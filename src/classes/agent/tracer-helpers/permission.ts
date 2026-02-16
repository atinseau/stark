import { type Span, SpanStatusCode } from "@opentelemetry/api";

import type { Tracer } from "../../tracer/tracer.ts";

// ── Types ──────────────────────────────────────────────────────────────────

/** Attributes for starting a permission span. */
export interface PermissionSpanAttributes {
	toolCallId: string;
	toolCallTitle?: string;
}

/** Details provided when ending a permission span. */
export interface PermissionEndDetails {
	optionId?: string;
	optionName?: string;
	reason?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Starts an `agent.permission` span as a child of the relevant tool call
 * span (if found via tracked spans), or as a child of the active span.
 *
 * @param tracer - The tracer instance.
 * @param attrs  - Permission request attributes.
 * @returns The started span (or a no-op span when tracing is disabled).
 */
export function startPermission(
	tracer: Tracer,
	attrs: PermissionSpanAttributes,
): Span {
	// Try to parent under the tool call span if it exists
	const toolSpan = tracer.getTrackedSpan(attrs.toolCallId);
	const parent = toolSpan ?? "active";

	return tracer.startOperation(
		"agent.permission",
		{
			"permission.tool_call_id": attrs.toolCallId,
			...(attrs.toolCallTitle && {
				"permission.tool_call_title": attrs.toolCallTitle,
			}),
		},
		parent,
	);
}

/**
 * Ends a permission span with the outcome.
 *
 * @param span    - The permission span to end.
 * @param outcome - Whether permission was granted or denied.
 * @param details - Additional details (optionId/name or denial reason).
 */
export function endPermission(
	span: Span,
	outcome: "granted" | "denied",
	details?: PermissionEndDetails,
): void {
	if (!span.isRecording()) return;

	span.setAttribute("permission.outcome", outcome);

	if (details?.optionId) {
		span.setAttribute("permission.option_id", details.optionId);
	}
	if (details?.optionName) {
		span.setAttribute("permission.option_name", details.optionName);
	}
	if (details?.reason) {
		span.setAttribute("permission.denial_reason", details.reason);
	}

	span.setStatus(
		outcome === "granted"
			? { code: SpanStatusCode.OK }
			: {
					code: SpanStatusCode.ERROR,
					message: details?.reason ?? "Permission denied",
				},
	);

	span.end();
}
