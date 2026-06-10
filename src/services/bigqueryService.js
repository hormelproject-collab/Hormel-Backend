import { BigQuery } from "@google-cloud/bigquery";

const bigquery = new BigQuery({
  projectId: process.env.BQ_PROJECT_ID || process.env.GCP_PROJECT_ID,
});

const getBigQueryConfig = () => {
  const projectId = process.env.BQ_PROJECT_ID || process.env.GCP_PROJECT_ID;
  const dataset = process.env.BQ_DATASET;

  if (!projectId || !dataset) {
    throw new Error("BQ_PROJECT_ID or BQ_DATASET is not set in .env");
  }

  return { projectId, dataset };
};

const normalizeText = (value) => String(value ?? "").trim();
const normalizeUpper = (value) => normalizeText(value).toUpperCase();
const sanitizeIdPart = (value) =>
  normalizeText(value).replace(/\s+/g, " ").trim();

const runQuery = async (query, params = {}) => {
  const [rows] = await bigquery.query({
    query,
    params,
    location: process.env.BQ_LOCATION || undefined,
  });
  return rows;
};

const getTableColumns = async (tableName) => {
  const { projectId, dataset } = getBigQueryConfig();

  const query = `
    SELECT column_name
    FROM \`${projectId}.${dataset}.INFORMATION_SCHEMA.COLUMNS\`
    WHERE table_name = @tableName
  `;

  const rows = await runQuery(query, { tableName });
  return rows.map((row) => String(row.column_name || "").toLowerCase());
};

const pickFirstValue = (row, keys = []) => {
  if (!row) return "";
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== "") {
      return String(row[key]).trim();
    }
  }
  return "";
};

export const fetchFromTable = async (tableName, filters = {}, limit = null) => {
  const { projectId, dataset } = getBigQueryConfig();

  let query = `SELECT * FROM \`${projectId}.${dataset}.${tableName}\``;
  const conditions = [];
  const params = {};

  Object.entries(filters || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || String(value).trim() === "") return;
    conditions.push(`CAST(${key} AS STRING) = @${key}`);
    params[key] = String(value);
  });

  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(" AND ")}`;
  }

  if (limit !== null && limit !== undefined) {
    query += ` LIMIT ${Number(limit)}`;
  }

  return runQuery(query, params);
};

/**
 * Existing API support:
 * item_master + item_releaseflag
 */
export const fetchItemMasterWithReleaseFlag = async (filters = {}, limit = null) => {
  const itemMasterRows = await fetchFromTable("item_master", filters, limit);
  const releaseFlagRows = await fetchFromTable("item_releaseflag", {}, null);

  const releaseFlagMap = new Map();

  for (const row of releaseFlagRows) {
    const itemKey = normalizeUpper(row.item);
    if (!itemKey) continue;

    const releaseFlag = pickFirstValue(row, [
      "release",
      "release_flag",
      "item_release_flag",
      "planning_release_flag",
      "status",
    ]);

    releaseFlagMap.set(itemKey, releaseFlag);
  }

  return itemMasterRows.map((row) => {
    const itemKey = normalizeUpper(row.item);
    return {
      ...row,
      item_release_flag: releaseFlagMap.get(itemKey) || "",
    };
  });
};

/**
 * Existing API support:
 * selected items -> bom_produced -> location_master
 */
export const fetchLocationsBySelectedItems = async (_itemIds) => {
  const { projectId, dataset } = getBigQueryConfig();

  const query = `
    SELECT DISTINCT
      TRIM(CAST(location AS STRING)) AS location,
      COALESCE(CAST(location_description AS STRING), '') AS location_description,
      COALESCE(CAST(location_status AS STRING), '') AS location_status,
      COALESCE(CAST(location_country AS STRING), '') AS location_country,
      COALESCE(CAST(location_region AS STRING), '') AS location_region,
      COALESCE(CAST(location_type AS STRING), '') AS location_type,
      COALESCE(CAST(reporting_location AS STRING), '') AS reporting_location,
      COALESCE(CAST(city AS STRING), '') AS city,
      COALESCE(CAST(zip AS STRING), '') AS zip,
      COALESCE(CAST(address AS STRING), '') AS address
    FROM \`${projectId}.${dataset}.location_master\`
    WHERE location IS NOT NULL
      AND TRIM(CAST(location AS STRING)) != ''
    ORDER BY location
  `;

  return runQuery(query);
};

/**
 * Pull all distinct resources from routing_rescons
 */
export const fetchAllResourcesFromRoutingResCons = async () => {
  const { projectId, dataset } = getBigQueryConfig();

  const query = `
    SELECT DISTINCT
      TRIM(CAST(resource AS STRING)) AS resource
    FROM \`${projectId}.${dataset}.routing_rescons\`
    WHERE resource IS NOT NULL
      AND TRIM(CAST(resource AS STRING)) != ''
    ORDER BY resource
  `;

  const rows = await runQuery(query);

  return rows.map((row) => ({
    resource: normalizeText(row.resource),
  }));
};

/**
 * Resource relevancy from resource_master
 */
export const fetchResourceRelevancyByResource = async (resource) => {
  const { projectId, dataset } = getBigQueryConfig();

  const query = `
    SELECT
      TRIM(CAST(resource AS STRING)) AS resource,
      COALESCE(CAST(resource_planning_relevance AS STRING), '') AS resource_planning_relevance
    FROM \`${projectId}.${dataset}.resource_master\`
    WHERE UPPER(TRIM(CAST(resource AS STRING))) = @resource
    LIMIT 1
  `;

  const rows = await runQuery(query, {
    resource: normalizeUpper(resource),
  });

  const row = rows[0] || {};

  return {
    resource: normalizeText(row.resource),
    resourcePlanningRelevance: pickFirstValue(row, [
      "resource_planning_relevance",
    ]),
  };
};

/**
 * Pull all BOM IDs from bom_parameters
 */
export const fetchBomIdsFromBomParameters = async () => {
  const { projectId, dataset } = getBigQueryConfig();

  const query = `
    SELECT DISTINCT
      TRIM(CAST(bom_id AS STRING)) AS bom_id
    FROM \`${projectId}.${dataset}.bom_parameters\`
    WHERE bom_id IS NOT NULL
      AND TRIM(CAST(bom_id AS STRING)) != ''
    ORDER BY bom_id
  `;

  const rows = await runQuery(query);

  return rows.map((row) => ({
    bomId: normalizeText(row.bom_id),
  }));
};

/**
 * Based on selected BOM ID:
 * 1) fetch produced item + location from bom_produced
 * 2) fetch release flag from item_releaseflag using item
 */
export const fetchBomDetailsByBomId = async (bomId) => {
  const { projectId, dataset } = getBigQueryConfig();

  const producedQuery = `
    SELECT
      CAST(bp.bom_id AS STRING) AS bom_id,
      CAST(bp.item AS STRING) AS item,
      CAST(bp.location AS STRING) AS location,
      SAFE_CAST(bp.erp_bom_qty_produced_per AS FLOAT64) AS qty_produced_per
    FROM \`${projectId}.${dataset}.bom_produced\` bp
    WHERE UPPER(TRIM(CAST(bp.bom_id AS STRING))) = @bomId
    ORDER BY
      CASE
        WHEN SAFE_CAST(bp.erp_bom_qty_produced_per AS FLOAT64) = 1 THEN 0
        ELSE 1
      END,
      CAST(bp.item AS STRING)
    LIMIT 1
  `;

  const producedRows = await runQuery(producedQuery, {
    bomId: normalizeUpper(bomId),
  });

  const producedRow = producedRows[0];

  if (!producedRow) {
    const bomParts = normalizeText(bomId).split("_");
    const fallbackProducedItem = bomParts.length >= 2 ? bomParts[1] : "";
    const fallbackLocation = bomParts.length >= 3 ? bomParts.slice(2).join("_") : "";

    return {
      bomId: normalizeText(bomId),
      producedItem: fallbackProducedItem,
      location: fallbackLocation,
      itemReleaseFlag: "",
    };
  }

  const producedItem = normalizeText(producedRow.item);
  const location = normalizeText(producedRow.location);

  let itemReleaseFlag = "";

  if (producedItem) {
    const releaseQuery = `
      SELECT *
      FROM \`${projectId}.${dataset}.item_releaseflag\`
      WHERE UPPER(TRIM(CAST(item AS STRING))) = @item
      LIMIT 1
    `;

    const releaseRows = await runQuery(releaseQuery, {
      item: normalizeUpper(producedItem),
    });

    const releaseRow = releaseRows[0] || {};
    itemReleaseFlag = pickFirstValue(releaseRow, [
      "release",
      "release_flag",
      "item_release_flag",
      "planning_release_flag",
      "status",
    ]);
  }

  return {
    bomId: normalizeText(bomId),
    producedItem,
    location,
    itemReleaseFlag,
  };
};

/**
 * Co-product options for selected item from item_master
 *
 * This tries to adapt to whichever item_master schema exists in GCP.
 * Supported patterns:
 *  - parent_item / co_product_item
 *  - produced_item / co_product_item
 *  - base_item / co_product_item
 *  - main_item / co_product_item
 *  - item / co_product_item
 *
 * If no supported co-product columns exist, returns [] safely.
 */
export const fetchCoProductsByItem = async (item) => {
  const { projectId, dataset } = getBigQueryConfig();
  const columns = await getTableColumns("item_master");

  const relationColumnCandidates = [
    "parent_item",
    "produced_item",
    "base_item",
    "main_item",
    "item",
  ];

  const coProductColumnCandidates = [
    "co_product_item",
    "coproduct_item",
    "connected_co_product",
    "co_product",
    "connected_item",
  ];

  const relationColumn = relationColumnCandidates.find((c) => columns.includes(c));
  const coProductColumn = coProductColumnCandidates.find((c) => columns.includes(c));

  if (!relationColumn || !coProductColumn) {
    return [];
  }

  const query = `
    SELECT DISTINCT
      TRIM(CAST(${coProductColumn} AS STRING)) AS co_product_item
    FROM \`${projectId}.${dataset}.item_master\`
    WHERE UPPER(TRIM(CAST(${relationColumn} AS STRING))) = @item
      AND ${coProductColumn} IS NOT NULL
      AND TRIM(CAST(${coProductColumn} AS STRING)) != ''
    ORDER BY co_product_item
  `;

  const rows = await runQuery(query, {
    item: normalizeUpper(item),
  });

  return rows.map((row) => ({
    item: normalizeText(row.co_product_item),
  }));
};

/**
 * Existing internal helper:
 * Fetch all distinct resources from resource_rescons.
 * If that table doesn't exist, fallback to routing_rescons.
 */
const fetchAllDistinctResources = async () => {
  const { projectId, dataset } = getBigQueryConfig();

  const tableCandidates = ["resource_rescons", "routing_rescons"];
  let lastError = null;

  for (const tableName of tableCandidates) {
    try {
      const query = `
        SELECT DISTINCT
          TRIM(CAST(resource AS STRING)) AS resource
        FROM \`${projectId}.${dataset}.${tableName}\`
        WHERE resource IS NOT NULL
          AND TRIM(CAST(resource AS STRING)) != ''
        ORDER BY resource
      `;

      const rows = await runQuery(query);
      return rows;
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Failed to fetch resources. Neither resource_rescons nor routing_rescons could be queried. ${lastError?.message || ""}`
  );
};

/**
 * Existing API:
 * Step 3 metadata for Resource / Component / Co-Product Info
 */
export const fetchResourceComponentMetadata = async (
  items = [],
  locations = []
) => {
  const [resourceRows, resourceMasterRows, itemMasterRows] = await Promise.all([
    fetchAllDistinctResources(),
    fetchFromTable("resource_master", {}, null),
    fetchFromTable("item_master", {}, null),
  ]);

  const resourceMasterMap = new Map();

  for (const row of resourceMasterRows) {
    const resourceKey = normalizeUpper(row.resource);
    if (!resourceKey) continue;

    resourceMasterMap.set(
      resourceKey,
      pickFirstValue(row, ["resource_planning_relevance"])
    );
  }

  const resourceOptions = [];
  const seenResources = new Set();

  for (const row of resourceRows) {
    const resourceValue = normalizeText(row.resource);
    const resourceKey = normalizeUpper(resourceValue);

    if (!resourceKey || seenResources.has(resourceKey)) continue;
    seenResources.add(resourceKey);

    resourceOptions.push({
      resource: resourceValue,
      resource_planning_relevance: resourceMasterMap.get(resourceKey) || "",
    });
  }

  const itemOptions = [];
  const seenItems = new Set();

  for (const row of itemMasterRows) {
    const itemValue = normalizeText(row.item);
    const itemKey = normalizeUpper(itemValue);

    if (!itemKey || seenItems.has(itemKey)) continue;
    seenItems.add(itemKey);

    itemOptions.push({
      item: itemValue,
      description: pickFirstValue(row, [
        "item_description",
        "description",
      ]),
    });
  }

  const bomVersions = [
    "PRIMARY",
    ...Array.from({ length: 20 }, (_, index) => `BOM${index + 1}`),
  ];

  return {
    bomVersions,
    resourceOptions,
    itemOptions,
    selectedItems: Array.isArray(items) ? items : [],
    selectedLocations: Array.isArray(locations) ? locations : [],
  };
};

/**
 * Existing API:
 * Existing BOM search rows
 */
export const fetchExistingBomSearchRows = async () => {
  const { projectId, dataset } = getBigQueryConfig();

  const query = `
    WITH base_produced AS (
      SELECT
        CAST(bp.bom_id AS STRING) AS bom_id,
        CAST(bp.item AS STRING) AS produced_item,
        CAST(bp.location AS STRING) AS location,
        SAFE_CAST(bp.erp_bom_qty_produced_per AS FLOAT64) AS qty_produced_per,
        ROW_NUMBER() OVER (
          PARTITION BY CAST(bp.bom_id AS STRING)
          ORDER BY
            CASE
              WHEN SAFE_CAST(bp.erp_bom_qty_produced_per AS FLOAT64) = 1 THEN 0
              ELSE 1
            END,
            CAST(bp.item AS STRING)
        ) AS rn
      FROM \`${projectId}.${dataset}.bom_produced\` bp
      WHERE bp.bom_id IS NOT NULL
    ),
    release_flags AS (
      SELECT
        CAST(item AS STRING) AS item,
        COALESCE(
          CAST(release AS STRING),
          CAST(release_flag AS STRING),
          CAST(item_release_flag AS STRING),
          CAST(planning_release_flag AS STRING),
          CAST(status AS STRING),
          ''
        ) AS item_release_flag
      FROM \`${projectId}.${dataset}.item_releaseflag\`
    ),
    produced_desc AS (
      SELECT
        CAST(item AS STRING) AS item,
        COALESCE(
          CAST(item_description AS STRING),
          CAST(description AS STRING),
          ''
        ) AS produced_item_desc
      FROM \`${projectId}.${dataset}.item_master\`
    ),
    routing_rows AS (
      SELECT
        CAST(ibr.bom_id AS STRING) AS bom_id,
        CAST(ibr.routing_id AS STRING) AS routing_id
      FROM \`${projectId}.${dataset}.item_bom_routing\` ibr
    ),
    resource_rows AS (
      SELECT
        CAST(rr.routing_id AS STRING) AS routing_id,
        CAST(rr.resource AS STRING) AS resource
      FROM \`${projectId}.${dataset}.routing_rescons\` rr
    )
    SELECT
      bp.bom_id AS id,
      bp.location,
      bp.produced_item,
      COALESCE(pd.produced_item_desc, '') AS produced_item_desc,
      bp.bom_id,
      COALESCE(rr.resource, '') AS resource,
      COALESCE(rf.item_release_flag, '') AS item_release_flag,
      COALESCE(rt.routing_id, '') AS routing_id
    FROM base_produced bp
    LEFT JOIN produced_desc pd
      ON UPPER(TRIM(pd.item)) = UPPER(TRIM(bp.produced_item))
    LEFT JOIN release_flags rf
      ON UPPER(TRIM(rf.item)) = UPPER(TRIM(bp.produced_item))
    LEFT JOIN routing_rows rt
      ON UPPER(TRIM(rt.bom_id)) = UPPER(TRIM(bp.bom_id))
    LEFT JOIN resource_rows rr
      ON UPPER(TRIM(rr.routing_id)) = UPPER(TRIM(rt.routing_id))
    WHERE bp.rn = 1
    ORDER BY bp.bom_id, rr.resource
  `;

  return runQuery(query);
};
