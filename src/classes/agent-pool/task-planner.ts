import type pino from "pino";
import { ConversationRole } from "../../enums/conversation-role.enum.ts";
import { ExecutionStrategy } from "../../enums/execution-strategy.enum.ts";
import { TaskComplexity } from "../../enums/task-complexity.enum.ts";
import {
	planningSystemPrompt,
	taskAnalysisPrompt,
} from "../../prompts/index.ts";
import type {
	ProjectContext,
	SubTask,
	TaskAnalysis,
	TaskDependency,
} from "../../types/agent-pool.types.ts";
import { toErrorMessage } from "../../utils/errors.ts";
import type { ConversationManager } from "./conversation-manager.ts";

// ── Validators ─────────────────────────────────────────────────────────────

/**
 * Validates that a raw parsed JSON value conforms to the {@link TaskAnalysis}
 * schema expected from the planner LLM.
 *
 * Performs structural type checking on every required field and coerces
 * enum values to their canonical forms. Returns `null` if the data is
 * invalid so the OpenRouter client can retry with a correction prompt.
 *
 * This validator is intentionally lenient on optional/extra fields — it
 * only rejects data that is structurally unsound. Semantic validation
 * (e.g. "do the dependency IDs reference real subtasks?") is performed
 * separately after validation succeeds.
 */
function validateTaskAnalysis(data: unknown): TaskAnalysis | null {
	if (data == null || typeof data !== "object") return null;

	const obj = data as Record<string, unknown>;

	// ── strategy ──────────────────────────────────────────────────────
	const strategy = obj.strategy;
	if (strategy !== "single" && strategy !== "multi") return null;

	// ── complexity ────────────────────────────────────────────────────
	const complexity = obj.complexity;
	if (
		complexity !== "simple" &&
		complexity !== "moderate" &&
		complexity !== "complex"
	) {
		return null;
	}

	// ── reasoning ────────────────────────────────────────────────────
	if (typeof obj.reasoning !== "string" || obj.reasoning.length === 0) {
		return null;
	}

	// ── subtasks ─────────────────────────────────────────────────────
	if (!Array.isArray(obj.subtasks) || obj.subtasks.length === 0) return null;

	const subtasks: SubTask[] = [];
	for (const raw of obj.subtasks) {
		const subtask = validateSubTask(raw);
		if (!subtask) return null;
		subtasks.push(subtask);
	}

	// Strategy-specific subtask count enforcement
	if (strategy === "single" && subtasks.length !== 1) return null;
	if (strategy === "multi" && subtasks.length < 2) return null;

	// ── dependencies ────────────────────────────────────────────────
	const dependencies: TaskDependency[] = [];
	if (Array.isArray(obj.dependencies)) {
		for (const raw of obj.dependencies) {
			const dep = validateDependency(raw);
			if (!dep) return null;
			dependencies.push(dep);
		}
	}

	// ── parallelismBenefit ───────────────────────────────────────────
	const parallelismBenefit =
		typeof obj.parallelismBenefit === "number"
			? Math.max(0, Math.min(1, obj.parallelismBenefit))
			: 0;

	return {
		strategy:
			strategy === "single"
				? ExecutionStrategy.SINGLE
				: ExecutionStrategy.MULTI,
		complexity:
			complexity === "simple"
				? TaskComplexity.SIMPLE
				: complexity === "moderate"
					? TaskComplexity.MODERATE
					: TaskComplexity.COMPLEX,
		reasoning: obj.reasoning as string,
		subtasks,
		dependencies,
		parallelismBenefit,
	};
}

/**
 * Validates a single subtask entry from the planner's JSON response.
 */
function validateSubTask(data: unknown): SubTask | null {
	if (data == null || typeof data !== "object") return null;

	const obj = data as Record<string, unknown>;

	if (typeof obj.id !== "string" || obj.id.length === 0) return null;
	if (typeof obj.prompt !== "string" || obj.prompt.length === 0) return null;
	if (typeof obj.role !== "string" || obj.role.length === 0) return null;

	const dependencies = Array.isArray(obj.dependencies)
		? obj.dependencies.filter((d): d is string => typeof d === "string")
		: [];

	const priority =
		typeof obj.priority === "number" && obj.priority > 0
			? Math.round(obj.priority)
			: 1;

	return {
		id: obj.id as string,
		prompt: obj.prompt as string,
		role: obj.role as string,
		dependencies,
		priority,
	};
}

/**
 * Validates a single dependency entry from the planner's JSON response.
 */
function validateDependency(data: unknown): TaskDependency | null {
	if (data == null || typeof data !== "object") return null;

	const obj = data as Record<string, unknown>;

	if (typeof obj.from !== "string" || obj.from.length === 0) return null;
	if (typeof obj.to !== "string" || obj.to.length === 0) return null;

	const type = obj.type;
	if (type !== "blocking" && type !== "informational") return null;

	return {
		from: obj.from as string,
		to: obj.to as string,
		type,
	};
}

// ── Semantic Validation ────────────────────────────────────────────────────

/**
 * Performs semantic validation on a structurally valid {@link TaskAnalysis}.
 *
 * Checks:
 * - All subtask IDs are unique
 * - All dependency references point to valid subtask IDs
 * - No subtask depends on itself
 * - No circular dependencies exist
 * - Single-strategy analyses have no dependencies
 *
 * Returns an array of error messages (empty = valid).
 */
function semanticValidationErrors(analysis: TaskAnalysis): string[] {
	const errors: string[] = [];
	const subtaskIds = new Set(analysis.subtasks.map((s) => s.id));

	// Unique IDs
	if (subtaskIds.size !== analysis.subtasks.length) {
		errors.push("Duplicate subtask IDs detected");
	}

	// Single strategy should have no dependencies
	if (
		analysis.strategy === ExecutionStrategy.SINGLE &&
		analysis.dependencies.length > 0
	) {
		errors.push("Single-agent strategy should not have dependencies");
	}

	// Dependency reference validity
	for (const dep of analysis.dependencies) {
		if (!subtaskIds.has(dep.from)) {
			errors.push(`Dependency references unknown subtask "${dep.from}"`);
		}
		if (!subtaskIds.has(dep.to)) {
			errors.push(`Dependency references unknown subtask "${dep.to}"`);
		}
		if (dep.from === dep.to) {
			errors.push(`Subtask "${dep.from}" depends on itself`);
		}
	}

	// Subtask dependency array consistency
	for (const subtask of analysis.subtasks) {
		for (const depId of subtask.dependencies) {
			if (!subtaskIds.has(depId)) {
				errors.push(
					`Subtask "${subtask.id}" depends on unknown subtask "${depId}"`,
				);
			}
			if (depId === subtask.id) {
				errors.push(`Subtask "${subtask.id}" depends on itself`);
			}
		}
	}

	// Circular dependency detection (simple DFS)
	if (analysis.dependencies.length > 0) {
		const adjacency = new Map<string, string[]>();
		for (const dep of analysis.dependencies) {
			if (!adjacency.has(dep.from)) {
				adjacency.set(dep.from, []);
			}
			adjacency.get(dep.from)?.push(dep.to);
		}

		const visited = new Set<string>();
		const inStack = new Set<string>();

		function hasCycle(node: string): boolean {
			if (inStack.has(node)) return true;
			if (visited.has(node)) return false;

			visited.add(node);
			inStack.add(node);

			for (const neighbor of adjacency.get(node) ?? []) {
				if (hasCycle(neighbor)) return true;
			}

			inStack.delete(node);
			return false;
		}

		for (const id of subtaskIds) {
			if (hasCycle(id)) {
				errors.push("Circular dependency detected in subtask graph");
				break;
			}
		}
	}

	return errors;
}

// ── TaskPlanner ────────────────────────────────────────────────────────────

/**
 * LLM-driven task analysis and decomposition engine.
 *
 * The planner receives a user's task description and produces a
 * {@link TaskAnalysis} that determines the optimal execution strategy:
 *
 * - **Single agent**: The task is self-contained and does not benefit
 *   from decomposition. A single agent receives the complete task prompt.
 *
 * - **Multiple agents**: The task has clearly separable concerns that
 *   benefit from parallel execution or specialization. Each agent
 *   receives a distinct, self-contained prompt for its subtask.
 *
 * ## Decision Process
 *
 * The planner uses a dedicated LLM conversation ({@link ConversationRole.PLANNER})
 * to analyze the task. The system prompt establishes strict criteria for
 * when decomposition is warranted (see `planning.system.hbs`). The planner
 * is biased toward single-agent execution to avoid artificial splitting.
 *
 * ## Semantic Validation
 *
 * After the LLM produces a structurally valid JSON response, the planner
 * performs semantic validation:
 * - Subtask ID uniqueness
 * - Dependency reference validity
 * - Circular dependency detection
 * - Strategy-subtask count consistency
 *
 * If semantic validation fails, the planner retries with an error correction
 * prompt. After exhausting retries, it falls back to a safe single-agent
 * strategy that passes the original task unmodified.
 *
 * ## Conversation History
 *
 * The planner's conversation history is maintained across calls, allowing
 * follow-up analyses to reference prior decisions. This enables iterative
 * planning (e.g. re-planning after partial failures).
 *
 * @example
 * ```ts
 * const planner = new TaskPlanner(conversationManager, logger);
 *
 * const analysis = await planner.analyze("Build a REST API with tests and docs");
 * // analysis.strategy === "multi"
 * // analysis.subtasks.length === 3
 * // analysis.subtasks[0].role === "api-developer"
 * // analysis.subtasks[1].role === "test-writer"
 * // analysis.subtasks[2].role === "documentation-author"
 *
 * const simpleAnalysis = await planner.analyze("Fix the typo in README.md");
 * // simpleAnalysis.strategy === "single"
 * // simpleAnalysis.subtasks.length === 1
 * ```
 */
export class TaskPlanner {
	/** Maximum number of semantic correction attempts before fallback. */
	private static readonly MAX_SEMANTIC_RETRIES = 2;

	constructor(
		private readonly conversations: ConversationManager,
		private readonly logger: pino.Logger,
		plannerModel?: string,
	) {
		// Register the planner conversation if not already present
		if (!this.conversations.has(ConversationRole.PLANNER)) {
			this.conversations.register(
				ConversationRole.PLANNER,
				planningSystemPrompt({}),
				plannerModel,
			);
		}
	}

	// ── Public API ─────────────────────────────────────────────────────

	/**
	 * Analyzes a task and produces an execution strategy.
	 *
	 * @param task        - The user's task description.
	 * @param contextHints - Optional additional context for the planner.
	 * @param constraints  - Optional constraints to apply.
	 * @param projectContext - Optional project context from the ProjectScanner.
	 * @returns A validated {@link TaskAnalysis} with the chosen strategy.
	 */
	async analyze(
		task: string,
		contextHints?: string,
		constraints?: string[],
		projectContext?: ProjectContext,
	): Promise<TaskAnalysis> {
		// Reset planner conversation to prevent history accumulation
		// across sequential executions. Each planning call starts fresh,
		// but semantic retry loops within a single call still work because
		// sendJson appends to the conversation during correction attempts.
		this.conversations.reset(ConversationRole.PLANNER);

		// Sanitize the task text against prompt injection
		const sanitizedTask = this.conversations.client.sanitize(task);

		// Build the analysis prompt from the Handlebars template
		const prompt = taskAnalysisPrompt({
			task: sanitizedTask,
			contextHints: contextHints ?? null,
			constraints: constraints ?? null,
			projectContext: projectContext ?? null,
		});

		this.logger.info(
			{ taskLength: task.length },
			`Analyzing task (${task.length} chars)`,
		);

		// Attempt to get a semantically valid analysis from the LLM
		let lastAnalysis: TaskAnalysis | null = null;

		for (
			let attempt = 0;
			attempt <= TaskPlanner.MAX_SEMANTIC_RETRIES;
			attempt++
		) {
			const promptToSend: string =
				attempt === 0 || lastAnalysis === null
					? prompt
					: this.buildCorrectionPrompt(prompt, lastAnalysis, attempt);

			try {
				const analysis: TaskAnalysis = await this.conversations.sendJson(
					ConversationRole.PLANNER,
					promptToSend,
					validateTaskAnalysis,
				);

				// Run semantic validation
				const semanticErrors = semanticValidationErrors(analysis);

				if (semanticErrors.length === 0) {
					this.logger.info(
						{
							strategy: analysis.strategy,
							complexity: analysis.complexity,
							subtaskCount: analysis.subtasks.length,
							dependencyCount: analysis.dependencies.length,
							parallelismBenefit: analysis.parallelismBenefit,
						},
						`Analysis complete — ${analysis.strategy}, ${analysis.complexity}, ${analysis.subtasks.length} subtask(s)`,
					);

					return analysis;
				}

				// Semantic errors found — log and retry
				this.logger.warn(
					{ attempt, semanticErrors },
					`Analysis has semantic errors (attempt ${attempt + 1}), retrying`,
				);

				lastAnalysis = analysis;
			} catch (error) {
				this.logger.warn(
					{
						attempt,
						error: toErrorMessage(error),
					},
					`Analysis attempt ${attempt + 1} failed — ${toErrorMessage(error)}`,
				);

				// If this was a JSON validation error, retry is already
				// handled by chatJson. If it's something else, keep trying.
				if (attempt === TaskPlanner.MAX_SEMANTIC_RETRIES) {
					break;
				}
			}
		}

		// All retries exhausted — fall back to single-agent
		this.logger.warn(
			"Analysis retries exhausted — falling back to single-agent",
		);

		return this.buildFallback(task);
	}

	// ── Private ────────────────────────────────────────────────────────

	/**
	 * Builds a correction prompt that includes the original analysis
	 * request plus the semantic errors found in the previous attempt.
	 */
	private buildCorrectionPrompt(
		originalPrompt: string,
		previousAnalysis: TaskAnalysis,
		attempt: number,
	): string {
		const errors = semanticValidationErrors(previousAnalysis);

		return [
			`Your previous analysis (attempt ${attempt}) had semantic errors:`,
			"",
			...errors.map((e) => `- ${e}`),
			"",
			"Please fix these issues and produce a corrected analysis.",
			"Remember: subtask IDs must be unique, dependencies must reference existing subtask IDs, and there must be no circular dependencies.",
			"",
			"Original request:",
			originalPrompt,
		].join("\n");
	}

	/**
	 * Produces a safe single-agent fallback analysis when the LLM
	 * fails to produce a valid decomposition.
	 *
	 * The fallback passes the original task verbatim as the sole
	 * subtask prompt, ensuring execution can proceed even when
	 * planning fails.
	 */
	private buildFallback(task: string): TaskAnalysis {
		this.logger.info("Using single-agent fallback");

		return {
			strategy: ExecutionStrategy.SINGLE,
			complexity: TaskComplexity.MODERATE,
			reasoning:
				"Automatic fallback: the planner could not produce a valid " +
				"analysis after multiple attempts. Defaulting to a single " +
				"agent with the original task.",
			subtasks: [
				{
					id: "fallback-task",
					prompt: task,
					role: "general-agent",
					dependencies: [],
					priority: 1,
				},
			],
			dependencies: [],
			parallelismBenefit: 0,
		};
	}
}
