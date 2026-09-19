import assert from "node:assert/strict";
import { test } from "node:test";
import { compareSessions, fingerprint } from "./identity.mjs";

test("fingerprints preserve comparisons without retaining credentials or prompts", () => {
  const thread = "T-01234567-89ab-cdef-0123-456789abcdef";
  const capture = fingerprint(
    {
      headers: { authorization: "Bearer private-key", "x-thread": thread },
      system: [{ text: `Private instructions. Thread URL: https://ampcode.com/threads/${thread}` }],
      empty: [],
      metadata: null,
    },
    "test-key",
  );
  const serialized = JSON.stringify(capture);
  for (const secret of [thread, "private-key", "Private instructions"]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.deepEqual(
    capture.threadIds.map((match) => match.path),
    ["/headers/x-thread", "/system/0/text"],
  );
  assert.equal(capture.threadIds[0].hash, capture.threadIds[1].hash);
  assert.equal(capture.fields["/headers/x-thread"], capture.threadIds[0].hash);
  assert.notEqual(fingerprint("same", "key-a").fields[""], fingerprint("same", "key-b").fields[""]);
  assert.notEqual(capture.fields["/empty"], capture.fields["/metadata"]);
});

test("distinguishes an Amp Thread URL line from other thread references", () => {
  const parent = "T-01234567-89ab-cdef-0123-456789abcdef";
  const child = "T-11234567-89ab-cdef-0123-456789abcdef";
  const capture = fingerprint(
    `Parent: ${parent}\nAmp Thread URL: https://ampcode.com/threads/${child}\nSee ${parent}`,
    "key",
  );
  assert.deepEqual(
    capture.threadIds.map((match) => match.ampThreadUrl),
    [false, true, false],
  );
  assert.equal(capture.threadIds[1].hash, fingerprint(child, "key").fields[""]);
});

test("separates session candidates from account identity, request identity, and missing fields", () => {
  const request = (session, requestId, extra = {}) =>
    fingerprint(
      {
        account: "owner",
        session,
        requestId,
        ...extra,
      },
      "test-key",
    );
  const result = compareSessions([
    [request("A", "r1", { optional: "only-on-first" }), request("A", "r2")],
    [request("B", "r3"), request("B", "r4")],
  ]);
  assert.deepEqual(result, {
    candidates: ["/session"],
    shared: ["/account"],
    varying: ["/requestId"],
    missing: ["/optional"],
  });
  assert.throws(() => compareSessions([[request("A", "r1")], [request("B", "r2")]]));
});

test("identical requests are not assigned invented session identities", () => {
  const request = fingerprint(
    { system: "same", messages: [{ role: "user", content: "same" }] },
    "key",
  );
  assert.deepEqual(
    compareSessions([
      [request, request],
      [request, request],
    ]).candidates,
    [],
  );
});
