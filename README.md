# pi-headless-subagent

A pi extension for spawning isolated subagents in separate `pi --mode rpc` subprocesses.

一个 Pi 扩展，用于在独立的 `pi --mode rpc` 子进程中生成隔离的子代理。

---

## What it does / 功能

**EN:**
- Runs delegated work in session-isolated subprocesses that load the same extensions/plugins as the parent
- Injects a child-only `update_status(message)` tool for progress reporting
- Inherits the parent session's active tool set, then optionally narrows it per agent
- Supports one-off subagent runs, parallel swarms, sequential chains, and background start/wait/prompt/kill flows
- Keep-alive mode by default: subagents stay alive after each turn for fast follow-up prompts without re-spawning

**中文：**
- 在会话隔离的子进程中运行委托任务，子进程加载与父进程相同的扩展/插件
- 注入子进程专用的 `update_status(message)` 工具用于进度报告
- 继承父会话的激活工具集，并可针对每个代理选择性缩小范围
- 支持一次性子代理运行、并行集群、串行链以及后台 启动/等待/提示/终止 流程
- 默认启用保活模式：子代理每轮结束后保持存活，无需重新生成即可快速跟进提示

---

## Tools / 工具

### `subagent_start`

Start a background subagent and return immediately with its id.
启动一个后台子代理并立即返回其 ID。

```json
{
  "task": "Find all uses of the fetch API",
  "agent": "scout",        // optional: predefined agent name
  "cwd": "/path/to/project" // optional: working directory
}
```

**Ad hoc variant / 临时变体** (无预定义代理):

```json
{
  "task": "Review the API surface",
  "systemPrompt": "You are an API review specialist.",
  "tools": ["read", "grep"]
}
```

> Only use when the user explicitly asks for a background subagent. Nested delegation is blocked (subagents cannot spawn their own).
> 仅在用户明确要求后台子代理时使用。嵌套委派已被禁止（子代理无法生成自己的子代理）。

---

### `subagent_list`

List tracked subagents and their current status.
列出已跟踪的子代理及其当前状态。

```json
// List all (including completed) / 列出所有（包括已完成的）
{}

// Exclude completed/errored/killed / 排除已完成/出错/已终止的
{"includeCompleted": false}
```

---

### `subagent_wait`

Wait for a background subagent to finish its current turn. **Blocks until completion** unless a timeout is specified.
等待后台子代理完成当前轮次。**阻塞直到完成**，除非指定超时。

```json
// Wait for specific subagent / 等待特定子代理
{"id": "abc"}

// Wait for all active subagents / 等待所有活跃子代理
{"all": true}

// With timeout (returns current state if exceeded, doesn't kill)
// 带超时（超时后返回当前状态，不会终止）
{"id": "abc", "timeoutMs": 30000}
```

Returns the handle once the subagent reaches `idle`, `done`, `error`, or `killed` state. If `timeoutMs` expires before completion, returns the current partial state without terminating the subagent.

当子代理达到 `idle`、`done`、`error` 或 `killed` 状态时返回句柄。如果 `timeoutMs` 在完成前到期，则返回当前部分状态而不终止子代理。

---

### `subagent_prompt`

Send a follow-up prompt to an **idle** subagent. Uses RPC to send the prompt without re-spawning.
向 **空闲** 状态的子代理发送后续提示。通过 RPC 发送提示，无需重新生成进程。

```json
{"id": "abc", "message": "Now also check TypeScript files..."}
```

Requirements / 要求:
- Subagent must be in `idle` state (call `subagent_wait` first if needed)
  子代理必须处于 `idle` 状态（如有需要先调用 `subagent_wait`）
- Process must still be alive (`subagent_kill` terminates it)
  进程必须仍在运行（`subagent_kill` 会终止它）

---

### `subagent_kill`

Terminate a live subagent process (including **idle** keep-alive ones).
终止一个活跃的子代理进程（包括 **空闲** 保活状态的）。

```json
{"id": "abc"}
```

Works on any non-terminal state: `starting`, `running`, `idle`, or unsettled `killed`. Rejects if already terminal (`done`, `error`, settled `killed`).

适用于任何非终止状态：`starting`、`running`、`idle` 或未确定的 `killed`。如果已处于终止状态（`done`、`error`、已确定的 `killed`）则拒绝。

---

## Custom agents / 自定义代理

**EN:**
Agent files are Markdown with YAML frontmatter placed in:

- User overrides: `~/.pi/agent/subagents/`
- Project overrides: nearest `.pi/subagents/`

Project overrides take precedence over user overrides when both define agents with the same name.

**中文：**
代理文件是带有 YAML 前置元数据的 Markdown 文件，放置于：

- 用户覆盖：`~/.pi/agent/subagents/`
- 项目覆盖：最近的 `.pi/subagents/` 目录

当两者定义同名代理时，项目覆盖优先于用户覆盖。

### Frontmatter schema / 前置元数据模式

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

### Example / 示例

```md
---
name: cheap-scout
description: Fast reconnaissance agent for broad code search
tools: read,grep,find,ls
model: deepseek/deep-3
---

You are a fast reconnaissance specialist focused on speed...
你是一个专注于速度的快速侦察专家...
```

---

## Subagent state machine / 子代理状态机

| State / 状态 | Meaning / 含义 | Can receive `subagent_prompt`? / 可接收提示? | Can be killed? / 可被终止? |
|---|---|---|---|
| `starting` | Process launched, awaiting first response / 进程已启动，等待首次响应 | No | Yes |
| `running` | Actively processing a prompt / 正在处理提示 | No | Yes |
| `idle` | Finished a turn, process still alive for follow-ups / 完成一轮，进程仍存活 | **Yes** | Yes |
| `done` | Completed successfully, process exited / 成功完成，进程已退出 | No | No (terminal) |
| `error` | Failed or errored, process exited / 失败或出错，进程已退出 | No | No (terminal) |
| `killed` | Terminated via `subagent_kill` / 通过 `subagent_kill` 终止 | No | No (if settled) |

**EN key points:**
- **Keep-alive mode**: By default, subagents transition to `idle` after each turn instead of exiting. This enables fast multi-turn interactions via `subagent_prompt`.
- **Terminal states**: `done`, `error`, and settled `killed` means the process has exited and cannot be used again.

**中文要点：**
- **保活模式**：默认情况下，子代理每轮结束后进入 `idle` 状态而非退出，通过 `subagent_prompt` 实现快速多轮交互。
- **终止状态**：`done`、`error` 和已确定的 `killed` 表示进程已退出，无法再次使用。

---

## Continuous prompting pattern / 连续提示模式

Subagents stay alive between prompts by default. Use this pattern for multi-turn interactions:
子代理默认在提示之间保持存活。使用以下模式进行多轮交互：

```
1. subagent_start({ task: "Initial analysis..." })
2. subagent_wait({ id: "abc" })          // blocks until idle / 阻塞直到空闲
3. subagent_prompt({ id: "abc", message: "Now also check..." })
4. subagent_wait({ id: "abc" })          // blocks for result / 等待结果
5. subagent_prompt(...)                  // repeat as needed / 根据需要重复
...
N. subagent_kill({ id: "abc" })          // terminate when done / 完成后终止
```

### Best practices / 最佳实践

- Always wait for `idle` before sending a follow-up prompt
  发送后续提示前务必等待 `idle` 状态
- Use `subagent_list` to inspect states before acting
  操作前使用 `subagent_list` 检查状态
- Call `subagent_kill` when finished — processes persist until killed or parent session ends
  完成后调用 `subagent_kill` — 进程会持续运行直到被终止或父会话结束
- Idle subagents retain: working directory, tool context, accumulated conversation history
  空闲子代理保留：工作目录、工具上下文、累积的对话历史

### When NOT to use continuous prompting / 何时不使用连续提示

- For independent tasks, spawn separate subagents via `subagent_start`
  对于独立任务，通过 `subagent_start` 生成单独的子代理
- If you need different tools or system prompts between turns, start a new subagent
  如果不同轮次需要不同工具或系统提示，请启动新的子代理
- If the subagent has exited (`done`/`error`/settled `killed`), you must spawn again
  如果子代理已退出（`done`/`error`/已确定的 `killed`），必须重新生成

---

## Notes / 注意事项

| EN | 中文 |
|---|---|
| **Nested delegation is blocked** — subagents cannot call `subagent_start`; they report needs back to the parent | **嵌套委派已被禁止** — 子代理无法调用 `subagent_start`；它们需将需求报告回父代理 |
| **Result persistence** — large results are saved to temp files; the tool response includes the path so you can recover full output with `read` | **结果持久化** — 大型结果保存到临时文件；工具响应包含路径，可使用 `read` 恢复完整输出 |
| **Abort behavior** — aborting the parent agent also aborts all active subagents; aborting `subagent_wait` stops waiting but leaves the subagent alive | **中止行为** — 中止父代理也会中止所有活跃子代理；中止 `subagent_wait` 停止等待但子代理保持存活 |
| **Model inheritance** — subagents inherit the parent session model by default; override with `model`/`models` in agent frontmatter | **模型继承** — 子代理默认继承父会话模型；可通过代理前置元数据中的 `model`/`models` 覆盖 |
| **Extension loading** — child processes load the same extensions/plugins as the parent (unlike `--no-session`) | **扩展加载** — 子进程与父进程加载相同的扩展/插件（不同于 `--no-session`） |
