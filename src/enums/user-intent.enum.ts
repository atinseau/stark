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

	/**
	 * The user is approving or denying a pending agent action.
	 *
	 * Detected when there are pending approval requests and the user
	 * sends a message that explicitly or implicitly authorizes an agent
	 * to proceed (e.g. "yes", "continue", "authorize Agent-X to use that tool")
	 * or denies it (e.g. "no", "deny", "don't allow that").
	 *
	 * Only classified when `autoApprove` is `false` and there are
	 * pending approvals in the pool.
	 */
	APPROVE_AGENT = "approve_agent",

	/** The intent could not be determined. */
	UNKNOWN = "unknown",
}
