import { describe, expect, it, mock } from "bun:test";
import { DeltaType } from "../../../enums/delta-type.enum.ts";
import type { ContextDelta, SubTask } from "../../../types/agent-pool.types.ts";
import { ContextTracker } from "../context-tracker.ts";
import { InformationBroker } from "../information-broker.ts";
import { silentLogger } from "./test-helpers.ts";

// ════════════════════════════════════════════════════════════════════════════
// InformationBroker Unit Tests
// ════════════════════════════════════════════════════════════════════════════

describe("InformationBroker", () => {
	it("skips deltas below significance threshold", async () => {
		const mockConversations = {
			sendOneShotJson: mock(() =>
				Promise.resolve({
					shouldShare: true,
					reasoning: "test",
					information: "info",
				}),
			),
		} as any;
		const tracker = new ContextTracker();
		const broker = new InformationBroker(
			mockConversations,
			tracker,
			[],
			silentLogger(),
			{ significanceThreshold: 0.5 },
		);

		const delta: ContextDelta = {
			agentId: "agent-1",
			agentName: "Alpha",
			timestamp: new Date().toISOString(),
			type: DeltaType.STATUS_CHANGE,
			summary: "Status changed",
			data: {},
			significance: 0.3, // Below threshold
		};

		const decisions = await broker.evaluate(delta);
		expect(decisions).toEqual([]);
		expect(mockConversations.sendOneShotJson).not.toHaveBeenCalled();
	});

	it("returns empty when no other agents exist", async () => {
		const mockConversations = {
			sendOneShotJson: mock(() =>
				Promise.resolve({
					shouldShare: true,
					reasoning: "test",
					information: "info",
				}),
			),
		} as any;
		const tracker = new ContextTracker();

		const subtask: SubTask = {
			id: "t1",
			prompt: "task",
			role: "role",
			dependencies: [],
			priority: 1,
		};
		tracker.registerAgent("agent-1", "Alpha", subtask);

		const broker = new InformationBroker(
			mockConversations,
			tracker,
			[],
			silentLogger(),
		);

		const delta: ContextDelta = {
			agentId: "agent-1",
			agentName: "Alpha",
			timestamp: new Date().toISOString(),
			type: DeltaType.PROMPT_COMPLETE,
			summary: "Prompt completed",
			data: {},
			significance: 0.9,
		};

		const decisions = await broker.evaluate(delta);
		expect(decisions).toEqual([]);
	});

	it("evaluates candidates and returns sharing decisions", async () => {
		const mockConversations = {
			sendOneShotJson: mock(() =>
				Promise.resolve({
					shouldShare: true,
					reasoning: "The API structure is needed for test writing",
					information:
						"The API has endpoints: GET /users, POST /users, DELETE /users/:id",
				}),
			),
		} as any;

		const tracker = new ContextTracker();
		const subtask1: SubTask = {
			id: "t1",
			prompt: "Build API",
			role: "api-dev",
			dependencies: [],
			priority: 1,
		};
		const subtask2: SubTask = {
			id: "t2",
			prompt: "Write tests",
			role: "tester",
			dependencies: ["t1"],
			priority: 2,
		};

		tracker.registerAgent("agent-1", "Alpha", subtask1);
		tracker.registerAgent("agent-2", "Beta", subtask2);

		const broker = new InformationBroker(
			mockConversations,
			tracker,
			[{ from: "t1", to: "t2", type: "informational" }],
			silentLogger(),
		);

		const delta: ContextDelta = {
			agentId: "agent-1",
			agentName: "Alpha",
			timestamp: new Date().toISOString(),
			type: DeltaType.PROMPT_COMPLETE,
			summary: "API implementation complete",
			data: { responsePreview: "Created REST endpoints..." },
			significance: 0.8,
		};

		const decisions = await broker.evaluate(delta);
		expect(decisions).toHaveLength(1);
		expect(decisions[0]!.shouldShare).toBe(true);
		expect(decisions[0]!.sourceAgentId).toBe("agent-1");
		expect(decisions[0]!.targetAgentId).toBe("agent-2");
		expect(decisions[0]!.information).toContain("endpoints");
		expect(broker.evaluationCount).toBe(1);
		expect(broker.shareCount).toBe(1);
	});

	it("excludes completed agents from candidates", async () => {
		const mockConversations = {
			sendOneShotJson: mock(() =>
				Promise.resolve({
					shouldShare: true,
					reasoning: "test",
					information: "info",
				}),
			),
		} as any;

		const tracker = new ContextTracker();
		const subtask1: SubTask = {
			id: "t1",
			prompt: "Task 1",
			role: "role1",
			dependencies: [],
			priority: 1,
		};
		const subtask2: SubTask = {
			id: "t2",
			prompt: "Task 2",
			role: "role2",
			dependencies: [],
			priority: 2,
		};

		tracker.registerAgent("agent-1", "Alpha", subtask1);
		tracker.registerAgent("agent-2", "Beta", subtask2);
		tracker.markCompleted("agent-2"); // Beta is done

		const broker = new InformationBroker(
			mockConversations,
			tracker,
			[],
			silentLogger(),
		);

		const delta: ContextDelta = {
			agentId: "agent-1",
			agentName: "Alpha",
			timestamp: new Date().toISOString(),
			type: DeltaType.PROMPT_COMPLETE,
			summary: "Complete",
			data: {},
			significance: 0.8,
		};

		const decisions = await broker.evaluate(delta);
		expect(decisions).toEqual([]);
		// Should not have called the LLM since the only candidate was completed
		expect(mockConversations.sendOneShotJson).not.toHaveBeenCalled();
	});

	it("handles LLM failures gracefully (defaults to not sharing)", async () => {
		const mockConversations = {
			sendOneShotJson: mock(() => Promise.reject(new Error("LLM timeout"))),
		} as any;

		const tracker = new ContextTracker();
		const subtask1: SubTask = {
			id: "t1",
			prompt: "Task 1",
			role: "role1",
			dependencies: [],
			priority: 1,
		};
		const subtask2: SubTask = {
			id: "t2",
			prompt: "Task 2",
			role: "role2",
			dependencies: [],
			priority: 2,
		};

		tracker.registerAgent("agent-1", "Alpha", subtask1);
		tracker.registerAgent("agent-2", "Beta", subtask2);

		const broker = new InformationBroker(
			mockConversations,
			tracker,
			[],
			silentLogger(),
		);

		const delta: ContextDelta = {
			agentId: "agent-1",
			agentName: "Alpha",
			timestamp: new Date().toISOString(),
			type: DeltaType.PROMPT_COMPLETE,
			summary: "Complete",
			data: {},
			significance: 0.8,
		};

		const decisions = await broker.evaluate(delta);
		// Should get a decision back (not throw) with shouldShare: false
		expect(decisions).toHaveLength(1);
		expect(decisions[0]!.shouldShare).toBe(false);
		expect(decisions[0]!.reasoning).toContain("failed");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Information sharing conditional behavior
// ════════════════════════════════════════════════════════════════════════════

describe("Information sharing conditional behavior", () => {
	it("sharing does not happen when only one agent exists", async () => {
		const mockConversations = {
			sendOneShotJson: mock(() =>
				Promise.resolve({
					shouldShare: true,
					reasoning: "test",
					information: "info",
				}),
			),
		} as any;

		const tracker = new ContextTracker();
		tracker.registerAgent("a1", "Alpha", {
			id: "t1",
			prompt: "task",
			role: "role",
			dependencies: [],
			priority: 1,
		});

		const broker = new InformationBroker(
			mockConversations,
			tracker,
			[],
			silentLogger(),
		);

		const delta: ContextDelta = {
			agentId: "a1",
			agentName: "Alpha",
			timestamp: new Date().toISOString(),
			type: DeltaType.PROMPT_COMPLETE,
			summary: "Done",
			data: {},
			significance: 0.9,
		};

		const decisions = await broker.evaluate(delta);
		expect(decisions).toEqual([]);
		expect(mockConversations.sendOneShotJson).not.toHaveBeenCalled();
	});

	it("sharing decision is LLM-driven, not automatic", async () => {
		const llmDecisions: boolean[] = [];
		const mockConversations = {
			sendOneShotJson: mock(() => {
				// LLM decides NOT to share even though agents exist
				const shouldShare = false;
				llmDecisions.push(shouldShare);
				return Promise.resolve({
					shouldShare,
					reasoning: "The information is not relevant to the target's task",
					information: "",
				});
			}),
		} as any;

		const tracker = new ContextTracker();
		tracker.registerAgent("a1", "Alpha", {
			id: "t1",
			prompt: "Build UI",
			role: "frontend",
			dependencies: [],
			priority: 1,
		});
		tracker.registerAgent("a2", "Beta", {
			id: "t2",
			prompt: "Build DB",
			role: "backend",
			dependencies: [],
			priority: 1,
		});

		const broker = new InformationBroker(
			mockConversations,
			tracker,
			[],
			silentLogger(),
		);

		const delta: ContextDelta = {
			agentId: "a1",
			agentName: "Alpha",
			timestamp: new Date().toISOString(),
			type: DeltaType.PROMPT_COMPLETE,
			summary: "UI layout completed",
			data: {},
			significance: 0.8,
		};

		const decisions = await broker.evaluate(delta);

		// LLM was called (meaning it's not automatic)
		expect(mockConversations.sendOneShotJson).toHaveBeenCalled();
		// But the decision was to NOT share
		expect(decisions).toHaveLength(1);
		expect(decisions[0]!.shouldShare).toBe(false);
	});
});
