import fs from "fs";
import path from "path";
import { validationRules } from "../postgres/ValidationRules.js";

// ✅ Chicago time for display
function getChicagoTime() {
  const now = new Date();
  return now.toLocaleString("en-US", {
    timeZone: "America/Chicago",
    hour12: false,
  });
}

// ✅ ✅ NEW: File name generator (Requirement applied)
function getReportFileName() {
  const now = new Date();

  const chicago = new Date(
    now.toLocaleString("en-US", { timeZone: "America/Chicago" })
  );

  const MM = String(chicago.getMonth() + 1).padStart(2, "0");
  const DD = String(chicago.getDate()).padStart(2, "0");
  const YYYY = chicago.getFullYear();

  const HH = String(chicago.getHours()).padStart(2, "0");
  const mm = String(chicago.getMinutes()).padStart(2, "0");
  const ss = String(chicago.getSeconds()).padStart(2, "0");

  return `Planning_BOM_Maintenance_Validations_Report_${MM}${DD}${YYYY}_${HH}${mm}${ss}_CST.csv`;
}

// ✅ template apply
const applyTemplate = (template, values = {}) => {
  let out = String(template || "");

  const map = {};
  Object.entries(values || {}).forEach(([k, v]) => {
    map[k.toLowerCase()] = v;
  });

  return out.replace(/<([^>]+)>/g, (_, key) => {
    return map[key.toLowerCase()] ?? "";
  });
};

// ✅ CSV escape
const esc = (v) => {
  if (v == null) return "";
  const s = String(v);
  if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};

export const generateFailureReport = ({
  REPORT_DIR,
  errorList = [],
  ecNumber,
  validation,
}) => {
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const fileName = getReportFileName();
  const file = path.join(REPORT_DIR, fileName);

  const ENG_CHANGE_ID =
    ecNumber || `EC${Math.floor(1000000 + Math.random() * 9000000)}`;

  let rows = "";

  // HEADER
  rows +=
    "Report Name,Validation Report for Planning BOM Maintenance Application UI\n";

  rows += `Report Time,${getChicagoTime()} CST\n`;

  rows += "Trnx Type,ONETIME,Run By,APPL_TEAM\n\n";

  // SUMMARY
  const validated = validation?.validatedCounts || {};
  const errors = validation?.errorCounts || {};

  const success = {
    BOM_PARAMETERS:
      (validated.BOM_PARAMETERS || 0) -
      (errors.BOM_PARAMETERS || 0),
    BOM_PRODUCED:
      (validated.BOM_PRODUCED || 0) -
      (errors.BOM_PRODUCED || 0),
    BOM_CONSUMED:
      (validated.BOM_CONSUMED || 0) -
      (errors.BOM_CONSUMED || 0),
    ITEM_BOM_ROUTING:
      (validated.ITEM_BOM_ROUTING || 0) -
      (errors.ITEM_BOM_ROUTING || 0),
  };

  rows += "Summary,BOM_PARAMETERS,BOM_PRODUCED,BOM_CONSUMED,ITEM_BOM_ROUTING\n";

  rows += `Validated Count,${validated.BOM_PARAMETERS || 0},${validated.BOM_PRODUCED || 0},${validated.BOM_CONSUMED || 0},${validated.ITEM_BOM_ROUTING || 0}\n`;

  rows += `Success Count,${success.BOM_PARAMETERS},${success.BOM_PRODUCED},${success.BOM_CONSUMED},${success.ITEM_BOM_ROUTING}\n`;

  rows += `Error Count,${errors.BOM_PARAMETERS || 0},${errors.BOM_PRODUCED || 0},${errors.BOM_CONSUMED || 0},${errors.ITEM_BOM_ROUTING || 0}\n`;

  rows += "One Time Load,No\n\n";

  // ✅ ✅ ERROR HEADER UPDATED
  rows += "Error Details are below:\n";

  rows +=
    "ERR_LOG_ID,ENG_CHANGE_ID,File name,ROW NUMBER,BOM_ID,Validation_sequence,Validation_description,Validation_ERROR_DETAILS,Remediation message\n";

  let autoId = 1; // ✅ for ERR_LOG_ID
  let fallbackRowNumber = 1; // ✅ only used if csvRecId missing

  // ERROR ROWS
  for (const err of errorList) {
    const bomId = err.bomId || "NULL";
    const fileName = err.fileName || err.table || "UNKNOWN";

    for (const msg of err.messages || []) {
      const seq = msg.seq;
      const rule = validationRules?.[seq] || {};

      // ✅ existing logic reused as ROW NUMBER
      const rowNumber =
        err.csvRecId && err.csvRecId !== "NULL"
          ? err.csvRecId
          : fallbackRowNumber++;

      const values = {
        value: bomId,
        ...msg.values,
      };

      const desc = applyTemplate(rule.desc, values);
      const errorMsg = applyTemplate(rule.error, values);
      const rm = applyTemplate(rule.rm, values);

      rows +=
        [
          esc(autoId++),            // ✅ ERR_LOG_ID (auto increment)
          esc(ENG_CHANGE_ID),
          esc(fileName),
          esc(rowNumber),           // ✅ ROW NUMBER (old ERR_ID logic)
          esc(bomId),
          esc(seq),
          esc(desc),
          esc(errorMsg),
          esc(rm),
        ].join(",") + "\n";
    }
  }

  fs.writeFileSync(file, rows, "utf8");

  return fileName;
};