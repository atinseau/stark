import {
	context,
	type Span,
	type SpanContext,
	SpanStatusCode,
	type Tracer,
	trace,
} from "@opentelemetry/api";
import type { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import {
	createTracerProvider,
	type TracerProviderConfig,
} from "../../tracer/create-tracer-provider.ts";
import type { AgentIdentity } from "../../types/agent.types.ts";

// ── AgentTracer Config ─────────────────────────────────────────────────────

/**
 * Configuration for the AgentTracer.
 *
 * Extends `TracerProviderConfig` with an `enabled` flag and an optional
 * `provider` override for dependency injection (used in tests with
 * `InMemorySpanExporter`).
 */
export interface AgentTracerConfig extends TracerProviderConfig {
	/** Whether tracing is active. When `false`, all methods return no-op spans. */
	enabled?: boolean;

	/**
	 * Optional pre-configured tracer provider.
	 *
	 * When provided, the `AgentTracer` uses this provider instead of creating
	 * its own via `createTracerProvider()`. This is primarily useful for testing
	 * with an `InMemorySpanExporter`.
	 *
	 * @example
	 * ```ts
	 * const exporter = new InMemorySpanExporter();
	 * const provider = new BasicTracerProvider({
	 *   spanProcessors: [new SimpleSpanProcessor(exporter)],
	 * });
	 * const tracer = new AgentTracer(identity, { enabled: true, provider });
	 * ```
	 */
	provider?: BasicTracerProvider;
}

// ── Trace Context (for log correlation) ────────────────────────────────────

/**
 * Trace context information that can be injected into Pino log lines
 * to correlate logs with their parent trace in Seq.
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
}

// ── Types ──────────────────────────────────────────────────────────────────

/** Attributes attached to tool call spans. */
export interface ToolCallSpanAttributes {
	toolCallId: string;
	title: string;
	kind?: string;
	command?: string;
}

/** Attributes attached to file system spans. */
export interface FsSpanAttributes {
	path: string;
	operation: "read" | "write";
	contentLength?: number;
}

/** Attributes attached to terminal spans. */
export interface TerminalSpanAttributes {
	terminalId: string;
	command: string;
	args?: string[];
	cwd?: string;
}

/** Attributes attached to permission spans. */
export interface PermissionSpanAttributes {
	toolCallId: string;
	toolCallTitle?: string;
	outcome?: "granted" | "denied";
	optionId?: string;
	optionName?: string;
	reason?: string;
}

// ── No-Op Sentinel ─────────────────────────────────────────────────────────

/**
 * A lightweight no-op span used when tracing is disabled.
 * Avoids polluting calling code with `null` checks everywhere.
 */
const NOOP_SPAN: Span = {
	spanContext: () => ({
		traceId: "0".repeat(32),
		spanId: "0".repeat(16),
		traceFlags: 0,
	}),
	setAttribute: () => NOOP_SPAN,
	setAttributes: () => NOOP_SPAN,
	addEvent: () => NOOP_SPAN,
	addLink: () => NOOP_SPAN,
	addLinks: () => NOOP_SPAN,
	setStatus: () => NOOP_SPAN,
	updateName: () => NOOP_SPAN,
	end: () => {},
	isRecording: () => false,
	recordException: () => {},
};

// ── AgentTracer ────────────────────────────────────────────────────────────

/**
 * High-level tracing wrapper for the Agent lifecycle.
 *
 * Manages OpenTelemetry spans that map to the Agent's operational hierarchy:
 *
 *   Trace (one per agent instance)
 *   └── session (root span — entire agent lifetime)
 *       ├── initialize
 *       │   ├── spawn-process
 *       │   ├── acp-protocol-init
 *       │   └── create-session
 *       ├── prompt #1
 *       │   ├── tool-call "Verify Docker"
 *       │   │   └── permission-request
 *       │   ├── tool-call "Start OrbStack"
 *       │   │   └── permission-request
 *       │   └── ...
 *       ├── prompt #2
 *       │   └── ...
 *       └── destroy
 *
 * When tracing is disabled (`enabled: false`), every method returns a
 * no-op span so the Agent class doesn't need conditional logic.
 *
 * @example
 * ```ts
 * const tracer = new AgentTracer(identity, { enabled: true });
 *
 * const sessionSpan = tracer.startSession();
 * const initSpan = tracer.startInitialize();
 * // ... initialization work ...
 * tracer.endInitialize(initSpan);
 *
 * const promptSpan = tracer.startPrompt(1, "Hello agent");
 * const toolSpan = tracer.startToolCall({ toolCallId: "tc-1", title: "Run cmd", kind: "execute" });
 * // ... tool work ...
 * tracer.endToolCall(toolSpan, "completed");
 * tracer.endPrompt(promptSpan, "end_turn");
 *
 * await tracer.shutdown();
 * ```
 */
export class AgentTracer {
	/** Whether tracing is active. When `false`, all methods return no-op spans. */
	readonly enabled: boolean;

	/**
	 * Returns the current trace context for log correlation.
	 *
	 * When tracing is enabled, this returns the `TraceId` and `SpanId` of the
	 * most specific active span (prompt > session), which can be spread into
	 * Pino log bindings so Seq automatically links log events to their trace.
	 *
	 * When tracing is disabled, returns `undefined`.
	 *
	 * @example
	 * ```ts
	 * const ctx = tracer.getTraceContext();
	 * if (ctx) logger.info({ ...ctx }, "Something happened");
	 * // In Seq, this log line will appear linked to the active trace/span.
	 * ```
	 */
	getTraceContext(): TraceContext | undefined {
		if (!this.enabled) return undefined;

		// Pick the most specific active span
		const span = this.activePromptSpan ?? this.sessionSpan;
		if (!span || span === NOOP_SPAN) return undefined;

		const ctx: SpanContext = span.spanContext();
		return {
			TraceId: ctx.traceId,
			SpanId: ctx.spanId,
		};
	}

	/** The agent identity this tracer is bound to. */
	private readonly identity: AgentIdentity;

	/** The underlying OTel tracer provider (null when disabled). */
	private provider: BasicTracerProvider | null = null;

	/** The underlying OTel tracer instance (null when disabled). */
	private tracer: Tracer | null = null;

	/** The root session span that is the parent of all other spans. */
	private sessionSpan: Span | null = null;

	/** The currently active prompt span (only one prompt at a time). */
	private activePromptSpan: Span | null = null;

	/** Map of active tool call spans keyed by toolCallId. */
	private readonly activeToolSpans = new Map<string, Span>();

	// ── Constructor ──────────────────────────────────────────────────────

	/**
	 * Creates a new AgentTracer.
	 *
	 * @param identity - The agent's identity, used as span attributes.
	 * @param config   - Tracing configuration. Pass `{ enabled: false }` to
	 *                   create a no-op tracer that has zero overhead.
	 *                   Pass `{ provider }` to inject a custom tracer provider
	 *                   (useful for testing with `InMemorySpanExporter`).
	 */
	constructor(identity: AgentIdentity, config?: AgentTracerConfig) {
		this.identity = identity;
		this.enabled = config?.enabled ?? true;

		if (this.enabled) {
			// Use injected provider (tests) or create one (production)
			this.provider =
				config?.provider ??
				createTracerProvider({
					...config,
					serviceName: config?.serviceName ?? "stark-agent",
				});
			this.tracer = this.provider.getTracer("stark-agent", "0.1.0");
		}
	}

	// ── Session (Root Span) ──────────────────────────────────────────────

	/**
	 * Starts the root session span that encompasses the entire agent lifetime.
	 * All subsequent spans are created as children of this span.
	 *
	 * @returns The root session span.
	 */
	startSession(): Span {
		if (!this.tracer) return NOOP_SPAN;

		const span = this.tracer.startSpan("agent.session", {
			attributes: {
				"agent.id": this.identity.id,
				"agent.name": this.identity.name,
			},
		});

		this.sessionSpan = span;
		return span;
	}

	/**
	 * Ends the root session span with an appropriate status.
	 *
	 * @param status  - Whether the session ended normally or with an error.
	 * @param message - Optional status message (used for errors).
	 */
	endSession(status: "ok" | "error" = "ok", message?: string): void {
		if (!this.sessionSpan || this.sessionSpan === NOOP_SPAN) return;

		this.sessionSpan.setStatus(
			status === "ok"
				? { code: SpanStatusCode.OK }
				: { code: SpanStatusCode.ERROR, message },
		);
		this.sessionSpan.end();
		this.sessionSpan = null;
	}

	// ── Initialize ───────────────────────────────────────────────────────

	/**
	 * Starts an `agent.initialize` span as a child of the session span.
	 *
	 * @returns The initialize span.
	 */
	startInitialize(): Span {
		return this.startChildSpan("agent.initialize");
	}

	/**
	 * Starts a sub-span within initialization for a specific phase.
	 *
	 * @param phase - One of the initialization phases.
	 * @param parentSpan - The parent initialize span.
	 * @returns The phase span.
	 */
	startInitPhase(
		phase: "spawn-process" | "acp-protocol-init" | "create-session",
		parentSpan: Span,
	): Span {
		return this.startChildOfSpan(`agent.initialize.${phase}`, parentSpan);
	}

	/**
	 * Ends an initialization span (or sub-phase span).
	 */
	endInitialize(span: Span, error?: Error): void {
		this.endSpanWithStatus(span, error);
	}

	// ── Prompt ───────────────────────────────────────────────────────────

	/**
	 * Starts an `agent.prompt` span as a child of the session span.
	 * Stores it as the active prompt span so tool calls can be parented to it.
	 *
	 * @param promptIndex - The sequential prompt number.
	 * @param promptText  - The prompt text (truncated in attributes).
	 * @returns The prompt span.
	 */
	startPrompt(promptIndex: number, promptText: string): Span {
		const span = this.startChildSpan("agent.prompt", {
			"prompt.index": promptIndex,
			"prompt.text": promptText.slice(0, 500),
			"prompt.text_length": promptText.length,
		});

		this.activePromptSpan = span;
		return span;
	}

	/**
	 * Ends the active prompt span.
	 *
	 * @param span       - The prompt span to end.
	 * @param stopReason - The ACP stop reason.
	 * @param error      - Optional error if the prompt failed.
	 */
	endPrompt(span: Span, stopReason?: string, error?: Error): void {
		if (span !== NOOP_SPAN && stopReason) {
			span.setAttribute("prompt.stop_reason", stopReason);
		}
		this.endSpanWithStatus(span, error);
		this.activePromptSpan = null;
	}

	// ── Tool Calls ───────────────────────────────────────────────────────

	/**
	 * Starts an `agent.tool_call` span as a child of the current prompt span.
	 * The span is tracked internally by `toolCallId` so it can be ended later
	 * when the tool call completes or fails.
	 *
	 * @param attrs - Tool call attributes.
	 * @returns The tool call span.
	 */
	startToolCall(attrs: ToolCallSpanAttributes): Span {
		const parentSpan = this.activePromptSpan ?? this.sessionSpan;
		if (!this.tracer || !parentSpan || parentSpan === NOOP_SPAN)
			return NOOP_SPAN;

		const parentCtx = trace.setSpan(context.active(), parentSpan);
		const span = this.tracer.startSpan(
			"agent.tool_call",
			{
				attributes: {
					"tool.call_id": attrs.toolCallId,
					"tool.title": attrs.title,
					...(attrs.kind && { "tool.kind": attrs.kind }),
					...(attrs.command && { "tool.command": attrs.command }),
				},
			},
			parentCtx,
		);

		this.activeToolSpans.set(attrs.toolCallId, span);
		return span;
	}

	/**
	 * Adds an update event to an active tool call span.
	 *
	 * @param toolCallId - The tool call to update.
	 * @param status     - The new status.
	 * @param output     - Optional output text (truncated).
	 * @param exitCode   - Optional exit code.
	 */
	updateToolCall(
		toolCallId: string,
		status?: string,
		output?: string,
		exitCode?: number,
	): void {
		const span = this.activeToolSpans.get(toolCallId);
		if (!span || span === NOOP_SPAN) return;

		const eventAttrs: Record<string, string | number> = {};
		if (status) eventAttrs.status = status;
		if (output) eventAttrs.output = output.slice(0, 1000);
		if (exitCode !== undefined) eventAttrs.exit_code = exitCode;

		span.addEvent("tool.update", eventAttrs);
	}

	/**
	 * Ends a tool call span.
	 *
	 * @param toolCallId - The tool call to end.
	 * @param status     - Final status (`"completed"` or `"failed"`).
	 * @param exitCode   - Optional exit code.
	 */
	endToolCall(toolCallId: string, status?: string, exitCode?: number): void {
		const span = this.activeToolSpans.get(toolCallId);
		if (!span || span === NOOP_SPAN) return;

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
		this.activeToolSpans.delete(toolCallId);
	}

	// ── Permissions ──────────────────────────────────────────────────────

	/**
	 * Starts an `agent.permission` span as a child of the relevant tool call
	 * span (if found), or as a child of the active prompt span.
	 *
	 * @param attrs - Permission request attributes.
	 * @returns The permission span.
	 */
	startPermission(attrs: PermissionSpanAttributes): Span {
		// Try to parent under the tool call span
		const toolSpan = this.activeToolSpans.get(attrs.toolCallId);
		const parentSpan = toolSpan ?? this.activePromptSpan ?? this.sessionSpan;

		if (!this.tracer || !parentSpan || parentSpan === NOOP_SPAN)
			return NOOP_SPAN;

		const parentCtx = trace.setSpan(context.active(), parentSpan);
		return this.tracer.startSpan(
			"agent.permission",
			{
				attributes: {
					"permission.tool_call_id": attrs.toolCallId,
					...(attrs.toolCallTitle && {
						"permission.tool_call_title": attrs.toolCallTitle,
					}),
				},
			},
			parentCtx,
		);
	}

	/**
	 * Ends a permission span with the outcome.
	 *
	 * @param span    - The permission span.
	 * @param outcome - Whether permission was granted or denied.
	 * @param details - Additional details (optionId/name or denial reason).
	 */
	endPermission(
		span: Span,
		outcome: "granted" | "denied",
		details?: { optionId?: string; optionName?: string; reason?: string },
	): void {
		if (span === NOOP_SPAN) return;

		span.setAttribute("permission.outcome", outcome);
		if (details?.optionId)
			span.setAttribute("permission.option_id", details.optionId);
		if (details?.optionName)
			span.setAttribute("permission.option_name", details.optionName);
		if (details?.reason)
			span.setAttribute("permission.denial_reason", details.reason);

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

	// ── File System ──────────────────────────────────────────────────────

	/**
	 * Starts an `agent.fs` span as a child of the active prompt span.
	 *
	 * @param attrs - File system operation attributes.
	 * @returns The file system span.
	 */
	startFs(attrs: FsSpanAttributes): Span {
		const parentSpan = this.activePromptSpan ?? this.sessionSpan;
		if (!this.tracer || !parentSpan || parentSpan === NOOP_SPAN)
			return NOOP_SPAN;

		const parentCtx = trace.setSpan(context.active(), parentSpan);
		return this.tracer.startSpan(
			`agent.fs.${attrs.operation}`,
			{
				attributes: {
					"fs.path": attrs.path,
					"fs.operation": attrs.operation,
					...(attrs.contentLength !== undefined && {
						"fs.content_length": attrs.contentLength,
					}),
				},
			},
			parentCtx,
		);
	}

	/**
	 * Ends a file system span.
	 *
	 * @param span          - The span to end.
	 * @param contentLength - Final content length (set if not provided at start).
	 * @param error         - Optional error if the operation failed.
	 */
	endFs(span: Span, contentLength?: number, error?: Error): void {
		if (span !== NOOP_SPAN && contentLength !== undefined) {
			span.setAttribute("fs.content_length", contentLength);
		}
		this.endSpanWithStatus(span, error);
	}

	// ── Terminal ─────────────────────────────────────────────────────────

	/**
	 * Starts an `agent.terminal` span as a child of the active prompt span.
	 *
	 * @param attrs - Terminal command attributes.
	 * @returns The terminal span.
	 */
	startTerminal(attrs: TerminalSpanAttributes): Span {
		const parentSpan = this.activePromptSpan ?? this.sessionSpan;
		if (!this.tracer || !parentSpan || parentSpan === NOOP_SPAN)
			return NOOP_SPAN;

		const parentCtx = trace.setSpan(context.active(), parentSpan);
		return this.tracer.startSpan(
			"agent.terminal",
			{
				attributes: {
					"terminal.id": attrs.terminalId,
					"terminal.command": attrs.command,
					...(attrs.args && { "terminal.args": attrs.args.join(" ") }),
					...(attrs.cwd && { "terminal.cwd": attrs.cwd }),
				},
			},
			parentCtx,
		);
	}

	/**
	 * Ends a terminal span.
	 *
	 * @param span     - The span to end.
	 * @param exitCode - Exit code of the terminal command.
	 * @param signal   - Signal that terminated the process, if any.
	 */
	endTerminal(
		span: Span,
		exitCode?: number | null,
		signal?: string | null,
	): void {
		if (span === NOOP_SPAN) return;

		if (exitCode !== undefined && exitCode !== null) {
			span.setAttribute("terminal.exit_code", exitCode);
		}
		if (signal) {
			span.setAttribute("terminal.signal", signal);
		}

		const failed =
			exitCode !== undefined && exitCode !== null && exitCode !== 0;
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

	// ── Context Injection ────────────────────────────────────────────────

	/**
	 * Records a context injection as an event on the session span.
	 *
	 * @param instructions - The injected instructions (truncated).
	 * @param queued       - Whether the injection was queued or immediate.
	 */
	recordContextInjection(instructions: string, queued: boolean): void {
		if (!this.sessionSpan || this.sessionSpan === NOOP_SPAN) return;

		this.sessionSpan.addEvent("context.injected", {
			"context.instructions": instructions.slice(0, 500),
			"context.instructions_length": instructions.length,
			"context.queued": queued ? "true" : "false",
		});
	}

	// ── Usage ────────────────────────────────────────────────────────────

	/**
	 * Records a usage update as an event on the active prompt span.
	 *
	 * @param used    - Tokens currently in use.
	 * @param size    - Total context window size.
	 * @param percent - Percentage of context used.
	 */
	recordUsage(used: number, size: number, percent: number): void {
		const span = this.activePromptSpan ?? this.sessionSpan;
		if (!span || span === NOOP_SPAN) return;

		span.addEvent("usage.update", {
			"usage.context_used": used,
			"usage.context_size": size,
			"usage.context_percent": percent,
		});
	}

	// ── Flush & Shutdown ─────────────────────────────────────────────────

	/**
	 * Ends all lingering spans and flushes them to the exporter, but does
	 * **not** shut down the provider. This allows callers (e.g. tests) to
	 * inspect exported spans before the provider clears the exporter.
	 *
	 * After calling `flush()`, no new spans should be created.
	 *
	 * @see {@link shutdown} — calls `flush()` then tears down the provider.
	 */
	async flush(): Promise<void> {
		// End any lingering tool call spans
		for (const [toolCallId, span] of this.activeToolSpans) {
			span.setStatus({
				code: SpanStatusCode.ERROR,
				message: "Agent destroyed before tool call completed",
			});
			span.end();
			this.activeToolSpans.delete(toolCallId);
		}

		// End prompt span if still active
		if (this.activePromptSpan && this.activePromptSpan !== NOOP_SPAN) {
			this.activePromptSpan.setStatus({
				code: SpanStatusCode.ERROR,
				message: "Agent destroyed during prompt",
			});
			this.activePromptSpan.end();
			this.activePromptSpan = null;
		}

		// End session span
		this.endSession("ok");

		// Flush pending spans to the exporter (does NOT clear the exporter)
		if (this.provider) {
			await this.provider.forceFlush();
		}
	}

	/**
	 * Flushes all pending spans and shuts down the tracer provider.
	 *
	 * Must be called during `Agent.destroy()` to ensure all spans are exported.
	 * After shutdown, the provider is torn down and the exporter is cleared.
	 *
	 * If you need to inspect spans after flush (e.g. in tests), call
	 * {@link flush} first, read the exporter, then call `shutdown()`.
	 */
	async shutdown(): Promise<void> {
		await this.flush();

		// Tear down the provider (also calls exporter.shutdown → clears spans)
		if (this.provider) {
			await this.provider.shutdown();
			this.provider = null;
			this.tracer = null;
		}
	}

	// ── Private Helpers ──────────────────────────────────────────────────

	/**
	 * Starts a span as a child of the root session span.
	 */
	private startChildSpan(
		name: string,
		attributes?: Record<string, string | number | boolean>,
	): Span {
		if (!this.tracer || !this.sessionSpan || this.sessionSpan === NOOP_SPAN) {
			return NOOP_SPAN;
		}

		const parentCtx = trace.setSpan(context.active(), this.sessionSpan);
		return this.tracer.startSpan(name, { attributes }, parentCtx);
	}

	/**
	 * Starts a span as a child of an explicit parent span.
	 */
	private startChildOfSpan(
		name: string,
		parentSpan: Span,
		attributes?: Record<string, string | number | boolean>,
	): Span {
		if (!this.tracer || parentSpan === NOOP_SPAN) return NOOP_SPAN;

		const parentCtx = trace.setSpan(context.active(), parentSpan);
		return this.tracer.startSpan(name, { attributes }, parentCtx);
	}

	/**
	 * Ends a span, setting its status based on whether an error was provided.
	 */
	private endSpanWithStatus(span: Span, error?: Error): void {
		if (span === NOOP_SPAN) return;

		if (error) {
			span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
			span.recordException(error);
		} else {
			span.setStatus({ code: SpanStatusCode.OK });
		}

		span.end();
	}
}
