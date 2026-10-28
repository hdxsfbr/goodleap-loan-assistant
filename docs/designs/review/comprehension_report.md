# Stage 6: Comprehension Test

* **Target:** `docs/designs/loan-assistant-design.md` (FeatureRange lines 1 to 1183, DetailedRange lines 1184 to 2027 at review time)
* **Reviewer:** `egm-comprehension` (naive reader), fresh context, no standard
* **Status:** completed. No Blocker; every section could be paraphrased.

## What this proposes

One AI assistant for GoodLeap's contractor-facing loan portal, in two features on a shared base, for a take-home due the morning of 2026-10-29. Feature 1 is a chat copilot beside the application form: it explains loan products, gets payment options from a deterministic calculator (the LLM never produces a number), proposes form field values only from the contractor's verbatim words (the backend verifies the quote), and opens a full-screen "homeowner view" whose TILA/RESPA disclosure block is a code template the type system makes mandatory. Feature 2 is backend document extraction: an LLM reads each uploaded pay stub, estimate and scope letter as indexed lines of positioned text and selects a span per field; the backend verifies the quote, draws a box from the document's own word positions, and an internal reviewer confirms, corrects or flags every value before anything reaches the application; out-of-tolerance differences become per-value discrepancy records with a templated question sent to the contractor. The shared base is mocked services behind typed interfaces, one Anthropic client, a three-layer guardrail (deny-list, number-match, Haiku judge, regenerate once then Compliance-owned fallback), an append-only audit event stream with a versions block on every event, and a three-tab React app with no login. The DetailedRange turns this into 86 numbered files on Node 22 / TypeScript / Vite / Express, a Floor/F1/F2/Fallback cut line, a six-step build order, and a verification plan.

## How the existing system works, per this document

GoodLeap finances home-improvement projects through 15,000+ contractors who fill in a loan application on a tablet in the homeowner's home using a React partner portal backed by a TypeScript/Node service on AWS ECS with RDS Postgres, S3 and SQS. An existing credit decision engine owns approval and denial; Plaid is the first income source; a product catalog, contractor profile service and document management service exist; Snowflake holds funnel analytics and Zapier carries automations. Per the document's stated assumption, a document upload emits an SQS message that creates a Jira Service Management issue, and staff then read the documents by hand to extract income, pay frequency, project total and scope. Applications take 22 minutes against a sub-10-minute benchmark and 38% are abandoned, mostly at product selection and income verification. The assistant adds four screens, one API route group, one SQS consumer, four tables and one S3 prefix, and claims to leave the applications table, the decision engine's inputs, Plaid and the JSM queue untouched.

The author's check: both paraphrases match the intent.

## Findings

### Major

| Id | Finding | Scope |
| --- | --- | --- |
| CO-1 | The credit engine is "never called", yet `CreditEngineService.submit()` is called by `submitApplication` and logged as a `tool.call` with `service: "credit_engine"`, and the counter `countToolCalls(applicationId, service)` would count it. A reader cannot say what the zero on the audit page counts. | G2, 4.3, 4.6, items 17, 50, 51 |
| CO-2 | CUJ 6 asserts `review.decision` entries; no such event exists in the union (decisions are `field.*` events with `review_task_id`). | CUJ 6, data model |
| CO-3 | "The existing write paths" is load-bearing for G5 and rollback but never named. | The Problem, G5, data model, section 10, Alternative S, NFR |
| CO-4 | The 3-second budget starts "from the question being understood", which is never defined. | G1, 4.1 step 4, section 9 |
| CO-5 | CUJ 3's "README's adversarial message" is not in the design, so the trip cannot be checked from the document. | CUJ 3 |
| CO-6 | `POST .../homeowner-view` takes an "options id" that nothing defines or stores; unclear whether the no-model button yields one. | 4.2, items 9, 18, 21, 22 |
| CO-7 | The discrepancy lifecycle has a start and an end with nothing between: how the homeowner's answer returns and what Resolve does are unstated. | 4.5, CUJ 5, items 21 to 23, 48, 62 |
| CO-8 | The build order and tiers omit items 10, 21, 22, 50, part of 51, 54, 82; step 3 claims CUJs 1 to 3 run without the copilot route, the applications API or the contractor view. | Build order and cut line |
| CO-9 | The displayed payment for `zero_intro` (promo-period payment) and `deferred_interest` (which of the two schedules fills the TILA box) is underspecified. | Items 31, 57, 58 |

### Nit

| Id | Finding |
| --- | --- |
| CO-N10 | TILA, RESPA, Reg Z and Reg B never expanded or defined in the design. |
| CO-N11 | Plaid named six times, never described. |
| CO-N12 | "card" / `card.rendered` / "card-first" is the brief's retired name for the homeowner view. |
| CO-N13 | Terms used before definition: positioned text, promo mechanic type, the take-home's six sections, verdict word (by example only). |
| CO-N14 | "refusal" names both the out-of-scope reply shape and the classifier `stop_reason`. |
| CO-N15 | Cross-reference errors: "section 9" for the three-store split; item 61's caption pointer. |
| CO-N16 | Names differ between the Technical Plan and the plan: client call sites, the commands list, `tool.call` fields, the "tolerance table" that no file holds. |
| CO-N17 | The header presents `docs/design-document.md` as existing. |
| CO-N18 | "$200M case" and "the VP" used without stating the business case. |
| CO-N19 | "the `claude-api` skill" and "no beta dependency" are unexplained tooling references. |
| CO-N20 | CUJ 2 says "four form fields" where five or six are plausible. |
| CO-N21 | The comparison assumes a stated value exists; `required` validation at submit is unstated. |
| CO-N22 | Per-slot extraction failure has nowhere to live before the task exists. |
| CO-N23 | `verification_source = document_review` is an assumption not listed under Open Questions. |
| CO-N24 | "At most one live proposal per field per source": "live" and "per source" undefined; the test drops "per source". |
| CO-N25 | `build` type-checks only the server config while the verification plan claims both. |
| CO-N26 | `percent_over` direction readable either way; the no-model button's behavior without a confirmed amount and term unstated. |

## Resolution (Elephant, applied without a gate at the author's instruction)

Comprehension gaps are not contested. All 9 Major and all 17 Nit findings are PROPOSE FIX and applied:

* CO-1: the credit engine interface has a `decide()` nobody calls and no `submit()`; `submitApplication` records "submitted" itself; the audit counter counts `tool.call` events whose `service` is `credit_engine`, which is zero.
* CO-2: CUJ 6 names the `field.*` events carrying `review_task_id`.
* CO-3: the two existing write paths are named in the data model and G5 points there: the portal's form submit request, and the manual-review confirmation endpoint that writes `verification_source = document_review`; the prototype's `submitApplication` and `confirmValue` stand in for them.
* CO-4: the 3-second budget runs from the server receiving the message and includes the first model round.
* CO-5: CUJ 3 carries the adversarial sentence and what trips.
* CO-6: an `options` record with `options_id` is stored by the turn (and by the no-model button); the homeowner-view route takes `{ options_id }`.
* CO-7: the contractor replies in the banner (`POST .../discrepancies/:did/reply`); the reviewer resolves with `explained` or `corrected`; a corrected stated value is re-compared.
* CO-8: tiers and steps now cover every item; step 3 includes the routes and the contractor view.
* CO-9: `zero_intro` shows the promo payment and the post-promo payment; `deferred_interest` shows the paid-in-full plan in the TILA box with a stated "if not paid by month 12" line from the second schedule.
* Nits: expansions and definitions on first use; `card.rendered` renamed `view.rendered`; "out-of-scope reply" replaces "refusal shape"; cross-references fixed; names aligned (`copilotCall`, `extractCall`, `judgeCall`; ten commands; `tool.call { service, method, ... }`; tolerance versioned by `schemas@<sha>`); header link marked planned; business case stated; API documentation cited; CUJ 2 counts five fields; `submitApplication` validates `required`; Document gets `extraction_status`; the column assumption added to Open Questions; invariant terms defined; `build` checks both configs; `percent_over` direction and the no-model button's disabled state stated.

**Status: resolved.** All 26 findings applied to the design. No findings remain open from this stage.
