import dotenv from "dotenv";
dotenv.config();

import express from "express";
import fs from "fs";
import path from "path";

import sampleRoute from "./src/routes/route.js";
import bomExplosionRoute from "./src/routes/createbomliteRoute.js";
import bomDownloadRoutes from "./src/routes/bomDownload.routes.js";
import bigqueryRoutes from "./src/routes/bigqueryRoutes.js";


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

console.log("✅ BigQuery routes loaded");

app.use("/api/bigquery/table", bigqueryRoutes);
app.use("/api/bom", bomDownloadRoutes);
app.use("/api/bigquery", sampleRoute);

// BOM Explosion: CSV upload + manual validation
app.use("/bom-explosion", bomExplosionRoute);

app.get("/health", (req, res) => res.json({ status: "UP" }));
app.get("/", (req, res) => res.send("✅ BOM API Server Running"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});