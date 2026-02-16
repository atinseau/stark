import { describe, expect, it } from "bun:test";

import { AgentEvent } from "../../../enums/agent-event.enum.ts";
import { ContextTracker } from "../context-tracker.ts";
import type { ContextDelta, SubTask } from "../types.ts";

// ════════════════════════════════════════════════════════════════════════════
// Concurrency Tests
// ════════════════════════════════════════════════════════════════════════════

describe("Concurrency", () => {
	it("multiple agents can be tracked simultaneously", () => {
		const tracker = new ContextTracker();
		const subtask: SubTask = {
			id: "test",
			prompt: "task",
			role: "role",
			dependencies: [],
			priority: 1,
		};

		// Register many agents
		for (let i = 0; i < 10; i++) {
			tracker.registerAgent(`agent-${i}`, `Agent ${i}`, {
				...subtask,
				id: `subtask-${i}`,
			});
		}

		expect(tracker.agentCount).toBe(10);

		// Process events for different agents concurrently
		const deltas: ContextDelta[] = [];
		for (let i = 0; i < 10; i++) {
			const delta = tracker.processEvent(
				`agent-${i}`,
				AgentEvent.PROMPT_COMPLETE,
				{
					stopReason: "end_turn",
					fullText: `Response from agent ${i}`,
				},
			);
			if (delta) deltas.push(delta);
		}

		expect(deltas).toHaveLength(10);

		// Verify each delta has the correct agent ID
		for (let i = 0; i < 10; i++) {
			expect(deltas[i]!.agentId).toBe(`agent-${i}`);
		}
	});

	it("concurrent event processing doesn't corrupt state", () => {
		const tracker = new ContextTracker();
		const subtask: SubTask = {
			id: "t1",
			prompt: "task",
			role: "role",
			dependencies: [],
			priority: 1,
		};

		tracker.registerAgent("agent-1", "Alpha", subtask);

		// Simulate rapid concurrent events
		for (let i = 0; i < 100; i++) {
			tracker.processEvent("agent-1", AgentEvent.FS_WRITE, {
				path: `file-${i % 20}.ts`, // Some will be duplicates
				contentLength: i * 10,
			});
		}

		const state = tracker.getAgentState("agent-1");
		// Should have at most 20 unique files
		expect(state!.filesWritten.length).toBeLessThanOrEqual(20);
		expect(state!.filesWritten.length).toBeGreaterThan(0);
	});
});
