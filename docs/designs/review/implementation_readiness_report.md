# Goldfish Review Report

**Target:** `/home/hdx/code/goodleap-loan-assistant/docs/designs/loan-assistant-design.md` (`1394-2314`, from the header `## Detailed Implementation Plan` to end of file)

**Stage:** 9 (Implementation Readiness Test), round 1. Findings are reported against the Detailed Implementation Plan only; a contradiction between the plan and the Technical Plan it implements is reported as a finding against the plan, with the spec line cited for reference.

**Facts applied (not findings):** the repository contains no source code yet, so no "file does not exist" finding is recorded; Create/Modify markers are present on every item; the plan is a take-home prototype due 2026-10-29 with a Build order and cut line (Floor, F1, F2, Fallback); the listed Anthropic SDK features (`messages.create`, `messages.parse`, `zodOutputFormat`, `strict: true` tools, `output_config.effort`, `cache_control` on system blocks, `stop_reason: "refusal"`) are real and were not flagged.

**Severity counts:** 4 Blockers, 39 Major, 41 Nits (84 findings after deduplication across three reviewers).

## Reviewer Status

| Reviewer | Status |
| --- | --- |
| `egm-implementation-readiness` | completed (3 Blocker, 24 Major, 30 Nit reported) |
| `egm-codebase-details` | completed (1 Blocker, 34 Major, 32 Nit reported) |
| `egm-style` | completed (0 Blocker, 13 Major, 30 Nit reported) |

All three ran once and returned a report; no retries were needed. Overlapping findings were merged; where reviewers disagreed on severity the synthesizer's judgement is recorded with the reason.

## Prioritized Findings (Blockers -> Major -> Nits)

### IR-1. Contractor-typed field values have three contradictory homes and no command can write them - Severity: Blocker
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`
* **Affected Scope:** Items 18, 19, 21, 22, 55, 77 (lines 1577-1585, 1587-1608, 1617-1630, 1632-1642, 1996-2002, 2182-2192); contradicts Technical Plan section 3 (line 424) and 4.1 step 1 (line 542).
* **Discrepancy Description**: Section 3 says "contractor-typed values are client state sent with each copilot turn ... and with the submit request", and item 19 agrees ("the current client-side typed values when enforcing the no-overwrite rule"; test 77 "passed in as client state"). But item 21 defines `POST /api/applications/:id/fields (manual edits)` and item 55 says "manual edits post to the fields route", which is server-side storage; item 21's `load-demo` "fills the demo project" on the server; item 22's `payment-options` reads "the form's confirmed project amount and preferred term" from the server; item 66 seeds confirmed values. Item 18 says "mutations happen in `commands.ts`", yet none of item 19's twelve commands writes a typed value (`editValue` is for proposals, "before and after are logged"). The state a typed value carries is also undefined: the `ProposedValue` enum has no `typed`, and whether a typed value counts as "confirmed" for item 22's button and item 28's "confirmed form fields" preference is unstated. Without a key (CUJ 7) the copilot cannot fill `preferred_term_months`, so if typed values are not "confirmed" the button can never enable.
* **Rationale & Recommendation**: An implementer must invent either a `setTypedValue` command or a client-state protocol before item 19, 21, 22 or 55 can be written, and the two halves of the document disagree on which. Pick one model and state it everywhere. Recommended: server-side typed state. Add `setFieldValue(applicationId, fieldKey, value, actor)` to item 19 that writes `fields[key]` with state `confirmed`, `sourceRef: null`, and emits `field.confirmed` with `source: "typed"`; make `POST .../fields` call it; make the turn body `{ text }` only; have `proposeFieldValue` read typed values from the store (dropping the client-state argument); update item 77, section 3 line 424 and 4.1 step 2. Enumerate the form-field display states (empty, typed/confirmed, proposed, edited) in item 10 or item 84.

### IR-2. Floor-tier items depend on F2-tier items and step 1 of the build order cannot build or boot - Severity: Blocker
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`, `egm-style`
* **Affected Scope:** Build order and cut line (lines 2265-2294, tier table 2271-2276, "Every numbered item appears in exactly one tier" 2278, steps 2281-2290); items 1, 13, 15, 19, 21, 28, 29, 52, 66 (lines 1422-1426, 1536-1541, 1551-1558, 1593, 1620-1626, 1718-1719, 1729-1730, 1971-1978, 2091-2096).
* **Discrepancy Description**: Each of the following Floor items imports or reads an F2 item: (a) item 15 `versions.ts` (Floor, step 1) hashes "extraction prompt ... and document schema files", which are item 25-extraction and item 11 (both F2, step 5), and gives no missing-file behavior, so boot throws at step 1; it also hashes the prompts (25, step 3), deny-list (35, step 3), catalog (30, step 2) and template (32, step 2), none of which exist at step 1. (b) Item 19 `rejectValue(reason_code)` and the `field.rejected { reason_code }` event (Floor) use the reason-code enum defined only in item 11 `shared/document-schemas/index.ts` (F2). (c) Item 29 `quote-verify.ts` (Floor, step 3) is "Shared with extraction's span check through `extraction/normalize.ts`", item 42 (F2, step 5); item 28 (Floor) builds `allowed` with "numeric tokens" using `isNumericToken` from item 42. (d) Item 21 `load-demo` (Floor) "attaches the three bundled documents through `attachDocument`", but the bundled documents (item 68) and the documents mock (item 51, "documents and JSM mocks") are F2; item 66 (Floor) "three document records pointing at the bundled files" likewise. (e) Item 21 `GET /api/applications/:id` (Floor) returns "the derived banner", computed by `deriveApplicationStatus` in item 48 (F2). (f) Item 1 (Floor) scripts `eval`, `samples:generate`, `samples:ocr` point at items 73 (F1) and 70 (F2). (g) Step 1 claims the repository is "buildable and `npm test` green", but `build` runs `vite build`, which fails with no `web/index.html` (item 52, step 3), and `server/index.ts` "serve `dist/web`" has nothing to serve. (h) Step 3 says CUJs 1 to 3 run with "21 (without the extraction hook)", but `.env.example` defaults `EXTRACTION_ENABLED=true`, so the submit route's post-submit behavior at step 3 is undefined (enqueue absent; the disabled branch calls `createReviewTask` whose JSM mock is step 5). (i) Line 2269 "Each item above belongs to one tier" and line 2278 "Every numbered item appears in exactly one tier" are false: items 21, 25 and 51 appear in both Floor and F2.
* **Rationale & Recommendation**: The tier table is the cut line for a one-day build; if it is wrong the cut cannot be made safely. Either move the shared primitives into the Floor (item 42 `normalize.ts` to `shared/` or `server/text/`; the reason-code enum to `shared/schemas.ts`; `deriveApplicationStatus` to a Floor module; the documents mock and the three sample files to the Floor, since "Load demo project" is CUJ 1), or restate the Floor versions of items 15, 19, 21, 29 (for example `versions.ts` records `<name>@absent` for missing files; `load-demo` attaches nothing in the Floor build). Add item 52's `index.html` to step 1 or make `build`/`start` tolerate a missing web root. State that in step 3 the submit route stops after `submitApplication` regardless of the flag. Split 21, 25 and 51 into per-tier sub-items (21a/21b, 25a/25b/25c, 51a/51b) and keep one of the two "one tier" sentences. Then re-derive the tier table and steps.

### IR-3. The "not located by construction" demonstration is impossible under the plan's own types and line-grouping rule - Severity: Blocker
* **Reviewer Lens:** `egm-codebase-details`, `egm-implementation-readiness`, `egm-style`
* **Affected Scope:** Items 39, 41, 43, 45, 68, 72 (lines 1825-1832, 1843-1848, 1858-1867, 1886-1889, 2107-2115, 2140-2145); contradicts Technical Plan section 7 (lines 777-781), CUJ 4 and G7.
* **Discrepancy Description**: Item 39 declares `PositionedWord { text, bbox: {x,y,w,h} (fractions, top-left), confidence, line }` with a non-nullable `bbox`, but item 68 commits words with `bbox: null` and item 45 speaks of "a match whose words carry no geometry"; the type cannot represent the fixture. Item 39's `toIndexedLines(text)` "groups words by y (within half a word height), orders by x": a word with no bbox has no y and no x, so the net-pay words "1,812.40" cannot be placed on any indexed line, the model never sees them, cannot cite them, and the value returns `null` -> `not_extracted` (a different row type), not `not_located`. Item 41 says the OCR adapter "assigns lines" while item 39 says `toIndexedLines` groups by y: two independent line assignments, and item 43 resolves "cited page, line and token span" against one of them. `spanBox(words)` has no rule for null members, and who converts "words carry no geometry" into `not_located` (item 43 or item 45) is stated differently in each.
* **Rationale & Recommendation**: This is the README's named demonstration and the no-key reviewer path in CUJ 7; as specified it does not occur. Make `bbox: {x,y,w,h} | null` in item 39. Make the adapters the single owner of `line` (the OCR adapter takes it from tesseract's block/paragraph/line hierarchy before geometry is stripped; the pdfjs adapter from its own y-grouping) and have `toIndexedLines` render by the adapter's `line` field, ordering by the word's original index within the line so null-bbox words keep their place. Define `spanBox(words)` as "union of the non-null boxes, or `null` if any word in the run has no box". State in item 43 that `locate` returns `{ method: "not_located", words }` when any matched word lacks geometry, so item 45 has one rule. State token indexing explicitly (0-based over words; the `|` column separator is not a token).

### IR-4. The no-model "Show payment options" rule contradicts CUJ 7 and G1, the amount field is unnamed, and `inputs_source` cannot represent the Floor walkthrough - Severity: Blocker
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`, `egm-style`
* **Affected Scope:** Items 22, 28, 57 (lines 1638-1642, 1709-1716, 2019-2022); contradicts G1 (lines 106-111), CUJ 1 (202-215), CUJ 2 Given (219-221), CUJ 7 (302-313), 4.1 step 4 (558-568), section 9 (824-826).
* **Discrepancy Description**: (a) Item 22: the button "is disabled with the caption 'Confirm a project amount and a term first' until both fields are confirmed". CUJ 2's Given states that `preferred_term_months` is empty in the demo seed, so in CUJ 1 and CUJ 7 (no key) the button is disabled, contradicting G1 ("it holds during an API outage") and CUJ 7 ("'Show payment options' ... all work"). (b) In CUJ 1 the amount comes from the form and the term (120) from the model's tool argument, but `OptionsRecord.inputs_source` is a single `form | argument` value (line 559); a mixed case is unrepresentable and the "based on an amount not yet on the application" label rule (item 57) is undefined for it. (c) Which form field is "the amount": item 22 says "project amount", item 28 says "confirmed form fields" without naming one; the TILA amount financed is the loan amount, `requested_loan_amount`, and item 67 has the two differ in principle ($31,000 estimate vs $30,000 requested) while the seed makes them equal, hiding the bug.
* **Rationale & Recommendation**: The button is the stated latency bound and the outage bound; its enable rule must hold in the walkthrough. Define `inputs_source` per input (`{ amount: "form" | "argument", term: "form" | "argument" }`) and the label rule ("shown when either is `argument`"). Name the fields in items 22, 28 and 57's echo: amount = confirmed `requested_loan_amount`, term = confirmed `preferred_term_months`. State the button rule as "enabled when `requested_loan_amount` is confirmed; term defaults to each product's catalog term when `preferred_term_months` is empty" (see IR-18 for the catalog terms), and move the caption string to item 56.

### IR-5. `npm run build` fails on every fresh clone: the server tsconfig includes `scripts/`, whose sources import packages the root install never has - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`, `egm-style`
* **Affected Scope:** Item 2 (lines 1431-1433 "includes `server/`, `shared/`, `scripts/`, `tests/`"), item 1 `build` script (1423-1424), items 70-72 (2125-2145), Verification Plan (2298).
* **Discrepancy Description**: `tsc --noEmit -p tsconfig.server.json` will report "Cannot find module 'pdf-lib'" (and `@napi-rs/canvas`, `tesseract.js`) because item 70 says "the root install never touches" `scripts/samples/`.
* **Rationale & Recommendation**: The Verification Plan's first gate is red by construction. In `tsconfig.server.json`, include `scripts/eval.ts` only (or `scripts/*.ts`) and `"exclude": ["scripts/samples/**"]`; give `scripts/samples/` its own tsconfig.

### IR-6. Express major is unpinned; history fallback and async error handling differ between 4 and 5 - Severity: Major
* **Reviewer Lens:** `egm-codebase-details`, `egm-implementation-readiness`
* **Affected Scope:** Items 1 (line 1419), 13 (1540 "serve `dist/web` with a history fallback"), 20 (1614-1615 "JSON error handler maps `AppError`").
* **Discrepancy Description**: A bare `npm install express` today resolves to Express 5, where `app.get('*', ...)` throws at startup (path-to-regexp 8 requires `/{*splat}`); under Express 4 a rejected async handler never reaches the error handler without `next(err)` or a wrapper, so every thrown `AppError` in an async route hangs the request. `@types/express` must match the major.
* **Rationale & Recommendation**: Item 20's error handler and item 13's fallback cannot be written without the choice. Pin `express@^5` and `@types/express@^5`, write the fallback as `app.get('/{*splat}', ...)`, and state it in items 13 and 20 (or pin 4 and specify an `asyncHandler` wrapper).

### IR-7. `.env` loading is unspecified and the obvious Node 22 choice crashes on the no-key path - Severity: Major
* **Reviewer Lens:** `egm-codebase-details`, `egm-implementation-readiness`, `egm-style`
* **Affected Scope:** Items 1 (dependency list, 1418-1421), 13 (1539 "Load `.env`"), 14 (1546).
* **Discrepancy Description**: `dotenv` is not a dependency and `tsx server/index.ts` passes no `--env-file`. Node 22's `process.loadEnvFile()` throws ENOENT when `.env` does not exist, which is exactly the grader-without-a-key case (CUJ 7 "Without a key the app starts"). Defaults when variables are absent (`PORT`, the two flags) are not stated.
* **Rationale & Recommendation**: Specify `try { process.loadEnvFile() } catch {}` in `server/index.ts` (or add `dotenv`), and state defaults in item 14: `PORT` 3000, `COPILOT_ENABLED` and `EXTRACTION_ENABLED` true when absent.

### IR-8. `data/` does not exist on a fresh clone, so the first audit append fails; tests write into the repo; `reset` semantics unstated - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`
* **Affected Scope:** Item 7 (line 1461 `data/` git-ignored), item 17 (1572), item 20 (1614 `POST /api/reset`), item 77 (2182-2192).
* **Discrepancy Description**: `fs.appendFile` to `data/audit.jsonl` fails with ENOENT on the first event. Item 77 exercises commands, which append, so `npm test` writes to the real file. Whether `/api/reset` truncates the file or only the memory list is unstated (otherwise the audit page shows pre-reset events for re-seeded ids).
* **Rationale & Recommendation**: Item 13: `mkdirSync("data", { recursive: true })` at boot. Item 17: `append` takes an injectable sink (memory in tests, file in the server). Item 20: `reset` clears the in-memory list and truncates the file, or state that it does not.

### IR-9. Store mutations outside `commands.ts` contradict item 18 and section 2 - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`, `egm-style`
* **Affected Scope:** Items 18, 28, 45, 47, 48 and the Options record (lines 1580-1583, 1709-1710, 1884-1890, 1921-1922, 1931-1932); spec line 395 ("The only write path") and 467-470.
* **Discrepancy Description**: Item 18 "Read helpers only; mutations happen in `commands.ts`" (on the same line as `loadSeed()` and `reset()`, which mutate). Item 28 "append the contractor message" to the transcript store (no command). Item 45 sets `extraction_status: type_mismatch` / `failed` / `done` on the Document record (no command). Item 48 "inside tolerance, record the difference on the proposal only" (no command, and `ProposedValue` in section 3 has no `difference` field). Item 47 `complete(taskId)` "transitions the application; appends `review.completed`" without naming `completeReview`. The Options record's `explanation?` is written after the judge, but `storeOptions` runs when the tool returns and no command updates it. Item 18 also lists "discrepancies" twice.
* **Rationale & Recommendation**: Add `appendMessage`, `setExtractionStatus`, `attachExplanation` (and `recordDifference` with a `difference?` field on `ProposedValue`, or drop that clause) to item 19, each with its audit event; route `complete()` through `completeReview`; or rewrite item 18's rule as "application, proposal, discrepancy and review-task mutations happen in commands; transcript, document status and options explanation are owned by the named modules". Rewrite item 18 to "Read helpers plus `loadSeed()` and `reset()`".

### IR-10. `createReviewTask` names two different functions; callers do not say which, and the JSM call order is unstated - Severity: Major
* **Reviewer Lens:** `egm-style`, `egm-codebase-details`, `egm-implementation-readiness`
* **Affected Scope:** Item 19 (line 1593, commands: "emits `review.task_created`"), item 47 (1914-1915, `review/tasks.ts`: "through `commands`, logging the mock JSM `createIssue` and `addLink` calls"), callers item 21 (1629-1630) and item 45 (1893); spec line 492 (`review.task_created { ..., jsm_issue_id }`).
* **Discrepancy Description**: The submit route and `enqueueExtraction` "call `createReviewTask`" without saying which; calling the command directly skips the JSM mock and leaves `jsm_issue_id` undefined. `review.task_created` carries `jsm_issue_id`, so `createIssue` must precede the command, and `addLink` (needs the task id) must follow it; the plan states no order.
* **Rationale & Recommendation**: Rename the wrapper `openReviewTask(applicationId)`: "calls the review-queue mock's `createIssue`, then the `createReviewTask` command with the returned `jsm_issue_id`, then `addLink` with the task id". Items 21 and 45 call `openReviewTask`.

### IR-11. ReviewTask state transitions and the "manual reading" slot status are missing - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`
* **Affected Scope:** Items 19, 21, 47 (lines 1593, 1607, 1629-1630, 1914-1922); spec section 3 (454-465), section 8 (809-811).
* **Discrepancy Description**: Nothing transitions `ready -> in_review` (first open? first decision?); no transition out of `extraction_failed`; `complete` requires "every value has a state" but whether `proposed` counts and whether an `edited` value needs a later confirm is unstated. When `EXTRACTION_ENABLED` is false the task is created "with every slot marked for manual reading", but `extraction_status` (`pending | done | failed | type_mismatch`) has no such value and the spec says the task is `ready` only "once every slot is `done`, `failed` or `type_mismatch`".
* **Rationale & Recommendation**: Define `ready -> in_review` on the first `decide()`; `extraction_failed` behaves as `ready` with zero proposals and completes immediately; completion = no proposal for the task in state `proposed`; `edited` is terminal. Add `manual` to the Document `extraction_status` enum (or reuse `failed` and say so) in item 9 and section 3.

### IR-12. Thinking blocks must be echoed back in the manual tool loop; "ignore any text block that accompanies a tool call" invites a 400 - Severity: Major
* **Reviewer Lens:** `egm-codebase-details`
* **Affected Scope:** Item 28 (line 1717), item 24 (1657-1664); spec section 5 (line 698 "thinking stays on at low effort because this model rejects disabling it").
* **Discrepancy Description**: With thinking on, the assistant response contains `thinking` (signed), `text` and `tool_use` blocks; the next request must carry the assistant message with its full, unmodified `content` array before the `tool_result` user message, or the API rejects it. The plan says only to ignore text blocks, which an implementer can read as "build the assistant turn from the tool_use blocks". Whether a `thinking` request parameter is sent at all (or effort alone governs it) is unstated.
* **Rationale & Recommendation**: State in item 28: "push `{ role: 'assistant', content: response.content }` verbatim, then one user message whose content is the `tool_result` blocks in tool-call order; render nothing from interim text blocks". State in item 14 or 24 the exact `thinking` parameter sent, or that none is sent.

### IR-13. Tool-loop termination is unbounded and `stop_reason: "max_tokens"` is unhandled everywhere; the judge's 256-token cap may be hit with thinking on - Severity: Major
* **Reviewer Lens:** `egm-codebase-details`, `egm-implementation-readiness`
* **Affected Scope:** Item 14 (lines 1548-1549), item 28 (1709-1722), item 37 (1813-1815), item 45 (1881-1890).
* **Discrepancy Description**: An `end_turn` is the only loop exit named in item 28; a model that keeps emitting `tool_use` runs forever inside a 10 s budget. Neither item 28 (copilot), 37 (judge) nor 45 (extraction) names a behavior for `stop_reason: "max_tokens"`. If thinking tokens count toward `max_tokens` on these models, a 256 cap on a thinking-on judge returns `max_tokens` with no parsed output, surfacing as `judge_unavailable` only by accident.
* **Rationale & Recommendation**: Item 28: "at most 3 model rounds per turn; a further `tool_use` is treated as a block (fallback line) and logged". Add `max_tokens` to the stop-reason handling: copilot -> block (fallback), extraction -> validation-failure path, judge -> `judge_unavailable`. Confirm in the item 24 smoke calls whether thinking counts toward `max_tokens` and raise the judge cap accordingly.

### IR-14. No SDK request timeout or retry policy; the defaults (600 s, 2 retries) make `llm.timeout` unreachable inside the 10 s budget - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`
* **Affected Scope:** Item 14 (1546-1549), item 16 (1564-1566 "timeouts"), item 24 (1657 "Constructs `new Anthropic()` once"); spec section 9 (818-820).
* **Discrepancy Description**: `llm.timeout` exists as a code but nothing says what triggers it; the SDK's automatic retries would double-bill rate-limit retries and stall turns the design says get a Retry button.
* **Rationale & Recommendation**: Item 24: `new Anthropic({ maxRetries: 0 })`; per-call `{ timeout: 15_000 }` for copilot and judge, `{ timeout: 60_000, maxRetries: 1 }` for extraction (matching section 10's 60 s); item 16 maps `APIConnectionTimeoutError` -> `llm.timeout` before `APIConnectionError`.

### IR-15. Error taxonomy gaps: several code paths need codes that `ErrorCode` does not define, and `retryable` is never defined per code - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`, `egm-style`
* **Affected Scope:** Item 9 (line 1493), item 16 (1563-1566), item 22 (1637-1638), item 28 (1721-1722), item 56 (2008-2009); spec section 8 (795-811).
* **Discrepancy Description**: (a) `mapSdkError()` takes `Anthropic.AuthenticationError` but section 8 has no code for an invalid key (only `llm.missing_key`, "startup"). (b) Item 22 "When `COPILOT_ENABLED` is false ... writes the matching `error` line", but no `copilot.disabled` code exists; section 8 requires the panel to render "disabled by operator" and item 56 handles only the no-key state. (c) `APIConnectionError` (non-timeout) and 4xx `APIError` other than 429 have no stated target. (d) Item 28 catches only `AppError`; a zod or programming error inside the turn produces no `error` line and the stream never ends with `done`. (e) `retryable` on the `error` line is never defined per code.
* **Rationale & Recommendation**: Add a mapping table to item 16 with a `retryable` column: `AuthenticationError` -> `llm.auth_failed` (new, not retryable); `RateLimitError` -> `llm.rate_limited` (retryable); `APIConnectionTimeoutError` and `APIConnectionError` -> `llm.timeout` (retryable); `APIError` 5xx and other -> `llm.server_error` (retryable); anything else -> `internal` (not retryable). Add `copilot.disabled`, `llm.auth_failed` and `internal` to the enum (item 9) and section 8. Item 28 catches everything. Item 56: input disabled with "disabled by operator" when `/api/healthz` reports `COPILOT_ENABLED=false`.

### IR-16. The copilot turn stream is not specified field by field, the status strings are missing from the plan, and the request body is undefined - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness`
* **Affected Scope:** Item 9 (lines 1493-1494), item 22 (1635-1638), item 28 (1710-1722), item 53 (1983-1985), item 56 (2009-2012); spec 4.1 step 1 (542-545), section 9 (823-824).
* **Discrepancy Description**: The plan names seven line types but never defines their payloads: `status` (field name? the step strings "Finding matching products... Calculating payments... Checking wording..." appear only in section 9), `options` (which of `options_id`, `calculator_output`, `inputs_echo`, `inputs_source`, `disclosure_block`?), `proposals` (list of what?), `explanation` (`text`, `footer?`), `fallback` (`text`, `marker`, `audit_event_id`), `error` (`code`, `message`, `retryable`), `done` (`event_ids` of what?). Item 22 gives no request body; section 3 says structured form state travels with each turn while 4.1 shows `{ text }`.
* **Rationale & Recommendation**: Write the zod union for the stream lines in item 9 with every field, list the fixed status strings, and define the request body (`{ text, session_id }`, see IR-1 for typed fields).

### IR-17. Compliance-owned fixed texts are referenced everywhere and written nowhere; the out-of-scope reply's shape and home contradict the spec and each other - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`, `egm-style`
* **Affected Scope:** Items 25, 32, 38, 49, 58 (lines 1676-1677, 1768-1772, 1817-1823, 1939-1941, 2032); tests 75, 81 (2170, 2222-2223); spec 4.1 (581-585), 4.1 step 4 (564).
* **Discrepancy Description**: The out-of-scope reply, the fallback reply, the "per-product canned sentences", the RESPA line, the schedule line format, the chat footer text, the "What happens next" line and the clarification question templates are all "exported as constants" but not given. The out-of-scope reply is "two sentences" in items 25 and 38 but the spec (581-583) and test 81 say one sentence plus two actions; it is owned by the prompt file (spec 584, item 25) and by `fallback.ts` constants (item 38), two sources for a string the submission document quotes verbatim. Test 81 asserts "contains the first fixed sentence" against a sentence the plan does not contain. Item 38's "The fallback reply (answers what can be answered ...)" describes behavior a constant cannot have.
* **Rationale & Recommendation**: Add an appendix listing each constant verbatim (or "placeholder: <text>" with Compliance as owner). Define the out-of-scope reply once as "one fixed sentence followed by two fixed action offers"; make `fallback.ts` the single owner; item 27 interpolates the constant into the system text (then `versions.ts` hashes `fallback.ts` too, or hashes the rendered prefix); items 25 and 81 reference the constant. Pin the footer to one string and put "What happens next" in item 32 and `HomeownerViewProps`.

### IR-18. Catalog parameters are absent, term semantics are undecided, and test 74's golden cases have no oracle and two cases no matching input - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`, `egm-style`
* **Affected Scope:** Item 30 (lines 1732-1741), item 31 (1743-1763), item 26 (1691), item 74 (2158-2163); spec section 12 (913), CUJ 1 (206, 210-211).
* **Discrepancy Description**: No APR (bps) for any product, no full term for `zero_intro_18m` or `deferred_12m`, no `schemaVersion` value, and "standard APR" is used (1736, 1737, 1760) but never declared as a field. `calculate({ amountCents, termMonths, products })` takes one `termMonths`, but `fixed_10y` implies 120 months and CUJ 1 says options are "ordered by term"; whether `termMonths` overrides or the product's term wins is undecided. "Five golden cases, hand-computed" are not written down (inputs, expected payment, finance charge, total, schedule rows). "0% intro paid off before the promo end" and "deferred interest avoided/triggered" imply a prepayment or payoff input that `calculate()` does not have: as specified the zero-intro payment is principal over the full term so the balance is never zero at month 18, and the deferred mechanic always computes both schedules.
* **Rationale & Recommendation**: Put a three-row table in item 30: id, mechanic, term months, APR bps, promo months, standard APR bps, and the `schemaVersion` value. State in item 31 that `termMonths` applies only to `fixed` and each other product uses its catalog term (or remove it). Add to item 74 a table of five concrete calls with expected outputs to the cent, and rename the cases to what the calculator produces (fixed; zero_intro promo and post-promo schedule; zero_intro four-cell totals; deferred primary "paid by month 12"; deferred consequence schedule), or add a `payoffAtMonth?` input.

### IR-19. `calculate_payment` tool schema: `product_ids` optionality under `strict: true` and the `value` type of `propose_field_fill` are undecided - Severity: Major
* **Reviewer Lens:** `egm-codebase-details`
* **Affected Scope:** Item 26 (lines 1690-1693); spec 4.1 step 3 (553-554 "defaulting to all three products"); item 25 (1677-1678 "all three unless the contractor named one").
* **Discrepancy Description**: The spec says `product_ids` defaults to all three, item 25's prompt rule says the model always passes them, and item 26 does not say whether the property is required under `strict: true` or who applies the default. `value` on `propose_field_fill` has no declared type while `zodForField()` parses it.
* **Rationale & Recommendation**: Declare `product_ids` required and non-nullable with the default in the prompt rule only; declare `value: string`, parsed server-side with `zodForField()`; state both in item 26.

### IR-20. Option labels are referenced everywhere and defined nowhere - Severity: Major
* **Reviewer Lens:** `egm-codebase-details`
* **Affected Scope:** Item 9 `PaymentOption` (line 1487), item 25 (1675 "refer to options by label"), item 28, item 57 (2019 "shows options by label"); CUJ 1 (208), 4.2 (600 "Option A costs less per month").
* **Discrepancy Description**: `PaymentOption` lists no `label`; the prompt, the number-match check and the table all depend on labels being figure-free and stable.
* **Rationale & Recommendation**: Add `label: string` to `PaymentOption` (e.g. "Option A" by catalog order, plus `product_name`); state it in item 31's return shape and in the tool result the model sees.

### IR-21. CUJ 2's "not re-proposed because `$30K` equals the amount already confirmed" has no implementing item - Severity: Major
* **Reviewer Lens:** `egm-codebase-details`
* **Affected Scope:** Items 19, 28, 29 (1590-1608, 1715-1716, 1727-1730); CUJ 2 (226-227).
* **Discrepancy Description**: No command or verifier contains an equality-with-confirmed-value rule, so the walkthrough's stated behavior does not follow from the plan.
* **Rationale & Recommendation**: In `proposeFieldValue` (item 19): if the normalized proposed value equals the field's current confirmed value, drop and log (`field.proposed` with `dropped_reason: "equals_confirmed"`, or no event); add the case to item 77.

### IR-22. Route request and response shapes for decisions, proposal reject, send and audit are undefined; path prefixes are ambiguous - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`
* **Affected Scope:** Item 21 (1622), item 23 (1649-1652), item 47 `decide(taskId, proposalId, action, payload)` (1917-1921), item 17 (1573-1575).
* **Discrepancy Description**: `POST /api/review/tasks/:id/decisions` has no body (action enum `confirm | correct | flag`, `value` for correct, `reason_code` + `note` for flag, `locatedByReviewer` for not-located confirm). `POST .../proposals/:pid/reject`: `field.rejected` requires `reason_code`, but the contractor-side dismiss has no code in the item 11 enum (which is reviewer-oriented). `GET .../audit`: is the credit-engine count in the response or computed by the client? `POST .../discrepancies/:did/send|resolve` and `.../complete` follow a `/api/review/tasks/:id/decisions` line with `...`, so the prefix is ambiguous.
* **Rationale & Recommendation**: Write each body and response as a zod schema in item 9 and reference it from items 21 and 23; add `dismissed_by_contractor` to the reason-code enum (or make `reason_code` optional for contractor rejects); write full paths.

### IR-23. Discrepancy "send" has no command, no field and no event, and the contractor banner would appear before the question is sent - Severity: Major
* **Reviewer Lens:** `egm-codebase-details`
* **Affected Scope:** Item 23 (line 1650 `POST .../discrepancies/:did/send`), item 19 command list (1590-1593), item 48 (1933-1934), item 62 (2063-2065); spec section 3 (442-449), event list (494), CUJ 5 (279-282).
* **Discrepancy Description**: `raiseDiscrepancy` runs on confirm, so the banner (derived from "any open record") shows immediately, before the reviewer has edited and sent the question; the `send` route has nothing to call and nothing persists the edited text.
* **Rationale & Recommendation**: Add `sendDiscrepancyQuestion(recordId, text, actor)` to item 19, a `sent_at?` field on `DiscrepancyRecord`, a `discrepancy.sent` event, and define the banner as "any record with `status: open` and `sent_at` set".

### IR-24. Required application fields and enum options are not listed; CUJ 2's submit may fail; `selected_product_id` options cross the `shared/` boundary - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`
* **Affected Scope:** Item 10 (lines 1499-1505), item 19 (1603-1605), item 66 (2094-2096); CUJ 2 (219-221, 233).
* **Discrepancy Description**: `submitApplication` "throws when a field marked `required` ... is empty", but no field's `required` value is given. If `employer_name` or `employment_status` is required, nothing in the seed or the copilot fills them and CUJ 2's submit fails. `project_type` and `employment_status` enum `options` are not listed, and `selected_product_id` options cannot be imported from `server/domain/catalog.ts` into `shared/`.
* **Rationale & Recommendation**: Add a `required` column to item 10 (minimum consistent with CUJ 2: `project_type`, `project_amount`, `requested_loan_amount`, `preferred_term_months`, `selected_product_id`, `homeowner_first_name`, `homeowner_last_name`, `property_zip`, `stated_annual_income`); list enum options; move the product id list to `shared/catalog-ids.ts` so both the schema and the catalog read it.

### IR-25. Seed vs "Load demo project" semantics contradict CUJ 1/2, omit `requested_loan_amount`, and the demo application id is unnamed - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`, `egm-style`
* **Affected Scope:** Item 66 (lines 2091-2096), item 21 (1624-1626), item 52 (1976 `/audit/:applicationId`); CUJ 1 Given (202-203), CUJ 2 Given (219-221), 4.4 step 1 (619-621).
* **Discrepancy Description**: "one draft application with `stated_annual_income` 85,000 and a roofing project at $30,000 (filled by 'Load demo project')" is ambiguous: is the application empty at boot and filled by the button, or pre-filled? CUJ 2 says `requested_loan_amount` is filled and confirmed, but item 66 lists only income and project amount. The seed has "three document records" while `attachDocument` is the sole emitter of `document.attached` on Load demo; re-attaching seeded records is undefined. `stated_annual_income` 85,000 has no unit while item 12 stores cents. The contractor and reviewer ids are named but the application id is not.
* **Rationale & Recommendation**: State: "boot: application `app_demo_001` exists with all fields empty and no documents; Load demo project sets `project_type: roofing`, `project_amount: 3000000`, `requested_loan_amount: 3000000`, `stated_annual_income: 8500000` (cents) through <command> and calls `attachDocument` three times."

### IR-26. `session_id` is required on every audit event and never generated anywhere - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`
* **Affected Scope:** Item 9 base fields (line 1489), item 17 (1571), item 18 (1581 "per application session"), items 22, 28, 53; spec line 475.
* **Discrepancy Description**: No item says who generates `session_id` (client per page load? server per process? sent in the body?).
* **Rationale & Recommendation**: "`session_id`: a UUID generated by the client on page load, sent as a header from `api.ts` on every write; the server stores it on the transcript" (or one per server boot, logged in `/api/healthz`); state it in item 17 and item 53.

### IR-27. react-pdf and the root `pdfjs-dist` are two copies whose worker must match exactly; the worker path is unnamed - Severity: Major
* **Reviewer Lens:** `egm-codebase-details`, `egm-implementation-readiness`
* **Affected Scope:** Item 1 (lines 1419-1420), item 60 (2047-2048 "Sets the pdf.js worker from the bundled worker file").
* **Discrepancy Description**: react-pdf depends on its own `pdfjs-dist`; if the root pin differs (the server wants the legacy build for Node) npm installs two copies and the browser logs "The API version X does not match the Worker version Y" and renders nothing. No versions are pinned.
* **Rationale & Recommendation**: Pin the root `pdfjs-dist` to the exact version react-pdf's current release depends on; in item 60 import `pdfjs` from `react-pdf` and set `pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()`; add `renderTextLayer={false} renderAnnotationLayer={false}` to `Page` (otherwise the layer CSS imports are required).

### IR-28. pdfjs text extraction in Node: input type, item typing and coordinate conversion are unstated, and the naive version throws - Severity: Major
* **Reviewer Lens:** `egm-codebase-details`
* **Affected Scope:** Item 40 (lines 1834-1841).
* **Discrepancy Description**: pdfjs-dist v4+ rejects a Node `Buffer` ("Please provide binary data as `Uint8Array`"); `getTextContent().items` is a union of `TextItem | TextMarkedContent` needing a `'str' in item` guard; converting "PDF points with a bottom-left origin" by hand is wrong for rotated pages or non-zero MediaBox origins.
* **Rationale & Recommendation**: `getDocument({ data: new Uint8Array(await readFile(path)) })`; filter items by `'str' in item`; use `viewport.convertToViewportPoint(tx[4], tx[5])` and `convertToViewportPoint(tx[4] + item.width, tx[5] + item.height)` then divide by `viewport.width/height`; set `confidence: 1` for pdfjs words.

### IR-29. `ProposedValue.source` has no representation for `not_located` or `not_extracted` proposals - Severity: Major
* **Reviewer Lens:** `egm-codebase-details`
* **Affected Scope:** Item 9 (line 1485 `ProposalSource`), item 45 (1886-1890), item 61 (2055-2057); spec section 3 (430-431: `box` requires `bbox` and `words`).
* **Discrepancy Description**: A not-located proposal has `document_id`, claimed `page`, `quoted_text` and no bbox; a not-extracted proposal has only `document_id`. Neither fits `message | box | formula` as defined, yet item 61 renders "the quoted text, the claimed page" for them.
* **Rationale & Recommendation**: Define `box` as `{ document_id, page, bbox: Box | null, words: PositionedWord[], quoted_text: string }` and allow `page: null, words: []` for `not_extracted`; or add a fourth `kind: "document"` variant. Update section 3 and item 9 together.

### IR-30. Document-schema field ids are undefined and the proposal `field_key` namespace collides across documents - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`
* **Affected Scope:** Item 11 (lines 1516-1522), item 45 (1886-1890), item 46 (1901-1902), item 47 (1915), item 67 (2101); spec section 3 invariant (437-438).
* **Discrepancy Description**: Fields are named in prose ("gross pay this period") but ids are never given; they are the keys of the extraction output schema, the fixture, `ground_truth.json`, `derived.inputs` and the reviewer grouping. `ProposedValue.field_key` is a single string; estimate and scope letter both have "contractor name", so extracting the scope letter after the estimate would mark the estimate's proposal `superseded` under "at most one live proposal per field per source kind".
* **Rationale & Recommendation**: List the ids in item 11 (e.g. `employer_name, pay_period_start, pay_period_end, pay_frequency, gross_pay, net_pay, ytd_gross, annualized_income; contractor_name, project_description, estimate_date, total_amount, line_item_count; property_address, scope_summary, start_date, contractor_name`) and state `field_key = "<slot>.<field_id>"` for document proposals (or key the invariant on `(field_key, source.kind, source.document_id ?? null)`).

### IR-31. The hallucinated-pointer rejection has no outcome in the proposal model, and value containment fails for enum and date fields - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`
* **Affected Scope:** Item 43 (lines 1865-1866), item 44 (1874-1876), item 45 (1886-1890); spec 4.4 step 5 (647-648), G7.
* **Discrepancy Description**: `locate` "reject[s] as a hallucinated pointer" but `match.method` is only `exact | normalized | not_located | not_extracted`; is a proposal created (with which method), or is the field dropped (then the reviewer sees no row, contradicting G7)? The check compares the normalized quote to the normalized value; for enum fields (`pay_frequency`: quote "Bi-Weekly", value `biweekly`) and dates it fails unless `value` is the as-written string.
* **Rationale & Recommendation**: State that a rejected pointer yields a proposal with `match.method: "not_located"`, the quoted text, and `rejected_pointer: true` in `extraction.completed.per_field` (or add a fifth method). State that `value` is the as-written string and give the enum/date normalization map applied after `locate`.

### IR-32. Derived-value rules conflict on confirmed-but-not-located inputs, misname the flag, and supersede a confirmed proposal - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`, `egm-style`
* **Affected Scope:** Item 46 (lines 1896-1909); spec 4.4 step 6 (651-659), CUJ 4.
* **Discrepancy Description**: "if every input is `confirmed` or `edited`, evaluate" versus "if an input is `not_extracted`, `not_located` or rejected, create no derived value": `not_located` is a match method, not a state; a not-located input confirmed with the acknowledgement satisfies both branches. The flag is always `pay_frequency_not_located`, even when gross pay is the missing input (the spec scopes it to the frequency). "Record a flag" names no entity or event (the derived proposal does not exist yet). Superseding a prior derived proposal that is already `confirmed` by `system` is outside the section 3 invariant (supersede applies to `proposed`). `rejected` is unformatted beside formatted `not_extracted`/`not_located`.
* **Rationale & Recommendation**: Decide on state, not method: inputs are final when state is `confirmed` or `edited` (including confirmed-not-located); `rejected` or `not_extracted` inputs block; `proposed` inputs wait. Record the block as a `field.rejected` event on a freshly created formula proposal with `value: null` and reason `pay_frequency_not_located` for the frequency, `source_not_located` for gross pay, so the reviewer row exists. Allow `superseded` from `confirmed` for `source.kind: "formula"` only, in section 3 and item 9.

### IR-33. `_fixture: true` is not in the `model.call` schema the audit log validates, so fixture replay either fails validation or shows LIVE - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`, `egm-style`
* **Affected Scope:** Item 45 (line 1883), item 9 (1489-1492), item 17 (1571-1572), item 63 (2073); spec event schema (479-481).
* **Discrepancy Description**: The audit log "validates against the union"; a `model.call` with `_fixture` is either rejected or silently stripped, and if no `model.call` is emitted on replay the MOCK/LIVE badge ("from `_mock` or `model.call`") has no row to decorate. Which event carries the field is unstated.
* **Rationale & Recommendation**: Add `_fixture?: boolean` to `model.call` in section 3 and item 9 (or reuse `_mock`), state that replay emits a `model.call` with `raw_input` = the built prompt and `raw_output` = the fixture entry, and have item 63 render MOCK when either `_mock` or `_fixture` is set.

### IR-34. `Verdict` contract vs judge return shape drift; the orchestrator cannot distinguish "judge said block" from "judge unavailable" - Severity: Major
* **Reviewer Lens:** `egm-codebase-details`, `egm-implementation-readiness`
* **Affected Scope:** Item 9 (`Verdict`, line 1488), item 34 (1785-1789), item 37 (1813-1815); spec section 6 (734), event schema (483-484).
* **Discrepancy Description**: `GuardrailCheck.check()` returns `Verdict { pass, layer, reason?, matched? }`, which has no `outcome`; item 37 "returns `outcome: "judge_unavailable"`". The judge's `category` enum values are not listed, and the mapping of `{ verdict, category, rationale }` to `Verdict` and the meaning of `verdict` vs `outcome` on `guardrail.verdict` are unstated.
* **Rationale & Recommendation**: Add `outcome: "pass" | "blocked" | "judge_unavailable"` to `Verdict` (section 6, item 9); state that the orchestrator maps `judge_unavailable` to `guardrail.judge_unavailable` with its own fallback; list the `category` values in item 37.

### IR-35. Discrepancy reason codes and reviewer flag reasons are conflated; "one template per reason code" is unimplementable - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`
* **Affected Scope:** Item 11 (lines 1523-1525), item 48 (1931-1932), item 49 (1936-1941), item 61 (2054).
* **Discrepancy Description**: The enum mixes reviewer Flag reasons (`illegible`, `wrong_document_type`, `missing`) with discrepancy reasons; a homeowner question template for `illegible` has no meaning. Which code `compareOnConfirm` passes for the income rule vs the requested-amount rule is unstated (`mismatch_with_stated` for both means one template, not one per code).
* **Rationale & Recommendation**: Split into `FlagReason` and `DiscrepancyReason` (`income_outside_tolerance`, `requested_amount_over_estimate`), emit one per tolerance rule, and give item 49 exactly those two template texts with placeholder names.

### IR-36. Deny-list and number-match test oracles are unwritable: "paraphrases" and "you'll get style phrasings" are undefined and exceed the spec's closed verdict list; the allowed set never includes term tokens or promo figures - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-style`, `egm-codebase-details`
* **Affected Scope:** Item 35 (lines 1794-1798), item 36 (1803-1808), item 75 (2168-2174); spec Overview (30-34), section 6 (742-746), section 12 (914).
* **Discrepancy Description**: The Overview defines verdict words as exactly five and section 6 says the deny-list is "word-boundary regexes over the verdict words"; item 35 adds open-ended "'you'll get' style phrasings" and item 75 asks for "paraphrases" that a regex over five terms cannot block. "Allowed contexts including ..." is open-ended. For number-match, "a 0% promo explanation" must pass, but nothing says the promo rate, post-promo payment, consequence figures or term strings are in `calculatorValues`; item 36 allows "the term in months or years" while extracting only "currency and percent tokens", so an invented "over 15 years" passes.
* **Rationale & Recommendation**: Delete the "you'll get" clause or add exact patterns to the Overview, item 35 and item 75; enumerate the must-block and must-pass strings in item 75; define `calculatorValues` in item 31/36 as the exact list (per option: payment(s), APR, promo rate, finance charge, amount financed, total of payments, consequence figures; plus the echoed inputs); either extract integers followed by "month(s)"/"year(s)" or drop the term clause; close the allowed-contexts list.

### IR-37. Quote/span normalization is defined twice with different rules while declared shared - Severity: Major
* **Reviewer Lens:** `egm-style`, `egm-implementation-readiness`
* **Affected Scope:** Item 29 (lines 1727-1730), item 42 (1853-1856), item 80 (2216).
* **Discrepancy Description**: Item 29: "normalizes both (lowercase, collapse whitespace, strip punctuation at token edges, drop currency and thousands separators)" and "Shared with extraction's span check through `extraction/normalize.ts`". Item 42: `normalizeToken` folds O to 0 and l to 1 inside numeric tokens and `normalizeText` joins hyphenated line breaks. An executor following item 29 writes a second normalizer, and item 80's "a paraphrase fails" depends on which rules apply. (The module placement across tiers is IR-2(c).)
* **Rationale & Recommendation**: Rewrite item 29: "`verifyQuote(quote, messageText)` applies `normalizeText` (item 42) to both and checks containment; it defines no normalization of its own."

### IR-38. The judge eval set of 20 labeled outputs (section 12) has no plan item - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness`
* **Affected Scope:** Items 73-81 (lines 2147-2223), Verification Plan (2305-2306); spec section 12 (918 "20 in the prototype").
* **Discrepancy Description**: No file, runner or format is planned for the judge set, yet the Verification Plan claims "every guardrail rule has at least one test" and item 83 says "No number in this file differs from section 12".
* **Rationale & Recommendation**: Add `tests/eval/judge-cases.json` and a judge mode to item 73, or change section 12 to say the 20 cases are specified in `docs/evals.md` only and not run in the prototype.

### IR-39. Whether the submit route awaits `enqueueExtraction` is unspecified, with a visible UX consequence - Severity: Major
* **Reviewer Lens:** `egm-codebase-details`, `egm-implementation-readiness`
* **Affected Scope:** Item 21 (lines 1623-1624), item 45 (1892-1894).
* **Discrepancy Description**: Awaited, the submit button spins through three Opus calls; fire-and-forget, rejections are unhandled. This also determines when CUJ 4's reviewer badge appears.
* **Rationale & Recommendation**: `void enqueueExtraction(ids).catch(log)` after responding; the reviewer badge refresh on tab switch (item 64) covers discovery. State it in item 21.

### IR-40. `composeHomeownerView` signature omits the disclosure block and mechanic sentences the props must contain; `HomeownerViewProps` fields are never listed - Severity: Major
* **Reviewer Lens:** `egm-codebase-details`, `egm-implementation-readiness`, `egm-style`
* **Affected Scope:** Item 33 (lines 1778-1780), item 9 (1488), item 21 (1626-1627), item 58 (2029-2033); spec 4.2 (590-595).
* **Discrepancy Description**: `composeHomeownerView(options, explanation | null, templateVersion)` "cannot be called without a disclosure block" but has no block parameter and no mechanic-sentence or "What happens next" argument; who substitutes the per-product canned sentence (item 38, a guardrail module) is unstated.
* **Rationale & Recommendation**: `composeHomeownerView({ options, disclosureBlock, explanation, mechanicSentences, templateVersion })` with `disclosureBlock: DisclosureBlock` required, returning `BorrowerFacingMessage`; the route substitutes the canned sentences from `fallback.ts` before calling; list `HomeownerViewProps` fields in item 9.

### IR-41. The Fallback tier has no implementation items and depends on a call shape the design says is incompatible - Severity: Major
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`, `egm-style`
* **Affected Scope:** Tier table (line 2276), fallback paragraph (2292-2294), items 40-45; spec Alternative O (1137 "citations are incompatible with structured output formats on the same request"), section 7 (790-791).
* **Discrepancy Description**: "replaces 39 to 43 and 60" names no file, no SDK request shape (a `document` block with citations enabled, no `output_format`, so a non-structured call plus a parser), no mapping to `ProposedValue.source` or `match.method`, and no reviewer rendering. Item 45 `extract.ts` is not replaced but calls `locate` (43) and the adapters (40/41). The image pay stub (no text layer) has no citation path, and that is where the not-located demonstration lives.
* **Rationale & Recommendation**: Add an item "45b `server/extraction/citations.ts`" with the request shape, response parsing, `source.kind: "citation"` (added to section 3's union) and the box-less reviewer row, and state that item 45 branches on a config flag; or drop the tier and state that an unfinished box pipeline ships design-only.

### IR-42. Item 24 embeds an unscheduled research task whose results the spec already asserts as fact, with no actor, location or failure decision - Severity: Major
* **Reviewer Lens:** `egm-style`, `egm-implementation-readiness`
* **Affected Scope:** Item 24 (lines 1664-1668); spec lines 551-552, 698, 705-706, 1137.
* **Discrepancy Description**: "Before the loop is written, one smoke call per claim verifies the four API behaviors ... and the result is noted beside each claim in this document." The spec presents each as settled; the plan says they are unverified; no fallback decision is given per claim (for example, if forced tool choice is accepted, or thinking can be disabled).
* **Rationale & Recommendation**: Move it to Build order step 3 as its own line ("Before item 28: run `scripts/smoke-api.ts`; record results in a 'Verified API behaviors' table under Technical Plan section 5"), and state the decision per outcome (accepted forced tool choice: keep `auto`; thinking can be disabled: still keep it on, effort `low`).

### IR-43. "No file declares a version constant" contradicts the catalog's `schemaVersion` that items 31 and 74 depend on - Severity: Major
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** Item 15 (lines 1557-1558), item 30 (1740), item 31 (1762-1763), item 74 (2163).
* **Discrepancy Description**: Followed literally, item 15 removes the integer that item 31 validates and item 74's last case ("`catalog.schema_mismatch` on a wrong snapshot version") asserts.
* **Rationale & Recommendation**: Rewrite item 15: "No file declares a content-version constant; the catalog's `schemaVersion` (item 30) is a shape version checked by the calculator and is not part of the versions block."

### IR-44. Health route named two ways - Severity: Nit
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`, `egm-style`
* **Affected Scope:** Item 20 (line 1613), item 52 (1977), item 64 (2081); spec section 8 (807 `/healthz`).
* **Discrepancy Description**: Plan says `/api/healthz`, spec says `/healthz`.
* **Rationale & Recommendation**: Keep `/api/healthz` (it must pass the Vite `/api` proxy, item 3) and correct the spec.

### IR-45. Schema files are under `shared/` in the plan and `server/domain/` in the spec - Severity: Nit
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-style`
* **Affected Scope:** Preamble (line 1398), items 10-11 (1496, 1507); spec section 2 (404, 407, 408).
* **Discrepancy Description**: Two paths for the same files.
* **Rationale & Recommendation**: Keep `shared/` (the reviewer panel renders from them) and amend the component table rows.

### IR-46. Signature drift between section 2 and items 17 and 48 - Severity: Nit
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`, `egm-style`
* **Affected Scope:** Item 17 (lines 1571-1575), item 48 (1933); spec lines 397, 448.
* **Discrepancy Description**: `append(partial)` vs `append(event)`; section 2 says `audit-log` exposes "`append(event)` and `list(applicationId)` only" while item 17 adds `countToolCalls`; `deriveApplicationStatus(app)` vs `deriveApplicationStatus(app, records)`.
* **Rationale & Recommendation**: Update section 2 to match the plan.

### IR-47. Dependency majors unpinned (zod, react-pdf, pdfjs-dist); Vite proxy port hardcoded while `PORT` is configurable; `build.emptyOutDir` - Severity: Nit
* **Reviewer Lens:** `egm-codebase-details`, `egm-implementation-readiness`
* **Affected Scope:** Item 1 (lines 1418-1421), item 3 (1438-1439), item 5 (1451).
* **Discrepancy Description**: `zodOutputFormat` support and `z.discriminatedUnion` details differ between zod 3 and 4; item 3 proxies to `:3000` while item 5 makes `PORT` configurable; Vite warns and does not clean an `outDir` outside `root` unless `emptyOutDir: true`.
* **Rationale & Recommendation**: Pin majors in item 1; read `process.env.PORT` in `vite.config.ts` or document that `PORT` is for `npm start` only; set `build.emptyOutDir: true`.

### IR-48. vitest does not load `.env`, so item 81 cannot find the key - Severity: Nit
* **Reviewer Lens:** `egm-codebase-details`
* **Affected Scope:** Item 4 (lines 1444-1445), item 81 (2219-2223).
* **Discrepancy Description**: "Tests that need a key read `ANTHROPIC_API_KEY`" but nothing populates it.
* **Rationale & Recommendation**: Add a vitest setup file that calls `process.loadEnvFile()` in a try/catch.

### IR-49. Signatures with ellipses or missing context: `withRegenerate`, `runGuardrail`, `copilotCall`/`judgeCall`, command `ctx`, `extractCall(schema, ...)` - Severity: Nit
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`, `egm-style`
* **Affected Scope:** Item 34 (lines 1788-1789), item 24 (1658-1659), item 19 (1593-1597), item 48.
* **Discrepancy Description**: `withRegenerate(generate, text, ...)` has a literal ellipsis and does not say how the reason is fed back (a user message after the assistant draft, since prefill is unavailable); `runGuardrail`, `copilotCall(params)` and `judgeCall(text)` have no way to receive `application_id`/`turn_id`/`parent_event_id` for the events they append; commands "append one primary audit event with `actor` and `parent_event_id`" but take only `actor`; `extractCall(schema, prompt)` is ambiguous between the document schema (item 11) and the zod output schema (item 44); `judgeCall(text)` drops the `client.` prefix used on the same line pair.
* **Rationale & Recommendation**: Give full signatures with a `ctx: { application_id, session_id, turn_id?, parent_event_id? }` argument; rename `schema` to `outputSchema`.

### IR-50. `VERSIONS` key names, `schema_version` and `mock_version` values are not given - Severity: Nit
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-style`
* **Affected Scope:** Item 15 (line 1556), item 9 (1489), item 50 (1952-1953); spec section 11 (887-892).
* **Discrepancy Description**: Nine artifacts are hashed but only seven `<name>` keys appear in section 11; the base-field `schema_version` and the envelope's `mock_version` values are unstated.
* **Rationale & Recommendation**: List all nine keys in item 15 (`copilot_prompt`, `judge_prompt`, `extraction_prompt`, `denylist`, `template`, `catalog`, `calculator`, `application_schema`, `schemas`); set `schema_version: 1` and `mock_version: 1`.

### IR-51. `formatMoney` output format is unspecified - Severity: Nit
* **Reviewer Lens:** `egm-implementation-readiness`
* **Affected Scope:** Item 12 (lines 1530-1532); CUJ 1 (206 "$30,000"), 4.1 ("$312.47").
* **Discrepancy Description**: Whether cents are shown (always, never, or when non-zero) determines every UI string and the number-match normalization.
* **Rationale & Recommendation**: State the rule (e.g. "always two decimals; the echoed inputs use the same formatter").

### IR-52. Item 67 arithmetic: $2,346.15 x 26 = $60,999.90, not $61,000 - Severity: Nit
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`, `egm-style`
* **Affected Scope:** Item 67 (lines 2102-2103); CUJ 5 (274).
* **Discrepancy Description**: The discrepancy test compares to the cent.
* **Rationale & Recommendation**: State the exact figure (234615 x 26 = 6099990 cents) in item 67 and CUJ 5, or change the gross to a value that annualizes evenly.

### IR-53. Section 5's 20-page cap and page batching have no home in item 45 - Severity: Nit
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`
* **Affected Scope:** Item 45 (lines 1878-1894); spec section 5 (722-724).
* **Rationale & Recommendation**: State "not built; samples are one page" in item 45 or add the cap.

### IR-54. Section 8's copilot `llm.schema_invalid` message and `catalog.unavailable` handling have no place in items 22 or 28 - Severity: Nit
* **Reviewer Lens:** `egm-implementation-readiness`
* **Affected Scope:** Item 22 (1632-1642), item 28 (1706-1722); spec section 8 (800, 802).
* **Rationale & Recommendation**: Add the two branches to item 28 (invalid tool arguments -> "I couldn't produce field suggestions for that; the explanation is below." as a `proposals` line note; catalog error -> `error` line naming the service).

### IR-55. Mock JSM `transition` has no caller; `tool.call` logging responsibility is split between callers and mocks - Severity: Nit
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`
* **Affected Scope:** Item 27 (lines 1699-1701), item 51 (1965-1967), item 50 (1952-1953).
* **Discrepancy Description**: Item 27 logs the catalog read from the caller; item 51 has the JSM mock log itself; `transition` is recorded but never called.
* **Rationale & Recommendation**: One `withMock()` wrapper that appends the `tool.call` (and say how it gets `application_id`); call `transition` from `complete(taskId)` or remove it.

### IR-56. `context.compacted` cadence and replay of prior-turn tool blocks are unstated - Severity: Nit
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`
* **Affected Scope:** Item 27 (lines 1702-1704).
* **Discrepancy Description**: Every turn after the window fills would re-report the same dropped ids; whether prior turns' `tool_use`/`tool_result` blocks are replayed in `messages` or only final texts affects cache stability and the `[m_123]` citation window.
* **Rationale & Recommendation**: "emitted once per message id on the turn it first leaves the window"; "prior turns are replayed as final text only".

### IR-57. Positioned-text details: column-gap threshold, page/line numbering base, token inclusivity - Severity: Nit
* **Reviewer Lens:** `egm-implementation-readiness`
* **Affected Scope:** Item 39 (lines 1830-1831), item 40, item 43 (1861).
* **Rationale & Recommendation**: State the gap threshold (e.g. "more than one average word width"), 1-based pages, 0-based lines and tokens, and `token_end` exclusive. (Line ownership is in IR-3.)

### IR-58. `paystub.ocr.json` shape and the "documented edit" location are undefined - Severity: Nit
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-style`
* **Affected Scope:** Item 41 (1846-1847), item 68 (2111-2112), item 72 (2144).
* **Rationale & Recommendation**: Give the JSON shape in item 41 and name the document (a comment block in `ocr-paystub.ts` or `docs/evals.md`) that records the edit.

### IR-59. Item 44 has two null representations for a missing field - Severity: Nit
* **Reviewer Lens:** `egm-implementation-readiness`
* **Affected Scope:** Item 44 (lines 1874-1875).
* **Discrepancy Description**: "`{ value: string | null, ... }` or null": the field object may be `null` or carry `value: null`.
* **Rationale & Recommendation**: Define one as `not_extracted` and forbid the other via the zod schema.

### IR-60. Item 45: parse failure after location has no outcome; actor for extraction proposals unstated - Severity: Nit
* **Reviewer Lens:** `egm-implementation-readiness`
* **Affected Scope:** Item 45 (lines 1886-1888).
* **Rationale & Recommendation**: "a value that fails `zodForField` parsing yields a proposal with `value: null`, `match.method: "not_extracted"` and `parse_error` in `per_field`"; actor is `model` with the `model.call` event as `parent_event_id`.

### IR-61. Chat-footer trigger, Retry semantics and multiple `calculate_payment` calls per turn are unstated - Severity: Nit
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`, `egm-style`
* **Affected Scope:** Item 28 (lines 1720-1721), item 56 (2011-2014).
* **Discrepancy Description**: "attach the chat footer when the reply contains a payment figure" has no detection rule; what Retry re-sends (same text, new `message.received`?) is unstated; two tool calls in one turn produce two Options records with no rule for which the explanation and "Show homeowner view" bind to.
* **Rationale & Recommendation**: Footer when the turn stored an Options record; Retry re-posts the same text as a new message; the last Options record of the turn is the one bound.

### IR-62. `view.rendered.produced_by`, `tool.call.service` values and the no-model button's events are unspecified - Severity: Nit
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`
* **Affected Scope:** Item 21 (1626-1627), item 22 (1638-1641), item 17 (1573-1574), item 9.
* **Rationale & Recommendation**: `produced_by = all events with this turn_id`; for the no-model path, the button's own `tool.call` for the calculator; enumerate `service` values (`catalog`, `credit_engine`, `plaid`, `contractor_profile`, `documents`, `review_queue`, `calculator`) in item 9.

### IR-63. Test oracles that cannot be written as stated: item 81's "likelihood words", item 79's "reachable only from the review path", item 80 housing tool-schema assertions - Severity: Nit
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-style`
* **Affected Scope:** Item 79 (lines 2210-2211), item 80 (2216-2217), item 81 (2223).
* **Rationale & Recommendation**: Give the word list; restate item 79 as "`confirmValue` alone emits no `discrepancy.raised`"; move the `fillableFields()` enum assertion to a `tests/tools.test.ts`.

### IR-64. Item 48 "always confirmed, because extraction starts at submit" contradicts the section 3 guard; percent denominator unstated - Severity: Nit
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`
* **Affected Scope:** Item 48 (lines 1927-1931); spec 451-452.
* **Rationale & Recommendation**: Keep the guard ("absent -> no record, re-run at submit"); state the denominator for `difference.percent` (stated value).

### IR-65. `copilot.enabled: true` on the contractor profile has no consumer; the UI does not read `COPILOT_ENABLED` from `/api/healthz` - Severity: Nit
* **Reviewer Lens:** `egm-implementation-readiness`
* **Affected Scope:** Item 51 (line 1964), items 56 and 64.
* **Rationale & Recommendation**: Either have `CopilotPanel` read both flags from `/api/healthz` or drop the profile field. (The missing error code is IR-15.)

### IR-66. Item 58 "two or three option cards": the minimum is unstated - Severity: Nit
* **Reviewer Lens:** `egm-implementation-readiness`
* **Affected Scope:** Item 58 (lines 2029-2030).
* **Rationale & Recommendation**: State that a single-product `calculate_payment` call yields one card, or that the view requires all three.

### IR-67. Fixture citations are silently invalidated by any change to the indexer; no staleness assertion - Severity: Nit
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`
* **Affected Scope:** Item 69 (2117-2123), item 78 (2194-2200).
* **Rationale & Recommendation**: Add a test that replays the fixture against the committed documents and asserts the expected `match.method` per field.

### IR-68. `field.confirmed.elapsed_ms` is in the schema but no item computes it - Severity: Nit
* **Reviewer Lens:** `egm-implementation-readiness`, `egm-codebase-details`
* **Affected Scope:** Item 47 (1917-1921); spec 487.
* **Rationale & Recommendation**: `decide()` computes it as now minus the task's `created_at`.

### IR-69. `amount_cents` conversion ("$30K" -> 3000000) is left to the model - Severity: Nit
* **Reviewer Lens:** `egm-codebase-details`
* **Affected Scope:** Item 26 (line 1691), item 25.
* **Rationale & Recommendation**: Say so in the prompt rule, or accept dollars and convert server-side.

### IR-70. `DisclosureBlock` names both a zod type and a React component - Severity: Nit
* **Reviewer Lens:** `egm-codebase-details`, `egm-style`
* **Affected Scope:** Item 9 (1488), item 32 (1768), item 57 (2016, 2022-2024).
* **Rationale & Recommendation**: `DisclosureBlockSchema` const, `DisclosureBlock` type, component `DisclosureBlockView`.

### IR-71. Zero-intro options carry two payment figures with no renderer rule; the deferred consequence line and button caption are UI strings placed in server items - Severity: Nit
* **Reviewer Lens:** `egm-codebase-details`, `egm-style`
* **Affected Scope:** Item 31 (lines 1754, 1760-1762), item 22 (1641-1642), items 32, 57, 58.
* **Rationale & Recommendation**: Say which figure `OptionsTable` shows as "monthly payment" and that both go into `calculatorValues`; the calculator returns fields and items 32/57/58 name where each string renders; move the caption to item 56.

### IR-72. Tier table: the F1 row contradicts itself and "if time" conflicts with the Verification Plan's `npm run eval` gate - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** Line 2274, lines 2307-2308.
* **Discrepancy Description**: "Nothing beyond the floor" in the Meaning cell with an item in the Items cell; `npm run eval` printing pass is a verification condition while 73 is "if time".
* **Rationale & Recommendation**: F1 row Meaning "The eval fixture, built after the floor", Items "73"; Verification: "if item 73 was built, `npm run eval` prints pass for every case".

### IR-73. Item 11 omits the tolerance numbers it owns - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** Item 11 (lines 1518-1521); spec 671-673, 398.
* **Rationale & Recommendation**: Put 10% / $5,000 and 5% in item 11, since the schema files are the tolerance version.

### IR-74. One concept, several names (terminology drift inside the plan and against the spec) - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** Lines 1607/1630 (slot flag), 1720/1772/2014/2021 (footer), 1471/2262/2268/2293 (cut line), 2267-2268/2274-2275/2288/2310/2312 (tiers), 1739/2031 (catalog sentence), 1524/1885 and spec 633/804 (type mismatch), 1843/1881 and spec 407/461 (adapter id), 1917/1947 (`decide`), 1593-1594 ("value commands").
* **Discrepancy Description**: Type mismatch is `extraction_status: type_mismatch`, reason code `wrong_document_type`, spec `document_type_mismatch`, error `extraction.document_type_mismatch`; adapter id is `ocr_fixture`, `ocr-fixture`, `ocr-fixture.ts` with no stated values for `document.adapter`; `decide(taskId, proposalId, action, payload)` (reviewer) and `decide(applicationId)` (credit engine, which G2 says nobody calls) share a name, so a grep for `decide(` cannot verify G2.
* **Rationale & Recommendation**: State `adapter: "pdfjs" | "ocr_fixture"`; give the type-mismatch mapping (status, error code, flag reason) in item 45; rename the reviewer gesture `applyDecision`; pick one term for each of footer, slot flag, cut line and tiers.

### IR-75. Casing rule never stated; the same field appears in two casings - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** Lines 1608 (`locatedByReviewer` vs spec `located_by_reviewer`), 1691-1692 vs 1746 (`amount_cents` vs `amountCents`), 1740 (`schemaVersion` vs `schema_version`), 1712 vs 1500.
* **Rationale & Recommendation**: One preamble sentence ("wire, audit and schema field names are snake_case; TypeScript identifiers are camelCase; command options use the schema's snake_case names"), then fix 1608.

### IR-76. Item structure: "Type / Scope" has no fixed semantics, headings deviate from `N. path (Create)`, and no item names its test - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** Lines 1417, 1589, 1726, 1745, 1852, 1860, 2044, 2149, 2160-2221 (Type / Scope values); 1507, 1955, 2107, 2117, 2256 (headings).
* **Rationale & Recommendation**: Fix the field to layer plus kind ("Server module", "React component", "Shared schema", "Unit test (no key)", "Doc"); full path per file and marker only Create or Modify; add a "Tested by: item N" line to each tested item.

### IR-77. Redundancy: the submit hand-off is described four times, the credit-engine zero-count rationale three times, the $30,000/$31,000 example three times, and several rationales restate the spec - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** Lines 1604-1607, 1623-1624, 1629-1630, 1892-1893 (hand-off); 1574-1575, 1946-1948, 1959-1961 (credit engine); 1930-1931, 2104-2105, 2206 (example); 1404-1406, 1583-1585, 1787-1788, 1893-1894, 1928, 1961-1963, 2112-2113, 2267-2269 (restatements).
* **Rationale & Recommendation**: One bullet in item 21 for the hand-off with items 19 and 45 pointing to it; mechanism once in item 51; example in item 79 only; delete or reduce the restatements to a cross-reference.

### IR-78. Vague quantifiers and mixed numerals - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** Lines 1512 ("usually appears"), 1703 ("last ten turns" vs spec "10"), 1796 ("including"), 2150 ("About 15"), 2161 ("Five"), 2168-2169 ("About ten", "about seven" before a list of seven), 2274 ("if time").
* **Rationale & Recommendation**: Exact counts, closed lists, numerals for counts.

### IR-79. Actorless passives - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** Lines 1426 ("outputs are committed"), 1667-1668 ("the result is noted"), 2308 ("The README walkthrough is run by hand").
* **Rationale & Recommendation**: Name the author and the build step.

### IR-80. Formatting: cross-reference style, code spans broken across line wraps, heading case, "&" - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** Lines 1952, 1962-1963, 2241 (bare "section N" vs "Technical Plan section N"); 1423-1424, 1511-1512, 1651-1652, 1788-1789, 1813-1814, 1828-1829, 1889-1890, 1983-1984 (broken spans); 1411, 2265, 2296 (heading case); 2303 ("&").
* **Rationale & Recommendation**: One cross-reference form; keep each span on one line; one heading case; "and".

### IR-81. Single-paragraph items that are rule lists - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** Preamble (1396-1409), item 8 (1466-1475), item 19 (1590-1608), item 28 (1709-1722), item 31 (1746-1763), item 45 (1881-1894), item 46 (1899-1909), item 51 (1958-1967).
* **Rationale & Recommendation**: One bullet per rule, grouped by function or file; in item 19 keep the `confirmValue` rules (1599-1602, 1607-1608) together.

### IR-82. `plaid/stub.ts` has no stated content - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** Item 51 heading (1955), line 1961, item 50 (1949).
* **Rationale & Recommendation**: "a class implementing `PlaidService` whose one method throws".

### IR-83. README item is incomplete relative to the current README and item 70 - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** Item 8 (1466-1475), item 70 (2130-2131); `/home/hdx/code/goodleap-loan-assistant/README.md` lines 29-57.
* **Rationale & Recommendation**: Say what happens to "Planned deliverables" and "Repository layout"; list item 70's README line in item 8.

### IR-84. Verification Plan wording does not match items 1 and 4 - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** Lines 2298, 2300; item 1 (1423-1424), item 4 (1444).
* **Discrepancy Description**: "type-check the server and build the web app" omits the web type-check; "runs every file under `tests/`" vs the `tests/**/*.test.ts` glob (and `tests/eval/cases.json` is under `tests/`).
* **Rationale & Recommendation**: "type-checks both configs and builds the web app"; "runs every `*.test.ts` under `tests/`".

## Categories where reviewers reported nothing

* Package names and the Anthropic SDK call shapes named in the Facts (`messages.create` manual loop, `messages.parse` + `zodOutputFormat`, `strict: true` tools with `tool_choice: auto`, `output_config.effort`, `cache_control` on the last stable system block, `stop_reason: "refusal"` mapping, SDK error classes) are used correctly.
* The Vite + Express single-process layout (`root: "web"`, `outDir: "../dist/web"`, `/api` proxy, `start` = `vite build && tsx server/index.ts`) is internally consistent apart from IR-2(g) and IR-47.
* NDJSON over a POST body with `res.write` per line is a sound choice given the design's rejection of SSE and works through the Vite dev proxy.
* The stream line type names, the command list (section 2 vs item 19), the event type list (section 3 vs item 9, modulo IR-33), and the application status, document `extraction_status`, proposal state and match-method enums are consistent across the two halves of the document.
* No hedging phrases, apologies, salesmanship or first-person asides were found in the plan.

---

## Resolution (Elephant, applied without a gate at the author's instruction)

All 84 findings were classified PROPOSE FIX and applied by rewriting the Detailed Implementation Plan in full and amending the specification where the plan's fixes required it. None was contested, escalated or declined. The substantive changes:

* IR-1: typed values are server state through a `setFieldValue` command (state `typed` counts as confirmed); nothing travels with a turn but the text.
* IR-2: shared primitives (`shared/normalize.ts`, `shared/reason-codes.ts`, `deriveBanner`) and the documents mock moved to the floor; `versions.ts` records `absent` for missing files; items 21, 25, 50 split per tier; placeholder routes in step 1 so `vite build` passes; a step 0 for the one-time sample scripts; the "one tier" claim now holds for items and named parts.
* IR-3: `bbox` nullable; the adapters own `line` and `index`; `toIndexedLines` renders from them; `spanBox` is null when any word lacks a box; `locate` returns `not_located` for such a run.
* IR-4: `inputs_source` per input; amount = `requested_loan_amount`; term = `preferred_term_months` or the catalog term; the no-model button needs only the amount.
* IR-5 to IR-8: the server tsconfig excludes `scripts/samples`; Express 5 pinned with the `/{*splat}` fallback; `.env` loaded in a try/catch with defaults; `data/` created at boot; an injectable audit sink; `reset` truncates.
* IR-9 to IR-11: `appendMessage`, `setExtractionStatus`, `attachExplanation`, `startReview`, `sendDiscrepancyQuestion` commands; `openReviewTask` as the review-module wrapper with the JSM call order; task transitions and the `manual` status.
* IR-12 to IR-15: assistant content echoed verbatim; a 3-round cap and `max_tokens` handling; per-call timeouts with no SDK retries; an error mapping table with `retryable`, and `llm.auth_failed`, `copilot.disabled`, `internal` codes.
* IR-16, IR-22: the stream lines, route bodies and responses as named zod schemas with full paths.
* IR-17: a "Fixed texts" table at the top of the plan, owned by `fallback.ts`, interpolated into the prompt, quoted by tests and the submission document.
* IR-18: the catalog parameter table (APR, terms, promo months) and five golden cases computed to the cent (fixed $396.29 on $30,000; zero-intro $250.00 then $414.14; deferred $2,500.00 paid in full, or $5,149.63 added and $602.83 after).
* IR-19 to IR-21, IR-24 to IR-26: tool schema types; `label` on options; the `equals_confirmed` drop; required fields and enum options with `shared/catalog-ids.ts`; an empty seed filled by "Load demo project" with cents; `x-session-id` from the client.
* IR-27 to IR-35: the react-pdf worker and version pin; pdfjs input and coordinate handling; `box` sources with null geometry and `not_extracted` rows; `field_key = "<slot>.<field_id>"`; `rejected_pointer`; derived values decided by input state; `_fixture` on `model.call`; `Verdict.outcome`; `FlagReason` and `DiscrepancyReason` with two templates.
* IR-36 to IR-43: closed deny-list and test lists; one normalizer; `judge-cases.json` and `eval:judge`; fire-and-forget extraction; `composeHomeownerView` with a required block; the fallback tier removed (an unfinished box pipeline ships design-only); `smoke-api.ts` as a step 3 line with a decision per outcome; the `schema_version` wording.
* Nits: applied as recommended, including `/api/healthz` in the specification, `shared/` paths in the component table, the naming rule, "Layer / kind" and "Tested by" on every item, the gross pay changed to $2,350.00 so annualized income is an exact $61,100.00, `applyDecision` and `DisclosureBlockView` as the renamed identifiers, and the F1 row and verification wording.

**Status: resolved.** No findings remain open from this stage. No second round was run; the convergence rule (two consecutive clean rounds) is therefore not met, and the author accepted that trade against the deadline.
