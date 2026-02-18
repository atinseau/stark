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

  /** Real-time context delta analysis for user notifications. */
  CONTEXT_ANALYZER = "context-analyzer",

  /**
   * Cross-agent information sharing evaluation.
   *
   * Dedicated conversation for the InformationBroker to evaluate
   * whether deltas from one agent should be shared with others.
   * Separated from CONTEXT_ANALYZER to enable:
   * - Specialized system prompts for sharing vs notification
   * - Independent model overrides (e.g., fast model for notifications, powerful for sharing)
   * - Future independent conversation history management
   */
  SHARING_ANALYZER = "sharing-analyzer",

  /** User-facing interaction and response generation. */
  USER_INTERACTION = "user-interaction",

  /** User intent classification and routing. */
  INTENT_ANALYZER = "intent-analyzer",

  /**
   * Meta-orchestrator for cross-conversation coordination.
   *
   * Periodically evaluates coordination quality across all active
   * agents and emits directives to improve coherence between the
   * sharing, notification, planning, and checkpoint subsystems.
   */
  ORCHESTRATOR = "orchestrator",

  /**
   * Post-execution reflection and insight extraction.
   *
   * Dedicated conversation for the ReflectionEngine to analyze
   * completed executions and extract reusable insights.
   * Separated from USER_INTERACTION to use a specialized system
   * prompt optimized for structured JSON reflection output.
   */
  REFLECTION = "reflection",
}
