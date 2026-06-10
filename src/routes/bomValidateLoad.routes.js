import express from "express";
import path from "path";
import fs from "fs";
import { validateAndLoadAllCsv } from "../postgres/ValidateOneTimeUpload.js";

const router = express.Router();
const ROOT = process.cwd();
const REPORTS_DIR = path.join(ROOT, "reports");

/**
 * POST /validate-and-load
 *
 * Expected request body:
 * {
 *   bom_parameters?: [],
 *   bom_produced?: [],
 *   bom_consumed?: [],
 *   item_bom_routing?: []
 * }
 *
 * Any subset of the 4 uploaded CSV files is allowed.
 */
router.post("/validate-and-load", async (req, res) => {
  try {
    const payload = req.body || {};
    const result = await validateAndLoadAllCsv(payload);

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
  } catch (err) {
    console.error("validate-and-load csv flow error:", err);
    return res.status(500).json({
      status: "ERROR",
      message: err.message || "Unexpected server error",
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