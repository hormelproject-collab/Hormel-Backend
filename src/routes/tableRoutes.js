import express from "express";
import pool from "../db/postgresClient.js";

const router = express.Router();

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
   Body:
   {
     "itemIds": ["1001", "1002"]
   }
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
   3) Generic GET ALL RECORDS FROM TABLE
   selecting existing BOM
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
   4) Generic GET SINGLE RECORD BY ID
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