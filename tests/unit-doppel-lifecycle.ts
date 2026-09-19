/**
 * Doppel lifecycle: what each kind of conversation keeps between turns.
 *
 * The host keeps a warm persistent query; a guest keeps its session and transcript but
 * not its process, and reconstitutes by resuming; an ephemeral keeps nothing at all.
 * Drives the real runtime with a fake SDK query that ends when its input does, the way
 * a real subprocess does.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Options, Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  Api,
  AssistantMessageEvent,
  Context,
  Model,
  Message as PiMessage,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { PushQueue } from "doppelclaude/query-state";
import { projectCatalogModels } from "pi-doppelclaude/models";
import { createPiBridgeRuntime as createBridgeRuntime } from "pi-doppelclaude/pi-runtime";
import { record } from "./lib/turns.js";

const [fakeModel] = projectCatalogModels(
  [
    {
      id: "claude-haiku-4-5",
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      contextWindow: 200_000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } as unknown as Model<Api>,
  ],
  new Set(["claude-haiku-4-5"]),
);

const HOST_SESSION = "host-session-id";
const OTHER_HOST_SESSION = "other-host-session-id";
const GUEST_SESSION = "guest-session-id";

interface QueryScript {
  /** The Claude Code session the subprocess reports for itself. */
  sessionId?: string;
  /** Stays open after its scripted messages, the way the host's persistent query does. */
  stayOpen?: boolean;
}

/** One spawned query, as the handle a test needs to inspect or drive it. */
interface SpawnedQuery {
  options: Options;
  emit(messages: SDKMessage[]): void;
  closed: boolean;
}

function makeHarness(scripts: QueryScript[]) {
  const spawned: SpawnedQuery[] = [];
  const runtime = createBridgeRuntime({
    providerSettings: { systemPromptMode: "claude-code" },
    queryFactory: ({ prompt, options }) => {
      const script = scripts[spawned.length];
      assert.ok(script, `unexpected query spawn #${spawned.length + 1}`);
      const queue = new PushQueue<SDKMessage>();
      const handle: SpawnedQuery = {
        options,
        emit(messages) {
          for (const message of messages) queue.push(message);
        },
        closed: false,
      };
      spawned.push(handle);
      // A real subprocess exits when its input ends; a drained query has to reach EOF
      // or nothing waiting on its close would ever be released.
      void (async () => {
        for await (const _ of prompt) {
          /* the turn's prompt */
        }
        queue.end();
      })();
      // Claude Code answers under the session it was told to resume, and names a new one
      // only when it started clean.
      handle.emit(answer("ok", (options?.resume as string | undefined) ?? script.sessionId));
      if (!script.stayOpen) queue.end();
      const iterate = async function* () {
        for await (const message of queue) yield message;
      };
      return {
        [Symbol.asyncIterator]: () => iterate()[Symbol.asyncIterator](),
        initializationResult: async () => ({}),
        setMcpServers: async () => ({ added: [] as string[], removed: [] as string[], errors: {} }),
        setModel: async () => {},
        interrupt: async () => ({}),
        close: () => {
          handle.closed = true;
          queue.end();
        },
      } as unknown as Query;
    },
  });
  return { runtime, spawned };
}

function stream(
  runtime: ReturnType<typeof makeHarness>["runtime"],
  messages: unknown[],
  options: SimpleStreamOptions = {},
) {
  return runtime.stream(
    fakeModel,
    {
      systemPrompt: "",
      messages: messages as PiMessage[],
      tools: [],
    } as unknown as Context,
    options,
  );
}

function answer(text: string, sessionId?: string): SDKMessage[] {
  return [
    ...(sessionId ? [{ type: "system", subtype: "init", session_id: sessionId }] : []),
    { type: "stream_event", event: { type: "message_start", message: { usage: {} } } },
    {
      type: "stream_event",
      event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    },
    {
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    },
    { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
    { type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" } } },
    { type: "stream_event", event: { type: "message_stop" } },
    {
      type: "result",
      subtype: "success",
      result: "",
      is_error: false,
      modelUsage: {},
      ...(sessionId ? { session_id: sessionId } : {}),
    },
  ] as unknown as SDKMessage[];
}

function texts(events: AssistantMessageEvent[]) {
  return events.flatMap((event) => (event.type === "text_end" ? [event.content] : []));
}

const firstTurn = [{ role: "user", content: "go" }];
const secondTurn = [
  ...firstTurn,
  { role: "assistant", content: [{ type: "text", text: "ok" }] },
  { role: "user", content: "again" },
];

function doppelFor(runtime: ReturnType<typeof makeHarness>["runtime"], key: string) {
  return runtime.test.doppels.all().find((doppel) => doppel.key === key);
}

describe("doppel lifecycle", () => {
  it("reconstitutes a guest by resuming the session its closed query left behind", async () => {
    const { runtime, spawned } = makeHarness([
      { sessionId: "guest-cc-session" },
      { sessionId: "guest-cc-session" },
    ]);
    void runtime.designateHost(HOST_SESSION);

    await record(stream(runtime, firstTurn, { sessionId: GUEST_SESSION })).done;

    const guest = doppelFor(runtime, GUEST_SESSION);
    assert.ok(guest, "the guest doppel was dropped at turn end");
    assert.equal(guest.kind, "guest");
    assert.equal(guest.context.activeQuery, null, "the guest kept a warm query");
    assert.equal(guest.session?.sessionId, "guest-cc-session", "the guest lost its session");

    const second = record(stream(runtime, secondTurn, { sessionId: GUEST_SESSION }));
    await second.done;

    assert.equal(spawned.length, 2, "the second guest turn did not respawn");
    assert.equal(
      spawned[1].options.resume,
      "guest-cc-session",
      "the guest did not resume its own session",
    );
    assert.deepEqual(texts(second.events), ["ok"]);
  });

  it("leaves no doppel and no transcript behind for a keyless call", async () => {
    const { runtime, spawned } = makeHarness([{ sessionId: "ephemeral-cc-session" }]);
    void runtime.designateHost(HOST_SESSION);

    const turn = record(stream(runtime, secondTurn));
    await turn.done;

    // A history this long is rebuilt into the store before the turn runs, so there is
    // something to leave behind if the ephemeral leaves anything.
    const rebuilt = spawned[0].options.resume;
    assert.ok(rebuilt, "the ephemeral's history was never rebuilt into a session");
    assert.deepEqual(texts(turn.events), ["ok"]);
    assert.deepEqual(
      runtime.test.doppels.all().map((doppel) => doppel.kind),
      ["host"],
      "the ephemeral outlived its turn",
    );
    assert.equal(
      runtime.test.getStoredSession(rebuilt),
      null,
      "the ephemeral left its transcript in the store",
    );
  });

  it("keeps a host and a guest out of each other's sessions", async () => {
    const { runtime, spawned } = makeHarness([
      { sessionId: "host-cc-session", stayOpen: true },
      { sessionId: "guest-cc-session" },
    ]);
    void runtime.designateHost(HOST_SESSION);

    await record(stream(runtime, firstTurn, { sessionId: HOST_SESSION })).done;
    const hostSession = runtime.test.getHostSession();
    assert.equal(hostSession?.sessionId, "host-cc-session");

    await record(stream(runtime, firstTurn, { sessionId: GUEST_SESSION })).done;

    assert.deepEqual(
      runtime.test.getHostSession(),
      hostSession,
      "the guest turn wrote the host's session",
    );
    assert.equal(doppelFor(runtime, GUEST_SESSION)?.session?.sessionId, "guest-cc-session");
    assert.equal(spawned[0].closed, false, "the guest turn closed the host's warm query");

    // The host's next turn goes into that same warm query rather than a third subprocess.
    const second = record(stream(runtime, secondTurn, { sessionId: HOST_SESSION }));
    spawned[0].emit(answer("second"));
    await second.done;

    assert.equal(
      spawned.length,
      2,
      "the host turn respawned instead of pushing into its warm query",
    );
    assert.deepEqual(texts(second.events), ["second"]);
  });

  it("demotes the outgoing host to a guest and closes its query", async () => {
    const { runtime, spawned } = makeHarness([{ sessionId: "host-cc-session", stayOpen: true }]);
    void runtime.designateHost(HOST_SESSION);

    await record(stream(runtime, firstTurn, { sessionId: HOST_SESSION })).done;
    const outgoing = doppelFor(runtime, HOST_SESSION);
    assert.ok(outgoing?.context.activeQuery, "the first host turn left no warm query");

    await runtime.designateHost(OTHER_HOST_SESSION);

    assert.equal(outgoing.kind, "guest", "the outgoing host was not demoted");
    assert.equal(outgoing.context.activeQuery, null, "the outgoing host kept its query");
    assert.equal(
      outgoing.session?.sessionId,
      "host-cc-session",
      "the outgoing host lost its session",
    );
    assert.equal(runtime.test.doppels.hostKey, OTHER_HOST_SESSION);
    assert.equal(spawned.length, 1);
  });

  it("upgrades a doppel that spoke before pi named its host", async () => {
    const { runtime, spawned } = makeHarness([
      { sessionId: "host-cc-session" },
      { sessionId: "host-cc-session", stayOpen: true },
    ]);

    await record(stream(runtime, firstTurn, { sessionId: HOST_SESSION })).done;
    const early = doppelFor(runtime, HOST_SESSION);
    assert.equal(early?.kind, "guest", "a keyed call before designation is a guest");

    await runtime.designateHost(HOST_SESSION);
    assert.equal(early.kind, "host", "the designation did not upgrade the doppel in place");
    assert.equal(early.session?.sessionId, "host-cc-session", "the upgrade lost the session");
    assert.strictEqual(runtime.test.hostContext, early.context);

    const second = record(stream(runtime, secondTurn, { sessionId: HOST_SESSION }));
    await second.done;

    assert.equal(
      spawned[1].options.resume,
      "host-cc-session",
      "the upgraded host did not resume its session",
    );
    assert.equal(
      early.context.persistent,
      true,
      "the upgraded host did not get a persistent query",
    );
    assert.deepEqual(texts(second.events), ["ok"]);
  });
});
