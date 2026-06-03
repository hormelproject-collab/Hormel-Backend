import express from "express";
import pool from "../db/postgresClient.js";
import { BigQuery } from "@google-cloud/bigquery";

const router = express.Router();

const bigquery = new BigQuery({
  projectId: process.env.BQ_PROJECT_ID,
});

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

/**
 * Example:
 *   bom_id     = PRIMARY_Item000_Location 1
 *   routing_id = PRIMARY_Item000_Resource1
 *
 * Shared base key should be:
 *   PRIMARY_Item000
 */
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
   GET /api/tables/items-with-releaseflag
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
   POST /api/tables/locations-by-items
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
   3) NEW API: Existing BOM search rows for Step 1
   GET /api/tables/existing-bom-search
========================================================= */
router.get("/existing-bom-search", async (req, res) => {
  try {
    /* ---------------------------------------------
       STEP A: PostgreSQL -> Base produced rows
       Pick one base produced item per BOM ID
       Prefer erp_bom_qty_produced_per = 1 to avoid co-products
    --------------------------------------------- */
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

    /* ---------------------------------------------
       STEP B: PostgreSQL -> routing_id rows
       Resource comes from routing_id
       Format: Routing_Item_Resource
    --------------------------------------------- */
    const routingResult = await pool.query(`
      SELECT DISTINCT
        TRIM(CAST(ibr.routing_id AS TEXT)) AS routing_id
      FROM item_bom_routing ibr
      WHERE ibr.routing_id IS NOT NULL
        AND TRIM(CAST(ibr.routing_id AS TEXT)) <> ''
      ORDER BY TRIM(CAST(ibr.routing_id AS TEXT))
    `);

    /* ---------------------------------------------
       STEP C: BigQuery -> item_master + item_releaseflag
    --------------------------------------------- */
    const { projectId, dataset } = getBigQueryConfig();

    const itemMasterRows = await runBigQuery(`
      SELECT *
      FROM \`${projectId}.${dataset}.item_master\`
    `);

    const releaseFlagRows = await runBigQuery(`
      SELECT *
      FROM \`${projectId}.${dataset}.item_releaseflag\`
    `);

    /* ---------------------------------------------
       STEP D: Build lookup maps
    --------------------------------------------- */
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

    /* ---------------------------------------------
       STEP E: Group resources by derived base key
       Example:
         routing_id = PRIMARY_Item000_Resource1
         baseKey    = PRIMARY_Item000
         resource   = Resource1
    --------------------------------------------- */
    const resourcesByBaseKey = new Map();

    for (const row of routingResult.rows) {
      const routingId = normalizeText(row.routing_id);
      if (!routingId) continue;

      const { baseKey, resource } = getBaseKeyAndResourceFromRoutingId(routingId);

      if (!baseKey || !resource) continue;

      if (!resourcesByBaseKey.has(baseKey)) {
        resourcesByBaseKey.set(baseKey, []);
      }

      const existing = resourcesByBaseKey.get(baseKey);
      if (!existing.includes(resource)) {
        existing.push(resource);
      }
    }

    /* ---------------------------------------------
       STEP F: Merge rows
       Match bom_produced.bom_id to routing_id using derived base key
    --------------------------------------------- */
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
   4) Generic GET ALL RECORDS FROM TABLE
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
   5) Generic GET SINGLE RECORD BY ID
========================================================= */
const allowedTables = [
  "item_bom_routing",
  "bom_produced",
  "item_master",
  "location_master",
  "item_releaseflag",
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