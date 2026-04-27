#!/usr/bin/env bash
# Cumulative zero-dep test sweep.
# Runs every test-*.ts that doesn't need a DB / network / discord client,
# parses pass/fail counts in 3 formats, and reports a workspace total.
#
# Usage: ./scripts/sweep-zero-dep-tests.sh
# Exit 0 if all green, 1 if any test file fails or contains FAILs.

set -u
cd "$(dirname "$0")/.."

# Files known to need DB / live infra. Skip them in the zero-dep sweep.
SKIP_PATTERNS=(
  test-auth.ts                    # needs running API + DB
  test-auth-cleanup.ts            # needs DB
  test-auth-coverage.ts           # needs DB
  test-deploy.ts                  # needs GCP creds
  test-build-log-live.ts          # needs Cloud Build
  test-event-stream.ts            # needs running API
  test-llm-analysis.ts            # needs Anthropic key
  test-pipeline.ts                # needs GCP
  test-timeline-route.ts          # needs running API
  test-diagnostics.ts             # needs running API
  test-env-vars-update.ts         # needs Cloud Run
  test-post-canary.ts             # needs Cloud Run
  test-publish-split.ts           # needs DB
  test-stage-events.ts            # needs running API
  test-transaction.ts             # needs DB
)

skip_match() {
  local f="$1"
  for p in "${SKIP_PATTERNS[@]}"; do
    [[ "$f" == *"$p" ]] && return 0
  done
  return 1
}

declare -i TOTAL_PASS=0
declare -i TOTAL_FAIL=0
declare -i FILES_OK=0
declare -i FILES_BAD=0
FAILED_FILES=()

run_one() {
  local file="$1"
  local cwd="$2"
  local out
  out=$(cd "$cwd" && bun "$file" 2>&1)
  local rc=$?

  # Format A: === N passed, M failed ===
  local p=$(echo "$out" | grep -oE '=== [0-9]+ passed, [0-9]+ failed ===' | tail -1 | awk '{print $2}')
  local f=$(echo "$out" | grep -oE '=== [0-9]+ passed, [0-9]+ failed ===' | tail -1 | awk '{print $4}')

  # Format B: SUMMARY-line "PASS: N" + "FAIL: M" with explicit numeric counts.
  # Look for them on consecutive-ish lines; require BOTH "PASS:" and "FAIL:"
  # to be followed by ONLY a number (excludes per-test "PASS: <name>" lines).
  if [[ -z "$p" ]]; then
    p=$(echo "$out" | grep -oE '^(PASS|PASSED|Pass):[[:space:]]+[0-9]+[[:space:]]*$' | tail -1 | grep -oE '[0-9]+' | tail -1)
    f=$(echo "$out" | grep -oE '^(FAIL|FAILED|Fail):[[:space:]]+[0-9]+[[:space:]]*$' | tail -1 | grep -oE '[0-9]+' | tail -1)
  fi

  # Format C: N/M tests passed
  if [[ -z "$p" ]]; then
    local nm
    nm=$(echo "$out" | grep -oE '[0-9]+/[0-9]+ tests passed' | tail -1)
    if [[ -n "$nm" ]]; then
      p=$(echo "$nm" | awk -F/ '{print $1}')
      local total=$(echo "$nm" | awk -F'[/ ]' '{print $2}')
      f=$((total - p))
    fi
  fi

  # Format D: "All <name> tests passed ✓" or similar — treat as success but
  # rely on a sibling "PASSED: N" line for the count.
  if [[ -z "$p" ]]; then
    local pn
    pn=$(echo "$out" | grep -oE '✓ ([0-9]+)/([0-9]+)' | tail -1 | grep -oE '[0-9]+' | head -1)
    if [[ -n "$pn" ]]; then
      p="$pn"
      f="0"
    fi
  fi

  if [[ -z "$p" ]]; then
    echo "?  $file (no parseable summary; rc=$rc)"
    FILES_BAD+=1
    FAILED_FILES+=("$file (no summary)")
    return 1
  fi

  TOTAL_PASS+=$p
  TOTAL_FAIL+=$f

  if [[ "$f" -eq 0 && "$rc" -eq 0 ]]; then
    echo "✓  $file ($p/$p)"
    FILES_OK+=1
  else
    echo "✗  $file ($p passed, $f failed, rc=$rc)"
    FILES_BAD+=1
    FAILED_FILES+=("$file ($f failed)")
  fi
}

echo "=== Zero-dep test sweep ==="
for f in apps/api/src/test-*.ts; do
  base=$(basename "$f")
  if skip_match "$base"; then
    echo "−  $base (skipped: needs live infra)"
    continue
  fi
  run_one "src/$base" apps/api
done

for f in apps/bot/src/test-*.ts; do
  base=$(basename "$f")
  if skip_match "$base"; then
    echo "−  $base (skipped: needs live infra)"
    continue
  fi
  run_one "src/$base" apps/bot
done

# Round 38: shared-package tests (pure helpers like permission-check that
# both apps depend on). Always run from packages/shared cwd so relative
# imports resolve consistently.
for f in packages/shared/src/test-*.ts; do
  [[ -e "$f" ]] || continue   # nothing matched → skip silently
  base=$(basename "$f")
  if skip_match "$base"; then
    echo "−  $base (skipped: needs live infra)"
    continue
  fi
  run_one "src/$base" packages/shared
done

echo ""
echo "=== Total: $TOTAL_PASS passed, $TOTAL_FAIL failed across $((FILES_OK + FILES_BAD)) files ==="
if [[ "$FILES_BAD" -gt 0 ]]; then
  echo "Failed/broken files:"
  for ff in "${FAILED_FILES[@]}"; do echo "  - $ff"; done
  exit 1
fi
exit 0
