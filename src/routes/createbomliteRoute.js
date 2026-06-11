import express from "express";
import crypto from "crypto";
import pool from "../db/postgresClient.js";
import { validateManualEntryPayload } from "../bigquery/manualentryValidation.js";

const router = express.Router();

/* =========================================================
   Helpers
========================================================= */
const norm = (v) => String(v ?? "").trim();
const ensureArray = (v) => (Array.isArray(v) ? v : []);
function getCstTimestamp() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })
  );
}

function getEcNumber() {
  const d = new Date();

  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");

  return `EC-${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
}

function generateUniqueBigInt() {
  const ts = Date.now().toString();
  const rand = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, "0");
  return `${ts}${rand}`;
}

function generateRandomSixDigit() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function getExistingColumns(client, tableName) {
  const result = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
      ORDER BY ordinal_position
    `,
    [tableName]
  );

  return result.rows.map((row) =>
    String(row.column_name).trim().toLowerCase()
  );
}

function buildInsertQuery(tableName, candidateData, allowedColumns) {
  const entries = Object.entries(candidateData).filter(([key, value]) => {
    return (
      allowedColumns.includes(String(key).toLowerCase()) &&
      value !== undefined
    );
  });

  if (entries.length === 0) {
    throw new Error(`No matching columns found for insert into ${tableName}`);
  }

  const columns = entries.map(([key]) => key);
  const values = entries.map(([, value]) => value);
  const placeholders = entries.map((_, index) => `$${index + 1}`);

  return {
    query: `
      INSERT INTO ${tableName} (${columns.join(", ")})
      VALUES (${placeholders.join(", ")})
      RETURNING *
    `,
    values,
  };
}

async function insertDynamic(client, tableName, row) {
  const allowedColumns = await getExistingColumns(client, tableName);
  const { query, values } = buildInsertQuery(tableName, row, allowedColumns);
  const result = await client.query(query, values);
  return result.rows?.[0] ?? null;
}

function getUserDetails(payload) {
  const records = ensureArray(payload?.records);
  const record0 = records[0] || {};

  return {
    user_name:
      norm(payload?.user?.name) ||
      norm(record0?.user?.name) ||
      norm(payload?.userName) ||
      "APPL_TEAM",
    user_email:
      norm(payload?.user?.email) ||
      norm(record0?.user?.email) ||
      norm(payload?.userEmail) ||
      "",
    user_id:
      norm(payload?.user?.id) ||
      norm(record0?.user?.id) ||
      norm(payload?.userId) ||
      "",
  };
}


function collectNotes(payload) {
  const uniqueNotes = Array.from(
    new Set(
      ensureArray(payload?.records)
        .map((r) => norm(r?.notes))
        .filter(Boolean)
    )
  );

  return uniqueNotes[0] || "";
}


/* =========================================================
   Build DB rows from normalized validator tables
========================================================= */
function buildTargetTableRows(normalizedTables, ecNumber, userDetails, notes) {
  const now = getCstTimestamp();

  const bomParametersRows = ensureArray(normalizedTables?.bom_parameters).map((row) => ({
    rec_id: generateUniqueBigInt(),
    bom_id: row.bom_id,
    erp_bom_start_date: row.erp_bom_start_date ?? null,
    erp_bom_end_date: row.erp_bom_end_date ?? null,
    engineering_change_id: ecNumber,
    change_type: "Add BOM",
    load_datetime: now,
  }));

  const bomProducedRows = ensureArray(normalizedTables?.bom_produced).map((row) => ({
    rec_id: generateUniqueBigInt(),
    bom_id: row.bom_id,
    item: row.item,
    location: row.location,
    bom_status:
      row.bom_status ??
      row.status ??
      null,
    bom_version:
      row.bom_version ??
      row.version ??
      null,
    prefix:
      row.prefix ??
      null,
    bom_plan_type:
      row.bom_plan_type ??
      null,
    erp_bom_qty_produced_per:
      row.erp_bom_qty_produced_per ??
      row.qty_produced_per ??
      null,
    engineering_change_id: ecNumber,
    change_type: "Add BOM",
    load_datetime: now,
  }));

  const bomConsumedRows = ensureArray(normalizedTables?.bom_consumed).map((row) => ({
    rec_id: generateUniqueBigInt(),
    bom_id: row.bom_id,
    item: row.item,
    location: row.location,
    bom_quantity_consumed_per:
      row.bom_quantity_consumed_per ??
      row.erp_bom_quantity_consumed_per ??
      row.quantity_consumed_per ??
      null,
    bom_component_start_date:
      row.bom_component_start_date ??
      row.erp_bom_component_start_date ??
      null,
    bom_component_end_date:
      row.bom_component_end_date ??
      row.erp_bom_component_end_date ??
      null,
    engineering_change_id: ecNumber,
    change_type: "Add BOM",
    load_datetime: now,
  }));


  const itemBomRoutingRows = ensureArray(normalizedTables?.item_bom_routing).map((row) => {
    const derivedResource =
      norm(row.resource) ||
      norm(String(row.routing_id || "").split("_").slice(3).join("_"));

    const coProductAssociation =
      row.co_product_association ??
      row.erp_co_product_association ??
      ((Number(row.is_coproduct) === 1 || row.is_coproduct === true) ? 1 : 0);

    return {
      rec_id: generateUniqueBigInt(),
      bom_id: row.bom_id,
      item: row.item,
      routing_id: row.routing_id,
      item_bom_routing_priority:
        row.item_bom_routing_priority ??
        row.priority ??
        row.routingPriority ??
        null,
      item_bom_routing_min_lot_size:
        row.item_bom_routing_min_lot_size ?? null,
      item_bom_routing_lot_size_increment:
        row.item_bom_routing_lot_size_increment ?? null,
      item_bom_routing_wip_sweep_priority:
        row.item_bom_routing_wip_sweep_priority ?? null,
      co_product_association: coProductAssociation,
      item_bom_routing_max_lot_size:
        row.item_bom_routing_max_lot_size ?? null,
      engineering_change_id: ecNumber,
      change_type: "Add BOM",
      load_datetime: now,
    };
  });


  return {
    bom_parameters: bomParametersRows,
    bom_produced: bomProducedRows,
    bom_consumed: bomConsumedRows,
    item_bom_routing: itemBomRoutingRows,
  };
}

async function insertChangeLogRow(
  client,
  {
    ecNumber,
    targetTable,
    postgresqlRecId,
    bomId = "",
    producedItem = "",
    location = "",
    resource = "",
    summarynotes = "",
    userDetails,
  }
) {
  const allowedColumns = await getExistingColumns(
    client,
    "planning_bom_change_log_summary"
  );

  const row = {
    rec_id: generateRandomSixDigit(), // 6-digit as requested
    engineering_change_id: ecNumber,
    postgresql_rec_id: postgresqlRecId,
    change_type: "Add BOM",
    target_table: targetTable,
    bom_id: bomId || "",
    produced_item: producedItem || "",
    location: location || "",
    change_date: new Date().toISOString().slice(0, 10),
    user_name: userDetails.user_name || "APPL_TEAM",
  };

  // NEW: store notes from Summary.jsx textarea
  if (allowedColumns.includes("summarynotes")) {
    row.summarynotes = summarynotes || "";
  }

  // optional backward compatibility
  if (allowedColumns.includes("notes")) {
    row.notes = summarynotes || "";
  }

  // NEW: store resource
  if (allowedColumns.includes("resource")) {
    row.resource = resource || "";
  }

  // optional plural column if your engineering log uses it
  if (allowedColumns.includes("resources")) {
    row.resources = resource || "";
  }

  // optional user-facing summary column
  if (allowedColumns.includes("change_summary")) {
    row.change_summary = summarynotes || targetTable || "Add BOM";
  }

  await insertDynamic(client, "planning_bom_change_log_summary", row);
}

async function insertAllManualRows(client, normalizedTables, ecNumber, userDetails, notes) {
  const dbRows = buildTargetTableRows(normalizedTables, ecNumber, userDetails, notes);

  const insertedCounts = {
    bom_parameters: 0,
    bom_produced: 0,
    bom_consumed: 0,
    item_bom_routing: 0,
  };

  // Build resource map from routing rows: key = bom_id__location
  const resourceByBomAndLocation = new Map();

  for (const row of dbRows.item_bom_routing) {
    const routingResource =
      norm(row.resource) ||
      norm(
        String(row.routing_id || "")
          .split("_")
          .slice(3)
          .join("_")
      );

    const key = `${norm(row.bom_id)}__${norm(row.location)}`;
    if (!resourceByBomAndLocation.has(key) && routingResource) {
      resourceByBomAndLocation.set(key, routingResource);
    }
  }

  const getResourceForRow = (bomId, location) => {
    const directKey = `${norm(bomId)}__${norm(location)}`;
    if (resourceByBomAndLocation.has(directKey)) {
      return resourceByBomAndLocation.get(directKey);
    }

    // fallback: if location missing (ex: bom_parameters), match by bom only
    const byBomOnly = [...resourceByBomAndLocation.entries()].find(([key]) =>
      key.startsWith(`${norm(bomId)}__`)
    );

    return byBomOnly?.[1] || "";
  };

  // bom_parameters
  for (const row of dbRows.bom_parameters) {
    const inserted = await insertDynamic(client, "bom_parameters", row);
    insertedCounts.bom_parameters += 1;

    const derivedLocation =
      norm(row.location) ||
      norm(String(row.bom_id || "").split("_").slice(-1)[0]);

    const resource = getResourceForRow(row.bom_id, derivedLocation);

    await insertChangeLogRow(client, {
      ecNumber,
      targetTable: "bom_parameters",
      postgresqlRecId: inserted?.rec_id ?? row.rec_id,
      bomId: row.bom_id,
      producedItem: row.produced_item,
      location: derivedLocation,
      resource,
      summarynotes: notes,
      userDetails,
    });
  }
  // bom_produced
  for (const row of dbRows.bom_produced) {
    const inserted = await insertDynamic(client, "bom_produced", row);
    insertedCounts.bom_produced += 1;

    const resource = getResourceForRow(row.bom_id, row.location);

    await insertChangeLogRow(client, {
      ecNumber,
      targetTable: "bom_produced",
      postgresqlRecId: inserted?.rec_id ?? row.rec_id,
      bomId: row.bom_id,
      producedItem: row.item,
      location: row.location,
      resource,
      summarynotes: notes,
      userDetails,
    });
  }

  // bom_consumed
  for (const row of dbRows.bom_consumed) {
    const inserted = await insertDynamic(client, "bom_consumed", row);
    insertedCounts.bom_consumed += 1;

    const resource = getResourceForRow(row.bom_id, row.location);

    await insertChangeLogRow(client, {
      ecNumber,
      targetTable: "bom_consumed",
      postgresqlRecId: inserted?.rec_id ?? row.rec_id,
      bomId: row.bom_id,
      producedItem: row.item,
      location: row.location,
      resource,
      summarynotes: notes,
      userDetails,
    });
  }

  // item_bom_routing
  for (const row of dbRows.item_bom_routing) {
    const inserted = await insertDynamic(client, "item_bom_routing", row);
    insertedCounts.item_bom_routing += 1;

    const routingResource =
      norm(row.resource) ||
      norm(
        String(row.routing_id || "")
          .split("_")
          .slice(3)
          .join("_")
      );

    await insertChangeLogRow(client, {
      ecNumber,
      targetTable: "item_bom_routing",
      postgresqlRecId: inserted?.rec_id ?? row.rec_id,
      bomId: row.bom_id,
      producedItem: row.item,
      location: row.location,
      resource: routingResource,
      summarynotes: notes,
      userDetails,
    });
  }

  return insertedCounts;
}

/* =========================================================
   POST /bom-explosion
   MANUAL ENTRY ONLY
========================================================= */
router.post("/", async (req, res) => {
  const payload = req.body || {};

  if (String(payload?.entryMode || "").toLowerCase() !== "manual") {
    return res.status(400).json({
      status: "failure",
      message:
        "This /bom-explosion endpoint currently supports manual entry flow only. CSV upload flow will be handled separately.",
    });
  }

  const records = ensureArray(payload?.records);
  if (records.length === 0) {
    return res.status(400).json({
      status: "failure",
      message: "No manual entry records received from summary page.",
    });
  }

  const userDetails = getUserDetails(payload);
  const notes = collectNotes(payload);

  try {
    // 1) Validate manual entry via separate validator file
    const validation = await validateManualEntryPayload(payload, pool);

    // 2) Failure -> return Summary.jsx expected structure (no report generation)
    if (!validation.isValid) {
      const remediationDetails = validation.errorList.flatMap((row) =>
        ensureArray(row?.messages).map((msg) => ({
          record: row?.csvRecId ?? null,
          location: row?.location ?? null,
          component: null,
          coProduct: null,
          field: row?.field ?? null,
          remediation: msg?.remediationMessage || "",
        }))
      );

      return res.status(400).json({
        status: "failure",
        message: "Validation failed",
        errors: validation.errorCodes,
        errorList: validation.errorList,
        errorDetails: validation.errorList,
        remediationDetails,
      });
    }

    // 3) Success -> insert target rows + change logs in one transaction
    const ecNumber = getEcNumber();
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const insertedCounts = await insertAllManualRows(
        client,
        validation.normalizedTables,
        ecNumber,
        userDetails,
        notes
      );

      await client.query("COMMIT");

      return res.status(200).json({
        status: "success",
        message: "Validation successful and records saved successfully.",
        ecNumber,
        engineeringChangeId: ecNumber,
        insertedCounts,
      });
    } catch (dbErr) {
      await client.query("ROLLBACK");
      throw dbErr;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("bom-explosion manual flow error:", err);
    return res.status(500).json({
      status: "failure",
      message: err.message || "Internal server error",
      errorDetails: [],
      remediationDetails: [],
    });
  }
});

export default router;
