#!/usr/bin/env bash
# Global shared-settings smoke with settings-only debug logging.

set -euo pipefail

source "$(dirname "$0")/lib/timeout.sh"

DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOGDIR="$DIR/.test-output"
mkdir -p "$LOGDIR"
PATH=$(echo "$PATH" | tr ':' '\n' | grep -v node_modules | tr '\n' ':')
export PATH

CLAUDE_EXECUTABLE=$(command -v claude)
ROOT=$(mktemp -d "$LOGDIR/phase6-settings.XXXXXX")
AGENT_DIR="$ROOT/agent"
mkdir -p "$AGENT_DIR"
cleanup() {
	pkill -P $$ 2>/dev/null || true
	rm -rf -- "$ROOT"
}
trap cleanup EXIT

SPAWN_LOG="$LOGDIR/phase6-settings-spawns.log"
DEBUG_LOG="$LOGDIR/phase6-settings-debug.log"
OUTPUT_LOG="$LOGDIR/phase6-settings-global.log"
: > "$SPAWN_LOG"
rm -f "$DEBUG_LOG"

CLAUDE_WRAPPER="$ROOT/claude.sh"
cat > "$CLAUDE_WRAPPER" <<EOF
#!/usr/bin/env bash
printf 'global %s\n' "\$*" >> "$SPAWN_LOG"
exec "$CLAUDE_EXECUTABLE" "\$@"
EOF
chmod +x "$CLAUDE_WRAPPER"

cat > "$AGENT_DIR/settings.json" <<EOF
{
  "claudeBridge": {
    "provider": {
      "systemPromptMode": "claude-code",
      "pathToClaudeCodeExecutable": "$CLAUDE_WRAPPER"
    },
    "debug": {
      "enabled": true,
      "logPath": "$DEBUG_LOG"
    }
  }
}
EOF

unset CLAUDE_BRIDGE_DEBUG CLAUDE_BRIDGE_DEBUG_PATH
if ! timeout 90 env PI_CODING_AGENT_DIR="$AGENT_DIR" \
	pi --no-session -ne -e "$DIR" --model anthropic-agent-sdk/claude-haiku-4-5 \
	-p 'Reply with only the word yes' > "$OUTPUT_LOG" 2>&1; then
	cat "$OUTPUT_LOG"
	exit 1
fi
grep -qiE '^[[:space:]]*yes[[:space:]]*$' "$OUTPUT_LOG"
grep -q '^global ' "$SPAWN_LOG"
grep -q 'loadSettings:' "$DEBUG_LOG"
grep -q "$CLAUDE_WRAPPER" "$DEBUG_LOG"

echo "Global settings smoke passed"
echo "  Provider output: $OUTPUT_LOG"
echo "  Settings debug:  $DEBUG_LOG"
echo "  Executable trace: $SPAWN_LOG"
