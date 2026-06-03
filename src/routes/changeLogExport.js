import express from "express";
import ExcelJS from "exceljs";
import { Pool } from "pg";

const router = express.Router();

const pool = new Pool({
  host: process.env.PG_HOST || "localhost",
  port: Number(process.env.PG_PORT || 5432),
  user: process.env.PG_USER || "postgres",
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,
});

function buildWhereClause(q, values) {
  const where = [];

  // Dates (assuming change_time is timestamp column)
  if (q.fromDate) {
    values.push(q.fromDate);
    where.push(`change_time >= $${values.length}`);
  }
  if (q.toDate) {
    values.push(q.toDate);
    where.push(`change_time <= $${values.length}`);
  }

  // User filter
  if (q.user) {
    values.push(q.user);
    where.push(`changed_by = $${values.length}`);
  }

  // My changes only (frontend should pass current userId/email; simplest approach is pass user in query)
  if (q.myChangesOnly === "true" && !q.user) {
    // If you have auth middleware, replace this with req.user.email etc.
    // For now, enforce explicit user to avoid guessing:
    where.push(`1=0`); // block if "myChangesOnly" true but no user provided
  }

  // Criteria 1 & 2 (map criteria labels -> columns)
  const criteriaToColumn = {
    "Location": "location",
    "BOM ID": "bom_id",
    "Resource": "resource",
    "Produced Item": "produced_item",
    "Component Item": "component_item",
    "Co-Product Item": "co_product_item",
  };

  if (q.criteria1 && q.value1 && criteriaToColumn[q.criteria1]) {
    values.push(q.value1);
    where.push(`${criteriaToColumn[q.criteria1]} = $${values.length}`);
  }

  if (q.criteria2 && q.value2 && criteriaToColumn[q.criteria2]) {
    values.push(q.value2);
    where.push(`${criteriaToColumn[q.criteria2]} = $${values.length}`);
  }

  return where.length ? `WHERE ${where.join(" AND ")}` : "";
}

router.get("/change-log/export", async (req, res) => {
  try {
    const values = [];
    const whereSql = buildWhereClause(req.query, values);

    /**
     * IMPORTANT:
     * Replace these table/queries with your real change log schema.
     * I’m using a generic `engineering_change_log` table as example.
     *
     * Expected columns used above:
     * change_time, changed_by, bom_id, location, resource, produced_item, component_item, co_product_item,
     * field_name, old_value, new_value, entity_type
     */

    const baseSql = `
      SELECT *
      FROM engineering_change_log
      ${whereSql}
      ORDER BY change_time DESC
      LIMIT 50000
    `;

    const { rows } = await pool.query(baseSql, values);

    // Create workbook
    const wb = new ExcelJS.Workbook();
    wb.creator = "BOM App";
    wb.created = new Date();

    // 1) High-Level Summary
    const wsSummary = wb.addWorksheet("High-Level Summary");
    wsSummary.addRow(["Metric", "Value"]);
    wsSummary.addRow(["Total Changes", rows.length]);

    // Group by entity_type (optional)
    const byEntity = rows.reduce((acc, r) => {
      const k = r.entity_type || "Unknown";
      acc[k] = (acc[k] || 0) + 1;
      return acc;
    }, {});
    Object.entries(byEntity).forEach(([k, v]) => wsSummary.addRow([`Changes - ${k}`, v]));
    wsSummary.columns.forEach(c => (c.width = 30));

    // 2) Main BOM Details
    const wsMain = wb.addWorksheet("Main BOM Details");
    wsMain.columns = [
      { header: "Change Time", key: "change_time", width: 22 },
      { header: "Changed By", key: "changed_by", width: 20 },
      { header: "BOM ID", key: "bom_id", width: 16 },
      { header: "Location", key: "location", width: 14 },
      { header: "Entity Type", key: "entity_type", width: 18 },
      { header: "Field Name", key: "field_name", width: 22 },
      { header: "Old Value", key: "old_value", width: 22 },
      { header: "New Value", key: "new_value", width: 22 },
    ];
    rows.forEach(r => wsMain.addRow(r));

    // 3) Component Details
    const wsComp = wb.addWorksheet("Component Details");
    wsComp.columns = [
      { header: "Change Time", key: "change_time", width: 22 },
      { header: "Changed By", key: "changed_by", width: 20 },
      { header: "BOM ID", key: "bom_id", width: 16 },
      { header: "Component Item", key: "component_item", width: 20 },
      { header: "Field Name", key: "field_name", width: 22 },
      { header: "Old Value", key: "old_value", width: 22 },
      { header: "New Value", key: "new_value", width: 22 },
    ];
    rows
      .filter(r => (r.entity_type || "").toLowerCase().includes("component") || r.component_item)
      .forEach(r => wsComp.addRow(r));

    // 4) Co-Product Details
    const wsCoProd = wb.addWorksheet("Co-Product Details");
    wsCoProd.columns = [
      { header: "Change Time", key: "change_time", width: 22 },
      { header: "Changed By", key: "changed_by", width: 20 },
      { header: "BOM ID", key: "bom_id", width: 16 },
      { header: "Co-Product Item", key: "co_product_item", width: 20 },
      { header: "Field Name", key: "field_name", width: 22 },
      { header: "Old Value", key: "old_value", width: 22 },
      { header: "New Value", key: "new_value", width: 22 },
    ];
    rows
      .filter(r => (r.entity_type || "").toLowerCase().includes("co") || r.co_product_item)
      .forEach(r => wsCoProd.addRow(r));

    // 5) Modified Field Comparison
    const wsCompare = wb.addWorksheet("Modified Field Comparison");
    wsCompare.columns = [
      { header: "BOM ID", key: "bom_id", width: 16 },
      { header: "Entity Type", key: "entity_type", width: 18 },
      { header: "Field Name", key: "field_name", width: 22 },
      { header: "Old Value", key: "old_value", width: 22 },
      { header: "New Value", key: "new_value", width: 22 },
      { header: "Change Time", key: "change_time", width: 22 },
      { header: "Changed By", key: "changed_by", width: 20 },
    ];
    rows.forEach(r => wsCompare.addRow(r));

    // Response headers for download
    const filename = `Filtered_Change_Log_${new Date().toISOString().slice(0,10)}.xlsx`;
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: e.message || "Failed to export change log" });
  }
});

export default router;