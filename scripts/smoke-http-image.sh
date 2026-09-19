#!/usr/bin/env bash
set -euo pipefail

image=${1:?usage: $0 IMAGE}
run=(
  docker run --rm --read-only
  --tmpfs "/tmp:mode=1777"
  --tmpfs "/var/lib/doppelclaude:uid=3456,gid=3456,mode=0700"
)

[[ $(docker image inspect --format '{{.Config.User}}' "$image") == "3456:3456" ]]
[[ $("${run[@]}" --entrypoint id "$image" -u) == "3456" ]]
"${run[@]}" "$image" --help | grep -F "DOPPELCLAUDE_HTTP_HOST" >/dev/null
"${run[@]}" "$image" --version | grep -E '^http-doppelclaude [0-9]+\.[0-9]+\.[0-9]+$' >/dev/null
"${run[@]}" --entrypoint sh "$image" -c \
  'test ! -e node_modules/@earendil-works && test ! -e node_modules/pi-doppelclaude'

output=$(mktemp)
suffix="$$-$RANDOM"
auth_name="doppelclaude-smoke-auth-$suffix"
server_name="doppelclaude-smoke-server-$suffix"
cleanup() {
  docker rm -f "$auth_name" "$server_name" >/dev/null 2>&1 || true
  rm -f "$output"
}
trap cleanup EXIT

if "${run[@]}" "$image" >"$output" 2>&1; then
  echo "daemon unexpectedly started without an HTTP API key" >&2
  exit 1
fi
grep -F "set DOPPELCLAUDE_HTTP_API_KEY or DOPPELCLAUDE_HTTP_API_KEY_FILE" "$output" >/dev/null

auth_run=(
  docker run --name "$auth_name" --read-only
  --tmpfs "/tmp:mode=1777"
  --tmpfs "/var/lib/doppelclaude:uid=3456,gid=3456,mode=0700"
  -e DOPPELCLAUDE_HTTP_API_KEY=smoke-only-key
)
if timeout 35s "${auth_run[@]}" "$image" >"$output" 2>&1; then
  echo "daemon unexpectedly started without Claude authentication" >&2
  exit 1
fi
docker rm -f "$auth_name" >/dev/null 2>&1 || true
grep -F "first-party account subscription" "$output" >/dev/null
if grep -Eiq 'EACCES|read-only file system' "$output"; then
  echo "daemon could not operate with a read-only root filesystem" >&2
  exit 1
fi

mock_script=$(cat <<'JS'
import { runHttpDaemon } from "http-doppelclaude/startup";
await runHttpDaemon({
  accountProbe: async () => ({
    available: true,
    supportedModels: [{ value: "claude-haiku-4-5", displayName: "Haiku", description: "" }],
  }),
  descriptionCapProbe: async () => 8192,
});
JS
)
docker run -d --name "$server_name" --read-only \
  --tmpfs "/tmp:mode=1777" \
  --tmpfs "/var/lib/doppelclaude:uid=3456,gid=3456,mode=0700" \
  -e DOPPELCLAUDE_HTTP_API_KEY=smoke-only-key \
  --entrypoint node "$image" --input-type=module --eval "$mock_script" >/dev/null

docker exec "$server_name" node --input-type=module --eval '
  let response;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      response = await fetch("http://127.0.0.1:3456/v1/models", {
        headers: { "x-api-key": "smoke-only-key" },
      });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!response?.ok) throw new Error(`models request failed: ${response?.status ?? "no listener"}`);
  const body = await response.json();
  if (body.data?.[0]?.id !== "claude-haiku-4-5") throw new Error("unexpected models response");
  const denied = await fetch("http://127.0.0.1:3456/v1/models");
  if (denied.status !== 401) throw new Error(`unauthenticated request returned ${denied.status}`);
'
