# System Brief: GoodLeap Loan Assistant

Read this before [AUDIT.md](AUDIT.md). Every claim is OBSERVED (file:line or command) unless marked
INFERRED. Written at commit `35eb9af` on 2026-10-29.

## 1. What it is

A take-home prototype for GoodLeap (README.md:1-12). It has two features. (1) A copilot beside a loan
application form. It quotes exact payment options from a deterministic calculator, explains them in
plain words, and proposes form values from the contractor's own words. (2) Document extraction: pay
stubs, estimates and scope letters become proposed values, which a reviewer confirms, corrects or
flags against boxes drawn on the page. Hard rules: no AI output makes or implies a credit decision,
and nothing a model wrote enters the application until a person confirms it. Single author, built in
waves from about 2026-10-20 to 2026-10-28 (docs/build-log.md). All data is synthetic (README.md:83).

## 2. Shape

| Aspect | Value |
| --- | --- |
| Languages / frameworks | TypeScript throughout. Express 5 server, React 18 + Vite client, Zod schemas shared by both (package.json) |
| LLM | `@anthropic-ai/sdk`. Copilot is Sonnet 5.5, extraction is Opus 5.5, judge is Haiku 5.5 (server/config.ts:54-58). The model ids are rewritten for an OpenRouter base URL (config.ts:65-68) |
| Documents | pdf.js for text PDFs. tesseract.js plus @napi-rs/canvas OCR for scans, run inside the server process |
| Build / tests | `npm run build` type-checks both halves. `npm test` is vitest, 24 test files (README.md:317). `npm run eval` runs live model evals. There is no CI (README.md:40) |
| Local run | `npm start` builds the web app and serves it with the API on one port. It runs without a key, in which case extraction replays `samples/extraction-fixture.json` |
| Deployment | None probed. docs/deployment.md describes a container. INFERRED: the production pieces it names (SQS, Textract, JSM) do not exist in the code |
| Eras | One era. "Described only" items (Textract, SQS, JSM, pgvector) live in docs, not code (README.md:297) |

## 3. Map

| Directory | What lives here | Entry point? |
| --- | --- | --- |
| `server/index.ts` | Composition root. Loads `.env`, empties `data/uploads` and `data/audit.jsonl`, loads the seed, mounts the routes | **Process entry** |
| `server/api/` | Routes. `applications.ts` (form, proposals, upload, submit, homeowner view, audit), `copilot.ts` (NDJSON turn, no-model button), `review.ts` (reviewer), `http.ts` (ctx helpers) | **HTTP entry** |
| `server/commands.ts` | **The only state writer.** About 20 transition functions | |
| `server/store.ts`, `server/audit-log.ts` | In-memory maps; append-only JSONL audit log | |
| `server/copilot/` | Turn loop, tools, context window, options pricing, quote verification | |
| `server/guardrail/` | Deny-list, number-match and judge, plus the fixed fallback texts | |
| `server/domain/` | Calculator, catalog, disclosure template, homeowner-view composition, banner | |
| `server/extraction/` | Document adapters (pdf.js, OCR, OCR fixture), the extraction prompt and call, quote-to-span matching | |
| `server/review/` | Review task lifecycle, derived values, discrepancy engine, single-flight | |
| `server/services/` | Typed mocks: catalog, credit engine (never called), Plaid, contractor profile, documents, review queue | |
| `shared/` | Zod schemas (`schemas.ts`), field definitions, document schemas, `normalize.ts`, formatters | |
| `web/src/` | React app. Contractor, reviewer, audit and homeowner routes | **Browser entry** (`main.tsx`) |
| `samples/`, `scripts/`, `docs/` | Synthetic documents and seed, eval/smoke/verify tools, design and build log | |

## 4. Data

| Store | Contents | Identity style | Same fact elsewhere? |
| --- | --- | --- | --- |
| In-memory `StoreState` (store.ts:26-38) | contractors, reviewers, applications, proposals, discrepancies, reviewTasks, documents, messages, options | Readable counters such as `p_3`, `doc_2` and `task_1`, which restart on reset (store.ts:63-67). Seed ids such as `app_demo_001` | Yes. Reviewer decisions are read back from **audit events** (`decisionsOf`, review/tasks.ts:293), while proposal state lives in the store |
| `data/audit.jsonl` plus an in-memory copy (audit-log.ts) | One validated event per line, with `seq`, `turn_id`, `parent_event_id`, `actor` and a versions block | `evt_<uuid>` | It is the system of record for "who did what". It is emptied at boot and on `/api/reset` |
| `data/uploads/<doc_id>.pdf` | Files the contractor attached | Document id, regex-checked (services/documents/mock.ts:17) | Emptied at boot |

Money is integer cents everywhere and APR is integer basis points (calculator.ts:4-9).

## 5. Request path: one copilot turn

```mermaid
sequenceDiagram
  participant B as Browser (CopilotPanel / conversation.ts)
  participant R as POST /api/applications/:id/copilot/turns
  participant T as runTurn (copilot/turn.ts)
  participant C as commands.ts + audit-log.ts
  participant M as Model (Sonnet) via llm/client.ts
  participant G as runGuardrail (deny-list, number-match, Haiku judge)
  B->>R: { text } + x-session-id (random, client-made)
  R->>R: contractorCtx: actor = application.contractor_id (no auth)
  R->>T: flush NDJSON headers, runTurn(ctx, text, write)
  T->>C: appendMessage -> message.received
  T->>T: buildContext: catalog via withMock (tool.call), 10-turn window
  loop at most 3 rounds
    T->>M: messages + tools (model.call event)
    M-->>T: tool_use calculate_payment / propose_field_fill
    T->>C: priceAndStore -> tool.call (LIVE) + options.stored; stream "options" line
    T->>C: verifyQuote + proposeFieldValue -> field.proposed; stream "proposals"
  end
  T->>G: draft + allowed figures (this turn only)
  G->>C: 3 x guardrail.verdict
  alt blocked once
    T->>M: regenerate with reasons, then check again; second block -> fixed fallback
  end
  T->>C: appendMessage(draft), attachExplanation -> options.explained
  T-->>B: "explanation" line, then "done" with the turn's event ids
```

Notes. The table is streamed before the prose. Prose is only shown after all three checks pass
(turn.ts:186-252). The turn always ends with `done` and never throws (turn.ts:96-132). It runs to
completion even if the browser disconnects (copilot.ts:29). Logging is the audit log: each command
appends its event **before** it mutates the store, so an invalid event leaves no state behind
(commands.ts:51-55, audit-log.ts:149-167).

The submit path is synchronous up to the response. After the response is sent,
`startDocumentReview` runs in the same process (applications.ts:289). It extracts each document in
turn and then opens the review task (extract.ts:332-349).

## 6. Identity and permission model

- **User.** None is authenticated. The contractor's identity comes from the URL: `contractorCtx` sets
  the actor to the application's own `contractor_id` (api/http.ts:47). Every reviewer write uses the
  hardcoded `rev_demo_001` (api/review.ts:19, 29). `x-session-id` is a random id the client makes
  per page load, and it is recorded but never checked (http.ts:14). There is no login (README.md:233).
- **Role.** Carried as `ctx.actor.type`: contractor, reviewer, system or model.
- **Unit of permission.** The *transition*, not the user. Commands check the application status, the
  proposal state and the actor type. For example, only a contractor-typed actor confirms a form value
  (commands.ts:410), and only `system` writes the verified income (commands.ts:416-420).
- **Where checks run.** In `commands.ts` and `review/tasks.ts:applyDecision`. **Where they do not.**
  Nothing checks who the caller is. The route chooses the actor type, so any HTTP client can act as
  either role. This was reproduced live (AUDIT.md SEC-HIGH-001).

## 7. Extension points

| Mechanism | Used first-party? | How to extend |
| --- | --- | --- |
| A new command in `commands.ts` | Every write | Follow guard, then `audit.emit`, then mutate. Add the event type to `AuditEventSchema` in `shared/schemas.ts` |
| A service behind `services/types.ts` and the `services` registry (services/index.ts:38) | Every mock | Swap the implementation in the registry and call it through `withMock` or `withToolCall`, so a `tool.call` is logged |
| A copilot tool (`copilot/tools.ts`) plus a branch in `runTools` (turn.ts:258) | Two tools | Strict JSON schema plus a Zod re-check. The backend decides, the model only suggests |
| A document slot (`shared/document-schemas/`) | Three slots | Fields, `compareTo` and `tolerance` drive extraction, the review rows and discrepancies with no other code |
| A deny-list entry (`guardrail/denylist.json`) | Yes | Data only, versioned by content hash |
| A guardrail check (`GuardrailCheck`, guardrail/index.ts:12) | Three checks | Add it to `runGuardrail` |

## 8. Operations

- **Config.** `.env` at the working directory overrides the shell (load-env.ts). Settings are read on
  access (config.ts). The kill switches are `COPILOT_ENABLED` and `EXTRACTION_ENABLED`.
- **Health.** `GET /api/healthz` reports whether a key is present, the switches and the versions,
  where each prompt, the calculator and the deny-list are content-hashed.
- **Background work.** In-process only: the extraction queue after submit, and single-flight for
  document reads and task opening (review/single-flight.ts).
- **Migrations.** None, because state is in memory.

## 9. Core files and functions to know well (reading order)

1. **`server/commands.ts`**, the domain's state machine. `proposeFieldValue` (276) covers drop rules,
   supersede rules and the key/source domains. `confirmValue` (386) has the only two paths that write
   application data. `submitApplication` (704). `putDocument` (762). `createReviewTask` (900).
   `completeReview` (971). The discrepancy lifecycle runs from 1009 to 1125. Read `docs/states.md` beside it.
2. **`server/audit-log.ts`**. `createAuditLog` / `appendAll` (validate, then write, then commit),
   `emit`, and `Ctx`. Every other module speaks in `Ctx`.
3. **`server/store.ts`**. `storeWriter()` versus the copying `store.*` readers. Only commands write,
   which is enforced by tests/commands.test.ts:612.
4. **`server/copilot/turn.ts`**. `runTurn` covers the tool loop, `runTools`, `proposeFromTool` (quote
   verification), the guardrail retry-once logic and `splitQuestion`.
5. **`server/domain/payments/calculator.ts`**. `levelPaymentCents` (BigInt exact), the three `price*`
   mechanics, `scheduleAprBps` (actuarial APR by bisection), `deferredConsequence`, and
   `calculatorValues`, which feeds number-match.
6. **`server/guardrail/`**. `runGuardrail` (index.ts:43), `checkNumberMatch`, `runJudge` (fails
   closed), and the deny-list.
7. **`server/copilot/options.ts` + `context.ts`**. `resolveInputs`, where form values beat model
   arguments. `priceAndStore`. `buildContext`, which handles the cache prefix, the field redaction in
   `VISIBLE_FIELDS` and the 10-turn window.
8. **`server/extraction/extract.ts` + `match.ts`**. `runExtraction` and `locate`, where the quote
   must contain the value and match the document's own words.
9. **`server/review/tasks.ts`**. `openReviewTask` (idempotent issue and link handling), `taskView`,
   and `applyDecision`, which runs the command, recomputes derived values, then compares. Also
   `review/discrepancy.ts:evaluateTolerance`.
10. **`shared/schemas.ts`, `shared/normalize.ts`, `shared/application-schema.ts`**. These are the
    wire contract, the only text normalizer and the field table.
11. **Client:** `web/src/conversation.ts` (`createConversationStore`), `stream.ts`
    (`applyStreamEvent`), `sync.ts` (`createViewSync`, which serializes writes and drops stale views),
    `routes/ReviewerView.tsx` (`TaskPage`).

## 10. Glossary

| Term | Meaning |
| --- | --- |
| Proposal / ProposedValue | A value suggested by the model or extraction. Its states are proposed, confirmed, edited, rejected and superseded. It enters the application only on confirmation |
| Source kinds | `message`, a quote from a contractor message; `box`, a span on a document; `formula`, a derived value such as annualized income |
| Options record | One stored calculator output. Its explanation is attached once |
| Homeowner view | The customer-facing page of the options plus disclosures. Each render is logged as `view.rendered` with a hash |
| Fallback | The fixed reply shown after two guardrail blocks |
| Discrepancy | A confirmed document value outside tolerance of the stated value. It becomes a question for the contractor |
| `typed` / `confirmed` / `edited` | How a form field got its value. All three count as confirmed |
| LIVE / MOCK | On the audit page, a real computation versus a mocked service call |

## 11. Open questions

- What production identity would supply the actor? It needs the portal's session, and the routes'
  `contractorCtx` and `reviewerCtx` are the seam (INFERRED).
- Has GoodLeap Compliance accepted the deferred-interest disclosure shape (AUDIT.md COMP-MED-010)?
- `npm test` and `npm audit` were not re-run for this audit. The last recorded run is in
  docs/test-results.md (2026-10-28).
