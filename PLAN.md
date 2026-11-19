# opencode-mcp v2: design plan v1 (agreed, implementation contract)

Bring the features proven in [agycli-mcp](https://github.com/bangya96/agycli-mcp) (same owner) to
this OpenCode MCP server: modes, background jobs that survive disconnects, idempotency, change
detection, a Claude Code completion-wake hook and `doctor`. v0 of this plan was reviewed by a second
AI agent on 2026-11-19; this version records the decisions. agycli-mcp modules are copied and adapted
(no shared package); credit kept in the README.

## Facts measured (opencode 1.19.6, macOS, 2026-11-19)

- `opencode run --format json` emits NDJSON, every event carrying `sessionID`:
  `step_start`; `text` (`part.text`); `tool_use` (`part.tool`, `part.state.{status,input,output}`);
  `step_finish` (`part.reason` = `tool-calls` | `stop`, `part.tokens.{total,input,output,reasoning,
  cache.{read,write}}`, `part.cost`); `error` (`error.name` e.g. `APIError` / `UnknownError`,
  `error.data.{message, statusCode, isRetryable}`), with exit code 1.
- The prompt can come from stdin (closed after writing); no argv length limit.
- The built-in `plan` agent ran `ls -la` through bash, so it is not a lock. v1's dedicated read-only
  agent (edit/bash denied, write/edit/patch/bash/task tools off, project config disabled) is stricter.
- `opencode run --session=<id> --auto` continues a planning session and executes the plan.
- Claude Code backgrounds an MCP call after ~120 s; that background task dies with the session.
- AI Hub has no API-key endpoint for remaining budget, so there is no quota tool.

## Decisions

- **Directory install for v2**: `node opencode-mcp.mjs` from a clone, plus `lib/`. No build step,
  no bundle. `opencode-mcp-macos.mjs` and `opencode-mcp-windows.mjs` stay **unchanged** as frozen v1
  single-file servers, so existing copies keep working. README documents the migration.
- **Backward compatible tools**: MCP name `opencode`, `opencode_ask` with all v1 parameters and its
  text output (status header + worker output, `isError` on failure, 600 s per-attempt default,
  blocking), `opencode_models` text output, `opencode_status` with no args = active jobs.
- **No dead default model**: `OPENCODE_MCP_MODEL`, else the request must name a model
  (`model_required` error with guidance). Deliberate, documented change.
- Modes: `ask` = v1 read-only agent (enforced tool restrictions, not an OS sandbox: globally
  configured MCP servers or plugins are not covered); `plan` = same agent + `PLAN_PREAMBLE`, the plan is
  the text answer, returns `session_id` and a `next_step` to continue with mode `edit` after user
  approval; `edit` = `--auto`.
- Prompts go over stdin on every platform; `OPENCODE_MCP_PROMPT_ARGV=1` keeps the argv escape hatch.
- Fallback lives in the supervisor and is **execution-aware**: move to the next model only when the
  attempt's category is retryable AND (mode is not `edit` OR no tool call happened in that attempt).
  Classification uses structured `error` events first (`statusCode`, `isRetryable`, `name`), then
  stderr diagnostics; never the answer text or tool output.
- Locks: session lock for every mode (given `session_id`, and the id discovered during the run);
  workspace lock for `edit` only, keyed by the canonical git worktree root (fallback canonical cwd,
  lower-cased on Windows). Plain `ask`/`plan` runs may overlap.
- Change detection snapshots for all modes; reported as "observed during this job".
- Fixes inherited from agycli-mcp review: atomic admission gate takeover (no stale-unlink race);
  persist `worker_pid`; a job whose supervisor died is only marked `interrupted` (and its locks freed)
  once the worker is also dead; MCP framing rejects oversized frames even when newline-terminated.
- Cut: quota, `dirs`, `effort`, auto plan continuation, HTTP, session browsing.

## Interfaces (frozen; change only by agreement)

Durations and timestamps in ms. Functions async unless marked [sync].

### lib/contracts.mjs (Claude)

```text
loadConfig(env) -> Config                                  [sync]
normalizeRun(input, config) -> RunRequest                  [sync]   new tools
normalizeLegacyAsk(input, config) -> RunRequest            [sync]   opencode_ask (allow_edits -> mode)
requestKey(request) -> string                              [sync]
workspaceKey(cwd) -> string                                [sync]   git root or cwd, canonical
constants: MODES, STATES, TERMINAL_STATES, FAILURE_REASONS, CATEGORIES, RETRYABLE_CATEGORIES,
           PLAN_PREAMBLE, PLAN_NEXT_PROMPT, READ_ONLY_AGENT
ValidationError (code 'invalid_params'), parseJsonLenient
```

`RunRequest` (frozen): `prompt, mode, cwd, workspace_key, model, fallback_models[], timeout_ms`
(per attempt) and optional `variant, session_id, title, idempotency_key`. Model ids are full
`provider/model`. Catalogue validation of `model`/`fallback_models` happens in the tools layer before
`start()`; the runtime trusts the request.

Config: `bin` (OPENCODE_MCP_BIN | null), `default_model` (OPENCODE_MCP_MODEL | null),
`default_timeout_ms` (OPENCODE_MCP_TIMEOUT_MS, 600000), `max_output_chars` (OPENCODE_MCP_MAX_OUTPUT,
120000), `prompt_via_argv` (OPENCODE_MCP_PROMPT_ARGV=1), `state_dir` (OPENCODE_MCP_STATE_DIR, default
`~/.local/state/opencode-mcp`, Windows `%LOCALAPPDATA%\opencode-mcp`), `sync_wait_ms` (90000),
`max_concurrency` (4), `job_ttl_ms` (24 h), `debug`.

Categories (attempt level): `ok, rate_limited, quota_exhausted, unavailable, model_unavailable,
server_error, auth_required, timeout, launch_failed, cancelled, task_error`. Retryable:
`rate_limited, quota_exhausted, unavailable, model_unavailable, server_error`.

### lib/platform.mjs (Astra)

```text
resolveLaunch(config) -> {file, argsPrefix, source}   // .mjs/.cjs/.js -> node; v1 Windows resolver
                                                      // (opencode.exe behind npm/scoop/choco shims)
killTree(pid, {grace_ms}) -> void
isAlive(pid) -> boolean                                [sync]
atomicWriteJson(path, value) -> void                  // Windows rename retry
readJson(path) -> value | null
```

### lib/opencode.mjs (Astra)

```text
buildInvocation(request, model, {config, env}) -> {args, stdin, env}     [sync]
runAttempt(request, {model, launch, config, signal, on_event, on_stdout, on_stderr, on_spawn})
  -> AttemptResult
probeOpenCode(kind: 'version'|'models', {launch, timeout_ms, provider?}) -> {exit_code, stdout, stderr, timed_out?}
```

`buildInvocation`: `run --format=json --model=<m>`, `--agent=<READ_ONLY_AGENT>` plus the v1 read-only
env for ask/plan, `--auto` for edit, `--dir=<cwd>`, `--variant=`, `--session=`, `--title=` (single
`--name=value` entries); prompt on stdin (plan: `PLAN_PREAMBLE + "\n\n" + prompt`), or `-- <prompt>`
when `prompt_via_argv`.

`AttemptResult`: `text, partial, exit_code, category, retryable, side_effects_possible, elapsed_ms,
tool_calls` and optional `session_id, error, retry_after_ms, usage{input, output, reasoning,
cache_read, cache_write, cost}`. `partial` is true unless a `step_finish` with reason `stop` arrived.
`side_effects_possible` is true when any `tool_use` event happened in mode `edit`.

### lib/change-detection.mjs (Astra)

`snapshot(dirs) -> Snapshot`, `compare(before, after) -> {changes_detected: boolean|null, files[],
coverage: 'git'|'partial'|'none', limitations[]}` (as agycli-mcp).

### lib/jobs.mjs + lib/supervisor.mjs (Astra)

```text
createJobStore({config, launch}) -> JobStore    // launch may be null: start() throws code launch_failed
start(request) -> JobView      // throws busy_session | busy_workspace | concurrency_limit | idempotency_conflict
status(job_id) / wait(job_id, {wait_ms, signal}) / cancel(job_id) / markCollected(job_id) -> JobView|void
list({limit, include_completed}) -> {jobs}      // include_completed false = non-terminal only
gc() -> {removed}
```

Supervisor: `node lib/supervisor.mjs <job-dir>`, detached, owns the fallback loop, change snapshots
and lock release. `JobView`: `job_id, state, mode, cwd, created_at, elapsed_ms` and optional
`started_at, finished_at, session_id, model, result`. `result`: `text, partial, model_used, attempts[
{model, category, elapsed_ms, session_id?, error?, tool_calls}], session_id, usage, changes` and, when
failed, `failure_reason` (`FAILURE_REASONS` = the non-ok categories plus `interrupted`, `unknown`) and
`error`. A committed terminal result wins over a racing cancel.

### Disk contract

`<state>/jobs/<uuid>/`: `meta.json` `{schema_version:1, job_id, created_at, request, runtime:{launch,
max_output_chars, prompt_via_argv}}`; `status.json` (JobView + `{pid, worker_pid?, token,
heartbeat_at}`); `result.json`; `events.jsonl` (bounded, each event tagged with `attempt`);
`stderr.log` (bounded); empty `done`, `cancel`, `collected`. `<state>/locks/session-<sha256>.json`,
`<state>/locks/workspace-<sha256>.json` (`{job_id, pid, token, created_at}`), `<state>/idem/<sha256>.json`
(`{job_id, request_key}`). Never GC live jobs or jobs whose worker may still run.

### Claude-owned

`opencode-mcp.mjs` (entry; `doctor`, `hook-wait` subcommands), `lib/mcp.mjs`, `lib/tools.mjs`,
`lib/models.mjs` (catalogue via `probeOpenCode('models')`, cache, validation), `lib/hook.mjs`,
`lib/doctor.mjs`, `fixtures/fake-opencode.mjs`, `test/client-*.test.mjs`, README, skill, CI.

## Tools

| Tool | Notes |
|---|---|
| `opencode_ask` | legacy blocking call; v1 params (`prompt, model, fallback_models, allow_edits, cwd, timeout_ms, variant, session_id, title`); v1 text output |
| `opencode_run` | start job: `prompt, mode, model, fallback_models, cwd, timeout_ms, variant, session_id, title, idempotency_key` |
| `opencode_run_sync` | start + wait up to `wait_ms` (cap 90 s) |
| `opencode_wait`, `opencode_cancel` | lifecycle |
| `opencode_status` | `job_id` -> that job; none -> active jobs (`include_completed`, `limit` for history) |
| `opencode_models` | catalogue (v1 output) |
