import { beforeEach, describe, expect, it } from "bun:test";

import { AgentEvent } from "../../../enums/agent-event.enum.ts";
import { AgentStatus } from "../../../enums/agent-status.enum.ts";
import { DeltaType } from "../../../enums/delta-type.enum.ts";
import type { PromptResult } from "../../../types/agent.types.ts";
import type { SubTask } from "../../../types/agent-pool.types.ts";
import { ContextTracker } from "../context-tracker.ts";

describe("ContextTracker", () => {
	let tracker: ContextTracker;

	beforeEach(() => {
		tracker = new ContextTracker();
	});

	const subtask: SubTask = {
		id: "test-subtask",
		prompt: "Do something",
		role: "test-role",
		dependencies: [],
		priority: 1,
	};

	it("registers and retrieves an agent", () => {
		tracker.registerAgent("agent-1", "Alpha", subtask);

		const state = tracker.getAgentState("agent-1");
		expect(state).toBeDefined();
		expect(state!.agentId).toBe("agent-1");
		expect(state!.agentName).toBe("Alpha");
		expect(state!.taskDescription).toBe("Do something");
		expect(state!.taskRole).toBe("test-role");
		expect(state!.status).toBe(AgentStatus.INITIALIZING);
		expect(state!.completed).toBe(false);
		expect(state!.error).toBeNull();
		expect(state!.events).toHaveLength(0);
	});

	it("returns undefined for unregistered agent", () => {
		expect(tracker.getAgentState("nonexistent")).toBeUndefined();
	});

	it("unregisters an agent", () => {
		tracker.registerAgent("agent-1", "Alpha", subtask);
		tracker.unregisterAgent("agent-1");
		expect(tracker.getAgentState("agent-1")).toBeUndefined();
		expect(tracker.agentCount).toBe(0);
	});

	it("processes a prompt:complete event and returns a delta", () => {
		tracker.registerAgent("agent-1", "Alpha", subtask);

		const delta = tracker.processEvent("agent-1", AgentEvent.PROMPT_COMPLETE, {
			timestamp: "2025-01-01T00:00:00.000Z",
			stopReason: "end_turn",
			fullText: "Response text here",
			usage: { inputTokens: 100, outputTokens: 50 },
		});

		expect(delta).not.toBeNull();
		expect(delta!.agentId).toBe("agent-1");
		expect(delta!.agentName).toBe("Alpha");
		expect(delta!.type).toBe(DeltaType.PROMPT_COMPLETE);
		expect(delta!.significance).toBe(0.8);
		expect(delta!.summary).toContain("Prompt completed");
	});

	it("processes a tool:complete event and returns a delta", () => {
		tracker.registerAgent("agent-1", "Alpha", subtask);

		const delta = tracker.processEvent("agent-1", AgentEvent.TOOL_COMPLETE, {
			timestamp: "2025-01-01T00:00:00.000Z",
			toolCallId: "tc-1",
			title: "Write file",
			command: "echo hello",
			exitCode: 0,
			output: "hello",
		});

		expect(delta).not.toBeNull();
		expect(delta!.type).toBe(DeltaType.TOOL_COMPLETE);
		expect(delta!.significance).toBe(0.5);
		expect(delta!.summary).toContain("Tool completed");
		expect(delta!.summary).toContain("Write file");
	});

	it("returns null for low-significance events that have no mapping", () => {
		tracker.registerAgent("agent-1", "Alpha", subtask);

		const delta = tracker.processEvent("agent-1", AgentEvent.PROMPT_CHUNK, {
			text: "some chunk",
		});

		expect(delta).toBeNull();
	});

	it("returns null for events from unregistered agents", () => {
		const delta = tracker.processEvent(
			"nonexistent",
			AgentEvent.PROMPT_COMPLETE,
			{},
		);
		expect(delta).toBeNull();
	});

	it("records events even when they don't produce a delta", () => {
		tracker.registerAgent("agent-1", "Alpha", subtask);

		// PROMPT_CHUNK is not in EVENT_SIGNIFICANCE but still gets recorded
		tracker.processEvent("agent-1", AgentEvent.PROMPT_CHUNK, { text: "chunk" });

		const state = tracker.getAgentState("agent-1");
		expect(state!.events.length).toBeGreaterThanOrEqual(1);
	});

	it("updates status on agent lifecycle events", () => {
		tracker.registerAgent("agent-1", "Alpha", subtask);

		tracker.processEvent("agent-1", AgentEvent.AGENT_READY, {
			sessionId: "session-1",
		});
		expect(tracker.getAgentState("agent-1")!.status).toBe(AgentStatus.IDLE);

		tracker.processEvent("agent-1", AgentEvent.AGENT_BUSY, {
			promptText: "do something",
		});
		expect(tracker.getAgentState("agent-1")!.status).toBe(AgentStatus.BUSY);

		tracker.processEvent("agent-1", AgentEvent.AGENT_IDLE, {
			previousStatus: AgentStatus.BUSY,
		});
		expect(tracker.getAgentState("agent-1")!.status).toBe(AgentStatus.IDLE);
	});

	it("tracks files written", () => {
		tracker.registerAgent("agent-1", "Alpha", subtask);

		tracker.processEvent("agent-1", AgentEvent.FS_WRITE, {
			path: "src/index.ts",
			contentLength: 100,
		});

		tracker.processEvent("agent-1", AgentEvent.FS_WRITE, {
			path: "src/utils.ts",
			contentLength: 50,
		});

		// Duplicate should not be added twice
		tracker.processEvent("agent-1", AgentEvent.FS_WRITE, {
			path: "src/index.ts",
			contentLength: 120,
		});

		const state = tracker.getAgentState("agent-1");
		expect(state!.filesWritten).toEqual(["src/index.ts", "src/utils.ts"]);
	});

	it("tracks files read", () => {
		tracker.registerAgent("agent-1", "Alpha", subtask);

		tracker.processEvent("agent-1", AgentEvent.FS_READ, {
			path: "package.json",
			contentLength: 200,
		});

		const state = tracker.getAgentState("agent-1");
		expect(state!.filesRead).toEqual(["package.json"]);
	});

	it("marks an agent as completed", () => {
		tracker.registerAgent("agent-1", "Alpha", subtask);
		tracker.markCompleted("agent-1");

		const state = tracker.getAgentState("agent-1");
		expect(state!.completed).toBe(true);
		expect(state!.status).toBe(AgentStatus.IDLE);
	});

	it("marks an agent as failed", () => {
		tracker.registerAgent("agent-1", "Alpha", subtask);
		tracker.markFailed("agent-1", "Something broke");

		const state = tracker.getAgentState("agent-1");
		expect(state!.completed).toBe(true);
		expect(state!.error).toBe("Something broke");
		expect(state!.status).toBe(AgentStatus.ERROR);
	});

	it("records prompt results", () => {
		tracker.registerAgent("agent-1", "Alpha", subtask);

		const result: PromptResult = {
			stopReason: "end_turn",
			text: "Response",
			usage: null,
		};

		tracker.recordPromptResult("agent-1", result);

		const state = tracker.getAgentState("agent-1");
		expect(state!.promptResults).toHaveLength(1);
		expect(state!.promptResults[0]).toBe(result);
	});

	it("getOtherAgentStates excludes the specified agent", () => {
		tracker.registerAgent("agent-1", "Alpha", subtask);
		tracker.registerAgent("agent-2", "Beta", subtask);
		tracker.registerAgent("agent-3", "Gamma", subtask);

		const others = tracker.getOtherAgentStates("agent-2");
		expect(others).toHaveLength(2);
		expect(others.map((s) => s.agentId)).toEqual(
			expect.arrayContaining(["agent-1", "agent-3"]),
		);
		expect(others.map((s) => s.agentId)).not.toContain("agent-2");
	});

	it("allCompleted returns true only when all agents are done", () => {
		tracker.registerAgent("agent-1", "Alpha", subtask);
		tracker.registerAgent("agent-2", "Beta", subtask);

		expect(tracker.allCompleted).toBe(false);

		tracker.markCompleted("agent-1");
		expect(tracker.allCompleted).toBe(false);

		tracker.markCompleted("agent-2");
		expect(tracker.allCompleted).toBe(true);
	});

	it("allCompleted returns true for empty tracker", () => {
		expect(tracker.allCompleted).toBe(true);
	});

	it("getGlobalSummary produces readable output", () => {
		tracker.registerAgent("agent-1", "Alpha", subtask);
		tracker.registerAgent("agent-2", "Beta", subtask);

		tracker.markCompleted("agent-1");
		tracker.markFailed("agent-2", "Network error");

		const summary = tracker.getGlobalSummary();
		expect(summary).toContain("Alpha");
		expect(summary).toContain("Beta");
		expect(summary).toContain("Completed");
		expect(summary).toContain("Failed");
		expect(summary).toContain("Network error");
	});

	it("enforces maximum events per agent", () => {
		tracker.registerAgent("agent-1", "Alpha", subtask);

		// Add 250 events (above the 200 limit)
		for (let i = 0; i < 250; i++) {
			tracker.processEvent("agent-1", AgentEvent.FS_READ, {
				path: `file-${i}.ts`,
				contentLength: i,
			});
		}

		const state = tracker.getAgentState("agent-1");
		expect(state!.events.length).toBeLessThanOrEqual(200);
	});

	it("updates lastDelta when a significant event is processed", () => {
		tracker.registerAgent("agent-1", "Alpha", subtask);

		expect(tracker.getAgentState("agent-1")!.lastDelta).toBeNull();

		tracker.processEvent("agent-1", AgentEvent.TOOL_COMPLETE, {
			toolCallId: "tc-1",
			title: "Read file",
		});

		expect(tracker.getAgentState("agent-1")!.lastDelta).not.toBeNull();
		expect(tracker.getAgentState("agent-1")!.lastDelta!.type).toBe(
			DeltaType.TOOL_COMPLETE,
		);
	});

	it("handles agent:error and records the error message", () => {
		tracker.registerAgent("agent-1", "Alpha", subtask);

		const delta = tracker.processEvent("agent-1", AgentEvent.AGENT_ERROR, {
			error: new Error("Connection failed"),
			context: "prompt #1",
		});

		expect(delta).not.toBeNull();
		expect(delta!.type).toBe(DeltaType.AGENT_ERROR);
		expect(delta!.significance).toBe(1.0);
		expect(tracker.getAgentState("agent-1")!.error).toBe("Connection failed");
	});
});
