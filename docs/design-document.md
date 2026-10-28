# GoodLeap Loan Assistant: Solution Design

**Author:** Andre Batista · **Date:** 2026-10-28 · **Detail:** [internal design](designs/loan-assistant-design.md) (data model, data flows, 37 alternatives, file-by-file plan), [concept brief](designs/loan-assistant-concept.md), [PRD](PRD.md)

## 1. Problem framing and approach

Contractors submit home improvement loan applications from a homeowner's kitchen, on a tablet, through a React partner portal. Applications take 22 minutes against a benchmark under 10 and 38% are abandoned, mostly at product selection and income verification; staff read uploaded pay stubs, estimates and scope letters by hand. Ten percent more closed deals is worth about $200M a year of origination.

The highest-leverage problem is the one in the contractor's own words: "I need to tell them in 30 seconds what their monthly payment would look like." A contractor who cannot explain a fixed loan against a 0% introductory period or deferred interest loses the deal at product selection, and a homeowner deciding on $30K with a salesperson present needs plain terms and the required disclosures without pressure. One assistant therefore acts at the two named failure points, on one shared base:

* **An application copilot** beside the existing form. It explains products and promotional terms in plain language, produces payment options through a deterministic calculator (the model never computes a payment figure), proposes form field values only from what the contractor explicitly said (verbatim quote, verified by the backend, confirmed by the contractor), and renders a full-screen **homeowner view**: options side by side with a code-templated TILA/RESPA disclosure block, which the contractor turns toward the homeowner.
* **Document extraction with human review.** Uploaded pay stubs, estimates and scope letters become proposed values, each pointing at the words on the page it came from, drawn as a box on the original. An internal reviewer confirms, corrects or flags every value; nothing enters the application until a person confirms it. A value outside tolerance for the stated one opens a discrepancy record with a templated question to the contractor. The system never says "insufficient" or "qualifies".

Rejected: extraction only (no contractor or homeowner surface), a whole-application copilot (the speedup would come from the form, not the model), and the model computing payments or writing disclosures (unverifiable figures; Compliance owns the text).

## 2. Proposed architecture

The assistant adds four screens to the portal (copilot panel, homeowner view, reviewer view, audit view), one route group to the TypeScript/Node backend on ECS, one SQS consumer, four RDS tables (proposals, discrepancies, review tasks, audit events) and one S3 prefix. It changes nothing in the applications table, the credit decision engine's inputs, Plaid, or the Jira Service Management queue of record.

**Copilot turn.** The context is a cached prefix (rules, the catalog with one plain sentence per promotional mechanic, disclosure facts), then the form state and the last 10 turns. Claude Sonnet 5.5 is called with two strict tools: `calculate_payment` (amount and term from the form when present, else from the arguments, which are then labeled and echoed) and `propose_field_fill` (field, value, message id, verbatim quote). The moment the calculator returns, the options table, echoed inputs and a compact estimate footer render; the explanation follows after the guardrail, so numbers never wait for prose. From server receipt: options in 3 s, explanation in 10 s p95; 30 s for the exchange from the first keystroke. A no-model "Show payment options" button is the bound during an outage.

**Extraction.** On submit, the consumer turns each document into positioned text (pdf.js for text PDFs; a committed OCR file for the image pay stub; AWS Textract in production through the same adapter shape) and sends Claude Opus 5.5 the indexed lines with a schema per document type. The model selects a line and token span per field and quotes it; the backend verifies the quote and draws the box from the document's own word positions. A quote matching words without geometry, or nothing, is "not located" and still gets a reviewer row. Annualized income is computed by the review path once its inputs are confirmed and compared to the stated value (outside ±10% or $5,000 flags; a requested amount more than 5% above the estimate flags).

**Models and cost.** Sonnet 5.5 for the copilot (latency-bound, guarded three ways), Opus 5.5 for extraction (background; selecting the right span among repeated values is the whole job), Haiku 5.5 as the judge (classification, about 1K tokens in, 50 out); exact ids pinned per use case and stamped on every audit event. About $0.02 per turn with caching, $0.03 per document, $0.30 per application, about $45K a year at 150K applications against a $200M case. Reviewer minutes, not LLM spend, are the constraint.

**Ownership.** Every artifact that shapes behavior (field schema, catalog, calculator, disclosure template, deny-list and judge prompt, document schemas) is a file versioned by content hash with one owning team, and any change is a version that must pass the eval gates.

## 3. AI design decisions

**Prompting, not fine-tuning.** The behaviors needed are instruction-following over a small fixed catalog; there is no labeled corpus, and every catalog or disclosure change would need re-tuning that a prompt handles as data.

**Context window.** The form is the structured memory, fed in every turn, so nothing confirmed is lost when old turns drop; the model sees a 10-turn window. No retrieval in v1 (three products fit in the prefix); a pgvector index over product terms and state-specific disclosure variants is the v2 step.

**Hallucination.** Every number comes from one amortization function keyed on promotional mechanic and every box from the document's word positions. A deterministic check rejects any currency, percent or term token in the prose that is not a calculator value for the turn or a figure the contractor typed, so "$312.47" cannot become "about $300" while "Use $40,000 as the requested amount?" passes. The explanation names options by label in the third person, so the same judged text reads correctly in the chat and on the homeowner view.

**Evaluation.** With no key, on every test run: five calculator golden cases exact to the cent; 10 must-block and 7 must-pass guardrail strings (including the rendered disclosure block and a 0% promo explanation); the disclosure render per product. Gating every version change: 15 recorded copilot conversations (expected tool calls, fills and non-fills, the out-of-scope question); the three sample documents against ground truth (90% field match on text PDFs, 80% located on the image PDF); a labeled judge set grown from 20 to at least 100 before pilot (recall at least 0.95, false positives at most 5%).

**Edge cases.** "Will she be approved?" gets a fixed reply from a prompt rule, checked by a test: *"Approval decisions are made by GoodLeap's credit team after the application is submitted, so I can't say whether this application will be approved."* followed by two offers, "Show payment options for this project" and "List what the application still needs". Every failure (missing or rejected key, rate limit, timeout, classifier refusal, invalid structured output, catalog mismatch, not-located value) has a code and a stated behavior: fail closed on model prose, fail open on deterministic parts, so the homeowner view always renders correct numbers and disclosures, with a canned sentence per product when the model is down.

## 4. Compliance and safety

**No implied credit decision.** Three checks run on every draft and any block is final: a versioned deny-list of verdict words (approved, pre-approved, guaranteed, qualify, eligible) with an allow-list for "subject to credit approval" and the fixed reply above; the number-match check; and a Haiku judge with one set of criteria (implied approval or likelihood, pressure or urgency, promo claims without the caveat, restated income). On a block the turn regenerates once with the reason; on a second block a Compliance-owned fallback appears: *"I can't phrase that in a way that meets lending rules. The payment options above are accurate and include the required disclosures. I can show them to the homeowner, explain how a promotional period works, or list what the application still needs."* with the marker "Wording adjusted to comply with lending rules. View in audit". A judge outage is a block. No code calls the credit decision engine, the audit page shows its call count as zero, and the walkthrough ends at `documents_under_review`. Discrepancy questions are templates per reason code, never model text.

**Disclosures by construction.** The homeowner view is the declared borrower-facing surface. It renders the TILA four-cell box per option (APR, finance charge, amount financed, total of payments), the payment schedule, "This is a payment estimate, not an offer of credit; final terms depend on credit approval" under each payment figure, and a conditional RESPA line, from a versioned code template; a borrower-facing render without the template does not compile. Chat replies with a payment figure carry "Estimates only. Not an offer of credit; subject to credit approval."

**Auditability.** Every interaction is an append-only event stream keyed by application id: contractor messages, model calls with raw input and output, tool calls, guardrail verdicts, proposals and confirmations, the homeowner view as shown, reviewer decisions and discrepancies, each with a versions block. "What did this homeowner see, and why" is a query; replaying the calculator and template from stored inputs reproduces the screen. Nothing AI-written enters the application unconfirmed: proposals live in a sidecar table, named backend commands are the only write path, submit is disabled while proposals are pending, and confirmed values reach the application only through the two write paths the portal already has (the form's own edits and submit; the manual-review confirmation).

## 5. Rollout plan

**MVP.** The copilot path (payment options, homeowner view, quote-verified proposals, guardrail, audit stream) ships in days once the catalog and contractor-profile mocks become real clients: it writes nothing to the applications table and the flag defaults off. Extraction follows as its own phase (consumer, Textract, JSM update).

| Phase | Who | Length | Gate to advance | Rollback |
| --- | --- | --- | --- | --- |
| 0 Internal | AI team, Compliance, two reviewers | 1 week | Eval sets pass; Compliance signs off on template, deny-list and fallback texts | Flags off |
| 1 Pilot | About 20 contractors in one region, 2 reviewers; extraction for pay stubs | 2 weeks | No guardrail false negative in sampled transcripts; fallback under 5% of turns; correction rate per field known | Flags off; existing form and JSM ticket remain |
| 2 Expansion | 10% of contractors; all document types | 4 weeks | Completion time and product-selection abandonment better flag-on than flag-off; queue time within SLA | Back to the pilot list |
| 3 Default on | All contractors, with opt-out | ongoing | Monthly metric review | Per contractor or global off |

**Change management.** An in-portal announcement at the product-selection step, a one-page guide, and the three suggested prompts in the panel as the onboarding device; support through the existing contractor queue; a 30-minute reviewer walkthrough. The pilot allowlist doubles as the control group. Rolling back a bad prompt version is a flag flip, with no data migration.

## 6. Monitoring and impact evaluation

Every metric is a query over audit events. Guardrail: block rate per check and prompt version; disagreement between checks in both directions (judge blocks what the list passed above 1%: add terms; the reverse above 2%: false-positive review); fallback above 5% and judge-unavailable above 0.5% alert. Copilot: latency p95 per step, cache read rate, proposal edit rate per field (above 20% alerts). Review: correct and flag rate per field, correction magnitude (above 10% on a money field is the extraction drift signal), not-located rate per adapter, queue time against the SLA. Invariants: catalog schema mismatches and credit-engine calls read zero.

**Drift** is read from the disagreement rate between checks, the reviewer correction rate, and the eval sets re-run on every version change; compliance failures are the blocks by category, reviewed weekly from retained drafts, which also grow the eval sets.

**Business impact**, from the existing Snowflake funnel with the pilot allowlist as control: completion time and abandonment at product selection, flag on versus off; contractor adoption (at least one copilot turn per week); time from submit to documents reviewed; reviewer minutes per application. The v1 to v2 loop: corrections and blocked drafts grow the eval sets, the monthly review picks the next prompt, deny-list and tolerance versions, and each advances only through the eval gates.

## Prototype: built versus described

Planned for the prototype (TypeScript, Node 22, React, one process, one Anthropic key): the copilot walkthrough, the homeowner view, quote-verified proposals, the three-check guardrail, the calculator and template with their tests, the audit stream and page, typed mocks, and extraction with boxes and review at reduced depth. Described only: the Textract adapter, the SQS consumer and JSM update, per-contractor flags, the audit timeline, the per-field tolerance table, retrieval, token streaming, a decorrelated judge, and the eval sets beyond the recorded copilot cases. The README states what ran; this section is updated after the build.
