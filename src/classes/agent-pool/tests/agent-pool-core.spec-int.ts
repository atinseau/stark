import { describe, expect, it } from "bun:test";
import { PoolEvent } from "../../../enums/pool-event.enum.ts";
import type { AgentPoolState } from "../../../types/agent-pool.types.ts";
import { AgentPool } from "../agent-pool.ts";
import {
	collectPoolEvents,
	createMockAgent,
	createMockAgentFactory,
	silentPoolConfig,
} from "./test-helpers.ts";
import {
	HAS_API_KEY,
	INT_TIMEOUT_MS,
	intPoolConfig,
	isPoolResult,
	trackingAgentFactory,
} from "./test-helpers-int.ts";

// ════════════════════════════════════════════════════════════════════════════
// AgentPool — Core Integration Tests
//
// Construction, state management, destroy, event system, single-agent
// execution, status querying, and error handling.
// ════════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_API_KEY)("AgentPool int — core", () => {
	// ── Construction ────────────────────────────────────────────────────

	describe("construction", () => {
		it.concurrent("creates a pool with default configuration", async () => {
			const pool = new AgentPool(
				silentPoolConfig({
					createAgent: createMockAgentFactory(),
				}),
			);

			const { EventEmitter } = await import("node:events");
			expect(pool).toBeInstanceOf(EventEmitter);
			expect(pool.getState().executing).toBe(false);
			expect(pool.getState().currentTask).toBeNull();
			expect(pool.getState().strategy).toBeNull();
			expect(pool.getState().activeAgentCount).toBe(0);
			expect(pool.getState().notificationsEnabled).toBe(false);
		});
	});

	// ── State Management ────────────────────────────────────────────────

	describe("state management", () => {
		it.concurrent("getState returns correct idle state", () => {
			const pool = new AgentPool(
				silentPoolConfig({
					createAgent: createMockAgentFactory(),
				}),
			);

			const state = pool.getState();

			expect(state.executing).toBe(false);
			expect(state.currentTask).toBeNull();
			expect(state.strategy).toBeNull();
			expect(state.activeAgentCount).toBe(0);
			expect(state.agents).toEqual([]);
			expect(state.notificationsEnabled).toBe(false);
			expect(state.deltaCount).toBe(0);
			expect(state.sharingDecisionCount).toBe(0);
		});

		it.concurrent("setNotificationPreference updates notification state", () => {
			const pool = new AgentPool(
				silentPoolConfig({
					createAgent: createMockAgentFactory(),
				}),
			);

			expect(pool.getState().notificationsEnabled).toBe(false);

			pool.setNotificationPreference({
				enabled: true,
				minSignificance: 0.7,
			});

			expect(pool.getState().notificationsEnabled).toBe(true);
		});
	});

	// ── Destroy ─────────────────────────────────────────────────────────

	describe("destroy", () => {
		it.concurrent("transitions to destroyed state", async () => {
			const pool = new AgentPool(
				silentPoolConfig({
					createAgent: createMockAgentFactory(),
				}),
			);

			const events = collectPoolEvents(pool, PoolEvent.DESTROYED);

			await pool.destroy();

			expect(events.length).toBe(1);
		});

		it.concurrent("is idempotent — calling destroy() twice is safe", async () => {
			const pool = new AgentPool(
				silentPoolConfig({
					createAgent: createMockAgentFactory(),
				}),
			);

			await pool.destroy();
			await pool.destroy(); // Should not throw
		});

		it.concurrent("execute throws after destroy", async () => {
			const pool = new AgentPool(
				silentPoolConfig({
					createAgent: createMockAgentFactory(),
				}),
			);

			await pool.destroy();

			await expect(pool.execute("This should fail")).rejects.toThrow(
				/destroyed/,
			);
		});

		it.concurrent("send throws after destroy", async () => {
			const pool = new AgentPool(
				silentPoolConfig({
					createAgent: createMockAgentFactory(),
				}),
			);

			await pool.destroy();

			await expect(pool.send("This should also fail")).rejects.toThrow(
				/destroyed/,
			);
		});
	});

	// ── Event System ────────────────────────────────────────────────────

	describe("event system", () => {
		it.concurrent("supports on/off/once with typed events", async () => {
			const pool = new AgentPool(
				silentPoolConfig({
					createAgent: createMockAgentFactory(),
				}),
			);

			const destroyedEvents = collectPoolEvents(pool, PoolEvent.DESTROYED);
			const listener = () => {};
			pool.on(PoolEvent.TASK_RECEIVED, listener);
			pool.off(PoolEvent.TASK_RECEIVED, listener);

			await pool.destroy();
			expect(destroyedEvents.length).toBe(1);
		});

		it.concurrent("once listener fires only once", async () => {
			const pool = new AgentPool(
				silentPoolConfig({
					createAgent: createMockAgentFactory(),
				}),
			);

			let callCount = 0;
			pool.once(PoolEvent.DESTROYED, () => {
				callCount++;
			});

			await pool.destroy();
			// Emit a fake event to verify the listener was removed
			pool.emit(PoolEvent.DESTROYED, {
				event: PoolEvent.DESTROYED,
				timestamp: new Date().toISOString(),
			});

			expect(callCount).toBe(1);
		});

		it.concurrent("off removes listeners", async () => {
			const pool = new AgentPool(
				silentPoolConfig({
					createAgent: createMockAgentFactory(),
				}),
			);

			let callCount = 0;
			const listener = () => {
				callCount++;
			};

			pool.on(PoolEvent.DESTROYED, listener);
			pool.off(PoolEvent.DESTROYED, listener);

			await pool.destroy();
			expect(callCount).toBe(0);
		});
	});

	// ── Single Agent Execution ──────────────────────────────────────────

	describe("single agent execution", () => {
		it.concurrent(
			"spawns a single agent and completes a simple task",
			async () => {
				const tracker = trackingAgentFactory();

				const pool = new AgentPool(
					intPoolConfig({ createAgent: tracker.factory }),
				);

				try {
					const result = await pool.execute(
						"Create a file called hello.txt with the content 'Hello World'",
					);

					// ── Strategy validation ──────────────────────────────────
					expect(result).toBeDefined();
					expect(result.task).toContain("hello.txt");
					expect(result.strategy).toBeDefined();
					expect(["single", "multi"]).toContain(result.strategy);

					// ── Analysis was produced by the LLM planner ─────────────
					expect(result.analysis).toBeDefined();
					expect(result.analysis.reasoning.length).toBeGreaterThan(10);
					expect(result.analysis.subtasks.length).toBeGreaterThanOrEqual(1);
					expect(result.analysis.complexity).toBeDefined();

					// ── At least one agent was spawned and completed ──────────
					expect(tracker.agents.length).toBeGreaterThanOrEqual(1);
					expect(result.agents.length).toBeGreaterThanOrEqual(1);

					const firstAgent = result.agents[0]!;
					expect(firstAgent.success).toBe(true);
					expect(firstAgent.agentName).toBeDefined();
					expect(firstAgent.promptResult.text.length).toBeGreaterThan(0);

					// ── Summary was generated by the LLM ─────────────────────
					expect(result.summary.length).toBeGreaterThan(10);

					// ── Duration is tracked ──────────────────────────────────
					expect(result.durationMs).toBeGreaterThan(0);

					// ── All agents received prompts ──────────────────────────
					expect(tracker.promptCalls.length).toBeGreaterThanOrEqual(1);
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			INT_TIMEOUT_MS,
		);

		it.concurrent(
			"emits lifecycle events during single-agent execution",
			async () => {
				const tracker = trackingAgentFactory();

				const pool = new AgentPool(
					intPoolConfig({ createAgent: tracker.factory }),
				);

				try {
					const taskReceivedEvents = collectPoolEvents(
						pool,
						PoolEvent.TASK_RECEIVED,
					);
					const planningStartEvents = collectPoolEvents(
						pool,
						PoolEvent.PLANNING_START,
					);
					const planningCompleteEvents = collectPoolEvents(
						pool,
						PoolEvent.PLANNING_COMPLETE,
					);
					const agentSpawnedEvents = collectPoolEvents(
						pool,
						PoolEvent.AGENT_SPAWNED,
					);
					const agentCompletedEvents = collectPoolEvents(
						pool,
						PoolEvent.AGENT_COMPLETED,
					);
					const executionCompleteEvents = collectPoolEvents(
						pool,
						PoolEvent.EXECUTION_COMPLETE,
					);

					await pool.execute("Fix a typo in the README file");

					expect(taskReceivedEvents.length).toBe(1);
					expect(planningStartEvents.length).toBe(1);
					expect(planningCompleteEvents.length).toBe(1);
					expect(agentSpawnedEvents.length).toBeGreaterThanOrEqual(1);
					expect(agentCompletedEvents.length).toBeGreaterThanOrEqual(1);
					expect(executionCompleteEvents.length).toBe(1);
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			INT_TIMEOUT_MS,
		);
	});

	// ── Status Querying ─────────────────────────────────────────────────

	describe("status querying", () => {
		it.concurrent("getState reflects idle state before execution", () => {
			const tracker = trackingAgentFactory();
			const pool = new AgentPool(
				intPoolConfig({ createAgent: tracker.factory }),
			);

			const state = pool.getState();

			expect(state.executing).toBe(false);
			expect(state.currentTask).toBeNull();
			expect(state.strategy).toBeNull();
			expect(state.activeAgentCount).toBe(0);
			expect(state.agents).toEqual([]);
			expect(state.notificationsEnabled).toBe(false);
			expect(state.deltaCount).toBe(0);
			expect(state.sharingDecisionCount).toBe(0);
		});

		it.concurrent(
			"getState reflects executing state during task execution",
			async () => {
				const stateSnapshots: AgentPoolState[] = [];

				// Use a delay so we can capture state mid-execution
				const tracker = trackingAgentFactory({ promptDelay: 200 });

				const pool = new AgentPool(
					intPoolConfig({ createAgent: tracker.factory }),
				);

				try {
					// Capture state when agents are spawned (they'll be executing)
					pool.on(PoolEvent.AGENT_SPAWNED, () => {
						stateSnapshots.push(pool.getState());
					});

					await pool.execute("Write a simple greeting function in TypeScript");

					// We should have captured at least one state snapshot during execution
					expect(stateSnapshots.length).toBeGreaterThanOrEqual(1);

					const midExecutionState = stateSnapshots[0]!;
					expect(midExecutionState.executing).toBe(true);
					expect(midExecutionState.currentTask).toContain("greeting");
					expect(midExecutionState.strategy).toBeDefined();
					expect(midExecutionState.activeAgentCount).toBeGreaterThanOrEqual(1);
					expect(midExecutionState.agents.length).toBeGreaterThanOrEqual(1);

					// After execution, state should be back to idle
					const finalState = pool.getState();
					expect(finalState.executing).toBe(false);
					expect(finalState.currentTask).toBeNull();
					expect(finalState.activeAgentCount).toBe(0);
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			INT_TIMEOUT_MS,
		);

		it.concurrent(
			"send with status_query intent returns a response (string or result)",
			async () => {
				const tracker = trackingAgentFactory();
				const pool = new AgentPool(
					intPoolConfig({ createAgent: tracker.factory }),
				);

				try {
					// The LLM intent analyzer may classify this as status_query or new_task.
					// Both are valid outcomes — we just verify the pool processes it without error.
					const response = await pool.send("status");

					expect(response).toBeDefined();

					if (typeof response === "string") {
						// Classified as status_query — should mention idle or no task
						expect(response.length).toBeGreaterThan(0);
					} else {
						// Classified as new_task — should return a valid result
						expect(isPoolResult(response)).toBe(true);
					}
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			INT_TIMEOUT_MS,
		);

		it.concurrent("getState provides accurate status information directly (no LLM)", () => {
			const tracker = trackingAgentFactory();
			const pool = new AgentPool(
				intPoolConfig({ createAgent: tracker.factory }),
			);

			const state = pool.getState();

			// Direct API call — no LLM involved, fully deterministic
			expect(state.executing).toBe(false);
			expect(state.currentTask).toBeNull();
			expect(state.activeAgentCount).toBe(0);
			expect(state.agents).toEqual([]);
		});
	});

	// ── Error Handling ──────────────────────────────────────────────────

	describe("error handling", () => {
		it.concurrent(
			"handles agent prompt failures gracefully",
			async () => {
				const factory = (config?: { name?: string }) => {
					return createMockAgent({
						name: config?.name ?? "FailingAgent",
						promptError: new Error("Simulated prompt failure"),
					});
				};

				const pool = new AgentPool(intPoolConfig({ createAgent: factory }));

				try {
					const errorEvents = collectPoolEvents(pool, PoolEvent.AGENT_ERROR);

					const result = await pool.execute("Do a simple task that will fail");

					// Execution should complete (not throw) even with agent failures
					expect(result).toBeDefined();
					expect(result.agents.length).toBeGreaterThanOrEqual(1);

					// At least one agent should have failed
					const failedAgents = result.agents.filter((a) => !a.success);
					expect(failedAgents.length).toBeGreaterThanOrEqual(1);
					expect(failedAgents[0]!.error).toContain("Simulated prompt failure");

					// Error events should have been emitted
					expect(errorEvents.length).toBeGreaterThanOrEqual(1);
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			INT_TIMEOUT_MS,
		);

		it.concurrent(
			"handles agent initialization failures gracefully",
			async () => {
				const factory = (config?: { name?: string }) => {
					return createMockAgent({
						name: config?.name ?? "FailInitAgent",
						readyError: new Error("Simulated init failure"),
					});
				};

				const pool = new AgentPool(intPoolConfig({ createAgent: factory }));

				try {
					const result = await pool.execute(
						"Do a task where the agent fails to initialize",
					);

					// Execution should complete without throwing
					expect(result).toBeDefined();

					// Agents should have failed with init errors
					const failedAgents = result.agents.filter((a) => !a.success);
					expect(failedAgents.length).toBeGreaterThanOrEqual(1);
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			INT_TIMEOUT_MS,
		);

		it.concurrent("throws when calling execute after destroy", async () => {
			const tracker = trackingAgentFactory();
			const pool = new AgentPool(
				intPoolConfig({ createAgent: tracker.factory }),
			);

			await pool.destroy();

			await expect(pool.execute("This should fail")).rejects.toThrow(
				/destroyed/,
			);
		});

		it.concurrent("throws when calling send after destroy", async () => {
			const tracker = trackingAgentFactory();
			const pool = new AgentPool(
				intPoolConfig({ createAgent: tracker.factory }),
			);

			await pool.destroy();

			await expect(pool.send("This should also fail")).rejects.toThrow(
				/destroyed/,
			);
		});
	});

	// ── Notification Preferences ────────────────────────────────────────

	describe("notification preferences", () => {
		it.concurrent(
			"setNotificationPreference enables notifications and execution tracks deltas",
			async () => {
				const tracker = trackingAgentFactory();
				const pool = new AgentPool(
					intPoolConfig({ createAgent: tracker.factory }),
				);

				try {
					// Enable notifications before execution
					pool.setNotificationPreference({
						enabled: true,
						minSignificance: 0.3,
					});

					expect(pool.getState().notificationsEnabled).toBe(true);

					const deltaEvents = collectPoolEvents(pool, PoolEvent.DELTA_DETECTED);

					const result = await pool.execute(
						"Create a simple hello world script",
					);

					expect(result).toBeDefined();
					expect(result.agents.length).toBeGreaterThanOrEqual(1);

					// Deltas should have been detected from agent activity
					// (mock agents emit AGENT_BUSY, PROMPT_COMPLETE, AGENT_IDLE events)
					expect(deltaEvents.length).toBeGreaterThanOrEqual(1);
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			INT_TIMEOUT_MS,
		);
	});
});
