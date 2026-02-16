import type { Tracer } from "../../tracer/tracer.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Records a usage update as an event on the active span
 * (falling back to the root span when no active span exists).
 *
 * @param tracer  - The tracer instance.
 * @param used    - Tokens currently in use.
 * @param size    - Total context window size.
 * @param percent - Percentage of context used (0–100).
 */
export function recordUsage(
	tracer: Tracer,
	used: number,
	size: number,
	percent: number,
): void {
	tracer.recordEvent("auto", "usage.update", {
		"usage.context_used": used,
		"usage.context_size": size,
		"usage.context_percent": percent,
	});
}
