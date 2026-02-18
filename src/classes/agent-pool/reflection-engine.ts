import type pino from "pino";
import { ConversationRole } from "../../enums/conversation-role.enum.ts";
import { reflectionPrompt } from "../../prompts/index.ts";
import type {
	AgentExecutionResult,
	CheckpointResult,
	ExecutionInsight,
	ExecutionReflection,
	OrchestratorAssessment,
	ReflectionConfig,
	TaskAnalysis,
} from "../../types/agent-pool.types.ts";
import { toErrorMessage } from "../../utils/errors.ts";
import { isoNow } from "../../utils/formatting.ts";
import type { ConversationManager } from "./conversation-manager.ts";

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_MAX_INSIGHTS = 30;
const DEFAULT_POSITIVE_PATTERN_THRESHOLD = 0.7;
const DEFAULT_MAX_INSIGHTS_IN_PROMPT = 8;
const DEFAULT_MIN_INSIGHT_CONFIDENCE = 0.6;

/**
 * Maximum number of sharing decisions included in the reflection prompt.
 */
const MAX_SHARING_DECISIONS_IN_PROMPT = 10;

/**
 * Maximum number of orchestrator assessments included in the reflection prompt.
 */
const MAX_ORCHESTRATOR_ASSESSMENTS_IN_PROMPT = 3;

/**
 * Maximum number of checkpoint results included in the reflection prompt.
 */
const MAX_CHECKPOINTS_IN_PROMPT = 5;

// ── Validator ──────────────────────────────────────────────────────────────

/**
 * Validates and narrows a raw LLM response into a structured reflection.
 *
 * Returns `null` if the response is malformed or missing required fields.
 * Clamps numeric values to their valid ranges.
 *
 * @internal Exported for testing only.
 */
export function validateReflectionResponse(data: unknown): {
	effectivenessScore: number;
	analysis: string;
	decompositionAssessment: string;
	sharingAssessment: string;
	insights: Array<{
		category: string;
		confidence: number;
		insight: string;
		applicableWhen: string;
		polarity: string;
	}>;
} | null {
	if (data == null || typeof data !== "object") return null;
	const obj = data as Record<string, unknown>;

	// effectivenessScore
	if (typeof obj.effectivenessScore !== "number") return null;

	// analysis
	if (typeof obj.analysis !== "string" || obj.analysis.length === 0)
		return null;

	// decompositionAssessment
	const validDecomp = [
		"optimal",
		"over-decomposed",
		"under-decomposed",
		"wrong-boundaries",
	];
	if (
		typeof obj.decompositionAssessment !== "string" ||
		!validDecomp.includes(obj.decompositionAssessment)
	)
		return null;

	// sharingAssessment
	const validSharing = [
		"optimal",
		"over-shared",
		"under-shared",
		"wrong-content",
	];
	if (
		typeof obj.sharingAssessment !== "string" ||
		!validSharing.includes(obj.sharingAssessment)
	)
		return null;

	// insights
	if (!Array.isArray(obj.insights)) return null;

	const validCategories = [
		"decomposition",
		"sharing",
		"coordination",
		"performance",
		"tooling",
	];
	const validPolarities = ["positive", "negative", "neutral"];

	const insights: Array<{
		category: string;
		confidence: number;
		insight: string;
		applicableWhen: string;
		polarity: string;
	}> = [];

	for (const raw of obj.insights) {
		if (raw == null || typeof raw !== "object") return null;
		const item = raw as Record<string, unknown>;

		if (
			typeof item.category !== "string" ||
			!validCategories.includes(item.category)
		)
			return null;
		if (typeof item.confidence !== "number") return null;
		if (typeof item.insight !== "string" || item.insight.length === 0)
			return null;
		if (
			typeof item.applicableWhen !== "string" ||
			item.applicableWhen.length === 0
		)
			return null;
		if (
			typeof item.polarity !== "string" ||
			!validPolarities.includes(item.polarity)
		)
			return null;

		insights.push({
			category: item.category,
			confidence: Math.max(0, Math.min(1, item.confidence)),
			insight: item.insight,
			applicableWhen: item.applicableWhen,
			polarity: item.polarity,
		});
	}

	return {
		effectivenessScore: Math.max(0, Math.min(1, obj.effectivenessScore)),
		analysis: obj.analysis as string,
		decompositionAssessment: obj.decompositionAssessment as string,
		sharingAssessment: obj.sharingAssessment as string,
		insights,
	};
}

// ── ReflectionEngine ───────────────────────────────────────────────────────

/**
 * Post-execution reflection engine that analyzes completed executions
 * and extracts reusable insights for future planning.
 *
 * ## Lifecycle
 *
 * 1. After each `execute()` completes (success or failure), the pool
 *    calls `reflect()` with the full execution data.
 * 2. The engine sends a one-shot prompt to the USER_INTERACTION
 *    conversation with all execution details.
 * 3. The LLM produces an `ExecutionReflection` with effectiveness
 *    scores and extracted `ExecutionInsight[]`.
 * 4. Insights are stored in-memory and survive across executions
 *    (but not across pool restarts).
 *
 * ## Insight persistence
 *
 * Insights are stored in a FIFO array with a configurable maximum
 * size. When the maximum is reached, the lowest-confidence insights
 * are evicted first. Insights with higher confidence are never
 * evicted in favor of lower-confidence ones.
 *
 * ## Insight injection
 *
 * The `getInsightsForPrompt()` method returns the most relevant
 * insights for a given task context, filtered by confidence threshold
 * and limited by token budget. These are injected into the planner
 * prompt to influence future planning.
 *
 * ## Interaction with PlannerMemory (évolution 13)
 *
 * The PlannerMemory captures factual execution data (strategy, roles,
 * outcome, files). The ReflectionEngine captures analytical data
 * (effectiveness, decomposition quality, coordination insights).
 * They are complementary:
 * - PlannerMemory tells the planner WHAT happened
 * - Insights tell the planner WHY it happened and WHAT to do differently
 */
export class ReflectionEngine {
	/** Resolved configuration with defaults. */
	private readonly config: Required<ReflectionConfig>;

	/** All stored insights, across executions. */
	private readonly insights: ExecutionInsight[] = [];

	/** All stored reflections, for debugging and analysis. */
	private readonly reflections: ExecutionReflection[] = [];

	/** Running count of reflections performed. */
	private _reflectionCount = 0;

	constructor(
		private readonly conversations: ConversationManager,
		private readonly logger: pino.Logger,
		config?: ReflectionConfig,
	) {
		this.config = {
			enabled: config?.enabled ?? true,
			maxInsights: config?.maxInsights ?? DEFAULT_MAX_INSIGHTS,
			positivePatternThreshold:
				config?.positivePatternThreshold ?? DEFAULT_POSITIVE_PATTERN_THRESHOLD,
			maxInsightsInPrompt:
				config?.maxInsightsInPrompt ?? DEFAULT_MAX_INSIGHTS_IN_PROMPT,
			minInsightConfidence:
				config?.minInsightConfidence ?? DEFAULT_MIN_INSIGHT_CONFIDENCE,
			reflectOnSingleAgent: config?.reflectOnSingleAgent ?? false,
		};
	}

	// ── Public API ─────────────────────────────────────────────────────

	/**
	 * Performs a post-execution reflection and extracts insights.
	 *
	 * Should be called after each execution completes (before cleanup
	 * of the broker, tracker, etc., so that stats are still available).
	 *
	 * @param params - All data about the completed execution.
	 * @returns The execution reflection, or `null` if reflection was skipped.
	 */
	async reflect(params: {
		task: string;
		analysis: TaskAnalysis;
		results: AgentExecutionResult[];
		durationMs: number;
		coordinationStats: {
			deltaCount: number;
			sharingEvaluationCount: number;
			sharingApprovedCount: number;
			notificationCount: number;
			replanCount?: number;
		};
		orchestratorAssessments?: OrchestratorAssessment[];
		checkpointResults?: CheckpointResult[];
		sharingDecisions?: Array<{
			decision: string;
			source: string;
			target: string;
			reasoning: string;
		}>;
	}): Promise<ExecutionReflection | null> {
		if (!this.config.enabled) return null;

		// Skip single-agent reflections unless configured
		if (
			params.analysis.strategy === "single" &&
			!this.config.reflectOnSingleAgent
		) {
			this.logger.debug("Skipping reflection for single-agent execution");
			return null;
		}

		this._reflectionCount++;

		// Build the reflection prompt data
		const subtasks = params.analysis.subtasks.map((s) => ({
			id: s.id,
			prompt: s.prompt,
			role: s.role,
			dependencies: s.dependencies,
			priority: s.priority,
		}));

		const agents = params.results.map((r) => ({
			agentName: r.agentName,
			role: r.subtask.role,
			success: r.success,
			error: r.error ?? null,
			responseLength: r.promptResult.text.length,
			filesWritten: r.filesWritten,
			eventCount: r.events.length,
			timedOut: r.timedOut,
			retryCount: r.retryCount,
			subtaskDurationMs: r.subtaskDurationMs,
		}));

		const sharingApprovalRate =
			params.coordinationStats.sharingEvaluationCount > 0
				? Math.round(
						(params.coordinationStats.sharingApprovedCount /
							params.coordinationStats.sharingEvaluationCount) *
							100,
					)
				: 0;

		const successCount = params.results.filter((r) => r.success).length;

		// Get existing insights for deduplication
		const existingInsights = this.getInsightsForPrompt();

		const prompt = reflectionPrompt({
			task: params.task,
			strategy: params.analysis.strategy,
			complexity: params.analysis.complexity,
			planningReasoning: params.analysis.reasoning,
			subtaskCount: params.analysis.subtasks.length,
			subtasks,
			agents,
			coordination: {
				...params.coordinationStats,
				sharingApprovalRate,
			},
			orchestratorAssessments: (params.orchestratorAssessments ?? []).slice(
				-MAX_ORCHESTRATOR_ASSESSMENTS_IN_PROMPT,
			),
			checkpoints: (params.checkpointResults ?? []).slice(
				-MAX_CHECKPOINTS_IN_PROMPT,
			),
			sharingDecisions: (params.sharingDecisions ?? []).slice(
				-MAX_SHARING_DECISIONS_IN_PROMPT,
			),
			durationMs: params.durationMs,
			successCount,
			totalAgents: params.results.length,
			existingInsights,
		});

		this.logger.info(
			{
				reflectionNumber: this._reflectionCount,
				strategy: params.analysis.strategy,
				agentCount: params.results.length,
				durationMs: params.durationMs,
			},
			`Post-execution reflection #${this._reflectionCount}`,
		);

		try {
			const rawResult = await this.conversations.sendOneShotJson(
				ConversationRole.USER_INTERACTION,
				prompt,
				validateReflectionResponse,
				{ maxTokens: 1200, maxJsonAttempts: 2 },
			);

			if (!rawResult) {
				this.logger.warn("Reflection LLM returned null response");
				return null;
			}

			// Build the full reflection
			const now = isoNow();
			const newInsights: ExecutionInsight[] = rawResult.insights.map(
				(i, idx) => ({
					id: `insight-${this._reflectionCount}-${idx}`,
					category: i.category as ExecutionInsight["category"],
					confidence: i.confidence,
					insight: i.insight,
					applicableWhen: i.applicableWhen,
					polarity: i.polarity as ExecutionInsight["polarity"],
					timestamp: now,
				}),
			);

			// Apply confidence penalty for low-effectiveness executions
			if (rawResult.effectivenessScore < this.config.positivePatternThreshold) {
				for (const insight of newInsights) {
					if (insight.polarity === "positive") {
						// Reduce confidence of "positive" insights from low-effectiveness executions
						(insight as { confidence: number }).confidence = Math.max(
							0.3,
							insight.confidence * 0.7,
						);
					}
				}
			}

			const reflection: ExecutionReflection = {
				task: params.task,
				strategy: params.analysis.strategy,
				effectivenessScore: rawResult.effectivenessScore,
				analysis: rawResult.analysis,
				decompositionAssessment:
					rawResult.decompositionAssessment as ExecutionReflection["decompositionAssessment"],
				sharingAssessment:
					rawResult.sharingAssessment as ExecutionReflection["sharingAssessment"],
				insights: newInsights,
				timestamp: now,
				executionDurationMs: params.durationMs,
			};

			// Store the reflection
			this.reflections.push(reflection);

			// Store the insights (with eviction)
			this.storeInsights(newInsights);

			this.logger.info(
				{
					effectivenessScore: reflection.effectivenessScore,
					decompositionAssessment: reflection.decompositionAssessment,
					sharingAssessment: reflection.sharingAssessment,
					insightCount: newInsights.length,
					totalStoredInsights: this.insights.length,
				},
				`Reflection complete: effectiveness=${reflection.effectivenessScore}, ` +
					`decomposition=${reflection.decompositionAssessment}, ` +
					`sharing=${reflection.sharingAssessment}, ${newInsights.length} insight(s)`,
			);

			return reflection;
		} catch (error) {
			this.logger.warn(
				{ error: toErrorMessage(error) },
				"Post-execution reflection failed (non-critical)",
			);
			return null;
		}
	}

	// ── Insight Retrieval ──────────────────────────────────────────────

	/**
	 * Returns insights suitable for injection into planner prompts.
	 *
	 * Filters by confidence threshold and limits by the configured
	 * maximum. Returns insights sorted by confidence (highest first)
	 * then by recency (newest first).
	 *
	 * @param _contextHint - Optional task description for future relevance filtering.
	 * @returns Array of insights for prompt injection.
	 */
	getInsightsForPrompt(_contextHint?: string): readonly ExecutionInsight[] {
		// Filter by confidence
		const eligible = this.insights.filter(
			(i) => i.confidence >= this.config.minInsightConfidence,
		);

		// Sort: highest confidence first, then newest first
		eligible.sort((a, b) => {
			const confDiff = b.confidence - a.confidence;
			if (Math.abs(confDiff) > 0.05) return confDiff;
			return b.timestamp.localeCompare(a.timestamp);
		});

		// Limit to configured max
		return eligible.slice(0, this.config.maxInsightsInPrompt);
	}

	/**
	 * Formats insights as a text section suitable for inclusion in
	 * a planner or other LLM prompt.
	 *
	 * Returns `null` if no eligible insights exist.
	 */
	getInsightsPromptSection(): string | null {
		const insights = this.getInsightsForPrompt();
		if (insights.length === 0) return null;

		const lines = [
			"## Lessons from previous executions",
			"The following insights were extracted from past execution reflections. Use them to inform your planning:",
			"",
		];

		for (const insight of insights) {
			const polarityIcon =
				insight.polarity === "positive"
					? "✅"
					: insight.polarity === "negative"
						? "⚠️"
						: "ℹ️";
			lines.push(`- ${polarityIcon} [${insight.category}] ${insight.insight}`);
			lines.push(
				`  _Applies when: ${insight.applicableWhen}_ (confidence: ${insight.confidence})`,
			);
		}

		return lines.join("\n");
	}

	// ── Statistics ─────────────────────────────────────────────────────

	/** Total number of reflections performed. */
	get reflectionCount(): number {
		return this._reflectionCount;
	}

	/** Total number of stored insights. */
	get insightCount(): number {
		return this.insights.length;
	}

	/** Whether reflections are enabled. */
	get isEnabled(): boolean {
		return this.config.enabled;
	}

	/**
	 * Returns the most recent reflection, or null.
	 */
	get lastReflection(): ExecutionReflection | null {
		return this.reflections[this.reflections.length - 1] ?? null;
	}

	/**
	 * Returns all stored insights (read-only copy).
	 */
	getAllInsights(): readonly ExecutionInsight[] {
		return [...this.insights];
	}

	/**
	 * Returns all stored reflections (read-only copy).
	 */
	getAllReflections(): readonly ExecutionReflection[] {
		return [...this.reflections];
	}

	// ── Lifecycle ──────────────────────────────────────────────────────

	/**
	 * Clears all stored insights and reflections.
	 *
	 * Called when the pool is destroyed. Insights do NOT survive
	 * pool destruction.
	 */
	clearAll(): void {
		const previousInsightCount = this.insights.length;
		const previousReflectionCount = this.reflections.length;

		this.insights.length = 0;
		this.reflections.length = 0;
		this._reflectionCount = 0;

		this.logger.debug(
			{ previousInsightCount, previousReflectionCount },
			"Reflection engine cleared",
		);
	}

	/**
	 * Clears stored reflections but KEEPS insights.
	 *
	 * Called between executions to free memory from detailed
	 * reflection data while preserving the distilled insights.
	 */
	clearReflections(): void {
		this.reflections.length = 0;
	}

	// ── Private ────────────────────────────────────────────────────────

	/**
	 * Stores new insights with eviction of the lowest-confidence when at capacity.
	 *
	 * Uses a quality-aware eviction strategy:
	 * 1. If at capacity, evict insights with the lowest confidence first
	 * 2. Never evict insights with higher confidence in favor of lower ones
	 * 3. Among equal-confidence insights, evict the oldest
	 */
	private storeInsights(newInsights: ExecutionInsight[]): void {
		for (const insight of newInsights) {
			if (this.insights.length >= this.config.maxInsights) {
				// Find the lowest-confidence insight to evict
				let evictIndex = 0;
				let lowestConfidence = this.insights[0]?.confidence ?? 0;

				for (let i = 1; i < this.insights.length; i++) {
					const existing = this.insights[i];
					if (!existing) continue;
					if (existing.confidence < lowestConfidence) {
						lowestConfidence = existing.confidence;
						evictIndex = i;
					}
				}

				// Only evict if the new insight has higher or equal confidence
				const evictCandidate = this.insights[evictIndex];
				if (evictCandidate && insight.confidence >= evictCandidate.confidence) {
					this.logger.debug(
						{
							evictedId: evictCandidate.id,
							evictedConfidence: evictCandidate.confidence,
							newConfidence: insight.confidence,
						},
						`Evicting insight ${evictCandidate.id} (conf=${evictCandidate.confidence}) ` +
							`for new insight (conf=${insight.confidence})`,
					);
					this.insights.splice(evictIndex, 1);
				} else {
					// New insight has lower confidence than everything stored — skip it
					this.logger.debug(
						{
							insightConfidence: insight.confidence,
							minStoredConfidence: lowestConfidence,
						},
						"Skipping insight — lower confidence than all stored insights",
					);
					continue;
				}
			}

			this.insights.push(insight);
		}
	}
}
