import { describe, expect, it, mock } from "bun:test";
import { AgentStatus } from "../../../enums/agent-status.enum.ts";
import { ConversationRole } from "../../../enums/conversation-role.enum.ts";
import { DeltaType } from "../../../enums/delta-type.enum.ts";
import {
	contextAnalysisSystemPrompt,
	sharingAnalysisSystemPrompt,
} from "../../../prompts/index.ts";
import type { ContextDelta, SubTask } from "../../../types/agent-pool.types.ts";
import { ContextTracker } from "../context-tracker.ts";
import { InformationBroker } from "../information-broker.ts";
import { NotificationEngine } from "../notification-engine.ts";
import { silentLogger } from "./test-helpers.ts";

// ════════════════════════════════════════════════════════════════════════════
// Évolution 05 — Separation of CONTEXT_ANALYZER and SHARING_ANALYZER
// ════════════════════════════════════════════════════════════════════════════

// ── Test 1: sharingAnalysisSystemPrompt compiles ───────────────────────────

describe("sharingAnalysisSystemPrompt compilation", () => {
	const rendered = sharingAnalysisSystemPrompt({});

	it("returns a non-empty string", () => {
		expect(typeof rendered).toBe("string");
		expect(rendered.length).toBeGreaterThan(0);
	});

	it("contains cross-agent sharing identity", () => {
		expect(rendered).toContain("cross-agent information sharing");
	});

	it("does not contain notify as a recommendable action", () => {
		// The word "notify" may appear in negation ("you do NOT notify")
		// but shouldNotify should never appear as a JSON field
		expect(rendered).not.toContain('"shouldNotify"');
		expect(rendered).not.toContain('"action": "notify"');
	});

	it("does not contain clarify", () => {
		expect(rendered).not.toContain("clarify");
	});
});

// ── Test 2: contextAnalysisSystemPrompt is specialized for notifications ───

describe("contextAnalysisSystemPrompt is specialized for notifications", () => {
	const rendered = contextAnalysisSystemPrompt({});

	it("returns a non-empty string", () => {
		expect(typeof rendered).toBe("string");
		expect(rendered.length).toBeGreaterThan(0);
	});

	it("contains notification-related terms", () => {
		expect(rendered).toContain("notification");
	});

	it("does not contain share as a recommendable action", () => {
		expect(rendered).not.toContain('"action": "share"');
		expect(rendered).not.toContain('"shouldShare"');
	});

	it("does not contain clarify", () => {
		expect(rendered).not.toContain("clarify");
	});

	it("contains shouldNotify in expected JSON format", () => {
		expect(rendered).toContain('"shouldNotify"');
	});

	it("contains Silence by Default guiding principle", () => {
		expect(rendered).toContain("Silence by Default");
	});
});

// ── Test 3: The two system prompts are distinct ────────────────────────────

describe("System prompts are distinct", () => {
	const notificationPrompt = contextAnalysisSystemPrompt({});
	const sharingPrompt = sharingAnalysisSystemPrompt({});

	it("produces different output", () => {
		expect(notificationPrompt).not.toBe(sharingPrompt);
	});

	it("has different introductions", () => {
		const notifFirstLine = notificationPrompt.split("\n")[0]!;
		const sharingFirstLine = sharingPrompt.split("\n")[0]!;
		expect(notifFirstLine).not.toBe(sharingFirstLine);
	});

	it("notification prompt mentions notification evaluator", () => {
		expect(notificationPrompt).toContain("notification evaluator");
	});

	it("sharing prompt mentions sharing specialist", () => {
		expect(sharingPrompt).toContain("sharing specialist");
	});
});

// ── Test 4: SHARING_ANALYZER exists in enum ────────────────────────────────

describe("ConversationRole.SHARING_ANALYZER", () => {
	it("is defined", () => {
		expect(ConversationRole.SHARING_ANALYZER).toBeDefined();
	});

	it("has the value 'sharing-analyzer'", () => {
		expect(ConversationRole.SHARING_ANALYZER as string).toBe(
			"sharing-analyzer",
		);
	});

	it("is distinct from all other roles", () => {
		const allValues = Object.values(ConversationRole);
		const unique = new Set(allValues);
		expect(unique.size).toBe(allValues.length);
	});

	it("CONTEXT_ANALYZER still exists and is distinct", () => {
		expect(ConversationRole.CONTEXT_ANALYZER as string).toBe(
			"context-analyzer",
		);
		expect(ConversationRole.SHARING_ANALYZER as string).not.toBe(
			ConversationRole.CONTEXT_ANALYZER as string,
		);
	});
});

// ── Test 5: InformationBroker.evaluateBatch() uses SHARING_ANALYZER ───────

describe("InformationBroker uses SHARING_ANALYZER", () => {
	it("calls sendOneShotJson with SHARING_ANALYZER role", async () => {
		const capturedRoles: string[] = [];

		const mockConversations = {
			sendOneShotJson: mock(
				(role: ConversationRole, _prompt: string, ..._rest: unknown[]) => {
					capturedRoles.push(role as string);
					return Promise.resolve([
						{
							targetAgentId: "agent-beta",
							shouldShare: false,
							reasoning: "Not relevant",
							information: "",
						},
					]);
				},
			),
		} as any;

		const tracker = new ContextTracker();

		const subtask1: SubTask = {
			id: "subtask-1",
			prompt: "Build API",
			role: "api-dev",
			dependencies: [],
			priority: 1,
		};
		const subtask2: SubTask = {
			id: "subtask-2",
			prompt: "Write tests",
			role: "test-writer",
			dependencies: ["subtask-1"],
			priority: 2,
		};

		const subtaskToAgent = new Map([
			["subtask-1", "agent-alpha"],
			["subtask-2", "agent-beta"],
		]);
		const agentToSubtask = new Map([
			["agent-alpha", "subtask-1"],
			["agent-beta", "subtask-2"],
		]);

		const broker = new InformationBroker(
			mockConversations,
			tracker,
			[{ from: "subtask-1", to: "subtask-2", type: "blocking" }],
			silentLogger(),
			subtaskToAgent,
			agentToSubtask,
		);

		// Register agents in the tracker
		tracker.registerAgent("agent-alpha", "Alpha", subtask1);
		tracker.registerAgent("agent-beta", "Beta", subtask2);

		const delta: ContextDelta = {
			agentId: "agent-alpha",
			agentName: "Alpha",
			timestamp: new Date().toISOString(),
			type: DeltaType.PROMPT_COMPLETE,
			summary: "Completed API implementation",
			data: { responsePreview: "All endpoints ready" },
			significance: 0.9,
			promptResultSummary: null,
		};

		await broker.evaluate(delta);

		// Verify the role used
		expect(mockConversations.sendOneShotJson).toHaveBeenCalledTimes(1);
		expect(capturedRoles).toHaveLength(1);
		expect(capturedRoles[0]).toBe(ConversationRole.SHARING_ANALYZER as string);
		expect(capturedRoles[0]).not.toBe(
			ConversationRole.CONTEXT_ANALYZER as string,
		);
	});
});

// ── Test 6: NotificationEngine.evaluateWithLlm() uses CONTEXT_ANALYZER ────

describe("NotificationEngine uses CONTEXT_ANALYZER", () => {
	it("calls sendOneShotJson with CONTEXT_ANALYZER role", async () => {
		const capturedRoles: string[] = [];

		const mockConversations = {
			sendOneShotJson: mock(
				(role: ConversationRole, _prompt: string, ..._rest: unknown[]) => {
					capturedRoles.push(role as string);
					return Promise.resolve({
						shouldNotify: true,
						reasoning: "Important milestone",
						message: "Task completed successfully",
					});
				},
			),
		} as any;

		const engine = new NotificationEngine(mockConversations, silentLogger());
		engine.setPreference({ enabled: true, minSignificance: 0.3 });

		const delta: ContextDelta = {
			agentId: "agent-1",
			agentName: "Alpha",
			timestamp: new Date().toISOString(),
			type: DeltaType.PROMPT_COMPLETE,
			summary: "Prompt completed",
			data: {},
			significance: 0.8,
			promptResultSummary: null,
		};

		await engine.evaluate(delta, {
			agentId: "agent-1",
			agentName: "Alpha",
			taskDescription: "Build the API",
			taskRole: "api-developer",
			status: AgentStatus.IDLE,
			events: [],
			promptResults: [],
			lastDelta: delta,
			filesWritten: [],
			filesRead: [],
			completed: false,
			error: null,
		});

		expect(mockConversations.sendOneShotJson).toHaveBeenCalledTimes(1);
		expect(capturedRoles).toHaveLength(1);
		expect(capturedRoles[0]).toBe(ConversationRole.CONTEXT_ANALYZER as string);
		expect(capturedRoles[0]).not.toBe(
			ConversationRole.SHARING_ANALYZER as string,
		);
	});
});

// ── Test 9: Backward compatibility — config without SHARING_ANALYZER override

describe("Backward compatibility", () => {
	it("sharing analysis prompt compiles without arguments", () => {
		const rendered = sharingAnalysisSystemPrompt({});
		expect(rendered.length).toBeGreaterThan(0);
	});

	it("context analysis prompt compiles without arguments (backward compat)", () => {
		const rendered = contextAnalysisSystemPrompt({});
		expect(rendered.length).toBeGreaterThan(0);
	});

	it("modelOverrides type accepts SHARING_ANALYZER key", () => {
		// TypeScript compilation test — if this compiles, the type accepts the key
		const overrides: Partial<Record<ConversationRole, string>> = {
			[ConversationRole.SHARING_ANALYZER]: "anthropic/claude-sonnet-4",
			[ConversationRole.CONTEXT_ANALYZER]: "google/gemini-flash-1.5",
		};

		expect(overrides[ConversationRole.SHARING_ANALYZER]).toBe(
			"anthropic/claude-sonnet-4",
		);
		expect(overrides[ConversationRole.CONTEXT_ANALYZER]).toBe(
			"google/gemini-flash-1.5",
		);
	});
});

// ── Test: Sharing system prompt content quality ────────────────────────────

describe("Sharing system prompt content quality", () => {
	const rendered = sharingAnalysisSystemPrompt({});

	it("contains dependency type instructions (blocking vs informational)", () => {
		expect(rendered).toContain("## Dependency types");
		expect(rendered).toContain("**blocking**");
		expect(rendered).toContain("**informational**");
	});

	it("contains previouslyShared deduplication instructions", () => {
		expect(rendered).toContain("previouslyShared");
	});

	it("contains When to share section", () => {
		expect(rendered).toContain("## When to share");
	});

	it("contains When NOT to share section", () => {
		expect(rendered).toContain("## When NOT to share");
	});

	it("contains Decision Framework section", () => {
		expect(rendered).toContain("## Decision Framework");
	});

	it("mentions all 5 evaluation criteria", () => {
		expect(rendered).toContain("**Relevance**");
		expect(rendered).toContain("**Actionability**");
		expect(rendered).toContain("**Timing**");
		expect(rendered).toContain("**Novelty**");
		expect(rendered).toContain("**Distillation**");
	});

	it("contains JSON output format with decisions array", () => {
		expect(rendered).toContain('"decisions"');
		expect(rendered).toContain('"targetAgentId"');
		expect(rendered).toContain('"shouldShare"');
		expect(rendered).toContain('"reasoning"');
		expect(rendered).toContain('"information"');
	});
});

// ── Test: Notification system prompt content quality ───────────────────────

describe("Notification system prompt content quality", () => {
	const rendered = contextAnalysisSystemPrompt({});

	it("contains Milestones as a notification trigger", () => {
		expect(rendered).toContain("**Milestones**");
	});

	it("contains Errors requiring intervention as a notification trigger", () => {
		expect(rendered).toContain("**Errors requiring intervention**");
	});

	it("contains Do NOT notify section", () => {
		expect(rendered).toContain("Do NOT notify for");
	});

	it("contains JSON output format with shouldNotify, reasoning, message", () => {
		expect(rendered).toContain('"shouldNotify"');
		expect(rendered).toContain('"reasoning"');
		expect(rendered).toContain('"message"');
	});

	it("does not position itself as a sharing system", () => {
		// "cross-agent" may appear in negation ("You do NOT decide on cross-agent sharing")
		// but the prompt should not identify as a sharing specialist
		expect(rendered).not.toContain("sharing specialist");
		expect(rendered).not.toContain("## When to share");
		expect(rendered).not.toContain("## Dependency types");
	});
});

// ── Test: Total conversation role count ────────────────────────────────────

describe("ConversationRole enum completeness", () => {
	it("has exactly 6 roles after orchestrator addition", () => {
		const allValues = Object.values(ConversationRole);
		expect(allValues).toHaveLength(6);
	});

	it("contains all expected roles", () => {
		const expected = [
			"planner",
			"context-analyzer",
			"sharing-analyzer",
			"user-interaction",
			"intent-analyzer",
			"orchestrator",
		];

		const actual = Object.values(ConversationRole) as string[];
		for (const role of expected) {
			expect(actual).toContain(role);
		}
	});
});
