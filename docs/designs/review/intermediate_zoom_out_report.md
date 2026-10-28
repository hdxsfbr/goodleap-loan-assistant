# Stage 8: Intermediate Zoom Out Review

* **Target:** `docs/designs/loan-assistant-design.md` (full file, 2323 lines at review time)
* **Reviewer:** `egm-zoom-out`, fresh context, against `zoom-out-standard.md`, with the Stage 5 report as prior context
* **Status:** completed. Context sufficiency, root problem focus and project alignment pass. Sections 12 and 13, the `allowed` set, `message.received`, `raw_input`, `review.task_created` and `not_extracted` were judged the minimal mechanism for their gaps. One Stage 5 fix (ZO-2) had regressed in a single clause.

## Findings

| Id | Severity | Finding |
| --- | --- | --- |
| IZ-1 | Major | `updateStatedValue` was a third write path to the application record (command, route, banner control, two tests, an open question), built for the secondary branch of an F2 journey and leaking into floor-tier items; it weakened G5's two-write-path claim. |
| IZ-2 | Major | The Risks table named two mitigations the design does not contain ("queue ordered by mismatches first"; "confirm in one gesture per document", a reviewer-side confirm-all the brief rejected). |
| IZ-3 | Major | ZO-2 regression: the Risks table reintroduced the row-label anchor heuristic that Stage 5 removed from the matcher. |
| IZ-4 | Major | `startDocumentReview` added a command, an unobservable `submitted` state and an extra event, and left the kill-switch path (`EXTRACTION_ENABLED=false`) with no owner for review-task creation. |
| IZ-N1 | Nit | Derived-value computation was listed under two components, its file sat under `extraction/`, it recomputed up to three times per review, and `input_pending` was not in the reason-code enum. |
| IZ-N2 | Nit | Section 12 overlapped with itself (field fill inside copilot behavior; judge and pre-launch guardrail as one growing set) and plan item 83 had drifted from it (8 versus 9 of 10). |
| IZ-N3 | Nit | Plan item 8 still described the split-token mechanism the later edit replaced. |
| IZ-N4 | Nit | The `verified` block was write-only in the prototype and the text did not say which `confirmValue` performs the write. |

## Resolution (Elephant, applied without a gate at the author's instruction)

All eight PROPOSE FIX, applied:

* IZ-1: `updateStatedValue`, its route, the banner control, its tests and the open question are removed. `corrected` now means the contractor's reply supplied a corrected figure, recorded in the note; the stated value changes through the portal's existing process outside this system. G5's two write paths stand without a footnote.
* IZ-2, IZ-3: the three clauses deleted; the stall row now names the SLA alert, the manual fallback and the scaling asymmetry.
* IZ-4: `startDocumentReview` and the `submitted` status are removed; `submitApplication` sets `documents_under_review` directly; the submit route creates the review task with every slot flagged when extraction is disabled.
* IZ-N1: `derived.ts` moves to `server/review/`; the extraction row no longer lists derived fields and now depends on `review`; computation happens once when every input is final and again only on a later `editValue`; `input_pending` is gone.
* IZ-N2: field fill merged into copilot behavior; judge and pre-launch guardrail merged into one growing set; item 83 is "the section 12 table, verbatim".
* IZ-N3: item 8 describes the no-geometry mechanism.
* IZ-N4: the system `confirmValue` on the derived income is named as the one write to `verified`.

**Status: resolved.** No findings remain open from this stage.
