# Agent Guidelines

## Project Overview

This is a Pi extension that spawns isolated subagents in separate `pi --mode rpc` subprocesses. It enables background task delegation, parallel execution, and multi-turn interactions via keep-alive mode.

## Architecture

- **`index.ts`**: Main extension entry point that registers tools (`subagent_start`, `subagent_list`, `subagent_wait`, `subagent_prompt`, `subagent_kill`)
- **`child.ts`**: Child process extension loaded by spawned subagents; injects `update_status` tool and handles RPC communication
- **`agents.ts`**: Discovers and parses agent definitions from `~/.pi/agent/subagents/` and `.pi/subagents/` directories

## Key Concepts

### Subagent States

| State | Description |
|-------|-------------|
| `starting` | Process launched, awaiting first response |
| `running` | Actively processing (or retrying) a prompt |
| `idle` | Turn complete, waiting for follow-up prompt |
| `done` | Completed successfully, process exited |
| `error` | Failed non-retryably, process exited |
| `killed` | Terminated via kill command |

### Retry Behavior (v1.2.0+)

Retryable errors (rate limits, 5xx, network issues, timeouts) keep the subagent in `running` state instead of transitioning to `error`. Pi's built-in auto-retry mechanism attempts recovery. Context overflow errors are NOT retryable (handled by compaction).

**Check `isRetryableError()` in `index.ts` for the full regex pattern.**

## Development

```bash
pnpm install
pi run --extension ./index.ts "test prompt"
```

## Important Files

- `index.ts`: Tool implementations and subagent lifecycle management
- `child.ts`: RPC protocol handling and status reporting
- `agents.ts`: Agent discovery and frontmatter parsing
- `README.md` / `README.zh-CN.md`: User documentation

## Git Workflow

Use conventional commits:
- `feat:` for new features
- `fix:` for bug fixes
- `docs:` for documentation changes
- `chore:` for maintenance tasks

Bump version in `package.json` before committing feature releases.
