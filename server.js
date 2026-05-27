import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";

import sampleRoute from "./src/routes/route.js";
import bomExplosionRoute from "./src/routes/createbomliteRoute.js";
import bomDownloadRoutes from "./src/routes/bomDownload.routes.js";
import bigqueryRoutes from "./src/routes/bigqueryRoutes.js";
import engineeringChanges from "./src/DummyResponse/engineeringchanges.js";
import engineeringChangeDetailById from "./src/DummyResponse/engineeringChangeDetailDummy.js";

import tableRoutes from "./src/routes/tableRoutes.js";

const app = express();

// Increase payload limit (CSV parsed JSON can be large)
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

const ROOT_DIR = process.cwd();
const UPLOAD_DIR = path.join(ROOT_DIR, "uploads");
const REPORT_DIR = path.join(ROOT_DIR, "reports");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });

// Existing routes

// using cors to overcome browser restrictions
app.use(
  cors({
    origin: "http://localhost:5173",
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  })
);

/* =============================
   ✅ BigQuery APIs - GCP to UI
============================= */
console.log("✅ BigQuery routes loaded");

app.use("/api/bigquery/table", bigqueryRoutes);
app.use("/api/bom", bomDownloadRoutes);
app.use("/api/bigquery", sampleRoute);

// BOM Explosion: CSV upload + manual validation
app.use("/bom-explosion", bomExplosionRoute);

app.get("/health", (req, res) => res.json({ status: "UP" }));
app.get("/", (req, res) => res.send("✅ BOM API Server Running"));

/* -----------------------------------------------------
   ✅ UPDATED: POST ENGINEERING CHANGE LOG
   Supports request payload:
   {
     "fromDate": "2026-05-01",
     "toDate": "2026-05-19",
     "userFilter": "John",
     "showMineOnly": true,
     "criteria1": "Location",
     "criteria2": "Resource",
     "search": {
       "criteria1Value": "Location1",
       "criteria2Value": "Resource5"
     }
   }
------------------------------------------------------*/
app.post("/api/engineering-change-log", (req, res) => {
  try {
    const {
      fromDate,
      toDate,
      userFilter = "ALL",
      showMineOnly = false,
      criteria1 = "None",
      criteria2 = "None",
      search = {},
    } = req.body || {};

    const criteria1Value = search?.criteria1Value || "";
    const criteria2Value = search?.criteria2Value || "";

    const criteriaFieldMap = {
      Location: "locationId",
      "BOM ID": "bomId",
      Resource: "resource",
      "Produced Item": "producedItem",
      "Component Item": "componentItem",
      "Co-Product Item": "coProductItem",
    };

    const normalize = (value) =>
      value === undefined || value === null ? "" : String(value).trim().toLowerCase();

    const matchesCriteria = (item, criteria, value) => {
      if (!criteria || criteria === "None") return true;
      if (!value) return true;

      const fieldName = criteriaFieldMap[criteria];
      if (!fieldName) return true;

      const itemValue = normalize(item[fieldName]);
      const filterValue = normalize(value);

      return itemValue.includes(filterValue);
    };

    const result = engineeringChanges.filter((item) => {
      // ✅ Date filter
      if (fromDate) {
        const itemDate = new Date(item.changeDate);
        const from = new Date(fromDate);
        if (itemDate < from) return false;
      }

      if (toDate) {
        const itemDate = new Date(item.changeDate);
        const to = new Date(toDate);
        if (itemDate > to) return false;
      }

      // ✅ User Filter
      if (userFilter && userFilter !== "ALL" && normalize(item.changedBy) !== normalize(userFilter)) {
        return false;
      }

      // ✅ Show My Changes Only
      // Since current payload does not send currentUser separately,
      // this uses userFilter when showMineOnly = true
      if (showMineOnly) {
        if (!userFilter || userFilter === "ALL") {
          return false;
        }
        if (normalize(item.changedBy) !== normalize(userFilter)) {
          return false;
        }
      }

      // ✅ Criteria 1
      if (!matchesCriteria(item, criteria1, criteria1Value)) {
        return false;
      }

      // ✅ Criteria 2
      if (!matchesCriteria(item, criteria2, criteria2Value)) {
        return false;
      }

      return true;
    });

    return res.status(200).json({
      page: 1,
      pageSize: result.length,
      totalCount: result.length,
      items: result,
    });
  } catch (error) {
    console.error("❌ Error in /api/engineering-change-log:", error);
    return res.status(500).json({
      message: "Failed to fetch engineering change log data",
      error: error.message,
    });
  }
});

/* -----------------------------------------------------
   ✅ NEW: GET ENGINEERING CHANGE DETAIL (BY ID)
   Query Param: EngineeringchangeID=EC-001234
------------------------------------------------------*/
app.get("/api/engineering-changes/detail", (req, res) => {

  const id =
    req.query.EngineeringchangeID ||
    req.query.EngineeringChangeID ||
    req.query.engineeringChangeId;

  if (!id) {
    return res.status(400).json({
      message:
        "EngineeringchangeID query parameter is required. Example: ?EngineeringchangeID=EC-001234",
    });
  }

  const detail = engineeringChangeDetailById[id];

  if (!detail) {
    return res.status(404).json({
      message: `No engineering change detail found for EngineeringchangeID=${id}`,
    });
  }

  return res.status(200).json({
    data: detail, // ✅ preferred key for frontend
  });
});

// BOM editing from exsisting records - PostgraSQL to UI
app.use("/api/tables", tableRoutes);

/* =============================
   ✅ Health Check
============================= */
app.get("/health", (req, res) => {
  res.json({ status: "UP" });
});

/* =============================
   ✅ Root
============================= */
app.get("/", (req, res) => {
  res.send("✅ BOM API Server Running");
});

/* =============================
   ✅ Start Server
============================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});