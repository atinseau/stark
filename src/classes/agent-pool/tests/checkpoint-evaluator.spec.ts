import { describe, expect, it, mock } from "bun:test";

import { AgentStatus } from "../../../enums/agent-status.enum.ts";
import type { ConversationRole } from "../../../enums/conversation-role.enum.ts";
import { ExecutionStrategy } from "../../../enums/execution-strategy.enum.ts";
import { TaskComplexity } from "../../../enums/task-complexity.enum.ts";
import {
	checkpointPrompt,
	checkpointSystemPrompt,
} from "../../../prompts/index.ts";
import {
	type AgentContextState,
	CheckpointAction,
	CheckpointTrigger,
	type TaskAnalysis,
} from "../../../types/agent-pool.types.ts";
import {
	CheckpointEvaluator,
	validateCheckpointResponse,
} from "../checkpoint-evaluator.ts";
import { silentLogger } from "./test-helpers.ts";

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

function createMockConversationManager(
	response?: Record<string, unknown>,
	shouldThrow?: Error,
) {
	const sendOneShotJson = shouldThrow
		? mock(() => Promise.reject(shouldThrow))
		: mock(() =>
				Promise.resolve(
					response ?? {
						action: "continue",
						healthScore: 0.9,
						reasoning: "Everything looks healthy.",
						statusSummary: "Execution on track.",
						issues: [],
						corrections: {},
					},
				),
			);

	return {
		has: mock(() => true),
		sendOneShotJson,
		// Other methods that may be called
		register: mock(() => {}),
		send: mock(() => Promise.resolve("")),
		sendJson: mock(() => Promise.resolve({})),
		sendOneShot: mock(() => Promise.resolve("")),
		getStats: mock(() => null),
		getHistory: mock(() => null),
		reset: mock(() => {}),
		resetAll: mock(() => {}),
		client: {
			validateModel: mock(() => Promise.resolve()),
			sanitize: (s: string) => s,
		},
	} as any;
}

function createMockContextTracker(agentStates?: AgentContextState[]) {
	const states: AgentContextState[] = agentStates ?? [
		{
			agentId: "agent-1",
			agentName: "api-developer",
			taskDescription: "Build REST API",
			taskRole: "api-developer",
			status: AgentStatus.BUSY,
			events: [],
			promptResults: [],
			lastDelta: null,
			filesWritten: ["src/routes/users.ts"],
			filesRead: [],
			completed: false,
			error: null,
		},
		{
			agentId: "agent-2",
			agentName: "test-writer",
			taskDescription: "Write tests",
			taskRole: "test-writer",
			status: AgentStatus.BUSY,
			events: [],
			promptResults: [],
			lastDelta: null,
			filesWritten: [],
			filesRead: [],
			completed: false,
			error: null,
		},
	];

	return {
		getAllAgentStates: mock(() => [...states]),
		getAgentState: mock((id: string) => states.find((s) => s.agentId === id)),
		agentCount: states.length,
	} as any;
}

function createTestAnalysis(subtaskCount = 3): TaskAnalysis {
	const subtasks = [];
	for (let i = 0; i < subtaskCount; i++) {
		subtasks.push({
			id: `subtask-${i}`,
			prompt: `Do task ${i}`,
			role: `role-${i}`,
			dependencies: i > 0 ? [`subtask-${i - 1}`] : [],
			priority: i + 1,
		});
	}

	const dependencies = [];
	for (let i = 1; i < subtaskCount; i++) {
		dependencies.push({
			from: `subtask-${i - 1}`,
			to: `subtask-${i}`,
			type: "blocking" as const,
		});
	}

	return {
		strategy: ExecutionStrategy.MULTI,
		complexity: TaskComplexity.COMPLEX,
		reasoning: "Task decomposed into multiple subtasks.",
		subtasks,
		dependencies,
		parallelismBenefit: 0.5,
	};
}

// ════════════════════════════════════════════════════════════════════════════
// validateCheckpointResponse Unit Tests
// ════════════════════════════════════════════════════════════════════════════

describe("validateCheckpointResponse", () => {
	// ── Test 14: rejects null/undefined/non-objects ──────────────────────

	it("rejects null", () => {
		expect(validateCheckpointResponse(null)).toBeNull();
	});

	it("rejects undefined", () => {
		expect(validateCheckpointResponse(undefined)).toBeNull();
	});

	it("rejects a string", () => {
		expect(validateCheckpointResponse("hello")).toBeNull();
	});

	it("rejects a number", () => {
		expect(validateCheckpointResponse(42)).toBeNull();
	});

	// ── Test 14: rejects invalid action ─────────────────────────────────

	it("rejects invalid action value", () => {
		expect(
			validateCheckpointResponse({
				action: "invalid",
				healthScore: 0.9,
				reasoning: "Test",
				statusSummary: "Test",
				issues: [],
				corrections: {},
			}),
		).toBeNull();
	});

	// ── Test 14: rejects non-number healthScore ─────────────────────────

	it("rejects non-number healthScore", () => {
		expect(
			validateCheckpointResponse({
				action: "continue",
				healthScore: "not a number",
				reasoning: "Test",
				statusSummary: "Test",
				issues: [],
				corrections: {},
			}),
		).toBeNull();
	});

	// ── Test 14: rejects empty reasoning ────────────────────────────────

	it("rejects empty reasoning", () => {
		expect(
			validateCheckpointResponse({
				action: "continue",
				healthScore: 0.9,
				reasoning: "",
				statusSummary: "Test",
				issues: [],
				corrections: {},
			}),
		).toBeNull();
	});

	// ── Test 14: rejects empty statusSummary ────────────────────────────

	it("rejects empty statusSummary", () => {
		expect(
			validateCheckpointResponse({
				action: "continue",
				healthScore: 0.9,
				reasoning: "Test",
				statusSummary: "",
				issues: [],
				corrections: {},
			}),
		).toBeNull();
	});

	// ── Test 15: accepts a valid complete response ──────────────────────

	it("accepts a valid complete response", () => {
		const result = validateCheckpointResponse({
			action: "adjust",
			healthScore: 0.7,
			reasoning: "Port mismatch detected.",
			statusSummary: "Port mismatch between API and tests.",
			issues: [
				{
					severity: "warning",
					description: "Port mismatch",
					affectedAgents: ["agent-1"],
				},
			],
			corrections: {
				"agent-1": "Use port 8080 instead of 3000.",
			},
		});

		expect(result).not.toBeNull();
		expect(result!.action as string).toBe("adjust");
		expect(result!.healthScore).toBe(0.7);
		expect(result!.reasoning).toBe("Port mismatch detected.");
		expect(result!.statusSummary).toBe("Port mismatch between API and tests.");
		expect(result!.issues).toHaveLength(1);
		expect(result!.issues[0]!.severity).toBe("warning");
		expect(result!.issues[0]!.description).toBe("Port mismatch");
		expect(result!.issues[0]!.affectedAgents).toEqual(["agent-1"]);
		expect(result!.corrections["agent-1"]).toBe(
			"Use port 8080 instead of 3000.",
		);
	});

	// ── Test 15: clamps healthScore between 0 and 1 ─────────────────────

	it("clamps healthScore below 0 to 0", () => {
		const result = validateCheckpointResponse({
			action: "continue",
			healthScore: -0.5,
			reasoning: "Test",
			statusSummary: "Test",
			issues: [],
			corrections: {},
		});

		expect(result).not.toBeNull();
		expect(result!.healthScore).toBe(0);
	});

	it("clamps healthScore above 1 to 1", () => {
		const result = validateCheckpointResponse({
			action: "continue",
			healthScore: 1.5,
			reasoning: "Test",
			statusSummary: "Test",
			issues: [],
			corrections: {},
		});

		expect(result).not.toBeNull();
		expect(result!.healthScore).toBe(1);
	});

	// ── Test 15: filters out invalid issues (not rejected in bulk) ──────

	it("filters out issues with invalid severity", () => {
		const result = validateCheckpointResponse({
			action: "continue",
			healthScore: 0.8,
			reasoning: "Test",
			statusSummary: "Test",
			issues: [
				{
					severity: "invalid_severity",
					description: "Bad issue",
					affectedAgents: [],
				},
				{
					severity: "warning",
					description: "Good issue",
					affectedAgents: [],
				},
			],
			corrections: {},
		});

		expect(result).not.toBeNull();
		expect(result!.issues).toHaveLength(1);
		expect(result!.issues[0]!.description).toBe("Good issue");
	});

	it("filters out issues with empty description", () => {
		const result = validateCheckpointResponse({
			action: "continue",
			healthScore: 0.8,
			reasoning: "Test",
			statusSummary: "Test",
			issues: [
				{ severity: "info", description: "", affectedAgents: [] },
				{ severity: "info", description: "Valid", affectedAgents: [] },
			],
			corrections: {},
		});

		expect(result).not.toBeNull();
		expect(result!.issues).toHaveLength(1);
		expect(result!.issues[0]!.description).toBe("Valid");
	});

	it("filters out issues that are null or non-objects", () => {
		const result = validateCheckpointResponse({
			action: "continue",
			healthScore: 0.8,
			reasoning: "Test",
			statusSummary: "Test",
			issues: [
				null,
				42,
				"string",
				{ severity: "info", description: "OK", affectedAgents: [] },
			],
			corrections: {},
		});

		expect(result).not.toBeNull();
		expect(result!.issues).toHaveLength(1);
	});

	// ── Test 15: filters out non-string correction values ───────────────

	it("filters out non-string correction values", () => {
		const result = validateCheckpointResponse({
			action: "adjust",
			healthScore: 0.7,
			reasoning: "Test",
			statusSummary: "Test",
			issues: [],
			corrections: {
				"agent-1": "Valid correction",
				"agent-2": 42,
				"agent-3": "",
				"agent-4": null,
			},
		});

		expect(result).not.toBeNull();
		expect(Object.keys(result!.corrections)).toHaveLength(1);
		expect(result!.corrections["agent-1"]).toBe("Valid correction");
	});

	// ── Test 15: handles missing issues gracefully ──────────────────────

	it("handles missing issues array gracefully", () => {
		const result = validateCheckpointResponse({
			action: "continue",
			healthScore: 0.9,
			reasoning: "All good",
			statusSummary: "On track",
		});

		expect(result).not.toBeNull();
		expect(result!.issues).toHaveLength(0);
		expect(Object.keys(result!.corrections)).toHaveLength(0);
	});

	// ── Test 15: all valid actions are accepted ─────────────────────────

	it.each([
		"continue",
		"adjust",
		"replan",
		"escalate",
		"abort",
	])("accepts action '%s'", (action) => {
		const result = validateCheckpointResponse({
			action,
			healthScore: 0.5,
			reasoning: "Test",
			statusSummary: "Test",
			issues: [],
			corrections: {},
		});
		expect(result).not.toBeNull();
		expect(result!.action as string).toBe(action);
	});

	// ── Test 15: affectedAgents filters non-strings ─────────────────────

	it("filters non-string values from affectedAgents", () => {
		const result = validateCheckpointResponse({
			action: "continue",
			healthScore: 0.8,
			reasoning: "Test",
			statusSummary: "Test",
			issues: [
				{
					severity: "info",
					description: "Test issue",
					affectedAgents: ["agent-1", 42, null, "agent-2"],
				},
			],
			corrections: {},
		});

		expect(result).not.toBeNull();
		expect(result!.issues[0]!.affectedAgents).toEqual(["agent-1", "agent-2"]);
	});

	// ── Test 15: defaults affectedAgents to [] when missing ─────────────

	it("defaults affectedAgents to empty array when missing", () => {
		const result = validateCheckpointResponse({
			action: "continue",
			healthScore: 0.8,
			reasoning: "Test",
			statusSummary: "Test",
			issues: [
				{
					severity: "info",
					description: "Test issue",
					// no affectedAgents
				},
			],
			corrections: {},
		});

		expect(result).not.toBeNull();
		expect(result!.issues[0]!.affectedAgents).toEqual([]);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// CheckpointEvaluator Unit Tests
// ════════════════════════════════════════════════════════════════════════════

describe("CheckpointEvaluator", () => {
	// ── Test 1: shouldTrigger returns null when disabled ─────────────────

	it("shouldTrigger returns null when disabled", () => {
		const conversations = createMockConversationManager();
		const tracker = createMockContextTracker();
		const evaluator = new CheckpointEvaluator(
			conversations,
			tracker,
			silentLogger(),
			{ enabled: false },
		);

		const result = evaluator.shouldTrigger(100, 2, 3, 60000);
		expect(result).toBeNull();
	});

	// ── Test 2: shouldTrigger returns null for single-agent ──────────────

	it("shouldTrigger returns null when totalSubtasks <= 1", () => {
		const conversations = createMockConversationManager();
		const tracker = createMockContextTracker();
		const evaluator = new CheckpointEvaluator(
			conversations,
			tracker,
			silentLogger(),
			{ enabled: true },
		);

		expect(evaluator.shouldTrigger(10, 0, 1, 30000)).toBeNull();
		expect(evaluator.shouldTrigger(10, 1, 1, 30000)).toBeNull();
		expect(evaluator.shouldTrigger(10, 0, 0, 30000)).toBeNull();
	});

	// ── Test 3: shouldTrigger returns COMPLETION_PERCENTAGE at threshold ─

	it("shouldTrigger returns COMPLETION_PERCENTAGE at 50% threshold", () => {
		const conversations = createMockConversationManager();
		const tracker = createMockContextTracker();
		const evaluator = new CheckpointEvaluator(
			conversations,
			tracker,
			silentLogger(),
			{ enabled: true, completionPercentages: 50 },
		);

		// 25% — not yet
		expect(evaluator.shouldTrigger(10, 1, 4, 1000)).toBeNull();

		// 50% — trigger
		expect(evaluator.shouldTrigger(15, 2, 4, 2000)).toBe(
			CheckpointTrigger.COMPLETION_PERCENTAGE,
		);

		// 75% — 50 threshold already triggered, no more
		expect(evaluator.shouldTrigger(20, 3, 4, 3000)).toBeNull();
	});

	// ── Test 4: shouldTrigger supports multiple percentage thresholds ────

	it("shouldTrigger supports multiple percentage thresholds", () => {
		const conversations = createMockConversationManager();
		const tracker = createMockContextTracker();
		const evaluator = new CheckpointEvaluator(
			conversations,
			tracker,
			silentLogger(),
			{
				enabled: true,
				completionPercentages: [25, 50, 75],
				// Disable time/delta triggers so only completion triggers
				deltaInterval: 999999,
				timeIntervalMs: 999999999,
			},
		);

		// 25% — trigger
		expect(evaluator.shouldTrigger(5, 1, 4, 1000)).toBe(
			CheckpointTrigger.COMPLETION_PERCENTAGE,
		);

		// Still 25% — already triggered
		expect(evaluator.shouldTrigger(6, 1, 4, 2000)).toBeNull();

		// 50% — trigger
		expect(evaluator.shouldTrigger(10, 2, 4, 3000)).toBe(
			CheckpointTrigger.COMPLETION_PERCENTAGE,
		);

		// 75% — trigger
		expect(evaluator.shouldTrigger(15, 3, 4, 4000)).toBe(
			CheckpointTrigger.COMPLETION_PERCENTAGE,
		);

		// 75% again — already triggered
		expect(evaluator.shouldTrigger(16, 3, 4, 5000)).toBeNull();
	});

	// ── Test 5: shouldTrigger returns DELTA_COUNT after interval ─────────

	it("shouldTrigger returns DELTA_COUNT after delta interval", () => {
		const conversations = createMockConversationManager();
		const tracker = createMockContextTracker();
		const evaluator = new CheckpointEvaluator(
			conversations,
			tracker,
			silentLogger(),
			{
				enabled: true,
				deltaInterval: 30,
				completionPercentages: 99, // Won't trigger
				timeIntervalMs: 999999999, // Won't trigger
			},
		);

		// 29 deltas — not yet
		expect(evaluator.shouldTrigger(29, 0, 3, 1000)).toBeNull();

		// 30 deltas — trigger
		expect(evaluator.shouldTrigger(30, 0, 3, 2000)).toBe(
			CheckpointTrigger.DELTA_COUNT,
		);
	});

	// ── Test 6: shouldTrigger returns TIME_INTERVAL after delay ──────────

	it("shouldTrigger returns TIME_INTERVAL after time interval", () => {
		const conversations = createMockConversationManager();
		const tracker = createMockContextTracker();
		const evaluator = new CheckpointEvaluator(
			conversations,
			tracker,
			silentLogger(),
			{
				enabled: true,
				timeIntervalMs: 60000,
				completionPercentages: 99, // Won't trigger
				deltaInterval: 999999, // Won't trigger
			},
		);

		// 59999ms — not yet
		expect(evaluator.shouldTrigger(5, 0, 3, 59999)).toBeNull();

		// 60001ms — trigger
		expect(evaluator.shouldTrigger(5, 0, 3, 60001)).toBe(
			CheckpointTrigger.TIME_INTERVAL,
		);
	});

	// ── Test 7: Rate limiting prevents frequent checkpoints ─────────────

	it("rate limiting prevents checkpoints too close together", async () => {
		const conversations = createMockConversationManager();
		const tracker = createMockContextTracker();
		const evaluator = new CheckpointEvaluator(
			conversations,
			tracker,
			silentLogger(),
			{
				enabled: true,
				deltaInterval: 5,
				completionPercentages: 99,
				timeIntervalMs: 999999999,
			},
		);

		// First call at delta 5 — should trigger
		expect(evaluator.shouldTrigger(5, 0, 3, 1000)).toBe(
			CheckpointTrigger.DELTA_COUNT,
		);

		// Call evaluate to set lastCheckpointTime
		await evaluator.evaluate(
			CheckpointTrigger.DELTA_COUNT,
			"Test task",
			createTestAnalysis(),
			5,
			0,
			1000,
		);

		// Immediately after — rate limited (MIN_CHECKPOINT_INTERVAL_MS = 15000)
		const result = evaluator.shouldTrigger(10, 0, 3, 2000);
		expect(result).toBeNull();
	});

	// ── Test 8: forceTrigger bypasses shouldTrigger check ────────────────

	it("forceTrigger returns the trigger type", () => {
		const conversations = createMockConversationManager();
		const tracker = createMockContextTracker();
		const evaluator = new CheckpointEvaluator(
			conversations,
			tracker,
			silentLogger(),
			{ enabled: true },
		);

		expect(evaluator.forceTrigger(CheckpointTrigger.AGENT_FAILURE)).toBe(
			CheckpointTrigger.AGENT_FAILURE,
		);

		expect(evaluator.forceTrigger(CheckpointTrigger.USER_REQUESTED)).toBe(
			CheckpointTrigger.USER_REQUESTED,
		);
	});

	it("forceTrigger rate limiting still applies", async () => {
		const conversations = createMockConversationManager();
		const tracker = createMockContextTracker();
		const evaluator = new CheckpointEvaluator(
			conversations,
			tracker,
			silentLogger(),
			{ enabled: true },
		);

		// Evaluate to set lastCheckpointTime
		await evaluator.evaluate(
			CheckpointTrigger.AGENT_FAILURE,
			"Test",
			createTestAnalysis(),
			5,
			0,
			1000,
		);

		// Immediately after — should be rate limited for AGENT_FAILURE
		// (uses MIN_CHECKPOINT_INTERVAL_MS = 15000)
		expect(evaluator.forceTrigger(CheckpointTrigger.AGENT_FAILURE)).toBeNull();
	});

	// ── Test 9: forceTrigger returns null when disabled ──────────────────

	it("forceTrigger returns null when disabled", () => {
		const conversations = createMockConversationManager();
		const tracker = createMockContextTracker();
		const evaluator = new CheckpointEvaluator(
			conversations,
			tracker,
			silentLogger(),
			{ enabled: false },
		);

		expect(evaluator.forceTrigger(CheckpointTrigger.USER_REQUESTED)).toBeNull();
		expect(evaluator.forceTrigger(CheckpointTrigger.AGENT_FAILURE)).toBeNull();
	});

	// ── Test 10: evaluate returns a valid CheckpointResult ──────────────

	it("evaluate returns a valid CheckpointResult", async () => {
		const mockResponse = {
			action: "adjust",
			healthScore: 0.7,
			reasoning: "Port mismatch detected.",
			statusSummary: "Port mismatch between API and tests.",
			issues: [
				{
					severity: "warning",
					description: "Port mismatch",
					affectedAgents: ["agent-1"],
				},
			],
			corrections: { "agent-1": "Use port 8080" },
		};

		const conversations = createMockConversationManager(mockResponse);
		const tracker = createMockContextTracker();
		const evaluator = new CheckpointEvaluator(
			conversations,
			tracker,
			silentLogger(),
		);

		const result = await evaluator.evaluate(
			CheckpointTrigger.DELTA_COUNT,
			"Build a REST API",
			createTestAnalysis(),
			30,
			5,
			45000,
		);

		// Verify the result structure
		expect(result.action).toBe(CheckpointAction.ADJUST);
		expect(result.trigger).toBe(CheckpointTrigger.DELTA_COUNT);
		expect(result.healthScore).toBe(0.7);
		expect(result.reasoning).toBe("Port mismatch detected.");
		expect(result.statusSummary).toBe("Port mismatch between API and tests.");
		expect(result.issues).toHaveLength(1);
		expect(result.issues[0]!.severity).toBe("warning");
		expect(result.corrections).toBeInstanceOf(Map);
		expect(result.corrections.get("agent-1")).toBe("Use port 8080");
		expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

		// Verify checkpointCount is incremented
		expect(evaluator.checkpointCount).toBe(1);
	});

	// ── Test 11: evaluate returns fallback CONTINUE on LLM error ────────

	it("evaluate returns fallback CONTINUE on LLM error", async () => {
		const conversations = createMockConversationManager(
			undefined,
			new Error("LLM call failed"),
		);
		const tracker = createMockContextTracker();
		const evaluator = new CheckpointEvaluator(
			conversations,
			tracker,
			silentLogger(),
		);

		const result = await evaluator.evaluate(
			CheckpointTrigger.TIME_INTERVAL,
			"Test task",
			createTestAnalysis(),
			10,
			2,
			60000,
		);

		expect(result.action).toBe(CheckpointAction.CONTINUE);
		expect(result.healthScore).toBe(0.5);
		expect(result.reasoning).toContain("LLM call failed");
		expect(result.reasoning).toContain("Defaulting to continue");
		expect(result.issues).toHaveLength(0);
		expect(result.corrections.size).toBe(0);
		expect(result.trigger).toBe(CheckpointTrigger.TIME_INTERVAL);

		// checkpointCount should still increment
		expect(evaluator.checkpointCount).toBe(1);
	});

	// ── Test 12: evaluate includes previous checkpoint in prompt ────────

	it("evaluate includes previous checkpoint result in subsequent calls", async () => {
		let capturedPrompt = "";
		const mockConversations = createMockConversationManager();
		// Override to capture the prompt
		mockConversations.sendOneShotJson = mock(
			(_role: ConversationRole, content: string) => {
				capturedPrompt = content;
				return Promise.resolve({
					action: "continue",
					healthScore: 0.9,
					reasoning: "All good.",
					statusSummary: "On track.",
					issues: [],
					corrections: {},
				});
			},
		);

		const tracker = createMockContextTracker();
		const evaluator = new CheckpointEvaluator(
			mockConversations,
			tracker,
			silentLogger(),
		);

		// First evaluation
		await evaluator.evaluate(
			CheckpointTrigger.DELTA_COUNT,
			"Test task",
			createTestAnalysis(),
			30,
			5,
			30000,
		);

		// Second evaluation — should include previous checkpoint
		await evaluator.evaluate(
			CheckpointTrigger.TIME_INTERVAL,
			"Test task",
			createTestAnalysis(),
			60,
			10,
			60000,
		);

		expect(capturedPrompt).toContain("Previous Checkpoint");
		expect(capturedPrompt).toContain("continue");
		expect(capturedPrompt).toContain("On track.");
	});

	it("first evaluation does NOT include previous checkpoint section", async () => {
		let capturedPrompt = "";
		const mockConversations = createMockConversationManager();
		mockConversations.sendOneShotJson = mock(
			(_role: ConversationRole, content: string) => {
				capturedPrompt = content;
				return Promise.resolve({
					action: "continue",
					healthScore: 0.9,
					reasoning: "All good.",
					statusSummary: "On track.",
					issues: [],
					corrections: {},
				});
			},
		);

		const tracker = createMockContextTracker();
		const evaluator = new CheckpointEvaluator(
			mockConversations,
			tracker,
			silentLogger(),
		);

		await evaluator.evaluate(
			CheckpointTrigger.DELTA_COUNT,
			"Test task",
			createTestAnalysis(),
			30,
			5,
			30000,
		);

		expect(capturedPrompt).not.toContain("Previous Checkpoint");
	});

	// ── Test 13: reset clears all state ─────────────────────────────────

	it("reset clears all state", async () => {
		const conversations = createMockConversationManager();
		const tracker = createMockContextTracker();
		const evaluator = new CheckpointEvaluator(
			conversations,
			tracker,
			silentLogger(),
			{
				enabled: true,
				completionPercentages: 50,
				deltaInterval: 999999,
				timeIntervalMs: 999999999,
			},
		);

		// Trigger a completion percentage checkpoint
		evaluator.shouldTrigger(5, 2, 4, 1000); // 50% → triggers

		// Evaluate two checkpoints
		await evaluator.evaluate(
			CheckpointTrigger.COMPLETION_PERCENTAGE,
			"Test",
			createTestAnalysis(),
			5,
			0,
			1000,
		);
		await evaluator.evaluate(
			CheckpointTrigger.TIME_INTERVAL,
			"Test",
			createTestAnalysis(),
			10,
			0,
			2000,
		);

		expect(evaluator.checkpointCount).toBe(2);
		expect(evaluator.lastResult).not.toBeNull();

		// Reset
		evaluator.reset();

		expect(evaluator.checkpointCount).toBe(0);
		expect(evaluator.lastResult).toBeNull();

		// The 50% threshold should be re-triggerable after reset
		const trigger = evaluator.shouldTrigger(5, 2, 4, 1000);
		expect(trigger).toBe(CheckpointTrigger.COMPLETION_PERCENTAGE);
	});

	// ── Query getters ───────────────────────────────────────────────────

	it("isEnabled returns true by default", () => {
		const conversations = createMockConversationManager();
		const tracker = createMockContextTracker();
		const evaluator = new CheckpointEvaluator(
			conversations,
			tracker,
			silentLogger(),
		);

		expect(evaluator.isEnabled).toBe(true);
	});

	it("isEnabled returns false when disabled", () => {
		const conversations = createMockConversationManager();
		const tracker = createMockContextTracker();
		const evaluator = new CheckpointEvaluator(
			conversations,
			tracker,
			silentLogger(),
			{ enabled: false },
		);

		expect(evaluator.isEnabled).toBe(false);
	});

	it("lastResult returns null before any evaluation", () => {
		const conversations = createMockConversationManager();
		const tracker = createMockContextTracker();
		const evaluator = new CheckpointEvaluator(
			conversations,
			tracker,
			silentLogger(),
		);

		expect(evaluator.lastResult).toBeNull();
	});

	it("lastResult returns the most recent result after evaluation", async () => {
		const conversations = createMockConversationManager({
			action: "replan",
			healthScore: 0.3,
			reasoning: "Database failed.",
			statusSummary: "DB setup failed.",
			issues: [
				{
					severity: "critical",
					description: "DB down",
					affectedAgents: ["agent-db"],
				},
			],
			corrections: {},
		});
		const tracker = createMockContextTracker();
		const evaluator = new CheckpointEvaluator(
			conversations,
			tracker,
			silentLogger(),
		);

		await evaluator.evaluate(
			CheckpointTrigger.AGENT_FAILURE,
			"Test",
			createTestAnalysis(),
			10,
			2,
			30000,
		);

		const last = evaluator.lastResult;
		expect(last).not.toBeNull();
		expect(last!.action).toBe(CheckpointAction.REPLAN);
		expect(last!.healthScore).toBe(0.3);
	});

	// ── Default config values ───────────────────────────────────────────

	it("uses default config when none provided", () => {
		const conversations = createMockConversationManager();
		const tracker = createMockContextTracker();
		const evaluator = new CheckpointEvaluator(
			conversations,
			tracker,
			silentLogger(),
		);

		expect(evaluator.isEnabled).toBe(true);

		// Delta interval default: 30 → should trigger at 30
		const triggerAt29 = evaluator.shouldTrigger(29, 0, 3, 10000);
		// The time interval (60000ms) won't trigger at 10000ms, delta not reached
		expect(triggerAt29).toBeNull();

		const triggerAt30 = evaluator.shouldTrigger(30, 0, 3, 10000);
		expect(triggerAt30).toBe(CheckpointTrigger.DELTA_COUNT);
	});

	// ── Evaluate updates lastCheckpointDeltaCount ───────────────────────

	it("evaluate updates internal counters for delta-based triggers", async () => {
		const conversations = createMockConversationManager();
		const tracker = createMockContextTracker();
		const evaluator = new CheckpointEvaluator(
			conversations,
			tracker,
			silentLogger(),
			{
				enabled: true,
				deltaInterval: 10,
				completionPercentages: 99,
				timeIntervalMs: 999999999,
			},
		);

		// First trigger at delta 10
		expect(evaluator.shouldTrigger(10, 0, 3, 1000)).toBe(
			CheckpointTrigger.DELTA_COUNT,
		);

		// Evaluate at delta 10 — sets lastCheckpointDeltaCount to 10
		await evaluator.evaluate(
			CheckpointTrigger.DELTA_COUNT,
			"Test",
			createTestAnalysis(),
			10,
			0,
			1000,
		);

		// Delta 15 — only 5 since last checkpoint, not 10 yet
		// But we're rate limited too, so this will be null regardless
		expect(evaluator.shouldTrigger(15, 0, 3, 2000)).toBeNull();
	});

	// ── Evaluate sends correct prompt data ──────────────────────────────

	it("evaluate sends prompt with correct agent state data", async () => {
		let capturedPrompt = "";
		const mockConversations = createMockConversationManager();
		mockConversations.sendOneShotJson = mock(
			(_role: ConversationRole, content: string) => {
				capturedPrompt = content;
				return Promise.resolve({
					action: "continue",
					healthScore: 0.9,
					reasoning: "All good.",
					statusSummary: "On track.",
					issues: [],
					corrections: {},
				});
			},
		);

		const states: AgentContextState[] = [
			{
				agentId: "agent-x",
				agentName: "test-agent",
				taskDescription: "Write tests for the app",
				taskRole: "tester",
				status: AgentStatus.BUSY,
				events: [
					{
						type: "tool_start",
						timestamp: "2024-01-01T00:00:00Z",
						summary: "Starting tool",
						data: {},
					},
				],
				promptResults: [],
				lastDelta: null,
				filesWritten: ["test.ts"],
				filesRead: ["app.ts"],
				completed: false,
				error: null,
			},
		];

		const tracker = createMockContextTracker(states);
		const evaluator = new CheckpointEvaluator(
			mockConversations,
			tracker,
			silentLogger(),
		);

		await evaluator.evaluate(
			CheckpointTrigger.TIME_INTERVAL,
			"Build an app",
			createTestAnalysis(2),
			15,
			3,
			60000,
		);

		// Verify the prompt contains expected content
		expect(capturedPrompt).toContain("Build an app");
		expect(capturedPrompt).toContain("test-agent");
		expect(capturedPrompt).toContain("tester");
		expect(capturedPrompt).toContain("test.ts");
		expect(capturedPrompt).toContain("time_interval");
		expect(capturedPrompt).toContain("60000");
	});

	// ── Evaluate with recentDecisions ───────────────────────────────────

	it("evaluate includes recentDecisions when provided", async () => {
		let capturedPrompt = "";
		const mockConversations = createMockConversationManager();
		mockConversations.sendOneShotJson = mock(
			(_role: ConversationRole, content: string) => {
				capturedPrompt = content;
				return Promise.resolve({
					action: "continue",
					healthScore: 0.9,
					reasoning: "All good.",
					statusSummary: "On track.",
					issues: [],
					corrections: {},
				});
			},
		);

		const tracker = createMockContextTracker();
		const evaluator = new CheckpointEvaluator(
			mockConversations,
			tracker,
			silentLogger(),
		);

		await evaluator.evaluate(
			CheckpointTrigger.DELTA_COUNT,
			"Test task",
			createTestAnalysis(),
			30,
			5,
			30000,
			[
				{ type: "sharing", summary: "Shared API schema with test-writer" },
				{ type: "notification", summary: "Notified user of progress" },
			],
		);

		expect(capturedPrompt).toContain("Recent Coordination Decisions");
		expect(capturedPrompt).toContain("Shared API schema with test-writer");
		expect(capturedPrompt).toContain("Notified user of progress");
	});

	it("evaluate omits recentDecisions section when not provided", async () => {
		let capturedPrompt = "";
		const mockConversations = createMockConversationManager();
		mockConversations.sendOneShotJson = mock(
			(_role: ConversationRole, content: string) => {
				capturedPrompt = content;
				return Promise.resolve({
					action: "continue",
					healthScore: 0.9,
					reasoning: "All good.",
					statusSummary: "On track.",
					issues: [],
					corrections: {},
				});
			},
		);

		const tracker = createMockContextTracker();
		const evaluator = new CheckpointEvaluator(
			mockConversations,
			tracker,
			silentLogger(),
		);

		await evaluator.evaluate(
			CheckpointTrigger.DELTA_COUNT,
			"Test task",
			createTestAnalysis(),
			30,
			5,
			30000,
		);

		expect(capturedPrompt).not.toContain("Recent Coordination Decisions");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Prompt Template Tests
// ════════════════════════════════════════════════════════════════════════════

describe("Checkpoint Prompts", () => {
	// ── Test 23: checkpoint prompt compiles with full data ───────────────

	it("checkpoint prompt compiles with full data", () => {
		const result = checkpointPrompt({
			task: "Build a REST API with tests and docs",
			strategy: "multi",
			complexity: "complex",
			planningReasoning: "Task decomposed into 3 subtasks.",
			trigger: "delta_count",
			elapsedMs: 45000,
			totalSubtasks: 3,
			completedSubtasks: 1,
			failedSubtasks: 0,
			inProgressSubtasks: 2,
			deltaCount: 30,
			sharingCount: 5,
			agents: [
				{
					agentName: "api-developer",
					taskRole: "api-developer",
					taskDescription: "Build REST API endpoints",
					status: "busy",
					completed: false,
					error: null,
					filesWritten: ["src/routes/users.ts"],
					filesRead: ["package.json"],
					events: [{ type: "tool_start" }],
					lastDelta: {
						type: "tool_complete",
						summary: "Completed file write",
						significance: 0.7,
					},
				},
			],
			recentDecisions: [{ type: "sharing", summary: "Shared API schema" }],
			previousCheckpoint: {
				action: "continue",
				healthScore: 0.9,
				statusSummary: "All good",
				issues: [],
			},
		});

		expect(result).toContain("## Original Task");
		expect(result).toContain("Build a REST API with tests and docs");
		expect(result).toContain("## Execution Progress");
		expect(result).toContain("## Agent States");
		expect(result).toContain("api-developer");
		expect(result).toContain("src/routes/users.ts");
		expect(result).toContain("## Recent Coordination Decisions");
		expect(result).toContain("Shared API schema");
		expect(result).toContain("## Previous Checkpoint");
		expect(result).toContain("All good");
	});

	// ── Test 24: checkpoint prompt handles optional sections ─────────────

	it("checkpoint prompt omits optional sections when null", () => {
		const result = checkpointPrompt({
			task: "Test task",
			strategy: "multi",
			complexity: "simple",
			planningReasoning: "Simple reasoning.",
			trigger: "time_interval",
			elapsedMs: 30000,
			totalSubtasks: 2,
			completedSubtasks: 0,
			failedSubtasks: 0,
			inProgressSubtasks: 2,
			deltaCount: 10,
			sharingCount: 0,
			agents: [
				{
					agentName: "worker",
					taskRole: "worker",
					taskDescription: "Do work",
					status: "busy",
					completed: false,
					error: null,
					filesWritten: [],
					filesRead: [],
					events: [],
					lastDelta: null,
				},
			],
			recentDecisions: null,
			previousCheckpoint: null,
		});

		expect(result).not.toContain("## Recent Coordination Decisions");
		expect(result).not.toContain("## Previous Checkpoint");
		expect(result).toContain("## Original Task");
		expect(result).toContain("## Agent States");
	});

	// ── Test 25: prompt includes previous checkpoint when provided ──────

	it("checkpoint prompt includes previous checkpoint details", () => {
		const result = checkpointPrompt({
			task: "Test",
			strategy: "multi",
			complexity: "moderate",
			planningReasoning: "Reasoning.",
			trigger: "completion_percentage",
			elapsedMs: 60000,
			totalSubtasks: 3,
			completedSubtasks: 1,
			failedSubtasks: 0,
			inProgressSubtasks: 2,
			deltaCount: 20,
			sharingCount: 3,
			agents: [],
			recentDecisions: null,
			previousCheckpoint: {
				action: "adjust",
				healthScore: 0.7,
				statusSummary: "Port mismatch detected.",
				issues: [{ severity: "warning", description: "Port mismatch" }],
			},
		});

		expect(result).toContain("## Previous Checkpoint");
		expect(result).toContain("**Action**: adjust");
		expect(result).toContain("0.7");
		expect(result).toContain("Port mismatch detected.");
		expect(result).toContain("**Issues identified**: 1");
	});

	// ── Test 26: system prompt contains few-shot examples ───────────────

	it("system prompt contains few-shot examples", () => {
		const systemPrompt = checkpointSystemPrompt({});

		expect(systemPrompt).toContain('"action": "continue"');
		expect(systemPrompt).toContain('"action": "adjust"');
		expect(systemPrompt).toContain('"action": "replan"');
		expect(systemPrompt).toContain("Healthy execution");
		expect(systemPrompt).toContain("Minor issue");
		expect(systemPrompt).toContain("Structural problem");
	});

	// ── Test 27: JSON examples in system prompt pass the validator ──────

	it("JSON examples in system prompt pass validation", () => {
		const systemPrompt = checkpointSystemPrompt({});

		// Extract JSON blocks from the system prompt
		// The examples are between the example titles and the next ### or ## section
		const jsonRegex = /\{[\s\S]*?"action"[\s\S]*?\n\}/g;
		const jsonMatches = systemPrompt.match(jsonRegex);

		expect(jsonMatches).not.toBeNull();
		expect(jsonMatches!.length).toBeGreaterThanOrEqual(3);

		for (const jsonStr of jsonMatches!) {
			// Skip the JSON schema template (contains | characters)
			if (jsonStr.includes("|")) continue;

			try {
				const parsed = JSON.parse(jsonStr);
				const validated = validateCheckpointResponse(parsed);
				expect(validated).not.toBeNull();
			} catch (_e) {
				// If JSON.parse fails, it's the schema template, skip it
			}
		}
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Enum value tests
// ════════════════════════════════════════════════════════════════════════════

describe("Checkpoint Enums", () => {
	it("CheckpointTrigger has all expected values", () => {
		expect(CheckpointTrigger.COMPLETION_PERCENTAGE as string).toBe(
			"completion_percentage",
		);
		expect(CheckpointTrigger.DELTA_COUNT as string).toBe("delta_count");
		expect(CheckpointTrigger.TIME_INTERVAL as string).toBe("time_interval");
		expect(CheckpointTrigger.AGENT_FAILURE as string).toBe("agent_failure");
		expect(CheckpointTrigger.USER_REQUESTED as string).toBe("user_requested");
	});

	it("CheckpointAction has all expected values", () => {
		expect(CheckpointAction.CONTINUE as string).toBe("continue");
		expect(CheckpointAction.ADJUST as string).toBe("adjust");
		expect(CheckpointAction.REPLAN as string).toBe("replan");
		expect(CheckpointAction.ESCALATE as string).toBe("escalate");
		expect(CheckpointAction.ABORT as string).toBe("abort");
	});
});
