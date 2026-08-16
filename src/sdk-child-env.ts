// The environment every Claude Code subprocess is spawned with.

const BRIDGE_CLIENT_APP = "pi-doppelclaude/0.6.2";

// API betas Claude Code does not request but the bridge needs. Each is inert on models
// where it has gone GA, so entries can stay until the SDK sends them itself.
const BRIDGE_BETAS = [
  // Without it the API buffers tool-input JSON and releases it in one burst: a write or
  // bash call sits frozen for seconds, then fills instantly.
  "fine-grained-tool-streaming-2025-05-14",
];

/** Appended to the caller's list, deduped, so a user-set ANTHROPIC_BETAS survives. */
function anthropicBetas(): string {
  const betas = new Set(
    (process.env.ANTHROPIC_BETAS ?? "")
      .split(",")
      .map((beta) => beta.trim())
      .filter(Boolean),
  );
  for (const beta of BRIDGE_BETAS) betas.add(beta);
  return [...betas].join(",");
}

export function sdkChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ANTHROPIC_BETAS: anthropicBetas(),
    CLAUDE_AGENT_SDK_CLIENT_APP: BRIDGE_CLIENT_APP,
    // Pi owns the conversation record; a bridge subprocess writing CC auto-memory
    // into ~/.claude from pi turns is state leaking outside that ownership.
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    ...extra,
  };
}
