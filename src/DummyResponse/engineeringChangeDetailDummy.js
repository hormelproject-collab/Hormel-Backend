// backend/data/engineeringChangeDetailDummy.js

const engineeringChangeDetailById = {
  "EC-001234": {
    engineeringChangeId: "EC-001234",
    changeDate: "2026-04-21",
    changeType: "Modified",
    changedBy: "John Smith",

    bomRecordChanges: [
      { field: "Location", originalValue: "1", updatedValue: "1", changed: false },
      { field: "Produced Item", originalValue: "Item123", updatedValue: "Item123", changed: false },

      // highlighted rows in UI
      { field: "Resource", originalValue: "1_Resource1", updatedValue: "2_Resource2", changed: true },
      { field: "Item BOM Routing Priority", originalValue: "1", updatedValue: "2", changed: true },

      { field: "BOM Version", originalValue: "PRIMARY", updatedValue: "PRIMARY", changed: false },
      { field: "BOM ID", originalValue: "PRIMARY_Item123_1", updatedValue: "PRIMARY_Item123_1", changed: false },
      { field: "Routing ID", originalValue: "ROUTING_Item123_1_Resource1", updatedValue: "ROUTING_Item123_1_Resource1", changed: false },
      { field: "Component Item", originalValue: "Item100", updatedValue: "Item100", changed: false },

      // highlighted row in UI
      { field: "Standard Usage", originalValue: "0.0567", updatedValue: "0.1234", changed: true }
    ],

    coProductInformation: {
      original: "No co-product",
      updated: "No co-product"
    }
  },

  // Add another example id if needed
  "EC-001235": {
    engineeringChangeId: "EC-001235",
    changeDate: "2026-04-20",
    changeType: "Added",
    changedBy: "Jane Doe",
    bomRecordChanges: [
      { field: "Location", originalValue: "2", updatedValue: "2", changed: false },
      { field: "Produced Item", originalValue: "Item456", updatedValue: "Item456", changed: false },
      { field: "Standard Usage", originalValue: "-", updatedValue: "0.0500", changed: true }
    ],
    coProductInformation: { original: "No co-product", updated: "No co-product" }
  },
  "EC-001236": {
    engineeringChangeId: "EC-001236",
    changeDate: "2026-04-20",
    changeType: "Added",
    changedBy: "Jane Doe",
    bomRecordChanges: [
      { field: "Location", originalValue: "2", updatedValue: "2", changed: false },
      { field: "Produced Item", originalValue: "Item456", updatedValue: "Item456", changed: false },
      { field: "Standard Usage", originalValue: "-", updatedValue: "0.0500", changed: true }
    ],
    coProductInformation: { original: "No co-product", updated: "No co-product" }
  },
  "EC-001237": {
    engineeringChangeId: "EC-001237",
    changeDate: "2026-04-20",
    changeType: "Added",
    changedBy: "Jane Doe",
    bomRecordChanges: [
      { field: "Location", originalValue: "2", updatedValue: "2", changed: false },
      { field: "Produced Item", originalValue: "Item456", updatedValue: "Item456", changed: false },
      { field: "Standard Usage", originalValue: "-", updatedValue: "0.0500", changed: true }
    ],
    coProductInformation: { original: "No co-product", updated: "No co-product" }
  },
  "EC-001238": {
    engineeringChangeId: "EC-001238",
    changeDate: "2026-04-20",
    changeType: "Added",
    changedBy: "Jane Doe",
    bomRecordChanges: [
      { field: "Location", originalValue: "2", updatedValue: "2", changed: false },
      { field: "Produced Item", originalValue: "Item456", updatedValue: "Item456", changed: false },
      { field: "Standard Usage", originalValue: "-", updatedValue: "0.0500", changed: true }
    ],
    coProductInformation: { original: "No co-product", updated: "No co-product" }
  },
  "EC-001239": {
    engineeringChangeId: "EC-001239",
    changeDate: "2026-04-20",
    changeType: "Added",
    changedBy: "Jane Doe",
    bomRecordChanges: [
      { field: "Location", originalValue: "2", updatedValue: "2", changed: false },
      { field: "Produced Item", originalValue: "Item456", updatedValue: "Item456", changed: false },
      { field: "Standard Usage", originalValue: "-", updatedValue: "0.0500", changed: true }
    ],
    coProductInformation: { original: "No co-product", updated: "No co-product" }
  },
  "EC-001240": {
    engineeringChangeId: "EC-001240",
    changeDate: "2026-04-20",
    changeType: "Added",
    changedBy: "Jane Doe",
    bomRecordChanges: [
      { field: "Location", originalValue: "2", updatedValue: "2", changed: false },
      { field: "Produced Item", originalValue: "Item456", updatedValue: "Item456", changed: false },
      { field: "Standard Usage", originalValue: "-", updatedValue: "0.0500", changed: true }
    ],
    coProductInformation: { original: "No co-product", updated: "No co-product" }
  },
  "EC-001241": {
    engineeringChangeId: "EC-001241",
    changeDate: "2026-04-20",
    changeType: "Added",
    changedBy: "Jane Doe",
    bomRecordChanges: [
      { field: "Location", originalValue: "2", updatedValue: "2", changed: false },
      { field: "Produced Item", originalValue: "Item456", updatedValue: "Item456", changed: false },
      { field: "Standard Usage", originalValue: "-", updatedValue: "0.0500", changed: true }
    ],
    coProductInformation: { original: "No co-product", updated: "No co-product" }
  },
  "EC-001242": {
    engineeringChangeId: "EC-001242",
    changeDate: "2026-04-20",
    changeType: "Added",
    changedBy: "Jane Doe",
    bomRecordChanges: [
      { field: "Location", originalValue: "2", updatedValue: "2", changed: false },
      { field: "Produced Item", originalValue: "Item456", updatedValue: "Item456", changed: false },
      { field: "Standard Usage", originalValue: "-", updatedValue: "0.0500", changed: true }
    ],
    coProductInformation: { original: "No co-product", updated: "No co-product" }
  },
  "EC-001243": {
    engineeringChangeId: "EC-001243",
    changeDate: "2026-04-20",
    changeType: "Added",
    changedBy: "Jane Doe",
    bomRecordChanges: [
      { field: "Location", originalValue: "2", updatedValue: "2", changed: false },
      { field: "Produced Item", originalValue: "Item456", updatedValue: "Item456", changed: false },
      { field: "Standard Usage", originalValue: "-", updatedValue: "0.0500", changed: true }
    ],
    coProductInformation: { original: "No co-product", updated: "No co-product" }
  }
};

export default engineeringChangeDetailById;