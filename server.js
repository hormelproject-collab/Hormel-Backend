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
import engineeringChangeDetailById from "./src/DummyResponse/engineeringChangeDetailDummy.js"

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
   ✅ GET ENGINEERING CHANGES (LAST 30 DAYS ONLY)
------------------------------------------------------*/
app.get("/api/engineering-changes", (req, res) => {
  console.log("GET /api/engineering-changes");

  const today = new Date();
  const last30Days = new Date();
  last30Days.setDate(today.getDate() - 30);

  const result = engineeringChanges.filter((item) => {
    const d = new Date(item.changeDate);
    return d >= last30Days && d <= today;
  });

  res.status(200).json({
    page: 1,
    pageSize: result.length,
    totalCount: result.length,
    items: result,
  });
});

/* -----------------------------------------------------
   ✅ NEW: GET ENGINEERING CHANGE DETAIL (BY ID)
   Query Param: EngineeringchangeID=EC-001234
------------------------------------------------------*/
app.get("/api/engineering-changes/detail", (req, res) => {
  // ✅ Print the full incoming request URL
  console.log("🔵 Engineering Change Detail API:", req.originalUrl);

  // ✅ Print query params clearly
  console.log("🔵 Query Params:", req.query);

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