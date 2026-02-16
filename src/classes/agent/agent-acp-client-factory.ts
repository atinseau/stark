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
import type { TerminalManager } from "../terminal-manager/terminal-manager.ts";
import type { AgentTracer } from "./agent-tracer.ts";

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Callback signature used by the factory to emit typed agent events.
 * Matches the `emitTyped` pattern from the Agent class.
 */
export type EmitEventFn = <K extends AgentEvent>(
	event: K,
	payload: Omit<AgentEventMap[K], keyof BaseAgentEvent>,
) => void;

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
		private readonly tracer: AgentTracer,
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

	// ── Private Handlers ───────────────────────────────────────────────────

	private async handlePermission(
		params: RequestPermissionRequest,
	): Promise<RequestPermissionResponse> {
		const toolCallTitle = params.toolCall.title ?? params.toolCall.toolCallId;

		// Tracing: start permission span
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

		this.emitEvent(AgentEvent.PERMISSION_REQUESTED, {
			toolCallId: params.toolCall.toolCallId,
			toolCallTitle,
			options: params.options,
		});

		if (this.config.autoApprove) {
			// Find the first "allow" option
			const allowOption = params.options.find(
				(o: PermissionOption) =>
					o.kind === "allow_always" || o.kind === "allow_once",
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

				this.emitEvent(AgentEvent.PERMISSION_GRANTED, {
					toolCallId: params.toolCall.toolCallId,
					optionId: allowOption.optionId,
					optionName: allowOption.name,
				});

				// Tracing: end permission span (granted)
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

		this.emitEvent(AgentEvent.PERMISSION_DENIED, {
			toolCallId: params.toolCall.toolCallId,
			reason: denialReason,
		});

		// Tracing: end permission span (denied)
		this.tracer.endPermission(permSpan, "denied", { reason: denialReason });

		return { outcome: { outcome: "cancelled" as const } };
	}

	private async handleWriteTextFile(
		params: WriteTextFileRequest,
	): Promise<WriteTextFileResponse> {
		// Tracing: start fs.write span
		const fsSpan = this.tracer.startFs({
			path: params.path,
			operation: "write",
			contentLength: params.content.length,
		});

		this.logger.info(
			{ path: params.path, contentLength: params.content.length },
			`FS write: ${params.path}`,
		);

		this.emitEvent(AgentEvent.FS_WRITE, {
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
			this.tracer.endFs(
				fsSpan,
				undefined,
				err instanceof Error ? err : new Error(String(err)),
			);
			throw err;
		}
	}

	private async handleReadTextFile(
		params: ReadTextFileRequest,
	): Promise<ReadTextFileResponse> {
		// Tracing: start fs.read span
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

			this.emitEvent(AgentEvent.FS_READ, {
				path: params.path,
				contentLength: content.length,
			});

			this.tracer.endFs(fsSpan, content.length);
			return { content };
		} catch (err) {
			this.tracer.endFs(
				fsSpan,
				undefined,
				err instanceof Error ? err : new Error(String(err)),
			);
			throw err;
		}
	}

	private async handleCreateTerminal(
		params: CreateTerminalRequest,
	): Promise<CreateTerminalResponse> {
		const terminal = this.terminalManager.create(params);

		// Tracing: start terminal span
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

		this.emitEvent(AgentEvent.TERMINAL_CREATED, {
			terminalId: terminal.terminalId,
			command: terminal.command,
			args: terminal.args,
			cwd: terminal.cwd,
		});

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
