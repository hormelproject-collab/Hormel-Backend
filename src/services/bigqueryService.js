import { BigQuery } from "@google-cloud/bigquery";

const bigquery = new BigQuery({
  projectId: process.env.BQ_PROJECT_ID,
});

const getBigQueryConfig = () => {
  const projectId = process.env.BQ_PROJECT_ID;
  const dataset = process.env.BQ_DATASET;

  if (!projectId || !dataset) {
    throw new Error("BQ_PROJECT_ID or BQ_DATASET is not set in .env");
  }

  return { projectId, dataset };
};

const normalizeText = (value) => String(value ?? "").trim();
const normalizeUpper = (value) => normalizeText(value).toUpperCase();
const sanitizeIdPart = (value) =>
  normalizeUpper(value).replace(/[\/\s]+/g, "");

export const fetchFromTable = async (tableName, filters = {}, limit = null) => {
  const { projectId, dataset } = getBigQueryConfig();

  let query = `SELECT * FROM \`${projectId}.${dataset}.${tableName}\``;
  const conditions = [];
  const params = {};

  Object.entries(filters).forEach(([key, value]) => {
    conditions.push(`${key} = @${key}`);
    params[key] = value;
  });

  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(" AND ")}`;
  }

  if (limit !== null && limit !== undefined) {
    query += ` LIMIT ${Number(limit)}`;
  }

  const [rows] = await bigquery.query({
    query,
    params,
  });

  return rows;
};

/**
 * Existing API support:
 * item_master + item_releaseflag
 */
export const fetchItemMasterWithReleaseFlag = async (
  filters = {},
  limit = null
) => {
  const itemMasterRows = await fetchFromTable("item_master", filters, limit);
  const releaseFlagRows = await fetchFromTable("item_releaseflag", {}, null);

  const releaseFlagMap = new Map();

  for (const row of releaseFlagRows) {
    const itemKey = normalizeUpper(row.item);
    if (!itemKey) continue;

    const releaseFlagValue =
      row.item_releaseflag ??
      row.item_release_flag ??
      row.itemreleaseflag ??
      row.release_flag ??
      row.release ??
      "";

    releaseFlagMap.set(itemKey, releaseFlagValue);
  }

  return itemMasterRows.map((row) => {
    const itemKey = normalizeUpper(row.item);

    return {
      ...row,
      item_releaseflag: releaseFlagMap.get(itemKey) || "",
    };
  });
};

/**
 * Existing API support:
 * selected items -> bom_produced -> location_master
 */
export const fetchLocationsBySelectedItems = async (itemIds) => {
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    throw new Error("itemIds must be a non-empty array");
  }

  const { projectId, dataset } = getBigQueryConfig();

  const normalizedItemIds = itemIds
    .map((id) => normalizeUpper(id))
    .filter(Boolean);

  const query = `
  SELECT DISTINCT
    TRIM(CAST(lm.location AS STRING)) AS location,
    COALESCE(CAST(lm.location_description AS STRING), '') AS location_description,
    COALESCE(CAST(lm.location_status AS STRING), '') AS location_status,
    COALESCE(CAST(lm.location_country AS STRING), '') AS location_country,
    COALESCE(CAST(lm.location_region AS STRING), '') AS location_region,
    COALESCE(CAST(lm.location_type AS STRING), '') AS location_type,
    COALESCE(CAST(lm.reporting_location AS STRING), '') AS reporting_location,
    COALESCE(CAST(lm.city AS STRING), '') AS city,
    COALESCE(CAST(lm.zip AS STRING), '') AS zip,
    COALESCE(CAST(lm.address AS STRING), '') AS address
  FROM \`${projectId}.${dataset}.location_master\` lm
  WHERE lm.location IS NOT NULL
    AND TRIM(CAST(lm.location AS STRING)) != ''
  ORDER BY location
`;


  const [rows] = await bigquery.query({
    query,
    params: { itemIds: normalizedItemIds },
  });

  return rows;
};

/**
 * Internal helper:
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

      const [rows] = await bigquery.query({ query });
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
 * NEW API:
 * Step 3 metadata for Resource / Component / Co-Product Info
 *
 * Returns:
 * - ALL distinct resources from resource_rescons (or routing_rescons fallback)
 * - Resource relevancy from resource_master
 * - Item options from item_master
 * - BOM Versions: PRIMARY + BOM1..BOM20
 * - Optional generated mappings if producedItem + locations + selectedResources are passed
 *
 * NOTE:
 * This no longer filters resources by selected item/location.
 */
export const fetchResourceComponentMetadata = async ({
  producedItem = "",
  locations = [],
  selectedResources = [],
  bomVersion = "PRIMARY",
} = {}) => {
  const [resourceRows, resourceMasterRows, itemMasterRows] = await Promise.all([
    fetchAllDistinctResources(),
    fetchFromTable("resource_master", {}, null),
    fetchFromTable("item_master", {}, null),
  ]);

  const resourceMasterMap = new Map();

  for (const row of resourceMasterRows) {
    const resourceKey = normalizeUpper(row.resource);
    if (!resourceKey) continue;

    resourceMasterMap.set(resourceKey, {
      resource: normalizeText(row.resource),
      resource_relevancy:
        row.resource_planning_relevance ??
        row.resource_relevancy ??
        row.relevancy ??
        "",
    });
  }

  const resourceOptions = [];
  const seenResources = new Set();

  for (const row of resourceRows) {
    const resourceValue = normalizeText(row.resource);
    const resourceKey = normalizeUpper(resourceValue);

    if (!resourceKey) continue;
    if (seenResources.has(resourceKey)) continue;
    seenResources.add(resourceKey);

    const resourceInfo = resourceMasterMap.get(resourceKey);

    resourceOptions.push({
      resource: resourceValue,
      resource_relevancy: resourceInfo?.resource_relevancy ?? "",
    });
  }

  const itemOptions = [];
  const seenItems = new Set();

  for (const row of itemMasterRows) {
    const itemValue = normalizeText(row.item);
    const itemKey = normalizeUpper(itemValue);

    if (!itemKey) continue;
    if (seenItems.has(itemKey)) continue;
    seenItems.add(itemKey);

    itemOptions.push({
      item: itemValue,
      item_description: row.item_desc ?? row.item_description ?? "",
      item_status: row.item_status ?? row.status ?? "",
    });
  }

  const bomVersions = [
    "PRIMARY",
    ...Array.from({ length: 20 }, (_, index) => `BOM${index + 1}`),
  ];

  const normalizedProducedItem = sanitizeIdPart(producedItem);
  const normalizedLocations = Array.isArray(locations)
    ? locations.map((loc) => normalizeText(loc)).filter(Boolean)
    : [];
  const normalizedSelectedResources = Array.isArray(selectedResources)
    ? selectedResources.map((res) => normalizeText(res)).filter(Boolean)
    : [];

  let generatedMappings = [];

  if (
    normalizedProducedItem &&
    normalizedLocations.length > 0 &&
    normalizedSelectedResources.length > 0 &&
    normalizeText(bomVersion)
  ) {
    generatedMappings = normalizedLocations.map((location) => {
      const bomId = `${sanitizeIdPart(bomVersion)}_${normalizedProducedItem}_${sanitizeIdPart(location)}`;

      const routingIds = normalizedSelectedResources.map((resource) => ({
        resource,
        routing_id: `ROUTING_${normalizedProducedItem}_${sanitizeIdPart(location)}_${sanitizeIdPart(resource)}`,
        resource_relevancy:
          resourceMasterMap.get(normalizeUpper(resource))?.resource_relevancy ??
          "",
      }));

      return {
        location,
        bomId,
        routingIds,
      };
    });
  }

  return {
    bomVersions,
    resourceOptions,
    itemOptions,
    generatedMappings,
  };
};
