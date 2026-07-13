import path from "path";
import fs from "fs";
import pool from "../db/postgresClient.js";
import { validateWithGCP } from "../bigquery/GCPvalidation.js";
import { generateFailureReport } from "../reportGenerator/failureReportGenerator.js";
import { generateSuccessReport } from "../reportGenerator/successReportGenerator.js";

/* =========================================================
   Helpers
========================================================= */
const ROOT = process.cwd();
const REPORT_DIR = path.join(ROOT, "reports");
const HARD_CODED_START_DATE = "2019-01-01";
const HARD_CODED_END_DATE = "2099-01-25";
const HARD_CODED_BOM_STATUS = "ACTIVE";
const HARD_CODED_PREFIX = "BOM";
const HARD_CODED_BOM_PLAN_TYPE = "MP and OP";
const HARD_CODED_LOAD_DATETIME = null;
const norm = (v) => (v == null ? "" : String(v).trim());

const toNum = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const toBool = (v) => {
  if (v === true) return true;
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "y";
};

const canonKey = (s) =>
  String(s ?? "")
    .normalize("NFKC")
    .replace(/[\uFEFF\u200B\u00A0]/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const pick = (obj, keys) => {
  if (!obj || typeof obj !== "object") return "";
  const map = {};
  for (const k of Object.keys(obj)) {
    map[canonKey(k)] = obj[k];
  }
  for (const key of keys) {
    const v = map[canonKey(key)];
    if (v != null && String(v).trim() !== "") return v;
  }
  return "";
};

function deriveBomItem(bomId) {
  const id = norm(bomId);
  if (!id) return "";
  const parts = id.split("_");
  return parts.length >= 2 ? parts[parts.length - 2] : "";
}

function deriveBomLocation(bomId) {
  const id = norm(bomId);
  if (!id) return "";
  const parts = id.split("_");
  return parts.length >= 1 ? parts[parts.length - 1] : "";
}
function deriveBomVersionFromBomId(bomId) {
  const id = norm(bomId);
  if (!id) return "";

  const parts = id.split("_");
  return parts.length >= 1 ? parts[0] : "";
}

function getChicagoTime() {
  const now = new Date();
  return now.toLocaleString("en-US", {
    timeZone: "America/Chicago",
    hour12: false,
  });
}

function generateUniqueBigInt() {
  const ts = Date.now().toString();
  const rand = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, "0");
  return `${ts}${rand}`;
}

function ensureArray(v) {
  return Array.isArray(v) ? v : [];
}

/* =========================================================
   Normalize only uploaded CSV tables from payload
========================================================= */
function normalizeUploadedTables(payload) {
  const tables = {
    bom_parameters: ensureArray(payload?.bom_parameters ?? payload?.parameters),
    bom_produced: ensureArray(payload?.bom_produced ?? payload?.produced),
    bom_consumed: ensureArray(payload?.bom_consumed ?? payload?.consumed),
    item_bom_routing: ensureArray(payload?.item_bom_routing ?? payload?.routing),
  };

  return tables;
}

/* =========================================================
   Convert uploaded CSV rows to Postgre insert rows
========================================================= */
function normalizeForPostgresInsert(payload) {
  const {
    bom_parameters,
    bom_produced,
    bom_consumed,
    item_bom_routing,
  } = normalizeUploadedTables(payload);

  const normalized = {
    bom_parameters: bom_parameters
      .map((row) => {
        const bom_id = norm(
          pick(row, ["BOMID", "bom_id", "bomId", "BOM_ID", "BOM Id"])
        );
        const produced_item =
          norm(
            pick(row, [
              "ProducedItem",
              "produced_item",
              "Produced_Item",
              "PRODUCED_ITEM",
              "Item",
            ])
          ) || deriveBomItem(bom_id);

        return {
          rec_id: generateUniqueBigInt(),
          bom_id,

          erp_bom_start_date: HARD_CODED_START_DATE,
          erp_bom_end_date: HARD_CODED_END_DATE,
          load_datetime: HARD_CODED_LOAD_DATETIME,
        };
      })
      .filter((x) => x.bom_id),

    bom_produced: bom_produced
      .map((row) => {
        const bom_id = norm(
          pick(row, ["BOMID", "bom_id", "bomId", "BOM_ID", "BOM Id"])
        );
        const item =
          norm(pick(row, ["Item", "item", "ITEM"])) || deriveBomItem(bom_id);
        const location =
          norm(pick(row, ["Location", "location", "LOC", "Plant", "PLANT"])) ||
          deriveBomLocation(bom_id);

        const qtyProduced = toNum(
          pick(row, [
            "ERPBOMQtyProducedPer",
            "ERPBOMQuantityProducedPer",
            "QtyProducedPer",
            "qty_produced_per",
            "QuantityProducedPer",
            "QTY_PRODUCED_PER",
          ])
        );

        const rawIsCo = pick(row, [
          "IsCoProduct",
          "is_coproduct",
          "CoProduct",
          "coproduct",
          "CoProductFlag",
          "co_product_flag",
        ]);

        const is_coproduct =
          toBool(rawIsCo) ||
          (qtyProduced != null && qtyProduced > 0 && qtyProduced < 1);

        return {
          rec_id: generateUniqueBigInt(),
          bom_id,
          item,
          location,

          bom_status: HARD_CODED_BOM_STATUS,
          bom_version: deriveBomVersionFromBomId(bom_id),
          prefix: HARD_CODED_PREFIX,
          bom_plan_type: HARD_CODED_BOM_PLAN_TYPE,

          erp_bom_qty_produced_per: qtyProduced,
          load_datetime: HARD_CODED_LOAD_DATETIME,
        };
      })
      .filter((x) => x.bom_id),

    bom_consumed: bom_consumed
      .map((row) => {
        const bom_id = norm(
          pick(row, ["BOMID", "bom_id", "bomId", "BOM_ID", "BOM Id"])
        );
        const item = norm(pick(row, ["Item", "item", "ITEM"]));
        const location =
          norm(pick(row, ["Location", "location", "LOC", "Plant", "PLANT"])) ||
          deriveBomLocation(bom_id);

        const qtyConsumed = toNum(
          pick(row, [
            "ERPBOMQuantityConsumedPer",
            "QtyConsumedPer",
            "qtyConsumedPer",
            "QuantityConsumedPer",
            "qty_consumed_per",
            "Qty Consumed Per",
            "ERPBOM Quantity Consumed Per",
          ])
        );

        const co_product_flag = toBool(
          pick(row, ["CoProductFlag", "co_product_flag", "coProductFlag"])
        );

        return {
          rec_id: generateUniqueBigInt(),
          bom_id,
          item,
          location,

          erp_bom_quantity_consumed_per: qtyConsumed,
          erp_bom_component_start_date: HARD_CODED_START_DATE,
          erp_bom_component_end_date: HARD_CODED_END_DATE,
          load_datetime: HARD_CODED_LOAD_DATETIME,
        };
      })
      .filter((x) => x.bom_id),

    item_bom_routing: item_bom_routing
      .map((row) => {
        const bom_id = norm(
          pick(row, ["BOMID", "bom_id", "bomId", "BOM_ID", "BOM Id"])
        );
        const item =
          norm(pick(row, ["Item", "item", "ITEM"])) || deriveBomItem(bom_id);
        const location =
          norm(pick(row, ["Location", "location", "LOC", "Plant", "PLANT"])) ||
          deriveBomLocation(bom_id);
        const routing_id = norm(
          pick(row, ["RoutingID", "routing_id", "routingId", "ROUTING_ID"])
        );
        const priority = toNum(
          pick(row, [
            "ERPItemBOMRoutingPriority",
            "RoutingPriority",
            "priority",
            "Priority",
          ])
        );
        const erp_co_product_association =
          toNum(
            pick(row, ["erp_co_product_association", "CoProductAssociation", "ERP_CoProductAssociation"])
          ) ?? null;

        return {
          rec_id: generateUniqueBigInt(),
          bom_id,
          item,
          routing_id,

          erp_item_bom_routing_priority: priority,
          erp_item_bom_routing_min_lot_size: null,
          erp_item_bom_routing_lot_size_increment: null,
          erp_item_bom_wip_sweep_priority: null,
          erp_co_product_association,
          erp_item_bom_routing_max_lot_size: null,

          load_datetime: HARD_CODED_LOAD_DATETIME,
        };
      })
      .filter((x) => x.bom_id),
  };

  return normalized;
}

/* =========================================================
   Dynamic Postgre insert helpers
========================================================= */
async function getExistingColumns(client, tableName) {
  const result = await client.query(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
      ORDER BY ordinal_position
    `,
    [tableName]
  );

  return result.rows.map((row) => String(row.column_name).trim().toLowerCase());
}

function buildInsertQuery(tableName, candidateData, allowedColumns) {
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
      INSERT INTO ${tableName} (${columns.join(", ")})
      VALUES (${placeholders.join(", ")})
    `,
    values,
  };
}

async function insertRows(client, tableName, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;

  const allowedColumns = await getExistingColumns(client, tableName);
  let inserted = 0;

  for (const row of rows) {
    const { query, values } = buildInsertQuery(tableName, row, allowedColumns);
    await client.query(query, values);
    inserted += 1;
  }

  return inserted;
}

/* =========================================================
   Main CSV validate + load
========================================================= */
export async function validateAndLoadAllCsv(payload = {}, options = {}) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const uploadedTables = normalizeUploadedTables(payload);

  const hasAnyRows =
    uploadedTables.bom_parameters.length > 0 ||
    uploadedTables.bom_produced.length > 0 ||
    uploadedTables.bom_consumed.length > 0 ||
    uploadedTables.item_bom_routing.length > 0;

  if (!hasAnyRows) {
    return {
      ok: false,
      errorCount: 1,
      report: null,
      errorsPreview: ["No CSV data received for validation."],
    };
  }

  const skipValidation = Boolean(options.skipValidation);

  if (skipValidation) {
    const normalized = normalizeForPostgresInsert(uploadedTables);
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const inserted = {
        bom_parameters: await insertRows(client, "bom_parameters", normalized.bom_parameters),
        bom_produced: await insertRows(client, "bom_produced", normalized.bom_produced),
        bom_consumed: await insertRows(client, "bom_consumed", normalized.bom_consumed),
        item_bom_routing: await insertRows(client, "item_bom_routing", normalized.item_bom_routing),
      };

      await client.query("COMMIT");

      return {
        ok: true,
        inserted,
        report: null,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // 1) Validate with GCP validator
  const validation = await validateWithGCP(uploadedTables, options);

  // 2) Failure -> failure report only, no DB load
  if (!validation.isValid) {
    const reportFileName = generateFailureReport({
      REPORT_DIR,
      errorList: validation.errorList,
      validation,
    });

    return {
      ok: false,
      errorCount: validation.errorList?.length || 0,
      report: {
        reportFileName,
      },
      errorsPreview: (validation.errorList || []).slice(0, 10),
    };
  }

  // 3) Success -> insert into Postgre only for uploaded tables
  const normalized = normalizeForPostgresInsert(uploadedTables);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const inserted = {
      bom_parameters: await insertRows(client, "bom_parameters", normalized.bom_parameters),
      bom_produced: await insertRows(client, "bom_produced", normalized.bom_produced),
      bom_consumed: await insertRows(client, "bom_consumed", normalized.bom_consumed),
      item_bom_routing: await insertRows(client, "item_bom_routing", normalized.item_bom_routing),
    };

    await client.query("COMMIT");

    // 4) Generate success report
    const successReportPath = generateSuccessReport({
      REPORT_DIR,
      validatedCounts: validation.validatedCounts,
      validatedRecIdCounts: validation.validatedCounts,
      getChicagoTime,
      validationType: "ONETIME",
    });

    return {
      ok: true,
      inserted,
      report: {
        reportFileName: path.basename(successReportPath),
      },
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}