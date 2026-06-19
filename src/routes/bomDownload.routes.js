import express from "express";
const router = express.Router();

import pool from "../db/postgresClient.js";

// ✅ Your API
router.post("/download-csv", async (req, res) => {
  res.send("CSV API working");
});

export default router; // ✅ THIS IS REQUIRED