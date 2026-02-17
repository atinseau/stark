/**
 * Manages the queue of context instructions injected into an agent.
 *
 * This is a **pure logic** class with no dependencies on logging
 * or event emission. It manages a simple FIFO queue of instruction strings
 * that can be:
 *
 *   - Injected (`inject`)       → pushed onto the queue
 *   - Prepended to a prompt     → `buildPromptWithContext` pops the queue
 *   - Drained as a batch        → `drain` pops all and merges them
 *
 * The Agent orchestrator decides *when* to drain based on status transitions;
 * this class only manages the data.
 *
 * @example
 * ```ts
 * const ctx = new AgentContextManager();
 *
 * ctx.inject("Use TypeScript strict mode");
 * ctx.inject("Prefer functional style");
 *
 * // Later, when building the next prompt:
 * const prompt = ctx.buildPromptWithContext("Create a REST API");
 * // → "Use TypeScript strict mode\n\n---\n\nPrefer functional style\n\n---\n\nUser request:\nCreate a REST API"
 * ```
 */
export class AgentContextManager {
	/** FIFO queue of context instruction strings. */
	private readonly pending: string[] = [];

	// ── Query ──────────────────────────────────────────────────────────────

	/** Returns `true` if there are queued instructions waiting to be sent. */
	hasPending(): boolean {
		return this.pending.length > 0;
	}

	/** Number of instructions currently queued. */
	get pendingCount(): number {
		return this.pending.length;
	}

	// ── Mutation ───────────────────────────────────────────────────────────

	/**
	 * Pushes new instructions onto the pending queue.
	 *
	 * @param instructions - The instruction text to enqueue.
	 */
	inject(instructions: string): void {
		this.pending.push(instructions);
	}

	/**
	 * Drains all pending instructions from the queue and returns them
	 * merged into a single string separated by `\n\n---\n\n`.
	 *
	 * If the queue is empty, returns `null`.
	 *
	 * @returns The merged instruction string, or `null` if nothing was queued.
	 */
	drain(): string | null {
		if (this.pending.length === 0) return null;

		const instructions = this.pending.splice(0);
		return instructions.join("\n\n---\n\n");
	}

	/**
	 * Builds the final prompt string by prepending any queued context
	 * instructions to the user's prompt text.
	 *
	 * If no instructions are queued, the original text is returned unchanged.
	 * The queue is emptied as a side effect.
	 *
	 * @param text - The user's original prompt text.
	 * @returns The prompt with context prepended, or the original text.
	 */
	buildPromptWithContext(text: string): string {
		if (this.pending.length === 0) return text;

		const context = this.pending.splice(0);
		const prefix = context.join("\n\n---\n\n");
		return `${prefix}\n\n---\n\nUser request:\n${text}`;
	}
}
