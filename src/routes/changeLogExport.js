import express from "express";
import ExcelJS from "exceljs";
import pool from "../db/postgresClient.js";
import appConfig from "../config/appConfig.js";

const router = express.Router();

/* =========================================================
   Change-log export source rules
   - Engineering change log is fetched only from PostgreSQL.
   - Table/schema/column names are resolved through appConfig.
========================================================= */
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

const quoteIdent = (value) => `"${String(value).replace(/"/g, '""')}"`;
const PG_SCHEMA = assertSafeIdentifier(appConfig.postgres.schema || "planning_bom", "postgres.schema");
const CHANGE_LOG_TABLE = assertSafeIdentifier(appConfig.postgres.tables.changeLog, "postgres.tables.changeLog");
const pgTableRef = (tableName) => `${quoteIdent(PG_SCHEMA)}.${quoteIdent(assertSafeIdentifier(tableName, "postgres.table"))}`;

const normalizeText = (value) => String(value ?? "").trim();

const getExistingColumns = async (tableName) => {
  const result = await pool.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = $2
      ORDER BY ordinal_position
    `,
    [PG_SCHEMA, tableName]
  );
  return result.rows.map((row) => String(row.column_name || "").trim().toLowerCase());
};

const firstExistingColumn = (columns, candidates = []) => {
  const set = new Set(columns.map((column) => String(column).toLowerCase()));
  return candidates.find((candidate) => set.has(String(candidate).toLowerCase())) || "";
};

const addExactFilter = ({ where, values, columns, candidates, value }) => {
  const column = firstExistingColumn(columns, candidates);
  const text = normalizeText(value);
  if (!column || !text) return;
  values.push(text);
  where.push(`TRIM(CAST(${quoteIdent(column)} AS TEXT)) = $${values.length}`);
};

function buildWhereClause(q, values, columns) {
  const where = [];

  const dateColumn = firstExistingColumn(columns, [
    appConfig.postgres.columns.changeDate,
    appConfig.postgres.columns.createdAt,
    appConfig.postgres.columns.createdOn,
    "change_time",
    "created_date",
  ]);

  if (dateColumn && q.fromDate) {
    values.push(q.fromDate);
    where.push(`${quoteIdent(dateColumn)} >= $${values.length}`);
  }

  if (dateColumn && q.toDate) {
    values.push(q.toDate);
    where.push(`${quoteIdent(dateColumn)} <= $${values.length}`);
  }

  const userColumn = firstExistingColumn(columns, [
    appConfig.postgres.columns.userName,
    "changed_by",
    "created_by",
    "updated_by",
    "user_id",
  ]);

  if (userColumn && q.user) {
    values.push(q.user);
    where.push(`TRIM(CAST(${quoteIdent(userColumn)} AS TEXT)) = $${values.length}`);
  }

  if (q.myChangesOnly === "true" && !q.user) {
    where.push("1=0");
  }

  const criteriaToColumns = {
    Location: ["location", "locations"],
    "BOM ID": ["bom_id", "bom_ids"],
    Resource: ["resource", "resources"],
    "Produced Item": ["produced_item", "item"],
    "Component Item": ["component_item", "consumed_item"],
    "Co-Product Item": ["co_product_item", "item"],
  };

  if (q.criteria1 && q.value1 && criteriaToColumns[q.criteria1]) {
    addExactFilter({
      where,
      values,
      columns,
      candidates: criteriaToColumns[q.criteria1],
      value: q.value1,
    });
  }

  if (q.criteria2 && q.value2 && criteriaToColumns[q.criteria2]) {
    addExactFilter({
      where,
      values,
      columns,
      candidates: criteriaToColumns[q.criteria2],
      value: q.value2,
    });
  }

  return where.length ? `WHERE ${where.join(" AND ")}` : "";
}

const getRowValue = (row, keys = []) => {
  for (const key of keys) {
    const value = row?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }
  return "";
};

const normalizeExportRows = (rows = []) =>
  rows.map((row) => ({
    ...row,
    change_time: getRowValue(row, ["change_date", "created_at", "created_on", "change_time"]),
    changed_by: getRowValue(row, ["user_name", "changed_by", "created_by", "updated_by", "user_id"]),
    entity_type: getRowValue(row, ["target_table", "source_table", "entity_type"]),
    field_name: getRowValue(row, ["field_name", "field", "change_summary"]),
    old_value: getRowValue(row, ["old_value", "original_value"]),
    new_value: getRowValue(row, ["new_value", "updated_value"]),
    component_item: getRowValue(row, ["component_item", "consumed_item"]),
    co_product_item: getRowValue(row, ["co_product_item"]),
  }));

const autoFitColumns = (worksheet) => {
  worksheet.columns.forEach((column) => {
    let maxLength = String(column.header || "").length;
    column.eachCell?.({ includeEmpty: true }, (cell) => {
      maxLength = Math.max(maxLength, String(cell.value ?? "").length);
    });
    column.width = Math.min(Math.max(maxLength + 2, 14), 45);
  });
};

router.get("/change-log/export", async (req, res) => {
  try {
    const existingColumns = await getExistingColumns(CHANGE_LOG_TABLE);
    const values = [];
    const whereSql = buildWhereClause(req.query, values, existingColumns);

    const orderColumn = firstExistingColumn(existingColumns, [
      appConfig.postgres.columns.changeDate,
      appConfig.postgres.columns.createdAt,
      appConfig.postgres.columns.createdOn,
      "change_time",
    ]);

    const baseSql = `
      SELECT *
      FROM ${pgTableRef(CHANGE_LOG_TABLE)}
      ${whereSql}
      ORDER BY ${orderColumn ? `${quoteIdent(orderColumn)} DESC NULLS LAST` : "1"}
      LIMIT 50000
    `;

    const { rows: dbRows } = await pool.query(baseSql, values);
    const rows = normalizeExportRows(dbRows || []);

    const wb = new ExcelJS.Workbook();
    wb.creator = "BOM App";
    wb.created = new Date();

    const wsSummary = wb.addWorksheet("High-Level Summary");
    wsSummary.addRow(["Metric", "Value"]);
    wsSummary.addRow(["Total Changes", rows.length]);

    const byType = rows.reduce((acc, row) => {
      const key = row.change_type || row.entity_type || "Unknown";
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    Object.entries(byType).forEach(([key, value]) => {
      wsSummary.addRow([`Changes - ${key}`, value]);
    });
    wsSummary.columns = [{ width: 35 }, { width: 20 }];

    const commonColumns = [
      { header: "Change Time", key: "change_time", width: 22 },
      { header: "Changed By", key: "changed_by", width: 20 },
      { header: "Change Type", key: "change_type", width: 16 },
      { header: "BOM ID", key: "bom_id", width: 24 },
      { header: "Location", key: "location", width: 18 },
      { header: "Resource", key: "resource", width: 22 },
      { header: "Produced Item", key: "produced_item", width: 20 },
      { header: "Component Item", key: "component_item", width: 20 },
      { header: "Co-Product Item", key: "co_product_item", width: 20 },
      { header: "Target Table", key: "target_table", width: 24 },
      { header: "Change Summary", key: "change_summary", width: 35 },
      { header: "Notes", key: "summarynotes", width: 35 },
    ];

    const wsMain = wb.addWorksheet("Main BOM Details");
    wsMain.columns = commonColumns;
    rows.forEach((row) => wsMain.addRow(row));
    autoFitColumns(wsMain);

    const wsComp = wb.addWorksheet("Component Details");
    wsComp.columns = commonColumns;
    rows
      .filter((row) => normalizeText(row.component_item) || normalizeText(row.consumed_item))
      .forEach((row) => wsComp.addRow(row));
    autoFitColumns(wsComp);

    const wsCoProd = wb.addWorksheet("Co-Product Details");
    wsCoProd.columns = commonColumns;
    rows
      .filter((row) => normalizeText(row.co_product_item) || /co-product/i.test(normalizeText(row.change_summary)))
      .forEach((row) => wsCoProd.addRow(row));
    autoFitColumns(wsCoProd);

    const wsCompare = wb.addWorksheet("Modified Field Comparison");
    wsCompare.columns = [
      { header: "BOM ID", key: "bom_id", width: 24 },
      { header: "Entity Type", key: "entity_type", width: 24 },
      { header: "Field Name", key: "field_name", width: 28 },
      { header: "Old Value", key: "old_value", width: 25 },
      { header: "New Value", key: "new_value", width: 25 },
      { header: "Change Time", key: "change_time", width: 22 },
      { header: "Changed By", key: "changed_by", width: 20 },
    ];
    rows.forEach((row) => wsCompare.addRow(row));
    autoFitColumns(wsCompare);

    const filename = `Filtered_Change_Log_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    await wb.xlsx.write(res);
    return res.end();
  } catch (error) {
    console.error("DB Error (change-log/export):", error);
    return res.status(500).json({
      message: error.message || "Failed to export change log",
    });
  }
});

export default router;
