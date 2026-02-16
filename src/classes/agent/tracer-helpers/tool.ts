import { SpanStatusCode } from "@opentelemetry/api";

import type { Tracer } from "../../tracer/tracer.ts";

// ── Types ──────────────────────────────────────────────────────────────────

/** Attributes for starting a tool call span. */
export interface ToolCallSpanAttributes {
	toolCallId: string;
	title: string;
	kind?: string;
	command?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Starts an `agent.tool_call` span as a child of the current active span
 * and tracks it by `toolCallId` so it can be ended later.
 *
 * @param tracer - The tracer instance.
 * @param attrs  - Tool call attributes.
 * @returns The started span (or a no-op span when tracing is disabled).
 */
export function startToolCall(
	tracer: Tracer,
	attrs: ToolCallSpanAttributes,
): void {
	const span = tracer.startOperation(
		"agent.tool_call",
		{
			"tool.call_id": attrs.toolCallId,
			"tool.title": attrs.title,
			...(attrs.kind && { "tool.kind": attrs.kind }),
			...(attrs.command && { "tool.command": attrs.command }),
		},
		"active",
	);

	tracer.trackSpan(attrs.toolCallId, span, "tool call");
}

/**
 * Adds an update event to an active tool call span.
 *
 * No-op if the tool call ID is unknown or tracing is disabled.
 *
 * @param tracer     - The tracer instance.
 * @param toolCallId - The tool call to update.
 * @param status     - The new status.
 * @param output     - Optional output text (truncated to 1000 chars).
 * @param exitCode   - Optional exit code.
 */
export function updateToolCall(
	tracer: Tracer,
	toolCallId: string,
	status?: string,
	output?: string,
	exitCode?: number,
): void {
	const span = tracer.getTrackedSpan(toolCallId);
	if (!span || !span.isRecording()) return;

	const eventAttrs: Record<string, string | number> = {};
	if (status) eventAttrs.status = status;
	if (output) eventAttrs.output = output.slice(0, 1000);
	if (exitCode !== undefined) eventAttrs.exit_code = exitCode;

	span.addEvent("tool.update", eventAttrs);
}

/**
 * Ends a tool call span, setting its status based on the outcome.
 *
 * No-op if the tool call ID is unknown or tracing is disabled.
 *
 * @param tracer     - The tracer instance.
 * @param toolCallId - The tool call to end.
 * @param status     - Final status (`"completed"` or `"failed"`).
 * @param exitCode   - Optional exit code.
 */
export function endToolCall(
	tracer: Tracer,
	toolCallId: string,
	status?: string,
	exitCode?: number,
): void {
	const span = tracer.removeTrackedSpan(toolCallId);
	if (!span || !span.isRecording()) return;

	if (status) span.setAttribute("tool.status", status);
	if (exitCode !== undefined) span.setAttribute("tool.exit_code", exitCode);

	const failed =
		status === "failed" || (exitCode !== undefined && exitCode !== 0);

	span.setStatus(
		failed
			? {
					code: SpanStatusCode.ERROR,
					message: `Tool ${status ?? "failed"} (exit ${exitCode ?? "?"})`,
				}
			: { code: SpanStatusCode.OK },
	);

	span.end();
}
