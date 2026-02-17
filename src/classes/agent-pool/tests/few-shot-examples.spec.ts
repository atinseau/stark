import { describe, expect, it } from "bun:test";

import {
	batchedSharingDecisionPrompt,
	contextAnalysisSystemPrompt,
	intentAnalysisSystemPrompt,
	notificationDecisionPrompt,
	planningSystemPrompt,
	sharingAnalysisSystemPrompt,
	sharingDecisionPrompt,
	summarySystemPrompt,
} from "../../../prompts/index.ts";

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

/**
 * Extracts all top-level JSON object blocks from a string.
 *
 * Walks character-by-character, tracking brace depth to correctly
 * handle nested objects. Only captures blocks that start with `{`
 * at the top level (not inside another block).
 */
function extractJsonBlocks(text: string): string[] {
	const blocks: string[] = [];
	let depth = 0;
	let start = -1;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === "{") {
			if (depth === 0) start = i;
			depth++;
		} else if (ch === "}") {
			depth--;
			if (depth === 0 && start !== -1) {
				blocks.push(text.slice(start, i + 1));
				start = -1;
			}
		}
	}

	return blocks;
}

/**
 * Extracts JSON blocks that appear within `## Examples` sections only,
 * skipping JSON blocks in schema definitions or other prompt sections.
 *
 * For the planning prompt, also skips the anti-pattern "BAD response"
 * block since it is intentionally incomplete.
 */
function extractExampleJsonBlocks(promptText: string): string[] {
	// Find the start of the Examples section
	const examplesStart = promptText.search(/## Examples?\b/);
	if (examplesStart === -1) return [];

	// Find the end of the Examples section (next ## heading that isn't a sub-example)
	const afterExamples = promptText.slice(examplesStart);
	// Find the next ## section that is NOT an example/anti-pattern heading
	const nextSectionMatch = afterExamples.search(
		/\n## (?!Example|Anti-pattern)[A-Z]/,
	);
	const examplesSection =
		nextSectionMatch !== -1
			? afterExamples.slice(0, nextSectionMatch)
			: afterExamples;

	// Remove the anti-pattern BAD response block before extracting
	const cleaned = examplesSection.replace(
		/\*\*BAD response\*\*[^}]*\{[^}]*\{[^}]*\}[^}]*\}/s,
		"",
	);

	return extractJsonBlocks(cleaned);
}

// ── Mock data for template compilation ─────────────────────────────────────

const mockNotificationData = {
	delta: {
		agentName: "TestAgent",
		agentRole: "api-developer",
		type: "prompt_complete",
		summary: "Agent completed a prompt",
		significance: 0.8,
	},
	agentTask: "Build a REST API",
	otherAgentsContext: null,
};

const mockSharingData = {
	sourceAgent: {
		agentName: "SourceAgent",
		agentId: "agent-source-id",
		taskDescription: "Build the API",
		taskRole: "api-developer",
		status: "idle",
	},
	delta: {
		type: "file_written",
		summary: "Wrote src/routes/users.ts",
		data: { file: "src/routes/users.ts" },
	},
	targetAgent: {
		agentName: "TargetAgent",
		agentId: "agent-target-id",
		taskDescription: "Write tests",
		taskRole: "test-writer",
		status: "idle",
		completed: false,
	},
	dependency: {
		from: "api-impl",
		to: "test-suite",
		type: "blocking",
	},
};

const mockBatchedSharingData = {
	sourceAgent: {
		agentName: "SourceAgent",
		agentId: "agent-source-id",
		taskDescription: "Build the API",
		taskRole: "api-developer",
		status: "idle",
	},
	delta: {
		type: "file_written",
		summary: "Wrote src/routes/users.ts",
		data: { file: "src/routes/users.ts" },
	},
	targets: [
		{
			agentName: "TargetAgent",
			agentId: "agent-target-id",
			taskDescription: "Write tests",
			taskRole: "test-writer",
			status: "idle",
			completed: false,
			dependency: {
				from: "api-impl",
				to: "test-suite",
				type: "blocking",
			},
			previouslyShared: [],
		},
	],
};

// ════════════════════════════════════════════════════════════════════════════
// Test 1: Planning system prompt contains all expected examples
// ════════════════════════════════════════════════════════════════════════════

describe("Planning system prompt — few-shot examples", () => {
	const rendered = planningSystemPrompt({});

	it("contains Example 1: Single-agent — simple task", () => {
		expect(rendered).toContain("Example 1: Single-agent");
		expect(rendered).toContain("simple task");
	});

	it("contains Example 2: Single-agent — deceptively complex", () => {
		expect(rendered).toContain("Example 2: Single-agent — deceptively complex");
	});

	it("contains Example 3: Multi-agent", () => {
		expect(rendered).toContain("Example 3: Multi-agent");
		expect(rendered).toContain("genuinely separable concerns");
	});

	it("contains Anti-pattern: Artificial splitting", () => {
		expect(rendered).toContain("Anti-pattern: Artificial splitting");
		expect(rendered).toContain("DO NOT do this");
		expect(rendered).toContain("Why it's bad");
	});

	it("examples are placed before the JSON Schema section", () => {
		const examplesIdx = rendered.indexOf("## Examples");
		const schemaIdx = rendered.indexOf("## JSON Schema");
		expect(examplesIdx).toBeGreaterThan(-1);
		expect(schemaIdx).toBeGreaterThan(-1);
		expect(examplesIdx).toBeLessThan(schemaIdx);
	});

	it("examples are placed after the Project Context Usage section", () => {
		const contextIdx = rendered.indexOf("## Project Context Usage");
		const examplesIdx = rendered.indexOf("## Examples");
		expect(contextIdx).toBeGreaterThan(-1);
		expect(examplesIdx).toBeGreaterThan(contextIdx);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Test 2: Batched sharing prompt contains examples
// ════════════════════════════════════════════════════════════════════════════

describe("Batched sharing decision prompt — few-shot examples", () => {
	const rendered = batchedSharingDecisionPrompt(mockBatchedSharingData);

	it("contains example markers", () => {
		expect(rendered).toContain("Example");
	});

	it("shows redundancy avoidance pattern", () => {
		expect(rendered).toContain("avoids redundancy");
	});

	it("contains a don't-share example", () => {
		expect(rendered).toContain("Don't share");
		expect(rendered).toContain('"shouldShare": false');
	});

	it("examples are placed before the JSON Output section", () => {
		const examplesIdx = rendered.indexOf("## Examples");
		const jsonOutputIdx = rendered.indexOf("## JSON Output");
		expect(examplesIdx).toBeGreaterThan(-1);
		expect(jsonOutputIdx).toBeGreaterThan(-1);
		expect(examplesIdx).toBeLessThan(jsonOutputIdx);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Test 3: Notification prompt contains examples
// ════════════════════════════════════════════════════════════════════════════

describe("Notification decision prompt — few-shot examples", () => {
	const rendered = notificationDecisionPrompt(mockNotificationData);

	it("contains 'Notify: Significant milestone' example", () => {
		expect(rendered).toContain("Notify: Significant milestone");
	});

	it("contains 'Don't notify: Routine progress' example", () => {
		expect(rendered).toContain("Don't notify: Routine progress");
	});

	it("contains 'Notify: Error requiring attention' example", () => {
		expect(rendered).toContain("Notify: Error requiring attention");
	});

	it("examples are placed before the JSON Output section", () => {
		const examplesIdx = rendered.indexOf("## Examples");
		const jsonOutputIdx = rendered.indexOf("## JSON Output");
		expect(examplesIdx).toBeGreaterThan(-1);
		expect(jsonOutputIdx).toBeGreaterThan(-1);
		expect(examplesIdx).toBeLessThan(jsonOutputIdx);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Test 4: Intent analysis system prompt contains examples
// ════════════════════════════════════════════════════════════════════════════

describe("Intent analysis system prompt — few-shot examples", () => {
	const rendered = intentAnalysisSystemPrompt({});

	it("contains at least 4 distinct intent examples", () => {
		const intentExamples = [
			"new_task",
			"status_query",
			"notification_preference",
			"approve_agent",
		];

		for (const intent of intentExamples) {
			expect(rendered).toContain(`"intent": "${intent}"`);
		}
	});

	it("contains context_injection example", () => {
		expect(rendered).toContain('"intent": "context_injection"');
	});

	it("examples are placed after approve_agent Rules", () => {
		const rulesIdx = rendered.indexOf("## approve_agent Rules");
		const examplesIdx = rendered.indexOf("## Examples");
		expect(rulesIdx).toBeGreaterThan(-1);
		expect(examplesIdx).toBeGreaterThan(rulesIdx);
	});

	it("examples are placed before the JSON Output section", () => {
		const examplesIdx = rendered.indexOf("## Examples");
		const jsonOutputIdx = rendered.indexOf("## JSON Output");
		expect(examplesIdx).toBeGreaterThan(-1);
		expect(jsonOutputIdx).toBeGreaterThan(-1);
		expect(examplesIdx).toBeLessThan(jsonOutputIdx);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Test 5: Context analysis system prompt contains examples
// ════════════════════════════════════════════════════════════════════════════

describe("Context analysis system prompt (notifications) — few-shot examples", () => {
	const rendered = contextAnalysisSystemPrompt({});

	it("contains Don't notify example", () => {
		expect(rendered).toContain('"shouldNotify": false');
	});

	it("contains Notify example", () => {
		expect(rendered).toContain('"shouldNotify": true');
	});

	it("does not contain share or clarify actions", () => {
		expect(rendered).not.toContain('"action": "share"');
		expect(rendered).not.toContain('"action": "clarify"');
	});

	it("examples are placed after the Guiding Principle section", () => {
		const principleIdx = rendered.indexOf("## Guiding Principle");
		const examplesIdx = rendered.indexOf("## Examples");
		expect(principleIdx).toBeGreaterThan(-1);
		expect(examplesIdx).toBeGreaterThan(principleIdx);
	});

	it("examples are placed before the JSON Output section", () => {
		const examplesIdx = rendered.indexOf("## Examples");
		const jsonOutputIdx = rendered.indexOf("## JSON Output");
		expect(examplesIdx).toBeGreaterThan(-1);
		expect(jsonOutputIdx).toBeGreaterThan(-1);
		expect(examplesIdx).toBeLessThan(jsonOutputIdx);
	});
});

describe("Sharing analysis system prompt — few-shot examples", () => {
	const rendered = sharingAnalysisSystemPrompt({});

	it("contains Share example", () => {
		expect(rendered).toContain('"shouldShare": true');
	});

	it("contains Don't share example", () => {
		expect(rendered).toContain('"shouldShare": false');
	});

	it("does not contain notify or clarify actions", () => {
		// "notify" may appear in negation context ("you do NOT notify"), but not as an action
		expect(rendered).not.toContain('"shouldNotify"');
		expect(rendered).not.toContain('"action": "clarify"');
	});

	it("contains dependency type instructions", () => {
		expect(rendered).toContain("## Dependency types");
		expect(rendered).toContain("**blocking**");
		expect(rendered).toContain("**informational**");
	});

	it("contains previouslyShared deduplication instructions", () => {
		expect(rendered).toContain("previouslyShared");
	});

	it("examples are placed before the JSON Output Format section", () => {
		const examplesIdx = rendered.indexOf("## Examples");
		const jsonOutputIdx = rendered.indexOf("## JSON Output Format");
		expect(examplesIdx).toBeGreaterThan(-1);
		expect(jsonOutputIdx).toBeGreaterThan(-1);
		expect(examplesIdx).toBeLessThan(jsonOutputIdx);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Test 6: Summary system prompt contains structure and examples
// ════════════════════════════════════════════════════════════════════════════

describe("Summary system prompt — structure and few-shot examples", () => {
	const rendered = summarySystemPrompt({});

	it("contains the '## Structure' section", () => {
		expect(rendered).toContain("## Structure");
	});

	it("contains the '## Examples' section", () => {
		expect(rendered).toContain("## Examples");
	});

	it("contains all expected structure sections", () => {
		const sections = [
			"Outcome",
			"What was built",
			"Architecture decisions",
			"Issues encountered",
			"Inter-agent coordination",
			"Recommendations",
		];

		for (const section of sections) {
			expect(rendered).toContain(section);
		}
	});

	it("contains a successful execution example", () => {
		expect(rendered).toContain("Successful multi-agent execution");
	});

	it("contains a partial failure example", () => {
		expect(rendered).toContain("Partial failure");
	});

	it("ends with instructions for plain text response", () => {
		expect(rendered).toContain(
			"Respond in plain text with Markdown formatting. No JSON.",
		);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Test 7: Sharing decision prompt contains examples
// ════════════════════════════════════════════════════════════════════════════

describe("Sharing decision prompt — few-shot examples", () => {
	const rendered = sharingDecisionPrompt(mockSharingData);

	it("contains a share example", () => {
		expect(rendered).toContain("Share: Relevant new information");
		expect(rendered).toContain('"shouldShare": true');
	});

	it("contains a don't-share example", () => {
		expect(rendered).toContain("Don't share: Irrelevant to target's task");
		expect(rendered).toContain('"shouldShare": false');
	});

	it("examples are placed before the JSON Output section", () => {
		const examplesIdx = rendered.indexOf("## Examples");
		const jsonOutputIdx = rendered.indexOf("## JSON Output");
		expect(examplesIdx).toBeGreaterThan(-1);
		expect(jsonOutputIdx).toBeGreaterThan(-1);
		expect(examplesIdx).toBeLessThan(jsonOutputIdx);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Test 8: All JSON blocks in examples are syntactically valid
// ════════════════════════════════════════════════════════════════════════════

describe("JSON validity of all example blocks", () => {
	const prompts: Array<{ name: string; text: string }> = [
		{ name: "planning system", text: planningSystemPrompt({}) },
		{
			name: "batched sharing decision",
			text: batchedSharingDecisionPrompt(mockBatchedSharingData),
		},
		{ name: "sharing decision", text: sharingDecisionPrompt(mockSharingData) },
		{
			name: "notification decision",
			text: notificationDecisionPrompt(mockNotificationData),
		},
		{ name: "intent analysis system", text: intentAnalysisSystemPrompt({}) },
		{
			name: "context analysis system (notifications)",
			text: contextAnalysisSystemPrompt({}),
		},
		{
			name: "sharing analysis system",
			text: sharingAnalysisSystemPrompt({}),
		},
	];

	for (const { name, text } of prompts) {
		it(`${name} prompt — all example JSON blocks parse successfully`, () => {
			const blocks = extractExampleJsonBlocks(text);
			expect(blocks.length).toBeGreaterThan(0);

			for (let i = 0; i < blocks.length; i++) {
				const block = blocks[i]!;
				let parsed: unknown;
				try {
					parsed = JSON.parse(block);
				} catch (e) {
					// Include the block content in the error message for debugging
					throw new Error(
						`JSON block ${i + 1} in "${name}" prompt failed to parse:\n${block}\n\nError: ${e}`,
					);
				}
				expect(parsed).toBeDefined();
				expect(typeof parsed).toBe("object");
			}
		});
	}
});

// ════════════════════════════════════════════════════════════════════════════
// Test 9: Example JSONs pass their corresponding validators
// ════════════════════════════════════════════════════════════════════════════

// The validators are internal to their respective modules, so we
// replicate the structural checks here to ensure compatibility.

describe("Planning example JSONs pass structural validation", () => {
	const rendered = planningSystemPrompt({});
	const blocks = extractExampleJsonBlocks(rendered);

	// The first 3 blocks are the valid examples (Example 1, 2, 3).
	// The anti-pattern block is excluded by extractExampleJsonBlocks.
	const validBlocks = blocks.filter((block) => {
		try {
			const obj = JSON.parse(block);
			// Filter out the anti-pattern block if it somehow slips through
			// (it lacks required fields like "complexity" and "reasoning")
			return (
				typeof obj.strategy === "string" &&
				typeof obj.complexity === "string" &&
				typeof obj.reasoning === "string"
			);
		} catch {
			return false;
		}
	});

	it("has at least 3 valid example blocks", () => {
		expect(validBlocks.length).toBeGreaterThanOrEqual(3);
	});

	for (let i = 0; i < validBlocks.length; i++) {
		it(`example ${i + 1} passes TaskAnalysis structural validation`, () => {
			const obj = JSON.parse(validBlocks[i]!);

			// strategy
			expect(["single", "multi"]).toContain(obj.strategy);

			// complexity
			expect(["simple", "moderate", "complex"]).toContain(obj.complexity);

			// reasoning
			expect(typeof obj.reasoning).toBe("string");
			expect(obj.reasoning.length).toBeGreaterThan(0);

			// subtasks
			expect(Array.isArray(obj.subtasks)).toBe(true);
			expect(obj.subtasks.length).toBeGreaterThan(0);

			if (obj.strategy === "single") {
				expect(obj.subtasks).toHaveLength(1);
			} else {
				expect(obj.subtasks.length).toBeGreaterThanOrEqual(2);
			}

			for (const subtask of obj.subtasks) {
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

			// dependencies
			expect(Array.isArray(obj.dependencies)).toBe(true);
			if (obj.strategy === "single") {
				expect(obj.dependencies).toHaveLength(0);
			}

			for (const dep of obj.dependencies) {
				expect(typeof dep.from).toBe("string");
				expect(dep.from.length).toBeGreaterThan(0);
				expect(typeof dep.to).toBe("string");
				expect(dep.to.length).toBeGreaterThan(0);
				expect(["blocking", "informational"]).toContain(dep.type);
			}

			// parallelismBenefit
			expect(typeof obj.parallelismBenefit).toBe("number");
			expect(obj.parallelismBenefit).toBeGreaterThanOrEqual(0);
			expect(obj.parallelismBenefit).toBeLessThanOrEqual(1);
		});
	}
});

describe("Planning example JSONs pass semantic validation", () => {
	const rendered = planningSystemPrompt({});
	const blocks = extractExampleJsonBlocks(rendered);
	const validBlocks = blocks.filter((block) => {
		try {
			const obj = JSON.parse(block);
			return (
				typeof obj.strategy === "string" &&
				typeof obj.complexity === "string" &&
				typeof obj.reasoning === "string"
			);
		} catch {
			return false;
		}
	});

	for (let i = 0; i < validBlocks.length; i++) {
		it(`example ${i + 1} has no semantic errors`, () => {
			const obj = JSON.parse(validBlocks[i]!);
			const subtaskIds = new Set<string>(
				obj.subtasks.map((s: { id: string }) => s.id),
			);

			// Unique IDs
			expect(subtaskIds.size).toBe(obj.subtasks.length);

			// Single strategy should have no dependencies
			if (obj.strategy === "single") {
				expect(obj.dependencies).toHaveLength(0);
			}

			// Dependency references must point to valid subtask IDs
			for (const dep of obj.dependencies) {
				expect(subtaskIds.has(dep.from)).toBe(true);
				expect(subtaskIds.has(dep.to)).toBe(true);
				expect(dep.from).not.toBe(dep.to);
			}

			// Subtask-level dependencies must reference valid IDs
			for (const subtask of obj.subtasks) {
				for (const depId of subtask.dependencies) {
					expect(subtaskIds.has(depId)).toBe(true);
					expect(depId).not.toBe(subtask.id);
				}
			}

			// No circular dependencies (simple check for acyclicity via topological sort)
			if (obj.dependencies.length > 0) {
				const adjacency = new Map<string, string[]>();
				for (const dep of obj.dependencies) {
					if (!adjacency.has(dep.from)) {
						adjacency.set(dep.from, []);
					}
					adjacency.get(dep.from)!.push(dep.to);
				}

				const visited = new Set<string>();
				const inStack = new Set<string>();

				function hasCycle(node: string): boolean {
					if (inStack.has(node)) return true;
					if (visited.has(node)) return false;
					visited.add(node);
					inStack.add(node);
					for (const neighbor of adjacency.get(node) ?? []) {
						if (hasCycle(neighbor)) return true;
					}
					inStack.delete(node);
					return false;
				}

				for (const id of subtaskIds) {
					expect(hasCycle(id)).toBe(false);
				}
			}
		});
	}
});

describe("Batched sharing example JSONs pass structural validation", () => {
	const rendered = batchedSharingDecisionPrompt(mockBatchedSharingData);
	const blocks = extractExampleJsonBlocks(rendered);

	it("has at least 2 example blocks", () => {
		expect(blocks.length).toBeGreaterThanOrEqual(2);
	});

	for (let i = 0; i < blocks.length; i++) {
		it(`example ${i + 1} passes BatchedSharingDecision validation`, () => {
			const obj = JSON.parse(blocks[i]!);

			expect(Array.isArray(obj.decisions)).toBe(true);

			for (const decision of obj.decisions) {
				expect(typeof decision.targetAgentId).toBe("string");
				expect(decision.targetAgentId.length).toBeGreaterThan(0);
				expect(typeof decision.shouldShare).toBe("boolean");
				expect(typeof decision.reasoning).toBe("string");
				expect(decision.reasoning.length).toBeGreaterThan(0);

				if (decision.shouldShare) {
					expect(typeof decision.information).toBe("string");
					expect(decision.information.length).toBeGreaterThan(0);
				}
			}
		});
	}
});

describe("Sharing decision example JSONs pass structural validation", () => {
	const rendered = sharingDecisionPrompt(mockSharingData);
	const blocks = extractExampleJsonBlocks(rendered);

	it("has at least 2 example blocks", () => {
		expect(blocks.length).toBeGreaterThanOrEqual(2);
	});

	for (let i = 0; i < blocks.length; i++) {
		it(`example ${i + 1} passes SharingDecision validation`, () => {
			const obj = JSON.parse(blocks[i]!);

			expect(typeof obj.shouldShare).toBe("boolean");
			expect(typeof obj.reasoning).toBe("string");
			expect(obj.reasoning.length).toBeGreaterThan(0);

			if (obj.shouldShare) {
				expect(typeof obj.information).toBe("string");
				expect(obj.information.length).toBeGreaterThan(0);
			}
		});
	}
});

describe("Notification decision example JSONs pass structural validation", () => {
	const rendered = notificationDecisionPrompt(mockNotificationData);
	const blocks = extractExampleJsonBlocks(rendered);

	it("has at least 3 example blocks", () => {
		expect(blocks.length).toBeGreaterThanOrEqual(3);
	});

	for (let i = 0; i < blocks.length; i++) {
		it(`example ${i + 1} passes NotificationDecision validation`, () => {
			const obj = JSON.parse(blocks[i]!);

			expect(typeof obj.shouldNotify).toBe("boolean");
			expect(typeof obj.reasoning).toBe("string");
			expect(obj.reasoning.length).toBeGreaterThan(0);

			if (obj.shouldNotify) {
				expect(typeof obj.message).toBe("string");
				expect(obj.message.length).toBeGreaterThan(0);
			}
		});
	}
});

describe("Intent analysis example JSONs pass structural validation", () => {
	const rendered = intentAnalysisSystemPrompt({});
	const blocks = extractExampleJsonBlocks(rendered);

	const validIntents = [
		"new_task",
		"notification_preference",
		"status_query",
		"context_injection",
		"cancel",
		"approve_agent",
		"unknown",
	];

	it("has at least 4 example blocks", () => {
		expect(blocks.length).toBeGreaterThanOrEqual(4);
	});

	for (let i = 0; i < blocks.length; i++) {
		it(`example ${i + 1} passes IntentAnalysis validation`, () => {
			const obj = JSON.parse(blocks[i]!);

			expect(typeof obj.intent).toBe("string");
			expect(validIntents).toContain(obj.intent);
			expect(typeof obj.confidence).toBe("number");
			expect(obj.confidence).toBeGreaterThanOrEqual(0);
			expect(obj.confidence).toBeLessThanOrEqual(1);
			expect(typeof obj.reasoning).toBe("string");
			expect(typeof obj.parameters).toBe("object");
			expect(obj.parameters).not.toBeNull();
		});
	}
});

describe("Context analysis (notification) example JSONs pass structural validation", () => {
	const rendered = contextAnalysisSystemPrompt({});
	const blocks = extractExampleJsonBlocks(rendered);

	it("has at least 3 example blocks", () => {
		expect(blocks.length).toBeGreaterThanOrEqual(3);
	});

	for (let i = 0; i < blocks.length; i++) {
		it(`example ${i + 1} passes NotificationDecision validation`, () => {
			const obj = JSON.parse(blocks[i]!);

			expect(typeof obj.shouldNotify).toBe("boolean");
			expect(typeof obj.reasoning).toBe("string");
			expect(obj.reasoning.length).toBeGreaterThan(0);

			if (obj.shouldNotify) {
				expect(typeof obj.message).toBe("string");
				expect(obj.message.length).toBeGreaterThan(0);
			}
		});
	}
});

describe("Sharing analysis example JSONs pass structural validation", () => {
	const rendered = sharingAnalysisSystemPrompt({});
	const blocks = extractExampleJsonBlocks(rendered);

	it("has at least 3 example blocks", () => {
		expect(blocks.length).toBeGreaterThanOrEqual(3);
	});

	for (let i = 0; i < blocks.length; i++) {
		it(`example ${i + 1} passes SharingDecision validation`, () => {
			const obj = JSON.parse(blocks[i]!);

			expect(Array.isArray(obj.decisions)).toBe(true);

			for (const decision of obj.decisions) {
				expect(typeof decision.targetAgentId).toBe("string");
				expect(decision.targetAgentId.length).toBeGreaterThan(0);
				expect(typeof decision.shouldShare).toBe("boolean");
				expect(typeof decision.reasoning).toBe("string");
				expect(decision.reasoning.length).toBeGreaterThan(0);

				if (decision.shouldShare) {
					expect(typeof decision.information).toBe("string");
					expect(decision.information.length).toBeGreaterThan(0);
				}
			}
		});
	}
});

// ════════════════════════════════════════════════════════════════════════════
// Test 10: Non-regression — existing prompt content preserved
// ════════════════════════════════════════════════════════════════════════════

describe("Non-regression — existing prompt content preserved", () => {
	describe("Planning system prompt", () => {
		const rendered = planningSystemPrompt({});

		it("still contains strategy instructions", () => {
			expect(rendered).toContain('## When to use "single"');
			expect(rendered).toContain('## When to use "multi"');
		});

		it("still contains rules section", () => {
			expect(rendered).toContain("## Rules");
			expect(rendered).toContain(
				"NEVER force multi-agent when single suffices",
			);
		});

		it("still contains project context usage section", () => {
			expect(rendered).toContain("## Project Context Usage");
		});

		it("still contains JSON Schema section", () => {
			expect(rendered).toContain("## JSON Schema");
			expect(rendered).toContain('"strategy": "single" | "multi"');
		});

		it("still contains strategy count constraints", () => {
			expect(rendered).toContain(
				'For "single": exactly 1 subtask, no dependencies, parallelismBenefit=0.',
			);
			expect(rendered).toContain(
				'For "multi": 2+ subtasks with meaningful decomposition.',
			);
		});
	});

	describe("Batched sharing decision prompt", () => {
		const rendered = batchedSharingDecisionPrompt(mockBatchedSharingData);

		it("still contains source/target/delta sections", () => {
			expect(rendered).toContain("## Source Agent");
			expect(rendered).toContain("## Delta (new information)");
			expect(rendered).toContain("## Target Agents");
		});

		it("still contains criteria section", () => {
			expect(rendered).toContain("## Criteria");
			expect(rendered).toContain(
				"Is this genuinely useful for the target agent",
			);
		});

		it("still contains JSON Output section", () => {
			expect(rendered).toContain("## JSON Output");
		});

		it("still contains the deduplication criterion", () => {
			expect(rendered).toContain(
				"Has similar or identical information already been shared",
			);
		});
	});

	describe("Sharing decision prompt", () => {
		const rendered = sharingDecisionPrompt(mockSharingData);

		it("still contains source/target/delta/criteria/JSON Output sections", () => {
			expect(rendered).toContain("## Source Agent");
			expect(rendered).toContain("## Target Agent");
			expect(rendered).toContain("## Delta (new information)");
			expect(rendered).toContain("## Criteria");
			expect(rendered).toContain("## JSON Output");
		});
	});

	describe("Notification decision prompt", () => {
		const rendered = notificationDecisionPrompt(mockNotificationData);

		it("does not contain removed sections (User Preference, Delta, Criteria)", () => {
			expect(rendered).not.toContain("## User Preference");
			expect(rendered).not.toContain("## Delta");
			expect(rendered).not.toContain("## Criteria");
		});

		it("contains new semantic framing and sections", () => {
			expect(rendered).toContain("already passed significance");
			expect(rendered).toContain("## What Happened");
			expect(rendered).toContain("## Agent's Task");
			expect(rendered).toContain("## Decision Guide");
			expect(rendered).toContain("## JSON Output");
		});
	});

	describe("Intent analysis system prompt", () => {
		const rendered = intentAnalysisSystemPrompt({});

		it("still contains intent definitions", () => {
			expect(rendered).toContain("- **new_task**:");
			expect(rendered).toContain("- **status_query**:");
			expect(rendered).toContain("- **cancel**:");
			expect(rendered).toContain("- **approve_agent**:");
			expect(rendered).toContain("- **context_injection**:");
			expect(rendered).toContain("- **unknown**:");
		});

		it("still contains approve_agent rules", () => {
			expect(rendered).toContain("## approve_agent Rules");
		});

		it("still contains JSON Output section", () => {
			expect(rendered).toContain("## JSON Output");
		});
	});

	describe("Context analysis system prompt (notifications)", () => {
		const rendered = contextAnalysisSystemPrompt({});

		it("is specialized for notifications", () => {
			expect(rendered).toContain("notification evaluator");
			expect(rendered).toContain("## Guiding Principle: Silence by Default");
		});

		it("does not contain share or clarify as actions", () => {
			expect(rendered).not.toContain('"action": "share"');
			expect(rendered).not.toContain('"action": "clarify"');
		});

		it("still contains JSON Output section", () => {
			expect(rendered).toContain("## JSON Output");
		});

		it("uses shouldNotify format", () => {
			expect(rendered).toContain('"shouldNotify"');
		});
	});

	describe("Sharing analysis system prompt", () => {
		const rendered = sharingAnalysisSystemPrompt({});

		it("is specialized for cross-agent sharing", () => {
			expect(rendered).toContain("cross-agent information sharing specialist");
		});

		it("contains dependency type instructions", () => {
			expect(rendered).toContain("## Dependency types");
			expect(rendered).toContain("**blocking**");
			expect(rendered).toContain("**informational**");
		});

		it("contains deduplication instructions", () => {
			expect(rendered).toContain("previouslyShared");
		});

		it("does not contain notify or clarify as actions", () => {
			expect(rendered).not.toContain('"shouldNotify"');
			expect(rendered).not.toContain('"action": "clarify"');
		});

		it("still contains JSON Output Format section", () => {
			expect(rendered).toContain("## JSON Output Format");
		});
	});

	describe("Summary system prompt", () => {
		const rendered = summarySystemPrompt({});

		it("still mentions the orchestration system role", () => {
			expect(rendered).toContain(
				"technical summarizer for an AI agent orchestration system",
			);
		});

		it("still ends with no-JSON instruction", () => {
			expect(rendered).toContain("No JSON.");
		});

		it("still mentions plain text with Markdown", () => {
			expect(rendered).toContain("Respond in plain text with Markdown");
		});
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Test 11: Examples use contrastive patterns
// ════════════════════════════════════════════════════════════════════════════

describe("Contrastive example patterns", () => {
	it("planning has both single and multi examples", () => {
		const rendered = planningSystemPrompt({});
		expect(rendered).toContain('"strategy": "single"');
		expect(rendered).toContain('"strategy": "multi"');
	});

	it("sharing decision has both share and don't-share examples", () => {
		const rendered = sharingDecisionPrompt(mockSharingData);
		expect(rendered).toContain('"shouldShare": true');
		expect(rendered).toContain('"shouldShare": false');
	});

	it("batched sharing has both share and don't-share examples", () => {
		const rendered = batchedSharingDecisionPrompt(mockBatchedSharingData);
		expect(rendered).toContain('"shouldShare": true');
		expect(rendered).toContain('"shouldShare": false');
	});

	it("notification has both notify and don't-notify examples", () => {
		const rendered = notificationDecisionPrompt(mockNotificationData);
		expect(rendered).toContain('"shouldNotify": true');
		expect(rendered).toContain('"shouldNotify": false');
	});

	it("context analysis (notifications) has both notify and don't-notify examples", () => {
		const rendered = contextAnalysisSystemPrompt({});
		expect(rendered).toContain('"shouldNotify": true');
		expect(rendered).toContain('"shouldNotify": false');
	});

	it("sharing analysis has both share and don't-share examples", () => {
		const rendered = sharingAnalysisSystemPrompt({});
		expect(rendered).toContain('"shouldShare": true');
		expect(rendered).toContain('"shouldShare": false');
	});

	it("summary has success and partial failure examples", () => {
		const rendered = summarySystemPrompt({});
		expect(rendered).toContain("completed successfully");
		expect(rendered).toContain("Partially succeeded");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Test 12: Example blocks use clear delimiters
// ════════════════════════════════════════════════════════════════════════════

describe("Example blocks use clear delimiters", () => {
	const promptsWithExamples: Array<{ name: string; text: string }> = [
		{ name: "planning system", text: planningSystemPrompt({}) },
		{
			name: "batched sharing",
			text: batchedSharingDecisionPrompt(mockBatchedSharingData),
		},
		{
			name: "sharing decision",
			text: sharingDecisionPrompt(mockSharingData),
		},
		{
			name: "notification decision",
			text: notificationDecisionPrompt(mockNotificationData),
		},
		{ name: "intent analysis", text: intentAnalysisSystemPrompt({}) },
		{
			name: "context analysis (notifications)",
			text: contextAnalysisSystemPrompt({}),
		},
		{ name: "sharing analysis", text: sharingAnalysisSystemPrompt({}) },
		{ name: "summary", text: summarySystemPrompt({}) },
	];

	for (const { name, text } of promptsWithExamples) {
		it(`${name} prompt uses '## Examples' or '### Example' headers`, () => {
			const hasExamplesHeader =
				text.includes("## Examples") || text.includes("## Example");
			const hasSubHeaders =
				text.includes("### Example") ||
				text.includes("### Share") ||
				text.includes("### Don't share") ||
				text.includes("### Notify") ||
				text.includes("### Don't notify") ||
				text.includes("### Ignore") ||
				text.includes("### Anti-pattern");
			expect(hasExamplesHeader || hasSubHeaders).toBe(true);
		});
	}
});
