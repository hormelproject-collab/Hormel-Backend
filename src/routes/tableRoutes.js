import express from "express";
// import { pool } from "../db.js"
import pool from "../postgres/postgres.js";


const router = express.Router();

// ✅ GET ALL RECORDS FROM TABLE
// selecting existing BOM
router.get("/:tableName", async (req, res) => {
  const { tableName } = req.params;

  try {
    // ✅ VERY IMPORTANT: whitelist tables (security)
    const allowedTables = [
      "bom_produced",
      "item_bom_routing",
      "item_master",
      "location_master"
    ];

    if (!allowedTables.includes(tableName)) {
      return res.status(400).json({ message: "Invalid table name" });
    }

    const result = await pool.query(`SELECT * FROM ${tableName} LIMIT 100`);

    res.json(result.rows);

  } catch (error) {
    console.error("DB Error:", error);
    res.status(500).json({
      message: "Failed to fetch data",
      error: error.message
    });
  }
});


// router.get("/:tableName/search", async (req, res) => {
//   const { tableName } = req.params;
//   const { column, value } = req.query;

//   try {
//     const allowedTables = ["bom_produced", "item_bom_routing"];

//     const allowedColumns = [
//       "item",
//       "location",
//       "bom_id",
//       "resource"
//     ];

//     if (!allowedTables.includes(tableName)) {
//       return res.status(400).json({ message: "Invalid table" });
//     }

//     if (!allowedColumns.includes(column)) {
//       return res.status(400).json({ message: "Invalid column" });
//     }

//     const query = `
//       SELECT * FROM ${tableName}
//       WHERE ${column} ILIKE $1
//       LIMIT 50
//     `;

//     const result = await pool.query(query, [`%${value}%`]);

//     res.json(result.rows);

//   } catch (error) {
//     res.status(500).json({
//       message: "Search failed",
//       error: error.message,
//     });
//   }
// });

// modifing existing BOM
// ✅ Get single record dynamically

const allowedTables = [
  "item_bom_routing",
  "bom_produced",
  "item_master"
];

router.get("/:tableName/:id", async (req, res) => {
  const { tableName, id } = req.params;

  try {
    // ✅ prevent SQL injection
    if (!allowedTables.includes(tableName)) {
      return res.status(400).json({ message: "Invalid table name" });
    }

    // ✅ IMPORTANT: use correct id column
    const result = await pool.query(
      `SELECT * FROM ${tableName} WHERE postgresql_rec_id = $1`,
      [id]
    );

    if (!result.rows.length) {
      return res.status(404).json({ message: "Record not found" });
    }

    res.json(result.rows[0]);

  } catch (err) {
    console.error("ERROR:", err);
    res.status(500).json({
      message: "Failed to fetch record",
      error: err.message
    });
  }
});


export default router;