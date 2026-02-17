import { AgentEvent } from "../../enums/agent-event.enum.ts";
import { AgentStatus } from "../../enums/agent-status.enum.ts";
import { DeltaType } from "../../enums/delta-type.enum.ts";
import type { PromptResult } from "../../types/agent.types.ts";
import type {
	AgentContextState,
	ContextDelta,
	ContextEvent,
	SubTask,
} from "../../types/agent-pool.types.ts";
import { isoNow } from "../../utils/formatting.ts";

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Maps raw agent event types to delta types and significance scores.
 *
 * Events not listed here are either ignored (too noisy) or handled
 * by dedicated logic in the tracker (e.g. prompt completion).
 */
const EVENT_SIGNIFICANCE: ReadonlyMap<
	string,
	{ deltaType: DeltaType; significance: number }
> = new Map([
	[
		AgentEvent.PROMPT_COMPLETE,
		{ deltaType: DeltaType.PROMPT_COMPLETE, significance: 0.8 },
	],
	[
		AgentEvent.TOOL_COMPLETE,
		{ deltaType: DeltaType.TOOL_COMPLETE, significance: 0.5 },
	],
	[
		AgentEvent.TOOL_FAILED,
		{ deltaType: DeltaType.TOOL_FAILED, significance: 0.9 },
	],
	[
		AgentEvent.AGENT_ERROR,
		{ deltaType: DeltaType.AGENT_ERROR, significance: 1.0 },
	],
	[
		AgentEvent.AGENT_IDLE,
		{ deltaType: DeltaType.STATUS_CHANGE, significance: 0.3 },
	],
	[
		AgentEvent.AGENT_BUSY,
		{ deltaType: DeltaType.STATUS_CHANGE, significance: 0.1 },
	],
	[
		AgentEvent.PLAN_UPDATE,
		{ deltaType: DeltaType.PLAN_UPDATE, significance: 0.6 },
	],
	[
		AgentEvent.FS_WRITE,
		{ deltaType: DeltaType.FILE_WRITTEN, significance: 0.5 },
	],
	[AgentEvent.FS_READ, { deltaType: DeltaType.FILE_READ, significance: 0.2 }],
]);

/**
 * Maximum number of context events retained per agent.
 *
 * Older events beyond this limit are discarded to prevent unbounded
 * memory growth in long-running executions. Only the most recent
 * events are kept since the context analyzer focuses on deltas.
 */
const MAX_EVENTS_PER_AGENT = 200;

/**
 * Maximum length of the response preview in delta data.
 * Responses longer than this are summarized in `promptResultSummary`.
 */
const PROMPT_RESULT_PREVIEW_LENGTH = 2000;

// ── ContextTracker ─────────────────────────────────────────────────────────

/**
 * Tracks the contextual state of every managed agent and computes
 * meaningful deltas from raw agent events.
 *
 * The tracker maintains a {@link AgentContextState} for each agent,
 * updated incrementally as events arrive. When a significant event
 * occurs, a {@link ContextDelta} is computed and returned to the
 * caller (typically the AgentPool orchestrator) for further analysis.
 *
 * ## Delta Computation
 *
 * Not every agent event produces a delta. Low-significance events
 * (e.g. prompt chunks, terminal output, permission grants) are
 * recorded in the event history but do not trigger delta computation.
 * This pre-filtering reduces the number of LLM analysis calls while
 * still capturing enough detail for cross-agent information sharing.
 *
 * Each delta carries a `significance` score (0.0–1.0) derived from
 * the event type. The context analyzer may later reassess this score
 * based on semantic analysis of the delta's content and the overall
 * task state.
 *
 * ## Event Summarization
 *
 * Raw agent events carry domain-specific payloads (tool call IDs,
 * exit codes, file paths, etc.). The tracker distills these into
 * human-readable summaries suitable for LLM consumption, reducing
 * token overhead in downstream analysis prompts.
 *
 * @example
 * ```ts
 * const tracker = new ContextTracker();
 *
 * tracker.registerAgent("agent-1", "Agent Alpha", subtask);
 *
 * const delta = tracker.processEvent("agent-1", AgentEvent.TOOL_COMPLETE, {
 *   toolCallId: "tc-1",
 *   title: "Write file",
 *   output: "Created src/index.ts",
 * });
 *
 * if (delta) {
 *   // Feed to context analyzer for semantic analysis
 *   await contextAnalyzer.analyze(delta);
 * }
 * ```
 */
export class ContextTracker {
	/** Per-agent context state, keyed by agent ID. */
	private readonly agents = new Map<string, AgentContextState>();

	// ── Registration ───────────────────────────────────────────────────

	/**
	 * Registers a new agent for context tracking.
	 *
	 * Must be called before any events for this agent are processed.
	 * Creates a fresh {@link AgentContextState} with the given subtask
	 * metadata.
	 *
	 * @param agentId   - The agent's unique identifier.
	 * @param agentName - The agent's human-friendly name.
	 * @param subtask   - The subtask assigned to this agent.
	 */
	registerAgent(agentId: string, agentName: string, subtask: SubTask): void {
		this.agents.set(agentId, {
			agentId,
			agentName,
			taskDescription: subtask.prompt,
			taskRole: subtask.role,
			status: AgentStatus.INITIALIZING,
			events: [],
			promptResults: [],
			lastDelta: null,
			filesWritten: [],
			filesRead: [],
			completed: false,
			error: null,
		});
	}

	/**
	 * Removes an agent from tracking.
	 *
	 * @param agentId - The agent to unregister.
	 */
	unregisterAgent(agentId: string): void {
		this.agents.delete(agentId);
	}

	// ── Event Processing ───────────────────────────────────────────────

	/**
	 * Processes a raw agent event and optionally returns a context delta.
	 *
	 * The method:
	 * 1. Records the event in the agent's context state
	 * 2. Updates derived state (status, files, completion, errors)
	 * 3. Computes a delta if the event is significant enough
	 *
	 * @param agentId - The agent that emitted the event.
	 * @param event   - The event type discriminator.
	 * @param payload - The event payload data.
	 * @returns A {@link ContextDelta} if the event is significant, or `null`.
	 */
	processEvent(
		agentId: string,
		event: string,
		payload: Record<string, unknown>,
	): ContextDelta | null {
		const state = this.agents.get(agentId);
		if (!state) return null;

		// Build a summarized context event
		const contextEvent = this.buildContextEvent(event, payload);
		state.events.push(contextEvent);

		// Enforce event history limit
		if (state.events.length > MAX_EVENTS_PER_AGENT) {
			state.events = state.events.slice(-MAX_EVENTS_PER_AGENT);
		}

		// Update derived state from the event
		this.updateDerivedState(state, event, payload);

		// Check if this event type warrants a delta
		const mapping = EVENT_SIGNIFICANCE.get(event);
		if (!mapping) return null;

		let promptResultSummary: string | null = null;
		if (
			event === AgentEvent.PROMPT_COMPLETE &&
			typeof payload.fullText === "string"
		) {
			const fullText = payload.fullText;
			if (fullText.length > PROMPT_RESULT_PREVIEW_LENGTH) {
				promptResultSummary = this.buildPromptResultSummary(fullText);
			}
		}

		// Build the delta
		const delta: ContextDelta = {
			agentId: state.agentId,
			agentName: state.agentName,
			timestamp: contextEvent.timestamp,
			type: mapping.deltaType,
			summary: contextEvent.summary,
			data: contextEvent.data,
			significance: mapping.significance,
			promptResultSummary,
		};

		state.lastDelta = delta;
		return delta;
	}

	/**
	 * Records a completed prompt result in the agent's context state.
	 *
	 * This is called separately from event processing because the
	 * `PromptResult` is returned by `agent.prompt()`, not emitted
	 * as an event.
	 *
	 * @param agentId - The agent that completed the prompt.
	 * @param result  - The prompt result to record.
	 */
	recordPromptResult(agentId: string, result: PromptResult): void {
		const state = this.agents.get(agentId);
		if (!state) return;

		state.promptResults.push(result);
	}

	/**
	 * Marks an agent as completed.
	 *
	 * @param agentId - The agent that completed its subtask.
	 */
	markCompleted(agentId: string): void {
		const state = this.agents.get(agentId);
		if (!state) return;

		state.completed = true;
		state.status = AgentStatus.IDLE;
	}

	/**
	 * Marks an agent as failed with an error message.
	 *
	 * @param agentId - The agent that failed.
	 * @param error   - The error description.
	 */
	markFailed(agentId: string, error: string): void {
		const state = this.agents.get(agentId);
		if (!state) return;

		state.completed = true;
		state.error = error;
		state.status = AgentStatus.ERROR;
	}

	/**
	 * Marks an agent as timed out.
	 *
	 * Similar to `markFailed()` but records the timeout specifically
	 * so it can be distinguished from other failures in logs and events.
	 *
	 * @param agentId - The agent that timed out.
	 * @param timeoutMs - The timeout duration that was exceeded.
	 * @param elapsedMs - The actual elapsed time before timeout was triggered.
	 */
	markTimedOut(agentId: string, timeoutMs: number, elapsedMs: number): void {
		const state = this.agents.get(agentId);
		if (!state) return;

		state.completed = true;
		state.error = `Timed out after ${elapsedMs}ms (limit: ${timeoutMs}ms)`;
		state.status = AgentStatus.ERROR;
	}

	// ── Query ──────────────────────────────────────────────────────────

	/**
	 * Returns the current context state of a specific agent.
	 *
	 * @param agentId - The agent to query.
	 * @returns The agent's context state, or `undefined` if not tracked.
	 */
	getAgentState(agentId: string): AgentContextState | undefined {
		return this.agents.get(agentId);
	}

	/**
	 * Returns the context states of all tracked agents.
	 *
	 * @returns An array of all agent context states.
	 */
	getAllAgentStates(): AgentContextState[] {
		return Array.from(this.agents.values());
	}

	/**
	 * Returns the context states of all agents *except* the specified one.
	 *
	 * Useful for cross-agent analysis: provides the "other agents" context
	 * without including the agent being analyzed.
	 *
	 * @param excludeAgentId - The agent ID to exclude.
	 * @returns Context states of all other agents.
	 */
	getOtherAgentStates(excludeAgentId: string): AgentContextState[] {
		const result: AgentContextState[] = [];
		for (const [id, state] of this.agents) {
			if (id !== excludeAgentId) {
				result.push(state);
			}
		}
		return result;
	}

	/**
	 * Returns the number of agents currently being tracked.
	 */
	get agentCount(): number {
		return this.agents.size;
	}

	/**
	 * Returns the total number of deltas that have been computed
	 * across all tracked agents.
	 */
	get totalDeltaCount(): number {
		let count = 0;
		for (const state of this.agents.values()) {
			// Count events that had significance mappings (proxy for deltas)
			for (const event of state.events) {
				if (EVENT_SIGNIFICANCE.has(event.type)) {
					count++;
				}
			}
		}
		return count;
	}

	/**
	 * Returns whether all tracked agents have completed their subtasks.
	 */
	get allCompleted(): boolean {
		if (this.agents.size === 0) return true;
		for (const state of this.agents.values()) {
			if (!state.completed) return false;
		}
		return true;
	}

	/**
	 * Returns a compact summary of the current global state,
	 * suitable for inclusion in LLM prompts.
	 */
	getGlobalSummary(): string {
		const states = this.getAllAgentStates();
		if (states.length === 0) return "No agents are currently active.";

		const lines: string[] = [];
		for (const state of states) {
			const status = state.completed
				? state.error
					? `❌ Failed: ${state.error}`
					: "✅ Completed"
				: `⚙️ ${state.status}`;

			lines.push(
				`- ${state.agentName} (${state.taskRole}): ${status}` +
					(state.filesWritten.length > 0
						? ` | Files: ${state.filesWritten.join(", ")}`
						: "") +
					(state.promptResults.length > 0
						? ` | Prompts: ${state.promptResults.length}`
						: ""),
			);
		}

		return lines.join("\n");
	}

	// ── Private ────────────────────────────────────────────────────────

	/**
	 * Builds a summarized context event from a raw agent event.
	 *
	 * Translates domain-specific payloads into human-readable summaries
	 * and extracts only the fields relevant for context analysis.
	 */
	private buildContextEvent(
		event: string,
		payload: Record<string, unknown>,
	): ContextEvent {
		const timestamp =
			typeof payload.timestamp === "string" ? payload.timestamp : isoNow();

		return {
			type: event,
			timestamp,
			summary: this.summarizeEvent(event, payload),
			data: this.extractRelevantData(event, payload),
		};
	}

	/**
	 * Produces a human-readable one-line summary of an agent event.
	 *
	 * These summaries are consumed by the context analyzer LLM, so
	 * they prioritize clarity and information density over brevity.
	 */
	private summarizeEvent(
		event: string,
		payload: Record<string, unknown>,
	): string {
		switch (event) {
			case AgentEvent.PROMPT_COMPLETE: {
				const stopReason = payload.stopReason as string | undefined;
				const textLength =
					typeof payload.fullText === "string" ? payload.fullText.length : 0;
				return `Prompt completed (${stopReason ?? "unknown"}), response: ${textLength} chars`;
			}

			case AgentEvent.TOOL_START: {
				const title = payload.title as string | undefined;
				const command = payload.command as string | undefined;
				return command
					? `Tool started: ${title} → $ ${command}`
					: `Tool started: ${title ?? "unknown"}`;
			}

			case AgentEvent.TOOL_COMPLETE: {
				const title = payload.title as string | undefined;
				const exitCode = payload.exitCode as number | undefined;
				const exitLabel = exitCode !== undefined ? ` (exit ${exitCode})` : "";
				return `Tool completed: ${title ?? "unknown"}${exitLabel}`;
			}

			case AgentEvent.TOOL_FAILED: {
				const title = payload.title as string | undefined;
				const output = payload.output as string | undefined;
				const preview = output ? `: ${output.slice(0, 100)}` : "";
				return `Tool failed: ${title ?? "unknown"}${preview}`;
			}

			case AgentEvent.AGENT_ERROR: {
				const error = payload.error;
				const message =
					error instanceof Error
						? error.message
						: typeof error === "string"
							? error
							: "unknown error";
				const context = payload.context as string | undefined;
				return `Agent error during ${context ?? "operation"}: ${message}`;
			}

			case AgentEvent.AGENT_IDLE: {
				const prev = payload.previousStatus as string | undefined;
				return `Agent became idle (was: ${prev ?? "unknown"})`;
			}

			case AgentEvent.AGENT_BUSY: {
				const promptText = payload.promptText as string | undefined;
				const preview = promptText ? promptText.slice(0, 80) : "unknown";
				return `Agent is busy processing: ${preview}`;
			}

			case AgentEvent.PLAN_UPDATE: {
				const entries = payload.entries as unknown[];
				return `Execution plan updated: ${entries?.length ?? 0} entries`;
			}

			case AgentEvent.FS_WRITE: {
				const path = payload.path as string | undefined;
				const contentLength = payload.contentLength as number | undefined;
				return `File written: ${path ?? "unknown"} (${contentLength ?? 0} chars)`;
			}

			case AgentEvent.FS_READ: {
				const path = payload.path as string | undefined;
				return `File read: ${path ?? "unknown"}`;
			}

			case AgentEvent.AGENT_READY: {
				const sessionId = payload.sessionId as string | undefined;
				return `Agent ready, session: ${sessionId ?? "unknown"}`;
			}

			case AgentEvent.AGENT_DESTROYED: {
				return "Agent destroyed";
			}

			case AgentEvent.USAGE_UPDATE: {
				const pct = payload.contextPercent as number | undefined;
				const used = payload.contextUsed as number | undefined;
				const size = payload.contextSize as number | undefined;
				return `Token usage: ${pct ?? 0}% (${used ?? 0}/${size ?? 0})`;
			}

			default:
				return `Event: ${event}`;
		}
	}

	/**
	 * Extracts only the fields from an event payload that are relevant
	 * for context analysis, reducing token overhead in downstream prompts.
	 *
	 * Large fields (full text responses, raw tool output) are truncated
	 * to keep the data manageable.
	 */
	private extractRelevantData(
		event: string,
		payload: Record<string, unknown>,
	): Record<string, unknown> {
		switch (event) {
			case AgentEvent.PROMPT_COMPLETE: {
				const fullText =
					typeof payload.fullText === "string" ? payload.fullText : "";
				return {
					stopReason: payload.stopReason,
					responsePreview:
						typeof payload.fullText === "string"
							? payload.fullText.slice(0, PROMPT_RESULT_PREVIEW_LENGTH)
							: undefined,
					responseLength: fullText.length,
					usage: payload.usage,
					isComplete:
						fullText.length > 0 &&
						fullText.length <= PROMPT_RESULT_PREVIEW_LENGTH,
				};
			}

			case AgentEvent.TOOL_START:
				return {
					toolCallId: payload.toolCallId,
					title: payload.title,
					kind: payload.kind,
					command: payload.command,
				};

			case AgentEvent.TOOL_COMPLETE:
				return {
					toolCallId: payload.toolCallId,
					title: payload.title,
					command: payload.command,
					exitCode: payload.exitCode,
					outputPreview:
						typeof payload.output === "string"
							? payload.output.slice(0, 300)
							: undefined,
				};

			case AgentEvent.TOOL_FAILED:
				return {
					toolCallId: payload.toolCallId,
					title: payload.title,
					command: payload.command,
					exitCode: payload.exitCode,
					output:
						typeof payload.output === "string"
							? payload.output.slice(0, 500)
							: undefined,
				};

			case AgentEvent.AGENT_ERROR:
				return {
					error:
						payload.error instanceof Error
							? payload.error.message
							: String(payload.error ?? "unknown"),
					context: payload.context,
				};

			case AgentEvent.PLAN_UPDATE:
				return {
					entries: payload.entries,
				};

			case AgentEvent.FS_WRITE:
				return {
					path: payload.path,
					contentLength: payload.contentLength,
				};

			case AgentEvent.FS_READ:
				return {
					path: payload.path,
					contentLength: payload.contentLength,
				};

			case AgentEvent.USAGE_UPDATE:
				return {
					contextPercent: payload.contextPercent,
					contextUsed: payload.contextUsed,
					contextSize: payload.contextSize,
					cost: payload.cost,
				};

			default:
				return {};
		}
	}

	/**
	 * Builds a structured summary of a long prompt result.
	 *
	 * Uses heuristic extraction (no LLM call) to identify key elements:
	 * - File paths mentioned
	 * - The start and end of the response (bookends)
	 *
	 * This is intentionally fast and imperfect — the goal is to provide
	 * enough context for the sharing LLM to make informed decisions,
	 * not to produce a polished summary.
	 *
	 * @param fullText - The complete agent response text.
	 * @returns A structured summary string, limited to ~1500 chars.
	 */
	private buildPromptResultSummary(fullText: string): string {
		const MAX_SUMMARY_LENGTH = 1500;
		const sections: string[] = [];

		const filePaths = this.extractFilePaths(fullText);
		if (filePaths.length > 0) {
			sections.push(`Files: ${filePaths.slice(0, 10).join(", ")}`);
		}

		const intro = fullText.slice(0, 500).trim();
		const outro = fullText.slice(-500).trim();

		sections.push(`Start: ${intro}`);
		if (fullText.length > 1000) {
			sections.push(`End: ${outro}`);
		}

		sections.push(`Total response: ${fullText.length} chars`);

		const summary = sections.join("\n\n");
		return summary.length > MAX_SUMMARY_LENGTH
			? `${summary.slice(0, MAX_SUMMARY_LENGTH)}…`
			: summary;
	}

	/**
	 * Extracts file paths from agent response text.
	 * Looks for common patterns like `src/foo/bar.ts`, `./config.json`, etc.
	 */
	private extractFilePaths(text: string): string[] {
		const pathPattern =
			/(?:\.\/|src\/|lib\/|app\/|tests?\/|config\/|public\/|docs?\/|scripts?\/)\S+\.\w{1,10}/g;
		const matches = text.match(pathPattern) ?? [];
		return [...new Set(matches)].slice(0, 15);
	}

	/**
	 * Updates derived state fields based on a processed event.
	 *
	 * This method maintains aggregate state (file lists, status, errors)
	 * that would be expensive to recompute from the full event history.
	 */
	private updateDerivedState(
		state: AgentContextState,
		event: string,
		payload: Record<string, unknown>,
	): void {
		switch (event) {
			case AgentEvent.AGENT_READY:
				state.status = AgentStatus.IDLE;
				break;

			case AgentEvent.AGENT_BUSY:
				state.status = AgentStatus.BUSY;
				break;

			case AgentEvent.AGENT_IDLE:
				state.status = AgentStatus.IDLE;
				break;

			case AgentEvent.AGENT_ERROR:
				state.status = AgentStatus.ERROR;
				if (payload.error instanceof Error) {
					state.error = payload.error.message;
				} else if (typeof payload.error === "string") {
					state.error = payload.error;
				}
				break;

			case AgentEvent.AGENT_DESTROYED:
				state.status = AgentStatus.DESTROYED;
				break;

			case AgentEvent.FS_WRITE: {
				const path = payload.path;
				if (typeof path === "string" && !state.filesWritten.includes(path)) {
					state.filesWritten.push(path);
				}
				break;
			}

			case AgentEvent.FS_READ: {
				const path = payload.path;
				if (typeof path === "string" && !state.filesRead.includes(path)) {
					state.filesRead.push(path);
				}
				break;
			}
		}
	}
}
