# Goldfish Review Report: Critic Review (Stage 7, round 1)

**Target:** `/home/hdx/code/goodleap-loan-assistant/docs/designs/loan-assistant-design.md` (lines `1-1246`; the `## Detailed Implementation Plan` header at line 1247 and everything after it is out of scope)

**Standard:** `/home/hdx/.claude/remote/plugins/d383169c/9393724969628926/resources/document_standards/feature-spec-standard.md` (design and structural reviewers); the style reviewer audited against its persona only.

**Context supplied to every reviewer:** `docs/designs/loan-assistant-concept.md`, `docs/designs/loan-assistant-concept-goldfish-findings.md`, `docs/PRD.md`, `README.md`; the repository has no source code; the submission is due the morning of 2026-10-29 and is graded on the PRD rubric; the document had already passed a zoom-out review and a comprehension test.

## Reviewer Status

| Reviewer | Status | Raw findings returned |
| --- | --- | --- |
| `egm-design` (Design Critic) | completed | 0 Blocker, 10 Major, 20 Nit |
| `egm-structural` (Structural) | completed | 0 Blocker, 6 Major, 9 Nit |
| `egm-style` (Style) | completed | 0 Blocker, 18 Major, 15 Nit |

All three reviewers confirmed they read lines 1-1246 and stopped at line 1247. No retries were needed.

## Severity Summary (after deduplication)

| Severity | Count | Ids |
| --- | --- | --- |
| Blocker | 0 | none |
| Major | 22 | CR-1 to CR-22 |
| Nit | 24 | CR-23 to CR-46 |

No reviewer found a Blocker: nothing in scope would fail the PRD outright or is unbuildable as a whole. The Majors are of two kinds. CR-1 to CR-15 are design gaps and internal contradictions that would produce different builds or a demo that does not match its own CUJs. CR-16 to CR-22 are document defects that a grader reading the text will notice (author voice, rubric-gaming rationale, triple-stated specifications, undefined terms). Within each severity the list is ordered by consequence.

Synthesizer triage notes: three items were downgraded from a reviewer's Major to Nit where a second reviewer rated them lower or the impact is cosmetic (heading nesting under NFR, the hedged transcript window, the stray "card" wording). Where two reviewers rated the same issue differently, the merged finding carries the higher rating unless noted.

---

## Prioritized Findings (Blockers -> Major -> Nits)

### Blockers

None found by any reviewer.

---

### CR-1. Number-match has no defined behavior without calculator output and blocks the design's own clarifying question - Severity: Major
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** `CUJ 2` lines 235-236; `4.1 A copilot turn` step 6 lines 571-574; `6. The guardrail` lines 720-721 and 729-731; `2. Components` guardrail row line 412
* **Discrepancy Description**: Section 6 says number-match "extracts every currency and percent token from the prose; each must string-match a formatted value in the calculator output for this turn." CUJ 2 says that on "what if it were $40K?" the copilot "would ask 'Use $40,000 as the requested amount?'". That reply contains "$40,000", which is not a calculator value for the turn (no calculator ran, or it ran at $30,000). As written the check blocks the reply, the regenerate repeats the figure, and the contractor gets the Compliance fallback instead of the clarifying question. The same applies to any reply that echoes the contractor's own figure ("$30K" at lines 227-228; the calculator formats "$30,000.00", so a string match fails). If the builder resolves it by skipping the check when no calculator ran, a turn with no tool call can carry an invented payment figure unchecked, which is exactly what G4 (lines 117-122) exists to prevent.
* **Rationale & Recommendation**: This is a demonstrated CUJ that the guardrail, as specified, cannot pass. Define `check(text, calculatorOutput)` for the no-calculator case explicitly: the allowed set is the formatted calculator values for the turn plus numeric tokens that appear (after normalizing "$40K"/"$40,000") in the contractor's messages in the window; any other currency or percent token blocks. Add the "$40K" clarifying question and a "$30K" echo to the deterministic must-pass set under G10. See also CR-2 for echoed calculator inputs.

### CR-2. Calculator inputs are model-chosen tool arguments; G4's "never produces a number" is contradicted by the design's own data flow and the brief's echo-and-label mitigation is dropped - Severity: Major
* **Reviewer Lens:** `egm-design`, `egm-style`
* **Affected Scope:** `Goals` G4 line 117; `4.1` sequence diagram line 525 and steps 3-4 lines 554-567; `4.2 The homeowner view` lines 594-600; concept brief lines 312-315
* **Discrepancy Description**: G4 states "The model never produces a number or a coordinate." Line 556-557 states `calculate_payment` "takes amount, term and product ids" from the model, so the model produces two numbers on every payment turn. Step 4 then says the options content "depends on no model text and needs no judge, so it is on screen within about 3 seconds." The figures are deterministic but their inputs are a model judgment: a wrong amount or term yields a precise, fully disclosed, wrong payment rendered before any check and promoted to the homeowner view. The concept brief recorded the mitigation ("takes amount and term from confirmed form fields when they exist, and labels any result computed from an unconfirmed argument"; "echoes its inputs on the view and in chat"); the in-scope text carries neither. Line 38 states the claim correctly ("the model never computes a number"); G4 overstates it.
* **Rationale & Recommendation**: A grader who checks the diagram against G4 finds the absolute false, and the gap is the compliance-sensitive one (a wrong but confident payment figure on the borrower-facing surface). In 4.1 step 4 and 4.2: the server resolves `amount` and `term` as the confirmed form value when present, else the tool argument; records `inputs_source: form | argument` on the Options record; echoes "$30,000 over 120 months" on the options line and on the homeowner view; labels argument-sourced results ("based on an amount not yet on the application"). Reword G4 to "The model never computes a payment figure or produces a coordinate." Include the echoed inputs in the number-match allowed set (CR-1).

### CR-3. Write paths are incomplete: contractor-typed values, post-submit corrections, and what reviewer `confirmValue` writes to the application - Severity: Major
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** `2. Components` commands row line 401; `3. Data model` Application line 430, invariants lines 443-446, DiscrepancyRecord lines 452-456; `4.3` lines 606-616; `4.5` lines 663-666; `CUJ 5` lines 284-285; `10.` RDS bullet lines 827-830
* **Discrepancy Description**: (a) `commands` is "The only write path" with eleven commands; none accepts a contractor-typed field value. Pre-submit, typed values evidently live client-side and ride in with the turn ("structured form state", line 552) and with submit (line 430); that is workable but unstated, and the invariant "a contractor-typed value is never overwritten by a proposal" (line 444) is attributed to `commands`, which then needs those typed values as input. (b) Post-submit, "when the contractor has corrected the stated value on the form, the record is re-compared and resolves as `corrected`" (lines 664-666; CUJ 5 lines 284-285) names no actor: no command edits a submitted application's field, nothing triggers the re-compare, and `resolveDiscrepancy` belongs to the reviewer. The application's `fields` hold "confirmed values only" and nothing changes them after `submitted`. In production this is a post-submit edit of a decision-engine input with no named portal endpoint. (c) Line 430 says `confirmValue` "stands in for" the manual-review confirmation path that "already writes reviewed income with its provenance", but the Application model has no verified-income field distinct from `stated_annual_income`. If a reviewer's `confirmValue` on `annualized_income` writes into the application, which field does it write? It must not overwrite `stated_annual_income`, which the discrepancy record compares against; and for estimate and scope values there is no named target at all (section 10 names only income).
* **Rationale & Recommendation**: "Named backend commands are the only write path" (G5) is a headline compliance claim and the text leaves three writes unnamed. (a) State in section 3 that pre-submit typed values are client state sent with each turn and with submit, and that `commands` receives them as an argument when enforcing line 444. (b) Either make `corrected` design-only (CUJ 5 ends at `explained`) or add `updateStatedValue(applicationId, fieldKey, value)` permitted only in `documents_under_review`, emitting `field.edited` with actor contractor and re-running the compare for open records on that field; name the production path or mark it an assumption. (c) Name the application-side target of reviewer confirmation (for example `verified_annual_income` with `verification_source`), state that estimate and scope confirmations are review-and-discrepancy data only, and say that `confirmValue` with a `review_task_id` never writes a `stated_*` field.

### CR-4. Extraction trigger differs between prototype (submit) and production (upload); the "never meets an unconfirmed stated value" invariant is argued only for the prototype - Severity: Major
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** `3. Data model` DiscrepancyRecord lines 458-460 and ReviewTask lines 463-464; `4.3` lines 615-616; `4.4` step 1 lines 623-624; `10.` Extraction consumer bullet lines 816-818
* **Discrepancy Description**: Lines 458-460: "Because extraction starts at submit and submit requires every proposal to be confirmed or rejected, a comparison never meets an unconfirmed stated value." Section 10 has the consumer "consuming the existing document-uploaded SQS message", which fires at upload, before submit. In production, extraction and review-task creation therefore run on draft applications, and a reviewer can confirm a pay-stub value while stated income is still a copilot proposal or empty. The brief's "if the stated value is still an unconfirmed copilot proposal, the discrepancy waits" (concept lines 210-212; findings B5 `waiting_on_stated_value`) was dropped on the strength of the submit trigger, which production does not have. Also, per-document upload messages cannot tell the consumer when "every slot" has been extracted (lines 463-464), since completion is per application.
* **Rationale & Recommendation**: The prototype works; the production design silently loses the invariant the data model relies on. Choose and state one: (a) production extracts at upload, but review-task creation and the discrepancy compare are gated on application status at or beyond `submitted`, and the consumer checks slot completeness per application on each message; or (b) the trigger is the submit event in both environments and the consumer filters on a submitted flag. In either case restore one sentence: if the stated value is unconfirmed or absent at compare time, no record is raised and the compare re-runs at submit.

### CR-5. Derived values (annualized income) have no lifecycle after extraction: no recompute on edit, no state, unclear compare trigger - Severity: Major
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** `4.4` step 6 lines 645-647; `4.5` lines 654-659; `CUJ 4` line 268; `CUJ 5` lines 276-277; `3.` ProposedValue lines 436-437; commands row line 401 ("none calls back into `review` or `extraction`")
* **Discrepancy Description**: Derived fields are computed once in the consumer from the extracted proposals and "point at their input proposal ids". The compare runs "when the field has `compareTo`" after the reviewer's value command. For income, the field with `compareTo: stated_annual_income` is the derived `annualized_income`, not gross pay, yet CUJ 5's trigger is "The reviewer confirms the pay stub's gross pay and pay frequency". The text does not say who recomputes `annualized_income` when gross pay is corrected via `editValue` (the stored derived value becomes stale), what state the derived proposal has (CUJ 4 shows it as a listed value, and "Complete review" requires every value to have a state; does the reviewer Confirm a formula, and what would Correct mean?), or at which event the compare fires. Because `commands` may not call `review` or `extraction`, the recompute must live in the review decision path, which is not stated.
* **Rationale & Recommendation**: CUJ 5 is the discrepancy demo and its trigger does not match the engine's rule. Specify that derived proposals are owned by the review decision path: after any value command on an input, recompute from the inputs' final values, write via `proposeFieldValue` (superseding the prior), auto-set state `confirmed` with actor `system` when every input is confirmed or edited, then run the discrepancy engine on it. Derived values are not Confirm/Correct targets (Flag only). Reword CUJ 5's trigger to match.

### CR-6. The audit stream cannot reconstruct a conversation on its own, and "the schema document" holding PII classes has no antecedent - Severity: Major
* **Reviewer Lens:** `egm-design`, `egm-style`
* **Affected Scope:** `Goals` G6 lines 128-132; `CUJ 6` lines 295-296; `2.` store row line 402; `3.` AuditEvent `model.call` lines 486-487 and the paragraph at lines 504-506; `4.1` step 1 lines 547-548; `10.` RDS and S3 bullets lines 825-832
* **Discrepancy Description**: `model.call.context` is `{ message_ids, system_prompt_version, system_prompt_sha256 }` plus `raw_output`. Message text lives only in `store.transcripts`, which is in-memory: "Nothing is persisted beyond the process except the audit JSONL" (line 402). CUJ 6 promises "`model.call` entries show the exact context the model saw"; line 504 says raw prompts are inlined in the prototype JSONL, but no event field holds them. `field.proposed.source.ref = message_id` and the badge tap that "scrolls to and highlights the sentence it came from" resolve against the transcript, so after a restart (and in production, where the four new tables contain no transcript table and S3 is named only for "raw prompts") proposals and model calls point at nothing. G6's "reconstructible from one application id" rests on a store the design neither persists nor names. Separately, lines 505-506 say "Each payload field carries a PII class in the schema document so the production split (section 10) is mechanical", and no schema document is named anywhere in scope (the brief's `docs/audit-schema.md` does not appear in this design).
* **Rationale & Recommendation**: G6 and CUJ 6 are the audit demo and a graded compliance surface. Add `message.received { message_id, text, actor }` so the stream is self-contained, and `raw_input_ref` on `model.call` (inlined `raw_input` in the prototype). In section 10 name the transcript's durable home. Alternatively state plainly that the transcript is outside the audit record and remove "exact context" from CUJ 6. For the PII class, name the file or write "in the `AuditEvent` type definition".

### CR-7. Eval datasets, thresholds and the gate rule are claimed "specified in full" but are not in the design; `docs/evals.md` is cited as if it existed - Severity: Major
* **Reviewer Lens:** `egm-design`, `egm-structural`
* **Affected Scope:** `Goals` G10 lines 147-152; `Alternatives` K lines 971-973; `Non-Functional Requirements` Rollout bullet lines 1207-1212 (line 1210); PRD D-3
* **Discrepancy Description**: G10 states "Judge, extraction and field-fill eval sets are specified with datasets, thresholds and the gate rule". Lines 1-1246 contain no threshold, dataset size or gate rule for any set; the text defers to `docs/evals.md`, which is not in the repository (`docs/` holds `PRD.md`, `designs/`, `source/`, `private/`), and the numbers appear only in out-of-scope plan item 83 as the contents of that not-yet-written file. Lines 972 and 1210 cite `docs/evals.md` as existing, while line 7 qualifies the sibling file `docs/design-document.md` as "not yet written". The brief carried the numbers (judge 10 prompts, at least 8 flagged; extraction 90% field match on text PDFs, 80% located on the image; pre-launch 100 labeled outputs, recall at least 0.95, false-positive rate at most 5%).
* **Rationale & Recommendation**: The rubric grades "approach to evaluation and testing" and "evaluation frameworks", and line 7 says the submission document is condensed from this design, so what is absent here cannot be condensed. Add a Technical Plan subsection "12. Evaluation and monitoring" with, per set, the dataset, metric, threshold and gate, plus the feedback loop (reviewer corrections become the extraction set; blocked text becomes the guardrail set). Keep `docs/evals.md` as the long form and mark both references at 972 and 1210 as planned, matching line 7.

### CR-8. PRD D-5 and D-6 material is missing: no named monitoring metrics, no drift or AI-quality tracking, no MVP timeline, no contractor change management - Severity: Major
* **Reviewer Lens:** `egm-design`, `egm-structural`
* **Affected Scope:** `Non-Functional Requirements` Rollout bullet lines 1207-1215; `9. Latency, cost and volume` lines 798-807; `10.` three-stores bullet lines 833-838; `Alternatives` E lines 912-919; fragments at lines 326-327, 759, 775, 806, 1235; PRD D-5, D-6
* **Discrepancy Description**: Phases "gate on the eval thresholds in `docs/evals.md` and on the monitored metrics" (line 1210) without naming the metrics. The brief's metric lists (deny-list hit rate, judge block rate, disagreement rate in both directions, `judge_unavailable` rate, regenerate-then-fallback rate; per-field confirm/correct/flag rate and correction magnitude; source-not-located rate per adapter; queue time; needs-clarification rate and time to resolve; completion time and abandonment flag-on vs flag-off) survive only as fragments: the reviewer correction rate (lines 326-327, 759), `catalog.schema_mismatch` (line 775), queue-time metrics (line 806), source-not-located rate (line 1235). There is no operational definition of drift or hallucination rate, no statement of how long the MVP takes to ship, and nothing on how 15,000 contractors learn the panel exists (the suggested prompts are the only onboarding device and are not framed as one). Alternative E rightly rejects the six-section shape for this document, but then this document must hold the content those six sections need.
* **Rationale & Recommendation**: Rollout and monitoring are rubric items (Technical Depth, Pragmatism) and the submission document has nothing to condense from. Add a "Monitoring and impact" subsection (table: metric, source event, owner, alert) and extend Rollout with an MVP definition and a days-level estimate per phase, change management (in-portal announcement, one-page contractor guide, suggested prompts as onboarding, support path), and drift signals with the feedback loop. Can share the new subsection proposed in CR-7.

### CR-9. No Risks and Mitigations section; risks are scattered and several predecessor-raised risks have no home - Severity: Major
* **Reviewer Lens:** `egm-structural`, `egm-design`
* **Affected Scope:** whole in-scope document; natural slot after `### 11. Ownership and surfaces` (line 867) or before `## Non-Functional Requirements` (line 1195); existing fragments at `6.` lines 741-743, `7.` lines 757-759, `8.` lines 766-783, `9.` lines 805-807, `10.` lines 833-838 and 842-846, NFR lines 1197-1215
* **Discrepancy Description**: The standard's "Risks & Limits" rule ("must identify potential failure modes, security implications, scalability limits, and how they will be mitigated") and its Requirements list ("Risks & Mitigations") have no corresponding section. Failure modes are in section 8, the guardrail asymmetry in section 6, the OCR wrong-but-located gap in section 7, the reviewer-minutes limit in section 9, PII and retention in section 10 and NFR Security. Nothing consolidates them, and risks the predecessor findings raised (model-id deprecation and version drift, M4; the judge sharing a model family with the generator, M4; reviewer queue backlog at peak, M11; provider data-retention terms, M7) appear only as single clauses or not at all.
* **Rationale & Recommendation**: A reader checking the document against the standard cannot find the required area, and gaps are invisible because there is no list to be incomplete. Add `## Risks and Mitigations` with a table (risk, where it bites, likelihood, mitigation, owning section) that points at the existing sections rather than restating them, and add rows for the risks that currently have no home. This also gives the submission document its compliance-and-safety section.

### CR-10. The not-located demonstration is not guaranteed on the keyed path, and null extraction results have no reviewer row - Severity: Major
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** `Goals` G7 lines 136-138; `CUJ 4` lines 264-268; `4.4` steps 4-6 lines 634-647; `7. Provenance` lines 751-756; `8.` line 776
* **Discrepancy Description**: Under "positioned text only", the model quotes lines it was handed, so "a non-match means a wrong citation or a paraphrase" (line 754). An OCR-mangled value is therefore located (wrong but located), which the design accepts, so the brief's "one value in the sample set is deliberately not locatable and is named in the README walkthrough" cannot be engineered by mangling. G7 concedes the keyed path shows one only "when the model's quote does not match a line", so the graded (keyed) walkthrough cannot promise the G7 behavior. Separately, step 4 permits a per-field `null`, but steps 5-6 describe only fields with a quote, and step 6 calls a null frequency "not located", conflating two outcomes. A null field creates no `ProposedValue`, so the reviewer has nothing to Confirm, Correct or Flag ("missing" is a flag reason with no row), the "every value has a state" gate has nothing to gate, and a realistic OCR dropout silently vanishes from review.
* **Rationale & Recommendation**: (1) Decide how the keyed walkthrough shows not-located: make it opportunistic in the README, or engineer it deterministically (for example, the pay-stub OCR fixture carries the net-pay tokens in the indexed text with no geometry, so the quote verifies but the box union is empty and the value is `not_located` with its quoted text; a realistic Textract failure). (2) Define the null outcome: a proposal with `value: null` and `match.method: "not_extracted"`, rendered as a row with Correct (enter value, `located_by_reviewer`) and Flag(`missing`); change step 6's condition to "not extracted or not located".

### CR-11. Contractor chat: full disclosure block or footer? Three sections disagree, and the footer's "APR x%" is undefined with three options - Severity: Major
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** `CUJ 1` lines 213-215; `4.1` step 4 lines 561-567; `Goals` G3 lines 115-116; `11. Ownership and surfaces` line 865; `2.` Contractor route line 423
* **Discrepancy Description**: CUJ 1: "the options table renders (three products, each with monthly payment, term, APR, and the disclosure block)". 4.1 step 4: the `options` line carries "the rendered disclosure block". Section 11: `contractor_chat` disclosure template is "footer on payment figures". G3: chat replies "carry a one-line estimate footer". If the chat renders the full TILA four-cell box per option, the footer is redundant and the panel shows three disclosure boxes on a tablet (the "woven in without disrupting" rubric line); if the chat renders only the footer, CUJ 1 is wrong and the block is data for the homeowner view. The footer text at line 566 ("Estimate only. APR x%. Not an offer of credit; subject to credit approval.") names one APR while the reply covers three options.
* **Rationale & Recommendation**: State it once: the `options` line carries the block as data; the chat renders the options table with per-option APR and the compact footer; the full block renders on the homeowner view. Align CUJ 1 and section 11. Tie the footer's APR to the table or drop it from the footer.

### CR-12. The number and name of the guardrail checks are inconsistent, and whether all three run on every draft is unstated - Severity: Major
* **Reviewer Lens:** `egm-style`, `egm-design`
* **Affected Scope:** `Overview` line 53; `Goals` G2 lines 105-108; `CUJ 1` line 222; `Owner decisions` line 317; `2.` guardrail row line 412; AuditEvent line 489; `4.1` steps 6-7 lines 571-578; `5.` table line 684; `6.` lines 720-721; `9.` line 791; `Alternatives` J line 962
* **Discrepancy Description**: Variants: "three checks (a versioned deny-list, a small-model judge, and a number-match check)" (53); "enforced three ways" (105) where the three listed are deny-list, judge and the fixed out-of-scope reply (number-match is absent); "three guardrail verdicts" (222); "guarded by three checks" (317); "three implementations" (412); "layer" (489, 578, 720); "three guardrail layers" (684); "three guardrail checks" (791); "guarded three ways" (962). G2 is the first place a grader meets "three" and its three are not section 6's three. Further, section 6 says "Order: denylist -> number_match -> judge. Either block is final" and 4.1 says "A disagreement between layers is logged as a tuning signal": if layers short-circuit, disagreement is observable in one direction only and a blocked turn has fewer than the three verdicts CUJ 1 promises.
* **Rationale & Recommendation**: In G2 either add number-match or retitle ("enforced by deny-list, judge and a fixed reply"); use "check" in prose throughout and keep `layer` only as the event field name. State that all three checks run on every draft and any block is final, so CUJ 1's three verdicts and the disagreement signal both hold.

### CR-13. The latency budget has three different starting points, and "about" is attached to a p95 - Severity: Major
* **Reviewer Lens:** `egm-structural`, `egm-style`, `egm-design`
* **Affected Scope:** `Goals` G1 lines 100-104; `CUJ 1` lines 213-215; `4.1` step 4 lines 561-567; `9. Latency, cost and volume` table lines 790-792; `5.` line 684; `4.1` diagram line 538
* **Discrepancy Description**: G1: "Measured from the server receiving the contractor's message: payment options with their disclosure block are on screen within about 3 seconds (this includes the first model round...) ... 30 seconds end to end including typing." The 30-second figure includes typing, which precedes the stated origin. 4.1 step 4 agrees with G1 ("within about 3 seconds of the server receiving the message, a budget that includes the first model round"). The section 9 table row reads "Options and disclosure block on screen (after the question is understood) | about 3 s", which starts the clock after the first model round, the thing G1 says the budget includes, and "after the question is understood" is not a measurable event. "Within about 10 seconds p95" (103, 538, 791) hedges a threshold. With thinking on at low effort (line 684) the first round dominates the 3 s and no support is given for the figure.
* **Rationale & Recommendation**: Latency is a graded item and the document states the budget three ways. State one origin (server receipt) for the 3 s and 10 s budgets, state the 30 s as a separate end-to-end figure with its own origin (contractor starts typing), and change the table row to "from server receipt (includes the first model round)" or add a row for the model round so the two sum visibly. Write "10 s p95" and "3 s" without "about". Say the "Show payment options" button is the bound if the measured number lands at 4-6 s.

### CR-14. Command-to-audit-event mapping gaps: `createReviewTask` has no event type, `submitApplication` yields two transitions, `document.attached` has two emitters - Severity: Major
* **Reviewer Lens:** `egm-structural`, `egm-design`
* **Affected Scope:** `2.` commands row line 401 and audit-log row line 403; `3.` AuditEvent union lines 480-502 (498, 500); `4.3` lines 611-613; `4.4` step 1 lines 620-621 and step 7 lines 648-650; `4.5` lines 669-671
* **Discrepancy Description**: Line 401 lists eleven commands and states each "emits exactly one audit event"; line 403 states "Event union type is the schema". Ten commands map to a type; `createReviewTask` has none (the JSM mock's `createIssue` and `addLink` at 648-650 are `tool.call` events from the service, not the command's event). `submitApplication` yields `submitted` then `documents_under_review` "once extraction has been started" (612-613), and `completeReview` emits `review.completed` and a state change (669-671), so these commands emit more than one event or something outside `commands` mutates the application (if the consumer flips `documents_under_review`, it is a write outside the "only write path"). `document.attached` is emitted by the documents service at 620-621 and by the `attachDocument` command at 401.
* **Rationale & Recommendation**: The union is declared normative, so the gap is a schema gap. Add `review.task_created { task_id, document_ids, slot_statuses, jsm_issue_id }` to the union (and to CUJ 6 if it should be visible). Say which component emits the second transition and relax the rule to "one primary event plus any derived `application.state_changed`". Pick the command as the single emitter of `document.attached`.

### CR-15. Extraction failure semantics contradict the data model, and the retry sentence reads as unconditional - Severity: Major
* **Reviewer Lens:** `egm-structural`, `egm-design`, `egm-style`
* **Affected Scope:** `8. Errors and degradation` rows lines 771-773 and kill-switch lines 781-783; `3. Data model` ReviewTask and Document lines 462-473; `4.4` step 4 lines 634-638
* **Discrepancy Description**: Section 8 says `llm.refusal` makes the "extraction task `extraction_failed`" and `llm.schema_invalid` yields "one retry, then `extraction_failed`". Section 3 says the task "is `extraction_failed` only when every slot failed" (472-473) and that a failing slot is recorded on the Document as `extraction_status: failed`; 4.4 step 4 says the same. `extraction_failed` is a ReviewTask enum value, so the table contradicts the model for the single-document case. Step 4's sentence "one retry on validation failure; then the document's `extraction_status` is `failed`" follows every validation as written, not only a failed retry. The `llm.timeout`, `llm.rate_limited`, `llm.server_error` row names "copilot" only and says nothing about extraction. With `EXTRACTION_ENABLED=false` the text does not say whether submit still creates a review task with every slot flagged for manual reading, so the reviewer tab may dead-end.
* **Rationale & Recommendation**: Change the two table rows to "document `extraction_status = failed`; slot flagged for manual reading; task `extraction_failed` only if every slot failed". Rewrite step 4 as "one retry on validation failure; if the retry also fails, `extraction_status` is `failed`...". Add extraction behavior to the timeout row and state the kill-switch behavior for review-task creation.

### CR-16. "submitted, documents under review" is written as one stored status while the enum has two states - Severity: Major
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** `Overview` lines 58-59; `Non-Goals` line 157; `CUJ 2` line 237; `CUJ 5` line 286; `3. Data model` line 429; `4.3` lines 612-613; `Alternatives` Z line 1098
* **Discrepancy Description**: Line 237: 'Submit records "Submitted, documents under review" and nothing else'; line 286: 'The stored application status is "documents under review" throughout'; line 429: `status (draft | submitted | documents_under_review | documents_reviewed)`; lines 612-613: "application status becomes `submitted`, then `documents_under_review` once extraction has been started". A builder writing the CUJ 2 acceptance test cannot tell from 237 whether the quoted phrase is a stored value, a UI label, or two states.
* **Rationale & Recommendation**: CUJs are what tests are written against. At 237 write 'Submit sets status `submitted` (then `documents_under_review` when extraction starts) and the form shows "Submitted, documents under review"'; elsewhere use the enum names when referring to stored status and the quoted phrase only for the on-screen label.

### CR-17. "The engine" is ambiguous in 4.5, and the credit decision engine has five names - Severity: Major
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** `4.5` line 659; credit-engine naming at lines 51, 58, 108, 110, 156, 162, 168, 238, 298, 354, 389, 416, 426, 614, 678, 903, 1037, 1050, 1093, 1099, 1213
* **Discrepancy Description**: Line 659: "The commands never call the engine, so the dependency runs one way." Here "engine" is the discrepancy engine of line 656, but "the engine" elsewhere is the credit decision engine. Variants for the credit decision engine: "credit decision engine" (51, 58, 108, 354, 614); "decision engine" (156, 162, 168, 389, 903, 1037, 1050, 1093, 1099, 1213); "credit-engine" (238, 426, 678); `credit_engine` (110, 298); `creditEngine` (416).
* **Rationale & Recommendation**: In a document whose central compliance claim is "no code calls the credit decision engine", a bare "the engine" in a sentence about commands will be read as that claim and then found to be about something else. Change 659 to "never call the discrepancy engine". Use "credit decision engine" in prose on every mention; keep `credit_engine` and `creditEngine` only as identifiers.

### CR-18. "Owner" is undefined and misattributes author choices to a stakeholder; the "Owner decisions" heading is an unnumbered sibling that duplicates later content - Severity: Major
* **Reviewer Lens:** `egm-style`, `egm-structural`
* **Affected Scope:** `Technical Plan` > `### Owner decisions recorded in this section` lines 314-327 (314, 324); `Alternatives` K line 971, L line 981, O line 1003; duplicated content at `5.` lines 684-686 and `Alternatives` J-L lines 957-983
* **Discrepancy Description**: "Owner decisions recorded in this section" (314); "The known cost, accepted by the owner" (324); "Owner decision: extraction goes to Opus 5.5" (971); "Owner decision for one code path" (981); "No box on the page, which the owner requires for both text and image PDFs" (1003). "Owner" is never defined; the concept brief calls the same calls "the author's requirement" (concept.md line 488) and "the author's call" (line 95). A grader reads "the owner requires" as a GoodLeap product owner. Structurally, eleven H3s are numbered 1-11 and every cross-reference uses "section N", while this H3 is unnumbered and precedes "1."; its two bullets restate the section 5 table's "Why" column and Alternatives J, K and L.
* **Rationale & Recommendation**: Misattributing a self-imposed scope choice to the client is a credibility risk with graders. Replace "owner" with "author" (or "this design") in all five places. Fold the two decisions into sections 5 and 7 (or make the heading a short unnumbered preamble paragraph with no H3).

### CR-19. Alternatives are justified by grading-rubric scoring rather than product or engineering reasons, and "rubric" then collides with the judge's rubric - Severity: Major
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** `Alternatives` B lines 891-892, I line 950, W lines 1071-1072, AD lines 1131-1132, AE lines 1142-1143, AG line 1155; judge-rubric uses at `2.` line 412, `4.1` lines 574 and 576, `6.` line 732; `Additional Resources` line 1223
* **Discrepancy Description**: 891: "the rubric's contractor-workflow and conversational-UX criteria have nothing to grade"; 950: "Pros: Rubric credit for RAG and embeddings"; 1071-1072: "which the rubric's 'woven in without disrupting' line penalizes"; 1131-1132: "the rubric's design-taste score does not reward; the contractor and homeowner views are where it is graded"; 1142-1143: "which are the graded surfaces"; 1155: "Cost with no rubric credit". Meanwhile "judge with one rubric" (412), "one classification rubric" (574), "The rubric is the strict one" (576), "one fixed rubric" (732) use the same word for the judge's criteria; a reader who has just seen the grading rubric referenced will misread 576.
* **Rationale & Recommendation**: The document is read by the graders; "we did X because the rubric rewards it" reads as optimizing the score rather than the product. Each case has an underlying product reason already implied (no contractor or homeowner surface to design; the catalog fits in the prefix; legalese is skipped by readers; the audit page is not user-facing; a CLI cannot show disclosures; extra processes risk the 5-minute run). Delete the rubric clauses and keep the product reason. Call the judge's criteria "the judge criteria" (or "judge prompt") everywhere and reserve "rubric" for the grading rubric, if it is referenced at all.

### CR-20. Build-session and review-response voice left in the specification; the Alternatives provenance sentence is wrong - Severity: Major
* **Reviewer Lens:** `egm-style`, `egm-structural`
* **Affected Scope:** `Alternatives` AB line 1116, AF line 1149, AJ lines 1180-1181; `Owner decisions` lines 325-327; `3.` line 457; `6.` line 741; `7.` line 757; `9.` line 798; `Alternatives Considered` intro lines 870-872
* **Discrepancy Description**: Time-bound developer voice: "one generic reviewer panel is less work tonight than three hand-written ones" (1116); "do not mix under time pressure" (1149); "A dependency the author must explain line by line; more setup tonight than a vitest file" (1180-1181). Review-response voice: "This replaces the drift canary suggested in the review findings" (325-327); "(rule 3 of the brief)" (457; "the brief" is ambiguous between the portal brief and the concept brief); "Asymmetry, stated:" (741); "The stated gap:" (757); "Volume, labeled an assumption:" (798). The provenance sentence at 870-872 ("the source for the first four groups is the concept brief's 'Alternatives Weighed' table, and the last group records alternatives rejected while writing the Technical Plan") is false: in the first four groups E, J, K, L, M and R are not in the brief's table (concept.md 550-577), and in the last group AE, AF, AG and AJ are.
* **Rationale & Recommendation**: "Tonight" and "stated" answer reviewers and date the document; a grader reads them as developer notes. Use "within the build window"; drop "the author must explain line by line" (restate as "an unexplained dependency"); write "Asymmetry:", "Known gap:", "Volume (assumption):"; "(concept brief, rule 3)"; move 325-327 to Alternative L or delete; replace 870-872 with "most entries come from the brief's table; E, J, K, L, M, R, AH, AI and AK were added while drafting" or drop the attribution.

### CR-21. "Reason for Rejection" entries state the chosen design, not a reason - Severity: Major
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** `Alternatives Considered`, 27 entries at lines 902-903, 909-910, 928-930, 937-938, 945-946, 953-955, 990, 997-998, 1013-1014, 1021-1022, 1029-1030, 1040-1042, 1049-1050, 1057-1058, 1065-1066, 1073-1075, 1082-1083, 1090-1091, 1117-1118, 1125, 1144, 1150, 1156-1157, 1164-1168, 1174-1175, 1182-1183, 1190-1191
* **Discrepancy Description**: Examples: 1125 "Reason for Rejection: One task per application with a tab per document."; 1144 "Reason for Rejection: A React web app with three role tabs served by the Node backend."; 1150 "Reason for Rejection: Vite plus Express, served from one process."; 990 "Reason for Rejection: Positioned text only, with the model selecting an indexed span." Under a label that promises a reason, most entries give the replacement; the reason is in Cons.
* **Rationale & Recommendation**: A grader scanning the bold labels gets decisions without rationale, in the section the standard requires precisely for rationale. Rename the label to "Chosen instead" (or "Decision") for the whole section, or begin each entry with the reason ("Because <Cons>, ...").

### CR-22. The guardrail pipeline, the discrepancy lifecycle and banner text, and the NFR rollout and compatibility bullets are each specified two or three times - Severity: Major
* **Reviewer Lens:** `egm-style`, `egm-structural`
* **Affected Scope:** guardrail: `4.1` steps 6-7 lines 571-582 vs `6.` lines 717-743 (also G2 105-108, line 412); discrepancy lifecycle: `3.` lines 452-460 vs `4.5` lines 654-672 vs `CUJ 5` lines 277-287 (also G8 139-142, Alternative T 1049-1050); requested-amount rule twice inside 4.5 at 657-659 and 666-667; banner text at 280-281 and 667-669; NFR Rollout and Compatibility lines 1207-1215 vs `1.` lines 388-390, `8.` lines 781-783, `10.` lines 813-815 and 842-846
* **Discrepancy Description**: 576-577 "The rubric is the strict one because the contractor's screen is visible to the homeowner over the shoulder, and the same judged text is what the homeowner view shows" vs 734-735 "There is one mode, the strict one, because the same judged text reaches the homeowner over the contractor's shoulder and on the homeowner view"; 577-578 vs 721; 574-575 categories vs 732-734; 579-582 trip behavior vs 737-740 and 735-736. The lifecycle at 452-456 and 663-666 is near verbatim; the banner text at 280-281 and 667-669 is verbatim. Within 4.5, "requested amount: more than 5% above the project estimate total" (658-659) is restated eight lines later (666-667). NFR 1213-1214 copies 388-390 word for word, and the Rollout bullet copies the flags, phases and rollback from sections 8 and 10, while the Performance and Security bullets correctly point back to sections 9 and 10.
* **Rationale & Recommendation**: Each copy is a drift point in a document that will be condensed to three pages. Keep the schema in section 3, the flow in 4.x, the component definition in section 6, and replace the other copies with a pointer; in 4.1 steps 6-7 keep the sequence only ("the final text goes through the guardrail (section 6); on a block..."). Delete 666-667. Quote the banner text once. Make the NFR Rollout and Compatibility bullets one-line references like the other two.

---

### CR-23. "Homeowner view" is also called a "card"; "view-first" vs "Card-first" timeline - Severity: Nit
* **Reviewer Lens:** `egm-style`, `egm-structural`
* **Affected Scope:** `10.` Rollback line 845; `Alternatives` V heading line 1060; `Future Improvements` line 1230; vs `Non-Goals` line 179 and `Alternatives` line 1127
* **Discrepancy Description**: "cards shown under a bad catalog version" (845); "The homeowner card as a panel inside the contractor layout" (1060); "Card-first audit timeline" (1230) against "view-first audit timeline" (179, 1127) and "homeowner view" everywhere else. The predecessor findings (M14, M22) asked for "homeowner view" consistently.
* **Rationale & Recommendation**: Three stray uses after a finding that was reported as applied. Write "homeowner views shown under a bad catalog version" (845), "The homeowner view as a panel inside the contractor layout" (1060), "View-first audit timeline" (1230). Downgraded from the style reviewer's Major because the dominant term appears over twenty times and a reader will resolve the stray uses.

### CR-24. Transcript window size is hedged - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** `4.1` sequence diagram line 522; `4.1` step 2 lines 552-553; `5.` line 707
* **Discrepancy Description**: "last ~10 turns" (522); "the last ten or so transcript turns" (552-553); "the last ten or so turns" (707).
* **Rationale & Recommendation**: An unspecified constant; two builders pick 8 and 12. Write "the last 10 turns" or name the constant and its value once. Downgraded from Major because the window size is neither graded nor safety-relevant.

### CR-25. Garbled sentence in the CUJ 3 pass criterion - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** `CUJ 3` lines 253-254
* **Discrepancy Description**: "Either path is a pass for this journey: what the homeowner can be read never contains a verdict word."
* **Rationale & Recommendation**: The clause is ungrammatical and it is the pass criterion of the journey. Write "what can be read to the homeowner never contains a verdict word".

### CR-26. Deny-list "and their forms" vs the model-written out-of-scope reply containing "approval" - Severity: Nit
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** `Overview` lines 31-32; `CUJ 3` line 245; `4.1` lines 586-589; `6.` lines 725-728
* **Discrepancy Description**: The verdict-word definition includes "their forms"; the model-written reply "approval decisions are made by GoodLeap's credit team" contains a form of "approve" and is model-written prose that the deny-list scans. CUJ 3 would then trip on every out-of-scope question and show the fallback rather than the designed reply (the CUJ still passes because "either path is a pass", but the designed reply never appears).
* **Rationale & Recommendation**: Add the phrase to the allow-list and to the must-pass set, or scope the deny-list to the five surface forms and say so at line 31.

### CR-27. Model ids as written look like aliases, and Alternative J's con does not distinguish Opus from Sonnet - Severity: Nit
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** `Owner decisions` lines 316-320; `Alternatives` J lines 960-961 vs `5.` line 684; concept lines 605-606
* **Discrepancy Description**: `claude-sonnet-5-5` and siblings are undated while the text says "'latest' aliases are never used". Alternative J's con "Thinking cannot be disabled on Opus 5.5" is equally true of Sonnet 5.5 per line 684, so it does not argue for Sonnet.
* **Rationale & Recommendation**: Confirm the strings are the published snapshot ids; if the snapshot carries a date suffix, pin that string. Reword Alternative J's con to per-token speed.

### CR-28. Four load-bearing external API claims are asserted, not tested - Severity: Nit
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** `4.1` lines 554-555 (forced tool choice rejected); `5.` line 684 (thinking cannot be disabled) and line 691 (prefill rejected); `Alternatives` O lines 1003-1004 (citations incompatible with structured outputs); `Additional Resources` lines 1224-1226
* **Discrepancy Description**: Each claim shapes a workaround (prompt-named tool, low-effort thinking in the 3 s budget, no prefill, no citations) and none is marked as verified.
* **Rationale & Recommendation**: For a one-day build, verify each with one smoke call before writing the tool loop; if any is wrong the workaround changes, and the latency budget improves if thinking can be disabled. Record the result beside each claim.

### CR-29. Cost arithmetic counts one model call per turn, and "roughly" is paired with three-decimal precision - Severity: Nit
* **Reviewer Lens:** `egm-design`, `egm-style`
* **Affected Scope:** `9.` lines 800-803
* **Discrepancy Description**: A tool round is two calls, each re-sending the fresh window, and thinking tokens bill as output; the per-turn figure assumes one. "roughly $0.010 per turn", "roughly $0.026" give three decimals under a hedge.
* **Rationale & Recommendation**: The conclusion (LLM spend is not the constraint) stands; restate as about two calls per turn so it survives a reader who checks, and write "about $0.01", "about $0.03".

### CR-30. Interim text in the tool-use round is neither displayed nor guarded per the text - Severity: Nit
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** `4.1` diagram lines 523-530; step 1 lines 545-548
* **Discrepancy Description**: A text block can accompany `tool_use` in round one; the text says only that "the final text goes through the guardrail".
* **Rationale & Recommendation**: State that only the final text block renders and interim text goes to `raw_output`.

### CR-31. JSM issue: "creates and updates" vs "created unchanged, gets a link" - Severity: Nit
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** `Alternatives` X line 1082 vs `10.` lines 820-823 and `Open Questions` lines 193-195
* **Discrepancy Description**: Alternative X says the consumer creates and updates the issue; section 10 says the issue is created unchanged by today's path and gets a link.
* **Rationale & Recommendation**: Write "updates the issue today's path creates; creates only if that path is absent".

### CR-32. Hard floor and cut order are not in the in-scope text - Severity: Nit
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** `Overview` lines 63-65; `Alternatives` A lines 882-885
* **Discrepancy Description**: The floor and the cut line live only in the out-of-scope plan.
* **Rationale & Recommendation**: Add a one-line pointer in the Overview so the morning-of decision has an in-document rule.

### CR-33. The homeowner view reuses the contractor-addressed explanation verbatim - Severity: Nit
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** `4.1` lines 576-577; `4.2` lines 596-597; `11.` line 864
* **Discrepancy Description**: A chat answer written to the contractor ("tell her ...") reads oddly on the screen the homeowner holds.
* **Rationale & Recommendation**: State the prompt's voice rule (third-person option descriptions, address neither party) or render only the catalog mechanic sentences on the homeowner view.

### CR-34. The no-key extraction fixture is absent from 4.4 - Severity: Nit
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** `Goals` G7 line 137; `CUJ 7` lines 306-307; `8.` line 770; `4.4` lines 634-644
* **Discrepancy Description**: The no-key fixture is promised in three places but 4.4 describes only the keyed call.
* **Rationale & Recommendation**: State that the fixture is a recorded structured-output response per document replayed through steps 5-6, so the not-located value is produced by the matcher, not hard-coded.

### CR-35. CUJ 2's exact count "five" depends on the model and on the seed - Severity: Nit
* **Reviewer Lens:** `egm-design`
* **Affected Scope:** `CUJ 2` lines 229-234
* **Discrepancy Description**: "$30K" can legitimately propose `requested_loan_amount` if the seed leaves it empty; the CUJ asserts five.
* **Rationale & Recommendation**: Soften to "the fields stated in the message" or state the seed's filled fields in the Given.

### CR-36. Open Questions and Goals use identifiers defined only later - Severity: Nit
* **Reviewer Lens:** `egm-structural`
* **Affected Scope:** `Open Questions` lines 183-204 ("extraction consumer" 194, defined 344 and 4.4; "per-field rule" 198, defined 4.5; `verification_source = document_review` and "manual-review confirmation endpoint" 200-204, defined 430); `Goals` (`calculate_payment` 102, defined 556; `tool.call`/`credit_engine` 109-110, defined 488; the G6 field list 129-132, defined 483-484; "no-key fixture" and "keyed path" 136-138, defined 770 and CUJ 7)
* **Rationale & Recommendation**: Move Open Questions after Alternatives Considered (next to Future Improvements), where every term is defined; in Goals, add "(Technical Plan section N)" after the first use of each identifier, as G5 already does, or keep identifiers out of the goals.

### CR-37. Cross-reference style varies, the design defers specification to the out-of-scope plan, and the rollout phases have no pointer from section 10 - Severity: Nit
* **Reviewer Lens:** `egm-structural`, `egm-style`
* **Affected Scope:** line 7 ("item 86 of the implementation plan"); "Technical Plan section 3" (96, 127, 1201, 1203) vs bare "section 10/3/2" (416, 506, 828, 859) vs "(4.4)" (615); `4.4` step 2 lines 628-629 ("The adapters are specified in plan items 40 and 41") and step 5 line 644 ("The matcher is specified in plan item 43"); `4.5` line 654 (`review/tasks.ts`); rollout phases only at NFR lines 1208-1210 while `10.` lines 809-846 carries the flags and rollback
* **Rationale & Recommendation**: The design does describe the adapter output (626-628) and the matcher's two tiers (639-644, 751-755), so "specified in" understates it and makes the submission condensation depend on the plan. Write "detailed in plan items 40 and 41" / "plan item 43"; replace `review/tasks.ts` with "the review module (section 2)". Use one cross-reference form ("Technical Plan section N" outside the plan, "section N" inside). Add "phases in Non-Functional Requirements, Rollout" to the section 10 Assistant API bullet, or move the phase list into section 10.

### CR-38. Additional Resources and Future Improvements are nested under Non-Functional Requirements - Severity: Nit
* **Reviewer Lens:** `egm-structural`
* **Affected Scope:** `## Non-Functional Requirements` line 1195; `### Additional Resources` line 1219; `### Future Improvements` line 1228
* **Discrepancy Description**: Both are H3, so in the outline they are subsections of NFR. The horizontal rules at 1217 and 1245 show they were intended as top-level sections.
* **Rationale & Recommendation**: Promote both to H2. Downgraded from the structural reviewer's Major because content is unaffected and the fix is two characters.

### CR-39. Small list and field mismatches - Severity: Nit
* **Reviewer Lens:** `egm-structural`
* **Affected Scope:** `Goals` G6 lines 131-132 vs `2.` versions row line 404; `10.` Rollback lines 843-844 vs ProposedValue line 440; `2.` api row line 400 vs `4.2` line 594
* **Discrepancy Description**: The G6 versions list omits the extraction prompt that the `versions` row includes. Rollback enumerates proposals "by `prompt_version`" but ProposedValue carries a `versions` block and no `prompt_version` field. The `api` row lists "form, review, audit, health, reset" endpoints but 4.2 adds a homeowner-view endpoint.
* **Rationale & Recommendation**: Align the three lists with their sources of truth (404, 436-440, and the endpoints named in 4.x).

### CR-40. Terminology drift across six concepts - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** whole in-scope document
* **Discrepancy Description**:
  - UI surfaces: contractor "tab" (210, 220, 243, 280, 667), "route" (423), "screen" (576), "views" (1132); reviewer "tab" (259, 650), "route" (425), "view" (337, 756, 866), "task view" (425, 466), "panel" (857, 1116, 1118), "path" (306); audit "tab" (292), "route" (426), "view" (338, 1157), "page" (109, 179, 220, 237, 677), "collapsible JSON page" (1133).
  - "verdict word" (30-31, 254, 287) vs "verdict terms" (53, 105, 572, 1021) vs "verdict and approval terms" (727); "borrower" outside the compound "borrower-facing" (24, 83, 742), "applicant" (31), "borrower-adjacent" (1088) against the brief's rule of "homeowner" everywhere except when quoting a regulation.
  - Audit store: "audit event stream" (54, 345), "event stream" (128), `audit-log` (400-403), "audit log" (649, 702), "audit JSONL" (391, 402, 1199), "audit table" (846), "audit records" (833), "audit metadata"/"audit payloads" (348-349).
  - "Needs clarification": `deriveApplicationStatus` (415, 458) returns something the text insists is not a status; `derived_banner` (500); "banner" (141, 667, 671, 1091); 1107 "every application enters 'needs clarification'"; 458 is telegraphic ("The application's 'needs clarification' is `deriveApplicationStatus(app)`: any open record. It is never stored.").
  - "not located": "could not be located" (136), "was not located" (264), "not-located" (425, 671, 989), `not_located` (438), "not located" (646, 753, 756), `source_not_located` (776), "source-not-located rate" (1235).
  - "pure component of those props" (602) vs "pure function of its props" (424, 1134).
* **Rationale & Recommendation**: Use "tab" for the top-bar control, "view" for what it shows, "route" only in the Web components table; "verdict words" throughout; "homeowner" at 83 and 742, "the homeowner" at 31; "audit event stream" for the concept, "audit log" only for the module, "audit JSONL" only for the prototype file; rename to `deriveBanner` or rewrite 458 as "The 'needs clarification' banner is computed by `deriveApplicationStatus(app)` as 'any open record' and is never stored"; "not located" in prose, hyphenate only as a compound modifier; "pure function" at 602.

### CR-41. Hidden actors - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** line 7 ("will be condensed"); lines 166-167 ("is computed once and committed"); line 292 ("A reader opens the audit tab" under a CUJ titled "Compliance reconstructs"); lines 555, 684, 691-692 ("is rejected" by the API); lines 612-613 ("once extraction has been started" by `submitApplication`); line 636 ("one retry" by the consumer); line 870 ("Each was weighed")
* **Rationale & Recommendation**: Name the actor in each (the author, a script the author runs, a Compliance user, the API, `submitApplication`, the consumer).

### CR-42. Figurative or unsupported wording - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** line 57 ("Two constraints shape everything"); 317 and 962-963 ("the faster model takes it"); 686 ("a different model family member than the generator reduces correlated blind spots", unsupported since both are Claude models); 754-755 ("neither deserves a box drawn by edit distance"); 901 ("the hardest step (Plaid) is fake anyway; the easiest way to boil the ocean"); 926 ("a hallucination risk with a dollar sign on it"); 959 ("Strongest explanation quality", unmeasured); 970 ("the larger model does that more reliably", stated as fact while 972-973 says the rate is unmeasured); 1012 ("makes the demo flaky"); 1071 ("A grey block of legalese a layperson skips")
* **Rationale & Recommendation**: Plain statements: "the faster model is used for the copilot"; "a financial figure computed by a language model cannot be verified"; "the larger model is expected to select spans more reliably; unmeasured until the extraction eval runs"; "a paragraph is skipped by readers". Qualify or drop the decorrelation claim at 686.

### CR-43. Smaller repeated statements - Severity: Nit
* **Reviewer Lens:** `egm-style`, `egm-structural`
* **Affected Scope:** two write paths with the same parenthetical (94-96, 125-127, 430, 827-830); credit-engine count reads zero (110, 238-239, 298, 426, 678) and `decide()` nobody calls (108-110, 614-615, 1099); "does not compile" (61, 115, 938); retrieval as v2 (173-174, 712-715, 953-955, 1236-1237); Plaid precedence (196-199, 839-841, 1242); prefix composition (406, 549-553, 694-696); submit starts extraction so comparisons see confirmed values (459-460, 615-616); tolerance version lives in schemas (132, 404, 449-450); "Show payment options" holds the promise during an outage (103-104, 794-796); copilot latency-bound, faster model (317, 962-963); OCR misread wrong-but-located and reviewer correction rate as the signal (323-327, 757-759, 981-983); model coordinates unverifiable (761, 995-996); citations fallback (763-764, 1005-1006); model selects a span (120-122, 747-748); tablet rotates (603-604, 1063-1066); Non-Goals 173-181 duplicate Alternatives I, AI, AK, AA, AD and Future Improvements 1230-1237; the two flags at 781-783, 813-815 and 1207-1212
* **Rationale & Recommendation**: Keep one statement per fact in the section that owns it and cross-reference. Lower priority than CR-22, which covers the three largest duplications.

### CR-44. Missing units and reviewer-finding jargon - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** lines 15-16 ("industry benchmark under 10"); lines 575 and 686 ("about 1K in, 50 out"); line 136 ("without a dead end")
* **Rationale & Recommendation**: Add "minutes" and "tokens"; replace "without a dead end" with "with confirm, correct and flag still available".

### CR-45. Pronoun chains and tense shifts - Severity: Nit
* **Reviewer Lens:** `egm-style`
* **Affected Scope:** lines 429-430 ("The assistant never adds a column here. In production it writes to it through exactly the two paths": two "it"s); lines 806-807 ("the queue-time metrics are where that is measured": "that" is reviewer minutes?); lines 283-285 ("or, had the contractor instead corrected ..., the record is re-compared": tense shift)
* **Rationale & Recommendation**: Name the nouns; "if the contractor instead corrects ... the record is re-compared".

### CR-46. Line length and horizontal-rule formatting - Severity: Nit
* **Reviewer Lens:** `egm-style`, `egm-structural`
* **Affected Scope:** single sentences spanning 5-7 lines at 36-42 and 92-96; overlong hard-wrapped lines at 103, 119, 325, 667 in otherwise 100-column paragraphs; horizontal rules before NFR (1193), Additional Resources (1217) and the plan (1245) but between no other H2s
* **Rationale & Recommendation**: Split the long sentences, re-wrap the four lines, and use rules consistently (or only after the metadata block).

---

## Structural coverage note (from `egm-structural`)

Heading hierarchy has no level skips. Standard coverage: Problem Statement present (67-96); Goals and Non-Goals present (98-181); Proposed Architecture present with component layout, data flows and ecosystem integration (312-866); Alternatives Considered present with Pros, Cons and Reason for Rejection on every one of 37 entries (868-1191); Risks and Mitigations has no section (CR-9). All relative links resolve (`loan-assistant-concept.md`, `loan-assistant-concept-goldfish-findings.md`, `../PRD.md`). In-scope references into the plan (item 86 at line 7; items 40, 41, 43 at 629 and 644) resolve. All internal "section N" references point at an existing Technical Plan subsection. Tables in sections 2, 5, 8, 9 and 11 have consistent column counts; both Mermaid blocks are well formed.

---

## Resolution (Elephant, applied without a gate at the author's instruction)

All 22 Major findings and all 24 Nits were classified PROPOSE FIX and applied to the design; none was contested, escalated or declined. The larger changes:

* CR-1, CR-2: the guardrail contract takes an `allowed` set (the turn's calculator values and echoed inputs plus the contractor's own figures), the calculator resolves amount and term from confirmed form fields first and labels argument-sourced results, G4 is reworded to "never computes a payment figure".
* CR-3: the two existing write paths are named with their targets (the form submit request; the manual-review confirmation into `verified_annual_income`); typed values are client state passed to commands; `updateStatedValue` is the one post-submit write; a reviewer's confirmation never touches a `stated_*` field.
* CR-4: review-task creation and the compare are gated on status `submitted` or later in both environments; absent or unconfirmed stated values defer the compare.
* CR-5: derived values are owned by the review path (`recomputeDerived`), auto-confirmed with actor `system`, Flag-only, and the compare runs on the derived value; CUJ 5's trigger says so.
* CR-6: `message.received` and `model.call.raw_input` make the audit stream self-contained; PII classes live in the zod schema.
* CR-7, CR-8, CR-9: new Technical Plan sections 12 (Evaluation, with datasets, thresholds, gates and the feedback loop) and 13 (Rollout, monitoring and impact, with the MVP, a phase table, change management, a metrics table, drift signals and the impact measures), and a new Risks and Mitigations section.
* CR-10: the not-located value is engineered as OCR words with no geometry, deterministic on both paths; null fields become `not_extracted` rows.
* CR-11 to CR-17: one statement per fact for the chat footer, the three checks, the latency origins, the event mapping (`review.task_created`, `startDocumentReview`, one emitter for `document.attached`), extraction failure semantics, stored-status wording, and "credit decision engine" in prose.
* CR-18 to CR-22: the "Owner decisions" heading folded into a preamble; "author" for "owner"; rubric-based justifications replaced by product reasons; build-session voice removed; the Alternatives label is "Decision"; duplicated specifications replaced by pointers; Open Questions moved after Alternatives with one new item (the post-submit edit endpoint).
* Nits: applied as recommended, including the two-call cost arithmetic, the smoke-call verification note for the four API claims, the third-person voice rule for the explanation, promoted H2 headings, and consistent terms.

**Status: resolved.** No findings remain open from this stage.
