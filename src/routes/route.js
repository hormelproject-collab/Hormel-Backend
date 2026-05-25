import express from "express";
import bigquery from "../bigquery/bigquery.js";

const router = express.Router();

router.get("/data", async (req, res) => {
  try {
    const query = `
      SELECT *
      FROM \`${process.env.GCP_PROJECT_ID}.${process.env.BQ_DATASET}.${process.env.BQ_TABLE}\`
      LIMIT 50
    `;

    const [rows] = await bigquery.query({
      query
    });

    res.status(200).json({
      success: true,
      count: rows.length,
      data: rows
    });
  } catch (error) {
    console.error("BigQuery error:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

export default router;