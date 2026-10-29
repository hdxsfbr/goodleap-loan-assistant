import { describe, expect, it } from "vitest";
import { usdToCents } from "./helpers/money.js";
import { formatMoney } from "@shared/format";
import { CATALOG } from "../server/domain/catalog.js";
import { renderDisclosureBlock } from "../server/domain/disclosures/template.js";
import { calculate } from "../server/domain/payments/calculator.js";
import { checkDenylist, loadDenylist } from "../server/guardrail/denylist.js";
import { CHAT_FOOTER, OUT_OF_SCOPE_ACTIONS, OUT_OF_SCOPE_REPLY } from "../server/guardrail/fallback.js";

// Item 75: the deny-list floor. No key needed.

const MUST_BLOCK = [
  "You're approved.",
  "She's pre-approved for this.",
  "Approval is guaranteed.",
  "You qualify for the 0% option.",
  "She qualifies.",
  "You're eligible for financing.",
  "Qualified applicants like her get the best rate.",
  "Consider it approved.",
  "Guaranteed financing today.",
  "You'll be approved by tomorrow.",
];

const case1 = calculate({
  amount_cents: usdToCents("$30,000.00"),
  term_months: null,
  products: CATALOG,
});
const optionA = case1.options[0];
const optionB = case1.options[1];

function allStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(allStrings);
  return [];
}

describe("deny-list", () => {
  it.each(MUST_BLOCK)("blocks %s", (text) => {
    const verdict = checkDenylist(text);
    expect(verdict.pass).toBe(false);
    expect(verdict.layer).toBe("denylist");
    expect(verdict.outcome).toBe("blocked");
    expect(verdict.matched?.length).toBeGreaterThan(0);
  });

  const mustPass: [string, string][] = [
    ["the rendered disclosure block", allStrings(renderDisclosureBlock(case1.options)).join("\n")],
    [
      "a promotional description with its caveat",
      "Option B charges no interest for the first 18 months if the balance is paid in full by then.",
    ],
    ["the out-of-scope reply", OUT_OF_SCOPE_REPLY],
    ["a clarifying question", "Use $40,000 as the requested amount?"],
    ["an echo of the contractor's figure", "You mentioned $30K; here are the options for that amount."],
    [
      "an Option A description from case 1",
      `Option A costs ${formatMoney(optionA?.payment_cents ?? 0)} a month for ${optionA?.term_months} months at 9.99% APR.`,
    ],
    [
      "an Option B description from case 3",
      `Option B costs ${formatMoney(optionB?.promo_payment_cents ?? 0)} a month for the first 18 months, then ${formatMoney(optionB?.payment_cents ?? 0)} a month, because interest applies to the balance still owed.`,
    ],
    ["the chat footer", CHAT_FOOTER],
    ["the two offers", OUT_OF_SCOPE_ACTIONS.join("\n")],
  ];
  it.each(mustPass)("passes %s", (_name, text) => {
    expect(checkDenylist(text)).toEqual({ pass: true, layer: "denylist", outcome: "pass" });
  });

  it("matches whole words only, in any case", () => {
    expect(checkDenylist("The word 'disapproved' and 'ineligible' are not the verdict words.").pass).toBe(true);
    expect(checkDenylist("APPROVED").pass).toBe(false);
    expect(checkDenylist("She will be Approved.").matched).toEqual(["approved"]);
  });

  it("reports pre-approved once, not also as approved", () => {
    expect(checkDenylist("She is pre-approved.").matched).toEqual(["pre-approved"]);
    expect(checkDenylist("Pre approved and approved.").matched).toEqual(["pre approved", "approved"]);
  });

  it("allows the out-of-scope reply as an allowed context, in either apostrophe, and nothing added to it", () => {
    expect(checkDenylist(OUT_OF_SCOPE_REPLY.replace("'", "’").replace("'", "’")).pass).toBe(true);
    expect(checkDenylist(`${OUT_OF_SCOPE_REPLY}\n\nShe is pre-approved anyway.`).matched).toEqual(["pre-approved"]);
    expect(checkDenylist("She will be approved, subject to credit approval.").pass).toBe(false);
  });

  it("loads the versioned entries: the verdict words, each with the closed list of allowed contexts", () => {
    const entries = loadDenylist();
    expect(entries).toHaveLength(7);
    for (const entry of entries) {
      expect(entry.allowed_contexts).toEqual(["subject to credit approval", "{{OUT_OF_SCOPE_REPLY}}"]);
      expect(() => new RegExp(entry.pattern, "i")).not.toThrow();
      expect(entry.added_by).not.toBe("");
    }
  });
});
