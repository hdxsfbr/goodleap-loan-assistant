import type { DocumentSchema } from "./index.js";

/**
 * Pay stub. Annualized income is derived by the review path from gross pay and pay frequency
 * (server/review/derived.ts), never read by the model, and is compared to the application's
 * stated annual income: outside plus or minus the larger of 10% and $5,000.
 */
export const PAY_STUB_SCHEMA: DocumentSchema = {
  slot: "pay_stub",
  title: "Pay stub",
  description:
    "A pay stub or earnings statement from an employer: pay period dates, pay frequency, gross pay, deductions, net pay and year-to-date totals for one employee.",
  fields: [
    {
      id: "employer_name",
      label: "Employer",
      type: "text",
      description:
        "The company that pays the wages, usually the name printed at the top of the stub. Not the employee's name.",
    },
    {
      id: "pay_period_start",
      label: "Pay period start",
      type: "date",
      description: "The first day of the pay period this stub covers.",
    },
    {
      id: "pay_period_end",
      label: "Pay period end",
      type: "date",
      description: "The last day of the pay period this stub covers. Not the pay date.",
    },
    {
      id: "pay_frequency",
      label: "Pay frequency",
      type: "enum",
      options: ["weekly", "biweekly", "semimonthly", "monthly"],
      description:
        "How often the employee is paid, as written on the stub (for example Weekly, Biweekly, Semi-monthly, Monthly).",
    },
    {
      id: "gross_pay",
      label: "Gross pay",
      type: "money",
      description:
        "Gross pay for this pay period, before taxes and deductions. Not the year-to-date figure and not net pay.",
    },
    {
      id: "net_pay",
      label: "Net pay",
      type: "money",
      description: "Take-home pay for this pay period, after taxes and deductions.",
    },
    {
      id: "ytd_gross",
      label: "Year-to-date gross",
      type: "money",
      description: "Gross pay accumulated so far this year (year to date), before taxes and deductions.",
    },
    {
      id: "annualized_income",
      label: "Annualized income",
      type: "money",
      description:
        "Gross pay for the period multiplied by the number of pay periods in a year for the pay frequency (weekly 52, biweekly 26, semimonthly 24, monthly 12).",
      compareTo: "stated_annual_income",
      tolerance: { kind: "percent_or_absolute", percent: 10, absolute: 500000 },
      discrepancy_reason: "income_outside_tolerance",
      derived: { formula: "annualized_income", inputs: ["gross_pay", "pay_frequency"] },
    },
  ],
};
