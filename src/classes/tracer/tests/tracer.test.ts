import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SpanStatusCode } from "@opentelemetry/api";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { recordContextInjection } from "../../agent/tracer-helpers/context.ts";
import {
	endPermission,
	startPermission,
} from "../../agent/tracer-helpers/permission.ts";
import {
	endTerminal,
	endTerminalById,
	startTerminal,
} from "../../agent/tracer-helpers/terminal.ts";
import {
	endToolCall,
	startToolCall,
	updateToolCall,
} from "../../agent/tracer-helpers/tool.ts";
import { recordUsage } from "../../agent/tracer-helpers/usage.ts";
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

		// Tool call helpers (external)
		startToolCall(tracer, {
			toolCallId: "tc-1",
			title: "Test tool",
			kind: "execute",
		});
		updateToolCall(tracer, "tc-1", "in_progress", "some output");
		endToolCall(tracer, "tc-1", "completed", 0);

		// Permission helpers (external)
		const perm = startPermission(tracer, {
			toolCallId: "tc-1",
			toolCallTitle: "Test",
		});
		endPermission(perm, "granted", {
			optionId: "opt-1",
			optionName: "Allow",
		});

		// Terminal helpers (external)
		const term = startTerminal(tracer, {
			terminalId: "t-1",
			command: "echo",
			args: ["hello"],
		});
		endTerminal(term, 0);

		// Context + usage helpers (external)
		recordContextInjection(tracer, "some instructions", false);
		recordUsage(tracer, 100, 1000, 10);

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
});

// ── Span Tracking ──────────────────────────────────────────────────────────

describe("Tracer — Span Tracking", () => {
	let tracer: Tracer;
	let provider: BasicTracerProvider;

	beforeEach(() => {
		({ tracer, provider } = createTestTracer());
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

	it("recordEvent with 'auto' targets the active span when active", () => {
		const active = tracer.startActiveSpan("test.active");
		tracer.recordEvent("auto", "usage.update", { "usage.percent": 50 });
		tracer.endActiveSpan(active);

		const activeSpan = findSpan(exporter, "test.active")!;
		const event = activeSpan.events.find((e) => e.name === "usage.update");
		expect(event).toBeDefined();
		expect(event!.attributes!["usage.percent"]).toBe(50);
	});

	it("recordEvent with 'auto' falls back to root when no active span", () => {
		tracer.recordEvent("auto", "some.event", { x: 1 });
		tracer.endRootSpan("ok");

		const session = findSpan(exporter, "test.session")!;
		const event = session.events.find((e) => e.name === "some.event");
		expect(event).toBeDefined();
	});
});

// ── Tool Calls (via helpers) ───────────────────────────────────────────────

describe("Tracer — Tool Calls (agent helpers)", () => {
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

	it("startToolCall creates a span named 'agent.tool_call'", () => {
		startToolCall(tracer, {
			toolCallId: "tc-1",
			title: "Run tests",
			kind: "execute",
			command: "bun test",
		});
		endToolCall(tracer, "tc-1", "completed", 0);

		const found = findSpan(exporter, "agent.tool_call");
		expect(found).toBeDefined();
	});

	it("tool call span carries all attributes", () => {
		startToolCall(tracer, {
			toolCallId: "tc-1",
			title: "Run tests",
			kind: "execute",
			command: "bun test",
		});
		endToolCall(tracer, "tc-1", "completed", 0);

		const found = findSpan(exporter, "agent.tool_call")!;
		expect(attr(found, "tool.call_id")).toBe("tc-1");
		expect(attr(found, "tool.title")).toBe("Run tests");
		expect(attr(found, "tool.kind")).toBe("execute");
		expect(attr(found, "tool.command")).toBe("bun test");
	});

	it("tool call span is a child of the active span", () => {
		startToolCall(tracer, {
			toolCallId: "tc-1",
			title: "Run tests",
		});
		endToolCall(tracer, "tc-1", "completed", 0);

		const toolSpan = findSpan(exporter, "agent.tool_call")!;
		const parent = parentSpanId(toolSpan);
		expect(parent).toBeDefined();
	});

	it("tool call without optional attributes omits them", () => {
		startToolCall(tracer, {
			toolCallId: "tc-1",
			title: "Simple tool",
		});
		endToolCall(tracer, "tc-1", "completed", 0);

		const found = findSpan(exporter, "agent.tool_call")!;
		expect(attr(found, "tool.kind")).toBeUndefined();
		expect(attr(found, "tool.command")).toBeUndefined();
	});

	it("updateToolCall adds an event to the span", () => {
		startToolCall(tracer, {
			toolCallId: "tc-1",
			title: "Run tests",
		});
		updateToolCall(tracer, "tc-1", "in_progress", "Building...", undefined);
		endToolCall(tracer, "tc-1", "completed", 0);

		const found = findSpan(exporter, "agent.tool_call")!;
		const updateEvent = found.events.find((e) => e.name === "tool.update");
		expect(updateEvent).toBeDefined();
		expect(updateEvent!.attributes!.status).toBe("in_progress");
		expect(updateEvent!.attributes!.output).toBe("Building...");
	});

	it("updateToolCall truncates output to 1000 chars", () => {
		startToolCall(tracer, {
			toolCallId: "tc-1",
			title: "Run tests",
		});
		const longOutput = "x".repeat(2000);
		updateToolCall(tracer, "tc-1", "in_progress", longOutput, undefined);
		endToolCall(tracer, "tc-1", "completed", 0);

		const found = findSpan(exporter, "agent.tool_call")!;
		const updateEvent = found.events.find((e) => e.name === "tool.update");
		expect(String(updateEvent!.attributes!.output).length).toBe(1000);
	});

	it("updateToolCall with exit_code records it in the event", () => {
		startToolCall(tracer, {
			toolCallId: "tc-1",
			title: "Run tests",
		});
		updateToolCall(tracer, "tc-1", "in_progress", undefined, 42);
		endToolCall(tracer, "tc-1", "completed", 0);

		const found = findSpan(exporter, "agent.tool_call")!;
		const updateEvent = found.events.find((e) => e.name === "tool.update");
		expect(updateEvent!.attributes!.exit_code).toBe(42);
	});

	it("updateToolCall is a no-op for unknown toolCallId", () => {
		// Should not throw
		updateToolCall(tracer, "nonexistent", "in_progress", "output");
	});

	it("endToolCall with 'completed' and exit 0 sets OK status", () => {
		startToolCall(tracer, {
			toolCallId: "tc-1",
			title: "Run tests",
		});
		endToolCall(tracer, "tc-1", "completed", 0);

		const found = findSpan(exporter, "agent.tool_call")!;
		expect(found.status.code).toBe(SpanStatusCode.OK);
	});

	it("endToolCall with 'failed' sets ERROR status", () => {
		startToolCall(tracer, {
			toolCallId: "tc-1",
			title: "Run tests",
		});
		endToolCall(tracer, "tc-1", "failed", 1);

		const found = findSpan(exporter, "agent.tool_call")!;
		expect(found.status.code).toBe(SpanStatusCode.ERROR);
	});

	it("endToolCall with non-zero exit code sets ERROR even if status is completed", () => {
		startToolCall(tracer, {
			toolCallId: "tc-1",
			title: "Run tests",
		});
		endToolCall(tracer, "tc-1", "completed", 1);

		const found = findSpan(exporter, "agent.tool_call")!;
		expect(found.status.code).toBe(SpanStatusCode.ERROR);
	});

	it("endToolCall removes the span from active tracking", () => {
		startToolCall(tracer, {
			toolCallId: "tc-1",
			title: "Run tests",
		});

		expect(tracer.getTrackedSpan("tc-1")).toBeDefined();
		endToolCall(tracer, "tc-1", "completed", 0);
		expect(tracer.getTrackedSpan("tc-1")).toBeUndefined();
	});

	it("endToolCall is a no-op for unknown toolCallId", () => {
		// Should not throw
		endToolCall(tracer, "nonexistent", "completed", 0);
	});

	it("supports multiple concurrent tool calls", () => {
		startToolCall(tracer, {
			toolCallId: "tc-a",
			title: "Tool A",
			kind: "execute",
		});
		startToolCall(tracer, {
			toolCallId: "tc-b",
			title: "Tool B",
			kind: "edit",
		});

		endToolCall(tracer, "tc-a", "completed", 0);
		endToolCall(tracer, "tc-b", "completed", 0);

		const spans = exporter
			.getFinishedSpans()
			.filter((s) => s.name === "agent.tool_call");
		expect(spans).toHaveLength(2);

		const titles = spans.map((s) => s.attributes["tool.title"]).sort();
		expect(titles).toEqual(["Tool A", "Tool B"]);
	});
});

// ── Permissions (via helpers) ──────────────────────────────────────────────

describe("Tracer — Permissions (agent helpers)", () => {
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

	it("startPermission creates a span named 'agent.permission'", () => {
		const span = startPermission(tracer, {
			toolCallId: "tc-1",
			toolCallTitle: "Run cmd",
		});
		endPermission(span, "granted", {
			optionId: "opt-1",
			optionName: "Allow",
		});

		const found = findSpan(exporter, "agent.permission");
		expect(found).toBeDefined();
	});

	it("permission span carries tool call attributes", () => {
		const span = startPermission(tracer, {
			toolCallId: "tc-1",
			toolCallTitle: "Run cmd",
		});
		endPermission(span, "granted");

		const found = findSpan(exporter, "agent.permission")!;
		expect(attr(found, "permission.tool_call_id")).toBe("tc-1");
		expect(attr(found, "permission.tool_call_title")).toBe("Run cmd");
	});

	it("endPermission with 'granted' sets OK status and outcome attributes", () => {
		const span = startPermission(tracer, {
			toolCallId: "tc-1",
		});
		endPermission(span, "granted", {
			optionId: "opt-1",
			optionName: "Allow once",
		});

		const found = findSpan(exporter, "agent.permission")!;
		expect(found.status.code).toBe(SpanStatusCode.OK);
		expect(attr(found, "permission.outcome")).toBe("granted");
		expect(attr(found, "permission.option_id")).toBe("opt-1");
	});

	it("endPermission with 'denied' sets ERROR status and reason", () => {
		const span = startPermission(tracer, {
			toolCallId: "tc-1",
		});
		endPermission(span, "denied", {
			reason: "User declined",
		});

		const found = findSpan(exporter, "agent.permission")!;
		expect(found.status.code).toBe(SpanStatusCode.ERROR);
		expect(attr(found, "permission.outcome")).toBe("denied");
		expect(attr(found, "permission.denial_reason")).toBe("User declined");
	});

	it("permission span is parented under the tool call span when available", () => {
		startToolCall(tracer, {
			toolCallId: "tc-1",
			title: "Run cmd",
			kind: "execute",
		});

		const permSpan = startPermission(tracer, {
			toolCallId: "tc-1",
			toolCallTitle: "Run cmd",
		});
		endPermission(permSpan, "granted");
		endToolCall(tracer, "tc-1", "completed", 0);

		const toolSpan = findSpan(exporter, "agent.tool_call")!;
		const permReadable = findSpan(exporter, "agent.permission")!;
		const parent = parentSpanId(permReadable);
		expect(parent).toBe(toolSpan.spanContext().spanId);
	});

	it("permission span has a parent even when no tool call matches", () => {
		const permSpan = startPermission(tracer, {
			toolCallId: "nonexistent",
			toolCallTitle: "Unknown",
		});
		endPermission(permSpan, "denied", { reason: "no match" });

		const permReadable = findSpan(exporter, "agent.permission")!;
		const parent = parentSpanId(permReadable);
		// Should be parented under the active span (fallback)
		expect(parent).toBeDefined();
	});
});

// ── Terminal (via helpers) ─────────────────────────────────────────────────

describe("Tracer — Terminal (agent helpers)", () => {
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

	it("startTerminal creates a span named 'agent.terminal'", () => {
		const span = startTerminal(tracer, {
			terminalId: "t-1",
			command: "echo",
			args: ["hello"],
			cwd: "/tmp",
		});
		endTerminal(span, 0);

		const found = findSpan(exporter, "agent.terminal");
		expect(found).toBeDefined();
	});

	it("terminal span carries all attributes", () => {
		const span = startTerminal(tracer, {
			terminalId: "t-1",
			command: "echo",
			args: ["hello", "world"],
			cwd: "/tmp",
		});
		endTerminal(span, 0);

		const found = findSpan(exporter, "agent.terminal")!;
		expect(attr(found, "terminal.id")).toBe("t-1");
		expect(attr(found, "terminal.command")).toBe("echo");
		expect(attr(found, "terminal.args")).toBe("hello world");
		expect(attr(found, "terminal.cwd")).toBe("/tmp");
	});

	it("endTerminal with exit code 0 sets OK status", () => {
		const span = startTerminal(tracer, {
			terminalId: "t-1",
			command: "echo",
		});
		endTerminal(span, 0);

		const found = findSpan(exporter, "agent.terminal")!;
		expect(found.status.code).toBe(SpanStatusCode.OK);
	});

	it("endTerminal with non-zero exit code sets ERROR status", () => {
		const span = startTerminal(tracer, {
			terminalId: "t-1",
			command: "false",
		});
		endTerminal(span, 1);

		const found = findSpan(exporter, "agent.terminal")!;
		expect(found.status.code).toBe(SpanStatusCode.ERROR);
	});

	it("endTerminal with signal records it as an attribute", () => {
		const span = startTerminal(tracer, {
			terminalId: "t-1",
			command: "sleep",
		});
		endTerminal(span, null, "SIGTERM");

		const found = findSpan(exporter, "agent.terminal")!;
		expect(attr(found, "terminal.signal")).toBe("SIGTERM");
	});

	it("endTerminal with null exit code and no signal sets OK status", () => {
		const span = startTerminal(tracer, {
			terminalId: "t-1",
			command: "echo",
		});
		endTerminal(span, null);

		const found = findSpan(exporter, "agent.terminal")!;
		expect(found.status.code).toBe(SpanStatusCode.OK);
	});

	it("terminal span without optional args and cwd omits them", () => {
		const span = startTerminal(tracer, {
			terminalId: "t-1",
			command: "echo",
		});
		endTerminal(span, 0);

		const found = findSpan(exporter, "agent.terminal")!;
		expect(attr(found, "terminal.args")).toBeUndefined();
		expect(attr(found, "terminal.cwd")).toBeUndefined();
	});

	it("endTerminalById ends a terminal span by its ID", () => {
		startTerminal(tracer, {
			terminalId: "t-1",
			command: "echo",
		});

		// End via helper that looks up by ID
		endTerminalById(tracer, "t-1", 0);

		const found = findSpan(exporter, "agent.terminal")!;
		expect(found).toBeDefined();
		expect(found.status.code).toBe(SpanStatusCode.OK);
	});

	it("endTerminalById is a no-op for unknown terminalId", () => {
		// Should not throw
		endTerminalById(tracer, "nonexistent", 0);
	});

	it("endTerminalById with non-zero exit code sets ERROR", () => {
		startTerminal(tracer, {
			terminalId: "t-1",
			command: "false",
		});
		endTerminalById(tracer, "t-1", 1);

		const found = findSpan(exporter, "agent.terminal")!;
		expect(found.status.code).toBe(SpanStatusCode.ERROR);
	});

	it("endTerminalById with signal records it as an attribute", () => {
		startTerminal(tracer, {
			terminalId: "t-1",
			command: "sleep",
		});
		endTerminalById(tracer, "t-1", null, "SIGKILL");

		const found = findSpan(exporter, "agent.terminal")!;
		expect(attr(found, "terminal.signal")).toBe("SIGKILL");
	});
});

// ── Context Injection (via helpers) ────────────────────────────────────────

describe("Tracer — Context Injection (agent helpers)", () => {
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

	it("recordContextInjection adds an event to the root span", () => {
		recordContextInjection(tracer, "Use strict mode", false);
		tracer.endRootSpan("ok");

		const session = findSpan(exporter, "test.session")!;
		const event = session.events.find((e) => e.name === "context.injected");
		expect(event).toBeDefined();
		expect(event!.attributes!["context.instructions"]).toBe("Use strict mode");
		expect(event!.attributes!["context.queued"]).toBe("false");
	});

	it("recordContextInjection records queued=true when instructions are queued", () => {
		recordContextInjection(tracer, "Add validation", true);
		tracer.endRootSpan("ok");

		const session = findSpan(exporter, "test.session")!;
		const event = session.events.find((e) => e.name === "context.injected");
		expect(event!.attributes!["context.queued"]).toBe("true");
	});

	it("recordContextInjection truncates long instructions to 500 chars", () => {
		const longInstructions = "x".repeat(1000);
		recordContextInjection(tracer, longInstructions, false);
		tracer.endRootSpan("ok");

		const session = findSpan(exporter, "test.session")!;
		const event = session.events.find((e) => e.name === "context.injected");
		expect(String(event!.attributes!["context.instructions"]).length).toBe(500);
		expect(event!.attributes!["context.instructions_length"]).toBe(1000);
	});

	it("recordContextInjection is a no-op when root span has not started", () => {
		const { provider: p } = createTestProvider();
		const t = new Tracer({ enabled: true, provider: p });
		// Don't start root span — should not throw
		recordContextInjection(t, "instructions", false);
		p.shutdown();
	});

	it("supports multiple context injections as separate events", () => {
		recordContextInjection(tracer, "First instruction", false);
		recordContextInjection(tracer, "Second instruction", true);
		recordContextInjection(tracer, "Third instruction", false);
		tracer.endRootSpan("ok");

		const session = findSpan(exporter, "test.session")!;
		const events = session.events.filter((e) => e.name === "context.injected");
		expect(events).toHaveLength(3);
	});
});

// ── Usage (via helpers) ────────────────────────────────────────────────────

describe("Tracer — Usage (agent helpers)", () => {
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

	it("recordUsage records correct attributes on the active span", () => {
		const active = tracer.startActiveSpan("test.active");
		recordUsage(tracer, 5000, 10000, 50);
		tracer.endActiveSpan(active);

		const activeSpan = findSpan(exporter, "test.active")!;
		const usageEvent = activeSpan.events.find((e) => e.name === "usage.update");
		expect(usageEvent).toBeDefined();
		expect(usageEvent!.attributes!["usage.context_used"]).toBe(5000);
		expect(usageEvent!.attributes!["usage.context_size"]).toBe(10000);
		expect(usageEvent!.attributes!["usage.context_percent"]).toBe(50);
	});

	it("recordUsage falls back to root span when no active span", () => {
		recordUsage(tracer, 1000, 5000, 20);
		tracer.endRootSpan("ok");

		const session = findSpan(exporter, "test.session")!;
		const usageEvent = session.events.find((e) => e.name === "usage.update");
		expect(usageEvent).toBeDefined();
	});

	it("supports multiple usage events on the same active span", () => {
		const active = tracer.startActiveSpan("test.active");
		recordUsage(tracer, 1000, 10000, 10);
		recordUsage(tracer, 5000, 10000, 50);
		recordUsage(tracer, 9000, 10000, 90);
		tracer.endActiveSpan(active);

		const activeSpan = findSpan(exporter, "test.active")!;
		const usageEvents = activeSpan.events.filter(
			(e) => e.name === "usage.update",
		);
		expect(usageEvents).toHaveLength(3);
	});
});

// ── Shutdown ───────────────────────────────────────────────────────────────

describe("Tracer — Shutdown", () => {
	it("shutdown ends all lingering tracked spans with ERROR", async () => {
		const { tracer, exporter, provider } = createTestTracer();
		tracer.startRootSpan("test.session");
		tracer.startActiveSpan("test.active");

		startToolCall(tracer, {
			toolCallId: "tc-1",
			title: "Lingering tool",
		});

		const spans = await shutdownAndCollect(tracer, exporter, provider);
		const toolSpan = spans.find((s) => s.name === "agent.tool_call");

		expect(toolSpan).toBeDefined();
		expect(toolSpan!.status.code).toBe(SpanStatusCode.ERROR);
	});

	it("shutdown ends lingering terminal spans with ERROR", async () => {
		const { tracer, exporter, provider } = createTestTracer();
		tracer.startRootSpan("test.session");
		tracer.startActiveSpan("test.active");

		startTerminal(tracer, {
			terminalId: "t-1",
			command: "long-running",
		});

		const spans = await shutdownAndCollect(tracer, exporter, provider);
		const termSpan = spans.find((s) => s.name === "agent.terminal");

		expect(termSpan).toBeDefined();
		expect(termSpan!.status.code).toBe(SpanStatusCode.ERROR);
	});

	it("shutdown ends lingering active span with ERROR", async () => {
		const { tracer, exporter, provider } = createTestTracer();
		tracer.startRootSpan("test.session");
		tracer.startActiveSpan("test.active");

		const spans = await shutdownAndCollect(tracer, exporter, provider);
		const activeSpan = spans.find((s) => s.name === "test.active");

		expect(activeSpan).toBeDefined();
		expect(activeSpan!.status.code).toBe(SpanStatusCode.ERROR);
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

		const active = tracer.startActiveSpan("test.active");
		startToolCall(tracer, {
			toolCallId: "tc-1",
			title: "Tool",
		});

		// Don't manually end active or tool — shutdown should handle it
		const spans = await shutdownAndCollect(tracer, exporter, provider);

		const names = spans.map((s) => s.name).sort();
		expect(names).toContain("test.session");
		expect(names).toContain("init");
		expect(names).toContain("test.active");
		expect(names).toContain("agent.tool_call");
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

		startToolCall(tracer, {
			toolCallId: "tc-1",
			title: "Run tests",
			kind: "execute",
			command: "bun test",
		});

		const permSpan = startPermission(tracer, {
			toolCallId: "tc-1",
			toolCallTitle: "Run tests",
		});
		endPermission(permSpan, "granted", {
			optionId: "opt-1",
			optionName: "Allow",
		});

		endToolCall(tracer, "tc-1", "completed", 0);

		// Context injection during prompt
		recordContextInjection(tracer, "Add error handling", false);

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

		// Terminal
		const termSpan = startTerminal(tracer, {
			terminalId: "t-1",
			command: "echo",
			args: ["hello"],
			cwd: "/tmp",
		});
		endTerminal(termSpan, 0);

		// Usage
		recordUsage(tracer, 5000, 10000, 50);

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

		// Context injection event on the root span
		const session = findSpan(exporter, "agent.session");
		// Session was ended by flush, so check the collected spans
		const sessionSpan = allSpans.find((s) => s.name === "agent.session")!;
		const ctxEvent = sessionSpan.events.find(
			(e) => e.name === "context.injected",
		);
		expect(ctxEvent).toBeDefined();
	});

	it("all spans share the same traceId across the entire lifecycle", async () => {
		const { tracer, exporter, provider } = createTestTracer();
		tracer.startRootSpan("test.session");

		const init = tracer.startOperation("init", {}, "root");
		tracer.endOperation(init);

		const active = tracer.startActiveSpan("test.active");
		startToolCall(tracer, { toolCallId: "tc-1", title: "T" });
		endToolCall(tracer, "tc-1", "completed", 0);
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

		startToolCall(tracer, {
			toolCallId: "tc-1",
			title: "Run cmd",
			kind: "execute",
		});

		const perm = startPermission(tracer, {
			toolCallId: "tc-1",
			toolCallTitle: "Run cmd",
		});
		endPermission(perm, "granted", {
			optionId: "opt-1",
			optionName: "Allow",
		});

		endToolCall(tracer, "tc-1", "completed", 0);

		const spans = await shutdownAndCollect(tracer, exporter, provider);

		const toolSpan = spans.find((s) => s.name === "agent.tool_call")!;
		const permSpan = spans.find((s) => s.name === "agent.permission")!;

		// Permission should be a child of the tool call
		const permParent = parentSpanId(permSpan);
		expect(permParent).toBe(toolSpan.spanContext().spanId);
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

		const spans = provider as any;
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
