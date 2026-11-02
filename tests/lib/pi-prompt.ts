/**
 * Pi's structured system prompt: an empty `content` plus named sections — an untagged
 * `preamble` and one `<name>…</name>` section each. The rewrite in system-prompt.ts patches
 * those sections by name, so fixtures reproduce pi's real shape rather than approximating it.
 */

import type { SystemMessage } from "@earendil-works/pi-ai";

export const PI_IDENTITY =
  "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.";

export const PI_DOCS_HEADING =
  "Pi documentation (read only when the user asks about the harness itself, its SDK, extensions, themes, skills, or TUI):";

export function piSystemMessage(toolLines = "- read: read a file"): SystemMessage {
  return {
    role: "system",
    content: "",
    sections: {
      preamble: PI_IDENTITY,
      tools: `<tools>\n${toolLines}\n\nAdditional tools may be available.\n</tools>`,
      rules: "<rules>\n- Be concise in your responses\n</rules>",
      docs: `<docs>\n${PI_DOCS_HEADING}
- Main documentation: /opt/pi/README.md
- Additional docs: /opt/pi/docs
- Examples: /opt/pi/examples (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), packages (docs/packages.md), environment variables (docs/environment-variables.md)
- Before implementing harness changes, read the relevant docs and examples in full, following related cross-references.\n</docs>`,
      cwd: "<cwd>\n/home/user/workspace/repo\n</cwd>",
    },
    timestamp: 0,
  };
}
