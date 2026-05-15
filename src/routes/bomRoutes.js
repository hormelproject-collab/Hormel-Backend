import express from "express";
import pool from "../db/postgresClient.js";

const router = express.Router();

/**
 * POST /bom-explosion
 * Body = {
 *   locations: [
 *     {
 *       locationId, locationName, region,
 *       finishedGoods: [
 *         {
 *           finishedGoodItem, resource, bomId, routingId,
 *           productsConsumed: [{ componentItem, quantity }]
 *         }
 *       ]
 *     }
 *   ]
 * }
 */
const bomRoutes = router.post("/", async (req, res) => {
  const payload = req.body;

  if (!payload?.locations?.length) {
    return res.status(400).json({
      success: false,
      message: "Invalid payload: locations[] is required",
    });
  }

  // Collect minimal rows to insert
  const rows_bom_parameters = []; // { bom_id, load_datetime }
  const rows_bom_produced = [];   // { bom_id, item, location, load_datetime }
  const rows_item_bom_routing = []; // { bom_id, item, routing_id, load_datetime }
  const rows_bom_consumed = [];   // { bom_id, item(componentItem), location, load_datetime }

  const nowIso = new Date().toISOString();

  for (const loc of payload.locations) {
    const locationValue = loc.locationName ?? loc.locationId ?? null;

    if (!locationValue) continue;

    const finishedGoods = Array.isArray(loc.finishedGoods) ? loc.finishedGoods : [];
    for (const fg of finishedGoods) {
      const bom_id = fg?.bomId;
      const item = fg?.finishedGoodItem;
      const routing_id = fg?.routingId;

      if (!bom_id) continue;

      // bom_parameters: only BOM_ID
      rows_bom_parameters.push({ bom_id, load_datetime: nowIso });

      // bom_produced: BOM_ID + finishedGoodItem + location
      if (item) {
        rows_bom_produced.push({ bom_id, item, location: locationValue, load_datetime: nowIso });
      }

      // item_bom_routing: BOM_ID + finishedGoodItem + routing_id
      if (item && routing_id) {
        rows_item_bom_routing.push({ bom_id, item, routing_id, load_datetime: nowIso });
      }

      // bom_consumed: BOM_ID + componentItem + location
      const productsConsumed = Array.isArray(fg.productsConsumed) ? fg.productsConsumed : [];
      for (const pc of productsConsumed) {
        const componentItem = pc?.componentItem;
        if (!componentItem) continue;

        rows_bom_consumed.push({
          bom_id,
          item: componentItem,              // store consumed component item in bom_consumed.item
          location: locationValue,
          load_datetime: nowIso,
        });
      }
    }
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 1) bom_parameters
    // Insert only bom_id + load_datetime (other columns remain NULL)
    for (const r of rows_bom_parameters) {
      await client.query(
        `INSERT INTO bom_parameters (bom_id, load_datetime)
         VALUES ($1, $2)`,
        [r.bom_id, r.load_datetime]
      );
    }

    // 2) bom_produced
    for (const r of rows_bom_produced) {
      await client.query(
        `INSERT INTO bom_produced (bom_id, item, location, load_datetime)
         VALUES ($1, $2, $3, $4)`,
        [r.bom_id, r.item, r.location, r.load_datetime]
      );
    }

    // 3) item_bom_routing
    for (const r of rows_item_bom_routing) {
      await client.query(
        `INSERT INTO item_bom_routing (bom_id, item, routing_id, load_datetime)
         VALUES ($1, $2, $3, $4)`,
        [r.bom_id, r.item, r.routing_id, r.load_datetime]
      );
    }

    // 4) bom_consumed
    for (const r of rows_bom_consumed) {
      await client.query(
        `INSERT INTO bom_consumed (bom_id, item, location, load_datetime)
         VALUES ($1, $2, $3, $4)`,
        [r.bom_id, r.item, r.location, r.load_datetime]
      );
    }

    await client.query("COMMIT");

    return res.status(201).json({
      success: true,
      message: "Inserted minimal values into PostgreSQL BOM tables",
      counts: {
        bom_parameters: rows_bom_parameters.length,
        bom_produced: rows_bom_produced.length,
        item_bom_routing: rows_item_bom_routing.length,
        bom_consumed: rows_bom_consumed.length,
      },
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Postgres insert failed:", err);
    return res.status(500).json({
      success: false,
      message: "Insert failed",
      error: err.message,
    });
  } finally {
    client.release();
  }
});

export default bomRoutes;