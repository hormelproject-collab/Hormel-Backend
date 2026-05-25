
import { BigQuery } from "@google-cloud/bigquery";
import path from "path";


const bigquery = new BigQuery({
  projectId: process.env.GCP_PROJECT_ID,
  keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS
});


export default bigquery;
