#!/usr/bin/env bash
# Bundles repository changes, plus named line ranges of the internal design, into one text
# stream for an independent reviewer that cannot run commands (codex's sandbox cannot start on
# this machine). Binary files and lockfiles are left out.
#
# Usage: scripts/review-bundle.sh [START-END ...] [-- FILE ...] > bundle.txt
#   START-END  a line range of docs/designs/loan-assistant-design.md to include
#   FILE ...   after "--": only these files, printed in full (tracked files also get their diff)
#   Without "--", every uncommitted change is included: the diff of tracked files and the full
#   content of untracked files.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
DESIGN=docs/designs/loan-assistant-design.md

ranges=()
files=()
mode=ranges
for arg in "$@"; do
  if [ "$arg" = "--" ]; then mode=files; continue; fi
  if [ "$mode" = ranges ]; then ranges+=("$arg"); else files+=("$arg"); fi
done

echo "# git status --short"
git status --short
echo

for range in "${ranges[@]}"; do
  echo "===== $DESIGN lines $range ====="
  sed -n "${range/-/,}p" "$DESIGN"
  echo
done

if [ "${#files[@]}" -gt 0 ]; then
  for f in "${files[@]}"; do
    if git ls-files --error-unmatch "$f" >/dev/null 2>&1; then
      echo "===== $f (diff against HEAD) ====="
      git diff -- "$f"
      echo
    fi
    echo "===== $f (full content) ====="
    cat "$f"
    echo
  done
  exit 0
fi

echo "# Diff of tracked files (excluding the design document)"
git diff -- . ":(exclude)$DESIGN"
echo

echo "# Untracked files, full content"
git ls-files --others --exclude-standard \
  | grep -v -E '\.(pdf|png|jpg)$|package-lock\.json$|^docs/' \
  | while read -r f; do
      echo "===== $f ====="
      cat "$f"
      echo
    done
