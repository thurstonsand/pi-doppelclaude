#!/usr/bin/env bash
# Shared setup functions for bash-based integration tests.
# Source this file at the start of test scripts.

set -euo pipefail

# Strip node_modules/.bin from PATH so we use the system pi, not the vendored one.
__clean_path() {
	echo "$PATH" | tr ':' '\n' | grep -v node_modules | tr '\n' ':'
}

# Setup standard test environment.
# Usage: setup_test_env "test-name"
# Sets: DIR, LOGDIR, LOGFILE (if specified), DEBUG_LOG, and debug environment overrides
setup_test_env() {
	local name="$1"
	local log_suffix="${2:-.log}"  # optional: suffix for logfile, or "none" for no logfile

	DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
	LOGDIR="$DIR/.test-output"
	mkdir -p "$LOGDIR"

	export CLAUDE_BRIDGE_DEBUG=1
	export CLAUDE_CODE_SAFE_MODE=1
	DEBUG_LOG="$LOGDIR/${name}-debug.log"
	export CLAUDE_BRIDGE_DEBUG_PATH="$DEBUG_LOG"

	# Isolate Pi's agent dir so developer settings cannot alter test behavior.
	# Pi provider credentials are copied into the sandbox; Claude Code's own auth
	# (~/.claude / $CLAUDE_CONFIG_DIR) is unaffected by PI_CODING_AGENT_DIR.
	local real_agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
	local sandbox_agent_dir="$LOGDIR/agent-${name}"
	rm -rf "$sandbox_agent_dir"
	mkdir -p "$sandbox_agent_dir"
	# models-store.json is copied so the sandbox replays a cached catalog. Letting it perform a
	# live first load instead makes every process boot Claude Code, and one slow probe persists a
	# failed attempt that starves every later assertion in the run. First load is covered
	# hermetically in unit-model-catalog.
	local f
	for f in auth.json models.json models-store.json; do
		if [[ -f "$real_agent_dir/$f" ]]; then cp "$real_agent_dir/$f" "$sandbox_agent_dir/$f"; fi
	done
	printf '{"claudeBridge":{"provider":{"systemPromptMode":"claude-code"}}}\n' > "$sandbox_agent_dir/settings.json"
	export PI_CODING_AGENT_DIR="$sandbox_agent_dir"

	if [[ "$log_suffix" != "none" ]]; then
		LOGFILE="$LOGDIR/${name}${log_suffix}"
	else
		LOGFILE=""
	fi

	# Clean PATH and run pi from the project root so project-local config is visible.
	PATH=$(__clean_path)
	cd "$DIR"

	# Export for use in tests
	export DIR LOGDIR DEBUG_LOG LOGFILE PATH PI_CODING_AGENT_DIR CLAUDE_CODE_SAFE_MODE
}

# Kill all descendant processes (children, grandchildren, etc.).
# Use as: trap kill_descendants EXIT
kill_descendants() {
	pkill -P $$ 2>/dev/null || true
	sleep 1
}

# Require an environment variable or exit with error.
# Usage: require_env VARNAME
require_env() {
	local var="$1"
	local val="${!var:-}"
	if [[ -z "$val" ]]; then
		echo "ERROR: $var not set (see .env.test)"
		exit 1
	fi
	echo "$val"
}

# Check for required commands or exit with error.
# Usage: require_command cmd1 cmd2 ...
require_command() {
	local cmd
	for cmd in "$@"; do
		if ! command -v "$cmd" >/dev/null 2>&1; then
			echo "ERROR: $cmd is required but not installed"
			exit 1
		fi
	done
}
