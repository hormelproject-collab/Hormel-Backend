import express from "express";
import path from "path";
import fs from "fs";

import { validateWithGCP } from "../bigquery/GCPvalidation.js";
import { generateFailureReport } from "../reportGenerator/failureReportGenerator.js";

const router = express.Router();

function getChicagoTimeStamp() {
  const now = new Date();
  const chicago = now.toLocaleString("en-US", {
    timeZone: "America/Chicago",
    hour12: false,
  });

  return chicago.replace(/[/,: ]/g, "_");
}

router.post("/", async (req, res) => {
  const payload = req.body;

  const REPORT_DIR = path.join(process.cwd(), "reports");
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const reportNameBase = `BOM_${getChicagoTimeStamp()}`;

  // ✅ SAME EC FOR ALL RECORDS
  const ecNumber = `EC${Math.floor(1000000 + Math.random() * 9000000)}`;

  try {
    const validation = await validateWithGCP(payload);

    if (validation.isValid) {
      return res.json({
        status: "success",
        message: "Validation successful",
        ecNumber,
      });
    }

    // const reportFile = generateFailureReport({
    //   REPORT_DIR,
    //   errorList: validation.errorList,
    //   ecNumber,
    //   reportNameBase,
    // });
    

const reportFile = generateFailureReport({
  REPORT_DIR,
  errorList: validation.errorList,
  ecNumber,
  reportNameBase,
  validation   // ✅ ADD THIS LINE
});



    return res.json({
      status: "failure",
      message: "Validation failed",
      reportFile,
      ecNumber,
      errors: validation.errorList,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      status: "failure",
      message: err.message,
    });
  }
});

export default router;