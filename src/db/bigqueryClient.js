import { BigQuery } from "@google-cloud/bigquery";
import appConfig from "../config/appConfig.js";

const bigquery = new BigQuery({
  projectId: appConfig.bigQuery.projectIds.dev,
});

export default bigquery;