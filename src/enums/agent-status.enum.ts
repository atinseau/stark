/**
 * Lifecycle states of an Agent instance.
 *
 * Transitions:
 *   INITIALIZING → IDLE → BUSY → IDLE
 *                              ↘ ERROR → IDLE (on retry)
 *   Any state    → DESTROYED
 */
export enum AgentStatus {
	/** Agent is being set up: spawning process, initializing ACP, creating session. */
	INITIALIZING = "initializing",

	/** Agent is ready and waiting for instructions. */
	IDLE = "idle",

	/** Agent is actively processing a prompt. */
	BUSY = "busy",

	/** Agent encountered an unrecoverable error during the last operation. */
	ERROR = "error",

	/** Agent has been shut down and cannot be reused. */
	DESTROYED = "destroyed",
}
