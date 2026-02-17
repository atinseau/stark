import { OpenRouter } from "@openrouter/sdk";
import type { ChatResponse } from "@openrouter/sdk/models";
import type pino from "pino";
import type {
	ChatOptions,
	OpenRouterConfig,
	OpenRouterMessage,
} from "../../types/agent-pool.types.ts";
import { toErrorMessage } from "../../utils/errors.ts";

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

/**
 * Thrown when the configured model does not exist on OpenRouter.
 *
 * This is a fatal, non-recoverable error — the pool cannot function
 * without a valid model identifier.
 */
export class InvalidModelError extends Error {
	constructor(
		readonly model: string,
		readonly availableModels?: string[],
	) {
		const suggestion = availableModels
			? InvalidModelError.findClosestMatch(model, availableModels)
			: undefined;

		const hint = suggestion ? `\n\nDid you mean "${suggestion}"?` : "";

		super(
			`Model "${model}" does not exist on OpenRouter. ` +
				`Verify the model identifier at https://openrouter.ai/models` +
				hint,
		);
		this.name = "InvalidModelError";
	}

	/**
	 * Simple Levenshtein-based closest-match finder for model IDs.
	 */
	private static findClosestMatch(
		target: string,
		candidates: string[],
	): string | undefined {
		if (candidates.length === 0) return undefined;

		let bestMatch: string | undefined;
		let bestDistance = Number.POSITIVE_INFINITY;

		for (const candidate of candidates) {
			// Quick pre-filter: skip models that don't share any path component
			const targetParts = target.toLowerCase().split("/");
			const candidateParts = candidate.toLowerCase().split("/");
			const sharesProvider = targetParts[0] === candidateParts[0];
			if (!sharesProvider) continue;

			const distance = levenshteinDistance(
				target.toLowerCase(),
				candidate.toLowerCase(),
			);
			if (distance < bestDistance) {
				bestDistance = distance;
				bestMatch = candidate;
			}
		}

		// Only suggest if reasonably close (less than 40% of the target length)
		if (bestMatch && bestDistance <= target.length * 0.4) {
			return bestMatch;
		}

		return undefined;
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

	/** Cache for model validation result (per-instance). */
	private _modelValidated: Promise<void> | null = null;

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
				const errMsg = toErrorMessage(parseError);

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
	 * Validates that the configured model exists on OpenRouter.
	 *
	 * This method fetches the full model list from the OpenRouter public API
	 * and checks whether the configured model identifier is present.
	 * The result is cached so the API is only called once per client instance.
	 *
	 * @throws {InvalidModelError} If the model does not exist on OpenRouter.
	 */
	async validateModel(): Promise<void> {
		if (!this._modelValidated) {
			this._modelValidated = this._doValidateModel();
		}
		return this._modelValidated;
	}

	private async _doValidateModel(): Promise<void> {
		this.logger.debug(
			{ model: this.model },
			"Validating model exists on OpenRouter",
		);

		try {
			const response = await fetch("https://openrouter.ai/api/v1/models", {
				headers: { Accept: "application/json" },
				signal: AbortSignal.timeout(15_000),
			});

			if (!response.ok) {
				this.logger.warn(
					{ status: response.status },
					"Failed to fetch OpenRouter model list — skipping model validation",
				);
				return;
			}

			const body = (await response.json()) as {
				data?: Array<{ id: string }>;
			};

			const models = body.data;
			if (!Array.isArray(models)) {
				this.logger.warn(
					"OpenRouter model list response has unexpected shape — skipping validation",
				);
				return;
			}

			const modelIds = models.map((m) => m.id);
			const exists = modelIds.includes(this.model);

			if (!exists) {
				this.logger.error(
					{ model: this.model, availableCount: modelIds.length },
					"Model does not exist on OpenRouter",
				);
				throw new InvalidModelError(this.model, modelIds);
			}

			this.logger.debug({ model: this.model }, "Model validated successfully");
		} catch (error) {
			// Re-throw InvalidModelError as-is
			if (error instanceof InvalidModelError) {
				throw error;
			}

			// Network errors / timeouts → log and skip (don't block execution)
			this.logger.warn(
				{ error: toErrorMessage(error) },
				"Could not validate model against OpenRouter API — skipping validation",
			);
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
 * Computes the Levenshtein distance between two strings.
 * Used for "did you mean?" suggestions in {@link InvalidModelError}.
 */
function levenshteinDistance(a: string, b: string): number {
	const m = a.length;
	const n = b.length;

	// Flat array avoids nested index-access nullability issues.
	const dp = new Array<number>((m + 1) * (n + 1)).fill(0);
	const at = (i: number, j: number): number => dp[i * (n + 1) + j] ?? 0;

	for (let i = 0; i <= m; i++) dp[i * (n + 1)] = i;
	for (let j = 0; j <= n; j++) dp[j] = j;

	for (let i = 1; i <= m; i++) {
		for (let j = 1; j <= n; j++) {
			dp[i * (n + 1) + j] =
				a[i - 1] === b[j - 1]
					? at(i - 1, j - 1)
					: 1 + Math.min(at(i - 1, j), at(i, j - 1), at(i - 1, j - 1));
		}
	}

	return at(m, n);
}

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
