// import pkg from "pg";
// const { Pool } = pkg;

// const pool = new Pool({
//   user: "postgres",
//   host: "localhost",
//   database: "postgres", // change if using bom_db
//   password: "postgresql",
//   port: 5432,
// });

// export default pool;

import dotenv from "dotenv";
dotenv.config();

import pkg from "pg";
const { Pool } = pkg;

const dbConfig = {
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT || 5432),
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  ssl:
    process.env.PG_SSL === "true"
      ? { rejectUnauthorized: false }
      : false,
};

console.log("DEBUG postgresClient config:", {
  host: dbConfig.host,
  port: dbConfig.port,
  database: dbConfig.database,
  user: dbConfig.user,
  hasPassword: !!dbConfig.password,
  ssl: !!dbConfig.ssl,
});

const pool = new Pool(dbConfig);

pool.on("connect", () => {
  console.log("✅ PostgreSQL connected");
});

pool.on("error", (err) => {
  console.error("❌ PostgreSQL pool error:", err.message);
});

export default pool;