# opencode-mcp-aihub

A dependency-free MCP server that lets **Claude Code**, **OpenAI Codex CLI** or **Hermes Agent**
delegate work to the [opencode](https://opencode.ai) CLI. It was built for models served through
[AI Hub](https://ai-hub.my), but it works with any provider that opencode is configured for.

**v2** adds three explicit modes (`plan` / `ask` / `edit`), background jobs that survive client
disconnects, execution-aware model fallback, change detection, a Claude Code completion-wake hook and
a `doctor` command. It runs from a clone (`node opencode-mcp.mjs`) on macOS, Linux and Windows, with
no `npm install` and no build step. The v1 single-file servers are still here and unchanged.

| Path | What it is |
|---|---|
| `opencode-mcp.mjs` + `lib/` | **v2** server for macOS, Linux and Windows. Node 18+, no dependencies. |
| `skills/opencode/SKILL.md` | Agent skill: *when* and *how* to delegate. It covers the three levels (High, Medium, Low) that match a model to the task's difficulty, the modes, the plan-first workflow, fallback rules, the handoff prompt template, and how to verify the worker's changes. |
| `opencode-mcp-macos.mjs`, `opencode-mcp-windows.mjs` | **v1** single-file servers (frozen). Existing copies keep working; see [Migrating from v1](#migrating-from-v1). |

## ⭐ Three levels: High, Medium, Low

The `opencode` skill sorts every delegated task into one of **three levels** and picks the
model by how hard the task is. You don't choose a model yourself. Just describe the task, and
the agent works out the difficulty, picks the level, and starts from the first model in that
level's list.

| Level | Used for | Model pool (tried in order) |
|---|---|---|
| 🔴 **High** | Changes across several files, unclear requirements, subtle bugs, architecture decisions, complex logic, work where correctness really matters | `cx/gpt-6.1-sol` → `cx/gpt-6-astra` → `kimi-k3` → `glm-5.3` → `deepseek-v4-pro[1m]` |
| 🟡 **Medium** | Well-scoped features, fixes that follow an existing pattern, moderate refactors, ordinary implementation work | `cx/gpt-6.1-terra` → `glm-5` → `mimo-v2.6-pro` → `glm-5.2` → `kimi-k2.6` → `hy4-preview` |
| 🟢 **Low** | Simple lookups, mechanical edits, small boilerplate, targeted searches, low-risk changes | `cx/gpt-6-luna` → `mimo-v2.6-flash` → `deepseek-v4.1-flash` → `minimax-m3` |

How the choice is made:

1. **Your choice wins.** If you name a level or a model, for example *"use opencode high"* or
   *"use opencode with glm-5.3"*, the agent uses it.
2. **Otherwise the agent judges the difficulty.** It reads the task, picks High, Medium or
   Low, and starts from the first model in that list. When a task is ambiguous or risky, it
   goes up a level rather than down.
3. **Automatic fallback.** If a model is unavailable (rate limit or 429, quota used up,
   overloaded, 5xx, or model not available), the next model in the same level is tried. The
   MCP server does this itself through `fallback_models`.
4. **Fallback only covers availability.** If the task itself fails, for example the code has
   a bug or a file is missing, the agent does not switch models, because a different model
   would not fix that. In `edit` mode the server also stops falling back once the failed attempt
   has used a tool, because it may already have changed files.

Examples:

| You say | Level chosen |
|---|---|
| "use opencode to find where the `checkBudget` function is defined" | 🟢 Low |
| "use opencode to add a `status` filter to the payments page, following the existing filters" | 🟡 Medium |
| "use opencode to fix the race condition in the webhook that marks payments twice" | 🔴 High |
| "use opencode **high** to review this file" | 🔴 High (you asked for it) |

> The pools above are the author's AI Hub catalogue. Change them to match your own; see
> [Customising the skill's model pools](#6-customising-the-skills-model-pools).

## What the server provides

| Tool | Purpose |
|---|---|
| `opencode_run` | Start a job in the background; returns `job_id` and the opencode `session_id`. |
| `opencode_run_sync` | Start and wait inline up to about 90 s; returns the result or a running `job_id`. |
| `opencode_wait` | Block until a job finishes (up to about 90 s per call). |
| `opencode_status` | With `job_id`: that job's state and result. Without: jobs still in flight (`include_completed` for recent ones). |
| `opencode_cancel` | Cancel a job and kill its process tree. |
| `opencode_ask` | The v1 blocking call, unchanged: read-only by default, `allow_edits: true` to change files, status header output. |
| `opencode_models` | The models opencode has configured, for example `ai-hub/cx/gpt-6.1-sol`. |

### Modes

| Mode | What opencode may do | How |
|---|---|---|
| `ask` (default) | Read, search and fetch | Dedicated `opencode-mcp-readonly` agent: write, edit, patch, shell and subagent tools removed, edit/bash denied, the project's opencode config ignored |
| `plan` | Same as `ask`, and it answers with an implementation plan | Same agent plus a planning preamble. Returns `session_id` |
| `edit` | Change files and run commands | `--auto` |

`ask` and `plan` are enforced tool restrictions, not an OS sandbox: MCP servers or plugins you have
configured globally in opencode are not covered. opencode's built-in `plan` agent is not used because
it can still run shell commands.

**Plan-first workflow:** run `plan`, review the plan with the user, then `opencode_run` with
`mode: "edit"` and the plan's `session_id`. opencode continues the same session and implements it.

### Behaviour

- **Jobs survive disconnects.** Each job runs under a detached supervisor and writes its state to
  disk, so restarting Claude Code or losing the connection does not lose the result. Cancelling a
  wait does not cancel the job; `opencode_cancel` does.
- **Model validation.** The model and fallbacks are checked against `opencode models` first; models
  that are not configured are skipped with a note.
- **Execution-aware fallback.** `fallback_models` are tried in order on availability errors only,
  classified from opencode's structured `error` events (`statusCode`, `isRetryable`) and then stderr,
  never from the answer text or tool output. In `edit` mode fallback stops once the failed attempt
  has used a tool.
- **Change detection.** Every job snapshots the git working tree before and after and reports the
  files that changed during the job (or `null` when that cannot be checked).
- **Locks.** One `edit` job per git repository and one job per opencode session at a time. `ask` and
  `plan` jobs may run side by side.
- **Idempotency.** `idempotency_key` makes a retried `opencode_run` return the existing job.
- **Arguments can't become flags.** Model ids, `variant` and `session_id` must be plain ids that do not
  start with `-`, and every option is a single `--name=value` argument. Prompts go over stdin.
- **No default model.** Pass `model`, or set `OPENCODE_MCP_MODEL`.
- **Status header.** `opencode_ask` replies keep the v1 header:
  ```
  status: ok
  category: ok
  model_used: ai-hub/cx/gpt-6.1-sol
  attempts: ai-hub/cx/gpt-6.1-sol → ok [42.1s]
  elapsed: 42.1s
  ```

---

## 1. Prerequisites (every host)

1. **Node.js 18 or newer** on `PATH`.
2. **opencode** installed and working from a terminal:

   | OS | Install |
   |---|---|
   | macOS | `brew install opencode` or `npm i -g opencode-ai` |
   | Linux | `npm i -g opencode-ai` or `curl -fsSL https://opencode.ai/install \| bash` |
   | Windows | `npm i -g opencode-ai`, `scoop install opencode`, or `choco install opencode` |

3. **A provider configured in opencode.** For AI Hub, add a provider to
   `~/.config/opencode/opencode.jsonc` (Windows: `%USERPROFILE%\.config\opencode\opencode.jsonc`)
   with your own `sk-hub-...` key. Never commit that file. AI Hub speaks the Anthropic
   Messages API for every model family (it translates to each upstream), so a single
   `@ai-sdk/anthropic` provider covers GPT, Gemini, Claude, DeepSeek, GLM and the rest.
   Only list model ids that your AI Hub key actually has access to.

   ```jsonc
   {
     "$schema": "https://opencode.ai/config.json",
     "provider": {
       "ai-hub": {
         "npm": "@ai-sdk/anthropic",
         "name": "AI Hub (Anthropic)",
         "options": {
           "baseURL": "https://ai-hub.my/v1",
           "apiKey": "sk-hub-REPLACE_ME"
         },
         "models": {
           "cx/gpt-6.1-sol": { "name": "cx/gpt-6.1-sol (via AI Hub)" },
           "cx/gpt-6-astra": { "name": "cx/gpt-6-astra (via AI Hub)" },
           "kimi-k3": { "name": "kimi-k3 (via AI Hub)" },
           "glm-5.3": { "name": "glm-5.3 (via AI Hub)" },
           "deepseek-v4-pro[1m]": { "name": "deepseek-v4-pro[1m] (via AI Hub)" },
           "cx/gpt-6.1-terra": { "name": "cx/gpt-6.1-terra (via AI Hub)" },
           "glm-5": { "name": "glm-5 (via AI Hub)" },
           "mimo-v2.6-pro": { "name": "mimo-v2.6-pro (via AI Hub)" },
           "glm-5.2": { "name": "glm-5.2 (via AI Hub)" },
           "kimi-k2.6": { "name": "kimi-k2.6 (via AI Hub)" },
           "hy4-preview": { "name": "hy4-preview (via AI Hub)" },
           "cx/gpt-6-luna": { "name": "cx/gpt-6-luna (via AI Hub)" },
           "mimo-v2.6-flash": { "name": "mimo-v2.6-flash (via AI Hub)" },
           "deepseek-v4.1-flash": { "name": "deepseek-v4.1-flash (via AI Hub)" },
           "minimax-m3": { "name": "minimax-m3 (via AI Hub)" }
         }
       }
     }
   }
   ```

   The `models` block above lists every alias in the skill's High / Medium / Low pools
   (`skills/opencode/SKILL.md`). A pool alias missing from this block cannot be used:
   the server skips it (`model_unavailable` when no candidate is left).

   > **If you are an AI agent installing this for a user:** do not stop at copying the
   > snippet. Open the user's existing `opencode.jsonc`, read the `models` block of the
   > `ai-hub` provider, and compare it with every alias in the three pools of
   > `skills/opencode/SKILL.md`. Add each missing alias under `models` (the key is the bare
   > alias, without the `ai-hub/` prefix), keeping the user's existing entries, `baseURL`
   > and `apiKey` untouched. Then run the check in step 4 and confirm every pool alias
   > shows up as `ai-hub/<alias>`. If the user's AI Hub key has no access to an alias,
   > remove it from the pools in `SKILL.md` instead of leaving it in.

4. Check that it works:

   ```bash
   opencode models | grep ai-hub        # Windows: opencode models | findstr ai-hub
   opencode run -m ai-hub/deepseek-v4.1-flash "Reply with exactly the word: pong"
   ```

   Use the piped form above: opencode 2.x no longer accepts a provider argument, so
   `opencode models ai-hub` fails there with "Unexpected positional argument" (it only works
   on 1.x). The MCP server itself calls plain `opencode models` and works on both.

5. Clone this repo:

   ```bash
   git clone https://github.com/bangya96/opencode-mcp-aihub.git
   ```

---

## 2. Install in Claude Code

### 2a. The MCP server

Clone the repo somewhere permanent and check the setup:

```bash
git clone https://github.com/bangya96/opencode-mcp-aihub.git ~/opencode-mcp-aihub
node ~/opencode-mcp-aihub/opencode-mcp.mjs doctor
```

Register it at **user scope**, which makes it available in every project. Set
`OPENCODE_MCP_MODEL` if you want a default model; otherwise every call must pass `model`.

```bash
# macOS / Linux
claude mcp add --scope user opencode -- node "$HOME/opencode-mcp-aihub/opencode-mcp.mjs"
```
```powershell
# Windows
claude mcp add --scope user opencode -- node "$env:USERPROFILE\opencode-mcp-aihub\opencode-mcp.mjs"
```

Updating is `git pull` in the clone, then reconnecting the server (`/mcp`).

### 2b. The skill

```bash
# macOS / Linux
mkdir -p ~/.claude/skills
cp -R ~/opencode-mcp-aihub/skills/opencode ~/.claude/skills/
```
```powershell
# Windows
Copy-Item -Recurse "$env:USERPROFILE\opencode-mcp-aihub\skills\opencode" "$env:USERPROFILE\.claude\skills\"
```

### 2c. Optional: completion-wake hook

Claude Code does not wake the model when a background job finishes. This hook does: after every
`opencode_run`, it waits for the job and wakes Claude when it ends, unless the result was already
read. Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "mcp__opencode__opencode_run(_sync)?",
        "hooks": [
          { "type": "command", "command": "node /absolute/path/to/opencode-mcp-aihub/opencode-mcp.mjs hook-wait", "asyncRewake": true, "timeout": 3700 }
        ]
      }
    ]
  }
}
```

The hook's `timeout` (seconds) must exceed hook-wait's own limit (1 hour by default,
`--timeout-ms` or `OPENCODE_MCP_HOOK_TIMEOUT_MS`). Hooks run with your shell environment: if you set
`OPENCODE_MCP_STATE_DIR` for the server, set it for the hook too.

### 2d. Verify

1. Restart Claude Code, or run `/mcp` and reconnect `opencode`.
2. `/mcp` should list **opencode · connected** with 7 tools.
3. Ask: *"use opencode to list the ai-hub models"*. Claude should call `opencode_models`.
4. Ask: *"guna opencode buat plan untuk ..."*. Claude should call `opencode_run` with `mode: "plan"`
   and an explicit `model`.

---

## 3. Install in OpenAI Codex CLI

Codex CLI reads MCP servers from `~/.codex/config.toml` (Windows: `%USERPROFILE%\.codex\config.toml`).

### 3a. The MCP server

```bash
codex mcp add opencode -- node "$HOME/opencode-mcp-aihub/opencode-mcp.mjs"
```

Or by hand:

```toml
[mcp_servers.opencode]
command = "node"
args = ["/Users/<you>/opencode-mcp-aihub/opencode-mcp.mjs"]
# Windows: args = ['C:\Users\<you>\opencode-mcp-aihub\opencode-mcp.mjs']
startup_timeout_sec = 20
# opencode_ask blocks until opencode finishes, which can take minutes. Keep this above the
# longest timeout_ms you use, or use opencode_run + opencode_wait, which never block for long.
tool_timeout_sec = 1200
```

### 3b. The skill

Codex loads agent skills (the same `SKILL.md` format) from `~/.codex/skills/`:

```bash
# macOS / Linux
mkdir -p ~/.codex/skills
cp -R ~/opencode-mcp-aihub/skills/opencode ~/.codex/skills/
```
```powershell
# Windows
Copy-Item -Recurse "$env:USERPROFILE\opencode-mcp-aihub\skills\opencode" "$env:USERPROFILE\.codex\skills\"
```

The skill is client-neutral. In Codex the tools
appear as `opencode.opencode_run` and so on, not `mcp__opencode__...`. If your Codex version does not
pick up `~/.codex/skills`, paste the body of `SKILL.md` into `~/.codex/AGENTS.md`.

### 3c. Verify

```bash
codex mcp list          # opencode should be listed
codex                   # then ask: "use opencode to list the ai-hub models"
```

---

## 4. Install in Hermes Agent

[Hermes Agent](https://hermes-agent.nousresearch.com) (Nous Research) uses this server as a normal
stdio MCP server. It reads MCP servers from `~/.hermes/config.yaml`.

### 4a. The MCP server

```yaml
mcp_servers:
  opencode:
    command: "/usr/local/bin/node"     # absolute path to node: `which node`
    args: ["/Users/<you>/opencode-mcp-aihub/opencode-mcp.mjs"]
    timeout: 300                       # per tool call; opencode_run_sync and opencode_wait return within ~90 s
    env:
      OPENCODE_MCP_MODEL: "ai-hub/cx/gpt-6.1-terra"   # optional default model
```

Windows:

```yaml
mcp_servers:
  opencode:
    command: 'C:\Program Files\nodejs\node.exe'
    args: ['C:\Users\<you>\opencode-mcp-aihub\opencode-mcp.mjs']
    timeout: 300
    env:
      SystemRoot: "${SystemRoot}"
      USERPROFILE: "${USERPROFILE}"
      APPDATA: "${APPDATA}"
      LOCALAPPDATA: "${LOCALAPPDATA}"
      TEMP: "${TEMP}"
```

Then run `/reload-mcp` in a Hermes chat.

### 4b. The skill

Hermes skills use the same `SKILL.md` format (agentskills.io):

```bash
mkdir -p ~/.hermes/skills
cp -R ~/opencode-mcp-aihub/skills/opencode ~/.hermes/skills/
```

### 4c. What differs from Claude Code

- **Use `opencode_run` + `opencode_wait`.** Hermes stops a tool call after `timeout` seconds (300 by
  default). `opencode_run_sync` and `opencode_wait` return within about 90 s, but the blocking
  `opencode_ask` waits for opencode to finish and can run longer.
- **No completion wake-up.** The hook in 2c is Claude Code only. In Hermes, call `opencode_wait`
  again while the state is `running`. Every result begins with `job_id`, `state`, `session_id`,
  `cwd` and a `next:` line.
- **Filtered environment.** Hermes gives MCP servers only a few variables (`PATH`, `HOME`,
  `XDG_*` and similar) plus what you list under `env`. opencode still finds
  `~/.config/opencode/opencode.jsonc` through `HOME`. Put any `OPENCODE_MCP_*` setting under `env`,
  and on Windows the variables shown above. If opencode cannot start, the error names the missing
  variables.
- **Same machine.** opencode must be installed and configured where Hermes runs, and the `cwd` you
  pass must exist there.
- With `trust: untrusted`, Hermes asks before `opencode_run`, `opencode_run_sync`, `opencode_ask`
  and `opencode_cancel`; the read-only tools are annotated and do not prompt.
- Cancelling a tool call in Hermes does not stop the opencode job; use `opencode_cancel`.

CI runs a client that reads only the text of each result, starts the server with a Hermes-style
filtered environment and reconnects mid-job, on Linux, macOS and Windows. Hermes itself is not part
of CI; reports from Hermes users are welcome.

---

## 5. Configuration (env vars)

Set these in the `env` block (Claude Code), `env = { ... }` under `[mcp_servers.opencode]` (Codex) or
`env:` under `mcp_servers.opencode` (Hermes):

| Var | Default | Meaning |
|---|---|---|
| `OPENCODE_MCP_MODEL` | none | Model used when a call passes no `model`. Without it, every call must pass one |
| `OPENCODE_MCP_TIMEOUT_MS` | `600000` | Per-attempt timeout |
| `OPENCODE_MCP_BIN` | auto | Full path to the opencode binary, if it isn't found automatically |
| `OPENCODE_MCP_MAX_OUTPUT` | `120000` | Max characters returned per run |
| `OPENCODE_MCP_PROMPT_ARGV` | unset | `1` passes the prompt as an argument instead of stdin (old behaviour) |
| `OPENCODE_MCP_STATE_DIR` | `~/.local/state/opencode-mcp`, Windows `%LOCALAPPDATA%\opencode-mcp` | Job state (kept 24 h) |
| `OPENCODE_MCP_SYNC_WAIT_MS` | `90000` | Inline wait cap for `opencode_run_sync` / `opencode_wait` |
| `OPENCODE_MCP_MAX_CONCURRENCY` | `4` | Running jobs per state dir |
| `OPENCODE_MCP_JOB_TTL_MS` | `86400000` | Finished jobs are deleted after this |
| `OPENCODE_MCP_HOOK_TIMEOUT_MS` | `3600000` | hook-wait limit |
| `OPENCODE_MCP_DEBUG` | unset | `1` logs to stderr |

## 6. Customising the skill's model pools

`skills/opencode/SKILL.md` has **High / Medium / Low** pools of model aliases. They reflect
the author's AI Hub catalogue and will drift. Run `opencode models | grep ai-hub`, or call the
`opencode_models` tool, and keep the two in step: every alias in the pools must also be under `models` in
`opencode.jsonc` (section 1, step 3). Add a new alias to both, and remove one from both. Aliases are
written without the `ai-hub/` prefix, which the skill adds when calling.

## 7. Windows notes

- `where opencode` usually finds the npm shim `opencode.cmd`. Node can't spawn a `.cmd`
  without a shell, and a shell would mangle multi-line prompts. The server therefore resolves
  the real `opencode.exe` by itself, from a scoop or choco `.exe` shim or from the npm package.
- Prompts go over stdin, so there is no command-line length limit.
- Timeouts and cancellation kill the process tree with `taskkill /pid <pid> /T /F`.
- `git` for change detection is looked up on absolute `PATH` entries only, never in the project folder.
- If a call fails with `launch_failed`, set `OPENCODE_MCP_BIN` to the full path of `opencode.exe`.
- The test suite runs on Windows in CI with a fake opencode.

## 8. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `model_required` | No `model` and no `OPENCODE_MCP_MODEL`. Pass a model from `opencode_models`. |
| `model_unavailable` | The model isn't in `opencode models`, or the gateway rejected it. Pick another one. |
| `rate_limited` / `quota_exhausted` | That model's allowance is used up. Pass `fallback_models`, or wait for the `retry after` time. |
| `server_error` / `unavailable` | The provider returned a 5xx or could not be reached. Fallback is attempted automatically. |
| `auth_required` | The provider rejected the API key. Check the opencode config. |
| `busy_workspace` | Another `edit` job is running in that repository. See `opencode_status`. |
| `busy_session` | Another job is using that opencode session. |
| `timeout` | Raise `timeout_ms`, continue the `session_id`, or split the task. |
| Anything else | Run `node opencode-mcp.mjs doctor`. |

### Smoke test without any host

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"opencode_models","arguments":{"provider":"ai-hub"}}}' \
  | node opencode-mcp.mjs
```

## Migrating from v1

- v1 (`opencode-mcp-macos.mjs` / `opencode-mcp-windows.mjs`, usually copied to
  `~/.claude/mcp/opencode-mcp.mjs`) keeps working and is no longer updated.
- To move to v2: clone the repo, run `doctor`, and point the registration at `opencode-mcp.mjs` in
  the clone (section 2a). The tool name (`opencode`) and `opencode_ask` / `opencode_models` /
  `opencode_status` stay compatible.
- **Breaking:** there is no built-in default model any more (the old default no longer exists on AI
  Hub). Pass `model` or set `OPENCODE_MCP_MODEL`.
- `opencode_status` without arguments still lists running work; v2 also accepts `job_id`.

## Credits

The job supervision, idempotency, change detection, completion-wake hook and doctor design come from
[agycli-mcp](https://github.com/bangya96/agycli-mcp) by the same author, which in turn took ideas from
[tphakala/agy-mcp](https://github.com/tphakala/agy-mcp).

## License

MIT. See [LICENSE](LICENSE).
