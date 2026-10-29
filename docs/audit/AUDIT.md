# GoodLeap Loan Assistant Audit

## Executive Summary

The core is well built. All state changes go through one module (`server/commands.ts`), and a test
enforces that (tests/commands.test.ts:612). Every command validates and writes its audit event before
it touches state (commands.ts:51-55). Money is exact integer math (calculator.ts:4-12). Model output
reaches a person only through quote checks and three guardrail layers. What would bite someone
changing it lies at the edges: identity, process lifetime, and a few loops that are not idempotent.

1. **SEC-HIGH-001: there is no identity. The route decides who the actor is.** Evidence: an
   anonymous request confirmed a document value, and the audit recorded it as reviewer
   `rev_demo_001`, session `no-session` (evidence/security/anonymous-reviewer-and-reset.out).
   Consequence: the commands' actor-type checks protect the order of transitions, not who may make
   them. Any real deployment needs an identity layer at `contractorCtx` and `reviewerCtx`.
2. **SEC-MED-002: anyone can empty the audit log.** Evidence: an anonymous `POST /api/reset` took the
   log from 41 events to 0 in the same run. The server also empties it at every boot
   (server/index.ts:21). Consequence: "append-only" holds within one process lifetime only.
3. **ARCH-MED-003: everything lives in one process's memory.** Evidence: store.ts:55. Single-flight
   and the extraction queue are process-local (review/single-flight.ts:8, applications.ts:289).
   Consequence: a restart loses every application and any extraction in flight. Two instances would
   each hold different data.
4. **ARCH-MED-004: a follow-up turn cannot quote an earlier turn's figures.** Evidence: number-match
   allows only figures from this turn's calculation (turn.ts:188). The draft "$396.29 … 120 months"
   is blocked with no calculation (evidence/architecture/followup-figures-blocked.out). Consequence:
   correctness rests on the prompt (copilot.system.md:45). A slip costs a regeneration or the
   fallback. This is a design choice, not a bug.
5. **SEC-MED-005: "Confirm all" can confirm suggestions the contractor never saw.** Evidence: the
   route confirms whatever is `proposed` when the request arrives (applications.ts:196-202). The
   button stays enabled while a turn is running (web ApplicationForm.tsx:91). Consequence: the rule
   that a person confirms every model value can be bypassed by timing.
6. **ARCH-MED-006: retrying a turn is not idempotent.** Evidence: the server records the message
   first (turn.ts:136). The client's retry re-sends the same text with no idempotency key
   (web conversation.ts:151). Consequence: duplicate transcript lines and superseded proposals.
7. **COMP-MED-009: raw model inputs and outputs, with names and pay data, are kept in plaintext and
   go to the configured provider.** The local `.env` sets a non-Anthropic base URL; its value was not
   recorded.
8. **COMP-MED-010: the deferred-interest option discloses its paid-in-full plan (0.00% APR) as its
   own figures** (calculator.ts:487-521). That is a call for Compliance, not for engineering.
9. **DQ-MED-011: annualized income is one pay period times periods per year**
   (pay_stub.ts:65-67), so variable or multi-job income raises a discrepancy by design.

**Performance.** Pricing, matching and the guardrail checks run locally and take milliseconds. Turn
latency is dominated by model calls, and README.md:37 records 11 to 12 s turns when a regeneration
doubles them. Two costs grow with use. Each `audit.list()` deep-clones every one of the application's
events: about 12 ms per 1,000 events per call, measured on real events (PERF-MED-007). It is called
several times per turn and on every review view. Second, uploads have no page cap: pdf.js parsing
and OCR page rendering run in the server process, and a whole document's text goes into one
extraction prompt (PERF-MED-008).

**Residual risk.** The findings rest on code reading plus two live reproductions and two unit-level
reproductions. These were not run: `npm test`, `npm audit`, any live model call (copilot or
extraction), the confirm-all race and the retry duplicate, both of which are INFERRED from code, and
a large-PDF load test. Nothing here is certified compliant.

---

## Audit Record

| Field | Value |
| --- | --- |
| Audit dates | 2026-10-29 |
| Auditor | Claude (Opus 5.5) for Andre Batista |
| Commit | `35eb9af` (main, clean tree) |
| Lens | "owner needs to understand the code thoroughly — identify the core files, classes and functions to know well" |
| Local environment | Node, Linux. A throwaway server on port 3471, started from an empty directory with no API key, so extraction replayed the recorded fixture |
| Deployed environment | None probed |
| Data classification | Synthetic only (seed and samples) |
| In scope | `server/`, `shared/`, `web/src/` (read by a sub-agent; its claims were checked where cited), prompts, the seed |
| Out of scope | `scripts/samples/` (one-time tooling), the demo video pipeline, design documents except to check intent |

## Methodology and Evidence Standards

- Every statement is OBSERVED (file:line, sanitized output) or INFERRED. No credentials or session
  tokens are recorded. The `.env` values were redacted on read.
- Because the codebase is small, the five tracks are written into this file rather than into
  separate track documents. Evidence is in `docs/audit/evidence/<track>/`, and each top claim is
  re-checked in that track's `lead-spot-check.md`.
- The system brief, [SYSTEM_BRIEF.md](SYSTEM_BRIEF.md), is the document to read first. Its section 9
  is the reading list the lens asked for.

## Initial Findings to Validate

| ID | Area | Observation | Validation required | Resolution |
| --- | --- | --- | --- | --- |
| PRE-001 | Security | The actor comes from the route, and there is no auth | A live anonymous reviewer write | Confirmed live, SEC-HIGH-001 |
| PRE-002 | Architecture | Follow-up turns may be blocked by number-match | Run the check on such a draft | Confirmed at unit level. Mitigated by the prompt. ARCH-MED-004 |
| PRE-003 | Data quality | `findRun` compares a word's text to a single quote token, so a multi-token word could never match | Do adapters emit words that contain whitespace? | **Refuted.** Both adapters split on `\S+` (pdfjs.ts:46), and `normalizeToken` yields one token |
| PRE-004 | Performance | `audit.list` clones every event | Measure | Confirmed, PERF-MED-007 |
| PRE-005 | Client | Submit and complete are gated only on the client | Read the server commands | **Refuted.** commands.ts:708-725 and 974-982 enforce both |

---

## 1. Security Audit

| ID | Sev. | Finding | Status |
| --- | --- | --- | --- |
| SEC-HIGH-001 | High | There is no authentication, and the route chooses the actor | Open (host design) |
| SEC-MED-002 | Medium | An unauthenticated `/api/reset` empties the audit log and the store | Open (host design) |
| SEC-MED-005 | Medium | Confirm all confirms suggestions the contractor has not seen | Open |
| SEC-LOW-014 | Low | Dependency advisories were reported and not addressed | Open (not re-verified) |

### `[SEC-HIGH-001]` No authentication; the route chooses the actor

- **Status:** Open. OBSERVED, reproduced live.
- **Severity:** High for any deployment. Accepted for the local prototype, which says "no login"
  (README.md:233).
- **Observed evidence:** `contractorCtx` sets the actor to the application's `contractor_id`
  (server/api/http.ts:47). `reviewerCtx` hardcodes `rev_demo_001` (server/api/review.ts:19, 29).
  `x-session-id` is client-made and never checked (http.ts:14). `GET /api/documents/:id/file` serves
  any document by id with no application scope (review.ts, the `getFile` route). Live:
  `evidence/security/anonymous-reviewer-and-reset.out` shows "anonymous confirm recorded as actor:
  reviewer rev_demo_001, session: no-session".
- **Affected assets and users:** Every application, document, decision and audit record. The users
  are contractors, reviewers and compliance.
- **Threat or failure scenario:** Anyone who can reach the port posts to
  `/api/review/tasks/:id/decisions`. The value is confirmed, the derived income is written to
  `verified`, and the audit trail names the demo reviewer.
- **Impact:** The audit trail's "who" cannot be trusted. Document PII (pay stubs) is readable by id.
- **Likelihood and assumptions:** Certain on any network-reachable deployment as built. Nil on
  localhost demo use.
- **Recommendation:** Derive `Ctx.actor` from a verified portal session in the two ctx helpers only.
  Keep the commands as they are, because they already take `ctx` everywhere. Scope the file route to
  the caller's application.
- **Verification:** The repro script returns 401/403 for the anonymous decision and the reset, and
  an application-scoped test shows a contractor cannot read another application's document.
- **Architecture consequence:** Identity becomes a middleware ahead of `createApiRouter`. The ctx
  helpers are the single seam, and that is a good property of this design.

### `[SEC-MED-002]` Unauthenticated reset empties the audit log

- **Status:** Open. OBSERVED, reproduced live.
- **Severity:** Medium. It is a demo convenience, but it contradicts the "no update or delete"
  property described at audit-log.ts:107.
- **Observed evidence:** server/api/index.ts:70-79 calls `audit.reset()` and `store.reset()`. The
  live run went from 41 events to 0. The boot also truncates the log (server/index.ts:21).
- **Affected assets and users:** The audit log and Compliance.
- **Threat or failure scenario:** A curl to `/api/reset` erases the evidence of a turn that showed a
  non-compliant draft.
- **Impact:** There is no tamper evidence and no history across restarts.
- **Likelihood and assumptions:** Only with network access, the same as SEC-HIGH-001.
- **Recommendation:** Put the reset behind a dev flag. In production, write the audit stream to
  append-only storage and never truncate it at boot.
- **Verification:** With the flag off, the reset route returns 404, and a restart keeps the prior
  `data/audit.jsonl`.
- **Architecture consequence:** The audit log's sink becomes a durable, external dependency.

### `[SEC-MED-005]` Confirm all can confirm suggestions the contractor has not seen

- **Status:** Open. OBSERVED code. The race itself is INFERRED and was not reproduced.
- **Severity:** Medium. It weakens the central "a person confirms every model value" rule.
- **Observed evidence:** server/api/applications.ts:196-202 loops over every `proposed` proposal at
  request time, and the request carries no ids. The client button is disabled only while a lock is
  held, not during a running turn (web/src/components/ApplicationForm.tsx:91, from the sub-agent and
  checked with grep).
- **Affected assets and users:** Application fields filled from chat. Contractors.
- **Threat or failure scenario:** A turn is still running and proposes `homeowner_last_name`. The
  contractor clicks "Confirm all (3)" on the three proposals they can see. Four are confirmed.
- **Impact:** An unseen model value enters the application as confirmed.
- **Likelihood and assumptions:** Low. It needs a click during a turn's tool round.
- **Recommendation:** Send the proposal ids the contractor saw and confirm only those, or refuse
  confirm-all while a turn is open.
- **Verification:** A test runs a proposal created between the view and confirm-all and expects it
  to stay `proposed`.
- **Architecture consequence:** Write requests carry the view revision they were made against.

### `[SEC-LOW-014]` Dependency advisories not addressed

- **Status:** Open. OBSERVED in the README only. `npm audit` was not re-run.
- **Severity:** Low (prototype).
- **Observed evidence:** README.md:39-40 reports "three advisories (one high) … not addressed".
- **Affected assets and users:** The server process.
- **Threat or failure scenario:** Depends on the advisory. It is unknown which package is affected.
- **Impact:** Unknown until triaged.
- **Likelihood and assumptions:** Unknown.
- **Recommendation:** Run `npm audit --omit=dev` and record which advisories reach runtime code.
- **Verification:** A dated `npm audit` result in docs/test-results.md.
- **Architecture consequence:** None.

## 2. Performance Audit

| ID | Sev. | Finding | Status |
| --- | --- | --- | --- |
| PERF-MED-007 | Medium | `audit.list()` deep-clones the application's whole history on hot paths | Open |
| PERF-MED-008 | Medium | Uploads have no page cap; parsing, OCR rendering and the prompt are unbounded | Open (INFERRED) |

### `[PERF-MED-007]` `audit.list()` clones the whole history per call

- **Status:** Open. OBSERVED, measured.
- **Severity:** Medium. It is harmless at demo scale, and the cost is linear in an application's
  history.
- **Observed evidence:** audit-log.ts:175 filters and then `structuredClone`s each event. It is
  called from `singleFlight` only to read the first event id (review/single-flight.ts:14),
  `decisionsOf` on every `taskView` (review/tasks.ts:293), `turnEventIds` at least twice per turn
  (turn.ts:129, 251), `buildContext`, and the homeowner view. Measured: 127 events take 1.3 ms;
  1,270 take 12.2 ms; 5,080 take 45 ms per call. `model.call` events are 55% of the bytes
  (evidence/performance/audit-list-clone-cost.out).
- **Affected assets and users:** Turn latency and the reviewer screen, which reloads every 5 s while
  waiting for a reply.
- **Threat or failure scenario:** A long chat session with many model calls: each turn and each
  reviewer refresh clones megabytes.
- **Impact:** Tens of ms per call at about 1,000 events. This is small next to model latency, but
  it blocks the event loop.
- **Likelihood and assumptions:** It grows with session length. A real store would replace it.
- **Recommendation:** Add index-based reads (`firstEventId`, `eventIdsForTurn`, `decisionsFor(task)`)
  that do not clone payloads.
- **Verification:** Re-run the evidence script against the new reads. A view with 5,000 events
  should take under 1 ms.
- **Architecture consequence:** Reads that drive the UI should not scan the audit stream. Keep a
  projection.

### `[PERF-MED-008]` No page cap on uploaded PDFs

- **Status:** Open. INFERRED from code. No large-file test was run.
- **Severity:** Medium.
- **Observed evidence:** uploads.ts checks the bytes (10 MB) and the magic number only. `readPdfText`
  loops every page (pdfjs.ts, `for pageNumber <= pdf.numPages`). The OCR adapter renders every page
  at up to 5,000 px (ocr-tesseract.ts:17, 309). `buildExtractionRequest` includes all pages
  (prompt.ts:48), and extraction `max_tokens` is 4096 (config.ts).
- **Affected assets and users:** Every request served by the same process during the extraction.
- **Threat or failure scenario:** A 10 MB, 400-page text PDF is attached and submitted. pdf.js
  parses it on the main thread, the prompt carries 400 pages, and the call times out or is cut off,
  ending in `llm.schema_invalid`.
- **Impact:** The event loop stalls for every user, model cost goes up, and the document fails to
  `manual`.
- **Likelihood and assumptions:** Low in a demo, real in production.
- **Recommendation:** Cap pages (for example 10) at upload with a clear message, and run OCR off
  the main thread.
- **Verification:** An upload test with an 11-page PDF expects a 400. A latency probe of
  `/api/healthz` during an OCR run.
- **Architecture consequence:** In production this is the Textract/SQS consumer the design
  describes, not the API process.

## 3. Architecture Audit

| ID | Sev. | Finding | Status |
| --- | --- | --- | --- |
| ARCH-MED-003 | Medium | Single-process, in-memory state, with background work tied to the process | Accepted (prototype) |
| ARCH-MED-004 | Medium | Number-match allows only this turn's figures | Accepted design. Documented here |
| ARCH-MED-006 | Medium | A turn retry is not idempotent | Open (INFERRED outcome) |
| ARCH-LOW-012 | Low | Two LLM clients for extraction | Open (known, README.md:30) |
| ARCH-INFO-013 | Info | A review completes with open discrepancies | By design (docs/states.md:152) |

### `[ARCH-MED-003]` Single-process, in-memory state

- **Status:** Accepted for the prototype. OBSERVED.
- **Severity:** Medium. It is the constraint any change must respect.
- **Observed evidence:** `let state` (store.ts:55). The seed loads at boot (index.ts:22). The
  `running` map lives in module scope (single-flight.ts:8). The extraction runs after the response
  as `void startDocumentReview(...)` (applications.ts:289).
- **Affected assets and users:** All of the data.
- **Threat or failure scenario:** The process restarts during extraction. The application, the
  proposals and the half-made review task are gone, and the audit file is truncated at boot.
- **Impact:** Total data loss on restart. Horizontal scaling is impossible.
- **Likelihood and assumptions:** Certain on any restart. The README states it (README.md:83).
- **Recommendation:** Keep `store.*` and `storeWriter()` as the seam for a database adapter. The
  commands do not need to change.
- **Verification:** Restart the server mid-review, and the task survives.
- **Architecture consequence:** Commands must become transactional, covering the event and the
  mutation together. Today's "emit, then mutate" ordering assumes a single-threaded process.

### `[ARCH-MED-004]` A follow-up turn cannot quote earlier figures

- **Status:** Accepted design, documented. OBSERVED at unit level.
- **Severity:** Medium for anyone changing the copilot. This is the most surprising behavior in the
  turn loop.
- **Observed evidence:** turn.ts:188 passes `calculator_values: []` when this turn made no
  calculation. The run in evidence/architecture/followup-figures-blocked.out blocked "$396.29" and
  "120 months". The prompt compensates: "Never quote payment figures from earlier replies; call
  calculate_payment again" (server/prompts/copilot.system.md:45).
- **Affected assets and users:** Contractors asking follow-ups ("what was option B again?").
- **Threat or failure scenario:** The model answers from history without the tool. The draft is
  blocked, regenerated, and if it is blocked again the contractor sees the fallback.
- **Impact:** Extra latency (README.md:37 records 11 to 12 s turns from regeneration) or a fallback
  reply.
- **Likelihood and assumptions:** Depends on how well the model follows the prompt. The 15 eval
  cases passed (docs/test-results.md).
- **Recommendation:** None for safety. If it shows up in metrics, allow the figures of the stored
  Options records already shown in this conversation.
- **Verification:** An eval case with a follow-up question that quotes earlier figures.
- **Architecture consequence:** The "allowed figures" set is per turn by design. Widening it is a
  compliance decision.

### `[ARCH-MED-006]` A turn retry is not idempotent

- **Status:** Open. Code OBSERVED. Duplicate outcome INFERRED, not reproduced.
- **Severity:** Medium.
- **Observed evidence:** `appendMessage` is the first thing a turn records (turn.ts:136). The client
  `retry` re-posts the same text after a retryable error, including a cut-off stream (web/src
  conversation.ts:151, stream.ts:121-127 per the sub-agent). There is no idempotency key in
  `TurnRequestSchema`.
- **Affected assets and users:** The transcript, proposals and the audit trail.
- **Threat or failure scenario:** The stream drops after the server proposed `property_zip`. The
  contractor clicks Retry. A second identical message is recorded, and a new proposal supersedes the
  first.
- **Impact:** A duplicated transcript and extra model calls. No wrong value results, because
  supersede keeps one live proposal.
- **Likelihood and assumptions:** Network drops only.
- **Recommendation:** A client-made turn id in the request. The server returns the recorded turn
  instead of re-running it.
- **Verification:** A test posts the same turn id twice and expects one `message.received`.
- **Architecture consequence:** Turn ids move from server-made (turn.ts:99) to client-proposed.

### `[ARCH-LOW-012]` Two LLM clients for extraction

- **Status:** Open. OBSERVED, and known (README.md:30).
- **Severity:** Low.
- **Observed evidence:** server/extraction/llm.ts makes its own `new Anthropic(...)` (llm.ts:121)
  next to server/llm/client.ts.
- **Affected assets and users:** Maintainers.
- **Threat or failure scenario:** A change to error mapping or the base URL is made in one client
  only, and extraction behaves differently from the copilot.
- **Impact:** Divergent retry and timeout behavior.
- **Likelihood and assumptions:** Likely on the next SDK change.
- **Recommendation:** Merge, as the README already plans, and re-record the fixture.
- **Verification:** One `new Anthropic` in `server/`, and a fixture replay test that passes.
- **Architecture consequence:** None beyond the merge.

### `[ARCH-INFO-013]` A review completes with open discrepancies

- **Status:** By design. OBSERVED.
- **Severity:** Informational.
- **Observed evidence:** `completeReview` checks only for undecided proposals and records the
  `open_discrepancies` count (commands.ts:971-998). This is documented at docs/states.md:152.
- **Affected assets and users:** Reviewers and downstream credit staff.
- **Threat or failure scenario:** A reviewer completes the review while a question is unanswered.
  The application shows `documents_reviewed` with an open question.
- **Impact:** Downstream staff must read the count.
- **Likelihood and assumptions:** Whenever a contractor is slow to reply.
- **Recommendation:** None, unless the business rule changes.
- **Verification:** n/a.
- **Architecture consequence:** None.

## 4. Data Quality Audit

| ID | Sev. | Finding | Status |
| --- | --- | --- | --- |
| DQ-MED-011 | Medium | Annualized income comes from a single pay period | Open (design) |

### `[DQ-MED-011]` Annualized income comes from a single pay period

- **Status:** Open. OBSERVED.
- **Severity:** Medium.
- **Observed evidence:** shared/document-schemas/pay_stub.ts:65-67 computes gross pay times periods
  per year (52/26/24/12), compared to the stated income at ±10% or $5,000. The demo itself gives
  $61,100.00 against $85,000.00, a 28% difference that a second job explains (README.md:206-216).
- **Affected assets and users:** Reviewers and contractors.
- **Threat or failure scenario:** For applicants with overtime, bonuses, commissions or a second job,
  the stated income legitimately exceeds one period's annualization, so a discrepancy and a
  contractor question are raised.
- **Impact:** Reviewer and contractor workload, against the goal of shortening applications.
- **Likelihood and assumptions:** High for variable-income borrowers.
- **Recommendation:** Extract YTD gross and the period end date, and annualize from YTD when both are
  present.
- **Verification:** A sample with YTD shows the YTD-based figure and no discrepancy.
- **Architecture consequence:** The derived formula grows a second input set. `derived.ts` already
  supports formulas with several inputs.

## 5. Compliance and Regulatory Audit

Regime: consumer lending (TILA/Reg Z, RESPA), plus a PII-processor review. There is no checklist in
the skill's references for this regime. Nothing here is certified compliant.

| ID | Sev. | Finding | Status |
| --- | --- | --- | --- |
| COMP-MED-009 | Medium | Raw model I/O with PII is stored in plaintext and sent to the provider | Open |
| COMP-MED-010 | Medium | The deferred-interest disclosure shows the paid-in-full plan | Needs a Compliance decision |

### `[COMP-MED-009]` Model I/O with PII is stored in plaintext and sent to the provider

- **Status:** Open. OBSERVED.
- **Severity:** Medium (synthetic data now).
- **Observed evidence:** `model.call` events hold the raw input and output (README.md:169), and they
  make up 279 KB of the 510 KB local audit file (evidence/performance). docs/audit-schema.md:63-81
  declares PII classes, but nothing splits or encrypts them. The local `.env` sets
  `ANTHROPIC_BASE_URL` (value not recorded), and README.md:32 says every live run went through
  OpenRouter. `context.ts:VISIBLE_FIELDS` keeps the name, ZIP and income out of the state block, but
  the contractor's own messages ("Her name is Dana Lee") go to the model verbatim.
- **Affected assets and users:** Homeowner names, ZIP codes and pay stub contents.
- **Threat or failure scenario:** A production key routed through a broker sends borrower PII to a
  second processor, and the plaintext JSONL is retained on disk.
- **Impact:** Contractual and GLBA-type exposure in real use.
- **Likelihood and assumptions:** Only with real data.
- **Recommendation:** Use the direct provider endpoint under a DPA. Split PII-classed fields out of
  the audit stream into encrypted storage with retention.
- **Verification:** A test asserts that no `pii:*` field appears in the plain audit sink.
- **Architecture consequence:** The audit sink becomes two sinks, using `auditPiiMap()` in
  shared/schemas.ts as the split key.

### `[COMP-MED-010]` The deferred-interest disclosure shows the paid-in-full plan

- **Status:** It needs a decision from Compliance. INFERRED as a regulatory question. The code is OBSERVED.
- **Severity:** Medium.
- **Observed evidence:** `priceDeferred` (calculator.ts:487-521) uses the promo-period schedule as
  the option's own schedule, so `schedule_apr_bps` is 0. The not-paid-in-full outcome is attached as
  `consequence`. README.md:121-122 shows "0.00% APR when paid in full".
- **Affected assets and users:** Homeowners, via the homeowner view.
- **Threat or failure scenario:** A reviewer of the disclosure expects the contract APR to be the
  headline figure for a deferred-interest product. The view leads with 0.00%.
- **Impact:** A possible disclosure defect, if Compliance reads it that way.
- **Likelihood and assumptions:** Depends on GoodLeap's product terms.
- **Recommendation:** Confirm the shape with Compliance before anyone changes the calculator. The
  calculator is easy to change, because it is one function plus golden tests.
- **Verification:** Golden tests in tests/calculator.test.ts updated to the agreed shape.
- **Architecture consequence:** None if the decision is to keep it.

## 6. Initial Findings: Resolution

| ID | Resolution | Finding |
| --- | --- | --- |
| PRE-001 | Confirmed live | SEC-HIGH-001 |
| PRE-002 | Confirmed at unit level, mitigated by the prompt | ARCH-MED-004 |
| PRE-003 | Refuted | — |
| PRE-004 | Confirmed, measured | PERF-MED-007 |
| PRE-005 | Refuted | — |

## 7. Response Plan

Priorities: P0 before any networked deployment, P1 before real data, P2 when convenient, P3
documented only. The owner of every row is Andre.

### 7.1 What we build because of the findings
| Findings | Response | Priority | Verification |
| --- | --- | --- | --- |
| SEC-HIGH-001 | An identity middleware that feeds `contractorCtx` and `reviewerCtx`, plus application-scoped file reads | P0 | The repro script returns 401/403 |
| SEC-MED-005, ARCH-MED-006 | Proposal ids on confirm-all, and a client turn id with replay | P2 | The race tests |
| PERF-MED-007 | Audit projections for UI reads | P2 | The evidence script under 1 ms |
| PERF-MED-008 | A page cap at upload | P2 | An 11-page upload is refused |
| DQ-MED-011 | YTD-based annualization | P2 | A sample with YTD |

### 7.2 Configuration we own
| Findings | Change | Priority | Verification |
| --- | --- | --- | --- |
| SEC-MED-002 | Gate `/api/reset` behind a dev flag | P0 | 404 with the flag off |
| COMP-MED-009 | The direct provider endpoint for real data | P1 | `/api/healthz` shows no base URL |
| SEC-LOW-014 | Triage `npm audit` | P2 | A dated result |

### 7.3 Documented, not fixed
| Findings | Why it stays | How we are protected anyway | What a real deployment would need |
| --- | --- | --- | --- |
| ARCH-MED-003 | It is a prototype by design | A deterministic seed, and reset on boot | A database adapter behind `store` and transactional commands |
| ARCH-MED-004 | It is safety-first by design | The prompt rule, plus regenerate and fallback | A metric on the follow-up fallback rate |
| COMP-MED-010 | Not an engineering call | A golden test pins the current shape | Compliance sign-off |
| ARCH-LOW-012, ARCH-INFO-013 | Known and documented | — | The merge after submission |

## 8. How the Audit Changed the Plan

There was no build plan behind the lens, so each row below is a surprise.

| # | Expectation | Audit evidence | Revised understanding |
| --- | --- | --- | --- |
| 1 | The actor-type checks in commands are authorization | Routes set the actor, and the anonymous write succeeded | They are transition rules. Identity has to be added at one seam |
| 2 | The audit log is tamper-evident | Reset and boot both empty it | It is append-only per process only |
| 3 | The number guard compares against everything shown | Only this turn's calculation | Follow-ups depend on the prompt |
| 4 | The client gates submit and complete | The server enforces both | The client gates are UX only |
| 5 | The matcher could miss multi-token words | The adapters split on whitespace | No defect |

**What skipping the audit would have missed.** Reading the commands alone suggests the system has
authorization. It does not. It has transition rules, with the actor chosen by the route. The
per-turn figure rule would surprise anyone adding a "repeat the options" feature. The confirm-all and
retry gaps are both cases where timing undoes a carefully enforced invariant.

## 9. Residual Risk

- Not run: `npm test`, `npm audit`, any live model call, the confirm-all race, the retry duplicate,
  and a large-PDF load. The web client was audited by a sub-agent. The cited lines were spot-checked,
  but not every line was.
- The prototype limits stated in README.md:27-41 stand. Most notably, number-match reads "N monthly
  payments" as a count, and there is no prompt-injection eval case.
- Before real use: identity, durable and split audit storage, a processor agreement for the model
  provider, and a Compliance review of the disclosures.
