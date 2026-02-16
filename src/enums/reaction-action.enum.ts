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
