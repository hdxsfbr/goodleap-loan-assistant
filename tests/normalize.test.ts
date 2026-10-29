import { describe, expect, it } from "vitest";
import { PAY_FREQUENCY_ALIASES, parseAsWritten, parseCorrection, parseDate, schemaForSlot } from "@shared/document-schemas/index";
import { figureTokens, isNumericToken, normalizeFigure, normalizeText, normalizeToken } from "@shared/normalize";

describe("normalizeText", () => {
  it("collapses whitespace and lowercases", () => {
    expect(normalizeText("  Total \t Amount \n  Due  ")).toBe("total amount due");
    expect(normalizeText("BIWEEKLY")).toBe("biweekly");
    expect(normalizeText("")).toBe("");
  });

  it("drops the currency mark and the thousands separator of a figure", () => {
    expect(normalizeText("$31,000.00")).toBe("31000.00");
    expect(normalizeText("Total $4,250.00")).toBe("total 4250.00");
    // A bare "$" before a figure is not a token of its own.
    expect(normalizeText("$ 4,250")).toBe("4250");
  });

  it("joins a word hyphenated across a line break", () => {
    expect(normalizeText("tear-\noff")).toBe("tearoff");
    expect(normalizeText("tear- \n  off")).toBe("tearoff");
    // A hyphen inside a word on one line is punctuation, not a break.
    expect(normalizeText("tear-off")).toBe("tearoff");
  });

  it("folds O to 0 and l to 1 inside numeric tokens only", () => {
    expect(normalizeToken("O1/15/2025")).toBe("01/15/2025");
    expect(normalizeToken("l,000")).toBe("1000");
    expect(normalizeToken("1O0")).toBe("100");
    expect(normalizeToken("lol")).toBe("lol");
    expect(normalizeToken("Olive")).toBe("olive");
  });

  it("strips sentence punctuation around a token and keeps the separators inside a number", () => {
    expect(normalizeToken("$42.50;")).toBe("42.50");
    expect(normalizeToken("1,812.40.")).toBe("1812.40");
    expect(normalizeToken("(10/05/2026)")).toBe("10/05/2026");
    expect(normalizeToken("Court,")).toBe("court");
  });

  it("makes the spellings of one figure equal and different figures different", () => {
    expect(normalizeText("2,350.00")).toBe(normalizeText("$2,350.00"));
    expect(normalizeText("2,350.00")).not.toBe(normalizeText("2,305.00"));
    expect(normalizeText("Bi-Weekly")).toBe(normalizeText("biweekly"));
  });
});

describe("isNumericToken", () => {
  it("accepts figures and dates and rejects words", () => {
    for (const token of ["$4,250.00", "03/15/2025", "l,000", "O1/15/2025", "$42.50;", "12"]) {
      expect(isNumericToken(token)).toBe(true);
    }
    for (const token of ["lol", "Court", "-", "$", ""]) {
      expect(isNumericToken(token)).toBe(false);
    }
  });
});

describe("figureTokens", () => {
  it("lists the currency, percent and month or year figures of a mixed sentence in order", () => {
    const sentence = "Use $40K over 120 months at 9.99% (about $396.29 a month), or a 10-year term for $1,200,000 and 0 percent promo.";
    expect(figureTokens(sentence)).toEqual([
      "40000.00",
      "120 months",
      "9.99%",
      "396.29",
      "10 years",
      "1200000.00",
      "0%",
    ]);
  });

  it("ignores bare numbers and spells equal figures alike", () => {
    expect(figureTokens("There are 4 line items and the room is 12 feet wide.")).toEqual([]);
    expect(figureTokens("$414.1")).toEqual(["414.10"]);
    expect(normalizeFigure("$40,000")).toBe(normalizeFigure("$40K"));
    expect(normalizeFigure("no figure here")).toBeNull();
  });
});

describe("document value parsing", () => {
  const field = (slot: "pay_stub" | "estimate" | "scope_letter", id: string) => {
    const found = schemaForSlot(slot).fields.find((f) => f.id === id);
    if (!found) throw new Error(`no field ${id}`);
    return found;
  };

  it("reads money as written into integer cents", () => {
    const gross = field("pay_stub", "gross_pay");
    expect(parseAsWritten(gross, "2,350.00")).toEqual({ ok: true, value: 235000 });
    expect(parseAsWritten(gross, "$31,000.00")).toEqual({ ok: true, value: 3100000 });
    expect(parseAsWritten(gross, "about 2,350")).toMatchObject({ ok: false });
  });

  it("reads the date spellings the design names into YYYY-MM-DD", () => {
    expect(parseDate("10/05/2026")).toBe("2026-10-05");
    expect(parseDate("September 14, 2026")).toBe("2026-09-14");
    expect(parseDate("Nov. 9, 2026")).toBe("2026-11-09");
    expect(parseDate("9 November 2026")).toBe("2026-11-09");
    expect(parseDate("2026-11-09")).toBe("2026-11-09");
    expect(parseDate("02/30/2026")).toBeNull();
    expect(parseDate("someday")).toBeNull();
  });

  it("maps the spellings of a pay frequency to its four values", () => {
    const frequency = field("pay_stub", "pay_frequency");
    const read = (text: string) => {
      const parsed = parseAsWritten(frequency, text);
      return parsed.ok ? parsed.value : null;
    };
    expect(read("Bi-Weekly")).toBe("biweekly");
    expect(read("biweekly")).toBe("biweekly");
    expect(read("every two weeks")).toBe("biweekly");
    expect(read("Weekly")).toBe("weekly");
    expect(read("Semi-Monthly")).toBe("semimonthly");
    expect(read("Twice a month")).toBe("semimonthly");
    expect(read("MONTHLY")).toBe("monthly");
    expect(read("quarterly")).toBeNull();
    expect(new Set(PAY_FREQUENCY_ALIASES.values())).toEqual(new Set(["weekly", "biweekly", "semimonthly", "monthly"]));
  });

  it("reads integers and text, and refuses an empty value", () => {
    expect(parseAsWritten(field("estimate", "line_item_count"), "4")).toEqual({ ok: true, value: 4 });
    expect(parseAsWritten(field("estimate", "line_item_count"), "four")).toMatchObject({ ok: false });
    expect(parseAsWritten(field("scope_letter", "property_address"), "  2217   Marlow Court ")).toEqual({
      ok: true,
      value: "2217 Marlow Court",
    });
    expect(parseAsWritten(field("scope_letter", "property_address"), "   ")).toMatchObject({ ok: false });
  });

  it("takes a reviewer's number as the stored form and a string as typed", () => {
    const gross = field("pay_stub", "gross_pay");
    expect(parseCorrection(gross, 235000)).toEqual({ ok: true, value: 235000 });
    expect(parseCorrection(gross, "$2,350.00")).toEqual({ ok: true, value: 235000 });
    expect(parseCorrection(gross, 0)).toMatchObject({ ok: false });
    expect(parseCorrection(gross, 12.5)).toMatchObject({ ok: false });
  });
});
