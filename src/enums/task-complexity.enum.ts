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
