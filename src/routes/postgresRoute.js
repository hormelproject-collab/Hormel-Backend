import express from "express";
import pool from "../postgres/postgres.js";

const router = express.Router();

// ✅ Test connection
router.get("/test", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({
      success: true,
      data: result.rows,
    });
  } catch (error) {
    console.error("Postgres error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ✅ Example: fetch BOM data
router.get("/bom-produced", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM bom_produced LIMIT 50");
    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows,
    });
  } catch (error) {
    console.error("Postgres error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;