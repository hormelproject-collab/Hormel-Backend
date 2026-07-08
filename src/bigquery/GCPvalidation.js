import bigquery from "./bigquery.js";



/*  Env + table name helpers */
const assertEnv = (name, value) => {
  if (!value) throw new Error(`Missing env: ${name}`);
};

const envOr = (key, fallback) => (process.env[key] ? process.env[key] : fallback);

const qTbl = (project, dataset, tableName) =>
  `\`${project}.${dataset}.${tableName}\``;

const qCol = (colName) => `\`${String(colName).replace(/`/g, "")}\``;


const canon = (v) =>
  String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const schemaCache = new Map();

async function getBigQueryColumns(tableName, project, dataset) {
  const cacheKey = `${project}.${dataset}.${tableName}`;
  if (schemaCache.has(cacheKey)) return schemaCache.get(cacheKey);

  const query = `
    SELECT column_name
    FROM \`${project}.${dataset}.INFORMATION_SCHEMA.COLUMNS\`
    WHERE table_name = @tableName
  `;

  const [rows] = await bigquery.query({
    query,
    params: { tableName },
  });

  const cols = rows.map((r) => String(r.column_name).trim());
  schemaCache.set(cacheKey, cols);
  return cols;
}

async function resolvePhysicalColumn(
  tableName,
  project,
  dataset,
  candidateNames = [],
  { required = true } = {}
) {
  const cols = await getBigQueryColumns(tableName, project, dataset);
  const byCanon = new Map(cols.map((c) => [canon(c), c]));

  for (const candidate of candidateNames) {
    const found = byCanon.get(canon(candidate));
    if (found) return found;
  }

  if (!required) return null;

  throw new Error(
    `Could not resolve any of [${candidateNames.join(", ")}] in BigQuery table ${tableName}. Actual columns: ${cols.join(", ")}`
  );
}

async function resolveBomIdColumn(tableName, project, dataset) {
  return resolvePhysicalColumn(tableName, project, dataset, [
    "BOMID",
    "bom_id",
    "bomid",
    "BOM_ID",
    "BomId",
    "bomId",
  ]);
}

async function resolveRecIdColumn(tableName, project, dataset, { required = false } = {}) {
  return resolvePhysicalColumn(
    tableName,
    project,
    dataset,
    [
      "rec_id",
      "REC_ID",
      "recid",
      "RECID",
      "RecordID",
      "record_id",
      "recordid",
      "RECORD_ID",
      "RECORDID",
      "RowID",
      "row_id",
      "rowid",
    ],
    { required }
  );
}

async function resolveBomTableColumns(tableName, project, dataset) {
  const bomIdCol = await resolveBomIdColumn(tableName, project, dataset);
  const recIdCol = await resolveRecIdColumn(tableName, project, dataset, {
    required: false,
  });

  return { bomIdCol, recIdCol };
}

/* Common helpers */
const norm = (v) => (v == null ? "" : String(v).trim());

const uniq = (arr) => [...new Set(arr)];

const toNum = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const isInt = (v) => Number.isInteger(Number(v));

const toBool = (v) => {
  if (v === true) return true;
  const s = String(v ?? "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "y";
};

const canonKey = (s) =>
  String(s ?? "")
    .normalize("NFKC")
    .replace(/[\uFEFF\u200B\u00A0]/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const pick = (obj, keys) => {
  if (!obj || typeof obj !== "object") return "";
  const map = {};
  for (const k of Object.keys(obj)) {
    map[canonKey(k)] = obj[k];
  }
  for (const key of keys) {
    const v = map[canonKey(key)];
    if (v != null && String(v).trim() !== "") return v;
  }
  return "";
};

const key2 = (a, b) => `${norm(a)}__${norm(b)}`;
const key3 = (a, b, c) => `${norm(a)}__${norm(b)}__${norm(c)}`;

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

/* CSV payload normalization */
const detectCsvArrayKind = (arr) => {
  const first = arr?.[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return null;

  const keys = Object.keys(first).map(canonKey);
  const has = (k) => keys.includes(canonKey(k));

  if (has("ERPBOMQuantityConsumedPer")) return "bom_consumed";
  if (has("ERPBOMQtyProducedPer") || has("ERPBOMQuantityProducedPer")) {
    return "bom_produced";
  }
  if (has("ProducedItem")) return "bom_parameters";
  if (has("RoutingID") || has("ERPItemBOMRoutingPriority")) {
    return "item_bom_routing";
  }

  return null;
};

function normalizeTablesFromPayload(payload) {
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

  const isObj = payload && typeof payload === "object" && !Array.isArray(payload);
  if (!isObj) {
    return {
      bom_parameters: [],
      bom_produced: [],
      bom_consumed: [],
      item_bom_routing: [],
    };
  }

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
  const bom_id = norm(
    pick(row, ["BOMID", "bom_id", "bomId", "BOM_ID", "BOM Id", "BOM", "bom"])
  );

  const item = norm(pick(row, ["Item", "item", "ITEM"]));

  const location = norm(
    pick(row, ["Location", "location", "LOC", "Plant", "PLANT"])
  );

  const routing_id = norm(
    pick(row, ["RoutingID", "routing_id", "routingId", "ROUTING_ID", "ROUTINGID"])
  );

  const csvRecId = norm(
    pick(row, [
      "ERR_ID",
      "ERRID",
      "err_id",
      "errid",
      "ROW_NUMBER",
      "row_number",
      "ROWNUMBER",
      "rownumber",
    ])
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

  const qtyConsumedPer = toNum(
    pick(row, [
      "ERPBOMQuantityConsumedPer",
      "QtyConsumedPer",
      "qtyConsumedPer",
      "QuantityConsumedPer",
      "qty_consumed_per",
      "Qty Consumed Per",
      "ERPBOM Quantity Consumed Per",
    ])
  );

  const priority = toNum(
    pick(row, [
      "ERPItemBOMRoutingPriority",
      "RoutingPriority",
      "priority",
      "Priority",
    ])
  );

  const rawIsCo = pick(row, [
    "IsCoProduct",
    "is_coproduct",
    "CoProduct",
    "coproduct",
    "CoProductFlag",
    "co_product_flag",
  ]);
  const flagIsCo = toBool(rawIsCo);
  const qtyImpliesCo =
    qtyProducedPer != null && qtyProducedPer > 0 && qtyProducedPer < 1;
  const is_coproduct = flagIsCo || qtyImpliesCo;

  if (tableKey === "BOM_PARAMETERS") {
    const produced_item =
      norm(
        pick(row, [
          "ProducedItem",
          "produced_item",
          "Produced_Item",
          "PRODUCED_ITEM",
        ])
      ) ||
      item ||
      deriveBomItem(bom_id);

    return {
      bom_id,
      produced_item,
      item: produced_item,
      location: deriveBomLocation(bom_id),
      csvRecId,
    };
  }

  if (tableKey === "BOM_PRODUCED") {
    return {
      bom_id,
      item: item || deriveBomItem(bom_id),
      location: location || deriveBomLocation(bom_id),
      erp_bom_qty_produced_per: qtyProducedPer,
      is_coproduct,
      csvRecId,
    };
  }

  if (tableKey === "BOM_CONSUMED") {
    return {
      bom_id,
      item,
      location: location || deriveBomLocation(bom_id),
      erp_bom_quantity_consumed_per: qtyConsumedPer,
      co_product_flag: flagIsCo,
      csvRecId,
    };
  }

  return {
    bom_id,
    item: item || deriveBomItem(bom_id),
    location: location || deriveBomLocation(bom_id),
    routing_id,
    priority,
    erp_co_product_association:
      toNum(pick(row, ["CoProductAssociation", "ERP_CoProductAssociation", "ERPCoProductAssociation"])) ?? 0,
    csvRecId,
  };
}

/* Error message helper */
function defaultMessageForSeq(seq, values = {}) {
  switch (Number(seq)) {
    case 1001:
      return `BOM Parameters BOM ID ${values.value ?? ""} must also exist in uploaded BOM Produced and Item BOM Routing data.`;
    case 1002:
      return `BOM Parameters BOM ID ${values.value ?? values.bom_id ?? ""} already exists in BigQuery.`;
    case 1005:
      return `BOM Produced BOM ID ${values.value ?? ""} must also exist in uploaded BOM Parameters and Item BOM Routing data.`;
    case 1006:
      return `BOM Produced BOM ID ${values.value ?? values.bom_id ?? ""} already exists in BigQuery.`;
    case 1010:
      return `Consumed quantity must be greater than 0 for BOM ${values.bom_id ?? ""}, item ${values.item ?? ""}.`;
    case 1011:
      return `BOM Consumed BOM ID ${values.value ?? values.bom_id ?? ""} must exist in uploaded BOM Produced data.`;
    case 1012:
      return `Duplicate consumed item ${values.item ?? ""} found for BOM ${values.value ?? ""}.`;
    case 1013:
      return `Consumed item ${values.value ?? ""} cannot be the same as the BOM produced item for BOM ${values.bom_id ?? values.bomid ?? ""}.`;
    case 1017:
      return `Routing co-product association is invalid because BOM ${values.bom_id ?? ""} has no co-product row in BOM Produced.`;
    case 1018:
      return `Item BOM Routing BOM ID ${values.value ?? ""} must also exist in uploaded BOM Parameters and BOM Produced data.`;
    case 1019:
      return `Duplicate Item/BOM/Routing combination found for BOM ${values.value ?? ""}, item ${values.item ?? ""}, routing ${values.routing_id ?? ""}.`;
    case 1020:
      return `Duplicate routing priority ${values.erp_item_bom_routing_priority ?? ""} found for BOM ${values.value ?? ""}.`;
    case 1021:
      return `Routing priority must be an integer for BOM ${values.bom_id ?? ""}.`;
    default:
      return `Validation failed for sequence ${seq}.`;
  }
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

  const { bom_parameters, bom_produced, bom_consumed, item_bom_routing } =
    normalizeTablesFromPayload(payload);

  const uploaded = {
    BOM_PARAMETERS: Array.isArray(bom_parameters) && bom_parameters.length > 0,
    BOM_PRODUCED: Array.isArray(bom_produced) && bom_produced.length > 0,
    BOM_CONSUMED: Array.isArray(bom_consumed) && bom_consumed.length > 0,
    ITEM_BOM_ROUTING:
      Array.isArray(item_bom_routing) && item_bom_routing.length > 0,
  };

  const addErrId = (rows = []) =>
    (rows || []).map((r, idx) => ({
      ...r,
      ERR_ID:
        (r?.ERR_ID ??
          r?.err_id ??
          r?.Err_ID ??
          r?.row_number ??
          r?.ROW_NUMBER) ??
        idx + 2,
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
      if (!firstRowByTableBom[tableKey].has(b)) {
        firstRowByTableBom[tableKey].set(b, id);
      }
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

  const gcpRecIds = {
    BOM_PARAMETERS: new Map(),
    BOM_PRODUCED: new Map(),
    BOM_CONSUMED: new Map(),
    ITEM_BOM_ROUTING: new Map(),
  };

  const addRecId = (tableKey, bomId, recId) => {
    const b = norm(bomId);
    const r = norm(recId);
    if (!b || !r) return;
    if (!gcpRecIds[tableKey].has(b)) {
      gcpRecIds[tableKey].set(b, new Set());
    }
    gcpRecIds[tableKey].get(b).add(r);
  };

  const getRecIdString = (tableKey, bomId) => {
    const b = norm(bomId);
    const set = gcpRecIds[tableKey]?.get(b);
    if (!set || set.size === 0) return "NULL";
    return [...set].join("\n");
  };

  const buildRecordId = (tableKey, ctx) => {
    const b = norm(ctx?.bom_id ?? ctx?.bomId);
    if (!b) return "NULL";
    return [
      tableKey,
      b,
      norm(ctx?.item ?? ""),
      norm(ctx?.location ?? ""),
      norm(ctx?.routing_id ?? ctx?.routingId ?? ""),
    ].join("__");
  };

  const addError = (tableKey, ctxOrBomId, err) => {
    const ctx =
      typeof ctxOrBomId === "string"
        ? {
            bom_id: ctxOrBomId,
            csvRecId: firstRowByTableBom[tableKey]?.get(norm(ctxOrBomId)) ?? "",
          }
        : ctxOrBomId || {};

    const bomId = norm(ctx?.bom_id ?? ctx?.bomId);
    if (!bomId) return;

    const recordId = buildRecordId(tableKey, ctx);
    const csvRecId =
      norm(ctx?.csvRecId) ||
      norm(firstRowByTableBom[tableKey]?.get(bomId)) ||
      "NULL";

    const messageObj = {
      seq: err?.seq ?? null,
      sequence: err?.seq ?? null,
      values: err?.values ?? {},
      message: err?.message ?? defaultMessageForSeq(err?.seq, err?.values ?? {}),
    };

    if (!errorMap[recordId]) {
      errorMap[recordId] = {
        table: tableKey,
        bomId,
        gcpRecId: "NULL",
        messages: [],
        csvRecId,
        item: norm(ctx?.item ?? ""),
        location: norm(ctx?.location ?? ""),
        routingId: norm(ctx?.routing_id ?? ctx?.routingId ?? ""),
        recordId,
      };
    }

    errorMap[recordId].messages.push(messageObj);
    errorBomSet[tableKey].add(bomId);
    errorRowSet[tableKey].add(recordId);
  };

  const bomIdsParams = uniq(reqBomParameters.map((x) => x.bom_id));
  const bomIdsProduced = uniq(reqBomProduced.map((x) => x.bom_id));
  const bomIdsConsumed = uniq(reqBomConsumed.map((x) => x.bom_id));
  const bomIdsRouting = uniq(reqItemRouting.map((x) => x.bom_id));

  const csvParamsSet = new Set(bomIdsParams);
  const csvProducedSet = new Set(bomIdsProduced);
  const csvRoutingSet = new Set(bomIdsRouting);

  const allBomIds = uniq([
    ...bomIdsParams,
    ...bomIdsProduced,
    ...bomIdsConsumed,
    ...bomIdsRouting,
  ]).filter(Boolean);

  const allBomIdsStr = allBomIds.map(String);

  const fetchRecIds = async (tableKey, tableName) => {
    if (!allBomIdsStr.length) return;

    const { bomIdCol, recIdCol } = await resolveBomTableColumns(
      tableName,
      PROJECT,
      DATASET
    );

    

    const query = `
      SELECT
        CAST(${qCol(bomIdCol)} AS STRING) AS bom_id,
        ${
          recIdCol
            ? `CAST(${qCol(recIdCol)} AS STRING) AS rec_id`
            : `'NULL' AS rec_id`
        }
      FROM ${qTbl(PROJECT, DATASET, tableName)}
      WHERE CAST(${qCol(bomIdCol)} AS STRING) IN UNNEST(@bomIds)
    `;

   

    const [rows] = await bigquery.query({
      query,
      params: { bomIds: allBomIdsStr },
    });

    rows.forEach((r) => addRecId(tableKey, r.bom_id, r.rec_id));
  };

  await Promise.all([
    uploaded.BOM_PARAMETERS
      ? fetchRecIds("BOM_PARAMETERS", TB_BOM_PARAMETERS)
      : Promise.resolve(),
    uploaded.BOM_PRODUCED
      ? fetchRecIds("BOM_PRODUCED", TB_BOM_PRODUCED)
      : Promise.resolve(),
    uploaded.BOM_CONSUMED
      ? fetchRecIds("BOM_CONSUMED", TB_BOM_CONSUMED)
      : Promise.resolve(),
    uploaded.ITEM_BOM_ROUTING
      ? fetchRecIds("ITEM_BOM_ROUTING", TB_ITEM_BOM_ROUTING)
      : Promise.resolve(),
  ]);

  const gcpBomParametersExisting = new Set();
  const gcpBomProducedExisting = new Set();

  const fillExistSet = async (set, _tableKey, tableName, bomIds) => {
    if (!bomIds.length) return;

    const bomIdCol = await resolveBomIdColumn(tableName, PROJECT, DATASET);

    const query = `
      SELECT DISTINCT CAST(${qCol(bomIdCol)} AS STRING) AS bom_id
      FROM ${qTbl(PROJECT, DATASET, tableName)}
      WHERE CAST(${qCol(bomIdCol)} AS STRING) IN UNNEST(@bomIds)
    `;

    const [rows] = await bigquery.query({
      query,
      params: { bomIds },
    });

    rows.forEach((r) => {
      if (r?.bom_id != null) set.add(String(r.bom_id).trim());
    });
  };

  await Promise.all([
    uploaded.BOM_PARAMETERS
      ? fillExistSet(
          gcpBomParametersExisting,
          "BOM_PARAMETERS",
          TB_BOM_PARAMETERS,
          bomIdsParams
        )
      : Promise.resolve(),
    uploaded.BOM_PRODUCED
      ? fillExistSet(
          gcpBomProducedExisting,
          "BOM_PRODUCED",
          TB_BOM_PRODUCED,
          bomIdsProduced
        )
      : Promise.resolve(),
  ]);

  const coproductBomsFromProducedCsv = uniq(
    reqBomProduced.filter((p) => p.is_coproduct).map((p) => p.bom_id)
  );
  const coproductBomSet = new Set(coproductBomsFromProducedCsv);

  if (uploaded.BOM_PARAMETERS && uploaded.BOM_PRODUCED && uploaded.ITEM_BOM_ROUTING) {
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
  }

  if (uploaded.BOM_PARAMETERS) {
    for (const b of bomIdsParams) {
      if (gcpBomParametersExisting.has(b)) {
        addError("BOM_PARAMETERS", b, {
          seq: 1002,
          values: { value: b, bom_id: b },
        });
      }
    }
  }

  if (uploaded.BOM_PRODUCED && uploaded.BOM_PARAMETERS && uploaded.ITEM_BOM_ROUTING) {
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
  }

  if (uploaded.BOM_PRODUCED) {
    for (const b of bomIdsProduced) {
      if (gcpBomProducedExisting.has(b)) {
        addError("BOM_PRODUCED", b, {
          seq: 1006,
          values: { value: b, bom_id: b },
        });
      }
    }
  }

  if (uploaded.BOM_CONSUMED) {
    for (const c of reqBomConsumed) {
      const qcp = c.erp_bom_quantity_consumed_per;
      if (!(typeof qcp === "number" && qcp > 0)) {
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
  }

  if (uploaded.BOM_CONSUMED && uploaded.BOM_PRODUCED) {
    for (const b of bomIdsConsumed) {
      if (!csvProducedSet.has(b)) {
        addError("BOM_CONSUMED", b, {
          seq: 1011,
          values: { value: b, bom_id: b },
        });
      }
    }
  }

  if (uploaded.BOM_CONSUMED) {
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

  if (uploaded.BOM_CONSUMED) {
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
  }

  if (uploaded.ITEM_BOM_ROUTING && uploaded.BOM_PRODUCED) {
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
  }

  if (uploaded.ITEM_BOM_ROUTING && uploaded.BOM_PARAMETERS && uploaded.BOM_PRODUCED) {
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
  }

  if (uploaded.ITEM_BOM_ROUTING) {
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

  if (uploaded.ITEM_BOM_ROUTING) {
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

  if (uploaded.ITEM_BOM_ROUTING) {
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
  }

  for (const k of Object.keys(errorMap)) {
    const e = errorMap[k];
    if (!e?.bomId) continue;
    e.gcpRecId = getRecIdString(e.table, e.bomId);
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
