import bigquery from "./bigquery.js";

/**
 * validateWithGCP(payload)
 *
 * CSV upload payload expected:
 * {
 *   bom_parameters: [],
 *   bom_produced: [],
 *   bom_consumed: [],
 *   item_bom_routing: []
 * }
 *
 * CSV flow is fixed & prioritized.
 */

const assertEnv = (name, value) => {
  if (!value) throw new Error(`Missing env: ${name}`);
};

const envOr = (key, fallback) => (process.env[key] ? process.env[key] : fallback);
const qTbl = (project, dataset, tableName) => `\`${project}.${dataset}.${tableName}\``;

const norm = (v) => (v == null ? "" : String(v).trim());
const uniq = (arr) => [...new Set(arr)];

/**
 * ✅ CSV FIX:
 * - "" (empty) => null (NOT 0)
 * - undefined/null => null
 * - valid numeric strings => number
 */
const toNum = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const isInt = (v) => Number.isInteger(Number(v));

/**
 * ✅ CSV FIX:
 * Canonicalize header keys to survive:
 * - trailing spaces
 * - BOM \uFEFF
 * - zero width \u200B
 * - NBSP \u00A0
 * - underscores/spaces/casing differences
 */
const canonKey = (s) =>
  String(s ?? "")
    .normalize("NFKC")
    .replace(/[\uFEFF\u200B\u00A0]/g, " ") // BOM/ZWSP/NBSP
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const pick = (obj, keys) => {
  if (!obj) return "";
  const map = {};
  for (const k of Object.keys(obj)) map[canonKey(k)] = obj[k];

  for (const key of keys) {
    const v = map[canonKey(key)];
    if (v != null && String(v).trim() !== "") return v;
  }
  return "";
};

const key2 = (a, b) => `${norm(a)}__${norm(b)}`;
const key3 = (a, b, c) => `${norm(a)}__${norm(b)}__${norm(c)}`;
const key4 = (a, b, c, d) => `${norm(a)}__${norm(b)}__${norm(c)}__${norm(d)}`;

const deriveBomItem = (bomId) => {
  const id = norm(bomId);
  if (!id) return "";
  const parts = id.split("_");
  return parts.length >= 2 ? parts[parts.length - 2] : "";
};

const deriveBomLocation = (bomId) => {
  const id = norm(bomId);
  if (!id) return "";
  const parts = id.split("_");
  return parts.length >= 1 ? parts[parts.length - 1] : "";
};

const toBool = (v) => {
  if (v === true) return true;
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "y";
};

/**
 * Identify which CSV table an array of rows is (if user accidentally sends a rows array)
 */
const detectCsvArrayKind = (arr) => {
  const first = arr?.[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return null;

  const keys = Object.keys(first).map(canonKey);
  const has = (k) => keys.includes(canonKey(k));

  if (has("ERPBOMQuantityConsumedPer")) return "bom_consumed";
  if (has("ERPBOMQtyProducedPer") || has("ERPBOMQuantityProducedPer")) return "bom_produced";
  if (has("ProducedItem")) return "bom_parameters";
  if (has("RoutingID") || has("ERPItemBOMRoutingPriority")) return "item_bom_routing";

  return null;
};

function normalizeTablesFromPayload(payload) {
  // If payload is an array, try to detect which table it is
  if (Array.isArray(payload)) {
    const kind = detectCsvArrayKind(payload);
    if (kind) {
      return {
        bom_parameters: kind === "bom_parameters" ? payload : [],
        bom_produced: kind === "bom_produced" ? payload : [],
        bom_consumed: kind === "bom_consumed" ? payload : [],
        item_bom_routing: kind === "item_bom_routing" ? payload : [],
      };
    }
  }

  // CSV payload object
  const isObj = payload && typeof payload === "object" && !Array.isArray(payload);
  if (!isObj) return { bom_parameters: [], bom_produced: [], bom_consumed: [], item_bom_routing: [] };

  const bom_parameters = payload.bom_parameters ?? payload.parameters ?? [];
  const bom_produced = payload.bom_produced ?? payload.produced ?? [];
  const bom_consumed = payload.bom_consumed ?? payload.consumed ?? [];
  const item_bom_routing = payload.item_bom_routing ?? payload.routing ?? [];

  return {
    bom_parameters: Array.isArray(bom_parameters) ? bom_parameters : [],
    bom_produced: Array.isArray(bom_produced) ? bom_produced : [],
    bom_consumed: Array.isArray(bom_consumed) ? bom_consumed : [],
    item_bom_routing: Array.isArray(item_bom_routing) ? item_bom_routing : [],
  };
}

function normalizeRow(tableKey, row) {
  const bom_id = norm(pick(row, ["BOMID", "bom_id", "bomId", "BOM_ID", "BOM Id", "BOM", "bom"]));
  const item = norm(pick(row, ["Item", "item", "ITEM"]));
  const location = norm(pick(row, ["Location", "location", "LOC", "Plant", "PLANT"]));
  const routing_id = norm(pick(row, ["RoutingID", "routing_id", "routingId", "ROUTING_ID", "ROUTINGID"]));

const csvRecId = norm(
  pick(row, ["ERR_ID", "ERRID", "err_id", "errid", "ROW_NUMBER", "row_number", "ROWNUMBER", "rownumber"])
);

  const qtyProducedPer = toNum(
    pick(row, [
      "ERPBOMQtyProducedPer",
      "ERPBOMQuantityProducedPer",
      "QtyProducedPer",
      "qty_produced_per",
      "QuantityProducedPer",
      "QTY_PRODUCED_PER",
    ])
  );

  const getConsumedQty = (r) => {
    const direct =
      r?.ERPBOMQuantityConsumedPer ??
      r?.QtyConsumedPer ??
      r?.qtyConsumedPer ??
      r?.QuantityConsumedPer ??
      r?.qty_consumed_per ??
      r?.["Qty Consumed Per"] ??
      r?.["ERPBOM Quantity Consumed Per"];

    const n1 = toNum(direct);
    if (n1 != null) return n1;

    // fallback scan
    for (const k of Object.keys(r || {})) {
      const ck = String(k).replace(/\s+/g, "").toLowerCase();
      if (ck.includes("qtyconsumedper") || ck.includes("quantityconsumedper")) {
        const n2 = toNum(r[k]);
        if (n2 != null) return n2;
      }
    }
    return null;
  };

  const qtyConsumedPer = getConsumedQty(row);

  const priority = toNum(pick(row, ["ERPItemBOMRoutingPriority", "RoutingPriority", "priority", "Priority"]));

  const rawIsCo = pick(row, ["IsCoProduct", "is_coproduct", "CoProduct", "coproduct", "CoProductFlag", "co_product_flag"]);
  const flagIsCo = toBool(rawIsCo);

  const qtyImpliesCo = qtyProducedPer != null && qtyProducedPer > 0 && qtyProducedPer < 1;
  const is_coproduct = flagIsCo || qtyImpliesCo;

  if (tableKey === "BOM_PARAMETERS") {
    const produced_item =
      norm(pick(row, ["ProducedItem", "produced_item", "Produced_Item", "PRODUCED_ITEM"])) || item;
    return { bom_id, produced_item,csvRecId  };
  }

  if (tableKey === "BOM_PRODUCED") {
    return {
      bom_id,
      item,
      location: location || deriveBomLocation(bom_id),
      erp_bom_qty_produced_per: qtyProducedPer,
      is_coproduct,
      csvRecId 
    };
  }

  if (tableKey === "BOM_CONSUMED") {
    return {
      bom_id,
      item,
      location: location || deriveBomLocation(bom_id),
      erp_bom_quantity_consumed_per: qtyConsumedPer,
      co_product_flag: flagIsCo,
      csvRecId 
    };
  }

  // ITEM_BOM_ROUTING
  return {
    bom_id,
    item: item || deriveBomItem(bom_id),
    location: location || deriveBomLocation(bom_id),
    routing_id,
    priority,
    erp_co_product_association: toNum(pick(row, ["CoProductAssociation", "ERP_CoProductAssociation"])) ?? 0,
    csvRecId 
  };
}

export const validateWithGCP = async (payload) => {
  const PROJECT = process.env.GCP_PROJECT_ID;
  const DATASET = process.env.BQ_DATASET;

  assertEnv("GCP_PROJECT_ID", PROJECT);
  assertEnv("BQ_DATASET", DATASET);

  const TB_BOM_PARAMETERS = envOr("BQ_TABLE_BOM_PARAMETERS", "bom_parameters");
  const TB_BOM_PRODUCED = envOr("BQ_TABLE_BOM_PRODUCED", "bom_produced");
  const TB_BOM_CONSUMED = envOr("BQ_TABLE_BOM_CONSUMED", "bom_consumed");
  const TB_ITEM_BOM_ROUTING = envOr("BQ_TABLE_ITEM_BOM_ROUTING", "item_bom_routing");
  const TB_ITEM_MASTER = envOr("BQ_TABLE_ITEM_MASTER", "item_master");
  const TB_ROUTING_RESCONS = envOr("BQ_TABLE_ROUTING_RESCONS", "routing_rescons");
  const TB_RESOURCE_MASTER = envOr("BQ_TABLE_RESOURCE_MASTER", "resource_master");

  const { bom_parameters, bom_produced, bom_consumed, item_bom_routing } = normalizeTablesFromPayload(payload);

// ✅ Always inject ERR_ID based on array index (row 1 = header, so first data row = 2)
const addErrId = (rows = []) =>
  (rows || []).map((r, idx) => ({
    ...r,
    // if frontend already sent ERR_ID, keep it; else compute
    ERR_ID:
      (r?.ERR_ID ?? r?.err_id ?? r?.Err_ID ?? r?.row_number ?? r?.ROW_NUMBER) ??
      (idx + 2),
  }));
const reqBomParameters = addErrId(bom_parameters)
  .map((r) => normalizeRow("BOM_PARAMETERS", r))
  .filter((x) => x.bom_id);

const reqBomProduced = addErrId(bom_produced)
  .map((r) => normalizeRow("BOM_PRODUCED", r))
  .filter((x) => x.bom_id);

const reqBomConsumed = addErrId(bom_consumed)
  .map((r) => normalizeRow("BOM_CONSUMED", r))
  .filter((x) => x.bom_id);

const reqItemRouting = addErrId(item_bom_routing)
  .map((r) => normalizeRow("ITEM_BOM_ROUTING", r))
  .filter((x) => x.bom_id);

  const firstRowByTableBom = {
  BOM_PARAMETERS: new Map(),
  BOM_PRODUCED: new Map(),
  BOM_CONSUMED: new Map(),
  ITEM_BOM_ROUTING: new Map(),
};

const rememberFirstRow = (tableKey, rows) => {
  for (const r of rows) {
    const b = norm(r.bom_id);
    const id = norm(r.csvRecId);
    if (!b || !id) continue;
    if (!firstRowByTableBom[tableKey].has(b)) firstRowByTableBom[tableKey].set(b, id);
  }
};

rememberFirstRow("BOM_PARAMETERS", reqBomParameters);
rememberFirstRow("BOM_PRODUCED", reqBomProduced);
rememberFirstRow("BOM_CONSUMED", reqBomConsumed);
rememberFirstRow("ITEM_BOM_ROUTING", reqItemRouting);

  const validatedSet = {
    BOM_PARAMETERS: new Set(reqBomParameters.map((x) => x.bom_id)),
    BOM_PRODUCED: new Set(reqBomProduced.map((x) => x.bom_id)),
    BOM_CONSUMED: new Set(reqBomConsumed.map((x) => x.bom_id)),
    ITEM_BOM_ROUTING: new Set(reqItemRouting.map((x) => x.bom_id)),
  };

  const errorBomSet = {
    BOM_PARAMETERS: new Set(),
    BOM_PRODUCED: new Set(),
    BOM_CONSUMED: new Set(),
    ITEM_BOM_ROUTING: new Set(),
  };

  const errorRowSet = {
    BOM_PARAMETERS: new Set(),
    BOM_PRODUCED: new Set(),
    BOM_CONSUMED: new Set(),
    ITEM_BOM_ROUTING: new Set(),
  };

  const errorMap = {};

  // ---- GCP rec_id maps (unchanged) ----
  const gcpRecIds = {
    BOM_PARAMETERS: new Map(),
    BOM_PRODUCED: new Map(),
    BOM_CONSUMED: new Map(),
    ITEM_BOM_ROUTING: new Map(),
  };

  const addRecId = (tableKey, bomId, recId) => {
    const b = norm(bomId);
    if (!b || recId == null) return;
    if (!gcpRecIds[tableKey].has(b)) gcpRecIds[tableKey].set(b, new Set());
    gcpRecIds[tableKey].get(b).add(String(recId));
  };

  const getRecIdString = (tableKey, bomId) => {
    const b = norm(bomId);
    const set = gcpRecIds[tableKey]?.get(b);
    if (!set || set.size === 0) return "NULL";
    return [...set].join("\n");
  };

  const buildRecordId = (tableKey, ctx) => {
    const b = norm(ctx?.bom_id || ctx?.bomId);
    if (!b) return "NULL";

    if (tableKey === "BOM_PARAMETERS") return b;

    if (tableKey === "BOM_PRODUCED" || tableKey === "BOM_CONSUMED") {
      return key3(b, norm(ctx?.item) || "NULL", norm(ctx?.location) || "NULL");
    }

    return key4(b, norm(ctx?.item) || "NULL", norm(ctx?.location) || "NULL", norm(ctx?.routing_id) || "NULL");
  };

  /**
   * ✅ UPDATED addError:
   * Now stores structured validation info:
   * { seq: <Book1 Seq Num>, values: {...}, debug?: string }
   */
 const addError = (tableKey, ctxOrBomId, err) => {
  const ctx =
    typeof ctxOrBomId === "string"
      ? { bom_id: ctxOrBomId }
      : ctxOrBomId || {};

  const bomId = norm(ctx.bom_id || ctx.bomId) || "NULL";
  const item = norm(ctx.item);
  const location = norm(ctx.location);
  const routingId = norm(ctx.routing_id || ctx.routingId);

  const recordId = buildRecordId(tableKey, {
    bom_id: bomId,
    item,
    location,
    routing_id: routingId,
  });

  const key = `${tableKey}__${recordId}`;

  // ✅ ✅ GET CSV ROW NUMBER (PRIMARY + FALLBACK)
  const csvRecId =
    norm(ctx.csvRecId || ctx.ERR_ID) ||
    firstRowByTableBom?.[tableKey]?.get(bomId) ||
    "NULL";

  const errObj =
    typeof err === "string"
      ? { seq: null, values: {}, debug: err }
      : {
          seq: err?.seq ?? null,
          values: err?.values ?? {},
          debug: err?.debug,
        };

  // ✅ ✅ CREATE ENTRY
  if (!errorMap[key]) {
    errorMap[key] = {
      table: tableKey,
      bomId,
      item: item || undefined,
      location: location || undefined,
      routingId: routingId || undefined,
      recordId,
      gcpRecId: "NULL",
      csvRecId,   // ✅ ADDED (IMPORTANT)
      messages: [],
    };
  } else {
    // ✅ ✅ UPDATE csvRecId IF EARLIER WAS NULL
    if (
      (!errorMap[key].csvRecId ||
        errorMap[key].csvRecId === "NULL") &&
      csvRecId !== "NULL"
    ) {
      errorMap[key].csvRecId = csvRecId;
    }
  }

  // ✅ ✅ REMOVE DUPLICATE MESSAGE LOGIC (UNCHANGED)
  const sig = JSON.stringify({
    seq: errObj.seq,
    values: errObj.values,
    debug: errObj.debug,
  });

  const exists = errorMap[key].messages.some(
    (m) => JSON.stringify(m) === sig
  );

  if (!exists) errorMap[key].messages.push(errObj);

  // ✅ ✅ TRACK COUNTS (USE csvRecId FOR ROW COUNT)
  if (csvRecId !== "NULL") {
    errorRowSet[tableKey]?.add(csvRecId);
  }

  errorBomSet[tableKey]?.add(bomId);
};

  // CSV sets
  const bomIdsParams = uniq(reqBomParameters.map((x) => x.bom_id));
  const bomIdsProduced = uniq(reqBomProduced.map((x) => x.bom_id));
  const bomIdsConsumed = uniq(reqBomConsumed.map((x) => x.bom_id));
  const bomIdsRouting = uniq(reqItemRouting.map((x) => x.bom_id));

  const csvParamsSet = new Set(bomIdsParams);
  const csvProducedSet = new Set(bomIdsProduced);
  const csvRoutingSet = new Set(bomIdsRouting);

  const allBomIds = uniq([...bomIdsParams, ...bomIdsProduced, ...bomIdsConsumed, ...bomIdsRouting]).filter(Boolean);
  const allBomIdsStr = allBomIds.map(String);

  // Fetch rec_ids (best effort)
  const fetchRecIds = async (tableKey, tableName) => {
    if (!allBomIdsStr.length) return;
    const query = `
      SELECT CAST(bom_id AS STRING) AS bom_id, rec_id
      FROM ${qTbl(PROJECT, DATASET, tableName)}
      WHERE CAST(bom_id AS STRING) IN UNNEST(@bomIds)
    `;
    const [rows] = await bigquery.query({ query, params: { bomIds: allBomIdsStr } });
    rows.forEach((r) => addRecId(tableKey, r.bom_id, r.rec_id));
  };

  await Promise.all([
    fetchRecIds("BOM_PARAMETERS", TB_BOM_PARAMETERS),
    fetchRecIds("BOM_PRODUCED", TB_BOM_PRODUCED),
    fetchRecIds("BOM_CONSUMED", TB_BOM_CONSUMED),
    fetchRecIds("ITEM_BOM_ROUTING", TB_ITEM_BOM_ROUTING),
  ]);

  // -------------------------
  // ITEM MASTER STATUS MAP (GCP)
  // -------------------------
  const itemsToCheck = new Set();
  for (const x of [...reqBomParameters, ...reqBomProduced, ...reqBomConsumed, ...reqItemRouting]) {
    const bomItem = deriveBomItem(x.bom_id);
    if (bomItem) itemsToCheck.add(bomItem);
    if (x.item) itemsToCheck.add(x.item);
    if (x.produced_item) itemsToCheck.add(x.produced_item);
  }

  const itemStatusMap = new Map();
  const itemsArr = [...itemsToCheck].filter(Boolean).map(String);

  if (itemsArr.length) {
    const query = `
      SELECT CAST(item AS STRING) AS item, CAST(item_status AS STRING) AS item_status
      FROM ${qTbl(PROJECT, DATASET, TB_ITEM_MASTER)}
      WHERE CAST(item AS STRING) IN UNNEST(@items)
    `;
    const [rows] = await bigquery.query({ query, params: { items: itemsArr } });
    rows.forEach((r) => itemStatusMap.set(norm(r.item), norm(r.item_status).toUpperCase()));
  }

  const getItemStatus = (item) => itemStatusMap.get(norm(item)) || "NULL";
  const isItemActive = (item) => getItemStatus(item) === "ACTIVE";

  // Duplicate checks in GCP
  const gcpBomParametersExisting = new Set();
  const gcpBomProducedExisting = new Set();

  const fillExistSet = async (set, tableName, bomIds) => {
    if (!bomIds.length) return;
    const query = `
      SELECT DISTINCT CAST(bom_id AS STRING) AS bom_id
      FROM ${qTbl(PROJECT, DATASET, tableName)}
      WHERE CAST(bom_id AS STRING) IN UNNEST(@bomIds)
    `;
    const [rows] = await bigquery.query({ query, params: { bomIds: bomIds.map(String) } });
    rows.forEach((r) => set.add(norm(r.bom_id)));
  };

  await Promise.all([
    fillExistSet(gcpBomParametersExisting, TB_BOM_PARAMETERS, bomIdsParams),
    fillExistSet(gcpBomProducedExisting, TB_BOM_PRODUCED, bomIdsProduced),
  ]);

  // ============================================================
  // ✅ Co-product sets (CSV ONLY) — (seq 1007 depends on this)
  // ============================================================
  const coproductBomsFromProducedCsv = uniq(reqBomProduced.filter((p) => p.is_coproduct).map((p) => p.bom_id));
  const coproductBomSet = new Set(coproductBomsFromProducedCsv);

  // CSV routing association set by (bom_id,item,location) where erp_co_product_association = 1
  const csvRoutingHasCoAssoc1 = new Set();
  for (const rt of reqItemRouting) {
    if (Number(rt.erp_co_product_association) !== 1) continue;
    const b = norm(rt.bom_id);
    const it = norm(rt.item || deriveBomItem(rt.bom_id));
    const loc = norm(rt.location || deriveBomLocation(rt.bom_id));
    if (b && it && loc) csvRoutingHasCoAssoc1.add(key3(b, it, loc));
  }

  // ============================================================
  // routing_rescons + MPS mapping (GCP) — (seq 1015/1016)
  // ============================================================
  const routingPairs = reqItemRouting
    .map((r) => ({
      routing_id: norm(r.routing_id),
      item: norm(r.item || deriveBomItem(r.bom_id)),
      location: norm(r.location || deriveBomLocation(r.bom_id)),
    }))
    .filter((p) => p.routing_id && p.item && p.location);

  const routingPairHasRescons = new Set();
  const routingIdToResources = new Map();

  if (routingPairs.length) {
    const query = `
      WITH pairs AS (SELECT * FROM UNNEST(@pairs) AS p)
      SELECT DISTINCT
        p.routing_id AS routing_id,
        p.item AS item,
        p.location AS location,
        CAST(rr.resource AS STRING) AS resource
      FROM pairs p
      JOIN ${qTbl(PROJECT, DATASET, TB_ROUTING_RESCONS)} rr
        ON CAST(rr.routing_id AS STRING) = p.routing_id
       AND CAST(rr.item AS STRING) = p.item
       AND CAST(rr.location AS STRING) = p.location
    `;
    const [rows] = await bigquery.query({ query, params: { pairs: routingPairs } });

    rows.forEach((r) => {
      const rid = norm(r.routing_id);
      const it = norm(r.item);
      const loc = norm(r.location);
      const res = norm(r.resource);

      routingPairHasRescons.add(key3(rid, it, loc));
      if (rid && res) {
        if (!routingIdToResources.has(rid)) routingIdToResources.set(rid, new Set());
        routingIdToResources.get(rid).add(res);
      }
    });
  }

  const allResources = uniq([...routingIdToResources.values()].flatMap((s) => [...s])).filter(Boolean);
  const mpsResourceSet = new Set();

  if (allResources.length) {
    const qMps = `
      SELECT DISTINCT CAST(resource AS STRING) AS resource
      FROM ${qTbl(PROJECT, DATASET, TB_RESOURCE_MASTER)}
      WHERE CAST(resource AS STRING) IN UNNEST(@resources)
        AND UPPER(CAST(resource_planning_relevance AS STRING)) LIKE '%MPS%'
    `;
    const [rows] = await bigquery.query({ query: qMps, params: { resources: allResources.map(String) } });
    rows.forEach((r) => {
      const res = norm(r.resource);
      if (res) mpsResourceSet.add(res);
    });
  }

  const routingIdHasMps = new Set();
  for (const [rid, resSet] of routingIdToResources.entries()) {
    if ([...resSet].some((res) => mpsResourceSet.has(res))) routingIdHasMps.add(rid);
  }

  // ============================================================
  // VALIDATIONS (CSV FLOW) — UPDATED addError everywhere
  // Seq numbers are from Book1 (Sheet2 column1) [1](https://teams.microsoft.com/l/meeting/details?eventId=AAMkADc4M2IzZjk2LTFjYzEtNGZjNC1hODgxLTJhZmIzZTMwNTFhNQFRAAgI3qZLbCBAAEYAAAAAN-Fjn_8W20WF3o-cLQAl0AcA9jIfEX9JgkW6T688ETYFmgAAAAABDQAA9jIfEX9JgkW6T688ETYFmgAAJKVo_AAAEA%3d%3d)
  // ============================================================

  // 1001: BOM_PARAMETERS BOMID exists in produced + routing (within CSV)
  for (const b of bomIdsParams) {
    const inProducedCsv = csvProducedSet.has(b);
    const inRoutingCsv = csvRoutingSet.has(b);
    if (!inProducedCsv || !inRoutingCsv) {
      addError("BOM_PARAMETERS", b, {
        seq: 1001,
        values: {
          "value/Values": b,
          value: b,
          producedExists: inProducedCsv,
          routingExists: inRoutingCsv,
        },
      });
    }
  }

  // 1002: BOM_PARAMETERS duplicate in GCP
  for (const b of bomIdsParams) {
    if (gcpBomParametersExisting.has(b)) {
      addError("BOM_PARAMETERS", b, {
        seq: 1002,
        values: { value: b },
      });
    }
  }
// ✅ NEW: Duplicate BOMID within CSV (BOM_PARAMETERS)
{
  const map = new Map();

  for (const p of reqBomParameters) {
    const b = p.bom_id;
    if (!b) continue;

    if (!map.has(b)) {
      map.set(b, []);
    }
    map.get(b).push(p);
  }

  for (const [b, rows] of map.entries()) {
    if (rows.length > 1) {
      for (const r of rows) {
        addError("BOM_PARAMETERS", r, {
          seq: 1002, // ✅ same seq used
          values: {
            bom_id: b,
            source: "CSV duplicate"
          },
          debug: "Duplicate BOMID found within BOM_PARAMETERS file"
        });
      }
    }
  }
}
  // 1003: BOM_PARAMETERS item ACTIVE (derived from BOMID)
  // for (const p of reqBomParameters) {
  //   const bomItem = deriveBomItem(p.bom_id);
  //   if (bomItem && !isItemActive(bomItem)) {
  //     addError("BOM_PARAMETERS", p, {
  //       seq: 1003,
  //       values: {
  //         derivedvalue: bomItem,
  //         Derivedvalue: bomItem,
  //         statusvalue: getItemStatus(bomItem),
  //         bom_id: p.bom_id,
  //       },
  //     });
  //   }
  // }

// 1005: BOM_PRODUCED BOMID exists in params + routing (within CSV)
for (const b of bomIdsProduced) {
  const inParamsCsv = csvParamsSet.has(b);
  const inRoutingCsv = csvRoutingSet.has(b);
  if (!inParamsCsv || !inRoutingCsv) {
    addError("BOM_PRODUCED", b, {
      seq: 1005,
      values: {
        value: b,
        paramsExists: inParamsCsv,
        routingExists: inRoutingCsv,
      },
    });
  }
}

// ============================================================
// ✅ 1006: Duplicate BOMID (GCP + CSV with Co-Product logic)
// ============================================================
{
  // ✅ 1. GCP duplicate check
  for (const b of bomIdsProduced) {
    if (gcpBomProducedExisting.has(b)) {
      addError("BOM_PRODUCED", b, {
        seq: 1006,
        values: { value: b },
      });
    }
  }

  // ✅ 2. Build BOM-level co-product association set from routing
  const bomLevelCoAssocSet = new Set();
  for (const rt of reqItemRouting) {
    if (Number(rt.erp_co_product_association) === 1) {
      const b = norm(rt.bom_id);
      if (b) bomLevelCoAssocSet.add(b);
    }
  }

  // ✅ 3. Group produced rows by BOM_ID
  const producedMap = new Map();
  for (const pr of reqBomProduced) {
    const b = norm(pr.bom_id);
    if (!b) continue;

    if (!producedMap.has(b)) producedMap.set(b, []);
    producedMap.get(b).push(pr);
  }

  // ✅ 4. Apply validation
  for (const [b, rows] of producedMap.entries()) {
    if (rows.length <= 1) continue;

    const hasRoutingCoAssoc = bomLevelCoAssocSet.has(b);

    // ✅ If co-product allowed → skip error
    if (hasRoutingCoAssoc) continue;

    // ❌ Otherwise → error
    for (const r of rows) {
      addError("BOM_PRODUCED", r, {
        seq: 1006,
        values: {
          value: b,
          type: "Duplicate BOMID without Co-Product Association=1"
        },
      });
    }
  }


  // ============================================================
  // ✅ 1007: Multiple items with Qty Produced = 1
  // ============================================================
  for (const [b, rows] of producedMap.entries()) {

    const qty1Rows = rows.filter(r => Number(r.erp_bom_qty_produced_per) === 1);

    if (qty1Rows.length > 1) {
      const uniqueItems = new Set(qty1Rows.map(r => norm(r.item)));

      if (uniqueItems.size > 1) {
        qty1Rows.forEach(r => {
          addError("BOM_PRODUCED", r, {
            seq: 1007,
            values: {
              bom_id: b,
              item: r.item,
              value: r.erp_bom_qty_produced_per
            }
          });
        });
      }
    }
  }


  // ============================================================
  // ✅ 1008 (NEW): Duplicate Co-Product Items (Qty < 1)
  // ============================================================
  for (const [b, rows] of producedMap.entries()) {

    const coRows = rows.filter(r =>
      r.is_coproduct && Number(r.erp_bom_qty_produced_per) < 1
    );

    const seen = new Set();

    for (const r of coRows) {
      const key = `${norm(r.item)}__${r.erp_bom_qty_produced_per}`;

      if (seen.has(key)) {
        addError("BOM_PRODUCED", r, {
          seq: 1008,
          values: {
            bom_id: b,
            item: r.item
          }
        });
      }
      seen.add(key);
    }
  }


  // ============================================================
  // ✅ 1009: Co-Product must have base Produced record (Qty = 1)
  // ============================================================
  for (const [b, rows] of producedMap.entries()) {

    const hasBase = rows.some(r =>
      Number(r.erp_bom_qty_produced_per) === 1
    );

    const coRows = rows.filter(r => r.is_coproduct);

    if (!hasBase && coRows.length > 0) {
      coRows.forEach(r => {
        addError("BOM_PRODUCED", r, {
          seq: 1009,
          values: {
            bom_id: b,
            item: r.item
          }
        });
      });
    }
  }
}


// ============================================================
// ✅ EXISTING 1008: QtyProducedPer rules (KEEP THIS)
// ============================================================
for (const pr of reqBomProduced) {
  const qpp = pr.erp_bom_qty_produced_per;

  if (qpp == null) {
    addError("BOM_PRODUCED", pr, {
      seq: 1008,
      values: {
        value: qpp,
        item: pr.item,
        location: pr.location,
        bom_id: pr.bom_id,
      },
    });
    continue;
  }

  const q = Number(qpp);

  if (pr.is_coproduct) {
    if (!(q > 0 && q < 1)) {
      addError("BOM_PRODUCED", pr, {
        seq: 1008,
        values: {
          value: qpp,
          item: pr.item,
          location: pr.location,
          bom_id: pr.bom_id,
        },
      });
    }
  } else {
    if (q !== 1) {
      addError("BOM_PRODUCED", pr, {
        seq: 1008,
        values: {
          value: qpp,
          item: pr.item,
          location: pr.location,
          bom_id: pr.bom_id,
        },
      });
    }
  }
}

  // 1009: BOM_PRODUCED Item ACTIVE (item and bom item)
  // for (const pr of reqBomProduced) {
  //   const item = norm(pr.item);
  //   const bomItem = deriveBomItem(pr.bom_id);

  //   if (item && !isItemActive(item)) {
  //     addError("BOM_PRODUCED", pr, {
  //       seq: 1009,
  //       values: {
  //         value: item,
  //         Derivedvalue: bomItem,
  //         derivedvalue: bomItem,
  //         statusvalue: getItemStatus(item),
  //         bomStatusvalue: bomItem ? getItemStatus(bomItem) : "NULL",
  //       },
  //     });
  //   }

  //   if (bomItem && !isItemActive(bomItem)) {
  //     addError("BOM_PRODUCED", pr, {
  //       seq: 1009,
  //       values: {
  //         value: item || "NULL",
  //         Derivedvalue: bomItem,
  //         derivedvalue: bomItem,
  //         statusvalue: item ? getItemStatus(item) : "NULL",
  //         bomStatusvalue: getItemStatus(bomItem),
  //       },
  //     });
  //   }
  // }

  // 1010: BOM_CONSUMED QtyConsumedPer > 0
  for (const c of reqBomConsumed) {
    const qcp = c.erp_bom_quantity_consumed_per;

    if (qcp == null || Number(qcp) <= 0) {
      addError("BOM_CONSUMED", c, {
        seq: 1010,
        values: {
          value: qcp,
          item: c.item,
          location: c.location,
          bom_id: c.bom_id,
        },
      });
    }
  }

  // 1011: BOM_CONSUMED BOMID must exist in produced CSV
  for (const b of bomIdsConsumed) {
    if (!csvProducedSet.has(b)) {
      addError("BOM_CONSUMED", b, {
        seq: 1011,
        values: { value: b },
      });
    }
  }

  // 1012: Duplicate combinations of BOMID and Consumed item (your current key is bomid+item)
  {
    const seen = new Set();
    for (const c of reqBomConsumed) {
      const k = key2(c.bom_id, c.item || "NULL");
      if (seen.has(k)) {
        addError("BOM_CONSUMED", c, {
          seq: 1012,
          values: {
            value: c.bom_id,
            item: c.item,
            location: c.location,
          },
        });
      }
      seen.add(k);
    }
  }

  // 1013: Recursive consumption
  for (const c of reqBomConsumed) {
    const bomItem = deriveBomItem(c.bom_id);
    if (bomItem && c.item && norm(bomItem) === norm(c.item)) {
      addError("BOM_CONSUMED", c, {
        seq: 1013,
        values: {
          value: c.item,
          location: c.location,
          bomid: c.bom_id,
          bom_id: c.bom_id,
        },
      });
    }
  }

  // 1014: BOM_CONSUMED Item ACTIVE (cons item + bom item)
  // for (const c of reqBomConsumed) {
  //   const item = norm(c.item);
  //   const bomItem = deriveBomItem(c.bom_id);

  //   if (item && !isItemActive(item)) {
  //     addError("BOM_CONSUMED", c, {
  //       seq: 1014,
  //       values: {
  //         value: item,
  //         Derivedvalue: bomItem,
  //         derivedvalue: bomItem,
  //         statusvalue: getItemStatus(item),
  //         bomStatusvalue: bomItem ? getItemStatus(bomItem) : "NULL",
  //       },
  //     });
  //   }

  //   if (bomItem && !isItemActive(bomItem)) {
  //     addError("BOM_CONSUMED", c, {
  //       seq: 1014,
  //       values: {
  //         value: item || "NULL",
  //         Derivedvalue: bomItem,
  //         derivedvalue: bomItem,
  //         statusvalue: item ? getItemStatus(item) : "NULL",
  //         bomStatusvalue: getItemStatus(bomItem),
  //       },
  //     });
  //   }
  // }

  // 1015: routing_rescons resource exists for (routing_id,item,location)
  // for (const rt of reqItemRouting) {
  //   const rid = norm(rt.routing_id);
  //   const it = norm(rt.item || deriveBomItem(rt.bom_id));
  //   const loc = norm(rt.location || deriveBomLocation(rt.bom_id));
  //   if (!rid || !it || !loc) continue;

  //   const k = key3(rid, it, loc);
  //   if (!routingPairHasRescons.has(k)) {
  //     addError("ITEM_BOM_ROUTING", { ...rt, item: it, location: loc, routing_id: rid }, {
  //       seq: 1015,
  //       values: {
  //         value: rid,
  //         "Derivedvalue-1": it,
  //         "Derivedvalue-2": loc,
  //       },
  //     });
  //   }
  // }

  // 1016: routing resource must be mapped as MPS (via resource_master)
  // for (const rt of reqItemRouting) {
  //   const rid = norm(rt.routing_id);
  //   if (rid && !routingIdHasMps.has(rid)) {
  //     addError("ITEM_BOM_ROUTING", rt, {
  //       seq: 1016,
  //       values: {
  //         value: rid, // (Book1 talks about resource; we keep routing_id here for trace; report can map resources if needed)
  //       },
  //     });
  //   }
  // }

  // 1017: If routing has CoProductAssociation=1 then produced must have qty<1 (co-product)
  for (const rt of reqItemRouting) {
    if (Number(rt.erp_co_product_association) !== 1) continue;
    if (!coproductBomSet.has(rt.bom_id)) {
      addError("ITEM_BOM_ROUTING", rt, {
        seq: 1017,
        values: {
          Value: rt.item,
          Derivedvalue: rt.location || deriveBomLocation(rt.bom_id),
          item: rt.item,
          location: rt.location || deriveBomLocation(rt.bom_id),
          bom_id: rt.bom_id,
        },
      });
    }
  }

  // 1018: Each routing BOMID exists in both params and produced CSV
  for (const b of bomIdsRouting) {
    const inParamsCsv = csvParamsSet.has(b);
    const inProducedCsv = csvProducedSet.has(b);
    if (!inParamsCsv || !inProducedCsv) {
      addError("ITEM_BOM_ROUTING", b, {
        seq: 1018,
        values: {
          "value/Values": b,
          value: b,
          paramsExists: inParamsCsv,
          producedExists: inProducedCsv,
        },
      });
    }
  }

  // 1019: Duplicate combinations of Item, BOMID, RoutingID
  {
    const seen = new Set();
    for (const rt of reqItemRouting) {
      const k = key3(rt.item || "NULL", rt.bom_id, rt.routing_id || "NULL");
      if (seen.has(k)) {
        addError("ITEM_BOM_ROUTING", rt, {
          seq: 1019,
          values: {
            value: rt.bom_id,
            item: rt.item,
            routing_id: rt.routing_id,
          },
        });
      }
      seen.add(k);
    }
  }

  // 1020: Duplicate combinations of BOMID and Priority
  {
    const seen = new Set();
    for (const rt of reqItemRouting) {
      const pr = rt.priority == null ? "NULL" : String(rt.priority);
      const k = key2(rt.bom_id, pr);
      if (seen.has(k)) {
        addError("ITEM_BOM_ROUTING", rt, {
          seq: 1020,
          values: {
            value: rt.bom_id,
            erp_item_bom_routing_priority: pr,
          },
        });
      }
      seen.add(k);
    }
  }

  // 1021: Priority must be integer
  for (const rt of reqItemRouting) {
    if (rt.priority == null) continue;
    if (!isInt(rt.priority)) {
      addError("ITEM_BOM_ROUTING", rt, {
        seq: 1021,
        values: {
          value: rt.priority,
          bom_id: rt.bom_id,
        },
      });
    }
  }

  // 1022: ITEM_BOM_ROUTING Item ACTIVE (item + bom item)
  // for (const rt of reqItemRouting) {
  //   const item = norm(rt.item);
  //   const bomItem = deriveBomItem(rt.bom_id);

  //   if (item && !isItemActive(item)) {
  //     addError("ITEM_BOM_ROUTING", rt, {
  //       seq: 1022,
  //       values: {
  //         value: item,
  //         Derivedvalue: bomItem,
  //         derivedvalue: bomItem,
  //         statusvalue: getItemStatus(item),
  //         bomStatusvalue: bomItem ? getItemStatus(bomItem) : "NULL",
  //       },
  //     });
  //   }

  //   if (bomItem && !isItemActive(bomItem)) {
  //     addError("ITEM_BOM_ROUTING", rt, {
  //       seq: 1022,
  //       values: {
  //         value: item || "NULL",
  //         Derivedvalue: bomItem,
  //         derivedvalue: bomItem,
  //         statusvalue: item ? getItemStatus(item) : "NULL",
  //         bomStatusvalue: getItemStatus(bomItem),
  //       },
  //     });
  //   }
  // }

  // finalize gcpRecId
  for (const k of Object.keys(errorMap)) {
    const e = errorMap[k];
    if (!e?.bomId) continue;

    if (e.table === "BOM_PARAMETERS") e.gcpRecId = getRecIdString("BOM_PARAMETERS", e.bomId);
    if (e.table === "BOM_PRODUCED") e.gcpRecId = getRecIdString("BOM_PRODUCED", e.bomId);
    if (e.table === "BOM_CONSUMED") e.gcpRecId = getRecIdString("BOM_CONSUMED", e.bomId);
    if (e.table === "ITEM_BOM_ROUTING") e.gcpRecId = getRecIdString("ITEM_BOM_ROUTING", e.bomId);
  }

  const validatedCounts = {
    BOM_PARAMETERS: validatedSet.BOM_PARAMETERS.size,
    BOM_PRODUCED: validatedSet.BOM_PRODUCED.size,
    BOM_CONSUMED: validatedSet.BOM_CONSUMED.size,
    ITEM_BOM_ROUTING: validatedSet.ITEM_BOM_ROUTING.size,
  };

  const errorCounts = {
    BOM_PARAMETERS: errorBomSet.BOM_PARAMETERS.size,
    BOM_PRODUCED: errorBomSet.BOM_PRODUCED.size,
    BOM_CONSUMED: errorBomSet.BOM_CONSUMED.size,
    ITEM_BOM_ROUTING: errorBomSet.ITEM_BOM_ROUTING.size,
  };

  const errorRowCounts = {
    BOM_PARAMETERS: errorRowSet.BOM_PARAMETERS.size,
    BOM_PRODUCED: errorRowSet.BOM_PRODUCED.size,
    BOM_CONSUMED: errorRowSet.BOM_CONSUMED.size,
    ITEM_BOM_ROUTING: errorRowSet.ITEM_BOM_ROUTING.size,
  };

  const errorList = Object.values(errorMap).map((e) => ({
    table: e.table,
    bomId: e.bomId,
    gcpRecId: e.gcpRecId,
    messages: e.messages, 
    csvRecId: e.csvRecId,
    item: e.item,
    location: e.location,
    routingId: e.routingId,
    recordId: e.recordId,
  }));

  const isValid = errorList.length === 0;

  return {
    status: isValid ? "SUCCESS" : "FAILED",
    isValid,
    validatedCounts,
    errorCounts,
    errorRowCounts,
    errorMap,
    errorList,
  };
};