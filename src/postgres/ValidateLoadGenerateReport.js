import fs from "fs";
import path from "path";
import csv from "csv-parser";

import { generateSuccessReport } from "../reportGenerator/successReportGenerator.js";
import { generateFailureReport } from "../reportGenerator/failureReportGenerator.js";

/* ✅ NORMALIZE CSV HEADERS */
function normalizeRow(row) {
  const newRow = {};
  Object.keys(row).forEach((key) => {
    const cleanKey = key.replace(/\s+/g, "").toUpperCase();
    newRow[cleanKey] = row[key];
  });
  return newRow;
}

const isBlank = (v) => v == null || String(v).trim() === "";

/* ✅ CSV READER */
const readCsv = (UPLOAD_DIR, file) => {
  return new Promise((resolve, reject) => {
    const rows = [];
    const fullPath = path.join(UPLOAD_DIR, file);

    fs.createReadStream(fullPath)
      .pipe(csv())
      .on("data", (row) => rows.push(normalizeRow(row)))
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
};

/* ✅ ERROR GROUPING */
function addError(errorMap, table, recordId, fieldName) {
  const recId = recordId || "NULL";
  const key = `${table}_${recId}`;

  if (!errorMap[key]) {
    errorMap[key] = { table, recordId: recId, missing: [] };
  }

  // store only field name; generator converts it to the screenshot-style line
  if (!errorMap[key].missing.includes(fieldName)) {
    errorMap[key].missing.push(fieldName);
  }
}

/* ✅ MAIN FUNCTION (ONE-TIME LOAD ONLY) */
export const validateGenerateReportAndLoad = async ({
  UPLOAD_DIR,
  REPORT_DIR,
  pool,
  getChicagoTime,
}) => {
  const routingFile = fs.existsSync(path.join(UPLOAD_DIR, "In_itemBOMRouting.csv"))
    ? "In_itemBOMRouting.csv"
    : "In_ItemBOMRouting.csv";

  const [paramRows, prodRows, consRows, routRows] = await Promise.all([
    readCsv(UPLOAD_DIR, "In_BOMParameters.csv"),
    readCsv(UPLOAD_DIR, "In_BOMProduced.csv"),
    readCsv(UPLOAD_DIR, "In_BOMConsumed.csv"),
    readCsv(UPLOAD_DIR, routingFile),
  ]);

  const errorMap = {};

  /* ✅ LEGACY VALIDATIONS (ONE-TIME LOAD) */
  paramRows.forEach((r) => {
    if (isBlank(r.BOMID)) addError(errorMap, "BOM_PARAMETERS", r.RECORDID, "BOMID");
  });

  prodRows.forEach((r) => {
    if (isBlank(r.BOMID)) addError(errorMap, "BOM_PRODUCED", r.RECORDID, "BOMID");
    if (isBlank(r.ITEM)) addError(errorMap, "BOM_PRODUCED", r.RECORDID, "ITEM");
    if (isBlank(r.RECORDID)) addError(errorMap, "BOM_PRODUCED", "NULL", "RECORDID");
  });

  consRows.forEach((r) => {
    if (isBlank(r.ERPBOMQUANTITYCONSUMEDPER))
      addError(errorMap, "BOM_CONSUMED", r.RECORDID, "ERPBOMQUANTITYCONSUMEDPER");
    if (isBlank(r.RECORDID)) addError(errorMap, "BOM_CONSUMED", "NULL", "RECORDID");
  });

  routRows.forEach((r) => {
    if (isBlank(r.ROUTINGID)) addError(errorMap, "ITEM_BOM_ROUTING", r.RECORDID, "ROUTINGID");
    if (isBlank(r.BOMID)) addError(errorMap, "ITEM_BOM_ROUTING", r.RECORDID, "BOMID");
    if (isBlank(r.RECORDID)) addError(errorMap, "ITEM_BOM_ROUTING", "NULL", "RECORDID");
  });

  /* ✅ COUNTS */
  const validatedCounts = {
    BOM_PARAMETERS: paramRows.length,
    BOM_PRODUCED: prodRows.length,
    BOM_CONSUMED: consRows.length,
    ITEM_BOM_ROUTING: routRows.length,
  };

  const errorCounts = {
    BOM_PARAMETERS: 0,
    BOM_PRODUCED: 0,
    BOM_CONSUMED: 0,
    ITEM_BOM_ROUTING: 0,
  };

  Object.values(errorMap).forEach((e) => {
    if (errorCounts[e.table] !== undefined) errorCounts[e.table]++;
  });

  const totalErrors = Object.values(errorCounts).reduce((a, b) => a + b, 0);

  // ✅ Failure -> report + stop
  if (totalErrors > 0) {
    const reportFile = generateFailureReport({
      REPORT_DIR,
      validatedCounts,
      errorCounts,
      getChicagoTime,
      validationType: "ONETIME",
      errorMap,
    });

    return { status: "FAILED", report: reportFile, errorCount: totalErrors };
  }

  // ✅ Success report
  const reportFile = generateSuccessReport({
    REPORT_DIR,
    validatedCounts,
    getChicagoTime,
    validationType: "ONETIME",
  });

  /* ✅ INSERT INTO DB */
  try {
    await pool.query("BEGIN");

    for (const r of paramRows) {
      await pool.query(`INSERT INTO bom_parameters VALUES ($1,$2,$3,$4,$5,$6)`, [
        r.POSTGRESQL_RECID || r.RECORDID,
        r.BOMID,
        r.ERPBOMSTARTDATE,
        r.ERPBOMENDDATE,
        getChicagoTime(),
        r.RECORDID,
      ]);
    }

    for (const r of prodRows) {
      await pool.query(`INSERT INTO bom_produced VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
        r.POSTGRESQL_RECID || r.RECORDID,
        r.BOMID,
        r.ITEM,
        r.LOCATION,
        r.BOMSTATUS,
        r.BOMVERSION,
        r.PREFIX,
        r.BOMPLANTYPE,
        r.ERPBOMQTYPRODUCEDPER,
        getChicagoTime(),
      ]);
    }

    for (const r of consRows) {
      await pool.query(`INSERT INTO bom_consumed VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
        r.POSTGRESQL_RECID || r.RECORDID,
        r.BOMID,
        r.ITEM,
        r.LOCATION,
        r.ERPBOMQUANTITYCONSUMEDPER,
        r.BOMCOMPONENTSTARTDATE,
        r.BOMCOMPONENTENDDATE,
        getChicagoTime(),
      ]);
    }

    for (const r of routRows) {
      await pool.query(
        `INSERT INTO item_bom_routing VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          r.POSTGRESQL_RECID || r.RECORDID,
          r.BOMID,
          r.ITEM,
          r.ROUTINGID,
          r.ITEMBOMROUTINGPRIORITY,
          r.ITEMBOMROUTINGMINLOTSIZE,
          r.ITEMBOMROUTINGLOTSIZEINCREMENT,
          r.ITEMBOMROUTINGWIPSWEEPPRIORITY,
          r.COPRODUCTASSOCIATION,
          r.ITEMBOMROUTINGMAXLOTSIZE,
          getChicagoTime(),
          r.RECORDID,
        ]
      );
    }

    await pool.query("COMMIT");

    return {
      status: "SUCCESS",
      report: reportFile,
      message: "✅ One time load completed successfully",
    };
  } catch (err) {
    await pool.query("ROLLBACK");

    // DB failure should still produce a failure report
    const dbErrorMap = {
      DB_ERROR: {
        table: "BOM_PRODUCED",
        recordId: "NULL",
        missing: [`DB Insert Failed: ${err.message}`],
      },
    };

    const dbReport = generateFailureReport({
      REPORT_DIR,
      validatedCounts,
      errorCounts: {
        ...errorCounts,
        BOM_PRODUCED: Math.max(errorCounts.BOM_PRODUCED, 1),
      },
      getChicagoTime,
      validationType: "ONETIME",
      errorMap: dbErrorMap,
    });

    return { status: "FAILED", report: dbReport, errorCount: 1 };
  }
};