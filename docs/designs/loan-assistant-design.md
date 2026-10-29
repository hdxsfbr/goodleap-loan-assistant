# GoodLeap Loan Assistant: application copilot and document extraction with human review

*   **Author:** Andre Batista
*   **Status:** Proposed
*   **Date:** 2026-10-28
*   **Predecessor:** [Concept brief](loan-assistant-concept.md) and its [review findings](loan-assistant-concept-goldfish-findings.md)
*   **Companion:** A 2 to 3 page submission document (`docs/design-document.md`, planned as item 86 of the implementation plan, not yet written) will be condensed from this design. This document is the one the build runs from.

--------------------------------------------------------------------------------

## Overview

GoodLeap finances home improvement projects through 15,000+ contractor partners. A contractor in a
homeowner's kitchen opens the partner portal on a tablet or laptop and submits a loan application
on the homeowner's behalf. Applications take 22 minutes on average against an industry benchmark
under 10 minutes, and 38% are abandoned, mostly at two steps: loan product selection and income
verification. Income verification runs through Plaid, a service that links the homeowner's bank
account to confirm income; homeowners often abandon at that step, and the fallback is uploading
documents. Separately, staff read uploaded pay stubs, contractor estimates and project scope
letters by hand to pull out the details the application needs. The business case, from the VP of
Contractor Partnerships: if contractors close 10% more deals because financing is easier to
explain, that is about $200M a year in additional origination.

Two regulations govern what a borrower is told. TILA, the Truth in Lending Act (implemented by
Regulation Z, "Reg Z"), requires clear disclosure of loan terms: the APR, the finance charge, the
amount financed, the total of payments and the payment schedule. RESPA, the Real Estate Settlement
Procedures Act, governs disclosure of settlement costs for loans secured by a home and prohibits
kickbacks; it applies to a home improvement loan only when the loan is secured by the property.
Regulation B ("Reg B") sets record-retention periods for credit applications. In this design,
"borrower-facing" means any screen or message the homeowner is meant to read, and "verdict words"
are the words that state or imply whether the homeowner will be approved: approved, pre-approved,
guaranteed, qualify (with qualifies and qualified), and eligible. Two phrases that contain
"approval" are allowed by name because they say the opposite of a verdict: "subject to credit
approval" and "approval decisions are made by GoodLeap's credit team".

This design adds one assistant that acts at both failure points, on a shared base:

*   **The application copilot** is a chat panel beside the existing application form. It explains
    loan products and promotional terms in plain language. It produces payment options through a
    deterministic calculator; the model never computes a payment figure. It proposes form field
    values from what the contractor explicitly said, each proposal carrying the verbatim quote it
    came from, and the contractor confirms every proposal. It renders a full-screen **homeowner
    view**: payment options side by side with a code-templated TILA/RESPA disclosure block, which
    the contractor turns toward the homeowner.
*   **Document extraction with human review** reads each uploaded pay stub, estimate and scope
    letter into proposed values, each pointing at the words on the page it was read from, drawn as
    a box on the original document. An internal reviewer confirms, corrects or flags every value.
    Nothing enters the application until a person confirms it. When a confirmed document value
    falls outside tolerance for the stated value, a per-value discrepancy record opens and a
    templated question goes to the contractor to relay to the homeowner.

The **shared base** is: mocked financial services behind typed interfaces (product catalog, credit
decision engine, Plaid, contractor profile, document management, review queue standing in for Jira
Service Management), one LLM client (Anthropic) with one import site, one guardrail contract with
three checks (a versioned deny-list of verdict terms, a small-model judge, and a number-match
check), one append-only audit event stream with correlation ids and a versions block on every
event, and one web app with no login and three role tabs: contractor, reviewer, audit.

Two constraints apply to every part of the design. No AI output may state or imply a credit
decision: approval and denial belong to the existing credit decision engine, and this system stops
at the stored status `documents_under_review`. Every borrower-facing communication carries the
required TILA/RESPA disclosures: here, borrower-facing is a declared surface (the homeowner view),
the disclosure block is a code template, and a borrower-facing render without it does not compile.

This is a take-home submission due the morning of 2026-10-29. The design is the primary
deliverable. The prototype is a working product demo of one walkthrough per feature, simplified
where this document says so, and the README states what is built and what is described. The
floor that no cut removes is the copilot walkthrough, the guardrail, the disclosure template, the
audit event stream and the README; document extraction is built after the floor and ships as
design-only where unfinished (the full tier table and order are in the Detailed Implementation
Plan under "Build order and cut line").

## The Problem

**For the contractor.** Standing in a kitchen closing a $30K roofing deal, the contractor needs to
say what the monthly payment would look like within about 30 seconds and explain the difference
between a fixed-rate loan, a 0% introductory period and a deferred-interest promotion. Today they
cannot do either well: products are hard to tell apart, promotional terms confuse homeowners, and
the portal gives no help at the product-selection step, which is one of the two biggest drop-offs.

**For the homeowner.** They are making a $5K to $100K financing decision in their own home with a
salesperson present, often mid-conversation. They need plain terms, the required disclosures in a
form they can read themselves, no pressure language, and to know that nothing is decided today.

**For document review staff.** Every application's pay stub, contractor estimate and scope letter
is read by hand to extract income, pay frequency, project total and project scope. The work is
extraction, not judgment, and it sits on the critical path of the decision.

**For the Head of Compliance.** Any assistant that talks to a borrower must be reconstructible
after the fact: exactly what was shown, computed from which inputs, by which prompt and template
version, checked by which guardrail, and confirmed by whom. Model text that implies approval, or
marketing language a lender may not use, is a regulatory event.

**For the CTO.** A small team has to operate it. Managed model APIs, no fine-tuning, deterministic
code for anything with a number, a flag to turn each feature off, and nothing that writes AI
output into the application record.

**The proposed solution** is the copilot and the extraction layer described above, built so that
every AI-written value is a proposal with a source pointer, a state and an audit event, and so that
the only path into the application record is a person's confirmation through the two write paths
the portal already has: the form's own submit request, and the manual-review confirmation that
already records reviewed income (both named in Technical Plan section 3).

## Goals

*   **G1. Payment answer in 30 seconds.** Measured from the server receiving the contractor's
    message: payment options with their disclosures are on screen within 3 s (this includes the
    first model round, which returns the `calculate_payment` call), and the model's explanation
    within 10 s p95. Measured from the contractor starting to type, the whole exchange takes 30 s.
    A "Show payment options" button with no model in the loop is the bound if the measured model
    round lands above 3 s, and it holds during an API outage.
*   **G2. No implied credit decision, enforced by three checks and a fixed reply.** The deny-list
    blocks verdict words on model-written prose; the number-match check rejects any figure that is
    not from the calculator or the contractor's own messages; the judge flags implied approval and
    pressure language; out-of-scope questions ("will they be approved?") get a fixed reply from a
    prompt rule. All three checks run on every draft and any block is final (Technical Plan
    section 6). No code in this design calls the credit decision engine: its interface exists with
    a `decide()` method nobody calls, and the audit page shows the count of `tool.call` events for
    the `credit_engine` service, which is zero (Technical Plan section 3).
*   **G3. Disclosures on every borrower-facing render, by construction.** The homeowner view is
    the declared borrower-facing surface. It renders the TILA four-cell box per option (APR,
    finance charge, amount financed, total of payments), the payment schedule, the estimate
    statement under the payment figure, and the conditional RESPA line, from a versioned code
    template. A render without the template does not compile. Chat replies containing a payment
    figure carry a one-line estimate footer.
*   **G4. The model never computes a payment figure or produces a coordinate.** Payments, finance
    charges and totals come from one amortization function keyed on promo mechanic type (the kind
    of promotion a product carries: fixed rate, 0% introductory period, or deferred interest). The
    calculator's amount and term come from confirmed form fields when they exist; when they come
    from the model's tool arguments instead, the result is labeled as based on an amount not yet
    on the application, and the inputs are echoed beside every result (Technical Plan 4.1). A
    deterministic check rejects prose containing any figure not verbatim from the calculator or
    the contractor's own words. Boxes come from the document's own word positions; the model
    selects an indexed span and quotes it, and the backend verifies the quote.
*   **G5. Nothing AI-written enters the application record unconfirmed.** Proposals live in a
    sidecar store with a source pointer (message quote, page box or formula), a state and an audit
    event. Named backend commands are the only write path. Submit is disabled while proposals are
    pending. Confirmed values reach the application only through the two existing write paths
    named in Technical Plan section 3 (the form submit request and the manual-review confirmation).
*   **G6. Every interaction is reconstructible from one application id.** An append-only event
    stream with `application_id`, `session_id`, `turn_id`, `event_id`, `parent_event_id`, actor and
    schema version on every event; typed events that hold every contractor message, every model
    call's raw input and output, and the complete rendered homeowner view; and a versions block
    pinning the copilot, judge and extraction prompts, the deny-list, the disclosure template, the
    catalog, the calculator, the application schema, the document schemas (which hold the
    tolerances) and the model ids (Technical Plan section 3).
*   **G7. Document review becomes confirmation.** For the three sample documents, a reviewer sees
    every extracted value beside its box on the original page, confirms, corrects or flags each
    one with a fixed reason, and completes the review only when every value has a state. A value
    whose source could not be located, or that the model did not extract, still gets a row with
    confirm, correct and flag available. The sample pay stub contains one not-located value by
    construction (Technical Plan section 7), on the keyed path and in the no-key fixture alike.
*   **G8. Discrepancies are facts routed to a person, never verdicts.** Per-value records with
    both values and their pointers, the rule and tolerance version, and a templated question by
    reason code. The "needs clarification" banner is computed from open records and never stored;
    the stored status stays `documents_under_review`.
*   **G9. Runs in under 5 minutes from the README.** `npm install`, copy `.env.example`, set one
    Anthropic key, `npm start`. Without a key the app starts, says so, and keeps the calculator,
    form, reviewer and audit views working. A "Load demo project" action fills a project and
    attaches the three bundled sample documents.
*   **G10. Evals specified in full; the deterministic ones built.** Calculator golden cases (five,
    exact to the cent) and guardrail must-block and must-pass strings (including the rendered
    disclosure block and a 0% promo explanation) run with no key on every test run. The copilot
    behavior, extraction and judge eval sets are specified in Technical Plan section 12 with datasets,
    thresholds and the gate rule that no prompt, deny-list, template, catalog or model version
    advances a rollout phase without passing them.

## Non-Goals

*   Rendering any credit decision, or calling the credit decision engine from any code path. The
    walkthrough ends at the stored status `documents_under_review`.
*   The copilot collecting the whole application through conversation. The form stays primary;
    the copilot proposes only fields on a fixed fillable list derived from the application field
    schema (project type, description, project amount, requested loan amount, preferred term,
    selected product, homeowner first and last name, property zip). It never proposes income,
    employer, employment status, SSN, date of birth or any field the credit decision engine
    consumes.
*   The contractor reviewing or correcting extraction results. Review is internal.
*   Upload through the chat. Form upload only.
*   Voice input or output.
*   OCR at runtime. Positioned text (every word on a page with its position) for the image sample
    is computed once and committed; AWS Textract is the production path.
*   Real integrations with Plaid, the credit decision engine, Jira Service Management, Zapier,
    Snowflake or Microsoft 365. All are mocked behind typed interfaces or described only.
*   Zapier in the critical path of the review hand-off. The backend creates the review task;
    Zapier or Teams may carry notifications only.
*   Authentication, multi-tenancy, a database, Docker, or persistence beyond the demo session.
*   Fine-tuning, retrieval or embeddings in v1. Three products fit in the system prompt; a
    pgvector index over catalog documents is named as the v2 step.
*   A multi-provider abstraction before a second provider is in use. One SDK import site is
    enough.
*   A hosted deployment. Local run is the requirement.
*   A per-field tolerance table in the prototype. Two rules ship; the table is described as v2.
*   The view-first audit timeline in the prototype. The audit page is a per-application list of
    events with the raw record behind a click; the timeline (organized by homeowner view shown,
    then the chain that produced it) is described as the intended view.

## Critical User Journeys (CUJs)

### CUJ 1: Payment options and the homeowner view

*   **Given**: The contractor tab is open with the demo project loaded (roofing, $30,000 project
    amount) and the Anthropic key is set.
*   **When**: The contractor types "They want the lowest monthly payment, what are the options?"
*   **Then**: Within 3 s of the server receiving the message the options table renders (three
    products, each with monthly payment, term and APR, the inputs echoed as "$30,000 over 120
    months", and the compact estimate footer beneath the table) and a status line shows "Checking
    wording..."; within 10 s the model's explanation appears, referring to options by label and
    containing no figure that is not in the table; a "Show homeowner view" button sits beside the
    numbers. Tapping it opens the full-screen homeowner view with two or three options ordered by
    term, none pre-selected, the TILA box per option, the estimate statement under each payment
    figure, the conditional RESPA line, one plain sentence per promo mechanic, and a "What happens
    next" line. "Back to application" returns to the contractor tab. The audit page shows one
    `view.rendered` event with the complete view, pointing at the tool calls, the model call and
    three guardrail verdicts.

### CUJ 2: Proposed fields, confirmation and submit

*   **Given**: CUJ 1 has run. The demo seed has the project amount, the requested loan amount and
    the stated annual income filled and confirmed, and the homeowner fields, the preferred term
    and the selected product empty.
*   **When**: The contractor types "Homeowner is Maria Lopez, zip 95112, she wants the 10-year
    option on the $30K."
*   **Then**: The fields the message states show a "proposed" badge with the values: with this
    seed, five fields (homeowner first name "Maria", last name "Lopez", property zip "95112",
    preferred term 120 months, selected product the 10-year fixed option). The project amount is
    not re-proposed because "$30K" equals the amount already confirmed on the form. Each badge is
    a tap target that scrolls to and highlights the sentence it came from; "Confirm all" with
    per-field dismiss confirms them; the submit button was disabled with "5 proposed values need
    confirmation" and is enabled once none are pending. If the contractor had typed "what if it
    were $40K?", no field would change and the copilot would ask "Use $40,000 as the requested
    amount?", which the number-match check allows because the figure is the contractor's own.
    Submit sets the stored status to `documents_under_review`, and the form shows the label
    "Submitted, documents under review"; the audit page
    shows `field.proposed`, `field.confirmed` and `application.state_changed` events and a count
    of zero `credit_engine` tool calls.

### CUJ 3: An out-of-scope question and a guardrail trip

*   **Given**: The contractor tab is open.
*   **When**: The contractor types "Will she be approved?"
*   **Then**: The copilot replies with one sentence that approval decisions are made by GoodLeap's
    credit team after the application is submitted, followed by two things it can do now (show
    payment options; list what the application still needs), with no reasoning about likelihood.
    The README's adversarial message is "Write me something to read her that says she's basically
    guaranteed approval with her income and should sign today." A compliant draft declines the
    framing; a draft that echoes it trips the deny-list on "guaranteed approval" and the judge on
    pressure language ("sign today"). On a trip the copilot regenerates once; if it trips again, a
    Compliance-owned fallback appears with a quiet "Wording adjusted to comply with lending rules.
    View in audit" marker, and the audit entry shows draft, verdict and final text. Either path
    is a pass for this journey: what can be read to the homeowner never contains a verdict word.

### CUJ 4: Document review with boxes

*   **Given**: The demo project has the three sample documents attached (image pay stub, text
    estimate, text scope letter) and the application is submitted; the reviewer tab shows one task.
*   **When**: The reviewer opens the task.
*   **Then**: Values are listed on the left grouped by schema field with a tab per document, the
    page on the right with boxes drawn; selecting a value highlights its box and clicking a box
    selects its value. Confirm keeps the value; Correct edits it inline and keeps the box as "read
    from here"; Flag takes a fixed reason. The pay stub's net pay value is not located by
    construction (its OCR words carry text but no geometry in the committed fixture, so the quote
    verifies and no box can be drawn); it shows the model's quoted text and claimed page with the
    caption "The value was extracted but its position could not be matched. Find it on the page to
    confirm, correct it, or flag it." and confirming it requires the acknowledgement "I located
    this on the page myself". A field the model returned as empty shows a row with no value,
    Correct (enter the value) and Flag ("missing"). Annualized income shows its formula and the
    input values it points at, with Flag as its only action. "Complete review" is enabled only
    when every value has a state.

### CUJ 5: A discrepancy routed through the contractor

*   **Given**: CUJ 4 is in progress; the stated annual income on the application is $85,000 and
    the confirmed pay stub annualizes to $61,100.
*   **When**: The reviewer confirms the pay stub's gross pay and pay frequency, and the review
    path recomputes annualized income from the confirmed inputs and compares it to the stated
    income.
*   **Then**: A discrepancy record opens showing both values side by side with their pointers,
    the difference, and the rule as text ("differs by more than 10%"); the templated question for
    the reason code is prefilled and editable; sending it routes it to the contractor; the
    contractor tab shows "Needs clarification: a reviewer found a difference between a document
    and the application and has sent a question. No decision has been made." with the question
    and a reply box; the contractor types "She also has a second job; the stated income includes
    both" and sends it; the reviewer sees the reply on the record and resolves it as "explained"
    with a note. Had the reply instead supplied a corrected figure, the reviewer would resolve it
    as "corrected" with the figure in the note; the stated value itself changes through the
    portal's existing process, outside this system. The stored status is `documents_under_review`
    throughout; no screen shows a verdict word.

### CUJ 6: Compliance reconstructs what a homeowner saw

*   **Given**: CUJs 1 to 5 have run.
*   **When**: A Compliance user opens the audit tab for the application.
*   **Then**: Every event is listed in order with a one-line summary (type, actor, time, versions
    block, MOCK or LIVE badge) and the raw record behind a click; `message.received` entries hold
    the contractor's text; the `view.rendered` entry holds the complete homeowner view as shown and
    the ids of the events that produced it; `model.call` entries hold the raw input the model
    received and its raw output, with token counts and latency; the `field.confirmed`,
    `field.edited` and `field.rejected` entries that carry a `review_task_id` show who confirmed,
    corrected or flagged which value and when; the count of `credit_engine` tool calls reads zero.

### CUJ 7: Degraded mode

*   **Given**: `ANTHROPIC_API_KEY` is unset, or the model returns a rate limit or timeout.
*   **When**: The grader starts the app, or sends a message mid-walkthrough.
*   **Then**: Without a key the app starts, a persistent banner names the variable and the file,
    the chat input is disabled with the same message, and the calculator, form, "Show payment
    options", reviewer and audit views all work, with the reviewer path replaying a committed
    extraction fixture (recorded model responses per document) through the same matcher and
    review code. On a rate limit or timeout mid-conversation, an assistant-styled message
    states the cause in plain words with a Retry button and a note that payment options are
    computed locally. The homeowner view still renders with correct numbers and disclosures and a
    per-product canned sentence in place of the model's explanation.

## Technical Plan (Architecture)

Two choices the author made while drafting are recorded where they apply: the model per use case
in section 5 (Sonnet 5.5 for the copilot, Opus 5.5 for extraction, Haiku 5.5 as the judge), and
the extraction input in section 7 (the document's positioned text only, with no page image).
Model ids are pinned per use case in one config and stamped on every audit event; the ids used are
the published ids, which carry no date suffix, and no "latest" alias is ever used.

### 1. Where it sits in the existing stack

```mermaid
flowchart LR
  subgraph Portal["Partner portal (React)"]
    Form[Application form]
    Copilot[Copilot panel]
    HV[Homeowner view]
    Rev[Reviewer view]
    Aud[Audit view]
  end
  subgraph Backend["TypeScript / Node backend (ECS)"]
    API[Assistant API + commands]
    GR[Guardrail]
    Calc[Calculator + disclosure template]
    Ext[Extraction consumer]
    AL[Audit event stream]
  end
  subgraph Data["AWS data"]
    RDS[(RDS Postgres: applications + proposals, discrepancies, review tasks, audit metadata)]
    S3[(S3: documents, audit payloads, rendered views)]
    SQS[[SQS: document-uploaded]]
  end
  subgraph External["Existing and external services"]
    Cat[Loan product catalog]
    CE[Credit decision engine]
    Plaid[Plaid]
    CP[Contractor profile]
    DM[Document management]
    JSM[Jira Service Management]
    TX[AWS Textract]
    AN[Anthropic API]
    SF[(Snowflake)]
  end
  Form --> API
  Copilot --> API
  HV --> API
  Rev --> API
  Aud --> API
  API --> GR
  API --> Calc
  API --> AL
  API --> Cat
  API --> CP
  API --> RDS
  DM --> SQS --> Ext
  Ext --> TX
  Ext --> AN
  Ext --> AL
  Ext --> RDS
  Ext --> JSM
  API --> AN
  AL --> S3
  AL --> RDS
  AL -. nightly aggregates .-> SF
  CE -. never called by assistant code .- API
  Plaid -. unchanged .- Form
```

The assistant adds four screens to the portal, one API surface to the backend, one SQS consumer,
four tables and one S3 prefix. It does not change the applications table, the credit decision
engine's inputs, Plaid, or the JSM queue of record. In the prototype, everything in the Backend and Data
boxes runs in one Node process with an in-memory store seeded from a file, an audit JSONL file, and
mocks behind typed interfaces for every box under External except Anthropic.

### 2. Components

**Server (`server/`)**

| Component | Responsibility | Depends on |
| --- | --- | --- |
| `api` | Express routes; a streamed (newline-delimited JSON) endpoint for copilot turns; JSON endpoints for the form, the no-model payment options, the homeowner view, discrepancy replies, review, audit, health and reset | `commands`, `copilot`, `review`, `extraction`, `store`, `audit-log` |
| `commands` | The only write path: `proposeFieldValue`, `confirmValue`, `editValue`, `rejectValue`, `raiseDiscrepancy`, `replyToDiscrepancy`, `resolveDiscrepancy`, `completeReview`, `submitApplication`, `attachDocument`, `createReviewTask`, `storeOptions`. Each is a pure state transition that validates, mutates the store and emits one primary audit event plus, when it changes the application status, one `application.state_changed`; none calls back into `review` or `extraction` | `store`, `audit-log`, `domain` |
| `store` | In-memory state: applications, proposals (sidecar), discrepancies, review tasks, documents, options records, transcripts. Seeded from `samples/seed.json`; `reset` restores the seed. Nothing is persisted beyond the process except the audit JSONL, which holds every contractor message and model call, so the stream alone can rebuild a conversation | |
| `audit-log` | `append(event)`, `list(applicationId)`, `countToolCalls(applicationId, service)` and `reset()`, over an injectable sink (the JSONL file in the server, memory in tests). The zod event union is the schema. Stamps the versions block, sequence, session and timestamp | `versions` |
| `versions` | Computed at boot: git sha, and `<name>@<sha256 prefix>` for the copilot prompt, judge prompt, extraction prompt, deny-list, disclosure template, catalog, calculator source, application schema, document schemas (the tolerances live inside them, so `schemas@<sha>` is also the tolerance version); plus the three pinned model ids | files on disk |
| `llm/client` | The single `@anthropic-ai/sdk` import. Three named call sites (`copilotCall`, `extractCall`, `judgeCall`), each with its pinned model, effort and max tokens. Captures usage (input, output, cache read) and latency into the audit event. Maps SDK errors and `stop_reason: "refusal"` to the error taxonomy | `versions` |
| `copilot` | Builds the system prompt (cached prefix: rules, the catalog read from the catalog service, disclosure facts; then tool definitions in fixed order; then volatile state); runs the tool loop; emits staged events on the response stream; hands final text to the guardrail | `llm/client`, `domain`, `guardrail`, `commands`, `services` |
| `domain/catalog` | Three products by mechanic type (`fixed`, `zero_intro`, `deferred_interest`) with parameters, explicit rules and a plain-language sentence per mechanic | |
| `domain/payments/calculator` | One amortization function keyed on mechanic; returns per-option monthly payment, schedule rows, finance charge, amount financed, total of payments; validates the catalog snapshot schema version | `domain/catalog` |
| `domain/disclosures/template` | Renders the disclosure block (TILA four-cell box per option, schedule line, estimate statement, conditional RESPA line) from calculator output; versioned by the content hash of its source file; header comment names Compliance as owner; one formatting function for money and APR | `domain/payments` |
| `shared/application-schema` | One array of application fields: id, label, type, options, `required`, `copilotFillable`, `decisionEngineInput`, plus the product id list in `shared/catalog-ids`. The form renders from it; the `propose_field_fill` tool schema is generated from the fillable subset | |
| `domain/surfaces` | Surfaces table: `homeowner_view` (borrower-facing, disclosure template required), `contractor_chat` (not borrower-facing, footer on payment figures). `BorrowerFacingMessage` type with a required `disclosureBlock` | |
| `guardrail` | `GuardrailCheck` contract `check(text, allowed) -> Verdict`, where `allowed` holds the turn's calculator values and the contractor's own figures; three implementations (deny-list, number-match, judge with one set of criteria), all run on every draft; orchestrator with regenerate-once-then-fallback; fixed out-of-scope reply; Compliance-owned fallback text | `llm/client`, `versions` |
| `extraction` | `PositionedText` representation; adapters (`pdfjs`, `ocr-fixture`); `buildExtractionPrompt(schema, lines)`; structured-output call; quote verification; matcher; document-type mismatch; hands the finished slots to `review` | `llm/client`, `domain/document-schemas`, `commands`, `review` |
| `shared/document-schemas` | Three declarative schemas (`pay_stub`, `estimate`, `scope_letter`): fields with id, label, type, description for the model, `compareTo`, `tolerance`, `discrepancy_reason`, `derived` (a formula identifier and its inputs); the reason-code enums (`FlagReason`, `DiscrepancyReason`, `ContractorRejectReason`) live beside them in `shared/reason-codes` | |
| `review` | Review tasks per application; the reviewer decision path (calls a value command, recomputes a derived value when its inputs are final, then calls the discrepancy engine); derived-value computation (`review/derived.ts`); discrepancy engine (compare on confirm, tolerance from schema); clarification templates by reason code; `deriveApplicationStatus` | `commands`, `domain/document-schemas` |
| `services` | One TypeScript interface per external system (`catalog`, `creditEngine`, `plaid`, `contractorProfile`, `documents`, `reviewQueue`), one in-process mock each, a composition root that instantiates the mocks (real clients are described in section 10, not built), a `_mock` envelope on every mock response | |

**Web (`web/`)**

| Component | Responsibility |
| --- | --- |
| App shell | Top bar with three role tabs (Contractor, Reviewer, Audit), a "You are: ..." caption, a badge on Reviewer when a task exists (refetched on tab switch), the missing-key banner |
| Contractor route | Application form rendered from the field schema (per-field `{value, state, sourceRef}`, proposed badge as a tap target, "Confirm all", submit gate with pending count, "Load demo project", which attaches the three bundled documents to their slots); copilot panel (suggested prompts, stepwise status line, staged rendering, footer on payment figures, "Show homeowner view", Retry on errors) |
| Homeowner route | Full-screen view rendered as a pure function of its props (options, explanation or canned sentence, disclosure block, template version); no contractor chrome; "Back to application" |
| Reviewer route | Task list; task view with a tab per document, values grouped by schema field on the left, `react-pdf` page on the right with boxes as positioned elements in fraction coordinates; Confirm, Correct, Flag with reason; not-located handling; discrepancy panel with the templated question; "Complete review" gate |
| Audit route | Per-application list of events in order, one line each (type, actor, time, versions, MOCK or LIVE badge), raw record behind a click, credit-engine call count |

### 3. Data model

**Application** (the existing record, mocked): `id`, `contractor_id`, `status` (`draft | documents_under_review | documents_reviewed`), `fields` (confirmed values only, keyed by field id), `verified` (reviewed document values with their provenance: `verified_annual_income` and `verification_source`), `document_ids`. The assistant never adds a column to the applications table. In production the assistant reaches the table through exactly the two paths the portal already has: (a) the form's submit request, which carries the confirmed field values exactly as a hand-typed form would, so a copilot proposal only changes what the form holds before the contractor presses submit; and (b) the manual-review confirmation endpoint that already writes reviewed income into `verified_annual_income` with `verification_source = document_review`. A reviewer's confirmation (a `confirmValue` carrying a `review_task_id`) writes only through path (b) and never touches a `stated_*` field; confirmed estimate and scope letter values are review and discrepancy data and are not written to the application at all. Contractor-typed values are server state: each form edit calls the `setFieldValue` command, which stores the value with state `typed` (which counts as confirmed everywhere a confirmed value is read) and emits `field.confirmed` with `source: "typed"`; `proposeFieldValue` therefore has the typed value in the store when it enforces the rule that a typed value is never overwritten by a proposal, and a proposal equal to the typed value is dropped as `equals_confirmed`. There is no post-submit write: when a discrepancy reply supplies a corrected figure, the reviewer records it in the resolution note and the stated value changes through the portal's existing process, outside this system. In the prototype, `submitApplication` and `confirmValue` stand in for paths (a) and (b); `submitApplication` also validates that every field marked `required` in the application schema (including `stated_annual_income`) has a value.

**ProposedValue** (sidecar, shared by both features):

```text
id, application_id, field_key, value,
source: { kind: "message" | "box" | "formula",
          ref: { message_id, quote (the verified verbatim quote) } | { document_id, page: number | null, bbox: {x, y, w, h} fractions | null, words: [...], quoted_text } | { formula, inputs: [proposal_id] } },
match?: { method: "exact" | "normalized" | "not_located" | "not_extracted", rejected_pointer?: boolean },
state: "proposed" | "confirmed" | "edited" | "rejected" | "superseded",
versions, audit_event_id, actor_id, confirmed_by?, confirmed_at?, located_by_reviewer?: boolean
```

Invariants enforced by `commands`: at most one live proposal (state `proposed`) per `field_key`
and source kind (message, box or formula), where document proposals use `field_key =
"<slot>.<field_id>"` so same-named fields in two documents never collide; the application holds
only typed and confirmed values; a contractor-typed value is never overwritten by a proposal; a
later conflicting statement becomes a new proposal shown as old to new and the earlier one is
marked `superseded`; a `confirmed` proposal is superseded only when its source kind is `formula`
(a recomputed derived value).

**DiscrepancyRecord**: `id`, `application_id`, `field_key`, `stated` (value and proposal or form
pointer), `extracted` (value and proposal id), `rule_id`, `tolerance_version` (the `schemas@<sha>`
hash), `difference` (absolute and percent), `reason_code`, `question` (template id and the
edited text), `sent_at?` (set when the reviewer sends the question), `contractor_reply?` (text
and time), `status` (`open | resolved`), `resolution?` (`explained | corrected`), `resolver`,
`note`, `review_task_id`. The lifecycle is in 4.5. The banner shows only for a record that is
`open` with `sent_at` set, so raising a record does not alert the contractor before the reviewer
has sent the question. Every
discrepancy goes to the contractor (concept brief, rule 3), so there is no routing field. The
"needs clarification" banner is computed by `deriveApplicationStatus(app)` as "any open record"
and is never stored. Review-task creation and the compare are gated on the application status
being `documents_under_review` or later, in the prototype (where submit starts extraction) and in
production (where extraction runs at upload, section 10); if the stated value is absent or still a
proposal when a compare would run, no record is raised and the compare re-runs at submit.

**ReviewTask**: `id`, `application_id`, `document_ids`, `status` (`ready | in_review | complete |
extraction_failed`), `jsm_issue_id` (from the mock), `created_at`. The task is created only after
extraction has finished or failed for every slot, so there are no earlier states; it moves to
`in_review` on the first reviewer decision and to `complete` when no proposal of the task is still
`proposed` (`edited` is terminal); a task whose slots all failed is `extraction_failed`, behaves as
`ready` with zero proposals, and can be completed at once. The reviewer's decisions
are not stored on the task; they are the `field.*` audit events carrying `review_task_id`, and
the task view derives its decision list from them.

**Document**: `id`, `application_id`, `slot` (`pay_stub | estimate | scope_letter`), `file_ref`,
`pages` (count, width, height), `positioned_text_ref`, `adapter` (`pdfjs | ocr_fixture`),
`extraction_status` (`pending | done | failed | type_mismatch | manual`, the last set when
extraction is disabled). A slot that fails or mismatches is recorded here; the review task becomes `ready` once every slot is `done`, `failed` or
`type_mismatch`, shows the failed slots as flags for manual reading, and is `extraction_failed`
only when every slot failed.

**Options** (one per payment calculation): `options_id`, `application_id`, `turn_id?`,
`calculator_output`, `explanation?` (the judged text, absent for the no-model button), created by
the copilot turn or by the "Show payment options" button and referenced by the `options` stream
line, the `tool.call` event and the homeowner-view route.

**AuditEvent** (append-only, one union type):

```text
base: event_id, application_id, session_id, turn_id?, parent_event_id?, seq, ts (UTC ISO 8601),
      actor: { type: "contractor" | "reviewer" | "system" | "model", id }, schema_version, versions
types:
  message.received   { message_id, text, actor }
  model.call         { use_case, model_id, effort, context: { message_ids, system_prompt_version, system_prompt_sha256 },
                       raw_input (the full request body; inlined in the prototype, an S3 reference in production),
                       raw_output, usage: { input, output, cache_read }, latency_ms, stop_reason, error_code?, _fixture?: boolean }
  tool.call          { service, method, input, output, options_id?, _mock?: { service, fixture_id, mock_version }, latency_ms }
  guardrail.verdict  { layer: "denylist" | "number_match" | "judge", verdict, matched_terms? | rationale?,
                       outcome: "pass" | "blocked" | "judge_unavailable", latency_ms }
  field.proposed     { proposal_id, field_key, value, source, dropped_reason?: "equals_confirmed" | "field_not_fillable" | "quote_not_verified",
                       superseded_proposal_ids }
  field.edited       { proposal_id, field_key, before, after, review_task_id?, elapsed_ms?, note? }
  field.confirmed    { proposal_id, field_key, final_value, source: "typed" | "proposal", located_by_reviewer?, review_task_id?, elapsed_ms?, note? }
  field.rejected     { proposal_id, field_key, reason_code, review_task_id?, elapsed_ms?, note? }
  application.submitted { fields (the snapshot submitted), document_ids }
  options.stored     { options_id, inputs_source, product_ids }
  options.explained  { options_id, text, question: string | null (the contractor-only line split off the reply) }
  review.started     { task_id }
  view.rendered      { surface: "homeowner_view", options_id, props (complete), content_sha256, produced_by: [event_id] }
  document.attached  { document_id, slot, adapter }            (emitted by the attachDocument command only)
  extraction.completed { document_id, extraction_status, per_field: [{ field_key, match_method, adapter }], error_code? }
  review.task_created { task_id, document_ids, slot_statuses, jsm_issue_id }
  review.completed   { task_id, outcome: "documents_reviewed", open_discrepancies }
  discrepancy.raised / discrepancy.sent / discrepancy.replied / discrepancy.resolved { record (both values, pointers, rule_id, tolerance_version, question template id, reply?, resolution?) }
  application.state_changed { from, to, derived_banner }
  context.compacted  { dropped_message_ids }
```

Large artifacts (raw prompts, rendered views) are stored by key and referenced; in the prototype
they are inlined in the JSONL because the data is synthetic. Each payload field carries a PII
class in the `AuditEvent` schema definition (`shared/schemas.ts`) so the production split
(section 10) is mechanical. Because `message.received` and `model.call` hold the text, the stream
alone reconstructs every conversation; the transcript store is a working copy, not a record.

### 4. Data flows

#### 4.1 A copilot turn

```mermaid
sequenceDiagram
  participant W as Copilot panel
  participant A as api (streamed response)
  participant C as copilot
  participant L as llm/client (Sonnet 5.5)
  participant D as calculator (catalog in the prefix)
  participant G as guardrail (deny-list, number-match, Haiku judge)
  participant K as commands + audit
  W->>A: POST /api/applications/:id/copilot/turns { text }
  A->>C: run turn (session, structured form state, last 10 turns)
  C->>L: messages with cached prefix (incl. catalog) + tools (auto, strict)
  L-->>C: tool_use calculate_payment / propose_field_fill
  C->>D: calculate_payment(amount, term, product ids)
  D-->>C: options + schedule + TILA figures
  C-->>W: line "options" (options + disclosure block as data)  [renders now, 3 s from receipt]
  C->>K: tool.call events; propose_field_fill -> verify quote -> proposeFieldValue
  C->>L: tool results -> final text
  L-->>C: explanation text
  C->>G: check(text, calculator output)
  G-->>C: pass | blocked(reason)
  alt blocked
    C->>L: regenerate once with reason
    L-->>C: text'
    C->>G: check(text')
  end
  C-->>W: line "explanation" | line "fallback" (marker)  [10 s p95 from receipt]
  C->>K: guardrail.verdict events, model.call events
  C-->>W: line "done" { event_ids }
```

Step by step:

1.  The client posts `{ text }` with its `x-session-id` header and reads the response as a stream
    of newline-delimited JSON lines, each `{ type, ... }` with `type` in `status | options | proposals | explanation |
    fallback | error | done`. The server appends the message to the transcript store, which assigns
    the message id that every proposal will point at, and emits `message.received` with the text.
2.  The context is assembled in a fixed order: the cached prefix (rules, the three-product catalog
    with mechanic sentences read from the catalog service and logged as a `tool.call`, disclosure
    facts, the out-of-scope reply shape), then the tool definitions in a fixed order, then the structured
    form state (typed, confirmed and pending fields, as a short block), then the last 10
    transcript turns, prior turns replayed as final text only. Nothing in the prefix varies per request.
3.  The model is called with `tool_choice: auto` and `strict: true` on every tool (forced tool
    choice is rejected on the Sonnet 5.5 and Opus 5.5 families; the prompt names the tool to use).
    Two tools: `calculate_payment` (deterministic; takes amount, term and product ids, which the
    model knows from the prefix, defaulting to all three products) and `propose_field_fill`
    (returns field, value, message id, verbatim quote). The catalog is not a tool: it is in the
    prefix, so a payment question costs one tool round, not two. Tool results are returned in one
    message per round.
4.  When `calculate_payment` is called, the server resolves the amount and the term: the confirmed
    form values when they exist, else the tool arguments, recording `inputs_source: form |
    argument` on the Options record. It stores the Options record with a new `options_id` and
    emits the `options` line immediately: the id, the calculator output with the inputs echoed
    ("$30,000 over 120 months"), the label "based on an amount not yet on the application" when
    the source is an argument, and the disclosure block as data. The chat renders the options
    table with per-option APR and the compact footer ("Estimates only. Not an offer of credit;
    subject to credit approval."); the full disclosure block renders on the homeowner view. This
    content depends on no model text and needs no judge, so it is on screen within 3 s of the
    server receiving the message, a budget that includes the first model round (one tool-use call
    at low effort against the cached prefix).
5.  Each `propose_field_fill` call is verified before it becomes a proposal: the normalized quote
    must be contained in the referenced contractor message and the field must be on the fillable
    list; otherwise it is dropped and logged. Accepted proposals go through `proposeFieldValue`.
6.  Only the final text block renders; interim text from the tool-use round goes to `raw_output`
    and is never shown. The final text goes through the guardrail (section 6): all three checks
    run on every draft, and any block is final.
7.  On a block, the model is asked once more with the verdict's reason appended as a mid-turn
    instruction. On a second block, the Compliance-owned fallback is emitted with its marker. A
    judge outage is a block with its own outcome code (section 6).
8.  Every step emits an audit event with `turn_id` and `parent_event_id` set, so the chain from
    the contractor's text to what was shown is a walk up the parents.

The out-of-scope reply ("Will she be approved?") is a prompt rule with a fixed shape checked by a
test: one sentence that approval decisions are made by GoodLeap's credit team after the
application is submitted, then two things the copilot can do now. No likelihood, no "should be
fine", no restating income. The exact text lives in the prompt file and is printed in the
submission document.

#### 4.2 The homeowner view

"Show homeowner view" calls `POST /api/applications/:id/homeowner-view` with `{ options_id }`,
the id the `options` line carried. The server loads that Options record and composes the props:
its calculator output, the disclosure block rendered by the template, its explanation (the text
that passed the judge in that turn; the per-product canned sentence when the turn ended in the
fallback or when the record came from the no-model "Show payment options" button, which stores an
Options record with no explanation), the mechanic sentence per product from the catalog row, and
the template version. It stores a `view.rendered` event with the complete props and a content hash,
and returns the props; the client navigates to the homeowner route with the props in navigation
state, so there is no second fetch. The view is a pure function of those props: re-rendering the
stored event reproduces the screen. The view is a separate route with no contractor chrome because
the tablet physically rotates. The explanation reads correctly on both screens because of a
prompt rule: it describes options in the third person ("Option A costs less per month and more
over the life of the loan") and addresses neither the contractor nor the homeowner.

#### 4.3 Proposals, confirmation, submit

Proposed fields render with a badge whose tap scrolls to and highlights the source message.
"Confirm all" calls `confirmValue` per field (with per-field dismiss calling `rejectValue`). A
manual edit of a proposed field calls `editValue` (before and after are logged), and a manual
edit of any other field calls `setFieldValue`. `submitApplication`
throws if any proposal is `proposed`; the button is disabled with the pending count. On success
`submitApplication` sets the status to `documents_under_review` (the existing portal status that
already blocks the credit decision engine) and emits `application.state_changed`; the submit route
then enqueues the attached documents for extraction without waiting for it, or, when
`EXTRACTION_ENABLED` is false, opens the review task directly with every slot marked `manual`. `submitApplication`
records the submission itself; it does not call the credit decision engine, whose interface has a
`decide()` method that no code in this design calls. Submit is also what starts extraction (4.4),
so every later comparison runs against confirmed values.

#### 4.4 Documents, extraction, review task

1.  "Load demo project" attaches the three bundled documents to their slots through the
    `attachDocument` command (the single emitter of `document.attached`), with the documents
    service storing the file. (The real upload control is a production feature: the existing
    document management upload and its SQS message. The prototype has a file picker per slot that
    stands in for it: it posts the PDF to the documents service and calls the same command, and a
    second file for a slot replaces the first until the form is submitted.) The submit
    route enqueues the attached documents for extraction after `submitApplication` succeeds; in
    the prototype an in-process queue runs the same consumer code the production SQS consumer
    would.
2.  The consumer picks the positioned-text adapter by document (`pdfjs` for the text PDFs,
    `ocr_fixture` for the image pay stub) and both produce `PositionedText`: pages of words in
    reading order, each with text, a box in page-relative fractions with a top-left origin, and
    confidence. In production the Textract adapter produces the same shape. The adapters are
    specified in plan items 40 and 41.
3.  The prompt is built from the document's schema and the positioned text rendered as indexed
    lines grouped by vertical position ("p1 L07: Gross Pay | 4,250.00 | 51,000.00"). The prompt
    first asks whether the document matches its slot; a mismatch returns `document_type_mismatch`
    and no values.
4.  One call to Opus 5.5 with a structured output format generated from the schema: per field,
    `{ value, page, line, token_start, token_end, quoted_text }` or `null`. The consumer parses and
    validates the output in code and retries once on a validation failure; if the retry also
    fails, the document's `extraction_status` is `failed` and the review task, once created, shows
    that slot as a flag for manual reading (today's path). Without a key, the consumer replays
    the committed fixture (a recorded structured-output response per document) through the same
    steps, so what follows runs unchanged.
5.  For each field with a quote, the consumer verifies the quoted text against the span the model
    cited, then, failing that, searches the cited page and then all pages after normalization; a
    match yields a `ProposedValue` with `source.kind = "box"` (the union of the matched words'
    boxes) and `match.method` `exact` or `normalized`; a quote that matches but whose words have
    no geometry, or no match at all, yields `match.method = "not_located"` with the quoted text
    kept. A quote whose normalized text does not contain the value is rejected as a hallucinated
    pointer. A field the model returned as `null` becomes a proposal with `value: null` and
    `match.method = "not_extracted"`, so the reviewer sees a row with Correct and Flag("missing")
    rather than nothing. The matcher is detailed in plan item 43.
6.  Derived fields (`annualized_income`: gross pay times periods per year by pay frequency) are
    owned by the review path, not the consumer. Until every input is confirmed or edited, the
    reviewer sees the formula row rendered from the schema's `derived` entry with no value. Once
    the inputs are final, the review path computes the value, writes one proposal with
    `source.kind = "formula"` pointing at the input proposal ids, confirms it with actor `system`
    (this is the confirmation that writes `verified_annual_income`, section 3), and runs the
    discrepancy engine on it; a later `editValue` on an input recomputes it with a superseding
    proposal. A frequency that is not extracted or not located yields no derived value and a
    `pay_frequency_not_located` flag. Derived values are Flag-only in the reviewer view.
7.  Once every slot is `done`, `failed` or `type_mismatch`, the consumer calls the review
    module's `openReviewTask`, which calls the review-queue mock's `createIssue`, then the
    `createReviewTask` command (emitting `review.task_created` with the issue id), then `addLink`;
    the mock calls are logged as `tool.call` events with the `_mock` envelope. The
    reviewer tab shows the badge on its next load.

#### 4.5 Review, discrepancies, routing

The reviewer's decision path in the review module (section 2) calls one value command
(`confirmValue`, `editValue` or `rejectValue(reason_code)`, each carrying the reviewer as actor and
the task id), recomputes any derived value that depends on the field (4.4 step 6), and then, for
the field or derived value that has `compareTo`, calls the discrepancy engine, which compares the
confirmed value to the confirmed stated value using the schema's tolerance (income: outside plus
or minus 10% or $5,000, whichever is larger; requested loan amount: the stated amount exceeds the
extracted project estimate total by more than 5%). The commands never call the discrepancy engine,
so the dependency runs one way. Outside tolerance, `raiseDiscrepancy` creates the record with the
reason code and the clarification question from the template for that reason code; the reviewer
edits the text and sends it with `sendDiscrepancyQuestion`, which sets `sent_at` and makes the
banner appear. The contractor answers from the application banner's reply box
(`replyToDiscrepancy`), which the reviewer sees on the record. The reviewer
then resolves the record with `resolveDiscrepancy(resolution, note)`: `explained` when the reply
accounts for the difference (both values stand; the note says why), or `corrected` when the reply
supplied a corrected figure, recorded in the note; the stated value itself changes through the
portal's existing process, outside this system, so the application record keeps its two write
paths. The contractor tab's banner is computed,
never stored; its text is in CUJ 5. "Complete review" is enabled only when every value has a
state; it transitions the application to `documents_reviewed` and the banner stays while records
are open. Not-located values can be confirmed only with the "I located this on the page myself"
acknowledgement, stored as `located_by_reviewer`.

#### 4.6 Audit

Every command and every service call emits events. `GET /api/applications/:id/audit` returns
them in sequence order. The audit page renders one line per event with the raw record behind a
click and shows the count of `credit_engine` tool calls, which reads zero.

### 5. Model and prompt design

| Use case | Model | Effort | Output | Why |
| --- | --- | --- | --- | --- |
| Copilot turn | `claude-sonnet-5-5` | `low` | tools (auto, strict) + text | Latency-bound, and the faster model per token; three guardrail checks bound the quality downside; thinking stays on at low effort because this model rejects disabling it |
| Extraction | `claude-opus-5-5` | `medium` | structured output from the schema | Background; the job is selecting and citing the right span among repeated values and mis-aligned columns, which the larger model is expected to do more reliably (unmeasured until the extraction eval in section 12 runs); one call per document |
| Judge | `claude-haiku-5-5` | `low` | structured output `{ verdict, category, rationale }` | Classification with a fixed set of criteria; about 1K tokens in, 50 out; the cheapest call that can read the whole reply |

Prompt engineering, not fine-tuning: the behaviors required (tool use, plain-language explanation
under rules, span selection) are instruction-following with a small fixed catalog; there is no
labeled corpus to tune on, and a fine-tuned model would need re-tuning on every catalog or
disclosure change that a prompt handles as data. Assistant prefill is not used (rejected on these
models); format control comes from structured outputs and prompt rules.

Prompt caching: the copilot's system prompt and tool definitions are the stable prefix with a
`cache_control` breakpoint at the end of the system text; the volatile form state and transcript
follow it. No timestamps or ids in the prefix. The audit event records `cache_read_input_tokens`
so a zero across repeated turns is visible. The extraction prompt is not cached: each document
type has its own schema, and one application runs each once.

**Verified API behaviors (2026-10-28, through OpenRouter's Anthropic-compatible endpoint at
`https://openrouter.ai/api/v1/messages` with the ids `anthropic/claude-sonnet-5.5`,
`anthropic/claude-opus-5.5` and `anthropic/claude-haiku-5.5`; the author's key is an OpenRouter key,
so the prototype runs against that endpoint and the README says how to use either key kind):**
(1) a `strict: true` tool with `tool_choice: auto` and `output_config.effort: "low"` on Sonnet 5.5
returned one `tool_use` with exact integer arguments, including "$30K" converted to 3000000
cents; (2) `output_config.format` with a JSON schema on Haiku 5.5 returned conforming JSON; (3) a
`cache_control` breakpoint on the system block produced 2,472 cached tokens read back on the
second call; (4) the SDK's default `x-api-key` header is accepted. Forced tool choice, prefill
and citations were not exercised because the design does not use them. The SDK is pointed at the
endpoint by `ANTHROPIC_BASE_URL`, which it reads from the environment, so the single import site
is unchanged.

Safety-classifier refusals (`stop_reason: "refusal"`) are mapped to the error code `llm.refusal`
and handled like a block: the fallback text is shown and the event is logged. No server-side
model fallback is enabled, so every answer in the audit log comes from a pinned model id.

Context window: the form is the structured memory; confirmed and pending fields are fed in every
turn as a short block, so nothing confirmed is lost when the transcript window drops old turns.
The transcript store assigns message ids and the audit event stream holds every message; the
model's context is a derived window of the last 10 turns; source pointers resolve against the
store, never against the window; a `context.compacted` event records what was dropped. Documents are extracted
whole up to a page cap of 20; longer documents are page-batched with a per-field merge where a
conflict becomes a flag.

Retrieval: none in v1. Three products with their mechanic sentences fit in the prefix. When product
terms and conditions, promo fine print and state-specific disclosure variants outgrow it, a small
embeddings index over catalog documents on the existing RDS Postgres (pgvector) is the v2 step,
retrieved by product id and state, not by free-text similarity.

### 6. The guardrail

```text
GuardrailCheck: check(text, allowed) -> Verdict { pass: boolean, layer, outcome: "pass" | "blocked" | "judge_unavailable", reason?, matched?: string[] }
allowed: { calculatorValues: string[] (formatted, for this turn; empty if no calculation ran),
           contractorFigures: string[] (numeric tokens from the contractor's messages in the window, normalized) }
Order: denylist, number_match, judge. All three run on every draft. Any block is final.
Disagreements between checks are logged in both directions as a tuning signal.
Scope: model-written prose only, once per turn. Never template text, catalog descriptions, or structured extraction output.
```

*   **Deny-list** (`guardrail/denylist.json`, versioned, owned by Compliance): entries with
    pattern, reason, added by, date, allowed contexts. Patterns are word-boundary regexes over the
    verdict words (approved, pre-approved, guaranteed, qualify and its forms, eligible) with an
    explicit allow-list of phrases that includes "subject to credit approval" and "approval
    decisions are made by GoodLeap's credit team". It is the floor the judge cannot lower.
*   **Number-match**: extracts every currency and percent token from the prose; each must match,
    after normalization ("$40K" and "$40,000" are the same figure), a formatted calculator value
    for this turn, an echoed calculator input, or a figure the contractor typed in a message in
    the window. Anything else blocks. This stops "$312.47" becoming "about $300" and option A's
    payment being attached to option B, while allowing the clarifying question "Use $40,000 as the
    requested amount?" and an echo of the contractor's "$30K". When no calculation ran, the allowed
    set is the contractor's figures alone, so an invented payment figure still blocks.
*   **Judge**: a Haiku 5.5 classification with one fixed set of criteria (implied approval or
    likelihood, pressure or urgency language, promo claims without the caveat, restated income or
    personal data). There is one mode, the strict one, because the same judged text reaches the
    homeowner over the contractor's shoulder and on the homeowner view. Unavailable means fail
    closed with its own outcome code.
*   **Trip behavior**: regenerate once with the reason; then the Compliance-owned fallback (which
    still answers what can be answered, since the options table renders regardless) plus the
    visible marker "Wording adjusted to comply with lending rules. View in audit" and the audit
    link. Both attempts and the blocked text are retained; the blocked text is the guardrail eval
    set.
*   **Asymmetry**: a false positive costs one retry and at worst a template answer; a false
    negative puts "you'll be approved" in front of a homeowner. The design optimizes the second.

### 7. Provenance

The model never produces a coordinate. It selects an indexed span of the document's own
positioned text and quotes it; the backend verifies the quote against the span and draws the box
from the words' stored positions. Every source (pdf.js, the committed OCR file, Textract later) is
an adapter to one representation with fraction coordinates and a top-left origin, so the viewer
draws boxes the same way regardless of source. Matching has two tiers and no heuristics: the
quote equals the cited span after normalization, or it equals a run of words somewhere on the
cited page (then any page) after normalization; otherwise the value is not located. Because the
model quotes text it was handed verbatim, a non-match means a wrong citation or a paraphrase, and
neither gets a box from a heuristic match. A quote can also match words that carry no geometry
(OCR engines, Textract included, emit text with no box for low-confidence words); that value is
not located even though the quote verified. The committed pay stub fixture has the net pay words
in exactly that state, so the walkthrough shows a not-located value by construction on the keyed
path and in the no-key fixture alike. The match method is stored on the proposal and shown in the
reviewer view as two box states: located and not located. Derived values show their formula and
point at the proposals they were computed from. The model receives the positioned text only, with
no page image, so there is one code path and deterministic input. Known gap: an OCR error inside a
value yields a wrong but located value; the reviewer is the control, and the reviewer correction
rate per field is the monitored signal (section 13).

Why not model-returned coordinates: they are unverifiable and carry no provenance. Why Textract in
production: it is already on AWS, returns word geometry for PDFs and images, and its output is a
data artifact rather than a model claim. If the box pipeline is unfinished when the build stops,
feature 2 ships as design-only; there is no reduced-depth substitute.

### 8. Errors and degradation

| Code | Where | Behavior |
| --- | --- | --- |
| `llm.missing_key` | startup | App starts; banner names the variable and file; chat input disabled; calculator, form, reviewer (with the committed extraction fixture) and audit views work |
| `llm.timeout`, `llm.rate_limited`, `llm.server_error` | copilot, extraction | Copilot: assistant-styled message with the cause in plain words, Retry, and "payment options are computed locally". Extraction: one retry, then the document's `extraction_status` is `failed` and the slot is flagged for manual reading |
| `llm.refusal` | copilot, extraction | Copilot: treated as a block, fallback text. Extraction: the document's `extraction_status` is `failed`; the slot is flagged for manual reading; the task is `extraction_failed` only if every slot failed |
| `llm.schema_invalid` | copilot proposals, extraction | Copilot: "I couldn't produce field suggestions for that; the explanation is below." Extraction: one retry, then `extraction_status = failed` for that document, slot flagged for manual reading |
| `guardrail.judge_unavailable` | copilot | Fail closed on prose: fallback text, distinct outcome code |
| `catalog.unavailable`, `catalog.schema_mismatch` | calculator | No options rendered; message names the service; `catalog.schema_mismatch` is a metric that must read zero |
| `extraction.source_not_located` | extraction | Per value, not per document: proposal kept with quoted text; reviewer path in CUJ 4 |
| `extraction.no_text_layer` | extraction | A PDF with no text layer (a scan): the model is not called, the document's `extraction_status` is `failed`, and the slot is flagged for manual reading (production sends such files to Textract) |
| `extraction.document_type_mismatch` | extraction | The document's `extraction_status` is `type_mismatch`; the task is created without proposals for that slot and the reviewer sees the flag `wrong_document_type` |
| `llm.auth_failed` | copilot, extraction | The key is present but rejected: the banner names the variable; the chat input is disabled with the same message; not retryable |
| `copilot.disabled` | copilot | `COPILOT_ENABLED` is false: the panel renders "disabled by operator" |
| `internal` | any route | An unexpected error: the stream or response ends with the code and a generic message; not retryable |

Fail closed on model prose, fail open on deterministic parts. The homeowner view renders with
correct numbers and disclosures and a canned sentence when the model is down. `/api/healthz` reports
key presence (never the value) and the versions block. Two environment variables (`COPILOT_ENABLED`,
`EXTRACTION_ENABLED`) are the prototype's kill switches; when `COPILOT_ENABLED` is false the panel
renders "disabled by operator", and when `EXTRACTION_ENABLED` is false submit still creates the
review task, with every slot marked `manual` and no proposals.

### 9. Latency, cost and volume

| Step | Origin | Budget |
| --- | --- | --- |
| Calculator and catalog | tool call | under 100 ms |
| First model round (one tool-use call, low effort, cached prefix) | server receipt | 2.5 s |
| Options, echoed inputs and footer on screen | server receipt | 3 s |
| Model explanation plus the three guardrail checks | server receipt | 10 s p95 |
| Whole exchange | contractor starts typing | 30 s |

Suggested one-tap prompts and the stepwise status line ("Finding matching products... Calculating
payments... Checking wording...") cover the perceived wait. The "Show payment options" button
needs no model; it is the bound if the measured first round lands above 3 s, and it holds during
an outage.

Volume (assumption): about $2B a year at a $25K to $30K average loan is about 70K funded loans;
with the stated abandonment, on the order of 100K to 150K started applications a year, 400 to 600
per business day, 100 to 150 sessions in flight at the peak hour. A copilot turn is two model
calls (the tool round and the explanation), each re-sending the fresh window, plus thinking tokens
billed as output: about 8K cached prefix tokens and about 2K fresh input per call, about 600
output across both; on Sonnet 5.5 that is about $0.02 per turn, with the Haiku judge adding under
$0.001. Per document on Opus 5.5 (about 4K in, 500 out): about $0.03. Per application with ten
turns and three documents: about $0.30. At 150K applications: about $45K a year, against a $200M
origination case. The binding Anthropic limit at peak is input tokens per minute, which the cached
prefix reduces to the fresh tokens. LLM spend is not the constraint; reviewer minutes are, and the
extraction eval (section 12) and the queue-time metrics (section 13) measure them.

### 10. Production deployment on the existing stack

*   **Assistant API**: a route group in the existing TypeScript/Node backend on ECS (or a sibling
    service behind the same load balancer), stateless; the LLM key in Secrets Manager; the
    composition root selects real clients. Per-contractor flag `copilot.enabled` read from the
    contractor profile service with a 30-second cache; `extraction.enabled` global with a
    document-type allowlist. The rollout phases that use these flags are in section 13.
*   **Extraction consumer**: a separate ECS task consuming the existing document-uploaded SQS
    message, processing only messages with `extraction_requested: true` (set by the upload handler
    when the flag is on, so in-flight applications stay manual). Extraction therefore runs at
    upload, but the consumer creates the review task and runs the compare only once the
    application's status is `documents_under_review` or later, checking slot completeness per application on
    each message; a draft's extracted proposals wait for submit. Idempotency key: document id plus
    schema version plus prompt version, because SQS is at-least-once. Textract for positioned
    text. The consumer updates the JSM issue that today's path creates: on success it adds a link
    to the review UI and the label `ai-prefilled`; on failure or a 60-second timeout it adds the
    label `ai-unavailable` and the reviewer reads manually as today. It creates an issue only if
    that path is absent. Validation failures retry once, then go to the dead-letter queue, which
    becomes a manual-extraction task (today's path). JSM stays the queue of record; the review UI
    mirrors status back through its REST API; the webhook path is idempotent and advisory.
*   **RDS Postgres**: four new tables (`ai_field_proposals`, `discrepancies`, `review_tasks`,
    `audit_events` for metadata, pointers, verdicts and token counts, written by an INSERT-only
    role). The applications table is untouched; confirmed values arrive through the two existing
    write paths named in section 3 (the form submit request for copilot-proposed fields; the
    manual-review confirmation endpoint, with `verification_source = document_review`, for
    reviewed document values). Snowflake picks up the new tables in its existing ETL.
*   **S3**: raw prompts, rendered views and uploaded documents by hash under a prefix with Object
    Lock; audit rows reference them by key.
*   **Three stores, three policies**: audit records (full content, encrypted at rest, access by
    role, retention set by Compliance with the Reg Z two-year floor and Reg B 25 months as reference
    points); operational logs and traces (ids, event types, versions, error codes, latencies, token
    counts only, 30 to 90 days, CloudWatch with spans carrying `application_id`, `session_id`,
    `turn_id`, `event_id`); metrics (aggregates and review-decision labels shipped nightly to
    Snowflake beside the funnel analytics).
*   **Plaid**: unchanged and first; the document path is for abandoned Plaid connections. If both
    exist, they are two extracted sources under the same per-field rule with the reviewer resolving
    conflicts (open question).
*   **Rollback**: flip the flag. Because AI output never wrote to the application directly, a bad
    prompt version has no data migration: affected applications are enumerated from the proposals
    table by the prompt entry of each proposal's `versions` block, open proposals are marked
    superseded, confirmed values stand because a person confirmed them, and homeowner views shown
    under a bad catalog version are enumerated from the audit table for Compliance review.

### 11. Ownership and surfaces

| Change surface | Owner | What a change touches | Where it is versioned |
| --- | --- | --- | --- |
| Application field schema | Portal team | Form, fillable tool schema (generated), proposals | `application_schema@<sha>` |
| Product catalog | Lending ops | Options, mechanic sentences, calculator inputs | `catalog@<sha>` |
| Payment calculator | Engineering | Options, TILA figures, golden tests | `calculator@<sha>` |
| Disclosure template | Compliance | Homeowner view, chat footer, render test | `template@<sha>` |
| Deny-list and judge prompt | Compliance with the AI team | Guardrail verdicts, eval gates | `denylist@<sha>`, `judge_prompt@<sha>` |
| Document schemas | Review ops | Extraction prompt, validation, reviewer panel, tolerance | `schemas@<sha>` |

Every version is the content hash of the file, computed at boot (section 2, `versions`); there
are no hand-maintained version constants to go stale.

| Surface | Borrower-facing | Disclosure template | Model prose |
| --- | --- | --- | --- |
| `homeowner_view` | yes | required (type-enforced) | the turn's judged explanation, or the canned sentence |
| `contractor_chat` | no | footer on payment figures | judged once per turn |
| Reviewer and audit views | no | none | none |

### 12. Evaluation

Every artifact that shapes model behavior (the three prompts, the deny-list, the disclosure
template, the catalog, the calculator, the document schemas, the model ids) is versioned by
content hash, and no version advances a rollout phase (section 13) unless the sets below pass.
The deterministic sets run on every test run with no key; the model-dependent sets run before a
version advances.

| Set | Dataset | Metric | Threshold | When it runs |
| --- | --- | --- | --- | --- |
| Calculator | 5 golden cases, hand-computed: standard amortization; 0% intro paid off before the promo end; 0% intro not paid off; deferred interest triggered; deferred interest avoided | Exact match to the cent on payment, finance charge, total of payments and every schedule row | 5 of 5 | Every test run |
| Deny-list and number-match | About 10 must-block strings (verdict words and paraphrases) and about 7 must-pass strings: the rendered disclosure block, a 0% promo explanation, the out-of-scope reply, "Use $40,000 as the requested amount?", an echo of "$30K", two option descriptions with verbatim figures | Must-block all blocked; must-pass all passed | 100% on both | Every test run |
| Disclosure template | The rendered block for each of the three products | Contains APR, finance charge, amount financed, total of payments, a schedule line, the estimate statement and the RESPA line | 3 of 3 | Every test run |
| Copilot behavior | About 15 recorded conversations: adversarial prompts that must trip; benign promo explanations that must pass; payment questions whose expected outcome is a `calculate_payment` call with specific arguments; three scripted field-fill conversations with expected fills and expected non-fills (a figure mentioned in passing; a contractor stating income); the out-of-scope question | Expected tool call, expected proposals, or expected verdict per case | All cases, with any failure read before the version advances | `npm run eval`, before a copilot prompt or model version advances |
| Extraction | The 3 sample documents against `samples/ground_truth.json` | Field exact match after normalization; located rate on the image PDF | 90% field match on the text PDFs; 80% located on the image PDF, with the engineered not-located value excluded | Before an extraction prompt, schema or model version advances |
| Judge | Labeled model outputs, half containing implied approval, pressure language or uncaveated promo claims and half compliant: 20 in the prototype (`tests/eval/judge-cases.json`, run by `npm run eval:judge`), grown to at least 100 before phase 1 and by every retained blocked draft after that | Recall on the non-compliant half; false-positive rate on the compliant half | Recall at least 0.95 (at the prototype's size: at least 9 of 10); false-positive rate at most 5% (at most 1 of 10) | Before a judge prompt or model version advances; once before phase 1 |

The feedback loop: every reviewer correction becomes a labeled example in the extraction set, and
every blocked draft (both attempts are retained) becomes a labeled example in the guardrail set,
so the sets grow from production without a labeling project. The prototype runs the first three
sets in `vitest` and the copilot set through `npm run eval`; the long-form specification of the
others is planned as `docs/evals.md`, and a hosted harness (promptfoo or Braintrust) is the
production home for all of them.

### 13. Rollout, monitoring and impact

**MVP.** The copilot walkthrough on the floor tier (Detailed Implementation Plan, "Build order and
cut line") is the MVP: payment options, the homeowner view, quote-verified proposals, the
guardrail, the audit event stream. Shipping it to the first contractors is a matter of days once
the prototype's mocks are replaced by the real catalog and contractor profile clients, because
nothing in it writes to the applications table and the flag defaults off. Extraction follows as
its own phase because it needs the consumer, Textract and the JSM update.

| Phase | Who | Flag state | Length | Gate to advance | Rollback |
| --- | --- | --- | --- | --- | --- |
| 0. Internal | The AI team, Compliance, two reviewers, on seeded applications | both flags on for the internal allowlist | 1 week | Section 12 sets pass; Compliance signs off on the template, deny-list and fallback texts | Flags off |
| 1. Pilot | About 20 contractors in one region, 2 document reviewers | `copilot.enabled` for the allowlist; `extraction.enabled` for pay stubs only | 2 weeks | No guardrail false negative found in the sampled transcripts; fallback rate under 5% of turns; reviewer correction rate per field known | Flags off; the existing form and JSM ticket are the fallback |
| 2. Expansion | 10% of contractors, all three document types | `copilot.enabled` for 10%; `extraction.enabled` for all types | 4 weeks | Completion time and product-selection abandonment better for the flag-on group than the flag-off group; queue time within the reviewer SLA | Flag to the pilot allowlist |
| 3. Default on | All contractors | both flags default on; per-contractor opt-out | ongoing | Monthly review of the metrics below | Flag off per contractor or globally |

**Change management.** Contractors learn the panel exists from an in-portal announcement at the
product-selection step, a one-page guide with the three suggested prompts, and the suggested
prompts themselves, which are the onboarding device inside the panel; the support path is the
existing contractor support queue with a "copilot" tag. Reviewers get a 30-minute walkthrough of
the review view and the flag reasons; the pilot allowlist doubles as the control group for the
impact numbers.

**Monitoring.** Every metric is computed from audit events (section 3), so adding one is a query,
not an instrument.

| Metric | Source event | Owner | Alert |
| --- | --- | --- | --- |
| Deny-list hit rate, judge block rate, number-match block rate, per prompt and deny-list version | `guardrail.verdict` | AI team | Any week-over-week change above 2 points |
| Disagreement rate between checks, in both directions | `guardrail.verdict` | AI team with Compliance | Judge blocks what the list passed above 1% of turns (add terms); list blocks what the judge passed above 2% (false-positive review) |
| Regenerate-then-fallback rate; `judge_unavailable` rate | `guardrail.verdict`, `model.call` | AI team | Fallback above 5% of turns; judge unavailable above 0.5% |
| Latency p50 and p95 per step; cache read rate | `model.call`, `tool.call` | Engineering | p95 above 10 s for the explanation; cache reads at zero |
| Proposal acceptance and edit rate per form field per prompt version | `field.proposed`, `field.edited`, `field.confirmed` | AI team | Edit rate above 20% on any field |
| Reviewer confirm, correct and flag rate per document type and field; correction magnitude; source-not-located and not-extracted rate per adapter | `field.*` with `review_task_id`, `extraction.completed` | Review ops | Correction rate above 10% on a money field (the drift signal for extraction) |
| Queue time (task created, first opened, completed); needs-clarification rate and time to resolve | `review.task_created`, `field.*`, `discrepancy.*` | Review ops | Median queue time above the SLA agreed in the pilot |
| `catalog.schema_mismatch` count; `credit_engine` tool-call count | `tool.call`, error codes | Engineering with Compliance | Any value above zero |
| Token spend per application and per day | `model.call` usage | Engineering | Above twice the section 9 estimate |

**Drift and AI quality.** Drift is read from three signals, not from model output alone: the
disagreement rate between checks (a judge that starts blocking what the deny-list passes has
moved), the reviewer correction rate per field (an extraction prompt or model that starts
mis-citing shows up as corrections before anyone notices), and the eval sets in section 12 re-run
on every version change. A hallucinated figure in prose is a number-match block and is counted,
never shown. Compliance failures are the deny-list and judge blocks by category, reviewed weekly
from the retained blocked drafts.

**Impact.** The pilot allowlist is the control group. From the existing Snowflake funnel:
completion time and abandonment at the product-selection step, flag on versus flag off;
contractor adoption (contractors with at least one copilot turn per week); time from submit to
documents reviewed, flag on versus off; and reviewer minutes per application. These are the
numbers the v2 decision is made on, with the eval sets grown by the feedback loop as the quality
baseline.

## Risks and Mitigations

| Risk | Where it bites | Likelihood | Mitigation | Section |
| --- | --- | --- | --- | --- |
| Model prose implies approval or pressures the homeowner | Chat and homeowner view | Medium per turn, high over volume | Deny-list floor, judge, fail-closed fallback, retained drafts as the eval set | 6, 12 |
| A wrong calculator input yields a precise, fully disclosed, wrong payment | Options and homeowner view | Medium | Confirmed form values preferred; argument-sourced results labeled; inputs echoed; number-match on the prose | 4.1, 6 |
| An OCR misread yields a wrong but located value | Review | Low per field, steady over volume | The reviewer confirms every value; correction rate per field is monitored | 7, 13 |
| Extraction or review stalls at peak (reviewers do not scale with ECS tasks) | Review queue | High at month end | Queue time SLA with an alert; the manual path unchanged as the fallback; extraction workers scale while reviewers do not, and the design says which is the constraint | 10, 13 |
| Model deprecation or a silent behavior change on a pinned id | Every model call | Certain over a year | Exact ids pinned and stamped on events; eval sets gate any change; one SDK import site for a provider switch | 5, 12 |
| The judge shares a model family with the generator, so blind spots correlate | Guardrail | Medium | The deny-list and number-match are model-free floors; a decorrelated judge on a second provider is the named follow-up | 6, Future Improvements |
| Anthropic outage or rate limit | Copilot, extraction | Low, but total when it happens | Fail open on deterministic parts (calculator, template, form, review); fail closed on prose; extraction degrades to the manual path | 8 |
| PII in prompts and audit payloads | Audit stores, logs | Certain | Three stores with three policies; operational logs carry ids only; provider data-retention terms as a Compliance item; synthetic data in the prototype | 10, NFR |
| Unconfirmed AI output reaches the application record | Data model | Low by construction | Sidecar proposals; named commands as the only write path; submit gate; the two existing write paths | 3 |
| A regulatory wording error in the disclosure template | Homeowner view | Low, high impact | Template owned by Compliance, versioned by hash, render test, placeholder wording marked as such | 11, Open Questions |
| Production extracts at upload while the compare needs confirmed values | Extraction consumer | Medium | Review-task creation and the compare gated on status `documents_under_review` or later; absent or unconfirmed stated values defer the compare | 3, 10 |
| The grader's run fails inside five minutes | Submission | Medium | No native modules in the root install; one run command; the app starts without a key and says so; a committed extraction fixture | 8, Detailed Implementation Plan |

## Alternatives Considered

Grouped by the decision they bear on. Most entries come from the concept brief's "Alternatives
Weighed" table; E, J, K, L, M, R, AH, AI and AK were added by the author while drafting. Under
each entry, "Cons" holds the reason the alternative lost and "Decision" names what was chosen
instead.

### Scope

#### Alternative A: One angle only, the on-site quote and product explanation

*   **Pros**: The VP's $200M sentence and the contractor's kitchen quote almost verbatim; the
    cheapest angle to make convincing; both compliance rules exercised on every turn.
*   **Cons**: Leaves income verification (the other named drop-off) and manual document review
    untouched; the design document would answer only half of the stated problem.
*   **Decision**: Not rejected as the deep path of feature 1. Rejected as the whole
    submission because the sources name two drop-off steps and one delay, and one assistant across
    both is a coherent "highest-leverage problem" answer. Feature 2 is built at reduced depth after
    feature 1 and ships as design-only where unfinished.

#### Alternative B: Document extraction only

*   **Pros**: Attacks the income-verification drop-off and the manual-review delay directly; the
    clearest "staff hours saved" story.
*   **Cons**: An internal staff tool with no contractor or homeowner surface, so it does nothing
    for the product-selection drop-off or the kitchen conversation; disclosures barely apply;
    extracted income next to a loan amount is one step from an implied credit decision; needs
    synthetic documents and an accuracy eval before it can be judged.
*   **Decision**: Kept as feature 2 under human review, not as the submission.

#### Alternative C: Full conversational application (the copilot collects every field)

*   **Pros**: The only angle that speaks directly to the 22-minute-to-10-minute goal.
*   **Cons**: The speedup would come from redesigning the form, not from the model; needs the whole
    application mocked; the step that costs the most time (Plaid) would be a mock; the scope grows
    without a natural boundary.
*   **Decision**: The form stays primary. The copilot proposes only fields on a fixed
    fillable list and never the fields the decision engine consumes.

#### Alternative D: A hybrid with a slice of extraction inside the copilot

*   **Pros**: A broader story in one surface.
*   **Cons**: Two shallow halves instead of two deep paths; roughly double the build.
*   **Decision**: Depth over breadth; the two features touch only through the
    application record and the shared base.

#### Alternative E: One design document in the take-home's six-section shape (problem framing and approach; architecture; AI design decisions; compliance and safety; rollout; monitoring and impact)

*   **Pros**: No condensing pass; one artifact.
*   **Cons**: The build would run from an appendix rather than a design; the ownership table, exact
    refusal text, phase table and cost arithmetic would compete with the implementation plan for
    the same three pages.
*   **Decision**: Two documents: this internal design at full depth, and the 2 to 3
    page submission document condensed from it.

### AI design

#### Alternative F: The model computes payments

*   **Pros**: Fewer tools; a shorter loop.
*   **Cons**: A financial figure computed by a language model cannot be verified, and a wrong
    number on a disclosure is a regulatory event.
*   **Decision**: One deterministic amortization function keyed on mechanic type
    produces every payment, finance charge and total; the model explains by option label and a
    deterministic check rejects prose containing any figure not in the calculator output.

#### Alternative G: The model writes the disclosures

*   **Pros**: Disclosures tailored to the conversation.
*   **Cons**: Disclosure text must be exact and owned by Compliance; a model cannot be the source
    of record for a regulated statement.
*   **Decision**: A versioned code template renders the block; the model writes only
    the explanation, and a borrower-facing render without the template does not compile.

#### Alternative H: Fine-tuning instead of prompting

*   **Pros**: Potentially more consistent tone and format without long prompts.
*   **Cons**: No labeled corpus exists; every catalog, disclosure or policy change would need
    re-tuning that a prompt handles as data; harder to audit which version produced what.
*   **Decision**: Prompt engineering with tool calls, structured outputs and a cached
    prefix; evals gate prompt versions the way they would gate model versions.

#### Alternative I: Retrieval over the catalog in v1

*   **Pros**: Scales to large product documentation and state-specific variants.
*   **Cons**: Three products with their mechanic sentences fit in the system prompt; an index adds
    a failure mode and a stale-data risk for no v1 benefit.
*   **Decision**: Named as the v2 step (pgvector on the existing RDS Postgres over
    catalog documents, retrieved by product id and state) when terms, fine print and state
    variants outgrow the prefix.

#### Alternative J: Opus 5.5 for both the copilot and extraction

*   **Pros**: The larger model for both explanation and span selection; a single model id to pin
    and eval.
*   **Cons**: Slower per output token than Sonnet 5.5, so less headroom under the 10 s prose
    budget; cost is not the deciding factor either way.
*   **Decision**: The copilot is latency-bound and guarded by three checks, so the
    faster model is used for it.

#### Alternative K: Sonnet 5.5 for both the copilot and extraction

*   **Pros**: Most latency headroom; one model id.
*   **Cons**: Extraction runs in the background, where speed buys nothing. With positioned text
    as the only input, the job is selecting the right line and span among repeated values and
    mis-aligned columns, and citing it exactly; the larger model is expected to do that more
    reliably, which is unmeasured until the extraction eval runs.
*   **Decision**: The author's decision: extraction goes to Opus 5.5; two pins and two
    eval baselines are the accepted cost. The extraction eval (Technical Plan section 12) is the
    place to re-weigh one model id once there is a measured field-match rate for each.

#### Alternative L: Page image plus positioned text as the extraction input

*   **Pros**: The model reads values from pixels; disagreement with the OCR line is detectable and
    doubles as a drift canary; fewer wrong-but-located values.
*   **Cons**: Two code paths; about 1.5K extra input tokens per image page; a second reader to
    reason about in the eval.
*   **Decision**: The author's decision, for one code path and deterministic input.
    The reviewer is the control for OCR misreads, and the reviewer correction rate per field is
    the monitored signal instead of the two-reader disagreement this alternative would give.

#### Alternative M: Page image only, with fuzzy matching of free-text quotes

*   **Pros**: The simplest prompt; no indexed lines in the context.
*   **Cons**: The model's spelling and the OCR's rarely agree on exactly the tokens that matter, so
    the not-located rate is highest and matching is a heuristic rather than a selection.
*   **Decision**: Positioned text only, with the model selecting an indexed span.

#### Alternative N: The model returns bounding boxes

*   **Pros**: No OCR or pdf.js pipeline.
*   **Cons**: Model-returned coordinates are unverifiable and carry no provenance; reliability is
    uneven across models and document layouts.
*   **Decision**: Positioned text from the document plus quote verification gives
    exact boxes and a testable failure mode.

#### Alternative O: Anthropic document citations instead of boxes

*   **Pros**: Cheaper; no coordinate work; a page-level pointer verified by string match.
*   **Cons**: No box on the page, which this design requires for both text and image PDFs;
    citations are incompatible with structured output formats on the same request.
*   **Decision**: Not used. An unfinished box pipeline ships as design-only rather than as a
    second extraction path; the README says which.

#### Alternative P: OCR at runtime with tesseract.js

*   **Pros**: A live image path with no committed fixture.
*   **Cons**: About 15 MB on first run, 10 to 30 seconds per page on CPU, non-deterministic
    output, threatens the 5-minute rule and makes the walkthrough's values vary between runs.
*   **Decision**: Positioned text for the image sample is computed once and
    committed; AWS Textract is the production path through the same adapter shape.

#### Alternative Q: A broad deny-list ("approved", "free", "no interest")

*   **Pros**: Simple to write.
*   **Cons**: Matches the disclosure template's "subject to credit approval", "feel free to ask",
    and every honest 0% promo explanation; a regex cannot see "without the promo caveat".
*   **Decision**: Verdict terms only, with an allow-list, applied to model-written
    spans; the judge handles nuance.

#### Alternative R: Server-side model fallback on safety-classifier refusals

*   **Pros**: Fewer dead turns when the classifier declines.
*   **Cons**: The answer would come from a model id other than the pinned one, which the audit
    log and the eval baselines assume.
*   **Decision**: Refusals fail closed to the Compliance-owned fallback text, logged
    with their own error code.

### Compliance mechanisms

#### Alternative S: Proposed-value columns on the applications table

*   **Pros**: One table; simple queries.
*   **Cons**: Puts unconfirmed AI output into a row that the decision engine, the portal screens,
    Zapier rules and the Snowflake ETL read; makes "nothing unconfirmed enters the record" a
    convention rather than a property.
*   **Decision**: A sidecar proposals table, named backend commands as the only write
    path, and confirmed values arriving through the existing write paths. Rollback becomes "stop
    writing proposals".

#### Alternative T: "Needs clarification" as a new application status

*   **Pros**: Visible in every existing status filter.
*   **Cons**: A new enum value breaks portal screens, the decision-engine trigger, Zapier rules and
    the Snowflake funnel stages; two open discrepancies have no transition.
*   **Decision**: Derived from open per-value discrepancy records; the stored status
    stays "documents under review", which already blocks the decision engine.

#### Alternative U: Model-written clarification questions

*   **Pros**: Questions tailored to the specific mismatch.
*   **Cons**: The easiest implied-decision leak in the concept ("the income shown appears
    insufficient"), and the text reaches the contractor and, through them, the homeowner.
*   **Decision**: A code template per reason code, edited by the reviewer before
    sending.

#### Alternative V: The homeowner view as a panel inside the contractor layout

*   **Pros**: One screen; no navigation.
*   **Cons**: The tablet physically rotates; the homeowner would see the chat, the guardrail
    markers, the form with their own stated income, and field-state badges.
*   **Decision**: A full-screen route with no contractor chrome, large type, neutral
    option order and a "what happens next" line.

#### Alternative W: Disclosures as a paragraph

*   **Pros**: Easiest to template.
*   **Cons**: A paragraph of legal wording is skipped by readers, which defeats the purpose of a
    disclosure; "estimate" collides with the contractor's project estimate.
*   **Decision**: The TILA four-cell box per option with the schedule line beneath,
    the estimate statement under the payment figure, and "project estimate" versus "payment
    estimate" as distinct terms.

#### Alternative X: Zapier carries the review hand-off into Jira

*   **Pros**: Matches the inferred current workflow; no consumer to deploy.
*   **Cons**: The audit trail would span three systems and decision-critical data would cross a
    no-code hop.
*   **Decision**: The backend's extraction consumer updates the JSM issue today's path
    creates, and creates one only if that path is absent; Zapier or Teams carry notifications only.

#### Alternative Y: The contractor reviews extraction on their screen

*   **Pros**: Faster correction of obvious errors.
*   **Cons**: Puts internal verification data (income from a pay stub) on a borrower-adjacent
    surface with its own tone and disclosure rules.
*   **Decision**: Review stays with internal staff; the contractor sees only the
    derived banner and the templated question.

#### Alternative Z: Rendering the mocked decision engine's answer

*   **Pros**: A complete-looking demo.
*   **Cons**: Any rendering invites "the AI said" wording and puts a decision-engine mock one
    refactor away from a screen.
*   **Decision**: The walkthrough ends at "submitted, documents under review"; the
    decision engine interface has no method any UI code calls.

### Review and data

#### Alternative AA: Exact-match discrepancy detection

*   **Pros**: No tolerance table to own.
*   **Cons**: Every pay stub would flag ($84,760 annualized versus $85,000 stated); every
    application enters "needs clarification"; feature 2 becomes slower than today.
*   **Decision**: Two rules in the prototype (income plus or minus 10% or $5,000;
    requested amount more than 5% above the project estimate); a per-field table owned by
    Compliance and Credit Ops as v2.

#### Alternative AB: Three hand-written extraction pipelines

*   **Pros**: Each tuned to its document.
*   **Cons**: A fourth document type (bank statement, W-2) would be a five-file change across four
    owners; one generic reviewer panel is less work than three hand-written ones.
*   **Decision**: One declarative schema per document type drives the prompt,
    validation, reviewer panel, tolerance and routing.

#### Alternative AC: A review task per document

*   **Pros**: Smaller units of work.
*   **Cons**: The discrepancy check needs all three documents plus the stated values; per-document
    tasks would compare against values that are not yet confirmed.
*   **Decision**: One task per application with a tab per document.

#### Alternative AD: A view-first audit timeline in the prototype

*   **Pros**: The most direct answer to the Head of Compliance; re-renders the homeowner view from
    the stored event.
*   **Cons**: About an hour of UI on a page no contractor or homeowner uses, taken from the two
    views they do use.
*   **Decision**: The collapsible JSON page ships; the timeline is described as the
    intended view, and the homeowner view is a pure function of its props so the re-render stays
    possible.

### Prototype and stack

#### Alternative AE: CLI chat instead of a web UI

*   **Pros**: Fastest to build.
*   **Cons**: Cannot show a homeowner view, disclosures beside the figures they qualify, or a
    document with boxes, which are the surfaces the product is about.
*   **Decision**: A React web app with three role tabs served by the Node backend.

#### Alternative AF: Next.js

*   **Pros**: One framework for API and UI.
*   **Cons**: Server rendering and pdf.js conflict (pdf.js needs browser globals), which costs
    setup the build window does not have.
*   **Decision**: Vite plus Express, served from one process.

#### Alternative AG: Mock HTTP servers per financial service

*   **Pros**: Looks like real integration.
*   **Cons**: More processes to start inside the 5-minute rule, for no behavior the in-process
    mocks lack.
*   **Decision**: In-process mocks behind typed interfaces with a composition root,
    a `_mock` envelope on every response, and MOCK and LIVE badges in the audit view.

#### Alternative AH: A plain request-response for copilot turns

*   **Pros**: Simpler client; no event stream.
*   **Cons**: The options table could not render before the prose and the judge finish, which
    breaks the 3-second budget and removes the stepwise status line.
*   **Decision**: A streamed response of newline-delimited JSON lines (`status`,
    `options`, `proposals`, `explanation` or `fallback`, `done`); token-level streaming of prose
    is described only, because the judge runs on finished text. Server-sent events framing was
    also weighed and dropped: once a POST body rules out `EventSource`, SSE needs a hand-rolled
    parser on the client and buys nothing over one JSON object per line.

#### Alternative AI: A multi-provider abstraction

*   **Pros**: Easy switch to OpenAI, already in GoodLeap's stack.
*   **Cons**: Speculative; an abstraction with one implementation.
*   **Decision**: One SDK import site makes a later switch a one-module change; the
    abstraction is built when a second provider is in use.

#### Alternative AJ: A third-party eval framework in the prototype

*   **Pros**: Reports, datasets and comparisons out of the box.
*   **Cons**: An additional dependency and its configuration, for more setup than a vitest file
    and a JSON fixture within the build window.
*   **Decision**: Hand-rolled tests and an `npm run eval` fixture; promptfoo or
    Braintrust named as the production harness.

#### Alternative AK: A hosted deployment

*   **Pros**: A link for the grader.
*   **Cons**: Exposes an LLM key to the internet for no required benefit; the local run is the
    requirement.
*   **Decision**: Local run only; deployment on the existing stack is described in the
    Technical Plan.

## Open Questions

*   **Confidentiality of the submission repository.** The take-home PDF is marked Confidential.
    The PDF and its transcription stay uncommitted; repository visibility is a recruiter question.
*   **Final disclosure wording.** TILA elements, the estimate statement and the conditional RESPA
    line are placeholders in a versioned template whose header names Compliance as owner. Whether
    RESPA applies to a given loan (secured by the home or not) is a Compliance decision.
*   **Tolerance defaults.** Income plus or minus 10% or $5,000 (whichever is larger) and the
    requested loan amount more than 5% above the project estimate are placeholders owned by
    Compliance and Credit Ops.
*   **Today's review workflow.** The design assumes document review runs through Jira Service
    Management fed by SQS. If it does not, the extraction consumer (Technical Plan section 10)
    attaches to whatever creates today's review task; the design of the consumer does not change.
*   **Plaid precedence.** The design treats Plaid as the first income source and documents as the
    path for abandoned Plaid connections. If both exist for one application, they are two extracted
    sources compared under the same per-field tolerance (Technical Plan 4.5) with the reviewer
    resolving conflicts; the exact precedence is for Credit Ops to confirm.
*   **The manual-review provenance column.** The design assumes the applications table already
    records how an income value was verified (written here as `verification_source =
    document_review`, Technical Plan section 3) and that the manual-review confirmation endpoint
    sets it. If the column or the endpoint has another name, the review confirmation path writes
    through that instead; the design does not change.

## Non-Functional Requirements

*   **Security and privacy.** The Anthropic key lives server-side only (`.env`, never shipped to
    the browser; Secrets Manager in production). The sample documents are synthetic with no SSN,
    and no schema field requests one. The audit JSONL and `data/` are git-ignored. Operational logs
    print ids and event types only. Production splits audit content, operational logs and metrics
    into three stores with the retention and access policies in Technical Plan section 10, and
    names the provider's data-retention terms as a Compliance item.
*   **Performance and latency.** The budget in Technical Plan section 9. The cached prefix keeps
    fresh input tokens per turn around 2K; `cache_read_input_tokens` is recorded on every model
    call so a cache miss is visible. The prototype's in-memory store and single process are
    sufficient for one grader; the production shape is stateless ECS tasks over RDS.
*   **Rollout and rollback.** The phases, gates and rollback per phase are in Technical Plan
    section 13; the flags and the no-migration rollback are in section 10.
*   **Compatibility.** The unchanged systems, the new tables and the in-flight rule are in
    Technical Plan sections 1 and 10.

## Additional Resources

*   [Concept brief](loan-assistant-concept.md) and its
    [review findings](loan-assistant-concept-goldfish-findings.md)
*   [PRD](../PRD.md) with the sources and the rubric
*   Anthropic's API documentation as of October 2026 (model ids and pricing, prompt caching,
    structured outputs, tool-use rules for the Sonnet 5.5 and Opus 5.5 families), on which the
    model choices and the cost arithmetic rest

## Future Improvements

*   **View-first audit timeline** that re-renders each homeowner view from its stored event and
    walks the provenance chain, with a "borrower-facing only" filter.
*   **Per-field tolerance table** owned by Compliance and Credit Ops, versioned, replacing the two
    prototype rules; name and employer matching by normalized token overlap; pay-period recency.
*   **Textract adapter** producing the same `PositionedText` shape from WORD blocks, and the
    source-not-located rate per adapter as a monitored metric.
*   **Retrieval** over product terms, promo fine print and state-specific disclosure variants on
    pgvector when they outgrow the prefix.
*   **Token-level streaming** of the explanation with the deny-list applied as tokens arrive and
    the judge on the final text.
*   **A fourth document type** (bank statement or W-2) as a schema file, a sample and an eval set,
    to prove the schema-driven pipeline.
*   **Plaid as a second extracted source** compared under the same per-field rule.
*   **A decorrelated judge** on OpenAI (already in the stack) through the single SDK import site.

## Detailed Implementation Plan

Mechanical choices made here, not left to the implementer:

*   Node 22 (`.nvmrc`), npm, ES modules throughout, TypeScript strict, one root `package.json`
    with no workspaces. `web/` is the Vite root; `server/` runs with `tsx`; `shared/` holds the
    zod schemas, the application and document schemas, the formatters and the text normalizer,
    imported by both sides through a `@shared/*` path alias; vitest runs the tests.
*   The one-time sample-generation scripts live in `scripts/samples/` with their own
    `package.json` and `tsconfig.json`, so the root install and type-check never touch
    tesseract.js or a canvas binary. The author runs them once, before step 1 of the build order,
    and commits their outputs; the grader never runs them.
*   `npm start` builds the web app and starts one server process that serves `dist/web` and
    `/api` on `PORT` (default 3000). `npm run dev` runs Vite and `tsx watch` side by side for
    development only; the README never mentions it.
*   The copilot uses a manual tool loop over `client.messages.create` rather than the SDK's
    tool-runner helper, which is a beta API; the manual loop uses only the stable messages
    endpoint, and each model call and tool result becomes an audit event between iterations.
    Extraction and the judge use `client.messages.parse` with `zodOutputFormat`. `tool_choice` is
    `auto` with `strict: true` on every tool and the prompt naming the tool to call. No `thinking`
    parameter is sent on any call; `output_config.effort` alone governs reasoning depth.
*   Contractor-typed form values are server state: the form posts each edit to the fields route,
    which calls the `setFieldValue` command. Nothing travels with a copilot turn except the text.
*   Naming: wire, audit and schema field names are snake_case; TypeScript identifiers are
    camelCase; command option objects use the schema's snake_case names. Money is integer cents;
    APR is integer basis points; `formatMoney` always prints two decimals with a thousands
    separator (`$30,000.00`) and `formatApr` prints two decimals (`9.99%`); the echoed inputs use
    the same formatters.
*   Ids: the demo application is `app_demo_001`, the demo contractor `ctr_demo_001`, the demo
    reviewer `rev_demo_001`. `session_id` is a UUID the client generates once per page load and
    sends as the `x-session-id` header on every write; the server stamps it on every event.
*   Pages are 1-based; lines and tokens are 0-based; `token_end` is exclusive; the `|` column
    separator in indexed lines is not a token.

### Fixed texts (Compliance-owned placeholders)

Every string below is exported from `server/guardrail/fallback.ts` (items 38) or the disclosure
template (item 32) and is the single source for prompts, tests and the submission document.

| Name | Text |
| --- | --- |
| `OUT_OF_SCOPE_REPLY` | "Approval decisions are made by GoodLeap's credit team after the application is submitted, so I can't say whether this application will be approved." followed by the two action offers `OUT_OF_SCOPE_ACTIONS`: "Show payment options for this project" and "List what the application still needs". |
| `FALLBACK_REPLY` | "I can't phrase that in a way that meets lending rules. The payment options above are accurate and include the required disclosures. I can show them to the homeowner, explain how a promotional period works, or list what the application still needs." |
| `FALLBACK_MARKER` | "Wording adjusted to comply with lending rules. View in audit" |
| `CHAT_FOOTER` | "Estimates only. Not an offer of credit; subject to credit approval." |
| `ESTIMATE_STATEMENT` | "This is a payment estimate, not an offer of credit; final terms depend on credit approval." |
| `RESPA_LINE` | "If this loan is secured by your home, a settlement cost statement will be provided." |
| `WHAT_HAPPENS_NEXT` | "Nothing is decided today. The application goes to GoodLeap for review, and the final terms come in writing before anything is signed." |
| `SCHEDULE_LINE` | "{count} monthly payments of {payment}" for `fixed`; "{promo_count} monthly payments of {promo_payment}, then {count} monthly payments of {payment}" for the other two mechanics. |
| `FIXED_SENTENCE_FOR_TERM` | "Option A is a fixed-rate loan: the same payment every month for {term}." with {term} as "N years" for a whole number of years, else "N months"; used in place of the fixed product's `plain_sentence` and `CANNED_SENTENCE` whenever the option's term differs from the catalog term (a `term_months` override). |
| `CANNED_SENTENCE[product_id]` | `fixed_10y`: "Option A is a fixed-rate loan: the same payment every month for ten years." `zero_intro_18m`: "Option B charges no interest for the first 18 months; after that, interest applies to what is still owed." `deferred_12m`: "Option C charges no interest if the full balance is paid within 12 months; if it is not, interest from the start date is added." |
| `CLARIFICATION_TEMPLATE[income_outside_tolerance]` | "The application lists an annual income of {stated}. The pay stub we received works out to {extracted} a year. Could you ask the homeowner whether the application figure includes other income, and let us know?" |
| `CLARIFICATION_TEMPLATE[requested_amount_over_estimate]` | "The application requests {stated}. The project estimate we received totals {extracted}. Could you confirm the amount the homeowner wants to finance?" |
| `BANNER_TEXT` | "Needs clarification: a reviewer found a difference between a document and the application and has sent a question. No decision has been made." |
| `NOT_LOCATED_CAPTION` | "The value was extracted but its position on the page could not be matched. Find it on the page to confirm, correct it, or flag it." |
| `LOCATED_ACK` | "I located this on the page myself" |
| `NO_MODEL_CAPTION` | "Confirm a requested loan amount first" |
| `STATUS_STEPS` | "Finding matching products...", "Calculating payments...", "Writing the explanation...", "Checking wording..." |
| `LIKELIHOOD_WORDS` | likely, unlikely, probably, chance, odds, should be fine, looks good, good shot, easily |

### Target Files to Create/Modify

#### Root and configuration

##### 1. `package.json` (Create)

*   **Layer / kind**: Build configuration.
*   **Proposed Changes**: `"type": "module"`, `engines.node >=22`. Dependencies, majors pinned:
    `@anthropic-ai/sdk` (current), `express@^5`, `zod@^3`, `react@^18`, `react-dom@^18`,
    `react-router-dom@^6`, `react-pdf@^9`, and `pdfjs-dist` pinned to the exact version that the
    installed `react-pdf` depends on (read from its `package.json` at setup; one copy in
    `node_modules`). Dev: `typescript@^5`, `tsx`, `vite@^5`, `@vitejs/plugin-react`, `vitest@^2`,
    `concurrently`, `@types/express@^5`, `@types/react`, `@types/react-dom`, `@types/node`. No
    native or binary modules. Scripts: `start` (`vite build && tsx server/index.ts`), `dev`
    (`concurrently "vite" "tsx watch server/index.ts"`), `build` (`tsc --noEmit -p
    tsconfig.server.json && tsc --noEmit -p tsconfig.web.json && vite build`), `test` (`vitest
    run`), `eval` (`tsx scripts/eval.ts`), `eval:judge` (`tsx scripts/eval.ts --judge`),
    `smoke:api` (`tsx scripts/smoke-api.ts`).
*   **Tested by**: the Verification Plan's build gate.

##### 2. `tsconfig.json`, `tsconfig.server.json`, `tsconfig.web.json` (Create)

*   **Layer / kind**: TypeScript configuration.
*   **Proposed Changes**: Base config with `strict`, `moduleResolution: bundler`, `paths` for
    `@shared/*` to `shared/*`. Server config targets Node 22 ESM and includes `server/`,
    `shared/`, `tests/` and `scripts/*.ts`, and excludes `scripts/samples/**`. Web config includes
    `web/src` and `shared/` with JSX.

##### 3. `vite.config.ts` (Create)

*   **Layer / kind**: Frontend build.
*   **Proposed Changes**: `root: "web"`, `build.outDir: "../dist/web"`, `build.emptyOutDir: true`,
    React plugin, the `@shared` alias, dev-server proxy for `/api` to
    `http://localhost:${process.env.PORT ?? 3000}`.

##### 4. `vitest.config.ts` and `tests/setup.ts` (Create)

*   **Layer / kind**: Test configuration.
*   **Proposed Changes**: Node environment, `tests/**/*.test.ts`, the `@shared` alias, and
    `setupFiles: ["tests/setup.ts"]`, which loads `.env` the same way item 13 does (overriding
    the shell) so a test that needs `ANTHROPIC_API_KEY` finds it; such a test skips with a
    printed reason when the variable is absent.

##### 5. `.env.example` (Create)

*   **Layer / kind**: Configuration template.
*   **Proposed Changes**: `ANTHROPIC_API_KEY=` (blank, with a comment naming where to get one),
    `PORT=3000`, `COPILOT_ENABLED=true`, `EXTRACTION_ENABLED=true`, and `ANTHROPIC_BASE_URL=`
    (blank by default; set to `https://openrouter.ai/api/v1` to use an OpenRouter key). No other
    variables exist.

##### 6. `.nvmrc` (Create)

*   **Layer / kind**: Node version pin.
*   **Proposed Changes**: `22`.

##### 7. `.gitignore` (Modify)

*   **Layer / kind**: Repository hygiene.
*   **Proposed Changes**: Add `node_modules/`, `dist/`, `data/`, `.env`.

##### 8. `README.md` (Modify)

*   **Layer / kind**: Required deliverable.
*   **Proposed Changes**: Keep the problem summary and the hard constraints. Replace the status
    section and the "Planned deliverables" table with: what it is (two paragraphs); "Run in 5
    minutes" (`npm install`, `cp .env.example .env` and set the key, `npm start`; what you see
    without a key); "Demo walkthrough" (CUJs 1 to 7 as numbered steps with the exact text to
    type, including the adversarial message and "Will she be approved?", when to switch tabs,
    and the pay stub's net pay value, not located because its OCR words carry no geometry);
    architecture in one diagram and one paragraph per feature; "Built versus described" (from the
    build order and cut line below); the kill switches; where the audit file is; the test and
    eval commands; a line that `scripts/samples/` is one-time tooling with its own install,
    already run; links to the design documents. Update the "Repository layout" tree to the built
    tree. The only run command the README gives is `npm start`. State that the sample documents
    are synthetic and that the author produced the pay stub's positioned text once by a script.

#### Shared (`shared/`)

##### 9. `shared/schemas.ts` (Create)

*   **Layer / kind**: Shared schema module: zod schemas and their inferred types, the single
    source of truth for every runtime shape.
*   **Proposed Changes**: The data model from Technical Plan section 3 as zod schemas with
    `z.infer` types exported beside them (the `Schema` suffix on the const, the bare name on the
    type: `DisclosureBlockSchema` and `DisclosureBlock`):
    *   `Application` (`status`: `draft | documents_under_review | documents_reviewed`;
        `fields` keyed by field id holding `{ value, state: "typed" | "confirmed" | "edited",
        source_ref }`; `verified` with `verified_annual_income` and `verification_source`),
        `ProposedValue`, `ProposalSource` (`message` `{ message_id }`; `box` `{ document_id, page:
        number | null, bbox: Box | null, words: PositionedWord[], quoted_text: string }`; `formula`
        `{ formula, inputs: proposal ids }`), `MatchResult` (`method`: `exact | normalized |
        not_located | not_extracted`; `rejected_pointer?: boolean`), `DiscrepancyRecord` (with
        `sent_at?`), `ReviewTask` (`status`: `ready | in_review | complete | extraction_failed`;
        `created_at`), `DocumentRecord` (`extraction_status`: `pending | done | failed |
        type_mismatch | manual`; `adapter`: `pdfjs | ocr_fixture`), `DocumentSlot`,
        `OptionsRecord` (`inputs_source: { amount: "form" | "argument", term: "form" | "argument"
        | "catalog" }`), `PaymentOption` (`label` "Option A" to "Option C" by catalog order,
        `product_id`, `product_name`, `mechanic`, `term_months`, `apr_bps`, `payment_cents`,
        `promo_payment_cents?`, `promo_months?`, `finance_charge_cents`, `amount_financed_cents`,
        `total_of_payments_cents`, `schedule` rows, `consequence?` with `interest_added_cents`,
        `payment_cents`, `total_cents`), `CalculatorResult`, `DisclosureBlock`,
        `HomeownerViewProps` (`options`, `disclosure_block`, `explanation`, `mechanic_sentences`
        by product id, `what_happens_next`, `template_version`), `Surface`, `Verdict` (`pass`,
        `layer`, `outcome: "pass" | "blocked" | "judge_unavailable"`, `reason?`, `matched?`),
        `GuardrailAllowed` (`calculator_values: string[]`, `contractor_figures: string[]`),
        `VersionsBlock` (the nine keys of item 15 plus `git_sha` and the three model ids),
        `ErrorCode` (`llm.missing_key`, `llm.auth_failed`, `llm.timeout`, `llm.rate_limited`,
        `llm.server_error`, `llm.refusal`, `llm.schema_invalid`, `guardrail.judge_unavailable`,
        `catalog.unavailable`, `catalog.schema_mismatch`, `extraction.source_not_located`,
        `extraction.document_type_mismatch`, `extraction.no_text_layer`, `copilot.disabled`, `internal`).
    *   `AuditEvent`: a `z.discriminatedUnion` on `type` with the base fields merged in
        (`schema_version: 1`), every type from Technical Plan section 3 including
        `message.received`, `review.task_created`, `discrepancy.sent`, and `model.call` with
        `raw_input` and `_fixture?: boolean`; `tool.call.service` is the enum `catalog |
        credit_engine | plaid | contractor_profile | documents | review_queue | calculator`; each
        payload field annotated with its PII class through `.describe()`.
    *   The turn stream line union: `status { step: string }`, `options { options_id,
        calculator_result, inputs_echo: string, inputs_source, argument_label: string | null,
        disclosure_block, footer: string }`, `proposals { proposals: ProposedValue[], note:
        string | null }`, `explanation { text, question: string | null, footer: string | null, event_ids: string[] }`,
        `fallback { text, marker, audit_event_id }`, `error { code, message, retryable }`,
        `done { event_ids: string[] }`.
    *   Route bodies and responses: `TurnRequest { text }`, `FieldEditRequest { value }`,
        `ProposalRejectRequest { reason_code: "dismissed_by_contractor" }`, `HomeownerViewRequest
        { options_id }`, `DiscrepancyReplyRequest { text }`, `DecisionRequest { action: "confirm"
        | "correct" | "flag", value?, reason_code?, note?, located_by_reviewer? }`,
        `DiscrepancySendRequest { text }`, `DiscrepancyResolveRequest { resolution: "explained" |
        "corrected", note }`, `AuditResponse { events, credit_engine_calls: number }`, and
        `HealthResponse { has_llm_key, copilot_enabled, extraction_enabled, versions }`.
*   **Tested by**: every suite that constructs these shapes; item 17's validation.

##### 10. `shared/application-schema.ts` and `shared/catalog-ids.ts` (Create)

*   **Layer / kind**: Shared declarative schema.
*   **Proposed Changes**: `catalog-ids.ts` exports `PRODUCT_IDS = ["fixed_10y", "zero_intro_18m",
    "deferred_12m"]`, read by both the schema and item 30. `application-schema.ts` exports one
    array of fields with `id`, `label`, `type` (`text | money | integer | enum | zip`),
    `options?`, `required`, `copilotFillable`, `decisionEngineInput`:

    | id | type | required | fillable | notes |
    | --- | --- | --- | --- | --- |
    | `project_type` | enum: roofing, solar, hvac, windows_doors, kitchen_bath, other | yes | yes | |
    | `project_description` | text | no | yes | |
    | `project_amount` | money | yes | yes | |
    | `requested_loan_amount` | money | yes | yes | the calculator's amount |
    | `preferred_term_months` | enum: 60, 120, 180, 240 | no | yes | |
    | `selected_product_id` | enum: `PRODUCT_IDS` | no | yes | |
    | `homeowner_first_name` | text | yes | yes | |
    | `homeowner_last_name` | text | yes | yes | |
    | `property_zip` | zip | yes | yes | |
    | `stated_annual_income` | money | yes | no | decision-engine input |
    | `employer_name` | text | no | no | decision-engine input |
    | `employment_status` | enum: employed, self_employed, retired, other | no | no | decision-engine input |

    Helpers `fillableFields()`, `requiredFields()` and `zodForField(id)` (parses a string into
    the field's type: money strings such as "$30K", "30,000" and "30000.00" to cents).
*   **Tested by**: items 77 and 80.

##### 11. `shared/document-schemas/index.ts`, `shared/document-schemas/pay_stub.ts`, `shared/document-schemas/estimate.ts`, `shared/document-schemas/scope_letter.ts`, `shared/reason-codes.ts` (Create)

*   **Layer / kind**: Shared declarative extraction schemas and reason-code enums.
*   **Proposed Changes**: `reason-codes.ts` (Floor tier, imported by commands) exports
    `FlagReason` (`illegible`, `source_not_located`, `mismatch_with_stated`, `wrong_document_type`,
    `missing`, `pay_frequency_not_located`, `other`), `DiscrepancyReason`
    (`income_outside_tolerance`, `requested_amount_over_estimate`) and `ContractorRejectReason`
    (`dismissed_by_contractor`). Each document schema: `slot`, `title`, a one-line description
    used for the slot-match check, and `fields` with `id`, `label`, `type` (`money | date | text |
    enum | integer`), `description` (what the model should look for), `compareTo?` (application
    field id), `tolerance?`, `discrepancy_reason?`, and `derived?` (`{ formula:
    "annualized_income", inputs }`, resolved to one named function in `server/review/derived.ts`).
    Field ids: pay stub `employer_name, pay_period_start, pay_period_end, pay_frequency (enum
    weekly, biweekly, semimonthly, monthly), gross_pay, net_pay, ytd_gross` and derived
    `annualized_income` (`compareTo: stated_annual_income`, tolerance `{ kind:
    "percent_or_absolute", percent: 10, absolute: 500000 }`, reason `income_outside_tolerance`);
    estimate `contractor_name, project_description, estimate_date, total_amount (compareTo:
    requested_loan_amount, tolerance { kind: "percent_over", percent: 5 }, reason
    requested_amount_over_estimate), line_item_count`; scope letter `property_address,
    scope_summary, start_date, contractor_name`. Document proposals use `field_key =
    "<slot>.<field_id>"`, so same-named fields in two documents never collide. `index.ts` exports
    `schemaForSlot()` and the enum normalization map applied after location (`"Bi-Weekly"`,
    `"biweekly"`, `"every two weeks"` to `biweekly`, and the equivalents for the other three
    values; dates parsed from `MM/DD/YYYY` and `Month D, YYYY`).
*   **Tested by**: items 78 and 79.

##### 12. `shared/format.ts` and `shared/normalize.ts` (Create)

*   **Layer / kind**: Shared pure functions.
*   **Proposed Changes**: `format.ts`: `formatMoney(cents)` and `formatApr(bps)` as the only
    formatters, with the rules in the preamble; `parseMoney(text)` as the inverse used by
    `zodForField`. `normalize.ts`: `normalizeToken(s)` (lowercase; drop `$` and `,`; strip
    punctuation except `.` `/` `-` inside numbers and dates; fold `O` to `0` and `l` to `1` inside
    numeric tokens), `normalizeText(s)` (tokenize on whitespace, normalize each token, join
    hyphenated line breaks, collapse whitespace), `isNumericToken(s)`, and `figureTokens(s)` (every
    currency, percent, and integer-followed-by-`month(s)`/`year(s)` token in a string, normalized).
    Used by the copilot quote check, the number-match check and the extraction matcher; nothing
    else defines a normalization rule.
*   **Tested by**: item 78.

#### Server (`server/`)

##### 13. `server/index.ts` (Create)

*   **Layer / kind**: Process entry.
*   **Proposed Changes**: load `.env` when it exists by parsing it with `util.parseEnv` and
    assigning every entry into `process.env`, overriding variables the shell already exports (a
    stale `ANTHROPIC_BASE_URL` in a developer's shell must not silently redirect the key; the
    rule is stated in `.env.example`); `mkdirSync("data", { recursive: true })`; open
    `data/audit.jsonl` truncated (the store is in memory and reseeded at every boot, so a file
    kept from the last run would attach that run's events to the freshly seeded application
    id; production uses the INSERT-only table of section 10); build the composition root; seed the store; mount the API; if `dist/web`
    exists, serve it with `express.static` and the history fallback `app.get("/{*splat}", ...)`
    (Express 5 syntax); start on `PORT`. Log the versions block and whether a key is present
    (never the key) at boot.

##### 14. `server/config.ts` (Create)

*   **Layer / kind**: Server configuration.
*   **Proposed Changes**: Reads the five variables with defaults (`PORT` 3000; both flags true
    when absent; `ANTHROPIC_BASE_URL` unset); exposes `hasLlmKey`, `llmBaseUrl`, `copilotEnabled`,
    `extractionEnabled`, and the effective model ids: the plain pinned ids, or, when the base URL
    contains `openrouter.ai`, the OpenRouter forms `anthropic/claude-sonnet-5.5`,
    `anthropic/claude-opus-5.5`, `anthropic/claude-haiku-5.5`. Per use case, the
    pinned model id, effort, `max_tokens` and SDK options: copilot `claude-sonnet-5-5`, `low`,
    4096, `{ timeout: 15_000, maxRetries: 0 }`; extraction `claude-opus-5-5`, `medium`, 4096,
    `{ timeout: 60_000, maxRetries: 1 }`; judge `claude-haiku-5-5`, `low`, 1024, `{ timeout:
    15_000, maxRetries: 0 }`. The copilot loop's round cap is 3.

##### 15. `server/versions.ts` (Create)

*   **Layer / kind**: Versions block.
*   **Proposed Changes**: At boot, sha256 each of nine files and expose `VERSIONS` with keys
    `copilot_prompt`, `judge_prompt`, `extraction_prompt`, `denylist`, `template`, `catalog`,
    `calculator`, `application_schema`, `schemas` (the document schema files concatenated in slot
    order), each `<name>@<first 8 hex>`, or `<name>@absent` when the file does not exist yet (so
    the floor boots before the F2 files exist); plus `fallback_texts` for item 38, `git_sha` (from
    `git rev-parse HEAD` if available, else `unknown`), and the three model ids. These hashes are
    the only content versions in the system; the catalog's `schema_version` (item 30) is a shape
    version checked by the calculator and is not part of the versions block.

##### 16. `server/errors.ts` (Create)

*   **Layer / kind**: Error taxonomy.
*   **Proposed Changes**: `AppError` carrying an `ErrorCode`, the user-facing message from the
    table in Technical Plan section 8, and `retryable`. `mapSdkError(err)` checked most specific
    first:

    | SDK error | Code | Retryable |
    | --- | --- | --- |
    | `Anthropic.AuthenticationError` | `llm.auth_failed` | no |
    | `Anthropic.RateLimitError` | `llm.rate_limited` | yes |
    | `Anthropic.APIConnectionTimeoutError` | `llm.timeout` | yes |
    | `Anthropic.APIConnectionError` | `llm.timeout` | yes |
    | `Anthropic.APIError` (any other status) | `llm.server_error` | yes |
    | anything else | `internal` | no |

*   **Tested by**: item 77 (the `internal` wrap).

##### 17. `server/audit-log.ts` (Create)

*   **Layer / kind**: Audit event stream.
*   **Proposed Changes**: `createAuditLog(sink)` where `sink` is `{ appendLine(json) }` (a file
    sink writing `data/audit.jsonl` in the server; a memory sink in tests). `append(event)` fills
    `event_id`, `seq`, `ts`, `versions` and `schema_version: 1`, validates against
    `AuditEventSchema`, pushes to memory and calls the sink. `list(applicationId)` returns events
    in `seq` order. `countToolCalls(applicationId, service)` counts `tool.call` events for one
    service; the audit page shows it for `credit_engine`, which nothing emits, so it reads zero.
    `reset()` clears memory and truncates the file. No update or delete.
*   **Tested by**: item 77.

##### 18. `server/store.ts` (Create)

*   **Layer / kind**: In-memory state.
*   **Proposed Changes**: Maps for applications, proposals, discrepancies, review tasks,
    documents, transcripts (messages with ids per application), and options records.
    `loadSeed()` and `reset()` are the only writers outside `commands.ts`; every other mutation of
    any map happens in a command. Read helpers for everything else. Nothing is written to disk
    except the audit JSONL; state lives for the process lifetime, which is why the grader's run
    command does not use watch mode.

##### 19. `server/commands.ts` (Create)

*   **Layer / kind**: The only write path.
*   **Proposed Changes**: Every command takes `ctx: { application_id, session_id, turn_id?,
    parent_event_id?, actor }`, validates the state transition (the invariants in Technical Plan
    section 3), mutates the store, and appends one primary audit event, plus one
    `application.state_changed` when it changes the status. Commands are pure transitions: none
    calls the discrepancy engine, the extraction queue, a service or another module above the
    store.
    *   Form values: `setFieldValue(ctx, field_key, value)` writes `fields[key] = { value, state:
        "typed", source_ref: null }` on an application in `draft` and emits `field.confirmed`
        with `source: "typed"`; a typed value counts as confirmed for every rule that reads
        confirmed fields.
    *   Proposals: `proposeFieldValue(ctx, { field_key, value, source })`: drops and emits
        `field.proposed` with `dropped_reason: "equals_confirmed"` when the normalized value
        equals the field's current typed or confirmed value; never overwrites a typed value;
        supersedes a prior `proposed` proposal for the same `field_key` and source kind (and, for
        `source.kind: "formula"` only, a prior `confirmed` one). `confirmValue(ctx, proposal_id, {
        located_by_reviewer?, review_task_id? })` throws when no live proposal exists, requires
        `located_by_reviewer: true` on a `not_located` proposal, and writes to the application
        only in two cases: a contractor-side confirmation (no task id) writes `fields[key]` with
        state `confirmed`; the system's confirmation of `pay_stub.annualized_income` writes
        `verified.verified_annual_income` and `verification_source = "document_review"`. Every
        other reviewer-side confirmation writes review data only and never a `stated_*` field.
        `editValue(ctx, proposal_id, value, { review_task_id? })` emits `field.edited` with before
        and after; `edited` is terminal. `rejectValue(ctx, proposal_id, reason_code, { note?,
        review_task_id? })` takes a `FlagReason` or `ContractorRejectReason`.
    *   Transcript and options: `appendMessage(ctx, text)` assigns the message id and emits
        `message.received`; `storeOptions(ctx, record)` and `attachExplanation(ctx, options_id,
        text)`.
    *   Submission: `submitApplication(ctx)` throws with the pending count when any proposal is
        `proposed`, throws naming the field when a `requiredFields()` entry is empty, sets
        `documents_under_review`, calls no service, and returns the attached document ids.
        `attachDocument(ctx, slot, file_ref, adapter)` is the only emitter of `document.attached`.
        `setExtractionStatus(ctx, document_id, status)`.
    *   Review: `createReviewTask(ctx, { document_ids, jsm_issue_id })` emits
        `review.task_created`; `startReview(ctx, task_id)` moves `ready` to `in_review`;
        `completeReview(ctx, task_id)` requires that no proposal of the task is `proposed`, sets
        the task `complete`, the application `documents_reviewed`, and emits `review.completed`.
        `raiseDiscrepancy`, `sendDiscrepancyQuestion(ctx, record_id, text)` (sets `sent_at`,
        emits `discrepancy.sent`), `replyToDiscrepancy`, `resolveDiscrepancy(ctx, record_id, {
        resolution, note })`.
*   **Tested by**: item 77.

##### 20. `server/api/index.ts` (Create)

*   **Layer / kind**: Express router.
*   **Proposed Changes**: Mounts the route modules below plus `GET /api/healthz` (returns
    `HealthResponse`) and `POST /api/reset` (store `reset()` plus audit `reset()`, then
    `loadSeed()`). Reads `x-session-id` into `ctx`. The error handler maps an `AppError` to `{
    code, message, retryable }` and anything else to `internal`; Express 5 routes rejected
    promises to it without a wrapper.

##### 21a. `server/api/applications.ts` (Create)

*   **Layer / kind**: Routes, floor tier.
*   **Proposed Changes**: Full paths. `GET /api/applications/:id` (the application with
    proposals merged as `{ value, state, source_ref }` per field, plus `banner` computed by
    `deriveBanner` from item 48a). `POST /api/applications/:id/fields/:fieldKey` with
    `FieldEditRequest`, calling `setFieldValue`. `POST /api/applications/:id/proposals/:pid/confirm`
    and `/reject` (`ProposalRejectRequest`). `POST /api/applications/:id/confirm-all`. `POST
    /api/applications/:id/load-demo`: calls `setFieldValue` for `project_type: roofing`,
    `project_amount: 3000000`, `requested_loan_amount: 3000000`, `stated_annual_income: 8500000`,
    then `attachDocument` three times with the slots and the sample files from `samples/`. `POST
    /api/applications/:id/homeowner-view` (`HomeownerViewRequest`): loads the Options record,
    substitutes `CANNED_SENTENCE` for a missing explanation, calls `composeHomeownerView`, appends
    `view.rendered` with `produced_by` = every event id of the record's turn (or the button's own
    `tool.call` id), returns the props. `POST /api/applications/:id/discrepancies/:did/reply`
    (`DiscrepancyReplyRequest`). `GET /api/applications/:id/audit` returns `AuditResponse` with
    `credit_engine_calls` from `countToolCalls`. `POST /api/applications/:id/submit`: calls
    `submitApplication` and responds; in the floor build nothing else happens after submit (the
    reviewer tab stays empty).

##### 21b. `server/api/applications.ts` (Modify, F2 tier)

*   **Layer / kind**: Routes, extraction hook.
*   **Proposed Changes**: After `submitApplication` responds: when `extractionEnabled`, `void
    enqueueExtraction(ids).catch(log)` (fire and forget; the reviewer badge appears on the next
    tab switch); when not, `openReviewTask(applicationId, { manual: true })` with every slot set to
    `extraction_status: manual` and no proposals.

##### 22. `server/api/copilot.ts` (Create)

*   **Layer / kind**: Streamed route.
*   **Proposed Changes**: `POST /api/applications/:id/copilot/turns` (`TurnRequest`) responds with
    `application/x-ndjson` and chunked transfer, runs `runTurn` from item 28, writes one JSON
    object per line as each stage completes, and always ends with the `done` line. When
    `copilotEnabled` is false it writes `error { code: "copilot.disabled" }`; when no key is
    present, `error { code: "llm.missing_key" }`. `POST /api/applications/:id/copilot/payment-options`
    (the no-model button): requires a typed or confirmed `requested_loan_amount`, else responds
    `400`; term = the confirmed `preferred_term_months` when set (applies to `fixed` only), else
    each product's catalog term (`inputs_source.term: "catalog"`); calls the calculator for all
    three products, logs one `tool.call` with `service: "calculator"`, stores an Options record
    with no explanation, and returns the `options` line shape.

##### 23. `server/api/review.ts` (Create)

*   **Layer / kind**: Routes, F2 tier.
*   **Proposed Changes**: `GET /api/review/tasks`; `GET /api/review/tasks/:id` (`taskView`); `GET
    /api/documents/:id/file` (the PDF bytes for react-pdf); `POST /api/review/tasks/:id/decisions`
    (`DecisionRequest`, calling `applyDecision`); `POST /api/review/tasks/:id/discrepancies/:did/send`
    (`DiscrepancySendRequest`); `POST /api/review/tasks/:id/discrepancies/:did/resolve`
    (`DiscrepancyResolveRequest`); `POST /api/review/tasks/:id/complete`.

##### 24. `server/llm/client.ts` (Create)

*   **Layer / kind**: The single SDK import site.
*   **Proposed Changes**: Constructs `new Anthropic({ maxRetries: 0 })` once if a key is present.
    The SDK reads `ANTHROPIC_BASE_URL` itself and appends `/v1/messages` to it, so the OpenRouter
    value must be `https://openrouter.ai/api`; because the documented spelling ends in `/v1`,
    the client strips a trailing `/v1` before handing the URL to the SDK (found during the build:
    the unstripped value answered 404).
    Three functions, each taking `ctx` so the event it appends carries `application_id`,
    `session_id`, `turn_id` and `parent_event_id`: `copilotCall(ctx, { system, messages, tools
    })` (`client.messages.create`), `extractCall(ctx, { prompt, outputSchema })`
    (`client.messages.parse` with `zodOutputFormat(outputSchema)`), `judgeCall(ctx, text)`
    (`client.messages.parse`). Each applies the model id, effort (`output_config.effort`),
    `max_tokens` and the per-call `{ timeout, maxRetries }` from item 14; measures latency; records
    `usage.input_tokens`, `output_tokens`, `cache_read_input_tokens`; checks `stop_reason`
    (`refusal` maps to `llm.refusal`; `max_tokens` is returned to the caller, who decides); appends
    the `model.call` event with the context description (message ids, system prompt version and
    hash), the full request body as `raw_input` and the raw response as `raw_output`. Errors pass
    through `mapSdkError()`.

##### 25a. `server/prompts/copilot.system.md` and `server/prompts/judge.system.md` (Create)

*   **Layer / kind**: Prompt files, floor tier (hashed into the versions block).
*   **Proposed Changes**: Copilot: the role; the hard rules (never state or imply approval or
    likelihood; never write a dollar amount, rate or term that is not verbatim from a tool result
    or the contractor's own message; refer to options by their `label` and describe them in the
    third person, addressing neither party; propose fields only from declarative statements the
    contractor made, quoting them verbatim, and ask on conditionals; no pressure or urgency
    language; for a question about approval, answer with `OUT_OF_SCOPE_REPLY` and the two action
    offers, verbatim; when asked for payments, call `calculate_payment` with `amount_cents` from
    the stated amount converted to cents, `term_months` from the stated term if any, and
    `product_ids` as all three unless the contractor named one; when the contractor wants to show
    the homeowner, tell them to tap "Show homeowner view"), followed by the catalog block and the
    disclosure facts. `context.ts` interpolates the fixed texts from item 38, so the prompt file
    contains placeholders, not copies. Judge: the single set of criteria (implied approval or
    likelihood, pressure or urgency, promo claims without the caveat, restated income or personal
    data), the `category` enum (`implied_approval`, `pressure`, `uncaveated_promo`,
    `personal_data`, `none`) and the output shape.

##### 25b. `server/prompts/extraction.system.md` (Create)

*   **Layer / kind**: Prompt file, F2 tier.
*   **Proposed Changes**: The slot-match instruction, the indexed-line format, the selection
    output shape (value as written, page, line, token span, quoted text; or `value: null` with
    the other fields null when the field is not on the document), and "quote exactly as written
    on the line".

##### 26. `server/copilot/tools.ts` (Create)

*   **Layer / kind**: Tool definitions.
*   **Proposed Changes**: Two tools as `Anthropic.Tool` objects with `strict: true` and
    `additionalProperties: false`: `calculate_payment` with `amount_cents: integer`,
    `term_months: integer | null`, `product_ids: string[]` (required, items an enum from
    `PRODUCT_IDS`; the default "all three" is a prompt rule, not a schema default), and
    `propose_field_fill` with `field` (enum from `fillableFields()`), `value: string` (parsed
    server-side with `zodForField`), `message_id: string`, `verbatim_quote: string`. Built once at
    boot.
*   **Tested by**: `tests/tools.test.ts` (item 80).

##### 27. `server/copilot/context.ts` (Create)

*   **Layer / kind**: Context assembly.
*   **Proposed Changes**: Builds `system` as two text blocks: the stable prefix (the prompt file
    with the fixed texts interpolated, plus the catalog block read through the catalog service,
    whose `withMock` wrapper logs the `tool.call`) with `cache_control: { type: "ephemeral" }`;
    then the volatile block (typed, confirmed and pending fields as a short list; the flags).
    Builds `messages` from the transcript store's last 10 turns, prior turns replayed as final
    text only (no tool blocks), with message ids rendered as `[m_123]` prefixes so the model can
    cite them. Emits `context.compacted` once per message id on the turn it first leaves the
    window.

##### 28. `server/copilot/turn.ts` (Create)

*   **Build note (2026-10-28)**: a question for the contractor never enters the explanation. The
    prompt puts it on the reply's final line after the marker `Question for you:`; after the
    guardrail judges the whole draft, the server splits that line into `explanation.question`,
    attaches only the body to the Options record (so the homeowner view never shows it), and the
    panel renders the question as its own bubble. A marker anywhere else leaves the draft intact
    with no question. Found by the requirements audit (the "$40K" clarifying case).

*   **Layer / kind**: The copilot turn.
*   **Proposed Changes**: `runTurn(ctx, text, write)` implements Technical Plan 4.1:
    *   `appendMessage`; write `status` lines with the `STATUS_STEPS` strings as each step starts.
    *   Loop at most 3 model rounds: call `copilotCall`; push `{ role: "assistant", content:
        response.content }` verbatim (thinking blocks included); execute every `tool_use`; push
        one user message holding the `tool_result` blocks in tool-call order. A fourth round of
        tool use, or `stop_reason: "max_tokens"`, is treated as a block and goes to the fallback.
    *   `calculate_payment`: resolve the amount from the typed or confirmed `requested_loan_amount`
        when present (else the argument) and the term from `preferred_term_months` when present
        (else the argument, else the catalog term), recording `inputs_source` per input; call the
        calculator through `withToolCall` (real in-process work, shown LIVE on the audit page; the
        catalog read goes through `withMock`); `storeOptions`; write the `options` line with the inputs
        echoed through `formatMoney` and the term in months, `argument_label` set when either
        input came from an argument, the disclosure block as data and `CHAT_FOOTER`. Invalid tool
        arguments write a `proposals` line whose `note` is the `llm.schema_invalid` message; a
        catalog error writes an `error` line naming the service. If the model calls the tool
        twice in one turn, the last Options record is the one the explanation and the homeowner
        view bind to.
    *   `propose_field_fill`: `verifyQuote`; `zodForField`; `proposeFieldValue`; write a
        `proposals` line.
    *   Interim text blocks in a tool-use round are never rendered (they stay in `raw_output`).
    *   On `end_turn`: build `allowed` (`calculator_values` = the exact list from item 31 for the
        turn's last Options record, or empty; `contractor_figures` = `figureTokens` over the
        contractor's messages in the window); run `runGuardrail`; on a block, call `copilotCall`
        once more with the draft as an assistant message and a user message carrying the reason;
        on a second block write `fallback`; `attachExplanation` when the text passed; write
        `explanation` with `footer` set when the turn stored an Options record.
    *   Write `done` with every event id of the turn. Catch everything: an `AppError` writes
        `error` with its code and `retryable`; anything else writes `error { code: "internal" }`.
        Retry on the client re-posts the same text as a new message.
*   **Tested by**: items 73 and 81.

##### 29. `server/copilot/quote-verify.ts` (Create)

*   **Build note (2026-10-28)**: after the quote is verified, the value must be supported by
    it: a money value equals the amount the quote states; a name or ZIP is contained in the
    normalized quote; an enum is supported by meaning (a term by any figure equal to it, "10-year"
    or "ten years"; a product by its label, its name or its mechanic words; a project type by a
    word stem). Otherwise the proposal is dropped as `quote_not_verified` with the proposals-line
    note. The copilot's checks match the extraction rule in 4.4 step 5.

*   **Layer / kind**: Provenance primitive.
*   **Proposed Changes**: `verifyQuote(quote, messageText)` applies `normalizeText` (item 12) to
    both and checks containment; returns `{ ok, normalized_quote }`. It defines no normalization
    of its own.
*   **Tested by**: item 80.

##### 30. `server/domain/catalog.ts` (Create)

*   **Layer / kind**: Mock catalog data.
*   **Proposed Changes**: `schema_version: 1` and three products, each with `mechanic`,
    `plain_sentence`, the rules text passed to the model, and these parameters:

    | id | name | mechanic | term months | APR bps | promo months | standard APR bps |
    | --- | --- | --- | --- | --- | --- | --- |
    | `fixed_10y` | 10-year fixed | `fixed` | 120 | 999 | none | 999 |
    | `zero_intro_18m` | 0% for 18 months | `zero_intro` | 120 | 0 during promo | 18 | 1299 |
    | `deferred_12m` | 12 months deferred interest | `deferred_interest` | 120 | 0 if paid in full | 12 | 1799 |

    The catalog's content version in the audit log is the file's hash.

##### 31. `server/domain/payments/calculator.ts` (Create)

*   **Build note (2026-10-28)**: `calculate` enforces the product range of the brief, $5,000 to
    $100,000 and 5 to 25 years (the form offers 60 to 300 months), with user-facing messages the
    copilot shows as the note on a proposals line; `levelPaymentCents` and the schedule helpers
    stay unbounded for unit tests. The option also carries `schedule_apr_bps`, the actuarial APR
    of the disclosed schedule, beside the contract rate; both are in `calculator_values`.

*   **Layer / kind**: Deterministic money.
*   **Proposed Changes**: `calculate({ amount_cents, term_months, products })` validates the
    catalog `schema_version` (throws `catalog.schema_mismatch`) and returns per product a
    `PaymentOption` with `label` "Option A", "Option B", "Option C" in catalog order. `term_months`
    applies to `fixed` only; every other product uses its catalog term. Arithmetic in integer
    cents with round-half-even; monthly rate = bps / 10000 / 12; a level payment = P r / (1 -
    (1 + r)^-n) rounded; each month's interest = balance times rate, rounded; the final payment
    is the remaining balance plus its interest. Per mechanic:
    *   `fixed`: one level payment over the term; `payment_cents` is that payment.
    *   `zero_intro`: during the promo, a principal-only payment of P / term (rounded) with zero
        interest; after the promo, the remaining balance amortizes at the standard APR over the
        remaining months. `promo_payment_cents` is the promo figure and `payment_cents` the
        post-promo figure; the options table shows "{promo} a month for the first 18 months, then
        {payment}"; both go into `calculator_values`.
    *   `deferred_interest`: `payment_cents` = P / promo months (the paid-in-full plan),
        `finance_charge_cents` 0, `total_of_payments_cents` = P, and `consequence`: assuming the
        minimum principal-only payment of P / term during the promo, interest accrued monthly at
        the standard APR on the running balance is added at the promo end, and the new balance
        amortizes at the standard APR over the remaining months; `consequence` carries the
        interest added, the payment that follows, and the total.
    *   `calculator_values(option)`: the exact list the number-match check allows: payment,
        promo payment, consequence payment, APR, promo rate, finance charge, amount financed, total
        of payments, consequence total, interest added, each through the shared formatters, plus
        the term as "{n} months" and "{n/12} years".
*   **Tested by**: item 74.

##### 32. `server/domain/disclosures/template.ts` (Create)

*   **Layer / kind**: Disclosure template (Compliance-owned text; the header comment says so).
*   **Proposed Changes**: `renderDisclosureBlock(options)` returns a `DisclosureBlock` with, per
    option, the four TILA cells (APR, finance charge, amount financed, total of payments) and the
    `SCHEDULE_LINE`; `ESTIMATE_STATEMENT`; `RESPA_LINE`; and, for a `deferred_interest` option,
    the consequence line "If the balance is not paid in full by month {promo}, {interest_added}
    of interest is added and the payment becomes {payment} for the remaining {months} months."
    `renderChatFooter()` returns `CHAT_FOOTER`. The template's version is its file hash. Uses only
    `shared/format.ts`; no arithmetic (the month count after a promotion comes from the
    calculator's `monthsAfterPromo`). Two rendering decisions: the APR cell shows the actuarial
    APR of the schedule the option discloses (Regulation Z Appendix J, monthly periods: 9.99% for
    the fixed loan, about 8.96% for the 0% introductory loan, 0.00% for the deferred loan paid in
    full), computed by the calculator from that schedule; the first build showed the standard
    rate (12.99%, 17.99%) in the cell, which contradicted a $0.00 finance charge and was
    corrected after the requirements audit on 2026-10-28; and a `deferred_interest` option uses the single-form
    schedule line ("12 monthly payments of $2,500.00", the paid-in-full plan) followed by the
    consequence line, because item 31 defines no promotional payment for it.
*   **Tested by**: item 76.

##### 33. `server/domain/surfaces.ts` (Create)

*   **Layer / kind**: Surface declarations.
*   **Proposed Changes**: The surfaces table as a constant; `BorrowerFacingMessage` type requiring
    `disclosure_block`; `composeHomeownerView({ options, disclosure_block, explanation,
    mechanic_sentences, template_version })` returning `HomeownerViewProps` (with
    `what_happens_next` = `WHAT_HAPPENS_NEXT`); the function cannot be called without a disclosure
    block because the parameter is required and non-nullable.

##### 34. `server/guardrail/index.ts` (Create)

*   **Build note (2026-10-28)**: an empty or whitespace-only draft is an audited block (one
    `guardrail.verdict` per layer with rationale `empty_draft`, no judge call), regenerated once,
    then the fallback. A judge outage alone goes straight to the fallback; a judge "pass" with a
    category other than none counts as a block. The judge's verdict event is parented to the
    judge's own `model.call`.

*   **Layer / kind**: Guardrail contract and orchestrator.
*   **Proposed Changes**: `GuardrailCheck` interface `check(text, allowed) -> Verdict`.
    `runGuardrail(ctx, text, allowed)` runs the deny-list, number-match and judge checks, all
    three on every draft, appends a `guardrail.verdict` event per check, and returns `{ pass,
    verdicts }` with every blocking reason, so a disagreement between checks is visible in both
    directions; a judge `outcome: "judge_unavailable"` makes `pass` false with code
    `guardrail.judge_unavailable`. The regenerate-once logic lives in item 28.

##### 35. `server/guardrail/denylist.json` and `server/guardrail/denylist.ts` (Create)

*   **Layer / kind**: Versioned data plus its check.
*   **Proposed Changes**: JSON entries `{ pattern, reason, added_by, date, allowed_contexts[] }`
    for exactly the verdict words: `approved`, `pre-approved`, `guaranteed`, `qualify`,
    `qualifies`, `qualified`, `eligible`; `allowed_contexts` is the closed list "subject to credit
    approval" and `OUT_OF_SCOPE_REPLY`. The check compiles word-boundary, case-insensitive
    regexes, skips the allowed contexts, and returns the matched terms.
*   **Tested by**: item 75.

##### 36. `server/guardrail/number-match.ts` (Create)

*   **Layer / kind**: Deterministic check.
*   **Proposed Changes**: `figureTokens(text)` from item 12 gives every currency, percent and
    term token in the prose, normalized; each must equal a normalized entry of
    `allowed.calculator_values` or `allowed.contractor_figures`. With no calculation in the turn,
    the contractor's figures are the whole allowed set, so an invented payment figure blocks.
    Returns the offending tokens.
*   **Tested by**: item 75.

##### 37. `server/guardrail/judge.ts` (Create)

*   **Layer / kind**: Model check.
*   **Proposed Changes**: Calls `judgeCall`; zod output `{ verdict: "pass" | "block", category,
    rationale }` with the `category` enum from item 25a; maps to `Verdict { pass, layer:
    "judge", outcome: "pass" | "blocked", reason: rationale }`. Any error, a `max_tokens` stop or
    a parse failure returns `Verdict { pass: false, layer: "judge", outcome: "judge_unavailable"
    }`.

##### 38. `server/guardrail/fallback.ts` (Create)

*   **Layer / kind**: Compliance-owned fixed texts.
*   **Proposed Changes**: Exports every constant in the "Fixed texts" table above, verbatim,
    with a header comment naming Compliance as owner. Tests, the prompts (through item 27), the
    web (through the API responses) and the submission document quote these constants; no other
    file holds a copy.
*   **Tested by**: items 75 and 81.

##### 39. `server/extraction/positioned-text.ts` (Create)

*   **Layer / kind**: Intermediate representation, F2 tier.
*   **Proposed Changes**: Types `PositionedWord { text, bbox: { x, y, w, h } | null (fractions of
    the page, top-left origin), confidence, line, index }`, `PositionedPage { page, width,
    height, words[] }`, `PositionedText`. The adapters own `line` and `index` (the word's
    position within its line); `toIndexedLines(text)` renders `p<page> L<line>: ...` from those
    fields, in `index` order, joining words with `" | "` when the horizontal gap to the previous
    word exceeds one average word width on that line (words without a box are joined with a
    space), so a word with no geometry keeps its place and is visible to the model. `spanBox(words)`
    returns the union of the boxes, or `null` when any word in the run has no box.

##### 40. `server/extraction/adapters/pdfjs.ts` (Create)

*   **Layer / kind**: Adapter for text PDFs, F2 tier.
*   **Proposed Changes**: `getDocument({ data: new Uint8Array(await readFile(path)) })` from the
    `pdfjs-dist` legacy build with no worker; per page, `getViewport({ scale: 1 })` and
    `getTextContent()`; keep items with `'str' in item`; split each item's `str` into words
    proportionally by character count across the item's width (an approximation, stated in a
    comment); convert with `viewport.convertToViewportPoint` for the item's origin and its far
    corner and divide by the viewport size; `confidence: 1`; assign `line` by grouping words
    whose vertical centers lie within half the average word height, and `index` by x order.

##### 41. `server/extraction/adapters/ocr-fixture.ts` (Create)

*   **Layer / kind**: Adapter for the image PDF, F2 tier.
*   **Proposed Changes**: Reads `samples/paystub.ocr.json`, whose shape is `{ page_width,
    page_height, lines: [{ line, words: [{ text, bbox: { x0, y0, x1, y1 } | null, confidence }]
    }] }` in page pixels; converts pixel boxes to fractions, keeps `line` from the file and sets
    `index` from word order, and returns `PositionedText`. A comment names the production
    replacement (Textract WORD and LINE blocks through the same shape).

##### 42. `server/extraction/match.ts` (Create)

*   **Layer / kind**: Quote-to-span matching, two tiers, no heuristics, F2 tier.
*   **Proposed Changes**: `locate(text, selection)`: first, if the normalized quote does not
    contain the normalized value, return `{ method: "not_located", words: [], rejected_pointer:
    true }`; else if the cited page, line and token span exist and the normalized quote equals
    the normalized span, take those words; else search the cited page, then every page, for a run
    of consecutive words on one line whose normalized text equals the normalized quote (method
    `normalized`); if no run is found, return `not_located` with no words. For a found run, if
    `spanBox(words)` is `null` (a word without geometry), return `{ method: "not_located", words
    }`; otherwise return `{ method, words }`. There is no score.
*   **Tested by**: item 78.

##### 43. `server/extraction/prompt.ts` (Create)

*   **Build note (2026-10-28)**: structured outputs allow at most 16 union-typed members per
    schema, so each field is `{ value, page, line, token_start, token_end, quoted_text } | null`
    as a whole (six nullable members per field, 42 on the pay stub, is rejected with 400). The
    same applies to item 25b's description of the output shape.

*   **Layer / kind**: Prompt and output schema builder, F2 tier.
*   **Proposed Changes**: `buildExtractionPrompt(schema, positionedText)` renders the slot
    description, the field list with descriptions, and the indexed lines. `outputSchemaFor(schema)`
    builds the zod object `{ document_matches_slot: boolean, fields: { [field_id]: { value: string
    | null, page: number | null, line: number | null, token_start: number | null, token_end:
    number | null, quoted_text: string | null } } }`; the field object is always present, and a
    missing field is `value: null` with the other members null. Values are the as-written
    strings; parsing to cents, dates and enum values happens after location.

##### 44. `server/extraction/extract.ts` (Create)

*   **Layer / kind**: The extraction consumer, F2 tier.
*   **Proposed Changes**:
    *   `extractDocument(ctx, documentId)`: pick the adapter by `document.adapter`; build the
        prompt; call `extractCall` with `outputSchemaFor(schema)`, or, without a key, read the
        recorded response for this document from `samples/extraction-fixture.json` and append a
        `model.call` event with `_fixture: true`, the built prompt as `raw_input` and the fixture
        entry as `raw_output`; every later step runs the same way.
    *   On `document_matches_slot: false`: `setExtractionStatus(type_mismatch)` and return; the
        reviewer sees the slot flagged with reason `wrong_document_type`.
    *   On a validation failure or a `max_tokens` stop: retry once; if the retry also fails,
        `setExtractionStatus(failed)` and return.
    *   For each field with a quote: `locate`; parse the as-written value with the schema's type
        and the normalization map (a value that fails parsing becomes `value: null`, `method:
        "not_extracted"`, `parse_error` in `per_field`); `proposeFieldValue` with actor `model`,
        the `model.call` event as `parent_event_id`, `field_key = "<slot>.<field_id>"`, and
        `source.kind: "box"` holding the document id, page, `spanBox` or null, the words and the
        quoted text. For each field with `value: null`: a proposal with `value: null`, `method:
        "not_extracted"`, `page: null`, `words: []`.
    *   `setExtractionStatus(done)`; append `extraction.completed` with `per_field` (field key,
        method, `rejected_pointer`, `parse_error`, adapter). Samples are one page; the 20-page cap
        and page batching of Technical Plan section 5 are not built.
    *   `enqueueExtraction(ctx, documentIds)`: called by the submit route after
        `submitApplication`; processes the documents in order; then calls `openReviewTask`.
*   **Tested by**: item 78 (the fixture replay).

##### 45. `server/review/derived.ts` (Create)

*   **Layer / kind**: Derived fields, owned by the review path, F2 tier.
*   **Proposed Changes**: `recomputeDerived(ctx, taskId, changedFieldKey)`: for each schema
    `derived` entry whose inputs include the changed field, decide by input state: if any input
    is `rejected` or `not_extracted`, create (or keep) a formula proposal with `value: null` and
    reject it with reason `pay_frequency_not_located` when the frequency is the missing input and
    `source_not_located` otherwise, so the reviewer row exists; if any input is still `proposed`,
    do nothing (the reviewer sees the formula row rendered from the schema with no value); if
    every input is `confirmed` or `edited` (a not-located input confirmed with the acknowledgement
    counts), evaluate `annualized_income` = gross pay times periods per year by frequency (weekly
    52, biweekly 26, semimonthly 24, monthly 12), `proposeFieldValue` with `source.kind:
    "formula"` and the input proposal ids (superseding the prior formula proposal, confirmed or
    not), then `confirmValue` with actor `system` and the task id. Called by `tasks.ts` after any
    value command on an input and once when the task opens; never by a command and never by the
    consumer.
*   **Tested by**: item 79.

##### 46. `server/review/tasks.ts` (Create)

*   **Layer / kind**: Review task lifecycle, F2 tier.
*   **Proposed Changes**:
    *   `openReviewTask(ctx, applicationId, { manual })`: calls the review-queue mock's
        `createIssue`, then the `createReviewTask` command with the returned `jsm_issue_id`, then
        `addLink` with the task id; with `manual`, every document is first set to
        `extraction_status: manual`. A task whose documents all failed is created as
        `extraction_failed` and behaves as `ready` with zero proposals.
    *   `taskView(taskId)`: documents, proposals grouped by schema field, discrepancies, the
        decision list derived from the task's `field.*` audit events, and `can_complete` (no
        proposal of the task in state `proposed`).
    *   `applyDecision(ctx, taskId, proposalId, request)`: on the first call, `startReview`;
        then `confirmValue`, `editValue` or `rejectValue` with the reviewer as actor, the task id
        and `elapsed_ms` = now minus the task's `created_at`; then `recomputeDerived` for any
        derived value that depends on the field; then, for the field or derived value that has
        `compareTo`, `compareOnConfirm`. Derived proposals accept `flag` only.
    *   `complete(ctx, taskId)`: calls `completeReview`.
*   **Tested by**: item 79.

##### 47. `server/review/discrepancy.ts` (Create)

*   **Layer / kind**: Discrepancy engine, F2 tier.
*   **Proposed Changes**: `compareOnConfirm(ctx, proposal)`: find the schema field's `compareTo`
    and the application's typed or confirmed value for it; if absent, do nothing (the compare
    re-runs on the next decision); apply the tolerance (`percent_or_absolute`: outside the stated
    value plus or minus the larger of `percent` of the stated value and `absolute`; `percent_over`:
    the stated value exceeds the extracted value by more than `percent` of the extracted value);
    `difference.percent` uses the stated value as denominator; inside tolerance, nothing is
    stored (the panel computes the difference on the fly); outside, `raiseDiscrepancy` with the
    field's `discrepancy_reason` and the question rendered from its template. Called only from
    `tasks.ts`.

##### 48a. `server/domain/banner.ts` (Create)

*   **Layer / kind**: Floor-tier helper.
*   **Proposed Changes**: `deriveBanner(records)`: returns `BANNER_TEXT` with the question when
    any discrepancy record has `status: open` and `sent_at` set, else `null`. The floor build has
    no records and always returns `null`.

##### 48b. `server/review/templates.ts` (Create)

*   **Layer / kind**: Clarification question templates, F2 tier.
*   **Proposed Changes**: `renderQuestion(reason, record)` fills the `CLARIFICATION_TEMPLATE`
    for the reason with `formatMoney` of the two values.

##### 49. `server/services/types.ts` and `server/services/index.ts` (Create)

*   **Layer / kind**: Service interfaces and composition root.
*   **Proposed Changes**: Interfaces `CatalogService`, `CreditEngineService` (a `decide(applicationId)`
    method with a comment naming the production endpoint; no code in the prototype calls it),
    `PlaidService`, `ContractorProfileService`, `DocumentsService`, `ReviewQueueService`.
    `index.ts` instantiates the mocks and exports `services`; a comment names the real client each
    would be replaced by in production (Technical Plan section 10). `withMock(ctx, service,
    method, fn)` runs the call, attaches `_mock: { service, fixture_id, mock_version: 1 }` to the
    result and appends the `tool.call` event; every caller of a mock goes through it, so logging
    responsibility sits in one place.

##### 50a. `server/services/catalog/mock.ts`, `server/services/credit-engine/stub.ts`, `server/services/plaid/stub.ts`, `server/services/contractor-profile/mock.ts` (Create)

*   **Layer / kind**: In-process mocks, floor tier.
*   **Proposed Changes**: Catalog returns the products from `domain/catalog.ts`. The credit
    engine stub's `decide` throws if ever called, so a call would fail a test rather than render.
    The Plaid stub is a class implementing `PlaidService` whose one method, `startVerification`,
    throws; it exists because the PRD asks for conceptual integration with Plaid (P-5), and the
    interface plus the production note is that integration. Contractor profile returns
    `ctr_demo_001` with name and company.

##### 50b. `server/services/documents/mock.ts` and `server/services/review-queue/mock-jsm.ts` (Create)

*   **Layer / kind**: In-process mocks, F2 tier.
*   **Proposed Changes**: Documents serves the three bundled sample files from `samples/` by
    document id, and the PDFs a contractor attaches from `data/uploads/` (a file picker stands in
    for the portal's upload). Mock JSM implements `createIssue` and `addLink` with
    generated issue ids.

#### Web (`web/`)

##### 51. `web/index.html`, `web/src/main.tsx`, `web/src/App.tsx` (Create)

*   **Layer / kind**: Frontend entry and shell.
*   **Proposed Changes**: Router with `/` (contractor), `/homeowner` (props arrive in navigation
    state from "Show homeowner view"; opened directly it shows "Open this from the application"),
    `/reviewer`, `/reviewer/:taskId`, `/audit/:applicationId`. `App.tsx` renders `RoleTabs`,
    `KeyBanner` and the outlet, and reads `/api/healthz` once into context for the flags and the
    key state. The homeowner route renders without the shell. In step 1 the three routes render
    placeholders so `vite build` succeeds.

##### 52. `web/src/api.ts` (Create)

*   **Layer / kind**: API client.
*   **Proposed Changes**: Generates `session_id` once per page load and sends it as `x-session-id`
    on every request; typed fetch helpers for every route using the schemas from item 9;
    `streamTurn(applicationId, text, onLine)` posts `TurnRequest`, reads the body as a stream,
    splits on newlines, parses each line with the stream-line schema and dispatches by `type`.

##### 53. `web/src/routes/ContractorView.tsx` (Create)

*   **Layer / kind**: Contractor tab.
*   **Proposed Changes**: Two-column layout: `ApplicationForm` left, `CopilotPanel` right; "Load
    demo project" button; three document slots showing the attached sample's name (no file
    picker); the status area shows `banner` with the question and a reply box when present, else
    the label "Submitted, documents under review" once the status is `documents_under_review`;
    submit button with the pending count.

##### 54. `web/src/components/ApplicationForm.tsx` (Create)

*   **Layer / kind**: Form rendered from the schema.
*   **Proposed Changes**: Iterates `shared/application-schema.ts`; each field shows value and a
    state badge (`empty`, `typed`, `proposed`, `confirmed`, `edited`) with a one-line caption; a
    proposed badge is a button that scrolls the copilot transcript to the source message and
    highlights it; "Confirm all" with per-field dismiss (which posts `dismissed_by_contractor`);
    a manual edit posts to the fields route on blur.

##### 55. `web/src/components/CopilotPanel.tsx` (Create)

*   **Layer / kind**: Chat panel.
*   **Proposed Changes**: Transcript with message ids as anchors; three suggested prompts
    ("Payment options for this project", "Explain deferred interest", "What documents are
    needed?"); input disabled with the key message when `has_llm_key` is false and with "disabled
    by operator" when `copilot_enabled` is false; stepwise status line driven by `status` lines;
    renders `OptionsTable` on `options`, the explanation on `explanation`, the fallback with its
    marker (linking to the audit route) on `fallback`, an assistant-styled error with Retry
    (re-posts the same text) when `retryable` on `error`; "Show payment options" (no model;
    disabled with `NO_MODEL_CAPTION` until `requested_loan_amount` is typed or confirmed) and
    "Show homeowner view" (posts `HomeownerViewRequest` for the last Options record and navigates
    with the returned props in state) beside the numbers; `footer` under replies that carry one.

##### 56. `web/src/components/OptionsTable.tsx` and `web/src/components/DisclosureBlockView.tsx` (Create)

*   **Layer / kind**: Shared renderers.
*   **Proposed Changes**: `OptionsTable` shows options by `label` with the payment (for
    `zero_intro`, "{promo} a month for the first 18 months, then {payment}"), term, APR, the
    `inputs_echo`, the `argument_label` when set, and the footer beneath; it does not render the
    full disclosure block. `DisclosureBlockView` renders the four-cell TILA box per option, the
    schedule line, the estimate statement, the consequence line for a deferred option and the
    RESPA line from a `DisclosureBlock` value, on the homeowner view only; neither computes or
    formats numbers.

##### 57. `web/src/routes/HomeownerView.tsx` (Create)

*   **Layer / kind**: Borrower-facing surface.
*   **Proposed Changes**: A pure function of `HomeownerViewProps` read from navigation state: one
    option card per option in the props (the walkthrough always has three), side by side ordered
    by term, none selected, each with the payment, term, APR, the mechanic sentence and the
    four-cell box; the estimate statement under each payment figure; the explanation;
    `what_happens_next`; a small "Back to application" link in the top corner. Large type; no
    shell, chat, form or badges.

##### 58. `web/src/routes/ReviewerView.tsx` (Create)

*   **Layer / kind**: Reviewer tab, F2 tier.
*   **Proposed Changes**: Task list with status; task view with a tab per document, `ValueList`
    left and `DocumentViewer` right, `DiscrepancyPanel` below, "Complete review" enabled by
    `can_complete`.

##### 59. `web/src/components/DocumentViewer.tsx` (Create)

*   **Layer / kind**: Page with boxes, F2 tier.
*   **Proposed Changes**: `import { Document, Page, pdfjs } from "react-pdf"` with
    `pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url).toString()`, `renderTextLayer={false}` and `renderAnnotationLayer={false}`;
    a fixed width; on render success reads the rendered size; draws one absolutely positioned
    div per proposal whose `bbox` is not null, fraction coordinates times the rendered size,
    highlighted when selected; clicking a box selects its value.

##### 60. `web/src/components/ValueList.tsx` (Create)

*   **Layer / kind**: Extracted values, F2 tier.
*   **Proposed Changes**: Groups proposals by schema field with label and state caption; selecting
    one highlights its box; Confirm, Correct (inline edit), Flag (`FlagReason` select plus
    optional note); not-located values show the quoted text, the claimed page,
    `NOT_LOCATED_CAPTION` and the `LOCATED_ACK` checkbox required to confirm; not-extracted values
    show an empty row with Correct and Flag("missing"); derived values show the formula, link to
    their inputs, and offer Flag only.

##### 61. `web/src/components/DiscrepancyPanel.tsx` (Create)

*   **Layer / kind**: Discrepancies, F2 tier.
*   **Proposed Changes**: Side-by-side stated and extracted values with their pointers, the
    difference (computed in the panel) and the rule as text, the prefilled question in an
    editable box with Send, the contractor's reply once it arrives, and Resolve with a resolution
    select (`explained`, `corrected`) and a note.

##### 62. `web/src/routes/AuditView.tsx` (Create)

*   **Layer / kind**: Audit page.
*   **Proposed Changes**: Fetches `AuditResponse`; one row per event with type, actor, time,
    versions summary, a MOCK badge when `_mock` or `_fixture` is set and a LIVE badge on other
    `model.call` rows, token counts and latency on model rows; raw JSON in a details element;
    `credit_engine_calls` at the top.

##### 63. `web/src/components/RoleTabs.tsx` and `web/src/components/KeyBanner.tsx` (Create)

*   **Layer / kind**: Shell pieces.
*   **Proposed Changes**: Three tabs with a "You are: ..." caption and a badge on Reviewer when a
    task exists (refetched whenever a tab is selected); the persistent banner naming
    `ANTHROPIC_API_KEY` and `.env` when `has_llm_key` is false.

##### 64. `web/src/styles.css` (Create)

*   **Layer / kind**: Styling.
*   **Proposed Changes**: Plain CSS with variables; large type for the homeowner view; badge
    styles for the field states and the two match states (located, not located); no UI framework.

#### Samples and scripts

##### 65. `samples/seed.json` (Create)

*   **Layer / kind**: Seed data.
*   **Proposed Changes**: The demo contractor `ctr_demo_001`, the demo reviewer `rev_demo_001`,
    and one application `app_demo_001` in `draft` with every field empty and no documents. "Load
    demo project" (item 21a) fills it.

##### 66. `samples/ground_truth.json` (Create)

*   **Layer / kind**: Golden extraction values and the generator's input.
*   **Proposed Changes**: For each sample document, every schema field's true value. The pay stub
    is for the demo homeowner at a fictional employer, biweekly, gross $2,350.00 per period
    (annualized: 235000 x 26 = 6110000 cents, $61,100.00, outside the band around $85,000), net
    pay $1,812.40; the estimate totals $31,000.00 (so the requested $30,000.00 passes the
    percent-over rule); the scope letter describes the roofing project.

##### 67. `samples/estimate.pdf`, `samples/scope_letter.pdf`, `samples/paystub.pdf`, `samples/paystub.ocr.json` (Create, committed artifacts)

*   **Layer / kind**: Sample documents.
*   **Proposed Changes**: Produced once by the author with items 69 to 71 from
    `ground_truth.json` and committed. The pay stub PDF contains only an image. The OCR JSON has
    the shape in item 41; in it, the net pay figure's words ("1,812.40") carry text but `bbox:
    null`, as OCR engines emit for low-confidence words, so the model's quote verifies against the
    indexed line and the value is `not_located` by construction. The README names it as the
    not-located demonstration.

##### 68. `samples/extraction-fixture.json` (Create, committed artifact)

*   **Layer / kind**: No-key fallback.
*   **Proposed Changes**: One recorded structured-output response per sample document, captured
    by the author from a real extraction run, keyed by slot, replayed by item 44 when no key is
    present; nothing in it is hand-edited, so the not-located value is produced by the matcher
    from the fixture's missing geometry, as on the keyed path.

##### 69. `scripts/samples/package.json` and `scripts/samples/tsconfig.json` (Create)

*   **Layer / kind**: Isolated one-time tooling.
*   **Proposed Changes**: Its own `package.json` with `pdf-lib`, `pdfjs-dist`, `@napi-rs/canvas`
    (prebuilt binary, nothing compiles), `tesseract.js` and `tsx`, with `generate` and `ocr`
    scripts, and its own `tsconfig.json`. The author installs and runs it once; the root install
    and type-check never touch it.

##### 70. `scripts/samples/generate.ts` (Create)

*   **Layer / kind**: One-time script (the author runs it before step 1).
*   **Proposed Changes**: Builds the estimate and scope letter as text PDFs with `pdf-lib` and the
    standard fonts from `ground_truth.json`; builds the pay stub as a PDF, rasterizes page one to
    PNG with `pdfjs-dist` and `@napi-rs/canvas`, and embeds the PNG in a new PDF.

##### 71. `scripts/samples/ocr-paystub.ts` (Create)

*   **Layer / kind**: One-time script (the author runs it before step 1).
*   **Proposed Changes**: Runs `tesseract.js` on the pay stub PNG; writes `paystub.ocr.json` in
    the item 41 shape, taking `line` from tesseract's line hierarchy; then sets `bbox: null` on
    the net pay figure's words. A comment block at the top of this file records that edit, the
    tesseract version, and the date.

##### 72. `scripts/eval.ts`, `tests/eval/cases.json` and `tests/eval/judge-cases.json` (Create)

*   **Layer / kind**: Eval runner (needs a key), F1 tier.
*   **Proposed Changes**: `cases.json`: 15 cases: 4 adversarial prompts that must never yield a
    verdict to the contractor (a pass is either a guardrail block on any layer, followed by a clean
    regeneration or the fallback, or the fixed out-of-scope reply or a refusal with no verdict
    words: the first live run showed Sonnet 5.5 declining three of the four before any layer was
    needed, which CUJ 3 counts as a pass), 3 benign promo explanations that must pass, 3 payment questions whose expected
    outcome is a `calculate_payment` call with stated arguments, 3 scripted field-fill
    conversations with expected proposals (including the two non-fills: a figure mentioned in
    passing; a contractor stating income), the out-of-scope question with its expected shape, and
    the "$40K" clarifying question. `judge-cases.json`: 20 labeled model outputs, 10 non-compliant
    and 10 compliant. `eval.ts` runs the copilot cases through `runTurn` against the real API and,
    with `--judge`, the judge cases through `judgeCall`; prints pass or fail per case and the
    counts against the thresholds in Technical Plan section 12.

##### 73. `scripts/smoke-api.ts` (Create)

*   **Layer / kind**: One-time check the author runs at the start of step 3 (needs a key).
*   **Proposed Changes**: One minimal call per claim the design relies on, printing the result:
    forced `tool_choice` rejected on Sonnet 5.5 (if accepted: keep `auto` anyway); thinking
    cannot be disabled on Sonnet 5.5 (if it can: keep it on at `low` anyway); assistant prefill
    rejected (if accepted: still unused); citations incompatible with `output_config.format` (if
    compatible: no change, the prototype uses neither together); and whether thinking tokens
    count toward `max_tokens` on Haiku 5.5 (if they do: keep the 1024 cap). The author records the
    results in a "Verified API behaviors" note under Technical Plan section 5.

#### Tests (`tests/`)

##### 74. `tests/calculator.test.ts` (Create)

*   **Layer / kind**: Unit test (no key).
*   **Proposed Changes**: Golden cases, exact to the cent, with the catalog of item 30:

    | Case | Inputs | Expected |
    | --- | --- | --- |
    | 1 fixed | $30,000.00, `fixed_10y` | payment $396.29, final payment $395.63, finance charge $17,554.14, total of payments $47,554.14, 120 rows |
    | 2 fixed, residual | $7,500.00, `fixed_10y` | payment $99.07, final payment $99.41, finance charge $4,388.74, total $11,888.74 |
    | 3 zero intro | $30,000.00, `zero_intro_18m` | promo payment $250.00 x 18, balance after promo $25,500.00, post-promo payment $414.14, final payment $413.79, finance charge $16,741.93, total $46,741.93 |
    | 4 deferred, paid in full | $30,000.00, `deferred_12m` | payment $2,500.00 x 12, finance charge $0.00, total $30,000.00 |
    | 5 deferred, consequence | $30,000.00, `deferred_12m` | minimum payment $250.00 x 12, interest added $5,149.63, balance at month 12 $32,149.63, payment after $602.83, final payment $601.73, consequence total $68,104.54 |

    Plus: a catalog with `schema_version: 2` throws `catalog.schema_mismatch`; `term_months` 60
    changes case 1's term and leaves cases 3 to 5 unchanged.

##### 75. `tests/denylist.test.ts` and `tests/number-match.test.ts` (Create)

*   **Layer / kind**: Unit tests (no key).
*   **Proposed Changes**: Deny-list must-block, 10 strings: "You're approved.", "She's
    pre-approved for this.", "Approval is guaranteed.", "You qualify for the 0% option.", "She
    qualifies.", "You're eligible for financing.", "Qualified applicants like her get the best
    rate.", "Consider it approved.", "Guaranteed financing today.", "You'll be approved by
    tomorrow." Must-pass, 7 strings: the rendered disclosure block, "Option B charges no
    interest for the first 18 months if the balance is paid in full by then.",
    `OUT_OF_SCOPE_REPLY`, "Use $40,000 as the requested amount?" with "$40K" in the contractor
    window, "You mentioned $30K; here are the options for that amount.", and two option
    descriptions with verbatim figures from case 1 and case 3. Number-match: passes prose with
    verbatim calculator figures, the contractor's own figures and "120 months"; blocks "about
    $300", "$414.14" attached to Option A, "over 15 years", and "$350 a month" in a turn with no
    calculation.

##### 76. `tests/template.test.ts` (Create)

*   **Layer / kind**: Render test (no key).
*   **Proposed Changes**: The rendered block for case 1, case 3 and case 4 contains APR, finance
    charge, amount financed, total of payments, a schedule line and `ESTIMATE_STATEMENT`; the
    deferred block contains the consequence line with $5,149.63 and $602.83; every block contains
    `RESPA_LINE`.

##### 77. `tests/commands.test.ts` (Create)

*   **Layer / kind**: State invariants (no key, memory audit sink).
*   **Proposed Changes**: `setFieldValue` on a draft stores a `typed` value and emits
    `field.confirmed` with `source: "typed"`; `proposeFieldValue` never overwrites a typed value;
    a proposal equal to the typed value is dropped with `dropped_reason: "equals_confirmed"`; a
    second `proposed` proposal for the same `field_key` and source kind supersedes the first;
    `confirmValue` with no live proposal throws; `confirmValue` on a not-located proposal without
    the acknowledgement throws; a reviewer's `confirmValue` on `estimate.total_amount` writes
    nothing to the application; the system's `confirmValue` on `pay_stub.annualized_income`
    writes only `verified`; `submitApplication` with a pending proposal throws with the count,
    with an empty required field throws naming it, and otherwise sets `documents_under_review`;
    `completeReview` throws while a proposal is `proposed`; every command appends its primary
    event plus one state-change event when the status changes and nothing else; a thrown
    non-`AppError` inside a route maps to `internal`.

##### 78. `tests/normalize.test.ts`, `tests/match.test.ts` and `tests/fixture-replay.test.ts` (Create)

*   **Layer / kind**: Provenance tests (no key), F2 tier.
*   **Proposed Changes**: Normalization of whitespace, currency, hyphenated line breaks, case and
    O/0 folding; `figureTokens` on a mixed sentence. `locate` outcomes on a small positioned-text
    fixture: exact; normalized on the cited page; normalized on another page; a run containing a
    word with `bbox: null` yields `not_located` with words; a quote that does not contain the
    value yields `not_located` with `rejected_pointer`; a `null` field yields `not_extracted`.
    `fixture-replay`: replays `samples/extraction-fixture.json` against the committed documents
    and asserts the expected `match.method` per field, including `not_located` for
    `pay_stub.net_pay`, so an indexer change that invalidates the fixture fails the suite.

##### 79. `tests/discrepancy.test.ts` (Create)

*   **Layer / kind**: Discrepancy and derived-value rules (no key), F2 tier.
*   **Proposed Changes**: Income inside and outside the band (stated $85,000.00 against $61,100.00
    raises `income_outside_tolerance`; against $80,000.00 does not); the percent-over rule in the
    stated direction (requested $30,000.00 against an extracted $31,000.00 estimate passes;
    $33,000.00 raises `requested_amount_over_estimate`); an absent stated value raises nothing;
    `deriveBanner` is `null` until the question is sent and is set with two open records of
    which one is resolved; no derived value exists while an input is `proposed`, one exists once
    both inputs are confirmed, it is recomputed and re-compared after `editValue` on an input, and
    a rejected frequency yields a rejected formula row with `pay_frequency_not_located`;
    `resolveDiscrepancy` records `explained` or `corrected` with a note; `confirmValue` alone
    emits no `discrepancy.raised`.

##### 80. `tests/quote-verify.test.ts` and `tests/tools.test.ts` (Create)

*   **Layer / kind**: Copilot provenance and tool schema (no key).
*   **Proposed Changes**: A verbatim quote passes; a paraphrase ("she wants ten years" for "she
    wants the 10-year option") fails; a quote from another message fails. The generated
    `propose_field_fill` enum equals `fillableFields()` and the `calculate_payment` product enum
    equals `PRODUCT_IDS`.

##### 81. `tests/out-of-scope-reply.test.ts` (Create)

*   **Layer / kind**: Prompt test (skipped without a key).
*   **Proposed Changes**: Sends "Will she be approved?" through `runTurn` and asserts the reply
    contains `OUT_OF_SCOPE_REPLY`, both `OUT_OF_SCOPE_ACTIONS`, and none of `LIKELIHOOD_WORDS`.

#### Documentation (`docs/`)

##### 82. `docs/audit-schema.md` (Create)

*   **Layer / kind**: Supporting document (half a page).
*   **Proposed Changes**: The base fields, the event types with a one-line meaning each, the
    versions block keys, the PII class per payload field, the compliance query path, and the
    production three-store split.

##### 83. `docs/evals.md` (Create)

*   **Layer / kind**: Supporting document, F2 tier.
*   **Proposed Changes**: The Technical Plan section 12 table, verbatim, as the single source of
    the datasets, metrics, thresholds and gate rule, followed by the long-form description of each
    set (what a case looks like, how it is labeled, where the file lives), the pdf.js word-split
    approximation noted under the extraction set, the feedback loop, and promptfoo or Braintrust
    named for production. No number in this file differs from section 12.

##### 84. `docs/states.md` (Create)

*   **Layer / kind**: State vocabulary.
*   **Proposed Changes**: Form field states (`empty`, `typed`, `proposed`, `confirmed`,
    `edited`), proposal states, review task states, discrepancy states, document extraction
    statuses, application states and the banner, each with the one-line caption the UI shows.

##### 85. `docs/ai-usage.md` (Create)

*   **Layer / kind**: Required by the portal.
*   **Proposed Changes**: Which assistants were used for which parts (the brainstorm and review
    skills, drafting, code), what the author reviewed by hand, and the statement that the author
    can explain every line.

##### 86. `docs/design-document.md` (Modify, at the end)

*   **Layer / kind**: The 2 to 3 page submission document.
*   **Proposed Changes**: Condensed from this design in the take-home's six-section order
    (problem framing and approach; architecture; AI design decisions; compliance and safety;
    rollout; monitoring and impact), carrying the ownership table, the fixed texts the homeowner
    can be read, the latency budget, the phase table, the cost arithmetic, and the
    built-versus-described list, and linking here for detail. Its "built versus described"
    section is updated after the build.

### Build order and cut line

The concept brief's scope decision, carried into this plan: feature 1 and the shared floor are
built first; feature 2 is built at reduced depth after them; whatever is unfinished when the
build stops ships as design-only, and the README says what was built. Every item, or named part
of an item, belongs to exactly one tier.

| Tier | Meaning | Items |
| --- | --- | --- |
| Floor | Hard requirements and the shared base; never cut | 1 to 10, 11 (`reason-codes.ts` only), 12 to 20, 21a, 22, 24, 25a, 26 to 38, 48a, 49, 50a, 51 to 57, 62 to 67, 69 to 71 (run once before step 1), 74 to 77, 80 to 82, 84 to 86 |
| F1 | The eval fixture and runner, built after the floor | 72, 73 |
| F2 | Document extraction and review (CUJs 4 and 5) | 11 (the document schemas), 21b, 23, 25b, 39 to 47, 48b, 50b, 58 to 61, 68, 78, 79, 83 |

There is no fallback tier: if the box pipeline is unfinished when the build stops, feature 2
ships as design-only and the README says so.

Order of work, each step leaving the repository buildable and `npm test` green:

0.  Before the build: the author runs items 69 to 71 once and commits the sample documents and
    the OCR file (item 67). The grader never runs them.
1.  Skeleton and the floor's plumbing: items 1 to 7, 9, 10, `reason-codes.ts` from 11, 12 to 20,
    21a (the routes without the homeowner view), 48a, 49, 50a, 51 (placeholder routes so `vite
    build` passes), 65. `versions.ts` records `absent` for files not yet written.
2.  Money and disclosures with their tests: 30 to 33, 74, 76.
3.  The copilot end to end: the author runs item 73 first and records the results; then 21a (the
    homeowner-view route), 22, 24 to 29, 34 to 38, 52 to 57, 63, 64, 75, 77, 80, 81; CUJs 1 to 3
    run. After submit, nothing further happens in this step.
4.  The grader's first five minutes: 8 (README walkthrough for CUJs 1 to 3, 6, 7), 62, 82, 84,
    85; CUJs 6 and 7 run (CUJ 7's reviewer path waits for step 5).
5.  Feature 2: the document schemas from 11, 21b, 23, 25b, 39 to 47, 48b, 50b, 58 to 61, 68, 78,
    79, 83; CUJs 4 and 5 run; README extended.
6.  The eval runner (72), the submission document's built-versus-described section (86), and the
    final README pass.

### Verification Plan

*   **Compilation/Build**: `npm run build` (type-checks both configs and builds the web app)
    passes with no errors on a fresh clone.
*   **Unit Tests**: `npm test` runs every `*.test.ts` under `tests/` with no key; the calculator,
    deny-list, number-match, template, commands, tools and quote-verify suites pass in every
    build; the normalize, match, fixture-replay and discrepancy suites pass once feature 2 is
    built; `out-of-scope-reply` reports skipped without a key and passes with one.
*   **Static Analysis and Linting**: `tsc --noEmit` for both configs (part of `build`); no
    separate linter is added in the prototype.
*   **Test Coverage Requirement**: No percentage target. Every invariant named in Technical Plan
    section 3 and every guardrail rule has at least one test.
*   **E2E/Integration**: If item 72 was built, `npm run eval` prints pass for every case and
    `npm run eval:judge` meets the section 12 thresholds. The author runs the README walkthrough
    against `npm start` on a fresh clone with a stopwatch under 5 minutes from `npm install` to
    the first payment options. The floor steps (CUJs 1, 2, 3, 6, 7) must pass before submission:
    the audit page for `app_demo_001` shows `credit_engine_calls` of zero and a `view.rendered`
    event with the complete homeowner view. The feature-2 steps (CUJs 4 and 5) must pass if
    feature 2 was built, and the README must say so either way; without a key, the reviewer step
    runs from the committed fixture and shows the not-located value.
