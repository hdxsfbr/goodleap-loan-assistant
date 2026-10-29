# Test results

Local runs only; there is no CI. Each block names the command, the date and the counts as printed.
The final numbers are from the last run before the submission commit and are updated with it.

## `npm test`

Date: 2026-10-28 (final run after the audit fixes; see the build log for the count after each wave).

```bash
npm test
```

Result: see "Final counts" at the end of this page. One test (`tests/out-of-scope-reply.test.ts`) makes a live
model call when a key is present and skips with a printed reason otherwise.

## `npm run eval -- --judge`

Date: 2026-10-28, with an OpenRouter key.

```bash
npm run eval -- --judge
```

Result: copilot cases 15 of 15 passed (62 model calls, 89 s). The four adversarial cases passed by the
model declining with no verdict word; one payment case passed after a judge-triggered regeneration.
Judge: recall 10 of 10, false positives 0 of 10 (the stated 0.95 and 5% thresholds cannot be measured
at 10 cases per class; the runner applied the design's allowance of at most one each and printed that).
The first run the same day passed 10 of 15; the five failures and their fixes are in `docs/evals.md`
and the build log.

## `bash scripts/verify.sh`

Date: 2026-10-28.

```bash
NODE_PATH=<dir with node_modules/playwright-core> bash scripts/verify.sh
```

Result: build ok; tests ok; server on port 3470 with the key present; browser walk ok with seven
screenshots (contractor view, three live turns, the homeowner view, back to the application, the
audit page), no page errors.

## Fresh clone

Date: 2026-10-28. Cloned from GitLab `main` into an empty directory and followed the README:
`npm install` (218 packages), `cp .env.example .env` with the key, `npm run build` (exit 0),
`npm test` (24 files, 558 passed), `npm start`, `GET /api/healthz` (key present, OpenRouter model
ids), `POST .../load-demo` (200), one live copilot turn (`status`, `status`, `options`, `status`,
`status`, `explanation`, `done`), `GET /` (200). Found and fixed: `.env.example` pinned `PORT=3000`,
which overrode the port exported in the shell.

## Final counts

Last full run, 2026-10-28 18:28  (after the requirements-audit fixes), from `bash scripts/verify.sh`:

| Step | Result |
| --- | --- |
| `npm run build` | exit 0 (tsc for server and web, vite build) |
| `npm test` | 24 files, 588 tests passed, 0 failed (one live model call, the out-of-scope reply test) |
| Server | started on a spare port, health endpoint reports the key present and the OpenRouter model ids |
| Browser walk | 7 screenshots, three live turns, the homeowner view and back, the audit page; no page errors |

The eval run and the fresh clone above predate the audit fixes by about an hour; the audit fixes added
the actuarial APR, the product range and the contractor-question split, each with its own tests, and the
"$40K" eval case was re-run live on its own after the split (passed).

## After the restyle and the upload control

2026-10-28 19:43 : `npm run build` exit 0; `npm test` 26 files, 619 tests passed, 0 failed (31 new tests cover the
upload route, the replace rule, the no-text-layer rule and the slot controls). The restyle added no
tests and changed none.

## After the runtime OCR adapter

2026-10-28 20:07 : `npm run build` exit 0; `npm test` 27 files, 636 tests passed, 0 failed. The OCR test reads the
sample pay stub picture with tesseract.js and matched 43 of 43 of the committed fixture's located words
within 0.02 of their box centers; it takes about 3 s warm and skips with a printed reason when the
language data is absent and cannot be downloaded. A live submit with three plain uploads produced a
review task 17.7 s after submit with the pay stub read by OCR (adapter `ocr_tesseract`, 7 values
located with boxes).
