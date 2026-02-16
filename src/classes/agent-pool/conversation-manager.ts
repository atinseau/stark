import type pino from "pino";

import type { ConversationRole } from "../../enums/conversation-role.enum.ts";
import type {
	ChatOptions,
	Conversation,
	OpenRouterConfig,
	OpenRouterMessage,
} from "../../types/agent-pool.types.ts";
import { OpenRouterClient } from "./openrouter-client.ts";

// ── ConversationManager ────────────────────────────────────────────────────

/**
 * Manages multiple isolated LLM conversations, each with its own
 * message history, system prompt, and token budget.
 *
 * The isolation between conversations is a core architectural decision:
 *
 * - **Planner** conversation focuses on strategic task decomposition
 *   without being polluted by real-time context deltas.
 * - **Context Analyzer** conversation evaluates deltas without
 *   carrying the overhead of the full planning history.
 * - **Intent Analyzer** conversation classifies user messages
 *   independently of ongoing agent activity.
 * - **User Interaction** conversation handles user-facing responses
 *   with its own tone and context.
 *
 * Each conversation's message history grows independently, and token
 * counts are tracked per conversation to enable future budget management.
 *
 * The underlying {@link OpenRouterClient} is shared across all conversations
 * (it is stateless — the conversation state lives here).
 *
 * @example
 * ```ts
 * const manager = new ConversationManager(openRouterConfig, logger);
 *
 * manager.register(ConversationRole.PLANNER, "You are a strategic planner...");
 * manager.register(ConversationRole.CONTEXT_ANALYZER, "You analyze deltas...");
 *
 * const analysis = await manager.sendJson(
 *   ConversationRole.PLANNER,
 *   "Analyze this task: build a REST API",
 *   validateTaskAnalysis,
 * );
 * ```
 */
export class ConversationManager {
	/** All registered conversations, keyed by role. */
	private readonly conversations = new Map<ConversationRole, Conversation>();

	/** The shared OpenRouter client instance. */
	readonly client: OpenRouterClient;

	constructor(
		config: OpenRouterConfig,
		private readonly logger: pino.Logger,
	) {
		this.client = new OpenRouterClient(config, logger);
	}

	// ── Registration ───────────────────────────────────────────────────

	/**
	 * Registers a new isolated conversation with the given role and
	 * system prompt. If a conversation with this role already exists,
	 * it is replaced (history is discarded).
	 *
	 * @param role         - The purpose of this conversation.
	 * @param systemPrompt - The system-level instructions for the LLM.
	 */
	register(role: ConversationRole, systemPrompt: string): void {
		this.conversations.set(role, {
			role,
			systemPrompt,
			messages: [{ role: "system", content: systemPrompt }],
			tokenCount: 0,
		});

		this.logger.debug(
			{ conversationRole: role, systemPromptLength: systemPrompt.length },
			`Conversation registered: ${role}`,
		);
	}

	/**
	 * Returns whether a conversation with the given role has been registered.
	 */
	has(role: ConversationRole): boolean {
		return this.conversations.has(role);
	}

	// ── Messaging ──────────────────────────────────────────────────────

	/**
	 * Sends a user message to a specific conversation and returns the
	 * assistant's text response.
	 *
	 * The message and response are appended to the conversation's
	 * history, maintaining full context for future turns.
	 *
	 * @param role    - Which conversation to send the message to.
	 * @param content - The user message text.
	 * @param options - Optional per-request overrides.
	 * @returns The assistant's response text.
	 * @throws If the conversation role has not been registered.
	 */
	async send(
		role: ConversationRole,
		content: string,
		options?: ChatOptions,
	): Promise<string> {
		const conversation = this.getOrThrow(role);

		// Append the user message to history
		const userMessage: OpenRouterMessage = { role: "user", content };
		conversation.messages.push(userMessage);

		this.logger.debug(
			{
				conversationRole: role,
				messageCount: conversation.messages.length,
				contentLength: content.length,
			},
			`Sending message to ${role} conversation`,
		);

		try {
			const response = await this.client.chat(conversation.messages, options);

			// Append the assistant's response to history
			const assistantMessage: OpenRouterMessage = {
				role: "assistant",
				content: response,
			};
			conversation.messages.push(assistantMessage);

			// Rough token estimate (4 chars ≈ 1 token)
			conversation.tokenCount += Math.ceil(
				(content.length + response.length) / 4,
			);

			this.logger.debug(
				{
					conversationRole: role,
					responseLength: response.length,
					totalMessages: conversation.messages.length,
					estimatedTokens: conversation.tokenCount,
				},
				`Response received from ${role} conversation`,
			);

			return response;
		} catch (error) {
			// Remove the user message on failure so conversation stays clean
			const idx = conversation.messages.indexOf(userMessage);
			if (idx !== -1) {
				conversation.messages.splice(idx, 1);
			}
			throw error;
		}
	}

	/**
	 * Sends a user message to a specific conversation, parses the
	 * response as JSON, and validates it against a caller-supplied
	 * validator function.
	 *
	 * On JSON parse or validation failure, the client automatically
	 * sends correction prompts to guide the LLM toward a conformant
	 * response.
	 *
	 * **Note**: Because correction attempts are handled by the
	 * underlying `chatJson`, only the initial user message and the
	 * final valid assistant response are persisted in the conversation
	 * history. Intermediate correction attempts are discarded to avoid
	 * polluting the history with error-recovery chatter.
	 *
	 * @param role      - Which conversation to send the message to.
	 * @param content   - The user message text.
	 * @param validator - A function that validates and narrows the parsed JSON.
	 * @param options   - Optional per-request overrides.
	 * @returns The validated JSON object.
	 * @throws If validation fails after all correction attempts.
	 */
	async sendJson<T>(
		role: ConversationRole,
		content: string,
		validator: (data: unknown) => T | null | undefined,
		options?: ChatOptions,
	): Promise<T> {
		const conversation = this.getOrThrow(role);

		// Build the messages array for chatJson (includes history + new message)
		const messagesForRequest: OpenRouterMessage[] = [
			...conversation.messages,
			{ role: "user", content },
		];

		this.logger.debug(
			{
				conversationRole: role,
				messageCount: messagesForRequest.length,
				contentLength: content.length,
			},
			`Sending JSON request to ${role} conversation`,
		);

		const result = await this.client.chatJson(
			messagesForRequest,
			validator,
			options,
		);

		// Persist only the successful exchange in the conversation history
		conversation.messages.push({ role: "user", content });
		conversation.messages.push({
			role: "assistant",
			content: JSON.stringify(result),
		});

		// Rough token estimate
		conversation.tokenCount += Math.ceil(
			(content.length + JSON.stringify(result).length) / 4,
		);

		return result;
	}

	// ── One-shot (no history) ──────────────────────────────────────────

	/**
	 * Sends a one-shot message using a conversation's system prompt
	 * but WITHOUT appending to or reading from the conversation history.
	 *
	 * Useful for stateless analysis calls where you don't want to
	 * pollute the conversation's context window.
	 *
	 * @param role    - Which conversation's system prompt to use.
	 * @param content - The user message text.
	 * @param options - Optional per-request overrides.
	 * @returns The assistant's response text.
	 */
	async sendOneShot(
		role: ConversationRole,
		content: string,
		options?: ChatOptions,
	): Promise<string> {
		const conversation = this.getOrThrow(role);

		const messages: OpenRouterMessage[] = [
			{ role: "system", content: conversation.systemPrompt },
			{ role: "user", content },
		];

		return this.client.chat(messages, options);
	}

	/**
	 * Like `sendOneShot` but parses and validates the response as JSON.
	 *
	 * @param role      - Which conversation's system prompt to use.
	 * @param content   - The user message text.
	 * @param validator - A function that validates and narrows the parsed JSON.
	 * @param options   - Optional per-request overrides.
	 * @returns The validated JSON object.
	 */
	async sendOneShotJson<T>(
		role: ConversationRole,
		content: string,
		validator: (data: unknown) => T | null | undefined,
		options?: ChatOptions,
	): Promise<T> {
		const conversation = this.getOrThrow(role);

		const messages: OpenRouterMessage[] = [
			{ role: "system", content: conversation.systemPrompt },
			{ role: "user", content },
		];

		return this.client.chatJson(messages, validator, options);
	}

	// ── Introspection ──────────────────────────────────────────────────

	/**
	 * Returns a read-only snapshot of a conversation's current state.
	 *
	 * @param role - The conversation to inspect.
	 * @returns The conversation's metadata and statistics.
	 */
	getStats(role: ConversationRole): {
		messageCount: number;
		estimatedTokens: number;
		systemPromptLength: number;
	} | null {
		const conversation = this.conversations.get(role);
		if (!conversation) return null;

		return {
			messageCount: conversation.messages.length,
			estimatedTokens: conversation.tokenCount,
			systemPromptLength: conversation.systemPrompt.length,
		};
	}

	/**
	 * Returns the full message history for a conversation.
	 * Returns a defensive copy to prevent external mutation.
	 *
	 * @param role - The conversation to inspect.
	 * @returns The message array, or null if not registered.
	 */
	getHistory(role: ConversationRole): OpenRouterMessage[] | null {
		const conversation = this.conversations.get(role);
		if (!conversation) return null;
		return [...conversation.messages];
	}

	/**
	 * Resets a conversation's history back to just the system prompt.
	 * Useful for clearing accumulated context when token limits approach.
	 *
	 * @param role - The conversation to reset.
	 */
	reset(role: ConversationRole): void {
		const conversation = this.conversations.get(role);
		if (!conversation) return;

		conversation.messages = [
			{ role: "system", content: conversation.systemPrompt },
		];
		conversation.tokenCount = 0;

		this.logger.debug(
			{ conversationRole: role },
			`Conversation reset: ${role}`,
		);
	}

	/**
	 * Resets all registered conversations.
	 */
	resetAll(): void {
		for (const role of this.conversations.keys()) {
			this.reset(role);
		}
	}

	// ── Private ────────────────────────────────────────────────────────

	/**
	 * Retrieves a registered conversation or throws a descriptive error.
	 */
	private getOrThrow(role: ConversationRole): Conversation {
		const conversation = this.conversations.get(role);
		if (!conversation) {
			throw new Error(
				`ConversationManager: conversation "${role}" has not been registered. ` +
					`Call register(${role}, systemPrompt) before sending messages.`,
			);
		}
		return conversation;
	}
}
