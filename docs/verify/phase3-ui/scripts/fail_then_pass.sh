#!/usr/bin/env bash
# For each task commit: put its non-test source files back to the parent commit (new files are removed), run that
# commit's tests (they must fail), then restore the files and run them again (they must pass).
# From the repo root, on a clean tree: bash docs/verify/phase3-ui/scripts/fail_then_pass.sh <commits>
set -u
cd "$(git rev-parse --show-toplevel)"
if [ -n "$(git status --porcelain -- packages)" ]; then echo "packages/ has uncommitted changes; refusing"; exit 2; fi
for c in "$@"; do
  echo "=== $(git log --oneline -1 "$c")"
  tests=$(git diff --name-only "$c^" "$c" -- 'packages/web/src' | grep -E '\.test\.tsx?$' | sed 's#^packages/web/##')
  srcs=$(git diff --name-only "$c^" "$c" -- 'packages/web/src' | grep -vE '\.test\.tsx?$')
  echo "tests: $(echo $tests)"
  echo "source put back: $(echo $srcs)"
  for f in $srcs; do
    if git cat-file -e "$c^:$f" 2>/dev/null; then git show "$c^:$f" > "$f"; else rm -f "$f"; fi
  done
  echo "--- without the change"
  (cd packages/web && npx vitest run $tests 2>&1 | grep -E '✓|×|FAIL|Test Files|Tests ' | sed -E 's/ [0-9]+ms$//' | head -40)
  git checkout -q -- packages
  echo "--- with the change"
  (cd packages/web && npx vitest run $tests 2>&1 | grep -E 'Test Files|Tests ')
  echo
done
