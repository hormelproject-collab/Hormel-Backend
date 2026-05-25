import express from "express";
const router = express.Router();

import { Pool } from "pg";

const pool = new Pool({
  host: "localhost",
  port: 5432,
  user: "postgres",
  password: "YOUR_PASSWORD",
  database: "YOUR_DB_NAME",
});

// ✅ Your API
router.post("/download-csv", async (req, res) => {
  res.send("CSV API working");
});

export default router; // ✅ THIS IS REQUIRED