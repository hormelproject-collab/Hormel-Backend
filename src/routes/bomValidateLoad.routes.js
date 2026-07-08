import express from "express";
import path from "path";
import fs from "fs";
import { BigQuery } from "@google-cloud/bigquery";
import { validateAndLoadAllCsv } from "../postgres/ValidateOneTimeUpload.js";
import appConfig from "../config/appConfig.js";

const router = express.Router();
const ROOT = process.cwd();
const REPORTS_DIR = path.join(ROOT, "reports");

const BQ_TABLE_BOM_PARAMETERS =
  appConfig.bigQuery.tables.bomParameters;

const BQ_TABLE_BOM_PRODUCED =
  appConfig.bigQuery.tables.bomProduced;

const BQ_TABLE_BOM_CONSUMED =
  appConfig.bigQuery.tables.bomConsumed;

const BQ_TABLE_ITEM_BOM_ROUTING =
  appConfig.bigQuery.tables.itemBomRouting;

function sendValidateLoadResponse(res, result) {
  if (!result.ok) {
    return res.status(400).json({
      status: "FAILED",
      errorCount: result.errorCount || 0,
      reportFileName: result.report?.reportFileName || null,
      reportDownloadUrl: result.report?.reportFileName
        ? `/api/bom-upload/report/${result.report.reportFileName}`
        : null,
      errorsPreview: result.errorsPreview || [],
    });
  }

  return res.json({
    status: "SUCCESS",
    inserted: result.inserted || {},
    reportFileName: result.report?.reportFileName || null,
    reportDownloadUrl: result.report?.reportFileName
      ? `/api/bom-upload/report/${result.report.reportFileName}`
      : null,
    message:
      "CSV files validated and loaded into PostgreSQL successfully.",
  });
}

async function fetchBigQueryTable(tableConfig) {
  const tableName =
    typeof tableConfig === "string" ? tableConfig : tableConfig.table;

  const projectId = appConfig.bigQuery.projectIds.dev;
  const datasetId = appConfig.bigQuery.datasetId;

  let keyFilename = process.env.GOOGLE_APPLICATION_CREDENTIALS || appConfig.bigQuery.keyFilename || undefined;
  if (keyFilename && !path.isAbsolute(keyFilename)) {
    keyFilename = path.resolve(process.cwd(), keyFilename);
  }

  if (keyFilename && !fs.existsSync(keyFilename)) {
    console.warn(
      `[bomValidateLoad] BigQuery key file not found at ${keyFilename}. Falling back to ADC if available.`
    );
    keyFilename = undefined;
  }

  if (!keyFilename && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.warn(
      `[bomValidateLoad] No BigQuery credentials found. Set GOOGLE_APPLICATION_CREDENTIALS or appConfig.bigQuery.keyFilename.`
    );
  }

  const bigquery = new BigQuery({
    projectId,
    ...(keyFilename ? { keyFilename } : {}),
  });

  const query = `
    SELECT *
    FROM \`${projectId}.${datasetId}.${tableName}\`
  `;

  const [job] = await bigquery.createQueryJob({
    query,
  });

  const [rows] = await job.getQueryResults();

  const normalizedRows = (Array.isArray(rows) ? rows : []).map((row) => ({
    ...row,

    // Common aliases
    item: row.item ?? row.Item ?? "",
    location: row.location ?? row.Location ?? "",
    bom_id: row.bom_id ?? row.BOMID ?? row.bomId ?? "",

    // bom_consumed specific
    erp_bom_quantity_consumed_per:
      row.erp_bom_quantity_consumed_per ??
      row.ERPBOMQuantityConsumedPer ??
      "",

    erp_bom_component_start_date:
      row.erp_bom_component_start_date ??
      row.ERPBOMComponentStartDate ??
      "",

    erp_bom_component_end_date:
      row.erp_bom_component_end_date ??
      row.ERPBOMComponentEndDate ??
      "",

    // record id / snapshot
    record_id: row.record_id ?? row.RecordID ?? "",
    snapshot_date: row.snapshot_date ?? row.SnapshotDate ?? "",

    // bom_produced aliases
    erp_bom_qty_produced_per:
      row.erp_bom_qty_produced_per ??
      row.ERPBOMQtyProducedPer ??
      row.ERPBOMQuantityProducedPer ??
      "",

    // item_bom_routing aliases
    routing_id:
      row.routing_id ??
      row.RoutingID ??
      row.routingId ??
      "",

    erp_item_bom_routing_priority:
      row.erp_item_bom_routing_priority ??
      row.ERPItemBOMRoutingPriority ??
      "",

    erp_item_bom_routing_min_lot_size:
      row.erp_item_bom_routing_min_lot_size ??
      row.ERPItemBOMRoutingMinLotSize ??
      "",

    erp_item_bom_routing_lot_size_increment:
      row.erp_item_bom_routing_lot_size_increment ??
      row.ERPItemBOMRoutingLotSizeIncrement ??
      "",

    erp_item_bom_routing_max_lot_size:
      row.erp_item_bom_routing_max_lot_size ??
      row.ERPItemBOMRoutingMaxLotSize ??
      "",

    erp_item_bom_wip_sweep_priority:
      row.erp_item_bom_wip_sweep_priority ??
      row.ERPItemBOMWIPSweepPriority ??
      "",

    erp_item_bom_routing_wip_sweep_priority:
      row.erp_item_bom_routing_wip_sweep_priority ??
      row.ERPItemBOMRoutingWIPSweepPriority ??
      "",

    // co-product association
    erp_co_product_association:
      row.erp_co_product_association ??
      row.ERPCoProductAssociation ??
      row.co_product_association ??
      "",
  }));

  return normalizedRows;
}

export async function performScheduledGcpSync() {
  const [
    bom_parameters,
    bom_produced,
    bom_consumed,
    item_bom_routing,
  ] = await Promise.all([
    fetchBigQueryTable(BQ_TABLE_BOM_PARAMETERS),
    fetchBigQueryTable(BQ_TABLE_BOM_PRODUCED),
    fetchBigQueryTable(BQ_TABLE_BOM_CONSUMED),
    fetchBigQueryTable(BQ_TABLE_ITEM_BOM_ROUTING),
  ]);

  const payload = {
    bom_parameters,
    bom_produced,
    bom_consumed,
    item_bom_routing,
  };

 
const result = await validateAndLoadAllCsv(payload, {
  skipDuplicateExistenceCheck: true,
});

  return {
    result,
    fetchedCounts: {
      bom_parameters: bom_parameters.length,
      bom_produced: bom_produced.length,
      bom_consumed: bom_consumed.length,
      item_bom_routing: item_bom_routing.length,
    },
  };
}

router.post("/validate-and-load", async (req, res) => {
  try {
    const payload = req.body || {};

    const result = await validateAndLoadAllCsv(payload, {
      skipDuplicateExistenceCheck:
        payload.skipDuplicateExistenceCheck ||
        payload.skipBigQueryDuplicateChecks ||
        payload.skipBigQueryDuplicateCheck,
      skipCrossTableValidation:
        payload.skipCrossTableValidation ||
        payload.skipCrossValidation ||
        payload.skipCrossTableChecks,
    });

    return sendValidateLoadResponse(res, result);
  } catch (err) {
    console.error("validate-and-load csv flow error:", err);
    return res.status(500).json({
      status: "ERROR",
      message: err.message || "Unexpected server error",
    });
  }
});

router.get("/sync-gcp-to-postgres", (_req, res) => {
  return res.json({
    status: "OK",
    message:
      "This endpoint accepts POST requests to sync BigQuery data into PostgreSQL. Use POST /api/bom-upload/sync-gcp-to-postgres.",
  });
});

router.post("/sync-gcp-to-postgres", async (req, res) => {
  console.log("[bomValidateLoad] sync-gcp-to-postgres called");
  try {
    const { result, fetchedCounts } = await performScheduledGcpSync();

    if (!result.ok) {
      return res.status(400).json({
        status: "FAILED",
        source: "sync-gcp-to-postgres",
        fetchedCounts,
        errorCount: result.errorCount || 0,
        reportFileName: result.report?.reportFileName || null,
        reportDownloadUrl: result.report?.reportFileName
          ? `/api/bom-upload/report/${result.report.reportFileName}`
          : null,
        errorsPreview: result.errorsPreview || [],
      });
    }

    return res.json({
      status: "SUCCESS",
      source: "sync-gcp-to-postgres",
      fetchedCounts,
      inserted: result.inserted || {},
      reportFileName: result.report?.reportFileName || null,
      reportDownloadUrl: result.report?.reportFileName
        ? `/api/bom-upload/report/${result.report.reportFileName}`
        : null,
      message:
        "BigQuery tables fetched, validated, and loaded into PostgreSQL successfully.",
    });
  } catch (err) {
    console.error("sync-gcp-to-postgres error:", err);
    return res.status(500).json({
      status: "ERROR",
      message: err.message || "Unexpected sync error",
    });
  }
});

// Download report
router.get("/report/:fileName", (req, res) => {
  const fileName = req.params.fileName;
  const fullPath = path.join(REPORTS_DIR, fileName);

  if (!fs.existsSync(fullPath)) {
    return res.status(404).json({
      status: "NOT_FOUND",
      message: "Report not found",
    });
  }

  return res.download(fullPath, fileName);
});

export default router;