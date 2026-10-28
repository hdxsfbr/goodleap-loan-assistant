import { existsSync } from "node:fs";
import { Router } from "express";
import { fieldDef, zodForField } from "@shared/application-schema";
import {
  ApplicationViewSchema,
  DiscrepancyReplyRequestSchema,
  FieldEditRequestSchema,
  ProposalRejectRequestSchema,
  type ApplicationFieldView,
  type ApplicationView,
  type AuditResponse,
  type DocumentAdapter,
  type DocumentSlot,
  type FieldValue,
} from "@shared/schemas";
import { audit } from "../audit-log.js";
import {
  attachDocument,
  confirmValue,
  rejectValue,
  replyToDiscrepancy,
  setFieldValue,
  submitApplication,
} from "../commands.js";
import { deriveBanner } from "../domain/banner.js";
import { CommandError } from "../errors.js";
import { store } from "../store.js";
import { PROJECT_ROOT } from "../versions.js";
import { contractorCtx, parseBody, requireApplication } from "./http.js";

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
    submitApplication(ctx);
    res.json(buildApplicationView(req.params.id));
  });

  return router;
}
