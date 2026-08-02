/**
 * Caller identity, not history shape, decides whose conversation a turn continues.
 * pi's auxiliary calls arrive without a session id, and another
 * pi session arrives with a foreign one; both run in their own one-shot context, so
 * the host doppel's warm query, session, stream and retry are all beyond their reach.
 * their reach. Drives the real runtime with a fake SDK query.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMessageEvent, Context, Message as PiMessage, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createBridgeRuntime } from "../src/bridge-runtime.js";
import { projectCatalogModels } from "../src/models.js";
import { PushQueue } from "../src/query-state.js";

const [fakeModel] = projectCatalogModels(
	[{ id: "claude-haiku-4-5", api: "anthropic-messages", provider: "anthropic", baseUrl: "https://api.anthropic.com", contextWindow: 200_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as unknown as Model<any>],
	new Set(["claude-haiku-4-5"]),
);

const QUERY_CLOSED = "Query closed before response received";
const HOST_SESSION = "host-session-id";
const FOREIGN_SESSION = "foreign-session-id";
const HOST_CC_SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION = "22222222-2222-4222-8222-222222222222";

interface QueryScript {
	failInit?: string;
	messages?: SDKMessage[];
	/** Stays open the way the persistent host query does between turns. */
	stayOpen?: boolean;
}

/** One spawned query, as the handle a test needs to answer or kill it mid-flight. */
interface SpawnedQuery {
	emit(messages: SDKMessage[]): void;
	closed: boolean;
}

function makeHarness(scripts: QueryScript[]) {
	const spawned: SpawnedQuery[] = [];
	const runtime = createBridgeRuntime({
		providerSettings: { systemPromptMode: "claude-code" },
		queryFactory: () => {
			const script = scripts[spawned.length];
			assert.ok(script, `unexpected query spawn #${spawned.length + 1}`);
			const queue = new PushQueue<SDKMessage>();
			const handle: SpawnedQuery = {
				emit(messages) { for (const message of messages) queue.push(message); },
				closed: false,
			};
			spawned.push(handle);
			for (const message of script.messages ?? []) queue.push(message);
			if (!script.stayOpen) queue.end();
			const iterate = async function* () { for await (const message of queue) yield message; };
			return {
				[Symbol.asyncIterator]: () => iterate()[Symbol.asyncIterator](),
				initializationResult: async () => {
					if (script.failInit) throw new Error(script.failInit);
					return {};
				},
				setMcpServers: async () => ({ added: [] as string[], removed: [] as string[], errors: {} }),
				setModel: async () => {},
				interrupt: async () => ({}),
				close: () => { handle.closed = true; queue.end(); },
			} as unknown as Query;
		},
	});
	void runtime.designateHost(HOST_SESSION);
	return { runtime, spawned };
}

function stream(
	runtime: ReturnType<typeof makeHarness>["runtime"],
	messages: unknown[],
	options: SimpleStreamOptions = { sessionId: HOST_SESSION },
) {
	return runtime.test.streamClaudeAgentSdk(fakeModel, {
		systemPrompt: "",
		messages: messages as PiMessage[],
		tools: [],
	} as unknown as Context, options);
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

function successResult(sessionId?: string): SDKMessage {
	return { type: "result", subtype: "success", result: "", is_error: false, modelUsage: {}, ...(sessionId ? { session_id: sessionId } : {}) } as unknown as SDKMessage;
}

function answer(text: string, sessionId?: string): SDKMessage[] {
	return [...textEvents(text), successResult(sessionId)];
}

function texts(events: AssistantMessageEvent[]) {
	return events.filter((event) => event.type === "text_end").map((event: any) => event.content);
}

function terminalError(events: AssistantMessageEvent[]) {
	const last = events.at(-1);
	return last?.type === "error" ? (last as any).error.errorMessage : null;
}

const firstTurn = [{ role: "user", content: "go" }];
// Pi's history a turn later: the answer, plus the next thing the user said.
const secondTurn = [
	...firstTurn,
	{ role: "assistant", content: [{ type: "text", text: "first" }] },
	{ role: "user", content: "again" },
];

/** Runs a first host turn that leaves a warm persistent query, as a real session does. */
async function openHostConversation(harness: ReturnType<typeof makeHarness>) {
	const events = record(stream(harness.runtime, firstTurn));
	await settle();
	// A real turn learns its session id from Claude Code's init message; the fake query
	// names none, so the state a completed turn leaves behind is set here.
	harness.runtime.test.setHostSession({ sessionId: HOST_CC_SESSION, cursor: 1 });
	return events;
}

/** The two callers that are not the host: pi's keyless auxiliary calls, and another pi session. */
const foreignCallers = [
	{ label: "a keyless auxiliary call", options: {} as SimpleStreamOptions, messages: [{ role: "user", content: "Name this conversation." }] },
	// A history as long as the host's: nothing but the session id sets these apart.
	{ label: "a foreign session", options: { sessionId: FOREIGN_SESSION } as SimpleStreamOptions, messages: secondTurn },
];

describe("turns that are not the host's", () => {
	for (const caller of foreignCallers) {
		it(`leaves the host's idle persistent query alone for ${caller.label}, and still reuses it for the next host turn`, async () => {
			const harness = makeHarness([
				{ stayOpen: true, messages: answer("first") },
				{ messages: answer("A Conversation", OTHER_SESSION) },
			]);
			await openHostConversation(harness);
			const hostCtx = harness.runtime.test.hostContext;
			const hostQuery = hostCtx.activeQuery;
			assert.ok(hostQuery, "the first host turn left no persistent query");

			const foreignEvents = record(stream(harness.runtime, caller.messages, caller.options));
			await settle();

			assert.equal(harness.spawned.length, 2, "the foreign turn did not get its own subprocess");
			assert.equal(harness.spawned[0].closed, false, "the foreign turn closed the host's persistent query");
			assert.equal(hostCtx.activeQuery, hostQuery, "the foreign turn took over the host's context");
			assert.equal(hostCtx.readyForInput, true, "the host's query is no longer reusable");
			assert.deepEqual(texts(foreignEvents), ["A Conversation"]);

			const hostEvents = record(stream(harness.runtime, secondTurn));
			harness.spawned[0].emit(answer("second"));
			await settle();

			assert.equal(harness.spawned.length, 2, "the next host turn respawned instead of reusing the warm query");
			assert.deepEqual(texts(hostEvents), ["second"]);
			assert.equal(terminalError(hostEvents), null);
		});

		it(`does not move the shared session onto ${caller.label}'s own result`, async () => {
			const harness = makeHarness([
				{ stayOpen: true, messages: answer("first") },
				{ messages: [{ type: "system", subtype: "init", session_id: OTHER_SESSION } as unknown as SDKMessage, ...answer("A Conversation", OTHER_SESSION)] },
			]);
			await openHostConversation(harness);
			const hostSession = harness.runtime.test.getHostSession();

			const foreignEvents = record(stream(harness.runtime, caller.messages, caller.options));
			await settle();

			assert.deepEqual(texts(foreignEvents), ["A Conversation"]);
			assert.deepEqual(
				harness.runtime.test.getHostSession(),
				hostSession,
				"the foreign turn's session replaced the host conversation's",
			);
		});
	}

	it("does not collide with a host turn that arrives alongside it", async () => {
		const harness = makeHarness([
			{ stayOpen: true, messages: answer("first") },
			{ failInit: QUERY_CLOSED },
			{ failInit: QUERY_CLOSED },
		]);
		await openHostConversation(harness);
		const hostCtx = harness.runtime.test.hostContext;
		const hostQuery = hostCtx.activeQuery;

		const foreignEvents = record(stream(harness.runtime, foreignCallers[0].messages, foreignCallers[0].options));
		const hostEvents = record(stream(harness.runtime, secondTurn));
		harness.spawned[0].emit(answer("second"));
		await settle();

		assert.equal(harness.spawned.length, 3, "the keyless turn's own retry is the only respawn");
		assert.equal(harness.spawned[0].closed, false, "the host turn's query was force-closed");
		assert.equal(hostCtx.activeQuery, hostQuery);
		assert.deepEqual(texts(hostEvents), ["second"], "the host turn did not answer");
		assert.equal(terminalError(hostEvents), null, "the keyless turn's death was charged to the host turn");
		assert.equal(terminalError(foreignEvents), QUERY_CLOSED, "the keyless turn's failure went unreported");
		assert.notEqual(hostCtx.turnRetry, null, "the keyless turn's death spent the host turn's one retry");
	});

	it("keeps a failing keyless turn out of the host's session", async () => {
		const harness = makeHarness([
			{ stayOpen: true, messages: answer("first") },
			{ failInit: QUERY_CLOSED },
			{ failInit: QUERY_CLOSED },
		]);
		await openHostConversation(harness);
		const hostSession = harness.runtime.test.getHostSession();

		const foreignEvents = record(stream(harness.runtime, foreignCallers[0].messages, foreignCallers[0].options));
		await settle();

		assert.equal(terminalError(foreignEvents), QUERY_CLOSED);
		assert.deepEqual(
			harness.runtime.test.getHostSession(),
			hostSession,
			"a dead keyless turn dropped or invalidated the host conversation's session",
		);
	});
});
