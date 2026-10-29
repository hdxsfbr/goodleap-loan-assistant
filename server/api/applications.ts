import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { Router } from "express";
import { fieldDef, zodForField } from "@shared/application-schema";
import {
  ApplicationViewSchema,
  DiscrepancyReplyRequestSchema,
  FieldEditRequestSchema,
  HomeownerViewRequestSchema,
  ProposalRejectRequestSchema,
  type ApplicationFieldView,
  type ApplicationView,
  type AuditResponse,
  type DocumentAdapter,
  type DocumentSlot,
  type FieldValue,
  type HomeownerViewProps,
  type OptionsRecord,
} from "@shared/schemas";
import { audit } from "../audit-log.js";
import {
  attachDocument,
  confirmValue,
  editValue,
  rejectValue,
  replyToDiscrepancy,
  setFieldValue,
  submitApplication,
} from "../commands.js";
import { deriveBanner } from "../domain/banner.js";
import { renderDisclosureBlock } from "../domain/disclosures/template.js";
import { composeHomeownerView } from "../domain/surfaces.js";
import { CommandError } from "../errors.js";
import { cannedExplanation, cannedSentenceFor } from "../guardrail/fallback.js";
import { store } from "../store.js";
import { PROJECT_ROOT, getVersions } from "../versions.js";
import { contractorCtx, parseBody, requireApplication } from "./http.js";
import { startDocumentReview, systemCtx } from "../extraction/extract.js";

/**
 * The application as the form shows it: stored values with the live proposals merged in as
 * `{ value, state, source_ref }` per field, plus the derived banner.
 */
export function buildApplicationView(applicationId: string): ApplicationView {
  const application = requireApplication(applicationId);
  const fields: Record<string, ApplicationFieldView> = {};
  for (const [key, entry] of Object.entries(application.fields)) {
    fields[key] = {
      value: entry.value,
      state: entry.state,
      source_ref: entry.source_ref,
      proposal_id: null,
      previous: null,
    };
  }
  for (const proposal of store.listProposals(applicationId, { state: "proposed" })) {
    if (proposal.field_key.includes(".") || proposal.value === null) continue;
    const stored = application.fields[proposal.field_key];
    fields[proposal.field_key] = {
      value: proposal.value,
      state: "proposed",
      source_ref: proposal.source,
      proposal_id: proposal.id,
      previous: stored ? { value: stored.value, state: stored.state } : null,
    };
  }
  return ApplicationViewSchema.parse({
    id: application.id,
    contractor_id: application.contractor_id,
    status: application.status,
    fields,
    verified: application.verified,
    document_ids: application.document_ids,
    documents: store.listDocuments(applicationId),
    banner: deriveBanner(store.listDiscrepancies(applicationId)),
  });
}

// "Load demo project": the field values and the bundled documents for the demo application.
const DEMO_FIELDS: ReadonlyArray<readonly [string, FieldValue]> = [
  ["project_type", "roofing"],
  ["project_amount", 3_000_000],
  ["requested_loan_amount", 3_000_000],
  ["stated_annual_income", 8_500_000],
];

const DEMO_DOCUMENTS: ReadonlyArray<{ slot: DocumentSlot; file: string; adapter: DocumentAdapter }> = [
  { slot: "pay_stub", file: "samples/paystub.pdf", adapter: "ocr_fixture" },
  { slot: "estimate", file: "samples/estimate.pdf", adapter: "pdfjs" },
  { slot: "scope_letter", file: "samples/scope_letter.pdf", adapter: "pdfjs" },
];


/** JSON with sorted keys, so a content hash does not depend on how an object was built. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The homeowner view for a stored Options record, as a pure function of the record: its
 * calculator output, the disclosure block rendered by the template, its explanation (the canned
 * sentences when the turn had none or the record came from the no-model button), the mechanic
 * sentence per product, and the template version.
 */
function homeownerViewFor(record: OptionsRecord): HomeownerViewProps {
  const result = record.calculator_output;
  return composeHomeownerView({
    options: result,
    disclosure_block: renderDisclosureBlock(result.options),
    explanation: record.explanation ?? cannedExplanation(result.options),
    mechanic_sentences: Object.fromEntries(
      result.options.map((option) => [option.product_id, cannedSentenceFor(option)]),
    ),
    template_version: getVersions().template,
  });
}

export function createApplicationsRouter(): Router {
  const router = Router();

  router.get("/api/applications/:id", (req, res) => {
    res.json(buildApplicationView(req.params.id));
  });

  router.post("/api/applications/:id/fields/:fieldKey", (req, res) => {
    const ctx = contractorCtx(req, req.params.id);
    const { fieldKey } = req.params;
    if (!fieldDef(fieldKey)) {
      throw new CommandError(`${fieldKey} is not an application field.`, { status: 404 });
    }
    const body = parseBody(FieldEditRequestSchema, req.body);
    const parsed = zodForField(fieldKey).safeParse(body.value);
    if (!parsed.success) {
      throw new CommandError(parsed.error.issues[0]?.message ?? "That value is not valid.", {
        status: 400,
      });
    }
    setFieldValue(ctx, fieldKey, parsed.data);
    res.json(buildApplicationView(req.params.id));
  });

  router.post("/api/applications/:id/proposals/:pid/confirm", (req, res) => {
    const ctx = contractorCtx(req, req.params.id);
    confirmValue(ctx, req.params.pid, {});
    res.json(buildApplicationView(req.params.id));
  });

  router.post("/api/applications/:id/proposals/:pid/reject", (req, res) => {
    const ctx = contractorCtx(req, req.params.id);
    const body = parseBody(ProposalRejectRequestSchema, req.body);
    rejectValue(ctx, req.params.pid, body.reason_code);
    res.json(buildApplicationView(req.params.id));
  });

  router.post("/api/applications/:id/proposals/:pid/edit", (req, res) => {
    const ctx = contractorCtx(req, req.params.id);
    const body = parseBody(FieldEditRequestSchema, req.body);
    const proposal = store.getProposal(req.params.pid);
    if (!proposal || proposal.application_id !== req.params.id) {
      throw new CommandError("That suggestion is no longer waiting for a decision.");
    }
    if (!fieldDef(proposal.field_key)) {
      throw new CommandError("Document values are corrected in review.");
    }
    const parsed = zodForField(proposal.field_key).safeParse(body.value);
    if (!parsed.success) {
      throw new CommandError(parsed.error.issues[0]?.message ?? "That value is not valid.", { status: 400 });
    }
    editValue(ctx, req.params.pid, parsed.data);
    res.json(buildApplicationView(req.params.id));
  });

  router.post("/api/applications/:id/confirm-all", (req, res) => {
    const ctx = contractorCtx(req, req.params.id);
    for (const proposal of store.listProposals(req.params.id, { state: "proposed" })) {
      if (!proposal.field_key.includes(".")) confirmValue(ctx, proposal.id, {});
    }
    res.json(buildApplicationView(req.params.id));
  });

  router.post("/api/applications/:id/load-demo", (req, res) => {
    const ctx = contractorCtx(req, req.params.id);
    for (const [key, value] of DEMO_FIELDS) setFieldValue(ctx, key, value);
    const attached = new Set(store.listDocuments(req.params.id).map((d) => d.slot));
    for (const { slot, file, adapter } of DEMO_DOCUMENTS) {
      if (attached.has(slot)) continue;
      if (!existsSync(`${PROJECT_ROOT}${file}`)) {
        console.warn(`load-demo: ${file} is missing; the ${slot} slot stays empty.`);
        continue;
      }
      attachDocument(ctx, slot, file, adapter);
    }
    res.json(buildApplicationView(req.params.id));
  });

  router.post("/api/applications/:id/homeowner-view", (req, res) => {
    const ctx = contractorCtx(req, req.params.id);
    const body = parseBody(HomeownerViewRequestSchema, req.body);
    const record = store.getOptions(body.options_id);
    if (!record || record.application_id !== req.params.id) {
      throw new CommandError(`Payment options ${body.options_id} were not found.`, { status: 404 });
    }
    const props = homeownerViewFor(record);
    // Produced by: every event of the record's turn, or, for the no-model button, the calculation
    // and storage events that name this record.
    const producedBy = audit
      .list(req.params.id)
      .filter(
        (event) =>
          (record.turn_id !== undefined && event.turn_id === record.turn_id) ||
          ((event.type === "tool.call" || event.type === "options.stored" || event.type === "options.explained") &&
            event.options_id === record.options_id),
      )
      .map((event) => event.event_id);
    audit.emit(ctx, "view.rendered", {
      surface: "homeowner_view",
      options_id: record.options_id,
      props,
      content_sha256: createHash("sha256").update(stableStringify(props)).digest("hex"),
      produced_by: producedBy,
    });
    res.json(props);
  });

  router.post("/api/applications/:id/discrepancies/:did/reply", (req, res) => {
    const ctx = contractorCtx(req, req.params.id);
    const body = parseBody(DiscrepancyReplyRequestSchema, req.body);
    replyToDiscrepancy(ctx, req.params.did, body.text);
    res.json(buildApplicationView(req.params.id));
  });

  router.get("/api/applications/:id/audit", (req, res) => {
    requireApplication(req.params.id);
    const body: AuditResponse = {
      events: audit.list(req.params.id),
      credit_engine_calls: audit.countToolCalls(req.params.id, "credit_engine"),
    };
    res.json(body);
  });

  router.post("/api/applications/:id/submit", (req, res) => {
    const ctx = contractorCtx(req, req.params.id);
    const documentIds = submitApplication(ctx);
    res.json(buildApplicationView(req.params.id));
    // Item 21b: extraction (or the manual review task) starts after the response is sent.
    void startDocumentReview(systemCtx(req.params.id, ctx.session_id), documentIds).catch((err) =>
      console.error("The document review could not start:", err instanceof Error ? err.message : err),
    );
  });

  return router;
}
