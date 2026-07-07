import bigquery from "../db/bigqueryClient.js";
import pool from "../db/postgresClient.js";
import appConfig from "../config/appConfig.js";

/* =========================================================
  Source rules
  - BOM core tables are fetched from PostgreSQL.
  - item_mrp_rls_flg / itemReleaseFlag is fetched from BigQuery.
  - Master/reference tables are fetched from BigQuery.
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

const BIGQUERY_DYNAMIC_TABLE_KEYS = new Set([
  BQ_TABLE_KEYS.itemMaster,
  BQ_TABLE_KEYS.itemReleaseFlag,
  BQ_TABLE_KEYS.locationMaster,
  BQ_TABLE_KEYS.routingRescons,
  BQ_TABLE_KEYS.resourceMaster,
]);

const getBigQueryDynamicTableKeyByName = (tableName) => {
  const normalizedTableName = String(tableName || "").trim();
  if (!normalizedTableName) return "";

  const matchedEntry = Object.entries(appConfig.bigQuery.tables || {}).find(
    ([, configuredTableName]) => String(configuredTableName || "").trim() === normalizedTableName
  );

  if (!matchedEntry) return "";

  const [tableKey] = matchedEntry;
  return BIGQUERY_DYNAMIC_TABLE_KEYS.has(tableKey) ? tableKey : "";
};

const IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

const assertSafeIdentifier = (value, label) => {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`Missing identifier for ${label}`);
  if (!IDENTIFIER_REGEX.test(normalized)) {
    throw new Error(`Invalid identifier for ${label}: ${normalized}`);
  }
  return normalized;
};

const quoteIdent = (value) => `"${String(value).replace(/"/g, '""')}"`;
const qCol = (columnName) => `\`${String(columnName).replace(/`/g, "")}\``;

const PG_SCHEMA = assertSafeIdentifier(
  appConfig.postgres.schema || "planning_bom",
  "postgres.schema"
);

const pgTableRef = (tableName) => {
  return `${quoteIdent(PG_SCHEMA)}.${quoteIdent(assertSafeIdentifier(tableName, "postgres.table"))}`;
};

const getBigQueryDatasetId = () => {
  const dataset = appConfig.bigQuery.datasetId;
  return assertSafeIdentifier(dataset, "bigQuery.datasetId");
};

const getBigQueryProjectId = (tableKey) => {
  const sourceMap = {
    bomParameters: "dev",
    bomProduced: "dev",
    bomConsumed: "dev",
    itemBomRouting: "dev",
    itemReleaseFlag: "dev",
    itemMaster: "dev",
    locationMaster: "dev",
    routingRescons: "dev",
    resourceMaster: "dev",
  };

  const source = sourceMap[tableKey] || "dev";
  const projectId = appConfig.bigQuery.projectIds?.[source] || appConfig.bigQuery.projectId;
  if (!projectId) {
    throw new Error(`BigQuery projectId for source '${source}' is missing in appConfig.js`);
  }
  return String(projectId).trim();
};

const getBQTableNameByKey = (tableKey) => {
  const tableName = appConfig.bigQuery.tables?.[tableKey];
  return assertSafeIdentifier(tableName, `bigQuery.tables.${tableKey}`);
};

const bqTableRefByKey = (tableKey) => {
  const projectId = getBigQueryProjectId(tableKey).replace(/`/g, "");
  const dataset = getBigQueryDatasetId();
  const tableName = getBQTableNameByKey(tableKey);
  return `\`${projectId}.${dataset}.${tableName}\``;
};

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

const getBigQueryTableColumns = async (tableKey) => {
  const projectId = getBigQueryProjectId(tableKey).replace(/`/g, "");
  const dataset = getBigQueryDatasetId();
  const tableName = getBQTableNameByKey(tableKey);

  const rows = await runQuery(
    `
      SELECT column_name
      FROM \`${projectId}.${dataset}.INFORMATION_SCHEMA.COLUMNS\`
      WHERE table_name = @tableName
      ORDER BY ordinal_position
    `,
    { tableName }
  );

  return rows.map((row) => String(row.column_name || "").trim());
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

const findColumn = (columns, candidates = []) => {
  const columnMap = new Map(
    columns.map((column) => [String(column).toLowerCase(), column])
  );

  for (const candidate of candidates) {
    const matched = columnMap.get(String(candidate).toLowerCase());
    if (matched) return matched;
  }

  return "";
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

const addPgParam = (params, value) => {
  params.push(value);
  return `$${params.length}`;
};

const EXISTING_BOM_SEARCH_FIELDS = new Set([
  "",
  "location",
  "produced_item",
  "produced_item_desc",
  "bom_id",
  "resource",
  "item_release_flag",
]);

const normalizeExistingBomSearchField = (field) => {
  const value = String(field || "").trim();
  return EXISTING_BOM_SEARCH_FIELDS.has(value) ? value : "";
};

const getItemsByDescriptionForExistingBom = async (queryText) => {
  const q = normalizeUpper(queryText);
  if (!q) return [];

  const columns = await getBigQueryTableColumns(BQ_TABLE_KEYS.itemMaster);
  const itemColumn = findColumn(columns, ["item", "item_id", "item_number", "itemNumber"]);
  const descColumn = findColumn(columns, [
    "item_description",
    "item_desc",
    "description",
    "item_desc_1",
  ]);

  if (!itemColumn || !descColumn) return [];

  const rows = await runQuery(
    `
      SELECT DISTINCT UPPER(TRIM(CAST(${qCol(itemColumn)} AS STRING))) AS item
      FROM ${bqTableRefByKey(BQ_TABLE_KEYS.itemMaster)}
      WHERE UPPER(TRIM(CAST(${qCol(descColumn)} AS STRING))) = @q
    `,
    { q }
  );

  return rows.map((row) => normalizeUpper(row.item)).filter(Boolean);
};

const getItemsByReleaseFlagForExistingBom = async (queryText) => {
  const q = normalizeUpper(queryText);
  if (!q) return [];

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

  if (!itemColumn || !releaseColumn) return [];

  const rows = await runQuery(
    `
      SELECT DISTINCT UPPER(TRIM(CAST(${qCol(itemColumn)} AS STRING))) AS item
      FROM ${bqTableRefByKey(BQ_TABLE_KEYS.itemReleaseFlag)}
      WHERE UPPER(TRIM(CAST(${qCol(releaseColumn)} AS STRING))) = @q
    `,
    { q }
  );

  return rows.map((row) => normalizeUpper(row.item)).filter(Boolean);
};

const getRoutingIdsByResourceForExistingBom = async (queryText) => {
  const q = normalizeUpper(queryText);
  if (!q) return [];

  const columns = await getBigQueryTableColumns(BQ_TABLE_KEYS.routingRescons);
  const routingColumn = findColumn(columns, ["routing_id", "routingId", "routing"]);
  const resourceColumn = findColumn(columns, ["resource", "resource_id", "resourceId"]);

  if (!routingColumn || !resourceColumn) return [];

  const rows = await runQuery(
    `
      SELECT DISTINCT UPPER(TRIM(CAST(${qCol(routingColumn)} AS STRING))) AS routing_id
      FROM ${bqTableRefByKey(BQ_TABLE_KEYS.routingRescons)}
      WHERE UPPER(TRIM(CAST(${qCol(resourceColumn)} AS STRING))) = @q
    `,
    { q }
  );

  return rows.map((row) => normalizeUpper(row.routing_id)).filter(Boolean);
};

export const fetchExistingBomSearchRows = async ({
  page = 1,
  pageSize = 50,
  searchBy1 = "resource",
  query1 = "",
  searchBy2 = "location",
  query2 = "",
} = {}) => {
  const safePage = Math.max(1, Number.parseInt(page, 10) || 1);
  const safePageSize = Math.min(200, Math.max(1, Number.parseInt(pageSize, 10) || 50));
  const safeOffset = (safePage - 1) * safePageSize;

  const normalizedSearchBy1 = normalizeExistingBomSearchField(searchBy1);
  const normalizedSearchBy2 = normalizeExistingBomSearchField(searchBy2);
  const normalizedQuery1 = normalizeText(query1);
  const normalizedQuery2 = normalizeText(query2);

  const pgParams = [];
  const pgFilters = [];

  const appendSearchFilter = async (field, value) => {
    const q = normalizeText(value);
    if (!field || !q) return false;

    const upperQ = normalizeUpper(q);

    if (field === "location") {
      pgFilters.push(`UPPER(TRIM(CAST(base.location AS TEXT))) = ${addPgParam(pgParams, upperQ)}`);
      return false;
    }

    if (field === "produced_item") {
      pgFilters.push(`UPPER(TRIM(CAST(base.produced_item AS TEXT))) = ${addPgParam(pgParams, upperQ)}`);
      return false;
    }

    if (field === "bom_id") {
      pgFilters.push(`UPPER(TRIM(CAST(base.bom_id AS TEXT))) = ${addPgParam(pgParams, upperQ)}`);
      return false;
    }

    if (field === "produced_item_desc") {
      const items = await getItemsByDescriptionForExistingBom(q);
      if (!items.length) return true;
      pgFilters.push(`UPPER(TRIM(CAST(base.produced_item AS TEXT))) = ANY(${addPgParam(pgParams, items)})`);
      return false;
    }

    if (field === "item_release_flag") {
      const items = await getItemsByReleaseFlagForExistingBom(q);
      if (!items.length) return true;
      pgFilters.push(`UPPER(TRIM(CAST(base.produced_item AS TEXT))) = ANY(${addPgParam(pgParams, items)})`);
      return false;
    }

    if (field === "resource") {
      const routingIds = await getRoutingIdsByResourceForExistingBom(q);
      if (!routingIds.length) return true;
      pgFilters.push(`UPPER(TRIM(CAST(base.routing_id AS TEXT))) = ANY(${addPgParam(pgParams, routingIds)})`);
      return false;
    }

    return false;
  };

  const forceNoRows1 = await appendSearchFilter(normalizedSearchBy1, normalizedQuery1);
  const forceNoRows2 = await appendSearchFilter(normalizedSearchBy2, normalizedQuery2);

  if (forceNoRows1 || forceNoRows2) {
    return {
      data: [],
      pagination: {
        page: safePage,
        pageSize: safePageSize,
        total: 0,
        totalPages: 1,
        hasPrev: false,
        hasNext: false,
        searchBy1: normalizedSearchBy1,
        query1: normalizedQuery1,
        searchBy2: normalizedSearchBy2,
        query2: normalizedQuery2,
      },
    };
  }

  const whereClause = pgFilters.length ? `WHERE ${pgFilters.join(" AND ")}` : "";
  const limitParam = addPgParam(pgParams, safePageSize);
  const offsetParam = addPgParam(pgParams, safeOffset);

  const pageRows = await runPgQuery(
    `
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
      ),
      base_rows AS (
        SELECT
          rp.bom_id,
          rp.produced_item,
          rp.location,
          rp.qty_produced_per,
          CAST(ibr.routing_id AS TEXT) AS routing_id
        FROM ranked_produced rp
        LEFT JOIN ${pgTableRef(appConfig.postgres.tables.itemBomRouting)} ibr
          ON CAST(ibr.bom_id AS TEXT) = rp.bom_id
         AND ibr.routing_id IS NOT NULL
         AND TRIM(CAST(ibr.routing_id AS TEXT)) <> ''
        WHERE rp.rn = 1
      ),
      filtered_rows AS (
        SELECT base.*
        FROM base_rows base
        ${whereClause}
      ),
      counted_rows AS (
        SELECT *, COUNT(1) OVER() AS total_count
        FROM filtered_rows
      )
      SELECT
        bom_id,
        produced_item,
        location,
        qty_produced_per,
        routing_id,
        total_count
      FROM counted_rows
      ORDER BY bom_id, routing_id NULLS LAST
      LIMIT ${limitParam}
      OFFSET ${offsetParam}
    `,
    pgParams
  );

  const total = pageRows.length ? Number(pageRows[0].total_count || 0) : 0;
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));

  const producedItems = Array.from(
    new Set(pageRows.map((row) => normalizeUpper(row.produced_item)).filter(Boolean))
  );

  const routingIds = Array.from(
    new Set(pageRows.map((row) => normalizeUpper(row.routing_id)).filter(Boolean))
  );

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
    itemDescMap.set(
      key,
      pickFirstValue(row, ["item_description", "item_desc", "description", "item_desc_1"])
    );
  }

  const releaseFlagMap = new Map();
  for (const row of releaseFlagRows) {
    const key = normalizeUpper(row.item);
    if (!key) continue;
    releaseFlagMap.set(
      key,
      pickFirstValue(row, [
        "release",
        "release_flag",
        "releaseflag",
        "item_releaseflag",
        "item_release_flag",
        "item_mrp_rls_flg",
        "planning_release_flag",
        "status",
      ])
    );
  }

  const resourceByRoutingId = new Map();
  for (const row of resourceRows) {
    const key = normalizeUpper(row.routing_id);
    if (!key) continue;
    resourceByRoutingId.set(key, pickFirstValue(row, ["resource"]));
  }

  const data = pageRows.map((row, index) => {
    const bomId = normalizeText(row.bom_id);
    const producedItem = normalizeText(row.produced_item);
    const itemKey = normalizeUpper(producedItem);
    const routingId = normalizeText(row.routing_id);

    return {
      id: `${bomId}__${routingId || "NOROUTING"}__${safeOffset + index}`,
      location: normalizeText(row.location),
      produced_item: producedItem,
      produced_item_desc: itemDescMap.get(itemKey) || "",
      bom_id: bomId,
      resource: resourceByRoutingId.get(normalizeUpper(routingId)) || "",
      item_release_flag: releaseFlagMap.get(itemKey) || "",
      routing_id: routingId,
    };
  });

  return {
    data,
    pagination: {
      page: safePage,
      pageSize: safePageSize,
      total,
      totalPages,
      hasPrev: safePage > 1,
      hasNext: safePage < totalPages,
      searchBy1: normalizedSearchBy1,
      query1: normalizedQuery1,
      searchBy2: normalizedSearchBy2,
      query2: normalizedQuery2,
    },
  };
};

const fetchFromBigQueryDynamicTable = async (tableKey, filters = {}, limit = null) => {
  const params = {};
  const conditions = [];
  let paramIndex = 0;

  Object.entries(filters || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || String(value).trim() === "") return;
    const safeColumn = assertSafeIdentifier(key, "bigQuery.column");
    const paramName = `p${paramIndex++}`;
    conditions.push(`CAST(${qCol(safeColumn)} AS STRING) = @${paramName}`);
    params[paramName] = String(value).trim();
  });

  let query = `SELECT * FROM ${bqTableRefByKey(tableKey)}`;
  if (conditions.length) query += ` WHERE ${conditions.join(" AND ")}`;

  if (limit !== null && limit !== undefined && Number(limit) > 0) {
    query += ` LIMIT ${Math.floor(Number(limit))}`;
  }

  return runQuery(query, params);
};

export const fetchFromTable = async (tableName, filters = {}, limit = null) => {
  const safeTableName = assertSafeIdentifier(tableName, "dynamic.table");
  const bigQueryTableKey = getBigQueryDynamicTableKeyByName(safeTableName);

  if (bigQueryTableKey) {
    return fetchFromBigQueryDynamicTable(bigQueryTableKey, filters, limit);
  }

  const params = [];
  const conditions = [];

  Object.entries(filters || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || String(value).trim() === "") return;
    conditions.push(`CAST(${quoteIdent(key)} AS TEXT) = $${params.length + 1}`);
    params.push(String(value));
  });

  let query = `SELECT * FROM ${pgTableRef(safeTableName)}`;
  if (conditions.length) query += ` WHERE ${conditions.join(" AND ")}`;
  if (limit !== null && limit !== undefined && Number(limit) > 0) {
    query += ` LIMIT ${Math.floor(Number(limit))}`;
  }

  return runPgQuery(query, params);
};

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

  const itemMasterColumns = await getBigQueryTableColumns(BQ_TABLE_KEYS.itemMaster);
  const releaseFlagColumns = await getBigQueryTableColumns(BQ_TABLE_KEYS.itemReleaseFlag);

  const itemColumn = findColumn(itemMasterColumns, ["item", "item_id", "item_number", "itemNumber"]);
  const itemDescColumn = findColumn(itemMasterColumns, ["item_desc", "item_description", "description", "item_desc_1"]);
  const itemStatusColumn = findColumn(itemMasterColumns, ["item_status", "status"]);
  const releaseItemColumn = findColumn(releaseFlagColumns, ["item", "item_id", "item_number", "itemNumber"]);
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

  if (!itemColumn) throw new Error(`${appConfig.bigQuery.tables.itemMaster}: item column not found`);

  const itemDescExpr = itemDescColumn ? `COALESCE(CAST(im.${qCol(itemDescColumn)} AS STRING), '')` : `''`;
  const itemStatusExpr = itemStatusColumn ? `COALESCE(CAST(im.${qCol(itemStatusColumn)} AS STRING), '')` : `''`;

  const releaseFlagCte = releaseItemColumn && releaseColumn
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
        SELECT CAST(NULL AS STRING) AS item_key, CAST(NULL AS STRING) AS item_release_flag
        FROM UNNEST([]) AS empty_rows
      ),`;

  const filterColumnExprMap = {
    item: "item",
    item_description: "item_desc",
    status: "item_status",
    releaseflag: "item_release_flag",
  };
  const filterColumnExpr = filterColumnExprMap[String(filterBy || "item").trim()] || "item";

  const rows = await runQuery(
    `
      WITH item_master_base AS (
        SELECT
          TRIM(CAST(im.${qCol(itemColumn)} AS STRING)) AS item,
          ${itemDescExpr} AS item_desc,
          ${itemStatusExpr} AS item_status
        FROM ${bqTableRefByKey(BQ_TABLE_KEYS.itemMaster)} im
        WHERE im.${qCol(itemColumn)} IS NOT NULL
          AND TRIM(CAST(im.${qCol(itemColumn)} AS STRING)) != ''
          AND UPPER(TRIM(CAST(im.${qCol(itemColumn)} AS STRING))) LIKE 'HRL%'
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
      SELECT item, item_desc, item_status, item_release_flag, total_count
      FROM counted_rows
      ORDER BY item
      LIMIT ${safePageSize}
      OFFSET ${safeOffset}
    `,
    { searchText }
  );

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
      filterBy,
      search: searchText,
    },
  };
};

export const fetchLocationsBySelectedItems = async () => {
  return runQuery(
    `
      SELECT
        CAST(location AS STRING) AS location,
        COALESCE(CAST(location_description AS STRING), '') AS location_description,
        COALESCE(CAST(location_status AS STRING), '') AS location_status
      FROM ${bqTableRefByKey(BQ_TABLE_KEYS.locationMaster)}
      WHERE location IS NOT NULL
      ORDER BY location
    `
  );
};

export const fetchAllResourcesFromRoutingResCons = async () => {
  const rows = await runQuery(
    `
      SELECT DISTINCT
        TRIM(CAST(resource AS STRING)) AS resource,
        COALESCE(CAST(resource_planning_relevance AS STRING), '') AS resource_planning_relevance
      FROM ${bqTableRefByKey(BQ_TABLE_KEYS.resourceMaster)}
      WHERE resource IS NOT NULL
        AND TRIM(CAST(resource AS STRING)) != ''
      ORDER BY resource
    `
  );

  return rows.map((row) => ({
    resource: normalizeText(row.resource),
    resourcePlanningRelevance: pickFirstValue(row, ["resource_planning_relevance"]),
    resource_relevancy: pickFirstValue(row, ["resource_planning_relevance"]),
  }));
};

export const fetchItemReleaseFlagByItem = async (item) => {
  const columns = await getBigQueryTableColumns(BQ_TABLE_KEYS.itemReleaseFlag);
  const itemColumn = findColumn(columns, ["item", "item_id", "item_number", "itemNumber"]);
  const releaseColumn = findColumn(columns, ["release", "release_flag", "releaseflag", "item_releaseflag", "item_release_flag", "item_mrp_rls_flg", "planning_release_flag", "status"]);

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

  const row = rows[0] || {};
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
  const rows = await runPgQuery(
    `
      SELECT DISTINCT TRIM(CAST(bom_id AS TEXT)) AS "bomId"
      FROM ${pgTableRef(tableName)}
      WHERE bom_id IS NOT NULL
        AND TRIM(CAST(bom_id AS TEXT)) <> ''
      ORDER BY "bomId"
    `
  );

  return rows.map((row) => ({ bomId: normalizeText(row.bomId) }));
};

export const fetchCoProductsByBomId = async (bomId) => {
  const tableName = appConfig.postgres.tables.bomConsumed;
  const columns = await getPostgresTableColumns(tableName);
  const itemColumn = findColumn(columns, ["item", "consumed_item", "component_item", "material_item"]);
  if (!itemColumn) return [];

  const rows = await runPgQuery(
    `
      SELECT DISTINCT TRIM(CAST(${quoteIdent(itemColumn)} AS TEXT)) AS item
      FROM ${pgTableRef(tableName)}
      WHERE UPPER(TRIM(CAST(bom_id AS TEXT))) = $1
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

  const itemMasterRows = await runQuery(
    `
      SELECT *
      FROM ${bqTableRefByKey(BQ_TABLE_KEYS.itemMaster)}
      WHERE UPPER(TRIM(CAST(item AS STRING))) IN UNNEST(@items)
    `,
    { items: cleanedRows.map((row) => normalizeUpper(row.item)) }
  );

  const releaseRows = await runQuery(
    `
      SELECT *
      FROM ${bqTableRefByKey(BQ_TABLE_KEYS.itemReleaseFlag)}
      WHERE UPPER(TRIM(CAST(item AS STRING))) IN UNNEST(@items)
    `,
    { items: cleanedRows.map((row) => normalizeUpper(row.item)) }
  );

  const resourceRows = cleanedRows.some((row) => row.resource)
    ? await runQuery(
        `
          SELECT *
          FROM ${bqTableRefByKey(BQ_TABLE_KEYS.resourceMaster)}
          WHERE UPPER(TRIM(CAST(resource AS STRING))) IN UNNEST(@resources)
        `,
        { resources: cleanedRows.map((row) => normalizeUpper(row.resource)).filter(Boolean) }
      )
    : [];

  const itemMap = new Map();
  itemMasterRows.forEach((row) => {
    itemMap.set(normalizeUpper(row.item), row);
  });

  const releaseMap = new Map();
  releaseRows.forEach((row) => {
    releaseMap.set(normalizeUpper(row.item), row);
  });

  const resourceMap = new Map();
  resourceRows.forEach((row) => {
    resourceMap.set(normalizeUpper(row.resource), row);
  });

  return cleanedRows.map((row) => {
    const itemRow = itemMap.get(normalizeUpper(row.item)) || {};
    const releaseRow = releaseMap.get(normalizeUpper(row.item)) || {};
    const resourceRow = resourceMap.get(normalizeUpper(row.resource)) || {};

    return {
      item: row.item,
      item_description: pickFirstValue(itemRow, ["item_description", "item_desc", "description", "item_desc_1"]),
      resource_relevancy: pickFirstValue(resourceRow, ["resource_planning_relevance", "resource_relevancy"]),
      item_release_flag: pickFirstValue(releaseRow, ["release", "release_flag", "releaseflag", "item_release_flag", "item_releaseflag", "item_mrp_rls_flg", "planning_release_flag", "status"]),
    };
  });
};

export const fetchBomDetailsByBomId = async (bomId) => {
  const tableName = appConfig.postgres.tables.bomProduced;

  const producedRows = await runPgQuery(
    `
      SELECT
        CAST(bp.bom_id AS TEXT) AS bom_id,
        CAST(bp.item AS TEXT) AS item,
        CAST(bp.location AS TEXT) AS location,
        CAST(bp.erp_bom_qty_produced_per AS TEXT) AS qty_produced_per
      FROM ${pgTableRef(tableName)} bp
      WHERE UPPER(TRIM(CAST(bp.bom_id AS TEXT))) = $1
      ORDER BY
        CASE WHEN CAST(bp.erp_bom_qty_produced_per AS TEXT) IN ('1', '1.0', '1.00') THEN 0 ELSE 1 END,
        CAST(bp.item AS TEXT)
      LIMIT 1
    `,
    [normalizeUpper(bomId)]
  );

  const producedRow = producedRows[0];
  if (!producedRow) {
    return {
      bomId: normalizeText(bomId),
      producedItem: "",
      location: "",
      itemReleaseFlag: "",
    };
  }

  const producedItem = normalizeText(producedRow.item);
  const releaseData = producedItem ? await fetchItemReleaseFlagByItem(producedItem) : {};

  return {
    bomId: normalizeText(bomId),
    producedItem,
    location: normalizeText(producedRow.location),
    itemReleaseFlag: releaseData?.itemReleaseFlag || "",
  };
};

export const fetchCoProductsByItem = async (item) => {
  const tableName = appConfig.postgres.tables.itemBomRouting;
  const columns = await getPostgresTableColumns(tableName);
  const associationColumn = findColumn(columns, ["erp_co_product_association", "co_product_association"]);
  const itemColumn = findColumn(columns, ["item", "produced_item", "erp_parent_item", "main_item"]);

  if (!associationColumn || !itemColumn) return [];

  const rows = await runPgQuery(
    `
      SELECT DISTINCT TRIM(CAST(${quoteIdent(itemColumn)} AS TEXT)) AS item
      FROM ${pgTableRef(tableName)}
      WHERE COALESCE(NULLIF(TRIM(CAST(${quoteIdent(associationColumn)} AS TEXT)), ''), '0') IN ('1', 'true', 'TRUE', 'Y', 'y')
        AND ${quoteIdent(itemColumn)} IS NOT NULL
        AND TRIM(CAST(${quoteIdent(itemColumn)} AS TEXT)) <> ''
      ORDER BY item
    `
  );

  return rows
    .map((row) => ({ item: normalizeText(row.item) }))
    .filter((row) => row.item !== normalizeText(item));
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
