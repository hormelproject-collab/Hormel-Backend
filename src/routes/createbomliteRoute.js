import express from "express";
import crypto from "crypto";
import os from "os";
import pool from "../db/postgresClient.js";
import appConfig from "../config/appConfig.js";
import { validateManualEntryPayload } from "../bigquery/manualentryValidation.js";
import { fetchItemDetailsForPostgres } from "../services/bigqueryService.js";

const router = express.Router();

/* =========================================================
   Config-driven sources
   - BOM core tables are written/read from PostgreSQL.
   - item details enrichment is delegated to bigqueryService.js:
     itemReleaseFlag => BigQuery DEV, item/resource master => BigQuery PRD.
========================================================= */
const IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

const assertSafeIdentifier = (value, label) => {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`Missing identifier for ${label}`);
  if (!IDENTIFIER_REGEX.test(normalized)) {
    throw new Error(`Invalid SQL identifier for ${label}: ${normalized}`);
  }
  return normalized;
};

const PG_SCHEMA = assertSafeIdentifier(appConfig.postgres.schema || "planning_bom", "postgres.schema");

const PG_TABLES = Object.freeze({
  bomParameters: assertSafeIdentifier(appConfig.postgres.tables.bomParameters, "postgres.tables.bomParameters"),
  bomProduced: assertSafeIdentifier(appConfig.postgres.tables.bomProduced, "postgres.tables.bomProduced"),
  bomConsumed: assertSafeIdentifier(appConfig.postgres.tables.bomConsumed, "postgres.tables.bomConsumed"),
  itemBomRouting: assertSafeIdentifier(appConfig.postgres.tables.itemBomRouting, "postgres.tables.itemBomRouting"),
  changeLog: assertSafeIdentifier(appConfig.postgres.tables.changeLog, "postgres.tables.changeLog"),
  itemDetails: assertSafeIdentifier(appConfig.postgres.tables.itemDetails, "postgres.tables.itemDetails"),
});

const ITEM_DETAIL_TABLE = PG_TABLES.itemDetails;
const CHANGE_LOG_TABLE = PG_TABLES.changeLog;

const quoteIdent = (value) => `"${String(value).replace(/"/g, '""')}"`;
const pgTableRef = (tableName) => `${quoteIdent(PG_SCHEMA)}.${quoteIdent(assertSafeIdentifier(tableName, "postgres.table"))}`;

/* =========================================================
   Helpers
========================================================= */
const norm = (v) => String(v ?? "").trim();
const ensureArray = (v) => (Array.isArray(v) ? v : []);

const ROUTING_PREFIX = "ROUTING";

/**
 * Routing ID required format: ROUTING_Item_resource
 * Example: ROUTING_HRL01639_RESOURCE123
 *
 * IMPORTANT FIX:
 * Old code used split("_").slice(3), which drops the resource for the correct
 * 3-part format. For ROUTING_Item_resource, resource starts from index 2.
 */
function parseRoutingId(routingId) {
  const value = norm(routingId);
  if (!value) return { item: "", resource: "" };

  const parts = value.split("_").map((part) => norm(part));
  if (parts.length >= 3 && parts[0].toUpperCase() === ROUTING_PREFIX) {
    return {
      item: parts[1] || "",
      resource: parts.slice(2).join("_") || "",
    };
  }

  return { item: "", resource: "" };
}

function getRoutingResource(row = {}) {
  return norm(row.resource) || parseRoutingId(row.routing_id).resource;
}

function buildRoutingId(item, resource, fallbackRoutingId = "") {
  const normalizedItem = norm(item);
  const normalizedResource = norm(resource) || parseRoutingId(fallbackRoutingId).resource;

  if (normalizedItem && normalizedResource) {
    return `${ROUTING_PREFIX}_${normalizedItem}_${normalizedResource}`;
  }

  return norm(fallbackRoutingId);
}

function collectItemResourceRowsForItemDetail(dbRows) {
  const itemResourceRows = [];
  const resourceByBomLocation = new Map();

  ensureArray(dbRows?.item_bom_routing).forEach((row) => {
    const bomId = norm(row.bom_id);
    const location = norm(row.location);
    const resource = getRoutingResource(row);

    if (bomId && location && resource) {
      resourceByBomLocation.set(`${bomId}__${location}`, resource);
    }
  });

  const getResource = (bomId, location) => {
    const key = `${norm(bomId)}__${norm(location)}`;

    if (resourceByBomLocation.has(key)) return resourceByBomLocation.get(key);

    const byBom = [...resourceByBomLocation.entries()].find(([mapKey]) =>
      mapKey.startsWith(`${norm(bomId)}__`)
    );

    return byBom?.[1] || "";
  };

  ensureArray(dbRows?.bom_produced).forEach((row) => {
    itemResourceRows.push({ item: row.item, resource: getResource(row.bom_id, row.location) });
  });

  ensureArray(dbRows?.bom_consumed).forEach((row) => {
    itemResourceRows.push({ item: row.item, resource: getResource(row.bom_id, row.location) });
  });

  ensureArray(dbRows?.item_bom_routing).forEach((row) => {
    itemResourceRows.push({ item: row.item, resource: getRoutingResource(row) });
  });

  return Array.from(
    new Map(
      itemResourceRows
        .map((row) => ({ item: norm(row.item), resource: norm(row.resource) }))
        .filter((row) => row.item)
        .map((row) => [row.item.toUpperCase(), row])
    ).values()
  );
}

async function getExistingColumns(client, tableName) {
  const result = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = $2
      ORDER BY ordinal_position
    `,
    [PG_SCHEMA, tableName]
  );

  return result.rows.map((row) => String(row.column_name).trim().toLowerCase());
}

async function upsertItemDetails(client, itemDetails = []) {
  const rows = ensureArray(itemDetails).filter((row) => norm(row.item));
  if (!rows.length) return 0;

  const existingColumns = await getExistingColumns(client, ITEM_DETAIL_TABLE);
  if (!existingColumns.includes("item")) {
    throw new Error(`${ITEM_DETAIL_TABLE}.item column does not exist`);
  }

  let upsertedCount = 0;

  for (const detail of rows) {
    const row = {
      item: norm(detail.item),
      item_description: norm(detail.item_description),
      resource_relevancy: norm(detail.resource_relevancy),
      item_release_flag: norm(detail.item_release_flag),
    };

    const finalEntries = Object.entries(row).filter(([key]) => existingColumns.includes(key.toLowerCase()));
    if (!finalEntries.length) continue;

    const columns = finalEntries.map(([key]) => key);
    const values = finalEntries.map(([, value]) => value);
    const placeholders = columns.map((_, index) => `$${index + 1}`);
    const updateColumns = columns.filter((column) => column !== "item");
    const insertColumnsSql = columns.map(quoteIdent).join(", ");

    let query = `
      INSERT INTO ${pgTableRef(ITEM_DETAIL_TABLE)} (${insertColumnsSql})
      VALUES (${placeholders.join(", ")})
      ON CONFLICT (${quoteIdent("item")})
    `;

    if (updateColumns.length) {
      const updateSet = updateColumns.map((column) => `${quoteIdent(column)} = EXCLUDED.${quoteIdent(column)}`).join(", ");
      query += ` DO UPDATE SET ${updateSet} RETURNING ${quoteIdent("item")}`;
    } else {
      query += ` DO NOTHING RETURNING ${quoteIdent("item")}`;
    }

    await client.query(query, values);
    upsertedCount += 1;
  }

  return upsertedCount;
}

const getOsUserName = () => {
  try {
    return norm(os.userInfo()?.username) || "APPL_TEAM";
  } catch {
    return "APPL_TEAM";
  }
};

const firstNonEmpty = (...values) => {
  for (const value of values) {
    const text = norm(value);
    if (text) return text;
  }
  return "";
};

const uniqueJoined = (values) =>
  Array.from(new Set(ensureArray(values).map((v) => norm(v)).filter(Boolean))).join(", ");

function collectAdditionalChangeLogFields(dbRows, payloadRecords = []) {
  const itemDescriptions = [];
  const itemReleaseFlags = [];
  const resourceRelevancies = [];
  const consumedItems = [];

  ensureArray(dbRows?.bom_produced).forEach((row) => {
    itemDescriptions.push(firstNonEmpty(row.item_description, row.item_desc, row.description, row.produced_item_description));
    itemReleaseFlags.push(firstNonEmpty(row.item_release_flag, row.item_Release_flag, row.release_flag, row.itemReleaseFlag));
  });

  ensureArray(dbRows?.bom_consumed).forEach((row) => {
    consumedItems.push(firstNonEmpty(row.item, row.component_item, row.consumed_item));
  });

  ensureArray(dbRows?.item_bom_routing).forEach((row) => {
    resourceRelevancies.push(firstNonEmpty(row.resource_relevancy, row.resourcePlanningRelevance, row.resource_planning_relevance));
  });

  ensureArray(payloadRecords).forEach((record) => {
    itemDescriptions.push(firstNonEmpty(record.itemDescription, record.item_description, record.producedItemDescription, record.produced_item_description));
    itemReleaseFlags.push(firstNonEmpty(record.itemReleaseFlag, record.item_release_flag, record.releaseFlag));
    resourceRelevancies.push(firstNonEmpty(record.resourceRelevancy, record.resource_relevancy, record.resourcePlanningRelevance, record.resource_planning_relevance));
    consumedItems.push(firstNonEmpty(record.consumedItem, record.componentItem));

    ensureArray(record.components).forEach((component) => {
      consumedItems.push(firstNonEmpty(component.componentItem, component.consumedItem, component.item));
    });

    ensureArray(record.locations).forEach((locationRow) => {
      ensureArray(locationRow.components).forEach((component) => {
        consumedItems.push(firstNonEmpty(component.componentItem, component.consumedItem, component.item));
      });
    });
  });

  return {
    itemDescription: uniqueJoined(itemDescriptions),
    itemReleaseFlag: uniqueJoined(itemReleaseFlags),
    resourceRelevancy: uniqueJoined(resourceRelevancies),
    consumedItem: uniqueJoined(consumedItems),
  };
}

const HARD_CODED_START_DATE = "2019-01-01";
const HARD_CODED_END_DATE = "2099-01-25";
const HARD_CODED_BOM_STATUS = "ACTIVE";
const HARD_CODED_PREFIX = "BOM";
const HARD_CODED_BOM_PLAN_TYPE = "MP and OP";
const HARD_CODED_LOAD_DATETIME = null;

function getCstTimestamp() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Chicago" }));
}

function formatChicagoChangeDate(dateInput = new Date()) {
  const chicagoDate = new Date(new Date(dateInput).toLocaleString("en-US", { timeZone: "America/Chicago" }));
  const yyyy = chicagoDate.getFullYear();
  const dd = String(chicagoDate.getDate()).padStart(2, "0");
  const mm = String(chicagoDate.getMonth() + 1).padStart(2, "0");
  const hh = String(chicagoDate.getHours()).padStart(2, "0");
  const mi = String(chicagoDate.getMinutes()).padStart(2, "0");
  const ss = String(chicagoDate.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
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
  const rand = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
  return `${ts}${rand}`;
}

function generateRandomSixDigit() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function getBomVersionFromBomId(bomId) {
  const parts = String(bomId || "").split("_").map((p) => p.trim()).filter(Boolean);
  return parts.length >= 1 ? parts[0] : "";
}

function buildInsertQuery(tableName, candidateData, allowedColumns) {
  const entries = Object.entries(candidateData).filter(([key, value]) => {
    return allowedColumns.includes(String(key).toLowerCase()) && value !== undefined;
  });

  if (entries.length === 0) throw new Error(`No matching columns found for insert into ${tableName}`);

  const columns = entries.map(([key]) => quoteIdent(key));
  const values = entries.map(([, value]) => value);
  const placeholders = entries.map((_, index) => `$${index + 1}`);

  return {
    query: `
      INSERT INTO ${pgTableRef(tableName)} (${columns.join(", ")})
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
  const osUser = getOsUserName();

  return {
    user_name: osUser,
    user_email: norm(payload?.user?.email) || norm(record0?.user?.email) || norm(payload?.userEmail) || "",
    user_id: osUser || norm(payload?.user?.id) || norm(record0?.user?.id) || norm(payload?.userId) || "",
  };
}

function collectNotes(payload) {
  const uniqueNotes = Array.from(new Set(ensureArray(payload?.records).map((r) => norm(r?.notes)).filter(Boolean)));
  return uniqueNotes[0] || "";
}

async function insertConsolidatedChangeLogRow(client, { ecNumber, dbRows, insertedCounts, notes, userDetails, payloadRecords = [] }) {
  const allowedColumns = await getExistingColumns(client, CHANGE_LOG_TABLE);

  const allBomIds = Array.from(new Set([
    ...ensureArray(dbRows?.bom_parameters).map((r) => norm(r.bom_id)),
    ...ensureArray(dbRows?.bom_produced).map((r) => norm(r.bom_id)),
    ...ensureArray(dbRows?.bom_consumed).map((r) => norm(r.bom_id)),
    ...ensureArray(dbRows?.item_bom_routing).map((r) => norm(r.bom_id)),
  ].filter(Boolean)));

  const allLocations = Array.from(new Set([
    ...ensureArray(dbRows?.bom_produced).map((r) => norm(r.location)),
    ...ensureArray(dbRows?.bom_consumed).map((r) => norm(r.location)),
    ...ensureArray(dbRows?.item_bom_routing).map((r) => norm(r.location)),
  ].filter(Boolean)));

  const allResources = Array.from(new Set(ensureArray(dbRows?.item_bom_routing).map((r) => getRoutingResource(r)).filter(Boolean)));

  const allProducedItems = Array.from(new Set([
    ...ensureArray(dbRows?.bom_produced).map((r) => norm(r.item)),
    ...ensureArray(dbRows?.item_bom_routing).map((r) => norm(r.item)),
  ].filter(Boolean)));

  const additionalChangeLogFields = collectAdditionalChangeLogFields(dbRows, payloadRecords);
  const totalBomRecordsCreated = allBomIds.length;

  const row = {
    rec_id: generateRandomSixDigit(),
    postgresql_rec_id: null,
    engineering_change_id: ecNumber,
    change_type: "Added",
    target_table: "consolidated tables",
    bom_id: allBomIds.join(", "),
    produced_item: allProducedItems.join(", "),
    location: allLocations.join(", "),
    resource: allResources.join(", "),
    change_date: formatChicagoChangeDate(),
    user_name: getOsUserName(),
    summarynotes: notes || "",
    change_summary: `Created ${totalBomRecordsCreated} BOM record${totalBomRecordsCreated === 1 ? "" : "s"}`,
  };

  if (allowedColumns.includes("notes")) row.notes = notes || "";
  if (allowedColumns.includes("resources")) row.resources = allResources.join(", ");
  if (allowedColumns.includes("locations")) row.locations = allLocations.join(", ");
  if (allowedColumns.includes("bom_ids")) row.bom_ids = allBomIds.join(", ");
  if (allowedColumns.includes("item_description")) row.item_description = additionalChangeLogFields.itemDescription || "";
  if (allowedColumns.includes("item_release_flag")) row.item_release_flag = additionalChangeLogFields.itemReleaseFlag || "";
  if (allowedColumns.includes("resource_relevancy")) row.resource_relevancy = additionalChangeLogFields.resourceRelevancy || "";
  if (allowedColumns.includes("consumed_item")) row.consumed_item = additionalChangeLogFields.consumedItem || "";

  await insertDynamic(client, CHANGE_LOG_TABLE, row);
}

/* =========================================================
   Build DB rows from normalized validator tables
========================================================= */
function buildTargetTableRows(normalizedTables, ecNumber, userDetails, notes, payloadRecords = []) {
  const bomParametersRows = ensureArray(normalizedTables?.bom_parameters).map((row) => ({
    rec_id: generateUniqueBigInt(),
    bom_id: row.bom_id,
    erp_bom_start_date: HARD_CODED_START_DATE,
    erp_bom_end_date: HARD_CODED_END_DATE,
    engineering_change_id: ecNumber,
    change_type: "Added",
    load_datetime: HARD_CODED_LOAD_DATETIME,
  }));

  const bomProducedRows = ensureArray(normalizedTables?.bom_produced).map((row) => ({
    rec_id: generateUniqueBigInt(),
    bom_id: row.bom_id,
    item: row.item,
    location: row.location,
    bom_status: HARD_CODED_BOM_STATUS,
    bom_version: getBomVersionFromBomId(row.bom_id),
    prefix: HARD_CODED_PREFIX,
    bom_plan_type: HARD_CODED_BOM_PLAN_TYPE,
    erp_bom_qty_produced_per:
      row.erp_bom_qty_produced_per ?? row.qty_produced_per ?? null,
    engineering_change_id: ecNumber,
    change_type: "Added",
    load_datetime: HARD_CODED_LOAD_DATETIME,
  }));

  const bomConsumedRows = ensureArray(normalizedTables?.bom_consumed).map((row) => ({
    rec_id: generateUniqueBigInt(),
    bom_id: row.bom_id,
    item: row.item,
    location: row.location,
    erp_bom_quantity_consumed_per:
      row.bom_quantity_consumed_per ??
      row.erp_bom_quantity_consumed_per ??
      row.quantity_consumed_per ??
      null,
    erp_bom_component_start_date: HARD_CODED_START_DATE,
    erp_bom_component_end_date: HARD_CODED_END_DATE,
    engineering_change_id: ecNumber,
    change_type: "Added",
    load_datetime: HARD_CODED_LOAD_DATETIME,
  }));

  const itemBomRoutingRows = [];

  const rawRoutingRows = ensureArray(normalizedTables?.item_bom_routing);

  // Prefer true main rows.
  // But if client env sends all rows as erp_co_product_association = 1,
  // fallback to all rows so item_bom_routing does not become empty.
  const nonCoProductRoutingRows = rawRoutingRows.filter(
    (row) => Number(row?.erp_co_product_association) !== 1
  );

  const routingSourceRows =
    nonCoProductRoutingRows.length > 0 ? nonCoProductRoutingRows : rawRoutingRows;

  const seenBaseRows = new Set();

  routingSourceRows.forEach((row) => {
    const bomId = norm(row.bom_id);
    const derivedResource = getRoutingResource(row);
    const location = norm(row.location);

    if (!bomId || !derivedResource) return;

    const matchingPayloadRecord = ensureArray(payloadRecords).find(
      (record) => norm(record?.bomId) === bomId
    );

    const producedItem =
      norm(matchingPayloadRecord?.producedItem?.item) ||
      norm(matchingPayloadRecord?.producedItem) ||
      norm(row.item);

    if (!producedItem) return;

    // Prevent duplicate base rows if client sends repeated normalized routing rows.
    const baseKey = `${bomId}__${location}__${derivedResource}__${producedItem}`;
    if (seenBaseRows.has(baseKey)) return;
    seenBaseRows.add(baseKey);

    // Create routing ID once from produced item + resource.
    const routingId = buildRoutingId(producedItem, derivedResource, row.routing_id);

    const mainRoutingRow = {
      rec_id: generateUniqueBigInt(),
      bom_id: bomId,
      item: producedItem,
      routing_id: routingId,
      location: row.location,
      resource: derivedResource,
      erp_item_bom_routing_priority:
        row.item_bom_routing_priority ?? row.priority ?? row.routingPriority ?? null,
      erp_item_bom_routing_min_lot_size:
        row.item_bom_routing_min_lot_size ?? row.erp_item_bom_routing_min_lot_size ?? 1,
      erp_item_bom_routing_lot_size_increment:
        row.item_bom_routing_lot_size_increment ?? row.erp_item_bom_routing_lot_size_increment ?? 1,
      erp_item_bom_routing_wip_sweep_priority:
        row.item_bom_routing_wip_sweep_priority ?? row.erp_item_bom_wip_sweep_priority ?? 1,
      erp_co_product_association: null,
      erp_item_bom_routing_max_lot_size:
        row.item_bom_routing_max_lot_size ?? row.erp_item_bom_routing_max_lot_size ?? null,
      engineering_change_id: ecNumber,
      change_type: "Added",
      load_datetime: HARD_CODED_LOAD_DATETIME,
    };

    itemBomRoutingRows.push(mainRoutingRow);

    ensureArray(matchingPayloadRecord?.locations).forEach((locationRow) => {
      ensureArray(locationRow?.coProducts).forEach((coProduct) => {
        const coProductItem = norm(
          coProduct?.coProductItem ??
            coProduct?.item ??
            coProduct?.value
        );

        if (!coProductItem) return;

        itemBomRoutingRows.push({
          ...mainRoutingRow,
          rec_id: generateUniqueBigInt(),

          // Co-product item.
          item: coProductItem,

          // Same routing ID as main produced item row.
          routing_id: mainRoutingRow.routing_id,

          erp_co_product_association: 1,
        });
      });
    });
  });

  return {
    bom_parameters: bomParametersRows,
    bom_produced: bomProducedRows,
    bom_consumed: bomConsumedRows,
    item_bom_routing: itemBomRoutingRows,
  };
}

async function insertAllManualRows(client, normalizedTables, ecNumber, userDetails, notes, payloadRecords = []) {
  const dbRows = buildTargetTableRows(normalizedTables, ecNumber, userDetails, notes, payloadRecords);

  const insertedCounts = {
    bom_parameters: 0,
    bom_produced: 0,
    bom_consumed: 0,
    item_bom_routing: 0,
  };

  for (const row of dbRows.bom_parameters) {
    await insertDynamic(client, PG_TABLES.bomParameters, row);
    insertedCounts.bom_parameters += 1;
  }

  for (const row of dbRows.bom_produced) {
    await insertDynamic(client, PG_TABLES.bomProduced, row);
    insertedCounts.bom_produced += 1;
  }

  for (const row of dbRows.bom_consumed) {
    await insertDynamic(client, PG_TABLES.bomConsumed, row);
    insertedCounts.bom_consumed += 1;
  }

  for (const row of dbRows.item_bom_routing) {
    await insertDynamic(client, PG_TABLES.itemBomRouting, row);
    insertedCounts.item_bom_routing += 1;
  }

  const itemResourceRows = collectItemResourceRowsForItemDetail(dbRows);
  let itemDetailUpsertCount = 0;

  if (itemResourceRows.length) {
    const itemDetailsFromBigQuery = await fetchItemDetailsForPostgres(itemResourceRows);
    itemDetailUpsertCount = await upsertItemDetails(client, itemDetailsFromBigQuery);
  }

  await insertConsolidatedChangeLogRow(client, {
    ecNumber,
    dbRows,
    insertedCounts,
    notes,
    userDetails,
    payloadRecords,
  });

  return { ...insertedCounts, item_detail: itemDetailUpsertCount };
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
      success: false,
      message: "This /bom-explosion endpoint currently supports manual entry flow only. CSV upload flow will be handled separately.",
      validationErrors: [
        {
          code: "ENTRY_MODE",
          desc: "Invalid entry mode",
          error: "Only manual entry flow is supported by this endpoint.",
          rm: "Submit the BOM payload with entryMode = manual.",
        },
      ],
    });
  }

  const records = ensureArray(payload?.records);

  if (records.length === 0) {
    return res.status(400).json({
      status: "failure",
      success: false,
      message: "No manual entry records received from summary page.",
      validationErrors: [
        {
          code: "NO_RECORDS",
          desc: "Payload records check",
          error: "No manual entry records received from summary page.",
          rm: "Please complete the previous steps and submit again.",
        },
      ],
    });
  }

  const normalizeValidationErrorArray = (validation) => {
    if (!validation) return [];
    if (Array.isArray(validation.validationErrors)) return validation.validationErrors;
    if (Array.isArray(validation.errors)) return validation.errors;

    if (Array.isArray(validation.errorList)) {
      return validation.errorList.flatMap((row, rowIndex) => {
        const messages = Array.isArray(row?.messages) ? row.messages : [];

        if (messages.length === 0) {
          return [
            {
              code: row?.seq ?? row?.sequence ?? row?.code ?? `VALIDATION-${rowIndex + 1}`,
              desc: row?.desc ?? row?.description ?? row?.validation ?? "Validation failed",
              error: row?.error ?? row?.message ?? row?.detail ?? JSON.stringify(row),
              rm: row?.rm ?? row?.remediation ?? row?.remediationMessage ?? "",
            },
          ];
        }

        return messages.map((msg, msgIndex) => ({
          code: msg?.seq ?? msg?.sequence ?? msg?.code ?? row?.seq ?? row?.sequence ?? row?.code ?? `VALIDATION-${rowIndex + 1}-${msgIndex + 1}`,
          desc: msg?.desc ?? msg?.description ?? msg?.validation ?? row?.desc ?? row?.description ?? row?.validation ?? "Validation failed",
          error: msg?.error ?? msg?.message ?? msg?.detail ?? row?.error ?? row?.message ?? row?.detail ?? "",
          rm: msg?.rm ?? msg?.remediation ?? msg?.remediationMessage ?? row?.rm ?? row?.remediation ?? row?.remediationMessage ?? "",
        }));
      });
    }

    if (validation.error) {
      return [
        {
          code: validation.code ?? "VALIDATION_ERROR",
          desc: validation.desc ?? "Validation failed",
          error: validation.error,
          rm: validation.rm ?? validation.remediation ?? "",
        },
      ];
    }

    return [];
  };

  const getNormalizedTablesFromValidation = (validation) => {
    return validation?.normalizedTables || validation?.normalized || validation?.tables || validation?.data?.normalizedTables || validation?.data?.normalized || null;
  };

  try {
    const validation = await validateManualEntryPayload(payload, pool);
    const validationErrors = normalizeValidationErrorArray(validation);

    const validationPassed =
      validation?.isValid === true ||
      validation?.valid === true ||
      String(validation?.status || "").toLowerCase() === "success";

    if (!validationPassed || validationErrors.length > 0) {
      return res.status(400).json({
        status: "failure",
        success: false,
        message: "Validation failed.",
        validationErrors,
      });
    }

    const normalizedTables = getNormalizedTablesFromValidation(validation);

    if (!normalizedTables) {
      return res.status(200).json({
        status: "failure",
        success: false,
        message: "Validation is successful but the records are not yet pushed to PostgreSQL table.",
        messageForUser: "Validation is successful but the records are not yet pushed to PostgreSQL table.",
        engineeringChangeId: "",
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const ecNumber = getEcNumber();
      const userDetails = getUserDetails(payload);
      const notes = collectNotes(payload);

      await insertAllManualRows(client, normalizedTables, ecNumber, userDetails, notes, records);

      await client.query("COMMIT");

      return res.status(200).json({
        status: "success",
        success: true,
        message: `Validation was successful and the records are saved successfully with ${ecNumber}.`,
        engineeringChangeId: ecNumber,
      });
    } catch (insertErr) {
      await client.query("ROLLBACK");
      console.error("BOM submit PostgreSQL insert failed after validation success:", insertErr);

      return res.status(200).json({
        status: "failure",
        success: false,
        message: "Validation is successful but the records are not yet pushed to PostgreSQL table.",
        messageForUser: "Validation is successful but the records are not yet pushed to PostgreSQL table.",
        engineeringChangeId: "",
        error: insertErr.message || "PostgreSQL insert failed after validation success",
      });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("bom-explosion manual flow error:", err);

    return res.status(500).json({
      status: "failure",
      success: false,
      message: err.message || "Internal server error",
      error: err.message || "Internal server error",
    });
  }
});

export default router;
