import type { StructuredContextInjection } from "../../types/agent-pool.types.ts";

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Maximum number of pending structured injections before overflow management kicks in.
 * When exceeded, LOW priority injections are dropped first, then NORMAL.
 */
const MAX_PENDING_INJECTIONS = 15;

/**
 * Maximum total character count of all pending structured injections combined.
 * When exceeded, the oldest LOW priority injections are dropped.
 */
const MAX_PENDING_CHARS = 15000;

/**
 * Priority ordering — lower number = presented first in the prompt.
 */
const PRIORITY_ORDER: Record<string, number> = {
	critical: 0,
	high: 1,
	normal: 2,
	low: 3,
};

/**
 * Headers for each injection category, used in the formatted prompt.
 */
const CATEGORY_HEADERS: Record<string, string> = {
	dependency_output: "📦 DEPENDENCY OUTPUT",
	shared_context: "🔗 SHARED CONTEXT",
	user_instruction: "👤 USER INSTRUCTION",
	coordination_alert: "⚠️ COORDINATION ALERT",
};

// ── AgentContextManager ────────────────────────────────────────────────────

/**
 * Manages the queue of context instructions injected into an agent.
 *
 * Supports two injection modes:
 *
 *   - **Structured** (`injectStructured`) — prioritized, categorized injections
 *     with metadata for ordering, formatting, and overflow management.
 *   - **Legacy** (`inject`) — raw string injections for backward compatibility.
 *
 * Structured injections are sorted by priority (CRITICAL first) when drained,
 * and overflow management drops LOW then NORMAL priority injections when the
 * queue exceeds configured limits. HIGH and CRITICAL injections are never dropped.
 *
 * Legacy string injections are appended after structured ones in the output,
 * with a generic `--- CONTEXT ---` header.
 *
 * The Agent orchestrator decides *when* to drain based on status transitions;
 * this class only manages the data.
 *
 * @example
 * ```ts
 * const ctx = new AgentContextManager();
 *
 * // Structured injection (new mode)
 * ctx.injectStructured({
 *   content: "The API uses port 3000",
 *   priority: ContextInjectionPriority.CRITICAL,
 *   category: ContextInjectionCategory.DEPENDENCY_OUTPUT,
 *   source: "api-developer",
 *   dependencyType: "blocking",
 *   timestamp: new Date().toISOString(),
 * });
 *
 * // Legacy injection (backward compatible)
 * ctx.inject("Use TypeScript strict mode");
 *
 * // Later, when building the next prompt:
 * const prompt = ctx.buildPromptWithContext("Create a REST API");
 * // → structured injections first (sorted by priority), then legacy, then user request
 * ```
 */
export class AgentContextManager {
	/** Structured injection queue, ordered by arrival time. */
	private readonly pending: StructuredContextInjection[] = [];

	/** Legacy string injection queue for backward compatibility. */
	private readonly pendingLegacy: string[] = [];

	// ── Query ──────────────────────────────────────────────────────────────

	/** Returns `true` if there are queued instructions waiting to be sent. */
	hasPending(): boolean {
		return this.pending.length > 0 || this.pendingLegacy.length > 0;
	}

	/** Number of instructions currently queued (both structured and legacy). */
	get pendingCount(): number {
		return this.pending.length + this.pendingLegacy.length;
	}

	// ── Mutation (structured) ──────────────────────────────────────────────

	/**
	 * Pushes a structured injection onto the pending queue.
	 *
	 * If the queue exceeds MAX_PENDING_INJECTIONS or MAX_PENDING_CHARS,
	 * the lowest-priority and oldest injections are dropped to make room.
	 *
	 * @param injection - The structured injection to enqueue.
	 * @returns An object with the number of injections dropped due to overflow.
	 */
	injectStructured(injection: StructuredContextInjection): { dropped: number } {
		this.pending.push(injection);
		const dropped = this.enforceQueueLimits();
		return { dropped };
	}

	// ── Mutation (legacy — backward compatible) ────────────────────────────

	/**
	 * Pushes raw string instructions onto the pending queue.
	 * Maintained for backward compatibility with `agent.injectContext(string)`.
	 *
	 * @param instructions - The instruction text to enqueue.
	 */
	inject(instructions: string): void {
		this.pendingLegacy.push(instructions);
	}

	// ── Drain ──────────────────────────────────────────────────────────────

	/**
	 * Drains all pending instructions (both structured and legacy)
	 * and returns them merged into a single formatted string.
	 *
	 * Structured injections are sorted by priority (CRITICAL first)
	 * and formatted with category headers and source attribution.
	 *
	 * Legacy string injections are appended after structured ones
	 * with a generic header.
	 *
	 * If the queue is empty, returns `null`.
	 *
	 * @returns The merged, formatted instruction string, or `null`.
	 */
	drain(): string | null {
		if (!this.hasPending()) return null;

		const sections: string[] = [];

		// 1. Drain structured injections (sorted by priority)
		if (this.pending.length > 0) {
			const sorted = this.pending.splice(0).sort((a, b) => {
				const priorityDiff =
					(PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3);
				if (priorityDiff !== 0) return priorityDiff;
				// Same priority — maintain insertion order (stable sort)
				return 0;
			});

			for (const injection of sorted) {
				sections.push(this.formatInjection(injection));
			}
		}

		// 2. Drain legacy string injections
		if (this.pendingLegacy.length > 0) {
			const legacyItems = this.pendingLegacy.splice(0);
			for (const item of legacyItems) {
				sections.push(`--- CONTEXT ---\n${item}`);
			}
		}

		return sections.join("\n\n---\n\n");
	}

	/**
	 * Builds the final prompt string by prepending any queued context
	 * instructions to the user's prompt text.
	 *
	 * Structured injections are sorted by priority and formatted with
	 * category headers. Legacy injections follow.
	 *
	 * If no instructions are queued, the original text is returned unchanged.
	 * The queue is emptied as a side effect.
	 *
	 * @param text - The user's original prompt text.
	 * @returns The prompt with context prepended, or the original text.
	 */
	buildPromptWithContext(text: string): string {
		const context = this.drain();
		if (!context) return text;
		return `${context}\n\n---\n\nUser request:\n${text}`;
	}

	// ── Private ────────────────────────────────────────────────────────────

	/**
	 * Formats a single structured injection into a prompt-ready string.
	 *
	 * Output format:
	 * ```
	 * [📦 DEPENDENCY OUTPUT from api-developer | priority: CRITICAL | blocking dependency]
	 * <content here>
	 * ```
	 */
	private formatInjection(injection: StructuredContextInjection): string {
		const header = CATEGORY_HEADERS[injection.category] ?? "CONTEXT";
		const priorityLabel = injection.priority.toUpperCase();
		const depLabel = injection.dependencyType
			? ` | ${injection.dependencyType} dependency`
			: "";

		return (
			`[${header} from ${injection.source} | priority: ${priorityLabel}${depLabel}]\n` +
			injection.content
		);
	}

	/**
	 * Enforces queue limits by dropping low-priority injections when
	 * the queue exceeds MAX_PENDING_INJECTIONS or MAX_PENDING_CHARS.
	 *
	 * Drop strategy:
	 * 1. Drop LOW priority injections (oldest first)
	 * 2. If still over limit, drop NORMAL priority injections (oldest first)
	 * 3. Never drop HIGH or CRITICAL injections
	 *
	 * This ensures that critical information from blocking dependencies
	 * is never lost, even when the queue is saturated.
	 *
	 * @returns The number of injections dropped.
	 */
	private enforceQueueLimits(): number {
		let dropped = 0;

		// Check count limit
		while (this.pending.length > MAX_PENDING_INJECTIONS) {
			if (!this.dropLowestPriority()) break;
			dropped++;
		}

		// Check character limit
		while (this.totalPendingChars() > MAX_PENDING_CHARS) {
			if (!this.dropLowestPriority()) break;
			dropped++;
		}

		return dropped;
	}

	/**
	 * Drops the oldest injection with the lowest droppable priority.
	 * Returns true if an injection was dropped, false if nothing can be dropped.
	 */
	private dropLowestPriority(): boolean {
		// Try to drop LOW first (oldest first)
		const lowIdx = this.pending.findIndex((i) => i.priority === "low");
		if (lowIdx !== -1) {
			this.pending.splice(lowIdx, 1);
			return true;
		}

		// Then NORMAL (oldest first)
		const normalIdx = this.pending.findIndex((i) => i.priority === "normal");
		if (normalIdx !== -1) {
			this.pending.splice(normalIdx, 1);
			return true;
		}

		// HIGH and CRITICAL are never dropped
		return false;
	}

	/**
	 * Returns the total character count of all pending structured injections.
	 */
	private totalPendingChars(): number {
		let total = 0;
		for (const injection of this.pending) {
			total += injection.content.length;
		}
		return total;
	}
}
