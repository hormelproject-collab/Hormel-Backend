import fs from "fs";
import path from "path";

export const generateSuccessReport = ({
  REPORT_DIR,
  validatedCounts,
  // ✅ NEW: if provided, report uses these (counts based on GCP rec_id)
  validatedRecIdCounts,
  getChicagoTime,
  validationType = "ONETIME",
}) => {
  const reportFile = path.join(
    REPORT_DIR,
    `Validation_Report_${Date.now()}.csv`
  );

  // ✅ Prefer REC_ID based counts if present
  const vc = validatedRecIdCounts || validatedCounts || {};

  let report = "";

  // Header (kept simple, you can align with your older header if needed)
  report += `Report Name:,BOM Validation Success Report\n`;
  report += `Trnx Type:,${validationType === "ONETIME" ? "ONETIME_LOAD" : "BOM_EXPLOSION"}\n`;
  report += `Run By:,APPL_TEAM\n`;
  report += `Count Basis:,GCP_REC_ID\n`; // ✅ Explicit
  report += `Report Time:,${getChicagoTime()}\n\n`;

  // Summary
  report += `Summary,BOM_PARAMETERS,BOM_PRODUCED,BOM_CONSUMED,ITEM_BOM_ROUTING\n`;
  report += `Validated Count,${vc.BOM_PARAMETERS || 0},${vc.BOM_PRODUCED || 0},${vc.BOM_CONSUMED || 0},${vc.ITEM_BOM_ROUTING || 0}\n`;

  // All success for success report
  report += `Success Count,${vc.BOM_PARAMETERS || 0},${vc.BOM_PRODUCED || 0},${vc.BOM_CONSUMED || 0},${vc.ITEM_BOM_ROUTING || 0}\n`;
  report += `Error Count,0,0,0,0\n`;
  report += `Onetime Load Successful?,Yes\n`;
  report += `Target Count,${vc.BOM_PARAMETERS || 0},${vc.BOM_PRODUCED || 0},${vc.BOM_CONSUMED || 0},${vc.ITEM_BOM_ROUTING || 0}\n`;

  fs.writeFileSync(reportFile, report);
  return reportFile;
};