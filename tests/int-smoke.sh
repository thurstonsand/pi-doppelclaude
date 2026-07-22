#!/usr/bin/env bash
# Smoke tests for pi-claude-bridge provider.
# Requires: pi CLI, Claude Code (for Agent SDK subprocess).

source "$(dirname "$0")/lib/bash-setup.sh"
source "$(dirname "$0")/lib/timeout.sh"

echo "=== smoke-test.sh ==="

setup_test_env "smoke-test"

TIMEOUT=60
PASS=0
FAIL=0

TEST_CWD_PREFIX="$LOGDIR/smoke-cwd."
TEST_CWD=$(mktemp -d "$TEST_CWD_PREFIX"XXXXXX)
mkdir -p "$TEST_CWD/.pi"
cd "$TEST_CWD"
cleanup() {
  if [[ "${TEST_CWD:-}" == "$TEST_CWD_PREFIX"* && ${#TEST_CWD} -gt ${#TEST_CWD_PREFIX} && -d "$TEST_CWD" ]]; then
    rm -rf -- "$TEST_CWD"
  fi
  kill_descendants
}
trap cleanup EXIT

run() {
  local name="$1"; shift
  local slug
  slug=$(echo "$name" | tr ' :,' '-' | tr -cd '[:alnum:]-')
  local logfile="$LOGDIR/$slug.log"
  printf "%-50s " "$name"
  if output=$(timeout "$TIMEOUT" "$@" 2>&1); then
    echo "$output" > "$logfile"
    if [ -n "$output" ]; then
      echo "PASS"
      ((++PASS))
    else
      echo "FAIL (empty output)"
      echo "  Log: $logfile"
      ((++FAIL))
    fi
  else
    local rc=$?
    echo "${output:-}" > "$logfile" 2>/dev/null || true
    echo "FAIL (exit $rc)"
    echo "  Log: $logfile"
    ((++FAIL))
  fi
  kill_descendants
}

# --- Tests ---

# Assert an exact, trimmed, case-insensitive `yes` line — not a substring — so
# `yesterday`, explanatory prose, or a `Not logged in · Please run /login` banner
# all fail instead of passing.
run "provider: print mode responds" \
  bash -c "pi --no-session -ne -e '$DIR' --model 'anthropic/claude-sonnet-4-6' -p 'Reply with only the word yes' 2>&1 | grep -qiE '^[[:space:]]*yes[[:space:]]*\$' && echo ok"

run "provider: --provider flag works" \
  bash -c "pi --no-session -ne -e '$DIR' --provider anthropic -p 'Reply with only the word yes' 2>&1 | grep -qiE '^[[:space:]]*yes[[:space:]]*\$' && echo ok"

run "provider: model list includes provider" \
  bash -c "pi --no-session -ne -e '$DIR' --list-models 2>&1 | grep -Eq '^anthropic[[:space:]]+claude-sonnet-4-6[[:space:]]' && echo ok"

# --- Summary ---

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
