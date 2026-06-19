import express from "express";
import pool from "../db/postgresClient.js";
import { BigQuery } from "@google-cloud/bigquery";
import crypto from "crypto";
import XLSX from "xlsx";

const router = express.Router();

const bigquery = new BigQuery({
  projectId: process.env.BQ_PROJECT_ID,
});

/* =========================================================
   Common ID helpers
========================================================= */
const generateUniqueBigInt = () => {
  const ts = Date.now().toString();
  const rand = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, "0");
  return `${ts}${rand}`;
};

function generateRandomSixDigit() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

const HARD_CODED_START_DATE = "2019-01-01";
const HARD_CODED_END_DATE = "2099-01-25";
const HARD_CODED_BOM_STATUS = "ACTIVE";
const HARD_CODED_PREFIX = "BOM";
const HARD_CODED_BOM_PLAN_TYPE = "MP and OP";
const HARD_CODED_LOAD_DATETIME = null;

const getBomVersionFromBomId = (bomId) => {
  const parts = String(bomId || "")
    .split("_")
    .map((p) => p.trim())
    .filter(Boolean);

  // Format expected: BOMVERSION_item_location
  // Example: BOM1_HRL00068_1008 -> BOM1
  return parts.length >= 1 ? parts[0] : "";
};

const generateUniqueId = (prefix) => {
  const ts = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  const rand = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `${prefix}${ts}${rand}`;
};

const generateDeleteBomEngineeringChangeId = () => {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `EC-${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
};

const generateDeleteItemBomRoutingEngineeringChangeId = () => {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `EC-${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
};
const getProducedItemFromBomId = (bomId) => {
  const parts = String(bomId || "")
    .split("_")
    .map((p) => p.trim())
    .filter(Boolean);

  return parts.length >= 3 ? parts[1] : "";
};

const getLocationFromBomId = (bomId) => {
  const parts = String(bomId || "")
    .split("_")
    .map((p) => p.trim())
    .filter(Boolean);

  return parts.length >= 3 ? parts[2] : "";
};

const getResourceFromRoutingId = (routingId) => {
  const parts = String(routingId || "")
    .split("_")
    .map((p) => p.trim())
    .filter(Boolean);

  return parts.length >= 4 ? parts.slice(3).join("_") : "";
};

const getSourceRecId = (row) =>
  row?.postgresql_rec_id ??
  row?.rec_id ??
  row?.record_id ??
  row?.recordid ??
  row?.id ??
  null;

const getArchiveRecId = (row) =>
  row?.postgresql_rec_id ??
  row?.rec_id ??
  row?.record_id ??
  row?.recordid ??
  row?.id ??
  null;

/* =========================================================
   DB metadata helpers
========================================================= */
const getExistingColumns = async (client, tableName) => {
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

  return result.rows.map((row) => String(row.column_name).trim().toLowerCase());
};

const pgTableExists = async (client, tableName) => {
  const result = await client.query(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = $1
      ) AS exists
    `,
    [tableName]
  );
  return Boolean(result.rows?.[0]?.exists);
};

const quoteIdent = (value) => `"${String(value).replace(/"/g, '""')}"`;

const buildDynamicInsertQuery = (tableName, data, allowedColumns) => {
  const entries = Object.entries(data).filter(([key, value]) => {
    return (
      value !== undefined &&
      allowedColumns.includes(String(key).toLowerCase())
    );
  });

  if (entries.length === 0) {
    throw new Error(`No matching columns found for insert into ${tableName}`);
  }

  const columns = entries.map(([key]) => quoteIdent(key));
  const values = entries.map(([, value]) => value);
  const placeholders = entries.map((_, index) => `$${index + 1}`);

  return {
    query: `INSERT INTO ${quoteIdent(tableName)} (${columns.join(
      ", "
    )}) VALUES (${placeholders.join(", ")}) RETURNING *`,
    values,
  };
};

const buildInsertQuery = (tableName, candidateData, allowedColumns) => {
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
};

/* =========================================================
   Delete helpers
========================================================= */
const DELETE_BOM_SOURCE_TO_ARCHIVE = {
  bom_parameters: "bom_parameters_og",
  bom_produced: "bom_produced_og",
  bom_consumed: "bom_consumed_og",
  item_bom_routing: "item_bom_routing_og",
};

const DELETE_BOM_CHANGE_LOG_TABLE_CANDIDATES = [
  "planning_bom_change_log_summary",
  "bom_change_log_summary",
];

const toText = (value) => String(value ?? "").trim();

const normalizeTextArray = (values) => {
  if (Array.isArray(values)) {
    return Array.from(new Set(values.map((v) => toText(v)).filter(Boolean)));
  }
  if (values == null) return [];
  return Array.from(new Set([toText(values)].filter(Boolean)));
};

const buildDeleteBomArchiveRow = ({
  baseRow,
  archiveColumns,
  engineeringChangeId,
  notes,
  sourceTable,
}) => {
  const archiveRow = { ...baseRow };

  // IMPORTANT:
  // _og tables must generate their own postgresql_rec_id from sequence.
  // Do not carry live PK into archive PK.
  delete archiveRow.postgresql_rec_id;

  if (archiveColumns.includes("engineering_change_id")) {
    archiveRow.engineering_change_id = engineeringChangeId;
  }
  if (archiveColumns.includes("engineeringchangeid")) {
    archiveRow.engineeringchangeid = engineeringChangeId;
  }
  if (archiveColumns.includes("change_type")) {
    archiveRow.change_type = "Deleted";
  }
  if (archiveColumns.includes("changetype")) {
    archiveRow.changetype = "Deleted";
  }
  if (archiveColumns.includes("notes")) {
    archiveRow.notes = notes || "";
  }
  if (archiveColumns.includes("summarynotes")) {
    archiveRow.summarynotes = notes || "";
  }
  if (archiveColumns.includes("change_summary")) {
    archiveRow.change_summary = "";
  }
  if (archiveColumns.includes("source_table")) {
    archiveRow.source_table = sourceTable;
  }
  if (archiveColumns.includes("source_rec_id")) {
    archiveRow.source_rec_id =
      baseRow.postgresql_rec_id ??
      baseRow.rec_id ??
      baseRow.record_id ??
      baseRow.recordid ??
      baseRow.id ??
      null;
  }
  if (archiveColumns.includes("original_rec_id")) {
    archiveRow.original_rec_id =
      baseRow.postgresql_rec_id ??
      baseRow.rec_id ??
      baseRow.record_id ??
      baseRow.recordid ??
      baseRow.id ??
      null;
  }
  if (archiveColumns.includes("archived_at")) {
    archiveRow.archived_at = new Date();
  }
  if (archiveColumns.includes("archived_on")) {
    archiveRow.archived_on = new Date();
  }
  if (archiveColumns.includes("deleted_at")) {
    archiveRow.deleted_at = new Date();
  }
  if (archiveColumns.includes("deleted_on")) {
    archiveRow.deleted_on = new Date();
  }

  return archiveRow;
};

const deleteRowsByBomId = async (client, tableName, bomIds) => {
  const normalizedBomIds = normalizeTextArray(bomIds);
  if (!normalizedBomIds.length) {
    throw new Error(`Cannot delete from ${tableName}: bomIds is empty`);
  }

  const deleteResult = await client.query(
    `
      DELETE FROM ${quoteIdent(tableName)}
      WHERE TRIM(CAST(bom_id AS TEXT)) = ANY($1::text[])
      RETURNING bom_id
    `,
    [normalizedBomIds]
  );

  return deleteResult.rowCount || 0;
};

const deleteItemBomRoutingByBomAndRouting = async (
  client,
  bomId,
  routingId
) => {
  const bomIdText = toText(bomId);
  const routingIdText = toText(routingId);

  if (!bomIdText) {
    throw new Error(
      "Cannot delete from item_bom_routing: bom_id is required"
    );
  }

  let query = `
    DELETE FROM item_bom_routing
    WHERE TRIM(CAST(bom_id AS TEXT)) = $1
  `;
  const params = [bomIdText];

  if (routingIdText) {
    query += ` AND TRIM(CAST(routing_id AS TEXT)) = $2`;
    params.push(routingIdText);
  }

  query += ` RETURNING bom_id, routing_id`;

  const deleteResult = await client.query(query, params);

  if (!deleteResult.rowCount) {
    throw new Error(
      `Delete failed in item_bom_routing: no row matched bom_id=${bomIdText}${routingIdText ? ` and routing_id=${routingIdText}` : ""
      }`
    );
  }

  return deleteResult.rows || [];
};

/* =========================================================
   BigQuery helpers
========================================================= */
const getBigQueryConfig = () => {
  const projectId = process.env.BQ_PROJECT_ID;
  const dataset = process.env.BQ_DATASET;

  if (!projectId || !dataset) {
    throw new Error("BQ_PROJECT_ID or BQ_DATASET is not set in .env");
  }

  return { projectId, dataset };
};

const normalizeText = (value) => String(value ?? "").trim();
const normalizeUpper = (value) => normalizeText(value).toUpperCase();

const runBigQuery = async (query, params = {}) => {
  const [rows] = await bigquery.query({
    query,
    params,
  });
  return rows;
};

const getBaseKeyFromBomId = (bomId) => {
  const value = normalizeText(bomId);
  if (!value) return "";

  const parts = value
    .split("_")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length < 2) return "";

  return `${parts[0]}_${parts[1]}`;
};

const getBaseKeyAndResourceFromRoutingId = (routingId) => {
  const value = normalizeText(routingId);
  if (!value) {
    return { baseKey: "", resource: "" };
  }

  const parts = value
    .split("_")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length < 3) {
    return { baseKey: "", resource: "" };
  }

  return {
    baseKey: `${parts[0]}_${parts[1]}`,
    resource: parts[parts.length - 1],
  };
};

/* =========================================================
   1) Dedicated API: item_master + item_releaseflag
========================================================= */
router.get("/items-with-releaseflag", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        im.*,
        COALESCE(
          ir.item_releaseflag,
          ir.release_flag,
          ir.releaseflag,
          ''
        ) AS item_releaseflag
      FROM item_master im
      LEFT JOIN item_releaseflag ir
        ON TRIM(CAST(im.item AS TEXT)) = TRIM(CAST(ir.item AS TEXT))
      ORDER BY CAST(im.item AS TEXT)
    `);

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("DB Error (items-with-releaseflag):", error);
    return res.status(500).json({
      message: "Failed to fetch item master with release flag",
      error: error.message,
    });
  }
});

/* =========================================================
   2) Dedicated API: selected item(s) -> bom_produced -> location_master
========================================================= */
router.post("/locations-by-items", async (req, res) => {
  try {
    const { itemIds } = req.body || {};

    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return res.status(400).json({
        error: "itemIds must be a non-empty array",
      });
    }

    const normalizedItemIds = itemIds
      .map((id) => String(id).trim())
      .filter(Boolean);

    const result = await pool.query(
      `
      SELECT DISTINCT
        CAST(bp.item AS TEXT) AS item,
        CAST(bp.location AS TEXT) AS location,
        lm.location_name,
        lm.location_status
      FROM bom_produced bp
      LEFT JOIN location_master lm
        ON TRIM(CAST(bp.location AS TEXT)) = TRIM(CAST(lm.location AS TEXT))
      WHERE TRIM(CAST(bp.item AS TEXT)) = ANY($1::text[])
      ORDER BY CAST(bp.item AS TEXT), CAST(bp.location AS TEXT)
      `,
      [normalizedItemIds]
    );

    return res.status(200).json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("DB Error (locations-by-items):", error);
    return res.status(500).json({
      error: "Failed to fetch locations by selected items",
      details: error.message,
    });
  }
});

/* =========================================================
   3) Existing BOM search rows for Step 1
========================================================= */
router.get("/existing-bom-search", async (req, res) => {
  try {
    const producedResult = await pool.query(`
      WITH ranked_produced AS (
        SELECT
          TRIM(CAST(bp.bom_id AS TEXT)) AS bom_id,
          TRIM(CAST(bp.item AS TEXT)) AS produced_item,
          TRIM(CAST(bp.location AS TEXT)) AS location,
          ROW_NUMBER() OVER (
            PARTITION BY TRIM(CAST(bp.bom_id AS TEXT))
            ORDER BY
              CASE
                WHEN COALESCE(TRIM(CAST(bp.erp_bom_qty_produced_per AS TEXT)), '') IN ('1', '1.0', '1.00')
                  THEN 0
                ELSE 1
              END,
              TRIM(CAST(bp.item AS TEXT))
          ) AS rn
        FROM bom_produced bp
        WHERE bp.bom_id IS NOT NULL
          AND TRIM(CAST(bp.bom_id AS TEXT)) <> ''
      )
      SELECT
        bom_id,
        produced_item,
        location
      FROM ranked_produced
      WHERE rn = 1
      ORDER BY location, produced_item, bom_id
    `);

    const routingResult = await pool.query(`
      SELECT
        TRIM(CAST(ibr.bom_id AS TEXT)) AS bom_id,
        TRIM(CAST(ibr.item AS TEXT)) AS produced_item,
        TRIM(CAST(ibr.routing_id AS TEXT)) AS routing_id
      FROM item_bom_routing ibr
      WHERE ibr.routing_id IS NOT NULL
        AND TRIM(CAST(ibr.routing_id AS TEXT)) <> ''
      ORDER BY TRIM(CAST(ibr.bom_id AS TEXT)), TRIM(CAST(ibr.routing_id AS TEXT))
    `);

    const { projectId, dataset } = getBigQueryConfig();

    const itemMasterRows = await runBigQuery(`
      SELECT *
      FROM \`${projectId}.${dataset}.item_master\`
    `);

    const releaseFlagRows = await runBigQuery(`
      SELECT *
      FROM \`${projectId}.${dataset}.item_releaseflag\`
    `);

    const itemDescMap = new Map();
    for (const row of itemMasterRows) {
      const itemKey = normalizeUpper(row.item);
      if (!itemKey) continue;

      const description = normalizeText(
        row.item_description ??
        row.description ??
        row.item_desc ??
        row.item_desc_1 ??
        ""
      );

      if (!itemDescMap.has(itemKey)) {
        itemDescMap.set(itemKey, description);
      }
    }

    const releaseFlagMap = new Map();
    for (const row of releaseFlagRows) {
      const itemKey = normalizeUpper(row.item);
      if (!itemKey) continue;

      const releaseFlag = normalizeText(
        row.item_releaseflag ??
        row.release_flag ??
        row.releaseflag ??
        row.mrp_release_flag ??
        ""
      );

      if (!releaseFlagMap.has(itemKey)) {
        releaseFlagMap.set(itemKey, releaseFlag);
      }
    }

    const getResourceFromRoutingIdValue = (routingId) => {
      const value = normalizeText(routingId);
      if (!value) return "";
      const parts = value.split("_").map((p) => p.trim()).filter(Boolean);

      // ROUTING_item_resource...
      if (parts.length >= 3 && parts[0].toUpperCase() === "ROUTING") {
        return parts.slice(2).join("_");
      }

      // fallback for other patterns
      return parts.length >= 2 ? parts.slice(1).join("_") : "";
    };

    const routingsByBomId = new Map();
    for (const row of routingResult.rows || []) {
      const bomId = normalizeText(row.bom_id);
      if (!bomId) continue;

      if (!routingsByBomId.has(bomId)) {
        routingsByBomId.set(bomId, []);
      }

      routingsByBomId.get(bomId).push({
        produced_item: normalizeText(row.produced_item),
        routing_id: normalizeText(row.routing_id),
        resource: getResourceFromRoutingIdValue(row.routing_id),
      });
    }

    const mergedRows = [];
    for (const row of producedResult.rows) {
      const bomId = normalizeText(row.bom_id);
      const producedItem = normalizeText(row.produced_item);
      const location = normalizeText(row.location);
      if (!bomId || !producedItem) continue;

      const producedItemKey = normalizeUpper(producedItem);
      const producedItemDesc = itemDescMap.get(producedItemKey) ?? "";
      const itemReleaseFlag = releaseFlagMap.get(producedItemKey) ?? "";

      const routingRows = (routingsByBomId.get(bomId) || []).filter(
        (r) => !r.produced_item || r.produced_item === producedItem
      );

      if (routingRows.length === 0) {
        mergedRows.push({
          id: `${bomId}__NOROUTING`,
          location,
          produced_item: producedItem,
          produced_item_desc: producedItemDesc,
          bom_id: bomId,
          resource: "",
          routing_id: "",
          item_release_flag: itemReleaseFlag,
        });
        continue;
      }

      for (const routing of routingRows) {
        mergedRows.push({
          id: `${bomId}__${routing.routing_id || routing.resource || "ROW"}`,
          location,
          produced_item: producedItem,
          produced_item_desc: producedItemDesc,
          bom_id: bomId,
          resource: routing.resource || "",
          routing_id: routing.routing_id || "",
          item_release_flag: itemReleaseFlag,
        });
      }
    }

    return res.status(200).json({
      success: true,
      data: mergedRows,
    });
  } catch (error) {
    console.error("DB Error (existing-bom-search):", error);
    return res.status(500).json({
      error: "Failed to fetch existing BOM search rows",
      details: error.message,
    });
  }
});

router.put("/modify-bom", async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const payload = req.body || {};
    const bomId = String(payload.bomId || "").trim();
    const producedItem = payload.producedItem || {};
    const engineeringChange = payload.engineeringChange || {};
    const notes = String(payload.notes || "").trim();
    const locations = Array.isArray(payload.locations) ? payload.locations : [];

    if (!bomId) {
      throw new Error("bomId is required");
    }

    if (!locations.length) {
      throw new Error("At least one location is required");
    }

    // ---------------------------------------------------------
    // Local helpers
    // Prefer postgresql_rec_id first
    // ---------------------------------------------------------
    const resolvePrimaryIdColumn = async (tableName) => {
      const columns = await getExistingColumns(client, tableName);

      if (columns.includes("postgresql_rec_id")) return "postgresql_rec_id";
      if (columns.includes("rec_id")) return "rec_id";
      if (columns.includes("record_id")) return "record_id";
      if (columns.includes("recordid")) return "recordid";
      if (columns.includes("id")) return "id";

      return null;
    };

    const getResolvedRowId = (row, idColumn) => {
      if (!row) return null;
      return (
        row[idColumn] ??
        row.postgresql_rec_id ??
        row.rec_id ??
        row.record_id ??
        row.recordid ??
        row.id ??
        null
      );
    };

    const buildModifiedSummary = (title, changes) => {
      const validChanges = (changes || []).filter(Boolean);
      if (!validChanges.length) {
        return "";
      }
      return `Modified the ${title}.`;
    };

    const buildConsolidatedModifiedSummary = (categories) => {
      const cleaned = Array.from(new Set((categories || []).filter(Boolean)));

      if (!cleaned.length) {
        return "Modified BOM records";
      }

      if (cleaned.length === 1) {
        return `Modified the ${cleaned[0]}.`;
      }

      const stripInformation = (value) =>
        String(value || "")
          .replace(/\s+information$/i, "")
          .trim();

      const baseLabels = cleaned.map(stripInformation);

      const joinedBase =
        baseLabels.length === 2
          ? `${baseLabels[0]} & ${baseLabels[1]}`
          : `${baseLabels.slice(0, -1).join(", ")}, and ${
              baseLabels[baseLabels.length - 1]
            }`;

      const suffix = cleaned.every((value) =>
        /information$/i.test(String(value || ""))
      )
        ? " information"
        : "";

      return `Modified the ${joinedBase}${suffix}.`;
    };

    // ---------------------------------------------------------
    // Engineering Change ID generated in backend
    // ---------------------------------------------------------
    const engineeringChangeId = generateUniqueId("EC-");
    const derivedBomVersion = getBomVersionFromBomId(bomId);

    // Current CST/Chicago date-time
    const chicagoNow = new Date(
      new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })
    );
    const chicagoDate = chicagoNow.toISOString().slice(0, 10);

    const changeLogTable = "planning_bom_change_log_summary";
    const changeLogColumns = await getExistingColumns(client, changeLogTable);

    // Resolve actual ID columns dynamically
    const bomProducedIdColumn = await resolvePrimaryIdColumn("bom_produced");
    const itemBomRoutingIdColumn = await resolvePrimaryIdColumn("item_bom_routing");
    const bomConsumedIdColumn = await resolvePrimaryIdColumn("bom_consumed");
    const bomParametersIdColumn = await resolvePrimaryIdColumn("bom_parameters");

    if (!bomProducedIdColumn) {
      throw new Error("Could not resolve primary id column for bom_produced");
    }
    if (!itemBomRoutingIdColumn) {
      throw new Error("Could not resolve primary id column for item_bom_routing");
    }
    if (!bomConsumedIdColumn) {
      throw new Error("Could not resolve primary id column for bom_consumed");
    }
    if (!bomParametersIdColumn) {
      throw new Error("Could not resolve primary id column for bom_parameters");
    }

    // ---------------------------------------------------------
    // Collect consolidated changelog info
    // ---------------------------------------------------------
    const consolidatedLocations = new Set();
    const consolidatedResources = new Set();
    const consolidatedSummaryCategories = new Set();
    const consolidatedItems = new Set();

    // ---------------------------------------------------------
    // Archive helper only (no per-row changelog insert)
    // ---------------------------------------------------------
    const archiveOnly = async ({
      sourceTable,
      archiveTable,
      sourceRow,
      actualRecId,
      logProducedItem,
      logItem,
      logLocation,
      logResource,
      summaryText,
      summaryCategory,
    }) => {
      const archiveExists = await pgTableExists(client, archiveTable);
      if (!archiveExists) {
        throw new Error(`Archive table ${archiveTable} does not exist`);
      }

      const archiveColumns = await getExistingColumns(client, archiveTable);
      const archiveRow = { ...sourceRow };

      // IMPORTANT:
      // _og tables must generate their own postgresql_rec_id from sequence.
      delete archiveRow.postgresql_rec_id;

      if (archiveColumns.includes("engineering_change_id")) {
        archiveRow.engineering_change_id = engineeringChangeId;
      }
      if (archiveColumns.includes("engineeringchangeid")) {
        archiveRow.engineeringchangeid = engineeringChangeId;
      }

      if (archiveColumns.includes("change_type")) {
        archiveRow.change_type = "Modified";
      }
      if (archiveColumns.includes("changetype")) {
        archiveRow.changetype = "Modified";
      }

      if (archiveColumns.includes("notes")) {
        archiveRow.notes = notes || "";
      }
      if (archiveColumns.includes("summarynotes")) {
        archiveRow.summarynotes = notes || "";
      }
      if (archiveColumns.includes("change_summary")) {
        archiveRow.change_summary = summaryText || "";
      }

      if (archiveColumns.includes("source_table")) {
        archiveRow.source_table = sourceTable;
      }
      if (archiveColumns.includes("source_rec_id")) {
        archiveRow.source_rec_id = actualRecId;
      }
      if (archiveColumns.includes("original_rec_id")) {
        archiveRow.original_rec_id = actualRecId;
      }

      if (archiveColumns.includes("archived_at")) {
        archiveRow.archived_at = new Date();
      }
      if (archiveColumns.includes("archived_on")) {
        archiveRow.archived_on = new Date();
      }
      if (archiveColumns.includes("deleted_at")) {
        archiveRow.deleted_at = new Date();
      }
      if (archiveColumns.includes("deleted_on")) {
        archiveRow.deleted_on = new Date();
      }

      const { query, values } = buildDynamicInsertQuery(
        archiveTable,
        archiveRow,
        archiveColumns
      );

      await client.query(query, values);

      if (logLocation) {
        consolidatedLocations.add(String(logLocation).trim());
      }
      if (logResource) {
        consolidatedResources.add(String(logResource).trim());
      }
      if (logProducedItem) {
        consolidatedItems.add(String(logProducedItem).trim());
      }
      if (logItem) {
        consolidatedItems.add(String(logItem).trim());
      }
      if (summaryCategory) {
        consolidatedSummaryCategories.add(String(summaryCategory).trim());
      }
    };

    // ---------------------------------------------------------
    // BOM_PARAMETERS is bom_id-level only. Archive/update once.
    // Use first location context for consolidated location/resource.
    // ---------------------------------------------------------
    const firstLocation = locations[0] || {};
    const firstLocationName = String(firstLocation?.locationName || "").trim();
    const firstRoutingId = String(firstLocation?.resourceInfo?.routingId || "").trim();
    const firstResource =
      String(firstLocation?.resourceInfo?.resource || "").trim() ||
      (firstRoutingId ? getResourceFromRoutingId(firstRoutingId) : "");

    const paramsLiveResult = await client.query(
      `
      SELECT *
      FROM bom_parameters
      WHERE TRIM(CAST(bom_id AS TEXT)) = $1
      LIMIT 1
      `,
      [bomId]
    );

    if (!paramsLiveResult.rows.length) {
      throw new Error(`No matching bom_parameters row found for bom_id=${bomId}`);
    }

    const paramsLiveRow = paramsLiveResult.rows[0];
    const paramsActualRecId = getResolvedRowId(
      paramsLiveRow,
      bomParametersIdColumn
    );

    if (paramsActualRecId == null || String(paramsActualRecId).trim() === "") {
      throw new Error(
        `Could not resolve live row id for bom_parameters using column ${bomParametersIdColumn}`
      );
    }

    const parameterChanges = [];
    if (
      String(paramsLiveRow.erp_bom_start_date ?? "") !==
      String(engineeringChange.creationDate ?? "")
    ) {
      parameterChanges.push(
        `BOM Start Date (${paramsLiveRow.erp_bom_start_date ?? ""} -> ${
          engineeringChange.creationDate ?? ""
        })`
      );
    }

    await archiveOnly({
      sourceTable: "bom_parameters",
      archiveTable: "bom_parameters_og",
      sourceRow: paramsLiveRow,
      actualRecId: paramsActualRecId,
      logProducedItem: producedItem.item || "",
      logItem: producedItem.item || "",
      logLocation: firstLocationName,
      logResource: firstResource,
      summaryText: buildModifiedSummary(
        "engineering / BOM parameter information",
        parameterChanges
      ),
      summaryCategory: parameterChanges.length
        ? "engineering / BOM parameter information"
        : "",
    });

    await client.query(
      `
      UPDATE bom_parameters
      SET
        erp_bom_start_date = $1,
        erp_bom_end_date = $2,
        load_datetime = $3
      WHERE ${quoteIdent(bomParametersIdColumn)} = $4
      `,
      [
        HARD_CODED_START_DATE,
        HARD_CODED_END_DATE,
        HARD_CODED_LOAD_DATETIME,
        paramsActualRecId,
      ]
    );

    // ---------------------------------------------------------
    // Process each location payload
    // ---------------------------------------------------------
    for (const location of locations) {
      const locationName = String(location?.locationName || "").trim();
      const routingId = String(location?.resourceInfo?.routingId || "").trim();

      const priority =
        location?.resourceInfo?.priority === "" ||
        location?.resourceInfo?.priority == null
          ? null
          : Number(location.resourceInfo.priority);

      const coProductAssociation =
        location?.resourceInfo?.coProductAssociation === "" ||
        location?.resourceInfo?.coProductAssociation == null
          ? null
          : Number(location.resourceInfo.coProductAssociation);

      const resource =
        String(location?.resourceInfo?.resource || "").trim() ||
        (routingId ? getResourceFromRoutingId(routingId) : "");

      if (!locationName) {
        throw new Error("locationName is required in locations");
      }

      if (!routingId) {
        throw new Error("routingId is required in resourceInfo");
      }

      // =========================================================
      // 1) BOM_PRODUCED
      // =========================================================
      const producedLiveResult = await client.query(
        `
        SELECT *
        FROM bom_produced
        WHERE TRIM(CAST(bom_id AS TEXT)) = $1
          AND TRIM(CAST(location AS TEXT)) = $2
        LIMIT 1
        `,
        [bomId, locationName]
      );

      if (!producedLiveResult.rows.length) {
        throw new Error(
          `No matching bom_produced row found for bom_id=${bomId}, location=${locationName}`
        );
      }

      const producedLiveRow = producedLiveResult.rows[0];
      const producedActualRecId = getResolvedRowId(
        producedLiveRow,
        bomProducedIdColumn
      );

      if (
        producedActualRecId == null ||
        String(producedActualRecId).trim() === ""
      ) {
        throw new Error(
          `Could not resolve live row id for bom_produced using column ${bomProducedIdColumn}`
        );
      }

      const producedChanges = [];
      if (String(producedLiveRow.item ?? "") !== String(producedItem.item ?? "")) {
        producedChanges.push(
          `Produced Item (${producedLiveRow.item ?? ""} -> ${producedItem.item ?? ""})`
        );
      }
      if (
        String(producedLiveRow.bom_status ?? "") !==
        String(producedItem.status ?? "")
      ) {
        producedChanges.push(
          `BOM Status (${producedLiveRow.bom_status ?? ""} -> ${producedItem.status ?? ""})`
        );
      }
      if (String(producedLiveRow.location ?? "") !== String(locationName)) {
        producedChanges.push(
          `Location (${producedLiveRow.location ?? ""} -> ${locationName})`
        );
      }

      await archiveOnly({
        sourceTable: "bom_produced",
        archiveTable: "bom_produced_og",
        sourceRow: producedLiveRow,
        actualRecId: producedActualRecId,
        logProducedItem: producedItem.item || "",
        logItem: producedItem.item || "",
        logLocation: locationName,
        logResource: resource,
        summaryText: buildModifiedSummary(
          "produced item information",
          producedChanges
        ),
        summaryCategory: producedChanges.length
          ? "produced item information"
          : "",
      });

      await client.query(
        `
        UPDATE bom_produced
        SET
          item = $1,
          location = $2,
          bom_status = $3,
          bom_version = $4,
          prefix = $5,
          bom_plan_type = $6,
          load_datetime = $7
        WHERE ${quoteIdent(bomProducedIdColumn)} = $8
        `,
        [
          producedItem.item || null,
          locationName,
          HARD_CODED_BOM_STATUS,
          derivedBomVersion || null,
          HARD_CODED_PREFIX,
          HARD_CODED_BOM_PLAN_TYPE,
          HARD_CODED_LOAD_DATETIME,
          producedActualRecId,
        ]
      );

      // =========================================================
      // 2) ITEM_BOM_ROUTING
      // =========================================================
      const routingLiveResult = await client.query(
        `
        SELECT *
        FROM item_bom_routing
        WHERE TRIM(CAST(bom_id AS TEXT)) = $1
          AND TRIM(CAST(routing_id AS TEXT)) = $2
        LIMIT 1
        `,
        [bomId, routingId]
      );

      const routingLiveRow = routingLiveResult.rows[0] || null;

      if (!routingLiveRow) {
        throw new Error(
          `No matching item_bom_routing row found for bom_id=${bomId}, routing_id=${routingId}`
        );
      }

      const routingActualRecId = getResolvedRowId(
        routingLiveRow,
        itemBomRoutingIdColumn
      );

      if (
        routingActualRecId == null ||
        String(routingActualRecId).trim() === ""
      ) {
        throw new Error(
          `Could not resolve live row id for item_bom_routing using column ${itemBomRoutingIdColumn}`
        );
      }

      const routingChanges = [];
      if (String(routingLiveRow.routing_id ?? "") !== String(routingId ?? "")) {
        routingChanges.push(
          `Routing ID (${routingLiveRow.routing_id ?? ""} -> ${routingId ?? ""})`
        );
      }
      if (
        String(routingLiveRow.erp_item_bom_routing_priority ?? "") !==
        String(priority ?? "")
      ) {
        routingChanges.push(
          `Routing Priority (${routingLiveRow.erp_item_bom_routing_priority ?? ""} -> ${priority ?? ""})`
        );
      }
      if (
        String(routingLiveRow.erp_co_product_association ?? "") !==
        String(coProductAssociation ?? "")
      ) {
        routingChanges.push(
          `Co-Product Association (${routingLiveRow.erp_co_product_association ?? ""} -> ${coProductAssociation ?? ""})`
        );
      }

      await archiveOnly({
        sourceTable: "item_bom_routing",
        archiveTable: "item_bom_routing_og",
        sourceRow: routingLiveRow,
        actualRecId: routingActualRecId,
        logProducedItem: producedItem.item || "",
        logItem: producedItem.item || "",
        logLocation: locationName,
        logResource: resource,
        summaryText: buildModifiedSummary(
          "co-product information",
          routingChanges
        ),
        summaryCategory: routingChanges.length
          ? "co-product information"
          : "",
      });

      await client.query(
        `
        UPDATE item_bom_routing
        SET
          routing_id = $1,
          erp_item_bom_routing_priority = $2,
          erp_co_product_association = $3,
          load_datetime = $4
        WHERE ${quoteIdent(itemBomRoutingIdColumn)} = $5
        `,
        [
          routingId || routingLiveRow.routing_id || null,
          priority,
          coProductAssociation,
          HARD_CODED_LOAD_DATETIME,
          routingActualRecId,
        ]
      );

   // =========================================================
      // 3) BOM_CONSUMED
      // If row exists -> archive + update
      // If row missing -> insert new row
      // =========================================================
      const bomConsumedColumns = await getExistingColumns(client, "bom_consumed");

      for (const component of Array.isArray(location.componentItems)
        ? location.componentItems
        : []) {
        const componentItem = String(component?.componentItem || "").trim();
        const standardUsage =
          component?.standardUsage === "" || component?.standardUsage == null
            ? null
            : Number(component.standardUsage);

        if (!componentItem) {
          continue;
        }

        const consumedLiveResult = await client.query(
          `
          SELECT *
          FROM bom_consumed
          WHERE TRIM(CAST(bom_id AS TEXT)) = $1
            AND TRIM(CAST(location AS TEXT)) = $2
            AND TRIM(CAST(item AS TEXT)) = $3
          LIMIT 1
          `,
          [bomId, locationName, componentItem]
        );

        // ---------------------------------------------------------
        // Existing row found -> archive + update
        // ---------------------------------------------------------
        if (consumedLiveResult.rows.length) {
          const consumedLiveRow = consumedLiveResult.rows[0];
          const consumedActualRecId = getResolvedRowId(
            consumedLiveRow,
            bomConsumedIdColumn
          );

          if (
            consumedActualRecId == null ||
            String(consumedActualRecId).trim() === ""
          ) {
            throw new Error(
              `Could not resolve live row id for bom_consumed using column ${bomConsumedIdColumn}`
            );
          }

          const componentChanges = [];
          if (String(consumedLiveRow.item ?? "") !== String(componentItem)) {
            componentChanges.push(
              `Component Item (${consumedLiveRow.item ?? ""} -> ${componentItem})`
            );
          }
          if (
            String(consumedLiveRow.erp_bom_quantity_consumed_per ?? "") !==
            String(standardUsage ?? "")
          ) {
            componentChanges.push(
              `Standard Usage (${consumedLiveRow.erp_bom_quantity_consumed_per ?? ""} -> ${standardUsage ?? ""})`
            );
          }

          await archiveOnly({
            sourceTable: "bom_consumed",
            archiveTable: "bom_consumed_og",
            sourceRow: consumedLiveRow,
            actualRecId: consumedActualRecId,
            logProducedItem: producedItem.item || "",
            logItem: componentItem,
            logLocation: locationName,
            logResource: resource,
            summaryText: buildModifiedSummary(
              "component information",
              componentChanges
            ),
            summaryCategory: componentChanges.length
              ? "component information"
              : "",
          });

          await client.query(
            `
            UPDATE bom_consumed
            SET
              item = $1,
              erp_bom_quantity_consumed_per = $2,
              erp_bom_component_start_date = $3,
              erp_bom_component_end_date = $4,
              load_datetime = $5
            WHERE ${quoteIdent(bomConsumedIdColumn)} = $6
            `,
            [
              componentItem,
              standardUsage,
              HARD_CODED_START_DATE,
              HARD_CODED_END_DATE,
              HARD_CODED_LOAD_DATETIME,
              consumedActualRecId,
            ]
          );
        } else {
          // ---------------------------------------------------------
          // Row missing -> insert new bom_consumed row
          // ---------------------------------------------------------
          const newConsumedRow = {
            bom_id: bomId,
            item: componentItem,
            location: locationName,
            erp_bom_quantity_consumed_per: standardUsage,
            erp_bom_component_start_date: HARD_CODED_START_DATE,
            erp_bom_component_end_date: HARD_CODED_END_DATE,
            load_datetime: HARD_CODED_LOAD_DATETIME,
            rec_id: generateUniqueBigInt(),
          };

          const consumedInsert = buildInsertQuery(
            "bom_consumed",
            newConsumedRow,
            bomConsumedColumns
          );

          await client.query(consumedInsert.query, consumedInsert.values);

          consolidatedItems.add(String(componentItem).trim());
          consolidatedLocations.add(String(locationName).trim());
          if (resource) {
            consolidatedResources.add(String(resource).trim());
          }
          consolidatedSummaryCategories.add("component information");
        }
      }
    }

    // ---------------------------------------------------------
    // Insert only ONE consolidated changelog row
    // ---------------------------------------------------------
    const consolidatedLocationText = Array.from(consolidatedLocations)
      .filter(Boolean)
      .join(", ");

    const consolidatedResourceText = Array.from(consolidatedResources)
      .filter(Boolean)
      .join(", ");

    const consolidatedItemText = Array.from(consolidatedItems)
      .filter(Boolean)
      .join(", ");

    const consolidatedSummaryText = buildConsolidatedModifiedSummary(
      Array.from(consolidatedSummaryCategories)
    );

    const consolidatedChangeLogRow = {};

    if (changeLogColumns.includes("rec_id")) {
      consolidatedChangeLogRow.rec_id = generateRandomSixDigit();
    }
    if (changeLogColumns.includes("record_id")) {
      consolidatedChangeLogRow.record_id = generateRandomSixDigit();
    }

    if (changeLogColumns.includes("postgresql_rec_id")) {
      consolidatedChangeLogRow.postgresql_rec_id = null;
    }

    if (changeLogColumns.includes("engineering_change_id")) {
      consolidatedChangeLogRow.engineering_change_id = engineeringChangeId;
    }
    if (changeLogColumns.includes("engineeringchangeid")) {
      consolidatedChangeLogRow.engineeringchangeid = engineeringChangeId;
    }

    if (changeLogColumns.includes("change_type")) {
      consolidatedChangeLogRow.change_type = "Modified";
    }
    if (changeLogColumns.includes("changetype")) {
      consolidatedChangeLogRow.changetype = "Modified";
    }

    if (changeLogColumns.includes("target_table")) {
      consolidatedChangeLogRow.target_table = "consolidated tables";
    }

    if (changeLogColumns.includes("bom_id")) {
      consolidatedChangeLogRow.bom_id = bomId;
    }
    if (changeLogColumns.includes("bom_ids")) {
      consolidatedChangeLogRow.bom_ids = bomId;
    }

    if (changeLogColumns.includes("produced_item")) {
      consolidatedChangeLogRow.produced_item =
        producedItem.item || consolidatedItemText || "";
    }

    if (changeLogColumns.includes("item")) {
      consolidatedChangeLogRow.item =
        consolidatedItemText || producedItem.item || "";
    }

    if (changeLogColumns.includes("location")) {
      consolidatedChangeLogRow.location = consolidatedLocationText;
    }
    if (changeLogColumns.includes("locations")) {
      consolidatedChangeLogRow.locations = consolidatedLocationText;
    }

    if (changeLogColumns.includes("resource")) {
      consolidatedChangeLogRow.resource = consolidatedResourceText;
    }
    if (changeLogColumns.includes("resources")) {
      consolidatedChangeLogRow.resources = consolidatedResourceText;
    }

    if (changeLogColumns.includes("change_date")) {
      consolidatedChangeLogRow.change_date = chicagoDate;
    }
    if (changeLogColumns.includes("created_at")) {
      consolidatedChangeLogRow.created_at = chicagoNow;
    }
    if (changeLogColumns.includes("created_on")) {
      consolidatedChangeLogRow.created_on = chicagoNow;
    }

    if (changeLogColumns.includes("user_name")) {
      consolidatedChangeLogRow.user_name = "SYSTEM_USER";
    }
    if (changeLogColumns.includes("created_by")) {
      consolidatedChangeLogRow.created_by = "SYSTEM_USER";
    }
    if (changeLogColumns.includes("updated_by")) {
      consolidatedChangeLogRow.updated_by = "SYSTEM_USER";
    }

    if (changeLogColumns.includes("summarynotes")) {
      consolidatedChangeLogRow.summarynotes = notes || "";
    }
    if (changeLogColumns.includes("change_summary")) {
      consolidatedChangeLogRow.change_summary = consolidatedSummaryText;
    }
    if (changeLogColumns.includes("notes")) {
      consolidatedChangeLogRow.notes = notes || "";
    }

    if (changeLogColumns.includes("status")) {
      consolidatedChangeLogRow.status = "COMPLETED";
    }

    const {
      query: consolidatedChangeLogInsertQuery,
      values: consolidatedChangeLogInsertValues,
    } = buildDynamicInsertQuery(
      changeLogTable,
      consolidatedChangeLogRow,
      changeLogColumns
    );

    await client.query(
      consolidatedChangeLogInsertQuery,
      consolidatedChangeLogInsertValues
    );

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      message: "BOM updated successfully",
      engineeringChangeId,
      changeType: "Modified",
      bomId,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("DB Error (modify-bom):", error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  } finally {
    client.release();
  }
});



/* =========================================================
   4) CREATE ITEM BOM ROUTING + CHANGE LOG
========================================================= */
router.post("/item-bom-routing/create", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      bomId = "",
      producedItem = "",
      itemReleaseFlag = "",
      location = "",
      resource = "",
      resourceRelevancy = "",
      routingPriority = "",
      routingId = "",
      addConnectedCoProduct = false,
      coProductItem = "",
      notes = "",
      changeType = "Added",
      user = {},
    } = req.body || {};

    const changedByUserId =
      String(user?.userId || "").trim() || "SYSTEM_USER";
    const changedByUserName =
      String(user?.userName || "").trim() || "SYSTEM_USER";

    if (!bomId || !producedItem || !location || !resource || !routingId) {
      return res.status(400).json({
        error:
          "bomId, producedItem, location, resource, and routingId are required",
      });
    }

    await client.query("BEGIN");

    const engineeringChangeId = generateUniqueId("EC-");
    const trxnSetId = generateUniqueId("TRXN-");
    const now = new Date();

    const itemBomRoutingColumns = await getExistingColumns(
      client,
      "item_bom_routing"
    );
    const changeLogColumns = await getExistingColumns(
      client,
      "planning_bom_change_log_summary"
    );

    // ---------------------------------------------------------
    // item_bom_routing INSERT DATA
    // Match actual PostgreSQL schema
    // ---------------------------------------------------------
    const itemBomRoutingData = {
      routing_id: routingId,
      bom_id: bomId,
      item: producedItem,

      // actual schema columns in item_bom_routing
      erp_item_bom_routing_priority:
        routingPriority === "" || routingPriority == null
          ? null
          : Number(routingPriority),

      erp_item_bom_routing_min_lot_size: 1,
      erp_item_bom_routing_lot_size_increment: 1,
      erp_item_bom_routing_wip_sweep_priority: 1,
      erp_co_product_association: addConnectedCoProduct ? 1 : 0,
      erp_item_bom_routing_max_lot_size: null,

      load_datetime: HARD_CODED_LOAD_DATETIME,
      rec_id: generateUniqueBigInt(),
    };

    const itemInsert = buildInsertQuery(
      "item_bom_routing",
      itemBomRoutingData,
      itemBomRoutingColumns
    );

    const insertedItemBomRouting = await client.query(
      itemInsert.query,
      itemInsert.values
    );

    const insertedRow = insertedItemBomRouting.rows?.[0] || {};

    // IMPORTANT:
    // item_bom_routing PK/default-generated identifier is postgresql_rec_id
    let postgresqlRecId =
      insertedRow.postgresql_rec_id ??
      insertedRow.rec_id ??
      insertedRow.id ??
      null;

    // fallback lookup if RETURNING doesn't give expected id
    if (postgresqlRecId === null || postgresqlRecId === undefined) {
      try {
        const lookupConditions = [];
        const lookupValues = [];
        let idx = 1;

        if (itemBomRoutingColumns.includes("routing_id")) {
          lookupConditions.push(`routing_id = $${idx++}`);
          lookupValues.push(routingId);
        }

        if (itemBomRoutingColumns.includes("bom_id")) {
          lookupConditions.push(`bom_id = $${idx++}`);
          lookupValues.push(bomId);
        }

        if (lookupConditions.length > 0) {
          const idSelectColumn = itemBomRoutingColumns.includes("postgresql_rec_id")
            ? "postgresql_rec_id"
            : itemBomRoutingColumns.includes("rec_id")
              ? "rec_id"
              : itemBomRoutingColumns.includes("id")
                ? "id"
                : null;

          if (idSelectColumn) {
            const lookupQuery = `
              SELECT ${idSelectColumn} AS resolved_id
              FROM item_bom_routing
              WHERE ${lookupConditions.join(" AND ")}
              ORDER BY ${idSelectColumn} DESC
              LIMIT 1
            `;

            const lookupResult = await client.query(lookupQuery, lookupValues);
            postgresqlRecId = lookupResult.rows?.[0]?.resolved_id ?? null;
          }
        }
      } catch (lookupError) {
        console.error("Lookup warning (item_bom_routing postgresql_rec_id):", lookupError);
      }
    }

    const changeLogRecId = generateUniqueBigInt();

    if (postgresqlRecId === null || postgresqlRecId === undefined) {
      postgresqlRecId = changeLogRecId;
    }

    // ---------------------------------------------------------
    // planning_bom_change_log_summary INSERT DATA
    // summarynotes = user notes
    // change_summary = action summary
    // ---------------------------------------------------------
    const normalizedChangeType = String(changeType || "Added").trim();

    const changeLogData = {
      rec_id: changeLogRecId,
      engineering_change_id: engineeringChangeId,
      postgresql_rec_id: postgresqlRecId,
      change_type: normalizedChangeType,
      target_table: "item_bom_routing",
      bom_id: bomId,
      produced_item: producedItem,
      location,
      change_date: now.toISOString().slice(0, 10),
      user_name: changedByUserName,
    };

    if (changeLogColumns.includes("created_at")) {
      changeLogData.created_at = now;
    }

    if (changeLogColumns.includes("created_on")) {
      changeLogData.created_on = now;
    }


    if (changeLogColumns.includes("resource")) {
      changeLogData.resource = resource;
    }

    if (changeLogColumns.includes("resources")) {
      changeLogData.resources = resource;
    }

    if (changeLogColumns.includes("summarynotes")) {
      changeLogData.summarynotes = notes || "";
    }

    if (changeLogColumns.includes("notes")) {
      changeLogData.notes = notes || "";
    }

    if (changeLogColumns.includes("change_summary")) {
      changeLogData.change_summary =
        normalizedChangeType === "Added"
          ? "Added 1 BOM ID in item_bom_routing"
          : normalizedChangeType === "Modified"
            ? "Modified 1 BOM ID in item_bom_routing"
            : normalizedChangeType === "Deleted"
              ? "Deleted 1 BOM ID in item_bom_routing"
              : normalizedChangeType;
    }

    const changeLogInsert = buildInsertQuery(
      "planning_bom_change_log_summary",
      changeLogData,
      changeLogColumns
    );

    await client.query(changeLogInsert.query, changeLogInsert.values);

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Item BOM routing record created successfully",
      data: {
        engineeringChangeId,
        trxnSetId,
        postgresqlRecId,
        recId: changeLogRecId,
        routingId,
        bomId,
        producedItem,
        location,
        resource,
      },
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("DB Error (item-bom-routing/create):", error);

    return res.status(500).json({
      error: "Failed to create item BOM routing record",
      details: error.message,
    });
  } finally {
    client.release();
  }
});
/* =========================================================
   DELETE BOM - Step 2 Summary
========================================================= */
router.get("/delete-bom/summary", async (req, res) => {
  try {
    const bomIds = normalizeTextArray(
      req.query.bomIds || req.query.bomId || req.query["bomIds[]"]
    );

    if (!bomIds.length) {
      return res.status(400).json({
        error: "bomIds is required",
      });
    }

    const summaryResult = await pool.query(
      `
        WITH ranked_produced AS (
          SELECT
            TRIM(CAST(bp.bom_id AS TEXT)) AS bom_id,
            TRIM(CAST(bp.item AS TEXT)) AS produced_item,
            TRIM(CAST(bp.location AS TEXT)) AS location,
            '' AS produced_item_desc,
            ROW_NUMBER() OVER (
              PARTITION BY TRIM(CAST(bp.bom_id AS TEXT))
              ORDER BY
                CASE
                  WHEN COALESCE(TRIM(CAST(bp.erp_bom_qty_produced_per AS TEXT)), '') IN ('1', '1.0', '1.00')
                    THEN 0
                  ELSE 1
                END,
                TRIM(CAST(bp.item AS TEXT))
            ) AS rn
          FROM bom_produced bp
          WHERE TRIM(CAST(bp.bom_id AS TEXT)) = ANY($1::text[])
        )
        SELECT
          bom_id,
          produced_item,
          produced_item_desc,
          location
        FROM ranked_produced
        WHERE rn = 1
        ORDER BY bom_id
      `,
      [bomIds]
    );

    const routingResult = await pool.query(
      `
        SELECT
          TRIM(CAST(ibr.bom_id AS TEXT)) AS bom_id,
          COALESCE(
            NULLIF(
              TRIM(
                CAST(
                  regexp_replace(CAST(ibr.routing_id AS TEXT), '^.*_', '')
                  AS TEXT
                )
              ),
              ''
            ),
            ''
          ) AS resource,
          TRIM(CAST(ibr.routing_id AS TEXT)) AS routing_id
        FROM item_bom_routing ibr
        WHERE TRIM(CAST(ibr.bom_id AS TEXT)) = ANY($1::text[])
        ORDER BY
          TRIM(CAST(ibr.bom_id AS TEXT)),
          TRIM(CAST(ibr.routing_id AS TEXT))
      `,
      [bomIds]
    );

    const countsResult = await pool.query(
      `
        SELECT 'bom_parameters' AS table_name, COUNT(*)::int AS row_count
        FROM bom_parameters
        WHERE TRIM(CAST(bom_id AS TEXT)) = ANY($1::text[])

        UNION ALL

        SELECT 'bom_produced' AS table_name, COUNT(*)::int AS row_count
        FROM bom_produced
        WHERE TRIM(CAST(bom_id AS TEXT)) = ANY($1::text[])

        UNION ALL

        SELECT 'bom_consumed' AS table_name, COUNT(*)::int AS row_count
        FROM bom_consumed
        WHERE TRIM(CAST(bom_id AS TEXT)) = ANY($1::text[])

        UNION ALL

        SELECT 'item_bom_routing' AS table_name, COUNT(*)::int AS row_count
        FROM item_bom_routing
        WHERE TRIM(CAST(bom_id AS TEXT)) = ANY($1::text[])
      `,
      [bomIds]
    );

    return res.status(200).json({
      success: true,
      data: {
        bomSummary: summaryResult.rows || [],
        routingSummary: routingResult.rows || [],
        tableCounts: countsResult.rows || [],
      },
    });
  } catch (error) {
    console.error("DB Error (delete-bom/summary):", error);
    return res.status(500).json({
      error: "Failed to fetch delete BOM summary",
      details: error.message,
    });
  }
});

/* =========================================================
   DELETE BOM - Execute permanent delete with archive
========================================================= */
router.post("/delete-bom/execute", async (req, res) => {
  const client = await pool.connect();

  try {
    const bomIds = normalizeTextArray(req.body?.bomIds);
    const notes = toText(req.body?.notes);
    const user = req.body?.user || {};

    const changedBy =
      String(user?.userName || "").trim() ||
      String(user?.userId || "").trim() ||
      "SYSTEM_USER";

    if (!bomIds.length) {
      return res.status(400).json({
        error: "bomIds must be a non-empty array",
      });
    }

    await client.query("BEGIN");

    const now = new Date();
    const engineeringChangeId = generateDeleteBomEngineeringChangeId();

    const ogRecIds = {
      bom_parameters_og: [],
      bom_produced_og: [],
      bom_consumed_og: [],
      item_bom_routing_og: [],
    };

    const movedCounts = {
      bom_parameters: 0,
      bom_produced: 0,
      bom_consumed: 0,
      item_bom_routing: 0,
    };

    const changeLogTable = "planning_bom_change_log_summary";
    const changeLogExists = await pgTableExists(client, changeLogTable);
    if (!changeLogExists) {
      throw new Error("planning_bom_change_log_summary table does not exist");
    }

    const changeLogColumns = await getExistingColumns(client, changeLogTable);

    const getProducedItemFromBomId = (bomId) => {
      const parts = String(bomId || "")
        .split("_")
        .map((p) => p.trim())
        .filter(Boolean);

      return parts.length >= 3 ? parts[1] : "";
    };

    const getLocationFromBomId = (bomId) => {
      const parts = String(bomId || "")
        .split("_")
        .map((p) => p.trim())
        .filter(Boolean);

      return parts.length >= 3 ? parts[2] : "";
    };

    const getResourceFromRoutingId = (routingId) => {
      const parts = String(routingId || "")
        .split("_")
        .map((p) => p.trim())
        .filter(Boolean);

      return parts.length >= 4 ? parts.slice(3).join("_") : "";
    };

    // ---------------------------------------------------------
    // Build resource lookup from LIVE item_bom_routing before deletes
    // ---------------------------------------------------------
    const resourceByBomAndLocation = new Map();

    const routingLookupResult = await client.query(
      `
        SELECT
          TRIM(CAST(bom_id AS TEXT)) AS bom_id,
          TRIM(CAST(routing_id AS TEXT)) AS routing_id
        FROM item_bom_routing
        WHERE TRIM(CAST(bom_id AS TEXT)) = ANY($1::text[])
      `,
      [bomIds]
    );

    for (const routeRow of routingLookupResult.rows || []) {
      const bomIdText = toText(routeRow.bom_id);
      const routingIdText = toText(routeRow.routing_id);
      const locationFromBomId = getLocationFromBomId(bomIdText);
      const resourceFromRouting = getResourceFromRoutingId(routingIdText);

      if (!bomIdText || !locationFromBomId || !resourceFromRouting) continue;

      const key = `${bomIdText}__${locationFromBomId}`;

      if (!resourceByBomAndLocation.has(key)) {
        resourceByBomAndLocation.set(key, resourceFromRouting);
      }
    }

    const getResourceForBomAndLocation = (bomId, location) => {
      const key = `${toText(bomId)}__${toText(location)}`;
      if (resourceByBomAndLocation.has(key)) {
        return resourceByBomAndLocation.get(key);
      }

      const bomPrefix = `${toText(bomId)}__`;
      const match = [...resourceByBomAndLocation.entries()].find(([k]) =>
        k.startsWith(bomPrefix)
      );

      return match?.[1] || "";
    };

    // ---------------------------------------------------------
    // Collect consolidated changelog info
    // ---------------------------------------------------------
    const consolidatedBomIds = new Set();
    const consolidatedLocations = new Set();
    const consolidatedResources = new Set();
    const consolidatedProducedItems = new Set();
    const consolidatedTargetTables = new Set();
    let totalDeletedRecords = 0;
    let firstArchivedRecId = null;

    // ---------------------------------------------------------
    // Archive all matching rows table-by-table
    // ---------------------------------------------------------
    for (const [sourceTable, archiveTable] of Object.entries(
      DELETE_BOM_SOURCE_TO_ARCHIVE
    )) {
      const archiveExists = await pgTableExists(client, archiveTable);
      if (!archiveExists) {
        throw new Error(`Archive table ${archiveTable} does not exist`);
      }

      const sourceResult = await client.query(
        `
          SELECT *
          FROM ${quoteIdent(sourceTable)}
          WHERE TRIM(CAST(bom_id AS TEXT)) = ANY($1::text[])
        `,
        [bomIds]
      );

      const sourceRows = sourceResult.rows || [];
      if (!sourceRows.length) {
        continue;
      }

      const archiveColumns = await getExistingColumns(client, archiveTable);

      for (const row of sourceRows) {
        const archiveRow = buildDeleteBomArchiveRow({
          baseRow: row,
          archiveColumns,
          engineeringChangeId,
          notes,
          sourceTable,
        });

        const { query, values } = buildDynamicInsertQuery(
          archiveTable,
          archiveRow,
          archiveColumns
        );

        const inserted = await client.query(query, values);
        const insertedRow = inserted.rows?.[0] || {};

        const archivedRecId =
          insertedRow.rec_id ??
          insertedRow.record_id ??
          insertedRow.recordid ??
          insertedRow.postgresql_rec_id ??
          null;

        if (archivedRecId != null) {
          ogRecIds[archiveTable].push(String(archivedRecId));
          if (firstArchivedRecId == null) {
            firstArchivedRecId = archivedRecId;
          }
        }

        const producedItem =
          row.produced_item ??
          row.item ??
          getProducedItemFromBomId(row.bom_id);

        const rowLocation =
          row.location ??
          getLocationFromBomId(row.bom_id);

        const rowResource =
          toText(row.resource) ||
          getResourceFromRoutingId(row.routing_id) ||
          getResourceForBomAndLocation(
            row.bom_id,
            row.location || getLocationFromBomId(row.bom_id)
          );

        if (row.bom_id) {
          consolidatedBomIds.add(String(row.bom_id).trim());
        }
        if (rowLocation) {
          consolidatedLocations.add(String(rowLocation).trim());
        }
        if (rowResource) {
          consolidatedResources.add(String(rowResource).trim());
        }
        if (producedItem) {
          consolidatedProducedItems.add(String(producedItem).trim());
        }

        consolidatedTargetTables.add(sourceTable);
        totalDeletedRecords += 1;
      }

      const deletedCount = await deleteRowsByBomId(client, sourceTable, bomIds);
      movedCounts[sourceTable] = deletedCount;
    }

    // ---------------------------------------------------------
    // Insert only ONE consolidated changelog row
    // ---------------------------------------------------------
    const deletedBomIdCount = consolidatedBomIds.size;

    const consolidatedChangeSummary = `Deleted ${deletedBomIdCount} BOM ID${deletedBomIdCount === 1 ? "" : "s"
      } from consolidated tables`;

    const consolidatedChangeLogRow = {};

    if (changeLogColumns.includes("rec_id")) {
      consolidatedChangeLogRow.rec_id = generateUniqueBigInt();
    }
    if (changeLogColumns.includes("record_id")) {
      consolidatedChangeLogRow.record_id = generateUniqueBigInt();
    }

    if (changeLogColumns.includes("postgresql_rec_id")) {
      consolidatedChangeLogRow.postgresql_rec_id = firstArchivedRecId;
    }

    if (changeLogColumns.includes("engineering_change_id")) {
      consolidatedChangeLogRow.engineering_change_id = engineeringChangeId;
    }
    if (changeLogColumns.includes("engineeringchangeid")) {
      consolidatedChangeLogRow.engineeringchangeid = engineeringChangeId;
    }

    if (changeLogColumns.includes("change_type")) {
      consolidatedChangeLogRow.change_type = "Deleted";
    }
    if (changeLogColumns.includes("changetype")) {
      consolidatedChangeLogRow.changetype = "Deleted";
    }

    if (changeLogColumns.includes("target_table")) {
      consolidatedChangeLogRow.target_table = "consolidated tables";
    }

    const consolidatedBomIdText = Array.from(consolidatedBomIds)
      .filter(Boolean)
      .join(", ");

    const consolidatedLocationText = Array.from(consolidatedLocations)
      .filter(Boolean)
      .join(", ");

    const consolidatedResourceText = Array.from(consolidatedResources)
      .filter(Boolean)
      .join(", ");

    const consolidatedProducedItemText = Array.from(consolidatedProducedItems)
      .filter(Boolean)
      .join(", ");

    const consolidatedTargetTableText = Array.from(consolidatedTargetTables)
      .filter(Boolean)
      .join(", ");

    if (changeLogColumns.includes("bom_id")) {
      consolidatedChangeLogRow.bom_id = consolidatedBomIdText;
    }
    if (changeLogColumns.includes("bom_ids")) {
      consolidatedChangeLogRow.bom_ids = consolidatedBomIdText;
    }

    if (changeLogColumns.includes("produced_item")) {
      consolidatedChangeLogRow.produced_item = consolidatedProducedItemText;
    }
    if (changeLogColumns.includes("item")) {
      consolidatedChangeLogRow.item = consolidatedProducedItemText;
    }

    if (changeLogColumns.includes("location")) {
      consolidatedChangeLogRow.location = consolidatedLocationText;
    }
    if (changeLogColumns.includes("locations")) {
      consolidatedChangeLogRow.locations = consolidatedLocationText;
    }

    if (changeLogColumns.includes("resource")) {
      consolidatedChangeLogRow.resource = consolidatedResourceText;
    }
    if (changeLogColumns.includes("resources")) {
      consolidatedChangeLogRow.resources = consolidatedResourceText;
    }

    if (changeLogColumns.includes("summarynotes")) {
      consolidatedChangeLogRow.summarynotes = notes || "";
    }
    if (changeLogColumns.includes("notes")) {
      consolidatedChangeLogRow.notes = notes || "";
    }
    if (changeLogColumns.includes("change_summary")) {
      consolidatedChangeLogRow.change_summary = consolidatedChangeSummary;
    }

    if (changeLogColumns.includes("user_name")) {
      consolidatedChangeLogRow.user_name = changedBy;
    }
    if (changeLogColumns.includes("created_by")) {
      consolidatedChangeLogRow.created_by = changedBy;
    }
    if (changeLogColumns.includes("updated_by")) {
      consolidatedChangeLogRow.updated_by = changedBy;
    }

    if (changeLogColumns.includes("change_date")) {
      consolidatedChangeLogRow.change_date = now.toISOString().slice(0, 10);
    }
    if (changeLogColumns.includes("created_at")) {
      consolidatedChangeLogRow.created_at = now;
    }
    if (changeLogColumns.includes("created_on")) {
      consolidatedChangeLogRow.created_on = now;
    }
    if (changeLogColumns.includes("status")) {
      consolidatedChangeLogRow.status = "COMPLETED";
    }

    // optional extra target table text if such a column exists later
    if (changeLogColumns.includes("target_tables")) {
      consolidatedChangeLogRow.target_tables = consolidatedTargetTableText;
    }

    const {
      query: consolidatedChangeLogInsertQuery,
      values: consolidatedChangeLogInsertValues,
    } = buildDynamicInsertQuery(
      changeLogTable,
      consolidatedChangeLogRow,
      changeLogColumns
    );

    await client.query(
      consolidatedChangeLogInsertQuery,
      consolidatedChangeLogInsertValues
    );

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      message:
        "Selected BOM records were permanently deleted and archived successfully.",
      engineeringChangeId,
      changeType: "Deleted",
      bomIds,
      movedCounts,
      ogRecIds,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("DB Error (delete-bom/execute):", error);
    return res.status(500).json({
      error: "Failed to delete and archive selected BOM records",
      details: error.message,
    });
  } finally {
    client.release();
  }
});


/* =========================================================
   EXISTING ITEM BOM ROUTING SEARCH - Step 1
========================================================= */
router.get("/existing-item-bom-routing-search", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        TRIM(CAST(ibr.rec_id AS TEXT)) AS rec_id,
        TRIM(CAST(ibr.item AS TEXT)) AS item,
        TRIM(CAST(ibr.bom_id AS TEXT)) AS bom_id,
        TRIM(CAST(ibr.routing_id AS TEXT)) AS routing_id,

        COALESCE(
          NULLIF(
            SUBSTRING(
              TRIM(CAST(ibr.routing_id AS TEXT))
              FROM '^[^_]+_[^_]+_([^_]+)_[^_]+$'
            ),
            ''
          ),
          ''
        ) AS location,

        COALESCE(
          NULLIF(
            SUBSTRING(
              TRIM(CAST(ibr.routing_id AS TEXT))
              FROM '^[^_]+_[^_]+_[^_]+_(.+)$'
            ),
            ''
          ),
          ''
        ) AS resource

      FROM item_bom_routing ibr
      WHERE ibr.routing_id IS NOT NULL
        AND TRIM(CAST(ibr.routing_id AS TEXT)) <> ''
      ORDER BY
        TRIM(CAST(ibr.bom_id AS TEXT)),
        TRIM(CAST(ibr.routing_id AS TEXT))
    `);

    return res.status(200).json({
      success: true,
      data: result.rows || [],
    });
  } catch (error) {
    console.error("DB Error (existing-item-bom-routing-search):", error);
    return res.status(500).json({
      error: "Failed to fetch existing item BOM routing rows",
      details: error.message,
    });
  }
});

/* =========================================================
   DELETE ITEM BOM ROUTING - Execute delete with archive
========================================================= */
router.post("/delete-item-bom-routing/execute", async (req, res) => {
  const client = await pool.connect();

  try {
    const records = Array.isArray(req.body?.records) ? req.body.records : [];
    const notes = String(req.body?.notes ?? "").trim();
    const user = req.body?.user || {};

    const changedBy =
      String(user?.userName || "").trim() ||
      String(user?.userId || "").trim() ||
      "SYSTEM_USER";

    if (!records.length) {
      return res.status(400).json({
        error: "records must be a non-empty array",
      });
    }

    const archiveTable = "item_bom_routing_og";
    const changeLogTable = "planning_bom_change_log_summary";

    const archiveExists = await pgTableExists(client, archiveTable);
    if (!archiveExists) {
      return res.status(500).json({
        error: "item_bom_routing_og table does not exist",
      });
    }

    const changeLogExists = await pgTableExists(client, changeLogTable);
    if (!changeLogExists) {
      return res.status(500).json({
        error: "planning_bom_change_log_summary table does not exist",
      });
    }

    await client.query("BEGIN");

    const engineeringChangeId = generateDeleteItemBomRoutingEngineeringChangeId();

    const archiveColumns = await getExistingColumns(client, archiveTable);
    const changeLogColumns = await getExistingColumns(client, changeLogTable);

    const archivedRecIds = [];
    let movedCount = 0;

    const processedLiveKeys = new Set();
    const consolidatedBomIds = new Set();
    const consolidatedLocations = new Set();
    const consolidatedResources = new Set();
    const consolidatedProducedItems = new Set();

    let firstArchivedPostgresqlRecId = null;

    const getLocationFromBomId = (bomId) => {
      const value = String(bomId || "").trim();
      if (!value) return "";
      const parts = value.split("_").map((p) => p.trim()).filter(Boolean);
      return parts.length >= 3 ? parts.slice(2).join("_") : "";
    };

    const getResourceFromRoutingId = (routingId) => {
      const value = String(routingId || "").trim();
      if (!value) return "";
      const parts = value.split("_").map((p) => p.trim()).filter(Boolean);
      return parts.length >= 4 ? parts.slice(3).join("_") : "";
    };

    for (const record of records) {
      const recId = String(record?.rec_id ?? "").trim();
      const bomId = String(record?.bom_id ?? "").trim();
      const routingId = String(record?.routing_id ?? "").trim();

      if (!recId && !bomId && !routingId) {
        continue;
      }

      const conditions = [];
      const params = [];
      let p = 1;

      if (recId) {
        conditions.push(`TRIM(CAST(rec_id AS TEXT)) = $${p++}`);
        params.push(recId);
      }
      if (bomId) {
        conditions.push(`TRIM(CAST(bom_id AS TEXT)) = $${p++}`);
        params.push(bomId);
      }
      if (routingId) {
        conditions.push(`TRIM(CAST(routing_id AS TEXT)) = $${p++}`);
        params.push(routingId);
      }

      const sourceQuery = `
        SELECT *
        FROM item_bom_routing
        WHERE ${conditions.join(" AND ")}
      `;

      const sourceResult = await client.query(sourceQuery, params);
      const sourceRows = sourceResult.rows || [];

      for (const row of sourceRows) {
        const liveUniqueKey =
          String(
            row.postgresql_rec_id ??
            row.rec_id ??
            row.record_id ??
            row.recordid ??
            ""
          ) +
          "__" +
          String(row.bom_id ?? "") +
          "__" +
          String(row.routing_id ?? "");

        if (processedLiveKeys.has(liveUniqueKey)) {
          continue;
        }
        processedLiveKeys.add(liveUniqueKey);

        const archiveRow = { ...row };

        // IMPORTANT:
        // _og table must generate its own PK
        delete archiveRow.postgresql_rec_id;

        if (archiveColumns.includes("engineering_change_id")) {
          archiveRow.engineering_change_id = engineeringChangeId;
        }
        if (archiveColumns.includes("engineeringchangeid")) {
          archiveRow.engineeringchangeid = engineeringChangeId;
        }

        if (archiveColumns.includes("change_type")) {
          archiveRow.change_type = "Deleted";
        }
        if (archiveColumns.includes("changetype")) {
          archiveRow.changetype = "Deleted";
        }

        if (archiveColumns.includes("notes")) {
          archiveRow.notes = notes || "";
        }

        if (archiveColumns.includes("summarynotes")) {
          archiveRow.summarynotes = notes || "";
        }

        if (archiveColumns.includes("change_summary")) {
          archiveRow.change_summary = "";
        }

        if (archiveColumns.includes("source_table")) {
          archiveRow.source_table = "item_bom_routing";
        }

        if (archiveColumns.includes("source_rec_id")) {
          archiveRow.source_rec_id =
            row.rec_id ?? row.record_id ?? row.recordid ?? null;
        }

        // match schema: ERP-prefixed columns in item_bom_routing_og
        if (archiveColumns.includes("erp_item_bom_routing_min_lot_size")) {
          archiveRow.erp_item_bom_routing_min_lot_size =
            row.erp_item_bom_routing_min_lot_size ?? 1;
        }

        if (archiveColumns.includes("erp_item_bom_routing_lot_size_increment")) {
          archiveRow.erp_item_bom_routing_lot_size_increment =
            row.erp_item_bom_routing_lot_size_increment ?? 1;
        }

        if (archiveColumns.includes("erp_item_bom_routing_wip_sweep_priority")) {
          archiveRow.erp_item_bom_routing_wip_sweep_priority =
            row.erp_item_bom_routing_wip_sweep_priority ?? 1;
        }

        if (archiveColumns.includes("archived_at")) {
          archiveRow.archived_at = new Date();
        }
        if (archiveColumns.includes("archived_on")) {
          archiveRow.archived_on = new Date();
        }
        if (archiveColumns.includes("deleted_at")) {
          archiveRow.deleted_at = new Date();
        }
        if (archiveColumns.includes("deleted_on")) {
          archiveRow.deleted_on = new Date();
        }

        const { query: archiveInsertQuery, values: archiveInsertValues } =
          buildDynamicInsertQuery(archiveTable, archiveRow, archiveColumns);

        const archiveInsertResult = await client.query(
          archiveInsertQuery,
          archiveInsertValues
        );

        const insertedOgRow = archiveInsertResult.rows?.[0] || {};

        const archivedPostgresqlRecId =
          insertedOgRow.postgresql_rec_id ??
          null;

        if (archivedPostgresqlRecId != null) {
          archivedRecIds.push(String(archivedPostgresqlRecId));
          if (firstArchivedPostgresqlRecId == null) {
            firstArchivedPostgresqlRecId = archivedPostgresqlRecId;
          }
        }

        const producedItem =
          row.produced_item ??
          row.item ??
          "";

        const derivedLocation =
          row.location ??
          getLocationFromBomId(row.bom_id);

        const derivedResource =
          row.resource ??
          getResourceFromRoutingId(row.routing_id);

        if (row.bom_id) {
          consolidatedBomIds.add(String(row.bom_id).trim());
        }
        if (derivedLocation) {
          consolidatedLocations.add(String(derivedLocation).trim());
        }
        if (derivedResource) {
          consolidatedResources.add(String(derivedResource).trim());
        }
        if (producedItem) {
          consolidatedProducedItems.add(String(producedItem).trim());
        }

        // delete live row only after archive insert
        await deleteItemBomRoutingByBomAndRouting(
          client,
          row.bom_id,
          row.routing_id
        );

        movedCount += 1;
      }
    }

    const consolidatedBomIdText = Array.from(consolidatedBomIds)
      .filter(Boolean)
      .join(", ");

    const consolidatedLocationText = Array.from(consolidatedLocations)
      .filter(Boolean)
      .join(", ");

    const consolidatedResourceText = Array.from(consolidatedResources)
      .filter(Boolean)
      .join(", ");

    const consolidatedProducedItemText = Array.from(consolidatedProducedItems)
      .filter(Boolean)
      .join(", ");

    const deletedBomIdCount = consolidatedBomIds.size;

    const deleteChangeSummary = `Deleted ${deletedBomIdCount} BOM ID${deletedBomIdCount === 1 ? "" : "s"
      } in item_bom_routing`;

    const consolidatedChangeLogRow = {};

    if (changeLogColumns.includes("rec_id")) {
      consolidatedChangeLogRow.rec_id = generateUniqueBigInt();
    }
    if (changeLogColumns.includes("record_id")) {
      consolidatedChangeLogRow.record_id = generateUniqueBigInt();
    }

    if (changeLogColumns.includes("postgresql_rec_id")) {
      consolidatedChangeLogRow.postgresql_rec_id = firstArchivedPostgresqlRecId;
    }

    if (changeLogColumns.includes("engineering_change_id")) {
      consolidatedChangeLogRow.engineering_change_id = engineeringChangeId;
    }
    if (changeLogColumns.includes("engineeringchangeid")) {
      consolidatedChangeLogRow.engineeringchangeid = engineeringChangeId;
    }

    if (changeLogColumns.includes("change_type")) {
      consolidatedChangeLogRow.change_type = "Deleted";
    }
    if (changeLogColumns.includes("changetype")) {
      consolidatedChangeLogRow.changetype = "Deleted";
    }

    if (changeLogColumns.includes("target_table")) {
      consolidatedChangeLogRow.target_table = "consolidated tables";
    }

    if (changeLogColumns.includes("bom_id")) {
      consolidatedChangeLogRow.bom_id = consolidatedBomIdText;
    }
    if (changeLogColumns.includes("bom_ids")) {
      consolidatedChangeLogRow.bom_ids = consolidatedBomIdText;
    }

    if (changeLogColumns.includes("produced_item")) {
      consolidatedChangeLogRow.produced_item = consolidatedProducedItemText;
    }
    if (changeLogColumns.includes("item")) {
      consolidatedChangeLogRow.item = consolidatedProducedItemText;
    }

    if (changeLogColumns.includes("location")) {
      consolidatedChangeLogRow.location = consolidatedLocationText;
    }
    if (changeLogColumns.includes("locations")) {
      consolidatedChangeLogRow.locations = consolidatedLocationText;
    }

    if (changeLogColumns.includes("resource")) {
      consolidatedChangeLogRow.resource = consolidatedResourceText;
    }
    if (changeLogColumns.includes("resources")) {
      consolidatedChangeLogRow.resources = consolidatedResourceText;
    }

    if (changeLogColumns.includes("summarynotes")) {
      consolidatedChangeLogRow.summarynotes = notes || "";
    }
    if (changeLogColumns.includes("notes")) {
      consolidatedChangeLogRow.notes = notes || "";
    }
    if (changeLogColumns.includes("change_summary")) {
      consolidatedChangeLogRow.change_summary = deleteChangeSummary;
    }

    if (changeLogColumns.includes("user_name")) {
      consolidatedChangeLogRow.user_name = changedBy;
    }
    if (changeLogColumns.includes("created_by")) {
      consolidatedChangeLogRow.created_by = changedBy;
    }
    if (changeLogColumns.includes("updated_by")) {
      consolidatedChangeLogRow.updated_by = changedBy;
    }

    const now = new Date();

    if (changeLogColumns.includes("change_date")) {
      consolidatedChangeLogRow.change_date = now.toISOString().slice(0, 10);
    }
    if (changeLogColumns.includes("created_at")) {
      consolidatedChangeLogRow.created_at = now;
    }
    if (changeLogColumns.includes("created_on")) {
      consolidatedChangeLogRow.created_on = now;
    }
    if (changeLogColumns.includes("status")) {
      consolidatedChangeLogRow.status = "COMPLETED";
    }

    const {
      query: changeLogInsertQuery,
      values: changeLogInsertValues,
    } = buildDynamicInsertQuery(
      changeLogTable,
      consolidatedChangeLogRow,
      changeLogColumns
    );

    await client.query(changeLogInsertQuery, changeLogInsertValues);

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      message: "Selected Item BOM Routing records were deleted successfully.",
      engineeringChangeId,
      changeType: "Deleted",
      movedCount,
      archivedRecIds,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("DB Error (delete-item-bom-routing/execute):", error);
    return res.status(500).json({
      error: "Failed to delete item BOM routing records",
      details: error.message,
    });
  } finally {
    client.release();
  }
});

/* =========================================================
   ENGINEERING CHANGE LOG SUMMARY
   GET /api/tables/engineering-change-log
   Fetch logs from planning_bom_change_log_summary (PostgreSQL)
========================================================= */
router.get("/engineering-change-log", async (req, res) => {
  try {
    const columns = await getExistingColumns(
      { query: (...args) => pool.query(...args) },
      "planning_bom_change_log_summary"
    );

    if (!columns || columns.length === 0) {
      return res.status(500).json({
        error: "planning_bom_change_log_summary table columns could not be resolved",
      });
    }

    const selectParts = [];

    // Engineering Change #
    if (columns.includes("engineering_change_id")) {
      selectParts.push(`CAST(engineering_change_id AS TEXT) AS engineering_change_id`);
    } else if (columns.includes("engineeringchangeid")) {
      selectParts.push(`CAST(engineeringchangeid AS TEXT) AS engineering_change_id`);
    } else {
      selectParts.push(`'' AS engineering_change_id`);
    }


   // Change Date
    if (columns.includes("created_at")) {
      selectParts.push(`CAST(created_at AS TEXT) AS change_date`);
    } else if (columns.includes("created_on")) {
      selectParts.push(`CAST(created_on AS TEXT) AS change_date`);
    } else if (columns.includes("change_date")) {
      selectParts.push(`CAST(change_date AS TEXT) AS change_date`);
    } else {
      selectParts.push(`'' AS change_date`);
    }

    // Change Type
    if (columns.includes("change_type")) {
      selectParts.push(`CAST(change_type AS TEXT) AS change_type`);
    } else if (columns.includes("changetype")) {
      selectParts.push(`CAST(changetype AS TEXT) AS change_type`);
    } else {
      selectParts.push(`'' AS change_type`);
    }

    // Location(s)
    if (columns.includes("location")) {
      selectParts.push(`CAST(location AS TEXT) AS locations`);
    } else if (columns.includes("locations")) {
      selectParts.push(`CAST(locations AS TEXT) AS locations`);
    } else {
      selectParts.push(`'' AS locations`);
    }

    // BOM ID(s)
    if (columns.includes("bom_id")) {
      selectParts.push(`CAST(bom_id AS TEXT) AS bom_ids`);
    } else if (columns.includes("bom_ids")) {
      selectParts.push(`CAST(bom_ids AS TEXT) AS bom_ids`);
    } else {
      selectParts.push(`'' AS bom_ids`);
    }

    // Resource(s)
    if (columns.includes("resource")) {
      selectParts.push(`CAST(resource AS TEXT) AS resources`);
    } else if (columns.includes("resources")) {
      selectParts.push(`CAST(resources AS TEXT) AS resources`);
    } else if (columns.includes("routing_id")) {
      selectParts.push(`CAST(routing_id AS TEXT) AS resources`);
    } else {
      selectParts.push(`'' AS resources`);
    }

    // User
    if (columns.includes("user_name")) {
      selectParts.push(`CAST(user_name AS TEXT) AS user_name`);
    } else if (columns.includes("created_by")) {
      selectParts.push(`CAST(created_by AS TEXT) AS user_name`);
    } else if (columns.includes("updated_by")) {
      selectParts.push(`CAST(updated_by AS TEXT) AS user_name`);
    } else {
      selectParts.push(`'' AS user_name`);
    }

    // Change Summary
    if (columns.includes("change_summary")) {
      selectParts.push(`CAST(change_summary AS TEXT) AS change_summary`);
    } else if (columns.includes("summarynotes")) {
      selectParts.push(`CAST(summarynotes AS TEXT) AS change_summary`);
    } else if (columns.includes("notes")) {
      selectParts.push(`CAST(notes AS TEXT) AS change_summary`);
    } else if (columns.includes("target_table")) {
      selectParts.push(`CAST(target_table AS TEXT) AS change_summary`);
    } else {
      selectParts.push(`'' AS change_summary`);
    }

    // Optional raw rec_id for debugging/reference
    if (columns.includes("rec_id")) {
      selectParts.push(`CAST(rec_id AS TEXT) AS rec_id`);
    } else if (columns.includes("record_id")) {
      selectParts.push(`CAST(record_id AS TEXT) AS rec_id`);
    } else {
      selectParts.push(`'' AS rec_id`);
    }

    const orderBy =
      columns.includes("created_at")
        ? `ORDER BY created_at DESC`
        : columns.includes("created_on")
          ? `ORDER BY created_on DESC`
          : columns.includes("change_date")
            ? `ORDER BY change_date DESC`
            : columns.includes("engineering_change_id")
              ? `ORDER BY engineering_change_id DESC`
              : ``;

    const query = `
      SELECT
        ${selectParts.join(",\n        ")}
      FROM planning_bom_change_log_summary
      ${orderBy}
    `;

    const result = await pool.query(query);

    return res.status(200).json({
      success: true,
      data: result.rows || [],
    });
  } catch (error) {
    console.error("DB Error (engineering-change-log):", error);
    return res.status(500).json({
      error: "Failed to fetch engineering change log",
      details: error.message,
    });
  }
});

router.get("/engineering-changes-detail-add", async (req, res) => {
  try {
    const engineeringChangeId = String(
      req.query.changeID || req.query.engineeringChangeId || ""
    ).trim();

    if (!engineeringChangeId) {
      return res.status(400).json({
        error: "engineeringChangeId/changeID is required",
      });
    }

    const changeLogTable = "planning_bom_change_log_summary";
    const changeLogColumns = await getExistingColumns(pool, changeLogTable);

    const dateSelectExpr = changeLogColumns.includes("created_at")
      ? "created_at AS actual_change_ts"
      : changeLogColumns.includes("created_on")
      ? "created_on AS actual_change_ts"
      : changeLogColumns.includes("change_date")
      ? "change_date AS actual_change_ts"
      : "NULL AS actual_change_ts";

    const orderByExpr = changeLogColumns.includes("created_at")
      ? "created_at DESC NULLS LAST, engineering_change_id DESC"
      : changeLogColumns.includes("created_on")
      ? "created_on DESC NULLS LAST, engineering_change_id DESC"
      : changeLogColumns.includes("change_date")
      ? "change_date DESC NULLS LAST, engineering_change_id DESC"
      : "engineering_change_id DESC";

    // ---------------------------------------------------------
    // Fetch summary row(s) for this engineering change
    // ---------------------------------------------------------
    const summaryQuery = `
      SELECT
        engineering_change_id,
        change_type,
        bom_id,
        produced_item,
        location,
        resource,
        summarynotes,
        change_summary,
        user_name,
        ${dateSelectExpr}
      FROM ${changeLogTable}
      WHERE engineering_change_id = $1
        AND LOWER(change_type) LIKE 'add%'
      ORDER BY ${orderByExpr}
    `;

    const summaryResult = await pool.query(summaryQuery, [engineeringChangeId]);
    const summaryRows = summaryResult.rows || [];

    if (!summaryRows.length) {
      return res.status(404).json({
        error: "No matching add-change rows found in planning_bom_change_log_summary",
        details: { engineeringChangeId },
      });
    }

    const firstSummaryRow = summaryRows[0] || {};

    const splitCsv = (value) =>
      String(value || "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);

    const fallbackResourceFromRoutingId = (routingId) => {
      const value = String(routingId || "").trim();
      if (!value) return "";
      const parts = value.split("_").map((p) => p.trim()).filter(Boolean);
      return parts.length >= 4 ? parts.slice(3).join("_") : "";
    };

    const deriveLocationFromBomId = (bomId) => {
      const parts = String(bomId || "")
        .split("_")
        .map((p) => p.trim())
        .filter(Boolean);
      return parts.length >= 3 ? parts[2] : "";
    };

    // ---------------------------------------------------------
    // Expand BOM IDs from summary rows
    // This is the key fix for your "1 card instead of 6 cards" issue
    // ---------------------------------------------------------
    const uniqueBomIds = Array.from(
      new Set(
        summaryRows.flatMap((row) => splitCsv(row.bom_id))
      )
    );

    const createdRecords = [];

    for (const bomId of uniqueBomIds) {
      const derivedLocation = deriveLocationFromBomId(bomId);

      const producedQuery = `
        SELECT *
        FROM bom_produced
        WHERE TRIM(CAST(bom_id AS TEXT)) = $1
          AND ($2 = '' OR TRIM(CAST(location AS TEXT)) = $2)
        ORDER BY load_datetime DESC NULLS LAST
      `;

      const consumedQuery = `
        SELECT *
        FROM bom_consumed
        WHERE TRIM(CAST(bom_id AS TEXT)) = $1
          AND ($2 = '' OR TRIM(CAST(location AS TEXT)) = $2)
        ORDER BY load_datetime DESC NULLS LAST
      `;

      const routingQuery = `
        SELECT *
        FROM item_bom_routing
        WHERE TRIM(CAST(bom_id AS TEXT)) = $1
        ORDER BY load_datetime DESC NULLS LAST, TRIM(CAST(routing_id AS TEXT))
      `;

      const parameterQuery = `
        SELECT *
        FROM bom_parameters
        WHERE TRIM(CAST(bom_id AS TEXT)) = $1
        ORDER BY load_datetime DESC NULLS LAST
      `;

      const [
        producedResult,
        consumedResult,
        routingResult,
        parameterResult,
      ] = await Promise.all([
        pool.query(producedQuery, [bomId, derivedLocation]),
        pool.query(consumedQuery, [bomId, derivedLocation]),
        pool.query(routingQuery, [bomId]),
        pool.query(parameterQuery, [bomId]),
      ]);

      const bomProducedRows = producedResult.rows || [];
      const bomConsumedRows = consumedResult.rows || [];
      const itemBomRoutingRows = routingResult.rows || [];
      const bomParametersRows = parameterResult.rows || [];

      const primaryProducedRow =
        bomProducedRows.find((row) => {
          const qty = Number(
            row.erp_bom_qty_produced_per ??
              row.bom_qty_produced_per ??
              row.qty_produced_per ??
              0
          );
          return qty === 1;
        }) || bomProducedRows[0] || {};

      const mainProducedItem = String(primaryProducedRow.item || "").trim();

      const coProductRows = bomProducedRows.filter((row) => {
        const itemValue = String(row.item || "").trim();
        if (!itemValue) return false;
        return itemValue !== mainProducedItem;
      });

      const routingRow = itemBomRoutingRows[0] || {};
      const resolvedResource =
        fallbackResourceFromRoutingId(routingRow.routing_id) || "";

      createdRecords.push({
        key: `bom_detail_${bomId}`,
        bomId,
        item: mainProducedItem || "-",
        itemReleaseFlag: "",
        resource: resolvedResource,
        resourceRelevancy: "",
        routingId: routingRow.routing_id || "",
        priority:
          routingRow.erp_item_bom_routing_priority ??
          routingRow.item_bom_routing_priority ??
          "",
        coProductAssociation:
          routingRow.erp_co_product_association ??
          routingRow.co_product_association ??
          "",
        bomStartDate:
          bomParametersRows[0]?.erp_bom_start_date ||
          bomParametersRows[0]?.bom_start_date ||
          "",
        bomEndDate:
          bomParametersRows[0]?.erp_bom_end_date ||
          bomParametersRows[0]?.bom_end_date ||
          "",
        components: bomConsumedRows.map((row, componentIndex) => ({
          key: `component_${bomId}_${componentIndex}`,
          componentItem: row.item || "",
          description: "",
          standardUsage:
            row.erp_bom_quantity_consumed_per ??
            row.bom_quantity_consumed_per ??
            "",
          startDate:
            row.erp_bom_component_start_date ??
            row.bom_component_start_date ??
            "",
          endDate:
            row.erp_bom_component_end_date ??
            row.bom_component_end_date ??
            "",
        })),
        coProducts: coProductRows.map((row, coIndex) => ({
          key: `coproduct_${bomId}_${coIndex}`,
          coProductItem: row.item || "",
          description: "",
          qtyProducedPer:
            row.erp_bom_qty_produced_per ??
            row.bom_qty_produced_per ??
            row.qty_produced_per ??
            "",
        })),
      });
    }

    return res.json({
      engineeringChangeId,
      changeDate: firstSummaryRow.actual_change_ts || "",
      user: firstSummaryRow.user_name || "",
      changeType: "Added",
      summaryNotes: firstSummaryRow.summarynotes || "",
      changeSummary: firstSummaryRow.change_summary || "",
      createdRecords,
      summaryLogRows: summaryRows,
    });
  } catch (error) {
    console.error("DB Error (engineering-changes-detail-add):", error);
    return res.status(500).json({
      error: "Failed to fetch engineering add detail",
      details: error.message,
    });
  }
});
``


router.get("/engineering-changes-detail-delete-bom", async (req, res) => {
  try {
    const engineeringChangeId = String(
      req.query.changeID || req.query.engineeringChangeId || ""
    ).trim();

    const bomId = String(req.query.bomID || req.query.bomId || "").trim();
    const location = String(req.query.location || "").trim();
    const resource = String(req.query.resource || "").trim();
    const item = String(req.query.item || req.query.producedItem || "").trim();

    if (!engineeringChangeId || !bomId) {
      return res.status(400).json({
        error: "engineeringChangeId/changeID and bomId/bomID are required",
        details: {
          engineeringChangeId,
          bomId,
          location,
          resource,
          item,
        },
      });
    }

    const query = `
      SELECT
        engineering_change_id,
        change_type,
        target_table,
        bom_id,
        produced_item,
        location,
        resource,
        summarynotes,
        change_summary,
        change_date,
        user_name,
        postgresql_rec_id,
        rec_id
      FROM planning_bom_change_log_summary
      WHERE engineering_change_id = $1
        AND bom_id = $2
        AND LOWER(change_type) LIKE 'deleted%'
        AND ($3 = '' OR location = $3)
        AND ($4 = '' OR resource = $4)
        AND ($5 = '' OR produced_item = $5)
      ORDER BY target_table, rec_id
    `;

    const result = await pool.query(query, [
      engineeringChangeId,
      bomId,
      location,
      resource,
      item,
    ]);

    const rows = result.rows || [];

    if (!rows.length) {
      return res.status(404).json({
        error: "No matching deleted BOM rows found in planning_bom_change_log_summary",
        details: {
          engineeringChangeId,
          bomId,
          location,
          resource,
          item,
        },
      });
    }

    const firstRow = rows[0] || {};

    const derivedRoutingId =
      (firstRow.produced_item || item) && (firstRow.resource || resource)
        ? `ROUTING_${firstRow.produced_item || item}_${firstRow.resource || resource}`
        : "";

    const deletedBomRecords = rows.map((row) => ({
      producedItem: row.produced_item || "",
      itemDescription: "",
      location: row.location || "",
      bomId: row.bom_id || "",
      resource: row.resource || "",
      routingId:
        row.produced_item && row.resource
          ? `ROUTING_${row.produced_item}_${row.resource}`
          : "",
      summaryNotes: row.summarynotes || "",
      changeSummary: row.change_summary || "",
      targetTable: row.target_table || "",
      postgresqlRecId: row.postgresql_rec_id || "",
      recId: row.rec_id || "",
    }));

    return res.status(200).json({
      success: true,
      data: {
        engineeringChangeId:
          firstRow.engineering_change_id || engineeringChangeId,
        changeDate: firstRow.change_date || "",
        user: firstRow.user_name || "SYSTEM_USER",
        changeType: "Deleted",
        item: firstRow.produced_item || item || "",
        itemDescription: "",
        location: firstRow.location || location || "",
        bomId: firstRow.bom_id || bomId || "",
        resource: firstRow.resource || resource || "",
        routingId: derivedRoutingId,
        summaryNotes: firstRow.summarynotes || "",
        changeSummary: firstRow.change_summary || "",
        deletedBomRecords,
        summaryRows: rows,
      },
    });
  } catch (error) {
    console.error("DB Error (engineering-changes-detail-delete-bom):", error);
    return res.status(500).json({
      error: "Failed to fetch engineering delete BOM detail",
      details: error.message,
    });
  }
});

router.get("/engineering-changes-detail-modify", async (req, res) => {
  const client = await pool.connect();

  try {
    const engineeringChangeId = String(req.query.engineeringChangeId || "").trim();
    const bomId = String(req.query.bomId || "").trim();
    const location = String(req.query.location || "").trim();
    const resource = String(req.query.resource || "").trim();
    const producedItem = String(req.query.producedItem || req.query.item || "").trim();
    const componentItem = String(req.query.componentItem || "").trim();

    if (!engineeringChangeId) {
      return res.status(400).json({
        success: false,
        message: "engineeringChangeId is required",
      });
    }

    if (!bomId) {
      return res.status(400).json({
        success: false,
        message: "bomId is required",
      });
    }

    if (!location) {
      return res.status(400).json({
        success: false,
        message: "location is required",
      });
    }

    // ---------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------
    const safeText = (value) => {
      if (value === null || value === undefined) return "";
      return String(value).trim();
    };

    const isSame = (a, b) => safeText(a) === safeText(b);

    const buildDetailRow = (field, value) => ({
      field,
      value: value ?? "",
    });

    const buildChangeRow = (field, originalValue, updatedValue) => ({
      field,
      originalValue: originalValue ?? "",
      updatedValue: updatedValue ?? "",
      changed: !isSame(originalValue, updatedValue),
    });

    const getResourceFromRoutingIdLocal = (routingId) => {
      const value = safeText(routingId);
      if (!value) return "";

      // Example:
      // 1001_20054_R20_RETORT_20 -> R20_RETORT_20
      const parts = value.split("_").filter(Boolean);
      if (parts.length <= 2) return value;
      return parts.slice(2).join("_");
    };

    const fetchSingleRow = async ({
      tableName,
      whereClause,
      values,
      orderBy = "",
    }) => {
      const query = `
        SELECT *
        FROM ${quoteIdent(tableName)}
        WHERE ${whereClause}
        ${orderBy ? `ORDER BY ${orderBy}` : ""}
        LIMIT 1
      `;
      const result = await client.query(query, values);
      return result.rows[0] || null;
    };

    // ---------------------------------------------------------
    // 1) Fetch header row from planning_bom_change_log_summary
    // support consolidated location/resource text too
    // ---------------------------------------------------------
    const headerQuery = `
      SELECT *
      FROM planning_bom_change_log_summary
      WHERE engineering_change_id = $1
        AND (
          bom_id = $2
          OR $2 = ANY(regexp_split_to_array(COALESCE(bom_id, ''), '\\s*,\\s*'))
        )
        AND (
          $3 = ''
          OR location = $3
          OR $3 = ANY(regexp_split_to_array(COALESCE(location, ''), '\\s*,\\s*'))
        )
        AND (
          $4 = ''
          OR resource = $4
          OR $4 = ANY(regexp_split_to_array(COALESCE(resource, ''), '\\s*,\\s*'))
        )
        AND LOWER(change_type) LIKE 'modif%'
      ORDER BY change_date DESC NULLS LAST, rec_id DESC
      LIMIT 1
    `;

    const headerResult = await client.query(headerQuery, [
      engineeringChangeId,
      bomId,
      location,
      resource,
    ]);

    const headerRow = headerResult.rows[0] || null;

    // ---------------------------------------------------------
    // 2) Fetch LIVE current values (main tables only)
    // ---------------------------------------------------------
    let producedWhereClause = `bom_id = $1 AND location = $2`;
    let producedWhereValues = [bomId, location];

    if (producedItem) {
      producedWhereClause += ` AND item = $3`;
      producedWhereValues.push(producedItem);
    }

    const updatedProducedRow = await fetchSingleRow({
      tableName: "bom_produced",
      whereClause: producedWhereClause,
      values: producedWhereValues,
      orderBy: "load_datetime DESC NULLS LAST",
    });

    const updatedParametersRow = await fetchSingleRow({
      tableName: "bom_parameters",
      whereClause: `bom_id = $1`,
      values: [bomId],
      orderBy: "load_datetime DESC NULLS LAST",
    });

    // ---------------------------------------------------------
    // 3) Fetch ITEM_BOM_ROUTING original + updated
    // item_bom_routing has no resource column,
    // so filter using parsed resource from routing_id
    // ---------------------------------------------------------
    const routingOgResult = await client.query(
      `
      SELECT *
      FROM item_bom_routing_og
      WHERE bom_id = $1
      ORDER BY load_datetime DESC NULLS LAST
      `,
      [bomId]
    );

    const routingLiveResult = await client.query(
      `
      SELECT *
      FROM item_bom_routing
      WHERE bom_id = $1
      ORDER BY load_datetime DESC NULLS LAST
      `,
      [bomId]
    );

    const pickRoutingRow = (rows) => {
      let candidates = rows || [];

      if (producedItem) {
        const itemMatched = candidates.filter(
          (row) => safeText(row.item) === producedItem
        );
        if (itemMatched.length) {
          candidates = itemMatched;
        }
      }

      if (resource) {
        const resourceMatched = candidates.filter((row) => {
          const parsedResource = getResourceFromRoutingIdLocal(row.routing_id);
          return safeText(parsedResource) === resource;
        });

        if (resourceMatched.length) {
          return resourceMatched[0];
        }
      }

      return candidates[0] || null;
    };

    const originalRoutingRow = pickRoutingRow(routingOgResult.rows);
    const updatedRoutingRow = pickRoutingRow(routingLiveResult.rows);

    // ---------------------------------------------------------
    // 4) Fetch BOM_CONSUMED original + updated
    // compare only component information from OG vs LIVE
    // ---------------------------------------------------------
    let originalConsumedRow = null;
    let updatedConsumedRow = null;

    if (componentItem) {
      originalConsumedRow = await fetchSingleRow({
        tableName: "bom_consumed_og",
        whereClause: `bom_id = $1 AND location = $2 AND item = $3`,
        values: [bomId, location, componentItem],
        orderBy: "load_datetime DESC NULLS LAST",
      });

      updatedConsumedRow = await fetchSingleRow({
        tableName: "bom_consumed",
        whereClause: `bom_id = $1 AND location = $2 AND item = $3`,
        values: [bomId, location, componentItem],
        orderBy: "load_datetime DESC NULLS LAST",
      });
    } else {
      originalConsumedRow = await fetchSingleRow({
        tableName: "bom_consumed_og",
        whereClause: `bom_id = $1 AND location = $2`,
        values: [bomId, location],
        orderBy: "load_datetime DESC NULLS LAST",
      });

      updatedConsumedRow = await fetchSingleRow({
        tableName: "bom_consumed",
        whereClause: `bom_id = $1 AND location = $2`,
        values: [bomId, location],
        orderBy: "load_datetime DESC NULLS LAST",
      });
    }

    // ---------------------------------------------------------
    // 5) Build LIVE-only BOM record details
    // ---------------------------------------------------------
    const liveResource =
      getResourceFromRoutingIdLocal(updatedRoutingRow?.routing_id || "") ||
      resource;

    const bomRecordDetails = [
      buildDetailRow("Location", updatedProducedRow?.location || location),
      buildDetailRow("Produced Item", updatedProducedRow?.item || producedItem),
      buildDetailRow("BOM Status", updatedProducedRow?.bom_status || ""),
      buildDetailRow("Resource", liveResource),
      buildDetailRow("Routing ID", updatedRoutingRow?.routing_id || ""),
      buildDetailRow(
        "Item BOM Routing Priority",
        updatedRoutingRow?.erp_item_bom_routing_priority || ""
      ),
      buildDetailRow("BOM Version", updatedProducedRow?.bom_version || ""),
      buildDetailRow(
        "BOM ID",
        updatedProducedRow?.bom_id || updatedParametersRow?.bom_id || bomId
      ),
    ].filter((row) => safeText(row.value) !== "");

    // ---------------------------------------------------------
    // 6) Build component item changes (OG vs LIVE)
    // ---------------------------------------------------------
    const componentItemChanges = [
      buildChangeRow(
        "Component Item 1",
        originalConsumedRow?.item || componentItem || "",
        updatedConsumedRow?.item || componentItem || ""
      ),
      buildChangeRow(
        "Standard Usage 1",
        originalConsumedRow?.erp_bom_quantity_consumed_per || "",
        updatedConsumedRow?.erp_bom_quantity_consumed_per || ""
      ),
      buildChangeRow(
        "Component Start Date 1",
        originalConsumedRow?.erp_bom_component_start_date || "",
        updatedConsumedRow?.erp_bom_component_start_date || ""
      ),
      buildChangeRow(
        "Component End Date 1",
        originalConsumedRow?.erp_bom_component_end_date || "",
        updatedConsumedRow?.erp_bom_component_end_date || ""
      ),
    ].filter(
      (row) =>
        safeText(row.originalValue) !== "" || safeText(row.updatedValue) !== ""
    );

    // ---------------------------------------------------------
    // 7) Build co-product / routing changes (OG vs LIVE)
    // ---------------------------------------------------------
    const originalResource =
      getResourceFromRoutingIdLocal(originalRoutingRow?.routing_id || "") ||
      resource;

    const updatedResource =
      getResourceFromRoutingIdLocal(updatedRoutingRow?.routing_id || "") ||
      resource;

    const coProductChanges = [
      buildChangeRow(
        "Resource",
        originalResource,
        updatedResource
      ),
      buildChangeRow(
        "Routing ID",
        originalRoutingRow?.routing_id || "",
        updatedRoutingRow?.routing_id || ""
      ),
      buildChangeRow(
        "Item BOM Routing Priority",
        originalRoutingRow?.erp_item_bom_routing_priority || "",
        updatedRoutingRow?.erp_item_bom_routing_priority || ""
      ),
      buildChangeRow(
        "Co-Product Association",
        originalRoutingRow?.erp_co_product_association || "",
        updatedRoutingRow?.erp_co_product_association || ""
      ),
    ].filter(
      (row) =>
        safeText(row.originalValue) !== "" || safeText(row.updatedValue) !== ""
    );

    return res.status(200).json({
      success: true,
      data: {
        header: {
          engineeringChangeId,
          changeDate: headerRow?.change_date || "",
          userName: headerRow?.user_name || "",
          changeType: headerRow?.change_type || "Modified",
          bomId,
          location,
          resource,
          summaryNotes: headerRow?.summarynotes || "",
        },
        bomRecordDetails,
        componentItemChanges,
        coProductChanges,
      },
    });
  } catch (error) {
    console.error("DB Error (engineering-changes-detail-modify):", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch engineering modify detail",
      details: error.message,
    });
  } finally {
    client.release();
  }
});

/* =========================================================
   ViEW BOM from main tables in postgresql
========================================================= */
router.post("/view-bom-data/search", async (req, res) => {
  try {
    const criterion1 = String(req.body?.criterion1?.field || "").trim();
    const criterion2 = String(req.body?.criterion2?.field || "").trim();

    const selectedFields = [criterion1, criterion2].filter(Boolean);

    // Fetch only when BOTH dropdowns are selected
    if (!criterion1 || !criterion2) {
      return res.status(200).json({
        success: true,
        data: {
          bomParameters: [],
          bomProduced: [],
          bomConsumed: [],
          itemBomRouting: [],
        },
      });
    }

    // Invalid combinations
    if (
      selectedFields.includes("resource") &&
      selectedFields.includes("componentItem")
    ) {
      return res.status(400).json({
        error: "Users cannot select Resource and Component Item at the same time.",
      });
    }

    if (
      selectedFields.includes("componentItem") &&
      selectedFields.includes("coProductItem")
    ) {
      return res.status(400).json({
        error: "Users cannot select Component Item and Co-Product Item at the same time.",
      });
    }

    // Decide which tables to fetch
    let tablesToShow = [
      "bom_parameters",
      "bom_produced",
      "bom_consumed",
      "item_bom_routing",
    ];

    if (selectedFields.includes("resource")) {
      tablesToShow = ["item_bom_routing"];
    } else if (selectedFields.includes("componentItem")) {
      tablesToShow = ["bom_consumed"];
    } else if (selectedFields.includes("coProductItem")) {
      tablesToShow = ["bom_produced", "item_bom_routing"];
    }

    const deriveResourceFromRoutingId = (routingId) => {
      const value = String(routingId || "").trim();
      if (!value) return "";

      const parts = value.split("_").map((p) => p.trim()).filter(Boolean);

      // ROUTING_item_location_resource...
      if (parts.length >= 4 && parts[0].toUpperCase() === "ROUTING") {
        return parts.slice(3).join("_");
      }

      // item_location_resource...
      if (parts.length >= 3) {
        return parts.slice(2).join("_");
      }

      return "";
    };

    const [
      bomParametersResult,
      bomProducedResult,
      bomConsumedResult,
      itemBomRoutingResult,
    ] = await Promise.all([
      tablesToShow.includes("bom_parameters")
        ? pool.query(`
            SELECT
              bom_id,
              erp_bom_start_date,
              erp_bom_end_date,
              load_datetime
            FROM bom_parameters
            ORDER BY bom_id
          `)
        : Promise.resolve({ rows: [] }),

      tablesToShow.includes("bom_produced")
        ? pool.query(`
            SELECT
              bom_id,
              item,
              location,
              bom_status,
              bom_version,
              prefix,
              bom_plan_type,
              erp_bom_qty_produced_per,
              load_datetime
            FROM bom_produced
            ORDER BY bom_id, item, location
          `)
        : Promise.resolve({ rows: [] }),

      // Updated to ERP-prefixed PostgreSQL columns
      tablesToShow.includes("bom_consumed")
        ? pool.query(`
            SELECT
              item,
              location,
              bom_id,
              erp_bom_quantity_consumed_per,
              erp_bom_component_start_date,
              erp_bom_component_end_date,
              load_datetime
            FROM bom_consumed
            ORDER BY bom_id, item, location
          `)
        : Promise.resolve({ rows: [] }),

      // Updated to ERP-prefixed PostgreSQL columns
     tablesToShow.includes("item_bom_routing")
  ? pool.query(`
      SELECT
        item,
        routing_id,
        bom_id,
        erp_item_bom_routing_priority,
        erp_item_bom_routing_min_lot_size,
        erp_item_bom_routing_lot_size_increment,
        erp_item_bom_wip_sweep_priority,
        erp_co_product_association,
        erp_item_bom_routing_max_lot_size,
        load_datetime
      FROM item_bom_routing
      ORDER BY bom_id, routing_id
    `)
  : Promise.resolve({ rows: [] }),
    ]);

    let itemBomRoutingRows = (itemBomRoutingResult.rows || []).map((row) => ({
      ...row,
      resource: deriveResourceFromRoutingId(row.routing_id),
    }));

    // If Co-Product Item selected, only keep association = 1
    if (selectedFields.includes("coProductItem")) {
      itemBomRoutingRows = itemBomRoutingRows.filter(
        (row) => Number(row.erp_co_product_association) === 1
      );
    }

    return res.status(200).json({
      success: true,
      data: {
        bomParameters: bomParametersResult.rows || [],
        bomProduced: bomProducedResult.rows || [],
        bomConsumed: bomConsumedResult.rows || [],
        itemBomRouting: itemBomRoutingRows,
      },
    });
  } catch (error) {
    console.error("DB Error (view-bom-data/search):", error);
    return res.status(500).json({
      error: "Failed to fetch BOM data",
      details: error.message,
    });
  }
});

router.post("/download-bom-excel", async (req, res) => {
  try {
    const tables = Array.isArray(req.body?.tables) ? req.body.tables : [];

    if (!tables.length) {
      return res.status(400).json({
        message: "At least one table must be selected",
      });
    }

    const allowedTables = {
      bom_parameters: "BOM Parameters",
      bom_produced: "BOM Produced",
      bom_consumed: "BOM Consumed",
      item_bom_routing: "Item BOM Routing",
    };

    const invalidTables = tables.filter((table) => !allowedTables[table]);
    if (invalidTables.length) {
      return res.status(400).json({
        message: `Invalid table(s): ${invalidTables.join(", ")}`,
      });
    }

    const workbook = XLSX.utils.book_new();

    for (const table of tables) {
      const result = await pool.query(`SELECT * FROM ${table}`);
      const rows = result.rows || [];

      const sheetData =
        rows.length > 0
          ? rows
          : [{ Message: "No data available in this table" }];

      const worksheet = XLSX.utils.json_to_sheet(sheetData);

      // Auto-fit columns
      const keys = Object.keys(sheetData[0] || {});
      worksheet["!cols"] = keys.map((key) => {
        const maxLength = Math.max(
          key.length,
          ...sheetData.map((row) => String(row[key] ?? "").length)
        );
        return { wch: Math.min(Math.max(maxLength + 2, 14), 40) };
      });

      XLSX.utils.book_append_sheet(
        workbook,
        worksheet,
        allowedTables[table].slice(0, 31) // Excel sheet name limit
      );
    }

    const buffer = XLSX.write(workbook, {
      type: "buffer",
      bookType: "xlsx",
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="bom_tables.xlsx"'
    );

    return res.send(buffer);
  } catch (error) {
    console.error("DB Error (download-bom-excel):", error);
    return res.status(500).json({
      message: "Failed to generate Excel download",
      error: error.message,
    });
  }
});



/* =========================================================
   5) Generic GET ALL RECORDS FROM TABLE
========================================================= */
router.get("/:tableName", async (req, res) => {
  const { tableName } = req.params;

  try {
    const allowedTables = [
      "bom_produced",
      "bom_consumed",
      "item_bom_routing",
      "item_master",
      "location_master",
      "item_releaseflag",
    
      // OG tables
      "bom_parameters_og",
      "bom_produced_og",
      "bom_consumed_og",
      "item_bom_routing_og",

    ];

    if (!allowedTables.includes(tableName)) {
      return res.status(400).json({ message: "Invalid table name" });
    }

    const result = await pool.query(`SELECT * FROM ${tableName} LIMIT 100`);
    return res.json(result.rows);
  } catch (error) {
    console.error("DB Error:", error);
    return res.status(500).json({
      message: "Failed to fetch data",
      error: error.message,
    });
  }
});

/* =========================================================
   6) Generic GET SINGLE RECORD BY ID
========================================================= */
const allowedTables = [
  "item_bom_routing",
  "bom_produced",
  "bom_consumed",
  "item_master",
  "location_master",
  "item_releaseflag",

  // OG tables
  "bom_parameters_og",
  "bom_produced_og",
  "bom_consumed_og",
  "item_bom_routing_og",

];

router.get("/:tableName/:id", async (req, res) => {
  const { tableName, id } = req.params;

  try {
    if (!allowedTables.includes(tableName)) {
      return res.status(400).json({ message: "Invalid table name" });
    }

    const result = await pool.query(
      `SELECT * FROM ${tableName} WHERE bom_id = $1`,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ message: "Record not found" });
    }

    return res.json(result.rows);
  } catch (err) {
    console.error("ERROR:", err);
    return res.status(500).json({
      message: "Failed to fetch record",
      error: err.message,
    });
  }
});

export default router;