# pi-headless-subagent

A pi extension for spawning isolated subagents in separate `pi --mode rpc` subprocesses.

## What it does

- Runs delegated work in session-isolated subprocesses that load the same extensions/plugins as the parent
- Injects a child-only `update_status(message)` tool for progress reporting
- Inherits the parent session's active tool set, then optionally narrows it per agent
- Supports one-off subagent runs, parallel swarms, sequential chains, and background start/wait/prompt/kill flows

## Tools

- `subagent_start` — Start a background subagent and return immediately with its id. Only for cases where the user explicitly asks for a background subagent. Nested delegation is blocked.
- `subagent_list` — List tracked subagents and their current status
- `subagent_wait` — Wait for a background subagent (or all active subagents) to finish
- `subagent_prompt` — Send a follow-up prompt to an idle subagent. The subagent must have finished its current turn (state `idle`). Uses RPC to send the prompt without re-spawning the subprocess.
- `subagent_kill` — Abort a running background subagent

## Built-in agents

This extension ships with:

- **`scout`** — Fast read-mostly codebase reconnaissance. Use for finding code, tracing call sites, and collecting high-signal context.
- **`reviewer`** — Read-only code review specialist. Returns independent, evidence-backed findings optimized for TLA synthesis.

## Custom agents

Agent files are Markdown with YAML frontmatter.

Lookup order (later sources override earlier ones by name):

1. Built-in agents: `./agents/` in this extension
2. User overrides: `~/.pi/agent/subagents/`
3. Project overrides: nearest `.pi/subagents/`

### Frontmatter schema

```yaml
---
name: <agent-name>
description: <short description>
tools: [read, grep, find, ls]  # optional: comma-separated or array
model: <provider/model-id>       # optional: single model (e.g., openai/gpt-4o)
models: [<pattern>, ...]         # optional: multiple models (e.g., claude-*,gpt-4o)
---

<system prompt>
```

### Example

```md
---
name: cheap-scout
description: Fast reconnaissance agent for broad code search
tools: read,grep,find,ls
model: deepseek/deep-3   # Use a specific, efficient model for speed
models: ["claude-*,gpt-4o"]  # Or match any claude or gpt-4o variant
---

You are a fast reconnaissance specialist focused on speed...
```

## Ad hoc subagents

You can spawn a subagent without a predefined agent by omitting `agent` and providing a task:

```json
{
  "task": "Review the API surface and summarize it",
  "systemPrompt": "You are a concise API review specialist.",
  "tools": ["read", "grep", "find", "ls"]
}
```

If no `systemPrompt` is provided, a default prompt is used.

## Subagent state machine

A subagent goes through these states:

- **`starting`** — Process launched, awaiting first response
- **`running`** — Actively processing a prompt
- **`idle`** — Finished a turn, process still alive for follow-up prompts
- **`done`** — Completed successfully, process exited
- **`error`** — Failed or errored, process exited
- **`killed`** — Killed via `subagent_kill`

## Continuous prompting pattern

Subagents stay alive between prompts by default. Use this pattern for multi-turn interactions:

```
1. subagent_start({ task: "...", id: "abc" })
2. subagent_wait({ id: "abc" })        // wait for current turn to finish
3. subagent_prompt({ id: "abc", message: "Now do this instead..." })
4. subagent_wait({ id: "abc" })        // wait for the follow-up to finish
5. subagent_prompt({ id: "abc", message: "Another follow-up..." })
// ... repeat as needed
```

### Key points

- Always call `subagent_wait` first — the subagent must be in `idle` state
- Use `subagent_list` to check state before prompting
- `subagent_prompt` sends via RPC to the existing subprocess (fast, preserves context)
- Idle subagents retain working directory, tool context, and accumulated state
- Call `subagent_kill` when done, or the process stays alive until parent session ends

### When NOT to use continuous prompting

- For independent tasks, use separate `subagent_start` calls
- If you need different tools or system prompts between turns, spawn new subagents
- If the subagent has exited (`done`/`error`/`killed` with no process), you must start again

## Notes

- Nested delegation is blocked — subagents cannot call `subagent_start`
- Large results are persisted to temp files; the tool response includes the path so you can recover full output with `read`
- Aborting the parent agent also aborts all active subagents
- Aborting `subagent_wait` stops waiting but does not kill the subagent
- Subagents inherit the parent session model by default, or use `model`/`models` in frontmatter to override
- The child process loads the same extensions/plugins as the parent (unlike `--no-session`)