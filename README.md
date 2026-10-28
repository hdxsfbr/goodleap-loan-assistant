# GoodLeap Loan Assistant

An AI-powered assistant for home improvement loan applications. It helps contractor partners
explain loan products and promotional terms, give homeowners a payment estimate on the spot, and get
applications through faster, without making or implying a credit decision and with TILA/RESPA
disclosures in every borrower-facing message.

This is a take-home project for GoodLeap through Gauntlet AI's partner program (brief version 1,
updated 2026-10-20).

## Status

Concept phase. The brief and its attachment are consolidated into [the PRD](docs/PRD.md). Its open
questions were resolved in a brainstorm and review round on 2026-10-28; the outcome is the
[concept brief](docs/designs/loan-assistant-concept.md), published for feedback before the formal
design document is drafted. There is no runnable code yet. Setup and run instructions will be added
here with the prototype.

## The problem

- Loan applications take 22 minutes on average, against an industry benchmark of under 10.
- 38% of applications are abandoned, mostly at income verification and loan product selection.
- Contractors on-site need to quote a monthly payment in about 30 seconds and can't explain
  products or promotional terms (0% intro periods, deferred interest) clearly.
- Staff review uploaded pay stubs, estimates and scope letters by hand, which delays decisions.

The business case: 10% more contractor deal closures is worth about $200M a year in origination.

## Planned deliverables

| Deliverable | Notes |
| --- | --- |
| Solution design document | 2–3 pages in `docs/`: problem framing, architecture, AI design decisions, compliance and safety, rollout, monitoring and impact |
| Working prototype | TypeScript / Node.js, a real LLM API, mocked financial services, at least one compliance guardrail, runnable locally in under 5 minutes |
| Technical documentation and deployment guide | Required by the portal brief |
| AI usage documentation | Required by the portal brief |

## Hard constraints

- No AI output may make or imply a credit decision.
- Every borrower-facing communication carries the required TILA/RESPA disclosures.
- Financial service APIs (loan catalog, credit decision engine, Plaid income verification,
  contractor profiles, document management) are mocked. No real financial API keys.
- AI interactions use a real LLM API.

## Repository layout

```
docs/
  PRD.md                      Consolidated requirements, metrics, rubric, open questions and their resolutions
  designs/
    loan-assistant-concept.md                     Concept brief (RFC): the two features, decisions, scope, alternatives
    loan-assistant-concept-goldfish-findings.md   Review findings the brief responds to
    loan-assistant-design.md                      Internal design: architecture, data flows, alternatives, file-by-file implementation plan
    review/                                       Goldfish review reports on the design (stages 5 to 9)
  design-document.md          The 2 to 3 page submission document, condensed from the internal design
  source/
    portal-brief.md           Project brief from the Gauntlet portal
```

The brief's attached take-home PDF is marked Confidential, so neither the PDF nor its text is
committed. Its requirements are captured in the PRD.
