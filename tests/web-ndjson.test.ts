import { describe, expect, it, vi } from "vitest";
import { AuditEventSchema, type AuditEvent, type ApplicationView, type StreamLine } from "@shared/schemas";
import { createConversationStore } from "../web/src/conversation";
import { ApiError } from "../web/src/errors";
import {
  badgeCaption,
  disclosureCovers,
  displayCovers,
  displayFor,
  documentName,
  eventBadge,
  fieldDisplayValue,
  fieldInputText,
  formatTimestamp,
  hasRequestedAmount,
  orderByTerm,
  proposalMessageId,
  proposalQuote,
  submitGate,
  summarizeEvent,
  usageText,
} from "../web/src/present";
import {
  applyStreamEvent,
  createLineReader,
  exchangeForMessage,
  latestOptionsExchange,
  messageIdsOf,
  messageTextFor,
  parseStreamLine,
  readTurnBody,
  startTurn,
  turnFromOptions,
  turnHasContent,
  type ClientEvent,
} from "../web/src/stream";
import type { Exchange } from "../web/src/types";
import {
  BLOCK,
  DEFERRED,
  EXPLANATION_WITH_QUESTION,
  FIXED,
  FOOTER,
  OPTIONS_DISPLAY,
  OPTIONS_LINE,
  SHORT_BLOCK,
  VERSIONS,
  ZERO_INTRO,
  proposal,
  proposedField,
  typedField,
  withoutDisplay,
} from "./helpers/web-fixtures";

// The pure parts of the web client: the NDJSON reader and parser, the reducer that turns stream
// lines into panel state, the chat store, and the presenters that print figures and events.

const line = (value: StreamLine): string => JSON.stringify(value);

describe("createLineReader", () => {
  it("returns complete lines and keeps the partial one for the next chunk", () => {
    const reader = createLineReader();
    expect(reader.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(reader.push(":2}\n")).toEqual(['{"b":2}']);
    expect(reader.flush()).toEqual([]);
  });

  it("splits several lines in one chunk, drops blank lines and strips carriage returns", () => {
    const reader = createLineReader();
    expect(reader.push('one\r\n\n  \ntwo\n')).toEqual(["one", "two"]);
  });

  it("flushes a final line that has no newline", () => {
    const reader = createLineReader();
    expect(reader.push('{"type":"done"}')).toEqual([]);
    expect(reader.flush()).toEqual(['{"type":"done"}']);
    expect(reader.flush()).toEqual([]);
  });
});

describe("parseStreamLine", () => {
  it("accepts every line type the stream carries", () => {
    expect(parseStreamLine(line({ type: "status", step: "Calculating payments..." }))).toEqual({
      ok: true,
      line: { type: "status", step: "Calculating payments..." },
    });
    expect(parseStreamLine(line(OPTIONS_LINE)).ok).toBe(true);
    expect(parseStreamLine(line({ type: "done", event_ids: ["e1"] })).ok).toBe(true);
    expect(parseStreamLine(line(EXPLANATION_WITH_QUESTION))).toEqual({ ok: true, line: EXPLANATION_WITH_QUESTION });
  });

  it("rejects text that is not JSON, an unknown type and an undeclared field", () => {
    expect(parseStreamLine("not json").ok).toBe(false);
    expect(parseStreamLine('{"type":"mystery"}').ok).toBe(false);
    expect(parseStreamLine('{"type":"status","step":"x","extra":1}').ok).toBe(false);
    expect(parseStreamLine('{"type":"done"}').ok).toBe(false);
    // An explanation line always says whether it carries a question.
    expect(
      parseStreamLine('{"type":"explanation","text":"Option A is a fixed-rate loan.","footer":null,"event_ids":[]}').ok,
    ).toBe(false);
  });
});

describe("applyStreamEvent", () => {
  it("builds a whole turn from its lines in order", () => {
    const events: ClientEvent[] = [
      { type: "status", step: "Finding matching products..." },
      OPTIONS_LINE,
      { type: "status", step: "Checking wording..." },
      { type: "proposals", proposals: [proposal("p1", "homeowner_first_name", "Maria", "m_1")], note: null },
      { type: "explanation", text: "Option A costs less per month.", question: null, footer: OPTIONS_LINE.footer, event_ids: ["e9"] },
      { type: "done", event_ids: ["e1", "e2"] },
    ];
    let turn = startTurn();
    const seen: Array<string | null> = [];
    for (const event of events) {
      turn = applyStreamEvent(turn, event);
      seen.push(turn.status);
    }
    expect(seen).toEqual([
      "Finding matching products...",
      "Finding matching products...",
      "Checking wording...",
      "Checking wording...",
      null,
      null,
    ]);
    expect(turn.phase).toBe("done");
    expect(turn.options?.options_id).toBe("opt_1");
    expect(turn.proposals).toEqual({ ids: ["p1"], note: null });
    expect(turn.explanation?.text).toBe("Option A costs less per month.");
    expect(turn.explanation?.question).toBeNull();
    expect(turn.event_ids).toEqual(["e1", "e2"]);
  });

  it("keeps the question of an explanation line beside its body and footer", () => {
    const turn = applyStreamEvent(startTurn(), EXPLANATION_WITH_QUESTION);
    expect(turn.explanation).toEqual({
      text: EXPLANATION_WITH_QUESTION.text,
      question: "Use $40,000 as the requested amount?",
      footer: FOOTER,
    });
    expect(turnHasContent(turn)).toBe(true);
  });

  it("accumulates proposals across lines and keeps the note", () => {
    let turn = startTurn();
    turn = applyStreamEvent(turn, { type: "proposals", proposals: [proposal("p1", "property_zip", "95112", "m_1")], note: null });
    turn = applyStreamEvent(turn, {
      type: "proposals",
      proposals: [proposal("p2", "homeowner_last_name", "Lopez", "m_1")],
      note: "I couldn't produce field suggestions for that; the explanation is below.",
    });
    turn = applyStreamEvent(turn, { type: "proposals", proposals: [], note: null });
    expect(turn.proposals?.ids).toEqual(["p1", "p2"]);
    expect(turn.proposals?.note).toMatch(/couldn't produce/);
  });

  it("shows the fallback text and its marker in place of an explanation", () => {
    const turn = applyStreamEvent(startTurn(), {
      type: "fallback",
      text: "I can't phrase that in a way that meets lending rules.",
      marker: "Wording adjusted to comply with lending rules. View in audit",
      audit_event_id: "evt_77",
    });
    expect(turn.fallback?.audit_event_id).toBe("evt_77");
    expect(turn.explanation).toBeNull();
    expect(turn.status).toBeNull();
  });

  it("replaces an explanation with the fallback when the turn ends in the fallback", () => {
    let turn = applyStreamEvent(startTurn(), OPTIONS_LINE);
    turn = applyStreamEvent(turn, {
      type: "explanation",
      text: "A draft the guardrail later blocked.",
      question: "Use $40,000 as the requested amount?",
      footer: OPTIONS_LINE.footer,
      event_ids: ["e1"],
    });
    expect(turn.explanation?.text).toBe("A draft the guardrail later blocked.");
    turn = applyStreamEvent(turn, {
      type: "fallback",
      text: "I can't phrase that in a way that meets lending rules.",
      marker: "Wording adjusted to comply with lending rules. View in audit",
      audit_event_id: "evt_77",
    });
    turn = applyStreamEvent(turn, { type: "done", event_ids: ["e2"] });
    // The question goes with the draft it was part of.
    expect(turn.explanation).toBeNull();
    expect(turn.fallback?.text).toMatch(/lending rules/);
    // The options table the turn showed stays.
    expect(turn.options?.options_id).toBe("opt_1");
    expect(turn.phase).toBe("done");
  });

  it("keeps what arrived before an error and takes the event ids from the done line after it", () => {
    let turn = applyStreamEvent(startTurn(), OPTIONS_LINE);
    turn = applyStreamEvent(turn, { type: "error", code: "llm.rate_limited", message: "The assistant is busy right now.", retryable: true });
    expect(turn.phase).toBe("error");
    expect(turn.options).not.toBeNull();
    expect(turn.error).toEqual({ code: "llm.rate_limited", message: "The assistant is busy right now.", retryable: true });
    turn = applyStreamEvent(turn, { type: "done", event_ids: ["e5"] });
    expect(turn.phase).toBe("error");
    expect(turn.event_ids).toEqual(["e5"]);
    // A settled turn ignores anything else.
    expect(applyStreamEvent(turn, { type: "status", step: "late" })).toBe(turn);
  });

  it("turns a body that ended without a done line into a retryable error", () => {
    const turn = applyStreamEvent(applyStreamEvent(startTurn(), OPTIONS_LINE), { type: "stream_ended" });
    expect(turn.phase).toBe("error");
    expect(turn.error?.retryable).toBe(true);
    expect(turn.options).not.toBeNull();
  });

  it("ignores the end of the body once the turn has finished", () => {
    const done = applyStreamEvent(startTurn(), { type: "done", event_ids: [] });
    expect(applyStreamEvent(done, { type: "stream_ended" })).toBe(done);
  });

  it("builds a settled turn from a calculator result", () => {
    const turn = turnFromOptions(OPTIONS_LINE);
    expect(turn.phase).toBe("done");
    expect(turn.status).toBeNull();
    expect(turnHasContent(turn)).toBe(true);
    expect(turnHasContent({ ...startTurn(), phase: "done", status: null })).toBe(false);
  });
});

describe("message ids", () => {
  const exchanges: Exchange[] = [
    { id: "x1", text: "Homeowner is Maria Lopez", message_ids: ["m_1"], turn: startTurn() },
    { id: "x2", text: "what if it were $40K?", message_ids: [], turn: startTurn() },
  ];

  it("lists the distinct message ids a proposals line points at", () => {
    const ids = messageIdsOf({
      type: "proposals",
      proposals: [proposal("p1", "property_zip", "95112", "m_1"), proposal("p2", "homeowner_last_name", "Lopez", "m_1")],
      note: null,
    });
    expect(ids).toEqual(["m_1"]);
  });

  it("finds the text and the exchange behind a message id", () => {
    expect(messageTextFor(exchanges, "m_1")).toBe("Homeowner is Maria Lopez");
    expect(messageTextFor(exchanges, "m_404")).toBeNull();
    expect(exchangeForMessage(exchanges, "m_1")?.id).toBe("x1");
  });
});

describe("latestOptionsExchange", () => {
  const withOptions = (id: string, optionsId: string): Exchange => ({
    id,
    text: null,
    message_ids: [],
    turn: turnFromOptions({ ...OPTIONS_LINE, options_id: optionsId }),
  });
  const textOnly = (id: string): Exchange => ({ id, text: "hello", message_ids: [], turn: startTurn() });

  it("finds the newest exchange that shows an options table", () => {
    const exchanges = [withOptions("x1", "opt_1"), textOnly("x2"), withOptions("x3", "opt_3"), textOnly("x4")];
    expect(latestOptionsExchange(exchanges)?.id).toBe("x3");
    expect(latestOptionsExchange(exchanges)?.turn.options?.options_id).toBe("opt_3");
  });

  it("is null when no reply has shown options", () => {
    expect(latestOptionsExchange([])).toBeNull();
    expect(latestOptionsExchange([textOnly("x1")])).toBeNull();
  });
});

describe("readTurnBody", () => {
  function bodyOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
  }

  it("reassembles lines and multi-byte characters split across chunks", async () => {
    const text = [
      line({ type: "status", step: "Finding matching products..." }),
      line({ type: "explanation", text: "Option A costs less – “quietly”.", question: null, footer: null, event_ids: [] }),
      line({ type: "done", event_ids: ["e1"] }),
    ].join("\n"); // no trailing newline on purpose
    const bytes = new TextEncoder().encode(text);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 7) chunks.push(bytes.slice(i, i + 7));
    const events: ClientEvent[] = [];
    await readTurnBody(bodyOf(chunks), (event) => events.push(event));
    expect(events.map((event) => event.type)).toEqual(["status", "explanation", "done"]);
    expect(events[1]).toMatchObject({ text: "Option A costs less – “quietly”." });
  });

  it("stops at a line that does not match the schema and reports an error", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const text = `${line({ type: "status", step: "a" })}\n{"type":"bogus"}\n${line({ type: "done", event_ids: [] })}\n`;
    const events: ClientEvent[] = [];
    await readTurnBody(bodyOf([new TextEncoder().encode(text)]), (event) => events.push(event));
    spy.mockRestore();
    expect(events.map((event) => event.type)).toEqual(["status", "error"]);
  });

  it("reports a connection error when the read fails", async () => {
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("socket closed"));
      },
    });
    const events: ClientEvent[] = [];
    await readTurnBody(failing, (event) => events.push(event));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", retryable: true });
  });
});

describe("conversation store", () => {
  function store(lines: ClientEvent[], overrides: { onStream?: (text: string) => void } = {}) {
    const posted: string[] = [];
    return {
      posted,
      store: createConversationStore({
        stream: async (_applicationId, text, onEvent) => {
          posted.push(text);
          overrides.onStream?.(text);
          for (const event of lines) onEvent(event);
        },
        paymentOptions: async () => OPTIONS_LINE,
      }),
    };
  }

  const FULL_TURN: ClientEvent[] = [
    OPTIONS_LINE,
    { type: "proposals", proposals: [proposal("p1", "homeowner_first_name", "Maria", "m_1")], note: null },
    { type: "explanation", text: "Option A costs less per month.", question: null, footer: OPTIONS_LINE.footer, event_ids: [] },
    { type: "done", event_ids: ["e1"] },
  ];

  it("adds an exchange, runs the turn and records the message id its proposals point at", async () => {
    const { store: chat } = store(FULL_TURN);
    const seen: number[] = [];
    chat.subscribe(() => seen.push(chat.getConversation("app").exchanges.length));
    await chat.sendMessage("app", "  Homeowner is Maria  ");
    const [exchange] = chat.getConversation("app").exchanges;
    expect(exchange?.text).toBe("Homeowner is Maria");
    expect(exchange?.turn.phase).toBe("done");
    expect(exchange?.message_ids).toEqual(["m_1"]);
    expect(seen[0]).toBe(1);
    // The form is told to reload when proposals arrive and when the turn ends.
    expect(chat.getConversation("app").revision).toBe(2);
  });

  it("does not give a later exchange a message id an earlier one already holds", async () => {
    const { store: chat } = store(FULL_TURN);
    await chat.sendMessage("app", "first");
    await chat.sendMessage("app", "second");
    const [first, second] = chat.getConversation("app").exchanges;
    expect(first?.message_ids).toEqual(["m_1"]);
    expect(second?.message_ids).toEqual([]);
  });

  it("returns the same snapshot until something changes", async () => {
    const { store: chat } = store(FULL_TURN);
    expect(chat.getConversation("app")).toBe(chat.getConversation("app"));
    await chat.sendMessage("app", "hello");
    expect(chat.getConversation("app")).toBe(chat.getConversation("app"));
    expect(chat.getConversation("other").exchanges).toHaveLength(0);
  });

  it("ignores a message while a reply is still arriving", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const posted: string[] = [];
    const chat = createConversationStore({
      stream: async (_a, text, onEvent) => {
        posted.push(text);
        onEvent({ type: "status", step: "Calculating payments..." });
        await gate;
        onEvent({ type: "done", event_ids: [] });
      },
      paymentOptions: async () => OPTIONS_LINE,
    });
    const first = chat.sendMessage("app", "one");
    expect(chat.isBusy("app")).toBe(true);
    await chat.sendMessage("app", "two");
    await chat.showPaymentOptions("app");
    expect(posted).toEqual(["one"]);
    expect(chat.getConversation("app").exchanges).toHaveLength(1);
    release();
    await first;
    expect(chat.isBusy("app")).toBe(false);
  });

  it("remembers that the key is missing or rejected, and that the operator disabled the assistant", async () => {
    for (const [code, flag] of [
      ["llm.missing_key", "key_missing"],
      ["llm.auth_failed", "key_rejected"],
      ["copilot.disabled", "copilot_disabled"],
    ] as const) {
      const { store: chat } = store([{ type: "error", code, message: "No.", retryable: false }, { type: "done", event_ids: [] }]);
      expect(chat.getFlags()[flag]).toBe(false);
      await chat.sendMessage("app", "hello");
      expect(chat.getFlags()[flag]).toBe(true);
    }
  });

  it("retries a retryable error with the same text and no new bubble, and refuses a final one", async () => {
    let attempts = 0;
    const posted: string[] = [];
    const chat = createConversationStore({
      stream: async (_a, text, onEvent) => {
        posted.push(text);
        attempts += 1;
        if (attempts === 1) {
          onEvent({ type: "error", code: "llm.timeout", message: "The assistant took too long to answer.", retryable: true });
          onEvent({ type: "done", event_ids: [] });
          return;
        }
        for (const event of FULL_TURN) onEvent(event);
      },
      paymentOptions: async () => OPTIONS_LINE,
    });
    await chat.sendMessage("app", "They want the lowest monthly payment");
    const [failed] = chat.getConversation("app").exchanges;
    expect(failed?.turn.error?.code).toBe("llm.timeout");
    await chat.retry("app", failed?.id ?? "");
    const exchanges = chat.getConversation("app").exchanges;
    expect(posted).toEqual(["They want the lowest monthly payment", "They want the lowest monthly payment"]);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.turn.phase).toBe("done");
    expect(exchanges[0]?.turn.error).toBeNull();

    // A finished turn cannot be retried.
    await chat.retry("app", exchanges[0]?.id ?? "");
    expect(posted).toHaveLength(2);
  });

  it("does not retry an error the server marked final", async () => {
    const { store: chat, posted } = store([
      { type: "error", code: "llm.refusal", message: "The assistant declined to answer that request.", retryable: false },
      { type: "done", event_ids: [] },
    ]);
    await chat.sendMessage("app", "hello");
    const [exchange] = chat.getConversation("app").exchanges;
    await chat.retry("app", exchange?.id ?? "");
    expect(posted).toHaveLength(1);
  });

  it("ends a turn as an error when the stream rejects or stops without a done line", async () => {
    const rejecting = createConversationStore({
      stream: async () => {
        throw new ApiError({ code: "internal", message: "Something went wrong on our side. Please try again.", retryable: false }, 500);
      },
      paymentOptions: async () => OPTIONS_LINE,
    });
    await rejecting.sendMessage("app", "hello");
    expect(rejecting.getConversation("app").exchanges[0]?.turn.error?.message).toMatch(/went wrong/);

    const { store: truncated } = store([OPTIONS_LINE]);
    await truncated.sendMessage("app", "hello");
    const turn = truncated.getConversation("app").exchanges[0]?.turn;
    expect(turn?.phase).toBe("error");
    expect(turn?.options).not.toBeNull();
  });

  it("adds a calculator result with no contractor text, and its error when the calculator fails", async () => {
    const { store: chat } = store([]);
    await chat.showPaymentOptions("app");
    const [result] = chat.getConversation("app").exchanges;
    expect(result?.text).toBeNull();
    expect(result?.turn.phase).toBe("done");
    expect(result?.turn.options?.options_id).toBe("opt_1");

    const failing = createConversationStore({
      stream: async () => undefined,
      paymentOptions: async () => {
        throw new ApiError({ code: "catalog.unavailable", message: "The product catalog service is unavailable.", retryable: true }, 503);
      },
    });
    await failing.showPaymentOptions("app");
    const [broken] = failing.getConversation("app").exchanges;
    expect(broken?.turn.error?.code).toBe("catalog.unavailable");
    // A retry of a calculator error calls the calculator again, not the chat.
    await failing.retry("app", broken?.id ?? "");
    expect(failing.getConversation("app").exchanges).toHaveLength(1);
  });
});

describe("payment options", () => {
  it("orders options by term and keeps the server's order for equal terms", () => {
    const a = { ...FIXED, term_months: 240 };
    expect(orderByTerm([a, ZERO_INTRO, DEFERRED]).map((o) => o.label)).toEqual(["Option B", "Option C", "Option A"]);
    expect(orderByTerm([FIXED, ZERO_INTRO, DEFERRED]).map((o) => o.label)).toEqual(["Option A", "Option B", "Option C"]);
  });

  it("finds an option's display strings by product id", () => {
    expect(displayFor(OPTIONS_DISPLAY, "zero_intro_18m")).toMatchObject({
      payment_text: "SERVER-PAY-B",
      term_text: "SERVER-TERM-B",
      apr_text: "SERVER-APR-B",
    });
    expect(displayFor(OPTIONS_DISPLAY.slice(0, 2), "deferred_12m")).toBeNull();
  });

  it("reports whether the display strings have an entry for every option", () => {
    const options = [FIXED, ZERO_INTRO, DEFERRED];
    expect(displayCovers(options, OPTIONS_DISPLAY)).toBe(true);
    expect(displayCovers(options, OPTIONS_DISPLAY.slice(0, 2))).toBe(false);
    expect(displayCovers([FIXED], OPTIONS_DISPLAY.slice(0, 1))).toBe(true);
    expect(displayCovers(options, [])).toBe(false);
  });

  it("reports whether the disclosure block has an entry for every option", () => {
    const options = [FIXED, ZERO_INTRO, DEFERRED];
    expect(disclosureCovers(options, BLOCK)).toBe(true);
    expect(disclosureCovers(options, SHORT_BLOCK)).toBe(false);
    expect(disclosureCovers([FIXED], SHORT_BLOCK)).toBe(true);
    expect(disclosureCovers(options, { ...BLOCK, options: [] })).toBe(false);
  });

  it("refuses an options line without display strings, or with an option they do not cover", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(parseStreamLine(line(OPTIONS_LINE)).ok).toBe(true);
    expect(parseStreamLine(JSON.stringify(withoutDisplay(OPTIONS_LINE))).ok).toBe(false);
    const short = parseStreamLine(line({ ...OPTIONS_LINE, options_display: OPTIONS_DISPLAY.slice(0, 2) }));
    expect(short).toEqual({ ok: false, reason: "options_display: an option has no display entry." });
    spy.mockRestore();
  });
});

describe("form presenters", () => {
  const view = (fields: ApplicationView["fields"], status: ApplicationView["status"] = "draft"): ApplicationView => ({
    id: "app_demo_001",
    contractor_id: "ctr_demo_001",
    status,
    fields,
    verified: { verified_annual_income: null, verification_source: null },
    document_ids: [],
    documents: [],
    banner: null,
  });
  const proposed = (value: string | number, previous: ApplicationView["fields"][string]["previous"] = null) => ({
    value,
    state: "proposed" as const,
    source_ref: { kind: "message" as const, ref: { message_id: "m_1", quote: "quoted words" } },
    proposal_id: "p1",
    previous,
  });
  const typed = (value: string | number) => ({ value, state: "typed" as const, source_ref: null, proposal_id: null, previous: null });

  it("shows money as dollars and enums as labels, and starts inputs from dollars or the raw value", () => {
    expect(fieldDisplayValue("requested_loan_amount", 3000000)).toBe("$30,000.00");
    expect(fieldDisplayValue("preferred_term_months", "120")).toBe("120 months");
    expect(fieldDisplayValue("selected_product_id", "fixed_10y")).toBe("10-year fixed");
    expect(fieldDisplayValue("homeowner_first_name", "Maria")).toBe("Maria");
    expect(fieldInputText("requested_loan_amount", 3000000)).toBe("$30,000.00");
    expect(fieldInputText("selected_product_id", "fixed_10y")).toBe("fixed_10y");
  });

  it("captions every state", () => {
    expect(badgeCaption("empty", true)).toBe("Required");
    expect(badgeCaption("empty", false)).toBe("Optional");
    expect(badgeCaption("proposed", false)).toMatch(/confirmation/);
  });

  it("disables submit with the pending count while values are proposed", () => {
    const fields = {
      homeowner_first_name: proposed("Maria"),
      homeowner_last_name: proposed("Lopez"),
      property_zip: proposed("95112"),
      preferred_term_months: proposed("120"),
      selected_product_id: proposed("fixed_10y"),
      project_amount: typed(3000000),
    };
    expect(submitGate(view(fields))).toEqual({ pending: 5, blocked: true, reason: "5 proposed values need confirmation" });
    expect(submitGate(view({ property_zip: proposed("95112") })).reason).toBe("1 proposed value needs confirmation");
    expect(submitGate(view({ project_amount: typed(3000000) }))).toEqual({ pending: 0, blocked: false, reason: null });
    expect(submitGate(view({}, "documents_under_review"))).toEqual({ pending: 0, blocked: true, reason: null });
  });

  it("keeps submit disabled while a reply runs, a save or a reload is outstanding, or the submit itself is running", () => {
    const clean = view({ project_amount: typed(3000000) });
    const open = { pending: 0, blocked: false, reason: null };
    expect(submitGate(clean, {})).toEqual(open);
    expect(submitGate(clean, { turnRunning: true })).toEqual({ ...open, blocked: true });
    expect(submitGate(clean, { writing: true })).toEqual({ ...open, blocked: true });
    expect(submitGate(clean, { refreshing: true })).toEqual({ ...open, blocked: true });
    expect(submitGate(clean, { submitting: true })).toEqual({ ...open, blocked: true });
    // The pending-count caption stays whatever else is going on.
    const pending = view({ property_zip: proposed("95112") });
    expect(submitGate(pending, { turnRunning: true, writing: true })).toEqual({
      pending: 1,
      blocked: true,
      reason: "1 proposed value needs confirmation",
    });
    // A submitted application is blocked without a caption.
    expect(submitGate(view({}, "documents_under_review"), { writing: true })).toEqual({ pending: 0, blocked: true, reason: null });
  });

  it("reads the quote and the message id of a proposal from the application view", () => {
    const fromMessage = proposedField("95112", "p1", { kind: "message", ref: { message_id: "m_7", quote: "zip 95112" } });
    expect(proposalMessageId(fromMessage)).toBe("m_7");
    expect(proposalQuote(fromMessage)).toBe("zip 95112");
    // A blank quote is no quotation; other sources and typed values have none.
    const blank = proposedField("95112", "p1", { kind: "message", ref: { message_id: "m_7", quote: "  " } });
    expect(proposalQuote(blank)).toBeNull();
    expect(proposalMessageId(blank)).toBe("m_7");
    const formula = proposedField(1, "p2", { kind: "formula", ref: { formula: "x", inputs: [] } });
    expect(proposalQuote(formula)).toBeNull();
    expect(proposalMessageId(formula)).toBeNull();
    expect(proposalQuote(typedField(3000000))).toBeNull();
    expect(proposalMessageId(typedField(3000000))).toBeNull();
  });

  it("enables the calculator only for a typed or confirmed amount", () => {
    expect(hasRequestedAmount(null)).toBe(false);
    expect(hasRequestedAmount(view({}))).toBe(false);
    expect(hasRequestedAmount(view({ requested_loan_amount: proposed(3000000) }))).toBe(false);
    expect(hasRequestedAmount(view({ requested_loan_amount: proposed(4000000, { value: 3000000, state: "typed" }) }))).toBe(true);
    expect(hasRequestedAmount(view({ requested_loan_amount: typed(3000000) }))).toBe(true);
  });

  it("names a document by its file", () => {
    expect(documentName("samples/paystub.pdf")).toBe("paystub.pdf");
    expect(documentName("estimate.pdf")).toBe("estimate.pdf");
  });
});

describe("audit presenters", () => {
  const base = {
    event_id: "evt_1",
    application_id: "app_demo_001",
    session_id: "s1",
    seq: 1,
    ts: "2026-10-28T14:03:22.123Z",
    actor: { type: "system" as const, id: "server" },
    schema_version: 1 as const,
    versions: VERSIONS,
  };
  const event = (extra: Record<string, unknown>): AuditEvent => AuditEventSchema.parse({ ...base, ...extra });

  const mockedToolCall = event({
    type: "tool.call",
    service: "catalog",
    method: "getCatalog",
    input: {},
    output: {},
    latency_ms: 2,
    _mock: { service: "catalog", fixture_id: "catalog-v1", mock_version: 1 },
  });
  const calculatorCall = event({ type: "tool.call", service: "calculator", method: "calculate", input: {}, output: {}, latency_ms: 1 });
  const modelCall = event({
    type: "model.call",
    use_case: "copilot",
    model_id: "claude-sonnet-5-5",
    effort: "low",
    context: { message_ids: [], system_prompt_version: "copilot@aaaaaaaa", system_prompt_sha256: "abc" },
    raw_input: {},
    raw_output: {},
    usage: { input: 1200, output: 80, cache_read: 900 },
    latency_ms: 812.4,
    stop_reason: "end_turn",
  });

  it("badges mocked and live calls and leaves other events unbadged", () => {
    expect(eventBadge(mockedToolCall)).toBe("MOCK");
    expect(eventBadge(calculatorCall)).toBe("LIVE");
    expect(eventBadge(modelCall)).toBe("LIVE");
    expect(eventBadge({ ...modelCall, _fixture: true } as AuditEvent)).toBe("MOCK");
    expect(eventBadge(event({ type: "options.explained", options_id: "opt_1", text: "x", question: null }))).toBeNull();
  });

  it("summarizes events in one line each", () => {
    expect(summarizeEvent(mockedToolCall)).toBe("catalog.getCatalog");
    expect(summarizeEvent(modelCall)).toBe("copilot · claude-sonnet-5-5");
    expect(summarizeEvent(event({ type: "message.received", message_id: "m_1", text: "Will she be approved?" }))).toBe(
      "“Will she be approved?”",
    );
    expect(
      summarizeEvent(event({ type: "field.confirmed", proposal_id: null, field_key: "requested_loan_amount", source: "typed", final_value: 3000000 })),
    ).toBe("requested_loan_amount = $30,000.00 (typed)");
    expect(summarizeEvent(event({ type: "application.state_changed", from: "draft", to: "documents_under_review", derived_banner: null }))).toBe(
      "draft → documents_under_review",
    );
    expect(
      summarizeEvent(event({ type: "guardrail.verdict", layer: "judge", verdict: "block", outcome: "blocked", latency_ms: 3 })),
    ).toBe("judge: block");
  });

  it("prints token counts and latency for model calls only", () => {
    expect(usageText(modelCall)).toBe("1200 in · 80 out · 900 cached · 812 ms");
    expect(usageText(mockedToolCall)).toBeNull();
  });

  it("formats a timestamp with milliseconds in the given zone", () => {
    expect(formatTimestamp("2026-10-28T14:03:22.123Z", "UTC")).toBe("Oct 28, 14:03:22.123");
    expect(formatTimestamp("not a time")).toBe("not a time");
  });
});
