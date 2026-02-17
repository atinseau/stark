import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";

import type pino from "pino";
import { AgentEvent } from "../../enums/agent-event.enum.ts";
import { AgentStatus } from "../../enums/agent-status.enum.ts";
import { createLogger } from "../../logger/create-logger.ts";
import type {
	AgentConfig,
	AgentIdentity,
	AgentSnapshot,
	PromptResult,
} from "../../types/agent.types.ts";
import type { StructuredContextInjection } from "../../types/agent-pool.types.ts";
import type { AgentEventMap } from "../../types/events.types.ts";
import { toError } from "../../utils/errors.ts";
import { isoNow, truncate } from "../../utils/formatting.ts";
import { generateIdentity } from "../../utils/identity.ts";
import { TerminalManager } from "../terminal-manager/terminal-manager.ts";
import { AgentAcpClientFactory } from "./agent-acp-client-factory.ts";
import { AgentContextManager } from "./agent-context-manager.ts";
import { AgentSessionUpdateHandler } from "./agent-session-update-handler.ts";

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
 * Internally, the Agent delegates to focused components:
 *   - {@link AgentContextManager} — pure logic for the context injection queue
 *   - {@link AgentSessionUpdateHandler} — routes ACP session updates to events/logs
 *   - {@link AgentAcpClientFactory} — builds the ACP client (permissions, FS, terminal)
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

	/** Pure-logic context injection queue manager. */
	private readonly contextManager = new AgentContextManager();

	/** Routes ACP session updates to events and logs. */
	private readonly sessionUpdateHandler: AgentSessionUpdateHandler;

	/** Builds the ACP client implementation. */
	private readonly acpClientFactory: AgentAcpClientFactory;

	/** Resolved configuration (defaults applied). */
	private readonly config: Required<
		Pick<AgentConfig, "executable" | "cwd" | "autoApprove">
	> &
		AgentConfig;

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
			executable:
				config?.executable ?? process.env.COPILOT_CLI_PATH ?? "copilot",
			cwd: config?.cwd ?? process.cwd(),
			autoApprove: config?.autoApprove ?? true,
			...config,
		};

		// Generate or use provided identity
		this.identity = generateIdentity({
			id: this.config.id,
			name: this.config.name,
		});

		// Create logger with agent identity
		this.logger = createLogger(this.identity, {
			logOutput: this.config.logOutput,
			logLevel: this.config.logLevel,
		});

		// Create the bound emitEvent callback for child components
		const emitEvent = this.emitTyped.bind(this);

		// Initialize the session update handler
		this.sessionUpdateHandler = new AgentSessionUpdateHandler(
			this.logger,
			emitEvent,
			this.identity.name,
		);

		// Initialize the ACP client factory
		this.acpClientFactory = new AgentAcpClientFactory(
			this.logger,
			emitEvent,
			this.terminalManager,
			{
				autoApprove: this.config.autoApprove,
				onApproveRequest: this.config.autoApprove
					? undefined
					: async (request) => {
							// If no listener is registered, deny immediately
							if (this.listenerCount(AgentEvent.APPROVE_REQUEST) === 0) {
								return false;
							}
							return new Promise<boolean>((resolve) => {
								this.emitTyped(AgentEvent.APPROVE_REQUEST, {
									toolCallId: request.toolCallId,
									toolCallTitle: request.toolCallTitle,
									options: request.options,
									resolve,
								});
							});
						},
			},
			this.identity.name,
		);

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

		this.logger.info(
			{ agentId: this.identity.id, agentName: this.identity.name },
			"Session started",
		);

		// Start async initialization — consumers await `agent.ready`
		this.ready = this.initialize().catch((err) => {
			this.setStatus(AgentStatus.ERROR);
			this.emitTyped(AgentEvent.AGENT_ERROR, {
				error: toError(err),
				context: "initialization",
			});
			throw err;
		});
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
		const fullPrompt = this.contextManager.buildPromptWithContext(text);

		this._promptCount++;
		const promptIndex = this._promptCount;
		this.sessionUpdateHandler.resetResponseText();

		this.setStatus(AgentStatus.BUSY);
		this.emitTyped(AgentEvent.AGENT_BUSY, { promptText: fullPrompt });
		this.emitTyped(AgentEvent.PROMPT_START, {
			promptText: fullPrompt,
			promptIndex,
		});

		this.logger.info(
			{ promptIndex, promptLength: fullPrompt.length },
			`Prompting (#${promptIndex}, ${fullPrompt.length} chars)`,
		);

		if (!this.connection || !this._sessionId) {
			throw new Error("Agent is not connected or has no session");
		}

		try {
			const result = await this.connection.prompt({
				sessionId: this._sessionId,
				prompt: [{ type: "text", text: fullPrompt }],
			});

			if (!result) {
				throw new Error("Prompt returned no result — connection may be closed");
			}

			const promptResult: PromptResult = {
				stopReason: result.stopReason,
				text: this.sessionUpdateHandler.responseText,
				usage: result.usage,
			};

			this.emitTyped(AgentEvent.PROMPT_COMPLETE, {
				stopReason: promptResult.stopReason,
				fullText: promptResult.text,
				usage: promptResult.usage,
			});

			this.logger.info(
				{
					stopReason: promptResult.stopReason,
					responseLength: promptResult.text.length,
					usage: promptResult.usage,
				},
				`Prompt complete — ${promptResult.stopReason}, ${promptResult.text.length} chars`,
			);

			this.setStatus(AgentStatus.IDLE);
			this.emitTyped(AgentEvent.AGENT_IDLE, {
				previousStatus: AgentStatus.BUSY,
			});

			// Process any context injected while we were busy
			await this.drainPendingContext();

			return promptResult;
		} catch (err) {
			const error = toError(err);

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
	 * Accepts either a raw string (backward compatible) or a
	 * StructuredContextInjection (for prioritized, categorized injections).
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
	 * @param instructions - The instructions to inject (string or structured).
	 *
	 * @example
	 * ```ts
	 * // Legacy mode — backward compatible
	 * agent.injectContext("From now on, use TypeScript strict mode");
	 *
	 * // Structured mode — prioritized and categorized
	 * agent.injectContext({
	 *   content: "The API uses port 3000",
	 *   priority: ContextInjectionPriority.CRITICAL,
	 *   category: ContextInjectionCategory.DEPENDENCY_OUTPUT,
	 *   source: "api-developer",
	 *   dependencyType: "blocking",
	 *   timestamp: new Date().toISOString(),
	 * });
	 * ```
	 */
	injectContext(instructions: string | StructuredContextInjection): void {
		if (this._status === AgentStatus.DESTROYED) {
			throw new Error(`Agent "${this.name}" (${this.id}) has been destroyed`);
		}

		const queued = this._status === AgentStatus.BUSY;

		if (typeof instructions === "string") {
			// Legacy mode — backward compatible
			this.logger.info(
				{ queued },
				`Context injected (legacy): ${truncate(instructions, 100)}`,
			);

			this.emitTyped(AgentEvent.CONTEXT_INJECTED, {
				instructions,
				queued,
			});

			this.contextManager.inject(instructions);
		} else {
			// Structured mode — prioritized and categorized
			this.logger.info(
				{
					queued,
					priority: instructions.priority,
					category: instructions.category,
					source: instructions.source,
				},
				`Context injected (structured, ${instructions.priority}): ${truncate(instructions.content, 100)}`,
			);

			this.emitTyped(AgentEvent.CONTEXT_INJECTED, {
				instructions: instructions.content,
				queued,
			});

			const { dropped } = this.contextManager.injectStructured(instructions);

			if (dropped > 0) {
				this.logger.warn(
					{ dropped, pendingCount: this.contextManager.pendingCount },
					`Overflow: ${dropped} low-priority injection(s) dropped from queue`,
				);
			}
		}

		if (!queued) {
			// Agent is idle — send immediately as a follow-up prompt
			// Fire-and-forget: drain will handle it.
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
			pendingContextCount: this.contextManager.pendingCount,
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

		this.logger.info("Shutting down");

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

		this.logger.info("Session closed");
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
		this.logger.debug(
			{ executable: this.config.executable },
			"Spawning ACP process",
		);

		// Spawn the agent process and attach the error listener immediately
		// (before any microtask tick) so Bun's async ENOENT is always caught.
		const proc = spawn(this.config.executable, ["--acp", "--stdio"], {
			stdio: ["pipe", "pipe", "inherit"],
		});

		// Listen for spawn errors (e.g. ENOENT when executable doesn't exist).
		// Must be attached synchronously right after spawn() so the listener
		// is in place before the event loop fires the error event.
		const spawnError = new Promise<never>((_, reject) => {
			proc.once("error", (err) => {
				reject(
					new Error(
						`Failed to start ACP process "${this.config.executable}": ${err.message}`,
					),
				);
			});
		});

		if (!proc || !proc.stdin || !proc.stdout) {
			throw new Error(
				`Failed to start ACP process "${this.config.executable}" with piped stdio`,
			);
		}

		this.process = proc;

		// Handle unexpected process exit
		proc.once("exit", (code, signal) => {
			if (this._status !== AgentStatus.DESTROYED) {
				this.logger.warn({ code, signal }, "ACP process exited unexpectedly");
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

		const client = this.acpClientFactory.build((update) =>
			this.sessionUpdateHandler.handle(update),
		);
		this.connection = new acp.ClientSideConnection((_agent) => client, stream);

		// Initialize the protocol.
		// Race against spawnError so that ENOENT is surfaced properly
		// instead of hanging on the initialize() call.
		this.logger.debug("Sending ACP initialize request");

		const initResult = await Promise.race([
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

		if (!initResult) {
			throw new Error(
				"ACP initialize returned no result — connection may be closed",
			);
		}

		this.logger.info(
			{
				protocolVersion: initResult.protocolVersion,
				agentInfo: initResult.agentInfo,
			},
			`Protocol ready (ACP v${initResult.protocolVersion})`,
		);

		// Create a new session
		this.logger.debug({ cwd: this.config.cwd }, "Creating ACP session");

		const sessionResult = await this.connection.newSession({
			cwd: this.config.cwd,
			mcpServers: this.config.mcpServers ?? [],
		});

		if (!sessionResult) {
			throw new Error(
				"ACP newSession returned no result — connection may be closed",
			);
		}

		this._sessionId = sessionResult.sessionId;

		this.logger.info({ sessionId: this._sessionId }, "Session ready");

		// Ready!
		this.setStatus(AgentStatus.IDLE);
		if (!this._sessionId) {
			throw new Error("Session ID was not set during initialization");
		}
		this.emitTyped(AgentEvent.AGENT_READY, {
			sessionId: this._sessionId,
		});
	}

	// ── Private: Context Drain ─────────────────────────────────────────────

	/**
	 * Sends all queued context instructions as a single follow-up prompt.
	 * Called after a prompt completes or when `injectContext()` is called on
	 * an idle agent.
	 */
	private async drainPendingContext(): Promise<void> {
		if (!this.contextManager.hasPending()) return;
		if (this._status !== AgentStatus.IDLE) return;

		const merged = this.contextManager.drain();
		if (!merged) return;

		this.logger.info("Draining queued context instruction(s)");

		// Send as a follow-up prompt (recursive call to `prompt`)
		await this.prompt(merged);
	}

	// ── Private: Helpers ───────────────────────────────────────────────────

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
		payload: Omit<
			AgentEventMap[K],
			keyof import("../../types/events.types.ts").BaseAgentEvent
		>,
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
