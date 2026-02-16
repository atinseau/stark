import type * as acp from "@agentclientprotocol/sdk";
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
import { type Span, SpanStatusCode } from "@opentelemetry/api";
import type pino from "pino";

import { AgentEvent } from "../../enums/agent-event.enum.ts";
import type {
	AgentEventMap,
	BaseAgentEvent,
} from "../../types/events.types.ts";
import type { EmitEventFn } from "../../types/observability.types.ts";
import type { TerminalManager } from "../terminal-manager/terminal-manager.ts";
import type { Tracer } from "../tracer/tracer.ts";

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Callback invoked when the ACP agent sends a session update notification.
 * The Agent wires this to the `AgentSessionUpdateHandler`.
 */
export type SessionUpdateCallback = (update: SessionUpdate) => void;

/**
 * Minimal configuration slice needed by the ACP client factory.
 */
export interface AgentAcpClientFactoryConfig {
	/** When `true`, permission requests are auto-approved. */
	autoApprove: boolean;
}

// ── AgentAcpClientFactory ───────────────────────────────────────────────────────

/**
 * Constructs the `acp.Client` implementation that handles all incoming
 * requests and notifications from the ACP agent process.
 *
 * This factory isolates the construction of the ACP client callbacks
 * (permissions, file system, terminal) from the Agent class, making
 * each concern independently testable.
 *
 * The factory receives its dependencies via the constructor:
 *   - **logger** — for structured logging of each operation
 *   - **tracer** — for OpenTelemetry span management
 *   - **emitEvent** — for typed event emission
 *   - **terminalManager** — for terminal lifecycle management
 *   - **config** — for permission auto-approve behavior
 *
 * ### Instrumentation Pattern
 *
 * Handlers use the private `logAndEmit` helper to combine logging and
 * event emission into a single call, eliminating the repeated
 * `logger.info(…) + emitEvent(…)` two-liner that previously appeared
 * in every handler. Tracing is handled via private methods on this class
 * (`tracePermissionStart`, `tracePermissionEnd`, `traceTerminalStart`)
 * or via `tracer.traced()`.
 *
 * @example
 * ```ts
 * const factory = new AgentAcpClientFactory(logger, tracer, emitEvent, terminalManager, config);
 * const client = factory.build(onSessionUpdate);
 * const connection = new acp.ClientSideConnection((_agent) => client, stream);
 * ```
 */
export class AgentAcpClientFactory {
	constructor(
		private readonly logger: pino.Logger,
		private readonly tracer: Tracer,
		private readonly emitEvent: EmitEventFn,
		private readonly terminalManager: TerminalManager,
		private readonly config: AgentAcpClientFactoryConfig,
	) {}

	/**
	 * Builds a complete `acp.Client` implementation with all request handlers.
	 *
	 * @param onSessionUpdate - Callback invoked for each session update notification.
	 * @returns An `acp.Client` object ready for use with `ClientSideConnection`.
	 */
	build(onSessionUpdate: SessionUpdateCallback): acp.Client {
		return {
			// ── Permission Handling ─────────────────────────────────────────
			requestPermission: async (
				params: RequestPermissionRequest,
			): Promise<RequestPermissionResponse> => {
				return this.handlePermission(params);
			},

			// ── Session Update Handling ────────────────────────────────────
			sessionUpdate: async (params: SessionNotification): Promise<void> => {
				onSessionUpdate(params.update);
			},

			// ── File System: Write ─────────────────────────────────────────
			writeTextFile: async (
				params: WriteTextFileRequest,
			): Promise<WriteTextFileResponse> => {
				return this.handleWriteTextFile(params);
			},

			// ── File System: Read ──────────────────────────────────────────
			readTextFile: async (
				params: ReadTextFileRequest,
			): Promise<ReadTextFileResponse> => {
				return this.handleReadTextFile(params);
			},

			// ── Terminal: Create ───────────────────────────────────────────
			createTerminal: async (
				params: CreateTerminalRequest,
			): Promise<CreateTerminalResponse> => {
				return this.handleCreateTerminal(params);
			},

			// ── Terminal: Get Output ───────────────────────────────────────
			terminalOutput: async (
				params: TerminalOutputRequest,
			): Promise<TerminalOutputResponse> => {
				this.logger.debug(
					{ terminalId: params.terminalId },
					"Terminal output requested",
				);
				return this.terminalManager.getOutput(params.terminalId);
			},

			// ── Terminal: Wait for Exit ────────────────────────────────────
			waitForTerminalExit: async (
				params: WaitForTerminalExitRequest,
			): Promise<WaitForTerminalExitResponse> => {
				this.logger.debug(
					{ terminalId: params.terminalId },
					"Waiting for terminal exit",
				);
				return this.terminalManager.waitForExit(params.terminalId);
			},

			// ── Terminal: Release ──────────────────────────────────────────
			releaseTerminal: async (
				params: ReleaseTerminalRequest,
			): Promise<ReleaseTerminalResponse> => {
				return this.handleReleaseTerminal(params);
			},

			// ── Terminal: Kill ─────────────────────────────────────────────
			killTerminal: async (
				params: KillTerminalCommandRequest,
			): Promise<KillTerminalCommandResponse> => {
				this.terminalManager.kill(params.terminalId);
				this.logger.debug({ terminalId: params.terminalId }, "Terminal killed");
				return {};
			},
		};
	}

	// ── Private Tracing Helpers ────────────────────────────────────────────

	/**
	 * Starts an `agent.permission` span as a child of the relevant tool call
	 * span (if found via tracked spans), or as a child of the active span.
	 */
	private tracePermissionStart(
		toolCallId: string,
		toolCallTitle?: string,
	): Span {
		const toolSpan = this.tracer.getTrackedSpan(toolCallId);
		const parent = toolSpan ?? "active";

		const span = this.tracer.startOperation(
			"agent.permission",
			{
				"permission.tool_call_id": toolCallId,
				...(toolCallTitle && {
					"permission.tool_call_title": toolCallTitle,
				}),
			},
			parent,
		);

		this.tracer.enterSpan(span);
		return span;
	}

	/**
	 * Ends a permission span with the outcome.
	 *
	 * Denied permissions use `SpanStatusCode.UNSET` (not ERROR) because a
	 * denial is a valid business outcome, not an operational failure.
	 */
	private tracePermissionEnd(
		span: Span,
		outcome: "granted" | "denied",
		details?: {
			optionId?: string;
			optionName?: string;
			reason?: string;
		},
	): void {
		if (!span.isRecording()) return;

		span.setAttribute("permission.outcome", outcome);

		if (details?.optionId) {
			span.setAttribute("permission.option_id", details.optionId);
		}
		if (details?.optionName) {
			span.setAttribute("permission.option_name", details.optionName);
		}
		if (details?.reason) {
			span.setAttribute("permission.denial_reason", details.reason);
		}

		span.setStatus(
			outcome === "granted"
				? { code: SpanStatusCode.OK }
				: { code: SpanStatusCode.UNSET },
		);

		this.tracer.leaveSpan(span);
		span.end();
	}

	/**
	 * Starts an `agent.terminal` span as a child of the active span
	 * and tracks it by `terminalId` so it can be ended later.
	 *
	 * Args are stored as a native string array (OTel supports `string[]` natively).
	 */
	private traceTerminalStart(
		terminalId: string,
		command: string,
		args?: string[],
		cwd?: string,
	): void {
		const span = this.tracer.startOperation(
			"agent.terminal",
			{
				"terminal.id": terminalId,
				"terminal.command": command,
				...(cwd && { "terminal.cwd": cwd }),
			},
			"active",
		);

		// TASK 9: Set args as native string array (OTel supports string[] natively)
		if (args && args.length > 0) {
			span.setAttribute("terminal.args", args);
		}

		this.tracer.trackSpan(terminalId, span, "terminal");
		this.tracer.enterSpan(span);
	}

	// ── Private Helpers ────────────────────────────────────────────────────

	/**
	 * Combines structured logging and typed event emission into a single call.
	 *
	 * This eliminates the repeated `logger.info(…); emitEvent(…);` two-liner
	 * that otherwise appears in every handler. The event payload is reused as
	 * the log object so the same attributes appear in both outputs.
	 *
	 * @param event      - The agent event type to emit.
	 * @param payload    - The domain-specific event payload (also used as log bindings).
	 * @param logMessage - The human-readable log message.
	 */
	private logAndEmit<K extends AgentEvent>(
		event: K,
		payload: Omit<AgentEventMap[K], keyof BaseAgentEvent>,
		logMessage: string,
	): void {
		this.logger.info(payload as Record<string, unknown>, logMessage);
		this.emitEvent(event, payload);
	}

	// ── Private Handlers ───────────────────────────────────────────────────

	private async handlePermission(
		params: RequestPermissionRequest,
	): Promise<RequestPermissionResponse> {
		const toolCallTitle = params.toolCall.title ?? params.toolCall.toolCallId;

		// Tracing: start permission span
		const permSpan = this.tracePermissionStart(
			params.toolCall.toolCallId,
			toolCallTitle,
		);

		this.logAndEmit(
			AgentEvent.PERMISSION_REQUESTED,
			{
				toolCallId: params.toolCall.toolCallId,
				toolCallTitle,
				options: params.options,
			},
			`Permission requested: ${toolCallTitle}`,
		);

		if (this.config.autoApprove) {
			// Find the first "allow" option
			const allowOption = params.options.find(
				(o: PermissionOption) =>
					o.kind === "allow_always" || o.kind === "allow_once",
			);

			if (allowOption) {
				this.logAndEmit(
					AgentEvent.PERMISSION_GRANTED,
					{
						toolCallId: params.toolCall.toolCallId,
						optionId: allowOption.optionId,
						optionName: allowOption.name,
					},
					`Permission auto-approved: ${allowOption.name}`,
				);

				// Tracing: end permission span (granted)
				this.tracePermissionEnd(permSpan, "granted", {
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

		this.emitEvent(AgentEvent.PERMISSION_DENIED, {
			toolCallId: params.toolCall.toolCallId,
			reason: denialReason,
		});

		// Tracing: end permission span (denied)
		this.tracePermissionEnd(permSpan, "denied", { reason: denialReason });

		return { outcome: { outcome: "cancelled" as const } };
	}

	private async handleWriteTextFile(
		params: WriteTextFileRequest,
	): Promise<WriteTextFileResponse> {
		this.logAndEmit(
			AgentEvent.FS_WRITE,
			{ path: params.path, contentLength: params.content.length },
			`FS write: ${params.path}`,
		);

		return this.tracer.traced(
			"agent.fs.write",
			async (span) => {
				const { writeFile, mkdir } = await import("node:fs/promises");
				const { dirname } = await import("node:path");

				await mkdir(dirname(params.path), { recursive: true });
				await writeFile(params.path, params.content, "utf-8");

				span.setAttribute("fs.content_length", params.content.length);
				this.logger.debug({ path: params.path }, "FS write complete");
				return {};
			},
			{
				attributes: {
					"fs.path": params.path,
					"fs.operation": "write",
					"fs.content_length": params.content.length,
				},
				parent: "active",
			},
		);
	}

	private async handleReadTextFile(
		params: ReadTextFileRequest,
	): Promise<ReadTextFileResponse> {
		this.logger.info({ path: params.path }, `FS read: ${params.path}`);

		return this.tracer.traced(
			"agent.fs.read",
			async (span) => {
				const { readFile } = await import("node:fs/promises");
				const content = await readFile(params.path, "utf-8");

				span.setAttribute("fs.content_length", content.length);

				this.logAndEmit(
					AgentEvent.FS_READ,
					{ path: params.path, contentLength: content.length },
					"FS read complete",
				);

				return { content };
			},
			{
				attributes: {
					"fs.path": params.path,
					"fs.operation": "read",
				},
				parent: "active",
			},
		);
	}

	private async handleCreateTerminal(
		params: CreateTerminalRequest,
	): Promise<CreateTerminalResponse> {
		const terminal = this.terminalManager.create(params);

		// Tracing: start terminal span (tracked internally by terminalId)
		// enterSpan is called inside traceTerminalStart so that the log
		// below carries the terminal span's ID.
		this.traceTerminalStart(
			terminal.terminalId,
			terminal.command,
			terminal.args,
			terminal.cwd,
		);

		this.logAndEmit(
			AgentEvent.TERMINAL_CREATED,
			{
				terminalId: terminal.terminalId,
				command: terminal.command,
				args: terminal.args,
				cwd: terminal.cwd,
			},
			`Terminal created: ${terminal.command}`,
		);

		// Leave the terminal span context after creation logging.
		// The span stays tracked (open) until the terminal exits, but
		// subsequent logs should not inherit the terminal's SpanId —
		// the terminal runs in the background.
		const termSpan = this.tracer.getTrackedSpan(terminal.terminalId);
		if (termSpan) this.tracer.leaveSpan(termSpan);

		return { terminalId: terminal.terminalId };
	}

	private async handleReleaseTerminal(
		params: ReleaseTerminalRequest,
	): Promise<ReleaseTerminalResponse> {
		this.terminalManager.release(params.terminalId);

		this.logger.debug({ terminalId: params.terminalId }, "Terminal released");

		this.emitEvent(AgentEvent.TERMINAL_RELEASED, {
			terminalId: params.terminalId,
		});

		return {};
	}
}
