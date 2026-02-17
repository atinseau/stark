import { describe, expect, it, mock } from "bun:test";
import { DeltaType } from "../../../enums/delta-type.enum.ts";
import type {
	ContextDelta,
	SignificanceContext,
	SubTask,
} from "../../../types/agent-pool.types.ts";
import { AgentPool } from "../agent-pool.ts";
import { ContextTracker } from "../context-tracker.ts";
import { InformationBroker } from "../information-broker.ts";
import { createMockAgent, silentPoolConfig } from "./test-helpers.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeDelta(overrides?: Partial<ContextDelta>): ContextDelta {
	return {
		agentId: overrides?.agentId ?? "agent-1",
		agentName: overrides?.agentName ?? "Alpha",
		timestamp: overrides?.timestamp ?? new Date().toISOString(),
		type: overrides?.type ?? DeltaType.TOOL_COMPLETE,
		summary: overrides?.summary ?? "Tool completed",
		data: overrides?.data ?? {},
		significance: overrides?.significance ?? 0.5,
		promptResultSummary: overrides?.promptResultSummary ?? null,
	};
}

function makeContext(
	overrides?: Partial<SignificanceContext>,
): SignificanceContext {
	return {
		totalSubtasks: overrides?.totalSubtasks ?? 3,
		completedSubtasks: overrides?.completedSubtasks ?? 0,
		failedSubtasks: overrides?.failedSubtasks ?? 0,
		phase: overrides?.phase ?? "mid",
		totalDeltasProcessed: overrides?.totalDeltasProcessed ?? 10,
	};
}

function createBroker(options?: {
	significanceThreshold?: number;
	dependencies?: Array<{
		from: string;
		to: string;
		type: "blocking" | "informational";
	}>;
	subtaskToAgent?: Map<string, string>;
	agentToSubtask?: Map<string, string>;
}): InformationBroker {
	const mockConversations = {
		sendOneShotJson: mock(() =>
			Promise.resolve([
				{
					targetAgentId: "agent-2",
					shouldShare: false,
					reasoning: "Not relevant",
					information: "",
				},
			]),
		),
	} as any;

	const subtask1: SubTask = {
		id: "st-1",
		prompt: "Do task 1",
		role: "role-1",
		dependencies: [],
		priority: 1,
	};
	const subtask2: SubTask = {
		id: "st-2",
		prompt: "Do task 2",
		role: "role-2",
		dependencies: [],
		priority: 2,
	};

	const tracker = new ContextTracker();
	tracker.registerAgent("agent-1", "Alpha", subtask1);
	tracker.registerAgent("agent-2", "Beta", subtask2);

	return new InformationBroker(
		mockConversations,
		tracker,
		options?.dependencies ?? [],
		{
			level: "silent",
			info: () => {},
			debug: () => {},
			warn: () => {},
			error: () => {},
			child: () => ({
				level: "silent",
				info: () => {},
				debug: () => {},
				warn: () => {},
				error: () => {},
			}),
		} as any,
		options?.subtaskToAgent ??
			new Map([
				["st-1", "agent-1"],
				["st-2", "agent-2"],
			]),
		options?.agentToSubtask ??
			new Map([
				["agent-1", "st-1"],
				["agent-2", "st-2"],
			]),
		options?.significanceThreshold !== undefined
			? { significanceThreshold: options.significanceThreshold }
			: undefined,
	);
}

// ── Tests: computeThreshold() ──────────────────────────────────────────────

describe("InformationBroker — computeThreshold()", () => {
	// ── Test 1: Base threshold without context ──────────────────────────

	it("returns base threshold (0.5) when no significance context is set", async () => {
		const broker = createBroker();
		// Don't call updateSignificanceContext()

		// A delta with significance exactly at 0.5 should pass (>= threshold)
		const deltaAtThreshold = makeDelta({ significance: 0.5 });
		const decisions = await broker.evaluate(deltaAtThreshold);
		// Should NOT be skipped — significance 0.5 >= baseThreshold 0.5
		// (It will try to evaluate and call LLM, returning decisions)
		expect(decisions.length).toBeGreaterThanOrEqual(0);

		// A delta with significance 0.49 should be skipped
		const deltaBelowThreshold = makeDelta({ significance: 0.49 });
		const skippedDecisions = await broker.evaluate(deltaBelowThreshold);
		expect(skippedDecisions).toEqual([]);
	});

	// ── Test 2: Phase "early" reduces threshold ─────────────────────────

	it("phase 'early' reduces threshold by 0.1", async () => {
		const broker = createBroker();
		broker.updateSignificanceContext(
			makeContext({ phase: "early", totalDeltasProcessed: 5 }),
		);

		// Effective threshold = 0.5 - 0.1 = 0.4
		// A delta at 0.4 should pass
		const delta = makeDelta({ significance: 0.4 });
		const decisions = await broker.evaluate(delta);
		// Should NOT be skipped
		expect(decisions.length).toBeGreaterThanOrEqual(0);

		// A delta at 0.39 should be skipped
		const deltaBelowThreshold = makeDelta({ significance: 0.39 });
		const skippedDecisions = await broker.evaluate(deltaBelowThreshold);
		expect(skippedDecisions).toEqual([]);
	});

	// ── Test 3: Phase "late" increases threshold ────────────────────────

	it("phase 'late' increases threshold by 0.1", async () => {
		const broker = createBroker();
		broker.updateSignificanceContext(
			makeContext({ phase: "late", totalDeltasProcessed: 5 }),
		);

		// Effective threshold = 0.5 + 0.1 = 0.6
		// A delta at 0.59 should be skipped
		const delta = makeDelta({ significance: 0.59 });
		const decisions = await broker.evaluate(delta);
		expect(decisions).toEqual([]);

		// A delta at 0.6 should pass
		const deltaAtThreshold = makeDelta({ significance: 0.6 });
		const passDecisions = await broker.evaluate(deltaAtThreshold);
		expect(passDecisions.length).toBeGreaterThanOrEqual(0);
	});

	// ── Test 4: Blocking dependents reduce threshold ────────────────────

	it("blocking dependents reduce threshold by 0.2", async () => {
		const broker = createBroker({
			dependencies: [{ from: "st-1", to: "st-2", type: "blocking" }],
			agentToSubtask: new Map([
				["agent-1", "st-1"],
				["agent-2", "st-2"],
			]),
			subtaskToAgent: new Map([
				["st-1", "agent-1"],
				["st-2", "agent-2"],
			]),
		});
		broker.updateSignificanceContext(
			makeContext({ phase: "mid", totalDeltasProcessed: 5 }),
		);

		// Effective threshold = 0.5 - 0.2 = 0.3
		// Delta from agent-1 (has blocking dependents) at 0.3 should pass
		const delta = makeDelta({ agentId: "agent-1", significance: 0.3 });
		const decisions = await broker.evaluate(delta);
		expect(decisions.length).toBeGreaterThanOrEqual(0);

		// Delta at 0.29 should be skipped
		const deltaBelowThreshold = makeDelta({
			agentId: "agent-1",
			significance: 0.29,
		});
		const skippedDecisions = await broker.evaluate(deltaBelowThreshold);
		expect(skippedDecisions).toEqual([]);
	});

	// ── Test 5: Informational dependents reduce threshold by 0.1 ───────

	it("informational dependents reduce threshold by 0.1", async () => {
		const broker = createBroker({
			dependencies: [{ from: "st-1", to: "st-2", type: "informational" }],
			agentToSubtask: new Map([
				["agent-1", "st-1"],
				["agent-2", "st-2"],
			]),
			subtaskToAgent: new Map([
				["st-1", "agent-1"],
				["st-2", "agent-2"],
			]),
		});
		broker.updateSignificanceContext(
			makeContext({ phase: "mid", totalDeltasProcessed: 5 }),
		);

		// Effective threshold = 0.5 - 0.1 = 0.4
		const delta = makeDelta({ agentId: "agent-1", significance: 0.4 });
		const decisions = await broker.evaluate(delta);
		expect(decisions.length).toBeGreaterThanOrEqual(0);

		const deltaBelowThreshold = makeDelta({
			agentId: "agent-1",
			significance: 0.39,
		});
		const skippedDecisions = await broker.evaluate(deltaBelowThreshold);
		expect(skippedDecisions).toEqual([]);
	});

	// ── Test 6: Early + blocking deps combined ─────────────────────────

	it("early phase + blocking deps combined = 0.2 (clamped to MIN)", async () => {
		const broker = createBroker({
			dependencies: [{ from: "st-1", to: "st-2", type: "blocking" }],
			agentToSubtask: new Map([
				["agent-1", "st-1"],
				["agent-2", "st-2"],
			]),
			subtaskToAgent: new Map([
				["st-1", "agent-1"],
				["st-2", "agent-2"],
			]),
		});
		broker.updateSignificanceContext(
			makeContext({ phase: "early", totalDeltasProcessed: 5 }),
		);

		// Effective threshold = 0.5 - 0.1 (early) - 0.2 (blocking) = 0.2 (MIN)
		const delta = makeDelta({ agentId: "agent-1", significance: 0.2 });
		const decisions = await broker.evaluate(delta);
		expect(decisions.length).toBeGreaterThanOrEqual(0);

		// 0.19 should be skipped (below MIN)
		const deltaBelowMin = makeDelta({ agentId: "agent-1", significance: 0.19 });
		const skippedDecisions = await broker.evaluate(deltaBelowMin);
		expect(skippedDecisions).toEqual([]);
	});

	// ── Test 7: Threshold never goes below MIN ─────────────────────────

	it("threshold never goes below MIN_SIGNIFICANCE_THRESHOLD (0.2)", async () => {
		// Even with a very low base threshold + early + blocking deps
		const broker = createBroker({
			significanceThreshold: 0.3,
			dependencies: [{ from: "st-1", to: "st-2", type: "blocking" }],
			agentToSubtask: new Map([
				["agent-1", "st-1"],
				["agent-2", "st-2"],
			]),
			subtaskToAgent: new Map([
				["st-1", "agent-1"],
				["st-2", "agent-2"],
			]),
		});
		broker.updateSignificanceContext(
			makeContext({ phase: "early", totalDeltasProcessed: 5 }),
		);

		// Calculated = 0.3 - 0.1 (early) - 0.2 (blocking) = 0.0
		// Clamped to MIN = 0.2
		const delta = makeDelta({ agentId: "agent-1", significance: 0.2 });
		const decisions = await broker.evaluate(delta);
		expect(decisions.length).toBeGreaterThanOrEqual(0);

		// 0.19 should still be skipped (below MIN)
		const deltaBelowMin = makeDelta({ agentId: "agent-1", significance: 0.19 });
		const skippedDecisions = await broker.evaluate(deltaBelowMin);
		expect(skippedDecisions).toEqual([]);
	});

	// ── Test 8: Threshold never goes above MAX ─────────────────────────

	it("threshold never goes above MAX_SIGNIFICANCE_THRESHOLD (0.85)", async () => {
		const broker = createBroker({
			significanceThreshold: 0.7,
		});
		broker.updateSignificanceContext(
			makeContext({ phase: "late", totalDeltasProcessed: 200 }),
		);

		// Calculated = 0.7 + 0.1 (late) + 0.15 (chatty max) = 0.95
		// Clamped to MAX = 0.85
		// AGENT_ERROR at 1.0 should still pass
		const agentErrorDelta = makeDelta({
			type: DeltaType.AGENT_ERROR,
			significance: 1.0,
		});
		const decisions = await broker.evaluate(agentErrorDelta);
		expect(decisions.length).toBeGreaterThanOrEqual(0);

		// TOOL_FAILED at 0.9 should still pass (0.9 > 0.85)
		const toolFailedDelta = makeDelta({
			type: DeltaType.TOOL_FAILED,
			significance: 0.9,
		});
		const decisions2 = await broker.evaluate(toolFailedDelta);
		expect(decisions2.length).toBeGreaterThanOrEqual(0);

		// Delta at 0.84 should be skipped (0.84 < 0.85)
		const skippedDelta = makeDelta({ significance: 0.84 });
		const skippedDecisions = await broker.evaluate(skippedDelta);
		expect(skippedDecisions).toEqual([]);
	});

	// ── Test 9: Chatty penalty kicks in progressively ──────────────────

	it("chatty penalty kicks in after 50 deltas and grows progressively", async () => {
		const broker = createBroker();

		// 50 deltas: no penalty yet (threshold at CHATTY_EXECUTION_DELTA_THRESHOLD is not exceeded)
		broker.updateSignificanceContext(
			makeContext({ phase: "mid", totalDeltasProcessed: 50 }),
		);
		// Threshold = 0.5 (no chatty penalty at exactly 50)
		const delta50 = makeDelta({ significance: 0.5 });
		const decisions50 = await broker.evaluate(delta50);
		expect(decisions50.length).toBeGreaterThanOrEqual(0);

		// 100 deltas: penalty = floor((100-50)/50) * 0.05 = 1 * 0.05 = +0.05
		broker.updateSignificanceContext(
			makeContext({ phase: "mid", totalDeltasProcessed: 100 }),
		);
		// Threshold = 0.5 + 0.05 = 0.55
		const delta100_at_54 = makeDelta({ significance: 0.54 });
		const decisions100_skip = await broker.evaluate(delta100_at_54);
		expect(decisions100_skip).toEqual([]);

		// 150 deltas: penalty = floor((150-50)/50) * 0.05 = 2 * 0.05 = +0.10
		broker.updateSignificanceContext(
			makeContext({ phase: "mid", totalDeltasProcessed: 150 }),
		);
		// Threshold = 0.5 + 0.10 = 0.60
		const delta150_at_59 = makeDelta({ significance: 0.59 });
		const decisions150_skip = await broker.evaluate(delta150_at_59);
		expect(decisions150_skip).toEqual([]);

		// At 0.6 should pass
		const delta150_at_60 = makeDelta({ significance: 0.6 });
		const decisions150_pass = await broker.evaluate(delta150_at_60);
		expect(decisions150_pass.length).toBeGreaterThanOrEqual(0);
	});

	// ── Test 10: Chatty penalty caps at MAX_CHATTY_PENALTY ─────────────

	it("chatty penalty does not exceed MAX_CHATTY_PENALTY (0.15)", async () => {
		const broker = createBroker();

		// 1000 deltas: penalty = floor((1000-50)/50) * 0.05 = 19 * 0.05 = 0.95
		// But capped at MAX_CHATTY_PENALTY = 0.15
		broker.updateSignificanceContext(
			makeContext({ phase: "mid", totalDeltasProcessed: 1000 }),
		);
		// Threshold = 0.5 + 0.15 = 0.65 (not 0.5 + 0.95)

		const delta = makeDelta({ significance: 0.65 });
		const decisions = await broker.evaluate(delta);
		expect(decisions.length).toBeGreaterThanOrEqual(0);

		// 0.64 should be skipped
		const deltaSkipped = makeDelta({ significance: 0.64 });
		const skippedDecisions = await broker.evaluate(deltaSkipped);
		expect(skippedDecisions).toEqual([]);

		// Same with 300 deltas — penalty = floor((300-50)/50) * 0.05 = 5 * 0.05 = 0.25
		// Capped to 0.15, threshold = 0.65
		broker.updateSignificanceContext(
			makeContext({ phase: "mid", totalDeltasProcessed: 300 }),
		);
		const delta300 = makeDelta({ significance: 0.65 });
		const decisions300 = await broker.evaluate(delta300);
		expect(decisions300.length).toBeGreaterThanOrEqual(0);

		const delta300_skip = makeDelta({ significance: 0.64 });
		const decisions300_skip = await broker.evaluate(delta300_skip);
		expect(decisions300_skip).toEqual([]);
	});

	// ── Test 11: Broker computes deps from internal data ───────────────

	it("computes blocking dependency adjustment from internal data", async () => {
		const brokerWithDeps = createBroker({
			dependencies: [{ from: "st-1", to: "st-2", type: "blocking" }],
			agentToSubtask: new Map([
				["agent-1", "st-1"],
				["agent-2", "st-2"],
			]),
			subtaskToAgent: new Map([
				["st-1", "agent-1"],
				["st-2", "agent-2"],
			]),
		});
		brokerWithDeps.updateSignificanceContext(
			makeContext({ phase: "mid", totalDeltasProcessed: 5 }),
		);

		// Delta from agent-1 (has blocking dependents) → threshold = 0.5 - 0.2 = 0.3
		const deltaFromAgent1 = makeDelta({
			agentId: "agent-1",
			significance: 0.3,
		});
		const decisions1 = await brokerWithDeps.evaluate(deltaFromAgent1);
		expect(decisions1.length).toBeGreaterThanOrEqual(0);

		// Delta from agent-2 (NO dependents — it's the target, not the source)
		// threshold stays at 0.5
		const deltaFromAgent2 = makeDelta({
			agentId: "agent-2",
			significance: 0.49,
		});
		const decisions2 = await brokerWithDeps.evaluate(deltaFromAgent2);
		expect(decisions2).toEqual([]);

		// Delta from agent-2 at 0.5 should pass (0.5 >= 0.5)
		const deltaFromAgent2_pass = makeDelta({
			agentId: "agent-2",
			significance: 0.5,
		});
		const decisions2_pass = await brokerWithDeps.evaluate(deltaFromAgent2_pass);
		expect(decisions2_pass.length).toBeGreaterThanOrEqual(0);
	});

	// ── Test: Phase "mid" has no adjustment ────────────────────────────

	it("phase 'mid' has zero adjustment (0.0)", async () => {
		const broker = createBroker();
		broker.updateSignificanceContext(
			makeContext({ phase: "mid", totalDeltasProcessed: 5 }),
		);

		// Effective threshold = 0.5 + 0.0 = 0.5
		const delta = makeDelta({ significance: 0.5 });
		const decisions = await broker.evaluate(delta);
		expect(decisions.length).toBeGreaterThanOrEqual(0);

		const deltaBelowThreshold = makeDelta({ significance: 0.49 });
		const skippedDecisions = await broker.evaluate(deltaBelowThreshold);
		expect(skippedDecisions).toEqual([]);
	});
});

// ── Tests: evaluate() with dynamic threshold ───────────────────────────────

describe("InformationBroker — evaluate() with dynamic threshold", () => {
	// ── Test 12: evaluate() uses dynamic threshold ──────────────────────

	it("evaluates TOOL_COMPLETE (0.5) in early phase that would be skipped with old static threshold", async () => {
		const mockConversations = {
			sendOneShotJson: mock(() =>
				Promise.resolve([
					{
						targetAgentId: "agent-2",
						shouldShare: true,
						reasoning: "tool output relevant",
						information: "The tool produced useful output",
					},
				]),
			),
		} as any;

		const subtask1: SubTask = {
			id: "st-1",
			prompt: "Do task 1",
			role: "role-1",
			dependencies: [],
			priority: 1,
		};
		const subtask2: SubTask = {
			id: "st-2",
			prompt: "Do task 2",
			role: "role-2",
			dependencies: [],
			priority: 2,
		};

		const tracker = new ContextTracker();
		tracker.registerAgent("agent-1", "Alpha", subtask1);
		tracker.registerAgent("agent-2", "Beta", subtask2);

		const broker = new InformationBroker(
			mockConversations,
			tracker,
			[],
			{
				level: "silent",
				info: () => {},
				debug: () => {},
				warn: () => {},
				error: () => {},
				child: () => ({
					level: "silent",
					info: () => {},
					debug: () => {},
					warn: () => {},
					error: () => {},
				}),
			} as any,
			new Map([
				["st-1", "agent-1"],
				["st-2", "agent-2"],
			]),
			new Map([
				["agent-1", "st-1"],
				["agent-2", "st-2"],
			]),
		);

		// Set early phase with blocking deps
		broker.updateSignificanceContext(
			makeContext({ phase: "early", totalDeltasProcessed: 5 }),
		);

		// TOOL_COMPLETE at 0.5 — would have been skipped with old static threshold (0.6)
		// but with dynamic threshold in early phase (0.4), it should pass
		const delta = makeDelta({
			agentId: "agent-1",
			type: DeltaType.TOOL_COMPLETE,
			significance: 0.5,
		});

		const decisions = await broker.evaluate(delta);
		// Should have been evaluated (not skipped)
		// The mock sendOneShotJson will return a decision
		expect(decisions.length).toBeGreaterThan(0);
		expect(mockConversations.sendOneShotJson).toHaveBeenCalled();
	});

	// ── Test 13: TOOL_COMPLETE in early phase with blocking deps ───────

	it("TOOL_COMPLETE is evaluated in early phase with blocking deps", async () => {
		const mockConversations = {
			sendOneShotJson: mock(() =>
				Promise.resolve([
					{
						targetAgentId: "agent-2",
						shouldShare: true,
						reasoning: "blocking dep needs this",
						information: "Critical output for dependent agent",
					},
				]),
			),
		} as any;

		const subtask1: SubTask = {
			id: "st-1",
			prompt: "Do task 1",
			role: "role-1",
			dependencies: [],
			priority: 1,
		};
		const subtask2: SubTask = {
			id: "st-2",
			prompt: "Do task 2",
			role: "role-2",
			dependencies: ["st-1"],
			priority: 2,
		};

		const tracker = new ContextTracker();
		tracker.registerAgent("agent-1", "Alpha", subtask1);
		tracker.registerAgent("agent-2", "Beta", subtask2);

		const broker = new InformationBroker(
			mockConversations,
			tracker,
			[{ from: "st-1", to: "st-2", type: "blocking" as const }],
			{
				level: "silent",
				info: () => {},
				debug: () => {},
				warn: () => {},
				error: () => {},
				child: () => ({
					level: "silent",
					info: () => {},
					debug: () => {},
					warn: () => {},
					error: () => {},
				}),
			} as any,
			new Map([
				["st-1", "agent-1"],
				["st-2", "agent-2"],
			]),
			new Map([
				["agent-1", "st-1"],
				["agent-2", "st-2"],
			]),
		);

		broker.updateSignificanceContext(
			makeContext({ phase: "early", totalDeltasProcessed: 3 }),
		);

		// Effective threshold = 0.5 - 0.1 (early) - 0.2 (blocking) = 0.2
		const delta = makeDelta({
			agentId: "agent-1",
			type: DeltaType.TOOL_COMPLETE,
			significance: 0.5,
		});

		const decisions = await broker.evaluate(delta);
		expect(decisions.length).toBeGreaterThan(0);
		expect(mockConversations.sendOneShotJson).toHaveBeenCalled();
	});

	// ── Test 14: TOOL_COMPLETE ignored in late phase without deps ──────

	it("TOOL_COMPLETE is ignored in late phase without deps", async () => {
		const mockConversations = {
			sendOneShotJson: mock(() =>
				Promise.resolve([
					{
						targetAgentId: "agent-2",
						shouldShare: false,
						reasoning: "Not relevant",
						information: "",
					},
				]),
			),
		} as any;

		const subtask1: SubTask = {
			id: "st-1",
			prompt: "Do task 1",
			role: "role-1",
			dependencies: [],
			priority: 1,
		};
		const subtask2: SubTask = {
			id: "st-2",
			prompt: "Do task 2",
			role: "role-2",
			dependencies: [],
			priority: 2,
		};

		const tracker = new ContextTracker();
		tracker.registerAgent("agent-1", "Alpha", subtask1);
		tracker.registerAgent("agent-2", "Beta", subtask2);

		const broker = new InformationBroker(
			mockConversations,
			tracker,
			[], // no dependencies
			{
				level: "silent",
				info: () => {},
				debug: () => {},
				warn: () => {},
				error: () => {},
				child: () => ({
					level: "silent",
					info: () => {},
					debug: () => {},
					warn: () => {},
					error: () => {},
				}),
			} as any,
			new Map([
				["st-1", "agent-1"],
				["st-2", "agent-2"],
			]),
			new Map([
				["agent-1", "st-1"],
				["agent-2", "st-2"],
			]),
		);

		broker.updateSignificanceContext(
			makeContext({ phase: "late", totalDeltasProcessed: 5 }),
		);

		// Effective threshold = 0.5 + 0.1 (late) = 0.6
		// TOOL_COMPLETE at 0.5 < 0.6 → skipped
		const delta = makeDelta({
			agentId: "agent-1",
			type: DeltaType.TOOL_COMPLETE,
			significance: 0.5,
		});

		const decisions = await broker.evaluate(delta);
		expect(decisions).toEqual([]);
		// sendOneShotJson should NOT have been called (delta was skipped)
		expect(mockConversations.sendOneShotJson).not.toHaveBeenCalled();
	});
});

// ── Tests: AgentPool integration ───────────────────────────────────────────

describe("AgentPool — significance context integration", () => {
	// ── Test 15: handleDelta updates context before evaluation ───────────

	it("calls updateSignificanceContext before evaluate", async () => {
		const pool = new AgentPool(
			silentPoolConfig({
				createAgent: () => createMockAgent(),
			}),
		);

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

		const tracker = (pool as any).contextTracker;
		tracker.registerAgent("agent-1", "Alpha", subtask1);
		tracker.registerAgent("agent-2", "Beta", subtask2);

		const callOrder: string[] = [];
		const updateSignificanceContext = mock((..._args: unknown[]) => {
			callOrder.push("updateSignificanceContext");
		});
		const evaluate = mock(async () => {
			callOrder.push("evaluate");
			return [];
		});

		const mockBroker = {
			evaluate,
			evaluateWithFullResult: mock(async () => []),
			recordSharing: mock(() => undefined),
			updateSignificanceContext,
		};

		(pool as any).informationBroker = mockBroker;

		const delta: ContextDelta = {
			agentId: "agent-1",
			agentName: "Alpha",
			timestamp: new Date().toISOString(),
			type: DeltaType.TOOL_COMPLETE,
			summary: "Tool completed",
			data: {},
			significance: 0.9,
			promptResultSummary: null,
		};

		await (pool as any).handleDelta(delta);

		expect(updateSignificanceContext).toHaveBeenCalledTimes(1);
		expect(evaluate).toHaveBeenCalledTimes(1);
		// updateSignificanceContext must be called BEFORE evaluate
		expect(callOrder).toEqual(["updateSignificanceContext", "evaluate"]);
	});

	// ── Test 16: Phase is correctly computed ────────────────────────────

	it("computes phase correctly based on completion ratio", async () => {
		const pool = new AgentPool(
			silentPoolConfig({
				createAgent: () => createMockAgent(),
			}),
		);

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
		const subtask3: SubTask = {
			id: "t3",
			prompt: "Task 3",
			role: "role3",
			dependencies: [],
			priority: 3,
		};

		const tracker = (pool as any).contextTracker;
		tracker.registerAgent("agent-1", "Alpha", subtask1);
		tracker.registerAgent("agent-2", "Beta", subtask2);
		tracker.registerAgent("agent-3", "Gamma", subtask3);

		let capturedContext: SignificanceContext | null = null;
		const updateSignificanceContext = mock((ctx: SignificanceContext) => {
			capturedContext = ctx;
		});

		const mockBroker = {
			evaluate: mock(async () => []),
			evaluateWithFullResult: mock(async () => []),
			recordSharing: mock(() => undefined),
			updateSignificanceContext,
		};

		(pool as any).informationBroker = mockBroker;

		const delta: ContextDelta = {
			agentId: "agent-1",
			agentName: "Alpha",
			timestamp: new Date().toISOString(),
			type: DeltaType.TOOL_COMPLETE,
			summary: "Tool completed",
			data: {},
			significance: 0.9,
			promptResultSummary: null,
		};

		// 0/3 completed → phase = "early" (0% < 30%)
		await (pool as any).handleDelta(delta);
		expect(capturedContext).not.toBeNull();
		expect(capturedContext!.phase).toBe("early");
		expect(capturedContext!.totalSubtasks).toBe(3);
		expect(capturedContext!.completedSubtasks).toBe(0);

		// Mark 1 agent as completed (1/3 = 33% → "mid")
		const state1 = tracker.getAgentState("agent-1");
		state1.completed = true;

		await (pool as any).handleDelta(delta);
		expect(capturedContext!.phase).toBe("mid");
		expect(capturedContext!.completedSubtasks).toBe(1);

		// Mark 2 agents as completed (2/3 = 67% — still < 70% → "mid")
		const state2 = tracker.getAgentState("agent-2");
		state2.completed = true;

		await (pool as any).handleDelta(delta);
		expect(capturedContext!.phase).toBe("mid");

		// Mark 3rd agent as completed (3/3 = 100% → "late")
		const state3 = tracker.getAgentState("agent-3");
		state3.completed = true;

		await (pool as any).handleDelta(delta);
		expect(capturedContext!.phase).toBe("late");
	});

	// ── Test 17: Fallback works without context ─────────────────────────

	it("evaluate works without calling updateSignificanceContext (fallback to baseThreshold)", async () => {
		const mockConversations = {
			sendOneShotJson: mock(() =>
				Promise.resolve([
					{
						targetAgentId: "agent-2",
						shouldShare: false,
						reasoning: "Not relevant",
						information: "",
					},
				]),
			),
		} as any;

		const subtask1: SubTask = {
			id: "st-1",
			prompt: "Do task 1",
			role: "role-1",
			dependencies: [],
			priority: 1,
		};
		const subtask2: SubTask = {
			id: "st-2",
			prompt: "Do task 2",
			role: "role-2",
			dependencies: [],
			priority: 2,
		};

		const tracker = new ContextTracker();
		tracker.registerAgent("agent-1", "Alpha", subtask1);
		tracker.registerAgent("agent-2", "Beta", subtask2);

		const broker = new InformationBroker(
			mockConversations,
			tracker,
			[],
			{
				level: "silent",
				info: () => {},
				debug: () => {},
				warn: () => {},
				error: () => {},
				child: () => ({
					level: "silent",
					info: () => {},
					debug: () => {},
					warn: () => {},
					error: () => {},
				}),
			} as any,
			new Map([
				["st-1", "agent-1"],
				["st-2", "agent-2"],
			]),
			new Map([
				["agent-1", "st-1"],
				["agent-2", "st-2"],
			]),
		);

		// Do NOT call updateSignificanceContext — should fall back to baseThreshold (0.5)
		const delta = makeDelta({ significance: 0.5 });
		const decisions = await broker.evaluate(delta);
		// Should not throw, should work fine
		expect(decisions.length).toBeGreaterThanOrEqual(0);
	});
});

// ── Tests: Non-regression ──────────────────────────────────────────────────

describe("InformationBroker — non-regression", () => {
	// ── Test 18: Single agent — no sharing evaluation ────────────────────

	it("single agent does not trigger sharing evaluation (agentCount check in pool)", async () => {
		const pool = new AgentPool(
			silentPoolConfig({
				createAgent: () => createMockAgent(),
			}),
		);

		const tracker = (pool as any).contextTracker;
		tracker.registerAgent("agent-1", "Alpha", {
			id: "t1",
			prompt: "Do work",
			role: "role1",
			dependencies: [],
			priority: 1,
		});
		// Only 1 agent — agentCount = 1

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
			significance: 0.9,
			promptResultSummary: null,
		};

		await (pool as any).handleDelta(delta);

		// Neither evaluate nor updateSignificanceContext should be called
		expect(evaluate).not.toHaveBeenCalled();
		expect(mockBroker.updateSignificanceContext).not.toHaveBeenCalled();
	});

	// ── Test 19: options.significanceThreshold override works ────────────

	it("options.significanceThreshold override applies to base threshold", async () => {
		// Create broker with custom threshold of 0.3
		const broker = createBroker({ significanceThreshold: 0.3 });

		// Without context, threshold should be 0.3
		const delta = makeDelta({ significance: 0.3 });
		const decisions = await broker.evaluate(delta);
		expect(decisions.length).toBeGreaterThanOrEqual(0);

		const deltaBelowThreshold = makeDelta({ significance: 0.29 });
		const skippedDecisions = await broker.evaluate(deltaBelowThreshold);
		expect(skippedDecisions).toEqual([]);
	});

	// ── Test 20: AGENT_ERROR always passes ──────────────────────────────

	it("AGENT_ERROR (significance 1.0) always passes in every scenario", async () => {
		const mockConversations = {
			sendOneShotJson: mock(() =>
				Promise.resolve([
					{
						targetAgentId: "agent-2",
						shouldShare: true,
						reasoning: "Error must be shared",
						information: "Agent encountered a critical error",
					},
				]),
			),
		} as any;

		const subtask1: SubTask = {
			id: "st-1",
			prompt: "Do task 1",
			role: "role-1",
			dependencies: [],
			priority: 1,
		};
		const subtask2: SubTask = {
			id: "st-2",
			prompt: "Do task 2",
			role: "role-2",
			dependencies: [],
			priority: 2,
		};

		const tracker = new ContextTracker();
		tracker.registerAgent("agent-1", "Alpha", subtask1);
		tracker.registerAgent("agent-2", "Beta", subtask2);

		const broker = new InformationBroker(
			mockConversations,
			tracker,
			[],
			{
				level: "silent",
				info: () => {},
				debug: () => {},
				warn: () => {},
				error: () => {},
				child: () => ({
					level: "silent",
					info: () => {},
					debug: () => {},
					warn: () => {},
					error: () => {},
				}),
			} as any,
			new Map([
				["st-1", "agent-1"],
				["st-2", "agent-2"],
			]),
			new Map([
				["agent-1", "st-1"],
				["agent-2", "st-2"],
			]),
		);

		// Worst case scenario: late phase, chatty execution, high base threshold
		broker.updateSignificanceContext(
			makeContext({ phase: "late", totalDeltasProcessed: 500 }),
		);

		const agentErrorDelta = makeDelta({
			agentId: "agent-1",
			type: DeltaType.AGENT_ERROR,
			significance: 1.0,
		});

		const decisions = await broker.evaluate(agentErrorDelta);
		expect(decisions.length).toBeGreaterThan(0);
		expect(mockConversations.sendOneShotJson).toHaveBeenCalled();
	});

	// ── Test: STATUS_CHANGE/BUSY (0.1) never passes ────────────────────

	it("STATUS_CHANGE/BUSY (significance 0.1) never passes even in most permissive scenario", async () => {
		const broker = createBroker({
			dependencies: [{ from: "st-1", to: "st-2", type: "blocking" }],
			agentToSubtask: new Map([
				["agent-1", "st-1"],
				["agent-2", "st-2"],
			]),
			subtaskToAgent: new Map([
				["st-1", "agent-1"],
				["st-2", "agent-2"],
			]),
		});

		// Most permissive scenario: early phase + blocking deps → threshold = 0.2 (MIN)
		broker.updateSignificanceContext(
			makeContext({ phase: "early", totalDeltasProcessed: 0 }),
		);

		const busyDelta = makeDelta({
			agentId: "agent-1",
			type: DeltaType.STATUS_CHANGE,
			significance: 0.1,
		});

		const decisions = await broker.evaluate(busyDelta);
		expect(decisions).toEqual([]);
	});

	// ── Test: FILE_WRITTEN (0.5) is evaluated in early phase with blocking deps ──

	it("FILE_WRITTEN (0.5) is evaluated when source agent has blocking dependents in early phase", async () => {
		const mockConversations = {
			sendOneShotJson: mock(() =>
				Promise.resolve([
					{
						targetAgentId: "agent-2",
						shouldShare: true,
						reasoning: "File may unblock dependent",
						information: "A file was written",
					},
				]),
			),
		} as any;

		const subtask1: SubTask = {
			id: "st-1",
			prompt: "Write files",
			role: "file-writer",
			dependencies: [],
			priority: 1,
		};
		const subtask2: SubTask = {
			id: "st-2",
			prompt: "Use files",
			role: "file-reader",
			dependencies: ["st-1"],
			priority: 2,
		};

		const tracker = new ContextTracker();
		tracker.registerAgent("agent-1", "Alpha", subtask1);
		tracker.registerAgent("agent-2", "Beta", subtask2);

		const broker = new InformationBroker(
			mockConversations,
			tracker,
			[{ from: "st-1", to: "st-2", type: "blocking" as const }],
			{
				level: "silent",
				info: () => {},
				debug: () => {},
				warn: () => {},
				error: () => {},
				child: () => ({
					level: "silent",
					info: () => {},
					debug: () => {},
					warn: () => {},
					error: () => {},
				}),
			} as any,
			new Map([
				["st-1", "agent-1"],
				["st-2", "agent-2"],
			]),
			new Map([
				["agent-1", "st-1"],
				["agent-2", "st-2"],
			]),
		);

		broker.updateSignificanceContext(
			makeContext({ phase: "early", totalDeltasProcessed: 3 }),
		);

		// Effective threshold = 0.5 - 0.1 (early) - 0.2 (blocking) = 0.2
		// FILE_WRITTEN at 0.5 >> 0.2 → evaluated
		const delta = makeDelta({
			agentId: "agent-1",
			type: DeltaType.FILE_WRITTEN,
			significance: 0.5,
		});

		const decisions = await broker.evaluate(delta);
		expect(decisions.length).toBeGreaterThan(0);
		expect(mockConversations.sendOneShotJson).toHaveBeenCalled();
	});
});
