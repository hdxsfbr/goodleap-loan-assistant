import type { DocumentSchema } from "./index.js";

/**
 * Contractor estimate. The total is compared to the requested loan amount: a request more than
 * 5% above the estimate total needs a question to the contractor.
 */
export const ESTIMATE_SCHEMA: DocumentSchema = {
  slot: "estimate",
  title: "Project estimate",
  description:
    "A contractor's estimate for a home improvement project: contractor name, project description, estimate date, itemized line items and a total amount.",
  fields: [
    {
      id: "contractor_name",
      label: "Contractor",
      type: "text",
      description: "The contractor or company that issued the estimate, usually the name at the top.",
    },
    {
      id: "project_description",
      label: "Project description",
      type: "text",
      description: "The one-line description of the project the estimate covers.",
    },
    {
      id: "estimate_date",
      label: "Estimate date",
      type: "date",
      description: "The date the estimate was issued.",
    },
    {
      id: "total_amount",
      label: "Total amount",
      type: "money",
      description: "The grand total of the estimate, not an individual line item.",
      compareTo: "requested_loan_amount",
      tolerance: { kind: "percent_over", percent: 5 },
      discrepancy_reason: "requested_amount_over_estimate",
    },
    {
      id: "line_item_count",
      label: "Line items",
      type: "integer",
      description: "The number of line items listed, if the estimate states a count.",
    },
  ],
};
