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
import type pino from "pino";

import { AgentEvent } from "../../enums/agent-event.enum.ts";
import { SpanName } from "../../enums/span-name.enum.ts";
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
 * Information passed to the `onApproveRequest` callback so the
 * consumer can make an informed approval decision.
 */
export interface ApproveRequestInfo {
	/** The tool call that requires approval. */
	toolCallId: string;
	/** Human-readable title of the tool call. */
	toolCallTitle: string;
	/** Available permission options. */
	options: PermissionOption[];
}

/**
 * Minimal configuration slice needed by the ACP client factory.
 */
export interface AgentAcpClientFactoryConfig {
	/** When `true`, permission requests are auto-approved. */
	autoApprove: boolean;

	/**
	 * Async callback invoked when `autoApprove` is `false` to let the
	 * consumer decide whether to grant the permission.
	 *
	 * Return `true` to approve, `false` to deny.
	 * If not provided and `autoApprove` is `false`, permissions are denied.
	 */
	onApproveRequest?: (request: ApproveRequestInfo) => Promise<boolean>;
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
 *   - **tracer** — for OpenTelemetry span management (using `wrap()` and tracked spans)
 *   - **emitEvent** — for typed event emission
 *   - **terminalManager** — for terminal lifecycle management
 *   - **config** — for permission auto-approve behavior
 *
 * ### Instrumentation Pattern
 *
 * Handlers use the private `logAndEmit` helper to combine logging and
 * event emission into a single call, eliminating the repeated
 * `logger.info(…) + emitEvent(…)` two-liner that previously appeared
 * in every handler. Tracing is handled via `tracer.wrap()` for scoped
 * spans (permissions, FS ops) and `tracer.startTracked()` for long-lived
 * spans (terminals).
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
		private readonly agentName: string,
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
	 * Formats a span name with the agent name suffix.
	 */
	private spanName(name: SpanName): string {
		return `${name}:${this.agentName}`;
	}

	/**
	 * Starts an `agent.terminal` span as a tracked span.
	 *
	 * The span is activated for log correlation during creation, then
	 * deactivated (via the caller) since terminals run in the background.
	 * Args are stored as a native string array (OTel supports `string[]` natively).
	 */
	private traceTerminalStart(
		terminalId: string,
		command: string,
		args?: string[],
		cwd?: string,
	): void {
		const span = this.tracer.startTracked(
			terminalId,
			this.spanName(SpanName.AGENT_TERMINAL),
			{
				"terminal.id": terminalId,
				"terminal.command": command,
				...(cwd && { "terminal.cwd": cwd }),
			},
			"terminal",
		);

		if (args && args.length > 0) {
			span.setAttribute("terminal.args", args);
		}
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

		return this.tracer.wrap(
			this.spanName(SpanName.AGENT_PERMISSION),
			{
				"permission.tool_call_id": params.toolCall.toolCallId,
				...(toolCallTitle && {
					"permission.tool_call_title": toolCallTitle,
				}),
			},
			async (permSpan) => {
				this.logAndEmit(
					AgentEvent.PERMISSION_REQUESTED,
					{
						toolCallId: params.toolCall.toolCallId,
						toolCallTitle,
						options: params.options,
					},
					`Permission needed: ${toolCallTitle}`,
				);

				// Find the first "allow" option — needed for both auto and manual approval
				const allowOption = params.options.find(
					(o: PermissionOption) =>
						o.kind === "allow_always" || o.kind === "allow_once",
				);

				// ── Auto-approve path ──────────────────────────────────────────
				if (this.config.autoApprove) {
					if (allowOption) {
						this.logAndEmit(
							AgentEvent.PERMISSION_GRANTED,
							{
								toolCallId: params.toolCall.toolCallId,
								optionId: allowOption.optionId,
								optionName: allowOption.name,
							},
							`Permission granted (auto): ${allowOption.name}`,
						);

						permSpan.setAttribute("permission.outcome", "granted");
						permSpan.setAttribute("permission.option_id", allowOption.optionId);
						permSpan.setAttribute("permission.option_name", allowOption.name);

						return {
							outcome: {
								outcome: "selected" as const,
								optionId: allowOption.optionId,
							},
						};
					}

					// Auto-approve enabled but no allow option exists
					const reason = "No allow option available";
					this.logger.warn(
						{ toolCallId: params.toolCall.toolCallId },
						`Permission denied: ${reason}`,
					);
					this.emitEvent(AgentEvent.PERMISSION_DENIED, {
						toolCallId: params.toolCall.toolCallId,
						reason,
					});

					permSpan.setAttribute("permission.outcome", "denied");
					permSpan.setAttribute("permission.denial_reason", reason);

					return { outcome: { outcome: "cancelled" as const } };
				}

				// ── Manual approval path (autoApprove === false) ───────────────
				if (allowOption && this.config.onApproveRequest) {
					const approved = await this.config.onApproveRequest({
						toolCallId: params.toolCall.toolCallId,
						toolCallTitle,
						options: params.options,
					});

					if (approved) {
						this.logAndEmit(
							AgentEvent.PERMISSION_GRANTED,
							{
								toolCallId: params.toolCall.toolCallId,
								optionId: allowOption.optionId,
								optionName: allowOption.name,
							},
							`Permission manually approved: ${allowOption.name}`,
						);

						permSpan.setAttribute("permission.outcome", "granted");
						permSpan.setAttribute("permission.option_id", allowOption.optionId);
						permSpan.setAttribute("permission.option_name", allowOption.name);

						return {
							outcome: {
								outcome: "selected" as const,
								optionId: allowOption.optionId,
							},
						};
					}
				}

				// No approval callback, no allow option, or user denied
				const denialReason = !allowOption
					? "No allow option available"
					: !this.config.onApproveRequest
						? "Auto-approve disabled and no approval handler registered"
						: "User denied permission";

				this.logger.warn(
					{ toolCallId: params.toolCall.toolCallId },
					`Permission denied: ${denialReason}`,
				);

				this.emitEvent(AgentEvent.PERMISSION_DENIED, {
					toolCallId: params.toolCall.toolCallId,
					reason: denialReason,
				});

				permSpan.setAttribute("permission.outcome", "denied");
				permSpan.setAttribute("permission.denial_reason", denialReason);

				return { outcome: { outcome: "cancelled" as const } };
			},
		);
	}

	private async handleWriteTextFile(
		params: WriteTextFileRequest,
	): Promise<WriteTextFileResponse> {
		this.logAndEmit(
			AgentEvent.FS_WRITE,
			{ path: params.path, contentLength: params.content.length },
			`FS write: ${params.path}`,
		);

		return this.tracer.wrap(
			this.spanName(SpanName.AGENT_FS_WRITE),
			{
				"fs.path": params.path,
				"fs.operation": "write",
				"fs.content_length": params.content.length,
			},
			async (span) => {
				const { writeFile, mkdir } = await import("node:fs/promises");
				const { dirname } = await import("node:path");

				await mkdir(dirname(params.path), { recursive: true });
				await writeFile(params.path, params.content, "utf-8");

				span.setAttribute("fs.content_length", params.content.length);
				this.logger.debug({ path: params.path }, "FS write complete");
				return {};
			},
		);
	}

	private async handleReadTextFile(
		params: ReadTextFileRequest,
	): Promise<ReadTextFileResponse> {
		this.logger.info({ path: params.path }, `FS read: ${params.path}`);

		return this.tracer.wrap(
			this.spanName(SpanName.AGENT_FS_READ),
			{
				"fs.path": params.path,
				"fs.operation": "read",
			},
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
		);
	}

	private async handleCreateTerminal(
		params: CreateTerminalRequest,
	): Promise<CreateTerminalResponse> {
		const terminal = this.terminalManager.create(params);

		// Start a tracked terminal span. It's activated for log correlation
		// during creation, then deactivated since the terminal runs in the
		// background. The span stays tracked until the terminal exits.
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

		// Deactivate the terminal span from the context stack after creation
		// logging. The span stays tracked (open) until the terminal exits,
		// but subsequent logs should not inherit the terminal's SpanId.
		this.tracer.deactivateTracked(terminal.terminalId);

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
