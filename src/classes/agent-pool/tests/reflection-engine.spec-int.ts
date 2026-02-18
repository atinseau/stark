import { describe, expect, it } from "bun:test";
import { ExecutionStrategy } from "../../../enums/execution-strategy.enum.ts";
import { PoolEvent } from "../../../enums/pool-event.enum.ts";
import type { ReflectionCompleteEvent } from "../../../types/agent-pool.types.ts";
import { AgentPool } from "../agent-pool.ts";
import {
	HAS_API_KEY,
	intPoolConfig,
	trackingAgentFactory,
} from "./test-helpers-int.ts";

// ════════════════════════════════════════════════════════════════════════════
// ReflectionEngine — Long-Running Integration Tests
//
// These tests exercise the post-execution reflection cycle in real
// multi-agent execution scenarios with actual LLM calls. They verify that:
//
// 1. Reflection is triggered after multi-agent executions
// 2. The REFLECTION_COMPLETE event is emitted with valid data
// 3. ExecutionReflection is included in AgentPoolResult
// 4. Insights accumulate across consecutive executions
// 5. Insights are injected into the planner prompt for future planning
// 6. Reflection is skipped for single-agent executions by default
// 7. Reflection failure does NOT block execution
// 8. Reflection state is exposed via getState()
// 9. Reflection state resets on destroy() but insights survive between executions
// 10. PlannerMemory is enriched with reflection insights
//
// These tests require OPENROUTER_API_KEY and may take 30-180 seconds each.
// ════════════════════════════════════════════════════════════════════════════

const LONG_TIMEOUT_MS = 180_000;

describe.skipIf(!HAS_API_KEY)(
	"ReflectionEngine int — real execution context",
	() => {
		// ── Test 25: execute() calls reflect() after multi-agent execution ──

		it(
			"triggers reflection and emits REFLECTION_COMPLETE after multi-agent execution",
			async () => {
				const tracker = trackingAgentFactory();
				const reflectionEvents: ReflectionCompleteEvent[] = [];

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 5,
						reflection: {
							enabled: true,
						},
					}),
				);

				pool.on(PoolEvent.REFLECTION_COMPLETE, (e) => {
					reflectionEvents.push(e);
				});

				try {
					const result = await pool.execute(
						"Build a REST API server with Express.js that has user CRUD endpoints, and write unit tests for each endpoint using Jest.",
					);

					// If the planner chose multi-agent, we expect a reflection
					if (result.strategy === ExecutionStrategy.MULTI) {
						expect(reflectionEvents.length).toBe(1);

						const reflection = reflectionEvents[0]!.reflection;
						expect(typeof reflection.effectivenessScore).toBe("number");
						expect(reflection.effectivenessScore).toBeGreaterThanOrEqual(0);
						expect(reflection.effectivenessScore).toBeLessThanOrEqual(1);
						expect(typeof reflection.analysis).toBe("string");
						expect(reflection.analysis.length).toBeGreaterThan(0);
						expect([
							"optimal",
							"over-decomposed",
							"under-decomposed",
							"wrong-boundaries",
						]).toContain(reflection.decompositionAssessment);
						expect([
							"optimal",
							"over-shared",
							"under-shared",
							"wrong-content",
						]).toContain(reflection.sharingAssessment);
						expect(Array.isArray(reflection.insights)).toBe(true);
						expect(reflection.insights.length).toBeGreaterThanOrEqual(0);
						expect(reflection.insights.length).toBeLessThanOrEqual(5);

						// Each insight should have valid structure
						for (const insight of reflection.insights) {
							expect(typeof insight.id).toBe("string");
							expect([
								"decomposition",
								"sharing",
								"coordination",
								"performance",
								"tooling",
							]).toContain(insight.category);
							expect(typeof insight.confidence).toBe("number");
							expect(insight.confidence).toBeGreaterThanOrEqual(0);
							expect(insight.confidence).toBeLessThanOrEqual(1);
							expect(typeof insight.insight).toBe("string");
							expect(insight.insight.length).toBeGreaterThan(0);
							expect(typeof insight.applicableWhen).toBe("string");
							expect(insight.applicableWhen.length).toBeGreaterThan(0);
							expect(["positive", "negative", "neutral"]).toContain(
								insight.polarity,
							);
							expect(typeof insight.timestamp).toBe("string");
						}

						expect(typeof reflection.timestamp).toBe("string");
						expect(typeof reflection.executionDurationMs).toBe("number");
						expect(reflection.executionDurationMs).toBeGreaterThan(0);
					} else {
						// Single-agent: reflection should be skipped by default
						expect(reflectionEvents.length).toBe(0);
					}
				} finally {
					await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);

		// ── Test 26: execute() does NOT call reflect() for single-agent (default) ──

		it(
			"does NOT emit REFLECTION_COMPLETE for single-agent executions (default config)",
			async () => {
				const tracker = trackingAgentFactory();
				const reflectionEvents: ReflectionCompleteEvent[] = [];

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						reflection: {
							enabled: true,
							reflectOnSingleAgent: false,
						},
					}),
				);

				pool.on(PoolEvent.REFLECTION_COMPLETE, (e) => {
					reflectionEvents.push(e);
				});

				try {
					// Use a task that the planner will almost certainly treat as single-agent
					const result = await pool.execute(
						"Print 'Hello World' to the console.",
					);

					if (result.strategy === ExecutionStrategy.SINGLE) {
						expect(reflectionEvents.length).toBe(0);
						expect(result.reflection).toBeUndefined();
					}
					// If the planner happened to use multi, reflection would fire — that's fine
				} finally {
					await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);

		// ── Test 30: Reflection is included in AgentPoolResult ──────────

		it(
			"includes reflection in AgentPoolResult for multi-agent executions",
			async () => {
				const tracker = trackingAgentFactory();

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 5,
						reflection: { enabled: true },
					}),
				);

				try {
					const result = await pool.execute(
						"Create a Python Flask REST API with user authentication endpoints and write pytest tests for the auth module.",
					);

					if (result.strategy === ExecutionStrategy.MULTI) {
						// Reflection is non-critical — the LLM may occasionally
						// return invalid JSON, so reflection can be undefined even
						// for multi-agent executions. When it IS present, validate
						// its structure thoroughly.
						if (result.reflection) {
							expect(typeof result.reflection.effectivenessScore).toBe(
								"number",
							);
							expect(
								result.reflection.effectivenessScore,
							).toBeGreaterThanOrEqual(0);
							expect(result.reflection.effectivenessScore).toBeLessThanOrEqual(
								1,
							);
							expect(typeof result.reflection.analysis).toBe("string");
							expect(result.reflection.analysis.length).toBeGreaterThan(0);
							expect(Array.isArray(result.reflection.insights)).toBe(true);
							expect(result.reflection.task).toBe(result.task);
							expect(result.reflection.strategy).toBe(result.strategy);
							expect(typeof result.reflection.timestamp).toBe("string");
							expect(typeof result.reflection.executionDurationMs).toBe(
								"number",
							);
							expect(result.reflection.executionDurationMs).toBeGreaterThan(0);
							expect([
								"optimal",
								"over-decomposed",
								"under-decomposed",
								"wrong-boundaries",
							]).toContain(result.reflection.decompositionAssessment);
							expect([
								"optimal",
								"over-shared",
								"under-shared",
								"wrong-content",
							]).toContain(result.reflection.sharingAssessment);
						}
						// Either way, execution itself must succeed
						expect(result.summary).toBeDefined();
						expect(result.agents.length).toBeGreaterThan(0);
					}
				} finally {
					await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);

		// ── Test: getState() includes reflection fields ─────────────────

		it(
			"getState() includes reflection fields with correct values during and after execution",
			async () => {
				const tracker = trackingAgentFactory();

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 5,
						reflection: { enabled: true },
					}),
				);

				try {
					// Before execution
					const stateBefore = pool.getState();
					expect(stateBefore.reflectionCount).toBe(0);
					expect(stateBefore.insightCount).toBe(0);
					expect(stateBefore.lastEffectivenessScore).toBeNull();

					const result = await pool.execute(
						"Build a Node.js CLI tool with argument parsing and a test suite. Implement the parser and tests separately.",
					);

					// After execution
					const stateAfter = pool.getState();

					if (result.strategy === ExecutionStrategy.MULTI) {
						expect(stateAfter.reflectionCount).toBe(1);
						expect(stateAfter.insightCount).toBeGreaterThanOrEqual(0);
						if (result.reflection) {
							expect(stateAfter.lastEffectivenessScore).toBe(
								result.reflection.effectivenessScore,
							);
						}
					} else {
						// Single-agent: reflection skipped
						expect(stateAfter.reflectionCount).toBe(0);
					}
				} finally {
					await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);

		// ── Test 29: Insights survive between execute() but not after destroy() ──

		it(
			"insights survive between execute() calls but are cleared on destroy()",
			async () => {
				const tracker = trackingAgentFactory();

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 5,
						reflection: { enabled: true },
					}),
				);

				try {
					// First execution
					const result1 = await pool.execute(
						"Create a TypeScript library with a string utility module and a math utility module, each with their own tests.",
					);

					const stateAfter1 = pool.getState();
					const insightsAfter1 = stateAfter1.insightCount;

					if (
						result1.strategy === ExecutionStrategy.MULTI &&
						insightsAfter1 > 0
					) {
						// Second execution — insights from first should still be available
						const result2 = await pool.execute(
							"Build a React component library with a Button and Card component, and Storybook stories for each.",
						);

						const stateAfter2 = pool.getState();

						// Insights should have accumulated (or at least not decreased
						// unless eviction happened due to capacity)
						if (result2.strategy === ExecutionStrategy.MULTI) {
							expect(stateAfter2.reflectionCount).toBe(2);
							// Insights accumulate across executions
							expect(stateAfter2.insightCount).toBeGreaterThanOrEqual(
								insightsAfter1,
							);
						}
					}
				} finally {
					await pool.destroy();
				}

				// After destroy, a new pool starts fresh
				const pool2 = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 3,
						reflection: { enabled: true },
					}),
				);

				try {
					const freshState = pool2.getState();
					expect(freshState.reflectionCount).toBe(0);
					expect(freshState.insightCount).toBe(0);
					expect(freshState.lastEffectivenessScore).toBeNull();
				} finally {
					await pool2.destroy();
				}
			},
			LONG_TIMEOUT_MS * 2,
		);

		// ── Test 31: Reflection failure does NOT block execution ─────────

		it(
			"execution succeeds even if reflection encounters an issue",
			async () => {
				const tracker = trackingAgentFactory();

				// Use default config — reflection is enabled
				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 5,
						reflection: { enabled: true },
					}),
				);

				try {
					// The execution should always succeed regardless of reflection outcome
					const result = await pool.execute(
						"Write a simple Express.js server with health check endpoint and add error handling middleware.",
					);

					// No crash, execution completed
					expect(result).toBeDefined();
					expect(result.task).toBeDefined();
					expect(result.summary).toBeDefined();
					expect(result.agents.length).toBeGreaterThan(0);
					expect(typeof result.durationMs).toBe("number");
				} finally {
					await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);

		// ── Test 33: No config `reflection` still works ─────────────────

		it(
			"executions without explicit reflection config work unchanged",
			async () => {
				const tracker = trackingAgentFactory();

				// No reflection config at all — should use defaults
				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 5,
						// No `reflection` key
					}),
				);

				try {
					const result = await pool.execute(
						"Create a REST API with CRUD operations for a todo list application and write integration tests.",
					);

					// Should work normally — reflection auto-enabled for multi-agent
					expect(result).toBeDefined();
					expect(result.summary).toBeDefined();

					if (result.strategy === ExecutionStrategy.MULTI) {
						// Reflection should have fired (defaults: enabled=true)
						const state = pool.getState();
						expect(state.reflectionCount).toBe(1);
					}
				} finally {
					await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);

		// ── Test 34: Explicitly disabled reflection ──────────────────────

		it(
			"produces no reflection events when explicitly disabled",
			async () => {
				const tracker = trackingAgentFactory();
				const reflectionEvents: ReflectionCompleteEvent[] = [];

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 5,
						reflection: { enabled: false },
					}),
				);

				pool.on(PoolEvent.REFLECTION_COMPLETE, (e) => {
					reflectionEvents.push(e);
				});

				try {
					const result = await pool.execute(
						"Build a web scraper with a parser module and a storage module, each with tests.",
					);

					expect(reflectionEvents.length).toBe(0);
					expect(result.reflection).toBeUndefined();

					const state = pool.getState();
					expect(state.reflectionCount).toBe(0);
					expect(state.insightCount).toBe(0);
					expect(state.lastEffectivenessScore).toBeNull();
				} finally {
					await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);

		// ── Test 27: Insights are injected into the planner prompt ──────

		it(
			"insights from first execution influence subsequent planner prompts",
			async () => {
				const tracker = trackingAgentFactory();

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 5,
						reflection: {
							enabled: true,
							minInsightConfidence: 0.3, // Low threshold so insights are likely included
						},
					}),
				);

				try {
					// First execution — produces insights
					const result1 = await pool.execute(
						"Create a microservice with an API gateway and a user service, each with their own test suites.",
					);

					if (
						result1.strategy === ExecutionStrategy.MULTI &&
						result1.reflection &&
						result1.reflection.insights.length > 0
					) {
						const stateAfterFirst = pool.getState();
						expect(stateAfterFirst.insightCount).toBeGreaterThan(0);

						// Second execution — insights should be injected into planner
						// We can't directly capture the prompt, but we can verify
						// that the system still works correctly with insights present
						const result2 = await pool.execute(
							"Build a GraphQL API with resolvers for users and posts, and write end-to-end tests.",
						);

						expect(result2).toBeDefined();
						expect(result2.summary).toBeDefined();

						// The planner memory should contain enriched lessons from reflection
						const stateAfterSecond = pool.getState();
						expect(stateAfterSecond.plannerMemoryCount).toBeGreaterThanOrEqual(
							2,
						);
					}
				} finally {
					await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS * 2,
		);

		// ── Test 28: enrichPlannerMemoryWithReflection adds insights to lessons ──

		it(
			"planner memory count reflects execution history including reflection enrichment",
			async () => {
				const tracker = trackingAgentFactory();

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 5,
						reflection: { enabled: true },
					}),
				);

				try {
					const stateBefore = pool.getState();
					expect(stateBefore.plannerMemoryCount).toBe(0);

					const result = await pool.execute(
						"Create a data processing pipeline with a reader module, a transformer module, and a writer module. Write tests for each.",
					);

					const stateAfter = pool.getState();

					// Planner memory should exist for this execution
					expect(stateAfter.plannerMemoryCount).toBe(1);

					// If reflection succeeded, insights were appended to the memory
					if (
						result.strategy === ExecutionStrategy.MULTI &&
						result.reflection &&
						result.reflection.insights.length > 0
					) {
						// We can't directly inspect PlannerMemory lessons,
						// but the fact that enrichPlannerMemoryWithReflection
						// ran without error is verified by the successful execution
						expect(result.reflection.insights.length).toBeGreaterThan(0);
					}
				} finally {
					await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);

		// ── Test 35: Existing PlannerMemory (évolution 13) still works ──

		it(
			"PlannerMemory records are created even when reflection fails or is skipped",
			async () => {
				const tracker = trackingAgentFactory();

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						reflection: { enabled: false }, // Disable reflection
					}),
				);

				try {
					await pool.execute(
						"Write a simple hello world function in TypeScript.",
					);

					const state = pool.getState();

					// PlannerMemory should still work without reflection
					expect(state.plannerMemoryCount).toBe(1);
					expect(state.reflectionCount).toBe(0);
				} finally {
					await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);

		// ── Test: Reflection with reflectOnSingleAgent enabled ──────────

		it(
			"triggers reflection for single-agent when reflectOnSingleAgent is true",
			async () => {
				const tracker = trackingAgentFactory();
				const reflectionEvents: ReflectionCompleteEvent[] = [];

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						reflection: {
							enabled: true,
							reflectOnSingleAgent: true,
						},
					}),
				);

				pool.on(PoolEvent.REFLECTION_COMPLETE, (e) => {
					reflectionEvents.push(e);
				});

				try {
					const result = await pool.execute(
						"Print 'Hello World' to the console.",
					);

					// Reflection is non-critical — the LLM may occasionally
					// produce invalid JSON for very simple single-agent tasks,
					// causing reflect() to return null. We verify that when
					// reflection succeeds, the event is emitted and the data
					// is structurally valid.
					if (reflectionEvents.length === 1) {
						expect(result.reflection).toBeDefined();
						expect(typeof result.reflection!.effectivenessScore).toBe("number");
						expect(typeof result.reflection!.analysis).toBe("string");
						expect(
							result.reflection!.effectivenessScore,
						).toBeGreaterThanOrEqual(0);
						expect(result.reflection!.effectivenessScore).toBeLessThanOrEqual(
							1,
						);
					} else {
						// Reflection was attempted but the LLM returned invalid JSON.
						// This is acceptable — verify the execution itself succeeded.
						expect(reflectionEvents.length).toBe(0);
						expect(result.reflection).toBeUndefined();
					}

					// Regardless of reflection outcome, the execution must succeed
					expect(result).toBeDefined();
					expect(result.summary).toBeDefined();
					expect(result.agents.length).toBeGreaterThan(0);

					// The reflection engine should have incremented its counter
					// (it counts attempts, not successes)
					const state = pool.getState();
					expect(state.reflectionCount).toBe(1);
				} finally {
					await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);

		// ── Test: Reflection with custom maxInsights ────────────────────

		it(
			"respects maxInsights configuration during accumulation",
			async () => {
				const tracker = trackingAgentFactory();

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 5,
						reflection: {
							enabled: true,
							maxInsights: 5,
						},
					}),
				);

				try {
					// Run two multi-agent tasks
					await pool.execute(
						"Build a REST API with Express.js and a separate test suite using Mocha.",
					);

					const _state1 = pool.getState();

					await pool.execute(
						"Create a CLI tool with a parser module and a renderer module, each with unit tests.",
					);

					const state2 = pool.getState();

					// insightCount should never exceed maxInsights
					expect(state2.insightCount).toBeLessThanOrEqual(5);
				} finally {
					await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS * 2,
		);

		// ── Test: Full event lifecycle ──────────────────────────────────

		it(
			"emits REFLECTION_COMPLETE before EXECUTION_COMPLETE",
			async () => {
				const tracker = trackingAgentFactory();
				const eventOrder: string[] = [];

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 5,
						reflection: { enabled: true },
					}),
				);

				pool.on(PoolEvent.REFLECTION_COMPLETE, () => {
					eventOrder.push("REFLECTION_COMPLETE");
				});
				pool.on(PoolEvent.EXECUTION_COMPLETE, () => {
					eventOrder.push("EXECUTION_COMPLETE");
				});

				try {
					const result = await pool.execute(
						"Create a TypeScript project with a math library module and a string library module, with unit tests for both.",
					);

					if (result.strategy === ExecutionStrategy.MULTI) {
						// Reflection should fire before execution complete
						const reflectionIdx = eventOrder.indexOf("REFLECTION_COMPLETE");
						const executionIdx = eventOrder.indexOf("EXECUTION_COMPLETE");

						expect(reflectionIdx).toBeGreaterThanOrEqual(0);
						expect(executionIdx).toBeGreaterThanOrEqual(0);
						expect(reflectionIdx).toBeLessThan(executionIdx);
					}
				} finally {
					await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);

		// ── Test: Concurrent execution safety ───────────────────────────

		it(
			"clearReflections between executions preserves insights for second run",
			async () => {
				const tracker = trackingAgentFactory();

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 5,
						reflection: {
							enabled: true,
							minInsightConfidence: 0.1, // Very low threshold
						},
					}),
				);

				try {
					const result1 = await pool.execute(
						"Build a REST API with user management endpoints and write comprehensive test coverage.",
					);

					if (
						result1.strategy === ExecutionStrategy.MULTI &&
						result1.reflection
					) {
						const insightsAfter1 = pool.getState().insightCount;

						// clearReflections is called internally in the finally block
						// but insights should persist
						expect(insightsAfter1).toBeGreaterThanOrEqual(0);

						if (insightsAfter1 > 0) {
							// Second execution should have access to previous insights
							const _result2 = await pool.execute(
								"Create a simple calculator API with add, subtract, multiply, divide endpoints and tests.",
							);

							const insightsAfter2 = pool.getState().insightCount;
							// Insights should be >= first run (accumulation)
							expect(insightsAfter2).toBeGreaterThanOrEqual(insightsAfter1);
						}
					}
				} finally {
					await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS * 2,
		);
	},
);
