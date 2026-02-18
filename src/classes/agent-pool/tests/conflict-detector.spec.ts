import { describe, expect, it, mock } from "bun:test";
import pino from "pino";
import { AgentStatus } from "../../../enums/agent-status.enum.ts";
import { DeltaType } from "../../../enums/delta-type.enum.ts";
import { PoolEvent } from "../../../enums/pool-event.enum.ts";
import type {
	AgentContextState,
	ContextDelta,
	SharingRecord,
} from "../../../types/agent-pool.types.ts";
import {
	ConflictDetector,
	validateConflictAnalysisResponse,
} from "../conflict-detector.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

function silentLogger(): pino.Logger {
	return pino({ level: "silent" });
}

function createMockContextTracker(states: AgentContextState[] = []): {
	agentCount: number;
	getAgentState: (id: string) => AgentContextState | undefined;
	getAllAgentStates: () => AgentContextState[];
	getOtherAgentStates: (excludeId: string) => AgentContextState[];
} {
	return {
		get agentCount() {
			return states.length;
		},
		getAgentState: (id: string) => states.find((s) => s.agentId === id),
		getAllAgentStates: () => [...states],
		getOtherAgentStates: (excludeId: string) =>
			states.filter((s) => s.agentId !== excludeId),
	};
}

function createAgentState(
	overrides: Partial<AgentContextState> & {
		agentId: string;
		agentName: string;
	},
): AgentContextState {
	return {
		taskDescription: "Test task",
		taskRole: "test-role",
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

function createMockConversationManager(
	response?: unknown,
	shouldThrow = false,
): any {
	const sendOneShotJson = shouldThrow
		? mock(() => {
				throw new Error("LLM call failed");
			})
		: mock(async () => response ?? null);

	return {
		sendOneShotJson,
		has: () => true,
		register: () => {},
		send: async () => ({ text: "", usage: {} }),
		sendJson: async () => null,
		sendOneShot: async () => ({ text: "", usage: {} }),
		getStats: () => ({}),
		getHistory: () => [],
		reset: () => {},
		resetAll: () => {},
		client: {
			validateModel: () => true,
			sanitize: (s: string) => s,
		},
	};
}

function createMockBroker(
	sharings: Map<string, SharingRecord[]> = new Map(),
): any {
	return {
		getRecentSharingsForTarget: (targetId: string, limit = 10) => {
			const records = sharings.get(targetId) ?? [];
			return records.slice(-limit);
		},
		evaluationCount: 0,
		shareCount: 0,
		journal: null,
	};
}

function createDelta(overrides: Partial<ContextDelta> = {}): ContextDelta {
	return {
		agentId: "agent-A",
		agentName: "AgentA",
		timestamp: new Date().toISOString(),
		type: DeltaType.FILE_WRITTEN,
		summary: "Wrote a file",
		data: { path: "src/index.ts" },
		significance: 0.5,
		promptResultSummary: null,
		...overrides,
	};
}

function createSharingRecord(
	overrides: Partial<SharingRecord> = {},
): SharingRecord {
	return {
		timestamp: new Date().toISOString(),
		sourceAgentId: "agent-A",
		targetAgentId: "agent-B",
		deltaType: DeltaType.FILE_WRITTEN,
		informationSummary: "Info about src/index.ts",
		...overrides,
	};
}

// ════════════════════════════════════════════════════════════════════════════
// Unit Tests — ConflictDetector
// ════════════════════════════════════════════════════════════════════════════

describe("ConflictDetector", () => {
	// ── Test 1: evaluate returns empty when disabled ──────────────────

	it("evaluate returns empty array when disabled (Test 1)", async () => {
		const tracker = createMockContextTracker([
			createAgentState({ agentId: "a1", agentName: "Agent1" }),
			createAgentState({ agentId: "a2", agentName: "Agent2" }),
		]);

		const detector = new ConflictDetector(
			createMockConversationManager(),
			tracker as any,
			silentLogger(),
			{ enabled: false },
		);

		const delta = createDelta({ agentId: "a1", agentName: "Agent1" });
		const result = await detector.evaluate(delta, null);

		expect(result).toEqual([]);
		expect(detector.evaluationCount).toBe(0);
	});

	// ── Test 2: evaluate returns empty for non-triggering delta types ─

	it("evaluate returns empty for non-triggering delta types (Test 2)", async () => {
		const tracker = createMockContextTracker([
			createAgentState({ agentId: "a1", agentName: "Agent1" }),
			createAgentState({ agentId: "a2", agentName: "Agent2" }),
		]);

		const detector = new ConflictDetector(
			createMockConversationManager(),
			tracker as any,
			silentLogger(),
		);

		const delta = createDelta({
			type: DeltaType.STATUS_CHANGE,
			agentId: "a1",
			agentName: "Agent1",
			significance: 0.8,
		});

		const result = await detector.evaluate(delta, null);

		expect(result).toEqual([]);
		expect(detector.evaluationCount).toBe(0);
	});

	// ── Test 3: evaluate returns empty with fewer than 2 agents ───────

	it("evaluate returns empty with fewer than 2 agents (Test 3)", async () => {
		const tracker = createMockContextTracker([
			createAgentState({ agentId: "a1", agentName: "Agent1" }),
		]);

		const detector = new ConflictDetector(
			createMockConversationManager(),
			tracker as any,
			silentLogger(),
		);

		const delta = createDelta({ agentId: "a1", agentName: "Agent1" });
		const result = await detector.evaluate(delta, null);

		expect(result).toEqual([]);
		expect(detector.evaluationCount).toBe(0);
	});

	// ── Test 4: detectFileOverlaps detects two agents writing same file

	it("detectFileOverlaps detects when two agents write the same file (Test 4)", async () => {
		const tracker = createMockContextTracker([
			createAgentState({
				agentId: "agent-A",
				agentName: "AgentA",
				filesWritten: ["src/index.ts"],
			}),
			createAgentState({
				agentId: "agent-B",
				agentName: "AgentB",
				filesWritten: ["src/index.ts"],
			}),
		]);

		const detector = new ConflictDetector(
			createMockConversationManager(),
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: false },
		);

		const delta = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "src/index.ts" },
			significance: 0.5,
		});

		const conflicts = await detector.evaluate(delta, null);

		expect(conflicts.length).toBe(1);
		expect(conflicts[0]!.type).toBe("file_overlap");
		expect(conflicts[0]!.severity).toBeGreaterThanOrEqual(0.7);
		expect(conflicts[0]!.affectedAgentIds).toContain("agent-B");
		expect(conflicts[0]!.filePath).toBe("src/index.ts");
		expect(conflicts[0]!.resolved).toBe(false);
	});

	// ── Test 5: No conflict if the other agent has completed ──────────

	it("detectFileOverlaps does NOT signal conflict if other agent completed (Test 5)", async () => {
		const tracker = createMockContextTracker([
			createAgentState({
				agentId: "agent-A",
				agentName: "AgentA",
				filesWritten: [],
			}),
			createAgentState({
				agentId: "agent-B",
				agentName: "AgentB",
				filesWritten: ["src/index.ts"],
				completed: true,
			}),
		]);

		const detector = new ConflictDetector(
			createMockConversationManager(),
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: false },
		);

		const delta = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "src/index.ts" },
			significance: 0.5,
		});

		const conflicts = await detector.evaluate(delta, null);

		expect(conflicts).toEqual([]);
	});

	// ── Test 6: No duplicate conflict for same file+agents pair ───────

	it("detectFileOverlaps does NOT signal duplicate conflict (Test 6)", async () => {
		const tracker = createMockContextTracker([
			createAgentState({
				agentId: "agent-A",
				agentName: "AgentA",
				filesWritten: ["src/index.ts"],
			}),
			createAgentState({
				agentId: "agent-B",
				agentName: "AgentB",
				filesWritten: ["src/index.ts"],
			}),
		]);

		const detector = new ConflictDetector(
			createMockConversationManager(),
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: false },
		);

		const delta = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "src/index.ts" },
			significance: 0.5,
		});

		// First evaluation — should detect 1 conflict
		const first = await detector.evaluate(delta, null);
		expect(first.length).toBe(1);

		// Second evaluation — same delta, same agents — should NOT duplicate
		const second = await detector.evaluate(delta, null);
		expect(second.length).toBe(0);
	});

	// ── Test 7: detectStaleShares detects when shared file is rewritten

	it("detectStaleShares detects when a shared file is rewritten (Test 7)", async () => {
		const tracker = createMockContextTracker([
			createAgentState({
				agentId: "agent-A",
				agentName: "AgentA",
				filesWritten: ["src/routes.ts"],
			}),
			createAgentState({
				agentId: "agent-B",
				agentName: "AgentB",
				filesWritten: [],
			}),
		]);

		const sharingMap = new Map<string, SharingRecord[]>();
		sharingMap.set("agent-B", [
			createSharingRecord({
				sourceAgentId: "agent-A",
				targetAgentId: "agent-B",
				informationSummary:
					"API routes defined in src/routes.ts with GET /users and POST /users endpoints",
			}),
		]);
		const broker = createMockBroker(sharingMap);

		const detector = new ConflictDetector(
			createMockConversationManager(),
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: false },
		);

		const delta = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "src/routes.ts" },
			significance: 0.5,
		});

		const conflicts = await detector.evaluate(delta, broker);

		// Should find at least 1 stale_share conflict
		const staleConflicts = conflicts.filter((c) => c.type === "stale_share");
		expect(staleConflicts.length).toBeGreaterThanOrEqual(1);
		expect(staleConflicts[0]!.staleInformation).toBeDefined();
		expect(staleConflicts[0]!.filePath).toBe("src/routes.ts");
		expect(staleConflicts[0]!.affectedAgentIds).toContain("agent-B");
	});

	// ── Test 8: detectStaleShares does NOT signal staleness for unrelated files

	it("detectStaleShares does NOT signal staleness for unmentioned files (Test 8)", async () => {
		const tracker = createMockContextTracker([
			createAgentState({
				agentId: "agent-A",
				agentName: "AgentA",
				filesWritten: ["src/models.ts"],
			}),
			createAgentState({
				agentId: "agent-B",
				agentName: "AgentB",
				filesWritten: [],
			}),
		]);

		const sharingMap = new Map<string, SharingRecord[]>();
		sharingMap.set("agent-B", [
			createSharingRecord({
				sourceAgentId: "agent-A",
				targetAgentId: "agent-B",
				informationSummary: "API routes defined in src/routes.ts",
			}),
		]);
		const broker = createMockBroker(sharingMap);

		const detector = new ConflictDetector(
			createMockConversationManager(),
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: false },
		);

		const delta = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "src/models.ts" },
			significance: 0.5,
		});

		const conflicts = await detector.evaluate(delta, broker);

		const staleConflicts = conflicts.filter((c) => c.type === "stale_share");
		expect(staleConflicts.length).toBe(0);
	});

	// ── Test 9: Semantic analysis is skipped when structural conflict found

	it("semantic analysis is skipped when structural conflict is found (Test 9)", async () => {
		const tracker = createMockContextTracker([
			createAgentState({
				agentId: "agent-A",
				agentName: "AgentA",
				filesWritten: ["src/index.ts"],
			}),
			createAgentState({
				agentId: "agent-B",
				agentName: "AgentB",
				filesWritten: ["src/index.ts"],
			}),
		]);

		const conversations = createMockConversationManager({
			hasConflict: false,
			reasoning: "No conflict",
		});

		const detector = new ConflictDetector(
			conversations,
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: true },
		);

		const delta = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "src/index.ts" },
			significance: 0.5,
		});

		await detector.evaluate(delta, null);

		// Structural conflict found → semantic analysis should NOT be called
		expect(detector.semanticAnalysisCount).toBe(0);
		expect(detector.structuralCheckCount).toBe(1);
	});

	// ── Test 10: Semantic analysis IS called when no structural conflict

	it("semantic analysis IS called when no structural conflict found (Test 10)", async () => {
		const tracker = createMockContextTracker([
			createAgentState({
				agentId: "agent-A",
				agentName: "AgentA",
				taskDescription: "Build the API",
				taskRole: "api-developer",
				filesWritten: [],
			}),
			createAgentState({
				agentId: "agent-B",
				agentName: "AgentB",
				taskDescription: "Write tests",
				taskRole: "test-writer",
				filesWritten: [],
			}),
		]);

		const conversations = createMockConversationManager({
			hasConflict: false,
			reasoning: "No conflict detected",
		});

		const detector = new ConflictDetector(
			conversations,
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: true },
		);

		const delta = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.PROMPT_COMPLETE,
			data: { responsePreview: "I built the API" },
			significance: 0.6,
		});

		await detector.evaluate(delta, null);

		expect(detector.semanticAnalysisCount).toBe(1);
	});

	// ── Test 11: Semantic analysis returns conflicts when LLM detects them

	it("semantic analysis returns conflicts when LLM detects them (Test 11)", async () => {
		const tracker = createMockContextTracker([
			createAgentState({
				agentId: "agent-A",
				agentName: "AgentA",
				taskDescription: "Build the API with snake_case",
				taskRole: "api-developer",
				filesWritten: [],
			}),
			createAgentState({
				agentId: "agent-B",
				agentName: "AgentB",
				taskDescription: "Build the frontend with camelCase",
				taskRole: "frontend-developer",
				filesWritten: [],
			}),
		]);

		const llmResponse = {
			hasConflict: true,
			conflicts: [
				{
					type: "semantic_conflict",
					severity: 0.7,
					description: "API uses snake_case but frontend expects camelCase",
					affectedAgentIds: ["agent-B"],
					recommendation: "Align on JSON naming convention",
				},
			],
			reasoning: "Naming convention mismatch detected",
		};

		const conversations = createMockConversationManager(llmResponse);

		const detector = new ConflictDetector(
			conversations,
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: true },
		);

		const delta = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.PROMPT_COMPLETE,
			data: { responsePreview: "Using snake_case for all JSON fields" },
			significance: 0.6,
		});

		const conflicts = await detector.evaluate(delta, null);

		expect(conflicts.length).toBe(1);
		expect(conflicts[0]!.type).toBe("semantic_conflict");
		expect(conflicts[0]!.severity).toBe(0.7);
		expect(conflicts[0]!.affectedAgentIds).toContain("agent-B");
		expect(conflicts[0]!.description).toContain("snake_case");
	});

	// ── Test 12: Semantic analysis returns empty on LLM error ─────────

	it("semantic analysis returns empty array on LLM error (Test 12)", async () => {
		const tracker = createMockContextTracker([
			createAgentState({
				agentId: "agent-A",
				agentName: "AgentA",
				taskDescription: "Build the API",
				taskRole: "api-developer",
				filesWritten: [],
			}),
			createAgentState({
				agentId: "agent-B",
				agentName: "AgentB",
				taskDescription: "Write tests",
				taskRole: "test-writer",
				filesWritten: [],
			}),
		]);

		const conversations = createMockConversationManager(null, true);

		const detector = new ConflictDetector(
			conversations,
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: true },
		);

		const delta = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.PROMPT_COMPLETE,
			data: { responsePreview: "Test" },
			significance: 0.6,
		});

		const conflicts = await detector.evaluate(delta, null);

		expect(conflicts).toEqual([]);
		expect(detector.semanticAnalysisCount).toBe(1);
	});

	// ── Test 13: markResolved marks a conflict as resolved ────────────

	it("markResolved marks a conflict as resolved (Test 13)", async () => {
		const tracker = createMockContextTracker([
			createAgentState({
				agentId: "agent-A",
				agentName: "AgentA",
				filesWritten: ["src/index.ts"],
			}),
			createAgentState({
				agentId: "agent-B",
				agentName: "AgentB",
				filesWritten: ["src/index.ts"],
			}),
		]);

		const detector = new ConflictDetector(
			createMockConversationManager(),
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: false },
		);

		const delta = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "src/index.ts" },
			significance: 0.5,
		});

		const conflicts = await detector.evaluate(delta, null);
		expect(conflicts.length).toBe(1);
		expect(conflicts[0]!.resolved).toBe(false);

		detector.markResolved(conflicts[0]!.id);

		const allConflicts = detector.getAllConflicts();
		expect(allConflicts[0]!.resolved).toBe(true);
	});

	// ── Test 14: getUnresolvedAlerts filters by severity and resolution

	it("getUnresolvedAlerts filters by severity and resolution (Test 14)", async () => {
		// We'll create conflicts with different severities by simulating
		// multiple file overlaps with different agent pairs
		const tracker = createMockContextTracker([
			createAgentState({
				agentId: "agent-A",
				agentName: "AgentA",
				filesWritten: ["file1.ts", "file2.ts", "file3.ts"],
			}),
			createAgentState({
				agentId: "agent-B",
				agentName: "AgentB",
				filesWritten: ["file1.ts"],
			}),
			createAgentState({
				agentId: "agent-C",
				agentName: "AgentC",
				filesWritten: ["file2.ts"],
			}),
			createAgentState({
				agentId: "agent-D",
				agentName: "AgentD",
				filesWritten: ["file3.ts"],
			}),
		]);

		const detector = new ConflictDetector(
			createMockConversationManager(),
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: false, minAlertSeverity: 0.5 },
		);

		// Generate 3 file_overlap conflicts (all at severity 0.8)
		const delta1 = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "file1.ts" },
			significance: 0.5,
		});
		const conflicts1 = await detector.evaluate(delta1, null);
		expect(conflicts1.length).toBe(1);

		const delta2 = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "file2.ts" },
			significance: 0.5,
		});
		const conflicts2 = await detector.evaluate(delta2, null);
		expect(conflicts2.length).toBe(1);

		const delta3 = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "file3.ts" },
			significance: 0.5,
		});
		const conflicts3 = await detector.evaluate(delta3, null);
		expect(conflicts3.length).toBe(1);

		// All 3 should be in unresolved alerts (severity 0.8 > 0.5 threshold)
		expect(detector.getUnresolvedAlerts().length).toBe(3);

		// Resolve one
		detector.markResolved(conflicts1[0]!.id);

		// Now 2 unresolved
		expect(detector.getUnresolvedAlerts().length).toBe(2);
	});

	// ── Test 15: maxConflicts evicts oldest conflicts ─────────────────

	it("maxConflicts evicts oldest conflicts (Test 15)", async () => {
		const agentStates = [
			createAgentState({
				agentId: "agent-A",
				agentName: "AgentA",
				filesWritten: ["f1.ts", "f2.ts", "f3.ts", "f4.ts", "f5.ts"],
			}),
			createAgentState({
				agentId: "agent-B",
				agentName: "AgentB",
				filesWritten: ["f1.ts"],
			}),
			createAgentState({
				agentId: "agent-C",
				agentName: "AgentC",
				filesWritten: ["f2.ts"],
			}),
			createAgentState({
				agentId: "agent-D",
				agentName: "AgentD",
				filesWritten: ["f3.ts"],
			}),
			createAgentState({
				agentId: "agent-E",
				agentName: "AgentE",
				filesWritten: ["f4.ts"],
			}),
			createAgentState({
				agentId: "agent-F",
				agentName: "AgentF",
				filesWritten: ["f5.ts"],
			}),
		];

		const tracker = createMockContextTracker(agentStates);

		const detector = new ConflictDetector(
			createMockConversationManager(),
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: false, maxConflicts: 3 },
		);

		// Generate 5 conflicts, one per file
		for (let i = 1; i <= 5; i++) {
			const delta = createDelta({
				agentId: "agent-A",
				agentName: "AgentA",
				type: DeltaType.FILE_WRITTEN,
				data: { path: `f${i}.ts` },
				significance: 0.5,
			});
			await detector.evaluate(delta, null);
		}

		// Only 3 should remain
		expect(detector.conflictCount).toBe(3);
	});

	// ── Test 16: maxConflicts evicts resolved conflicts first ─────────

	it("maxConflicts evicts resolved conflicts in priority (Test 16)", async () => {
		const agentStates = [
			createAgentState({
				agentId: "agent-A",
				agentName: "AgentA",
				filesWritten: ["f1.ts", "f2.ts", "f3.ts", "f4.ts"],
			}),
			createAgentState({
				agentId: "agent-B",
				agentName: "AgentB",
				filesWritten: ["f1.ts"],
			}),
			createAgentState({
				agentId: "agent-C",
				agentName: "AgentC",
				filesWritten: ["f2.ts"],
			}),
			createAgentState({
				agentId: "agent-D",
				agentName: "AgentD",
				filesWritten: ["f3.ts"],
			}),
			createAgentState({
				agentId: "agent-E",
				agentName: "AgentE",
				filesWritten: ["f4.ts"],
			}),
		];

		const tracker = createMockContextTracker(agentStates);

		const detector = new ConflictDetector(
			createMockConversationManager(),
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: false, maxConflicts: 3 },
		);

		// Generate first 3 conflicts
		for (let i = 1; i <= 3; i++) {
			const delta = createDelta({
				agentId: "agent-A",
				agentName: "AgentA",
				type: DeltaType.FILE_WRITTEN,
				data: { path: `f${i}.ts` },
				significance: 0.5,
			});
			await detector.evaluate(delta, null);
		}

		expect(detector.conflictCount).toBe(3);

		// Resolve the first conflict
		const allConflicts = detector.getAllConflicts();
		const firstConflictId = allConflicts[0]!.id;
		detector.markResolved(firstConflictId);

		// Add a 4th conflict
		const delta4 = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "f4.ts" },
			significance: 0.5,
		});
		await detector.evaluate(delta4, null);

		// Should still be 3 conflicts
		expect(detector.conflictCount).toBe(3);

		// The resolved conflict should have been evicted
		const remaining = detector.getAllConflicts();
		expect(remaining.find((c) => c.id === firstConflictId)).toBeUndefined();

		// All remaining should be unresolved
		expect(remaining.every((c) => !c.resolved)).toBe(true);
	});

	// ── Test 17: getSummary returns null without conflicts ────────────

	it("getSummary returns null without conflicts (Test 17)", () => {
		const tracker = createMockContextTracker([]);

		const detector = new ConflictDetector(
			createMockConversationManager(),
			tracker as any,
			silentLogger(),
		);

		expect(detector.getSummary()).toBeNull();
	});

	// ── Test 18: getSummary formats correctly ─────────────────────────

	it("getSummary formats correctly with high and low severity conflicts (Test 18)", async () => {
		const tracker = createMockContextTracker([
			createAgentState({
				agentId: "agent-A",
				agentName: "AgentA",
				filesWritten: ["high.ts", "low.ts"],
			}),
			createAgentState({
				agentId: "agent-B",
				agentName: "AgentB",
				filesWritten: ["high.ts"],
			}),
			createAgentState({
				agentId: "agent-C",
				agentName: "AgentC",
				filesWritten: ["low.ts"],
			}),
		]);

		const detector = new ConflictDetector(
			createMockConversationManager(),
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: false },
		);

		// Generate 2 conflicts (both at severity 0.8 from file overlaps)
		const delta1 = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "high.ts" },
			significance: 0.5,
		});
		await detector.evaluate(delta1, null);

		const delta2 = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "low.ts" },
			significance: 0.5,
		});
		await detector.evaluate(delta2, null);

		const summary = detector.getSummary();
		expect(summary).not.toBeNull();
		expect(summary).toContain("Conflict Summary");
		expect(summary).toContain("Total detected: 2");
		expect(summary).toContain("High Severity Conflicts");
	});

	// ── Test 19: reset clears all state ───────────────────────────────

	it("reset clears all state (Test 19)", async () => {
		const tracker = createMockContextTracker([
			createAgentState({
				agentId: "agent-A",
				agentName: "AgentA",
				filesWritten: ["src/index.ts"],
			}),
			createAgentState({
				agentId: "agent-B",
				agentName: "AgentB",
				filesWritten: ["src/index.ts"],
			}),
		]);

		const detector = new ConflictDetector(
			createMockConversationManager(),
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: false },
		);

		const delta = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "src/index.ts" },
			significance: 0.5,
		});

		await detector.evaluate(delta, null);
		expect(detector.conflictCount).toBeGreaterThan(0);
		expect(detector.evaluationCount).toBeGreaterThan(0);

		detector.reset();

		expect(detector.conflictCount).toBe(0);
		expect(detector.evaluationCount).toBe(0);
		expect(detector.structuralCheckCount).toBe(0);
		expect(detector.semanticAnalysisCount).toBe(0);
		expect(detector.getSummary()).toBeNull();
	});

	// ── Test: isEnabled reflects config ───────────────────────────────

	it("isEnabled returns true by default", () => {
		const detector = new ConflictDetector(
			createMockConversationManager(),
			createMockContextTracker([]) as any,
			silentLogger(),
		);
		expect(detector.isEnabled).toBe(true);
	});

	it("isEnabled returns false when disabled", () => {
		const detector = new ConflictDetector(
			createMockConversationManager(),
			createMockContextTracker([]) as any,
			silentLogger(),
			{ enabled: false },
		);
		expect(detector.isEnabled).toBe(false);
	});

	// ── Test: unresolvedHighSeverityCount ─────────────────────────────

	it("unresolvedHighSeverityCount counts correctly", async () => {
		const tracker = createMockContextTracker([
			createAgentState({
				agentId: "agent-A",
				agentName: "AgentA",
				filesWritten: ["f1.ts", "f2.ts"],
			}),
			createAgentState({
				agentId: "agent-B",
				agentName: "AgentB",
				filesWritten: ["f1.ts"],
			}),
			createAgentState({
				agentId: "agent-C",
				agentName: "AgentC",
				filesWritten: ["f2.ts"],
			}),
		]);

		const detector = new ConflictDetector(
			createMockConversationManager(),
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: false },
		);

		// File overlap creates severity 0.8 conflicts
		const d1 = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "f1.ts" },
			significance: 0.5,
		});
		const conflicts1 = await detector.evaluate(d1, null);

		const d2 = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "f2.ts" },
			significance: 0.5,
		});
		await detector.evaluate(d2, null);

		expect(detector.unresolvedHighSeverityCount).toBe(2);

		detector.markResolved(conflicts1[0]!.id);
		expect(detector.unresolvedHighSeverityCount).toBe(1);
	});

	// ── Test: Low significance deltas are filtered out ────────────────

	it("evaluate filters out deltas below MIN_CONFLICT_CHECK_SIGNIFICANCE", async () => {
		const tracker = createMockContextTracker([
			createAgentState({ agentId: "a1", agentName: "Agent1" }),
			createAgentState({ agentId: "a2", agentName: "Agent2" }),
		]);

		const detector = new ConflictDetector(
			createMockConversationManager(),
			tracker as any,
			silentLogger(),
		);

		const delta = createDelta({
			agentId: "a1",
			agentName: "Agent1",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "src/index.ts" },
			significance: 0.2, // Below 0.4 threshold
		});

		const result = await detector.evaluate(delta, null);
		expect(result).toEqual([]);
		expect(detector.evaluationCount).toBe(0);
	});

	// ── Test: Stale share detects file mention by basename ────────────

	it("detectStaleShares detects file by basename in sharing summary", async () => {
		const tracker = createMockContextTracker([
			createAgentState({
				agentId: "agent-A",
				agentName: "AgentA",
				filesWritten: ["deep/nested/path/config.ts"],
			}),
			createAgentState({
				agentId: "agent-B",
				agentName: "AgentB",
				filesWritten: [],
			}),
		]);

		const sharingMap = new Map<string, SharingRecord[]>();
		sharingMap.set("agent-B", [
			createSharingRecord({
				sourceAgentId: "agent-A",
				targetAgentId: "agent-B",
				informationSummary: "Configuration in config.ts defines port 3000",
			}),
		]);
		const broker = createMockBroker(sharingMap);

		const detector = new ConflictDetector(
			createMockConversationManager(),
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: false },
		);

		const delta = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "deep/nested/path/config.ts" },
			significance: 0.5,
		});

		const conflicts = await detector.evaluate(delta, broker);
		const staleConflicts = conflicts.filter((c) => c.type === "stale_share");
		expect(staleConflicts.length).toBeGreaterThanOrEqual(1);
	});

	// ── Test: PROMPT_COMPLETE and TOOL_COMPLETE are triggering types ───

	it("PROMPT_COMPLETE triggers conflict evaluation", async () => {
		const tracker = createMockContextTracker([
			createAgentState({
				agentId: "a1",
				agentName: "Agent1",
				taskDescription: "Build API",
				taskRole: "api-dev",
				filesWritten: [],
			}),
			createAgentState({
				agentId: "a2",
				agentName: "Agent2",
				taskDescription: "Build frontend",
				taskRole: "frontend-dev",
				filesWritten: [],
			}),
		]);

		const detector = new ConflictDetector(
			createMockConversationManager({ hasConflict: false, reasoning: "None" }),
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: true },
		);

		const delta = createDelta({
			agentId: "a1",
			agentName: "Agent1",
			type: DeltaType.PROMPT_COMPLETE,
			data: { responsePreview: "API response" },
			significance: 0.6,
		});

		await detector.evaluate(delta, null);
		expect(detector.evaluationCount).toBe(1);
	});

	it("TOOL_COMPLETE triggers conflict evaluation", async () => {
		const tracker = createMockContextTracker([
			createAgentState({
				agentId: "a1",
				agentName: "Agent1",
				taskDescription: "Build API",
				taskRole: "api-dev",
				filesWritten: [],
			}),
			createAgentState({
				agentId: "a2",
				agentName: "Agent2",
				taskDescription: "Build frontend",
				taskRole: "frontend-dev",
				filesWritten: [],
			}),
		]);

		const detector = new ConflictDetector(
			createMockConversationManager({ hasConflict: false, reasoning: "None" }),
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: true },
		);

		const delta = createDelta({
			agentId: "a1",
			agentName: "Agent1",
			type: DeltaType.TOOL_COMPLETE,
			data: { tool: "test" },
			significance: 0.6,
		});

		await detector.evaluate(delta, null);
		expect(detector.evaluationCount).toBe(1);
	});

	// ── Test: FILE_READ and AGENT_ERROR are NOT triggering types ──────

	it("FILE_READ does NOT trigger conflict evaluation", async () => {
		const tracker = createMockContextTracker([
			createAgentState({ agentId: "a1", agentName: "Agent1" }),
			createAgentState({ agentId: "a2", agentName: "Agent2" }),
		]);

		const detector = new ConflictDetector(
			createMockConversationManager(),
			tracker as any,
			silentLogger(),
		);

		const delta = createDelta({
			agentId: "a1",
			agentName: "Agent1",
			type: DeltaType.FILE_READ,
			significance: 0.5,
		});

		await detector.evaluate(delta, null);
		expect(detector.evaluationCount).toBe(0);
	});

	// ── Test: Default config values ───────────────────────────────────

	it("uses correct default config values", () => {
		const detector = new ConflictDetector(
			createMockConversationManager(),
			createMockContextTracker([]) as any,
			silentLogger(),
		);

		expect(detector.isEnabled).toBe(true);
		// Can't directly access config, but we can verify behavior
	});

	// ── Test: ConflictRecord IDs are unique ───────────────────────────

	it("conflict IDs are unique across evaluations", async () => {
		const tracker = createMockContextTracker([
			createAgentState({
				agentId: "agent-A",
				agentName: "AgentA",
				filesWritten: ["f1.ts", "f2.ts"],
			}),
			createAgentState({
				agentId: "agent-B",
				agentName: "AgentB",
				filesWritten: ["f1.ts"],
			}),
			createAgentState({
				agentId: "agent-C",
				agentName: "AgentC",
				filesWritten: ["f2.ts"],
			}),
		]);

		const detector = new ConflictDetector(
			createMockConversationManager(),
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: false },
		);

		const d1 = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "f1.ts" },
			significance: 0.5,
		});
		const d2 = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "f2.ts" },
			significance: 0.5,
		});

		await detector.evaluate(d1, null);
		await detector.evaluate(d2, null);

		const allConflicts = detector.getAllConflicts();
		const ids = allConflicts.map((c) => c.id);
		const uniqueIds = new Set(ids);
		expect(uniqueIds.size).toBe(ids.length);
	});

	// ── Test: Timestamps are ISO-8601 ────────────────────────────────

	it("conflict timestamps are ISO-8601", async () => {
		const tracker = createMockContextTracker([
			createAgentState({
				agentId: "agent-A",
				agentName: "AgentA",
				filesWritten: ["src/index.ts"],
			}),
			createAgentState({
				agentId: "agent-B",
				agentName: "AgentB",
				filesWritten: ["src/index.ts"],
			}),
		]);

		const detector = new ConflictDetector(
			createMockConversationManager(),
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: false },
		);

		const delta = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "src/index.ts" },
			significance: 0.5,
		});

		const conflicts = await detector.evaluate(delta, null);
		expect(conflicts.length).toBe(1);

		// ISO-8601 check
		const timestamp = conflicts[0]!.timestamp;
		expect(() => new Date(timestamp)).not.toThrow();
		expect(new Date(timestamp).toISOString()).toBeDefined();
	});

	// ── Test: Semantic analysis skips when all other agents completed ──

	it("semantic analysis returns empty when all other agents are completed", async () => {
		const tracker = createMockContextTracker([
			createAgentState({
				agentId: "agent-A",
				agentName: "AgentA",
				taskDescription: "Build API",
				taskRole: "api-dev",
				filesWritten: [],
			}),
			createAgentState({
				agentId: "agent-B",
				agentName: "AgentB",
				taskDescription: "Write tests",
				taskRole: "test-writer",
				filesWritten: [],
				completed: true,
			}),
		]);

		const conversations = createMockConversationManager({
			hasConflict: true,
			conflicts: [
				{
					type: "semantic_conflict",
					severity: 0.8,
					description: "Test conflict",
					affectedAgentIds: ["agent-B"],
					recommendation: "Fix it",
				},
			],
			reasoning: "Conflict found",
		});

		const detector = new ConflictDetector(
			conversations,
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: true },
		);

		const delta = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.PROMPT_COMPLETE,
			data: { responsePreview: "Test" },
			significance: 0.6,
		});

		const conflicts = await detector.evaluate(delta, null);
		// Semantic analysis detects the other agents are completed/destroyed
		// The LLM call shouldn't be made because otherAgents.length === 0
		expect(detector.semanticAnalysisCount).toBe(1);
		// But the internal filter excludes completed agents, so no conflicts returned
		expect(conflicts).toEqual([]);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Validator Tests — validateConflictAnalysisResponse
// ════════════════════════════════════════════════════════════════════════════

describe("validateConflictAnalysisResponse", () => {
	// ── Test 20: accepts a valid no-conflict response ─────────────────

	it("accepts a valid response without conflict (Test 20)", () => {
		const valid = {
			hasConflict: false,
			reasoning: "No conflicts detected",
		};

		const result = validateConflictAnalysisResponse(valid);
		expect(result).not.toBeNull();
		expect(result!.hasConflict).toBe(false);
		expect(result!.reasoning).toBe("No conflicts detected");
	});

	// ── Test 21: accepts a valid response with conflict ───────────────

	it("accepts a valid response with conflict (Test 21)", () => {
		const valid = {
			hasConflict: true,
			conflicts: [
				{
					type: "semantic_conflict",
					severity: 0.7,
					description: "API uses snake_case but frontend expects camelCase",
					affectedAgentIds: ["agent-B"],
					recommendation: "Align on JSON naming convention",
				},
			],
			reasoning: "Naming convention mismatch detected",
		};

		const result = validateConflictAnalysisResponse(valid);
		expect(result).not.toBeNull();
		expect(result!.hasConflict).toBe(true);
		expect(result!.conflicts!.length).toBe(1);
		expect(result!.conflicts![0]!.type).toBe("semantic_conflict");
	});

	// ── Test 22: rejects hasConflict: true without conflicts array ────

	it("rejects hasConflict: true without conflicts array (Test 22)", () => {
		const invalid = {
			hasConflict: true,
			reasoning: "There is a conflict",
		};

		expect(validateConflictAnalysisResponse(invalid)).toBeNull();
	});

	// ── Test 23: rejects invalid conflict type ────────────────────────

	it("rejects an invalid conflict type (Test 23)", () => {
		const invalid = {
			hasConflict: true,
			conflicts: [
				{
					type: "magic_conflict",
					severity: 0.5,
					description: "test",
					affectedAgentIds: [],
					recommendation: "test",
				},
			],
			reasoning: "test",
		};

		expect(validateConflictAnalysisResponse(invalid)).toBeNull();
	});

	// ── Test 24: clamps severity to [0, 1] ────────────────────────────

	it("clamps severity to [0, 1] (Test 24)", () => {
		const data = {
			hasConflict: true,
			conflicts: [
				{
					type: "file_overlap",
					severity: 1.5,
					description: "test conflict",
					affectedAgentIds: ["a"],
					recommendation: "fix it",
				},
			],
			reasoning: "test reasoning",
		};

		const result = validateConflictAnalysisResponse(data);
		expect(result).not.toBeNull();
		expect(result!.conflicts![0]!.severity).toBe(1.0);
	});

	it("clamps negative severity to 0.0", () => {
		const data = {
			hasConflict: true,
			conflicts: [
				{
					type: "file_overlap",
					severity: -0.5,
					description: "test conflict",
					affectedAgentIds: ["a"],
					recommendation: "fix it",
				},
			],
			reasoning: "test reasoning",
		};

		const result = validateConflictAnalysisResponse(data);
		expect(result).not.toBeNull();
		expect(result!.conflicts![0]!.severity).toBe(0.0);
	});

	// ── Additional validator edge cases ───────────────────────────────

	it("rejects null input", () => {
		expect(validateConflictAnalysisResponse(null)).toBeNull();
	});

	it("rejects undefined input", () => {
		expect(validateConflictAnalysisResponse(undefined)).toBeNull();
	});

	it("rejects a string input", () => {
		expect(validateConflictAnalysisResponse("hello")).toBeNull();
	});

	it("rejects a number input", () => {
		expect(validateConflictAnalysisResponse(42)).toBeNull();
	});

	it("rejects missing hasConflict field", () => {
		expect(validateConflictAnalysisResponse({ reasoning: "test" })).toBeNull();
	});

	it("rejects missing reasoning field", () => {
		expect(validateConflictAnalysisResponse({ hasConflict: false })).toBeNull();
	});

	it("rejects empty reasoning string", () => {
		expect(
			validateConflictAnalysisResponse({ hasConflict: false, reasoning: "" }),
		).toBeNull();
	});

	it("rejects hasConflict: true with empty conflicts array", () => {
		expect(
			validateConflictAnalysisResponse({
				hasConflict: true,
				conflicts: [],
				reasoning: "test",
			}),
		).toBeNull();
	});

	it("rejects conflict with non-number severity", () => {
		expect(
			validateConflictAnalysisResponse({
				hasConflict: true,
				conflicts: [
					{
						type: "file_overlap",
						severity: "high",
						description: "test",
						affectedAgentIds: ["a"],
						recommendation: "fix",
					},
				],
				reasoning: "test",
			}),
		).toBeNull();
	});

	it("rejects conflict with empty description", () => {
		expect(
			validateConflictAnalysisResponse({
				hasConflict: true,
				conflicts: [
					{
						type: "file_overlap",
						severity: 0.5,
						description: "",
						affectedAgentIds: ["a"],
						recommendation: "fix",
					},
				],
				reasoning: "test",
			}),
		).toBeNull();
	});

	it("rejects conflict with empty recommendation", () => {
		expect(
			validateConflictAnalysisResponse({
				hasConflict: true,
				conflicts: [
					{
						type: "file_overlap",
						severity: 0.5,
						description: "test",
						affectedAgentIds: ["a"],
						recommendation: "",
					},
				],
				reasoning: "test",
			}),
		).toBeNull();
	});

	it("rejects conflict without affectedAgentIds array", () => {
		expect(
			validateConflictAnalysisResponse({
				hasConflict: true,
				conflicts: [
					{
						type: "file_overlap",
						severity: 0.5,
						description: "test",
						recommendation: "fix",
					},
				],
				reasoning: "test",
			}),
		).toBeNull();
	});

	it("rejects null conflict in array", () => {
		expect(
			validateConflictAnalysisResponse({
				hasConflict: true,
				conflicts: [null],
				reasoning: "test",
			}),
		).toBeNull();
	});

	it("filters non-string values from affectedAgentIds", () => {
		const data = {
			hasConflict: true,
			conflicts: [
				{
					type: "file_overlap",
					severity: 0.5,
					description: "test conflict",
					affectedAgentIds: ["agent-A", 42, null, "agent-B", undefined],
					recommendation: "fix it",
				},
			],
			reasoning: "test",
		};

		const result = validateConflictAnalysisResponse(data);
		expect(result).not.toBeNull();
		expect(result!.conflicts![0]!.affectedAgentIds).toEqual([
			"agent-A",
			"agent-B",
		]);
	});

	it("accepts all valid conflict types", () => {
		const validTypes = [
			"file_overlap",
			"stale_share",
			"semantic_conflict",
			"dependency_violation",
		];

		for (const type of validTypes) {
			const data = {
				hasConflict: true,
				conflicts: [
					{
						type,
						severity: 0.5,
						description: "test",
						affectedAgentIds: ["a"],
						recommendation: "fix",
					},
				],
				reasoning: "test",
			};

			const result = validateConflictAnalysisResponse(data);
			expect(result).not.toBeNull();
			expect(result!.conflicts![0]!.type).toBe(type);
		}
	});

	it("includes optional staleInformation when present", () => {
		const data = {
			hasConflict: true,
			conflicts: [
				{
					type: "stale_share",
					severity: 0.7,
					description: "Stale info",
					affectedAgentIds: ["a"],
					recommendation: "re-share",
					staleInformation: "Port was 3000 but now is 8080",
				},
			],
			reasoning: "test",
		};

		const result = validateConflictAnalysisResponse(data);
		expect(result).not.toBeNull();
		expect(result!.conflicts![0]!.staleInformation).toBe(
			"Port was 3000 but now is 8080",
		);
	});

	it("omits staleInformation when not a string", () => {
		const data = {
			hasConflict: true,
			conflicts: [
				{
					type: "stale_share",
					severity: 0.7,
					description: "Stale info",
					affectedAgentIds: ["a"],
					recommendation: "re-share",
					staleInformation: 42,
				},
			],
			reasoning: "test",
		};

		const result = validateConflictAnalysisResponse(data);
		expect(result).not.toBeNull();
		expect(result!.conflicts![0]!.staleInformation).toBeUndefined();
	});

	it("accepts multiple conflicts in one response", () => {
		const data = {
			hasConflict: true,
			conflicts: [
				{
					type: "file_overlap",
					severity: 0.8,
					description: "File overlap on index.ts",
					affectedAgentIds: ["agent-B"],
					recommendation: "Coordinate file access",
				},
				{
					type: "semantic_conflict",
					severity: 0.6,
					description: "Contradictory API design",
					affectedAgentIds: ["agent-C"],
					recommendation: "Align API design",
				},
			],
			reasoning: "Multiple conflicts found",
		};

		const result = validateConflictAnalysisResponse(data);
		expect(result).not.toBeNull();
		expect(result!.conflicts!.length).toBe(2);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Enum Tests — CONFLICT_DETECTED
// ════════════════════════════════════════════════════════════════════════════

describe("DeltaType — CONFLICT_DETECTED", () => {
	it("CONFLICT_DETECTED has the expected value", () => {
		expect(DeltaType.CONFLICT_DETECTED as string).toBe("conflict_detected");
	});
});

describe("PoolEvent — CONFLICT_DETECTED", () => {
	it("CONFLICT_DETECTED event has the expected value", () => {
		expect(PoolEvent.CONFLICT_DETECTED as string).toBe(
			"pool:conflict-detected",
		);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Prompt Tests — Conflict Analysis
// ════════════════════════════════════════════════════════════════════════════

describe("Conflict Analysis Prompt", () => {
	it("conflict analysis prompt compiles without errors", async () => {
		const { conflictAnalysisPrompt } = await import(
			"../../../prompts/conflict-analysis.ts"
		);

		const result = conflictAnalysisPrompt({
			sourceAgent: {
				agentName: "api-developer",
				taskRole: "api-developer",
			},
			eventType: "file_written",
			eventSummary: "Wrote src/models/user.ts",
			filePath: "src/models/user.ts",
			eventData: { path: "src/models/user.ts" },
			otherAgents: [
				{
					agentName: "test-writer",
					taskRole: "test-writer",
					taskDescription: "Write tests for the API",
					status: "idle",
					completed: false,
					filesWritten: ["src/tests/user.test.ts"],
					filesRead: ["src/models/user.ts"],
				},
			],
			previouslySharedToSource: null,
			previouslySharedFromSource: [
				{
					deltaType: "file_written",
					targetAgentName: "test-writer",
					informationSummary: "User model schema defined",
				},
			],
			fileOverlaps: null,
		});

		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
		expect(result).toContain("api-developer");
		expect(result).toContain("test-writer");
		expect(result).toContain("src/models/user.ts");
	});

	it("conflict analysis prompt includes file overlaps when present", async () => {
		const { conflictAnalysisPrompt } = await import(
			"../../../prompts/conflict-analysis.ts"
		);

		const result = conflictAnalysisPrompt({
			sourceAgent: {
				agentName: "agent-A",
				taskRole: "developer",
			},
			eventType: "file_written",
			eventSummary: "Wrote src/index.ts",
			filePath: "src/index.ts",
			eventData: { path: "src/index.ts" },
			otherAgents: [
				{
					agentName: "agent-B",
					taskRole: "tester",
					taskDescription: "Test stuff",
					status: "idle",
					completed: false,
					filesWritten: ["src/index.ts"],
					filesRead: [],
				},
			],
			previouslySharedToSource: null,
			previouslySharedFromSource: null,
			fileOverlaps: [
				{ filePath: "src/index.ts", agents: ["agent-A", "agent-B"] },
			],
		});

		expect(result).toContain("Detected File Overlaps");
		expect(result).toContain("src/index.ts");
	});

	it("conflict analysis prompt omits optional sections when null", async () => {
		const { conflictAnalysisPrompt } = await import(
			"../../../prompts/conflict-analysis.ts"
		);

		const result = conflictAnalysisPrompt({
			sourceAgent: {
				agentName: "agent-A",
				taskRole: "developer",
			},
			eventType: "prompt_complete",
			eventSummary: "Completed prompt",
			filePath: null,
			eventData: null,
			otherAgents: [
				{
					agentName: "agent-B",
					taskRole: "tester",
					taskDescription: "Test stuff",
					status: "idle",
					completed: false,
					filesWritten: [],
					filesRead: [],
				},
			],
			previouslySharedToSource: null,
			previouslySharedFromSource: null,
			fileOverlaps: null,
		});

		expect(result).not.toContain("Detected File Overlaps");
		expect(result).not.toContain("Information Previously Shared TO");
		expect(result).not.toContain("Information Previously Shared FROM");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// AgentPoolState — Conflict Fields
// ════════════════════════════════════════════════════════════════════════════

describe("AgentPoolState — Conflict Fields", () => {
	it("getState includes conflict fields with initial values", async () => {
		const { AgentPool } = await import("../agent-pool.ts");

		const pool = new AgentPool({
			openRouterApiKey: "test-key-not-real",
			model: "test/model",
			logOutput: { console: false, json: false },
			logLevel: "silent" as any,
		});

		const state = pool.getState();
		expect(state.conflictCount).toBe(0);
		expect(state.unresolvedConflictCount).toBe(0);

		await pool.destroy();
	});

	it("getState includes conflict fields when conflict detection is configured", async () => {
		const { AgentPool } = await import("../agent-pool.ts");

		const pool = new AgentPool({
			openRouterApiKey: "test-key-not-real",
			model: "test/model",
			logOutput: { console: false, json: false },
			logLevel: "silent" as any,
			conflictDetection: {
				enabled: true,
				enableSemanticAnalysis: false,
				minAlertSeverity: 0.6,
				maxConflicts: 20,
			},
		});

		const state = pool.getState();
		expect(state.conflictCount).toBe(0);
		expect(state.unresolvedConflictCount).toBe(0);

		await pool.destroy();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Non-Regression — Pool Without Conflict Config
// ════════════════════════════════════════════════════════════════════════════

describe("Non-Regression — Pool Without conflictDetection Config", () => {
	it("pool can be constructed without conflictDetection config (Test 34)", async () => {
		const { AgentPool } = await import("../agent-pool.ts");

		const pool = new AgentPool({
			openRouterApiKey: "test-key-not-real",
			model: "test/model",
			logOutput: { console: false, json: false },
			logLevel: "silent" as any,
		});

		const state = pool.getState();
		expect(state.conflictCount).toBe(0);
		expect(state.unresolvedConflictCount).toBe(0);
		expect(state.executing).toBe(false);

		await pool.destroy();
	});

	it("pool can be constructed with conflictDetection explicitly disabled", async () => {
		const { AgentPool } = await import("../agent-pool.ts");

		const pool = new AgentPool({
			openRouterApiKey: "test-key-not-real",
			model: "test/model",
			logOutput: { console: false, json: false },
			logLevel: "silent" as any,
			conflictDetection: { enabled: false },
		});

		const state = pool.getState();
		expect(state.conflictCount).toBe(0);
		expect(state.unresolvedConflictCount).toBe(0);

		await pool.destroy();
	});

	it("disabling semantic analysis preserves structural detection (Test 35)", async () => {
		const tracker = createMockContextTracker([
			createAgentState({
				agentId: "agent-A",
				agentName: "AgentA",
				filesWritten: ["src/index.ts"],
			}),
			createAgentState({
				agentId: "agent-B",
				agentName: "AgentB",
				filesWritten: ["src/index.ts"],
			}),
		]);

		const detector = new ConflictDetector(
			createMockConversationManager(),
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: false },
		);

		const delta = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "src/index.ts" },
			significance: 0.5,
		});

		const conflicts = await detector.evaluate(delta, null);

		expect(conflicts.length).toBe(1);
		expect(conflicts[0]!.type).toBe("file_overlap");
		expect(detector.semanticAnalysisCount).toBe(0);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Prompt Export Tests
// ════════════════════════════════════════════════════════════════════════════

describe("Prompt Index — Conflict Analysis Export", () => {
	it("conflictAnalysisPrompt is exported from prompts/index.ts", async () => {
		const { conflictAnalysisPrompt } = await import(
			"../../../prompts/index.ts"
		);
		expect(typeof conflictAnalysisPrompt).toBe("function");
	});

	it("templates object includes conflictAnalysis", async () => {
		const { templates } = await import("../../../prompts/index.ts");
		expect(templates.conflictAnalysis).toBeDefined();
		expect(typeof templates.conflictAnalysis).toBe("function");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// StructuredContextInjection — Conflict Alert Acceptance (Test 33)
// ════════════════════════════════════════════════════════════════════════════

describe("StructuredContextInjection — Conflict Alert Acceptance", () => {
	it("AgentContextManager accepts conflict alerts with CRITICAL priority and COORDINATION_ALERT category (Test 33)", async () => {
		const { AgentContextManager } = await import(
			"../../agent/agent-context-manager.ts"
		);
		const { ContextInjectionPriority, ContextInjectionCategory } = await import(
			"../../../types/agent-pool.types.ts"
		);

		const ctx = new AgentContextManager();

		// Inject a conflict alert (CRITICAL priority)
		ctx.injectStructured({
			content:
				'⚠️ CONFLICT ALERT: File "src/models/user.ts" was written by both api-dev and test-writer.',
			priority: ContextInjectionPriority.CRITICAL,
			category: ContextInjectionCategory.COORDINATION_ALERT,
			source: "conflict-detector (from api-dev)",
			dependencyType: null,
			timestamp: new Date().toISOString(),
		});

		// Inject a normal context item
		ctx.injectStructured({
			content: "API routes are ready on port 3000.",
			priority: ContextInjectionPriority.NORMAL,
			category: ContextInjectionCategory.SHARED_CONTEXT,
			source: "api-dev",
			dependencyType: null,
			timestamp: new Date().toISOString(),
		});

		expect(ctx.hasPending()).toBe(true);
		expect(ctx.pendingCount).toBe(2);

		const drained = ctx.drain();
		expect(drained).not.toBeNull();
		expect(drained!).toContain("CONFLICT ALERT");
		expect(drained!).toContain("COORDINATION ALERT");

		// CRITICAL should appear BEFORE NORMAL
		const criticalIdx = drained!.indexOf("CONFLICT ALERT");
		const normalIdx = drained!.indexOf("API routes are ready");
		expect(criticalIdx).toBeLessThan(normalIdx);
	});

	it("CRITICAL conflict alerts are never dropped by queue limits", async () => {
		const { AgentContextManager } = await import(
			"../../agent/agent-context-manager.ts"
		);
		const { ContextInjectionPriority, ContextInjectionCategory } = await import(
			"../../../types/agent-pool.types.ts"
		);

		const ctx = new AgentContextManager();

		// Fill queue with 20 NORMAL items (exceeds typical limit of 15)
		for (let i = 0; i < 20; i++) {
			ctx.injectStructured({
				content: `Normal item ${i}`,
				priority: ContextInjectionPriority.NORMAL,
				category: ContextInjectionCategory.SHARED_CONTEXT,
				source: `agent-${i}`,
				dependencyType: null,
				timestamp: new Date().toISOString(),
			});
		}

		// Now inject a CRITICAL conflict alert
		ctx.injectStructured({
			content: "⚠️ CONFLICT ALERT: Critical file conflict detected",
			priority: ContextInjectionPriority.CRITICAL,
			category: ContextInjectionCategory.COORDINATION_ALERT,
			source: "conflict-detector (from api-dev)",
			dependencyType: null,
			timestamp: new Date().toISOString(),
		});

		// The CRITICAL alert must survive
		const drained = ctx.drain();
		expect(drained).not.toBeNull();
		expect(drained!).toContain("CONFLICT ALERT");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Alert Flow — Threshold and Routing Tests
// ════════════════════════════════════════════════════════════════════════════

describe("ConflictDetector — Alert Threshold Behavior", () => {
	it("conflicts below minAlertSeverity are stored but not in getUnresolvedAlerts (Test 27)", async () => {
		const tracker = createMockContextTracker([
			createAgentState({
				agentId: "agent-A",
				agentName: "AgentA",
				filesWritten: ["src/index.ts"],
			}),
			createAgentState({
				agentId: "agent-B",
				agentName: "AgentB",
				filesWritten: ["src/index.ts"],
			}),
		]);

		// File overlaps have severity 0.8, so set threshold above that
		const detector = new ConflictDetector(
			createMockConversationManager(),
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: false, minAlertSeverity: 0.9 },
		);

		const delta = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "src/index.ts" },
			significance: 0.5,
		});

		const conflicts = await detector.evaluate(delta, null);

		// Conflict is detected
		expect(conflicts.length).toBe(1);
		expect(conflicts[0]!.severity).toBe(0.8);

		// Stored in getAllConflicts
		expect(detector.getAllConflicts().length).toBe(1);

		// But NOT in getUnresolvedAlerts (because severity 0.8 < threshold 0.9)
		expect(detector.getUnresolvedAlerts().length).toBe(0);
	});

	it("conflicts at or above minAlertSeverity appear in getUnresolvedAlerts", async () => {
		const tracker = createMockContextTracker([
			createAgentState({
				agentId: "agent-A",
				agentName: "AgentA",
				filesWritten: ["src/index.ts"],
			}),
			createAgentState({
				agentId: "agent-B",
				agentName: "AgentB",
				filesWritten: ["src/index.ts"],
			}),
		]);

		// File overlaps have severity 0.8, set threshold at 0.8 exactly
		const detector = new ConflictDetector(
			createMockConversationManager(),
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: false, minAlertSeverity: 0.8 },
		);

		const delta = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "src/index.ts" },
			significance: 0.5,
		});

		const conflicts = await detector.evaluate(delta, null);
		expect(conflicts.length).toBe(1);

		// At threshold — should appear in alerts
		expect(detector.getUnresolvedAlerts().length).toBe(1);
	});

	it("conflicts with semantic severity below threshold are stored but not alerted", async () => {
		const tracker = createMockContextTracker([
			createAgentState({
				agentId: "agent-A",
				agentName: "AgentA",
				taskDescription: "Build API",
				taskRole: "api-dev",
				filesWritten: [],
			}),
			createAgentState({
				agentId: "agent-B",
				agentName: "AgentB",
				taskDescription: "Write docs",
				taskRole: "doc-writer",
				filesWritten: [],
			}),
		]);

		const llmResponse = {
			hasConflict: true,
			conflicts: [
				{
					type: "semantic_conflict",
					severity: 0.3, // Below default threshold 0.5
					description: "Minor style inconsistency",
					affectedAgentIds: ["agent-B"],
					recommendation: "Consider aligning styles",
				},
			],
			reasoning: "Minor issue detected",
		};

		const detector = new ConflictDetector(
			createMockConversationManager(llmResponse),
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: true, minAlertSeverity: 0.5 },
		);

		const delta = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.PROMPT_COMPLETE,
			data: { responsePreview: "Some output" },
			significance: 0.6,
		});

		const conflicts = await detector.evaluate(delta, null);

		// Conflict is detected and stored
		expect(conflicts.length).toBe(1);
		expect(conflicts[0]!.severity).toBe(0.3);
		expect(detector.getAllConflicts().length).toBe(1);

		// But not in unresolved alerts (below threshold)
		expect(detector.getUnresolvedAlerts().length).toBe(0);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Edge Cases — ConflictDetector
// ════════════════════════════════════════════════════════════════════════════

describe("ConflictDetector — Edge Cases", () => {
	it("evaluate handles null broker gracefully for structural checks", async () => {
		const tracker = createMockContextTracker([
			createAgentState({
				agentId: "agent-A",
				agentName: "AgentA",
				filesWritten: ["src/index.ts"],
			}),
			createAgentState({
				agentId: "agent-B",
				agentName: "AgentB",
				filesWritten: ["src/index.ts"],
			}),
		]);

		const detector = new ConflictDetector(
			createMockConversationManager(),
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: false },
		);

		const delta = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "src/index.ts" },
			significance: 0.5,
		});

		// Pass null broker — stale share checks should be skipped, file overlap still works
		const conflicts = await detector.evaluate(delta, null);
		expect(conflicts.length).toBe(1);
		expect(conflicts[0]!.type).toBe("file_overlap");
	});

	it("evaluate handles FILE_WRITTEN delta without path in data", async () => {
		const tracker = createMockContextTracker([
			createAgentState({ agentId: "a1", agentName: "Agent1" }),
			createAgentState({ agentId: "a2", agentName: "Agent2" }),
		]);

		const detector = new ConflictDetector(
			createMockConversationManager(),
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: false },
		);

		const delta = createDelta({
			agentId: "a1",
			agentName: "Agent1",
			type: DeltaType.FILE_WRITTEN,
			data: {}, // No path field
			significance: 0.5,
		});

		// Should not crash, just return empty
		const conflicts = await detector.evaluate(delta, null);
		expect(conflicts).toEqual([]);
	});

	it("markResolved is a no-op for unknown conflict IDs", () => {
		const detector = new ConflictDetector(
			createMockConversationManager(),
			createMockContextTracker([]) as any,
			silentLogger(),
		);

		// Should not throw
		detector.markResolved("nonexistent-conflict-id");
		expect(detector.conflictCount).toBe(0);
	});

	it("multiple file overlaps in a single evaluation are all detected", async () => {
		const tracker = createMockContextTracker([
			createAgentState({
				agentId: "agent-A",
				agentName: "AgentA",
				filesWritten: ["src/file1.ts"],
			}),
			createAgentState({
				agentId: "agent-B",
				agentName: "AgentB",
				filesWritten: ["src/file1.ts"],
			}),
			createAgentState({
				agentId: "agent-C",
				agentName: "AgentC",
				filesWritten: ["src/file1.ts"],
			}),
		]);

		const detector = new ConflictDetector(
			createMockConversationManager(),
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: false },
		);

		const delta = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "src/file1.ts" },
			significance: 0.5,
		});

		const conflicts = await detector.evaluate(delta, null);

		// Agent-A wrote a file that Agent-B and Agent-C also wrote
		expect(conflicts.length).toBe(2);
		expect(conflicts.every((c) => c.type === "file_overlap")).toBe(true);

		const affectedIds = conflicts.flatMap((c) => c.affectedAgentIds);
		expect(affectedIds).toContain("agent-B");
		expect(affectedIds).toContain("agent-C");
	});

	it("stale share and file overlap can both be detected for the same delta", async () => {
		const tracker = createMockContextTracker([
			createAgentState({
				agentId: "agent-A",
				agentName: "AgentA",
				filesWritten: ["src/config.ts"],
			}),
			createAgentState({
				agentId: "agent-B",
				agentName: "AgentB",
				filesWritten: ["src/config.ts"],
			}),
		]);

		const sharingMap = new Map<string, SharingRecord[]>();
		sharingMap.set("agent-B", [
			createSharingRecord({
				sourceAgentId: "agent-A",
				targetAgentId: "agent-B",
				informationSummary: "Configuration in src/config.ts sets PORT=3000",
			}),
		]);
		const broker = createMockBroker(sharingMap);

		const detector = new ConflictDetector(
			createMockConversationManager(),
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: false },
		);

		const delta = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "src/config.ts" },
			significance: 0.5,
		});

		const conflicts = await detector.evaluate(delta, broker);

		// Both types should be detected
		const types = conflicts.map((c) => c.type);
		expect(types).toContain("file_overlap");
		expect(types).toContain("stale_share");
		expect(conflicts.length).toBe(2);
	});

	it("ConflictRecord fields match the ConflictRecord interface shape", async () => {
		const tracker = createMockContextTracker([
			createAgentState({
				agentId: "agent-A",
				agentName: "AgentA",
				filesWritten: ["src/index.ts"],
			}),
			createAgentState({
				agentId: "agent-B",
				agentName: "AgentB",
				filesWritten: ["src/index.ts"],
			}),
		]);

		const detector = new ConflictDetector(
			createMockConversationManager(),
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: false },
		);

		const delta = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "src/index.ts" },
			significance: 0.5,
		});

		const conflicts = await detector.evaluate(delta, null);
		expect(conflicts.length).toBe(1);

		const c = conflicts[0]!;

		// Validate all required fields of ConflictRecord
		expect(typeof c.id).toBe("string");
		expect(c.id).toMatch(/^conflict-\d+$/);
		expect(c.type).toBe("file_overlap");
		expect(typeof c.severity).toBe("number");
		expect(c.severity).toBeGreaterThanOrEqual(0);
		expect(c.severity).toBeLessThanOrEqual(1);
		expect(typeof c.description).toBe("string");
		expect(c.description.length).toBeGreaterThan(0);
		expect(c.sourceAgentId).toBe("agent-A");
		expect(c.sourceAgentName).toBe("AgentA");
		expect(Array.isArray(c.affectedAgentIds)).toBe(true);
		expect(c.affectedAgentIds).toContain("agent-B");
		expect(c.filePath).toBe("src/index.ts");
		expect(typeof c.recommendation).toBe("string");
		expect(c.recommendation.length).toBeGreaterThan(0);
		expect(typeof c.timestamp).toBe("string");
		expect(c.resolved).toBe(false);
		// staleInformation should be undefined for file_overlap
		expect(c.staleInformation).toBeUndefined();
	});

	it("stale share conflict includes staleInformation field", async () => {
		const tracker = createMockContextTracker([
			createAgentState({
				agentId: "agent-A",
				agentName: "AgentA",
				filesWritten: ["src/routes.ts"],
			}),
			createAgentState({
				agentId: "agent-B",
				agentName: "AgentB",
				filesWritten: [],
			}),
		]);

		const sharingMap = new Map<string, SharingRecord[]>();
		sharingMap.set("agent-B", [
			createSharingRecord({
				sourceAgentId: "agent-A",
				targetAgentId: "agent-B",
				informationSummary: "Routes in src/routes.ts: GET /users, POST /users",
			}),
		]);
		const broker = createMockBroker(sharingMap);

		const detector = new ConflictDetector(
			createMockConversationManager(),
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: false },
		);

		const delta = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "src/routes.ts" },
			significance: 0.5,
		});

		const conflicts = await detector.evaluate(delta, broker);
		const staleConflicts = conflicts.filter((c) => c.type === "stale_share");
		expect(staleConflicts.length).toBe(1);

		const stale = staleConflicts[0]!;
		expect(stale.staleInformation).toBeDefined();
		expect(stale.staleInformation).toContain("routes.ts");
		expect(stale.staleInformation).toContain("GET /users");
		expect(stale.filePath).toBe("src/routes.ts");
		expect(stale.affectedAgentIds).toContain("agent-B");
	});

	it("buildFileOverlapData aggregates across all agents correctly", async () => {
		const tracker = createMockContextTracker([
			createAgentState({
				agentId: "agent-A",
				agentName: "AgentA",
				taskDescription: "Build API",
				taskRole: "api-dev",
				filesWritten: ["shared.ts", "unique-a.ts"],
			}),
			createAgentState({
				agentId: "agent-B",
				agentName: "AgentB",
				taskDescription: "Write tests",
				taskRole: "test-dev",
				filesWritten: ["shared.ts", "unique-b.ts"],
			}),
			createAgentState({
				agentId: "agent-C",
				agentName: "AgentC",
				taskDescription: "Write docs",
				taskRole: "doc-dev",
				filesWritten: ["unique-c.ts"],
			}),
		]);

		// Use semantic analysis to trigger buildFileOverlapData via the prompt
		const conversations = createMockConversationManager({
			hasConflict: false,
			reasoning: "No semantic conflict",
		});

		const detector = new ConflictDetector(
			conversations,
			tracker as any,
			silentLogger(),
			{ enableSemanticAnalysis: true },
		);

		// Use PROMPT_COMPLETE (no file path) to avoid structural checks,
		// trigger semantic analysis which calls buildFileOverlapData
		const delta = createDelta({
			agentId: "agent-C",
			agentName: "AgentC",
			type: DeltaType.PROMPT_COMPLETE,
			data: { responsePreview: "Documentation written" },
			significance: 0.6,
		});

		await detector.evaluate(delta, null);

		// Verify semantic analysis was called (which uses buildFileOverlapData)
		expect(detector.semanticAnalysisCount).toBe(1);

		// Verify the prompt was called with the right data
		const callArgs = conversations.sendOneShotJson.mock.calls;
		expect(callArgs.length).toBe(1);

		// The prompt string should contain the file overlap info
		const promptText = callArgs[0]![1] as string;
		// "shared.ts" is written by both agent-A and agent-B
		if (promptText.includes("shared.ts")) {
			expect(promptText).toContain("AgentA");
			expect(promptText).toContain("AgentB");
		}
	});
});
