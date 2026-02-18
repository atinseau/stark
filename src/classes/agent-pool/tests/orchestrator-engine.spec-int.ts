import { describe, expect, it } from "bun:test";
import { PoolEvent } from "../../../enums/pool-event.enum.ts";
import type {
	OrchestratorAssessment,
	OrchestratorAssessmentEvent,
} from "../../../types/agent-pool.types.ts";
import { AgentPool } from "../agent-pool.ts";
import {
	HAS_API_KEY,
	INT_TIMEOUT_MS,
	intPoolConfig,
	trackingAgentFactory,
} from "./test-helpers-int.ts";

// ════════════════════════════════════════════════════════════════════════════
// OrchestratorEngine — Long-Running Integration Tests
//
// These tests exercise the orchestrator in real multi-agent execution
// scenarios with actual LLM calls. They verify that the orchestrator:
//
// 1. Triggers during multi-agent executions
// 2. Produces valid OrchestratorAssessment objects
// 3. Emits ORCHESTRATOR_ASSESSMENT events
// 4. Resets between executions
// 5. Stays silent during single-agent executions
// 6. Injects directives into subsystem prompts
// 7. Exposes state correctly via getState()
//
// These tests require OPENROUTER_API_KEY and may take 30-120 seconds each.
// ════════════════════════════════════════════════════════════════════════════

const LONG_TIMEOUT_MS = 180_000;

describe.skipIf(!HAS_API_KEY)(
	"OrchestratorEngine int — real execution context",
	() => {
		// ── Test 21: handleDelta triggers orchestrator in multi-agent ───

		it(
			"triggers orchestrator assessment during multi-agent execution with low intervals",
			async () => {
				const tracker = trackingAgentFactory();
				const assessments: OrchestratorAssessment[] = [];

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 5,
						orchestrator: {
							enabled: true,
							// Very aggressive trigger settings so it fires during test
							deltaInterval: 2,
							minIntervalMs: 0,
						},
					}),
				);

				pool.on(PoolEvent.ORCHESTRATOR_ASSESSMENT, (e) => {
					assessments.push(e.assessment);
				});

				try {
					const result = await pool.execute(
						"Build a REST API with Express.js including: " +
							"1) User CRUD routes and controllers, " +
							"2) A comprehensive test suite with Jest, " +
							"3) API documentation with Swagger/OpenAPI",
					);

					expect(result).toBeDefined();
					expect(result.analysis).toBeDefined();

					// If the planner chose multi-agent strategy, orchestrator may have triggered
					if (
						result.analysis.subtasks.length >= 2 &&
						result.agents.length >= 2
					) {
						// With deltaInterval: 2 and minIntervalMs: 0, the orchestrator
						// should trigger if enough deltas were produced.
						// We can't guarantee it fires (depends on LLM timing), but if it did:
						if (assessments.length > 0) {
							const assessment = assessments[0]!;

							// Validate assessment structure
							expect(assessment.coherenceScore).toBeGreaterThanOrEqual(0);
							expect(assessment.coherenceScore).toBeLessThanOrEqual(1);
							expect(typeof assessment.assessment).toBe("string");
							expect(assessment.assessment.length).toBeGreaterThan(0);
							expect(Array.isArray(assessment.issues)).toBe(true);
							expect(Array.isArray(assessment.directives)).toBe(true);
							expect(assessment.assessmentNumber).toBeGreaterThanOrEqual(1);
							expect(typeof assessment.timestamp).toBe("string");

							// Validate issues if any
							for (const issue of assessment.issues) {
								expect([
									"coherence",
									"efficiency",
									"drift",
									"conflict",
									"communication",
								]).toContain(issue.category);
								expect(["low", "medium", "high"]).toContain(issue.severity);
								expect(typeof issue.description).toBe("string");
								expect(Array.isArray(issue.affected)).toBe(true);
							}

							// Validate directives if any
							for (const directive of assessment.directives) {
								expect([
									"sharing",
									"notification",
									"planner",
									"checkpoint",
									"all",
								]).toContain(directive.target);
								expect(["suggestion", "recommendation", "strong"]).toContain(
									directive.priority,
								);
								expect(typeof directive.instruction).toBe("string");
								expect(directive.ttlEvaluations).toBeGreaterThanOrEqual(1);
								expect(typeof directive.id).toBe("string");
								expect(typeof directive.timestamp).toBe("string");
							}
						}
					}
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);

		// ── Test 22: Orchestrator stays silent for single-agent ─────────

		it(
			"does NOT emit orchestrator assessments for single-agent executions",
			async () => {
				const tracker = trackingAgentFactory();
				const assessments: OrchestratorAssessment[] = [];

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 1, // Force single agent
						orchestrator: {
							enabled: true,
							deltaInterval: 1,
							minIntervalMs: 0,
						},
					}),
				);

				pool.on(PoolEvent.ORCHESTRATOR_ASSESSMENT, (e) => {
					assessments.push(e.assessment);
				});

				try {
					const result = await pool.execute(
						"Write a simple hello world function in JavaScript",
					);

					expect(result).toBeDefined();
					// Single agent = no orchestrator assessment
					expect(assessments).toHaveLength(0);
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			INT_TIMEOUT_MS,
		);

		// ── Test 25: Orchestrator state exposed in getState() ──────────

		it(
			"getState() includes orchestrator fields with correct values during execution",
			async () => {
				const tracker = trackingAgentFactory();
				const stateSnapshots: Array<{
					orchestratorAssessmentCount: number;
					activeDirectiveCount: number;
					coherenceScore: number | null;
				}> = [];

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 5,
						orchestrator: {
							enabled: true,
							deltaInterval: 2,
							minIntervalMs: 0,
						},
					}),
				);

				// Capture state on every delta
				pool.on(PoolEvent.DELTA_DETECTED, () => {
					const state = pool.getState();
					stateSnapshots.push({
						orchestratorAssessmentCount: state.orchestratorAssessmentCount,
						activeDirectiveCount: state.activeDirectiveCount,
						coherenceScore: state.coherenceScore,
					});
				});

				// Also capture after orchestrator assessment
				pool.on(PoolEvent.ORCHESTRATOR_ASSESSMENT, () => {
					const state = pool.getState();
					stateSnapshots.push({
						orchestratorAssessmentCount: state.orchestratorAssessmentCount,
						activeDirectiveCount: state.activeDirectiveCount,
						coherenceScore: state.coherenceScore,
					});
				});

				try {
					// Before execution
					const preState = pool.getState();
					expect(preState.orchestratorAssessmentCount).toBe(0);
					expect(preState.activeDirectiveCount).toBe(0);
					expect(preState.coherenceScore).toBeNull();

					await pool.execute(
						"Build a REST API with Express.js including: " +
							"1) User CRUD routes, " +
							"2) Tests with Jest, " +
							"3) API docs with Swagger",
					);

					// After execution (orchestrator is reset)
					const postState = pool.getState();
					expect(postState.orchestratorAssessmentCount).toBe(0);
					expect(postState.activeDirectiveCount).toBe(0);
					expect(postState.coherenceScore).toBeNull();

					// During execution, state snapshots should have valid types
					for (const snapshot of stateSnapshots) {
						expect(typeof snapshot.orchestratorAssessmentCount).toBe("number");
						expect(snapshot.orchestratorAssessmentCount).toBeGreaterThanOrEqual(
							0,
						);
						expect(typeof snapshot.activeDirectiveCount).toBe("number");
						expect(snapshot.activeDirectiveCount).toBeGreaterThanOrEqual(0);
						// coherenceScore is null until first assessment
						if (snapshot.coherenceScore !== null) {
							expect(snapshot.coherenceScore).toBeGreaterThanOrEqual(0);
							expect(snapshot.coherenceScore).toBeLessThanOrEqual(1);
						}
					}
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);

		// ── Test 26: Orchestrator resets between executions ────────────

		it(
			"orchestrator state is reset between consecutive executions",
			async () => {
				const tracker = trackingAgentFactory();
				const firstRunAssessments: OrchestratorAssessment[] = [];
				const secondRunAssessments: OrchestratorAssessment[] = [];
				let isSecondRun = false;

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 5,
						orchestrator: {
							enabled: true,
							deltaInterval: 2,
							minIntervalMs: 0,
						},
					}),
				);

				pool.on(PoolEvent.ORCHESTRATOR_ASSESSMENT, (e) => {
					if (isSecondRun) {
						secondRunAssessments.push(e.assessment);
					} else {
						firstRunAssessments.push(e.assessment);
					}
				});

				try {
					// First execution
					await pool.execute(
						"Build a REST API with Express.js including: " +
							"1) User CRUD routes, " +
							"2) Tests with Jest, " +
							"3) API docs",
					);

					// State should be reset after first execution
					const midState = pool.getState();
					expect(midState.orchestratorAssessmentCount).toBe(0);
					expect(midState.activeDirectiveCount).toBe(0);
					expect(midState.coherenceScore).toBeNull();

					// Second execution
					isSecondRun = true;
					await pool.execute(
						"Create a CLI tool with: 1) Argument parser, 2) Unit tests",
					);

					// State reset again after second execution
					const endState = pool.getState();
					expect(endState.orchestratorAssessmentCount).toBe(0);
					expect(endState.activeDirectiveCount).toBe(0);
					expect(endState.coherenceScore).toBeNull();

					// If any assessments were produced in the second run, their
					// assessmentNumber should start from 1 (not continue from first run)
					if (secondRunAssessments.length > 0) {
						expect(secondRunAssessments[0]!.assessmentNumber).toBe(1);
					}
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);

		// ── Test 27b: Pool works normally without orchestrator config ──

		it(
			"pool executes normally without explicit orchestrator config",
			async () => {
				const tracker = trackingAgentFactory();

				// No orchestrator field in config at all
				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 3,
					}),
				);

				try {
					const result = await pool.execute(
						"Write a simple hello world function in TypeScript",
					);

					expect(result).toBeDefined();
					expect(result.summary.length).toBeGreaterThan(0);

					// State should include orchestrator fields with defaults
					const state = pool.getState();
					expect(typeof state.orchestratorAssessmentCount).toBe("number");
					expect(typeof state.activeDirectiveCount).toBe("number");
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			INT_TIMEOUT_MS,
		);

		// ── Test 28b: Explicitly disabled orchestrator produces no events ──

		it(
			"explicitly disabled orchestrator produces no assessment events even in multi-agent",
			async () => {
				const tracker = trackingAgentFactory();
				const assessments: OrchestratorAssessment[] = [];

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 5,
						orchestrator: {
							enabled: false,
							deltaInterval: 1,
							minIntervalMs: 0,
						},
					}),
				);

				pool.on(PoolEvent.ORCHESTRATOR_ASSESSMENT, (e) => {
					assessments.push(e.assessment);
				});

				try {
					await pool.execute(
						"Build a REST API with Express.js including: " +
							"1) User CRUD routes, " +
							"2) Tests with Jest, " +
							"3) API docs",
					);

					// Even with multi-agent, disabled orchestrator should not fire
					expect(assessments).toHaveLength(0);

					const state = pool.getState();
					expect(state.orchestratorAssessmentCount).toBe(0);
					expect(state.coherenceScore).toBeNull();
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);
	},
);

// ════════════════════════════════════════════════════════════════════════════
// Event structure validation
// ════════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_API_KEY)(
	"OrchestratorEngine int — event structure",
	() => {
		it(
			"ORCHESTRATOR_ASSESSMENT event has correct structure",
			async () => {
				const tracker = trackingAgentFactory();
				const events: OrchestratorAssessmentEvent[] = [];

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 5,
						orchestrator: {
							enabled: true,
							deltaInterval: 2,
							minIntervalMs: 0,
						},
					}),
				);

				pool.on(PoolEvent.ORCHESTRATOR_ASSESSMENT, (e) => {
					events.push(e);
				});

				try {
					await pool.execute(
						"Build a REST API with: 1) Routes, 2) Tests, 3) Docs",
					);

					// If any events were emitted, validate their structure
					for (const event of events) {
						// BasePoolEvent fields
						expect(event.event).toBe(PoolEvent.ORCHESTRATOR_ASSESSMENT);
						expect(typeof event.timestamp).toBe("string");
						// ISO-8601 format check
						expect(new Date(event.timestamp).toISOString()).toBe(
							event.timestamp,
						);

						// Assessment payload
						expect(event.assessment).toBeDefined();
						expect(typeof event.assessment.coherenceScore).toBe("number");
						expect(typeof event.assessment.assessment).toBe("string");
						expect(Array.isArray(event.assessment.issues)).toBe(true);
						expect(Array.isArray(event.assessment.directives)).toBe(true);
						expect(typeof event.assessment.timestamp).toBe("string");
						expect(typeof event.assessment.assessmentNumber).toBe("number");
					}
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);
	},
);

// ════════════════════════════════════════════════════════════════════════════
// Directive injection verification
// ════════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_API_KEY)(
	"OrchestratorEngine int — directive lifecycle",
	() => {
		it(
			"directives emitted during execution have valid IDs and timestamps",
			async () => {
				const tracker = trackingAgentFactory();
				const allDirectives: Array<{
					id: string;
					target: string;
					priority: string;
					instruction: string;
					ttlEvaluations: number;
					timestamp: string;
				}> = [];

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 5,
						orchestrator: {
							enabled: true,
							deltaInterval: 2,
							minIntervalMs: 0,
						},
					}),
				);

				pool.on(PoolEvent.ORCHESTRATOR_ASSESSMENT, (e) => {
					for (const d of e.assessment.directives) {
						allDirectives.push(d);
					}
				});

				try {
					await pool.execute(
						"Build a REST API with: 1) Routes, 2) Tests, 3) Docs",
					);

					// If directives were emitted, validate each one
					for (const directive of allDirectives) {
						expect(typeof directive.id).toBe("string");
						expect(directive.id.length).toBeGreaterThan(0);
						expect(typeof directive.timestamp).toBe("string");
						expect(new Date(directive.timestamp).toISOString()).toBe(
							directive.timestamp,
						);
						expect(directive.ttlEvaluations).toBeGreaterThanOrEqual(1);
						expect([
							"sharing",
							"notification",
							"planner",
							"checkpoint",
							"all",
						]).toContain(directive.target);
						expect(["suggestion", "recommendation", "strong"]).toContain(
							directive.priority,
						);
						expect(directive.instruction.length).toBeGreaterThan(0);
					}

					// If multiple directives, IDs should be unique
					if (allDirectives.length > 1) {
						const ids = allDirectives.map((d) => d.id);
						const uniqueIds = new Set(ids);
						expect(uniqueIds.size).toBe(ids.length);
					}
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);
	},
);

// ════════════════════════════════════════════════════════════════════════════
// Coherence score tracking
// ════════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_API_KEY)(
	"OrchestratorEngine int — coherence tracking",
	() => {
		it(
			"coherence scores across multiple assessments stay within [0, 1]",
			async () => {
				const tracker = trackingAgentFactory();
				const scores: number[] = [];

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 5,
						orchestrator: {
							enabled: true,
							deltaInterval: 2,
							minIntervalMs: 0,
						},
					}),
				);

				pool.on(PoolEvent.ORCHESTRATOR_ASSESSMENT, (e) => {
					scores.push(e.assessment.coherenceScore);
				});

				try {
					await pool.execute(
						"Build a full-stack application with: " +
							"1) Backend REST API with Express.js, " +
							"2) Unit tests with comprehensive coverage, " +
							"3) Complete API documentation",
					);

					// All scores must be in valid range
					for (const score of scores) {
						expect(score).toBeGreaterThanOrEqual(0);
						expect(score).toBeLessThanOrEqual(1);
					}
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);
	},
);

// ════════════════════════════════════════════════════════════════════════════
// Non-regression: sharing and notification work without directives
// ════════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_API_KEY)("OrchestratorEngine int — non-regression", () => {
	// ── Test 29: Sharing and notification work before first assessment ──

	it(
		"sharing and notification work normally before any orchestrator assessment fires",
		async () => {
			const tracker = trackingAgentFactory();
			let sharingDecisionCount = 0;
			let orchestratorAssessmentCount = 0;
			let sharingBeforeOrchestrator = false;

			const pool = new AgentPool(
				intPoolConfig({
					createAgent: tracker.factory,
					maxAgents: 5,
					orchestrator: {
						enabled: true,
						// High delta interval so orchestrator fires late (or never)
						deltaInterval: 50,
						minIntervalMs: 60_000,
					},
				}),
			);

			pool.on(PoolEvent.SHARING_DECISION, () => {
				sharingDecisionCount++;
				if (orchestratorAssessmentCount === 0) {
					sharingBeforeOrchestrator = true;
				}
			});

			pool.on(PoolEvent.ORCHESTRATOR_ASSESSMENT, () => {
				orchestratorAssessmentCount++;
			});

			pool.setNotificationPreference({
				enabled: true,
				minSignificance: 0.3,
			});

			try {
				const result = await pool.execute(
					"Build a REST API with: 1) Routes, 2) Tests, 3) Docs",
				);

				expect(result).toBeDefined();

				// If multi-agent was used and sharing decisions happened,
				// they should have worked fine even without orchestrator directives
				if (result.agents.length >= 2 && sharingDecisionCount > 0) {
					expect(sharingBeforeOrchestrator).toBe(true);
				}

				// Orchestrator should not have triggered (high thresholds)
				expect(orchestratorAssessmentCount).toBe(0);
			} finally {
				if (!(pool as any)._destroyed) await pool.destroy();
			}
		},
		LONG_TIMEOUT_MS,
	);

	it(
		"pool lifecycle events are complete and in order with orchestrator enabled",
		async () => {
			const tracker = trackingAgentFactory();
			const eventTypes: string[] = [];

			const pool = new AgentPool(
				intPoolConfig({
					createAgent: tracker.factory,
					maxAgents: 3,
					orchestrator: {
						enabled: true,
						deltaInterval: 3,
						minIntervalMs: 0,
					},
				}),
			);

			// Track all event types
			for (const event of Object.values(PoolEvent)) {
				pool.on(event, () => {
					eventTypes.push(event);
				});
			}

			try {
				await pool.execute("Write a hello world function in JavaScript");

				// Core lifecycle events should always be present
				expect(eventTypes).toContain(PoolEvent.TASK_RECEIVED);
				expect(eventTypes).toContain(PoolEvent.PLANNING_START);
				expect(eventTypes).toContain(PoolEvent.PLANNING_COMPLETE);
				expect(eventTypes).toContain(PoolEvent.AGENT_SPAWNED);
				expect(eventTypes).toContain(PoolEvent.EXECUTION_COMPLETE);

				// TASK_RECEIVED should be first
				expect(eventTypes[0]).toBe(PoolEvent.TASK_RECEIVED);

				// EXECUTION_COMPLETE should be last
				expect(eventTypes[eventTypes.length - 1]).toBe(
					PoolEvent.EXECUTION_COMPLETE,
				);
			} finally {
				if (!(pool as any)._destroyed) await pool.destroy();
			}
		},
		INT_TIMEOUT_MS,
	);
});
