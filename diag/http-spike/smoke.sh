#!/usr/bin/env bash
set -euo pipefail

: "${DOPPELCLAUDE_HTTP_API_KEY:?set DOPPELCLAUDE_HTTP_API_KEY}"
: "${AMP_THREAD_URL:?set AMP_THREAD_URL to https://ampcode.com/threads/T-...}"
base_url="${DOPPELCLAUDE_HTTP_BASE_URL:-http://127.0.0.1:3456}"
model="${DOPPELCLAUDE_HTTP_CLIENT_MODEL:-claude-haiku-4-5}"

curl --fail-with-body --no-buffer "$base_url/v1/messages" \
  -H "x-api-key: $DOPPELCLAUDE_HTTP_API_KEY" \
  -H 'content-type: application/json' \
  --data-binary "$(jq -n --arg model "$model" --arg marker "Amp Thread URL: $AMP_THREAD_URL" '{model:$model,max_tokens:256,stream:true,system:[{type:"text",text:$marker}],messages:[{role:"user",content:"Reply with exactly: amp-http-ok"}]}')"
