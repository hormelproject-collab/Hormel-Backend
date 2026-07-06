import bigquery from "../db/bigqueryClient.js";
import pool from "../db/postgresClient.js";
import appConfig from "../config/appConfig.js";

/* =========================================================
   Source rules
   - BOM core tables are fetched from PostgreSQL.
   - item_mrp_rls_flg / itemReleaseFlag is fetched from BigQuery DEV.
   - Remaining BigQuery master/reference tables are fetched from BigQuery PRD.
========================================================= */
const BQ_TABLE_KEYS = Object.freeze({
  bomParameters: "bomParameters",
  bomProduced: "bomProduced",
  bomConsumed: "bomConsumed",
  itemBomRouting: "itemBomRouting",
  itemMaster: "itemMaster",
  itemReleaseFlag: "itemReleaseFlag",
  locationMaster: "locationMaster",
  routingRescons: "routingRescons",
  resourceMaster: "resourceMaster",
});

const PG_TABLE_KEYS_BY_TABLE_NAME = Object.freeze({
  [appConfig.postgres.tables.bomParameters]: "bomParameters",
  [appConfig.postgres.tables.bomProduced]: "bomProduced",
  [appConfig.postgres.tables.bomConsumed]: "bomConsumed",
  [appConfig.postgres.tables.itemBomRouting]: "itemBomRouting",
});

const BQ_TABLE_KEYS_BY_TABLE_NAME = Object.freeze(
  Object.fromEntries(
    Object.entries(appConfig.bigQuery.tables).map(([key, tableName]) => [tableName, key])
  )
);

const BQ_TABLE_SOURCE_BY_KEY = Object.freeze({
  bomParameters: "dev",
  bomProduced: "dev",
  bomConsumed: "dev",
  itemBomRouting: "dev",
  itemReleaseFlag: "dev",
  itemMaster: "dev",
  locationMaster: "dev",
  routingRescons: "dev",
  resourceMaster: "dev",
  // itemMaster: "prd",
  // locationMaster: "prd",
  // routingRescons: "prd",
  // resourceMaster: "prd",
});

const IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

const assertSafeIdentifier = (value, label) => {
  const normalized = String(value || "").trim();
  if (!normalized) {
    throw new Error(`Missing identifier for ${label}`);
  }
  if (!IDENTIFIER_REGEX.test(normalized)) {
    throw new Error(`Invalid identifier for ${label}: ${normalized}`);
  }
  return normalized;
};

const quoteIdent = (value) => `"${String(value).replace(/"/g, '""')}"`;
const qCol = (columnName) => `\`${String(columnName).replace(/`/g, "")}\``;

const PG_SCHEMA = assertSafeIdentifier(appConfig.postgres.schema || "planning_bom", "postgres.schema");
const pgTableRef = (tableName) => `${quoteIdent(PG_SCHEMA)}.${quoteIdent(tableName)}`;

const getBigQueryConfig = () => {
  const dataset = appConfig.bigQuery.datasetId;
  if (!dataset) {
    throw new Error("BigQuery datasetId is missing in appConfig.js");
  }
  return { dataset };
};

const getBigQueryProjectId = (tableKey) => {
  const source = BQ_TABLE_SOURCE_BY_KEY[tableKey] || "prd";
  const projectId = appConfig.bigQuery.projectIds?.[source];
  if (!projectId) {
    throw new Error(`BigQuery projectId for source '${source}' is missing in appConfig.js`);
  }
  return projectId;
};

const getBQTableNameByKey = (tableKey) => {
  const tableName = appConfig.bigQuery.tables?.[tableKey];
  return assertSafeIdentifier(tableName, `bigQuery.tables.${tableKey}`);
};

const bqTableRefByKey = (tableKey) => {
  const { dataset } = getBigQueryConfig();
  const projectId = getBigQueryProjectId(tableKey);
  const tableName = getBQTableNameByKey(tableKey);
  return `\`${projectId}.${assertSafeIdentifier(dataset, "BigQuery dataset")}.${tableName}\``;
};

const getTableKeyFromName = (tableName) => {
  const requested = String(tableName || "").trim();
  return PG_TABLE_KEYS_BY_TABLE_NAME[requested] || BQ_TABLE_KEYS_BY_TABLE_NAME[requested] || "";
};

const isPostgresTableName = (tableName) => {
  const requested = String(tableName || "").trim();
  return Boolean(PG_TABLE_KEYS_BY_TABLE_NAME[requested]);
};

const isKnownTableName = (tableName) => Boolean(getTableKeyFromName(tableName));

const normalizeText = (value) => String(value ?? "").trim();
const normalizeUpper = (value) => normalizeText(value).toUpperCase();

const runQuery = async (query, params = {}) => {
  const [rows] = await bigquery.query({ query, params });
  return rows || [];
};

const runPgQuery = async (query, params = []) => {
  const result = await pool.query(query, params);
  return result.rows || [];
};

const getPostgresTableColumns = async (tableName) => {
  const rows = await runPgQuery(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = $2
      ORDER BY ordinal_position
    `,
    [PG_SCHEMA, tableName]
  );
  return rows.map((row) => String(row.column_name || "").trim());
};

const getBigQueryTableColumns = async (tableKey) => {
  const { dataset } = getBigQueryConfig();
  const projectId = getBigQueryProjectId(tableKey);
  const tableName = getBQTableNameByKey(tableKey);
  const query = `
    SELECT column_name
    FROM \`${projectId}.${dataset}.INFORMATION_SCHEMA.COLUMNS\`
    WHERE table_name = @tableName
  `;
  const rows = await runQuery(query, { tableName });
  return rows.map((row) => String(row.column_name || "").trim());
};

const getTableColumns = async (tableName) => {
  const tableKey = getTableKeyFromName(tableName);
  if (!tableKey) {
    throw new Error(`Invalid table name: ${tableName}`);
  }
  if (isPostgresTableName(tableName)) {
    return getPostgresTableColumns(tableName);
  }
  return getBigQueryTableColumns(tableKey);
};

const findColumn = (columns, candidates = []) => {
  const columnMap = new Map(columns.map((column) => [String(column).toLowerCase(), column]));
  for (const candidate of candidates) {
    const matched = columnMap.get(String(candidate).toLowerCase());
    if (matched) return matched;
  }
  return "";
};

const findFirstExistingColumn = async (tableName, candidates = []) => {
  const columns = await getTableColumns(tableName);
  return findColumn(columns, candidates);
};

const getBomIdColumn = async (tableName) => {
  const bomIdColumn = await findFirstExistingColumn(tableName, ["bom_id", "BOMID", "bomId", "bomid", "BOM_ID"]);
  if (!bomIdColumn) {
    throw new Error(`No BOM ID column found in ${tableName}. Expected one of: bom_id, BOMID, bomId`);
  }
  return bomIdColumn;
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

const buildPgWhere = (filters = {}, params = []) => {
  const conditions = [];
  Object.entries(filters || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || String(value).trim() === "") return;
    conditions.push(`CAST(${quoteIdent(key)} AS TEXT) = $${params.length + 1}`);
    params.push(String(value));
  });
  return { conditions, params };
};

export const fetchFromTable = async (tableName, filters = {}, limit = null) => {
  const safeTableName = String(tableName || "").trim();
  if (!isKnownTableName(safeTableName)) {
    throw new Error(`Invalid table name: ${safeTableName}`);
  }

  if (isPostgresTableName(safeTableName)) {
    const params = [];
    const { conditions } = buildPgWhere(filters, params);
    let query = `SELECT * FROM ${pgTableRef(safeTableName)}`;
    if (conditions.length) {
      query += ` WHERE ${conditions.join(" AND ")}`;
    }
    if (limit !== null && limit !== undefined) {
      const parsedLimit = Number(limit);
      if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
        query += ` LIMIT ${Math.floor(parsedLimit)}`;
      }
    }
    return runPgQuery(query, params);
  }

  const tableKey = getTableKeyFromName(safeTableName);
  let query = `SELECT * FROM ${bqTableRefByKey(tableKey)}`;
  const conditions = [];
  const params = {};

  Object.entries(filters || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || String(value).trim() === "") return;
    const paramName = String(key).replace(/[^A-Za-z0-9_]/g, "_");
    conditions.push(`CAST(${qCol(key)} AS STRING) = @${paramName}`);
    params[paramName] = String(value);
  });

  if (conditions.length) {
    query += ` WHERE ${conditions.join(" AND ")}`;
  }

  if (limit !== null && limit !== undefined) {
    const parsedLimit = Number(limit);
    if (Number.isFinite(parsedLimit) && parsedLimit > 0) {
      query += ` LIMIT ${Math.floor(parsedLimit)}`;
    }
  }

  return runQuery(query, params);
};

/**
 * item_master from BigQuery PRD + item_mrp_rls_flg from BigQuery DEV.
 */
export const fetchItemMasterWithReleaseFlag = async ({
  page = 1,
  pageSize = 50,
  search = "",
  filterBy = "item",
} = {}) => {
  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const safePageSize = Math.min(200, Math.max(1, Number.parseInt(pageSize, 10) || 50));
  const safeOffset = (safePage - 1) * safePageSize;
  const searchText = normalizeText(search);

  const allowedFilterFields = new Set(["item", "item_description", "status", "releaseflag"]);
  const normalizedFilterBy = allowedFilterFields.has(String(filterBy || "").trim())
    ? String(filterBy || "").trim()
    : "item";

  const itemMasterColumns = await getBigQueryTableColumns(BQ_TABLE_KEYS.itemMaster);
  const releaseFlagColumns = await getBigQueryTableColumns(BQ_TABLE_KEYS.itemReleaseFlag);

  const itemColumn = findColumn(itemMasterColumns, ["item", "item_id", "item_number", "itemNumber"]);
  if (!itemColumn) {
    throw new Error(`${appConfig.bigQuery.tables.itemMaster}: item column not found`);
  }

  const itemDescColumn = findColumn(itemMasterColumns, [
    "item_desc",
    "item_description",
    "description",
    "item_desc_1",
  ]);

  const itemStatusColumn = findColumn(itemMasterColumns, ["item_status", "status"]);

  const releaseItemColumn = findColumn(releaseFlagColumns, [
    "item",
    "item_id",
    "item_number",
    "itemNumber",
  ]);

  const releaseColumn = findColumn(releaseFlagColumns, [
    "release",
    "release_flag",
    "releaseflag",
    "item_releaseflag",
    "item_release_flag",
    "item_mrp_rls_flg",
    "planning_release_flag",
    "status",
  ]);

  const itemDescExpr = itemDescColumn
    ? `COALESCE(CAST(im.${qCol(itemDescColumn)} AS STRING), '')`
    : `''`;

  const itemStatusExpr = itemStatusColumn
    ? `COALESCE(CAST(im.${qCol(itemStatusColumn)} AS STRING), '')`
    : `''`;

 const releaseFlagCte =
  releaseItemColumn && releaseColumn
    ? `
    release_flag_base AS (
      SELECT
        UPPER(TRIM(CAST(${qCol(releaseItemColumn)} AS STRING))) AS item_key,
        ANY_VALUE(COALESCE(CAST(${qCol(releaseColumn)} AS STRING), '')) AS item_release_flag
      FROM ${bqTableRefByKey(BQ_TABLE_KEYS.itemReleaseFlag)}
      WHERE ${qCol(releaseItemColumn)} IS NOT NULL
        AND TRIM(CAST(${qCol(releaseItemColumn)} AS STRING)) != ''
      GROUP BY item_key
    ),`
    : `
    release_flag_base AS (
      SELECT
        CAST(NULL AS STRING) AS item_key,
        CAST(NULL AS STRING) AS item_release_flag
      FROM UNNEST([]) AS empty_rows
    ),`;
    

  const filterColumnExprMap = {
    item: "item",
    item_description: "item_desc",
    status: "item_status",
    releaseflag: "item_release_flag",
  };

  const filterColumnExpr = filterColumnExprMap[normalizedFilterBy] || "item";

  const query = `
    WITH item_master_base AS (
  SELECT
    TRIM(CAST(im.${qCol(itemColumn)} AS STRING)) AS item,
    ${itemDescExpr} AS item_desc,
    ${itemStatusExpr} AS item_status
  FROM ${bqTableRefByKey(BQ_TABLE_KEYS.itemMaster)} im
  WHERE im.${qCol(itemColumn)} IS NOT NULL
    AND TRIM(CAST(im.${qCol(itemColumn)} AS STRING)) != ''
    AND (
      CASE
        WHEN @searchText = '' THEN UPPER(TRIM(CAST(im.${qCol(itemColumn)} AS STRING))) LIKE '%HRL%'
        ELSE TRUE
      END
    )
    ),
    ${releaseFlagCte}
    joined_rows AS (
      SELECT
        im.item,
        im.item_desc,
        im.item_status,
        COALESCE(rf.item_release_flag, '') AS item_release_flag
      FROM item_master_base im
      LEFT JOIN release_flag_base rf
        ON rf.item_key = UPPER(TRIM(im.item))
    ),
    filtered_rows AS (
      SELECT *
      FROM joined_rows
      WHERE @searchText = ''
         OR LOWER(CAST(${filterColumnExpr} AS STRING)) LIKE CONCAT('%', LOWER(@searchText), '%')
    ),
    counted_rows AS (
      SELECT *, COUNT(1) OVER() AS total_count
      FROM filtered_rows
    )
    SELECT
      item,
      item_desc,
      item_status,
      item_release_flag,
      total_count
    FROM counted_rows
    ORDER BY item
    LIMIT ${safePageSize}
    OFFSET ${safeOffset}
  `;

  const rows = await runQuery(query, { searchText });

  console.log("fetchItemMasterWithReleaseFlag rows:", rows.length);

  const total = rows.length ? Number(rows[0].total_count || 0) : 0;
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));

  return {
    data: rows.map((row) => ({
      item: normalizeText(row.item),
      item_desc: normalizeText(row.item_desc),
      item_status: normalizeText(row.item_status),
      item_release_flag: normalizeText(row.item_release_flag),
    })),
    pagination: {
      page: safePage,
      pageSize: safePageSize,
      total,
      totalPages,
      hasPrev: safePage > 1,
      hasNext: safePage < totalPages,
      filterBy: normalizedFilterBy,
      search: searchText,
    },
  };
};

/**
 * bom_produced from PostgreSQL + location_master from BigQuery PRD.
 */
export const fetchLocationsBySelectedItems = async (itemIds = []) => {
  const normalizedItemIds = Array.isArray(itemIds)
    ? itemIds.map((id) => normalizeText(id)).filter(Boolean)
    : [];

  if (!normalizedItemIds.length) return [];

  const producedRows = await runPgQuery(
    `
      SELECT DISTINCT
        CAST(item AS TEXT) AS item,
        CAST(location AS TEXT) AS location
      FROM ${pgTableRef(appConfig.postgres.tables.bomProduced)}
      WHERE TRIM(CAST(item AS TEXT)) = ANY($1::text[])
        AND COALESCE(TRIM(CAST(location AS TEXT)), '') <> ''
      ORDER BY CAST(item AS TEXT), CAST(location AS TEXT)
    `,
    [normalizedItemIds]
  );

  const locations = Array.from(new Set(producedRows.map((row) => normalizeText(row.location)).filter(Boolean)));
  if (!locations.length) return [];

  const locationRows = await runQuery(
    `
      SELECT
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
      FROM ${bqTableRefByKey(BQ_TABLE_KEYS.locationMaster)}
      WHERE UPPER(TRIM(CAST(location AS STRING))) IN UNNEST(@locations)
      ORDER BY location
    `,
    { locations: locations.map((location) => location.toUpperCase()) }
  );

  const locationMap = new Map(locationRows.map((row) => [normalizeUpper(row.location), row]));

  return producedRows.map((row) => ({
    ...row,
    ...(locationMap.get(normalizeUpper(row.location)) || {}),
  }));
};

export const fetchAllResourcesFromRoutingResCons = async () => {
  const columns = await getBigQueryTableColumns(BQ_TABLE_KEYS.resourceMaster);
  const resourceColumn = findColumn(columns, ["resource", "resource_id", "resourceId"]);
  if (!resourceColumn) {
    throw new Error(`${appConfig.bigQuery.tables.resourceMaster}.resource column does not exist`);
  }

  const relevancyColumn = findColumn(columns, ["resource_planning_relevance", "resource_relevancy"]);
  const relevancyExpr = relevancyColumn ? `COALESCE(CAST(${qCol(relevancyColumn)} AS STRING), '')` : `''`;

  const rows = await runQuery(`
    SELECT DISTINCT
      TRIM(CAST(${qCol(resourceColumn)} AS STRING)) AS resource,
      ${relevancyExpr} AS resource_planning_relevance
    FROM ${bqTableRefByKey(BQ_TABLE_KEYS.resourceMaster)}
    WHERE ${qCol(resourceColumn)} IS NOT NULL
      AND TRIM(CAST(${qCol(resourceColumn)} AS STRING)) != ''
    ORDER BY resource
  `);

  return rows.map((row) => ({
    resource: normalizeText(row.resource),
    resourcePlanningRelevance: pickFirstValue(row, ["resource_planning_relevance"]),
    resource_relevancy: pickFirstValue(row, ["resource_planning_relevance"]),
  }));
};

export const fetchItemReleaseFlagByItem = async (item) => {
  const columns = await getBigQueryTableColumns(BQ_TABLE_KEYS.itemReleaseFlag);
  const itemColumn = findColumn(columns, ["item", "item_id", "item_number", "itemNumber"]);
  const releaseColumn = findColumn(columns, [
    "release",
    "release_flag",
    "releaseflag",
    "item_releaseflag",
    "item_release_flag",
    "item_mrp_rls_flg",
    "planning_release_flag",
    "status",
  ]);

  if (!itemColumn || !releaseColumn) {
    return { item: normalizeText(item), itemReleaseFlag: "", release: "" };
  }

  const rows = await runQuery(
    `
      SELECT
        TRIM(CAST(${qCol(itemColumn)} AS STRING)) AS item,
        COALESCE(CAST(${qCol(releaseColumn)} AS STRING), '') AS release
      FROM ${bqTableRefByKey(BQ_TABLE_KEYS.itemReleaseFlag)}
      WHERE UPPER(TRIM(CAST(${qCol(itemColumn)} AS STRING))) = @item
      LIMIT 1
    `,
    { item: normalizeUpper(item) }
  );

  const row = rows?.[0] || {};
  return {
    item: normalizeText(item),
    itemReleaseFlag: pickFirstValue(row, ["release"]),
    release: pickFirstValue(row, ["release"]),
  };
};

export const fetchResourceRelevancyByResource = async (resource) => {
  const rows = await runQuery(
    `
      SELECT
        TRIM(CAST(resource AS STRING)) AS resource,
        COALESCE(CAST(resource_planning_relevance AS STRING), '') AS resource_planning_relevance
      FROM ${bqTableRefByKey(BQ_TABLE_KEYS.resourceMaster)}
      WHERE UPPER(TRIM(CAST(resource AS STRING))) = @resource
      LIMIT 1
    `,
    { resource: normalizeUpper(resource) }
  );

  const row = rows[0] || {};
  return {
    resource: normalizeText(row.resource),
    resourcePlanningRelevance: pickFirstValue(row, ["resource_planning_relevance"]),
  };
};

export const fetchBomIdsFromBomParameters = async () => {
  const tableName = appConfig.postgres.tables.bomParameters;
  const bomIdColumn = await getBomIdColumn(tableName);
  const rows = await runPgQuery(`
    SELECT DISTINCT TRIM(CAST(${quoteIdent(bomIdColumn)} AS TEXT)) AS "bomId"
    FROM ${pgTableRef(tableName)}
    WHERE ${quoteIdent(bomIdColumn)} IS NOT NULL
      AND TRIM(CAST(${quoteIdent(bomIdColumn)} AS TEXT)) <> ''
    ORDER BY "bomId"
  `);

  return rows.map((row) => ({ bomId: normalizeText(row.bomId) }));
};

export const fetchCoProductsByBomId = async (bomId) => {
  const tableName = appConfig.postgres.tables.bomConsumed;
  const columns = await getPostgresTableColumns(tableName);
  const itemColumn = findColumn(columns, ["item", "consumed_item", "component_item", "material_item"]);
  if (!itemColumn) return [];

  const bomIdColumn = await getBomIdColumn(tableName);
  const rows = await runPgQuery(
    `
      SELECT DISTINCT TRIM(CAST(${quoteIdent(itemColumn)} AS TEXT)) AS item
      FROM ${pgTableRef(tableName)}
      WHERE UPPER(TRIM(CAST(${quoteIdent(bomIdColumn)} AS TEXT))) = $1
        AND ${quoteIdent(itemColumn)} IS NOT NULL
        AND TRIM(CAST(${quoteIdent(itemColumn)} AS TEXT)) <> ''
      ORDER BY item
    `,
    [normalizeUpper(bomId)]
  );

  return rows.map((row) => ({ item: normalizeText(row.item) }));
};

export const fetchItemDetailsForPostgres = async (itemResourceRows = []) => {
  const cleanedRows = Array.from(
    new Map(
      (Array.isArray(itemResourceRows) ? itemResourceRows : [])
        .map((row) => {
          const item = normalizeText(row?.item);
          const resource = normalizeText(row?.resource);
          if (!item) return null;
          return [normalizeUpper(item), { item, resource }];
        })
        .filter(Boolean)
    ).values()
  );

  if (!cleanedRows.length) return [];

  const itemMasterColumns = await getBigQueryTableColumns(BQ_TABLE_KEYS.itemMaster);
  const releaseFlagColumns = await getBigQueryTableColumns(BQ_TABLE_KEYS.itemReleaseFlag);
  const resourceMasterColumns = await getBigQueryTableColumns(BQ_TABLE_KEYS.resourceMaster);

  const itemMasterItemColumn = findColumn(itemMasterColumns, [
    "item",
    "item_id",
    "item_number",
    "itemNumber",
  ]);

  const itemDescColumn = findColumn(itemMasterColumns, [
    "item_description",
    "item_desc",
    "item_desc_1",
    "description",
  ]);

  const releaseItemColumn = findColumn(releaseFlagColumns, [
    "item",
    "item_id",
    "item_number",
    "itemNumber",
  ]);

  const releaseColumn = findColumn(releaseFlagColumns, [
    "release",
    "release_flag",
    "releaseflag",
    "item_release_flag",
    "item_releaseflag",
    "item_mrp_rls_flg",
    "planning_release_flag",
    "status",
  ]);

  const resourceColumn = findColumn(resourceMasterColumns, [
    "resource",
    "resource_id",
    "resource_number",
    "resourceNumber",
  ]);

  const resourceRelevancyColumn = findColumn(resourceMasterColumns, [
    "resource_planning_relevance",
    "resource_relevancy",
    "planning_relevance",
    "resource_relevance",
  ]);

  if (!itemMasterItemColumn) {
    throw new Error(`${appConfig.bigQuery.tables.itemMaster}: item column not found`);
  }

  const itemDescriptionExpr = itemDescColumn
    ? `ANY_VALUE(COALESCE(CAST(${qCol(itemDescColumn)} AS STRING), ''))`
    : `''`;

  const releaseFlagCte =
    releaseItemColumn && releaseColumn
      ? `
    item_release_data AS (
      SELECT
        UPPER(TRIM(CAST(${qCol(releaseItemColumn)} AS STRING))) AS item_key,
        ANY_VALUE(COALESCE(CAST(${qCol(releaseColumn)} AS STRING), '')) AS item_release_flag
      FROM ${bqTableRefByKey(BQ_TABLE_KEYS.itemReleaseFlag)}
      WHERE ${qCol(releaseItemColumn)} IS NOT NULL
        AND TRIM(CAST(${qCol(releaseItemColumn)} AS STRING)) != ''
      GROUP BY item_key
    ),`
      : `
    item_release_data AS (
      SELECT
        CAST(NULL AS STRING) AS item_key,
        CAST(NULL AS STRING) AS item_release_flag
      FROM UNNEST([]) AS empty_rows
    ),`;

  const resourceMasterCte =
    resourceColumn && resourceRelevancyColumn
      ? `
    resource_master_data AS (
      SELECT
        UPPER(TRIM(CAST(${qCol(resourceColumn)} AS STRING))) AS resource_key,
        ANY_VALUE(COALESCE(CAST(${qCol(resourceRelevancyColumn)} AS STRING), '')) AS resource_relevancy
      FROM ${bqTableRefByKey(BQ_TABLE_KEYS.resourceMaster)}
      WHERE ${qCol(resourceColumn)} IS NOT NULL
        AND TRIM(CAST(${qCol(resourceColumn)} AS STRING)) != ''
      GROUP BY resource_key
    )`
      : `
    resource_master_data AS (
      SELECT
        CAST(NULL AS STRING) AS resource_key,
        CAST(NULL AS STRING) AS resource_relevancy
      FROM UNNEST([]) AS empty_rows
    )`;

  const query = `
    WITH requested_items AS (
      SELECT
        TRIM(CAST(row.item AS STRING)) AS item,
        UPPER(TRIM(CAST(row.item AS STRING))) AS item_key,
        TRIM(CAST(row.resource AS STRING)) AS resource,
        UPPER(TRIM(CAST(row.resource AS STRING))) AS resource_key
      FROM UNNEST(@itemResourceRows) AS row
      WHERE row.item IS NOT NULL
        AND TRIM(CAST(row.item AS STRING)) != ''
    ),
    item_master_data AS (
      SELECT
        UPPER(TRIM(CAST(${qCol(itemMasterItemColumn)} AS STRING))) AS item_key,
        ${itemDescriptionExpr} AS item_description
      FROM ${bqTableRefByKey(BQ_TABLE_KEYS.itemMaster)}
      WHERE ${qCol(itemMasterItemColumn)} IS NOT NULL
        AND TRIM(CAST(${qCol(itemMasterItemColumn)} AS STRING)) != ''
      GROUP BY item_key
    ),
    ${releaseFlagCte}
    ${resourceMasterCte}
    SELECT
      ri.item,
      COALESCE(im.item_description, '') AS item_description,
      COALESCE(ird.item_release_flag, '') AS item_release_flag,
      COALESCE(rm.resource_relevancy, '') AS resource_relevancy
    FROM requested_items ri
    LEFT JOIN item_master_data im
      ON im.item_key = ri.item_key
    LEFT JOIN item_release_data ird
      ON ird.item_key = ri.item_key
    LEFT JOIN resource_master_data rm
      ON rm.resource_key = ri.resource_key
    ORDER BY ri.item
  `;

  console.log("fetchItemDetailsForPostgres query:");
  console.log(query);

  const rows = await runQuery(query, { itemResourceRows: cleanedRows });

  return rows.map((row) => ({
    item: normalizeText(row.item),
    item_description: pickFirstValue(row, ["item_description"]),
    resource_relevancy: pickFirstValue(row, ["resource_relevancy"]),
    item_release_flag: pickFirstValue(row, ["item_release_flag"]),
  }));
};

export const fetchBomDetailsByBomId = async (bomId) => {
  const tableName = appConfig.postgres.tables.bomProduced;
  const bomIdColumn = await getBomIdColumn(tableName);

  const producedRows = await runPgQuery(
    `
      SELECT
        CAST(bp.${quoteIdent(bomIdColumn)} AS TEXT) AS bom_id,
        CAST(bp.item AS TEXT) AS item,
        CAST(bp.location AS TEXT) AS location,
        CAST(bp.erp_bom_qty_produced_per AS TEXT) AS qty_produced_per
      FROM ${pgTableRef(tableName)} bp
      WHERE UPPER(TRIM(CAST(bp.${quoteIdent(bomIdColumn)} AS TEXT))) = $1
      ORDER BY
        CASE
          WHEN CAST(bp.erp_bom_qty_produced_per AS TEXT) IN ('1', '1.0', '1.00') THEN 0
          ELSE 1
        END,
        CAST(bp.item AS TEXT)
      LIMIT 1
    `,
    [normalizeUpper(bomId)]
  );

  const producedRow = producedRows[0];
  if (!producedRow) {
    const bomParts = normalizeText(bomId).split("_");
    const fallbackProducedItem = bomParts.length >= 2 ? bomParts[1] : "";
    const fallbackLocation = bomParts.length >= 3 ? bomParts.slice(2).join("_") : "";
    let itemReleaseFlag = "";
    if (fallbackProducedItem) {
      const releaseData = await fetchItemReleaseFlagByItem(fallbackProducedItem);
      itemReleaseFlag = releaseData?.itemReleaseFlag || "";
    }
    return { bomId: normalizeText(bomId), producedItem: fallbackProducedItem, location: fallbackLocation, itemReleaseFlag };
  }

  const producedItem = normalizeText(producedRow.item);
  const location = normalizeText(producedRow.location);
  let itemReleaseFlag = "";
  if (producedItem) {
    const releaseData = await fetchItemReleaseFlagByItem(producedItem);
    itemReleaseFlag = releaseData?.itemReleaseFlag || "";
  }

  return { bomId: normalizeText(bomId), producedItem, location, itemReleaseFlag };
};

export const fetchCoProductsByItem = async (item) => {
  const tableName = appConfig.postgres.tables.itemBomRouting;
  const columns = await getPostgresTableColumns(tableName);
  const associationColumn = findColumn(columns, ["erp_co_product_association", "co_product_association"]);
  const itemColumn = findColumn(columns, ["item", "produced_item", "erp_parent_item", "main_item"]);

  if (!associationColumn || !itemColumn) return [];

  const rows = await runPgQuery(`
    SELECT DISTINCT TRIM(CAST(${quoteIdent(itemColumn)} AS TEXT)) AS item
    FROM ${pgTableRef(tableName)}
    WHERE COALESCE(NULLIF(TRIM(CAST(${quoteIdent(associationColumn)} AS TEXT)), ''), '0') IN ('1', 'true', 'TRUE', 'Y', 'y')
      AND ${quoteIdent(itemColumn)} IS NOT NULL
      AND TRIM(CAST(${quoteIdent(itemColumn)} AS TEXT)) <> ''
    ORDER BY item
  `);

  return rows.map((row) => ({ item: normalizeText(row.item) })).filter((row) => row.item !== normalizeText(item));
};

const fetchAllDistinctResources = async () => {
  return runQuery(`
    SELECT DISTINCT TRIM(CAST(resource AS STRING)) AS resource
    FROM ${bqTableRefByKey(BQ_TABLE_KEYS.routingRescons)}
    WHERE resource IS NOT NULL
      AND TRIM(CAST(resource AS STRING)) != ''
    ORDER BY resource
  `);
};

export const fetchResourceComponentMetadata = async (items = [], locations = []) => {
  const resourceRows = await fetchAllResourcesFromRoutingResCons();
  const resourceOptions = [];
  const seenResources = new Set();

  for (const row of resourceRows) {
    const resourceValue = normalizeText(row.resource);
    const resourceKey = normalizeUpper(resourceValue);
    if (!resourceKey || seenResources.has(resourceKey)) continue;
    seenResources.add(resourceKey);
    resourceOptions.push({
      resource: resourceValue,
      resourcePlanningRelevance: row.resourcePlanningRelevance ?? row.resource_planning_relevance ?? row.resource_relevancy ?? "",
      resource_relevancy: row.resource_relevancy ?? row.resourcePlanningRelevance ?? row.resource_planning_relevance ?? "",
    });
  }

  const bomVersions = ["PRIMARY", ...Array.from({ length: 20 }, (_, index) => `BOM${index + 1}`)];
  return {
    bomVersions,
    resourceOptions,
    itemOptions: [],
    selectedItems: Array.isArray(items) ? items : [],
    selectedLocations: Array.isArray(locations) ? locations : [],
  };
};

export const fetchExistingBomSearchRows = async () => {
  const producedRows = await runPgQuery(`
    WITH ranked_produced AS (
      SELECT
        CAST(bp.bom_id AS TEXT) AS bom_id,
        CAST(bp.item AS TEXT) AS produced_item,
        CAST(bp.location AS TEXT) AS location,
        CAST(bp.erp_bom_qty_produced_per AS TEXT) AS qty_produced_per,
        ROW_NUMBER() OVER (
          PARTITION BY CAST(bp.bom_id AS TEXT)
          ORDER BY
            CASE
              WHEN CAST(bp.erp_bom_qty_produced_per AS TEXT) IN ('1', '1.0', '1.00') THEN 0
              ELSE 1
            END,
            CAST(bp.item AS TEXT)
        ) AS rn
      FROM ${pgTableRef(appConfig.postgres.tables.bomProduced)} bp
      WHERE bp.bom_id IS NOT NULL
    )
    SELECT bom_id, produced_item, location, qty_produced_per
    FROM ranked_produced
    WHERE rn = 1
    ORDER BY bom_id
  `);

  const routingRows = await runPgQuery(`
    SELECT
      CAST(ibr.bom_id AS TEXT) AS bom_id,
      CAST(ibr.routing_id AS TEXT) AS routing_id
    FROM ${pgTableRef(appConfig.postgres.tables.itemBomRouting)} ibr
    WHERE ibr.routing_id IS NOT NULL
      AND TRIM(CAST(ibr.routing_id AS TEXT)) <> ''
  `);

  const producedItems = Array.from(new Set(producedRows.map((row) => normalizeUpper(row.produced_item)).filter(Boolean)));
  const routingIds = Array.from(new Set(routingRows.map((row) => normalizeUpper(row.routing_id)).filter(Boolean)));

  const itemMasterRows = producedItems.length
    ? await runQuery(
      `
          SELECT *
          FROM ${bqTableRefByKey(BQ_TABLE_KEYS.itemMaster)}
          WHERE UPPER(TRIM(CAST(item AS STRING))) IN UNNEST(@items)
        `,
      { items: producedItems }
    )
    : [];

  const releaseFlagRows = producedItems.length
    ? await runQuery(
      `
          SELECT *
          FROM ${bqTableRefByKey(BQ_TABLE_KEYS.itemReleaseFlag)}
          WHERE UPPER(TRIM(CAST(item AS STRING))) IN UNNEST(@items)
        `,
      { items: producedItems }
    )
    : [];

  const resourceRows = routingIds.length
    ? await runQuery(
      `
          SELECT *
          FROM ${bqTableRefByKey(BQ_TABLE_KEYS.routingRescons)}
          WHERE UPPER(TRIM(CAST(routing_id AS STRING))) IN UNNEST(@routingIds)
        `,
      { routingIds }
    )
    : [];

  const itemDescMap = new Map();
  for (const row of itemMasterRows) {
    const key = normalizeUpper(row.item);
    if (!key) continue;
    itemDescMap.set(key, pickFirstValue(row, ["item_description", "item_desc", "description", "item_desc_1"]));
  }

  const releaseFlagMap = new Map();
  for (const row of releaseFlagRows) {
    const key = normalizeUpper(row.item);
    if (!key) continue;
    releaseFlagMap.set(
      key,
      pickFirstValue(row, ["release", "release_flag", "releaseflag", "item_releaseflag", "item_release_flag", "item_mrp_rls_flg", "planning_release_flag", "status"])
    );
  }

  const resourceByRoutingId = new Map();
  for (const row of resourceRows) {
    const key = normalizeUpper(row.routing_id);
    if (!key) continue;
    resourceByRoutingId.set(key, pickFirstValue(row, ["resource"]));
  }

  const routingByBomId = new Map();
  for (const row of routingRows) {
    const bomId = normalizeText(row.bom_id);
    if (!bomId) continue;
    if (!routingByBomId.has(bomId)) routingByBomId.set(bomId, []);
    routingByBomId.get(bomId).push(row);
  }

  const result = [];
  for (const bp of producedRows) {
    const bomId = normalizeText(bp.bom_id);
    const producedItem = normalizeText(bp.produced_item);
    const itemKey = normalizeUpper(producedItem);
    const matchingRoutingRows = routingByBomId.get(bomId) || [];

    if (!matchingRoutingRows.length) {
      result.push({
        id: `${bomId}__NOROUTING`,
        location: normalizeText(bp.location),
        produced_item: producedItem,
        produced_item_desc: itemDescMap.get(itemKey) || "",
        bom_id: bomId,
        resource: "",
        item_release_flag: releaseFlagMap.get(itemKey) || "",
        routing_id: "",
      });
      continue;
    }

    for (const rt of matchingRoutingRows) {
      const routingId = normalizeText(rt.routing_id);
      result.push({
        id: `${bomId}__${routingId || "ROW"}`,
        location: normalizeText(bp.location),
        produced_item: producedItem,
        produced_item_desc: itemDescMap.get(itemKey) || "",
        bom_id: bomId,
        resource: resourceByRoutingId.get(normalizeUpper(routingId)) || "",
        item_release_flag: releaseFlagMap.get(itemKey) || "",
        routing_id: routingId,
      });
    }
  }

  return result.sort((a, b) => String(a.bom_id).localeCompare(String(b.bom_id)) || String(a.resource).localeCompare(String(b.resource)));
};
