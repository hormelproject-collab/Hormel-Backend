import express from "express";
import {
  fetchFromTable,
  fetchItemMasterWithReleaseFlag,
  fetchLocationsBySelectedItems,
  fetchResourceComponentMetadata,
} from "../services/bigqueryService.js";

const router = express.Router();

/* =========================================================
   Allowed dynamic GCP tables for frontend
========================================================= */
const ALLOWED_BIGQUERY_TABLES = [
  "item_master",
  "item_releaseflag",
  "bom_produced",
  "bom_consumed",
  "item_bom_routing",
  "location_master",
  "resource_master",
  "routing_rescons",
  "resource_rescons",
];

const normalizeLimit = (limit) => {
  if (limit === undefined || limit === null || limit === "") return null;

  const text = String(limit).trim().toLowerCase();

  if (text === "all") return null;

  const parsed = Number(text);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;

  return Math.floor(parsed);
};

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
   4) NEW API: Existing BOM search rows for Step 1
   Returns flattened joined rows from GCP:
   - location from bom_produced
   - produced item from bom_produced (base produced item only)
   - produced item desc from item_master
   - bom_id from bom_produced
   - one row per resource via item_bom_routing + routing_rescons
   - item release flag from item_releaseflag
========================================================= */
router.get("/existing-bom-search", async (req, res) => {
  try {
    const data = await fetchExistingBomSearchRows();

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Error fetching existing BOM search rows:", error);
    return res.status(500).json({
      error: "Failed to fetch existing BOM search rows",
      details: error.message,
    });
  }
});

/* =========================================================
   Keep existing generic route
========================================================= */
/* =========================================================
   Generic dynamic GCP table route for frontend
   Supports:
   - /api/bigquery/table/:table
   - optional filters via query params
   - ?limit=all  => no limit
   - ?limit=100  => LIMIT 100
========================================================= */
router.get("/:table", async (req, res) => {
  try {
    const tableName = String(req.params.table || "").trim();

    if (!ALLOWED_BIGQUERY_TABLES.includes(tableName)) {
      return res.status(400).json({
        error: "Invalid table name",
      });
    }

    const { limit, ...filters } = req.query || {};

    const normalizedFilters = Object.fromEntries(
      Object.entries(filters).filter(
        ([, value]) => value !== undefined && value !== null && String(value).trim() !== ""
      )
    );

    const data = await fetchFromTable(
      tableName,
      normalizedFilters,
      normalizeLimit(limit)
    );

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error(`Error fetching BigQuery table ${req.params.table}:`, error);
    return res.status(500).json({
      error: error.message || "Something went wrong",
    });
  }
});

export default router;