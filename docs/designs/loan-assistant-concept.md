# GoodLeap Loan Assistant: application copilot and document extraction with human review

* **Author:** Andre Batista
* **Date:** 2026-10-28
* **Status:** Concept brief after one Goldfish review round (six lenses, 34 consolidated findings, 8 blockers). Full findings: [loan-assistant-concept-goldfish-findings.md](loan-assistant-concept-goldfish-findings.md). All three decisions raised by the review (scope, routing, audit view depth) are recorded in Key Decisions.
* **Sources:** [PRD](../PRD.md), [portal brief](../source/portal-brief.md), take-home challenge (transcribed in `docs/private/takehome-challenge.md`, not committed)

## Overview

### The setting

GoodLeap finances home improvement projects (roofing, solar, HVAC, renovations) through 15,000+
contractor partners. A contractor stands in a homeowner's kitchen, opens the partner portal on a
tablet or laptop, and submits a loan application on the homeowner's behalf. Loans run $5K to $100K
over 5 to 25 years, with promotional structures such as 0% introductory periods and deferred
interest.

The application takes 22 minutes on average against an industry benchmark under 10 minutes, and
38% of applications are abandoned. The two biggest drop-off steps are loan product selection and
income verification. Separately, staff read uploaded pay stubs, contractor estimates and project
scope letters by hand to pull out the details the application needs, which delays decisions.

The submission is a take-home for GoodLeap through Gauntlet AI: a 2 to 3 page design document plus
a working prototype that calls a real LLM, runs locally in under 5 minutes, mocks every financial
service, includes at least one guardrail against non-compliant output, puts TILA/RESPA disclosures
on every borrower-facing communication, and never makes or implies a credit decision. It is due the
morning of 2026-10-29. The design is the primary deliverable; the prototype is a working product
demo of the design, simplified where the design says so.

### The concept

One assistant that acts at the funnel's two failure points, on a shared base.

**Feature 1: application copilot (contractor-facing).** A chat panel that sits beside the
existing application form in the partner portal. The contractor types to it (voice is out of
scope). It does four things:

1. Explains loan products and promotional terms in plain language, tailored to the project the
   contractor describes (for example, what deferred interest means if the balance is not paid off
   by the promo end date).
2. Produces payment options. The model never computes a number. It calls a deterministic payment
   calculator and the mocked loan product catalog, then explains the results by option label,
   without restating figures.
3. Proposes form field values from what the contractor explicitly said. Each proposal carries the
   verbatim quote it came from, which the backend verifies against the contractor's message before
   the proposal exists. Proposed fields are badged, editable, and confirmed by the contractor before
   they enter the application.
4. Produces the homeowner view: a full-screen page the contractor turns toward the homeowner. It
   shows two or three payment options side by side, a plain-language explanation written by the
   model, and a disclosure block produced by a code template. Every homeowner view carries the
   disclosures.

**Feature 2: document extraction with human review (internal).** The contractor uploads the pay
stub, the contractor estimate and the project scope letter through the form. In the backend, an
extraction step reads each document into proposed values against a declarative schema per document
type. Each proposed value points at the words on the page it was read from, shown as a box on the
original document. The backend creates a review task; a document reviewer (internal staff) opens
the application's documents with the boxes drawn on them and confirms, corrects or flags each
value. Nothing enters the application record until a person confirms it. When a confirmed document
value falls outside the tolerance for the stated value, a per-value discrepancy record is opened
and a templated question goes to a person. The system never says "insufficient", "qualifies" or
any other verdict word.

**Shared base.** Mocked services behind typed interfaces (loan product catalog, credit decision
engine, Plaid income verification, contractor profile service, document management, review queue
standing in for Jira Service Management), one LLM client (Anthropic) with one import site, one
guardrail contract with two implementations, one append-only audit event stream, and one web app
with no login and three role tabs: contractor (form, copilot, homeowner view), reviewer (queue,
document with boxes, confirm or flag), and audit (per application: what was shown, by which
version, from which inputs).

### Who it is for

| Who | What they get |
| --- | --- |
| Contractor partner | A monthly payment answer within about 30 seconds and a way to explain products without being a loan officer |
| Homeowner | Plain terms, required disclosures, no pressure language, on a screen they can read themselves |
| Document review staff | Pre-read documents with each value pointing at its source, so review is confirmation rather than extraction |
| Head of Compliance | Every homeowner view and every AI-written value is reconstructible from one application id: inputs, versions, verdicts, source pointer, who confirmed it |
| CTO | Prompt engineering over fine-tuning, managed APIs over self-hosted models, deterministic code for anything with a number in it, a flag to turn each feature off |

### Why this angle

The sources name exactly two drop-off steps and one delay. Feature 1 attacks loan product
selection and the VP's deal-closure goal. Feature 2 attacks income verification and the manual
review delay. The review found that feature 2 costs at least as much to build as feature 1 (the
shared pieces are the small ones). Both features are designed at full depth; the build runs
feature 1 and the shared floor first, then feature 2 at reduced depth, and whatever is unfinished in feature 2 when the build stops
ships as design-only. See Analysis item 1.

## Analysis

Six Goldfish lenses reviewed the concept: architecture and cost, observability, scope and reuse,
UX, migration and rollout, and maintainability. This section records what they found and what the
brief now says as a result. Items marked **Decided** record the author's call on points where
the reviewers disagreed or the brief had to change.

### 1. Scope versus hours

The brief claimed feature 2 adds about 60% to the build. Listed component by component, the shared
pieces (LLM client, audit wrapper, web shell, README) are the small ones. Feature 2's own list is
PDF ingest, positioned text, an OCR path, a quote matcher, a box overlay with coordinate
transforms, three extraction schemas, three synthetic documents, a reviewer UI, a discrepancy
comparator with a tolerance rule and routing, two extra mocks and an extraction eval
specification. That list is at least as long as feature 1's and has the fatter risk tail
(coordinate bugs and OCR noise late at night). In the design document, two features means two
data flows, two failure-mode sets and two eval approaches inside each of six mandated sections in
2 to 3 pages.

The reviewers split. One position: build the copilot path only, and put extraction in the design
document as phase 2 of the rollout (about 200 words across the architecture and AI-decisions
sections earn the credit the provenance idea deserves), with an optional thin slice at the end
(one text-PDF pay stub, value plus quoted text plus page, confirm and flag, no boxes). The other
position: build feature 2 at reduced depth, with positioned text precomputed and committed for all
three samples, the reviewer view with boxes, one deliberate "source not located" value and one
templated clarification transition.

Everyone agreed on three things. No OCR at runtime: tesseract.js pulls about 15 MB on first run,
takes 10 to 30 seconds per page, and makes the demo non-deterministic, so the pay stub image is
OCR'd once and the positioned-text file is committed. The design document states plainly which
items are described only, and the README reads as staging rather than as a shallow half. Evals
are not what gets cut to pay for boxes: the calculator golden cases and the deny-list tests take
about 20 minutes, need no key, and are graded by name.

**Decided:** both features stay in the design document at full depth. The build follows the
consensus order: feature 1 and the shared floor first (steps 1 to 5 of the build order), then
feature 2 at reduced depth with precomputed positioned text (step 6). Whatever part of
feature 2 is unfinished when the build stops ships as design-only,
with the citation thin slice (value, quoted text, page, confirm and flag) as the fallback if the
box pipeline is the unfinished part. The README states what was built and what is described.

### 2. Two compliance promises that had no mechanism

**The audit log.** "An entry per model call" cannot answer the Head of Compliance's question,
because a homeowner view is not a model call. It is a calculator result, a catalog lookup, model
prose, two guardrail verdicts and a template, and nothing in the brief joined them. The brief also
said "one audit log", "per model call" and "per turn", three different granularities. The audit
log is now an append-only event stream with one root correlation key (`application_id`) and
`session_id`, `turn_id`, `event_id`, `parent_event_id`, sequence, UTC timestamp, actor and schema
version on every event. Event types include `model.call` (the exact context the model saw, raw
output, token counts, latency), `tool.call`, `guardrail.verdict` (one per layer),
`field.proposed` / `field.edited` / `field.confirmed`, `card.rendered` (the complete artifact as
shown, with a content hash and pointers to the events that produced it), `document.uploaded`,
`extraction.completed`, `review.decision`, `discrepancy.raised` / `discrepancy.resolved`,
`application.state_changed` and `context.compacted`. Every event carries a versions block stamped
at process start: git sha, copilot prompt, judge prompt, deny-list, disclosure template, catalog
snapshot (the product objects stored by value), calculator, model id (the exact published id, never an alias),
tolerance table, OCR engine. Replay means recomputing the calculator and the template from stored
inputs and asserting equality; model text is stored verbatim and never regenerated. The compliance
query path is: filter by application and `card.rendered`, then follow parent pointers back.

The design names three stores with three policies: audit records (full content, encrypted at rest,
access by role, retention set by Compliance with the Reg Z two-year floor and Reg B 25 months as
reference points; metadata rows in an insert-only Postgres table, payloads and rendered views in S3
by hash with Object Lock), operational logs and traces (ids, event types, versions, error codes,
latencies and token counts only, never field values or document text, 30 to 90 days), and metrics
(aggregates shipped nightly to Snowflake next to the funnel analytics). Cost arithmetic belongs in
the design with the volume labeled an assumption: roughly 100K to 150K started applications a
year, 8K to 10K input tokens per copilot turn, on the order of $0.30 to $0.90 per application
including extraction, $50K to $150K a year against a $200M origination case. LLM spend is not the
constraint; reviewer minutes are.

**Unconfirmed values.** "Nothing enters the application record unconfirmed" was a UI convention.
If three views share one mutable store, the central compliance claim is enforced by discipline,
and in production the natural implementation (proposed-value columns on the applications table)
puts unconfirmed AI output into a row that the decision engine, the portal screens, Zapier rules
and the Snowflake ETL all read. Proposals are now rows in a sidecar table (`application_id`,
`field_key`, `proposed_value`, `source {kind: message | box | formula, ref}`, `state: proposed |
confirmed | edited | rejected | superseded`, versions, audit event id, who confirmed and when). One
`ProposedValue` envelope serves both features. The only write path is a small set of named backend
commands (`proposeFieldValue`, `confirmValue`, `editValue`, `rejectValue`, `raiseDiscrepancy`,
`resolveDiscrepancy`, `submitApplication`) that enforce state and emit audit events; the three
views are read-only clients of the API. A contractor-typed value is never overwritten by a
proposal; a conflicting later statement becomes a proposed change shown as old to new. Submit is
disabled while proposals are pending, with a count, which is where the rule becomes visible.
Confirmed values reach the application only through the existing write paths (form submit for the
copilot, manual-review confirmation for extraction), so the application schema and all its
consumers are untouched, Snowflake picks up one new table, and rollback of a bad prompt version is
"stop writing proposals, enumerate affected applications from the proposals table".

### 3. Discrepancies and the review loop

**Rule 3 was circular.** It routed income discrepancies "to the document reviewer", but the
reviewer is the person who finds them. The reviewers' proposal: income discrepancies go to the
contractor with a templated question to relay to the homeowner, because the contractor is the only
party the portal reaches; estimate and scope discrepancies go to the contractor directly. Routing
target and tolerance become properties of the field in the document schema, not a switch on
document type. **Decided:** adopted. The reviewer raises the discrepancy and sends the templated
question; the contractor receives it and relays it to the homeowner; the answer comes back through
the contractor and the reviewer resolves the record.

**No tolerance meant every pay stub flags.** $84,760 annualized against $85,000 stated is a
discrepancy under exact match, every application enters "needs clarification", and feature 2
becomes slower than today. The prototype ships two rules: annualized income outside plus or minus
10% or $5,000, whichever is larger; requested loan amount more than 5% above the project estimate
total (less is a down payment). Annualization uses the extracted pay frequency; if the frequency is
not located, the system does not annualize and raises "pay frequency not located" instead. The
per-field tolerance table is described as v2, owned by Compliance and Credit Ops, versioned.

**"Needs clarification" is derived, never stored.** The demo uploads three documents, so two
discrepancies can be open at once; a stored application-level state has no transition for the
second and no safe exit, and a new value in the applications status enum breaks portal screens,
the decision-engine trigger, Zapier rules and the Snowflake funnel stages. Discrepancies are
per-value records (field, stated value with pointer, extracted value with pointer, rule id and
tolerance version, difference, routing target, status, resolver, note, review task id). The
application's banner is derived from open records; the application stays in the existing
"documents under review" status, which already blocks the decision engine. The clarification
question is a code template per reason code, never model text, because a model-written question
("the income shown appears insufficient") is the easiest implied-decision leak in the concept. The
reviewer edits the template before sending and never sees a verdict word in the UI. The comparison
runs when the reviewer confirms the extracted value, against a confirmed stated value; if the
stated value is still an unconfirmed copilot proposal, the discrepancy waits. Review tasks are per
application, not per document.

**"Source not located" was a dead end.** If a failed match meant the value cannot be confirmed at
all, every failed match would force the reviewer to flag a value that may be correct, with nothing
showing what the model read. Now the reviewer sees the model's quoted text and claimed page with a
caption ("The value was extracted but its position could not be matched. Find it on the page to
confirm, correct it, or flag it."), may confirm with a required acknowledgement recorded as
`located_by_reviewer`, distinct from box-confirmed, and may correct or flag as usual. One value in
the sample set is deliberately not locatable and is named in the README walkthrough.

**The review loop is defined.** One task per application with a tab per document; values on the
left grouped by schema field, the page on the right; selecting a value highlights its box and
clicking a box selects its value. Confirm keeps the value as extracted; Correct is an inline edit
with the box kept as "read from here"; Flag takes a reason from a fixed list (illegible, source not
located, mismatch with stated, wrong document type, missing, other) plus an optional note. There is
no confirm-all on the reviewer side, and the design says why the contractor side has one.
"Complete review" is enabled only when every value has a state. Each `review.decision` event
carries field, document type, proposed and final value, action, reviewer, time since task creation
and reason code; those events are the labeled extraction dataset.

**The hand-off is specified.** In production the SQS message that creates today's Jira Service
Management issue also feeds an extraction consumer (a separate ECS task on the same queue). The
consumer writes extraction tasks and proposals and updates the existing issue with a link to the
review UI and the label `ai-prefilled`. If extraction fails or exceeds 60 seconds, the issue is
created unchanged with the label `ai-unavailable` and the reviewer reads manually as today. The
idempotency key is document id plus schema version plus prompt version, because SQS is
at-least-once. Extraction output is a strict JSON schema validated in code; one retry on validation
failure, then the dead-letter queue, which becomes a manual-extraction task (today's path, already
staffed). JSM stays the queue of record. Confirmed income is written with the provenance manual
review already uses, so the decision engine sees nothing new. Plaid comes first; documents are
for when the Plaid connect step is abandoned, which is the drop-off. In the prototype, the queue is
in-app and a mock JSM client's calls (create issue, add link, transition) are written to the audit
log so the integration is visible.

**Schemas are declarative.** Each document type is one schema (fields with id, label, type,
description for the model, the stated field it compares to, tolerance, route, derived fields with
formula and inputs). The extraction prompt, output validation, reviewer panel and discrepancy rules
are derived from it, so a fourth document type (bank statement, W-2) is a schema file, a sample and
an eval set. The prompt first confirms the document matches its slot and returns "document type
mismatch" rather than values when it does not.

### 4. The guardrail as written would block the product it exists to explain

**The deny-list matched its own disclosure template.** "approved" matches "subject to credit
approval", "free" matches "feel free to ask", and "no interest" appears in every honest 0% promo
explanation; a regex cannot see "without the promo caveat". The deny-list now holds only
unambiguous verdict and approval terms (approved, pre-approved, guaranteed, qualify, eligible) as
word-boundary patterns with an explicit allow-list of phrases, applied to model-written spans only,
never to template text or catalog descriptions. It is a versioned JSON file owned by Compliance,
not code. The judge handles marketing nuance and promo caveats on prose only; the guardrail has no
meaning for structured extraction output. Both are implementations of one contract,
`check(text, surface) -> Verdict`; either block is final; a disagreement is logged as a tuning
signal. The asymmetry is explicit: a false positive is bounded (regenerate once, then a template
fallback), a false negative is unbounded (the deny-list is the floor the judge cannot lower).
Tests: about ten must-block strings and about five must-pass strings that include the rendered
disclosure block and a 0% promo explanation. The design specifies a pre-launch eval of at least
100 labeled outputs with judge recall of at least 0.95 and a false-positive rate of at most 5% as
launch gates, and shadow-mode logging of both verdicts in production.

**Trip behavior and the refusal were unspecified.** On a trip, the copilot regenerates once with
the verdict's reason fed back; if it trips again, it shows a fixed, Compliance-owned fallback that
still answers what can be answered (the options table renders regardless), with a quiet marker
under the reply ("Wording adjusted to comply with lending rules. View in audit") linking to the
entry that shows draft, verdict and final. Both attempts are retained; blocked text is the eval
dataset. A judge that is unavailable fails closed with its own outcome code, distinguishable from a
block. An out-of-scope question ("will they be approved?") gets a fixed reply shape enforced by the
prompt and checked by a test: one sentence that approval decisions are made by GoodLeap's credit
team after submission, then two things the copilot can do now. The exact fallback and refusal
texts are printed in the design document.

**Numbers in prose.** The model refers to options by label and never writes a dollar amount, rate
or term that is not verbatim from the tool result. A deterministic check extracts every currency
and percent token from the prose and matches each to a formatted calculator value; a mismatch
regenerates once, then falls back to the template-only view with no prose. This verdict is logged
beside the other two.

**Degradation.** Fail closed on model prose, fail open on deterministic parts. When the model is
down, the homeowner view still renders with correct numbers and disclosures and a per-product
canned sentence owned by Compliance in place of the explanation; extraction degrades to "queued,
awaiting extraction" with manual extraction available. Model ids are pinned per use case
(copilot, extraction, judge) in one config and stamped on every event. The SDK has one import
site, so switching the judge to OpenAI (already in GoodLeap's stack) for decorrelation or
availability is a one-module change; no multi-provider abstraction is built until a second provider
is in use.

### 5. Copilot mechanics

**"Only from what the contractor said" is now a mechanism.** The `propose_field_fill` tool returns
field, value, message id and verbatim quote; the backend verifies the normalized quote is contained
in that message or drops the proposal and logs it. This is the same quote-verification primitive
as document provenance: one mechanism across both features. The fillable list is fixed and derived
from the single application field schema through a `copilotFillable` flag: project type,
description, project amount, requested loan amount, preferred term, selected product, homeowner
first and last name, property zip. Income, employer, employment status, SSN, date of birth and
anything the decision engine consumes are excluded by name and enter only through the form or
document review. The tool schema is generated from the fillable subset at startup, so a form change
cannot leave the prompt stale. The system prompt proposes only from declarative statements and asks
on conditionals ("Use $40,000 as the requested amount?").

**The calculator's inputs are model-chosen tool arguments**, and a wrong input yields a precise,
compliant-looking, wrong payment. The calculator echoes its inputs on the view and in chat ("$30,000
over 120 months, product X at 7.99% APR"), takes amount and term from confirmed form fields when
they exist, and labels any result computed from an unconfirmed argument.

**Latency has a budget.** The payment path is three sequential model calls plus typing. The design
states: calculator and catalog under 100 ms; numbers and the disclosure block on screen within
about 3 seconds of the question being understood; model explanation plus judge under about 10
seconds p95; 30 seconds end to end including typing. Rendering is staged: the calculator result
and the templated disclosures depend on no model text and need no judge, so they render the moment
the tool call returns; only the prose waits behind the judge. A "Show payment options" button
calls the calculator directly with no model in the loop, so the promise holds during an outage.
Suggested one-tap prompts seed the panel; a stepwise status line mirrors the pipeline. The judge
runs on Haiku 5.5 with a classification-only prompt; prompt caching covers the fixed
prefix (rules, catalog, tool schemas).

**Context window.** Confirmed and pending fields live as structured state outside the transcript
and are fed into the system prompt every turn, so the form is the structured memory and nothing
confirmed is lost to truncation. The transcript store is the source of truth and assigns message
ids; the model's context is a derived window of the last ten or so turns; source pointers resolve
against the store so they never dangle; a `context.compacted` event records what was dropped.
Documents are extracted whole up to a page cap of about 20, page-batched above it. No retrieval in
v1: three products fit in the system prompt. Retrieval becomes necessary when product terms,
promo fine print and state-specific disclosure variants exceed the budget; a small embeddings
index on the existing RDS Postgres (pgvector) over catalog documents is the v2 step.

**Promo mechanics are the coupling point.** A mechanic change touches the catalog (lending ops),
the calculator (engineering), the disclosure wording and schedule rows (Compliance) and the
explanation (AI team). Products are described by mechanic type plus parameters (closed set:
fixed, zero_intro, deferred_interest) with the mechanic's explicit rules and plain description in
the catalog row and passed to the model. The calculator keys on mechanic type, never on product id.
TILA figures come from the same amortization function as the payment options. Deferred interest is
defined explicitly: interest accrues from the purchase date and is waived only if the balance is
paid in full by the promo end date; otherwise all accrued interest is added. The catalog holds
three products. The design carries a six-row ownership table: change surface, owner, what a change
touches, where it is versioned.

### 6. The homeowner view

**It is a physical and privacy boundary.** "A screen the contractor turns toward the homeowner"
means the tablet physically rotates and the homeowner sees whatever is on it. A card inside the
contractor layout would show the chat, the form with their own stated income, and field-state
badges. The homeowner view is a full-screen route with no contractor chrome, large type for arm's
length, and a small "Back to application" control where the contractor reaches. It shows two or
three options side by side ordered by term, none pre-selected, none labeled "recommended", each
with payment, term, APR and a one-sentence promo mechanic in plain words, and a "What happens next"
line: nothing is decided today, the application goes to GoodLeap for review, final terms come in
writing before signing. The model's explanation is the only free text on it, the highest-risk text
in the system, and the one place the judge is strict about pressure language ("great deal", "lock
in", "today only"). Wherever the chat shows payment numbers it offers "Show homeowner view", so the
natural move is to turn the screen with disclosures rather than read numbers aloud without them.

**Disclosures are a table, not a paragraph.** The TILA elements render as the standard four-cell
box per option (APR, finance charge, amount financed, total of payments) with the payment schedule
as one line beneath, beside the monthly payment without scrolling. "This is a payment estimate,
not an offer of credit; final terms depend on credit approval" sits directly under the payment
figure in body type. RESPA is one conditional line ("If this loan is secured by your home, a
settlement cost statement will be provided"), with applicability marked as Compliance's decision.
"Project estimate" (the document) and "payment estimate" (the view) are distinct terms everywhere.
The "Compliance owns final wording" note lives in the template file header, never on screen. One
test asserts the rendered block contains every element.

**Borrower-facing is a declared surface, not a component.** A surfaces table (`homeowner_view`:
borrower-facing, disclosure required, guardrail on; `contractor_chat`: not borrower-facing,
guardrail on) drives both the guardrail's surface argument and template attachment, and a
`BorrowerFacingMessage` type with a required disclosure block means a borrower-facing render
without the template does not compile. Because a grader may read "every borrower-facing
communication" to include chat replies the contractor reads aloud, any chat reply containing a
payment figure carries a one-line compact footer ("Estimate only. APR x%. Not an offer of credit;
subject to credit approval."). This revises rule 2.

### 7. The provenance method

Quote matching had four unnamed failure modes: OCR noise on exactly the tokens that matter
("$4,25O.OO"), repeated values (the same figure in Current and YTD columns), pdf.js returning text
in content-stream order so table cells break a line-level quote, and quotes without a page index.
The two location paths also produce boxes in different coordinate systems (PDF points with a
bottom-left origin versus image pixels with a top-left origin), so without normalization one of
the two sample documents would have boxes in the wrong place, which misleads more than no boxes.

The method is now: one `PositionedText` representation (page; words in reading order; each with
text, a box stored as page-relative fractions with a top-left origin regardless of source, and
confidence). Every source (pdf.js, the committed OCR file, Textract later) is an adapter producing
it, and the matcher sees only that shape. The model selects rather than generates: positioned text
is fed as indexed lines grouped by vertical position ("p1 L07: Gross Pay | 4,250.00 | 51,000.00")
and the structured output returns page, line, token span and quoted text; the backend verifies the
quote against the referenced span. When the span is absent, a fallback window match runs over
normalized tokens (lowercase, currency and thousands separators dropped, O/0 and l/1 folded,
hyphenated line breaks joined) with numeric tokens required to match exactly, accepting a window at
mean score 0.85 or above spanning at most two lines. A quote whose normalized text does not contain
the value is rejected as a hallucinated pointer. Monetary fields require a row label or column
header as an anchor. The match method (exact, normalized, fuzzy) and score are stored on the
proposed value, and an "approximate location" box style sits between "located" and "source not
located". Derived values show a formula string and the ids of their input proposals. The known gap
is stated: an OCR error inside the value yields a wrong but located value, which is what the
reviewer is for.

The justification is reworded. The old line ("vision models return text, not coordinates") is
stale; several current models return boxes with uneven reliability. The argument is that
model-returned coordinates are unverifiable and carry no provenance, while positioned text from the
document plus quote verification gives exact boxes and a testable failure mode. Textract is the
production choice because it is already on AWS, returns word geometry for PDFs and images, and its
output is a data artifact rather than a model claim. If boxes are cut from the prototype, the
alternative is Anthropic document citations on text PDFs (value, cited text, page), verified by
string match.

### 8. Operability, rollout and the grader's first five minutes

**Stack defaults, adopted rather than chosen.** One repository, one `package.json`, `web/` (Vite,
React, TypeScript) and `server/` (Express, TypeScript run with tsx), `npm run dev` runs both, the
API and the static frontend served from one process, pinned Node version. Anthropic SDK with tool
use for the copilot (tools: `get_products`, `calculate_payment`, `propose_field_fill`,
`request_homeowner_view`, a signal only; the server composes the view) and one
JSON-schema-constrained extraction call per document validated with zod. Sonnet 5.5 for the
copilot, Opus 5.5 for extraction, Haiku 5.5 for the judge, each pinned by its exact published id.
react-pdf for the viewer with boxes as positioned elements scaled by the rendered viewport;
pdfjs-dist text content server-side for text PDFs. vitest. No database, no Docker, no Next.js, no
native modules. In-memory state seeded from a committed seed file; every mutation appends to an
audit JSONL file; a reset endpoint restores the seed; the run command does not use watch mode.

**The first five minutes.** A README section "Demo in 5 minutes" with the exact commands and a
numbered walkthrough naming the text to type at each step, including the one adversarial message
that trips the guardrail visibly and the out-of-scope question. A "Load demo project" action fills
a project and attaches the three bundled sample documents, so the grader never opens a file
picker. Without a key, the app starts, shows a persistent banner naming the variable and the file,
disables chat input with the same message, and leaves the calculator, form, reviewer and audit
views working; extraction without a key offers a committed extraction fixture so the review path
still demos. Rate limits, timeouts and server errors render as an assistant-styled message with the
cause in plain words, a Retry button and a note that payment options are computed locally.
Malformed structured output falls back to "I couldn't produce field suggestions for that; the
explanation is below." The error taxonomy is an enum with a stated behavior per code. A health
endpoint reports key presence and mock status. A top bar with three role tabs and a "You are: ..."
caption.

**Rollout has flags and gates.** `copilot.enabled` per contractor (from the contractor profile
service) and `extraction.enabled` globally with a document-type allowlist. Phase 1: about 20
contractors in one region and 2 reviewers, 2 weeks. Phase 2: 10% of contractors, 4 weeks. Phase 3:
default on. Kill is a flag flip; the existing form and the existing JSM ticket are the fallback.
No prompt, deny-list, template, catalog or model version advances a phase unless its eval gate
passes. The per-contractor allowlist doubles as the impact evaluation's control group: completion
time and abandonment at the product-selection step, flag on versus off, from the existing
Snowflake funnel. In-flight applications at rollout stay manual: the consumer processes only
messages flagged by the upload handler when the flag is on. In the prototype, two environment
variables are the kill switches.

**Mocks are typed seams.** Each external system is a TypeScript interface with one in-process mock
and a comment naming the real endpoint and auth; one composition root selects implementations; no
mock HTTP servers. The credit engine and Plaid get typed stubs with a one-line comment naming where
they would be called; the decision engine interface has no method any UI code calls, and its only
consumer is `submitApplication`, which records "submitted" and nothing else. Every mock response
carries a `_mock` envelope; the audit view renders a MOCK badge on those rows and a LIVE badge with
request id, model id, tokens and latency on model calls, and shows a credit-engine call count that
reads zero.

**The audit view is a view, not a record.** The intended view, described in the design document,
is organized application first, then homeowner views shown, then the provenance chain, with the
per-turn list secondary; raw JSON behind an expander; a "borrower-facing only" filter; the
homeowner view re-rendered from its stored inputs exactly as shown, which is free if the view is a
pure function of its props. **Decided:** the prototype ships the collapsible-JSON page, one page
per application listing every event in order with a one-line summary and the raw record behind a
click, linked from the contractor view. The polish goes to the contractor and homeowner views where
design taste is graded. The homeowner view is still written as a pure function of its props so the
re-render is possible later.

**Terms.** The design document defines each term on first use in one clause and has no glossary.
One name for the person: "homeowner" everywhere, "borrower" only when quoting the regulation.
"Verdict word" means any word that states or implies whether the applicant will be approved, with
the deny-list as the enforced list. The full state vocabulary (field states, review states,
application states) lives in one supporting file. Every UI state label carries a one-line caption.
The README calls the scenario a "demo walkthrough".

### Where the reviewers disagreed, and how it is settled

| Question | Settled as |
| --- | --- |
| Build both features tonight? | Both designed in full; feature 1 built first, feature 2 at reduced depth, unfinished parts design-only (item 1) |
| Bounding boxes or citations? | Boxes, by the author's requirement; the model selects indexed spans so rule 5 holds. Citations are the fallback if boxes are cut. |
| Tolerance rules | Two rules in the prototype; per-field table described as v2 |
| Mocks | Typed interfaces with in-process mocks; typed stubs with a comment for the uncalled APIs; no HTTP servers |
| Audit view | Collapsible JSON page in the prototype; card-first timeline described in the design as the intended view |
| Document schemas | Three declarative schemas and one generic panel, because one generic panel is less work than three hand-written ones |

## Goals vs. Non-Goals

* **In-Scope Goals:**
  * A design document of 2 to 3 pages covering problem framing, architecture, AI design decisions,
    compliance and safety, rollout, and monitoring, with described-only items marked. Three short
    supporting files under `docs/`: the audit event schema, the eval specification, and the state
    vocabulary. Schemas, templates and eval cases live in code.
  * A prototype that runs locally in under 5 minutes with one LLM key, with a README walkthrough
    through the copilot (load the demo project, ask for payment options, see the homeowner view,
    confirm proposed fields, submit) and, if built, through document review (open the task, see
    the boxes and the one not-located value, confirm or flag, see one discrepancy with its
    templated question).
  * The guardrail: a versioned deny-list of verdict terms with an allow-list, a Haiku 5.5 judge
    for nuance and pressure language, and a deterministic number-match check, all under one
    contract with logged verdicts, regenerate-once-then-fallback behavior, a visible marker, and a
    fixed out-of-scope reply. Tests: must-block and must-pass strings including the rendered
    disclosure block.
  * The homeowner view as a full-screen route with the TILA four-cell box per option, the estimate
    statement under the payment figure, the conditional RESPA line, neutral option order and the
    "what happens next" line. A compact footer on chat replies that contain a payment figure.
  * The append-only audit event stream with correlation ids, typed events, a versions block on
    every event, token counts from every API response, and an audit page (events in order, one
    line each, raw record behind a click).
  * The sidecar proposals store, the named backend commands as the only write path, and the
    submit gate.
  * The deterministic calculator keyed on mechanic type, with five golden cases exact to the cent,
    and the disclosure template with a render test.
  * The quote-verified `propose_field_fill` tool over a fixed fillable list derived from the
    application field schema.
  * If feature 2 is built: committed positioned text for the three samples, the `PositionedText`
    adapters and matcher with fraction coordinates, declarative schemas, the generic reviewer
    panel, per-value discrepancy records with derived status and one templated question.
  * Eval requirements fully specified with datasets, metrics, thresholds and gates; calculator and
    deny-list tests built tonight; a small `npm run eval` fixture if time remains.
  * A README with install and run steps, environment variables, the architecture, the demo
    walkthrough and the kill switches; an AI usage note; deployment on the existing stack folded
    into the architecture section.
* **Out-of-Scope Non-Goals:**
  * Rendering any credit decision. The demo ends at "submitted, documents under review."
  * The copilot collecting the whole application through conversation. The form stays primary.
  * The copilot proposing income, employer, employment status, SSN, date of birth or any field the
    decision engine consumes.
  * The contractor reviewing or correcting extraction results. Review is internal.
  * Upload through the chat. Form upload only; chat upload gets one sentence in the design.
  * Voice input or output.
  * OCR at runtime. Positioned text for the image sample is computed once and committed.
  * Real integrations: Plaid, the decision engine, Jira Service Management, Zapier, Snowflake,
    Microsoft 365. All are mocked behind typed interfaces or described in the design document.
  * Zapier in the critical path of the review hand-off. The backend creates the review task
    directly; Zapier or Teams may carry notifications only.
  * Authentication, multi-tenancy, a database, Docker, persistence beyond the demo session.
  * Fine-tuning, retrieval or embeddings in v1. Prompt engineering with tool calls and structured
    output; pgvector named as the v2 step.
  * A multi-provider abstraction before a second provider is in use.
  * A hosted deployment. Local run is the requirement.

## Alternatives Weighed

| Alternative | Why rejected |
| --- | --- |
| One angle only: on-site quote and product explanation | Covers the money and the contractor's own words but leaves income verification and manual review untouched. Chosen as the deep path of feature 1. Whether extraction is built or designed tonight is decision 1. |
| Document extraction only | Internal staff tool. No conversation to grade, disclosures do not apply, and extracted income next to a loan amount is one step from an implied credit decision. Kept as feature 2 under human review. |
| Full conversational application (the copilot collects every field) | The speedup would come from redesigning the form, not from the model; needs the whole application mocked; the easiest way to boil the ocean. |
| The model computes payments | Arithmetic by a language model is a hallucination risk with a dollar sign on it. A deterministic calculator does it; the model explains by option label. |
| The model returns bounding boxes | Model-returned coordinates are unverifiable and carry no provenance. Positioned text plus quote verification gives exact boxes and a testable failure mode. |
| Anthropic document citations instead of boxes | Cheaper and no coordinate work, but the author requires boxes on the original page for both PDF kinds. Kept as the fallback if boxes are cut. |
| OCR at runtime with tesseract.js | About 15 MB on first run, 10 to 30 seconds per page, non-deterministic, threatens the 5-minute rule. Positioned text is computed once and committed; Textract is the production path. |
| Zapier carries the review hand-off into Jira | The audit trail would span three systems. The backend creates the task; Zapier may notify. |
| "Needs clarification" as a new application status | A new enum value breaks portal screens, the decision-engine trigger, Zapier rules and Snowflake funnel stages, and two open discrepancies have no transition. Derived from per-value records instead. |
| Model-written clarification questions | The easiest implied-decision leak in the concept. Templates per reason code. |
| Exact-match discrepancy detection | Every pay stub would flag. Two tolerance rules in the prototype; per-field table in v2. |
| A broad deny-list ("approved", "free", "no interest") | Matches the disclosure template and every honest promo explanation. Narrowed to verdict terms with an allow-list; the judge handles nuance. |
| The model writes the disclosures | Disclosure text must be exact and owned by Compliance. A template, attached by code, as a table. |
| The homeowner card as a panel inside the contractor layout | The tablet rotates; the homeowner would see the chat and their own stated income. A full-screen route. |
| Proposed-value columns on the applications table | Puts unconfirmed AI output into a row the decision engine, Zapier and Snowflake read. A sidecar table with named commands. |
| The contractor reviews extraction on their screen | Puts internal verification data on a borrower-adjacent surface. Review stays with staff. |
| Render the mocked decision engine's answer | Any rendering invites "the AI said" wording. Ending at "submitted" keeps the hardest rule trivially satisfied. |
| Mock HTTP servers per financial service | Cost with no rubric credit. In-process mocks behind typed interfaces with a composition root. |
| CLI chat instead of a web UI | The rubric grades whether it feels good to use and whether disclosures are woven in; a CLI cannot show a homeowner view or a document with boxes. |
| Next.js | Server rendering and pdf.js do not mix under time pressure. Vite plus Express. |
| Third-party eval framework in the prototype | Hand-rolled tests are explainable line by line and cheaper tonight; promptfoo or Braintrust named for production. |
| Three hand-written extraction pipelines | A fourth document type would be a five-file change across four owners. One declarative schema per type drives prompt, validation, panel and rules. |
| Retrieval over the catalog in v1 | Three products fit in the system prompt. pgvector over catalog documents when terms and state variants outgrow it. |
| Hybrid with a slice of extraction inside the copilot | Two shallow halves instead of two deep paths. |

## Key Decisions & Staging for Next Steps

**Rules carried into the design**

1. Every AI-written value (a form field from the conversation, a field from a document) is a
   proposal in a sidecar store with a source pointer (message quote, page box or formula), a state
   and an audit event. Named backend commands are the only write path. Submit is blocked while
   proposals are pending. Confirmed values reach the application only through the existing write
   paths. The copilot proposes only from a verbatim quote that the backend verifies against the
   contractor's message, and only for fields on the fixed fillable list.
2. Borrower-facing is a declared surface. The homeowner view is borrower-facing and carries the
   disclosure template; a borrower-facing render without the template does not compile. Contractor
   chat is not borrower-facing but passes the same guardrail, and any chat reply with a payment
   figure carries a one-line estimate footer.
3. Income discrepancies go to the contractor with a templated question to relay to the homeowner;
   estimate and scope discrepancies go to the contractor directly. The reviewer raises and
   resolves the record. Routing and tolerance are properties of the schema field. The state is
   derived from open per-value discrepancy records, never stored, and never a verdict word.
4. The model never produces a number used in a payment or a disclosure, and never restates one in
   prose. Deterministic code computes; a deterministic check enforces.
5. The model never produces coordinates. It selects an indexed span of positioned text and quotes
   it; the backend verifies the quote and draws the box from the document's own word positions.
6. No credit decision is rendered anywhere in the prototype.
7. The pay stub sample is an image PDF with its positioned text computed once and committed; the
   estimate and scope letter samples are text PDFs read by pdf.js. Both adapters produce the same
   representation with fraction coordinates.
8. Provider: Anthropic, one import site, exact published model ids pinned per use case (Sonnet 5.5
   copilot, Opus 5.5 extraction, Haiku 5.5 judge), never an alias. Reviewers supply
   their own key in `.env`; `.env.example` is committed; without a key the app starts and says so.
9. The deny-list holds verdict terms only, is versioned JSON owned by Compliance, and is the floor
   the judge cannot lower. A trip regenerates once, then falls back to Compliance-owned text with
   a visible marker. The judge fails closed with its own outcome code.
10. Payment options and disclosures render before and independently of model prose. Numbers on
    screen within about 3 seconds; prose plus judge under about 10 seconds p95.
11. Products are described by mechanic type; the calculator keys on mechanic; the catalog has
    three products; deferred interest is defined explicitly.
12. Evals are specified in full; the calculator golden cases and the deny-list tests are built
    tonight; nothing else is cut to pay for feature 2.
13. Stack: Vite, React, TypeScript, Express, tsx, zod, vitest, react-pdf, pdfjs-dist, Anthropic
    SDK. No database, Docker, Next.js or native modules.

**Assumptions to state in the design document**

* The loan product catalog is invented: three products covering a standard fixed-rate term, a 0%
  introductory period, and a deferred-interest promotion, with explicit mechanics.
* TILA elements for a closed-end consumer loan apply to the homeowner view as a payment estimate,
  not an offer. RESPA applies only where the loan is secured by the home; one conditional line,
  applicability a Compliance decision. Placeholder wording throughout; Compliance owns final text.
* Document review today runs through Jira Service Management fed by SQS; the design adds an
  extraction consumer on the same queue and the prototype uses an in-app queue with a mock JSM
  client whose calls are logged.
* Plaid is the first income source; documents are for the abandoned-Plaid case.
* Volume: about 100K to 150K started applications a year, derived from $2B at a $25K to $30K
  average loan. Labeled an assumption.
* Synthetic documents only. No real PII. The pay stub sample has no SSN and the schema never
  requests one. A fixed demo contractor id and reviewer id stand in for login.
* Tolerance defaults are placeholders owned by Compliance and Credit Ops.

**Decided before the design draft**

1. **Scope tonight.** Both features designed in full. Build feature 1 and the shared floor first,
   then feature 2 at reduced depth; whatever is unfinished when the build stops ships as
   design-only.
2. **Income discrepancy routing.** To the contractor, with a templated question to relay to the
   homeowner. Estimate and scope questions to the contractor directly.

3. **Audit view depth.** The collapsible JSON page in the prototype; the card-first timeline
   described in the design document as the intended view. Polish goes to the contractor and
   homeowner views.

**Resolved open items** (from the first draft of this brief)

| Item | Resolution |
| --- | --- |
| Tolerance rule for "disagrees" | Two rules in the prototype (income plus or minus 10% or $5,000; requested amount more than 5% above the project estimate); per-field table as v2 |
| OCR path in the prototype | Precomputed and committed; runtime OCR described only; Textract in production |
| How much of the form the copilot can fill | Fixed list from the application schema via a `copilotFillable` flag; excluded fields named |
| Context window strategy | Form state as structured memory; transcript store as source of truth with a derived window; page cap and batching for documents; no retrieval in v1 |
| Eval datasets and size | Calculator golden cases and deny-list tests tonight; 15-case fixture if time; judge (10 prompts, 8 flagged), extraction (3 samples, 90% field match on text PDFs, 80% located on the image), fill (3 scripted conversations) specified with gates |

**Build order** (from the reviewers' consensus)

1. Record decision 1. Design document skeleton with six sections and described-only items marked.
2. Stack skeleton; audit event stream with the event union and versions block; commands and the
   sidecar proposals store; service interfaces with mocks and the `_mock` envelope.
3. Catalog with mechanic rows; calculator with golden tests; disclosure template with its render
   test.
4. Copilot: four tools, quote-verified field proposals, staged rendering and the direct "Show
   payment options" button, deny-list and judge with trip behavior, fallback and refusal text,
   number-match check, full-screen homeowner view, chat footer.
5. README walkthrough, missing-key banner, in-chat retry, role tabs, "Load demo project", kill
   switches.
6. If feature 2 is built: sample documents and committed positioned text; adapters and matcher;
   declarative schemas and the generic reviewer panel; discrepancy records, derived status and the
   templated question; the not-located value.
7. Audit JSON page; eval fixture; AI usage note; final design document pass with the ownership
   table.

**Logistics**

* Repository host: GitLab (`labs.gauntletai.com`), the existing remote. A GitHub mirror only if
  the portal requires one. Settled; not to be raised again.
* Visibility of the submission repository given the Confidential marking on the take-home PDF:
  parked for the recruiter.
