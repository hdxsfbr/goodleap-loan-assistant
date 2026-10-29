# Deployment guide

The prototype is one Node process that serves the API and the built web app. This page covers
running it locally, running it as a container, and what changes for GoodLeap's production stack
(the internal design's section 10 is the full plan).

## Local

Node 22 or newer (24 was used for the build).

```bash
npm install
```

```bash
cp .env.example .env
```

Set `ANTHROPIC_API_KEY` in `.env`. An Anthropic key works as is; an OpenRouter key also needs
`ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1`. Values in `.env` override variables exported by
the shell.

```bash
npm start
```

`npm start` builds the web app and starts the server on port 3000 (`PORT=3001 npm start` for another
port). The health endpoint is `GET /api/healthz`; it reports whether a key is present (never the key),
the content hashes of every artifact that shapes behavior, and the model ids in use.

Without a key the app starts, the calculator, the form, the reviewer screen (from the committed
extraction fixture) and the audit page work, and the chat input is disabled with a banner.

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | For the model features | Anthropic or OpenRouter key. Never logged; never sent to the browser. |
| `ANTHROPIC_BASE_URL` | No | Set to `https://openrouter.ai/api/v1` for an OpenRouter key; a trailing `/v1` is stripped because the SDK appends `/v1/messages`. |
| `PORT` | No | Defaults to 3000. |
| `COPILOT_ENABLED` | No | `false` turns the copilot off; the panel says so and the calculator button still works. |
| `EXTRACTION_ENABLED` | No | `false` skips extraction on submit; the review task opens with every document marked for manual reading. |

## Container

A minimal image: `node:22-alpine`, `npm ci`, `npm run build`, `CMD ["npx", "tsx", "server/index.ts"]`,
port 3000 exposed, the five variables above injected by the platform (never baked into the image).
The process writes `data/audit.jsonl` in its working directory; mount a volume there or accept that
the file is truncated at each boot, as the prototype does (the store is in memory and reseeds).

## What changes for production

The internal design, section 10, places each piece on GoodLeap's stack. In short:

* The in-memory store becomes four RDS tables (proposals, discrepancies, review tasks, audit
  events) written only through the same commands; the audit table is INSERT-only.
* Large artifacts (raw prompts, rendered views) move to one S3 prefix and are referenced by key.
* Extraction runs in an SQS consumer; the image adapter becomes AWS Textract behind the same
  positioned-text interface; the committed OCR file is only for the sample pay stub.
* The typed mocks (catalog, contractor profile, documents, review queue) become clients of the
  real services; the credit decision engine stays uncalled. The review queue mock becomes the Jira
  Service Management update.
* The copilot and extraction flags become per-contractor flags; rollout and rollback are flag
  flips with no data migration (submission document, section 5).
* Model calls keep their pinned ids and the versions block on every audit event; every artifact
  version change passes the eval gates in `docs/evals.md` before it is enabled.
