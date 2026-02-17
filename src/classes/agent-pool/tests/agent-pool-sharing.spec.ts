import { describe, expect, it, mock } from "bun:test";

import { DeltaType } from "../../../enums/delta-type.enum.ts";
import type { ContextDelta, SubTask } from "../../../types/agent-pool.types.ts";
import { AgentPool } from "../agent-pool.ts";
import { createMockAgent, silentPoolConfig } from "./test-helpers.ts";

describe("AgentPool handleDelta — sharing behavior", () => {
	it("uses evaluateWithFullResult for PROMPT_COMPLETE when prompt result exists", async () => {
		const pool = new AgentPool(
			silentPoolConfig({
				createAgent: () => createMockAgent(),
			}),
		);

		const subtask: SubTask = {
			id: "t1",
			prompt: "Do work",
			role: "role1",
			dependencies: [],
			priority: 1,
		};
		const otherSubtask: SubTask = {
			id: "t2",
			prompt: "Do other work",
			role: "role2",
			dependencies: [],
			priority: 2,
		};

		const tracker = (pool as any).contextTracker;
		tracker.registerAgent("agent-1", "Alpha", subtask);
		tracker.registerAgent("agent-2", "Beta", otherSubtask);

		tracker.recordPromptResult("agent-1", {
			stopReason: "end_turn",
			text: "Full response text",
			usage: null,
		});

		const evaluate = mock(async () => []);
		const evaluateWithFullResult = mock(async () => []);
		const mockBroker = {
			evaluate,
			evaluateWithFullResult,
			recordSharing: mock(() => undefined),
			updateSignificanceContext: mock(() => undefined),
		};

		(pool as any).informationBroker = mockBroker;

		const delta: ContextDelta = {
			agentId: "agent-1",
			agentName: "Alpha",
			timestamp: new Date().toISOString(),
			type: DeltaType.PROMPT_COMPLETE,
			summary: "Completed prompt",
			data: {
				responsePreview: "Short preview",
				responseLength: 999,
				isComplete: false,
			},
			significance: 0.9,
			promptResultSummary: null,
		};

		await (pool as any).handleDelta(delta);

		expect(evaluateWithFullResult).toHaveBeenCalledTimes(1);
		expect(evaluate).not.toHaveBeenCalled();

		const args = evaluateWithFullResult.mock.calls[0] as unknown as [
			ContextDelta,
			string,
		];
		expect(args[0]).toBe(delta);
		expect(args[1]).toBe("Full response text");
	});

	it("falls back to evaluate for PROMPT_COMPLETE when no prompt result exists", async () => {
		const pool = new AgentPool(
			silentPoolConfig({
				createAgent: () => createMockAgent(),
			}),
		);

		const subtask: SubTask = {
			id: "t1",
			prompt: "Do work",
			role: "role1",
			dependencies: [],
			priority: 1,
		};
		const otherSubtask: SubTask = {
			id: "t2",
			prompt: "Do other work",
			role: "role2",
			dependencies: [],
			priority: 2,
		};

		const tracker = (pool as any).contextTracker;
		tracker.registerAgent("agent-1", "Alpha", subtask);
		tracker.registerAgent("agent-2", "Beta", otherSubtask);

		const evaluate = mock(async () => []);
		const evaluateWithFullResult = mock(async () => []);
		const mockBroker = {
			evaluate,
			evaluateWithFullResult,
			recordSharing: mock(() => undefined),
			updateSignificanceContext: mock(() => undefined),
		};

		(pool as any).informationBroker = mockBroker;

		const delta: ContextDelta = {
			agentId: "agent-1",
			agentName: "Alpha",
			timestamp: new Date().toISOString(),
			type: DeltaType.PROMPT_COMPLETE,
			summary: "Completed prompt",
			data: {
				responsePreview: "Short preview",
				responseLength: 999,
				isComplete: false,
			},
			significance: 0.9,
			promptResultSummary: null,
		};

		await (pool as any).handleDelta(delta);

		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(evaluateWithFullResult).not.toHaveBeenCalled();
	});

	it("uses standard evaluate for non-prompt deltas", async () => {
		const pool = new AgentPool(
			silentPoolConfig({
				createAgent: () => createMockAgent(),
			}),
		);

		const subtask: SubTask = {
			id: "t1",
			prompt: "Do work",
			role: "role1",
			dependencies: [],
			priority: 1,
		};
		const otherSubtask: SubTask = {
			id: "t2",
			prompt: "Do other work",
			role: "role2",
			dependencies: [],
			priority: 2,
		};

		const tracker = (pool as any).contextTracker;
		tracker.registerAgent("agent-1", "Alpha", subtask);
		tracker.registerAgent("agent-2", "Beta", otherSubtask);

		const evaluate = mock(async () => []);
		const evaluateWithFullResult = mock(async () => []);
		const mockBroker = {
			evaluate,
			evaluateWithFullResult,
			recordSharing: mock(() => undefined),
			updateSignificanceContext: mock(() => undefined),
		};

		(pool as any).informationBroker = mockBroker;

		const delta: ContextDelta = {
			agentId: "agent-1",
			agentName: "Alpha",
			timestamp: new Date().toISOString(),
			type: DeltaType.TOOL_COMPLETE,
			summary: "Tool completed",
			data: {
				toolCallId: "tc-1",
				title: "Write file",
				outputPreview: "ok",
			},
			significance: 0.5,
			promptResultSummary: null,
		};

		await (pool as any).handleDelta(delta);

		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(evaluateWithFullResult).not.toHaveBeenCalled();
	});

	it("skips sharing when only one agent is tracked", async () => {
		const pool = new AgentPool(
			silentPoolConfig({
				createAgent: () => createMockAgent(),
			}),
		);

		const subtask: SubTask = {
			id: "t1",
			prompt: "Do work",
			role: "role1",
			dependencies: [],
			priority: 1,
		};

		const tracker = (pool as any).contextTracker;
		tracker.registerAgent("agent-1", "Alpha", subtask);

		const evaluate = mock(async () => []);
		const mockBroker = {
			evaluate,
			evaluateWithFullResult: mock(async () => []),
			recordSharing: mock(() => undefined),
			updateSignificanceContext: mock(() => undefined),
		};

		(pool as any).informationBroker = mockBroker;

		const delta: ContextDelta = {
			agentId: "agent-1",
			agentName: "Alpha",
			timestamp: new Date().toISOString(),
			type: DeltaType.TOOL_COMPLETE,
			summary: "Tool completed",
			data: {},
			significance: 0.5,
			promptResultSummary: null,
		};

		await (pool as any).handleDelta(delta);

		expect(evaluate).not.toHaveBeenCalled();
	});
});
