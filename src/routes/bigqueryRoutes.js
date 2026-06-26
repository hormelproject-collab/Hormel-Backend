import express from "express";
import {
  fetchFromTable,
  fetchItemMasterWithReleaseFlag,
  fetchLocationsBySelectedItems,
  fetchResourceComponentMetadata,
  fetchExistingBomSearchRows,
  fetchBomIdsFromBomParameters,
  fetchAllResourcesFromRoutingResCons,
  fetchResourceRelevancyByResource,
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

const toText = (value) => {
  if (value === undefined || value === null) return "";
  return String(value).trim();
};
const safeArray = (value) => (Array.isArray(value) ? value : []);
const getRowValue = (row, keys) => {
  for (const key of keys) {
    const value = row?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }
  return "";
};

const getBomIdFilters = (bomId) => {
  const value = toText(bomId);
  if (!value) return [];
  return [
    { bom_id: value },
    { BOMID: value },
    { bomId: value },
  ];
};

const fetchRowsByBomId = async (tableName, bomId, limit = 1000) => {
  const filtersToTry = getBomIdFilters(bomId);

  for (const filters of filtersToTry) {
    try {
      const rows = await fetchFromTable(tableName, filters, limit);
      if (Array.isArray(rows) && rows.length) {
        return rows;
      }
    } catch (error) {
      const message = String(error?.message || "");

      if (
        message.includes("Unrecognized name: bom_id") ||
        message.includes("Unrecognized name: BOMID") ||
        message.includes("Unrecognized name: bomId")
      ) {
        continue;
      }

      throw error;
    }
  }

  return [];
};

const deriveItemAndLocationFromBomId = (bomId) => {
  const parts = String(bomId || "")
    .split("_")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length < 3) {
    return { item: "", location: "" };
  }

  return {
    item: parts[1] || "",
    location: parts.slice(2).join("_") || "",
  };
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
 5) Create Item BOM Routing Record - Step 1
========================================================= */
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

router.get("/bom-routing-step1/bom-details/:bomId", async (req, res) => {
  try {
    const bomId = String(req.params.bomId || "").trim();
    if (!bomId) {
      return res.status(400).json({
        error: "bomId is required",
      });
    }

    const producedRows = await fetchRowsByBomId("bom_produced", bomId, 1000);
    const firstProducedRow = producedRows[0] || {};
    const derived = deriveItemAndLocationFromBomId(bomId);

    const producedItem =
      getRowValue(firstProducedRow, [
        "item",
        "produced_item",
        "producedItem",
        "item_id",
      ]) || derived.item;

    const location =
      getRowValue(firstProducedRow, ["location", "plant", "site"]) ||
      derived.location;

    let itemReleaseFlag = "";
    if (producedItem) {
      try {
        const releaseFlagData = await fetchItemReleaseFlagByItem(producedItem);
        itemReleaseFlag =
          releaseFlagData?.release ||
          releaseFlagData?.item_releaseflag ||
          releaseFlagData?.releaseFlag ||
          "";
      } catch (releaseErr) {
        console.error("Error fetching item release flag in bom-details:", releaseErr);
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        bomId,
        producedItem,
        location,
        itemReleaseFlag,
      },
    });
  } catch (error) {
    console.error("Error fetching BOM details:", error);
    return res.status(500).json({
      error: "Failed to fetch BOM details",
      details: error.message,
    });
  }
});

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

router.get("/bom-routing-step1/resource-relevancy/:resource", async (req, res) => {
  try {
    const resource = String(req.params.resource || "").trim();
    if (!resource) {
      return res.status(400).json({
        error: "resource is required",
      });
    }

    const data = await fetchResourceRelevancyByResource(resource);
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

router.get("/bom-routing-step1/co-products/:bomIdOrItem", async (req, res) => {
  try {
    const bomIdOrItem = String(
      req.params.bomIdOrItem || req.query.bomId || req.query.item || ""
    ).trim();

    if (!bomIdOrItem) {
      return res.status(400).json({
        error: "bomIdOrItem is required",
      });
    }

    let producedItemToExclude = "";

    const producedRows = await fetchRowsByBomId("bom_produced", bomIdOrItem, 1000);
    const firstProducedRow = producedRows[0] || {};

    producedItemToExclude = getRowValue(firstProducedRow, [
      "item",
      "produced_item",
      "producedItem",
      "item_id",
    ]);

    if (!producedItemToExclude && !bomIdOrItem.includes("_")) {
      producedItemToExclude = bomIdOrItem;
    }

    const itemMasterRows = await fetchFromTable("item_master", {}, null);

    const data = safeArray(itemMasterRows)
      .map((row) => ({
        item: getRowValue(row, ["item", "item_id", "item_number", "itemNumber"]),
        description: getRowValue(row, [
          "item_description",
          "item_desc",
          "item_desc_1",
          "description",
          "desc",
        ]),
      }))
      .filter((row) => row.item)
      .filter((row) => row.item !== producedItemToExclude)
      .reduce((acc, row) => {
        if (!acc.some((existing) => existing.item === row.item)) {
          acc.push(row);
        }
        return acc;
      }, [])
      .sort((a, b) => a.item.localeCompare(b.item));

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

    const data = await fetchRowsByBomId("bom_consumed", bomId, 1000);

    return res.status(200).json({
      success: true,
      count: Array.isArray(data) ? data.length : 0,
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

export default router;