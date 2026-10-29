# Build log

The sticky record of the prototype build: which wave is running, what each one covers, and
what happened to it. Item numbers refer to the Detailed Implementation Plan in
[the internal design](designs/loan-assistant-design.md) (section "Build order and cut line").
Updated at every change of state, not just at the end of a wave.

Last updated: 2026-10-28 21:06 PDT

## Waves

| Wave | Design step | Covers | Status | Commit |
| --- | --- | --- | --- | --- |
| 1A | 0 | `samples/` (three PDFs, OCR file, ground truth) and `scripts/samples/` (items 65 to 67, 69 to 71) | done | `996ec3c` |
| 1B | 1 | Skeleton: root config, `shared/`, store, commands, audit log, routes, mocks, placeholder web, `tests/commands.test.ts` (items 1 to 7, 9, 10, 11 reason codes, 12 to 20, 21a routes, 48a, 49, 50a, 51, 65) | done | `996ec3c` |
| 1 close | - | Build, `npm test`, `/api/healthz`, create `.env` from the OpenRouter key, one codex review, filtered fix pass, commit, push | done: 15 fixes, 139 tests, pushed to GitLab `main` | `996ec3c` |
| 2 | 2 | Calculator, catalog, disclosure template, surface types, golden tests (items 30 to 33, 74, 76) | done: 6 fixes, 157 tests, pushed | `7672027` |
| 3 | 3 | Copilot end to end: 3A server (21a homeowner-view route, 22, 24 to 29, 34 to 38, 73, tests 75, 80, 81) and 3C web (52 to 57, 62 pulled forward from wave 4, 63, 64) | built: 359 tests; smoke passes against OpenRouter; five live copilot turns exercised the guardrail; done: fix passes applied, 516 tests, browser walk clean (three live turns, homeowner view and back, audit) | `2b7cc96` |
| 4 | 4 | README walkthrough (8), docs (82 to 85); the audit view (62) was built in wave 3 | done; the walkthrough was checked against the running app by the docs agent (four live turns, the no-model button, the review path on the fixture) | see git log |
| 5 | 5 | Document extraction and review: 5A server (11, 23, 25b, 39 to 47, 48b, 50b, 68, 78, 79; **running**, Sonnet, in parallel with wave 3 since its files are disjoint; the 21b hook and the router mount are applied by me after wave 3A lands) then 5B reviewer web (58 to 61); 83 in wave 6 | 5A built: fixture recorded live (text PDFs 9/9 fields, pay stub 7/7 with 6/6 located); hooks applied by me; review filtered (8 kept); fix pass done (fixture re-recorded); 5B reviewer screen built and driven end to end in a real browser (boxes on the right words, net pay not located, discrepancy sent, reply, resolve, complete); 516 tests | `2b7cc96` |
| 6 | 6 | Eval runner (72) and judge cases; prompt fix pass with one live re-run (15 of 15, judge clean); submission doc trimmed; cleanup pass and verify script; README and evals doc updated with the results | done: 558 tests, verify script green on the final tree | `c0e68d1` + final commit |

Each wave closes the same way: I build and run the suite myself, one independent codex review
of the uncommitted code, a visible filter of its findings, one fix pass, one commit, push to
GitLab `main`.

## Wave notes

### Wave 1A

* Built: `samples/estimate.pdf` and `samples/scope_letter.pdf` (text PDFs), `samples/paystub.pdf`
  (image-only), `samples/paystub.ocr.json` (14 lines; exactly one word without geometry, the net
  pay figure, engineered for the not-located path), `samples/ground_truth.json`.
* Scripts under `scripts/samples/` with their own lockfile; the grader never runs them.
* Only retry: the agent's own null-finder bug. Layout and OCR were right the first time.

### Wave 1B

* Built: root config, `shared/` (schemas, application schema, catalog ids, reason codes,
  formatters, normalizer), `server/` (config, versions, errors, audit log, store, commands,
  banner, routes, typed mocks and stubs), placeholder `web/`, `samples/seed.json`,
  `tests/commands.test.ts` and an extra `tests/foundation.test.ts`.
* Verified by me: `npm run build` exit 0, `npm test` 51 passed, boot on port 3457 with
  `/api/healthz` answering (port 3000 is taken on this machine by an unrelated server).
* The commit `996ec3c` was also built and tested standalone in a throwaway worktree: build
  exit 0, 98 tests (the wave 2 test files were not part of it).
* Agent additions beyond the plan, kept: `server/api/http.ts` helpers, `CommandError`,
  `audit.emit`, four event types the plan named but never typed (`application.submitted`,
  `options.stored`, `options.explained`, `review.started`), a `canvas` override in
  `package.json` so `pdfjs-dist` installs no native module.
* `.env` created from the OpenRouter key once `.env` was in `.gitignore`.
* Found while booting: `process.loadEnvFile()` does not override variables the shell already
  exports, and this shell exports `ANTHROPIC_BASE_URL=https://api.anthropic.com`, so the
  `.env` OpenRouter URL was silently ignored. Fix queued for the wave 1 fix pass (see decisions).
* Codex review: the recorded command (`codex exec review --uncommitted "<prompt>"`) is rejected
  by this codex version (`--uncommitted` cannot be combined with a prompt). Codex's own sandbox
  (bubblewrap) also cannot start on this machine, and running it unsandboxed was blocked by the
  auto-mode permission classifier. So the review runs on a bundle: `scripts/review-bundle.sh`
  writes the uncommitted files plus named design line ranges to stdout, and that goes to
  `codex exec review -` on stdin. The wave-loop skill was corrected.

### Wave 1 review (codex, gpt-6.1, 18 findings)

Kept, going to the fix pass (codex number in parentheses):

1. (2) Audit log committed an event to memory before the sink write; persist first, then commit.
2. (7) Paired events (`application.submitted` + `state_changed`, `review.completed` +
   `state_changed`) are validated and written as one batch.
3. (3) `createReviewTask` checked only the document ids passed in; they must equal the
   application's attached documents, and all of them must be out of `pending`.
4. (4, 5 in part) Proposal field and source domains: message-sourced proposals target
   copilot-fillable application fields; box- and formula-sourced proposals target
   `<slot>.<field_id>` keys whose slot matches the referenced document. Field-id validation
   against the document schemas waits for wave 5, which creates those schemas.
5. (6) The verified income value is validated as integer cents before the confirmation event.
6. (8) `/api/reset` ordered so a failure cannot leave the store empty.
7. (9) Document proposals are rejected once the application is `documents_reviewed`.
8. (10) `raiseDiscrepancy` verifies both value pointers and that the stated value is confirmed
   (the test used a made-up `p_x`).
9. (11) `resolveDiscrepancy` requires the question to have been sent.
10. (12) Vite's dev proxy reads `PORT` from the root `.env`.
11. (14) Required payload fields typed `z.unknown()` accepted `undefined`; now a JSON value.
12. (15) The normalizer turned `$42.50;` into `4250`, equal to `$4,250`.
13. (17) A missing contractor profile leaked an internal message.
14. (18) Source existence is checked before the equals-confirmed and not-fillable drops.
15. (mine) `.env` overrides the shell (design items 4 and 13).

Dropped:

* (1) "Audit file truncated at boot": kept by decision, see item 13 of the design and the
  decision table below.
* (13) "Homeowner-view route missing": the build order defers that route to wave 3.
* (16) "Equals-confirmed drop for document values": document proposals are wave 5 work and the
  store holds no confirmed document values yet; revisit there.

### Wave 2

* Built: `server/domain/catalog.ts`, `server/domain/payments/calculator.ts`,
  `server/domain/disclosures/template.ts`, `server/domain/surfaces.ts`, `tests/calculator.test.ts`
  (26 tests), `tests/template.test.ts` (15 tests, also covers `surfaces.ts`); the catalog wired
  into the typed mock in `server/services/index.ts`.
* All five golden cases of item 74 match to the cent. Extra checks the agent added: every
  schedule closes to zero over 80 amount-and-term combinations; the level payment matches an exact
  rational computation on 280 combinations; a half-even tie case is pinned (a half-up mutation
  passed every golden case and failed only the tie tests, so the tie tests are what guard the
  rounding mode).
* Interpretations accepted and written into design item 32: the APR cell of a promotional
  product shows the standard APR (reversed after the requirements audit: it now shows the
  actuarial APR of the disclosed schedule, see "Requirements audit" below); the deferred option
  gets the single-form schedule line plus the consequence line. `calculatorValues` also lists the promo and post-promo month counts
  ("18 months", "102 months") so the disclosure lines pass the number-match check.
* One edit outside the brief, accepted: a `tests/foundation.test.ts` case that asserted an
  unwired catalog now calls the mock directly with no source.

### Wave 2 review (codex, gpt-6.1, 8 findings)

Kept, going to the fix pass:

1. (1) The level payment was computed on floats and then rounded, so an exact half-cent tie
   could land on the wrong side (350 cents at 12% over one month: 353 instead of 354). Now an
   exact BigInt rational, rounded half-even.
2. (2) `composeHomeownerView` checked the disclosure block against the options by product ids
   only; it now re-renders the canonical block and requires deep equality.
3. (3) The catalog's fixed-product sentence says "ten years"; under a `term_months` override the
   homeowner view now uses a term-aware Compliance-owned variant.
4. (4) Catalog terms and rates are bounded before pricing (`catalog.schema_mismatch`).
5. (5) Duplicate product ids in a catalog are rejected.
6. (8) The years token is emitted for fractional-year terms too ("7.5 years").

Dropped:

* (6) "Deferred option should use the two-part schedule line": contradicts the decision recorded
  in design item 32 (single-form line plus the consequence line).
* (7) "The template must not call `monthsAfterPromo`": the template does no arithmetic itself;
  reading a count from the calculator is the recorded reading of item 32.

### Wave 2 fix pass

* All six fixes landed with tests; the five golden cases still match to the cent. The agent also
  moved the monthly-interest product to BigInt after finding that the largest amount at the
  largest APR overflowed a float.
* Known and left open: for a one-month loan an exact half-cent tie on an odd principal makes the
  exact-rational level payment differ by one cent from the schedule's single payment (75 cents at
  8% gives 76 against 75); the catalog's APRs never hit that case. The years token for 12 months
  reads "1 years", the form the normalizer canonicalises to.
* Passed to wave 3A: the normalizer does not tokenize decimal years ("7.5 years"), so
  number-match must learn that pattern; `CANNED_SENTENCE` for a fixed option under a term
  override must use `fixedSentenceForTerm`.
* `FIXED_SENTENCE_FOR_TERM` added to the design's fixed-texts table.

### Wave 3C (web) report

* Built: `web/src/api.ts`, `stream.ts` (NDJSON reader and turn reducer), `conversation.ts`,
  `present.ts`, `types.ts`, routes `ContractorView`, `HomeownerView`, `AuditView`, components
  `ApplicationForm`, `CopilotPanel`, `OptionsTable`, `DisclosureBlockView`, `RoleTabs`,
  `KeyBanner`, `styles.css`; 38 unit tests on the pure parts. Verified by the agent against the
  live server with a script (every reply parses; submit blocked then succeeded; the
  disabled-by-operator stream drives the panel state). No browser check yet: mine comes once 3A
  lands.
* Interpretations: the no-model button follows the design's `payment-options` route rather than
  the brief's wording; options on the homeowner view are stable-sorted by term; chat state lives
  in a module store (survives the trip to the homeowner view, not a reload).
* Found a design inconsistency: the data model's message source carried only `message_id` while
  the CUJs show the verbatim quote on the card. The design now reads `{ message_id, quote }`;
  3A adds the field and the missing `proposals/:pid/edit` route the web client calls.
* Left for the wave 3 fix pass: the proposal card should show `source.ref.quote` once it exists
  (it shows the whole source message today); the submit 409 is unstructured (message only).

### Wave 3

* 3A (server) and 3C (web) run in parallel against the contract in `shared/schemas.ts`; the
  audit view (item 62) was pulled forward from wave 4 into 3C because its API already exists.
* Carried from the wave 1 fix pass for 3A: values handed to `withToolCall` and `withMock` must
  be JSON-clean (the audit schema now rejects `undefined`, `Date`, `NaN`).
* Left open from the wave 1 fix pass, minor: `/api/reset` duplicates the seed schema because
  `store.ts` does not export it; `PORT=abc` in `.env` falls back differently in the server and
  the Vite proxy.

### Wave 3A (copilot server) report

* Built: `server/llm/client.ts`, the two system prompts, `server/copilot/{tools,context,turn,
  quote-verify,options}.ts`, the guardrail (`index`, `denylist` + `denylist.json`, `number-match`,
  `judge`, `fallback`), `server/api/copilot.ts`, the homeowner-view and proposal-edit routes,
  `scripts/smoke-api.ts` (`npm run smoke`), tests 75, 80, 81 plus `tests/turn.test.ts` (29 tests
  against a scripted SDK client).
* Smoke against OpenRouter: strict tool call with exact cents, prompt caching (4,144 cached
  tokens on the second call), JSON output format for the judge. Probes: forced tool choice,
  disabling thinking and assistant prefill are rejected (400) on Sonnet 5.5; citations together
  with the output format are accepted on Haiku, contrary to the design's note.
* Five live turns: options line at 2.8 s, explanation at 7.0 s; the out-of-scope reply for
  "Will she be approved?"; a pre-approval instruction got the fixed reply; a name-and-ZIP turn
  produced three quote-verified proposals and no "solar" proposal (the judge blocked the first
  explanation as personal data, a false positive, and the regeneration passed). An earlier prompt
  version showed the full block path: deny-list and number-match blocked while the judge passed,
  both verdicts logged, one regeneration passed.
* Found: the SDK appends `/v1/messages` to `ANTHROPIC_BASE_URL`, so the design's
  `https://openrouter.ai/api/v1` would 404; the client strips a trailing `/v1` so either
  spelling works. Design items 14 and 24 to be updated in the fix pass.
* Interpretations to record in the design: the calculator is logged through `withToolCall`
  (LIVE), not `withMock`; a judge outage alone goes straight to the fallback; a judge "pass"
  with a category other than none counts as a block; number-match is a set check and cannot
  tell "Option A's figure attached to Option B"; the proposed value is not checked against the
  quote (the contractor confirms every proposal).

### Wave 5A (extraction server) report

* Built: `shared/document-schemas/*`, `server/prompts/extraction.system.md`,
  `server/extraction/{positioned-text,match,prompt,extract,llm,score}.ts` and the two adapters,
  `server/review/{derived,tasks,discrepancy,templates}.ts`, `server/api/review.ts`, the two
  service mocks, `samples/extraction-fixture.json` (recorded live), `scripts/record-extraction-
  fixture.ts`, tests 78, 79 plus `extract.test.ts` and `review-api.test.ts`.
* Recording (Opus 5.5, effort medium, one call per document, 7 to 9 s each): pay stub 7/7
  fields right, 6 located exact, net pay not located as engineered; estimate 5/5; scope letter
  4/4. Thresholds (90% text, 80% located) met with margin. Boxes overlaid on the rendered pages
  sit on the right words.
* Found: structured outputs allow at most 16 union-typed members per schema, so item 43's
  per-member nullable shape (42 on the pay stub) is rejected with 400; each field is now
  nullable as a whole. Items 25b and 43 to be reworded in the fix pass.
* Duplication to merge in the fix pass: `server/extraction/llm.ts` and `server/llm/client.ts`
  both implement the extraction call.
* The two hooks (review router mount, submit hook) applied by me; 360 tests.

### Wave 5B (reviewer screen) report

* Built: `web/src/routes/ReviewerView.tsx`, `DocumentViewer` (react-pdf page with the box
  drawn as a positioned element from the server's fractional bbox and the rendered page size),
  `ValueList`, `DiscrepancyPanel`, `review-api.ts`, `review-present.ts`, `review-types.ts`
  (type-only imports from the server's task view), the Reviewer tab badge; 35 tests, some driving
  the real review router with a scripted model.
* Driven in a real browser against two live submissions: not-located acknowledgement then
  confirm, box click, correct, flag, the derived income going from waiting to $61,100.00, the
  discrepancy ($85,000.00 stated against $61,100.00, 28.12%), the templated question edited and
  sent, the contractor's reply appearing without a reload, resolve, complete, badge cleared.
* Interpretations: the stored `difference` is shown, not recomputed (the brief's "the screen
  never computes" wins over item 61's wording); Resolve appears only after the question is sent;
  the derived row offers Flag only.
* Suggested for the final pass: a zod schema for the task view in `shared/`; the flag reason
  list includes system-only codes a reviewer can pick.

### Wave 3A fix pass report

* All eight fixes landed with tests; a live turn confirmed `options_display` on the options
  line and the homeowner props, digits-only figures in the explanation, and four proposals on the
  CUJ 2 sentence with nothing wrongly dropped.
* Interpretations written into the design (items 29 and 34): enum values are supported by the
  quote "by meaning" ("10-year" supports a 120-month term; "Option A", "fixed" or "0%" support a
  product), otherwise CUJ 2 would lose two of its five proposals; empty drafts are audited blocks.
* Known limits kept: "N monthly payments" is read as a count, not a figure, so an invented "180
  monthly payments" passes number-match; percents and terms keep the global rule (only money is
  bound per option).
* `tests/out-of-scope-reply.test.ts` makes one real model call on every `npm test` when a key is
  present (by design, item 81); it skips with a printed reason without a key.

### Wave 5A fix pass report

* All eight fixes landed with tests. The fixture was re-recorded once (three Opus calls, all
  `end_turn`): pay stub 7/7 fields and 6/6 located, estimate 5/5, scope letter 4/4; token counts
  identical to the first recording, so the prompt had not changed. Each entry now carries a
  `request_sha256` over the system prompt, the user prompt, the output schema and the indexed
  text, and the replay test fails when any of them changes.
* New: `withdrawVerifiedValue` (system actor, the derived income only) in `server/commands.ts`;
  `server/review/single-flight.ts` for per-document in-flight extraction; idempotent task
  opening that reuses an orphan queue issue and resumes a failed link.
* Known and left: a discrepancy record raised before a correction stays open until its question
  is sent and resolved (a second record is raised if the corrected figure is still outside
  tolerance); decided rows still show no Correct button in the web until the row builder and the
  reviewer screen change together (the API accepts the correction).

### Wave 3C fix pass report

* The crash on return was not an async effect but `window.scrollTo` returning a promise in
  this Chrome, which React then called as a cleanup; the effect returns nothing now and an error
  boundary wraps the routes. The other eleven fixes landed with tests (`web-sync`, `web-api`,
  `web-render`, `web-homeowner-effect`), including the switch to the server's
  `options_display` strings with a coverage rule (a reply missing an entry is refused like an
  unreadable reply). My walk on the final tree: three live turns, homeowner view and back,
  audit, no page errors.
* Left for the final pass: the options table's APR column wraps mid-number at 1366 px; an unused
  `.card-payment-detail` rule; `DisclosureBlockView` still returns null for a missing entry
  (guarded above it).

### Wave 3 and 5A reviews (codex, gpt-6.1)

Browser walk (`scripts/ui-walk.mjs`, three live turns): the options table, the quote-backed
proposal cards with submit blocked, the out-of-scope reply and the full homeowner view all
render; the audit page shows 45 events with LIVE/MOCK badges, token counts and the judge's
block-and-regenerate sequence. One blocker: "Back to application" left a blank page, traced on
the dev build to an async `useEffect` in `HomeownerView` (React calls its returned promise as a
cleanup) and no error boundary.

Copilot server, 6 findings, all kept: spelled money and term wording ("350 dollars", "ten
years") produced no figure token; number-match did not bind a figure to the option named in the
sentence (the design's "$414.14 attached to Option A" case); a proposal's value was never checked
against its verified quote ($40K proposed from a "$30K" quote); the judge verdict was parented to
the copilot call instead of the judge call; empty drafts skipped the checks and fabricated a
verdict; invalid calculator arguments never reached the contractor as the schema-invalid note.

Web client, 12 findings, 11 kept: the client formatted cents and composed payment wording
(design item 56 says it formats nothing: the server now sends `options_display` strings);
missing per-option disclosures were silently skipped; every historical options table could open
the homeowner view; cards showed the whole message instead of the verified quote; out-of-order
mutation responses; submit enabled during a running turn; state not scoped to the application
id; a fallback did not clear the explanation; overlapping bulk and single confirms; session id
persisted across reloads (item 52 says per page load); the explanation footer was deduplicated
away. Dropped: the Reviewer badge, which the reviewer-screen agent (5B) is building.

Extraction, 8 findings, all kept: a flagged derived income stayed verified on the application;
decided formula inputs could not be corrected later (4.4 step 6); overlapping extraction attempts
for one document; a retried task opening created a second queue issue; per-field pointer and
parse diagnostics were dropped from the completion event; the fixture replay was bound to the
indexed lines but not to the prompt or schema; the recorder overwrote the committed fixture
without a flag and logged document values.

Deferred to the final pass: merging `server/extraction/llm.ts` into `server/llm/client.ts`
(two agents would collide in one file now); the submit 409 stays unstructured.

### Wave 4 (docs) report

* Written: `README.md` (five-minute run, what you see without a key, a 16-step walkthrough,
  built-versus-described table, scripts, dated test results), `docs/audit-schema.md` (generated
  from the schema file), `docs/states.md`, `docs/evals.md`, `docs/ai-usage.md`.
* Differences between code and design the docs note: the golden cases follow item 74 rather than
  the case list in section 12; the deny-list set has 9 must-pass strings; the extraction replay
  runs on every `npm test`; `note` exists only on `field.rejected`; the review completes through
  an explicit "Complete review" click.
* The submission document was trimmed by me from 2,158 to 1,978 words (table included) and its
  built-versus-described section rewritten from the actual state.
* Left for the final README pass: the eval runner (wave 6A, running) and `docs/evals.md` once it
  exists; the item 85 statement that the author can explain every line is Andre's to make.

### Wave 6B (cleanup) report

* Done with tests (524 total): the options table's term and APR cells no longer wrap; the
  unused CSS rule is gone; `DisclosureBlockView` throws on a missing entry instead of returning
  null; the reviewer's flag-reason list omits the one system-only code
  (`pay_frequency_not_located`, written only by the derived-income path); a decided formula input
  now offers Correct ("Correcting recalculates the annualized income.") while the task is open;
  `setExtractionStatus` accepts the two diagnostic fields without a cast.
* Known: the decisions route still accepts the system-only reason from a reviewer (the schema
  allows it); a system-flagged derived row's summary reads the humanized code.
* `scripts/verify.sh` added: build, tests, boot on a spare port, health check, and the browser
  walk when playwright-core and Chrome are present; `verify-out/` is gitignored.

### Wave 6A (eval runner) report

* Built: `scripts/eval.ts` (`--judge`, `--judge-only`, `--only`, `--json`, `--retries`,
  `--list`; exit 2 without a key), `scripts/eval-schema.ts` (the case schema and the pure
  checks), `tests/eval/cases.json` (15 cases), `tests/eval/judge-cases.json` (20 labeled
  outputs), `tests/eval-cases.test.ts` (keyless; drives every check with a scripted client).
* First live run (66 model calls, 92 s): 10 of 15 copilot cases passed; judge recall 10/10,
  false positives 1/10. Failures: adv-01 to adv-03 because the model declined on its own
  (CUJ 3 counts that as a pass; the design's item 72 now says so, and a fix pass rewrites the
  expectation); adv-04 blocked by number-match rather than the judge named in the expectation
  (the first draft restated the form's $30,000.00 with no calculation; the regeneration was
  clean); fill-01 because "the 10-year option" did not fill `preferred_term_months` (the tool
  description never listed the term values: a real prompt gap, fixed in the same pass).
* Judge note: at 10 cases per class the 5% false-positive threshold cannot be measured; the
  runner applies the design's allowance of at most one miss and one false positive and says so.
* One latency miss: the clarifying-question case took 11.3 s because of a regeneration, over
  the 10 s p95 target; the judge's false positive on field labels caused it, addressed by the
  judge-prompt change.

### Wave 6C (prompt fixes and re-run) report

* The tool description for `propose_field_fill` now lists the term values (60, 120, 180, 240) and
  the product ids with a phrase each, and says a named term fills `preferred_term_months`; the
  copilot prompt forbids writing a dollar amount the contractor did not type and no calculation
  produced; the judge prompt says field labels are not personal data and the pricing amount is
  not income. The adversarial expectation follows item 72 as reworded (block on any layer, or a
  decline with no verdict word; the runner prints the path taken).
* Live re-run: 15 of 15 copilot cases (one needed a judge-triggered regeneration), judge recall
  10/10 with 0/10 false positives, 62 calls, 89 s. All four adversarial prompts passed by the
  model declining, so the live run did not exercise a block on them; the scripted tests do.
* Final tree: `bash scripts/verify.sh` green (build, 558 tests, health, seven-screenshot walk).

### Submission checks

* Fresh clone from GitLab, following the README verbatim: `npm install` (218 packages), `cp
  .env.example .env` with the key, `npm run build` exit 0, `npm test` 558 passed, `npm start`,
  health endpoint with the OpenRouter model ids, `load-demo`, one live copilot turn (status,
  options, explanation, done), the home page. Found: `.env.example` pinned `PORT=3000`, which by
  the override rule beat a `PORT=3471` exported in the shell; the example now leaves the port
  commented out and the README says how to change it.
* The README opens with a reader's map and its known limits; there is no CI, and the README says
  so. No secrets or developer commentary in the tree (checked at every commit).
* A requirements audit of the brief against the repository runs as the last step; its findings
  are fixed or disclosed before the final push.

### Requirements audit (Opus agent, 13 findings)

Code fixes, all landed with tests:

1. The TILA APR cell showed the product's standard rate, so Option C read 17.99% beside a
   $0.00 finance charge and Option B 12.99% against a schedule worth 8.96%. The calculator now
   computes the actuarial APR of the disclosed schedule (Regulation Z Appendix J, monthly
   periods, bisection, cross-checked by Newton and an exact BigInt bracket): 9.99%, 8.96%,
   0.00%. Both rates stay in `calculator_values`.
2. A contractor-directed question ("Use $40,000 as the requested amount?") was part of the
   explanation the homeowner view prints. The prompt now puts it on a marked final line, the
   server splits it into `explanation.question`, only the body is attached to the Options
   record, and the panel shows the question in its own bubble. Verified live on the "$40K"
   case.
3. The product range from the brief ($5,000 to $100,000, 5 to 25 years) is enforced by the
   calculator with user-facing messages the copilot shows as the proposals-line note; the form
   gained the 300-month term.

Write-up fixes: the README's confidentiality claim reworded (the PRD restates the brief and
now paraphrases its rubric), the figure-binding claim narrowed to what the code does, the
rejected angles, the simplifying assumptions and a build-versus-buy paragraph restored to the
submission document, its length stated honestly, a deployment guide (`docs/deployment.md`) for
the brief's third deliverable, a dated `docs/test-results.md`, the time budget in
`docs/ai-usage.md`, and the minor wording items (end state `documents_reviewed`, "every
locatable value", "whichever is larger", monitoring in the described-only list). Disclosed
rather than fixed: the direct Anthropic path not exercised, no upload control, two live turns
over the 10 s budget after a regeneration, no prompt-injection case, three `npm audit`
advisories, no CI.

### Final state

* `bash scripts/verify.sh` on the final tree: build ok, 588 tests, server with the key, browser walk
  with seven screenshots and no page errors. The script now refuses a busy port and kills its
  server by port (a previous run's `tsx` child had outlived `npm start` and blocked the port).
* Every commit on GitLab `main`; the working tree is clean after the final commit.

### Upload control

After the final state above, the one gap the requirements audit had disclosed rather than fixed
(documents came only from "Load demo project") was closed with a prototype file picker that stands
in for the portal's production upload. It does not change what the design describes for production.

* **Route.** `POST /api/applications/:id/documents/:slot` takes the PDF as the raw body
  (`express.raw`, 10 MB, this route only) and the file name, percent-encoded, in `x-file-name`. The
  application, the slot and the draft state are checked before the body is read; then the body
  must start with `%PDF-` and be 1 byte to 10 MB. Refusals are `{ code: "internal", message,
  retryable: false }`: 400 for a bad file (including a body over the limit), 404 for an unknown
  application or slot, 409 after submit. The reply is the application view.
* **Storage.** `server/uploads.ts` reserves the document id, has the documents service keep the bytes
  as `data/uploads/<document_id>.pdf` (gitignored, emptied at boot), and only then calls the command,
  so a failed write leaves no record. The record's `file_ref` is `uploads/<sanitized name>` and the
  reader is always `pdfjs`; the `uploads/` prefix is what tells the documents mock an attached file
  from a bundled sample, so `GET /api/documents/:id/file` and the extraction adapter read either.
* **Replace.** A second file for a slot in draft goes through the new `replaceDocument` command: the
  old record leaves the store and the application's document ids (the new one takes its position),
  its file is deleted, and `document.attached` carries the optional `replaces: <old document id>`.
  The new file has a new document id, so the browser's cache of the old file's URL cannot show it.
  `attachDocument` still refuses a second document for a slot.
* **No text layer.** A PDF whose text layer holds no words used to fail with `internal`. Extraction
  now stops before the model call and ends the document `failed` with the new error code
  `extraction.no_text_layer` ("This PDF has no readable text layer, so it is marked for manual
  reading."); no proposals are made and the review task flags the slot for manual reading, as it does
  for any failed document. The committed pay stub is a picture, so attached through the picker it
  takes this path; "Load demo project" still attaches it with the `ocr_fixture` adapter and its
  recorded OCR output, which is why the walkthrough's pay stub boxes come from the demo loader.
* **Web.** The Documents card shows each slot's file name or "No file attached", with Attach (Replace
  when a file is present) as a styled label over a visually hidden file input, "Uploading..." while
  the file is on its way, the server's sentence under the slot on a refusal, and disabled controls
  after submit. The row rules are the pure function `slotRow` in `web/src/present.ts`.
* **Tests.** `tests/upload.test.ts` (route contract, replace, after submit, the picture-only pay
  stub through extraction to the review task) and `tests/web-upload.test.ts` (row rules, the card's
  markup, the request the page sends).

### OCR at runtime

On 2026-10-28 the author reversed Alternative P ("OCR at runtime with tesseract.js", rejected earlier the
same day in favor of the committed fixture) for uploaded files. A PDF the contractor attaches whose text
layer has no words used to end `failed` with `extraction.no_text_layer`; it is now read by OCR. The
committed fixture stays for the sample pay stub that "Load demo project" attaches (`ocr_fixture`), so the
walkthrough and the recorded no-key replay are unchanged. This supersedes the "No text layer" bullet in the
upload control entry above: the code `extraction.no_text_layer` remains, but it now means that OCR found no
words either.

* **Dependencies.** `tesseract.js` 7.0.0 and `@napi-rs/canvas` 1.0.13, added to the root `package.json`
  pinned to those versions (the one-time tooling in `scripts/samples/` already used both). The `canvas`
  override that blocks the native package stays. pdf.js stays at 4.8.69, which looks for `DOMMatrix`
  and `Path2D` in the blocked `canvas` package, so the adapter takes them from `@napi-rs/canvas`, and hands
  pdf.js its own canvas factory through the `CanvasFactory` option of `getDocument` (4.8 has no
  `canvasFactory` option on `page.render`).
* **Adapter.** `server/extraction/adapters/ocr-tesseract.ts`, `ocrTesseractAdapter(file, { signal })`:
  each page is drawn at scale 3 (216 dpi for letter) on a white canvas, PNG-encoded, and read by one
  tesseract.js worker (English, LSTM engine, page segmentation mode 6) that is created on first use and
  reused. Words are mapped from tesseract's lines (numbered top to bottom per page, words left to right,
  boxes as page fractions, confidence divided by 100, empty words dropped). `shutdownOcr()` ends the
  worker, and so does the process exit hook. Language data goes to `data/tessdata/` (not committed); the
  adapter fetches the gzip file itself, once, so that an offline first run fails with an error instead of
  hanging inside the library, and a later call retries.
* **Selection.** In `extract.ts` an `ocr_fixture` document is read from its recorded file as before; a
  `pdfjs` document is OCR'd only when pdf.js finds no words in it. The adapter that read the document is
  written on the document record and on `extraction.completed` (new optional `adapter` field, also
  `ocr_tesseract` on every `per_field` entry); a failure after OCR started keeps `ocr_tesseract`.
* **Limits.** OCR runs inside the per-document single flight with a 120 second limit (`ocr_timeout_ms`
  in the extraction dependencies, for tests). A document that runs out ends `failed` with the new code
  `extraction.ocr_timeout` (added to the 15 codes, now 16; I chose a code of its own over `internal` so
  the audit trail says what happened). The abort stops page drawing and, if a page is being read, ends the
  worker; the next document starts a fresh one. Documents are OCR'd one at a time. The limit covers the OCR
  stage, not the model call, which keeps its own timeout and retry.
* **Timing (this machine, warm cache).** Language data 2.95 MB download, 5.2 MB on disk (the task brief
  estimated 15 MB). Pay stub picture 0.5 s, estimate 0.7 to 1.5 s, scope letter 0.9 s per page with the
  worker running; the first page after a start takes about 1.0 to 1.3 s. The brief estimated 20 to 40 s
  per page; that was an order of magnitude too high for these pages, and the README says what was measured.
  Through the running server, a pay stub upload logged `OCR read doc_1 (pay_stub): 1 page(s), 44 words, 1.0 s`,
  and the review task opened 17.7 s after submit with three live model calls.
* **Quality.** The test compares the adapter with `samples/paystub.ocr.json`: all 43 of the recorded words
  that have a box were found with the same text and a box center within 0.02 (100%; the test requires 90%).
  The OCR of `estimate.pdf` and `scope_letter.pdf` pictures matches their text layers line for line. One
  difference from the fixture: net pay now has a box, because the fixture withholds it on purpose and real
  OCR has it, so an uploaded pay stub shows all seven values located.
* **Tests.** 636 tests, up from 619. `tests/ocr-tesseract.test.ts` (mapping without the engine; the engine
  on the pay stub picture, the line grouping, the fixture comparison, a three-page document with a blank
  page, abort and restart; skips with a printed reason when the language data is absent and cannot be
  downloaded), the fall-through, no-words, timeout, engine-failure and never-OCR cases in
  `tests/extract.test.ts`, and an uploaded pay stub through the real adapter to located proposals in
  `tests/upload.test.ts`. The upload tests that expected `no_text_layer` for the pay stub picture now use a
  blank page and an OCR reader that finds nothing. `tests/helpers/pdf.ts` writes small PDFs for them.

### Demo video

* `docs/demo/`: narration in Andre's cloned voice (Chatterbox, the same setup as the Cerbo and
  Meridian demos), brand title and close cards, a Playwright capture (`record.mjs`, one clip per
  scene from a timestamped screencast, a visible cursor, cuts of waiting time recorded to
  `cuts.json`), `mux.sh` pacing each scene to its narration, `verify.sh`. Output 4:23 at
  1440x900; every model call live; only waiting is cut; between scenes 8 and 9 the estimate and
  scope-letter rows are confirmed through the API to keep scene 9 short (the README says so).
* Found while recording: across six takes the guardrail blocked a legitimate options
  explanation more than once (judge `uncaveated_promo` on the "$30K" question, one number-match
  block), once ending in the fallback. The recorder discards such a take for scenes 3 and 4
  because the narration says the explanation follows. The false-positive rate of the judge on
  benign explanations is a known limit to measure with the grown judge set.

## Decisions made during the build

| Date | Decision | Why |
| --- | --- | --- |
| 2026-10-28 | Model calls go through OpenRouter (`ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1`, ids `anthropic/claude-*`) | No Anthropic key on this machine; strict tools, effort, JSON output and prompt caching were verified to work through OpenRouter with curl before the build |
| 2026-10-28 | Implementation agents run on Sonnet 5.5; I do the builds, reviews and commits | User instruction |
| 2026-10-28 | `data/audit.jsonl` is truncated at boot; only `/api/reset` truncates it otherwise | The store is in memory and reseeded at boot, so a kept file would attach the previous run's events to the same seeded application id; production has the INSERT-only table |
| 2026-10-28 | An adversarial eval case passes either when a guardrail layer blocks or when the model declines with no verdict word | CUJ 3 already defined both as acceptable; "must trip" would fail a model that behaves well, and the block path is proven by scripted tests |
| 2026-10-28 | The duplicate extraction client (`server/extraction/llm.ts` beside `server/llm/client.ts`) stays for the submission | Merging it changes the recorded request and therefore the fixture hash on the eve of the deadline; noted as the first cleanup after submission |
| 2026-10-28 | Values in `.env` override variables already exported by the shell | A stale `ANTHROPIC_BASE_URL` in the demo machine's shell would otherwise send the OpenRouter key to api.anthropic.com and every model call would fail; `.env.example` states the rule |
| 2026-10-28 | Uploaded PDFs with no text layer are read by tesseract.js at runtime; the committed OCR file stays for the sample pay stub | The author reversed Alternative P for uploads. Measured cost was 3 MB of language data once and about a second per page, not the 15 MB and 10 to 30 s the alternative assumed; the sample pay stub keeps its fixture so the walkthrough and the no-key replay do not vary |
| 2026-10-28 | OCR timeout is its own code, `extraction.ocr_timeout`, 120 s per document | A timeout that reads as `internal` in the audit trail hides what happened; the code is one enum entry and one message |

## After submission

* 2026-10-29: `docs/production-plan.md`, the plan to scale the prototype to GoodLeap's stack
  (ECS, RDS, S3, SQS, Textract, JSM, Snowflake, Entra ID, GitHub Actions): what maps where, the
  workstreams and timeline, the load, data handling, code changes before production, and the
  decisions GoodLeap owns. Linked from the README's docs list and the deployment guide. Committed
  locally, not pushed.
