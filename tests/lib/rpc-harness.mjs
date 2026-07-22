/**
 * Shared RPC harness for pi integration tests.
 * Provides spawn, send, event waiting, and text collection utilities.
 */
import { spawn } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

// Isolate Pi's agent dir so a developer's real ~/.pi/agent/claude-bridge.json
// (which may still hold a now-rejected askClaude block) cannot break tests.
// Pi provider credentials are copied into the sandbox so alt-provider auth still
// works; Claude Code's own auth (~/.claude / $CLAUDE_CONFIG_DIR) is unaffected.
function isolateAgentDir(name, logdir, customAgentDir) {
	const realDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	const sandbox = join(logdir, `agent-${name}`);
	rmSync(sandbox, { recursive: true, force: true });
	mkdirSync(sandbox, { recursive: true });
	for (const file of ["auth.json", "models.json", "models-store.json"]) {
		const src = join(realDir, file);
		if (existsSync(src)) copyFileSync(src, join(sandbox, file));
	}
	if (customAgentDir) {
		for (const file of ["settings.json", "auth.json", "models.json", "models-store.json"]) {
			const src = join(customAgentDir, file);
			if (existsSync(src)) copyFileSync(src, join(sandbox, file));
		}
	}
	writeFileSync(join(sandbox, "claude-bridge.json"), '{"provider":{"systemPromptMode":"claude-code"}}\n');
	return sandbox;
}

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Auto-load .env.test so int tests work when invoked directly
// (`node --import tsx --test tests/int-foo.mjs`) and not just via `npm test`.
const ENV_FILE = resolve(DIR, ".env.test");
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

/**
 * Create an RPC harness for pi integration tests.
 *
 * @param {Object} opts
 * @param {string} opts.name - Test name (used for log files)
 * @param {string[]} opts.args - Additional pi CLI args (after --mode rpc)
 * @param {Object} opts.env - Extra env vars to set on the pi process
 * @param {string} opts.cwd - Working directory for the pi process (default: project root)
 * @param {number} opts.defaultTimeout - Default timeout for send/wait operations (default: 30000)
 */
export function createRpcHarness(opts) {
	const { name, args = [], env = {}, cwd = DIR, defaultTimeout = 30_000 } = opts;

	const LOGDIR = `${DIR}/.test-output`;
	mkdirSync(LOGDIR, { recursive: true });

	const RPC_LOG = `${LOGDIR}/${name}.log`;
	const DEBUG_LOG = `${LOGDIR}/${name}-debug.log`;
	const AGENT_DIR = isolateAgentDir(name, LOGDIR, env.PI_CODING_AGENT_DIR);

	// Strip any local node_modules from PATH so we use the globally-installed `pi`.
	const cleanPath = process.env.PATH.split(":").filter((p) => !p.includes("node_modules")).join(":");

	let pi, rpcLog;
	let buffer = "";
	let listeners = [];
	let reqId = 0;

	function start() {
		// Truncate the debug log on each run so test assertions that grep the
		// log see only this run's output, not accumulated history from prior
		// failing runs. RPC log is still append so cross-run comparisons work.
		writeFileSync(DEBUG_LOG, "");
		rpcLog = createWriteStream(RPC_LOG, { flags: "a" });
		const spawnArgs = ["--no-session", "-ne", "-e", DIR, "--mode", "rpc", ...args];
		pi = spawn("pi", spawnArgs, {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...process.env, ...env, PATH: cleanPath, PI_CODING_AGENT_DIR: AGENT_DIR, CLAUDE_BRIDGE_DEBUG: "1", CLAUDE_BRIDGE_DEBUG_PATH: DEBUG_LOG },
		});

		pi.stderr.on("data", (d) => rpcLog.write(d));

		const decoder = new StringDecoder("utf8");
		pi.stdout.on("data", (chunk) => {
			buffer += decoder.write(chunk);
			while (true) {
				const i = buffer.indexOf("\n");
				if (i === -1) break;
				const line = buffer.slice(0, i);
				buffer = buffer.slice(i + 1);
				try {
					const msg = JSON.parse(line);
					rpcLog.write(`< ${line}\n`);
					for (const fn of [...listeners]) fn(msg);
				} catch {}
			}
		});
	}

	async function startAndWait(ms = 2000) {
		start();
		await new Promise((r) => setTimeout(r, ms));
	}

	async function stop() {
		if (pi && pi.exitCode === null) {
			const closed = new Promise((resolve) => pi.once("close", resolve));
			pi.kill();
			await closed;
		}
		if (rpcLog) await new Promise((resolve) => rpcLog.end(resolve));
	}

	function addListener(fn) {
		listeners.push(fn);
		return () => {
			const i = listeners.indexOf(fn);
			if (i !== -1) listeners.splice(i, 1);
		};
	}

	function send(cmd, timeout = defaultTimeout) {
		const id = `req_${++reqId}`;
		const full = { ...cmd, id };
		rpcLog.write(`> ${JSON.stringify(full)}\n`);
		pi.stdin.write(JSON.stringify(full) + "\n");
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`Timeout: ${cmd.type}`)), timeout);
			const remove = addListener((msg) => {
				if (msg.type !== "response" || msg.id !== id) return;
				clearTimeout(timer);
				remove();
				msg.success ? resolve(msg.data) : reject(new Error(`${cmd.type}: ${msg.error}`));
			});
		});
	}

	function waitForEvent(type, timeout = defaultTimeout) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeout);
			const remove = addListener((msg) => {
				if (msg.type === type) {
					clearTimeout(timer);
					remove();
					resolve(msg);
				}
			});
		});
	}

	function waitForMatch(predicate, description, timeout = defaultTimeout) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${description}`)), timeout);
			const remove = addListener((msg) => {
				if (predicate(msg)) {
					clearTimeout(timer);
					remove();
					resolve(msg);
				}
			});
		});
	}

	function collectText() {
		let text = "";
		const handler = (msg) => {
			if (msg.type === "message_update") {
				const ae = msg.assistantMessageEvent;
				if (ae?.type === "text_delta") text += ae.delta;
			}
		};
		addListener(handler);
		return { stop() { const i = listeners.indexOf(handler); if (i !== -1) listeners.splice(i, 1); return text; } };
	}

	async function promptAndWait(message, timeout = defaultTimeout) {
		const collector = collectText();
		await send({ type: "prompt", message }, timeout);
		await waitForEvent("agent_end", timeout);
		return collector.stop();
	}

	function clearListeners() {
		listeners = [];
	}

	return {
		DIR,
		LOGDIR,
		RPC_LOG,
		DEBUG_LOG,
		pi: () => pi,
		start,
		startAndWait,
		stop,
		addListener,
		clearListeners,
		send,
		waitForEvent,
		waitForMatch,
		collectText,
		promptAndWait,
	};
}

/**
 * Require environment variable or exit with error.
 * @param {string} name - Environment variable name
 * @returns {string} The env var value
 */
export function requireEnv(name) {
	const value = process.env[name];
	if (!value) {
		console.error(`ERROR: ${name} not set (see .env.test)`);
		process.exit(1);
	}
	return value;
}
