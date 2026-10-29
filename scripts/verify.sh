#!/usr/bin/env bash
# Builds, runs the test suite, boots the server on a spare port, checks the health endpoint and,
# when playwright-core is resolvable, drives the browser walk (scripts/ui-walk.mjs). Prints one
# summary line per step and exits non-zero if any step fails.
#
# Usage: bash scripts/verify.sh [--port N] [--no-walk] [--out DIR] [--turn "text"]...
#   --port N     port for the throwaway server (default 3470)
#   --no-walk    skip the browser walk (it needs google-chrome and playwright-core; set NODE_PATH
#                to a directory whose node_modules holds playwright-core, or let the script look
#                for ./node_modules/playwright-core)
#   --out DIR    where logs and screenshots go (default ./verify-out, gitignored)
#   --turn TEXT  passed through to the walk (repeatable; the walk has defaults)
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

PORT=3470; WALK=1; OUT=./verify-out; TURNS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --no-walk) WALK=0; shift ;;
    --out) OUT="$2"; shift 2 ;;
    --turn) TURNS+=(--turn "$2"); shift 2 ;;
    *) echo "unknown flag $1" >&2; exit 2 ;;
  esac
done
mkdir -p "$OUT"
status=0
say() { printf '%-8s %s\n' "$1" "$2"; }

npm run build > "$OUT/build.log" 2>&1 && say ok "build (log: $OUT/build.log)" || { say FAIL "build (see $OUT/build.log)"; status=1; }
npm test > "$OUT/test.log" 2>&1 && say ok "tests: $(grep -E '^ *Tests ' "$OUT/test.log" | tr -s ' ' | sed 's/^ //')" || { say FAIL "tests (see $OUT/test.log)"; status=1; }

if lsof -t -i:"$PORT" > /dev/null 2>&1; then
  say FAIL "port $PORT is already in use (pid $(lsof -t -i:"$PORT" | head -1)); pass --port or stop that process"
  exit 1
fi
PORT="$PORT" npm start > "$OUT/server.log" 2>&1 < /dev/null &
server_pid=$!
up=0
for _ in $(seq 1 40); do
  sleep 0.5
  if curl -sf "http://localhost:$PORT/api/healthz" > "$OUT/healthz.json" 2>/dev/null; then up=1; break; fi
done
if [ "$up" = 1 ]; then
  say ok "server on :$PORT, key present: $(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["has_llm_key"])' "$OUT/healthz.json")"
else
  say FAIL "server did not answer on :$PORT (see $OUT/server.log)"; status=1
fi

if [ "$WALK" = 1 ] && [ "$up" = 1 ]; then
  if [ -z "${NODE_PATH:-}" ] && [ -d ./node_modules/playwright-core ]; then export NODE_PATH=./node_modules; fi
  if node -e "require('playwright-core')" > /dev/null 2>&1 && command -v google-chrome > /dev/null; then
    if node scripts/ui-walk.mjs --base "http://localhost:$PORT" --out "$OUT/walk" "${TURNS[@]}" > "$OUT/walk.log" 2>&1 < /dev/null \
       && ! grep -q -E '^FAIL|pageerror|console.error' "$OUT/walk.log"; then
      say ok "browser walk ($(grep -c '^screenshot' "$OUT/walk.log") screenshots in $OUT/walk)"
    else
      say FAIL "browser walk (see $OUT/walk.log)"; status=1
    fi
  else
    say skip "browser walk (needs google-chrome and playwright-core on NODE_PATH)"
  fi
fi

# npm start runs "vite build && tsx server/index.ts" in a subshell, so kill the listener by port
# as well as the npm process, or the tsx child outlives this script and blocks the next run.
lsof -t -i:"$PORT" 2>/dev/null | xargs -r kill 2>/dev/null
kill "$server_pid" 2>/dev/null; wait "$server_pid" 2>/dev/null
exit $status
