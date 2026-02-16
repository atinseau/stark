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
