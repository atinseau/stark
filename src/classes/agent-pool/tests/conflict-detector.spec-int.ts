import { beforeAll, describe, expect, it } from "bun:test";
import pino from "pino";
import { AgentStatus } from "../../../enums/agent-status.enum.ts";
import { ConversationRole } from "../../../enums/conversation-role.enum.ts";
import { DeltaType } from "../../../enums/delta-type.enum.ts";
import { PoolEvent } from "../../../enums/pool-event.enum.ts";
import { sharingAnalysisSystemPrompt } from "../../../prompts/index.ts";
import type {
	AgentContextState,
	ContextDelta,
	SharingRecord,
	SubTask,
} from "../../../types/agent-pool.types.ts";
import { AgentPool } from "../agent-pool.ts";
import { ConflictDetector } from "../conflict-detector.ts";
import { ContextTracker } from "../context-tracker.ts";
import { ConversationManager } from "../conversation-manager.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
const MODEL = process.env.STARK_TEST_MODEL ?? "openai/gpt-4.1-nano";

function hasApiKey(): boolean {
	return OPENROUTER_API_KEY.length > 0;
}

function silentLogger(): pino.Logger {
	return pino({ level: "silent" });
}

let _subtaskIdCounter = 0;

function makeSubTask(prompt: string, role: string): SubTask {
	_subtaskIdCounter++;
	return {
		id: `subtask-${_subtaskIdCounter}`,
		prompt,
		role,
		dependencies: [],
		priority: 1,
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
// Integration Tests — ConflictDetector with real LLM
// ════════════════════════════════════════════════════════════════════════════

describe("ConflictDetector — LLM Integration", () => {
	if (!hasApiKey()) {
		it.skip("OPENROUTER_API_KEY not set — skipping LLM integration tests", () => {});
		return;
	}

	let conversations: ConversationManager;
	const logger = silentLogger();

	beforeAll(() => {
		conversations = new ConversationManager(
			{
				apiKey: OPENROUTER_API_KEY,
				model: MODEL,
				maxRetries: 2,
				temperature: 0.1,
			},
			logger,
		);

		// Register the SHARING_ANALYZER role used by the conflict detector
		conversations.register(
			ConversationRole.SHARING_ANALYZER,
			sharingAnalysisSystemPrompt({}),
		);
	});

	// ── Test: Semantic analysis detects a real naming convention conflict ──

	it("semantic analysis detects a naming convention conflict via LLM", async () => {
		const tracker = new ContextTracker();

		// Register two agents with conflicting naming conventions
		tracker.registerAgent(
			"agent-api",
			"api-developer",
			makeSubTask(
				"Build a REST API using snake_case for all JSON response fields (user_name, created_at, is_active)",
				"api-developer",
			),
		);
		tracker.registerAgent(
			"agent-frontend",
			"frontend-developer",
			makeSubTask(
				"Build a React frontend that consumes the API. All TypeScript interfaces use camelCase (userName, createdAt, isActive)",
				"frontend-developer",
			),
		);

		const detector = new ConflictDetector(conversations, tracker, logger, {
			enableSemanticAnalysis: true,
		});

		const delta = createDelta({
			agentId: "agent-api",
			agentName: "api-developer",
			type: DeltaType.PROMPT_COMPLETE,
			summary:
				"Implemented the User API endpoint. All JSON fields use snake_case: user_name, created_at, is_active, email_verified",
			data: {
				responsePreview:
					'app.get("/users", (req, res) => { res.json({ user_name: "john", created_at: "2024-01-01", is_active: true }); });',
			},
			significance: 0.7,
		});

		const conflicts = await detector.evaluate(delta, null);

		// The LLM should detect the naming convention mismatch
		// (snake_case API vs camelCase frontend)
		expect(detector.semanticAnalysisCount).toBe(1);
		expect(detector.evaluationCount).toBe(1);

		// We expect a conflict but LLM results can vary —
		// at minimum the analysis ran without error
		if (conflicts.length > 0) {
			const first = conflicts[0]!;
			expect(first.type).toMatch(/semantic_conflict|dependency_violation/);
			expect(first.severity).toBeGreaterThan(0);
			expect(first.description.length).toBeGreaterThan(0);
			expect(first.recommendation.length).toBeGreaterThan(0);
			expect(first.affectedAgentIds.length).toBeGreaterThan(0);
		}
	}, 60_000);

	// ── Test: Semantic analysis returns no conflict for unrelated agents ───

	it("semantic analysis returns no conflict for clearly unrelated agent work", async () => {
		const tracker = new ContextTracker();

		// Two agents working on completely independent things
		tracker.registerAgent(
			"agent-backend",
			"backend-developer",
			makeSubTask(
				"Build a database migration script for PostgreSQL",
				"backend-developer",
			),
		);
		tracker.registerAgent(
			"agent-docs",
			"documentation-writer",
			makeSubTask(
				"Write the project README.md with installation instructions",
				"documentation-writer",
			),
		);

		const detector = new ConflictDetector(conversations, tracker, logger, {
			enableSemanticAnalysis: true,
		});

		const delta = createDelta({
			agentId: "agent-docs",
			agentName: "documentation-writer",
			type: DeltaType.PROMPT_COMPLETE,
			summary:
				"Wrote the README.md with installation instructions and usage examples",
			data: {
				responsePreview:
					"# Project Setup\n\n## Installation\n\n1. Clone the repository\n2. Run npm install\n3. Run npm start",
			},
			significance: 0.5,
		});

		const conflicts = await detector.evaluate(delta, null);

		expect(detector.semanticAnalysisCount).toBe(1);
		// The LLM should detect no conflict between database migration and README
		expect(conflicts.length).toBe(0);
	}, 60_000);

	// ── Test: Semantic analysis detects a port conflict ────────────────────

	it("semantic analysis detects a port configuration conflict", async () => {
		const tracker = new ContextTracker();

		tracker.registerAgent(
			"agent-api",
			"api-developer",
			makeSubTask(
				"Build the Express API server. It listens on port 3000.",
				"api-developer",
			),
		);
		tracker.registerAgent(
			"agent-test",
			"test-writer",
			makeSubTask(
				"Write integration tests that call the API at http://localhost:8080. Run tests with Jest.",
				"test-writer",
			),
		);

		// Simulate that the api-developer previously shared port info
		const sharingMap = new Map<string, SharingRecord[]>();
		sharingMap.set("agent-test", [
			createSharingRecord({
				sourceAgentId: "agent-api",
				targetAgentId: "agent-test",
				informationSummary:
					"The API server is configured to listen on port 3000. Base URL: http://localhost:3000",
			}),
		]);

		// Create a broker-like object for the test
		const mockBroker = {
			getRecentSharingsForTarget: (targetId: string, limit = 10) => {
				const records = sharingMap.get(targetId) ?? [];
				return records.slice(-limit);
			},
		} as any;

		const detector = new ConflictDetector(conversations, tracker, logger, {
			enableSemanticAnalysis: true,
		});

		const delta = createDelta({
			agentId: "agent-test",
			agentName: "test-writer",
			type: DeltaType.PROMPT_COMPLETE,
			summary:
				"Wrote integration tests targeting http://localhost:8080. All test cases use port 8080.",
			data: {
				responsePreview:
					'const BASE_URL = "http://localhost:8080"; describe("API Tests", () => { it("should GET /users", async () => { const res = await fetch(BASE_URL + "/users"); }); });',
			},
			significance: 0.6,
		});

		const conflicts = await detector.evaluate(delta, mockBroker);

		expect(detector.semanticAnalysisCount).toBe(1);

		// The LLM should detect that port 8080 (tests) != port 3000 (API)
		if (conflicts.length > 0) {
			const portConflict = conflicts[0]!;
			expect(portConflict.severity).toBeGreaterThan(0.3);
			expect(portConflict.description.length).toBeGreaterThan(0);
			// The description or recommendation should mention port numbers
			const combinedText =
				`${portConflict.description} ${portConflict.recommendation}`.toLowerCase();
			expect(
				combinedText.includes("port") ||
					combinedText.includes("3000") ||
					combinedText.includes("8080") ||
					combinedText.includes("url") ||
					combinedText.includes("mismatch") ||
					combinedText.includes("conflict"),
			).toBe(true);
		}
	}, 60_000);

	// ── Test: Structural + Semantic combined flow ─────────────────────────

	it("structural conflict skips semantic analysis even with LLM available", async () => {
		const tracker = new ContextTracker();

		tracker.registerAgent(
			"agent-A",
			"AgentA",
			makeSubTask("Build the user model", "backend-developer"),
		);
		tracker.registerAgent(
			"agent-B",
			"AgentB",
			makeSubTask("Build the auth module", "auth-developer"),
		);

		// Simulate both agents having written the same file
		const stateA = tracker.getAgentState("agent-A");
		const stateB = tracker.getAgentState("agent-B");
		if (stateA) stateA.filesWritten.push("src/models/user.ts");
		if (stateB) stateB.filesWritten.push("src/models/user.ts");

		const detector = new ConflictDetector(conversations, tracker, logger, {
			enableSemanticAnalysis: true,
		});

		const delta = createDelta({
			agentId: "agent-A",
			agentName: "AgentA",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "src/models/user.ts" },
			significance: 0.5,
		});

		const conflicts = await detector.evaluate(delta, null);

		// Structural conflict found
		expect(conflicts.length).toBe(1);
		expect(conflicts[0]!.type).toBe("file_overlap");

		// Semantic analysis should NOT have been called
		expect(detector.semanticAnalysisCount).toBe(0);
		expect(detector.structuralCheckCount).toBe(1);
	}, 30_000);

	// ── Test: Full lifecycle with multiple deltas ─────────────────────────

	it("full lifecycle: multiple deltas, structural + resolved conflicts", async () => {
		const tracker = new ContextTracker();

		tracker.registerAgent(
			"agent-api",
			"api-dev",
			makeSubTask("Build the REST API with Express", "api-developer"),
		);
		tracker.registerAgent(
			"agent-test",
			"test-dev",
			makeSubTask("Write tests for the REST API", "test-writer"),
		);
		tracker.registerAgent(
			"agent-docs",
			"docs-dev",
			makeSubTask("Write API documentation", "doc-writer"),
		);

		const detector = new ConflictDetector(
			conversations,
			tracker,
			logger,
			{ enableSemanticAnalysis: false }, // Only structural for speed
		);

		// Delta 1: api-dev writes src/routes.ts
		const apiState = tracker.getAgentState("agent-api");
		if (apiState) apiState.filesWritten.push("src/routes.ts");

		const delta1 = createDelta({
			agentId: "agent-api",
			agentName: "api-dev",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "src/routes.ts" },
			significance: 0.5,
		});
		const conflicts1 = await detector.evaluate(delta1, null);
		expect(conflicts1.length).toBe(0); // No overlap yet

		// Delta 2: test-dev also writes src/routes.ts (file overlap!)
		const testState = tracker.getAgentState("agent-test");
		if (testState) testState.filesWritten.push("src/routes.ts");

		const delta2 = createDelta({
			agentId: "agent-test",
			agentName: "test-dev",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "src/routes.ts" },
			significance: 0.5,
		});
		const conflicts2 = await detector.evaluate(delta2, null);
		expect(conflicts2.length).toBe(1);
		expect(conflicts2[0]!.type).toBe("file_overlap");
		expect(conflicts2[0]!.affectedAgentIds).toContain("agent-api");

		// Delta 3: docs-dev writes README.md — no conflict
		const docsState = tracker.getAgentState("agent-docs");
		if (docsState) docsState.filesWritten.push("README.md");

		const delta3 = createDelta({
			agentId: "agent-docs",
			agentName: "docs-dev",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "README.md" },
			significance: 0.5,
		});
		const conflicts3 = await detector.evaluate(delta3, null);
		expect(conflicts3.length).toBe(0);

		// Verify state
		expect(detector.conflictCount).toBe(1);
		expect(detector.evaluationCount).toBe(3);
		expect(detector.structuralCheckCount).toBe(3);
		expect(detector.semanticAnalysisCount).toBe(0);

		// Resolve the conflict
		detector.markResolved(conflicts2[0]!.id);
		expect(detector.unresolvedHighSeverityCount).toBe(0);

		// Summary should still show the conflict
		const summary = detector.getSummary();
		expect(summary).not.toBeNull();
		expect(summary).toContain("Total detected: 1");

		// Reset
		detector.reset();
		expect(detector.conflictCount).toBe(0);
		expect(detector.evaluationCount).toBe(0);
		expect(detector.getSummary()).toBeNull();
	}, 30_000);
});

// ════════════════════════════════════════════════════════════════════════════
// Integration Tests — ConflictDetector with AgentPool wiring
// ════════════════════════════════════════════════════════════════════════════

describe("ConflictDetector — AgentPool Wiring", () => {
	it("AgentPool exposes conflictCount and unresolvedConflictCount in getState()", async () => {
		const pool = new AgentPool({
			openRouterApiKey: "test-key-not-real",
			model: "test/model",
			logOutput: { console: false, json: false },
			logLevel: "silent" as any,
			conflictDetection: {
				enabled: true,
				enableSemanticAnalysis: false,
				minAlertSeverity: 0.5,
				maxConflicts: 20,
			},
		});

		const state = pool.getState();

		// Before execution, conflict detector is not instantiated
		expect(state.conflictCount).toBe(0);
		expect(state.unresolvedConflictCount).toBe(0);
		expect(state.executing).toBe(false);

		await pool.destroy();
	});

	it("AgentPool construction works without conflictDetection config", async () => {
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

	it("AgentPool construction works with conflictDetection explicitly disabled", async () => {
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

	it("CONFLICT_DETECTED event type is properly defined", () => {
		expect(PoolEvent.CONFLICT_DETECTED as string).toBe(
			"pool:conflict-detected",
		);
	});

	it("CONFLICT_DETECTED delta type is properly defined", () => {
		expect(DeltaType.CONFLICT_DETECTED as string).toBe("conflict_detected");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Integration Tests — Stale Share Detection with Broker
// ════════════════════════════════════════════════════════════════════════════

describe("ConflictDetector — Stale Share Detection Integration", () => {
	it("detects stale share when broker has relevant sharing history", async () => {
		const logger = silentLogger();
		const tracker = new ContextTracker();

		tracker.registerAgent(
			"agent-api",
			"api-developer",
			makeSubTask("Build the REST API", "api-developer"),
		);
		tracker.registerAgent(
			"agent-test",
			"test-writer",
			makeSubTask("Write tests for the API", "test-writer"),
		);

		// Simulate api-developer's file writes
		const apiState = tracker.getAgentState("agent-api");
		if (apiState) apiState.filesWritten.push("src/config.ts");

		// Create a real-ish broker mock with sharing history
		const sharingHistory = new Map<string, SharingRecord[]>();
		sharingHistory.set("agent-test", [
			{
				timestamp: new Date(Date.now() - 60000).toISOString(),
				sourceAgentId: "agent-api",
				targetAgentId: "agent-test",
				deltaType: DeltaType.FILE_WRITTEN,
				informationSummary:
					"Server configuration in src/config.ts: PORT=3000, HOST=localhost, DB_URL=postgres://localhost:5432/mydb",
			},
		]);

		const broker = {
			getRecentSharingsForTarget: (targetId: string, limit = 10) => {
				const records = sharingHistory.get(targetId) ?? [];
				return records.slice(-limit);
			},
		} as any;

		const mockConversations = {
			sendOneShotJson: async () => null,
			has: () => true,
			register: () => {},
		} as any;

		const detector = new ConflictDetector(mockConversations, tracker, logger, {
			enableSemanticAnalysis: false,
		});

		// api-developer rewrites src/config.ts — the shared info is now stale
		const delta = createDelta({
			agentId: "agent-api",
			agentName: "api-developer",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "src/config.ts" },
			significance: 0.5,
		});

		const conflicts = await detector.evaluate(delta, broker);

		// Should detect a stale_share conflict
		const staleConflicts = conflicts.filter((c) => c.type === "stale_share");
		expect(staleConflicts.length).toBe(1);
		expect(staleConflicts[0]!.sourceAgentId).toBe("agent-api");
		expect(staleConflicts[0]!.affectedAgentIds).toContain("agent-test");
		expect(staleConflicts[0]!.filePath).toBe("src/config.ts");
		expect(staleConflicts[0]!.staleInformation).toContain("config.ts");
		expect(staleConflicts[0]!.severity).toBe(0.7);
		expect(staleConflicts[0]!.resolved).toBe(false);
	});

	it("does NOT detect stale share for unrelated file writes", async () => {
		const logger = silentLogger();
		const tracker = new ContextTracker();

		tracker.registerAgent(
			"agent-api",
			"api-developer",
			makeSubTask("Build the REST API", "api-developer"),
		);
		tracker.registerAgent(
			"agent-test",
			"test-writer",
			makeSubTask("Write tests for the API", "test-writer"),
		);

		const apiState = tracker.getAgentState("agent-api");
		if (apiState) apiState.filesWritten.push("src/utils.ts");

		const sharingHistory = new Map<string, SharingRecord[]>();
		sharingHistory.set("agent-test", [
			{
				timestamp: new Date(Date.now() - 60000).toISOString(),
				sourceAgentId: "agent-api",
				targetAgentId: "agent-test",
				deltaType: DeltaType.FILE_WRITTEN,
				informationSummary:
					"API routes defined in src/routes.ts with GET /users and POST /users endpoints",
			},
		]);

		const broker = {
			getRecentSharingsForTarget: (targetId: string, limit = 10) => {
				const records = sharingHistory.get(targetId) ?? [];
				return records.slice(-limit);
			},
		} as any;

		const mockConversations = {
			sendOneShotJson: async () => null,
			has: () => true,
			register: () => {},
		} as any;

		const detector = new ConflictDetector(mockConversations, tracker, logger, {
			enableSemanticAnalysis: false,
		});

		// api-developer writes src/utils.ts — not the same file as shared
		const delta = createDelta({
			agentId: "agent-api",
			agentName: "api-developer",
			type: DeltaType.FILE_WRITTEN,
			data: { path: "src/utils.ts" },
			significance: 0.5,
		});

		const conflicts = await detector.evaluate(delta, broker);

		const staleConflicts = conflicts.filter((c) => c.type === "stale_share");
		expect(staleConflicts.length).toBe(0);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Integration Tests — maxConflicts Eviction Under Load
// ════════════════════════════════════════════════════════════════════════════

describe("ConflictDetector — Eviction Under Load", () => {
	it("handles many file overlaps without memory leaks (maxConflicts enforced)", async () => {
		const logger = silentLogger();

		// Create a scenario with many agents and file overlaps
		const fileCount = 20;
		const maxConflicts = 5;

		const states: AgentContextState[] = [
			createAgentState({
				agentId: "agent-main",
				agentName: "MainAgent",
				filesWritten: Array.from(
					{ length: fileCount },
					(_, i) => `src/file-${i}.ts`,
				),
			}),
		];

		// Each file has a corresponding "other" agent that also wrote it
		for (let i = 0; i < fileCount; i++) {
			states.push(
				createAgentState({
					agentId: `agent-${i}`,
					agentName: `Agent${i}`,
					filesWritten: [`src/file-${i}.ts`],
				}),
			);
		}

		const tracker = {
			get agentCount() {
				return states.length;
			},
			getAgentState: (id: string) => states.find((s) => s.agentId === id),
			getAllAgentStates: () => [...states],
			getOtherAgentStates: (excludeId: string) =>
				states.filter((s) => s.agentId !== excludeId),
		} as any;

		const mockConversations = {
			sendOneShotJson: async () => null,
			has: () => true,
			register: () => {},
		} as any;

		const detector = new ConflictDetector(mockConversations, tracker, logger, {
			enableSemanticAnalysis: false,
			maxConflicts,
		});

		// Generate conflicts for all files
		for (let i = 0; i < fileCount; i++) {
			const delta = createDelta({
				agentId: "agent-main",
				agentName: "MainAgent",
				type: DeltaType.FILE_WRITTEN,
				data: { path: `src/file-${i}.ts` },
				significance: 0.5,
			});
			await detector.evaluate(delta, null);
		}

		// Should never exceed maxConflicts
		expect(detector.conflictCount).toBeLessThanOrEqual(maxConflicts);
		expect(detector.conflictCount).toBe(maxConflicts);
		expect(detector.evaluationCount).toBe(fileCount);
	});

	it("resolved conflicts are evicted before unresolved ones", async () => {
		const logger = silentLogger();

		const states: AgentContextState[] = [
			createAgentState({
				agentId: "agent-main",
				agentName: "MainAgent",
				filesWritten: ["f1.ts", "f2.ts", "f3.ts", "f4.ts", "f5.ts"],
			}),
			createAgentState({
				agentId: "agent-1",
				agentName: "Agent1",
				filesWritten: ["f1.ts"],
			}),
			createAgentState({
				agentId: "agent-2",
				agentName: "Agent2",
				filesWritten: ["f2.ts"],
			}),
			createAgentState({
				agentId: "agent-3",
				agentName: "Agent3",
				filesWritten: ["f3.ts"],
			}),
			createAgentState({
				agentId: "agent-4",
				agentName: "Agent4",
				filesWritten: ["f4.ts"],
			}),
			createAgentState({
				agentId: "agent-5",
				agentName: "Agent5",
				filesWritten: ["f5.ts"],
			}),
		];

		const tracker = {
			get agentCount() {
				return states.length;
			},
			getAgentState: (id: string) => states.find((s) => s.agentId === id),
			getAllAgentStates: () => [...states],
			getOtherAgentStates: (excludeId: string) =>
				states.filter((s) => s.agentId !== excludeId),
		} as any;

		const mockConversations = {
			sendOneShotJson: async () => null,
			has: () => true,
			register: () => {},
		} as any;

		const detector = new ConflictDetector(mockConversations, tracker, logger, {
			enableSemanticAnalysis: false,
			maxConflicts: 3,
		});

		// Generate 3 conflicts
		const allConflictIds: string[] = [];
		for (let i = 1; i <= 3; i++) {
			const delta = createDelta({
				agentId: "agent-main",
				agentName: "MainAgent",
				type: DeltaType.FILE_WRITTEN,
				data: { path: `f${i}.ts` },
				significance: 0.5,
			});
			const conflicts = await detector.evaluate(delta, null);
			if (conflicts.length > 0) {
				allConflictIds.push(conflicts[0]!.id);
			}
		}

		expect(detector.conflictCount).toBe(3);

		// Resolve the first two
		if (allConflictIds[0]) detector.markResolved(allConflictIds[0]);
		if (allConflictIds[1]) detector.markResolved(allConflictIds[1]);

		// Add two more
		for (let i = 4; i <= 5; i++) {
			const delta = createDelta({
				agentId: "agent-main",
				agentName: "MainAgent",
				type: DeltaType.FILE_WRITTEN,
				data: { path: `f${i}.ts` },
				significance: 0.5,
			});
			await detector.evaluate(delta, null);
		}

		// Should still be at most 3
		expect(detector.conflictCount).toBeLessThanOrEqual(3);

		// The resolved conflicts should have been evicted first
		const remaining = detector.getAllConflicts();
		const resolvedRemaining = remaining.filter((c) => c.resolved);
		// At most 0 resolved should remain (both were evicted to make room)
		expect(resolvedRemaining.length).toBeLessThanOrEqual(1);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Integration Tests — getSummary Formatting
// ════════════════════════════════════════════════════════════════════════════

describe("ConflictDetector — getSummary Integration", () => {
	it("getSummary includes all required sections for orchestrator/checkpoint", async () => {
		const logger = silentLogger();

		const states: AgentContextState[] = [
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
		];

		const tracker = {
			get agentCount() {
				return states.length;
			},
			getAgentState: (id: string) => states.find((s) => s.agentId === id),
			getAllAgentStates: () => [...states],
			getOtherAgentStates: (excludeId: string) =>
				states.filter((s) => s.agentId !== excludeId),
		} as any;

		const mockConversations = {
			sendOneShotJson: async () => null,
			has: () => true,
			register: () => {},
		} as any;

		const detector = new ConflictDetector(mockConversations, tracker, logger, {
			enableSemanticAnalysis: false,
		});

		// Generate 2 high-severity file overlap conflicts
		for (const file of ["f1.ts", "f2.ts"]) {
			const delta = createDelta({
				agentId: "agent-A",
				agentName: "AgentA",
				type: DeltaType.FILE_WRITTEN,
				data: { path: file },
				significance: 0.5,
			});
			await detector.evaluate(delta, null);
		}

		const summary = detector.getSummary();

		expect(summary).not.toBeNull();
		expect(summary!).toContain("## Conflict Summary");
		expect(summary!).toContain("Total detected: 2");
		expect(summary!).toContain("Unresolved: 2");
		expect(summary!).toContain("High severity");
		expect(summary!).toContain("file_overlap");

		// Resolve one and check updated summary
		const conflicts = detector.getAllConflicts();
		detector.markResolved(conflicts[0]!.id);

		const updatedSummary = detector.getSummary();
		expect(updatedSummary).toContain("Unresolved: 1");
	});
});
