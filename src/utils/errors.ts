/**
 * Error serialization utilities.
 *
 * Provides a single canonical way to extract a human-readable message from
 * any caught value (`unknown`).  This replaces the fragile pattern:
 *
 *   error instanceof Error ? error.message : String(error)
 *
 * which produces the unhelpful `[object Object]` when the thrown value is a
 * plain object (e.g. a JSON-RPC error response from the ACP library).
 */

/**
 * Extract a human-readable error message from any thrown value.
 *
 * Resolution order:
 *  1. `Error` instance → `.message` (with `.cause` appended when present)
 *  2. Object with a `message` string property → that property
 *  3. Non-empty string → the string itself
 *  4. Any other object → `JSON.stringify` (truncated to keep logs sane)
 *  5. Nullish / fallback → a generic placeholder
 *
 * @param error - The caught value (typically `unknown`).
 * @param maxLength - Maximum length for JSON-stringified output (default 500).
 * @returns A non-empty string describing the error.
 */
export function toErrorMessage(error: unknown, maxLength = 500): string {
	// 1. Standard Error instances
	if (error instanceof Error) {
		let msg = error.message;
		if (error.cause) {
			msg += ` [cause: ${toErrorMessage(error.cause, maxLength)}]`;
		}
		return msg;
	}

	// 2. Duck-typed error objects (e.g. JSON-RPC errors: { code, message })
	if (
		error !== null &&
		typeof error === "object" &&
		"message" in error &&
		typeof (error as Record<string, unknown>).message === "string"
	) {
		const msg = (error as Record<string, unknown>).message as string;
		// Include extra fields like `code` or `data` if present
		const code = (error as Record<string, unknown>).code;
		const data = (error as Record<string, unknown>).data;
		const extras: string[] = [];
		if (code !== undefined) extras.push(`code=${String(code)}`);
		if (data !== undefined) {
			try {
				extras.push(`data=${JSON.stringify(data)}`);
			} catch {
				extras.push(`data=[unserializable]`);
			}
		}
		return extras.length > 0 ? `${msg} (${extras.join(", ")})` : msg;
	}

	// 3. Plain strings
	if (typeof error === "string" && error.length > 0) {
		return error;
	}

	// 4. Other objects — JSON.stringify for visibility
	if (error !== null && error !== undefined && typeof error === "object") {
		try {
			const json = JSON.stringify(error);
			if (json.length > maxLength) {
				return `${json.slice(0, maxLength)}…`;
			}
			return json;
		} catch {
			return Object.prototype.toString.call(error);
		}
	}

	// 5. Fallback
	if (error === null) return "null";
	if (error === undefined) return "undefined";
	return String(error);
}

// ── Subtask Timeout Error ──────────────────────────────────────────────────

/**
 * Thrown when a subtask exceeds its configured timeout.
 *
 * Distinguished from other errors so the retry logic can check
 * `retryOnTimeout` configuration.
 */
export class SubtaskTimeoutError extends Error {
	readonly isTimeout = true;

	constructor(
		readonly agentName: string,
		readonly subtaskId: string,
		readonly timeoutMs: number,
		readonly elapsedMs: number,
	) {
		super(
			`Subtask "${subtaskId}" (agent: ${agentName}) timed out ` +
				`after ${elapsedMs}ms (limit: ${timeoutMs}ms)`,
		);
		this.name = "SubtaskTimeoutError";
	}
}

// ── Replan Restart Error ───────────────────────────────────────────────────

/**
 * Thrown when a replan decision requires restarting the entire execution.
 *
 * This is a flow-control error caught by `execute()` to trigger a full
 * restart of the execution pipeline. It is NOT a "real" error — it signals
 * that the planner decided the current plan is unsalvageable and a fresh
 * start is needed.
 */
export class ReplanRestartError extends Error {
	readonly isReplanRestart = true;

	constructor(readonly decision: { readonly reasoning: string }) {
		super(`Replan requires restart: ${decision.reasoning}`);
		this.name = "ReplanRestartError";
	}
}

/**
 * Wrap any thrown value into a proper `Error` instance.
 *
 * If the value is already an `Error`, it is returned as-is.
 * Otherwise a new `Error` is created with the message produced by
 * {@link toErrorMessage}, and the original value is attached as `.cause`.
 */
export function toError(error: unknown): Error {
	if (error instanceof Error) return error;
	const wrapped = new Error(toErrorMessage(error));
	wrapped.cause = error;
	return wrapped;
}
