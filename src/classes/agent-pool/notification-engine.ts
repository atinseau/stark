import type pino from "pino";
import { ConversationRole } from "../../enums/conversation-role.enum.ts";
import { DeltaType } from "../../enums/delta-type.enum.ts";
import { notificationDecisionPrompt } from "../../prompts/index.ts";
import type {
	AgentContextState,
	ContextDelta,
	DecisionJournalConfig,
	NotificationPreference,
	UserNotification,
} from "../../types/agent-pool.types.ts";
import { toErrorMessage } from "../../utils/errors.ts";
import { isoNow } from "../../utils/formatting.ts";
import type { ConversationManager } from "./conversation-manager.ts";
import { DecisionJournal } from "./decision-journal.ts";

// ── Validators ─────────────────────────────────────────────────────────────

/**
 * Validates that a raw parsed JSON value conforms to the internal
 * notification decision schema returned by the context-analyzer LLM.
 *
 * Returns `null` on invalid data so the OpenRouter client can
 * retry with a correction prompt.
 */
function validateNotificationDecision(
	data: unknown,
): { shouldNotify: boolean; reasoning: string; message: string } | null {
	if (data == null || typeof data !== "object") return null;

	const obj = data as Record<string, unknown>;

	if (typeof obj.shouldNotify !== "boolean") return null;
	if (typeof obj.reasoning !== "string" || obj.reasoning.length === 0) {
		return null;
	}

	// message is required when shouldNotify is true
	if (obj.shouldNotify) {
		if (typeof obj.message !== "string" || obj.message.length === 0) {
			return null;
		}
	}

	return {
		shouldNotify: obj.shouldNotify,
		reasoning: obj.reasoning as string,
		message: typeof obj.message === "string" ? obj.message : "",
	};
}

// ── NotificationEngine ─────────────────────────────────────────────────────

/**
 * LLM-driven conditional notification system for user-facing updates.
 *
 * The notification engine is responsible for deciding whether a context
 * delta warrants informing the user. It enforces a strict
 * **silence-by-default** policy:
 *
 * - If the user has **not** explicitly requested notifications,
 *   no automatic messages are ever generated.
 * - If the user **has** requested notifications (via a message to
 *   the AgentPool), the preference is memorized and applied to all
 *   subsequent deltas.
 *
 * ## Preference Model
 *
 * Notification preferences are set by the user through natural language
 * messages analyzed by the intent analyzer. The preference includes:
 *
 * - `enabled` — Master toggle. Must be `true` for any notifications.
 * - `minSignificance` — Minimum delta significance (0.0–1.0) required
 *   to even consider notifying. Defaults to 0.5.
 * - `types` — Optional list of {@link DeltaType} values the user is
 *   interested in. If empty, all types are considered.
 *
 * ## Decision Process
 *
 * When a delta passes the pre-filter checks (enabled, significance,
 * type match), the engine consults the context-analyzer LLM conversation
 * to make the final decision. The LLM evaluates:
 *
 * 1. Whether the delta is genuinely noteworthy to a human observer
 * 2. Whether the notification message is clear and informative
 * 3. Whether the notification adds value vs. being noise
 *
 * This LLM-driven approach avoids hardcoded rules about what constitutes
 * a "notification-worthy" event — the decision is contextual and adaptive.
 *
 * ## Token Efficiency
 *
 * Notification decisions use one-shot prompts (via `sendOneShotJson`)
 * to avoid accumulating decision history in the conversation context.
 * Only the system prompt and the current delta are sent, keeping token
 * usage constant per evaluation regardless of how many deltas have
 * been processed.
 *
 * @example
 * ```ts
 * const engine = new NotificationEngine(conversationManager, logger);
 *
 * // User hasn't requested notifications → silence
 * const result1 = await engine.evaluate(delta, agentState);
 * // result1 === null (no notification)
 *
 * // User requests notifications
 * engine.setPreference({ enabled: true, minSignificance: 0.6 });
 *
 * // Now deltas above 0.6 significance are evaluated
 * const result2 = await engine.evaluate(importantDelta, agentState);
 * // result2 = { message: "Agent completed the API implementation", ... }
 * ```
 */
export class NotificationEngine {
	/**
	 * The user's current notification preference.
	 * `null` means the user has not expressed any preference (silence mode).
	 */
	private preference: NotificationPreference | null = null;

	/** Running count of notifications generated. */
	private _notificationCount = 0;

	/** Running count of evaluations performed (LLM calls). */
	private _evaluationCount = 0;

	/** Rolling journal of notification decisions for session memory. */
	private readonly decisionJournal: DecisionJournal;

	constructor(
		private readonly conversations: ConversationManager,
		private readonly logger: pino.Logger,
		journalConfig?: DecisionJournalConfig,
	) {
		this.decisionJournal = new DecisionJournal(journalConfig);
	}

	// ── Preference Management ──────────────────────────────────────────

	/**
	 * Sets the user's notification preference.
	 *
	 * Once set, the engine begins evaluating incoming deltas against
	 * this preference. The preference can be updated at any time.
	 *
	 * @param preference - The notification preference to apply.
	 */
	setPreference(preference: NotificationPreference): void {
		this.preference = {
			enabled: preference.enabled,
			minSignificance: preference.minSignificance ?? 0.5,
			types: preference.types ?? undefined,
		};

		this.logger.info(
			{
				enabled: this.preference.enabled,
				minSignificance: this.preference.minSignificance,
				types: this.preference.types,
			},
			`Notifications ${this.preference.enabled ? "enabled" : "disabled"} — threshold: ${this.preference.minSignificance}${this.preference.types ? `, types: ${this.preference.types.join(", ")}` : ""}`,
		);
	}

	/**
	 * Returns the current notification preference, or `null` if none
	 * has been set.
	 */
	getPreference(): NotificationPreference | null {
		return this.preference ? { ...this.preference } : null;
	}

	/**
	 * Clears the notification preference, returning to silence mode.
	 */
	clearPreference(): void {
		this.preference = null;
		this.logger.info("Notifications disabled — silence mode");
	}

	/**
	 * Returns whether notifications are currently enabled.
	 * `false` if no preference has been set or if explicitly disabled.
	 */
	get isEnabled(): boolean {
		return this.preference?.enabled === true;
	}

	// ── Evaluation ─────────────────────────────────────────────────────

	/**
	 * Evaluates whether a context delta warrants a user notification.
	 *
	 * Returns a {@link UserNotification} if the user should be notified,
	 * or `null` if the delta should be silently ignored.
	 *
	 * The method applies the following filters in order:
	 *
	 * 1. **Preference check**: If no preference is set or notifications
	 *    are disabled, returns `null` immediately (silence by default).
	 *
	 * 2. **Significance threshold**: If the delta's significance is below
	 *    the user's configured minimum, returns `null`.
	 *
	 * 3. **Type filter**: If the user specified interested types and the
	 *    delta's type is not in the list, returns `null`.
	 *
	 * 4. **LLM evaluation**: If all pre-filters pass, the engine consults
	 *    the LLM for a final semantic decision.
	 *
	 * @param delta      - The context delta to evaluate.
	 * @param agentState - The state of the agent that produced the delta.
	 * @returns A notification to send to the user, or `null`.
	 */
	async evaluate(
		delta: ContextDelta,
		agentState: AgentContextState,
	): Promise<UserNotification | null> {
		// ── Filter 1: Preference must exist and be enabled ─────────────
		if (!this.preference || !this.preference.enabled) {
			return null;
		}

		// ── Filter 2: Significance threshold ───────────────────────────
		const minSig = this.preference.minSignificance ?? 0.5;
		if (delta.significance < minSig) {
			this.logger.debug(
				{
					agentId: delta.agentId,
					deltaType: delta.type,
					significance: delta.significance,
					threshold: minSig,
				},
				"Delta below notification significance threshold",
			);
			return null;
		}

		// ── Filter 3: Type filter ──────────────────────────────────────
		if (
			this.preference.types &&
			this.preference.types.length > 0 &&
			!this.preference.types.includes(delta.type)
		) {
			this.logger.debug(
				{
					agentId: delta.agentId,
					deltaType: delta.type,
					interestedTypes: this.preference.types,
				},
				"Delta type not in user's interested types",
			);
			return null;
		}

		// ── Filter 4: LLM evaluation ───────────────────────────────────
		return this.evaluateWithLlm(delta, agentState);
	}

	// ── Statistics ─────────────────────────────────────────────────────

	/** Total number of notifications generated. */
	get notificationCount(): number {
		return this._notificationCount;
	}

	/** Total number of LLM evaluations performed. */
	get evaluationCount(): number {
		return this._evaluationCount;
	}

	/**
	 * Returns the decision journal for inspection or cleanup.
	 */
	get journal(): DecisionJournal {
		return this.decisionJournal;
	}

	// ── Private ────────────────────────────────────────────────────────

	/**
	 * Consults the LLM to determine if the delta warrants a notification.
	 *
	 * Builds a structured prompt from the Handlebars template and sends
	 * it as a one-shot request to avoid polluting the conversation history.
	 *
	 * @param delta      - The context delta being evaluated.
	 * @param agentState - The agent's current context state.
	 * @returns A notification to send, or `null` if the LLM decided not to notify.
	 */
	private async evaluateWithLlm(
		delta: ContextDelta,
		agentState: AgentContextState,
	): Promise<UserNotification | null> {
		if (!this.preference) return null;

		// Include the decision journal in the prompt for session memory
		const journalSection = this.decisionJournal.toPromptSection();
		const recentNotificationCount =
			this.decisionJournal.countRecentApprovedForTarget("user", 60);

		// Build the notification decision prompt with semantic framing
		// (preference data is intentionally omitted — pre-filters already passed)
		const prompt = notificationDecisionPrompt({
			delta: {
				agentName: delta.agentName,
				agentRole: agentState.taskRole,
				type: delta.type,
				summary: delta.summary,
				significance: delta.significance,
			},
			agentTask: agentState.taskDescription,
			otherAgentsContext: null, // Placeholder for future evolution
			decisionJournal: journalSection,
			recentNotificationCount:
				recentNotificationCount > 0 ? recentNotificationCount : null,
		});

		this.logger.debug(
			{
				agentId: delta.agentId,
				deltaType: delta.type,
				significance: delta.significance,
			},
			"Evaluating notification decision with LLM",
		);

		this._evaluationCount++;

		try {
			const decision = await this.conversations.sendOneShotJson(
				ConversationRole.CONTEXT_ANALYZER,
				prompt,
				validateNotificationDecision,
				{ maxTokens: 200, maxJsonAttempts: 2 },
			);

			if (!decision) {
				this.logger.warn(
					{ agentId: delta.agentId },
					"Notification decision validation returned null",
				);
				return null;
			}

			// Record the decision in the journal for session memory
			this.decisionJournal.recordNotificationDecision(
				delta.agentName,
				delta.type,
				decision.shouldNotify,
				decision.reasoning,
				delta.timestamp,
			);

			if (!decision.shouldNotify) {
				this.logger.debug(
					{
						agentId: delta.agentId,
						deltaType: delta.type,
						reasoning: decision.reasoning.slice(0, 100),
					},
					"LLM decided not to notify user",
				);
				return null;
			}

			// Build the notification
			const notification: UserNotification = {
				message: decision.message,
				significance: delta.significance,
				agentId: delta.agentId,
				agentName: delta.agentName,
				type: delta.type,
				timestamp: isoNow(),
			};

			this._notificationCount++;

			this.logger.info(
				{
					agentId: delta.agentId,
					agentName: delta.agentName,
					deltaType: delta.type,
					significance: delta.significance,
					message: decision.message.slice(0, 100),
				},
				`Notification — ${delta.agentName}: ${decision.message.slice(0, 80)}`,
			);

			return notification;
		} catch (error) {
			this.logger.warn(
				{
					agentId: delta.agentId,
					error: toErrorMessage(error),
				},
				"Notification LLM evaluation failed — defaulting to silence",
			);

			// On failure, default to not notifying (safe default)
			return null;
		}
	}
}
