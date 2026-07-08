export const validationRules = {

  1001: {
    desc: "Check if BOMID exists in both BOM Produced and Item BOM Routing",
    error: "This BOMID = <value/Values> does not exist in ( bom_produced.bom_id \nand/or item_bom_routing.bom_id )",
    rm: "RM: . Please ADD the missing bom_id records to bom_produced.bom_id  and/or item_bom_routing.bom_id\nRS:  Allow users to add the missing bom_id records to bom_produced.bom_id  and/or item_bom_routing.bom_id using ADD buttons"
  },

  1002: {
    desc: "Check for any duplicate BOMIDs",
    error: "There are duplicate values for this BOMID = <value>",
    rm: "RM: Please DELETE this extra bom_id record\nRS:  Allow users to DELETE the extra bom_id records using DELETE buttons"
  },

  1003: {
    desc: "Check if Item is marked as ACTIVE within Item Master (bom_parameters)",
    error: "This (item number) = <derivedvalue> in bom_parameters.bom_id is not with  item_master.ITEM_STATUS = ACTIVE.\n<Derivedvalue> = Text after the first _ (underscore) and second _(underscore) in bom_parameters.bom_id",
    rm: "RS:  Show all the record details from bom_parameters, bom_produced, bom_consumed and item_bom_routing for this INACTIVE item in a popup window or new form"
  },

  1005: {
    desc: "Check if BOMID exists in both BOM Parameters and Item BOM Routing",
    error: "This BOMID = <value> does not exist in ( bom_parameters.bom_id and/or item_bom_routing.bom_id )",
    rm: "RM: . Please ADD the missing bom_id records to bom_parameters.bom_id  and/or item_bom_routing.bom_id\nRS:  Allow users to add the missing bom_id records to bom_parameters.bom_id  and/or item_bom_routing.bom_id using ADD buttons"
  },

  1006: {
    desc: "Check for any duplicate BOMIDs (accounting for if there are Co-Products attached)",
    error: "There are duplicate values for this BOMID = <value>",
    rm: "RM: Please DELETE this extra bom_id record\nRS:  Allow users to DELETE the extra bom_id records using DELETE buttons"
  },

  1007: {
    desc: "For Co-Product Records, check if there is a corresponding record in Item BOM Routing that has Co Product Association value of 1",
    error: "This item, location combination with erp_bom_qty_produced_per = <value> does not exist in item_bom_routing with  erp_co_product_association=1",
    rm: "RM: Please ADD the missing CoProduct Record to item_bom_routing with erp_co_product_association=1 for this item, location combination\nRS:  Show the Relevant CoProduct Records in a Popup or new window  & Allow users to add the missing Coproduct records to item_bom_routing using ADD button"
  },

  1008: {
    desc: "Check that every Quantity Produced Per value is equal to 1 (or greater than zero in the case of Co-Products)",
    error: "This item= <value>, location= <value> combination with erp_bom_qty_produced_per = <value>  is less than zero or greater than 1",
    rm: "RM: Please MODIFY the erp_bom_qty_produced_per to  (> 0 or <= 1 ) for this item, location combination\nRS:  Show the Relevant CoProduct Records in a Popup or new window  & Allow users to update this erp_bom_qty_produced_per values using MODIFY/UPDATE button"
  },

  1009: {
    desc: "Check if Item is marked as ACTIVE within Item Master (for bom_produced)",
    error: "This item = <value> or bom item = <Derivedvalue> is not with  item_master.ITEM_STATUS = ACTIVE.\n<Derivedvalue> = Text after the first _ (underscore) and second _(underscore) in bom_produced.bom_id",
    rm: "RS:  Show all the record details from bom_parameters, bom_produced, bom_consumed and item_bom_routing for this INACTIVE (item or bom item) in a popup window or new window/form"
  },

  1010: {
    desc: "Check that every Quantity Consumed Per is greater than 0",
    error: "This item, location combination with erp_bom_quantity_consumed_per = <value>  is less than zero",
    rm: "RM: Please MODIFY the erp_bom_quantity_consumed_per to  (> 0 ) for this item, location combination\nRS:  Show the Relevant Records in a Popup or new window  & Allow users to update this erp_bom_quantity_consumed_per value using MODIFY/UPDATE button"
  },

  1011: {
    desc: "Check that every BOMID exists in BOM Produced",
    error: "This BOMID = <value> does not exist in ( bom_produced.bom_id)",
    rm: ""
  },

  1012: {
    desc: "Check for any duplicate combinations of BOMID and Consumed item",
    error: "There are duplicate values for this BOMID = <value>, item = <item> and location = <location>",
    rm: "RM: Please DELETE this extra bom_id records \nRS:  Allow users to DELETE the extra (bom_id, item, location) records using DELETE buttons"
  },

  1013: {
    desc: "Check for any recursive records (item shown in the BOMID is the same as the item in the consumed item column)",
    error: "This item=<item>, location=<location>, bomid = <bom_id> is a recursive consumption",
    rm: "RM: Please MODIFY/UPDATE the Consumed Item for this  bom_id, item, location combination  or Please DELETE this bom_id, item, location combination from bom_consumed to avoid recursive consumption\nRS:  Show the Relevant Records in a Popup or new window  & Allow users to update/delete records"
  },

  1014: {
    desc: "Check if Item is marked as ACTIVE within Item Master (for consumed items)",
    error: "This item = <value> or bom item = <Derivedvalue> is not with  item_master.ITEM_STATUS = ACTIVE.  Cons Item Status = <statusvalue> , BOM Item Status = <statusvalue>",
    rm: "RS:  Show all the record details from all tables for this INACTIVE item"
  },

  1015: {
    desc: "Check if the Resource exists in the Routing Resource Constraints table",
    error: "The routing_id = <value> does not exist in routing_rescons.routing_id with the same item= <Derivedvalue-1> and location <Derivedvalue-2>",
    rm: "RM: These Routings do not exist\nRS: Show records"
  },

  1016: {
    desc: "Check if the Resource is mapped as MPS",
    error: "This resource = <value> corresponding to item_bom_routing.routing_id is not mapped to MPS",
    rm: "RM: These Resources are not mapped to MPS\nRS: Show resource records"
  },

  1017: {
    desc: "Check Co-Product mapping",
    error: "This item= <Value>, location= <Derivedvalue> combination with erp_co_product_association= 1 does not exist in bom_produced with  erp_bom_qty_produced_per < 1",
    rm: "RM: Please ADD the missing CoProduct Record\nRS: Allow update/add"
  },

  1018: {
    desc: "Check if each BOMID exists in both BOM Parameters and BOM Produced",
    error: "This BOMID = <value/Values> does not exist in ( bom_produced.bom_id \nand/or bom_parameters.bom_id )",
    rm: "RM: . Please ADD the missing bom_id records\nRS:  Allow users to add records"
  },

  1019: {
    desc: "Check duplicate combinations",
    error: "There are duplicate values for this BOMID = <value>, item = <item> and routing_id = <routing_id>",
    rm: "RM: Please DELETE duplicate records\nRS: Allow delete"
  },

  1020: {
    desc: "Check duplicate priority",
    error: "There are duplicate values for this BOMID = <value> and erp_item_bom_routing_priority = <erp_item_bom_routing_priority>",
    rm: ""
  },

  1021: {
    desc: "Check priority integer",
    error: "The bom_id = <bom_id> with erp_item_bom_routing_priority = <value> is not a integer",
    rm: "RM: Please MODIFY the erp_item_bom_routing_priority to Integer\nRS: Allow update"
  },

  1022: {
    desc: "Check Item ACTIVE in routing",
    error: "This item = <value> or bom item = <Derivedvalue> is not with  item_master.ITEM_STATUS = ACTIVE.",
    rm: "RS: Show inactive item records"
  }

};