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
