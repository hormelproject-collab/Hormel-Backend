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

  const options = {
    query,
    params,
  };

  const [rows] = await bigquery.query(options);
  return rows;
};

/**
 * item_master + item_releaseflag
 * Merge by item
 */
export const fetchItemMasterWithReleaseFlag = async (
  filters = {},
  limit = null
) => {
  const itemMasterRows = await fetchFromTable("item_master", filters, limit);
  const releaseFlagRows = await fetchFromTable("item_releaseflag", {}, null);

  const releaseFlagMap = new Map();

  const normalizeItem = (value) => String(value ?? "").trim().toUpperCase();

  for (const row of releaseFlagRows) {
    const itemKey = normalizeItem(row.item);
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
    const itemKey = normalizeItem(row.item);

    return {
      ...row,
      item_releaseflag: releaseFlagMap.get(itemKey) || "",
    };
  });

};

/**
 * selected items -> bom_produced -> location_master
 * FIX: cast bp.item to STRING and normalize itemIds to STRING
 */
export const fetchLocationsBySelectedItems = async (itemIds) => {
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    throw new Error("itemIds must be a non-empty array");
  }

  const projectId = process.env.BQ_PROJECT_ID;
  const dataset = process.env.BQ_DATASET;

  if (!projectId || !dataset) {
    throw new Error("BQ_PROJECT_ID or BQ_DATASET is not set in .env");
  }

  const normalizedItemIds = itemIds
    .map((id) => String(id ?? "").trim().toUpperCase())
    .filter(Boolean);

  const query = `
    SELECT DISTINCT
      UPPER(TRIM(CAST(bp.item AS STRING))) AS item,
      TRIM(CAST(bp.location AS STRING)) AS location,

      -- exact fields needed by frontend
      COALESCE(CAST(lm.location_description AS STRING), '') AS location_description,
      COALESCE(CAST(lm.location_status AS STRING), '') AS location_status,

      -- optional extra fields if needed later
      COALESCE(CAST(lm.location_country AS STRING), '') AS location_country,
      COALESCE(CAST(lm.location_region AS STRING), '') AS location_region,
      COALESCE(CAST(lm.location_type AS STRING), '') AS location_type,
      COALESCE(CAST(lm.reporting_location AS STRING), '') AS reporting_location,
      COALESCE(CAST(lm.city AS STRING), '') AS city,
      COALESCE(CAST(lm.zip AS STRING), '') AS zip,
      COALESCE(CAST(lm.address AS STRING), '') AS address

    FROM \`${projectId}.${dataset}.bom_produced\` bp
    LEFT JOIN \`${projectId}.${dataset}.location_master\` lm
      ON TRIM(CAST(bp.location AS STRING)) = TRIM(CAST(lm.location AS STRING))

    WHERE UPPER(TRIM(CAST(bp.item AS STRING))) IN UNNEST(@itemIds)

    ORDER BY item, location
  `;

  const options = {
    query,
    params: { itemIds: normalizedItemIds },
  };

  const [rows] = await bigquery.query(options);
  return rows;
};


