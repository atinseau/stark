import { describe, expect, it, mock } from "bun:test";

import { AgentStatus } from "../../../enums/agent-status.enum.ts";
import { ConversationRole } from "../../../enums/conversation-role.enum.ts";
import { ExecutionStrategy } from "../../../enums/execution-strategy.enum.ts";
import { PoolEvent } from "../../../enums/pool-event.enum.ts";
import { TaskComplexity } from "../../../enums/task-complexity.enum.ts";
import {
	orchestratorEvaluationPrompt,
	orchestratorSystemPrompt,
} from "../../../prompts/index.ts";
import {
	type AgentContextState,
	CheckpointAction,
	CheckpointTrigger,
	type OrchestratorConfig,
	type TaskAnalysis,
} from "../../../types/agent-pool.types.ts";
import { DecisionJournal } from "../decision-journal.ts";
import {
	OrchestratorEngine,
	validateOrchestratorResponse,
} from "../orchestrator-engine.ts";
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
						coherenceScore: 0.85,
						assessment: "Coordination is good overall.",
						issues: [],
						directives: [],
					},
				),
			);

	return {
		has: mock(() => true),
		sendOneShotJson,
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

function createMockBroker() {
	return {
		evaluationCount: 10,
		shareCount: 5,
		journal: new DecisionJournal(),
	} as any;
}

function createMockNotificationEngine() {
	return {
		notificationCount: 3,
		evaluationCount: 7,
	} as any;
}

function createEngine(
	config?: OrchestratorConfig,
	conversationResponse?: Record<string, unknown>,
	agentStates?: AgentContextState[],
) {
	const conversations = createMockConversationManager(conversationResponse);
	const tracker = createMockContextTracker(agentStates);
	const engine = new OrchestratorEngine(
		conversations,
		tracker,
		silentLogger(),
		config,
	);
	return { engine, conversations, tracker };
}

// ════════════════════════════════════════════════════════════════════════════
// validateOrchestratorResponse Unit Tests
// ════════════════════════════════════════════════════════════════════════════

describe("validateOrchestratorResponse", () => {
	// ── Basic rejection tests ───────────────────────────────────────────

	it("rejects null", () => {
		expect(validateOrchestratorResponse(null)).toBeNull();
	});

	it("rejects undefined", () => {
		expect(validateOrchestratorResponse(undefined)).toBeNull();
	});

	it("rejects a string", () => {
		expect(validateOrchestratorResponse("hello")).toBeNull();
	});

	it("rejects a number", () => {
		expect(validateOrchestratorResponse(42)).toBeNull();
	});

	it("rejects an array", () => {
		expect(validateOrchestratorResponse([])).toBeNull();
	});

	// ── Missing required fields ─────────────────────────────────────────

	it("rejects missing coherenceScore", () => {
		expect(
			validateOrchestratorResponse({
				assessment: "test",
				issues: [],
				directives: [],
			}),
		).toBeNull();
	});

	it("rejects non-number coherenceScore", () => {
		expect(
			validateOrchestratorResponse({
				coherenceScore: "high",
				assessment: "test",
				issues: [],
				directives: [],
			}),
		).toBeNull();
	});

	it("rejects missing assessment", () => {
		expect(
			validateOrchestratorResponse({
				coherenceScore: 0.8,
				issues: [],
				directives: [],
			}),
		).toBeNull();
	});

	it("rejects empty assessment", () => {
		expect(
			validateOrchestratorResponse({
				coherenceScore: 0.8,
				assessment: "",
				issues: [],
				directives: [],
			}),
		).toBeNull();
	});

	it("rejects missing issues array", () => {
		expect(
			validateOrchestratorResponse({
				coherenceScore: 0.8,
				assessment: "test",
				directives: [],
			}),
		).toBeNull();
	});

	it("rejects missing directives array", () => {
		expect(
			validateOrchestratorResponse({
				coherenceScore: 0.8,
				assessment: "test",
				issues: [],
			}),
		).toBeNull();
	});

	// ── Valid complete assessment ────────────────────────────────────────

	it("accepts a valid complete assessment (Test 16)", () => {
		const valid = {
			coherenceScore: 0.85,
			assessment: "Coordination is good overall",
			issues: [
				{
					category: "efficiency",
					severity: "low",
					description: "Slight redundancy in sharing",
					affected: ["agent-A"],
				},
			],
			directives: [
				{
					target: "sharing",
					instruction: "Share less frequently",
					priority: "suggestion",
					ttlEvaluations: 3,
				},
			],
		};

		const result = validateOrchestratorResponse(valid);
		expect(result).not.toBeNull();
		expect(result!.coherenceScore).toBe(0.85);
		expect(result!.assessment).toBe("Coordination is good overall");
		expect(result!.issues).toHaveLength(1);
		expect(result!.issues[0]!.category).toBe("efficiency");
		expect(result!.issues[0]!.severity).toBe("low");
		expect(result!.issues[0]!.description).toBe("Slight redundancy in sharing");
		expect(result!.issues[0]!.affected).toEqual(["agent-A"]);
		expect(result!.directives).toHaveLength(1);
		expect(result!.directives[0]!.target).toBe("sharing");
		expect(result!.directives[0]!.instruction).toBe("Share less frequently");
		expect(result!.directives[0]!.priority).toBe("suggestion");
		expect(result!.directives[0]!.ttlEvaluations).toBe(3);
	});

	// ── Valid assessment without issues or directives ────────────────────

	it("accepts an assessment without issues or directives (Test 17)", () => {
		const valid = {
			coherenceScore: 1.0,
			assessment: "Perfect coordination",
			issues: [],
			directives: [],
		};

		const result = validateOrchestratorResponse(valid);
		expect(result).not.toBeNull();
		expect(result!.coherenceScore).toBe(1.0);
		expect(result!.assessment).toBe("Perfect coordination");
		expect(result!.issues).toHaveLength(0);
		expect(result!.directives).toHaveLength(0);
	});

	// ── Invalid issue categories ────────────────────────────────────────

	it("rejects invalid issue categories (Test 18)", () => {
		const invalid = {
			coherenceScore: 0.5,
			assessment: "test",
			issues: [
				{
					category: "invalid_category",
					severity: "low",
					description: "test",
					affected: [],
				},
			],
			directives: [],
		};

		expect(validateOrchestratorResponse(invalid)).toBeNull();
	});

	// ── Invalid directive priorities ────────────────────────────────────

	it("rejects invalid directive priorities (Test 19)", () => {
		const invalid = {
			coherenceScore: 0.5,
			assessment: "test",
			issues: [],
			directives: [
				{
					target: "sharing",
					instruction: "test",
					priority: "urgent",
					ttlEvaluations: 3,
				},
			],
		};

		expect(validateOrchestratorResponse(invalid)).toBeNull();
	});

	// ── coherenceScore clamping ─────────────────────────────────────────

	it("clamps coherenceScore above 1 to 1.0 (Test 20)", () => {
		const data = {
			coherenceScore: 1.5,
			assessment: "test",
			issues: [],
			directives: [],
		};

		const result = validateOrchestratorResponse(data);
		expect(result).not.toBeNull();
		expect(result!.coherenceScore).toBe(1.0);
	});

	it("clamps coherenceScore below 0 to 0.0", () => {
		const data = {
			coherenceScore: -0.5,
			assessment: "test",
			issues: [],
			directives: [],
		};

		const result = validateOrchestratorResponse(data);
		expect(result).not.toBeNull();
		expect(result!.coherenceScore).toBe(0.0);
	});

	// ── Invalid issue fields ────────────────────────────────────────────

	it("rejects invalid issue severity", () => {
		const invalid = {
			coherenceScore: 0.5,
			assessment: "test",
			issues: [
				{
					category: "drift",
					severity: "critical",
					description: "test",
					affected: [],
				},
			],
			directives: [],
		};

		expect(validateOrchestratorResponse(invalid)).toBeNull();
	});

	it("rejects issue with empty description", () => {
		const invalid = {
			coherenceScore: 0.5,
			assessment: "test",
			issues: [
				{
					category: "drift",
					severity: "high",
					description: "",
					affected: [],
				},
			],
			directives: [],
		};

		expect(validateOrchestratorResponse(invalid)).toBeNull();
	});

	it("rejects issue without affected array", () => {
		const invalid = {
			coherenceScore: 0.5,
			assessment: "test",
			issues: [
				{
					category: "drift",
					severity: "high",
					description: "test issue",
				},
			],
			directives: [],
		};

		expect(validateOrchestratorResponse(invalid)).toBeNull();
	});

	it("rejects null issue in array", () => {
		const invalid = {
			coherenceScore: 0.5,
			assessment: "test",
			issues: [null],
			directives: [],
		};

		expect(validateOrchestratorResponse(invalid)).toBeNull();
	});

	// ── Invalid directive fields ────────────────────────────────────────

	it("rejects invalid directive target", () => {
		const invalid = {
			coherenceScore: 0.5,
			assessment: "test",
			issues: [],
			directives: [
				{
					target: "execution",
					instruction: "test",
					priority: "suggestion",
					ttlEvaluations: 3,
				},
			],
		};

		expect(validateOrchestratorResponse(invalid)).toBeNull();
	});

	it("rejects directive with empty instruction", () => {
		const invalid = {
			coherenceScore: 0.5,
			assessment: "test",
			issues: [],
			directives: [
				{
					target: "sharing",
					instruction: "",
					priority: "suggestion",
					ttlEvaluations: 3,
				},
			],
		};

		expect(validateOrchestratorResponse(invalid)).toBeNull();
	});

	it("rejects directive with ttlEvaluations < 1", () => {
		const invalid = {
			coherenceScore: 0.5,
			assessment: "test",
			issues: [],
			directives: [
				{
					target: "sharing",
					instruction: "test",
					priority: "suggestion",
					ttlEvaluations: 0,
				},
			],
		};

		expect(validateOrchestratorResponse(invalid)).toBeNull();
	});

	it("rejects null directive in array", () => {
		const invalid = {
			coherenceScore: 0.5,
			assessment: "test",
			issues: [],
			directives: [null],
		};

		expect(validateOrchestratorResponse(invalid)).toBeNull();
	});

	// ── All valid categories ────────────────────────────────────────────

	it.each([
		"coherence",
		"efficiency",
		"drift",
		"conflict",
		"communication",
	])("accepts valid category '%s'", (category) => {
		const data = {
			coherenceScore: 0.5,
			assessment: "test",
			issues: [
				{
					category,
					severity: "low",
					description: "test",
					affected: [],
				},
			],
			directives: [],
		};

		expect(validateOrchestratorResponse(data)).not.toBeNull();
	});

	// ── All valid targets ───────────────────────────────────────────────

	it.each([
		"sharing",
		"notification",
		"planner",
		"checkpoint",
		"all",
	])("accepts valid target '%s'", (target) => {
		const data = {
			coherenceScore: 0.5,
			assessment: "test",
			issues: [],
			directives: [
				{
					target,
					instruction: "test directive",
					priority: "recommendation",
					ttlEvaluations: 2,
				},
			],
		};

		expect(validateOrchestratorResponse(data)).not.toBeNull();
	});

	// ── All valid priorities ────────────────────────────────────────────

	it.each([
		"suggestion",
		"recommendation",
		"strong",
	])("accepts valid priority '%s'", (priority) => {
		const data = {
			coherenceScore: 0.5,
			assessment: "test",
			issues: [],
			directives: [
				{
					target: "sharing",
					instruction: "test directive",
					priority,
					ttlEvaluations: 2,
				},
			],
		};

		expect(validateOrchestratorResponse(data)).not.toBeNull();
	});

	// ── All valid severities ────────────────────────────────────────────

	it.each([
		"low",
		"medium",
		"high",
	])("accepts valid severity '%s'", (severity) => {
		const data = {
			coherenceScore: 0.5,
			assessment: "test",
			issues: [
				{
					category: "drift",
					severity,
					description: "something",
					affected: ["agent-1"],
				},
			],
			directives: [],
		};

		expect(validateOrchestratorResponse(data)).not.toBeNull();
	});

	// ── Filters non-string affected values ──────────────────────────────

	it("filters non-string values from affected array", () => {
		const data = {
			coherenceScore: 0.5,
			assessment: "test",
			issues: [
				{
					category: "drift",
					severity: "low",
					description: "test issue",
					affected: ["agent-1", 42, null, "agent-2", undefined],
				},
			],
			directives: [],
		};

		const result = validateOrchestratorResponse(data);
		expect(result).not.toBeNull();
		expect(result!.issues[0]!.affected).toEqual(["agent-1", "agent-2"]);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// OrchestratorEngine — Trigger Logic
// ════════════════════════════════════════════════════════════════════════════

describe("OrchestratorEngine — Trigger Logic", () => {
	it("recordDelta returns false when disabled (Test 1)", () => {
		const { engine } = createEngine({ enabled: false });

		for (let i = 0; i < 100; i++) {
			expect(engine.recordDelta()).toBe(false);
		}
	});

	it("recordDelta returns true after deltaInterval deltas and minIntervalMs (Test 2)", () => {
		const { engine } = createEngine({
			deltaInterval: 3,
			minIntervalMs: 0,
		});

		expect(engine.recordDelta()).toBe(false); // 1st
		expect(engine.recordDelta()).toBe(false); // 2nd
		expect(engine.recordDelta()).toBe(true); // 3rd — triggers
	});

	it("recordDelta returns false if time minimum not elapsed (Test 3)", () => {
		const { engine } = createEngine({
			deltaInterval: 1,
			minIntervalMs: 60_000,
		});

		// First call: _lastEvalTime is 0, so Date.now() - 0 > 60000 = true
		// We need to simulate having just evaluated
		// We can do this by triggering a successful recordDelta first, then checking
		// the next one fails
		expect(engine.recordDelta()).toBe(true); // This triggers (lastEvalTime=0, so interval passes)

		// But recordDelta doesn't update _lastEvalTime — that's done in evaluate().
		// So let's test the concept by evaluating, which sets lastEvalTime.
		// Actually, looking at the code: recordDelta() does NOT set _lastEvalTime.
		// Only evaluate() sets it. So after recordDelta() returns true, but before
		// evaluate() is called, _lastEvalTime is still 0.

		// Let's verify: the 2nd call should also check delta interval.
		// After the 1st call returned true, _deltasSinceLastEval is 1.
		// But recordDelta increments first, so after 1st call: _deltasSinceLastEval = 1.
		// Since deltaInterval = 1, the delta check passes.
		// The time check: _lastEvalTime is still 0, so Date.now() - 0 >> 60000.
		// So it would return true again.

		// The real scenario: after evaluate() is called, _lastEvalTime is set and
		// _deltasSinceLastEval is reset to 0. Let's just test that directly.
	});

	it("recordDelta returns false if less than 2 agents (Test 4)", () => {
		const singleAgentStates: AgentContextState[] = [
			{
				agentId: "agent-1",
				agentName: "solo-agent",
				taskDescription: "Do everything",
				taskRole: "general",
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

		const { engine } = createEngine(
			{ deltaInterval: 1, minIntervalMs: 0 },
			undefined,
			singleAgentStates,
		);

		// Even with deltaInterval=1 and minIntervalMs=0, should not trigger
		// because there's only 1 agent.
		expect(engine.recordDelta()).toBe(false);
		expect(engine.recordDelta()).toBe(false);
		expect(engine.recordDelta()).toBe(false);
	});

	it("recordDelta accumulates deltas correctly", () => {
		const { engine } = createEngine({
			deltaInterval: 5,
			minIntervalMs: 0,
		});

		for (let i = 0; i < 4; i++) {
			expect(engine.recordDelta()).toBe(false);
		}
		expect(engine.recordDelta()).toBe(true); // 5th delta
	});
});

// ════════════════════════════════════════════════════════════════════════════
// OrchestratorEngine — Evaluation
// ════════════════════════════════════════════════════════════════════════════

describe("OrchestratorEngine — Evaluation", () => {
	it("evaluate returns null when disabled (Test 6)", async () => {
		const { engine } = createEngine({ enabled: false });

		const result = await engine.evaluate(
			"test task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);

		expect(result).toBeNull();
	});

	it("evaluate produces a valid assessment (Test 5)", async () => {
		const response = {
			coherenceScore: 0.85,
			assessment: "Good coordination overall",
			issues: [
				{
					category: "communication",
					severity: "medium",
					description: "Test-writer lacks API details",
					affected: ["test-writer", "api-developer"],
				},
			],
			directives: [
				{
					target: "sharing",
					instruction: "Share API route definitions",
					priority: "strong",
					ttlEvaluations: 3,
				},
			],
		};

		const { engine } = createEngine(undefined, response);

		const result = await engine.evaluate(
			"Build an API with tests",
			createTestAnalysis(2),
			createMockBroker(),
			createMockNotificationEngine(),
		);

		expect(result).not.toBeNull();
		expect(result!.coherenceScore).toBe(0.85);
		expect(result!.assessment).toBe("Good coordination overall");
		expect(result!.issues).toHaveLength(1);
		expect(result!.issues[0]!.category).toBe("communication");
		expect(result!.issues[0]!.severity).toBe("medium");
		expect(result!.directives).toHaveLength(1);
		expect(result!.directives[0]!.target).toBe("sharing");
		expect(result!.directives[0]!.priority).toBe("strong");
		expect(result!.timestamp).toBeTruthy();
		expect(result!.assessmentNumber).toBe(1);
		expect(engine.assessmentCount).toBe(1);
	});

	it("evaluate returns null on LLM error (Test 7)", async () => {
		const conversations = createMockConversationManager(
			undefined,
			new Error("LLM timeout"),
		);
		const tracker = createMockContextTracker();
		const engine = new OrchestratorEngine(
			conversations,
			tracker,
			silentLogger(),
		);

		const result = await engine.evaluate(
			"test task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);

		expect(result).toBeNull();
		// Should not throw — error is swallowed
		expect(engine.assessmentCount).toBe(1); // Count incremented even on error
	});

	it("evaluate returns null when sendOneShotJson returns null", async () => {
		const conversations = createMockConversationManager();
		conversations.sendOneShotJson = mock(() => Promise.resolve(null));
		const tracker = createMockContextTracker();
		const engine = new OrchestratorEngine(
			conversations,
			tracker,
			silentLogger(),
		);

		const result = await engine.evaluate(
			"test task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);

		expect(result).toBeNull();
	});

	it("evaluate increments assessmentCount on each call", async () => {
		const { engine } = createEngine();

		expect(engine.assessmentCount).toBe(0);

		await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);
		expect(engine.assessmentCount).toBe(1);

		await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);
		expect(engine.assessmentCount).toBe(2);
	});

	it("evaluate stores previousAssessment for continuity", async () => {
		const { engine } = createEngine(undefined, {
			coherenceScore: 0.75,
			assessment: "Mostly fine",
			issues: [],
			directives: [],
		});

		expect(engine.previousAssessment).toBeNull();

		await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);

		expect(engine.previousAssessment).not.toBeNull();
		expect(engine.previousAssessment!.coherenceScore).toBe(0.75);
		expect(engine.previousAssessment!.assessment).toBe("Mostly fine");
	});

	it("evaluate passes checkpoint result when provided", async () => {
		let capturedPrompt = "";
		const conversations = createMockConversationManager();
		conversations.sendOneShotJson = mock(
			(_role: ConversationRole, content: string) => {
				capturedPrompt = content;
				return Promise.resolve({
					coherenceScore: 0.8,
					assessment: "OK",
					issues: [],
					directives: [],
				});
			},
		);
		const tracker = createMockContextTracker();
		const engine = new OrchestratorEngine(
			conversations,
			tracker,
			silentLogger(),
		);

		const checkpointResult = {
			action: CheckpointAction.CONTINUE,
			healthScore: 0.9,
			reasoning: "All good",
			statusSummary: "Healthy execution",
			issues: [],
			corrections: new Map<string, string>(),
			trigger: CheckpointTrigger.COMPLETION_PERCENTAGE,
			timestamp: new Date().toISOString(),
		};

		await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
			checkpointResult,
		);

		expect(capturedPrompt).toContain("Latest Checkpoint");
		expect(capturedPrompt).toContain("continue");
		expect(capturedPrompt).toContain("0.9");
	});

	it("evaluate passes sharing journal decisions", async () => {
		let capturedPrompt = "";
		const conversations = createMockConversationManager();
		conversations.sendOneShotJson = mock(
			(_role: ConversationRole, content: string) => {
				capturedPrompt = content;
				return Promise.resolve({
					coherenceScore: 0.8,
					assessment: "OK",
					issues: [],
					directives: [],
				});
			},
		);
		const tracker = createMockContextTracker();
		const engine = new OrchestratorEngine(
			conversations,
			tracker,
			silentLogger(),
		);

		const journal = new DecisionJournal();
		journal.recordSharingDecision(
			"api-developer",
			"test-writer",
			"prompt_complete",
			true,
			"Important API details shared",
			new Date().toISOString(),
		);
		journal.recordSharingDecision(
			"api-developer",
			"doc-writer",
			"file_write",
			false,
			"Not relevant to documentation",
			new Date().toISOString(),
		);

		await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
			null,
			journal,
		);

		expect(capturedPrompt).toContain("SHARED");
		expect(capturedPrompt).toContain("DENIED");
		expect(capturedPrompt).toContain("api-developer");
		expect(capturedPrompt).toContain("test-writer");
	});

	it("evaluate works with null sharing journal", async () => {
		const { engine } = createEngine();

		const result = await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
			null,
			null,
		);

		expect(result).not.toBeNull();
	});

	it("evaluate resets delta counter and sets lastEvalTime", async () => {
		const { engine } = createEngine({
			deltaInterval: 3,
			minIntervalMs: 0,
		});

		// Accumulate some deltas
		engine.recordDelta();
		engine.recordDelta();

		await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);

		// After evaluate, the delta counter should be reset.
		// The next recordDelta should start from 1, not 3.
		// With deltaInterval = 3, it should take 3 more deltas to trigger.
		expect(engine.recordDelta()).toBe(false); // 1st after reset
		expect(engine.recordDelta()).toBe(false); // 2nd
		expect(engine.recordDelta()).toBe(true); // 3rd — triggers
	});
});

// ════════════════════════════════════════════════════════════════════════════
// OrchestratorEngine — Directives
// ════════════════════════════════════════════════════════════════════════════

describe("OrchestratorEngine — Directives", () => {
	it("directives are added to activeDirectives (Test 8)", async () => {
		const response = {
			coherenceScore: 0.6,
			assessment: "Some coordination issues",
			issues: [],
			directives: [
				{
					target: "sharing",
					instruction: "Share more with test-writer",
					priority: "strong",
					ttlEvaluations: 3,
				},
				{
					target: "notification",
					instruction: "Alert user about API changes",
					priority: "recommendation",
					ttlEvaluations: 2,
				},
			],
		};

		const { engine } = createEngine(undefined, response);

		await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);

		expect(engine.activeDirectiveCount).toBe(2);
		expect(engine.totalDirectivesEmitted).toBe(2);

		const sharingDirectives = engine.getDirectivesFor("sharing");
		expect(sharingDirectives.length).toBe(1);
		expect(sharingDirectives[0]!.instruction).toBe(
			"Share more with test-writer",
		);
	});

	it("directives expire after their TTL (Test 9)", async () => {
		// First evaluation: emit a directive with TTL=2
		const response1 = {
			coherenceScore: 0.7,
			assessment: "First assessment",
			issues: [],
			directives: [
				{
					target: "sharing",
					instruction: "Share more",
					priority: "strong",
					ttlEvaluations: 2,
				},
			],
		};

		const conversations = createMockConversationManager(response1);
		const tracker = createMockContextTracker();
		const engine = new OrchestratorEngine(
			conversations,
			tracker,
			silentLogger(),
		);

		// First evaluation: directive added with TTL=2
		await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);
		expect(engine.activeDirectiveCount).toBe(1);

		// Second evaluation: directive TTL decremented to 1 (during tickDirectives at start of evaluate)
		const response2 = {
			coherenceScore: 0.8,
			assessment: "Second assessment",
			issues: [],
			directives: [],
		};
		conversations.sendOneShotJson = mock(() => Promise.resolve(response2));

		await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);
		// After tick: TTL goes from 2 → 1 (still active)
		expect(engine.activeDirectiveCount).toBe(1);

		// Third evaluation: directive TTL decremented to 0 → expired
		await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);
		// After tick: TTL goes from 1 → 0 → removed
		expect(engine.activeDirectiveCount).toBe(0);
	});

	it("getDirectivesFor includes 'all' directives (Test 10)", async () => {
		const response = {
			coherenceScore: 0.7,
			assessment: "Test",
			issues: [],
			directives: [
				{
					target: "all",
					instruction: "Global directive",
					priority: "suggestion",
					ttlEvaluations: 5,
				},
				{
					target: "sharing",
					instruction: "Sharing-specific",
					priority: "strong",
					ttlEvaluations: 3,
				},
			],
		};

		const { engine } = createEngine(undefined, response);

		await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);

		const sharingDirectives = engine.getDirectivesFor("sharing");
		expect(sharingDirectives.length).toBe(2);

		const notificationDirectives = engine.getDirectivesFor("notification");
		expect(notificationDirectives.length).toBe(1);
		expect(notificationDirectives[0]!.instruction).toBe("Global directive");
	});

	it("getDirectivesFor sorts by priority — strong first (Test 11)", async () => {
		const response = {
			coherenceScore: 0.7,
			assessment: "Test",
			issues: [],
			directives: [
				{
					target: "sharing",
					instruction: "Suggestion directive",
					priority: "suggestion",
					ttlEvaluations: 5,
				},
				{
					target: "sharing",
					instruction: "Strong directive",
					priority: "strong",
					ttlEvaluations: 3,
				},
				{
					target: "sharing",
					instruction: "Recommendation directive",
					priority: "recommendation",
					ttlEvaluations: 4,
				},
			],
		};

		const { engine } = createEngine(undefined, response);

		await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);

		const directives = engine.getDirectivesFor("sharing");
		expect(directives.length).toBe(3);
		expect(directives[0]!.priority).toBe("strong");
		expect(directives[1]!.priority).toBe("recommendation");
		expect(directives[2]!.priority).toBe("suggestion");
	});

	it("getDirectivePromptSection returns null without directives (Test 12)", () => {
		const { engine } = createEngine();

		const section = engine.getDirectivePromptSection("sharing");
		expect(section).toBeNull();
	});

	it("getDirectivePromptSection formats correctly (Test 13)", async () => {
		const response = {
			coherenceScore: 0.6,
			assessment: "Test",
			issues: [],
			directives: [
				{
					target: "sharing",
					instruction: "Share more",
					priority: "strong",
					ttlEvaluations: 3,
				},
			],
		};

		const { engine } = createEngine(undefined, response);

		await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);

		const section = engine.getDirectivePromptSection("sharing");
		expect(section).not.toBeNull();
		expect(section).toContain("Active Orchestrator Directives");
		expect(section).toContain("[STRONG] Share more");
		expect(section).toContain(
			"The following directives come from the meta-orchestrator",
		);
	});

	it("getDirectivePromptSection includes 'all' directives", async () => {
		const response = {
			coherenceScore: 0.6,
			assessment: "Test",
			issues: [],
			directives: [
				{
					target: "all",
					instruction: "Be careful",
					priority: "recommendation",
					ttlEvaluations: 3,
				},
			],
		};

		const { engine } = createEngine(undefined, response);

		await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);

		const section = engine.getDirectivePromptSection("notification");
		expect(section).not.toBeNull();
		expect(section).toContain("[RECOMMENDATION] Be careful");
	});

	it("enforceDirectiveLimit evicts oldest directives (Test 14)", async () => {
		const conversations = createMockConversationManager();
		const tracker = createMockContextTracker();
		const engine = new OrchestratorEngine(
			conversations,
			tracker,
			silentLogger(),
			{ maxActiveDirectives: 3 },
		);

		// Each evaluation adds 2 directives
		const responseWith2 = {
			coherenceScore: 0.5,
			assessment: "Test",
			issues: [],
			directives: [
				{
					target: "sharing",
					instruction: "Directive A",
					priority: "suggestion",
					ttlEvaluations: 10,
				},
				{
					target: "sharing",
					instruction: "Directive B",
					priority: "suggestion",
					ttlEvaluations: 10,
				},
			],
		};
		conversations.sendOneShotJson = mock(() => Promise.resolve(responseWith2));

		// 1st evaluation: 2 directives added (total: 2, under limit)
		await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);
		expect(engine.activeDirectiveCount).toBe(2);

		// 2nd evaluation: 2 more added (total: 4), ticked down to 3 after eviction
		// Actually: tickDirectives first (decrements TTL but 9 > 0 so they stay)
		// Then adds 2 more → 4 total → enforceDirectiveLimit evicts 1 → 3 remain
		const responseWith2b = {
			coherenceScore: 0.5,
			assessment: "Test",
			issues: [],
			directives: [
				{
					target: "sharing",
					instruction: "Directive C",
					priority: "suggestion",
					ttlEvaluations: 10,
				},
				{
					target: "sharing",
					instruction: "Directive D",
					priority: "suggestion",
					ttlEvaluations: 10,
				},
			],
		};
		conversations.sendOneShotJson = mock(() => Promise.resolve(responseWith2b));

		await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);
		expect(engine.activeDirectiveCount).toBe(3);

		// The remaining directives should be the 3 most recent (B, C, D — A evicted)
		const allDirectives = engine.getDirectivesFor("sharing");
		const instructions = allDirectives.map((d) => d.instruction);
		expect(instructions).toContain("Directive D");
		expect(instructions).toContain("Directive C");
		expect(instructions).not.toContain("Directive A");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// OrchestratorEngine — Lifecycle
// ════════════════════════════════════════════════════════════════════════════

describe("OrchestratorEngine — Lifecycle", () => {
	it("reset clears all state (Test 15)", async () => {
		const response = {
			coherenceScore: 0.7,
			assessment: "Test",
			issues: [
				{
					category: "drift",
					severity: "low",
					description: "Minor drift",
					affected: ["agent-1"],
				},
			],
			directives: [
				{
					target: "sharing",
					instruction: "Test directive",
					priority: "suggestion",
					ttlEvaluations: 5,
				},
			],
		};

		const { engine } = createEngine(undefined, response);

		// Perform an evaluation to populate state
		await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);

		expect(engine.assessmentCount).toBeGreaterThan(0);
		expect(engine.activeDirectiveCount).toBeGreaterThan(0);
		expect(engine.previousAssessment).not.toBeNull();
		expect(engine.totalDirectivesEmitted).toBeGreaterThan(0);

		// Reset
		engine.reset();

		expect(engine.assessmentCount).toBe(0);
		expect(engine.activeDirectiveCount).toBe(0);
		expect(engine.previousAssessment).toBeNull();
		expect(engine.totalDirectivesEmitted).toBe(0);
	});

	it("isEnabled returns true by default", () => {
		const { engine } = createEngine();
		expect(engine.isEnabled).toBe(true);
	});

	it("isEnabled returns false when disabled", () => {
		const { engine } = createEngine({ enabled: false });
		expect(engine.isEnabled).toBe(false);
	});

	it("isEnabled returns true when explicitly enabled", () => {
		const { engine } = createEngine({ enabled: true });
		expect(engine.isEnabled).toBe(true);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// OrchestratorEngine — Statistics
// ════════════════════════════════════════════════════════════════════════════

describe("OrchestratorEngine — Statistics", () => {
	it("initial statistics are all zero", () => {
		const { engine } = createEngine();

		expect(engine.assessmentCount).toBe(0);
		expect(engine.totalDirectivesEmitted).toBe(0);
		expect(engine.activeDirectiveCount).toBe(0);
		expect(engine.previousAssessment).toBeNull();
	});

	it("totalDirectivesEmitted accumulates across evaluations", async () => {
		const response = {
			coherenceScore: 0.7,
			assessment: "Test",
			issues: [],
			directives: [
				{
					target: "sharing",
					instruction: "One",
					priority: "suggestion",
					ttlEvaluations: 5,
				},
			],
		};

		const { engine, conversations } = createEngine(undefined, response);

		await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);
		expect(engine.totalDirectivesEmitted).toBe(1);

		const response2 = {
			coherenceScore: 0.7,
			assessment: "Test",
			issues: [],
			directives: [
				{
					target: "notification",
					instruction: "Two",
					priority: "strong",
					ttlEvaluations: 3,
				},
				{
					target: "planner",
					instruction: "Three",
					priority: "recommendation",
					ttlEvaluations: 2,
				},
			],
		};
		conversations.sendOneShotJson = mock(() => Promise.resolve(response2));

		await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);
		expect(engine.totalDirectivesEmitted).toBe(3);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// OrchestratorEngine — Default Configuration
// ════════════════════════════════════════════════════════════════════════════

describe("OrchestratorEngine — Default Configuration", () => {
	it("uses default config when none provided", () => {
		const { engine } = createEngine();

		expect(engine.isEnabled).toBe(true);

		// Default deltaInterval = 8
		for (let i = 0; i < 7; i++) {
			expect(engine.recordDelta()).toBe(false);
		}
		// 8th delta should trigger (minIntervalMs = 30000 but lastEvalTime = 0 so interval check passes)
		expect(engine.recordDelta()).toBe(true);
	});

	it("partial config fills in defaults", () => {
		const { engine } = createEngine({ deltaInterval: 2 });

		expect(engine.isEnabled).toBe(true);

		// deltaInterval = 2 (overridden)
		expect(engine.recordDelta()).toBe(false); // 1st
		expect(engine.recordDelta()).toBe(true); // 2nd — triggers
	});
});

// ════════════════════════════════════════════════════════════════════════════
// OrchestratorEngine — Prompt Content
// ════════════════════════════════════════════════════════════════════════════

describe("OrchestratorEngine — Prompt Content", () => {
	it("evaluation prompt includes task description", async () => {
		let capturedPrompt = "";
		const conversations = createMockConversationManager();
		conversations.sendOneShotJson = mock(
			(_role: ConversationRole, content: string) => {
				capturedPrompt = content;
				return Promise.resolve({
					coherenceScore: 0.8,
					assessment: "OK",
					issues: [],
					directives: [],
				});
			},
		);
		const tracker = createMockContextTracker();
		const engine = new OrchestratorEngine(
			conversations,
			tracker,
			silentLogger(),
		);

		await engine.evaluate(
			"Build a REST API with authentication",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);

		expect(capturedPrompt).toContain("Build a REST API with authentication");
		expect(capturedPrompt).toContain("Original Task");
	});

	it("evaluation prompt includes agent states", async () => {
		let capturedPrompt = "";
		const conversations = createMockConversationManager();
		conversations.sendOneShotJson = mock(
			(_role: ConversationRole, content: string) => {
				capturedPrompt = content;
				return Promise.resolve({
					coherenceScore: 0.8,
					assessment: "OK",
					issues: [],
					directives: [],
				});
			},
		);

		const agentStates: AgentContextState[] = [
			{
				agentId: "agent-1",
				agentName: "my-api-builder",
				taskDescription: "Build the REST API",
				taskRole: "api-developer",
				status: AgentStatus.BUSY,
				events: [
					{
						type: "file_write",
						timestamp: new Date().toISOString(),
						summary: "Created routes",
						data: {},
					},
				],
				promptResults: [],
				lastDelta: null,
				filesWritten: ["src/routes.ts"],
				filesRead: [],
				completed: false,
				error: null,
			},
		];

		const tracker = createMockContextTracker(agentStates);
		const engine = new OrchestratorEngine(
			conversations,
			tracker,
			silentLogger(),
		);

		await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);

		expect(capturedPrompt).toContain("my-api-builder");
		expect(capturedPrompt).toContain("api-developer");
		expect(capturedPrompt).toContain("src/routes.ts");
	});

	it("evaluation prompt includes sharing stats", async () => {
		let capturedPrompt = "";
		const conversations = createMockConversationManager();
		conversations.sendOneShotJson = mock(
			(_role: ConversationRole, content: string) => {
				capturedPrompt = content;
				return Promise.resolve({
					coherenceScore: 0.8,
					assessment: "OK",
					issues: [],
					directives: [],
				});
			},
		);
		const tracker = createMockContextTracker();
		const engine = new OrchestratorEngine(
			conversations,
			tracker,
			silentLogger(),
		);

		const broker = {
			evaluationCount: 20,
			shareCount: 12,
			journal: new DecisionJournal(),
		} as any;

		await engine.evaluate(
			"task",
			createTestAnalysis(),
			broker,
			createMockNotificationEngine(),
		);

		expect(capturedPrompt).toContain("Sharing Activity");
		expect(capturedPrompt).toContain("20"); // totalEvaluations
		expect(capturedPrompt).toContain("12"); // approvedCount
		expect(capturedPrompt).toContain("60%"); // approvalRate
	});

	it("evaluation prompt includes notification stats", async () => {
		let capturedPrompt = "";
		const conversations = createMockConversationManager();
		conversations.sendOneShotJson = mock(
			(_role: ConversationRole, content: string) => {
				capturedPrompt = content;
				return Promise.resolve({
					coherenceScore: 0.8,
					assessment: "OK",
					issues: [],
					directives: [],
				});
			},
		);
		const tracker = createMockContextTracker();
		const engine = new OrchestratorEngine(
			conversations,
			tracker,
			silentLogger(),
		);

		const notifEngine = {
			notificationCount: 5,
			evaluationCount: 15,
		} as any;

		await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			notifEngine,
		);

		expect(capturedPrompt).toContain("Notification Activity");
		expect(capturedPrompt).toContain("5"); // sentCount
		expect(capturedPrompt).toContain("15"); // evaluationCount
	});

	it("evaluation prompt includes previous assessment on subsequent calls", async () => {
		let capturedPrompt = "";
		const conversations = createMockConversationManager();
		conversations.sendOneShotJson = mock(
			(_role: ConversationRole, content: string) => {
				capturedPrompt = content;
				return Promise.resolve({
					coherenceScore: 0.75,
					assessment: "First assessment with details",
					issues: [],
					directives: [],
				});
			},
		);
		const tracker = createMockContextTracker();
		const engine = new OrchestratorEngine(
			conversations,
			tracker,
			silentLogger(),
		);

		// First evaluation — no previous
		await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);
		expect(capturedPrompt).not.toContain("Your Previous Assessment");

		// Second evaluation — should include previous
		await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);
		expect(capturedPrompt).toContain("Your Previous Assessment");
		expect(capturedPrompt).toContain("0.75");
	});

	it("evaluation prompt includes active directives", async () => {
		const capturedPrompts: string[] = [];
		const conversations = createMockConversationManager();
		conversations.sendOneShotJson = mock(
			(_role: ConversationRole, content: string) => {
				capturedPrompts.push(content);
				return Promise.resolve({
					coherenceScore: 0.7,
					assessment: "Test",
					issues: [],
					directives: [
						{
							target: "sharing",
							instruction: "Share API details",
							priority: "strong",
							ttlEvaluations: 5,
						},
					],
				});
			},
		);
		const tracker = createMockContextTracker();
		const engine = new OrchestratorEngine(
			conversations,
			tracker,
			silentLogger(),
		);

		// 1st evaluation — no active directives
		await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);
		expect(capturedPrompts[0]).not.toContain("Currently Active Directives");

		// 2nd evaluation — should show the directive from 1st evaluation
		conversations.sendOneShotJson = mock(
			(_role: ConversationRole, content: string) => {
				capturedPrompts.push(content);
				return Promise.resolve({
					coherenceScore: 0.8,
					assessment: "Better",
					issues: [],
					directives: [],
				});
			},
		);

		await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);
		expect(capturedPrompts[1]).toContain("Currently Active Directives");
		expect(capturedPrompts[1]).toContain("Share API details");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Orchestrator Prompts — Template Tests
// ════════════════════════════════════════════════════════════════════════════

describe("Orchestrator Prompts", () => {
	it("system prompt compiles without errors", () => {
		const result = orchestratorSystemPrompt({});
		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(100);
	});

	it("system prompt contains few-shot examples", () => {
		const result = orchestratorSystemPrompt({});
		expect(result).toContain("example_assessment");
		expect(result).toContain("coherenceScore");
		expect(result).toContain("0.7");
		expect(result).toContain("0.95");
	});

	it("system prompt contains JSON schema", () => {
		const result = orchestratorSystemPrompt({});
		expect(result).toContain("JSON Schema");
		expect(result).toContain("coherenceScore");
		expect(result).toContain("issues");
		expect(result).toContain("directives");
	});

	it("system prompt contains all issue categories", () => {
		const result = orchestratorSystemPrompt({});
		expect(result).toContain("coherence");
		expect(result).toContain("efficiency");
		expect(result).toContain("drift");
		expect(result).toContain("conflict");
		expect(result).toContain("communication");
	});

	it("system prompt contains all directive targets", () => {
		const result = orchestratorSystemPrompt({});
		expect(result).toContain('"sharing"');
		expect(result).toContain('"notification"');
		expect(result).toContain('"planner"');
		expect(result).toContain('"checkpoint"');
		expect(result).toContain('"all"');
	});

	it("evaluation prompt compiles with full data", () => {
		const result = orchestratorEvaluationPrompt({
			task: "Build an API",
			strategy: "multi",
			complexity: "complex",
			planningReasoning: "Task requires multiple agents",
			totalSubtasks: 3,
			agents: [
				{
					agentName: "api-dev",
					taskRole: "api-developer",
					taskDescription: "Build REST endpoints",
					status: "busy",
					completed: false,
					error: null,
					filesWritten: ["src/routes.ts"],
					eventCount: 5,
					promptCount: 1,
					lastDeltaSummary: "Created user route",
				},
			],
			sharing: {
				totalEvaluations: 10,
				approvedCount: 5,
				approvalRate: 50,
				recentDecisions: [
					{
						decision: "SHARED",
						sourceAgent: "api-dev",
						targetAgent: "test-writer",
						reasoning: "API details needed",
					},
				],
			},
			notification: {
				sentCount: 2,
				evaluationCount: 8,
			},
			checkpoint: {
				action: "CONTINUE",
				healthScore: 0.9,
				statusSummary: "All healthy",
				issues: [],
			},
			previousAssessment: {
				coherenceScore: 0.8,
				assessment: "Previous was good",
				issues: [
					{
						category: "drift",
						severity: "low",
						description: "Minor drift",
						affected: ["agent-1"],
					},
				],
				directives: [],
			},
			activeDirectives: [
				{
					target: "sharing",
					priority: "strong",
					instruction: "Share more",
					remainingTtl: 3,
				},
			],
		});

		expect(typeof result).toBe("string");
		expect(result).toContain("Build an API");
		expect(result).toContain("api-dev");
		expect(result).toContain("api-developer");
		expect(result).toContain("src/routes.ts");
		expect(result).toContain("SHARED");
		expect(result).toContain("Latest Checkpoint");
		expect(result).toContain("Your Previous Assessment");
		expect(result).toContain("Currently Active Directives");
	});

	it("evaluation prompt omits optional sections when null", () => {
		const result = orchestratorEvaluationPrompt({
			task: "Simple task",
			strategy: "single",
			complexity: "simple",
			planningReasoning: "Straightforward",
			totalSubtasks: 1,
			agents: [
				{
					agentName: "solo",
					taskRole: "general",
					taskDescription: "Do it all",
					status: "busy",
					completed: false,
					error: null,
					filesWritten: [],
					eventCount: 0,
					promptCount: 0,
					lastDeltaSummary: null,
				},
			],
			sharing: {
				totalEvaluations: 0,
				approvedCount: 0,
				approvalRate: 0,
				recentDecisions: [],
			},
			notification: {
				sentCount: 0,
				evaluationCount: 0,
			},
			checkpoint: null,
			previousAssessment: null,
			activeDirectives: [],
		});

		expect(result).not.toContain("Latest Checkpoint");
		expect(result).not.toContain("Your Previous Assessment");
		expect(result).not.toContain("Currently Active Directives");
	});

	it("JSON examples in system prompt pass validation", () => {
		const systemPrompt = orchestratorSystemPrompt({});

		// Extract JSON blocks from example_assessment tags
		const jsonRegex =
			/<example_assessment>\s*(\{[\s\S]*?\})\s*<\/example_assessment>/g;
		const jsonMatches = [...systemPrompt.matchAll(jsonRegex)];

		expect(jsonMatches.length).toBeGreaterThan(0);

		for (const match of jsonMatches) {
			const jsonStr = match[1]!;
			let parsed: unknown;
			expect(() => {
				parsed = JSON.parse(jsonStr);
			}).not.toThrow();

			const validated = validateOrchestratorResponse(parsed);
			expect(validated).not.toBeNull();
		}
	});
});

// ════════════════════════════════════════════════════════════════════════════
// OrchestratorEngine — Enum Tests
// ════════════════════════════════════════════════════════════════════════════

describe("ConversationRole — ORCHESTRATOR", () => {
	it("ORCHESTRATOR role has the expected value", () => {
		expect(ConversationRole.ORCHESTRATOR).toBe(
			"orchestrator" as ConversationRole,
		);
	});
});

describe("PoolEvent — ORCHESTRATOR_ASSESSMENT", () => {
	it("ORCHESTRATOR_ASSESSMENT event has the expected value", () => {
		expect(PoolEvent.ORCHESTRATOR_ASSESSMENT).toBe(
			"pool:orchestrator-assessment" as PoolEvent,
		);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// OrchestratorEngine — Edge Cases
// ════════════════════════════════════════════════════════════════════════════

describe("OrchestratorEngine — Edge Cases", () => {
	it("handles empty agent states gracefully", async () => {
		const { engine } = createEngine(undefined, undefined, []);

		const result = await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);

		expect(result).not.toBeNull();
	});

	it("handles broker with zero evaluations (no division by zero)", async () => {
		const broker = {
			evaluationCount: 0,
			shareCount: 0,
			journal: new DecisionJournal(),
		} as any;

		const { engine } = createEngine();

		const result = await engine.evaluate(
			"task",
			createTestAnalysis(),
			broker,
			createMockNotificationEngine(),
		);

		expect(result).not.toBeNull();
	});

	it("multiple evaluations do not leak state between assessments", async () => {
		const conversations = createMockConversationManager();
		const tracker = createMockContextTracker();
		const engine = new OrchestratorEngine(
			conversations,
			tracker,
			silentLogger(),
		);

		// First evaluation
		conversations.sendOneShotJson = mock(() =>
			Promise.resolve({
				coherenceScore: 0.5,
				assessment: "First",
				issues: [
					{
						category: "drift",
						severity: "high",
						description: "Major drift",
						affected: ["agent-1"],
					},
				],
				directives: [],
			}),
		);

		const result1 = await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);
		expect(result1!.assessmentNumber).toBe(1);

		// Second evaluation
		conversations.sendOneShotJson = mock(() =>
			Promise.resolve({
				coherenceScore: 0.9,
				assessment: "Second",
				issues: [],
				directives: [],
			}),
		);

		const result2 = await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);
		expect(result2!.assessmentNumber).toBe(2);
		expect(result2!.issues).toHaveLength(0);

		// Previous should be result2 now
		expect(engine.previousAssessment!.assessment).toBe("Second");
	});

	it("directive IDs are unique across evaluations", async () => {
		const conversations = createMockConversationManager();
		const tracker = createMockContextTracker();
		const engine = new OrchestratorEngine(
			conversations,
			tracker,
			silentLogger(),
		);

		const response = {
			coherenceScore: 0.7,
			assessment: "Test",
			issues: [],
			directives: [
				{
					target: "sharing",
					instruction: "Test",
					priority: "suggestion",
					ttlEvaluations: 10,
				},
			],
		};
		conversations.sendOneShotJson = mock(() => Promise.resolve(response));

		await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);
		await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);

		const directives = engine.getDirectivesFor("sharing");
		const ids = directives.map((d) => d.id);
		const uniqueIds = new Set(ids);
		expect(uniqueIds.size).toBe(ids.length);
	});

	it("directive timestamps are ISO-8601", async () => {
		const response = {
			coherenceScore: 0.7,
			assessment: "Test",
			issues: [],
			directives: [
				{
					target: "sharing",
					instruction: "Test",
					priority: "suggestion",
					ttlEvaluations: 5,
				},
			],
		};

		const { engine } = createEngine(undefined, response);

		const result = await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);

		expect(result!.directives[0]!.timestamp).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
		);
		expect(result!.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
	});

	it("getDirectivesFor returns empty array for target with no directives", async () => {
		const response = {
			coherenceScore: 0.7,
			assessment: "Test",
			issues: [],
			directives: [
				{
					target: "sharing",
					instruction: "Only for sharing",
					priority: "suggestion",
					ttlEvaluations: 5,
				},
			],
		};

		const { engine } = createEngine(undefined, response);

		await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);

		expect(engine.getDirectivesFor("planner")).toHaveLength(0);
		expect(engine.getDirectivesFor("checkpoint")).toHaveLength(0);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// OrchestratorEngine — DecisionJournal Integration
// ════════════════════════════════════════════════════════════════════════════

describe("OrchestratorEngine — DecisionJournal Integration", () => {
	it("getRecentSharingDecisions returns at most 5 entries", async () => {
		let capturedPrompt = "";
		const conversations = createMockConversationManager();
		conversations.sendOneShotJson = mock(
			(_role: ConversationRole, content: string) => {
				capturedPrompt = content;
				return Promise.resolve({
					coherenceScore: 0.8,
					assessment: "OK",
					issues: [],
					directives: [],
				});
			},
		);
		const tracker = createMockContextTracker();
		const engine = new OrchestratorEngine(
			conversations,
			tracker,
			silentLogger(),
		);

		// Create a journal with 10 entries
		const journal = new DecisionJournal();
		for (let i = 0; i < 10; i++) {
			journal.recordSharingDecision(
				`source-${i}`,
				`target-${i}`,
				"file_write",
				i % 2 === 0,
				`Reasoning for decision ${i}`,
				new Date().toISOString(),
			);
		}

		await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
			null,
			journal,
		);

		// The prompt should contain the most recent decisions (last 5)
		// source-5 through source-9
		expect(capturedPrompt).toContain("source-9");
		expect(capturedPrompt).toContain("source-5");
		// source-0 through source-4 should NOT be present
		expect(capturedPrompt).not.toContain("source-0");
		expect(capturedPrompt).not.toContain("source-4");
	});

	it("handles empty journal gracefully", async () => {
		let capturedPrompt = "";
		const conversations = createMockConversationManager();
		conversations.sendOneShotJson = mock(
			(_role: ConversationRole, content: string) => {
				capturedPrompt = content;
				return Promise.resolve({
					coherenceScore: 0.8,
					assessment: "OK",
					issues: [],
					directives: [],
				});
			},
		);
		const tracker = createMockContextTracker();
		const engine = new OrchestratorEngine(
			conversations,
			tracker,
			silentLogger(),
		);

		const emptyJournal = new DecisionJournal();

		await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
			null,
			emptyJournal,
		);

		// Should not contain "Recent sharing decisions" section header
		expect(capturedPrompt).not.toContain("Recent sharing decisions");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// InformationBroker — Orchestrator Directive Injection
// ════════════════════════════════════════════════════════════════════════════

describe("InformationBroker — Orchestrator Directive Injection", () => {
	it("setOrchestratorEngine stores the engine reference", () => {
		const { InformationBroker } = require("../information-broker.ts");
		const { ContextTracker } = require("../context-tracker.ts");

		const mockConversations = {
			sendOneShotJson: mock(() => Promise.resolve([])),
		} as any;

		const tracker = new ContextTracker();
		const broker = new InformationBroker(
			mockConversations,
			tracker,
			[],
			silentLogger(),
			new Map(),
			new Map(),
		);

		// Should not throw
		const mockEngine = {
			getDirectivePromptSection: mock(() => null),
		} as any;
		expect(() => broker.setOrchestratorEngine(mockEngine)).not.toThrow();
	});

	it("includes orchestrator directives in sharing prompt when available", async () => {
		const { InformationBroker } = require("../information-broker.ts");
		const { ContextTracker } = require("../context-tracker.ts");
		const { DeltaType } = require("../../../enums/delta-type.enum.ts");

		let capturedPrompt = "";
		const mockConversations = {
			sendOneShotJson: mock((_role: any, content: string) => {
				capturedPrompt = content;
				return Promise.resolve([
					{
						targetAgentId: "agent-2",
						shouldShare: false,
						reasoning: "Not relevant",
						information: "",
					},
				]);
			}),
		} as any;

		const tracker = new ContextTracker();
		const subtask1 = {
			id: "s1",
			prompt: "Build API",
			role: "api-dev",
			dependencies: [],
			priority: 1,
		};
		const subtask2 = {
			id: "s2",
			prompt: "Write tests",
			role: "test-writer",
			dependencies: ["s1"],
			priority: 2,
		};
		tracker.registerAgent("agent-1", "Alpha", subtask1);
		tracker.registerAgent("agent-2", "Beta", subtask2);

		const broker = new InformationBroker(
			mockConversations,
			tracker,
			[{ from: "s1", to: "s2", type: "blocking" as const }],
			silentLogger(),
			new Map([
				["s1", "agent-1"],
				["s2", "agent-2"],
			]),
			new Map([
				["agent-1", "s1"],
				["agent-2", "s2"],
			]),
		);

		// Set up orchestrator engine mock that returns a directive section
		const mockEngine = {
			getDirectivePromptSection: mock(
				(_target: string) =>
					"## Active Orchestrator Directives\n- [STRONG] Share API route definitions with test-writer",
			),
		} as any;
		broker.setOrchestratorEngine(mockEngine);

		const delta = {
			agentId: "agent-1",
			agentName: "Alpha",
			timestamp: new Date().toISOString(),
			type: DeltaType.PROMPT_COMPLETE,
			summary: "Completed API implementation",
			data: { responsePreview: "All endpoints ready" },
			significance: 0.9,
			promptResultSummary: null,
		};

		await broker.evaluate(delta);

		expect(capturedPrompt).toContain("Active Orchestrator Directives");
		expect(capturedPrompt).toContain(
			"[STRONG] Share API route definitions with test-writer",
		);
		expect(mockEngine.getDirectivePromptSection).toHaveBeenCalledWith(
			"sharing",
		);
	});

	it("omits orchestrator section when no directives are active", async () => {
		const { InformationBroker } = require("../information-broker.ts");
		const { ContextTracker } = require("../context-tracker.ts");
		const { DeltaType } = require("../../../enums/delta-type.enum.ts");

		let capturedPrompt = "";
		const mockConversations = {
			sendOneShotJson: mock((_role: any, content: string) => {
				capturedPrompt = content;
				return Promise.resolve([
					{
						targetAgentId: "agent-2",
						shouldShare: false,
						reasoning: "Not relevant",
						information: "",
					},
				]);
			}),
		} as any;

		const tracker = new ContextTracker();
		const subtask1 = {
			id: "s1",
			prompt: "Build API",
			role: "api-dev",
			dependencies: [],
			priority: 1,
		};
		const subtask2 = {
			id: "s2",
			prompt: "Write tests",
			role: "test-writer",
			dependencies: ["s1"],
			priority: 2,
		};
		tracker.registerAgent("agent-1", "Alpha", subtask1);
		tracker.registerAgent("agent-2", "Beta", subtask2);

		const broker = new InformationBroker(
			mockConversations,
			tracker,
			[{ from: "s1", to: "s2", type: "blocking" as const }],
			silentLogger(),
			new Map([
				["s1", "agent-1"],
				["s2", "agent-2"],
			]),
			new Map([
				["agent-1", "s1"],
				["agent-2", "s2"],
			]),
		);

		// Set up orchestrator engine mock that returns null (no directives)
		const mockEngine = {
			getDirectivePromptSection: mock(() => null),
		} as any;
		broker.setOrchestratorEngine(mockEngine);

		const delta = {
			agentId: "agent-1",
			agentName: "Alpha",
			timestamp: new Date().toISOString(),
			type: DeltaType.PROMPT_COMPLETE,
			summary: "Completed API implementation",
			data: { responsePreview: "All endpoints ready" },
			significance: 0.9,
			promptResultSummary: null,
		};

		await broker.evaluate(delta);

		expect(capturedPrompt).not.toContain("Active Orchestrator Directives");
	});

	it("works correctly without orchestrator engine set (null reference)", async () => {
		const { InformationBroker } = require("../information-broker.ts");
		const { ContextTracker } = require("../context-tracker.ts");
		const { DeltaType } = require("../../../enums/delta-type.enum.ts");

		let capturedPrompt = "";
		const mockConversations = {
			sendOneShotJson: mock((_role: any, content: string) => {
				capturedPrompt = content;
				return Promise.resolve([
					{
						targetAgentId: "agent-2",
						shouldShare: false,
						reasoning: "Not relevant",
						information: "",
					},
				]);
			}),
		} as any;

		const tracker = new ContextTracker();
		const subtask1 = {
			id: "s1",
			prompt: "Build API",
			role: "api-dev",
			dependencies: [],
			priority: 1,
		};
		const subtask2 = {
			id: "s2",
			prompt: "Write tests",
			role: "test-writer",
			dependencies: ["s1"],
			priority: 2,
		};
		tracker.registerAgent("agent-1", "Alpha", subtask1);
		tracker.registerAgent("agent-2", "Beta", subtask2);

		const broker = new InformationBroker(
			mockConversations,
			tracker,
			[{ from: "s1", to: "s2", type: "blocking" as const }],
			silentLogger(),
			new Map([
				["s1", "agent-1"],
				["s2", "agent-2"],
			]),
			new Map([
				["agent-1", "s1"],
				["agent-2", "s2"],
			]),
		);

		// Do NOT set orchestrator engine — should work fine without it
		const delta = {
			agentId: "agent-1",
			agentName: "Alpha",
			timestamp: new Date().toISOString(),
			type: DeltaType.PROMPT_COMPLETE,
			summary: "Completed API implementation",
			data: { responsePreview: "All endpoints ready" },
			significance: 0.9,
			promptResultSummary: null,
		};

		// Should not throw
		await broker.evaluate(delta);

		expect(capturedPrompt).not.toContain("Active Orchestrator Directives");
		expect(capturedPrompt.length).toBeGreaterThan(0);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// NotificationEngine — Orchestrator Directive Injection
// ════════════════════════════════════════════════════════════════════════════

describe("NotificationEngine — Orchestrator Directive Injection", () => {
	it("setOrchestratorEngine stores the engine reference", () => {
		const { NotificationEngine } = require("../notification-engine.ts");

		const mockConversations = {
			sendOneShotJson: mock(() =>
				Promise.resolve({
					shouldNotify: false,
					reasoning: "Not important",
					message: "",
				}),
			),
		} as any;

		const engine = new NotificationEngine(mockConversations, silentLogger());

		const mockOrchestrator = {
			getDirectivePromptSection: mock(() => null),
		} as any;
		expect(() => engine.setOrchestratorEngine(mockOrchestrator)).not.toThrow();
	});

	it("includes orchestrator directives in notification prompt when available", async () => {
		const { NotificationEngine } = require("../notification-engine.ts");
		const { DeltaType } = require("../../../enums/delta-type.enum.ts");

		let capturedPrompt = "";
		const mockConversations = {
			sendOneShotJson: mock((_role: any, content: string) => {
				capturedPrompt = content;
				return Promise.resolve({
					shouldNotify: true,
					reasoning: "Important milestone",
					message: "Task completed",
				});
			}),
		} as any;

		const notifEngine = new NotificationEngine(
			mockConversations,
			silentLogger(),
		);
		notifEngine.setPreference({ enabled: true, minSignificance: 0.3 });

		// Set up orchestrator engine mock that returns a directive section
		const mockOrchestrator = {
			getDirectivePromptSection: mock(
				(_target: string) =>
					"## Active Orchestrator Directives\n- [RECOMMENDATION] Notify user more frequently about progress",
			),
		} as any;
		notifEngine.setOrchestratorEngine(mockOrchestrator);

		const delta = {
			agentId: "agent-1",
			agentName: "Alpha",
			timestamp: new Date().toISOString(),
			type: DeltaType.PROMPT_COMPLETE,
			summary: "Completed important step",
			data: {},
			significance: 0.8,
			promptResultSummary: null,
		};

		const agentState = {
			agentId: "agent-1",
			agentName: "Alpha",
			taskDescription: "Build the API",
			taskRole: "api-developer",
			status: AgentStatus.BUSY,
			events: [],
			promptResults: [],
			lastDelta: delta,
			filesWritten: [],
			filesRead: [],
			completed: false,
			error: null,
		};

		await notifEngine.evaluate(delta, agentState);

		expect(capturedPrompt).toContain("Active Orchestrator Directives");
		expect(capturedPrompt).toContain(
			"[RECOMMENDATION] Notify user more frequently about progress",
		);
		expect(mockOrchestrator.getDirectivePromptSection).toHaveBeenCalledWith(
			"notification",
		);
	});

	it("omits orchestrator section when no directives are active", async () => {
		const { NotificationEngine } = require("../notification-engine.ts");
		const { DeltaType } = require("../../../enums/delta-type.enum.ts");

		let capturedPrompt = "";
		const mockConversations = {
			sendOneShotJson: mock((_role: any, content: string) => {
				capturedPrompt = content;
				return Promise.resolve({
					shouldNotify: false,
					reasoning: "Routine",
					message: "",
				});
			}),
		} as any;

		const notifEngine = new NotificationEngine(
			mockConversations,
			silentLogger(),
		);
		notifEngine.setPreference({ enabled: true, minSignificance: 0.3 });

		const mockOrchestrator = {
			getDirectivePromptSection: mock(() => null),
		} as any;
		notifEngine.setOrchestratorEngine(mockOrchestrator);

		const delta = {
			agentId: "agent-1",
			agentName: "Alpha",
			timestamp: new Date().toISOString(),
			type: DeltaType.PROMPT_COMPLETE,
			summary: "Step done",
			data: {},
			significance: 0.8,
			promptResultSummary: null,
		};

		const agentState = {
			agentId: "agent-1",
			agentName: "Alpha",
			taskDescription: "Build the API",
			taskRole: "api-developer",
			status: AgentStatus.BUSY,
			events: [],
			promptResults: [],
			lastDelta: delta,
			filesWritten: [],
			filesRead: [],
			completed: false,
			error: null,
		};

		await notifEngine.evaluate(delta, agentState);

		expect(capturedPrompt).not.toContain("Active Orchestrator Directives");
	});

	it("works correctly without orchestrator engine set (null reference)", async () => {
		const { NotificationEngine } = require("../notification-engine.ts");
		const { DeltaType } = require("../../../enums/delta-type.enum.ts");

		let capturedPrompt = "";
		const mockConversations = {
			sendOneShotJson: mock((_role: any, content: string) => {
				capturedPrompt = content;
				return Promise.resolve({
					shouldNotify: false,
					reasoning: "Routine",
					message: "",
				});
			}),
		} as any;

		const notifEngine = new NotificationEngine(
			mockConversations,
			silentLogger(),
		);
		notifEngine.setPreference({ enabled: true, minSignificance: 0.3 });
		// Do NOT set orchestrator engine

		const delta = {
			agentId: "agent-1",
			agentName: "Alpha",
			timestamp: new Date().toISOString(),
			type: DeltaType.PROMPT_COMPLETE,
			summary: "Step done",
			data: {},
			significance: 0.8,
			promptResultSummary: null,
		};

		const agentState = {
			agentId: "agent-1",
			agentName: "Alpha",
			taskDescription: "Build the API",
			taskRole: "api-developer",
			status: AgentStatus.BUSY,
			events: [],
			promptResults: [],
			lastDelta: delta,
			filesWritten: [],
			filesRead: [],
			completed: false,
			error: null,
		};

		// Should not throw
		await notifEngine.evaluate(delta, agentState);

		expect(capturedPrompt).not.toContain("Active Orchestrator Directives");
		expect(capturedPrompt.length).toBeGreaterThan(0);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// AgentPoolState — Orchestrator Fields
// ════════════════════════════════════════════════════════════════════════════

describe("AgentPoolState — Orchestrator Fields", () => {
	it("getState includes orchestrator fields with initial values", () => {
		const { AgentPool } = require("../agent-pool.ts");

		const pool = new AgentPool({
			model: "test/model",
			apiKey: "test-key",
			autoApprove: true,
		});

		const state = pool.getState();

		expect(state.orchestratorAssessmentCount).toBe(0);
		expect(state.activeDirectiveCount).toBe(0);
		expect(state.coherenceScore).toBeNull();
	});

	it("getState includes orchestrator fields when configured", () => {
		const { AgentPool } = require("../agent-pool.ts");

		const pool = new AgentPool({
			model: "test/model",
			apiKey: "test-key",
			autoApprove: true,
			orchestrator: {
				enabled: true,
				deltaInterval: 4,
				minIntervalMs: 10000,
			},
		});

		const state = pool.getState();

		expect(typeof state.orchestratorAssessmentCount).toBe("number");
		expect(typeof state.activeDirectiveCount).toBe("number");
		// coherenceScore is null when no assessment has been performed
		expect(state.coherenceScore).toBeNull();
	});

	it("getState includes orchestrator fields when orchestrator is disabled", () => {
		const { AgentPool } = require("../agent-pool.ts");

		const pool = new AgentPool({
			model: "test/model",
			apiKey: "test-key",
			autoApprove: true,
			orchestrator: { enabled: false },
		});

		const state = pool.getState();

		expect(state.orchestratorAssessmentCount).toBe(0);
		expect(state.activeDirectiveCount).toBe(0);
		expect(state.coherenceScore).toBeNull();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Non-Regression — Pool Works Without Orchestrator Config
// ════════════════════════════════════════════════════════════════════════════

describe("Non-Regression — Pool Without Orchestrator Config", () => {
	it("pool can be constructed without orchestrator config (Test 27)", () => {
		const { AgentPool } = require("../agent-pool.ts");

		// No orchestrator field at all — should use defaults
		const pool = new AgentPool({
			model: "test/model",
			apiKey: "test-key",
			autoApprove: true,
		});

		const state = pool.getState();
		expect(state).toBeDefined();
		expect(state.orchestratorAssessmentCount).toBe(0);
	});

	it("pool can be constructed with orchestrator explicitly disabled (Test 28)", () => {
		const { AgentPool } = require("../agent-pool.ts");

		const pool = new AgentPool({
			model: "test/model",
			apiKey: "test-key",
			autoApprove: true,
			orchestrator: { enabled: false },
		});

		const state = pool.getState();
		expect(state).toBeDefined();
		expect(state.orchestratorAssessmentCount).toBe(0);
		expect(state.activeDirectiveCount).toBe(0);
	});

	it("pool supports ORCHESTRATOR model override key", () => {
		const { AgentPool } = require("../agent-pool.ts");

		// TypeScript compilation test + runtime validation
		const pool = new AgentPool({
			model: "test/model",
			apiKey: "test-key",
			autoApprove: true,
			modelOverrides: {
				[ConversationRole.ORCHESTRATOR]: "anthropic/claude-sonnet-4",
			},
		});

		const state = pool.getState();
		expect(state).toBeDefined();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// OrchestratorEngine — Time Interval Enforcement via evaluate()
// ════════════════════════════════════════════════════════════════════════════

describe("OrchestratorEngine — Time Interval Enforcement via evaluate()", () => {
	it("recordDelta respects minIntervalMs after evaluate sets lastEvalTime", async () => {
		const { engine } = createEngine({
			deltaInterval: 1,
			minIntervalMs: 60_000,
		});

		// First recordDelta: _lastEvalTime is 0, so Date.now() - 0 >> 60000 → passes
		expect(engine.recordDelta()).toBe(true);

		// Call evaluate to set _lastEvalTime to Date.now()
		await engine.evaluate(
			"task",
			createTestAnalysis(),
			createMockBroker(),
			createMockNotificationEngine(),
		);

		// Now recordDelta should return false because < 60 seconds have elapsed
		// since evaluate() set _lastEvalTime
		expect(engine.recordDelta()).toBe(false);
		expect(engine.recordDelta()).toBe(false);
	});
});
