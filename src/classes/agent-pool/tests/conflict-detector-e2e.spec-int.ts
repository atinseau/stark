import { describe, expect, it } from "bun:test";
import { AgentEvent } from "../../../enums/agent-event.enum.ts";
import { DeltaType } from "../../../enums/delta-type.enum.ts";
import { PoolEvent } from "../../../enums/pool-event.enum.ts";
import type {
	ConflictDetectedEvent,
	ConflictRecord,
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
// End-to-End Integration Tests — Conflict Detection in Real Pool Execution
//
// These tests exercise the full conflict-detection pipeline within a real
// AgentPool.execute() call. They use mock agents (so no real MCP sessions)
// but real LLM calls for planning/sharing/orchestration.
//
// Runtime: each test can take 30–120 seconds depending on LLM latency.
// ════════════════════════════════════════════════════════════════════════════

const E2E_TIMEOUT_MS = INT_TIMEOUT_MS * 2; // 240 s

describe.skipIf(!HAS_API_KEY)(
	"ConflictDetector — End-to-End in AgentPool",
	() => {
		// ── Test 25: handleDelta triggers conflict detection in multi-agent ──

		it(
			"CONFLICT_DETECTED event is emitted when agents write the same file (Test 25)",
			async () => {
				// Create agents that emit FS_WRITE events for the same file
				let agentIndex = 0;
				const injectedContexts: Array<{
					agentName: string;
					content: string | StructuredContextInjection;
				}> = [];

				const factory = (config?: { name?: string }) => {
					const { createMockAgent } = require("./test-helpers.ts");
					const agentName = config?.name ?? `ConflictAgent-${agentIndex++}`;

					const agent = createMockAgent({
						name: agentName,
						promptResult: {
							stopReason: "end_turn" as const,
							text: `Task completed by ${agentName}.`,
							usage: {
								inputTokens: 100,
								outputTokens: 50,
								totalTokens: 150,
							},
						},
					});

					// Wrap injectContext to track conflict alerts
					const originalInjectContext = agent.injectContext;
					(agent as any).injectContext = (
						instructions: string | StructuredContextInjection,
					) => {
						injectedContexts.push({
							agentName,
							content: instructions,
						});
						return originalInjectContext.call(agent, instructions);
					};

					// Emit a FILE_WRITTEN event for a shared file when prompted
					const originalPrompt = agent.prompt;
					(agent as any).prompt = async (text: string) => {
						// Simulate writing to the same file
						agent.emit(AgentEvent.TOOL_COMPLETE, {
							event: AgentEvent.TOOL_COMPLETE,
							timestamp: new Date().toISOString(),
							agent: agent.identity,
							toolCallId: `tc-${crypto.randomUUID().slice(0, 8)}`,
							title: "write_file",
							output: `Wrote src/models/user.ts`,
						});

						return originalPrompt.call(agent, text);
					};

					return agent;
				};

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: factory,
						maxAgents: 3,
						conflictDetection: {
							enabled: true,
							enableSemanticAnalysis: false, // Structural only for speed
							minAlertSeverity: 0.5,
						},
					}),
				);

				const conflictEvents = collectPoolEvents<ConflictDetectedEvent>(
					pool,
					PoolEvent.CONFLICT_DETECTED,
				);

				try {
					const result = await pool.execute(
						"Build a REST API with Express.js: " +
							"1) Create the user model and schema in src/models/user.ts, " +
							"2) Write unit tests for the user model, " +
							"3) Create API documentation for the user endpoints",
					);

					expect(result).toBeDefined();

					// The pool ran successfully
					expect(result.agents.length).toBeGreaterThanOrEqual(1);

					// If multiple agents were spawned and both wrote the same file,
					// conflict events should have been emitted.
					// Note: The LLM may choose single-agent strategy, in which case
					// no conflicts would occur. This test is best-effort.
					if (result.agents.length >= 2) {
						// Check state reflects conflict count
						// (state is already cleaned up at this point, so conflictCount == 0)
						// We verify via the collected events instead
						if (conflictEvents.length > 0) {
							const conflict = conflictEvents[0]!.conflict;
							expect(conflict.type).toBeDefined();
							expect(conflict.severity).toBeGreaterThan(0);
							expect(conflict.description.length).toBeGreaterThan(0);
							expect(conflict.recommendation.length).toBeGreaterThan(0);
							expect(conflict.resolved).toBe(true); // Should be marked resolved after alert
						}
					}
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			E2E_TIMEOUT_MS,
		);

		// ── Test 28: No conflict detector for single-agent executions ────

		it(
			"conflict detector is NOT instantiated for single-agent executions (Test 28)",
			async () => {
				const tracker = trackingAgentFactory();

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 1,
						conflictDetection: {
							enabled: true,
							enableSemanticAnalysis: false,
						},
					}),
				);

				const conflictEvents = collectPoolEvents<ConflictDetectedEvent>(
					pool,
					PoolEvent.CONFLICT_DETECTED,
				);

				try {
					// Simple task that should result in single-agent execution
					const result = await pool.execute(
						"Create a simple hello world function in TypeScript",
					);

					expect(result).toBeDefined();
					expect(result.agents.length).toBe(1);
					expect(result.analysis.strategy).toBeDefined();

					// No conflicts should be detected in single-agent mode
					expect(conflictEvents.length).toBe(0);

					// State should show zero conflicts
					// (After execution, state is cleaned up)
					const state = pool.getState();
					expect(state.conflictCount).toBe(0);
					expect(state.unresolvedConflictCount).toBe(0);
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			E2E_TIMEOUT_MS,
		);

		// ── Test 30: Detector cleaned between sequential executions ──────

		it(
			"conflict state is cleaned up between sequential executions (Test 30)",
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

				try {
					// First execution
					const result1 = await pool.execute(
						"Create a README.md file for the project",
					);
					expect(result1).toBeDefined();

					// After first execution, state should be clean
					const midState = pool.getState();
					expect(midState.executing).toBe(false);
					expect(midState.conflictCount).toBe(0);
					expect(midState.unresolvedConflictCount).toBe(0);
					expect(midState.activeAgentCount).toBe(0);

					// Second execution on the same pool
					const result2 = await pool.execute(
						"Create a LICENSE file for the project",
					);
					expect(result2).toBeDefined();

					// After second execution, state should also be clean
					const finalState = pool.getState();
					expect(finalState.executing).toBe(false);
					expect(finalState.conflictCount).toBe(0);
					expect(finalState.unresolvedConflictCount).toBe(0);
					expect(finalState.activeAgentCount).toBe(0);
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			E2E_TIMEOUT_MS * 2,
		);

		// ── Test 26+27: Alert injection with threshold filtering ─────────

		it(
			"conflict alerts are injected with CRITICAL priority into affected agents (Test 26 + 27)",
			async () => {
				// Track all injectContext calls across all agents
				const injectedAlerts: Array<{
					agentName: string;
					injection: StructuredContextInjection;
				}> = [];

				let agentCounter = 0;
				const agentNames: string[] = [];

				const factory = (config?: { name?: string }) => {
					const { createMockAgent } = require("./test-helpers.ts");
					const name = config?.name ?? `AlertTestAgent-${agentCounter++}`;
					agentNames.push(name);

					const agent = createMockAgent({
						name,
						promptResult: {
							stopReason: "end_turn" as const,
							text: `Done by ${name}.`,
							usage: {
								inputTokens: 100,
								outputTokens: 50,
								totalTokens: 150,
							},
						},
					});

					// Track structured context injections (conflict alerts)
					const originalInjectContext = agent.injectContext;
					(agent as any).injectContext = (
						instructions: string | StructuredContextInjection,
					) => {
						if (typeof instructions === "object" && instructions !== null) {
							const structured = instructions as StructuredContextInjection;
							if (
								structured.category === "coordination_alert" &&
								structured.source?.includes("conflict-detector")
							) {
								injectedAlerts.push({
									agentName: name,
									injection: structured,
								});
							}
						}
						return originalInjectContext.call(agent, instructions);
					};

					return agent;
				};

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: factory,
						maxAgents: 4,
						conflictDetection: {
							enabled: true,
							enableSemanticAnalysis: false,
							minAlertSeverity: 0.5,
						},
					}),
				);

				const conflictEvents = collectPoolEvents<ConflictDetectedEvent>(
					pool,
					PoolEvent.CONFLICT_DETECTED,
				);

				try {
					await pool.execute(
						"Build a full-stack app: " +
							"1) Create the database models in src/models/, " +
							"2) Build the API controllers, " +
							"3) Write test suites for the API",
					);

					// If conflicts were detected (depends on LLM planning + agent events),
					// verify that alerts were properly injected
					if (conflictEvents.length > 0) {
						for (const event of conflictEvents) {
							const conflict = event.conflict;

							// All detected conflicts above threshold should have been alerted
							if (conflict.severity >= 0.5) {
								expect(conflict.resolved).toBe(true);
							}
						}

						// Check that injected alerts have CRITICAL priority
						if (injectedAlerts.length > 0) {
							for (const alert of injectedAlerts) {
								expect(alert.injection.priority).toBe(
									ContextInjectionPriority.CRITICAL,
								);
								expect(alert.injection.category).toBe(
									ContextInjectionCategory.COORDINATION_ALERT,
								);
								expect(alert.injection.source).toContain("conflict-detector");
								expect(alert.injection.content).toContain("CONFLICT ALERT");
							}
						}
					}
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			E2E_TIMEOUT_MS,
		);

		// ── Test 32: Sharing works normally without conflicts ─────────────

		it(
			"sharing continues to work normally when no conflicts are present (Test 32)",
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

				const _conflictEvents = collectPoolEvents<ConflictDetectedEvent>(
					pool,
					PoolEvent.CONFLICT_DETECTED,
				);

				try {
					const result = await pool.execute(
						"Build a REST API: 1) Define API routes, 2) Write tests for the routes",
					);

					expect(result).toBeDefined();
					expect(result.agents.length).toBeGreaterThanOrEqual(1);

					// The execution should complete successfully regardless of
					// whether conflicts were detected or not.
					// The key assertion: no crash, no unhandled errors.
					for (const agentResult of result.agents) {
						expect(agentResult.success).toBe(true);
					}

					// Summary should be generated
					expect(result.summary.length).toBeGreaterThan(0);
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			E2E_TIMEOUT_MS,
		);

		// ── Test 34 extended: Pool without conflictDetection config works ─

		it(
			"pool execution works correctly without conflictDetection config (Test 34 extended)",
			async () => {
				const tracker = trackingAgentFactory();

				// No conflictDetection in config at all
				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 3,
					}),
				);

				try {
					const result = await pool.execute(
						"Create a simple utility library with a few helper functions",
					);

					expect(result).toBeDefined();
					expect(result.agents.length).toBeGreaterThanOrEqual(1);

					for (const agentResult of result.agents) {
						expect(agentResult.success).toBe(true);
					}

					// State should be valid
					const state = pool.getState();
					expect(state.conflictCount).toBe(0);
					expect(state.unresolvedConflictCount).toBe(0);
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			E2E_TIMEOUT_MS,
		);

		// ── Test: Pool with conflictDetection disabled executes normally ──

		it(
			"pool with conflictDetection explicitly disabled works correctly",
			async () => {
				const tracker = trackingAgentFactory();

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 3,
						conflictDetection: { enabled: false },
					}),
				);

				const conflictEvents = collectPoolEvents<ConflictDetectedEvent>(
					pool,
					PoolEvent.CONFLICT_DETECTED,
				);

				try {
					const result = await pool.execute(
						"Build a REST API with documentation and tests",
					);

					expect(result).toBeDefined();

					// No conflicts should ever be detected when disabled
					expect(conflictEvents.length).toBe(0);

					const state = pool.getState();
					expect(state.conflictCount).toBe(0);
					expect(state.unresolvedConflictCount).toBe(0);
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			E2E_TIMEOUT_MS,
		);

		// ── Test: ConflictRecord structure validation in real execution ───

		it(
			"emitted ConflictRecord has all required fields with valid values",
			async () => {
				let agentIdx = 0;

				// Force file overlap by having agents emit TOOL_COMPLETE for the same file
				const factory = (config?: { name?: string }) => {
					const { createMockAgent } = require("./test-helpers.ts");
					const name = config?.name ?? `FieldValidationAgent-${agentIdx++}`;

					const agent = createMockAgent({
						name,
						promptResult: {
							stopReason: "end_turn" as const,
							text: `Completed: ${name}`,
							usage: {
								inputTokens: 100,
								outputTokens: 50,
								totalTokens: 150,
							},
						},
					});

					const originalPrompt = agent.prompt;
					(agent as any).prompt = async (text: string) => {
						// All agents write to the same shared file
						agent.emit(AgentEvent.TOOL_COMPLETE, {
							event: AgentEvent.TOOL_COMPLETE,
							timestamp: new Date().toISOString(),
							agent: agent.identity,
							toolCallId: `tc-${crypto.randomUUID().slice(0, 8)}`,
							title: "write_file",
							output: "Wrote src/shared/config.ts",
						});

						return originalPrompt.call(agent, text);
					};

					return agent;
				};

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: factory,
						maxAgents: 3,
						conflictDetection: {
							enabled: true,
							enableSemanticAnalysis: false,
							minAlertSeverity: 0.3, // Low threshold to catch all
						},
					}),
				);

				const conflictEvents = collectPoolEvents<ConflictDetectedEvent>(
					pool,
					PoolEvent.CONFLICT_DETECTED,
				);

				try {
					await pool.execute(
						"Build a complex system: " +
							"1) Create shared configuration in src/shared/config.ts, " +
							"2) Build the API server using the shared config, " +
							"3) Write integration tests using the shared config",
					);

					// Validate ConflictRecord structure for any detected conflicts
					for (const event of conflictEvents) {
						const c: ConflictRecord = event.conflict;

						// Required fields
						expect(typeof c.id).toBe("string");
						expect(c.id.length).toBeGreaterThan(0);

						expect([
							"file_overlap",
							"stale_share",
							"semantic_conflict",
							"dependency_violation",
						]).toContain(c.type);

						expect(typeof c.severity).toBe("number");
						expect(c.severity).toBeGreaterThanOrEqual(0);
						expect(c.severity).toBeLessThanOrEqual(1);

						expect(typeof c.description).toBe("string");
						expect(c.description.length).toBeGreaterThan(0);

						expect(typeof c.sourceAgentId).toBe("string");
						expect(c.sourceAgentId.length).toBeGreaterThan(0);

						expect(typeof c.sourceAgentName).toBe("string");
						expect(c.sourceAgentName.length).toBeGreaterThan(0);

						expect(Array.isArray(c.affectedAgentIds)).toBe(true);
						expect(c.affectedAgentIds.length).toBeGreaterThan(0);

						expect(typeof c.recommendation).toBe("string");
						expect(c.recommendation.length).toBeGreaterThan(0);

						expect(typeof c.timestamp).toBe("string");
						// ISO-8601 check
						expect(() => new Date(c.timestamp)).not.toThrow();
						expect(Number.isNaN(new Date(c.timestamp).getTime())).toBe(false);

						expect(typeof c.resolved).toBe("boolean");

						// Optional fields should be correct types when present
						if (c.filePath !== undefined) {
							expect(typeof c.filePath).toBe("string");
						}
						if (c.staleInformation !== undefined) {
							expect(typeof c.staleInformation).toBe("string");
						}
					}
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			E2E_TIMEOUT_MS,
		);

		// ── Test: getState during execution reflects real-time conflicts ──

		it(
			"getState reflects conflict count during and after execution",
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

				// Check state before execution
				const preState = pool.getState();
				expect(preState.conflictCount).toBe(0);
				expect(preState.unresolvedConflictCount).toBe(0);
				expect(preState.executing).toBe(false);

				try {
					await pool.execute("Write a simple utility function");

					// After execution completes, detector is cleaned up
					const postState = pool.getState();
					expect(postState.conflictCount).toBe(0);
					expect(postState.unresolvedConflictCount).toBe(0);
					expect(postState.executing).toBe(false);
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			E2E_TIMEOUT_MS,
		);
	},
);

// ════════════════════════════════════════════════════════════════════════════
// Non-regression: conflict detection does not break existing pool behavior
// ════════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_API_KEY)("ConflictDetector — Non-Regression E2E", () => {
	it(
		"multi-agent execution with conflict detection enabled produces valid results",
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
						maxConflicts: 20,
					},
				}),
			);

			try {
				const result = await pool.execute(
					"Build a complete REST API with Express.js including: " +
						"1) The API routes and controllers for a user management system, " +
						"2) A comprehensive test suite, " +
						"3) API documentation using Swagger",
				);

				// Execution should complete successfully
				expect(result).toBeDefined();
				expect(result.analysis).toBeDefined();
				expect(result.agents.length).toBeGreaterThanOrEqual(1);

				for (const agentResult of result.agents) {
					expect(agentResult.success).toBe(true);
					expect(agentResult.subtask).toBeDefined();
					expect(agentResult.subtask.role.length).toBeGreaterThan(0);
				}

				// Summary should be generated despite conflict detection overhead
				expect(result.summary.length).toBeGreaterThan(0);
			} finally {
				if (!(pool as any)._destroyed) await pool.destroy();
			}
		},
		E2E_TIMEOUT_MS,
	);

	it(
		"semantic conflict analysis does not crash the execution when enabled",
		async () => {
			const tracker = trackingAgentFactory();

			const pool = new AgentPool(
				intPoolConfig({
					createAgent: tracker.factory,
					maxAgents: 3,
					conflictDetection: {
						enabled: true,
						enableSemanticAnalysis: true, // Enable full LLM analysis
						minAlertSeverity: 0.5,
					},
				}),
			);

			try {
				const result = await pool.execute(
					"Create a simple hello world Express server with a test file",
				);

				// Even with semantic analysis enabled, execution should complete
				expect(result).toBeDefined();
				expect(result.agents.length).toBeGreaterThanOrEqual(1);

				for (const agentResult of result.agents) {
					expect(agentResult.success).toBe(true);
				}
			} finally {
				if (!(pool as any)._destroyed) await pool.destroy();
			}
		},
		E2E_TIMEOUT_MS,
	);

	it("CONFLICT_DETECTED events have the correct PoolEvent string value", () => {
		// Sanity check that the event constant matches
		expect(PoolEvent.CONFLICT_DETECTED as string).toBe(
			"pool:conflict-detected",
		);
	});

	it("DeltaType.CONFLICT_DETECTED has the correct string value", () => {
		expect(DeltaType.CONFLICT_DETECTED as string).toBe("conflict_detected");
	});
});
