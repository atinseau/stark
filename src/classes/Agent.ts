import { EventEmitter } from "node:events";
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalCommandRequest,
  KillTerminalCommandResponse,
  PermissionOption,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import type pino from "pino";

import { AgentStatus } from "../enums/agent-status.enum.ts";
import { AgentEvent } from "../enums/agent-event.enum.ts";
import type {
  AgentConfig,
  AgentIdentity,
  AgentSnapshot,
  PromptResult,
} from "../types/agent.types.ts";
import type { AgentEventMap } from "../types/events.types.ts";
import { generateIdentity } from "../utils/identity.ts";
import { TerminalManager } from "../utils/terminal-manager.ts";
import { isoNow, truncate } from "../utils/formatting.ts";
import { createLogger } from "../logger/create-logger.ts";
import { parseToolCommand, parseToolOutput, parseExitCode } from "../utils/tool-parsing.ts";
import { AgentTracer } from "../tracer/agent-tracer.ts";

// ── Internal Types ─────────────────────────────────────────────────────────

/** Tracks in-flight tool calls for summary logging and events. */
interface TrackedToolCall {
  title: string;
  kind?: string;
  status?: string;
  command?: string;
}

// ── Agent Class ────────────────────────────────────────────────────────────

/**
 * High-level ACP client that wraps a single agent process.
 *
 * The Agent manages the full lifecycle of an ACP connection:
 *   1. Spawns the agent executable as a child process
 *   2. Negotiates the ACP protocol (initialize + newSession)
 *   3. Exposes a simple `prompt()` API to send user messages
 *   4. Provides `injectContext()` to alter behavior mid-execution
 *   5. Emits strongly-typed events for pool orchestration
 *   6. Logs everything via pino (console + JSON)
 *
 * The Agent extends `EventEmitter` with a typed `emit`/`on` interface
 * so that a pool of agents can subscribe to fine-grained events like
 * `tool:start`, `plan:update`, `fs:write`, etc.
 *
 * @example
 * ```ts
 * const agent = new Agent({ cwd: "/my/project" });
 * await agent.ready;
 *
 * agent.on("tool:start", (e) => console.log(e.title));
 *
 * const result = await agent.prompt("Refactor the utils folder");
 * console.log(result.text);
 *
 * await agent.destroy();
 * ```
 */
export class Agent extends EventEmitter {
  // ── Public Identity ────────────────────────────────────────────────────

  /** The agent's unique identity (programmatic ID + human-friendly name). */
  readonly identity: AgentIdentity;

  /** Convenience accessor for the programmatic ID. */
  get id(): string {
    return this.identity.id;
  }

  /** Convenience accessor for the human-friendly name. */
  get name(): string {
    return this.identity.name;
  }

  // ── Public Logger ──────────────────────────────────────────────────────

  /** The pino logger instance used by this agent. Accessible for external use. */
  readonly logger: pino.Logger;

  // ── Public State ───────────────────────────────────────────────────────

  /** Current lifecycle status of the agent. */
  get status(): AgentStatus {
    return this._status;
  }

  /** ACP session ID, available after initialization completes. */
  get sessionId(): string | null {
    return this._sessionId;
  }

  /**
   * A promise that resolves when the agent has completed initialization
   * and is ready to accept prompts. Rejects if initialization fails.
   */
  readonly ready: Promise<void>;

  // ── Private State ──────────────────────────────────────────────────────

  private _status: AgentStatus = AgentStatus.INITIALIZING;
  private _sessionId: string | null = null;
  private _promptCount = 0;

  /** The ACP agent process. */
  private process: ChildProcess | null = null;

  /** The ACP client-side connection. */
  private connection: acp.ClientSideConnection | null = null;

  /** The raw writable stream passed to ndJsonStream, kept for graceful shutdown. */
  private outputStream: WritableStream<Uint8Array> | null = null;

  /** Terminal manager for handling spawned terminals. */
  private readonly terminalManager = new TerminalManager();

  /** Tracks in-flight tool calls by ID. */
  private readonly toolCalls = new Map<string, TrackedToolCall>();

  /** OpenTelemetry tracer for distributed tracing to Seq. */
  private readonly tracer: AgentTracer;

  /**
   * Queue of context instructions injected via `injectContext()`.
   * These are automatically sent as follow-up prompts after the current
   * prompt completes, or prepended to the next `prompt()` call.
   */
  private readonly pendingContext: string[] = [];

  /** Resolved configuration (defaults applied). */
  private readonly config: Required<
    Pick<AgentConfig, "executable" | "cwd" | "autoApprove">
  > & AgentConfig;

  /** Accumulated text from the current prompt turn. */
  private currentResponseText = "";

  // ── Constructor ────────────────────────────────────────────────────────

  /**
   * Creates a new Agent instance and begins async initialization.
   *
   * The agent spawns the ACP executable, negotiates the protocol,
   * and creates a session. Await `agent.ready` before sending prompts.
   *
   * @param config - Optional configuration. See {@link AgentConfig} for details.
   */
  constructor(config?: AgentConfig) {
    super();

    // Apply defaults
    this.config = {
      executable: config?.executable ?? process.env.COPILOT_CLI_PATH ?? "copilot",
      cwd: config?.cwd ?? process.cwd(),
      autoApprove: config?.autoApprove ?? true,
      ...config,
    };

    // Generate or use provided identity
    this.identity = generateIdentity({
      id: this.config.id,
      name: this.config.name,
    });

    // Create tracer (no-op when tracing is disabled) — must be created
    // BEFORE the logger so we can inject trace context into log bindings.
    const tracingConfig = this.config.tracing;
    this.tracer = new AgentTracer(this.identity, {
      enabled: !!tracingConfig,
      ...(typeof tracingConfig === "string" ? { endpoint: tracingConfig } : {}),
    });

    // Start the root session span immediately so traceId is available
    this.tracer.startSession();

    // Create logger with agent identity + trace context bindings.
    // When tracing is enabled, every log line carries TraceId/SpanId so
    // Seq can automatically correlate logs ↔ traces in its UI.
    this.logger = createLogger(this.identity, {
      logOutput: this.config.logOutput,
      logLevel: this.config.logLevel,
      traceContext: this.tracer.getTraceContext(),
    });

    // Wire terminal manager callbacks to our event system
    this.terminalManager.setOutputCallback((terminalId, stream, text) => {
      this.logger.debug({ terminalId, stream }, truncate(text, 300));
      this.emitTyped(AgentEvent.TERMINAL_OUTPUT, {
        terminalId,
        stream,
        text,
      });
    });

    this.terminalManager.setExitCallback((terminalId, result) => {
      this.logger.info(
        { terminalId, exitCode: result.exitCode, signal: result.signal },
        "Terminal exited",
      );
      this.emitTyped(AgentEvent.TERMINAL_EXIT, {
        terminalId,
        exitCode: result.exitCode,
        signal: result.signal,
      });
    });

    // Start async initialization — consumers await `agent.ready`
    this.ready = this.initialize().catch((err) => {
      this.setStatus(AgentStatus.ERROR);
      this.emitTyped(AgentEvent.AGENT_ERROR, {
        error: err instanceof Error ? err : new Error(String(err)),
        context: "initialization",
      });
      throw err;
    });

    this.logger.info(
      { agentId: this.identity.id, agentName: this.identity.name },
      "Agent created, initializing…",
    );
  }

  // ── Public API: Prompt ─────────────────────────────────────────────────

  /**
   * Sends a prompt to the agent and waits for the full response.
   *
   * If there are queued context instructions (from `injectContext()`),
   * they are prepended to the prompt text automatically.
   *
   * Only one prompt can be active at a time. If the agent is already
   * processing a prompt, this method throws.
   *
   * @param text - The user's prompt message.
   * @returns A {@link PromptResult} with the stop reason, full text, and usage.
   * @throws If the agent is not in IDLE status.
   *
   * @example
   * ```ts
   * const result = await agent.prompt("Create a REST API in Express");
   * console.log(result.text);
   * console.log(result.stopReason); // "end_turn"
   * ```
   */
  async prompt(text: string): Promise<PromptResult> {
    this.assertReady();

    // Drain any queued context and prepend to the prompt
    const fullPrompt = this.buildPromptWithContext(text);

    this._promptCount++;
    const promptIndex = this._promptCount;
    this.currentResponseText = "";

    this.setStatus(AgentStatus.BUSY);
    this.emitTyped(AgentEvent.AGENT_BUSY, { promptText: fullPrompt });
    this.emitTyped(AgentEvent.PROMPT_START, {
      promptText: fullPrompt,
      promptIndex,
    });

    this.logger.info({ promptIndex }, `Prompt: ${truncate(fullPrompt, 100)}`);

    // ── Tracing: start prompt span ───────────────────────────────────
    const promptSpan = this.tracer.startPrompt(promptIndex, fullPrompt);

    try {
      const result = await this.connection!.prompt({
        sessionId: this._sessionId!,
        prompt: [{ type: "text", text: fullPrompt }],
      });

      const promptResult: PromptResult = {
        stopReason: result.stopReason,
        text: this.currentResponseText,
        usage: result.usage,
      };

      this.emitTyped(AgentEvent.PROMPT_COMPLETE, {
        stopReason: result.stopReason,
        fullText: this.currentResponseText,
        usage: result.usage,
      });

      this.logger.info(
        {
          stopReason: result.stopReason,
          responseLength: this.currentResponseText.length,
          usage: result.usage,
        },
        "Prompt completed",
      );

      // ── Tracing: end prompt span (success) ─────────────────────────
      this.tracer.endPrompt(promptSpan, result.stopReason);

      this.setStatus(AgentStatus.IDLE);
      this.emitTyped(AgentEvent.AGENT_IDLE, { previousStatus: AgentStatus.BUSY });

      // Process any context injected while we were busy
      await this.drainPendingContext();

      return promptResult;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      // ── Tracing: end prompt span (error) ───────────────────────────
      this.tracer.endPrompt(promptSpan, undefined, error);

      this.setStatus(AgentStatus.ERROR);
      this.emitTyped(AgentEvent.AGENT_ERROR, {
        error,
        context: `prompt #${promptIndex}`,
      });
      this.logger.error({ err, promptIndex }, "Prompt failed");
      throw error;
    }
  }

  // ── Public API: Context Injection ──────────────────────────────────────

  /**
   * Injects new instructions into the agent's context.
   *
   * Behavior depends on the agent's current state:
   *
   *   - **IDLE**: The instructions are immediately sent as a follow-up
   *     prompt to the existing session. This is the typical usage when
   *     a pool orchestrator wants to steer an idle agent.
   *
   *   - **BUSY**: The instructions are queued and automatically sent
   *     as a follow-up prompt once the current prompt completes. Multiple
   *     injections during a single busy period are concatenated.
   *
   * This design preserves the ACP session's conversation history, so
   * injected instructions build upon all previous context.
   *
   * @param instructions - The new instructions to inject.
   *
   * @example
   * ```ts
   * // Steer the agent while it's idle
   * agent.injectContext("From now on, use TypeScript strict mode");
   *
   * // Queue instructions while a prompt is running
   * agent.prompt("Build the API"); // fire-and-forget
   * agent.injectContext("Also add input validation"); // queued
   * ```
   */
  injectContext(instructions: string): void {
    if (this._status === AgentStatus.DESTROYED) {
      throw new Error(`Agent "${this.name}" (${this.id}) has been destroyed`);
    }

    const queued = this._status === AgentStatus.BUSY;

    this.logger.info(
      { queued },
      `Context injected: ${truncate(instructions, 100)}`,
    );

    this.emitTyped(AgentEvent.CONTEXT_INJECTED, {
      instructions,
      queued,
    });

    // ── Tracing: record context injection event ──────────────────────
    this.tracer.recordContextInjection(instructions, queued);

    if (queued) {
      // Agent is busy — queue for later
      this.pendingContext.push(instructions);
    } else {
      // Agent is idle — send immediately as a follow-up prompt
      this.pendingContext.push(instructions);
      // Fire-and-forget: drain will handle it.
      // We don't await here because injectContext is synchronous.
      // The drain happens in a microtask.
      void this.drainPendingContext();
    }
  }

  // ── Public API: State Snapshot ──────────────────────────────────────────

  /**
   * Returns a read-only snapshot of the agent's current state.
   *
   * Useful for pool orchestrators to inspect agents without subscribing
   * to the full event stream.
   *
   * @returns An {@link AgentSnapshot} with identity, status, and counters.
   */
  snapshot(): AgentSnapshot {
    return {
      identity: { ...this.identity },
      status: this._status,
      sessionId: this._sessionId,
      promptCount: this._promptCount,
      pendingContextCount: this.pendingContext.length,
    };
  }

  // ── Public API: Destroy ────────────────────────────────────────────────

  /**
   * Gracefully shuts down the agent.
   *
   * This method:
   *   1. Kills all managed terminals
   *   2. Closes the ACP child process (SIGTERM with 2s timeout)
   *   3. Sets the status to DESTROYED
   *   4. Emits the `agent:destroyed` event
   *
   * After calling `destroy()`, the agent instance cannot be reused.
   */
  async destroy(): Promise<void> {
    if (this._status === AgentStatus.DESTROYED) return;

    this.logger.info("Destroying agent…");

    // ── Tracing: flush all spans before tearing down ─────────────────
    await this.tracer.shutdown();

    // Mark as destroyed early so the process "exit" handler
    // knows this is an intentional shutdown and doesn't emit
    // a spurious AGENT_ERROR.
    this.setStatus(AgentStatus.DESTROYED);

    // Kill all tracked terminals
    this.terminalManager.destroyAll();

    // Gracefully close the writable stream before killing the process.
    // This prevents the SDK from attempting writes on a dead stream
    // which would trigger noisy "ACP write error" console.error logs.
    if (this.outputStream) {
      try {
        await this.outputStream.close();
      } catch {
        // Stream may already be closed — that's fine.
      }
      this.outputStream = null;
    }

    // Wait briefly for the connection to notice the stream closure.
    if (this.connection) {
      await Promise.race([
        this.connection.closed,
        new Promise<void>((r) => setTimeout(r, 500)),
      ]);
      this.connection = null;
    }

    // Tear down the ACP child process
    if (this.process) {
      const proc = this.process;
      proc.stdin?.end();
      proc.kill("SIGTERM");

      await new Promise<void>((resolve) => {
        proc.once("exit", () => resolve());
        setTimeout(() => {
          proc.kill("SIGKILL");
          resolve();
        }, 2000);
      });

      this.process = null;
    }

    this.emitTyped(AgentEvent.AGENT_DESTROYED, {});

    this.logger.info("Agent destroyed");
  }

  // ── Typed Event Emitter Overrides ──────────────────────────────────────

  /**
   * Subscribe to a specific agent event with full type inference.
   *
   * @example
   * ```ts
   * agent.on("tool:start", (event) => {
   *   console.log(event.title);   // TS knows this is ToolStartEvent
   *   console.log(event.kind);
   * });
   * ```
   */
  override on<K extends AgentEvent>(
    event: K,
    listener: (payload: AgentEventMap[K]) => void,
  ): this {
    return super.on(event, listener);
  }

  /** Subscribe to a specific agent event, firing the listener at most once. */
  override once<K extends AgentEvent>(
    event: K,
    listener: (payload: AgentEventMap[K]) => void,
  ): this {
    return super.once(event, listener);
  }

  /** Remove a previously registered listener for a specific event. */
  override off<K extends AgentEvent>(
    event: K,
    listener: (payload: AgentEventMap[K]) => void,
  ): this {
    return super.off(event, listener);
  }

  /** @internal Emit a typed event. */
  override emit<K extends AgentEvent>(
    event: K,
    payload: AgentEventMap[K],
  ): boolean {
    return super.emit(event, payload);
  }

  // ── Private: Initialization ────────────────────────────────────────────

  /**
   * Spawns the ACP process, negotiates the protocol, and creates a session.
   * Called once from the constructor; consumers await `agent.ready`.
   */
  private async initialize(): Promise<void> {
    // ── Tracing: start initialize span ───────────────────────────────
    const initSpan = this.tracer.startInitialize();

    this.logger.debug(
      { executable: this.config.executable },
      "Spawning ACP process",
    );

    // Spawn the agent process — wrap in try-catch for ENOENT and similar errors
    const spawnPhase = this.tracer.startInitPhase("spawn-process", initSpan);
    let proc: ChildProcess;
    try {
      proc = spawn(this.config.executable, ["--acp", "--stdio"], {
        stdio: ["pipe", "pipe", "inherit"],
      });
      this.tracer.endInitialize(spawnPhase);
    } catch (err) {
      const error = new Error(
        `Failed to spawn ACP process "${this.config.executable}": ${err instanceof Error ? err.message : String(err)}`,
      );
      this.tracer.endInitialize(spawnPhase, error);
      this.tracer.endInitialize(initSpan, error);
      throw error;
    }

    // Listen for spawn errors (e.g. ENOENT when executable doesn't exist).
    // The error event fires asynchronously after spawn() returns.
    const spawnError = new Promise<never>((_, reject) => {
      proc.once("error", (err) => {
        reject(
          new Error(
            `Failed to start ACP process "${this.config.executable}": ${err.message}`,
          ),
        );
      });
    });

    if (!proc.stdin || !proc.stdout) {
      throw new Error(
        `Failed to start ACP process "${this.config.executable}" with piped stdio`,
      );
    }

    this.process = proc;

    // Handle unexpected process exit
    proc.once("exit", (code, signal) => {
      if (this._status !== AgentStatus.DESTROYED) {
        this.logger.warn(
          { code, signal },
          "ACP process exited unexpectedly",
        );
        this.setStatus(AgentStatus.ERROR);
        this.emitTyped(AgentEvent.AGENT_ERROR, {
          error: new Error(
            `ACP process exited unexpectedly (code=${code}, signal=${signal})`,
          ),
          context: "process_exit",
        });
      }
    });

    // Create the NDJSON stream and ACP connection
    const output = Writable.toWeb(proc.stdin) as WritableStream<Uint8Array>;
    const input = Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(output, input);

    // Keep a reference to the raw writable stream for graceful shutdown
    this.outputStream = output;

    const client = this.buildAcpClient();
    this.connection = new acp.ClientSideConnection((_agent) => client, stream);

    // Initialize the protocol.
    // Race against spawnError so that ENOENT is surfaced properly
    // instead of hanging on the initialize() call.
    this.logger.debug("Sending ACP initialize request");

    const acpInitPhase = this.tracer.startInitPhase("acp-protocol-init", initSpan);

    let initResult;
    try {
      initResult = await Promise.race([
        this.connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: {
              readTextFile: true,
              writeTextFile: true,
            },
            terminal: true,
          },
        }),
        spawnError,
      ]);
      this.tracer.endInitialize(acpInitPhase);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.tracer.endInitialize(acpInitPhase, error);
      this.tracer.endInitialize(initSpan, error);
      throw error;
    }

    this.logger.info(
      {
        protocolVersion: initResult.protocolVersion,
        agentInfo: initResult.agentInfo,
      },
      "ACP protocol initialized",
    );

    // Create a new session
    this.logger.debug({ cwd: this.config.cwd }, "Creating ACP session");

    const sessionPhase = this.tracer.startInitPhase("create-session", initSpan);

    let sessionResult;
    try {
      sessionResult = await this.connection.newSession({
        cwd: this.config.cwd,
        mcpServers: this.config.mcpServers ?? [],
      });
      this.tracer.endInitialize(sessionPhase);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.tracer.endInitialize(sessionPhase, error);
      this.tracer.endInitialize(initSpan, error);
      throw error;
    }

    this._sessionId = sessionResult.sessionId;

    this.logger.info(
      { sessionId: this._sessionId },
      "Session created",
    );

    // ── Tracing: end initialize span (success) ──────────────────────
    this.tracer.endInitialize(initSpan);

    // Ready!
    this.setStatus(AgentStatus.IDLE);
    this.emitTyped(AgentEvent.AGENT_READY, {
      sessionId: this._sessionId,
    });
  }

  // ── Private: ACP Client Builder ────────────────────────────────────────

  /**
   * Constructs the `acp.Client` implementation that handles all incoming
   * requests and notifications from the ACP agent process.
   */
  private buildAcpClient(): acp.Client {
    return {
      // ── Permission Handling ───────────────────────────────────────────
      requestPermission: async (
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> => {
        const toolCallTitle = params.toolCall.title ?? params.toolCall.toolCallId;

        // ── Tracing: start permission span ───────────────────────────
        const permSpan = this.tracer.startPermission({
          toolCallId: params.toolCall.toolCallId,
          toolCallTitle,
        });

        this.logger.info(
          {
            toolCallId: params.toolCall.toolCallId,
            options: params.options.map((o: PermissionOption) => ({
              id: o.optionId,
              name: o.name,
              kind: o.kind,
            })),
          },
          `Permission requested: ${toolCallTitle}`,
        );

        this.emitTyped(AgentEvent.PERMISSION_REQUESTED, {
          toolCallId: params.toolCall.toolCallId,
          toolCallTitle,
          options: params.options,
        });

        if (this.config.autoApprove) {
          // Find the first "allow" option
          const allowOption = params.options.find(
            (o: PermissionOption) => o.kind === "allow_always" || o.kind === "allow_once",
          );

          if (allowOption) {
            this.logger.info(
              {
                toolCallId: params.toolCall.toolCallId,
                optionId: allowOption.optionId,
                optionName: allowOption.name,
              },
              `Permission auto-approved: ${allowOption.name}`,
            );

            this.emitTyped(AgentEvent.PERMISSION_GRANTED, {
              toolCallId: params.toolCall.toolCallId,
              optionId: allowOption.optionId,
              optionName: allowOption.name,
            });

            // ── Tracing: end permission span (granted) ───────────────
            this.tracer.endPermission(permSpan, "granted", {
              optionId: allowOption.optionId,
              optionName: allowOption.name,
            });

            return {
              outcome: {
                outcome: "selected" as const,
                optionId: allowOption.optionId,
              },
            };
          }
        }

        // No auto-approve or no allow option available
        const denialReason = this.config.autoApprove
          ? "No allow option available"
          : "Auto-approve disabled";

        this.logger.warn(
          { toolCallId: params.toolCall.toolCallId },
          "Permission denied (no allow option or auto-approve disabled)",
        );

        this.emitTyped(AgentEvent.PERMISSION_DENIED, {
          toolCallId: params.toolCall.toolCallId,
          reason: denialReason,
        });

        // ── Tracing: end permission span (denied) ────────────────────
        this.tracer.endPermission(permSpan, "denied", { reason: denialReason });

        return { outcome: { outcome: "cancelled" as const } };
      },

      // ── Session Update Handling ──────────────────────────────────────
      sessionUpdate: async (
        params: SessionNotification,
      ): Promise<void> => {
        this.handleSessionUpdate(params.update);
      },

      // ── File System: Write ───────────────────────────────────────────
      writeTextFile: async (
        params: WriteTextFileRequest,
      ): Promise<WriteTextFileResponse> => {
        // ── Tracing: start fs.write span ─────────────────────────────
        const fsSpan = this.tracer.startFs({
          path: params.path,
          operation: "write",
          contentLength: params.content.length,
        });

        this.logger.info(
          { path: params.path, contentLength: params.content.length },
          `FS write: ${params.path}`,
        );

        this.emitTyped(AgentEvent.FS_WRITE, {
          path: params.path,
          contentLength: params.content.length,
        });

        try {
          const { writeFile, mkdir } = await import("node:fs/promises");
          const { dirname } = await import("node:path");

          await mkdir(dirname(params.path), { recursive: true });
          await writeFile(params.path, params.content, "utf-8");

          this.logger.debug({ path: params.path }, "FS write complete");
          this.tracer.endFs(fsSpan, params.content.length);
          return {};
        } catch (err) {
          this.tracer.endFs(fsSpan, undefined, err instanceof Error ? err : new Error(String(err)));
          throw err;
        }
      },

      // ── File System: Read ────────────────────────────────────────────
      readTextFile: async (
        params: ReadTextFileRequest,
      ): Promise<ReadTextFileResponse> => {
        // ── Tracing: start fs.read span ──────────────────────────────
        const fsSpan = this.tracer.startFs({
          path: params.path,
          operation: "read",
        });

        this.logger.info({ path: params.path }, `FS read: ${params.path}`);

        try {
          const { readFile } = await import("node:fs/promises");
          const content = await readFile(params.path, "utf-8");

          this.logger.debug(
            { path: params.path, contentLength: content.length },
            "FS read complete",
          );

          this.emitTyped(AgentEvent.FS_READ, {
            path: params.path,
            contentLength: content.length,
          });

          this.tracer.endFs(fsSpan, content.length);
          return { content };
        } catch (err) {
          this.tracer.endFs(fsSpan, undefined, err instanceof Error ? err : new Error(String(err)));
          throw err;
        }
      },

      // ── Terminal: Create ─────────────────────────────────────────────
      createTerminal: async (
        params: CreateTerminalRequest,
      ): Promise<CreateTerminalResponse> => {
        const terminal = this.terminalManager.create(params);

        // ── Tracing: start terminal span ─────────────────────────────
        this.tracer.startTerminal({
          terminalId: terminal.terminalId,
          command: terminal.command,
          args: terminal.args,
          cwd: terminal.cwd,
        });

        this.logger.info(
          {
            terminalId: terminal.terminalId,
            command: terminal.command,
            args: terminal.args,
            cwd: terminal.cwd,
          },
          `Terminal created: ${terminal.command}`,
        );

        this.emitTyped(AgentEvent.TERMINAL_CREATED, {
          terminalId: terminal.terminalId,
          command: terminal.command,
          args: terminal.args,
          cwd: terminal.cwd,
        });

        return { terminalId: terminal.terminalId };
      },

      // ── Terminal: Get Output ─────────────────────────────────────────
      terminalOutput: async (
        params: TerminalOutputRequest,
      ): Promise<TerminalOutputResponse> => {
        this.logger.debug(
          { terminalId: params.terminalId },
          "Terminal output requested",
        );
        return this.terminalManager.getOutput(params.terminalId);
      },

      // ── Terminal: Wait for Exit ──────────────────────────────────────
      waitForTerminalExit: async (
        params: WaitForTerminalExitRequest,
      ): Promise<WaitForTerminalExitResponse> => {
        this.logger.debug(
          { terminalId: params.terminalId },
          "Waiting for terminal exit",
        );
        return this.terminalManager.waitForExit(params.terminalId);
      },

      // ── Terminal: Release ────────────────────────────────────────────
      releaseTerminal: async (
        params: ReleaseTerminalRequest,
      ): Promise<ReleaseTerminalResponse> => {
        this.terminalManager.release(params.terminalId);

        this.logger.debug(
          { terminalId: params.terminalId },
          "Terminal released",
        );

        this.emitTyped(AgentEvent.TERMINAL_RELEASED, {
          terminalId: params.terminalId,
        });

        return {};
      },

      // ── Terminal: Kill ───────────────────────────────────────────────
      killTerminal: async (
        params: KillTerminalCommandRequest,
      ): Promise<KillTerminalCommandResponse | void> => {
        this.terminalManager.kill(params.terminalId);
        this.logger.debug(
          { terminalId: params.terminalId },
          "Terminal killed",
        );
      },
    };
  }

  // ── Private: Session Update Router ─────────────────────────────────────

  /**
   * Routes incoming ACP session updates to the appropriate handler,
   * logging and emitting events for each update type.
   */
  private handleSessionUpdate(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      // ── Agent message text ───────────────────────────────────────────
      case "agent_message_chunk": {
        if (update.content.type === "text") {
          this.currentResponseText += update.content.text;
          this.emitTyped(AgentEvent.PROMPT_CHUNK, {
            text: update.content.text,
          });
        }
        break;
      }

      // ── Agent reasoning / thinking ───────────────────────────────────
      case "agent_thought_chunk": {
        if (update.content.type === "text") {
          this.logger.debug(
            { thought: truncate(update.content.text, 200) },
            "Agent thinking",
          );
          this.emitTyped(AgentEvent.PROMPT_THOUGHT, {
            text: update.content.text,
          });
        }
        break;
      }

      // ── User message echo ────────────────────────────────────────────
      case "user_message_chunk": {
        // Typically just an echo; log at trace level
        if (update.content.type === "text") {
          this.logger.trace({ text: update.content.text }, "User message echo");
        }
        break;
      }

      // ── New tool call ────────────────────────────────────────────────
      case "tool_call": {
        const command = parseToolCommand(update.rawInput);

        this.toolCalls.set(update.toolCallId, {
          title: update.title,
          kind: update.kind ?? undefined,
          status: update.status ?? undefined,
          command,
        });

        // ── Tracing: start tool call span ────────────────────────────
        this.tracer.startToolCall({
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind ?? undefined,
          command,
        });

        this.logger.info(
          {
            toolCallId: update.toolCallId,
            kind: update.kind,
            status: update.status,
            locations: update.locations,
            command,
          },
          `Tool: ${update.title}${command ? ` → $ ${command}` : ""}`,
        );

        this.emitTyped(AgentEvent.TOOL_START, {
          toolCallId: update.toolCallId,
          title: update.title,
          kind: update.kind ?? undefined,
          locations: update.locations ?? undefined,
          command,
          rawInput: update.rawInput,
        });
        break;
      }

      // ── Tool call progress ───────────────────────────────────────────
      case "tool_call_update": {
        const existing = this.toolCalls.get(update.toolCallId);
        const title = update.title ?? existing?.title ?? update.toolCallId;

        // Update tracked state
        if (existing) {
          if (update.title) existing.title = update.title;
          if (update.status) existing.status = update.status;
          if (update.kind) existing.kind = update.kind;
        }

        const output = parseToolOutput(update.rawOutput);
        const exitCode = parseExitCode(update.rawOutput);

        // ── Tracing: update or end tool call span ────────────────────
        if (update.status === "completed" || update.status === "failed") {
          this.tracer.endToolCall(update.toolCallId, update.status ?? undefined, exitCode);
        } else {
          this.tracer.updateToolCall(
            update.toolCallId,
            update.status ?? undefined,
            output,
            exitCode,
          );
        }

        this.logger.info(
          {
            toolCallId: update.toolCallId,
            status: update.status,
            locations: update.locations,
            exitCode,
            output: output ? truncate(output, 500) : undefined,
          },
          `Tool update: ${title} → ${update.status ?? "update"}${exitCode != null ? ` (exit ${exitCode})` : ""}`,
        );

        this.emitTyped(AgentEvent.TOOL_UPDATE, {
          toolCallId: update.toolCallId,
          title: update.title,
          status: update.status,
          locations: update.locations,
          output,
          exitCode,
          rawOutput: update.rawOutput,
        });

        // Emit completion/failure events for terminal statuses
        if (update.status === "completed") {
          this.emitTyped(AgentEvent.TOOL_COMPLETE, {
            toolCallId: update.toolCallId,
            title,
            command: existing?.command,
            output,
            exitCode,
          });
        } else if (update.status === "failed") {
          this.emitTyped(AgentEvent.TOOL_FAILED, {
            toolCallId: update.toolCallId,
            title,
            command: existing?.command,
            output,
            exitCode,
          });
        }
        break;
      }

      // ── Execution plan ───────────────────────────────────────────────
      case "plan": {
        this.logger.info(
          { entryCount: update.entries.length },
          "Plan updated",
        );

        for (const entry of update.entries) {
          this.logger.info(
            { status: entry.status, priority: entry.priority },
            `  ${entry.status === "completed" ? "✅" : entry.status === "in_progress" ? "⚙️ " : "⏳"} [${entry.priority}] ${entry.content}`,
          );
        }

        this.emitTyped(AgentEvent.PLAN_UPDATE, {
          entries: update.entries,
        });
        break;
      }

      // ── Available commands ───────────────────────────────────────────
      case "available_commands_update": {
        this.logger.debug(
          { commandCount: update.availableCommands.length },
          "Available commands updated",
        );
        break;
      }

      // ── Mode change ──────────────────────────────────────────────────
      case "current_mode_update": {
        this.logger.info(
          { modeId: update.currentModeId },
          `Mode changed: ${update.currentModeId}`,
        );
        this.emitTyped(AgentEvent.MODE_CHANGE, {
          modeId: update.currentModeId,
        });
        break;
      }

      // ── Config change ────────────────────────────────────────────────
      case "config_option_update": {
        this.logger.debug("Config options updated");
        this.emitTyped(AgentEvent.CONFIG_UPDATE, {
          configOptions: update.configOptions,
        });
        break;
      }

      // ── Session info ─────────────────────────────────────────────────
      case "session_info_update": {
        this.logger.debug(
          { title: update.title },
          "Session info updated",
        );
        break;
      }

      // ── Usage / tokens ───────────────────────────────────────────────
      case "usage_update": {
        const percent =
          update.size > 0 ? Math.round((update.used / update.size) * 100) : 0;

        // ── Tracing: record usage event ──────────────────────────────
        this.tracer.recordUsage(update.used, update.size, percent);

        this.logger.info(
          {
            contextUsed: update.used,
            contextSize: update.size,
            contextPercent: percent,
            cost: update.cost,
          },
          `Usage: ${percent}% context (${update.used}/${update.size} tokens)`,
        );

        this.emitTyped(AgentEvent.USAGE_UPDATE, {
          contextSize: update.size,
          contextUsed: update.used,
          contextPercent: percent,
          cost: update.cost,
        });
        break;
      }

      default: {
        this.logger.warn(
          { update },
          "Unhandled session update type",
        );
        break;
      }
    }
  }

  // ── Private: Context Drain ─────────────────────────────────────────────

  /**
   * Sends all queued context instructions as a single follow-up prompt.
   * Called after a prompt completes or when `injectContext()` is called on
   * an idle agent.
   */
  private async drainPendingContext(): Promise<void> {
    if (this.pendingContext.length === 0) return;
    if (this._status !== AgentStatus.IDLE) return;

    // Collect and clear the queue
    const instructions = this.pendingContext.splice(0);
    const merged = instructions.join("\n\n---\n\n");

    this.logger.info(
      { instructionCount: instructions.length },
      `Draining ${instructions.length} queued context instruction(s)`,
    );

    // Send as a follow-up prompt (recursive call to `prompt`)
    await this.prompt(merged);
  }

  // ── Private: Helpers ───────────────────────────────────────────────────

  /**
   * Builds the final prompt string by prepending any queued context
   * instructions that should be included immediately (non-busy injection).
   */
  private buildPromptWithContext(text: string): string {
    if (this.pendingContext.length === 0) return text;

    const context = this.pendingContext.splice(0);
    const prefix = context.join("\n\n---\n\n");
    return `${prefix}\n\n---\n\nUser request:\n${text}`;
  }

  /**
   * Updates the internal status and logs the transition.
   */
  private setStatus(newStatus: AgentStatus): void {
    const prev = this._status;
    if (prev === newStatus) return;

    this._status = newStatus;
    this.logger.debug(
      { from: prev, to: newStatus },
      `Status: ${prev} → ${newStatus}`,
    );
  }

  /**
   * Throws if the agent is not ready to accept a prompt.
   */
  private assertReady(): void {
    if (this._status === AgentStatus.DESTROYED) {
      throw new Error(`Agent "${this.name}" (${this.id}) has been destroyed`);
    }
    if (this._status === AgentStatus.INITIALIZING) {
      throw new Error(
        `Agent "${this.name}" (${this.id}) is still initializing — await agent.ready first`,
      );
    }
    if (this._status === AgentStatus.BUSY) {
      throw new Error(
        `Agent "${this.name}" (${this.id}) is already processing a prompt`,
      );
    }
  }

  /**
   * Type-safe event emit helper that automatically injects the base
   * event fields (event type, timestamp, agent identity).
   */
  private emitTyped<K extends AgentEvent>(
    event: K,
    payload: Omit<AgentEventMap[K], keyof import("../types/events.types.ts").BaseAgentEvent>,
  ): void {
    const fullPayload = {
      event,
      timestamp: isoNow(),
      agent: { ...this.identity },
      ...payload,
    } as AgentEventMap[K];

    this.emit(event, fullPayload);
  }
}
