import type pino from "pino";
import { ConversationRole } from "../../enums/conversation-role.enum.ts";
import { batchedSharingDecisionPrompt } from "../../prompts/index.ts";
import type {
	AgentContextState,
	ContextDelta,
	SharingDecision,
	TaskDependency,
} from "../../types/agent-pool.types.ts";
import { toErrorMessage } from "../../utils/errors.ts";
import type { ContextTracker } from "./context-tracker.ts";
import type { ConversationManager } from "./conversation-manager.ts";

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Maximum number of target agents to evaluate in a single batched LLM call.
 * Prevents prompt saturation when many agents are active.
 * Candidates beyond this limit are evaluated in additional batched calls.
 */
const MAX_AGENT_EVALUATION_BUFFER_SIZE = 5;

// ── Validators ─────────────────────────────────────────────────────────────

/**
 * Validates that a raw parsed JSON value conforms to the batched
 * sharing decision schema returned by the context-analyzer LLM.
 *
 * Expects an object with a `decisions` array where each element has:
 * - `targetAgentId`: non-empty string
 * - `shouldShare`: boolean
 * - `reasoning`: non-empty string
 * - `information`: non-empty string when `shouldShare` is true
 *
 * Returns `null` on invalid data so the OpenRouter client can
 * retry with a correction prompt.
 */
function validateBatchedSharingDecision(data: unknown): Array<{
	targetAgentId: string;
	shouldShare: boolean;
	reasoning: string;
	information: string;
}> | null {
	if (data == null || typeof data !== "object") return null;

	const obj = data as Record<string, unknown>;

	if (!Array.isArray(obj.decisions)) return null;

	const results: Array<{
		targetAgentId: string;
		shouldShare: boolean;
		reasoning: string;
		information: string;
	}> = [];

	for (const entry of obj.decisions) {
		if (entry == null || typeof entry !== "object") return null;

		const item = entry as Record<string, unknown>;

		if (
			typeof item.targetAgentId !== "string" ||
			item.targetAgentId.length === 0
		)
			return null;
		if (typeof item.shouldShare !== "boolean") return null;
		if (typeof item.reasoning !== "string" || item.reasoning.length === 0)
			return null;

		if (item.shouldShare) {
			if (typeof item.information !== "string" || item.information.length === 0)
				return null;
		}

		results.push({
			targetAgentId: item.targetAgentId as string,
			shouldShare: item.shouldShare,
			reasoning: item.reasoning as string,
			information: typeof item.information === "string" ? item.information : "",
		});
	}

	return results;
}

// ── InformationBroker ──────────────────────────────────────────────────────

/**
 * LLM-driven engine for conditional cross-agent information sharing.
 *
 * The broker is the sole authority on whether and what information
 * flows between agents. Agents themselves are completely unaware of
 * each other's existence — all coordination is emergent, piloted by
 * the broker's semantic analysis of context deltas.
 *
 * ## Decision Process
 *
 * When a context delta is detected from one agent, the broker:
 *
 * 1. **Identifies candidate targets**: Finds other agents that are
 *    still active (not completed or destroyed) and may benefit from
 *    the information.
 *
 * 2. **Evaluates dependencies**: Cross-references the delta against
 *    the task dependency graph to find agents with declared
 *    `blocking` or `informational` dependencies on the source.
 *
 * 3. **Consults the LLM**: Sends a batched prompt to the
 *    context-analyzer conversation with the source agent's state,
 *    delta, and all candidate targets in a single request. The LLM
 *    decides for each target whether sharing is beneficial and, if
 *    so, distills the relevant information into a concise instruction.
 *
 * 4. **Returns decisions**: Each `SharingDecision` includes:
 *    - Whether to share (`shouldShare`)
 *    - The LLM's reasoning
 *    - The distilled information to inject (if sharing)
 *    - Source and target agent IDs
 *
 * ## Non-Automatic Sharing
 *
 * Information sharing is **never** automatic. Even when an explicit
 * `blocking` dependency exists between two agents, the broker still
 * consults the LLM to determine:
 * - Whether the delta contains information relevant to the target
 * - How to distill and contextualize the information
 * - Whether the target is in a state where the information is useful
 *
 * This ensures sharing decisions are semantically meaningful, not
 * just structural.
 *
 * ## Significance Pre-filter
 *
 * To avoid excessive LLM calls, the broker applies a configurable
 * significance threshold. Deltas below this threshold are silently
 * skipped — only deltas that cross the threshold are evaluated
 * against candidate targets.
 *
 * ## Batched Evaluation
 *
 * To reduce the number of LLM calls, the broker evaluates multiple
 * candidate targets in a single batched prompt. The batch size is
 * controlled by {@link MAX_AGENT_EVALUATION_BUFFER_SIZE} to prevent
 * prompt saturation when many agents are active.
 *
 * ## Conversation Isolation
 *
 * Sharing decisions use one-shot prompts via the context-analyzer
 * conversation. This prevents the sharing evaluation context from
 * accumulating in the conversation history, keeping token usage
 * bounded regardless of how many deltas are processed.
 *
 * @example
 * ```ts
 * const broker = new InformationBroker(
 *   conversationManager,
 *   contextTracker,
 *   dependencies,
 *   logger,
 * );
 *
 * const delta = tracker.processEvent("agent-1", "prompt:complete", payload);
 * if (delta) {
 *   const decisions = await broker.evaluate(delta);
 *   for (const decision of decisions) {
 *     if (decision.shouldShare) {
 *       agent.injectContext(decision.information);
 *     }
 *   }
 * }
 * ```
 */
export class InformationBroker {
	/**
	 * Minimum delta significance required to trigger sharing evaluation.
	 *
	 * Deltas below this threshold are silently ignored, reducing the
	 * number of LLM calls for low-value events (file reads, status
	 * transitions, etc.).
	 */
	private readonly significanceThreshold: number;

	/** Running count of sharing evaluations performed. */
	private _evaluationCount = 0;

	/** Running count of positive sharing decisions. */
	private _shareCount = 0;

	constructor(
		private readonly conversations: ConversationManager,
		private readonly contextTracker: ContextTracker,
		private readonly dependencies: ReadonlyArray<TaskDependency>,
		private readonly logger: pino.Logger,
		options?: {
			/** Override the significance threshold (default: 0.4). */
			significanceThreshold?: number;
		},
	) {
		this.significanceThreshold = options?.significanceThreshold ?? 0.6;
	}

	// ── Public API ─────────────────────────────────────────────────────

	/**
	 * Evaluates whether a context delta from one agent should be shared
	 * with any other active agents.
	 *
	 * Returns an array of {@link SharingDecision} objects — one per
	 * candidate target agent that was evaluated. The array may be empty
	 * if:
	 * - The delta's significance is below the threshold
	 * - There are no other active agents
	 * - The LLM determined that sharing is not beneficial for any target
	 *
	 * @param delta - The context delta to evaluate for sharing.
	 * @returns An array of sharing decisions (may be empty).
	 */
	async evaluate(delta: ContextDelta): Promise<SharingDecision[]> {
		// Pre-filter: skip low-significance deltas
		if (delta.significance < this.significanceThreshold) {
			this.logger.debug(
				{
					agentId: delta.agentId,
					deltaType: delta.type,
					significance: delta.significance,
					threshold: this.significanceThreshold,
				},
				"Delta below significance threshold, skipping sharing evaluation",
			);
			return [];
		}

		// Find candidate target agents
		const candidates = this.findCandidateTargets(delta.agentId);

		if (candidates.length === 0) {
			this.logger.debug(
				{ agentId: delta.agentId },
				"No candidate target agents for sharing evaluation",
			);
			return [];
		}

		// Get the source agent's state
		const sourceState = this.contextTracker.getAgentState(delta.agentId);
		if (!sourceState) {
			this.logger.warn(
				{ agentId: delta.agentId },
				"Source agent not found in context tracker",
			);
			return [];
		}

		// Evaluate candidates in batches to avoid prompt saturation
		const results: SharingDecision[] = [];

		for (
			let i = 0;
			i < candidates.length;
			i += MAX_AGENT_EVALUATION_BUFFER_SIZE
		) {
			const batch = candidates.slice(i, i + MAX_AGENT_EVALUATION_BUFFER_SIZE);
			const batchResults = await this.evaluateBatch(delta, sourceState, batch);
			results.push(...batchResults);
		}

		return results;
	}

	// ── Statistics ────────────────────────────────────────────────────

	/** Total number of individual sharing evaluations performed. */
	get evaluationCount(): number {
		return this._evaluationCount;
	}

	/** Total number of positive sharing decisions. */
	get shareCount(): number {
		return this._shareCount;
	}

	// ── Private ──────────────────────────────────────────────────────

	/**
	 * Finds all agents that are potential targets for information sharing.
	 *
	 * A candidate target must:
	 * 1. Not be the source agent itself
	 * 2. Not be completed (already finished its subtask)
	 * 3. Not be in DESTROYED status
	 *
	 * Candidates are sorted by relevance:
	 * - Agents with declared dependencies on the source come first
	 * - Then agents without dependencies, ordered by priority
	 */
	private findCandidateTargets(sourceAgentId: string): AgentContextState[] {
		const others = this.contextTracker.getOtherAgentStates(sourceAgentId);

		// Filter to active agents only
		const active = others.filter(
			(state) => !state.completed && state.status !== "destroyed",
		);

		if (active.length === 0) return [];

		// Sort: agents with dependencies on source first
		const dependentIds = new Set<string>();
		for (const dep of this.dependencies) {
			if (
				dep.from === sourceAgentId ||
				this.isAgentForSubtask(sourceAgentId, dep.from)
			) {
				dependentIds.add(dep.to);
			}
		}

		return active.sort((a, b) => {
			const aDependent = this.isAgentDependentOnSource(a.agentId, dependentIds);
			const bDependent = this.isAgentDependentOnSource(b.agentId, dependentIds);

			if (aDependent && !bDependent) return -1;
			if (!aDependent && bDependent) return 1;
			return 0;
		});
	}

	/**
	 * Checks if an agent is a target of any dependency that lists
	 * the source agent as the `from` side.
	 */
	private isAgentDependentOnSource(
		agentId: string,
		dependentSubtaskIds: Set<string>,
	): boolean {
		// The dependentSubtaskIds contains subtask IDs that depend on the source.
		// We need to check if this agent's task role or ID matches any of them.
		// Since we track agents by agent ID but dependencies use subtask IDs,
		// we use a mapping maintained during evaluate().
		for (const depId of dependentSubtaskIds) {
			if (this.isAgentForSubtask(agentId, depId)) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Checks if an agent ID corresponds to a given subtask ID.
	 *
	 * Since agents are assigned subtasks at spawn time, the mapping
	 * between agent IDs and subtask IDs is maintained by the pool
	 * orchestrator. This method uses the context tracker's state
	 * to find the match — the `taskRole` is used as a heuristic
	 * since the subtask ID is not directly stored in the context state.
	 *
	 * This is a best-effort heuristic. The dependency system uses
	 * subtask IDs, while the broker works with agent IDs. The pool
	 * can inject a proper mapping via the `agentSubtaskMap` if needed.
	 */
	private isAgentForSubtask(_agentId: string, _subtaskId: string): boolean {
		// Default implementation: the agent-to-subtask mapping is
		// handled externally by the pool. This method can be overridden
		// or augmented with a proper mapping.
		// For now, we always return false and let the LLM decide based
		// on semantic analysis rather than structural matching.
		return false;
	}

	/**
	 * Evaluates a batch of candidate target agents for information sharing
	 * in a single LLM call.
	 *
	 * Sends a one-shot prompt to the context-analyzer conversation
	 * with full context about the source delta, source state, and all
	 * target states in the batch, along with any dependency relationships.
	 *
	 * @param delta        - The source delta being evaluated.
	 * @param sourceState  - The source agent's full context state.
	 * @param targetStates - The candidate target agents' context states.
	 * @returns An array of {@link SharingDecision} for each target in the batch.
	 */
	private async evaluateBatch(
		delta: ContextDelta,
		sourceState: AgentContextState,
		targetStates: AgentContextState[],
	): Promise<SharingDecision[]> {
		// Build the targets array for the Handlebars template
		const targets = targetStates.map((targetState) => {
			const dependency = this.findDependency(
				sourceState.agentId,
				targetState.agentId,
			);

			return {
				agentId: targetState.agentId,
				agentName: targetState.agentName,
				taskDescription: targetState.taskDescription,
				taskRole: targetState.taskRole,
				status: targetState.status,
				completed: targetState.completed,
				dependency: dependency ?? null,
			};
		});

		// Build the batched sharing decision prompt from the Handlebars template
		const prompt = batchedSharingDecisionPrompt({
			sourceAgent: {
				agentId: sourceState.agentId,
				agentName: sourceState.agentName,
				taskDescription: sourceState.taskDescription,
				taskRole: sourceState.taskRole,
				status: sourceState.status,
			},
			delta: {
				type: delta.type,
				summary: delta.summary,
				data: delta.data,
			},
			targets,
		});

		this.logger.debug(
			{
				sourceAgentId: sourceState.agentId,
				targetCount: targetStates.length,
				deltaType: delta.type,
			},
			`Evaluating sharing batch: ${sourceState.agentName} → ${targetStates.length} target(s)`,
		);

		try {
			// Use one-shot to avoid polluting the conversation history
			const batchDecisions = await this.conversations.sendOneShotJson(
				ConversationRole.CONTEXT_ANALYZER,
				prompt,
				validateBatchedSharingDecision,
				{ maxTokens: 300 * targetStates.length, maxJsonAttempts: 2 },
			);

			// Map the results into SharingDecision[] with sourceAgentId
			const results: SharingDecision[] = batchDecisions.map((decision) => ({
				shouldShare: decision.shouldShare,
				reasoning: decision.reasoning,
				information: decision.information,
				sourceAgentId: sourceState.agentId,
				targetAgentId: decision.targetAgentId,
			}));

			// Log summary
			const shareCount = results.filter((d) => d.shouldShare).length;
			if (results.length > 0) {
				this.logger.info(
					{
						sourceAgentId: sourceState.agentId,
						deltaType: delta.type,
						candidatesEvaluated: targetStates.length,
						sharingApproved: shareCount,
					},
					`Sharing evaluation: ${shareCount}/${targetStates.length} candidates approved`,
				);
			}

			for (const decision of results) {
				this.logger.debug(
					{
						shouldShare: decision.shouldShare,
						sourceAgentId: decision.sourceAgentId,
						targetAgentId: decision.targetAgentId,
						reasoning: decision.reasoning.slice(0, 100),
					},
					decision.shouldShare
						? `Sharing approved: ${sourceState.agentName} → ${decision.targetAgentId}`
						: `Sharing denied: ${sourceState.agentName} → ${decision.targetAgentId}`,
				);
			}

			this._evaluationCount += targetStates.length;
			this._shareCount += shareCount;

			return results;
		} catch (error) {
			this.logger.warn(
				{
					sourceAgentId: sourceState.agentId,
					targetCount: targetStates.length,
					error: toErrorMessage(error),
				},
				"Batched sharing evaluation LLM call failed",
			);

			// On failure, default to not sharing for all targets (safe default)
			this._evaluationCount += targetStates.length;

			return targetStates.map((targetState) => ({
				shouldShare: false,
				reasoning: `Evaluation failed: ${toErrorMessage(error)}`,
				sourceAgentId: sourceState.agentId,
				targetAgentId: targetState.agentId,
				information: "",
			}));
		}
	}

	/**
	 * Finds a declared dependency between a source and target agent.
	 *
	 * Searches both the structural dependency graph (by subtask IDs)
	 * and falls back to direct agent ID matching.
	 *
	 * @returns The matching dependency, or `undefined` if none exists.
	 */
	private findDependency(
		sourceAgentId: string,
		targetAgentId: string,
	): TaskDependency | undefined {
		// Direct match on dependency from/to (may be subtask IDs or agent IDs
		// depending on how the pool maps them)
		return this.dependencies.find(
			(dep) =>
				(dep.from === sourceAgentId && dep.to === targetAgentId) ||
				// Also check reverse direction (target depends on source)
				(dep.from === targetAgentId && dep.to === sourceAgentId),
		);
	}
}
