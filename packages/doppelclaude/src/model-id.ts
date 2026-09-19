const LONG_CONTEXT_FORM = /\[1m\]$/u;
const DATED_SNAPSHOT = /-\d{8}$/u;

// Claude names a model by whichever form the caller met it in: a long-context form
// (`claude-opus-5[1m]`) or a dated snapshot (`claude-haiku-4-5-20251001`). Pi names the
// family, and Claude serves it, so both forms normalize onto the family ID.
export function canonicalClaudeModelId(advertised: string): string {
  return advertised.replace(LONG_CONTEXT_FORM, "").replace(DATED_SNAPSHOT, "");
}
