// One payment calculation, end to end, for both callers: the copilot's calculate_payment tool and
// the "Show payment options" button. Resolves the inputs (the application's values win over the
// tool arguments), prices through the calculator as a logged LIVE tool call, stores the Options
// record, and builds the `options` stream line. The model never sees a cents value: its tool
// result is pre-formatted strings.

import { formatApr, formatMoney } from "@shared/format";
import type {
  CalculatorResult,
  Catalog,
  InputsSource,
  OptionsRecord,
  StreamLine,
} from "@shared/schemas";
import type { ProductId } from "@shared/catalog-ids";
import { newOptionsId, storeOptions } from "../commands.js";
import type { Ctx } from "../audit-log.js";
import { CommandError } from "../errors.js";
import { calculate, calculatorValues } from "../domain/payments/calculator.js";
import { renderChatFooter, renderDisclosureBlock, renderOptionsDisplay } from "../domain/disclosures/template.js";
import { withToolCall } from "../services/index.js";
import { store } from "../store.js";

export type OptionsLine = Extract<StreamLine, { type: "options" }>;

export interface PriceRequest {
  /** The catalog snapshot to price from (read through the catalog service by the caller). */
  catalog: Catalog;
  /** The model's amount in cents; null when there is none (the button). */
  amount_arg: number | null;
  /** The model's term in months; null when none. */
  term_arg: number | null;
  /** The products to price; absent or empty means all. */
  product_ids?: readonly ProductId[];
}

export interface PricedOptions {
  record: OptionsRecord;
  line: OptionsLine;
  /** Differences between the arguments and the values the application supplied, for the model. */
  notes: string[];
  /** The `tool.call` event of the calculation. */
  tool_event_id: string;
  /** The `options.stored` event. */
  stored_event_id: string;
}

interface ResolvedInputs {
  amount_cents: number;
  term_months: number | null;
  inputs_source: InputsSource;
  notes: string[];
}

/** The application's requested loan amount and preferred term win; the arguments fill what the form lacks. */
export function resolveInputs(applicationId: string, request: Pick<PriceRequest, "amount_arg" | "term_arg">): ResolvedInputs {
  const fields = store.getApplication(applicationId)?.fields ?? {};
  const notes: string[] = [];

  const formAmount = fields.requested_loan_amount?.value;
  let amount_cents: number;
  let amountSource: InputsSource["amount"];
  if (typeof formAmount === "number") {
    amount_cents = formAmount;
    amountSource = "form";
    if (request.amount_arg !== null && request.amount_arg !== formAmount) {
      notes.push(
        `The amount given (${formatMoney(request.amount_arg)}) differs from the application's requested loan amount; the options use the application's ${formatMoney(formAmount)}.`,
      );
    }
  } else if (request.amount_arg !== null) {
    amount_cents = request.amount_arg;
    amountSource = "argument";
  } else {
    throw new CommandError("There is no loan amount to price yet.", { status: 400 });
  }

  const formTerm = fields.preferred_term_months?.value;
  let term_months: number | null;
  let termSource: InputsSource["term"];
  if (formTerm !== undefined && Number.isInteger(Number(formTerm))) {
    term_months = Number(formTerm);
    termSource = "form";
    if (request.term_arg !== null && request.term_arg !== term_months) {
      notes.push(
        `The term given (${request.term_arg} months) differs from the application's preferred term; the fixed-rate option uses ${term_months} months.`,
      );
    }
  } else if (request.term_arg !== null) {
    term_months = request.term_arg;
    termSource = "argument";
  } else {
    term_months = null;
    termSource = "catalog";
  }

  return { amount_cents, term_months, inputs_source: { amount: amountSource, term: termSource }, notes };
}

/** "$30,000.00 over 120 months": the inputs as the table shows them. */
export function inputsEcho(result: CalculatorResult): string {
  const amount = formatMoney(result.amount_cents);
  const fixed = result.options.find((option) => option.mechanic === "fixed");
  if (result.term_months !== null && fixed) {
    return `${amount} over ${result.term_months} months (${fixed.label})`;
  }
  const terms = [...new Set(result.options.map((option) => option.term_months))];
  return terms.length === 1 ? `${amount} over ${terms[0]} months` : amount;
}

/** The label under the table when an input came from the model's arguments rather than the application. */
export function argumentLabel(source: InputsSource): string | null {
  const amount = source.amount === "argument";
  const term = source.term === "argument";
  if (amount && term) return "based on an amount and a term not yet on the application";
  if (amount) return "based on an amount not yet on the application";
  if (term) return "based on a term not yet on the application";
  return null;
}

/**
 * Prices, logs, stores and describes one calculation. `ctx` carries the turn (or none, for the
 * button) and the parent event. The calculator runs as a LIVE `tool.call` that names the Options
 * record it produced. A bad amount or term throws a 400 `CommandError`; a catalog problem throws
 * `catalog.schema_mismatch`.
 */
export async function priceAndStore(ctx: Ctx, request: PriceRequest): Promise<PricedOptions> {
  const inputs = resolveInputs(ctx.application_id, request);
  const product_ids = request.product_ids && request.product_ids.length > 0 ? [...request.product_ids] : undefined;
  const options_id = newOptionsId();
  const systemCtx: Ctx = { ...ctx, actor: { type: "system", id: "copilot" } };

  const { result, event_id: tool_event_id } = await withToolCall(
    systemCtx,
    "calculator",
    "calculate",
    () =>
      calculate({
        amount_cents: inputs.amount_cents,
        term_months: inputs.term_months,
        products: request.catalog,
        ...(product_ids ? { product_ids } : {}),
      }),
    {
      input: {
        amount_cents: inputs.amount_cents,
        term_months: inputs.term_months,
        product_ids: product_ids ?? null,
        inputs_source: inputs.inputs_source,
      },
      options_id,
    },
  );

  const stored = storeOptions(
    { ...systemCtx, parent_event_id: tool_event_id },
    {
      options_id,
      ...(ctx.turn_id === undefined ? {} : { turn_id: ctx.turn_id }),
      calculator_output: result,
      inputs_source: inputs.inputs_source,
    },
  );

  const line: OptionsLine = {
    type: "options",
    options_id,
    calculator_result: result,
    inputs_echo: inputsEcho(result),
    inputs_source: inputs.inputs_source,
    argument_label: argumentLabel(inputs.inputs_source),
    options_display: renderOptionsDisplay(result.options),
    disclosure_block: renderDisclosureBlock(result.options),
    footer: renderChatFooter(),
  };
  return {
    record: stored.options,
    line,
    notes: inputs.notes,
    tool_event_id,
    stored_event_id: stored.event_id,
  };
}

/**
 * What the model reads back after calculate_payment: only strings, formatted by the shared
 * formatters and the disclosure template. It never receives integer cents to compute with.
 */
export function optionsToolResult(priced: PricedOptions): string {
  const { line, record, notes } = priced;
  const result = record.calculator_output;
  const options = result.options.map((option, index) => {
    const cells = line.disclosure_block.options[index];
    const years = calculatorValues(option).find((value) => value.endsWith(" years"));
    return {
      label: option.label,
      product: option.product_name,
      mechanic: option.mechanic,
      term: years ? `${option.term_months} months (${years})` : `${option.term_months} months`,
      apr: cells?.apr ?? formatApr(option.schedule_apr_bps ?? option.apr_bps),
      payments: cells?.schedule_line ?? null,
      ...(option.promo_months === undefined ? {} : { promotional_period: `${option.promo_months} months` }),
      ...(option.promo_apr_bps === undefined ? {} : { promotional_rate: formatApr(option.promo_apr_bps) }),
      ...(cells?.consequence_line ? { if_not_paid_in_full: cells.consequence_line } : {}),
      amount_financed: cells?.amount_financed ?? formatMoney(option.amount_financed_cents),
      finance_charge: cells?.finance_charge ?? formatMoney(option.finance_charge_cents),
      total_of_payments: cells?.total_of_payments ?? formatMoney(option.total_of_payments_cents),
    };
  });
  return JSON.stringify({
    amount_used: formatMoney(result.amount_cents),
    amount_from: line.inputs_source.amount === "form" ? "the application" : "the amount given",
    term_used: result.term_months === null ? "each product's own term" : `${result.term_months} months for the fixed-rate option`,
    notes,
    options,
  });
}
