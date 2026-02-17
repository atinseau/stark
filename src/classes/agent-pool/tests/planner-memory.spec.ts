import { describe, expect, it } from "bun:test";

import { ExecutionStrategy } from "../../../enums/execution-strategy.enum.ts";
import { TaskComplexity } from "../../../enums/task-complexity.enum.ts";
import type { PromptResult } from "../../../types/agent.types.ts";
import type {
	AgentExecutionResult,
	PlannerMemory,
	TaskAnalysis,
} from "../../../types/agent-pool.types.ts";
import { AgentPool } from "../agent-pool.ts";
import { TaskPlanner } from "../task-planner.ts";
import {
	createMockAgentFactory,
	multiTaskAnalysis,
	silentLogger,
	silentPoolConfig,
	singleTaskAnalysis,
} from "./test-helpers.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Creates a minimal ConversationManager stub for TaskPlanner construction.
 * The planner only needs `has()`, `register()`, `reset()`, `client.sanitize()`,
 * and `sendJson()` — we stub them all.
 */
function createConversationManagerStub(options?: {
	sendJsonResult?: TaskAnalysis;
	sendJsonCapture?: { prompts: string[] };
}) {
	const sendJsonCapture = options?.sendJsonCapture ?? { prompts: [] };
	const sendJsonResult =
		options?.sendJsonResult ?? singleTaskAnalysis("stub task");

	return {
		has: () => true,
		register: () => {},
		reset: () => {},
		client: {
			sanitize: (text: string) => text,
		},
		sendJson: async (_role: unknown, prompt: string) => {
			sendJsonCapture.prompts.push(prompt);
			return sendJsonResult;
		},
	} as any;
}

/** Creates a valid AgentExecutionResult for testing. */
function createExecutionResult(
	overrides?: Partial<AgentExecutionResult>,
): AgentExecutionResult {
	const defaultPromptResult: PromptResult = {
		stopReason: "end_turn",
		text: "Done.",
		usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
	};

	return {
		agentId: crypto.randomUUID(),
		agentName: overrides?.agentName ?? "test-agent",
		subtask: overrides?.subtask ?? {
			id: "task-1",
			prompt: "Do something",
			role: overrides?.subtask?.role ?? "general-agent",
			dependencies: [],
			priority: 1,
		},
		promptResult: overrides?.promptResult ?? defaultPromptResult,
		events: overrides?.events ?? [],
		filesWritten: overrides?.filesWritten ?? [],
		success: overrides?.success ?? true,
		error: overrides?.error,
		retryCount: overrides?.retryCount ?? 0,
		timedOut: overrides?.timedOut ?? false,
		subtaskDurationMs: overrides?.subtaskDurationMs ?? 1000,
	};
}

/** Creates a TaskPlanner with a stubbed ConversationManager. */
function createTestPlanner(
	options?: Parameters<typeof createConversationManagerStub>[0],
) {
	const conversations = createConversationManagerStub(options);
	const logger = silentLogger();
	return new TaskPlanner(conversations, logger);
}

// ════════════════════════════════════════════════════════════════════════════
// Planner Memory Tests
// ════════════════════════════════════════════════════════════════════════════

describe("TaskPlanner Memory", () => {
	// ── Test 1: recordExecution creates a correct memory ────────────────

	describe("recordExecution", () => {
		it("creates a memory with correct fields from a successful execution", () => {
			const planner = createTestPlanner();
			const task = "Build the REST API";
			const analysis = multiTaskAnalysis();
			const results: AgentExecutionResult[] = [
				createExecutionResult({
					success: true,
					subtask: {
						id: "subtask-api",
						prompt: "Build the REST API",
						role: "api-developer",
						dependencies: [],
						priority: 1,
					},
					filesWritten: ["src/routes/users.ts", "src/models/user.ts"],
				}),
				createExecutionResult({
					success: true,
					subtask: {
						id: "subtask-tests",
						prompt: "Write tests",
						role: "test-writer",
						dependencies: ["subtask-api"],
						priority: 2,
					},
					filesWritten: ["tests/users.test.ts"],
				}),
			];

			planner.recordExecution(task, analysis, results);

			expect(planner.memoryCount).toBe(1);

			const memories = planner.getMemories();
			expect(memories).toHaveLength(1);

			const memory = memories[0]!;
			expect(memory.task).toBe("Build the REST API");
			expect(memory.strategy).toBe(ExecutionStrategy.MULTI);
			expect(memory.roles).toEqual(["api-developer", "test-writer"]);
			expect(memory.outcome).toContain("2/2 subtask(s) succeeded");
			expect(memory.outcome).toContain("api-developer: completed");
			expect(memory.outcome).toContain("test-writer: completed");
			expect(memory.filesAffected).toContain("src/routes/users.ts");
			expect(memory.filesAffected).toContain("src/models/user.ts");
			expect(memory.filesAffected).toContain("tests/users.test.ts");
			expect(memory.lessons).toContain("Multi-agent decomposition worked well");
			expect(memory.timestamp).toMatch(
				/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
			);
		});

		it("truncates task to 200 chars", () => {
			const planner = createTestPlanner();
			const longTask = "A".repeat(500);
			const analysis = singleTaskAnalysis(longTask);
			const results = [createExecutionResult({ success: true })];

			planner.recordExecution(longTask, analysis, results);

			const memory = planner.getMemories()[0]!;
			expect(memory.task).toHaveLength(200);
			expect(memory.task).toBe("A".repeat(200));
		});

		it("extracts roles from analysis subtasks (not results)", () => {
			const planner = createTestPlanner();
			const analysis = multiTaskAnalysis();
			// analysis has subtasks with roles: "api-developer", "test-writer"
			const results = [
				createExecutionResult({ success: true }),
				createExecutionResult({ success: true }),
			];

			planner.recordExecution("task", analysis, results);

			const memory = planner.getMemories()[0]!;
			expect(memory.roles).toEqual(["api-developer", "test-writer"]);
		});

		it("contains the correct success/total ratio in outcome", () => {
			const planner = createTestPlanner();
			const analysis = multiTaskAnalysis();
			const results = [
				createExecutionResult({ success: true }),
				createExecutionResult({ success: false, error: "some error" }),
			];

			planner.recordExecution("task", analysis, results);

			const memory = planner.getMemories()[0]!;
			expect(memory.outcome).toContain("1/2 subtask(s) succeeded");
		});
	});

	// ── Test 2: recordExecution respects MAX_MEMORY_ENTRIES ─────────────

	describe("MAX_MEMORY_ENTRIES enforcement", () => {
		it("keeps only the 3 most recent memories when more are recorded", () => {
			const planner = createTestPlanner();
			const analysis = singleTaskAnalysis("task");

			for (let i = 1; i <= 5; i++) {
				planner.recordExecution(`Task ${i}`, analysis, [
					createExecutionResult({ success: true }),
				]);
			}

			expect(planner.memoryCount).toBe(3);

			const memories = planner.getMemories();
			// The 3 most recent should be tasks 3, 4, 5
			expect(memories[0]!.task).toBe("Task 3");
			expect(memories[1]!.task).toBe("Task 4");
			expect(memories[2]!.task).toBe("Task 5");
		});

		it("evicts oldest memory first (FIFO)", () => {
			const planner = createTestPlanner();
			const analysis = singleTaskAnalysis("task");

			// Record 3 (fills the slots)
			planner.recordExecution("First", analysis, [createExecutionResult()]);
			planner.recordExecution("Second", analysis, [createExecutionResult()]);
			planner.recordExecution("Third", analysis, [createExecutionResult()]);
			expect(planner.memoryCount).toBe(3);
			expect(planner.getMemories()[0]!.task).toBe("First");

			// Record 4th — should evict "First"
			planner.recordExecution("Fourth", analysis, [createExecutionResult()]);
			expect(planner.memoryCount).toBe(3);
			expect(planner.getMemories()[0]!.task).toBe("Second");
			expect(planner.getMemories()[2]!.task).toBe("Fourth");
		});
	});

	// ── Test 3: clearMemory ────────────────────────────────────────────

	describe("clearMemory", () => {
		it("removes all stored memories", () => {
			const planner = createTestPlanner();
			const analysis = singleTaskAnalysis("task");

			planner.recordExecution("Task 1", analysis, [createExecutionResult()]);
			planner.recordExecution("Task 2", analysis, [createExecutionResult()]);
			planner.recordExecution("Task 3", analysis, [createExecutionResult()]);

			expect(planner.memoryCount).toBe(3);

			planner.clearMemory();

			expect(planner.memoryCount).toBe(0);
			expect(planner.getMemories()).toEqual([]);
		});

		it("is idempotent — clearing an empty memory is a no-op", () => {
			const planner = createTestPlanner();

			expect(planner.memoryCount).toBe(0);
			planner.clearMemory();
			expect(planner.memoryCount).toBe(0);
		});
	});

	// ── Test 4: buildMemoryContext returns null without memories ────────

	describe("memory context (via analyze prompt inspection)", () => {
		it("does not include Previous Execution Context on first call (no memories)", async () => {
			const capture = { prompts: [] as string[] };
			const planner = createTestPlanner({
				sendJsonCapture: capture,
				sendJsonResult: singleTaskAnalysis("result"),
			});

			await planner.analyze("First task");

			expect(capture.prompts).toHaveLength(1);
			expect(capture.prompts[0]).not.toContain("## Previous Execution Context");
		});

		// ── Test 5: buildMemoryContext formats memories correctly ──────

		it("includes formatted memory context in the prompt after recordExecution", async () => {
			const capture = { prompts: [] as string[] };
			const planner = createTestPlanner({
				sendJsonCapture: capture,
				sendJsonResult: singleTaskAnalysis("result"),
			});

			// Record a previous execution
			const analysis = multiTaskAnalysis();
			planner.recordExecution("Build the API", analysis, [
				createExecutionResult({
					success: true,
					subtask: {
						id: "subtask-api",
						prompt: "Build API",
						role: "api-developer",
						dependencies: [],
						priority: 1,
					},
					filesWritten: ["src/api.ts"],
				}),
				createExecutionResult({
					success: false,
					error: "Timeout: exceeded 60000ms",
					subtask: {
						id: "subtask-tests",
						prompt: "Write tests",
						role: "test-writer",
						dependencies: ["subtask-api"],
						priority: 2,
					},
				}),
			]);

			// Now analyze a new task
			await planner.analyze("Add authentication");

			expect(capture.prompts).toHaveLength(1);
			const prompt = capture.prompts[0]!;

			// Should contain the section header
			expect(prompt).toContain("## Previous Execution Context");

			// Should contain the execution number
			expect(prompt).toContain("### Execution 1");

			// Should contain the task
			expect(prompt).toContain("Build the API");

			// Should contain strategy
			expect(prompt).toContain("multi");

			// Should contain roles
			expect(prompt).toContain("api-developer");
			expect(prompt).toContain("test-writer");

			// Should contain outcome
			expect(prompt).toContain("1/2 subtask(s) succeeded");

			// Should contain files
			expect(prompt).toContain("src/api.ts");

			// Should contain lessons
			expect(prompt).toContain("Lessons");
		});

		it("formats multiple memories with numbered sections", async () => {
			const capture = { prompts: [] as string[] };
			const planner = createTestPlanner({
				sendJsonCapture: capture,
				sendJsonResult: singleTaskAnalysis("result"),
			});

			const analysis = singleTaskAnalysis("task");
			planner.recordExecution("First task", analysis, [
				createExecutionResult({ success: true }),
			]);
			planner.recordExecution("Second task", analysis, [
				createExecutionResult({ success: true }),
			]);

			await planner.analyze("Third task");

			const prompt = capture.prompts[0]!;
			expect(prompt).toContain("### Execution 1");
			expect(prompt).toContain("### Execution 2");
			expect(prompt).toContain("First task");
			expect(prompt).toContain("Second task");
		});
	});

	// ── Test 6 & 7: analyze injects/doesn't inject memories ──────────

	describe("analyze memory injection", () => {
		it("injects memories into the prompt when present", async () => {
			const capture = { prompts: [] as string[] };
			const planner = createTestPlanner({
				sendJsonCapture: capture,
				sendJsonResult: singleTaskAnalysis("result"),
			});

			planner.recordExecution("Previous work", singleTaskAnalysis("prev"), [
				createExecutionResult({ success: true }),
			]);

			await planner.analyze("New task");

			expect(capture.prompts[0]).toContain("## Previous Execution Context");
			expect(capture.prompts[0]).toContain("Previous work");
		});

		it("does NOT inject memories on the very first call", async () => {
			const capture = { prompts: [] as string[] };
			const planner = createTestPlanner({
				sendJsonCapture: capture,
				sendJsonResult: singleTaskAnalysis("result"),
			});

			await planner.analyze("First task ever");

			expect(capture.prompts[0]).not.toContain("## Previous Execution Context");
		});
	});

	// ── Test 8: analyze resets conversation but preserves memories ─────

	describe("conversation reset vs memory preservation", () => {
		it("preserves memories across multiple analyze() calls", async () => {
			const capture = { prompts: [] as string[] };
			const planner = createTestPlanner({
				sendJsonCapture: capture,
				sendJsonResult: singleTaskAnalysis("result"),
			});

			// Record 2 executions
			planner.recordExecution("Task A", singleTaskAnalysis("A"), [
				createExecutionResult({ success: true }),
			]);
			planner.recordExecution("Task B", singleTaskAnalysis("B"), [
				createExecutionResult({ success: true }),
			]);

			expect(planner.memoryCount).toBe(2);

			// First analyze
			await planner.analyze("Task C");
			expect(planner.memoryCount).toBe(2); // Memories survive

			// Second analyze
			await planner.analyze("Task D");
			expect(planner.memoryCount).toBe(2); // Still survive

			// Both prompts should contain the same 2 memories
			expect(capture.prompts[0]).toContain("Task A");
			expect(capture.prompts[0]).toContain("Task B");
			expect(capture.prompts[1]).toContain("Task A");
			expect(capture.prompts[1]).toContain("Task B");
		});
	});

	// ── Test 9: recordExecution handles fully failed executions ────────

	describe("failed execution recording", () => {
		it("records correct outcome for a fully failed execution", () => {
			const planner = createTestPlanner();
			const analysis = multiTaskAnalysis();
			const results: AgentExecutionResult[] = [
				createExecutionResult({
					success: false,
					error: "Connection refused",
					subtask: {
						id: "subtask-api",
						prompt: "Build API",
						role: "api-developer",
						dependencies: [],
						priority: 1,
					},
				}),
				createExecutionResult({
					success: false,
					error: "Dependency failed",
					subtask: {
						id: "subtask-tests",
						prompt: "Write tests",
						role: "test-writer",
						dependencies: ["subtask-api"],
						priority: 2,
					},
				}),
			];

			planner.recordExecution("Build API", analysis, results);

			const memory = planner.getMemories()[0]!;
			expect(memory.outcome).toContain("0/2 subtask(s) succeeded");
			expect(memory.outcome).toContain("api-developer: failed");
			expect(memory.outcome).toContain("test-writer: failed");
			expect(memory.lessons).toContain("failed");
			expect(memory.lessons).toContain(
				"Consider alternative decomposition or single-agent",
			);
		});

		it("records correct outcome for a single-agent failure", () => {
			const planner = createTestPlanner();
			const analysis = singleTaskAnalysis("Fix bug");
			const results = [
				createExecutionResult({
					success: false,
					error: "File not found: src/main.ts",
				}),
			];

			planner.recordExecution("Fix bug", analysis, results);

			const memory = planner.getMemories()[0]!;
			expect(memory.outcome).toContain("0/1 subtask(s) succeeded");
			expect(memory.lessons).toContain("Single-agent failed");
			expect(memory.lessons).toContain("File not found");
		});
	});

	// ── Test 10: timeout detection in lessons ──────────────────────────

	describe("timeout detection in lessons", () => {
		it("detects timeout errors and includes them in lessons", () => {
			const planner = createTestPlanner();
			const analysis = multiTaskAnalysis();
			const results: AgentExecutionResult[] = [
				createExecutionResult({
					success: true,
					subtask: {
						id: "subtask-api",
						prompt: "Build API",
						role: "api-developer",
						dependencies: [],
						priority: 1,
					},
				}),
				createExecutionResult({
					success: false,
					error: "Timeout: exceeded 60000ms",
					subtask: {
						id: "subtask-tests",
						prompt: "Write tests",
						role: "test-writer",
						dependencies: ["subtask-api"],
						priority: 2,
					},
				}),
			];

			planner.recordExecution("Build with tests", analysis, results);

			const memory = planner.getMemories()[0]!;
			expect(memory.lessons).toContain("Timeout");
			expect(memory.lessons).toContain("test-writer");
			expect(memory.lessons).toContain("simpler scope");
		});

		it("does NOT mention timeout when failures are not timeouts", () => {
			const planner = createTestPlanner();
			const analysis = singleTaskAnalysis("task");
			const results = [
				createExecutionResult({
					success: false,
					error: "Syntax error in output",
				}),
			];

			planner.recordExecution("task", analysis, results);

			const memory = planner.getMemories()[0]!;
			expect(memory.lessons).not.toContain("Timeout");
		});
	});

	// ── Test 11: filesAffected deduplication and limits ────────────────

	describe("filesAffected deduplication and limits", () => {
		it("deduplicates files across agents", () => {
			const planner = createTestPlanner();
			const analysis = multiTaskAnalysis();
			const results: AgentExecutionResult[] = [
				createExecutionResult({
					success: true,
					filesWritten: ["src/index.ts", "src/utils.ts"],
				}),
				createExecutionResult({
					success: true,
					filesWritten: ["src/index.ts", "src/routes.ts"],
				}),
			];

			planner.recordExecution("task", analysis, results);

			const memory = planner.getMemories()[0]!;
			const indexOccurrences = memory.filesAffected.filter(
				(f) => f === "src/index.ts",
			);
			expect(indexOccurrences).toHaveLength(1);
			expect(memory.filesAffected).toContain("src/utils.ts");
			expect(memory.filesAffected).toContain("src/routes.ts");
		});

		it("limits filesAffected to 15 entries", () => {
			const planner = createTestPlanner();
			const analysis = singleTaskAnalysis("task");

			const manyFiles = Array.from(
				{ length: 25 },
				(_, i) => `src/file-${i}.ts`,
			);
			const results = [
				createExecutionResult({ success: true, filesWritten: manyFiles }),
			];

			planner.recordExecution("task", analysis, results);

			const memory = planner.getMemories()[0]!;
			expect(memory.filesAffected.length).toBeLessThanOrEqual(15);
		});

		it("handles empty filesWritten gracefully", () => {
			const planner = createTestPlanner();
			const analysis = singleTaskAnalysis("task");
			const results = [
				createExecutionResult({ success: true, filesWritten: [] }),
			];

			planner.recordExecution("task", analysis, results);

			const memory = planner.getMemories()[0]!;
			expect(memory.filesAffected).toEqual([]);
		});
	});

	// ── Test 12: memories survive analyze() but not clearMemory() ──────

	describe("memory lifecycle", () => {
		it("memories survive multiple analyze() calls", async () => {
			const planner = createTestPlanner({
				sendJsonResult: singleTaskAnalysis("result"),
			});

			planner.recordExecution("Exec 1", singleTaskAnalysis("t"), [
				createExecutionResult(),
			]);
			planner.recordExecution("Exec 2", singleTaskAnalysis("t"), [
				createExecutionResult(),
			]);

			await planner.analyze("Task A");
			expect(planner.memoryCount).toBe(2);

			await planner.analyze("Task B");
			expect(planner.memoryCount).toBe(2);
		});

		it("clearMemory removes all memories", async () => {
			const capture = { prompts: [] as string[] };
			const planner = createTestPlanner({
				sendJsonCapture: capture,
				sendJsonResult: singleTaskAnalysis("result"),
			});

			planner.recordExecution("Exec 1", singleTaskAnalysis("t"), [
				createExecutionResult(),
			]);
			planner.recordExecution("Exec 2", singleTaskAnalysis("t"), [
				createExecutionResult(),
			]);

			planner.clearMemory();
			expect(planner.memoryCount).toBe(0);

			await planner.analyze("Task C");

			// The prompt should NOT contain Previous Execution Context
			expect(capture.prompts[0]).not.toContain("## Previous Execution Context");
		});
	});

	// ── Test: error message truncation ──────────────────────────────────

	describe("error message handling", () => {
		it("truncates long error messages to 100 chars in outcome", () => {
			const planner = createTestPlanner();
			const longError = "E".repeat(300);
			const analysis = singleTaskAnalysis("task");
			const results = [
				createExecutionResult({ success: false, error: longError }),
			];

			planner.recordExecution("task", analysis, results);

			const memory = planner.getMemories()[0]!;
			// The outcome should contain the truncated error (100 chars)
			expect(memory.outcome).toContain("E".repeat(100));
			expect(memory.outcome).not.toContain("E".repeat(101));
		});

		it("handles undefined error gracefully", () => {
			const planner = createTestPlanner();
			const analysis = singleTaskAnalysis("task");
			const results = [
				createExecutionResult({ success: false, error: undefined }),
			];

			planner.recordExecution("task", analysis, results);

			const memory = planner.getMemories()[0]!;
			expect(memory.outcome).toContain("unknown");
		});
	});

	// ── Test: strategy-specific lessons ─────────────────────────────────

	describe("strategy-specific lessons", () => {
		it("generates appropriate lesson for successful single-agent", () => {
			const planner = createTestPlanner();
			const analysis = singleTaskAnalysis("Fix typo");
			const results = [createExecutionResult({ success: true })];

			planner.recordExecution("Fix typo", analysis, results);

			const memory = planner.getMemories()[0]!;
			expect(memory.lessons).toContain("Single-agent strategy was appropriate");
		});

		it("generates appropriate lesson for successful multi-agent", () => {
			const planner = createTestPlanner();
			const analysis = multiTaskAnalysis();
			const results = [
				createExecutionResult({ success: true }),
				createExecutionResult({ success: true }),
			];

			planner.recordExecution("Build API", analysis, results);

			const memory = planner.getMemories()[0]!;
			expect(memory.lessons).toContain("Multi-agent decomposition worked well");
			expect(memory.lessons).toContain(analysis.complexity);
		});

		it("generates appropriate lesson for partially failed multi-agent", () => {
			const planner = createTestPlanner();
			const analysis = multiTaskAnalysis();
			const results = [
				createExecutionResult({
					success: true,
					subtask: {
						id: "s1",
						prompt: "p1",
						role: "api-developer",
						dependencies: [],
						priority: 1,
					},
				}),
				createExecutionResult({
					success: false,
					error: "compile error",
					subtask: {
						id: "s2",
						prompt: "p2",
						role: "test-writer",
						dependencies: ["s1"],
						priority: 2,
					},
				}),
			];

			planner.recordExecution("Build API", analysis, results);

			const memory = planner.getMemories()[0]!;
			expect(memory.lessons).toContain("test-writer failed");
			expect(memory.lessons).toContain("Consider alternative decomposition");
		});
	});

	// ── Test: getMemories returns a read-only view ──────────────────────

	describe("getMemories", () => {
		it("returns the memories in chronological order", () => {
			const planner = createTestPlanner();
			const analysis = singleTaskAnalysis("task");

			planner.recordExecution("Alpha", analysis, [createExecutionResult()]);
			planner.recordExecution("Beta", analysis, [createExecutionResult()]);

			const memories = planner.getMemories();
			expect(memories[0]!.task).toBe("Alpha");
			expect(memories[1]!.task).toBe("Beta");
		});

		it("returns an empty array when no memories exist", () => {
			const planner = createTestPlanner();
			expect(planner.getMemories()).toEqual([]);
		});
	});

	// ── Test: memoryCount getter ────────────────────────────────────────

	describe("memoryCount", () => {
		it("returns 0 for a fresh planner", () => {
			const planner = createTestPlanner();
			expect(planner.memoryCount).toBe(0);
		});

		it("increments as executions are recorded", () => {
			const planner = createTestPlanner();
			const analysis = singleTaskAnalysis("task");

			planner.recordExecution("A", analysis, [createExecutionResult()]);
			expect(planner.memoryCount).toBe(1);

			planner.recordExecution("B", analysis, [createExecutionResult()]);
			expect(planner.memoryCount).toBe(2);

			planner.recordExecution("C", analysis, [createExecutionResult()]);
			expect(planner.memoryCount).toBe(3);

			// 4th should evict oldest, keeping count at 3
			planner.recordExecution("D", analysis, [createExecutionResult()]);
			expect(planner.memoryCount).toBe(3);
		});

		it("returns 0 after clearMemory()", () => {
			const planner = createTestPlanner();
			const analysis = singleTaskAnalysis("task");

			planner.recordExecution("A", analysis, [createExecutionResult()]);
			planner.recordExecution("B", analysis, [createExecutionResult()]);
			expect(planner.memoryCount).toBe(2);

			planner.clearMemory();
			expect(planner.memoryCount).toBe(0);
		});
	});

	// ── Test: memory context has correct formatting ─────────────────────

	describe("memory context formatting", () => {
		it("includes files section only when files exist", async () => {
			const capture = { prompts: [] as string[] };
			const planner = createTestPlanner({
				sendJsonCapture: capture,
				sendJsonResult: singleTaskAnalysis("result"),
			});

			// Record execution with files
			planner.recordExecution("With files", singleTaskAnalysis("t"), [
				createExecutionResult({
					success: true,
					filesWritten: ["src/app.ts"],
				}),
			]);

			await planner.analyze("Next task");

			expect(capture.prompts[0]).toContain("**Files**: src/app.ts");
		});

		it("omits files section when no files were written", async () => {
			const capture = { prompts: [] as string[] };
			const planner = createTestPlanner({
				sendJsonCapture: capture,
				sendJsonResult: singleTaskAnalysis("result"),
			});

			planner.recordExecution("No files", singleTaskAnalysis("t"), [
				createExecutionResult({ success: true, filesWritten: [] }),
			]);

			await planner.analyze("Next task");

			expect(capture.prompts[0]).not.toContain("**Files**:");
		});

		it("truncates file list display to 10 with (+N more) indicator", async () => {
			const capture = { prompts: [] as string[] };
			const planner = createTestPlanner({
				sendJsonCapture: capture,
				sendJsonResult: singleTaskAnalysis("result"),
			});

			const files = Array.from({ length: 14 }, (_, i) => `src/file-${i}.ts`);
			planner.recordExecution("Many files", singleTaskAnalysis("t"), [
				createExecutionResult({ success: true, filesWritten: files }),
			]);

			await planner.analyze("Next task");

			const prompt = capture.prompts[0]!;
			expect(prompt).toContain("(+4 more)");
		});
	});

	// ── Test: prompt ordering ──────────────────────────────────────────

	describe("prompt section ordering", () => {
		it("places Previous Execution Context after Task and before Context/Project Context", async () => {
			const capture = { prompts: [] as string[] };
			const planner = createTestPlanner({
				sendJsonCapture: capture,
				sendJsonResult: singleTaskAnalysis("result"),
			});

			planner.recordExecution("Previous", singleTaskAnalysis("t"), [
				createExecutionResult(),
			]);

			await planner.analyze("Current task", "Some context hints");

			const prompt = capture.prompts[0]!;
			const taskIndex = prompt.indexOf("## Task");
			const memoryIndex = prompt.indexOf("## Previous Execution Context");
			const contextIndex = prompt.indexOf("## Context");

			expect(taskIndex).toBeGreaterThan(-1);
			expect(memoryIndex).toBeGreaterThan(-1);
			expect(contextIndex).toBeGreaterThan(-1);

			// Task < Previous Execution Context < Context
			expect(taskIndex).toBeLessThan(memoryIndex);
			expect(memoryIndex).toBeLessThan(contextIndex);
		});
	});

	// ── Test: PlannerMemory type structure ──────────────────────────────

	describe("PlannerMemory type compliance", () => {
		it("produces a memory conforming to the PlannerMemory interface", () => {
			const planner = createTestPlanner();
			const analysis = singleTaskAnalysis("type check");
			const results = [
				createExecutionResult({
					success: true,
					filesWritten: ["a.ts"],
				}),
			];

			planner.recordExecution("type check", analysis, results);

			const memory: PlannerMemory = planner.getMemories()[0]!;

			// Verify all required fields exist and have correct types
			expect(typeof memory.task).toBe("string");
			expect(typeof memory.strategy).toBe("string");
			expect(Array.isArray(memory.roles)).toBe(true);
			expect(typeof memory.outcome).toBe("string");
			expect(Array.isArray(memory.filesAffected)).toBe(true);
			expect(typeof memory.lessons).toBe("string");
			expect(typeof memory.timestamp).toBe("string");

			// Verify enum value
			expect(
				[ExecutionStrategy.SINGLE, ExecutionStrategy.MULTI].includes(
					memory.strategy,
				),
			).toBe(true);
		});
	});

	// ── Test: empty results array ──────────────────────────────────────

	describe("edge cases", () => {
		it("handles empty results array", () => {
			const planner = createTestPlanner();
			const analysis = singleTaskAnalysis("task");

			planner.recordExecution("empty", analysis, []);

			const memory = planner.getMemories()[0]!;
			expect(memory.outcome).toContain("0/0 subtask(s) succeeded");
			expect(memory.filesAffected).toEqual([]);
		});

		it("handles a single result with multiple file writes including duplicates", () => {
			const planner = createTestPlanner();
			const analysis = singleTaskAnalysis("task");
			const results = [
				createExecutionResult({
					success: true,
					filesWritten: ["a.ts", "b.ts", "a.ts", "c.ts", "b.ts"],
				}),
			];

			planner.recordExecution("task", analysis, results);

			const memory = planner.getMemories()[0]!;
			expect(memory.filesAffected).toEqual(["a.ts", "b.ts", "c.ts"]);
		});
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Planning System Prompt Tests
// ════════════════════════════════════════════════════════════════════════════

describe("Planning System Prompt — Previous Execution Memory section", () => {
	it("system prompt includes Previous Execution Memory guidance", async () => {
		// Import the compiled template and render it
		const { planningSystemPrompt } = await import(
			"../../../prompts/planning.ts"
		);
		const rendered = planningSystemPrompt({});

		expect(rendered).toContain("## Previous Execution Memory");
		expect(rendered).toContain(
			"Do NOT re-plan work that was already completed successfully",
		);
		expect(rendered).toContain(
			"Maintain consistency with previous architectural decisions",
		);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Task Analysis Template Tests
// ════════════════════════════════════════════════════════════════════════════

describe("Task Analysis Template — previousExecutions parameter", () => {
	it("renders without Previous Execution Context when previousExecutions is null", async () => {
		const { taskAnalysisPrompt } = await import("../../../prompts/planning.ts");

		const rendered = taskAnalysisPrompt({
			task: "Build something",
			contextHints: null,
			constraints: null,
			projectContext: null,
			previousExecutions: null,
		});

		expect(rendered).not.toContain("## Previous Execution Context");
		expect(rendered).toContain("## Task");
		expect(rendered).toContain("Build something");
	});

	it("renders Previous Execution Context when previousExecutions is provided", async () => {
		const { taskAnalysisPrompt } = await import("../../../prompts/planning.ts");

		const memoryText = [
			"### Execution 1 (2024-01-01T00:00:00.000Z)",
			"- **Task**: Build API",
			"- **Strategy**: multi (api-dev, test-writer)",
			"- **Outcome**: 2/2 succeeded",
			"- **Lessons**: Multi-agent worked well.",
		].join("\n");

		const rendered = taskAnalysisPrompt({
			task: "Add auth",
			contextHints: null,
			constraints: null,
			projectContext: null,
			previousExecutions: memoryText,
		});

		expect(rendered).toContain("## Previous Execution Context");
		expect(rendered).toContain("### Execution 1");
		expect(rendered).toContain("Build API");
		expect(rendered).toContain(
			"Avoid re-doing work that was already completed successfully",
		);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Integration-style Tests — AgentPool ↔ TaskPlanner memory interaction
// ════════════════════════════════════════════════════════════════════════════

describe("AgentPool — planner memory integration", () => {
	// ── Test 13: execute() calls recordExecution() after successful execution ──

	it("Test 13: execute() calls recordExecution on the planner after a successful execution", async () => {
		const pool = new AgentPool(
			silentPoolConfig({
				createAgent: createMockAgentFactory(),
			}),
		);

		const planner = (pool as any).planner as TaskPlanner;
		const conversations = (pool as any).conversations;

		// Skip model validation — no real API key
		conversations.client._modelValidated = Promise.resolve();

		// Before execution, no memories
		expect(planner.memoryCount).toBe(0);

		// Stub the planner's analyze to return a single-agent analysis.
		// Single-agent summary is generated without LLM, so no extra mocking needed.
		planner.analyze = async () => singleTaskAnalysis("Test task");

		const result = await pool.execute("Test task");

		// After execution, planner should have a memory recorded
		expect(planner.memoryCount).toBe(1);

		const memories = planner.getMemories();
		expect(memories[0]!.task).toBe("Test task");
		expect(memories[0]!.strategy).toBe(ExecutionStrategy.SINGLE);

		// The result should also be valid
		expect(result.strategy).toBe(ExecutionStrategy.SINGLE);

		await pool.destroy();
	});

	// ── Test 14: execute() does NOT call recordExecution on fatal error ──

	it("Test 14: execute() does NOT call recordExecution when analyze() throws", async () => {
		const pool = new AgentPool(
			silentPoolConfig({
				createAgent: createMockAgentFactory(),
			}),
		);

		const planner = (pool as any).planner as TaskPlanner;
		const conversations = (pool as any).conversations;

		// Skip model validation — no real API key
		conversations.client._modelValidated = Promise.resolve();

		// Force analyze to throw a fatal error
		planner.analyze = async () => {
			throw new Error("Fatal planner error");
		};

		try {
			await pool.execute("Failing task");
		} catch {
			// Expected to throw
		}

		// No memory should have been recorded
		expect(planner.memoryCount).toBe(0);

		await pool.destroy();
	});

	// ── Test 16: pool.destroy() clears planner memory ──

	it("Test 16: pool.destroy() clears the planner memory", async () => {
		const pool = new AgentPool(
			silentPoolConfig({
				createAgent: createMockAgentFactory(),
			}),
		);

		const planner = (pool as any).planner as TaskPlanner;

		// Manually record some memories
		planner.recordExecution("Task A", singleTaskAnalysis("A"), [
			createExecutionResult({ success: true }),
		]);
		planner.recordExecution("Task B", singleTaskAnalysis("B"), [
			createExecutionResult({ success: true }),
		]);
		expect(planner.memoryCount).toBe(2);

		await pool.destroy();

		expect(planner.memoryCount).toBe(0);
		expect(planner.getMemories()).toEqual([]);
	});

	// ── Test 17: pool.getState() includes plannerMemoryCount ──

	it("Test 17: pool.getState() includes plannerMemoryCount", () => {
		const pool = new AgentPool(
			silentPoolConfig({
				createAgent: createMockAgentFactory(),
			}),
		);

		const planner = (pool as any).planner as TaskPlanner;

		// Initial state
		expect(pool.getState().plannerMemoryCount).toBe(0);

		// Record a memory
		planner.recordExecution("Task X", singleTaskAnalysis("X"), [
			createExecutionResult({ success: true }),
		]);

		expect(pool.getState().plannerMemoryCount).toBe(1);

		// Record another
		planner.recordExecution("Task Y", singleTaskAnalysis("Y"), [
			createExecutionResult({ success: true }),
		]);

		expect(pool.getState().plannerMemoryCount).toBe(2);

		pool.destroy();
	});

	// ── Test 18: pool.clearPlannerMemory() works ──

	it("Test 18: pool.clearPlannerMemory() clears all memories", () => {
		const pool = new AgentPool(
			silentPoolConfig({
				createAgent: createMockAgentFactory(),
			}),
		);

		const planner = (pool as any).planner as TaskPlanner;

		// Record some memories
		planner.recordExecution("Task 1", singleTaskAnalysis("1"), [
			createExecutionResult({ success: true }),
		]);
		planner.recordExecution("Task 2", singleTaskAnalysis("2"), [
			createExecutionResult({ success: true }),
		]);
		expect(pool.getState().plannerMemoryCount).toBe(2);

		// Clear via public API
		pool.clearPlannerMemory();

		expect(pool.getState().plannerMemoryCount).toBe(0);
		expect(planner.getMemories()).toEqual([]);

		pool.destroy();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Non-regression Tests
// ════════════════════════════════════════════════════════════════════════════

describe("Non-regression — planner memory", () => {
	// ── Test 19: conversation is always reset at each analyze() ──

	it("Test 19: conversations.reset() is called at each analyze() even with memories", async () => {
		let resetCallCount = 0;
		const capture = { prompts: [] as string[] };

		const conversations = {
			has: () => true,
			register: () => {},
			reset: () => {
				resetCallCount++;
			},
			client: {
				sanitize: (text: string) => text,
			},
			sendJson: async (_role: unknown, prompt: string) => {
				capture.prompts.push(prompt);
				return singleTaskAnalysis("result");
			},
		} as any;

		const planner = new TaskPlanner(conversations, silentLogger());

		// Record a memory
		planner.recordExecution("Previous", singleTaskAnalysis("prev"), [
			createExecutionResult({ success: true }),
		]);

		// Reset count includes the initial registration — capture baseline
		const baselineResetCount = resetCallCount;

		// First analyze
		await planner.analyze("Task A");
		expect(resetCallCount).toBe(baselineResetCount + 1);

		// Second analyze
		await planner.analyze("Task B");
		expect(resetCallCount).toBe(baselineResetCount + 2);

		// Memories should still be intact despite resets
		expect(planner.memoryCount).toBe(1);
	});

	// ── Test 21: semantic retries in analyze() work with memories ──

	it("Test 21: semantic retry loop works correctly when memories are present", async () => {
		let callCount = 0;
		const capture = { prompts: [] as string[] };

		// First call returns an analysis with a semantic error (circular dependency)
		// Second call returns a valid analysis
		const badAnalysis: TaskAnalysis = {
			strategy: ExecutionStrategy.MULTI,
			complexity: TaskComplexity.COMPLEX,
			reasoning: "Split into two tasks",
			subtasks: [
				{
					id: "task-a",
					prompt: "Do A",
					role: "role-a",
					dependencies: ["task-b"], // circular!
					priority: 1,
				},
				{
					id: "task-b",
					prompt: "Do B",
					role: "role-b",
					dependencies: ["task-a"], // circular!
					priority: 2,
				},
			],
			dependencies: [
				{ from: "task-a", to: "task-b", type: "blocking" },
				{ from: "task-b", to: "task-a", type: "blocking" },
			],
			parallelismBenefit: 0.5,
		};

		const goodAnalysis: TaskAnalysis = {
			strategy: ExecutionStrategy.MULTI,
			complexity: TaskComplexity.COMPLEX,
			reasoning: "Split into two tasks (fixed)",
			subtasks: [
				{
					id: "task-a",
					prompt: "Do A",
					role: "role-a",
					dependencies: [],
					priority: 1,
				},
				{
					id: "task-b",
					prompt: "Do B",
					role: "role-b",
					dependencies: ["task-a"],
					priority: 2,
				},
			],
			dependencies: [{ from: "task-a", to: "task-b", type: "blocking" }],
			parallelismBenefit: 0.5,
		};

		const conversations = {
			has: () => true,
			register: () => {},
			reset: () => {},
			client: {
				sanitize: (text: string) => text,
			},
			sendJson: async (_role: unknown, prompt: string) => {
				capture.prompts.push(prompt);
				callCount++;
				// First call returns bad analysis, second returns good
				return callCount === 1 ? badAnalysis : goodAnalysis;
			},
		} as any;

		const planner = new TaskPlanner(conversations, silentLogger());

		// Record a memory before analyzing
		planner.recordExecution("Previous task", singleTaskAnalysis("prev"), [
			createExecutionResult({ success: true, filesWritten: ["src/prev.ts"] }),
		]);

		// Analyze should succeed after retry
		const result = await planner.analyze("New task with retry");

		// Should have called sendJson at least twice (initial + retry)
		expect(callCount).toBeGreaterThanOrEqual(2);

		// The result should be the good analysis
		expect(result.subtasks).toHaveLength(2);
		expect(result.dependencies).toHaveLength(1);

		// The correction prompt (2nd call) should include the original prompt
		// which contains the memory context
		const correctionPrompt = capture.prompts[1]!;
		expect(correctionPrompt).toContain("Previous Execution Context");
		expect(correctionPrompt).toContain("Previous task");
		expect(correctionPrompt).toContain("src/prev.ts");

		// Memories should be unaffected by the retry loop
		expect(planner.memoryCount).toBe(1);
	});

	// ── Test 20: planner works identically without memories (first call) ──

	it("Test 20: first analyze() without memories behaves identically to pre-evolution", async () => {
		const capture = { prompts: [] as string[] };
		const planner = createTestPlanner({
			sendJsonCapture: capture,
			sendJsonResult: singleTaskAnalysis("result"),
		});

		// No recordExecution calls — this is a brand new planner

		const result = await planner.analyze("Build API");

		// Should have produced a valid analysis
		expect(result.strategy).toBe(ExecutionStrategy.SINGLE);
		expect(result.subtasks).toHaveLength(1);

		// Prompt should NOT contain any memory section
		expect(capture.prompts[0]).not.toContain("## Previous Execution Context");
		expect(capture.prompts[0]).not.toContain("### Execution");

		// Should still contain the standard sections
		expect(capture.prompts[0]).toContain("## Task");
		expect(capture.prompts[0]).toContain("Build API");

		// Memory count should be 0
		expect(planner.memoryCount).toBe(0);
	});
});
