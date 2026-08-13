import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import spawn from "cross-spawn";

import {
  MAX_CLI_PROTOCOL_LINE_CHARS,
  appendCapturedCliOutput,
  buildAgentCliSearchPath,
  buildCliEnvironment,
  shouldDetachCliProcess,
  trackCliProcess,
  terminateCliProcessTree,
} from "../../cli-process";
import { CodexCommandNotFoundError } from "../command";
import type {
  CodexAppServerExit,
  CodexAppServerNotification,
  CodexAppServerRequestId,
  CodexAppServerRequestOptions,
  CodexAppServerThreadResumeParams,
  CodexAppServerThreadResumeResult,
  CodexAppServerThreadStartParams,
  CodexAppServerThreadStartResult,
  CodexAppServerTurnInterruptParams,
  CodexAppServerTurnStartParams,
  CodexAppServerTurnStartResult,
  CodexAppServerTurnSteerParams,
  CodexAppServerTurnSteerResult,
} from "./protocol";

const DEFAULT_CLIENT_VERSION = "1.0.0";
const SHUTDOWN_STDIN_GRACE_MS = 250;
const SHUTDOWN_TREE_KILL_WAIT_MS = 3_000;
const SHUTDOWN_DIRECT_KILL_WAIT_MS = 1_000;

type ClientState = "idle" | "running" | "closing" | "closed";

interface JsonRpcResponse {
  id: CodexAppServerRequestId;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

interface JsonRpcServerRequest {
  id: CodexAppServerRequestId;
  method: string;
  params?: unknown;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  cleanupAbort?: () => void;
}

export interface CodexAppServerClientOptions {
  command: string;
  cwd: string;
  /** Defaults to `app-server --stdio`. Primarily overridden by tests. */
  args?: readonly string[];
  profile?: string;
  env?: Record<string, string>;
  /** Aborting this signal terminates the app-server process. */
  signal?: AbortSignal;
}

export type CodexAppServerNotificationListener = (
  notification: CodexAppServerNotification,
) => void;

export class CodexAppServerRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(`Codex app-server ${method} failed (${code}): ${message}`);
    this.name = "CodexAppServerRpcError";
  }
}

export class CodexAppServerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexAppServerProtocolError";
  }
}

export class CodexAppServerExitError extends Error {
  constructor(readonly exit: CodexAppServerExit) {
    const output = exit.stderr.trim();
    const reason = exit.signal
      ? `signal ${exit.signal}`
      : `code ${exit.exitCode}`;
    super(
      output
        ? `Codex app-server exited unexpectedly (${reason}): ${output}`
        : `Codex app-server exited unexpectedly (${reason})`,
    );
    this.name = "CodexAppServerExitError";
  }
}

export class CodexAppServerShutdownError extends Error {
  constructor(pid: number | undefined) {
    super(
      `Codex app-server${pid ? ` process ${pid}` : ""} did not exit after forced shutdown`,
    );
    this.name = "CodexAppServerShutdownError";
  }
}

export function buildCodexAppServerArgs(profile?: string): string[] {
  return [
    ...(profile?.trim() ? ["-p", profile.trim()] : []),
    "app-server",
    "--disable",
    "goals",
    "--stdio",
  ];
}

/**
 * Long-lived, narrow JSON-RPC client for Codex app-server stdio transport.
 *
 * It deliberately has no inactivity timeout: a Codex turn may legitimately
 * spend a long time in a tool. Callers use AbortSignal for request or session
 * cancellation and `turn/interrupt` for normal runtime control.
 */
export class CodexAppServerClient {
  private proc?: ChildProcessWithoutNullStreams;
  private state: ClientState = "idle";
  private requestCounter = 0;
  private stdoutBuffer = "";
  private stderr = "";
  private fatalError?: Error;
  private initialized = false;
  private initializePromise?: Promise<void>;
  private shutdownPromise?: Promise<void>;
  private readonly pendingRequests = new Map<
    CodexAppServerRequestId,
    PendingRequest
  >();
  private readonly notificationListeners =
    new Set<CodexAppServerNotificationListener>();
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");
  private resolveExit!: (exit: CodexAppServerExit) => void;
  private readonly exitPromise = new Promise<CodexAppServerExit>((resolve) => {
    this.resolveExit = resolve;
  });

  constructor(private readonly options: CodexAppServerClientOptions) {}

  start(): void {
    if (this.state === "running") {
      return;
    }
    if (this.state !== "idle") {
      throw new Error("Codex app-server client cannot be restarted");
    }
    throwIfAborted(this.options.signal);

    const args = this.options.args
      ? [...this.options.args]
      : buildCodexAppServerArgs(this.options.profile);
    let proc: ChildProcessWithoutNullStreams;
    try {
      proc = spawn(this.options.command, args, {
        cwd: this.options.cwd,
        env: buildCliEnvironment({
          ...this.options.env,
          PATH: buildAgentCliSearchPath(this.options.env?.PATH),
        }),
        detached: shouldDetachCliProcess(),
        windowsHide: true,
      }) as ChildProcessWithoutNullStreams;
      trackCliProcess(proc);
    } catch (error) {
      throw normalizeSpawnError(error, this.options.command);
    }

    this.proc = proc;
    this.state = "running";
    this.options.signal?.addEventListener("abort", this.abortHandler, {
      once: true,
    });

    proc.stdin.on("error", (error: Error) => {
      if (this.state === "closing" || this.state === "closed") return;
      this.fail(error);
    });
    proc.stdout.on("data", (chunk: Buffer) => {
      this.handleStdoutChunk(chunk);
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      this.stderr = appendCapturedCliOutput(
        this.stderr,
        this.stderrDecoder.write(chunk),
      );
    });
    proc.on("error", (error: Error & { code?: string }) => {
      this.fail(normalizeSpawnError(error, this.options.command));
    });
    proc.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      this.handleClose(code, signal);
    });

    if (this.options.signal?.aborted) {
      this.abortHandler();
    }
  }

  initialize(options?: CodexAppServerRequestOptions): Promise<void> {
    if (this.initializePromise) {
      return this.initializePromise;
    }
    if (this.state === "idle") {
      this.start();
    }

    const initialization = this.request(
      "initialize",
      defaultInitializeParams(),
      options,
    ).then(() => {
      this.notify("initialized", {});
      this.initialized = true;
    });
    this.initializePromise = initialization;
    void initialization.catch(() => {
      if (!this.initialized && this.initializePromise === initialization) {
        this.initializePromise = undefined;
      }
    });
    return initialization;
  }

  async startThread(
    params: CodexAppServerThreadStartParams,
    options?: CodexAppServerRequestOptions,
  ): Promise<CodexAppServerThreadStartResult> {
    this.assertInitialized();
    return parseThreadStartResult(
      await this.request(
        "thread/start",
        { ...params, approvalPolicy: "never" },
        options,
      ),
    );
  }

  async resumeThread(
    params: CodexAppServerThreadResumeParams,
    options?: CodexAppServerRequestOptions,
  ): Promise<CodexAppServerThreadResumeResult> {
    this.assertInitialized();
    return parseThreadResumeResult(
      await this.request("thread/resume", params, options),
    );
  }

  async startTurn(
    params: CodexAppServerTurnStartParams,
    options?: CodexAppServerRequestOptions,
  ): Promise<CodexAppServerTurnStartResult> {
    this.assertInitialized();
    return parseTurnStartResult(
      await this.request("turn/start", params, options),
    );
  }

  async steerTurn(
    params: CodexAppServerTurnSteerParams,
    options?: CodexAppServerRequestOptions,
  ): Promise<CodexAppServerTurnSteerResult> {
    this.assertInitialized();
    return parseTurnSteerResult(
      await this.request("turn/steer", params, options),
    );
  }

  async interruptTurn(
    params: CodexAppServerTurnInterruptParams,
    options?: CodexAppServerRequestOptions,
  ): Promise<void> {
    this.assertInitialized();
    await this.request("turn/interrupt", params, options);
  }

  /**
   * Send an initialized app-server request outside the live-runtime surface.
   * This keeps capability probes on the same transport without expanding the
   * client with a typed method for every experimental app-server endpoint.
   */
  requestRaw<TResult = unknown>(
    method: string,
    params?: unknown,
    options?: CodexAppServerRequestOptions,
  ): Promise<TResult> {
    this.assertInitialized();
    return this.request<TResult>(method, params, options);
  }

  onNotification(listener: CodexAppServerNotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  waitForExit(): Promise<CodexAppServerExit> {
    return this.exitPromise;
  }

  async shutdown(): Promise<void> {
    if (this.state === "closed") {
      return;
    }
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }
    if (this.state === "idle") {
      this.state = "closed";
      this.resolveExit({
        exitCode: 0,
        signal: null,
        stderr: "",
        expected: true,
      });
      return;
    }

    this.state = "closing";
    this.rejectAll(new Error("Codex app-server client is shutting down"));
    this.shutdownPromise = this.finishShutdown();
    return this.shutdownPromise;
  }

  private async finishShutdown(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;

    // app-server is a stdio protocol: EOF is its normal shutdown boundary.
    // Let it close itself before terminating the process tree. Most
    // importantly, do not return until the child `close` event confirms that
    // the process and all three stdio streams have released their handles.
    // Windows otherwise keeps the child's cwd locked and callers can observe
    // EBUSY while cleaning up a completed Runtime Session.
    if (!proc.stdin.destroyed && proc.stdin.writable) {
      try {
        proc.stdin.end();
      } catch {
        // Fall through to process-tree termination below.
      }
    }
    if (await settlesWithin(this.exitPromise, SHUTDOWN_STDIN_GRACE_MS)) {
      return;
    }

    this.kill();
    if (await settlesWithin(this.exitPromise, SHUTDOWN_TREE_KILL_WAIT_MS)) {
      return;
    }

    // terminateCliProcessTree normally owns the full tree. If the platform
    // helper itself failed, make one bounded direct-child attempt and surface
    // a lifecycle error instead of hanging every Runtime Session shutdown.
    try {
      proc.kill("SIGKILL");
    } catch {
      // The final exit wait below determines whether the process is gone.
    }
    if (await settlesWithin(this.exitPromise, SHUTDOWN_DIRECT_KILL_WAIT_MS)) {
      return;
    }
    throw new CodexAppServerShutdownError(proc.pid);
  }

  private request<TResult>(
    method: string,
    params?: unknown,
    options?: CodexAppServerRequestOptions,
  ): Promise<TResult> {
    this.assertRunning();
    throwIfAborted(options?.signal);
    const id = ++this.requestCounter;

    return new Promise<TResult>((resolve, reject) => {
      const pending: PendingRequest = {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      const onAbort = () => {
        if (!this.pendingRequests.delete(id)) {
          return;
        }
        pending.cleanupAbort?.();
        reject(createAbortError(options?.signal));
      };
      if (options?.signal) {
        options.signal.addEventListener("abort", onAbort, { once: true });
        pending.cleanupAbort = () =>
          options.signal?.removeEventListener("abort", onAbort);
      }

      this.pendingRequests.set(id, pending);
      if (options?.signal?.aborted) {
        onAbort();
        return;
      }
      try {
        this.write({ id, method, params });
      } catch (error) {
        this.pendingRequests.delete(id);
        pending.cleanupAbort?.();
        reject(toError(error));
      }
    });
  }

  private notify(method: string, params?: unknown): void {
    this.write({ method, params });
  }

  private handleStdoutChunk(chunk: Buffer): void {
    const text = this.stdoutDecoder.write(chunk);
    this.stdoutBuffer += text;
    if (this.stdoutBuffer.length > MAX_CLI_PROTOCOL_LINE_CHARS) {
      this.fail(
        new CodexAppServerProtocolError(
          `Codex app-server emitted a JSON line larger than ${MAX_CLI_PROTOCOL_LINE_CHARS} characters`,
        ),
      );
      return;
    }
    this.flushStdoutLines();
  }

  private flushStdoutLines(): void {
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) {
        this.handleLine(line);
      }
    }
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.fail(
        new CodexAppServerProtocolError(
          "Codex app-server emitted invalid JSON on stdout",
        ),
      );
      return;
    }

    if (isServerRequest(message)) {
      this.handleServerRequest(message);
      return;
    }
    if (isNotification(message)) {
      for (const listener of this.notificationListeners) {
        try {
          listener({ method: message.method, params: message.params });
        } catch {
          // An observer failure must not stop the transport pump.
        }
      }
      return;
    }
    if (isResponse(message)) {
      this.handleResponse(message);
    }
  }

  private handleResponse(message: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(message.id);
    if (!pending) {
      return;
    }
    this.pendingRequests.delete(message.id);
    pending.cleanupAbort?.();

    if (message.error) {
      pending.reject(
        new CodexAppServerRpcError(
          pending.method,
          typeof message.error.code === "number" ? message.error.code : -1,
          message.error.message?.trim() || "unknown error",
          message.error.data,
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  private handleServerRequest(request: JsonRpcServerRequest): void {
    try {
      switch (request.method) {
        case "item/commandExecution/requestApproval":
        case "item/fileChange/requestApproval":
          this.write({ id: request.id, result: { decision: "decline" } });
          return;
        default:
          this.write({
            id: request.id,
            error: {
              code: -32601,
              message: `Unsupported OpenLoomi app-server method: ${request.method}`,
            },
          });
      }
    } catch (error) {
      this.fail(toError(error));
    }
  }

  private handleClose(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const finalStdout = this.stdoutDecoder.end();
    if (finalStdout) {
      this.stdoutBuffer += finalStdout;
    }
    this.stderr = appendCapturedCliOutput(
      this.stderr,
      this.stderrDecoder.end(),
    );
    if (this.stdoutBuffer.trim() && !this.fatalError) {
      this.handleLine(this.stdoutBuffer);
    }
    this.stdoutBuffer = "";

    const expected =
      Boolean(this.options.signal?.aborted) ||
      (this.state === "closing" && !this.fatalError);
    const exit: CodexAppServerExit = {
      exitCode: code ?? (signal ? 130 : 0),
      signal,
      stderr: this.stderr,
      expected,
    };
    const error =
      this.fatalError ??
      (!expected ? new CodexAppServerExitError(exit) : undefined);
    if (error) {
      this.rejectAll(error);
    } else if (this.pendingRequests.size > 0) {
      this.rejectAll(new Error("Codex app-server closed before responding"));
    }

    this.state = "closed";
    this.options.signal?.removeEventListener("abort", this.abortHandler);
    this.resolveExit(exit);
  }

  private fail(error: Error): void {
    if (this.fatalError || this.state === "closed") {
      return;
    }
    this.fatalError = error;
    this.rejectAll(error);
    this.kill();
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.cleanupAbort?.();
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private kill(): void {
    if (!this.proc || this.proc.killed) {
      return;
    }
    terminateCliProcessTree(this.proc);
  }

  private write(message: Record<string, unknown>): void {
    this.assertRunning();
    this.proc?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error("Codex app-server client has not been initialized");
    }
    this.assertRunning();
  }

  private assertRunning(): void {
    if (this.state !== "running" || !this.proc) {
      throw (
        this.fatalError ?? new Error("Codex app-server process is not running")
      );
    }
  }

  private readonly abortHandler = () => {
    if (this.state === "closing" || this.state === "closed") {
      return;
    }
    const error = createAbortError(this.options.signal);
    this.fatalError = error;
    this.rejectAll(error);
    this.state = "closing";
    this.kill();
  };
}

function defaultInitializeParams() {
  return {
    clientInfo: {
      name: "openloomi",
      title: "OpenLoomi",
      version: DEFAULT_CLIENT_VERSION,
    },
    capabilities: {
      experimentalApi: false,
      requestAttestation: false,
    },
  };
}

async function settlesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function parseThreadStartResult(
  value: unknown,
): CodexAppServerThreadStartResult {
  const result = asObject(value, "thread/start result");
  const thread = asObject(result.thread, "thread/start thread");
  if (typeof thread.id !== "string" || !thread.id.trim()) {
    throw new CodexAppServerProtocolError(
      "Codex app-server thread/start result is missing thread.id",
    );
  }
  return result as unknown as CodexAppServerThreadStartResult;
}

function parseThreadResumeResult(
  value: unknown,
): CodexAppServerThreadResumeResult {
  const method = "thread/resume";
  const result = asObject(value, `${method} result`);
  const thread = asObject(result.thread, `${method} thread`);
  if (typeof thread.id !== "string" || !thread.id.trim()) {
    throw new CodexAppServerProtocolError(
      `Codex app-server ${method} result is missing thread.id`,
    );
  }
  if (!Array.isArray(thread.turns)) {
    throw new CodexAppServerProtocolError(
      `Codex app-server ${method} thread is missing turns`,
    );
  }
  for (const [index, rawTurn] of thread.turns.entries()) {
    const turn = asObject(rawTurn, `${method} thread.turns[${index}]`);
    parseTurn(turn, `${method} thread.turns[${index}]`);
    if (!Array.isArray(turn.items)) {
      throw new CodexAppServerProtocolError(
        `Codex app-server ${method} thread.turns[${index}] is missing items`,
      );
    }
  }
  return result as unknown as CodexAppServerThreadResumeResult;
}

function parseTurnStartResult(value: unknown): CodexAppServerTurnStartResult {
  const result = asObject(value, "turn/start result");
  parseTurn(result.turn, "turn/start turn");
  return result as unknown as CodexAppServerTurnStartResult;
}

function parseTurnSteerResult(value: unknown): CodexAppServerTurnSteerResult {
  const result = asObject(value, "turn/steer result");
  if (typeof result.turnId !== "string" || !result.turnId.trim()) {
    throw new CodexAppServerProtocolError(
      "Codex app-server turn/steer result is missing turnId",
    );
  }
  return result as unknown as CodexAppServerTurnSteerResult;
}

function parseTurn(value: unknown, label: string): void {
  const turn = asObject(value, label);
  if (typeof turn.id !== "string" || !turn.id.trim()) {
    throw new CodexAppServerProtocolError(
      `Codex app-server ${label} is missing id`,
    );
  }
  if (
    turn.status !== "completed" &&
    turn.status !== "interrupted" &&
    turn.status !== "failed" &&
    turn.status !== "inProgress"
  ) {
    throw new CodexAppServerProtocolError(
      `Codex app-server ${label} has an invalid status`,
    );
  }
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CodexAppServerProtocolError(
      `Codex app-server returned an invalid ${label}`,
    );
  }
  return value as Record<string, unknown>;
}

function isServerRequest(value: unknown): value is JsonRpcServerRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const message = value as { id?: unknown; method?: unknown };
  return isRequestId(message.id) && typeof message.method === "string";
}

function isNotification(
  value: unknown,
): value is { method: string; params?: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const message = value as { id?: unknown; method?: unknown };
  return message.id === undefined && typeof message.method === "string";
}

function isResponse(value: unknown): value is JsonRpcResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const message = value as { id?: unknown; method?: unknown };
  return isRequestId(message.id) && message.method === undefined;
}

function isRequestId(value: unknown): value is CodexAppServerRequestId {
  return typeof value === "string" || typeof value === "number";
}

function normalizeSpawnError(error: unknown, command: string): Error {
  const normalized = toError(error) as Error & { code?: string };
  return normalized.code === "ENOENT"
    ? new CodexCommandNotFoundError(command)
    : normalized;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError(signal);
  }
}

function createAbortError(signal: AbortSignal | undefined): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException(
        "The Codex app-server request was aborted",
        "AbortError",
      );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
