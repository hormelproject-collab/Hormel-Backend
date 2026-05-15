import { BigQuery } from "@google-cloud/bigquery";

const bigquery = new BigQuery({
  projectId: process.env.GCP_PROJECT_ID,
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS
  // ✅ NO keyFilename needed
});

export default bigquery;
