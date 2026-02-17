import { describe, expect, it, mock } from "bun:test";
import { DeltaType } from "../../../enums/delta-type.enum.ts";
import type {
	ContextDelta,
	SharingDecision,
	SubTask,
} from "../../../types/agent-pool.types.ts";
import { ContextTracker } from "../context-tracker.ts";
import { InformationBroker } from "../information-broker.ts";
import { silentLogger } from "./test-helpers.ts";

// ════════════════════════════════════════════════════════════════════════════
// InformationBroker — Sharing Deduplication Tests
// ════════════════════════════════════════════════════════════════════════════

describe("InformationBroker — Sharing Deduplication", () => {
	// ── Helpers ─────────────────────────────────────────────────────────────

	function createBroker(overrides?: {
		mockConversations?: any;
		dependencies?: Array<{ from: string; to: string; type: string }>;
		subtaskToAgent?: Map<string, string>;
		agentToSubtask?: Map<string, string>;
	}) {
		const mockConversations =
			overrides?.mockConversations ??
			({
				sendOneShotJson: mock(() => Promise.resolve([])),
			} as any);

		const tracker = new ContextTracker();

		const broker = new InformationBroker(
			mockConversations,
			tracker,
			(overrides?.dependencies as any) ?? [],
			silentLogger(),
			overrides?.subtaskToAgent ?? new Map(),
			overrides?.agentToSubtask ?? new Map(),
		);

		return { broker, tracker, mockConversations };
	}

	function makeSharingDecision(
		overrides?: Partial<SharingDecision>,
	): SharingDecision {
		return {
			shouldShare: true,
			reasoning: "Test sharing decision",
			sourceAgentId: overrides?.sourceAgentId ?? "agent-source",
			targetAgentId: overrides?.targetAgentId ?? "agent-target",
			information:
				overrides?.information ??
				"Some useful information for the target agent",
		};
	}

	// ── Test 1: recordSharing enregistre correctement un partage ───────────

	it("recordSharing records a sharing correctly", () => {
		const { broker } = createBroker();

		const decision = makeSharingDecision({
			sourceAgentId: "agent-1",
			targetAgentId: "agent-2",
			information: "The API has GET /users and POST /users endpoints",
		});

		broker.recordSharing(decision, DeltaType.PROMPT_COMPLETE);

		const records = broker.getRecentSharingsForTarget("agent-2");
		expect(records).toHaveLength(1);
		expect(records[0]!.sourceAgentId).toBe("agent-1");
		expect(records[0]!.targetAgentId).toBe("agent-2");
		expect(records[0]!.deltaType).toBe(DeltaType.PROMPT_COMPLETE);
		expect(records[0]!.informationSummary).toBe(
			"The API has GET /users and POST /users endpoints",
		);
		expect(records[0]!.timestamp).toBeTruthy();
		expect(broker.totalRecordedSharings).toBe(1);
	});

	// ── Test 2: recordSharing respecte la limite MAX_SHARING_RECORDS_PER_TARGET ──

	it("recordSharing respects the MAX_SHARING_RECORDS_PER_TARGET limit", () => {
		const { broker } = createBroker();
		const targetId = "agent-target";

		// Record 25 sharings (MAX is 20)
		for (let i = 0; i < 25; i++) {
			const decision = makeSharingDecision({
				targetAgentId: targetId,
				information: `Information batch number ${i}`,
			});
			broker.recordSharing(decision, DeltaType.FILE_WRITTEN);
		}

		// Should have exactly 20 records (MAX_SHARING_RECORDS_PER_TARGET)
		expect(broker.totalRecordedSharings).toBe(20);

		// The returned records (up to prompt limit of 5) should be the most recent
		const recentRecords = broker.getRecentSharingsForTarget(targetId);
		expect(recentRecords).toHaveLength(5); // MAX_SHARING_RECORDS_IN_PROMPT = 5

		// Fetch all 20 stored records with a high limit
		const allRecords = broker.getRecentSharingsForTarget(targetId, 100);
		expect(allRecords).toHaveLength(20);

		// The first 5 (indices 0-4) should have been evicted; first remaining is index 5
		expect(allRecords[0]!.informationSummary).toBe(
			"Information batch number 5",
		);
		// The last one should be index 24
		expect(allRecords[19]!.informationSummary).toBe(
			"Information batch number 24",
		);
	});

	// ── Test 3: getRecentSharingsForTarget retourne un tableau vide pour un target inconnu ──

	it("getRecentSharingsForTarget returns empty array for unknown target", () => {
		const { broker } = createBroker();

		const records = broker.getRecentSharingsForTarget("agent-inexistant");
		expect(records).toEqual([]);
		expect(records).toHaveLength(0);
	});

	// ── Test 4: getRecentSharingsForTarget respecte le paramètre limit ──

	it("getRecentSharingsForTarget respects the limit parameter", () => {
		const { broker } = createBroker();
		const targetId = "agent-target";

		// Record 10 sharings
		for (let i = 0; i < 10; i++) {
			const decision = makeSharingDecision({
				targetAgentId: targetId,
				information: `Info item ${i}`,
			});
			broker.recordSharing(decision, DeltaType.TOOL_COMPLETE);
		}

		// Request only 3
		const records = broker.getRecentSharingsForTarget(targetId, 3);
		expect(records).toHaveLength(3);

		// Should be the 3 most recent (7, 8, 9)
		expect(records[0]!.informationSummary).toBe("Info item 7");
		expect(records[1]!.informationSummary).toBe("Info item 8");
		expect(records[2]!.informationSummary).toBe("Info item 9");
	});

	// ── Test 5: clearHistory vide tout l'historique ──

	it("clearHistory clears all sharing history", () => {
		const { broker } = createBroker();

		// Record sharings to multiple targets
		broker.recordSharing(
			makeSharingDecision({
				targetAgentId: "agent-A",
				information: "Info for A",
			}),
			DeltaType.PROMPT_COMPLETE,
		);
		broker.recordSharing(
			makeSharingDecision({
				targetAgentId: "agent-B",
				information: "Info for B",
			}),
			DeltaType.FILE_WRITTEN,
		);
		broker.recordSharing(
			makeSharingDecision({
				targetAgentId: "agent-C",
				information: "Info for C",
			}),
			DeltaType.TOOL_COMPLETE,
		);

		expect(broker.totalRecordedSharings).toBe(3);

		broker.clearHistory();

		expect(broker.totalRecordedSharings).toBe(0);
		expect(broker.getRecentSharingsForTarget("agent-A")).toEqual([]);
		expect(broker.getRecentSharingsForTarget("agent-B")).toEqual([]);
		expect(broker.getRecentSharingsForTarget("agent-C")).toEqual([]);
	});

	// ── Test 6: L'historique est indépendant par target ──

	it("sharing history is independent per target agent", () => {
		const { broker } = createBroker();

		// Record 3 sharings for agent-A
		for (let i = 0; i < 3; i++) {
			broker.recordSharing(
				makeSharingDecision({
					targetAgentId: "agent-A",
					sourceAgentId: "source-1",
					information: `Info A-${i}`,
				}),
				DeltaType.PROMPT_COMPLETE,
			);
		}

		// Record 2 sharings for agent-B
		for (let i = 0; i < 2; i++) {
			broker.recordSharing(
				makeSharingDecision({
					targetAgentId: "agent-B",
					sourceAgentId: "source-2",
					information: `Info B-${i}`,
				}),
				DeltaType.FILE_WRITTEN,
			);
		}

		const recordsA = broker.getRecentSharingsForTarget("agent-A");
		const recordsB = broker.getRecentSharingsForTarget("agent-B");

		expect(recordsA).toHaveLength(3);
		expect(recordsB).toHaveLength(2);

		// Records for A should all have agent-A as target
		for (const r of recordsA) {
			expect(r.targetAgentId).toBe("agent-A");
			expect(r.sourceAgentId).toBe("source-1");
		}

		// Records for B should all have agent-B as target
		for (const r of recordsB) {
			expect(r.targetAgentId).toBe("agent-B");
			expect(r.sourceAgentId).toBe("source-2");
		}

		expect(broker.totalRecordedSharings).toBe(5);
	});

	// ── Test 7: informationSummary est tronqué à 200 caractères ──

	it("informationSummary is truncated to 200 characters", () => {
		const { broker } = createBroker();

		// Create a 500-character information string
		const longInfo = "A".repeat(500);
		expect(longInfo.length).toBe(500);

		broker.recordSharing(
			makeSharingDecision({
				targetAgentId: "agent-target",
				information: longInfo,
			}),
			DeltaType.FILE_WRITTEN,
		);

		const records = broker.getRecentSharingsForTarget("agent-target");
		expect(records).toHaveLength(1);
		expect(records[0]!.informationSummary.length).toBe(200);
		expect(records[0]!.informationSummary).toBe("A".repeat(200));
	});

	// ── Test 8: Le prompt LLM inclut l'historique de partage ──

	it("LLM prompt includes sharing history for targets", async () => {
		let capturedPrompt = "";

		const mockConversations = {
			sendOneShotJson: mock((_role: any, prompt: string) => {
				capturedPrompt = prompt;
				return Promise.resolve([
					{
						targetAgentId: "agent-2",
						shouldShare: false,
						reasoning: "Already shared similar info",
						information: "",
					},
				]);
			}),
		} as any;

		const tracker = new ContextTracker();
		const subtask1: SubTask = {
			id: "t1",
			prompt: "Build the API",
			role: "api-dev",
			dependencies: [],
			priority: 1,
		};
		const subtask2: SubTask = {
			id: "t2",
			prompt: "Write tests for the API",
			role: "test-writer",
			dependencies: ["t1"],
			priority: 2,
		};

		tracker.registerAgent("agent-1", "ApiDev", subtask1);
		tracker.registerAgent("agent-2", "TestWriter", subtask2);

		const subtaskToAgent = new Map([
			["t1", "agent-1"],
			["t2", "agent-2"],
		]);
		const agentToSubtask = new Map([
			["agent-1", "t1"],
			["agent-2", "t2"],
		]);

		const broker = new InformationBroker(
			mockConversations,
			tracker,
			[{ from: "t1", to: "t2", type: "blocking" }],
			silentLogger(),
			subtaskToAgent,
			agentToSubtask,
		);

		// Record a previous sharing to agent-2
		broker.recordSharing(
			makeSharingDecision({
				sourceAgentId: "agent-1",
				targetAgentId: "agent-2",
				information: "API has GET /users and POST /users endpoints",
			}),
			DeltaType.FILE_WRITTEN,
		);

		// Trigger evaluation with a new delta
		const delta: ContextDelta = {
			agentId: "agent-1",
			agentName: "ApiDev",
			timestamp: new Date().toISOString(),
			type: DeltaType.FILE_WRITTEN,
			summary: "Wrote products routes",
			data: { path: "src/routes/products.ts" },
			significance: 0.8,
			promptResultSummary: null,
		};

		await broker.evaluate(delta);

		// Verify the prompt includes the previously shared section
		expect(capturedPrompt).toContain("Previously shared to this agent");
		expect(capturedPrompt).toContain(
			"API has GET /users and POST /users endpoints",
		);
		expect(capturedPrompt).toContain(DeltaType.FILE_WRITTEN);
	});

	// ── Test 9: Le prompt contient le critère de non-redondance ──

	it("LLM prompt contains the non-redundancy criterion", async () => {
		let capturedPrompt = "";

		const mockConversations = {
			sendOneShotJson: mock((_role: any, prompt: string) => {
				capturedPrompt = prompt;
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
			dependencies: [],
			priority: 2,
		};

		tracker.registerAgent("agent-1", "Alpha", subtask1);
		tracker.registerAgent("agent-2", "Beta", subtask2);

		const broker = new InformationBroker(
			mockConversations,
			tracker,
			[],
			silentLogger(),
			new Map([
				["t1", "agent-1"],
				["t2", "agent-2"],
			]),
			new Map([
				["agent-1", "t1"],
				["agent-2", "t2"],
			]),
		);

		const delta: ContextDelta = {
			agentId: "agent-1",
			agentName: "Alpha",
			timestamp: new Date().toISOString(),
			type: DeltaType.PROMPT_COMPLETE,
			summary: "Completed prompt",
			data: {},
			significance: 0.8,
			promptResultSummary: null,
		};

		await broker.evaluate(delta);

		// The prompt should include the 5th criterion about non-redundancy
		expect(capturedPrompt).toContain(
			"Has similar or identical information already been shared to this target?",
		);
		expect(capturedPrompt).toContain("do NOT re-share");
	});

	// ── Test: previouslyShared is empty when no history exists ──

	it("prompt does NOT include previouslyShared section when history is empty", async () => {
		let capturedPrompt = "";

		const mockConversations = {
			sendOneShotJson: mock((_role: any, prompt: string) => {
				capturedPrompt = prompt;
				return Promise.resolve([
					{
						targetAgentId: "agent-2",
						shouldShare: false,
						reasoning: "Not useful",
						information: "",
					},
				]);
			}),
		} as any;

		const tracker = new ContextTracker();
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
			dependencies: [],
			priority: 2,
		};

		tracker.registerAgent("agent-1", "Alpha", subtask1);
		tracker.registerAgent("agent-2", "Beta", subtask2);

		const broker = new InformationBroker(
			mockConversations,
			tracker,
			[],
			silentLogger(),
			new Map([
				["t1", "agent-1"],
				["t2", "agent-2"],
			]),
			new Map([
				["agent-1", "t1"],
				["agent-2", "t2"],
			]),
		);

		const delta: ContextDelta = {
			agentId: "agent-1",
			agentName: "Alpha",
			timestamp: new Date().toISOString(),
			type: DeltaType.PROMPT_COMPLETE,
			summary: "Done",
			data: {},
			significance: 0.8,
			promptResultSummary: null,
		};

		await broker.evaluate(delta);

		// No history → no "Previously shared" section
		expect(capturedPrompt).not.toContain("Previously shared to this agent");
	});

	// ── Test: Multiple records with different delta types ──

	it("records preserve different delta types correctly", () => {
		const { broker } = createBroker();

		broker.recordSharing(
			makeSharingDecision({
				targetAgentId: "agent-X",
				information: "File content",
			}),
			DeltaType.FILE_WRITTEN,
		);
		broker.recordSharing(
			makeSharingDecision({
				targetAgentId: "agent-X",
				information: "Tool output",
			}),
			DeltaType.TOOL_COMPLETE,
		);
		broker.recordSharing(
			makeSharingDecision({
				targetAgentId: "agent-X",
				information: "Prompt result",
			}),
			DeltaType.PROMPT_COMPLETE,
		);

		const records = broker.getRecentSharingsForTarget("agent-X");
		expect(records).toHaveLength(3);
		expect(records[0]!.deltaType).toBe(DeltaType.FILE_WRITTEN);
		expect(records[1]!.deltaType).toBe(DeltaType.TOOL_COMPLETE);
		expect(records[2]!.deltaType).toBe(DeltaType.PROMPT_COMPLETE);
	});

	// ── Test: totalRecordedSharings counts across all targets ──

	it("totalRecordedSharings counts records across all targets", () => {
		const { broker } = createBroker();

		expect(broker.totalRecordedSharings).toBe(0);

		broker.recordSharing(
			makeSharingDecision({ targetAgentId: "a1" }),
			DeltaType.FILE_WRITTEN,
		);
		broker.recordSharing(
			makeSharingDecision({ targetAgentId: "a2" }),
			DeltaType.FILE_WRITTEN,
		);
		broker.recordSharing(
			makeSharingDecision({ targetAgentId: "a1" }),
			DeltaType.TOOL_COMPLETE,
		);

		expect(broker.totalRecordedSharings).toBe(3);
	});

	// ── Test: Records have valid ISO-8601 timestamps ──

	it("recorded sharings have valid ISO-8601 timestamps", () => {
		const { broker } = createBroker();

		const before = new Date().toISOString();
		broker.recordSharing(
			makeSharingDecision({ targetAgentId: "agent-t" }),
			DeltaType.PROMPT_COMPLETE,
		);
		const after = new Date().toISOString();

		const records = broker.getRecentSharingsForTarget("agent-t");
		expect(records).toHaveLength(1);

		const ts = records[0]!.timestamp;
		expect(ts).toBeTruthy();
		// Should be a valid ISO date
		expect(new Date(ts).toISOString()).toBe(ts);
		// Should be between before and after
		expect(ts >= before).toBe(true);
		expect(ts <= after).toBe(true);
	});

	// ── Test: Information shorter than 200 chars is not truncated ──

	it("informationSummary preserves short information without truncation", () => {
		const { broker } = createBroker();
		const shortInfo = "Short info, only 30 chars.....";

		broker.recordSharing(
			makeSharingDecision({ targetAgentId: "agent-t", information: shortInfo }),
			DeltaType.FILE_WRITTEN,
		);

		const records = broker.getRecentSharingsForTarget("agent-t");
		expect(records[0]!.informationSummary).toBe(shortInfo);
		expect(records[0]!.informationSummary.length).toBe(shortInfo.length);
	});

	// ── Test: getRecentSharingsForTarget returns readonly array ──

	it("getRecentSharingsForTarget returns records from oldest to newest", () => {
		const { broker } = createBroker();

		broker.recordSharing(
			makeSharingDecision({ targetAgentId: "agent-t", information: "First" }),
			DeltaType.FILE_WRITTEN,
		);
		broker.recordSharing(
			makeSharingDecision({ targetAgentId: "agent-t", information: "Second" }),
			DeltaType.TOOL_COMPLETE,
		);
		broker.recordSharing(
			makeSharingDecision({ targetAgentId: "agent-t", information: "Third" }),
			DeltaType.PROMPT_COMPLETE,
		);

		const records = broker.getRecentSharingsForTarget("agent-t");
		expect(records[0]!.informationSummary).toBe("First");
		expect(records[1]!.informationSummary).toBe("Second");
		expect(records[2]!.informationSummary).toBe("Third");
	});

	// ── Test: clearHistory followed by new records works correctly ──

	it("clearHistory allows fresh recording after clearing", () => {
		const { broker } = createBroker();

		broker.recordSharing(
			makeSharingDecision({
				targetAgentId: "agent-t",
				information: "Old info",
			}),
			DeltaType.FILE_WRITTEN,
		);
		expect(broker.totalRecordedSharings).toBe(1);

		broker.clearHistory();
		expect(broker.totalRecordedSharings).toBe(0);

		broker.recordSharing(
			makeSharingDecision({
				targetAgentId: "agent-t",
				information: "New info",
			}),
			DeltaType.PROMPT_COMPLETE,
		);
		expect(broker.totalRecordedSharings).toBe(1);

		const records = broker.getRecentSharingsForTarget("agent-t");
		expect(records).toHaveLength(1);
		expect(records[0]!.informationSummary).toBe("New info");
	});
});
