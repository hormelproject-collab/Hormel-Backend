import express from "express";
import {
  fetchFromTable,
  fetchItemMasterWithReleaseFlag,
  fetchLocationsBySelectedItems,
  fetchResourceComponentMetadata,
  fetchExistingBomSearchRows,
  fetchBomIdsFromBomParameters,
  fetchBomDetailsByBomId,
  fetchAllResourcesFromRoutingResCons,
  fetchResourceRelevancyByResource,
  fetchCoProductsByItem,
  fetchItemReleaseFlagByItem,
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
  "bom_parameters",
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
 3) Existing API: Resource & Component Step metadata
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

router.get("/bom-routing-step1/item-releaseflag/:item", async (req, res) => {
  try {
    const item = String(req.params?.item || "").trim();

    if (!item) {
      return res.status(400).json({
        error: "Item is required",
      });
    }

    const data = await fetchItemReleaseFlagByItem(item);

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Error fetching item release flag:", error);
    return res.status(500).json({
      error: "Failed to fetch item release flag",
      details: error.message,
    });
  }
});

/* =========================================================
 4) Existing API: Existing BOM search rows for Step 1
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
 5) NEW API: Create Item BOM Routing Record - Step 1
========================================================= */

/**
 * Pull all BOM IDs from bom_parameters
 */
router.get("/bom-routing-step1/bom-ids", async (_req, res) => {
  try {
    const data = await fetchBomIdsFromBomParameters();
    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Error fetching BOM IDs:", error);
    return res.status(500).json({
      error: "Failed to fetch BOM IDs",
      details: error.message,
    });
  }
});

/**
 * Based on BOM ID selected:
 * - fetch produced item + location from bom_produced
 * - fetch release flag from item_releaseflag
 */
router.get("/bom-routing-step1/bom-details/:bomId", async (req, res) => {
  try {
    const bomId = String(req.params.bomId || "").trim();

    if (!bomId) {
      return res.status(400).json({
        error: "bomId is required",
      });
    }

    const data = await fetchBomDetailsByBomId(bomId);

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Error fetching BOM details:", error);
    return res.status(500).json({
      error: "Failed to fetch BOM details",
      details: error.message,
    });
  }
});

/**
 * Pull all resources from routing_rescons
 */
router.get("/bom-routing-step1/resources", async (_req, res) => {
  try {
    const data = await fetchAllResourcesFromRoutingResCons();

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Error fetching resources:", error);
    return res.status(500).json({
      error: "Failed to fetch resources",
      details: error.message,
    });
  }
});

/**
 * Based on resource selected:
 * fetch resource_planning_relevance from resource_master
 */
router.get("/bom-routing-step1/resource-relevancy/:resource", async (req, res) => {
  try {
    const resource = String(req.params.resource || "").trim();

    if (!resource) {
      return res.status(400).json({
        error: "resource is required",
      });
    }

    const data = await fetchResourceRelevancyByResource(resource);
 console.error("resource relevancy:", data);
    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Error fetching resource relevancy:", error);
    return res.status(500).json({
      error: "Failed to fetch resource relevancy",
      details: error.message,
    });
  }
});


/**
 * Co-product list from item_master for selected item
 */
router.get("/bom-routing-step1/co-products/:item", async (req, res) => {
  try {
    const item = String(req.params.item || "").trim();

    if (!item) {
      return res.status(400).json({
        error: "item is required",
      });
    }

    const data = await fetchCoProductsByItem(item);

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Error fetching co-products:", error);
    return res.status(500).json({
      error: "Failed to fetch co-products",
      details: error.message,
    });
  }
});

router.get("/bom-routing-step1/co-products/:bomId", async (req, res) => {
  try {
    const bomId = String(req.params.bomId || "").trim();
    if (!bomId) {
      return res.status(400).json({
        error: "bomId is required",
      });
    }

    const data = await fetchCoProductsByBomId(bomId);

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Error fetching co-products:", error);
    return res.status(500).json({
      error: "Failed to fetch co-products",
      details: error.message,
    });
  }
});




/* =========================================================
 Generic dynamic GCP table route for frontend
 Supports:
 - /api/bigquery/table/:table
 - optional filters via query params
 - ?limit=all => no limit
 - ?limit=100 => LIMIT 100
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
        ([, value]) =>
          value !== undefined &&
          value !== null &&
          String(value).trim() !== ""
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

router.get("/bom-consumed/:bomId", async (req, res) => {
  try {
    const { bomId } = req.params;

    if (!bomId) {
      return res.status(400).json({
        success: false,
        message: "bomId is required",
      });
    }

    const data = await fetchFromTable(
      "bom_consumed",
      { BOMID: bomId },
      1000
    );

    return res.status(200).json({
      success: true,
      count: data.length,
      data,
    });
  } catch (error) {
    console.error("Error fetching BOM consumed items:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Something went wrong",
    });
  }
});

router.get("/api/bigquery/table/item_bom_routing/:bomId", async (req, res) => {
  try {
    const { bomId } = req.params;

    if (!bomId) {
      return res.status(400).json({
        success: false,
        message: "bomId is required",
      });
    }

    const query = `
      SELECT *
      FROM \`${projectId}.${dataset}.item_bom_routing\`
      WHERE TRIM(CAST(bom_id AS STRING)) = @bomId
    `;

    const options = {
      query,
      params: { bomId: String(bomId).trim() },
      location: "US", // or your dataset location if different
    };

    const [rows] = await bigquery.query(options);

    return res.json({
      success: true,
      data: rows || [],
    });
  } catch (error) {
    console.error("Error fetching item BOM routing items:", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch item BOM routing items",
      details: error.message,
    });
  }
});


export default router;
