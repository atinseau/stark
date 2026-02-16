import type { Tracer } from "../../tracer/tracer.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Records a context injection as an event on the root span.
 *
 * The instructions text is truncated to 500 characters in the span event
 * attributes to avoid excessively large traces.
 *
 * @param tracer       - The tracer instance.
 * @param instructions - The injected instructions text.
 * @param queued       - Whether the injection was queued (agent busy) or immediate.
 */
export function recordContextInjection(
	tracer: Tracer,
	instructions: string,
	queued: boolean,
): void {
	tracer.recordEvent("root", "context.injected", {
		"context.instructions": instructions.slice(0, 500),
		"context.instructions_length": instructions.length,
		"context.queued": queued ? "true" : "false",
	});
}
