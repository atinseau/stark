import type {
	DecisionJournalConfig,
	DecisionJournalEntry,
} from "../../types/agent-pool.types.ts";

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_MAX_ENTRIES = 15;
const DEFAULT_MAX_ENTRIES_IN_PROMPT = 8;
const DEFAULT_MAX_REASONING_LENGTH = 120;

// ── DecisionJournal ────────────────────────────────────────────────────────

/**
 * Maintains a rolling window of condensed decision records for
 * injection into LLM prompts.
 *
 * The journal serves as a lightweight "session memory" for the
 * sharing and notification analyzers. Instead of maintaining full
 * conversation history (which grows linearly with deltas), the journal
 * keeps a fixed-size window of decision summaries that gives the LLM
 * enough context to:
 *
 * - Detect patterns in its own decisions (e.g., "I've been sharing
 *   a lot of file_write events to this agent")
 * - Maintain consistency (e.g., "I refused this type of sharing
 *   earlier for good reason")
 * - Adjust behavior over time (e.g., "I've already notified the
 *   user 3 times in the last minute, I should be more selective")
 *
 * ## Design Decisions
 *
 * - **Fixed window, not summarization**: The journal uses a simple
 *   FIFO eviction strategy rather than LLM-based summarization.
 *   This keeps the journal management synchronous and free of
 *   additional LLM calls.
 *
 * - **Separate from SharingHistory**: The SharingHistory (evolution 02)
 *   tracks what was shared TO each target agent for deduplication.
 *   The DecisionJournal tracks ALL decisions (including rejections)
 *   to provide reasoning context. They serve complementary purposes.
 *
 * - **One journal per analyzer**: The sharing analyzer and notification
 *   engine each have their own journal instance. This prevents
 *   cross-contamination of decision contexts.
 *
 * ## Token Budget
 *
 * With `maxEntriesInPrompt = 8` and `maxReasoningLength = 120`,
 * the journal section adds approximately:
 * - 8 entries × ~200 chars each = ~1600 chars ≈ ~400 tokens
 *
 * This is a modest, bounded overhead per LLM call.
 *
 * @example
 * ```ts
 * const journal = new DecisionJournal({ maxEntries: 15 });
 *
 * journal.record({
 *     timestamp: "2024-01-15T10:30:00Z",
 *     type: "sharing",
 *     sourceAgentName: "api-developer",
 *     targetName: "test-writer",
 *     deltaType: "prompt_complete",
 *     approved: true,
 *     reasoningSummary: "API implementation details are critical for test-writer's blocking dependency.",
 * });
 *
 * const promptSection = journal.toPromptSection();
 * // Returns formatted text ready for inclusion in an LLM prompt
 * ```
 */
export class DecisionJournal {
	private readonly entries: DecisionJournalEntry[] = [];
	private readonly maxEntries: number;
	private readonly maxEntriesInPrompt: number;
	private readonly maxReasoningLength: number;

	constructor(config?: DecisionJournalConfig) {
		this.maxEntries = config?.maxEntries ?? DEFAULT_MAX_ENTRIES;
		this.maxEntriesInPrompt =
			config?.maxEntriesInPrompt ?? DEFAULT_MAX_ENTRIES_IN_PROMPT;
		this.maxReasoningLength =
			config?.maxReasoningLength ?? DEFAULT_MAX_REASONING_LENGTH;
	}

	// ── Recording ──────────────────────────────────────────────────────

	/**
	 * Records a new decision in the journal.
	 *
	 * The `reasoningSummary` is automatically truncated to
	 * `maxReasoningLength` characters if necessary.
	 *
	 * If the journal exceeds `maxEntries`, the oldest entry is evicted.
	 *
	 * @param entry - The decision to record.
	 */
	record(entry: DecisionJournalEntry): void {
		// Truncate reasoning if needed
		const truncatedEntry: DecisionJournalEntry = {
			...entry,
			reasoningSummary:
				entry.reasoningSummary.length > this.maxReasoningLength
					? `${entry.reasoningSummary.slice(0, this.maxReasoningLength)}…`
					: entry.reasoningSummary,
		};

		this.entries.push(truncatedEntry);

		// Evict oldest if over limit
		while (this.entries.length > this.maxEntries) {
			this.entries.shift();
		}
	}

	/**
	 * Records a sharing decision from an InformationBroker evaluation.
	 *
	 * Convenience method that constructs the journal entry from
	 * the sharing decision fields.
	 *
	 * @param sourceAgentName - Name of the agent that produced the delta.
	 * @param targetAgentName - Name of the target agent evaluated.
	 * @param deltaType - The type of delta being evaluated.
	 * @param approved - Whether sharing was approved.
	 * @param reasoning - The LLM's reasoning (will be truncated).
	 * @param timestamp - ISO-8601 timestamp.
	 */
	recordSharingDecision(
		sourceAgentName: string,
		targetAgentName: string,
		deltaType: string,
		approved: boolean,
		reasoning: string,
		timestamp: string,
	): void {
		this.record({
			timestamp,
			type: "sharing",
			sourceAgentName,
			targetName: targetAgentName,
			deltaType,
			approved,
			reasoningSummary: reasoning,
		});
	}

	/**
	 * Records a notification decision from the NotificationEngine.
	 *
	 * @param sourceAgentName - Name of the agent that produced the delta.
	 * @param deltaType - The type of delta being evaluated.
	 * @param approved - Whether notification was sent.
	 * @param reasoning - The LLM's reasoning (will be truncated).
	 * @param timestamp - ISO-8601 timestamp.
	 */
	recordNotificationDecision(
		sourceAgentName: string,
		deltaType: string,
		approved: boolean,
		reasoning: string,
		timestamp: string,
	): void {
		this.record({
			timestamp,
			type: "notification",
			sourceAgentName,
			targetName: "user",
			deltaType,
			approved,
			reasoningSummary: reasoning,
		});
	}

	// ── Prompt Generation ──────────────────────────────────────────────

	/**
	 * Generates a formatted text section suitable for inclusion in
	 * an LLM prompt.
	 *
	 * Returns the most recent `maxEntriesInPrompt` entries formatted
	 * as a numbered list with key fields. Returns `null` if the
	 * journal is empty.
	 *
	 * @returns A formatted string for prompt injection, or `null`.
	 */
	toPromptSection(): string | null {
		if (this.entries.length === 0) return null;

		const entriesToShow = this.entries.slice(-this.maxEntriesInPrompt);

		const lines = entriesToShow.map((entry, index) => {
			const decision = entry.approved ? "✅ APPROVED" : "❌ DENIED";
			const arrow =
				entry.type === "sharing"
					? `${entry.sourceAgentName} → ${entry.targetName}`
					: `${entry.sourceAgentName} → user notification`;
			const timeAgo = this.formatRelativeTime(entry.timestamp);

			return (
				`${index + 1}. [${decision}] ${arrow} (${entry.deltaType}, ${timeAgo})\n` +
				`   Reasoning: ${entry.reasoningSummary}`
			);
		});

		return lines.join("\n\n");
	}

	/**
	 * Returns the journal entries as a structured array suitable
	 * for inclusion in Handlebars templates.
	 *
	 * @returns Array of entries for template rendering, or empty array.
	 */
	toTemplateData(): Array<{
		decision: string;
		sourceAgentName: string;
		targetName: string;
		deltaType: string;
		approved: boolean;
		reasoningSummary: string;
		timeAgo: string;
	}> {
		const entriesToShow = this.entries.slice(-this.maxEntriesInPrompt);

		return entriesToShow.map((entry) => ({
			decision: entry.approved ? "APPROVED" : "DENIED",
			sourceAgentName: entry.sourceAgentName,
			targetName: entry.targetName,
			deltaType: entry.deltaType,
			approved: entry.approved,
			reasoningSummary: entry.reasoningSummary,
			timeAgo: this.formatRelativeTime(entry.timestamp),
		}));
	}

	// ── Query ──────────────────────────────────────────────────────────

	/** Returns the total number of entries in the journal. */
	get entryCount(): number {
		return this.entries.length;
	}

	/** Returns the number of approved decisions in the journal. */
	get approvedCount(): number {
		return this.entries.filter((e) => e.approved).length;
	}

	/** Returns the number of denied decisions in the journal. */
	get deniedCount(): number {
		return this.entries.filter((e) => !e.approved).length;
	}

	/**
	 * Returns the approval rate as a number between 0 and 1.
	 * Returns 0 if the journal is empty.
	 */
	get approvalRate(): number {
		if (this.entries.length === 0) return 0;
		return this.approvedCount / this.entries.length;
	}

	/**
	 * Returns the number of decisions made in the last N seconds.
	 * Useful for rate limiting (e.g., "too many notifications in a short time").
	 *
	 * @param seconds - The time window in seconds.
	 * @returns Number of decisions within the window.
	 */
	countRecentDecisions(seconds: number): number {
		const cutoff = Date.now() - seconds * 1000;
		return this.entries.filter((e) => new Date(e.timestamp).getTime() > cutoff)
			.length;
	}

	/**
	 * Returns the number of approved decisions for a specific target
	 * in the last N seconds.
	 *
	 * @param targetName - The target agent name or "user".
	 * @param seconds - The time window in seconds.
	 * @returns Number of approved decisions for this target within the window.
	 */
	countRecentApprovedForTarget(targetName: string, seconds: number): number {
		const cutoff = Date.now() - seconds * 1000;
		return this.entries.filter(
			(e) =>
				e.targetName === targetName &&
				e.approved &&
				new Date(e.timestamp).getTime() > cutoff,
		).length;
	}

	/**
	 * Returns all entries as a read-only array.
	 */
	getAllEntries(): readonly DecisionJournalEntry[] {
		return [...this.entries];
	}

	// ── Lifecycle ──────────────────────────────────────────────────────

	/**
	 * Clears all entries from the journal.
	 * Called between executions or on pool reset.
	 */
	clear(): void {
		this.entries.length = 0;
	}

	// ── Private ────────────────────────────────────────────────────────

	/**
	 * Formats a timestamp as a human-readable relative time string.
	 * Examples: "5s ago", "2m ago", "1h ago"
	 *
	 * @param timestamp - ISO-8601 timestamp.
	 * @returns Human-readable relative time.
	 */
	private formatRelativeTime(timestamp: string): string {
		const now = Date.now();
		const then = new Date(timestamp).getTime();
		const diffMs = now - then;

		if (Number.isNaN(diffMs) || diffMs < 0) return "just now";

		const diffS = Math.floor(diffMs / 1000);
		if (diffS < 60) return `${diffS}s ago`;

		const diffM = Math.floor(diffS / 60);
		if (diffM < 60) return `${diffM}m ago`;

		const diffH = Math.floor(diffM / 60);
		return `${diffH}h ago`;
	}
}
