import { validationRules } from "../postgres/ValidationRules.js";

/* =========================================================
   Helpers
========================================================= */
const norm = (v) => String(v ?? "").trim();
const ensureArray = (v) => (Array.isArray(v) ? v : []);
const toNum = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const isInt = (v) => Number.isInteger(Number(v));

const applyTemplate = (template, values = {}) => {
  let out = String(template || "");
  const map = {};
  Object.entries(values || {}).forEach(([k, v]) => {
    map[String(k).toLowerCase()] = v;
  });
  return out.replace(/<([^>]+)>/g, (_, key) => {
    return map[String(key).toLowerCase()] ?? "";
  });
};

const buildMessage = ({
  seq,
  values = {},
  fallbackValidation = "",
  fallbackErrorDetails = "",
  fallbackRemediationMessage = "",
}) => {
  const rule = validationRules?.[seq] || {};
  const validation =
    applyTemplate(rule?.desc || "", values) || fallbackValidation || "";
  const errorDetails =
    applyTemplate(rule?.error || "", values) || fallbackErrorDetails || "";
  const remediationMessage =
    applyTemplate(rule?.rm || "", values) ||
    fallbackRemediationMessage ||
    "";

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
};

const buildErrorRow = ({
  table = "MANUAL_ENTRY",
  record = null,
  bomId = "",
  item = "",
  location = "",
  routingId = "",
  field = "",
  seq,
  values = {},
  fallbackValidation = "",
  fallbackErrorDetails = "",
  fallbackRemediationMessage = "",
}) => ({
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
    buildMessage({
      seq,
      values,
      fallbackValidation,
      fallbackErrorDetails,
      fallbackRemediationMessage,
    }),
  ],
});

/* =========================================================
   Summary payload -> normalized table arrays
========================================================= */
export function convertSummaryPayloadToTables(payload) {
  const records = Array.isArray(payload?.records) ? payload.records : [];

  const bom_parameters = [];
  const bom_produced = [];
  const bom_consumed = [];
  const item_bom_routing = [];

  records.forEach((record, recordIndex) => {
    const recNo = recordIndex + 1;
    const bomId = norm(record?.bomId);
    const producedItem = norm(record?.producedItem?.item);
    const locations = ensureArray(record?.locations);

    if (!bomId) return;

    bom_parameters.push({
      recordNo: recNo,
      bom_id: bomId,
      produced_item: producedItem,
    });

    locations.forEach((loc, locIndex) => {
      const locNo = locIndex + 1;
      const location =
        norm(loc?.locationId) || norm(loc?.locationName) || `Location ${locNo}`;
      const flags = loc?.flags || {};
      const componentItems = ensureArray(loc?.componentItems);
      const coProducts = ensureArray(loc?.coProducts);
      const resourceInfo = ensureArray(loc?.resourceInfo);

      // Main produced row
      bom_produced.push({
        recordNo: `${recNo}.${locNo}`,
        bom_id: bomId,
        item: producedItem,
        location,
        erp_bom_qty_produced_per: 1,
        is_coproduct: false,
        source: "MAIN",
      });

      // Co-products
      coProducts.forEach((cp, cpIndex) => {
        bom_produced.push({
          recordNo: `${recNo}.${locNo}.CP${cpIndex + 1}`,
          bom_id: bomId,
          item: norm(cp?.coProductItem),
          location,
          erp_bom_qty_produced_per: toNum(cp?.qtyProducedPer),
          is_coproduct: true,
          source: "COPRODUCT",
        });
      });

      // Components -> consumed
      componentItems.forEach((comp, compIndex) => {
        bom_consumed.push({
          recordNo: `${recNo}.${locNo}.C${compIndex + 1}`,
          bom_id: bomId,
          item: norm(comp?.componentItem),
          location,
          erp_bom_quantity_consumed_per: toNum(comp?.standardUsage),
          co_product_flag: false,
        });
      });

      // Routing
      resourceInfo.forEach((res, resIndex) => {
        item_bom_routing.push({
          recordNo: `${recNo}.${locNo}.R${resIndex + 1}`,
          bom_id: bomId,
          item: producedItem,
          location,
          routing_id: norm(res?.routingId),
          priority: toNum(res?.priority),
          erp_co_product_association:
            toNum(res?.coProductAssociation) ??
            (flags?.isCoProduct ? 1 : 0),
        });
      });
    });
  });

  return {
    bom_parameters,
    bom_produced,
    bom_consumed,
    item_bom_routing,
  };
}

/* =========================================================
   DB helpers for duplicate checks
========================================================= */
async function fetchExistingBomIds(pool, tableName, bomIds = []) {
  if (!Array.isArray(bomIds) || bomIds.length === 0) return new Set();

  const sql = `
    SELECT DISTINCT TRIM(CAST(bom_id AS TEXT)) AS bom_id
    FROM ${tableName}
    WHERE TRIM(CAST(bom_id AS TEXT)) = ANY($1)
  `;

  const result = await pool.query(sql, [bomIds.map((x) => norm(x)).filter(Boolean)]);
  return new Set(result.rows.map((r) => norm(r.bom_id)).filter(Boolean));
}

/* =========================================================
   Main manual validator
========================================================= */
export async function validateManualEntryPayload(payload, pool) {
  const tables = convertSummaryPayloadToTables(payload);

  const params = tables.bom_parameters;
  const produced = tables.bom_produced;
  const consumed = tables.bom_consumed;
  const routing = tables.item_bom_routing;

  const failures = [];

  const bomIdsParams = [...new Set(params.map((x) => norm(x.bom_id)).filter(Boolean))];
  const bomIdsProduced = [...new Set(produced.map((x) => norm(x.bom_id)).filter(Boolean))];
  const bomIdsConsumed = [...new Set(consumed.map((x) => norm(x.bom_id)).filter(Boolean))];
  const bomIdsRouting = [...new Set(routing.map((x) => norm(x.bom_id)).filter(Boolean))];

  const paramsSet = new Set(bomIdsParams);
  const producedSet = new Set(bomIdsProduced);
  const routingSet = new Set(bomIdsRouting);

  // Existing duplicate checks in Postgre
  const [existingParams, existingProduced] = await Promise.all([
    fetchExistingBomIds(pool, "bom_parameters", bomIdsParams),
    fetchExistingBomIds(pool, "bom_produced", bomIdsProduced),
  ]);

  /* ======================================================
     1001: BOM_PARAMETERS bom_id must exist in produced + routing
  ====================================================== */
  for (const p of params) {
    const b = norm(p.bom_id);
    if (!b) continue;

    const hasProduced = producedSet.has(b);
    const hasRouting = routingSet.has(b);

    if (!hasProduced || !hasRouting) {
      failures.push(
        buildErrorRow({
          table: "BOM_PARAMETERS",
          record: p.recordNo,
          bomId: b,
          seq: 1001,
          values: {
            value: b,
            "value/Values": b,
            producedExists: hasProduced,
            routingExists: hasRouting,
            bom_id: b,
          },
          fallbackValidation:
            "Check if BOMID in BOM_PARAMETERS exists in BOM_PRODUCED and ITEM_BOM_ROUTING",
          fallbackErrorDetails: `BOM ID "${b}" is missing in ${
            !hasProduced && !hasRouting
              ? "BOM_PRODUCED and ITEM_BOM_ROUTING"
              : !hasProduced
                ? "BOM_PRODUCED"
                : "ITEM_BOM_ROUTING"
          }.`,
          fallbackRemediationMessage:
            "Ensure the same BOM ID exists in BOM_PRODUCED and ITEM_BOM_ROUTING.",
        })
      );
    }
  }

  /* ======================================================
     1002: BOM_PARAMETERS duplicate
  ====================================================== */
  {
    const seen = new Set();
    for (const p of params) {
      const b = norm(p.bom_id);
      if (!b) continue;

      if (seen.has(b) || existingParams.has(b)) {
        failures.push(
          buildErrorRow({
            table: "BOM_PARAMETERS",
            record: p.recordNo,
            bomId: b,
            seq: 1002,
            values: { value: b, bom_id: b },
            fallbackValidation: "Duplicate BOMID in BOM_PARAMETERS",
            fallbackErrorDetails: `Duplicate BOM ID "${b}" found in BOM_PARAMETERS.`,
            fallbackRemediationMessage:
              "Use a unique BOM ID that does not already exist.",
          })
        );
      }
      seen.add(b);
    }
  }

  /* ======================================================
     1005: BOM_PRODUCED bom_id must exist in params + routing
  ====================================================== */
  for (const pr of produced) {
    const b = norm(pr.bom_id);
    if (!b) continue;

    const hasParams = paramsSet.has(b);
    const hasRouting = routingSet.has(b);

    if (!hasParams || !hasRouting) {
      failures.push(
        buildErrorRow({
          table: "BOM_PRODUCED",
          record: pr.recordNo,
          bomId: b,
          item: pr.item,
          location: pr.location,
          seq: 1005,
          values: {
            value: b,
            paramsExists: hasParams,
            routingExists: hasRouting,
            item: pr.item,
            location: pr.location,
            bom_id: b,
          },
          fallbackValidation:
            "Check if BOMID in BOM_PRODUCED exists in BOM_PARAMETERS and ITEM_BOM_ROUTING",
          fallbackErrorDetails: `BOM ID "${b}" is missing in ${
            !hasParams && !hasRouting
              ? "BOM_PARAMETERS and ITEM_BOM_ROUTING"
              : !hasParams
                ? "BOM_PARAMETERS"
                : "ITEM_BOM_ROUTING"
          }.`,
          fallbackRemediationMessage:
            "Ensure the same BOM ID exists in BOM_PARAMETERS and ITEM_BOM_ROUTING.",
        })
      );
    }
  }

  /* ======================================================
     1006/1007/1008/1009: BOM_PRODUCED rules
  ====================================================== */
  {
    const byBom = new Map();
    for (const pr of produced) {
      const b = norm(pr.bom_id);
      if (!b) continue;
      if (!byBom.has(b)) byBom.set(b, []);
      byBom.get(b).push(pr);
    }

    for (const [bomId, rows] of byBom.entries()) {
      // duplicate in DB
      if (existingProduced.has(bomId)) {
        rows.forEach((pr) => {
          failures.push(
            buildErrorRow({
              table: "BOM_PRODUCED",
              record: pr.recordNo,
              bomId,
              item: pr.item,
              location: pr.location,
              seq: 1006,
              values: { value: bomId, bom_id: bomId },
              fallbackValidation: "Duplicate BOMID in BOM_PRODUCED",
              fallbackErrorDetails: `BOM ID "${bomId}" already exists in BOM_PRODUCED.`,
              fallbackRemediationMessage:
                "Use a new BOM ID or modify the existing BOM through modify flow.",
            })
          );
        });
      }

      const mainRows = rows.filter(
        (r) => Number(r.erp_bom_qty_produced_per) === 1 && !r.is_coproduct
      );
      const coRows = rows.filter((r) => r.is_coproduct);

      if (mainRows.length !== 1) {
        rows.forEach((pr) => {
          failures.push(
            buildErrorRow({
              table: "BOM_PRODUCED",
              record: pr.recordNo,
              bomId,
              item: pr.item,
              location: pr.location,
              seq: 1007,
              values: {
                value: bomId,
                item: pr.item,
                location: pr.location,
                bom_id: bomId,
              },
              fallbackValidation:
                "Exactly one main produced item must have Qty Produced Per = 1",
              fallbackErrorDetails: `BOM ID "${bomId}" must contain exactly one main produced item with Qty Produced Per = 1.`,
              fallbackRemediationMessage:
                "Keep one main produced row with Qty Produced Per = 1 and all co-products less than 1.",
            })
          );
        });
      }

      // co-product rows need qty > 0 and < 1
      for (const pr of coRows) {
        const q = toNum(pr.erp_bom_qty_produced_per);
        if (!(q > 0 && q < 1)) {
          failures.push(
            buildErrorRow({
              table: "BOM_PRODUCED",
              record: pr.recordNo,
              bomId,
              item: pr.item,
              location: pr.location,
              seq: 1008,
              values: {
                value: pr.erp_bom_qty_produced_per,
                item: pr.item,
                location: pr.location,
                bom_id: bomId,
              },
              fallbackValidation:
                "Co-product quantity produced per must be greater than 0 and less than 1",
              fallbackErrorDetails: `Co-product "${pr.item}" for BOM "${bomId}" must have Qty Produced Per > 0 and < 1.`,
              fallbackRemediationMessage:
                "Enter a co-product quantity produced per between 0 and 1.",
            })
          );
        }
      }

      // main row must exist if any co-product exists
      if (coRows.length > 0 && mainRows.length === 0) {
        coRows.forEach((pr) => {
          failures.push(
            buildErrorRow({
              table: "BOM_PRODUCED",
              record: pr.recordNo,
              bomId,
              item: pr.item,
              location: pr.location,
              seq: 1009,
              values: {
                value: pr.item,
                location: pr.location,
                bom_id: bomId,
              },
              fallbackValidation:
                "Co-product BOM must also contain one main produced record",
              fallbackErrorDetails: `BOM "${bomId}" has co-product rows but no main produced row with Qty Produced Per = 1.`,
              fallbackRemediationMessage:
                "Add one main produced row for the BOM with Qty Produced Per = 1.",
            })
          );
        });
      }
    }
  }

  /* ======================================================
     1010: BOM_CONSUMED quantity > 0
  ====================================================== */
  for (const c of consumed) {
    const q = toNum(c.erp_bom_quantity_consumed_per);
    if (!(q > 0)) {
      failures.push(
        buildErrorRow({
          table: "BOM_CONSUMED",
          record: c.recordNo,
          bomId: c.bom_id,
          item: c.item,
          location: c.location,
          seq: 1010,
          values: {
            value: c.erp_bom_quantity_consumed_per,
            item: c.item,
            location: c.location,
            bom_id: c.bom_id,
          },
          fallbackValidation:
            "Consumed quantity per must be greater than 0",
          fallbackErrorDetails: `Consumed item "${c.item}" for BOM "${c.bom_id}" must have quantity > 0.`,
          fallbackRemediationMessage:
            "Enter a positive consumed quantity.",
        })
      );
    }
  }

  /* ======================================================
     1011: BOM_CONSUMED bom_id exists in produced
  ====================================================== */
  for (const c of consumed) {
    const b = norm(c.bom_id);
    if (!producedSet.has(b)) {
      failures.push(
        buildErrorRow({
          table: "BOM_CONSUMED",
          record: c.recordNo,
          bomId: b,
          item: c.item,
          location: c.location,
          seq: 1011,
          values: { value: b, item: c.item, location: c.location, bom_id: b },
          fallbackValidation:
            "Check if BOMID in BOM_CONSUMED exists in BOM_PRODUCED",
          fallbackErrorDetails: `Consumed row refers to BOM ID "${b}" which does not exist in BOM_PRODUCED.`,
          fallbackRemediationMessage:
            "Ensure the BOM ID exists in produced rows before adding consumed items.",
        })
      );
    }
  }

  /* ======================================================
     1012: Duplicate BOMID + consumed item
  ====================================================== */
  {
    const seen = new Set();
    for (const c of consumed) {
      const key = `${norm(c.bom_id)}__${norm(c.item)}`;
      if (seen.has(key)) {
        failures.push(
          buildErrorRow({
            table: "BOM_CONSUMED",
            record: c.recordNo,
            bomId: c.bom_id,
            item: c.item,
            location: c.location,
            seq: 1012,
            values: {
              value: c.bom_id,
              item: c.item,
              location: c.location,
              bom_id: c.bom_id,
            },
            fallbackValidation:
              "Duplicate combination of BOMID and consumed item",
            fallbackErrorDetails: `Duplicate consumed item "${c.item}" found for BOM "${c.bom_id}".`,
            fallbackRemediationMessage:
              "Remove duplicate consumed item rows for the same BOM.",
          })
        );
      }
      seen.add(key);
    }
  }

  /* ======================================================
     1013: Recursive consumption
  ====================================================== */
  for (const c of consumed) {
    const producedItemForBom =
      produced.find(
        (p) =>
          norm(p.bom_id) === norm(c.bom_id) &&
          Number(p.erp_bom_qty_produced_per) === 1 &&
          !p.is_coproduct
      )?.item || "";

    if (
      producedItemForBom &&
      norm(producedItemForBom).toUpperCase() === norm(c.item).toUpperCase()
    ) {
      failures.push(
        buildErrorRow({
          table: "BOM_CONSUMED",
          record: c.recordNo,
          bomId: c.bom_id,
          item: c.item,
          location: c.location,
          seq: 1013,
          values: {
            value: c.item,
            bomid: c.bom_id,
            bom_id: c.bom_id,
            location: c.location,
          },
          fallbackValidation:
            "Produced item cannot be consumed recursively in the same BOM",
          fallbackErrorDetails: `Consumed item "${c.item}" is the same as the main produced item for BOM "${c.bom_id}".`,
          fallbackRemediationMessage:
            "Remove recursive consumption from the BOM.",
        })
      );
    }
  }

  /* ======================================================
     1018/1019/1020/1021: routing rules
  ====================================================== */
  for (const rt of routing) {
    const b = norm(rt.bom_id);
    const inParams = paramsSet.has(b);
    const inProduced = producedSet.has(b);

    if (!inParams || !inProduced) {
      failures.push(
        buildErrorRow({
          table: "ITEM_BOM_ROUTING",
          record: rt.recordNo,
          bomId: b,
          item: rt.item,
          location: rt.location,
          routingId: rt.routing_id,
          seq: 1018,
          values: {
            value: b,
            "value/Values": b,
            paramsExists: inParams,
            producedExists: inProduced,
            item: rt.item,
            location: rt.location,
            bom_id: b,
          },
          fallbackValidation:
            "Check if BOMID in ITEM_BOM_ROUTING exists in BOM_PARAMETERS and BOM_PRODUCED",
          fallbackErrorDetails: `Routing row refers to BOM ID "${b}" which is missing in ${
            !inParams && !inProduced
              ? "BOM_PARAMETERS and BOM_PRODUCED"
              : !inParams
                ? "BOM_PARAMETERS"
                : "BOM_PRODUCED"
          }.`,
          fallbackRemediationMessage:
            "Ensure the same BOM ID exists in BOM_PARAMETERS and BOM_PRODUCED.",
        })
      );
    }

    if (!norm(rt.routing_id)) {
      failures.push(
        buildErrorRow({
          table: "ITEM_BOM_ROUTING",
          record: rt.recordNo,
          bomId: b,
          item: rt.item,
          location: rt.location,
          routingId: rt.routing_id,
          seq: 1019,
          values: {
            value: b,
            item: rt.item,
            routing_id: rt.routing_id,
            bom_id: b,
          },
          fallbackValidation: "Routing ID is required",
          fallbackErrorDetails: `Routing ID is blank for BOM "${b}".`,
          fallbackRemediationMessage:
            "Provide a routing ID for each routing row.",
        })
      );
    }

    if (rt.priority == null || !isInt(rt.priority)) {
      failures.push(
        buildErrorRow({
          table: "ITEM_BOM_ROUTING",
          record: rt.recordNo,
          bomId: b,
          item: rt.item,
          location: rt.location,
          routingId: rt.routing_id,
          seq: 1021,
          values: {
            value: rt.priority,
            bom_id: b,
          },
          fallbackValidation: "Routing priority must be an integer",
          fallbackErrorDetails: `Routing priority for BOM "${b}" and routing "${rt.routing_id}" must be an integer.`,
          fallbackRemediationMessage:
            "Enter a whole number for routing priority.",
        })
      );
    }
  }

  // 1019 duplicate item+bomid+routingid
  {
    const seen = new Set();
    for (const rt of routing) {
      const key = `${norm(rt.item)}__${norm(rt.bom_id)}__${norm(rt.routing_id)}`;
      if (seen.has(key)) {
        failures.push(
          buildErrorRow({
            table: "ITEM_BOM_ROUTING",
            record: rt.recordNo,
            bomId: rt.bom_id,
            item: rt.item,
            location: rt.location,
            routingId: rt.routing_id,
            seq: 1019,
            values: {
              value: rt.bom_id,
              item: rt.item,
              routing_id: rt.routing_id,
              bom_id: rt.bom_id,
            },
            fallbackValidation:
              "Duplicate combination of Item, BOMID and RoutingID",
            fallbackErrorDetails: `Duplicate routing row found for item "${rt.item}", BOM "${rt.bom_id}", routing "${rt.routing_id}".`,
            fallbackRemediationMessage:
              "Remove duplicate routing rows.",
          })
        );
      }
      seen.add(key);
    }
  }

  // 1020 duplicate bomid+priority
  {
    const seen = new Set();
    for (const rt of routing) {
      const key = `${norm(rt.bom_id)}__${String(rt.priority ?? "NULL")}`;
      if (seen.has(key)) {
        failures.push(
          buildErrorRow({
            table: "ITEM_BOM_ROUTING",
            record: rt.recordNo,
            bomId: rt.bom_id,
            item: rt.item,
            location: rt.location,
            routingId: rt.routing_id,
            seq: 1020,
            values: {
              value: rt.bom_id,
              erp_item_bom_routing_priority: rt.priority,
              bom_id: rt.bom_id,
            },
            fallbackValidation:
              "Duplicate priority for the same BOMID",
            fallbackErrorDetails: `Duplicate routing priority "${rt.priority}" found for BOM "${rt.bom_id}".`,
            fallbackRemediationMessage:
              "Use unique routing priorities within the BOM.",
          })
        );
      }
      seen.add(key);
    }
  }

  const errorCodes = [
    ...new Set(
      failures.flatMap((row) =>
        ensureArray(row?.messages).map((m) => m?.validationSequence).filter(Boolean)
      )
    ),
  ];

  return {
    isValid: failures.length === 0,
    errorCodes,
    errorList: failures,
    normalizedTables: tables,
  };
}