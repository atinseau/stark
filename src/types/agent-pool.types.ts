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

// ── Intent Analysis Types ──────────────────────────────────────────────────

/**
 * Result of the intent analyzer's classification of a user message.
 */
export interface IntentAnalysis {
	/** The classified intent type. */
	readonly intent: UserIntent;

	/** Confidence score (0.0 to 1.0). */
	readonly confidence: number;

	/** Extracted parameters relevant to the intent. */
	readonly parameters: Record<string, unknown>;

	/** Human-readable reasoning. */
	readonly reasoning: string;
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
	injectContext(instructions: string): void;
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
	[PoolEvent.DELTA_DETECTED]: DeltaDetectedEvent;
	[PoolEvent.SHARING_DECISION]: SharingDecisionEvent;
	[PoolEvent.CONTEXT_SHARED]: ContextSharedEvent;
	[PoolEvent.NOTIFICATION]: NotificationEvent;
	[PoolEvent.EXECUTION_COMPLETE]: ExecutionCompleteEvent;
	[PoolEvent.ERROR]: PoolErrorEvent;
	[PoolEvent.DESTROYED]: PoolDestroyedEvent;
	[PoolEvent.APPROVE_REQUEST]: ApproveRequestPoolEvent;
}
