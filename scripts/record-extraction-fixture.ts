import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DOCUMENT_SLOTS, schemaForSlot } from "@shared/document-schemas/index";
import type { DocumentAdapter, DocumentSlot } from "@shared/schemas";
import { audit, createAuditLog, createMemorySink, installAuditLog, type Ctx } from "../server/audit-log.js";
import { attachDocument, setFieldValue, submitApplication } from "../server/commands.js";
import { config } from "../server/config.js";
import { AppError } from "../server/errors.js";
import { extractDocument, loadPositionedText } from "../server/extraction/extract.js";
import { FIXTURE_PATH, type FixtureEntry, type FixtureFile } from "../server/extraction/llm.js";
import { buildExtractionPrompt, buildExtractionRequest, requestSha256 } from "../server/extraction/prompt.js";
import { scoreDocument } from "../server/extraction/score.js";
import { loadEnvFile } from "../server/load-env.js";
import { store } from "../server/store.js";
import { getVersions } from "../server/versions.js";

// Records the extraction fixture (samples/extraction-fixture.json): one real model response per
// sample document, captured through the same code the server runs, never edited by hand. The
// replay (tests/fixture-replay.test.ts) answers from it when there is no key. Re-record whenever
// the extraction prompt, a document schema, the indexer or the model id changes; the replay test
// compares the recorded `request_sha256` to the request built today and fails until you do.
//
//   npx tsx scripts/record-extraction-fixture.ts [--slots pay_stub,estimate] [--out path] [--force]
//
// Slots that are not re-recorded keep their entry in the output file. An entry that already
// exists is replaced only with --force; without it the script says what it would replace and
// stops before any model call. The key is read from .env and is never printed, and neither is
// anything read from a document: the log holds field ids, match methods, scores and error codes.

const SAMPLES: Record<DocumentSlot, { file: string; adapter: DocumentAdapter }> = {
  pay_stub: { file: "samples/paystub.pdf", adapter: "ocr_fixture" },
  estimate: { file: "samples/estimate.pdf", adapter: "pdfjs" },
  scope_letter: { file: "samples/scope_letter.pdf", adapter: "pdfjs" },
};

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

const short = (hash: string): string => hash.slice(0, 12);

/** What an existing entry is, in words that carry no document content. */
function describeEntry(entry: Partial<FixtureEntry>, recordedAt: string): string {
  // An entry recorded before the request hash existed has none.
  const request = entry.request_sha256 === undefined ? "not recorded" : short(entry.request_sha256);
  return `${entry.document}, ${entry.model_id}, effort ${entry.effort}, prompt ${entry.system_prompt_version}, request ${request}, recorded ${recordedAt}`;
}

/** An error as the log may show it: the code of an `AppError`, otherwise the error's class. */
function describeError(err: unknown): string {
  if (err instanceof AppError) return err.code;
  return err instanceof Error ? err.name : "unknown error";
}

async function main(): Promise<number> {
  loadEnvFile();
  if (!config.hasLlmKey) {
    console.error("ANTHROPIC_API_KEY is not set (add it to .env).");
    return 1;
  }
  const slots = (flag("slots")?.split(",") ?? [...DOCUMENT_SLOTS]) as DocumentSlot[];
  const unknown = slots.filter((slot) => !(DOCUMENT_SLOTS as readonly string[]).includes(slot));
  if (unknown.length > 0) {
    console.error(`Unknown slot: ${unknown.join(", ")}. Slots are ${DOCUMENT_SLOTS.join(", ")}.`);
    return 1;
  }
  const out = flag("out") ?? FIXTURE_PATH;
  const force = process.argv.includes("--force");

  const previous: FixtureFile | undefined = existsSync(out)
    ? (JSON.parse(readFileSync(out, "utf8")) as FixtureFile)
    : undefined;
  const existing = slots.filter((slot) => previous?.entries[slot] !== undefined);
  if (existing.length > 0) {
    for (const slot of existing) {
      const entry = previous?.entries[slot];
      if (entry) console.log(`${force ? "Replacing" : "Would replace"} ${slot}: ${describeEntry(entry, previous?.recorded_at ?? "unknown")}`);
    }
    if (!force) {
      console.log(`\n${out} already holds ${existing.length === 1 ? "this entry" : "these entries"}. Nothing was recorded. Pass --force to replace ${existing.length === 1 ? "it" : "them"}.`);
      return 1;
    }
  }

  installAuditLog(createAuditLog(createMemorySink()));
  store.reset();
  store.loadSeed();
  const app = "app_demo_001";
  const contractor: Ctx = { application_id: app, session_id: "record", actor: { type: "contractor", id: "ctr_demo_001" } };
  const system: Ctx = { ...contractor, actor: { type: "system", id: "system" } };
  const values: Array<[string, string | number]> = [
    ["project_type", "roofing"],
    ["project_amount", 3_000_000],
    ["requested_loan_amount", 3_000_000],
    ["homeowner_first_name", "Maria"],
    ["homeowner_last_name", "Lopez"],
    ["property_zip", "95112"],
    ["stated_annual_income", 8_500_000],
  ];
  for (const [key, value] of values) setFieldValue(contractor, key, value);
  const documents = slots.map((slot) => ({
    slot,
    doc: attachDocument(contractor, slot, SAMPLES[slot].file, SAMPLES[slot].adapter).document,
  }));
  submitApplication(contractor);

  const entries: Record<string, FixtureEntry> = { ...(previous?.entries ?? {}) };
  let failed = false;
  let recorded = 0;

  for (const { slot, doc } of documents) {
    const before = audit.list(app).length;
    const outcome = await extractDocument(system, doc.id, { mode: "live" });
    const events = audit.list(app).slice(before);
    const call = events.filter((e) => e.type === "model.call").at(-1);
    console.log(`\n== ${slot}: extraction_status=${outcome.extraction_status}${outcome.error_code ? ` (${outcome.error_code})` : ""}`);
    if (outcome.extraction_status !== "done" || call?.type !== "model.call" || call.error_code) {
      failed = true;
      if (call?.type === "model.call") console.log(`   model call failed: ${call.error_code ?? "no error code"}`);
      continue;
    }

    // The hash is of the request that was sent, and it must be the one the replay builds today.
    const positioned = await loadPositionedText(system, store.getDocument(doc.id) ?? doc);
    const schema = schemaForSlot(slot);
    const sent = call.raw_input as {
      system: string;
      messages: Array<{ content: string }>;
      output_config: { format: unknown };
    };
    const sentHash = requestSha256({
      system: sent.system,
      user: sent.messages[0]?.content ?? "",
      format: sent.output_config.format,
    });
    if (sentHash !== requestSha256(buildExtractionRequest(schema, positioned))) {
      failed = true;
      console.log("   the request that was sent is not the one the replay builds; the entry was not written.");
      continue;
    }

    recorded += 1;
    entries[slot] = {
      document: SAMPLES[slot].file.split("/").pop() ?? SAMPLES[slot].file,
      model_id: call.model_id,
      effort: call.effort,
      system_prompt_version: getVersions().extraction_prompt,
      lines_sha256: buildExtractionPrompt(schema, positioned).lines_sha256,
      request_sha256: sentHash,
      latency_ms: call.latency_ms,
      usage: call.usage,
      stop_reason: call.stop_reason,
      response: call.raw_output as FixtureEntry["response"],
    };
    const score = scoreDocument(slot, store.listProposals(app).filter((p) => p.field_key.startsWith(`${slot}.`)));
    console.log(
      `   model=${call.model_id} latency=${call.latency_ms}ms tokens in/out=${call.usage.input}/${call.usage.output} stop=${call.stop_reason} request=${short(sentHash)}`,
    );
    for (const f of score.fields) {
      console.log(`   ${f.value_match ? "match   " : "MISMATCH"} ${f.field_key.padEnd(28)} ${String(f.method)}`);
    }
    console.log(
      `   field match ${score.matched}/${score.total} (${(score.match_rate * 100).toFixed(0)}%), located ${score.located}/${score.located_total} (${(score.located_rate * 100).toFixed(0)}%), not located: [${score.not_located.join(", ")}], not extracted: [${score.not_extracted.join(", ")}]`,
    );
    if (score.derived) console.log(`   annualized income: ${score.derived.value_match ? "match" : "MISMATCH"}`);
  }

  if (recorded > 0) {
    const file: FixtureFile = { version: 1, recorded_at: new Date().toISOString(), entries };
    writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
    console.log(`\nWrote ${out}`);
  } else {
    console.log("\nNothing written: no document finished.");
  }
  if (failed) console.log("At least one document did not finish; its entry was not written.");
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`Recording stopped: ${describeError(err)}`);
    process.exit(1);
  },
);
