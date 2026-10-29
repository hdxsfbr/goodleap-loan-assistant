import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { schemaForSlot } from "@shared/document-schemas/index";
import type { DocumentSlot, MatchMethod, ProposedValue } from "@shared/schemas";
import { audit } from "../server/audit-log.js";
import { config } from "../server/config.js";
import { enqueueExtraction, extractDocument, loadPositionedText } from "../server/extraction/extract.js";
import { FIXTURE_PATH, loadFixture, type FixtureFile } from "../server/extraction/llm.js";
import { buildExtractionPrompt, buildExtractionRequest, requestSha256 } from "../server/extraction/prompt.js";
import { THRESHOLDS, scoreDocument } from "../server/extraction/score.js";
import { currentProposal } from "../server/review/derived.js";
import { applyDecision, taskView } from "../server/review/tasks.js";
import { store } from "../server/store.js";
import { PROJECT_ROOT } from "../server/versions.js";
import { APP, freshWorld, reviewer, system } from "./helpers/world.js";

// Replays samples/extraction-fixture.json, the recorded real model response for each sample
// document, against the committed documents. No key is used and no request leaves the process:
// the matcher, the parser and the proposals run exactly as they do on a live answer. Each entry
// records a hash of the whole request it answered (system prompt, user prompt with the indexed
// lines, output schema). If any of them changes, or the indexer or a document schema that feed
// them, the recorded hash no longer matches and this suite fails until the fixture is recorded
// again (scripts/record-extraction-fixture.ts).

const SLOTS: DocumentSlot[] = ["pay_stub", "estimate", "scope_letter"];

/** The match method the recorded answers produce for every field; the net pay is not located by construction. */
const EXPECTED_METHOD: Record<DocumentSlot, Record<string, MatchMethod>> = {
  pay_stub: {
    employer_name: "exact",
    pay_period_start: "exact",
    pay_period_end: "exact",
    pay_frequency: "exact",
    gross_pay: "exact",
    net_pay: "not_located",
    ytd_gross: "exact",
  },
  estimate: {
    contractor_name: "exact",
    project_description: "exact",
    estimate_date: "exact",
    total_amount: "exact",
    line_item_count: "exact",
  },
  scope_letter: {
    property_address: "exact",
    scope_summary: "exact",
    start_date: "exact",
    contractor_name: "exact",
  },
};

beforeAll(() => {
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubGlobal("fetch", () => {
    throw new Error("The fixture replay must not make a network request.");
  });
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  freshWorld();
});

function proposalsOf(slot: DocumentSlot): ProposedValue[] {
  return store.listProposals(APP).filter((p) => p.field_key.startsWith(`${slot}.`));
}

describe("the recorded fixture", () => {
  it("holds one response per sample document, recorded from a real call", () => {
    const fixture = loadFixture();
    expect(Object.keys(fixture.entries).sort()).toEqual([...SLOTS].sort());
    for (const slot of SLOTS) {
      const entry = fixture.entries[slot];
      expect(entry?.model_id).toMatch(/claude-opus-5/);
      expect(entry?.effort).toBe("medium");
      expect(entry?.stop_reason).toBe("end_turn");
      expect(entry?.usage.input).toBeGreaterThan(0);
      expect(entry?.usage.output).toBeGreaterThan(0);
      expect(entry?.request_sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("was recorded against the text the indexer produces today", async () => {
    const world = freshWorld();
    const fixture = loadFixture();
    for (const slot of SLOTS) {
      const doc = world.docs[slot];
      if (!doc) throw new Error(`no ${slot} document`);
      const text = await loadPositionedText(system, doc);
      expect(buildExtractionPrompt(schemaForSlot(slot), text).lines_sha256, `${slot}: re-record the fixture`).toBe(
        fixture.entries[slot]?.lines_sha256,
      );
    }
  });

  it("was recorded against the system prompt, the user prompt and the output schema built today", async () => {
    const world = freshWorld();
    const fixture = loadFixture();
    for (const slot of SLOTS) {
      const doc = world.docs[slot];
      if (!doc) throw new Error(`no ${slot} document`);
      const request = buildExtractionRequest(schemaForSlot(slot), await loadPositionedText(system, doc));
      expect(
        requestSha256(request),
        `${slot}: the prompt, a document schema or the indexer changed; record the fixture again`,
      ).toBe(fixture.entries[slot]?.request_sha256);
    }
  });

  it("hashes the system prompt, the user prompt and the output schema separately enough to notice any of them changing", async () => {
    const world = freshWorld();
    const text = await loadPositionedText(system, world.docs.pay_stub!);
    const request = buildExtractionRequest(schemaForSlot("pay_stub"), text);
    const hash = requestSha256(request);
    expect(requestSha256(buildExtractionRequest(schemaForSlot("pay_stub"), text))).toBe(hash);

    expect(requestSha256({ ...request, system: `${request.system}\n` })).not.toBe(hash);
    expect(requestSha256({ ...request, user: request.user.replace("Gross pay", "Gross") })).not.toBe(hash);
    expect(
      requestSha256({ ...request, format: { ...request.format, schema: { ...request.format.schema, additionalProperties: true } } }),
    ).not.toBe(hash);
    // The indexed lines are part of the user prompt: a word the indexer reads differently changes the hash.
    const moved = structuredClone(text);
    const word = moved.pages[0]?.words[0];
    if (!word) throw new Error("no words");
    word.text = `${word.text}x`;
    expect(requestSha256(buildExtractionRequest(schemaForSlot("pay_stub"), moved))).not.toBe(hash);
    // And so is the document schema the prompt and the output format are generated from.
    expect(requestSha256(buildExtractionRequest(schemaForSlot("estimate"), text))).not.toBe(hash);
  });
});

describe("replaying it without a key", () => {
  it("is what runs when no key is present", () => {
    expect(config.hasLlmKey).toBe(false);
  });

  it("produces the expected match method for every field, including not_located for the net pay", async () => {
    await enqueueExtraction(system, store.getApplication(APP)?.document_ids ?? []);
    expect(store.listDocuments(APP).map((d) => d.extraction_status)).toEqual(["done", "done", "done"]);
    for (const slot of SLOTS) {
      const methods = Object.fromEntries(
        proposalsOf(slot).map((p) => [p.field_key.slice(slot.length + 1), p.match?.method]),
      );
      expect(methods, slot).toEqual(EXPECTED_METHOD[slot]);
    }
    const net = store.listProposals(APP).find((p) => p.field_key === "pay_stub.net_pay");
    expect(net?.value).toBe(181240);
    expect(net?.source.kind === "box" && net.source.ref.bbox).toBeNull();
    expect(net?.source.kind === "box" && net.source.ref.words.map((w) => w.text)).toEqual(["1,812.40"]);
    expect(net?.source.kind === "box" && net.source.ref.quoted_text).toBe("1,812.40");
    // Every other pay stub value has a box.
    for (const p of proposalsOf("pay_stub").filter((q) => q.field_key !== "pay_stub.net_pay")) {
      expect(p.source.kind === "box" && p.source.ref.bbox, p.field_key).not.toBeNull();
    }
  });

  it("reproduces the ground truth at the thresholds the design states", async () => {
    await enqueueExtraction(system, store.getApplication(APP)?.document_ids ?? []);
    const scores = Object.fromEntries(SLOTS.map((slot) => [slot, scoreDocument(slot, proposalsOf(slot))]));

    for (const slot of ["estimate", "scope_letter"] as const) {
      const score = scores[slot];
      expect(score?.match_rate, slot).toBeGreaterThanOrEqual(THRESHOLDS.text_pdf_field_match);
      expect(score?.fields.filter((f) => !f.value_match).map((f) => f.field_key)).toEqual([]);
    }
    const payStub = scores.pay_stub;
    expect(payStub?.located_total).toBe(6);
    expect(payStub?.located_rate).toBeGreaterThanOrEqual(THRESHOLDS.image_pdf_located);
    expect(payStub?.not_located).toEqual(["pay_stub.net_pay"]);
    expect(payStub?.match_rate).toBe(1);
    // Annualized income follows from the extracted gross pay and pay frequency.
    expect(payStub?.derived).toMatchObject({ expected: 6_110_000, actual: 6_110_000, value_match: true });
  });

  it("appends a model.call event marked _fixture with the prompt as input and the recorded response as output", async () => {
    await enqueueExtraction(system, store.getApplication(APP)?.document_ids ?? []);
    const calls = audit.list(APP).flatMap((e) => (e.type === "model.call" ? [e] : []));
    expect(calls).toHaveLength(3);
    const fixture = loadFixture();
    for (const [i, slot] of SLOTS.entries()) {
      const call = calls[i];
      expect(call).toMatchObject({
        use_case: "extraction",
        _fixture: true,
        model_id: fixture.entries[slot]?.model_id,
        effort: "medium",
        stop_reason: "end_turn",
      });
      expect(call?.raw_output).toEqual(fixture.entries[slot]?.response);
      expect(call?.error_code).toBeUndefined();
      const input = call?.raw_input as {
        system: string;
        messages: Array<{ content: string }>;
        output_config: { effort: string; format: unknown };
      };
      expect(input.messages[0]?.content).toContain(`Expected document: ${schemaForSlot(slot).title}.`);
      expect(input.output_config.effort).toBe("medium");
      // The request that went out is the one the recorded response answered.
      expect(
        requestSha256({ system: input.system, user: input.messages[0]?.content ?? "", format: input.output_config.format }),
      ).toBe(fixture.entries[slot]?.request_sha256);
    }
    expect((calls[0]?.raw_input as { messages: Array<{ content: string }> }).messages[0]?.content).toContain(
      "p1 L07: Gross Pay | 2,350.00",
    );
    // The proposals carry the fixture's model call as their parent event.
    const proposed = audit.list(APP).filter((e) => e.type === "field.proposed");
    expect(proposed).toHaveLength(16);
    expect(new Set(proposed.map((e) => e.parent_event_id))).toEqual(new Set(calls.map((c) => c.event_id)));
  });

  it("replays one document on its own", async () => {
    const world = freshWorld({ slots: ["pay_stub"] });
    const outcome = await extractDocument(system, world.docs.pay_stub?.id ?? "");
    expect(outcome.extraction_status).toBe("done");
    expect(outcome.fields.map((f) => f.match_method)).toEqual(Object.values(EXPECTED_METHOD.pay_stub));
  });
});

describe("the review of the replayed documents (CUJ 4 and 5)", () => {
  it("shows the net pay as not located, and routes the income difference to the contractor", async () => {
    await enqueueExtraction(system, store.getApplication(APP)?.document_ids ?? []);
    const task = store.listReviewTasks(APP)[0];
    expect(task?.status).toBe("ready");
    const view = taskView(task?.id ?? "");
    const net = view.documents[0]?.rows.find((r) => r.field_id === "net_pay");
    expect(net).toMatchObject({ location: "not_located", error_code: "extraction.source_not_located", requires_acknowledgement: true });

    const pid = (key: string) => currentProposal(APP, key, "box")?.id ?? "";
    applyDecision(reviewer, task?.id ?? "", pid("pay_stub.gross_pay"), { action: "confirm" });
    expect(store.listDiscrepancies(APP)).toEqual([]);
    applyDecision(reviewer, task?.id ?? "", pid("pay_stub.pay_frequency"), { action: "confirm" });

    // $2,350.00 biweekly is $61,100.00 a year; the application states $85,000.00.
    const [record] = store.listDiscrepancies(APP);
    expect(record).toMatchObject({
      reason_code: "income_outside_tolerance",
      stated: { value: 8_500_000 },
      extracted: { value: 6_110_000 },
      status: "open",
    });
    expect(store.getApplication(APP)?.verified.verified_annual_income).toBe(6_110_000);
    expect(store.getApplication(APP)?.status).toBe("documents_under_review");
  });
});

// ---------------------------------------------------------------------------------------------
// The recorder
// ---------------------------------------------------------------------------------------------

// scripts/record-extraction-fixture.ts run for real against a stand-in model endpoint on this
// machine that answers with the committed responses: no key of the project is used and nothing
// leaves the machine. The child runs in an empty directory so no .env replaces the test key.

const RECORDER_KEY = "recorder-test-key-0000";

interface RecorderRun {
  code: number | null;
  output: string;
  requests: number;
}

async function runRecorder(out: string, workdir: string, args: string[]): Promise<RecorderRun> {
  const fixture = loadFixture();
  let requests = 0;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests += 1;
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: Array<{ content: string }> };
      const prompt = body.messages[0]?.content ?? "";
      const slot = SLOTS.find((s) => prompt.startsWith(`Expected document: ${schemaForSlot(s).title}.`));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(slot ? fixture.entries[slot]?.response : {}));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  try {
    const child = spawn(
      join(PROJECT_ROOT, "node_modules/.bin/tsx"),
      [
        "--tsconfig",
        join(PROJECT_ROOT, "tsconfig.json"),
        join(PROJECT_ROOT, "scripts/record-extraction-fixture.ts"),
        "--out",
        out,
        ...args,
      ],
      {
        cwd: workdir,
        env: { ...process.env, ANTHROPIC_API_KEY: RECORDER_KEY, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    return { code, output, requests };
  } finally {
    server.close();
  }
}

/** Every value and quote the recorded answers hold: what a log must not repeat. */
function documentValues(fixture: FixtureFile): string[] {
  const values = new Set<string>();
  for (const entry of Object.values(fixture.entries)) {
    const text = (entry.response.content as Array<{ type: string; text?: string }>).map((b) => b.text ?? "").join("");
    const answer = JSON.parse(text) as { fields: Record<string, { value: string; quoted_text: string } | null> };
    for (const selection of Object.values(answer.fields)) {
      if (selection) for (const v of [selection.value, selection.quoted_text]) if (v.length >= 4) values.add(v);
    }
  }
  return [...values];
}

describe("the recorder", () => {
  it("refuses to replace a recorded entry without --force, says what it would replace, and calls no model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recorder-"));
    try {
      const out = join(dir, "fixture.json");
      copyFileSync(FIXTURE_PATH, out);
      const run = await runRecorder(out, dir, []);

      expect(run.code).toBe(1);
      expect(run.requests).toBe(0);
      expect(readFileSync(out, "utf8")).toBe(readFileSync(FIXTURE_PATH, "utf8"));
      for (const slot of SLOTS) expect(run.output).toContain(`Would replace ${slot}: ${loadFixture().entries[slot]?.document}`);
      expect(run.output).toContain("--force");
      expect(run.output).not.toContain(RECORDER_KEY);

      // Only the slots asked for count: an empty output file has nothing to replace.
      const fresh = await runRecorder(join(dir, "other.json"), dir, ["--slots", "scope_letter"]);
      expect(fresh.code).toBe(0);
      expect(fresh.requests).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("replaces entries with --force, records the request hash the replay checks, and logs no document value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "recorder-"));
    try {
      const out = join(dir, "fixture.json");
      copyFileSync(FIXTURE_PATH, out);
      const run = await runRecorder(out, dir, ["--force"]);

      expect(run.code).toBe(0);
      expect(run.requests).toBe(3);
      for (const slot of SLOTS) expect(run.output).toContain(`Replacing ${slot}:`);

      const original = loadFixture();
      const recorded = loadFixture(out);
      const world = freshWorld();
      for (const slot of SLOTS) {
        const doc = world.docs[slot];
        if (!doc) throw new Error(`no ${slot} document`);
        const request = buildExtractionRequest(schemaForSlot(slot), await loadPositionedText(system, doc));
        expect(recorded.entries[slot]?.request_sha256).toBe(requestSha256(request));
        expect(recorded.entries[slot]?.request_sha256).toBe(original.entries[slot]?.request_sha256);
        expect(recorded.entries[slot]?.response).toEqual(original.entries[slot]?.response);
      }

      // Field ids, methods and scores are logged; the key and what the documents say are not.
      expect(run.output).toContain("pay_stub.net_pay");
      expect(run.output).toMatch(/field match 7\/7/);
      expect(run.output).not.toContain(RECORDER_KEY);
      for (const value of documentValues(original)) expect(run.output, `the log repeats ${value}`).not.toContain(value);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
