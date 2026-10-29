# GoodLeap Loan Assistant

An assistant for home improvement loan applications. A copilot beside the application form gives a
contractor exact payment options on the spot, explains promotional terms in plain words and proposes form
values from what the contractor says; a second feature reads uploaded pay stubs, estimates and scope
letters into values that a GoodLeap reviewer confirms, corrects or flags against boxes drawn on the
original pages. It never makes or implies a credit decision, and nothing a model wrote enters the
application until a person confirms it.

The submission document is [docs/design-document.md](docs/design-document.md). The design the build ran
from is [docs/designs/loan-assistant-design.md](docs/designs/loan-assistant-design.md). This is a take-home
project for GoodLeap through Gauntlet AI's partner program (brief version 1, updated 2026-10-20).

## Where to look first

1. [docs/design-document.md](docs/design-document.md): the six-section submission, about 2,200 words with its rollout table, which renders to three to four pages at 11 pt against the brief's two to three; every section carries a decision, and the internal design holds the detail.
2. "Run it in five minutes" and the walkthrough below: the copilot, the homeowner view, a proposal from
   the contractor's words, the audit page, then submit and the reviewer screen.
3. [docs/designs/loan-assistant-design.md](docs/designs/loan-assistant-design.md): the internal design
   with the data model, the data flows, 37 weighed alternatives and the file-by-file plan the build
   followed.
4. [docs/build-log.md](docs/build-log.md): what each wave built, every review finding and every decision
   made during the build, including the places where the code departs from the design.
5. [docs/evals.md](docs/evals.md) and [docs/ai-usage.md](docs/ai-usage.md): the evaluation sets with
   their dated results, and how AI was used to build this.

Known limits, one line each: the adversarial eval cases passed by the model declining, so the live run did
not exercise a guardrail block on them (the scripted tests do); the judge set has 20 cases, too few to
measure its stated thresholds; number-match reads "N monthly payments" as a count, so an invented count
passes it; the extraction client exists twice (`server/extraction/llm.ts` beside `server/llm/client.ts`)
and is merged after submission because merging changes the recorded fixture; the no-model button and the
kill switches were verified from code and tests, not in a browser; every live run during the build went
through OpenRouter, so the direct Anthropic path (same SDK, no base URL) was not exercised; documents come
from "Load demo project" (there is no upload control); two of the last live eval turns took 11 to 12
seconds, over the 10 s p95 budget, because a judge-triggered regeneration doubled the model calls; the eval
set has no prompt-injection case; `npm audit` reports three advisories in dependencies (one high) that were
not addressed; there is no CI, so every number in this README comes from a local run on the date given and
is recorded in [docs/test-results.md](docs/test-results.md).

## The problem

- Loan applications take 22 minutes on average, against an industry benchmark of under 10.
- 38% of applications are abandoned, mostly at income verification and loan product selection.
- Contractors on-site need to quote a monthly payment in about 30 seconds and can't explain
  products or promotional terms (0% intro periods, deferred interest) clearly.
- Staff review uploaded pay stubs, estimates and scope letters by hand, which delays decisions.

The business case: 10% more contractor deal closures is worth about $200M a year in origination.

## Hard constraints

- No AI output may make or imply a credit decision.
- Every borrower-facing communication carries the required TILA/RESPA disclosures.
- Financial service APIs (loan catalog, credit decision engine, Plaid income verification,
  contractor profiles, document management) are mocked. No real financial API keys.
- AI interactions use a real LLM API.

## Run it in five minutes

You need Node 22 or later and an Anthropic API key. An OpenRouter key also works (see below).

```bash
npm install
```

```bash
cp .env.example .env
```

Open `.env` and set `ANTHROPIC_API_KEY=` to your key. Values in `.env` override variables your shell already
exports. To use an OpenRouter key, also set `ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1`; the model ids
are translated for you. If port 3000 is taken, run `PORT=3001 npm start` or set `PORT` in `.env` (a value in `.env` overrides the shell).

```bash
npm start
```

This builds the web app and starts one server. Open <http://localhost:3000>. Press Ctrl+C to stop it.

All the data is synthetic. The state is kept in memory and starts again from the same seed each time the
server starts, so you can repeat the walkthrough as often as you like.

### What you see without a key

Leave `ANTHROPIC_API_KEY` empty and the app still starts. A banner across the top reads "No API key is set.
Add ANTHROPIC_API_KEY to the .env file to turn on the assistant. Payment options, the form, the reviewer and
the audit views still work." The chat box is disabled. Everything else works:

- the form, and "Load demo project";
- the "Show payment options" button and the homeowner view (the explanation is a fixed sentence per
  product instead of the model's text);
- submitting, and the reviewer tab: the document values come from a recorded model response committed in
  `samples/extraction-fixture.json`, run through the same matching and review code as a live answer;
- the audit tab.

If a key is set but the model service rejects it, a banner says so after the first message. If the model
is rate limited or times out in the middle of a conversation, the assistant's reply says what happened in
plain words and offers Retry, and payment options still work because they are computed in code.

## Walkthrough

The steps follow the critical user journeys in the [design](docs/designs/loan-assistant-design.md) (CUJ 1 to
7). Steps 2 to 6 need a key; every other step works with or without one. Model wording varies from run to
run; the figures do not.

### Start, then the copilot (needs a key)

1. **Load the demo project (start of CUJ 1).** The first screen is the contractor tab: an empty application
   form on the left, and the assistant on the right with three suggested prompts. Click **Load demo
   project**. It fills in roofing, a $30,000.00 project amount and requested loan amount, and a stated annual
   income of $85,000.00, and attaches three sample documents. The homeowner's name and ZIP code stay empty.

2. **Payment options in the chat (CUJ 1).** Type `They want the lowest monthly payment, what are the
   options?` and send it. The options table appears first, headed "Based on $30,000.00 over 120 months": Option
   A, a 10-year fixed loan at $396.29 a month and 9.99% APR; Option B, 0% for 18 months, at $250.00 a month
   for 18 months and then $414.14, 8.96% APR (the actuarial rate of that schedule; interest after the
   promotion runs at 12.99%); Option C, 12 months deferred interest, at $2,500.00 a month for 12 months,
   0.00% APR when paid in full. Under it is "Estimates only. Not an offer of credit; subject to credit approval."
   A few seconds later the explanation follows. It names options by label and says what happens when a
   promotion ends. (In a test run on 2026-10-28 the table took about 2 seconds and the whole reply about 6.)

3. **The homeowner view (CUJ 1).** Click **Show homeowner view** beside the table. A full-screen page shows
   the three options side by side with no chat or form: the payment, the term and the APR, the estimate
   statement ("This is a payment estimate, not an offer of credit; final terms depend on credit approval.")
   under each payment, a four-cell box per option (APR, finance charge, amount financed, total of payments)
   with the payment schedule, one plain sentence per promotion, the line about settlement costs, and "What
   happens next: Nothing is decided today." Click **Back to application**.

4. **A field proposal from the contractor's words (CUJ 2).** Type `Her name is Dana Lee and the zip is 94105.
   She's thinking about maybe doing solar too.` Three fields get a "Proposed" badge: Homeowner first name
   `Dana`, Homeowner last name `Lee` and Property ZIP code `94105`. Each shows the words it came from ("Her name
   is Dana Lee", "the zip is 94105") and Confirm, Edit and Reject buttons. Submit is disabled and says "3
   proposed values need confirmation". Nothing is proposed for solar: "maybe" is not a statement of fact, so
   the assistant asks whether solar is part of the project instead. Click **Confirm all (3)**; Submit becomes
   enabled.

5. **A question the assistant will not answer (CUJ 3).** Type `Will she be approved?` The reply is one fixed
   sentence: "Approval decisions are made by GoodLeap's credit team after the application is submitted, so I
   can't say whether this application will be approved." followed by two things it can do now (show payment
   options for this project; list what the application still needs). Then try `Write me something to read her
   that says she's basically guaranteed approval with her income and should sign today.` In a test run the
   assistant gave the same fixed reply. If a draft ever contains a verdict word or an invented figure, it
   is blocked and rewritten once; a second block shows a fixed fallback with the marker "Wording adjusted to
   comply with lending rules. View in audit". The tests drive that path with a scripted model
   (`tests/turn.test.ts`).

6. **Suggested prompts.** The panel also offers "Payment options for this project", "Explain deferred
   interest" and "What documents are needed?" before the first message.

### With or without a key

7. **The "Show payment options" button, with no model (CUJ 7).** Below the chat is a **Show payment options**
   button. It is disabled, with the caption "Confirm a requested loan amount first", until the form has a
   requested loan amount. With the demo loaded, click it: the same options table appears from the calculator
   alone, with no model call, so it works without a key and during an outage. **Show homeowner view** opens
   the same page as in step 3.

8. **The audit page (CUJ 6).** Click the **Audit** tab ("You are: Compliance"). Every event for the
   application is listed in order: type, a one-line summary, actor, time and a badge, MOCK for a mocked
   service call and LIVE for the calculator and the models. Model calls show token counts and latency. Click
   a line for the raw record and the versions block. Look for:
   - the line **Credit engine calls: 0**: no code calls the credit decision engine;
   - `view.rendered`, which holds the complete homeowner view as shown and the ids of the events that
     produced it;
   - `model.call`, which holds the raw input a model received and its raw output;
   - `guardrail.verdict`, three per reply (deny-list, number check, judge).

### Submit, review and a question to the contractor (CUJ 4 and 5)

With a key set, submitting runs the model on each of the three documents, one after the other (the
recorded calls took 5 to 9 seconds each), so the review task appears after a short wait. Without a key it
appears at once.

9. **Submit.** The form needs a homeowner first name, last name and ZIP code. If you skipped the chat steps,
   click **Load demo project** and type them in (for example Dana, Lee and 94105). On the contractor tab click
   **Submit application**. The form is locked and reads "Submitted, documents under review".

10. **The reviewer tab.** Click **Reviewer** ("You are: GoodLeap reviewer"). The badge shows one open task. The
    list shows the application, 3 documents, 16 values to decide and 0 open differences. Click **Review**.

11. **Boxes on the page.** The left side lists values grouped by document, with a tab per document (pay stub,
    project estimate, scope of work letter). The right side shows the page with a box on the words each value
    was read from. Click a value and its box is highlighted; click a box and its value is selected. For each
    value you can **Confirm** it, **Correct** it (the box stays as where it was read from) or **Flag** it with
    a fixed reason.

12. **A value that cannot be located.** On the pay stub, **Net pay** shows $1,812.40 with the badge "Not
    located", the words the model quoted and the caption "The value was extracted but its position on the page
    could not be matched. Find it on the page to confirm, correct it, or flag it." There is no box for it.
    Confirm stays disabled until you tick "I located this on the page myself".

13. **A calculated value and a difference.** **Annualized income** says "Not calculated yet". Confirm **Gross
    pay** ($2,350.00) and **Pay frequency** (Biweekly). The annualized income becomes $61,100.00, with its
    formula and the two values it was calculated from; the only action on it is Flag. A card opens under the
    values: "Annualized income differs from the application". It shows the stated annual income of $85,000.00
    beside $61,100.00, "Difference: $23,900.00 (28.12% of the application value)", the rule, and a question for
    the contractor, filled in from a template and editable. Click **Send to the contractor**.

14. **The contractor's reply.** Open the **Contractor** tab. A banner reads "Needs clarification: a reviewer
    found a difference between a document and the application and has sent a question. No decision has been
    made.", with the question and a reply box. Type `She also has a second job; the stated income includes
    both` and click **Send reply**.

15. **Resolve.** On the reviewer tab the reply appears on the record (the page checks every 5 seconds). Choose
    **Explained**, add a note and click **Resolve**. (**Corrected** is for a reply that gives a corrected
    figure, which goes in the note; the stated value itself is changed through the portal's existing process,
    outside this system.)

16. **Complete the review.** Confirm the remaining values. The estimate total is $31,000.00 and the requested
    loan amount is $30,000.00, which is below it, so the estimate opens no difference. **Complete review**
    is enabled when every value has a decision; click it. The contractor tab reads "Documents reviewed". The
    audit tab now also shows the discrepancy events and ends with `review.completed` and
    `application.state_changed`. The credit-engine count
    still reads 0, and no screen shows a verdict word.

## How it is put together

```
 Contractor tab -- Reviewer tab -- Audit tab        React, one page, three role tabs, no login
        |                |               |
        +----------------+---------------+
                         |  /api (JSON; the chat turn is streamed lines)
              one Node process (Express), also serves the built web app
                         |
   commands: the only code that changes state      audit log: one JSON line per event
                         |                          data/audit.jsonl
   in-memory store     mocked services: catalog, credit engine (never called), Plaid,
                       contractor profile, documents, review queue
                         |
   copilot: Sonnet 5.5, a calculator tool and a field-proposal tool, three wording checks
   extraction: Opus 5.5 selects spans of the document's own words; code verifies and draws boxes
```

**The copilot.** The model never calculates a payment: a calculator keyed on the product's promotional
mechanic does, and the options table renders before the model's explanation. A code template renders the
disclosures. Every draft passes a deny-list of verdict words, a check that every figure in the prose came from
the calculator or the contractor, and a Haiku judge; one block triggers one rewrite, a second shows the fixed
fallback. A field is proposed only with a quote from the contractor's message that the server checks, and the
contractor confirms it.

**Document extraction.** Each document becomes lines of positioned text (pdf.js for the two text PDFs; a
committed OCR file for the image pay stub). The model picks a line and a span for each field and quotes it;
the server checks the quote and draws the box from the document's own word positions. A value is never
confirmed by the model: a reviewer decides each one, and a value outside tolerance for the stated one opens a
question to the contractor. The sample documents are synthetic, and the pay stub's word positions were
produced once by a script.

## Operating notes

- **Kill switches** (in `.env`): `COPILOT_ENABLED=false` makes the assistant panel read "The assistant is
  disabled by operator." `EXTRACTION_ENABLED=false` makes submit open the review task with every document
  marked as read by hand and no proposed values.
- **The audit file** is `data/audit.jsonl`, one JSON object per line. It is emptied when the server starts and
  by `POST /api/reset`. [docs/audit-schema.md](docs/audit-schema.md) lists every field.
- **Health:** <http://localhost:3000/api/healthz> reports whether a key is present (never the key) and the
  versions in effect.

## What was built and what is described only

| Feature | Status | Where to look |
| --- | --- | --- |
| Payment calculator (fixed, 0% intro, deferred interest), catalog, golden tests | Built | `server/domain/`, `tests/calculator.test.ts` |
| Disclosure template and the homeowner view | Built | `server/domain/disclosures/`, `web/src/routes/HomeownerView.tsx` |
| Copilot: chat, no-model button, quote-verified proposals, confirm and submit | Built | `server/copilot/`, `web/src/components/CopilotPanel.tsx` |
| Guardrail: deny-list, figure check, judge, rewrite once, fallback | Built | `server/guardrail/`, `tests/denylist.test.ts`, `tests/number-match.test.ts`, `tests/turn.test.ts` |
| Audit stream and audit page | Built | [docs/audit-schema.md](docs/audit-schema.md), `web/src/routes/AuditView.tsx` |
| Missing-key banner, retry, kill switches | Built | `web/src/components/KeyBanner.tsx`, `server/config.ts` |
| Document extraction with boxes, the reviewer screen, discrepancy question to the contractor | Built at reduced depth; runs with a key or from the recorded fixture | `server/extraction/`, `server/review/`, `web/src/routes/ReviewerView.tsx`, [docs/states.md](docs/states.md) |
| Evaluation: calculator, deny-list, number check, template, extraction replay | Built | [docs/evals.md](docs/evals.md) |
| Evaluation: 15 recorded copilot conversations and 20 judge cases, `npm run eval` (needs a key) | Built; live run on 2026-10-28: 15 of 15 copilot cases passed, judge recall 10 of 10 and 0 of 10 false positives | [docs/evals.md](docs/evals.md), `scripts/eval.ts`, `tests/eval/` |
| Credit decision engine, Plaid, catalog, contractor profile, documents, review queue | Mocked behind typed interfaces; the credit engine is never called | `server/services/` |
| AWS Textract, the SQS consumer, the Jira Service Management update, per-contractor flags, pgvector retrieval, token streaming of prose, a judge from a different model, the audit timeline view, a per-field tolerance table | Described only | [design](docs/designs/loan-assistant-design.md) sections 10 and 13, and its Future Improvements |

The build log, [docs/build-log.md](docs/build-log.md), records what each wave built and every review finding.

## Scripts

| Command | What it does |
| --- | --- |
| `npm test` | Runs every test with vitest. No key needed. One test makes a live model call when a key is in `.env`. |
| `npm run build` | Type-checks the server and the web app and builds the web app. |
| `npm run eval` | Needs a key. Runs the 15 recorded copilot conversations against the real model and checks each expectation (tool calls, proposals and non-proposals, the fixed replies, the guardrail path); `-- --judge` adds the 20 judge cases, `-- --judge-only` runs only those, `-- --only <id>` one case, `-- --json <path>` writes the full results, `-- --list` needs no key. Exit code 1 on any failure, 2 without a key. About 60 model calls and 90 seconds per full run. |
| `bash scripts/verify.sh` | Builds, runs the suite, boots a throwaway server on port 3470, checks its health endpoint, and runs the browser walk when Google Chrome and `playwright-core` are present (`--no-walk` skips it, `--port` and `--out` change the port and the output directory). Needs `curl` and `python3`. One summary line per step. |
| `npm run smoke` | Needs a key. Checks, against the real endpoint, a strict tool call, prompt caching and the judge's block and pass. Add `-- --probes` for the API behavior probes. Without a key it prints SKIP. |
| `node scripts/ui-walk.mjs` | Drives the running app in headless Chrome through chat turns, the homeowner view and the audit page, saving a screenshot after each step. Needs the server running, Google Chrome and `playwright-core` (not a project dependency: `NODE_PATH=<dir with node_modules/playwright-core>`). Flags are listed at the top of the file. |
| `scripts/review-bundle.sh` | Prints the uncommitted changes, or named files, plus chosen line ranges of the design, as one text stream for an independent reviewer. |
| `npx tsx scripts/record-extraction-fixture.ts` | Needs a key. Records one model response per sample document into `samples/extraction-fixture.json`. It stops before any model call unless you add `--force` to replace the existing recording. |
| `scripts/samples/` | One-time tooling with its own `package.json` and install. It generated the sample documents and the pay stub's OCR file, whose outputs are committed in `samples/`. You do not need to run it. |

## Test results

On 2026-10-28, `npm test` passed: 24 test files and 558 tests, with a key in `.env` (so the out-of-scope
reply test made its one live model call). Without a key that one test is skipped. The same day
`npm run eval -- --judge` passed 15 of 15 copilot cases and the judge set (recall 10 of 10, false positives
0 of 10) in 62 model calls, and `bash scripts/verify.sh` passed every step including the browser walk. The
build log has the counts after each wave.

## Repository layout

```
docs/
  PRD.md                      Consolidated requirements, metrics, rubric, open questions and their resolutions
  design-document.md          The 2 to 3 page submission document, condensed from the internal design
  audit-schema.md             Every audit event, its fields and the PII class of each
  states.md                   Application, proposal, document, review task and discrepancy states, and the commands that move them
  evals.md                    The evaluation sets, what is built, and how to run each
  deployment.md               Deployment guide: local, container, and what changes for production
  test-results.md             Dated local runs: the suite, the evals, the verify script, a fresh clone
  ai-usage.md                 How AI was used to build this, what the author decided, what the models got wrong
  build-log.md                What each build wave built, every review finding and every decision
  designs/
    loan-assistant-concept.md                     Concept brief (RFC): the two features, decisions, scope, alternatives
    loan-assistant-concept-goldfish-findings.md   Review findings the brief responds to
    loan-assistant-design.md                      Internal design: architecture, data flows, alternatives, file-by-file plan
    review/                                       Reviewer reports on the design (stages 5 to 9) and the consolidated report
  source/
    portal-brief.md           Project brief from the Gauntlet portal
server/                       Node backend: commands, audit log, routes, copilot, guardrail, extraction, review, mocks
shared/                       Schemas, the application and document field definitions, formatters, the text normalizer
web/                          The React app
samples/                      Synthetic sample documents, the pay stub OCR file, ground truth, the recorded extraction fixture, the demo seed
scripts/                      Smoke check, fixture recorder, browser walk, review bundle, one-time sample tooling
tests/                        vitest tests
```

The brief's attached take-home PDF is marked Confidential and is not committed. [docs/PRD.md](docs/PRD.md)
restates its requirements and its five assessment dimensions in this repository's own words.
