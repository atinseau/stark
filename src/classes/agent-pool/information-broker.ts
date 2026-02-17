import type pino from "pino";
import { ConversationRole } from "../../enums/conversation-role.enum.ts";
import type { DeltaType } from "../../enums/delta-type.enum.ts";
import { batchedSharingDecisionPrompt } from "../../prompts/index.ts";
import type {
	AgentContextState,
	ContextDelta,
	SharingDecision,
	SharingRecord,
	SignificanceContext,
	TaskDependency,
} from "../../types/agent-pool.types.ts";
import { toErrorMessage } from "../../utils/errors.ts";
import { isoNow } from "../../utils/formatting.ts";
import type { ContextTracker } from "./context-tracker.ts";
import type { ConversationManager } from "./conversation-manager.ts";

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Maximum number of target agents to evaluate in a single batched LLM call.
 * Prevents prompt saturation when many agents are active.
 * Candidates beyond this limit are evaluated in additional batched calls.
 */
const MAX_AGENT_EVALUATION_BUFFER_SIZE = 5;

/**
 * Nombre maximum d'enregistrements de partage conservés par agent cible.
 * Limite la croissance mémoire en ne gardant que les partages les plus récents.
 * Les plus anciens sont considérés comme suffisamment intégrés par l'agent.
 */
const MAX_SHARING_RECORDS_PER_TARGET = 20;

/**
 * Nombre maximum d'enregistrements inclus dans le prompt LLM pour le contexte.
 * Réduit la consommation de tokens tout en donnant au LLM assez de contexte
 * pour éviter les doublons.
 */
const MAX_SHARING_RECORDS_IN_PROMPT = 5;

// ── Dynamic Significance Threshold Constants ───────────────────────────────

/**
 * Base significance threshold — the starting point for dynamic computation.
 * Adjusted up or down based on contextual factors.
 */
const BASE_SIGNIFICANCE_THRESHOLD = 0.5;

/**
 * Absolute minimum threshold — never go below this to avoid
 * evaluating every trivial event (STATUS_CHANGE, FILE_READ, etc.).
 */
const MIN_SIGNIFICANCE_THRESHOLD = 0.2;

/**
 * Absolute maximum threshold — never go above this to ensure
 * critical events (AGENT_ERROR at 1.0) are always evaluated.
 */
const MAX_SIGNIFICANCE_THRESHOLD = 0.85;

/**
 * Threshold reduction for agents with blocking dependents.
 * These agents' output is critical — we evaluate more aggressively.
 */
const BLOCKING_DEPENDENT_REDUCTION = 0.2;

/**
 * Threshold reduction for agents with informational dependents.
 * Less aggressive than blocking, but still reduces the threshold.
 */
const INFORMATIONAL_DEPENDENT_REDUCTION = 0.1;

/**
 * Phase-based threshold adjustments.
 */
const PHASE_ADJUSTMENTS: Record<string, number> = {
	early: -0.1, // Lower threshold early — more exploration sharing
	mid: 0.0, // Normal threshold during active work
	late: 0.1, // Higher threshold late — only critical info
};

/**
 * Number of total deltas after which the "chatty execution" penalty kicks in.
 * Raises the threshold slightly to reduce LLM call volume.
 */
const CHATTY_EXECUTION_DELTA_THRESHOLD = 50;

/**
 * Threshold increase per 50 deltas beyond CHATTY_EXECUTION_DELTA_THRESHOLD.
 * Caps at MAX_CHATTY_PENALTY to prevent total suppression.
 */
const CHATTY_PENALTY_PER_BATCH = 0.05;
const MAX_CHATTY_PENALTY = 0.15;

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
 *   subtaskToAgent,   // ReadonlyMap<string, string>
 *   agentToSubtask,   // ReadonlyMap<string, string>
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
	 * The base threshold provided at construction time.
	 * Used as the starting point for dynamic computation.
	 */
	private readonly baseThreshold: number;

	/**
	 * The execution context used for dynamic threshold computation.
	 * Set by the pool orchestrator when the execution state changes.
	 * `null` means no context is available — falls back to the base threshold.
	 */
	private significanceContext: SignificanceContext | null = null;

	/** Running count of sharing evaluations performed. */
	private _evaluationCount = 0;

	/** Running count of positive sharing decisions. */
	private _shareCount = 0;

	/**
	 * Historique des partages effectués, indexé par agent cible.
	 *
	 * Structure : targetAgentId → SharingRecord[]
	 *
	 * L'indexation par target est choisie car la question de déduplication
	 * est toujours posée du point de vue du target : « cet agent a-t-il
	 * déjà reçu cette information ? »
	 */
	private readonly sharingHistory = new Map<string, SharingRecord[]>();

	constructor(
		private readonly conversations: ConversationManager,
		private readonly contextTracker: ContextTracker,
		private readonly dependencies: ReadonlyArray<TaskDependency>,
		private readonly logger: pino.Logger,
		private readonly subtaskToAgent: ReadonlyMap<string, string> = new Map(),
		private readonly agentToSubtask: ReadonlyMap<string, string> = new Map(),
		options?: {
			/** Override the base significance threshold (default: 0.5). */
			significanceThreshold?: number;
		},
	) {
		this.baseThreshold =
			options?.significanceThreshold ?? BASE_SIGNIFICANCE_THRESHOLD;
	}

	// ── Public API ─────────────────────────────────────────────────────

	/**
	 * Updates the execution context used for dynamic threshold computation.
	 *
	 * Called by the pool orchestrator whenever the execution state changes
	 * (agent completion, failure, new delta processed, etc.).
	 *
	 * @param context - The updated significance context.
	 */
	updateSignificanceContext(context: SignificanceContext): void {
		this.significanceContext = context;
	}

	/**
	 * Evaluates whether a context delta from one agent should be shared
	 * with any other active agents.
	 *
	 * Returns an array of {@link SharingDecision} objects — one per
	 * candidate target agent that was evaluated. The array may be empty
	 * if:
	 * - The delta's significance is below the dynamic threshold
	 * - There are no other active agents
	 * - The LLM determined that sharing is not beneficial for any target
	 *
	 * @param delta - The context delta to evaluate for sharing.
	 * @returns An array of sharing decisions (may be empty).
	 */
	async evaluate(delta: ContextDelta): Promise<SharingDecision[]> {
		// Pre-filter: skip low-significance deltas using dynamic threshold
		const effectiveThreshold = this.computeThreshold(delta);

		if (delta.significance < effectiveThreshold) {
			this.logger.debug(
				{
					agentId: delta.agentId,
					deltaType: delta.type,
					significance: delta.significance,
					threshold: effectiveThreshold,
					phase: this.significanceContext?.phase ?? "unknown",
				},
				`Delta below dynamic threshold (${delta.significance.toFixed(2)} < ${effectiveThreshold.toFixed(2)}), skipping`,
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

	/**
	 * Evaluates sharing for a completed prompt result with access to the full
	 * response text when blocking dependents exist.
	 *
	 * Falls back to the standard evaluation for non-blocking cases.
	 */
	async evaluateWithFullResult(
		delta: ContextDelta,
		fullResultText: string,
	): Promise<SharingDecision[]> {
		const sourceSubtaskId = this.agentToSubtask.get(delta.agentId);
		if (!sourceSubtaskId) {
			return this.evaluate(delta);
		}

		const hasBlockingDependents = this.dependencies.some(
			(dep) => dep.from === sourceSubtaskId && dep.type === "blocking",
		);

		if (!hasBlockingDependents) {
			return this.evaluate(delta);
		}

		const previewLimit = 5000;
		const enrichedDelta: ContextDelta = {
			...delta,
			data: {
				...delta.data,
				responsePreview: fullResultText.slice(0, previewLimit),
				responseLength: fullResultText.length,
				isComplete: fullResultText.length <= previewLimit,
			},
			promptResultSummary:
				delta.promptResultSummary ?? this.buildQuickSummary(fullResultText),
		};

		return this.evaluate(enrichedDelta);
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

	/** Nombre total de partages enregistrés dans l'historique. */
	get totalRecordedSharings(): number {
		let count = 0;
		for (const records of this.sharingHistory.values()) {
			count += records.length;
		}
		return count;
	}

	/**
	 * Enregistre un partage effectué pour la déduplication future.
	 *
	 * Appelé après qu'un partage a été approuvé ET injecté dans l'agent cible.
	 * Tronque l'information à un résumé court pour limiter l'usage mémoire
	 * et la taille des prompts futurs.
	 *
	 * @param decision - La décision de partage qui a été exécutée.
	 * @param deltaType - Le type de delta qui a déclenché le partage.
	 */
	recordSharing(decision: SharingDecision, deltaType: DeltaType): void {
		const record: SharingRecord = {
			timestamp: isoNow(),
			sourceAgentId: decision.sourceAgentId,
			targetAgentId: decision.targetAgentId,
			deltaType,
			informationSummary: decision.information.slice(0, 200),
		};

		let records = this.sharingHistory.get(decision.targetAgentId);
		if (!records) {
			records = [];
			this.sharingHistory.set(decision.targetAgentId, records);
		}
		records.push(record);

		// Enforce limit — supprimer les plus anciens
		if (records.length > MAX_SHARING_RECORDS_PER_TARGET) {
			records.splice(0, records.length - MAX_SHARING_RECORDS_PER_TARGET);
		}
	}

	/**
	 * Retourne les partages récents effectués vers un agent cible.
	 * Utilisé pour enrichir le prompt de décision de partage et permettre
	 * au LLM d'éviter les doublons.
	 *
	 * @param targetAgentId - L'agent cible.
	 * @param limit - Nombre maximum de records à retourner (défaut: MAX_SHARING_RECORDS_IN_PROMPT).
	 * @returns Les records les plus récents, du plus ancien au plus récent.
	 */
	getRecentSharingsForTarget(
		targetAgentId: string,
		limit: number = MAX_SHARING_RECORDS_IN_PROMPT,
	): readonly SharingRecord[] {
		const records = this.sharingHistory.get(targetAgentId);
		if (!records || records.length === 0) return [];

		// Retourner les N plus récents
		return records.slice(-limit);
	}

	/**
	 * Efface tout l'historique de partage.
	 * Appelé en fin d'exécution lors du cleanup.
	 */
	clearHistory(): void {
		this.sharingHistory.clear();
	}

	// ── Private ──────────────────────────────────────────────────────

	/**
	 * Computes the effective significance threshold for a given delta,
	 * taking into account the current execution context.
	 *
	 * The computation applies a series of adjustments to the base threshold:
	 *
	 * 1. **Phase adjustment**: Lower threshold in early execution (more exploration),
	 *    higher in late execution (only critical info).
	 *
	 * 2. **Dependency adjustment**: Lower threshold when the source agent has
	 *    blocking or informational dependents — their output is more valuable.
	 *    Computed internally from the broker's own dependency data.
	 *
	 * 3. **Chatty penalty**: Slightly raise threshold when the execution has
	 *    produced an unusually high number of deltas (reduces LLM call volume).
	 *
	 * 4. **Clamping**: The final threshold is clamped to [MIN, MAX] to prevent
	 *    extreme values.
	 *
	 * If no context is available, falls back to the base threshold.
	 *
	 * @param delta - The delta to compute the threshold for.
	 * @returns The effective significance threshold (0.0 to 1.0).
	 */
	private computeThreshold(delta: ContextDelta): number {
		if (!this.significanceContext) {
			return this.baseThreshold;
		}

		const ctx = this.significanceContext;
		let threshold = this.baseThreshold;

		// 1. Phase adjustment
		const phaseAdjustment = PHASE_ADJUSTMENTS[ctx.phase] ?? 0;
		threshold += phaseAdjustment;

		// 2. Dependency adjustment — compute from broker's own dependency data
		const sourceSubtaskId = this.agentToSubtask.get(delta.agentId);
		let hasBlockingDependents = false;
		let hasInformationalDependents = false;

		if (sourceSubtaskId) {
			for (const dep of this.dependencies) {
				if (dep.from === sourceSubtaskId) {
					if (dep.type === "blocking") hasBlockingDependents = true;
					if (dep.type === "informational") hasInformationalDependents = true;
				}
			}
		}

		if (hasBlockingDependents) {
			threshold -= BLOCKING_DEPENDENT_REDUCTION;
		} else if (hasInformationalDependents) {
			threshold -= INFORMATIONAL_DEPENDENT_REDUCTION;
		}

		// 3. Chatty execution penalty
		if (ctx.totalDeltasProcessed > CHATTY_EXECUTION_DELTA_THRESHOLD) {
			const excessBatches = Math.floor(
				(ctx.totalDeltasProcessed - CHATTY_EXECUTION_DELTA_THRESHOLD) / 50,
			);
			const chattyPenalty = Math.min(
				excessBatches * CHATTY_PENALTY_PER_BATCH,
				MAX_CHATTY_PENALTY,
			);
			threshold += chattyPenalty;
		}

		// 4. Clamp to valid range
		threshold = Math.max(
			MIN_SIGNIFICANCE_THRESHOLD,
			Math.min(MAX_SIGNIFICANCE_THRESHOLD, threshold),
		);

		// Log the computed threshold if it differs from base
		if (Math.abs(threshold - this.baseThreshold) > 0.01) {
			this.logger.debug(
				{
					baseThreshold: this.baseThreshold,
					effectiveThreshold: threshold,
					phase: ctx.phase,
					hasBlockingDeps: hasBlockingDependents,
					hasInfoDeps: hasInformationalDependents,
					totalDeltas: ctx.totalDeltasProcessed,
					deltaType: delta.type,
					deltaSignificance: delta.significance,
				},
				`Dynamic threshold: ${threshold.toFixed(2)} (base: ${this.baseThreshold})`,
			);
		}

		return threshold;
	}

	/**
	 * Builds a quick summary of a long text for sharing evaluation.
	 * Used as a fallback when promptResultSummary is not available.
	 */
	private buildQuickSummary(text: string): string {
		if (text.length <= 2000) return text;

		const intro = text.slice(0, 800);
		const outro = text.slice(-800);
		const omitted = text.length - 1600;

		return `${intro}\n\n[...${omitted} chars omitted...]\n\n${outro}`;
	}

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

		// Translate the source agent ID to its subtask ID
		const sourceSubtaskId = this.agentToSubtask.get(sourceAgentId);

		// Find the subtask IDs that depend on the source subtask
		const dependentSubtaskIds = new Set<string>();
		if (sourceSubtaskId) {
			for (const dep of this.dependencies) {
				if (dep.from === sourceSubtaskId) {
					dependentSubtaskIds.add(dep.to);
				}
			}
		}

		// Sort: agents whose subtask depends on the source come first
		return active.sort((a, b) => {
			const aDependent = this.isAgentDependentOnSource(
				a.agentId,
				dependentSubtaskIds,
			);
			const bDependent = this.isAgentDependentOnSource(
				b.agentId,
				dependentSubtaskIds,
			);

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
		// Check if this agent's subtask is in the set of dependent subtask IDs
		const agentSubtaskId = this.agentToSubtask.get(agentId);
		if (agentSubtaskId && dependentSubtaskIds.has(agentSubtaskId)) {
			return true;
		}

		// Fallback: check via isAgentForSubtask for each dependent subtask
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
	private isAgentForSubtask(agentId: string, subtaskId: string): boolean {
		// Check forward mapping: does this subtask ID map to the given agent ID?
		const mappedAgentId = this.subtaskToAgent.get(subtaskId);
		if (mappedAgentId === agentId) return true;

		// Check reverse mapping: does this agent ID map to the given subtask ID?
		const mappedSubtaskId = this.agentToSubtask.get(agentId);
		if (mappedSubtaskId === subtaskId) return true;

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

			// Récupérer l'historique de partage pour ce target (déduplication)
			const previouslyShared = this.getRecentSharingsForTarget(
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
				previouslyShared,
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
				promptResultSummary: delta.promptResultSummary ?? null,
				responseLength:
					typeof delta.data.responseLength === "number"
						? delta.data.responseLength
						: null,
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
			const effectiveMaxTokens = delta.promptResultSummary
				? 500 * targetStates.length
				: 300 * targetStates.length;

			// Use one-shot to avoid polluting the conversation history
			const batchDecisions = await this.conversations.sendOneShotJson(
				ConversationRole.SHARING_ANALYZER,
				prompt,
				validateBatchedSharingDecision,
				{ maxTokens: effectiveMaxTokens, maxJsonAttempts: 2 },
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
	/**
	 * Finds a dependency between two subtask IDs.
	 * Public method for use by the pool orchestrator when building
	 * structured injections.
	 *
	 * @param fromSubtaskId - The source subtask ID.
	 * @param toSubtaskId - The target subtask ID.
	 * @returns The dependency, or null if none exists.
	 */
	findDependencyBySubtaskIds(
		fromSubtaskId: string,
		toSubtaskId: string,
	): TaskDependency | null {
		return (
			this.dependencies.find(
				(dep) =>
					(dep.from === fromSubtaskId && dep.to === toSubtaskId) ||
					(dep.from === toSubtaskId && dep.to === fromSubtaskId),
			) ?? null
		);
	}

	private findDependency(
		sourceAgentId: string,
		targetAgentId: string,
	): TaskDependency | undefined {
		// Translate agent IDs to subtask IDs for dependency lookup
		const sourceSubtaskId = this.agentToSubtask.get(sourceAgentId);
		const targetSubtaskId = this.agentToSubtask.get(targetAgentId);

		if (!sourceSubtaskId || !targetSubtaskId) return undefined;

		return this.dependencies.find(
			(dep) =>
				(dep.from === sourceSubtaskId && dep.to === targetSubtaskId) ||
				// Also check reverse direction (target depends on source)
				(dep.from === targetSubtaskId && dep.to === sourceSubtaskId),
		);
	}
}
