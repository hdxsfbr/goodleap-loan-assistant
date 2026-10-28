import { readFileSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requiredFields } from "@shared/application-schema";
import type { DiscrepancyRaiseInput, DocumentSlot, ProposalSource } from "@shared/schemas";
import { createApiRouter, errorHandler } from "../server/api/index.js";
import {
  audit,
  createAuditLog,
  createMemorySink,
  installAuditLog,
  type Ctx,
  type MemorySink,
} from "../server/audit-log.js";
import {
  appendMessage,
  attachDocument,
  attachExplanation,
  completeReview,
  confirmValue,
  createReviewTask,
  editValue,
  proposeFieldValue,
  raiseDiscrepancy,
  rejectValue,
  replyToDiscrepancy,
  resolveDiscrepancy,
  sendDiscrepancyQuestion,
  setExtractionStatus,
  setFieldValue,
  startReview,
  storeOptions,
  submitApplication,
} from "../server/commands.js";
import { AppError, CommandError } from "../server/errors.js";
import { storeWriter, store } from "../server/store.js";

const APP = "app_demo_001";

const contractor: Ctx = {
  application_id: APP,
  session_id: "test-session",
  actor: { type: "contractor", id: "ctr_demo_001" },
};
const reviewer: Ctx = { ...contractor, actor: { type: "reviewer", id: "rev_demo_001" } };
const system: Ctx = { ...contractor, actor: { type: "system", id: "system" } };

const REQUIRED_VALUES: Record<string, string | number> = {
  project_type: "roofing",
  project_amount: 3_000_000,
  requested_loan_amount: 3_000_000,
  homeowner_first_name: "Dana",
  homeowner_last_name: "Reyes",
  property_zip: "94110",
  stated_annual_income: 8_500_000,
};

let sink: MemorySink;

beforeEach(() => {
  store.reset();
  store.loadSeed();
  sink = createMemorySink();
  installAuditLog(createAuditLog(sink));
});

function eventTypes(): string[] {
  return sink.lines.map((line) => JSON.parse(line).type as string);
}

/** The event types a block appends, in order. */
function appended(fn: () => unknown): string[] {
  const before = sink.lines.length;
  fn();
  return sink.lines.slice(before).map((line) => JSON.parse(line).type as string);
}

function fillRequired(): void {
  for (const [key, value] of Object.entries(REQUIRED_VALUES)) setFieldValue(contractor, key, value);
}

function messageSource(text = "The roof job is thirty thousand."): ProposalSource {
  const { message } = appendMessage(contractor, text);
  return { kind: "message", ref: { message_id: message.id } };
}

function boxSource(documentId: string, quotedText: string): ProposalSource {
  return {
    kind: "box",
    ref: {
      document_id: documentId,
      page: 1,
      bbox: { x: 0.1, y: 0.2, w: 0.2, h: 0.03 },
      words: [],
      quoted_text: quotedText,
    },
  };
}

function app() {
  const found = store.getApplication(APP);
  if (!found) throw new Error("seed application missing");
  return found;
}

/** Submits a complete application with three documents and opens its review task. */
function openReview() {
  fillRequired();
  const slots: DocumentSlot[] = ["pay_stub", "estimate", "scope_letter"];
  const docs = Object.fromEntries(
    slots.map((slot) => [slot, attachDocument(contractor, slot, `samples/${slot}.pdf`, "pdfjs").document]),
  ) as Record<DocumentSlot, ReturnType<typeof attachDocument>["document"]>;
  submitApplication(contractor);
  for (const doc of Object.values(docs)) setExtractionStatus(system, doc.id, "done");
  const { task } = createReviewTask(system, {
    document_ids: Object.values(docs).map((d) => d.id),
    jsm_issue_id: "JSM-1",
  });
  return { docs, task };
}

describe("setFieldValue", () => {
  it("stores a typed value on a draft and emits field.confirmed with source typed", () => {
    setFieldValue(contractor, "project_amount", 3_000_000);

    expect(app().fields.project_amount).toEqual({ value: 3_000_000, state: "typed", source_ref: null });
    const [event] = audit.list(APP);
    expect(event).toMatchObject({
      type: "field.confirmed",
      source: "typed",
      field_key: "project_amount",
      final_value: 3_000_000,
      proposal_id: null,
    });
  });

  it("rejects a value of the wrong type and a field that does not exist", () => {
    expect(() => setFieldValue(contractor, "project_amount", "lots")).toThrow(CommandError);
    expect(() => setFieldValue(contractor, "project_type", "boats")).toThrow(CommandError);
    expect(() => setFieldValue(contractor, "ssn", "123")).toThrow(CommandError);
    expect(sink.lines).toHaveLength(0);
  });

  it("refuses edits after submission", () => {
    fillRequired();
    submitApplication(contractor);
    expect(() => setFieldValue(contractor, "project_amount", 1_000_000)).toThrow(/submitted/);
  });
});

describe("proposeFieldValue", () => {
  it("never overwrites a typed value", () => {
    setFieldValue(contractor, "requested_loan_amount", 3_000_000);
    const result = proposeFieldValue(contractor, {
      field_key: "requested_loan_amount",
      value: 4_000_000,
      source: messageSource(),
    });

    expect(result.proposal?.state).toBe("proposed");
    expect(app().fields.requested_loan_amount).toEqual({
      value: 3_000_000,
      state: "typed",
      source_ref: null,
    });
  });

  it("drops a proposal equal to the typed value with dropped_reason equals_confirmed", () => {
    setFieldValue(contractor, "requested_loan_amount", 3_000_000);
    const result = proposeFieldValue(contractor, {
      field_key: "requested_loan_amount",
      value: 3_000_000,
      source: messageSource(),
    });

    expect(result.proposal).toBeNull();
    expect(result.dropped_reason).toBe("equals_confirmed");
    expect(store.listProposals(APP)).toHaveLength(0);
    const last = audit.list(APP).at(-1);
    expect(last).toMatchObject({
      type: "field.proposed",
      proposal_id: null,
      dropped_reason: "equals_confirmed",
    });
  });

  it("supersedes a prior proposed proposal for the same field and source kind", () => {
    const first = proposeFieldValue(contractor, {
      field_key: "requested_loan_amount",
      value: 3_000_000,
      source: messageSource("Thirty thousand."),
    });
    const second = proposeFieldValue(contractor, {
      field_key: "requested_loan_amount",
      value: 4_000_000,
      source: messageSource("Actually forty."),
    });

    expect(second.superseded).toEqual([first.proposal?.id]);
    expect(store.getProposal(first.proposal?.id ?? "")?.state).toBe("superseded");
    expect(store.getProposal(second.proposal?.id ?? "")?.state).toBe("proposed");
    expect(store.listProposals(APP, { state: "proposed" })).toHaveLength(1);
  });

  it("drops a message proposal for a field the copilot may not fill", () => {
    const result = proposeFieldValue(contractor, {
      field_key: "stated_annual_income",
      value: 9_000_000,
      source: messageSource(),
    });
    expect(result.dropped_reason).toBe("field_not_fillable");
    expect(store.listProposals(APP)).toHaveLength(0);
  });

  it("rejects a proposal that points at a message that does not exist", () => {
    expect(() =>
      proposeFieldValue(contractor, {
        field_key: "project_type",
        value: "roofing",
        source: { kind: "message", ref: { message_id: "m_999" } },
      }),
    ).toThrow(CommandError);
  });
});

describe("confirmValue", () => {
  it("throws when no live proposal exists", () => {
    expect(() => confirmValue(contractor, "p_404", {})).toThrow(CommandError);

    const proposed = proposeFieldValue(contractor, {
      field_key: "project_type",
      value: "roofing",
      source: messageSource(),
    });
    const id = proposed.proposal?.id ?? "";
    confirmValue(contractor, id, {});
    expect(() => confirmValue(contractor, id, {})).toThrow(CommandError);
  });

  it("writes a contractor-side confirmation to the application as confirmed", () => {
    const source = messageSource();
    const proposed = proposeFieldValue(contractor, { field_key: "project_type", value: "roofing", source });
    confirmValue(contractor, proposed.proposal?.id ?? "", {});

    expect(app().fields.project_type).toEqual({ value: "roofing", state: "confirmed", source_ref: source });
  });

  it("throws on a not-located proposal without the acknowledgement", () => {
    const { docs, task } = openReview();
    const proposal = proposeFieldValue(system, {
      field_key: "pay_stub.net_pay",
      value: 300_000,
      source: boxSource(docs.pay_stub.id, "3,000.00"),
      match: { method: "not_located" },
    }).proposal;

    expect(() =>
      confirmValue(reviewer, proposal?.id ?? "", { review_task_id: task.id }),
    ).toThrow(/located/);
    confirmValue(reviewer, proposal?.id ?? "", { review_task_id: task.id, located_by_reviewer: true });
    expect(store.getProposal(proposal?.id ?? "")).toMatchObject({
      state: "confirmed",
      located_by_reviewer: true,
    });
  });

  it("writes nothing to the application when a reviewer confirms estimate.total_amount", () => {
    const { docs, task } = openReview();
    const before = app();
    const proposal = proposeFieldValue(system, {
      field_key: "estimate.total_amount",
      value: 3_100_000,
      source: boxSource(docs.estimate.id, "$31,000.00"),
      match: { method: "exact" },
    }).proposal;

    confirmValue(reviewer, proposal?.id ?? "", { review_task_id: task.id });

    expect(app().fields).toEqual(before.fields);
    expect(app().verified).toEqual(before.verified);
    expect(store.getProposal(proposal?.id ?? "")?.state).toBe("confirmed");
  });

  it("writes only `verified` when the system confirms pay_stub.annualized_income", () => {
    const { docs, task } = openReview();
    const before = app();
    const gross = proposeFieldValue(system, {
      field_key: "pay_stub.gross_pay",
      value: 235_000,
      source: boxSource(docs.pay_stub.id, "2,350.00"),
      match: { method: "exact" },
    }).proposal;
    const formula = proposeFieldValue(system, {
      field_key: "pay_stub.annualized_income",
      value: 6_110_000,
      source: { kind: "formula", ref: { formula: "annualized_income", inputs: [gross?.id ?? ""] } },
    }).proposal;

    confirmValue(system, formula?.id ?? "", { review_task_id: task.id });

    expect(app().verified).toEqual({
      verified_annual_income: 6_110_000,
      verification_source: "document_review",
    });
    expect(app().fields).toEqual(before.fields);
  });

  it("rejects a contractor-side confirmation of a document value", () => {
    const { docs } = openReview();
    const proposal = proposeFieldValue(system, {
      field_key: "estimate.total_amount",
      value: 3_100_000,
      source: boxSource(docs.estimate.id, "$31,000.00"),
    }).proposal;
    expect(() => confirmValue(contractor, proposal?.id ?? "", {})).toThrow(CommandError);
  });
});

describe("editValue and rejectValue", () => {
  it("edits a proposed field: before and after are logged and the application gets state edited", () => {
    const proposal = proposeFieldValue(contractor, {
      field_key: "requested_loan_amount",
      value: 3_000_000,
      source: messageSource(),
    }).proposal;

    editValue(contractor, proposal?.id ?? "", 2_800_000);

    expect(app().fields.requested_loan_amount).toMatchObject({ value: 2_800_000, state: "edited" });
    expect(audit.list(APP).at(-1)).toMatchObject({
      type: "field.edited",
      before: 3_000_000,
      after: 2_800_000,
    });
    expect(() => editValue(contractor, proposal?.id ?? "", 2_500_000)).toThrow(CommandError);
  });

  it("dismisses a proposal without touching the application", () => {
    const proposal = proposeFieldValue(contractor, {
      field_key: "project_type",
      value: "solar",
      source: messageSource(),
    }).proposal;
    rejectValue(contractor, proposal?.id ?? "", "dismissed_by_contractor");

    expect(store.getProposal(proposal?.id ?? "")).toMatchObject({
      state: "rejected",
      reason_code: "dismissed_by_contractor",
    });
    expect(app().fields).toEqual({});
  });

  it("refuses to edit a calculated value and a reviewer reason from a contractor", () => {
    const { docs, task } = openReview();
    const gross = proposeFieldValue(system, {
      field_key: "pay_stub.gross_pay",
      value: 235_000,
      source: boxSource(docs.pay_stub.id, "2,350.00"),
    }).proposal;
    const formula = proposeFieldValue(system, {
      field_key: "pay_stub.annualized_income",
      value: 6_110_000,
      source: { kind: "formula", ref: { formula: "annualized_income", inputs: [gross?.id ?? ""] } },
    }).proposal;

    expect(() => editValue(reviewer, formula?.id ?? "", 1, { review_task_id: task.id })).toThrow(
      /calculated/,
    );
    expect(() => rejectValue(reviewer, gross?.id ?? "", "dismissed_by_contractor", { review_task_id: task.id })).toThrow(
      CommandError,
    );
    rejectValue(reviewer, gross?.id ?? "", "illegible", { review_task_id: task.id, note: "blurred" });
    expect(store.getProposal(gross?.id ?? "")?.state).toBe("rejected");
  });
});

describe("submitApplication", () => {
  it("throws with the pending count while a proposal is proposed", () => {
    fillRequired();
    proposeFieldValue(contractor, { field_key: "project_description", value: "Tear-off", source: messageSource() });
    proposeFieldValue(contractor, { field_key: "preferred_term_months", value: "120", source: messageSource() });

    let error: unknown;
    try {
      submitApplication(contractor);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).details).toEqual({ pending_count: 2 });
    expect((error as CommandError).message).toContain("2 suggestions");
    expect(app().status).toBe("draft");
  });

  it("throws naming the empty required field", () => {
    for (const [key, value] of Object.entries(REQUIRED_VALUES)) {
      if (key !== "property_zip") setFieldValue(contractor, key, value);
    }

    let error: unknown;
    try {
      submitApplication(contractor);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).message).toContain("Property ZIP code");
    expect((error as CommandError).details).toEqual({ field_keys: ["property_zip"] });
  });

  it("sets documents_under_review, returns the attached document ids and calls no service", () => {
    fillRequired();
    const { document } = attachDocument(contractor, "estimate", "samples/estimate.pdf", "pdfjs");

    const ids = submitApplication(contractor);

    expect(ids).toEqual([document.id]);
    expect(app().status).toBe("documents_under_review");
    expect(audit.countToolCalls(APP, "credit_engine")).toBe(0);
    expect(audit.list(APP).some((e) => e.type === "tool.call")).toBe(false);
  });

  it("requires every field the schema marks required", () => {
    expect(Object.keys(REQUIRED_VALUES).sort()).toEqual(requiredFields().map((f) => f.id).sort());
  });
});

describe("completeReview", () => {
  it("throws while a proposal of the task is still proposed", () => {
    const { docs, task } = openReview();
    const proposal = proposeFieldValue(system, {
      field_key: "estimate.total_amount",
      value: 3_100_000,
      source: boxSource(docs.estimate.id, "$31,000.00"),
    }).proposal;

    expect(() => completeReview(reviewer, task.id)).toThrow(/needs a decision/);

    confirmValue(reviewer, proposal?.id ?? "", { review_task_id: task.id });
    completeReview(reviewer, task.id);
    expect(store.getReviewTask(task.id)?.status).toBe("complete");
    expect(app().status).toBe("documents_reviewed");
  });

  it("opens an extraction_failed task when every document failed", () => {
    fillRequired();
    const docs = (["pay_stub", "estimate"] as const).map(
      (slot) => attachDocument(contractor, slot, `samples/${slot}.pdf`, "pdfjs").document,
    );
    submitApplication(contractor);
    for (const doc of docs) setExtractionStatus(system, doc.id, "failed", { error_code: "llm.timeout" });

    const { task } = createReviewTask(system, { document_ids: docs.map((d) => d.id), jsm_issue_id: "JSM-2" });
    expect(task.status).toBe("extraction_failed");
    completeReview(reviewer, task.id);
    expect(app().status).toBe("documents_reviewed");
  });
});

describe("audit events per command", () => {
  it("appends its primary event, plus one state change when the status changes, and nothing else", () => {
    const log: Array<[string, string[]]> = [];
    const step = (name: string, fn: () => unknown) => log.push([name, appended(fn)]);

    fillRequired();
    let messageId = "";
    step("appendMessage", () => {
      messageId = appendMessage(contractor, "Thirty thousand for the roof.").message.id;
    });
    let proposalId = "";
    step("proposeFieldValue", () => {
      proposalId =
        proposeFieldValue(contractor, {
          field_key: "project_description",
          value: "Roof tear-off",
          source: { kind: "message", ref: { message_id: messageId } },
        }).proposal?.id ?? "";
    });
    step("editValue", () => editValue(contractor, proposalId, "Roof replacement"));
    let rejectId = "";
    step("proposeFieldValue (second)", () => {
      rejectId =
        proposeFieldValue(contractor, {
          field_key: "preferred_term_months",
          value: "120",
          source: { kind: "message", ref: { message_id: messageId } },
        }).proposal?.id ?? "";
    });
    step("rejectValue", () => rejectValue(contractor, rejectId, "dismissed_by_contractor"));
    let confirmId = "";
    proposeFieldValue(contractor, {
      field_key: "selected_product_id",
      value: "fixed_10y",
      source: { kind: "message", ref: { message_id: messageId } },
    });
    confirmId = store.listProposals(APP, { state: "proposed" })[0]?.id ?? "";
    step("confirmValue", () => confirmValue(contractor, confirmId, {}));
    step("setFieldValue", () => setFieldValue(contractor, "employer_name", "Acme"));

    let optionsId = "";
    step("storeOptions", () => {
      optionsId = storeOptions(contractor, {
        calculator_output: { amount_cents: 3_000_000, term_months: null, options: [] },
        inputs_source: { amount: "form", term: "catalog" },
      }).options.options_id;
    });
    step("attachExplanation", () => attachExplanation(contractor, optionsId, "Option A costs less per month."));

    const attached: string[] = [];
    step("attachDocument", () => {
      attached.push(attachDocument(contractor, "estimate", "samples/estimate.pdf", "pdfjs").document.id);
      attached.push(attachDocument(contractor, "pay_stub", "samples/paystub.pdf", "ocr_fixture").document.id);
    });
    step("submitApplication", () => submitApplication(contractor));
    step("setExtractionStatus", () => {
      for (const id of attached) setExtractionStatus(system, id, "done");
    });
    let taskId = "";
    step("createReviewTask", () => {
      taskId = createReviewTask(system, { document_ids: attached, jsm_issue_id: "JSM-9" }).task.id;
    });
    step("startReview", () => startReview(reviewer, taskId));

    // The discrepancy points at real values: the form's stated income and the pay stub's
    // annualized income, which the system confirms from a gross pay the reviewer confirmed.
    const gross = proposeFieldValue(system, {
      field_key: "pay_stub.gross_pay",
      value: 235_000,
      source: boxSource(attached[1] ?? "", "2,350.00"),
      match: { method: "exact" },
    }).proposal;
    confirmValue(reviewer, gross?.id ?? "", { review_task_id: taskId });
    const annualized = proposeFieldValue(system, {
      field_key: "pay_stub.annualized_income",
      value: 6_110_000,
      source: { kind: "formula", ref: { formula: "annualized_income", inputs: [gross?.id ?? ""] } },
    }).proposal;
    confirmValue(system, annualized?.id ?? "", { review_task_id: taskId });

    const raise: DiscrepancyRaiseInput = {
      field_key: "pay_stub.annualized_income",
      stated: { value: 8_500_000, pointer: { kind: "form", field_key: "stated_annual_income" } },
      extracted: { value: 6_110_000, proposal_id: annualized?.id ?? "" },
      rule_id: "income_within_10_percent_or_5000",
      tolerance_version: "schemas@absent",
      difference: { absolute: 2_390_000, percent: 28.1 },
      reason_code: "income_outside_tolerance",
      question: { template_id: "income_outside_tolerance", text: "Could you ask the homeowner?" },
      review_task_id: taskId,
    };
    let recordId = "";
    step("raiseDiscrepancy", () => {
      recordId = raiseDiscrepancy(reviewer, raise).record.id;
    });
    step("sendDiscrepancyQuestion", () => sendDiscrepancyQuestion(reviewer, recordId, "Is there other income?"));
    step("replyToDiscrepancy", () => replyToDiscrepancy(contractor, recordId, "A second job."));
    step("resolveDiscrepancy", () =>
      resolveDiscrepancy(reviewer, recordId, { resolution: "explained", note: "Second job." }),
    );
    step("completeReview", () => completeReview(reviewer, taskId));

    expect(Object.fromEntries(log)).toMatchObject({
      appendMessage: ["message.received"],
      proposeFieldValue: ["field.proposed"],
      editValue: ["field.edited"],
      "proposeFieldValue (second)": ["field.proposed"],
      rejectValue: ["field.rejected"],
      confirmValue: ["field.confirmed"],
      setFieldValue: ["field.confirmed"],
      storeOptions: ["options.stored"],
      attachExplanation: ["options.explained"],
      attachDocument: ["document.attached", "document.attached"],
      submitApplication: ["application.submitted", "application.state_changed"],
      setExtractionStatus: ["extraction.completed", "extraction.completed"],
      createReviewTask: ["review.task_created"],
      startReview: ["review.started"],
      raiseDiscrepancy: ["discrepancy.raised"],
      sendDiscrepancyQuestion: ["discrepancy.sent"],
      replyToDiscrepancy: ["discrepancy.replied"],
      resolveDiscrepancy: ["discrepancy.resolved"],
      completeReview: ["review.completed", "application.state_changed"],
    });

    const changes = audit.list(APP).filter((e) => e.type === "application.state_changed");
    expect(changes.map((e) => e.type === "application.state_changed" && [e.from, e.to])).toEqual([
      ["draft", "documents_under_review"],
      ["documents_under_review", "documents_reviewed"],
    ]);
    // every appended event is also one validated JSON line in the sink, in sequence order
    expect(eventTypes()).toHaveLength(audit.list(APP).length);
    expect(audit.list(APP).map((e) => e.seq)).toEqual([...Array(sink.lines.length).keys()].map((i) => i + 1));
  });

  it("appends nothing when a command throws", () => {
    expect(appended(() => expect(() => confirmValue(contractor, "p_404", {})).toThrow())).toEqual([]);
    expect(appended(() => expect(() => submitApplication(contractor)).toThrow())).toEqual([]);
    expect(app().status).toBe("draft");
  });
});

describe("the store is written only by commands", () => {
  it("reaches the mutable maps through storeWriter() from server/commands.ts and server/store.ts only", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith(".ts") && readFileSync(path, "utf8").includes("storeWriter")) {
          offenders.push(path);
        }
      }
    };
    walk(join(import.meta.dirname, "..", "server"));
    expect(offenders.map((p) => p.split("/server/")[1]).sort()).toEqual(["commands.ts", "store.ts"]);
  });
});

describe("error mapping in a route", () => {
  async function serve(configure: (app: express.Express) => void, run: (base: string) => Promise<void>) {
    const server = express();
    configure(server);
    server.use(errorHandler);
    const listener = server.listen(0);
    await new Promise<void>((resolve) => listener.once("listening", () => resolve()));
    const { port } = listener.address() as AddressInfo;
    try {
      await run(`http://127.0.0.1:${port}`);
    } finally {
      listener.close();
    }
  }

  it("maps a thrown non-AppError to internal with a generic message", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await serve(
      (server) => {
        server.get("/boom", () => {
          throw new Error("database password is hunter2");
        });
        server.get("/boom-async", async () => {
          throw new TypeError("undefined is not a function");
        });
      },
      async (base) => {
        for (const path of ["/boom", "/boom-async"]) {
          const response = await fetch(`${base}${path}`);
          const body = await response.json();
          expect(response.status).toBe(500);
          expect(body).toEqual({
            code: "internal",
            message: "Something went wrong on our side. Please try again.",
            retryable: false,
          });
        }
      },
    );
    consoleError.mockRestore();
  });

  it("keeps the code, message and retry flag of an AppError and the message of a CommandError", async () => {
    await serve(
      (server) => {
        server.get("/limited", () => {
          throw new AppError("llm.rate_limited");
        });
        server.get("/rule", () => {
          throw new CommandError("Fill in the required field before submitting: Property ZIP code.");
        });
      },
      async (base) => {
        const limited = await fetch(`${base}/limited`);
        expect(limited.status).toBe(429);
        expect(await limited.json()).toMatchObject({ code: "llm.rate_limited", retryable: true });

        const rule = await fetch(`${base}/rule`);
        expect(rule.status).toBe(409);
        expect(await rule.json()).toEqual({
          code: "internal",
          message: "Fill in the required field before submitting: Property ZIP code.",
          retryable: false,
        });
      },
    );
  });

  it("maps a command failure behind the real router to a 409 with the specific message", async () => {
    await serve(
      (server) => {
        server.use(createApiRouter());
      },
      async (base) => {
        const response = await fetch(`${base}/api/applications/${APP}/submit`, { method: "POST" });
        expect(response.status).toBe(409);
        const body = (await response.json()) as { code: string; message: string };
        expect(body.code).toBe("internal");
        expect(body.message).toContain("Fill in the required fields");
      },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Fix pass, wave 1
// ---------------------------------------------------------------------------------------------

/** A submitted application with a pay stub and an estimate attached and not yet extracted. */
function submitWithTwoDocuments() {
  fillRequired();
  const payStub = attachDocument(contractor, "pay_stub", "samples/paystub.pdf", "ocr_fixture").document;
  const estimate = attachDocument(contractor, "estimate", "samples/estimate.pdf", "pdfjs").document;
  submitApplication(contractor);
  return { payStub, estimate };
}

function proposedEvents() {
  return audit.list(APP).filter((e) => e.type === "field.proposed");
}

describe("createReviewTask readiness", () => {
  it("rejects a call that names only some of the attached documents", () => {
    const { payStub } = submitWithTwoDocuments();
    setExtractionStatus(system, payStub.id, "done");

    expect(() =>
      createReviewTask(system, { document_ids: [payStub.id], jsm_issue_id: "JSM-1" }),
    ).toThrow(/every document attached/);
    expect(store.listReviewTasks(APP)).toEqual([]);
    expect(audit.list(APP).some((e) => e.type === "review.task_created")).toBe(false);
  });

  it("applies the pending check to every attached document, not only the named ones", () => {
    const { payStub, estimate } = submitWithTwoDocuments();
    setExtractionStatus(system, payStub.id, "done");

    // naming just the finished document would have skipped the pending one
    expect(() =>
      createReviewTask(system, { document_ids: [payStub.id], jsm_issue_id: "JSM-1" }),
    ).toThrow(CommandError);
    expect(() =>
      createReviewTask(system, { document_ids: [payStub.id, estimate.id], jsm_issue_id: "JSM-1" }),
    ).toThrow(/every document has been read/);
  });

  it("applies the all-failed rule to every attached document", () => {
    const { payStub, estimate } = submitWithTwoDocuments();
    setExtractionStatus(system, payStub.id, "failed", { error_code: "llm.timeout" });
    setExtractionStatus(system, estimate.id, "done");

    expect(() =>
      createReviewTask(system, { document_ids: [payStub.id], jsm_issue_id: "JSM-1" }),
    ).toThrow(CommandError);
    const { task } = createReviewTask(system, {
      document_ids: [payStub.id, estimate.id],
      jsm_issue_id: "JSM-1",
    });
    expect(task.status).toBe("ready");
  });

  it("deduplicates the named documents before comparing and storing them", () => {
    const { payStub, estimate } = submitWithTwoDocuments();
    setExtractionStatus(system, payStub.id, "done");
    setExtractionStatus(system, estimate.id, "done");

    expect(() =>
      createReviewTask(system, { document_ids: [payStub.id, payStub.id], jsm_issue_id: "JSM-1" }),
    ).toThrow(CommandError);
    const { task } = createReviewTask(system, {
      document_ids: [payStub.id, estimate.id, payStub.id],
      jsm_issue_id: "JSM-1",
    });
    expect(task.document_ids).toEqual([payStub.id, estimate.id]);
    const created = audit.list(APP).find((e) => e.type === "review.task_created");
    expect(created).toMatchObject({ document_ids: [payStub.id, estimate.id] });
  });
});

describe("proposal key and source domains", () => {
  it("rejects an application field key with a box source", () => {
    const { docs } = openReview();
    expect(() =>
      proposeFieldValue(system, {
        field_key: "project_description",
        value: "Tear-off",
        source: boxSource(docs.estimate.id, "Tear-off"),
      }),
    ).toThrow(/not a document field/);
    expect(proposedEvents()).toEqual([]);
    expect(store.listProposals(APP)).toEqual([]);
  });

  it("rejects an application field key with a formula source", () => {
    const { docs } = openReview();
    const gross = proposeFieldValue(system, {
      field_key: "pay_stub.gross_pay",
      value: 235_000,
      source: boxSource(docs.pay_stub.id, "2,350.00"),
    }).proposal;
    expect(() =>
      proposeFieldValue(system, {
        field_key: "stated_annual_income",
        value: 6_110_000,
        source: { kind: "formula", ref: { formula: "annualized_income", inputs: [gross?.id ?? ""] } },
      }),
    ).toThrow(/not a document field/);
    expect(store.listProposals(APP)).toHaveLength(1);
  });

  it("rejects a slot-qualified key with a message source", () => {
    expect(() =>
      proposeFieldValue(contractor, {
        field_key: "pay_stub.net_pay",
        value: 300_000,
        source: messageSource(),
      }),
    ).toThrow(/chat message/);
    expect(proposedEvents()).toEqual([]);
  });

  it("rejects a key whose prefix is not a document slot, or whose field id is empty", () => {
    const { docs } = openReview();
    for (const field_key of ["payslip.gross_pay", "pay_stub.", ".gross_pay"]) {
      expect(() =>
        proposeFieldValue(system, {
          field_key,
          value: 1,
          source: boxSource(docs.pay_stub.id, "1"),
        }),
      ).toThrow(CommandError);
    }
    expect(store.listProposals(APP)).toEqual([]);
  });

  it("rejects a box proposal whose slot differs from the referenced document's slot", () => {
    const { docs } = openReview();
    expect(() =>
      proposeFieldValue(system, {
        field_key: "estimate.total_amount",
        value: 3_100_000,
        source: boxSource(docs.pay_stub.id, "$31,000.00"),
      }),
    ).toThrow(/does not belong to the document/);
    expect(store.listProposals(APP)).toEqual([]);
  });

  it("rejects a formula proposal whose slot differs from the proposal it derives from", () => {
    const { docs } = openReview();
    const gross = proposeFieldValue(system, {
      field_key: "pay_stub.gross_pay",
      value: 235_000,
      source: boxSource(docs.pay_stub.id, "2,350.00"),
    }).proposal;
    expect(() =>
      proposeFieldValue(system, {
        field_key: "estimate.total_amount",
        value: 6_110_000,
        source: { kind: "formula", ref: { formula: "annualized_income", inputs: [gross?.id ?? ""] } },
      }),
    ).toThrow(/different document/);
    expect(() =>
      proposeFieldValue(system, {
        field_key: "pay_stub.annualized_income",
        value: 6_110_000,
        source: { kind: "formula", ref: { formula: "annualized_income", inputs: [] } },
      }),
    ).toThrow(/at least one input/);
    expect(store.listProposals(APP)).toHaveLength(1);
  });

  it("accepts a document key in the slot of its box document and of its formula inputs", () => {
    const { docs } = openReview();
    const gross = proposeFieldValue(system, {
      field_key: "pay_stub.gross_pay",
      value: 235_000,
      source: boxSource(docs.pay_stub.id, "2,350.00"),
    }).proposal;
    const annualized = proposeFieldValue(system, {
      field_key: "pay_stub.annualized_income",
      value: 6_110_000,
      source: { kind: "formula", ref: { formula: "annualized_income", inputs: [gross?.id ?? ""] } },
    }).proposal;
    expect(gross?.state).toBe("proposed");
    expect(annualized?.state).toBe("proposed");
  });
});

describe("document proposal lifecycle", () => {
  it("rejects box and formula proposals before the application is submitted", () => {
    const { document } = attachDocument(contractor, "pay_stub", "samples/paystub.pdf", "pdfjs");
    expect(() =>
      proposeFieldValue(system, {
        field_key: "pay_stub.gross_pay",
        value: 235_000,
        source: boxSource(document.id, "2,350.00"),
      }),
    ).toThrow(/before the application is submitted/);
    expect(store.listProposals(APP)).toEqual([]);
  });

  it("rejects box and formula proposals once the documents are reviewed", () => {
    const { docs, task } = openReview();
    const gross = proposeFieldValue(system, {
      field_key: "pay_stub.gross_pay",
      value: 235_000,
      source: boxSource(docs.pay_stub.id, "2,350.00"),
    }).proposal;
    confirmValue(reviewer, gross?.id ?? "", { review_task_id: task.id });
    completeReview(reviewer, task.id);
    expect(app().status).toBe("documents_reviewed");
    const before = proposedEvents().length;

    expect(() =>
      proposeFieldValue(system, {
        field_key: "estimate.total_amount",
        value: 3_100_000,
        source: boxSource(docs.estimate.id, "$31,000.00"),
      }),
    ).toThrow(/after the review is complete/);
    expect(() =>
      proposeFieldValue(system, {
        field_key: "pay_stub.annualized_income",
        value: 6_110_000,
        source: { kind: "formula", ref: { formula: "annualized_income", inputs: [gross?.id ?? ""] } },
      }),
    ).toThrow(/after the review is complete/);
    expect(proposedEvents()).toHaveLength(before);
    expect(store.listProposals(APP, { state: "proposed" })).toEqual([]);
  });
});

describe("dropped proposals", () => {
  it("never record a source that does not exist", () => {
    setFieldValue(contractor, "requested_loan_amount", 3_000_000);
    const nowhere: ProposalSource = { kind: "message", ref: { message_id: "m_999" } };

    // would be dropped as equals_confirmed
    expect(() =>
      proposeFieldValue(contractor, { field_key: "requested_loan_amount", value: 3_000_000, source: nowhere }),
    ).toThrow(/message that does not exist/);
    // would be dropped as field_not_fillable
    expect(() =>
      proposeFieldValue(contractor, { field_key: "stated_annual_income", value: 9_000_000, source: nowhere }),
    ).toThrow(/message that does not exist/);
    expect(() =>
      proposeFieldValue(contractor, { field_key: "not_a_field", value: "x", source: nowhere }),
    ).toThrow(/message that does not exist/);
    expect(proposedEvents()).toEqual([]);
  });

  it("still drop and log when the source is real", () => {
    setFieldValue(contractor, "requested_loan_amount", 3_000_000);
    const source = messageSource();
    expect(
      proposeFieldValue(contractor, { field_key: "requested_loan_amount", value: 3_000_000, source })
        .dropped_reason,
    ).toBe("equals_confirmed");
    expect(
      proposeFieldValue(contractor, { field_key: "stated_annual_income", value: 9_000_000, source })
        .dropped_reason,
    ).toBe("field_not_fillable");
    expect(proposedEvents()).toHaveLength(2);
  });
});

describe("verified income", () => {
  function annualizedProposal(value: number) {
    const { docs, task } = openReview();
    const gross = proposeFieldValue(system, {
      field_key: "pay_stub.gross_pay",
      value: 235_000,
      source: boxSource(docs.pay_stub.id, "2,350.00"),
    }).proposal;
    const formula = proposeFieldValue(system, {
      field_key: "pay_stub.annualized_income",
      value,
      source: { kind: "formula", ref: { formula: "annualized_income", inputs: [gross?.id ?? ""] } },
    }).proposal;
    return { formula, task };
  }

  it("refuses to store a fractional or negative annual income and emits no confirmation", () => {
    for (const bad of [6_110_000.5, -1]) {
      store.reset();
      store.loadSeed();
      installAuditLog(createAuditLog((sink = createMemorySink())));
      const { formula, task } = annualizedProposal(bad);

      expect(() => confirmValue(system, formula?.id ?? "", { review_task_id: task.id })).toThrow(
        /whole number of cents/,
      );
      expect(audit.list(APP).some((e) => e.type === "field.confirmed" && e.source === "proposal")).toBe(false);
      expect(store.getProposal(formula?.id ?? "")?.state).toBe("proposed");
      expect(app().verified).toEqual({ verified_annual_income: null, verification_source: null });
    }
  });

  it("stores a whole, non-negative amount", () => {
    const { formula, task } = annualizedProposal(0);
    confirmValue(system, formula?.id ?? "", { review_task_id: task.id });
    expect(app().verified).toEqual({ verified_annual_income: 0, verification_source: "document_review" });
  });
});

describe("raiseDiscrepancy pointers", () => {
  /** An open review with a confirmed pay stub value to point at, and a record input to adjust. */
  function raiseInput(overrides: Partial<DiscrepancyRaiseInput> = {}) {
    const { docs, task } = openReview();
    const extracted = proposeFieldValue(system, {
      field_key: "pay_stub.gross_pay",
      value: 235_000,
      source: boxSource(docs.pay_stub.id, "2,350.00"),
    }).proposal;
    const input: DiscrepancyRaiseInput = {
      field_key: "pay_stub.annualized_income",
      stated: { value: 8_500_000, pointer: { kind: "form", field_key: "stated_annual_income" } },
      extracted: { value: 6_110_000, proposal_id: extracted?.id ?? "" },
      rule_id: "income_within_10_percent_or_5000",
      tolerance_version: "schemas@absent",
      difference: { absolute: 2_390_000, percent: 28.1 },
      reason_code: "income_outside_tolerance",
      question: { template_id: "income_outside_tolerance", text: "Could you ask the homeowner?" },
      review_task_id: task.id,
      ...overrides,
    };
    return { input, docs, task, extracted };
  }

  /** A proposal of another application, put in the store directly because the seed has one application. */
  function foreignProposal(state: "proposed" | "confirmed") {
    const mine = store.listProposals(APP)[0];
    if (!mine) throw new Error("expected a proposal to copy");
    const foreign = { ...mine, id: "p_foreign", application_id: "app_other", state };
    storeWriter().proposals.set(foreign.id, foreign);
    return foreign.id;
  }

  it("accepts pointers that resolve inside the application", () => {
    const { input } = raiseInput();
    expect(raiseDiscrepancy(reviewer, input).record.status).toBe("open");
  });

  it("rejects an extracted value that does not exist or belongs to another application", () => {
    const { input } = raiseInput();
    const before = audit.list(APP).length;
    expect(() =>
      raiseDiscrepancy(reviewer, { ...input, extracted: { value: 1, proposal_id: "p_404" } }),
    ).toThrow(/extracted value was not found/);
    expect(() =>
      raiseDiscrepancy(reviewer, { ...input, extracted: { value: 1, proposal_id: foreignProposal("proposed") } }),
    ).toThrow(/extracted value was not found/);
    expect(audit.list(APP)).toHaveLength(before);
    expect(store.listDiscrepancies(APP)).toEqual([]);
  });

  it("rejects a stated form value the application does not hold", () => {
    const { input } = raiseInput();
    expect(() =>
      raiseDiscrepancy(reviewer, {
        ...input,
        stated: { value: 1, pointer: { kind: "form", field_key: "employer_name" } },
      }),
    ).toThrow(/stated value was not found/);
    expect(() =>
      raiseDiscrepancy(reviewer, {
        ...input,
        stated: { value: 1, pointer: { kind: "form", field_key: "not_a_field" } },
      }),
    ).toThrow(/stated value was not found/);
  });

  it("requires a stated proposal pointer to be in this application and confirmed", () => {
    const { input, extracted } = raiseInput();
    const stated = (proposal_id: string) => ({
      ...input,
      stated: { value: 1, pointer: { kind: "proposal" as const, proposal_id } },
    });

    expect(() => raiseDiscrepancy(reviewer, stated("p_404"))).toThrow(/stated value was not found/);
    expect(() => raiseDiscrepancy(reviewer, stated(foreignProposal("confirmed")))).toThrow(
      /stated value was not found/,
    );
    expect(() => raiseDiscrepancy(reviewer, stated(extracted?.id ?? ""))).toThrow(/not been confirmed/);

    confirmValue(reviewer, extracted?.id ?? "", { review_task_id: input.review_task_id });
    expect(raiseDiscrepancy(reviewer, stated(extracted?.id ?? "")).record.status).toBe("open");
  });
});

describe("resolveDiscrepancy", () => {
  it("requires the question to have been sent", () => {
    const { docs, task } = openReview();
    const extracted = proposeFieldValue(system, {
      field_key: "pay_stub.gross_pay",
      value: 235_000,
      source: boxSource(docs.pay_stub.id, "2,350.00"),
    }).proposal;
    const { record } = raiseDiscrepancy(reviewer, {
      field_key: "pay_stub.annualized_income",
      stated: { value: 8_500_000, pointer: { kind: "form", field_key: "stated_annual_income" } },
      extracted: { value: 6_110_000, proposal_id: extracted?.id ?? "" },
      rule_id: "income_within_10_percent_or_5000",
      tolerance_version: "schemas@absent",
      difference: { absolute: 2_390_000, percent: 28.1 },
      reason_code: "income_outside_tolerance",
      question: { template_id: "income_outside_tolerance", text: "Could you ask the homeowner?" },
      review_task_id: task.id,
    });

    expect(() => resolveDiscrepancy(reviewer, record.id, { resolution: "explained", note: "ok" })).toThrow(
      /Send the question/,
    );
    expect(store.getDiscrepancy(record.id)?.status).toBe("open");
    expect(audit.list(APP).some((e) => e.type === "discrepancy.resolved")).toBe(false);

    sendDiscrepancyQuestion(reviewer, record.id, "Is there other income?");
    resolveDiscrepancy(reviewer, record.id, { resolution: "explained", note: "Second job." });
    expect(store.getDiscrepancy(record.id)?.status).toBe("resolved");
  });
});

describe("paired audit events", () => {
  it("hands the review completion and its state change to the sink as one batch", () => {
    const writes: string[][] = [];
    installAuditLog(
      createAuditLog({
        appendLine: (json) => void writes.push([json]),
        appendLines: (batch) => void writes.push([...batch]),
      }),
    );
    const types = () => writes.map((batch) => batch.map((line) => JSON.parse(line).type as string));
    const { task } = openReview();
    writes.length = 0;

    completeReview(reviewer, task.id);
    expect(types()).toEqual([["review.completed", "application.state_changed"]]);
  });

  it("hands the submission and its state change to the sink as one batch", () => {
    fillRequired();
    const writes: string[][] = [];
    installAuditLog(
      createAuditLog({
        appendLine: (json) => void writes.push([json]),
        appendLines: (batch) => void writes.push([...batch]),
      }),
    );

    submitApplication(contractor);
    expect(writes.map((batch) => batch.map((line) => JSON.parse(line).type as string))).toEqual([
      ["application.submitted", "application.state_changed"],
    ]);
  });

  /** A log whose sink fails every write while `failing` is true. */
  function flakySink() {
    const state = { failing: true, lines: [] as string[] };
    const fail = () => {
      if (state.failing) throw new Error("disk full");
    };
    installAuditLog(
      createAuditLog({
        appendLine: (json) => {
          fail();
          state.lines.push(json);
        },
        appendLines: (batch) => {
          fail();
          state.lines.push(...batch);
        },
      }),
    );
    return state;
  }

  it("submits atomically: a failed write leaves the application a draft with no events", () => {
    fillRequired();
    const log = flakySink();

    expect(() => submitApplication(contractor)).toThrow("disk full");
    expect(app().status).toBe("draft");
    expect(audit.list(APP)).toEqual([]);

    log.failing = false;
    submitApplication(contractor);
    expect(app().status).toBe("documents_under_review");
    expect(audit.list(APP).map((e) => [e.seq, e.type])).toEqual([
      [1, "application.submitted"],
      [2, "application.state_changed"],
    ]);
    expect(log.lines).toHaveLength(2);
  });

  it("completes a review atomically: a failed write leaves the task and the application unchanged", () => {
    const { task } = openReview();
    const log = flakySink();

    expect(() => completeReview(reviewer, task.id)).toThrow("disk full");
    expect(app().status).toBe("documents_under_review");
    expect(store.getReviewTask(task.id)?.status).toBe("ready");
    expect(audit.list(APP)).toEqual([]);

    log.failing = false;
    const { event_ids } = completeReview(reviewer, task.id);
    expect(event_ids).toHaveLength(2);
    expect(app().status).toBe("documents_reviewed");
    expect(log.lines).toHaveLength(2);
  });
});
