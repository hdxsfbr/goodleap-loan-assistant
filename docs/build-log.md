# Build log

The sticky record of the prototype build: which wave is running, what each one covers, and
what happened to it. Item numbers refer to the Detailed Implementation Plan in
[the internal design](designs/loan-assistant-design.md) (section "Build order and cut line").
Updated at every change of state, not just at the end of a wave.

Last updated: 2026-10-28 17:08 PDT

## Waves

| Wave | Design step | Covers | Status | Commit |
| --- | --- | --- | --- | --- |
| 1A | 0 | `samples/` (three PDFs, OCR file, ground truth) and `scripts/samples/` (items 65 to 67, 69 to 71) | done | `996ec3c` |
| 1B | 1 | Skeleton: root config, `shared/`, store, commands, audit log, routes, mocks, placeholder web, `tests/commands.test.ts` (items 1 to 7, 9, 10, 11 reason codes, 12 to 20, 21a routes, 48a, 49, 50a, 51, 65) | done | `996ec3c` |
| 1 close | - | Build, `npm test`, `/api/healthz`, create `.env` from the OpenRouter key, one codex review, filtered fix pass, commit, push | done: 15 fixes, 139 tests, pushed to GitLab `main` | `996ec3c` |
| 2 | 2 | Calculator, catalog, disclosure template, surface types, golden tests (items 30 to 33, 74, 76) | done: 6 fixes, 157 tests, pushed | see git log |
| 3 | 3 | Copilot end to end: 3A server (21a homeowner-view route, 22, 24 to 29, 34 to 38, 73, tests 75, 80, 81) and 3C web (52 to 57, 62 pulled forward from wave 4, 63, 64) | **running** as two Sonnet agents in parallel with the wave 2 fix pass | - |
| 4 | 4 | README walkthrough (8), audit view (62), docs (82, 84, 85); CUJs 6 and 7 run | not started | - |
| 5 | 5 | Document extraction and review: 5A server (11, 23, 25b, 39 to 47, 48b, 50b, 68, 78, 79; **running**, Sonnet, in parallel with wave 3 since its files are disjoint; the 21b hook and the router mount are applied by me after wave 3A lands) then 5B reviewer web (58 to 61) after 3C; 83 in wave 6 | **running** | - |
| 6 | 6 | Eval runner (72) and judge cases, submission doc built-versus-described (86) and final trim, final README pass | not started | - |

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
  product shows the standard APR; the deferred option gets the single-form schedule line plus
  the consequence line. `calculatorValues` also lists the promo and post-promo month counts
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

### Wave 3

* 3A (server) and 3C (web) run in parallel against the contract in `shared/schemas.ts`; the
  audit view (item 62) was pulled forward from wave 4 into 3C because its API already exists.
* Carried from the wave 1 fix pass for 3A: values handed to `withToolCall` and `withMock` must
  be JSON-clean (the audit schema now rejects `undefined`, `Date`, `NaN`).
* Left open from the wave 1 fix pass, minor: `/api/reset` duplicates the seed schema because
  `store.ts` does not export it; `PORT=abc` in `.env` falls back differently in the server and
  the Vite proxy.

## Decisions made during the build

| Date | Decision | Why |
| --- | --- | --- |
| 2026-10-28 | Model calls go through OpenRouter (`ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1`, ids `anthropic/claude-*`) | No Anthropic key on this machine; strict tools, effort, JSON output and prompt caching were verified to work through OpenRouter with curl before the build |
| 2026-10-28 | Implementation agents run on Sonnet 5.5; I do the builds, reviews and commits | User instruction |
| 2026-10-28 | `data/audit.jsonl` is truncated at boot; only `/api/reset` truncates it otherwise | The store is in memory and reseeded at boot, so a kept file would attach the previous run's events to the same seeded application id; production has the INSERT-only table |
| 2026-10-28 | Values in `.env` override variables already exported by the shell | A stale `ANTHROPIC_BASE_URL` in the demo machine's shell would otherwise send the OpenRouter key to api.anthropic.com and every model call would fail; `.env.example` states the rule |
