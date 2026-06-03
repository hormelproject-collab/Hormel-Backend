import express from "express";
import {
  fetchFromTable,
  fetchItemMasterWithReleaseFlag,
  fetchLocationsBySelectedItems,
} from "../services/bigqueryService.js";

const router = express.Router();

/* =========================================================
   1) Dedicated API: item_master + item_releaseflag
========================================================= */
router.get("/item-master-with-releaseflag", async (req, res) => {
  try {
    const { limit, ...filters } = req.query;

    const data = await fetchItemMasterWithReleaseFlag(
      filters,
      limit === undefined ? null : limit
    );

    return res.status(200).json(data);
  } catch (error) {
    console.error("Error fetching item master with release flag:", error);
    return res.status(500).json({
      error: "Failed to fetch item master with release flag",
      details: error.message,
    });
  }
});

/* =========================================================
   2) Dedicated API: selected item(s) -> bom_produced -> location_master
========================================================= */
router.post("/locations-by-items", async (req, res) => {
  try {
    const { itemIds } = req.body;

    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return res.status(400).json({
        error: "itemIds must be a non-empty array",
      });
    }

    const data = await fetchLocationsBySelectedItems(itemIds);

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Error fetching locations by selected items:", error);
    return res.status(500).json({
      error: "Failed to fetch locations by selected items",
      details: error.message,
    });
  }
});

/* backward-compatible alias if old frontend still uses /by-items */
router.post("/by-items", async (req, res) => {
  try {
    const { itemIds } = req.body;

    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return res.status(400).json({
        error: "itemIds must be a non-empty array",
      });
    }

    const data = await fetchLocationsBySelectedItems(itemIds);

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Error fetching locations by items:", error);
    return res.status(500).json({
      error: "Failed to fetch locations",
      details: error.message,
    });
  }
});

/* keep generic route */
router.get("/:table", async (req, res) => {
  try {
    const tableName = req.params.table;
    const { limit, ...filters } = req.query;

    const data = await fetchFromTable(
      tableName,
      filters,
      limit === undefined ? null : limit
    );

    return res.status(200).json(data);
  } catch (error) {
    return res.status(400).json({
      error: error.message || "Something went wrong",
    });
  }
});

export default router;