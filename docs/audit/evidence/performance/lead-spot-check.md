# Performance: lead spot-check (2026-10-29)

| Claim | Re-checked by | Result |
| --- | --- | --- |
| PERF-MED-007: about 12 ms per 1,000 events per `audit.list()` | `audit-list-clone-cost.mjs` over data/audit.jsonl from a local run (127 real events, copied as independent objects) | 1.3 / 12.2 / 45.0 ms at 127 / 1,270 / 5,080 events. A first attempt with shared references under-measured (1.2 ms at 5,080) and was discarded |
| PERF-MED-008: no page cap | Read uploads.ts, pdfjs.ts, ocr-tesseract.ts:309, prompt.ts:48 | Code confirmed. No load test |
