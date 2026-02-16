import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SpanStatusCode } from "@opentelemetry/api";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { AgentIdentity } from "../../../types/agent.types.ts";
import { AgentTracer } from "../agent-tracer.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Creates a test identity for the agent. */
function testIdentity(overrides?: Partial<AgentIdentity>): AgentIdentity {
	return {
		id: overrides?.id ?? "test-agent-001",
		name: overrides?.name ?? "Test Agent",
	};
}

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

/** Creates an AgentTracer wired to an in-memory exporter for assertions. */
function createTestTracer(identity?: AgentIdentity): {
	tracer: AgentTracer;
	exporter: InMemorySpanExporter;
	provider: BasicTracerProvider;
} {
	const { exporter, provider } = createTestProvider();
	const tracer = new AgentTracer(identity ?? testIdentity(), {
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

/** Finds all spans matching a name prefix. */
function findSpans(
	exporter: InMemorySpanExporter,
	namePrefix: string,
): ReadableSpan[] {
	return exporter
		.getFinishedSpans()
		.filter((s) => s.name.startsWith(namePrefix));
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
	tracer: AgentTracer,
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

// ── Disabled (No-Op) Tracer ────────────────────────────────────────────────

describe("AgentTracer (disabled)", () => {
	it("creates a no-op tracer when enabled is false", () => {
		const tracer = new AgentTracer(testIdentity(), { enabled: false });
		expect(tracer.enabled).toBe(false);
	});

	it("defaults to enabled when no config is provided", () => {
		const { provider } = createTestProvider();
		const tracer = new AgentTracer(testIdentity(), { provider });
		expect(tracer.enabled).toBe(true);
		provider.shutdown();
	});

	it("startSession returns a span that does not record", () => {
		const tracer = new AgentTracer(testIdentity(), { enabled: false });
		const span = tracer.startSession();
		expect(span.isRecording()).toBe(false);
	});

	it("all span methods return non-throwing no-ops when disabled", () => {
		const tracer = new AgentTracer(testIdentity(), { enabled: false });

		// None of these should throw
		const _session = tracer.startSession();
		const init = tracer.startInitialize();
		const phase = tracer.startInitPhase("spawn-process", init);
		tracer.endInitialize(phase);
		tracer.endInitialize(init);

		const prompt = tracer.startPrompt(1, "test prompt");
		tracer.startToolCall({
			toolCallId: "tc-1",
			title: "Test tool",
			kind: "execute",
		});
		tracer.updateToolCall("tc-1", "in_progress", "some output");
		tracer.endToolCall("tc-1", "completed", 0);

		const perm = tracer.startPermission({
			toolCallId: "tc-1",
			toolCallTitle: "Test",
		});
		tracer.endPermission(perm, "granted", {
			optionId: "opt-1",
			optionName: "Allow",
		});

		const fs = tracer.startFs({
			path: "/test",
			operation: "read",
		});
		tracer.endFs(fs, 100);

		const term = tracer.startTerminal({
			terminalId: "t-1",
			command: "echo",
			args: ["hello"],
		});
		tracer.endTerminal(term, 0);

		tracer.recordContextInjection("some instructions", false);
		tracer.recordUsage(100, 1000, 10);

		tracer.endPrompt(prompt, "end_turn");
		tracer.endSession("ok");
	});

	it("shutdown resolves without error when disabled", async () => {
		const tracer = new AgentTracer(testIdentity(), { enabled: false });
		tracer.startSession();
		await expect(tracer.shutdown()).resolves.toBeUndefined();
	});
});

// ── Session (Root Span) ────────────────────────────────────────────────────

describe("AgentTracer — Session", () => {
	let tracer: AgentTracer;
	let exporter: InMemorySpanExporter;
	let provider: BasicTracerProvider;

	beforeEach(() => {
		({ tracer, exporter, provider } = createTestTracer());
	});

	afterEach(async () => {
		await provider.shutdown();
	});

	it("startSession creates a root span named 'agent.session'", () => {
		tracer.startSession();
		tracer.endSession("ok");

		const span = findSpan(exporter, "agent.session");
		expect(span).toBeDefined();
	});

	it("session span carries agent identity attributes", () => {
		const identity = testIdentity({ id: "id-42", name: "Cool Agent" });
		const { tracer: t, exporter: e, provider: p } = createTestTracer(identity);

		t.startSession();
		t.endSession("ok");

		const span = findSpan(e, "agent.session")!;
		expect(attr(span, "agent.id")).toBe("id-42");
		expect(attr(span, "agent.name")).toBe("Cool Agent");

		p.shutdown();
	});

	it("endSession with 'ok' sets status OK", () => {
		tracer.startSession();
		tracer.endSession("ok");

		const span = findSpan(exporter, "agent.session")!;
		expect(span.status.code).toBe(SpanStatusCode.OK);
	});

	it("endSession with 'error' sets status ERROR with message", () => {
		tracer.startSession();
		tracer.endSession("error", "Something went wrong");

		const span = findSpan(exporter, "agent.session")!;
		expect(span.status.code).toBe(SpanStatusCode.ERROR);
		expect(span.status.message).toBe("Something went wrong");
	});

	it("endSession is safe to call multiple times", () => {
		tracer.startSession();
		tracer.endSession("ok");
		// Second call should be a no-op, not throw
		tracer.endSession("ok");

		const spans = findSpans(exporter, "agent.session");
		expect(spans.length).toBe(1);
	});

	it("endSession is a no-op when session was never started", () => {
		// No startSession() call — should not throw
		tracer.endSession("ok");

		expect(exporter.getFinishedSpans().length).toBe(0);
	});
});

// ── Initialize ─────────────────────────────────────────────────────────────

describe("AgentTracer — Initialize", () => {
	let tracer: AgentTracer;
	let exporter: InMemorySpanExporter;
	let provider: BasicTracerProvider;

	beforeEach(() => {
		({ tracer, exporter, provider } = createTestTracer());
		tracer.startSession();
	});

	afterEach(async () => {
		tracer.endSession("ok");
		await provider.shutdown();
	});

	it("startInitialize creates a child span named 'agent.initialize'", () => {
		const span = tracer.startInitialize();
		tracer.endInitialize(span);

		const found = findSpan(exporter, "agent.initialize");
		expect(found).toBeDefined();
	});

	it("initialize span shares the same traceId as the session span", () => {
		const span = tracer.startInitialize();
		tracer.endInitialize(span);
		tracer.endSession("ok");

		const sessionSpan = findSpan(exporter, "agent.session")!;
		const initSpan = findSpan(exporter, "agent.initialize")!;

		// Same trace ID proves they are part of the same trace
		expect(initSpan.spanContext().traceId).toBe(
			sessionSpan.spanContext().traceId,
		);
	});

	it("initialize span is a child of the session span (parentSpanContext)", () => {
		const span = tracer.startInitialize();
		tracer.endInitialize(span);
		tracer.endSession("ok");

		const sessionSpan = findSpan(exporter, "agent.session")!;
		const initSpan = findSpan(exporter, "agent.initialize")!;

		// sdk-trace-base v2.x uses parentSpanContext instead of parentSpanId
		const parent = parentSpanId(initSpan);
		expect(parent).toBe(sessionSpan.spanContext().spanId);
	});

	it("startInitPhase creates sub-spans for each initialization phase", () => {
		const initSpan = tracer.startInitialize();

		const spawn = tracer.startInitPhase("spawn-process", initSpan);
		tracer.endInitialize(spawn);

		const acpInit = tracer.startInitPhase("acp-protocol-init", initSpan);
		tracer.endInitialize(acpInit);

		const session = tracer.startInitPhase("create-session", initSpan);
		tracer.endInitialize(session);

		tracer.endInitialize(initSpan);

		expect(findSpan(exporter, "agent.initialize.spawn-process")).toBeDefined();
		expect(
			findSpan(exporter, "agent.initialize.acp-protocol-init"),
		).toBeDefined();
		expect(findSpan(exporter, "agent.initialize.create-session")).toBeDefined();
	});

	it("init phase spans are children of the initialize span", () => {
		const initSpan = tracer.startInitialize();

		const spawn = tracer.startInitPhase("spawn-process", initSpan);
		tracer.endInitialize(spawn);

		tracer.endInitialize(initSpan);

		const initReadable = findSpan(exporter, "agent.initialize")!;
		const spawnReadable = findSpan(exporter, "agent.initialize.spawn-process")!;

		const parent = parentSpanId(spawnReadable);
		expect(parent).toBe(initReadable.spanContext().spanId);
	});

	it("endInitialize with an error sets ERROR status and records exception", () => {
		const span = tracer.startInitialize();
		const error = new Error("spawn failed");
		tracer.endInitialize(span, error);

		const found = findSpan(exporter, "agent.initialize")!;
		expect(found.status.code).toBe(SpanStatusCode.ERROR);
		expect(found.status.message).toBe("spawn failed");

		// Exception should be recorded as an event
		const exceptionEvent = found.events.find((e) => e.name === "exception");
		expect(exceptionEvent).toBeDefined();
	});

	it("endInitialize without an error sets OK status", () => {
		const span = tracer.startInitialize();
		tracer.endInitialize(span);

		const found = findSpan(exporter, "agent.initialize")!;
		expect(found.status.code).toBe(SpanStatusCode.OK);
	});
});

// ── Prompt ──────────────────────────────────────────────────────────────────

describe("AgentTracer — Prompt", () => {
	let tracer: AgentTracer;
	let exporter: InMemorySpanExporter;
	let provider: BasicTracerProvider;

	beforeEach(() => {
		({ tracer, exporter, provider } = createTestTracer());
		tracer.startSession();
	});

	afterEach(async () => {
		tracer.endSession("ok");
		await provider.shutdown();
	});

	it("startPrompt creates a span named 'agent.prompt'", () => {
		const span = tracer.startPrompt(1, "Hello agent");
		tracer.endPrompt(span, "end_turn");

		const found = findSpan(exporter, "agent.prompt");
		expect(found).toBeDefined();
	});

	it("prompt span carries prompt index and text attributes", () => {
		const promptText = "Do something cool";
		const span = tracer.startPrompt(3, promptText);
		tracer.endPrompt(span, "end_turn");

		const found = findSpan(exporter, "agent.prompt")!;
		expect(attr(found, "prompt.index")).toBe(3);
		expect(attr(found, "prompt.text")).toBe(promptText);
		expect(attr(found, "prompt.text_length")).toBe(promptText.length);
	});

	it("prompt text is truncated to 500 chars in attributes", () => {
		const longText = "x".repeat(1000);
		const span = tracer.startPrompt(1, longText);
		tracer.endPrompt(span, "end_turn");

		const found = findSpan(exporter, "agent.prompt")!;
		expect((attr(found, "prompt.text") as string).length).toBe(500);
		expect(attr(found, "prompt.text_length")).toBe(1000);
	});

	it("endPrompt sets the stop_reason attribute", () => {
		const span = tracer.startPrompt(1, "test");
		tracer.endPrompt(span, "end_turn");

		const found = findSpan(exporter, "agent.prompt")!;
		expect(attr(found, "prompt.stop_reason")).toBe("end_turn");
	});

	it("endPrompt with error sets ERROR status", () => {
		const span = tracer.startPrompt(1, "test");
		tracer.endPrompt(span, undefined, new Error("prompt failed"));

		const found = findSpan(exporter, "agent.prompt")!;
		expect(found.status.code).toBe(SpanStatusCode.ERROR);
		expect(found.status.message).toBe("prompt failed");
	});

	it("endPrompt with success sets OK status", () => {
		const span = tracer.startPrompt(1, "test");
		tracer.endPrompt(span, "end_turn");

		const found = findSpan(exporter, "agent.prompt")!;
		expect(found.status.code).toBe(SpanStatusCode.OK);
	});

	it("prompt span shares the same traceId as the session span", () => {
		const span = tracer.startPrompt(1, "test");
		tracer.endPrompt(span, "end_turn");
		tracer.endSession("ok");

		const sessionSpan = findSpan(exporter, "agent.session")!;
		const promptSpan = findSpan(exporter, "agent.prompt")!;

		expect(promptSpan.spanContext().traceId).toBe(
			sessionSpan.spanContext().traceId,
		);
	});

	it("prompt span is a child of the session span", () => {
		const span = tracer.startPrompt(1, "test");
		tracer.endPrompt(span, "end_turn");
		tracer.endSession("ok");

		const sessionSpan = findSpan(exporter, "agent.session")!;
		const promptSpan = findSpan(exporter, "agent.prompt")!;

		const parent = parentSpanId(promptSpan);
		expect(parent).toBe(sessionSpan.spanContext().spanId);
	});

	it("supports multiple sequential prompts", () => {
		const p1 = tracer.startPrompt(1, "first");
		tracer.endPrompt(p1, "end_turn");

		const p2 = tracer.startPrompt(2, "second");
		tracer.endPrompt(p2, "end_turn");

		const prompts = findSpans(exporter, "agent.prompt");
		expect(prompts.length).toBe(2);
		expect(attr(prompts[0]!, "prompt.index")).toBe(1);
		expect(attr(prompts[1]!, "prompt.index")).toBe(2);
	});
});

// ── Tool Calls ─────────────────────────────────────────────────────────────

describe("AgentTracer — Tool Calls", () => {
	let tracer: AgentTracer;
	let exporter: InMemorySpanExporter;
	let provider: BasicTracerProvider;

	beforeEach(() => {
		({ tracer, exporter, provider } = createTestTracer());
		tracer.startSession();
		tracer.startPrompt(1, "test prompt");
	});

	afterEach(async () => {
		// Collect before provider shutdown clears the exporter
		tracer.endSession("ok");
		await provider.shutdown();
	});

	it("startToolCall creates a span named 'agent.tool_call'", () => {
		tracer.startToolCall({
			toolCallId: "tc-1",
			title: "Check Docker",
			kind: "execute",
			command: "docker info",
		});
		tracer.endToolCall("tc-1", "completed", 0);

		const found = findSpan(exporter, "agent.tool_call");
		expect(found).toBeDefined();
	});

	it("tool call span carries all attributes", () => {
		tracer.startToolCall({
			toolCallId: "tc-42",
			title: "Run tests",
			kind: "execute",
			command: "bun test",
		});
		tracer.endToolCall("tc-42", "completed", 0);

		const found = findSpan(exporter, "agent.tool_call")!;
		expect(attr(found, "tool.call_id")).toBe("tc-42");
		expect(attr(found, "tool.title")).toBe("Run tests");
		expect(attr(found, "tool.kind")).toBe("execute");
		expect(attr(found, "tool.command")).toBe("bun test");
	});

	it("tool call span is a child of the active prompt span", () => {
		tracer.startToolCall({
			toolCallId: "tc-1",
			title: "Test",
		});
		tracer.endToolCall("tc-1", "completed", 0);

		const toolSpan = findSpan(exporter, "agent.tool_call")!;

		// The tool call should have a parent (the prompt span)
		const parent = parentSpanId(toolSpan);
		expect(parent).toBeDefined();
		expect(parent?.length).toBe(16);
	});

	it("tool call without optional attributes omits them", () => {
		tracer.startToolCall({
			toolCallId: "tc-1",
			title: "Read file",
			// No kind, no command
		});
		tracer.endToolCall("tc-1", "completed");

		const found = findSpan(exporter, "agent.tool_call")!;
		expect(attr(found, "tool.call_id")).toBe("tc-1");
		expect(attr(found, "tool.title")).toBe("Read file");
		expect(attr(found, "tool.kind")).toBeUndefined();
		expect(attr(found, "tool.command")).toBeUndefined();
	});

	it("updateToolCall adds an event to the span", () => {
		tracer.startToolCall({
			toolCallId: "tc-1",
			title: "Long task",
		});

		tracer.updateToolCall("tc-1", "in_progress", "partial output", undefined);
		tracer.endToolCall("tc-1", "completed", 0);

		const found = findSpan(exporter, "agent.tool_call")!;
		const updateEvent = found.events.find((e) => e.name === "tool.update");
		expect(updateEvent).toBeDefined();
		expect(updateEvent?.attributes?.status).toBe("in_progress");
		expect(updateEvent?.attributes?.output).toBe("partial output");
	});

	it("updateToolCall truncates output to 1000 chars", () => {
		tracer.startToolCall({
			toolCallId: "tc-1",
			title: "Verbose task",
		});

		const longOutput = "y".repeat(2000);
		tracer.updateToolCall("tc-1", "in_progress", longOutput);
		tracer.endToolCall("tc-1", "completed", 0);

		const found = findSpan(exporter, "agent.tool_call")!;
		const updateEvent = found.events.find((e) => e.name === "tool.update");
		expect((updateEvent?.attributes?.output as string).length).toBe(1000);
	});

	it("updateToolCall with exit_code records it in the event", () => {
		tracer.startToolCall({
			toolCallId: "tc-1",
			title: "Failing task",
		});

		tracer.updateToolCall("tc-1", "in_progress", undefined, 1);
		tracer.endToolCall("tc-1", "failed", 1);

		const found = findSpan(exporter, "agent.tool_call")!;
		const updateEvent = found.events.find((e) => e.name === "tool.update");
		expect(updateEvent?.attributes?.exit_code).toBe(1);
	});

	it("updateToolCall is a no-op for unknown toolCallId", () => {
		// Should not throw
		tracer.updateToolCall("unknown-id", "in_progress", "output");
		expect(exporter.getFinishedSpans().length).toBe(0);
	});

	it("endToolCall with 'completed' and exit 0 sets OK status", () => {
		tracer.startToolCall({
			toolCallId: "tc-1",
			title: "Success",
		});
		tracer.endToolCall("tc-1", "completed", 0);

		const found = findSpan(exporter, "agent.tool_call")!;
		expect(found.status.code).toBe(SpanStatusCode.OK);
		expect(attr(found, "tool.status")).toBe("completed");
		expect(attr(found, "tool.exit_code")).toBe(0);
	});

	it("endToolCall with 'failed' sets ERROR status", () => {
		tracer.startToolCall({
			toolCallId: "tc-1",
			title: "Failure",
		});
		tracer.endToolCall("tc-1", "failed", 1);

		const found = findSpan(exporter, "agent.tool_call")!;
		expect(found.status.code).toBe(SpanStatusCode.ERROR);
		expect(attr(found, "tool.status")).toBe("failed");
		expect(attr(found, "tool.exit_code")).toBe(1);
	});

	it("endToolCall with non-zero exit code sets ERROR even if status is completed", () => {
		tracer.startToolCall({
			toolCallId: "tc-1",
			title: "Odd case",
		});
		tracer.endToolCall("tc-1", "completed", 127);

		const found = findSpan(exporter, "agent.tool_call")!;
		expect(found.status.code).toBe(SpanStatusCode.ERROR);
	});

	it("endToolCall removes the span from active tracking", () => {
		tracer.startToolCall({
			toolCallId: "tc-1",
			title: "Tracked",
		});
		tracer.endToolCall("tc-1", "completed", 0);

		// Second end should be a no-op (span already ended and removed)
		tracer.endToolCall("tc-1", "completed", 0);

		// Only one tool_call span should exist
		const spans = findSpans(exporter, "agent.tool_call");
		expect(spans.length).toBe(1);
	});

	it("endToolCall is a no-op for unknown toolCallId", () => {
		// Should not throw
		tracer.endToolCall("nonexistent", "completed", 0);
		expect(findSpans(exporter, "agent.tool_call").length).toBe(0);
	});

	it("supports multiple concurrent tool calls", () => {
		tracer.startToolCall({
			toolCallId: "tc-a",
			title: "Tool A",
			kind: "execute",
		});
		tracer.startToolCall({
			toolCallId: "tc-b",
			title: "Tool B",
			kind: "read",
		});

		tracer.endToolCall("tc-b", "completed", 0);
		tracer.endToolCall("tc-a", "completed", 0);

		const spans = findSpans(exporter, "agent.tool_call");
		expect(spans.length).toBe(2);

		const titles = spans.map((s) => attr(s, "tool.title"));
		expect(titles).toContain("Tool A");
		expect(titles).toContain("Tool B");
	});
});

// ── Permissions ────────────────────────────────────────────────────────────

describe("AgentTracer — Permissions", () => {
	let tracer: AgentTracer;
	let exporter: InMemorySpanExporter;
	let provider: BasicTracerProvider;

	beforeEach(() => {
		({ tracer, exporter, provider } = createTestTracer());
		tracer.startSession();
		tracer.startPrompt(1, "test");
	});

	afterEach(async () => {
		tracer.endSession("ok");
		await provider.shutdown();
	});

	it("startPermission creates a span named 'agent.permission'", () => {
		const span = tracer.startPermission({
			toolCallId: "tc-1",
			toolCallTitle: "Run command",
		});
		tracer.endPermission(span, "granted", {
			optionId: "allow_once",
			optionName: "Allow once",
		});

		const found = findSpan(exporter, "agent.permission");
		expect(found).toBeDefined();
	});

	it("permission span carries tool call attributes", () => {
		const span = tracer.startPermission({
			toolCallId: "tc-99",
			toolCallTitle: "Install package",
		});
		tracer.endPermission(span, "granted");

		const found = findSpan(exporter, "agent.permission")!;
		expect(attr(found, "permission.tool_call_id")).toBe("tc-99");
		expect(attr(found, "permission.tool_call_title")).toBe("Install package");
	});

	it("endPermission with 'granted' sets OK status and outcome attributes", () => {
		const span = tracer.startPermission({
			toolCallId: "tc-1",
		});
		tracer.endPermission(span, "granted", {
			optionId: "allow_always",
			optionName: "Always allow",
		});

		const found = findSpan(exporter, "agent.permission")!;
		expect(found.status.code).toBe(SpanStatusCode.OK);
		expect(attr(found, "permission.outcome")).toBe("granted");
		expect(attr(found, "permission.option_id")).toBe("allow_always");
		expect(attr(found, "permission.option_name")).toBe("Always allow");
	});

	it("endPermission with 'denied' sets ERROR status and reason", () => {
		const span = tracer.startPermission({
			toolCallId: "tc-1",
		});
		tracer.endPermission(span, "denied", {
			reason: "Auto-approve disabled",
		});

		const found = findSpan(exporter, "agent.permission")!;
		expect(found.status.code).toBe(SpanStatusCode.ERROR);
		expect(attr(found, "permission.outcome")).toBe("denied");
		expect(attr(found, "permission.denial_reason")).toBe(
			"Auto-approve disabled",
		);
	});

	it("permission span is parented under the tool call span when available", () => {
		tracer.startToolCall({
			toolCallId: "tc-1",
			title: "Docker check",
		});

		const permSpan = tracer.startPermission({
			toolCallId: "tc-1",
			toolCallTitle: "Docker check",
		});
		tracer.endPermission(permSpan, "granted");
		tracer.endToolCall("tc-1", "completed", 0);

		const toolSpan = findSpan(exporter, "agent.tool_call")!;
		const permReadable = findSpan(exporter, "agent.permission")!;

		const parent = parentSpanId(permReadable);
		expect(parent).toBe(toolSpan.spanContext().spanId);
	});

	it("permission span has a parent even when no tool call matches", () => {
		const permSpan = tracer.startPermission({
			toolCallId: "tc-unknown",
			toolCallTitle: "Unknown tool",
		});
		tracer.endPermission(permSpan, "denied", { reason: "No match" });

		const permReadable = findSpan(exporter, "agent.permission")!;
		// It should still have a parent (the prompt span or session span)
		const parent = parentSpanId(permReadable);
		expect(parent).toBeDefined();
		expect(parent?.length).toBe(16);
	});
});

// ── File System ────────────────────────────────────────────────────────────

describe("AgentTracer — File System", () => {
	let tracer: AgentTracer;
	let exporter: InMemorySpanExporter;
	let provider: BasicTracerProvider;

	beforeEach(() => {
		({ tracer, exporter, provider } = createTestTracer());
		tracer.startSession();
		tracer.startPrompt(1, "test");
	});

	afterEach(async () => {
		tracer.endSession("ok");
		await provider.shutdown();
	});

	it("startFs creates a span named 'agent.fs.read' for read operations", () => {
		const span = tracer.startFs({
			path: "/src/index.ts",
			operation: "read",
		});
		tracer.endFs(span, 1234);

		const found = findSpan(exporter, "agent.fs.read");
		expect(found).toBeDefined();
	});

	it("startFs creates a span named 'agent.fs.write' for write operations", () => {
		const span = tracer.startFs({
			path: "/src/output.ts",
			operation: "write",
			contentLength: 500,
		});
		tracer.endFs(span);

		const found = findSpan(exporter, "agent.fs.write");
		expect(found).toBeDefined();
	});

	it("fs span carries path and operation attributes", () => {
		const span = tracer.startFs({
			path: "/config/settings.json",
			operation: "read",
			contentLength: 42,
		});
		tracer.endFs(span);

		const found = findSpan(exporter, "agent.fs.read")!;
		expect(attr(found, "fs.path")).toBe("/config/settings.json");
		expect(attr(found, "fs.operation")).toBe("read");
		expect(attr(found, "fs.content_length")).toBe(42);
	});

	it("endFs updates content_length when provided", () => {
		const span = tracer.startFs({
			path: "/test.txt",
			operation: "read",
		});
		tracer.endFs(span, 999);

		const found = findSpan(exporter, "agent.fs.read")!;
		expect(attr(found, "fs.content_length")).toBe(999);
	});

	it("endFs with error sets ERROR status", () => {
		const span = tracer.startFs({
			path: "/nonexistent.txt",
			operation: "read",
		});
		tracer.endFs(span, undefined, new Error("ENOENT: file not found"));

		const found = findSpan(exporter, "agent.fs.read")!;
		expect(found.status.code).toBe(SpanStatusCode.ERROR);
		expect(found.status.message).toBe("ENOENT: file not found");
	});

	it("endFs without error sets OK status", () => {
		const span = tracer.startFs({
			path: "/test.txt",
			operation: "write",
			contentLength: 100,
		});
		tracer.endFs(span);

		const found = findSpan(exporter, "agent.fs.write")!;
		expect(found.status.code).toBe(SpanStatusCode.OK);
	});

	it("fs span is a child of the active prompt span", () => {
		const span = tracer.startFs({
			path: "/test.txt",
			operation: "read",
		});
		tracer.endFs(span, 50);

		const fsSpan = findSpan(exporter, "agent.fs.read")!;
		const parent = parentSpanId(fsSpan);
		expect(parent).toBeDefined();
		expect(parent?.length).toBe(16);
	});
});

// ── Terminal ───────────────────────────────────────────────────────────────

describe("AgentTracer — Terminal", () => {
	let tracer: AgentTracer;
	let exporter: InMemorySpanExporter;
	let provider: BasicTracerProvider;

	beforeEach(() => {
		({ tracer, exporter, provider } = createTestTracer());
		tracer.startSession();
		tracer.startPrompt(1, "test");
	});

	afterEach(async () => {
		tracer.endSession("ok");
		await provider.shutdown();
	});

	it("startTerminal creates a span named 'agent.terminal'", () => {
		const span = tracer.startTerminal({
			terminalId: "t-1",
			command: "echo",
			args: ["hello", "world"],
			cwd: "/home/user",
		});
		tracer.endTerminal(span, 0);

		const found = findSpan(exporter, "agent.terminal");
		expect(found).toBeDefined();
	});

	it("terminal span carries all attributes", () => {
		const span = tracer.startTerminal({
			terminalId: "t-42",
			command: "docker",
			args: ["compose", "up", "-d"],
			cwd: "/app",
		});
		tracer.endTerminal(span, 0);

		const found = findSpan(exporter, "agent.terminal")!;
		expect(attr(found, "terminal.id")).toBe("t-42");
		expect(attr(found, "terminal.command")).toBe("docker");
		expect(attr(found, "terminal.args")).toBe("compose up -d");
		expect(attr(found, "terminal.cwd")).toBe("/app");
	});

	it("endTerminal with exit code 0 sets OK status", () => {
		const span = tracer.startTerminal({
			terminalId: "t-1",
			command: "true",
		});
		tracer.endTerminal(span, 0);

		const found = findSpan(exporter, "agent.terminal")!;
		expect(found.status.code).toBe(SpanStatusCode.OK);
		expect(attr(found, "terminal.exit_code")).toBe(0);
	});

	it("endTerminal with non-zero exit code sets ERROR status", () => {
		const span = tracer.startTerminal({
			terminalId: "t-1",
			command: "false",
		});
		tracer.endTerminal(span, 1);

		const found = findSpan(exporter, "agent.terminal")!;
		expect(found.status.code).toBe(SpanStatusCode.ERROR);
		expect(found.status.message).toContain("code 1");
		expect(attr(found, "terminal.exit_code")).toBe(1);
	});

	it("endTerminal with signal records it as an attribute", () => {
		const span = tracer.startTerminal({
			terminalId: "t-1",
			command: "sleep",
		});
		tracer.endTerminal(span, null, "SIGTERM");

		const found = findSpan(exporter, "agent.terminal")!;
		expect(attr(found, "terminal.signal")).toBe("SIGTERM");
		// null exit code + signal = OK (graceful termination)
		expect(found.status.code).toBe(SpanStatusCode.OK);
	});

	it("endTerminal with null exit code and no signal sets OK status", () => {
		const span = tracer.startTerminal({
			terminalId: "t-1",
			command: "echo",
		});
		tracer.endTerminal(span, null, null);

		const found = findSpan(exporter, "agent.terminal")!;
		expect(found.status.code).toBe(SpanStatusCode.OK);
	});

	it("terminal span without optional args and cwd omits them", () => {
		const span = tracer.startTerminal({
			terminalId: "t-1",
			command: "whoami",
		});
		tracer.endTerminal(span, 0);

		const found = findSpan(exporter, "agent.terminal")!;
		expect(attr(found, "terminal.args")).toBeUndefined();
		expect(attr(found, "terminal.cwd")).toBeUndefined();
	});
});

// ── Context Injection ──────────────────────────────────────────────────────

describe("AgentTracer — Context Injection", () => {
	let tracer: AgentTracer;
	let exporter: InMemorySpanExporter;
	let provider: BasicTracerProvider;

	beforeEach(() => {
		({ tracer, exporter, provider } = createTestTracer());
		tracer.startSession();
	});

	afterEach(async () => {
		tracer.endSession("ok");
		await provider.shutdown();
	});

	it("recordContextInjection adds an event to the session span", () => {
		tracer.recordContextInjection("Use strict TypeScript", false);
		tracer.endSession("ok");

		const session = findSpan(exporter, "agent.session")!;
		const event = session.events.find((e) => e.name === "context.injected");
		expect(event).toBeDefined();
		expect(event?.attributes?.["context.instructions"]).toBe(
			"Use strict TypeScript",
		);
		expect(event?.attributes?.["context.queued"]).toBe("false");
	});

	it("recordContextInjection records queued=true when instructions are queued", () => {
		tracer.recordContextInjection("Add error handling", true);
		tracer.endSession("ok");

		const session = findSpan(exporter, "agent.session")!;
		const event = session.events.find((e) => e.name === "context.injected");
		expect(event?.attributes?.["context.queued"]).toBe("true");
	});

	it("recordContextInjection truncates long instructions to 500 chars", () => {
		const longInstructions = "z".repeat(1000);
		tracer.recordContextInjection(longInstructions, false);
		tracer.endSession("ok");

		const session = findSpan(exporter, "agent.session")!;
		const event = session.events.find((e) => e.name === "context.injected");
		expect((event?.attributes?.["context.instructions"] as string).length).toBe(
			500,
		);
		expect(event?.attributes?.["context.instructions_length"]).toBe(1000);
	});

	it("recordContextInjection is a no-op when session has not started", () => {
		const { provider: p } = createTestProvider();
		const t = new AgentTracer(testIdentity(), { enabled: true, provider: p });
		// No startSession() call
		t.recordContextInjection("test", false);
		// Should not throw, and no spans should be created
		p.shutdown();
	});

	it("supports multiple context injections as separate events", () => {
		tracer.recordContextInjection("First instruction", false);
		tracer.recordContextInjection("Second instruction", true);
		tracer.endSession("ok");

		const session = findSpan(exporter, "agent.session")!;
		const events = session.events.filter((e) => e.name === "context.injected");
		expect(events.length).toBe(2);
		expect(events[0]?.attributes?.["context.instructions"]).toBe(
			"First instruction",
		);
		expect(events[1]?.attributes?.["context.instructions"]).toBe(
			"Second instruction",
		);
	});
});

// ── Usage ──────────────────────────────────────────────────────────────────

describe("AgentTracer — Usage", () => {
	let tracer: AgentTracer;
	let exporter: InMemorySpanExporter;
	let provider: BasicTracerProvider;

	beforeEach(() => {
		({ tracer, exporter, provider } = createTestTracer());
		tracer.startSession();
	});

	afterEach(async () => {
		tracer.endSession("ok");
		await provider.shutdown();
	});

	it("recordUsage records correct attributes on the active prompt span", () => {
		const prompt = tracer.startPrompt(1, "test");
		tracer.recordUsage(10000, 200000, 5);
		tracer.endPrompt(prompt, "end_turn");

		const promptSpan = findSpan(exporter, "agent.prompt")!;
		const usageEvent = promptSpan.events.find((e) => e.name === "usage.update");
		expect(usageEvent).toBeDefined();
		expect(usageEvent?.attributes?.["usage.context_used"]).toBe(10000);
		expect(usageEvent?.attributes?.["usage.context_size"]).toBe(200000);
		expect(usageEvent?.attributes?.["usage.context_percent"]).toBe(5);
	});

	it("recordUsage falls back to session span when no prompt is active", () => {
		// No active prompt — should record on session
		tracer.recordUsage(1000, 10000, 10);
		tracer.endSession("ok");

		const session = findSpan(exporter, "agent.session")!;
		const usageEvent = session.events.find((e) => e.name === "usage.update");
		expect(usageEvent).toBeDefined();
		expect(usageEvent?.attributes?.["usage.context_used"]).toBe(1000);
	});

	it("supports multiple usage events on the same prompt", () => {
		const prompt = tracer.startPrompt(1, "test");
		tracer.recordUsage(5000, 128000, 4);
		tracer.recordUsage(10000, 128000, 8);
		tracer.recordUsage(15000, 128000, 12);
		tracer.endPrompt(prompt, "end_turn");

		const promptSpan = findSpan(exporter, "agent.prompt")!;
		const usageEvents = promptSpan.events.filter(
			(e) => e.name === "usage.update",
		);
		expect(usageEvents.length).toBe(3);
		expect(usageEvents[2]?.attributes?.["usage.context_percent"]).toBe(12);
	});
});

// ── Shutdown ───────────────────────────────────────────────────────────────

describe("AgentTracer — Shutdown", () => {
	it("shutdown ends all lingering tool call spans with ERROR", async () => {
		const { tracer, exporter, provider } = createTestTracer();
		tracer.startSession();
		tracer.startPrompt(1, "test");

		tracer.startToolCall({
			toolCallId: "tc-orphan",
			title: "Orphaned tool",
		});

		// Don't end the tool call — shutdown should clean it up
		// Snapshot spans BEFORE provider.shutdown() clears the exporter
		const spans = await shutdownAndCollect(tracer, exporter, provider);

		const toolSpan = spans.find((s) => s.name === "agent.tool_call");
		expect(toolSpan).toBeDefined();
		expect(toolSpan?.status.code).toBe(SpanStatusCode.ERROR);
		expect(toolSpan?.status.message).toContain("destroyed");
	});

	it("shutdown ends lingering prompt span with ERROR", async () => {
		const { tracer, exporter, provider } = createTestTracer();
		tracer.startSession();
		tracer.startPrompt(1, "unfinished prompt");

		// Don't end the prompt — shutdown should clean it up
		const spans = await shutdownAndCollect(tracer, exporter, provider);

		const promptSpan = spans.find((s) => s.name === "agent.prompt");
		expect(promptSpan).toBeDefined();
		expect(promptSpan?.status.code).toBe(SpanStatusCode.ERROR);
		expect(promptSpan?.status.message).toContain("destroyed");
	});

	it("shutdown ends the session span", async () => {
		const { tracer, exporter, provider } = createTestTracer();
		tracer.startSession();

		const spans = await shutdownAndCollect(tracer, exporter, provider);

		const session = spans.find((s) => s.name === "agent.session");
		expect(session).toBeDefined();
		expect(session?.status.code).toBe(SpanStatusCode.OK);
	});

	it("shutdown is safe to call multiple times", async () => {
		const { tracer, exporter, provider } = createTestTracer();
		tracer.startSession();

		// First shutdown collects spans
		const spans = await shutdownAndCollect(tracer, exporter, provider);

		// Second shutdown should not throw
		await tracer.shutdown();

		const sessions = spans.filter((s) => s.name === "agent.session");
		expect(sessions.length).toBe(1);
	});

	it("shutdown flushes all spans to the exporter", async () => {
		const { tracer, exporter, provider } = createTestTracer();
		tracer.startSession();

		const initSpan = tracer.startInitialize();
		tracer.endInitialize(initSpan);

		const prompt = tracer.startPrompt(1, "test");
		tracer.startToolCall({
			toolCallId: "tc-1",
			title: "Tool",
		});
		tracer.endToolCall("tc-1", "completed", 0);
		tracer.endPrompt(prompt, "end_turn");

		const spans = await shutdownAndCollect(tracer, exporter, provider);

		const names = spans.map((s) => s.name);
		expect(names).toContain("agent.session");
		expect(names).toContain("agent.initialize");
		expect(names).toContain("agent.prompt");
		expect(names).toContain("agent.tool_call");
	});
});

// ── Full Lifecycle (Integration) ───────────────────────────────────────────

describe("AgentTracer — Full Lifecycle", () => {
	it("produces a correct span hierarchy for a complete agent session", async () => {
		const { tracer, exporter, provider } = createTestTracer(
			testIdentity({ id: "full-test", name: "Full Agent" }),
		);

		// 1. Start session
		tracer.startSession();

		// 2. Initialize
		const initSpan = tracer.startInitialize();
		const spawnPhase = tracer.startInitPhase("spawn-process", initSpan);
		tracer.endInitialize(spawnPhase);
		const acpPhase = tracer.startInitPhase("acp-protocol-init", initSpan);
		tracer.endInitialize(acpPhase);
		const sessionPhase = tracer.startInitPhase("create-session", initSpan);
		tracer.endInitialize(sessionPhase);
		tracer.endInitialize(initSpan);

		// 3. First prompt
		const p1 = tracer.startPrompt(1, "Start Docker");

		// Tool call with permission
		tracer.startToolCall({
			toolCallId: "tc-docker",
			title: "Check Docker",
			kind: "execute",
			command: "docker info",
		});

		const permSpan = tracer.startPermission({
			toolCallId: "tc-docker",
			toolCallTitle: "Check Docker",
		});
		tracer.endPermission(permSpan, "granted", {
			optionId: "allow_once",
			optionName: "Allow once",
		});

		tracer.updateToolCall("tc-docker", "in_progress", "Client: Docker...");
		tracer.endToolCall("tc-docker", "completed", 0);

		// File read
		const fsSpan = tracer.startFs({
			path: "/docker-compose.yml",
			operation: "read",
		});
		tracer.endFs(fsSpan, 250);

		// Terminal
		const termSpan = tracer.startTerminal({
			terminalId: "t-1",
			command: "docker",
			args: ["compose", "up", "-d"],
			cwd: "/app",
		});
		tracer.endTerminal(termSpan, 0);

		// Usage
		tracer.recordUsage(15000, 128000, 12);

		tracer.endPrompt(p1, "end_turn");

		// 4. Context injection
		tracer.recordContextInjection("Use OrbStack", false);

		// 5. Second prompt
		const p2 = tracer.startPrompt(2, "Verify containers");
		tracer.endPrompt(p2, "end_turn");

		// 6. Shutdown — collect before provider clears the exporter
		const allSpans = await shutdownAndCollect(tracer, exporter, provider);

		// ── Assertions ─────────────────────────────────────────────────────

		// Verify all span types were created
		const spanNames = allSpans.map((s) => s.name);
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

		// All spans share the same trace ID
		const traceIds = new Set(allSpans.map((s) => s.spanContext().traceId));
		expect(traceIds.size).toBe(1);

		// Two prompt spans
		const prompts = allSpans.filter((s) => s.name === "agent.prompt");
		expect(prompts.length).toBe(2);

		// Session span has context injection event
		const session = allSpans.find((s) => s.name === "agent.session")!;
		const ctxEvent = session.events.find((e) => e.name === "context.injected");
		expect(ctxEvent).toBeDefined();

		// All spans completed successfully (no ERROR statuses expected here)
		for (const span of allSpans) {
			expect(span.status.code).toBe(SpanStatusCode.OK);
		}

		// Agent identity is on the session span
		expect(attr(session, "agent.id")).toBe("full-test");
		expect(attr(session, "agent.name")).toBe("Full Agent");
	});

	it("all spans share the same traceId across the entire lifecycle", async () => {
		const { tracer, exporter, provider } = createTestTracer();
		tracer.startSession();

		const init = tracer.startInitialize();
		tracer.endInitialize(init);

		const p = tracer.startPrompt(1, "test");
		tracer.startToolCall({ toolCallId: "tc-1", title: "T" });
		tracer.endToolCall("tc-1", "completed", 0);
		tracer.endPrompt(p, "end_turn");

		const spans = await shutdownAndCollect(tracer, exporter, provider);

		const traceIds = new Set(spans.map((s) => s.spanContext().traceId));
		expect(traceIds.size).toBe(1);
	});

	it("every non-root span has a parentSpanContext", async () => {
		const { tracer, exporter, provider } = createTestTracer();
		tracer.startSession();

		const init = tracer.startInitialize();
		const phase = tracer.startInitPhase("spawn-process", init);
		tracer.endInitialize(phase);
		tracer.endInitialize(init);

		const p = tracer.startPrompt(1, "test");
		const fs = tracer.startFs({ path: "/x", operation: "read" });
		tracer.endFs(fs, 10);
		tracer.endPrompt(p, "end_turn");

		const spans = await shutdownAndCollect(tracer, exporter, provider);

		for (const span of spans) {
			if (span.name === "agent.session") {
				// Root span — no parent
				continue;
			}
			const parent = parentSpanId(span);
			expect(parent).toBeDefined();
			expect(parent?.length).toBe(16);
		}
	});

	it("tool call and permission share the same parent-child chain", async () => {
		const { tracer, exporter, provider } = createTestTracer();
		tracer.startSession();
		tracer.startPrompt(1, "test");

		tracer.startToolCall({
			toolCallId: "tc-1",
			title: "Docker check",
			kind: "execute",
		});

		const perm = tracer.startPermission({
			toolCallId: "tc-1",
			toolCallTitle: "Docker check",
		});
		tracer.endPermission(perm, "granted", {
			optionId: "allow_once",
			optionName: "Allow once",
		});
		tracer.endToolCall("tc-1", "completed", 0);

		const spans = await shutdownAndCollect(tracer, exporter, provider);

		const toolSpan = spans.find((s) => s.name === "agent.tool_call")!;
		const permSpan = spans.find((s) => s.name === "agent.permission")!;

		// Permission should be a child of the tool call
		const permParent = parentSpanId(permSpan);
		expect(permParent).toBe(toolSpan.spanContext().spanId);

		// All in the same trace
		expect(permSpan.spanContext().traceId).toBe(toolSpan.spanContext().traceId);
	});

	it("spans have realistic span IDs (16 hex chars)", async () => {
		const { tracer, exporter, provider } = createTestTracer();
		tracer.startSession();

		const init = tracer.startInitialize();
		tracer.endInitialize(init);

		const spans = await shutdownAndCollect(tracer, exporter, provider);

		for (const span of spans) {
			expect(span.spanContext().spanId).toMatch(/^[a-f0-9]{16}$/);
			expect(span.spanContext().traceId).toMatch(/^[a-f0-9]{32}$/);
		}
	});

	it("error in one prompt does not affect the next prompt", async () => {
		const { tracer, exporter, provider } = createTestTracer();
		tracer.startSession();

		// First prompt fails
		const p1 = tracer.startPrompt(1, "failing prompt");
		tracer.endPrompt(p1, undefined, new Error("timeout"));

		// Second prompt succeeds
		const p2 = tracer.startPrompt(2, "succeeding prompt");
		tracer.endPrompt(p2, "end_turn");

		const spans = await shutdownAndCollect(tracer, exporter, provider);

		const prompts = spans.filter((s) => s.name === "agent.prompt");
		expect(prompts.length).toBe(2);

		const first = prompts.find((s) => attr(s, "prompt.index") === 1)!;
		const second = prompts.find((s) => attr(s, "prompt.index") === 2)!;

		expect(first.status.code).toBe(SpanStatusCode.ERROR);
		expect(second.status.code).toBe(SpanStatusCode.OK);
	});
});
