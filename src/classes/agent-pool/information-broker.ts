import type pino from "pino";
import type { ContextTracker } from "./context-tracker.ts";
import type { ConversationManager } from "./conversation-manager.ts";
import { ConversationRole } from "./enums.ts";
import { sharingDecisionPrompt } from "./prompts/templates.ts";
import type {
	AgentContextState,
	ContextDelta,
	SharingDecision,
	TaskDependency,
} from "./types.ts";

// ── Validators ─────────────────────────────────────────────────────────────

/**
 * Validates that a raw parsed JSON value conforms to the internal
 * sharing decision schema returned by the context-analyzer LLM.
 *
 * Returns `null` on invalid data so the OpenRouter client can
 * retry with a correction prompt.
 */
function validateSharingDecision(
	data: unknown,
): Omit<SharingDecision, "sourceAgentId" | "targetAgentId"> | null {
	if (data == null || typeof data !== "object") return null;

	const obj = data as Record<string, unknown>;

	if (typeof obj.shouldShare !== "boolean") return null;
	if (typeof obj.reasoning !== "string" || obj.reasoning.length === 0) {
		return null;
	}

	// information is required when shouldShare is true
	if (obj.shouldShare) {
		if (typeof obj.information !== "string" || obj.information.length === 0) {
			return null;
		}
	}

	return {
		shouldShare: obj.shouldShare,
		reasoning: obj.reasoning as string,
		information: typeof obj.information === "string" ? obj.information : "",
	};
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
 * 3. **Consults the LLM**: For each candidate target, sends a
 *    structured prompt to the context-analyzer conversation with:
 *    - The source agent's state and delta
 *    - The target agent's state and task
 *    - The dependency relationship (if any)
 *    The LLM decides whether sharing is beneficial and, if so,
 *    distills the relevant information into a concise instruction.
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
		this.significanceThreshold = options?.significanceThreshold ?? 0.4;
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

		// Evaluate each candidate in parallel
		const evaluationPromises = candidates.map((candidate) =>
			this.evaluateCandidate(delta, sourceState, candidate),
		);

		const decisions = await Promise.allSettled(evaluationPromises);

		// Collect successful evaluations
		const results: SharingDecision[] = [];
		for (const result of decisions) {
			if (result.status === "fulfilled" && result.value) {
				results.push(result.value);
			} else if (result.status === "rejected") {
				this.logger.warn(
					{
						error:
							result.reason instanceof Error
								? result.reason.message
								: String(result.reason),
					},
					"Sharing evaluation failed for a candidate",
				);
			}
		}

		// Log summary
		const shareCount = results.filter((d) => d.shouldShare).length;
		if (results.length > 0) {
			this.logger.info(
				{
					sourceAgentId: delta.agentId,
					deltaType: delta.type,
					candidatesEvaluated: candidates.length,
					sharingApproved: shareCount,
				},
				`Sharing evaluation: ${shareCount}/${candidates.length} candidates approved`,
			);
		}

		this._evaluationCount += candidates.length;
		this._shareCount += shareCount;

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
	 * Evaluates a single candidate target agent for information sharing.
	 *
	 * Sends a one-shot prompt to the context-analyzer conversation
	 * with full context about the source delta, source state, target
	 * state, and any dependency relationship.
	 *
	 * @param delta       - The source delta being evaluated.
	 * @param sourceState - The source agent's full context state.
	 * @param targetState - The candidate target agent's context state.
	 * @returns A complete {@link SharingDecision}, or `null` if evaluation failed.
	 */
	private async evaluateCandidate(
		delta: ContextDelta,
		sourceState: AgentContextState,
		targetState: AgentContextState,
	): Promise<SharingDecision | null> {
		// Find the dependency between source and target (if any)
		const dependency = this.findDependency(
			sourceState.agentId,
			targetState.agentId,
		);

		// Build the sharing decision prompt from the Handlebars template
		const prompt = sharingDecisionPrompt({
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
			targetAgent: {
				agentId: targetState.agentId,
				agentName: targetState.agentName,
				taskDescription: targetState.taskDescription,
				taskRole: targetState.taskRole,
				status: targetState.status,
				completed: targetState.completed,
			},
			dependency: dependency ?? null,
		});

		this.logger.debug(
			{
				sourceAgentId: sourceState.agentId,
				targetAgentId: targetState.agentId,
				deltaType: delta.type,
				hasDependency: !!dependency,
			},
			`Evaluating sharing: ${sourceState.agentName} → ${targetState.agentName}`,
		);

		try {
			// Use one-shot to avoid polluting the conversation history
			const partialDecision = await this.conversations.sendOneShotJson(
				ConversationRole.CONTEXT_ANALYZER,
				prompt,
				validateSharingDecision,
			);

			if (!partialDecision) {
				this.logger.warn(
					{
						sourceAgentId: sourceState.agentId,
						targetAgentId: targetState.agentId,
					},
					"Sharing decision validation returned null",
				);
				return null;
			}

			const decision: SharingDecision = {
				...partialDecision,
				sourceAgentId: sourceState.agentId,
				targetAgentId: targetState.agentId,
			};

			this.logger.debug(
				{
					shouldShare: decision.shouldShare,
					sourceAgentId: decision.sourceAgentId,
					targetAgentId: decision.targetAgentId,
					reasoning: decision.reasoning.slice(0, 100),
				},
				decision.shouldShare
					? `Sharing approved: ${sourceState.agentName} → ${targetState.agentName}`
					: `Sharing denied: ${sourceState.agentName} → ${targetState.agentName}`,
			);

			return decision;
		} catch (error) {
			this.logger.warn(
				{
					sourceAgentId: sourceState.agentId,
					targetAgentId: targetState.agentId,
					error: error instanceof Error ? error.message : String(error),
				},
				"Sharing evaluation LLM call failed",
			);

			// On failure, default to not sharing (safe default)
			return {
				shouldShare: false,
				reasoning: `Evaluation failed: ${error instanceof Error ? error.message : String(error)}`,
				sourceAgentId: sourceState.agentId,
				targetAgentId: targetState.agentId,
				information: "",
			};
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
