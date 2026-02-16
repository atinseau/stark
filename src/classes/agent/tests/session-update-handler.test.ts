import { describe, expect, it, mock } from "bun:test";
import pino from "pino";
import { AgentEvent } from "../../../enums/agent-event.enum.ts";
import type { EmitEventFn } from "../../../types/observability.types.ts";
import type { Tracer } from "../../tracer/tracer.ts";
import { AgentSessionUpdateHandler } from "../agent-session-update-handler.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Creates a silent pino logger for testing. */
function silentLogger(): pino.Logger {
	return pino({ level: "silent" });
}

/**
 * Creates a minimal no-op Tracer mock.
 *
 * Exposes the generic API (`startOperation`, `trackSpan`, `getTrackedSpan`,
 * `removeTrackedSpan`, `recordEvent`) that the tracer helper functions use.
 * Domain-specific methods have been extracted to `./tracer-helpers/` and
 * operate on this generic API.
 */
function noopTracer(): Tracer {
	/** Backing store for tracked spans so helpers can retrieve them. */
	const tracked = new Map<string, { span: any; label: string }>();

	/** A minimal mock span that satisfies the Span interface. */
	const mockSpan = () => ({
		setAttribute: mock(() => {}),
		setAttributes: mock(() => {}),
		addEvent: mock(() => {}),
		setStatus: mock(() => {}),
		end: mock(() => {}),
		isRecording: () => true,
		recordException: mock(() => {}),
		spanContext: () => ({
			traceId: "0".repeat(32),
			spanId: "0".repeat(16),
			traceFlags: 0,
		}),
		updateName: mock(() => {}),
		addLink: mock(() => {}),
		addLinks: mock(() => {}),
	});

	return {
		enabled: false,
		startRootSpan: mock(() => mockSpan()),
		endRootSpan: mock(() => {}),
		startActiveSpan: mock(() => mockSpan()),
		endActiveSpan: mock(() => {}),
		getTraceContext: mock(() => undefined),
		startOperation: mock(() => mockSpan()),
		endOperation: mock(() => {}),
		traced: mock(async (_name: string, work: (span: any) => Promise<any>) =>
			work(mockSpan()),
		),
		trackSpan: mock((id: string, span: any, label: string = "operation") => {
			tracked.set(id, { span, label });
		}),
		getTrackedSpan: mock((id: string) => tracked.get(id)?.span),
		removeTrackedSpan: mock((id: string) => {
			const entry = tracked.get(id);
			tracked.delete(id);
			return entry?.span;
		}),
		recordEvent: mock(() => {}),
		flush: mock(async () => {}),
		shutdown: mock(async () => {}),
	} as unknown as Tracer;
}

/**
 * Collects emitted events into a map keyed by event type.
 * Returns both the emitEvent callback and the collected events.
 */
function createEventCollector() {
	const events = new Map<string, any[]>();

	const emitEvent: EmitEventFn = (event, payload) => {
		if (!events.has(event)) {
			events.set(event, []);
		}
		events.get(event)?.push(payload);
	};

	return { emitEvent, events };
}

/** Helper to get collected events of a specific type. */
function getEvents(events: Map<string, any[]>, event: AgentEvent): any[] {
	return events.get(event) ?? [];
}

// ── AgentSessionUpdateHandler — Initial State ───────────────────────────────────

describe("AgentSessionUpdateHandler — Initial State", () => {
	it("starts with empty response text", () => {
		const { emitEvent } = createEventCollector();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			noopTracer(),
			emitEvent,
		);

		expect(handler.responseText).toBe("");
	});
});

// ── AgentSessionUpdateHandler — Response Text ───────────────────────────────────

describe("AgentSessionUpdateHandler — Response Text", () => {
	it("accumulates text from agent_message_chunk updates", () => {
		const { emitEvent } = createEventCollector();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			noopTracer(),
			emitEvent,
		);

		handler.handle({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "Hello " },
		} as any);

		handler.handle({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "world!" },
		} as any);

		expect(handler.responseText).toBe("Hello world!");
	});

	it("resetResponseText clears accumulated text", () => {
		const { emitEvent } = createEventCollector();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			noopTracer(),
			emitEvent,
		);

		handler.handle({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "Some text" },
		} as any);

		handler.resetResponseText();

		expect(handler.responseText).toBe("");
	});

	it("ignores non-text content types in agent_message_chunk", () => {
		const { emitEvent, events } = createEventCollector();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			noopTracer(),
			emitEvent,
		);

		handler.handle({
			sessionUpdate: "agent_message_chunk",
			content: { type: "image", data: "base64..." },
		} as any);

		expect(handler.responseText).toBe("");
		expect(getEvents(events, AgentEvent.PROMPT_CHUNK)).toHaveLength(0);
	});
});

// ── AgentSessionUpdateHandler — agent_message_chunk Events ──────────────────────

describe("AgentSessionUpdateHandler — agent_message_chunk", () => {
	it("emits PROMPT_CHUNK with the text content", () => {
		const { emitEvent, events } = createEventCollector();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			noopTracer(),
			emitEvent,
		);

		handler.handle({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "chunk data" },
		} as any);

		const chunks = getEvents(events, AgentEvent.PROMPT_CHUNK);
		expect(chunks).toHaveLength(1);
		expect(chunks[0].text).toBe("chunk data");
	});
});

// ── AgentSessionUpdateHandler — agent_thought_chunk Events ──────────────────────

describe("AgentSessionUpdateHandler — agent_thought_chunk", () => {
	it("emits PROMPT_THOUGHT with the text content", () => {
		const { emitEvent, events } = createEventCollector();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			noopTracer(),
			emitEvent,
		);

		handler.handle({
			sessionUpdate: "agent_thought_chunk",
			content: { type: "text", text: "I need to think about this..." },
		} as any);

		const thoughts = getEvents(events, AgentEvent.PROMPT_THOUGHT);
		expect(thoughts).toHaveLength(1);
		expect(thoughts[0].text).toBe("I need to think about this...");
	});

	it("does not accumulate thought text in responseText", () => {
		const { emitEvent } = createEventCollector();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			noopTracer(),
			emitEvent,
		);

		handler.handle({
			sessionUpdate: "agent_thought_chunk",
			content: { type: "text", text: "Thinking..." },
		} as any);

		expect(handler.responseText).toBe("");
	});

	it("ignores non-text content in thought chunks", () => {
		const { emitEvent, events } = createEventCollector();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			noopTracer(),
			emitEvent,
		);

		handler.handle({
			sessionUpdate: "agent_thought_chunk",
			content: { type: "image", data: "..." },
		} as any);

		expect(getEvents(events, AgentEvent.PROMPT_THOUGHT)).toHaveLength(0);
	});
});

// ── AgentSessionUpdateHandler — user_message_chunk ──────────────────────────────

describe("AgentSessionUpdateHandler — user_message_chunk", () => {
	it("does not emit any event for user message echoes", () => {
		const { emitEvent, events } = createEventCollector();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			noopTracer(),
			emitEvent,
		);

		handler.handle({
			sessionUpdate: "user_message_chunk",
			content: { type: "text", text: "echo" },
		} as any);

		expect(events.size).toBe(0);
	});

	it("does not accumulate user message text in responseText", () => {
		const { emitEvent } = createEventCollector();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			noopTracer(),
			emitEvent,
		);

		handler.handle({
			sessionUpdate: "user_message_chunk",
			content: { type: "text", text: "echo" },
		} as any);

		expect(handler.responseText).toBe("");
	});
});

// ── AgentSessionUpdateHandler — tool_call Events ────────────────────────────────

describe("AgentSessionUpdateHandler — tool_call", () => {
	it("emits TOOL_START with all fields", () => {
		const { emitEvent, events } = createEventCollector();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			noopTracer(),
			emitEvent,
		);

		handler.handle({
			sessionUpdate: "tool_call",
			toolCallId: "tc-1",
			title: "Run tests",
			kind: "execute",
			status: "in_progress",
			locations: [{ path: "/src/test.ts" }],
			rawInput: { command: "bun test" },
		} as any);

		const starts = getEvents(events, AgentEvent.TOOL_START);
		expect(starts).toHaveLength(1);
		expect(starts[0].toolCallId).toBe("tc-1");
		expect(starts[0].title).toBe("Run tests");
		expect(starts[0].kind).toBe("execute");
		expect(starts[0].command).toBe("bun test");
	});

	it("starts a tracer tool call span", () => {
		const { emitEvent } = createEventCollector();
		const tracer = noopTracer();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			tracer,
			emitEvent,
		);

		handler.handle({
			sessionUpdate: "tool_call",
			toolCallId: "tc-2",
			title: "Edit file",
			kind: "edit",
			rawInput: null,
		} as any);

		expect(tracer.startOperation).toHaveBeenCalledTimes(1);
		expect(tracer.trackSpan).toHaveBeenCalledTimes(1);
	});

	it("handles tool_call with no kind or locations", () => {
		const { emitEvent, events } = createEventCollector();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			noopTracer(),
			emitEvent,
		);

		handler.handle({
			sessionUpdate: "tool_call",
			toolCallId: "tc-3",
			title: "Simple tool",
			rawInput: null,
		} as any);

		const starts = getEvents(events, AgentEvent.TOOL_START);
		expect(starts).toHaveLength(1);
		expect(starts[0].kind).toBeUndefined();
		expect(starts[0].locations).toBeUndefined();
	});
});

// ── AgentSessionUpdateHandler — tool_call_update Events ─────────────────────────

describe("AgentSessionUpdateHandler — tool_call_update", () => {
	it("emits TOOL_UPDATE for in-progress updates", () => {
		const { emitEvent, events } = createEventCollector();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			noopTracer(),
			emitEvent,
		);

		// First register the tool call
		handler.handle({
			sessionUpdate: "tool_call",
			toolCallId: "tc-10",
			title: "Run build",
			kind: "execute",
			rawInput: { command: "npm run build" },
		} as any);

		// Then send an update
		handler.handle({
			sessionUpdate: "tool_call_update",
			toolCallId: "tc-10",
			status: "in_progress",
			rawOutput: { content: "Building..." },
		} as any);

		const updates = getEvents(events, AgentEvent.TOOL_UPDATE);
		expect(updates).toHaveLength(1);
		expect(updates[0].toolCallId).toBe("tc-10");
		expect(updates[0].status).toBe("in_progress");
	});

	it("emits TOOL_COMPLETE when status is 'completed'", () => {
		const { emitEvent, events } = createEventCollector();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			noopTracer(),
			emitEvent,
		);

		handler.handle({
			sessionUpdate: "tool_call",
			toolCallId: "tc-11",
			title: "Run tests",
			kind: "execute",
			rawInput: { command: "bun test" },
		} as any);

		handler.handle({
			sessionUpdate: "tool_call_update",
			toolCallId: "tc-11",
			status: "completed",
			rawOutput: {
				content: "All tests passed\n\n\nProcess exited with code: 0",
			},
		} as any);

		const completes = getEvents(events, AgentEvent.TOOL_COMPLETE);
		expect(completes).toHaveLength(1);
		expect(completes[0].toolCallId).toBe("tc-11");
		expect(completes[0].title).toBe("Run tests");
		expect(completes[0].command).toBe("bun test");
	});

	it("emits TOOL_FAILED when status is 'failed'", () => {
		const { emitEvent, events } = createEventCollector();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			noopTracer(),
			emitEvent,
		);

		handler.handle({
			sessionUpdate: "tool_call",
			toolCallId: "tc-12",
			title: "Run lint",
			kind: "execute",
			rawInput: { command: "eslint ." },
		} as any);

		handler.handle({
			sessionUpdate: "tool_call_update",
			toolCallId: "tc-12",
			status: "failed",
			rawOutput: {
				content: "Error: lint failed\n\n\nProcess exited with code: 1",
			},
		} as any);

		const failures = getEvents(events, AgentEvent.TOOL_FAILED);
		expect(failures).toHaveLength(1);
		expect(failures[0].toolCallId).toBe("tc-12");
		expect(failures[0].title).toBe("Run lint");
	});

	it("ends tracer tool call span on completion", () => {
		const { emitEvent } = createEventCollector();
		const tracer = noopTracer();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			tracer,
			emitEvent,
		);

		handler.handle({
			sessionUpdate: "tool_call",
			toolCallId: "tc-13",
			title: "Something",
			rawInput: null,
		} as any);

		handler.handle({
			sessionUpdate: "tool_call_update",
			toolCallId: "tc-13",
			status: "completed",
			rawOutput: null,
		} as any);

		expect(tracer.removeTrackedSpan).toHaveBeenCalledTimes(1);
	});

	it("updates tracer tool call span on in-progress", () => {
		const { emitEvent } = createEventCollector();
		const tracer = noopTracer();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			tracer,
			emitEvent,
		);

		handler.handle({
			sessionUpdate: "tool_call",
			toolCallId: "tc-14",
			title: "Something",
			rawInput: null,
		} as any);

		handler.handle({
			sessionUpdate: "tool_call_update",
			toolCallId: "tc-14",
			status: "in_progress",
			rawOutput: { content: "Working..." },
		} as any);

		expect(tracer.getTrackedSpan).toHaveBeenCalledTimes(1);
	});

	it("uses toolCallId as fallback title for unknown tool calls", () => {
		const { emitEvent, events } = createEventCollector();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			noopTracer(),
			emitEvent,
		);

		// Send update without prior tool_call registration
		handler.handle({
			sessionUpdate: "tool_call_update",
			toolCallId: "unknown-tc",
			status: "completed",
			rawOutput: null,
		} as any);

		const completes = getEvents(events, AgentEvent.TOOL_COMPLETE);
		expect(completes).toHaveLength(1);
		expect(completes[0].title).toBe("unknown-tc");
	});

	it("updates tracked title when tool_call_update provides a new one", () => {
		const { emitEvent, events } = createEventCollector();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			noopTracer(),
			emitEvent,
		);

		handler.handle({
			sessionUpdate: "tool_call",
			toolCallId: "tc-15",
			title: "Original Title",
			rawInput: null,
		} as any);

		handler.handle({
			sessionUpdate: "tool_call_update",
			toolCallId: "tc-15",
			title: "Updated Title",
			status: "completed",
			rawOutput: null,
		} as any);

		const completes = getEvents(events, AgentEvent.TOOL_COMPLETE);
		expect(completes).toHaveLength(1);
		expect(completes[0].title).toBe("Updated Title");
	});
});

// ── AgentSessionUpdateHandler — plan Events ─────────────────────────────────────

describe("AgentSessionUpdateHandler — plan", () => {
	it("emits PLAN_UPDATE with entries", () => {
		const { emitEvent, events } = createEventCollector();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			noopTracer(),
			emitEvent,
		);

		const entries = [
			{ content: "Step 1", status: "completed", priority: "high" },
			{ content: "Step 2", status: "in_progress", priority: "medium" },
			{ content: "Step 3", status: "pending", priority: "low" },
		];

		handler.handle({
			sessionUpdate: "plan",
			entries,
		} as any);

		const plans = getEvents(events, AgentEvent.PLAN_UPDATE);
		expect(plans).toHaveLength(1);
		expect(plans[0].entries).toEqual(entries);
	});
});

// ── AgentSessionUpdateHandler — current_mode_update Events ──────────────────────

describe("AgentSessionUpdateHandler — current_mode_update", () => {
	it("emits MODE_CHANGE with the mode ID", () => {
		const { emitEvent, events } = createEventCollector();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			noopTracer(),
			emitEvent,
		);

		handler.handle({
			sessionUpdate: "current_mode_update",
			currentModeId: "architect",
		} as any);

		const modes = getEvents(events, AgentEvent.MODE_CHANGE);
		expect(modes).toHaveLength(1);
		expect(modes[0].modeId).toBe("architect");
	});
});

// ── AgentSessionUpdateHandler — config_option_update Events ─────────────────────

describe("AgentSessionUpdateHandler — config_option_update", () => {
	it("emits CONFIG_UPDATE with config options", () => {
		const { emitEvent, events } = createEventCollector();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			noopTracer(),
			emitEvent,
		);

		const configOptions = [{ id: "opt-1", name: "Model", value: "gpt-4" }];

		handler.handle({
			sessionUpdate: "config_option_update",
			configOptions,
		} as any);

		const configs = getEvents(events, AgentEvent.CONFIG_UPDATE);
		expect(configs).toHaveLength(1);
		expect(configs[0].configOptions).toEqual(configOptions);
	});
});

// ── AgentSessionUpdateHandler — usage_update Events ─────────────────────────────

describe("AgentSessionUpdateHandler — usage_update", () => {
	it("emits USAGE_UPDATE with computed percent", () => {
		const { emitEvent, events } = createEventCollector();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			noopTracer(),
			emitEvent,
		);

		handler.handle({
			sessionUpdate: "usage_update",
			used: 5000,
			size: 10000,
			cost: { amount: 0.05, currency: "USD" },
		} as any);

		const usage = getEvents(events, AgentEvent.USAGE_UPDATE);
		expect(usage).toHaveLength(1);
		expect(usage[0].contextUsed).toBe(5000);
		expect(usage[0].contextSize).toBe(10000);
		expect(usage[0].contextPercent).toBe(50);
		expect(usage[0].cost).toEqual({ amount: 0.05, currency: "USD" });
	});

	it("computes 0% when size is 0", () => {
		const { emitEvent, events } = createEventCollector();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			noopTracer(),
			emitEvent,
		);

		handler.handle({
			sessionUpdate: "usage_update",
			used: 0,
			size: 0,
		} as any);

		const usage = getEvents(events, AgentEvent.USAGE_UPDATE);
		expect(usage[0].contextPercent).toBe(0);
	});

	it("rounds percent to nearest integer", () => {
		const { emitEvent, events } = createEventCollector();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			noopTracer(),
			emitEvent,
		);

		handler.handle({
			sessionUpdate: "usage_update",
			used: 3333,
			size: 10000,
		} as any);

		const usage = getEvents(events, AgentEvent.USAGE_UPDATE);
		expect(usage[0].contextPercent).toBe(33);
	});

	it("records usage in the tracer", () => {
		const { emitEvent } = createEventCollector();
		const tracer = noopTracer();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			tracer,
			emitEvent,
		);

		handler.handle({
			sessionUpdate: "usage_update",
			used: 7500,
			size: 10000,
		} as any);

		expect(tracer.recordEvent).toHaveBeenCalledTimes(1);
		expect(tracer.recordEvent).toHaveBeenCalledWith("auto", "usage.update", {
			"usage.context_used": 7500,
			"usage.context_size": 10000,
			"usage.context_percent": 75,
		});
	});
});

// ── AgentSessionUpdateHandler — session_info_update ─────────────────────────────

describe("AgentSessionUpdateHandler — session_info_update", () => {
	it("does not emit any event for session info updates", () => {
		const { emitEvent, events } = createEventCollector();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			noopTracer(),
			emitEvent,
		);

		handler.handle({
			sessionUpdate: "session_info_update",
			title: "My Session",
		} as any);

		expect(events.size).toBe(0);
	});
});

// ── AgentSessionUpdateHandler — available_commands_update ───────────────────────

describe("AgentSessionUpdateHandler — available_commands_update", () => {
	it("does not emit any event for available commands updates", () => {
		const { emitEvent, events } = createEventCollector();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			noopTracer(),
			emitEvent,
		);

		handler.handle({
			sessionUpdate: "available_commands_update",
			availableCommands: [{ id: "cmd-1", name: "test" }],
		} as any);

		expect(events.size).toBe(0);
	});
});

// ── AgentSessionUpdateHandler — Unknown Update Types ────────────────────────────

describe("AgentSessionUpdateHandler — unknown update types", () => {
	it("does not throw for unknown session update types", () => {
		const { emitEvent } = createEventCollector();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			noopTracer(),
			emitEvent,
		);

		expect(() => {
			handler.handle({
				sessionUpdate: "some_future_update_type",
				data: "whatever",
			} as any);
		}).not.toThrow();
	});

	it("does not emit any event for unknown update types", () => {
		const { emitEvent, events } = createEventCollector();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			noopTracer(),
			emitEvent,
		);

		handler.handle({
			sessionUpdate: "unknown_type",
		} as any);

		expect(events.size).toBe(0);
	});
});

// ── AgentSessionUpdateHandler — Multiple Updates Sequence ───────────────────────

describe("AgentSessionUpdateHandler — Multiple Updates Sequence", () => {
	it("handles a realistic sequence of updates", () => {
		const { emitEvent, events } = createEventCollector();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			noopTracer(),
			emitEvent,
		);

		// Agent starts thinking
		handler.handle({
			sessionUpdate: "agent_thought_chunk",
			content: { type: "text", text: "Let me analyze this..." },
		} as any);

		// Agent sends a message
		handler.handle({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "I'll create a file for you." },
		} as any);

		// Tool call starts
		handler.handle({
			sessionUpdate: "tool_call",
			toolCallId: "tc-seq-1",
			title: "Create file",
			kind: "edit",
			rawInput: null,
		} as any);

		// Tool call completes
		handler.handle({
			sessionUpdate: "tool_call_update",
			toolCallId: "tc-seq-1",
			status: "completed",
			rawOutput: null,
		} as any);

		// More agent text
		handler.handle({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: " Done!" },
		} as any);

		// Usage update
		handler.handle({
			sessionUpdate: "usage_update",
			used: 1000,
			size: 10000,
		} as any);

		// Verify accumulated response text
		expect(handler.responseText).toBe("I'll create a file for you. Done!");

		// Verify all events were emitted
		expect(getEvents(events, AgentEvent.PROMPT_THOUGHT)).toHaveLength(1);
		expect(getEvents(events, AgentEvent.PROMPT_CHUNK)).toHaveLength(2);
		expect(getEvents(events, AgentEvent.TOOL_START)).toHaveLength(1);
		expect(getEvents(events, AgentEvent.TOOL_UPDATE)).toHaveLength(1);
		expect(getEvents(events, AgentEvent.TOOL_COMPLETE)).toHaveLength(1);
		expect(getEvents(events, AgentEvent.USAGE_UPDATE)).toHaveLength(1);
	});

	it("can be reset and reused across prompt turns", () => {
		const { emitEvent } = createEventCollector();
		const handler = new AgentSessionUpdateHandler(
			silentLogger(),
			noopTracer(),
			emitEvent,
		);

		// First turn
		handler.handle({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "Turn 1 response" },
		} as any);

		expect(handler.responseText).toBe("Turn 1 response");

		// Reset for next turn
		handler.resetResponseText();
		expect(handler.responseText).toBe("");

		// Second turn
		handler.handle({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "Turn 2 response" },
		} as any);

		expect(handler.responseText).toBe("Turn 2 response");
	});
});
