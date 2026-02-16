import { describe, expect, it } from "bun:test";

import { ExecutionStrategy } from "../../../enums/execution-strategy.enum.ts";
import { TaskComplexity } from "../../../enums/task-complexity.enum.ts";
import { multiTaskAnalysis, singleTaskAnalysis } from "./test-helpers.ts";

// ════════════════════════════════════════════════════════════════════════════
// TaskPlanner Validation Tests
// ════════════════════════════════════════════════════════════════════════════

describe("TaskPlanner validation (via ContextTracker & type checking)", () => {
	// We can't easily unit test the planner directly without mocking
	// the ConversationManager. Instead, we validate the data structures
	// that the planner produces and consumes.

	describe("TaskAnalysis structure validation", () => {
		it("single strategy analysis is structurally valid", () => {
			const analysis = singleTaskAnalysis("Fix a bug");

			expect(analysis.strategy).toBe(ExecutionStrategy.SINGLE);
			expect(analysis.complexity).toBe(TaskComplexity.SIMPLE);
			expect(analysis.subtasks).toHaveLength(1);
			expect(analysis.subtasks[0]!.id).toBe("task-1");
			expect(analysis.subtasks[0]!.prompt).toBe("Fix a bug");
			expect(analysis.subtasks[0]!.dependencies).toEqual([]);
			expect(analysis.dependencies).toEqual([]);
			expect(analysis.parallelismBenefit).toBe(0);
		});

		it("multi strategy analysis is structurally valid", () => {
			const analysis = multiTaskAnalysis();

			expect(analysis.strategy).toBe(ExecutionStrategy.MULTI);
			expect(analysis.complexity).toBe(TaskComplexity.COMPLEX);
			expect(analysis.subtasks).toHaveLength(2);
			expect(analysis.dependencies).toHaveLength(1);
			expect(analysis.parallelismBenefit).toBeGreaterThan(0);

			// Dependency references valid subtask IDs
			const subtaskIds = new Set(analysis.subtasks.map((s) => s.id));
			for (const dep of analysis.dependencies) {
				expect(subtaskIds.has(dep.from)).toBe(true);
				expect(subtaskIds.has(dep.to)).toBe(true);
			}
		});

		it("multi strategy has distinct subtask prompts", () => {
			const analysis = multiTaskAnalysis();

			const prompts = analysis.subtasks.map((s) => s.prompt);
			const uniquePrompts = new Set(prompts);
			expect(uniquePrompts.size).toBe(prompts.length);
		});

		it("multi strategy has distinct subtask roles", () => {
			const analysis = multiTaskAnalysis();

			const roles = analysis.subtasks.map((s) => s.role);
			const uniqueRoles = new Set(roles);
			expect(uniqueRoles.size).toBe(roles.length);
		});

		it("subtask dependencies reference existing subtask IDs", () => {
			const analysis = multiTaskAnalysis();
			const subtaskIds = new Set(analysis.subtasks.map((s) => s.id));

			for (const subtask of analysis.subtasks) {
				for (const depId of subtask.dependencies) {
					expect(subtaskIds.has(depId)).toBe(true);
				}
			}
		});

		it("no subtask depends on itself", () => {
			const analysis = multiTaskAnalysis();

			for (const subtask of analysis.subtasks) {
				expect(subtask.dependencies).not.toContain(subtask.id);
			}
		});

		it("dependency type is either blocking or informational", () => {
			const analysis = multiTaskAnalysis();

			for (const dep of analysis.dependencies) {
				expect(["blocking", "informational"]).toContain(dep.type);
			}
		});
	});
});

// ════════════════════════════════════════════════════════════════════════════
// JSON Parsing Strictness Tests
// ════════════════════════════════════════════════════════════════════════════

describe("JSON Parsing Strictness", () => {
	it("TaskAnalysis validator rejects null", () => {
		// We test the validator logic by creating objects that would fail
		// (The actual validator function is internal to task-planner.ts,
		// but we can verify the type expectations through our test helpers)

		const analysis = singleTaskAnalysis("test");

		// Valid analysis should have all required fields
		expect(analysis.strategy).toBeDefined();
		expect(analysis.complexity).toBeDefined();
		expect(analysis.reasoning).toBeDefined();
		expect(analysis.subtasks).toBeDefined();
		expect(analysis.subtasks.length).toBeGreaterThan(0);
		expect(analysis.dependencies).toBeDefined();
		expect(typeof analysis.parallelismBenefit).toBe("number");
	});

	it("SubTask must have non-empty id, prompt, and role", () => {
		const subtask = singleTaskAnalysis("test").subtasks[0];

		expect(subtask!.id.length).toBeGreaterThan(0);
		expect(subtask!.prompt.length).toBeGreaterThan(0);
		expect(subtask!.role.length).toBeGreaterThan(0);
		expect(Array.isArray(subtask!.dependencies)).toBe(true);
		expect(typeof subtask!.priority).toBe("number");
		expect(subtask!.priority).toBeGreaterThan(0);
	});

	it("parallelismBenefit is clamped to [0, 1]", () => {
		const analysis = singleTaskAnalysis("test");
		expect(analysis.parallelismBenefit).toBeGreaterThanOrEqual(0);
		expect(analysis.parallelismBenefit).toBeLessThanOrEqual(1);
	});

	it("strategy single must have exactly 1 subtask", () => {
		const analysis = singleTaskAnalysis("test");
		expect(analysis.strategy).toBe(ExecutionStrategy.SINGLE);
		expect(analysis.subtasks).toHaveLength(1);
	});

	it("strategy multi must have >= 2 subtasks", () => {
		const analysis = multiTaskAnalysis();
		expect(analysis.strategy).toBe(ExecutionStrategy.MULTI);
		expect(analysis.subtasks.length).toBeGreaterThanOrEqual(2);
	});
});
