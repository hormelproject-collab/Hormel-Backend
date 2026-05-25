import dotenv from "dotenv";
dotenv.config(); // MUST be first

import express from "express";
import cors from "cors";

// ✅ Updated imports (after renaming)
import bigqueryRoutes from "./src/routes/bigqueryRoutes.js";
import bomRoutes from "./src/routes/bomRoutes.js";
import tableRoutes from "./src/routes/tableRoutes.js";

const app = express();

app.use(express.json());


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

// Example:
// http://localhost:3000/api/bigquery/table/item_master?limit=10
// http://localhost:3000/api/bigquery/table/location_master

/* =============================
   ✅ BOM APIs 
============================= */

// BOM Creation - UI to PostgraSQL
app.use("/api/bom/explosion", bomRoutes);

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
