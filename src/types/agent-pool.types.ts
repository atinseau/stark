import type pino from "pino";
import type { AgentStatus } from "../enums/agent-status.enum.ts";
import type { ConversationRole } from "../enums/conversation-role.enum.ts";
import type { DeltaType } from "../enums/delta-type.enum.ts";
import type { ExecutionStrategy } from "../enums/execution-strategy.enum.ts";
import type { PoolEvent } from "../enums/pool-event.enum.ts";
import type { ReactionAction } from "../enums/reaction-action.enum.ts";
import type { TaskComplexity } from "../enums/task-complexity.enum.ts";
import type { UserIntent } from "../enums/user-intent.enum.ts";
import type {
	AgentConfig,
	AgentIdentity,
	LogOutputConfig,
	PromptResult,
} from "./agent.types.ts";

// ── OpenRouter Types ───────────────────────────────────────────────────────

/** A single message in an OpenRouter chat conversation. */
export interface OpenRouterMessage {
	readonly role: "system" | "user" | "assistant";
	readonly content: string;
}

/** Configuration for the OpenRouter LLM client. */
export interface OpenRouterConfig {
	/** OpenRouter API key. */
	readonly apiKey: string;

	/** Model identifier (e.g. "anthropic/claude-sonnet-4"). */
	readonly model: string;

	/** Maximum number of retry attempts on transient failures. Defaults to 3. */
	readonly maxRetries?: number;

	/** Base delay in ms for exponential backoff. Defaults to 1000. */
	readonly baseDelay?: number;

	/** Request timeout in ms. Defaults to 120_000 (2 minutes). */
	readonly timeout?: number;

	/** Temperature for generation. Defaults to 0.3 for deterministic planning. */
	readonly temperature?: number;

	/** Maximum tokens to generate per response. */
	readonly maxTokens?: number;
}

/** Options for a single chat request to OpenRouter. */
export interface ChatOptions {
	/** Override the temperature for this request. */
	readonly temperature?: number;

	/** Override the max tokens for this request. */
	readonly maxTokens?: number;

	/** Whether to request JSON output mode. Defaults to false. */
	readonly jsonMode?: boolean;

	/** Override the max JSON correction attempts for this request.
	 *  When set, takes precedence over the client-level maxJsonAttempts. */
	readonly maxJsonAttempts?: number;

	/** Override the model for this request. */
	readonly model?: string;
}

// ── Conversation Types ─────────────────────────────────────────────────────

/** A single isolated LLM conversation with its own message history. */
export interface Conversation {
	/** The purpose of this conversation. */
	readonly role: ConversationRole;

	/** The system prompt establishing the conversation's behavior. */
	readonly systemPrompt: string;

	/** Full message history for this conversation. */
	messages: OpenRouterMessage[];

	/** Total tokens consumed by this conversation (estimated). */
	tokenCount: number;

	/** Optional model override for this conversation role. */
	model?: string;
}

// ── Task Planning Types ────────────────────────────────────────────────────

// ── Subtask Timeout & Retry Configuration ──────────────────────────────────

/**
 * Configuration for subtask-level timeouts.
 *
 * A timeout is applied to each individual subtask's `agent.prompt()` call.
 * When a subtask exceeds its timeout, the agent is destroyed and the
 * subtask is either retried (if retries are configured) or marked as failed.
 */
export interface SubtaskTimeoutConfig {
	/**
	 * Maximum duration (in milliseconds) for a single subtask execution.
	 *
	 * This includes the full `agent.prompt()` call — all tool calls,
	 * file operations, and LLM round-trips within that prompt.
	 *
	 * Default: 300_000 (5 minutes).
	 *
	 * Set to `0` or `Infinity` to disable timeout.
	 */
	readonly subtaskTimeoutMs: number;

	/**
	 * Optional per-complexity timeout overrides.
	 *
	 * If provided, overrides `subtaskTimeoutMs` based on the assessed
	 * task complexity from the planner. This allows giving more time
	 * to complex subtasks without inflating the timeout for simple ones.
	 *
	 * If a complexity level is not specified, `subtaskTimeoutMs` is used.
	 */
	readonly complexityTimeouts?: {
		readonly simple?: number;
		readonly moderate?: number;
		readonly complex?: number;
	};
}

/**
 * Configuration for subtask-level retry behavior.
 *
 * When a subtask fails (error or timeout), it can be retried with
 * a fresh agent instance. The retry prompt includes the error context
 * from the previous attempt to help the agent avoid the same mistake.
 */
export interface SubtaskRetryConfig {
	/**
	 * Maximum number of retry attempts per subtask (not counting the initial attempt).
	 *
	 * Default: 1 (one retry allowed, so 2 total attempts).
	 * Set to 0 to disable retries.
	 */
	readonly maxRetries: number;

	/**
	 * Whether to include the error context from the previous attempt
	 * in the retry prompt.
	 *
	 * When `true`, the retry prompt is augmented with:
	 * - The error message from the previous attempt
	 * - A summary of what the previous agent did before failing
	 * - Instructions to avoid the same mistake
	 *
	 * Default: true.
	 */
	readonly includeErrorContext: boolean;

	/**
	 * Delay in milliseconds before retrying a failed subtask.
	 *
	 * Useful for transient errors (network issues, rate limiting).
	 * Default: 2000 (2 seconds).
	 */
	readonly retryDelayMs: number;

	/**
	 * Whether to retry on timeout specifically (as opposed to only on errors).
	 *
	 * Default: true.
	 */
	readonly retryOnTimeout: boolean;
}

// ── Task Planning Types ────────────────────────────────────────────────────

/**
 * Result of the planner's analysis of a user task.
 *
 * Contains the strategic decision about whether to use a single agent
 * or multiple agents, along with the decomposed subtasks if applicable.
 */
export interface TaskAnalysis {
	/** Whether to use a single agent or multiple agents. */
	readonly strategy: ExecutionStrategy;

	/** Assessed complexity of the task. */
	readonly complexity: TaskComplexity;

	/** Human-readable explanation of the planning decision. */
	readonly reasoning: string;

	/**
	 * The subtasks to execute.
	 * For `strategy: "single"`, this contains exactly one subtask.
	 * For `strategy: "multi"`, this contains two or more subtasks.
	 */
	readonly subtasks: SubTask[];

	/**
	 * Dependencies between subtasks.
	 * Empty when `strategy` is `"single"`.
	 */
	readonly dependencies: TaskDependency[];

	/**
	 * Estimated benefit of parallel execution (0.0 to 1.0).
	 * 0 = no benefit (fully sequential), 1 = maximum benefit.
	 */
	readonly parallelismBenefit: number;
}

/** A discrete unit of work assigned to a single agent. */
export interface SubTask {
	/** Unique identifier for this subtask. */
	readonly id: string;

	/** The prompt text to send to the agent. */
	readonly prompt: string;

	/**
	 * A human-readable role description for the agent handling this subtask.
	 * Example: "backend-api-developer", "test-writer", "documentation-author"
	 */
	readonly role: string;

	/**
	 * IDs of subtasks that must complete before this one can start.
	 * Empty array means the subtask can start immediately.
	 */
	readonly dependencies: string[];

	/**
	 * Execution priority (1 = highest).
	 * Used to order subtasks when dependencies allow parallel execution.
	 */
	readonly priority: number;
}

/** A dependency relationship between two subtasks. */
export interface TaskDependency {
	/** The subtask that produces information. */
	readonly from: string;

	/** The subtask that consumes the information. */
	readonly to: string;

	/**
	 * The nature of the dependency:
	 * - `"blocking"`: The target cannot start until the source completes.
	 * - `"informational"`: The target benefits from the source's output
	 *   but can proceed without it.
	 */
	readonly type: "blocking" | "informational";
}

// ── Replanning Types ───────────────────────────────────────────────────────

/**
 * Trigger conditions that can initiate a replanning evaluation.
 */
export enum ReplanTrigger {
	/** A subtask failed after exhausting all retries. */
	SUBTASK_FAILURE = "subtask_failure",

	/** A deadlock was detected in the dependency graph. */
	DEADLOCK = "deadlock",

	/** An agent reported a fundamental blocker (framework mismatch, missing capability). */
	AGENT_BLOCKER = "agent_blocker",

	/** Multiple subtasks failed, suggesting systemic issues. */
	CASCADING_FAILURES = "cascading_failures",

	/** Manual replan requested by the user. */
	USER_REQUESTED = "user_requested",
}

/**
 * Request for replanning, containing the context needed for the planner
 * to make an informed decision about how to proceed.
 */
export interface ReplanRequest {
	/** What triggered the replan evaluation. */
	readonly trigger: ReplanTrigger;

	/** The original task description. */
	readonly originalTask: string;

	/** The original plan that was being executed. */
	readonly originalAnalysis: TaskAnalysis;

	/** Current state of all agents (completed, failed, in-progress). */
	readonly agentStates: ReadonlyArray<{
		readonly subtaskId: string;
		readonly agentName: string;
		readonly role: string;
		readonly completed: boolean;
		readonly failed: boolean;
		readonly error: string | null;
		/** Summary of what was accomplished before failure/completion. */
		readonly accomplishedSummary: string;
		/** Files written by this agent. */
		readonly filesWritten: readonly string[];
	}>;

	/** Subtask IDs that are blocked and cannot proceed. */
	readonly blockedSubtaskIds: readonly string[];

	/** Human-readable description of the problem that triggered replanning. */
	readonly problemDescription: string;
}

/**
 * The planner's decision on how to proceed after evaluating the replan request.
 */
export interface ReplanDecision {
	/** Whether the plan should be modified. */
	readonly shouldReplan: boolean;

	/**
	 * The chosen strategy for the replan.
	 * - `"continue"` — Keep going with the current plan despite issues.
	 * - `"modify"` — Adjust the plan: add, remove, or change subtasks.
	 * - `"restart"` — Abandon current progress and restart from scratch.
	 * - `"abort"` — Stop execution entirely, the task cannot be completed.
	 */
	readonly action: "continue" | "modify" | "restart" | "abort";

	/** Human-readable reasoning for the decision. */
	readonly reasoning: string;

	/**
	 * If action is "modify": the new subtasks to execute.
	 * These replace the remaining (non-completed) subtasks in the original plan.
	 * Already-completed subtasks are NOT re-executed.
	 */
	readonly newSubtasks: SubTask[];

	/**
	 * If action is "modify": updated dependency graph for the new subtasks.
	 */
	readonly newDependencies: TaskDependency[];

	/**
	 * Context that should be injected into new agents, summarizing
	 * what was already accomplished by the completed subtasks.
	 */
	readonly completedWorkSummary: string;
}

// ── Significance Context Types ─────────────────────────────────────────────

/**
 * Contextual information used by the InformationBroker to compute
 * dynamic significance thresholds for delta evaluation.
 *
 * The threshold adapts based on the current state of execution,
 * the relationship between agents, and the nature of the delta.
 */
export interface SignificanceContext {
	/** Total number of subtasks in the current execution. */
	readonly totalSubtasks: number;

	/** Number of subtasks that have completed successfully. */
	readonly completedSubtasks: number;

	/** Number of subtasks that have failed. */
	readonly failedSubtasks: number;

	/**
	 * Execution phase derived from completion ratio.
	 * - "early": 0-30% completion — exploration, alignment phase
	 * - "mid": 30-70% completion — active production phase
	 * - "late": 70-100% completion — finalization, integration phase
	 */
	readonly phase: "early" | "mid" | "late";

	/**
	 * Total number of deltas already processed in this execution.
	 * Used to detect "chatty" executions where the threshold should
	 * be raised to reduce LLM call volume.
	 */
	readonly totalDeltasProcessed: number;
}

// ── Structured Context Injection Types ─────────────────────────────────────

/**
 * Priority levels for context injections.
 *
 * Determines the order in which injections are presented to the agent
 * when multiple are pending. Higher priority = presented first.
 */
export enum ContextInjectionPriority {
	/** Critical information the agent cannot proceed correctly without.
	 *  Typically from blocking dependencies. */
	CRITICAL = "critical",

	/** Important information that significantly improves the agent's output.
	 *  Typically from informational dependencies or significant sharing decisions. */
	HIGH = "high",

	/** Supplementary context that may be useful but is not essential.
	 *  Typically from non-dependent agents or routine observations. */
	NORMAL = "normal",

	/** Background information provided for awareness only.
	 *  Will be dropped first if the queue is overloaded. */
	LOW = "low",
}

/**
 * Categories of context injections.
 * Used to format clear headers in the injected prompt.
 */
export enum ContextInjectionCategory {
	/** Output from a dependent agent that this agent needs. */
	DEPENDENCY_OUTPUT = "dependency_output",

	/** Information shared from another agent working on a related task. */
	SHARED_CONTEXT = "shared_context",

	/** Additional instructions or constraints from the user. */
	USER_INSTRUCTION = "user_instruction",

	/** Error or conflict information from the coordination system. */
	COORDINATION_ALERT = "coordination_alert",
}

/**
 * A categorized, prioritized instruction injected into an agent's context.
 *
 * Unlike raw string injections, structured injections carry metadata
 * that allows the AgentContextManager to:
 * - Present them in priority order (CRITICAL first)
 * - Format them with clear source attribution
 * - Limit accumulation per priority level
 * - Drop low-priority injections when the queue is overloaded
 */
export interface StructuredContextInjection {
	/** The raw instruction text to inject. */
	readonly content: string;

	/** Priority level for ordering and overflow management. */
	readonly priority: ContextInjectionPriority;

	/**
	 * Category describing the nature of this injection.
	 * Used for formatting the injection header in the agent's prompt.
	 */
	readonly category: ContextInjectionCategory;

	/** Human-readable source label (e.g., "api-developer", "user"). */
	readonly source: string;

	/**
	 * Optional dependency type if this injection comes from a dependency.
	 * `null` for user-injected context or non-dependency sharing.
	 */
	readonly dependencyType: "blocking" | "informational" | null;

	/** ISO-8601 timestamp when the injection was created. */
	readonly timestamp: string;
}

// ── Checkpoint Types ───────────────────────────────────────────────────────

/**
 * Conditions that trigger a mid-execution checkpoint evaluation.
 */
export enum CheckpointTrigger {
	/** A configured percentage of subtasks have completed. */
	COMPLETION_PERCENTAGE = "completion_percentage",

	/** A fixed number of deltas have been processed since the last checkpoint. */
	DELTA_COUNT = "delta_count",

	/** A time interval has elapsed since the last checkpoint. */
	TIME_INTERVAL = "time_interval",

	/** An agent has failed (complementary to the ReplanTrigger). */
	AGENT_FAILURE = "agent_failure",

	/** Triggered manually by the user via a STATUS_QUERY intent. */
	USER_REQUESTED = "user_requested",
}

/**
 * Actions recommended by a checkpoint evaluation.
 */
export enum CheckpointAction {
	/** Everything looks healthy — continue without intervention. */
	CONTINUE = "continue",

	/** Minor issues detected — inject corrective context into affected agents. */
	ADJUST = "adjust",

	/** Significant structural problems — trigger re-planning (evolution 11). */
	REPLAN = "replan",

	/** Issues require human judgment — escalate to the user. */
	ESCALATE = "escalate",

	/** Critical problems detected — abort execution immediately. */
	ABORT = "abort",
}

/**
 * Result of a mid-execution checkpoint evaluation.
 *
 * Produced by the CheckpointEvaluator after analysing the global
 * execution state at a given point in time.
 */
export interface CheckpointResult {
	/** The recommended action. */
	readonly action: CheckpointAction;

	/** The trigger that caused this checkpoint. */
	readonly trigger: CheckpointTrigger;

	/** Human-readable explanation of the evaluation. */
	readonly reasoning: string;

	/**
	 * Execution health score (0.0 to 1.0).
	 * 0.0 = critical, 1.0 = perfect.
	 */
	readonly healthScore: number;

	/**
	 * Concise user-facing summary of the current execution state.
	 * Includes progress, detected problems, and recommendations.
	 */
	readonly statusSummary: string;

	/**
	 * Problems detected during the checkpoint (may be empty).
	 * Each entry is a distinct issue with its severity.
	 */
	readonly issues: ReadonlyArray<{
		readonly severity: "info" | "warning" | "critical";
		readonly description: string;
		readonly affectedAgents: readonly string[];
	}>;

	/**
	 * Corrective instructions to inject into specific agents.
	 * Non-empty only when action === ADJUST.
	 * Key = agent ID, value = corrective instruction text.
	 */
	readonly corrections: ReadonlyMap<string, string>;

	/** ISO-8601 timestamp of the checkpoint. */
	readonly timestamp: string;
}

/**
 * Configuration for mid-execution checkpoints in {@link AgentPoolConfig}.
 */
export interface CheckpointConfig {
	/**
	 * Enable or disable checkpoints.
	 * Default: true for multi-agent, false for single-agent.
	 */
	readonly enabled?: boolean;

	/**
	 * Completion percentage(s) that trigger a checkpoint.
	 * A single number or an array for multiple thresholds.
	 * Default: 50 (checkpoint at the halfway mark).
	 */
	readonly completionPercentages?: number | number[];

	/**
	 * Number of deltas between periodic checkpoints.
	 * Default: 30.
	 */
	readonly deltaInterval?: number;

	/**
	 * Time interval in milliseconds between periodic checkpoints.
	 * Default: 60000 (1 minute).
	 */
	readonly timeIntervalMs?: number;

	/**
	 * Whether every non-CONTINUE checkpoint automatically notifies
	 * the user. ESCALATE and ABORT always notify regardless of this
	 * setting.
	 * Default: false.
	 */
	readonly notifyOnCheckpoint?: boolean;
}

// ── Context Tracking Types ─────────────────────────────────────────────────

/**
 * Tracks the full contextual state of a single managed agent.
 *
 * Updated incrementally as the agent produces events, enabling
 * delta computation and cross-agent analysis.
 */
export interface AgentContextState {
	/** The agent's unique ID. */
	readonly agentId: string;

	/** The agent's human-friendly name. */
	readonly agentName: string;

	/** The subtask description assigned to this agent. */
	readonly taskDescription: string;

	/** The subtask role assigned to this agent. */
	readonly taskRole: string;

	/** Current lifecycle status of the agent. */
	status: AgentStatus;

	/** Significant events captured from the agent's activity. */
	events: ContextEvent[];

	/** Results from completed prompts. */
	promptResults: PromptResult[];

	/** The most recent context delta, or null if no changes yet. */
	lastDelta: ContextDelta | null;

	/** Files written by this agent (paths). */
	filesWritten: string[];

	/** Files read by this agent (paths). */
	filesRead: string[];

	/** Whether this agent has completed its subtask. */
	completed: boolean;

	/** Error message if the agent failed. */
	error: string | null;
}

/**
 * A significant event captured from agent activity.
 *
 * This is a simplified representation of raw agent events,
 * retaining only the information needed for context analysis.
 */
export interface ContextEvent {
	/** The type of event. */
	readonly type: string;

	/** ISO-8601 timestamp. */
	readonly timestamp: string;

	/** Human-readable summary of the event. */
	readonly summary: string;

	/** Structured data associated with the event. */
	readonly data: Record<string, unknown>;
}

/**
 * Represents a meaningful change in an agent's context.
 *
 * Deltas are computed from raw agent events and fed to the
 * context analyzer for semantic analysis and reaction decisions.
 */
export interface ContextDelta {
	/** The agent that produced this delta. */
	readonly agentId: string;

	/** The agent's human-friendly name. */
	readonly agentName: string;

	/** ISO-8601 timestamp of the delta. */
	readonly timestamp: string;

	/** Classified type of the change. */
	readonly type: DeltaType;

	/** Human-readable summary of the change. */
	readonly summary: string;

	/** Structured data specific to this delta type. */
	readonly data: Record<string, unknown>;

	/**
	 * Estimated significance of this delta (0.0 to 1.0).
	 * Used as a pre-filter before LLM analysis.
	 * - 0.0 = trivial (file read, status echo)
	 * - 0.5 = moderate (tool completed, plan updated)
	 * - 1.0 = critical (error, task completed)
	 */
	readonly significance: number;

	/**
	 * For PROMPT_COMPLETE deltas: a structured summary of the agent's response,
	 * extracted to provide more context than the truncated responsePreview.
	 *
	 * This field is populated for prompt completions where the full response
	 * exceeds the preview limit, giving downstream consumers (like the
	 * InformationBroker) enough context to make informed sharing decisions.
	 *
	 * `null` for non-PROMPT_COMPLETE deltas or when the preview is already complete.
	 */
	readonly promptResultSummary: string | null;
}

// ── Context Analysis Types ─────────────────────────────────────────────────

/**
 * Result of the context analyzer's evaluation of a delta.
 *
 * Produced by the context-analyzer LLM conversation after
 * examining a delta in the context of the overall task state.
 */
export interface ContextAnalysisResult {
	/** The recommended action to take. */
	readonly action: ReactionAction;

	/** Human-readable reasoning for the decision. */
	readonly reasoning: string;

	/**
	 * If action is SHARE: the ID of the target agent.
	 * If action is NOTIFY: unused.
	 * If action is CLARIFY: unused.
	 */
	readonly targetAgentId?: string;

	/** The information to share or the notification/clarification text. */
	readonly content?: string;

	/** Assessed significance after LLM analysis (may differ from pre-filter). */
	readonly significance: number;
}

// ── Information Sharing Types ──────────────────────────────────────────────

/**
 * A decision about whether to share information between agents.
 *
 * Produced by the information broker after analyzing a delta
 * in the context of the target agent's current state.
 */
export interface SharingDecision {
	/** Whether the information should be shared. */
	readonly shouldShare: boolean;

	/** Human-readable reasoning for the decision. */
	readonly reasoning: string;

	/** The source agent's ID. */
	readonly sourceAgentId: string;

	/** The target agent's ID. */
	readonly targetAgentId: string;

	/** The distilled information to inject, if sharing is approved. */
	readonly information: string;
}

/**
 * Enregistrement d'un partage d'information effectué entre deux agents.
 * Stocké dans l'historique du broker pour la déduplication.
 */
export interface SharingRecord {
	/** ISO-8601 timestamp du partage. */
	readonly timestamp: string;

	/** L'agent source qui a produit l'information. */
	readonly sourceAgentId: string;

	/** L'agent cible qui a reçu l'information. */
	readonly targetAgentId: string;

	/** Le type de delta qui a déclenché le partage. */
	readonly deltaType: DeltaType;

	/** Résumé condensé de l'information partagée (pour inclusion dans les prompts futurs). */
	readonly informationSummary: string;
}

// ── Notification Types ─────────────────────────────────────────────────────

/**
 * User's notification preference.
 *
 * Stored by the notification engine when the user explicitly
 * requests notifications via `pool.send()`.
 */
export interface NotificationPreference {
	/** Whether notifications are enabled. */
	readonly enabled: boolean;

	/**
	 * Minimum significance threshold for notifications (0.0 to 1.0).
	 * Only deltas with significance >= this value trigger notifications.
	 * Defaults to 0.5.
	 */
	readonly minSignificance?: number;

	/**
	 * Optional list of delta types the user is interested in.
	 * If empty/undefined, all types are considered.
	 */
	readonly types?: DeltaType[];
}

/** A notification generated for the user. */
export interface UserNotification {
	/** The notification message. */
	readonly message: string;

	/** The significance of the triggering delta. */
	readonly significance: number;

	/** The agent that triggered the notification. */
	readonly agentId: string;

	/** The agent's human-friendly name. */
	readonly agentName: string;

	/** The type of delta that triggered the notification. */
	readonly type: DeltaType;

	/** ISO-8601 timestamp. */
	readonly timestamp: string;
}

// ── Coordination Statistics ────────────────────────────────────────────────

/**
 * Statistics about cross-agent coordination during execution.
 * Used to enrich the execution summary with coordination context.
 */
export interface CoordinationStats {
	/** Number of context deltas detected across all agents. */
	readonly deltaCount: number;

	/** Number of sharing evaluations performed by the broker. */
	readonly sharingEvaluationCount: number;

	/** Number of positive sharing decisions (information actually shared). */
	readonly sharingApprovedCount: number;

	/** Number of notifications sent to the user. */
	readonly notificationCount: number;

	/**
	 * Summary of information shared between agents.
	 * Each entry describes a sharing event: source → target and what was shared.
	 * Limited to the most significant sharing events.
	 */
	readonly sharingSummaries: ReadonlyArray<{
		readonly sourceAgentName: string;
		readonly targetAgentName: string;
		readonly informationPreview: string;
	}>;

	/** Number of subtask retries performed. */
	readonly retryCount: number;

	/** Number of subtask timeouts triggered. */
	readonly timeoutCount: number;
}

// ── Intent Analysis Types ──────────────────────────────────────────────────

/**
 * A single detected intent within a multi-intent analysis.
 */
export interface DetectedIntent {
	/** The classified intent type. */
	readonly intent: UserIntent;

	/** Confidence score for this specific intent (0.0 to 1.0). */
	readonly confidence: number;

	/** Extracted parameters relevant to this intent. */
	readonly parameters: Record<string, unknown>;
}

/**
 * Result of the intent analyzer's classification of a user message.
 *
 * Supports multi-intent messages where the user expresses more than
 * one intention in a single message (e.g., "Start the tests and
 * notify me when done" → new_task + notification_preference).
 *
 * The `intents` array is ordered by priority: the primary intent first,
 * secondary intents after. When only one intent is detected, the array
 * contains a single element.
 */
export interface IntentAnalysis {
	/**
	 * The detected intents, ordered by priority (primary first).
	 * Guaranteed to have at least one entry.
	 */
	readonly intents: DetectedIntent[];

	/**
	 * Convenience accessor: the primary (first) intent.
	 * Equivalent to `intents[0].intent`.
	 * Kept for backward compatibility with code that reads `analysis.primaryIntent`.
	 */
	readonly primaryIntent: UserIntent;

	/** Human-readable reasoning for the overall classification. */
	readonly reasoning: string;
}

// ── Project Context ────────────────────────────────────────────────────────

/**
 * Contexte du projet de travail, extrait par le ProjectScanner.
 *
 * Ce contexte est injecté dans le prompt du planner pour qu'il puisse
 * prendre des décisions de décomposition informées par l'état réel
 * du projet.
 */
export interface ProjectContext {
	/** Le chemin absolu du répertoire de travail. */
	readonly cwd: string;

	/**
	 * Arborescence du projet (fichiers et dossiers principaux).
	 * Limitée en profondeur et filtrée (sans node_modules, .git, etc.).
	 * Format : liste de chemins relatifs, un par ligne.
	 * Exemple : ["src/", "src/index.ts", "src/routes/", "package.json"]
	 */
	readonly fileTree: string[];

	/**
	 * Langages principaux détectés, ordonnés par fréquence.
	 * Exemple : ["typescript", "json", "markdown"]
	 */
	readonly languages: string[];

	/**
	 * Fichiers de configuration détectés avec leur contenu résumé.
	 * Clé = nom du fichier, valeur = résumé ou contenu partiel.
	 * Exemple : { "package.json": "{ name: my-app, deps: express, jest }" }
	 */
	readonly configFiles: Record<string, string>;

	/**
	 * Framework(s) ou runtime(s) détectés.
	 * Exemple : ["express", "react", "jest"]
	 */
	readonly detectedFrameworks: string[];

	/**
	 * Résumé textuel compact du projet pour injection dans les prompts LLM.
	 * Construit à partir des champs ci-dessus.
	 * Limité à ~1500 caractères pour ne pas saturer le prompt.
	 */
	readonly summary: string;

	/**
	 * Indique si le projet semble vierge (aucun fichier source détecté).
	 */
	readonly isEmpty: boolean;
}

// ── Orchestrator Types ─────────────────────────────────────────────────────

/**
 * A directive emitted by the ORCHESTRATOR to influence another conversation.
 *
 * Directives are not imperative orders — they are contextual
 * recommendations that subsystems integrate into their next decisions.
 */
export interface OrchestratorDirective {
	/** The unique identifier of this directive. */
	readonly id: string;

	/** The subsystem targeted by this directive. */
	readonly target:
		| "sharing"
		| "notification"
		| "planner"
		| "checkpoint"
		| "all";

	/** The instruction to integrate into the subsystem's next decisions. */
	readonly instruction: string;

	/** Priority level of the directive. */
	readonly priority: "suggestion" | "recommendation" | "strong";

	/** Time-to-live in number of evaluations before automatic expiration. */
	readonly ttlEvaluations: number;

	/** ISO-8601 timestamp of creation. */
	readonly timestamp: string;
}

/**
 * Type of the target of a directive, for validation.
 */
export type DirectiveTarget = OrchestratorDirective["target"];

/**
 * A problem detected by the ORCHESTRATOR.
 */
export interface OrchestratorIssue {
	/** Category of the problem. */
	readonly category:
		| "coherence"
		| "efficiency"
		| "drift"
		| "conflict"
		| "communication";

	/** Severity of the problem. */
	readonly severity: "low" | "medium" | "high";

	/** Human-readable description of the problem. */
	readonly description: string;

	/** The agents or subsystems affected. */
	readonly affected: string[];
}

/**
 * Result of an ORCHESTRATOR evaluation.
 *
 * Produced periodically to give a global view of coordination
 * quality in the system.
 */
export interface OrchestratorAssessment {
	/** Global coherence score (0.0 = chaos, 1.0 = perfectly coordinated). */
	readonly coherenceScore: number;

	/** Textual assessment of the coordination state. */
	readonly assessment: string;

	/** Problems detected by the meta-analysis. */
	readonly issues: OrchestratorIssue[];

	/** Directives emitted to correct detected problems. */
	readonly directives: OrchestratorDirective[];

	/** ISO-8601 timestamp of this evaluation. */
	readonly timestamp: string;

	/** Sequential number of this evaluation in the current execution. */
	readonly assessmentNumber: number;
}

/**
 * Configuration for the ORCHESTRATOR engine.
 */
export interface OrchestratorConfig {
	/** Enable/disable the ORCHESTRATOR (default: true for multi-agent, false for single). */
	readonly enabled?: boolean;

	/**
	 * Minimum interval between two evaluations in number of deltas.
	 * The ORCHESTRATOR does not trigger on every delta — it waits
	 * for enough changes to accumulate for a meaningful evaluation.
	 * Default: 8.
	 */
	readonly deltaInterval?: number;

	/**
	 * Minimum interval between two evaluations in milliseconds.
	 * Even if the deltaInterval is reached, the ORCHESTRATOR waits
	 * at least this delay between evaluations.
	 * Default: 30000 (30 seconds).
	 */
	readonly minIntervalMs?: number;

	/**
	 * Maximum number of simultaneously active directives.
	 * Beyond this, the oldest directives expire automatically.
	 * Default: 10.
	 */
	readonly maxActiveDirectives?: number;

	/**
	 * Default time-to-live for directives in number of evaluations.
	 * Default: 5.
	 */
	readonly defaultDirectiveTtl?: number;
}

// ── Reflection Types ───────────────────────────────────────────────────────

/**
 * An actionable insight extracted from post-execution reflection.
 *
 * Insights are the primary output of the reflection cycle. They
 * represent patterns, lessons, and recommendations that can be
 * injected into future planning and coordination decisions.
 */
export interface ExecutionInsight {
	/** Unique identifier for this insight. */
	readonly id: string;

	/** Category of the insight. */
	readonly category:
		| "decomposition"
		| "sharing"
		| "coordination"
		| "performance"
		| "tooling";

	/** Confidence that this insight is valid and useful (0.0–1.0). */
	readonly confidence: number;

	/**
	 * The insight itself — a concise, actionable statement.
	 *
	 * Examples:
	 * - "Splitting frontend and backend into separate agents works well when there's a clear API contract"
	 * - "The test-writer agent needs the full API contract (routes + schemas), not just file paths"
	 * - "Tasks involving a single language and framework should use a single agent"
	 */
	readonly insight: string;

	/**
	 * Under what conditions this insight applies.
	 *
	 * Examples:
	 * - "When the task involves building an API and writing tests for it"
	 * - "When multiple agents share filesystem access"
	 */
	readonly applicableWhen: string;

	/**
	 * Polarity of the insight.
	 * - `positive`: Something that worked well and should be replicated
	 * - `negative`: Something that went wrong and should be avoided
	 * - `neutral`: An observation without clear positive/negative valence
	 */
	readonly polarity: "positive" | "negative" | "neutral";

	/** ISO-8601 timestamp of creation. */
	readonly timestamp: string;
}

/**
 * The full output of the post-execution reflection cycle.
 *
 * Contains the LLM's analysis of the execution quality along with
 * extracted insights that will influence future executions.
 */
export interface ExecutionReflection {
	/** The task that was executed. */
	readonly task: string;

	/** The strategy that was used. */
	readonly strategy: ExecutionStrategy;

	/**
	 * Overall effectiveness rating of the execution (0.0–1.0).
	 * - 0.0 = Complete failure, wrong approach
	 * - 0.5 = Partially successful, significant issues
	 * - 1.0 = Excellent execution, optimal coordination
	 */
	readonly effectivenessScore: number;

	/**
	 * Free-text analysis of the execution quality.
	 * Covers what worked, what didn't, and why.
	 */
	readonly analysis: string;

	/**
	 * Assessment of whether the decomposition was appropriate.
	 * - `optimal`: The strategy was the right choice
	 * - `over-decomposed`: Should have used fewer agents
	 * - `under-decomposed`: Should have used more agents
	 * - `wrong-boundaries`: The subtask boundaries were wrong
	 */
	readonly decompositionAssessment:
		| "optimal"
		| "over-decomposed"
		| "under-decomposed"
		| "wrong-boundaries";

	/**
	 * Assessment of information sharing quality.
	 * - `optimal`: Right amount and quality of sharing
	 * - `over-shared`: Too much information flow, agents were distracted
	 * - `under-shared`: Not enough information flow, agents were siloed
	 * - `wrong-content`: Information was shared but not the right content
	 */
	readonly sharingAssessment:
		| "optimal"
		| "over-shared"
		| "under-shared"
		| "wrong-content";

	/** Extracted insights from the reflection. */
	readonly insights: ExecutionInsight[];

	/** ISO-8601 timestamp of the reflection. */
	readonly timestamp: string;

	/** Duration of the original execution in milliseconds. */
	readonly executionDurationMs: number;
}

/**
 * Configuration for the post-execution reflection engine.
 */
export interface ReflectionConfig {
	/**
	 * Enable or disable post-execution reflection.
	 * Default: true for multi-agent executions, false for single-agent.
	 */
	readonly enabled?: boolean;

	/**
	 * Maximum number of insights to retain across executions.
	 * Oldest insights are evicted when this limit is reached.
	 * Default: 30.
	 */
	readonly maxInsights?: number;

	/**
	 * Minimum effectiveness score of an execution for its insights
	 * to be considered "validated positive patterns".
	 * Insights from executions below this threshold are still stored
	 * but marked with lower confidence.
	 * Default: 0.7.
	 */
	readonly positivePatternThreshold?: number;

	/**
	 * Maximum number of insights to include in planner prompts.
	 * Controls the token budget for insight injection.
	 * Default: 8.
	 */
	readonly maxInsightsInPrompt?: number;

	/**
	 * Minimum confidence for an insight to be included in prompts.
	 * Insights below this threshold are stored but not injected.
	 * Default: 0.6.
	 */
	readonly minInsightConfidence?: number;

	/**
	 * Whether to reflect on single-agent executions.
	 * Usually not worth the token cost. Default: false.
	 */
	readonly reflectOnSingleAgent?: boolean;
}

// ── Planner Memory ─────────────────────────────────────────────────────────

/**
 * Condensed memory of a previous planning + execution cycle.
 *
 * Stored by the TaskPlanner between analyze() calls and injected
 * as context into subsequent planning prompts. This enables the
 * planner to make informed decisions about follow-up tasks without
 * carrying the full conversation history.
 *
 * The memory is intentionally small (~500-800 tokens) to avoid
 * bloating the planner's context window over multiple cycles.
 */
export interface PlannerMemory {
	/**
	 * The original task that was planned.
	 * Truncated to 200 chars for memory efficiency.
	 */
	readonly task: string;

	/**
	 * The strategy chosen by the planner (single/multi).
	 */
	readonly strategy: ExecutionStrategy;

	/**
	 * Brief list of subtask roles executed.
	 * Example: ["api-developer", "test-writer"]
	 */
	readonly roles: string[];

	/**
	 * Execution outcome summary.
	 * Example: "2/3 subtasks succeeded. api-developer and test-writer completed. docs-writer failed (timeout)."
	 */
	readonly outcome: string;

	/**
	 * Key files created or modified during execution.
	 * Limited to 15 entries.
	 */
	readonly filesAffected: string[];

	/**
	 * Lessons learned — what worked well or poorly.
	 * Example: "Multi-agent split worked well for API+tests. Documentation agent timed out — consider single-agent for docs."
	 */
	readonly lessons: string;

	/**
	 * ISO-8601 timestamp of when this memory was created.
	 */
	readonly timestamp: string;
}

// ── Decision Journal ───────────────────────────────────────────────────────

/**
 * A condensed record of a decision made by the sharing or notification analyzer.
 *
 * Each entry captures the essential information about a past decision
 * to provide context for future decisions without accumulating full
 * conversation history.
 */
export interface DecisionJournalEntry {
	/** ISO-8601 timestamp of the decision. */
	readonly timestamp: string;

	/** Type of decision: sharing or notification. */
	readonly type: "sharing" | "notification";

	/** The agent that produced the delta being evaluated. */
	readonly sourceAgentName: string;

	/**
	 * For sharing decisions: the target agent name.
	 * For notification decisions: "user".
	 */
	readonly targetName: string;

	/** The delta type that triggered the evaluation. */
	readonly deltaType: string;

	/** Whether the decision was positive (share/notify) or negative (skip). */
	readonly approved: boolean;

	/**
	 * Condensed reasoning for the decision (max ~120 chars).
	 * Extracted from the LLM's reasoning field.
	 */
	readonly reasoningSummary: string;
}

/**
 * Configuration for a DecisionJournal instance.
 */
export interface DecisionJournalConfig {
	/**
	 * Maximum number of entries retained in the journal.
	 * Oldest entries are evicted when the limit is reached.
	 * Default: 15
	 */
	readonly maxEntries?: number;

	/**
	 * Maximum number of entries included in the LLM prompt.
	 * Should be <= maxEntries. Entries beyond this are still stored
	 * for analytics but not shown to the LLM.
	 * Default: 8
	 */
	readonly maxEntriesInPrompt?: number;

	/**
	 * Maximum character length of the reasoningSummary per entry.
	 * Truncated with "…" if exceeded.
	 * Default: 120
	 */
	readonly maxReasoningLength?: number;
}

// ── Agent Pool Configuration ───────────────────────────────────────────────

/**
 * Configuration for the AgentPool orchestrator.
 */
export interface AgentPoolConfig {
	/** OpenRouter API key for all LLM conversations. */
	readonly openRouterApiKey: string;

	/**
	 * Model to use for orchestration conversations.
	 * Defaults to `"anthropic/claude-sonnet-4"`.
	 */
	readonly model?: string;

	/**
	 * Configure which log outputs are active for the pool **and** all
	 * spawned agents.
	 *
	 * This controls the pool's own logger as well as being forwarded
	 * automatically to every agent created by the pool.
	 *
	 * - `console: false` → no console output from the pool or its agents
	 * - `seq: false`     → no logs are sent to Seq
	 *
	 * Individual agents inherit this setting unless explicitly overridden
	 * via `agentConfig.logOutput`.
	 */
	readonly logOutput?: LogOutputConfig;

	/**
	 * Minimum pino log level for the pool and all spawned agents.
	 * Defaults to `"info"`.
	 *
	 * Automatically forwarded to every agent created by the pool.
	 * Can be overridden per-agent via `agentConfig.logLevel`.
	 */
	readonly logLevel?: pino.Level;

	/**
	 * Working directory for all spawned agents.
	 * Defaults to `process.cwd()`.
	 *
	 * Automatically forwarded to every agent created by the pool.
	 * Can be overridden per-agent via `agentConfig.cwd`.
	 */
	readonly cwd?: string;

	/**
	 * Additional agent-specific configuration applied to all spawned agents.
	 *
	 * Pool-level `logOutput`, `logLevel`, and `cwd` are automatically
	 * forwarded to agents. Only use `agentConfig` for agent-specific
	 * settings such as `autoApprove`, `executable`, or `mcpServers`.
	 *
	 * If `agentConfig` also specifies `logOutput`, `logLevel`, or `cwd`,
	 * those values take precedence over the pool-level defaults.
	 */
	readonly agentConfig?: AgentConfig;

	/**
	 * Maximum number of concurrent agents.
	 * Defaults to 5.
	 */
	readonly maxAgents?: number;

	/**
	 * Maximum retry attempts for OpenRouter API calls.
	 * Defaults to 3.
	 */
	readonly maxRetries?: number;

	/**
	 * Temperature for LLM generation.
	 * Lower values produce more deterministic planning.
	 * Defaults to 0.2.
	 */
	readonly temperature?: number;

	/**
	 * Optional per-conversation-role model overrides.
	 *
	 * When provided, the specified model will be used for all LLM calls
	 * within that conversation role, instead of the pool's default model.
	 * Useful for routing simple classification tasks (intent, sharing)
	 * to a faster/cheaper model while keeping the main model for planning.
	 *
	 * @example
	 * ```ts
	 * modelOverrides: {
	 *   [ConversationRole.INTENT_ANALYZER]: "openai/gpt-4o-mini",
	 *   [ConversationRole.CONTEXT_ANALYZER]: "openai/gpt-4o-mini",
	 * }
	 * ```
	 */
	readonly modelOverrides?: Partial<Record<ConversationRole, string>>;

	/**
	 * Subtask timeout configuration.
	 *
	 * When specified, each subtask execution is bounded by a timeout.
	 * Agents that exceed the timeout are destroyed and the subtask
	 * is either retried or marked as failed.
	 *
	 * Default: { subtaskTimeoutMs: 300_000 } (5 minutes).
	 * Set `subtaskTimeoutMs: 0` or `subtaskTimeoutMs: Infinity` to disable.
	 */
	readonly timeout?: SubtaskTimeoutConfig;

	/**
	 * Subtask retry configuration.
	 *
	 * When specified, failed subtasks can be retried with fresh agent instances.
	 * The retry prompt includes error context from the previous attempt.
	 *
	 * Default: { maxRetries: 1, includeErrorContext: true, retryDelayMs: 2000, retryOnTimeout: true }.
	 * Set `maxRetries: 0` to disable retries.
	 */
	readonly retry?: SubtaskRetryConfig;

	/**
	 * Whether adaptive replanning is enabled.
	 * When enabled, the pool will consult the planner when subtasks fail
	 * after retries, when deadlocks are detected, or when cascading
	 * failures suggest the plan is unviable.
	 *
	 * Default: true
	 */
	readonly enableReplanning?: boolean;

	/**
	 * Maximum number of replanning attempts per execution.
	 * Prevents infinite replan loops.
	 *
	 * Default: 2
	 */
	readonly maxReplanAttempts?: number;

	/**
	 * Configuration for mid-execution checkpoints.
	 *
	 * Checkpoints evaluate overall execution health and detect issues
	 * proactively. Only active for multi-agent executions.
	 *
	 * @default { enabled: true, completionPercentages: 50, deltaInterval: 30, timeIntervalMs: 60000 }
	 */
	readonly checkpoints?: CheckpointConfig;

	/**
	 * Optional factory function for creating agents.
	 *
	 * When provided, the pool uses this factory instead of directly
	 * instantiating `Agent` objects. This enables testing without
	 * requiring a real ACP executable.
	 *
	 * The factory receives the agent config and returns an object
	 * that conforms to the agent interface used by the pool.
	 */
	readonly createAgent?: AgentFactory;

	/**
	 * Configuration for the ORCHESTRATOR (meta-reflection cross-conversation).
	 * Activated automatically for multi-agent executions.
	 * Disabled for single-agent executions (unnecessary).
	 */
	readonly orchestrator?: OrchestratorConfig;

	/**
	 * Configuration for post-execution reflection.
	 * Enabled by default for multi-agent executions.
	 */
	readonly reflection?: ReflectionConfig;
}

// ── Agent Abstraction ──────────────────────────────────────────────────────

/**
 * Minimal interface that the AgentPool requires from an agent.
 *
 * This is a structural subset of the `Agent` class, allowing the pool
 * to work with both real agents and test mocks without importing
 * or depending on the Agent class directly at the type level.
 */
export interface PoolManagedAgent {
	readonly identity: AgentIdentity;
	readonly id: string;
	readonly name: string;
	readonly status: AgentStatus;
	readonly ready: Promise<void>;

	prompt(text: string): Promise<PromptResult>;
	injectContext(instructions: string | StructuredContextInjection): void;
	snapshot(): {
		identity: AgentIdentity;
		status: AgentStatus;
		sessionId: string | null;
		promptCount: number;
		pendingContextCount: number;
	};
	destroy(): Promise<void>;

	on(event: string, listener: (...args: unknown[]) => void): unknown;
	once(event: string, listener: (...args: unknown[]) => void): unknown;
	off(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * Factory function for creating agents.
 * Used for dependency injection in tests.
 */
export type AgentFactory = (config?: AgentConfig) => PoolManagedAgent;

// ── Agent Pool Result ──────────────────────────────────────────────────────

/**
 * The complete result of an AgentPool task execution.
 */
export interface AgentPoolResult {
	/** The original task description. */
	readonly task: string;

	/** The execution strategy that was chosen. */
	readonly strategy: ExecutionStrategy;

	/** The task analysis produced by the planner. */
	readonly analysis: TaskAnalysis;

	/** Results from each agent that participated. */
	readonly agents: AgentExecutionResult[];

	/** An LLM-generated summary of the overall execution. */
	readonly summary: string;

	/** Total execution time in milliseconds. */
	readonly durationMs: number;

	/** Post-execution reflection with effectiveness analysis and insights, if performed. */
	readonly reflection?: ExecutionReflection;
}

/**
 * The result of a single agent's execution within the pool.
 */
export interface AgentExecutionResult {
	/** The agent's unique ID. */
	readonly agentId: string;

	/** The agent's human-friendly name. */
	readonly agentName: string;

	/** The subtask that was assigned. */
	readonly subtask: SubTask;

	/** The prompt result from the agent. */
	readonly promptResult: PromptResult;

	/** Significant context events captured during execution. */
	readonly events: ContextEvent[];

	/** Files written during execution. */
	readonly filesWritten: string[];

	/** Whether the agent completed successfully. */
	readonly success: boolean;

	/** Error message if the agent failed. */
	readonly error?: string;

	/**
	 * Number of retry attempts made for this subtask.
	 * 0 means the subtask succeeded (or failed) on the first attempt.
	 */
	readonly retryCount: number;

	/**
	 * Whether this subtask was terminated due to a timeout.
	 * `true` means the agent exceeded the configured timeout and was destroyed.
	 */
	readonly timedOut: boolean;

	/**
	 * Duration in milliseconds for this subtask's execution
	 * (last attempt only — does not include retry delays).
	 */
	readonly subtaskDurationMs: number;
}

// ── Pool State ─────────────────────────────────────────────────────────────

/**
 * Read-only snapshot of the pool's current state.
 */
export interface AgentPoolState {
	/** Whether the pool is currently executing a task. */
	readonly executing: boolean;

	/** The current task description, if any. */
	readonly currentTask: string | null;

	/** The chosen execution strategy, if planning is complete. */
	readonly strategy: ExecutionStrategy | null;

	/** Number of active agents. */
	readonly activeAgentCount: number;

	/** Snapshots of all managed agents. */
	readonly agents: Array<{
		readonly agentId: string;
		readonly agentName: string;
		readonly status: AgentStatus;
		readonly taskRole: string;
		readonly completed: boolean;
	}>;

	/** Whether notifications are enabled. */
	readonly notificationsEnabled: boolean;

	/** Total deltas detected during the current execution. */
	readonly deltaCount: number;

	/** Total sharing decisions made. */
	readonly sharingDecisionCount: number;

	/** Number of subtask retries performed during current execution. */
	readonly retryCount: number;

	/** Number of subtask timeouts triggered during current execution. */
	readonly timeoutCount: number;

	/**
	 * Pending approval requests from agents waiting for user authorization.
	 *
	 * Only populated when `agentConfig.autoApprove` is `false`.
	 * Each entry represents a tool call that an agent is blocked on,
	 * waiting for the user to approve or deny.
	 */
	readonly pendingApprovals: Array<{
		readonly agentId: string;
		readonly agentName: string;
		readonly toolCallId: string;
		readonly toolCallTitle: string;
		readonly timestamp: string;
	}>;

	/**
	 * Number of execution memories stored by the planner.
	 * These memories influence future planning decisions by providing
	 * context about previous executions in this session.
	 */
	readonly plannerMemoryCount: number;

	/** Number of orchestrator assessments performed in the current execution. */
	readonly orchestratorAssessmentCount: number;

	/** Number of currently active orchestrator directives. */
	readonly activeDirectiveCount: number;

	/** Most recent coherence score from the orchestrator, or null. */
	readonly coherenceScore: number | null;

	/** Number of post-execution reflections performed. */
	readonly reflectionCount: number;

	/** Number of stored execution insights. */
	readonly insightCount: number;

	/** Most recent effectiveness score, or null. */
	readonly lastEffectivenessScore: number | null;
}

// ── Pool Event Map ─────────────────────────────────────────────────────────

/** Base fields present on every pool event. */
export interface BasePoolEvent {
	readonly event: PoolEvent;
	readonly timestamp: string;
}

export interface TaskReceivedEvent extends BasePoolEvent {
	readonly event: PoolEvent.TASK_RECEIVED;
	readonly task: string;
}

export interface PlanningStartEvent extends BasePoolEvent {
	readonly event: PoolEvent.PLANNING_START;
	readonly task: string;
}

export interface PlanningCompleteEvent extends BasePoolEvent {
	readonly event: PoolEvent.PLANNING_COMPLETE;
	readonly analysis: TaskAnalysis;
}

export interface AgentSpawnedEvent extends BasePoolEvent {
	readonly event: PoolEvent.AGENT_SPAWNED;
	readonly agentId: string;
	readonly agentName: string;
	readonly subtask: SubTask;
}

export interface AgentCompletedEvent extends BasePoolEvent {
	readonly event: PoolEvent.AGENT_COMPLETED;
	readonly agentId: string;
	readonly agentName: string;
	readonly result: AgentExecutionResult;
}

export interface AgentErrorEvent extends BasePoolEvent {
	readonly event: PoolEvent.AGENT_ERROR;
	readonly agentId: string;
	readonly agentName: string;
	readonly error: string;
}

export interface DeltaDetectedEvent extends BasePoolEvent {
	readonly event: PoolEvent.DELTA_DETECTED;
	readonly delta: ContextDelta;
}

export interface SharingDecisionEvent extends BasePoolEvent {
	readonly event: PoolEvent.SHARING_DECISION;
	readonly decision: SharingDecision;
}

export interface ContextSharedEvent extends BasePoolEvent {
	readonly event: PoolEvent.CONTEXT_SHARED;
	readonly sourceAgentId: string;
	readonly targetAgentId: string;
	readonly information: string;
}

export interface NotificationEvent extends BasePoolEvent {
	readonly event: PoolEvent.NOTIFICATION;
	readonly notification: UserNotification;
}

export interface ExecutionCompleteEvent extends BasePoolEvent {
	readonly event: PoolEvent.EXECUTION_COMPLETE;
	readonly result: AgentPoolResult;
}

export interface PoolErrorEvent extends BasePoolEvent {
	readonly event: PoolEvent.ERROR;
	readonly error: string;
	readonly context: string;
}

export interface PoolDestroyedEvent extends BasePoolEvent {
	readonly event: PoolEvent.DESTROYED;
}

export interface ReplanStartEvent extends BasePoolEvent {
	readonly event: PoolEvent.REPLAN_START;
	readonly trigger: ReplanTrigger;
	readonly problemDescription: string;
}

export interface ReplanCompleteEvent extends BasePoolEvent {
	readonly event: PoolEvent.REPLAN_COMPLETE;
	readonly decision: ReplanDecision;
}

export interface CheckpointEvaluatedEvent extends BasePoolEvent {
	readonly event: PoolEvent.CHECKPOINT_EVALUATED;
	readonly result: CheckpointResult;
}

export interface OrchestratorAssessmentEvent extends BasePoolEvent {
	readonly event: PoolEvent.ORCHESTRATOR_ASSESSMENT;
	readonly assessment: OrchestratorAssessment;
}

export interface ReflectionCompleteEvent extends BasePoolEvent {
	readonly event: PoolEvent.REFLECTION_COMPLETE;
	readonly reflection: ExecutionReflection;
}

export interface AgentTimeoutEvent extends BasePoolEvent {
	readonly event: PoolEvent.AGENT_TIMEOUT;
	readonly agentId: string;
	readonly agentName: string;
	readonly subtaskId: string;
	readonly timeoutMs: number;
	readonly elapsedMs: number;
}

export interface AgentRetryEvent extends BasePoolEvent {
	readonly event: PoolEvent.AGENT_RETRY;
	readonly agentId: string;
	readonly agentName: string;
	readonly subtaskId: string;
	readonly attempt: number;
	readonly maxRetries: number;
	readonly previousError: string;
}

/**
 * Emitted when an agent requires user approval to proceed with a tool call.
 *
 * Only emitted when `agentConfig.autoApprove` is `false`. The `resolve`
 * callback MUST be invoked to approve (`true`) or deny (`false`) the
 * request. The requesting agent blocks until resolved — other agents
 * in the pool continue executing unaffected.
 *
 * Approvals can also be resolved via `pool.send()` using natural
 * language (e.g. "yes, continue" or "authorize Agent-X").
 */
export interface ApproveRequestPoolEvent extends BasePoolEvent {
	readonly event: PoolEvent.APPROVE_REQUEST;
	/** The agent requesting approval. */
	readonly agentId: string;
	/** The agent's human-friendly name. */
	readonly agentName: string;
	/** The tool call that requires approval. */
	readonly toolCallId: string;
	/** Human-readable title of the tool call. */
	readonly toolCallTitle: string;
	/**
	 * Callback to approve (`true`) or deny (`false`) the request.
	 * Calling this unblocks the agent. Can only be called once.
	 */
	readonly resolve: (approved: boolean) => void;
}

/** Maps each PoolEvent to its corresponding payload type. */
export interface PoolEventMap {
	[PoolEvent.TASK_RECEIVED]: TaskReceivedEvent;
	[PoolEvent.PLANNING_START]: PlanningStartEvent;
	[PoolEvent.PLANNING_COMPLETE]: PlanningCompleteEvent;
	[PoolEvent.AGENT_SPAWNED]: AgentSpawnedEvent;
	[PoolEvent.AGENT_COMPLETED]: AgentCompletedEvent;
	[PoolEvent.AGENT_ERROR]: AgentErrorEvent;
	[PoolEvent.AGENT_TIMEOUT]: AgentTimeoutEvent;
	[PoolEvent.AGENT_RETRY]: AgentRetryEvent;
	[PoolEvent.DELTA_DETECTED]: DeltaDetectedEvent;
	[PoolEvent.SHARING_DECISION]: SharingDecisionEvent;
	[PoolEvent.CONTEXT_SHARED]: ContextSharedEvent;
	[PoolEvent.NOTIFICATION]: NotificationEvent;
	[PoolEvent.EXECUTION_COMPLETE]: ExecutionCompleteEvent;
	[PoolEvent.ERROR]: PoolErrorEvent;
	[PoolEvent.DESTROYED]: PoolDestroyedEvent;
	[PoolEvent.APPROVE_REQUEST]: ApproveRequestPoolEvent;
	[PoolEvent.REPLAN_START]: ReplanStartEvent;
	[PoolEvent.REPLAN_COMPLETE]: ReplanCompleteEvent;
	[PoolEvent.CHECKPOINT_EVALUATED]: CheckpointEvaluatedEvent;
	[PoolEvent.ORCHESTRATOR_ASSESSMENT]: OrchestratorAssessmentEvent;
	[PoolEvent.REFLECTION_COMPLETE]: ReflectionCompleteEvent;
}
