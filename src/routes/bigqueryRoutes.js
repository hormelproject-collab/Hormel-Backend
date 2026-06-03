import express from "express";
import {
  fetchFromTable,
  fetchItemMasterWithReleaseFlag,
  fetchLocationsBySelectedItems,
  fetchResourceComponentMetadata,
} from "../services/bigqueryService.js";

const router = express.Router();

/* =========================================================
   1) Existing API: item_master + item_releaseflag
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
   2) Existing API: selected item(s) -> bom_produced -> location_master
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

/* =========================================================
   3) NEW API: Resource & Component Step metadata
   Does NOT alter any existing API
========================================================= */
router.post("/resource-component-metadata", async (req, res) => {
  try {
    const { items, locations } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        error: "items must be a non-empty array",
      });
    }

    if (!Array.isArray(locations) || locations.length === 0) {
      return res.status(400).json({
        error: "locations must be a non-empty array",
      });
    }

    const data = await fetchResourceComponentMetadata(items, locations);

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Error fetching resource component metadata:", error);
    return res.status(500).json({
      error: "Failed to fetch resource component metadata",
      details: error.message,
    });
  }
});

/* =========================================================
   Keep existing generic route
========================================================= */
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