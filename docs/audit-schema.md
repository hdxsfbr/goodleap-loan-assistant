# Audit event schema

Every command, model call, service call, guardrail verdict and rendered homeowner view appends one
event to a single append-only stream per application. This page lists the base fields, the event
types, the payload fields of each, the PII class of each field and the versions block.

The source of truth is `AuditEventSchema` in [`shared/schemas.ts`](../shared/schemas.ts). This page
was generated from that schema as it stood on 2026-10-28; if the two differ, the schema is right.
Every object in the schema is strict, so a field that is not declared there is rejected, not dropped.

## Where events go

* Each event is validated against the schema, written as one JSON line to `data/audit.jsonl`, and
  only then kept in memory. An event the file refused leaves no trace.
* Events that belong together are written as one batch: `application.submitted` with its
  `application.state_changed`, and `review.completed` with its `application.state_changed`.
* There is no update and no delete. `data/audit.jsonl` is emptied when the server starts and by
  `POST /api/reset`, because the prototype's store is in memory and is seeded again at each start.
* `GET /api/applications/:id/audit` returns `{ events, credit_engine_calls }` in `seq` order. The
  audit tab is that response, one line per event with the raw record behind a click.
* The audit file holds raw model input and output and the text of every conversation, because the
  data is synthetic. Production keeps this in a restricted store (see the last section).

## Base fields

Every event carries these fields, then the fields of its type.

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `event_id` | string | yes | Unique id of the event (`evt_` and a UUID). |
| `application_id` | string | yes | The application the event belongs to. |
| `session_id` | string | yes | One page load of the web app (the `x-session-id` header of the request that caused the event). |
| `turn_id` | string | no | The copilot turn the event belongs to. |
| `parent_event_id` | string | no | The event that caused this one, for example the `model.call` behind a `field.proposed`. |
| `seq` | number | yes | Position in the application's stream, starting at 1. |
| `ts` | string | yes | UTC time, ISO 8601. |
| `actor` | `{ type, id }` | yes | Who acted. `type` is `contractor`, `reviewer`, `system` or `model`. |
| `schema_version` | `1` | yes | Version of this event schema. |
| `versions` | versions block | yes | The content hashes in effect when the event was written (next section). |
| `type` | string | yes | The event type (below). |

## Versions block

Each hashed key is `<name>@<first 8 hex of the SHA-256 of the file or files>`, computed once when the
server starts. A file that does not exist is recorded as `<name>@absent`. There are no version
numbers kept by hand.

| Key | Content |
| --- | --- |
| `copilot_prompt` | `server/prompts/copilot.system.md` |
| `judge_prompt` | `server/prompts/judge.system.md` |
| `extraction_prompt` | `server/prompts/extraction.system.md` |
| `denylist` | `server/guardrail/denylist.json` |
| `template` | `server/domain/disclosures/template.ts` (the disclosure template) |
| `catalog` | `server/domain/catalog.ts` |
| `calculator` | `server/domain/payments/calculator.ts` |
| `application_schema` | `shared/application-schema.ts` |
| `schemas` | The three document schemas in `shared/document-schemas/` (also the tolerance rules) |
| `fallback_texts` | `server/guardrail/fallback.ts` (the fixed texts Compliance owns) |
| `git_sha` | `git rev-parse HEAD`, or `unknown` |
| `copilot_model`, `extraction_model`, `judge_model` | The model ids in effect, after any OpenRouter translation (for example `anthropic/claude-sonnet-5.5`) |

## PII classes

A payload field that can hold personal or document data carries a class in the schema (`pii:<class>`
in the field's description). A field with no class holds ids, counts, enums, hashes or timings.
`auditPiiMap()` in `shared/schemas.ts` returns the map below as data, so a production split into
stores can be mechanical.

| Class | Holds |
| --- | --- |
| `personal` | Names, addresses, ZIP codes. Declared in the schema; no event field carries it on its own today, because values arrive inside the `mixed` fields. |
| `financial` | Amounts, payments, income. |
| `free_text` | Contractor, reviewer or assistant prose. |
| `document` | Content read from an uploaded document. |
| `model_io` | Raw prompts and raw model output, which can hold any of the above. |
| `mixed` | Field values and service payloads, which can hold personal and financial data. |

## Event types

In the tables, "PII" is the class declared in the schema, or a dash when none is declared. An
`optional` field is absent when it does not apply (never present and empty).

### Conversation and model calls

#### `message.received`

One message in the conversation. The contractor's text is recorded with a `contractor` actor; the
assistant's final reply (model text, fixed reply or fallback text) is recorded with a `model` actor.
Emitted by `appendMessage`.

| Field | Type | Required | PII |
| --- | --- | --- | --- |
| `message_id` | string | yes | - |
| `text` | string | yes | `free_text` |

#### `model.call`

One call to a model: the copilot, the extraction or the judge. Holds the full request body and the
raw response, so the stream alone reconstructs a conversation. Emitted by `server/llm/client.ts`
and `server/extraction/llm.ts`.

| Field | Type | Required | PII |
| --- | --- | --- | --- |
| `use_case` | `copilot` \| `extraction` \| `judge` | yes | - |
| `model_id` | string | yes | - |
| `effort` | string | yes | - |
| `context` | `{ message_ids, system_prompt_version, system_prompt_sha256 }` | yes | - |
| `raw_input` | JSON value (the full request body) | yes | `model_io` |
| `raw_output` | JSON value (the raw response) | yes | `model_io` |
| `usage` | `{ input, output, cache_read }` token counts | yes | - |
| `latency_ms` | number | yes | - |
| `stop_reason` | string or null | yes | - |
| `error_code` | an error code (see `ErrorCodeSchema`) | no | - |
| `_fixture` | boolean; true when the response was replayed from `samples/extraction-fixture.json` | no | - |

#### `tool.call`

One call to a service or to the calculator. Emitted by `withMock` (mocked services, with `_mock`) and
`withToolCall` (the calculator, which is real code and has no `_mock`). The audit tab shows MOCK when
`_mock` is present and LIVE when it is not.

| Field | Type | Required | PII |
| --- | --- | --- | --- |
| `service` | `catalog` \| `credit_engine` \| `plaid` \| `contractor_profile` \| `documents` \| `review_queue` \| `calculator` | yes | - |
| `method` | string | yes | - |
| `input` | JSON value | yes | `mixed` |
| `output` | JSON value | yes | `mixed` |
| `options_id` | string | no | - |
| `_mock` | `{ service, fixture_id, mock_version }` | no | - |
| `latency_ms` | number | yes | - |

#### `guardrail.verdict`

The result of one of the three wording checks on one draft. A draft produces three events, in this
order: `denylist`, `number_match`, `judge`. Emitted by `server/guardrail/index.ts`.

| Field | Type | Required | PII |
| --- | --- | --- | --- |
| `layer` | `denylist` \| `number_match` \| `judge` | yes | - |
| `verdict` | `pass` \| `block` | yes | - |
| `matched_terms` | string[] (the terms or figures that triggered the block) | no | `free_text` |
| `rationale` | string (the judge's reason, or the number-match reason) | no | `free_text` |
| `outcome` | `pass` \| `blocked` \| `judge_unavailable` | yes | - |
| `latency_ms` | number | yes | - |

#### `context.compacted`

Messages left the 10-turn window the model sees, for the first time. Emitted when a turn builds its
context.

| Field | Type | Required | PII |
| --- | --- | --- | --- |
| `dropped_message_ids` | string[] | yes | - |

### Form values and proposals

#### `field.proposed`

A value was suggested for a field, from a message quote, a box on a document or a formula. When
`proposal_id` is null the value was dropped before a proposal existed, and `dropped_reason` says why.
A new proposal for the same field and source kind supersedes the earlier live one, which is listed in
`superseded_proposal_ids`. Emitted by `proposeFieldValue`.

| Field | Type | Required | PII |
| --- | --- | --- | --- |
| `proposal_id` | string or null | yes | - |
| `field_key` | string (an application field id, or `<slot>.<field_id>` for a document value) | yes | - |
| `value` | string, number or null | yes | `mixed` |
| `source` | message, box or formula source (see below) | yes | `document` |
| `dropped_reason` | `equals_confirmed` \| `field_not_fillable` \| `quote_not_verified` | no | - |
| `superseded_proposal_ids` | string[] | no | - |

#### `field.confirmed`

A value became final: a contractor typed it (`source: typed`, no proposal), the contractor confirmed
a proposal, a reviewer confirmed a document value, or the system confirmed the calculated annual
income. Emitted by `setFieldValue` and `confirmValue`.

| Field | Type | Required | PII |
| --- | --- | --- | --- |
| `proposal_id` | string or null (null for a typed value) | yes | - |
| `field_key` | string | yes | - |
| `source` | `typed` \| `proposal` | yes | - |
| `final_value` | string or number | yes | `mixed` |
| `located_by_reviewer` | boolean (the reviewer acknowledged finding a not-located value) | no | - |
| `review_task_id` | string (present for a reviewer or system decision in a review) | no | - |
| `elapsed_ms` | number (time since the review task was created) | no | - |

#### `field.edited`

A person replaced a proposed value with their own. Emitted by `editValue`.

| Field | Type | Required | PII |
| --- | --- | --- | --- |
| `proposal_id` | string | yes | - |
| `field_key` | string | yes | - |
| `before` | string, number or null | yes | `mixed` |
| `after` | string or number | yes | `mixed` |
| `review_task_id` | string | no | - |
| `elapsed_ms` | number | no | - |

#### `field.rejected`

A contractor dismissed a proposal (`dismissed_by_contractor`) or a reviewer flagged a value with a
fixed reason. Emitted by `rejectValue`. The same event, with the system as actor, also records
`withdrawVerifiedValue` taking back a stored verified income when the confirmed calculated income behind
it is flagged or replaced.

| Field | Type | Required | PII |
| --- | --- | --- | --- |
| `proposal_id` | string | yes | - |
| `field_key` | string | yes | - |
| `reason_code` | `illegible` \| `source_not_located` \| `mismatch_with_stated` \| `wrong_document_type` \| `missing` \| `pay_frequency_not_located` \| `other` \| `dismissed_by_contractor` | yes | - |
| `note` | string | no | `free_text` |
| `review_task_id` | string | no | - |
| `elapsed_ms` | number | no | - |

### Payment options and the homeowner view

#### `options.stored`

A payment calculation was stored, by a copilot turn or by the "Show payment options" button. Emitted
by `storeOptions`.

| Field | Type | Required | PII |
| --- | --- | --- | --- |
| `options_id` | string | yes | - |
| `inputs_source` | `{ amount: form \| argument, term: form \| argument \| catalog }` | yes | - |
| `product_ids` | `fixed_10y` \| `zero_intro_18m` \| `deferred_12m` (list) | yes | - |

#### `options.explained`

The explanation that passed all three checks was attached to a stored calculation. Emitted by
`attachExplanation`.

| Field | Type | Required | PII |
| --- | --- | --- | --- |
| `options_id` | string | yes | - |
| `text` | string | yes | `free_text` |

#### `view.rendered`

The homeowner view was produced: its complete props as shown, a hash of them, and the events that
produced it. Emitted by the homeowner-view route when the contractor taps "Show homeowner view".

| Field | Type | Required | PII |
| --- | --- | --- | --- |
| `surface` | `homeowner_view` | yes | - |
| `options_id` | string | yes | - |
| `props` | the complete view (see below) | yes | `financial` |
| `content_sha256` | string (SHA-256 of the props with sorted keys) | yes | - |
| `produced_by` | string[] of event ids | yes | - |

### Application, documents and review

#### `application.submitted`

The form was submitted. Holds the field values as submitted and the attached document ids. Emitted
by `submitApplication`, in one batch with `application.state_changed`.

| Field | Type | Required | PII |
| --- | --- | --- | --- |
| `fields` | record of field id to string or number | yes | `mixed` |
| `document_ids` | string[] | yes | - |

#### `application.state_changed`

The stored status changed. `derived_banner` is the "needs clarification" text in effect after the
change, or null.

| Field | Type | Required | PII |
| --- | --- | --- | --- |
| `from` | `draft` \| `documents_under_review` \| `documents_reviewed` | yes | - |
| `to` | `draft` \| `documents_under_review` \| `documents_reviewed` | yes | - |
| `derived_banner` | string or null | yes | - |

#### `document.attached`

A document was attached to a slot. Emitted by `attachDocument` (the "Load demo project" button).

| Field | Type | Required | PII |
| --- | --- | --- | --- |
| `document_id` | string | yes | - |
| `slot` | `pay_stub` \| `estimate` \| `scope_letter` | yes | - |
| `adapter` | `pdfjs` \| `ocr_fixture` | yes | - |

#### `extraction.completed`

Extraction ended for one document. `per_field` lists how each field was matched, not the values.
Emitted by `setExtractionStatus`.

| Field | Type | Required | PII |
| --- | --- | --- | --- |
| `document_id` | string | yes | - |
| `extraction_status` | `pending` \| `done` \| `failed` \| `type_mismatch` \| `manual` | yes | - |
| `per_field` | list of `{ field_key, match_method, adapter, rejected_pointer?, parse_error? }` | yes | - |
| `error_code` | an error code | no | - |

`match_method` is `exact`, `normalized`, `not_located` or `not_extracted`. `rejected_pointer` is true
when the quote did not contain the value the model gave. `parse_error` says why a value could not be
read into its type. No PII class is declared on `per_field`.

#### `review.task_created`

The review task opened, once every document had been read, had failed or had been marked manual.
Emitted by `createReviewTask`.

| Field | Type | Required | PII |
| --- | --- | --- | --- |
| `task_id` | string | yes | - |
| `document_ids` | string[] | yes | - |
| `slot_statuses` | record of slot to extraction status | yes | - |
| `jsm_issue_id` | string (from the mocked review queue) | yes | - |

#### `review.started`

The first reviewer decision on a task. Emitted by `startReview`.

| Field | Type | Required | PII |
| --- | --- | --- | --- |
| `task_id` | string | yes | - |

#### `review.completed`

The reviewer completed the task. Emitted by `completeReview`, in one batch with
`application.state_changed`.

| Field | Type | Required | PII |
| --- | --- | --- | --- |
| `task_id` | string | yes | - |
| `outcome` | `documents_reviewed` | yes | - |
| `open_discrepancies` | number (records still open at completion) | yes | - |

### Discrepancies

Each of these four events carries the complete record as it stood after the step. Emitted by
`raiseDiscrepancy`, `sendDiscrepancyQuestion`, `replyToDiscrepancy` and `resolveDiscrepancy`.

| Type | Meaning |
| --- | --- |
| `discrepancy.raised` | A confirmed document value fell outside the tolerance for the application's value. The record is open and its question is the template for the reason code. The contractor sees nothing yet. |
| `discrepancy.sent` | The reviewer sent the (possibly edited) question to the contractor. The record gets `sent_at`; the banner appears. |
| `discrepancy.replied` | The contractor answered. The record gets `contractor_reply`. |
| `discrepancy.resolved` | The reviewer closed the record as `explained` or `corrected`, with a note. |

| Field | Type | Required | PII |
| --- | --- | --- | --- |
| `record` | the discrepancy record (see below) | yes | `mixed` |

## Nested shapes

**`source`** (on `field.proposed`), one of three kinds:

* `message`: `ref: { message_id, quote }`, the contractor's message and the verified verbatim quote.
* `box`: `ref: { document_id, page, bbox, words, quoted_text }`. `page` and `bbox` are null for a
  value that was not found. `bbox` is `{ x, y, w, h }` as fractions of the page, top-left origin.
  `words` are the document's own words with their positions; a word without geometry has `box: null`.
* `formula`: `ref: { formula, inputs }`, the formula name and the ids of the proposals it was computed from.

**`record`** (on the four `discrepancy.*` events): `id`, `application_id`, `field_key`,
`stated { value, pointer }`, `extracted { value, proposal_id }`, `rule_id`, `tolerance_version` (the
`schemas@<hash>` in effect when the rule ran), `difference { absolute, percent }`, `reason_code`
(`income_outside_tolerance` or `requested_amount_over_estimate`), `question { template_id, text }`,
`sent_at?`, `contractor_reply? { text, at }`, `status` (`open` or `resolved`), `resolution?`
(`explained` or `corrected`), `resolver?`, `note?`, `review_task_id`. Money is integer cents.

**`props`** (on `view.rendered`): `options` (the calculator output: amount, term and, per option, the
payment, finance charge, amount financed, total of payments and schedule), `options_display` (the
payment, term and APR wording per option), `disclosure_block` (the TILA cells per option, the schedule
line, the consequence line where there is one, the estimate statement and the RESPA line),
`explanation`, `mechanic_sentences` (one per product), `what_happens_next` and `template_version`.

## What did this homeowner see, and why

The homeowner view is a pure function of one stored calculation. When the contractor taps "Show
homeowner view", the server builds the view, appends one `view.rendered` event and returns the same
props to the screen. To answer the question for an application:

1. Find the `view.rendered` events. Each holds `props`, the complete content of the screen, and
   `content_sha256`, the hash of that content.
2. Read `produced_by`. It lists the events behind the view. For a copilot turn, that is every event
   that carries the turn's `turn_id`: the contractor's `message.received`, the `tool.call` events for
   the catalog and the calculator, the `model.call` events, the three `guardrail.verdict` events per
   draft, `options.stored`, `options.explained` and any `field.proposed` of the same turn. For the
   no-model button, it is the `tool.call`, `options.stored` and `options.explained` events that name the
   same `options_id`.
3. Open the `model.call` events in that list for the raw request and response, and the
   `guardrail.verdict` events for what was checked and why a draft was blocked or passed. The
   `versions` block on each event says which prompt, deny-list, template, catalog and model produced it.
4. To check the numbers, run the calculator and the disclosure template, at the versions stamped on the
   event, on `props.options.amount_cents` and `props.options.term_months`. The result should equal
   `options` and `disclosure_block` in `props`. The explanation is the text stored by
   `options.explained`, or the canned sentence per product when there was none.

A blocked draft stays in the stream. Its text is the `raw_output` of the `model.call` that wrote it,
the `guardrail.verdict` events with `outcome: blocked` (or `judge_unavailable`) follow it, and the
regenerated draft or the fallback text comes after, so the stream holds the draft, the verdict and the
final text.

## The credit-engine count

`credit_engine_calls` in the audit response is the number of `tool.call` events with
`service: credit_engine`. No code calls the credit decision engine; the stub throws when called. The
audit tab shows the count, and it reads 0.

## Production

Described only; the prototype writes one file. In production each field's PII class decides where it
goes: audit records with full content in a restricted, encrypted table written by an INSERT-only
role (large items such as raw prompts and rendered views by key in S3); operational logs and traces
with ids, event types, versions, error codes, latencies and token counts only; and aggregates
shipped to the warehouse. The retention period is Compliance's decision. See section 10 of the
[internal design](designs/loan-assistant-design.md).
