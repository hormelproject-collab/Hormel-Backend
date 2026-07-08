import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
  user: "postgres",
  host: "localhost",
  database: "postgres", // change if using bom_db
  password: "postgresql",
  port: 5432,
});

export default pool;

