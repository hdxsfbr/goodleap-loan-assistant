# How AI was used to build this project

This page records how AI tools were used, what the author decided, what the models got wrong, and which
real model calls the build made. It is written from the repository: the commit history, the review
reports in [`designs/review/`](designs/review/) and [`build-log.md`](build-log.md). Where a number is an
estimate, it says so.

## The short version

* The author, Andre Batista, chose the problem, the scope, the two features, the rules the system keeps and
  the model for each job. AI tools drafted and reviewed.
* The design came first. It was written, then reviewed in stages by reviewer agents that each started with
  no memory of the conversation, and the findings were fixed before any code was written.
* The code was written in waves by Sonnet 5.5 agents, each working from the design's numbered
  file-by-file plan. After each wave the coordinator built it and ran the tests, one independent model
  reviewed it, the findings were filtered and the kept ones fixed, and the wave was committed.
* The product calls real models (Sonnet 5.5, Opus 5.5 and Haiku 5.5, through OpenRouter in the build). Every
  payment figure and every disclosure a homeowner sees comes from code, not from a model.

## Tools and roles

| Role | Tool | Used for |
| --- | --- | --- |
| Author and decision maker | Andre Batista | Scope, features, rules, model choices, every decision below |
| Coordinator | Claude Code (the commit trailers name Claude Opus 5.5 on the first commit and Claude Fable 5.1 on the later ones) | Drafting the PRD, the concept brief and the design; briefing the implementation agents; building, testing and committing each wave; filtering review findings |
| Design reviewers | Claude Code reviewer agents (`egm-zoom-out`, `egm-comprehension`, `egm-design`, `egm-structural`, `egm-style`, `egm-implementation-readiness`, `egm-codebase-details`), each in a fresh context | Reviewing the concept brief and the design (reports in `docs/designs/review/`) |
| Implementation agents | Claude Sonnet 5.5, one agent per file scope, run in parallel where the files do not overlap | Writing code, tests, samples and documentation from the design's plan |
| Independent code reviewer | codex with gpt-6.1 (a model from a different vendor), one review per wave | Reviewing the uncommitted code of each wave |
| Product models | Claude Sonnet 5.5 (copilot), Opus 5.5 (extraction), Haiku 5.5 (judge) | The running application |

The skills involved were a brainstorm and review workflow (the Goldfish review, run through the reviewer
agents above) for the design, and a wave-loop procedure for the build: a design gate, parallel agents with
disjoint file scopes, a build and a test run, one independent review, a filtered fix pass, a commit, stop.

## How the design was made

1. **PRD.** The brief and its attachment were consolidated into [`PRD.md`](PRD.md), with sixteen open
   questions.
2. **Concept brief and a brainstorm review.** A concept brief
   ([`designs/loan-assistant-concept.md`](designs/loan-assistant-concept.md)) was reviewed through six
   lenses (architecture and cost, observability, scope and reuse, UX, migration and rollout,
   maintainability): 34 consolidated findings, 8 of them blockers
   ([`designs/loan-assistant-concept-goldfish-findings.md`](designs/loan-assistant-concept-goldfish-findings.md)).
   The brief was revised and the author decided the points where the reviewers disagreed.
3. **Internal design and a five-stage review.** [`designs/loan-assistant-design.md`](designs/loan-assistant-design.md)
   was reviewed in five stages, each by reviewer agents with a fresh context and the documents they were
   handed, and nothing else. The fixes were applied between stages at the author's instruction.

| Stage | Reviewers | Blocker | Major | Nit | Outcome |
| --- | --- | --- | --- | --- | --- |
| 5 Initial zoom out | `egm-zoom-out` | 0 | 7 | 13 | 20 fixed; 1 contested (the Plaid stub stays); 1 declined (re-weighing one model id, deferred to the extraction eval) |
| 6 Comprehension | `egm-comprehension` | 0 | 9 | 17 | 26 fixed |
| 7 Critic | `egm-design`, `egm-structural`, `egm-style` | 0 | 22 | 24 | 46 fixed |
| 8 Intermediate zoom out | `egm-zoom-out` | 0 | 4 | 4 | 8 fixed, including removing two mitigations stage 7 had over-built |
| 9 Implementation readiness | `egm-implementation-readiness`, `egm-codebase-details`, `egm-style` | 4 | 39 | 41 | 84 fixed; the implementation plan was rewritten in full |
| Total | | 4 | 81 | 99 | 184 findings: 182 fixed, 1 contested, 1 declined |

The review loop asks for two clean rounds in a row. They were not run: each stage ran once, and its
findings were fixed. The consolidated report says so
([`designs/review/consolidated_review_report.md`](designs/review/consolidated_review_report.md)), and a fresh
pass would find new minor points.

## How the code was built

The design's implementation plan has 86 numbered items (files and groups of files) in tiers: a floor that
is never cut, then an eval tier, then the document-extraction feature, which was allowed to ship as
design-only if unfinished. The waves ran in the plan's order. [`build-log.md`](build-log.md) records each
wave, every review finding and what was done with it.

| Wave | What | Tests after | Review |
| --- | --- | --- | --- |
| 1 | Sample documents; skeleton, shared schemas, store, commands, audit log, routes, mocks | 139 | 18 findings, 15 fixed, 3 dropped with reasons |
| 2 | Calculator, catalog, disclosure template, surfaces | 157 | 8 findings, 6 fixed, 2 dropped as contradicting recorded decisions |
| 3 | Copilot server and web client (two agents in parallel), the audit page | 359 | 6 findings on the server and 12 on the web client; 17 kept |
| 5 | Extraction server and the reviewer screen (two agents in parallel) | 360 after the extraction server | 8 findings on the extraction server, all kept; the reviewer screen was driven in a real browser |

The build log reports 516 tests after the wave 3 and wave 5 fix passes.
| 4 | This documentation | | |

Waves are numbered by the design's build order. Waves 3 and 5 overlapped in time because their files are
disjoint.

In each wave the coordinator, not the agent, ran the build and the full test suite, because an agent's
report is not evidence. Wave 3 was also driven in a real browser, which found a blank page on "Back to
application" that neither the tests nor the review had found, and the wave 5 reviewer screen was driven
end to end in a real browser.

The independent review ran as `codex exec review -` over a text bundle produced by
[`scripts/review-bundle.sh`](../scripts/review-bundle.sh): codex's own sandbox could not start on the
build machine, so the reviewer reads the code as text and runs nothing. The findings were filtered in the
open: the build log lists them and what was kept or dropped, with the reason for each drop.

## What the author decided

These are the author's calls. The models proposed options; the choices below were not theirs.

**Problem and scope**

* One assistant at the two named failure points (product selection and income verification), on a shared
  base, instead of one angle only, extraction only, a full conversational application, or a hybrid
  (design alternatives A to D).
* Build the copilot and the shared floor first, then document extraction at reduced depth; whatever is
  unfinished ships as design-only and the README says so.
* Two documents: the internal design at full depth, and a 2 to 3 page submission document condensed from it.
* The design is the primary deliverable; the prototype demonstrates it and is simpler where the design says so.

**Rules the system keeps**

* No output makes or implies a credit decision. The walkthrough ends at "submitted, documents under
  review" and no UI code calls the credit decision engine.
* Review with humans: nothing a model wrote enters the application until a person confirms it. Every
  suggested value is a proposal with a source pointer; named commands are the only write path; submit is
  blocked while a proposal is pending; a reviewer confirms, corrects or flags every document value.
* The model never computes a payment or writes a disclosure. A calculator and a Compliance-owned template
  do, and a check rejects prose that contains a figure the calculator did not produce.
* Discrepancy questions to the contractor are templates per reason code, never model text, and they go to
  the contractor, not to the homeowner.
* Every borrower-facing screen carries the disclosures, and the borrower-facing surface is declared in
  code.

**Models and method**

* Sonnet 5.5 for the copilot (latency-bound), Opus 5.5 for extraction (background work where picking the
  right span matters; the author's call over Sonnet 5.5 for both), Haiku 5.5 as the judge. Exact ids, never
  aliases, stamped on every audit event.
* The model selects an indexed span of the document's own words and the code draws the box. The author
  required boxes, so Anthropic document citations were not used.
* Positioned text only as the extraction input, with no page image (the author's call for one code path and
  deterministic input); the reviewer is the control for OCR misreads.
* The pay stub is an image, read once by OCR and committed with one word deliberately left without a
  position, so the walkthrough always shows a value that cannot be located.
* Prompting and tools, not fine-tuning; no retrieval in version one.

**Product choices in the design's alternatives**

The design records 37 alternatives, each ending in a decision. Besides those above: a deny-list of verdict
words only, with an allow-list; refusals fail closed to a fixed fallback text; "needs clarification" is
derived and never a stored status; the homeowner view is a full-screen page with a four-cell TILA box per
option; review stays with internal staff; the prototype's tolerance rules are two (income plus or minus
10% or $5,000, and a request more than 5% above the estimate); one declarative schema per document type;
one review task per application; an audit page of collapsible JSON now and a timeline described for later;
a web app rather than a CLI; Vite and Express rather than Next.js; in-process mocks rather than mock
servers; streamed newline-delimited JSON for a turn; one SDK import site; hand-rolled tests rather than an
eval framework; a local run only.

**Decisions made during the build** (the build log keeps the dated table)

* The GitLab remote is the repository host.
* Model calls go through OpenRouter in the build, because there was no Anthropic key on the build machine;
  strict tools, effort, JSON output and prompt caching were checked with curl first. The client accepts
  either spelling of the base URL.
* Implementation agents run on Sonnet 5.5; the coordinator does the builds, the reviews and the commits.
* The audit file is emptied at server start, because the store is in memory and is seeded again.
* Values in `.env` override variables the shell already exports, so a stale variable cannot send the key to
  the wrong endpoint.
* Findings from the independent review are filtered before they are fixed; a finding that contradicts a
  recorded decision is dropped, with the reason written down.

## What the models got wrong, and what caught it

Five examples from the independent review, with the wave that found each. The review filter kept all five,
and each was fixed with a test (waves 1 and 2 in their commits, the others in the wave 3 and wave 5 fix
passes recorded in the build log).

1. **Money rounding (wave 2).** The monthly payment was computed on floating-point numbers and then
   rounded, so an exact half-cent tie could land on the wrong side: 350 cents at 12% over one month gave 353
   instead of 354. All five golden cases still passed. A half-up rounding mutation passed them too, and only
   the tie tests failed. The payment is now an exact BigInt fraction rounded half-even. While fixing it, the
   agent found that the largest amount at the largest rate overflowed a float.
2. **A figure read as a different figure (wave 1).** The text normalizer turned `$42.50;` into `4250`, which
   is the same token as `$4,250`. A check that compares figures would have treated the two as equal.
3. **A figure attached to the wrong option (wave 3).** The number check was a set check, so "$414.14" (Option
   B's payment) written against Option A passed because the figure was in the calculator's output. Spelled
   figures such as "350 dollars" and "ten years" produced no figure to check at all. The check now binds a
   figure to the option named in its sentence and reads spelled amounts and terms.
4. **A proposal that did not match its own quote (wave 3).** The copilot verified that the contractor's quote
   existed in their message, but never checked that the value it proposed came from that quote, so "$40K"
   could be proposed from a message that said "$30K". The contractor confirms every proposal, but the
   check was missing.
5. **A flagged value still stored as verified (wave 5).** When a reviewer flagged the calculated annual
   income after it had been confirmed, the verified income on the application stayed in place. A flagged
   value no longer stands behind the stored verified income; the system withdraws it and records why.

Other findings of the same kind: the homeowner view checked its disclosure block against the options by
product id only, where it now compares the whole rendered block; the audit log added an event to memory
before the file write, so a failed write left a phantom event; the web client formatted cents and wrote
payment wording itself, against the design's rule that the client formats nothing; a retried review task
opened a second queue issue.

Things that tests and reviews missed, and running the code found:

* A `.env` value did not override a variable the shell had already exported, so the OpenRouter address was
  ignored. The SDK adds `/v1/messages` itself, so the design's base URL would have returned 404.
* The design assumed a structured-output schema with a nullable member per field; the API allows at most 16
  union members per schema and the pay stub needed 42. The design was wrong, and was corrected.
* The design said citations cannot be combined with a JSON output format; Haiku accepts them. The other
  API claims the design relied on (forced tool choice, disabling thinking and assistant prefill are rejected
  with a 400 on Sonnet 5.5) held. The smoke script checked each claim against the real endpoint.
* "Back to application" left a blank page, because of an async effect and no error boundary. A browser walk
  found it.

The reviewers were also wrong sometimes, which is why the findings are filtered: one asked for the audit file
to be kept between runs against a recorded decision; one asked for a two-part schedule line against a
recorded interpretation of the deferred product.

## Real model calls made during the build

The calls below went to a real provider through the project's own key. Costs are estimates from the
design's unit figures (about $0.02 per copilot turn with caching, about $0.03 per document on Opus 5.5);
the provider's usage page is the record, and it was not consulted.

| What | Calls | Estimated cost |
| --- | --- | --- |
| Smoke script (`npm run smoke`), including the behavior probes, in wave 3 | About 10; several probes were rejected by the API by design | Under $0.10 |
| Live copilot turns while building and tuning the prompt (wave 3) | Five turns reported in the build log, one more in its fix pass, plus earlier prompt versions | Roughly $0.10 to $0.30 |
| A browser walk of three live turns (wave 3) | 3 turns, each a tool round, an explanation and a judge call | About $0.06 |
| Recording the extraction fixture (Opus 5.5, effort medium), then recording it again after the review fixes | 6 calls, about 9,800 tokens in and 1,100 out for each set of three | About $0.18 |
| Two live submissions to drive the reviewer screen in a browser (wave 5): each runs the extraction on three documents | 6 Opus 5.5 calls | About $0.18 |
| `tests/out-of-scope-reply.test.ts`, which makes one live turn each run while a key is in `.env` | One per full test run; the number of runs was not counted | About $0.01 to $0.02 each |
| Checking the walkthrough for the documentation (wave 4): a three-turn browser run, a four-turn browser run, one smoke run, two full test runs | About 25 calls | About $0.25 |

| The eval runner (wave 6): two full runs of the 15 copilot cases and the 20 judge cases, the second after the prompt fixes | 128 calls (52 copilot turns' worth of rounds, 76 judge calls), about 140K input tokens plus 240K cache reads | About $1.50 |
| Verify-script runs with the browser walk (wave 6): three runs of three live turns | 9 turns | About $0.20 |

The brief says a focused one-to-two-hour submission beats a sprawling one. This submission took one
working day (2026-10-28): the morning on the design and its five-stage review, the afternoon and
evening on the six build waves, with AI agents doing the typing throughout. The design is the part the
author stands behind line by line; the code was read in review and in the walkthroughs, not written by hand.

The estimate for the whole build is under $5 of API spend. It counts only the calls named here. The cost of the
Claude Code agents, the reviewer agents and codex is not counted.

## What this page does not claim

* It does not say a model's output was correct because a model said so. Every claim in the product about
  money is checked by code and tests, and the model-written parts are checked by three guardrail layers and
  a human review.
* It does not measure accuracy beyond the numbers in [`evals.md`](evals.md), which come from one recording of
  three synthetic documents.
