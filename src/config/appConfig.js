const appConfig = {
  bigQuery: {
    
    projectIds: {
      dev: "bommanagement",
      prd: "bommanagement",
    },
    datasetId: "bom_sandbox",
  
    tables: {
      bomParameters: "bom_parameters",
      bomProduced: "bom_produced",
      bomConsumed: "bom_consumed",
      itemBomRouting: "item_bom_routing",

      itemMaster: "item_master",
      itemReleaseFlag: "item_mrp_rls_flg",
      locationMaster: "location_master",
      routingRescons: "routing_rescons",
      resourceMaster: "resource_master",
    },
  },

  postgres: {
    schema: "public",
    database: "postgres",

    tables: {
      bomParameters: "bom_parameters",
      bomProduced: "bom_produced",
      bomConsumed: "bom_consumed",
      itemBomRouting: "item_bom_routing",

      itemMaster: "item_master",
      locationMaster: "location_master",
      itemReleaseFlag: "item_releaseflag",
      changeLog: "planning_bom_change_log_summary",
      itemDetails: "item_details",

      bomParametersOg: "bom_parameters_og",
      bomProducedOg: "bom_produced_og",
      bomConsumedOg: "bom_consumed_og",
      itemBomRoutingOg: "item_bom_routing_og",
    },

    columns: {
      postgresqlRecId: "postgresql_rec_id",
      recId: "rec_id",
      recordId: "record_id",
      bomId: "bom_id",
      item: "item",
      location: "location",
      routingId: "routing_id",
      engineeringChangeId: "engineering_change_id",
      changeType: "change_type",
      changeDate: "change_date",
      userName: "user_name",
      createdAt: "created_at",
      createdOn: "created_on",
      notes: "notes",
      summaryNotes: "summarynotes",
      changeSummary: "change_summary",
      sourceTable: "source_table",
      sourceRecId: "source_rec_id",
      originalRecId: "original_rec_id",
      loadDatetime: "load_datetime",

      erpBomQtyProducedPer: "erp_bom_qty_produced_per",
      erpBomQuantityConsumedPer: "erp_bom_quantity_consumed_per",
      erpBomComponentStartDate: "erp_bom_component_start_date",
      erpBomComponentEndDate: "erp_bom_component_end_date",
      erpItemBomRoutingPriority: "erp_item_bom_routing_priority",
      erpItemBomRoutingMinLotSize: "erp_item_bom_routing_min_lot_size",
      erpItemBomRoutingLotSizeIncrement:
        "erp_item_bom_routing_lot_size_increment",
      erpItemBomWipSweepPriority: "erp_item_bom_wip_sweep_priority",
      erpItemBomRoutingWipSweepPriority:
        "erp_item_bom_routing_wip_sweep_priority",
      erpItemBomRoutingMaxLotSize: "erp_item_bom_routing_max_lot_size",
      erpCoProductAssociation: "erp_co_product_association",
      erpBomStartDate: "erp_bom_start_date",
      erpBomEndDate: "erp_bom_end_date",
    },
  },
};

export default appConfig;