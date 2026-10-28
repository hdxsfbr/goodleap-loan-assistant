# Stage 5: Initial Zoom Out Review

* **Target:** `docs/designs/loan-assistant-design.md` (full file, lines 1 to 1953 at review time)
* **Reviewer:** `egm-zoom-out` (Skeptical Architect), fresh context, against `zoom-out-standard.md`
* **Context read:** the target, the concept brief, the brainstorm findings, the PRD, the README
* **Status:** completed. Context sufficiency, root problem focus and project alignment pass.

## Findings

### Blockers

None.

### Major

| Id | Finding | Scope |
| --- | --- | --- |
| ZO-1 | `get_products` is a second model round-trip for data already in the cached prefix, on the 3-second path. Delete it; `calculate_payment` takes product ids from the prefix or defaults to all three; the catalog stays a real consumer at context assembly and in the calculator. | Technical Plan 4.1, section 9, plan items 25 and 26 |
| ZO-2 | The fuzzy Levenshtein matcher tier, the "approximate" box style and `anchorRequired` solve a problem the positioned-text-only decision removed. A verbatim quote on a mis-cited line would fall through to "fuzzy" with score 1.0 and be mislabeled. Simplify to two tiers: exact span, then normalized equality searched over the claimed page then all pages; otherwise not located. The engineered not-located value assumes the model quotes a token it never saw as one piece; put the deterministic case in the extraction fixture. | Owner decisions, 4.4 step 5, section 7, plan items 11, 42, 43, 65, 68, 78 |
| ZO-3 | The implementation plan drops the staging decision: 87 items, no build order, no cut line, and the verification plan requires all seven CUJs unconditionally. Carry the brief's build order in, tag each item (floor, feature 1, feature 2, fallback), make feature-2 verification conditional. | Plan intro, verification plan |
| ZO-4 | `commands` and `review` form a dependency cycle: `confirmValue` calls the discrepancy engine, which calls `raiseDiscrepancy`. Keep `confirmValue` a pure transition; the review layer calls `confirmValue` then `compareOnConfirm`. | Section 2, plan items 19 and 48 |
| ZO-5 | Two grader run commands (`npm run dev` in G9, `npm start` elsewhere) and a `data/state.json` nobody reads at boot. One command, and delete `persist()`. | G9, section 2 store row, plan items 8 and 18, verification plan |
| ZO-6 | `waiting_on_stated_value` exists only because review can begin before submit. Start extraction from `submitApplication`; every comparison then runs against confirmed values and the state, its branch, its test and its UI label disappear. | Section 3, 4.3, 4.4, 4.5, CUJ 4, plan items 45, 48, 79 |
| ZO-7 | Two judge modes, and the strict one never runs as drawn: the turn judges in standard mode, 4.2 claims a strict pass with no second call. One rubric (the strict one) applied once per turn; drop the judge-mode column and the judge's surface argument. | 4.1, 4.2, section 6, section 11, plan items 25, 34, 37 |

### Nits

| Id | Finding |
| --- | --- |
| ZO-N1 | Altitude drop: 4.4 steps 2 and 5 spell out algorithms duplicated in plan items 40, 42, 43. |
| ZO-N2 | `pdf-lib` in root dependencies is used only by the isolated sample script. |
| ZO-N3 | `MOCKS=true` is a switch with one position; the 20 ms simulated latency adds nothing. |
| ZO-N4 | Hand-maintained version constants duplicate the content hashes `versions` computes. |
| ZO-N5 | Speculative paths no CUJ exercises: the `request_homeowner_view` tool, the multipart upload route and file inputs (hidden dependency), the Plaid stub, the 5-second badge poll. |
| ZO-N6 | Unreachable or single-valued enums: `queued | extracting` task states; `route` with one value. |
| ZO-N7 | One reviewer gesture emits two events (`field.confirmed` and `review.decision`) and appends to `decisions[]`. |
| ZO-N8 | SSE framing with a hand-rolled parser buys nothing once `EventSource` is ruled out; newline-delimited JSON over a chunked POST response is simpler. |
| ZO-N9 | The extraction prompt-caching claim is doubtful (three schemas, one run); re-weigh one model id now that extraction is span selection over text. |
| ZO-N10 | The homeowner route fetches by view id but no GET by id exists; pass props through navigation state. |
| ZO-N11 | `derived.formula` as a string invites an expression evaluator for one formula; use an identifier. |
| ZO-N12 | Plan item 87 is a drafting step, not a build target. |
| ZO-N13 | The event union is written twice (TS types and zod); derive types from the zod schemas. |

## Resolution (Elephant, applied without a gate at the author's instruction)

| Id | Category | Action |
| --- | --- | --- |
| ZO-1 | PROPOSE FIX | Removed `get_products`; `calculate_payment` takes product ids (default all); catalog lookup logged as a `tool.call` at context assembly. Tools are now `calculate_payment` and `propose_field_fill`. |
| ZO-2 | PROPOSE FIX | Two-tier matcher (exact span; normalized equality on the claimed page, then all pages); `anchorRequired`, Levenshtein, the window algorithm and the "approximate" style removed. The deterministic not-located case lives in `samples/extraction-fixture.json`; the keyed path shows the split-token value as either not located or located-but-wrong, and the CUJ and README say so. |
| ZO-3 | PROPOSE FIX | Added "Build order and cut line" at the top of the plan with a tag per item (floor, F1, F2, fallback) and the seven-step order; feature-2 verification made conditional. |
| ZO-4 | PROPOSE FIX | `confirmValue` is a pure transition; `review/tasks.ts` calls it and then `compareOnConfirm`. Component table updated. |
| ZO-5 | PROPOSE FIX | `npm start` is the only grader command; `persist()` and `data/state.json` removed. |
| ZO-6 | PROPOSE FIX | Extraction starts from `submitApplication`; `waiting_on_stated_value` removed everywhere. |
| ZO-7 | PROPOSE FIX | One judge rubric applied once per turn; judge-mode column and the judge's surface argument removed; the surfaces table keeps disclosure and footer rules only. |
| ZO-N1 | PROPOSE FIX | 4.4 steps 2 and 5 reduced to one sentence each pointing at the plan. |
| ZO-N2 | PROPOSE FIX | `pdf-lib` removed from root dependencies. |
| ZO-N3 | PROPOSE FIX | `MOCKS` variable removed; composition root instantiates the mocks; simulated latency removed. |
| ZO-N4 | PROPOSE FIX | Version constants removed; content hashes are the versions; ownership table says so. |
| ZO-N5 | PROPOSE FIX, except the Plaid stub (CONTEST) | Removed the `request_homeowner_view` tool, the multipart route and file inputs, and the badge poll (refetch on tab switch). The Plaid interface stays as a one-file typed stub with a comment: the PRD's requirement P-5 asks for conceptual integration with Plaid, and the stub is the evidence. |
| ZO-N6 | PROPOSE FIX | Task states trimmed to `ready | in_review | complete | extraction_failed`; `route` removed (all discrepancies go to the contractor, rule 3). |
| ZO-N7 | PROPOSE FIX | Value commands carry `actor` and optional `review_task_id` and emit one event; `decisions[]` is derived from the audit list. |
| ZO-N8 | PROPOSE FIX | Newline-delimited JSON over a chunked POST response replaces SSE framing. |
| ZO-N9 | PROPOSE FIX for the caching sentence; DECLINE for re-weighing the model | The extraction caching sentence removed. The copilot-on-Sonnet, extraction-on-Opus split is an owner decision recorded in the Technical Plan; Alternative K's wording updated to the text-based task. |
| ZO-N10 | PROPOSE FIX | Props passed through navigation state; no GET by view id. |
| ZO-N11 | PROPOSE FIX | `derived.formula` is an identifier mapped to one named function. |
| ZO-N12 | PROPOSE FIX | Item 87 removed. |
| ZO-N13 | PROPOSE FIX | `shared/types.ts` becomes `shared/schemas.ts` with zod schemas and inferred types. |

**Status: resolved.** 20 fixes applied to the design (7 Major, 13 Nit, one Nit partially contested); 1 contest (the Plaid stub, kept on PRD P-5); 1 decline (re-weighing one model id, an owner decision, deferred to the extraction eval). No findings remain open from this stage.
