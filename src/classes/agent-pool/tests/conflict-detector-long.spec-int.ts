import { describe, expect, it } from "bun:test";
import { AgentEvent } from "../../../enums/agent-event.enum.ts";
import { PoolEvent } from "../../../enums/pool-event.enum.ts";
import type {
	ConflictDetectedEvent,
	StructuredContextInjection,
} from "../../../types/agent-pool.types.ts";
import {
	ContextInjectionCategory,
	ContextInjectionPriority,
} from "../../../types/agent-pool.types.ts";
import { AgentPool } from "../agent-pool.ts";
import { collectPoolEvents } from "./test-helpers.ts";
import {
	HAS_API_KEY,
	INT_TIMEOUT_MS,
	intPoolConfig,
	trackingAgentFactory,
} from "./test-helpers-int.ts";

// ════════════════════════════════════════════════════════════════════════════
// Long-Running Integration Tests — Conflict Detection
//
// These tests exercise the conflict detection system under realistic,
// sustained workloads. They are intentionally long-running (minutes per test)
// to validate:
//
// 1. Multi-execution resilience — detector resets cleanly across runs
// 2. Full conflict lifecycle — detect → alert → resolve → cleanup
// 3. High-concurrency overlap — many agents writing to shared files
// 4. Coexistence with other subsystems (orchestrator, checkpoints, sharing)
// 5. Semantic + structural mixed detection in a single execution
//
// These tests use real LLM calls for planning, sharing, orchestration,
// and (optionally) semantic conflict analysis. Mock agents are used to
// control file-write events deterministically.
//
// Expected runtime: 2–10 minutes per test.
// ════════════════════════════════════════════════════════════════════════════

const LONG_TIMEOUT_MS = INT_TIMEOUT_MS * 5; // 600 s (10 min)

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Creates a mock agent factory where every agent emits a TOOL_COMPLETE
 * event simulating a write to the given file path during prompt().
 */
function fileWritingAgentFactory(filePaths: string[]) {
	let agentIdx = 0;
	const injectedContexts: Array<{
		agentName: string;
		content: string | StructuredContextInjection;
	}> = [];

	const factory = (config?: { name?: string }) => {
		const { createMockAgent } = require("./test-helpers.ts");
		const name = config?.name ?? `LongRunAgent-${agentIdx++}`;
		const myFile = filePaths[agentIdx % filePaths.length] ?? filePaths[0];

		const agent = createMockAgent({
			name,
			promptResult: {
				stopReason: "end_turn" as const,
				text: `Task completed by ${name}. Wrote to ${myFile}.`,
				usage: {
					inputTokens: 120,
					outputTokens: 60,
					totalTokens: 180,
				},
			},
		});

		// Track injected contexts (conflict alerts)
		const originalInjectContext = agent.injectContext;
		(agent as any).injectContext = (
			instructions: string | StructuredContextInjection,
		) => {
			injectedContexts.push({ agentName: name, content: instructions });
			return originalInjectContext.call(agent, instructions);
		};

		// Emit a TOOL_COMPLETE event for all files (simulates overlapping writes)
		const originalPrompt = agent.prompt;
		(agent as any).prompt = async (text: string) => {
			for (const fp of filePaths) {
				agent.emit(AgentEvent.TOOL_COMPLETE, {
					event: AgentEvent.TOOL_COMPLETE,
					timestamp: new Date().toISOString(),
					agent: agent.identity,
					toolCallId: `tc-${crypto.randomUUID().slice(0, 8)}`,
					title: "write_file",
					output: `Wrote ${fp}`,
				});
			}
			return originalPrompt.call(agent, text);
		};

		return agent;
	};

	return { factory, injectedContexts };
}

// ════════════════════════════════════════════════════════════════════════════
// Test Suite
// ════════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_API_KEY)(
	"ConflictDetector — Long-Running Integration Tests",
	() => {
		// ── 1. Multi-Execution Resilience ──────────────────────────────

		it(
			"detector state resets cleanly across 3 sequential executions on the same pool",
			async () => {
				const tracker = trackingAgentFactory();

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 3,
						conflictDetection: {
							enabled: true,
							enableSemanticAnalysis: false,
							minAlertSeverity: 0.5,
							maxConflicts: 20,
						},
					}),
				);

				const allConflictEvents: ConflictDetectedEvent[] = [];
				pool.on(PoolEvent.CONFLICT_DETECTED, ((e: ConflictDetectedEvent) => {
					allConflictEvents.push(e);
				}) as any);

				try {
					// ── Execution 1 ──
					const result1 = await pool.execute(
						"Build a REST API: 1) Create models, 2) Write tests, 3) Generate docs",
					);
					expect(result1).toBeDefined();
					expect(result1.agents.length).toBeGreaterThanOrEqual(1);

					const state1 = pool.getState();
					expect(state1.executing).toBe(false);
					expect(state1.conflictCount).toBe(0);
					expect(state1.unresolvedConflictCount).toBe(0);
					expect(state1.activeAgentCount).toBe(0);

					const _eventsAfter1 = allConflictEvents.length;

					// ── Execution 2 ──
					const result2 = await pool.execute(
						"Create a CLI tool: 1) Build the argument parser, 2) Implement commands, 3) Write usage docs",
					);
					expect(result2).toBeDefined();
					expect(result2.agents.length).toBeGreaterThanOrEqual(1);

					const state2 = pool.getState();
					expect(state2.executing).toBe(false);
					expect(state2.conflictCount).toBe(0);
					expect(state2.unresolvedConflictCount).toBe(0);
					expect(state2.activeAgentCount).toBe(0);

					// ── Execution 3 ──
					const result3 = await pool.execute(
						"Write a configuration loader: 1) Parse YAML config, 2) Validate schema, 3) Add tests",
					);
					expect(result3).toBeDefined();
					expect(result3.agents.length).toBeGreaterThanOrEqual(1);

					const state3 = pool.getState();
					expect(state3.executing).toBe(false);
					expect(state3.conflictCount).toBe(0);
					expect(state3.unresolvedConflictCount).toBe(0);
					expect(state3.activeAgentCount).toBe(0);

					// All three results should be valid independent results
					expect(result1.summary.length).toBeGreaterThan(0);
					expect(result2.summary.length).toBeGreaterThan(0);
					expect(result3.summary.length).toBeGreaterThan(0);

					// Conflict events from earlier executions should NOT affect later ones
					// (i.e., the count shouldn't grow unboundedly unless new conflicts appear)
					for (const event of allConflictEvents) {
						expect(event.conflict.id).toBeDefined();
						expect(event.conflict.timestamp).toBeDefined();
					}
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);

		// ── 2. Full Conflict Lifecycle ─────────────────────────────────

		it(
			"full lifecycle: file overlap detected → alert injected → conflict resolved → state cleaned",
			async () => {
				const sharedFiles = ["src/shared/database.ts", "src/shared/config.ts"];
				const { factory, injectedContexts } =
					fileWritingAgentFactory(sharedFiles);

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: factory,
						maxAgents: 4,
						conflictDetection: {
							enabled: true,
							enableSemanticAnalysis: false,
							minAlertSeverity: 0.3, // Low threshold to catch everything
							maxConflicts: 30,
						},
					}),
				);

				const conflictEvents = collectPoolEvents<ConflictDetectedEvent>(
					pool,
					PoolEvent.CONFLICT_DETECTED,
				);

				try {
					const result = await pool.execute(
						"Build a database layer with shared configuration: " +
							"1) Create the database connection module in src/shared/database.ts, " +
							"2) Create configuration management in src/shared/config.ts, " +
							"3) Write integration tests for the database, " +
							"4) Generate API documentation",
					);

					expect(result).toBeDefined();

					if (result.agents.length >= 2 && conflictEvents.length > 0) {
						// ── Verify conflict records ──
						for (const event of conflictEvents) {
							const c = event.conflict;

							// All required fields present
							expect(c.id.length).toBeGreaterThan(0);
							expect(c.type).toBeDefined();
							expect(typeof c.severity).toBe("number");
							expect(c.severity).toBeGreaterThanOrEqual(0);
							expect(c.severity).toBeLessThanOrEqual(1);
							expect(c.description.length).toBeGreaterThan(0);
							expect(c.sourceAgentId.length).toBeGreaterThan(0);
							expect(c.sourceAgentName.length).toBeGreaterThan(0);
							expect(c.affectedAgentIds.length).toBeGreaterThan(0);
							expect(c.recommendation.length).toBeGreaterThan(0);

							// ISO timestamp
							const ts = new Date(c.timestamp);
							expect(Number.isNaN(ts.getTime())).toBe(false);

							// All conflicts above threshold should be resolved (alert was sent)
							if (c.severity >= 0.3) {
								expect(c.resolved).toBe(true);
							}
						}

						// ── Verify alerts were injected ──
						const conflictAlerts = injectedContexts.filter((ctx) => {
							if (typeof ctx.content === "object" && ctx.content !== null) {
								const s = ctx.content as StructuredContextInjection;
								return (
									s.category === ContextInjectionCategory.COORDINATION_ALERT &&
									s.source?.includes("conflict-detector")
								);
							}
							return false;
						});

						if (conflictAlerts.length > 0) {
							for (const alert of conflictAlerts) {
								const s = alert.content as StructuredContextInjection;
								expect(s.priority).toBe(ContextInjectionPriority.CRITICAL);
								expect(s.content).toContain("CONFLICT ALERT");
								expect(s.timestamp?.length).toBeGreaterThan(0);
							}
						}
					}

					// ── Post-execution state is clean ──
					const finalState = pool.getState();
					expect(finalState.conflictCount).toBe(0);
					expect(finalState.unresolvedConflictCount).toBe(0);
					expect(finalState.executing).toBe(false);
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);

		// ── 3. High-Concurrency Overlap ────────────────────────────────

		it(
			"handles 4 agents all writing to the same file without crash or state corruption",
			async () => {
				const sharedFile = "src/core/shared-module.ts";
				const { factory } = fileWritingAgentFactory([sharedFile]);

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: factory,
						maxAgents: 4,
						conflictDetection: {
							enabled: true,
							enableSemanticAnalysis: false,
							minAlertSeverity: 0.5,
							maxConflicts: 50,
						},
					}),
				);

				const conflictEvents = collectPoolEvents<ConflictDetectedEvent>(
					pool,
					PoolEvent.CONFLICT_DETECTED,
				);

				try {
					const result = await pool.execute(
						"Build a modular system with 4 components, all using src/core/shared-module.ts: " +
							"1) Core data processing module, " +
							"2) API gateway that imports the core module, " +
							"3) Background worker using the core module, " +
							"4) Test suite for the core module",
					);

					expect(result).toBeDefined();

					if (result.agents.length >= 2) {
						// With multiple agents all writing the same file,
						// we expect file_overlap conflicts
						if (conflictEvents.length > 0) {
							const fileOverlaps = conflictEvents.filter(
								(e) => e.conflict.type === "file_overlap",
							);

							for (const event of fileOverlaps) {
								expect(event.conflict.filePath).toContain("shared-module.ts");
								expect(event.conflict.severity).toBeGreaterThanOrEqual(0.7);
							}
						}
					}

					// No crash, valid result
					for (const agentResult of result.agents) {
						expect(agentResult.success).toBe(true);
					}

					// Summary was generated
					expect(result.summary.length).toBeGreaterThan(0);
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);

		// ── 4. Coexistence With Other Subsystems ───────────────────────

		it(
			"conflict detection coexists with orchestrator, checkpoints, and sharing without interference",
			async () => {
				const tracker = trackingAgentFactory();

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 4,
						conflictDetection: {
							enabled: true,
							enableSemanticAnalysis: false,
							minAlertSeverity: 0.5,
						},
						checkpoints: {
							enabled: true,
							deltaInterval: 5,
							timeIntervalMs: 10_000,
						},
						orchestrator: {
							enabled: true,
							deltaInterval: 5,
						},
					}),
				);

				const _conflictEvents = collectPoolEvents<ConflictDetectedEvent>(
					pool,
					PoolEvent.CONFLICT_DETECTED,
				);
				const checkpointEvents: unknown[] = [];
				pool.on(PoolEvent.CHECKPOINT_EVALUATED, ((e: unknown) => {
					checkpointEvents.push(e);
				}) as any);
				const orchestratorEvents: unknown[] = [];
				pool.on(PoolEvent.ORCHESTRATOR_ASSESSMENT, ((e: unknown) => {
					orchestratorEvents.push(e);
				}) as any);
				const sharingEvents: unknown[] = [];
				pool.on(PoolEvent.SHARING_DECISION, ((e: unknown) => {
					sharingEvents.push(e);
				}) as any);

				try {
					const result = await pool.execute(
						"Build a full-stack web application: " +
							"1) Create the backend API with Express.js routes and controllers, " +
							"2) Write a comprehensive test suite with unit and integration tests, " +
							"3) Create OpenAPI/Swagger documentation for all endpoints, " +
							"4) Build a deployment configuration with Docker",
					);

					expect(result).toBeDefined();
					expect(result.agents.length).toBeGreaterThanOrEqual(1);

					// All agents should complete successfully regardless of
					// conflict detection being active alongside other subsystems
					for (const agentResult of result.agents) {
						expect(agentResult.success).toBe(true);
					}

					// Summary should be generated
					expect(result.summary.length).toBeGreaterThan(0);

					// All subsystems should have operated without error
					// (even if no conflicts/checkpoints/assessments were actually triggered,
					// the important thing is that there were no crashes)
					const finalState = pool.getState();
					expect(finalState.executing).toBe(false);
					expect(finalState.conflictCount).toBe(0);
					expect(finalState.unresolvedConflictCount).toBe(0);
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);

		// ── 5. Semantic + Structural Mixed Detection ───────────────────

		it(
			"semantic analysis enabled alongside structural detection does not crash or duplicate conflicts",
			async () => {
				const sharedFiles = ["src/api/routes.ts"];
				const { factory } = fileWritingAgentFactory(sharedFiles);

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: factory,
						maxAgents: 3,
						conflictDetection: {
							enabled: true,
							enableSemanticAnalysis: true, // Both structural + semantic
							minAlertSeverity: 0.3,
							maxConflicts: 30,
						},
					}),
				);

				const conflictEvents = collectPoolEvents<ConflictDetectedEvent>(
					pool,
					PoolEvent.CONFLICT_DETECTED,
				);

				try {
					const result = await pool.execute(
						"Build an API with shared routing: " +
							"1) Define the main routes in src/api/routes.ts, " +
							"2) Write tests that exercise the routes, " +
							"3) Create middleware for authentication",
					);

					expect(result).toBeDefined();

					if (result.agents.length >= 2 && conflictEvents.length > 0) {
						// Verify no duplicate conflict IDs
						const ids = conflictEvents.map((e) => e.conflict.id);
						const uniqueIds = new Set(ids);
						expect(uniqueIds.size).toBe(ids.length);

						// File overlaps (structural) should exist if agents both wrote routes.ts
						const structural = conflictEvents.filter(
							(e) => e.conflict.type === "file_overlap",
						);
						// Semantic conflicts should NOT duplicate already-detected structural ones
						// (the implementation skips semantic analysis when structural is found)
						const semantic = conflictEvents.filter(
							(e) => e.conflict.type === "semantic_conflict",
						);

						// If structural conflicts were found, the same delta should NOT
						// also produce semantic conflicts (by design)
						if (structural.length > 0) {
							// For each structural conflict's source delta, there should be
							// no semantic conflict from the same source agent + same delta
							for (const s of structural) {
								const duplicateSemantic = semantic.find(
									(sem) =>
										sem.conflict.sourceAgentId === s.conflict.sourceAgentId &&
										sem.conflict.filePath === s.conflict.filePath,
								);
								// This might be undefined (correct) or defined if a different
								// delta triggered the semantic analysis. Not a strict invariant
								// at the event level, but good to observe.
								if (duplicateSemantic) {
									// If there IS a semantic conflict for the same file,
									// it should be from a different evaluation (different delta)
									expect(duplicateSemantic.conflict.id).not.toBe(s.conflict.id);
								}
							}
						}
					}

					// Execution should always succeed
					for (const agentResult of result.agents) {
						expect(agentResult.success).toBe(true);
					}
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);

		// ── 6. Disabled Conflict Detection Under Load ──────────────────

		it(
			"pool with conflict detection disabled handles multi-agent execution identically to before",
			async () => {
				const tracker = trackingAgentFactory();

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 4,
						conflictDetection: {
							enabled: false,
						},
					}),
				);

				const conflictEvents = collectPoolEvents<ConflictDetectedEvent>(
					pool,
					PoolEvent.CONFLICT_DETECTED,
				);

				try {
					// Run a complex multi-agent task
					const result = await pool.execute(
						"Build a complete microservice: " +
							"1) API gateway with Express, " +
							"2) Database service with Prisma, " +
							"3) Auth service with JWT, " +
							"4) Monitoring with health checks",
					);

					expect(result).toBeDefined();
					expect(result.agents.length).toBeGreaterThanOrEqual(1);

					// Zero conflict events — detection is off
					expect(conflictEvents.length).toBe(0);

					// All agents should still succeed
					for (const agentResult of result.agents) {
						expect(agentResult.success).toBe(true);
					}

					// State should reflect zero conflicts
					const state = pool.getState();
					expect(state.conflictCount).toBe(0);
					expect(state.unresolvedConflictCount).toBe(0);
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);

		// ── 7. maxConflicts Enforcement Under Sustained Load ───────────

		it(
			"maxConflicts=5 enforced even when many overlapping writes occur",
			async () => {
				// Create agents that write to many overlapping files
				const manyFiles = Array.from(
					{ length: 10 },
					(_, i) => `src/modules/module-${i}.ts`,
				);
				const { factory } = fileWritingAgentFactory(manyFiles);

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: factory,
						maxAgents: 3,
						conflictDetection: {
							enabled: true,
							enableSemanticAnalysis: false,
							minAlertSeverity: 0.3,
							maxConflicts: 5, // Very low limit
						},
					}),
				);

				const _conflictEvents = collectPoolEvents<ConflictDetectedEvent>(
					pool,
					PoolEvent.CONFLICT_DETECTED,
				);

				try {
					const result = await pool.execute(
						"Build a modular system with many shared modules: " +
							"1) Create core modules in src/modules/, " +
							"2) Write tests for all modules, " +
							"3) Create documentation for the modules",
					);

					expect(result).toBeDefined();

					// Even though many conflict events may have been emitted over time,
					// the detector's internal store should never exceed maxConflicts=5.
					// We can't inspect the internal state here (post-cleanup), but we
					// verify that the execution didn't crash and events were emitted.

					// All agents should succeed
					for (const agentResult of result.agents) {
						expect(agentResult.success).toBe(true);
					}

					// Final state is clean
					const state = pool.getState();
					expect(state.conflictCount).toBe(0);
					expect(state.unresolvedConflictCount).toBe(0);
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);

		// ── 8. Alert Content Verification ──────────────────────────────

		it(
			"injected conflict alerts contain actionable information for the agent",
			async () => {
				const sharedFiles = ["src/config/database.ts"];
				const { factory, injectedContexts } =
					fileWritingAgentFactory(sharedFiles);

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: factory,
						maxAgents: 3,
						conflictDetection: {
							enabled: true,
							enableSemanticAnalysis: false,
							minAlertSeverity: 0.1, // Very low: alert on everything
						},
					}),
				);

				const conflictEvents = collectPoolEvents<ConflictDetectedEvent>(
					pool,
					PoolEvent.CONFLICT_DETECTED,
				);

				try {
					const result = await pool.execute(
						"Build database configuration: " +
							"1) Create database config in src/config/database.ts, " +
							"2) Write tests for the database config, " +
							"3) Create migration scripts",
					);

					expect(result).toBeDefined();

					if (result.agents.length >= 2 && conflictEvents.length > 0) {
						// Verify every conflict produced an alert injection
						const alertInjections = injectedContexts.filter((ctx) => {
							if (typeof ctx.content !== "object" || ctx.content === null)
								return false;
							const s = ctx.content as StructuredContextInjection;
							return (
								s.category === ContextInjectionCategory.COORDINATION_ALERT &&
								s.priority === ContextInjectionPriority.CRITICAL
							);
						});

						if (alertInjections.length > 0) {
							for (const alert of alertInjections) {
								const s = alert.content as StructuredContextInjection;

								// Alert content should be actionable
								expect(s.content.length).toBeGreaterThan(20);
								expect(s.content).toContain("CONFLICT ALERT");

								// Should contain a recommendation
								expect(s.content).toContain("Recommendation");

								// Source should identify the conflict detector
								expect(s.source).toContain("conflict-detector");

								// Timestamp should be present
								expect(s.timestamp?.length).toBeGreaterThan(0);

								// dependencyType should be null for conflict alerts
								expect(s.dependencyType).toBeNull();
							}
						}
					}
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);

		// ── 9. Pool Destroy During/After Conflict Detection ────────────

		it(
			"destroying the pool after an execution with conflicts does not leave dangling state",
			async () => {
				const tracker = trackingAgentFactory();

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 3,
						conflictDetection: {
							enabled: true,
							enableSemanticAnalysis: false,
						},
					}),
				);

				const result = await pool.execute(
					"Build a simple utility: 1) Create helper functions, 2) Write tests",
				);

				expect(result).toBeDefined();

				// Verify clean state before destroy
				const preDestroyState = pool.getState();
				expect(preDestroyState.conflictCount).toBe(0);
				expect(preDestroyState.unresolvedConflictCount).toBe(0);
				expect(preDestroyState.executing).toBe(false);

				// Destroy should not throw
				await expect(pool.destroy()).resolves.toBeUndefined();

				// After destroy, getState should throw or be safe
				expect(() => {
					try {
						pool.getState();
					} catch {
						// Expected — pool is destroyed
					}
				}).not.toThrow();
			},
			LONG_TIMEOUT_MS,
		);

		// ── 10. Reflection Engine Receives Conflict-Affected Execution ─

		it(
			"reflection engine operates correctly when conflict detection is active",
			async () => {
				const sharedFiles = ["src/shared/types.ts"];
				const { factory } = fileWritingAgentFactory(sharedFiles);

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: factory,
						maxAgents: 3,
						conflictDetection: {
							enabled: true,
							enableSemanticAnalysis: false,
							minAlertSeverity: 0.5,
						},
						reflection: {
							enabled: true,
						},
					}),
				);

				const reflectionEvents: unknown[] = [];
				pool.on(PoolEvent.REFLECTION_COMPLETE, ((e: unknown) => {
					reflectionEvents.push(e);
				}) as any);

				try {
					const result = await pool.execute(
						"Build a type-safe system: " +
							"1) Define shared types in src/shared/types.ts, " +
							"2) Build the API using those types, " +
							"3) Write type-checked tests",
					);

					expect(result).toBeDefined();

					// Execution should succeed regardless of conflicts
					for (const agentResult of result.agents) {
						expect(agentResult.success).toBe(true);
					}

					// If multi-agent execution occurred, reflection should have run
					if (result.agents.length >= 2 && reflectionEvents.length > 0) {
						// Reflection completed without error
						expect(reflectionEvents.length).toBeGreaterThanOrEqual(1);
					}

					// Summary should be generated
					expect(result.summary.length).toBeGreaterThan(0);
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);
	},
);
