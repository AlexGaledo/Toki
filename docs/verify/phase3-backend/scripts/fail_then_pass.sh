#!/usr/bin/env bash
# For each task commit: put its non-test source files (hub and shared) back to the parent commit (new files are
# removed), run that commit's hub tests (they must fail), then restore the files and run them again (they must pass).
# From the repo root, on a clean packages/ tree: bash docs/verify/phase3-backend/scripts/fail_then_pass.sh <commits>
set -u
cd "$(git rev-parse --show-toplevel)"
if [ -n "$(git status --porcelain -- packages)" ]; then echo "packages/ has uncommitted changes; refusing"; exit 2; fi
for c in "$@"; do
  echo "=== $(git log --oneline -1 "$c")"
  tests=$(git diff --name-only "$c^" "$c" -- 'packages/hub/src' | grep -E '\.test\.ts$' | sed 's#^packages/hub/##')
  srcs=$(git diff --name-only "$c^" "$c" -- 'packages/hub/src' 'packages/shared/src' | grep -vE '\.test\.ts$')
  echo "tests: $(echo $tests)"
  echo "source put back: $(echo $srcs)"
  for f in $srcs; do
    if git cat-file -e "$c^:$f" 2>/dev/null; then git show "$c^:$f" > "$f"; else rm -f "$f"; fi
  done
  echo "--- without the change"
  (cd packages/hub && npx vitest run $tests 2>&1 | grep -E '✓|×|FAIL|Test Files|Tests |Error:' | sed -E 's/ [0-9]+ms$//' | head -60)
  git checkout -q -- packages
  echo "--- with the change"
  (cd packages/hub && npx vitest run $tests 2>&1 | grep -E 'FAIL|Test Files|Tests ')
  echo
done
