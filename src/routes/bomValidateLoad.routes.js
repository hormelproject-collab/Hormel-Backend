import express from "express";
import path from "path";
import fs from "fs";
import { validateAndLoadAllCsv } from "../postgres/bomCSV validataandLoad.js";

const router = express.Router();
const ROOT = process.cwd();
const REPORTS_DIR = path.join(ROOT, "reports");

// Run validation + load
router.post("/validate-and-load", async (req, res) => {
  try {
    const result = await validateAndLoadAllCsv();

    if (!result.ok) {
      return res.status(400).json({
        status: "FAILED",
        errorCount: result.errorCount,
        reportFileName: result.report.reportFileName,
        reportDownloadUrl: `/api/bom-upload/report/${result.report.reportFileName}`,
        errorsPreview: result.errorsPreview,
      });
    }

    return res.json({
      status: "SUCCESS",
      inserted: result.inserted,
      message: "All CSV files validated and loaded into PostgreSQL successfully.",
    });
  } catch (err) {
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
    return res.status(404).json({ status: "NOT_FOUND", message: "Report not found" });
  }

  return res.download(fullPath, fileName);
});

export default router;