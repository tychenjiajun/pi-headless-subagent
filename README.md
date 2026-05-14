# pi-headless-subagent

A pi extension for spawning isolated subagents in separate `pi --mode rpc` subprocesses.

## Install

```bash
pi install npm:pi-headless-subagent
```

---

## What it does

- Runs delegated work in session-isolated subprocesses that load the same extensions/plugins as the parent
- Injects a child-only `update_status(message)` tool for progress reporting
- Inherits the parent session's active tool set, then optionally narrows it per agent
- Supports one-off subagent runs, parallel swarms, sequential chains, and background start/wait/prompt/kill flows
- Keep-alive mode by default: subagents stay alive after each turn for fast follow-up prompts without re-spawning

## Tools

### `subagent_start`

Start a background subagent and return immediately with its id.

```json
{
  "task": "Find all uses of the fetch API",
  "agent": "scout",        // optional: predefined agent name
  "cwd": "/path/to/project" // optional: working directory
}
```

**Ad hoc variant** (no predefined agent):

```json
{
  "task": "Review the API surface",
  "systemPrompt": "You are an API review specialist.",
  "tools": ["read", "grep"]
}
```

> Only use when the user explicitly asks for a background subagent. Nested delegation is blocked (subagents cannot spawn their own).

---

### `subagent_list`

List tracked subagents and their current status.

```json
// List all (including completed)
{}

// Exclude completed/errored/killed
{"includeCompleted": false}
```

---

### `subagent_wait`

Wait for a background subagent to finish its current turn. **Blocks until completion** unless a timeout is specified.

```json
// Wait for specific subagent
{"id": "abc"}

// Wait for all active subagents
{"all": true}

// With timeout (returns current state if exceeded, doesn't kill)
{"id": "abc", "timeoutMs": 30000}
```

Returns the handle once the subagent reaches `idle`, `done`, `error`, or `killed` state. If `timeoutMs` expires before completion, returns the current partial state without terminating the subagent.

---

### `subagent_prompt`

Send a follow-up prompt to an **idle** subagent. Uses RPC to send the prompt without re-spawning.

```json
{"id": "abc", "message": "Now also check TypeScript files..."}
```

Requirements:
- Subagent must be in `idle` state (call `subagent_wait` first if needed)
- Process must still be alive (`subagent_kill` terminates it)

---

### `subagent_kill`

Terminate a live subagent process (including **idle** keep-alive ones).

```json
{"id": "abc"}
```

Works on any non-terminal state: `starting`, `running`, `idle`, or unsettled `killed`. Rejects if already terminal (`done`, `error`, settled `killed`).

---

## Custom agents

Agent files are Markdown with YAML frontmatter placed in:

- User overrides: `~/.pi/agent/subagents/`
- Project overrides: nearest `.pi/subagents/`

Project overrides take precedence over user overrides when both define agents with the same name.

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
model: deepseek/deep-3
---

You are a fast reconnaissance specialist focused on speed...
```

## Subagent state machine

| State | Meaning | Can receive `subagent_prompt`? | Can be killed? |
|-------|---------|-------------------------------|----------------|
| `starting` | Process launched, awaiting first response | No | Yes |
| `running` | Actively processing a prompt | No | Yes |
| `idle` | Finished a turn, process still alive for follow-ups | **Yes** | Yes |
| `done` | Completed successfully, process exited | No | No (terminal) |
| `error` | Failed or errored, process exited | No | No (terminal) |
| `killed` | Terminated via `subagent_kill` | No | No (if settled) |

Key points:
- **Keep-alive mode**: By default, subagents transition to `idle` after each turn instead of exiting. This enables fast multi-turn interactions via `subagent_prompt`.
- **Terminal states**: `done`, `error`, and settled `killed` means the process has exited and cannot be used again.

## Continuous prompting pattern

Subagents stay alive between prompts by default. Use this pattern for multi-turn interactions:

```
1. subagent_start({ task: "Initial analysis..." })
2. subagent_wait({ id: "abc" })
3. subagent_prompt({ id: "abc", message: "Now also check..." })
4. subagent_wait({ id: "abc" })
5. subagent_prompt(...)
...
N. subagent_kill({ id: "abc" })
```

### Best practices

- Always wait for `idle` before sending a follow-up prompt
- Use `subagent_list` to inspect states before acting
- Call `subagent_kill` when finished — processes persist until killed or parent session ends
- Idle subagents retain: working directory, tool context, accumulated conversation history

### When NOT to use continuous prompting

- For independent tasks, spawn separate subagents via `subagent_start`
- If you need different tools or system prompts between turns, start a new subagent
- If the subagent has exited (`done`/`error`/settled `killed`), you must spawn again

## Notes

- **Nested delegation is blocked** — subagents cannot call `subagent_start`; they report needs back to the parent
- **Result persistence** — large results are saved to temp files; the tool response includes the path so you can recover full output with `read`
- **Abort behavior** — aborting the parent agent also aborts all active subagents; aborting `subagent_wait` stops waiting but leaves the subagent alive
- **Model inheritance** — subagents inherit the parent session model by default; override with `model`/`models` in agent frontmatter
- **Extension loading** — child processes load the same extensions/plugins as the parent (unlike `--no-session`)
- **Retry behavior (v1.2.0+)** — transient errors (rate limits, 5xx responses, network issues, timeouts) trigger Pi's auto-retry instead of immediately failing. The subagent stays in `running` state while retries proceed. Context overflow errors are NOT retried (handled by compaction).
