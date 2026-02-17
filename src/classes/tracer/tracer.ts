import { AsyncLocalStorage } from "node:async_hooks";
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

	/**
	 * Optional parent span context for cross-tracer linking.
	 *
	 * When provided, the root span created by {@link Tracer.startRootSpan}
	 * will be a child of this span context. This is used to link traces
	 * across tracer boundaries — for example, linking an Agent's trace
	 * to the AgentPool's trace that spawned it.
	 *
	 * The span context is typically obtained from the parent tracer via
	 * {@link Tracer.getRootSpanContext}.
	 *
	 * @example
	 * ```ts
	 * // In the parent (e.g., AgentPool):
	 * const poolTracer = new Tracer({ serviceName: "stark-pool" });
	 * poolTracer.startRootSpan("pool.execution");
	 * const parentCtx = poolTracer.getRootSpanContext();
	 *
	 * // In the child (e.g., Agent):
	 * const agentTracer = new Tracer({
	 *   serviceName: "stark-agent",
	 *   parentSpanContext: parentCtx,
	 * });
	 * // The agent's root span will be a child of the pool's root span
	 * agentTracer.startRootSpan("agent.session");
	 * ```
	 */
	parentSpanContext?: SpanContext;
}

// ── Attribute Value Type ───────────────────────────────────────────────────

/** Values accepted by OpenTelemetry span attributes. */
export type SpanAttributeValue = string | number | boolean | string[];

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

// ── AsyncLocalStorage Context ──────────────────────────────────────────────

/** The context stored in AsyncLocalStorage for automatic span propagation. */
interface TracerStore {
	/** The current span in this async context. */
	span: Span;
}

// ── Tracer ─────────────────────────────────────────────────────────────────

/**
 * Tracing wrapper around OpenTelemetry with automatic context propagation
 * via `AsyncLocalStorage`.
 *
 * ## Core Concepts
 *
 * - **Root span**: the top-level span representing the entity's entire
 *   lifetime (e.g., an agent session, a pool lifecycle).
 *
 * - **`wrap()` / `wrapSync()`**: scoped span management. Creates a child
 *   span of the current context, runs a function within it, and auto-ends
 *   the span on success or error. Nested `wrap()` calls automatically
 *   form a parent-child hierarchy via `AsyncLocalStorage`.
 *
 * - **Tracked spans**: for long-lived spans that start and end at different
 *   call sites (e.g., tool calls, terminals). Managed via `startTracked()`
 *   / `endTracked()`. Tracked spans also participate in context resolution
 *   for log correlation.
 *
 * ## Context Resolution
 *
 * When determining the "current span" (for parenting new spans, log
 * correlation via `getContext()`, or `recordEvent()`), the resolution
 * order is:
 *
 *   1. **Tracked span stack** top (most specific active tracked span)
 *   2. **AsyncLocalStorage** current span (from `wrap()` / `wrapSync()`)
 *   3. **Root span** (fallback)
 *
 * This means:
 *   - Inside `wrap()`, nested spans are automatically children of the
 *     enclosing span.
 *   - When a tracked span is active (e.g., a tool call), operations and
 *     log lines are associated with that tool call.
 *   - Outside any `wrap()` or tracked span, everything falls back to root.
 *
 * ## Design Philosophy
 *
 * The Tracer is domain-agnostic. It provides generic primitives
 * (`wrap`, `startTracked`, `recordEvent`) that domain-specific code
 * composes. Span names are centralized in the `SpanName` enum.
 *
 * When tracing is disabled (`enabled: false`), every method returns a
 * no-op span so calling code doesn't need conditional logic.
 *
 * @example
 * ```ts
 * const tracer = new Tracer({ enabled: true, serviceName: "my-service" });
 * tracer.startRootSpan("session", { "session.id": "abc" });
 *
 * await tracer.wrap("request.handle", { "request.path": "/api" }, async (span) => {
 *   await tracer.wrap("db.query", async (innerSpan) => {
 *     // innerSpan is automatically a child of the request span
 *   });
 * });
 *
 * await tracer.shutdown();
 * ```
 */
export class Tracer {
	/** Whether tracing is active. When `false`, all methods return no-op spans. */
	readonly enabled: boolean;

	/** The underlying OTel tracer provider (null when disabled). */
	private provider: BasicTracerProvider | null = null;

	/** The underlying OTel tracer instance (null when disabled). */
	private tracer: OtelTracer | null = null;

	/**
	 * Optional parent span context for cross-tracer linking.
	 * When set, the root span will be created as a child of this context.
	 */
	private readonly parentSpanContext: SpanContext | null = null;

	/** The root span that is the parent of all other spans. */
	private rootSpan: Span | null = null;

	/**
	 * AsyncLocalStorage for automatic span context propagation.
	 *
	 * `wrap()` and `wrapSync()` use `store.run()` to set the current span,
	 * making it available to nested calls without explicit parameter passing.
	 */
	private readonly store = new AsyncLocalStorage<TracerStore>();

	/**
	 * Tracks the parent of every span created via this Tracer.
	 *
	 * Populated in `wrap()`, `wrapSync()`, `startTracked()`, and
	 * `startRootSpan()` so that `getContext()` can derive `ParentSpanId`
	 * without relying on OTel internals (the `Span` interface does not
	 * expose the parent span ID).
	 *
	 * Uses `WeakMap` so ended spans can be garbage-collected.
	 */
	private readonly spanParents = new WeakMap<Span, Span>();

	/**
	 * Registry of tracked long-lived spans keyed by a caller-chosen ID.
	 *
	 * Used for spans that are started and ended at different call sites
	 * (e.g., tool call spans keyed by `toolCallId`, terminal spans keyed
	 * by `terminalId`).
	 *
	 * Each entry carries a `label` for descriptive error messages when the
	 * span is forcefully ended during shutdown.
	 */
	private readonly trackedSpans = new Map<
		string,
		{ span: Span; label: string }
	>();

	/**
	 * Stack of activated tracked spans for context resolution.
	 *
	 * When a tracked span is started via `startTracked()`, it is pushed
	 * onto this stack. `getContext()` and `resolveParent()` check this
	 * stack first, giving logs and child spans the most specific context.
	 *
	 * Spans are removed via `endTracked()` or `deactivateTracked()`.
	 */
	private readonly trackedSpanStack: Span[] = [];

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
			this.parentSpanContext = config?.parentSpanContext ?? null;
		}
	}

	// ── Root Span ────────────────────────────────────────────────────────

	/**
	 * Starts the root span that encompasses the entire lifetime of the
	 * traced entity. All subsequent spans are created as children of this
	 * span (directly or transitively via `wrap()` nesting).
	 *
	 * @param name       - The span name (e.g. `SpanName.AGENT_SESSION`).
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

		// If a parent span context was provided, create the root span as a
		// child of that context. This links the entire trace tree of this
		// Tracer instance under the parent (e.g., AgentPool → Agent).
		let span: Span;
		if (this.parentSpanContext) {
			const remoteParent = trace.wrapSpanContext(this.parentSpanContext);
			const parentCtx = trace.setSpan(context.active(), remoteParent);
			span = this.tracer.startSpan(name, { attributes }, parentCtx);
			this.spanParents.set(span, remoteParent);
		} else {
			span = this.tracer.startSpan(name, { attributes });
		}

		this.rootSpan = span;
		return span;
	}

	/**
	 * Returns the `SpanContext` of the current root span, or `undefined`
	 * if tracing is disabled or no root span has been started.
	 *
	 * This is used to pass the root span's context to child Tracer
	 * instances (e.g., from AgentPool to Agent) so that their root spans
	 * become children of this span, creating a unified trace hierarchy.
	 */
	getRootSpanContext(): SpanContext | undefined {
		if (!this.enabled || !this.rootSpan || this.rootSpan === NOOP_SPAN) {
			return undefined;
		}
		return this.rootSpan.spanContext();
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

	// ── Scoped Span API (wrap / wrapSync) ────────────────────────────────

	/**
	 * Executes an async function within a traced span, automatically
	 * managing the span lifecycle.
	 *
	 * The span is:
	 *   1. Created as a child of the current context (tracked stack → ALS → root)
	 *   2. Set as the current span in `AsyncLocalStorage` for the duration
	 *   3. Ended with OK on success, or ERROR on exception
	 *
	 * Any nested `wrap()` calls automatically become children of this span.
	 *
	 * @param name - The span name (use `SpanName` enum values).
	 * @param fnOrAttrs - Either the work function, or attributes for the span.
	 * @param maybeFn - The work function (when attributes are provided).
	 * @returns The result of the work function.
	 *
	 * @example
	 * ```ts
	 * // Without attributes
	 * await tracer.wrap("db.query", async (span) => {
	 *   const rows = await db.query(sql);
	 *   span.setAttribute("db.row_count", rows.length);
	 *   return rows;
	 * });
	 *
	 * // With attributes
	 * await tracer.wrap("http.request", { "http.url": url }, async (span) => {
	 *   return await fetch(url);
	 * });
	 * ```
	 */
	async wrap<T>(
		name: string,
		fnOrAttrs:
			| ((span: Span) => Promise<T>)
			| Record<string, SpanAttributeValue>,
		maybeFn?: (span: Span) => Promise<T>,
	): Promise<T> {
		const { attrs, fn } = this.resolveWrapArgs(fnOrAttrs, maybeFn);

		if (!this.tracer) return fn(NOOP_SPAN);

		const parent = this.resolveParent();
		if (!parent || parent === NOOP_SPAN) return fn(NOOP_SPAN);

		const parentCtx = trace.setSpan(context.active(), parent);
		const span = this.tracer.startSpan(name, { attributes: attrs }, parentCtx);
		this.spanParents.set(span, parent);

		return this.store.run({ span }, async () => {
			try {
				const result = await fn(span);
				this.endSpanWithStatus(span);
				return result;
			} catch (err) {
				const error = err instanceof Error ? err : new Error(String(err));
				this.endSpanWithStatus(span, error);
				throw err;
			}
		});
	}

	/**
	 * Executes a synchronous function within a traced span, automatically
	 * managing the span lifecycle.
	 *
	 * This is the synchronous counterpart to {@link wrap}.
	 *
	 * @param name - The span name (use `SpanName` enum values).
	 * @param fnOrAttrs - Either the work function, or attributes for the span.
	 * @param maybeFn - The work function (when attributes are provided).
	 * @returns The result of the work function.
	 *
	 * @example
	 * ```ts
	 * const parsed = tracer.wrapSync("json.parse", (span) => {
	 *   const obj = JSON.parse(raw);
	 *   span.setAttribute("json.keys", Object.keys(obj).length);
	 *   return obj;
	 * });
	 * ```
	 */
	wrapSync<T>(
		name: string,
		fnOrAttrs: ((span: Span) => T) | Record<string, SpanAttributeValue>,
		maybeFn?: (span: Span) => T,
	): T {
		const { attrs, fn } = this.resolveWrapArgs(fnOrAttrs, maybeFn);

		if (!this.tracer) return fn(NOOP_SPAN);

		const parent = this.resolveParent();
		if (!parent || parent === NOOP_SPAN) return fn(NOOP_SPAN);

		const parentCtx = trace.setSpan(context.active(), parent);
		const span = this.tracer.startSpan(name, { attributes: attrs }, parentCtx);
		this.spanParents.set(span, parent);

		return this.store.run({ span }, () => {
			try {
				const result = fn(span);
				this.endSpanWithStatus(span);
				return result;
			} catch (err) {
				const error = err instanceof Error ? err : new Error(String(err));
				this.endSpanWithStatus(span, error);
				throw err;
			}
		});
	}

	// ── Tracked Span API ─────────────────────────────────────────────────

	/**
	 * Starts a tracked span and activates it for context resolution.
	 *
	 * Tracked spans are for long-lived operations that start and end at
	 * different call sites (e.g., tool calls, terminal sessions). The span
	 * is:
	 *   1. Created as a child of the current context
	 *   2. Stored in the tracked registry by `id`
	 *   3. Pushed onto the tracked span stack (active for context resolution)
	 *
	 * Use {@link endTracked} to end the span and remove it from the registry.
	 * Use {@link deactivateTracked} / {@link activateTracked} to control
	 * context activation without ending the span.
	 *
	 * Non-recording spans (NOOP_SPAN when tracing is disabled) are silently
	 * ignored — they are never stored.
	 *
	 * @param id    - Unique identifier (e.g., toolCallId, terminalId).
	 * @param name  - The span name (use `SpanName` enum values).
	 * @param attributes - Optional span attributes.
	 * @param label - Human-readable label for error messages during forced
	 *               cleanup (e.g., `"tool call"`, `"terminal"`).
	 * @returns The started span, or `NOOP_SPAN` when tracing is disabled.
	 */
	startTracked(
		id: string,
		name: string,
		attributes?: Record<string, SpanAttributeValue>,
		label: string = "operation",
	): Span {
		if (!id || !this.tracer) return NOOP_SPAN;

		const parent = this.resolveParent();
		if (!parent || parent === NOOP_SPAN) return NOOP_SPAN;

		const parentCtx = trace.setSpan(context.active(), parent);
		const span = this.tracer.startSpan(name, { attributes }, parentCtx);
		this.spanParents.set(span, parent);

		// End existing span with same ID if any
		const existing = this.trackedSpans.get(id);
		if (existing?.span.isRecording()) {
			existing.span.setStatus({
				code: SpanStatusCode.ERROR,
				message: `${existing.label} replaced before completion`,
			});
			existing.span.end();
			// Remove from stack
			const idx = this.trackedSpanStack.lastIndexOf(existing.span);
			if (idx !== -1) this.trackedSpanStack.splice(idx, 1);
		}

		// Store and activate
		this.trackedSpans.set(id, { span, label });
		this.trackedSpanStack.push(span);

		return span;
	}

	/**
	 * Retrieves a tracked span by its ID without removing it.
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
	 * Ends a tracked span, removes it from the registry and the context
	 * stack, and sets its status based on whether an error was provided.
	 *
	 * @param id    - The span's tracking ID.
	 * @param error - Optional error. When provided, the span is marked ERROR.
	 * @returns The ended span, or `undefined` if the ID was unknown.
	 */
	endTracked(id: string, error?: Error): Span | undefined {
		if (!id) return undefined;

		const entry = this.trackedSpans.get(id);
		if (!entry) return undefined;

		this.trackedSpans.delete(id);

		// Remove from context stack
		const idx = this.trackedSpanStack.lastIndexOf(entry.span);
		if (idx !== -1) this.trackedSpanStack.splice(idx, 1);

		// End with status
		this.endSpanWithStatus(entry.span, error);

		return entry.span;
	}

	/**
	 * Removes a tracked span from the context stack without ending it.
	 *
	 * The span remains in the tracked registry and can be re-activated
	 * later via {@link activateTracked}. This is used for spans that
	 * should not continuously affect context resolution (e.g., terminal
	 * spans that run in the background).
	 *
	 * @param id - The span's tracking ID.
	 */
	deactivateTracked(id: string): void {
		if (!id) return;
		const entry = this.trackedSpans.get(id);
		if (!entry) return;

		const idx = this.trackedSpanStack.lastIndexOf(entry.span);
		if (idx !== -1) this.trackedSpanStack.splice(idx, 1);
	}

	/**
	 * Pushes a tracked span back onto the context stack.
	 *
	 * This re-activates a span that was previously deactivated via
	 * {@link deactivateTracked}, making it the current span for context
	 * resolution.
	 *
	 * @param id - The span's tracking ID.
	 */
	activateTracked(id: string): void {
		if (!id) return;
		const entry = this.trackedSpans.get(id);
		if (!entry || !entry.span.isRecording()) return;

		if (!this.trackedSpanStack.includes(entry.span)) {
			this.trackedSpanStack.push(entry.span);
		}
	}

	// ── Context ──────────────────────────────────────────────────────────

	/**
	 * Returns the current trace context for log correlation.
	 *
	 * Resolution order: tracked span stack → ALS span → root span.
	 *
	 * When tracing is disabled, returns `undefined`.
	 *
	 * @example
	 * ```ts
	 * const ctx = tracer.getContext();
	 * // { TraceId: "abc…", SpanId: "def…", ParentSpanId: "012…" }
	 * if (ctx) logger.info({ ...ctx }, "Something happened");
	 * ```
	 */
	getContext(): TraceContext | undefined {
		if (!this.enabled) return undefined;

		const span = this.resolveParent();
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

	/**
	 * Returns the current span from context resolution, or `undefined`.
	 *
	 * Useful when you need to set attributes on the current span without
	 * creating a new child span.
	 */
	currentSpan(): Span | undefined {
		const span = this.resolveParent();
		if (!span || span === NOOP_SPAN) return undefined;
		return span;
	}

	// ── Event Recording ──────────────────────────────────────────────────

	/**
	 * Adds an event to the current span (tracked stack → ALS → root).
	 *
	 * @param eventName  - The event name (e.g., `"context.injected"`).
	 * @param attributes - Optional event attributes.
	 */
	recordEvent(
		eventName: string,
		attributes?: Record<string, SpanAttributeValue>,
	): void {
		const span = this.resolveParent();
		if (!span || span === NOOP_SPAN) return;
		span.addEvent(eventName, attributes);
	}

	/**
	 * Adds an event to the root span specifically.
	 *
	 * Use this when you want to record an event on the root span regardless
	 * of the current context (e.g., pool-level events).
	 *
	 * @param eventName  - The event name.
	 * @param attributes - Optional event attributes.
	 */
	recordRootEvent(
		eventName: string,
		attributes?: Record<string, SpanAttributeValue>,
	): void {
		if (!this.rootSpan || this.rootSpan === NOOP_SPAN) return;
		this.rootSpan.addEvent(eventName, attributes);
	}

	// ── Flush & Shutdown ─────────────────────────────────────────────────

	/**
	 * Forces the provider to export all pending spans **without** ending
	 * any active spans or clearing any state.
	 *
	 * Use this when you need to ensure that all spans completed so far
	 * have been delivered to the backend but the tracer is still in use.
	 *
	 * Export errors are swallowed — telemetry is best-effort.
	 */
	async forceExport(): Promise<void> {
		if (this.provider) {
			try {
				await this.provider.forceFlush();
			} catch {
				// Telemetry export is best-effort — silently ignore failures.
			}
		}
	}

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
		// Clear the tracked span stack
		this.trackedSpanStack.length = 0;

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

		// End root span — ERROR if any children were forcefully terminated
		this.endRootSpan(
			hadLingeringSpans ? "error" : "ok",
			hadLingeringSpans ? "Session ended with lingering spans" : undefined,
		);

		// Flush pending spans to the exporter
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
	 * Resolves the current parent span from context.
	 *
	 * Priority: tracked span stack → ALS span → root span.
	 */
	private resolveParent(): Span | null {
		return (
			this.trackedSpanStack.at(-1) ??
			this.store.getStore()?.span ??
			this.rootSpan
		);
	}

	/**
	 * Resolves overloaded arguments for `wrap()` / `wrapSync()`.
	 *
	 * Supports two signatures:
	 *   - `wrap(name, fn)` — no attributes
	 *   - `wrap(name, attrs, fn)` — with attributes
	 */
	private resolveWrapArgs<T>(
		fnOrAttrs: ((span: Span) => T) | Record<string, SpanAttributeValue>,
		maybeFn?: (span: Span) => T,
	): {
		attrs: Record<string, SpanAttributeValue> | undefined;
		fn: (span: Span) => T;
	} {
		if (typeof fnOrAttrs === "function") {
			return { attrs: undefined, fn: fnOrAttrs };
		}
		if (!maybeFn) {
			throw new Error(
				"A function argument is required when passing attributes",
			);
		}
		return { attrs: fnOrAttrs, fn: maybeFn };
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
