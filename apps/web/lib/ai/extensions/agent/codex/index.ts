import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  BaseAgent,
  defineAgentPlugin,
  formatPlanForExecution,
  parsePlanFromResponse,
  parsePlanningResponse,
  PLANNING_INSTRUCTION,
} from "@openloomi/ai/agent";
import type { AgentPlugin } from "@openloomi/ai/agent/plugin";
import type {
  AgentConfig,
  AgentMessage,
  AgentOptions,
  AgentProvider,
  ExecuteOptions,
  PlanOptions,
} from "@openloomi/ai/agent/types";

import {
  buildCodexRunCommand,
  CodexCommandNotFoundError,
  normalizeCodexProviderConfig,
  runCodexCli,
  type CodexCliEvent,
} from "./command";
import { CODEX_METADATA } from "./metadata";
import { parseCodexJsonLine } from "./parser";
import { addConversationContext } from "../prompt-context";

/**
 * Codex CLI runtime adapter. Wraps `codex exec --json` (NDJSON event stream)
 * and projects the Codex item lifecycle into OpenLoomi AgentMessage events.
 *
 * The agent follows the same planning / execution contract as the OpenCode
 * adapter: planning forces `read-only` sandbox and disables `--full-auto`,
 * execution defaults to `workspace-write`, and `--full-auto` only fires when
 * both OpenLoomi permissionMode is `bypassPermissions` and the provider
 * config explicitly opts in.
 */
export class CodexAgent extends BaseAgent {
  readonly provider: AgentProvider = "codex";

  private messageCounter = 0;

  private generateMessageId(): string {
    return `codex_msg_${Date.now()}_${++this.messageCounter}`;
  }

  async *run(
    prompt: string,
    options?: AgentOptions,
  ): AsyncGenerator<AgentMessage> {
    const session = this.createSession("executing", {
      abortController: options?.abortController,
    });

    yield {
      type: "session",
      sessionId: session.id,
      messageId: this.generateMessageId(),
    };

    try {
      const cwd = await this.resolveAndPrepareWorkDir(options);
      yield* this.runCodexPrompt(
        prompt,
        cwd,
        options,
        "run",
        session.abortController.signal,
      );
    } catch (error) {
      yield this.toErrorMessage(error);
    } finally {
      this.sessions.delete(session.id);
      yield { type: "done", messageId: this.generateMessageId() };
    }
  }

  async *plan(
    prompt: string,
    options?: PlanOptions,
  ): AsyncGenerator<AgentMessage> {
    const session = this.createSession("planning", {
      abortController: options?.abortController,
    });

    yield {
      type: "session",
      sessionId: session.id,
      messageId: this.generateMessageId(),
    };

    let fullResponse = "";

    try {
      const cwd = await this.resolveAndPrepareWorkDir(options);
      const planningPrompt = `${PLANNING_INSTRUCTION(
        options?.timezone ?? undefined,
      )}\n\n${prompt}`;
      // Planning must never opt into --full-auto: every Codex plan turn runs
      // inside a read-only sandbox with on-request approval so the model can
      // only describe actions.
      const planningOptions: AgentOptions = {
        ...options,
        permissionMode: "plan",
      };

      for await (const message of this.runCodexPrompt(
        planningPrompt,
        cwd,
        planningOptions,
        "plan",
        session.abortController.signal,
      )) {
        if (message.type === "text" && message.content) {
          fullResponse += message.content;
          yield message;
        } else if (message.type === "error") {
          yield message;
          return;
        } else if (
          message.type === "tool_use" ||
          message.type === "tool_result" ||
          message.type === "reasoning" ||
          message.type === "session" ||
          message.type === "result"
        ) {
          yield message;
        }
      }

      const planningResult = parsePlanningResponse(fullResponse);
      if (planningResult?.type === "direct_answer") {
        yield {
          type: "direct_answer",
          content: planningResult.answer,
          messageId: this.generateMessageId(),
        };
        return;
      }

      const plan =
        planningResult?.type === "plan"
          ? planningResult.plan
          : parsePlanFromResponse(fullResponse);
      if (plan && plan.steps.length > 0) {
        this.storePlan(plan);
        yield {
          type: "plan",
          plan,
          messageId: this.generateMessageId(),
        };
        return;
      }

      yield {
        type: "direct_answer",
        content: fullResponse.trim(),
        messageId: this.generateMessageId(),
      };
    } catch (error) {
      yield this.toErrorMessage(error);
    } finally {
      this.sessions.delete(session.id);
      yield { type: "done", messageId: this.generateMessageId() };
    }
  }

  async *execute(options: ExecuteOptions): AsyncGenerator<AgentMessage> {
    const plan = options.plan || this.getPlan(options.planId);

    if (!plan) {
      yield {
        type: "session",
        sessionId: options.sessionId,
        messageId: this.generateMessageId(),
      };
      yield {
        type: "error",
        message: `Plan not found: ${options.planId}`,
        messageId: this.generateMessageId(),
      };
      yield { type: "done", messageId: this.generateMessageId() };
      return;
    }

    let completedSuccessfully = false;

    try {
      const cwd = await this.resolveAndPrepareWorkDir(options);
      const executionPrompt = `${formatPlanForExecution(
        plan,
        cwd,
        undefined,
        options.aiSoulPrompt ?? undefined,
        options.language ?? undefined,
        options.timezone ?? undefined,
      )}\n\nOriginal request: ${options.originalPrompt}`;

      let sawError = false;
      let sawAbort = false;
      for await (const message of this.run(executionPrompt, {
        ...options,
        cwd,
        sessionId: options.sessionId,
        abortController: options.abortController,
        permissionMode:
          options.permissionMode === "plan"
            ? "acceptEdits"
            : options.permissionMode,
      })) {
        if (message.type === "error") {
          sawError = true;
        }
        if (message.type === "result") {
          completedSuccessfully = !sawError;
        }
        yield message;
      }
      sawAbort = options.abortController?.signal.aborted ?? false;
      completedSuccessfully = completedSuccessfully && !sawAbort;
    } catch (error) {
      yield this.toErrorMessage(error);
    } finally {
      if (completedSuccessfully) {
        this.deletePlan(options.planId);
      }
    }
  }

  private async *runCodexPrompt(
    prompt: string,
    cwd: string,
    options: AgentOptions | undefined,
    mode: "run" | "plan" | "execute",
    signal: AbortSignal | undefined,
  ): AsyncGenerator<AgentMessage> {
    const providerConfig = normalizeCodexProviderConfig(
      this.config.providerConfig,
    );

    const command = buildCodexRunCommand({
      prompt: addConversationContext(prompt, options),
      cwd,
      model: this.config.model,
      permissionMode: options?.permissionMode,
      mode,
      providerConfig: this.config.providerConfig,
    });

    let closeEvent: Extract<CodexCliEvent, { type: "close" }> | undefined;
    let sawRuntimeError = false;
    let inputTokens = 0;
    let outputTokens = 0;
    let sawUsage = false;
    // Tracks tool_use ids that have started but not yet produced a tool_result,
    // plus workspace artifacts produced by completed file_change items. Both
    // are surfaced on provider timeout so the chat UI can transition in-flight
    // tool parts to a terminal state and offer an explicit Continue action
    // that reuses the same workspace instead of restarting from scratch.
    const inFlightToolIds = new Set<string>();
    const completedArtifacts = new Set<string>();

    for await (const event of runCodexCli(command.command, command.args, {
      cwd,
      env: providerConfig.env,
      signal: signal ?? options?.abortController?.signal,
      timeoutMs: providerConfig.timeoutMs,
    })) {
      if (event.type === "line") {
        for (const message of parseCodexJsonLine(event.line)) {
          if (message.type === "result") {
            if (message.usage) {
              inputTokens += message.usage.inputTokens;
              outputTokens += message.usage.outputTokens;
              sawUsage = true;
            }
            continue;
          }
          if (message.type === "error") {
            sawRuntimeError = true;
          }
          if (message.type === "tool_use") {
            const useId = message.id ?? message.toolUseId;
            if (useId) {
              inFlightToolIds.add(useId);
            }
            yield this.withMessageId(message);
            continue;
          }
          if (message.type === "tool_result") {
            const useId = message.toolUseId ?? message.id;
            if (useId) {
              inFlightToolIds.delete(useId);
            }
            // file_change tool results summarise the changed paths. Codex
            // emits them as part of the same item lifecycle as the tool_use,
            // so we capture them at completion time, not at start time, to
            // avoid reporting a path the CLI later reported as failed.
            if (message.output && typeof message.output === "string") {
              for (const line of message.output.split(/\r?\n/)) {
                const match = line.match(/^(?:create|update)\s+(.+)$/);
                if (match) {
                  completedArtifacts.add(match[1].trim());
                }
              }
            }
            yield this.withMessageId(message);
            continue;
          }
          yield this.withMessageId(message);
        }
        continue;
      }

      closeEvent = event;
    }

    if (!closeEvent) {
      return;
    }

    // Provider timeout: surface an interrupted state so the UI can mark
    // in-flight tool parts as terminal and offer a Continue action that
    // reuses the same workspace. We deliberately yield synthetic tool_result
    // events for every tool_use that never received a result, then a single
    // structured error message carrying the workspace path and any
    // artifacts that did manage to land before the deadline.
    if (closeEvent.timedOut) {
      for (const toolUseId of inFlightToolIds) {
        yield {
          type: "tool_result",
          toolUseId,
          output:
            "Tool execution was interrupted because the run reached the provider timeout.",
          isError: true,
          messageId: this.generateMessageId(),
        };
      }

      const interruptedMessage = formatCodexInterruptedError({
        timeoutMs: closeEvent.timeoutMs ?? providerConfig.timeoutMs ?? 0,
        workspacePath: cwd,
        completedArtifacts: Array.from(completedArtifacts),
      });
      yield {
        type: "error",
        message: interruptedMessage,
        messageId: this.generateMessageId(),
      };
      return;
    }

    if (closeEvent.exitCode !== 0) {
      yield {
        type: "error",
        message: formatCodexExitError(closeEvent),
        messageId: this.generateMessageId(),
      };
      return;
    }

    if (sawRuntimeError) {
      return;
    }

    yield {
      type: "result",
      content: "success",
      duration: closeEvent.duration,
      usage: sawUsage ? { inputTokens, outputTokens } : undefined,
      messageId: this.generateMessageId(),
    };
  }

  private withMessageId(message: AgentMessage): AgentMessage {
    return message.messageId
      ? message
      : { ...message, messageId: this.generateMessageId() };
  }

  private toErrorMessage(error: unknown): AgentMessage {
    return {
      type: "error",
      message:
        error instanceof CodexCommandNotFoundError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error),
      messageId: this.generateMessageId(),
    };
  }

  private async resolveAndPrepareWorkDir(options?: AgentOptions) {
    const rawWorkDir = options?.cwd || this.config.workDir || process.cwd();
    const resolved = resolveHome(rawWorkDir);
    await mkdir(resolved, { recursive: true });
    return resolved;
  }
}

function formatCodexExitError(
  closeEvent: Extract<CodexCliEvent, { type: "close" }>,
) {
  const output = closeEvent.stderr.trim() || closeEvent.stdout.trim();
  if (closeEvent.timedOut) {
    return output
      ? `Codex CLI timed out after ${closeEvent.timeoutMs}ms: ${output}`
      : `Codex CLI timed out after ${closeEvent.timeoutMs}ms`;
  }

  return output
    ? `Codex CLI exited with code ${closeEvent.exitCode}: ${output}`
    : `Codex CLI exited with code ${closeEvent.exitCode}`;
}

/**
 * Sentinel marker embedded in Codex error messages so the chat UI can
 * distinguish a *timeout interruption* (where the provider killed an active
 * run that still had in-flight work) from a plain CLI failure. The marker
 * carries the workspace path and any artifacts that did manage to land so
 * the UI can render a Continue action that reuses the existing workspace
 * instead of restarting the task from scratch.
 *
 * Keep the prefix stable — it is parsed by both the chat context and the
 * error message display component.
 */
export const CODEX_INTERRUPTED_MARKER = "__CODEX_INTERRUPTED__";

export interface CodexInterruptedContext {
  timeoutMs: number;
  workspacePath: string;
  completedArtifacts: string[];
}

export function formatCodexInterruptedError(context: CodexInterruptedContext) {
  const payload = JSON.stringify({
    marker: CODEX_INTERRUPTED_MARKER,
    reason: "timeout",
    timeoutMs: context.timeoutMs,
    workspacePath: context.workspacePath,
    completedArtifacts: context.completedArtifacts,
    canResume: true,
  });
  return `${CODEX_INTERRUPTED_MARKER} ${payload}`;
}

/**
 * Parse a Codex interrupted marker message back into its structured payload.
 * Returns `null` for any other error string so callers can safely chain
 * `if (parse(...))` checks before handling the interruption.
 */
export function parseCodexInterruptedError(
  raw: string,
): (CodexInterruptedContext & { canResume: boolean }) | null {
  if (!raw || !raw.startsWith(CODEX_INTERRUPTED_MARKER)) {
    return null;
  }

  const tail = raw.slice(CODEX_INTERRUPTED_MARKER.length).trim();
  try {
    const parsed = JSON.parse(tail) as {
      marker?: string;
      reason?: string;
      timeoutMs?: number;
      workspacePath?: string;
      completedArtifacts?: string[];
      canResume?: boolean;
    };

    if (parsed.marker !== CODEX_INTERRUPTED_MARKER) {
      return null;
    }

    return {
      timeoutMs:
        typeof parsed.timeoutMs === "number" ? parsed.timeoutMs : 0,
      workspacePath:
        typeof parsed.workspacePath === "string"
          ? parsed.workspacePath
          : "",
      completedArtifacts: Array.isArray(parsed.completedArtifacts)
        ? parsed.completedArtifacts.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [],
      canResume: parsed.canResume !== false,
    };
  } catch {
    return null;
  }
}

function resolveHome(filePath: string) {
  if (filePath === "~") {
    return homedir();
  }
  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    return join(homedir(), filePath.slice(2));
  }
  return isAbsolute(filePath) ? filePath : join(process.cwd(), filePath);
}

export function createCodexAgent(config: AgentConfig): CodexAgent {
  return new CodexAgent(config);
}

export const codexPlugin: AgentPlugin = defineAgentPlugin({
  metadata: CODEX_METADATA,
  factory: (config) => createCodexAgent(config),
});
