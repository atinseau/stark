import {
	context,
	type Tracer as OtelTracer,
	type Span,
	type SpanContext,
	SpanStatusCode,
	trace,
} from "@opentelemetry/api";
import type { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import type { TraceContext } from "../../types/observability.types.ts";
import {
	DEFAULT_SERVICE_NAME,
	DEFAULT_TRACER_NAME,
	DEFAULT_TRACER_VERSION,
} from "./constants.ts";
import {
	createTracerProvider,
	type TracerProviderConfig,
} from "./create-tracer-provider.ts";

// ── Re-export TraceContext so consumers can import from this module ─────────
export type { TraceContext };

// ── Tracer Config ──────────────────────────────────────────────────────────

/**
 * Configuration for the Tracer.
 *
 * Extends `TracerProviderConfig` with an `enabled` flag and an optional
 * `provider` override for dependency injection (used in tests with
 * `InMemorySpanExporter`).
 */
export interface TracerConfig extends TracerProviderConfig {
	/** Whether tracing is active. When `false`, all methods return no-op spans. */
	enabled?: boolean;

	/**
	 * Optional pre-configured tracer provider.
	 *
	 * When provided, the `Tracer` uses this provider instead of creating
	 * its own via `createTracerProvider()`. This is primarily useful for testing
	 * with an `InMemorySpanExporter`.
	 *
	 * @example
	 * ```ts
	 * const exporter = new InMemorySpanExporter();
	 * const provider = new BasicTracerProvider({
	 *   spanProcessors: [new SimpleSpanProcessor(exporter)],
	 * });
	 * const tracer = new Tracer({ enabled: true, provider });
	 * ```
	 */
	provider?: BasicTracerProvider;

	/**
	 * The tracer name used when calling `provider.getTracer(name)`.
	 * @default "stark"
	 */
	tracerName?: string;

	/**
	 * The tracer version used when calling `provider.getTracer(name, version)`.
	 * @default "0.1.0"
	 */
	tracerVersion?: string;
}

// ── Parent Strategy ────────────────────────────────────────────────────────

/**
 * Determines which span a new operation span should be parented under.
 *
 * - `"root"`   → child of the root span
 * - `"active"` → child of the active span (falls back to root)
 * - `Span`     → child of an explicit parent span
 */
export type ParentStrategy = "root" | "active" | Span;

// ── Attribute Value Type ───────────────────────────────────────────────────

/** Values accepted by OpenTelemetry span attributes. */
export type SpanAttributeValue = string | number | boolean;

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

// ── Tracer ─────────────────────────────────────────────────────────────────

/**
 * Generic, domain-agnostic tracing wrapper around OpenTelemetry.
 *
 * Manages a span hierarchy with two named "slots":
 *
 *   Trace (one per Tracer instance)
 *   └── root span (entire lifetime of the traced entity)
 *       ├── child operation spans
 *       │   └── nested operations…
 *       ├── active span (the current "work unit" in progress)
 *       │   ├── child operations…
 *       │   └── …
 *       └── …
 *
 * The **root span** represents the overall lifetime of the entity being
 * traced (e.g., an agent session, a pipeline run, a request).
 *
 * The **active span** represents the currently running work unit (e.g.,
 * a prompt turn, a pipeline stage, a request handler). Only one active
 * span exists at a time; it is automatically used as the parent for
 * operations started with `parent: "active"`.
 *
 * When tracing is disabled (`enabled: false`), every method returns a
 * no-op span so calling code doesn't need conditional logic.
 *
 * ### Design Philosophy — Generic Core + External Helpers
 *
 * `Tracer` is intentionally domain-agnostic. It provides:
 *
 *   1. **Root span management**: `startRootSpan` / `endRootSpan`
 *
 *   2. **Active span management**: `startActiveSpan` / `endActiveSpan`
 *
 *   3. **Generic span API**: `startOperation`, `endOperation`, `traced`
 *      for creating arbitrary child spans.
 *
 *   4. **Span tracking**: `trackSpan`, `getTrackedSpan`, `removeTrackedSpan`
 *      for long-lived spans started and ended at different call sites.
 *
 *   5. **Event recording**: `recordEvent` for attaching events to the
 *      root or active span without creating a new span.
 *
 * Domain-specific tracing logic (tool calls, permissions, etc.) should
 * live in **external helper functions** that compose on top of this API.
 * This follows the Open/Closed Principle: new domain concepts can be
 * traced by adding new helper modules without modifying this class.
 *
 * @example
 * ```ts
 * const tracer = new Tracer({ enabled: true, serviceName: "my-service" });
 *
 * tracer.startRootSpan("session", { "session.id": "abc" });
 *
 * const activeSpan = tracer.startActiveSpan("request.handle", {
 *   "request.path": "/api/data",
 * });
 *
 * const opSpan = tracer.startOperation("db.query", {
 *   "db.statement": "SELECT …",
 * }, "active");
 * // … do work …
 * tracer.endOperation(opSpan);
 *
 * tracer.endActiveSpan(activeSpan);
 *
 * await tracer.shutdown();
 * ```
 */
export class Tracer {
	/** Whether tracing is active. When `false`, all methods return no-op spans. */
	readonly enabled: boolean;

	/**
	 * Returns the current trace context for log correlation.
	 *
	 * When tracing is enabled, this returns the `TraceId`, `SpanId`, and
	 * optionally `ParentSpanId` of the most specific span currently in
	 * scope. Resolution order: span stack top → active span → root span.
	 *
	 * The `ParentSpanId` is derived from the internal parent tracking map
	 * (`spanParents`), which records the parent of every span at creation
	 * time. This allows log backends like Seq to reconstruct the full span
	 * hierarchy directly from log events.
	 *
	 * When tracing is disabled, returns `undefined`.
	 *
	 * @example
	 * ```ts
	 * const ctx = tracer.getTraceContext();
	 * // { TraceId: "abc…", SpanId: "def…", ParentSpanId: "012…" }
	 * if (ctx) logger.info({ ...ctx }, "Something happened");
	 * ```
	 */
	getTraceContext(): TraceContext | undefined {
		if (!this.enabled) return undefined;

		const span = this.spanStack.at(-1) ?? this.activeSpan ?? this.rootSpan;
		if (!span || span === NOOP_SPAN) return undefined;

		const ctx: SpanContext = span.spanContext();
		const parent = this.spanParents.get(span);

		const result: TraceContext = {
			TraceId: ctx.traceId,
			SpanId: ctx.spanId,
		};

		if (parent && parent !== NOOP_SPAN) {
			result.ParentSpanId = parent.spanContext().spanId;
		}

		return result;
	}

	/** The underlying OTel tracer provider (null when disabled). */
	private provider: BasicTracerProvider | null = null;

	/** The underlying OTel tracer instance (null when disabled). */
	private tracer: OtelTracer | null = null;

	/** The root span that is the parent of all other spans. */
	private rootSpan: Span | null = null;

	/** The currently active span (only one at a time). */
	private activeSpan: Span | null = null;

	/**
	 * Span context stack for fine-grained log correlation.
	 *
	 * When a span is "entered" via {@link enterSpan}, it is pushed onto
	 * this stack. {@link getTraceContext} resolves the top of the stack
	 * first, giving logs the most specific span context available.
	 *
	 * This allows tool call spans, permission spans, and init phase spans
	 * to appear in logs with their own `SpanId` instead of inheriting
	 * the coarser active/root span ID.
	 */
	private readonly spanStack: Span[] = [];

	/**
	 * Tracks the parent of every span created via this Tracer.
	 *
	 * Populated in {@link startOperation} and {@link startChildOfRoot}
	 * so that {@link getTraceContext} can derive `ParentSpanId` without
	 * relying on OTel internals (the `Span` interface does not expose
	 * the parent span ID).
	 *
	 * Uses `WeakMap` so ended spans can be garbage-collected.
	 */
	private readonly spanParents = new WeakMap<Span, Span>();

	/**
	 * Generic map of tracked long-lived spans keyed by a caller-chosen ID.
	 *
	 * Used by external helper functions to store spans that are started and
	 * ended at different call sites (e.g., tool call spans keyed by
	 * `toolCallId`, terminal spans keyed by `terminalId`).
	 *
	 * Each entry carries a `label` for descriptive error messages when the
	 * span is forcefully ended during shutdown.
	 */
	private readonly trackedSpans = new Map<
		string,
		{ span: Span; label: string }
	>();

	// ── Constructor ──────────────────────────────────────────────────────

	/**
	 * Creates a new Tracer.
	 *
	 * @param config - Tracing configuration. Pass `{ enabled: false }` to
	 *                 create a no-op tracer that has zero overhead.
	 *                 Pass `{ provider }` to inject a custom tracer provider
	 *                 (useful for testing with `InMemorySpanExporter`).
	 */
	constructor(config?: TracerConfig) {
		this.enabled = config?.enabled ?? true;

		if (this.enabled) {
			const tracerName = config?.tracerName ?? DEFAULT_TRACER_NAME;
			const tracerVersion = config?.tracerVersion ?? DEFAULT_TRACER_VERSION;

			this.provider =
				config?.provider ??
				createTracerProvider({
					...config,
					serviceName: config?.serviceName ?? DEFAULT_SERVICE_NAME,
				});
			this.tracer = this.provider.getTracer(tracerName, tracerVersion);
		}
	}

	// ── Root Span ────────────────────────────────────────────────────────

	/**
	 * Starts the root span that encompasses the entire lifetime of the
	 * traced entity. All subsequent spans are created as children of this span.
	 *
	 * @param name       - The span name (e.g. `"agent.session"`, `"pipeline.run"`).
	 * @param attributes - Optional key-value pairs attached to the span.
	 * @returns The root span.
	 */
	startRootSpan(
		name: string,
		attributes?: Record<string, SpanAttributeValue>,
	): Span {
		if (!this.tracer) return NOOP_SPAN;

		// Guard against double-call: end the previous root span with ERROR
		if (this.rootSpan && this.rootSpan !== NOOP_SPAN) {
			this.rootSpan.setStatus({
				code: SpanStatusCode.ERROR,
				message: "Root span replaced before completion",
			});
			this.rootSpan.end();
		}

		const span = this.tracer.startSpan(name, { attributes });
		this.rootSpan = span;
		return span;
	}

	/**
	 * Ends the root span with an appropriate status.
	 *
	 * @param status  - Whether the root span ended normally or with an error.
	 * @param message - Optional status message (used for errors).
	 */
	endRootSpan(status: "ok" | "error" = "ok", message?: string): void {
		if (!this.rootSpan || this.rootSpan === NOOP_SPAN) return;

		this.rootSpan.setStatus(
			status === "ok"
				? { code: SpanStatusCode.OK }
				: { code: SpanStatusCode.ERROR, message },
		);
		this.rootSpan.end();
		this.rootSpan = null;
	}

	// ── Active Span ──────────────────────────────────────────────────────

	/**
	 * Starts a span as a child of the root span and stores it as the
	 * current active span. Only one active span exists at a time.
	 *
	 * Operations started with `parent: "active"` will be parented under
	 * this span.
	 *
	 * @param name       - The span name (e.g. `"agent.prompt"`, `"pipeline.stage"`).
	 * @param attributes - Optional key-value pairs attached to the span.
	 * @returns The active span.
	 */
	startActiveSpan(
		name: string,
		attributes?: Record<string, SpanAttributeValue>,
	): Span {
		const span = this.startChildOfRoot(name, attributes);
		this.activeSpan = span;
		return span;
	}

	/**
	 * Ends the active span and clears the active span slot.
	 *
	 * @param span  - The active span to end (should match the current active span).
	 * @param error - Optional error. When provided, the span is marked ERROR.
	 */
	endActiveSpan(span: Span, error?: Error): void {
		this.endSpanWithStatus(span, error);
		this.activeSpan = null;
	}

	// ── Generic Span API ─────────────────────────────────────────────────

	/**
	 * Starts a named span with optional attributes and parent strategy.
	 *
	 * This is the generic, domain-agnostic entry point for tracing arbitrary
	 * operations. New domain concepts can be traced without adding dedicated
	 * methods to this class.
	 *
	 * @param name       - The span name (e.g. `"db.query"`, `"http.request"`).
	 * @param attributes - Optional key-value pairs attached to the span.
	 * @param parent     - Where to parent the span. Defaults to `"active"`.
	 * @returns The started span, or `NOOP_SPAN` when tracing is disabled.
	 *
	 * @example
	 * ```ts
	 * const span = tracer.startOperation("rag.pipeline", {
	 *   "rag.query": query.slice(0, 200),
	 *   "rag.collection": collectionName,
	 * }, "active");
	 * ```
	 */
	startOperation(
		name: string,
		attributes?: Record<string, SpanAttributeValue>,
		parent: ParentStrategy = "active",
	): Span {
		if (!this.tracer) return NOOP_SPAN;

		const parentSpan = this.resolveParent(parent);
		if (!parentSpan || parentSpan === NOOP_SPAN) return NOOP_SPAN;

		const parentCtx = trace.setSpan(context.active(), parentSpan);
		const span = this.tracer.startSpan(name, { attributes }, parentCtx);
		this.spanParents.set(span, parentSpan);
		return span;
	}

	/**
	 * Ends a span, setting its status based on whether an error was provided.
	 *
	 * This is the generic counterpart to `startOperation`.
	 *
	 * @param span  - The span to end.
	 * @param error - Optional error. When provided, the span is marked ERROR.
	 */
	endOperation(span: Span, error?: Error): void {
		this.endSpanWithStatus(span, error);
	}

	/**
	 * Executes an async function within a traced span, automatically ending
	 * the span on success or error.
	 *
	 * This is a convenience wrapper around `startOperation`/`endOperation`
	 * that eliminates the repetitive try/catch pattern.
	 *
	 * @param name       - The span name.
	 * @param work       - The async function to execute.
	 * @param options    - Optional configuration.
	 * @returns The result of the work function.
	 *
	 * @example
	 * ```ts
	 * const content = await tracer.traced("fs.read", async (span) => {
	 *   const data = await readFile(path, "utf-8");
	 *   span.setAttribute("fs.content_length", data.length);
	 *   return data;
	 * }, { attributes: { "fs.path": path }, parent: "active" });
	 * ```
	 */
	async traced<T>(
		name: string,
		work: (span: Span) => Promise<T>,
		options?: {
			attributes?: Record<string, SpanAttributeValue>;
			parent?: ParentStrategy;
		},
	): Promise<T> {
		const span = this.startOperation(
			name,
			options?.attributes,
			options?.parent,
		);
		this.enterSpan(span);

		try {
			const result = await work(span);
			this.endSpanWithStatus(span);
			return result;
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			this.endSpanWithStatus(span, error);
			throw err;
		} finally {
			this.leaveSpan(span);
		}
	}

	/**
	 * Executes a synchronous function within a traced span, automatically
	 * ending the span on success or error.
	 *
	 * This is the synchronous counterpart to {@link traced}. It eliminates
	 * the repetitive try/catch pattern for operations that do not need to
	 * await anything.
	 *
	 * @param name    - The span name.
	 * @param work    - The synchronous function to execute.
	 * @param options - Optional configuration.
	 * @returns The result of the work function.
	 *
	 * @example
	 * ```ts
	 * const parsed = tracer.tracedSync("json.parse", (span) => {
	 *   const obj = JSON.parse(raw);
	 *   span.setAttribute("json.keys", Object.keys(obj).length);
	 *   return obj;
	 * }, { attributes: { "json.length": raw.length }, parent: "active" });
	 * ```
	 */
	tracedSync<T>(
		name: string,
		work: (span: Span) => T,
		options?: {
			attributes?: Record<string, SpanAttributeValue>;
			parent?: ParentStrategy;
		},
	): T {
		const span = this.startOperation(
			name,
			options?.attributes,
			options?.parent,
		);
		this.enterSpan(span);
		try {
			const result = work(span);
			this.endSpanWithStatus(span);
			return result;
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			this.endSpanWithStatus(span, error);
			throw err;
		} finally {
			this.leaveSpan(span);
		}
	}

	// ── Span Tracking ────────────────────────────────────────────────────

	/**
	 * Tracks a span by ID so it can be retrieved and ended later.
	 *
	 * This is used by external helper functions for long-lived spans that
	 * are started and ended at different call sites (e.g., tool call spans
	 * started in one handler but ended when the tool completes).
	 *
	 * Non-recording spans (i.e., NOOP_SPAN when tracing is disabled) are
	 * silently ignored — they are never stored.
	 *
	 * Empty-string IDs are silently ignored to prevent accidental key
	 * collisions. If an ID already exists, the existing span is ended
	 * with ERROR before being replaced.
	 *
	 * @param id    - Unique identifier for this span (e.g., toolCallId, terminalId).
	 * @param span  - The span to track.
	 * @param label - Human-readable label for error messages during forced cleanup
	 *               (e.g., `"tool call"`, `"terminal"`). Defaults to `"operation"`.
	 */
	trackSpan(id: string, span: Span, label: string = "operation"): void {
		if (!id) return;
		if (span.isRecording()) {
			const existing = this.trackedSpans.get(id);
			if (existing?.span.isRecording()) {
				existing.span.setStatus({
					code: SpanStatusCode.ERROR,
					message: `${existing.label} replaced before completion`,
				});
				existing.span.end();
			}
			this.trackedSpans.set(id, { span, label });
		}
	}

	/**
	 * Retrieves a tracked span by its ID.
	 *
	 * Returns `undefined` if the ID is unknown, empty, or the span was
	 * never tracked (e.g., because tracing was disabled).
	 *
	 * @param id - The span's tracking ID.
	 * @returns The tracked span, or `undefined`.
	 */
	getTrackedSpan(id: string): Span | undefined {
		if (!id) return undefined;
		return this.trackedSpans.get(id)?.span;
	}

	/**
	 * Removes and returns a tracked span by its ID.
	 *
	 * This is typically called when the operation completes and the span
	 * should be ended. Returns `undefined` if the ID is unknown or empty.
	 *
	 * @param id - The span's tracking ID.
	 * @returns The removed span, or `undefined`.
	 */
	removeTrackedSpan(id: string): Span | undefined {
		if (!id) return undefined;
		const entry = this.trackedSpans.get(id);
		if (entry) {
			this.trackedSpans.delete(id);
			return entry.span;
		}
		return undefined;
	}

	// ── Event Recording ──────────────────────────────────────────────────

	/**
	 * Adds an event to the span resolved by the given parent strategy.
	 *
	 * This is used by external helper functions to record domain events
	 * (e.g., context injection, usage updates) on the appropriate span
	 * without needing access to the span reference directly.
	 *
	 * @param target     - Which span to attach the event to.
	 * @param eventName  - The event name (e.g., `"context.injected"`).
	 * @param attributes - Optional event attributes.
	 */
	recordEvent(
		target: ParentStrategy,
		eventName: string,
		attributes?: Record<string, SpanAttributeValue>,
	): void {
		const span = this.resolveParent(target);
		if (!span || span === NOOP_SPAN) return;

		span.addEvent(eventName, attributes);
	}

	// ── Span Context Stack ───────────────────────────────────────────────

	/**
	 * Pushes a span onto the context stack, making it the "current" span
	 * for log correlation via {@link getTraceContext}.
	 *
	 * Call {@link leaveSpan} when the span's scope ends (e.g., after a
	 * tool call completes or a permission is resolved). Non-recording
	 * spans (i.e., `NOOP_SPAN`) are silently ignored.
	 *
	 * Duplicate entries are prevented — entering an already-entered span
	 * is a no-op.
	 *
	 * @param span - The span to enter.
	 *
	 * @example
	 * ```ts
	 * const toolSpan = tracer.startOperation("agent.tool_call", { ... }, "active");
	 * tracer.enterSpan(toolSpan);
	 * logger.info("Tool started");   // ← log carries toolSpan's SpanId
	 * // ... work ...
	 * tracer.leaveSpan(toolSpan);
	 * tracer.endOperation(toolSpan);
	 * ```
	 */
	enterSpan(span: Span): void {
		if (span === NOOP_SPAN || !span.isRecording()) return;
		if (!this.spanStack.includes(span)) {
			this.spanStack.push(span);
		}
	}

	/**
	 * Removes a span from the context stack.
	 *
	 * Uses identity-based removal (not LIFO pop) so that out-of-order
	 * leaves are handled gracefully. If the span is not in the stack,
	 * this is a silent no-op.
	 *
	 * @param span - The span to leave.
	 */
	leaveSpan(span: Span): void {
		const idx = this.spanStack.lastIndexOf(span);
		if (idx !== -1) {
			this.spanStack.splice(idx, 1);
		}
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
		// Clear the span context stack — no more log correlation after flush
		this.spanStack.length = 0;

		let hadLingeringSpans = false;

		// End any lingering tracked spans
		for (const [id, { span, label }] of this.trackedSpans) {
			hadLingeringSpans = true;
			span.setStatus({
				code: SpanStatusCode.ERROR,
				message: `Destroyed before ${label} completed`,
			});
			span.end();
			this.trackedSpans.delete(id);
		}

		// End active span if still active
		if (this.activeSpan && this.activeSpan !== NOOP_SPAN) {
			hadLingeringSpans = true;
			this.activeSpan.setStatus({
				code: SpanStatusCode.ERROR,
				message: "Destroyed while active span was in progress",
			});
			this.activeSpan.end();
			this.activeSpan = null;
		}

		// End root span — ERROR if any children were forcefully terminated
		this.endRootSpan(
			hadLingeringSpans ? "error" : "ok",
			hadLingeringSpans ? "Session ended with lingering spans" : undefined,
		);

		// Flush pending spans to the exporter (does NOT clear the exporter).
		// Swallow export errors (e.g. OTLP endpoint unreachable / bad request)
		// so that telemetry failures never crash the application.
		if (this.provider) {
			try {
				await this.provider.forceFlush();
			} catch {
				// Telemetry export is best-effort — silently ignore failures.
			}
		}
	}

	/**
	 * Flushes all pending spans and shuts down the tracer provider.
	 *
	 * Must be called during teardown to ensure all spans are exported.
	 * After shutdown, the provider is torn down and the exporter is cleared.
	 *
	 * If you need to inspect spans after flush (e.g. in tests), call
	 * {@link flush} first, read the exporter, then call `shutdown()`.
	 */
	async shutdown(): Promise<void> {
		await this.flush();

		// Tear down the provider (also calls exporter.shutdown → clears spans).
		// Swallow export errors so that telemetry failures never crash the app.
		if (this.provider) {
			try {
				await this.provider.shutdown();
			} catch {
				// Telemetry shutdown is best-effort — silently ignore failures.
			}
			this.provider = null;
			this.tracer = null;
		}
	}

	// ── Private Helpers ──────────────────────────────────────────────────

	/**
	 * Resolves a parent strategy to an actual span reference.
	 */
	private resolveParent(parent: ParentStrategy): Span | null {
		if (typeof parent === "object") {
			// Explicit Span reference
			return parent;
		}

		switch (parent) {
			case "root":
				return this.rootSpan;
			case "active":
				return this.spanStack.at(-1) ?? this.activeSpan ?? this.rootSpan;
			default:
				return this.rootSpan;
		}
	}

	/**
	 * Starts a span as a child of the root span.
	 */
	private startChildOfRoot(
		name: string,
		attributes?: Record<string, string | number | boolean>,
	): Span {
		if (!this.tracer || !this.rootSpan || this.rootSpan === NOOP_SPAN) {
			return NOOP_SPAN;
		}

		const parentCtx = trace.setSpan(context.active(), this.rootSpan);
		const span = this.tracer.startSpan(name, { attributes }, parentCtx);
		this.spanParents.set(span, this.rootSpan);
		return span;
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
