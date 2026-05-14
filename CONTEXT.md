# Context: Subagent Retry Handling

## Problem Statement (v1.2)

Subagents were transitioning to `error` state on **any** LLM error, blocking Pi's auto-retry mechanism from recovering transient failures like rate limits or network blips.

## Decision Tree

### When does a subagent fail vs retry?

```
agent_end event with stopReason="error" or errorMessage
│
├─ Is error retryable? → YES  → Stay in 'running', don't settle
│                          → Let Pi handle exponential backoff retry
│
└─ Is error retryable? → NO   → Transition to 'error', settle handle
                                   │
                                   ├─ Context overflow → Handled by compaction
                                   ├─ Auth failure     → Terminal (re-login needed)
                                   └─ Invalid config   → Terminal (user fix required)
```

### What makes an error retryable?

Matches these patterns (case-insensitive):

| Category | Patterns |
|----------|----------|
| Rate limiting | `rate.?limit`, `too many requests`, `429`, `overloaded` |
| Server errors | `500`, `502`, `503`, `504`, `server.?error`, `internal.?error` |
| Network issues | `network.?error`, `connection.?error`, `fetch failed`, `socket hang up` |
| Timeouts | `timed? out`, `timeout`, `request ended without` |
| WebSocket transport | `websocket.?closed`, `other side closed` |

**Explicitly non-retryable:** Context overflow (`context.?overflow`, `too many tokens`) — handled by compaction instead.

## Implementation Details

**Location:** `index.ts`, line ~786, inside `spawnSubagent()`'s `processLine()` handler for `agent_end` events.

```typescript
const isRetryable = isErrorState && isRetryableError(handle.error);
if (isRetryable) {
  updateHandle(handle, {
    state: 'running',
    statusText: `Retrying… ${truncate(handle.error, 72)}`,
  });
  // Intentionally NOT calling settleHandle()
}
```

**Key invariant:** Only `settleHandle()` for terminal states (`done`, `error` after max retries exhausted, settled `killed`). Keep-alive `idle` and in-progress `running` (including during retry) never settle.

## Trade-offs Considered

| Option | Rejected Because |
|--------|------------------|
| Track retry count in extension | Pi already manages this; duplication adds drift risk |
| Settle on first error, restart process | Loses conversation history, wastes startup cost |
| Never settle until explicit kill | Blocks cleanup of truly-failed subagents |
