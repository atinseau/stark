import { describe, expect, it, mock } from "bun:test";

import { AgentStatus } from "../../../enums/agent-status.enum.ts";
import { DeltaType } from "../../../enums/delta-type.enum.ts";
import type { ContextDelta, SubTask } from "../../../types/agent-pool.types.ts";
import { ContextTracker } from "../context-tracker.ts";
import { DecisionJournal } from "../decision-journal.ts";
import { InformationBroker } from "../information-broker.ts";
import { NotificationEngine } from "../notification-engine.ts";
import { silentLogger } from "./test-helpers.ts";

// ════════════════════════════════════════════════════════════════════════════
// DecisionJournal — Integration Tests with InformationBroker & NotificationEngine
// ════════════════════════════════════════════════════════════════════════════

// ── Helpers ────────────────────────────────────────────────────────────────

function createBrokerWithCapture(overrides?: {
	llmResponse?: unknown;
	dependencies?: Array<{ from: string; to: string; type: string }>;
	subtaskToAgent?: Map<string, string>;
	agentToSubtask?: Map<string, string>;
	journalConfig?: {
		maxEntries?: number;
		maxEntriesInPrompt?: number;
		maxReasoningLength?: number;
	};
}) {
	let capturedPrompt: string | null = null;

	const llmResponse = overrides?.llmResponse ?? [
		{
			targetAgentId: "agent-2",
			shouldShare: true,
			reasoning: "The target needs this information",
			information: "Relevant information for the target",
		},
	];

	const mockConversations = {
		sendOneShotJson: mock((_role: unknown, prompt: string) => {
			capturedPrompt = prompt;
			return Promise.resolve(llmResponse);
		}),
	} as any;

	const tracker = new ContextTracker();

	const broker = new InformationBroker(
		mockConversations,
		tracker,
		(overrides?.dependencies as any) ?? [],
		silentLogger(),
		overrides?.subtaskToAgent ?? new Map(),
		overrides?.agentToSubtask ?? new Map(),
		{ journalConfig: overrides?.journalConfig },
	);

	return {
		broker,
		tracker,
		mockConversations,
		getCapturedPrompt: () => capturedPrompt,
	};
}

function createNotificationEngineWithCapture(overrides?: {
	llmResponse?: unknown;
	journalConfig?: {
		maxEntries?: number;
		maxEntriesInPrompt?: number;
		maxReasoningLength?: number;
	};
}) {
	let capturedPrompt: string | null = null;

	const llmResponse = overrides?.llmResponse ?? {
		shouldNotify: true,
		reasoning: "This is an important milestone",
		message: "Agent completed an important task.",
	};

	const mockConversations = {
		sendOneShotJson: mock((_role: unknown, prompt: string) => {
			capturedPrompt = prompt;
			return Promise.resolve(llmResponse);
		}),
	} as any;

	const engine = new NotificationEngine(
		mockConversations,
		silentLogger(),
		overrides?.journalConfig,
	);

	return { engine, mockConversations, getCapturedPrompt: () => capturedPrompt };
}

function makeDelta(overrides?: Partial<ContextDelta>): ContextDelta {
	return {
		agentId: overrides?.agentId ?? "agent-1",
		agentName: overrides?.agentName ?? "Alpha",
		timestamp: overrides?.timestamp ?? new Date().toISOString(),
		type: overrides?.type ?? DeltaType.PROMPT_COMPLETE,
		summary: overrides?.summary ?? "Prompt completed successfully",
		data: overrides?.data ?? { responsePreview: "Some response..." },
		significance: overrides?.significance ?? 0.8,
		promptResultSummary: overrides?.promptResultSummary ?? null,
	};
}

function makeAgentState(overrides?: Partial<Record<string, unknown>>) {
	const delta = makeDelta();
	return {
		agentId: overrides?.agentId ?? "agent-1",
		agentName: overrides?.agentName ?? "Alpha",
		taskDescription: overrides?.taskDescription ?? "Build the API",
		taskRole: overrides?.taskRole ?? "api-developer",
		status: overrides?.status ?? AgentStatus.IDLE,
		events: [],
		promptResults: [],
		lastDelta: delta,
		filesWritten: [],
		filesRead: [],
		completed: overrides?.completed ?? false,
		error: null,
	};
}

// ════════════════════════════════════════════════════════════════════════════
// Test 16: The prompt of sharing includes the journal when it's not empty
// ════════════════════════════════════════════════════════════════════════════

describe("DecisionJournal — InformationBroker integration", () => {
	it("Test 16: sharing prompt includes the journal when it is not empty", async () => {
		const { broker, tracker, getCapturedPrompt } = createBrokerWithCapture();

		const subtask1: SubTask = {
			id: "t1",
			prompt: "Build API",
			role: "api-dev",
			dependencies: [],
			priority: 1,
		};
		const subtask2: SubTask = {
			id: "t2",
			prompt: "Write tests",
			role: "tester",
			dependencies: ["t1"],
			priority: 2,
		};
		tracker.registerAgent("agent-1", "Alpha", subtask1);
		tracker.registerAgent("agent-2", "Beta", subtask2);

		// Pre-populate the journal with 3 decisions
		broker.journal.recordSharingDecision(
			"PreviousAgent",
			"Beta",
			"file_written",
			true,
			"File structure was relevant for the tester.",
			new Date(Date.now() - 10_000).toISOString(),
		);
		broker.journal.recordSharingDecision(
			"AnotherAgent",
			"Beta",
			"tool_complete",
			false,
			"Tool output not relevant for test writing.",
			new Date(Date.now() - 5_000).toISOString(),
		);
		broker.journal.recordSharingDecision(
			"Alpha",
			"Beta",
			"status_change",
			true,
			"Agent status transition is informative.",
			new Date(Date.now() - 2_000).toISOString(),
		);

		const delta = makeDelta({ agentId: "agent-1", agentName: "Alpha" });
		await broker.evaluate(delta);

		const prompt = getCapturedPrompt();
		expect(prompt).not.toBeNull();

		// The prompt must include the journal header
		expect(prompt!).toContain("Recent Sharing Decisions (your session memory)");

		// It should contain the 3 journal entries
		expect(prompt!).toContain("PreviousAgent");
		expect(prompt!).toContain("AnotherAgent");
		expect(prompt!).toContain("File structure was relevant");
		expect(prompt!).toContain("Tool output not relevant");
		expect(prompt!).toContain("Agent status transition is informative");

		// It should contain both APPROVED and DENIED markers
		expect(prompt!).toContain("✅ APPROVED");
		expect(prompt!).toContain("❌ DENIED");
	});

	// ══════════════════════════════════════════════════════════════════════════
	// Test 17: The prompt of sharing does NOT include the journal when empty
	// ══════════════════════════════════════════════════════════════════════════

	it("Test 17: sharing prompt does NOT include the journal when it is empty", async () => {
		const { broker, tracker, getCapturedPrompt } = createBrokerWithCapture();

		const subtask1: SubTask = {
			id: "t1",
			prompt: "Build API",
			role: "api-dev",
			dependencies: [],
			priority: 1,
		};
		const subtask2: SubTask = {
			id: "t2",
			prompt: "Write tests",
			role: "tester",
			dependencies: ["t1"],
			priority: 2,
		};
		tracker.registerAgent("agent-1", "Alpha", subtask1);
		tracker.registerAgent("agent-2", "Beta", subtask2);

		// Journal is empty — no pre-population
		expect(broker.journal.entryCount).toBe(0);

		const delta = makeDelta({ agentId: "agent-1", agentName: "Alpha" });
		await broker.evaluate(delta);

		const prompt = getCapturedPrompt();
		expect(prompt).not.toBeNull();

		// The prompt must NOT include the journal section
		expect(prompt!).not.toContain(
			"Recent Sharing Decisions (your session memory)",
		);
		expect(prompt!).not.toContain("✅ APPROVED");
		expect(prompt!).not.toContain("❌ DENIED");
	});

	// ══════════════════════════════════════════════════════════════════════════
	// Test 18: Sharing decisions are recorded in the journal
	// ══════════════════════════════════════════════════════════════════════════

	it("Test 18: sharing decisions (approved AND denied) are recorded in the journal", async () => {
		const { broker, tracker } = createBrokerWithCapture({
			llmResponse: [
				{
					targetAgentId: "agent-2",
					shouldShare: true,
					reasoning: "Approved: the tester needs API structure info",
					information: "API endpoints: GET /users, POST /users",
				},
				{
					targetAgentId: "agent-3",
					shouldShare: false,
					reasoning: "Denied: CSS changes irrelevant for backend tests",
					information: "",
				},
			],
		});

		const subtask1: SubTask = {
			id: "t1",
			prompt: "Build API",
			role: "api-dev",
			dependencies: [],
			priority: 1,
		};
		const subtask2: SubTask = {
			id: "t2",
			prompt: "Write tests",
			role: "tester",
			dependencies: ["t1"],
			priority: 2,
		};
		const subtask3: SubTask = {
			id: "t3",
			prompt: "Write docs",
			role: "doc-writer",
			dependencies: [],
			priority: 3,
		};
		tracker.registerAgent("agent-1", "Alpha", subtask1);
		tracker.registerAgent("agent-2", "Beta", subtask2);
		tracker.registerAgent("agent-3", "Gamma", subtask3);

		expect(broker.journal.entryCount).toBe(0);

		const delta = makeDelta({ agentId: "agent-1", agentName: "Alpha" });
		await broker.evaluate(delta);

		// Should have 2 entries: one approved, one denied
		expect(broker.journal.entryCount).toBe(2);
		expect(broker.journal.approvedCount).toBe(1);
		expect(broker.journal.deniedCount).toBe(1);

		const entries = broker.journal.getAllEntries();

		const approved = entries.find((e) => e.approved);
		expect(approved).toBeDefined();
		expect(approved!.type).toBe("sharing");
		expect(approved!.sourceAgentName).toBe("Alpha");
		expect(approved!.targetName).toBe("Beta");
		expect(approved!.deltaType).toBe(DeltaType.PROMPT_COMPLETE);
		expect(approved!.reasoningSummary).toContain("Approved");

		const denied = entries.find((e) => !e.approved);
		expect(denied).toBeDefined();
		expect(denied!.type).toBe("sharing");
		expect(denied!.sourceAgentName).toBe("Alpha");
		expect(denied!.targetName).toBe("Gamma");
		expect(denied!.reasoningSummary).toContain("Denied");
	});

	// ══════════════════════════════════════════════════════════════════════════
	// Test 22: Broker journal is naturally clean (new broker per execution)
	// ══════════════════════════════════════════════════════════════════════════

	it("Test 22: broker journal starts empty (broker is new each execution)", () => {
		// Each call to createBrokerWithCapture simulates a new execution
		const { broker: broker1 } = createBrokerWithCapture();
		expect(broker1.journal.entryCount).toBe(0);

		// Simulate recording some decisions on the first broker
		broker1.journal.recordSharingDecision(
			"Alpha",
			"Beta",
			"prompt_complete",
			true,
			"reason",
			new Date().toISOString(),
		);
		expect(broker1.journal.entryCount).toBe(1);

		// Creating a new broker (simulating a new execution) should have an empty journal
		const { broker: broker2 } = createBrokerWithCapture();
		expect(broker2.journal.entryCount).toBe(0);
	});

	// ══════════════════════════════════════════════════════════════════════════
	// Test 24: Sharing works identically when journal is empty (non-regression)
	// ══════════════════════════════════════════════════════════════════════════

	it("Test 24: sharing works identically when journal is empty vs not empty", async () => {
		// Test with empty journal
		const setup1 = createBrokerWithCapture({
			llmResponse: [
				{
					targetAgentId: "agent-2",
					shouldShare: true,
					reasoning: "Important info",
					information: "Some info",
				},
			],
		});
		const subtask1a: SubTask = {
			id: "t1",
			prompt: "Build API",
			role: "api-dev",
			dependencies: [],
			priority: 1,
		};
		const subtask2a: SubTask = {
			id: "t2",
			prompt: "Write tests",
			role: "tester",
			dependencies: ["t1"],
			priority: 2,
		};
		setup1.tracker.registerAgent("agent-1", "Alpha", subtask1a);
		setup1.tracker.registerAgent("agent-2", "Beta", subtask2a);

		const delta1 = makeDelta({ agentId: "agent-1", agentName: "Alpha" });
		const decisions1 = await setup1.broker.evaluate(delta1);

		// Test with pre-populated journal
		const setup2 = createBrokerWithCapture({
			llmResponse: [
				{
					targetAgentId: "agent-2",
					shouldShare: true,
					reasoning: "Important info",
					information: "Some info",
				},
			],
		});
		const subtask1b: SubTask = {
			id: "t1",
			prompt: "Build API",
			role: "api-dev",
			dependencies: [],
			priority: 1,
		};
		const subtask2b: SubTask = {
			id: "t2",
			prompt: "Write tests",
			role: "tester",
			dependencies: ["t1"],
			priority: 2,
		};
		setup2.tracker.registerAgent("agent-1", "Alpha", subtask1b);
		setup2.tracker.registerAgent("agent-2", "Beta", subtask2b);
		setup2.broker.journal.recordSharingDecision(
			"SomeAgent",
			"Beta",
			"file_written",
			true,
			"Previous decision",
			new Date().toISOString(),
		);

		const delta2 = makeDelta({ agentId: "agent-1", agentName: "Alpha" });
		const decisions2 = await setup2.broker.evaluate(delta2);

		// Both should produce the same decisions (the journal doesn't change the LLM mock response)
		expect(decisions1).toHaveLength(1);
		expect(decisions2).toHaveLength(1);
		expect(decisions1[0]!.shouldShare).toBe(decisions2[0]!.shouldShare);
		expect(decisions1[0]!.reasoning).toBe(decisions2[0]!.reasoning);
		expect(decisions1[0]!.information).toBe(decisions2[0]!.information);

		// The only difference: the second prompt should include the journal section
		const prompt1 = setup1.getCapturedPrompt()!;
		const prompt2 = setup2.getCapturedPrompt()!;
		expect(prompt1).not.toContain("Recent Sharing Decisions");
		expect(prompt2).toContain("Recent Sharing Decisions");
	});

	// ══════════════════════════════════════════════════════════════════════════
	// Test 25: SharingHistory (previouslyShared, evolution 02) still works
	// ══════════════════════════════════════════════════════════════════════════

	it("Test 25: previouslyShared is still included in the prompt alongside the journal", async () => {
		const { broker, tracker, getCapturedPrompt } = createBrokerWithCapture();

		const subtask1: SubTask = {
			id: "t1",
			prompt: "Build API",
			role: "api-dev",
			dependencies: [],
			priority: 1,
		};
		const subtask2: SubTask = {
			id: "t2",
			prompt: "Write tests",
			role: "tester",
			dependencies: ["t1"],
			priority: 2,
		};
		tracker.registerAgent("agent-1", "Alpha", subtask1);
		tracker.registerAgent("agent-2", "Beta", subtask2);

		// Record a sharing in the SharingHistory (evolution 02)
		broker.recordSharing(
			{
				shouldShare: true,
				reasoning: "API structure needed",
				sourceAgentId: "agent-1",
				targetAgentId: "agent-2",
				information: "GET /users endpoint returns User[]",
			},
			DeltaType.PROMPT_COMPLETE,
		);

		// Also add a decision journal entry
		broker.journal.recordSharingDecision(
			"Alpha",
			"Beta",
			"prompt_complete",
			true,
			"Previously shared API endpoint info.",
			new Date().toISOString(),
		);

		const delta = makeDelta({ agentId: "agent-1", agentName: "Alpha" });
		await broker.evaluate(delta);

		const prompt = getCapturedPrompt()!;

		// The prompt should contain BOTH mechanisms:
		// 1. The decision journal section
		expect(prompt).toContain("Recent Sharing Decisions (your session memory)");

		// 2. The previouslyShared section (from SharingHistory)
		expect(prompt).toContain("Previously shared to this agent");
		expect(prompt).toContain("GET /users endpoint returns User[]");
	});

	// ══════════════════════════════════════════════════════════════════════════
	// Test: Journal section appears BEFORE delta and targets in sharing prompt
	// ══════════════════════════════════════════════════════════════════════════

	it("journal section is placed BEFORE delta and targets in the sharing prompt", async () => {
		const { broker, tracker, getCapturedPrompt } = createBrokerWithCapture();

		const subtask1: SubTask = {
			id: "t1",
			prompt: "Build API",
			role: "api-dev",
			dependencies: [],
			priority: 1,
		};
		const subtask2: SubTask = {
			id: "t2",
			prompt: "Write tests",
			role: "tester",
			dependencies: ["t1"],
			priority: 2,
		};
		tracker.registerAgent("agent-1", "Alpha", subtask1);
		tracker.registerAgent("agent-2", "Beta", subtask2);

		broker.journal.recordSharingDecision(
			"Alpha",
			"Beta",
			"prompt_complete",
			true,
			"test reason",
			new Date().toISOString(),
		);

		const delta = makeDelta({ agentId: "agent-1", agentName: "Alpha" });
		await broker.evaluate(delta);

		const prompt = getCapturedPrompt()!;

		const journalPos = prompt.indexOf("Recent Sharing Decisions");
		const sourceAgentPos = prompt.indexOf("## Source Agent");
		const deltaPos = prompt.indexOf("## Delta");
		const targetPos = prompt.indexOf("## Target Agents");

		expect(journalPos).toBeGreaterThan(-1);
		expect(sourceAgentPos).toBeGreaterThan(-1);
		expect(deltaPos).toBeGreaterThan(-1);
		expect(targetPos).toBeGreaterThan(-1);

		// Journal must appear before source agent, delta, and targets
		expect(journalPos).toBeLessThan(sourceAgentPos);
		expect(journalPos).toBeLessThan(deltaPos);
		expect(journalPos).toBeLessThan(targetPos);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// DecisionJournal — NotificationEngine integration
// ════════════════════════════════════════════════════════════════════════════

describe("DecisionJournal — NotificationEngine integration", () => {
	// ══════════════════════════════════════════════════════════════════════════
	// Test 19: Notification prompt includes journal and rate awareness
	// ══════════════════════════════════════════════════════════════════════════

	it("Test 19: notification prompt includes journal and rate awareness when journal is not empty", async () => {
		const { engine, getCapturedPrompt } = createNotificationEngineWithCapture();
		engine.setPreference({ enabled: true, minSignificance: 0.3 });

		const now = Date.now();

		// Pre-populate the journal with 2 approved notification decisions (recent)
		engine.journal.recordNotificationDecision(
			"Alpha",
			"prompt_complete",
			true,
			"Important milestone: API endpoints created.",
			new Date(now - 20_000).toISOString(),
		);
		engine.journal.recordNotificationDecision(
			"Beta",
			"agent_error",
			true,
			"Error requires user attention.",
			new Date(now - 10_000).toISOString(),
		);

		const delta = makeDelta({
			agentId: "agent-1",
			agentName: "Alpha",
			significance: 0.8,
		});
		await engine.evaluate(delta, makeAgentState() as any);

		const prompt = getCapturedPrompt()!;

		// The prompt must include the journal header
		expect(prompt).toContain("Your Recent Notification Decisions");
		expect(prompt).toContain(
			"Maintain consistency and avoid notification fatigue",
		);

		// The prompt should contain the journal entries
		expect(prompt).toContain("Important milestone: API endpoints created.");
		expect(prompt).toContain("Error requires user attention.");

		// Rate awareness: 2 approved notifications in the last 60 seconds
		expect(prompt).toContain("2 notification(s) in the last 60 seconds");
		expect(prompt).toContain("⚠️");
	});

	// ══════════════════════════════════════════════════════════════════════════
	// Test: Notification prompt does NOT include journal when empty
	// ══════════════════════════════════════════════════════════════════════════

	it("notification prompt does NOT include journal when it is empty", async () => {
		const { engine, getCapturedPrompt } = createNotificationEngineWithCapture();
		engine.setPreference({ enabled: true, minSignificance: 0.3 });

		expect(engine.journal.entryCount).toBe(0);

		const delta = makeDelta({
			agentId: "agent-1",
			agentName: "Alpha",
			significance: 0.8,
		});
		await engine.evaluate(delta, makeAgentState() as any);

		const prompt = getCapturedPrompt()!;

		expect(prompt).not.toContain("Your Recent Notification Decisions");
		expect(prompt).not.toContain("notification(s) in the last 60 seconds");
	});

	// ══════════════════════════════════════════════════════════════════════════
	// Test 20: Notification decisions are recorded in the journal
	// ══════════════════════════════════════════════════════════════════════════

	it("Test 20: notification decisions (approved) are recorded in the journal", async () => {
		const { engine } = createNotificationEngineWithCapture({
			llmResponse: {
				shouldNotify: true,
				reasoning: "Major milestone: all tests passing",
				message: "All tests are now passing!",
			},
		});
		engine.setPreference({ enabled: true, minSignificance: 0.3 });

		expect(engine.journal.entryCount).toBe(0);

		const delta = makeDelta({
			agentId: "agent-1",
			agentName: "Alpha",
			significance: 0.8,
		});
		await engine.evaluate(delta, makeAgentState() as any);

		expect(engine.journal.entryCount).toBe(1);

		const entries = engine.journal.getAllEntries();
		expect(entries[0]!.type).toBe("notification");
		expect(entries[0]!.approved).toBe(true);
		expect(entries[0]!.sourceAgentName).toBe("Alpha");
		expect(entries[0]!.targetName).toBe("user");
		expect(entries[0]!.deltaType).toBe(DeltaType.PROMPT_COMPLETE);
		expect(entries[0]!.reasoningSummary).toContain("Major milestone");
	});

	it("Test 20b: notification decisions (denied) are recorded in the journal", async () => {
		const { engine } = createNotificationEngineWithCapture({
			llmResponse: {
				shouldNotify: false,
				reasoning: "Routine progress, not noteworthy",
				message: "",
			},
		});
		engine.setPreference({ enabled: true, minSignificance: 0.3 });

		const delta = makeDelta({
			agentId: "agent-1",
			agentName: "Alpha",
			significance: 0.8,
		});
		await engine.evaluate(delta, makeAgentState() as any);

		expect(engine.journal.entryCount).toBe(1);
		const entries = engine.journal.getAllEntries();
		expect(entries[0]!.approved).toBe(false);
		expect(entries[0]!.reasoningSummary).toContain("Routine progress");
	});

	// ══════════════════════════════════════════════════════════════════════════
	// Test 21: Notification journal is cleaned between executions
	// ══════════════════════════════════════════════════════════════════════════

	it("Test 21: notification journal can be cleared (simulating between-execution cleanup)", () => {
		const { engine } = createNotificationEngineWithCapture();

		// Simulate accumulating decisions
		engine.journal.recordNotificationDecision(
			"Alpha",
			"prompt_complete",
			true,
			"reason1",
			new Date().toISOString(),
		);
		engine.journal.recordNotificationDecision(
			"Beta",
			"agent_error",
			false,
			"reason2",
			new Date().toISOString(),
		);
		engine.journal.recordNotificationDecision(
			"Gamma",
			"file_written",
			true,
			"reason3",
			new Date().toISOString(),
		);

		expect(engine.journal.entryCount).toBe(3);
		expect(engine.journal.approvedCount).toBe(2);
		expect(engine.journal.deniedCount).toBe(1);

		// Simulate the finally block cleanup: notificationEngine.journal.clear()
		engine.journal.clear();

		expect(engine.journal.entryCount).toBe(0);
		expect(engine.journal.toPromptSection()).toBeNull();
		expect(engine.journal.approvalRate).toBe(0);
	});

	// ══════════════════════════════════════════════════════════════════════════
	// Test: Rate awareness shows 0 when no recent approved notifications
	// ══════════════════════════════════════════════════════════════════════════

	it("rate awareness section is absent when no recent notifications exist", async () => {
		const { engine, getCapturedPrompt } = createNotificationEngineWithCapture();
		engine.setPreference({ enabled: true, minSignificance: 0.3 });

		// Add an old notification (more than 60 seconds ago)
		engine.journal.recordNotificationDecision(
			"Alpha",
			"prompt_complete",
			true,
			"old notification",
			new Date(Date.now() - 120_000).toISOString(),
		);

		const delta = makeDelta({
			agentId: "agent-1",
			agentName: "Alpha",
			significance: 0.8,
		});
		await engine.evaluate(delta, makeAgentState() as any);

		const prompt = getCapturedPrompt()!;

		// Journal section should be present (there IS a journal entry)
		expect(prompt).toContain("Your Recent Notification Decisions");

		// But rate awareness should NOT be present (no approved notifications in last 60s)
		expect(prompt).not.toContain("notification(s) in the last 60 seconds");
	});

	// ══════════════════════════════════════════════════════════════════════════
	// Test: Journal section appears BEFORE delta in notification prompt
	// ══════════════════════════════════════════════════════════════════════════

	it("journal section is placed BEFORE delta in the notification prompt", async () => {
		const { engine, getCapturedPrompt } = createNotificationEngineWithCapture();
		engine.setPreference({ enabled: true, minSignificance: 0.3 });

		engine.journal.recordNotificationDecision(
			"Alpha",
			"prompt_complete",
			true,
			"test reason",
			new Date().toISOString(),
		);

		const delta = makeDelta({
			agentId: "agent-1",
			agentName: "Alpha",
			significance: 0.8,
		});
		await engine.evaluate(delta, makeAgentState() as any);

		const prompt = getCapturedPrompt()!;

		const journalPos = prompt.indexOf("Your Recent Notification Decisions");
		const whatHappenedPos = prompt.indexOf("## What Happened");
		const agentTaskPos = prompt.indexOf("## Agent's Task");

		expect(journalPos).toBeGreaterThan(-1);
		expect(whatHappenedPos).toBeGreaterThan(-1);
		expect(agentTaskPos).toBeGreaterThan(-1);

		// Journal must appear before the delta and agent task sections
		expect(journalPos).toBeLessThan(whatHappenedPos);
		expect(journalPos).toBeLessThan(agentTaskPos);
	});

	// ══════════════════════════════════════════════════════════════════════════
	// Test: Multiple evaluations accumulate in the journal
	// ══════════════════════════════════════════════════════════════════════════

	it("multiple notification evaluations accumulate in the journal", async () => {
		const { engine } = createNotificationEngineWithCapture({
			llmResponse: {
				shouldNotify: true,
				reasoning: "Important event",
				message: "Something happened.",
			},
		});
		engine.setPreference({ enabled: true, minSignificance: 0.3 });

		// Evaluate 3 deltas
		for (let i = 0; i < 3; i++) {
			const delta = makeDelta({
				agentId: `agent-${i}`,
				agentName: `Agent-${i}`,
				significance: 0.8,
			});
			await engine.evaluate(
				delta,
				makeAgentState({
					agentId: `agent-${i}`,
					agentName: `Agent-${i}`,
				}) as any,
			);
		}

		expect(engine.journal.entryCount).toBe(3);
		expect(engine.journal.approvedCount).toBe(3);

		const entries = engine.journal.getAllEntries();
		expect(entries[0]!.sourceAgentName).toBe("Agent-0");
		expect(entries[1]!.sourceAgentName).toBe("Agent-1");
		expect(entries[2]!.sourceAgentName).toBe("Agent-2");
	});

	// ══════════════════════════════════════════════════════════════════════════
	// Test: Notification engine does not record in journal when pre-filters reject
	// ══════════════════════════════════════════════════════════════════════════

	it("no journal entry when delta is rejected by pre-filters (significance too low)", async () => {
		const { engine } = createNotificationEngineWithCapture();
		engine.setPreference({ enabled: true, minSignificance: 0.8 });

		const delta = makeDelta({ significance: 0.3 }); // Below threshold
		await engine.evaluate(delta, makeAgentState() as any);

		// Pre-filter rejected → LLM not called → no journal entry
		expect(engine.journal.entryCount).toBe(0);
	});

	it("no journal entry when notifications are disabled", async () => {
		const { engine } = createNotificationEngineWithCapture();
		// Do NOT set preference (silence mode)

		const delta = makeDelta({ significance: 0.9 });
		await engine.evaluate(delta, makeAgentState() as any);

		expect(engine.journal.entryCount).toBe(0);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Test 23: Analytics (journal stats) — unit test for journal getter on both
// ════════════════════════════════════════════════════════════════════════════

describe("DecisionJournal — Analytics getters", () => {
	it("Test 23: broker journal exposes accurate analytics after evaluations", async () => {
		const { broker, tracker } = createBrokerWithCapture({
			llmResponse: [
				{
					targetAgentId: "agent-2",
					shouldShare: true,
					reasoning: "Needed for tests",
					information: "API info",
				},
			],
		});

		const subtask1: SubTask = {
			id: "t1",
			prompt: "Build API",
			role: "api-dev",
			dependencies: [],
			priority: 1,
		};
		const subtask2: SubTask = {
			id: "t2",
			prompt: "Write tests",
			role: "tester",
			dependencies: ["t1"],
			priority: 2,
		};
		tracker.registerAgent("agent-1", "Alpha", subtask1);
		tracker.registerAgent("agent-2", "Beta", subtask2);

		const delta = makeDelta({ agentId: "agent-1", agentName: "Alpha" });
		await broker.evaluate(delta);

		// Journal should be accessible via the getter
		const journal = broker.journal;
		expect(journal).toBeInstanceOf(DecisionJournal);
		expect(journal.entryCount).toBe(1);
		expect(journal.approvedCount).toBe(1);
		expect(journal.deniedCount).toBe(0);
		expect(journal.approvalRate).toBe(1.0);
	});

	it("Test 23b: notification engine journal exposes accurate analytics", async () => {
		const { engine } = createNotificationEngineWithCapture({
			llmResponse: {
				shouldNotify: false,
				reasoning: "Not noteworthy",
				message: "",
			},
		});
		engine.setPreference({ enabled: true, minSignificance: 0.3 });

		const delta = makeDelta({ significance: 0.8 });
		await engine.evaluate(delta, makeAgentState() as any);

		const journal = engine.journal;
		expect(journal).toBeInstanceOf(DecisionJournal);
		expect(journal.entryCount).toBe(1);
		expect(journal.approvedCount).toBe(0);
		expect(journal.deniedCount).toBe(1);
		expect(journal.approvalRate).toBe(0);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Token budget — bounded overhead
// ════════════════════════════════════════════════════════════════════════════

describe("DecisionJournal — Token budget verification", () => {
	it("journal prompt section stays within ~2000 chars even at max capacity", () => {
		const journal = new DecisionJournal({
			maxEntries: 15,
			maxEntriesInPrompt: 8,
			maxReasoningLength: 120,
		});

		// Fill to max
		for (let i = 0; i < 15; i++) {
			journal.record({
				timestamp: new Date(Date.now() - i * 10_000).toISOString(),
				type: "sharing",
				sourceAgentName: `source-agent-${i}`,
				targetName: `target-agent-${i}`,
				deltaType: "prompt_complete",
				approved: i % 2 === 0,
				reasoningSummary: "X".repeat(120), // Max reasoning length
			});
		}

		const section = journal.toPromptSection()!;
		expect(section).not.toBeNull();

		// 8 entries × ~200 chars each = ~1600 chars
		// Allow some margin: should be well under 2500 chars
		expect(section.length).toBeLessThan(2500);

		// Verify only 8 entries are shown
		const entryCount = (section.match(/^\d+\.\s/gm) ?? []).length;
		expect(entryCount).toBe(8);
	});
});
