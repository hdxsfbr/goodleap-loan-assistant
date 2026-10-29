import type { DocumentSchema } from "./index.js";

/** Scope of work letter from the contractor to the homeowner. No value is compared to the application. */
export const SCOPE_LETTER_SCHEMA: DocumentSchema = {
  slot: "scope_letter",
  title: "Scope of work letter",
  description:
    "A letter from a contractor to a homeowner that sets out the scope of work for a home improvement project, the property address and the planned start date.",
  fields: [
    {
      id: "property_address",
      label: "Property address",
      type: "text",
      description: "The address of the property where the work will be carried out.",
    },
    {
      id: "scope_summary",
      label: "Scope of work",
      type: "text",
      description: "The one-line summary of the scope of work.",
    },
    {
      id: "start_date",
      label: "Start date",
      type: "date",
      description: "The estimated or planned date the work begins.",
    },
    {
      id: "contractor_name",
      label: "Contractor",
      type: "text",
      description: "The contractor or company that wrote the letter, usually the name at the top.",
    },
  ],
};
