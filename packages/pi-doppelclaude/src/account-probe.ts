import { createDefaultAccountProbe as createCoreAccountProbe } from "doppelclaude/account-probe";
import type { ProviderSettings } from "./settings.js";

export type { AccountProbe, AccountSnapshot } from "doppelclaude/account-probe";
export { createAccountProbe } from "doppelclaude/account-probe";

export function createDefaultAccountProbe(providerSettings: ProviderSettings) {
  return createCoreAccountProbe(providerSettings.pathToClaudeCodeExecutable);
}
