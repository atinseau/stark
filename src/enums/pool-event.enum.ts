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

	/**
	 * An agent exceeded its subtask timeout and was destroyed.
	 *
	 * Emitted before a retry attempt (if configured) or before
	 * marking the subtask as failed.
	 */
	AGENT_TIMEOUT = "pool:agent-timeout",

	/**
	 * A failed subtask is being retried with a fresh agent.
	 *
	 * Emitted when a subtask that failed (error or timeout) is
	 * about to be retried. The payload includes the attempt number
	 * and the error from the previous attempt.
	 */
	AGENT_RETRY = "pool:agent-retry",

	/**
	 * An agent in the pool requires user approval to proceed with a tool call.
	 *
	 * Only emitted when `agentConfig.autoApprove` is `false`. The event
	 * payload includes a `resolve(boolean)` callback that the listener
	 * MUST invoke to approve or deny the request. The requesting agent
	 * blocks until resolved — other agents continue unaffected.
	 */
	APPROVE_REQUEST = "pool:approve-request",

	/**
	 * A replanning evaluation has started.
	 *
	 * Emitted when the pool detects a condition that warrants re-evaluating
	 * the current execution plan (e.g. subtask failure after retries,
	 * deadlock, cascading failures). The payload includes the trigger
	 * and a human-readable problem description.
	 */
	REPLAN_START = "pool:replan-start",

	/**
	 * A replanning evaluation has completed with a decision.
	 *
	 * Emitted after the planner LLM has analyzed the situation and
	 * decided how to proceed (continue, modify, restart, or abort).
	 * The payload includes the full {@link ReplanDecision}.
	 */
	REPLAN_COMPLETE = "pool:replan-complete",
}
