/**
 * Execution strategy decided by the planner.
 */
export enum ExecutionStrategy {
	/** A single agent handles the entire task. */
	SINGLE = "single",

	/** Multiple agents collaborate on decomposed subtasks. */
	MULTI = "multi",
}
