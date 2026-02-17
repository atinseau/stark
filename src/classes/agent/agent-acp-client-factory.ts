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
 *   - **emitEvent** — for typed event emission
 *   - **terminalManager** — for terminal lifecycle management
 *   - **config** — for permission auto-approve behavior
 *
 * ### Instrumentation Pattern
 *
 * Handlers use the private `logAndEmit` helper to combine logging and
 * event emission into a single call, eliminating the repeated
 * `logger.info(…) + emitEvent(…)` two-liner that previously appeared
 * in every handler.
 *
 * @example
 * ```ts
 * const factory = new AgentAcpClientFactory(logger, emitEvent, terminalManager, config, agentName);
 * const client = factory.build(onSessionUpdate);
 * const connection = new acp.ClientSideConnection((_agent) => client, stream);
 * ```
 */
export class AgentAcpClientFactory {
	constructor(
		private readonly logger: pino.Logger,
		private readonly emitEvent: EmitEventFn,
		private readonly terminalManager: TerminalManager,
		private readonly config: AgentAcpClientFactoryConfig,
		readonly _agentName: string,
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

		const { writeFile, mkdir } = await import("node:fs/promises");
		const { dirname } = await import("node:path");

		await mkdir(dirname(params.path), { recursive: true });
		await writeFile(params.path, params.content, "utf-8");

		this.logger.debug({ path: params.path }, "FS write complete");
		return {};
	}

	private async handleReadTextFile(
		params: ReadTextFileRequest,
	): Promise<ReadTextFileResponse> {
		this.logger.info({ path: params.path }, `FS read: ${params.path}`);

		const { readFile } = await import("node:fs/promises");
		const content = await readFile(params.path, "utf-8");

		this.logAndEmit(
			AgentEvent.FS_READ,
			{ path: params.path, contentLength: content.length },
			"FS read complete",
		);

		return { content };
	}

	private async handleCreateTerminal(
		params: CreateTerminalRequest,
	): Promise<CreateTerminalResponse> {
		const terminal = this.terminalManager.create(params);

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
