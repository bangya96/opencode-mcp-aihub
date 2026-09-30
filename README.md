# opencode-mcp-aihub

A dependency-free stdio MCP server that lets **Claude Code** or **OpenAI Codex CLI**
delegate work to the [opencode](https://opencode.ai) CLI. It was built for models
served through [AI Hub](https://ai-hub.my), but it works with any provider that
opencode is configured for.

The repo has two parts:

| Path | What it is |
|---|---|
| `opencode-mcp.mjs` | The MCP server. One file, Node 18+, no `npm install`. Runs on macOS, Linux and Windows. |
| `skills/opencode/SKILL.md` | An agent skill that tells the host agent *when* and *how* to delegate: model tiers, fallback rules, handoff prompt template, and how to verify the worker's changes. |

## What the server provides

| Tool | Purpose |
|---|---|
| `opencode_ask` | Runs `opencode run` with a self-contained prompt. It is read-only by default, and `allow_edits: true` lets opencode change files. |
| `opencode_models` | Lists the models opencode currently has configured, for example `ai-hub/cx/gpt-5.6-sol`. |
| `opencode_status` | Lists runs that are still in flight. Check it after a timeout, before starting another editing run. |

`opencode_ask` behaves as follows:

- **Model validation.** It checks the model against `opencode models` before running. A model that isn't configured fails in about a second with the list of valid ids, instead of an opaque "Unexpected server error".
- **Automatic fallback.** `fallback_models: [...]` is tried in order, but only on availability errors: rate limit / 429, quota or usage limit, overloaded, 5xx or bad gateway, and model unavailable. Task errors such as failing code or a missing file are never retried on another model.
- **Status header.** Every reply starts with a header like this:
  ```
  status: ok
  category: ok
  model_used: ai-hub/cx/gpt-5.6-sol
  attempts: ai-hub/cx/gpt-5.6-sol → ok [42.1s]
  elapsed: 42.1s
  ```
  A 429 shows up as `→ rate_limit (retry after 489s)`.
- **Timeouts.** A timeout kills the whole process tree. That is the process group on POSIX and `taskkill /T` on Windows. Any partial output is returned.
- **One editing worker per folder.** A second `allow_edits` run in the same `cwd` is refused while the first is still running.
- **Other options.** `variant` passes reasoning effort, for example `high` or `max`. `session_id` continues an earlier session and `title` names it. Output is capped at 120k characters, keeping the head and tail.

---

## 1. Prerequisites (both hosts)

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
           "cx/gpt-5.6-sol": { "name": "cx/gpt-5.6-sol (via AI Hub)" },
           "ag/gemini-3.8-flash-high": { "name": "ag/gemini-3.8-flash-high (via AI Hub)" }
         }
       }
     }
   }
   ```

4. Check that it works:

   ```bash
   opencode models ai-hub
   opencode run -m ai-hub/ag/gemini-3.8-flash-high "Reply with exactly the word: pong"
   ```

5. Clone this repo:

   ```bash
   git clone https://github.com/bangya96/opencode-mcp-aihub.git
   ```

---

## 2. Install in Claude Code

### 2a. The MCP server

Copy the server into your Claude folder:

```bash
# macOS / Linux
mkdir -p ~/.claude/mcp
cp opencode-mcp-aihub/opencode-mcp.mjs ~/.claude/mcp/
```
```powershell
# Windows (PowerShell)
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\mcp" | Out-Null
Copy-Item opencode-mcp-aihub\opencode-mcp.mjs "$env:USERPROFILE\.claude\mcp\"
```

Register it at **user scope**, which makes it available in every project:

```bash
# macOS / Linux
claude mcp add --scope user opencode -- node "$HOME/.claude/mcp/opencode-mcp.mjs"
```
```powershell
# Windows
claude mcp add --scope user opencode -- node "$env:USERPROFILE\.claude\mcp\opencode-mcp.mjs"
```

You can also edit `~/.claude.json` by hand and add this under `"mcpServers"`:

```json
"opencode": {
  "type": "stdio",
  "command": "node",
  "args": ["/Users/<you>/.claude/mcp/opencode-mcp.mjs"],
  "env": {}
}
```

To share the server with a team through a repo, use `--scope project` instead. That writes a
`.mcp.json` at the project root.

### 2b. The skill

```bash
# macOS / Linux
mkdir -p ~/.claude/skills
cp -R opencode-mcp-aihub/skills/opencode ~/.claude/skills/
```
```powershell
# Windows
Copy-Item -Recurse opencode-mcp-aihub\skills\opencode "$env:USERPROFILE\.claude\skills\"
```

### 2c. Verify

1. Restart Claude Code, or run `/mcp` and reconnect `opencode`.
2. `/mcp` should list **opencode · connected** with 3 tools.
3. Ask: *"use opencode to list the ai-hub models"*. Claude should call
   `mcp__opencode__opencode_models`.
4. Ask: *"guna opencode (high) untuk review fail X"*. The `opencode` skill should load, and
   Claude should call `mcp__opencode__opencode_ask` with an explicit `model`.

---

## 3. Install in OpenAI Codex CLI

Codex CLI reads MCP servers from `~/.codex/config.toml` (Windows: `%USERPROFILE%\.codex\config.toml`).

### 3a. The MCP server

```bash
# macOS / Linux
mkdir -p ~/.codex/mcp
cp opencode-mcp-aihub/opencode-mcp.mjs ~/.codex/mcp/
```
```powershell
# Windows
New-Item -ItemType Directory -Force "$env:USERPROFILE\.codex\mcp" | Out-Null
Copy-Item opencode-mcp-aihub\opencode-mcp.mjs "$env:USERPROFILE\.codex\mcp\"
```

Register it with the CLI:

```bash
codex mcp add opencode -- node "$HOME/.codex/mcp/opencode-mcp.mjs"
```

You can also add it to `~/.codex/config.toml` by hand:

```toml
[mcp_servers.opencode]
command = "node"
args = ["/Users/<you>/.codex/mcp/opencode-mcp.mjs"]
# Windows: args = ['C:\Users\<you>\.codex\mcp\opencode-mcp.mjs']
startup_timeout_sec = 20
# IMPORTANT: Codex's default tool timeout is short, and opencode runs often take
# minutes. Set this above the longest timeout_ms you plan to use (default 600s).
tool_timeout_sec = 1200
```

> **Set `tool_timeout_sec`.** Without it, Codex abandons long opencode runs while the worker
> keeps going in the background. That is exactly the overlapping-editor situation the skill
> warns about.

### 3b. The skill

Codex loads agent skills (the same `SKILL.md` format) from `~/.codex/skills/`:

```bash
# macOS / Linux
mkdir -p ~/.codex/skills
cp -R opencode-mcp-aihub/skills/opencode ~/.codex/skills/
```
```powershell
# Windows
Copy-Item -Recurse opencode-mcp-aihub\skills\opencode "$env:USERPROFILE\.codex\skills\"
```

The skill is written from Claude's point of view ("Claude is the planner and reviewer…").
Codex follows it the same way, because the rules are about the host agent, not about Claude
specifically. In Codex the tool appears as `opencode.opencode_ask`, not
`mcp__opencode__opencode_ask`. The skill tells the agent to check the exposed tool schema
first, so it adapts to that name.

If your Codex version does not pick up `~/.codex/skills`, paste the body of `SKILL.md` into
`~/.codex/AGENTS.md` instead. That file is loaded on every run.

### 3c. Verify

```bash
codex mcp list          # opencode should be listed
codex                   # then ask: "use opencode to list the ai-hub models"
```

---

## 4. Configuration (env vars)

Set these in the `env` block (Claude Code) or `env = { ... }` under `[mcp_servers.opencode]`
(Codex):

| Var | Default | Meaning |
|---|---|---|
| `OPENCODE_MCP_MODEL` | `ai-hub/ag/gemini-3.8-flash-high` | Model used when a call passes no `model` |
| `OPENCODE_MCP_TIMEOUT_MS` | `600000` | Per-attempt timeout |
| `OPENCODE_MCP_BIN` | `opencode` | Full path to the opencode binary, if it isn't on `PATH` |
| `OPENCODE_MCP_MAX_OUTPUT` | `120000` | Max characters returned per run |
| `OPENCODE_MCP_DEBUG` | unset | `1` logs to stderr |

## 5. Customising the skill's model pools

`skills/opencode/SKILL.md` has **High / Medium / Low** pools of model aliases. They reflect
the author's AI Hub catalogue and will drift. Run `opencode models ai-hub`, or call the
`opencode_models` tool, and edit the pools so every alias exists in your catalogue. Aliases are
written without the `ai-hub/` prefix, which the skill adds when calling.

## 6. Windows notes

- `where opencode` usually finds the npm shim `opencode.cmd`. Node can't spawn a `.cmd`
  without a shell, and a shell would mangle multi-line prompts. The server therefore resolves
  the real `opencode.exe` by itself, from a scoop or choco `.exe` shim or from
  `node_modules\opencode-ai\bin\opencode.exe` next to the npm shim.
- If a call returns `category: launch_failed`, set `OPENCODE_MCP_BIN` to the full path of
  `opencode.exe`.
- Timeouts kill the process tree with `taskkill /pid <pid> /T /F`.

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `category: model_not_configured` | The model id isn't in `opencode models`. Pick one from the list in the error. |
| `category: rate_limit` / `quota` | That model's allowance is used up. Pass `fallback_models`, or wait for the `retry after` time. |
| `category: server_error` | The provider returned a 5xx. Fallback is attempted automatically. |
| `category: bad_cwd` | `cwd` doesn't exist. Pass an absolute path to an existing folder. |
| `category: edit_conflict` | Another editing run is active in that folder. Check `opencode_status`. |
| `category: timeout` | Raise `timeout_ms` (and Codex's `tool_timeout_sec`), or split the task. |
| Tool list is stale after updating the file | Reconnect the server (`/mcp` in Claude Code), or restart the host. |

### Smoke test without any host

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"opencode_models","arguments":{"provider":"ai-hub"}}}' \
  | node opencode-mcp.mjs
```

## License

MIT. See [LICENSE](LICENSE).
