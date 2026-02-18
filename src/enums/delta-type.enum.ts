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

	/** A conflict was detected between two agents' outputs or activities. */
	CONFLICT_DETECTED = "conflict_detected",
}
