import { z } from "zod";
import { PRODUCT_IDS } from "./catalog-ids.js";
import { FlagReasonSchema, DiscrepancyReasonSchema, RejectReasonSchema } from "./reason-codes.js";

// The single source of truth for every runtime shape: zod schemas with the `Schema` suffix on the
// const and the bare name on the inferred type (DisclosureBlockSchema / DisclosureBlock). Wire,
// audit and schema field names are snake_case. Money is integer cents; APR is integer basis points.
// Objects are strict, so a field that is not declared here fails loudly instead of being dropped.

const obj = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

// ---------------------------------------------------------------------------------------------
// PII classes. Audit payload fields that hold personal or document data carry their class in the
// schema description ("pii:<class>"), so the production split into audit stores is mechanical.
// ---------------------------------------------------------------------------------------------

export const PII_CLASSES = [
  "personal", // names, addresses, ZIP codes
  "financial", // amounts, payments, income
  "free_text", // contractor, homeowner or reviewer prose
  "document", // content read from an uploaded document
  "model_io", // raw prompts and raw model output, which can hold any of the above
  "mixed", // field values and service payloads, which can hold personal and financial data
] as const;
export type PiiClass = (typeof PII_CLASSES)[number];

const PII_PREFIX = "pii:";

function pii<T extends z.ZodTypeAny>(piiClass: PiiClass, schema: T): T {
  return schema.describe(`${PII_PREFIX}${piiClass}`) as T;
}

/** The PII class annotated on a schema, if any. */
export function piiClassOf(schema: z.ZodTypeAny): PiiClass | undefined {
  const description = schema.description;
  if (!description?.startsWith(PII_PREFIX)) return undefined;
  return description.slice(PII_PREFIX.length) as PiiClass;
}

// ---------------------------------------------------------------------------------------------
// Enums and primitives
// ---------------------------------------------------------------------------------------------

export const ActorTypeSchema = z.enum(["contractor", "reviewer", "system", "model"]);
export type ActorType = z.infer<typeof ActorTypeSchema>;

export const ActorSchema = obj({ type: ActorTypeSchema, id: z.string().min(1) });
export type Actor = z.infer<typeof ActorSchema>;

export const ApplicationStatusSchema = z.enum([
  "draft",
  "documents_under_review",
  "documents_reviewed",
]);
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;

export const DocumentSlotSchema = z.enum(["pay_stub", "estimate", "scope_letter"]);
export type DocumentSlot = z.infer<typeof DocumentSlotSchema>;

export const ExtractionStatusSchema = z.enum([
  "pending",
  "done",
  "failed",
  "type_mismatch",
  "manual",
]);
export type ExtractionStatus = z.infer<typeof ExtractionStatusSchema>;

/**
 * What read a document: the PDF's text layer (`pdfjs`), the recorded OCR output of the sample pay
 * stub (`ocr_fixture`), or tesseract.js reading the page pictures of a PDF that has no text layer
 * (`ocr_tesseract`). A file starts as `pdfjs` or `ocr_fixture`; extraction records the adapter that
 * actually read it.
 */
export const DocumentAdapterSchema = z.enum(["pdfjs", "ocr_fixture", "ocr_tesseract"]);
export type DocumentAdapter = z.infer<typeof DocumentAdapterSchema>;

export const MatchMethodSchema = z.enum(["exact", "normalized", "not_located", "not_extracted"]);
export type MatchMethod = z.infer<typeof MatchMethodSchema>;

export const MechanicSchema = z.enum(["fixed", "zero_intro", "deferred_interest"]);
export type Mechanic = z.infer<typeof MechanicSchema>;

export const ProductIdSchema = z.enum(PRODUCT_IDS);

export const SurfaceSchema = z.enum(["homeowner_view", "contractor_chat"]);
export type Surface = z.infer<typeof SurfaceSchema>;

export const ToolServiceSchema = z.enum([
  "catalog",
  "credit_engine",
  "plaid",
  "contractor_profile",
  "documents",
  "review_queue",
  "calculator",
]);
export type ToolService = z.infer<typeof ToolServiceSchema>;

export const ErrorCodeSchema = z.enum([
  "llm.missing_key",
  "llm.auth_failed",
  "llm.timeout",
  "llm.rate_limited",
  "llm.server_error",
  "llm.refusal",
  "llm.schema_invalid",
  "guardrail.judge_unavailable",
  "catalog.unavailable",
  "catalog.schema_mismatch",
  "extraction.source_not_located",
  "extraction.document_type_mismatch",
  "extraction.no_text_layer",
  "extraction.ocr_timeout",
  "copilot.disabled",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

/** The body of every non-2xx JSON response and of the stream's `error` line (minus `type`). */
export const ErrorBodySchema = obj({
  code: ErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

/** A stored field value: integer cents for money, a string for everything else. */
export const FieldValueSchema = z.union([z.string(), z.number()]);
export type FieldValue = z.infer<typeof FieldValueSchema>;

const IsoTimestampSchema = z.string().datetime();

/** Anything `JSON.stringify` writes and `JSON.parse` reads back unchanged. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * A JSON value, recursively. Unlike `z.unknown()` it rejects `undefined`, so an object key typed
 * with it is required: Zod 3 treats a key whose schema accepts `undefined` as omittable. It also
 * rejects NaN, infinities, dates, bigints and functions, none of which survive the audit file.
 */
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ]),
);

// ---------------------------------------------------------------------------------------------
// Versions block
// ---------------------------------------------------------------------------------------------

/**
 * Content versions stamped on every audit event: `<name>@<first 8 hex of the file hash>`, or
 * `<name>@absent` for a file that does not exist yet; plus the git sha and the three model ids
 * in effect (after any base-URL translation).
 */
export const VersionsBlockSchema = obj({
  copilot_prompt: z.string(),
  judge_prompt: z.string(),
  extraction_prompt: z.string(),
  denylist: z.string(),
  template: z.string(),
  catalog: z.string(),
  calculator: z.string(),
  application_schema: z.string(),
  schemas: z.string(),
  fallback_texts: z.string(),
  git_sha: z.string(),
  copilot_model: z.string(),
  extraction_model: z.string(),
  judge_model: z.string(),
});
export type VersionsBlock = z.infer<typeof VersionsBlockSchema>;

// ---------------------------------------------------------------------------------------------
// Positioned text, proposals and match results
// ---------------------------------------------------------------------------------------------

/** A box in page-relative fractions with a top-left origin. */
export const BoxSchema = obj({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
export type Box = z.infer<typeof BoxSchema>;

/** One word of a document's positioned text. A word with no geometry has `box: null`. */
export const PositionedWordSchema = obj({
  text: z.string(),
  box: BoxSchema.nullable(),
  confidence: z.number().nullable(),
  page: z.number().int().positive().optional(),
  line: z.number().int().nonnegative().optional(),
  token: z.number().int().nonnegative().optional(),
});
export type PositionedWord = z.infer<typeof PositionedWordSchema>;

export const MessageSourceSchema = obj({
  kind: z.literal("message"),
  ref: obj({ message_id: z.string(), quote: z.string() }),
});

export const BoxSourceSchema = obj({
  kind: z.literal("box"),
  ref: obj({
    document_id: z.string(),
    page: z.number().int().positive().nullable(),
    bbox: BoxSchema.nullable(),
    words: z.array(PositionedWordSchema),
    quoted_text: z.string(),
  }),
});

export const FormulaSourceSchema = obj({
  kind: z.literal("formula"),
  ref: obj({ formula: z.string(), inputs: z.array(z.string()) }),
});

export const ProposalSourceSchema = z.discriminatedUnion("kind", [
  MessageSourceSchema,
  BoxSourceSchema,
  FormulaSourceSchema,
]);
export type ProposalSource = z.infer<typeof ProposalSourceSchema>;
export type ProposalSourceKind = ProposalSource["kind"];

export const MatchResultSchema = obj({
  method: MatchMethodSchema,
  rejected_pointer: z.boolean().optional(),
});
export type MatchResult = z.infer<typeof MatchResultSchema>;

export const ProposalStateSchema = z.enum([
  "proposed",
  "confirmed",
  "edited",
  "rejected",
  "superseded",
]);
export type ProposalState = z.infer<typeof ProposalStateSchema>;

/** The sidecar record behind a suggested value, shared by the copilot and the extraction. */
export const ProposedValueSchema = obj({
  id: z.string(),
  application_id: z.string(),
  /** An application field id, or `<slot>.<field_id>` for a document value. */
  field_key: z.string(),
  /** Null for a document field the model did not find (`match.method = not_extracted`). */
  value: FieldValueSchema.nullable(),
  source: ProposalSourceSchema,
  match: MatchResultSchema.optional(),
  state: ProposalStateSchema,
  versions: VersionsBlockSchema,
  audit_event_id: z.string(),
  actor_id: z.string(),
  confirmed_by: z.string().optional(),
  confirmed_at: IsoTimestampSchema.optional(),
  located_by_reviewer: z.boolean().optional(),
  /** Set when the proposal was rejected. */
  reason_code: RejectReasonSchema.optional(),
});
export type ProposedValue = z.infer<typeof ProposedValueSchema>;

// ---------------------------------------------------------------------------------------------
// Application, documents, review, discrepancies
// ---------------------------------------------------------------------------------------------

export const FieldStateSchema = z.enum(["typed", "confirmed", "edited"]);
export type FieldState = z.infer<typeof FieldStateSchema>;

/** A stored field value. The application holds only typed, confirmed and edited values. */
export const FieldEntrySchema = obj({
  value: FieldValueSchema,
  state: FieldStateSchema,
  source_ref: ProposalSourceSchema.nullable(),
});
export type FieldEntry = z.infer<typeof FieldEntrySchema>;

/** Reviewed annual income as stored: integer cents, never negative. */
export const VerifiedIncomeSchema = z.number().int().nonnegative();

export const VerifiedSchema = obj({
  verified_annual_income: VerifiedIncomeSchema.nullable(),
  verification_source: z.literal("document_review").nullable(),
});
export type Verified = z.infer<typeof VerifiedSchema>;

export const ApplicationSchema = obj({
  id: z.string(),
  contractor_id: z.string(),
  status: ApplicationStatusSchema,
  fields: z.record(FieldEntrySchema),
  verified: VerifiedSchema,
  document_ids: z.array(z.string()),
});
export type Application = z.infer<typeof ApplicationSchema>;

export const DocumentPagesSchema = obj({
  count: z.number().int().positive(),
  width: z.number(),
  height: z.number(),
});

export const DocumentRecordSchema = obj({
  id: z.string(),
  application_id: z.string(),
  slot: DocumentSlotSchema,
  file_ref: z.string(),
  pages: DocumentPagesSchema.nullable(),
  positioned_text_ref: z.string().nullable(),
  adapter: DocumentAdapterSchema,
  extraction_status: ExtractionStatusSchema,
});
export type DocumentRecord = z.infer<typeof DocumentRecordSchema>;

export const ReviewTaskStatusSchema = z.enum(["ready", "in_review", "complete", "extraction_failed"]);
export type ReviewTaskStatus = z.infer<typeof ReviewTaskStatusSchema>;

export const ReviewTaskSchema = obj({
  id: z.string(),
  application_id: z.string(),
  document_ids: z.array(z.string()),
  status: ReviewTaskStatusSchema,
  jsm_issue_id: z.string(),
  created_at: IsoTimestampSchema,
});
export type ReviewTask = z.infer<typeof ReviewTaskSchema>;

export const DiscrepancyStatusSchema = z.enum(["open", "resolved"]);
export const DiscrepancyResolutionSchema = z.enum(["explained", "corrected"]);
export type DiscrepancyResolution = z.infer<typeof DiscrepancyResolutionSchema>;

export const DiscrepancyPointerSchema = z.discriminatedUnion("kind", [
  obj({ kind: z.literal("form"), field_key: z.string() }),
  obj({ kind: z.literal("proposal"), proposal_id: z.string() }),
]);

export const DiscrepancyRecordSchema = obj({
  id: z.string(),
  application_id: z.string(),
  field_key: z.string(),
  stated: obj({ value: FieldValueSchema.nullable(), pointer: DiscrepancyPointerSchema }),
  extracted: obj({ value: FieldValueSchema.nullable(), proposal_id: z.string() }),
  rule_id: z.string(),
  /** The `schemas@<sha>` hash in effect when the rule ran. */
  tolerance_version: z.string(),
  difference: obj({ absolute: z.number(), percent: z.number() }),
  reason_code: DiscrepancyReasonSchema,
  question: obj({ template_id: z.string(), text: z.string() }),
  sent_at: IsoTimestampSchema.optional(),
  contractor_reply: obj({ text: z.string(), at: IsoTimestampSchema }).optional(),
  status: DiscrepancyStatusSchema,
  resolution: DiscrepancyResolutionSchema.optional(),
  resolver: z.string().optional(),
  note: z.string().optional(),
  review_task_id: z.string(),
});
export type DiscrepancyRecord = z.infer<typeof DiscrepancyRecordSchema>;

/** What `raiseDiscrepancy` takes: the record before the command assigns its id, status and times. */
export const DiscrepancyRaiseInputSchema = obj({
  field_key: z.string(),
  stated: DiscrepancyRecordSchema.shape.stated,
  extracted: DiscrepancyRecordSchema.shape.extracted,
  rule_id: z.string(),
  tolerance_version: z.string(),
  difference: DiscrepancyRecordSchema.shape.difference,
  reason_code: DiscrepancyReasonSchema,
  question: DiscrepancyRecordSchema.shape.question,
  review_task_id: z.string(),
});
export type DiscrepancyRaiseInput = z.infer<typeof DiscrepancyRaiseInputSchema>;

/** The contractor-facing banner, derived from the open discrepancy records and never stored. */
export const BannerSchema = obj({
  text: z.string(),
  question: z.string(),
  record_id: z.string(),
  contractor_reply: z.string().nullable(),
});
export type Banner = z.infer<typeof BannerSchema>;

export const TranscriptMessageSchema = obj({
  id: z.string(),
  application_id: z.string(),
  role: z.enum(["contractor", "assistant"]),
  text: z.string(),
  ts: IsoTimestampSchema,
  event_id: z.string(),
});
export type TranscriptMessage = z.infer<typeof TranscriptMessageSchema>;

export const ContractorSchema = obj({ id: z.string(), name: z.string(), company: z.string() });
export type Contractor = z.infer<typeof ContractorSchema>;

export const ReviewerSchema = obj({ id: z.string(), name: z.string() });
export type Reviewer = z.infer<typeof ReviewerSchema>;

// ---------------------------------------------------------------------------------------------
// Catalog, calculator output, disclosures, homeowner view, options
// ---------------------------------------------------------------------------------------------

export const CatalogProductSchema = obj({
  id: ProductIdSchema,
  name: z.string(),
  mechanic: MechanicSchema,
  term_months: z.number().int().positive(),
  /** The APR charged on the balance (the standard APR for the promotional mechanics). */
  apr_bps: z.number().int().nonnegative(),
  promo_months: z.number().int().positive().nullable(),
  standard_apr_bps: z.number().int().nonnegative(),
  plain_sentence: z.string(),
  /** The rules text passed to the model. */
  rules: z.string(),
});
export type CatalogProduct = z.infer<typeof CatalogProductSchema>;

export const CatalogSchema = obj({
  /** The shape version the calculator checks; not a content version. */
  schema_version: z.number().int(),
  products: z.array(CatalogProductSchema),
});
export type Catalog = z.infer<typeof CatalogSchema>;

export const ScheduleRowSchema = obj({
  month: z.number().int().positive(),
  payment_cents: z.number().int(),
  interest_cents: z.number().int(),
  principal_cents: z.number().int(),
  balance_cents: z.number().int(),
});
export type ScheduleRow = z.infer<typeof ScheduleRowSchema>;

export const PaymentOptionSchema = obj({
  label: z.enum(["Option A", "Option B", "Option C"]),
  product_id: ProductIdSchema,
  product_name: z.string(),
  mechanic: MechanicSchema,
  term_months: z.number().int().positive(),
  /** The contract rate: the product's standard APR, charged on the balance. */
  apr_bps: z.number().int().nonnegative(),
  /**
   * The actuarial APR of `schedule` (Regulation Z Appendix J, monthly periods), in basis points.
   * Set on every option the calculator prices; the TILA cell and the options table print it, and a
   * schedule that earns less than the contract rate (free months) shows the lower figure.
   */
  schedule_apr_bps: z.number().int().nonnegative().optional(),
  /** 0 for the promotional mechanics, absent for `fixed`. */
  promo_apr_bps: z.number().int().nonnegative().optional(),
  payment_cents: z.number().int(),
  promo_payment_cents: z.number().int().optional(),
  promo_months: z.number().int().positive().optional(),
  finance_charge_cents: z.number().int(),
  amount_financed_cents: z.number().int(),
  total_of_payments_cents: z.number().int(),
  schedule: z.array(ScheduleRowSchema),
  consequence: obj({
    interest_added_cents: z.number().int(),
    payment_cents: z.number().int(),
    total_cents: z.number().int(),
  }).optional(),
});
export type PaymentOption = z.infer<typeof PaymentOptionSchema>;

export const CalculatorResultSchema = obj({
  amount_cents: z.number().int().positive(),
  /** The term the caller asked for (applies to `fixed` only), or null for each product's catalog term. */
  term_months: z.number().int().positive().nullable(),
  options: z.array(PaymentOptionSchema),
});
export type CalculatorResult = z.infer<typeof CalculatorResultSchema>;

/** One option's pre-formatted TILA cells. The renderers print these strings and compute nothing. */
export const DisclosureOptionSchema = obj({
  label: PaymentOptionSchema.shape.label,
  product_id: ProductIdSchema,
  apr: z.string(),
  finance_charge: z.string(),
  amount_financed: z.string(),
  total_of_payments: z.string(),
  schedule_line: z.string(),
  consequence_line: z.string().nullable(),
});

export const DisclosureBlockSchema = obj({
  options: z.array(DisclosureOptionSchema),
  estimate_statement: z.string(),
  respa_line: z.string(),
});
export type DisclosureBlock = z.infer<typeof DisclosureBlockSchema>;

/**
 * One option's table cells as the person reads them, pre-formatted by the server (the client
 * formats no numbers): the payment wording per mechanic, the term and the APR.
 */
export const OptionDisplaySchema = obj({
  label: PaymentOptionSchema.shape.label,
  product_id: ProductIdSchema,
  payment_text: z.string(),
  term_text: z.string(),
  apr_text: z.string(),
});
export type OptionDisplay = z.infer<typeof OptionDisplaySchema>;

export const HomeownerViewPropsSchema = obj({
  options: CalculatorResultSchema,
  options_display: z.array(OptionDisplaySchema),
  disclosure_block: DisclosureBlockSchema,
  /** The judged explanation's body. The contractor's question is split off before it is stored and never reaches this. */
  explanation: z.string(),
  mechanic_sentences: z.record(ProductIdSchema, z.string()),
  what_happens_next: z.string(),
  template_version: z.string(),
});
export type HomeownerViewProps = z.infer<typeof HomeownerViewPropsSchema>;

export const InputsSourceSchema = obj({
  amount: z.enum(["form", "argument"]),
  term: z.enum(["form", "argument", "catalog"]),
});
export type InputsSource = z.infer<typeof InputsSourceSchema>;

/** One payment calculation. `explanation` is the judged text, absent for the no-model button. */
export const OptionsRecordSchema = obj({
  options_id: z.string(),
  application_id: z.string(),
  turn_id: z.string().optional(),
  calculator_output: CalculatorResultSchema,
  explanation: z.string().optional(),
  inputs_source: InputsSourceSchema,
});
export type OptionsRecord = z.infer<typeof OptionsRecordSchema>;

// ---------------------------------------------------------------------------------------------
// Guardrail
// ---------------------------------------------------------------------------------------------

export const GuardrailLayerSchema = z.enum(["denylist", "number_match", "judge"]);
export type GuardrailLayer = z.infer<typeof GuardrailLayerSchema>;

export const GuardrailOutcomeSchema = z.enum(["pass", "blocked", "judge_unavailable"]);
export type GuardrailOutcome = z.infer<typeof GuardrailOutcomeSchema>;

export const VerdictSchema = obj({
  pass: z.boolean(),
  layer: GuardrailLayerSchema,
  outcome: GuardrailOutcomeSchema,
  reason: z.string().optional(),
  matched: z.array(z.string()).optional(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export const GuardrailAllowedSchema = obj({
  calculator_values: z.array(z.string()),
  contractor_figures: z.array(z.string()),
  /** Each priced option's own calculator values by label ("Option A"), for the per-option binding of money figures. */
  option_values: z.record(z.string(), z.array(z.string())).optional(),
});
export type GuardrailAllowed = z.infer<typeof GuardrailAllowedSchema>;

// ---------------------------------------------------------------------------------------------
// Audit events: one append-only union
// ---------------------------------------------------------------------------------------------

export const AUDIT_SCHEMA_VERSION = 1 as const;

const AuditBaseSchema = obj({
  event_id: z.string(),
  application_id: z.string(),
  session_id: z.string(),
  turn_id: z.string().optional(),
  parent_event_id: z.string().optional(),
  seq: z.number().int().positive(),
  ts: IsoTimestampSchema,
  actor: ActorSchema,
  schema_version: z.literal(AUDIT_SCHEMA_VERSION),
  versions: VersionsBlockSchema,
});
export type AuditBase = z.infer<typeof AuditBaseSchema>;

export const DroppedReasonSchema = z.enum([
  "equals_confirmed",
  "field_not_fillable",
  "quote_not_verified",
]);
export type DroppedReason = z.infer<typeof DroppedReasonSchema>;

const MockEnvelopeSchema = obj({
  service: z.string(),
  fixture_id: z.string(),
  mock_version: z.literal(1),
});
export type MockEnvelope = z.infer<typeof MockEnvelopeSchema>;

// The payload fields below hold arbitrary service and model data. Emitters pass values typed
// `unknown`, so the TypeScript type stays `unknown`; the schema still refuses a missing key and
// anything that is not JSON.
const jsonPayload: z.ZodType<unknown> = JsonValueSchema;

export const AuditEventSchema = z.discriminatedUnion("type", [
  AuditBaseSchema.extend({
    type: z.literal("message.received"),
    message_id: z.string(),
    text: pii("free_text", z.string()),
  }),
  AuditBaseSchema.extend({
    type: z.literal("model.call"),
    use_case: z.enum(["copilot", "extraction", "judge"]),
    model_id: z.string(),
    effort: z.string(),
    context: obj({
      message_ids: z.array(z.string()),
      system_prompt_version: z.string(),
      system_prompt_sha256: z.string(),
    }),
    /** The full request body; inlined in the prototype, an S3 reference in production. */
    raw_input: pii("model_io", jsonPayload),
    raw_output: pii("model_io", jsonPayload),
    usage: obj({
      input: z.number().int().nonnegative(),
      output: z.number().int().nonnegative(),
      cache_read: z.number().int().nonnegative(),
    }),
    latency_ms: z.number().nonnegative(),
    stop_reason: z.string().nullable(),
    error_code: ErrorCodeSchema.optional(),
    /** True when the response was replayed from a committed fixture rather than a live call. */
    _fixture: z.boolean().optional(),
  }),
  AuditBaseSchema.extend({
    type: z.literal("tool.call"),
    service: ToolServiceSchema,
    method: z.string(),
    input: pii("mixed", jsonPayload),
    output: pii("mixed", jsonPayload),
    options_id: z.string().optional(),
    _mock: MockEnvelopeSchema.optional(),
    latency_ms: z.number().nonnegative(),
  }),
  AuditBaseSchema.extend({
    type: z.literal("guardrail.verdict"),
    layer: GuardrailLayerSchema,
    verdict: z.enum(["pass", "block"]),
    matched_terms: pii("free_text", z.array(z.string()).optional()),
    rationale: pii("free_text", z.string().optional()),
    outcome: GuardrailOutcomeSchema,
    latency_ms: z.number().nonnegative(),
  }),
  AuditBaseSchema.extend({
    type: z.literal("field.proposed"),
    /** Null when the value was dropped before a proposal was created. */
    proposal_id: z.string().nullable(),
    field_key: z.string(),
    value: pii("mixed", FieldValueSchema.nullable()),
    source: pii("document", ProposalSourceSchema),
    dropped_reason: DroppedReasonSchema.optional(),
    superseded_proposal_ids: z.array(z.string()).optional(),
  }),
  AuditBaseSchema.extend({
    type: z.literal("field.edited"),
    proposal_id: z.string(),
    field_key: z.string(),
    before: pii("mixed", FieldValueSchema.nullable()),
    after: pii("mixed", FieldValueSchema),
    review_task_id: z.string().optional(),
    elapsed_ms: z.number().nonnegative().optional(),
  }),
  AuditBaseSchema.extend({
    type: z.literal("field.confirmed"),
    /** Null for a contractor-typed value, which has no proposal. */
    proposal_id: z.string().nullable(),
    field_key: z.string(),
    source: z.enum(["typed", "proposal"]),
    final_value: pii("mixed", FieldValueSchema),
    located_by_reviewer: z.boolean().optional(),
    review_task_id: z.string().optional(),
    elapsed_ms: z.number().nonnegative().optional(),
  }),
  AuditBaseSchema.extend({
    type: z.literal("field.rejected"),
    proposal_id: z.string(),
    field_key: z.string(),
    reason_code: RejectReasonSchema,
    note: pii("free_text", z.string().optional()),
    review_task_id: z.string().optional(),
    elapsed_ms: z.number().nonnegative().optional(),
  }),
  AuditBaseSchema.extend({
    type: z.literal("view.rendered"),
    surface: z.literal("homeowner_view"),
    options_id: z.string(),
    /** The complete props as shown. */
    props: pii("financial", HomeownerViewPropsSchema),
    content_sha256: z.string(),
    produced_by: z.array(z.string()),
  }),
  AuditBaseSchema.extend({
    type: z.literal("document.attached"),
    document_id: z.string(),
    slot: DocumentSlotSchema,
    adapter: DocumentAdapterSchema,
    /** The document this one took the slot from, when the contractor replaced a file before submitting. */
    replaces: z.string().optional(),
  }),
  AuditBaseSchema.extend({
    type: z.literal("extraction.completed"),
    document_id: z.string(),
    extraction_status: ExtractionStatusSchema,
    /** The adapter that read the document: the one it was attached with, or `ocr_tesseract` when its text layer was empty. */
    adapter: DocumentAdapterSchema.optional(),
    per_field: z.array(
      obj({
        field_key: z.string(),
        match_method: MatchMethodSchema,
        adapter: DocumentAdapterSchema,
        /** True when the quote did not contain the value the model gave, so no box was drawn. */
        rejected_pointer: z.boolean().optional(),
        /** Why the value as written could not be read into its type; the field is then `not_extracted`. */
        parse_error: z.string().optional(),
      }),
    ),
    error_code: ErrorCodeSchema.optional(),
  }),
  AuditBaseSchema.extend({
    type: z.literal("review.task_created"),
    task_id: z.string(),
    document_ids: z.array(z.string()),
    slot_statuses: z.record(DocumentSlotSchema, ExtractionStatusSchema),
    jsm_issue_id: z.string(),
  }),
  AuditBaseSchema.extend({
    type: z.literal("review.completed"),
    task_id: z.string(),
    outcome: z.literal("documents_reviewed"),
    open_discrepancies: z.number().int().nonnegative(),
  }),
  AuditBaseSchema.extend({
    type: z.literal("discrepancy.raised"),
    record: pii("mixed", DiscrepancyRecordSchema),
  }),
  AuditBaseSchema.extend({
    type: z.literal("discrepancy.sent"),
    record: pii("mixed", DiscrepancyRecordSchema),
  }),
  AuditBaseSchema.extend({
    type: z.literal("discrepancy.replied"),
    record: pii("mixed", DiscrepancyRecordSchema),
  }),
  AuditBaseSchema.extend({
    type: z.literal("discrepancy.resolved"),
    record: pii("mixed", DiscrepancyRecordSchema),
  }),
  AuditBaseSchema.extend({
    type: z.literal("application.state_changed"),
    from: ApplicationStatusSchema,
    to: ApplicationStatusSchema,
    /** The banner text in effect after the change, or null. */
    derived_banner: z.string().nullable(),
  }),
  AuditBaseSchema.extend({
    type: z.literal("context.compacted"),
    dropped_message_ids: z.array(z.string()),
  }),
  // Primary events of commands that section 3's list does not name, so that every command
  // appends exactly one primary event.
  AuditBaseSchema.extend({
    type: z.literal("application.submitted"),
    fields: pii("mixed", z.record(FieldValueSchema)),
    document_ids: z.array(z.string()),
  }),
  AuditBaseSchema.extend({
    type: z.literal("options.stored"),
    options_id: z.string(),
    inputs_source: InputsSourceSchema,
    product_ids: z.array(ProductIdSchema),
  }),
  AuditBaseSchema.extend({
    type: z.literal("options.explained"),
    options_id: z.string(),
    /** The explanation body, as the homeowner view prints it. */
    text: pii("free_text", z.string()),
    /** The question for the contractor that ended the judged draft, without its marker; null when there was none. */
    question: pii("free_text", z.string().nullable()),
  }),
  AuditBaseSchema.extend({
    type: z.literal("review.started"),
    task_id: z.string(),
  }),
]);
export type AuditEvent = z.infer<typeof AuditEventSchema>;
export type AuditEventType = AuditEvent["type"];

/** For documentation and the audit schema doc: each event type's annotated PII classes. */
export function auditPiiMap(): Record<string, Record<string, PiiClass>> {
  const map: Record<string, Record<string, PiiClass>> = {};
  for (const option of AuditEventSchema.options) {
    const type = option.shape.type.value;
    const fields: Record<string, PiiClass> = {};
    for (const [name, schema] of Object.entries(option.shape)) {
      const piiClass = piiClassOf(schema as z.ZodTypeAny);
      if (piiClass) fields[name] = piiClass;
    }
    map[type] = fields;
  }
  return map;
}

// ---------------------------------------------------------------------------------------------
// The copilot turn stream: one JSON object per line
// ---------------------------------------------------------------------------------------------

export const StatusLineSchema = obj({ type: z.literal("status"), step: z.string() });

export const OptionsLineSchema = obj({
  type: z.literal("options"),
  options_id: z.string(),
  calculator_result: CalculatorResultSchema,
  inputs_echo: z.string(),
  inputs_source: InputsSourceSchema,
  argument_label: z.string().nullable(),
  options_display: z.array(OptionDisplaySchema),
  disclosure_block: DisclosureBlockSchema,
  footer: z.string(),
});

export const ProposalsLineSchema = obj({
  type: z.literal("proposals"),
  proposals: z.array(ProposedValueSchema),
  note: z.string().nullable(),
});

export const ExplanationLineSchema = obj({
  type: z.literal("explanation"),
  /** The body, for the contractor and the homeowner. */
  text: z.string(),
  /** A question for the contractor alone, shown as its own bubble after the body; null when there is none. */
  question: z.string().nullable(),
  footer: z.string().nullable(),
  event_ids: z.array(z.string()),
});

export const FallbackLineSchema = obj({
  type: z.literal("fallback"),
  text: z.string(),
  marker: z.string(),
  audit_event_id: z.string(),
});

export const ErrorLineSchema = obj({
  type: z.literal("error"),
  code: ErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
});

export const DoneLineSchema = obj({ type: z.literal("done"), event_ids: z.array(z.string()) });

export const StreamLineSchema = z.discriminatedUnion("type", [
  StatusLineSchema,
  OptionsLineSchema,
  ProposalsLineSchema,
  ExplanationLineSchema,
  FallbackLineSchema,
  ErrorLineSchema,
  DoneLineSchema,
]);
export type StreamLine = z.infer<typeof StreamLineSchema>;

// ---------------------------------------------------------------------------------------------
// Route requests and responses
// ---------------------------------------------------------------------------------------------

export const TurnRequestSchema = obj({ text: z.string().trim().min(1).max(4000) });
export type TurnRequest = z.infer<typeof TurnRequestSchema>;

export const FieldEditRequestSchema = obj({ value: z.string() });
export type FieldEditRequest = z.infer<typeof FieldEditRequestSchema>;

export const ProposalRejectRequestSchema = obj({
  reason_code: z.literal("dismissed_by_contractor"),
});
export type ProposalRejectRequest = z.infer<typeof ProposalRejectRequestSchema>;

export const HomeownerViewRequestSchema = obj({ options_id: z.string() });
export type HomeownerViewRequest = z.infer<typeof HomeownerViewRequestSchema>;

export const DiscrepancyReplyRequestSchema = obj({ text: z.string().trim().min(1).max(4000) });
export type DiscrepancyReplyRequest = z.infer<typeof DiscrepancyReplyRequestSchema>;

export const DecisionRequestSchema = obj({
  action: z.enum(["confirm", "correct", "flag"]),
  value: FieldValueSchema.optional(),
  reason_code: FlagReasonSchema.optional(),
  note: z.string().optional(),
  located_by_reviewer: z.boolean().optional(),
});
export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;

export const DiscrepancySendRequestSchema = obj({ text: z.string().trim().min(1).max(4000) });
export type DiscrepancySendRequest = z.infer<typeof DiscrepancySendRequestSchema>;

export const DiscrepancyResolveRequestSchema = obj({
  resolution: DiscrepancyResolutionSchema,
  note: z.string().trim().min(1).max(4000),
});
export type DiscrepancyResolveRequest = z.infer<typeof DiscrepancyResolveRequestSchema>;

/** One field of the application as the form shows it: stored values with proposals merged in. */
export const ApplicationFieldViewSchema = obj({
  value: FieldValueSchema,
  state: z.enum(["typed", "confirmed", "edited", "proposed"]),
  source_ref: ProposalSourceSchema.nullable(),
  /** The live proposal behind a `proposed` value. */
  proposal_id: z.string().nullable(),
  /** The stored value a proposal would replace, so the form can show old to new. */
  previous: obj({ value: FieldValueSchema, state: FieldStateSchema }).nullable(),
});
export type ApplicationFieldView = z.infer<typeof ApplicationFieldViewSchema>;

/** `GET /api/applications/:id` and the response of every contractor-side write. */
export const ApplicationViewSchema = obj({
  id: z.string(),
  contractor_id: z.string(),
  status: ApplicationStatusSchema,
  fields: z.record(ApplicationFieldViewSchema),
  verified: VerifiedSchema,
  document_ids: z.array(z.string()),
  documents: z.array(DocumentRecordSchema),
  banner: BannerSchema.nullable(),
});
export type ApplicationView = z.infer<typeof ApplicationViewSchema>;

export const AuditResponseSchema = obj({
  events: z.array(AuditEventSchema),
  credit_engine_calls: z.number().int().nonnegative(),
});
export type AuditResponse = z.infer<typeof AuditResponseSchema>;

export const HealthResponseSchema = obj({
  has_llm_key: z.boolean(),
  copilot_enabled: z.boolean(),
  extraction_enabled: z.boolean(),
  versions: VersionsBlockSchema,
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
