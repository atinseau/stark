/**
 * All event types emitted by an AgentPool instance.
 *
 * Events are grouped by domain:
 *   - `pool:*`     → Pool lifecycle and orchestration events
 *   - `agent:*`    → Agent-level events forwarded from managed agents
 */
export enum PoolEvent {
	/** A new task has been received for execution. */
	TASK_RECEIVED = "pool:task-received",

	/** The planning conversation has started analyzing the task. */
	PLANNING_START = "pool:planning-start",

	/** The planning conversation has completed its analysis. */
	PLANNING_COMPLETE = "pool:planning-complete",

	/** A new agent has been spawned to handle a subtask. */
	AGENT_SPAWNED = "pool:agent-spawned",

	/** An agent has completed its assigned subtask. */
	AGENT_COMPLETED = "pool:agent-completed",

	/** An agent encountered an error during execution. */
	AGENT_ERROR = "pool:agent-error",

	/** A context delta was detected from an agent's activity. */
	DELTA_DETECTED = "pool:delta-detected",

	/** The information broker made a sharing decision. */
	SHARING_DECISION = "pool:sharing-decision",

	/** Context was shared from one agent to another. */
	CONTEXT_SHARED = "pool:context-shared",

	/** A notification was generated for the user. */
	NOTIFICATION = "pool:notification",

	/** The full execution pipeline has completed. */
	EXECUTION_COMPLETE = "pool:execution-complete",

	/** A pool-level error occurred. */
	ERROR = "pool:error",

	/** The pool has been destroyed. */
	DESTROYED = "pool:destroyed",
}

/**
 * Identifies the purpose of each isolated LLM conversation.
 *
 * Each role maps to a separate conversation with its own message
 * history, system prompt, and token budget. This separation prevents
 * cross-contamination between planning, analysis, and interaction.
 */
export enum ConversationRole {
	/** Strategic task analysis and decomposition. */
	PLANNER = "planner",

	/** Real-time context delta analysis and reaction. */
	CONTEXT_ANALYZER = "context-analyzer",

	/** User-facing interaction and response generation. */
	USER_INTERACTION = "user-interaction",

	/** User intent classification and routing. */
	INTENT_ANALYZER = "intent-analyzer",
}

/**
 * Execution strategy decided by the planner.
 */
export enum ExecutionStrategy {
	/** A single agent handles the entire task. */
	SINGLE = "single",

	/** Multiple agents collaborate on decomposed subtasks. */
	MULTI = "multi",
}

/**
 * Task complexity levels assessed by the planner.
 */
export enum TaskComplexity {
	/** Straightforward task, no decomposition needed. */
	SIMPLE = "simple",

	/** Moderate complexity, decomposition may or may not help. */
	MODERATE = "moderate",

	/** High complexity, strong candidate for multi-agent decomposition. */
	COMPLEX = "complex",
}

/**
 * Types of context deltas detected from agent activity.
 */
export enum DeltaType {
	/** An agent completed a prompt response. */
	PROMPT_COMPLETE = "prompt_complete",

	/** An agent completed a tool call. */
	TOOL_COMPLETE = "tool_complete",

	/** An agent's tool call failed. */
	TOOL_FAILED = "tool_failed",

	/** An agent encountered an error. */
	AGENT_ERROR = "agent_error",

	/** An agent transitioned to a new status. */
	STATUS_CHANGE = "status_change",

	/** An agent's execution plan was updated. */
	PLAN_UPDATE = "plan_update",

	/** A file was written by an agent. */
	FILE_WRITTEN = "file_written",

	/** A file was read by an agent. */
	FILE_READ = "file_read",
}

/**
 * Actions the context reaction engine can recommend.
 */
export enum ReactionAction {
	/** No action needed — the delta is not significant. */
	IGNORE = "ignore",

	/** Share information with another agent. */
	SHARE = "share",

	/** Notify the user about the change. */
	NOTIFY = "notify",

	/** Request clarification from the user. */
	CLARIFY = "clarify",
}

/**
 * Types of user intents detected by the intent analyzer.
 */
export enum UserIntent {
	/** The user wants to execute a new task. */
	NEW_TASK = "new_task",

	/** The user wants to enable or configure notifications. */
	NOTIFICATION_PREFERENCE = "notification_preference",

	/** The user is asking about current status or progress. */
	STATUS_QUERY = "status_query",

	/** The user wants to inject context into running agents. */
	CONTEXT_INJECTION = "context_injection",

	/** The user wants to cancel or stop execution. */
	CANCEL = "cancel",

	/** The intent could not be determined. */
	UNKNOWN = "unknown",
}
