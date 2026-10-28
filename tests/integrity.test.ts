import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isNumericToken, normalizeText, normalizeToken } from "@shared/normalize";
import { AuditEventSchema, JsonValueSchema } from "@shared/schemas";
import { createApiRouter } from "../server/api/index.js";
import {
  audit,
  createAuditLog,
  createMemorySink,
  installAuditLog,
  type AuditEventInput,
  type AuditSink,
  type Ctx,
  type MemorySink,
} from "../server/audit-log.js";
import { setFieldValue } from "../server/commands.js";
import { useCases } from "../server/config.js";
import { AppError, toErrorResponse } from "../server/errors.js";
import { loadEnvFile } from "../server/load-env.js";
import { services } from "../server/services/index.js";
import { store } from "../server/store.js";
import { getVersions } from "../server/versions.js";
import { ROOT_ENV_FILE, resolveApiPort } from "../vite.config.js";

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
  vi.restoreAllMocks();
});

const tempDir = () => mkdtempSync(join(tmpdir(), "integrity-"));

/** A sink that fails every write and truncate while `failing` is true. */
function flakySink() {
  const state = { failing: true, lines: [] as string[] };
  const sinkImpl: AuditSink = {
    appendLine: (json) => {
      if (state.failing) throw new Error("disk full");
      state.lines.push(json);
    },
    truncate: () => {
      if (state.failing) throw new Error("disk full");
      state.lines.length = 0;
    },
  };
  return { state, sink: sinkImpl };
}

const compacted = (id: string): AuditEventInput => ({
  type: "context.compacted",
  application_id: APP,
  session_id: "s1",
  actor: { type: "system", id: "system" },
  dropped_message_ids: [id],
});

describe("audit write order", () => {
  it("commits an event to memory and advances seq only after the sink accepted it", () => {
    const { state, sink: failing } = flakySink();
    const log = createAuditLog(failing);

    expect(() => log.emit(ctx, "review.started", { task_id: "t1" })).toThrow("disk full");
    expect(log.list(APP)).toEqual([]);
    expect(state.lines).toEqual([]);

    state.failing = false;
    const event = log.emit(ctx, "review.started", { task_id: "t1" });
    expect(event.seq).toBe(1);
    expect(log.list(APP).map((e) => e.seq)).toEqual([1]);
    expect(state.lines).toHaveLength(1);
  });

  it("keeps memory when the sink cannot be emptied on reset", () => {
    const { state, sink: failing } = flakySink();
    state.failing = false;
    const log = createAuditLog(failing);
    log.emit(ctx, "review.started", { task_id: "t1" });

    state.failing = true;
    expect(() => log.reset()).toThrow("disk full");
    expect(log.list(APP)).toHaveLength(1);
    expect(state.lines).toHaveLength(1);
    state.failing = false;
    expect(log.emit(ctx, "review.started", { task_id: "t2" }).seq).toBe(2);
  });
});

describe("audit batches", () => {
  it("validates every event before persisting any: an invalid second event leaves no first event", () => {
    const invalid = { ...compacted("m_2"), dropped_message_ids: "not-an-array" } as unknown as AuditEventInput;

    expect(() => audit.appendAll([compacted("m_1"), invalid])).toThrow();
    expect(audit.list(APP)).toEqual([]);
    expect(sink.lines).toEqual([]);
    expect(audit.emit(ctx, "review.started", { task_id: "t" }).seq).toBe(1);
  });

  it("stamps consecutive sequence numbers and writes the batch to the sink in order", () => {
    const events = audit.appendAll([compacted("m_1"), compacted("m_2"), compacted("m_3")]);

    expect(events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(new Set(events.map((e) => e.event_id)).size).toBe(3);
    expect(sink.lines.map((l) => AuditEventSchema.parse(JSON.parse(l)).seq)).toEqual([1, 2, 3]);
    expect(audit.list(APP).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(audit.appendAll([])).toEqual([]);
  });

  it("commits nothing when the sink refuses the batch", () => {
    const written: string[] = [];
    let failing = true;
    const log = createAuditLog({
      appendLine: (json) => {
        if (failing) throw new Error("disk full");
        written.push(json);
      },
      appendLines: (batch) => {
        if (failing) throw new Error("disk full");
        written.push(...batch);
      },
    });

    expect(() => log.appendAll([compacted("m_1"), compacted("m_2")])).toThrow("disk full");
    expect(log.list(APP)).toEqual([]);
    failing = false;
    expect(log.appendAll([compacted("m_1"), compacted("m_2")]).map((e) => e.seq)).toEqual([1, 2]);
    expect(written).toHaveLength(2);
  });

  it("falls back to one write per event for a sink without a batch method", () => {
    const lines: string[] = [];
    const log = createAuditLog({ appendLine: (json) => void lines.push(json) });
    log.appendAll([compacted("m_1"), compacted("m_2")]);
    expect(lines).toHaveLength(2);
    expect(log.list(APP)).toHaveLength(2);
  });
});

describe("required JSON payloads", () => {
  const base = {
    event_id: "evt_1",
    application_id: APP,
    session_id: "s1",
    seq: 1,
    ts: "2026-10-28T12:00:00.000Z",
    actor: { type: "model", id: "copilot" },
    schema_version: 1,
    versions: getVersions(),
  };
  const modelCall = {
    ...base,
    type: "model.call",
    use_case: "copilot",
    model_id: "claude-sonnet-5-5",
    effort: "low",
    context: { message_ids: [], system_prompt_version: "copilot_prompt@absent", system_prompt_sha256: "0" },
    raw_input: { messages: [{ role: "user", content: "hi" }] },
    raw_output: { content: [] },
    usage: { input: 1, output: 1, cache_read: 0 },
    latency_ms: 5,
    stop_reason: "end_turn",
  };
  const toolCall = {
    ...base,
    type: "tool.call",
    service: "catalog",
    method: "getCatalog",
    input: null,
    output: { products: [] },
    latency_ms: 1,
  };

  it("accepts complete model.call and tool.call events, with null as a real payload", () => {
    expect(AuditEventSchema.safeParse(modelCall).success).toBe(true);
    expect(AuditEventSchema.safeParse({ ...modelCall, raw_output: null }).success).toBe(true);
    expect(AuditEventSchema.safeParse(toolCall).success).toBe(true);
  });

  it("rejects an event that omits a required payload", () => {
    for (const key of ["raw_input", "raw_output"] as const) {
      const { [key]: _omitted, ...without } = modelCall;
      expect(AuditEventSchema.safeParse(without).success).toBe(false);
      expect(AuditEventSchema.safeParse({ ...modelCall, [key]: undefined }).success).toBe(false);
    }
    for (const key of ["input", "output"] as const) {
      const { [key]: _omitted, ...without } = toolCall;
      expect(AuditEventSchema.safeParse(without).success).toBe(false);
      expect(AuditEventSchema.safeParse({ ...toolCall, [key]: undefined }).success).toBe(false);
    }
  });

  it("rejects a payload that is not JSON, nested undefined included", () => {
    expect(JsonValueSchema.safeParse({ a: [1, "x", null, { b: true }] }).success).toBe(true);
    for (const bad of [undefined, { a: undefined }, [undefined], new Date(), 1n, Number.NaN, Infinity, () => 1]) {
      expect(JsonValueSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("refuses to append an event whose payload is missing", () => {
    const { raw_input: _raw, ...without } = modelCall;
    expect(() => audit.append(without as never)).toThrow();
    expect(sink.lines).toEqual([]);
  });
});

describe("normalizer boundary punctuation", () => {
  it("does not let trailing punctuation turn $42.50 into $4,250", () => {
    expect(normalizeToken("$42.50;")).toBe("42.50");
    expect(normalizeToken("$42.50;")).toBe(normalizeToken("$42.50"));
    expect(normalizeToken("$42.50;")).not.toBe(normalizeToken("$4,250"));
    expect(normalizeToken("$42.50")).not.toBe(normalizeToken("$4,250"));
  });

  it("strips sentence punctuation around a number and keeps the separators inside it", () => {
    expect(normalizeToken("1,812.40.")).toBe(normalizeToken("1,812.40"));
    expect(normalizeToken("1,812.40.")).toBe("1812.40");
    for (const wrapped of ['"$42.50"', "($42.50)", "$42.50:", "$42.50!", "$42.50?", "'$42.50',", "42.50%."]) {
      expect(normalizeToken(wrapped)).toBe("42.50");
    }
    expect(normalizeToken("03/15/2025;")).toBe("03/15/2025");
    expect(isNumericToken("$42.50;")).toBe(true);
    expect(isNumericToken("...")).toBe(false);
    expect(normalizeText("Net pay: $42.50; due 03/15/2025.")).toBe("net pay 42.50 due 03/15/2025");
  });
});

describe("contractor profile mock", () => {
  it("answers a missing profile with the generic internal text and keeps the diagnostic in cause", async () => {
    const failure = await services.contractorProfile.getProfile("ctr_missing_77").then(
      () => undefined,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(AppError);
    const { status, body } = toErrorResponse(failure);
    expect(status).toBe(500);
    expect(body).toEqual({
      code: "internal",
      message: "Something went wrong on our side. Please try again.",
      retryable: false,
    });
    expect(JSON.stringify(body)).not.toContain("ctr_missing_77");
    expect((failure as AppError).cause).toBeInstanceOf(Error);
    expect(((failure as AppError).cause as Error).message).toContain("ctr_missing_77");
  });
});

describe("POST /api/reset ordering", () => {
  async function serve(options: { seedPath?: string }, run: (base: string) => Promise<void>) {
    const server = express();
    server.use(createApiRouter(options));
    const listener = server.listen(0);
    await new Promise<void>((resolve) => listener.once("listening", () => resolve()));
    const { port } = listener.address() as AddressInfo;
    try {
      await run(`http://127.0.0.1:${port}`);
    } finally {
      listener.close();
    }
  }
  const reset = (base: string) => fetch(`${base}/api/reset`, { method: "POST" });

  function expectHistoryAndStoreIntact() {
    expect(store.getApplication(APP)?.fields.project_amount).toMatchObject({ value: 3_000_000 });
    expect(audit.list(APP)).toHaveLength(1);
  }

  it("keeps the store and the audit history when the seed is malformed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    setFieldValue(contractorCtx, "project_amount", 3_000_000);
    const seedPath = join(tempDir(), "seed.json");
    writeFileSync(seedPath, JSON.stringify({ contractors: "nope" }));

    await serve({ seedPath }, async (base) => {
      expect((await reset(base)).status).toBe(500);
    });
    expectHistoryAndStoreIntact();
    expect(sink.lines).toHaveLength(1);
  });

  it("keeps the store and the audit history when the seed file is missing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    setFieldValue(contractorCtx, "project_amount", 3_000_000);

    await serve({ seedPath: join(tempDir(), "absent.json") }, async (base) => {
      expect((await reset(base)).status).toBe(500);
    });
    expectHistoryAndStoreIntact();
  });

  it("keeps the store when the audit file cannot be emptied", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { state, sink: failing } = flakySink();
    state.failing = false;
    installAuditLog(createAuditLog(failing));
    setFieldValue(contractorCtx, "project_amount", 3_000_000);
    state.failing = true;

    await serve({}, async (base) => {
      expect((await reset(base)).status).toBe(500);
    });
    expectHistoryAndStoreIntact();
    expect(state.lines).toHaveLength(1);
  });

  it("still clears the history and reloads the seed on success", async () => {
    setFieldValue(contractorCtx, "project_amount", 3_000_000);
    await serve({}, async (base) => {
      expect((await reset(base)).status).toBe(200);
    });
    expect(store.getApplication(APP)?.fields).toEqual({});
    expect(audit.list(APP)).toEqual([]);
    expect(sink.lines).toEqual([]);
  });
});

describe("vite proxy port", () => {
  const envFile = (content?: string) => {
    const path = join(tempDir(), ".env");
    if (content !== undefined) writeFileSync(path, content);
    return path;
  };

  it("reads PORT from the root .env, then the shell, then 3000", () => {
    expect(resolveApiPort(envFile("PORT=3459\n"), "4000")).toBe(3459);
    expect(resolveApiPort(envFile(), "4000")).toBe(4000);
    expect(resolveApiPort(envFile("ANTHROPIC_BASE_URL=x\n"), "4000")).toBe(4000);
    expect(resolveApiPort(envFile("PORT=\n"), "4000")).toBe(4000);
    expect(resolveApiPort(envFile("PORT=banana\n"), "4000")).toBe(4000);
    expect(resolveApiPort(envFile(), undefined)).toBe(3000);
    expect(resolveApiPort(envFile("PORT=99999\n"), "")).toBe(3000);
  });

  it("looks for .env in the repository root, not in web/", () => {
    expect(ROOT_ENV_FILE).toBe(join(import.meta.dirname, "..", ".env"));
  });
});

describe("loading .env", () => {
  it("overrides a variable the shell already exported", () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://api.anthropic.com");
    const path = join(tempDir(), ".env");
    writeFileSync(path, 'ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1\nINTEGRITY_TEST_ONLY="a value"\n');
    try {
      expect(useCases().copilot.model).toBe("claude-sonnet-5-5");
      expect(loadEnvFile(path)).toBe(true);
      expect(process.env.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api/v1");
      expect(process.env.INTEGRITY_TEST_ONLY).toBe("a value");
      expect(useCases().copilot.model).toBe("anthropic/claude-sonnet-5.5");
    } finally {
      delete process.env.INTEGRITY_TEST_ONLY;
    }
  });

  it("does nothing when there is no .env file", () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://api.anthropic.com");
    expect(loadEnvFile(join(tempDir(), "absent.env"))).toBe(false);
    expect(process.env.ANTHROPIC_BASE_URL).toBe("https://api.anthropic.com");
  });
});
