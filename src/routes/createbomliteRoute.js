import express from "express";
import path from "path";
import fs from "fs";

import { validateWithGCP } from "../bigquery/GCPvalidation.js";
import { generateFailureReport } from "../reportGenerator/failureReportGenerator.js";
import { validationRules } from "../postgres/ValidationRules.js";

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
   Helpers
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

function isIntegerNumber(value) {
  return typeof value === "number" && !Number.isNaN(value) && Number.isInteger(value);
}

function toNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

function applyTemplate(template, values = {}) {
  let out = String(template || "");

  const map = {};
  Object.entries(values || {}).forEach(([k, v]) => {
    map[String(k).toLowerCase()] = v;
  });

  return out.replace(/<([^>]+)>/g, (_, key) => {
    return map[String(key).toLowerCase()] ?? "";
  });
}

function getRule(seq) {
  return validationRules?.[seq] || {};
}

function buildManualMessage({
  seq,
  values = {},
  fallbackValidation = "",
  fallbackErrorDetails = "",
  fallbackRemediationMessage = "",
}) {
  const rule = getRule(seq);

  const validation =
    applyTemplate(rule?.desc || "", values) || fallbackValidation || "";

  const errorDetails =
    applyTemplate(rule?.error || "", values) || fallbackErrorDetails || "";

  const remediationMessage =
    applyTemplate(rule?.rm || "", values) || fallbackRemediationMessage || "";

  return {
    seq,
    validationSequence: seq,
    validation,
    errorDetails,
    remediationMessage,
    desc: validation,
    error: errorDetails,
    rm: remediationMessage,
    values,
  };
}

function buildManualErrorRow({
  seq,
  values = {},
  fallbackValidation = "",
  fallbackErrorDetails = "",
  fallbackRemediationMessage = "",
  record = null,
  bomId = "",
  item = "",
  location = "",
  routingId = "",
  field = "",
  table = "MANUAL_ENTRY",
}) {
  return {
    table,
    bomId: bomId || "NULL",
    gcpRecId: "NULL",
    csvRecId: record != null ? String(record) : "NULL",
    item: item || "",
    location: location || "",
    routingId: routingId || "",
    recordId: `${table}__${record ?? "NULL"}__${bomId || "NULL"}__${item || ""}__${location || ""}__${routingId || ""}__${field || ""}`,
    field,
    messages: [
      buildManualMessage({
        seq,
        values,
        fallbackValidation,
        fallbackErrorDetails,
        fallbackRemediationMessage,
      }),
    ],
  };
}

/* =========================================================
   Detect if incoming payload is manual-entry JSON
   or existing CSV/GCP-shaped payload
========================================================= */
function detectInputMode(payload) {
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

    if (
      first &&
      typeof first === "object" &&
      ("engineeringChange" in first ||
        "producedItem" in first ||
        "locations" in first ||
        "bomId" in first)
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
   Normalize validation response for UI
   NOTE: CSV flow kept as-is
========================================================= */
function normalizeValidationForUI(validation) {
  const errorDetails =
    validation?.failureDetails ||
    validation?.errorDetails ||
    validation?.errors ||
    (Array.isArray(validation?.errorList)
      ? validation.errorList.map((msg, index) => ({
          code: validation?.errorCodes?.[index] || "VALIDATION_ERROR",
          message: msg,
          remediation: "Please correct the data and resubmit.",
        }))
      : []);

  const remediationDetails =
    validation?.remediationDetails ||
    validation?.remediation ||
    (Array.isArray(errorDetails)
      ? errorDetails.map((item) => ({
          record: item.record ?? item.rowNumber ?? null,
          location: item.location ?? null,
          component: item.component ?? null,
          coProduct: item.coProduct ?? null,
          field: item.field ?? null,
          remediation:
            item.remediation || "Please correct the data and resubmit.",
        }))
      : []);

  const errorCodes =
    validation?.errorCodes?.length
      ? [...new Set(validation.errorCodes)]
      : Array.isArray(errorDetails)
      ? [...new Set(errorDetails.map((e) => e.code).filter(Boolean))]
      : ["VALIDATION_ERROR"];

  const errorList =
    validation?.errorList?.length
      ? validation.errorList
      : Array.isArray(errorDetails)
      ? errorDetails.map((e) => e.message).filter(Boolean)
      : ["Validation failed"];

  return {
    errorCodes,
    errorList,
    errorDetails,
    remediationDetails,
  };
}

/* =========================================================
   Manual Entry Validations Only
   Returns the structure Summary.jsx expects:
   errorList: [{ messages: [{ validationSequence, validation,
                              errorDetails, remediationMessage }] }]
========================================================= */
function validateManualEntry(payload) {
  const records = extractRecords(payload);
  const failures = [];

  if (!Array.isArray(records) || records.length === 0) {
    failures.push(
      buildManualErrorRow({
        seq: "RM&RF",
        record: 1,
        field: "records",
        fallbackValidation: "Manual entry payload must be a non-empty array",
        fallbackErrorDetails:
          "No manual-entry records were received in the request body.",
        fallbackRemediationMessage:
          "Send a non-empty manual entry records array in the request body.",
      })
    );

    return {
      isValid: false,
      errorCodes: ["RM&RF"],
      errorList: failures,
      failureDetails: failures,
    };
  }

  records.forEach((record, recordIndex) => {
    const recNo = recordIndex + 1;
    const bomId = normalizeText(record?.bomId);
    const item = normalizeText(record?.producedItem?.item);
    const locations = ensureArray(record?.locations);

    /* -----------------------------------------------------
       Top-level validations
    ----------------------------------------------------- */
    if (isBlank(record?.bomId)) {
      failures.push(
        buildManualErrorRow({
          seq: "RM&RF",
          record: recNo,
          bomId,
          item,
          field: "bomId",
          values: { value: record?.bomId ?? "" },
          fallbackValidation: "BOM ID is required",
          fallbackErrorDetails: `Record ${recNo}: bomId is required.`,
          fallbackRemediationMessage: "Provide bomId and resubmit.",
        })
      );
    }

    if (!record?.engineeringChange || typeof record.engineeringChange !== "object") {
      failures.push(
        buildManualErrorRow({
          seq: "RM&RF",
          record: recNo,
          bomId,
          item,
          field: "engineeringChange",
          fallbackValidation: "Engineering Change is required",
          fallbackErrorDetails: `Record ${recNo}: engineeringChange is required.`,
          fallbackRemediationMessage:
            "Provide engineeringChange object with required fields.",
        })
      );
    } else {
      if (isBlank(record.engineeringChange.ecNumber)) {
        failures.push(
          buildManualErrorRow({
            seq: "RM&RF",
            record: recNo,
            bomId,
            item,
            field: "engineeringChange.ecNumber",
            fallbackValidation: "Engineering Change Number is required",
            fallbackErrorDetails:
              `Record ${recNo}: engineeringChange.ecNumber is required.`,
            fallbackRemediationMessage:
              "Provide engineeringChange.ecNumber and resubmit.",
          })
        );
      }

      if (isBlank(record.engineeringChange.creationDate)) {
        failures.push(
          buildManualErrorRow({
            seq: "RM&RF",
            record: recNo,
            bomId,
            item,
            field: "engineeringChange.creationDate",
            fallbackValidation: "Engineering Change Creation Date is required",
            fallbackErrorDetails:
              `Record ${recNo}: engineeringChange.creationDate is required.`,
            fallbackRemediationMessage:
              "Provide engineeringChange.creationDate in valid format and resubmit.",
          })
        );
      }
    }

    if (!record?.producedItem || typeof record.producedItem !== "object") {
      failures.push(
        buildManualErrorRow({
          seq: "RM&RF",
          record: recNo,
          bomId,
          field: "producedItem",
          fallbackValidation: "Produced Item is required",
          fallbackErrorDetails: `Record ${recNo}: producedItem is required.`,
          fallbackRemediationMessage:
            "Provide producedItem object with required fields.",
        })
      );
    } else {
      if (isBlank(record.producedItem.item)) {
        failures.push(
          buildManualErrorRow({
            seq: "RM&RF",
            record: recNo,
            bomId,
            field: "producedItem.item",
            fallbackValidation: "Produced Item Code is required",
            fallbackErrorDetails:
              `Record ${recNo}: producedItem.item is required.`,
            fallbackRemediationMessage:
              "Provide producedItem.item and resubmit.",
          })
        );
      }

      if (isBlank(record.producedItem.status)) {
        failures.push(
          buildManualErrorRow({
            seq: "RM&RF",
            record: recNo,
            bomId,
            item,
            field: "producedItem.status",
            fallbackValidation: "Produced Item Status is required",
            fallbackErrorDetails:
              `Record ${recNo}: producedItem.status is required.`,
            fallbackRemediationMessage:
              "Provide producedItem.status and resubmit.",
          })
        );
      }
    }

    if (!Array.isArray(locations) || locations.length === 0) {
      failures.push(
        buildManualErrorRow({
          seq: "RM&RF",
          record: recNo,
          bomId,
          item,
          field: "locations",
          fallbackValidation: "At least one location is required",
          fallbackErrorDetails:
            `Record ${recNo}: at least one location is required.`,
          fallbackRemediationMessage:
            "Add at least one location entry.",
        })
      );
      return;
    }

    /* -----------------------------------------------------
       Location-level validations
    ----------------------------------------------------- */
    locations.forEach((loc, locIndex) => {
      const locNo = locIndex + 1;
      const locationId = normalizeText(loc?.locationId);
      const locationName = normalizeText(loc?.locationName);
      const locationStatus = normalizeText(loc?.locationStatus);
      const locationLabel = locationId || locationName || `Location ${locNo}`;

      const resourceInfoList = ensureArray(loc?.resourceInfo);
      const flags = loc?.flags || {};
      const componentItems = ensureArray(loc?.componentItems);
      const coProducts = ensureArray(loc?.coProducts);

      if (isBlank(locationId) && isBlank(locationName)) {
        failures.push(
          buildManualErrorRow({
            seq: "RM&RF",
            record: recNo,
            bomId,
            item,
            location: locationLabel,
            field: "locationId/locationName",
            fallbackValidation: "Location ID or Location Name is required",
            fallbackErrorDetails:
              `Record ${recNo}, Location ${locNo}: locationId or locationName is required.`,
            fallbackRemediationMessage:
              "Provide either locationId or locationName.",
          })
        );
      }

      if (isBlank(locationStatus)) {
        failures.push(
          buildManualErrorRow({
            seq: "RM&RF",
            record: recNo,
            bomId,
            item,
            location: locationLabel,
            field: "locationStatus",
            fallbackValidation: "Location Status is required",
            fallbackErrorDetails:
              `Record ${recNo}, Location ${locNo}: locationStatus is required.`,
            fallbackRemediationMessage:
              "Provide locationStatus and resubmit.",
          })
        );
      }

      if (resourceInfoList.length === 0) {
        failures.push(
          buildManualErrorRow({
            seq: "RM&RF",
            record: recNo,
            bomId,
            item,
            location: locationLabel,
            field: "resourceInfo",
            fallbackValidation: "At least one Resource is required",
            fallbackErrorDetails:
              `Record ${recNo}, Location ${locNo}: at least one resourceInfo entry is required.`,
            fallbackRemediationMessage:
              "Add at least one selected resource for the location.",
          })
        );
      }

      resourceInfoList.forEach((resourceInfo, resourceIndex) => {
        const resourceNo = resourceIndex + 1;
        const routingId = normalizeText(resourceInfo?.routingId);
        const priority = toNumber(resourceInfo?.priority);

        if (isBlank(resourceInfo?.resource)) {
          failures.push(
            buildManualErrorRow({
              seq: "RM&RF",
              record: recNo,
              bomId,
              item,
              location: locationLabel,
              routingId,
              field: "resourceInfo.resource",
              fallbackValidation: "Resource is required",
              fallbackErrorDetails:
                `Record ${recNo}, Location ${locNo}, Resource ${resourceNo}: resourceInfo.resource is required.`,
              fallbackRemediationMessage:
                "Provide resourceInfo.resource.",
            })
          );
        }

        if (isBlank(resourceInfo?.resourceRelevancy)) {
          failures.push(
            buildManualErrorRow({
              seq: "RM&RF",
              record: recNo,
              bomId,
              item,
              location: locationLabel,
              routingId,
              field: "resourceInfo.resourceRelevancy",
              fallbackValidation: "Resource Relevancy is required",
              fallbackErrorDetails:
                `Record ${recNo}, Location ${locNo}, Resource ${resourceNo}: resourceInfo.resourceRelevancy is required.`,
              fallbackRemediationMessage:
                "Provide resourceInfo.resourceRelevancy.",
            })
          );
        }

        if (isBlank(resourceInfo?.bomVersion)) {
          failures.push(
            buildManualErrorRow({
              seq: "RM&RF",
              record: recNo,
              bomId,
              item,
              location: locationLabel,
              routingId,
              field: "resourceInfo.bomVersion",
              fallbackValidation: "BOM Version is required",
              fallbackErrorDetails:
                `Record ${recNo}, Location ${locNo}, Resource ${resourceNo}: resourceInfo.bomVersion is required.`,
              fallbackRemediationMessage:
                "Provide resourceInfo.bomVersion.",
            })
          );
        }

        if (isBlank(resourceInfo?.routingId)) {
          failures.push(
            buildManualErrorRow({
              seq: "RM&RF",
              record: recNo,
              bomId,
              item,
              location: locationLabel,
              field: "resourceInfo.routingId",
              fallbackValidation: "Routing ID is required",
              fallbackErrorDetails:
                `Record ${recNo}, Location ${locNo}, Resource ${resourceNo}: resourceInfo.routingId is required.`,
              fallbackRemediationMessage:
                "Provide resourceInfo.routingId.",
            })
          );
        }

        if (!isNonNegativeNumber(priority)) {
          failures.push(
            buildManualErrorRow({
              seq: 1021,
              record: recNo,
              bomId,
              item,
              location: locationLabel,
              routingId,
              field: "resourceInfo.priority",
              values: {
                value: resourceInfo?.priority ?? "",
                bom_id: bomId || "",
              },
              fallbackValidation: "Routing Priority must be a valid integer",
              fallbackErrorDetails:
                `Record ${recNo}, Location ${locNo}, Resource ${resourceNo}: resourceInfo.priority must be a number >= 0.`,
              fallbackRemediationMessage:
                "Set resourceInfo.priority to a valid whole number greater than or equal to 0.",
            })
          );
        } else if (!isIntegerNumber(priority)) {
          failures.push(
            buildManualErrorRow({
              seq: 1021,
              record: recNo,
              bomId,
              item,
              location: locationLabel,
              routingId,
              field: "resourceInfo.priority",
              values: {
                value: resourceInfo?.priority ?? "",
                bom_id: bomId || "",
              },
              fallbackValidation: "Routing Priority must be an integer",
              fallbackErrorDetails:
                `Record ${recNo}, Location ${locNo}, Resource ${resourceNo}: resourceInfo.priority must be an integer.`,
              fallbackRemediationMessage:
                "Set resourceInfo.priority to a whole number.",
            })
          );
        }
      });

      /* -----------------------------------------------------
         Component item validations
      ----------------------------------------------------- */
      if (flags.noComponentItems !== true && componentItems.length === 0) {
        failures.push(
          buildManualErrorRow({
            seq: "RM&RF",
            record: recNo,
            bomId,
            item,
            location: locationLabel,
            field: "componentItems",
            fallbackValidation: "Component Items are required",
            fallbackErrorDetails:
              `Record ${recNo}, Location ${locNo}: componentItems are required when flags.noComponentItems is false.`,
            fallbackRemediationMessage:
              "Add componentItems or set flags.noComponentItems = true if applicable.",
          })
        );
      }

      componentItems.forEach((comp, compIndex) => {
        const compNo = compIndex + 1;

        if (isBlank(comp?.componentItem)) {
          failures.push(
            buildManualErrorRow({
              seq: "RM&RF",
              record: recNo,
              bomId,
              item,
              location: locationLabel,
              field: "componentItems.componentItem",
              fallbackValidation: "Component Item is required",
              fallbackErrorDetails:
                `Record ${recNo}, Location ${locNo}, Component ${compNo}: componentItem is required.`,
              fallbackRemediationMessage:
                "Provide componentItems.componentItem.",
            })
          );
        }

        if (!isPositiveNumber(comp?.standardUsage)) {
          failures.push(
            buildManualErrorRow({
              seq: 1010,
              record: recNo,
              bomId,
              item,
              location: locationLabel,
              field: "componentItems.standardUsage",
              values: {
                value: comp?.standardUsage ?? "",
                item: comp?.componentItem ?? "",
                location: locationLabel,
                bom_id: bomId || "",
              },
              fallbackValidation: "Standard Usage must be greater than 0",
              fallbackErrorDetails:
                `Record ${recNo}, Location ${locNo}, Component ${compNo}: standardUsage must be > 0.`,
              fallbackRemediationMessage:
                "Set componentItems.standardUsage to a number greater than 0.",
            })
          );
        }
      });

      /* -----------------------------------------------------
         Co-product validations
      ----------------------------------------------------- */
      if (flags.isCoProduct === true && coProducts.length === 0) {
        failures.push(
          buildManualErrorRow({
            seq: 1008,
            record: recNo,
            bomId,
            item,
            location: locationLabel,
            field: "coProducts",
            values: {
              value: "",
              item,
              location: locationLabel,
              bom_id: bomId || "",
            },
            fallbackValidation: "Co-Product Items are required",
            fallbackErrorDetails:
              `Record ${recNo}, Location ${locNo}: coProducts are required when flags.isCoProduct is true.`,
            fallbackRemediationMessage:
              "Add at least one co-product item or turn off the Produced Co-Product flag.",
          })
        );
      }

      if (coProducts.length > 0) {
        if (flags.isCoProduct !== true) {
          failures.push(
            buildManualErrorRow({
              seq: "RM&RF",
              record: recNo,
              bomId,
              item,
              location: locationLabel,
              field: "flags.isCoProduct",
              fallbackValidation: "Produced Co-Product flag must be true",
              fallbackErrorDetails:
                `Record ${recNo}, Location ${locNo}: flags.isCoProduct must be true when coProducts exist.`,
              fallbackRemediationMessage:
                "Set flags.isCoProduct = true when coProducts are provided.",
            })
          );
        }

        let hasQtyProducedPerLessThanOne = false;

        coProducts.forEach((cp, cpIndex) => {
          const cpNo = cpIndex + 1;
          const qtyProducedPer = toNumber(cp?.qtyProducedPer);

          if (isBlank(cp?.coProductItem)) {
            failures.push(
              buildManualErrorRow({
                seq: "RM&RF",
                record: recNo,
                bomId,
                item,
                location: locationLabel,
                field: "coProducts.coProductItem",
                fallbackValidation: "Co-Product Item is required",
                fallbackErrorDetails:
                  `Record ${recNo}, Location ${locNo}, CoProduct ${cpNo}: coProductItem is required.`,
                fallbackRemediationMessage:
                  "Provide coProducts.coProductItem.",
              })
            );
          }

          if (!(typeof qtyProducedPer === "number" && qtyProducedPer > 0 && qtyProducedPer < 1)) {
            failures.push(
              buildManualErrorRow({
                seq: 1008,
                record: recNo,
                bomId,
                item,
                location: locationLabel,
                field: "coProducts.qtyProducedPer",
                values: {
                  value: cp?.qtyProducedPer ?? "",
                  item: cp?.coProductItem ?? "",
                  location: locationLabel,
                  bom_id: bomId || "",
                },
                fallbackValidation:
                  "Co-Product Qty Produced must be greater than 0 and less than 1",
                fallbackErrorDetails:
                  `Record ${recNo}, Location ${locNo}, CoProduct ${cpNo}: qtyProducedPer must be > 0 and < 1.`,
                fallbackRemediationMessage:
                  "Set coProducts.qtyProducedPer to a number greater than 0 and less than 1.",
              })
            );
          }

          if (typeof qtyProducedPer === "number" && qtyProducedPer < 1) {
            hasQtyProducedPerLessThanOne = true;
          }
        });

        if (!hasQtyProducedPerLessThanOne) {
          failures.push(
            buildManualErrorRow({
              seq: 1008,
              record: recNo,
              bomId,
              item,
              location: locationLabel,
              field: "coProducts.qtyProducedPer",
              values: {
                value: "",
                item,
                location: locationLabel,
                bom_id: bomId || "",
              },
              fallbackValidation:
                "At least one Co-Product Qty Produced must be less than 1",
              fallbackErrorDetails:
                `Record ${recNo}, Location ${locNo}: at least one coProduct qtyProducedPer must be < 1.`,
              fallbackRemediationMessage:
                "Ensure at least one coProduct has qtyProducedPer less than 1.",
            })
          );
        }
      }
    });
  });

  const errorCodes = [
    ...new Set(
      failures.flatMap((row) =>
        ensureArray(row?.messages).map((msg) => msg?.validationSequence).filter(Boolean)
      )
    ),
  ];

  return {
    isValid: failures.length === 0,
    errorCodes,
    errorList: failures,
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

  const extractedRecords = extractRecords(payload);
  const ecNumber =
    Array.isArray(extractedRecords) && extractedRecords[0]?.engineeringChange?.ecNumber
      ? extractedRecords[0].engineeringChange.ecNumber
      : `EC${Math.floor(1000000 + Math.random() * 9000000)}`;

  try {
    const inputMode = detectInputMode(payload);
    let validation;

    // =====================================================
    // MANUAL ENTRY FLOW (FIXED FOR SUMMARY PAGE)
    // =====================================================
    if (inputMode === "manual") {
      validation = validateManualEntry(payload);

      if (validation.isValid) {
        return res.status(200).json({
          status: "success",
          message: "Validation successful",
          ecNumber,
        });
      }

      const remediationDetails = validation.errorList.flatMap((row) =>
        ensureArray(row?.messages).map((msg) => ({
          record: row?.csvRecId ?? null,
          location: row?.location ?? null,
          component: null,
          coProduct: null,
          field: row?.field ?? null,
          remediation: msg?.remediationMessage || "",
        }))
      );

      const reportFile = generateFailureReport({
        REPORT_DIR,
        errorList: validation.errorList,
        ecNumber,
        reportNameBase,
        validation,
      });

      return res.status(400).json({
        status: "failure",
        message: "Validation failed",
        reportFile,
        ecNumber,
        errors: validation.errorCodes,
        errorList: validation.errorList,
        errorDetails: validation.errorList,
        remediationDetails,
      });
    }

    // =====================================================
    // EXISTING CSV / GCP FLOW (UNCHANGED)
    // =====================================================
    validation = await validateWithGCP(payload);

    if (validation.isValid) {
      return res.status(200).json({
        status: "success",
        message: "Validation successful",
        ecNumber,
      });
    }

    const normalized = normalizeValidationForUI(validation);

    const reportFile = generateFailureReport({
      REPORT_DIR,
      errorList: normalized.errorList,
      ecNumber,
      reportNameBase,
      validation,
    });

    return res.status(400).json({
      status: "failure",
      message: "Validation failed",
      reportFile,
      ecNumber,
      errors: normalized.errorCodes,
      errorList: normalized.errorList,
      errorDetails: normalized.errorDetails,
      remediationDetails: normalized.remediationDetails,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({
      status: "failure",
      message: err.message || "Internal server error",
      errorDetails: err.errorDetails || [],
      remediationDetails: err.remediationDetails || [],
    });
  }
});

export default router;
