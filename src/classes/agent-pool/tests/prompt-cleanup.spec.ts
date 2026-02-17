import { describe, expect, it, mock } from "bun:test";

import { AgentStatus } from "../../../enums/agent-status.enum.ts";
import { DeltaType } from "../../../enums/delta-type.enum.ts";
import {
	notificationDecisionPrompt,
	summaryPrompt,
} from "../../../prompts/index.ts";
import type {
	AgentContextState,
	ContextDelta,
	CoordinationStats,
} from "../../../types/agent-pool.types.ts";
import { NotificationEngine } from "../notification-engine.ts";
import { silentLogger } from "./test-helpers.ts";

// ════════════════════════════════════════════════════════════════════════════
// Helper: build mock data
// ════════════════════════════════════════════════════════════════════════════

function makeDelta(overrides?: Partial<ContextDelta>): ContextDelta {
	return {
		agentId: "agent-1",
		agentName: "Alpha",
		timestamp: new Date().toISOString(),
		type: DeltaType.PROMPT_COMPLETE,
		summary: "Prompt completed",
		data: {},
		significance: 0.8,
		...overrides,
	};
}

function makeAgentState(
	overrides?: Partial<AgentContextState>,
): AgentContextState {
	return {
		agentId: "agent-1",
		agentName: "Alpha",
		taskDescription: "Build the API",
		taskRole: "api-developer",
		status: AgentStatus.IDLE,
		events: [],
		promptResults: [],
		lastDelta: null,
		filesWritten: [],
		filesRead: [],
		completed: false,
		error: null,
		...overrides,
	};
}

function makeSummaryData(overrides?: Record<string, unknown>) {
	return {
		task: "Build a REST API with tests",
		strategy: "multi",
		complexity: "complex",
		planningReasoning: "Task has separable concerns",
		agents: [
			{
				agentName: "api-dev",
				subtask: {
					id: "s1",
					prompt: "Build the REST API endpoints with Express.js",
					role: "api-developer",
					dependencies: [],
					priority: 1,
				},
				success: true,
				error: undefined,
				promptResult: {
					text: "Done building API",
					stopReason: "end_turn",
					usage: null,
				},
				filesWritten: ["src/routes/users.ts"],
				events: [],
			},
			{
				agentName: "test-writer",
				subtask: {
					id: "s2",
					prompt: "Write tests for the API",
					role: "test-writer",
					dependencies: ["s1"],
					priority: 2,
				},
				success: true,
				error: undefined,
				promptResult: {
					text: "Tests written",
					stopReason: "end_turn",
					usage: null,
				},
				filesWritten: ["tests/users.test.ts"],
				events: [
					{
						type: "tool_complete",
						timestamp: new Date().toISOString(),
						summary: "jest ran",
						data: {},
					},
				],
			},
		],
		durationMs: 12345,
		coordination: null as CoordinationStats | null,
		...overrides,
	};
}

// ════════════════════════════════════════════════════════════════════════════
// Test 1: Notification prompt no longer contains User Preference section
// ════════════════════════════════════════════════════════════════════════════

describe("Notification prompt — removed redundant sections", () => {
	const rendered = notificationDecisionPrompt({
		delta: {
			agentName: "TestAgent",
			agentRole: "api-developer",
			type: "prompt_complete",
			summary: "Agent completed a prompt",
			significance: 0.8,
		},
		agentTask: "Build a REST API",
		otherAgentsContext: null,
	});

	it("does NOT contain ## User Preference section", () => {
		expect(rendered).not.toContain("## User Preference");
	});

	it("does NOT contain 'Enabled' as a section label", () => {
		expect(rendered).not.toContain("**Enabled**:");
	});

	it("does NOT contain 'Min Significance' as a section label", () => {
		expect(rendered).not.toContain("**Min Significance**:");
	});

	it("does NOT contain redundant criteria about significance threshold", () => {
		expect(rendered).not.toContain("Does delta meet minimum significance");
	});

	it("does NOT contain redundant criteria about type matching", () => {
		expect(rendered).not.toContain("Does delta type match user's interests");
	});

	it("does NOT contain the old ## Delta section header", () => {
		expect(rendered).not.toContain("## Delta");
	});

	it("does NOT contain the old ## Criteria section header", () => {
		expect(rendered).not.toContain("## Criteria");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Test 2: Notification prompt contains semantic framing
// ════════════════════════════════════════════════════════════════════════════

describe("Notification prompt — semantic framing", () => {
	const rendered = notificationDecisionPrompt({
		delta: {
			agentName: "TestAgent",
			agentRole: "test-writer",
			type: "prompt_complete",
			summary: "Tests passed",
			significance: 0.8,
		},
		agentTask: "Write comprehensive tests",
		otherAgentsContext: null,
	});

	it("contains 'already passed' framing about pre-filters", () => {
		expect(rendered).toContain("already passed significance");
	});

	it("contains 'purely semantic' or 'semantic' wording", () => {
		expect(rendered).toContain("semantic");
	});

	it("contains the significance value in the framing", () => {
		expect(rendered).toContain("0.8");
	});

	it("contains ## Decision Guide section", () => {
		expect(rendered).toContain("## Decision Guide");
	});

	it("contains ## What Happened section", () => {
		expect(rendered).toContain("## What Happened");
	});

	it("contains ## Agent's Task section", () => {
		expect(rendered).toContain("## Agent's Task");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Test 3: Notification prompt includes agentRole
// ════════════════════════════════════════════════════════════════════════════

describe("Notification prompt — agentRole", () => {
	it("includes the agentRole with the 'role:' label", () => {
		const rendered = notificationDecisionPrompt({
			delta: {
				agentName: "TestAgent",
				agentRole: "test-writer",
				type: "prompt_complete",
				summary: "Tests passed",
				significance: 0.9,
			},
			agentTask: "Write tests",
			otherAgentsContext: null,
		});

		expect(rendered).toContain("test-writer");
		expect(rendered).toContain("role:");
	});

	it("renders different role values correctly", () => {
		const rendered = notificationDecisionPrompt({
			delta: {
				agentName: "DocBot",
				agentRole: "documentation-author",
				type: "prompt_complete",
				summary: "Docs written",
				significance: 0.7,
			},
			agentTask: "Write docs",
			otherAgentsContext: null,
		});

		expect(rendered).toContain("documentation-author");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Test 4: otherAgentsContext is omitted when null
// ════════════════════════════════════════════════════════════════════════════

describe("Notification prompt — otherAgentsContext omission", () => {
	it("does NOT contain ## Broader Context when otherAgentsContext is null", () => {
		const rendered = notificationDecisionPrompt({
			delta: {
				agentName: "TestAgent",
				agentRole: "api-developer",
				type: "prompt_complete",
				summary: "Done",
				significance: 0.8,
			},
			agentTask: "Build API",
			otherAgentsContext: null,
		});

		expect(rendered).not.toContain("## Broader Context");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Test 5: otherAgentsContext is included when provided
// ════════════════════════════════════════════════════════════════════════════

describe("Notification prompt — otherAgentsContext inclusion", () => {
	it("contains ## Broader Context when otherAgentsContext is provided", () => {
		const rendered = notificationDecisionPrompt({
			delta: {
				agentName: "TestAgent",
				agentRole: "api-developer",
				type: "prompt_complete",
				summary: "Done",
				significance: 0.8,
			},
			agentTask: "Build API",
			otherAgentsContext:
				"2 other agents are active: test-writer (running), docs-author (idle)",
		});

		expect(rendered).toContain("## Broader Context");
		expect(rendered).toContain("2 other agents are active");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Test 6: Summary prompt includes coordination section when provided
// ════════════════════════════════════════════════════════════════════════════

describe("Summary prompt — coordination stats included", () => {
	const coordination: CoordinationStats = {
		deltaCount: 15,
		sharingEvaluationCount: 8,
		sharingApprovedCount: 3,
		notificationCount: 2,
		sharingSummaries: [
			{
				sourceAgentName: "api-dev",
				targetAgentName: "test-writer",
				informationPreview:
					"API endpoints: GET /users, POST /users, PUT /users/:id",
			},
			{
				sourceAgentName: "api-dev",
				targetAgentName: "docs-author",
				informationPreview: "User model schema with validation rules",
			},
		],
	};

	const rendered = summaryPrompt(makeSummaryData({ coordination }));

	it("contains ## Inter-Agent Coordination section", () => {
		expect(rendered).toContain("## Inter-Agent Coordination");
	});

	it("contains 'Deltas detected' with the correct count", () => {
		expect(rendered).toContain("Deltas detected");
		expect(rendered).toContain("15");
	});

	it("contains 'Information shared' with count and 'time(s)' format", () => {
		expect(rendered).toContain("Information shared");
		expect(rendered).toContain("3 time(s)");
	});

	it("contains 'Sharing evaluations' with the correct count", () => {
		expect(rendered).toContain("Sharing evaluations");
		expect(rendered).toContain("8");
	});

	it("contains 'User notifications' with the correct count", () => {
		expect(rendered).toContain("User notifications");
		expect(rendered).toContain("2");
	});

	it("contains ### Information Flow section", () => {
		expect(rendered).toContain("### Information Flow");
	});

	it("displays sharing summaries with source → target format", () => {
		expect(rendered).toContain("**api-dev**");
		expect(rendered).toContain("**test-writer**");
		expect(rendered).toContain("→");
		expect(rendered).toContain("API endpoints");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Test 7: Summary prompt omits coordination when null
// ════════════════════════════════════════════════════════════════════════════

describe("Summary prompt — coordination omitted when null", () => {
	const rendered = summaryPrompt(makeSummaryData({ coordination: null }));

	it("does NOT contain ## Inter-Agent Coordination", () => {
		expect(rendered).not.toContain("## Inter-Agent Coordination");
	});

	it("does NOT contain ### Information Flow", () => {
		expect(rendered).not.toContain("### Information Flow");
	});

	it("does NOT contain 'Deltas detected'", () => {
		expect(rendered).not.toContain("Deltas detected");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Test 8: Summary prompt includes durationMs with real value
// ════════════════════════════════════════════════════════════════════════════

describe("Summary prompt — durationMs", () => {
	it("includes the actual durationMs value", () => {
		const rendered = summaryPrompt(makeSummaryData({ durationMs: 12345 }));
		expect(rendered).toContain("12345ms");
	});

	it("shows a different value when durationMs changes", () => {
		const rendered = summaryPrompt(makeSummaryData({ durationMs: 98765 }));
		expect(rendered).toContain("98765ms");
		expect(rendered).not.toContain("0ms");
	});

	it("includes the durationMs in the Duration label", () => {
		const rendered = summaryPrompt(makeSummaryData({ durationMs: 5000 }));
		expect(rendered).toContain("**Duration**: 5000ms");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Test 9: Sharing summaries displayed with source → target format
// ════════════════════════════════════════════════════════════════════════════

describe("Summary prompt — sharingSummaries format", () => {
	it("displays each sharing event with bold source → bold target", () => {
		const coordination: CoordinationStats = {
			deltaCount: 5,
			sharingEvaluationCount: 3,
			sharingApprovedCount: 1,
			notificationCount: 0,
			sharingSummaries: [
				{
					sourceAgentName: "api-dev",
					targetAgentName: "test-writer",
					informationPreview: "API endpoints defined: GET /users, POST /users",
				},
			],
		};

		const rendered = summaryPrompt(makeSummaryData({ coordination }));

		expect(rendered).toContain("**api-dev** → **test-writer**");
		expect(rendered).toContain("API endpoints defined");
	});

	it("omits Information Flow section when sharingSummaries is empty", () => {
		const coordination: CoordinationStats = {
			deltaCount: 5,
			sharingEvaluationCount: 3,
			sharingApprovedCount: 0,
			notificationCount: 0,
			sharingSummaries: [],
		};

		const rendered = summaryPrompt(makeSummaryData({ coordination }));

		expect(rendered).toContain("## Inter-Agent Coordination");
		expect(rendered).not.toContain("### Information Flow");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Test 10: NotificationEngine.evaluateWithLlm sends correct data
// ════════════════════════════════════════════════════════════════════════════

describe("NotificationEngine — prompt data sent to LLM", () => {
	it("sends agentRole from agentState.taskRole in the prompt", async () => {
		let capturedPrompt = "";
		const mockConversations = {
			sendOneShotJson: mock(
				(
					_role: string,
					prompt: string,
					_validator: unknown,
					_options: unknown,
				) => {
					capturedPrompt = prompt;
					return Promise.resolve({
						shouldNotify: false,
						reasoning: "routine",
						message: "",
					});
				},
			),
		} as any;

		const engine = new NotificationEngine(mockConversations, silentLogger());
		engine.setPreference({ enabled: true, minSignificance: 0.3 });

		const delta = makeDelta({ significance: 0.8 });
		const agentState = makeAgentState({ taskRole: "test-writer" });

		await engine.evaluate(delta, agentState);

		expect(capturedPrompt).toContain("test-writer");
		expect(capturedPrompt).toContain("role:");
	});

	it("does NOT include preference.enabled in the prompt", async () => {
		let capturedPrompt = "";
		const mockConversations = {
			sendOneShotJson: mock(
				(
					_role: string,
					prompt: string,
					_validator: unknown,
					_options: unknown,
				) => {
					capturedPrompt = prompt;
					return Promise.resolve({
						shouldNotify: false,
						reasoning: "routine",
						message: "",
					});
				},
			),
		} as any;

		const engine = new NotificationEngine(mockConversations, silentLogger());
		engine.setPreference({ enabled: true, minSignificance: 0.5 });

		await engine.evaluate(makeDelta({ significance: 0.8 }), makeAgentState());

		expect(capturedPrompt).not.toContain("**Enabled**:");
		expect(capturedPrompt).not.toContain("## User Preference");
		expect(capturedPrompt).not.toContain("**Min Significance**:");
	});

	it("includes the semantic framing in the prompt sent to LLM", async () => {
		let capturedPrompt = "";
		const mockConversations = {
			sendOneShotJson: mock(
				(
					_role: string,
					prompt: string,
					_validator: unknown,
					_options: unknown,
				) => {
					capturedPrompt = prompt;
					return Promise.resolve({
						shouldNotify: false,
						reasoning: "routine",
						message: "",
					});
				},
			),
		} as any;

		const engine = new NotificationEngine(mockConversations, silentLogger());
		engine.setPreference({ enabled: true, minSignificance: 0.3 });

		await engine.evaluate(makeDelta({ significance: 0.9 }), makeAgentState());

		expect(capturedPrompt).toContain("already passed significance");
		expect(capturedPrompt).toContain("semantic");
		expect(capturedPrompt).toContain("## Decision Guide");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Test: Summary prompt includes system prompt structure reference
// ════════════════════════════════════════════════════════════════════════════

describe("Summary prompt — structure reference", () => {
	it("includes reference to system prompt structure", () => {
		const rendered = summaryPrompt(makeSummaryData());
		expect(rendered).toContain(
			"following the structure defined in your system prompt",
		);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Test: Summary prompt renders agent results correctly
// ════════════════════════════════════════════════════════════════════════════

describe("Summary prompt — agent results rendering", () => {
	const rendered = summaryPrompt(makeSummaryData());

	it("includes agent names and roles", () => {
		expect(rendered).toContain("api-dev");
		expect(rendered).toContain("api-developer");
		expect(rendered).toContain("test-writer");
	});

	it("includes file information", () => {
		expect(rendered).toContain("src/routes/users.ts");
		expect(rendered).toContain("tests/users.test.ts");
	});

	it("includes success status", () => {
		expect(rendered).toContain("**Success**: true");
	});

	it("includes agent count", () => {
		expect(rendered).toContain("**Agents**: 2");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Test: CoordinationStats type structure
// ════════════════════════════════════════════════════════════════════════════

describe("CoordinationStats — type structure", () => {
	it("can be constructed with all required fields", () => {
		const stats: CoordinationStats = {
			deltaCount: 10,
			sharingEvaluationCount: 5,
			sharingApprovedCount: 2,
			notificationCount: 1,
			sharingSummaries: [
				{
					sourceAgentName: "src",
					targetAgentName: "tgt",
					informationPreview: "preview text",
				},
			],
		};

		expect(stats.deltaCount).toBe(10);
		expect(stats.sharingEvaluationCount).toBe(5);
		expect(stats.sharingApprovedCount).toBe(2);
		expect(stats.notificationCount).toBe(1);
		expect(stats.sharingSummaries).toHaveLength(1);
		expect(stats.sharingSummaries[0]!.sourceAgentName).toBe("src");
	});

	it("allows empty sharingSummaries array", () => {
		const stats: CoordinationStats = {
			deltaCount: 0,
			sharingEvaluationCount: 0,
			sharingApprovedCount: 0,
			notificationCount: 0,
			sharingSummaries: [],
		};

		expect(stats.sharingSummaries).toHaveLength(0);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Test: Notification prompt backward compatibility
// ════════════════════════════════════════════════════════════════════════════

describe("Notification prompt — backward compatibility", () => {
	it("Handlebars silently ignores extra fields passed to the template", () => {
		// Passing old-format data with preference should not throw
		const rendered = notificationDecisionPrompt({
			preference: {
				enabled: true,
				minSignificance: 0.5,
				types: ["prompt_complete"],
			},
			delta: {
				agentName: "TestAgent",
				agentRole: "developer",
				agentId: "agent-id-123",
				type: "prompt_complete",
				summary: "Done",
				significance: 0.8,
			},
			agentTask: "Build something",
			otherAgentsContext: null,
		});

		// Template should still render correctly
		expect(rendered).toContain("## What Happened");
		expect(rendered).toContain("TestAgent");
		// Old fields are silently ignored by Handlebars
		expect(rendered).not.toContain("## User Preference");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Test: Notification prompt examples are still valid JSON
// ════════════════════════════════════════════════════════════════════════════

describe("Notification prompt — example JSON validity after rewrite", () => {
	const rendered = notificationDecisionPrompt({
		delta: {
			agentName: "TestAgent",
			agentRole: "developer",
			type: "prompt_complete",
			summary: "Done",
			significance: 0.8,
		},
		agentTask: "Build something",
		otherAgentsContext: null,
	});

	it("still contains both notify and don't-notify examples", () => {
		expect(rendered).toContain('"shouldNotify": true');
		expect(rendered).toContain('"shouldNotify": false');
	});

	it("all example JSON blocks in the Examples section parse successfully", () => {
		// Extract the examples section
		const examplesStart = rendered.indexOf("## Examples");
		const jsonOutputStart = rendered.indexOf("## JSON Output");
		expect(examplesStart).toBeGreaterThan(-1);
		expect(jsonOutputStart).toBeGreaterThan(examplesStart);

		const examplesSection = rendered.slice(examplesStart, jsonOutputStart);

		// Extract JSON blocks
		const blocks: string[] = [];
		let depth = 0;
		let start = -1;
		for (let i = 0; i < examplesSection.length; i++) {
			const ch = examplesSection[i];
			if (ch === "{") {
				if (depth === 0) start = i;
				depth++;
			} else if (ch === "}") {
				depth--;
				if (depth === 0 && start !== -1) {
					blocks.push(examplesSection.slice(start, i + 1));
					start = -1;
				}
			}
		}

		expect(blocks.length).toBeGreaterThanOrEqual(3);

		for (const block of blocks) {
			const parsed = JSON.parse(block);
			expect(typeof parsed.shouldNotify).toBe("boolean");
			expect(typeof parsed.reasoning).toBe("string");
			expect(parsed.reasoning.length).toBeGreaterThan(0);
		}
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Test: Summary prompt with multiple sharing summaries
// ════════════════════════════════════════════════════════════════════════════

describe("Summary prompt — multiple sharing summaries", () => {
	it("renders all sharing summaries", () => {
		const coordination: CoordinationStats = {
			deltaCount: 20,
			sharingEvaluationCount: 10,
			sharingApprovedCount: 3,
			notificationCount: 1,
			sharingSummaries: [
				{
					sourceAgentName: "agent-a",
					targetAgentName: "agent-b",
					informationPreview: "First sharing event",
				},
				{
					sourceAgentName: "agent-b",
					targetAgentName: "agent-c",
					informationPreview: "Second sharing event",
				},
				{
					sourceAgentName: "agent-a",
					targetAgentName: "agent-c",
					informationPreview: "Third sharing event",
				},
			],
		};

		const rendered = summaryPrompt(makeSummaryData({ coordination }));

		expect(rendered).toContain("**agent-a** → **agent-b**");
		expect(rendered).toContain("**agent-b** → **agent-c**");
		expect(rendered).toContain("**agent-a** → **agent-c**");
		expect(rendered).toContain("First sharing event");
		expect(rendered).toContain("Second sharing event");
		expect(rendered).toContain("Third sharing event");
	});
});
