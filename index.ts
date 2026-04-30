import { createHash, randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@mariozechner/pi-coding-agent';
import { Type } from '@sinclair/typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';
import {
  clearAgentDiscoveryCache,
  discoverAgents,
  formatAgentList,
  type AgentConfig,
} from './agents.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const childExtensionPath = join(__dirname, 'child.ts');

const MAX_PARALLEL_TASKS = 64;
const MAX_CONCURRENCY = 4;

const MAX_RETAINED_HANDLES = 24;
const INLINE_RESULT_MAX = 4_000;
const RESULT_PREVIEW_MAX = 1_200;
const SERIALIZED_RESULT_PREVIEW_MAX = 200;
const RESULT_FILE_DIR = 'pi-subagent-results';

type SubagentState =
  | 'starting'
  | 'running'
  | 'idle'
  | 'done'
  | 'error'
  | 'killed';

interface RpcResponse {
  id?: string;
  type: 'response';
  command: string;
  success: boolean;
  error?: string;
}

interface PromptResponse {
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

interface SubagentHandle {
  id: string;
  agent: AgentConfig;
  task: string;
  cwd: string;
  state: SubagentState;
  statusText: string;
  lastTool: string | undefined;
  lastPrompt: string | undefined;
  resultText: string;
  resultPath: string | undefined;
  persistedResultHash: string | undefined;
  stderr: string;
  error: string | undefined;
  stopReason: string | undefined;
  exitCode: number | undefined;
  startedAt: number;
  updatedAt: number;
  process: ChildProcessWithoutNullStreams | undefined;
  completionSettled: boolean | undefined;
  completionPromise: Promise<SubagentHandle> | undefined;
  waiters: Array<{
    resolve: (handle: SubagentHandle) => void;
    timer: NodeJS.Timeout | undefined;
  }>;
  promptResolvers: Map<string, PromptResponse>;
}

interface SerializableHandle {
  id: string;
  agent: string;
  source: string;
  state: SubagentState;
  task: string;
  statusText: string;
  lastTool: string | undefined;
  lastPrompt: string | undefined;
  resultText: string;
  resultPath: string | undefined;
  error: string | undefined;
  stopReason: string | undefined;
  exitCode: number | undefined;
  startedAt: number;
  updatedAt: number;
}

interface TaskSpec {
  agent?: string;
  name?: string;
  task: string;
  cwd?: string;
  tools?: string[];
  systemPrompt?: string;
}

type AgentDiscovery = Awaited<ReturnType<typeof discoverAgents>>;

const now = (): number => Date.now();

const createId = (): string => randomBytes(3).toString('hex');
let extensionContext: ExtensionContext | undefined;

const getExtensionContext = (): ExtensionContext => {
  if (!extensionContext) throw new Error('Extension context not available');
  return extensionContext;
};

const truncate = (text: string | undefined, max = 80): string => {
  const value = (text || '').replace(/\s+/g, ' ').trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
};

const safeFileFragment = (value: string | undefined): string => {
  const normalized = (value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'subagent';
};

const hashText = (text: string): string =>
  createHash('sha1').update(text).digest('hex');

const ensureResultPersisted = async (
  handle: SubagentHandle,
): Promise<string | undefined> => {
  if (!handle.resultText) return undefined;
  const nextHash = hashText(handle.resultText);
  if (handle.resultPath && handle.persistedResultHash === nextHash)
    return handle.resultPath;

  const directory = join(tmpdir(), RESULT_FILE_DIR);
  const filename = `${safeFileFragment(handle.agent.name)}-${handle.id}.md`;
  const path = join(directory, filename);

  try {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700).catch(() => {});
    await fs.writeFile(path, handle.resultText, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.chmod(path, 0o600).catch(() => {});
    handle.resultPath = path;
    handle.persistedResultHash = nextHash;
    return path;
  } catch (error) {
    handle.resultPath = undefined;
    handle.persistedResultHash = undefined;
    handle.stderr += `Failed to persist subagent result: ${error instanceof Error ? error.message : String(error)}\n`;
    return undefined;
  }
};

const previewResult = (text: string, max = RESULT_PREVIEW_MAX): string =>
  text.length <= max ? text : `${text.slice(0, max).trimEnd()}\n…`;

const isHandleActive = (handle: SubagentHandle): boolean =>
  handle.state === 'starting' ||
  handle.state === 'running' ||
  (handle.state === 'killed' && !handle.completionSettled);

const isHandleAlive = (handle: SubagentHandle): boolean =>
  handle.state === 'idle' || isHandleActive(handle);

const extractText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map(
      (part) =>
        (part &&
          typeof part === 'object' &&
          part.type === 'text' &&
          typeof part.text === 'string' &&
          part.text) ??
        '',
    )
    .filter(Boolean)
    .join('\n');
};

const getPiInvocation = (
  args: string[],
): { command: string; args: string[] } => {
  const currentScript = process.argv[1];
  const looksLikeScriptPath =
    typeof currentScript === 'string' &&
    !currentScript.startsWith('-') &&
    (currentScript.includes('/') ||
      currentScript.endsWith('.js') ||
      currentScript.endsWith('.mjs'));
  if (looksLikeScriptPath)
    return { command: process.execPath, args: [currentScript, ...args] };
  const execName = basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };
  return { command: process.env.PI_SUBAGENT_PI_BIN || 'pi', args };
};

const getSubagentDepth = (): number =>
  Math.max(0, Number.parseInt(process.env.PI_SUBAGENT_DEPTH || '0', 10) || 0);

const isNestedSubagent = (): boolean => getSubagentDepth() > 0;

const serializeHandle = (handle: SubagentHandle): SerializableHandle => ({
  id: handle.id,
  agent: handle.agent.name,
  source: handle.agent.source,
  state: handle.state,
  task: handle.task,
  statusText: handle.statusText,
  lastTool: handle.lastTool,
  lastPrompt: handle.lastPrompt,
  resultText: previewResult(handle.resultText, SERIALIZED_RESULT_PREVIEW_MAX),
  resultPath: handle.resultPath,
  error: handle.error,
  stopReason: handle.stopReason,
  exitCode: handle.exitCode,
  startedAt: handle.startedAt,
  updatedAt: handle.updatedAt,
});

const serializeHandleForReturn = async (
  handle: SubagentHandle,
): Promise<SerializableHandle> => {
  if (handle.resultText) await ensureResultPersisted(handle);
  return serializeHandle(handle);
};

const serializeHandlesForReturn = async (
  values: SubagentHandle[],
): Promise<SerializableHandle[]> =>
  Promise.all(values.map(serializeHandleForReturn));

const TaskSpecSchema = Type.Object({
  agent: Type.Optional(
    Type.String({
      description: 'Optional predefined subagent name to use as a base',
    }),
  ),
  name: Type.Optional(
    Type.String({
      description: 'Optional display name for an ad hoc subagent',
    }),
  ),
  task: Type.String({ description: 'Focused task to delegate' }),
  cwd: Type.Optional(
    Type.String({ description: 'Working directory for the subagent process' }),
  ),
  tools: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Optional built-in tool override for the child, e.g. [read,grep,find,ls]',
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({
      description:
        'Optional ad hoc subagent prompt or extra instructions. If agent is provided, this is appended to the predefined prompt.',
    }),
  ),
});

const SingleSchema = TaskSpecSchema;

const WaitSchema = Type.Object({
  id: Type.Optional(
    Type.String({ description: 'Specific subagent id to wait for' }),
  ),
  all: Type.Optional(
    Type.Boolean({
      default: true,
      description:
        'When id is omitted, this must be true to wait for all active subagents',
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Number({
      minimum: 1,
      description: 'Optional timeout in milliseconds',
    }),
  ),
});

const ListSchema = Type.Object({
  includeCompleted: Type.Optional(
    Type.Boolean({
      default: true,
      description: 'Include completed, errored, and killed subagents',
    }),
  ),
});

const KillSchema = Type.Object({
  id: Type.String({ description: 'Subagent id to kill' }),
});

const SubagentPromptSchema = Type.Object({
  id: Type.String({
    description: 'Subagent id to send the follow-up prompt to',
  }),
  message: Type.String({
    description: 'Follow-up prompt message for the subagent',
  }),
  images: Type.Optional(
    Type.Array(
      Type.Object({
        type: Type.Literal('image'),
        data: Type.String({ description: 'Base64-encoded image data' }),
        mimeType: Type.String({
          description: 'Image MIME type, e.g. image/png',
        }),
      }),
      { description: 'Optional images attached to the prompt' },
    ),
  ),
});

export default function subagentExtension(pi: ExtensionAPI) {
  const handles = new Map<string, SubagentHandle>();

  const getRequestedChildTools = (agent: AgentConfig): string[] => {
    const parentActiveTools = new Set(pi.getActiveTools());
    return (
      agent.tools?.length ? agent.tools : Array.from(parentActiveTools)
    ).filter((toolName) => parentActiveTools.has(toolName));
  };

  const nestedDelegationBlocked = (toolName: string) => ({
    content: [
      {
        type: 'text' as const,
        text: `${toolName} is disabled inside delegated subagents. Report any need for further delegation back to the parent agent instead.`,
      },
    ],
    details: { nestedDelegationBlocked: true },
  });

  const sortHandles = (values: SubagentHandle[]): SubagentHandle[] =>
    [...values].sort(
      (a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id),
    );

  const trimRetainedHandles = (): void => {
    for (const handle of [...handles.values()]
      .sort(
        (a, b) =>
          b.updatedAt - a.updatedAt ||
          b.startedAt - a.startedAt ||
          a.id.localeCompare(b.id),
      )
      .slice(MAX_RETAINED_HANDLES))
      if (!isHandleActive(handle)) handles.delete(handle.id);
  };

  const updateHandle = (
    handle: SubagentHandle,
    patch: Partial<SubagentHandle>,
  ): void => {
    Object.assign(handle, patch);
    handle.updatedAt = now();
    if (handles.size > MAX_RETAINED_HANDLES) trimRetainedHandles();
  };

  const settleHandle = (handle: SubagentHandle): void => {
    if (handle.completionSettled) return;
    handle.completionSettled = true;
    handle.updatedAt = now();
    for (const [, resolver] of handle.promptResolvers) {
      if (resolver.timer) clearTimeout(resolver.timer);
      resolver.reject(
        new Error('Subagent process settled before prompt response'),
      );
    }
    handle.promptResolvers.clear();
    const waiters = handle.waiters.splice(0);
    handle.completionPromise = (async () => {
      try {
        if (handle.resultText) await ensureResultPersisted(handle);
      } finally {
        waiters.forEach((w) => {
          if (w.timer) clearTimeout(w.timer);
          w.resolve(handle);
        });
        trimRetainedHandles();
      }
      return handle;
    })();
  };

  const waitForHandle = (
    handle: SubagentHandle,
    timeoutMs?: number,
  ): Promise<SubagentHandle> => {
    // Return immediately for terminal or settled states.
    // 'idle' is included because keep-alive mode resolves waiters without settling —
    // the handle is usable as-is even though completionPromise may be absent.
    if (
      handle.state === 'idle' ||
      handle.state === 'done' ||
      handle.state === 'error' ||
      (handle.state === 'killed' && handle.completionSettled)
    )
      return handle.completionPromise || Promise.resolve(handle);

    return new Promise((resolve) => {
      const waiter = {
        resolve,
        timer: undefined as NodeJS.Timeout | undefined,
      };
      if (timeoutMs && timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          handle.waiters = handle.waiters.filter((value) => value !== waiter);
          resolve(handle);
        }, timeoutMs);
      }
      handle.waiters.push(waiter);
    });
  };

  const waitForHandleOrAbort = (
    handle: SubagentHandle,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<SubagentHandle> => {
    if (!signal) return waitForHandle(handle, timeoutMs);
    // On abort, return whatever state is available — caller chose to stop waiting.
    // A killed-but-unsettled handle may lack completionPromise; that's expected on abort.
    if (signal.aborted) return handle.completionPromise || Promise.resolve(handle);
    // Return immediately for terminal or settled states (same rationale as waitForHandle).
    if (
      handle.state === 'idle' ||
      handle.state === 'done' ||
      handle.state === 'error' ||
      (handle.state === 'killed' && handle.completionSettled)
    )
      return handle.completionPromise || Promise.resolve(handle);

    return new Promise((resolve) => {
      const onAbort = () => {
        cleanup();
        resolve(handle);
      };
      const cleanup = () => {
        if (waiter.timer) clearTimeout(waiter.timer);
        handle.waiters = handle.waiters.filter((v) => v !== waiter);
        signal.removeEventListener('abort', onAbort);
      };
      const waiter = {
        resolve: (resolvedHandle: SubagentHandle) => {
          cleanup();
          resolve(resolvedHandle);
        },
        timer: undefined as NodeJS.Timeout | undefined,
      };
      if (timeoutMs && timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          cleanup();
          resolve(handle);
        }, timeoutMs);
      }
      signal.addEventListener('abort', onAbort, { once: true });
      handle.waiters.push(waiter);
    });
  };

  const RPC_TIMEOUT_MS = 15_000;

  const sendRpc = (
    proc: ChildProcessWithoutNullStreams,
    handle: SubagentHandle,
    payload: Record<string, unknown>,
    timeoutMs = RPC_TIMEOUT_MS,
  ): Promise<RpcResponse> => {
    const rpcId =
      typeof payload.id === 'string' && payload.id
        ? payload.id
        : `${handle.id}:rpc:${createId()}`;
    const finalPayload = { ...payload, id: rpcId };

    try {
      proc.stdin.write(`${JSON.stringify(finalPayload)}\n`);
    } catch {
      return Promise.reject(
        new Error('Broken pipe — subagent process is gone'),
      );
    }

    return new Promise((resolve, reject) => {
      const resolver: PromptResponse = { resolve, reject, timer: undefined };
      resolver.timer = setTimeout(() => {
        handle.promptResolvers.delete(rpcId);
        reject(
          new Error(`Subagent response timeout after ${timeoutMs}ms`),
        );
      }, timeoutMs);
      handle.promptResolvers.set(rpcId, resolver);
    });
  };

  const killHandle = (
    handle: SubagentHandle,
    reason = 'Killed by parent',
  ): Promise<SubagentHandle> => {
    if (
      handle.completionSettled ||
      handle.state === 'done' ||
      handle.state === 'error'
    )
      return Promise.resolve(handle);

    if (handle.state !== 'killed') {
      updateHandle(handle, {
        state: 'killed',
        error: reason,
        statusText: reason,
      });
      if (handle.process) {
        sendRpc(handle.process!, handle, { type: 'abort' }).catch(() => {});
        setTimeout(() => handle.process?.kill('SIGTERM'), 1500);
        setTimeout(() => handle.process?.kill('SIGKILL'), 4000);
      }
    }
    return waitForHandle(handle, 5000);
  };

  const killAll = async (reason: string): Promise<void> => {
    await Promise.allSettled(
      [...handles.values()]
        .filter(isHandleActive)
        .map((handle) => killHandle(handle, reason)),
    );
  };

  const formatSingleResult = async (
    handle: SubagentHandle,
  ): Promise<string> => {
    const resultPath = handle.resultText
      ? await ensureResultPersisted(handle)
      : undefined;
    const lines: string[] = [];

    if (resultPath) {
      lines.push(
        handle.state === 'done'
          ? `Full subagent result saved to ${resultPath}. Use read to inspect the exact complete output.`
          : `Partial subagent result saved to ${resultPath}. Use read to inspect the exact output captured before completion.`,
      );
    }

    if (!handle.resultText) {
      lines.push(handle.error || handle.statusText || '(no output)');
      return lines.join('\n\n');
    }

    if (handle.resultText.length <= INLINE_RESULT_MAX) {
      lines.push(handle.resultText);
      return lines.join('\n\n');
    }

    const previewLabel =
      handle.state === 'done' ? 'Result preview' : 'Captured output preview';
    lines.push(`${previewLabel}:\n${previewResult(handle.resultText)}`);
    lines.push(
      resultPath
        ? `Preview truncated for transport safety. Use read on ${resultPath} for the ${handle.state === 'done' ? 'full result' : 'full captured output'}.`
        : 'Preview truncated for transport safety.',
    );
    return lines.join('\n\n');
  };

  const formatHandleSummary = async (
    handle: SubagentHandle,
  ): Promise<string> => {
    const base = `#${handle.id} ${handle.agent.name} ${handle.state} - ${truncate(handle.task, 70)}`;
    const detail =
      handle.statusText ||
      truncate(handle.resultText, 90) ||
      truncate(handle.error, 90);
    const promptNote = handle.lastPrompt
      ? `  last prompt: ${truncate(handle.lastPrompt, 70)}`
      : '';
    const resultPath = handle.resultText
      ? await ensureResultPersisted(handle)
      : undefined;
    return [
      base,
      detail ? `  ${detail}` : '',
      promptNote,
      resultPath ? `  result ${resultPath}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  };

  const getActiveOrRecentSummary = async (
    includeCompleted = true,
  ): Promise<string> => {
    const list = sortHandles([...handles.values()]).filter(
      (handle) => includeCompleted || isHandleActive(handle),
    );
    return list.length === 0
      ? 'No subagents running.'
      : (await Promise.all(list.map(formatHandleSummary))).join('\n\n');
  };

  const spawnSubagent = (
    agent: AgentConfig,
    task: string,
    cwd: string,
  ): SubagentHandle => {
    const id = createId();
    const handle: SubagentHandle = {
      id,
      agent,
      task,
      cwd,
      state: 'starting',
      statusText: 'Launching…',
      resultText: '',
      stderr: '',
      startedAt: now(),
      updatedAt: now(),
      lastTool: undefined,
      lastPrompt: undefined,
      resultPath: undefined,
      persistedResultHash: undefined,
      error: undefined,
      stopReason: undefined,
      exitCode: undefined,
      process: undefined,
      completionSettled: undefined,
      completionPromise: undefined,
      waiters: [],
      promptResolvers: new Map(),
    };
    handles.set(handle.id, handle);

    const childActiveTools = getRequestedChildTools(agent);
    const args = [
      '--mode',
      'rpc',
      '--extension',
      childExtensionPath,
      ...(agent.model ? ['--model', agent.model] : []),
      ...(agent.models ? ['--models', agent.models] : []),
    ];
    const invocation = getPiInvocation(args);
    const proc = spawn(invocation.command, invocation.args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PI_SUBAGENT_AGENT_NAME: agent.name,
        PI_SUBAGENT_SYSTEM_PROMPT: agent.systemPrompt,
        PI_SUBAGENT_ACTIVE_TOOLS: childActiveTools.join(','),
        PI_SUBAGENT_DEPTH: String(getSubagentDepth() + 1),
        PI_SUBAGENT_KEEP_ALIVE: '1',
      },
      shell: false,
    });
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');

    handle.process = proc;
    if (typeof proc.pid === 'number')
      updateHandle(handle, { statusText: 'Starting subagent…' });

    let stdoutBuffer = '';
    const processLine = (line: string) => {
      if (!line.trim()) return;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }

      if (message.type === 'response') {
        const resolverId =
          typeof message.id === 'string' ? message.id : undefined;
        if (resolverId) {
          const resolver = handle.promptResolvers.get(resolverId);
          if (resolver) {
            handle.promptResolvers.delete(resolverId);
            if (resolver.timer) clearTimeout(resolver.timer);
            if (message.success) {
              resolver.resolve(message);
            } else {
              resolver.reject(
                new Error(String(message.error || 'Prompt failed')),
              );
            }
          }
        }
        if (message.command === 'prompt' && message.success === false) {
          updateHandle(handle, {
            state: 'error',
            error: String(message.error || 'Failed to start prompt'),
            statusText: String(message.error || 'Prompt failed'),
          });
        }
        return;
      }

      if (message.type === 'agent_start') {
        updateHandle(handle, { state: 'running', statusText: 'Working…', error: undefined, stopReason: undefined });
        return;
      }

      if (message.type === 'tool_execution_start') {
        const toolName = String(message.toolName || '');
        if (toolName === 'update_status') {
          const status =
            typeof message.args?.message === 'string'
              ? message.args.message
              : 'Working…';
          updateHandle(handle, {
            state: 'running',
            statusText: status,
            lastTool: undefined,
          });
        } else {
          updateHandle(handle, {
            state: 'running',
            lastTool: toolName,
            statusText: handle.statusText || `Using ${toolName}`,
          });
        }
        return;
      }

      if (
        message.type === 'message_end' &&
        message.message?.role === 'assistant'
      ) {
        const assistantText = extractText(message.message.content);
        const assistantStopReason = message.message.stopReason;
        const assistantError = message.message.errorMessage;
        const assistantFailed =
          assistantStopReason === 'error' || !!assistantError;
        // Don't finalize error state here — message_end is tentative.
        // agent_end decides the final state, avoiding premature 'error' if the process recovers.
        updateHandle(handle, {
          state: handle.state,
          resultText: assistantText || handle.resultText,
          stopReason: assistantStopReason || handle.stopReason,
          error: assistantError || handle.error,
          statusText:
            assistantFailed && handle.state !== 'killed'
              ? truncate(
                  assistantError || assistantText || 'Subagent failed',
                  96,
                )
              : handle.statusText,
        });
        return;
      }

      if (message.type === 'agent_end') {
        // Finalize error state — either set by prompt failure or tentatively flagged by message_end.
        if (handle.state === 'error' || handle.stopReason === 'error' || handle.error) {
          updateHandle(handle, {
            state: 'error',
            statusText:
              truncate(handle.error || handle.statusText, 96) || 'Finished',
          });
          settleHandle(handle);
        } else if (handle.state === 'killed') {
          updateHandle(handle, {
            state: 'killed',
            statusText: handle.error || handle.statusText || 'Killed',
          });
          settleHandle(handle);
        } else {
          // Subagent finished its turn but stays alive (keep-alive mode).
          // Transition to idle so subagent_prompt can send follow-ups.
          updateHandle(handle, {
            state: 'idle',
            statusText: truncate(handle.resultText, 96) || 'Idle',
          });
          // Resolve completion waiters (subagent_wait callers) but don't settle —
          // the process stays alive for follow-up prompts.
          for (const waiter of handle.waiters.splice(0)) {
            if (waiter.timer) clearTimeout(waiter.timer);
            waiter.resolve(handle);
          }
        }
        return;
      }

      if (message.type === 'extension_error') {
        handle.stderr += `${message.extensionPath || 'extension'}: ${message.error || 'Unknown extension error'}\n`;
        updateHandle(handle, {
          statusText: truncate(String(message.error || 'Extension error'), 96),
        });
      }
    };

    proc.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      let idx: number;
      while ((idx = stdoutBuffer.indexOf('\n')) !== -1) {
        let line = stdoutBuffer.slice(0, idx);
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        processLine(line);
      }
    });

    proc.stderr.on('data', (chunk: string) => {
      handle.stderr += chunk;
    });

    proc.on('error', (error) => {
      updateHandle(handle, {
        state: 'error',
        error: error.message,
        statusText: error.message,
      });
      settleHandle(handle);
    });

    proc.on('close', (code, signal) => {
      if (stdoutBuffer.trim()) processLine(stdoutBuffer.trim());
      handle.process = undefined;
      handle.exitCode = code ?? (signal ? 1 : 0);
      if (!handle.completionSettled) {
        if (handle.state !== 'killed') {
          if (code === 0 && handle.state !== 'error') {
            updateHandle(handle, {
              state: 'done',
              statusText: truncate(handle.resultText, 96) || 'Done',
            });
          } else {
            const exitDetail = signal
              ? `Exited via signal ${signal}`
              : `Exited with code ${code ?? 0}`;
            const errorText = truncate(
              handle.error || handle.stderr || exitDetail,
              120,
            );
            updateHandle(handle, {
              state: 'error',
              error: errorText,
              statusText: errorText,
            });
          }
        }
        settleHandle(handle);
      }
    });

    // sendRpc is async but we don't block on it — response is tracked via promptResolvers.
    sendRpc(proc, handle, { type: 'prompt', message: task }).catch((err) => {
      handle.stderr += `Initial prompt RPC failed: ${err instanceof Error ? err.message : String(err)}\n`;
    });
    return handle;
  };

  const getAgents = (cwd?: string): Promise<AgentDiscovery> =>
    discoverAgents(cwd || getExtensionContext().cwd, __dirname);

  const materializeAgent = async (spec: {
    cwd?: string;
    agent?: string;
    systemPrompt?: string;
    name?: string;
    tools?: string[];
  }): Promise<{
    discovery: AgentDiscovery;
    agent?: AgentConfig;
    error?: string;
  }> => {
    const ctx = getExtensionContext();
    const discovery = await getAgents(spec.cwd || ctx.cwd);
    const base = spec.agent
      ? discovery.agents.find((c) => c.name === spec.agent)
      : undefined;
    if (spec.agent && !base)
      return { discovery, error: `Unknown subagent: ${spec.agent}` };

    const defaultPrompt = `You are an ad hoc delegated subagent working in an isolated context.
- Stay tightly scoped to the assigned task.
- Be concise and high-signal.
- Use tools as needed, but avoid unnecessary work.
- Return a definitive answer useful to the parent agent.
- Never call subagent_start from within a subagent; report any need for further delegation back to the parent agent.`;
    const mergedPrompt = [
      base?.systemPrompt || defaultPrompt,
      spec.systemPrompt || '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const agent: AgentConfig = {
      name: spec.name || base?.name || 'adhoc',
      description: base?.description || 'Ad hoc delegated subagent',
      tools: spec.tools?.length ? spec.tools : base?.tools,
      systemPrompt: mergedPrompt,
      source: base?.source || 'user',
      filePath: base?.filePath || '(ad hoc)',
    };
    return { discovery, agent };
  };

  const waitForAllOrAbort = (
    handlesToWait: SubagentHandle[],
    timeoutMs: number | undefined,
    signal?: AbortSignal,
  ): Promise<SubagentHandle[]> =>
    Promise.all(
      handlesToWait.map((handle) =>
        waitForHandleOrAbort(handle, timeoutMs, signal),
      ),
    );

  pi.on('session_start', (_event, ctx) => {
    extensionContext = ctx;
    clearAgentDiscoveryCache();
  });

  pi.on('session_shutdown', () => killAll('Parent session shutting down'));

  pi.on('before_agent_start', async (event, ctx) => {
    extensionContext = ctx;
    const discovery = await discoverAgents(ctx.cwd, __dirname);
    const guidance = isNestedSubagent()
      ? '\n\nSubagent extension is loaded in this delegated child to preserve the parent environment.\nYou are already inside a subagent. Never call subagent_start from within a subagent.\nIf further delegation seems useful, report that back to the parent agent instead.'
      : `\n\nSubagent extension is available.\nUse subagent_start to spawn background subagents, and subagent_list, subagent_wait, subagent_prompt, and subagent_kill to inspect, continue, or control them.\nA subagent call may either reference a predefined agent via {agent: "name", ...} or be ad hoc by omitting agent and providing task plus optional systemPrompt/tools.\nAvailable predefined subagents:\n${formatAgentList(discovery.agents, 20)}`;
    return { systemPrompt: event.systemPrompt + guidance };
  });

  pi.registerTool(
    defineTool({
      name: 'subagent_start',
      label: 'Subagent Start',
      description:
        'Start a background subagent and return immediately with its id. Only use this when the user explicitly asks you to spawn a background subagent.',
      promptSnippet:
        'Only when the user explicitly asks, start a background subagent and return its id.',
      promptGuidelines: [
        'Do not use subagent_start unless the user explicitly asks for a background subagent.',
        'Never call subagent_start from within a delegated subagent; nested delegation is disabled.',
      ],
      parameters: SingleSchema,
      async execute(_toolCallId, params: TaskSpec, _signal, _onUpdate, ctx) {
        extensionContext = ctx;
        if (isNestedSubagent())
          return nestedDelegationBlocked('subagent_start');
        const { discovery, agent, error } = await materializeAgent(params);
        if (!agent) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `${error || 'Invalid subagent spec'}\n\nAvailable subagents:\n${formatAgentList(discovery.agents)}`,
              },
            ],
            details: {},
          };
        }
        const handle = spawnSubagent(agent, params.task, params.cwd || ctx.cwd);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Started subagent #${handle.id} (${agent.name}).`,
            },
          ],
          details: { handle: await serializeHandleForReturn(handle) },
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: 'subagent_list',
      label: 'Subagent List',
      description: 'List tracked subagents and their current status.',
      parameters: ListSchema,
      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        const summary = await getActiveOrRecentSummary(
          params.includeCompleted ?? true,
        );
        return {
          content: [{ type: 'text' as const, text: summary }],
          details: {
            handles: await serializeHandlesForReturn(
              sortHandles([...handles.values()]),
            ),
          },
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: 'subagent_wait',
      label: 'Subagent Wait',
      description:
        'Wait for a background subagent, or all active subagents, to finish.',
      parameters: WaitSchema,
      async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
        let targets: SubagentHandle[] = [];
        if (params.id) {
          const handle = handles.get(params.id);
          if (!handle) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `Unknown subagent id: ${params.id}`,
                },
              ],
              details: {},
            };
          }
          targets = [handle];
        } else {
          if (params.all === false) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'Invalid subagent_wait call. Provide {id} to wait for one subagent, or omit id / set {all:true} to wait for all active subagents.',
                },
              ],
              details: {
                handles: await serializeHandlesForReturn(
                  sortHandles([...handles.values()]),
                ),
              },
            };
          }
          targets = [...handles.values()].filter(isHandleActive);
          if (targets.length === 0) {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: 'No active subagents to wait for.',
                },
              ],
              details: {
                handles: await serializeHandlesForReturn(
                  sortHandles([...handles.values()]),
                ),
              },
            };
          }
        }
        const results = await waitForAllOrAbort(
          targets,
          params.timeoutMs,
          signal,
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: (
                await Promise.all(
                  results.map((handle) => formatHandleSummary(handle)),
                )
              ).join('\n\n'),
            },
          ],
          details: { handles: await serializeHandlesForReturn(results) },
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: 'subagent_kill',
      label: 'Subagent Kill',
      description: 'Abort a running background subagent.',
      parameters: KillSchema,
      async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
        const handle = handles.get(params.id);
        if (!handle) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Unknown subagent id: ${params.id}`,
              },
            ],
            details: {},
          };
        }
        // Only reject if truly terminal — idle keep-alive subagents can still be killed.
        if (
          handle.state === 'done' ||
          handle.state === 'error' ||
          (handle.state === 'killed' && handle.completionSettled)
        ) {
          const stateText =
            handle.state === 'done'
              ? 'already completed'
              : handle.state === 'error'
                ? 'already failed'
                : 'already killed';
          return {
            content: [
              {
                type: 'text' as const,
                text: `Subagent #${handle.id} (${handle.agent.name}) is ${stateText}.`,
              },
            ],
            details: { handle: await serializeHandleForReturn(handle) },
          };
        }
        const result = await killHandle(handle, 'Killed via subagent_kill');
        return {
          content: [
            {
              type: 'text' as const,
              text: `Killed subagent #${result.id} (${result.agent.name}).\n\n${await formatSingleResult(result)}`,
            },
          ],
          details: { handle: await serializeHandleForReturn(result) },
        };
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: 'subagent_prompt',
      label: 'Subagent Prompt',
      description:
        'Send a follow-up prompt to an idle subagent. The subagent must have finished its current turn (state idle). If it is still streaming, call subagent_wait first. Returns once the subagent acknowledges receipt.',
      promptSnippet:
        'Send a follow-up prompt to an idle subagent to continue its work.',
      promptGuidelines: [
        'Use subagent_prompt to send follow-up instructions to an idle subagent (one that has finished its current turn).',
        'If the subagent is still streaming, call subagent_wait({id}) first — then use subagent_prompt once it becomes idle.',
        'Never call subagent_prompt on a subagent that was never started via subagent_start.',
      ],
      parameters: SubagentPromptSchema,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        extensionContext = ctx;
        if (isNestedSubagent())
          return nestedDelegationBlocked('subagent_prompt');
        const handle = handles.get(params.id);
        if (!handle) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Unknown subagent id: ${params.id}`,
              },
            ],
            details: {},
          };
        }

        if (isHandleActive(handle)) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Subagent #${handle.id} (${handle.agent.name}) is currently streaming. Call subagent_wait({id: "${handle.id}"}) first to let it finish, then send subagent_prompt with your follow-up message.`,
              },
            ],
            details: { handle: await serializeHandleForReturn(handle) },
          };
        }

        if (handle.state !== 'idle') {
          const stateText =
            handle.state === 'done'
              ? 'already completed and exited'
              : handle.state === 'error'
                ? 'already errored and exited'
                : handle.state === 'killed'
                  ? 'already killed'
                  : `in state ${handle.state}`;
          return {
            content: [
              {
                type: 'text' as const,
                text: `Subagent #${handle.id} (${handle.agent.name}) is ${stateText}. Only idle subagents can receive follow-up prompts. Start a new subagent with subagent_start instead.`,
              },
            ],
            details: { handle: await serializeHandleForReturn(handle) },
          };
        }

        if (!handle.process) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Subagent #${handle.id} process is no longer available. Start a new subagent with subagent_start instead.`,
              },
            ],
            details: { handle: await serializeHandleForReturn(handle) },
          };
        }

        const payload: Record<string, unknown> = {
          type: 'prompt',
          message: params.message,
        };
        if (params.images) payload.images = params.images;

        // Reset handle state for the new turn — process stays alive
        updateHandle(handle, {
          state: 'starting',
          statusText: 'Working on follow-up…',
          lastTool: undefined,
          lastPrompt: params.message,
        });

        try {
          await sendRpc(handle.process, handle, payload);
          return {
            content: [
              {
                type: 'text' as const,
                text: `Sent follow-up prompt to subagent #${handle.id} (${handle.agent.name}). Subagent acknowledged receipt.`,
              },
            ],
            details: {
              handle: await serializeHandleForReturn(handle),
            },
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return {
            content: [
              {
                type: 'text' as const,
                text: `Failed to send prompt to subagent #${handle.id}: ${message}. The subagent may have exited — call subagent_list to check its state, or start a new subagent with subagent_start.`,
              },
            ],
            details: { handle: await serializeHandleForReturn(handle) },
          };
        }
      },
    }),
  );
}
