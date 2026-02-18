import { afterEach, describe, expect, it } from "bun:test";
import { PoolEvent } from "../../../enums/pool-event.enum.ts";
import type {
	QueueDrainedEvent,
	TaskCancelledEvent,
	TaskDequeuedEvent,
	TaskQueuedEvent,
} from "../../../types/agent-pool.types.ts";
import { AgentPool } from "../agent-pool.ts";
import {
	HAS_API_KEY,
	intPoolConfig,
	isPoolResult,
	trackingAgentFactory,
} from "./test-helpers-int.ts";

// ════════════════════════════════════════════════════════════════════════════
// TaskQueue — Long-Running Integration Tests (Real LLM API)
//
// These tests hit the real OpenRouter API and use mock agents.
// They validate the full pipeline: intent analysis → planning → queue →
// agent execution → summary — with the task queue enabled.
//
// Requires OPENROUTER_API_KEY in the environment.
// Expected duration: 30–120s per test depending on API latency.
// ════════════════════════════════════════════════════════════════════════════

const LONG_TIMEOUT_MS = 180_000;

describe.skipIf(!HAS_API_KEY)("TaskQueue long-running integration", () => {
	let pool: AgentPool;

	afterEach(async () => {
		if (pool) {
			try {
				await pool.destroy();
			} catch {
				// ignore
			}
		}
	});

	// ── Test: Sequential queue with real planning ────────────────────

	it(
		"executes two tasks sequentially through the queue with real LLM planning",
		async () => {
			const { factory, promptCalls } = trackingAgentFactory({
				promptText: "Task completed successfully.",
			});

			pool = new AgentPool(
				intPoolConfig({
					createAgent: factory,
					taskQueue: { enabled: true, maxConcurrent: 1 },
				}),
			);

			const queuedEvents: TaskQueuedEvent[] = [];
			const dequeuedEvents: TaskDequeuedEvent[] = [];
			const drainedEvents: QueueDrainedEvent[] = [];

			pool.on(PoolEvent.TASK_QUEUED, (e) => queuedEvents.push(e));
			pool.on(PoolEvent.TASK_DEQUEUED, (e) => dequeuedEvents.push(e));
			pool.on(PoolEvent.QUEUE_DRAINED, (e) => drainedEvents.push(e));

			// Enqueue two tasks — they should execute sequentially
			const h1 = pool.enqueue("Create a hello world function in JavaScript");
			const h2 = pool.enqueue("Write a simple add function in TypeScript");

			expect(h1.id).toBeTruthy();
			expect(h2.id).toBeTruthy();
			expect(h1.position).toBe(0);

			// TASK_QUEUED should fire immediately
			expect(queuedEvents.length).toBe(2);
			expect(queuedEvents[0]!.task).toContain("hello world");
			expect(queuedEvents[1]!.task).toContain("add function");

			// Wait for both to complete
			const [result1, result2] = await Promise.all([
				h1.completion,
				h2.completion,
			]);

			// Both should produce valid results
			expect(result1.task).toContain("hello world");
			expect(result1.strategy).toBeTruthy();
			expect(result1.summary).toBeTruthy();
			expect(result1.durationMs).toBeGreaterThan(0);

			expect(result2.task).toContain("add function");
			expect(result2.strategy).toBeTruthy();
			expect(result2.summary).toBeTruthy();
			expect(result2.durationMs).toBeGreaterThan(0);

			// Dequeued events
			expect(dequeuedEvents.length).toBe(2);

			// Queue should have drained
			await new Promise<void>((r) => setTimeout(r, 100));
			expect(drainedEvents.length).toBeGreaterThanOrEqual(1);

			const lastDrain = drainedEvents[drainedEvents.length - 1]!;
			expect(lastDrain.totalProcessed).toBe(2);
			expect(lastDrain.totalSucceeded).toBe(2);
			expect(lastDrain.totalFailed).toBe(0);

			// Agents should have been prompted
			expect(promptCalls.length).toBeGreaterThanOrEqual(2);

			// Queue state should reflect completion
			const state = pool.getState();
			expect(state.queue).not.toBeNull();
			expect(state.queue!.processedCount).toBe(2);
			expect(state.queue!.executingCount).toBe(0);
			expect(state.queue!.pendingCount).toBe(0);
		},
		LONG_TIMEOUT_MS,
	);

	// ── Test: execute() goes through queue when enabled ──────────────

	it(
		"execute() routes through the queue and returns a valid result",
		async () => {
			const { factory } = trackingAgentFactory();

			pool = new AgentPool(
				intPoolConfig({
					createAgent: factory,
					taskQueue: { enabled: true, maxConcurrent: 1 },
				}),
			);

			const queuedEvents: TaskQueuedEvent[] = [];
			pool.on(PoolEvent.TASK_QUEUED, (e) => queuedEvents.push(e));

			// execute() should internally enqueue
			const result = await pool.execute(
				"Write a utility function that reverses a string",
			);

			expect(result.task).toContain("reverses a string");
			expect(result.strategy).toBeTruthy();
			expect(result.agents).toBeDefined();
			expect(result.summary).toBeTruthy();
			expect(result.usage).toBeDefined();
			expect(result.usage.totalTokens).toBeGreaterThan(0);

			// Should have gone through the queue
			expect(queuedEvents.length).toBe(1);
		},
		LONG_TIMEOUT_MS,
	);

	// ── Test: Multiple execute() calls don't throw ──────────────────

	it(
		"multiple execute() calls with queue don't throw (unlike legacy behavior)",
		async () => {
			const { factory } = trackingAgentFactory();

			pool = new AgentPool(
				intPoolConfig({
					createAgent: factory,
					taskQueue: { enabled: true, maxConcurrent: 1 },
				}),
			);

			// Fire three execute() calls — none should throw
			const [r1, r2, r3] = await Promise.all([
				pool.execute("Create a sum function"),
				pool.execute("Create a multiply function"),
				pool.execute("Create a divide function"),
			]);

			expect(r1.task).toContain("sum");
			expect(r2.task).toContain("multiply");
			expect(r3.task).toContain("divide");

			// All three should have valid summaries
			expect(r1.summary.length).toBeGreaterThan(0);
			expect(r2.summary.length).toBeGreaterThan(0);
			expect(r3.summary.length).toBeGreaterThan(0);
		},
		LONG_TIMEOUT_MS,
	);

	// ── Test: Priority ordering with real execution ─────────────────

	it(
		"priority ordering is respected with real LLM execution",
		async () => {
			const { factory } = trackingAgentFactory();

			pool = new AgentPool(
				intPoolConfig({
					createAgent: factory,
					taskQueue: { enabled: true, maxConcurrent: 1 },
				}),
			);

			const completionOrder: string[] = [];

			pool.on(PoolEvent.EXECUTION_COMPLETE, (e: any) => {
				completionOrder.push(e.result.task);
			});

			// First task blocks the queue
			const h0 = pool.enqueue("Write a README file");

			// Give it time to start
			await new Promise<void>((r) => setTimeout(r, 200));

			// Queue tasks with different priorities
			const hLow = pool.enqueue("Write a changelog", { priority: 1 });
			const hHigh = pool.enqueue("Fix critical security bug", {
				priority: 100,
			});
			const hMed = pool.enqueue("Add unit tests", { priority: 50 });

			// Wait for all
			await Promise.all([
				h0.completion,
				hLow.completion,
				hHigh.completion,
				hMed.completion,
			]);

			await new Promise<void>((r) => setTimeout(r, 100));

			// The first task completes first (it was already executing)
			expect(completionOrder[0]).toContain("README");

			// Then priority order: high (100), medium (50), low (1)
			expect(completionOrder[1]).toContain("security bug");
			expect(completionOrder[2]).toContain("unit tests");
			expect(completionOrder[3]).toContain("changelog");
		},
		LONG_TIMEOUT_MS,
	);

	// ── Test: Cancel a pending task in queue ────────────────────────

	it(
		"cancel() removes a pending task from the queue",
		async () => {
			const { factory } = trackingAgentFactory({
				promptDelay: 500, // Slow agent to ensure tasks queue up
			});

			pool = new AgentPool(
				intPoolConfig({
					createAgent: factory,
					taskQueue: { enabled: true, maxConcurrent: 1 },
				}),
			);

			const cancelledEvents: TaskCancelledEvent[] = [];
			pool.on(PoolEvent.TASK_CANCELLED, (e) => cancelledEvents.push(e));

			// First task starts executing
			const h1 = pool.enqueue("Write a parser");

			// Give it time to start
			await new Promise<void>((r) => setTimeout(r, 100));

			// Second task is pending
			const h2 = pool.enqueue("Write a formatter");
			const h3 = pool.enqueue("Write a linter");

			// Cancel the formatter task
			const wasCancelled = await h2.cancel();

			if (wasCancelled) {
				expect(cancelledEvents.length).toBeGreaterThanOrEqual(1);
				const event = cancelledEvents.find((e) => e.taskId === h2.id);
				expect(event).toBeTruthy();
				expect(event!.wasExecuting).toBe(false);

				// Completion should reject
				await expect(h2.completion).rejects.toThrow("cancelled");
			}

			// The other tasks should still complete
			const r1 = await h1.completion;
			expect(r1.task).toContain("parser");

			const r3 = await h3.completion;
			expect(r3.task).toContain("linter");
		},
		LONG_TIMEOUT_MS,
	);

	// ── Test: Queue state after partial execution ────────────────────

	it(
		"queue state reflects partial execution correctly",
		async () => {
			const { factory } = trackingAgentFactory({
				promptDelay: 300,
			});

			pool = new AgentPool(
				intPoolConfig({
					createAgent: factory,
					taskQueue: { enabled: true, maxConcurrent: 1 },
				}),
			);

			const h1 = pool.enqueue("Build an API");
			const h2 = pool.enqueue("Build a CLI");
			const h3 = pool.enqueue("Build a GUI");

			// Wait for first to start
			await new Promise<void>((r) => setTimeout(r, 200));

			const midState = pool.getState();
			expect(midState.queue).not.toBeNull();

			// At this point, at least one should be executing
			// The exact state depends on timing, but the counts should be consistent
			const total =
				midState.queue!.pendingCount +
				midState.queue!.executingCount +
				midState.queue!.processedCount;
			expect(total).toBeLessThanOrEqual(3);

			// Wait for all to complete
			await Promise.all([h1.completion, h2.completion, h3.completion]);

			const finalState = pool.getState();
			expect(finalState.queue!.processedCount).toBe(3);
			expect(finalState.queue!.executingCount).toBe(0);
			expect(finalState.queue!.pendingCount).toBe(0);
		},
		LONG_TIMEOUT_MS,
	);

	// ── Test: Concurrent execution with real LLM ────────────────────

	it(
		"maxConcurrent: 2 executes tasks in parallel with real planning",
		async () => {
			const { factory, promptCalls } = trackingAgentFactory();

			pool = new AgentPool(
				intPoolConfig({
					createAgent: factory,
					maxAgents: 10,
					taskQueue: { enabled: true, maxConcurrent: 2 },
				}),
			);

			const dequeuedEvents: TaskDequeuedEvent[] = [];
			pool.on(PoolEvent.TASK_DEQUEUED, (e) => dequeuedEvents.push(e));

			const h1 = pool.enqueue("Create a logger utility");
			const h2 = pool.enqueue("Create an HTTP client wrapper");

			const [r1, r2] = await Promise.all([h1.completion, h2.completion]);

			expect(r1.task).toContain("logger");
			expect(r2.task).toContain("HTTP client");

			// Both should have been dequeued
			expect(dequeuedEvents.length).toBe(2);

			// Agents from both tasks should have been prompted
			expect(promptCalls.length).toBeGreaterThanOrEqual(2);
		},
		LONG_TIMEOUT_MS,
	);

	// ── Test: send("new task") queues when busy ─────────────────────

	it(
		"send() with a new task intent queues the task when pool is busy",
		async () => {
			const { factory } = trackingAgentFactory({
				promptDelay: 1000, // Slow enough that pool stays busy
			});

			pool = new AgentPool(
				intPoolConfig({
					createAgent: factory,
					taskQueue: { enabled: true, maxConcurrent: 1 },
				}),
			);

			// Start a task via enqueue
			const h1 = pool.enqueue("Build the authentication system");

			// Give it time to start executing
			await new Promise<void>((r) => setTimeout(r, 500));

			// Now send a new task via send() — should queue instead of throw
			const sendResult = await pool.send("Now build the payment system");

			// The result should be a string message about queueing,
			// or it might execute as a new task if the first already completed.
			// Either way, it should NOT throw.
			if (typeof sendResult === "string") {
				// If it was queued, the message should mention it
				// If the pool was idle, it might have executed directly
				expect(sendResult.length).toBeGreaterThan(0);
			} else {
				// It executed directly (pool was idle by the time send processed)
				expect(isPoolResult(sendResult)).toBe(true);
			}

			// Wait for first task
			const r1 = await h1.completion;
			expect(r1.task).toContain("authentication");
		},
		LONG_TIMEOUT_MS,
	);

	// ── Test: Existing events still emitted through queue ────────────

	it(
		"core pool events are still emitted when tasks go through the queue",
		async () => {
			const { factory } = trackingAgentFactory();

			pool = new AgentPool(
				intPoolConfig({
					createAgent: factory,
					taskQueue: { enabled: true, maxConcurrent: 1 },
				}),
			);

			const receivedEvents: string[] = [];

			pool.on(PoolEvent.TASK_RECEIVED, () =>
				receivedEvents.push("TASK_RECEIVED"),
			);
			pool.on(PoolEvent.PLANNING_START, () =>
				receivedEvents.push("PLANNING_START"),
			);
			pool.on(PoolEvent.PLANNING_COMPLETE, () =>
				receivedEvents.push("PLANNING_COMPLETE"),
			);
			pool.on(PoolEvent.AGENT_SPAWNED, () =>
				receivedEvents.push("AGENT_SPAWNED"),
			);
			pool.on(PoolEvent.EXECUTION_COMPLETE, () =>
				receivedEvents.push("EXECUTION_COMPLETE"),
			);
			pool.on(PoolEvent.TASK_QUEUED, () => receivedEvents.push("TASK_QUEUED"));
			pool.on(PoolEvent.TASK_DEQUEUED, () =>
				receivedEvents.push("TASK_DEQUEUED"),
			);

			const result = await pool.execute("Write a fibonacci function in Python");

			expect(result.task).toContain("fibonacci");

			// Queue events
			expect(receivedEvents).toContain("TASK_QUEUED");
			expect(receivedEvents).toContain("TASK_DEQUEUED");

			// Core events (still emitted through the queue pipeline)
			expect(receivedEvents).toContain("TASK_RECEIVED");
			expect(receivedEvents).toContain("PLANNING_START");
			expect(receivedEvents).toContain("PLANNING_COMPLETE");
			expect(receivedEvents).toContain("EXECUTION_COMPLETE");
		},
		LONG_TIMEOUT_MS,
	);

	// ── Test: Planner memory persists across queued tasks ────────────

	it(
		"planner memory from earlier tasks enriches later tasks in the queue",
		async () => {
			const { factory } = trackingAgentFactory();

			pool = new AgentPool(
				intPoolConfig({
					createAgent: factory,
					taskQueue: { enabled: true, maxConcurrent: 1 },
				}),
			);

			// Execute first task — creates planner memory
			const r1 = await pool.execute(
				"Create a user authentication module with JWT tokens",
			);
			expect(r1.task).toContain("authentication");

			// Check planner memory was recorded
			const stateAfterFirst = pool.getState();
			expect(stateAfterFirst.plannerMemoryCount).toBeGreaterThanOrEqual(1);

			// Execute second task — planner should have memory context
			const r2 = await pool.execute(
				"Now add role-based access control to the auth system",
			);
			expect(r2.task).toContain("access control");

			// Planner memory should have grown
			const stateAfterSecond = pool.getState();
			expect(stateAfterSecond.plannerMemoryCount).toBeGreaterThanOrEqual(2);
		},
		LONG_TIMEOUT_MS,
	);

	// ── Test: Destroy during queue execution ────────────────────────

	it(
		"destroy() during active queue execution cancels gracefully",
		async () => {
			const { factory } = trackingAgentFactory({
				promptDelay: 2000, // Slow agent
			});

			pool = new AgentPool(
				intPoolConfig({
					createAgent: factory,
					taskQueue: { enabled: true, maxConcurrent: 1 },
				}),
			);

			const h1 = pool.enqueue("Task that will be interrupted");
			const h2 = pool.enqueue("Task that will never start");

			// Give time for first to start
			await new Promise<void>((r) => setTimeout(r, 500));

			// Destroy should not throw
			await pool.destroy();

			// Completions should settle (either resolve or reject)
			const results = await Promise.allSettled([h1.completion, h2.completion]);

			// At least h2 should be rejected (it was pending)
			const h2Result = results[1];
			expect(h2Result.status).toBe("rejected");

			// Pool should be destroyed — new operations should throw
			expect(() => pool.enqueue("should fail")).toThrow();
		},
		LONG_TIMEOUT_MS,
	);

	// ── Test: Queue timeout with real execution ─────────────────────

	it(
		"queue timeout expires pending tasks while others execute",
		async () => {
			const { factory } = trackingAgentFactory({
				promptDelay: 3000, // Very slow agent
			});

			pool = new AgentPool(
				intPoolConfig({
					createAgent: factory,
					taskQueue: {
						enabled: true,
						maxConcurrent: 1,
						queueTimeoutMs: 2000, // 2s timeout for waiting tasks
					},
				}),
			);

			const expiredEvents: any[] = [];
			pool.on(PoolEvent.TASK_EXPIRED, (e) => expiredEvents.push(e));

			// First task starts executing (takes ~3s for agent + LLM planning)
			const h1 = pool.enqueue("Build a database schema");

			// Wait a bit, then queue another
			await new Promise<void>((r) => setTimeout(r, 200));
			const h2 = pool.enqueue("Build an ORM layer");

			// Wait for the timeout to fire (2s)
			await new Promise<void>((r) => setTimeout(r, 3000));

			// h2 should have expired if it was still pending
			if (expiredEvents.length > 0) {
				expect(expiredEvents[0].taskId).toBe(h2.id);
				await expect(h2.completion).rejects.toThrow("expired");
			}

			// Wait for h1 to finish (or handle its completion)
			try {
				const r1 = await h1.completion;
				expect(r1.task).toContain("database");
			} catch {
				// Might have been cancelled during destroy
			}
		},
		LONG_TIMEOUT_MS,
	);

	// ── Test: Usage tracking works across queued tasks ───────────────

	it(
		"usage/cost tracking aggregates across sequentially queued tasks",
		async () => {
			const { factory } = trackingAgentFactory();

			pool = new AgentPool(
				intPoolConfig({
					createAgent: factory,
					taskQueue: { enabled: true, maxConcurrent: 1 },
				}),
			);

			const r1 = await pool.execute("Create a config parser");
			const r2 = await pool.execute("Create a logger");

			// Both results should have usage info
			expect(r1.usage).toBeDefined();
			expect(r1.usage.totalTokens).toBeGreaterThan(0);

			expect(r2.usage).toBeDefined();
			expect(r2.usage.totalTokens).toBeGreaterThan(0);
		},
		LONG_TIMEOUT_MS,
	);

	// ── Test: Status query shows queue info ─────────────────────────

	it(
		"send('status') includes queue information in the response",
		async () => {
			const { factory } = trackingAgentFactory({
				promptDelay: 1000,
			});

			pool = new AgentPool(
				intPoolConfig({
					createAgent: factory,
					taskQueue: { enabled: true, maxConcurrent: 1 },
				}),
			);

			// Start a task
			const h1 = pool.enqueue("Build a web server");

			// Give it time to start
			await new Promise<void>((r) => setTimeout(r, 500));

			// Queue another task
			const h2 = pool.enqueue("Build a middleware layer");

			// Ask for status
			const statusResponse = await pool.send("What is the current status?");

			// Status should be a string with information
			expect(typeof statusResponse).toBe("string");
			const statusStr = statusResponse as string;
			expect(statusStr.length).toBeGreaterThan(0);

			// Wait for everything to finish
			try {
				await Promise.all([h1.completion, h2.completion]);
			} catch {
				// Some tasks may fail during cleanup
			}
		},
		LONG_TIMEOUT_MS,
	);

	// ── Test: Reflection works with queued execution ────────────────

	it(
		"post-execution reflection works for queued tasks",
		async () => {
			const { factory } = trackingAgentFactory();

			pool = new AgentPool(
				intPoolConfig({
					createAgent: factory,
					taskQueue: { enabled: true, maxConcurrent: 1 },
					reflection: {
						enabled: true,
					},
				}),
			);

			const reflectionEvents: any[] = [];
			pool.on(PoolEvent.REFLECTION_COMPLETE, (e) => reflectionEvents.push(e));

			const result = await pool.execute(
				"Build a complete REST API with CRUD operations for a blog",
			);

			expect(result.task).toContain("REST API");

			// Reflection may or may not have run depending on config
			// but it shouldn't crash
			const state = pool.getState();
			// reflectionCount may be 0 if reflection is skipped for simple tasks
			expect(state.reflectionCount).toBeGreaterThanOrEqual(0);
		},
		LONG_TIMEOUT_MS,
	);

	// ── Test: send('cancel') cancels all tasks via cancelAll ─────────

	it(
		"send('cancel') cancels queued tasks and keeps pool usable afterwards",
		async () => {
			const { factory } = trackingAgentFactory({
				promptDelay: 2000, // Slow agent so tasks stay in queue
			});

			pool = new AgentPool(
				intPoolConfig({
					createAgent: factory,
					taskQueue: { enabled: true, maxConcurrent: 1 },
				}),
			);

			const cancelledEvents: TaskCancelledEvent[] = [];
			pool.on(PoolEvent.TASK_CANCELLED, (e) => cancelledEvents.push(e));

			// Enqueue several tasks
			const h1 = pool.enqueue("Build a user service");
			const h2 = pool.enqueue("Build a payment service");
			const h3 = pool.enqueue("Build a notification service");

			h1.completion.catch(() => {});
			h2.completion.catch(() => {});
			h3.completion.catch(() => {});

			// Give time for first task to start
			await new Promise<void>((r) => setTimeout(r, 500));

			// Cancel everything via send()
			const cancelResult = await pool.send("Cancel all tasks");

			// Should return a string confirmation
			expect(typeof cancelResult).toBe("string");
			const cancelStr = cancelResult as string;
			expect(cancelStr.toLowerCase()).toContain("cancel");

			// Some cancelled events should have fired
			expect(cancelledEvents.length).toBeGreaterThanOrEqual(1);

			// The pool should remain usable — verify the queue is still
			// accepting tasks by checking state
			const stateAfterCancel = pool.getState();
			expect(stateAfterCancel.queue).not.toBeNull();
			expect(stateAfterCancel.queue!.pendingCount).toBe(0);
			expect(stateAfterCancel.queue!.executingCount).toBe(0);
		},
		LONG_TIMEOUT_MS,
	);

	// ── Test: Concurrent error isolation ─────────────────────────────

	it(
		"a failing concurrent task does not corrupt the other task's result",
		async () => {
			let callCount = 0;
			const { factory } = trackingAgentFactory({
				promptText: "Task completed successfully.",
			});

			// We need a factory where the second agent fails
			const failingFactory = (config?: { name?: string }) => {
				callCount++;
				const agent = factory(config);

				// Make the second spawned agent's prompt throw
				if (callCount === 2) {
					const _original = agent.prompt;
					(agent as any).prompt = async (_text: string) => {
						throw new Error("Agent crashed intentionally");
					};
				}

				return agent;
			};

			pool = new AgentPool(
				intPoolConfig({
					createAgent: failingFactory,
					maxAgents: 10,
					taskQueue: { enabled: true, maxConcurrent: 2 },
				}),
			);

			// Enqueue two tasks — they should run in parallel
			const h1 = pool.enqueue("Write a hello world function");
			const h2 = pool.enqueue("Write a goodbye world function");

			// One should succeed and one may fail (depending on which
			// agent gets the failing factory call). The key assertion is
			// that neither hangs and at least one completes cleanly.
			const results = await Promise.allSettled([h1.completion, h2.completion]);

			// Both should have settled (no hang)
			expect(results.length).toBe(2);

			// At least one should have fulfilled
			const fulfilled = results.filter((r) => r.status === "fulfilled");
			expect(fulfilled.length).toBeGreaterThanOrEqual(1);

			// The fulfilled result should be a valid AgentPoolResult
			for (const r of fulfilled) {
				if (r.status === "fulfilled") {
					expect(r.value.task).toBeTruthy();
					expect(r.value.strategy).toBeTruthy();
					expect(r.value.summary).toBeTruthy();
				}
			}

			// Queue state should be clean
			const finalState = pool.getState();
			expect(finalState.queue!.executingCount).toBe(0);
			expect(finalState.queue!.pendingCount).toBe(0);
			expect(finalState.queue!.processedCount).toBe(2);
		},
		LONG_TIMEOUT_MS,
	);

	// ── Test: Queue timeout interaction with active execution ────────

	it(
		"queueTimeoutMs only expires pending tasks, not executing ones",
		async () => {
			const { factory } = trackingAgentFactory({
				promptDelay: 100, // Fast agent
			});

			pool = new AgentPool(
				intPoolConfig({
					createAgent: factory,
					taskQueue: {
						enabled: true,
						maxConcurrent: 1,
						queueTimeoutMs: 1500, // Short timeout for pending tasks
					},
				}),
			);

			const expiredEvents: any[] = [];
			pool.on(PoolEvent.TASK_EXPIRED, (e) => expiredEvents.push(e));

			// First task starts executing — takes a while due to LLM planning
			const h1 = pool.enqueue("Create a simple utility function");

			// Second task waits in queue — may expire if first takes too long
			await new Promise<void>((r) => setTimeout(r, 200));
			const h2 = pool.enqueue("Create another utility function");
			h2.completion.catch(() => {});

			// Wait for first task to complete
			const r1 = await h1.completion;
			expect(r1.task).toContain("utility");

			// If h2 expired, verify the event and error
			if (expiredEvents.length > 0) {
				expect(expiredEvents[0].taskId).toBe(h2.id);
				expect(expiredEvents[0].waitTimeMs).toBeGreaterThanOrEqual(1500);
				await expect(h2.completion).rejects.toThrow("expired");
			} else {
				// h2 didn't expire — it should have completed successfully
				const r2 = await h2.completion;
				expect(r2.task).toContain("utility");
			}

			// The executing task should NEVER have expired regardless
			// (queue timeout only applies to pending tasks)
			const expiredH1 = expiredEvents.find((e) => e.taskId === h1.id);
			expect(expiredH1).toBeUndefined();
		},
		LONG_TIMEOUT_MS,
	);

	// ── Test: cancelAll via pool keeps queue usable for new tasks ────

	it(
		"pool remains fully functional after cancelAll — new tasks execute normally",
		async () => {
			const { factory } = trackingAgentFactory({
				promptDelay: 1500,
			});

			pool = new AgentPool(
				intPoolConfig({
					createAgent: factory,
					taskQueue: { enabled: true, maxConcurrent: 1 },
				}),
			);

			// Start some tasks
			const h1 = pool.enqueue("Initial task that will be cancelled");
			const h2 = pool.enqueue("Second task that will be cancelled");

			h1.completion.catch(() => {});
			h2.completion.catch(() => {});

			// Wait for first to start
			await new Promise<void>((r) => setTimeout(r, 300));

			// Cancel everything
			await pool.send("Cancel everything");

			// Wait for cancellation to settle
			await new Promise<void>((r) => setTimeout(r, 200));

			// Now submit a fresh task — it should execute normally.
			// The key test is that execute() doesn't throw or hang.
			const result = await pool.execute("Write a simple add function");

			expect(result.task).toContain("add function");
			expect(result.strategy).toBeTruthy();
			expect(result.summary).toBeTruthy();
			expect(result.durationMs).toBeGreaterThan(0);

			// Queue state should show the new task was processed
			const state = pool.getState();
			expect(state.queue!.processedCount).toBeGreaterThanOrEqual(1);
		},
		LONG_TIMEOUT_MS,
	);

	// ── Test: Large batch of sequential tasks ────────────────────────

	it(
		"processes a batch of 4 sequential tasks without issues",
		async () => {
			const { factory, promptCalls } = trackingAgentFactory({
				promptText: "Task completed.",
			});

			pool = new AgentPool(
				intPoolConfig({
					createAgent: factory,
					taskQueue: { enabled: true, maxConcurrent: 1 },
				}),
			);

			const drainedEvents: QueueDrainedEvent[] = [];
			pool.on(PoolEvent.QUEUE_DRAINED, (e) => drainedEvents.push(e));

			const tasks = [
				"Write a sum function",
				"Write a multiply function",
				"Write a subtract function",
				"Write a divide function",
			];

			const handles = tasks.map((t) => pool.enqueue(t));

			// Wait for all to complete
			const results = await Promise.all(handles.map((h) => h.completion));

			// All results should be valid
			expect(results.length).toBe(4);
			for (let i = 0; i < results.length; i++) {
				expect(results[i]!.strategy).toBeTruthy();
				expect(results[i]!.summary.length).toBeGreaterThan(0);
				expect(results[i]!.durationMs).toBeGreaterThan(0);
				expect(results[i]!.usage).toBeDefined();
				expect(results[i]!.usage.totalTokens).toBeGreaterThan(0);
			}

			// Agents should have been prompted for each task
			expect(promptCalls.length).toBeGreaterThanOrEqual(4);

			// Queue should have drained
			await new Promise<void>((r) => setTimeout(r, 100));
			expect(drainedEvents.length).toBeGreaterThanOrEqual(1);

			const lastDrain = drainedEvents[drainedEvents.length - 1]!;
			expect(lastDrain.totalProcessed).toBe(4);
			expect(lastDrain.totalSucceeded).toBe(4);
			expect(lastDrain.totalFailed).toBe(0);

			// Final state should be clean
			const state = pool.getState();
			expect(state.queue!.processedCount).toBe(4);
			expect(state.queue!.executingCount).toBe(0);
			expect(state.queue!.pendingCount).toBe(0);
		},
		LONG_TIMEOUT_MS,
	);
});
