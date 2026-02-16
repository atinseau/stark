import type { Cost, SessionUpdate } from "@agentclientprotocol/sdk";
import { SpanStatusCode } from "@opentelemetry/api";
import type pino from "pino";

import { AgentEvent } from "../../enums/agent-event.enum.ts";
import { SessionUpdateType } from "../../enums/session-update-type.enum.ts";
import type { EmitEventFn } from "../../types/observability.types.ts";
import { truncate } from "../../utils/formatting.ts";
import {
	parseExitCode,
	parseToolCommand,
	parseToolOutput,
} from "../../utils/tool-parsing.ts";
import type { Tracer } from "../tracer/tracer.ts";

// ── Internal Types ─────────────────────────────────────────────────────────

/** Tracks in-flight tool calls for summary logging and events. */
export interface TrackedToolCall {
	title: string;
	kind?: string;
	status?: string;
	command?: string;
}

// ── Narrowed Update Types ──────────────────────────────────────────────────

/**
 * Type aliases that narrow `SessionUpdate` to a specific variant using
 * the raw string literal discriminant. We cannot use `SessionUpdateType`
 * enum members here because TypeScript treats them as nominal types that
 * don't match the SDK's string-literal discriminants in `Extract`.
 */
type AgentMessageChunkUpdate = Extract<
	SessionUpdate,
	{ sessionUpdate: "agent_message_chunk" }
>;
type AgentThoughtChunkUpdate = Extract<
	SessionUpdate,
	{ sessionUpdate: "agent_thought_chunk" }
>;
type UserMessageChunkUpdate = Extract<
	SessionUpdate,
	{ sessionUpdate: "user_message_chunk" }
>;
type ToolCallUpdate = Extract<SessionUpdate, { sessionUpdate: "tool_call" }>;
type ToolCallProgressUpdate = Extract<
	SessionUpdate,
	{ sessionUpdate: "tool_call_update" }
>;
type PlanUpdate = Extract<SessionUpdate, { sessionUpdate: "plan" }>;
type AvailableCommandsUpdate = Extract<
	SessionUpdate,
	{ sessionUpdate: "available_commands_update" }
>;
type CurrentModeUpdate = Extract<
	SessionUpdate,
	{ sessionUpdate: "current_mode_update" }
>;
type ConfigOptionUpdate = Extract<
	SessionUpdate,
	{ sessionUpdate: "config_option_update" }
>;
type SessionInfoUpdate = Extract<
	SessionUpdate,
	{ sessionUpdate: "session_info_update" }
>;
type UsageUpdate = Extract<SessionUpdate, { sessionUpdate: "usage_update" }>;

// ── AgentSessionUpdateHandler ───────────────────────────────────────────────────

/**
 * Routes incoming ACP session updates to the appropriate logging,
 * tracing, and event-emission calls.
 *
 * This class extracts the large `handleSessionUpdate()` switch statement
 * and the in-flight tool call tracking map from the Agent, giving them
 * a focused, independently testable home.
 *
 * It owns:
 *   - The `trackedToolCalls` map (keyed by tool call ID)
 *   - The accumulated `responseText` for the current prompt turn
 *
 * It does **not** own the logger, tracer, or event bus — those are injected
 * via the constructor so the Agent can share them across all components.
 *
 * Each update type is handled by a dedicated private method, and the
 * discriminator values are centralised in the {@link SessionUpdateType} enum.
 *
 * Tracing is performed via private methods (`traceToolCallStart`,
 * `traceToolCallUpdate`, `traceToolCallEnd`, `traceUsageUpdate`) that
 * operate on the generic `Tracer` API (`startOperation`,
 * `trackSpan`, etc.), keeping the handler decoupled from tracer internals.
 *
 * @example
 * ```ts
 * const handler = new AgentSessionUpdateHandler(logger, tracer, emitEvent);
 *
 * // Feed ACP updates into the handler:
 * handler.handle(update);
 *
 * // Read accumulated response text after the prompt completes:
 * const text = handler.responseText;
 * handler.resetResponseText();
 * ```
 */
export class AgentSessionUpdateHandler {
	/** Tracks in-flight tool calls by ID. */
	private readonly toolCalls = new Map<string, TrackedToolCall>();

	/** Accumulated text from the current prompt turn. */
	private _responseText = "";

	constructor(
		private readonly logger: pino.Logger,
		private readonly tracer: Tracer,
		private readonly emitEvent: EmitEventFn,
	) {}

	// ── Response Text ────────────────────────────────────────────────────

	/** Returns the accumulated response text for the current prompt turn. */
	get responseText(): string {
		return this._responseText;
	}

	/** Resets the response text accumulator (call at the start of each prompt). */
	resetResponseText(): void {
		this._responseText = "";
	}

	// ── Main Router ──────────────────────────────────────────────────────

	/**
	 * Routes a single ACP session update to the appropriate private handler,
	 * producing logs, trace events, and typed agent events.
	 *
	 * The switch uses {@link SessionUpdateType} enum members for readability.
	 * Each case delegates to a dedicated private method typed with a narrowed
	 * `SessionUpdate` variant (via `as` assertions — safe because the
	 * discriminant has already been matched).
	 */
	handle(update: SessionUpdate): void {
		switch (update.sessionUpdate) {
			case SessionUpdateType.AGENT_MESSAGE_CHUNK:
				this.handleAgentMessageChunk(update as AgentMessageChunkUpdate);
				break;

			case SessionUpdateType.AGENT_THOUGHT_CHUNK:
				this.handleAgentThoughtChunk(update as AgentThoughtChunkUpdate);
				break;

			case SessionUpdateType.USER_MESSAGE_CHUNK:
				this.handleUserMessageChunk(update as UserMessageChunkUpdate);
				break;

			case SessionUpdateType.TOOL_CALL:
				this.handleToolCall(update as ToolCallUpdate);
				break;

			case SessionUpdateType.TOOL_CALL_UPDATE:
				this.handleToolCallUpdate(update as ToolCallProgressUpdate);
				break;

			case SessionUpdateType.PLAN:
				this.handlePlan(update as PlanUpdate);
				break;

			case SessionUpdateType.AVAILABLE_COMMANDS_UPDATE:
				this.handleAvailableCommandsUpdate(update as AvailableCommandsUpdate);
				break;

			case SessionUpdateType.CURRENT_MODE_UPDATE:
				this.handleCurrentModeUpdate(update as CurrentModeUpdate);
				break;

			case SessionUpdateType.CONFIG_OPTION_UPDATE:
				this.handleConfigOptionUpdate(update as ConfigOptionUpdate);
				break;

			case SessionUpdateType.SESSION_INFO_UPDATE:
				this.handleSessionInfoUpdate(update as SessionInfoUpdate);
				break;

			case SessionUpdateType.USAGE_UPDATE:
				this.handleUsageUpdate(update as UsageUpdate);
				break;

			default:
				this.logger.warn({ update }, "Unhandled session update type");
				break;
		}
	}

	// ── Private Handlers ─────────────────────────────────────────────────

	/** Accumulates agent response text and emits a chunk event. */
	private handleAgentMessageChunk(update: AgentMessageChunkUpdate): void {
		if (update.content.type === "text") {
			this._responseText += update.content.text;
			this.emitEvent(AgentEvent.PROMPT_CHUNK, {
				text: update.content.text,
			});
		}
	}

	/** Logs agent reasoning and emits a thought event. */
	private handleAgentThoughtChunk(update: AgentThoughtChunkUpdate): void {
		if (update.content.type === "text") {
			this.logger.debug(
				{ thought: truncate(update.content.text, 200) },
				"Agent thinking",
			);
			this.emitEvent(AgentEvent.PROMPT_THOUGHT, {
				text: update.content.text,
			});
		}
	}

	/** Logs the echoed user message at trace level (no event emitted). */
	private handleUserMessageChunk(update: UserMessageChunkUpdate): void {
		if (update.content.type === "text") {
			this.logger.trace({ text: update.content.text }, "User message echo");
		}
	}

	/** Registers a new tool call, starts a tracer span, and emits a start event. */
	private handleToolCall(update: ToolCallUpdate): void {
		const command = parseToolCommand(update.rawInput);

		this.toolCalls.set(update.toolCallId, {
			title: update.title,
			kind: update.kind ?? undefined,
			status: update.status ?? undefined,
			command,
		});

		this.traceToolCallStart(
			update.toolCallId,
			update.title,
			update.kind ?? undefined,
			command,
		);

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

		this.emitEvent(AgentEvent.TOOL_START, {
			toolCallId: update.toolCallId,
			title: update.title,
			kind: update.kind ?? undefined,
			locations: update.locations ?? undefined,
			command,
			rawInput: update.rawInput,
		});
	}

	/**
	 * Updates tracked tool call state, manages tracer spans, and emits
	 * update / complete / failed events depending on the status.
	 */
	private handleToolCallUpdate(update: ToolCallProgressUpdate): void {
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

		// Log FIRST while the tool call span is still in the context stack,
		// so the log line carries the tool call's SpanId (not the prompt's).
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

		// Tracing: update or end tool call span (after logging)
		if (update.status === "completed" || update.status === "failed") {
			this.traceToolCallEnd(
				update.toolCallId,
				update.status ?? undefined,
				exitCode,
			);
		} else {
			this.traceToolCallUpdate(
				update.toolCallId,
				update.status ?? undefined,
				output,
				exitCode,
			);
		}

		this.emitEvent(AgentEvent.TOOL_UPDATE, {
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
			this.emitEvent(AgentEvent.TOOL_COMPLETE, {
				toolCallId: update.toolCallId,
				title,
				command: existing?.command,
				output,
				exitCode,
			});
		} else if (update.status === "failed") {
			this.emitEvent(AgentEvent.TOOL_FAILED, {
				toolCallId: update.toolCallId,
				title,
				command: existing?.command,
				output,
				exitCode,
			});
		}
	}

	/** Logs each plan entry and emits a plan update event. */
	private handlePlan(update: PlanUpdate): void {
		this.logger.info({ entryCount: update.entries.length }, "Plan updated");

		for (const entry of update.entries) {
			this.logger.info(
				{ status: entry.status, priority: entry.priority },
				`  ${entry.status === "completed" ? "✅" : entry.status === "in_progress" ? "⚙️ " : "⏳"} [${entry.priority}] ${entry.content}`,
			);
		}

		this.emitEvent(AgentEvent.PLAN_UPDATE, {
			entries: update.entries,
		});
	}

	/** Logs available commands at debug level (no event emitted). */
	private handleAvailableCommandsUpdate(update: AvailableCommandsUpdate): void {
		this.logger.debug(
			{ commandCount: update.availableCommands.length },
			"Available commands updated",
		);
	}

	/** Logs the mode change and emits a mode change event. */
	private handleCurrentModeUpdate(update: CurrentModeUpdate): void {
		this.logger.info(
			{ modeId: update.currentModeId },
			`Mode changed: ${update.currentModeId}`,
		);
		this.emitEvent(AgentEvent.MODE_CHANGE, {
			modeId: update.currentModeId,
		});
	}

	/** Logs the config change and emits a config update event. */
	private handleConfigOptionUpdate(update: ConfigOptionUpdate): void {
		this.logger.debug("Config options updated");
		this.emitEvent(AgentEvent.CONFIG_UPDATE, {
			configOptions: update.configOptions,
		});
	}

	/** Logs session info changes at debug level (no event emitted). */
	private handleSessionInfoUpdate(update: SessionInfoUpdate): void {
		this.logger.debug({ title: update.title }, "Session info updated");
	}

	/** Computes usage percentage, records in the tracer, and emits a usage event. */
	private handleUsageUpdate(update: UsageUpdate): void {
		const percent =
			update.size > 0 ? Math.round((update.used / update.size) * 100) : 0;

		this.traceUsageUpdate(update.used, update.size, percent, update.cost);

		this.logger.info(
			{
				contextUsed: update.used,
				contextSize: update.size,
				contextPercent: percent,
				cost: update.cost,
			},
			`Usage: ${percent}% context (${update.used}/${update.size} tokens)`,
		);

		this.emitEvent(AgentEvent.USAGE_UPDATE, {
			contextSize: update.size,
			contextUsed: update.used,
			contextPercent: percent,
			cost: update.cost,
		});
	}

	// ── Private Tracing Helpers ──────────────────────────────────────────

	/**
	 * Starts an `agent.tool_call` span as a child of the current active span
	 * and tracks it by `toolCallId` so it can be ended later.
	 */
	private traceToolCallStart(
		toolCallId: string,
		title: string,
		kind?: string,
		command?: string,
	): void {
		const span = this.tracer.startOperation(
			"agent.tool_call",
			{
				"tool.call_id": toolCallId,
				"tool.title": title,
				...(kind && { "tool.kind": kind }),
				...(command && { "tool.command": command }),
			},
			"active",
		);

		this.tracer.trackSpan(toolCallId, span, "tool call");
		this.tracer.enterSpan(span);
	}

	/**
	 * Adds an update event to an active tool call span.
	 * No-op if the tool call ID is unknown or tracing is disabled.
	 */
	private traceToolCallUpdate(
		toolCallId: string,
		status?: string,
		output?: string,
		exitCode?: number,
	): void {
		const span = this.tracer.getTrackedSpan(toolCallId);
		if (!span || !span.isRecording()) return;

		const eventAttrs: Record<string, string | number> = {};
		if (status) eventAttrs.status = status;
		if (output) eventAttrs.output = output.slice(0, 1000);
		if (exitCode !== undefined) eventAttrs.exit_code = exitCode;

		span.addEvent("tool.update", eventAttrs);
	}

	/**
	 * Ends a tool call span, setting its status based on the outcome.
	 * No-op if the tool call ID is unknown or tracing is disabled.
	 */
	private traceToolCallEnd(
		toolCallId: string,
		status?: string,
		exitCode?: number,
	): void {
		const span = this.tracer.removeTrackedSpan(toolCallId);
		if (!span || !span.isRecording()) return;

		if (status) span.setAttribute("tool.status", status);
		if (exitCode !== undefined) span.setAttribute("tool.exit_code", exitCode);

		const failed =
			status === "failed" || (exitCode !== undefined && exitCode !== 0);

		span.setStatus(
			failed
				? {
						code: SpanStatusCode.ERROR,
						message: `Tool ${status ?? "failed"} (exit ${exitCode ?? "?"})`,
					}
				: { code: SpanStatusCode.OK },
		);

		this.tracer.leaveSpan(span);
		span.end();
	}

	/**
	 * Records a usage update as an event on the active span,
	 * including optional cost information.
	 */
	private traceUsageUpdate(
		used: number,
		size: number,
		percent: number,
		cost?: Cost | null,
	): void {
		const attrs: Record<string, string | number> = {
			"usage.context_used": used,
			"usage.context_size": size,
			"usage.context_percent": percent,
		};
		if (cost) {
			attrs["usage.cost_amount"] = cost.amount;
			attrs["usage.cost_currency"] = cost.currency;
		}
		this.tracer.recordEvent("active", "usage.update", attrs);
	}
}
