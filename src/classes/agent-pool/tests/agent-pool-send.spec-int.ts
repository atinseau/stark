import { describe, expect, it } from "bun:test";
import { PoolEvent } from "../../../enums/pool-event.enum.ts";
import { AgentPool } from "../agent-pool.ts";
import { collectPoolEvents } from "./test-helpers.ts";
import {
	HAS_API_KEY,
	INT_TIMEOUT_MS,
	intPoolConfig,
	isPoolResult,
	trackingAgentFactory,
} from "./test-helpers-int.ts";

// ════════════════════════════════════════════════════════════════════════════
// AgentPool — Send, Intent Routing, Events & Pipeline Integration Tests
//
// send() message routing, event-driven monitoring, and full pipeline
// integration (execute → query → modify → re-execute).
// ════════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_API_KEY)("AgentPool int — send & pipeline", () => {
	// ── Send Message & Intent Routing ───────────────────────────────────

	describe("send message and intent routing", () => {
		it.concurrent(
			"send with a task description triggers execution and returns a result",
			async () => {
				const tracker = trackingAgentFactory();
				const pool = new AgentPool(
					intPoolConfig({ createAgent: tracker.factory }),
				);

				try {
					const result = await pool.send(
						"Please create a utility function that formats dates in ISO format",
					);

					// The LLM should classify this as new_task and return an AgentPoolResult.
					// In rare cases it may return a string — both are acceptable from the
					// intent routing pipeline.
					expect(result).toBeDefined();

					if (isPoolResult(result)) {
						expect(result.task).toBeDefined();
						expect(result.strategy).toBeDefined();
						expect(result.agents.length).toBeGreaterThanOrEqual(1);
						expect(result.summary.length).toBeGreaterThan(0);

						// Agents should have been spawned and executed
						expect(tracker.agents.length).toBeGreaterThanOrEqual(1);
						expect(tracker.promptCalls.length).toBeGreaterThanOrEqual(1);
					} else {
						// Still a valid routing outcome — the pool processed the message
						expect(typeof result).toBe("string");
						expect((result as string).length).toBeGreaterThan(0);
					}
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			INT_TIMEOUT_MS,
		);

		it.concurrent("setNotificationPreference directly enables notifications (deterministic)", () => {
			const tracker = trackingAgentFactory();
			const pool = new AgentPool(
				intPoolConfig({ createAgent: tracker.factory }),
			);

			expect(pool.getState().notificationsEnabled).toBe(false);

			pool.setNotificationPreference({
				enabled: true,
				minSignificance: 0.6,
			});

			expect(pool.getState().notificationsEnabled).toBe(true);
		});

		it.concurrent(
			"send routes messages through the intent analysis pipeline",
			async () => {
				const tracker = trackingAgentFactory();
				const pool = new AgentPool(
					intPoolConfig({ createAgent: tracker.factory }),
				);

				try {
					// Send a notification preference message via the LLM pipeline
					const response = await pool.send(
						"Enable notifications. Notify me of all important changes.",
					);

					// The intent analyzer may classify this as notification_preference
					// or as a new_task — both are valid pipeline outcomes.
					expect(response).toBeDefined();

					// Regardless of classification, the pool should not have thrown
					if (
						typeof response === "string" &&
						response.toLowerCase().includes("notif")
					) {
						expect(pool.getState().notificationsEnabled).toBe(true);
					}
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			INT_TIMEOUT_MS,
		);

		it.concurrent(
			"send with cancel-like message when idle returns a response",
			async () => {
				const tracker = trackingAgentFactory();
				const pool = new AgentPool(
					intPoolConfig({ createAgent: tracker.factory }),
				);

				try {
					const response = await pool.send(
						"Cancel everything, stop all agents",
					);

					// Whether classified as cancel, unknown, or even new_task,
					// the pool must return a valid response without throwing.
					expect(response).toBeDefined();

					if (typeof response === "string") {
						expect(response.length).toBeGreaterThan(0);
					} else {
						expect(isPoolResult(response)).toBe(true);
					}
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			INT_TIMEOUT_MS,
		);
	});

	// ── Event-Driven Monitoring ─────────────────────────────────────────

	describe("event-driven monitoring", () => {
		it.concurrent(
			"emits a full lifecycle event sequence during execution",
			async () => {
				const tracker = trackingAgentFactory();
				const pool = new AgentPool(
					intPoolConfig({ createAgent: tracker.factory }),
				);

				try {
					const eventLog: string[] = [];

					pool.on(PoolEvent.TASK_RECEIVED, () =>
						eventLog.push("task_received"),
					);
					pool.on(PoolEvent.PLANNING_START, () =>
						eventLog.push("planning_start"),
					);
					pool.on(PoolEvent.PLANNING_COMPLETE, () =>
						eventLog.push("planning_complete"),
					);
					pool.on(PoolEvent.AGENT_SPAWNED, () =>
						eventLog.push("agent_spawned"),
					);
					pool.on(PoolEvent.AGENT_COMPLETED, () =>
						eventLog.push("agent_completed"),
					);
					pool.on(PoolEvent.EXECUTION_COMPLETE, () =>
						eventLog.push("execution_complete"),
					);
					pool.on(PoolEvent.DELTA_DETECTED, () =>
						eventLog.push("delta_detected"),
					);

					await pool.execute("Write a function that adds two numbers");

					// Verify the canonical event ordering
					expect(eventLog.indexOf("task_received")).toBe(0);
					expect(eventLog.indexOf("planning_start")).toBe(1);
					expect(eventLog.indexOf("planning_complete")).toBe(2);
					expect(eventLog.indexOf("agent_spawned")).toBeGreaterThan(2);

					// Completed and execution_complete should come after spawned
					const spawnedIdx = eventLog.indexOf("agent_spawned");
					const completedIdx = eventLog.indexOf("agent_completed");
					const executionCompleteIdx = eventLog.indexOf("execution_complete");

					expect(completedIdx).toBeGreaterThan(spawnedIdx);
					expect(executionCompleteIdx).toBeGreaterThan(completedIdx);

					// Delta events should have been fired (from mock agent events)
					expect(
						eventLog.filter((e) => e === "delta_detected").length,
					).toBeGreaterThanOrEqual(1);
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			INT_TIMEOUT_MS,
		);

		it.concurrent(
			"all pool events include timestamp and event type",
			async () => {
				const tracker = trackingAgentFactory();
				const pool = new AgentPool(
					intPoolConfig({ createAgent: tracker.factory }),
				);

				try {
					const allEvents: Array<{ event: string; timestamp: string }> = [];

					for (const eventType of Object.values(PoolEvent)) {
						pool.on(eventType, ((payload: any) => {
							allEvents.push({
								event: payload.event,
								timestamp: payload.timestamp,
							});
						}) as any);
					}

					await pool.execute("Create a config file");

					expect(allEvents.length).toBeGreaterThan(0);

					for (const evt of allEvents) {
						expect(evt.event).toBeDefined();
						expect(typeof evt.event).toBe("string");
						expect(evt.timestamp).toBeDefined();
						expect(typeof evt.timestamp).toBe("string");
						// Timestamp should be ISO 8601
						expect(new Date(evt.timestamp).toISOString()).toBeTruthy();
					}
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			INT_TIMEOUT_MS,
		);
	});

	// ── Full Pipeline Integration ───────────────────────────────────────

	describe("full pipeline integration", () => {
		it.concurrent(
			"executes a task, queries status, modifies preferences, then executes another task",
			async () => {
				const tracker = trackingAgentFactory();
				const pool = new AgentPool(
					intPoolConfig({ createAgent: tracker.factory }),
				);

				try {
					// ── Step 1: Execute initial task ─────────────────────────
					const result1 = await pool.execute(
						"Create a utility module for string manipulation",
					);

					expect(result1).toBeDefined();
					expect(result1.agents.every((a) => a.success)).toBe(true);

					// ── Step 2: Query status (should be idle) ────────────────
					const stateAfterFirst = pool.getState();
					expect(stateAfterFirst.executing).toBe(false);
					expect(stateAfterFirst.activeAgentCount).toBe(0);

					// ── Step 3: Modify notification preference ───────────────
					pool.setNotificationPreference({
						enabled: true,
						minSignificance: 0.5,
					});
					expect(pool.getState().notificationsEnabled).toBe(true);

					// ── Step 4: Execute a follow-up task with notifications on ──
					const deltaEvents = collectPoolEvents(pool, PoolEvent.DELTA_DETECTED);

					const result2 = await pool.execute(
						"Add unit tests for the string manipulation module",
					);

					expect(result2).toBeDefined();
					expect(result2.agents.every((a) => a.success)).toBe(true);

					// Deltas should have been tracked
					expect(deltaEvents.length).toBeGreaterThanOrEqual(1);

					// ── Step 5: Verify the pool is reusable ──────────────────
					const finalState = pool.getState();
					expect(finalState.executing).toBe(false);
					expect(finalState.notificationsEnabled).toBe(true);

					// Total agents spawned should be >= 2 (at least 1 per task)
					expect(tracker.agents.length).toBeGreaterThanOrEqual(2);
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			INT_TIMEOUT_MS * 2,
		);

		it.concurrent(
			"uses send() to drive a multi-step workflow with mixed intents",
			async () => {
				const tracker = trackingAgentFactory();
				const pool = new AgentPool(
					intPoolConfig({ createAgent: tracker.factory }),
				);

				try {
					// ── Step 1: Send a task via send() ───────────────────────
					const taskResult = await pool.send("Create a simple logging utility");

					// The LLM may classify this as new_task (AgentPoolResult) or
					// route it differently (string). Both are valid.
					expect(taskResult).toBeDefined();
					if (isPoolResult(taskResult)) {
						expect(taskResult.agents.length).toBeGreaterThanOrEqual(1);
					}

					// ── Step 2: Query status via send() ──────────────────────
					const statusResponse = await pool.send("status");

					// May return a string (status_query) or AgentPoolResult (new_task)
					expect(statusResponse).toBeDefined();

					// ── Step 3: Enable notifications directly (deterministic) ─
					pool.setNotificationPreference({
						enabled: true,
						minSignificance: 0.5,
					});
					expect(pool.getState().notificationsEnabled).toBe(true);

					// ── Step 4: Destroy and verify ───────────────────────────
					await pool.destroy();

					await expect(
						pool.send("This should fail after destroy"),
					).rejects.toThrow(/destroyed/);
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			INT_TIMEOUT_MS * 2,
		);
	});
});
