# PRD: AI-Powered Home Improvement Loan Application Assistant

| | |
| --- | --- |
| Partner | GoodLeap (Gauntlet AI partner project, Silver tier) |
| Brief version | 1, last updated 2026-10-20 |
| PRD status | Draft, 2026-10-28. Consolidates the sources below. The open questions in [§13](#13-open-questions-and-ambiguities) were resolved on 2026-10-28; the resolutions are recorded at the end of that section and detailed in the [concept brief](designs/loan-assistant-concept.md). |
| Sources | [Portal brief](source/portal-brief.md) (**[P]**) · Take-home challenge PDF attached to the brief, marked Confidential and not committed (**[T]**) |

Each requirement cites its source. Where the two sources disagree, both values are recorded and the
conflict is logged as an open question; neither source is assumed to take precedence.

## 1. Summary

Contractor partners lose deals because the home improvement loan application is slow and its
products are hard to explain on-site. Design and prototype an AI-powered solution that removes
friction between the contractor, the homeowner and the application, with no AI credit decisions,
TILA/RESPA disclosures on every borrower-facing message, and mocked financial service APIs. The
submission is a solution design document plus a working, locally runnable prototype that calls a
real LLM. [P][T]

## 2. Problem

| Fact | Value | Source |
| --- | --- | --- |
| Annual origination | ~$2B | [P][T] |
| Contractor partners | 15,000+ | [P][T] |
| Loan range | $5K–$100K | [P][T] |
| Terms | 5–25 years | [P][T] |
| Promotional structures | 0% intro periods, deferred interest, promotional APRs | [P][T] |
| Average application completion time | 22 minutes | [P][T] |
| Industry benchmark completion time | under 10 minutes | [P][T] |
| Application abandonment rate | 38% | [P][T] |
| Largest drop-off steps | income verification, loan product selection | [P][T] |

Root causes named by the sources:

1. **Product explanation.** Contractors struggle to explain the differences between loan products. [T]
2. **Promotional terms.** Homeowners are often confused by promotional terms. [P][T]
3. **On-site speed.** Contractors cannot give quick financing answers while at the job site. [T]
4. **Manual document review.** Staff extract key details from uploaded pay stubs, contractor
   estimates and project scope letters by hand, which delays applications. [P][T]

## 3. Users and stakeholders

| Who | Role in the problem | What they need | Source |
| --- | --- | --- | --- |
| Contractor partner | Submits applications on the homeowner's behalf through the partner portal, often on-site | Tell a homeowner their monthly payment within ~30 seconds; explain products simply | [T] |
| Homeowner (borrower) | Makes the financing decision, often mid-conversation in their own home | Clear, honest terms; the rubric asks for understanding of their emotional state during a financing decision | [T] |
| VP of Contractor Partnerships | Owns contractor deal flow | +10% contractor deal closure, worth ~$200M annual origination | [P][T] |
| Head of Compliance | Owns regulatory risk | Every borrower-facing interaction auditable: exactly what the system said and why | [T] |
| CTO | Owns a small engineering team | Something the team can operate; "not a science project" | [T] |
| Document review staff | Extract details from uploads by hand today | Less manual extraction, faster turnaround | [P][T] |
| Data team | Maintains Snowflake warehouse (loan history, contractor performance, funnel analytics) | Source for metrics and evaluation | [T] |

## 4. Goals and success metrics

| Metric | Baseline | Target | Source |
| --- | --- | --- | --- |
| Application completion time | 22 min | under 10 min | [P][T] |
| Application abandonment rate | 38% | reduce (no numeric target given) | [P][T] |
| Time for a contractor to give a payment estimate on-site | not stated | ~30 seconds | [P][T] |
| Contractor deal closure | not stated | +10% (business case: ~$200M annual origination) | [P][T] |
| Time-to-decision | not stated | track | [P][T] |
| Contractor adoption rate | not stated | track | [P][T] |
| Document review turnaround time | not stated | track | [P] |

These are the business outcomes the design document must address; the prototype demonstrates the
interaction that would move them, not the outcomes themselves.

## 5. Scope

**In scope**

- Part 1: a solution design document ([§6](#6-deliverable-1-solution-design-document)). [P][T]
- Part 2: a working prototype of the core interaction ([§7](#7-deliverable-2-working-prototype)). [P][T]
- The solution angle is open. Example angles from the sources: explaining loan products,
  estimating payments, extracting data from documents. [P] The design should pick the
  highest-leverage problem rather than "boil the ocean". [T]

**Out of scope**

- A production system. The prototype is a proof of concept. [T]
- Real financial service integrations or API keys; these are mocked. [P][T]
- Any AI credit decision, explicit or implied. [P][T]

## 6. Deliverable 1: Solution design document

Length 2–3 pages, PDF or Markdown, in `/docs`. [T] It must cover:

| ID | Section | Must address | Source |
| --- | --- | --- | --- |
| D-1 | Problem framing and approach | The problem and for whom; why this angle over alternatives; the highest-leverage problem | [P][T] |
| D-2 | Proposed architecture | How it fits the existing stack; models/APIs used; data flow; integration with existing services; specific, justified vendor/model choices | [P][T] |
| D-3 | AI design decisions | Prompt engineering vs. fine-tuning; context window management; hallucination risk in a financial context; evaluation and testing approach; edge cases and out-of-scope queries | [P][T] |
| D-4 | Compliance and safety | How the compliance constraints are met; auditability; preventing implied credit decisions; preventing non-compliant marketing language | [P][T] |
| D-5 | Rollout plan | Launch phases; what the MVP is and how long it takes to ship; contractor change management | [P][T] |
| D-6 | Monitoring and impact evaluation | Production monitoring; business impact metrics (completion rate, adoption, time-to-decision); AI quality over time (drift, hallucinations, compliance failures); v1 → v2 feedback loop | [P][T] |

## 7. Deliverable 2: Working prototype

### 7.1 Functional requirements

| ID | Requirement | Source |
| --- | --- | --- |
| P-1 | Uses at least one real LLM API (Anthropic or OpenAI are in the current stack; Google or open-source models are allowed). | [P][T] |
| P-2 | Demonstrates a realistic end-to-end interaction connected to the problem in [§2](#2-problem). | [P][T] |
| P-3 | Includes at least one guardrail that prevents non-compliant output. | [P][T] |
| P-4 | Financial service APIs are mocked; no real financial service API keys. | [P][T] |
| P-5 | Integrates, at least conceptually, with the existing APIs: loan product catalog, credit decision engine, income verification (Plaid), contractor profile service, document management. | [P][T] |
| P-6 | Every borrower-facing communication includes the required TILA/RESPA disclosures. | [P][T] |
| P-7 | The system never makes or implies a credit decision. | [P][T] |
| P-8 | Borrower-facing interactions are auditable: what the system said and why. Stated by the Head of Compliance as a design concern; whether the prototype must show it is open ([Q-8](#13-open-questions-and-ambiguities)). | [T] |

### 7.2 What reviewers evaluate in the prototype

- Quality of the conversational UX and prompt design, not just that it works. [T]
- Handling of messy LLM output in a regulated context. [T]
- Judgment about what to build vs. mock or stub. [T]
- Code quality, structure and documentation. [P][T]

## 8. Non-functional requirements

| ID | Requirement | Source |
| --- | --- | --- |
| N-1 | Runnable locally in under 5 minutes by following the README. | [P][T] |
| N-2 | README at the repo root covers install and run steps, required API keys and environment variables, and a brief architecture description. | [P][T] |
| N-3 | Well-structured, documented code with a clear architecture description. | [P] |
| N-4 | The author can explain every line, AI-assisted or not. | [P][T] |
| N-5 | Required languages: TypeScript and Node.js. The existing portal is React with a TypeScript/Node.js backend. | [P][T] |
| N-6 | Supports a payment estimate within ~30 seconds of a contractor's question. | [P][T] |
| N-7 | Operable by a small engineering team. | [T] |
| N-8 | Simplifying assumptions are called out explicitly. | [T] |

## 9. Compliance and safety constraints

| ID | Constraint | Source |
| --- | --- | --- |
| C-1 | **No credit decisions.** No AI system may make or imply a credit decision. Approval and denial belong to the existing credit decision engine. | [P][T] |
| C-2 | **TILA.** Borrower-facing communications clearly disclose loan terms, APR and total cost of credit. | [T] |
| C-3 | **RESPA.** Governs disclosure of settlement costs and prohibits kickbacks. | [T] |
| C-4 | **Required disclosures everywhere.** All borrower-facing communications include the required TILA/RESPA disclosures. | [P][T] |
| C-5 | **No non-compliant marketing language.** | [T] |
| C-6 | **Auditability.** Every borrower-facing interaction records exactly what the system said and why. | [T] |
| C-7 | **Disclosures woven in.** Disclosures appear without disrupting the experience (rubric: Design Taste). | [T] |

## 10. Technical context

### 10.1 Existing environment

| Layer | Existing system | Source |
| --- | --- | --- |
| Partner portal | React web app | [P][T] |
| Backend | TypeScript / Node.js | [P][T] |
| Cloud | AWS: ECS, RDS Postgres, S3, SQS | [P][T] |
| Data warehouse | Snowflake (historical loans, contractor performance, funnel analytics) | [P][T] |
| AI platforms | Anthropic, OpenAI | [P][T] |
| Automation and ops | Zapier, Jira Service Management | [P][T] |
| Productivity | Microsoft 365 | [P][T] |
| Source control | GitHub | [P] |

### 10.2 Existing APIs the solution integrates with (mocked in the prototype)

| API | Relevance |
| --- | --- |
| Loan product catalog | Products, APRs, terms, promotional structures |
| Credit decision engine | Owns every credit decision (C-1) |
| Income verification (Plaid) | One of the two largest drop-off steps |
| Contractor profile service | The contractor using the tool |
| Document management | Uploaded pay stubs, estimates, scope letters |

### 10.3 AI ecosystem the reviewers expect to see

Prompt engineering, RAG patterns, embeddings, evaluation frameworks and guardrails tooling, applied
with current LLM capabilities. [P][T]

## 11. Submission

| Item | Requirement | Source |
| --- | --- | --- |
| Container | A single GitHub repository (preferred; commit history is a positive signal) or a zip file | [T] |
| Layout | `/docs` holds the design document; prototype source in the repo root or `/src`; `README.md` at the root | [T] |
| Required deliverables (portal) | Source Code, Technical Documentation, Deployment Guide | [P] |
| AI usage documentation | Required | [P] |
| AI assistants | Allowed freely; the author must be able to explain every line | [P][T] |
| Submission channel | The portal's submission interface, tied to brief version 1 | [P] |
| Questions | Ask the recruiter | [P][T] |
| Time budget | 2–4 hours [P]; 1–2 hours recommended, and a focused 1–2-hour submission is preferred over a sprawling 3+-hour one [T] | [P][T] |

## 12. Evaluation rubric

Five dimensions, weighted equally. [T]

| Dimension | Question | Strong signal |
| --- | --- | --- |
| Stakeholder Empathy | Can you identify the real problem and the right user to solve for? | Addresses the contractor workflow, not just technology. Understands the homeowner's emotional state during a financing decision. |
| Technical Depth | Can you design a real system, not just describe concepts? | Specific model choices with reasoning. Addresses latency, cost and context window limits. Aware of failure modes. |
| AI Ecosystem Fluency | Do you know the tools and how they fit together? | Familiar with current LLM capabilities, embedding strategies, RAG patterns, evaluation frameworks and guardrails tooling. |
| Pragmatism | Can you ship something real with limited resources? | MVP scoped to days, not months. Clear build vs. buy. Acknowledges tradeoffs. |
| Design Taste | Does the solution feel good to use? | Natural conversational UX. Graceful error handling. Disclosures woven in without disrupting the experience. |

## 13. Open questions and ambiguities

To be resolved during requirements alignment.

**Conflicts between the sources**

- **Q-1 Time budget.** [P] says 2–4 hours; [T] recommends 1–2 hours and discourages 3+ hours.
  Which budget sets the scope?
- **Q-2 Deliverable set.** [P] lists Source Code, Technical Documentation and a Deployment Guide;
  [T] lists a 2–3 page design document and a prototype with a README. Is "Technical Documentation"
  the design document, and is anything beyond it expected?
- **Q-3 Deployment Guide.** [T] only requires a local run. Does the portal's Deployment Guide mean
  local setup instructions, a description of how it would deploy on the existing AWS stack, or a
  live hosted deployment?
- **Q-4 Repository host.** [T] asks for a GitHub repository; this repo's remote is Gauntlet's
  GitLab (`labs.gauntletai.com`) and the portal has its own submission interface. Where do
  reviewers read the code and commit history?
- **Q-5 Metric wording.** [P] compares the 38% abandonment rate with a "10-minute industry
  benchmark", which mixes a rate and a duration. [T] makes clear that 10 minutes is the
  completion-time benchmark. Treat [T]'s reading as correct?

**Gaps in the sources**

- **Q-6 Solution angle.** Which problem does the prototype target: payment estimation, product
  and promo explanation, document extraction, income verification, or a combination? Both sources
  push for one high-leverage angle.
- **Q-7 Primary user and surface.** Contractor-facing assistant inside the partner portal,
  homeowner-facing experience, or both? This decides which outputs count as "borrower-facing" for
  the disclosure requirement (C-4), including contractor-facing text the homeowner will see.
- **Q-8 Auditability in the prototype.** Must the prototype demonstrate an audit trail (C-6), or
  is it enough for the design document to cover it?
- **Q-9 Loan product data.** No product catalog, APR ranges, fee schedules or promotional
  mechanics (e.g. how deferred interest works) are given. Mock data has to be invented; what level
  of realism is expected?
- **Q-10 Disclosure fidelity.** No disclosure text is provided. Which TILA elements must appear
  (APR, finance charge, amount financed, total of payments, payment schedule) and in what form?
  RESPA is mostly about mortgage settlement costs; how does it apply to these unsecured or
  secured home improvement loans?
- **Q-11 AI usage documentation.** Format and location are not specified.
- **Q-12 LLM key for reviewers.** A real LLM API is required. How do reviewers supply a key, and
  is a specific provider expected?
- **Q-13 Other stack pieces.** Snowflake, Zapier, JSM and Microsoft 365 are listed. Are they
  design-document material only, or expected in the prototype?
- **Q-14 Frontend.** TypeScript and Node.js are required; is a React UI expected, or is another
  interface (CLI, chat, portal widget mock) acceptable?
- **Q-15 Abandonment target.** No numeric reduction target is given. Should the design commit to
  one?
- **Q-16 Confidentiality.** The take-home PDF is marked Confidential. What visibility is allowed
  for the submission repository?

### Resolutions (2026-10-28)

Resolved in the brainstorm and Goldfish review round. Details and rationale are in the
[concept brief](designs/loan-assistant-concept.md); the review findings are in
[loan-assistant-concept-goldfish-findings.md](designs/loan-assistant-concept-goldfish-findings.md).

| Question | Resolution |
| --- | --- |
| Q-1 Time budget | The deadline is the morning of 2026-10-29. The design document is the primary deliverable; the prototype is a working product demo of one path through each feature, simplified where the design says so. Feature 1 and the shared base are built first; feature 2 is built at reduced depth after it, and whatever is unfinished ships as design-only. |
| Q-2 Deliverable set | "Technical Documentation" is the design document plus the README's architecture section and three short supporting files (audit event schema, eval specification, state vocabulary). Nothing beyond that. |
| Q-3 Deployment Guide | The README's local run instructions, plus a description of deployment on the existing ECS, RDS, S3 and SQS stack folded into the design document's architecture section. No hosted deployment. |
| Q-4 Repository host | GitLab (`labs.gauntletai.com`), the existing remote. A GitHub mirror only if the portal requires one. Settled. |
| Q-5 Metric wording | [T]'s reading: 10 minutes is the completion-time benchmark; 38% is the abandonment rate. |
| Q-6 Solution angle | Both named drop-off steps. Feature 1: a contractor-facing application copilot beside the form (product and promo explanation, deterministic payment options, quote-verified field proposals, a homeowner view with templated disclosures). Feature 2: backend document extraction with bounding-box provenance and internal human review of every value. |
| Q-7 Primary user and surface | Contractor-facing. Borrower-facing is a declared surface: the full-screen homeowner view carries the disclosure template; contractor chat passes the same guardrail, and chat replies containing a payment figure carry a one-line estimate footer. |
| Q-8 Auditability in the prototype | Yes. An append-only audit event stream with correlation ids and a versions block on every event, shown in the prototype as a per-application JSON page; the card-first timeline is described in the design. |
| Q-9 Loan product data | An invented three-product catalog described by mechanic type (fixed, 0% introductory, deferred interest) with explicit mechanics; the calculator keys on mechanic. |
| Q-10 Disclosure fidelity | TILA as the four-cell box per option (APR, finance charge, amount financed, total of payments) with the payment schedule beneath and the estimate statement under the payment figure; RESPA as one conditional line for home-secured loans. Placeholder wording; Compliance owns the final text. |
| Q-11 AI usage documentation | A short note at `docs/ai-usage.md`. |
| Q-12 LLM key for reviewers | Anthropic, dated model ids pinned per use case. Reviewers supply their own key in `.env` from a committed `.env.example`; the app starts without a key and says so. |
| Q-13 Other stack pieces | Design-document material. Jira Service Management is mocked by a client whose calls are logged; Zapier is kept out of the review hand-off's critical path; Snowflake receives metrics; Microsoft 365 is not involved. |
| Q-14 Frontend | A React web app (Vite) served by the Node backend, with three role tabs and no login. |
| Q-15 Abandonment target | No numeric commitment. The design states a measurement plan: the per-contractor rollout allowlist is the control group, measured on completion time and abandonment at the product-selection step from the existing Snowflake funnel. |
| Q-16 Confidentiality | Parked for the recruiter. The PDF and its text stay uncommitted. |
