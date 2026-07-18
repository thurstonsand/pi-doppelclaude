#!/usr/bin/env bash
# Smoke tests for pi-claude-bridge provider.
# Requires: pi CLI, Claude Code (for Agent SDK subprocess).
# Requires: CLAUDE_BRIDGE_TESTING_ALT_PROVIDER / CLAUDE_BRIDGE_TESTING_ALT_MODEL

source "$(dirname "$0")/lib/bash-setup.sh"

echo "=== smoke-test.sh ==="

setup_test_env "smoke-test"

ALT_PROVIDER=$(require_env CLAUDE_BRIDGE_TESTING_ALT_PROVIDER)
ALT_MODEL=$(require_env CLAUDE_BRIDGE_TESTING_ALT_MODEL)

TIMEOUT=60
PASS=0
FAIL=0

TEST_CWD_PREFIX="$LOGDIR/smoke-cwd."
TEST_CWD=$(mktemp -d "$TEST_CWD_PREFIX"XXXXXX)
mkdir -p "$TEST_CWD/.pi"
printf '{"askClaude":{"enabled":true}}\n' > "$TEST_CWD/.pi/claude-bridge.json"
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
  local slug=$(echo "$name" | tr ' :,' '-' | tr -cd '[:alnum:]-')
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

run "provider: print mode responds" \
  pi --no-session -ne -e "$DIR" \
  --model "anthropic/claude-sonnet-4-6" \
  -p "Reply with just the word 'yes'"

run "provider: --provider flag works" \
  pi --no-session -ne -e "$DIR" \
  --provider anthropic \
  -p "Reply with just the word 'yes'"

run "provider: model list includes provider" \
  bash -c "pi --no-session -ne -e '$DIR' --list-models 2>&1 | grep -Eq '^anthropic[[:space:]]+claude-sonnet-4-6[[:space:]]'"

# AskClaude is only usable when the active model is not already routed through Claude Code.
run "tool: AskClaude registered" \
  bash -c "pi --no-session -ne -e '$DIR' --mode json --provider '$ALT_PROVIDER' --model '$ALT_MODEL' -p 'list your tools' 2>&1 | grep -q AskClaude && echo ok"

# AskClaude e2e: force a non-Claude model to call the tool and check for a tool result
run "tool: AskClaude responds" \
  bash -c "pi --no-session -ne -e '$DIR' --provider '$ALT_PROVIDER' --model '$ALT_MODEL' --mode json \
    -p 'Use the AskClaude tool with prompt=\"What is 2+2? Reply with just the number.\" and then tell me the answer.' 2>&1 \
    | grep -q '\"toolName\":\"AskClaude\"' && echo ok"

# --- Summary ---

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
