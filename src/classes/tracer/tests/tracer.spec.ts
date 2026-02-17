import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SpanStatusCode } from "@opentelemetry/api";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Tracer } from "../tracer.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Creates an InMemorySpanExporter + BasicTracerProvider for test inspection. */
function createTestProvider(): {
	exporter: InMemorySpanExporter;
	provider: BasicTracerProvider;
} {
	const exporter = new InMemorySpanExporter();
	const provider = new BasicTracerProvider({
		spanProcessors: [new SimpleSpanProcessor(exporter)],
	});
	return { exporter, provider };
}

/** Creates a Tracer wired to an in-memory exporter for assertions. */
function createTestTracer(): {
	tracer: Tracer;
	exporter: InMemorySpanExporter;
	provider: BasicTracerProvider;
} {
	const { exporter, provider } = createTestProvider();
	const tracer = new Tracer({
		enabled: true,
		provider,
	});
	return { tracer, exporter, provider };
}

/** Finds a span by name from the exporter's finished spans. */
function findSpan(
	exporter: InMemorySpanExporter,
	name: string,
): ReadableSpan | undefined {
	return exporter.getFinishedSpans().find((s) => s.name === name);
}

/** Returns the attribute value from a span, or undefined. */
function attr(span: ReadableSpan, key: string): unknown {
	return span.attributes[key];
}

/**
 * Extracts the parent span ID from a ReadableSpan.
 * In sdk-trace-base v2.x, parentSpanId was replaced by parentSpanContext.
 */
function parentSpanId(span: ReadableSpan): string | undefined {
	// v2.x: parentSpanContext is a SpanContext object
	const parentCtx = (span as any).parentSpanContext;
	if (parentCtx && typeof parentCtx.spanId === "string") {
		return parentCtx.spanId;
	}
	// v1.x fallback
	return (span as any).parentSpanId;
}

/**
 * Ends all live spans on a tracer, flushes them to the exporter, then
 * snapshots the finished spans BEFORE shutdown clears the exporter.
 *
 * `tracer.flush()` ends lingering spans and calls `provider.forceFlush()`.
 * `tracer.shutdown()` then calls `provider.shutdown()` which clears the
 * exporter, so we must snapshot between the two.
 */
async function shutdownAndCollect(
	tracer: Tracer,
	exporter: InMemorySpanExporter,
	_provider?: BasicTracerProvider,
): Promise<ReadableSpan[]> {
	// flush() ends lingering spans + calls forceFlush — exporter still has data
	await tracer.flush();
	// Snapshot before shutdown() clears the exporter
	const spans = [...exporter.getFinishedSpans()];
	// Now tear down — this clears the exporter but we already have our copy
	await tracer.shutdown();
	return spans;
}

// ── Tracer (disabled) ──────────────────────────────────────────────────────

describe("Tracer (disabled)", () => {
	it("creates a no-op tracer when enabled is false", () => {
		const tracer = new Tracer({ enabled: false });
		expect(tracer.enabled).toBe(false);
	});

	it("defaults to enabled when no config is provided", () => {
		const { provider } = createTestProvider();
		const tracer = new Tracer({ provider });
		expect(tracer.enabled).toBe(true);
		provider.shutdown();
	});

	it("startRootSpan returns a span that does not record", () => {
		const tracer = new Tracer({ enabled: false });
		const span = tracer.startRootSpan("test.root");
		expect(span.isRecording()).toBe(false);
	});

	it("all span methods return non-throwing no-ops when disabled", async () => {
		const tracer = new Tracer({ enabled: false });

		// None of these should throw
		const _root = tracer.startRootSpan("test.root");

		// wrap / wrapSync with disabled tracer should still execute the fn
		const wrapResult = await tracer.wrap("test.wrap", async (span) => {
			expect(span.isRecording()).toBe(false);
			return "wrap-ok";
		});
		expect(wrapResult).toBe("wrap-ok");

		const syncResult = tracer.wrapSync("test.wrapSync", (span) => {
			expect(span.isRecording()).toBe(false);
			return "sync-ok";
		});
		expect(syncResult).toBe("sync-ok");

		// startTracked with disabled tracer returns NOOP
		const tracked = tracer.startTracked("tc-1", "agent.tool_call", {
			"tool.call_id": "tc-1",
			"tool.title": "Test tool",
		});
		expect(tracked.isRecording()).toBe(false);
		expect(tracer.getTrackedSpan("tc-1")).toBeUndefined();

		// endTracked returns undefined for NOOP
		expect(tracer.endTracked("tc-1")).toBeUndefined();

		// deactivateTracked / activateTracked should not throw
		tracer.deactivateTracked("tc-1");
		tracer.activateTracked("tc-1");

		// getContext returns undefined when disabled
		expect(tracer.getContext()).toBeUndefined();

		// recordEvent / recordRootEvent should not throw
		tracer.recordEvent("test.event", { foo: "bar" });
		tracer.recordRootEvent("test.event", { foo: "bar" });

		tracer.endRootSpan("ok");
	});

	it("shutdown resolves without error when disabled", async () => {
		const tracer = new Tracer({ enabled: false });
		tracer.startRootSpan("test.root");
		await expect(tracer.shutdown()).resolves.toBeUndefined();
	});
});

// ── Root Span ──────────────────────────────────────────────────────────────

describe("Tracer — Root Span", () => {
	let tracer: Tracer;
	let exporter: InMemorySpanExporter;
	let provider: BasicTracerProvider;

	beforeEach(() => {
		({ tracer, exporter, provider } = createTestTracer());
	});

	afterEach(async () => {
		tracer.endRootSpan("ok");
		await provider.shutdown();
	});

	it("startRootSpan creates a root span with the given name", () => {
		tracer.startRootSpan("test.session");
		tracer.endRootSpan("ok");

		const span = findSpan(exporter, "test.session");
		expect(span).toBeDefined();
	});

	it("root span carries custom attributes", () => {
		tracer.startRootSpan("test.session", {
			"entity.id": "abc",
			"entity.name": "Test",
		});
		tracer.endRootSpan("ok");

		const span = findSpan(exporter, "test.session")!;
		expect(attr(span, "entity.id")).toBe("abc");
		expect(attr(span, "entity.name")).toBe("Test");
	});

	it("endRootSpan with 'ok' sets status OK", () => {
		tracer.startRootSpan("test.session");
		tracer.endRootSpan("ok");

		const span = findSpan(exporter, "test.session")!;
		expect(span.status.code).toBe(SpanStatusCode.OK);
	});

	it("endRootSpan with 'error' sets status ERROR with message", () => {
		tracer.startRootSpan("test.session");
		tracer.endRootSpan("error", "something went wrong");

		const span = findSpan(exporter, "test.session")!;
		expect(span.status.code).toBe(SpanStatusCode.ERROR);
		expect(span.status.message).toBe("something went wrong");
	});

	it("endRootSpan is safe to call multiple times", () => {
		tracer.startRootSpan("test.session");
		tracer.endRootSpan("ok");
		tracer.endRootSpan("ok"); // should not throw
		tracer.endRootSpan("error"); // should not throw

		const spans = exporter
			.getFinishedSpans()
			.filter((s) => s.name === "test.session");
		expect(spans).toHaveLength(1);
	});

	it("endRootSpan is a no-op when root span was never started", () => {
		// Should not throw
		tracer.endRootSpan("ok");
		tracer.endRootSpan("error", "msg");

		const spans = exporter.getFinishedSpans();
		expect(spans).toHaveLength(0);
	});

	it("startRootSpan ends the previous root span when called twice", async () => {
		tracer.startRootSpan("session.first", {
			"session.id": "s1",
		});
		tracer.startRootSpan("session.second", {
			"session.id": "s2",
		});
		tracer.endRootSpan("ok");

		const spans = exporter.getFinishedSpans();
		const firstSpan = spans.find((s) => s.name === "session.first");
		const secondSpan = spans.find((s) => s.name === "session.second");

		expect(firstSpan).toBeDefined();
		expect(firstSpan!.status.code).toBe(SpanStatusCode.ERROR);
		expect(secondSpan).toBeDefined();
		expect(secondSpan!.status.code).toBe(SpanStatusCode.OK);
	});
});

// ── Scoped Spans (wrap / wrapSync) ─────────────────────────────────────────

describe("Tracer — Scoped Spans (wrap / wrapSync)", () => {
	let tracer: Tracer;
	let exporter: InMemorySpanExporter;
	let provider: BasicTracerProvider;

	beforeEach(() => {
		({ tracer, exporter, provider } = createTestTracer());
		tracer.startRootSpan("test.session");
	});

	afterEach(async () => {
		tracer.endRootSpan("ok");
		await provider.shutdown();
	});

	it("wrap() creates a span with the given name", async () => {
		await tracer.wrap("test.operation", async (_span) => {});

		const found = findSpan(exporter, "test.operation");
		expect(found).toBeDefined();
	});

	it("wrap() carries custom attributes", async () => {
		await tracer.wrap(
			"test.operation",
			{
				"prompt.index": 1,
				"prompt.text": "hello world",
				"prompt.text_length": 11,
			},
			async (_span) => {},
		);

		const found = findSpan(exporter, "test.operation")!;
		expect(attr(found, "prompt.index")).toBe(1);
		expect(attr(found, "prompt.text")).toBe("hello world");
		expect(attr(found, "prompt.text_length")).toBe(11);
	});

	it("wrap() sets OK status on success", async () => {
		await tracer.wrap("test.operation", async (_span) => "result");

		const found = findSpan(exporter, "test.operation")!;
		expect(found.status.code).toBe(SpanStatusCode.OK);
	});

	it("wrap() sets ERROR status and re-throws on failure", async () => {
		const work = tracer.wrap("failing.op", async (_span) => {
			throw new Error("something broke");
		});

		await expect(work).rejects.toThrow("something broke");

		const found = findSpan(exporter, "failing.op")!;
		expect(found.status.code).toBe(SpanStatusCode.ERROR);
		expect(found.status.message).toBe("something broke");
	});

	it("wrap() returns the callback's return value", async () => {
		const result = await tracer.wrap("fs.read", async (span) => {
			span.setAttribute("fs.path", "/test.txt");
			return "file content";
		});

		expect(result).toBe("file content");
	});

	it("wrap() span shares the same traceId as the root span", async () => {
		await tracer.wrap("test.operation", async (_span) => {});
		tracer.endRootSpan("ok");

		const rootSpan = findSpan(exporter, "test.session")!;
		const childSpan = findSpan(exporter, "test.operation")!;
		expect(childSpan.spanContext().traceId).toBe(
			rootSpan.spanContext().traceId,
		);
	});

	it("wrap() span is a child of the root span", async () => {
		await tracer.wrap("test.operation", async (_span) => {});
		tracer.endRootSpan("ok");

		const rootSpan = findSpan(exporter, "test.session")!;
		const childSpan = findSpan(exporter, "test.operation")!;
		const parent = parentSpanId(childSpan);
		expect(parent).toBe(rootSpan.spanContext().spanId);
	});

	it("nested wrap() calls form correct parent-child hierarchy", async () => {
		await tracer.wrap("outer.op", async (_outerSpan) => {
			await tracer.wrap("inner.op", async (_innerSpan) => {});
		});

		const outerSpan = findSpan(exporter, "outer.op")!;
		const innerSpan = findSpan(exporter, "inner.op")!;
		expect(parentSpanId(innerSpan)).toBe(outerSpan.spanContext().spanId);
	});

	it("wrapSync() creates and auto-closes a span on success", () => {
		const result = tracer.wrapSync(
			"json.parse",
			{ "json.length": 20 },
			(span) => {
				span.setAttribute("json.keys", 3);
				return { a: 1, b: 2, c: 3 };
			},
		);

		expect(result).toEqual({ a: 1, b: 2, c: 3 });

		const found = findSpan(exporter, "json.parse")!;
		expect(found).toBeDefined();
		expect(found.status.code).toBe(SpanStatusCode.OK);
		expect(attr(found, "json.length")).toBe(20);
		expect(attr(found, "json.keys")).toBe(3);
	});

	it("wrapSync() sets ERROR status and re-throws on failure", () => {
		expect(() =>
			tracer.wrapSync("json.parse.fail", { "json.length": 5 }, (_span) => {
				throw new Error("Unexpected token");
			}),
		).toThrow("Unexpected token");

		const found = findSpan(exporter, "json.parse.fail")!;
		expect(found).toBeDefined();
		expect(found.status.code).toBe(SpanStatusCode.ERROR);
		expect(found.status.message).toBe("Unexpected token");
	});

	it("wrapSync() span is a child of the root span", () => {
		tracer.wrapSync("sync.child", (_span) => "ok");
		tracer.endRootSpan("ok");

		const rootSpan = findSpan(exporter, "test.session")!;
		const childSpan = findSpan(exporter, "sync.child")!;
		const parent = parentSpanId(childSpan);
		expect(parent).toBe(rootSpan.spanContext().spanId);
	});

	it("nested wrapSync() calls form correct parent-child hierarchy", () => {
		tracer.wrapSync("outer.sync", (_outerSpan) => {
			tracer.wrapSync("inner.sync", (_innerSpan) => {});
		});

		const outerSpan = findSpan(exporter, "outer.sync")!;
		const innerSpan = findSpan(exporter, "inner.sync")!;
		expect(parentSpanId(innerSpan)).toBe(outerSpan.spanContext().spanId);
	});

	it("supports multiple sequential wrap() calls as siblings", async () => {
		await tracer.wrap("op.1", async () => {});
		await tracer.wrap("op.2", async () => {});

		tracer.endRootSpan("ok");
		const rootSpan = findSpan(exporter, "test.session")!;
		const op1 = findSpan(exporter, "op.1")!;
		const op2 = findSpan(exporter, "op.2")!;

		// Both should be children of root, not chained
		expect(parentSpanId(op1)).toBe(rootSpan.spanContext().spanId);
		expect(parentSpanId(op2)).toBe(rootSpan.spanContext().spanId);
	});

	it("error in one wrap() does not affect the next", async () => {
		try {
			await tracer.wrap("active.1", async () => {
				throw new Error("failed");
			});
		} catch {
			// expected
		}

		await tracer.wrap("active.2", async () => "ok");

		const first = findSpan(exporter, "active.1")!;
		const second = findSpan(exporter, "active.2")!;
		expect(first.status.code).toBe(SpanStatusCode.ERROR);
		expect(second.status.code).toBe(SpanStatusCode.OK);
	});

	it("wrap() with attributes creates a span with the given attributes", async () => {
		await tracer.wrap(
			"custom.op",
			{
				"custom.key": "value",
				"custom.num": 42,
			},
			async (_span) => {},
		);

		const found = findSpan(exporter, "custom.op")!;
		expect(found).toBeDefined();
		expect(attr(found, "custom.key")).toBe("value");
		expect(attr(found, "custom.num")).toBe(42);
	});

	it("wrap() allows setting attributes inside the callback", async () => {
		await tracer.wrap("fs.read", { "fs.operation": "read" }, async (span) => {
			span.setAttribute("fs.path", "/test.txt");
		});

		const found = findSpan(exporter, "fs.read")!;
		expect(attr(found, "fs.operation")).toBe("read");
		expect(attr(found, "fs.path")).toBe("/test.txt");
	});
});

// ── Span Tracking (startTracked / endTracked) ─────────────────────────────

describe("Tracer — Span Tracking", () => {
	let tracer: Tracer;
	let exporter: InMemorySpanExporter;
	let provider: BasicTracerProvider;

	beforeEach(() => {
		({ tracer, exporter, provider } = createTestTracer());
		tracer.startRootSpan("test.session");
	});

	afterEach(async () => {
		tracer.endRootSpan("ok");
		await provider.shutdown();
	});

	it("startTracked creates a span and getTrackedSpan retrieves it", () => {
		const span = tracer.startTracked("my-id", "test.op", {}, "test");

		expect(span.isRecording()).toBe(true);
		const retrieved = tracer.getTrackedSpan("my-id");
		expect(retrieved).toBe(span);

		tracer.endTracked("my-id");
	});

	it("endTracked removes and returns the span", () => {
		tracer.startTracked("my-id", "test.op", {}, "test");

		const removed = tracer.endTracked("my-id");
		expect(removed).toBeDefined();
		expect(tracer.getTrackedSpan("my-id")).toBeUndefined();
	});

	it("endTracked returns undefined for unknown IDs", () => {
		expect(tracer.endTracked("nonexistent")).toBeUndefined();
	});

	it("getTrackedSpan returns undefined for unknown IDs", () => {
		expect(tracer.getTrackedSpan("nonexistent")).toBeUndefined();
	});

	it("startTracked silently ignores non-recording spans", () => {
		const disabledTracer = new Tracer({ enabled: false });
		disabledTracer.startRootSpan("test.root");
		const span = disabledTracer.startTracked("x", "test.op");
		expect(span.isRecording()).toBe(false);
		expect(disabledTracer.getTrackedSpan("x")).toBeUndefined();
	});

	it("startTracked silently ignores empty string IDs", () => {
		const span = tracer.startTracked("", "test.op");
		expect(span.isRecording()).toBe(false);
		expect(tracer.getTrackedSpan("")).toBeUndefined();
	});

	it("getTrackedSpan returns undefined for empty string ID", () => {
		expect(tracer.getTrackedSpan("")).toBeUndefined();
	});

	it("endTracked returns undefined for empty string ID", () => {
		expect(tracer.endTracked("")).toBeUndefined();
	});

	it("startTracked with duplicate ID ends previous span with ERROR", () => {
		tracer.startTracked("dup-id", "first.op", {}, "first operation");
		const span2 = tracer.startTracked(
			"dup-id",
			"second.op",
			{},
			"second operation",
		);

		// The retrieved span should be the second one
		expect(tracer.getTrackedSpan("dup-id")).toBe(span2);

		// End span2 properly
		const removed = tracer.endTracked("dup-id");
		expect(removed).toBe(span2);

		// First span should have been ended with ERROR
		const firstSpan = findSpan(exporter, "first.op")!;
		expect(firstSpan).toBeDefined();
		expect(firstSpan.status.code).toBe(SpanStatusCode.ERROR);
		expect(firstSpan.status.message).toBe(
			"first operation replaced before completion",
		);
	});

	it("endTracked with error sets ERROR status", () => {
		tracer.startTracked("my-id", "test.op", {}, "test");

		tracer.endTracked("my-id", new Error("tool failed"));

		const found = findSpan(exporter, "test.op")!;
		expect(found.status.code).toBe(SpanStatusCode.ERROR);
		expect(found.status.message).toBe("tool failed");
	});

	it("endTracked without error sets OK status", () => {
		tracer.startTracked("my-id", "test.op", {}, "test");

		tracer.endTracked("my-id");

		const found = findSpan(exporter, "test.op")!;
		expect(found.status.code).toBe(SpanStatusCode.OK);
	});

	it("deactivateTracked removes span from context stack without ending it", () => {
		const span = tracer.startTracked("my-id", "test.op", {}, "test");

		// deactivateTracked should not end the span
		tracer.deactivateTracked("my-id");
		expect(span.isRecording()).toBe(true);
		expect(tracer.getTrackedSpan("my-id")).toBe(span);

		// After deactivation, getContext should fall back to root
		const ctx = tracer.getContext();
		expect(ctx).toBeDefined();
		const rootCtx = tracer.getRootSpanContext();
		expect(ctx!.SpanId).toBe(rootCtx!.spanId);

		tracer.endTracked("my-id");
	});

	it("activateTracked re-activates a deactivated span", () => {
		const span = tracer.startTracked("my-id", "test.op", {}, "test");

		tracer.deactivateTracked("my-id");

		// After deactivation, context falls back to root
		const rootCtx = tracer.getRootSpanContext();
		expect(tracer.getContext()!.SpanId).toBe(rootCtx!.spanId);

		// Re-activate
		tracer.activateTracked("my-id");

		// Now context should point to the tracked span again
		expect(tracer.getContext()!.SpanId).toBe(span.spanContext().spanId);

		tracer.endTracked("my-id");
	});

	it("tracked span is a child of the current context", async () => {
		await tracer.wrap("parent.op", async (_parentSpan) => {
			const _toolSpan = tracer.startTracked(
				"tc-1",
				"agent.tool_call",
				{ "tool.call_id": "tc-1" },
				"tool call",
			);

			tracer.endTracked("tc-1");

			// Verify parenting after both are exported
			const toolFound = findSpan(exporter, "agent.tool_call")!;
			const _parentFound = findSpan(exporter, "parent.op");
			// parent.op hasn't ended yet (we're still inside wrap), so check the other way
			expect(parentSpanId(toolFound)).toBe(_parentSpan.spanContext().spanId);
		});
	});
});

// ── Event Recording ────────────────────────────────────────────────────────

describe("Tracer — Event Recording", () => {
	let tracer: Tracer;
	let exporter: InMemorySpanExporter;
	let provider: BasicTracerProvider;

	beforeEach(() => {
		({ tracer, exporter, provider } = createTestTracer());
		tracer.startRootSpan("test.session");
	});

	afterEach(async () => {
		tracer.endRootSpan("ok");
		await provider.shutdown();
	});

	it("recordRootEvent adds an event to the root span", () => {
		tracer.recordRootEvent("test.event", { key: "value" });
		tracer.endRootSpan("ok");

		const session = findSpan(exporter, "test.session")!;
		const event = session.events.find((e) => e.name === "test.event");
		expect(event).toBeDefined();
		expect(event!.attributes!.key).toBe("value");
	});

	it("recordEvent targets the current span (root when no wrap)", () => {
		tracer.recordEvent("some.event", { x: 1 });
		tracer.endRootSpan("ok");

		const session = findSpan(exporter, "test.session")!;
		const event = session.events.find((e) => e.name === "some.event");
		expect(event).toBeDefined();
	});

	it("recordEvent targets the wrap span inside a wrap() callback", async () => {
		await tracer.wrap("test.prompt", async (_span) => {
			tracer.recordEvent("usage.update", { "usage.percent": 50 });
		});

		const promptSpan = findSpan(exporter, "test.prompt")!;
		const event = promptSpan.events.find((e) => e.name === "usage.update");
		expect(event).toBeDefined();
		expect(event!.attributes!["usage.percent"]).toBe(50);
	});

	it("recordEvent targets tracked span when one is active", () => {
		tracer.startTracked("tc-1", "agent.tool_call", {}, "tool call");

		tracer.recordEvent("tool.update", { "tool.progress": "50%" });

		tracer.endTracked("tc-1");

		const toolSpan = findSpan(exporter, "agent.tool_call")!;
		const event = toolSpan.events.find((e) => e.name === "tool.update");
		expect(event).toBeDefined();
		expect(event!.attributes!["tool.progress"]).toBe("50%");
	});
});

// ── Shutdown ───────────────────────────────────────────────────────────────

describe("Tracer — Shutdown", () => {
	it("shutdown ends all lingering tracked spans with ERROR", async () => {
		const { tracer, exporter, provider } = createTestTracer();
		tracer.startRootSpan("test.session");

		// Start a tool call span via startTracked
		tracer.startTracked(
			"tc-1",
			"agent.tool_call",
			{
				"tool.call_id": "tc-1",
				"tool.title": "Lingering tool",
			},
			"tool call",
		);

		const spans = await shutdownAndCollect(tracer, exporter, provider);
		const toolSpanFound = spans.find((s) => s.name === "agent.tool_call");

		expect(toolSpanFound).toBeDefined();
		expect(toolSpanFound!.status.code).toBe(SpanStatusCode.ERROR);

		const rootSpan = spans.find((s) => s.name === "test.session");
		expect(rootSpan).toBeDefined();
		expect(rootSpan!.status.code).toBe(SpanStatusCode.ERROR);
		expect(rootSpan!.status.message).toBe("Session ended with lingering spans");
	});

	it("shutdown ends lingering terminal spans with ERROR", async () => {
		const { tracer, exporter, provider } = createTestTracer();
		tracer.startRootSpan("test.session");

		// Start a terminal span via startTracked
		tracer.startTracked(
			"t-1",
			"agent.terminal",
			{
				"terminal.id": "t-1",
				"terminal.command": "long-running",
			},
			"terminal",
		);

		const spans = await shutdownAndCollect(tracer, exporter, provider);
		const termSpanFound = spans.find((s) => s.name === "agent.terminal");

		expect(termSpanFound).toBeDefined();
		expect(termSpanFound!.status.code).toBe(SpanStatusCode.ERROR);

		const rootSpan = spans.find((s) => s.name === "test.session");
		expect(rootSpan).toBeDefined();
		expect(rootSpan!.status.code).toBe(SpanStatusCode.ERROR);
		expect(rootSpan!.status.message).toBe("Session ended with lingering spans");
	});

	it("shutdown ends the root span", async () => {
		const { tracer, exporter, provider } = createTestTracer();
		tracer.startRootSpan("test.session");

		const spans = await shutdownAndCollect(tracer, exporter, provider);
		const session = spans.find((s) => s.name === "test.session");

		expect(session).toBeDefined();
		expect(session!.status.code).toBe(SpanStatusCode.OK);
	});

	it("shutdown is safe to call multiple times", async () => {
		const { tracer, exporter, provider } = createTestTracer();
		tracer.startRootSpan("test.session");

		const spans = await shutdownAndCollect(tracer, exporter, provider);

		// Second call should not throw
		await tracer.shutdown();

		const sessions = spans.filter((s) => s.name === "test.session");
		expect(sessions).toHaveLength(1);
	});

	it("shutdown flushes all spans to the exporter", async () => {
		const { tracer, exporter, provider } = createTestTracer();
		tracer.startRootSpan("test.session");

		// Create some child spans
		await tracer.wrap("init", async () => {});

		// Start a tool call span that we don't end
		tracer.startTracked(
			"tc-1",
			"agent.tool_call",
			{
				"tool.call_id": "tc-1",
				"tool.title": "Tool",
			},
			"tool call",
		);

		// Don't manually end tool — shutdown should handle it
		const spans = await shutdownAndCollect(tracer, exporter, provider);

		const names = spans.map((s) => s.name).sort();
		expect(names).toContain("test.session");
		expect(names).toContain("init");
		expect(names).toContain("agent.tool_call");

		const rootSpan = spans.find((s) => s.name === "test.session");
		expect(rootSpan).toBeDefined();
		expect(rootSpan!.status.code).toBe(SpanStatusCode.ERROR);
		expect(rootSpan!.status.message).toBe("Session ended with lingering spans");
	});
});

// ── Full Lifecycle ─────────────────────────────────────────────────────────

describe("Tracer — Full Lifecycle", () => {
	it("produces a correct span hierarchy for a complete session", async () => {
		const { tracer, exporter, provider } = createTestTracer();

		// Start root span
		tracer.startRootSpan("agent.session", {
			"agent.id": "test-001",
			"agent.name": "Test Agent",
		});

		// Initialize phase — nested wrap() calls
		await tracer.wrap("agent.initialize", async () => {
			await tracer.wrap("agent.initialize.spawn-process", async () => {});
			await tracer.wrap("agent.initialize.acp-protocol-init", async () => {});
			await tracer.wrap("agent.initialize.create-session", async () => {});
		});

		// First prompt
		await tracer.wrap(
			"agent.prompt",
			{
				"prompt.index": 1,
				"prompt.text": "Hello",
			},
			async (promptSpan) => {
				// Tool call via startTracked (long-lived, start/end at different sites)
				tracer.startTracked(
					"tc-1",
					"agent.tool_call",
					{
						"tool.call_id": "tc-1",
						"tool.title": "Run tests",
						"tool.kind": "execute",
						"tool.command": "bun test",
					},
					"tool call",
				);

				// Permission via wrap() — nested inside tool call context
				// (the tracked tool span is on top of the context stack)
				await tracer.wrap(
					"agent.permission",
					{
						"permission.tool_call_id": "tc-1",
						"permission.tool_call_title": "Run tests",
					},
					async (permSpan) => {
						permSpan.setAttribute("permission.outcome", "granted");
						permSpan.setAttribute("permission.option_id", "opt-1");
						permSpan.setAttribute("permission.option_name", "Allow");
					},
				);

				// End tool call
				const toolSpan = tracer.getTrackedSpan("tc-1");
				if (toolSpan?.isRecording()) {
					toolSpan.setAttribute("tool.status", "completed");
					toolSpan.setAttribute("tool.exit_code", 0);
				}
				tracer.endTracked("tc-1");

				// Context injection during prompt
				tracer.recordEvent("context.injected", {
					"context.instructions": "Add error handling",
					"context.instructions_length": 18,
					"context.queued": false,
				});

				// FS operation (scoped via wrap)
				await tracer.wrap(
					"agent.fs.read",
					{
						"fs.path": "/test.txt",
						"fs.operation": "read",
					},
					async (span) => {
						span.setAttribute("fs.content_length", 42);
					},
				);

				// Terminal via startTracked
				tracer.startTracked(
					"t-1",
					"agent.terminal",
					{
						"terminal.id": "t-1",
						"terminal.command": "echo",
						"terminal.cwd": "/tmp",
					},
					"terminal",
				);

				// End terminal
				tracer.endTracked("t-1");

				// Usage event
				tracer.recordEvent("usage.update", {
					"usage.context_used": 5000,
					"usage.context_size": 10000,
					"usage.context_percent": 50,
				});

				promptSpan.setAttribute("prompt.stop_reason", "end_turn");
			},
		);

		// Second prompt
		await tracer.wrap(
			"agent.prompt",
			{ "prompt.index": 2 },
			async (_span) => {},
		);

		// Collect all spans
		const allSpans = await shutdownAndCollect(tracer, exporter, provider);

		// Verify all expected spans exist
		const spanNames = allSpans.map((s) => s.name).sort();
		expect(spanNames).toContain("agent.session");
		expect(spanNames).toContain("agent.initialize");
		expect(spanNames).toContain("agent.initialize.spawn-process");
		expect(spanNames).toContain("agent.initialize.acp-protocol-init");
		expect(spanNames).toContain("agent.initialize.create-session");
		expect(spanNames).toContain("agent.prompt");
		expect(spanNames).toContain("agent.tool_call");
		expect(spanNames).toContain("agent.permission");
		expect(spanNames).toContain("agent.fs.read");
		expect(spanNames).toContain("agent.terminal");

		// All spans share the same traceId
		const traceIds = new Set(allSpans.map((s) => s.spanContext().traceId));
		expect(traceIds.size).toBe(1);

		// Two prompt spans
		const prompts = allSpans.filter((s) => s.name === "agent.prompt");
		expect(prompts).toHaveLength(2);

		// Context injection event on the prompt span (not root)
		const promptSpan = allSpans
			.filter((s) => s.name === "agent.prompt")
			.find((s) => s.attributes["prompt.index"] === 1)!;
		const ctxEvent = promptSpan.events.find(
			(e) => e.name === "context.injected",
		);
		expect(ctxEvent).toBeDefined();
		expect(ctxEvent!.attributes!["context.queued"]).toBe(false);
	});

	it("all spans share the same traceId across the entire lifecycle", async () => {
		const { tracer, exporter, provider } = createTestTracer();
		tracer.startRootSpan("test.session");

		await tracer.wrap("init", async () => {});

		await tracer.wrap("test.prompt", async () => {
			tracer.startTracked(
				"tc-1",
				"agent.tool_call",
				{
					"tool.call_id": "tc-1",
					"tool.title": "T",
				},
				"tool call",
			);
			tracer.endTracked("tc-1");
		});

		const spans = await shutdownAndCollect(tracer, exporter, provider);
		const traceIds = new Set(spans.map((s) => s.spanContext().traceId));
		expect(traceIds.size).toBe(1);
	});

	it("every non-root span has a parentSpanContext", async () => {
		const { tracer, exporter, provider } = createTestTracer();
		tracer.startRootSpan("test.session");

		await tracer.wrap("init", async () => {
			await tracer.wrap("init.phase", async () => {});
		});

		await tracer.wrap("test.prompt", async () => {
			await tracer.wrap(
				"custom.op",
				{
					"fs.path": "/test",
					"fs.operation": "read",
				},
				async () => {},
			);
		});

		const spans = await shutdownAndCollect(tracer, exporter, provider);

		// Every span except the root should have a parent
		for (const span of spans) {
			if (span.name === "test.session") continue; // root has no parent

			const parent = parentSpanId(span);
			expect(parent).toBeDefined();
			expect(parent!.length).toBe(16);
		}
	});

	it("tool call and permission share the same parent-child chain", async () => {
		const { tracer, exporter, provider } = createTestTracer();
		tracer.startRootSpan("test.session");

		await tracer.wrap("test.prompt", async () => {
			// Tool call via startTracked
			tracer.startTracked(
				"tc-1",
				"agent.tool_call",
				{
					"tool.call_id": "tc-1",
					"tool.title": "Run cmd",
					"tool.kind": "execute",
				},
				"tool call",
			);

			// Permission is created inside the tracked tool call context,
			// so it becomes a child of the tool call span
			await tracer.wrap(
				"agent.permission",
				{
					"permission.tool_call_id": "tc-1",
					"permission.tool_call_title": "Run cmd",
				},
				async (permSpan) => {
					permSpan.setAttribute("permission.outcome", "granted");
				},
			);

			// End tool call
			tracer.endTracked("tc-1");
		});

		const spans = await shutdownAndCollect(tracer, exporter, provider);

		const toolSpanFound = spans.find((s) => s.name === "agent.tool_call")!;
		const permSpanFound = spans.find((s) => s.name === "agent.permission")!;

		// Permission should be a child of the tool call
		const permParent = parentSpanId(permSpanFound);
		expect(permParent).toBe(toolSpanFound.spanContext().spanId);
	});

	it("spans have realistic span IDs (16 hex chars)", async () => {
		const { tracer, exporter, provider } = createTestTracer();
		tracer.startRootSpan("test.session");

		await tracer.wrap("init", async () => {});

		const spans = await shutdownAndCollect(tracer, exporter, provider);

		for (const span of spans) {
			expect(span.spanContext().spanId.length).toBe(16);
			expect(span.spanContext().traceId.length).toBe(32);
		}
	});
});

// ── Context (getContext) ───────────────────────────────────────────────────

describe("Tracer — Context", () => {
	it("returns undefined when tracing is disabled", () => {
		const tracer = new Tracer({ enabled: false });
		expect(tracer.getContext()).toBeUndefined();
	});

	it("returns undefined when no root span is started", () => {
		const { provider } = createTestProvider();
		const tracer = new Tracer({ enabled: true, provider });
		expect(tracer.getContext()).toBeUndefined();
		provider.shutdown();
	});

	it("returns trace context with TraceId and SpanId when root span is active", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("test.session");

		const ctx = tracer.getContext();
		expect(ctx).toBeDefined();
		expect(ctx!.TraceId).toBeDefined();
		expect(ctx!.TraceId.length).toBe(32);
		expect(ctx!.SpanId).toBeDefined();
		expect(ctx!.SpanId.length).toBe(16);

		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("root span has no ParentSpanId", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("test.session");

		const ctx = tracer.getContext()!;
		expect(ctx.ParentSpanId).toBeUndefined();

		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("wrap() sets context to the wrapped span during callback", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("test.session");
		const rootCtx = tracer.getContext()!;

		tracer.wrapSync("test.operation", (span) => {
			const innerCtx = tracer.getContext()!;

			// TraceId should be the same
			expect(innerCtx.TraceId).toBe(rootCtx.TraceId);
			// SpanId should be the operation span, not root
			expect(innerCtx.SpanId).not.toBe(rootCtx.SpanId);
			expect(innerCtx.SpanId).toBe(span.spanContext().spanId);
			// ParentSpanId should point to root span
			expect(innerCtx.ParentSpanId).toBe(rootCtx.SpanId);
		});

		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("context reverts after wrap() completes", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("test.session");
		const rootCtx = tracer.getContext()!;

		tracer.wrapSync("test.operation", (_span) => {});

		// After wrapSync completes, context should be back to root
		const afterCtx = tracer.getContext()!;
		expect(afterCtx.SpanId).toBe(rootCtx.SpanId);

		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("nested wrap() produces correct ParentSpanId chain", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("test.session");
		const rootCtx = tracer.getContext()!;

		tracer.wrapSync("test.prompt", (_promptSpan) => {
			const promptCtx = tracer.getContext()!;
			expect(promptCtx.ParentSpanId).toBe(rootCtx.SpanId);

			tracer.wrapSync("test.tool_call", (_toolSpan) => {
				const toolCtx = tracer.getContext()!;
				expect(toolCtx.ParentSpanId).toBe(promptCtx.SpanId);

				tracer.wrapSync("test.permission", (_permSpan) => {
					const permCtx = tracer.getContext()!;
					expect(permCtx.ParentSpanId).toBe(toolCtx.SpanId);
				});

				// After permission returns, back to tool context
				expect(tracer.getContext()!.SpanId).toBe(toolCtx.SpanId);
			});

			// After tool call returns, back to prompt context
			expect(tracer.getContext()!.SpanId).toBe(promptCtx.SpanId);
		});

		// After prompt returns, back to root context
		expect(tracer.getContext()!.SpanId).toBe(rootCtx.SpanId);

		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("tracked span affects context resolution", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("test.session");
		const rootCtx = tracer.getContext()!;

		const trackedSpan = tracer.startTracked(
			"tc-1",
			"tool_call",
			{ "tool.call_id": "tc-1" },
			"tool call",
		);

		const trackedCtx = tracer.getContext()!;
		expect(trackedCtx.SpanId).toBe(trackedSpan.spanContext().spanId);
		expect(trackedCtx.ParentSpanId).toBe(rootCtx.SpanId);

		tracer.endTracked("tc-1");

		// After endTracked, context falls back to root
		const afterCtx = tracer.getContext()!;
		expect(afterCtx.SpanId).toBe(rootCtx.SpanId);

		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("wrap() auto-enters and auto-leaves the span for context", async () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("test.session");
		const rootCtx = tracer.getContext()!;

		let capturedCtx: ReturnType<typeof tracer.getContext>;
		await tracer.wrap("test.fs.read", async (_span) => {
			capturedCtx = tracer.getContext();
		});

		// Inside wrap(), the context should have been the fs.read span
		expect(capturedCtx!).toBeDefined();
		expect(capturedCtx!.SpanId).not.toBe(rootCtx.SpanId);
		expect(capturedCtx!.ParentSpanId).toBe(rootCtx.SpanId);

		// After wrap(), context should be back to root
		const afterCtx = tracer.getContext()!;
		expect(afterCtx.SpanId).toBe(rootCtx.SpanId);

		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("wrapSync() auto-enters and auto-leaves the span for context", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("test.session");
		const rootCtx = tracer.getContext()!;

		let capturedCtx: ReturnType<typeof tracer.getContext>;
		tracer.wrapSync("test.json.parse", (_span) => {
			capturedCtx = tracer.getContext();
			return { key: "value" };
		});

		// Inside wrapSync(), the context should have been the parse span
		expect(capturedCtx!).toBeDefined();
		expect(capturedCtx!.SpanId).not.toBe(rootCtx.SpanId);
		expect(capturedCtx!.ParentSpanId).toBe(rootCtx.SpanId);

		// After wrapSync(), context should be back to root
		const afterCtx = tracer.getContext()!;
		expect(afterCtx.SpanId).toBe(rootCtx.SpanId);

		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("flush ends root span so getContext returns undefined", async () => {
		const { tracer } = createTestTracer();
		tracer.startRootSpan("test.session");

		// Flush ends lingering spans and root span
		await tracer.flush();

		// After flush, getContext returns undefined (root span ended)
		expect(tracer.getContext()).toBeUndefined();

		await tracer.shutdown();
	});

	it("deeply nested wrapSync (4 levels) produces correct ParentSpanId chain", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");
		const rootCtx = tracer.getContext()!;

		tracer.wrapSync("level.1", (_span) => {
			const l1Ctx = tracer.getContext()!;
			expect(l1Ctx.ParentSpanId).toBe(rootCtx.SpanId);

			tracer.wrapSync("level.2", (_span) => {
				const l2Ctx = tracer.getContext()!;
				expect(l2Ctx.ParentSpanId).toBe(l1Ctx.SpanId);

				tracer.wrapSync("level.3", (_span) => {
					const l3Ctx = tracer.getContext()!;
					expect(l3Ctx.ParentSpanId).toBe(l2Ctx.SpanId);

					tracer.wrapSync("level.4", (_span) => {
						const l4Ctx = tracer.getContext()!;
						expect(l4Ctx.ParentSpanId).toBe(l3Ctx.SpanId);
					});

					// Back to level 3
					expect(tracer.getContext()!.SpanId).toBe(l3Ctx.SpanId);
				});

				// Back to level 2
				expect(tracer.getContext()!.SpanId).toBe(l2Ctx.SpanId);
			});

			// Back to level 1
			expect(tracer.getContext()!.SpanId).toBe(l1Ctx.SpanId);
		});

		// Back to root
		expect(tracer.getContext()!.SpanId).toBe(rootCtx.SpanId);

		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("nested wrap() calls produce correct ParentSpanId at each level", async () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");
		const rootCtx = tracer.getContext()!;

		let outerCtx: ReturnType<typeof tracer.getContext>;
		let innerCtx: ReturnType<typeof tracer.getContext>;

		await tracer.wrap("outer.op", async (_outerSpan) => {
			outerCtx = tracer.getContext();
			await tracer.wrap("inner.op", async (_innerSpan) => {
				innerCtx = tracer.getContext();
			});
		});

		// Outer is child of root
		expect(outerCtx!.ParentSpanId).toBe(rootCtx.SpanId);
		// Inner is child of outer
		expect(innerCtx!.ParentSpanId).toBe(outerCtx!.SpanId);
		// All three have distinct SpanIds
		expect(
			new Set([rootCtx.SpanId, outerCtx!.SpanId, innerCtx!.SpanId]).size,
		).toBe(3);

		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("wrapSync() that throws still restores context correctly", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");
		const rootCtx = tracer.getContext()!;

		tracer.wrapSync("prompt.1", (_promptSpan) => {
			const promptCtx = tracer.getContext()!;

			try {
				tracer.wrapSync("failing.op", (_span) => {
					const ctx = tracer.getContext()!;
					// Inside, ParentSpanId should point to prompt
					expect(ctx.ParentSpanId).toBe(promptCtx.SpanId);
					throw new Error("boom");
				});
			} catch {
				// expected
			}

			// After the throw, context is back to prompt
			const afterCtx = tracer.getContext()!;
			expect(afterCtx.SpanId).toBe(promptCtx.SpanId);
		});

		// Back to root
		expect(tracer.getContext()!.SpanId).toBe(rootCtx.SpanId);

		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("wrap() that throws still restores context correctly", async () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");
		const rootCtx = tracer.getContext()!;

		await tracer.wrap("prompt.1", async (_promptSpan) => {
			const promptCtx = tracer.getContext()!;

			try {
				await tracer.wrap("async.failing.op", async (_span) => {
					const ctx = tracer.getContext()!;
					expect(ctx.ParentSpanId).toBe(promptCtx.SpanId);
					throw new Error("async boom");
				});
			} catch {
				// expected
			}

			const afterCtx = tracer.getContext()!;
			expect(afterCtx.SpanId).toBe(promptCtx.SpanId);
		});

		expect(tracer.getContext()!.SpanId).toBe(rootCtx.SpanId);

		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("simulated terminal span lifecycle has correct context", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");

		tracer.wrapSync("prompt.1", (_promptSpan) => {
			const promptCtx = tracer.getContext()!;

			// Start a terminal span (child of prompt via tracked context)
			const termSpan = tracer.startTracked(
				"term_1",
				"terminal",
				{
					"terminal.id": "term_1",
					"terminal.command": "ls -la",
				},
				"terminal",
			);

			const termCtx = tracer.getContext()!;
			expect(termCtx.SpanId).toBe(termSpan.spanContext().spanId);
			expect(termCtx.ParentSpanId).toBe(promptCtx.SpanId);

			// Terminal exits — end tracked
			tracer.endTracked("term_1");

			// Back to prompt (the wrap context, since tracked span is removed)
			const afterCtx = tracer.getContext()!;
			expect(afterCtx.SpanId).toBe(promptCtx.SpanId);
		});

		tracer.endRootSpan("ok");
		provider.shutdown();
	});
});

// ── ParentSpanId ───────────────────────────────────────────────────────────

describe("Tracer — ParentSpanId", () => {
	it("root span has no ParentSpanId", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");

		const ctx = tracer.getContext()!;
		expect(ctx).toBeDefined();
		expect(ctx.ParentSpanId).toBeUndefined();

		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("wrap span ParentSpanId points to root span SpanId", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");
		const rootCtx = tracer.getContext()!;

		tracer.wrapSync("prompt.1", (_span) => {
			const wrapCtx = tracer.getContext()!;
			expect(wrapCtx.ParentSpanId).toBeDefined();
			expect(wrapCtx.ParentSpanId).toBe(rootCtx.SpanId);
		});

		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("ParentSpanId is a 16-hex-char string when present", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");

		tracer.wrapSync("prompt.1", (_span) => {
			const ctx = tracer.getContext()!;
			expect(ctx.ParentSpanId).toBeDefined();
			expect(ctx.ParentSpanId!.length).toBe(16);
			expect(ctx.ParentSpanId).toMatch(/^[0-9a-f]{16}$/);
		});

		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("nested wrap produces correct parent chain", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");
		const rootCtx = tracer.getContext()!;

		tracer.wrapSync("prompt.1", (_promptSpan) => {
			const promptCtx = tracer.getContext()!;
			expect(promptCtx.ParentSpanId).toBe(rootCtx.SpanId);

			tracer.wrapSync("tool_call", (_toolSpan) => {
				const toolCtx = tracer.getContext()!;
				expect(toolCtx.ParentSpanId).toBe(promptCtx.SpanId);
			});
		});

		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("full chain: root → wrap → wrap → wrap produces correct ParentSpanId at every level", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");
		const rootCtx = tracer.getContext()!;
		expect(rootCtx.ParentSpanId).toBeUndefined();

		tracer.wrapSync("prompt.1", (_promptSpan) => {
			const promptCtx = tracer.getContext()!;
			expect(promptCtx.ParentSpanId).toBe(rootCtx.SpanId);

			tracer.wrapSync("tool_call", { "tool.call_id": "tc_1" }, (_toolSpan) => {
				const toolCtx = tracer.getContext()!;
				expect(toolCtx.ParentSpanId).toBe(promptCtx.SpanId);

				tracer.wrapSync(
					"permission",
					{ "permission.tool_call_id": "tc_1" },
					(_permSpan) => {
						const permCtx = tracer.getContext()!;
						expect(permCtx.ParentSpanId).toBe(toolCtx.SpanId);

						// All share the same TraceId
						expect(promptCtx.TraceId).toBe(rootCtx.TraceId);
						expect(toolCtx.TraceId).toBe(rootCtx.TraceId);
						expect(permCtx.TraceId).toBe(rootCtx.TraceId);

						// All SpanIds are distinct
						const ids = [
							rootCtx.SpanId,
							promptCtx.SpanId,
							toolCtx.SpanId,
							permCtx.SpanId,
						];
						expect(new Set(ids).size).toBe(4);
					},
				);
			});
		});

		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("context correctly reverts at each level after wrapSync", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");
		const rootCtx = tracer.getContext()!;

		tracer.wrapSync("prompt.1", (_promptSpan) => {
			const promptCtx = tracer.getContext()!;

			tracer.wrapSync("tool_call", (_toolSpan) => {
				tracer.wrapSync("permission", (_permSpan) => {});

				// After permission, back to tool context
				const afterPermCtx = tracer.getContext()!;
				expect(afterPermCtx.SpanId).toBe(tracer.getContext()!.SpanId);
				expect(afterPermCtx.ParentSpanId).toBe(promptCtx.SpanId);
			});

			// After tool call, back to prompt context
			const afterToolCtx = tracer.getContext()!;
			expect(afterToolCtx.SpanId).toBe(promptCtx.SpanId);
			expect(afterToolCtx.ParentSpanId).toBe(rootCtx.SpanId);
		});

		// After prompt, back to root
		const afterAll = tracer.getContext()!;
		expect(afterAll.SpanId).toBe(rootCtx.SpanId);
		expect(afterAll.ParentSpanId).toBeUndefined();

		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("sequential wrap spans each have ParentSpanId pointing to root", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");
		const rootCtx = tracer.getContext()!;

		let a1SpanId: string | undefined;
		tracer.wrapSync("prompt.1", (_span) => {
			const a1Ctx = tracer.getContext()!;
			a1SpanId = a1Ctx.SpanId;
			expect(a1Ctx.ParentSpanId).toBe(rootCtx.SpanId);
		});

		tracer.wrapSync("prompt.2", (_span) => {
			const a2Ctx = tracer.getContext()!;
			expect(a2Ctx.ParentSpanId).toBe(rootCtx.SpanId);
			// Different SpanIds for the two spans
			expect(a2Ctx.SpanId).not.toBe(a1SpanId);
		});

		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("ParentSpanId is stable across consecutive getContext calls", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");

		tracer.wrapSync("prompt.1", (_promptSpan) => {
			tracer.wrapSync("tool_call", (_toolSpan) => {
				const ctx1 = tracer.getContext()!;
				const ctx2 = tracer.getContext()!;
				const ctx3 = tracer.getContext()!;

				expect(ctx1.ParentSpanId).toBe(ctx2.ParentSpanId);
				expect(ctx2.ParentSpanId).toBe(ctx3.ParentSpanId);
				expect(ctx1.SpanId).toBe(ctx2.SpanId);
				expect(ctx2.SpanId).toBe(ctx3.SpanId);
			});
		});

		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("tracked span has correct ParentSpanId", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");

		tracer.wrapSync("prompt.1", (_promptSpan) => {
			const promptCtx = tracer.getContext()!;

			// Start a tracked tool call span
			tracer.startTracked(
				"tc_42",
				"tool_call",
				{ "tool.call_id": "tc_42" },
				"tool call",
			);

			const toolCtx = tracer.getContext()!;
			expect(toolCtx.ParentSpanId).toBe(promptCtx.SpanId);
			expect(toolCtx.SpanId).not.toBe(promptCtx.SpanId);

			// End tracked span
			tracer.endTracked("tc_42");

			// Context reverts to prompt
			const afterCtx = tracer.getContext()!;
			expect(afterCtx.SpanId).toBe(promptCtx.SpanId);
		});

		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("wrap() provides correct ParentSpanId inside the callback", async () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");

		const _rootCtx = tracer.getContext()!;

		let innerCtx: ReturnType<typeof tracer.getContext>;
		await tracer.wrap("prompt.1", async (_promptSpan) => {
			const promptCtx = tracer.getContext()!;

			await tracer.wrap("fs.read", async (_span) => {
				innerCtx = tracer.getContext();
			});

			expect(innerCtx!).toBeDefined();
			expect(innerCtx!.ParentSpanId).toBe(promptCtx.SpanId);

			// After wrap() completes, ParentSpanId reverts
			const afterCtx = tracer.getContext()!;
			expect(afterCtx.SpanId).toBe(promptCtx.SpanId);
		});

		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("multiple tool calls in same prompt each have ParentSpanId pointing to prompt", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");

		tracer.wrapSync("prompt.1", (_promptSpan) => {
			const promptCtx = tracer.getContext()!;

			// First tool call
			tracer.wrapSync("tool_call.1", (_span) => {
				const tool1Ctx = tracer.getContext()!;
				expect(tool1Ctx.ParentSpanId).toBe(promptCtx.SpanId);
			});

			// Second tool call
			tracer.wrapSync("tool_call.2", (_span) => {
				const tool2Ctx = tracer.getContext()!;
				expect(tool2Ctx.ParentSpanId).toBe(promptCtx.SpanId);
			});

			// Third tool call
			tracer.wrapSync("tool_call.3", (_span) => {
				const tool3Ctx = tracer.getContext()!;
				expect(tool3Ctx.ParentSpanId).toBe(promptCtx.SpanId);
			});
		});

		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("ParentSpanId is undefined for disabled tracer", () => {
		const tracer = new Tracer({ enabled: false });
		expect(tracer.getContext()).toBeUndefined();

		tracer.startRootSpan("session");
		expect(tracer.getContext()).toBeUndefined();
	});

	it("TraceId is consistent while ParentSpanId changes through the hierarchy", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");
		const rootCtx = tracer.getContext()!;
		const traceId = rootCtx.TraceId;

		tracer.wrapSync("prompt.1", (_promptSpan) => {
			const promptCtx = tracer.getContext()!;
			expect(promptCtx.TraceId).toBe(traceId);
			expect(promptCtx.ParentSpanId).toBe(rootCtx.SpanId);

			tracer.wrapSync("tool_call", (_span) => {
				const opCtx = tracer.getContext()!;
				expect(opCtx.TraceId).toBe(traceId);
				expect(opCtx.ParentSpanId).toBe(promptCtx.SpanId);
			});

			// Back to prompt — same TraceId, ParentSpanId reverts to root
			const revertCtx = tracer.getContext()!;
			expect(revertCtx.TraceId).toBe(traceId);
			expect(revertCtx.ParentSpanId).toBe(rootCtx.SpanId);
		});

		tracer.endRootSpan("ok");
		provider.shutdown();
	});
});

// ── Custom Tracer Names ────────────────────────────────────────────────────

describe("Tracer — Custom Configuration", () => {
	it("accepts custom tracerName and tracerVersion", () => {
		const { provider } = createTestProvider();
		const tracer = new Tracer({
			enabled: true,
			provider,
			tracerName: "my-pipeline",
			tracerVersion: "2.0.0",
		});

		tracer.startRootSpan("pipeline.run");
		tracer.endRootSpan("ok");

		// If it didn't throw, the config was accepted
		expect(tracer.enabled).toBe(true);

		provider.shutdown();
	});

	it("accepts custom serviceName", () => {
		const { provider } = createTestProvider();
		const tracer = new Tracer({
			enabled: true,
			provider,
			serviceName: "my-custom-service",
		});

		expect(tracer.enabled).toBe(true);
		provider.shutdown();
	});
});
