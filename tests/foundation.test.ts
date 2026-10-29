import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fillableFields, requiredFields, zodForField } from "@shared/application-schema";
import { formatApr, formatMoney, parseMoney } from "@shared/format";
import { figureTokens, normalizeFigure, normalizeText, normalizeToken } from "@shared/normalize";
import {
  AuditEventSchema,
  ErrorCodeSchema,
  HealthResponseSchema,
  ApplicationViewSchema,
  auditPiiMap,
} from "@shared/schemas";
import { createApiRouter } from "../server/api/index.js";
import {
  audit,
  createAuditLog,
  createFileSink,
  createMemorySink,
  installAuditLog,
  type Ctx,
  type MemorySink,
} from "../server/audit-log.js";
import { appendMessage, proposeFieldValue, setFieldValue } from "../server/commands.js";
import { translateModelId, useCases } from "../server/config.js";
import { AppError, mapSdkError } from "../server/errors.js";
import { createCatalogMock } from "../server/services/catalog/mock.js";
import { services, withMock, withToolCall } from "../server/services/index.js";
import { store } from "../server/store.js";
import { VERSIONS, computeVersions, getVersions } from "../server/versions.js";

const APP = "app_demo_001";
const ctx: Ctx = {
  application_id: APP,
  session_id: "s1",
  actor: { type: "system", id: "system" },
};

const contractorCtx: Ctx = {
  application_id: APP,
  session_id: "s2",
  actor: { type: "contractor", id: "ctr_demo_001" },
};

let sink: MemorySink;

beforeEach(() => {
  store.reset();
  store.loadSeed();
  sink = createMemorySink();
  installAuditLog(createAuditLog(sink));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("audit log", () => {
  it("stamps id, sequence, time, versions and schema version, and writes one JSON line per event", () => {
    const first = audit.append({
      type: "context.compacted",
      application_id: APP,
      session_id: "s1",
      actor: { type: "system", id: "system" },
      dropped_message_ids: ["m_1"],
    });
    const second = audit.emit(ctx, "context.compacted", { dropped_message_ids: ["m_2"] });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(first.schema_version).toBe(1);
    expect(first.event_id).not.toBe(second.event_id);
    expect(first.versions.calculator).toMatch(/^calculator@/);
    expect(new Date(first.ts).toISOString()).toBe(first.ts);
    expect(sink.lines.map((l) => AuditEventSchema.parse(JSON.parse(l)).seq)).toEqual([1, 2]);
    expect(audit.list(APP).map((e) => e.seq)).toEqual([1, 2]);
    expect(audit.list("other")).toEqual([]);
  });

  it("refuses an event that does not match the schema and stores nothing", () => {
    expect(() =>
      audit.append({
        type: "message.received",
        application_id: APP,
        session_id: "s1",
        actor: { type: "contractor", id: "c" },
        message_id: "m_1",
        text: 42,
      } as never),
    ).toThrow();
    expect(() =>
      audit.append({
        type: "message.received",
        application_id: APP,
        session_id: "s1",
        actor: { type: "contractor", id: "c" },
        message_id: "m_1",
        text: "hi",
        extra_field: true,
      } as never),
    ).toThrow();
    expect(sink.lines).toHaveLength(0);
    expect(audit.list(APP)).toHaveLength(0);
  });

  it("counts tool calls per service and clears on reset", () => {
    audit.emit(ctx, "tool.call", { service: "catalog", method: "getCatalog", input: null, output: {}, latency_ms: 1 });
    audit.emit(ctx, "tool.call", { service: "catalog", method: "getCatalog", input: null, output: {}, latency_ms: 1 });
    audit.emit(ctx, "tool.call", { service: "calculator", method: "calculate", input: null, output: {}, latency_ms: 1 });

    expect(audit.countToolCalls(APP, "catalog")).toBe(2);
    expect(audit.countToolCalls(APP, "credit_engine")).toBe(0);

    audit.reset();
    expect(audit.list(APP)).toEqual([]);
    expect(sink.lines).toEqual([]);
    expect(audit.emit(ctx, "review.started", { task_id: "t" }).seq).toBe(1);
  });

  it("writes JSON lines to a file sink and truncates it on reset", () => {
    const path = join(mkdtempSync(join(tmpdir(), "audit-")), "nested", "audit.jsonl");
    installAuditLog(createAuditLog(createFileSink(path, { truncate: true })));
    audit.emit(ctx, "review.started", { task_id: "t1" });
    audit.emit(ctx, "review.started", { task_id: "t2" });
    expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
    audit.reset();
    expect(readFileSync(path, "utf8")).toBe("");
  });

  it("annotates personal and document payload fields with a PII class", () => {
    const map = auditPiiMap();
    expect(map["message.received"]).toEqual({ text: "free_text" });
    expect(map["model.call"]).toMatchObject({ raw_input: "model_io", raw_output: "model_io" });
    expect(map["field.confirmed"]).toEqual({ final_value: "mixed" });
    expect(map["view.rendered"]).toEqual({ props: "financial" });
  });

  it("covers every event type of the data model, and every error code", () => {
    const types = AuditEventSchema.options.map((o) => o.shape.type.value);
    for (const type of [
      "message.received",
      "model.call",
      "tool.call",
      "guardrail.verdict",
      "field.proposed",
      "field.edited",
      "field.confirmed",
      "field.rejected",
      "view.rendered",
      "document.attached",
      "extraction.completed",
      "review.task_created",
      "review.completed",
      "discrepancy.raised",
      "discrepancy.sent",
      "discrepancy.replied",
      "discrepancy.resolved",
      "application.state_changed",
      "context.compacted",
    ]) {
      expect(types).toContain(type);
    }
    expect(ErrorCodeSchema.options).toHaveLength(14);
  });
});

describe("versions and config", () => {
  it("records <name>@absent for files that do not exist and never throws", () => {
    const empty = mkdtempSync(join(tmpdir(), "versions-"));
    const versions = computeVersions(empty);
    expect(versions.copilot_prompt).toBe("copilot_prompt@absent");
    expect(versions.schemas).toBe("schemas@absent");
    expect(versions.git_sha).toBe("unknown");

    writeFileSync(join(empty, "package.json"), "{}");
    const real = computeVersions();
    expect(real.application_schema).toMatch(/^application_schema@[0-9a-f]{8}$/);
    expect({ ...VERSIONS }).toEqual(getVersions());
    expect(VERSIONS.application_schema).toBe(getVersions().application_schema);
  });

  it("translates the pinned model ids for an OpenRouter base URL only", () => {
    expect(translateModelId("claude-sonnet-5-5", undefined)).toBe("claude-sonnet-5-5");
    expect(translateModelId("claude-sonnet-5-5", "https://api.anthropic.com")).toBe("claude-sonnet-5-5");
    expect(translateModelId("claude-sonnet-5-5", "https://openrouter.ai/api/v1")).toBe(
      "anthropic/claude-sonnet-5.5",
    );
    expect(translateModelId("claude-opus-5-5", "https://openrouter.ai/api/v1")).toBe("anthropic/claude-opus-5.5");
    expect(translateModelId("claude-haiku-5-5", "https://openrouter.ai/api/v1")).toBe("anthropic/claude-haiku-5.5");

    vi.stubEnv("ANTHROPIC_BASE_URL", "https://openrouter.ai/api/v1");
    expect(useCases().judge.model).toBe("anthropic/claude-haiku-5.5");
    expect(computeVersions().copilot_model).toBe("anthropic/claude-sonnet-5.5");
    vi.stubEnv("ANTHROPIC_BASE_URL", "");
    expect(useCases().copilot).toMatchObject({
      model: "claude-sonnet-5-5",
      effort: "low",
      max_tokens: 4096,
      sdk: { timeout: 15_000, maxRetries: 0 },
    });
    expect(useCases().extraction).toMatchObject({ model: "claude-opus-5-5", effort: "medium" });
  });
});

describe("error mapping", () => {
  it("maps SDK errors most specific first", () => {
    const headers = new Headers();
    expect(mapSdkError(new Anthropic.AuthenticationError(401, {}, "no", headers)).code).toBe("llm.auth_failed");
    expect(mapSdkError(new Anthropic.RateLimitError(429, {}, "slow", headers))).toMatchObject({
      code: "llm.rate_limited",
      retryable: true,
    });
    expect(mapSdkError(new Anthropic.APIConnectionTimeoutError({})).code).toBe("llm.timeout");
    expect(mapSdkError(new Anthropic.APIConnectionError({})).code).toBe("llm.timeout");
    expect(mapSdkError(new Anthropic.InternalServerError(500, {}, "boom", headers))).toMatchObject({
      code: "llm.server_error",
      retryable: true,
    });
    expect(mapSdkError(new Error("other"))).toMatchObject({ code: "internal", retryable: false });
    const passthrough = new AppError("catalog.unavailable");
    expect(mapSdkError(passthrough)).toBe(passthrough);
  });
});

describe("services", () => {
  it("attaches _mock and appends a tool.call event through withMock", async () => {
    const result = await withMock(ctx, "contractor_profile", "getProfile", () =>
      services.contractorProfile.getProfile("ctr_demo_001"),
    );
    expect(result).toMatchObject({
      id: "ctr_demo_001",
      _mock: { service: "contractor_profile", fixture_id: "contractor_profile.getProfile", mock_version: 1 },
    });
    const [event] = audit.list(APP);
    expect(event).toMatchObject({ type: "tool.call", service: "contractor_profile", method: "getProfile" });
    expect(event && "_mock" in event && event._mock).toMatchObject({ mock_version: 1 });
  });

  it("logs a failing call and rethrows; reports an unwired catalog as catalog.unavailable", async () => {
    await expect(
      withMock(ctx, "catalog", "getCatalog", () => createCatalogMock().getCatalog()),
    ).rejects.toMatchObject({ code: "catalog.unavailable" });
    expect(audit.countToolCalls(APP, "catalog")).toBe(1);
  });

  it("logs real in-process work without a _mock envelope", async () => {
    const { result } = await withToolCall(ctx, "calculator", "calculate", () => ({ ok: true }), {
      options_id: "opt_1",
    });
    expect(result).toEqual({ ok: true });
    const event = audit.list(APP)[0];
    expect(event).toMatchObject({ type: "tool.call", service: "calculator", options_id: "opt_1" });
    expect(event && "_mock" in event).toBe(false);
  });

  it("fails loudly if the credit engine or Plaid is ever called", () => {
    expect(() => services.creditEngine.decide(APP)).toThrow(/must not be called/);
    expect(() => services.plaid.startVerification(APP)).toThrow();
  });
});

describe("api routes", () => {
  async function serve(run: (base: string) => Promise<void>) {
    const server = express();
    server.use(createApiRouter());
    const listener = server.listen(0);
    await new Promise<void>((resolve) => listener.once("listening", () => resolve()));
    const { port } = listener.address() as AddressInfo;
    try {
      await run(`http://127.0.0.1:${port}`);
    } finally {
      listener.close();
    }
  }

  const headers = { "content-type": "application/json", "x-session-id": "sess-1" };
  const post = (base: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });

  it("reports health without exposing the key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("COPILOT_ENABLED", "");
    vi.stubEnv("EXTRACTION_ENABLED", "false");
    await serve(async (base) => {
      const health = HealthResponseSchema.parse(await (await fetch(`${base}/api/healthz`)).json());
      expect(health).toMatchObject({ has_llm_key: false, copilot_enabled: true, extraction_enabled: false });
      expect(health.versions.copilot_model).toBeTruthy();
    });
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-secret");
    await serve(async (base) => {
      const text = await (await fetch(`${base}/api/healthz`)).text();
      expect(JSON.parse(text).has_llm_key).toBe(true);
      expect(text).not.toContain("sk-secret");
    });
  });

  it("walks the floor routes: edit, load demo, view, audit, reset", async () => {
    await serve(async (base) => {
      const empty = ApplicationViewSchema.parse(await (await fetch(`${base}/api/applications/${APP}`)).json());
      expect(empty).toMatchObject({ status: "draft", fields: {}, document_ids: [], banner: null });

      const edit = await post(base, `/api/applications/${APP}/fields/project_amount`, { value: "$30K" });
      expect(edit.status).toBe(200);
      expect(ApplicationViewSchema.parse(await edit.json()).fields.project_amount).toMatchObject({
        value: 3_000_000,
        state: "typed",
      });
      const bad = await post(base, `/api/applications/${APP}/fields/project_amount`, { value: "lots" });
      expect(bad.status).toBe(400);
      expect((await post(base, `/api/applications/${APP}/fields/ssn`, { value: "1" })).status).toBe(404);
      expect((await post(base, `/api/applications/nope/submit`)).status).toBe(404);

      const demo = ApplicationViewSchema.parse(await (await post(base, `/api/applications/${APP}/load-demo`)).json());
      expect(demo.fields).toMatchObject({
        project_type: { value: "roofing", state: "typed" },
        project_amount: { value: 3_000_000 },
        requested_loan_amount: { value: 3_000_000 },
        stated_annual_income: { value: 8_500_000 },
      });
      expect(demo.documents.map((d) => d.slot)).toEqual(["pay_stub", "estimate", "scope_letter"]);
      const again = ApplicationViewSchema.parse(await (await post(base, `/api/applications/${APP}/load-demo`)).json());
      expect(again.documents).toHaveLength(3);

      const trail = (await (await fetch(`${base}/api/applications/${APP}/audit`)).json()) as {
        credit_engine_calls: number;
        events: Array<{ session_id: string }>;
      };
      expect(trail.credit_engine_calls).toBe(0);
      expect(trail.events.length).toBeGreaterThan(0);
      expect(trail.events[0].session_id).toBe("sess-1");

      expect((await post(base, "/api/reset")).status).toBe(200);
      const after = ApplicationViewSchema.parse(await (await fetch(`${base}/api/applications/${APP}`)).json());
      expect(after.fields).toEqual({});
      expect(after.document_ids).toEqual([]);
      expect(audit.list(APP)).toEqual([]);
    });
  });

  it("returns a JSON 404 for an unknown api path and rejects a malformed body", async () => {
    await serve(async (base) => {
      const missing = await fetch(`${base}/api/nope`);
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ code: "internal" });

      const malformed = await fetch(`${base}/api/applications/${APP}/fields/project_type`, {
        method: "POST",
        headers,
        body: "{not json",
      });
      expect(malformed.status).toBe(400);
      expect(await malformed.json()).toMatchObject({ code: "internal", retryable: false });
    });
  });

  it("merges a live proposal into the field view as old to new", async () => {
    setFieldValue(contractorCtx, "requested_loan_amount", 3_000_000);
    const { message } = appendMessage(contractorCtx, "Make it forty.");
    proposeFieldValue(contractorCtx, {
      field_key: "requested_loan_amount",
      value: 4_000_000,
      source: { kind: "message", ref: { message_id: message.id, quote: "Make it forty." } },
    });
    await serve(async (base) => {
      const view = ApplicationViewSchema.parse(await (await fetch(`${base}/api/applications/${APP}`)).json());
      expect(view.fields.requested_loan_amount).toMatchObject({
        value: 4_000_000,
        state: "proposed",
        previous: { value: 3_000_000, state: "typed" },
      });
      const confirmed = ApplicationViewSchema.parse(
        await (await post(base, `/api/applications/${APP}/confirm-all`)).json(),
      );
      expect(confirmed.fields.requested_loan_amount).toMatchObject({ value: 4_000_000, state: "confirmed" });
    });
  });
});

describe("application schema", () => {
  it("separates fillable fields from decision-engine inputs", () => {
    const fillable = fillableFields().map((f) => f.id);
    expect(fillable).toContain("requested_loan_amount");
    expect(fillable).not.toContain("stated_annual_income");
    expect(requiredFields().map((f) => f.id)).toContain("stated_annual_income");
  });

  it("parses typed strings into stored values", () => {
    expect(zodForField("project_amount").parse("$30K")).toBe(3_000_000);
    expect(zodForField("project_amount").parse("30,000")).toBe(3_000_000);
    expect(zodForField("project_amount").parse("30000.00")).toBe(3_000_000);
    expect(zodForField("project_type").parse("Windows Doors")).toBe("windows_doors");
    expect(zodForField("preferred_term_months").parse("120")).toBe("120");
    expect(zodForField("property_zip").parse(" 94110 ")).toBe("94110");
    expect(zodForField("project_amount").safeParse("thirty").success).toBe(false);
    expect(zodForField("property_zip").safeParse("9411").success).toBe(false);
    expect(zodForField("preferred_term_months").safeParse("100").success).toBe(false);
  });
});

describe("shared formatters and normalizer", () => {
  it("formats money and APR with two decimals", () => {
    expect(formatMoney(3_000_000)).toBe("$30,000.00");
    expect(formatMoney(39_629)).toBe("$396.29");
    expect(formatMoney(5)).toBe("$0.05");
    expect(formatMoney(123_456_789)).toBe("$1,234,567.89");
    expect(formatApr(999)).toBe("9.99%");
    expect(formatApr(0)).toBe("0.00%");
    expect(parseMoney("$1.5m")).toBe(150_000_000);
    expect(parseMoney("$30.5K")).toBe(3_050_000);
    expect(parseMoney("12.345")).toBeNull();
    expect(parseMoney("-5")).toBeNull();
    expect(parseMoney("")).toBeNull();
  });

  it("normalizes tokens and text", () => {
    expect(normalizeToken("$4,250.00")).toBe("4250.00");
    expect(normalizeToken("4,25O.00")).toBe("4250.00");
    expect(normalizeToken("l,000")).toBe("1000");
    expect(normalizeToken("03/15/2025,")).toBe("03/15/2025");
    expect(normalizeToken("Bi-Weekly")).toBe("biweekly");
    expect(normalizeToken("lol")).toBe("lol");
    expect(normalizeText("Gross  Pay:\n$4,250.00")).toBe("gross pay 4250.00");
    expect(normalizeText("pay-\nment due")).toBe("payment due");
  });

  it("canonicalizes figures so equal amounts compare equal", () => {
    expect(figureTokens("Use $40,000 as the amount; you said $40K.")).toEqual(["40000.00", "40000.00"]);
    expect(figureTokens("$396.29 a month at 9.99% for 120 months (10 years)")).toEqual([
      "396.29",
      "9.99%",
      "120 months",
      "10 years",
    ]);
    expect(figureTokens("0% for 18-month promo, 0.00% APR")).toEqual(["0%", "18 months", "0%"]);
    expect(figureTokens("about $300 over 15 years")).toEqual(["300.00", "15 years"]);
    expect(figureTokens("1.5 years")).toEqual([]);
    expect(normalizeFigure("$414.14")).toBe("414.14");
    expect(normalizeFigure("no figures here")).toBeNull();
  });
});
