/**
 * A query that dies out from under a turn — a torn-down subprocess, revoked OAuth
 * credentials — is not a verdict on the request. The turn is respawned and replayed
 * once, and only while nothing of it has reached pi. Drives the real runtime with a
 * fake SDK query.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMessageEvent, Context, Message as PiMessage, Model, SimpleStreamOptions, Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createBridgeRuntime } from "../src/bridge-runtime.js";
import { projectCatalogModels } from "../src/models.js";
import { PushQueue } from "../src/query-state.js";

const [fakeModel] = projectCatalogModels(
	[{ id: "claude-haiku-4-5", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://api.anthropic.com", contextWindow: 200_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as unknown as Model<any>],
	new Set(["claude-haiku-4-5"]),
);

const QUERY_CLOSED = "Query closed before response received";
/** These turns are the host conversation's, so the runtime is told the host is this caller. */
const HOST_SESSION = "host-session-id";
const REVOKED = "Failed to authenticate. API Error: 401 OAuth access token has been revoked.";

interface QueryScript {
	/** Rejects `initializationResult()`, the way a subprocess that never came up does. */
	failInit?: string;
	messages?: SDKMessage[];
	/** Rejects the consumer once the scripted messages run out, the way a torn-down transport does. */
	throwAfterMessages?: string;
	/** Stays open until the test kills it, so a failure can be ordered after an abort. */
	stayOpen?: boolean;
	/** Rejects the control requests a reused query answers before a pushed turn. */
	failControl?: string;
	hangOnInterrupt?: boolean;
}

/** One spawned query, as the handle a test needs to kill it mid-flight. */
interface SpawnedQuery {
	fail(message: string): void;
}

function makeHarness(scripts: QueryScript[]) {
	const spawned: SpawnedQuery[] = [];
	const runtime = createBridgeRuntime({
		providerSettings: { systemPromptMode: "claude-code" },
		queryFactory: () => {
			const script = scripts[spawned.length];
			assert.ok(script, `unexpected query spawn #${spawned.length + 1}`);
			const queue = new PushQueue<SDKMessage>();
			let pendingError = script.throwAfterMessages ?? null;
			spawned.push({ fail(message) { pendingError = message; queue.end(); } });
			for (const message of script.messages ?? []) queue.push(message);
			if (!script.stayOpen) queue.end();
			const iterate = async function* () {
				for await (const message of queue) yield message;
				if (pendingError) throw new Error(pendingError);
			};
			return {
				[Symbol.asyncIterator]: () => iterate()[Symbol.asyncIterator](),
				initializationResult: async () => {
					if (script.failInit) throw new Error(script.failInit);
					return {};
				},
				setMcpServers: async () => {
					if (script.failControl) throw new Error(script.failControl);
					return { added: ["custom-tools"], removed: ["custom-tools"], errors: {} };
				},
				setModel: async () => {
					if (script.failControl) throw new Error(script.failControl);
				},
				interrupt: async () => {
					if (script.hangOnInterrupt) return new Promise(() => {});
					return {};
				},
				close: () => queue.end(),
			} as unknown as Query;
		},
	});
	void runtime.designateHost(HOST_SESSION);
	return { runtime, spawned };
}

function stream(
	runtime: ReturnType<typeof makeHarness>["runtime"],
	messages: unknown[],
	options?: SimpleStreamOptions,
	tools: Tool[] = [],
) {
	return runtime.test.streamClaudeAgentSdk(fakeModel, {
		systemPrompt: "",
		messages: messages as PiMessage[],
		tools,
	} as unknown as Context, { sessionId: HOST_SESSION, ...options });
}

function record(source: AsyncIterable<AssistantMessageEvent>) {
	const events: AssistantMessageEvent[] = [];
	void (async () => { for await (const event of source) events.push(event); })();
	return events;
}

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 5)); };

function textEvents(text: string): SDKMessage[] {
	return [
		{ type: "stream_event", event: { type: "message_start", message: { usage: {} } } },
		{ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
		{ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } },
		{ type: "stream_event", event: { type: "content_block_stop", index: 0 } },
		{ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: "end_turn" } } },
		{ type: "stream_event", event: { type: "message_stop" } },
	] as unknown as SDKMessage[];
}

const successResult = { type: "result", subtype: "success", result: "", is_error: false, modelUsage: {} } as unknown as SDKMessage;
const revokedResult = { type: "result", subtype: "error_during_execution", is_error: true, error: REVOKED, modelUsage: {} } as unknown as SDKMessage;

function texts(events: AssistantMessageEvent[]) {
	return events.filter((event) => event.type === "text_end").map((event: any) => event.content);
}

function terminalError(events: AssistantMessageEvent[]) {
	const last = events.at(-1);
	return last?.type === "error" ? (last as any).error.errorMessage : null;
}

const prompt = [{ role: "user", content: "go" }];
// A second turn pi's history says is a straight continuation, so the runtime pushes it
// into the query it kept alive.
const secondPrompt = [
	...prompt,
	{ role: "assistant", content: [{ type: "text", text: "first" }] },
	{ role: "user", content: "again" },
];
const bashTool = {
	name: "bash",
	description: "run a command",
	parameters: Type.Object({ command: Type.String() }),
} as unknown as Tool;

describe("dead query retry", () => {
	it("replays the turn once on a fresh subprocess and answers from it", async () => {
		const { runtime, spawned } = makeHarness([
			{ failInit: QUERY_CLOSED },
			{ messages: [...textEvents("alive"), successResult] },
		]);
		const events = record(stream(runtime, prompt));
		await settle();

		assert.equal(spawned.length, 2, "the dead query was not respawned");
		assert.deepEqual(texts(events), ["alive"]);
		assert.equal(events.at(-1)?.type, "done", "the retry's answer did not complete the turn");
		assert.equal(events.filter((event) => event.type === "start").length, 1, "pi saw the turn start twice");
	});

	it("reports the failure when the replay dies the same way", async () => {
		const { runtime, spawned } = makeHarness([
			{ failInit: QUERY_CLOSED },
			{ failInit: QUERY_CLOSED },
		]);
		const events = record(stream(runtime, prompt));
		await settle();

		assert.equal(spawned.length, 2, "exactly one retry, and the second failure is final");
		assert.equal(terminalError(events), QUERY_CLOSED);
	});

	it("tells the user how to re-authenticate when a revoked token outlives the retry", async () => {
		const { runtime, spawned } = makeHarness([
			{ messages: [revokedResult] },
			{ messages: [revokedResult] },
		]);
		const events = record(stream(runtime, prompt));
		await settle();

		assert.equal(spawned.length, 2);
		const error = terminalError(events);
		assert.match(error, /401 OAuth access token has been revoked/);
		assert.match(error, /claude \/login/, "a revoked credential is only actionable in Claude Code's own terms");
	});

	it("recovers silently when the token was revoked only for the first subprocess", async () => {
		const { runtime, spawned } = makeHarness([
			{ messages: [revokedResult] },
			{ messages: [...textEvents("refreshed"), successResult] },
		]);
		const events = record(stream(runtime, prompt));
		await settle();

		assert.equal(spawned.length, 2);
		assert.deepEqual(texts(events), ["refreshed"]);
		assert.equal(terminalError(events), null, "a self-healed turn must not report a failure");
	});

	it("never replays a turn the user aborted", async () => {
		const controller = new AbortController();
		const { runtime, spawned } = makeHarness([
			{ stayOpen: true, hangOnInterrupt: true },
		]);
		const events = record(stream(runtime, prompt, { signal: controller.signal } as SimpleStreamOptions));
		await settle();
		controller.abort();
		await settle();
		// The interrupt never lands and the subprocess dies instead: a dead query, but one the
		// user has already walked away from.
		spawned[0].fail(QUERY_CLOSED);
		await settle();

		assert.equal(spawned.length, 1, "an aborted turn was respawned");
		assert.equal(events.at(-1)?.type, "error");
	});

	it("never replays a turn whose output already reached pi", async () => {
		const { runtime, spawned } = makeHarness([
			{ messages: textEvents("half an answer"), throwAfterMessages: QUERY_CLOSED },
		]);
		const events = record(stream(runtime, prompt));
		await settle();

		assert.equal(spawned.length, 1, "replaying after partial delivery would duplicate the answer");
		assert.deepEqual(texts(events), ["half an answer"]);
		assert.equal(terminalError(events), QUERY_CLOSED);
	});

	it("replays a turn pushed into a query that had already died", async () => {
		const { runtime, spawned } = makeHarness([
			{ stayOpen: true, failControl: QUERY_CLOSED, messages: [...textEvents("first"), successResult] },
			{ messages: [...textEvents("second"), successResult] },
		]);
		record(stream(runtime, prompt));
		await settle();
		assert.equal(spawned.length, 1, "the first turn should not have respawned anything");
		// A real turn learns its session id from Claude Code's init message; the fake query
		// names none, so the sync state a completed turn leaves behind is set here.
		runtime.test.setHostSession({ sessionId: "11111111-1111-4111-8111-111111111111", cursor: 1 });

		// The tool set changed, so the reused query is asked to reconcile its MCP servers —
		// and answers as a corpse.
		const events = record(stream(runtime, secondPrompt, undefined, [bashTool]));
		await settle();

		assert.equal(spawned.length, 2, "the pushed-into corpse was not replaced");
		assert.deepEqual(texts(events), ["second"]);
		assert.equal(terminalError(events), null);
	});

	it("leaves failures that are not a dead query alone", async () => {
		const { runtime, spawned } = makeHarness([
			{ failInit: "Claude Code process exited with code 1" },
		]);
		const events = record(stream(runtime, prompt));
		await settle();

		assert.equal(spawned.length, 1);
		assert.equal(terminalError(events), "Claude Code process exited with code 1");
	});
});
