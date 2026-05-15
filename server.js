import dotenv from "dotenv";
dotenv.config(); // MUST be first

import express from "express";

// ✅ Updated imports (after renaming)
import bigqueryRoutes from "./src/routes/bigqueryRoutes.js";
import bomRoutes from "./src/routes/bomRoutes.js";

const app = express();

app.use(express.json());

/* =============================
   ✅ BigQuery APIs
============================= */
console.log("✅ BigQuery routes loaded");

app.use("/api/bigquery/table", bigqueryRoutes);

// Example:
// http://localhost:3000/api/bigquery/table/item_master?limit=10
// http://localhost:3000/api/bigquery/table/location_master

/* =============================
   ✅ BOM APIs
============================= */
app.use("/api/bom/explosion", bomRoutes);

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
