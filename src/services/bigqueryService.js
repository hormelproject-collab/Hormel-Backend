import bigquery from "../db/bigqueryClient.js";

// ✅ Allowed tables
const allowedTables = ["item_master", "location_master"];

// ✅ Allowed filters per table (VERY IMPORTANT)
const allowedFilters = {
  item_master: ["item_id", "item_name"],
  location_master: ["location_id", "location_name"]
};

export const fetchFromTable = async (tableName, filters = {}, limit = 10) => {
  try {
    // ✅ Validate table
    if (!allowedTables.includes(tableName)) {
      throw new Error("Invalid table name");
    }

    let whereConditions = [];

    // ✅ Build WHERE dynamically (SAFE)
    Object.keys(filters).forEach((key) => {
      if (allowedFilters[tableName]?.includes(key)) {
        whereConditions.push(`${key} = @${key}`);
      }
    });

    const whereClause =
      whereConditions.length > 0
        ? `WHERE ${whereConditions.join(" AND ")}`
        : "";

    const query = `
      SELECT *
      FROM \`${process.env.GCP_PROJECT_ID}.${process.env.BQ_DATASET}.${tableName}\`
      ${whereClause}
      LIMIT @limit
    `;
    // We used: @param instead of:'${value}' 
    //  This prevents SQL Injection
    //  BigQuery handles escaping

    const options = {
      query,
      params: {
        ...filters,
        limit: parseInt(limit)
      }
    };

    const [rows] = await bigquery.query(options);

    return rows;

  } catch (error) {
    console.error("BigQuery Service Error:", error);
    throw error;
  }
};