/**
 * Pi's structured system prompt: an empty `content` plus named sections — an untagged
 * `preamble` and one `<name>…</name>` section each. The rewrite in system-prompt.ts patches
 * those sections by name, so fixtures reproduce pi's real shape rather than approximating it.
 */

import type { SystemMessage } from "@earendil-works/pi-ai";

export const PI_IDENTITY =
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

export const PI_DOCS_HEADING =
  "Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):";

export function piSystemMessage(toolLines = "- read: read a file"): SystemMessage {
  return {
    role: "system",
    content: "",
    sections: {
      preamble: PI_IDENTITY,
      tools: `<tools>\n${toolLines}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.\n</tools>`,
      rules: "<rules>\n- Be concise in your responses\n</rules>",
      docs: `<docs>\n${PI_DOCS_HEADING}
- Main documentation: /opt/pi/README.md
- Additional docs: /opt/pi/docs
- Examples: /opt/pi/examples (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md), environment variables (docs/environment-variables.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)\n</docs>`,
      cwd: "<cwd>\n/home/user/workspace/repo\n</cwd>",
    },
    timestamp: 0,
  };
}
