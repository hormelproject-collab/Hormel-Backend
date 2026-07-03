import express from "express";
import path from "path";
import fs from "fs";
import { BigQuery } from "@google-cloud/bigquery";
import { validateAndLoadAllCsv } from "../postgres/ValidateOneTimeUpload.js";

const router = express.Router();
const ROOT = process.cwd();
const REPORTS_DIR = path.join(ROOT, "reports");

// Keep only table names at top if needed
const BQ_TABLE_BOM_PARAMETERS =
  process.env.BQ_TABLE_BOM_PARAMETERS || "bom_parameters";
const BQ_TABLE_BOM_PRODUCED =
  process.env.BQ_TABLE_BOM_PRODUCED || "bom_produced";
const BQ_TABLE_BOM_CONSUMED =
  process.env.BQ_TABLE_BOM_CONSUMED || "bom_consumed";
const BQ_TABLE_ITEM_BOM_ROUTING =
  process.env.BQ_TABLE_ITEM_BOM_ROUTING || "item_bom_routing";

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
    message: "CSV files validated and loaded into PostgreSQL successfully.",
  });
}

async function fetchBigQueryTable(tableName) {
  const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || "";
  const BQ_PROJECT_ID = process.env.BQ_PROJECT_ID || GCP_PROJECT_ID || "";
  const BQ_DATASET = process.env.BQ_DATASET || "";

  if (!BQ_PROJECT_ID || !BQ_DATASET ) {
    throw new Error(
      "BQ_PROJECT_ID or BQ_DATASET  is not set in .env"
    );
  }

  const bigquery = new BigQuery({
    projectId: BQ_PROJECT_ID,
  });

  const query = `
    SELECT *
    FROM \`${BQ_PROJECT_ID}.${BQ_DATASET}.${tableName}\`
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
    routing_id: row.routing_id ?? row.RoutingID ?? row.routingId ?? "",
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

  const result = await validateAndLoadAllCsv(payload);
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
    const result = await validateAndLoadAllCsv(payload);
    return sendValidateLoadResponse(res, result);
  } catch (err) {
    console.error("validate-and-load csv flow error:", err);
    return res.status(500).json({
      status: "ERROR",
      message: err.message || "Unexpected server error",
    });
  }
});

router.post("/sync-gcp-to-postgres", async (req, res) => {
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