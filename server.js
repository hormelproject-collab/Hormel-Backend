import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";

import pool from "./src/db/postgresClient.js";
import cron from "node-cron";

import bomExplosionRoute from "./src/routes/createbomliteRoute.js";
import bomDownloadRoutes from "./src/routes/bomDownload.routes.js";
import bigqueryRoutes from "./src/routes/bigqueryRoutes.js";

import engineeringChanges from "./src/DummyResponse/engineeringchanges.js";
import engineeringChangeDetailById from "./src/DummyResponse/engineeringChangeDetailDummy.js";

import bomValidateLoadRoutes, {
  performScheduledGcpSync,
} from "./src/routes/bomValidateLoad.routes.js";

import tableRoutes from "./src/routes/tableRoutes.js";

const app = express();

// Increase payload limit because CSV parsed JSON can be large
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

const ROOT_DIR = process.cwd();
const UPLOAD_DIR = path.join(ROOT_DIR, "uploads");
const REPORT_DIR = path.join(ROOT_DIR, "reports");

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

if (!fs.existsSync(REPORT_DIR)) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });
}

/*
  CORS:
  - Local Vite frontend
  - Dev deployed frontend
  - Optional FRONTEND_ORIGIN env for future environments
*/
const allowedOrigins = [
  "http://localhost:5173",
  "https://planning-bom-dev.myhormel.com",
  process.env.FRONTEND_ORIGIN,
].filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Allow non-browser requests like health checks / server-to-server
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error(`CORS blocked origin: ${origin}`));
    },
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
  })
);


let lastFetchTime = null;

// 📍 Global Request Logging Middleware
app.use((req, res, next) => {
  console.log(`\n📡 [${new Date().toISOString()}] ${req.method} ${req.path}`);
  if (Object.keys(req.query).length > 0) {
    console.log("   Query:", req.query);
  }
  if (req.body && Object.keys(req.body).length > 0) {
    console.log("   Body:", req.body);
  }
  next();
});

/* BigQuery APIs - GCP to UI */
app.use("/api/bigquery/table", bigqueryRoutes);

/* BOM download routes */
app.use("/api/bom", bomDownloadRoutes);

/* One-time upload / scheduled sync */
app.use("/api/bom-upload", bomValidateLoadRoutes);

/* BOM Explosion: create BOM manual validation */
app.use("/bom-explosion", bomExplosionRoute);
app.use("/api/bom-explosion", bomExplosionRoute);

/* BOM editing from existing records - PostgreSQL to UI */
// 🧪 TEST ENDPOINT
app.get("/api/tables/test", (req, res) => {
  console.log("✅ /api/tables/test endpoint called");
  return res.json({
    status: "OK",
    message: "Table routes are working",
    timestamp: new Date().toISOString(),
  });
});

app.use("/api/tables", tableRoutes);

app.get("/health", (req, res) => {
  console.log("✅ Health check called");
  return res.json({ status: "UP", timestamp: new Date().toISOString() });
});

app.get("/", (req, res) => {
  return res.send("✅ BOM API Server Running");
});
app.get("/api/last-fetch-time", (req, res) => {
  return res.status(200).json({
    success: true,
    lastFetchTime,
  });
});
app.get("/api/engineering-changes", (req, res) => {
  return res.status(200).json({
    data: engineeringChanges,
  });
});

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

/* PostgreSQL connection test */
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

// 🚨 Error Handling Middleware (MUST be last)
app.use((err, req, res, next) => {
  console.error("\n❌ === UNHANDLED ERROR ===");
  console.error("Error Message:", err.message);
  console.error("Error Stack:", err.stack);
  console.error("Request URL:", req.url);
  console.error("Request Method:", req.method);
  
  res.status(err.status || 500).json({
    error: err.message,
    details: err.stack,
  });
});

// 404 Handler
app.use((req, res) => {
  console.warn(`⚠️ 404 Not Found: ${req.method} ${req.url}`);
  res.status(404).json({
    error: "Route not found",
    path: req.url,
    method: req.method,
  });
});

/* Start Server */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);

  const SCHEDULE_TIME = "0 6 * * *"; // 6:00 AM every day

  cron.schedule(
    SCHEDULE_TIME,
    async () => {
      try {
        await performScheduledGcpSync();

        lastFetchTime = new Date().toISOString();

        console.log("✅ Last fetch time updated:", lastFetchTime);
      } catch (error) {
        console.error("❌ Scheduled sync failed:", error);
      }
    },
    {
      timezone: "America/Chicago",
    }
  );
});