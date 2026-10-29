import { afterEach, describe, expect, it, vi } from "vitest";
import { UNREADABLE_REPLY_MESSAGE } from "../web/src/copy";
import { HOMEOWNER_PROPS, OPTIONS_DISPLAY, SHORT_BLOCK } from "./helpers/web-fixtures";

// The API client: the session id each page load sends, and the homeowner view reply it will hand
// to a screen.

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("session id", () => {
  it("is made once per page load, kept in module memory and never written to sessionStorage", async () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error("sessionStorage must not be read");
      }),
      setItem: vi.fn(() => {
        throw new Error("sessionStorage must not be written");
      }),
    };
    vi.stubGlobal("sessionStorage", storage);
    const { getSessionId } = await import("../web/src/api");
    const first = getSessionId();
    expect(first).toMatch(/^[0-9a-f-]{16,}$/);
    expect(getSessionId()).toBe(first);
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("starts a new session when the page loads again", async () => {
    const before = (await import("../web/src/api")).getSessionId();
    vi.resetModules();
    const after = (await import("../web/src/api")).getSessionId();
    expect(after).not.toBe(before);
  });

  it("is sent as x-session-id on every request", async () => {
    const seen: Array<Record<string, string>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        seen.push((init?.headers ?? {}) as Record<string, string>);
        return json({ code: "internal", message: "No.", retryable: false }, 500);
      }),
    );
    const api = await import("../web/src/api");
    await expect(api.getApplication("app_demo_001")).rejects.toMatchObject({ name: "ApiError" });
    await expect(api.getAudit("app_demo_001")).rejects.toMatchObject({ name: "ApiError" });
    expect(seen.map((headers) => headers["x-session-id"])).toEqual([api.getSessionId(), api.getSessionId()]);
  });
});

describe("createHomeownerView", () => {
  it("hands over props whose disclosure block covers every option", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(HOMEOWNER_PROPS)));
    const { createHomeownerView } = await import("../web/src/api");
    const props = await createHomeownerView("app_demo_001", "opt_1");
    expect(props.options.options).toHaveLength(3);
  });

  it("refuses a reply that leaves an option without its disclosure entry", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...HOMEOWNER_PROPS, disclosure_block: SHORT_BLOCK })));
    const { createHomeownerView } = await import("../web/src/api");
    const failure = await createHomeownerView("app_demo_001", "opt_1").catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "ApiError", message: UNREADABLE_REPLY_MESSAGE });
    expect(spy).toHaveBeenCalled();
  });

  it("refuses a reply whose display strings leave an option out", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn(async () => json({ ...HOMEOWNER_PROPS, options_display: OPTIONS_DISPLAY.slice(0, 2) })));
    const { createHomeownerView } = await import("../web/src/api");
    const failure = await createHomeownerView("app_demo_001", "opt_1").catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "ApiError", message: UNREADABLE_REPLY_MESSAGE });
    expect(spy).toHaveBeenCalled();
  });
});
