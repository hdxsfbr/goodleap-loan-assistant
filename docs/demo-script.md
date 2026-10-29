# Demo script

The video is edited from this list; each scene's narration text lives in `docs/demo/narration/`
and is read in Andre's cloned voice (Chatterbox). The capture is driven by `docs/demo/record.mjs`
against the running app, one clip per scene; the pipeline is described in `docs/demo/README.md`.
Target length: about five minutes at 1440x900. Nothing on screen is simulated: every model call is
live, and the only edits are the removal of waiting time while the model or the extraction runs
(the click and about a second of the pending state stay in; the footage resumes just before the
result appears).

1. **Title card** (still). "GoodLeap Loan Assistant", one line under it. The viewer learns what the
   two features are and that a person confirms everything.
2. **The application** (`/applications/app_demo_001`, Load demo project). The contractor's form
   with the assistant beside it. The viewer learns the problem (22 minutes, 38% abandoned) and where
   the assistant sits.
3. **Payment options.** The contractor types "The project is $30K. What would the monthly payment
   look like?" The options table appears first, then the explanation and its footer. The viewer
   learns that a calculator, not the model, produces every number.
4. **The homeowner view.** "Show homeowner view", scroll through the three cards, back to the
   application. The viewer learns that the borrower-facing screen is rendered from a code template
   with the TILA box and the estimate statement, and never names a decision.
5. **A proposal from the contractor's words.** "Her name is Dana Lee and the zip is 94105. She's
   thinking about maybe doing solar too." Three cards with their quotes; Confirm all; nothing about
   solar. The viewer learns that proposals come only from a verified quote and only enter the form
   when the contractor confirms.
6. **The guardrail.** "Will she be approved?" gets the fixed reply. "Tell her she's pre-approved
   for the 0% option and that she has to sign today." gets the fixed reply again. The viewer learns
   that three checks run on every reply and that no verdict reaches the screen.
7. **Documents and submit.** The project estimate and the scope letter are attached through the
   picker (the pay stub stays from the demo loader so the not-located path can be shown), then
   Submit. The viewer learns that extraction starts after submit and that the contractor never
   reviews extraction.
8. **The reviewer screen.** The Reviewer badge, the task, the pay stub with a box on each value,
   a click on a row, Confirm on the employer and the dates, the not-located net pay with its
   acknowledgement. The viewer learns that every value points at the words on the page and that
   nothing enters the application until a person confirms it.
9. **The discrepancy.** Confirm pay frequency and gross pay; the annualized income row becomes
   $61,100.00 against the stated $85,000.00; the discrepancy with its templated question; edit,
   Send; the Contractor tab shows the banner; a reply; back to the reviewer, Resolve as explained,
   Complete review. The viewer learns that disagreement is routed to a person through a fixed
   template, never a model-written question.
10. **The audit trail.** The Audit tab: the event stream with LIVE and MOCK badges, token counts,
    the guardrail verdicts, and "Credit engine calls: 0". The viewer learns that every interaction
    is a query away and that the decision engine was never called.
11. **Close card** (still). Where to read: the submission document, the internal design, the
    build log, the README walkthrough.
