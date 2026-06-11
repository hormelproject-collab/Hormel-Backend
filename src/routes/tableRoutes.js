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
  row?.rec_id ?? row?.record_id ?? row?.recordid ?? null;

const getArchiveRecId = (row) =>
  row?.rec_id ?? row?.record_id ?? row?.recordid ?? null;

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
  const row = { ...baseRow };

  if (archiveColumns.includes("engineering_change_id")) {
    row.engineering_change_id = engineeringChangeId;
  }
  if (archiveColumns.includes("engineeringchangeid")) {
    row.engineeringchangeid = engineeringChangeId;
  }
  if (archiveColumns.includes("change_type")) {
    row.change_type = "deleteBOM";
  }
  if (archiveColumns.includes("changetype")) {
    row.changetype = "deleteBOM";
  }
  if (archiveColumns.includes("notes")) {
    row.notes = notes || "";
  }
  if (archiveColumns.includes("source_table")) {
    row.source_table = sourceTable;
  }
  if (archiveColumns.includes("source_rec_id")) {
    row.source_rec_id =
      baseRow.rec_id ?? baseRow.record_id ?? baseRow.recordid ?? null;
  }
  if (archiveColumns.includes("original_rec_id")) {
    row.original_rec_id =
      baseRow.rec_id ?? baseRow.record_id ?? baseRow.recordid ?? null;
  }
  if (archiveColumns.includes("archived_at")) {
    row.archived_at = new Date();
  }
  if (archiveColumns.includes("archived_on")) {
    row.archived_on = new Date();
  }
  if (archiveColumns.includes("deleted_at")) {
    row.deleted_at = new Date();
  }
  if (archiveColumns.includes("deleted_on")) {
    row.deleted_on = new Date();
  }

  return row;
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
      SELECT DISTINCT
        TRIM(CAST(ibr.routing_id AS TEXT)) AS routing_id
      FROM item_bom_routing ibr
      WHERE ibr.routing_id IS NOT NULL
        AND TRIM(CAST(ibr.routing_id AS TEXT)) <> ''
      ORDER BY TRIM(CAST(ibr.routing_id AS TEXT))
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

    const resourcesByBaseKey = new Map();

    for (const row of routingResult.rows) {
      const routingId = normalizeText(row.routing_id);
      if (!routingId) continue;

      const { baseKey, resource } = getBaseKeyAndResourceFromRoutingId(
        routingId
      );

      if (!baseKey || !resource) continue;

      if (!resourcesByBaseKey.has(baseKey)) {
        resourcesByBaseKey.set(baseKey, []);
      }

      const existing = resourcesByBaseKey.get(baseKey);
      if (!existing.includes(resource)) {
        existing.push(resource);
      }
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

      const baseKey = getBaseKeyFromBomId(bomId);
      const resources = resourcesByBaseKey.get(baseKey) ?? [];

      if (resources.length === 0) {
        mergedRows.push({
          id: `${bomId}__NORESOURCE`,
          location,
          produced_item: producedItem,
          produced_item_desc: producedItemDesc,
          bom_id: bomId,
          resource: "",
          item_release_flag: itemReleaseFlag,
        });
        continue;
      }

      for (const resource of resources) {
        mergedRows.push({
          id: `${bomId}__${resource}`,
          location,
          produced_item: producedItem,
          produced_item_desc: producedItemDesc,
          bom_id: bomId,
          resource,
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
      changeType = "Add",
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
    const changeLogId = generateUniqueId("U-");
    const now = new Date();

    const itemBomRoutingColumns = await getExistingColumns(
      client,
      "item_bom_routing"
    );

    const changeLogColumns = await getExistingColumns(
      client,
      "planning_bom_change_log_summary"
    );

    const chicagoNow = new Date(
      new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })
    );

    const itemBomRoutingData = {
      routing_id: routingId,
      bom_id: bomId,
      item: producedItem,
      produced_item: producedItem,
      location,
      resource,
      resource_relevancy: resourceRelevancy,
      resource_planning_relevance: resourceRelevancy,
      item_release_flag: itemReleaseFlag,
      connected_coproduct_item: addConnectedCoProduct ? coProductItem : "",
      co_product_item: addConnectedCoProduct ? coProductItem : "",
      item_bom_routing_priority:
        routingPriority === "" || routingPriority == null
          ? null
          : Number(routingPriority),
      co_product_association: addConnectedCoProduct ? 1 : 0,
      notes,
      engineering_change_id: engineeringChangeId,
      trxn_set_id: trxnSetId,
      trxn_creation_date: chicagoNow,
      trxn_by_user_name: changedByUserName,
      changed_by_user_id: changedByUserId,
      change_type: changeType,
      load_datetime: chicagoNow,
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

    let postgresqlRecId =
      insertedRow.rec_id ??
      insertedRow.postgresql_rec_id ??
      insertedRow.id ??
      null;

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

        if (itemBomRoutingColumns.includes("location")) {
          lookupConditions.push(`location = $${idx++}`);
          lookupValues.push(location);
        }

        if (lookupConditions.length > 0) {
          const idSelectColumn = itemBomRoutingColumns.includes("rec_id")
            ? "rec_id"
            : itemBomRoutingColumns.includes("postgresql_rec_id")
              ? "postgresql_rec_id"
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
        console.error("Lookup warning (item_bom_routing rec_id):", lookupError);
      }
    }

    const changeLogRecId = generateUniqueBigInt();

    if (postgresqlRecId === null || postgresqlRecId === undefined) {
      postgresqlRecId = changeLogRecId;
    }

    const changeLogData = {
      rec_id: changeLogRecId,
      engineering_change_id: engineeringChangeId,
      postgresql_rec_id: postgresqlRecId,
      change_type: changeType,
      target_table: "item_bom_routing",
      bom_id: bomId,
      produced_item: producedItem,
      location,
      change_date: now.toISOString().slice(0, 10),
      user_name: changedByUserName,
    };

    // store resource
    if (changeLogColumns.includes("resource")) {
      changeLogData.resource = resource;
    }
    if (changeLogColumns.includes("resources")) {
      changeLogData.resources = resource;
    }

    // store summary notes from ReviewSummary.jsx textarea
    if (changeLogColumns.includes("summarynotes")) {
      changeLogData.summarynotes = notes || "";
    }

    // optional backward compatibility
    if (changeLogColumns.includes("notes")) {
      changeLogData.notes = notes || "";
    }

    // optional better UI summary text
    if (changeLogColumns.includes("change_summary")) {
      changeLogData.change_summary = notes || "item_bom_routing";
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
        changeLogId,
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

    // Build resource lookup from LIVE item_bom_routing before deletes
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

        const sourceRecId =
          row.rec_id ??
          row.record_id ??
          row.recordid ??
          null;

        const archivedRecId =
          insertedRow.rec_id ??
          insertedRow.record_id ??
          insertedRow.recordid ??
          null;

        const safeChangeLogRecId =
          sourceRecId ??
          archivedRecId ??
          generateUniqueBigInt();

        const safeArchivedRecId =
          archivedRecId ??
          generateUniqueBigInt();

        ogRecIds[archiveTable].push(String(safeArchivedRecId));

        const producedItem =
          row.produced_item ??
          row.item ??
          getProducedItemFromBomId(row.bom_id);

        const location =
          row.location ??
          getLocationFromBomId(row.bom_id);

        // FIXED RESOURCE LOGIC
        const resource =
          toText(row.resource) ||
          getResourceFromRoutingId(row.routing_id) ||
          getResourceForBomAndLocation(
            row.bom_id,
            row.location || getLocationFromBomId(row.bom_id)
          );

        const changeLogRow = {};

        if (changeLogColumns.includes("rec_id")) {
          changeLogRow.rec_id = safeChangeLogRecId;
        }
        if (changeLogColumns.includes("record_id")) {
          changeLogRow.record_id = safeChangeLogRecId;
        }

        if (changeLogColumns.includes("engineering_change_id")) {
          changeLogRow.engineering_change_id = engineeringChangeId;
        }
        if (changeLogColumns.includes("engineeringchangeid")) {
          changeLogRow.engineeringchangeid = engineeringChangeId;
        }

        if (changeLogColumns.includes("postgresql_rec_id")) {
          changeLogRow.postgresql_rec_id = safeArchivedRecId;
        }

        if (changeLogColumns.includes("change_type")) {
          changeLogRow.change_type = "Deleted";
        }
        if (changeLogColumns.includes("changetype")) {
          changeLogRow.changetype = "Deleted";
        }

        if (changeLogColumns.includes("target_table")) {
          changeLogRow.target_table = archiveTable;
        }

        if (changeLogColumns.includes("bom_id")) {
          changeLogRow.bom_id = row.bom_id ?? null;
        }
        if (changeLogColumns.includes("bom_ids")) {
          changeLogRow.bom_ids = row.bom_id ?? null;
        }

        if (changeLogColumns.includes("produced_item")) {
          changeLogRow.produced_item = producedItem || "";
        }
        if (changeLogColumns.includes("item")) {
          changeLogRow.item = row.item ?? producedItem ?? null;
        }

        if (changeLogColumns.includes("location")) {
          changeLogRow.location = location || "";
        }
        if (changeLogColumns.includes("locations")) {
          changeLogRow.locations = location || "";
        }

        if (changeLogColumns.includes("resource")) {
          changeLogRow.resource = resource || "";
        }
        if (changeLogColumns.includes("resources")) {
          changeLogRow.resources = resource || "";
        }

        if (changeLogColumns.includes("routing_id")) {
          changeLogRow.routing_id = row.routing_id ?? null;
        }

        if (changeLogColumns.includes("summarynotes")) {
          changeLogRow.summarynotes = notes || "";
        }
        if (changeLogColumns.includes("notes")) {
          changeLogRow.notes = notes || "";
        }
        if (changeLogColumns.includes("change_summary")) {
          changeLogRow.change_summary = notes || archiveTable;
        }

        if (changeLogColumns.includes("user_name")) {
          changeLogRow.user_name =
            String(user?.userId || "").trim() || "SYSTEM_USER";
        }
        if (changeLogColumns.includes("created_by")) {
          changeLogRow.created_by = String(user?.userId || "").trim() || "SYSTEM_USER";
        }
        if (changeLogColumns.includes("updated_by")) {
          changeLogRow.updated_by = String(user?.userId || "").trim() || "SYSTEM_USER";
        }

        if (changeLogColumns.includes("change_date")) {
          changeLogRow.change_date = now.toISOString().slice(0, 10);
        }
        if (changeLogColumns.includes("created_at")) {
          changeLogRow.created_at = now;
        }
        if (changeLogColumns.includes("created_on")) {
          changeLogRow.created_on = now;
        }
        if (changeLogColumns.includes("status")) {
          changeLogRow.status = "COMPLETED";
        }

        const {
          query: changeLogInsertQuery,
          values: changeLogInsertValues,
        } = buildDynamicInsertQuery(
          changeLogTable,
          changeLogRow,
          changeLogColumns
        );

        await client.query(changeLogInsertQuery, changeLogInsertValues);
      }

      const deletedCount = await deleteRowsByBomId(client, sourceTable, bomIds);
      movedCounts[sourceTable] = deletedCount;
    }

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
        const archiveRow = { ...row };

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

        if (archiveColumns.includes("source_table")) {
          archiveRow.source_table = "item_bom_routing";
        }

        if (archiveColumns.includes("source_rec_id")) {
          archiveRow.source_rec_id =
            row.rec_id ?? row.record_id ?? row.recordid ?? null;
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

        const ogRecId =
          insertedOgRow.rec_id ??
          insertedOgRow.record_id ??
          insertedOgRow.recordid ??
          null;

        if (ogRecId != null) {
          archivedRecIds.push(String(ogRecId));
        }

        // use actual deleted row values
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

        const safeChangeLogRecId =
          ogRecId ??
          generateUniqueBigInt();

        const changeLogRow = {};

        // rec_id in planning_bom_change_log_summary = _og record id created
        if (changeLogColumns.includes("rec_id")) {
          changeLogRow.rec_id = safeChangeLogRecId;
        }
        if (changeLogColumns.includes("record_id")) {
          changeLogRow.record_id = safeChangeLogRecId;
        }

        if (changeLogColumns.includes("engineering_change_id")) {
          changeLogRow.engineering_change_id = engineeringChangeId;
        }
        if (changeLogColumns.includes("engineeringchangeid")) {
          changeLogRow.engineeringchangeid = engineeringChangeId;
        }

        // also keep _og record id in postgresql_rec_id if column exists
        if (changeLogColumns.includes("postgresql_rec_id")) {
          changeLogRow.postgresql_rec_id = safeChangeLogRecId;
        }

        if (changeLogColumns.includes("change_type")) {
          changeLogRow.change_type = "Deleted";
        }
        if (changeLogColumns.includes("changetype")) {
          changeLogRow.changetype = "Deleted";
        }

        if (changeLogColumns.includes("target_table")) {
          changeLogRow.target_table = archiveTable;
        }

        if (changeLogColumns.includes("bom_id")) {
          changeLogRow.bom_id = row.bom_id ?? null;
        }
        if (changeLogColumns.includes("routing_id")) {
          changeLogRow.routing_id = row.routing_id ?? null;
        }

        if (changeLogColumns.includes("produced_item")) {
          changeLogRow.produced_item = producedItem || "";
        }
        if (changeLogColumns.includes("item")) {
          changeLogRow.item = row.item ?? producedItem ?? null;
        }

        if (changeLogColumns.includes("location")) {
          changeLogRow.location = derivedLocation || "";
        }
        if (changeLogColumns.includes("locations")) {
          changeLogRow.locations = derivedLocation || "";
        }

        if (changeLogColumns.includes("resource")) {
          changeLogRow.resource = derivedResource || "";
        }
        if (changeLogColumns.includes("resources")) {
          changeLogRow.resources = derivedResource || "";
        }

        if (changeLogColumns.includes("summarynotes")) {
          changeLogRow.summarynotes = notes || "";
        }
        if (changeLogColumns.includes("notes")) {
          changeLogRow.notes = notes || "";
        }

        if (changeLogColumns.includes("change_summary")) {
          changeLogRow.change_summary = notes || archiveTable;
        }

        // username 
        if (changeLogColumns.includes("user_name")) {
          changeLogRow.user_name = String(user?.userId || "").trim() || "SYSTEM_USER";
        }
        if (changeLogColumns.includes("created_by")) {
          changeLogRow.created_by = String(user?.userId || "").trim() || "SYSTEM_USER";
        }
        if (changeLogColumns.includes("updated_by")) {
          changeLogRow.updated_by = String(user?.userId || "").trim() || "SYSTEM_USER";
        }

        const now = new Date();

        if (changeLogColumns.includes("change_date")) {
          changeLogRow.change_date = now.toISOString().slice(0, 10);
        }
        if (changeLogColumns.includes("created_at")) {
          changeLogRow.created_at = now;
        }
        if (changeLogColumns.includes("created_on")) {
          changeLogRow.created_on = now;
        }
        if (changeLogColumns.includes("status")) {
          changeLogRow.status = "COMPLETED";
        }

        const { query: changeLogInsertQuery, values: changeLogInsertValues } =
          buildDynamicInsertQuery(
            changeLogTable,
            changeLogRow,
            changeLogColumns
          );

        await client.query(changeLogInsertQuery, changeLogInsertValues);

        // delete live row only after archive + changelog insert
        await deleteItemBomRoutingByBomAndRouting(
          client,
          row.bom_id,
          row.routing_id
        );

        movedCount += 1;
      }
    }

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
    if (columns.includes("change_date")) {
      selectParts.push(`CAST(change_date AS TEXT) AS change_date`);
    } else if (columns.includes("created_at")) {
      selectParts.push(`CAST(created_at AS TEXT) AS change_date`);
    } else if (columns.includes("created_on")) {
      selectParts.push(`CAST(created_on AS TEXT) AS change_date`);
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
    if (columns.includes("summarynotes")) {
      selectParts.push(`CAST(summarynotes AS TEXT) AS change_summary`);
    } else if (columns.includes("change_summary")) {
      selectParts.push(`CAST(change_summary AS TEXT) AS change_summary`);
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

    const bomId = String(req.query.bomID || req.query.bomId || "").trim();
    const resource = String(req.query.resource || "").trim();

    let location = String(req.query.location || "").trim();
    let producedItem = String(req.query.producedItem || req.query.item || "").trim();

    // Derive item + location from BOM ID format: BOMID_ITEM_LOCATION
    // Example: BOM3_HRL00123_1007
    if (bomId) {
      const bomParts = bomId.split("_");

      if (!producedItem && bomParts.length >= 3) {
        producedItem = String(bomParts[1] || "").trim();
      }

      if (!location && bomParts.length >= 3) {
        location = String(bomParts[2] || "").trim();
      }
    }

    if (!engineeringChangeId || !bomId || !location) {
      return res.status(400).json({
        error:
          "engineeringChangeId/changeID and bomId/bomID are required. Location is derived from BOM ID if not passed.",
        details: {
          engineeringChangeId,
          bomId,
          derivedLocation: location || "",
        },
      });
    }

    // 1) Fetch from planning_bom_change_log_summary first
    const summaryQuery = `
  SELECT
    engineering_change_id,
    change_type,
    target_table,
    bom_id,
    produced_item,
    location,
    resource,
    summarynotes,
    change_date,
    user_name
  FROM planning_bom_change_log_summary
  WHERE engineering_change_id = $1
    AND bom_id = $2
    AND ($3 = '' OR location = $3)
    AND LOWER(change_type) LIKE 'add%'
  ORDER BY change_date DESC, engineering_change_id DESC
`;



    const summaryResult = await pool.query(summaryQuery, [
      engineeringChangeId,
      bomId,
      location,
    ]);



    const summaryRows = summaryResult.rows || [];

    if (!summaryRows.length) {
      return res.status(404).json({
        error: "No matching add-change rows found in planning_bom_change_log_summary",
        details: {
          engineeringChangeId,
          bomId,
          location,
        },
      });
    }

    const firstSummaryRow = summaryRows[0] || {};

    const resolvedLocation =
      location || String(firstSummaryRow.location || "").trim();

    const resolvedResource =
      resource || String(firstSummaryRow.resource || "").trim();


    // Prefer produced_item from summary log if available
    if (!producedItem) {
      producedItem = String(firstSummaryRow.produced_item || "").trim();
    }

    // fallback again from bomId if still empty
    if (!producedItem && bomId) {
      const bomParts = bomId.split("_");
      if (bomParts.length >= 3) {
        producedItem = String(bomParts[1] || "").trim();
      }
    }

    const changeDate = firstSummaryRow.change_date || "";
    const userName = firstSummaryRow.user_name || "";

    // Expected routing id only if resource is passed from log/frontend
    const expectedRoutingId =
      producedItem && resolvedLocation && resolvedResource
        ? `ROUTING_${producedItem}_${resolvedLocation}_${resolvedResource}`
        : "";

    // 2) Fetch from bom_produced

    const producedQuery = `
  SELECT *
  FROM bom_produced
  WHERE bom_id = $1
    AND location = $2
    AND ($3 = '' OR item = $3)
  ORDER BY load_datetime DESC NULLS LAST
  LIMIT 1
`;



    // 3) Fetch from bom_consumed

    const consumedQuery = `
  SELECT *
  FROM bom_consumed
  WHERE bom_id = $1
    AND location = $2
  ORDER BY load_datetime DESC NULLS LAST
`;



    // 4) Fetch from item_bom_routing
    // item_bom_routing has item, bom_id, routing_id
    // no location column, no resource column

    const routingQuery = `
  SELECT *
  FROM item_bom_routing
  WHERE bom_id = $1
    AND ($2 = '' OR item = $2)
    AND ($3 = '' OR routing_id = $3)
  ORDER BY load_datetime DESC NULLS LAST
  LIMIT 1
`;


    // 5) Fetch from bom_parameters
    // bom_parameters only has bom_id + date columns

    const parameterQuery = `
  SELECT *
  FROM bom_parameters
  WHERE bom_id = $1
  ORDER BY load_datetime DESC NULLS LAST
  LIMIT 1
`;



    const producedResult = await pool.query(producedQuery, [
      bomId,
      location,
      producedItem,
    ]);

    const consumedResult = await pool.query(consumedQuery, [
      bomId,
      location,
    ]);

    const routingResult = await pool.query(routingQuery, [
      bomId,
      producedItem,
      expectedRoutingId,
    ]);


    const parameterResult = await pool.query(parameterQuery, [bomId]);


    const bomProduced = producedResult.rows[0] || {};
    const bomConsumedRows = consumedResult.rows || [];
    const itemBomRouting = routingResult.rows[0] || {};
    const bomParameters = parameterResult.rows[0] || {};

    const resolvedItem =
      producedItem ||
      bomProduced.item ||
      itemBomRouting.item ||
      "";

    const resolvedRoutingId =
      itemBomRouting.routing_id ||
      expectedRoutingId ||
      "";

    return res.json({
      engineeringChangeId,
      changeDate,
      user: userName,
      changeType: "Added",

      item: resolvedItem,
      location: resolvedLocation,
      bomId,
      resource: resolvedResource,
      routingId: resolvedRoutingId,

      itemReleaseFlag: "",
      resourceRelevancy: "",
      summaryNotes: firstSummaryRow.summarynotes || "",

      summaryLogRows: summaryRows,
      bomProduced,
      bomConsumedRows,
      itemBomRouting,
      bomParameters,
    });

  } catch (error) {
    console.error("DB Error (engineering-changes-detail-add):", error);
    return res.status(500).json({
      error: "Failed to fetch engineering add detail",
      details: error.message,
    });
  }
});

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
        routing_id,
        summarynotes,
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

    return res.status(200).json({
      success: true,
      data: {
        engineeringChangeId: firstRow.engineering_change_id || engineeringChangeId,
        changeDate: firstRow.change_date || "",
        user: firstRow.user_name || String(user?.userId || "").trim() || "SYSTEM_USER",
        changeType: "Deleted",
        item: firstRow.produced_item || item || "",
        itemDescription: "",
        location: firstRow.location || location || "",
        bomId: firstRow.bom_id || bomId || "",
        resource: firstRow.resource || resource || "",
        summaryNotes: firstRow.summarynotes || "",
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

      // Use actual DB columns, alias to frontend-expected names
      tablesToShow.includes("bom_consumed")
        ? pool.query(`
            SELECT
              item,
              location,
              bom_id,
              bom_quantity_consumed_per AS erp_bom_quantity_consumed_per,
              bom_component_start_date AS erp_bom_component_start_date,
              bom_component_end_date AS erp_bom_component_end_date,
              load_datetime
            FROM bom_consumed
            ORDER BY bom_id, item, location
          `)
        : Promise.resolve({ rows: [] }),

      // Use actual DB columns, alias to frontend-expected names
      tablesToShow.includes("item_bom_routing")
        ? pool.query(`
            SELECT
              item,
              routing_id,
              bom_id,
              item_bom_routing_priority AS erp_item_bom_routing_priority,
              item_bom_routing_min_lot_size AS erp_item_bom_routing_min_lot_size,
              item_bom_routing_lot_size_increment AS erp_item_bom_routing_lot_size_increment,
              item_bom_routing_wip_sweep_priority AS erp_item_bom_wip_sweep_priority,
              co_product_association AS erp_co_product_association,
              item_bom_routing_max_lot_size AS erp_item_bom_routing_max_lot_size,
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
      `SELECT * FROM ${tableName} WHERE postgresql_rec_id = $1`,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ message: "Record not found" });
    }

    return res.json(result.rows[0]);
  } catch (err) {
    console.error("ERROR:", err);
    return res.status(500).json({
      message: "Failed to fetch record",
      error: err.message,
    });
  }
});

export default router;