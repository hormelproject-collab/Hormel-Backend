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

/* =========================================================
   Helpers for Manual Entry Validation
========================================================= */
function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

function isPositiveNumber(value) {
  return typeof value === "number" && !Number.isNaN(value) && value > 0;
}

function isNonNegativeNumber(value) {
  return typeof value === "number" && !Number.isNaN(value) && value >= 0;
}

function buildFailure(code, message, context = {}) {
  return {
    code,
    message,
    ...context,
  };
}

/* =========================================================
   Detect if incoming payload is manual-entry JSON
   or existing CSV/GCP-shaped payload
========================================================= */
function detectInputMode(payload) {
  // Optional explicit mode from UI if you want to pass it later
  // req.body.entryMode = "manual" | "csv"
  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    typeof payload.entryMode === "string"
  ) {
    const mode = payload.entryMode.toLowerCase();
    if (mode === "manual" || mode === "csv") {
      return mode;
    }
  }

  const records = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.records)
    ? payload.records
    : Array.isArray(payload?.data)
    ? payload.data
    : null;

  if (Array.isArray(records) && records.length > 0) {
    const first = records[0];

    // Manual-entry shape detection
    if (
      first &&
      typeof first === "object" &&
      (
        "engineeringChange" in first ||
        "producedItem" in first ||
        "locations" in first ||
        "bomId" in first
      )
    ) {
      return "manual";
    }
  }

  return "csv";
}

/* =========================================================
   Normalize payload so route can support:
   - req.body as array
   - req.body.records
   - req.body.data
========================================================= */
function extractRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.records)) return payload.records;
  if (Array.isArray(payload?.data)) return payload.data;
  return payload;
}

/* =========================================================
   Manual Entry Validations Only
========================================================= */
function validateManualEntry(payload) {
  const records = extractRecords(payload);
  const failures = [];

  if (!Array.isArray(records) || records.length === 0) {
    failures.push(
      buildFailure("RM&RF", "Manual entry payload must be a non-empty array")
    );

    return {
      isValid: false,
      errorCodes: ["RM&RF"],
      errorList: failures.map((f) => f.message),
      failureDetails: failures,
    };
  }

  records.forEach((record, recordIndex) => {
    const recNo = recordIndex + 1;

    // -----------------------------------------------------
    // Top-level validations
    // -----------------------------------------------------
    if (isBlank(record?.bomId)) {
      failures.push(
        buildFailure("RM&RF", `Record ${recNo}: bomId is required`, {
          record: recNo,
          field: "bomId",
        })
      );
    }

    if (!record?.engineeringChange || typeof record.engineeringChange !== "object") {
      failures.push(
        buildFailure("RM&RF", `Record ${recNo}: engineeringChange is required`, {
          record: recNo,
          field: "engineeringChange",
        })
      );
    } else {
      if (isBlank(record.engineeringChange.ecNumber)) {
        failures.push(
          buildFailure(
            "RM&RF",
            `Record ${recNo}: engineeringChange.ecNumber is required`,
            {
              record: recNo,
              field: "engineeringChange.ecNumber",
            }
          )
        );
      }

      if (isBlank(record.engineeringChange.creationDate)) {
        failures.push(
          buildFailure(
            "RM&RF",
            `Record ${recNo}: engineeringChange.creationDate is required`,
            {
              record: recNo,
              field: "engineeringChange.creationDate",
            }
          )
        );
      }
    }

    if (!record?.producedItem || typeof record.producedItem !== "object") {
      failures.push(
        buildFailure("RM&RF", `Record ${recNo}: producedItem is required`, {
          record: recNo,
          field: "producedItem",
        })
      );
    } else {
      if (isBlank(record.producedItem.item)) {
        failures.push(
          buildFailure("RM&RF", `Record ${recNo}: producedItem.item is required`, {
            record: recNo,
            field: "producedItem.item",
          })
        );
      }

      if (isBlank(record.producedItem.status)) {
        failures.push(
          buildFailure(
            "RM&RF",
            `Record ${recNo}: producedItem.status is required`,
            {
              record: recNo,
              field: "producedItem.status",
            }
          )
        );
      }
    }

    if (!Array.isArray(record?.locations) || record.locations.length === 0) {
      failures.push(
        buildFailure("RM&RF", `Record ${recNo}: at least one location is required`, {
          record: recNo,
          field: "locations",
        })
      );
      return;
    }

    // -----------------------------------------------------
    // Location-level validations
    // -----------------------------------------------------
    record.locations.forEach((loc, locIndex) => {
      const locNo = locIndex + 1;

      if (isBlank(loc?.locationId) && isBlank(loc?.locationName)) {
        failures.push(
          buildFailure(
            "RM&RF",
            `Record ${recNo}, Location ${locNo}: locationId or locationName is required`,
            {
              record: recNo,
              location: locNo,
              field: "locationId/locationName",
            }
          )
        );
      }

      if (isBlank(loc?.locationStatus)) {
        failures.push(
          buildFailure(
            "RM&RF",
            `Record ${recNo}, Location ${locNo}: locationStatus is required`,
            {
              record: recNo,
              location: locNo,
              field: "locationStatus",
            }
          )
        );
      }

      const resourceInfo = loc?.resourceInfo || {};
      const flags = loc?.flags || {};
      const componentItems = Array.isArray(loc?.componentItems) ? loc.componentItems : [];
      const coProducts = Array.isArray(loc?.coProducts) ? loc.coProducts : [];

      if (isBlank(resourceInfo.resource)) {
        failures.push(
          buildFailure(
            "RM&RF",
            `Record ${recNo}, Location ${locNo}: resourceInfo.resource is required`,
            {
              record: recNo,
              location: locNo,
              field: "resourceInfo.resource",
            }
          )
        );
      }

      if (isBlank(resourceInfo.resourceRelevancy)) {
        failures.push(
          buildFailure(
            "RM&RF",
            `Record ${recNo}, Location ${locNo}: resourceInfo.resourceRelevancy is required`,
            {
              record: recNo,
              location: locNo,
              field: "resourceInfo.resourceRelevancy",
            }
          )
        );
      }

      if (isBlank(resourceInfo.bomVersion)) {
        failures.push(
          buildFailure(
            "RM&RF",
            `Record ${recNo}, Location ${locNo}: resourceInfo.bomVersion is required`,
            {
              record: recNo,
              location: locNo,
              field: "resourceInfo.bomVersion",
            }
          )
        );
      }

      if (isBlank(resourceInfo.routingId)) {
        failures.push(
          buildFailure(
            "RM&RF",
            `Record ${recNo}, Location ${locNo}: resourceInfo.routingId is required`,
            {
              record: recNo,
              location: locNo,
              field: "resourceInfo.routingId",
            }
          )
        );
      }

      if (!isNonNegativeNumber(resourceInfo.priority)) {
        failures.push(
          buildFailure(
            "RM&RF",
            `Record ${recNo}, Location ${locNo}: resourceInfo.priority must be a number >= 0`,
            {
              record: recNo,
              location: locNo,
              field: "resourceInfo.priority",
            }
          )
        );
      }

      // -----------------------------------------------------
      // Component item validations
      // -----------------------------------------------------
      if (flags.noComponentItems !== true && componentItems.length === 0) {
        failures.push(
          buildFailure(
            "RM&RF",
            `Record ${recNo}, Location ${locNo}: componentItems are required when flags.noComponentItems is false`,
            {
              record: recNo,
              location: locNo,
              field: "componentItems",
            }
          )
        );
      }

      componentItems.forEach((comp, compIndex) => {
        const compNo = compIndex + 1;

        if (isBlank(comp?.componentItem)) {
          failures.push(
            buildFailure(
              "RM&RF",
              `Record ${recNo}, Location ${locNo}, Component ${compNo}: componentItem is required`,
              {
                record: recNo,
                location: locNo,
                component: compNo,
                field: "componentItems.componentItem",
              }
            )
          );
        }

        if (!isPositiveNumber(comp?.standardUsage)) {
          failures.push(
            buildFailure(
              "RM&RF",
              `Record ${recNo}, Location ${locNo}, Component ${compNo}: standardUsage must be > 0`,
              {
                record: recNo,
                location: locNo,
                component: compNo,
                field: "componentItems.standardUsage",
              }
            )
          );
        }
      });

      // -----------------------------------------------------
      // Co-product validations
      // -----------------------------------------------------
      if (coProducts.length > 0) {
        if (flags.isCoProduct !== true) {
          failures.push(
            buildFailure(
              "RM&RF",
              `Record ${recNo}, Location ${locNo}: flags.isCoProduct must be true when coProducts exist`,
              {
                record: recNo,
                location: locNo,
                field: "flags.isCoProduct",
              }
            )
          );
        }

        if (resourceInfo.coProductAssociation !== 1) {
          failures.push(
            buildFailure(
              "RM&RF",
              `Record ${recNo}, Location ${locNo}: resourceInfo.coProductAssociation must be 1 when coProducts exist`,
              {
                record: recNo,
                location: locNo,
                field: "resourceInfo.coProductAssociation",
              }
            )
          );
        }

        let hasQtyProducedPerLessThanOne = false;

        coProducts.forEach((cp, cpIndex) => {
          const cpNo = cpIndex + 1;

          if (isBlank(cp?.coProductItem)) {
            failures.push(
              buildFailure(
                "RM&RF",
                `Record ${recNo}, Location ${locNo}, CoProduct ${cpNo}: coProductItem is required`,
                {
                  record: recNo,
                  location: locNo,
                  coProduct: cpNo,
                  field: "coProducts.coProductItem",
                }
              )
            );
          }

          if (!isPositiveNumber(cp?.qtyProducedPer)) {
            failures.push(
              buildFailure(
                "RM&RF",
                `Record ${recNo}, Location ${locNo}, CoProduct ${cpNo}: qtyProducedPer must be > 0`,
                {
                  record: recNo,
                  location: locNo,
                  coProduct: cpNo,
                  field: "coProducts.qtyProducedPer",
                }
              )
            );
          }

          if (typeof cp?.qtyProducedPer === "number" && cp.qtyProducedPer < 1) {
            hasQtyProducedPerLessThanOne = true;
          }
        });

        if (!hasQtyProducedPerLessThanOne) {
          failures.push(
            buildFailure(
              "RM&RF",
              `Record ${recNo}, Location ${locNo}: at least one coProduct qtyProducedPer must be < 1`,
              {
                record: recNo,
                location: locNo,
                field: "coProducts.qtyProducedPer",
              }
            )
          );
        }
      }
    });
  });

  const errorCodes = [...new Set(failures.map((f) => f.code))];
  const errorList = failures.map((f) => f.message);

  return {
    isValid: failures.length === 0,
    errorCodes,
    errorList,
    failureDetails: failures,
  };
}

/* =========================================================
   POST /bom-explosion
   Supports BOTH:
   1. Existing CSV/GCP validation flow
   2. Manual-entry JSON validation flow
========================================================= */
router.post("/", async (req, res) => {
  const payload = req.body;

  const REPORT_DIR = path.join(process.cwd(), "reports");
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const reportNameBase = `BOM_${getChicagoTimeStamp()}`;
  console.log("bom-explosion called");

  // ✅ SAME EC FOR ALL RECORDS
  const extractedRecords = extractRecords(payload);
  const ecNumber =
    Array.isArray(extractedRecords) && extractedRecords[0]?.engineeringChange?.ecNumber
      ? extractedRecords[0].engineeringChange.ecNumber
      : `EC${Math.floor(1000000 + Math.random() * 9000000)}`;

  try {
    const inputMode = detectInputMode(payload);

    let validation;

    // =====================================================
    // MANUAL ENTRY FLOW
    // =====================================================
    if (inputMode === "manual") {
      validation = validateManualEntry(payload);

      if (validation.isValid) {
        return res.json({
          status: "success",
          message: "Validation successful",
          ecNumber,
        });
      }

      const reportFile = generateFailureReport({
        REPORT_DIR,
        errorList: validation.errorList,
        ecNumber,
        reportNameBase,
        validation, // ✅ keep for report generator compatibility
      });

      return res.status(400).json({
        status: "failure",
        message: "Validation failed",
        reportFile,
        ecNumber,
        errors: validation.errorCodes?.length ? validation.errorCodes : ["RM&RF"],
      });
    }

    // =====================================================
    // EXISTING CSV / GCP FLOW  (preserved)
    // =====================================================
    validation = await validateWithGCP(payload);

    if (validation.isValid) {
      return res.json({
        status: "success",
        message: "Validation successful",
        ecNumber,
      });
    }

    const reportFile = generateFailureReport({
      REPORT_DIR,
      errorList: validation.errorList,
      ecNumber,
      reportNameBase,
      validation, // ✅ existing compatibility preserved
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