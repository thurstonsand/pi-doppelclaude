# DEV.md

## Setup

```sh
mise trust && mise run bootstrap
```

The mise enter hook keeps the bootstrap current (npm ci, hk git hooks). Pi loads the extension directly from TypeScript source at `src/index.ts` — there is no build step.

## Commands

mise is the task runner of record; the `npm run` scripts are thin aliases onto it.

```bash
mise run lint       # biome + actionlint + shellcheck (also the pre-commit hook)
mise run format     # biome check --write: format and apply safe fixes
mise run check      # offline verification: lint + typecheck + unit tests
mise run test       # full suite: unit + integration

# Individual steps
mise run lint:biome                                 # TypeScript and JSON
mise run typecheck
mise run test:unit                                  # offline unit suite (tests/unit-*.ts)
node --import tsx --test tests/unit-models.ts       # single unit file
node --import tsx --test tests/int-session-new.ts   # single integration file
tests/int-smoke.sh                                  # shell-driven integration tests, run sparingly
mise run test:usage                                 # on-demand A/B subscription-usage diagnostic; hits a rate-limited endpoint, run sparingly
```

## Tests

- `unit-*.ts` run offline against mocked SDK query factories.
- `tests/fixtures/sdk-streams/` holds verbatim recorded CC message streams (scrubbed) that `unit-stream-replay.ts` replays through the real `consumeQuery`. Re-record with `node --import tsx tests/lib/record-sdk-streams.ts` on an SDK bump (costs quota), then read the fixture diff — it is the SDK's contract change.
- `int-*.{sh,ts}` hit the real Claude Code binary and consume real subscription quota — run deliberately. They need local Claude auth (`claude auth login`).
- `.env.test` supplies `DOPPELCLAUDE_TESTING_ALT_PROVIDER`/`DOPPELCLAUDE_TESTING_ALT_MODEL` — an authenticated non-bridge provider used by the session-resume test.
- `tests/int-rejection-smoke.ts` depends on the model misbehaving on request.
- Do not change production types to make tests easier; mock the real type instead.
- Shell tests share helpers in `tests/lib/`.

## Code style

- Biome owns formatting and lint (`biome.json`): two-space indent, 100 columns, double quotes, semicolons, trailing commas.

- All Pi registration (`pi.registerProvider`, `pi.on`, …) lives in `src/index.ts`; implementations live in sibling modules built as `create*` factories taking explicit dependencies.
- Conform at the edges: untrusted input (settings files, catalog responses, SDK payloads) is validated with TypeBox schemas once, at the boundary.

## Project structure

- **Entrypoint / composition root**: `src/index.ts` — settings load, owner acquisition, provider registration, event wiring.
- **Bridge owner**: `src/bridge-owner.ts` — process-scoped singleton across activations.
- **Bridge runtime**: `src/bridge-runtime.ts` — query/session/MCP state machine; the heart of the extension.
- **Doppels**: `src/doppel.ts` — per-conversation session state, the doppel registry, and session sync planning.
- **Provider**: `src/provider.ts` — native Provider composition; stream event handling in `src/provider-stream.ts`.
- **Session store**: `src/session-store.ts` — in-memory SDK SessionStore with writer revision fencing.
- **Compaction**: `src/compaction.ts` — isolated summary subprocess, file-op carry-forward.
- **Account probe**: `src/account-probe.ts` — auth/first-party gate.
- **System prompt**: `src/system-prompt.ts` — all prompt-rewrite behavior stays isolated here.
- **Settings**: `src/settings.ts` — `doppelclaude` block in Pi's shared settings, env overrides.
- **Diagnostics**: `diag/` — one-off measurement scripts and findings.

## Debugging

- Enable with `doppelclaude.debug.enabled` in Pi settings, or ephemerally with `DOPPELCLAUDE_DEBUG=1` (`DOPPELCLAUDE_DEBUG_PATH` overrides the log path). Env beats settings.
- **Bridge log** (`~/.pi/agent/doppelclaude.log` by default): sync decisions (`syncResult:`), session-store operations, MCP reconciliation, served-model usage, CC stderr.
- **Per-query CC CLI logs** in `cc-cli-logs/` beside the bridge log: the subprocess's own view of session loading and API requests, one file per `query()`. Writer labels `provider` vs `provider-child` distinguish root from reentrant queries.
- Quick live smoke:

```bash
pi -ne -e ./src/index.ts -p --model doppelclaude/claude-haiku-4-5 'Reply with exactly: bridge-ok'
```
