# Technical Context

## Retry Handling (v1.2.0)

### Problem

Previously, when Pi's LLM encountered any error (including transient ones like rate limits or network failures), the subagent would immediately transition to `error` state and call `settleHandle()`. This prevented Pi's built-in auto-retry mechanism from recovering gracefully.

### Solution

The `isRetryableError()` function now intercepts errors during the `agent_end` event. For retryable errors:

1. **State remains `running`** instead of transitioning to `error`
2. **`settleHandle()` is NOT called** — the handle stays active for retries
3. **Status text shows "Retrying…"** to indicate recovery in progress

Pi handles the actual retry logic with exponential backoff. When the retry succeeds, normal flow continues. When max retries are exceeded or a non-retryable error occurs, the subagent transitions to `error`.

### Retryable Error Patterns

```typescript
/overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i
```

### Non-Retryable Errors

- Context overflow / context exceeded (handled by compaction)
- Authentication errors
- Invalid model/provider configuration
- User-requested abort

### Implementation Details

**Location**: `index.ts`, `spawnSubagent()` function, `agent_end` message handler

```typescript
const isRetryable = isErrorState && isRetryableError(handle.error);
if (isErrorState && !isRetryable) {
  // Finalize as error
} else if (isRetryable) {
  // Stay running, don't settle
  updateHandle(handle, {
    state: 'running',
    statusText: `Retrying… ${truncate(handle.error, 72)}`,
  });
}
```

This mirrors Pi's `_isRetryableError()` in `@earendil-works/pi-coding-agent/dist/core/agent-session.js`.
