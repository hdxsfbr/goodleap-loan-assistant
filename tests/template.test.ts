import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DisclosureBlockSchema,
  HomeownerViewPropsSchema,
  OptionDisplaySchema,
  type CalculatorResult,
  type DisclosureBlock,
  type HomeownerViewProps,
} from "@shared/schemas";
import { CATALOG } from "../server/domain/catalog.js";
import {
  CHAT_FOOTER,
  ESTIMATE_STATEMENT,
  FIXED_SENTENCE_FOR_TERM,
  RESPA_LINE,
  WHAT_HAPPENS_NEXT,
  fixedSentenceForTerm,
  renderChatFooter,
  renderDisclosureBlock,
  renderOptionsDisplay,
} from "../server/domain/disclosures/template.js";
import { calculate } from "../server/domain/payments/calculator.js";
import {
  SURFACES,
  composeHomeownerView,
  type BorrowerFacingMessage,
  type BorrowerFacingSurface,
} from "../server/domain/surfaces.js";
import { AppError } from "../server/errors.js";

// Item 76: the rendered block for case 1, case 3 and case 4. Plus the homeowner view that carries
// it (item 33), since a view cannot be composed without a block.

const AMOUNT_CENTS = 3_000_000;

function resultFor(...productIds: string[]): CalculatorResult {
  return calculate({
    amount_cents: AMOUNT_CENTS,
    term_months: null,
    products: CATALOG,
    ...(productIds.length > 0 ? { product_ids: productIds } : {}),
  });
}

/** Every string a block prints, in order, as the homeowner reads it. */
function blockText(block: DisclosureBlock): string {
  const lines: string[] = [];
  for (const option of block.options) {
    lines.push(
      option.label,
      option.apr,
      option.finance_charge,
      option.amount_financed,
      option.total_of_payments,
      option.schedule_line,
    );
    if (option.consequence_line) lines.push(option.consequence_line);
  }
  lines.push(block.estimate_statement, block.respa_line);
  return lines.join("\n");
}

describe("disclosure block", () => {
  it("case 1 (fixed): the four cells, a schedule line and the fixed statements", () => {
    const block = renderDisclosureBlock(resultFor("fixed_10y").options);
    expect(DisclosureBlockSchema.parse(block)).toEqual(block);
    expect(block.options).toEqual([
      {
        label: "Option A",
        product_id: "fixed_10y",
        apr: "9.99%",
        finance_charge: "$17,554.14",
        amount_financed: "$30,000.00",
        total_of_payments: "$47,554.14",
        schedule_line: "120 monthly payments of $396.29",
        consequence_line: null,
      },
    ]);
    expect(block.estimate_statement).toBe(ESTIMATE_STATEMENT);
    expect(block.respa_line).toBe(RESPA_LINE);
    expect(blockText(block)).toContain(ESTIMATE_STATEMENT);
    expect(blockText(block)).toContain(RESPA_LINE);
  });

  it("case 3 (zero intro): the promotional schedule line", () => {
    const block = renderDisclosureBlock(resultFor("zero_intro_18m").options);
    expect(block.options).toEqual([
      {
        label: "Option B",
        product_id: "zero_intro_18m",
        apr: "12.99%",
        finance_charge: "$16,741.93",
        amount_financed: "$30,000.00",
        total_of_payments: "$46,741.93",
        schedule_line: "18 monthly payments of $250.00, then 102 monthly payments of $414.14",
        consequence_line: null,
      },
    ]);
    expect(blockText(block)).toContain(ESTIMATE_STATEMENT);
    expect(blockText(block)).toContain(RESPA_LINE);
  });

  it("case 4 (deferred): the paid-in-full schedule and the consequence line", () => {
    const block = renderDisclosureBlock(resultFor("deferred_12m").options);
    expect(block.options).toEqual([
      {
        label: "Option C",
        product_id: "deferred_12m",
        apr: "17.99%",
        finance_charge: "$0.00",
        amount_financed: "$30,000.00",
        total_of_payments: "$30,000.00",
        schedule_line: "12 monthly payments of $2,500.00",
        consequence_line:
          "If the balance is not paid in full by month 12, $5,149.63 of interest is added and the payment becomes $602.83 for the remaining 108 months.",
      },
    ]);
    const text = blockText(block);
    expect(text).toContain("$5,149.63");
    expect(text).toContain("$602.83");
    expect(text).toContain(ESTIMATE_STATEMENT);
    expect(text).toContain(RESPA_LINE);
  });

  it("renders all three options in the order given, with the consequence only on the deferred one", () => {
    const result = resultFor();
    const block = renderDisclosureBlock(result.options);
    expect(block.options.map((option) => option.label)).toEqual(["Option A", "Option B", "Option C"]);
    expect(block.options.map((option) => option.consequence_line !== null)).toEqual([false, false, true]);
    for (const option of block.options) {
      expect(option.schedule_line.length).toBeGreaterThan(0);
      for (const cell of [option.apr, option.finance_charge, option.amount_financed, option.total_of_payments]) {
        expect(cell).toMatch(/^\$?[\d,]+\.\d{2}%?$/);
      }
    }
    const reversed = renderDisclosureBlock([...result.options].reverse());
    expect(reversed.options.map((option) => option.label)).toEqual(["Option C", "Option B", "Option A"]);
  });

  it("is a pure function of the options and leaves them untouched", () => {
    const result = resultFor();
    const before = structuredClone(result);
    const first = renderDisclosureBlock(result.options);
    const second = renderDisclosureBlock(result.options);
    expect(second).toEqual(first);
    expect(result).toEqual(before);
  });

  it("follows the term, not a fixed ten years, for a 60-month fixed option", () => {
    const result = calculate({
      amount_cents: AMOUNT_CENTS,
      term_months: 60,
      products: CATALOG,
      product_ids: ["fixed_10y"],
    });
    expect(renderDisclosureBlock(result.options).options[0]?.schedule_line).toBe(
      "60 monthly payments of $637.26",
    );
  });

  it("keeps the term-aware fixed sentence word for word with the catalog's, apart from the duration", () => {
    const catalogFixed = CATALOG.products.find((product) => product.id === "fixed_10y");
    expect(FIXED_SENTENCE_FOR_TERM).toContain("{term}");
    expect(FIXED_SENTENCE_FOR_TERM.replace("{term}", "ten years")).toBe(catalogFixed?.plain_sentence);
  });

  it("fills the fixed sentence with years for a whole number of years and months otherwise", () => {
    expect(fixedSentenceForTerm(60)).toBe("Option A is a fixed-rate loan: the same payment every month for 5 years.");
    expect(fixedSentenceForTerm(120)).toBe("Option A is a fixed-rate loan: the same payment every month for 10 years.");
    expect(fixedSentenceForTerm(12)).toContain("for 1 year.");
    expect(fixedSentenceForTerm(90)).toBe("Option A is a fixed-rate loan: the same payment every month for 90 months.");
    expect(fixedSentenceForTerm(1)).toContain("for 1 month.");
    for (const term of [0, -12, 60.5, Number.NaN]) {
      expect(() => fixedSentenceForTerm(term)).toThrow(RangeError);
    }
  });

  it("returns the chat footer", () => {
    expect(renderChatFooter()).toBe(CHAT_FOOTER);
  });

  it("prints only through shared/format.ts and does no arithmetic of its own", () => {
    const source = readFileSync(
      new URL("../server/domain/disclosures/template.ts", import.meta.url),
      "utf8",
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bMath\b|\.toFixed\b|\.toLocale\w*\b|\bIntl\b|\bNumber\(/);
    const imports = [...code.matchAll(/^import[\s\S]*?from "([^"]+)";/gm)].map((match) => match[1]);
    expect(imports).toEqual(["@shared/format", "@shared/schemas", "../payments/calculator.js"]);
  });
});

function sentencesFor(): HomeownerViewProps["mechanic_sentences"] {
  return Object.fromEntries(CATALOG.products.map((product) => [product.id, product.plain_sentence]));
}

describe("options display", () => {
  it("words the payment per mechanic, with the term and the APR, for all three options", () => {
    const display = renderOptionsDisplay(resultFor().options);
    expect(display).toEqual([
      {
        label: "Option A",
        product_id: "fixed_10y",
        payment_text: "$396.29 a month",
        term_text: "120 months",
        apr_text: "9.99%",
      },
      {
        label: "Option B",
        product_id: "zero_intro_18m",
        payment_text: "$250.00 a month for the first 18 months, then $414.14 a month",
        term_text: "120 months",
        apr_text: "12.99%",
      },
      {
        label: "Option C",
        product_id: "deferred_12m",
        payment_text: "$2,500.00 a month for 12 months",
        term_text: "120 months",
        apr_text: "17.99%",
      },
    ]);
    for (const entry of display) expect(OptionDisplaySchema.parse(entry)).toEqual(entry);
  });

  it("follows the fixed option's term and keeps the calculator's order", () => {
    const sixty = calculate({ amount_cents: AMOUNT_CENTS, term_months: 60, products: CATALOG });
    expect(renderOptionsDisplay(sixty.options).map((entry) => entry.term_text)).toEqual([
      "60 months",
      "120 months",
      "120 months",
    ]);
    expect(renderOptionsDisplay(sixty.options)[0]?.payment_text).toBe("$637.26 a month");
    expect(renderOptionsDisplay([...sixty.options].reverse()).map((entry) => entry.label)).toEqual([
      "Option C",
      "Option B",
      "Option A",
    ]);
    const oneMonth = calculate({ amount_cents: AMOUNT_CENTS, term_months: 1, products: CATALOG, product_ids: ["fixed_10y"] });
    expect(renderOptionsDisplay(oneMonth.options)[0]?.term_text).toBe("1 month");
  });

  it("is a pure function of the options", () => {
    const result = resultFor();
    const before = structuredClone(result);
    expect(renderOptionsDisplay(result.options)).toEqual(renderOptionsDisplay(result.options));
    expect(result).toEqual(before);
  });

  it("travels on the homeowner view, computed from the options shown", () => {
    const result = resultFor();
    const props = composeHomeownerView({
      options: result,
      disclosure_block: renderDisclosureBlock(result.options),
      explanation: "Option A costs less per month.",
      mechanic_sentences: sentencesFor(),
      template_version: "template@0123abcd",
    });
    expect(props.options_display).toEqual(renderOptionsDisplay(result.options));
    expect(HomeownerViewPropsSchema.shape.options_display.parse(props.options_display)).toEqual(props.options_display);
    expect(() => HomeownerViewPropsSchema.parse({ ...props, options_display: undefined })).toThrow();
  });
});

describe("homeowner view", () => {
  const options = resultFor();
  const disclosure_block = renderDisclosureBlock(options.options);
  const input = {
    options,
    disclosure_block,
    explanation: "Option B charges no interest for the first 18 months if the balance is paid in full by then.",
    mechanic_sentences: sentencesFor(),
    template_version: "template@0123abcd",
  };

  it("composes the props with the fixed what-happens-next text", () => {
    const props = composeHomeownerView(input);
    expect(HomeownerViewPropsSchema.parse(props)).toEqual(props);
    expect(props.what_happens_next).toBe(WHAT_HAPPENS_NEXT);
    expect(props.template_version).toBe("template@0123abcd");
    expect(props.options).toEqual(options);
    expect(props.disclosure_block).toEqual(disclosure_block);
    expect(props.explanation).toBe(input.explanation);
    expect(props.mechanic_sentences).toEqual(sentencesFor());
  });

  it("cannot be called without a disclosure block", () => {
    const { disclosure_block: _omitted, ...withoutBlock } = input;
    expect(() =>
      composeHomeownerView(
        // @ts-expect-error disclosure_block is required
        withoutBlock,
      ),
    ).toThrow(AppError);
    expect(() =>
      composeHomeownerView({
        ...input,
        // @ts-expect-error disclosure_block is not nullable
        disclosure_block: null,
      }),
    ).toThrow(/disclosure block/);
  });

  it("refuses a block that describes different options", () => {
    const onlyFixed = renderDisclosureBlock(resultFor("fixed_10y").options);
    expect(() => composeHomeownerView({ ...input, disclosure_block: onlyFixed })).toThrow(AppError);
    const reordered = renderDisclosureBlock([...options.options].reverse());
    expect(() => composeHomeownerView({ ...input, disclosure_block: reordered })).toThrow(AppError);
  });

  it("refuses a block rendered for a different amount, even when the products and order match", () => {
    const other = calculate({ amount_cents: 750_000, term_months: null, products: CATALOG });
    const wrongAmount = renderDisclosureBlock(other.options);
    expect(wrongAmount.options.map((option) => option.product_id)).toEqual(
      options.options.map((option) => option.product_id),
    );
    // A $30,000 view with a $7,500 block: same ids, same order, different figures.
    const err = (() => {
      try {
        composeHomeownerView({ ...input, disclosure_block: wrongAmount });
      } catch (caught) {
        return caught;
      }
      throw new Error("expected the view to be refused");
    })();
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("internal");
  });

  it("refuses a block whose fixed statements or lines were altered", () => {
    const alterations: DisclosureBlock[] = [
      { ...disclosure_block, estimate_statement: "This is an offer of credit." },
      { ...disclosure_block, respa_line: "" },
      {
        ...disclosure_block,
        options: disclosure_block.options.map((option, i) =>
          i === 0 ? { ...option, apr: "1.00%" } : option,
        ),
      },
      {
        ...disclosure_block,
        options: disclosure_block.options.map((option, i) =>
          i === 2 ? { ...option, consequence_line: null } : option,
        ),
      },
    ];
    for (const altered of alterations) {
      expect(() => composeHomeownerView({ ...input, disclosure_block: altered })).toThrow(AppError);
    }
  });

  it("accepts a block that is the canonical rendering with its keys in another order", () => {
    const reordered: DisclosureBlock = {
      respa_line: disclosure_block.respa_line,
      estimate_statement: disclosure_block.estimate_statement,
      options: disclosure_block.options.map((option) => ({
        consequence_line: option.consequence_line,
        schedule_line: option.schedule_line,
        total_of_payments: option.total_of_payments,
        amount_financed: option.amount_financed,
        finance_charge: option.finance_charge,
        apr: option.apr,
        product_id: option.product_id,
        label: option.label,
      })),
    };
    expect(composeHomeownerView({ ...input, disclosure_block: reordered }).disclosure_block).toEqual(
      disclosure_block,
    );
  });

  it("does not show the ten-years sentence for a fixed option on a different term", () => {
    const sixty = calculate({ amount_cents: AMOUNT_CENTS, term_months: 60, products: CATALOG });
    const props = composeHomeownerView({
      ...input,
      options: sixty,
      disclosure_block: renderDisclosureBlock(sixty.options),
    });
    const fixedSentence = props.mechanic_sentences["fixed_10y"] ?? "";
    expect(fixedSentence).toContain("5 years");
    expect(fixedSentence).not.toContain("ten years");
    expect(fixedSentence).toBe(fixedSentenceForTerm(60));
    // The two products that ignore a requested term keep the catalog's sentences.
    expect(props.mechanic_sentences["zero_intro_18m"]).toBe(sentencesFor()["zero_intro_18m"]);
    expect(props.mechanic_sentences["deferred_12m"]).toBe(sentencesFor()["deferred_12m"]);
    // The caller's sentences are not changed in place.
    expect(input.mechanic_sentences["fixed_10y"]).toContain("ten years");
  });

  it("keeps the catalog's sentence when the fixed option runs the catalog term", () => {
    const explicit = calculate({ amount_cents: AMOUNT_CENTS, term_months: 120, products: CATALOG });
    const props = composeHomeownerView({
      ...input,
      options: explicit,
      disclosure_block: renderDisclosureBlock(explicit.options),
    });
    expect(props.mechanic_sentences["fixed_10y"]).toContain("ten years");
  });

  it("refuses a view that lacks a mechanic sentence for a product it shows", () => {
    const { deferred_12m: _dropped, ...missing } = sentencesFor();
    expect(() => composeHomeownerView({ ...input, mechanic_sentences: missing })).toThrow(AppError);
  });

  it("copies its inputs, so a later change to them does not reach the props", () => {
    const props = composeHomeownerView(input);
    const first = props.options.options[0];
    expect(first).not.toBe(options.options[0]);
    expect(props.disclosure_block).not.toBe(disclosure_block);
  });
});

describe("surfaces", () => {
  it("declares the two surfaces", () => {
    expect(SURFACES.homeowner_view).toEqual({
      borrower_facing: true,
      disclosure: "required_block",
      model_prose: "explanation_or_canned_sentence",
    });
    expect(SURFACES.contractor_chat).toEqual({
      borrower_facing: false,
      disclosure: "chat_footer",
      model_prose: "judged_once_per_turn",
    });
  });

  it("types a borrower-facing message so that it needs its disclosure block", () => {
    const surface: BorrowerFacingSurface = "homeowner_view";
    const block = renderDisclosureBlock(resultFor("fixed_10y").options);
    const message: BorrowerFacingMessage = { surface, text: "Hello", disclosure_block: block };
    expect(message.disclosure_block).toBe(block);

    // @ts-expect-error a borrower-facing message cannot omit its disclosure block
    const withoutBlock: BorrowerFacingMessage = { surface, text: "Hello" };
    // @ts-expect-error the contractor chat is not a borrower-facing surface
    const wrongSurface: BorrowerFacingMessage = { surface: "contractor_chat", text: "Hello", disclosure_block: block };
    expect([withoutBlock, wrongSurface]).toHaveLength(2);
  });
});
