---
name: opencode
description: Delegate implementation, investigation, planning or code review to OpenCode through the opencode MCP tools (opencode_run / opencode_wait / opencode_ask) when the user asks to use OpenCode or explicitly assigns it a task. Triggers include "guna opencode", "suruh opencode", "ask opencode", and "delegate to opencode". Requests mentioning Terra or Gemini trigger this skill when the context clearly refers to the OpenCode worker.
---

# OpenCode delegation

Claude is the user's discussion partner, planner, and reviewer.
OpenCode is the delegated implementation or investigation agent.

Use the opencode MCP tools for delegation. This skill explains how to use them;
it does not create the tools or grant execution permissions.

## Session and tool contract

Treat every job as a fresh session without Claude's conversation history, unless
you continue an earlier opencode session with `session_id`. OpenCode can inspect
project files through its permitted tools, but decisions and requirements that
exist only in Claude's conversation must be supplied.

The v2 server exposes:

- `opencode_run`: start a background job; returns `job_id` and `session_id`.
- `opencode_run_sync`: start and wait up to ~90 s.
- `opencode_wait` / `opencode_status` / `opencode_cancel`: collect, inspect or stop a job.
- `opencode_ask`: the v1 blocking call (`allow_edits` instead of `mode`).
- `opencode_models`: the configured catalogue.

Run parameters: `prompt` (self-contained), `mode` (`plan` | `ask` | `edit`),
`model` (always explicit `provider/model`), `fallback_models`, `cwd` (absolute
project root), `timeout_ms` (per attempt, default 600000), `session_id`,
`variant`, `title`, `idempotency_key`.

Check the exposed tool schema before calling. If only `opencode_ask` exists (a
v1 server), use it with `allow_edits` and the same rules. If parameters or
behaviour differ from this skill, follow the actual contract and explain any
material mismatch. Do not invent unsupported parameters.

`ask` and `plan` use a read-only agent (edit, shell and subagent tools removed).
That is a tool restriction, not an OS sandbox: globally configured opencode MCP
servers or plugins are not covered. `edit` can change files and run commands.

If the tools are unavailable, explain the blocker. Do not silently implement
the delegated task yourself or substitute another integration.

## Model routing and fallback

The model pools below are the user's local routing preference, not a verified
ranking of model capability. Entries are ordered fallback candidates.

Store aliases without the provider prefix for readability. When invoking the
current AI Hub integration, expand an alias as:

`<alias>` -> `ai-hub/<alias>`

Example: `cx/gpt-6.1-sol` -> `ai-hub/cx/gpt-6.1-sol`.

If the actual tool schema or current catalogue requires a different ID format,
follow the actual contract instead of forcing this prefix.

### High tier

Use for multi-file implementation, ambiguous requirements, subtle bugs,
architecture-sensitive work, complex logic, and high-correctness tasks.

1. `cx/gpt-6.1-sol`
2. `cx/gpt-6-astra`
3. `kimi-k3`
4. `glm-5.3`
5. `deepseek-v4-pro[1m]`

### Medium tier

Use for well-scoped features, fixes that follow established patterns,
moderate refactors, and ordinary implementation work.

1. `cx/gpt-6.1-terra`
2. `glm-5`
3. `mimo-v2.6-pro`
4. `glm-5.2`
5. `kimi-k2.6`
6. `hy4-preview`

### Low tier

Use for simple lookups, mechanical edits, small boilerplate tasks, targeted
searches, and low-risk changes.

1. `cx/gpt-6-luna`
2. `mimo-v2.6-flash`
3. `deepseek-v4.1-flash`
4. `minimax-m3`

Do not use image-generation or embedding aliases as delegation fallbacks.

### Selection priority

1. An explicit model choice by the user takes precedence.
2. Otherwise choose the task tier, then start from the first candidate.
3. Prefer a higher tier when ambiguity or correctness risk justifies it.
4. Always send `model`; never rely on the MCP server's default.

If the user explicitly says to use only one exact model, do not fall back from
that model. Report the failure if it cannot run.

If the user names a model but does not require it exclusively, try that model
first. On a retryable model-availability failure, continue with the normal pool
for the task's tier, skipping duplicates.

### Automatic fallback policy

Use the next candidate only when the previous candidate fails for a reason that
is plausibly model- or provider-availability related, for example:

- quota, credit, or token allowance exhausted;
- rate limit / HTTP 429;
- model unavailable, disabled, overloaded, or at capacity;
- configured model ID rejected or no longer available;
- provider-specific temporary availability failure.

Do not switch models merely because OpenCode reports a coding problem, failing
test, missing requirement, bad path, permission issue, invalid tool arguments,
or another task-level error. Changing models does not fix those conditions.

Never retry the same failed model in the same delegation unless the error
clearly indicates a transient retry-after condition and retrying once is safer
than moving on.

If an error clearly affects an entire provider, skip remaining candidates from
that provider for the current delegation and continue with the next different
provider.

Stop immediately after the first successful OpenCode response. Do not call
additional models to compare answers unless the user explicitly asks for
multiple independent attempts.

### Long jobs, timeouts and uncertain execution

Prefer `opencode_run` for anything that may take more than a minute, then
`opencode_wait` (repeat while it is running) or wait for the completion-wake
hook. Jobs keep running if Claude Code restarts or the call is abandoned; find
them again with `opencode_status`.

A timeout or lost connection does not prove the worker stopped. Before starting
another `edit` job in the same repository, check `opencode_status` and the
working tree. The server refuses a second concurrent `edit` job in one
repository (`busy_workspace`) and a second job on one session (`busy_session`).

In `edit` mode the server stops falling back to the next model once the failed
attempt has used a tool, because files may already have changed. Inspect
`git diff` before retrying in that case. For `ask` and `plan`, fallback is safe.

### Catalogue recovery

The local catalogue is in `~/.config/opencode/opencode.jsonc`, under
`provider.ai-hub.models`.

If an explicitly requested model is absent from the pools, a configured ID is
rejected, or every candidate in the selected pool is unavailable, inspect the
current catalogue before concluding there is no usable model.

Extract only model keys and necessary non-secret metadata using a JSONC-aware
reader. Do not print or load the entire configuration into the conversation;
it may contain API keys.

Use catalogue recovery only to resolve model availability. Do not silently
modify provider configuration.

If no suitable model can be resolved after the configured pool and catalogue
check, report the blocker instead of silently doing the delegated task yourself.

## Choose the task mode

### Consultation, investigation, or review

Use `mode: "ask"` (v1: `allow_edits: false`).

Define the question, relevant code, and expected evidence. Request findings
with file references and a distinction between confirmed facts and hypotheses.
The result's `changes` field reports files that changed during the job; for an
`ask` job that should be empty. If it is not, tell the user (someone else may
have edited at the same time) and do not revert automatically.

For review-only work, a matching `-review` model variant may be used when it is
present in the current catalogue, but it is optional. The normal tier fallback
policy still applies if that review variant is unavailable.

### Planning (plan-first workflow)

Use `mode: "plan"` to have OpenCode study the code and propose a plan without
touching files. Show the plan to the user, summarised with the key steps and
risks you see. Only after the user approves, call `opencode_run` with
`mode: "edit"`, the plan job's `session_id`, the same model, and a prompt such as
"The plan is approved. Implement it now, then verify the change." Add any
changes the user asked for in that prompt.

### Implementation or correction

Use `mode: "edit"` (v1: `allow_edits: true`) only when changes are authorized.

For the user's plan-first workflow, discuss requirements and obtain approval
before implementation. An explicit instruction to implement an agreed plan
already counts as approval.

Carry existing authorization forward. Do not ask again for routine corrections
within the approved scope. Ask when new decisions materially expand scope or
change agreed behavior.

Claude should delegate implementation and retain responsibility for independent
review and testing. If delegation is blocked, report it rather than silently
taking over development.

## Prepare the handoff

Inspect only enough context to identify the project, relevant files, existing
patterns, and task boundaries. Prefer `rg` for file and text searches.

For edits:

- Inspect applicable project instructions.
- Record existing tracked and untracked changes.
- Inspect relevant pre-existing diffs so later changes can be distinguished.
- Include clear acceptance criteria.
- Use an approved plan/spec file when one already exists.
- For a small task, a complete prompt is sufficient; do not create unnecessary
  planning documents.

Keep Claude and OpenCode from editing the same files concurrently. Ensure
Claude later verifies the exact workspace where OpenCode worked.

## Write a self-contained prompt

Include the information needed for this specific task:

- Absolute project root and relevant file paths.
- Task mode and desired outcome.
- Approved requirements and acceptance criteria.
- Relevant conventions and project instruction files.
- Decisions from the conversation that are not recorded in project files.
- Scope boundaries and known pre-existing changes.
- Relevant validation commands, when known.
- Required completion report.

Tell OpenCode to inspect the current implementation before editing and preserve
unrelated changes. Allow it to discover additional relevant files rather than
treating an initial file list as exhaustive.

Do not weaken or remove tests merely to make checks pass. Update tests when
approved behavior changes and explain why.

Delegation does not authorize commits, pushes, deployments, destructive Git
operations, or production data changes unless the user explicitly includes them.

Do not let OpenCode recursively delegate back through the same integration.

### Example implementation prompt

```text
Project: <absolute project root>
Mode: Implementation
Approved requirements: <requirements or plan path>
Model tier: <high | medium | low>

Outcome:
<desired behavior>

Acceptance criteria:
<observable conditions for completion>

Context:
<relevant files, conventions, decisions, and existing changes>

Instructions:
- Read applicable project instructions and inspect the existing implementation.
- Implement the approved scope and preserve unrelated changes.
- Add or update tests where needed to verify changed behavior.
- Run relevant checks available in this environment.
- Do not commit, push, deploy, or perform destructive operations unless explicitly
  authorized in this task.
- If a material requirement is unclear, report the blocker rather than inventing
  a product decision.

Return:
- Completion status: complete, partial, or blocked.
- Model actually used.
- Summary and files created, modified, or deleted.
- Validation commands, results, and any checks not run.
- Remaining issues, assumptions, and decisions needing clarification.
```

Replace placeholders before sending. Never include secrets.

## After OpenCode replies

Treat its response as a report to verify, not proof of completion.

1. Inspect workspace status and compare against the pre-delegation baseline.
2. Review tracked changes and inspect new/untracked files separately.
   `git diff` alone does not show the contents of untracked files.
3. Check actual changes against acceptance criteria, project conventions,
   and scope. Look beyond the worker's reported file list.
4. Independently run relevant tests or checks, proportionate to the changes.
5. For UI changes, verify relevant interactions and visual behavior when browser
   tooling is available. A successful HTTP response alone does not verify the UI.

Do not claim independent verification if the environment prevents it.
Distinguish implemented work, verified behavior, and checks that remain unrun.

For review-only tasks, verify the evidence behind important findings before
presenting them as confirmed.

## Corrections and follow-up calls

Every follow-up must stand alone. Include:

- Original requirements or approved plan path.
- Current implementation state and relevant existing changes.
- Exact failure, reproduction steps, or test output.
- Expected behavior and correction scope.
- The model previously used and any model fallback already attempted.

Send focused corrections to OpenCode, then verify again.

If repeated attempts make no progress, stop the retry loop, explain the evidence,
and identify the missing information or decision. Do not retry indefinitely.

## Timeouts and failures

A timeout or lost connection does not prove the worker stopped.

Before retrying:

- Check execution status using the integration's supported status mechanism,
  or inspect the relevant local process if available.
- Inspect partial changes.
- Do not launch another editing worker while the first may still be running.

If status cannot be established, report the uncertainty and pause overlapping
edits until it is resolved.

If a run partially completed, make the next prompt describe the current state
and remaining work. Do not blindly repeat the original implementation request.

Increase timeout only within supported limits. Prefer bounded tasks when a
large change would be difficult to review or recover.

## Report to the user

Briefly state:

- What changed or what was found.
- Which model was actually used, and whether fallback occurred when relevant.
- What Claude independently verified.
- Any remaining failures, limitations, or decisions.

Do not describe partial or unverified work as fully complete.
