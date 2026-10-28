# Consolidated Review Report: loan-assistant-design.md

* **Target:** `docs/designs/loan-assistant-design.md`
* **Mode:** uninterrupted full flow (stages 5 to 9), one round per stage, remediation applied by the author between stages without checkpoint gates (at the author's instruction)
* **Date:** 2026-10-28

## Stage reports

| Stage | Reviewers | Report | Blocker | Major | Nit | Resolution |
| --- | --- | --- | --- | --- | --- | --- |
| 5 Initial zoom out | `egm-zoom-out` | [zoom_out_report.md](zoom_out_report.md) | 0 | 7 | 13 | 20 fixed; 1 contested (Plaid stub kept on PRD P-5); 1 declined (re-weighing one model id, an author decision deferred to the extraction eval) |
| 6 Comprehension | `egm-comprehension` | [comprehension_report.md](comprehension_report.md) | 0 | 9 | 17 | 26 fixed |
| 7 Critic | `egm-design`, `egm-structural`, `egm-style` | [critic_report.md](critic_report.md) | 0 | 22 | 24 | 46 fixed |
| 8 Intermediate zoom out | `egm-zoom-out` | [intermediate_zoom_out_report.md](intermediate_zoom_out_report.md) | 0 | 4 | 4 | 8 fixed (two were over-built mitigations from stage 7, removed; one was a stage 5 regression, removed) |
| 9 Implementation readiness | `egm-implementation-readiness`, `egm-codebase-details`, `egm-style` | [implementation_readiness_report.md](implementation_readiness_report.md) | 4 | 39 | 41 | 84 fixed (the implementation plan rewritten in full) |
| **Total** | | | **4** | **81** | **99** | **184 findings; 182 fixed, 1 contested, 1 declined** |

All reviewers completed; none was retried or marked not run.

## What changed in the design as a result

1.  **Scope and staging.** A tier table (Floor, F1, F2) and a seven-step build order with a step
    0 for one-time tooling; the fallback tier was added in stage 7 and removed in stage 9 because
    it had no implementable items.
2.  **Compliance mechanisms made real.** The audit stream holds every contractor message and
    every model call's raw input and output; the application record has two named write paths
    and a typed-value command; the number-match check has a defined allowed set; the judge has
    one set of criteria and a distinguishable "unavailable" outcome; the deny-list is a closed
    list with a closed allow-list.
3.  **Over-building removed.** Two commands added by the critic stage (`updateStatedValue`,
    `startDocumentReview`) were removed by the intermediate zoom-out as third write paths and
    unobservable states; the Risks table lost two mitigations the design did not contain.
4.  **Extraction made deterministic.** Positioned text only; a two-tier matcher with no
    heuristics; a not-located value engineered as OCR words without geometry, which the plan's
    types now allow; derived values owned by the review path and decided by input state.
5.  **Evaluation, rollout and monitoring** gained sections 12 and 13 with thresholds, phases,
    gates, metrics and alerts, and the implementation plan gained the golden figures, the fixed
    texts, the catalog parameters and the route and stream schemas an implementer needs.

## Open items carried forward

* The two consecutive clean rounds the review loop requires for convergence were not run; each
  stage ran once and its findings were fixed. A fresh pass would find new nits.
* The five Open Questions in the design (confidentiality, disclosure wording, tolerance
  defaults, today's review workflow, Plaid precedence, the provenance column) need Compliance,
  Credit Ops or the recruiter.
* Five API behaviors the design relies on are to be verified by `scripts/smoke-api.ts` at the
  start of build step 3, with the decision per outcome recorded in the plan.
