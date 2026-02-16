import type { AgentEvent } from "../enums/agent-event.enum.ts";
import type { AgentEventMap, BaseAgentEvent } from "./events.types.ts";

// ── Trace Context (for log ↔ trace correlation) ────────────────────────────

/**
 * Trace context information that can be injected into log lines
 * to correlate logs with their parent trace in backends like Seq.
 *
 * When a log event carries `TraceId` and `SpanId`, Seq automatically
 * links it to the corresponding span in the Traces view.
 *
 * Seq expects the fields to be named exactly `TraceId` and `SpanId`
 * (PascalCase) to enable automatic correlation.
 */
export interface TraceContext {
	/** The W3C trace ID (32 hex chars). */
	TraceId: string;
	/** The current span ID (16 hex chars). */
	SpanId: string;
	/**
	 * The parent span ID (16 hex chars), if the current span has a parent.
	 *
	 * Present when the current span is a child of another span (e.g., a
	 * prompt span parented under the root session span, or a tool call
	 * span parented under the prompt span). Absent for root spans.
	 *
	 * Seq and other backends use this field to reconstruct the span
	 * hierarchy directly from log events, even without OTLP trace data.
	 */
	ParentSpanId?: string;
}

/**
 * A function that returns the current trace context dynamically.
 *
 * Used as a pino `mixin` provider so that every log line carries
 * the `TraceId`/`SpanId` of the **currently active** span rather than
 * the span that was active at logger-creation time.
 *
 * @returns The current trace context, or `undefined` when tracing is disabled.
 */
export type LogTraceProvider = () => TraceContext | undefined;

// ── Typed Event Emission ───────────────────────────────────────────────────

/**
 * Callback signature used by agent sub-components to emit typed events.
 *
 * Matches the `emitTyped` pattern from the Agent class so that child
 * components (session update handler, ACP client factory) don't need
 * to know about EventEmitter internals.
 *
 * The `BaseAgentEvent` fields (event type, timestamp, agent identity)
 * are injected automatically by the Agent — callers only supply the
 * domain-specific payload.
 */
export type EmitEventFn = <K extends AgentEvent>(
	event: K,
	payload: Omit<AgentEventMap[K], keyof BaseAgentEvent>,
) => void;
