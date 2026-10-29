# GoodLeap Loan Assistant: Solution Design

**Author:** Andre Batista · **Date:** 2026-10-28 · **Detail:** [internal design](designs/loan-assistant-design.md) (data model, data flows, 37 alternatives, file-by-file plan), [concept brief](designs/loan-assistant-concept.md), [PRD](PRD.md), [build log](build-log.md)

## 1. Problem framing and approach

Contractors submit home improvement loan applications from a homeowner's kitchen, on a tablet. Applications take 22 minutes against a benchmark under 10, and 38% are abandoned, mostly at product selection and income verification; staff read the uploaded documents by hand. Ten percent more closed deals is worth about $200M a year.

The highest-leverage problem is in the contractor's own words: "I need to tell them in 30 seconds what their monthly payment would look like." A contractor who cannot explain a fixed loan against a 0% period or deferred interest loses the deal there, and a homeowner deciding on $30K with a salesperson present needs plain terms and the required disclosures. One assistant acts at both failure points, on one shared base:

* **An application copilot** beside the existing form. It explains products and promotional terms in plain language, produces payment options through a deterministic calculator (the model never computes a figure), proposes form values only from what the contractor said (a verbatim quote, verified by the backend, confirmed by the contractor), and renders a full-screen **homeowner view**: options side by side with a code-templated TILA/RESPA disclosure block, which the contractor turns toward the homeowner.
* **Document extraction with human review.** Pay stubs, estimates and scope letters become proposed values, each pointing at the words on the page it came from, drawn as a box on the original. An internal reviewer confirms, corrects or flags every value; nothing enters the application until a person confirms it. A value more than 10% or $5,000 (whichever is larger) from the stated one opens a discrepancy record with a templated question to the contractor. The system never says "insufficient" or "qualifies".

Rejected: extraction alone (no effect on the 30-second quote), a copilot that collects the whole application (the speedup would come from the form), and the model computing payments or writing disclosures (unverifiable figures; Compliance owns the text). The internal design weighs 37 alternatives.

## 2. Proposed architecture

Four screens join the portal (copilot panel, homeowner view, reviewer view, audit view); one route group, one SQS consumer, four RDS tables (proposals, discrepancies, review tasks, audit events) and one S3 prefix join the TypeScript/Node backend. Nothing changes in the applications table, the credit decision engine's inputs, Plaid, or the Jira queue of record.

**Copilot turn.** The context is a cached prefix (rules, the catalog with one plain sentence per promotional mechanic, disclosure facts), then the form state and the last 10 turns. Claude Sonnet 5.5 is called with two strict tools, `calculate_payment` (inputs from the form, else from the model's arguments, which are then labeled) and `propose_field_fill`. The options table renders the moment the calculator returns; the explanation follows after the guardrail, so numbers never wait for prose (options in 3 s, explanation in 10 s p95). A no-model "Show payment options" button is the floor during an outage.

**Extraction.** On submit, the consumer turns each document into positioned text (pdf.js, a committed OCR file for the image pay stub, Textract in production behind the same adapter) and sends Claude Opus 5.5 the indexed lines with a schema per document type. The model selects a line and token span per field and quotes it; the backend verifies the quote and draws the box from the document's own word positions. A quote matching words without geometry, or nothing, is "not located" and still gets a reviewer row. Annualized income is computed by the review path from confirmed inputs and compared to the stated value (outside ±10% or $5,000 flags; a requested amount more than 5% above the estimate flags).

**Models and cost.** Sonnet 5.5 for the copilot (latency-bound, guarded three ways), Opus 5.5 for extraction (background; choosing the right span among repeated values is the whole job), Haiku 5.5 as the judge; ids pinned per use case and stamped on every audit event. About $0.02 per turn with caching, $0.03 per document, $0.30 per application, about $45K a year at 150K applications. Reviewer minutes, not LLM spend, are the constraint.

**Ownership.** Every artifact that shapes behavior (field schema, catalog, calculator, disclosure template, deny-list, judge prompt, document schemas) is a file versioned by content hash with one owning team; a change must pass the eval gates.

## 3. AI design decisions

**Prompting, not fine-tuning.** The behaviors are instruction-following over a small fixed catalog; there is no labeled corpus, and every catalog or disclosure change would need re-tuning that a prompt takes as data.

**Build versus buy.** One vendor (Anthropic's three model sizes through the official SDK, which also fronts OpenRouter), because every call shape used here was verified on it before the build and a second provider would add a client and an eval run for no gain at three products. Textract and Jira are bought; the calculator, template, deny-list and matcher are built because they must be exact and owned. A hosted eval harness (promptfoo or Braintrust) and embeddings arrive with retrieval in v2.

**Context window.** The form is the structured memory, fed in every turn, so nothing confirmed is lost when old turns drop; the model sees a 10-turn window. No retrieval in v1 (three products fit in the prefix).

**Hallucination.** Every number comes from one amortization function keyed on promotional mechanic, and every box from the document's word positions. A deterministic check rejects any currency, percent or term token in the prose that is not a calculator value for the turn or a figure the contractor typed, and, in a sentence that names exactly one option, binds each money figure to that option: "$312.47" cannot become "about $300", Option B's payment cannot be attributed to Option A, and "Use $40,000 as the requested amount?" passes. A proposal's quote must also support its value, so "$30K" cannot back a $40,000 proposal.

**Evaluation.** On every test run, without a key: five calculator golden cases exact to the cent, must-block and must-pass guardrail strings, the disclosure render per product, and the sample documents replayed from a recorded fixture. Gating every version change, with a key: 15 recorded copilot conversations (tool calls, fills and non-fills, the out-of-scope question), the live extraction run (90% field match on text PDFs, 80% located on the image PDF), and a labeled judge set grown from 20 to at least 100 before pilot (recall at least 0.95, false positives at most 5%).

**Edge cases.** "Will she be approved?" gets a fixed reply from a prompt rule, checked by a test (*"Approval decisions are made by GoodLeap's credit team after the application is submitted, so I can't say whether this application will be approved."*). Every failure, from a missing key to a not-located value, has a code and a stated behavior: fail closed on model prose, fail open on deterministic parts, so the homeowner view always renders correct numbers and disclosures, with a canned sentence per product when the model is down.

## 4. Compliance and safety

**No implied credit decision.** Three checks run on every draft and any block is final: a versioned deny-list of verdict words with an allow-list for "subject to credit approval" and the fixed reply; the number-match check; and a Haiku judge with one set of criteria (implied approval or likelihood, pressure or urgency, promo claims without the caveat, restated income). On a block the turn regenerates once with the reason; on a second block a Compliance-owned fallback appears, marked and linked to the audit page. A judge outage is a block. No code calls the credit decision engine, the audit page shows its call count as zero, and the application's last state is `documents_reviewed`: no state means a decision. Discrepancy questions are templates per reason code, never model text.

**Disclosures by construction.** The homeowner view is the declared borrower-facing surface. It renders the TILA four-cell box per option (the APR is the actuarial rate of the schedule shown), the payment schedule, "This is a payment estimate, not an offer of credit; final terms depend on credit approval" under each payment figure, and a conditional RESPA line, from a versioned code template; a borrower-facing render without the template does not compile, and the client formats no number itself. Chat replies with a payment figure carry "Estimates only. Not an offer of credit; subject to credit approval."

**Auditability.** Every interaction is an append-only event stream keyed by application id, from contractor messages and raw model calls to the homeowner view as shown and every reviewer decision, each with a versions block. "What did this homeowner see, and why" is a query, and replaying the calculator and template from stored inputs reproduces the screen. Nothing AI-written enters the application unconfirmed: proposals live in a sidecar table, named commands are the only write path, submit waits for pending proposals, and confirmed values reach the application only through the portal's two existing write paths.

## 5. Rollout plan

**MVP.** The copilot path ships in days once the catalog and contractor-profile mocks become real clients: it writes nothing to the applications table and the flag defaults off. Extraction follows as its own phase.

| Phase | Who | Length | Gate to advance | Rollback |
| --- | --- | --- | --- | --- |
| 0 Internal | AI team, Compliance, two reviewers | 1 week | Eval sets pass; Compliance signs off on the template, deny-list and fallback texts | Flags off |
| 1 Pilot | About 20 contractors in one region, 2 reviewers; pay-stub extraction | 2 weeks | No guardrail false negative in sampled transcripts; fallback under 5% of turns; correction rate per field known | Flags off |
| 2 Expansion | 10% of contractors; all document types | 4 weeks | Completion time and abandonment better flag-on than flag-off; queue time within SLA | Back to the pilot list |
| 3 Default on | All contractors, with opt-out | ongoing | Monthly metric review | Per contractor or global off |

**Change management.** An in-portal announcement at product selection, a one-page guide, the three suggested prompts as the onboarding device, and a 30-minute reviewer walkthrough. The pilot allowlist doubles as the control group; rolling back a prompt version is a flag flip.

## 6. Monitoring and impact evaluation

Every metric is a query over audit events. Guardrail: block rate per check and prompt version; disagreement between checks in both directions (judge blocks what the list passed above 1%: add terms; the reverse above 2%: false-positive review); fallback above 5% and judge-unavailable above 0.5% alert. Copilot: latency p95 per step, cache read rate, proposal edit rate per field (above 20% alerts). Review: correct and flag rate per field, correction magnitude (above 10% on a money field signals drift), not-located rate, queue time. Catalog mismatches and credit-engine calls must read zero.

**Drift** is read from the disagreement rate between checks, the reviewer correction rate and the eval sets re-run on every version change; blocked drafts are reviewed weekly by category and grow the eval sets.

**Business impact**, from the existing Snowflake funnel with the pilot allowlist as control: completion time and abandonment at product selection, flag on versus off; contractor adoption (at least one copilot turn per week); time from submit to documents reviewed; reviewer minutes per application. The v1 to v2 loop: corrections and blocked drafts grow the eval sets, and each new prompt, deny-list or tolerance version advances only through the eval gates.

## Prototype: built versus described

Built (TypeScript, Node 22, React, one process, an Anthropic or OpenRouter key): the copilot walkthrough with live model calls, the homeowner view, quote-verified proposals, the three-check guardrail, the calculator and disclosure template with golden tests, the audit page, extraction with boxes on the original page, the reviewer screen with discrepancy questions and replies, a recorded extraction fixture replayed without a key, the eval runner, and a scripted browser walk. 558 tests pass as of 2026-10-28, and the eval runner passed 15 of 15 recorded conversations and the judge set live; the fixture scored 9/9 fields on the text PDFs and, on the image pay stub, 7/7 fields with every locatable value located (net pay is engineered as not located). Described only: the Textract adapter, the SQS consumer and the Jira update (typed mocks stand in), per-contractor flags, the audit timeline view, the per-field tolerance table, the monitoring queries and alerts of section 6, retrieval, token streaming, a decorrelated judge, and the judge set beyond its first 20 cases.

Simplifying assumptions: typed mocks for the financial services; an in-memory store reseeded at boot; three products; synthetic sample documents with one value engineered to be unlocatable; a demo loader instead of an upload control; models reached through OpenRouter (the direct Anthropic path was not exercised); a judge set too small to measure its thresholds; one tenant, no authentication. The README says what ran; the build log records every review finding and decision.
