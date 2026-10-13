# pi-headless-subagent

一个 Pi 扩展，用于在独立的 `pi --mode rpc` 子进程中生成隔离的子代理。

## 安装

```bash
pi install npm:pi-headless-subagent
```

---

## 功能

- 在会话隔离的子进程中运行委托任务，子进程加载与父进程相同的扩展/插件
- 注入子进程专用的 `update_status(message)` 工具用于进度报告
- 继承父会话的激活工具集，并可针对每个代理选择性缩小范围
- 支持一次性子代理运行、并行集群、串行链以及后台 启动/等待/提示/终止 流程
- 默认启用保活模式：子代理每轮结束后保持存活，无需重新生成即可快速跟进提示

## 工具

### `subagent_start`

启动一个后台子代理并立即返回其 ID。

```json
{
  "task": "查找所有 fetch API 的使用",
  "agent": "scout",         // 可选：预定义代理名称
  "cwd": "/path/to/project" // 可选：工作目录
}
```

**临时变体**（无预定义代理）：

```json
{
  "task": "审查 API 接口",
  "systemPrompt": "你是一个 API 审查专家。",
  "tools": ["read", "grep"]
}
```

> 仅在用户明确要求后台子代理时使用。嵌套委派已被禁止（子代理无法生成自己的子代理）。

---

### `subagent_list`

列出已跟踪的子代理及其当前状态。

```json
// 列出所有（包括已完成的）
{}

// 排除已完成/出错/已终止的
{"includeCompleted": false}
```

---

### `subagent_wait`

等待后台子代理完成当前轮次。**阻塞直到完成**，除非指定超时。

```json
// 等待特定子代理
{"id": "abc"}

// 等待所有活跃子代理
{"all": true}

// 带超时（超时后返回当前状态，不会终止）
{"id": "abc", "timeoutMs": 30000}
```

当子代理达到 `idle`、`done`、`error` 或 `killed` 状态时返回句柄。如果 `timeoutMs` 在完成前到期，则返回当前部分状态而不终止子代理。

---

### `subagent_prompt`

向**空闲**状态的子代理发送后续提示。通过 RPC 发送提示，无需重新生成进程。

```json
{"id": "abc", "message": "现在也检查一下 TypeScript 文件..."}
```

要求：
- 子代理必须处于 `idle` 状态（如有需要先调用 `subagent_wait`）
- 进程必须仍在运行（`subagent_kill` 会终止它）

---

### `subagent_kill`

终止一个活跃的子代理进程（包括**空闲**保活状态的）。

```json
{"id": "abc"}
```

适用于任何非终止状态：`starting`、`running`、`idle` 或未确定的 `killed`。如果已处于终止状态（`done`、`error`、已确定的 `killed`）则拒绝。

---

## 自定义代理

代理文件是带有 YAML 前置元数据的 Markdown 文件，放置于：

- 用户覆盖：`~/.pi/agent/subagents/`
- 项目覆盖：最近的 `.pi/subagents/` 目录

当两者定义同名代理时，项目覆盖优先于用户覆盖。

### 前置元数据模式

```yaml
---
name: <agent-name>
description: <short description>
tools: [read, grep, find, ls]  # 可选：逗号分隔或数组
model: <provider/model-id>       # 可选：单一模型（例如 openai/gpt-4o）
models: [<pattern>, ...]         # 可选：多个模型（例如 claude-*,gpt-4o）
---

<system prompt>
```

### 示例

```md
---
name: cheap-scout
description: 快速侦察代理，用于广泛的代码搜索
tools: read,grep,find,ls
model: deepseek/deep-3
---

你是一个专注于速度的快速侦察专家...
```

## 子代理状态机

| 状态 | 含义 | 可接收 `subagent_prompt`? | 可被终止? |
|---|---|---|---|
| `starting` | 进程已启动，等待首次响应 | 否 | 是 |
| `running` | 正在处理提示 | 否 | 是 |
| `idle` | 完成一轮，进程仍存活以便后续 | **是** | 是 |
| `done` | 成功完成，进程已退出 | 否 | 否（终止态） |
| `error` | 失败或出错，进程已退出 | 否 | 否（终止态） |
| `killed` | 通过 `subagent_kill` 终止 | 否 | 否（已确定） |

要点：
- **保活模式**：默认情况下，子代理每轮结束后进入 `idle` 状态而非退出，通过 `subagent_prompt` 实现快速多轮交互。
- **终止状态**：`done`、`error` 和已确定的 `killed` 表示进程已退出，无法再次使用。

## 连续提示模式

子代理默认在提示之间保持存活。使用以下模式进行多轮交互：

```
1. subagent_start({ task: "初始分析..." })
2. subagent_wait({ id: "abc" })
3. subagent_prompt({ id: "abc", message: "现在也检查..." })
4. subagent_wait({ id: "abc" })
5. subagent_prompt(...)
...
N. subagent_kill({ id: "abc" })
```

### 最佳实践

- 发送后续提示前务必等待 `idle` 状态
- 操作前使用 `subagent_list` 检查状态
- 完成后调用 `subagent_kill` — 进程会持续运行直到被终止或父会话结束
- 空闲子代理保留：工作目录、工具上下文、累积的对话历史

### 何时不使用连续提示

- 对于独立任务，通过 `subagent_start` 生成单独的子代理
- 如果不同轮次需要不同工具或系统提示，请启动新的子代理
- 如果子代理已退出（`done`/`error`/已确定的 `killed`），必须重新生成

## 注意事项

- **嵌套委派已被禁止** — 子代理无法调用 `subagent_start`；它们需将需求报告回父代理
- **结果持久化** — 大型结果保存到临时文件；工具响应包含路径，可使用 `read` 恢复完整输出
- **中止行为** — 中止父代理也会中止所有活跃子代理；中止 `subagent_wait` 停止等待但子代理保持存活
- **模型继承** — 子代理默认继承父会话模型；可通过代理前置元数据中的 `model`/`models` 覆盖
- **扩展加载** — 子进程与父进程加载相同的扩展/插件（不同于 `--no-session`）
- **重试行为 (v1.2+)** — 瞬态错误（速率限制、5xx、网络问题）会触发 Pi 的自动重试而非立即失败。详见 [CONTEXT.md](CONTEXT.md)。
- **重试行为 (v1.2.0+)** — 瞬态错误（速率限制、5xx 响应、网络问题、超时）会触发 Pi 的自动重试而非立即失败。子代理保持在 `running` 状态直到重试完成或耗尽。上下文溢出错误不会重试（由压缩处理）。
