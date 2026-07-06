import dotenv from "dotenv";
dotenv.config();

console.log("DEBUG BQ_PROJECT_ID from server.js:", process.env.BQ_PROJECT_ID);
console.log("DEBUG BQ_DATASET from server.js:", process.env.BQ_DATASET);
console.log("DEBUG BQ_LOCATION from server.js:", process.env.BQ_LOCATION);
console.log(
  "DEBUG GOOGLE_APPLICATION_CREDENTIALS from server.js:",
  process.env.GOOGLE_APPLICATION_CREDENTIALS
);

import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import pool from "./src/db/postgresClient.js";


import bomExplosionRoute from "./src/routes/createbomliteRoute.js";
import bomDownloadRoutes from "./src/routes/bomDownload.routes.js";
import bigqueryRoutes from "./src/routes/bigqueryRoutes.js";
import engineeringChanges from "./src/DummyResponse/engineeringchanges.js";
import engineeringChangeDetailById from "./src/DummyResponse/engineeringChangeDetailDummy.js";
import bomValidateLoadRoutes from "./src/routes/bomValidateLoad.routes.js";
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

// one-time upload
app.use("/api/bom-upload", bomValidateLoadRoutes);
// BOM Explosion: create bom manual validation
app.use("/bom-explosion", bomExplosionRoute);
app.use("/api/bom-explosion", bomExplosionRoute);
// BOM editing from existing records - PostgreSQL to UI
app.use("/api/tables", tableRoutes);

app.get("/health", (req, res) => res.json({ status: "UP" }));
app.get("/", (req, res) => res.send("✅ BOM API Server Running"));

/* -----------------------------------------------------
   ✅ GET ENGINEERING CHANGE DETAIL (BY ID)
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
    data: detail,
  });
});

console.log("DEBUG DB USER from server.js:", process.env.PG_USER);
console.log("DEBUG DB HOST from server.js:", process.env.PG_HOST);
console.log("DEBUG DB NAME from server.js:", process.env.PG_DATABASE);

/* =============================
   ✅ PostgreSQL connection test
============================= */
(async () => {
  try {
    const client = await pool.connect();
    const result = await client.query(
      "SELECT current_database(), current_user, now()"
    );
    console.log("✅ PostgreSQL test connection successful:", result.rows[0]);
    client.release();
  } catch (err) {
    console.error("❌ PostgreSQL connection failed:", err.message);
  }
})();

/* =============================
   ✅ Start Server
============================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});