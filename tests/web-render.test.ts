import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OLDER_OPTIONS_CAPTION, UNREADABLE_REPLY_MESSAGE } from "../web/src/copy";
import { conversationStore } from "../web/src/hooks";
import { loadComponent } from "./helpers/web-components";
import {
  FOOTER,
  HOMEOWNER_PROPS,
  OPTIONS_DISPLAY,
  OPTIONS_LINE,
  SHORT_BLOCK,
  applicationView,
  proposedField,
  typedField,
} from "./helpers/web-fixtures";

// What the screens print, rendered on the server with fixture data: no browser, so only what a
// first render shows. The chat is driven through the page's own store with a stubbed network.

const ApplicationForm = await loadComponent("components/ApplicationForm.tsx", "ApplicationForm");
const CopilotPanel = await loadComponent("components/CopilotPanel.tsx", "CopilotPanel");
const OptionsTable = await loadComponent("components/OptionsTable.tsx", "OptionsTable");
const HomeownerView = await loadComponent("routes/HomeownerView.tsx", "HomeownerView");
const DisclosureBlockView = await loadComponent("components/DisclosureBlockView.tsx", "DisclosureBlockView");

function render(element: ReactElement, state?: unknown): string {
  return renderToStaticMarkup(h(StaticRouter, { location: { pathname: "/", state } }, element));
}

const text = (html: string): string => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const count = (html: string, needle: string): number => html.split(needle).length - 1;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("proposal cards", () => {
  const noop = async () => undefined;
  const actions = { setField: noop, confirm: noop, reject: noop, edit: noop, confirmAll: noop };
  const form = (canShowSource: (messageId: string) => boolean, source?: Parameters<typeof proposedField>[2]) =>
    render(
      h(ApplicationForm, {
        view: applicationView({
          requested_loan_amount: typedField(3000000),
          property_zip: proposedField("95112", "p1", source),
        }),
        actions,
        canShowSource,
        onShowSource: () => undefined,
      }),
    );

  it("shows the verified quote from the application view, with or without the chat that produced it", () => {
    const source = { kind: "message" as const, ref: { message_id: "m_1", quote: "zip 95112" } };
    // After a reload: the chat on the page does not hold the message.
    const reloaded = form(() => false, source);
    expect(reloaded).toContain('<blockquote class="proposal-quote">zip 95112</blockquote>');
    expect(reloaded).not.toContain("badge-button");
    // Same page as the chat: the badge jumps to the message.
    const samePage = form(() => true, source);
    expect(samePage).toContain('<blockquote class="proposal-quote">zip 95112</blockquote>');
    expect(samePage).toContain("badge-button");
  });

  it("shows no quotation for a proposal that did not come from a message", () => {
    const html = form(() => true, { kind: "formula", ref: { formula: "income / 12", inputs: [] } });
    expect(html).not.toContain("proposal-quote");
    expect(html).not.toContain("badge-button");
    expect(html).toContain("Confirm");
  });
});

describe("options table", () => {
  it("prints the server's payment, term and APR strings for every option and no figure of its own", () => {
    const html = render(h(OptionsTable, { line: OPTIONS_LINE }));
    for (const letter of ["A", "B", "C"]) {
      expect(html).toContain(`SERVER-PAY-${letter}`);
      expect(html).toContain(`SERVER-TERM-${letter}`);
      expect(html).toContain(`SERVER-APR-${letter}`);
    }
    expect(html).not.toContain("$387.50");
    expect(html).not.toContain("a month");
    expect(html).not.toContain("9.99%");
    expect(html).toContain(FOOTER);
  });
});

describe("disclosure box", () => {
  it("prints the entry of the product it is given", () => {
    const html = render(h(DisclosureBlockView, { block: HOMEOWNER_PROPS.disclosure_block, productId: "fixed_10y" }));
    expect(count(html, 'class="tila-box"')).toBe(1);
  });

  it("refuses to render a product the block has no entry for, naming the product", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(h(DisclosureBlockView, { block: SHORT_BLOCK, productId: "deferred_12m" }))).toThrow(/deferred_12m/);
  });
});

describe("homeowner view", () => {
  const view = (state: unknown) => render(h(HomeownerView), state);
  const incomplete = (html: string) => {
    expect(count(html, "option-card")).toBe(0);
    expect(count(html, "tila")).toBe(0);
    expect(count(html, "SERVER-")).toBe(0);
    expect(text(html)).toContain(UNREADABLE_REPLY_MESSAGE);
    expect(html).toContain("Back to application");
  };

  it("prints a card with its TILA box for every option, with the server's strings", () => {
    const html = view(HOMEOWNER_PROPS);
    expect(count(html, 'class="option-card"')).toBe(3);
    expect(count(html, 'class="tila-box"')).toBe(3);
    expect(html).toContain("SERVER-PAY-A");
    expect(html).toContain("SERVER-TERM-B");
    expect(html).toContain("SERVER-APR-C");
    expect(html).not.toContain("$387.50 a month");
    expect(html).toContain(HOMEOWNER_PROPS.what_happens_next);
  });

  it("prints no card at all, and the error text instead, when the disclosure block misses an option", () => {
    incomplete(view({ ...HOMEOWNER_PROPS, disclosure_block: SHORT_BLOCK }));
  });

  it("prints no card at all, and the error text instead, when the display strings miss an option", () => {
    incomplete(view({ ...HOMEOWNER_PROPS, options_display: OPTIONS_DISPLAY.slice(0, 2) }));
  });

  it("asks to be opened from the application when it has no props", () => {
    const html = view(undefined);
    expect(text(html)).toContain("Open this from the application.");
    expect(count(html, "option-card")).toBe(0);
  });
});

describe("assistant panel", () => {
  const encoder = new TextEncoder();
  const ndjson = (...lines: unknown[]): string => lines.map((entry) => JSON.stringify(entry)).join("\n") + "\n";

  /** A chat reply whose body the test writes to and closes itself. */
  function openReply() {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(started) {
        controller = started;
      },
    });
    return {
      response: new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } }),
      write: (...lines: unknown[]) => controller?.enqueue(encoder.encode(ndjson(...lines))),
      close: () => controller?.close(),
    };
  }

  const panel = (applicationId: string): string =>
    render(h(CopilotPanel, { applicationId, view: applicationView({ requested_loan_amount: typedField(3000000) }), focus: null }));

  /** The open tags of the "Show homeowner view" buttons, newest last. */
  const viewButtons = (html: string): string[] => html.match(/<button[^>]*>Show homeowner view<\/button>/g) ?? [];

  const optionsReply = (optionsId: string) => {
    const { type: _type, ...rest } = { ...OPTIONS_LINE, options_id: optionsId };
    return new Response(JSON.stringify(rest), { status: 200, headers: { "content-type": "application/json" } });
  };

  it("opens the homeowner view only from the newest options table", async () => {
    let served = 0;
    vi.stubGlobal("fetch", vi.fn(async () => optionsReply(`opt_${++served}`)));
    await conversationStore.showPaymentOptions("app_tables");
    await conversationStore.showPaymentOptions("app_tables");
    await conversationStore.showPaymentOptions("app_tables");
    const html = panel("app_tables");
    const buttons = viewButtons(html);
    expect(buttons).toHaveLength(3);
    expect(buttons.map((tag) => tag.includes('disabled=""'))).toEqual([true, true, false]);
    // Older tables keep their numbers and say why the button is off.
    expect(count(html, OLDER_OPTIONS_CAPTION)).toBe(2);
    expect(count(html, "SERVER-PAY-A")).toBe(3);
  });

  it("turns the newest table's button off while a reply is running", async () => {
    const reply = openReply();
    vi.stubGlobal("fetch", vi.fn(async () => reply.response));
    const turn = conversationStore.sendMessage("app_running", "What would the payment be?");
    reply.write(OPTIONS_LINE, { type: "status", step: "Checking wording..." });
    await vi.waitFor(() => expect(conversationStore.getConversation("app_running").exchanges[0]?.turn.options).not.toBeNull());
    const html = panel("app_running");
    const buttons = viewButtons(html);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toContain('disabled=""');
    expect(html).not.toContain(OLDER_OPTIONS_CAPTION);
    reply.write({ type: "done", event_ids: [] });
    reply.close();
    await turn;
    expect(viewButtons(panel("app_running"))[0]).not.toContain('disabled=""');
  });

  it("prints the explanation's footer under the explanation even when it equals the table's footer", async () => {
    const reply = openReply();
    vi.stubGlobal("fetch", vi.fn(async () => reply.response));
    const turn = conversationStore.sendMessage("app_footer", "Explain the options.");
    reply.write(
      OPTIONS_LINE,
      { type: "explanation", text: "Option A costs less per month.", footer: FOOTER, event_ids: [] },
      { type: "done", event_ids: [] },
    );
    reply.close();
    await turn;
    const html = panel("app_footer");
    expect(count(html, FOOTER)).toBe(2);
    expect(html).toContain(`<p class="reply-footer">${FOOTER}</p>`);
    expect(html).toContain(`<p class="options-footer">${FOOTER}</p>`);
  });

  it("prints the fallback in place of an explanation the guardrail then blocked", async () => {
    const reply = openReply();
    vi.stubGlobal("fetch", vi.fn(async () => reply.response));
    const turn = conversationStore.sendMessage("app_fallback", "Write something to read to her.");
    reply.write(
      { type: "explanation", text: "A draft that was blocked.", footer: null, event_ids: [] },
      {
        type: "fallback",
        text: "I can't phrase that in a way that meets lending rules.",
        marker: "Wording adjusted to comply with lending rules. View in audit",
        audit_event_id: "evt_9",
      },
      { type: "done", event_ids: [] },
    );
    reply.close();
    await turn;
    const html = panel("app_fallback");
    expect(html).toContain("I can&#x27;t phrase that in a way that meets lending rules.");
    expect(html).not.toContain("A draft that was blocked.");
    expect(html).toContain("Wording adjusted to comply with lending rules.");
  });
});
