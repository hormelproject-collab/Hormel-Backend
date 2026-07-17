import appConfig from "../config/appConfig.js";
import { validationRules } from "../postgres/ValidationRules.js";

/* Helpers */
const norm = (v) => String(v ?? "").trim();
const ensureArray = (v) => (Array.isArray(v) ? v : []);
const toNum = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const isInt = (v) => Number.isInteger(Number(v));

const IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

const assertSafeIdentifier = (value, label) => {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`Missing identifier for ${label}`);
  if (!IDENTIFIER_REGEX.test(normalized)) {
    throw new Error(`Invalid SQL identifier for ${label}: ${normalized}`);
  }
  return normalized;
};

const quoteIdent = (value) => `"${String(value).replace(/"/g, '""')}"`;

const PG_SCHEMA = assertSafeIdentifier(
  appConfig.postgres.schema || "planning_bom",
  "postgres.schema"
);

const PG_TABLES = Object.freeze({
  bomParameters: assertSafeIdentifier(
    appConfig.postgres.tables.bomParameters,
    "postgres.tables.bomParameters"
  ),
  bomProduced: assertSafeIdentifier(
    appConfig.postgres.tables.bomProduced,
    "postgres.tables.bomProduced"
  ),
  itemBomRouting: assertSafeIdentifier(
    appConfig.postgres.tables.itemBomRouting,
    "postgres.tables.itemBomRouting"
  ),
});

const pgRef = (tableName) =>
  `${quoteIdent(PG_SCHEMA)}.${quoteIdent(
    assertSafeIdentifier(tableName, "postgres.table")
  )}`;

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
  table = "ITEM_BOM_ROUTING",
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
  recordId: `${table}__${record ?? "NULL"}__${bomId || "NULL"}__${
    item || ""
  }__${location || ""}__${routingId || ""}__${field || ""}`,
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

const buildRoutingId = (item, resource) => {
  const cleanItem = norm(item);
  const cleanResource = norm(resource);

  if (!cleanItem || !cleanResource) return "";

  return `ROUTING_${cleanItem}_${cleanResource}`;
};

const getResourceFromRoutingId = (routingId) => {
  const parts = String(routingId || "")
    .split("_")
    .map((p) => p.trim())
    .filter(Boolean);

  return parts.length >= 3 ? parts.slice(2).join("_") : "";
};

/* =========================================================
   Convert /item-bom-routing/create payload -> item_bom_routing rows only
========================================================= */
export function convertItemBomRoutingCreatePayloadToTables(payload = {}) {
  const {
    bomId = "",
    producedItem = "",
    location = "",
    resource = "",
    routingId = "",
    routingPriority = "",
    mainItem = {},
    addConnectedCoProduct = false,
    coProductItem = "",
    coProducts = [],
  } = payload || {};

  const resolvedMainItem = norm(mainItem?.item) || norm(producedItem);

  const resolvedResource =
    norm(resource) ||
    norm(mainItem?.resource) ||
    getResourceFromRoutingId(mainItem?.routingId || routingId);

  const resolvedRoutingId = buildRoutingId(resolvedMainItem, resolvedResource);

  const priority = toNum(routingPriority);

  const item_bom_routing = [];

  if (norm(bomId) && resolvedMainItem) {
    item_bom_routing.push({
      recordNo: "1",
      bom_id: norm(bomId),
      item: resolvedMainItem,
      location: norm(location),
      routing_id: resolvedRoutingId,
      resource: resolvedResource,
      priority,
      erp_co_product_association: null,
      source: "MAIN",
    });
  }

  const normalizedCoProducts = addConnectedCoProduct
    ? ensureArray(coProducts)
        .map((row) => ({
          coProductItem: norm(row?.coProductItem),
          qtyProduced: norm(row?.qtyProduced),
        }))
        .filter((row) => row.coProductItem)
    : [];

  if (
    addConnectedCoProduct &&
    normalizedCoProducts.length === 0 &&
    norm(coProductItem)
  ) {
    normalizedCoProducts.push({
      coProductItem: norm(coProductItem),
      qtyProduced: "",
    });
  }

  normalizedCoProducts.forEach((row, index) => {
    item_bom_routing.push({
      recordNo: `1.CP${index + 1}`,
      bom_id: norm(bomId),
      item: row.coProductItem,

      // IMPORTANT:
      // co-product must use same routing ID as main produced item.
      routing_id: resolvedRoutingId,

      location: norm(location),
      resource: resolvedResource,
      priority,
      erp_co_product_association: 1,
      source: "COPRODUCT",
    });
  });

  return {
    item_bom_routing,
  };
}

/* =========================================================
   DB helpers
========================================================= */
async function fetchExistingBomIds(pool, tableName, bomIds = []) {
  const ids = ensureArray(bomIds).map(norm).filter(Boolean);
  if (!ids.length) return new Set();

  const sql = `
    SELECT DISTINCT TRIM(CAST(bom_id AS TEXT)) AS bom_id
    FROM ${pgRef(tableName)}
    WHERE TRIM(CAST(bom_id AS TEXT)) = ANY($1)
  `;

  const result = await pool.query(sql, [ids]);
  return new Set(result.rows.map((r) => norm(r.bom_id)).filter(Boolean));
}

async function fetchExistingRoutingRows(pool, routingRows = []) {
  if (!ensureArray(routingRows).length) return [];

  const bomIds = [...new Set(routingRows.map((r) => norm(r.bom_id)).filter(Boolean))];

  if (!bomIds.length) return [];

  const sql = `
    SELECT
      TRIM(CAST(bom_id AS TEXT)) AS bom_id,
      TRIM(CAST(item AS TEXT)) AS item,
      TRIM(CAST(routing_id AS TEXT)) AS routing_id,
      erp_item_bom_routing_priority
    FROM ${pgRef(PG_TABLES.itemBomRouting)}
    WHERE TRIM(CAST(bom_id AS TEXT)) = ANY($1)
  `;

  const result = await pool.query(sql, [bomIds]);
  return result.rows || [];
}

/* =========================================================
   Main validator for /item-bom-routing/create
   Only ITEM_BOM_ROUTING validation.
========================================================= */
export async function validateItemBomRoutingCreatePayload(payload, pool) {
  const tables = convertItemBomRoutingCreatePayloadToTables(payload);
  const routing = tables.item_bom_routing;

  const failures = [];

  const bomIdsRouting = [
    ...new Set(routing.map((x) => norm(x.bom_id)).filter(Boolean)),
  ];

  const [existingParams, existingProduced, existingRoutingRows] =
    await Promise.all([
      fetchExistingBomIds(pool, PG_TABLES.bomParameters, bomIdsRouting),
      fetchExistingBomIds(pool, PG_TABLES.bomProduced, bomIdsRouting),
      fetchExistingRoutingRows(pool, routing),
    ]);

  const existingRoutingKeySet = new Set(
    existingRoutingRows.map(
      (row) =>
        `${norm(row.item).toUpperCase()}__${norm(row.bom_id).toUpperCase()}__${norm(
          row.routing_id
        ).toUpperCase()}`
    )
  );



  /* ======================================================
     1018: ITEM_BOM_ROUTING bom_id must exist in
           BOM_PARAMETERS and BOM_PRODUCED
  ====================================================== */
  for (const rt of routing) {
    const b = norm(rt.bom_id);
    const inParams = existingParams.has(b);
    const inProduced = existingProduced.has(b);

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
            "Ensure the BOM ID exists in BOM_PARAMETERS and BOM_PRODUCED before adding item BOM routing.",
        })
      );
    }
  }

  /* ======================================================
     1019: Routing ID required
  ====================================================== */
  for (const rt of routing) {
    const b = norm(rt.bom_id);

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
            "Provide a routing ID for each item BOM routing row.",
        })
      );
    }
  }

  /* ======================================================
     1021: Routing priority must be integer
  ====================================================== */
  for (const rt of routing) {
    const b = norm(rt.bom_id);

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

  /* ======================================================
     1019: Duplicate Item + BOMID + RoutingID
     Checks payload duplicates and existing PostgreSQL rows.
  ====================================================== */
  {
    const seen = new Set();

    for (const rt of routing) {
      const key = `${norm(rt.item).toUpperCase()}__${norm(
        rt.bom_id
      ).toUpperCase()}__${norm(rt.routing_id).toUpperCase()}`;

      if (seen.has(key) || existingRoutingKeySet.has(key)) {
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
              "Remove duplicate routing rows or choose a routing combination that does not already exist.",
          })
        );
      }

      seen.add(key);
    }
  }

    const errorCodes = [
    ...new Set(
      failures.flatMap((row) =>
        ensureArray(row?.messages)
          .map((m) => m?.validationSequence)
          .filter(Boolean)
      )
    ),
  ];

  return {
    isValid: failures.length === 0,
    valid: failures.length === 0,
    status: failures.length === 0 ? "success" : "failure",
    errorCodes,
    errorList: failures,
    validationErrors: failures,
    normalizedTables: tables,
  };
}