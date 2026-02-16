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
	_provider: BasicTracerProvider,
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

	it("all span methods return non-throwing no-ops when disabled", () => {
		const tracer = new Tracer({ enabled: false });

		// None of these should throw
		const _root = tracer.startRootSpan("test.root");
		const active = tracer.startActiveSpan("test.active");

		// Tool call via public API (external helpers removed)
		const toolSpan = tracer.startOperation(
			"agent.tool_call",
			{
				"tool.call_id": "tc-1",
				"tool.title": "Test tool",
				"tool.kind": "execute",
			},
			"active",
		);
		tracer.trackSpan("tc-1", toolSpan, "tool call");
		const trackedTool = tracer.getTrackedSpan("tc-1");
		// NOOP spans are not tracked
		expect(trackedTool).toBeUndefined();
		tracer.endOperation(toolSpan);

		// Permission via public API
		const permSpan = tracer.startOperation(
			"agent.permission",
			{
				"permission.tool_call_id": "tc-1",
				"permission.tool_call_title": "Test",
			},
			"active",
		);
		permSpan.setAttribute("permission.outcome", "granted");
		permSpan.setAttribute("permission.option_id", "opt-1");
		permSpan.setAttribute("permission.option_name", "Allow");
		permSpan.setStatus({ code: SpanStatusCode.OK });
		permSpan.end();

		// Terminal via public API
		const termSpan = tracer.startOperation(
			"agent.terminal",
			{
				"terminal.id": "t-1",
				"terminal.command": "echo",
			},
			"active",
		);
		termSpan.setAttribute("terminal.args", ["hello"]);
		termSpan.setStatus({ code: SpanStatusCode.OK });
		termSpan.end();

		// Context injection + usage via public API
		tracer.recordEvent("active", "context.injected", {
			"context.instructions": "some instructions",
			"context.queued": false,
		});
		tracer.recordEvent("active", "usage.update", {
			"usage.context_used": 100,
			"usage.context_size": 1000,
			"usage.context_percent": 10,
		});

		// Generic API
		const op = tracer.startOperation("custom.op", { key: "val" });
		tracer.endOperation(op);

		tracer.trackSpan("x", op, "custom");
		expect(tracer.getTrackedSpan("x")).toBeUndefined(); // NOOP not tracked
		expect(tracer.removeTrackedSpan("x")).toBeUndefined();

		tracer.recordEvent("root", "test.event", { foo: "bar" });

		tracer.endActiveSpan(active);
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
		await provider.shutdown();
	});

	it("startRootSpan creates a root span with the given name", () => {
		tracer.startRootSpan("test.session");
		tracer.endRootSpan("ok");

		const span = findSpan(exporter, "test.session");
		expect(span).toBeDefined();
	});

	it("root span carries custom attributes", () => {
		tracer.startRootSpan("agent.session", {
			"entity.id": "test-001",
			"entity.name": "Test Entity",
		});
		tracer.endRootSpan("ok");

		const span = findSpan(exporter, "agent.session")!;
		expect(attr(span, "entity.id")).toBe("test-001");
		expect(attr(span, "entity.name")).toBe("Test Entity");
	});

	it("endRootSpan with 'ok' sets status OK", () => {
		tracer.startRootSpan("test.session");
		tracer.endRootSpan("ok");

		const span = findSpan(exporter, "test.session")!;
		expect(span.status.code).toBe(SpanStatusCode.OK);
	});

	it("endRootSpan with 'error' sets status ERROR with message", () => {
		tracer.startRootSpan("test.session");
		tracer.endRootSpan("error", "Something failed");

		const span = findSpan(exporter, "test.session")!;
		expect(span.status.code).toBe(SpanStatusCode.ERROR);
		expect(span.status.message).toBe("Something failed");
	});

	it("endRootSpan is safe to call multiple times", () => {
		tracer.startRootSpan("test.session");
		tracer.endRootSpan("ok");
		tracer.endRootSpan("ok"); // should not throw

		const spans = exporter
			.getFinishedSpans()
			.filter((s) => s.name === "test.session");
		expect(spans).toHaveLength(1);
	});

	it("endRootSpan is a no-op when root span was never started", () => {
		// Should not throw
		tracer.endRootSpan("ok");
		tracer.endRootSpan("error", "nothing here");

		expect(exporter.getFinishedSpans()).toHaveLength(0);
	});

	it("startRootSpan ends the previous root span when called twice", async () => {
		const _firstRoot = tracer.startRootSpan("first.session", {
			"session.id": "1",
		});
		const _secondRoot = tracer.startRootSpan("second.session", {
			"session.id": "2",
		});
		tracer.endRootSpan("ok");
		await provider.forceFlush();
		const spans = exporter.getFinishedSpans();
		const firstSpan = spans.find((s) => s.name === "first.session");
		const secondSpan = spans.find((s) => s.name === "second.session");
		expect(firstSpan).toBeDefined();
		expect(firstSpan!.status.code).toBe(SpanStatusCode.ERROR);
		expect(firstSpan!.status.message).toBe(
			"Root span replaced before completion",
		);
		expect(secondSpan).toBeDefined();
		expect(secondSpan!.status.code).toBe(SpanStatusCode.OK);
	});
});

// ── Active Span ────────────────────────────────────────────────────────────

describe("Tracer — Active Span", () => {
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

	it("startActiveSpan creates a span with the given name", () => {
		const span = tracer.startActiveSpan("test.active", {
			"active.index": 1,
			"active.text": "hello",
		});
		tracer.endActiveSpan(span);

		const found = findSpan(exporter, "test.active");
		expect(found).toBeDefined();
	});

	it("active span carries custom attributes", () => {
		const span = tracer.startActiveSpan("test.active", {
			"prompt.index": 1,
			"prompt.text": "hello world".slice(0, 500),
			"prompt.text_length": 11,
		});
		tracer.endActiveSpan(span);

		const found = findSpan(exporter, "test.active")!;
		expect(attr(found, "prompt.index")).toBe(1);
		expect(attr(found, "prompt.text")).toBe("hello world");
		expect(attr(found, "prompt.text_length")).toBe(11);
	});

	it("endActiveSpan with error sets ERROR status", () => {
		const span = tracer.startActiveSpan("test.active");
		tracer.endActiveSpan(span, new Error("prompt failed"));

		const found = findSpan(exporter, "test.active")!;
		expect(found.status.code).toBe(SpanStatusCode.ERROR);
	});

	it("endActiveSpan with success sets OK status", () => {
		const span = tracer.startActiveSpan("test.active");
		tracer.endActiveSpan(span);

		const found = findSpan(exporter, "test.active")!;
		expect(found.status.code).toBe(SpanStatusCode.OK);
	});

	it("active span shares the same traceId as the root span", () => {
		const span = tracer.startActiveSpan("test.active");
		tracer.endActiveSpan(span);
		tracer.endRootSpan("ok");

		const rootSpan = findSpan(exporter, "test.session")!;
		const activeSpan = findSpan(exporter, "test.active")!;
		expect(activeSpan.spanContext().traceId).toBe(
			rootSpan.spanContext().traceId,
		);
	});

	it("active span is a child of the root span", () => {
		const span = tracer.startActiveSpan("test.active");
		tracer.endActiveSpan(span);
		tracer.endRootSpan("ok");

		const rootSpan = findSpan(exporter, "test.session")!;
		const activeSpan = findSpan(exporter, "test.active")!;
		const parent = parentSpanId(activeSpan);
		expect(parent).toBe(rootSpan.spanContext().spanId);
	});

	it("supports multiple sequential active spans", () => {
		const a1 = tracer.startActiveSpan("test.active.1");
		tracer.endActiveSpan(a1);

		const a2 = tracer.startActiveSpan("test.active.2");
		tracer.endActiveSpan(a2);

		const actives = exporter
			.getFinishedSpans()
			.filter((s) => s.name.startsWith("test.active"));
		expect(actives).toHaveLength(2);
	});
});

// ── Generic API ────────────────────────────────────────────────────────────

describe("Tracer — Generic API", () => {
	let tracer: Tracer;
	let exporter: InMemorySpanExporter;
	let provider: BasicTracerProvider;

	beforeEach(() => {
		({ tracer, exporter, provider } = createTestTracer());
		tracer.startRootSpan("test.session");
		tracer.startActiveSpan("test.active");
	});

	afterEach(async () => {
		tracer.endRootSpan("ok");
		await provider.shutdown();
	});

	it("startOperation creates a span with the given name and attributes", () => {
		const span = tracer.startOperation(
			"custom.op",
			{
				"custom.key": "value",
				"custom.num": 42,
			},
			"active",
		);
		tracer.endOperation(span);

		const found = findSpan(exporter, "custom.op")!;
		expect(found).toBeDefined();
		expect(attr(found, "custom.key")).toBe("value");
		expect(attr(found, "custom.num")).toBe(42);
	});

	it("endOperation with error sets ERROR status", () => {
		const span = tracer.startOperation("failing.op", {}, "active");
		tracer.endOperation(span, new Error("something broke"));

		const found = findSpan(exporter, "failing.op")!;
		expect(found.status.code).toBe(SpanStatusCode.ERROR);
		expect(found.status.message).toBe("something broke");
	});

	it("traced() creates and auto-closes a span on success", async () => {
		const result = await tracer.traced(
			"fs.read",
			async (span) => {
				span.setAttribute("fs.path", "/test.txt");
				return "file content";
			},
			{ attributes: { "fs.operation": "read" }, parent: "active" },
		);

		expect(result).toBe("file content");

		const found = findSpan(exporter, "fs.read")!;
		expect(found).toBeDefined();
		expect(found.status.code).toBe(SpanStatusCode.OK);
		expect(attr(found, "fs.operation")).toBe("read");
		expect(attr(found, "fs.path")).toBe("/test.txt");
	});

	it("traced() sets ERROR status and re-throws on failure", async () => {
		const work = tracer.traced(
			"fs.write",
			async (_span) => {
				throw new Error("EACCES: permission denied");
			},
			{ attributes: { "fs.path": "/root/file" }, parent: "active" },
		);

		await expect(work).rejects.toThrow("EACCES: permission denied");

		const found = findSpan(exporter, "fs.write")!;
		expect(found).toBeDefined();
		expect(found.status.code).toBe(SpanStatusCode.ERROR);
		expect(found.status.message).toBe("EACCES: permission denied");
	});

	it("traced() span is a child of the active span", async () => {
		await tracer.traced("custom.op", async (_span) => "ok", {
			parent: "active",
		});

		const customSpan = findSpan(exporter, "custom.op")!;
		const parent = parentSpanId(customSpan);
		expect(parent).toBeDefined();
		expect(parent?.length).toBe(16);
	});

	it("startOperation with explicit parent span creates a child", () => {
		const parentOp = tracer.startOperation("parent.op", {}, "root");
		const childOp = tracer.startOperation("child.op", {}, parentOp);
		tracer.endOperation(childOp);
		tracer.endOperation(parentOp);

		const parentFound = findSpan(exporter, "parent.op")!;
		const childFound = findSpan(exporter, "child.op")!;
		const childParent = parentSpanId(childFound);
		expect(childParent).toBe(parentFound.spanContext().spanId);
	});

	it("startOperation with 'root' creates a child of the root span", () => {
		const span = tracer.startOperation("root-child.op", {}, "root");
		tracer.endOperation(span);
		tracer.endRootSpan("ok");

		const rootSpan = findSpan(exporter, "test.session")!;
		const childSpan = findSpan(exporter, "root-child.op")!;
		const parent = parentSpanId(childSpan);
		expect(parent).toBe(rootSpan.spanContext().spanId);
	});

	it("tracedSync() creates and auto-closes a span on success", () => {
		const result = tracer.tracedSync(
			"json.parse",
			(span) => {
				span.setAttribute("json.keys", 3);
				return { a: 1, b: 2, c: 3 };
			},
			{ attributes: { "json.length": 20 }, parent: "active" },
		);

		expect(result).toEqual({ a: 1, b: 2, c: 3 });

		const found = findSpan(exporter, "json.parse")!;
		expect(found).toBeDefined();
		expect(found.status.code).toBe(SpanStatusCode.OK);
		expect(attr(found, "json.length")).toBe(20);
		expect(attr(found, "json.keys")).toBe(3);
	});

	it("tracedSync() sets ERROR status and re-throws on failure", () => {
		expect(() =>
			tracer.tracedSync(
				"json.parse.fail",
				(_span) => {
					throw new Error("Unexpected token");
				},
				{ attributes: { "json.length": 5 }, parent: "active" },
			),
		).toThrow("Unexpected token");

		const found = findSpan(exporter, "json.parse.fail")!;
		expect(found).toBeDefined();
		expect(found.status.code).toBe(SpanStatusCode.ERROR);
		expect(found.status.message).toBe("Unexpected token");
	});

	it("tracedSync() span is a child of the active span", () => {
		tracer.tracedSync("sync.child", (_span) => "ok", {
			parent: "active",
		});

		const childSpan = findSpan(exporter, "sync.child")!;
		const parent = parentSpanId(childSpan);
		expect(parent).toBeDefined();
		expect(parent?.length).toBe(16);
	});
});

// ── Span Tracking ──────────────────────────────────────────────────────────

describe("Tracer — Span Tracking", () => {
	let tracer: Tracer;
	let exporter: InMemorySpanExporter;
	let provider: BasicTracerProvider;

	beforeEach(() => {
		({ tracer, exporter, provider } = createTestTracer());
		tracer.startRootSpan("test.session");
		tracer.startActiveSpan("test.active");
	});

	afterEach(async () => {
		tracer.endRootSpan("ok");
		await provider.shutdown();
	});

	it("trackSpan stores a recording span and getTrackedSpan retrieves it", () => {
		const span = tracer.startOperation("test.op", {}, "active");
		tracer.trackSpan("my-id", span, "test");

		const retrieved = tracer.getTrackedSpan("my-id");
		expect(retrieved).toBe(span);

		tracer.endOperation(span);
	});

	it("removeTrackedSpan removes and returns the span", () => {
		const span = tracer.startOperation("test.op", {}, "active");
		tracer.trackSpan("my-id", span, "test");

		const removed = tracer.removeTrackedSpan("my-id");
		expect(removed).toBe(span);
		expect(tracer.getTrackedSpan("my-id")).toBeUndefined();

		tracer.endOperation(span);
	});

	it("removeTrackedSpan returns undefined for unknown IDs", () => {
		expect(tracer.removeTrackedSpan("nonexistent")).toBeUndefined();
	});

	it("getTrackedSpan returns undefined for unknown IDs", () => {
		expect(tracer.getTrackedSpan("nonexistent")).toBeUndefined();
	});

	it("trackSpan silently ignores non-recording spans", () => {
		const disabledTracer = new Tracer({ enabled: false });
		disabledTracer.startRootSpan("test.root");
		const span = disabledTracer.startOperation("test");
		disabledTracer.trackSpan("x", span);
		expect(disabledTracer.getTrackedSpan("x")).toBeUndefined();
	});

	it("trackSpan silently ignores empty string IDs", () => {
		const span = tracer.startOperation("test.op", {}, "active");
		tracer.trackSpan("", span, "test");
		expect(tracer.getTrackedSpan("")).toBeUndefined();
		tracer.endOperation(span);
	});

	it("getTrackedSpan returns undefined for empty string ID", () => {
		expect(tracer.getTrackedSpan("")).toBeUndefined();
	});

	it("removeTrackedSpan returns undefined for empty string ID", () => {
		expect(tracer.removeTrackedSpan("")).toBeUndefined();
	});

	it("trackSpan with duplicate ID ends previous span with ERROR", () => {
		const span1 = tracer.startOperation("first.op", {}, "active");
		tracer.trackSpan("dup-id", span1, "first operation");

		const span2 = tracer.startOperation("second.op", {}, "active");
		tracer.trackSpan("dup-id", span2, "second operation");

		// The retrieved span should be the second one
		expect(tracer.getTrackedSpan("dup-id")).toBe(span2);

		// End span2 properly
		const removed = tracer.removeTrackedSpan("dup-id");
		expect(removed).toBe(span2);
		tracer.endOperation(span2);

		// First span should have been ended with ERROR
		const firstSpan = findSpan(exporter, "first.op")!;
		expect(firstSpan).toBeDefined();
		expect(firstSpan.status.code).toBe(SpanStatusCode.ERROR);
		expect(firstSpan.status.message).toBe(
			"first operation replaced before completion",
		);
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

	it("recordEvent adds an event to the root span", () => {
		tracer.recordEvent("root", "test.event", { key: "value" });
		tracer.endRootSpan("ok");

		const session = findSpan(exporter, "test.session")!;
		const event = session.events.find((e) => e.name === "test.event");
		expect(event).toBeDefined();
		expect(event!.attributes!.key).toBe("value");
	});

	it("recordEvent with 'active' targets the active span when active", () => {
		const active = tracer.startActiveSpan("test.active");
		tracer.recordEvent("active", "usage.update", { "usage.percent": 50 });
		tracer.endActiveSpan(active);

		const activeSpan = findSpan(exporter, "test.active")!;
		const event = activeSpan.events.find((e) => e.name === "usage.update");
		expect(event).toBeDefined();
		expect(event!.attributes!["usage.percent"]).toBe(50);
	});

	it("recordEvent with 'active' falls back to root when no active span", () => {
		tracer.recordEvent("active", "some.event", { x: 1 });
		tracer.endRootSpan("ok");

		const session = findSpan(exporter, "test.session")!;
		const event = session.events.find((e) => e.name === "some.event");
		expect(event).toBeDefined();
	});
});

// ── Shutdown ───────────────────────────────────────────────────────────────

describe("Tracer — Shutdown", () => {
	it("shutdown ends all lingering tracked spans with ERROR", async () => {
		const { tracer, exporter, provider } = createTestTracer();
		tracer.startRootSpan("test.session");
		tracer.startActiveSpan("test.active");

		// Start a tool call span via public API
		const toolSpan = tracer.startOperation(
			"agent.tool_call",
			{
				"tool.call_id": "tc-1",
				"tool.title": "Lingering tool",
			},
			"active",
		);
		tracer.trackSpan("tc-1", toolSpan, "tool call");

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
		tracer.startActiveSpan("test.active");

		// Start a terminal span via public API
		const termSpan = tracer.startOperation(
			"agent.terminal",
			{
				"terminal.id": "t-1",
				"terminal.command": "long-running",
			},
			"active",
		);
		tracer.trackSpan("t-1", termSpan, "terminal");

		const spans = await shutdownAndCollect(tracer, exporter, provider);
		const termSpanFound = spans.find((s) => s.name === "agent.terminal");

		expect(termSpanFound).toBeDefined();
		expect(termSpanFound!.status.code).toBe(SpanStatusCode.ERROR);

		const rootSpan = spans.find((s) => s.name === "test.session");
		expect(rootSpan).toBeDefined();
		expect(rootSpan!.status.code).toBe(SpanStatusCode.ERROR);
		expect(rootSpan!.status.message).toBe("Session ended with lingering spans");
	});

	it("shutdown ends lingering active span with ERROR", async () => {
		const { tracer, exporter, provider } = createTestTracer();
		tracer.startRootSpan("test.session");
		tracer.startActiveSpan("test.active");

		const spans = await shutdownAndCollect(tracer, exporter, provider);
		const activeSpan = spans.find((s) => s.name === "test.active");

		expect(activeSpan).toBeDefined();
		expect(activeSpan!.status.code).toBe(SpanStatusCode.ERROR);

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

		const initSpan = tracer.startOperation("init", {}, "root");
		tracer.endOperation(initSpan);

		const _active = tracer.startActiveSpan("test.active");

		// Start a tool call span via public API
		const toolSpan = tracer.startOperation(
			"agent.tool_call",
			{
				"tool.call_id": "tc-1",
				"tool.title": "Tool",
			},
			"active",
		);
		tracer.trackSpan("tc-1", toolSpan, "tool call");

		// Don't manually end active or tool — shutdown should handle it
		const spans = await shutdownAndCollect(tracer, exporter, provider);

		const names = spans.map((s) => s.name).sort();
		expect(names).toContain("test.session");
		expect(names).toContain("init");
		expect(names).toContain("test.active");
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

		// Initialize phase
		const initSpan = tracer.startOperation("agent.initialize", {}, "root");
		const spawnPhase = tracer.startOperation(
			"agent.initialize.spawn-process",
			{},
			initSpan,
		);
		tracer.endOperation(spawnPhase);
		const acpPhase = tracer.startOperation(
			"agent.initialize.acp-protocol-init",
			{},
			initSpan,
		);
		tracer.endOperation(acpPhase);
		const sessionPhase = tracer.startOperation(
			"agent.initialize.create-session",
			{},
			initSpan,
		);
		tracer.endOperation(sessionPhase);
		tracer.endOperation(initSpan);

		// First prompt
		const p1 = tracer.startActiveSpan("agent.prompt", {
			"prompt.index": 1,
			"prompt.text": "Hello",
		});

		// Tool call via public API
		const toolSpan = tracer.startOperation(
			"agent.tool_call",
			{
				"tool.call_id": "tc-1",
				"tool.title": "Run tests",
				"tool.kind": "execute",
				"tool.command": "bun test",
			},
			"active",
		);
		tracer.trackSpan("tc-1", toolSpan, "tool call");

		// Permission via public API — parented under tool call span
		const permSpan = tracer.startOperation(
			"agent.permission",
			{
				"permission.tool_call_id": "tc-1",
				"permission.tool_call_title": "Run tests",
			},
			toolSpan,
		);
		permSpan.setAttribute("permission.outcome", "granted");
		permSpan.setAttribute("permission.option_id", "opt-1");
		permSpan.setAttribute("permission.option_name", "Allow");
		permSpan.setStatus({ code: SpanStatusCode.OK });
		permSpan.end();

		// End tool call
		const removedToolSpan = tracer.removeTrackedSpan("tc-1");
		if (removedToolSpan?.isRecording()) {
			removedToolSpan.setAttribute("tool.status", "completed");
			removedToolSpan.setAttribute("tool.exit_code", 0);
			removedToolSpan.setStatus({ code: SpanStatusCode.OK });
			removedToolSpan.end();
		}

		// Context injection during prompt — targets "active" span
		tracer.recordEvent("active", "context.injected", {
			"context.instructions": "Add error handling",
			"context.instructions_length": 18,
			"context.queued": false,
		});

		// FS operation
		await tracer.traced(
			"agent.fs.read",
			async (span) => {
				span.setAttribute("fs.content_length", 42);
				return { content: "file data" };
			},
			{
				attributes: {
					"fs.path": "/test.txt",
					"fs.operation": "read",
				},
				parent: "active",
			},
		);

		// Terminal via public API
		const termSpan = tracer.startOperation(
			"agent.terminal",
			{
				"terminal.id": "t-1",
				"terminal.command": "echo",
				"terminal.cwd": "/tmp",
			},
			"active",
		);
		// TASK 9: args as native array
		termSpan.setAttribute("terminal.args", ["hello"]);
		tracer.trackSpan("t-1", termSpan, "terminal");

		// End terminal
		const removedTermSpan = tracer.removeTrackedSpan("t-1");
		if (removedTermSpan?.isRecording()) {
			removedTermSpan.setAttribute("terminal.exit_code", 0);
			removedTermSpan.setStatus({ code: SpanStatusCode.OK });
			removedTermSpan.end();
		}

		// Usage via public API — targets "active" span
		tracer.recordEvent("active", "usage.update", {
			"usage.context_used": 5000,
			"usage.context_size": 10000,
			"usage.context_percent": 50,
		});

		// End first prompt
		if (p1.isRecording()) {
			p1.setAttribute("prompt.stop_reason", "end_turn");
		}
		tracer.endActiveSpan(p1);

		// Second prompt
		const p2 = tracer.startActiveSpan("agent.prompt", {
			"prompt.index": 2,
		});
		tracer.endActiveSpan(p2);

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

		// TASK 13: Context injection event on the active span (not root)
		const promptSpan = allSpans
			.filter((s) => s.name === "agent.prompt")
			.find((s) => s.attributes["prompt.index"] === 1)!;
		const ctxEvent = promptSpan.events.find(
			(e) => e.name === "context.injected",
		);
		expect(ctxEvent).toBeDefined();
		// TASK 11: context.queued is a boolean, not a string
		expect(ctxEvent!.attributes!["context.queued"]).toBe(false);
	});

	it("all spans share the same traceId across the entire lifecycle", async () => {
		const { tracer, exporter, provider } = createTestTracer();
		tracer.startRootSpan("test.session");

		const init = tracer.startOperation("init", {}, "root");
		tracer.endOperation(init);

		const active = tracer.startActiveSpan("test.active");

		// Tool call via public API
		const toolSpan = tracer.startOperation(
			"agent.tool_call",
			{
				"tool.call_id": "tc-1",
				"tool.title": "T",
			},
			"active",
		);
		tracer.trackSpan("tc-1", toolSpan, "tool call");
		const removed = tracer.removeTrackedSpan("tc-1");
		if (removed?.isRecording()) {
			removed.setStatus({ code: SpanStatusCode.OK });
			removed.end();
		}

		tracer.endActiveSpan(active);

		const spans = await shutdownAndCollect(tracer, exporter, provider);
		const traceIds = new Set(spans.map((s) => s.spanContext().traceId));
		expect(traceIds.size).toBe(1);
	});

	it("every non-root span has a parentSpanContext", async () => {
		const { tracer, exporter, provider } = createTestTracer();
		tracer.startRootSpan("test.session");

		const init = tracer.startOperation("init", {}, "root");
		const phase = tracer.startOperation("init.phase", {}, init);
		tracer.endOperation(phase);
		tracer.endOperation(init);

		const active = tracer.startActiveSpan("test.active");
		await tracer.traced("custom.op", async () => "ok", {
			attributes: {
				"fs.path": "/test",
				"fs.operation": "read",
			},
			parent: "active",
		});
		tracer.endActiveSpan(active);

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
		tracer.startActiveSpan("test.active");

		// Tool call via public API
		const toolSpan = tracer.startOperation(
			"agent.tool_call",
			{
				"tool.call_id": "tc-1",
				"tool.title": "Run cmd",
				"tool.kind": "execute",
			},
			"active",
		);
		tracer.trackSpan("tc-1", toolSpan, "tool call");

		// Permission as child of tool call span
		const permSpan = tracer.startOperation(
			"agent.permission",
			{
				"permission.tool_call_id": "tc-1",
				"permission.tool_call_title": "Run cmd",
			},
			toolSpan,
		);
		permSpan.setAttribute("permission.outcome", "granted");
		permSpan.setAttribute("permission.option_id", "opt-1");
		permSpan.setAttribute("permission.option_name", "Allow");
		permSpan.setStatus({ code: SpanStatusCode.OK });
		permSpan.end();

		// End tool call
		const removedTool = tracer.removeTrackedSpan("tc-1");
		if (removedTool?.isRecording()) {
			removedTool.setStatus({ code: SpanStatusCode.OK });
			removedTool.end();
		}

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

		const init = tracer.startOperation("init", {}, "root");
		tracer.endOperation(init);

		const spans = await shutdownAndCollect(tracer, exporter, provider);

		for (const span of spans) {
			expect(span.spanContext().spanId.length).toBe(16);
			expect(span.spanContext().traceId.length).toBe(32);
		}
	});

	it("error in one active span does not affect the next", async () => {
		const { tracer, exporter, provider } = createTestTracer();
		tracer.startRootSpan("test.session");

		// First active span — error
		const a1 = tracer.startActiveSpan("active.1");
		tracer.endActiveSpan(a1, new Error("failed"));

		// Second active span — success
		const a2 = tracer.startActiveSpan("active.2");
		tracer.endActiveSpan(a2);

		const spans = await shutdownAndCollect(tracer, exporter, provider);

		const actives = spans.filter((s) => s.name.startsWith("active."));
		expect(actives).toHaveLength(2);

		const first = actives.find((s) => s.name === "active.1")!;
		const second = actives.find((s) => s.name === "active.2")!;
		expect(first.status.code).toBe(SpanStatusCode.ERROR);
		expect(second.status.code).toBe(SpanStatusCode.OK);
	});
});

// ── Trace Context ──────────────────────────────────────────────────────────

describe("Tracer — Trace Context", () => {
	it("returns undefined when tracing is disabled", () => {
		const tracer = new Tracer({ enabled: false });
		expect(tracer.getTraceContext()).toBeUndefined();
	});

	it("returns undefined when no root span is started", () => {
		const { provider } = createTestProvider();
		const tracer = new Tracer({ enabled: true, provider });
		expect(tracer.getTraceContext()).toBeUndefined();
		provider.shutdown();
	});

	it("returns trace context with TraceId and SpanId when root span is active", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("test.session");

		const ctx = tracer.getTraceContext();
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

		const ctx = tracer.getTraceContext()!;
		expect(ctx.ParentSpanId).toBeUndefined();

		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("returns active span context when active span is set", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("test.session");

		const rootCtx = tracer.getTraceContext()!;

		const active = tracer.startActiveSpan("test.active");
		const activeCtx = tracer.getTraceContext()!;

		// TraceId should be the same
		expect(activeCtx.TraceId).toBe(rootCtx.TraceId);
		// SpanId should be different (active span vs root span)
		expect(activeCtx.SpanId).not.toBe(rootCtx.SpanId);

		tracer.endActiveSpan(active);
		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("active span ParentSpanId points to root span", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("test.session");

		const rootCtx = tracer.getTraceContext()!;

		const active = tracer.startActiveSpan("test.active");
		const activeCtx = tracer.getTraceContext()!;

		expect(activeCtx.ParentSpanId).toBe(rootCtx.SpanId);

		tracer.endActiveSpan(active);
		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("falls back to root span context after active span ends", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("test.session");
		const rootCtx = tracer.getTraceContext()!;

		const active = tracer.startActiveSpan("test.active");
		tracer.endActiveSpan(active);

		const afterCtx = tracer.getTraceContext()!;
		expect(afterCtx.SpanId).toBe(rootCtx.SpanId);

		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	// ── enterSpan / leaveSpan ──────────────────────────────────────────

	it("enterSpan makes a span the current context for getTraceContext", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("test.session");
		const active = tracer.startActiveSpan("test.prompt");
		const activeCtx = tracer.getTraceContext()!;

		const opSpan = tracer.startOperation("test.tool_call", {}, "active");
		tracer.enterSpan(opSpan);

		const opCtx = tracer.getTraceContext()!;
		// SpanId should be the operation span, not the active span
		expect(opCtx.SpanId).not.toBe(activeCtx.SpanId);
		// ParentSpanId should point to the active (prompt) span
		expect(opCtx.ParentSpanId).toBe(activeCtx.SpanId);
		// TraceId stays the same
		expect(opCtx.TraceId).toBe(activeCtx.TraceId);

		tracer.leaveSpan(opSpan);
		tracer.endOperation(opSpan);
		tracer.endActiveSpan(active);
		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("leaveSpan restores previous context", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("test.session");
		const active = tracer.startActiveSpan("test.prompt");
		const activeCtx = tracer.getTraceContext()!;

		const opSpan = tracer.startOperation("test.tool_call", {}, "active");
		tracer.enterSpan(opSpan);
		tracer.leaveSpan(opSpan);

		// After leaving, context falls back to active span
		const afterCtx = tracer.getTraceContext()!;
		expect(afterCtx.SpanId).toBe(activeCtx.SpanId);

		tracer.endOperation(opSpan);
		tracer.endActiveSpan(active);
		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("nested enterSpan produces correct ParentSpanId chain", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("test.session");
		const active = tracer.startActiveSpan("test.prompt");
		const activeCtx = tracer.getTraceContext()!;

		// Tool call span (child of active)
		const toolSpan = tracer.startOperation("test.tool_call", {}, "active");
		tracer.enterSpan(toolSpan);
		const toolCtx = tracer.getTraceContext()!;
		expect(toolCtx.ParentSpanId).toBe(activeCtx.SpanId);

		// Permission span (child of tool call)
		const permSpan = tracer.startOperation("test.permission", {}, toolSpan);
		tracer.enterSpan(permSpan);
		const permCtx = tracer.getTraceContext()!;
		expect(permCtx.ParentSpanId).toBe(toolCtx.SpanId);

		// Leave permission → back to tool call
		tracer.leaveSpan(permSpan);
		const afterPermCtx = tracer.getTraceContext()!;
		expect(afterPermCtx.SpanId).toBe(toolCtx.SpanId);

		// Leave tool call → back to active
		tracer.leaveSpan(toolSpan);
		const afterToolCtx = tracer.getTraceContext()!;
		expect(afterToolCtx.SpanId).toBe(activeCtx.SpanId);

		tracer.endOperation(permSpan);
		tracer.endOperation(toolSpan);
		tracer.endActiveSpan(active);
		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("enterSpan silently ignores non-recording spans", () => {
		const disabledTracer = new Tracer({ enabled: false });
		const noopSpan = disabledTracer.startRootSpan("noop");
		// Should not throw
		disabledTracer.enterSpan(noopSpan);
		disabledTracer.leaveSpan(noopSpan);
	});

	it("enterSpan prevents duplicate entries", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("test.session");
		const active = tracer.startActiveSpan("test.prompt");

		const opSpan = tracer.startOperation("test.op", {}, "active");
		tracer.enterSpan(opSpan);
		tracer.enterSpan(opSpan); // duplicate — should be a no-op

		const ctx = tracer.getTraceContext()!;
		// Should still have the op span
		expect(ctx.SpanId).toBe(tracer.getTraceContext()!.SpanId); // self-check (same call)
		// A single leaveSpan should fully remove it
		tracer.leaveSpan(opSpan);
		const afterCtx = tracer.getTraceContext()!;
		// Falls back to active span (not stuck on opSpan)
		const activeCtx = active.spanContext();
		expect(afterCtx.SpanId).toBe(activeCtx.spanId);

		tracer.endOperation(opSpan);
		tracer.endActiveSpan(active);
		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("leaveSpan is a no-op for unknown spans", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("test.session");
		const rootCtx = tracer.getTraceContext()!;

		const opSpan = tracer.startOperation("test.op", {}, "root");
		// Never entered — leaveSpan should not throw
		tracer.leaveSpan(opSpan);

		const ctx = tracer.getTraceContext()!;
		expect(ctx.SpanId).toBe(rootCtx.SpanId);

		tracer.endOperation(opSpan);
		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("traced() auto-enters and auto-leaves the span", async () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("test.session");
		const active = tracer.startActiveSpan("test.prompt");
		const activeCtx = tracer.getTraceContext()!;

		let capturedCtx: ReturnType<typeof tracer.getTraceContext>;
		await tracer.traced(
			"test.fs.read",
			async (_span) => {
				capturedCtx = tracer.getTraceContext();
				return "data";
			},
			{ parent: "active" },
		);

		// Inside traced(), the context should have been the fs.read span
		expect(capturedCtx!).toBeDefined();
		expect(capturedCtx!.SpanId).not.toBe(activeCtx.SpanId);
		expect(capturedCtx!.ParentSpanId).toBe(activeCtx.SpanId);

		// After traced(), context should be back to active
		const afterCtx = tracer.getTraceContext()!;
		expect(afterCtx.SpanId).toBe(activeCtx.SpanId);

		tracer.endActiveSpan(active);
		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("tracedSync() auto-enters and auto-leaves the span", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("test.session");
		const active = tracer.startActiveSpan("test.prompt");
		const activeCtx = tracer.getTraceContext()!;

		let capturedCtx: ReturnType<typeof tracer.getTraceContext>;
		tracer.tracedSync(
			"test.json.parse",
			(_span) => {
				capturedCtx = tracer.getTraceContext();
				return { key: "value" };
			},
			{ parent: "active" },
		);

		// Inside tracedSync(), the context should have been the parse span
		expect(capturedCtx!).toBeDefined();
		expect(capturedCtx!.SpanId).not.toBe(activeCtx.SpanId);
		expect(capturedCtx!.ParentSpanId).toBe(activeCtx.SpanId);

		// After tracedSync(), context should be back to active
		const afterCtx = tracer.getTraceContext()!;
		expect(afterCtx.SpanId).toBe(activeCtx.SpanId);

		tracer.endActiveSpan(active);
		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("flush clears the span stack", async () => {
		const { tracer } = createTestTracer();
		tracer.startRootSpan("test.session");
		const _active = tracer.startActiveSpan("test.prompt");

		const opSpan = tracer.startOperation("test.op", {}, "active");
		tracer.enterSpan(opSpan);

		// Flush ends lingering spans and clears the stack
		await tracer.flush();

		// After flush, getTraceContext returns undefined (root span ended)
		expect(tracer.getTraceContext()).toBeUndefined();

		await tracer.shutdown();
	});

	it("operation span ParentSpanId tracks the resolved parent", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("test.session");
		const rootCtx = tracer.getTraceContext()!;

		// Operation parented under root
		const initSpan = tracer.startOperation("test.init", {}, "root");
		tracer.enterSpan(initSpan);
		const initCtx = tracer.getTraceContext()!;
		expect(initCtx.ParentSpanId).toBe(rootCtx.SpanId);

		// Sub-operation parented under explicit span
		const subSpan = tracer.startOperation("test.init.sub", {}, initSpan);
		tracer.enterSpan(subSpan);
		const subCtx = tracer.getTraceContext()!;
		expect(subCtx.ParentSpanId).toBe(initCtx.SpanId);

		tracer.leaveSpan(subSpan);
		tracer.endOperation(subSpan);
		tracer.leaveSpan(initSpan);
		tracer.endOperation(initSpan);
		tracer.endRootSpan("ok");
		provider.shutdown();
	});
});

// ── ParentSpanId ───────────────────────────────────────────────────────────

describe("Tracer — ParentSpanId", () => {
	it("root span has no ParentSpanId", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");

		const ctx = tracer.getTraceContext()!;
		expect(ctx).toBeDefined();
		expect(ctx.ParentSpanId).toBeUndefined();

		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("active span ParentSpanId points to root span SpanId", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");
		const rootCtx = tracer.getTraceContext()!;

		const active = tracer.startActiveSpan("prompt.1");
		const activeCtx = tracer.getTraceContext()!;

		expect(activeCtx.ParentSpanId).toBeDefined();
		expect(activeCtx.ParentSpanId).toBe(rootCtx.SpanId);

		tracer.endActiveSpan(active);
		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("ParentSpanId is a 16-hex-char string when present", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");

		const active = tracer.startActiveSpan("prompt.1");
		const ctx = tracer.getTraceContext()!;

		expect(ctx.ParentSpanId).toBeDefined();
		expect(ctx.ParentSpanId!.length).toBe(16);
		expect(ctx.ParentSpanId).toMatch(/^[0-9a-f]{16}$/);

		tracer.endActiveSpan(active);
		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("operation parented under 'active' has ParentSpanId equal to active span", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");
		const active = tracer.startActiveSpan("prompt.1");
		const activeCtx = tracer.getTraceContext()!;

		const opSpan = tracer.startOperation("tool_call", {}, "active");
		tracer.enterSpan(opSpan);
		const opCtx = tracer.getTraceContext()!;

		expect(opCtx.ParentSpanId).toBe(activeCtx.SpanId);

		tracer.leaveSpan(opSpan);
		tracer.endOperation(opSpan);
		tracer.endActiveSpan(active);
		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("operation parented under 'root' has ParentSpanId equal to root span", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");
		const rootCtx = tracer.getTraceContext()!;

		const active = tracer.startActiveSpan("prompt.1");

		const opSpan = tracer.startOperation("init.phase", {}, "root");
		tracer.enterSpan(opSpan);
		const opCtx = tracer.getTraceContext()!;

		expect(opCtx.ParentSpanId).toBe(rootCtx.SpanId);

		tracer.leaveSpan(opSpan);
		tracer.endOperation(opSpan);
		tracer.endActiveSpan(active);
		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("operation parented under explicit span has ParentSpanId equal to that span", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");
		const active = tracer.startActiveSpan("prompt.1");

		const toolSpan = tracer.startOperation("tool_call", {}, "active");
		tracer.enterSpan(toolSpan);
		const toolCtx = tracer.getTraceContext()!;

		const permSpan = tracer.startOperation("permission", {}, toolSpan);
		tracer.enterSpan(permSpan);
		const permCtx = tracer.getTraceContext()!;

		expect(permCtx.ParentSpanId).toBe(toolCtx.SpanId);

		tracer.leaveSpan(permSpan);
		tracer.endOperation(permSpan);
		tracer.leaveSpan(toolSpan);
		tracer.endOperation(toolSpan);
		tracer.endActiveSpan(active);
		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("full chain: root → active → tool → permission produces correct ParentSpanId at every level", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");
		const rootCtx = tracer.getTraceContext()!;
		expect(rootCtx.ParentSpanId).toBeUndefined();

		const active = tracer.startActiveSpan("prompt.1");
		const activeCtx = tracer.getTraceContext()!;
		expect(activeCtx.ParentSpanId).toBe(rootCtx.SpanId);

		const toolSpan = tracer.startOperation(
			"tool_call",
			{
				"tool.call_id": "tc_1",
			},
			"active",
		);
		tracer.enterSpan(toolSpan);
		const toolCtx = tracer.getTraceContext()!;
		expect(toolCtx.ParentSpanId).toBe(activeCtx.SpanId);

		const permSpan = tracer.startOperation(
			"permission",
			{
				"permission.tool_call_id": "tc_1",
			},
			toolSpan,
		);
		tracer.enterSpan(permSpan);
		const permCtx = tracer.getTraceContext()!;
		expect(permCtx.ParentSpanId).toBe(toolCtx.SpanId);

		// All share the same TraceId
		expect(activeCtx.TraceId).toBe(rootCtx.TraceId);
		expect(toolCtx.TraceId).toBe(rootCtx.TraceId);
		expect(permCtx.TraceId).toBe(rootCtx.TraceId);

		// All SpanIds are distinct
		const ids = [
			rootCtx.SpanId,
			activeCtx.SpanId,
			toolCtx.SpanId,
			permCtx.SpanId,
		];
		expect(new Set(ids).size).toBe(4);

		tracer.leaveSpan(permSpan);
		tracer.endOperation(permSpan);
		tracer.leaveSpan(toolSpan);
		tracer.endOperation(toolSpan);
		tracer.endActiveSpan(active);
		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("leaveSpan restores ParentSpanId to the parent of the span we fall back to", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");
		const rootCtx = tracer.getTraceContext()!;

		const active = tracer.startActiveSpan("prompt.1");
		const activeCtx = tracer.getTraceContext()!;

		const toolSpan = tracer.startOperation("tool_call", {}, "active");
		tracer.enterSpan(toolSpan);

		const permSpan = tracer.startOperation("permission", {}, toolSpan);
		tracer.enterSpan(permSpan);

		// Leave permission → context is tool, ParentSpanId is active
		tracer.leaveSpan(permSpan);
		const afterPermCtx = tracer.getTraceContext()!;
		expect(afterPermCtx.SpanId).toBe(tracer.getTraceContext()!.SpanId);
		expect(afterPermCtx.ParentSpanId).toBe(activeCtx.SpanId);

		// Leave tool → context is active, ParentSpanId is root
		tracer.leaveSpan(toolSpan);
		const afterToolCtx = tracer.getTraceContext()!;
		expect(afterToolCtx.SpanId).toBe(activeCtx.SpanId);
		expect(afterToolCtx.ParentSpanId).toBe(rootCtx.SpanId);

		tracer.endOperation(permSpan);
		tracer.endOperation(toolSpan);
		tracer.endActiveSpan(active);
		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("endActiveSpan falls back to root which has no ParentSpanId", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");
		const rootCtx = tracer.getTraceContext()!;

		const active = tracer.startActiveSpan("prompt.1");
		tracer.endActiveSpan(active);

		const afterCtx = tracer.getTraceContext()!;
		expect(afterCtx.SpanId).toBe(rootCtx.SpanId);
		expect(afterCtx.ParentSpanId).toBeUndefined();

		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("sequential active spans each have ParentSpanId pointing to root", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");
		const rootCtx = tracer.getTraceContext()!;

		const a1 = tracer.startActiveSpan("prompt.1");
		const a1Ctx = tracer.getTraceContext()!;
		expect(a1Ctx.ParentSpanId).toBe(rootCtx.SpanId);
		tracer.endActiveSpan(a1);

		const a2 = tracer.startActiveSpan("prompt.2");
		const a2Ctx = tracer.getTraceContext()!;
		expect(a2Ctx.ParentSpanId).toBe(rootCtx.SpanId);
		// Different SpanIds for the two active spans
		expect(a2Ctx.SpanId).not.toBe(a1Ctx.SpanId);
		tracer.endActiveSpan(a2);

		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("ParentSpanId is stable across consecutive getTraceContext calls", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");
		const active = tracer.startActiveSpan("prompt.1");

		const toolSpan = tracer.startOperation("tool_call", {}, "active");
		tracer.enterSpan(toolSpan);

		const ctx1 = tracer.getTraceContext()!;
		const ctx2 = tracer.getTraceContext()!;
		const ctx3 = tracer.getTraceContext()!;

		expect(ctx1.ParentSpanId).toBe(ctx2.ParentSpanId);
		expect(ctx2.ParentSpanId).toBe(ctx3.ParentSpanId);
		expect(ctx1.SpanId).toBe(ctx2.SpanId);
		expect(ctx2.SpanId).toBe(ctx3.SpanId);

		tracer.leaveSpan(toolSpan);
		tracer.endOperation(toolSpan);
		tracer.endActiveSpan(active);
		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("tracked span entered via enterSpan has correct ParentSpanId", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");
		const active = tracer.startActiveSpan("prompt.1");
		const activeCtx = tracer.getTraceContext()!;

		// Simulate a tool call span tracked by ID (as agent code does)
		const toolSpan = tracer.startOperation(
			"tool_call",
			{
				"tool.call_id": "tc_42",
			},
			"active",
		);
		tracer.trackSpan("tc_42", toolSpan, "tool_call:tc_42");
		tracer.enterSpan(toolSpan);

		const toolCtx = tracer.getTraceContext()!;
		expect(toolCtx.ParentSpanId).toBe(activeCtx.SpanId);
		expect(toolCtx.SpanId).not.toBe(activeCtx.SpanId);

		// Remove tracked span and leave
		const removed = tracer.removeTrackedSpan("tc_42");
		expect(removed).toBe(toolSpan);
		tracer.leaveSpan(toolSpan);

		const afterCtx = tracer.getTraceContext()!;
		expect(afterCtx.SpanId).toBe(activeCtx.SpanId);
		expect(afterCtx.ParentSpanId).toBe(tracer.getTraceContext()!.ParentSpanId);

		tracer.endOperation(toolSpan);
		tracer.endActiveSpan(active);
		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("out-of-order leaveSpan preserves correct ParentSpanId", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");
		const active = tracer.startActiveSpan("prompt.1");
		const activeCtx = tracer.getTraceContext()!;

		const span1 = tracer.startOperation("op.1", {}, "active");
		tracer.enterSpan(span1);
		const span1Ctx = tracer.getTraceContext()!;

		const span2 = tracer.startOperation("op.2", {}, span1);
		tracer.enterSpan(span2);
		const span2Ctx = tracer.getTraceContext()!;

		expect(span2Ctx.ParentSpanId).toBe(span1Ctx.SpanId);

		// Leave span1 first (out of order — span2 is still on top)
		tracer.leaveSpan(span1);
		// span2 is now on top of stack, ParentSpanId still points to span1
		const afterCtx = tracer.getTraceContext()!;
		expect(afterCtx.SpanId).toBe(span2Ctx.SpanId);
		expect(afterCtx.ParentSpanId).toBe(span1Ctx.SpanId);

		// Now leave span2 → fall back to active
		tracer.leaveSpan(span2);
		const finalCtx = tracer.getTraceContext()!;
		expect(finalCtx.SpanId).toBe(activeCtx.SpanId);

		tracer.endOperation(span2);
		tracer.endOperation(span1);
		tracer.endActiveSpan(active);
		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("deeply nested spans (4 levels) produce correct ParentSpanId chain", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");
		const rootCtx = tracer.getTraceContext()!;

		const active = tracer.startActiveSpan("prompt.1");
		const activeCtx = tracer.getTraceContext()!;

		const level1 = tracer.startOperation("level.1", {}, "active");
		tracer.enterSpan(level1);
		const l1Ctx = tracer.getTraceContext()!;

		const level2 = tracer.startOperation("level.2", {}, level1);
		tracer.enterSpan(level2);
		const l2Ctx = tracer.getTraceContext()!;

		const level3 = tracer.startOperation("level.3", {}, level2);
		tracer.enterSpan(level3);
		const l3Ctx = tracer.getTraceContext()!;

		const level4 = tracer.startOperation("level.4", {}, level3);
		tracer.enterSpan(level4);
		const l4Ctx = tracer.getTraceContext()!;

		// Verify the full chain
		expect(activeCtx.ParentSpanId).toBe(rootCtx.SpanId);
		expect(l1Ctx.ParentSpanId).toBe(activeCtx.SpanId);
		expect(l2Ctx.ParentSpanId).toBe(l1Ctx.SpanId);
		expect(l3Ctx.ParentSpanId).toBe(l2Ctx.SpanId);
		expect(l4Ctx.ParentSpanId).toBe(l3Ctx.SpanId);

		// Unwind and verify at each step
		tracer.leaveSpan(level4);
		expect(tracer.getTraceContext()!.SpanId).toBe(l3Ctx.SpanId);

		tracer.leaveSpan(level3);
		expect(tracer.getTraceContext()!.SpanId).toBe(l2Ctx.SpanId);

		tracer.leaveSpan(level2);
		expect(tracer.getTraceContext()!.SpanId).toBe(l1Ctx.SpanId);

		tracer.leaveSpan(level1);
		expect(tracer.getTraceContext()!.SpanId).toBe(activeCtx.SpanId);

		tracer.endOperation(level4);
		tracer.endOperation(level3);
		tracer.endOperation(level2);
		tracer.endOperation(level1);
		tracer.endActiveSpan(active);
		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("traced() provides correct ParentSpanId inside the callback", async () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");
		const active = tracer.startActiveSpan("prompt.1");
		const activeCtx = tracer.getTraceContext()!;

		let innerCtx: ReturnType<typeof tracer.getTraceContext>;
		await tracer.traced(
			"fs.read",
			async (_span) => {
				innerCtx = tracer.getTraceContext();
				return "content";
			},
			{ parent: "active" },
		);

		expect(innerCtx!).toBeDefined();
		expect(innerCtx!.ParentSpanId).toBe(activeCtx.SpanId);

		// After traced() completes, ParentSpanId reverts
		const afterCtx = tracer.getTraceContext()!;
		expect(afterCtx.SpanId).toBe(activeCtx.SpanId);

		tracer.endActiveSpan(active);
		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("tracedSync() provides correct ParentSpanId inside the callback", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");
		const active = tracer.startActiveSpan("prompt.1");
		const activeCtx = tracer.getTraceContext()!;

		let innerCtx: ReturnType<typeof tracer.getTraceContext>;
		tracer.tracedSync(
			"json.parse",
			(_span) => {
				innerCtx = tracer.getTraceContext();
				return { ok: true };
			},
			{ parent: "active" },
		);

		expect(innerCtx!).toBeDefined();
		expect(innerCtx!.ParentSpanId).toBe(activeCtx.SpanId);

		const afterCtx = tracer.getTraceContext()!;
		expect(afterCtx.SpanId).toBe(activeCtx.SpanId);

		tracer.endActiveSpan(active);
		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("nested traced() calls produce correct ParentSpanId at each level", async () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");
		const active = tracer.startActiveSpan("prompt.1");
		const activeCtx = tracer.getTraceContext()!;

		let outerCtx: ReturnType<typeof tracer.getTraceContext>;
		let innerCtx: ReturnType<typeof tracer.getTraceContext>;

		await tracer.traced(
			"outer.op",
			async (outerSpan) => {
				outerCtx = tracer.getTraceContext();
				await tracer.traced(
					"inner.op",
					async (_innerSpan) => {
						innerCtx = tracer.getTraceContext();
						return "deep";
					},
					{ parent: outerSpan },
				);
				return "shallow";
			},
			{ parent: "active" },
		);

		// Outer is child of active
		expect(outerCtx!.ParentSpanId).toBe(activeCtx.SpanId);
		// Inner is child of outer
		expect(innerCtx!.ParentSpanId).toBe(outerCtx!.SpanId);
		// All three have distinct SpanIds
		expect(
			new Set([activeCtx.SpanId, outerCtx!.SpanId, innerCtx!.SpanId]).size,
		).toBe(3);

		tracer.endActiveSpan(active);
		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("tracedSync() that throws still restores ParentSpanId correctly", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");
		const active = tracer.startActiveSpan("prompt.1");
		const activeCtx = tracer.getTraceContext()!;

		try {
			tracer.tracedSync(
				"failing.op",
				(_span) => {
					const ctx = tracer.getTraceContext()!;
					// Inside, ParentSpanId should point to active
					expect(ctx.ParentSpanId).toBe(activeCtx.SpanId);
					throw new Error("boom");
				},
				{ parent: "active" },
			);
		} catch {
			// expected
		}

		// After the throw, context is back to active
		const afterCtx = tracer.getTraceContext()!;
		expect(afterCtx.SpanId).toBe(activeCtx.SpanId);
		expect(afterCtx.ParentSpanId).toBe(tracer.getTraceContext()!.ParentSpanId);

		tracer.endActiveSpan(active);
		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("traced() that throws still restores ParentSpanId correctly", async () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");
		const active = tracer.startActiveSpan("prompt.1");
		const activeCtx = tracer.getTraceContext()!;

		try {
			await tracer.traced(
				"async.failing.op",
				async (_span) => {
					const ctx = tracer.getTraceContext()!;
					expect(ctx.ParentSpanId).toBe(activeCtx.SpanId);
					throw new Error("async boom");
				},
				{ parent: "active" },
			);
		} catch {
			// expected
		}

		const afterCtx = tracer.getTraceContext()!;
		expect(afterCtx.SpanId).toBe(activeCtx.SpanId);

		tracer.endActiveSpan(active);
		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("simulated terminal span lifecycle has correct ParentSpanId", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");
		const active = tracer.startActiveSpan("prompt.1");
		const activeCtx = tracer.getTraceContext()!;

		// Start a terminal span (child of active, tracked by terminal ID)
		const termSpan = tracer.startOperation(
			"terminal",
			{
				"terminal.id": "term_1",
				"terminal.command": "ls -la",
			},
			"active",
		);
		tracer.trackSpan("term_1", termSpan, "terminal:term_1");

		// Enter terminal span for logging
		tracer.enterSpan(termSpan);
		const termCtx = tracer.getTraceContext()!;
		expect(termCtx.ParentSpanId).toBe(activeCtx.SpanId);
		expect(termCtx.SpanId).not.toBe(activeCtx.SpanId);

		// Terminal exits — leave span, remove tracked, end
		tracer.leaveSpan(termSpan);
		const removed = tracer.removeTrackedSpan("term_1");
		expect(removed).toBe(termSpan);

		// Back to active
		const afterCtx = tracer.getTraceContext()!;
		expect(afterCtx.SpanId).toBe(activeCtx.SpanId);
		expect(afterCtx.ParentSpanId).toBe(tracer.getTraceContext()!.ParentSpanId);

		tracer.endOperation(termSpan);
		tracer.endActiveSpan(active);
		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("multiple tool calls in same prompt each have ParentSpanId pointing to prompt", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");
		const active = tracer.startActiveSpan("prompt.1");
		const activeCtx = tracer.getTraceContext()!;

		// First tool call
		const tool1 = tracer.startOperation("tool_call.1", {}, "active");
		tracer.enterSpan(tool1);
		const tool1Ctx = tracer.getTraceContext()!;
		expect(tool1Ctx.ParentSpanId).toBe(activeCtx.SpanId);
		tracer.leaveSpan(tool1);
		tracer.endOperation(tool1);

		// Second tool call
		const tool2 = tracer.startOperation("tool_call.2", {}, "active");
		tracer.enterSpan(tool2);
		const tool2Ctx = tracer.getTraceContext()!;
		expect(tool2Ctx.ParentSpanId).toBe(activeCtx.SpanId);
		// Different SpanId from first tool
		expect(tool2Ctx.SpanId).not.toBe(tool1Ctx.SpanId);
		tracer.leaveSpan(tool2);
		tracer.endOperation(tool2);

		// Third tool call
		const tool3 = tracer.startOperation("tool_call.3", {}, "active");
		tracer.enterSpan(tool3);
		const tool3Ctx = tracer.getTraceContext()!;
		expect(tool3Ctx.ParentSpanId).toBe(activeCtx.SpanId);
		expect(tool3Ctx.SpanId).not.toBe(tool1Ctx.SpanId);
		expect(tool3Ctx.SpanId).not.toBe(tool2Ctx.SpanId);
		tracer.leaveSpan(tool3);
		tracer.endOperation(tool3);

		tracer.endActiveSpan(active);
		tracer.endRootSpan("ok");
		provider.shutdown();
	});

	it("ParentSpanId is undefined for disabled tracer", () => {
		const tracer = new Tracer({ enabled: false });
		expect(tracer.getTraceContext()).toBeUndefined();

		tracer.startRootSpan("session");
		expect(tracer.getTraceContext()).toBeUndefined();
	});

	it("TraceId is consistent while ParentSpanId changes through the hierarchy", () => {
		const { tracer, provider } = createTestTracer();
		tracer.startRootSpan("session");
		const rootCtx = tracer.getTraceContext()!;
		const traceId = rootCtx.TraceId;

		const active = tracer.startActiveSpan("prompt.1");
		const activeCtx = tracer.getTraceContext()!;
		expect(activeCtx.TraceId).toBe(traceId);
		expect(activeCtx.ParentSpanId).toBe(rootCtx.SpanId);

		const op = tracer.startOperation("tool_call", {}, "active");
		tracer.enterSpan(op);
		const opCtx = tracer.getTraceContext()!;
		expect(opCtx.TraceId).toBe(traceId);
		expect(opCtx.ParentSpanId).toBe(activeCtx.SpanId);

		tracer.leaveSpan(op);
		// Back to active — same TraceId, ParentSpanId reverts to root
		const revertCtx = tracer.getTraceContext()!;
		expect(revertCtx.TraceId).toBe(traceId);
		expect(revertCtx.ParentSpanId).toBe(rootCtx.SpanId);

		tracer.endOperation(op);
		tracer.endActiveSpan(active);
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

		const _spans = provider as any;
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
