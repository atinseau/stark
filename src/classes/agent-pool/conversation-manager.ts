import type pino from "pino";

import type { ConversationRole } from "../../enums/conversation-role.enum.ts";
import {
	compressionPrompt,
	compressionSystemPrompt,
} from "../../prompts/compression.ts";
import type {
	ChatOptions,
	Conversation,
	ConversationCompressionConfig,
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

	/**
	 * Callback appelé après chaque appel LLM réussi pour reporter la consommation.
	 * Injecté par l'AgentPool pour connecter le ConversationManager au CostTracker.
	 */
	private usageCallback:
		| ((
				role: ConversationRole,
				inputTokens: number,
				outputTokens: number,
				costUsd?: number,
		  ) => void)
		| null = null;

	/** Tracks how many times each conversation has been compressed. */
	private readonly compressionCounts = new Map<ConversationRole, number>();

	constructor(
		config: OpenRouterConfig,
		private readonly logger: pino.Logger,
	) {
		this.client = new OpenRouterClient(config, logger);
	}

	// ── Usage Tracking ─────────────────────────────────────────────────

	/**
	 * Définit le callback de tracking de consommation.
	 *
	 * Called by the AgentPool after construction to connect the
	 * ConversationManager's LLM calls to the CostTracker.
	 *
	 * @param callback - The function to call after each successful LLM call.
	 */
	setUsageCallback(
		callback: (
			role: ConversationRole,
			inputTokens: number,
			outputTokens: number,
			costUsd?: number,
		) => void,
	): void {
		this.usageCallback = callback;
	}

	/**
	 * Reports usage to the callback if one is set.
	 * Uses the heuristic estimate (chars / 4) as a fallback.
	 */
	private reportUsage(
		role: ConversationRole,
		contentLength: number,
		responseLength: number,
	): void {
		if (this.usageCallback) {
			const estimatedInputTokens = Math.ceil(contentLength / 4);
			const estimatedOutputTokens = Math.ceil(responseLength / 4);
			this.usageCallback(role, estimatedInputTokens, estimatedOutputTokens);
		}
	}

	// ── Registration ───────────────────────────────────────────────────

	/**
	 * Registers a new isolated conversation with the given role and
	 * system prompt. If a conversation with this role already exists,
	 * it is replaced (history is discarded).
	 *
	 * @param role         - The purpose of this conversation.
	 * @param systemPrompt - The system-level instructions for the LLM.
	 * @param model        - Optional model override for all LLM calls in this conversation.
	 */
	register(role: ConversationRole, systemPrompt: string, model?: string): void {
		this.conversations.set(role, {
			role,
			systemPrompt,
			messages: [{ role: "system", content: systemPrompt }],
			tokenCount: 0,
			model,
		});

		// Initialize compression counter
		this.compressionCounts.set(role, 0);

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

		const effectiveOptions: ChatOptions | undefined = conversation.model
			? { model: conversation.model, ...options }
			: options;

		try {
			const response = await this.client.chat(
				conversation.messages,
				effectiveOptions,
			);

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

			// Report usage to cost tracker
			this.reportUsage(role, content.length, response.length);

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

		const effectiveOptions: ChatOptions | undefined = conversation.model
			? { model: conversation.model, ...options }
			: options;

		const result = await this.client.chatJson(
			messagesForRequest,
			validator,
			effectiveOptions,
		);

		// Persist only the successful exchange in the conversation history
		conversation.messages.push({ role: "user", content });
		const resultStr = JSON.stringify(result);
		conversation.messages.push({
			role: "assistant",
			content: resultStr,
		});

		// Rough token estimate
		conversation.tokenCount += Math.ceil(
			(content.length + resultStr.length) / 4,
		);

		// Report usage to cost tracker
		this.reportUsage(role, content.length, resultStr.length);

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

		const effectiveOptions: ChatOptions | undefined = conversation.model
			? { model: conversation.model, ...options }
			: options;

		const response = await this.client.chat(messages, effectiveOptions);

		// Report usage to cost tracker
		this.reportUsage(role, content.length, response.length);

		return response;
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

		const effectiveOptions: ChatOptions | undefined = conversation.model
			? { model: conversation.model, ...options }
			: options;

		const result = await this.client.chatJson(
			messages,
			validator,
			effectiveOptions,
		);

		// Report usage to cost tracker
		const resultStr = JSON.stringify(result);
		this.reportUsage(role, content.length, resultStr.length);

		return result;
	}

	// ── Compression ────────────────────────────────────────────────────

	/**
	 * Vérifie si une conversation a besoin de compression.
	 *
	 * @param role - La conversation à vérifier.
	 * @param thresholdTokens - Le seuil de tokens au-delà duquel compresser.
	 * @returns `true` si la conversation dépasse le seuil.
	 */
	needsCompression(role: ConversationRole, thresholdTokens: number): boolean {
		const conversation = this.conversations.get(role);
		if (!conversation) return false;
		return conversation.tokenCount >= thresholdTokens;
	}

	/**
	 * Compresse l'historique d'une conversation en résumant les messages
	 * les plus anciens et en gardant les plus récents intacts.
	 *
	 * Le processus :
	 * 1. Calcule combien de messages garder (basé sur `retentionRatio`)
	 * 2. Envoie les messages à compresser au LLM via un one-shot call
	 * 3. Remplace les messages compressés par un unique message `system`
	 *    contenant le résumé
	 * 4. Préserve le system prompt original en première position
	 *
	 * @param role - La conversation à compresser.
	 * @param config - Configuration de compression.
	 * @returns Le nombre de tokens estimés économisés, ou 0 si pas de compression.
	 */
	async compress(
		role: ConversationRole,
		config: ConversationCompressionConfig,
	): Promise<number> {
		const conversation = this.conversations.get(role);
		if (!conversation) return 0;

		const messages = conversation.messages;

		// Minimum de 4 messages pour que la compression ait du sens
		// (system + au moins 3 user/assistant exchanges)
		if (messages.length < 4) return 0;

		// Check compression count limit
		const maxCompressions = config.maxCompressions ?? 3;
		const currentCompressions = this.compressionCounts.get(role) ?? 0;

		if (currentCompressions >= maxCompressions) {
			this.logger.warn(
				{ conversationRole: role, maxCompressions },
				`Max compressions reached for ${role}, performing hard reset`,
			);
			const savedTokens = conversation.tokenCount;
			this.reset(role);
			return savedTokens;
		}

		const retentionRatio = config.retentionRatio ?? 0.3;

		// Messages to keep (most recent) — exclude the system prompt
		const nonSystemMessages = messages.slice(1);
		const keepCount = Math.max(
			2,
			Math.ceil(nonSystemMessages.length * retentionRatio),
		);
		const compressCount = nonSystemMessages.length - keepCount;

		if (compressCount < 2) return 0; // Not enough to compress

		const messagesToCompress = nonSystemMessages.slice(0, compressCount);
		const messagesToKeep = nonSystemMessages.slice(compressCount);

		// Determine conversation purpose for the compression prompt
		const purposeMap: Record<string, string> = {
			planner: "Strategic task analysis and decomposition",
			"context-analyzer": "Notification evaluation for user-facing updates",
			"sharing-analyzer": "Cross-agent information sharing decisions",
			"user-interaction": "User-facing response generation",
			"intent-analyzer": "User intent classification",
			orchestrator: "Cross-conversation meta-reflection",
		};
		const purpose = purposeMap[role] ?? role;

		// Build the compression prompt
		const prompt = compressionPrompt({
			messageCount: messagesToCompress.length,
			conversationPurpose: purpose,
			messages: messagesToCompress.map((m) => ({
				role: m.role,
				content: m.content,
			})),
		});

		this.logger.info(
			{
				conversationRole: role,
				totalMessages: messages.length,
				compressing: compressCount,
				keeping: keepCount,
			},
			`Compressing ${compressCount} messages in ${role} conversation`,
		);

		try {
			// Use a one-shot call to avoid recursion (don't add to this conversation)
			const compressedSummary = await this.client.chat([
				{
					role: "system",
					content: compressionSystemPrompt({ maxLength: 2000 }),
				},
				{ role: "user", content: prompt },
			]);

			// Report usage for the compression call itself
			this.reportUsage(role, prompt.length, compressedSummary.length);

			// Estimate tokens saved
			const oldTokenCount = messagesToCompress.reduce(
				(acc, m) => acc + Math.ceil(m.content.length / 4),
				0,
			);
			const newTokenCount = Math.ceil(compressedSummary.length / 4);
			const tokensSaved = Math.max(0, oldTokenCount - newTokenCount);

			// Rebuild the conversation: system prompt + compressed summary + kept messages
			const compressedMessage: OpenRouterMessage = {
				role: "system",
				content: `[Compressed context from ${compressCount} earlier messages]\n\n${compressedSummary}`,
			};

			const systemPromptMessage = messages[0];
			if (!systemPromptMessage) return 0;

			conversation.messages = [
				systemPromptMessage, // Original system prompt
				compressedMessage,
				...messagesToKeep,
			];

			// Update token count
			conversation.tokenCount = conversation.messages.reduce(
				(acc, m) => acc + Math.ceil(m.content.length / 4),
				0,
			);

			// Track compression count
			this.compressionCounts.set(role, currentCompressions + 1);

			this.logger.info(
				{
					conversationRole: role,
					tokensSaved,
					newMessageCount: conversation.messages.length,
					newEstimatedTokens: conversation.tokenCount,
					compressionNumber: currentCompressions + 1,
				},
				`Compression complete: saved ~${tokensSaved} tokens`,
			);

			return tokensSaved;
		} catch (error) {
			this.logger.warn(
				{
					conversationRole: role,
					error: error instanceof Error ? error.message : String(error),
				},
				`Compression failed for ${role} — conversation left unchanged`,
			);
			return 0;
		}
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

		// Reset compression count on hard reset
		this.compressionCounts.set(role, 0);

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
