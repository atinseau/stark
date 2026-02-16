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
import type {
	AgentEventMap,
	BaseAgentEvent,
} from "../../types/events.types.ts";
import type { EmitEventFn } from "../../types/observability.types.ts";
import type { TerminalManager } from "../terminal-manager/terminal-manager.ts";
import type { Tracer } from "../tracer/tracer.ts";
import { endPermission, startPermission } from "./tracer-helpers/permission.ts";
import { startTerminal } from "./tracer-helpers/terminal.ts";

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
 * in every handler. Tracing is handled via external helper functions
 * from `./tracer-helpers/` or via `tracer.traced()`.
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

		// Tracing: start permission span (via helper)
		const permSpan = startPermission(this.tracer, {
			toolCallId: params.toolCall.toolCallId,
			toolCallTitle,
		});

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
				endPermission(permSpan, "granted", {
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
		endPermission(permSpan, "denied", { reason: denialReason });

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

		// Tracing: start terminal span (tracked internally by terminalId via helper)
		startTerminal(this.tracer, {
			terminalId: terminal.terminalId,
			command: terminal.command,
			args: terminal.args,
			cwd: terminal.cwd,
		});

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
