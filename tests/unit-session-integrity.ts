/** Regression coverage for repairing tool pairing before transcript synthesis. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Message, repairToolPairing } from "cc-session-io";

describe("repairToolPairing", () => {
  it("passes through a paired tool_use/tool_result", () => {
    const msgs: Message[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "X", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
    ];
    const repaired = repairToolPairing(msgs);
    assert.equal(repaired.length, msgs.length);
  });

  it("synthesizes a tool_result for an orphan tool_use", () => {
    const msgs: Message[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "orphan", name: "X", input: {} }] },
      { role: "user", content: "next turn" },
    ];
    const repaired = repairToolPairing(msgs);
    assert.equal(repaired.length, msgs.length);
    const nextUser = repaired[1];
    assert.equal(nextUser.role, "user");
    assert.ok(Array.isArray(nextUser.content));
    assert.equal(nextUser.content[0].type, "tool_result");
    assert.equal(nextUser.content[0].tool_use_id, "orphan");
    assert.equal(nextUser.content[0].is_error, true);
  });

  it("returns empty input unchanged", () => {
    assert.deepEqual(repairToolPairing([]), []);
  });
});
