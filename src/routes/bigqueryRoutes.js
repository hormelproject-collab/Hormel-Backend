import express from "express";
import { fetchFromTable } from "../services/bigqueryService.js";

const router = express.Router();

const bigqueryRoutes = router.get("/:table", async (req, res) => {
  try {
    const tableName = req.params.table;

    // ✅ Extract filters from query params
    const { limit = 10, ...filters } = req.query;

    const data = await fetchFromTable(tableName, filters, limit);

    res.json(data);

  } catch (error) {
    res.status(400).json({
      error: error.message || "Something went wrong"
    });
  }
});

export default bigqueryRoutes;