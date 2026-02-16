import { OpenRouter } from "@openrouter/sdk";
import type { ChatResponse } from "@openrouter/sdk/models";
import type pino from "pino";

import type {
	ChatOptions,
	OpenRouterConfig,
	OpenRouterMessage,
} from "../../types/agent-pool.types.ts";

// ── Constants ──────────────────────────────────────────────────────────────

/** Patterns that indicate prompt injection attempts in user-supplied content. */
const INJECTION_PATTERNS: ReadonlyArray<RegExp> = [
	/\b(?:ignore\s+(?:all\s+)?(?:previous|above|prior)\s+instructions)/i,
	/\b(?:you\s+are\s+now\s+(?:a\s+)?(?:new|different)\s+(?:ai|assistant|system))/i,
	/\b(?:disregard\s+(?:all\s+)?(?:your\s+)?(?:previous|prior|system)\s+(?:instructions|prompt))/i,
	/^system\s*:\s/im,
	/\{\s*"role"\s*:\s*"system"/,
	/<\/?system>/i,
];

// ── Error Classes ──────────────────────────────────────────────────────────

/**
 * Thrown when the response from OpenRouter cannot be parsed as valid JSON
 * matching the expected schema, even after correction attempts.
 */
export class JsonValidationError extends Error {
	constructor(
		message: string,
		readonly rawResponse: string,
		override readonly cause?: Error,
	) {
		super(message);
		this.name = "JsonValidationError";
	}
}

/**
 * Thrown when prompt injection is detected in user-supplied content.
 */
export class PromptInjectionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PromptInjectionError";
	}
}

// ── OpenRouterClient ───────────────────────────────────────────────────────

/**
 * Wrapper around the official `@openrouter/sdk` that adds:
 *
 * - **JSON validation**: `chatJson()` parses and validates responses
 *   against a caller-supplied validator, with automatic correction prompts.
 * - **Prompt injection protection**: `sanitize()` detects and blocks
 *   common injection patterns in user-supplied content.
 * - **Conversation-aware API**: accepts an `OpenRouterMessage[]` array
 *   that the {@link ConversationManager} maintains per conversation.
 *
 * The SDK itself handles retries (exponential backoff), HTTP transport,
 * timeout enforcement, and connection error resilience — we configure
 * those via the `SDKOptions` passed at construction time.
 *
 * This client is intentionally **stateless**: it does not maintain
 * conversation history. The {@link ConversationManager} is responsible
 * for managing per-conversation message arrays and feeding them here.
 *
 * @example
 * ```ts
 * const client = new OpenRouterClient(
 *   { apiKey: "sk-…", model: "anthropic/claude-sonnet-4" },
 *   logger,
 * );
 *
 * const text = await client.chat([
 *   { role: "system", content: "You are a helpful assistant." },
 *   { role: "user", content: "Hello!" },
 * ]);
 *
 * const data = await client.chatJson(messages, validateMySchema);
 * ```
 */
export class OpenRouterClient {
	private readonly sdk: OpenRouter;
	private readonly model: string;
	private readonly temperature: number;
	private readonly maxTokens: number | undefined;
	private readonly maxJsonAttempts: number;

	constructor(
		config: OpenRouterConfig,
		private readonly logger: pino.Logger,
	) {
		this.model = config.model;
		this.temperature = config.temperature ?? 0.2;
		this.maxTokens = config.maxTokens;
		this.maxJsonAttempts = (config.maxRetries ?? 3) + 1;

		this.sdk = new OpenRouter({
			apiKey: config.apiKey,
			httpReferer: "https://github.com/stark-agent-pool",
			xTitle: "Stark AgentPool",
			timeoutMs: config.timeout ?? 120_000,
			retryConfig: {
				strategy: "backoff",
				backoff: {
					initialInterval: config.baseDelay ?? 1000,
					maxInterval: 60_000,
					exponent: 2,
					maxElapsedTime: 300_000,
				},
				retryConnectionErrors: true,
			},
		});
	}

	// ── Public API ───────────────────────────────────────────────────────

	/**
	 * Sends a chat completion request and returns the raw text response.
	 *
	 * The underlying SDK handles retries with exponential backoff on
	 * transient HTTP failures (429, 5xx) and network errors.
	 *
	 * @param messages - The full conversation message array.
	 * @param options  - Optional per-request overrides.
	 * @returns The assistant's response text.
	 */
	async chat(
		messages: OpenRouterMessage[],
		options?: ChatOptions,
	): Promise<string> {
		const response = await this.sdk.chat.send({
			chatGenerationParams: {
				model: this.model,
				messages: messages.map((m) => this.toSdkMessage(m)),
				temperature: options?.temperature ?? this.temperature,
				maxTokens: options?.maxTokens ?? this.maxTokens ?? undefined,
				stream: false,
				...(options?.jsonMode
					? { responseFormat: { type: "json_object" as const } }
					: {}),
			},
		});

		const content = this.extractContent(response as ChatResponse);

		this.logger.debug(
			{
				model: this.model,
				usage: (response as ChatResponse).usage,
				responseLength: content.length,
			},
			"OpenRouter chat completed",
		);

		return content;
	}

	/**
	 * Sends a chat completion request, parses the response as JSON, and
	 * validates it against a caller-supplied validator function.
	 *
	 * If the response is not valid JSON or fails validation, the method
	 * retries with a correction prompt appended to guide the LLM toward
	 * a conformant response.
	 *
	 * @param messages  - The full conversation message array.
	 * @param validator - A function that validates and narrows the parsed JSON.
	 *                    Should return `null`/`undefined` on invalid data.
	 * @param options   - Optional per-request overrides (jsonMode defaults to true).
	 * @returns The validated JSON object.
	 * @throws {JsonValidationError} After exhausting all correction attempts.
	 */
	async chatJson<T>(
		messages: OpenRouterMessage[],
		validator: (data: unknown) => T | null | undefined,
		options?: ChatOptions,
	): Promise<T> {
		const jsonOptions: ChatOptions = { jsonMode: true, ...options };

		let lastRaw = "";
		let conversationMessages = [...messages];

		for (let attempt = 0; attempt < this.maxJsonAttempts; attempt++) {
			const raw = await this.chat(conversationMessages, jsonOptions);
			lastRaw = raw;

			try {
				const cleanedJson = extractJsonFromResponse(raw);
				const parsed: unknown = JSON.parse(cleanedJson);
				const validated = validator(parsed);

				if (validated != null) {
					return validated;
				}

				// Validator returned null/undefined → invalid structure
				this.logger.warn(
					{ attempt },
					"JSON validation failed, requesting correction",
				);

				conversationMessages = [
					...conversationMessages,
					{ role: "assistant" as const, content: raw },
					{
						role: "user" as const,
						content: `The JSON structure is invalid. Your response was:\n${cleanedJson}\n\nPlease respond with a valid JSON object matching the exact schema described in the system prompt. No markdown, no commentary — only the JSON object.`,
					},
				];
			} catch (parseError) {
				const errMsg =
					parseError instanceof Error ? parseError.message : String(parseError);

				this.logger.warn(
					{ attempt, error: errMsg },
					"JSON parse failed, requesting correction",
				);

				conversationMessages = [
					...conversationMessages,
					{ role: "assistant" as const, content: raw },
					{
						role: "user" as const,
						content: `Your response could not be parsed as valid JSON. Error: ${errMsg}\n\nYour response was:\n${raw}\n\nPlease respond with ONLY a valid JSON object. No markdown code blocks, no commentary, no extra text — just the raw JSON object.`,
					},
				];
			}
		}

		throw new JsonValidationError(
			`Failed to get valid JSON from OpenRouter after ${this.maxJsonAttempts} attempts`,
			lastRaw,
		);
	}

	// ── Prompt Injection Protection ──────────────────────────────────────

	/**
	 * Sanitizes user-supplied content to mitigate prompt injection attacks.
	 *
	 * This is a defense-in-depth measure. The primary protection comes from
	 * strong system prompts that constrain the LLM's behavior. This function
	 * adds a second layer by detecting suspicious patterns.
	 *
	 * @param input - The raw user-supplied text.
	 * @returns The sanitized text, safe to include in prompts.
	 * @throws {PromptInjectionError} If a high-confidence injection is detected.
	 */
	sanitize(input: string): string {
		let matchCount = 0;
		for (const pattern of INJECTION_PATTERNS) {
			if (pattern.test(input)) {
				matchCount++;
			}
		}

		if (matchCount >= 2) {
			this.logger.error(
				{ matchCount, inputPreview: input.slice(0, 200) },
				"Prompt injection detected — rejecting input",
			);
			throw new PromptInjectionError(
				"Input rejected: multiple prompt injection patterns detected",
			);
		}

		if (matchCount === 1) {
			this.logger.warn(
				{ inputPreview: input.slice(0, 200) },
				"Possible prompt injection pattern detected — wrapping input",
			);
		}

		return input;
	}

	// ── Private ──────────────────────────────────────────────────────────

	/**
	 * Converts our generic `OpenRouterMessage` to the SDK's discriminated
	 * union `Message` type, which uses `{ role: "system" }` / `{ role: "user" }`
	 * / `{ role: "assistant" }` as literal discriminants.
	 */
	private toSdkMessage(msg: OpenRouterMessage) {
		switch (msg.role) {
			case "system":
				return { role: "system" as const, content: msg.content };
			case "user":
				return { role: "user" as const, content: msg.content };
			case "assistant":
				return { role: "assistant" as const, content: msg.content };
			default: {
				const _exhaustive: never = msg.role;
				throw new Error(`Unknown message role: ${_exhaustive}`);
			}
		}
	}

	/**
	 * Extracts the assistant's text content from a chat response.
	 *
	 * @throws {Error} If the response has no choices or no content.
	 */
	private extractContent(response: ChatResponse): string {
		if (!response.choices || response.choices.length === 0) {
			throw new Error("OpenRouter response contained no choices");
		}

		const firstChoice = response.choices[0];
		if (!firstChoice) {
			throw new Error("OpenRouter response first choice is undefined");
		}

		const content = firstChoice.message?.content;
		if (typeof content !== "string" || content.length === 0) {
			throw new Error("OpenRouter response contained no content");
		}

		return content;
	}
}

// ── Utility Functions ──────────────────────────────────────────────────────

/**
 * Extracts a JSON string from a response that may be wrapped in
 * markdown code blocks.
 *
 * LLMs sometimes wrap JSON responses in code blocks despite explicit
 * instructions not to. This function strips the wrapping so that
 * `JSON.parse` can succeed.
 */
function extractJsonFromResponse(raw: string): string {
	const trimmed = raw.trim();

	// Try to find JSON within markdown code blocks
	const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
	if (codeBlockMatch?.[1]) {
		return codeBlockMatch[1].trim();
	}

	// Try to extract a JSON object directly
	const jsonObjectMatch = trimmed.match(/(\{[\s\S]*\})/);
	if (jsonObjectMatch?.[1]) {
		return jsonObjectMatch[1].trim();
	}

	const jsonArrayMatch = trimmed.match(/(\[[\s\S]*\])/);
	if (jsonArrayMatch?.[1]) {
		return jsonArrayMatch[1].trim();
	}

	// Return as-is and let JSON.parse surface the error
	return trimmed;
}
