import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { SystemMessage } from "@earendil-works/pi-ai";
import { buildClaudeSystemPrompt, rewritePiSystemPrompt } from "pi-doppelclaude/system-prompt";
import { PI_DOCS_HEADING, PI_IDENTITY, piSystemMessage } from "./lib/pi-prompt.js";

const SYSTEM_MESSAGE = piSystemMessage();

const REPLACEMENTS = {
  identity: "Custom identity.",
  toolNameNote: "Custom tool note.",
  documentation: {
    heading: "Custom docs:",
    instructions: ["Custom instructions."],
  },
};

/** Rename one of pi's sections, as a pi version that restructured the prompt would. */
function renameSection(message: SystemMessage, from: string, to: string): SystemMessage {
  const sections = Object.fromEntries(
    Object.entries(message.sections ?? {}).map(([name, text]) => [name === from ? to : name, text]),
  );
  return { ...message, sections };
}

describe("rewritePiSystemPrompt", () => {
  it("uses custom documentation prose while preserving discovered paths", () => {
    const rewritten = rewritePiSystemPrompt(SYSTEM_MESSAGE, {
      ...REPLACEMENTS,
      documentation: {
        heading: "Custom implementation references:",
        instructions: ["Consult them quietly and only when required."],
      },
    });

    assert.match(rewritten, /Custom implementation references:/);
    assert.match(rewritten, /- Main documentation: \/opt\/pi\/README\.md/);
    assert.match(rewritten, /- Additional docs: \/opt\/pi\/docs/);
    assert.match(rewritten, /Consult them quietly and only when required\./);
  });

  it("joins each instruction line under the preserved paths", () => {
    const rewritten = rewritePiSystemPrompt(SYSTEM_MESSAGE, {
      ...REPLACEMENTS,
      documentation: {
        heading: "Custom docs:",
        instructions: ["- First line.", "- Second line."],
      },
    });

    assert.match(
      rewritten,
      /- Examples: \/opt\/pi\/examples \(extensions, custom tools, SDK\)\n- First line\.\n- Second line\./,
    );
  });

  it("keeps the rewritten documentation inside pi's docs section", () => {
    const rewritten = rewritePiSystemPrompt(SYSTEM_MESSAGE, REPLACEMENTS);

    assert.match(rewritten, /<docs>\nCustom docs:\n/);
    assert.match(rewritten, /Custom instructions\.\n<\/docs>/);
    assert.doesNotMatch(rewritten, /Pi documentation/);
    assert.doesNotMatch(rewritten, /Always read pi \.md files completely/);
    // Only the docs section is rebuilt, so every later section still stands.
    assert.match(rewritten, /Custom instructions\.\n<\/docs>\n\n<cwd>\n.+\n<\/cwd>$/);
  });

  it("applies identity and tool-note replacements", () => {
    const rewritten = rewritePiSystemPrompt(SYSTEM_MESSAGE, REPLACEMENTS);

    assert.ok(rewritten.startsWith("Custom identity."));
    assert.match(rewritten, /Custom tool note\.\n\n<tools>\n/);
    assert.doesNotMatch(rewritten, new RegExp(PI_IDENTITY));
  });

  it("substitutes replacement prose literally rather than as a pattern", () => {
    const rewritten = rewritePiSystemPrompt(SYSTEM_MESSAGE, {
      identity: "Cost is $& per $1 unit.",
      toolNameNote: "Note $&.",
      documentation: { heading: "Docs $&:", instructions: ["- Line $1."] },
    });

    assert.ok(rewritten.startsWith("Cost is $& per $1 unit."));
    assert.match(rewritten, /Note \$&\.\n\n<tools>\n/);
    assert.match(rewritten, /<docs>\nDocs \$&:\n/);
    assert.match(rewritten, /- Line \$1\./);
  });

  it("fails loudly when pi renames a section the rewrite must replace", () => {
    assert.throws(
      () =>
        rewritePiSystemPrompt(renameSection(SYSTEM_MESSAGE, "docs", "documentation"), REPLACEMENTS),
      /without a "docs" section/,
    );
    assert.throws(
      () =>
        rewritePiSystemPrompt(
          renameSection(SYSTEM_MESSAGE, "tools", "available_tools"),
          REPLACEMENTS,
        ),
      /without a "tools" section/,
    );
  });

  it("fails loudly when pi relabels the documentation paths it discovers", () => {
    const relabelled: SystemMessage = {
      ...SYSTEM_MESSAGE,
      sections: {
        ...SYSTEM_MESSAGE.sections,
        docs: (SYSTEM_MESSAGE.sections?.docs ?? "").replace("- Main documentation:", "- Readme:"),
      },
    };

    assert.throws(
      () => rewritePiSystemPrompt(relabelled, REPLACEMENTS),
      /listed 2 of the 3 expected documentation paths/,
    );
  });

  it("fails loudly when pi rewords the preamble of its default prompt", () => {
    const reworded: SystemMessage = {
      ...SYSTEM_MESSAGE,
      sections: { ...SYSTEM_MESSAGE.sections, preamble: "You are pi, a coding agent harness." },
    };

    assert.throws(
      () => rewritePiSystemPrompt(reworded, REPLACEMENTS),
      /preamble the rewrite does not recognise/,
    );
  });

  it("leaves a docs section an extension supplied in place of pi's untouched", () => {
    const docs = "<docs>\nProject docs live in ./handbook.\n</docs>";
    const custom: SystemMessage = {
      ...SYSTEM_MESSAGE,
      sections: { ...SYSTEM_MESSAGE.sections, docs },
    };

    const rewritten = rewritePiSystemPrompt(custom, REPLACEMENTS);
    assert.ok(rewritten.includes(docs));
    assert.ok(rewritten.startsWith("Custom identity."));
  });

  // Resuming a session recorded before pi 0.87: pi stored the prompt as flat prose, and replays
  // that stored copy ahead of the sections it builds now. Patching sections cannot reach it.
  it("refuses a prompt carrying a pre-0.87 copy of the wording it just replaced", () => {
    const resumed: SystemMessage = {
      ...SYSTEM_MESSAGE,
      content: [PI_IDENTITY, "Available tools:\n- read", PI_DOCS_HEADING].join("\n\n"),
    };

    assert.throws(
      () => rewritePiSystemPrompt(resumed, REPLACEMENTS),
      /still contains .* after the rewrite/,
    );
  });

  it("leaves a prompt that never came from pi's agent loop untouched", () => {
    // streamSimple and friends carry a plain prompt with none of pi's sections in it.
    const foreign: SystemMessage = {
      role: "system",
      content: "Summarize this conversation.",
      timestamp: 0,
    };

    assert.equal(rewritePiSystemPrompt(foreign, REPLACEMENTS), "Summarize this conversation.");
    assert.equal(
      buildClaudeSystemPrompt(foreign, "pi", REPLACEMENTS),
      " Summarize this conversation.",
    );
  });

  // Pi projects a forced prompt as a head holding the forced text and no sections at all, and
  // extensions routinely build that text from `event.systemPrompt` — pi's own prompt, already
  // rendered. Having no sections to patch is exactly why this has to be caught on the way out.
  it("refuses a prompt an extension forced from pi's own rendered prompt", () => {
    const forced: SystemMessage = {
      role: "system",
      content: `${PI_IDENTITY}\n\n<docs>\n${PI_DOCS_HEADING}\n</docs>\n\nAlways answer as a pirate.`,
      timestamp: 0,
    };

    assert.throws(
      () => rewritePiSystemPrompt(forced, REPLACEMENTS),
      /still contains .* after the rewrite/,
    );
  });

  it("leaves a prompt an extension forced from its own wording untouched", () => {
    const forced: SystemMessage = {
      role: "system",
      content: "You are a bespoke assistant.",
      timestamp: 0,
    };

    assert.equal(rewritePiSystemPrompt(forced, REPLACEMENTS), "You are a bespoke assistant.");
  });

  it("uses only the rewritten Pi system prompt in pi mode", () => {
    const systemPrompt = buildClaudeSystemPrompt(SYSTEM_MESSAGE, "pi", REPLACEMENTS);

    assert(typeof systemPrompt === "string");
    assert.doesNotMatch(systemPrompt, /Pi documentation/);
    assert.match(systemPrompt, /Custom docs:/);
  });

  it("separates the prompt from Claude Code's preceding identity block", () => {
    const systemPrompt = buildClaudeSystemPrompt(SYSTEM_MESSAGE, "pi", REPLACEMENTS);

    assert(typeof systemPrompt === "string");
    assert.ok(systemPrompt.startsWith(" Custom identity."));
  });

  it("appends the rewritten Pi system prompt to Claude Code's preset", () => {
    const systemPrompt = buildClaudeSystemPrompt(SYSTEM_MESSAGE, "append", REPLACEMENTS);

    assert(typeof systemPrompt !== "string");
    assert.equal(systemPrompt.type, "preset");
    assert.equal(systemPrompt.preset, "claude_code");
    assert.doesNotMatch(systemPrompt.append, /Pi documentation/);
    assert.match(systemPrompt.append, /Custom docs:/);
  });

  it("excludes the Pi system prompt entirely in claude-code mode", () => {
    assert.deepEqual(buildClaudeSystemPrompt(SYSTEM_MESSAGE, "claude-code", undefined), {
      type: "preset",
      preset: "claude_code",
    });
  });
});

describe("pi prompt structure", () => {
  // The rewrite can only fail loudly once a turn is already in flight. Reading the installed pi
  // moves that detection to `mise run check`, so a pi bump that restructures the prompt fails
  // here rather than in front of Anthropic.
  const piPromptSource = readFileSync(
    new URL(
      "../node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js",
      import.meta.url,
    ),
    "utf8",
  );

  for (const wording of [PI_IDENTITY, PI_DOCS_HEADING]) {
    it(`installed pi still emits: ${wording.slice(0, 48)}…`, () => {
      assert.ok(
        piPromptSource.includes(wording),
        `pi no longer builds this wording, so the rewrite in system-prompt.ts is stale: ${wording}`,
      );
    });
  }

  for (const section of ["preamble", "tools", "docs"]) {
    it(`installed pi still builds a "${section}" section`, () => {
      assert.match(piPromptSource, new RegExp(`promptSections\\.${section}\\s*=`));
    });
  }

  it("installed pi still leaves the preamble untagged and wraps every other section", () => {
    assert.match(piPromptSource, /`<\$\{name\}>\\n\$\{content\}\\n<\/\$\{name\}>`/);
    assert.match(piPromptSource, /name !== "preamble"/);
  });

  for (const prefix of ["- Main documentation:", "- Additional docs:", "- Examples:"]) {
    it(`installed pi still labels its docs paths "${prefix}"`, () => {
      assert.ok(
        piPromptSource.includes(prefix),
        `pi relabelled its documentation paths, so rewriteDocsSection would drop them: ${prefix}`,
      );
    });
  }
});
