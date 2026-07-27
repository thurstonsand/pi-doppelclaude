#!/usr/bin/env bash
# Smoke tests for pi-doppelclaude provider.
# Requires: pi CLI, Claude Code (for Agent SDK subprocess).

source "$(dirname "$0")/lib/bash-setup.sh"
source "$(dirname "$0")/lib/timeout.sh"

echo "=== smoke-test.sh ==="

setup_test_env "smoke-test"
require_command claude

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

cat > "$PI_CODING_AGENT_DIR/models.json" <<'JSON'
{
  "providers": {
    "doppelclaude": {
      "modelOverrides": {
        "claude-sonnet-5": { "contextWindow": 200000 }
      },
      "models": [
        { "id": "claude-future-9-9", "api": "doppelclaude", "baseUrl": "claude-code://local" }
      ]
    }
  }
}
JSON

# Assert an exact, trimmed, case-insensitive `yes` line — not a substring — so
# `yesterday`, explanatory prose, or a `Not logged in · Please run /login` banner
# all fail instead of passing.
run "provider: print mode responds" \
  bash -c "pi --no-session -ne -e '$DIR' --model 'doppelclaude/claude-haiku-4-5' -p 'Reply with only the word yes' 2>&1 | grep -qiE '^[[:space:]]*yes[[:space:]]*\$' && echo ok"

run "provider: --provider flag works" \
  bash -c "pi --no-session -ne -e '$DIR' --provider doppelclaude --model claude-haiku-4-5 -p 'Reply with only the word yes' 2>&1 | grep -qiE '^[[:space:]]*yes[[:space:]]*\$' && echo ok"

# Startup replays the cached catalog without asking Claude Code, so the sandbox must offer the
# models its copied store recorded.
run "provider: cached catalog is replayed without a probe" \
  bash -c "[ \"\$(pi --no-session -ne -e '$DIR' --list-models 2>&1 | grep -Ec '^doppelclaude[[:space:]]+claude-')\" -ge 3 ] && echo ok"

run "provider: dynamic model list includes Opus 5" \
  bash -c "pi --no-session -ne -e '$DIR' --list-models 2>&1 | grep -Eq '^doppelclaude[[:space:]]+claude-opus-5[[:space:]]+1M[[:space:]]+128K[[:space:]]' && echo ok"

# Claude Code advertises Haiku only as a dated snapshot; it must be cached as the family model.
run "provider: dated snapshot resolves to its family model" \
  bash -c "output=\$(pi --no-session -ne -e '$DIR' --list-models 2>&1) && grep -Eq '^doppelclaude[[:space:]]+claude-haiku-4-5[[:space:]]' <<<\"\$output\" && ! grep -Eq '^doppelclaude[[:space:]]+claude-haiku-4-5-' <<<\"\$output\" && echo ok"

run "provider: modelOverrides apply and additions stay hidden" \
  bash -c "output=\$(pi --no-session -ne -e '$DIR' --list-models 2>&1) && grep -Eq '^doppelclaude[[:space:]]+claude-sonnet-5[[:space:]]+200K[[:space:]]' <<<\"\$output\" && ! grep -q 'claude-future-9-9' <<<\"\$output\" && echo ok"

CLAUDE_EXECUTABLE=$(command -v claude)
CLAUDE_SPAWN_LOG="$LOGDIR/rejected-model-claude-spawns.log"
CLAUDE_WRAPPER="$LOGDIR/rejected-model-claude-wrapper.sh"
: > "$CLAUDE_SPAWN_LOG"
cat > "$CLAUDE_WRAPPER" <<EOF
#!/usr/bin/env bash
printf '%s\\n' "\$*" >> "$CLAUDE_SPAWN_LOG"
exec "$CLAUDE_EXECUTABLE" "\$@"
EOF
chmod +x "$CLAUDE_WRAPPER"
printf '{"doppelclaude":{"provider":{"systemPromptMode":"claude-code","pathToClaudeCodeExecutable":"%s"}}}\n' "$CLAUDE_WRAPPER" > "$PI_CODING_AGENT_DIR/settings.json"

run "provider: rejected model emits terminal error before model spawn" \
  bash -c "if pi --no-session -ne -e '$DIR' --model 'doppelclaude/claude-future-9-9' -p yes >'$LOGDIR/rejected-model.out' 2>&1; then exit 1; fi; grep -q 'Unsupported Doppelclaude model' '$LOGDIR/rejected-model.out' && ! grep -q -- '--model' '$CLAUDE_SPAWN_LOG' && echo ok"

# --- Summary ---

echo ""
echo "Passed: $PASS  Failed: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
