/* modifyentryValidation.js
   Validation for Modify Existing BOM flow.
   Scope intentionally limited to:
   - component items / standard usage
   - co-products / qty produced
   - resource
   - routing ID
   - item BOM routing priority
*/

const norm = (value) => String(value ?? "").trim();
const ensureArray = (value) => (Array.isArray(value) ? value : []);
const toNum = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};
const isInt = (value) => Number.isInteger(Number(value));

const buildErrorRow = ({
  table = "MODIFY_ENTRY",
  record = "NULL",
  bomId = "",
  item = "",
  location = "",
  routingId = "",
  field = "",
  seq,
  validation,
  error,
  rm,
}) => ({
  table,
  bomId: bomId || "NULL",
  gcpRecId: "NULL",
  csvRecId: record != null ? String(record) : "NULL",
  item: item || "",
  location: location || "",
  routingId: routingId || "",
  recordId: `${table}__${record ?? "NULL"}__${bomId || "NULL"}__${item || ""}__${location || ""}__${routingId || ""}__${field || ""}`,
  field,
  messages: [
    {
      seq,
      validationSequence: seq,
      validation,
      errorDetails: error,
      remediationMessage: rm,
      desc: validation,
      error,
      rm,
      values: { bomId, item, location, routingId, field },
    },
  ],
});

const getResourceFromRoutingId = (routingId) => {
  const parts = norm(routingId)
    .split("_")
    .map((part) => part.trim())
    .filter(Boolean);

  return parts.length >= 3 && parts[0].toUpperCase() === "ROUTING"
    ? parts.slice(2).join("_")
    : "";
};

const buildRoutingId = (item, resource) => {
  const cleanItem = norm(item);
  const cleanResource = norm(resource);
  if (!cleanItem || !cleanResource) return "";
  return `ROUTING_${cleanItem}_${cleanResource}`;
};

const getComponentItem = (component) =>
  norm(component?.componentItem ?? component?.component_item ?? component?.item);

const getComponentUsage = (component) =>
  component?.standardUsage ??
  component?.standard_usage ??
  component?.erp_bom_quantity_consumed_per ??
  "";

const getCoProductItem = (cp) =>
  norm(cp?.coProductItem ?? cp?.co_product_item ?? cp?.item);

const getCoProductQty = (cp) =>
  cp?.standardUsage ??
  cp?.qtyProducedPer ??
  cp?.qtyProduced ??
  cp?.qty ??
  cp?.erp_bom_qty_produced_per ??
  "";

const getCoProductPriority = (cp) =>
  cp?.itemBomRoutingPriority ??
  cp?.item_bom_routing_priority ??
  cp?.erp_item_bom_routing_priority ??
  cp?.routingPriority ??
  "";

export function validateModifyEntryPayload(payload = {}) {
  const failures = [];

  const bomId = norm(payload?.bomId);
  const producedItem = norm(payload?.producedItem?.item ?? payload?.producedItem);
  const locations = ensureArray(payload?.locations);

  if (!bomId) {
    failures.push(
      buildErrorRow({
        table: "MODIFY_BOM",
        seq: "M1001",
        field: "bomId",
        validation: "BOM ID is required for modify BOM submission.",
        error: "The modify BOM payload does not contain bomId.",
        rm: "Select an existing BOM again and submit the modification.",
      })
    );
  }

  if (!locations.length) {
    failures.push(
      buildErrorRow({
        table: "MODIFY_BOM",
        bomId,
        seq: "M1002",
        field: "locations",
        validation: "At least one location is required.",
        error: "The modify BOM payload does not contain location data.",
        rm: "Return to the modify page and select a valid BOM/location.",
      })
    );
  }

  locations.forEach((locationRow, locationIndex) => {
    const location = norm(locationRow?.locationName ?? locationRow?.locationId ?? locationRow?.location);
    const resourceInfo = locationRow?.resourceInfo || {};
    const resource = norm(resourceInfo?.resource) || getResourceFromRoutingId(resourceInfo?.routingId);
    const routingId = norm(resourceInfo?.routingId) || buildRoutingId(producedItem, resource);
    const priority = resourceInfo?.priority;
    const componentItems = ensureArray(locationRow?.componentItems);
    const coProductItems = ensureArray(locationRow?.coProductItems ?? locationRow?.coProducts);

    if (!location) {
      failures.push(
        buildErrorRow({
          table: "MODIFY_LOCATION",
          record: locationIndex + 1,
          bomId,
          item: producedItem,
          seq: "M1003",
          field: "location",
          validation: "Location is required.",
          error: "Location is blank in modify BOM payload.",
          rm: "Select a valid existing BOM/location before submit.",
        })
      );
    }

    if (!resource) {
      failures.push(
        buildErrorRow({
          table: "ITEM_BOM_ROUTING",
          record: `${locationIndex + 1}.R`,
          bomId,
          item: producedItem,
          location,
          routingId,
          seq: "M1018",
          field: "resource",
          validation: "Resource is required for routing.",
          error: `Resource is blank for BOM "${bomId}" at location "${location}".`,
          rm: "Select a resource or ensure routing ID contains ROUTING_item_resource.",
        })
      );
    }

    if (!routingId) {
      failures.push(
        buildErrorRow({
          table: "ITEM_BOM_ROUTING",
          record: `${locationIndex + 1}.R`,
          bomId,
          item: producedItem,
          location,
          routingId,
          seq: "M1019",
          field: "routingId",
          validation: "Routing ID is required.",
          error: `Routing ID is blank for BOM "${bomId}" at location "${location}".`,
          rm: "Provide or derive Routing ID in the format ROUTING_item_resource.",
        })
      );
    }

    if (priority !== "" && priority !== null && priority !== undefined && !isInt(priority)) {
      failures.push(
        buildErrorRow({
          table: "ITEM_BOM_ROUTING",
          record: `${locationIndex + 1}.R`,
          bomId,
          item: producedItem,
          location,
          routingId,
          seq: "M1021",
          field: "itemBomRoutingPriority",
          validation: "Item BOM Routing Priority must be an integer.",
          error: `Routing priority "${priority}" is not a whole number.`,
          rm: "Enter a whole number for Item BOM Routing Priority.",
        })
      );
    }

    const seenComponents = new Set();
    componentItems.forEach((component, componentIndex) => {
      const componentItem = getComponentItem(component);
      const standardUsage = getComponentUsage(component);
      const usageNum = toNum(standardUsage);
      const key = `${bomId}__${location}__${componentItem}`.toUpperCase();

      if (!componentItem) {
        failures.push(
          buildErrorRow({
            table: "BOM_CONSUMED",
            record: `${locationIndex + 1}.C${componentIndex + 1}`,
            bomId,
            location,
            field: "componentItem",
            seq: "M1010",
            validation: "Component item is required.",
            error: "A component row has a blank component item.",
            rm: "Select a component item or remove the blank component row.",
          })
        );
      }

      if (!(usageNum > 0)) {
        failures.push(
          buildErrorRow({
            table: "BOM_CONSUMED",
            record: `${locationIndex + 1}.C${componentIndex + 1}`,
            bomId,
            item: componentItem,
            location,
            field: "standardUsage",
            seq: "M1011",
            validation: "Component standard usage must be greater than 0.",
            error: `Component "${componentItem || "blank"}" has invalid standard usage "${standardUsage}".`,
            rm: "Enter a positive Standard Usage for every component row.",
          })
        );
      }

      if (componentItem && seenComponents.has(key)) {
        failures.push(
          buildErrorRow({
            table: "BOM_CONSUMED",
            record: `${locationIndex + 1}.C${componentIndex + 1}`,
            bomId,
            item: componentItem,
            location,
            field: "componentItem",
            seq: "M1012",
            validation: "Duplicate component item for the same BOM/location is not allowed.",
            error: `Component "${componentItem}" is duplicated for BOM "${bomId}" at location "${location}".`,
            rm: "Remove the duplicate component row.",
          })
        );
      }

      if (componentItem) seenComponents.add(key);
    });

    const seenCoProducts = new Set();
    const seenRoutingRows = new Set();
    const seenPriorities = new Set();

    const addDuplicatePriorityError = ({ priorityValue, record, item, routingId }) => {
      failures.push(
        buildErrorRow({
          table: "ITEM_BOM_ROUTING",
          record,
          bomId,
          item,
          location,
          routingId,
          field: "itemBomRoutingPriority",
          seq: "M1020",
          validation: "Duplicate priority for the same BOM is not allowed.",
          error: `Duplicate Item BOM Routing Priority "${priorityValue}" found for BOM "${bomId}".`,
          rm: "Use a unique Item BOM Routing Priority within the BOM.",
        })
      );
    };

    if (priority !== "" && priority !== null && priority !== undefined) {
      const mainPriorityKey = `${bomId}__${priority}`.toUpperCase();
      if (seenPriorities.has(mainPriorityKey)) {
        addDuplicatePriorityError({
          priorityValue: priority,
          record: `${locationIndex + 1}.R`,
          item: producedItem,
          routingId,
        });
      }
      seenPriorities.add(mainPriorityKey);
    }

    coProductItems.forEach((cp, cpIndex) => {
      const coProductItem = getCoProductItem(cp);
      const qty = getCoProductQty(cp);
      const qtyNum = toNum(qty);
      const cpResource = norm(cp?.resource) || getResourceFromRoutingId(cp?.routingId) || resource;
      const cpRoutingId = norm(cp?.routingId) || buildRoutingId(producedItem, cpResource);
      const cpPriority = getCoProductPriority(cp);
      const coProductKey = `${bomId}__${location}__${coProductItem}`.toUpperCase();
      const routingKey = `${bomId}__${cpRoutingId}__${coProductItem}`.toUpperCase();
      const priorityKey = `${bomId}__${cpPriority}`.toUpperCase();

      if (!coProductItem) {
        failures.push(
          buildErrorRow({
            table: "BOM_PRODUCED",
            record: `${locationIndex + 1}.CP${cpIndex + 1}`,
            bomId,
            location,
            field: "coProductItem",
            seq: "M1008",
            validation: "Co-product item is required.",
            error: "A co-product row has a blank item.",
            rm: "Select a co-product item or remove the blank co-product row.",
          })
        );
      }

      if (!(qtyNum > 0 && qtyNum < 1)) {
        failures.push(
          buildErrorRow({
            table: "BOM_PRODUCED",
            record: `${locationIndex + 1}.CP${cpIndex + 1}`,
            bomId,
            item: coProductItem,
            location,
            field: "qtyProduced",
            seq: "M1009",
            validation: "Co-product Qty Produced must be greater than 0 and less than 1.",
            error: `Co-product "${coProductItem || "blank"}" has invalid Qty Produced "${qty}".`,
            rm: "Enter a Qty Produced value between 0 and 1.",
          })
        );
      }

      if (!cpResource) {
        failures.push(
          buildErrorRow({
            table: "ITEM_BOM_ROUTING",
            record: `${locationIndex + 1}.CP${cpIndex + 1}.R`,
            bomId,
            item: coProductItem,
            location,
            routingId: cpRoutingId,
            field: "resource",
            seq: "M1018",
            validation: "Resource is required for co-product routing.",
            error: `Resource is blank for co-product "${coProductItem}".`,
            rm: "Select a resource for the co-product row.",
          })
        );
      }

      if (!cpRoutingId) {
        failures.push(
          buildErrorRow({
            table: "ITEM_BOM_ROUTING",
            record: `${locationIndex + 1}.CP${cpIndex + 1}.R`,
            bomId,
            item: coProductItem,
            location,
            routingId: cpRoutingId,
            field: "routingId",
            seq: "M1019",
            validation: "Routing ID is required for co-product routing.",
            error: `Routing ID is blank for co-product "${coProductItem}".`,
            rm: "Provide or derive Routing ID in the format ROUTING_item_resource.",
          })
        );
      }

      if (cpPriority === "" || cpPriority === null || cpPriority === undefined || !isInt(cpPriority)) {
        failures.push(
          buildErrorRow({
            table: "ITEM_BOM_ROUTING",
            record: `${locationIndex + 1}.CP${cpIndex + 1}.R`,
            bomId,
            item: coProductItem,
            location,
            routingId: cpRoutingId,
            field: "itemBomRoutingPriority",
            seq: "M1021",
            validation: "Item BOM Routing Priority is required and must be an integer.",
            error: `Co-product "${coProductItem || "blank"}" has invalid priority "${cpPriority}".`,
            rm: "Enter a whole number for Item BOM Routing Priority.",
          })
        );
      }

      if (coProductItem && seenCoProducts.has(coProductKey)) {
        failures.push(
          buildErrorRow({
            table: "BOM_PRODUCED",
            record: `${locationIndex + 1}.CP${cpIndex + 1}`,
            bomId,
            item: coProductItem,
            location,
            field: "coProductItem",
            seq: "M1006",
            validation: "Duplicate co-product item for the same BOM/location is not allowed.",
            error: `Co-product "${coProductItem}" is duplicated for BOM "${bomId}" at location "${location}".`,
            rm: "Remove duplicate co-product rows for the same BOM/location.",
          })
        );
      }

      if (cpRoutingId && coProductItem && seenRoutingRows.has(routingKey)) {
        failures.push(
          buildErrorRow({
            table: "ITEM_BOM_ROUTING",
            record: `${locationIndex + 1}.CP${cpIndex + 1}.R`,
            bomId,
            item: coProductItem,
            location,
            routingId: cpRoutingId,
            field: "routingId",
            seq: "M1019",
            validation: "Duplicate item/BOM/routing combination is not allowed.",
            error: `Duplicate routing row found for item "${coProductItem}", BOM "${bomId}", routing "${cpRoutingId}".`,
            rm: "Remove duplicate routing rows.",
          })
        );
      }

      if (cpPriority !== "" && cpPriority !== null && cpPriority !== undefined && seenPriorities.has(priorityKey)) {
        addDuplicatePriorityError({
          priorityValue: cpPriority,
          record: `${locationIndex + 1}.CP${cpIndex + 1}.R`,
          item: coProductItem,
          routingId: cpRoutingId,
        });
      }

      if (coProductItem) seenCoProducts.add(coProductKey);
      if (cpRoutingId && coProductItem) seenRoutingRows.add(routingKey);
      if (cpPriority !== "" && cpPriority !== null && cpPriority !== undefined) seenPriorities.add(priorityKey);
    });
  });

  const errorCodes = [
    ...new Set(
      failures.flatMap((row) =>
        ensureArray(row?.messages).map((m) => m?.validationSequence).filter(Boolean)
      )
    ),
  ];

  return {
    isValid: failures.length === 0,
    success: failures.length === 0,
    status: failures.length === 0 ? "success" : "failure",
    errorCodes,
    errorList: failures,
    validationErrors: failures,
  };
}

export default validateModifyEntryPayload;
