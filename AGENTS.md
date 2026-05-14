# Agent Instructions

## Package Manager
- Use **pnpm**: `pnpm install`

## Commands
| Task | Command |
|------|---------|
| Test extension | `pi run --extension ./index.ts "prompt"` |
| Typecheck | `npx tsc --noEmit` |

## Key Files
| Purpose | File |
|---------|------|
| Extension entry | `index.ts` |
| Child process handler | `child.ts` |
| Agent discovery | `agents.ts` |
| User docs | `README.md`, `README.zh-CN.md` |

## Project Structure
- **`index.ts`**: Tool implementations (`subagent_start`, `_list`, `_wait`, `_prompt`, `_kill`)
- **`child.ts`**: RPC protocol and `update_status` tool injection for spawned subagents
- **`agents.ts`**: Discovers agent definitions from `~/.pi/agent/subagents/` and `.pi/subagents/`

## State Machine
Subagents cycle: `starting` → `running` → `idle` (keep-alive) / `done` / `error` / `killed`

## External References
| Need | File |
|------|------|
| API docs | `README.md` |
| Retry behavior (v1.2+) | `CONTEXT.md` |

## Commit Convention
Use conventional commits with scope:
```bash
git commit -m "feat(subagent): add retry handling for transient errors"
```
