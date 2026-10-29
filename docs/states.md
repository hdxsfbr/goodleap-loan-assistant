# States and transitions

The state vocabulary of the prototype: what each state means, which command causes each transition,
and which audit event the command appends. States are stored in memory by `server/store.ts`, and the
only code that changes them is the set of named commands in [`server/commands.ts`](../server/commands.ts).
A command checks the transition, appends its audit event (see [audit-schema.md](audit-schema.md)), and
only then changes the state, so a refused transition leaves nothing behind. The routes call the
commands; two helpers, `server/review/tasks.ts` and `server/review/derived.ts`, decide which command a
reviewer's click turns into.

The stored application status is never a verdict. No state in this page means approved, declined,
qualified or eligible. The walkthrough ends at `documents_under_review` or `documents_reviewed`.

## Application status

Stored on the application. Three values, one direction.

| Status | Meaning | Caption on the contractor tab |
| --- | --- | --- |
| `draft` | The form is open. Typed values and suggestions can change. | The form and the submit button |
| `documents_under_review` | The form was submitted. Its values are locked and the documents are being read and reviewed. | "Submitted, documents under review" |
| `documents_reviewed` | A reviewer completed the document review. | "Documents reviewed" |

| From | To | Command | Audit events | Refused when |
| --- | --- | --- | --- | --- |
| `draft` | `documents_under_review` | `submitApplication` (the submit button) | `application.submitted`, then `application.state_changed`, written as one batch | Any suggestion is still `proposed` (the message gives the count), a required field is empty (the message names it), or the application is not a draft |
| `documents_under_review` | `documents_reviewed` | `completeReview` (the "Complete review" button) | `review.completed`, then `application.state_changed`, written as one batch | Any value of the task is still `proposed`, the task is already complete, or the application is not under review |

There is no other transition: no path back to `draft`, and nothing sets a status after
`documents_reviewed`. Required fields are `project_type`, `project_amount`, `requested_loan_amount`,
`homeowner_first_name`, `homeowner_last_name`, `property_zip` and `stated_annual_income`.

**Needs clarification** is not a status. It is a banner computed from the discrepancy records: it shows
while at least one record is `open` and its question has been sent (see "Discrepancy record"). It is
never stored, and its text is fixed: "Needs clarification: a reviewer found a difference between a
document and the application and has sent a question. No decision has been made." The text in effect at
each change is recorded in `application.state_changed.derived_banner`.

## Form field

What a field on the contractor's form shows. Four of the five states are stored on the application;
`proposed` is held in the proposals sidecar and merged into the form for display.

| State | Badge | Caption under the field | Meaning |
| --- | --- | --- | --- |
| `empty` | Empty | "Required" or "Optional" | No value. |
| `proposed` | Proposed | "Waiting for your confirmation" | A live suggestion exists. The stored value, if any, is unchanged and is shown as old to new. |
| `typed` | Typed | "Entered by you" | The contractor typed it. Counts as confirmed wherever a confirmed value is read. |
| `confirmed` | Confirmed | "Confirmed" | The contractor confirmed a suggestion. |
| `edited` | Edited | "Suggested value, changed by you" | The contractor replaced a suggestion with their own value. |

| Transition | Command | Audit event |
| --- | --- | --- |
| `empty` or any stored state to `typed` | `setFieldValue` (the form's own edits; also "Load demo project") | `field.confirmed` with `source: typed` and `proposal_id: null` |
| `empty` or any stored state to `proposed` | `proposeFieldValue` (the copilot's `propose_field_fill`) | `field.proposed` |
| `proposed` to `confirmed` | `confirmValue` (a proposal's Confirm, or "Confirm all") | `field.confirmed` with `source: proposal` |
| `proposed` to `edited` | `editValue` (a proposal's Edit then Save) | `field.edited` |
| `proposed` to the earlier stored state | `rejectValue` with `dismissed_by_contractor` (Reject) | `field.rejected` |

Rules the commands enforce:

* A suggestion equal to the value the field already holds is dropped, with `field.proposed` carrying
  `dropped_reason: equals_confirmed` and no proposal. A suggestion for a field outside the fillable list
  is dropped with `field_not_fillable`. A quote that does not verify never reaches the command: the
  copilot turn records `field.proposed` with `quote_not_verified` and no proposal.
* A suggestion never overwrites a typed or confirmed value. A different value stays a proposal, shown
  old to new, and replaces the stored value only when the contractor confirms it.
* Values can be set, suggested, confirmed, edited or dismissed only while the application is a `draft`.
* Only the contractor can confirm or edit a value on the application.

## Proposal

The sidecar record behind every suggested value, from the copilot (source `message`), from a document
(source `box`) or from a formula (source `formula`). Document values use the field key
`<slot>.<field_id>`, for example `pay_stub.gross_pay`.

| State | Meaning |
| --- | --- |
| `proposed` | Waiting for a person's decision. At most one live proposal exists per field key and source kind. |
| `confirmed` | A person (or, for the calculated annual income, the system) confirmed it. |
| `edited` | A person replaced the value with their own. Final. |
| `rejected` | The contractor dismissed it, or a reviewer flagged it with a reason. Final. |
| `superseded` | A newer proposal for the same field key and source kind replaced it. Final. |

| From | To | Command | Audit event | Who | Notes |
| --- | --- | --- | --- | --- | --- |
| (none) | `proposed` | `proposeFieldValue` | `field.proposed` | model (copilot, extraction) or system (formula) | A form value is checked against its quote first. |
| `proposed` | `confirmed` | `confirmValue` | `field.confirmed` | Contractor for form values; reviewer for document values; system for annualized income | A value that was `not_located` can be confirmed only with `located_by_reviewer: true`. A document field the model did not find (value null) cannot be confirmed. A confirmation by the contractor writes the form; a reviewer's writes review data only; the system's confirmation of `pay_stub.annualized_income` writes `verified_annual_income` with `verification_source: document_review`. No reviewer confirmation writes a `stated_*` field. |
| `proposed` | `edited` | `editValue` | `field.edited` | Contractor or reviewer | A calculated (formula) value cannot be edited, only flagged. A reviewer's correction is parsed into the field's type (money in dollars becomes cents, dates become ISO dates, an enum must be one of its options). |
| `proposed` | `rejected` | `rejectValue` | `field.rejected` | Contractor (`dismissed_by_contractor`) or reviewer (one of the flag reasons) | The flag reasons are `illegible`, `source_not_located`, `mismatch_with_stated`, `wrong_document_type`, `missing`, `pay_frequency_not_located` and `other`. |
| `proposed` | `superseded` | `proposeFieldValue` (a newer proposal, same key and source kind) | none of its own; the new `field.proposed` lists the id in `superseded_proposal_ids` | - | |
| `confirmed` | `superseded` | `proposeFieldValue` with a `formula` source | same as above | system | Only a calculated value is superseded after confirmation, when an input is corrected and the income is calculated again. |
| `confirmed` (calculated income) | still `confirmed`, but its stored verification is taken back | `withdrawVerifiedValue`, called by the review path just before the value is flagged or replaced | `field.rejected` with the system as actor, the task id and a flag reason | system | Sets `verified_annual_income` and `verification_source` back to nothing. The caller then supersedes the proposal. |

A `confirmed` proposal cannot be rejected. To flag a calculated value that is already confirmed, the
review path first replaces it with a new proposal that has no value, and the flag lands on that.

## Document and its extraction status

A document is attached to one of three slots (`pay_stub`, `estimate`, `scope_letter`). The
`extraction_status` says how reading it ended. It leaves `pending` once.

| Status | Meaning | What the reviewer sees |
| --- | --- | --- |
| `pending` | Attached; not read yet. | The review task does not exist yet. |
| `done` | Read; one proposal per field the model answered for. | A row per field, with a box where one could be drawn. |
| `failed` | The document could not be read, or the model failed after one retry. | A note: "This document could not be read automatically. Read it on the page." No values. |
| `type_mismatch` | The model said the document is not the expected type. | A note that the document does not look like the expected type, so no values were read. |
| `manual` | Extraction is switched off (`EXTRACTION_ENABLED=false`). | A note: "This document was not read automatically. Read it on the page." No values. |

| From | To | Command | Audit event |
| --- | --- | --- | --- |
| (none) | `pending` | `attachDocument` | `document.attached` |
| `pending` | `done`, `failed`, `type_mismatch` | `setExtractionStatus`, called by `extractDocument` | `extraction.completed`, with `per_field` and, for `failed` and `type_mismatch`, an `error_code` |
| `pending` | `manual` | `setExtractionStatus`, called by `openReviewTask` when extraction is switched off | `extraction.completed` |

A model failure (`llm.timeout`, `llm.rate_limited`, `llm.server_error`, `llm.schema_invalid`) gets one
retry; `llm.auth_failed` and `llm.refusal` do not. A wrong document type uses
`extraction.document_type_mismatch`. A value whose quote verified but whose words carry no position
is kept as a proposal with match method `not_located` and the error code
`extraction.source_not_located`; that is per value, not per document.

Extraction runs after submit, one document at a time, then the review task opens. With no key it
replays the committed recording `samples/extraction-fixture.json` instead of calling the model; those
`model.call` events carry `_fixture: true`.

## Review task

One task per application, with a tab per document. It is created once every document has left
`pending`, so there are no earlier states.

| Status | Meaning | Caption in the reviewer tab |
| --- | --- | --- |
| `ready` | Created; no decision yet. | "Ready for review" |
| `in_review` | At least one decision has been made. | "In review" |
| `complete` | The reviewer completed it. Final. | "Complete" |
| `extraction_failed` | Every document failed. The task has no values and can be completed at once. | "Extraction failed" |

| From | To | Command | Audit event | Notes |
| --- | --- | --- | --- | --- |
| (none) | `ready` | `createReviewTask` | `review.task_created` | Also a `tool.call` for the mocked review queue (`createIssue`, then `addLink`) |
| (none) | `extraction_failed` | `createReviewTask` | `review.task_created` | Only when every document is `failed` |
| `ready` | `in_review` | `startReview`, called with the first decision | `review.started` | Not available from `extraction_failed` |
| `ready`, `in_review` or `extraction_failed` | `complete` | `completeReview` | `review.completed` and `application.state_changed` | No proposal of the task may still be `proposed`. Open discrepancies do not block it; their count is in the event |

When extraction is switched off, the task is created `ready` with every slot `manual` and no values.

The reviewer's decisions are not stored on the task. They are the `field.confirmed`, `field.edited`
and `field.rejected` events that carry the task's id, and the task view reads them from the audit log.

A row in the reviewer view has its own display states, derived from its proposal:

| Row status | Meaning |
| --- | --- |
| "To decide" | The proposal is `proposed`. Confirm, Correct and Flag are offered; Confirm is offered only when there is a value, and with the acknowledgement "I located this on the page myself" when the value is not located. |
| "Confirmed", "Corrected", "Flagged" | The proposal is `confirmed`, `edited` or `rejected`. |
| "Waiting" | A calculated value whose inputs are not all decided. |

The location badge says "Located" (a box was drawn), "Not located" (the quote verified but no box can
be drawn), "Not found" (the model returned no value) or "Calculated" (a formula). "Complete review" is
enabled only when no value is "To decide" and no calculated value is "Waiting".

### The calculated annual income

`pay_stub.annualized_income` is never read by the model. `recomputeDerived` handles it after each
reviewer decision on its inputs, `pay_stub.gross_pay` and `pay_stub.pay_frequency`:

| Inputs | What happens | Events |
| --- | --- | --- |
| One or both still `proposed` | Nothing. The row shows "Not calculated yet". | none |
| Both `confirmed` or `edited` | Gross pay times the pay periods in a year (weekly 52, biweekly 26, semimonthly 24, monthly 12) is proposed as a `formula` proposal and confirmed by the system. The confirmation writes `verified_annual_income`. | `field.proposed`, `field.confirmed` (actor `system`) |
| One flagged, or not found | A formula proposal with no value is created and rejected: `pay_frequency_not_located` when the frequency is the missing input, `source_not_located` otherwise. | `field.proposed`, `field.rejected` |

A gross pay or pay frequency that was already decided can be corrected again. The correction goes on
a fresh proposal that carries the same value and source, and the income is calculated again: the stored
verification is withdrawn, the earlier confirmed value is superseded, and a new one is confirmed. The
reviewer can flag the calculated value but not edit it; flagging a confirmed one withdraws the
verification first, so a flagged income never stays stored as verified.

## Discrepancy record

Opened when a confirmed (or corrected) document value falls outside the tolerance for the application's
own value. Two rules exist: the annualized income differs from the stated annual income by more than
10% of the stated value or $5,000, whichever is larger (reason `income_outside_tolerance`); and the
requested loan amount exceeds the estimate total by more than 5% of the estimate (reason
`requested_amount_over_estimate`). The check runs only after the review helper has recorded a decision
or recomputed a value, never inside a command, and it raises at most one open record per value. The
tolerance is read from the document schema in `shared/document-schemas/`, and the `schemas@<hash>` in
effect is stored on the record. If the stated value is not yet a typed or confirmed number, nothing is
raised.

Stored `status` is `open` or `resolved`. The four steps below are the lifecycle; "stage" is what the
reviewer screen calls them.

| Stage | Stored as | Command | Audit event | Contractor sees |
| --- | --- | --- | --- | --- |
| Not sent | `status: open`, no `sent_at` | `raiseDiscrepancy` (called by `compareOnConfirm`) | `discrepancy.raised` | Nothing |
| Waiting for a reply | `status: open`, `sent_at` set; `question.text` is the reviewer's final text | `sendDiscrepancyQuestion` | `discrepancy.sent` | The banner and the question, with a reply box |
| Reply received | `status: open`, `contractor_reply` set | `replyToDiscrepancy` | `discrepancy.replied` | The banner, with their reply |
| Resolved | `status: resolved`, `resolution` (`explained` or `corrected`), `resolver`, `note` | `resolveDiscrepancy` | `discrepancy.resolved` | The banner goes (when no other record is open) |

Rules the commands enforce:

* A record can be raised only after the application is submitted. Both value pointers must resolve
  inside the application: the extracted value to one of its proposals, the stated value to a form
  field or to a confirmed proposal.
* The question text starts as the template for the reason code (fixed text, never model text) and the
  reviewer may edit it before sending. It can be sent once.
* A reply needs a record that is open and sent, and can be given once.
* A record can be resolved only after its question was sent, with a non-empty note. A reply is not
  required. `explained` means both values stand and the note says why. `corrected` means the reply gave
  a corrected figure, which goes in the note; the stated value itself changes through the portal's
  existing process, outside this system, so the application keeps its two write paths.
* Resolving does not change any stored value, and no record is deleted.
* Completing the review does not wait for open records. The banner stays while a record is open, and
  the reviewer can still send and resolve after the task is `complete`.
