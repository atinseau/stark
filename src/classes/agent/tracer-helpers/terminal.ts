import { type Span, SpanStatusCode } from "@opentelemetry/api";

import type { Tracer } from "../../tracer/tracer.ts";

// ── Types ──────────────────────────────────────────────────────────────────

/** Attributes for starting a terminal span. */
export interface TerminalSpanAttributes {
	terminalId: string;
	command: string;
	args?: string[];
	cwd?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Starts an `agent.terminal` span as a child of the active span
 * and tracks it by `terminalId` so it can be ended later via
 * {@link endTerminalById} when the terminal process exits.
 *
 * @param tracer - The tracer instance.
 * @param attrs  - Terminal command attributes.
 * @returns The started span (or a no-op span when tracing is disabled).
 */
export function startTerminal(
	tracer: Tracer,
	attrs: TerminalSpanAttributes,
): Span {
	const span = tracer.startOperation(
		"agent.terminal",
		{
			"terminal.id": attrs.terminalId,
			"terminal.command": attrs.command,
			...(attrs.args && { "terminal.args": attrs.args.join(" ") }),
			...(attrs.cwd && { "terminal.cwd": attrs.cwd }),
		},
		"active",
	);

	tracer.trackSpan(attrs.terminalId, span, "terminal");
	return span;
}

/**
 * Ends a terminal span by its direct span reference.
 *
 * Sets status based on exit code: 0 or null → OK, non-zero → ERROR.
 * If a signal is provided, it is recorded as an attribute.
 *
 * @param span     - The terminal span to end.
 * @param exitCode - Exit code of the terminal command.
 * @param signal   - Signal that terminated the process, if any.
 */
export function endTerminal(
	span: Span,
	exitCode?: number | null,
	signal?: string | null,
): void {
	if (!span.isRecording()) return;

	if (exitCode !== undefined && exitCode !== null) {
		span.setAttribute("terminal.exit_code", exitCode);
	}
	if (signal) {
		span.setAttribute("terminal.signal", signal);
	}

	const failed = exitCode !== undefined && exitCode !== null && exitCode !== 0;

	span.setStatus(
		failed
			? {
					code: SpanStatusCode.ERROR,
					message: `Terminal exited with code ${exitCode}`,
				}
			: { code: SpanStatusCode.OK },
	);

	span.end();
}

/**
 * Ends a terminal span by its terminal ID.
 *
 * This is the counterpart to {@link startTerminal} that allows ending
 * the span from a different call site (e.g., the terminal exit callback
 * in the Agent constructor) without needing the original span reference.
 *
 * No-op if the terminal ID is unknown or was already ended.
 *
 * @param tracer     - The tracer instance.
 * @param terminalId - The terminal whose span should be ended.
 * @param exitCode   - Exit code of the terminal command.
 * @param signal     - Signal that terminated the process, if any.
 */
export function endTerminalById(
	tracer: Tracer,
	terminalId: string,
	exitCode?: number | null,
	signal?: string | null,
): void {
	const span = tracer.removeTrackedSpan(terminalId);
	if (!span) return;

	endTerminal(span, exitCode, signal);
}
