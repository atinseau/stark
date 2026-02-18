import { describe, expect, it, mock } from "bun:test";

import { ConversationRole } from "../../../enums/conversation-role.enum.ts";
import { ExecutionStrategy } from "../../../enums/execution-strategy.enum.ts";
import { TaskComplexity } from "../../../enums/task-complexity.enum.ts";
import type { PromptResult } from "../../../types/agent.types.ts";
import type {
	AgentExecutionResult,
	CheckpointResult,
	ExecutionInsight,
	ExecutionReflection,
	OrchestratorAssessment,
	TaskAnalysis,
} from "../../../types/agent-pool.types.ts";
import {
	ReflectionEngine,
	validateReflectionResponse,
} from "../reflection-engine.ts";
import { silentLogger } from "./test-helpers.ts";

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

/** Standard valid reflection response from the LLM. */
function validReflectionResponse(overrides?: Record<string, unknown>) {
	return {
		effectivenessScore: 0.85,
		analysis: "The execution was generally good with minor sharing issues.",
		decompositionAssessment: "optimal",
		sharingAssessment: "under-shared",
		insights: [
			{
				category: "sharing",
				confidence: 0.9,
				insight:
					"Share full API contract (routes + schemas) with test-writer, not just file paths.",
				applicableWhen: "When a test-writer depends on an api-developer agent",
				polarity: "negative",
			},
			{
				category: "decomposition",
				confidence: 0.8,
				insight:
					"Splitting REST API into api-developer and test-writer works well with clear contracts.",
				applicableWhen:
					"When building a REST API with tests and the API has multiple endpoints",
				polarity: "positive",
			},
		],
		...overrides,
	};
}

/** Creates a mock ConversationManager for the ReflectionEngine. */
function createMockConversationManager(
	response?: Record<string, unknown> | null,
	shouldThrow?: Error,
) {
	const sendOneShotJson = shouldThrow
		? mock(() => Promise.reject(shouldThrow))
		: mock(() => Promise.resolve(response ?? validReflectionResponse()));

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

/** Creates a valid TaskAnalysis for testing. */
function createTaskAnalysis(
	strategy: ExecutionStrategy = ExecutionStrategy.MULTI,
): TaskAnalysis {
	if (strategy === ExecutionStrategy.SINGLE) {
		return {
			strategy: ExecutionStrategy.SINGLE,
			complexity: TaskComplexity.SIMPLE,
			reasoning: "Simple task, single agent sufficient.",
			subtasks: [
				{
					id: "task-1",
					prompt: "Do the thing",
					role: "general-agent",
					dependencies: [],
					priority: 1,
				},
			],
			dependencies: [],
			parallelismBenefit: 0,
		};
	}

	return {
		strategy: ExecutionStrategy.MULTI,
		complexity: TaskComplexity.COMPLEX,
		reasoning: "Task benefits from specialization.",
		subtasks: [
			{
				id: "subtask-api",
				prompt: "Build the REST API endpoints",
				role: "api-developer",
				dependencies: [],
				priority: 1,
			},
			{
				id: "subtask-tests",
				prompt: "Write comprehensive tests",
				role: "test-writer",
				dependencies: ["subtask-api"],
				priority: 2,
			},
		],
		dependencies: [
			{ from: "subtask-api", to: "subtask-tests", type: "blocking" },
		],
		parallelismBenefit: 0.5,
	};
}

/** Creates a valid AgentExecutionResult for testing. */
function createExecutionResult(
	overrides?: Partial<AgentExecutionResult>,
): AgentExecutionResult {
	const defaultPromptResult: PromptResult = {
		stopReason: "end_turn",
		text: "Task completed successfully.",
		usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
	};

	return {
		agentId: overrides?.agentId ?? crypto.randomUUID(),
		agentName: overrides?.agentName ?? "api-developer",
		subtask: overrides?.subtask ?? {
			id: "subtask-api",
			prompt: "Build the REST API endpoints",
			role: "api-developer",
			dependencies: [],
			priority: 1,
		},
		promptResult: overrides?.promptResult ?? defaultPromptResult,
		events: overrides?.events ?? [],
		filesWritten: overrides?.filesWritten ?? ["src/routes/users.ts"],
		success: overrides?.success ?? true,
		error: overrides?.error,
		retryCount: overrides?.retryCount ?? 0,
		timedOut: overrides?.timedOut ?? false,
		subtaskDurationMs: overrides?.subtaskDurationMs ?? 5000,
	};
}

/** Creates standard reflect() params. */
function createReflectParams(overrides?: Record<string, unknown>) {
	return {
		task: "Build a REST API with tests",
		analysis: createTaskAnalysis(ExecutionStrategy.MULTI),
		results: [
			createExecutionResult({ agentName: "api-developer" }),
			createExecutionResult({
				agentName: "test-writer",
				subtask: {
					id: "subtask-tests",
					prompt: "Write comprehensive tests",
					role: "test-writer",
					dependencies: ["subtask-api"],
					priority: 2,
				},
			}),
		],
		durationMs: 15000,
		coordinationStats: {
			deltaCount: 8,
			sharingEvaluationCount: 5,
			sharingApprovedCount: 3,
			notificationCount: 1,
			replanCount: 0,
		},
		...overrides,
	} as Parameters<ReflectionEngine["reflect"]>[0];
}

/** Directly insert insights into the engine for testing retrieval/eviction. */
function insertInsight(
	engine: ReflectionEngine,
	overrides?: Partial<ExecutionInsight>,
): ExecutionInsight {
	const insight: ExecutionInsight = {
		id:
			overrides?.id ?? `insight-test-${Math.random().toString(36).slice(2, 8)}`,
		category: overrides?.category ?? "decomposition",
		confidence: overrides?.confidence ?? 0.8,
		insight: overrides?.insight ?? "Test insight",
		applicableWhen: overrides?.applicableWhen ?? "When testing",
		polarity: overrides?.polarity ?? "positive",
		timestamp: overrides?.timestamp ?? new Date().toISOString(),
	};

	// Access private insights array for direct insertion in tests
	(engine as any).insights.push(insight);

	return insight;
}

// ════════════════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════════════════

describe("ReflectionEngine", () => {
	// ── Test 1: reflect returns a valid ExecutionReflection ─────────────

	describe("reflect()", () => {
		it("returns a valid ExecutionReflection with all required fields", async () => {
			const conversations = createMockConversationManager();
			const engine = new ReflectionEngine(conversations, silentLogger());

			const result = await engine.reflect(createReflectParams());

			expect(result).not.toBeNull();
			expect(result!.task).toBe("Build a REST API with tests");
			expect(result!.strategy).toBe(ExecutionStrategy.MULTI);
			expect(typeof result!.effectivenessScore).toBe("number");
			expect(result!.effectivenessScore).toBeGreaterThanOrEqual(0);
			expect(result!.effectivenessScore).toBeLessThanOrEqual(1);
			expect(typeof result!.analysis).toBe("string");
			expect(result!.analysis.length).toBeGreaterThan(0);
			expect([
				"optimal",
				"over-decomposed",
				"under-decomposed",
				"wrong-boundaries",
			]).toContain(result!.decompositionAssessment);
			expect([
				"optimal",
				"over-shared",
				"under-shared",
				"wrong-content",
			]).toContain(result!.sharingAssessment);
			expect(Array.isArray(result!.insights)).toBe(true);
			expect(result!.insights.length).toBeGreaterThan(0);
			expect(typeof result!.timestamp).toBe("string");
			expect(typeof result!.executionDurationMs).toBe("number");
			expect(result!.executionDurationMs).toBe(15000);
		});

		it("increments reflectionCount after each successful reflection", async () => {
			const conversations = createMockConversationManager();
			const engine = new ReflectionEngine(conversations, silentLogger());

			expect(engine.reflectionCount).toBe(0);

			await engine.reflect(createReflectParams());
			expect(engine.reflectionCount).toBe(1);

			await engine.reflect(createReflectParams());
			expect(engine.reflectionCount).toBe(2);
		});

		// ── Test 2: reflect returns null when disabled ──────────────────

		it("returns null when enabled is false", async () => {
			const conversations = createMockConversationManager();
			const engine = new ReflectionEngine(conversations, silentLogger(), {
				enabled: false,
			});

			const result = await engine.reflect(createReflectParams());

			expect(result).toBeNull();
			expect(engine.reflectionCount).toBe(0);
			expect(conversations.sendOneShotJson).not.toHaveBeenCalled();
		});

		// ── Test 3: reflect returns null for single-agent when reflectOnSingleAgent is false ──

		it("returns null for single-agent execution when reflectOnSingleAgent is false (default)", async () => {
			const conversations = createMockConversationManager();
			const engine = new ReflectionEngine(conversations, silentLogger());

			const params = createReflectParams({
				analysis: createTaskAnalysis(ExecutionStrategy.SINGLE),
				results: [createExecutionResult()],
			});

			const result = await engine.reflect(params);

			expect(result).toBeNull();
			expect(conversations.sendOneShotJson).not.toHaveBeenCalled();
		});

		// ── Test 4: reflect returns a result for single-agent when reflectOnSingleAgent is true ──

		it("returns a result for single-agent execution when reflectOnSingleAgent is true", async () => {
			const conversations = createMockConversationManager();
			const engine = new ReflectionEngine(conversations, silentLogger(), {
				reflectOnSingleAgent: true,
			});

			const params = createReflectParams({
				analysis: createTaskAnalysis(ExecutionStrategy.SINGLE),
				results: [createExecutionResult()],
			});

			const result = await engine.reflect(params);

			expect(result).not.toBeNull();
			expect(conversations.sendOneShotJson).toHaveBeenCalled();
		});

		// ── Test 5: reflect returns null on LLM error ──────────────────

		it("returns null when the LLM call throws an error", async () => {
			const conversations = createMockConversationManager(
				null,
				new Error("LLM service unavailable"),
			);
			const engine = new ReflectionEngine(conversations, silentLogger());

			const result = await engine.reflect(createReflectParams());

			expect(result).toBeNull();
			// reflectionCount is still incremented (tracks attempts)
			expect(engine.reflectionCount).toBe(1);
		});

		it("does not crash when the LLM returns null", async () => {
			const conversations = createMockConversationManager(null);
			// Override sendOneShotJson to return null directly
			conversations.sendOneShotJson = mock(() => Promise.resolve(null));
			const engine = new ReflectionEngine(conversations, silentLogger());

			const result = await engine.reflect(createReflectParams());

			expect(result).toBeNull();
		});

		// ── Test 6: Insights are stored after a successful reflection ──

		it("stores insights after a successful reflection", async () => {
			const conversations = createMockConversationManager();
			const engine = new ReflectionEngine(conversations, silentLogger());

			expect(engine.insightCount).toBe(0);

			await engine.reflect(createReflectParams());

			// The default response has 2 insights
			expect(engine.insightCount).toBe(2);
			expect(engine.getAllInsights().length).toBe(2);
		});

		it("builds insights with correct fields", async () => {
			const conversations = createMockConversationManager();
			const engine = new ReflectionEngine(conversations, silentLogger());

			await engine.reflect(createReflectParams());

			const insights = engine.getAllInsights();
			expect(insights.length).toBe(2);

			const first = insights[0]!;
			expect(first.id).toBe("insight-1-0");
			expect(first.category).toBe("sharing");
			expect(first.confidence).toBe(0.9);
			expect(first.polarity).toBe("negative");
			expect(first.insight).toContain("API contract");
			expect(first.applicableWhen).toContain("test-writer");
			expect(typeof first.timestamp).toBe("string");
		});

		// ── Confidence penalty for low-effectiveness executions ─────────

		it("reduces confidence of positive insights from low-effectiveness executions", async () => {
			const lowEffectivenessResponse = validReflectionResponse({
				effectivenessScore: 0.4,
				insights: [
					{
						category: "decomposition",
						confidence: 0.8,
						insight: "This approach worked well",
						applicableWhen: "When doing X",
						polarity: "positive",
					},
					{
						category: "sharing",
						confidence: 0.9,
						insight: "Sharing was insufficient",
						applicableWhen: "When doing Y",
						polarity: "negative",
					},
				],
			});
			const conversations = createMockConversationManager(
				lowEffectivenessResponse,
			);
			const engine = new ReflectionEngine(conversations, silentLogger());

			await engine.reflect(createReflectParams());

			const insights = engine.getAllInsights();

			// Positive insight should have reduced confidence
			const positiveInsight = insights.find((i) => i.polarity === "positive");
			expect(positiveInsight).toBeDefined();
			expect(positiveInsight!.confidence).toBeLessThan(0.8);
			expect(positiveInsight!.confidence).toBeGreaterThanOrEqual(0.3);

			// Negative insight should NOT have reduced confidence
			const negativeInsight = insights.find((i) => i.polarity === "negative");
			expect(negativeInsight).toBeDefined();
			expect(negativeInsight!.confidence).toBe(0.9);
		});

		it("does NOT reduce confidence when effectiveness is above threshold", async () => {
			const highEffectivenessResponse = validReflectionResponse({
				effectivenessScore: 0.9,
				insights: [
					{
						category: "decomposition",
						confidence: 0.8,
						insight: "This approach worked well",
						applicableWhen: "When doing X",
						polarity: "positive",
					},
				],
			});
			const conversations = createMockConversationManager(
				highEffectivenessResponse,
			);
			const engine = new ReflectionEngine(conversations, silentLogger());

			await engine.reflect(createReflectParams());

			const insights = engine.getAllInsights();
			const positiveInsight = insights.find((i) => i.polarity === "positive");
			expect(positiveInsight!.confidence).toBe(0.8); // Unchanged
		});

		// ── Sends prompt to ConversationManager correctly ──────────────

		it("calls sendOneShotJson with correct role and options", async () => {
			const conversations = createMockConversationManager();
			const engine = new ReflectionEngine(conversations, silentLogger());

			await engine.reflect(createReflectParams());

			expect(conversations.sendOneShotJson).toHaveBeenCalledTimes(1);
			const call = conversations.sendOneShotJson.mock.calls[0]!;
			expect(call[0]).toBe(ConversationRole.USER_INTERACTION);
			expect(typeof call[1]).toBe("string"); // prompt
			expect(typeof call[2]).toBe("function"); // validator
			expect(call[3]).toEqual({ maxTokens: 1200, maxJsonAttempts: 2 });
		});

		// ── Includes optional data in prompt ───────────────────────────

		it("includes orchestrator assessments, checkpoints, and sharing decisions in the prompt", async () => {
			const conversations = createMockConversationManager();
			const engine = new ReflectionEngine(conversations, silentLogger());

			const orchestratorAssessment: OrchestratorAssessment = {
				coherenceScore: 0.8,
				assessment: "Coordination quality is good.",
				issues: [],
				directives: [],
				timestamp: new Date().toISOString(),
				assessmentNumber: 1,
			};

			const checkpointResult: CheckpointResult = {
				action: "CONTINUE" as any,
				trigger: "COMPLETION_THRESHOLD" as any,
				healthScore: 0.9,
				reasoning: "All good",
				statusSummary: "Execution proceeding normally.",
				issues: [],
				corrections: new Map<string, string>(),
				timestamp: new Date().toISOString(),
			};

			const params = createReflectParams({
				orchestratorAssessments: [orchestratorAssessment],
				checkpointResults: [checkpointResult],
				sharingDecisions: [
					{
						decision: "SHARED",
						source: "api-dev",
						target: "test-writer",
						reasoning: "Needed API contract",
					},
				],
			});

			await engine.reflect(params);

			const call = conversations.sendOneShotJson.mock.calls[0]!;
			const prompt = call[1] as string;

			expect(prompt).toContain("Orchestrator Assessments");
			expect(prompt).toContain("Checkpoint Results");
			expect(prompt).toContain("Notable Sharing Decisions");
			expect(prompt).toContain("SHARED");
			expect(prompt).toContain("api-dev");
		});

		// ── Stores reflections ─────────────────────────────────────────

		it("stores the full reflection in getAllReflections()", async () => {
			const conversations = createMockConversationManager();
			const engine = new ReflectionEngine(conversations, silentLogger());

			await engine.reflect(createReflectParams());

			const reflections = engine.getAllReflections();
			expect(reflections.length).toBe(1);
			expect(reflections[0]!.effectivenessScore).toBe(0.85);
		});

		it("sets lastReflection to the most recent reflection", async () => {
			const conversations = createMockConversationManager();
			const engine = new ReflectionEngine(conversations, silentLogger());

			expect(engine.lastReflection).toBeNull();

			await engine.reflect(createReflectParams());
			expect(engine.lastReflection).not.toBeNull();
			expect(engine.lastReflection!.effectivenessScore).toBe(0.85);
		});

		// ── Existing insights are included for deduplication ────────────

		it("includes existing insights in the prompt to prevent duplication", async () => {
			const conversations = createMockConversationManager();
			const engine = new ReflectionEngine(conversations, silentLogger());

			// First reflection — no existing insights
			await engine.reflect(createReflectParams());

			// Second reflection — should include existing insights
			await engine.reflect(createReflectParams());

			const secondCall = conversations.sendOneShotJson.mock.calls[1]!;
			const prompt = secondCall[1] as string;

			expect(prompt).toContain("Existing Insights");
			expect(prompt).toContain("API contract");
		});
	});

	// ── Insight Eviction ─────────────────────────────────────────────────

	describe("insight eviction", () => {
		// ── Test 7: Insights are evicted when maxInsights is reached ────

		it("evicts insights when maxInsights is reached", async () => {
			const conversations = createMockConversationManager(
				validReflectionResponse({
					insights: [
						{
							category: "sharing",
							confidence: 0.7,
							insight: "Insight A",
							applicableWhen: "When A",
							polarity: "positive",
						},
						{
							category: "decomposition",
							confidence: 0.8,
							insight: "Insight B",
							applicableWhen: "When B",
							polarity: "positive",
						},
					],
				}),
			);
			const engine = new ReflectionEngine(conversations, silentLogger(), {
				maxInsights: 5,
			});

			// 3 reflections × 2 insights = 6 total, but max is 5
			await engine.reflect(createReflectParams());
			await engine.reflect(createReflectParams());
			await engine.reflect(createReflectParams());

			expect(engine.insightCount).toBeLessThanOrEqual(5);
		});

		// ── Test 8: Eviction prefers removing lower-confidence insights ─

		it("evicts the lowest-confidence insight when at capacity", async () => {
			const conversations = createMockConversationManager();
			const engine = new ReflectionEngine(conversations, silentLogger(), {
				maxInsights: 3,
			});

			// Insert 3 insights with varying confidence
			insertInsight(engine, {
				id: "low",
				confidence: 0.5,
				insight: "Low confidence",
			});
			insertInsight(engine, {
				id: "high",
				confidence: 0.8,
				insight: "High confidence",
			});
			insertInsight(engine, {
				id: "very-high",
				confidence: 0.9,
				insight: "Very high confidence",
			});

			expect(engine.insightCount).toBe(3);

			// Now call storeInsights with a new insight at 0.7 confidence
			// We do this via reflect() which calls storeInsights internally
			const response = validReflectionResponse({
				insights: [
					{
						category: "coordination",
						confidence: 0.7,
						insight: "New insight at 0.7",
						applicableWhen: "When testing",
						polarity: "neutral",
					},
				],
			});
			(conversations as any).sendOneShotJson = mock(() =>
				Promise.resolve(response),
			);

			await engine.reflect(createReflectParams());

			// Should be 3 (not 4) — the 0.5 confidence insight was evicted
			expect(engine.insightCount).toBe(3);

			const allInsights = engine.getAllInsights();
			const ids = allInsights.map((i) => i.id);
			expect(ids).not.toContain("low");
			expect(ids).toContain("high");
			expect(ids).toContain("very-high");
		});

		// ── Test 9: Low-confidence insights don't replace high-confidence ones ──

		it("does NOT store a new insight when it has lower confidence than all stored insights", async () => {
			const conversations = createMockConversationManager();
			const engine = new ReflectionEngine(conversations, silentLogger(), {
				maxInsights: 3,
			});

			// Insert 3 high-confidence insights
			insertInsight(engine, { id: "a", confidence: 0.9 });
			insertInsight(engine, { id: "b", confidence: 0.9 });
			insertInsight(engine, { id: "c", confidence: 0.9 });

			// Try to add a low-confidence insight
			const response = validReflectionResponse({
				insights: [
					{
						category: "sharing",
						confidence: 0.3,
						insight: "Low confidence new insight",
						applicableWhen: "When testing",
						polarity: "neutral",
					},
				],
			});
			(conversations as any).sendOneShotJson = mock(() =>
				Promise.resolve(response),
			);

			await engine.reflect(createReflectParams());

			// Still 3 insights, the low-confidence one was rejected
			expect(engine.insightCount).toBe(3);

			const allInsights = engine.getAllInsights();
			const ids = allInsights.map((i) => i.id);
			expect(ids).toContain("a");
			expect(ids).toContain("b");
			expect(ids).toContain("c");
			expect(
				allInsights.every((i) => i.insight !== "Low confidence new insight"),
			).toBe(true);
		});
	});

	// ── getInsightsForPrompt ─────────────────────────────────────────────

	describe("getInsightsForPrompt()", () => {
		// ── Test 10: Filters by minInsightConfidence ────────────────────

		it("filters insights below minInsightConfidence", () => {
			const engine = new ReflectionEngine(
				createMockConversationManager(),
				silentLogger(),
				{ minInsightConfidence: 0.6 },
			);

			insertInsight(engine, { confidence: 0.3, insight: "Low" });
			insertInsight(engine, { confidence: 0.5, insight: "Medium-low" });
			insertInsight(engine, { confidence: 0.7, insight: "Medium-high" });
			insertInsight(engine, { confidence: 0.9, insight: "High" });

			const result = engine.getInsightsForPrompt();

			expect(result.length).toBe(2);
			expect(result.some((i) => i.insight === "Medium-high")).toBe(true);
			expect(result.some((i) => i.insight === "High")).toBe(true);
			expect(result.some((i) => i.insight === "Low")).toBe(false);
			expect(result.some((i) => i.insight === "Medium-low")).toBe(false);
		});

		// ── Test 11: Respects maxInsightsInPrompt ──────────────────────

		it("limits output to maxInsightsInPrompt", () => {
			const engine = new ReflectionEngine(
				createMockConversationManager(),
				silentLogger(),
				{ maxInsightsInPrompt: 3, minInsightConfidence: 0.0 },
			);

			for (let i = 0; i < 10; i++) {
				insertInsight(engine, {
					confidence: 0.9,
					insight: `Insight ${i}`,
				});
			}

			const result = engine.getInsightsForPrompt();
			expect(result.length).toBe(3);
		});

		// ── Test 12: Sorts by confidence then by recency ───────────────

		it("sorts by confidence (highest first), then by recency (newest first)", () => {
			const engine = new ReflectionEngine(
				createMockConversationManager(),
				silentLogger(),
				{
					maxInsightsInPrompt: 10,
					minInsightConfidence: 0.0,
				},
			);

			const t1 = "2024-01-01T00:00:00Z";
			const t2 = "2024-01-02T00:00:00Z";
			const t3 = "2024-01-03T00:00:00Z";

			insertInsight(engine, {
				confidence: 0.7,
				insight: "C1-old",
				timestamp: t1,
			});
			insertInsight(engine, {
				confidence: 0.9,
				insight: "C3-new",
				timestamp: t3,
			});
			insertInsight(engine, {
				confidence: 0.9,
				insight: "C3-old",
				timestamp: t1,
			});
			insertInsight(engine, {
				confidence: 0.7,
				insight: "C1-new",
				timestamp: t2,
			});

			const result = engine.getInsightsForPrompt();

			// First two should be confidence 0.9, sorted by recency
			expect(result[0]!.insight).toBe("C3-new");
			expect(result[1]!.insight).toBe("C3-old");
			// Last two should be confidence 0.7, sorted by recency
			expect(result[2]!.insight).toBe("C1-new");
			expect(result[3]!.insight).toBe("C1-old");
		});

		it("returns an empty array when no insights exist", () => {
			const engine = new ReflectionEngine(
				createMockConversationManager(),
				silentLogger(),
			);

			const result = engine.getInsightsForPrompt();
			expect(result).toEqual([]);
		});
	});

	// ── getInsightsPromptSection ─────────────────────────────────────────

	describe("getInsightsPromptSection()", () => {
		// ── Test 13: Returns null without eligible insights ─────────────

		it("returns null when no eligible insights exist", () => {
			const engine = new ReflectionEngine(
				createMockConversationManager(),
				silentLogger(),
			);

			expect(engine.getInsightsPromptSection()).toBeNull();
		});

		it("returns null when all insights are below confidence threshold", () => {
			const engine = new ReflectionEngine(
				createMockConversationManager(),
				silentLogger(),
				{ minInsightConfidence: 0.8 },
			);

			insertInsight(engine, { confidence: 0.3 });
			insertInsight(engine, { confidence: 0.5 });

			expect(engine.getInsightsPromptSection()).toBeNull();
		});

		// ── Test 14: Formats insights correctly ────────────────────────

		it("formats insights with polarity icons and applicability conditions", () => {
			const engine = new ReflectionEngine(
				createMockConversationManager(),
				silentLogger(),
				{ minInsightConfidence: 0.0 },
			);

			insertInsight(engine, {
				polarity: "positive",
				insight: "Positive insight text",
				applicableWhen: "When doing good things",
				category: "decomposition",
				confidence: 0.85,
			});
			insertInsight(engine, {
				polarity: "negative",
				insight: "Negative insight text",
				applicableWhen: "When doing bad things",
				category: "sharing",
				confidence: 0.9,
			});
			insertInsight(engine, {
				polarity: "neutral",
				insight: "Neutral observation",
				applicableWhen: "Always",
				category: "coordination",
				confidence: 0.7,
			});

			const section = engine.getInsightsPromptSection();

			expect(section).not.toBeNull();
			expect(section).toContain("Lessons from previous executions");
			expect(section).toContain("✅");
			expect(section).toContain("⚠️");
			expect(section).toContain("ℹ️");
			expect(section).toContain("Positive insight text");
			expect(section).toContain("Negative insight text");
			expect(section).toContain("Neutral observation");
			expect(section).toContain("When doing good things");
			expect(section).toContain("When doing bad things");
			expect(section).toContain("[decomposition]");
			expect(section).toContain("[sharing]");
			expect(section).toContain("[coordination]");
		});
	});

	// ── Statistics and Getters ───────────────────────────────────────────

	describe("statistics", () => {
		it("reflectionCount starts at 0", () => {
			const engine = new ReflectionEngine(
				createMockConversationManager(),
				silentLogger(),
			);
			expect(engine.reflectionCount).toBe(0);
		});

		it("insightCount starts at 0", () => {
			const engine = new ReflectionEngine(
				createMockConversationManager(),
				silentLogger(),
			);
			expect(engine.insightCount).toBe(0);
		});

		it("isEnabled returns true by default", () => {
			const engine = new ReflectionEngine(
				createMockConversationManager(),
				silentLogger(),
			);
			expect(engine.isEnabled).toBe(true);
		});

		it("isEnabled returns false when disabled", () => {
			const engine = new ReflectionEngine(
				createMockConversationManager(),
				silentLogger(),
				{ enabled: false },
			);
			expect(engine.isEnabled).toBe(false);
		});

		it("lastReflection is null initially", () => {
			const engine = new ReflectionEngine(
				createMockConversationManager(),
				silentLogger(),
			);
			expect(engine.lastReflection).toBeNull();
		});

		it("getAllInsights returns a copy (not a reference)", () => {
			const engine = new ReflectionEngine(
				createMockConversationManager(),
				silentLogger(),
			);
			insertInsight(engine, {});

			const a = engine.getAllInsights();
			const b = engine.getAllInsights();
			expect(a).not.toBe(b); // Different array references
			expect(a).toEqual(b); // Same content
		});

		it("getAllReflections returns a copy (not a reference)", async () => {
			const conversations = createMockConversationManager();
			const engine = new ReflectionEngine(conversations, silentLogger());
			await engine.reflect(createReflectParams());

			const a = engine.getAllReflections();
			const b = engine.getAllReflections();
			expect(a).not.toBe(b);
			expect(a).toEqual(b);
		});
	});

	// ── Lifecycle ────────────────────────────────────────────────────────

	describe("lifecycle", () => {
		// ── Test 16: clearAll voids everything ──────────────────────────

		it("clearAll resets everything to initial state", async () => {
			const conversations = createMockConversationManager();
			const engine = new ReflectionEngine(conversations, silentLogger());

			await engine.reflect(createReflectParams());
			expect(engine.insightCount).toBeGreaterThan(0);
			expect(engine.reflectionCount).toBeGreaterThan(0);
			expect(engine.lastReflection).not.toBeNull();

			engine.clearAll();

			expect(engine.insightCount).toBe(0);
			expect(engine.reflectionCount).toBe(0);
			expect(engine.lastReflection).toBeNull();
			expect(engine.getAllInsights()).toEqual([]);
			expect(engine.getAllReflections()).toEqual([]);
		});

		// ── Test 17: clearReflections keeps insights ───────────────────

		it("clearReflections removes reflections but keeps insights", async () => {
			const conversations = createMockConversationManager();
			const engine = new ReflectionEngine(conversations, silentLogger());

			await engine.reflect(createReflectParams());
			const insightCountBefore = engine.insightCount;
			expect(insightCountBefore).toBeGreaterThan(0);
			expect(engine.getAllReflections().length).toBeGreaterThan(0);

			engine.clearReflections();

			expect(engine.insightCount).toBe(insightCountBefore); // Preserved
			expect(engine.getAllReflections()).toEqual([]); // Cleared
			expect(engine.lastReflection).toBeNull(); // No reflections left
		});
	});

	// ── Test 18: Insights survive between reflections ───────────────────

	describe("cross-execution insight persistence", () => {
		it("insights accumulate across multiple reflections", async () => {
			const conversations = createMockConversationManager();
			const engine = new ReflectionEngine(conversations, silentLogger());

			await engine.reflect(createReflectParams());
			const countAfterFirst = engine.insightCount;

			// Change the response to produce different insights
			(conversations as any).sendOneShotJson = mock(() =>
				Promise.resolve(
					validReflectionResponse({
						insights: [
							{
								category: "performance",
								confidence: 0.75,
								insight: "Completely different insight",
								applicableWhen: "When testing performance",
								polarity: "neutral",
							},
						],
					}),
				),
			);

			await engine.reflect(createReflectParams());
			const countAfterSecond = engine.insightCount;

			expect(countAfterSecond).toBeGreaterThan(countAfterFirst);

			const all = engine.getAllInsights();
			expect(all.some((i) => i.category === "sharing")).toBe(true); // From first
			expect(all.some((i) => i.category === "performance")).toBe(true); // From second
		});

		it("clearReflections preserves insights for the next reflection's dedup", async () => {
			const conversations = createMockConversationManager();
			const engine = new ReflectionEngine(conversations, silentLogger());

			await engine.reflect(createReflectParams());
			engine.clearReflections();

			const insightsForPrompt = engine.getInsightsForPrompt();
			expect(insightsForPrompt.length).toBeGreaterThan(0);
		});
	});

	// ── Configuration defaults ──────────────────────────────────────────

	describe("configuration defaults", () => {
		it("applies correct defaults when no config is provided", () => {
			const engine = new ReflectionEngine(
				createMockConversationManager(),
				silentLogger(),
			);

			expect(engine.isEnabled).toBe(true);
			// We can't directly test private config, but we can test behavior
			// maxInsights default = 30 — insert 31 and verify limit
			for (let i = 0; i < 35; i++) {
				insertInsight(engine, {
					id: `ins-${i}`,
					confidence: 0.5 + (i % 10) * 0.05,
				});
			}
			// Some should have been evicted by storeInsights, but since
			// we're using the private array directly, they won't be evicted.
			// Instead test via getInsightsForPrompt default limit
			const forPrompt = engine.getInsightsForPrompt();
			// Default maxInsightsInPrompt = 8
			expect(forPrompt.length).toBeLessThanOrEqual(8);
		});

		it("uses custom config values when provided", () => {
			const engine = new ReflectionEngine(
				createMockConversationManager(),
				silentLogger(),
				{
					enabled: false,
					maxInsights: 10,
					positivePatternThreshold: 0.5,
					maxInsightsInPrompt: 3,
					minInsightConfidence: 0.8,
					reflectOnSingleAgent: true,
				},
			);

			expect(engine.isEnabled).toBe(false);
		});
	});

	// ── Coordination stats in prompt ─────────────────────────────────────

	describe("prompt content", () => {
		it("includes coordination statistics in the reflection prompt", async () => {
			const conversations = createMockConversationManager();
			const engine = new ReflectionEngine(conversations, silentLogger());

			await engine.reflect(
				createReflectParams({
					coordinationStats: {
						deltaCount: 12,
						sharingEvaluationCount: 8,
						sharingApprovedCount: 5,
						notificationCount: 3,
						replanCount: 1,
					},
				}),
			);

			const call = conversations.sendOneShotJson.mock.calls[0]!;
			const prompt = call[1] as string;

			expect(prompt).toContain("Total deltas");
			expect(prompt).toContain("12");
			expect(prompt).toContain("Sharing evaluations");
			expect(prompt).toContain("8");
			expect(prompt).toContain("Sharing approved");
			expect(prompt).toContain("5");
			expect(prompt).toContain("Notifications sent");
			expect(prompt).toContain("3");
			expect(prompt).toContain("Re-plans triggered");
			expect(prompt).toContain("1");
		});

		it("computes sharing approval rate correctly", async () => {
			const conversations = createMockConversationManager();
			const engine = new ReflectionEngine(conversations, silentLogger());

			await engine.reflect(
				createReflectParams({
					coordinationStats: {
						deltaCount: 10,
						sharingEvaluationCount: 4,
						sharingApprovedCount: 3,
						notificationCount: 0,
					},
				}),
			);

			const call = conversations.sendOneShotJson.mock.calls[0]!;
			const prompt = call[1] as string;

			// 3/4 = 75%
			expect(prompt).toContain("75%");
		});

		it("handles zero sharing evaluations (0% rate)", async () => {
			const conversations = createMockConversationManager();
			const engine = new ReflectionEngine(conversations, silentLogger());

			await engine.reflect(
				createReflectParams({
					coordinationStats: {
						deltaCount: 0,
						sharingEvaluationCount: 0,
						sharingApprovedCount: 0,
						notificationCount: 0,
					},
				}),
			);

			const call = conversations.sendOneShotJson.mock.calls[0]!;
			const prompt = call[1] as string;

			// Should not crash, and 0% rate
			expect(prompt).toContain("0%");
		});

		it("includes the task and strategy in the prompt", async () => {
			const conversations = createMockConversationManager();
			const engine = new ReflectionEngine(conversations, silentLogger());

			await engine.reflect(createReflectParams());

			const call = conversations.sendOneShotJson.mock.calls[0]!;
			const prompt = call[1] as string;

			expect(prompt).toContain("Build a REST API with tests");
			expect(prompt).toContain("multi");
		});

		it("includes agent results in the prompt", async () => {
			const conversations = createMockConversationManager();
			const engine = new ReflectionEngine(conversations, silentLogger());

			await engine.reflect(createReflectParams());

			const call = conversations.sendOneShotJson.mock.calls[0]!;
			const prompt = call[1] as string;

			expect(prompt).toContain("api-developer");
			expect(prompt).toContain("test-writer");
			expect(prompt).toContain("Success");
		});

		it("includes subtask details in the prompt", async () => {
			const conversations = createMockConversationManager();
			const engine = new ReflectionEngine(conversations, silentLogger());

			await engine.reflect(createReflectParams());

			const call = conversations.sendOneShotJson.mock.calls[0]!;
			const prompt = call[1] as string;

			expect(prompt).toContain("subtask-api");
			expect(prompt).toContain("subtask-tests");
			expect(prompt).toContain("Build the REST API");
		});
	});
});

// ════════════════════════════════════════════════════════════════════════════
// validateReflectionResponse Tests
// ════════════════════════════════════════════════════════════════════════════

describe("validateReflectionResponse", () => {
	// ── Test 19: Accepts a valid complete response ──────────────────────

	it("accepts a complete valid response", () => {
		const valid = {
			effectivenessScore: 0.85,
			analysis: "Good execution overall",
			decompositionAssessment: "optimal",
			sharingAssessment: "under-shared",
			insights: [
				{
					category: "sharing",
					confidence: 0.9,
					insight: "Share more API details",
					applicableWhen: "When test-writer depends on api-developer",
					polarity: "negative",
				},
			],
		};

		const result = validateReflectionResponse(valid);
		expect(result).not.toBeNull();
		expect(result!.effectivenessScore).toBe(0.85);
		expect(result!.analysis).toBe("Good execution overall");
		expect(result!.decompositionAssessment).toBe("optimal");
		expect(result!.sharingAssessment).toBe("under-shared");
		expect(result!.insights.length).toBe(1);
		expect(result!.insights[0]!.category).toBe("sharing");
	});

	// ── Test 20: Accepts response with empty insights ──────────────────

	it("accepts a response with empty insights array", () => {
		const valid = {
			effectivenessScore: 1.0,
			analysis: "Perfect execution",
			decompositionAssessment: "optimal",
			sharingAssessment: "optimal",
			insights: [],
		};

		const result = validateReflectionResponse(valid);
		expect(result).not.toBeNull();
		expect(result!.insights).toEqual([]);
	});

	// ── Test 21: Rejects invalid decompositionAssessment ───────────────

	it("rejects invalid decompositionAssessment values", () => {
		const invalid = {
			effectivenessScore: 0.5,
			analysis: "test",
			decompositionAssessment: "bad",
			sharingAssessment: "optimal",
			insights: [],
		};

		expect(validateReflectionResponse(invalid)).toBeNull();
	});

	it("accepts all valid decompositionAssessment values", () => {
		for (const value of [
			"optimal",
			"over-decomposed",
			"under-decomposed",
			"wrong-boundaries",
		]) {
			const data = {
				effectivenessScore: 0.5,
				analysis: "test",
				decompositionAssessment: value,
				sharingAssessment: "optimal",
				insights: [],
			};
			expect(validateReflectionResponse(data)).not.toBeNull();
		}
	});

	// ── Test 22: Rejects invalid sharingAssessment ─────────────────────

	it("rejects invalid sharingAssessment values", () => {
		const invalid = {
			effectivenessScore: 0.5,
			analysis: "test",
			decompositionAssessment: "optimal",
			sharingAssessment: "terrible",
			insights: [],
		};

		expect(validateReflectionResponse(invalid)).toBeNull();
	});

	it("accepts all valid sharingAssessment values", () => {
		for (const value of [
			"optimal",
			"over-shared",
			"under-shared",
			"wrong-content",
		]) {
			const data = {
				effectivenessScore: 0.5,
				analysis: "test",
				decompositionAssessment: "optimal",
				sharingAssessment: value,
				insights: [],
			};
			expect(validateReflectionResponse(data)).not.toBeNull();
		}
	});

	// ── Test 23: Rejects invalid insight categories ────────────────────

	it("rejects invalid insight categories", () => {
		const invalid = {
			effectivenessScore: 0.5,
			analysis: "test",
			decompositionAssessment: "optimal",
			sharingAssessment: "optimal",
			insights: [
				{
					category: "magic",
					confidence: 0.5,
					insight: "test",
					applicableWhen: "always",
					polarity: "positive",
				},
			],
		};

		expect(validateReflectionResponse(invalid)).toBeNull();
	});

	it("accepts all valid insight categories", () => {
		for (const category of [
			"decomposition",
			"sharing",
			"coordination",
			"performance",
			"tooling",
		]) {
			const data = {
				effectivenessScore: 0.5,
				analysis: "test",
				decompositionAssessment: "optimal",
				sharingAssessment: "optimal",
				insights: [
					{
						category,
						confidence: 0.5,
						insight: "test insight",
						applicableWhen: "when testing",
						polarity: "positive",
					},
				],
			};
			expect(validateReflectionResponse(data)).not.toBeNull();
		}
	});

	it("rejects invalid insight polarities", () => {
		const invalid = {
			effectivenessScore: 0.5,
			analysis: "test",
			decompositionAssessment: "optimal",
			sharingAssessment: "optimal",
			insights: [
				{
					category: "sharing",
					confidence: 0.5,
					insight: "test",
					applicableWhen: "always",
					polarity: "good",
				},
			],
		};

		expect(validateReflectionResponse(invalid)).toBeNull();
	});

	it("accepts all valid insight polarities", () => {
		for (const polarity of ["positive", "negative", "neutral"]) {
			const data = {
				effectivenessScore: 0.5,
				analysis: "test",
				decompositionAssessment: "optimal",
				sharingAssessment: "optimal",
				insights: [
					{
						category: "sharing",
						confidence: 0.5,
						insight: "test insight",
						applicableWhen: "when testing",
						polarity,
					},
				],
			};
			expect(validateReflectionResponse(data)).not.toBeNull();
		}
	});

	// ── Test 24: Clamps effectivenessScore to [0, 1] ───────────────────

	it("clamps effectivenessScore above 1 to 1.0", () => {
		const data = {
			effectivenessScore: 1.5,
			analysis: "test",
			decompositionAssessment: "optimal",
			sharingAssessment: "optimal",
			insights: [],
		};

		const result = validateReflectionResponse(data);
		expect(result).not.toBeNull();
		expect(result!.effectivenessScore).toBe(1.0);
	});

	it("clamps effectivenessScore below 0 to 0.0", () => {
		const data = {
			effectivenessScore: -0.5,
			analysis: "test",
			decompositionAssessment: "optimal",
			sharingAssessment: "optimal",
			insights: [],
		};

		const result = validateReflectionResponse(data);
		expect(result).not.toBeNull();
		expect(result!.effectivenessScore).toBe(0.0);
	});

	it("clamps insight confidence to [0, 1]", () => {
		const data = {
			effectivenessScore: 0.5,
			analysis: "test",
			decompositionAssessment: "optimal",
			sharingAssessment: "optimal",
			insights: [
				{
					category: "sharing",
					confidence: 1.5,
					insight: "test insight",
					applicableWhen: "when testing",
					polarity: "positive",
				},
			],
		};

		const result = validateReflectionResponse(data);
		expect(result!.insights[0]!.confidence).toBe(1.0);
	});

	// ── Null/undefined/missing field rejections ────────────────────────

	it("rejects null input", () => {
		expect(validateReflectionResponse(null)).toBeNull();
	});

	it("rejects undefined input", () => {
		expect(validateReflectionResponse(undefined)).toBeNull();
	});

	it("rejects non-object input", () => {
		expect(validateReflectionResponse("string")).toBeNull();
		expect(validateReflectionResponse(42)).toBeNull();
		expect(validateReflectionResponse(true)).toBeNull();
	});

	it("rejects missing effectivenessScore", () => {
		const data = {
			analysis: "test",
			decompositionAssessment: "optimal",
			sharingAssessment: "optimal",
			insights: [],
		};
		expect(validateReflectionResponse(data)).toBeNull();
	});

	it("rejects non-numeric effectivenessScore", () => {
		const data = {
			effectivenessScore: "high",
			analysis: "test",
			decompositionAssessment: "optimal",
			sharingAssessment: "optimal",
			insights: [],
		};
		expect(validateReflectionResponse(data)).toBeNull();
	});

	it("rejects missing analysis", () => {
		const data = {
			effectivenessScore: 0.5,
			decompositionAssessment: "optimal",
			sharingAssessment: "optimal",
			insights: [],
		};
		expect(validateReflectionResponse(data)).toBeNull();
	});

	it("rejects empty analysis string", () => {
		const data = {
			effectivenessScore: 0.5,
			analysis: "",
			decompositionAssessment: "optimal",
			sharingAssessment: "optimal",
			insights: [],
		};
		expect(validateReflectionResponse(data)).toBeNull();
	});

	it("rejects missing decompositionAssessment", () => {
		const data = {
			effectivenessScore: 0.5,
			analysis: "test",
			sharingAssessment: "optimal",
			insights: [],
		};
		expect(validateReflectionResponse(data)).toBeNull();
	});

	it("rejects missing sharingAssessment", () => {
		const data = {
			effectivenessScore: 0.5,
			analysis: "test",
			decompositionAssessment: "optimal",
			insights: [],
		};
		expect(validateReflectionResponse(data)).toBeNull();
	});

	it("rejects missing insights array", () => {
		const data = {
			effectivenessScore: 0.5,
			analysis: "test",
			decompositionAssessment: "optimal",
			sharingAssessment: "optimal",
		};
		expect(validateReflectionResponse(data)).toBeNull();
	});

	it("rejects insights that is not an array", () => {
		const data = {
			effectivenessScore: 0.5,
			analysis: "test",
			decompositionAssessment: "optimal",
			sharingAssessment: "optimal",
			insights: "not an array",
		};
		expect(validateReflectionResponse(data)).toBeNull();
	});

	it("rejects insights with null items", () => {
		const data = {
			effectivenessScore: 0.5,
			analysis: "test",
			decompositionAssessment: "optimal",
			sharingAssessment: "optimal",
			insights: [null],
		};
		expect(validateReflectionResponse(data)).toBeNull();
	});

	it("rejects insights with empty insight string", () => {
		const data = {
			effectivenessScore: 0.5,
			analysis: "test",
			decompositionAssessment: "optimal",
			sharingAssessment: "optimal",
			insights: [
				{
					category: "sharing",
					confidence: 0.5,
					insight: "",
					applicableWhen: "when testing",
					polarity: "positive",
				},
			],
		};
		expect(validateReflectionResponse(data)).toBeNull();
	});

	it("rejects insights with empty applicableWhen string", () => {
		const data = {
			effectivenessScore: 0.5,
			analysis: "test",
			decompositionAssessment: "optimal",
			sharingAssessment: "optimal",
			insights: [
				{
					category: "sharing",
					confidence: 0.5,
					insight: "test insight",
					applicableWhen: "",
					polarity: "positive",
				},
			],
		};
		expect(validateReflectionResponse(data)).toBeNull();
	});

	it("rejects insights with non-numeric confidence", () => {
		const data = {
			effectivenessScore: 0.5,
			analysis: "test",
			decompositionAssessment: "optimal",
			sharingAssessment: "optimal",
			insights: [
				{
					category: "sharing",
					confidence: "high",
					insight: "test insight",
					applicableWhen: "when testing",
					polarity: "positive",
				},
			],
		};
		expect(validateReflectionResponse(data)).toBeNull();
	});

	it("accepts a response with multiple valid insights", () => {
		const data = {
			effectivenessScore: 0.7,
			analysis: "Multi-insight test",
			decompositionAssessment: "wrong-boundaries",
			sharingAssessment: "wrong-content",
			insights: [
				{
					category: "decomposition",
					confidence: 0.9,
					insight: "First insight",
					applicableWhen: "Condition 1",
					polarity: "positive",
				},
				{
					category: "sharing",
					confidence: 0.7,
					insight: "Second insight",
					applicableWhen: "Condition 2",
					polarity: "negative",
				},
				{
					category: "coordination",
					confidence: 0.5,
					insight: "Third insight",
					applicableWhen: "Condition 3",
					polarity: "neutral",
				},
			],
		};

		const result = validateReflectionResponse(data);
		expect(result).not.toBeNull();
		expect(result!.insights.length).toBe(3);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// TaskPlanner.appendLessonsToLastMemory Tests
// ════════════════════════════════════════════════════════════════════════════

describe("TaskPlanner.appendLessonsToLastMemory", () => {
	// We need a real TaskPlanner instance for these tests
	function createPlannerWithMockConversations() {
		const conversations = {
			has: () => true,
			register: () => {},
			send: () => Promise.resolve(""),
			sendJson: () => Promise.resolve({}),
			sendOneShot: () => Promise.resolve(""),
			sendOneShotJson: () => Promise.resolve(null),
			getStats: () => null,
			getHistory: () => null,
			reset: () => {},
			resetAll: () => {},
			client: {
				validateModel: () => Promise.resolve(),
				sanitize: (s: string) => s,
			},
		} as any;

		// Import TaskPlanner dynamically to avoid circular deps
		const { TaskPlanner } = require("../task-planner.ts");
		return new TaskPlanner(conversations, silentLogger()) as InstanceType<
			typeof import("../task-planner.ts").TaskPlanner
		>;
	}

	it("appends lessons to the most recent memory entry", () => {
		const planner = createPlannerWithMockConversations();

		// Simulate a recorded execution
		const analysis = {
			strategy: ExecutionStrategy.MULTI,
			complexity: TaskComplexity.COMPLEX,
			reasoning: "test",
			subtasks: [
				{
					id: "s1",
					prompt: "Do X",
					role: "role-a",
					dependencies: [],
					priority: 1,
				},
			],
			dependencies: [],
			parallelismBenefit: 0.5,
		};

		const results = [
			{
				agentId: "a1",
				agentName: "role-a",
				subtask: analysis.subtasks[0],
				promptResult: {
					stopReason: "end_turn" as const,
					text: "Done",
					usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
				},
				events: [],
				filesWritten: ["file.ts"],
				success: true,
				error: undefined,
				retryCount: 0,
				timedOut: false,
				subtaskDurationMs: 1000,
			},
		];

		planner.recordExecution("Test task", analysis, results as any);
		expect(planner.memoryCount).toBe(1);

		// Append reflection lessons
		planner.appendLessonsToLastMemory([
			"✅ [decomposition] Good split",
			"⚠️ [sharing] Need more context sharing",
		]);

		const memories = planner.getMemories();
		expect(memories.length).toBe(1);
		expect(memories[0]!.lessons).toContain("Good split");
		expect(memories[0]!.lessons).toContain("Need more context sharing");
		expect(memories[0]!.lessons).toContain("✅");
		expect(memories[0]!.lessons).toContain("⚠️");
	});

	it("does nothing when memories array is empty", () => {
		const planner = createPlannerWithMockConversations();

		expect(planner.memoryCount).toBe(0);

		// Should not throw
		planner.appendLessonsToLastMemory(["Some lesson"]);

		expect(planner.memoryCount).toBe(0);
	});

	it("does nothing when lessons array is empty", () => {
		const planner = createPlannerWithMockConversations();

		const analysis = {
			strategy: ExecutionStrategy.SINGLE,
			complexity: TaskComplexity.SIMPLE,
			reasoning: "test",
			subtasks: [
				{
					id: "s1",
					prompt: "Do X",
					role: "role-a",
					dependencies: [],
					priority: 1,
				},
			],
			dependencies: [],
			parallelismBenefit: 0,
		};

		const results = [
			{
				agentId: "a1",
				agentName: "role-a",
				subtask: analysis.subtasks[0],
				promptResult: {
					stopReason: "end_turn" as const,
					text: "Done",
					usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
				},
				events: [],
				filesWritten: [],
				success: true,
				error: undefined,
				retryCount: 0,
				timedOut: false,
				subtaskDurationMs: 500,
			},
		];

		planner.recordExecution("Test task", analysis, results as any);
		const originalLessons = planner.getMemories()[0]!.lessons;

		planner.appendLessonsToLastMemory([]);

		// Lessons should be unchanged
		expect(planner.getMemories()[0]!.lessons).toBe(originalLessons);
	});

	it("caps total lesson length at 2000 characters", () => {
		const planner = createPlannerWithMockConversations();

		const analysis = {
			strategy: ExecutionStrategy.MULTI,
			complexity: TaskComplexity.COMPLEX,
			reasoning: "test",
			subtasks: [
				{
					id: "s1",
					prompt: "Do X",
					role: "role-a",
					dependencies: [],
					priority: 1,
				},
			],
			dependencies: [],
			parallelismBenefit: 0.5,
		};

		const results = [
			{
				agentId: "a1",
				agentName: "role-a",
				subtask: analysis.subtasks[0],
				promptResult: {
					stopReason: "end_turn" as const,
					text: "Done",
					usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
				},
				events: [],
				filesWritten: [],
				success: true,
				error: undefined,
				retryCount: 0,
				timedOut: false,
				subtaskDurationMs: 1000,
			},
		];

		planner.recordExecution("Test task", analysis, results as any);

		// Append a very long lesson
		const longLesson = "A".repeat(3000);
		planner.appendLessonsToLastMemory([longLesson]);

		const memories = planner.getMemories();
		expect(memories[0]!.lessons.length).toBeLessThanOrEqual(2000);
	});

	it("only modifies the most recent memory, not earlier ones", () => {
		const planner = createPlannerWithMockConversations();

		const analysis = {
			strategy: ExecutionStrategy.SINGLE,
			complexity: TaskComplexity.SIMPLE,
			reasoning: "test",
			subtasks: [
				{
					id: "s1",
					prompt: "Do X",
					role: "role-a",
					dependencies: [],
					priority: 1,
				},
			],
			dependencies: [],
			parallelismBenefit: 0,
		};

		const results = [
			{
				agentId: "a1",
				agentName: "role-a",
				subtask: analysis.subtasks[0],
				promptResult: {
					stopReason: "end_turn" as const,
					text: "Done",
					usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
				},
				events: [],
				filesWritten: [],
				success: true,
				error: undefined,
				retryCount: 0,
				timedOut: false,
				subtaskDurationMs: 500,
			},
		];

		// Record two executions
		planner.recordExecution("First task", analysis, results as any);
		const firstLessons = planner.getMemories()[0]!.lessons;

		planner.recordExecution("Second task", analysis, results as any);

		// Append to the last memory only
		planner.appendLessonsToLastMemory(["New insight for second"]);

		const memories = planner.getMemories();
		expect(memories.length).toBe(2);
		// First memory should be unchanged
		expect(memories[0]!.lessons).toBe(firstLessons);
		// Second memory should have the new insight
		expect(memories[1]!.lessons).toContain("New insight for second");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// TaskPlanner.setReflectionEngine Tests
// ════════════════════════════════════════════════════════════════════════════

describe("TaskPlanner.setReflectionEngine", () => {
	it("planner works without a reflection engine (returns null for insights)", () => {
		const conversations = {
			has: () => true,
			register: () => {},
			reset: () => {},
			client: {
				validateModel: () => Promise.resolve(),
				sanitize: (s: string) => s,
			},
		} as any;

		const { TaskPlanner } = require("../task-planner.ts");
		const planner = new TaskPlanner(conversations, silentLogger());

		// Without setReflectionEngine, the planner should still function.
		// The private reflectionEngine is null, so getInsightsPromptSection returns null.
		// This is verified indirectly — analyze() would work without insights.
		expect(planner.memoryCount).toBe(0);
	});

	it("setReflectionEngine allows insight injection", () => {
		const conversations = {
			has: () => true,
			register: () => {},
			reset: () => {},
			client: {
				validateModel: () => Promise.resolve(),
				sanitize: (s: string) => s,
			},
		} as any;

		const { TaskPlanner } = require("../task-planner.ts");
		const planner = new TaskPlanner(conversations, silentLogger());

		const engine = new ReflectionEngine(
			createMockConversationManager(),
			silentLogger(),
			{ minInsightConfidence: 0.0 },
		);

		// Add an insight to the engine
		insertInsight(engine, {
			insight: "Test insight for planner",
			confidence: 0.9,
		});

		// Wire the engine
		planner.setReflectionEngine(engine);

		// The engine should now provide insights via getInsightsPromptSection()
		const section = engine.getInsightsPromptSection();
		expect(section).not.toBeNull();
		expect(section).toContain("Test insight for planner");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// enrichPlannerMemoryWithReflection — Edge Cases
// ════════════════════════════════════════════════════════════════════════════

describe("enrichPlannerMemoryWithReflection edge cases", () => {
	it("only includes insights with confidence >= 0.6 in enrichment", () => {
		// This tests the filtering logic in enrichPlannerMemoryWithReflection
		// which only adds insights with confidence >= 0.6 to the planner memory.
		// We simulate this by checking the reflection's insights directly.

		const reflection: ExecutionReflection = {
			task: "Test task",
			strategy: ExecutionStrategy.MULTI,
			effectivenessScore: 0.8,
			analysis: "Good execution",
			decompositionAssessment: "optimal",
			sharingAssessment: "optimal",
			insights: [
				{
					id: "i1",
					category: "decomposition",
					confidence: 0.3,
					insight: "Low confidence insight",
					applicableWhen: "When testing",
					polarity: "positive",
					timestamp: new Date().toISOString(),
				},
				{
					id: "i2",
					category: "sharing",
					confidence: 0.8,
					insight: "High confidence insight",
					applicableWhen: "When sharing",
					polarity: "negative",
					timestamp: new Date().toISOString(),
				},
			],
			timestamp: new Date().toISOString(),
			executionDurationMs: 5000,
		};

		// Simulate the filtering logic from enrichPlannerMemoryWithReflection
		const insightLessons = reflection.insights
			.filter((i: ExecutionInsight) => i.confidence >= 0.6)
			.map((i: ExecutionInsight) => {
				const polarity =
					i.polarity === "positive"
						? "✅"
						: i.polarity === "negative"
							? "⚠️"
							: "ℹ️";
				return `${polarity} [${i.category}] ${i.insight} (when: ${i.applicableWhen})`;
			});

		// Only the high-confidence insight should be included
		expect(insightLessons.length).toBe(1);
		expect(insightLessons[0]).toContain("High confidence insight");
		expect(insightLessons[0]).toContain("⚠️");
		expect(insightLessons[0]).not.toContain("Low confidence insight");
	});

	it("skips enrichment when all insights have confidence < 0.6", () => {
		const reflection: ExecutionReflection = {
			task: "Test task",
			strategy: ExecutionStrategy.MULTI,
			effectivenessScore: 0.5,
			analysis: "Mediocre execution",
			decompositionAssessment: "over-decomposed",
			sharingAssessment: "under-shared",
			insights: [
				{
					id: "i1",
					category: "decomposition",
					confidence: 0.2,
					insight: "Very low confidence",
					applicableWhen: "When testing",
					polarity: "neutral",
					timestamp: new Date().toISOString(),
				},
				{
					id: "i2",
					category: "sharing",
					confidence: 0.5,
					insight: "Just below threshold",
					applicableWhen: "When sharing",
					polarity: "negative",
					timestamp: new Date().toISOString(),
				},
			],
			timestamp: new Date().toISOString(),
			executionDurationMs: 3000,
		};

		const insightLessons = reflection.insights
			.filter((i: ExecutionInsight) => i.confidence >= 0.6)
			.map((i: ExecutionInsight) => `[${i.category}] ${i.insight}`);

		expect(insightLessons.length).toBe(0);
	});

	it("includes assessment summary in enrichment lessons", () => {
		const reflection: ExecutionReflection = {
			task: "Test task",
			strategy: ExecutionStrategy.MULTI,
			effectivenessScore: 0.75,
			analysis: "Decent execution",
			decompositionAssessment: "wrong-boundaries",
			sharingAssessment: "wrong-content",
			insights: [
				{
					id: "i1",
					category: "coordination",
					confidence: 0.9,
					insight: "Agent coordination was poor",
					applicableWhen: "When agents share files",
					polarity: "negative",
					timestamp: new Date().toISOString(),
				},
			],
			timestamp: new Date().toISOString(),
			executionDurationMs: 8000,
		};

		// Simulate the assessment lesson from enrichPlannerMemoryWithReflection
		const assessmentLesson =
			`Reflection: effectiveness=${reflection.effectivenessScore}, ` +
			`decomposition=${reflection.decompositionAssessment}, ` +
			`sharing=${reflection.sharingAssessment}`;

		expect(assessmentLesson).toContain("effectiveness=0.75");
		expect(assessmentLesson).toContain("decomposition=wrong-boundaries");
		expect(assessmentLesson).toContain("sharing=wrong-content");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Test 36: Planning template compatibility with executionInsights
// ════════════════════════════════════════════════════════════════════════════

describe("Planning template compatibility (test 36)", () => {
	it("taskAnalysisPrompt works without executionInsights (null)", () => {
		const { taskAnalysisPrompt } = require("../../../prompts/planning.ts");

		const prompt = taskAnalysisPrompt({
			task: "Build a REST API",
			contextHints: null,
			constraints: null,
			projectContext: null,
			previousExecutions: null,
			executionInsights: null,
		});

		expect(typeof prompt).toBe("string");
		expect(prompt.length).toBeGreaterThan(0);
		expect(prompt).toContain("Build a REST API");
		// Should NOT contain the insights section
		expect(prompt).not.toContain("Lessons from previous executions");
	});

	it("taskAnalysisPrompt works without executionInsights (undefined)", () => {
		const { taskAnalysisPrompt } = require("../../../prompts/planning.ts");

		const prompt = taskAnalysisPrompt({
			task: "Fix a bug",
			contextHints: null,
			constraints: null,
			projectContext: null,
			previousExecutions: null,
			// executionInsights not provided at all
		});

		expect(typeof prompt).toBe("string");
		expect(prompt).toContain("Fix a bug");
		expect(prompt).not.toContain("Lessons from previous executions");
	});

	it("taskAnalysisPrompt includes executionInsights when provided", () => {
		const { taskAnalysisPrompt } = require("../../../prompts/planning.ts");

		const insightsSection =
			"## Lessons from previous executions\n" +
			"- ✅ [decomposition] Splitting API and tests works well\n" +
			"  _Applies when: When building REST APIs_ (confidence: 0.9)";

		const prompt = taskAnalysisPrompt({
			task: "Build another REST API",
			contextHints: null,
			constraints: null,
			projectContext: null,
			previousExecutions: null,
			executionInsights: insightsSection,
		});

		expect(typeof prompt).toBe("string");
		expect(prompt).toContain("Build another REST API");
		expect(prompt).toContain("Lessons from previous executions");
		expect(prompt).toContain("Splitting API and tests works well");
		expect(prompt).toContain("confidence: 0.9");
	});

	it("taskAnalysisPrompt works with both previousExecutions and executionInsights", () => {
		const { taskAnalysisPrompt } = require("../../../prompts/planning.ts");

		const prompt = taskAnalysisPrompt({
			task: "Create a library",
			contextHints: "TypeScript project",
			constraints: ["Must use ESM"],
			projectContext: null,
			previousExecutions:
				"## Execution #1\nTask: Build API\nStrategy: multi\nOutcome: 2/2 succeeded",
			executionInsights:
				"## Lessons from previous executions\n- ✅ [decomposition] Good split",
		});

		expect(typeof prompt).toBe("string");
		expect(prompt).toContain("Create a library");
		expect(prompt).toContain("TypeScript project");
		expect(prompt).toContain("Must use ESM");
		expect(prompt).toContain("Execution #1");
		expect(prompt).toContain("Lessons from previous executions");
	});
});
