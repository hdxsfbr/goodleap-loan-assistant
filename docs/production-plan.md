# Production plan: scaling the prototype to GoodLeap's stack

**Author:** Andre Batista · **Date:** 2026-10-29 · **Builds on:** the [internal design](designs/loan-assistant-design.md), section 10 (where each piece sits on the existing stack), the [submission document](design-document.md), section 5 (rollout phases), and the [deployment guide](deployment.md) (running the prototype).

The prototype is one Node process with an in-memory store, a JSONL audit file, an in-process
extraction queue, tesseract.js OCR and typed mocks for the five internal APIs. This page is the
plan to take it to production on the stack the brief describes, in the order that keeps the copilot
shippable first and every step reversible by a flag.

## 1. What the brief tells us about the stack

| Layer | Existing system | What it means for this plan |
| --- | --- | --- |
| Partner portal | React web app | The four screens are React components inside the portal, under its session |
| Backend | TypeScript / Node.js | The assistant API is a route group in that service; no new language or runtime |
| Cloud | AWS: ECS, RDS Postgres, S3, SQS | ECS services for the API and the extraction consumer; four RDS tables; one S3 prefix; the existing document-uploaded SQS message |
| Data warehouse | Snowflake | The new tables join the existing ETL; the funnel analytics give the control-group comparison |
| AI platforms | Anthropic, OpenAI | Anthropic for the three model roles; OpenAI for a decorrelated judge later |
| Automation and ops | Zapier, Jira Service Management | JSM stays the queue of record; Zapier stays out of the critical path |
| Productivity | Microsoft 365 | Entra ID for the internal reviewer and audit screens |
| Source control | GitHub | GitHub Actions for the test suite, the eval gates and the ECS deploy |
| Internal APIs | Product catalog, credit decision engine, Plaid, contractor profile, document management | Clients replace the typed mocks; the credit decision engine is never called |

Two constraints from the stakeholders shape the plan as much as the stack: a small engineering
team that must operate the result, and Compliance's requirement that every borrower-facing
interaction is reconstructable.

## 2. What maps where

| Prototype | Production |
| --- | --- |
| Express routes in one process | A route group in the existing backend service on ECS, behind the existing load balancer, stateless |
| In-memory store reseeded at boot | Four new RDS tables: `ai_field_proposals`, `discrepancies`, `review_tasks`, `audit_events`. The applications table is untouched; confirmed values arrive through the portal's two existing write paths |
| `data/audit.jsonl` | The audit table written by an INSERT-only database role. Raw prompts, rendered homeowner views and uploaded documents in one S3 prefix with Object Lock, referenced by key |
| In-process extraction queue | A separate ECS service consuming the existing document-uploaded SQS message, with a dead-letter queue whose entries become manual-extraction tasks (today's path) |
| tesseract.js inside the server process | AWS Textract behind the same positioned-text adapter; the committed OCR file stays for the sample pay stub only |
| Typed mocks | Clients for the catalog, contractor profile, document management and JSM, selected by the composition root per environment |
| `COPILOT_ENABLED`, `EXTRACTION_ENABLED` | A per-contractor copilot flag read from the contractor profile service with a 30-second cache; a global extraction flag with a document-type allowlist |
| No login, three role tabs | Contractor and homeowner views inside the portal session; reviewer and audit views behind internal SSO through Entra ID |
| Conversation window in process memory | Rebuilt per turn from the session's audit events in RDS, so any ECS task can serve any turn |
| OpenRouter | Anthropic directly under an enterprise agreement, or Bedrock inside GoodLeap's AWS account (section 5) |
| Audit file truncated at boot | Append-only forever; retention set by Compliance (section 5) |

## 3. Workstreams and timeline

| Phase | Weeks | Gate to advance | Rollback |
| --- | --- | --- | --- |
| A. Foundations | 2 to 3 | Staging deploy green; eval gates wired into CI; real clients pass contract tests | n/a |
| B. Internal, copilot only | 1 | Compliance signs off on the template, deny-list and fallback texts | Flags off |
| C. Pilot: about 20 contractors in one region, pay-stub extraction | 2 | No guardrail false negative in sampled transcripts; fallback under 5% of turns; correction rate per field known | Flags off |
| D. Expansion: 10% of contractors, all document types | 4 | Completion time and product-selection abandonment better flag-on than flag-off; queue time within the reviewer SLA | Back to the pilot list |
| E. Default on, per-contractor opt-out | ongoing | Monthly metric review | Per contractor or global off |

Phases B through E are the rollout in the submission document. Phase A is the integration work
the prototype skipped, and it is where the engineering time goes:

* **Infrastructure as code.** The tables, the S3 prefix, the SQS consumer's queue and dead-letter
  queue, a Secrets Manager entry for the model key, IAM roles (the INSERT-only audit role among
  them) and the two ECS services, in whatever Terraform or CDK already deploys the portal.
* **CI on GitHub Actions.** The no-key suite on every pull request. The keyed eval set on merge to
  main and whenever a behavior-shaping artifact's content hash changes (catalog, prompts,
  deny-list, template, document schemas). A flag can be enabled only on a build whose eval run
  passed; the build id is stamped on every audit event beside the model ids.
* **Real clients.** The composition root already selects mocks versus real; the work is the five
  clients and their contract tests against staging. The catalog client replaces the file; the
  contractor profile client serves the flag; document management provides the upload and its SQS
  message; the JSM client adds the `ai-prefilled` or `ai-unavailable` label and the review link to
  the issue today's path creates.
* **Auth and flags.** Contractor identity from the portal session, which also names the
  contractor on every audit event. The reviewer and audit screens on internal SSO with a role
  check. Flag reads cached so the profile service is never on a turn's critical path.
* **Streaming through the load balancer.** The explanation streams over server-sent events; the
  ALB idle timeout must sit above the turn budget, and the API must end the stream on a client
  disconnect so a closed tab does not keep a model call running.
* **Observability.** CloudWatch logs carry ids, event types, versions, error codes, latencies and
  token counts only; never prompt or document text. Spans carry `application_id`, `session_id`,
  `turn_id` and `event_id`. Dashboards and alerts for the metrics in the design's section 13:
  block rate per check, disagreement between checks, fallback rate, judge-unavailable rate,
  latency p95 per step, proposal edit rate, reviewer correction rate and magnitude, queue time.
* **Snowflake.** The four tables join the existing ETL. The pilot allowlist is the control group:
  completion time and abandonment at product selection, flag on versus flag off, from the funnel
  that already exists.

With two engineers, the whole path to default-on is about twelve weeks. The copilot can reach
internal users in about three, because it writes nothing to the applications table and ships
behind a flag that defaults off.

## 4. Scaling the load

| Quantity | Figure | Source |
| --- | --- | --- |
| Started applications per business day | 400 to 600 | Design, section 9 (assumption from the origination volume) |
| Sessions in flight at the peak hour | 100 to 150 | Design, section 9 |
| Model calls per copilot turn | 2, plus one Haiku judge call | Design, section 4.1 |
| Cost per application (ten turns, three documents) | about $0.30 | Design, section 9 |
| Annual model spend at 150K applications | about $45K | Design, section 9 |

* **The API is light.** Two or three ECS tasks per availability zone, scaling on CPU and open
  streaming connections, cover the peak hour with headroom.
* **Model throughput is the binding external limit.** It is input tokens per minute, and the
  cached prefix keeps the fresh part of each call to about 2K tokens. Ask Anthropic for a rate
  tier sized to the peak with headroom, alert on 429s, and keep the no-model "Show payment
  options" button as the floor during throttling or an outage.
* **Extraction scales with queue depth.** The consumer service autoscales on SQS backlog;
  Textract's asynchronous API handles multi-page documents. The idempotency key is document id
  plus schema version plus prompt version, because SQS delivers at least once.
* **Reviewers are the real constraint.** Extraction workers scale and reviewers do not. The
  queue-time SLA alert, the unchanged manual path, and a month-end staffing plan are the
  mitigation; the design says this is the constraint, not model spend.
* **Postgres stays small.** The four tables are append-mostly. Index on application id and
  time, partition `audit_events` by month, and archive partitions to S3 Glacier once the
  retention period Compliance sets has passed.
* **Cost at ten times the volume** stays under the reviewer cost at any plausible rate; the levers
  if it ever matters are a smaller model for the explanation step (not the extraction step) and a
  shorter conversation window, both gated by the eval sets.

## 5. Compliance and data handling

* **PII reaches the model vendor on every turn.** Two acceptable paths: direct Anthropic with
  zero-data-retention terms and a data processing agreement, or Amazon Bedrock, which keeps
  traffic inside GoodLeap's AWS account and VPC with no retention. The SDK supports both from the
  single client import site. Recommendation: Bedrock if the security team requires data to stay
  in-account; direct Anthropic otherwise, since new models land there first. Decide before
  phase B, because the pinned model ids and the eval runs depend on it.
* **Send only what the model needs.** SSN, date of birth and account numbers never enter a
  prompt. The copilot context is the subset of the form needed for products and payments; the
  extraction prompt is the document's positioned text and the schema for its type.
* **Storage controls.** KMS encryption at rest on RDS and S3, Object Lock on the audit prefix,
  role-based access to the audit view, the INSERT-only role for audit rows. Three stores, three
  policies: audit records with full content and long retention; operational logs with ids only
  for 30 to 90 days; aggregates in Snowflake.
* **Retention.** Compliance sets the number, with the Reg Z two-year floor and Reg B's 25 months
  as the reference points. The archive job is part of phase A so the policy exists before the
  first real event is written.
* **Change control.** Model ids and artifact hashes are stamped on every event. A model, prompt,
  catalog, deny-list, template or schema change passes the eval gates and a Compliance review
  before its flag flips. Rollback is a flag flip with no data migration, because AI output never
  wrote to the application directly; affected proposals are enumerated from the versions block
  and marked superseded, and homeowner views shown under a bad version are listed for Compliance
  from the audit table.
* **The credit decision engine stays uncalled.** The audit page's call count reads zero in
  production as it does in the prototype, and a test asserts it.

## 6. Code changes before production

* Merge the duplicate extraction client into the single LLM client and re-record the fixture
  (the first cleanup noted in the build log).
* Validate the flag reason on the decisions route instead of accepting the system-only value.
* Per-contractor rate limiting and idempotency keys on copilot turns, so a double tap on a tablet
  does not run a turn twice.
* Token streaming for the explanation, which the design describes and the prototype does not build.
* Clear the `npm audit` advisories and pin Node 22 LTS in the container image.
* Grow the judge set from 20 to at least 100 labeled cases before the pilot, so its recall and
  false-positive thresholds are measurable; the demo takes showed the judge blocking benign
  explanations, which the grown set will quantify.
* A decorrelated judge on OpenAI, which GoodLeap already has, as the first guardrail follow-up.

## 7. Decisions GoodLeap owns

| Decision | Needed by | Default if undecided |
| --- | --- | --- |
| Bedrock or direct Anthropic | Phase B | Direct Anthropic with zero-data-retention terms |
| Audit retention period | Phase A | Reg B's 25 months |
| Reviewer queue-time SLA and month-end staffing | Phase C | Median under one business day |
| Rule when Plaid and a pay stub both exist for one field | Phase C | Two sources under the per-field rule; the reviewer resolves conflicts |
| Where the reviewer screen lives: the portal or an internal tool | Phase A | A route in the portal behind the internal SSO role |
| Final wording of the disclosure template, deny-list and fallback texts | Phase B | The Compliance-owned placeholders in the design's Fixed texts section |
