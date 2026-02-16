/**
 * Discriminator values for ACP session update notifications.
 *
 * Each member corresponds to one variant of the SDK's `SessionUpdate`
 * discriminated union (`sessionUpdate` field). Using an enum instead
 * of raw string literals keeps the router switch exhaustive and
 * gives a single source of truth for all update types.
 *
 * @see {@link https://agentclientprotocol.com Agent Client Protocol}
 */
export enum SessionUpdateType {
	/** Echo of a user message sent to the agent. */
	USER_MESSAGE_CHUNK = "user_message_chunk",

	/** A chunk of the agent's response text. */
	AGENT_MESSAGE_CHUNK = "agent_message_chunk",

	/** A chunk of the agent's internal reasoning / chain-of-thought. */
	AGENT_THOUGHT_CHUNK = "agent_thought_chunk",

	/** A new tool call was created by the agent. */
	TOOL_CALL = "tool_call",

	/** An existing tool call received a progress or completion update. */
	TOOL_CALL_UPDATE = "tool_call_update",

	/** The agent published or updated its execution plan. */
	PLAN = "plan",

	/** The set of available slash-commands changed. */
	AVAILABLE_COMMANDS_UPDATE = "available_commands_update",

	/** The agent's session mode changed (e.g. "ask", "code", "architect"). */
	CURRENT_MODE_UPDATE = "current_mode_update",

	/** A session configuration option was updated. */
	CONFIG_OPTION_UPDATE = "config_option_update",

	/** Session metadata (e.g. title) was updated. */
	SESSION_INFO_UPDATE = "session_info_update",

	/** Token usage and/or cost information was updated. */
	USAGE_UPDATE = "usage_update",
}
