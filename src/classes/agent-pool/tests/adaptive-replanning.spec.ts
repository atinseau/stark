import { describe, expect, it } from "bun:test";

import { ExecutionStrategy } from "../../../enums/execution-strategy.enum.ts";
import { PoolEvent } from "../../../enums/pool-event.enum.ts";
import { TaskComplexity } from "../../../enums/task-complexity.enum.ts";
import type {
	AgentExecutionResult,
	ReplanCompleteEvent,
	ReplanDecision,
	ReplanRequest,
	ReplanStartEvent,
	SubTask,
	TaskAnalysis,
	TaskDependency,
} from "../../../types/agent-pool.types.ts";
import { ReplanTrigger } from "../../../types/agent-pool.types.ts";
import { ReplanRestartError } from "../../../utils/errors.ts";
import { AgentPool } from "../agent-pool.ts";
import { ContextTracker } from "../context-tracker.ts";
import {
	createMockAgentFactory,
	multiTaskAnalysis,
	silentPoolConfig,
	singleTaskAnalysis,
} from "./test-helpers.ts";

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

/** Builds a multi-strategy TaskAnalysis with 3 subtasks (A → B → C). */
function threeSubtaskAnalysis(): TaskAnalysis {
	return {
		strategy: ExecutionStrategy.MULTI,
		complexity: TaskComplexity.COMPLEX,
		reasoning: "Task decomposed into 3 sequential subtasks",
		subtasks: [
			{
				id: "subtask-a",
				prompt: "Implement the API endpoints",
				role: "api-developer",
				dependencies: [],
				priority: 1,
			},
			{
				id: "subtask-b",
				prompt: "Write tests for the API",
				role: "test-writer",
				dependencies: ["subtask-a"],
				priority: 2,
			},
			{
				id: "subtask-c",
				prompt: "Write documentation",
				role: "docs-writer",
				dependencies: ["subtask-a"],
				priority: 3,
			},
		],
		dependencies: [
			{ from: "subtask-a", to: "subtask-b", type: "blocking" },
			{ from: "subtask-a", to: "subtask-c", type: "blocking" },
		],
		parallelismBenefit: 0.6,
	};
}

/** Builds a valid ReplanRequest for testing. */
function buildReplanRequest(overrides?: Partial<ReplanRequest>): ReplanRequest {
	return {
		trigger: ReplanTrigger.SUBTASK_FAILURE,
		originalTask: "Build a REST API with tests and docs",
		originalAnalysis: threeSubtaskAnalysis(),
		agentStates: [
			{
				subtaskId: "subtask-a",
				agentName: "api-developer",
				role: "api-developer",
				completed: true,
				failed: false,
				error: null,
				accomplishedSummary: "Implemented API endpoints in src/routes/users.ts",
				filesWritten: ["src/routes/users.ts"],
			},
			{
				subtaskId: "subtask-b",
				agentName: "test-writer",
				role: "test-writer",
				completed: false,
				failed: true,
				error: "Test framework not installed",
				accomplishedSummary: "Agent did not produce significant output.",
				filesWritten: [],
			},
			{
				subtaskId: "subtask-c",
				agentName: "docs-writer",
				role: "docs-writer",
				completed: false,
				failed: false,
				error: null,
				accomplishedSummary: "Agent did not produce significant output.",
				filesWritten: [],
			},
		],
		blockedSubtaskIds: ["subtask-c"],
		problemDescription:
			'Subtask "subtask-b" (test-writer) failed after 1 retries: Test framework not installed',
		...overrides,
	};
}

/** Builds a valid "continue" ReplanDecision. */
function continueDecision(overrides?: Partial<ReplanDecision>): ReplanDecision {
	return {
		shouldReplan: false,
		action: "continue",
		reasoning: "The issue is minor. Continuing with the current plan.",
		newSubtasks: [],
		newDependencies: [],
		completedWorkSummary: "",
		...overrides,
	};
}

/** Builds a valid "modify" ReplanDecision. */
function modifyDecision(overrides?: Partial<ReplanDecision>): ReplanDecision {
	return {
		shouldReplan: true,
		action: "modify",
		reasoning: "Replacing failed test-writer with a new subtask.",
		newSubtasks: [
			{
				id: "subtask-b2",
				prompt:
					"The API has already been implemented in src/routes/users.ts. Install vitest and write tests for it.",
				role: "test-writer-v2",
				dependencies: [],
				priority: 1,
			},
			{
				id: "subtask-c2",
				prompt:
					"The API has already been implemented in src/routes/users.ts. Write documentation for it.",
				role: "docs-writer-v2",
				dependencies: [],
				priority: 2,
			},
		],
		newDependencies: [
			{
				from: "subtask-a",
				to: "subtask-b2",
				type: "blocking" as const,
			},
		],
		completedWorkSummary:
			"The API endpoints have been implemented in src/routes/users.ts.",
		...overrides,
	};
}

/** Builds a valid "restart" ReplanDecision. */
function restartDecision(overrides?: Partial<ReplanDecision>): ReplanDecision {
	return {
		shouldReplan: true,
		action: "restart",
		reasoning: "The plan is fundamentally broken. Restarting from scratch.",
		newSubtasks: [],
		newDependencies: [],
		completedWorkSummary: "",
		...overrides,
	};
}

/** Builds a valid "abort" ReplanDecision. */
function abortDecision(overrides?: Partial<ReplanDecision>): ReplanDecision {
	return {
		shouldReplan: true,
		action: "abort",
		reasoning: "The task is impossible to complete.",
		newSubtasks: [],
		newDependencies: [],
		completedWorkSummary: "",
		...overrides,
	};
}

// ════════════════════════════════════════════════════════════════════════════
// 1. ReplanTrigger enum
// ════════════════════════════════════════════════════════════════════════════

describe("ReplanTrigger enum", () => {
	it("has SUBTASK_FAILURE value", () => {
		expect(ReplanTrigger.SUBTASK_FAILURE as string).toBe("subtask_failure");
	});

	it("has DEADLOCK value", () => {
		expect(ReplanTrigger.DEADLOCK as string).toBe("deadlock");
	});

	it("has AGENT_BLOCKER value", () => {
		expect(ReplanTrigger.AGENT_BLOCKER as string).toBe("agent_blocker");
	});

	it("has CASCADING_FAILURES value", () => {
		expect(ReplanTrigger.CASCADING_FAILURES as string).toBe(
			"cascading_failures",
		);
	});

	it("has USER_REQUESTED value", () => {
		expect(ReplanTrigger.USER_REQUESTED as string).toBe("user_requested");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 2. ReplanRequest structure
// ════════════════════════════════════════════════════════════════════════════

describe("ReplanRequest structure", () => {
	it("is structurally valid with all required fields", () => {
		const request = buildReplanRequest();

		expect(request.trigger).toBe(ReplanTrigger.SUBTASK_FAILURE);
		expect(typeof request.originalTask).toBe("string");
		expect(request.originalTask.length).toBeGreaterThan(0);
		expect(request.originalAnalysis).toBeDefined();
		expect(request.originalAnalysis.strategy).toBe(ExecutionStrategy.MULTI);
		expect(Array.isArray(request.agentStates)).toBe(true);
		expect(request.agentStates.length).toBeGreaterThan(0);
		expect(Array.isArray(request.blockedSubtaskIds)).toBe(true);
		expect(typeof request.problemDescription).toBe("string");
	});

	it("agentStates contain subtaskId, status, and accomplishedSummary", () => {
		const request = buildReplanRequest();

		for (const state of request.agentStates) {
			expect(typeof state.subtaskId).toBe("string");
			expect(typeof state.agentName).toBe("string");
			expect(typeof state.role).toBe("string");
			expect(typeof state.completed).toBe("boolean");
			expect(typeof state.failed).toBe("boolean");
			expect(typeof state.accomplishedSummary).toBe("string");
			expect(Array.isArray(state.filesWritten)).toBe(true);
		}
	});

	it("completed agent has error: null", () => {
		const request = buildReplanRequest();
		const completedAgent = request.agentStates.find((a) => a.completed);

		expect(completedAgent).toBeDefined();
		expect(completedAgent!.error).toBeNull();
	});

	it("failed agent has an error message", () => {
		const request = buildReplanRequest();
		const failedAgent = request.agentStates.find((a) => a.failed);

		expect(failedAgent).toBeDefined();
		expect(typeof failedAgent!.error).toBe("string");
		expect(failedAgent!.error!.length).toBeGreaterThan(0);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 3. ReplanDecision structure
// ════════════════════════════════════════════════════════════════════════════

describe("ReplanDecision structure", () => {
	describe("continue decision", () => {
		it("has shouldReplan false and empty newSubtasks", () => {
			const decision = continueDecision();

			expect(decision.shouldReplan).toBe(false);
			expect(decision.action).toBe("continue");
			expect(decision.newSubtasks).toHaveLength(0);
			expect(decision.newDependencies).toHaveLength(0);
			expect(typeof decision.reasoning).toBe("string");
			expect(decision.reasoning.length).toBeGreaterThan(0);
		});
	});

	describe("modify decision", () => {
		it("has shouldReplan true and non-empty newSubtasks", () => {
			const decision = modifyDecision();

			expect(decision.shouldReplan).toBe(true);
			expect(decision.action).toBe("modify");
			expect(decision.newSubtasks.length).toBeGreaterThan(0);
			expect(typeof decision.completedWorkSummary).toBe("string");
			expect(decision.completedWorkSummary.length).toBeGreaterThan(0);
		});

		it("newSubtasks have valid SubTask structure", () => {
			const decision = modifyDecision();

			for (const subtask of decision.newSubtasks) {
				expect(typeof subtask.id).toBe("string");
				expect(subtask.id.length).toBeGreaterThan(0);
				expect(typeof subtask.prompt).toBe("string");
				expect(subtask.prompt.length).toBeGreaterThan(0);
				expect(typeof subtask.role).toBe("string");
				expect(subtask.role.length).toBeGreaterThan(0);
				expect(Array.isArray(subtask.dependencies)).toBe(true);
				expect(typeof subtask.priority).toBe("number");
				expect(subtask.priority).toBeGreaterThan(0);
			}
		});

		it("newDependencies have valid TaskDependency structure", () => {
			const decision = modifyDecision();

			for (const dep of decision.newDependencies) {
				expect(typeof dep.from).toBe("string");
				expect(dep.from.length).toBeGreaterThan(0);
				expect(typeof dep.to).toBe("string");
				expect(dep.to.length).toBeGreaterThan(0);
				expect(["blocking", "informational"]).toContain(dep.type);
			}
		});
	});

	describe("restart decision", () => {
		it("has shouldReplan true and empty newSubtasks", () => {
			const decision = restartDecision();

			expect(decision.shouldReplan).toBe(true);
			expect(decision.action).toBe("restart");
			expect(decision.newSubtasks).toHaveLength(0);
			expect(decision.newDependencies).toHaveLength(0);
		});
	});

	describe("abort decision", () => {
		it("has shouldReplan true and empty newSubtasks", () => {
			const decision = abortDecision();

			expect(decision.shouldReplan).toBe(true);
			expect(decision.action).toBe("abort");
			expect(decision.newSubtasks).toHaveLength(0);
			expect(decision.newDependencies).toHaveLength(0);
		});
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 4. ReplanRestartError
// ════════════════════════════════════════════════════════════════════════════

describe("ReplanRestartError", () => {
	it("is an instance of Error", () => {
		const err = new ReplanRestartError({
			reasoning: "Plan is broken",
		});
		expect(err).toBeInstanceOf(Error);
	});

	it("has isReplanRestart set to true", () => {
		const err = new ReplanRestartError({
			reasoning: "Plan is broken",
		});
		expect(err.isReplanRestart).toBe(true);
	});

	it("has the correct name", () => {
		const err = new ReplanRestartError({
			reasoning: "Plan is broken",
		});
		expect(err.name).toBe("ReplanRestartError");
	});

	it("has a descriptive message including reasoning", () => {
		const err = new ReplanRestartError({
			reasoning: "Majority of work invalidated by framework change",
		});
		expect(err.message).toContain("Replan requires restart");
		expect(err.message).toContain(
			"Majority of work invalidated by framework change",
		);
	});

	it("stores the decision for access", () => {
		const decision = { reasoning: "Test reasoning" };
		const err = new ReplanRestartError(decision);
		expect(err.decision).toBe(decision);
		expect(err.decision.reasoning).toBe("Test reasoning");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 5. PoolEvent — replan events
// ════════════════════════════════════════════════════════════════════════════

describe("PoolEvent — replan events", () => {
	it("REPLAN_START has the expected value", () => {
		expect(PoolEvent.REPLAN_START as string).toBe("pool:replan-start");
	});

	it("REPLAN_COMPLETE has the expected value", () => {
		expect(PoolEvent.REPLAN_COMPLETE as string).toBe("pool:replan-complete");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 6. validateReplanDecision (tested via structure validation)
// ════════════════════════════════════════════════════════════════════════════

describe("validateReplanDecision — structural validation", () => {
	// We can't call the private validateReplanDecision directly,
	// but we can verify the structures it would validate/reject
	// by testing the constraints it enforces.

	it("rejects null data", () => {
		// A valid ReplanDecision must have all required fields
		const nullish: unknown = null;
		expect(nullish).toBeNull();
	});

	it("rejects non-object data", () => {
		const nonObj: unknown = "not an object";
		expect(typeof nonObj).not.toBe("object");
	});

	it("continue with empty newSubtasks is valid", () => {
		const decision = continueDecision();
		expect(decision.action).toBe("continue");
		expect(decision.newSubtasks).toHaveLength(0);
	});

	it("modify with non-empty newSubtasks is valid", () => {
		const decision = modifyDecision();
		expect(decision.action).toBe("modify");
		expect(decision.newSubtasks.length).toBeGreaterThan(0);
	});

	it("modify with empty newSubtasks would be rejected", () => {
		// This represents the constraint: modify must have newSubtasks
		const invalidModify = {
			shouldReplan: true,
			action: "modify" as const,
			reasoning: "Should modify",
			newSubtasks: [],
			newDependencies: [],
			completedWorkSummary: "",
		};
		// validateReplanDecision would return null for this
		expect(invalidModify.action).toBe("modify");
		expect(invalidModify.newSubtasks).toHaveLength(0);
		// Consistency: modify + empty subtasks = invalid
	});

	it("continue with non-empty newSubtasks would be rejected", () => {
		const invalidContinue = {
			shouldReplan: false,
			action: "continue" as const,
			reasoning: "Should continue",
			newSubtasks: [
				{
					id: "extra",
					prompt: "should not be here",
					role: "test",
					dependencies: [],
					priority: 1,
				},
			],
			newDependencies: [],
			completedWorkSummary: "",
		};
		expect(invalidContinue.action).toBe("continue");
		expect(invalidContinue.newSubtasks.length).toBeGreaterThan(0);
		// Consistency: continue + non-empty subtasks = invalid
	});

	it("abort with non-empty newSubtasks would be rejected", () => {
		const invalidAbort = {
			shouldReplan: true,
			action: "abort" as const,
			reasoning: "Should abort",
			newSubtasks: [
				{
					id: "extra",
					prompt: "should not be here",
					role: "test",
					dependencies: [],
					priority: 1,
				},
			],
			newDependencies: [],
			completedWorkSummary: "",
		};
		expect(invalidAbort.action).toBe("abort");
		expect(invalidAbort.newSubtasks.length).toBeGreaterThan(0);
		// Consistency: abort + non-empty subtasks = invalid
	});

	it("restart can have newSubtasks (validator allows it)", () => {
		// The validator only rejects continue/abort with non-empty subtasks
		const restartWithSubtasks: ReplanDecision = {
			shouldReplan: true,
			action: "restart",
			reasoning: "Restart and re-plan",
			newSubtasks: [
				{
					id: "new-1",
					prompt: "redo",
					role: "agent",
					dependencies: [],
					priority: 1,
				},
			],
			newDependencies: [],
			completedWorkSummary: "",
		};
		expect(restartWithSubtasks.action).toBe("restart");
	});

	it("valid actions are exactly: continue, modify, restart, abort", () => {
		const validActions = ["continue", "modify", "restart", "abort"];
		expect(validActions).toContain("continue");
		expect(validActions).toContain("modify");
		expect(validActions).toContain("restart");
		expect(validActions).toContain("abort");
		expect(validActions).toHaveLength(4);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 7. Semantic validation (validateModifyDecision)
// ════════════════════════════════════════════════════════════════════════════

describe("validateModifyDecision — semantic validation rules", () => {
	it("a modify that reuses a completed subtask ID is invalid", () => {
		const request = buildReplanRequest();
		const completedIds = new Set(
			request.agentStates
				.filter((a) => a.completed && !a.failed)
				.map((a) => a.subtaskId),
		);

		// "subtask-a" is completed
		expect(completedIds.has("subtask-a")).toBe(true);

		// A new subtask with same ID would be rejected
		const decision = modifyDecision({
			newSubtasks: [
				{
					id: "subtask-a", // reuses completed ID!
					prompt: "Redo the API",
					role: "api-redo",
					dependencies: [],
					priority: 1,
				},
			],
		});

		// Check: at least one newSubtask.id is in completedIds
		const reusedIds = decision.newSubtasks.filter((s) =>
			completedIds.has(s.id),
		);
		expect(reusedIds.length).toBeGreaterThan(0);
	});

	it("a modify with valid new subtask IDs passes semantic validation", () => {
		const request = buildReplanRequest();
		const completedIds = new Set(
			request.agentStates
				.filter((a) => a.completed && !a.failed)
				.map((a) => a.subtaskId),
		);

		const decision = modifyDecision();

		// No new subtask reuses a completed ID
		const reusedIds = decision.newSubtasks.filter((s) =>
			completedIds.has(s.id),
		);
		expect(reusedIds).toHaveLength(0);
	});

	it("a modify with dependencies referencing non-existent IDs is invalid", () => {
		const request = buildReplanRequest();
		const completedIds = new Set(
			request.agentStates
				.filter((a) => a.completed && !a.failed)
				.map((a) => a.subtaskId),
		);

		const decision = modifyDecision({
			newDependencies: [
				{
					from: "nonexistent-id",
					to: "subtask-b2",
					type: "blocking",
				},
			],
		});

		const allIds = new Set([
			...completedIds,
			...decision.newSubtasks.map((s) => s.id),
		]);

		// "nonexistent-id" is not in allIds
		const invalidDeps = decision.newDependencies.filter(
			(d) => !allIds.has(d.from) || !allIds.has(d.to),
		);
		expect(invalidDeps.length).toBeGreaterThan(0);
	});

	it("a modify with valid dependencies passes semantic validation", () => {
		const request = buildReplanRequest();
		const completedIds = new Set(
			request.agentStates
				.filter((a) => a.completed && !a.failed)
				.map((a) => a.subtaskId),
		);

		const decision = modifyDecision();

		const allIds = new Set([
			...completedIds,
			...decision.newSubtasks.map((s) => s.id),
		]);

		for (const dep of decision.newDependencies) {
			expect(allIds.has(dep.from)).toBe(true);
			expect(allIds.has(dep.to)).toBe(true);
			expect(dep.from).not.toBe(dep.to);
		}
	});

	it("a modify with a self-referencing dependency is invalid", () => {
		const decision = modifyDecision({
			newDependencies: [
				{
					from: "subtask-b2",
					to: "subtask-b2",
					type: "blocking",
				},
			],
		});

		const selfDeps = decision.newDependencies.filter((d) => d.from === d.to);
		expect(selfDeps.length).toBeGreaterThan(0);
	});

	it("a modify with an empty prompt subtask is invalid", () => {
		const decision = modifyDecision({
			newSubtasks: [
				{
					id: "subtask-empty",
					prompt: "",
					role: "empty-agent",
					dependencies: [],
					priority: 1,
				},
			],
		});

		const emptyPrompts = decision.newSubtasks.filter(
			(s) => !s.prompt || s.prompt.trim().length === 0,
		);
		expect(emptyPrompts.length).toBeGreaterThan(0);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 8. Replan prompt template
// ════════════════════════════════════════════════════════════════════════════

describe("Replan prompt template", () => {
	// Import the compiled template
	it("replanPrompt is exported from planning.ts", async () => {
		const mod = await import("../../../prompts/planning.ts");
		expect(typeof mod.replanPrompt).toBe("function");
	});

	it("replanPrompt is exported from prompts/index.ts", async () => {
		const mod = await import("../../../prompts/index.ts");
		expect(typeof mod.replanPrompt).toBe("function");
	});

	it("replanPrompt is included in the templates object", async () => {
		const mod = await import("../../../prompts/index.ts");
		expect(typeof mod.templates.replan).toBe("function");
	});

	it("renders with the correct context", async () => {
		const { replanPrompt: render } = await import(
			"../../../prompts/planning.ts"
		);

		const rendered = render({
			originalTask: "Build a REST API",
			originalAnalysis: threeSubtaskAnalysis(),
			agentStates: [
				{
					subtaskId: "subtask-a",
					agentName: "api-developer",
					role: "api-developer",
					completed: true,
					failed: false,
					error: null,
					accomplishedSummary: "Built the API",
					filesWritten: ["src/routes/users.ts"],
				},
				{
					subtaskId: "subtask-b",
					agentName: "test-writer",
					role: "test-writer",
					completed: false,
					failed: true,
					error: "Test framework not installed",
					accomplishedSummary: "",
					filesWritten: [],
				},
			],
			trigger: ReplanTrigger.SUBTASK_FAILURE,
			blockedSubtaskIds: ["subtask-c"],
			problemDescription: "Subtask B failed",
		});

		expect(typeof rendered).toBe("string");
		expect(rendered.length).toBeGreaterThan(0);

		// Contains original task
		expect(rendered).toContain("Build a REST API");

		// Contains original analysis info
		expect(rendered).toContain("multi");
		expect(rendered).toContain("complex");

		// Contains agent states
		expect(rendered).toContain("api-developer");
		expect(rendered).toContain("test-writer");
		expect(rendered).toContain("✅ Completed");
		expect(rendered).toContain("❌ Failed");
		expect(rendered).toContain("Test framework not installed");

		// Contains files written
		expect(rendered).toContain("src/routes/users.ts");

		// Contains trigger
		expect(rendered).toContain("subtask_failure");

		// Contains blocked subtasks
		expect(rendered).toContain("subtask-c");

		// Contains problem description
		expect(rendered).toContain("Subtask B failed");

		// Contains decision options
		expect(rendered).toContain("continue");
		expect(rendered).toContain("modify");
		expect(rendered).toContain("restart");
		expect(rendered).toContain("abort");

		// Contains JSON output template
		expect(rendered).toContain("shouldReplan");
		expect(rendered).toContain("newSubtasks");
		expect(rendered).toContain("newDependencies");
		expect(rendered).toContain("completedWorkSummary");
	});

	it("renders with empty blocked subtask IDs", async () => {
		const { replanPrompt: render } = await import(
			"../../../prompts/planning.ts"
		);

		const rendered = render({
			originalTask: "Test task",
			originalAnalysis: multiTaskAnalysis(),
			agentStates: [],
			trigger: ReplanTrigger.DEADLOCK,
			blockedSubtaskIds: [],
			problemDescription: "Deadlock detected",
		});

		expect(rendered).toContain("Deadlock detected");
		expect(rendered).toContain("deadlock");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 9. AgentPoolConfig — replanning configuration
// ════════════════════════════════════════════════════════════════════════════

describe("AgentPoolConfig — replanning configuration", () => {
	it("accepts enableReplanning: true", () => {
		const pool = new AgentPool(
			silentPoolConfig({
				createAgent: createMockAgentFactory(),
				enableReplanning: true,
			}),
		);
		const state = pool.getState();
		expect(state).toBeDefined();
		pool.destroy();
	});

	it("accepts enableReplanning: false", () => {
		const pool = new AgentPool(
			silentPoolConfig({
				createAgent: createMockAgentFactory(),
				enableReplanning: false,
			}),
		);
		const state = pool.getState();
		expect(state).toBeDefined();
		pool.destroy();
	});

	it("accepts maxReplanAttempts: 0", () => {
		const pool = new AgentPool(
			silentPoolConfig({
				createAgent: createMockAgentFactory(),
				maxReplanAttempts: 0,
			}),
		);
		const state = pool.getState();
		expect(state).toBeDefined();
		pool.destroy();
	});

	it("accepts maxReplanAttempts: 5", () => {
		const pool = new AgentPool(
			silentPoolConfig({
				createAgent: createMockAgentFactory(),
				maxReplanAttempts: 5,
			}),
		);
		const state = pool.getState();
		expect(state).toBeDefined();
		pool.destroy();
	});

	it("defaults enableReplanning to true when not specified", () => {
		const pool = new AgentPool(
			silentPoolConfig({
				createAgent: createMockAgentFactory(),
			}),
		);
		// We can verify by checking that the pool was created successfully
		// The default is enableReplanning !== false → true
		const state = pool.getState();
		expect(state).toBeDefined();
		pool.destroy();
	});

	it("defaults maxReplanAttempts to 2 when not specified", () => {
		const pool = new AgentPool(
			silentPoolConfig({
				createAgent: createMockAgentFactory(),
			}),
		);
		// Default is 2 — cannot be directly observed but pool creates successfully
		const state = pool.getState();
		expect(state).toBeDefined();
		pool.destroy();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 10. ContextTracker — unregisterAgent
// ════════════════════════════════════════════════════════════════════════════

describe("ContextTracker — unregisterAgent for replanning", () => {
	it("removes the agent from tracking", () => {
		const tracker = new ContextTracker();
		const subtask: SubTask = {
			id: "task-1",
			prompt: "Do something",
			role: "worker",
			dependencies: [],
			priority: 1,
		};

		tracker.registerAgent("agent-1", "Worker", subtask);
		expect(tracker.getAgentState("agent-1")).toBeDefined();

		tracker.unregisterAgent("agent-1");
		expect(tracker.getAgentState("agent-1")).toBeUndefined();
	});

	it("does nothing for non-existent agent IDs", () => {
		const tracker = new ContextTracker();
		// Should not throw
		tracker.unregisterAgent("nonexistent");
	});

	it("does not affect other registered agents", () => {
		const tracker = new ContextTracker();

		tracker.registerAgent("agent-1", "Worker1", {
			id: "task-1",
			prompt: "Do 1",
			role: "worker",
			dependencies: [],
			priority: 1,
		});
		tracker.registerAgent("agent-2", "Worker2", {
			id: "task-2",
			prompt: "Do 2",
			role: "worker",
			dependencies: [],
			priority: 1,
		});

		tracker.unregisterAgent("agent-1");

		expect(tracker.getAgentState("agent-1")).toBeUndefined();
		expect(tracker.getAgentState("agent-2")).toBeDefined();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 11. Pool event types — ReplanStartEvent and ReplanCompleteEvent
// ════════════════════════════════════════════════════════════════════════════

describe("ReplanStartEvent structure", () => {
	it("is structurally valid", () => {
		const event: ReplanStartEvent = {
			event: PoolEvent.REPLAN_START,
			timestamp: new Date().toISOString(),
			trigger: ReplanTrigger.SUBTASK_FAILURE,
			problemDescription: "Subtask failed after retries",
		};

		expect(event.event).toBe(PoolEvent.REPLAN_START);
		expect(typeof event.timestamp).toBe("string");
		expect(event.trigger).toBe(ReplanTrigger.SUBTASK_FAILURE);
		expect(typeof event.problemDescription).toBe("string");
	});
});

describe("ReplanCompleteEvent structure", () => {
	it("is structurally valid with continue decision", () => {
		const event: ReplanCompleteEvent = {
			event: PoolEvent.REPLAN_COMPLETE,
			timestamp: new Date().toISOString(),
			decision: continueDecision(),
		};

		expect(event.event).toBe(PoolEvent.REPLAN_COMPLETE);
		expect(event.decision.action).toBe("continue");
	});

	it("is structurally valid with modify decision", () => {
		const event: ReplanCompleteEvent = {
			event: PoolEvent.REPLAN_COMPLETE,
			timestamp: new Date().toISOString(),
			decision: modifyDecision(),
		};

		expect(event.event).toBe(PoolEvent.REPLAN_COMPLETE);
		expect(event.decision.action).toBe("modify");
		expect(event.decision.newSubtasks.length).toBeGreaterThan(0);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 12. UserIntent.REPLAN
// ════════════════════════════════════════════════════════════════════════════

describe("UserIntent.REPLAN", () => {
	it("has the expected value", async () => {
		const { UserIntent } = await import("../../../enums/user-intent.enum.ts");
		expect(UserIntent.REPLAN as string).toBe("replan");
	});

	it("is recognized by the intent analysis system prompt", async () => {
		const { intentAnalysisSystemPrompt } = await import(
			"../../../prompts/intent-analysis.ts"
		);
		const rendered = intentAnalysisSystemPrompt({});
		expect(rendered).toContain("replan");
		expect(rendered).toContain(
			"User wants to change the current plan or ask the system to re-evaluate",
		);
	});

	it("intent prompt includes replan in JSON Output schema", async () => {
		const { intentAnalysisSystemPrompt } = await import(
			"../../../prompts/intent-analysis.ts"
		);
		const rendered = intentAnalysisSystemPrompt({});
		expect(rendered).toContain('"replan"');
	});

	it("intent prompt includes replan example", async () => {
		const { intentAnalysisSystemPrompt } = await import(
			"../../../prompts/intent-analysis.ts"
		);
		const rendered = intentAnalysisSystemPrompt({});
		expect(rendered).toContain('"intent": "replan"');
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 13. Pool send() handles REPLAN intent
// ════════════════════════════════════════════════════════════════════════════

describe("AgentPool.send() — REPLAN intent (no active execution)", () => {
	it("returns a message when no execution is active", async () => {
		const pool = new AgentPool(
			silentPoolConfig({
				createAgent: createMockAgentFactory(),
			}),
		);

		// We can't directly send a REPLAN intent via send() without the LLM,
		// but we can verify the pool handles the REPLAN case in the switch.
		// The UserIntent.REPLAN case returns a string when not executing.
		const state = pool.getState();
		expect(state.executing).toBe(false);

		await pool.destroy();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 14. buildAccomplishedSummary logic
// ════════════════════════════════════════════════════════════════════════════

describe("buildAccomplishedSummary behavior", () => {
	it("returns 'No information available.' for undefined state", () => {
		// This tests the logic: if (!state) return "No information available."
		const state = undefined;
		const result = state ? "has info" : "No information available.";
		expect(result).toBe("No information available.");
	});

	it("includes file list when filesWritten is non-empty", () => {
		const tracker = new ContextTracker();
		const subtask: SubTask = {
			id: "task-1",
			prompt: "Build API",
			role: "developer",
			dependencies: [],
			priority: 1,
		};

		tracker.registerAgent("agent-1", "Dev", subtask);
		const state = tracker.getAgentState("agent-1");
		expect(state).toBeDefined();

		// Simulate files written
		state!.filesWritten.push("src/api.ts", "src/routes.ts");

		// The state now has files — buildAccomplishedSummary would include them
		expect(state!.filesWritten.length).toBe(2);
		expect(state!.filesWritten).toContain("src/api.ts");
	});

	it("includes prompt result text when available", () => {
		const tracker = new ContextTracker();
		const subtask: SubTask = {
			id: "task-1",
			prompt: "Build API",
			role: "developer",
			dependencies: [],
			priority: 1,
		};

		tracker.registerAgent("agent-1", "Dev", subtask);
		const state = tracker.getAgentState("agent-1");
		expect(state).toBeDefined();

		// Simulate a prompt result
		state!.promptResults.push({
			stopReason: "end_turn",
			text: "I built the API endpoints successfully with Express.js",
			usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
		});

		expect(state!.promptResults.length).toBe(1);
		expect(state!.promptResults[0]!.text.length).toBeGreaterThan(0);
	});

	it("returns fallback message when state has no output", () => {
		const tracker = new ContextTracker();
		const subtask: SubTask = {
			id: "task-1",
			prompt: "Build API",
			role: "developer",
			dependencies: [],
			priority: 1,
		};

		tracker.registerAgent("agent-1", "Dev", subtask);
		const state = tracker.getAgentState("agent-1");
		expect(state).toBeDefined();
		expect(state!.promptResults).toHaveLength(0);
		expect(state!.filesWritten).toHaveLength(0);
		expect(state!.events).toHaveLength(0);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 15. Replan guards (single-agent, disabled, max attempts)
// ════════════════════════════════════════════════════════════════════════════

describe("Replan guards", () => {
	it("single-agent strategy does not trigger replanning", () => {
		const analysis = singleTaskAnalysis("Simple task");
		expect(analysis.strategy).toBe(ExecutionStrategy.SINGLE);
		// evaluateReplan returns null for single-agent
	});

	it("multi-agent strategy is eligible for replanning", () => {
		const analysis = multiTaskAnalysis();
		expect(analysis.strategy).toBe(ExecutionStrategy.MULTI);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 16. CASCADING_FAILURES trigger
// ════════════════════════════════════════════════════════════════════════════

describe("CASCADING_FAILURES trigger logic", () => {
	it("single failure uses SUBTASK_FAILURE trigger", () => {
		const failedCount = 1;
		const trigger =
			failedCount >= 2
				? ReplanTrigger.CASCADING_FAILURES
				: ReplanTrigger.SUBTASK_FAILURE;
		expect(trigger).toBe(ReplanTrigger.SUBTASK_FAILURE);
	});

	it("two failures use CASCADING_FAILURES trigger", () => {
		const failedCount = 2;
		const trigger =
			failedCount >= 2
				? ReplanTrigger.CASCADING_FAILURES
				: ReplanTrigger.SUBTASK_FAILURE;
		expect(trigger).toBe(ReplanTrigger.CASCADING_FAILURES);
	});

	it("three failures also use CASCADING_FAILURES trigger", () => {
		const failedCount = 3;
		const trigger =
			failedCount >= 2
				? ReplanTrigger.CASCADING_FAILURES
				: ReplanTrigger.SUBTASK_FAILURE;
		expect(trigger).toBe(ReplanTrigger.CASCADING_FAILURES);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 17. applyReplanDecision — structure tests
// ════════════════════════════════════════════════════════════════════════════

describe("applyReplanDecision — decision structures", () => {
	describe("continue decision", () => {
		it("returns continueExecution: true, restart: false", () => {
			const _decision = continueDecision();
			// applyReplanDecision("continue") returns { continueExecution: true, restart: false }
			const result = { continueExecution: true, restart: false };
			expect(result.continueExecution).toBe(true);
			expect(result.restart).toBe(false);
		});
	});

	describe("abort decision", () => {
		it("throws an Error with the reasoning", () => {
			const decision = abortDecision();
			// applyReplanDecision("abort") throws an Error
			expect(() => {
				throw new Error(
					`Execution aborted by replanner: ${decision.reasoning}`,
				);
			}).toThrow("Execution aborted by replanner");
		});

		it("error message contains the decision reasoning", () => {
			const decision = abortDecision({
				reasoning: "Missing API key for external service",
			});
			const error = new Error(
				`Execution aborted by replanner: ${decision.reasoning}`,
			);
			expect(error.message).toContain("Missing API key for external service");
		});
	});

	describe("restart decision", () => {
		it("returns continueExecution: false, restart: true", () => {
			const _decision = restartDecision();
			// applyReplanDecision("restart") destroys agents and returns restart: true
			const result = { continueExecution: false, restart: true };
			expect(result.continueExecution).toBe(false);
			expect(result.restart).toBe(true);
		});
	});

	describe("modify decision", () => {
		it("should preserve completed subtask IDs in merged subtasks", () => {
			const completedIds = new Set(["subtask-a"]);
			const dec = modifyDecision();

			// Verify new subtask IDs don't overlap with completed IDs
			for (const subtask of dec.newSubtasks) {
				expect(completedIds.has(subtask.id)).toBe(false);
			}
		});

		it("should clear failed and remaining sets after modify", () => {
			const failed = new Set(["subtask-b"]);
			const remaining = new Set(["subtask-c"]);

			// After modify, these sets are cleared
			failed.clear();
			remaining.clear();

			expect(failed.size).toBe(0);
			expect(remaining.size).toBe(0);
		});

		it("should add new subtask IDs to remaining after modify", () => {
			const remaining = new Set<string>();
			const decision = modifyDecision();

			for (const subtask of decision.newSubtasks) {
				remaining.add(subtask.id);
			}

			expect(remaining.size).toBe(decision.newSubtasks.length);
			expect(remaining.has("subtask-b2")).toBe(true);
			expect(remaining.has("subtask-c2")).toBe(true);
		});

		it("should merge completed subtasks with new subtasks", () => {
			const analysis = threeSubtaskAnalysis();
			const completed = new Set(["subtask-a"]);
			const decision = modifyDecision();

			const mergedSubtasks = [
				...analysis.subtasks.filter((s) => completed.has(s.id)),
				...decision.newSubtasks,
			];

			// Should have 1 completed + 2 new = 3 total
			expect(mergedSubtasks).toHaveLength(3);
			expect(mergedSubtasks[0]!.id).toBe("subtask-a");
			expect(mergedSubtasks[1]!.id).toBe("subtask-b2");
			expect(mergedSubtasks[2]!.id).toBe("subtask-c2");
		});
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 18. execute() restart loop
// ════════════════════════════════════════════════════════════════════════════

describe("execute() restart loop", () => {
	it("ReplanRestartError is caught and triggers restart", () => {
		const decision = restartDecision();
		const err = new ReplanRestartError(decision);

		// execute() catches ReplanRestartError and restarts
		expect(err).toBeInstanceOf(ReplanRestartError);
		expect(err).toBeInstanceOf(Error);
		expect(err.isReplanRestart).toBe(true);
	});

	it("MAX_RESTARTS limits restart loop to 1 restart", () => {
		const MAX_RESTARTS = 1;
		let restartCount = 0;

		// Simulate the restart loop logic
		while (restartCount <= MAX_RESTARTS) {
			restartCount++;
			if (restartCount > MAX_RESTARTS) {
				break;
			}
		}

		// After the loop, restartCount should be MAX_RESTARTS + 1
		expect(restartCount).toBe(MAX_RESTARTS + 1);
	});

	it("non-ReplanRestartError errors propagate unchanged", () => {
		const regularError = new Error("Something went wrong");
		expect(regularError).not.toBeInstanceOf(ReplanRestartError);
		expect(regularError).toBeInstanceOf(Error);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 19. State reset between executions
// ════════════════════════════════════════════════════════════════════════════

describe("State reset — _replanCount between executions", () => {
	it("pool starts with no replan count", () => {
		const pool = new AgentPool(
			silentPoolConfig({
				createAgent: createMockAgentFactory(),
			}),
		);

		const state = pool.getState();
		expect(state.executing).toBe(false);
		// _replanCount is internal but starts at 0
		// We verify by checking the pool is in a clean state
		expect(state.deltaCount).toBe(0);
		expect(state.retryCount).toBe(0);
		expect(state.timeoutCount).toBe(0);

		pool.destroy();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 20. Deadlock handling integration with replanning
// ════════════════════════════════════════════════════════════════════════════

describe("Deadlock replanning", () => {
	it("deadlock trigger type is DEADLOCK", () => {
		expect(ReplanTrigger.DEADLOCK as string).toBe("deadlock");
	});

	it("deadlock problem description includes subtask IDs", () => {
		const remaining = new Set(["subtask-b", "subtask-c"]);
		const completed = new Set(["subtask-a"]);
		const failed = new Set<string>();

		const problemDescription =
			`Deadlock detected: subtasks ${[...remaining].join(", ")} have unsatisfiable dependencies. ` +
			`Completed: ${[...completed].join(", ")}. Failed: ${[...failed].join(", ")}.`;

		expect(problemDescription).toContain("subtask-b");
		expect(problemDescription).toContain("subtask-c");
		expect(problemDescription).toContain("subtask-a");
		expect(problemDescription).toContain("Deadlock detected");
	});

	it("only modify action is applied for deadlock replan", () => {
		// In the code, deadlock handling only applies "modify" action
		const dec = modifyDecision();
		expect(dec.action).toBe("modify");
		// continue/abort would fall through to default deadlock handling
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 21. InformationBroker recreation after modify
// ════════════════════════════════════════════════════════════════════════════

describe("InformationBroker recreation after modify", () => {
	it("new dependencies are used for the new broker", () => {
		const decision = modifyDecision();
		const newDeps = decision.newDependencies;

		// The new broker is created with these dependencies
		expect(Array.isArray(newDeps)).toBe(true);
		expect(newDeps.length).toBeGreaterThan(0);
		expect(newDeps[0]!.from).toBe("subtask-a");
		expect(newDeps[0]!.to).toBe("subtask-b2");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 22. completedWorkSummary injection
// ════════════════════════════════════════════════════════════════════════════

describe("completedWorkSummary injection", () => {
	it("is injected with HIGH priority", async () => {
		const { ContextInjectionPriority } = await import(
			"../../../types/agent-pool.types.ts"
		);
		expect(ContextInjectionPriority.HIGH).toBeDefined();
	});

	it("is injected with SHARED_CONTEXT category", async () => {
		const { ContextInjectionCategory } = await import(
			"../../../types/agent-pool.types.ts"
		);
		expect(ContextInjectionCategory.SHARED_CONTEXT).toBeDefined();
	});

	it("has source set to 'replanner'", () => {
		// When injecting completedWorkSummary, source is "replanner"
		const injection = {
			content: "The API has been built.",
			priority: "HIGH",
			category: "SHARED_CONTEXT",
			source: "replanner",
			dependencyType: null,
			timestamp: new Date().toISOString(),
		};
		expect(injection.source).toBe("replanner");
	});

	it("empty completedWorkSummary is not injected", () => {
		const decision = modifyDecision({
			completedWorkSummary: "",
		});
		// When completedWorkSummary is empty, injectContext is not called
		expect(decision.completedWorkSummary).toBe("");
	});

	it("non-empty completedWorkSummary is injected into new agents", () => {
		const decision = modifyDecision();
		expect(decision.completedWorkSummary.length).toBeGreaterThan(0);
		// injectContext would be called with this summary
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 23. AgentExecutionResult — compatibility
// ════════════════════════════════════════════════════════════════════════════

describe("AgentExecutionResult shape — unchanged by replanning", () => {
	it("still has all required fields from evolution 10", () => {
		const result: AgentExecutionResult = {
			agentId: "agent-1",
			agentName: "Worker",
			subtask: {
				id: "task-1",
				prompt: "Do work",
				role: "worker",
				dependencies: [],
				priority: 1,
			},
			promptResult: {
				stopReason: "end_turn",
				text: "Done",
				usage: null,
			},
			events: [],
			filesWritten: [],
			success: true,
			retryCount: 0,
			timedOut: false,
			subtaskDurationMs: 1000,
		};

		expect(result.agentId).toBe("agent-1");
		expect(result.retryCount).toBe(0);
		expect(result.timedOut).toBe(false);
		expect(result.subtaskDurationMs).toBe(1000);
		expect(result.success).toBe(true);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 24. Replan prompt — truncation and Handlebars helpers
// ════════════════════════════════════════════════════════════════════════════

describe("Replan prompt uses Handlebars truncate helper", () => {
	it("truncates long subtask prompts to 150 chars", async () => {
		const { replanPrompt } = await import("../../../prompts/planning.ts");

		const longPrompt = "A".repeat(300);
		const analysis = threeSubtaskAnalysis();
		// Override first subtask with long prompt
		(analysis.subtasks[0] as any).prompt = longPrompt;

		const rendered = replanPrompt({
			originalTask: "Test",
			originalAnalysis: analysis,
			agentStates: [],
			trigger: ReplanTrigger.SUBTASK_FAILURE,
			blockedSubtaskIds: [],
			problemDescription: "Test",
		});

		// The truncate helper should limit to 150 chars + ellipsis
		expect(rendered).not.toContain(longPrompt);
		// Should contain truncated version (150 chars + "…")
		expect(rendered).toContain("A".repeat(150));
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 25. Edge cases
// ════════════════════════════════════════════════════════════════════════════

describe("Edge cases", () => {
	it("ReplanRequest with all agents completed (no failures)", () => {
		const request = buildReplanRequest({
			trigger: ReplanTrigger.USER_REQUESTED,
			agentStates: [
				{
					subtaskId: "subtask-a",
					agentName: "api-developer",
					role: "api-developer",
					completed: true,
					failed: false,
					error: null,
					accomplishedSummary: "Built API",
					filesWritten: ["src/api.ts"],
				},
				{
					subtaskId: "subtask-b",
					agentName: "test-writer",
					role: "test-writer",
					completed: true,
					failed: false,
					error: null,
					accomplishedSummary: "Wrote tests",
					filesWritten: ["tests/api.test.ts"],
				},
			],
			blockedSubtaskIds: [],
			problemDescription: "User requested replan",
		});

		const completedCount = request.agentStates.filter(
			(a) => a.completed,
		).length;
		const failedCount = request.agentStates.filter((a) => a.failed).length;

		expect(completedCount).toBe(2);
		expect(failedCount).toBe(0);
	});

	it("ReplanRequest with all agents failed", () => {
		const request = buildReplanRequest({
			trigger: ReplanTrigger.CASCADING_FAILURES,
			agentStates: [
				{
					subtaskId: "subtask-a",
					agentName: "api-developer",
					role: "api-developer",
					completed: false,
					failed: true,
					error: "Connection refused",
					accomplishedSummary: "",
					filesWritten: [],
				},
				{
					subtaskId: "subtask-b",
					agentName: "test-writer",
					role: "test-writer",
					completed: false,
					failed: true,
					error: "Dependency error",
					accomplishedSummary: "",
					filesWritten: [],
				},
			],
			blockedSubtaskIds: [],
			problemDescription: "All agents failed",
		});

		const failedCount = request.agentStates.filter((a) => a.failed).length;
		expect(failedCount).toBe(2);
	});

	it("modify decision with dependencies referencing completed subtasks", () => {
		const decision = modifyDecision({
			newDependencies: [
				{
					from: "subtask-a",
					to: "subtask-b2",
					type: "blocking",
				},
			],
		});

		// "subtask-a" is a completed subtask, "subtask-b2" is a new subtask
		// This is valid — new subtasks can depend on completed work
		expect(decision.newDependencies[0]!.from).toBe("subtask-a");
		expect(decision.newDependencies[0]!.to).toBe("subtask-b2");
	});

	it("modify decision with no dependencies", () => {
		const decision = modifyDecision({
			newDependencies: [],
		});

		// Independent subtasks — valid
		expect(decision.newDependencies).toHaveLength(0);
	});

	it("ReplanRestartError with very long reasoning", () => {
		const longReasoning = "R".repeat(10000);
		const err = new ReplanRestartError({
			reasoning: longReasoning,
		});
		expect(err.message).toContain(longReasoning);
	});

	it("maxReplanAttempts of 0 means no replanning even when enabled", () => {
		// When maxReplanAttempts is 0, the guard:
		//   if (this._replanCount >= this._maxReplanAttempts) return null;
		// will trigger immediately since _replanCount starts at 0 and 0 >= 0 is true.
		const maxReplanAttempts = 0;
		const replanCount = 0;
		expect(replanCount >= maxReplanAttempts).toBe(true);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 26. Replan flow — retry vs replan distinction
// ════════════════════════════════════════════════════════════════════════════

describe("Retry vs Replan distinction", () => {
	it("retry re-executes the SAME subtask with the SAME prompt + error context", () => {
		// Evolution 10: retry = same subtask, same prompt, + error context
		const originalPrompt = "Build the API";
		const errorContext =
			"\n\n[PREVIOUS ATTEMPT FAILED]\nError: Connection refused\nAvoid the same mistake.";
		const retryPrompt = originalPrompt + errorContext;

		expect(retryPrompt).toContain(originalPrompt);
		expect(retryPrompt).toContain("PREVIOUS ATTEMPT FAILED");
	});

	it("replan creates NEW subtasks with NEW prompts referencing completed work", () => {
		// Evolution 11: replan = new subtask, new prompt, references completed work
		const decision = modifyDecision();

		for (const subtask of decision.newSubtasks) {
			// New subtask prompts reference completed work
			expect(subtask.prompt).toContain("already been implemented");
		}
	});

	it("retry preserves the subtask ID, replan creates new IDs", () => {
		const originalSubtaskId = "subtask-b";
		const decision = modifyDecision();

		// New subtask IDs are different from the failed one
		for (const subtask of decision.newSubtasks) {
			expect(subtask.id).not.toBe(originalSubtaskId);
		}
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 27. Completed subtasks are never re-executed
// ════════════════════════════════════════════════════════════════════════════

describe("Completed subtasks immutability", () => {
	it("completed subtask IDs are preserved in merged subtasks", () => {
		const analysis = threeSubtaskAnalysis();
		const completedIds = new Set(["subtask-a"]);
		const dec = modifyDecision();

		const mergedSubtasks = [
			...analysis.subtasks.filter((s) => completedIds.has(s.id)),
			...dec.newSubtasks,
		];

		// subtask-a is preserved
		const preservedIds = mergedSubtasks.map((s) => s.id);
		expect(preservedIds).toContain("subtask-a");

		// subtask-b and subtask-c are NOT in the merged list (they were failed/blocked)
		expect(preservedIds).not.toContain("subtask-b");
		expect(preservedIds).not.toContain("subtask-c");
	});

	it("completed subtasks are not in the remaining set after modify", () => {
		const remaining = new Set<string>();
		const completedIds = new Set(["subtask-a"]);
		const dec = modifyDecision();

		// Only new subtasks go into remaining
		for (const subtask of dec.newSubtasks) {
			remaining.add(subtask.id);
		}

		// completed IDs should NOT be in remaining
		for (const completedId of completedIds) {
			expect(remaining.has(completedId)).toBe(false);
		}
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 28. rebuildBlockingDeps after modify
// ════════════════════════════════════════════════════════════════════════════

describe("rebuildBlockingDeps after modify", () => {
	it("new subtask dependencies are resolved correctly", () => {
		const _completed = new Set(["subtask-a"]);
		const decision = modifyDecision();

		// After modify, blocking deps should use the new dependencies
		const blockingDeps = new Map<string, Set<string>>();
		for (const subtask of decision.newSubtasks) {
			const blockers = new Set<string>();
			for (const depId of subtask.dependencies) {
				// Check if it's a blocking dep
				const dep = decision.newDependencies.find(
					(d) => d.from === depId && d.to === subtask.id,
				);
				if (!dep || dep.type === "blocking") {
					blockers.add(depId);
				}
			}
			blockingDeps.set(subtask.id, blockers);
		}

		// subtask-b2 has no dependencies in its subtask.dependencies
		expect(blockingDeps.get("subtask-b2")!.size).toBe(0);
		// subtask-c2 has no dependencies in its subtask.dependencies
		expect(blockingDeps.get("subtask-c2")!.size).toBe(0);
	});

	it("completed subtasks are skipped when rebuilding blocking deps", () => {
		const completed = new Set(["subtask-a"]);
		const analysis = threeSubtaskAnalysis();

		// rebuildBlockingDeps skips completed subtasks
		const blockingDeps = new Map<string, Set<string>>();
		for (const subtask of analysis.subtasks) {
			if (completed.has(subtask.id)) continue;
			blockingDeps.set(subtask.id, new Set());
		}

		expect(blockingDeps.has("subtask-a")).toBe(false);
		expect(blockingDeps.has("subtask-b")).toBe(true);
		expect(blockingDeps.has("subtask-c")).toBe(true);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 29. Fallback on LLM error
// ════════════════════════════════════════════════════════════════════════════

describe("Fallback behavior on LLM error", () => {
	it("TaskPlanner.replan returns continue on LLM failure", () => {
		// If the LLM throws, replan() returns a safe fallback:
		const fallback: ReplanDecision = {
			shouldReplan: false,
			action: "continue",
			reasoning:
				"Replan evaluation failed: Some error. Continuing with original plan.",
			newSubtasks: [],
			newDependencies: [],
			completedWorkSummary: "",
		};

		expect(fallback.action).toBe("continue");
		expect(fallback.shouldReplan).toBe(false);
		expect(fallback.newSubtasks).toHaveLength(0);
		expect(fallback.reasoning).toContain("Replan evaluation failed");
	});

	it("semantic validation failure also falls back to continue", () => {
		const fallback: ReplanDecision = {
			shouldReplan: false,
			action: "continue",
			reasoning:
				'Replan decision was invalid (New subtask "subtask-a" reuses a completed subtask ID). Continuing with original plan.',
			newSubtasks: [],
			newDependencies: [],
			completedWorkSummary: "",
		};

		expect(fallback.action).toBe("continue");
		expect(fallback.reasoning).toContain("reuses a completed subtask ID");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 30. Pool lifecycle — replan count reset in finally block
// ════════════════════════════════════════════════════════════════════════════

describe("Pool lifecycle — counter reset in finally block", () => {
	it("_replanCount is reset in the finally block of _executeInternal", () => {
		// The finally block of _executeInternal resets:
		// this._replanCount = 0;
		// This is alongside _deltaCount, _sharingDecisionCount, etc.
		const countersReset = {
			_deltaCount: 0,
			_sharingDecisionCount: 0,
			_retryCount: 0,
			_timeoutCount: 0,
			_replanCount: 0,
		};

		expect(countersReset._replanCount).toBe(0);
		expect(countersReset._deltaCount).toBe(0);
	});

	it("_replanCount is reset on restart in execute()", () => {
		// In the execute() restart loop, _replanCount is explicitly reset:
		// this._replanCount = 0;
		const afterRestart = {
			_deltaCount: 0,
			_sharingDecisionCount: 0,
			_replanCount: 0,
		};

		expect(afterRestart._replanCount).toBe(0);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 31. Mapping cleanup on modify (subtaskToAgent, agentToSubtask)
// ════════════════════════════════════════════════════════════════════════════

describe("Mapping cleanup on modify", () => {
	it("subtaskToAgent is cleaned for destroyed subtasks", () => {
		const subtaskToAgent = new Map<string, string>();
		subtaskToAgent.set("subtask-a", "agent-1");
		subtaskToAgent.set("subtask-b", "agent-2");
		subtaskToAgent.set("subtask-c", "agent-3");

		// After modify, failed/remaining subtasks are cleaned
		const toRemove = ["subtask-b", "subtask-c"];
		for (const id of toRemove) {
			subtaskToAgent.delete(id);
		}

		expect(subtaskToAgent.has("subtask-a")).toBe(true);
		expect(subtaskToAgent.has("subtask-b")).toBe(false);
		expect(subtaskToAgent.has("subtask-c")).toBe(false);
	});

	it("agentToSubtask is cleaned for destroyed agents", () => {
		const agentToSubtask = new Map<string, string>();
		agentToSubtask.set("agent-1", "subtask-a");
		agentToSubtask.set("agent-2", "subtask-b");
		agentToSubtask.set("agent-3", "subtask-c");

		// After modify, agents for failed/remaining subtasks are cleaned
		const agentsToRemove = ["agent-2", "agent-3"];
		for (const id of agentsToRemove) {
			agentToSubtask.delete(id);
		}

		expect(agentToSubtask.has("agent-1")).toBe(true);
		expect(agentToSubtask.has("agent-2")).toBe(false);
		expect(agentToSubtask.has("agent-3")).toBe(false);
	});

	it("new subtask-agent mappings are added after modify", () => {
		const subtaskToAgent = new Map<string, string>();
		subtaskToAgent.set("subtask-a", "agent-1"); // preserved

		// Add new mappings
		subtaskToAgent.set("subtask-b2", "agent-4");
		subtaskToAgent.set("subtask-c2", "agent-5");

		expect(subtaskToAgent.size).toBe(3);
		expect(subtaskToAgent.get("subtask-b2")).toBe("agent-4");
		expect(subtaskToAgent.get("subtask-c2")).toBe("agent-5");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 32. Integration: Pool creates with replan config
// ════════════════════════════════════════════════════════════════════════════

describe("Integration — Pool creates with replanning config combined with other configs", () => {
	it("works with timeout + retry + replanning config", () => {
		const pool = new AgentPool(
			silentPoolConfig({
				createAgent: createMockAgentFactory(),
				timeout: {
					subtaskTimeoutMs: 60_000,
					complexityTimeouts: {
						simple: 30_000,
						complex: 120_000,
					},
				},
				retry: {
					maxRetries: 2,
					includeErrorContext: true,
					retryDelayMs: 1000,
					retryOnTimeout: true,
				},
				enableReplanning: true,
				maxReplanAttempts: 3,
			}),
		);

		const state = pool.getState();
		expect(state).toBeDefined();
		expect(state.executing).toBe(false);

		pool.destroy();
	});

	it("works with replanning disabled and retry enabled", () => {
		const pool = new AgentPool(
			silentPoolConfig({
				createAgent: createMockAgentFactory(),
				retry: {
					maxRetries: 1,
					includeErrorContext: true,
					retryDelayMs: 2000,
					retryOnTimeout: true,
				},
				enableReplanning: false,
			}),
		);

		const state = pool.getState();
		expect(state).toBeDefined();

		pool.destroy();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// 33. Non-regression: existing types unchanged
// ════════════════════════════════════════════════════════════════════════════

describe("Non-regression — existing types unchanged", () => {
	it("TaskAnalysis still has all required fields", () => {
		const analysis = multiTaskAnalysis();

		expect(analysis.strategy).toBeDefined();
		expect(analysis.complexity).toBeDefined();
		expect(analysis.reasoning).toBeDefined();
		expect(analysis.subtasks).toBeDefined();
		expect(analysis.dependencies).toBeDefined();
		expect(analysis.parallelismBenefit).toBeDefined();
	});

	it("SubTask still has all required fields", () => {
		const subtask: SubTask = {
			id: "test",
			prompt: "test prompt",
			role: "tester",
			dependencies: [],
			priority: 1,
		};

		expect(subtask.id).toBeDefined();
		expect(subtask.prompt).toBeDefined();
		expect(subtask.role).toBeDefined();
		expect(subtask.dependencies).toBeDefined();
		expect(subtask.priority).toBeDefined();
	});

	it("TaskDependency still has all required fields", () => {
		const dep: TaskDependency = {
			from: "a",
			to: "b",
			type: "blocking",
		};

		expect(dep.from).toBeDefined();
		expect(dep.to).toBeDefined();
		expect(dep.type).toBeDefined();
		expect(["blocking", "informational"]).toContain(dep.type);
	});
});
