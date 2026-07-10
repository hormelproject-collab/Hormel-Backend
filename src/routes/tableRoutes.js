import express from "express";
import pool from "../db/postgresClient.js";
import bigquery from "../db/bigqueryClient.js";
import appConfig from "../config/appConfig.js";
import crypto from "crypto";
import XLSX from "xlsx";
import os from "os";
import { fetchItemMasterReleaseDetailsByItems } from "../services/bigqueryService.js";

const router = express.Router();

// Config-driven object maps. Non-sensitive table/column names come from committed appConfig.js.
const IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

const assertSafeIdentifier = (value, label) => {
  const normalized = String(value || "").trim();

  if (!normalized) {
    throw new Error(`Missing identifier for ${label}`);
  }

  if (!IDENTIFIER_REGEX.test(normalized)) {
    throw new Error(`Invalid SQL identifier for ${label}: ${normalized}`);
  }

  return normalized;
};

const CFG = Object.freeze({
  pg: {
    schema: appConfig.postgres.schema,
    database: appConfig.postgres.database,
  },
  bq: {
    projectId: appConfig.bigQuery.projectId,
    dataset: appConfig.bigQuery.datasetId,
  },
  tables: {
    bomParameters: appConfig.postgres.tables.bomParameters,
    bomProduced: appConfig.postgres.tables.bomProduced,
    bomConsumed: appConfig.postgres.tables.bomConsumed,
    itemBomRouting: appConfig.postgres.tables.itemBomRouting,
    itemMaster: appConfig.postgres.tables.itemMaster,
    locationMaster: appConfig.postgres.tables.locationMaster,
    itemReleaseFlag: appConfig.postgres.tables.itemReleaseFlag,
    changeLog: appConfig.postgres.tables.changeLog,
    itemDetails: appConfig.postgres.tables.itemDetails,

    bomParametersOg: appConfig.postgres.tables.bomParametersOg,
    bomProducedOg: appConfig.postgres.tables.bomProducedOg,
    bomConsumedOg: appConfig.postgres.tables.bomConsumedOg,
    itemBomRoutingOg: appConfig.postgres.tables.itemBomRoutingOg,

    bqBomParameters: appConfig.bigQuery.tables.bomParameters,
    bqBomProduced: appConfig.bigQuery.tables.bomProduced,
    bqBomConsumed: appConfig.bigQuery.tables.bomConsumed,
    bqItemBomRouting: appConfig.bigQuery.tables.itemBomRouting,
    bqItemMaster: appConfig.bigQuery.tables.itemMaster,
    bqItemReleaseFlag: appConfig.bigQuery.tables.itemReleaseFlag,
    bqLocationMaster: appConfig.bigQuery.tables.locationMaster,
    bqRoutingRescons: appConfig.bigQuery.tables.routingRescons,
    bqResourceMaster: appConfig.bigQuery.tables.resourceMaster,
  },
  columns: {
    postgresqlRecId: appConfig.postgres.columns.postgresqlRecId,
    recId: appConfig.postgres.columns.recId,
    recordId: appConfig.postgres.columns.recordId,
    bomId: appConfig.postgres.columns.bomId,
    item: appConfig.postgres.columns.item,
    location: appConfig.postgres.columns.location,
    routingId: appConfig.postgres.columns.routingId,
    engineeringChangeId: appConfig.postgres.columns.engineeringChangeId,
    changeType: appConfig.postgres.columns.changeType,
    changeDate: appConfig.postgres.columns.changeDate,
    userName: appConfig.postgres.columns.userName,
    createdAt: appConfig.postgres.columns.createdAt,
    createdOn: appConfig.postgres.columns.createdOn,
    notes: appConfig.postgres.columns.notes,
    summaryNotes: appConfig.postgres.columns.summaryNotes,
    changeSummary: appConfig.postgres.columns.changeSummary,
    sourceTable: appConfig.postgres.columns.sourceTable,
    sourceRecId: appConfig.postgres.columns.sourceRecId,
    originalRecId: appConfig.postgres.columns.originalRecId,
    loadDatetime: appConfig.postgres.columns.loadDatetime,

    erpBomQtyProducedPer: appConfig.postgres.columns.erpBomQtyProducedPer,
    erpBomQuantityConsumedPer: appConfig.postgres.columns.erpBomQuantityConsumedPer,
    erpBomComponentStartDate: appConfig.postgres.columns.erpBomComponentStartDate,
    erpBomComponentEndDate: appConfig.postgres.columns.erpBomComponentEndDate,
    erpItemBomRoutingPriority: appConfig.postgres.columns.erpItemBomRoutingPriority,
    erpItemBomRoutingMinLotSize: appConfig.postgres.columns.erpItemBomRoutingMinLotSize,
    erpItemBomRoutingLotSizeIncrement:
      appConfig.postgres.columns.erpItemBomRoutingLotSizeIncrement,
    erpItemBomWipSweepPriority: appConfig.postgres.columns.erpItemBomWipSweepPriority,
    erpItemBomRoutingWipSweepPriority:
      appConfig.postgres.columns.erpItemBomRoutingWipSweepPriority,
    erpItemBomRoutingMaxLotSize: appConfig.postgres.columns.erpItemBomRoutingMaxLotSize,
    erpCoProductAssociation: appConfig.postgres.columns.erpCoProductAssociation,
    erpBomStartDate: appConfig.postgres.columns.erpBomStartDate,
    erpBomEndDate: appConfig.postgres.columns.erpBomEndDate,
  },
});

const T = new Proxy(CFG.tables, {
  get(target, prop) {
    return assertSafeIdentifier(target[prop], `table.${String(prop)}`);
  },
});

const C = new Proxy(CFG.columns, {
  get(target, prop) {
    return assertSafeIdentifier(target[prop], `column.${String(prop)}`);
  },
});

const S = assertSafeIdentifier(CFG.pg.schema, "pg.schema");
const pgRef = (tableName) => `${S}.${tableName}`;

// Backward-compatible fallback helper for any remaining old envOr references.
// This file no longer reads table/column names from .env.
const envOr = (_key, fallback = "") => fallback;

/* =========================================================
   Common ID helpers
========================================================= */
const getSystemUserName = (req) => {
  return (
    String(req.user?.userName || "").trim() ||
    String(req.user?.userId || "").trim() ||
    String(req.auth?.user?.userName || "").trim() ||
    String(req.auth?.user?.userId || "").trim() ||
    String(req.headers["x-ms-client-principal-name"] || "").trim() ||
    String(process.env.USERNAME || "").trim() ||
    String(process.env.USER || "").trim() ||
    (() => {
      try {
        return String(os.userInfo().username || "").trim();
      } catch {
        return "";
      }
    })() ||
    "SYSTEM_USER"
  );
};

const toTextValue = (value) => String(value ?? "").trim();

const isTruthyCoProductAssociation = (row) => {
  const value = toTextValue(
    row?.erp_co_product_association ??
    row?.co_product_association ??
    row?.coProductAssociation ??
    row?.erpCoProductAssociation
  ).toLowerCase();

  return value === "1" || value === "true" || value === "yes" || value === "y";
};

const getLocationFromBomIdForDelete = (bomId) => {
  const value = toTextValue(bomId);
  if (!value) return "";
  const parts = value.split("_").map((p) => p.trim()).filter(Boolean);
  return parts.length >= 3 ? parts.slice(2).join("_") : "";
};

async function getDeleteTargetRowsForItemBomRouting(client, sourceRow) {
  const bomId = toTextValue(sourceRow?.bom_id);
  const routingId = toTextValue(sourceRow?.routing_id);

  if (!bomId || !routingId) {
    return sourceRow ? [sourceRow] : [];
  }

  const sourceIsCoProduct = isTruthyCoProductAssociation(sourceRow);

  // If selected row itself is a co-product, delete only that specific row
  if (sourceIsCoProduct) {
    return [sourceRow];
  }

  // If parent item is selected, delete the routing group
  // (parent + associated co-product rows) from item_bom_routing
  const relatedQuery = `
    SELECT *
    FROM ${pgRef(T.itemBomRouting)}
    WHERE TRIM(CAST(bom_id AS TEXT)) = $1
      AND TRIM(CAST(routing_id AS TEXT)) = $2
  `;

  const relatedResult = await client.query(relatedQuery, [bomId, routingId]);
  const relatedRows = Array.isArray(relatedResult.rows) ? relatedResult.rows : [];

  if (!relatedRows.length) {
    return [sourceRow];
  }

  const uniqueMap = new Map();

  relatedRows.forEach((row) => {
    const key = buildItemBomRoutingUniqueKey(row);
    if (!uniqueMap.has(key)) {
      uniqueMap.set(key, row);
    }
  });

  return Array.from(uniqueMap.values());
}

function getBomProducedMatchInputFromRow(row) {
  const bomId = toTextValue(row?.bom_id);
  const location =
    toTextValue(row?.location) || getLocationFromBomIdForDelete(bomId);

  let coProductItem = toTextValue(
    row?.co_product_item ??
    row?.coProductItem ??
    row?.coproduct_item
  );

  // If the row itself is a co-product row and co_product_item is blank,
  // use row.item as the co-product item
  if (!coProductItem && isTruthyCoProductAssociation(row)) {
    coProductItem = toTextValue(row?.item);
  }

  return {
    bomId,
    location,
    coProductItem,
  };
}

async function getBomProducedRowsForCoProductOnly(client, row) {
  const { bomId, location, coProductItem } = getBomProducedMatchInputFromRow(row);

  // only co-product item should be deleted from bom_produced
  if (!bomId || !location || !coProductItem) {
    return [];
  }

  const result = await client.query(
    `
    SELECT ctid, *
    FROM ${pgRef(T.bomProduced)}
    WHERE TRIM(CAST(bom_id AS TEXT)) = $1
      AND TRIM(CAST(location AS TEXT)) = $2
      AND TRIM(CAST(item AS TEXT)) = $3
    `,
    [bomId, location, coProductItem]
  );

  return Array.isArray(result.rows) ? result.rows : [];
}

async function archiveBomProducedRows(
  client,
  rows,
  archiveTable,
  archiveColumns,
  engineeringChangeId,
  notes
) {
  const archivedIds = [];

  for (const sourceRow of rows) {
    const archiveRow = { ...sourceRow };

    delete archiveRow.ctid;
    delete archiveRow.postgresql_rec_id;

    if (archiveColumns.includes("engineering_change_id")) {
      archiveRow.engineering_change_id = engineeringChangeId;
    }
    if (archiveColumns.includes("engineeringchangeid")) {
      archiveRow.engineeringchangeid = engineeringChangeId;
    }

    if (archiveColumns.includes("change_type")) {
      archiveRow.change_type = "Deleted";
    }
    if (archiveColumns.includes("changetype")) {
      archiveRow.changetype = "Deleted";
    }

    if (archiveColumns.includes("notes")) {
      archiveRow.notes = notes || "";
    }
    if (archiveColumns.includes("summarynotes")) {
      archiveRow.summarynotes = notes || "";
    }

    if (archiveColumns.includes("change_summary")) {
      archiveRow.change_summary = "";
    }

    if (archiveColumns.includes("source_table")) {
      archiveRow.source_table = T.bomProduced;
    }

    if (archiveColumns.includes("source_rec_id")) {
      archiveRow.source_rec_id =
        sourceRow.rec_id ??
        sourceRow.record_id ??
        sourceRow.recordid ??
        sourceRow.postgresql_rec_id ??
        null;
    }

    if (archiveColumns.includes("archived_at")) {
      archiveRow.archived_at = getChicagoNowDate();
    }
    if (archiveColumns.includes("archived_on")) {
      archiveRow.archived_on = getChicagoNowDate();
    }
    if (archiveColumns.includes("deleted_at")) {
      archiveRow.deleted_at = getChicagoNowDate();
    }
    if (archiveColumns.includes("deleted_on")) {
      archiveRow.deleted_on = getChicagoNowDate();
    }

    const { query, values } = buildDynamicInsertQuery(
      archiveTable,
      archiveRow,
      archiveColumns
    );

    const insertResult = await client.query(query, values);
    const insertedRow = insertResult.rows?.[0] || {};

    if (insertedRow?.postgresql_rec_id != null) {
      archivedIds.push(String(insertedRow.postgresql_rec_id));
    }
  }

  return archivedIds;
}

async function deleteExactBomProducedRow(client, row) {
  if (row?.ctid) {
    const result = await client.query(
      `DELETE FROM ${pgRef(T.bomProduced)} WHERE ctid = $1`,
      [row.ctid]
    );
    return Number(result.rowCount || 0);
  }

  if (row?.postgresql_rec_id != null) {
    const result = await client.query(
      `DELETE FROM ${pgRef(T.bomProduced)} WHERE postgresql_rec_id = $1`,
      [row.postgresql_rec_id]
    );
    return Number(result.rowCount || 0);
  }

  if (row?.rec_id != null) {
    const result = await client.query(
      `DELETE FROM ${pgRef(T.bomProduced)} WHERE rec_id = $1`,
      [row.rec_id]
    );
    return Number(result.rowCount || 0);
  }

  const bomId = toTextValue(row?.bom_id);
  const location = toTextValue(row?.location);
  const item = toTextValue(row?.item);

  if (!bomId || !location || !item) {
    return 0;
  }

  const result = await client.query(
    `
    DELETE FROM ${pgRef(T.bomProduced)}
    WHERE TRIM(CAST(bom_id AS TEXT)) = $1
      AND TRIM(CAST(location AS TEXT)) = $2
      AND TRIM(CAST(item AS TEXT)) = $3
    `,
    [bomId, location, item]
  );

  return Number(result.rowCount || 0);
}

async function archiveAndDeleteMatchingBomProducedCoProductOnly(
  client,
  row,
  {
    bomProducedArchiveTable,
    bomProducedArchiveColumns,
    engineeringChangeId,
    notes,
  }
) {
  const bomProducedRows = await getBomProducedRowsForCoProductOnly(client, row);

  if (!bomProducedRows.length) {
    return {
      archivedBomProducedRecIds: [],
      bomProducedDeletedCount: 0,
    };
  }

  const archivedBomProducedRecIds = await archiveBomProducedRows(
    client,
    bomProducedRows,
    bomProducedArchiveTable,
    bomProducedArchiveColumns,
    engineeringChangeId,
    notes
  );

  let bomProducedDeletedCount = 0;

  for (const bomProducedRow of bomProducedRows) {
    bomProducedDeletedCount += await deleteExactBomProducedRow(
      client,
      bomProducedRow
    );
  }

  return {
    archivedBomProducedRecIds,
    bomProducedDeletedCount,
  };
}

const generateUniqueBigInt = () => {
  const ts = Date.now().toString();
  const rand = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, "0");
  return `${ts}${rand}`;
};
function getChicagoNowDate() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "America/Chicago" })
  );
}

function formatChicagoDbTimestamp(dateInput = new Date()) {
  const chicagoDate = new Date(
    new Date(dateInput).toLocaleString("en-US", { timeZone: "America/Chicago" })
  );

  const yyyy = chicagoDate.getFullYear();
  const mm = String(chicagoDate.getMonth() + 1).padStart(2, "0");
  const dd = String(chicagoDate.getDate()).padStart(2, "0");
  const hh = String(chicagoDate.getHours()).padStart(2, "0");
  const mi = String(chicagoDate.getMinutes()).padStart(2, "0");
  const ss = String(chicagoDate.getSeconds()).padStart(2, "0");

  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}

function normalizeCoProductAssociation(row) {
  const raw =
    row?.erp_co_product_association ??
    row?.co_product_association ??
    row?.erpCoProductAssociation ??
    row?.coProductAssociation ??
    null;

  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return 0;
  }

  return Number(raw) === 1 ? 1 : 0;
}

function buildItemBomRoutingUniqueKey(row) {
  return [
    String(row?.postgresql_rec_id ?? "").trim(),
    String(row?.rec_id ?? "").trim(),
    String(row?.bom_id ?? "").trim(),
    String(row?.routing_id ?? "").trim(),
    String(row?.item ?? "").trim(),
    String(normalizeCoProductAssociation(row)),
  ].join("__");
}

async function deleteExactItemBomRoutingRow(client, row) {
  const postgresqlRecId = row?.postgresql_rec_id ?? null;
  const recId = String(row?.rec_id ?? "").trim();
  const bomId = String(row?.bom_id ?? "").trim();
  const routingId = String(row?.routing_id ?? "").trim();
  const item = String(row?.item ?? "").trim();
  const association = normalizeCoProductAssociation(row);

  if (postgresqlRecId !== null && postgresqlRecId !== undefined) {
    await client.query(
      `
        DELETE FROM ${pgRef(T.itemBomRouting)}
        WHERE postgresql_rec_id = $1
      `,
      [postgresqlRecId]
    );
    return;
  }

  const conditions = [];
  const params = [];
  let p = 1;

  if (recId) {
    conditions.push(`TRIM(CAST(rec_id AS TEXT)) = $${p++}`);
    params.push(recId);
  }

  conditions.push(`TRIM(CAST(bom_id AS TEXT)) = $${p++}`);
  params.push(bomId);

  conditions.push(`TRIM(CAST(routing_id AS TEXT)) = $${p++}`);
  params.push(routingId);

  conditions.push(`TRIM(CAST(item AS TEXT)) = $${p++}`);
  params.push(item);

  if (association === 1) {
    conditions.push(
      `COALESCE(NULLIF(TRIM(CAST(erp_co_product_association AS TEXT)), ''), '0') = '1'`
    );
  } else {
    conditions.push(
      `COALESCE(NULLIF(TRIM(CAST(erp_co_product_association AS TEXT)), ''), '0') <> '1'`
    );
  }

  await client.query(
    `
      DELETE FROM ${pgRef(T.itemBomRouting)}
      WHERE ${conditions.join(" AND ")}
    `,
    params
  );
}

function generateRandomSixDigit() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

const HARD_CODED_START_DATE = "2019-01-01";
const HARD_CODED_END_DATE = "2099-01-25";
const HARD_CODED_BOM_STATUS = "ACTIVE";
const HARD_CODED_PREFIX = "BOM";
const HARD_CODED_BOM_PLAN_TYPE = "MP and OP";
const HARD_CODED_LOAD_DATETIME = null;

const getOsUserName = () => {
  try {
    return String(os.userInfo()?.username || "APPL_TEAM").trim() || "APPL_TEAM";
  } catch (error) {
    return "APPL_TEAM";
  }
};

const getBomVersionFromBomId = (bomId) => {
  const parts = String(bomId || "")
    .split("_")
    .map((p) => p.trim())
    .filter(Boolean);

  // Format expected: BOMVERSION_item_location
  // Example: BOM1_HRL00068_1008 -> BOM1
  return parts.length >= 1 ? parts[0] : "";
};

const generateUniqueId = (prefix) => {
  const ts = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  const rand = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `${prefix}${ts}${rand}`;
};

const generateDeleteBomEngineeringChangeId = () => {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `EC-${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
};

const generateDeleteItemBomRoutingEngineeringChangeId = () => {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `EC-${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
};
const getProducedItemFromBomId = (bomId) => {
  const parts = String(bomId || "")
    .split("_")
    .map((p) => p.trim())
    .filter(Boolean);

  return parts.length >= 3 ? parts[1] : "";
};

const getLocationFromBomId = (bomId) => {
  const parts = String(bomId || "")
    .split("_")
    .map((p) => p.trim())
    .filter(Boolean);

  return parts.length >= 3 ? parts[2] : "";
};

const getResourceFromRoutingId = (routingId) => {
  const parts = String(routingId || "")
    .split("_")
    .map((p) => p.trim())
    .filter(Boolean);

  return parts.length >= 4 ? parts.slice(3).join("_") : "";
};

const getSourceRecId = (row) =>
  row?.postgresql_rec_id ??
  row?.rec_id ??
  row?.record_id ??
  row?.recordid ??
  row?.id ??
  null;

const getArchiveRecId = (row) =>
  row?.postgresql_rec_id ??
  row?.rec_id ??
  row?.record_id ??
  row?.recordid ??
  row?.id ??
  null;

/* =========================================================
   DB metadata helpers
========================================================= */
const getExistingColumns = async (client, tableName) => {
  const result = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = $2
      ORDER BY ordinal_position
    `,
    [S, tableName]
  );

  return result.rows.map((row) => String(row.column_name).trim().toLowerCase());
};

const pgTableExists = async (client, tableName) => {
  const result = await client.query(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = $1
          AND table_name = $2
      ) AS exists
    `,
    [S, tableName]
  );
  return Boolean(result.rows?.[0]?.exists);
};

const quoteIdent = (value) => `"${String(value).replace(/"/g, '""')}"`;
const quotePgTable = (tableName, schema = S) => `${quoteIdent(schema)}.${quoteIdent(tableName)}`;

const buildDynamicInsertQuery = (tableName, data, allowedColumns) => {
  const entries = Object.entries(data).filter(([key, value]) => {
    return (
      value !== undefined &&
      allowedColumns.includes(String(key).toLowerCase())
    );
  });

  if (entries.length === 0) {
    throw new Error(`No matching columns found for insert into ${tableName}`);
  }

  const columns = entries.map(([key]) => quoteIdent(key));
  const values = entries.map(([, value]) => value);
  const placeholders = entries.map((_, index) => `$${index + 1}`);

  return {
    query: `INSERT INTO ${quotePgTable(tableName)} (${columns.join(
      ", "
    )}) VALUES (${placeholders.join(", ")}) RETURNING *`,
    values,
  };
};

const buildInsertQuery = (tableName, candidateData, allowedColumns) => {
  const entries = Object.entries(candidateData).filter(([key, value]) => {
    return (
      allowedColumns.includes(String(key).toLowerCase()) &&
      value !== undefined
    );
  });

  if (entries.length === 0) {
    throw new Error(`No matching columns found for insert into ${tableName}`);
  }

  const columns = entries.map(([key]) => key);
  const values = entries.map(([, value]) => value);
  const placeholders = entries.map((_, index) => `$${index + 1}`);

  return {
    query: `
      INSERT INTO ${quotePgTable(tableName)} (${columns.join(", ")})
      VALUES (${placeholders.join(", ")})
      RETURNING *
    `,
    values,
  };
};

/* =========================================================
   Delete helpers
========================================================= */
const DELETE_BOM_SOURCE_TO_ARCHIVE = {
  [T.bomParameters]: T.bomParametersOg,
  [T.bomProduced]: T.bomProducedOg,
  [T.bomConsumed]: T.bomConsumedOg,
  [T.itemBomRouting]: T.itemBomRoutingOg,
};

const DELETE_BOM_CHANGE_LOG_TABLE_CANDIDATES = [
  T.changeLog,
  envOr("PG_TABLE_CHANGE_LOG_FALLBACK", "bom_change_log_summary"),
];

const toText = (value) => String(value ?? "").trim();

const normalizeTextArray = (values) => {
  if (Array.isArray(values)) {
    return Array.from(new Set(values.map((v) => toText(v)).filter(Boolean)));
  }
  if (values == null) return [];
  return Array.from(new Set([toText(values)].filter(Boolean)));
};

const buildDeleteBomArchiveRow = ({
  baseRow,
  archiveColumns,
  engineeringChangeId,
  notes,
  sourceTable,
}) => {
  const archiveRow = { ...baseRow };

  // IMPORTANT:
  // _og tables must generate their own postgresql_rec_id from sequence.
  // Do not carry live PK into archive PK.
  delete archiveRow.postgresql_rec_id;

  if (archiveColumns.includes("engineering_change_id")) {
    archiveRow.engineering_change_id = engineeringChangeId;
  }
  if (archiveColumns.includes("engineeringchangeid")) {
    archiveRow.engineeringchangeid = engineeringChangeId;
  }
  if (archiveColumns.includes("change_type")) {
    archiveRow.change_type = "Deleted";
  }
  if (archiveColumns.includes("changetype")) {
    archiveRow.changetype = "Deleted";
  }
  if (archiveColumns.includes("notes")) {
    archiveRow.notes = notes || "";
  }
  if (archiveColumns.includes("summarynotes")) {
    archiveRow.summarynotes = notes || "";
  }
  if (archiveColumns.includes("change_summary")) {
    archiveRow.change_summary = "";
  }
  if (archiveColumns.includes("source_table")) {
    archiveRow.source_table = sourceTable;
  }
  if (archiveColumns.includes("source_rec_id")) {
    archiveRow.source_rec_id =
      baseRow.postgresql_rec_id ??
      baseRow.rec_id ??
      baseRow.record_id ??
      baseRow.recordid ??
      baseRow.id ??
      null;
  }
  if (archiveColumns.includes("original_rec_id")) {
    archiveRow.original_rec_id =
      baseRow.postgresql_rec_id ??
      baseRow.rec_id ??
      baseRow.record_id ??
      baseRow.recordid ??
      baseRow.id ??
      null;
  }
  if (archiveColumns.includes("archived_at")) {
    archiveRow.archived_at = new Date();
  }
  if (archiveColumns.includes("archived_on")) {
    archiveRow.archived_on = new Date();
  }
  if (archiveColumns.includes("deleted_at")) {
    archiveRow.deleted_at = new Date();
  }
  if (archiveColumns.includes("deleted_on")) {
    archiveRow.deleted_on = new Date();
  }

  return archiveRow;
};

const deleteRowsByBomId = async (client, tableName, bomIds) => {
  const normalizedBomIds = normalizeTextArray(bomIds);
  if (!normalizedBomIds.length) {
    throw new Error(`Cannot delete from ${tableName}: bomIds is empty`);
  }

  const deleteResult = await client.query(
    `
      DELETE FROM ${quotePgTable(tableName)}
      WHERE TRIM(CAST(bom_id AS TEXT)) = ANY($1::text[])
      RETURNING bom_id
    `,
    [normalizedBomIds]
  );

  return deleteResult.rowCount || 0;
};

const deleteItemBomRoutingByBomAndRouting = async (
  client,
  bomId,
  routingId
) => {
  const bomIdText = toText(bomId);
  const routingIdText = toText(routingId);

  if (!bomIdText) {
    throw new Error(
      "Cannot delete from item_bom_routing: bom_id is required"
    );
  }

  let query = `
    DELETE FROM ${pgRef(T.itemBomRouting)}
    WHERE TRIM(CAST(bom_id AS TEXT)) = $1
  `;
  const params = [bomIdText];

  if (routingIdText) {
    query += ` AND TRIM(CAST(routing_id AS TEXT)) = $2`;
    params.push(routingIdText);
  }

  query += ` RETURNING bom_id, routing_id`;

  const deleteResult = await client.query(query, params);

  if (!deleteResult.rowCount) {
    throw new Error(
      `Delete failed in item_bom_routing: no row matched bom_id=${bomIdText}${routingIdText ? ` and routing_id=${routingIdText}` : ""
      }`
    );
  }

  return deleteResult.rows || [];
};

/* =========================================================
   BigQuery helpers
========================================================= */
const getBigQueryConfig = () => {
  const dataset = appConfig.bigQuery.datasetId;

  if (!dataset) {
    throw new Error("BigQuery datasetId is missing in appConfig.js");
  }

  return { dataset };
};

const BQ_TABLE_SOURCE_BY_KEY = Object.freeze({
  // These BOM source-of-truth tables are fetched from PostgreSQL in this route.
  bomParameters: "dev",
  bomProduced: "dev",
  bomConsumed: "dev",
  itemBomRouting: "dev",

  // Required BigQuery source split.
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

const BQ_TABLE_NAME_BY_KEY = Object.freeze({
  bomParameters: appConfig.bigQuery.tables.bomParameters,
  bomProduced: appConfig.bigQuery.tables.bomProduced,
  bomConsumed: appConfig.bigQuery.tables.bomConsumed,
  itemBomRouting: appConfig.bigQuery.tables.itemBomRouting,
  itemMaster: appConfig.bigQuery.tables.itemMaster,
  itemReleaseFlag: appConfig.bigQuery.tables.itemReleaseFlag,
  locationMaster: appConfig.bigQuery.tables.locationMaster,
  routingRescons: appConfig.bigQuery.tables.routingRescons,
  resourceMaster: appConfig.bigQuery.tables.resourceMaster,
});

const BQ_READ_TABLE_KEYS_BY_TABLE_NAME = Object.freeze(
  Object.fromEntries(
    Object.entries(BQ_TABLE_NAME_BY_KEY).map(([key, tableName]) => [tableName, key])
  )
);

const getBQProjectId = (tableKey) => {
  const source = BQ_TABLE_SOURCE_BY_KEY[tableKey] || "prd";
  const projectId = appConfig.bigQuery.projectIds?.[source];
  if (!projectId) {
    throw new Error(`BigQuery projectId for source ${source} is missing in appConfig.js`);
  }
  return projectId;
};

const bqTableRefByKey = (tableKey) => {
  const { dataset } = getBigQueryConfig();
  const projectId = getBQProjectId(tableKey);
  const tableName = assertSafeIdentifier(BQ_TABLE_NAME_BY_KEY[tableKey], `bigQuery.tables.${tableKey}`);
  return `\`${projectId}.${dataset}.${tableName}\``;
};

const getBQTableKeyByTableName = (tableName) => {
  const requested = String(tableName || "").trim();
  return BQ_READ_TABLE_KEYS_BY_TABLE_NAME[requested] || "";
};

const getBQSingleRecordWhere = (tableKey) => {
  switch (tableKey) {
    case "itemMaster":
    case "itemReleaseFlag":
      return ["item", "item_id", "item_number", "itemNumber"];
    case "locationMaster":
      return ["location", "location_id", "location_number", "locationNumber"];
    case "resourceMaster":
    case "routingRescons":
      return ["resource", "resource_id", "routing_id", "routingId"];
    default:
      return ["item", "location", "resource", "routing_id", "bom_id"];
  }
};

const normalizeText = (value) => String(value ?? "").trim();
const normalizeUpper = (value) => normalizeText(value).toUpperCase();
const qCol = (columnName) => `\`${String(columnName).replace(/`/g, "")}\``;

const runBigQuery = async (query, params = {}) => {
  const [rows] = await bigquery.query({
    query,
    params,
  });
  return rows;
};

const fetchBQRowsForRoute = async (tableKey, { limit = 100, id = "" } = {}) => {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 1000));
  const params = {};
  let query = `SELECT * FROM ${bqTableRefByKey(tableKey)}`;

  const idText = normalizeText(id);
  if (idText) {
    const candidates = getBQSingleRecordWhere(tableKey);
    const conditions = candidates.map((column, index) => {
      const paramName = `id${index}`;
      params[paramName] = idText;
      return `UPPER(TRIM(CAST(${qCol(column)} AS STRING))) = UPPER(TRIM(@${paramName}))`;
    });
    query += ` WHERE ${conditions.join(" OR ")}`;
  }

  query += ` LIMIT ${safeLimit}`;
  return runBigQuery(query, params);
};

const getBaseKeyFromBomId = (bomId) => {
  const value = normalizeText(bomId);
  if (!value) return "";

  const parts = value
    .split("_")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length < 2) return "";

  return `${parts[0]}_${parts[1]}`;
};

const getBaseKeyAndResourceFromRoutingId = (routingId) => {
  const value = normalizeText(routingId);
  if (!value) {
    return { baseKey: "", resource: "" };
  }

  const parts = value
    .split("_")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length < 3) {
    return { baseKey: "", resource: "" };
  }

  return {
    baseKey: `${parts[0]}_${parts[1]}`,
    resource: parts[parts.length - 1],
  };
};

/* =========================================================
   1) Dedicated API: item_master + item_releaseflag
   Source:
   - item_master       => BigQuery PRD project from appConfig
   - item_release_flag => BigQuery DEV project from appConfig
========================================================= */
router.get("/items-with-releaseflag", async (req, res) => {
  try {
    const query = `
      WITH item_master_base AS (
        SELECT
          TRIM(CAST(im.item AS STRING)) AS item,
          COALESCE(
            CAST(im.item_description AS STRING),
            CAST(im.item_desc AS STRING),
            CAST(im.description AS STRING),
            ''
          ) AS item_description,
          COALESCE(
            CAST(im.item_status AS STRING),
            CAST(im.status AS STRING),
            ''
          ) AS item_status
        FROM ${bqTableRefByKey("itemMaster")} im
        WHERE im.item IS NOT NULL
          AND TRIM(CAST(im.item AS STRING)) != ''
      ),
      release_flag_base AS (
        SELECT
          TRIM(CAST(rf.item AS STRING)) AS item,
          COALESCE(
            CAST(rf.item_releaseflag AS STRING),
            CAST(rf.item_release_flag AS STRING),
            CAST(rf.release_flag AS STRING),
            CAST(rf.releaseflag AS STRING),
            CAST(rf.item_mrp_rls_flg AS STRING),
            CAST(rf.mrp_release_flag AS STRING),
            CAST(rf.release AS STRING),
            ''
          ) AS item_releaseflag
        FROM ${bqTableRefByKey("itemReleaseFlag")} rf
        WHERE rf.item IS NOT NULL
          AND TRIM(CAST(rf.item AS STRING)) != ''
      )
      SELECT
        im.*,
        COALESCE(rf.item_releaseflag, '') AS item_releaseflag
      FROM item_master_base im
      LEFT JOIN release_flag_base rf
        ON UPPER(TRIM(im.item)) = UPPER(TRIM(rf.item))
      ORDER BY item
    `;
    const rows = await runBigQuery(query);
    return res.status(200).json(rows || []);
  } catch (error) {
    console.error("DB Error (items-with-releaseflag):", error);
    return res.status(500).json({
      message: "Failed to fetch item master with release flag",
      error: error.message,
    });
  }
});
/* =========================================================
   2) Dedicated API: selected item(s) -> bom_produced -> location_master
========================================================= */
router.post("/locations-by-items", async (req, res) => {
  try {
    const { itemIds } = req.body || {};
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return res.status(400).json({
        error: "itemIds must be a non-empty array",
      });
    }
    const normalizedItemIds = itemIds
      .map((id) => String(id).trim())
      .filter(Boolean);

    // bom_produced is fetched from PostgreSQL.
    const producedResult = await pool.query(
      `
      SELECT DISTINCT
        CAST(bp.item AS TEXT) AS item,
        CAST(bp.location AS TEXT) AS location
      FROM ${pgRef(T.bomProduced)} bp
      WHERE TRIM(CAST(bp.item AS TEXT)) = ANY($1::text[])
        AND COALESCE(TRIM(CAST(bp.location AS TEXT)), '') <> ''
      ORDER BY CAST(bp.item AS TEXT), CAST(bp.location AS TEXT)
      `,
      [normalizedItemIds]
    );

    const producedRows = producedResult.rows || [];
    const locations = Array.from(
      new Set(producedRows.map((row) => normalizeText(row.location)).filter(Boolean))
    );

    let locationRows = [];
    if (locations.length) {
      // location_master is fetched from BigQuery PRD using appConfig.
      locationRows = await runBigQuery(
        `
        SELECT
          TRIM(CAST(location AS STRING)) AS location,
          COALESCE(CAST(location_name AS STRING), CAST(location_description AS STRING), '') AS location_name,
          COALESCE(CAST(location_status AS STRING), CAST(status AS STRING), '') AS location_status
        FROM ${bqTableRefByKey("locationMaster")}
        WHERE UPPER(TRIM(CAST(location AS STRING))) IN UNNEST(@locations)
        `,
        { locations: locations.map((location) => location.toUpperCase()) }
      );
    }

    const locationMap = new Map(
      (locationRows || []).map((row) => [normalizeUpper(row.location), row])
    );

    const data = producedRows.map((row) => {
      const locationInfo = locationMap.get(normalizeUpper(row.location)) || {};
      return {
        ...row,
        location_name: locationInfo.location_name || "",
        location_status: locationInfo.location_status || "",
      };
    });

    return res.status(200).json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("DB Error (locations-by-items):", error);
    return res.status(500).json({
      error: "Failed to fetch locations by selected items",
      details: error.message,
    });
  }
});
/* =========================================================
   3) Existing BOM search rows for Step 1
========================================================= */
router.get("/existing-bom-search", async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, Number.parseInt(req.query.pageSize, 10) || 50)
    );
    const offset = (page - 1) * pageSize;

    const normalizeField = (value) => {
      const allowed = new Set([
        "",
        "location",
        "bom_id",
        "bomId",
        "produced_item",
        "producedItem",
        "produced_item_desc",
        "producedItemDescription",
        "item_release_flag",
        "releaseFlag",
        "resource",
      ]);

      const field = String(value || "").trim();
      if (!allowed.has(field)) return "";

      const fieldMap = {
        bomId: "bom_id",
        producedItem: "produced_item",
        producedItemDescription: "produced_item_desc",
        releaseFlag: "item_release_flag",
      };

      return fieldMap[field] || field;
    };

    const searchBy1 = normalizeField(req.query.searchBy1);
    const query1 = normalizeText(req.query.query1 || "");
    const searchBy2 = normalizeField(req.query.searchBy2);
    const query2 = normalizeText(req.query.query2 || "");

    const pgParams = [];
    const pgFilters = [];

    const addPgParam = (value) => {
      pgParams.push(value);
      return `$${pgParams.length}`;
    };

    const addProducedItemInFilter = (items) => {
      const cleaned = Array.from(
        new Set((items || []).map(normalizeUpper).filter(Boolean))
      );

      if (!cleaned.length) {
        pgFilters.push("1 = 0");
        return;
      }

      const placeholders = cleaned.map((item) => addPgParam(item)).join(", ");

      pgFilters.push(
        `UPPER(TRIM(CAST(produced_item AS TEXT))) IN (${placeholders})`
      );
    };

    const findItemsByDescription = async (descriptionText) => {
      const q = normalizeText(descriptionText);
      if (!q) return [];

      const rows = await runBigQuery(
        `
          SELECT DISTINCT UPPER(TRIM(CAST(item AS STRING))) AS item
          FROM ${bqTableRefByKey("itemMaster")}
          WHERE item IS NOT NULL
            AND TRIM(CAST(item AS STRING)) != ''
            AND (
              LOWER(COALESCE(CAST(item_description AS STRING), '')) LIKE CONCAT('%', LOWER(@q), '%')
              OR LOWER(COALESCE(CAST(description AS STRING), '')) LIKE CONCAT('%', LOWER(@q), '%')
              OR LOWER(COALESCE(CAST(item_desc AS STRING), '')) LIKE CONCAT('%', LOWER(@q), '%')
              OR LOWER(COALESCE(CAST(item_desc_1 AS STRING), '')) LIKE CONCAT('%', LOWER(@q), '%')
            )
        `,
        { q }
      );

      return rows.map((row) => normalizeUpper(row.item)).filter(Boolean);
    };

    const findItemsByReleaseFlag = async (releaseText) => {
      const q = normalizeText(releaseText);
      if (!q) return [];

      const rows = await runBigQuery(
        `
          SELECT DISTINCT UPPER(TRIM(CAST(item AS STRING))) AS item
          FROM ${bqTableRefByKey("itemReleaseFlag")}
          WHERE item IS NOT NULL
            AND TRIM(CAST(item AS STRING)) != ''
            AND (
              LOWER(COALESCE(CAST(item_releaseflag AS STRING), '')) LIKE CONCAT('%', LOWER(@q), '%')
              OR LOWER(COALESCE(CAST(release_flag AS STRING), '')) LIKE CONCAT('%', LOWER(@q), '%')
              OR LOWER(COALESCE(CAST(releaseflag AS STRING), '')) LIKE CONCAT('%', LOWER(@q), '%')
              OR LOWER(COALESCE(CAST(mrp_release_flag AS STRING), '')) LIKE CONCAT('%', LOWER(@q), '%')
              OR LOWER(COALESCE(CAST(item_mrp_rls_flg AS STRING), '')) LIKE CONCAT('%', LOWER(@q), '%')
            )
        `,
        { q }
      );

      return rows.map((row) => normalizeUpper(row.item)).filter(Boolean);
    };

    const appendSearchFilter = async (field, value) => {
      const q = normalizeText(value);
      if (!field || !q) return;

      if (field === "location") {
        pgFilters.push(
          `TRIM(CAST(location AS TEXT)) ILIKE ${addPgParam(`%${q}%`)}`
        );
        return;
      }

      if (field === "bom_id") {
        pgFilters.push(
          `TRIM(CAST(bom_id AS TEXT)) ILIKE ${addPgParam(`%${q}%`)}`
        );
        return;
      }

      if (field === "produced_item") {
        pgFilters.push(
          `TRIM(CAST(produced_item AS TEXT)) ILIKE ${addPgParam(`%${q}%`)}`
        );
        return;
      }

      if (field === "resource") {
        pgFilters.push(
          `TRIM(CAST(resource AS TEXT)) ILIKE ${addPgParam(`%${q}%`)}`
        );
        return;
      }

      if (field === "produced_item_desc") {
        const items = await findItemsByDescription(q);
        addProducedItemInFilter(items);
        return;
      }

      if (field === "item_release_flag") {
        const items = await findItemsByReleaseFlag(q);
        addProducedItemInFilter(items);
      }
    };

    await appendSearchFilter(searchBy1, query1);
    await appendSearchFilter(searchBy2, query2);

    const whereClause = pgFilters.length
      ? `WHERE ${pgFilters.join(" AND ")}`
      : "";

    const limitParam = addPgParam(pageSize);
    const offsetParam = addPgParam(offset);

    const producedResult = await pool.query(
      `
        WITH produced_all AS (
          SELECT
            TRIM(CAST(bp.bom_id AS TEXT)) AS bom_id,
            TRIM(CAST(bp.item AS TEXT)) AS produced_item,
            TRIM(CAST(bp.location AS TEXT)) AS location,
            CASE
              WHEN COALESCE(TRIM(CAST(bp.erp_bom_qty_produced_per AS TEXT)), '') IN ('1', '1.0', '1.00')
                THEN ''
              ELSE '1'
            END AS inferred_co_product_association
          FROM ${pgRef(T.bomProduced)} bp
          WHERE bp.bom_id IS NOT NULL
            AND TRIM(CAST(bp.bom_id AS TEXT)) <> ''
            AND bp.item IS NOT NULL
            AND TRIM(CAST(bp.item AS TEXT)) <> ''
        ),
        routing_all AS (
          SELECT
            TRIM(CAST(ibr.bom_id AS TEXT)) AS bom_id,
            TRIM(CAST(ibr.item AS TEXT)) AS produced_item,
            TRIM(CAST(ibr.routing_id AS TEXT)) AS original_routing_id,
            COALESCE(TRIM(CAST(ibr.erp_co_product_association AS TEXT)), '') AS erp_co_product_association,
            COALESCE(
              NULLIF(
                TRIM(
                  regexp_replace(
                    TRIM(CAST(ibr.routing_id AS TEXT)),
                    '^([^_]*_){2}',
                    ''
                  )
                ),
                ''
              ),
              ''
            ) AS resource
          FROM ${pgRef(T.itemBomRouting)} ibr
          WHERE ibr.routing_id IS NOT NULL
            AND TRIM(CAST(ibr.routing_id AS TEXT)) <> ''
            AND ibr.bom_id IS NOT NULL
            AND TRIM(CAST(ibr.bom_id AS TEXT)) <> ''
        ),
        base_rows AS (
          SELECT
            pa.bom_id,
            pa.produced_item,
            pa.location,
            COALESCE(ra.resource, '') AS resource,
            CASE
              WHEN COALESCE(ra.resource, '') <> ''
                THEN CONCAT('ROUTING_', pa.produced_item, '_', ra.resource)
              ELSE ''
            END AS routing_id,
            COALESCE(
              NULLIF(ra.erp_co_product_association, ''),
              pa.inferred_co_product_association,
              ''
            ) AS erp_co_product_association
          FROM produced_all pa
          LEFT JOIN routing_all ra
            ON ra.bom_id = pa.bom_id
           AND UPPER(TRIM(CAST(ra.produced_item AS TEXT))) =
               UPPER(TRIM(CAST(pa.produced_item AS TEXT)))
        ),
        filtered_rows AS (
          SELECT *
          FROM base_rows
          ${whereClause}
        ),
        page_boms AS (
          SELECT
            bom_id,
            MIN(produced_item) AS sort_item,
            COUNT(*) OVER() AS total_count
          FROM filtered_rows
          GROUP BY bom_id
          ORDER BY bom_id, MIN(produced_item)
          LIMIT ${limitParam}
          OFFSET ${offsetParam}
        )
        SELECT
          br.bom_id,
          br.produced_item,
          br.location,
          br.resource,
          br.routing_id,
          br.erp_co_product_association,
          pb.total_count
        FROM base_rows br
        INNER JOIN page_boms pb
          ON pb.bom_id = br.bom_id
        ORDER BY
          br.bom_id,
          br.resource,
          br.location,
          CASE WHEN br.erp_co_product_association = '1' THEN 1 ELSE 0 END,
          br.produced_item,
          br.routing_id
      `,
      pgParams
    );

    const producedRows = producedResult.rows || [];

    const total = producedRows.length
      ? Number(producedRows[0].total_count || 0)
      : 0;

    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    const allPageItems = Array.from(
      new Set(
        producedRows
          .map((row) => normalizeUpper(row.produced_item))
          .filter(Boolean)
      )
    );

    const itemMasterRows = allPageItems.length
      ? await runBigQuery(
          `
            SELECT *
            FROM ${bqTableRefByKey("itemMaster")}
            WHERE UPPER(TRIM(CAST(item AS STRING))) IN UNNEST(@items)
          `,
          { items: allPageItems }
        )
      : [];

    const releaseFlagRows = allPageItems.length
      ? await runBigQuery(
          `
            SELECT *
            FROM ${bqTableRefByKey("itemReleaseFlag")}
            WHERE UPPER(TRIM(CAST(item AS STRING))) IN UNNEST(@items)
          `,
          { items: allPageItems }
        )
      : [];

    const itemDescMap = new Map();

    for (const row of itemMasterRows) {
      const itemKey = normalizeUpper(row.item);
      if (!itemKey) continue;

      const description = normalizeText(
        row.item_description ??
          row.description ??
          row.item_desc ??
          row.item_desc_1 ??
          ""
      );

      if (!itemDescMap.has(itemKey)) {
        itemDescMap.set(itemKey, description);
      }
    }

    const releaseFlagMap = new Map();

    for (const row of releaseFlagRows) {
      const itemKey = normalizeUpper(row.item);
      if (!itemKey) continue;

      const releaseFlag = normalizeText(
        row.item_releaseflag ??
          row.release_flag ??
          row.releaseflag ??
          row.mrp_release_flag ??
          row.item_mrp_rls_flg ??
          ""
      );

      if (!releaseFlagMap.has(itemKey)) {
        releaseFlagMap.set(itemKey, releaseFlag);
      }
    }

    const mergedRows = producedRows.map((row) => {
      const bomId = normalizeText(row.bom_id);
      const producedItem = normalizeText(row.produced_item);
      const itemKey = normalizeUpper(producedItem);
      const location = normalizeText(row.location);
      const resource = normalizeText(row.resource);
      const routingId = resource
        ? `ROUTING_${producedItem}_${resource}`
        : normalizeText(row.routing_id);

      const erpCoProductAssociation = normalizeText(
        row.erp_co_product_association
      );

      const rowType =
        erpCoProductAssociation === "1" ? "COPRODUCT" : "MAIN";

      return {
        id: `${bomId}__${resource || "NORESOURCE"}__${location}__${producedItem}__${rowType}`,
        location,
        produced_item: producedItem,
        produced_item_desc: itemDescMap.get(itemKey) ?? "",
        bom_id: bomId,
        resource,
        routing_id: routingId,
        item_release_flag: releaseFlagMap.get(itemKey) ?? "",
        erp_co_product_association:
          erpCoProductAssociation === "1" ? "1" : "",
      };
    });

    return res.status(200).json({
      success: true,
      data: mergedRows,
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
        hasPrev: page > 1,
        hasNext: page < totalPages,
        searchBy1,
        query1,
        searchBy2,
        query2,
      },
    });
  } catch (error) {
    console.error("DB Error (existing-bom-search):", error);

    return res.status(500).json({
      success: false,
      error: "Failed to fetch existing BOM search rows",
      details: error.message,
    });
  }
});



router.get("/existing-bom-details", async (req, res) => {
  const client = await pool.connect();

  try {
    const bomId = String(req.query.bomId ?? "").trim();

    if (!bomId) {
      return res.status(400).json({
        status: "ERROR",
        message: "bomId is required",
      });
    }

    const normalizeText = (value) =>
      value == null ? "" : String(value).trim();

    const normalizeItemKey = (value) =>
      normalizeText(value).toUpperCase();

    const normalizeItemDetailsToMap = (detailsResult) => {
      if (detailsResult instanceof Map) {
        const map = new Map();

        for (const [key, value] of detailsResult.entries()) {
          const itemKey = normalizeItemKey(key || value?.item);
          if (!itemKey) continue;

          map.set(itemKey, {
            item: normalizeText(value?.item ?? key),
            item_desc: normalizeText(
              value?.item_desc ??
                value?.item_description ??
                value?.description
            ),
            item_release_flag: normalizeText(
              value?.item_release_flag ??
                value?.item_releaseflag ??
                value?.release
            ),
          });
        }

        return map;
      }

      if (Array.isArray(detailsResult)) {
        const map = new Map();

        detailsResult.forEach((row) => {
          const itemKey = normalizeItemKey(row?.item);
          if (!itemKey) return;

          map.set(itemKey, {
            item: normalizeText(row?.item),
            item_desc: normalizeText(
              row?.item_desc ??
                row?.item_description ??
                row?.description
            ),
            item_release_flag: normalizeText(
              row?.item_release_flag ??
                row?.item_releaseflag ??
                row?.release
            ),
          });
        });

        return map;
      }

      if (detailsResult && typeof detailsResult === "object") {
        const map = new Map();

        Object.entries(detailsResult).forEach(([key, value]) => {
          const itemKey = normalizeItemKey(key || value?.item);
          if (!itemKey) return;

          map.set(itemKey, {
            item: normalizeText(value?.item ?? key),
            item_desc: normalizeText(
              value?.item_desc ??
                value?.item_description ??
                value?.description
            ),
            item_release_flag: normalizeText(
              value?.item_release_flag ??
                value?.item_releaseflag ??
                value?.release
            ),
          });
        });

        return map;
      }

      return new Map();
    };

    const parseBomIdParts = (value) => {
      const text = normalizeText(value);

      if (!text) {
        return {
          bomVersion: "",
          producedItem: "",
          location: "",
        };
      }

      const parts = text.split("_").filter(Boolean);

      if (parts.length < 3) {
        return {
          bomVersion: parts[0] ?? "",
          producedItem: parts[1] ?? "",
          location: parts[2] ?? "",
        };
      }

      return {
        bomVersion: parts[0] ?? "",
        producedItem: parts.slice(1, parts.length - 1).join("_"),
        location: parts[parts.length - 1] ?? "",
      };
    };

    const parseResourceFromRoutingId = (routingId) => {
      const text = normalizeText(routingId);
      if (!text) return "";

      const parts = text.split("_");
      if (parts.length < 3) return "";

      return parts.slice(2).join("_").trim();
    };

    const parsed = parseBomIdParts(bomId);

    /**
     * Prefer query values if frontend sends them.
     * Fallback to parsed BOM ID.
     */
    const producedItem = normalizeText(req.query.producedItem) || parsed.producedItem;
    const location = normalizeText(req.query.location) || parsed.location;
    const bomVersion = parsed.bomVersion;

    const resourcesQuery = `
      SELECT DISTINCT
        routing_id
      FROM ${pgRef(T.itemBomRouting)}
      WHERE TRIM(COALESCE(bom_id, '')) = TRIM($1)
        AND TRIM(COALESCE(routing_id, '')) <> ''
      ORDER BY routing_id
    `;

    const resourcesResult = await client.query(resourcesQuery, [bomId]);

    const resourceMap = new Map();

    (resourcesResult.rows || []).forEach((row, index) => {
      const routingId = normalizeText(row.routing_id);
      if (!routingId) return;

      const resource = parseResourceFromRoutingId(routingId);
      if (!resource) return;

      const key = resource.toUpperCase();

      if (!resourceMap.has(key)) {
        resourceMap.set(key, {
          id: `resource-${index + 1}`,
          resource,
          routing_id: routingId,
        });
      }
    });

    const componentsQuery = `
      SELECT
        rec_id,
        item AS component_item,
        erp_bom_quantity_consumed_per AS standard_usage
      FROM ${pgRef(T.bomConsumed)}
      WHERE TRIM(COALESCE(bom_id, '')) = TRIM($1)
      ORDER BY rec_id NULLS LAST, item
    `;

    const componentsResult = await client.query(componentsQuery, [bomId]);

    const coProductsQuery = `
      SELECT DISTINCT ON (UPPER(TRIM(ibr.item)))
        COALESCE(bp.rec_id, ibr.rec_id) AS rec_id,
        TRIM(ibr.item) AS co_product_item,
        bp.erp_bom_qty_produced_per AS qty_produced_per
      FROM ${pgRef(T.itemBomRouting)} ibr
      LEFT JOIN ${pgRef(T.bomProduced)} bp
        ON TRIM(COALESCE(bp.bom_id, '')) = TRIM(COALESCE(ibr.bom_id, ''))
       AND TRIM(COALESCE(bp.item, '')) = TRIM(COALESCE(ibr.item, ''))
      WHERE TRIM(COALESCE(ibr.bom_id, '')) = TRIM($1)
        AND COALESCE(ibr.erp_co_product_association, 0) = 1
        AND TRIM(COALESCE(ibr.item, '')) <> TRIM($2)
      ORDER BY UPPER(TRIM(ibr.item)), COALESCE(bp.rec_id, ibr.rec_id) NULLS LAST
    `;

    const coProductsResult = await client.query(coProductsQuery, [
      bomId,
      producedItem,
    ]);

    const componentRows = componentsResult.rows || [];
    const coProductRows = coProductsResult.rows || [];

    /**
     * Collect all items for GCP enrichment:
     * - produced item
     * - component item(s)
     * - co-product item(s)
     */
    const allItems = [
      producedItem,
      ...componentRows.map((row) => row.component_item),
      ...coProductRows.map((row) => row.co_product_item),
    ]
      .map((value) => normalizeText(value))
      .filter(Boolean);

    const uniqueItems = [...new Set(allItems)];

    const itemDetailsRaw =
      await fetchItemMasterReleaseDetailsByItems(uniqueItems);

    const itemDetailsMap = normalizeItemDetailsToMap(itemDetailsRaw);

    const getItemDetails = (item) => {
      const key = normalizeItemKey(item);

      return (
        itemDetailsMap.get(key) || {
          item: normalizeText(item),
          item_desc: "",
          item_release_flag: "",
        }
      );
    };

    const producedDetails = getItemDetails(producedItem);

    const components = componentRows.map((row, index) => {
      const componentItem = normalizeText(row.component_item);
      const details = getItemDetails(componentItem);

      return {
        id: row.rec_id ?? `component-${index + 1}`,

        component_item: componentItem,

        // Explicit separate fields for frontend
        item: componentItem,
        item_desc: details.item_desc || "",
        item_description: details.item_desc || "",

        standard_usage: row.standard_usage ?? "",
      };
    });

    const coProductMap = new Map();

    coProductRows.forEach((row, index) => {
      const coProductItem = normalizeText(row.co_product_item);
      if (!coProductItem) return;

      const key = coProductItem.toUpperCase();
      if (coProductMap.has(key)) return;

      const details = getItemDetails(coProductItem);

      coProductMap.set(key, {
        id: row.rec_id ?? `coproduct-${index + 1}`,

        co_product_item: coProductItem,

        // Explicit separate fields for frontend
        item: coProductItem,
        item_desc: details.item_desc || "",
        item_description: details.item_desc || "",

        qty_produced_per: row.qty_produced_per ?? "",
      });
    });

    const coProducts = Array.from(coProductMap.values());

    return res.json({
      status: "SUCCESS",

      selectedBom: {
        bom_id: bomId,
        bom_version: bomVersion,
        location,
        produced_item: producedItem,

        // From GCP item_master.item_desc
        produced_item_desc: producedDetails.item_desc || "",

        // From GCP item_mrp_rls_flg.release
        item_release_flag: producedDetails.item_release_flag || "",
      },

      resources: Array.from(resourceMap.values()),

      components,

      coProducts,
    });
  } catch (error) {
    console.error("DB Error (existing-bom-details):", error);

    return res.status(500).json({
      status: "ERROR",
      message: "Failed to fetch existing BOM details",
      details: error.message,
    });
  } finally {
    client.release();
  }
});



/**
 * Optional fallback route if frontend reloads page and only route param id is present.
 * This is useful because your frontend currently supports a fallback by id as well.
 */


router.get("/existing-bom-details-by-id/:id", async (req, res) => {
  const client = await pool.connect();

  try {
    const id = String(req.params.id ?? "").trim();

    if (!id) {
      return res.status(400).json({
        status: "ERROR",
        message: "id is required",
      });
    }

    /**
     * Initial load:
     * PostgreSQL gives BOM structure.
     * GCP BigQuery gives:
     * - item_desc from item_master
     * - item_release_flag from item_mrp_rls_flg.release
     */
    const headerQuery = `
      SELECT
        bom_id,
        location,
        item AS produced_item
      FROM ${pgRef(T.itemBomRouting)}
      WHERE TRIM(COALESCE(bom_id, '')) = TRIM($1)
      ORDER BY bom_id
      LIMIT 1
    `;

    const headerResult = await client.query(headerQuery, [id]);

    if (!headerResult.rows?.length) {
      return res.status(404).json({
        status: "ERROR",
        message: "No BOM found for given id",
      });
    }

    const header = headerResult.rows[0];

    const bomId = header.bom_id ?? "";
    const location = header.location ?? "";
    const producedItem = header.produced_item ?? "";

    const resourcesQuery = `
      SELECT DISTINCT
        resource
      FROM ${pgRef(T.itemBomRouting)}
      WHERE TRIM(COALESCE(bom_id, '')) = TRIM($1)
        AND TRIM(COALESCE(location, '')) = TRIM($2)
        AND TRIM(COALESCE(item, '')) = TRIM($3)
        AND TRIM(COALESCE(resource, '')) <> ''
      ORDER BY resource
    `;

    const componentsQuery = `
      SELECT
        rec_id,
        item AS component_item,
        erp_bom_quantity_consumed_per AS standard_usage
      FROM ${pgRef(T.bomConsumed)}
      WHERE TRIM(COALESCE(bom_id, '')) = TRIM($1)
        AND TRIM(COALESCE(location, '')) = TRIM($2)
        AND TRIM(COALESCE(produced_item, '')) = TRIM($3)
      ORDER BY rec_id NULLS LAST, item
    `;

    const coProductsQuery = `
      SELECT
        COALESCE(bp.rec_id, ibr.rec_id) AS rec_id,
        ibr.item AS co_product_item,
        bp.erp_bom_qty_produced_per AS qty_produced_per
      FROM ${pgRef(T.itemBomRouting)} ibr
      LEFT JOIN ${pgRef(T.bomProduced)} bp
        ON TRIM(COALESCE(bp.bom_id, '')) = TRIM(COALESCE(ibr.bom_id, ''))
       AND TRIM(COALESCE(bp.location, '')) = TRIM(COALESCE(ibr.location, ''))
       AND TRIM(COALESCE(bp.item, '')) = TRIM(COALESCE(ibr.item, ''))
      WHERE TRIM(COALESCE(ibr.bom_id, '')) = TRIM($1)
        AND TRIM(COALESCE(ibr.location, '')) = TRIM($2)
        AND TRIM(COALESCE(ibr.item, '')) <> TRIM($3)
        AND COALESCE(ibr.erp_co_product_association, 0) = 1
      ORDER BY COALESCE(bp.rec_id, ibr.rec_id) NULLS LAST, ibr.item
    `;

    const [resourcesResult, componentsResult, coProductsResult] =
      await Promise.all([
        client.query(resourcesQuery, [bomId, location, producedItem]),
        client.query(componentsQuery, [bomId, location, producedItem]),
        client.query(coProductsQuery, [bomId, location, producedItem]),
      ]);

    const componentRows = componentsResult.rows || [];
    const coProductRows = coProductsResult.rows || [];

    /**
     * Collect all items that need GCP enrichment:
     * - produced item
     * - component items
     * - co-product items
     */
    const allItems = [
      producedItem,
      ...componentRows.map((row) => row.component_item),
      ...coProductRows.map((row) => row.co_product_item),
    ]
      .map((value) => String(value ?? "").trim())
      .filter(Boolean);

    /**
     * Helper should fetch:
     * - item_desc from GCP item_master
     * - item_release_flag from GCP item_mrp_rls_flg.release
     *
     * Expected return:
     * Map keyed by UPPER(item)
     * {
     *   item,
     *   item_desc,
     *   item_release_flag
     * }
     */
    const itemDetailsMap = await fetchItemMasterReleaseDetailsByItems(allItems);

    const getItemDetails = (item) => {
      const key = String(item ?? "").trim().toUpperCase();

      return (
        itemDetailsMap.get(key) || {
          item: String(item ?? "").trim(),
          item_desc: "",
          item_release_flag: "",
        }
      );
    };

    const producedDetails = getItemDetails(producedItem);

    return res.json({
      status: "SUCCESS",

      selectedBom: {
        bom_id: bomId,
        location,
        produced_item: producedItem,

        // From GCP item_master.item_desc
        produced_item_desc: producedDetails.item_desc || "",

        // From GCP item_mrp_rls_flg.release
        item_release_flag: producedDetails.item_release_flag || "",
      },

      resources: (resourcesResult.rows || []).map((row, index) => ({
        id: `resource-${index + 1}`,
        resource: row.resource ?? "",
      })),

      components: componentRows.map((row, index) => {
        const componentItem = row.component_item ?? "";
        const details = getItemDetails(componentItem);

        return {
          id: row.rec_id ?? `component-${index + 1}`,

          // Keep existing frontend field
          component_item: componentItem,

          // Explicit separate fields
          item: componentItem,
          item_desc: details.item_desc || "",
          item_description: details.item_desc || "",

          standard_usage: row.standard_usage ?? "",
        };
      }),

      coProducts: coProductRows.map((row, index) => {
        const coProductItem = row.co_product_item ?? "";
        const details = getItemDetails(coProductItem);

        return {
          id: row.rec_id ?? `coproduct-${index + 1}`,

          // Keep existing frontend field
          co_product_item: coProductItem,

          // Explicit separate fields
          item: coProductItem,
          item_desc: details.item_desc || "",
          item_description: details.item_desc || "",

          qty_produced_per: row.qty_produced_per ?? "",
        };
      }),
    });
  } catch (error) {
    console.error("DB Error (existing-bom-details-by-id):", error);

    return res.status(500).json({
      status: "ERROR",
      message: "Failed to fetch existing BOM details by id",
      details: error.message,
    });
  } finally {
    client.release();
  }
});


router.put("/modify-bom", async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const payload = req.body || {};
    const bomId = String(payload.bomId || "").trim();
    const producedItem = payload.producedItem || {};
    const engineeringChange = payload.engineeringChange || {};
    const notes = String(payload.notes || "").trim();
    const locations = Array.isArray(payload.locations) ? payload.locations : [];

    const changedBy = getSystemUserName(req);

    const getChicagoDateTimeFormatted = () => {
      const formatter = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "America/Chicago",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });

      const parts = formatter.formatToParts(new Date());
      const map = {};

      for (const part of parts) {
        if (part.type !== "literal") {
          map[part.type] = part.value;
        }
      }

      return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
    };

    if (!bomId) {
      throw new Error("bomId is required");
    }

    if (!locations.length) {
      throw new Error("At least one location is required");
    }

    const chicagoAuditTs = getChicagoDateTimeFormatted();

    const toText = (value) => String(value ?? "").trim();

    const getResourceFromRoutingId = (routingId) => {
      const parts = String(routingId || "")
        .split("_")
        .map((p) => p.trim())
        .filter(Boolean);

      // Correct format: ROUTING_Item_resource
      // Resource starts after ROUTING + Item.
      return parts.length >= 3 ? parts.slice(2).join("_") : "";
    };

    const buildRoutingId = (item, resource) => {
      const cleanItem = toText(item);
      const cleanResource = toText(resource);

      if (!cleanItem || !cleanResource) return "";

      return `ROUTING_${cleanItem}_${cleanResource}`;
    };

    const normalizeRoutingIdForRow = (row, fallbackResource = "") => {
      const item = toText(row?.item);
      const resource =
        toText(row?.resource) ||
        toText(fallbackResource) ||
        getResourceFromRoutingId(row?.routing_id);

      return buildRoutingId(item, resource) || toText(row?.routing_id);
    };

    const resolvePrimaryIdColumn = async (tableName) => {
      const columns = await getExistingColumns(client, tableName);

      if (columns.includes("postgresql_rec_id")) return "postgresql_rec_id";
      if (columns.includes("rec_id")) return "rec_id";
      if (columns.includes("record_id")) return "record_id";
      if (columns.includes("recordid")) return "recordid";
      if (columns.includes("id")) return "id";

      return null;
    };

    const getResolvedRowId = (row, idColumn) => {
      if (!row) return null;
      return (
        row[idColumn] ??
        row.postgresql_rec_id ??
        row.rec_id ??
        row.record_id ??
        row.recordid ??
        row.id ??
        null
      );
    };

    const buildModifiedSummary = (title, changes) => {
      const validChanges = (changes || []).filter(Boolean);
      if (!validChanges.length) {
        return "";
      }
      return `Modified the ${title}.`;
    };

    const buildConsolidatedModifiedSummary = (categories) => {
      const cleaned = Array.from(new Set((categories || []).filter(Boolean)));

      if (!cleaned.length) {
        return "Modified BOM records";
      }

      if (cleaned.length === 1) {
        return `Modified the ${cleaned[0]}.`;
      }

      const stripInformation = (value) =>
        String(value || "")
          .replace(/\s+information$/i, "")
          .trim();

      const baseLabels = cleaned.map(stripInformation);

      const joinedBase =
        baseLabels.length === 2
          ? `${baseLabels[0]} & ${baseLabels[1]}`
          : `${baseLabels.slice(0, -1).join(", ")}, and ${
              baseLabels[baseLabels.length - 1]
            }`;

      const suffix = cleaned.every((value) =>
        /information$/i.test(String(value || ""))
      )
        ? " information"
        : "";

      return `Modified the ${joinedBase}${suffix}.`;
    };

    const buildConsumedKey = (row) =>
      [toText(row?.bom_id), toText(row?.location), toText(row?.item)].join("__");

    const buildProducedKey = (row) =>
      [toText(row?.bom_id), toText(row?.location), toText(row?.item)].join("__");

    const buildRoutingKey = (row, fallbackResource = "") => {
      const routingId = normalizeRoutingIdForRow(row, fallbackResource);
      const coProductFlag =
        Number(row?.erp_co_product_association ?? 0) === 1 ? "1" : "0";

      return [
        toText(row?.bom_id),
        routingId,
        toText(row?.item),
        coProductFlag,
      ].join("__");
    };

    const deleteExactRowById = async (tableName, idColumn, row) => {
      const resolvedId = getResolvedRowId(row, idColumn);
      if (resolvedId == null || String(resolvedId).trim() === "") {
        throw new Error(`Could not resolve row id for delete in ${tableName}`);
      }

      await client.query(
        `
        DELETE FROM ${pgRef(tableName)}
        WHERE ${quoteIdent(idColumn)} = $1
        `,
        [resolvedId]
      );
    };

    const archiveOnly = async ({
      sourceTable,
      archiveTable,
      sourceRow,
      actualRecId,
      logProducedItem,
      logItem,
      logLocation,
      logResource,
      summaryText,
      summaryCategory,
    }) => {
      const archiveExists = await pgTableExists(client, archiveTable);
      if (!archiveExists) {
        throw new Error(`Archive table ${archiveTable} does not exist`);
      }

      const archiveColumns = await getExistingColumns(client, archiveTable);
      const archiveRow = { ...sourceRow };

      delete archiveRow.postgresql_rec_id;

      if (archiveColumns.includes("engineering_change_id")) {
        archiveRow.engineering_change_id = engineeringChangeId;
      }
      if (archiveColumns.includes("engineeringchangeid")) {
        archiveRow.engineeringchangeid = engineeringChangeId;
      }

      if (archiveColumns.includes("change_type")) {
        archiveRow.change_type = "Modified";
      }
      if (archiveColumns.includes("changetype")) {
        archiveRow.changetype = "Modified";
      }

      if (archiveColumns.includes("notes")) {
        archiveRow.notes = notes || "";
      }
      if (archiveColumns.includes("summarynotes")) {
        archiveRow.summarynotes = notes || "";
      }
      if (archiveColumns.includes("change_summary")) {
        archiveRow.change_summary = summaryText || "";
      }

      if (archiveColumns.includes("source_table")) {
        archiveRow.source_table = sourceTable;
      }
      if (archiveColumns.includes("source_rec_id")) {
        archiveRow.source_rec_id = actualRecId;
      }
      if (archiveColumns.includes("original_rec_id")) {
        archiveRow.original_rec_id = actualRecId;
      }

      if (archiveColumns.includes("archived_at")) {
        archiveRow.archived_at = chicagoAuditTs;
      }
      if (archiveColumns.includes("archived_on")) {
        archiveRow.archived_on = chicagoAuditTs;
      }
      if (archiveColumns.includes("deleted_at")) {
        archiveRow.deleted_at = chicagoAuditTs;
      }
      if (archiveColumns.includes("deleted_on")) {
        archiveRow.deleted_on = chicagoAuditTs;
      }

      const { query, values } = buildDynamicInsertQuery(
        archiveTable,
        archiveRow,
        archiveColumns
      );

      await client.query(query, values);

      if (logLocation) {
        consolidatedLocations.add(String(logLocation).trim());
      }
      if (logResource) {
        consolidatedResources.add(String(logResource).trim());
      }
      if (logProducedItem) {
        consolidatedItems.add(String(logProducedItem).trim());
      }
      if (logItem) {
        consolidatedItems.add(String(logItem).trim());
      }
      if (summaryCategory) {
        consolidatedSummaryCategories.add(String(summaryCategory).trim());
      }
    };

    const archiveManyRows = async ({
      sourceTable,
      archiveTable,
      rows,
      idColumn,
      logProducedItem,
      logLocation,
      logResource,
      summaryText,
      summaryCategory,
      rowLogItemSelector,
    }) => {
      for (const row of rows || []) {
        const actualRecId = getResolvedRowId(row, idColumn);
        if (actualRecId == null || String(actualRecId).trim() === "") {
          throw new Error(
            `Could not resolve live row id for ${sourceTable} using column ${idColumn}`
          );
        }

        await archiveOnly({
          sourceTable,
          archiveTable,
          sourceRow: row,
          actualRecId,
          logProducedItem: logProducedItem || "",
          logItem: rowLogItemSelector ? rowLogItemSelector(row) : "",
          logLocation: logLocation || "",
          logResource: logResource || "",
          summaryText,
          summaryCategory,
        });
      }
    };

    const engineeringChangeId = generateUniqueId("EC-");
    const derivedBomVersion = getBomVersionFromBomId(bomId);

    const changeLogTable = T.changeLog;
    const changeLogColumns = await getExistingColumns(client, changeLogTable);

    const bomProducedIdColumn = await resolvePrimaryIdColumn(T.bomProduced);
    const itemBomRoutingIdColumn = await resolvePrimaryIdColumn(
      T.itemBomRouting
    );
    const bomConsumedIdColumn = await resolvePrimaryIdColumn(T.bomConsumed);
    const bomParametersIdColumn = await resolvePrimaryIdColumn(T.bomParameters);

    if (!bomProducedIdColumn) {
      throw new Error("Could not resolve primary id column for bom_produced");
    }
    if (!itemBomRoutingIdColumn) {
      throw new Error("Could not resolve primary id column for item_bom_routing");
    }
    if (!bomConsumedIdColumn) {
      throw new Error("Could not resolve primary id column for bom_consumed");
    }
    if (!bomParametersIdColumn) {
      throw new Error("Could not resolve primary id column for bom_parameters");
    }

    const consolidatedLocations = new Set();
    const consolidatedResources = new Set();
    const consolidatedSummaryCategories = new Set();
    const consolidatedItems = new Set();

    const firstLocation = locations[0] || {};
    const firstLocationName = String(firstLocation?.locationName || "").trim();
    const firstIncomingRoutingId = String(
      firstLocation?.resourceInfo?.routingId || ""
    ).trim();
    const firstResource =
      String(firstLocation?.resourceInfo?.resource || "").trim() ||
      (firstIncomingRoutingId
        ? getResourceFromRoutingId(firstIncomingRoutingId)
        : "");

    const paramsLiveResult = await client.query(
      `
      SELECT *
      FROM ${pgRef(T.bomParameters)}
      WHERE TRIM(CAST(bom_id AS TEXT)) = $1
      LIMIT 1
      `,
      [bomId]
    );

    if (!paramsLiveResult.rows.length) {
      throw new Error(`No matching bom_parameters row found for bom_id=${bomId}`);
    }

    const paramsLiveRow = paramsLiveResult.rows[0];
    const paramsActualRecId = getResolvedRowId(
      paramsLiveRow,
      bomParametersIdColumn
    );

    if (paramsActualRecId == null || String(paramsActualRecId).trim() === "") {
      throw new Error(
        `Could not resolve live row id for bom_parameters using column ${bomParametersIdColumn}`
      );
    }

    const parameterChanges = [];
    if (
      String(paramsLiveRow.erp_bom_start_date ?? "") !==
      String(engineeringChange.creationDate ?? "")
    ) {
      parameterChanges.push(
        `BOM Start Date (${paramsLiveRow.erp_bom_start_date ?? ""} -> ${
          engineeringChange.creationDate ?? ""
        })`
      );
    }

    await archiveOnly({
      sourceTable: T.bomParameters,
      archiveTable: T.bomParametersOg,
      sourceRow: paramsLiveRow,
      actualRecId: paramsActualRecId,
      logProducedItem: producedItem.item || "",
      logItem: producedItem.item || "",
      logLocation: firstLocationName,
      logResource: firstResource,
      summaryText: "",
      summaryCategory: parameterChanges.length ? "parameter information" : "",
    });

    await client.query(
      `
      UPDATE ${pgRef(T.bomParameters)}
      SET
        erp_bom_start_date = $1,
        erp_bom_end_date = $2,
        load_datetime = $3
      WHERE ${quoteIdent(bomParametersIdColumn)} = $4
      `,
      [
        HARD_CODED_START_DATE,
        HARD_CODED_END_DATE,
        HARD_CODED_LOAD_DATETIME,
        paramsActualRecId,
      ]
    );

    for (const location of locations) {
      const locationName = String(location?.locationName || "").trim();
      const incomingRoutingId = String(
        location?.resourceInfo?.routingId || ""
      ).trim();

      const priority =
        location?.resourceInfo?.priority === "" ||
        location?.resourceInfo?.priority == null
          ? null
          : Number(location.resourceInfo.priority);

      const resource =
        String(location?.resourceInfo?.resource || "").trim() ||
        (incomingRoutingId ? getResourceFromRoutingId(incomingRoutingId) : "");

      if (!locationName) {
        throw new Error("locationName is required in locations");
      }

      if (!resource) {
        throw new Error(
          "resource is required in resourceInfo or derivable from routingId"
        );
      }

      const mainRoutingId =
        buildRoutingId(producedItem.item, resource) || incomingRoutingId;

      if (!mainRoutingId) {
        throw new Error("routingId could not be derived");
      }

      const requestedComponentItems = Array.isArray(location?.componentItems)
        ? location.componentItems
        : [];

      const requestedCoProductItems = Array.isArray(location?.coProductItems)
        ? location.coProductItems
        : [];

      const liveProducedResult = await client.query(
        `
        SELECT *
        FROM ${pgRef(T.bomProduced)}
        WHERE TRIM(CAST(bom_id AS TEXT)) = $1
          AND TRIM(CAST(location AS TEXT)) = $2
        ORDER BY load_datetime DESC NULLS LAST, ${quoteIdent(
          bomProducedIdColumn
        )} DESC
        `,
        [bomId, locationName]
      );

      const liveProducedRows = liveProducedResult.rows || [];

      if (!liveProducedRows.length) {
        throw new Error(
          `No matching bom_produced rows found for bom_id=${bomId}, location=${locationName}`
        );
      }

      const primaryProducedLiveRow =
        liveProducedRows.find(
          (row) => toText(row.item) === toText(producedItem.item)
        ) ||
        liveProducedRows.find(
          (row) => Number(row.erp_bom_qty_produced_per ?? 0) === 1
        ) ||
        liveProducedRows[0];

      const liveCoProductRows = liveProducedRows.filter(
        (row) => toText(row.item) !== toText(primaryProducedLiveRow?.item)
      );

      const producedChanges = [];
      if (
        String(primaryProducedLiveRow?.item ?? "") !==
        String(producedItem.item ?? "")
      ) {
        producedChanges.push(
          `Produced Item (${primaryProducedLiveRow?.item ?? ""} -> ${
            producedItem.item ?? ""
          })`
        );
      }

      if (
        String(primaryProducedLiveRow?.bom_status ?? "") !==
        String(producedItem.status ?? "")
      ) {
        producedChanges.push(
          `BOM Status (${primaryProducedLiveRow?.bom_status ?? ""} -> ${
            producedItem.status ?? ""
          })`
        );
      }

      await archiveManyRows({
        sourceTable: T.bomProduced,
        archiveTable: T.bomProducedOg,
        rows: liveProducedRows,
        idColumn: bomProducedIdColumn,
        logProducedItem: producedItem.item || "",
        logLocation: locationName,
        logResource: resource,
        summaryText: buildModifiedSummary(
          "co-product information",
          producedChanges
        ),
        summaryCategory:
          producedChanges.length || requestedCoProductItems.length
            ? "co-product information"
            : "",
        rowLogItemSelector: (row) => row?.item || "",
      });

      const primaryProducedActualRecId = getResolvedRowId(
        primaryProducedLiveRow,
        bomProducedIdColumn
      );

      await client.query(
        `
        UPDATE ${pgRef(T.bomProduced)}
        SET
          item = $1,
          location = $2,
          bom_status = $3,
          bom_version = $4,
          prefix = $5,
          bom_plan_type = $6,
          erp_bom_qty_produced_per = $7,
          load_datetime = $8
        WHERE ${quoteIdent(bomProducedIdColumn)} = $9
        `,
        [
          producedItem.item || null,
          locationName,
          HARD_CODED_BOM_STATUS,
          derivedBomVersion || null,
          HARD_CODED_PREFIX,
          HARD_CODED_BOM_PLAN_TYPE,
          1,
          HARD_CODED_LOAD_DATETIME,
          primaryProducedActualRecId,
        ]
      );

      const liveCoProductMap = new Map(
        liveCoProductRows.map((row) => [buildProducedKey(row), row])
      );

      const requestedCoProductMap = new Map();

      for (const cp of requestedCoProductItems) {
        const coProductItem = String(cp?.coProductItem || "").trim();
        const standardUsage =
          cp?.standardUsage === "" || cp?.standardUsage == null
            ? null
            : Number(cp.standardUsage);

        if (!coProductItem) continue;

        const key = [bomId, locationName, coProductItem].join("__");
        requestedCoProductMap.set(key, {
          coProductItem,
          standardUsage,
        });

        const existingRow = liveCoProductMap.get(key) || null;

        if (existingRow) {
          const existingRecId = getResolvedRowId(
            existingRow,
            bomProducedIdColumn
          );

          await client.query(
            `
            UPDATE ${pgRef(T.bomProduced)}
            SET
              item = $1,
              location = $2,
              bom_status = $3,
              bom_version = $4,
              prefix = $5,
              bom_plan_type = $6,
              erp_bom_qty_produced_per = $7,
              load_datetime = $8
            WHERE ${quoteIdent(bomProducedIdColumn)} = $9
            `,
            [
              coProductItem,
              locationName,
              HARD_CODED_BOM_STATUS,
              derivedBomVersion || null,
              HARD_CODED_PREFIX,
              HARD_CODED_BOM_PLAN_TYPE,
              standardUsage,
              HARD_CODED_LOAD_DATETIME,
              existingRecId,
            ]
          );
        } else {
          const producedColumns = await getExistingColumns(
            client,
            T.bomProduced
          );
          const templateRow = { ...primaryProducedLiveRow };

          delete templateRow.postgresql_rec_id;

          const newProducedRow = {
            ...templateRow,
            bom_id: bomId,
            item: coProductItem,
            location: locationName,
            bom_status: HARD_CODED_BOM_STATUS,
            bom_version: derivedBomVersion || null,
            prefix: HARD_CODED_PREFIX,
            bom_plan_type: HARD_CODED_BOM_PLAN_TYPE,
            erp_bom_qty_produced_per: standardUsage,
            load_datetime: HARD_CODED_LOAD_DATETIME,
            rec_id: generateUniqueBigInt(),
          };

          const producedInsert = buildInsertQuery(
            T.bomProduced,
            newProducedRow,
            producedColumns
          );

          await client.query(producedInsert.query, producedInsert.values);
        }

        consolidatedItems.add(coProductItem);
        consolidatedLocations.add(locationName);
        if (resource) consolidatedResources.add(resource);
        consolidatedSummaryCategories.add("co-product information");
      }

      for (const row of liveCoProductRows) {
        const key = buildProducedKey(row);
        if (requestedCoProductMap.has(key)) continue;

        await deleteExactRowById(T.bomProduced, bomProducedIdColumn, row);
        consolidatedSummaryCategories.add("co-product information");
      }

      const liveRoutingResult = await client.query(
        `
        SELECT *
        FROM ${pgRef(T.itemBomRouting)}
        WHERE TRIM(CAST(bom_id AS TEXT)) = $1
          AND TRIM(regexp_replace(TRIM(CAST(routing_id AS TEXT)), '^([^_]*_){2}', '')) = $2
        ORDER BY load_datetime DESC NULLS LAST, ${quoteIdent(
          itemBomRoutingIdColumn
        )} DESC
        `,
        [bomId, resource]
      );

      const liveRoutingRows = liveRoutingResult.rows || [];

      if (!liveRoutingRows.length) {
        throw new Error(
          `No matching item_bom_routing rows found for bom_id=${bomId}, resource=${resource}`
        );
      }

      const primaryRoutingLiveRow =
        liveRoutingRows.find(
          (row) =>
            toText(row.item) === toText(producedItem.item) &&
            Number(row.erp_co_product_association ?? 0) !== 1
        ) ||
        liveRoutingRows.find(
          (row) => Number(row.erp_co_product_association ?? 0) !== 1
        ) ||
        liveRoutingRows[0];

      const liveCoProductRoutingRows = liveRoutingRows.filter(
        (row) => Number(row.erp_co_product_association ?? 0) === 1
      );

      const routingChanges = [];

      if (
        String(primaryRoutingLiveRow?.routing_id ?? "") !==
        String(mainRoutingId ?? "")
      ) {
        routingChanges.push(
          `Routing ID (${primaryRoutingLiveRow?.routing_id ?? ""} -> ${
            mainRoutingId ?? ""
          })`
        );
      }

      if (
        String(primaryRoutingLiveRow?.erp_item_bom_routing_priority ?? "") !==
        String(priority ?? "")
      ) {
        routingChanges.push(
          `Routing Priority (${
            primaryRoutingLiveRow?.erp_item_bom_routing_priority ?? ""
          } -> ${priority ?? ""})`
        );
      }

      await archiveManyRows({
        sourceTable: T.itemBomRouting,
        archiveTable: T.itemBomRoutingOg,
        rows: liveRoutingRows,
        idColumn: itemBomRoutingIdColumn,
        logProducedItem: producedItem.item || "",
        logLocation: locationName,
        logResource: resource,
        summaryText: buildModifiedSummary(
          "routing information",
          routingChanges
        ),
        summaryCategory:
          routingChanges.length || requestedCoProductItems.length
            ? "routing information"
            : "",
        rowLogItemSelector: (row) => row?.item || "",
      });

      const primaryRoutingActualRecId = getResolvedRowId(
        primaryRoutingLiveRow,
        itemBomRoutingIdColumn
      );

      await client.query(
        `
        UPDATE ${pgRef(T.itemBomRouting)}
        SET
          item = $1,
          routing_id = $2,
          erp_item_bom_routing_priority = $3,
          erp_co_product_association = $4,
          load_datetime = $5
        WHERE ${quoteIdent(itemBomRoutingIdColumn)} = $6
        `,
        [
          producedItem.item || primaryRoutingLiveRow.item || null,
          mainRoutingId || primaryRoutingLiveRow.routing_id || null,
          priority,
          0,
          HARD_CODED_LOAD_DATETIME,
          primaryRoutingActualRecId,
        ]
      );

      const liveCoProductRoutingMap = new Map(
        liveCoProductRoutingRows.map((row) => [
          buildRoutingKey(row, resource),
          row,
        ])
      );

      const requestedCoProductRoutingMap = new Map();

      for (const cp of requestedCoProductItems) {
        const coProductItem = String(cp?.coProductItem || "").trim();
        if (!coProductItem) continue;

        const coProductRoutingId = buildRoutingId(coProductItem, resource);
        const key = [bomId, coProductRoutingId, coProductItem, "1"].join("__");
        requestedCoProductRoutingMap.set(key, true);

        const existingRoutingRow = liveCoProductRoutingMap.get(key) || null;

        if (existingRoutingRow) {
          const existingRoutingRecId = getResolvedRowId(
            existingRoutingRow,
            itemBomRoutingIdColumn
          );

          await client.query(
            `
            UPDATE ${pgRef(T.itemBomRouting)}
            SET
              item = $1,
              routing_id = $2,
              erp_item_bom_routing_priority = $3,
              erp_co_product_association = $4,
              load_datetime = $5
            WHERE ${quoteIdent(itemBomRoutingIdColumn)} = $6
            `,
            [
              coProductItem,
              coProductRoutingId,
              priority,
              1,
              HARD_CODED_LOAD_DATETIME,
              existingRoutingRecId,
            ]
          );
        } else {
          const routingColumns = await getExistingColumns(
            client,
            T.itemBomRouting
          );
          const routingTemplate = { ...primaryRoutingLiveRow };

          delete routingTemplate.postgresql_rec_id;

          const newRoutingRow = {
            ...routingTemplate,
            bom_id: bomId,
            item: coProductItem,
            routing_id: coProductRoutingId,
            erp_item_bom_routing_priority: priority,
            erp_item_bom_routing_min_lot_size:
              primaryRoutingLiveRow?.erp_item_bom_routing_min_lot_size ?? 1,
            erp_item_bom_routing_lot_size_increment:
              primaryRoutingLiveRow?.erp_item_bom_routing_lot_size_increment ??
              1,
            erp_item_bom_routing_wip_sweep_priority:
              primaryRoutingLiveRow?.erp_item_bom_routing_wip_sweep_priority ??
              primaryRoutingLiveRow?.erp_item_bom_wip_sweep_priority ??
              1,
            erp_item_bom_wip_sweep_priority:
              primaryRoutingLiveRow?.erp_item_bom_wip_sweep_priority ?? 1,
            erp_co_product_association: 1,
            erp_item_bom_routing_max_lot_size:
              primaryRoutingLiveRow?.erp_item_bom_routing_max_lot_size ?? null,
            load_datetime: HARD_CODED_LOAD_DATETIME,
            rec_id: generateUniqueBigInt(),
          };

          const routingInsert = buildInsertQuery(
            T.itemBomRouting,
            newRoutingRow,
            routingColumns
          );

          await client.query(routingInsert.query, routingInsert.values);
        }

        consolidatedItems.add(coProductItem);
        consolidatedLocations.add(locationName);
        if (resource) consolidatedResources.add(resource);
        consolidatedSummaryCategories.add("routing information");
      }

      for (const row of liveCoProductRoutingRows) {
        const key = buildRoutingKey(row, resource);
        if (requestedCoProductRoutingMap.has(key)) continue;

        await deleteExactRowById(T.itemBomRouting, itemBomRoutingIdColumn, row);
        consolidatedSummaryCategories.add("routing information");
      }

      const liveConsumedResult = await client.query(
        `
        SELECT *
        FROM ${pgRef(T.bomConsumed)}
        WHERE TRIM(CAST(bom_id AS TEXT)) = $1
          AND TRIM(CAST(location AS TEXT)) = $2
        ORDER BY load_datetime DESC NULLS LAST, ${quoteIdent(
          bomConsumedIdColumn
        )} DESC
        `,
        [bomId, locationName]
      );

      const liveConsumedRows = liveConsumedResult.rows || [];
      const bomConsumedColumns = await getExistingColumns(client, T.bomConsumed);

      await archiveManyRows({
        sourceTable: T.bomConsumed,
        archiveTable: T.bomConsumedOg,
        rows: liveConsumedRows,
        idColumn: bomConsumedIdColumn,
        logProducedItem: producedItem.item || "",
        logLocation: locationName,
        logResource: resource,
        summaryText: buildModifiedSummary(
          "component information",
          requestedComponentItems.map((c) => c?.componentItem).filter(Boolean)
        ),
        summaryCategory: requestedComponentItems.length
          ? "component information"
          : "",
        rowLogItemSelector: (row) => row?.item || "",
      });

      const liveConsumedMap = new Map(
        liveConsumedRows.map((row) => [buildConsumedKey(row), row])
      );

      const requestedConsumedMap = new Map();

      for (const component of requestedComponentItems) {
        const componentItem = String(component?.componentItem || "").trim();
        const standardUsage =
          component?.standardUsage === "" || component?.standardUsage == null
            ? null
            : Number(component.standardUsage);

        if (!componentItem) continue;

        const key = [bomId, locationName, componentItem].join("__");
        requestedConsumedMap.set(key, {
          componentItem,
          standardUsage,
        });

        const existingRow = liveConsumedMap.get(key) || null;

        if (existingRow) {
          const consumedActualRecId = getResolvedRowId(
            existingRow,
            bomConsumedIdColumn
          );

          await client.query(
            `
            UPDATE ${pgRef(T.bomConsumed)}
            SET
              item = $1,
              erp_bom_quantity_consumed_per = $2,
              erp_bom_component_start_date = $3,
              erp_bom_component_end_date = $4,
              load_datetime = $5
            WHERE ${quoteIdent(bomConsumedIdColumn)} = $6
            `,
            [
              componentItem,
              standardUsage,
              HARD_CODED_START_DATE,
              HARD_CODED_END_DATE,
              HARD_CODED_LOAD_DATETIME,
              consumedActualRecId,
            ]
          );
        } else {
          const templateConsumedRow = liveConsumedRows[0] || {};

          const newConsumedRow = {
            ...templateConsumedRow,
            bom_id: bomId,
            item: componentItem,
            location: locationName,
            erp_bom_quantity_consumed_per: standardUsage,
            erp_bom_component_start_date: HARD_CODED_START_DATE,
            erp_bom_component_end_date: HARD_CODED_END_DATE,
            load_datetime: HARD_CODED_LOAD_DATETIME,
            rec_id: generateUniqueBigInt(),
          };

          delete newConsumedRow.postgresql_rec_id;

          const consumedInsert = buildInsertQuery(
            T.bomConsumed,
            newConsumedRow,
            bomConsumedColumns
          );

          await client.query(consumedInsert.query, consumedInsert.values);
        }

        consolidatedItems.add(componentItem);
        consolidatedLocations.add(locationName);
        if (resource) consolidatedResources.add(resource);
        consolidatedSummaryCategories.add("component information");
      }

      for (const row of liveConsumedRows) {
        const key = buildConsumedKey(row);
        if (requestedConsumedMap.has(key)) continue;

        await deleteExactRowById(T.bomConsumed, bomConsumedIdColumn, row);
        consolidatedSummaryCategories.add("component information");
      }
    }

    const consolidatedLocationText = Array.from(consolidatedLocations)
      .filter(Boolean)
      .join(", ");

    const consolidatedResourceText = Array.from(consolidatedResources)
      .filter(Boolean)
      .join(", ");

    const consolidatedItemText = Array.from(consolidatedItems)
      .filter(Boolean)
      .join(", ");

    const consolidatedSummaryText = buildConsolidatedModifiedSummary(
      Array.from(consolidatedSummaryCategories)
    );

    const consolidatedChangeLogRow = {};

    if (changeLogColumns.includes("rec_id")) {
      consolidatedChangeLogRow.rec_id = generateRandomSixDigit();
    }
    if (changeLogColumns.includes("record_id")) {
      consolidatedChangeLogRow.record_id = generateRandomSixDigit();
    }
    if (changeLogColumns.includes("postgresql_rec_id")) {
      consolidatedChangeLogRow.postgresql_rec_id = null;
    }

    if (changeLogColumns.includes("engineering_change_id")) {
      consolidatedChangeLogRow.engineering_change_id = engineeringChangeId;
    }
    if (changeLogColumns.includes("engineeringchangeid")) {
      consolidatedChangeLogRow.engineeringchangeid = engineeringChangeId;
    }

    if (changeLogColumns.includes("change_type")) {
      consolidatedChangeLogRow.change_type = "Modified";
    }
    if (changeLogColumns.includes("changetype")) {
      consolidatedChangeLogRow.changetype = "Modified";
    }

    if (changeLogColumns.includes("target_table")) {
      consolidatedChangeLogRow.target_table = "consolidated tables";
    }

    if (changeLogColumns.includes("bom_id")) {
      consolidatedChangeLogRow.bom_id = bomId;
    }
    if (changeLogColumns.includes("bom_ids")) {
      consolidatedChangeLogRow.bom_ids = bomId;
    }

    if (changeLogColumns.includes("produced_item")) {
      consolidatedChangeLogRow.produced_item =
        producedItem.item || consolidatedItemText || "";
    }

    if (changeLogColumns.includes("item")) {
      consolidatedChangeLogRow.item =
        consolidatedItemText || producedItem.item || "";
    }

    if (changeLogColumns.includes("location")) {
      consolidatedChangeLogRow.location = consolidatedLocationText;
    }
    if (changeLogColumns.includes("locations")) {
      consolidatedChangeLogRow.locations = consolidatedLocationText;
    }

    if (changeLogColumns.includes("resource")) {
      consolidatedChangeLogRow.resource = consolidatedResourceText;
    }
    if (changeLogColumns.includes("resources")) {
      consolidatedChangeLogRow.resources = consolidatedResourceText;
    }

    if (changeLogColumns.includes("change_date")) {
      consolidatedChangeLogRow.change_date = chicagoAuditTs;
    }
    if (changeLogColumns.includes("created_at")) {
      consolidatedChangeLogRow.created_at = chicagoAuditTs;
    }
    if (changeLogColumns.includes("created_on")) {
      consolidatedChangeLogRow.created_on = chicagoAuditTs;
    }

    if (changeLogColumns.includes("user_name")) {
      consolidatedChangeLogRow.user_name = changedBy;
    }
    if (changeLogColumns.includes("created_by")) {
      consolidatedChangeLogRow.created_by = changedBy;
    }
    if (changeLogColumns.includes("updated_by")) {
      consolidatedChangeLogRow.updated_by = changedBy;
    }

    if (changeLogColumns.includes("summarynotes")) {
      consolidatedChangeLogRow.summarynotes = notes || "";
    }
    if (changeLogColumns.includes("change_summary")) {
      consolidatedChangeLogRow.change_summary = consolidatedSummaryText;
    }
    if (changeLogColumns.includes("notes")) {
      consolidatedChangeLogRow.notes = notes || "";
    }

    if (changeLogColumns.includes("status")) {
      consolidatedChangeLogRow.status = "COMPLETED";
    }

    const {
      query: consolidatedChangeLogInsertQuery,
      values: consolidatedChangeLogInsertValues,
    } = buildDynamicInsertQuery(
      changeLogTable,
      consolidatedChangeLogRow,
      changeLogColumns
    );

    await client.query(
      consolidatedChangeLogInsertQuery,
      consolidatedChangeLogInsertValues
    );

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      message: "BOM updated successfully",
      engineeringChangeId,
      changeType: "Modified",
      bomId,
      changedBy,
      changeDate: chicagoAuditTs,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("DB Error (modify-bom):", error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  } finally {
    client.release();
  }
});

// ======================================================
// BOM Routing Step 1 - BOM ID dropdown from PostgreSQL
// Source:
//   - bom_parameters for BOMID
//   - bom_produced for produced item
// Exclude produced items where item_bom_routing.erp_co_product_association = 1
// ======================================================

// ======================================================
// BOM Routing Step 1 - BOM ID dropdown from PostgreSQL
// BOMID from bom_parameters
// Produced Item from bom_produced
// Exclude item if erp_co_product_association = 1 in item_bom_routing
// Supports BOMID column names:
//   bom_id / BOMID / bomid / BOM_ID
// ======================================================

const getExistingColumn = async (tableName, possibleColumns) => {
  const result = await pool.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = $2
        AND LOWER(column_name) = ANY($3)
      LIMIT 1
    `,
    [S, tableName, possibleColumns.map((col) => col.toLowerCase())]
  );
  return result.rows?.[0]?.column_name || null;
};

router.get("/bom-routing-step1/bom-ids", async (req, res) => {
  try {
    const possibleBomIdColumns = ["bom_id", "BOMID", "bomid", "BOM_ID"];

    const bomParametersBomIdCol = await getExistingColumn(
      T.bomParameters,
      possibleBomIdColumns
    );

    const bomProducedBomIdCol = await getExistingColumn(
      T.bomProduced,
      possibleBomIdColumns
    );

    if (!bomParametersBomIdCol) {
      return res.status(500).json({
        status: "ERROR",
        message:
          "No BOMID column found in bom_parameters. Expected one of bom_id, BOMID, bomid, BOM_ID.",
      });
    }

    if (!bomProducedBomIdCol) {
      return res.status(500).json({
        status: "ERROR",
        message:
          "No BOMID column found in bom_produced. Expected one of bom_id, BOMID, bomid, BOM_ID.",
      });
    }

    const query = `
      SELECT DISTINCT
        TRIM(bp."${bomParametersBomIdCol}"::text) AS "bomId",
        TRIM(bprod.item::text) AS "producedItem"
      FROM ${pgRef(T.bomParameters)} bp
      INNER JOIN ${pgRef(T.bomProduced)} bprod
        ON UPPER(TRIM(bprod."${bomProducedBomIdCol}"::text)) =
           UPPER(TRIM(bp."${bomParametersBomIdCol}"::text))
      WHERE COALESCE(TRIM(bp."${bomParametersBomIdCol}"::text), '') <> ''
        AND COALESCE(TRIM(bprod.item::text), '') <> ''
        AND NOT EXISTS (
          SELECT 1
          FROM ${pgRef(T.itemBomRouting)} ibr
          WHERE UPPER(TRIM(ibr.item::text)) = UPPER(TRIM(bprod.item::text))
            AND COALESCE(TRIM(ibr.erp_co_product_association::text), '0')
                IN ('1', 'true', 'TRUE', 'Y', 'y')
        )
      ORDER BY "bomId", "producedItem";
    `;

    const result = await pool.query(query);

    return res.status(200).json({
      status: "SUCCESS",
      data: result.rows,
    });
  } catch (error) {
    console.error("DB Error fetching BOM routing BOM IDs:", error);

    return res.status(500).json({
      status: "ERROR",
      message: "Failed to fetch BOM IDs from PostgreSQL",
      details: error.message,
    });
  }
});

/* =========================================================
   4) CREATE ITEM BOM ROUTING + CHANGE LOG
========================================================= */

router.post("/item-bom-routing/create", async (req, res) => {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    const {
      bomId = "",
      producedItem = "",
      itemDescription = "",
      itemReleaseFlag = "",
      location = "",
      resource = "",
      resourceRelevancy = "",
      routingPriority = "",
      routingId = "",
      addConnectedCoProduct = false,
      mainItem = {},
      coProductItem = "",
      coProducts = [],
      consumedItem = "",
      componentItem = "",
      notes = "",
      changeType = "Added",
    } = req.body || {};

    const safeText = (value) => String(value ?? "").trim();
    const safeArray = (value) => (Array.isArray(value) ? value : []);

    const MAIN_ITEM_ASSOCIATION = 0;
    const CO_PRODUCT_ASSOCIATION = 1;

    const getChicagoDateTimeFormatted = () => {
      const formatter = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "America/Chicago",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });

      const parts = formatter.formatToParts(new Date());
      const map = {};

      for (const part of parts) {
        if (part.type !== "literal") {
          map[part.type] = part.value;
        }
      }

      return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
    };

    const getResourceFromRoutingId = (value) => {
      const parts = String(value || "")
        .split("_")
        .map((p) => p.trim())
        .filter(Boolean);

      // Correct format: ROUTING_Item_resource
      // Resource may contain underscores, so keep everything after ROUTING + Item.
      return parts.length >= 3 ? parts.slice(2).join("_") : "";
    };

    const buildRoutingId = (item, resourceValue) => {
      const cleanItem = safeText(item);
      const cleanResource = safeText(resourceValue);

      if (!cleanItem || !cleanResource) return "";

      return `ROUTING_${cleanItem}_${cleanResource}`;
    };

    const changedByUserId = getOsUserName();
    const changedByUserName = getOsUserName();

    const resolvedMainItem = safeText(mainItem?.item) || safeText(producedItem);

    const priorityNumber =
      routingPriority === "" || routingPriority == null
        ? null
        : Number(routingPriority);

    const resolvedResource =
      safeText(resource) || getResourceFromRoutingId(routingId);

    const resolvedMainRoutingId =
      buildRoutingId(resolvedMainItem, resolvedResource) || safeText(routingId);

    if (!bomId) {
      return res.status(400).json({
        success: false,
        error: "bomId is required",
      });
    }

    if (!resolvedMainItem) {
      return res.status(400).json({
        success: false,
        error: "producedItem/mainItem is required",
      });
    }

    if (!resolvedResource) {
      return res.status(400).json({
        success: false,
        error:
          "resource is required or must be derivable from routingId in ROUTING_Item_resource format",
      });
    }

    if (!resolvedMainRoutingId) {
      return res.status(400).json({
        success: false,
        error: "routingId could not be derived",
      });
    }

    const normalizedCoProducts = addConnectedCoProduct
      ? safeArray(coProducts)
          .map((row) => ({
            coProductItem: safeText(row?.coProductItem),
            itemDescription: safeText(row?.itemDescription),
            qtyProduced: safeText(row?.qtyProduced),
            erp_co_product_association: CO_PRODUCT_ASSOCIATION,
          }))
          .filter(
            (row) =>
              row.coProductItem &&
              row.qtyProduced !== "" &&
              !Number.isNaN(Number(row.qtyProduced))
          )
      : [];

    // Backward compatibility if only single coProductItem came from old UI
    if (
      addConnectedCoProduct &&
      !normalizedCoProducts.length &&
      safeText(coProductItem)
    ) {
      normalizedCoProducts.push({
        coProductItem: safeText(coProductItem),
        itemDescription: "",
        qtyProduced: "",
        erp_co_product_association: CO_PRODUCT_ASSOCIATION,
      });
    }

    await client.query("BEGIN");
    transactionStarted = true;

    const engineeringChangeId = generateUniqueId("EC-");
    const trxnSetId = generateUniqueId("TRXN-");
    const chicagoNowText = getChicagoDateTimeFormatted();

    const itemBomRoutingColumns = await getExistingColumns(client, T.itemBomRouting);
    const bomProducedColumns = await getExistingColumns(client, T.bomProduced);
    const changeLogColumns = await getExistingColumns(client, T.changeLog);

    if (!itemBomRoutingColumns.includes("erp_co_product_association")) {
      throw new Error(
        `${T.itemBomRouting}.erp_co_product_association column does not exist. Cannot mark co-products.`
      );
    }

    const insertedItemBomRoutingIds = [];
    const insertedBomProducedIds = [];

    // ---------------------------------------------------------
    // 1) INSERT MAIN produced item row into item_bom_routing
    // MAIN item must always have co-product association = 0
    // Routing ID format: ROUTING_MainItem_resource
    // ---------------------------------------------------------
    const mainItemBomRoutingData = {
      routing_id: resolvedMainRoutingId,
      bom_id: bomId,
      item: resolvedMainItem,
      location,
      resource: resolvedResource,
      erp_item_bom_routing_priority: priorityNumber,
      erp_item_bom_routing_min_lot_size: 1,
      erp_item_bom_routing_lot_size_increment: 1,
      erp_item_bom_routing_wip_sweep_priority: 1,

      // IMPORTANT: main item must be 0
      erp_co_product_association: MAIN_ITEM_ASSOCIATION,

      erp_item_bom_routing_max_lot_size: null,
      engineering_change_id: engineeringChangeId,
      change_type: "Added",
      load_datetime: HARD_CODED_LOAD_DATETIME,
      rec_id: generateUniqueBigInt(),
    };

    const mainItemInsert = buildInsertQuery(
      T.itemBomRouting,
      mainItemBomRoutingData,
      itemBomRoutingColumns
    );

    const insertedMainItemBomRouting = await client.query(
      mainItemInsert.query,
      mainItemInsert.values
    );

    // Safety update to guarantee main item flag is 0
    await client.query(
      `
        UPDATE ${pgRef(T.itemBomRouting)}
        SET erp_co_product_association = $1
        WHERE TRIM(CAST(bom_id AS TEXT)) = $2
          AND TRIM(CAST(item AS TEXT)) = $3
          AND TRIM(CAST(routing_id AS TEXT)) = $4
      `,
      [
        MAIN_ITEM_ASSOCIATION,
        bomId,
        resolvedMainItem,
        resolvedMainRoutingId,
      ]
    );

    const mainInsertedRow = insertedMainItemBomRouting.rows?.[0] || {};

    let postgresqlRecId =
      mainInsertedRow.postgresql_rec_id ??
      mainInsertedRow.rec_id ??
      mainInsertedRow.id ??
      null;

    if (postgresqlRecId != null) {
      insertedItemBomRoutingIds.push(String(postgresqlRecId));
    }

    if (postgresqlRecId === null || postgresqlRecId === undefined) {
      try {
        const lookupConditions = [];
        const lookupValues = [];
        let idx = 1;

        if (itemBomRoutingColumns.includes("routing_id")) {
          lookupConditions.push(`routing_id = $${idx++}`);
          lookupValues.push(resolvedMainRoutingId);
        }

        if (itemBomRoutingColumns.includes("bom_id")) {
          lookupConditions.push(`bom_id = $${idx++}`);
          lookupValues.push(bomId);
        }

        if (itemBomRoutingColumns.includes("item")) {
          lookupConditions.push(`item = $${idx++}`);
          lookupValues.push(resolvedMainItem);
        }

        if (lookupConditions.length > 0) {
          const idSelectColumn = itemBomRoutingColumns.includes("postgresql_rec_id")
            ? "postgresql_rec_id"
            : itemBomRoutingColumns.includes("rec_id")
              ? "rec_id"
              : itemBomRoutingColumns.includes("id")
                ? "id"
                : null;

          if (idSelectColumn) {
            const lookupQuery = `
              SELECT ${quoteIdent(idSelectColumn)} AS resolved_id
              FROM ${pgRef(T.itemBomRouting)}
              WHERE ${lookupConditions.join(" AND ")}
              ORDER BY ${quoteIdent(idSelectColumn)} DESC
              LIMIT 1
            `;

            const lookupResult = await client.query(lookupQuery, lookupValues);
            postgresqlRecId = lookupResult.rows?.[0]?.resolved_id ?? null;
          }
        }
      } catch (lookupError) {
        console.error(
          "Lookup warning (item_bom_routing postgresql_rec_id):",
          lookupError
        );
      }
    }

    // ---------------------------------------------------------
    // 2) INSERT co-product rows into item_bom_routing and bom_produced
    // Co-products must have association = 1
    // Routing ID format: ROUTING_CoProductItem_resource
    // ---------------------------------------------------------
    for (const row of normalizedCoProducts) {
      const coProductItemValue = safeText(row.coProductItem);

      const qtyProducedValue =
        row.qtyProduced === "" || row.qtyProduced == null
          ? null
          : Number(row.qtyProduced);

      if (!coProductItemValue) {
        continue;
      }

      const coProductRoutingId =
        buildRoutingId(coProductItemValue, resolvedResource) ||
        resolvedMainRoutingId;

      const coItemBomRoutingData = {
        routing_id: coProductRoutingId,
        bom_id: bomId,
        item: coProductItemValue,
        location,
        resource: resolvedResource,
        erp_item_bom_routing_priority: priorityNumber,
        erp_item_bom_routing_min_lot_size: 1,
        erp_item_bom_routing_lot_size_increment: 1,
        erp_item_bom_routing_wip_sweep_priority: 1,

        // IMPORTANT: co-product must always be 1
        erp_co_product_association: CO_PRODUCT_ASSOCIATION,

        erp_item_bom_routing_max_lot_size: null,
        engineering_change_id: engineeringChangeId,
        change_type: "Added",
        load_datetime: HARD_CODED_LOAD_DATETIME,
        rec_id: generateUniqueBigInt(),
      };

      const coItemInsert = buildInsertQuery(
        T.itemBomRouting,
        coItemBomRoutingData,
        itemBomRoutingColumns
      );

      const insertedCoItemBomRouting = await client.query(
        coItemInsert.query,
        coItemInsert.values
      );

      // Safety update to guarantee co-product flag is 1
      await client.query(
        `
          UPDATE ${pgRef(T.itemBomRouting)}
          SET erp_co_product_association = $1
          WHERE TRIM(CAST(bom_id AS TEXT)) = $2
            AND TRIM(CAST(item AS TEXT)) = $3
            AND TRIM(CAST(routing_id AS TEXT)) = $4
        `,
        [
          CO_PRODUCT_ASSOCIATION,
          bomId,
          coProductItemValue,
          coProductRoutingId,
        ]
      );

      const insertedCoItemRow = insertedCoItemBomRouting.rows?.[0] || {};

      const coItemRoutingRecId =
        insertedCoItemRow.postgresql_rec_id ??
        insertedCoItemRow.rec_id ??
        insertedCoItemRow.id ??
        null;

      if (coItemRoutingRecId != null) {
        insertedItemBomRoutingIds.push(String(coItemRoutingRecId));
      }

      const bomProducedData = {
        bom_id: bomId,
        item: coProductItemValue,
        location,
        bom_status: HARD_CODED_BOM_STATUS,
        bom_version: getBomVersionFromBomId(bomId),
        prefix: HARD_CODED_PREFIX,
        bom_plan_type: HARD_CODED_BOM_PLAN_TYPE,
        erp_bom_qty_produced_per: qtyProducedValue,
        engineering_change_id: engineeringChangeId,
        change_type: "Added",
        load_datetime: HARD_CODED_LOAD_DATETIME,
        rec_id: generateUniqueBigInt(),
      };

      const bomProducedInsert = buildInsertQuery(
        T.bomProduced,
        bomProducedData,
        bomProducedColumns
      );

      const insertedBomProduced = await client.query(
        bomProducedInsert.query,
        bomProducedInsert.values
      );

      const insertedBomProducedRow = insertedBomProduced.rows?.[0] || {};

      const bomProducedRecId =
        insertedBomProducedRow.postgresql_rec_id ??
        insertedBomProducedRow.rec_id ??
        insertedBomProducedRow.id ??
        null;

      if (bomProducedRecId != null) {
        insertedBomProducedIds.push(String(bomProducedRecId));
      }
    }

    const changeLogRecId = generateUniqueBigInt();

    if (postgresqlRecId === null || postgresqlRecId === undefined) {
      postgresqlRecId = changeLogRecId;
    }

    // ---------------------------------------------------------
    // 3) planning_bom_change_log_summary INSERT DATA
    // ---------------------------------------------------------
    const normalizedChangeType = String(changeType || "Added").trim();
    const resolvedConsumedItem = safeText(consumedItem) || safeText(componentItem);

    const allProducedItemsForChangeLog = [
      resolvedMainItem,
      ...normalizedCoProducts.map((row) => row.coProductItem),
    ]
      .map((item) => safeText(item))
      .filter(Boolean)
      .join(", ");

    const allRoutingIdsForChangeLog = [
      resolvedMainRoutingId,
      ...normalizedCoProducts.map((row) =>
        buildRoutingId(row.coProductItem, resolvedResource)
      ),
    ]
      .map((id) => safeText(id))
      .filter(Boolean)
      .join(", ");

    const changeLogData = {
      rec_id: changeLogRecId,
      engineering_change_id: engineeringChangeId,
      postgresql_rec_id: postgresqlRecId,
      change_type: normalizedChangeType,
      target_table: T.itemBomRouting,
      bom_id: bomId,

      // IMPORTANT: keep main + co-products for detail-add classification
      produced_item: allProducedItemsForChangeLog,

      location,
      change_date: chicagoNowText,
      user_name: changedByUserName,
      item_description: safeText(itemDescription),
      item_release_flag: safeText(itemReleaseFlag),
      resource_relevancy: safeText(resourceRelevancy),
      consumed_item: resolvedConsumedItem,
    };

    if (changeLogColumns.includes("routing_id")) {
      changeLogData.routing_id = allRoutingIdsForChangeLog;
    }

    if (changeLogColumns.includes("created_at")) {
      changeLogData.created_at = chicagoNowText;
    }

    if (changeLogColumns.includes("created_on")) {
      changeLogData.created_on = chicagoNowText;
    }

    if (changeLogColumns.includes("resource")) {
      changeLogData.resource = resolvedResource;
    }

    if (changeLogColumns.includes("resources")) {
      changeLogData.resources = resolvedResource;
    }

    if (changeLogColumns.includes("summarynotes")) {
      changeLogData.summarynotes = notes || "";
    }

    if (changeLogColumns.includes("notes")) {
      changeLogData.notes = notes || "";
    }

    if (changeLogColumns.includes("changed_by_user_id")) {
      changeLogData.changed_by_user_id = changedByUserId;
    }

    if (changeLogColumns.includes("change_summary")) {
      const coProductCount = normalizedCoProducts.length;

      changeLogData.change_summary =
        normalizedChangeType === "Added"
          ? coProductCount > 0
            ? `Added 1 BOM ID in item_bom_routing and ${coProductCount} co-product row(s) in item_bom_routing/bom_produced`
            : "Added 1 BOM ID in item_bom_routing"
          : normalizedChangeType === "Modified"
            ? "Modified 1 BOM ID in item_bom_routing"
            : normalizedChangeType === "Deleted"
              ? "Deleted 1 BOM ID in item_bom_routing"
              : normalizedChangeType;
    }

    const changeLogInsert = buildInsertQuery(
      T.changeLog,
      changeLogData,
      changeLogColumns
    );

    await client.query(changeLogInsert.query, changeLogInsert.values);

    await client.query("COMMIT");
    transactionStarted = false;

    return res.status(201).json({
      success: true,
      message: "Item BOM routing record created successfully",
      data: {
        engineeringChangeId,
        trxnSetId,
        postgresqlRecId,
        recId: changeLogRecId,
        routingId: resolvedMainRoutingId,
        bomId,
        producedItem: resolvedMainItem,
        producedItems: allProducedItemsForChangeLog,
        itemDescription: safeText(itemDescription),
        itemReleaseFlag: safeText(itemReleaseFlag),
        location,
        resource: resolvedResource,
        resourceRelevancy: safeText(resourceRelevancy),
        consumedItem: resolvedConsumedItem,
        changedByUserId,
        changedByUserName,
        coProducts: normalizedCoProducts.map((row) => ({
          ...row,
          routingId: buildRoutingId(row.coProductItem, resolvedResource),
          resource: resolvedResource,
          erp_co_product_association: CO_PRODUCT_ASSOCIATION,
        })),
        insertedItemBomRoutingIds,
        insertedBomProducedIds,
      },
    });
  } catch (error) {
    if (transactionStarted) {
      await client.query("ROLLBACK");
    }

    console.error("DB Error (item-bom-routing/create):", error);

    return res.status(500).json({
      success: false,
      error: "Failed to create item BOM routing record",
      details: error.message,
    });
  } finally {
    client.release();
  }
});

/* =========================================================
   DELETE BOM - Step 2 Summary
========================================================= */
router.get("/delete-bom/summary", async (req, res) => {
  try {
    const bomIds = normalizeTextArray(
      req.query.bomIds || req.query.bomId || req.query["bomIds[]"]
    );

    if (!bomIds.length) {
      return res.status(400).json({
        error: "bomIds is required",
      });
    }

    const summaryResult = await pool.query(
      `
        SELECT
          TRIM(CAST(bp.bom_id AS TEXT)) AS bom_id,
          TRIM(CAST(bp.item AS TEXT)) AS produced_item,
          TRIM(CAST(bp.location AS TEXT)) AS location,
          CASE
            WHEN COALESCE(TRIM(CAST(bp.erp_bom_qty_produced_per AS TEXT)), '') IN ('1', '1.0', '1.00')
              THEN ''
            ELSE '1'
          END AS erp_co_product_association
        FROM ${pgRef(T.bomProduced)} bp
        WHERE TRIM(CAST(bp.bom_id AS TEXT)) = ANY($1::text[])
        ORDER BY
          TRIM(CAST(bp.bom_id AS TEXT)),
          CASE
            WHEN COALESCE(TRIM(CAST(bp.erp_bom_qty_produced_per AS TEXT)), '') IN ('1', '1.0', '1.00')
              THEN 0
            ELSE 1
          END,
          TRIM(CAST(bp.item AS TEXT))
      `,
      [bomIds]
    );

    const routingResult = await pool.query(
      `
        SELECT
          TRIM(CAST(ibr.bom_id AS TEXT)) AS bom_id,
          TRIM(CAST(ibr.item AS TEXT)) AS produced_item,
          COALESCE(
            NULLIF(
              TRIM(
                regexp_replace(
                  TRIM(CAST(ibr.routing_id AS TEXT)),
                  '^([^_]*_){2}',
                  ''
                )
              ),
              ''
            ),
            ''
          ) AS resource,
          CONCAT(
            'ROUTING_',
            TRIM(CAST(ibr.item AS TEXT)),
            '_',
            COALESCE(
              NULLIF(
                TRIM(
                  regexp_replace(
                    TRIM(CAST(ibr.routing_id AS TEXT)),
                    '^([^_]*_){2}',
                    ''
                  )
                ),
                ''
              ),
              ''
            )
          ) AS routing_id,
          COALESCE(TRIM(CAST(ibr.erp_co_product_association AS TEXT)), '') AS erp_co_product_association
        FROM ${pgRef(T.itemBomRouting)} ibr
        WHERE TRIM(CAST(ibr.bom_id AS TEXT)) = ANY($1::text[])
          AND ibr.routing_id IS NOT NULL
          AND TRIM(CAST(ibr.routing_id AS TEXT)) <> ''
        ORDER BY
          TRIM(CAST(ibr.bom_id AS TEXT)),
          CASE
            WHEN COALESCE(TRIM(CAST(ibr.erp_co_product_association AS TEXT)), '') = '1'
              THEN 1
            ELSE 0
          END,
          TRIM(CAST(ibr.item AS TEXT)),
          TRIM(CAST(ibr.routing_id AS TEXT))
      `,
      [bomIds]
    );

    const countsResult = await pool.query(
      `
        SELECT 'bom_parameters' AS table_name, COUNT(*)::int AS row_count
        FROM ${pgRef(T.bomParameters)}
        WHERE TRIM(CAST(bom_id AS TEXT)) = ANY($1::text[])

        UNION ALL

        SELECT 'bom_produced' AS table_name, COUNT(*)::int AS row_count
        FROM ${pgRef(T.bomProduced)}
        WHERE TRIM(CAST(bom_id AS TEXT)) = ANY($1::text[])

        UNION ALL

        SELECT 'bom_consumed' AS table_name, COUNT(*)::int AS row_count
        FROM ${pgRef(T.bomConsumed)}
        WHERE TRIM(CAST(bom_id AS TEXT)) = ANY($1::text[])

        UNION ALL

        SELECT 'item_bom_routing' AS table_name, COUNT(*)::int AS row_count
        FROM ${pgRef(T.itemBomRouting)}
        WHERE TRIM(CAST(bom_id AS TEXT)) = ANY($1::text[])
      `,
      [bomIds]
    );

    return res.status(200).json({
      success: true,
      data: {
        bomSummary: summaryResult.rows || [],
        routingSummary: routingResult.rows || [],
        tableCounts: countsResult.rows || [],
      },
    });
  } catch (error) {
    console.error("DB Error (delete-bom/summary):", error);

    return res.status(500).json({
      error: "Failed to fetch delete BOM summary",
      details: error.message,
    });
  }
});

/* =========================================================
   DELETE BOM - Execute permanent delete with archive
========================================================= */
router.post("/delete-bom/execute", async (req, res) => {
  const client = await pool.connect();

  try {
    const bomIds = normalizeTextArray(req.body?.bomIds);
    const notes = toText(req.body?.notes);

    const changedBy = getSystemUserName(req);

    const getChicagoDateTimeFormatted = () => {
      const formatter = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "America/Chicago",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });

      const parts = formatter.formatToParts(new Date());
      const map = {};

      for (const part of parts) {
        if (part.type !== "literal") {
          map[part.type] = part.value;
        }
      }

      return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
    };

    if (!bomIds.length) {
      return res.status(400).json({
        success: false,
        error: "bomIds must be a non-empty array",
      });
    }

    await client.query("BEGIN");

    const engineeringChangeId = generateDeleteBomEngineeringChangeId();
    const chicagoNowText = getChicagoDateTimeFormatted();

    const ogRecIds = {
      bom_parameters_og: [],
      bom_produced_og: [],
      bom_consumed_og: [],
      item_bom_routing_og: [],
    };

    const movedCounts = {
      bom_parameters: 0,
      bom_produced: 0,
      bom_consumed: 0,
      item_bom_routing: 0,
    };

    const changeLogTable = T.changeLog;
    const changeLogExists = await pgTableExists(client, changeLogTable);

    if (!changeLogExists) {
      throw new Error("planning_bom_change_log_summary table does not exist");
    }

    const changeLogColumns = await getExistingColumns(client, changeLogTable);

    const getProducedItemFromBomId = (bomId) => {
      const parts = String(bomId || "")
        .split("_")
        .map((p) => p.trim())
        .filter(Boolean);

      // Expected BOM format: BOM_Item_Location
      return parts.length >= 3 ? parts[1] : "";
    };

    const getLocationFromBomId = (bomId) => {
      const parts = String(bomId || "")
        .split("_")
        .map((p) => p.trim())
        .filter(Boolean);

      // Expected BOM format: BOM_Item_Location
      // Location may contain underscores, so keep all parts after item.
      return parts.length >= 3 ? parts.slice(2).join("_") : "";
    };

    const getResourceFromRoutingId = (routingId) => {
      const parts = String(routingId || "")
        .split("_")
        .map((p) => p.trim())
        .filter(Boolean);

      // Correct routing format: ROUTING_Item_resource
      // Resource may contain underscores, so keep all parts after ROUTING + Item.
      return parts.length >= 3 ? parts.slice(2).join("_") : "";
    };

    const resourceByBomAndLocation = new Map();

    const routingLookupResult = await client.query(
      `
        SELECT
          TRIM(CAST(bom_id AS TEXT)) AS bom_id,
          TRIM(CAST(routing_id AS TEXT)) AS routing_id
        FROM ${pgRef(T.itemBomRouting)}
        WHERE TRIM(CAST(bom_id AS TEXT)) = ANY($1::text[])
      `,
      [bomIds]
    );

    for (const routeRow of routingLookupResult.rows || []) {
      const bomIdText = toText(routeRow.bom_id);
      const routingIdText = toText(routeRow.routing_id);
      const locationFromBomId = getLocationFromBomId(bomIdText);
      const resourceFromRouting = getResourceFromRoutingId(routingIdText);

      if (!bomIdText || !locationFromBomId || !resourceFromRouting) continue;

      const key = `${bomIdText}__${locationFromBomId}`;

      if (!resourceByBomAndLocation.has(key)) {
        resourceByBomAndLocation.set(key, resourceFromRouting);
      }
    }

    const getResourceForBomAndLocation = (bomId, location) => {
      const key = `${toText(bomId)}__${toText(location)}`;

      if (resourceByBomAndLocation.has(key)) {
        return resourceByBomAndLocation.get(key);
      }

      const bomPrefix = `${toText(bomId)}__`;
      const match = [...resourceByBomAndLocation.entries()].find(([k]) =>
        k.startsWith(bomPrefix)
      );

      return match?.[1] || "";
    };

    const consolidatedBomIds = new Set();
    const consolidatedLocations = new Set();
    const consolidatedResources = new Set();
    const consolidatedProducedItems = new Set();
    const consolidatedTargetTables = new Set();

    let totalDeletedRecords = 0;
    let firstArchivedRecId = null;

    for (const [sourceTable, archiveTable] of Object.entries(
      DELETE_BOM_SOURCE_TO_ARCHIVE
    )) {
      const archiveExists = await pgTableExists(client, archiveTable);

      if (!archiveExists) {
        throw new Error(`Archive table ${archiveTable} does not exist`);
      }

      const sourceResult = await client.query(
        `
          SELECT *
          FROM ${quoteIdent(sourceTable)}
          WHERE TRIM(CAST(bom_id AS TEXT)) = ANY($1::text[])
        `,
        [bomIds]
      );

      const sourceRows = sourceResult.rows || [];

      if (!sourceRows.length) {
        continue;
      }

      const archiveColumns = await getExistingColumns(client, archiveTable);

      for (const row of sourceRows) {
        const archiveRow = buildDeleteBomArchiveRow({
          baseRow: row,
          archiveColumns,
          engineeringChangeId,
          notes,
          sourceTable,
        });

        const { query, values } = buildDynamicInsertQuery(
          archiveTable,
          archiveRow,
          archiveColumns
        );

        const inserted = await client.query(query, values);
        const insertedRow = inserted.rows?.[0] || {};

        const archivedRecId =
          insertedRow.rec_id ??
          insertedRow.record_id ??
          insertedRow.recordid ??
          insertedRow.postgresql_rec_id ??
          null;

        if (archivedRecId != null) {
          if (!ogRecIds[archiveTable]) {
            ogRecIds[archiveTable] = [];
          }

          ogRecIds[archiveTable].push(String(archivedRecId));

          if (firstArchivedRecId == null) {
            firstArchivedRecId = archivedRecId;
          }
        }

        const producedItem =
          row.produced_item ??
          row.item ??
          getProducedItemFromBomId(row.bom_id);

        const rowLocation =
          toText(row.location) || getLocationFromBomId(row.bom_id);

        const rowResource =
          toText(row.resource) ||
          getResourceFromRoutingId(row.routing_id) ||
          getResourceForBomAndLocation(row.bom_id, rowLocation);

        if (row.bom_id) {
          consolidatedBomIds.add(String(row.bom_id).trim());
        }

        if (rowLocation) {
          consolidatedLocations.add(String(rowLocation).trim());
        }

        if (rowResource) {
          consolidatedResources.add(String(rowResource).trim());
        }

        if (producedItem) {
          consolidatedProducedItems.add(String(producedItem).trim());
        }

        consolidatedTargetTables.add(sourceTable);
        totalDeletedRecords += 1;
      }

      const deletedCount = await deleteRowsByBomId(client, sourceTable, bomIds);
      movedCounts[sourceTable] = deletedCount;
    }

    if (totalDeletedRecords === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        error: "No matching BOM records found for deletion",
      });
    }

    const deletedBomIdCount = consolidatedBomIds.size;

    const consolidatedChangeSummary = `Deleted ${deletedBomIdCount} BOM ID${
      deletedBomIdCount === 1 ? "" : "s"
    } from all 4 consolidated tables`;

    const consolidatedBomIdText = Array.from(consolidatedBomIds)
      .filter(Boolean)
      .join(", ");

    const consolidatedLocationText = Array.from(consolidatedLocations)
      .filter(Boolean)
      .join(", ");

    const consolidatedResourceText = Array.from(consolidatedResources)
      .filter(Boolean)
      .join(", ");

    const consolidatedProducedItemText = Array.from(consolidatedProducedItems)
      .filter(Boolean)
      .join(", ");

    const consolidatedTargetTableText = Array.from(consolidatedTargetTables)
      .filter(Boolean)
      .join(", ");

    const consolidatedChangeLogRow = {};

    if (changeLogColumns.includes("rec_id")) {
      consolidatedChangeLogRow.rec_id = generateUniqueBigInt();
    }

    if (changeLogColumns.includes("record_id")) {
      consolidatedChangeLogRow.record_id = generateUniqueBigInt();
    }

    if (changeLogColumns.includes("postgresql_rec_id")) {
      consolidatedChangeLogRow.postgresql_rec_id = firstArchivedRecId;
    }

    if (changeLogColumns.includes("engineering_change_id")) {
      consolidatedChangeLogRow.engineering_change_id = engineeringChangeId;
    }

    if (changeLogColumns.includes("engineeringchangeid")) {
      consolidatedChangeLogRow.engineeringchangeid = engineeringChangeId;
    }

    if (changeLogColumns.includes("change_type")) {
      consolidatedChangeLogRow.change_type = "Deleted";
    }

    if (changeLogColumns.includes("changetype")) {
      consolidatedChangeLogRow.changetype = "Deleted";
    }

    if (changeLogColumns.includes("target_table")) {
      consolidatedChangeLogRow.target_table = "consolidated tables";
    }

    if (changeLogColumns.includes("target_tables")) {
      consolidatedChangeLogRow.target_tables = consolidatedTargetTableText;
    }

    if (changeLogColumns.includes("bom_id")) {
      consolidatedChangeLogRow.bom_id = consolidatedBomIdText;
    }

    if (changeLogColumns.includes("bom_ids")) {
      consolidatedChangeLogRow.bom_ids = consolidatedBomIdText;
    }

    if (changeLogColumns.includes("produced_item")) {
      consolidatedChangeLogRow.produced_item = consolidatedProducedItemText;
    }

    if (changeLogColumns.includes("item")) {
      consolidatedChangeLogRow.item = consolidatedProducedItemText;
    }

    if (changeLogColumns.includes("location")) {
      consolidatedChangeLogRow.location = consolidatedLocationText;
    }

    if (changeLogColumns.includes("locations")) {
      consolidatedChangeLogRow.locations = consolidatedLocationText;
    }

    if (changeLogColumns.includes("resource")) {
      consolidatedChangeLogRow.resource = consolidatedResourceText;
    }

    if (changeLogColumns.includes("resources")) {
      consolidatedChangeLogRow.resources = consolidatedResourceText;
    }

    if (changeLogColumns.includes("summarynotes")) {
      consolidatedChangeLogRow.summarynotes = notes || "";
    }

    if (changeLogColumns.includes("notes")) {
      consolidatedChangeLogRow.notes = notes || "";
    }

    if (changeLogColumns.includes("change_summary")) {
      consolidatedChangeLogRow.change_summary = consolidatedChangeSummary;
    }

    if (changeLogColumns.includes("user_name")) {
      consolidatedChangeLogRow.user_name = changedBy;
    }

    if (changeLogColumns.includes("created_by")) {
      consolidatedChangeLogRow.created_by = changedBy;
    }

    if (changeLogColumns.includes("updated_by")) {
      consolidatedChangeLogRow.updated_by = changedBy;
    }

    if (changeLogColumns.includes("change_date")) {
      consolidatedChangeLogRow.change_date = chicagoNowText;
    }

    if (changeLogColumns.includes("created_at")) {
      consolidatedChangeLogRow.created_at = chicagoNowText;
    }

    if (changeLogColumns.includes("created_on")) {
      consolidatedChangeLogRow.created_on = chicagoNowText;
    }

    if (changeLogColumns.includes("status")) {
      consolidatedChangeLogRow.status = "COMPLETED";
    }

    const {
      query: consolidatedChangeLogInsertQuery,
      values: consolidatedChangeLogInsertValues,
    } = buildDynamicInsertQuery(
      changeLogTable,
      consolidatedChangeLogRow,
      changeLogColumns
    );

    await client.query(
      consolidatedChangeLogInsertQuery,
      consolidatedChangeLogInsertValues
    );

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      message:
        "Selected BOM records were permanently deleted and archived successfully.",
      engineeringChangeId,
      changeType: "Deleted",
      bomIds,
      movedCounts,
      ogRecIds,
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Rollback Error (delete-bom/execute):", rollbackError);
    }

    console.error("DB Error (delete-bom/execute):", error);

    return res.status(500).json({
      success: false,
      error: "Failed to delete and archive selected BOM records",
      details: error.message,
    });
  } finally {
    client.release();
  }
});


/* =========================================================
   EXISTING ITEM BOM ROUTING SEARCH - Step 1
========================================================= */

// Assumes these are already available in your backend file:
// router, pool, pgRef, T

router.get("/existing-item-bom-routing-search", async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const requestedPageSize = Number.parseInt(req.query.pageSize, 10) || 50;
    const pageSize = Math.min(50, Math.max(1, requestedPageSize));
    const offset = (page - 1) * pageSize;

    const normalizeTextLocal = (value) => String(value ?? "").trim();

    const normalizeField = (value) => {
      const field = normalizeTextLocal(value);
      const fieldMap = {
        "": "",
        location: "location",
        item: "item",
        producedItem: "item",
        bomId: "bomId",
        bom_id: "bomId",
        resource: "resource",
        routingId: "routingId",
        routing_id: "routingId",
        componentItem: "componentItem",
        coProductItem: "coProductItem",
      };
      return fieldMap[field] || "";
    };

    const searchBy1 = normalizeField(req.query.searchBy1);
    const query1 = normalizeTextLocal(req.query.query1);
    const searchBy2 = normalizeField(req.query.searchBy2);
    const query2 = normalizeTextLocal(req.query.query2);

    const pgParams = [];
    const addPgParam = (value) => {
      pgParams.push(value);
      return `$${pgParams.length}`;
    };

   const routingValueExpr = `TRIM(CAST(ibr.routing_id AS TEXT))`;
const itemValueExpr = `TRIM(CAST(ibr.item AS TEXT))`;
const bomValueExpr = `TRIM(CAST(ibr.bom_id AS TEXT))`;
const associationExpr = `COALESCE(NULLIF(TRIM(CAST(ibr.erp_co_product_association AS TEXT)), ''), '')`;
const locationExpr = `''`;


const resourceExpr = `
  COALESCE(
    NULLIF(
      SUBSTRING(TRIM(CAST(ibr.routing_id AS TEXT)) FROM '^[^_]+_[^_]+_(.+)$'),
      ''
    ),
    ''
  )
`;
    const componentAssociationCondition = `(
      NULLIF(TRIM(CAST(ibr.erp_co_product_association AS TEXT)), '') IS NULL
      OR (
        TRIM(CAST(ibr.erp_co_product_association AS TEXT)) ~ '^-?[0-9]+(\\.[0-9]+)?$'
        AND TRIM(CAST(ibr.erp_co_product_association AS TEXT))::numeric < 1
      )
    )`;

    const coProductAssociationCondition = `(
      TRIM(CAST(ibr.erp_co_product_association AS TEXT)) ~ '^-?[0-9]+(\\.[0-9]+)?$'
      AND TRIM(CAST(ibr.erp_co_product_association AS TEXT))::numeric >= 1
    )`;

    const whereParts = [
      `ibr.routing_id IS NOT NULL`,
      `TRIM(CAST(ibr.routing_id AS TEXT)) <> ''`,
    ];

    const appendSearchFilter = (field, value) => {
      const q = normalizeTextLocal(value);
      if (!field || !q) return;

      const likeParam = addPgParam(`%${q}%`);

      if (field === "location") {
        whereParts.push(`${locationExpr} ILIKE ${likeParam}`);
        return;
      }

      if (field === "item") {
        whereParts.push(`${itemValueExpr} ILIKE ${likeParam}`);
        return;
      }

      if (field === "bomId") {
        whereParts.push(`${bomValueExpr} ILIKE ${likeParam}`);
        return;
      }

      if (field === "resource") {
        whereParts.push(`${resourceExpr} ILIKE ${likeParam}`);
        return;
      }

      if (field === "routingId") {
        whereParts.push(`${routingValueExpr} ILIKE ${likeParam}`);
        return;
      }

      if (field === "componentItem") {
        whereParts.push(`(${componentAssociationCondition} AND ${itemValueExpr} ILIKE ${likeParam})`);
        return;
      }

      if (field === "coProductItem") {
        whereParts.push(`(${coProductAssociationCondition} AND ${itemValueExpr} ILIKE ${likeParam})`);
      }
    };

    appendSearchFilter(searchBy1, query1);
    appendSearchFilter(searchBy2, query2);

    const whereClause = `WHERE ${whereParts.join(" AND ")}`;
    const limitParam = addPgParam(pageSize);
    const offsetParam = addPgParam(offset);

    const result = await pool.query(
      `
        WITH filtered_rows AS (
          SELECT
            TRIM(CAST(ibr.rec_id AS TEXT)) AS rec_id,
            ${itemValueExpr} AS item,
            ${bomValueExpr} AS bom_id,
            ${routingValueExpr} AS routing_id,
            ${associationExpr} AS erp_co_product_association,
            ${locationExpr} AS location,
            ${resourceExpr} AS resource
          FROM ${pgRef(T.itemBomRouting)} ibr
          ${whereClause}
        ),
        counted_rows AS (
          SELECT fr.*, COUNT(1) OVER() AS total_count
          FROM filtered_rows fr
        )
        SELECT
          rec_id,
          item,
          bom_id,
          routing_id,
          erp_co_product_association,
          location,
          resource,
          total_count
        FROM counted_rows
        ORDER BY
          bom_id ASC,
          CASE
            WHEN NULLIF(erp_co_product_association, '') IS NULL
              THEN 0
            WHEN erp_co_product_association ~ '^-?[0-9]+(\\.[0-9]+)?$'
              AND erp_co_product_association::numeric < 1
              THEN 1
            ELSE 2
          END ASC,
          routing_id ASC,
          item ASC
        LIMIT ${limitParam}
        OFFSET ${offsetParam}
      `,
      pgParams
    );

    const rows = result.rows || [];
    const total = rows.length ? Number(rows[0].total_count || 0) : 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const data = rows.map(({ total_count, ...row }) => row);

    return res.status(200).json({
      success: true,
      data,
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
        hasPrev: page > 1,
        hasNext: page < totalPages,
        searchBy1,
        query1,
        searchBy2,
        query2,
      },
    });
  } catch (error) {
    console.error("DB Error (existing-item-bom-routing-search):", error);
    return res.status(500).json({
      success: false,
      error: "Failed to fetch existing item BOM routing rows",
      details: error.message,
    });
  }
});





/* =========================================================
   DELETE ITEM BOM ROUTING - Execute delete with archive
========================================================= */


router.post("/delete-item-bom-routing/execute", async (req, res) => {
  const client = await pool.connect();

  try {
    const records = Array.isArray(req.body?.records) ? req.body.records : [];
    const notes = String(req.body?.notes ?? "").trim();
    const changedBy = getSystemUserName(req);

    const getChicagoDateTimeFormatted = () => {
      const formatter = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "America/Chicago",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });

      const parts = formatter.formatToParts(new Date());
      const map = {};

      for (const part of parts) {
        if (part.type !== "literal") {
          map[part.type] = part.value;
        }
      }

      return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
    };

    const normalizeTextLocal = (value) => String(value ?? "").trim();

    const getLocationFromBomId = (bomId) => {
      const value = normalizeTextLocal(bomId);
      if (!value) return "";

      const parts = value
        .split("_")
        .map((p) => p.trim())
        .filter(Boolean);

      return parts.length >= 3 ? parts.slice(2).join("_") : "";
    };

    const getResourceFromRoutingId = (routingId) => {
      const value = normalizeTextLocal(routingId);
      if (!value) return "";

      const parts = value
        .split("_")
        .map((p) => p.trim())
        .filter(Boolean);

      // Required frontend/display format: ROUTING_item_resource
      // Resource is everything after the second underscore.
      return parts.length >= 3 ? parts.slice(2).join("_") : "";
    };

    const getSourceRowsForRecord = async (record) => {
      const recId = normalizeTextLocal(record?.rec_id);
      const bomId = normalizeTextLocal(record?.bom_id);
      const item = normalizeTextLocal(record?.item);
      const routingId = normalizeTextLocal(record?.routing_id);
      const resource = normalizeTextLocal(
        record?.resource || getResourceFromRoutingId(routingId)
      );

      if (recId) {
        return client.query(
          `
            SELECT *
            FROM ${pgRef(T.itemBomRouting)}
            WHERE TRIM(CAST(rec_id AS TEXT)) = $1
          `,
          [recId]
        );
      }

      const conditions = [];
      const params = [];
      let p = 1;

      if (bomId) {
        conditions.push(`TRIM(CAST(bom_id AS TEXT)) = $${p++}`);
        params.push(bomId);
      }

      if (item) {
        conditions.push(`TRIM(CAST(item AS TEXT)) = $${p++}`);
        params.push(item);
      }

      if (resource) {
        conditions.push(
          `TRIM(regexp_replace(TRIM(CAST(routing_id AS TEXT)), '^([^_]*_){2}', '')) = $${p++}`
        );
        params.push(resource);
      } else if (routingId) {
        conditions.push(`TRIM(CAST(routing_id AS TEXT)) = $${p++}`);
        params.push(routingId);
      }

      if (!conditions.length) {
        return { rows: [] };
      }

      return client.query(
        `
          SELECT *
          FROM ${pgRef(T.itemBomRouting)}
          WHERE ${conditions.join(" AND ")}
        `,
        params
      );
    };

    if (!records.length) {
      return res.status(400).json({
        success: false,
        error: "records must be a non-empty array",
      });
    }

    const archiveTable = T.itemBomRoutingOg;
    const bomProducedArchiveTable = T.bomProducedOg;
    const changeLogTable = T.changeLog;

    const archiveExists = await pgTableExists(client, archiveTable);
    if (!archiveExists) {
      return res.status(500).json({
        success: false,
        error: "item_bom_routing_og table does not exist",
      });
    }

    const bomProducedArchiveExists = await pgTableExists(
      client,
      bomProducedArchiveTable
    );
    if (!bomProducedArchiveExists) {
      return res.status(500).json({
        success: false,
        error: "bom_produced_og table does not exist",
      });
    }

    const changeLogExists = await pgTableExists(client, changeLogTable);
    if (!changeLogExists) {
      return res.status(500).json({
        success: false,
        error: "planning_bom_change_log_summary table does not exist",
      });
    }

    await client.query("BEGIN");

    const engineeringChangeId =
      generateDeleteItemBomRoutingEngineeringChangeId();

    const chicagoNowText = getChicagoDateTimeFormatted();

    const archiveColumns = await getExistingColumns(client, archiveTable);
    const bomProducedArchiveColumns = await getExistingColumns(
      client,
      bomProducedArchiveTable
    );
    const changeLogColumns = await getExistingColumns(client, changeLogTable);

    const archivedRecIds = [];
    const archivedBomProducedRecIds = [];

    let movedCount = 0;
    let bomProducedDeletedCount = 0;
    let firstArchivedPostgresqlRecId = null;

    const processedLiveKeys = new Set();
    const processedBomProducedMatchKeys = new Set();

    const consolidatedBomIds = new Set();
    const consolidatedLocations = new Set();
    const consolidatedResources = new Set();
    const consolidatedProducedItems = new Set();

    for (const record of records) {
      const sourceResult = await getSourceRowsForRecord(record);
      const sourceRows = sourceResult.rows || [];

      for (const sourceRow of sourceRows) {
        const targetRows = await getDeleteTargetRowsForItemBomRouting(
          client,
          sourceRow
        );

        for (const row of targetRows) {
          const liveUniqueKey = buildItemBomRoutingUniqueKey(row);

          if (processedLiveKeys.has(liveUniqueKey)) {
            continue;
          }

          processedLiveKeys.add(liveUniqueKey);

          const archiveRow = { ...row };

          delete archiveRow.postgresql_rec_id;

          if (archiveColumns.includes("engineering_change_id")) {
            archiveRow.engineering_change_id = engineeringChangeId;
          }
          if (archiveColumns.includes("engineeringchangeid")) {
            archiveRow.engineeringchangeid = engineeringChangeId;
          }

          if (archiveColumns.includes("change_type")) {
            archiveRow.change_type = "Deleted";
          }
          if (archiveColumns.includes("changetype")) {
            archiveRow.changetype = "Deleted";
          }

          if (archiveColumns.includes("notes")) {
            archiveRow.notes = notes || "";
          }
          if (archiveColumns.includes("summarynotes")) {
            archiveRow.summarynotes = notes || "";
          }
          if (archiveColumns.includes("change_summary")) {
            archiveRow.change_summary = "";
          }

          if (archiveColumns.includes("source_table")) {
            archiveRow.source_table = T.itemBomRouting;
          }
          if (archiveColumns.includes("source_rec_id")) {
            archiveRow.source_rec_id =
              row.rec_id ?? row.record_id ?? row.recordid ?? null;
          }

          if (archiveColumns.includes("erp_item_bom_routing_min_lot_size")) {
            archiveRow.erp_item_bom_routing_min_lot_size =
              row.erp_item_bom_routing_min_lot_size ?? 1;
          }

          if (
            archiveColumns.includes(
              "erp_item_bom_routing_lot_size_increment"
            )
          ) {
            archiveRow.erp_item_bom_routing_lot_size_increment =
              row.erp_item_bom_routing_lot_size_increment ?? 1;
          }

          if (
            archiveColumns.includes(
              "erp_item_bom_routing_wip_sweep_priority"
            )
          ) {
            archiveRow.erp_item_bom_routing_wip_sweep_priority =
              row.erp_item_bom_routing_wip_sweep_priority ?? 1;
          }

          if (archiveColumns.includes("archived_at")) {
            archiveRow.archived_at = chicagoNowText;
          }
          if (archiveColumns.includes("archived_on")) {
            archiveRow.archived_on = chicagoNowText;
          }
          if (archiveColumns.includes("deleted_at")) {
            archiveRow.deleted_at = chicagoNowText;
          }
          if (archiveColumns.includes("deleted_on")) {
            archiveRow.deleted_on = chicagoNowText;
          }

          const { query: archiveInsertQuery, values: archiveInsertValues } =
            buildDynamicInsertQuery(archiveTable, archiveRow, archiveColumns);

          const archiveInsertResult = await client.query(
            archiveInsertQuery,
            archiveInsertValues
          );

          const insertedOgRow = archiveInsertResult.rows?.[0] || {};
          const archivedPostgresqlRecId =
            insertedOgRow.postgresql_rec_id ?? null;

          if (archivedPostgresqlRecId != null) {
            archivedRecIds.push(String(archivedPostgresqlRecId));

            if (firstArchivedPostgresqlRecId == null) {
              firstArchivedPostgresqlRecId = archivedPostgresqlRecId;
            }
          }

          const producedItem = normalizeTextLocal(
            row.produced_item ?? row.item ?? ""
          );
          const derivedLocation = normalizeTextLocal(
            row.location || getLocationFromBomId(row.bom_id)
          );
          const derivedResource = normalizeTextLocal(
            row.resource || getResourceFromRoutingId(row.routing_id)
          );

          if (row.bom_id) {
            consolidatedBomIds.add(normalizeTextLocal(row.bom_id));
          }
          if (derivedLocation) {
            consolidatedLocations.add(derivedLocation);
          }
          if (derivedResource) {
            consolidatedResources.add(derivedResource);
          }
          if (producedItem) {
            consolidatedProducedItems.add(producedItem);
          }

          if (isTruthyCoProductAssociation(row)) {
            const bomProducedMatchInput = getBomProducedMatchInputFromRow(row);
            const bomProducedMatchKey = [
              bomProducedMatchInput.bomId,
              bomProducedMatchInput.location,
              bomProducedMatchInput.coProductItem,
            ].join("__");

            if (
              bomProducedMatchInput.bomId &&
              bomProducedMatchInput.location &&
              bomProducedMatchInput.coProductItem &&
              !processedBomProducedMatchKeys.has(bomProducedMatchKey)
            ) {
              processedBomProducedMatchKeys.add(bomProducedMatchKey);

              const bomProducedResult =
                await archiveAndDeleteMatchingBomProducedCoProductOnly(
                  client,
                  row,
                  {
                    bomProducedArchiveTable,
                    bomProducedArchiveColumns,
                    engineeringChangeId,
                    notes,
                  }
                );

              archivedBomProducedRecIds.push(
                ...(bomProducedResult.archivedBomProducedRecIds || [])
              );

              bomProducedDeletedCount += Number(
                bomProducedResult.bomProducedDeletedCount || 0
              );
            }
          }

          await deleteExactItemBomRoutingRow(client, row);

          movedCount += 1;
        }
      }
    }

    if (movedCount === 0) {
      await client.query("ROLLBACK");

      return res.status(404).json({
        success: false,
        error: "No matching item_bom_routing records found for deletion",
      });
    }

    const consolidatedBomIdText = Array.from(consolidatedBomIds)
      .filter(Boolean)
      .join(", ");

    const consolidatedLocationText = Array.from(consolidatedLocations)
      .filter(Boolean)
      .join(", ");

    const consolidatedResourceText = Array.from(consolidatedResources)
      .filter(Boolean)
      .join(", ");

    const consolidatedProducedItemText = Array.from(consolidatedProducedItems)
      .filter(Boolean)
      .join(", ");

    const deletedBomIdCount = consolidatedBomIds.size;

    const deleteChangeSummary =
      `Deleted ${movedCount} item_bom_routing record${
        movedCount === 1 ? "" : "s"
      } ` +
      `across ${deletedBomIdCount} BOM ID${
        deletedBomIdCount === 1 ? "" : "s"
      }. ` +
      `Deleted ${bomProducedDeletedCount} co-product bom_produced record${
        bomProducedDeletedCount === 1 ? "" : "s"
      }.`;

    const consolidatedChangeLogRow = {};

    if (changeLogColumns.includes("rec_id")) {
      consolidatedChangeLogRow.rec_id = generateUniqueBigInt();
    }
    if (changeLogColumns.includes("record_id")) {
      consolidatedChangeLogRow.record_id = generateUniqueBigInt();
    }
    if (changeLogColumns.includes("postgresql_rec_id")) {
      consolidatedChangeLogRow.postgresql_rec_id = firstArchivedPostgresqlRecId;
    }

    if (changeLogColumns.includes("engineering_change_id")) {
      consolidatedChangeLogRow.engineering_change_id = engineeringChangeId;
    }
    if (changeLogColumns.includes("engineeringchangeid")) {
      consolidatedChangeLogRow.engineeringchangeid = engineeringChangeId;
    }

    if (changeLogColumns.includes("change_type")) {
      consolidatedChangeLogRow.change_type = "Deleted";
    }
    if (changeLogColumns.includes("changetype")) {
      consolidatedChangeLogRow.changetype = "Deleted";
    }

    if (changeLogColumns.includes("target_table")) {
      consolidatedChangeLogRow.target_table = T.itemBomRouting;
    }

    if (changeLogColumns.includes("bom_id")) {
      consolidatedChangeLogRow.bom_id = consolidatedBomIdText;
    }
    if (changeLogColumns.includes("bom_ids")) {
      consolidatedChangeLogRow.bom_ids = consolidatedBomIdText;
    }

    if (changeLogColumns.includes("produced_item")) {
      consolidatedChangeLogRow.produced_item =
        consolidatedProducedItemText;
    }
    if (changeLogColumns.includes("item")) {
      consolidatedChangeLogRow.item = consolidatedProducedItemText;
    }

    if (changeLogColumns.includes("location")) {
      consolidatedChangeLogRow.location = consolidatedLocationText;
    }
    if (changeLogColumns.includes("locations")) {
      consolidatedChangeLogRow.locations = consolidatedLocationText;
    }

    if (changeLogColumns.includes("resource")) {
      consolidatedChangeLogRow.resource = consolidatedResourceText;
    }
    if (changeLogColumns.includes("resources")) {
      consolidatedChangeLogRow.resources = consolidatedResourceText;
    }

    if (changeLogColumns.includes("summarynotes")) {
      consolidatedChangeLogRow.summarynotes = notes || "";
    }
    if (changeLogColumns.includes("notes")) {
      consolidatedChangeLogRow.notes = notes || "";
    }
    if (changeLogColumns.includes("change_summary")) {
      consolidatedChangeLogRow.change_summary = deleteChangeSummary;
    }

    if (changeLogColumns.includes("user_name")) {
      consolidatedChangeLogRow.user_name = changedBy;
    }
    if (changeLogColumns.includes("created_by")) {
      consolidatedChangeLogRow.created_by = changedBy;
    }
    if (changeLogColumns.includes("updated_by")) {
      consolidatedChangeLogRow.updated_by = changedBy;
    }

    if (changeLogColumns.includes("change_date")) {
      consolidatedChangeLogRow.change_date = chicagoNowText;
    }
    if (changeLogColumns.includes("created_at")) {
      consolidatedChangeLogRow.created_at = chicagoNowText;
    }
    if (changeLogColumns.includes("created_on")) {
      consolidatedChangeLogRow.created_on = chicagoNowText;
    }

    if (changeLogColumns.includes("status")) {
      consolidatedChangeLogRow.status = "COMPLETED";
    }

    const { query: changeLogInsertQuery, values: changeLogInsertValues } =
      buildDynamicInsertQuery(
        changeLogTable,
        consolidatedChangeLogRow,
        changeLogColumns
      );

    await client.query(changeLogInsertQuery, changeLogInsertValues);

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      message: "Selected Item BOM Routing records were deleted successfully.",
      engineeringChangeId,
      changeType: "Deleted",
      movedCount,
      bomProducedDeletedCount,
      archivedRecIds,
      archivedBomProducedRecIds,
    });
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      console.error("Rollback Error (delete-item-bom-routing/execute):", rollbackError);
    }

    console.error("DB Error (delete-item-bom-routing/execute):", error);

    return res.status(500).json({
      success: false,
      error: "Failed to delete item BOM routing records",
      details: error.message,
    });
  } finally {
    client.release();
  }
});
/* =========================================================
   ENGINEERING CHANGE LOG SUMMARY
   GET /api/tables/engineering-change-log
   Fetch logs from planning_bom_change_log_summary (PostgreSQL)
========================================================= */
router.get("/engineering-change-log", async (req, res) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, Number.parseInt(req.query.pageSize, 10) || 50)
    );
    const offset = (page - 1) * pageSize;

    const PG_SCHEMA = S;
    const TABLES = {
      changeLog: T.changeLog,
      bomProduced: T.bomProduced,
      bomConsumed: T.bomConsumed,
      itemBomRouting: T.itemBomRouting,
      itemDetails: T.itemDetails,
      bomProducedOg: T.bomProducedOg,
      bomConsumedOg: T.bomConsumedOg,
      itemBomRoutingOg: T.itemBomRoutingOg,
    };

    const q = (name) => `"${String(name).replace(/"/g, '""')}"`;
    const tbl = (name) => `${q(PG_SCHEMA)}.${q(name)}`;

    const normalizeText = (value) =>
      value == null ? "" : String(value).trim();

    const uniqueValues = (arr) => [
      ...new Set((arr || []).map((v) => normalizeText(v)).filter(Boolean)),
    ];

    const formatChangeDate = (value) => {
      if (!value) return "";

      if (value instanceof Date) {
        const yyyy = value.getFullYear();
        const mm = String(value.getMonth() + 1).padStart(2, "0");
        const dd = String(value.getDate()).padStart(2, "0");
        const hh = String(value.getHours()).padStart(2, "0");
        const mi = String(value.getMinutes()).padStart(2, "0");
        const ss = String(value.getSeconds()).padStart(2, "0");

        return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
      }

      return String(value);
    };

    const csvSplitExpr = (columnSql) => `
      regexp_split_to_table(COALESCE(${columnSql}::TEXT, ''), '\\s*,\\s*')
    `;

    const pageEcResult = await pool.query(
      `
        WITH distinct_ec AS (
          SELECT
            cl.engineering_change_id::TEXT AS engineering_change_id,
            MAX(cl.change_date) AS latest_change_date,
            MAX(cl.rec_id::TEXT) AS latest_rec_id
          FROM ${tbl(TABLES.changeLog)} cl
          WHERE cl.engineering_change_id IS NOT NULL
            AND TRIM(cl.engineering_change_id::TEXT) <> ''
          GROUP BY cl.engineering_change_id::TEXT
        ),
        counted AS (
          SELECT
            *,
            COUNT(*) OVER() AS total_count
          FROM distinct_ec
        )
        SELECT
          engineering_change_id,
          total_count
        FROM counted
        ORDER BY
          latest_change_date DESC NULLS LAST,
          engineering_change_id DESC,
          latest_rec_id DESC
        LIMIT $1
        OFFSET $2
      `,
      [pageSize, offset]
    );

    const pageEcIds = (pageEcResult.rows || [])
      .map((row) => normalizeText(row.engineering_change_id))
      .filter(Boolean);

    const total = pageEcResult.rows.length
      ? Number(pageEcResult.rows[0].total_count || 0)
      : 0;

    const totalPages = Math.max(1, Math.ceil(total / pageSize));

    if (!pageEcIds.length) {
      return res.status(200).json({
        success: true,
        data: [],
        pagination: {
          page,
          pageSize,
          total,
          totalPages,
          hasPrev: page > 1,
          hasNext: page < totalPages,
        },
      });
    }

    const queryParams = [pageEcIds];

    const baseQuery = `
      SELECT
        cl.rec_id,
        cl.postgresql_rec_id,
        cl.engineering_change_id,
        cl.change_type,
        cl.target_table,
        cl.bom_id,
        cl.produced_item,
        cl.consumed_item,
        cl.location,
        cl.resource,
        cl.change_date,
        cl.user_name,
        cl.summarynotes,
        cl.change_summary
      FROM ${tbl(TABLES.changeLog)} cl
      WHERE cl.engineering_change_id::TEXT = ANY($1)
      ORDER BY
        cl.change_date DESC NULLS LAST,
        cl.engineering_change_id DESC,
        cl.rec_id DESC
    `;

    const mainBomQuery = `
  WITH log_boms AS (
    SELECT DISTINCT
      cl.engineering_change_id,
      cl.change_date,
      cl.change_type,
      TRIM(b.bom_id) AS bom_id,
      cl.location,
      cl.resource,
      cl.user_name
    FROM ${tbl(TABLES.changeLog)} cl
    CROSS JOIN LATERAL ${csvSplitExpr("cl.bom_id")} AS b(bom_id)
    WHERE cl.engineering_change_id::TEXT = ANY($1)
      AND TRIM(b.bom_id) <> ''
  ),
  routing_union AS (
    SELECT
      lb.engineering_change_id,
      lb.change_date,
      lb.change_type,
      lb.bom_id,

      -- location from planning_bom_change_log_summary
      lb.location,

      -- resource from planning_bom_change_log_summary
      lb.resource,

      lb.user_name,
      ibr.item,
      ibr.erp_co_product_association,
      ibr.erp_item_bom_routing_priority,

      -- routing_id from item_bom_routing
      ibr.routing_id,

      1 AS source_priority
    FROM log_boms lb
    INNER JOIN ${tbl(TABLES.itemBomRouting)} ibr
      ON UPPER(TRIM(ibr.bom_id::TEXT)) = UPPER(TRIM(lb.bom_id::TEXT))
    WHERE LOWER(COALESCE(lb.change_type, '')) NOT LIKE '%delete%'

    UNION ALL

    SELECT
      lb.engineering_change_id,
      lb.change_date,
      lb.change_type,
      lb.bom_id,

      -- location from planning_bom_change_log_summary
      lb.location,

      -- resource from planning_bom_change_log_summary
      lb.resource,

      lb.user_name,
      og_ibr.item,
      og_ibr.erp_co_product_association,
      og_ibr.erp_item_bom_routing_priority,

      -- routing_id from item_bom_routing_og
      og_ibr.routing_id,

      2 AS source_priority
    FROM log_boms lb
    INNER JOIN ${tbl(TABLES.itemBomRoutingOg)} og_ibr
      ON UPPER(TRIM(og_ibr.bom_id::TEXT)) = UPPER(TRIM(lb.bom_id::TEXT))
  ),
  main_routing AS (
    SELECT DISTINCT ON (
      engineering_change_id,
      bom_id,
      item,
      COALESCE(erp_item_bom_routing_priority::TEXT, '')
    )
      *
    FROM routing_union
    WHERE COALESCE(erp_co_product_association, 0) <> 1
    ORDER BY
      engineering_change_id,
      bom_id,
      item,
      COALESCE(erp_item_bom_routing_priority::TEXT, ''),
      CASE
        WHEN LOWER(COALESCE(change_type, '')) LIKE '%delete%'
          THEN source_priority * -1
        ELSE source_priority
      END
  ),
  produced_qty AS (
    SELECT
      lb.engineering_change_id,
      lb.bom_id,
      bp.item,
      bp.bom_version,
      1 AS source_priority
    FROM log_boms lb
    INNER JOIN ${tbl(TABLES.bomProduced)} bp
      ON UPPER(TRIM(bp.bom_id::TEXT)) = UPPER(TRIM(lb.bom_id::TEXT))
    WHERE LOWER(COALESCE(lb.change_type, '')) NOT LIKE '%delete%'

    UNION ALL

    SELECT
      lb.engineering_change_id,
      lb.bom_id,
      og_bp.item,
      og_bp.bom_version,
      2 AS source_priority
    FROM log_boms lb
    INNER JOIN ${tbl(TABLES.bomProducedOg)} og_bp
      ON UPPER(TRIM(og_bp.bom_id::TEXT)) = UPPER(TRIM(lb.bom_id::TEXT))
  ),
  produced_qty_one AS (
    SELECT DISTINCT ON (engineering_change_id, bom_id, item)
      engineering_change_id,
      bom_id,
      item,
      bom_version
    FROM produced_qty
    ORDER BY engineering_change_id, bom_id, item, source_priority
  )
  SELECT DISTINCT
    mr.engineering_change_id,
    mr.change_date,
    mr.change_type,
    mr.item AS produced_item,
    id.item_description,
    id.item_release_flag,

    -- from change log summary
    mr.location,

    mr.bom_id,
    pq.bom_version,

    -- from change log summary
    mr.resource,

    id.resource_relevancy,

    -- directly from item_bom_routing
    mr.routing_id AS routing_id,

    mr.erp_item_bom_routing_priority AS item_bom_routing_priority,
    mr.user_name
  FROM main_routing mr
  LEFT JOIN produced_qty_one pq
    ON pq.engineering_change_id = mr.engineering_change_id
   AND UPPER(TRIM(pq.bom_id::TEXT)) = UPPER(TRIM(mr.bom_id::TEXT))
   AND UPPER(TRIM(pq.item::TEXT)) = UPPER(TRIM(mr.item::TEXT))
  LEFT JOIN ${tbl(TABLES.itemDetails)} id
    ON UPPER(TRIM(id.item::TEXT)) = UPPER(TRIM(mr.item::TEXT))
  ORDER BY
    mr.engineering_change_id,
    mr.bom_id,
    mr.item,
    mr.resource,
    mr.erp_item_bom_routing_priority
`;

    const componentQuery = `
      WITH log_boms AS (
        SELECT DISTINCT
          cl.engineering_change_id,
          cl.change_date,
          cl.change_type,
          TRIM(b.bom_id) AS bom_id,
          cl.location,
          cl.resource,
          cl.user_name,
          cl.consumed_item
        FROM ${tbl(TABLES.changeLog)} cl
        CROSS JOIN LATERAL ${csvSplitExpr("cl.bom_id")} AS b(bom_id)
        WHERE cl.engineering_change_id::TEXT = ANY($1)
          AND TRIM(b.bom_id) <> ''
      ),
      main_items AS (
        SELECT
          lb.engineering_change_id,
          lb.bom_id,
          STRING_AGG(DISTINCT ibr.item::TEXT, ', ' ORDER BY ibr.item::TEXT) AS produced_item
        FROM log_boms lb
        INNER JOIN ${tbl(TABLES.itemBomRouting)} ibr
          ON UPPER(TRIM(ibr.bom_id::TEXT)) = UPPER(TRIM(lb.bom_id::TEXT))
         AND COALESCE(ibr.erp_co_product_association, 0) <> 1
        WHERE LOWER(COALESCE(lb.change_type, '')) NOT LIKE '%delete%'
        GROUP BY lb.engineering_change_id, lb.bom_id

        UNION ALL

        SELECT
          lb.engineering_change_id,
          lb.bom_id,
          STRING_AGG(DISTINCT og_ibr.item::TEXT, ', ' ORDER BY og_ibr.item::TEXT) AS produced_item
        FROM log_boms lb
        INNER JOIN ${tbl(TABLES.itemBomRoutingOg)} og_ibr
          ON UPPER(TRIM(og_ibr.bom_id::TEXT)) = UPPER(TRIM(lb.bom_id::TEXT))
         AND COALESCE(og_ibr.erp_co_product_association, 0) <> 1
        WHERE LOWER(COALESCE(lb.change_type, '')) LIKE '%delete%'
        GROUP BY lb.engineering_change_id, lb.bom_id
      ),
      consumed_filter AS (
        SELECT DISTINCT
          lb.engineering_change_id,
          lb.bom_id,
          TRIM(c.item) AS component_item
        FROM log_boms lb
        CROSS JOIN LATERAL ${csvSplitExpr("lb.consumed_item")} AS c(item)
        WHERE TRIM(c.item) <> ''
      ),
      consumed_union AS (
        SELECT
          lb.*,
          bc.item AS component_item,
          bc.erp_bom_quantity_consumed_per AS standard_usage,
          1 AS source_priority
        FROM log_boms lb
        INNER JOIN ${tbl(TABLES.bomConsumed)} bc
          ON UPPER(TRIM(bc.bom_id::TEXT)) = UPPER(TRIM(lb.bom_id::TEXT))
        LEFT JOIN consumed_filter cf
          ON cf.engineering_change_id = lb.engineering_change_id
         AND UPPER(TRIM(cf.bom_id::TEXT)) = UPPER(TRIM(lb.bom_id::TEXT))
         AND UPPER(TRIM(cf.component_item::TEXT)) = UPPER(TRIM(bc.item::TEXT))
        WHERE LOWER(COALESCE(lb.change_type, '')) NOT LIKE '%delete%'
          AND (
            NOT EXISTS (
              SELECT 1
              FROM consumed_filter cf2
              WHERE cf2.engineering_change_id = lb.engineering_change_id
                AND UPPER(TRIM(cf2.bom_id::TEXT)) = UPPER(TRIM(lb.bom_id::TEXT))
            )
            OR cf.component_item IS NOT NULL
          )

        UNION ALL

        SELECT
          lb.*,
          og_bc.item AS component_item,
          og_bc.erp_bom_quantity_consumed_per AS standard_usage,
          2 AS source_priority
        FROM log_boms lb
        INNER JOIN ${tbl(TABLES.bomConsumedOg)} og_bc
          ON UPPER(TRIM(og_bc.bom_id::TEXT)) = UPPER(TRIM(lb.bom_id::TEXT))
        LEFT JOIN consumed_filter cf
          ON cf.engineering_change_id = lb.engineering_change_id
         AND UPPER(TRIM(cf.bom_id::TEXT)) = UPPER(TRIM(lb.bom_id::TEXT))
         AND UPPER(TRIM(cf.component_item::TEXT)) = UPPER(TRIM(og_bc.item::TEXT))
        WHERE LOWER(COALESCE(lb.change_type, '')) LIKE '%delete%'
          AND (
            NOT EXISTS (
              SELECT 1
              FROM consumed_filter cf2
              WHERE cf2.engineering_change_id = lb.engineering_change_id
                AND UPPER(TRIM(cf2.bom_id::TEXT)) = UPPER(TRIM(lb.bom_id::TEXT))
            )
            OR cf.component_item IS NOT NULL
          )
      ),
      consumed_one AS (
        SELECT DISTINCT ON (engineering_change_id, bom_id, component_item)
          *
        FROM consumed_union
        ORDER BY engineering_change_id, bom_id, component_item, source_priority
      )
      SELECT DISTINCT
        cu.engineering_change_id,
        cu.change_date,
        cu.change_type,
        mi.produced_item,
        cu.bom_id,
        cu.component_item,
        id.item_description AS component_item_description,
        cu.standard_usage,
        cu.user_name
      FROM consumed_one cu
      LEFT JOIN main_items mi
        ON mi.engineering_change_id = cu.engineering_change_id
       AND UPPER(TRIM(mi.bom_id::TEXT)) = UPPER(TRIM(cu.bom_id::TEXT))
      LEFT JOIN ${tbl(TABLES.itemDetails)} id
        ON UPPER(TRIM(id.item::TEXT)) = UPPER(TRIM(cu.component_item::TEXT))
      ORDER BY cu.engineering_change_id, cu.bom_id, cu.component_item
    `;

    const coProductQuery = `
      WITH log_boms AS (
        SELECT DISTINCT
          cl.engineering_change_id,
          cl.change_date,
          cl.change_type,
          TRIM(b.bom_id) AS bom_id,
          cl.location,
          cl.resource,
          cl.user_name
        FROM ${tbl(TABLES.changeLog)} cl
        CROSS JOIN LATERAL ${csvSplitExpr("cl.bom_id")} AS b(bom_id)
        WHERE cl.engineering_change_id::TEXT = ANY($1)
          AND TRIM(b.bom_id) <> ''
      ),
      main_items AS (
        SELECT
          lb.engineering_change_id,
          lb.bom_id,
          STRING_AGG(DISTINCT ibr.item::TEXT, ', ' ORDER BY ibr.item::TEXT) AS produced_item
        FROM log_boms lb
        INNER JOIN ${tbl(TABLES.itemBomRouting)} ibr
          ON UPPER(TRIM(ibr.bom_id::TEXT)) = UPPER(TRIM(lb.bom_id::TEXT))
         AND COALESCE(ibr.erp_co_product_association, 0) <> 1
        WHERE LOWER(COALESCE(lb.change_type, '')) NOT LIKE '%delete%'
        GROUP BY lb.engineering_change_id, lb.bom_id

        UNION ALL

        SELECT
          lb.engineering_change_id,
          lb.bom_id,
          STRING_AGG(DISTINCT og_ibr.item::TEXT, ', ' ORDER BY og_ibr.item::TEXT) AS produced_item
        FROM log_boms lb
        INNER JOIN ${tbl(TABLES.itemBomRoutingOg)} og_ibr
          ON UPPER(TRIM(og_ibr.bom_id::TEXT)) = UPPER(TRIM(lb.bom_id::TEXT))
         AND COALESCE(og_ibr.erp_co_product_association, 0) <> 1
        WHERE LOWER(COALESCE(lb.change_type, '')) LIKE '%delete%'
        GROUP BY lb.engineering_change_id, lb.bom_id
      ),
      coproduct_routing AS (
        SELECT
          lb.*,
          ibr.item AS co_product_item,
          1 AS source_priority
        FROM log_boms lb
        INNER JOIN ${tbl(TABLES.itemBomRouting)} ibr
          ON UPPER(TRIM(ibr.bom_id::TEXT)) = UPPER(TRIM(lb.bom_id::TEXT))
         AND COALESCE(ibr.erp_co_product_association, 0) = 1
        WHERE LOWER(COALESCE(lb.change_type, '')) NOT LIKE '%delete%'

        UNION ALL

        SELECT
          lb.*,
          og_ibr.item AS co_product_item,
          2 AS source_priority
        FROM log_boms lb
        INNER JOIN ${tbl(TABLES.itemBomRoutingOg)} og_ibr
          ON UPPER(TRIM(og_ibr.bom_id::TEXT)) = UPPER(TRIM(lb.bom_id::TEXT))
         AND COALESCE(og_ibr.erp_co_product_association, 0) = 1
        WHERE LOWER(COALESCE(lb.change_type, '')) LIKE '%delete%'
      ),
      coproduct_one AS (
        SELECT DISTINCT ON (engineering_change_id, bom_id, co_product_item)
          *
        FROM coproduct_routing
        ORDER BY engineering_change_id, bom_id, co_product_item, source_priority
      ),
      qty_union AS (
        SELECT
          lb.engineering_change_id,
          lb.bom_id,
          bp.item,
          bp.erp_bom_qty_produced_per,
          1 AS source_priority
        FROM log_boms lb
        INNER JOIN ${tbl(TABLES.bomProduced)} bp
          ON UPPER(TRIM(bp.bom_id::TEXT)) = UPPER(TRIM(lb.bom_id::TEXT))
        WHERE LOWER(COALESCE(lb.change_type, '')) NOT LIKE '%delete%'

        UNION ALL

        SELECT
          lb.engineering_change_id,
          lb.bom_id,
          og_bp.item,
          og_bp.erp_bom_qty_produced_per,
          2 AS source_priority
        FROM log_boms lb
        INNER JOIN ${tbl(TABLES.bomProducedOg)} og_bp
          ON UPPER(TRIM(og_bp.bom_id::TEXT)) = UPPER(TRIM(lb.bom_id::TEXT))
        WHERE LOWER(COALESCE(lb.change_type, '')) LIKE '%delete%'
      ),
      qty_one AS (
        SELECT DISTINCT ON (engineering_change_id, bom_id, item)
          engineering_change_id,
          bom_id,
          item,
          erp_bom_qty_produced_per
        FROM qty_union
        ORDER BY engineering_change_id, bom_id, item, source_priority
      )
      SELECT DISTINCT
        cp.engineering_change_id,
        cp.change_date,
        cp.change_type,
        mi.produced_item,
        cp.bom_id,
        cp.co_product_item,
        id.item_description AS co_product_item_description,
        q.erp_bom_qty_produced_per AS co_product_quantity_produced,
        cp.user_name
      FROM coproduct_one cp
      LEFT JOIN main_items mi
        ON mi.engineering_change_id = cp.engineering_change_id
       AND UPPER(TRIM(mi.bom_id::TEXT)) = UPPER(TRIM(cp.bom_id::TEXT))
      LEFT JOIN qty_one q
        ON q.engineering_change_id = cp.engineering_change_id
       AND UPPER(TRIM(q.bom_id::TEXT)) = UPPER(TRIM(cp.bom_id::TEXT))
       AND UPPER(TRIM(q.item::TEXT)) = UPPER(TRIM(cp.co_product_item::TEXT))
      LEFT JOIN ${tbl(TABLES.itemDetails)} id
        ON UPPER(TRIM(id.item::TEXT)) = UPPER(TRIM(cp.co_product_item::TEXT))
      ORDER BY cp.engineering_change_id, cp.bom_id, cp.co_product_item
    `;

    const modifiedComparisonQuery = `
      WITH modified_boms AS (
        SELECT DISTINCT
          cl.engineering_change_id,
          cl.change_date,
          cl.change_type,
          TRIM(b.bom_id) AS bom_id,
          cl.location,
          cl.resource,
          cl.user_name
        FROM ${tbl(TABLES.changeLog)} cl
        CROSS JOIN LATERAL ${csvSplitExpr("cl.bom_id")} AS b(bom_id)
        WHERE cl.engineering_change_id::TEXT = ANY($1)
          AND LOWER(COALESCE(cl.change_type, '')) LIKE '%modif%'
          AND TRIM(b.bom_id) <> ''
      ),
      main_items AS (
        SELECT DISTINCT
          mb.engineering_change_id,
          mb.change_date,
          mb.change_type,
          mb.bom_id,
          mb.location,
          mb.resource,
          mb.user_name,
          COALESCE(main_ibr.item, og_ibr.item)::TEXT AS produced_item
        FROM modified_boms mb
        LEFT JOIN ${tbl(TABLES.itemBomRouting)} main_ibr
          ON UPPER(TRIM(main_ibr.bom_id::TEXT)) = UPPER(TRIM(mb.bom_id::TEXT))
         AND COALESCE(main_ibr.erp_co_product_association, 0) <> 1
        LEFT JOIN ${tbl(TABLES.itemBomRoutingOg)} og_ibr
          ON UPPER(TRIM(og_ibr.bom_id::TEXT)) = UPPER(TRIM(mb.bom_id::TEXT))
         AND COALESCE(og_ibr.erp_co_product_association, 0) <> 1
        WHERE COALESCE(main_ibr.item, og_ibr.item) IS NOT NULL
      ),
      component_keys AS (
        SELECT DISTINCT
          mi.engineering_change_id,
          mi.change_date,
          mi.change_type,
          mi.produced_item,
          mi.bom_id,
          mi.resource,
          mi.user_name,
          main_bc.item::TEXT AS item
        FROM main_items mi
        INNER JOIN ${tbl(TABLES.bomConsumed)} main_bc
          ON UPPER(TRIM(main_bc.bom_id::TEXT)) = UPPER(TRIM(mi.bom_id::TEXT))

        UNION

        SELECT DISTINCT
          mi.engineering_change_id,
          mi.change_date,
          mi.change_type,
          mi.produced_item,
          mi.bom_id,
          mi.resource,
          mi.user_name,
          og_bc.item::TEXT AS item
        FROM main_items mi
        INNER JOIN ${tbl(TABLES.bomConsumedOg)} og_bc
          ON UPPER(TRIM(og_bc.bom_id::TEXT)) = UPPER(TRIM(mi.bom_id::TEXT))
      ),
      component_diffs AS (
        SELECT DISTINCT
          ck.engineering_change_id,
          ck.change_date,
          ck.change_type,
          ck.produced_item,
          ck.bom_id,
          ck.resource,
          ck.user_name,
          'Component' AS section,
          CASE
            WHEN og_bc.item IS NULL THEN 'Added'
            WHEN main_bc.item IS NULL THEN 'Deleted'
            WHEN COALESCE(og_bc.erp_bom_quantity_consumed_per::TEXT, '')
                 IS DISTINCT FROM COALESCE(main_bc.erp_bom_quantity_consumed_per::TEXT, '')
              THEN 'Modified'
          END AS action,
          ck.item,
          'Standard Usage' AS field,
          og_bc.erp_bom_quantity_consumed_per::TEXT AS original_value,
          main_bc.erp_bom_quantity_consumed_per::TEXT AS updated_value
        FROM component_keys ck
        LEFT JOIN ${tbl(TABLES.bomConsumed)} main_bc
          ON UPPER(TRIM(main_bc.bom_id::TEXT)) = UPPER(TRIM(ck.bom_id::TEXT))
         AND UPPER(TRIM(main_bc.item::TEXT)) = UPPER(TRIM(ck.item::TEXT))
        LEFT JOIN ${tbl(TABLES.bomConsumedOg)} og_bc
          ON UPPER(TRIM(og_bc.bom_id::TEXT)) = UPPER(TRIM(ck.bom_id::TEXT))
         AND UPPER(TRIM(og_bc.item::TEXT)) = UPPER(TRIM(ck.item::TEXT))
        WHERE
          og_bc.item IS NULL
          OR main_bc.item IS NULL
          OR COALESCE(og_bc.erp_bom_quantity_consumed_per::TEXT, '')
             IS DISTINCT FROM COALESCE(main_bc.erp_bom_quantity_consumed_per::TEXT, '')
      ),
      coproduct_keys AS (
        SELECT DISTINCT
          mi.engineering_change_id,
          mi.change_date,
          mi.change_type,
          mi.produced_item,
          mi.bom_id,
          mi.resource,
          mi.user_name,
          main_bp.item::TEXT AS item
        FROM main_items mi
        INNER JOIN ${tbl(TABLES.bomProduced)} main_bp
          ON UPPER(TRIM(main_bp.bom_id::TEXT)) = UPPER(TRIM(mi.bom_id::TEXT))
        INNER JOIN ${tbl(TABLES.itemBomRouting)} main_ibr
          ON UPPER(TRIM(main_ibr.bom_id::TEXT)) = UPPER(TRIM(mi.bom_id::TEXT))
         AND UPPER(TRIM(main_ibr.item::TEXT)) = UPPER(TRIM(main_bp.item::TEXT))
         AND COALESCE(main_ibr.erp_co_product_association, 0) = 1

        UNION

        SELECT DISTINCT
          mi.engineering_change_id,
          mi.change_date,
          mi.change_type,
          mi.produced_item,
          mi.bom_id,
          mi.resource,
          mi.user_name,
          og_bp.item::TEXT AS item
        FROM main_items mi
        INNER JOIN ${tbl(TABLES.bomProducedOg)} og_bp
          ON UPPER(TRIM(og_bp.bom_id::TEXT)) = UPPER(TRIM(mi.bom_id::TEXT))
        INNER JOIN ${tbl(TABLES.itemBomRoutingOg)} og_ibr
          ON UPPER(TRIM(og_ibr.bom_id::TEXT)) = UPPER(TRIM(mi.bom_id::TEXT))
         AND UPPER(TRIM(og_ibr.item::TEXT)) = UPPER(TRIM(og_bp.item::TEXT))
         AND COALESCE(og_ibr.erp_co_product_association, 0) = 1
      ),
      coproduct_diffs AS (
        SELECT DISTINCT
          ck.engineering_change_id,
          ck.change_date,
          ck.change_type,
          ck.produced_item,
          ck.bom_id,
          ck.resource,
          ck.user_name,
          'Co-Product' AS section,
          CASE
            WHEN og_bp.item IS NULL THEN 'Added'
            WHEN main_bp.item IS NULL THEN 'Deleted'
            WHEN COALESCE(og_bp.erp_bom_qty_produced_per::TEXT, '')
                 IS DISTINCT FROM COALESCE(main_bp.erp_bom_qty_produced_per::TEXT, '')
              THEN 'Modified'
          END AS action,
          ck.item,
          'Co-Product Quantity Produced' AS field,
          og_bp.erp_bom_qty_produced_per::TEXT AS original_value,
          main_bp.erp_bom_qty_produced_per::TEXT AS updated_value
        FROM coproduct_keys ck
        LEFT JOIN ${tbl(TABLES.bomProduced)} main_bp
          ON UPPER(TRIM(main_bp.bom_id::TEXT)) = UPPER(TRIM(ck.bom_id::TEXT))
         AND UPPER(TRIM(main_bp.item::TEXT)) = UPPER(TRIM(ck.item::TEXT))
        LEFT JOIN ${tbl(TABLES.bomProducedOg)} og_bp
          ON UPPER(TRIM(og_bp.bom_id::TEXT)) = UPPER(TRIM(ck.bom_id::TEXT))
         AND UPPER(TRIM(og_bp.item::TEXT)) = UPPER(TRIM(ck.item::TEXT))
        WHERE
          og_bp.item IS NULL
          OR main_bp.item IS NULL
          OR COALESCE(og_bp.erp_bom_qty_produced_per::TEXT, '')
             IS DISTINCT FROM COALESCE(main_bp.erp_bom_qty_produced_per::TEXT, '')
      ),
      all_diffs AS (
        SELECT * FROM component_diffs WHERE action IS NOT NULL
        UNION ALL
        SELECT * FROM coproduct_diffs WHERE action IS NOT NULL
      ),
      counted AS (
        SELECT
          *,
          COUNT(*) FILTER (WHERE action = 'Added')
            OVER (PARTITION BY engineering_change_id, produced_item, bom_id, resource, section) AS added_count,
          COUNT(*) FILTER (WHERE action = 'Deleted')
            OVER (PARTITION BY engineering_change_id, produced_item, bom_id, resource, section) AS deleted_count,
          COUNT(*) FILTER (WHERE action = 'Modified')
            OVER (PARTITION BY engineering_change_id, produced_item, bom_id, resource, section) AS modified_count,
          CASE action
            WHEN 'Added' THEN 1
            WHEN 'Deleted' THEN 2
            WHEN 'Modified' THEN 3
            ELSE 4
          END AS action_sort_order
        FROM all_diffs
      )
      SELECT DISTINCT
        engineering_change_id,
        change_date,
        change_type,
        produced_item,
        bom_id,
        resource,
        user_name,
        section,
        action,
        item,
        added_count,
        deleted_count,
        modified_count,
        field,
        original_value,
        updated_value,
        action_sort_order
      FROM counted
      ORDER BY
        engineering_change_id,
        produced_item,
        bom_id,
        resource,
        section,
        action_sort_order,
        item,
        field
    `;

    const [
      baseResult,
      mainBomResult,
      componentResult,
      coProductResult,
      modifiedComparisonResult,
    ] = await Promise.all([
      pool.query(baseQuery, queryParams),
      pool.query(mainBomQuery, queryParams),
      pool.query(componentQuery, queryParams),
      pool.query(coProductQuery, queryParams),
      pool.query(modifiedComparisonQuery, queryParams),
    ]);

    const baseRows = baseResult.rows || [];
    const mainBomRows = mainBomResult.rows || [];
    const componentRows = componentResult.rows || [];
    const coProductRows = coProductResult.rows || [];
    const modifiedRows = modifiedComparisonResult.rows || [];

    const groupByEcId = (rows) => {
      const map = new Map();

      for (const row of rows || []) {
        const ecId = normalizeText(row.engineering_change_id);
        if (!ecId) continue;

        if (!map.has(ecId)) map.set(ecId, []);
        map.get(ecId).push(row);
      }

      return map;
    };

    const mainBomByEc = groupByEcId(mainBomRows);
    const componentByEc = groupByEcId(componentRows);
    const coProductByEc = groupByEcId(coProductRows);
    const modifiedByEc = groupByEcId(modifiedRows);

    const summaryMap = new Map();

    for (const row of baseRows) {
      const ecId = normalizeText(row.engineering_change_id);
      if (!ecId) continue;

      if (!summaryMap.has(ecId)) {
        summaryMap.set(ecId, {
          engineering_change_id: ecId,
          change_date: formatChangeDate(row.change_date),
          change_type: normalizeText(row.change_type),
          bom_ids: [],
          locations: [],
          resources: [],
          user_name: normalizeText(row.user_name),
          change_summary:
            normalizeText(row.change_summary) || normalizeText(row.summarynotes),
          summarynotes: normalizeText(row.summarynotes),
          component_items: [],
        });
      }

      const summary = summaryMap.get(ecId);

      summary.bom_ids.push(
        ...String(row.bom_id || "")
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean)
      );

      summary.locations.push(row.location);
      summary.resources.push(row.resource);

      summary.component_items.push(
        ...String(row.consumed_item || "")
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean)
      );

      if (!summary.change_date && row.change_date) {
        summary.change_date = formatChangeDate(row.change_date);
      }

      if (!summary.change_type && row.change_type) {
        summary.change_type = normalizeText(row.change_type);
      }

      if (!summary.user_name && row.user_name) {
        summary.user_name = normalizeText(row.user_name);
      }

      if (!summary.change_summary) {
        summary.change_summary =
          normalizeText(row.change_summary) || normalizeText(row.summarynotes);
      }
    }

    const responseRows = Array.from(summaryMap.values()).map((summary) => {
      const ecId = summary.engineering_change_id;

      const mainDetails = mainBomByEc.get(ecId) || [];
      const componentDetails = componentByEc.get(ecId) || [];
      const coProductDetails = coProductByEc.get(ecId) || [];
      const modifiedDetails = modifiedByEc.get(ecId) || [];

      const bomIds = uniqueValues([
        ...summary.bom_ids,
        ...mainDetails.map((r) => r.bom_id),
        ...componentDetails.map((r) => r.bom_id),
        ...coProductDetails.map((r) => r.bom_id),
      ]);

      const locations = uniqueValues([
        ...summary.locations,
        ...mainDetails.map((r) => r.location),
      ]);

      const resources = uniqueValues([
        ...summary.resources,
        ...mainDetails.map((r) => r.resource),
      ]);

      const producedItems = uniqueValues([
        ...mainDetails.map((r) => r.produced_item),
        ...componentDetails.map((r) => r.produced_item),
        ...coProductDetails.map((r) => r.produced_item),
      ]);

      const componentItems = uniqueValues([
        ...summary.component_items,
        ...componentDetails.map((r) => r.component_item),
      ]);

      const coProductItems = uniqueValues(
        coProductDetails.map((r) => r.co_product_item)
      );

      return {
        engineering_change_id: ecId,
        change_date: summary.change_date,
        change_type: summary.change_type,
        locations: locations.join(", "),
        location: locations.join(", "),
        bom_ids: bomIds.join(", "),
        bom_id: bomIds.join(", "),
        resources: resources.join(", "),
        resource: resources.join(", "),
        user_name: summary.user_name,
        change_summary: summary.change_summary,
        summarynotes: summary.summarynotes,
        produced_item: producedItems.join(", "),
        consumed_item: componentItems.join(", "),
        co_product_item: coProductItems.join(", "),

        main_bom_details: mainDetails.map((r) => ({
          engineering_change_id: r.engineering_change_id,
          change_date: formatChangeDate(r.change_date),
          change_type: r.change_type,
          produced_item: r.produced_item,
          item_description: r.item_description,
          item_release_flag: r.item_release_flag,
          location: r.location,
          bom_id: r.bom_id,
          bom_version: r.bom_version,
          resource: r.resource,
          resource_relevancy: r.resource_relevancy,
          routing_id: r.routing_id,
          item_bom_routing_priority: r.item_bom_routing_priority,
          user_name: r.user_name,
        })),

        component_details: componentDetails.map((r) => ({
          engineering_change_id: r.engineering_change_id,
          change_date: formatChangeDate(r.change_date),
          change_type: r.change_type,
          produced_item: r.produced_item,
          bom_id: r.bom_id,
          component_item: r.component_item,
          component_item_description: r.component_item_description,
          standard_usage: r.standard_usage,
          user_name: r.user_name,
        })),

        co_product_details: coProductDetails.map((r) => ({
          engineering_change_id: r.engineering_change_id,
          change_date: formatChangeDate(r.change_date),
          change_type: r.change_type,
          produced_item: r.produced_item,
          bom_id: r.bom_id,
          co_product_item: r.co_product_item,
          co_product_item_description: r.co_product_item_description,
          co_product_quantity_produced: r.co_product_quantity_produced,
          user_name: r.user_name,
        })),

        modified_field_comparison: modifiedDetails.map((r) => ({
          engineering_change_id: r.engineering_change_id,
          change_date: formatChangeDate(r.change_date),
          change_type: r.change_type,
          produced_item: r.produced_item,
          bom_id: r.bom_id,
          resource: r.resource,
          section: r.section,
          action: r.action,
          item: r.item,
          added_count: r.added_count,
          deleted_count: r.deleted_count,
          modified_count: r.modified_count,
          field: r.field,
          original_value: r.original_value,
          updated_value: r.updated_value,
          old_value: r.original_value,
          new_value: r.updated_value,
          user_name: r.user_name,
        })),
      };
    });

    return res.status(200).json({
      success: true,
      data: responseRows,
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
        hasPrev: page > 1,
        hasNext: page < totalPages,
      },
    });
  } catch (error) {
    console.error("DB Error (engineering-change-log):", error);

    return res.status(500).json({
      success: false,
      error: "Failed to fetch engineering change log",
      details: error.message,
    });
  }
});



router.get("/engineering-changes-detail-add", async (req, res) => {
  try {
    const engineeringChangeId = String(
      req.query.changeID || req.query.engineeringChangeId || ""
    ).trim();

    if (!engineeringChangeId) {
      return res.status(400).json({
        error: "engineeringChangeId/changeID is required",
      });
    }

    const changeLogTable = T.changeLog;
    const changeLogColumns = await getExistingColumns(pool, changeLogTable);
    const itemDetailsColumns = await getExistingColumns(pool, T.itemDetails);

    const dateSelectExpr = changeLogColumns.includes("created_at")
      ? "created_at AS actual_change_ts"
      : changeLogColumns.includes("created_on")
        ? "created_on AS actual_change_ts"
        : changeLogColumns.includes("change_date")
          ? "change_date AS actual_change_ts"
          : "NULL AS actual_change_ts";

    const orderByExpr = changeLogColumns.includes("created_at")
      ? "created_at DESC NULLS LAST, engineering_change_id DESC"
      : changeLogColumns.includes("created_on")
        ? "created_on DESC NULLS LAST, engineering_change_id DESC"
        : changeLogColumns.includes("change_date")
          ? "change_date DESC NULLS LAST, engineering_change_id DESC"
          : "engineering_change_id DESC";

    const routingIdSelectExpr = changeLogColumns.includes("routing_id")
      ? "routing_id"
      : "NULL AS routing_id";

    const itemDescriptionSelectExpr = changeLogColumns.includes("item_description")
      ? "item_description"
      : "NULL AS item_description";

    const itemReleaseFlagSelectExpr = changeLogColumns.includes("item_release_flag")
      ? "item_release_flag"
      : "NULL AS item_release_flag";

    const resourceRelevancySelectExpr = changeLogColumns.includes("resource_relevancy")
      ? "resource_relevancy"
      : "NULL AS resource_relevancy";

    const consumedItemSelectExpr = changeLogColumns.includes("consumed_item")
      ? "consumed_item"
      : "NULL AS consumed_item";

    const summaryQuery = `
      SELECT
        engineering_change_id,
        change_type,
        target_table,
        bom_id,
        produced_item,
        location,
        resource,
        ${routingIdSelectExpr},
        ${itemDescriptionSelectExpr},
        ${itemReleaseFlagSelectExpr},
        ${resourceRelevancySelectExpr},
        ${consumedItemSelectExpr},
        summarynotes,
        change_summary,
        user_name,
        ${dateSelectExpr}
      FROM ${pgRef(changeLogTable)}
      WHERE engineering_change_id = $1
        AND LOWER(change_type) LIKE 'add%'
      ORDER BY ${orderByExpr}
    `;

    const summaryResult = await pool.query(summaryQuery, [engineeringChangeId]);
    const summaryRows = summaryResult.rows || [];

    if (!summaryRows.length) {
      return res.status(404).json({
        error: "No matching add-change rows found in planning_bom_change_log_summary",
        details: { engineeringChangeId },
      });
    }

    const firstSummaryRow = summaryRows[0] || {};

    const safeText = (value) => String(value ?? "").trim();
    const upperText = (value) => safeText(value).toUpperCase();
    const sameText = (a, b) => upperText(a) === upperText(b);

    const splitCsv = (value) =>
      String(value || "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);

    const uniqueBy = (rows, keyFn) => {
      const map = new Map();

      for (const row of rows || []) {
        const key = keyFn(row);
        if (!key) continue;
        if (!map.has(key)) map.set(key, row);
      }

      return [...map.values()];
    };

    const normalizeSummaryText = (value) =>
      safeText(value)
        .toLowerCase()
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const isItemBomRoutingOnlyChange = summaryRows.some((row) => {
      const text = normalizeSummaryText(row.change_summary);
      return (
        /added\s+\d+\s+bom\s+id\s+in\s+item\s+bom\s+routing/.test(text) ||
        text.includes("item bom routing")
      );
    });

    const deriveLocationFromBomId = (bomId) => {
      const parts = safeText(bomId)
        .split("_")
        .map((p) => p.trim())
        .filter(Boolean);

      return parts.length >= 3 ? parts[2] : "";
    };

    const deriveProducedItemFromBomId = (bomId) => {
      const parts = safeText(bomId)
        .split("_")
        .map((p) => p.trim())
        .filter(Boolean);

      return parts.length >= 3 ? parts[1] : "";
    };

    const parseResourceFromRoutingId = (routingId) => {
      const value = safeText(routingId);
      if (!value) return "";

      const parts = value
        .split("_")
        .map((p) => p.trim())
        .filter(Boolean);

      // ROUTING_item_resource
      // Example: ROUTING_20044_S08_SMOKEHOUSE_8
      // Resource = S08_SMOKEHOUSE_8
      if (parts.length >= 3 && parts[0].toUpperCase() === "ROUTING") {
        return parts.slice(2).join("_");
      }

      return "";
    };

    const getCoProductAssociationFlag = (row) => {
      const rawValue =
        row?.erp_co_product_association ??
        row?.co_product_association ??
        "";

      const parsed = Number(rawValue);
      return Number.isFinite(parsed) ? parsed : 0;
    };

    const itemDescriptionSql = itemDetailsColumns.includes("item_description")
      ? `COALESCE(NULLIF(TRIM(CAST(item_description AS TEXT)), ''), '')`
      : itemDetailsColumns.includes("item_desc")
        ? `COALESCE(NULLIF(TRIM(CAST(item_desc AS TEXT)), ''), '')`
        : `''`;

    const fetchItemDescriptions = async (items) => {
      const upperItems = Array.from(
        new Set((items || []).map(upperText).filter(Boolean))
      );

      if (!upperItems.length) return new Map();

      const result = await pool.query(
        `
          SELECT
            TRIM(CAST(item AS TEXT)) AS item,
            ${itemDescriptionSql} AS item_description
          FROM ${pgRef(T.itemDetails)}
          WHERE UPPER(TRIM(CAST(item AS TEXT))) = ANY($1)
        `,
        [upperItems]
      );

      return new Map(
        (result.rows || []).map((row) => [
          upperText(row.item),
          safeText(row.item_description),
        ])
      );
    };

    /*
      IMPORTANT FIX:
      Do not pair bom_id/resource/routing_id only by index.
      If 2 BOMIDs and 2 resources are selected, every BOM should be able to
      display its matching routing/resource rows.
    */
    const summaryEntryMap = new Map();

    for (const row of summaryRows) {
      const bomIds = splitCsv(row.bom_id);
      const locations = splitCsv(row.location);
      const resources = splitCsv(row.resource);
      const producedItems = splitCsv(row.produced_item);
      const routingIds = splitCsv(row.routing_id);

      for (let bomIndex = 0; bomIndex < bomIds.length; bomIndex += 1) {
        const bomId = safeText(bomIds[bomIndex]);
        if (!bomId) continue;

        const location =
          safeText(locations[bomIndex]) ||
          safeText(locations[0]) ||
          deriveLocationFromBomId(bomId);

        const producedItemsForBom = producedItems.length
          ? producedItems
          : [deriveProducedItemFromBomId(bomId)].filter(Boolean);

        const entryKey = [
          upperText(bomId),
          upperText(location),
        ].join("__");

        const existing = summaryEntryMap.get(entryKey);

        if (!existing) {
          summaryEntryMap.set(entryKey, {
            summaryRow: row,
            bomId,
            location,
            resources: [...resources],
            routingIds: [...routingIds],
            producedItems: [...producedItemsForBom],
          });
        } else {
          existing.resources = uniqueBy(
            [...existing.resources, ...resources],
            upperText
          );

          existing.routingIds = uniqueBy(
            [...existing.routingIds, ...routingIds],
            upperText
          );

          existing.producedItems = uniqueBy(
            [...existing.producedItems, ...producedItemsForBom],
            upperText
          );

          summaryEntryMap.set(entryKey, existing);
        }
      }
    }

    const uniqueSummaryEntries = [...summaryEntryMap.values()];

    const createdRecords = [];

    for (const entry of uniqueSummaryEntries) {
      const summaryRow = entry.summaryRow || firstSummaryRow || {};
      const bomId = safeText(entry.bomId);
      const effectiveLocation = safeText(entry.location);

      const selectedResources = uniqueBy(
        entry.resources || [],
        upperText
      )
        .map(safeText)
        .filter(Boolean);

      const selectedRoutingIds = uniqueBy(
        entry.routingIds || [],
        upperText
      )
        .map(safeText)
        .filter(Boolean);

      const producedItems = uniqueBy(
        entry.producedItems || [],
        upperText
      )
        .map(safeText)
        .filter(Boolean);

      const producedItemsUpper = producedItems.map(upperText);
      const selectedResourcesUpper = selectedResources.map(upperText);
      const selectedRoutingIdsUpper = selectedRoutingIds.map(upperText);

      const producedQuery = `
        SELECT *
        FROM ${pgRef(T.bomProduced)}
        WHERE TRIM(CAST(bom_id AS TEXT)) = $1
          AND ($2 = '' OR TRIM(CAST(location AS TEXT)) = $2)
        ORDER BY load_datetime DESC NULLS LAST
      `;

      const consumedQuery = `
        SELECT *
        FROM ${pgRef(T.bomConsumed)}
        WHERE TRIM(CAST(bom_id AS TEXT)) = $1
          AND ($2 = '' OR TRIM(CAST(location AS TEXT)) = $2)
        ORDER BY load_datetime DESC NULLS LAST
      `;

      const routingQuery = `
        SELECT *
        FROM ${pgRef(T.itemBomRouting)}
        WHERE TRIM(CAST(bom_id AS TEXT)) = $1
        ORDER BY load_datetime DESC NULLS LAST, TRIM(CAST(routing_id AS TEXT))
      `;

      const parameterQuery = `
        SELECT *
        FROM ${pgRef(T.bomParameters)}
        WHERE TRIM(CAST(bom_id AS TEXT)) = $1
        ORDER BY load_datetime DESC NULLS LAST
      `;

      const [producedResult, consumedResult, routingResult, parameterResult] =
        await Promise.all([
          pool.query(producedQuery, [bomId, effectiveLocation]),
          pool.query(consumedQuery, [bomId, effectiveLocation]),
          pool.query(routingQuery, [bomId]),
          pool.query(parameterQuery, [bomId]),
        ]);

      const bomProducedRows = producedResult.rows || [];
      const bomConsumedRows = consumedResult.rows || [];
      const allRoutingRowsForBom = routingResult.rows || [];
      const bomParametersRows = parameterResult.rows || [];

      const itemBomRoutingRows = allRoutingRowsForBom.filter((row) => {
        const rowRoutingId = safeText(row.routing_id);
        const rowResource = parseResourceFromRoutingId(rowRoutingId);
        const rowItem = safeText(row.item);

        const matchesProducedItem =
          producedItemsUpper.length === 0 ||
          producedItemsUpper.includes(upperText(rowItem));

        const matchesRoutingId =
          selectedRoutingIdsUpper.length === 0 ||
          selectedRoutingIdsUpper.includes(upperText(rowRoutingId));

        const matchesResource =
          selectedResourcesUpper.length === 0 ||
          selectedResourcesUpper.includes(upperText(rowResource));

        return matchesProducedItem && matchesRoutingId && matchesResource;
      });

      const mainRoutingRows = uniqueBy(
        itemBomRoutingRows.filter((row) => getCoProductAssociationFlag(row) !== 1),
        (row) =>
          [
            upperText(row.item),
            upperText(row.routing_id),
            upperText(
              row.erp_item_bom_routing_priority ??
                row.item_bom_routing_priority ??
                ""
            ),
          ].join("__")
      );

      const coProductRoutingRows = uniqueBy(
        itemBomRoutingRows.filter((row) => getCoProductAssociationFlag(row) === 1),
        (row) => [upperText(row.item), upperText(row.routing_id)].join("__")
      );

      const mainProducedItem =
        safeText(mainRoutingRows[0]?.item) ||
        producedItems.find(
          (item) => !coProductRoutingRows.some((row) => sameText(row.item, item))
        ) ||
        deriveProducedItemFromBomId(bomId) ||
        "-";

      const mainRoutingId = safeText(mainRoutingRows[0]?.routing_id);
      const mainResource =
        parseResourceFromRoutingId(mainRoutingId) ||
        selectedResources[0] ||
        "";

      const bomProducedByItem = new Map();

      for (const row of bomProducedRows) {
        const itemKey = upperText(row.item);
        if (!itemKey) continue;
        if (!bomProducedByItem.has(itemKey)) {
          bomProducedByItem.set(itemKey, row);
        }
      }

      const coProductItems = uniqueBy(
        coProductRoutingRows.map((row) => safeText(row.item)).filter(Boolean),
        upperText
      );

      const componentItems = uniqueBy(
        bomConsumedRows.map((row) => safeText(row.item)).filter(Boolean),
        upperText
      );

      const itemDescriptionByItem = await fetchItemDescriptions([
        ...componentItems,
        ...coProductItems,
      ]);

      const finalCoProducts = coProductItems.map((coProductItem, coIndex) => {
        const matchedProducedRow =
          bomProducedByItem.get(upperText(coProductItem)) || {};

        const description =
          itemDescriptionByItem.get(upperText(coProductItem)) || "";

        return {
          key: `coproduct_${bomId}_${effectiveLocation}_${coIndex}`,
          coProductItem,
          item: coProductItem,
          description,
          itemDescription: description,
          qtyProduced:
            matchedProducedRow.erp_bom_qty_produced_per ??
            matchedProducedRow.bom_qty_produced_per ??
            matchedProducedRow.qty_produced_per ??
            "",
          qtyProducedPer:
            matchedProducedRow.erp_bom_qty_produced_per ??
            matchedProducedRow.bom_qty_produced_per ??
            matchedProducedRow.qty_produced_per ??
            "",
        };
      });

      /*
        User requirement:
        Resource/Routing table unique by RESOURCE only.
      */
      const routingDetails = uniqueBy(
        itemBomRoutingRows.map((row, routingIndex) => {
          const routingId = safeText(row.routing_id);
          const resource = parseResourceFromRoutingId(routingId);

          return {
            key: `routing_${bomId}_${effectiveLocation}_${routingIndex}`,
            resource,
            routingId,
            itemBomRoutingPriority:
              row.erp_item_bom_routing_priority ??
              row.item_bom_routing_priority ??
              "",
            item_bom_routing_priority:
              row.erp_item_bom_routing_priority ??
              row.item_bom_routing_priority ??
              "",
            priority:
              row.erp_item_bom_routing_priority ??
              row.item_bom_routing_priority ??
              "",
            coProductAssociation:
              row.erp_co_product_association ??
              row.co_product_association ??
              "",
          };
        }),
        (row) => upperText(row.resource)
      );

      const firstRoutingRow = routingDetails[0] || {};

      createdRecords.push({
        key: `bom_detail_${bomId}_${effectiveLocation}_${mainProducedItem}`,
        bomId,
        location: effectiveLocation,
        item: mainProducedItem,
        itemDescription: safeText(summaryRow.item_description),
        itemReleaseFlag: safeText(summaryRow.item_release_flag),

        resource: firstRoutingRow.resource || mainResource,
        resourceRelevancy: safeText(summaryRow.resource_relevancy),
        routingId: firstRoutingRow.routingId || mainRoutingId,

        itemBomRoutingPriority: firstRoutingRow.itemBomRoutingPriority ?? "",
        item_bom_routing_priority: firstRoutingRow.item_bom_routing_priority ?? "",
        priority: firstRoutingRow.priority ?? "",
        coProductAssociation: firstRoutingRow.coProductAssociation ?? "",

        routingDetails,

        bomStartDate:
          bomParametersRows[0]?.erp_bom_start_date ||
          bomParametersRows[0]?.bom_start_date ||
          "",
        bomEndDate:
          bomParametersRows[0]?.erp_bom_end_date ||
          bomParametersRows[0]?.bom_end_date ||
          "",

        components: isItemBomRoutingOnlyChange
          ? []
          : bomConsumedRows.map((row, componentIndex) => {
              const componentItem = safeText(row.item);
              const description =
                itemDescriptionByItem.get(upperText(componentItem)) || "";

              return {
                key: `component_${bomId}_${effectiveLocation}_${componentIndex}`,
                componentItem,
                item: componentItem,
                description,
                itemDescription: description,
                standardUsage:
                  row.erp_bom_quantity_consumed_per ??
                  row.bom_quantity_consumed_per ??
                  "",
                startDate:
                  row.erp_bom_component_start_date ??
                  row.bom_component_start_date ??
                  "",
                endDate:
                  row.erp_bom_component_end_date ??
                  row.bom_component_end_date ??
                  "",
              };
            }),

        coProducts: finalCoProducts,
        hideComponentTable: isItemBomRoutingOnlyChange,
      });
    }

    /*
      Same BOMID should display in same card.
      Routing/resource uniqueness remains RESOURCE only.
    */
    const groupedCreatedRecords = uniqueBy(
      createdRecords,
      (row) => upperText(row.bomId)
    ).map((baseRow) => {
      const sameBomRows = createdRecords.filter((row) =>
        sameText(row.bomId, baseRow.bomId)
      );

      const mergedItems = uniqueBy(
        sameBomRows.map((row) => safeText(row.item)).filter(Boolean),
        upperText
      );

      const mergedRoutingDetails = uniqueBy(
        sameBomRows.flatMap((row) => row.routingDetails || []),
        (row) => upperText(row.resource)
      );

      const mergedComponents = uniqueBy(
        sameBomRows.flatMap((row) => row.components || []),
        (row) =>
          [
            upperText(row.componentItem || row.item),
            upperText(row.standardUsage),
          ].join("__")
      );

      const mergedCoProducts = uniqueBy(
        sameBomRows.flatMap((row) => row.coProducts || []),
        (row) =>
          [
            upperText(row.coProductItem || row.item),
            upperText(row.qtyProduced || row.qtyProducedPer),
          ].join("__")
      );

      return {
        ...baseRow,
        key: `bom_detail_${baseRow.bomId}_${baseRow.location}`,
        item: mergedItems.join(", ") || baseRow.item,

        routingDetails: mergedRoutingDetails,
        resource: mergedRoutingDetails[0]?.resource || baseRow.resource || "",
        routingId: mergedRoutingDetails[0]?.routingId || baseRow.routingId || "",

        itemBomRoutingPriority:
          mergedRoutingDetails[0]?.itemBomRoutingPriority ||
          baseRow.itemBomRoutingPriority ||
          "",
        item_bom_routing_priority:
          mergedRoutingDetails[0]?.item_bom_routing_priority ||
          baseRow.item_bom_routing_priority ||
          "",
        priority:
          mergedRoutingDetails[0]?.priority ||
          baseRow.priority ||
          "",
        coProductAssociation:
          mergedRoutingDetails[0]?.coProductAssociation ||
          baseRow.coProductAssociation ||
          "",

        components: mergedComponents,
        coProducts: mergedCoProducts,
      };
    });

    return res.json({
      engineeringChangeId,
      changeDate: firstSummaryRow.actual_change_ts || "",
      user: firstSummaryRow.user_name || "",
      changeType: "Added",
      summaryNotes: firstSummaryRow.summarynotes || "",
      changeSummary: firstSummaryRow.change_summary || "",
      hideComponentTable: isItemBomRoutingOnlyChange,
      createdRecords: groupedCreatedRecords,
      summaryLogRows: summaryRows,
    });
  } catch (error) {
    console.error("DB Error (engineering-changes-detail-add):", error);
    return res.status(500).json({
      error: "Failed to fetch engineering add detail",
      details: error.message,
    });
  }
});



router.get("/engineering-changes-detail-delete-bom", async (req, res) => {
  try {
    const engineeringChangeId = String(
      req.query.changeID || req.query.engineeringChangeId || ""
    ).trim();

    if (!engineeringChangeId) {
      return res.status(400).json({
        error: "engineeringChangeId/changeID is required",
      });
    }

    const safeText = (value) => String(value ?? "").trim();
    const normalizeKey = (value) => safeText(value).toUpperCase();

    const splitCsv = (value) =>
      String(value || "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);

    const uniqueBy = (rows, keyFn) => {
      const map = new Map();

      for (const row of rows || []) {
        const key = keyFn(row);
        if (!map.has(key)) {
          map.set(key, row);
        }
      }

      return [...map.values()];
    };

    const deriveLocationFromBomId = (value) => {
      const parts = safeText(value)
        .split("_")
        .map((p) => p.trim())
        .filter(Boolean);

      return parts.length >= 3 ? parts[2] : "";
    };

    const buildRoutingId = (item, resource) => {
      const cleanItem = safeText(item);
      const cleanResource = safeText(resource);

      if (!cleanItem || !cleanResource) return "";

      return `ROUTING_${cleanItem}_${cleanResource}`;
    };

    const getCoProductAssociationFlag = (row) => {
      const rawValue =
        row?.erp_co_product_association ??
        row?.co_product_association ??
        row?.co_prod_association ??
        row?.coProductAssociation ??
        "";

      const parsed = Number(rawValue);
      return Number.isFinite(parsed) ? parsed : 0;
    };

    const changeLogTable = T.changeLog;
    const changeLogColumns = await getExistingColumns(pool, changeLogTable);

    const dateSelectExpr = changeLogColumns.includes("created_at")
      ? "created_at AS actual_change_ts"
      : changeLogColumns.includes("created_on")
        ? "created_on AS actual_change_ts"
        : changeLogColumns.includes("change_date")
          ? "change_date AS actual_change_ts"
          : "NULL AS actual_change_ts";

    const changeLogOrderBy = changeLogColumns.includes("created_at")
      ? "created_at DESC NULLS LAST, rec_id DESC NULLS LAST"
      : changeLogColumns.includes("created_on")
        ? "created_on DESC NULLS LAST, rec_id DESC NULLS LAST"
        : changeLogColumns.includes("change_date")
          ? "change_date DESC NULLS LAST, rec_id DESC NULLS LAST"
          : changeLogColumns.includes("rec_id")
            ? "rec_id DESC NULLS LAST"
            : "1";

    const summaryQuery = `
      SELECT
        engineering_change_id,
        change_type,
        target_table,
        bom_id,
        produced_item,
        consumed_item,
        location,
        resource,
        summarynotes,
        change_summary,
        user_name,
        postgresql_rec_id,
        rec_id,
        ${dateSelectExpr}
      FROM ${pgRef(changeLogTable)}
      WHERE TRIM(CAST(engineering_change_id AS TEXT)) = $1
        AND LOWER(TRIM(CAST(change_type AS TEXT))) LIKE 'deleted%'
      ORDER BY ${changeLogOrderBy}
    `;

    const summaryResult = await pool.query(summaryQuery, [engineeringChangeId]);
    const summaryRows = summaryResult.rows || [];

    if (!summaryRows.length) {
      return res.status(404).json({
        error: "No matching deleted rows found in planning_bom_change_log_summary",
        details: { engineeringChangeId },
      });
    }

    const firstRow = summaryRows[0] || {};

    /*
      Source of truth:
      - BOMID, location, resource come from planning_bom_change_log_summary.
      - Deleted produced/co-product items come from bom_produced_og.
      - Deleted component items come from bom_consumed_og.
      - Co-product classification comes from item_bom_routing_og.erp_co_product_association = 1.
      - Routing ID format is ROUTING_item_resource.
    */
    const summaryCombos = [];
    const seenCombo = new Set();

    for (const row of summaryRows) {
      const bomIds = splitCsv(row.bom_id);
      const locations = splitCsv(row.location);
      const resources = splitCsv(row.resource);

      const maxLen = Math.max(bomIds.length, locations.length, resources.length, 1);

      for (let index = 0; index < maxLen; index += 1) {
        const bomId = bomIds[index] || bomIds[0] || "";
        if (!bomId) continue;

        const location =
          locations[index] ||
          locations[0] ||
          deriveLocationFromBomId(bomId);

        const resource =
          resources[index] ||
          resources[0] ||
          "";

        const comboKey = [
          normalizeKey(bomId),
          normalizeKey(location),
          normalizeKey(resource),
        ].join("__");

        if (seenCombo.has(comboKey)) continue;
        seenCombo.add(comboKey);

        summaryCombos.push({
          bomId,
          location,
          resource,
          summaryNotes: safeText(row.summarynotes),
          changeSummary: safeText(row.change_summary),
          postgresqlRecId: row.postgresql_rec_id || "",
          recId: row.rec_id || "",
        });
      }
    }

    const summaryBomIds = Array.from(
      new Set(summaryCombos.map((combo) => combo.bomId).filter(Boolean))
    );

    if (!summaryBomIds.length) {
      return res.status(200).json({
        success: true,
        data: {
          engineeringChangeId,
          changeDate: firstRow.actual_change_ts || "",
          user: firstRow.user_name || "SYSTEM_USER",
          changeType: "Deleted",
          item: firstRow.produced_item || "",
          itemDescription: "",
          location: firstRow.location || "",
          bomId: "",
          resource: firstRow.resource || "",
          routingId: "",
          summaryNotes: firstRow.summarynotes || "",
          notes: firstRow.summarynotes || "",
          changeSummary: firstRow.change_summary || "",
          showRoutingInDeletedTable: true,
          showConnectedRoutingTable: false,
          deletedBomRecords: [],
          connectedRoutingRecords: [],
          summaryRows,
        },
      });
    }

    const [
      producedOgColumns,
      consumedOgColumns,
      routingOgColumns,
      itemDetailsColumns,
    ] = await Promise.all([
      getExistingColumns(pool, T.bomProducedOg),
      getExistingColumns(pool, T.bomConsumedOg),
      getExistingColumns(pool, T.itemBomRoutingOg),
      getExistingColumns(pool, T.itemDetails),
    ]);

    const producedOgOrderBy = [
      producedOgColumns.includes("load_datetime")
        ? "load_datetime DESC NULLS LAST"
        : "",
      producedOgColumns.includes("postgresql_rec_id")
        ? "postgresql_rec_id DESC NULLS LAST"
        : "",
      producedOgColumns.includes("rec_id")
        ? "rec_id DESC NULLS LAST"
        : "",
    ]
      .filter(Boolean)
      .join(", ") || "1";

    const consumedOgOrderBy = [
      consumedOgColumns.includes("load_datetime")
        ? "load_datetime DESC NULLS LAST"
        : "",
      consumedOgColumns.includes("postgresql_rec_id")
        ? "postgresql_rec_id DESC NULLS LAST"
        : "",
      consumedOgColumns.includes("rec_id")
        ? "rec_id DESC NULLS LAST"
        : "",
    ]
      .filter(Boolean)
      .join(", ") || "1";

    const routingOgOrderBy = [
      routingOgColumns.includes("load_datetime")
        ? "load_datetime DESC NULLS LAST"
        : "",
      routingOgColumns.includes("postgresql_rec_id")
        ? "postgresql_rec_id DESC NULLS LAST"
        : "",
      routingOgColumns.includes("rec_id")
        ? "rec_id DESC NULLS LAST"
        : "",
    ]
      .filter(Boolean)
      .join(", ") || "1";

    const [
      producedOgResult,
      consumedOgResult,
      routingOgResult,
    ] = await Promise.all([
      pool.query(
        `
          SELECT *
          FROM ${pgRef(T.bomProducedOg)}
          WHERE TRIM(CAST(bom_id AS TEXT)) = ANY($1::text[])
          ORDER BY ${producedOgOrderBy}
        `,
        [summaryBomIds]
      ),
      pool.query(
        `
          SELECT *
          FROM ${pgRef(T.bomConsumedOg)}
          WHERE TRIM(CAST(bom_id AS TEXT)) = ANY($1::text[])
          ORDER BY ${consumedOgOrderBy}
        `,
        [summaryBomIds]
      ),
      pool.query(
        `
          SELECT *
          FROM ${pgRef(T.itemBomRoutingOg)}
          WHERE TRIM(CAST(bom_id AS TEXT)) = ANY($1::text[])
          ORDER BY ${routingOgOrderBy}
        `,
        [summaryBomIds]
      ),
    ]);

    const producedOgRows = producedOgResult.rows || [];
    const consumedOgRows = consumedOgResult.rows || [];
    const routingOgRows = routingOgResult.rows || [];

    /*
      Build routing map by BOM + item + routing_id.
      Routing ID is deterministic:
        ROUTING_item_resource
    */
    const routingByBomItemRouting = new Map();

    for (const row of routingOgRows) {
      const item = safeText(row.item);
      const bomId = safeText(row.bom_id);
      const routingId = safeText(row.routing_id);

      if (!bomId || !item || !routingId) continue;

      routingByBomItemRouting.set(
        [
          normalizeKey(bomId),
          normalizeKey(item),
          normalizeKey(routingId),
        ].join("__"),
        row
      );
    }

    const allItems = Array.from(
      new Set(
        [
          ...producedOgRows.map((row) => safeText(row.item)),
          ...consumedOgRows.map((row) => safeText(row.item)),
          ...routingOgRows.map((row) => safeText(row.item)),
        ].filter(Boolean)
      )
    );

    const itemDescriptionMap = new Map();

    if (itemDetailsColumns.includes("item") && allItems.length) {
      let descriptionSql = "'' AS item_description";

      if (itemDetailsColumns.includes("item_description")) {
        descriptionSql = "item_description";
      } else if (itemDetailsColumns.includes("item_desc")) {
        descriptionSql = "item_desc AS item_description";
      }

      const itemDetailsQuery = `
        SELECT
          TRIM(CAST(item AS TEXT)) AS item,
          ${descriptionSql}
        FROM ${pgRef(T.itemDetails)}
        WHERE UPPER(TRIM(CAST(item AS TEXT))) = ANY($1::text[])
      `;

      const itemDetailsResult = await pool.query(
        itemDetailsQuery,
        [allItems.map(normalizeKey)]
      );

      for (const row of itemDetailsResult.rows || []) {
        itemDescriptionMap.set(
          normalizeKey(row.item),
          safeText(row.item_description)
        );
      }
    }

    const deletedBomRecords = [];
    const seenOutputRows = new Set();

    for (const combo of summaryCombos) {
      const comboBomKey = normalizeKey(combo.bomId);
      const comboLocationKey = normalizeKey(combo.location);

      /*
        1. Produced rows from bom_produced_og:
           includes main item and co-products.
           Co-product flag is checked from item_bom_routing_og.
      */
      const producedRowsForCombo = producedOgRows.filter((row) => {
        const rowBomId = safeText(row.bom_id);
        const rowLocation = safeText(row.location);

        return (
          normalizeKey(rowBomId) === comboBomKey &&
          (!combo.location || normalizeKey(rowLocation) === comboLocationKey)
        );
      });

      for (const row of producedRowsForCombo) {
        const item = safeText(row.item);
        if (!item) continue;

        const routingId = buildRoutingId(item, combo.resource);
        const routingKey = [
          comboBomKey,
          normalizeKey(item),
          normalizeKey(routingId),
        ].join("__");

        const routingRow = routingByBomItemRouting.get(routingKey) || null;
        const coProductAssociation = routingRow
          ? getCoProductAssociationFlag(routingRow)
          : 0;

        const outputKey = [
          "PRODUCED",
          comboBomKey,
          comboLocationKey,
          normalizeKey(item),
          normalizeKey(routingId),
        ].join("__");

        if (seenOutputRows.has(outputKey)) continue;
        seenOutputRows.add(outputKey);

        deletedBomRecords.push({
          recordType: coProductAssociation === 1 ? "Co-Product" : "Produced",
          producedItem: item,
          item,
          itemDescription: itemDescriptionMap.get(normalizeKey(item)) || "",
          location: combo.location || safeText(row.location),
          bomId: combo.bomId,
          resource: combo.resource,
          routingId,
          itemBomRoutingPriority:
            routingRow?.erp_item_bom_routing_priority ??
            routingRow?.item_bom_routing_priority ??
            "",
          coProductAssociation,
          erpCoProductAssociation: coProductAssociation,
          erp_co_product_association: coProductAssociation,
          isCoProduct: coProductAssociation === 1,
          summaryNotes: combo.summaryNotes || safeText(firstRow.summarynotes),
          changeSummary: combo.changeSummary || safeText(firstRow.change_summary),
          targetTable: "bom_produced_og",
          postgresqlRecId:
            row.postgresql_rec_id ||
            routingRow?.postgresql_rec_id ||
            combo.postgresqlRecId ||
            "",
          recId:
            row.rec_id ||
            routingRow?.rec_id ||
            combo.recId ||
            "",
        });
      }

      /*
        2. Component rows from bom_consumed_og:
           component does not need routing row. Routing ID can still be built
           as ROUTING_component_resource only for display consistency.
      */
      const consumedRowsForCombo = consumedOgRows.filter((row) => {
        const rowBomId = safeText(row.bom_id);
        const rowLocation = safeText(row.location);

        return (
          normalizeKey(rowBomId) === comboBomKey &&
          (!combo.location || normalizeKey(rowLocation) === comboLocationKey)
        );
      });

      for (const row of consumedRowsForCombo) {
        const item = safeText(row.item);
        if (!item) continue;

        const routingId = buildRoutingId(item, combo.resource);

        const outputKey = [
          "CONSUMED",
          comboBomKey,
          comboLocationKey,
          normalizeKey(item),
        ].join("__");

        if (seenOutputRows.has(outputKey)) continue;
        seenOutputRows.add(outputKey);

        deletedBomRecords.push({
          recordType: "Component",
          producedItem: item,
          item,
          itemDescription: itemDescriptionMap.get(normalizeKey(item)) || "",
          location: combo.location || safeText(row.location),
          bomId: combo.bomId,
          resource: combo.resource,
          routingId,
          itemBomRoutingPriority: "",
          coProductAssociation: 0,
          erpCoProductAssociation: 0,
          erp_co_product_association: 0,
          isCoProduct: false,
          summaryNotes: combo.summaryNotes || safeText(firstRow.summarynotes),
          changeSummary: combo.changeSummary || safeText(firstRow.change_summary),
          targetTable: "bom_consumed_og",
          postgresqlRecId: row.postgresql_rec_id || combo.postgresqlRecId || "",
          recId: row.rec_id || combo.recId || "",
        });
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        engineeringChangeId: firstRow.engineering_change_id || engineeringChangeId,
        changeDate: firstRow.actual_change_ts || "",
        user: firstRow.user_name || "SYSTEM_USER",
        changeType: "Deleted",
        item: firstRow.produced_item || "",
        itemDescription: "",
        location: firstRow.location || "",
        bomId: summaryBomIds.join(", "),
        resource: firstRow.resource || "",
        routingId: "",
        summaryNotes: firstRow.summarynotes || "",
        notes: firstRow.summarynotes || "",
        changeSummary: firstRow.change_summary || "",

        showRoutingInDeletedTable: true,
        showConnectedRoutingTable: false,

        deletedBomRecords,
        connectedRoutingRecords: [],
        summaryRows,
      },
    });
  } catch (error) {
    console.error("DB Error (engineering-changes-detail-delete-bom):", error);

    return res.status(500).json({
      error: "Failed to fetch engineering delete BOM detail",
      details: error.message,
    });
  }
});

router.get("/engineering-changes-detail-modify", async (req, res) => {
  const client = await pool.connect();

  try {
    const engineeringChangeId = String(req.query.engineeringChangeId || "").trim();
    const requestBomId = String(req.query.bomId || "").trim();
    const requestLocation = String(req.query.location || "").trim();
    const requestResource = String(req.query.resource || "").trim();
    const requestProducedItem = String(
      req.query.producedItem || req.query.item || ""
    ).trim();

    if (!engineeringChangeId) {
      return res.status(400).json({
        success: false,
        message: "engineeringChangeId is required",
      });
    }

    const safeText = (value) => {
      if (value === null || value === undefined) return "";
      return String(value).trim();
    };

    const upperText = (value) => safeText(value).toUpperCase();
    const sameText = (a, b) => upperText(a) === upperText(b);
    const isSame = (a, b) => safeText(a) === safeText(b);

    const splitCsv = (value) =>
      String(value || "")
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);

    const uniqueValues = (values) =>
      Array.from(new Set((values || []).map(safeText).filter(Boolean)));

    const buildDetailRow = (field, value) => ({
      field,
      value: value ?? "",
    });

    const buildChangeRow = (field, originalValue, updatedValue, description = "") => ({
      field,
      originalValue: originalValue ?? "",
      updatedValue: updatedValue ?? "",
      description: description ?? "",
      changed: !isSame(originalValue, updatedValue),
    });

    /* Correct format: ROUTING_Item_resource */
    const parseRoutingId = (routingId) => {
      const value = safeText(routingId);
      if (!value) return { item: "", resource: "" };

      const parts = value
        .replace(/^ROUTING_/i, "")
        .split("_")
        .map((p) => p.trim())
        .filter(Boolean);

      if (parts.length >= 2) {
        return {
          item: parts[0] || "",
          resource: parts.slice(1).join("_"),
        };
      }

      return { item: parts[0] || "", resource: "" };
    };

    const buildRoutingId = (item, resource) => {
      const cleanItem = safeText(item);
      const cleanResource = safeText(resource);
      if (!cleanItem || !cleanResource) return "";
      return `ROUTING_${cleanItem}_${cleanResource}`;
    };

    const fetchRows = async ({ tableName, whereClause, values, orderBy = "" }) => {
      const query = `
        SELECT *
        FROM ${pgRef(tableName)}
        WHERE ${whereClause}
        ${orderBy ? `ORDER BY ${orderBy}` : ""}
      `;
      const result = await client.query(query, values);
      return result.rows || [];
    };

    const getQtyProducedPer = (row) => {
      if (!row) return "";
      return (
        row.erp_bom_qty_produced_per ??
        row.bom_qty_produced_per ??
        row.qty_produced_per ??
        ""
      );
    };

    const getConsumedPer = (row) => {
      if (!row) return "";
      return (
        row.erp_bom_quantity_consumed_per ??
        row.bom_quantity_consumed_per ??
        ""
      );
    };

    const getRoutingPriority = (row) => {
      if (!row) return "";
      return (
        row.erp_item_bom_routing_priority ??
        row.item_bom_routing_priority ??
        ""
      );
    };

    const getCoProductAssociationFlag = (row) => {
      const parsed = Number(
        row?.erp_co_product_association ??
        row?.co_product_association ??
        row?.co_prod_association ??
        0
      );
      return Number.isFinite(parsed) ? parsed : 0;
    };

    const buildItemKey = (row) => upperText(row?.item);

    const descriptionColumnSql = async () => {
      const itemDetailsColumns = await getExistingColumns(client, T.itemDetails);
      if (itemDetailsColumns.includes("item_description")) {
        return "item_description";
      }
      if (itemDetailsColumns.includes("item_desc")) {
        return "item_desc AS item_description";
      }
      return "'' AS item_description";
    };

    const fetchItemDescriptionMap = async (items) => {
      const itemList = uniqueValues(items).map(upperText);
      const descriptionMap = new Map();
      if (!itemList.length) return descriptionMap;

      const descriptionSelect = await descriptionColumnSql();
      const itemDetailsResult = await client.query(
        `
          SELECT
            TRIM(CAST(item AS TEXT)) AS item,
            ${descriptionSelect}
          FROM ${pgRef(T.itemDetails)}
          WHERE UPPER(TRIM(CAST(item AS TEXT))) = ANY($1::text[])
        `,
        [itemList]
      );

      for (const row of itemDetailsResult.rows || []) {
        descriptionMap.set(upperText(row.item), safeText(row.item_description));
      }

      return descriptionMap;
    };

    /*
      Fetch the exact planning_bom_change_log_summary row for this engineering change.
      This is the source for BOMID, location, resource and produced_item.
    */
    const headerQuery = `
      SELECT *
      FROM ${pgRef(T.changeLog)}
      WHERE TRIM(CAST(engineering_change_id AS TEXT)) = $1
        AND LOWER(TRIM(CAST(change_type AS TEXT))) LIKE 'modif%'
      ORDER BY change_date DESC NULLS LAST, rec_id DESC NULLS LAST
      LIMIT 1
    `;

    const headerResult = await client.query(headerQuery, [engineeringChangeId]);
    const headerRow = headerResult.rows[0] || null;

    if (!headerRow) {
      return res.status(404).json({
        success: false,
        message: `No modify change log row found for engineeringChangeId=${engineeringChangeId}`,
      });
    }

    const resolvedBomId =
      splitCsv(headerRow.bom_id)[0] ||
      splitCsv(headerRow.bom_ids)[0] ||
      requestBomId;

    const resolvedLocation =
      splitCsv(headerRow.location)[0] ||
      splitCsv(headerRow.locations)[0] ||
      requestLocation;

    const resolvedResource =
      splitCsv(headerRow.resource)[0] ||
      splitCsv(headerRow.resources)[0] ||
      requestResource;

    const producedItemsFromLog = uniqueValues([
      ...splitCsv(headerRow.produced_item),
      safeText(headerRow.item),
      requestProducedItem,
    ]);

    if (!resolvedBomId) {
      return res.status(400).json({
        success: false,
        message: "bomId could not be resolved from change log",
      });
    }

    if (!resolvedLocation) {
      return res.status(400).json({
        success: false,
        message: "location could not be resolved from change log",
      });
    }

    const producedItemsUpper = producedItemsFromLog.map(upperText);

    const [
      updatedRoutingRowsForItems,
      originalRoutingRowsForItems,
      updatedProducedRowsAll,
      originalProducedRowsAll,
      updatedConsumedRows,
      originalConsumedRows,
    ] = await Promise.all([
      fetchRows({
        tableName: T.itemBomRouting,
        whereClause: `
          TRIM(CAST(bom_id AS TEXT)) = $1
          AND (
            CARDINALITY($2::text[]) = 0
            OR UPPER(TRIM(CAST(item AS TEXT))) = ANY($2::text[])
          )
        `,
        values: [resolvedBomId, producedItemsUpper],
        orderBy: "load_datetime DESC NULLS LAST, rec_id DESC NULLS LAST",
      }),
      fetchRows({
        tableName: T.itemBomRoutingOg,
        whereClause: `
          TRIM(CAST(bom_id AS TEXT)) = $1
          AND (
            CARDINALITY($2::text[]) = 0
            OR UPPER(TRIM(CAST(item AS TEXT))) = ANY($2::text[])
          )
        `,
        values: [resolvedBomId, producedItemsUpper],
        orderBy: "load_datetime DESC NULLS LAST, postgresql_rec_id DESC NULLS LAST, rec_id DESC NULLS LAST",
      }),
      fetchRows({
        tableName: T.bomProduced,
        whereClause: `TRIM(CAST(bom_id AS TEXT)) = $1 AND TRIM(CAST(location AS TEXT)) = $2`,
        values: [resolvedBomId, resolvedLocation],
        orderBy: "load_datetime DESC NULLS LAST, rec_id DESC NULLS LAST",
      }),
      fetchRows({
        tableName: T.bomProducedOg,
        whereClause: `TRIM(CAST(bom_id AS TEXT)) = $1 AND TRIM(CAST(location AS TEXT)) = $2`,
        values: [resolvedBomId, resolvedLocation],
        orderBy: "load_datetime DESC NULLS LAST, postgresql_rec_id DESC NULLS LAST, rec_id DESC NULLS LAST",
      }),
      fetchRows({
        tableName: T.bomConsumed,
        whereClause: `TRIM(CAST(bom_id AS TEXT)) = $1 AND TRIM(CAST(location AS TEXT)) = $2`,
        values: [resolvedBomId, resolvedLocation],
        orderBy: "load_datetime DESC NULLS LAST, rec_id DESC NULLS LAST",
      }),
      fetchRows({
        tableName: T.bomConsumedOg,
        whereClause: `TRIM(CAST(bom_id AS TEXT)) = $1 AND TRIM(CAST(location AS TEXT)) = $2`,
        values: [resolvedBomId, resolvedLocation],
        orderBy: "load_datetime DESC NULLS LAST, postgresql_rec_id DESC NULLS LAST, rec_id DESC NULLS LAST",
      }),
    ]);

    /*
      Routing does not have location. Match it using BOMID + produced item.
      If resource exists in the change log, narrow using resource parsed from ROUTING_Item_resource.
    */
    const filterRoutingRowsForResource = (rows) => {
      return (rows || []).filter((row) => {
        const parsed = parseRoutingId(row.routing_id);
        const rowResource = parsed.resource;
        const resourceMatches = !resolvedResource || sameText(rowResource, resolvedResource);
        return resourceMatches;
      });
    };

    const updatedRoutingRows = filterRoutingRowsForResource(updatedRoutingRowsForItems);
    const originalRoutingRows = filterRoutingRowsForResource(originalRoutingRowsForItems);

    const updatedMainRoutingRow =
      updatedRoutingRows.find((row) => getCoProductAssociationFlag(row) !== 1) || null;

    const originalMainRoutingRow =
      originalRoutingRows.find((row) => getCoProductAssociationFlag(row) !== 1) || null;

    const displayProducedItem =
      safeText(updatedMainRoutingRow?.item) ||
      producedItemsFromLog.find(Boolean) ||
      safeText(updatedProducedRowsAll.find((row) => Number(getQtyProducedPer(row) || 0) === 1)?.item) ||
      safeText(updatedProducedRowsAll[0]?.item) ||
      "";

    const displayRoutingId =
      safeText(updatedMainRoutingRow?.routing_id) ||
      safeText(originalMainRoutingRow?.routing_id) ||
      buildRoutingId(displayProducedItem, resolvedResource);

    const displayRoutingPriority =
      getRoutingPriority(updatedMainRoutingRow) || getRoutingPriority(originalMainRoutingRow);

    const bomRecordDetails = [
      buildDetailRow("Location", resolvedLocation),
      buildDetailRow("BOM ID", resolvedBomId),
      buildDetailRow("Produced Item", displayProducedItem),
      buildDetailRow("Routing ID", displayRoutingId),
      buildDetailRow("Item BOM Routing Priority", displayRoutingPriority),
    ].filter((row) => safeText(row.value) !== "");

    const allItemsForDescription = Array.from(
      new Set([
        ...updatedConsumedRows.map((row) => safeText(row.item)),
        ...originalConsumedRows.map((row) => safeText(row.item)),
        ...updatedProducedRowsAll.map((row) => safeText(row.item)),
        ...originalProducedRowsAll.map((row) => safeText(row.item)),
      ].filter(Boolean))
    );

    const itemDescriptionMap = await fetchItemDescriptionMap(allItemsForDescription);

    /* ------------------------------------------------------------------
       Component comparison:
       - OG only   => Existing component table, updated value = Item removed
       - Main only => Added component table, value = standard usage from main
       - Both      => Existing component table, original=OG and updated=Main
    ------------------------------------------------------------------ */
    const updatedConsumedMap = new Map();
    for (const row of updatedConsumedRows) {
      const key = buildItemKey(row);
      if (key && !updatedConsumedMap.has(key)) updatedConsumedMap.set(key, row);
    }

    const originalConsumedMap = new Map();
    for (const row of originalConsumedRows) {
      const key = buildItemKey(row);
      if (key && !originalConsumedMap.has(key)) originalConsumedMap.set(key, row);
    }

    const componentKeys = Array.from(
      new Set([...originalConsumedMap.keys(), ...updatedConsumedMap.keys()])
    );

    const componentItemChanges = [];
    for (const key of componentKeys) {
      const originalRow = originalConsumedMap.get(key) || null;
      const updatedRow = updatedConsumedMap.get(key) || null;
      const item = safeText(originalRow?.item || updatedRow?.item);
      const itemDescription = itemDescriptionMap.get(upperText(item)) || "";
      const originalUsage = getConsumedPer(originalRow);
      const updatedUsage = getConsumedPer(updatedRow);

      if (originalRow && updatedRow) {
        componentItemChanges.push(
          buildChangeRow("Component Item", item, item, itemDescription),
          buildChangeRow("Standard Usage", originalUsage, updatedUsage, itemDescription)
        );
      } else if (originalRow && !updatedRow) {
        componentItemChanges.push(
          buildChangeRow("Component Item", item, "", itemDescription),
          buildChangeRow("Standard Usage", originalUsage, "", itemDescription)
        );
      } else if (!originalRow && updatedRow) {
        componentItemChanges.push(
          buildChangeRow("Component Item", "", item, itemDescription),
          buildChangeRow("Standard Usage", "", updatedUsage, itemDescription)
        );
      }
    }

    /* ------------------------------------------------------------------
       Co-product comparison:
       Co-products are identified from item_bom_routing/_og where
       erp_co_product_association = 1. Then quantities come from
       bom_produced/_og.
    ------------------------------------------------------------------ */
    const updatedCoProductItems = new Set(
      updatedRoutingRows
        .filter((row) => getCoProductAssociationFlag(row) === 1)
        .map((row) => upperText(row.item))
        .filter(Boolean)
    );

    const originalCoProductItems = new Set(
      originalRoutingRows
        .filter((row) => getCoProductAssociationFlag(row) === 1)
        .map((row) => upperText(row.item))
        .filter(Boolean)
    );

    const updatedCoProductMap = new Map();
    for (const row of updatedProducedRowsAll) {
      const key = buildItemKey(row);
      if (!key || !updatedCoProductItems.has(key)) continue;
      if (!updatedCoProductMap.has(key)) updatedCoProductMap.set(key, row);
    }

    const originalCoProductMap = new Map();
    for (const row of originalProducedRowsAll) {
      const key = buildItemKey(row);
      if (!key || !originalCoProductItems.has(key)) continue;
      if (!originalCoProductMap.has(key)) originalCoProductMap.set(key, row);
    }

    const coProductKeys = Array.from(
      new Set([...originalCoProductMap.keys(), ...updatedCoProductMap.keys()])
    );

    const coProductChanges = [];
    for (const key of coProductKeys) {
      const originalRow = originalCoProductMap.get(key) || null;
      const updatedRow = updatedCoProductMap.get(key) || null;
      const item = safeText(originalRow?.item || updatedRow?.item);
      const itemDescription = itemDescriptionMap.get(upperText(item)) || "";
      const originalQty = getQtyProducedPer(originalRow);
      const updatedQty = getQtyProducedPer(updatedRow);

      if (originalRow && updatedRow) {
        coProductChanges.push(
          buildChangeRow("Co-Product Item", item, item, itemDescription),
          buildChangeRow("Qty Produced", originalQty, updatedQty, itemDescription)
        );
      } else if (originalRow && !updatedRow) {
        coProductChanges.push(
          buildChangeRow("Co-Product Item", item, "", itemDescription),
          buildChangeRow("Qty Produced", originalQty, "", itemDescription)
        );
      } else if (!originalRow && updatedRow) {
        coProductChanges.push(
          buildChangeRow("Co-Product Item", "", item, itemDescription),
          buildChangeRow("Qty Produced", "", updatedQty, itemDescription)
        );
      }
    }

    return res.status(200).json({
      success: true,
      data: {
        header: {
          engineeringChangeId,
          changeDate: headerRow?.change_date || "",
          userName: headerRow?.user_name || "",
          changeType: headerRow?.change_type || "Modified",
          bomId: resolvedBomId,
          location: resolvedLocation,
          resource: resolvedResource,
          producedItem: displayProducedItem,
          routingId: displayRoutingId,
          itemBomRoutingPriority: displayRoutingPriority,
          summaryNotes: headerRow?.summarynotes || "",
        },
        bomRecordDetails,
        componentItemChanges,
        coProductChanges,
      },
    });
  } catch (error) {
    console.error("DB Error (engineering-changes-detail-modify):", error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch engineering modify detail",
      details: error.message,
    });
  } finally {
    client.release();
  }
});



/* =========================================================
   ViEW BOM from main tables in postgresql
========================================================= */
router.post("/view-bom-data/search", async (req, res) => {
  try {
    const safeText = (value) => String(value ?? "").trim();
    const upperText = (value) => safeText(value).toUpperCase();

    const criterion1 = {
      field: safeText(req.body?.criterion1?.field),
      value: safeText(req.body?.criterion1?.value),
    };

    const criterion2 = {
      field: safeText(req.body?.criterion2?.field),
      value: safeText(req.body?.criterion2?.value),
    };

    const criteria = [criterion1, criterion2].filter((criterion) => criterion.field);
    const selectedFields = criteria.map((criterion) => criterion.field);

    const emptyData = {
      bomParameters: [],
      bomProduced: [],
      bomConsumed: [],
      itemBomRouting: [],
    };

    if (!criteria.length) {
      return res.status(200).json({
        success: true,
        enabledTables: [],
        data: emptyData,
      });
    }

    if (
      selectedFields.includes("resource") &&
      selectedFields.includes("componentItem")
    ) {
      return res.status(400).json({
        success: false,
        error: "Users cannot select Resource and Component Item at the same time.",
      });
    }

    if (
      selectedFields.includes("componentItem") &&
      selectedFields.includes("coProductItem")
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Users cannot select Component Item and Co-Product Item at the same time.",
      });
    }

    const TABLE_KEYS = {
      bomParameters: "bomParameters",
      bomProduced: "bomProduced",
      bomConsumed: "bomConsumed",
      itemBomRouting: "itemBomRouting",
    };

    const ALL_TABLE_KEYS = [
      TABLE_KEYS.bomParameters,
      TABLE_KEYS.bomProduced,
      TABLE_KEYS.bomConsumed,
      TABLE_KEYS.itemBomRouting,
    ];

    /*
      Main table rules only:

      Location:
        available from bom_produced / bom_consumed.

      BOMID:
        available from all four main tables.

      Resource:
        available from item_bom_routing only.
        Resource is derived from routing_id if resource column is unavailable.

      Produced Item:
        available from bom_produced / item_bom_routing.

      Component Item:
        available from bom_consumed only.

      Co-Product Item:
        available from bom_produced / item_bom_routing.
        Co-product is identified from item_bom_routing.erp_co_product_association = 1.
    */
    const fieldTableMap = {
      location: [TABLE_KEYS.bomProduced, TABLE_KEYS.bomConsumed],
      bomId: ALL_TABLE_KEYS,
      producedItem: [TABLE_KEYS.bomProduced, TABLE_KEYS.itemBomRouting],
      resource: [TABLE_KEYS.itemBomRouting],
      componentItem: [TABLE_KEYS.bomConsumed],
      coProductItem: [TABLE_KEYS.bomProduced, TABLE_KEYS.itemBomRouting],
    };

    let enabledTables = ALL_TABLE_KEYS;

    for (const field of selectedFields) {
      const supportedTables = fieldTableMap[field] || [];
      enabledTables = enabledTables.filter((tableKey) =>
        supportedTables.includes(tableKey)
      );
    }

    const tableNameByKey = {
      bomParameters: T.bomParameters,
      bomProduced: T.bomProduced,
      bomConsumed: T.bomConsumed,
      itemBomRouting: T.itemBomRouting,
    };

    const deriveResourceFromRoutingId = (routingId) => {
      const value = safeText(routingId);
      if (!value) return "";

      const parts = value
        .split("_")
        .map((part) => part.trim())
        .filter(Boolean);

      /*
        Correct current format:
        ROUTING_item_resource

        Example:
        ROUTING_HRL01639_RESOURCE123

        Resource starts after ROUTING + item.
      */
      if (parts.length >= 3 && parts[0].toUpperCase() === "ROUTING") {
        return parts.slice(2).join("_");
      }

      return "";
    };

    const getCoProductAssociationFlag = (row) => {
      const parsed = Number(
        row?.erp_co_product_association ??
          row?.co_product_association ??
          row?.co_prod_association ??
          0
      );

      return Number.isFinite(parsed) ? parsed : 0;
    };

    const contains = (cellValue, searchValue) =>
      upperText(cellValue).includes(upperText(searchValue));

    const normalizeItemKey = (bomId, item) =>
      `${upperText(bomId)}__${upperText(item)}`;

    /*
      Fetch from PostgreSQL MAIN tables only.
      SELECT * is intentional because View BOM must show all columns.
    */
    const [
      bomParametersResult,
      bomProducedResult,
      bomConsumedResult,
      itemBomRoutingResult,
    ] = await Promise.all([
      enabledTables.includes(TABLE_KEYS.bomParameters)
        ? pool.query(`SELECT * FROM ${pgRef(T.bomParameters)}`)
        : Promise.resolve({ rows: [] }),

      enabledTables.includes(TABLE_KEYS.bomProduced)
        ? pool.query(`SELECT * FROM ${pgRef(T.bomProduced)}`)
        : Promise.resolve({ rows: [] }),

      enabledTables.includes(TABLE_KEYS.bomConsumed)
        ? pool.query(`SELECT * FROM ${pgRef(T.bomConsumed)}`)
        : Promise.resolve({ rows: [] }),

      enabledTables.includes(TABLE_KEYS.itemBomRouting) ||
      selectedFields.includes("coProductItem")
        ? pool.query(`SELECT * FROM ${pgRef(T.itemBomRouting)}`)
        : Promise.resolve({ rows: [] }),
    ]);

    const rawBomParameters = bomParametersResult.rows || [];
    const rawBomProduced = bomProducedResult.rows || [];
    const rawBomConsumed = bomConsumedResult.rows || [];
    const rawItemBomRouting = (itemBomRoutingResult.rows || []).map((row) => ({
      ...row,
      resource:
        safeText(row.resource) || deriveResourceFromRoutingId(row.routing_id),
    }));

    /*
      Co-product item set from item_bom_routing main table only.
      This is required to filter bom_produced when Co-Product Item criterion is selected.
    */
    const coProductProducedItemKeys = new Set(
      rawItemBomRouting
        .filter((row) => getCoProductAssociationFlag(row) === 1)
        .map((row) => normalizeItemKey(row.bom_id, row.item))
        .filter(Boolean)
    );

    const rowMatchesCriterion = (row, tableKey, criterion) => {
      const field = criterion.field;
      const value = safeText(criterion.value);

      if (!field || !value) return true;

      switch (field) {
        case "location":
          return contains(row.location, value);

        case "bomId":
          return contains(row.bom_id, value);

        case "producedItem":
          return contains(row.item, value);

        case "resource":
          return (
            tableKey === TABLE_KEYS.itemBomRouting &&
            contains(row.resource || deriveResourceFromRoutingId(row.routing_id), value)
          );

        case "componentItem":
          return tableKey === TABLE_KEYS.bomConsumed && contains(row.item, value);

        case "coProductItem":
          if (!contains(row.item, value)) return false;

          if (tableKey === TABLE_KEYS.itemBomRouting) {
            return getCoProductAssociationFlag(row) === 1;
          }

          if (tableKey === TABLE_KEYS.bomProduced) {
            return coProductProducedItemKeys.has(
              normalizeItemKey(row.bom_id, row.item)
            );
          }

          return false;

        default:
          return true;
      }
    };

    const filterRowsForTable = (rows, tableKey) => {
      if (!enabledTables.includes(tableKey)) return [];

      let outputRows = rows || [];

      /*
        If Co-Product Item is selected:
        - item_bom_routing must only show association = 1.
        - bom_produced must only show items that are co-products based on item_bom_routing.
      */
      if (selectedFields.includes("coProductItem")) {
        if (tableKey === TABLE_KEYS.itemBomRouting) {
          outputRows = outputRows.filter(
            (row) => getCoProductAssociationFlag(row) === 1
          );
        }

        if (tableKey === TABLE_KEYS.bomProduced) {
          outputRows = outputRows.filter((row) =>
            coProductProducedItemKeys.has(normalizeItemKey(row.bom_id, row.item))
          );
        }
      }

      return outputRows.filter((row) =>
        criteria.every((criterion) =>
          rowMatchesCriterion(row, tableKey, criterion)
        )
      );
    };

    const bomParameters = filterRowsForTable(
      rawBomParameters,
      TABLE_KEYS.bomParameters
    );

    const bomProduced = filterRowsForTable(
      rawBomProduced,
      TABLE_KEYS.bomProduced
    );

    const bomConsumed = filterRowsForTable(
      rawBomConsumed,
      TABLE_KEYS.bomConsumed
    );

    const itemBomRouting = filterRowsForTable(
      rawItemBomRouting,
      TABLE_KEYS.itemBomRouting
    );

    return res.status(200).json({
      success: true,
      enabledTables,
      data: {
        bomParameters,
        bomProduced,
        bomConsumed,
        itemBomRouting,
      },
    });
  } catch (error) {
    console.error("DB Error (view-bom-data/search):", error);

    return res.status(500).json({
      success: false,
      error: "Failed to fetch BOM data",
      details: error.message,
    });
  }
});


router.post("/download-bom-excel", async (req, res) => {
  try {
    const tables = Array.isArray(req.body?.tables) ? req.body.tables : [];

    if (!tables.length) {
      return res.status(400).json({
        message: "At least one table must be selected",
      });
    }

    /*
      IMPORTANT:
      Table names are read from appConfig.js through T.
      Frontend sends stable keys: bom_parameters, bom_produced, bom_consumed, item_bom_routing.
      Do not hardcode physical PostgreSQL table names here.
    */
    const allowedTables = {
      bom_parameters: {
        label: "BOM Parameters",
        tableName: T.bomParameters,
      },
      bom_produced: {
        label: "BOM Produced",
        tableName: T.bomProduced,
      },
      bom_consumed: {
        label: "BOM Consumed",
        tableName: T.bomConsumed,
      },
      item_bom_routing: {
        label: "Item BOM Routing",
        tableName: T.itemBomRouting,
      },
    };

    const invalidTables = tables.filter((table) => !allowedTables[table]);
    if (invalidTables.length) {
      return res.status(400).json({
        message: `Invalid table(s): ${invalidTables.join(", ")}`,
      });
    }

    const workbook = XLSX.utils.book_new();

    for (const tableKey of tables) {
      const tableMeta = allowedTables[tableKey];

      if (!tableMeta?.tableName) {
        return res.status(500).json({
          message: `Table mapping missing in appConfig for ${tableKey}`,
        });
      }

      const result = await pool.query(`SELECT * FROM ${pgRef(tableMeta.tableName)}`);
      const rows = result.rows || [];

      const sheetData =
        rows.length > 0
          ? rows
          : [{ Message: "No data available in this table" }];

      const worksheet = XLSX.utils.json_to_sheet(sheetData);

      const keys = Object.keys(sheetData[0] || {});
      worksheet["!cols"] = keys.map((key) => {
        const maxLength = Math.max(
          key.length,
          ...sheetData.map((row) => String(row[key] ?? "").length)
        );
        return { wch: Math.min(Math.max(maxLength + 2, 14), 40) };
      });

      XLSX.utils.book_append_sheet(
        workbook,
        worksheet,
        tableMeta.label.slice(0, 31)
      );
    }

    const buffer = XLSX.write(workbook, {
      type: "buffer",
      bookType: "xlsx",
    });

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="bom_tables.xlsx"'
    );

    return res.send(buffer);
  } catch (error) {
    console.error("DB Error (download-bom-excel):", error);
    return res.status(500).json({
      message: "Failed to generate Excel download",
      error: error.message,
    });
  }
});
router.post("/item-details/by-items", async (req, res) => {
  try {
    const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];

    const items = Array.from(
      new Set(rawItems.map((x) => String(x || "").trim()).filter(Boolean))
    );

    if (!items.length) {
      return res.status(200).json({
        success: true,
        data: [],
      });
    }

    const upperItems = items.map((x) => x.toUpperCase());

    const PG_SCHEMA = S;

    const columnResult = await pool.query(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name = $2
      `,
      [PG_SCHEMA, T.itemDetails]
    );

    const existingColumns = new Set(
      (columnResult.rows || []).map((row) =>
        String(row.column_name || "").trim().toLowerCase()
      )
    );

    if (!existingColumns.has("item")) {
      return res.status(500).json({
        success: false,
        error: `${T.itemDetails}.item column does not exist`,
      });
    }

    const hasItemDesc = existingColumns.has("item_desc");
    const hasItemDescription = existingColumns.has("item_description");

    let itemDescSql = "''";
    let itemDescriptionSql = "''";

    if (hasItemDescription && hasItemDesc) {
      itemDescSql = `
        COALESCE(
          NULLIF(TRIM(CAST(item_desc AS TEXT)), ''),
          NULLIF(TRIM(CAST(item_description AS TEXT)), ''),
          ''
        )
      `;

      itemDescriptionSql = `
        COALESCE(
          NULLIF(TRIM(CAST(item_description AS TEXT)), ''),
          NULLIF(TRIM(CAST(item_desc AS TEXT)), ''),
          ''
        )
      `;
    } else if (hasItemDescription) {
      itemDescSql = `
        COALESCE(
          NULLIF(TRIM(CAST(item_description AS TEXT)), ''),
          ''
        )
      `;

      itemDescriptionSql = `
        COALESCE(
          NULLIF(TRIM(CAST(item_description AS TEXT)), ''),
          ''
        )
      `;
    } else if (hasItemDesc) {
      itemDescSql = `
        COALESCE(
          NULLIF(TRIM(CAST(item_desc AS TEXT)), ''),
          ''
        )
      `;

      itemDescriptionSql = `
        COALESCE(
          NULLIF(TRIM(CAST(item_desc AS TEXT)), ''),
          ''
        )
      `;
    }

    const result = await pool.query(
      `
        SELECT
          TRIM(CAST(item AS TEXT)) AS item,
          ${itemDescSql} AS item_desc,
          ${itemDescriptionSql} AS item_description
        FROM ${pgRef(T.itemDetails)}
        WHERE UPPER(TRIM(CAST(item AS TEXT))) = ANY($1)
      `,
      [upperItems]
    );

    return res.status(200).json({
      success: true,
      data: result.rows || [],
    });
  } catch (error) {
    console.error("DB Error (item-details/by-items):", error);

    return res.status(500).json({
      success: false,
      error: "Failed to fetch item details",
      details: error.message,
    });
  }
});



/* =========================================================
   5) Generic GET ALL RECORDS FROM TABLE
========================================================= */
router.get("/:tableName", async (req, res) => {
  const { tableName } = req.params;
  try {
    const pgAllowedTables = [
      T.bomParameters,
      T.bomProduced,
      T.bomConsumed,
      T.itemBomRouting,
      // OG tables
      T.bomParametersOg,
      T.bomProducedOg,
      T.bomConsumedOg,
      T.itemBomRoutingOg,
    ];

    const bqTableKey = getBQTableKeyByTableName(tableName);

    // BigQuery source split:
    // item_mrp_rls_flg => DEV; item_master/location_master/routing_rescons/resource_master => PRD.
    if (bqTableKey && !["bomParameters", "bomProduced", "bomConsumed", "itemBomRouting"].includes(bqTableKey)) {
      const rows = await fetchBQRowsForRoute(bqTableKey, { limit: req.query?.limit || 100 });
      return res.json(rows || []);
    }

    // Primary BOM tables are fetched from PostgreSQL.
    if (!pgAllowedTables.includes(tableName)) {
      return res.status(400).json({ message: "Invalid table name" });
    }

    const result = await pool.query(`SELECT * FROM ${pgRef(tableName)} LIMIT 100`);
    return res.json(result.rows);
  } catch (error) {
    console.error("DB Error:", error);
    return res.status(500).json({
      message: "Failed to fetch data",
      error: error.message,
    });
  }
});
/* =========================================================
   6) Generic GET SINGLE RECORD BY ID
========================================================= */
const allowedTables = [
  T.bomParameters,
  T.itemBomRouting,
  T.bomProduced,
  T.bomConsumed,
  // OG tables
  T.bomParametersOg,
  T.bomProducedOg,
  T.bomConsumedOg,
  T.itemBomRoutingOg,
];
router.get("/:tableName/:id", async (req, res) => {
  const { tableName, id } = req.params;
  try {
    const bqTableKey = getBQTableKeyByTableName(tableName);

    // BigQuery source split:
    // item_mrp_rls_flg => DEV; item_master/location_master/routing_rescons/resource_master => PRD.
    if (bqTableKey && !["bomParameters", "bomProduced", "bomConsumed", "itemBomRouting"].includes(bqTableKey)) {
      const rows = await fetchBQRowsForRoute(bqTableKey, { id, limit: 100 });
      if (!rows.length) {
        return res.status(404).json({ message: "Record not found" });
      }
      return res.json(rows);
    }

    // Primary BOM tables are fetched from PostgreSQL.
    if (!allowedTables.includes(tableName)) {
      return res.status(400).json({ message: "Invalid table name" });
    }

    const result = await pool.query(
      `SELECT * FROM ${pgRef(tableName)} WHERE bom_id = $1`,
      [id]
    );
    if (!result.rows.length) {
      return res.status(404).json({ message: "Record not found" });
    }
    return res.json(result.rows);
  } catch (err) {
    console.error("ERROR:", err);
    return res.status(500).json({
      message: "Failed to fetch record",
      error: err.message,
    });
  }
});
export default router;