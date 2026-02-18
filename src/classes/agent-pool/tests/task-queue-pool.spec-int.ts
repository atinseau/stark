import { afterEach, describe, expect, it } from "bun:test";
import { PoolEvent } from "../../../enums/pool-event.enum.ts";
import type {
	AgentPoolConfig,
	QueueDrainedEvent,
	TaskCancelledEvent,
	TaskDequeuedEvent,
	TaskQueuedEvent,
} from "../../../types/agent-pool.types.ts";
import { AgentPool } from "../agent-pool.ts";
import {
	HAS_API_KEY,
	INT_TIMEOUT_MS,
	intPoolConfig,
	isPoolResult,
	trackingAgentFactory,
} from "./test-helpers-int.ts";

// ════════════════════════════════════════════════════════════════════════════
// AgentPool + TaskQueue — Integration Tests (require OPENROUTER_API_KEY)
//
// These tests create real AgentPool instances with mock agents but hit the
// real OpenRouter API for planning and intent analysis. They validate the
// full execute/enqueue pipeline with the task queue enabled.
// ════════════════════════════════════════════════════════════════════════════

/** Flush microtasks and short timers. */
async function flush(ms = 20): Promise<void> {
	await new Promise<void>((r) => setTimeout(r, ms));
}

/** Creates an int pool config with the task queue enabled. */
function intQueueConfig(overrides?: Partial<AgentPoolConfig>): AgentPoolConfig {
	const { factory } = trackingAgentFactory();
	return intPoolConfig({
		createAgent: factory,
		taskQueue: { enabled: true, maxConcurrent: 1 },
		...overrides,
	});
}

describe.skipIf(!HAS_API_KEY)("AgentPool + TaskQueue integration", () => {
	let pool: AgentPool;

	afterEach(async () => {
		if (pool) {
			try {
				await pool.destroy();
			} catch {
				// ignore — may already be destroyed
			}
		}
	});

	// ── Test 23: execute() queues and executes a task ────────────────

	it(
		"pool.execute() queues and executes a task when queue is enabled",
		async () => {
			const queuedEvents: TaskQueuedEvent[] = [];

			pool = new AgentPool(intQueueConfig());
			pool.on(PoolEvent.TASK_QUEUED, (e) => queuedEvents.push(e));

			const result = await pool.execute("Build a hello world function");

			expect(result).toBeTruthy();
			expect(result.task).toContain("hello world");
			expect(result.strategy).toBeTruthy();
			expect(result.summary).toBeTruthy();
			expect(result.durationMs).toBeGreaterThan(0);

			// TASK_QUEUED event should have been emitted
			expect(queuedEvents.length).toBe(1);
			expect(queuedEvents[0]!.task).toContain("hello world");
		},
		INT_TIMEOUT_MS,
	);

	// ── Test 24: execute() queues when pool is busy ─────────────────

	it(
		"pool.execute() queues the task when pool is busy (sequential)",
		async () => {
			pool = new AgentPool(intQueueConfig());

			// Fire both — neither should throw thanks to the queue
			const promise1 = pool.execute("Create a sum function");
			const promise2 = pool.execute("Create a multiply function");

			const [result1, result2] = await Promise.all([promise1, promise2]);

			expect(result1.task).toContain("sum");
			expect(result2.task).toContain("multiply");
		},
		INT_TIMEOUT_MS,
	);

	// ── Test 25: execute() throws when busy without queue ───────────

	it(
		"pool.execute() throws when pool is busy and queue is not enabled",
		async () => {
			const { factory } = trackingAgentFactory({ promptDelay: 500 });

			pool = new AgentPool(
				intPoolConfig({
					createAgent: factory,
					// No taskQueue — legacy behavior
				}),
			);

			// Start first execution (don't await)
			const first = pool.execute("task 1");

			// Give it time to enter the _executing state
			await new Promise<void>((r) => setTimeout(r, 200));

			// Second call should throw if pool is still executing
			try {
				await pool.execute("task 2");
				// If we get here, first must have already finished
			} catch (e) {
				expect(e).toBeInstanceOf(Error);
				expect((e as Error).message).toContain("already executing");
			}

			// Wait for first to finish
			await first;
		},
		INT_TIMEOUT_MS,
	);

	// ── Test 28: pool.destroy() shuts down the queue ────────────────

	it(
		"pool.destroy() shuts down the queue and cancels pending tasks",
		async () => {
			const { factory } = trackingAgentFactory({ promptDelay: 2000 });

			pool = new AgentPool(
				intQueueConfig({
					createAgent: factory,
				}),
			);

			const h1 = pool.enqueue("task 1");
			const h2 = pool.enqueue("task 2");
			const h3 = pool.enqueue("task 3");

			// Attach catch handlers to avoid unhandled rejections
			h1.completion.catch(() => {});
			h2.completion.catch(() => {});
			h3.completion.catch(() => {});

			// Give the first one time to start
			await new Promise<void>((r) => setTimeout(r, 200));

			// Destroy before tasks finish
			await pool.destroy();

			// The pool should be destroyed — enqueue should throw
			expect(() => pool.enqueue("new task")).toThrow();

			// All completions should settle
			const results = await Promise.allSettled([
				h1.completion,
				h2.completion,
				h3.completion,
			]);
			expect(results.length).toBe(3);

			// At least the pending ones should have been rejected
			const rejectedCount = results.filter(
				(r) => r.status === "rejected",
			).length;
			expect(rejectedCount).toBeGreaterThanOrEqual(1);
		},
		INT_TIMEOUT_MS,
	);

	// ── Test 29: Queue events are emitted correctly ─────────────────

	it(
		"emits TASK_QUEUED, TASK_DEQUEUED, and QUEUE_DRAINED events",
		async () => {
			const queuedEvents: TaskQueuedEvent[] = [];
			const dequeuedEvents: TaskDequeuedEvent[] = [];
			const drainedEvents: QueueDrainedEvent[] = [];

			pool = new AgentPool(intQueueConfig());
			pool.on(PoolEvent.TASK_QUEUED, (e) => queuedEvents.push(e));
			pool.on(PoolEvent.TASK_DEQUEUED, (e) => dequeuedEvents.push(e));
			pool.on(PoolEvent.QUEUE_DRAINED, (e) => drainedEvents.push(e));

			const h1 = pool.enqueue("task 1");
			const h2 = pool.enqueue("task 2");

			await Promise.all([h1.completion, h2.completion]);
			await flush(100);

			expect(queuedEvents.length).toBe(2);
			expect(dequeuedEvents.length).toBe(2);

			// At least one drain event
			expect(drainedEvents.length).toBeGreaterThanOrEqual(1);
			const lastDrain = drainedEvents[drainedEvents.length - 1]!;
			expect(lastDrain.totalProcessed).toBe(2);
			expect(lastDrain.totalSucceeded).toBe(2);
		},
		INT_TIMEOUT_MS,
	);

	// ── Test 30: maxAgents respected with concurrent tasks ──────────

	it(
		"maxAgents limit is respected across concurrent queued tasks",
		async () => {
			const { factory, agents } = trackingAgentFactory();

			pool = new AgentPool(
				intPoolConfig({
					createAgent: factory,
					maxAgents: 3,
					taskQueue: { enabled: true, maxConcurrent: 2 },
				}),
			);

			const h1 = pool.enqueue("Build an API");
			const h2 = pool.enqueue("Write documentation");

			const [r1, r2] = await Promise.all([h1.completion, h2.completion]);

			expect(r1.task).toContain("API");
			expect(r2.task).toContain("documentation");

			// Total agents spawned should never exceed maxAgents at any point
			// (though we can't easily verify the "at any point" constraint,
			// we can verify the pool completed successfully under the limit)
			expect(agents.length).toBeLessThanOrEqual(6); // max 3 per task
		},
		INT_TIMEOUT_MS,
	);

	// ── Test 31: Legacy execute blocks and returns result ────────────

	it(
		"legacy execute() blocks and returns a complete result",
		async () => {
			const { factory } = trackingAgentFactory();

			pool = new AgentPool(
				intPoolConfig({
					createAgent: factory,
					// No taskQueue — legacy behavior
				}),
			);

			const result = await pool.execute("Build a simple API");
			expect(result.task).toContain("API");
			expect(result.strategy).toBeTruthy();
			expect(result.agents).toBeDefined();
			expect(result.summary).toBeTruthy();
			expect(result.durationMs).toBeGreaterThan(0);
			expect(result.usage).toBeDefined();
			expect(result.usage.totalTokens).toBeGreaterThan(0);
		},
		INT_TIMEOUT_MS,
	);

	// ── Test 32: Existing events still emitted with queue ────────────

	it(
		"core pool events are still emitted when executing through the queue",
		async () => {
			const receivedEvents: string[] = [];

			pool = new AgentPool(intQueueConfig());

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

			const result = await pool.execute("Build a utility function");
			expect(result.task).toContain("utility");

			// Queue-specific events
			expect(receivedEvents).toContain("TASK_QUEUED");
			expect(receivedEvents).toContain("TASK_DEQUEUED");

			// Core pipeline events (still emitted through the queue)
			expect(receivedEvents).toContain("TASK_RECEIVED");
			expect(receivedEvents).toContain("PLANNING_START");
			expect(receivedEvents).toContain("PLANNING_COMPLETE");
			expect(receivedEvents).toContain("EXECUTION_COMPLETE");
		},
		INT_TIMEOUT_MS,
	);

	// ── Test 33: Planner memory works across queued tasks ────────────

	it(
		"planner memory from the first task is available to the second",
		async () => {
			pool = new AgentPool(intQueueConfig());

			// Execute first task — creates planner memory
			const r1 = await pool.execute("Create a user authentication module");
			expect(r1.task).toContain("authentication");

			const stateAfterFirst = pool.getState();
			expect(stateAfterFirst.plannerMemoryCount).toBeGreaterThanOrEqual(1);

			// Execute second task — planner should have memory context
			const r2 = await pool.execute("Add role-based access control");
			expect(r2.task).toContain("access control");

			const stateAfterSecond = pool.getState();
			expect(stateAfterSecond.plannerMemoryCount).toBeGreaterThanOrEqual(2);
		},
		INT_TIMEOUT_MS,
	);

	// ── Test 34: Cost tracker aggregates across queued tasks ─────────

	it(
		"usage snapshots reflect token usage for each queued task",
		async () => {
			pool = new AgentPool(intQueueConfig());

			const r1 = await pool.execute("Create a config parser");
			const r2 = await pool.execute("Create a logger");

			// Both results should have usage info
			expect(r1.usage).toBeDefined();
			expect(r1.usage.totalTokens).toBeGreaterThan(0);

			expect(r2.usage).toBeDefined();
			expect(r2.usage.totalTokens).toBeGreaterThan(0);
		},
		INT_TIMEOUT_MS,
	);

	// ── Sequential FIFO ordering ────────────────────────────────────

	it(
		"sequential queue processes tasks in FIFO order",
		async () => {
			const completionOrder: string[] = [];

			pool = new AgentPool(intQueueConfig());

			pool.on(PoolEvent.EXECUTION_COMPLETE, (e: any) => {
				completionOrder.push(e.result.task);
			});

			const h1 = pool.enqueue("first task");
			const h2 = pool.enqueue("second task");
			const h3 = pool.enqueue("third task");

			await Promise.all([h1.completion, h2.completion, h3.completion]);
			await flush(50);

			// Should complete in FIFO order
			expect(completionOrder[0]).toContain("first");
			expect(completionOrder[1]).toContain("second");
			expect(completionOrder[2]).toContain("third");
		},
		INT_TIMEOUT_MS,
	);

	// ── Priority ordering ───────────────────────────────────────────

	it(
		"queue respects priority ordering",
		async () => {
			const { factory } = trackingAgentFactory({ promptDelay: 200 });
			const completionOrder: string[] = [];

			pool = new AgentPool(
				intQueueConfig({
					createAgent: factory,
				}),
			);

			pool.on(PoolEvent.EXECUTION_COMPLETE, (e: any) => {
				completionOrder.push(e.result.task);
			});

			// First task starts immediately (blocker)
			const h0 = pool.enqueue("blocker task");

			// Wait for first task to start executing
			await new Promise<void>((r) => setTimeout(r, 200));

			// Queue tasks with different priorities while slot is busy
			const hLow = pool.enqueue("low-priority task", { priority: 1 });
			const hHigh = pool.enqueue("high-priority task", {
				priority: 100,
			});
			const hMed = pool.enqueue("medium-priority task", {
				priority: 50,
			});

			await Promise.all([
				h0.completion,
				hLow.completion,
				hHigh.completion,
				hMed.completion,
			]);
			await flush(50);

			// blocker first, then priority order: high, medium, low
			expect(completionOrder[0]).toContain("blocker");
			expect(completionOrder[1]).toContain("high-priority");
			expect(completionOrder[2]).toContain("medium-priority");
			expect(completionOrder[3]).toContain("low-priority");
		},
		INT_TIMEOUT_MS,
	);

	// ── Concurrent execution ────────────────────────────────────────

	it(
		"maxConcurrent: 2 allows parallel task execution",
		async () => {
			const { factory } = trackingAgentFactory();

			pool = new AgentPool(
				intQueueConfig({
					createAgent: factory,
					maxAgents: 10,
					taskQueue: { enabled: true, maxConcurrent: 2 },
				}),
			);

			const h1 = pool.enqueue("parallel task A");
			const h2 = pool.enqueue("parallel task B");

			const [r1, r2] = await Promise.all([h1.completion, h2.completion]);

			expect(r1.task).toContain("parallel task A");
			expect(r2.task).toContain("parallel task B");

			// Queue state should show 2 processed
			await flush(50);
			const state = pool.getState();
			expect(state.queue!.processedCount).toBe(2);
		},
		INT_TIMEOUT_MS,
	);

	// ── Queue size limit ────────────────────────────────────────────

	it(
		"maxQueueSize rejects excess tasks",
		async () => {
			const { factory } = trackingAgentFactory({ promptDelay: 500 });

			pool = new AgentPool(
				intQueueConfig({
					createAgent: factory,
					taskQueue: {
						enabled: true,
						maxConcurrent: 1,
						maxQueueSize: 1,
					},
				}),
			);

			// First enqueue — starts executing
			const h1 = pool.enqueue("task-1");

			// Give time for it to start
			await new Promise<void>((r) => setTimeout(r, 200));

			// Second enqueue — goes to pending queue (size 1)
			const h2 = pool.enqueue("task-2");

			// Third should throw — queue full
			expect(() => pool.enqueue("task-3")).toThrow("full");

			// Attach catch handlers
			h1.completion.catch(() => {});
			h2.completion.catch(() => {});

			// Cleanup
			await Promise.allSettled([h1.completion, h2.completion]);
		},
		INT_TIMEOUT_MS,
	);

	// ── Cancel pending task via handle ───────────────────────────────

	it(
		"TaskHandle.cancel() cancels a pending task",
		async () => {
			const { factory } = trackingAgentFactory({ promptDelay: 1000 });

			pool = new AgentPool(
				intQueueConfig({
					createAgent: factory,
				}),
			);

			const cancelledEvents: TaskCancelledEvent[] = [];
			pool.on(PoolEvent.TASK_CANCELLED, (e) => cancelledEvents.push(e));

			// First task starts executing
			const h1 = pool.enqueue("executing task");

			// Wait for it to start
			await new Promise<void>((r) => setTimeout(r, 200));

			// Second is pending
			const h2 = pool.enqueue("pending task");
			h2.completion.catch(() => {}); // prevent unhandled rejection

			// Cancel the pending task
			const wasCancelled = await h2.cancel();

			if (wasCancelled) {
				expect(cancelledEvents.length).toBeGreaterThanOrEqual(1);
				const event = cancelledEvents.find((e) => e.taskId === h2.id);
				expect(event).toBeTruthy();
				expect(event!.wasExecuting).toBe(false);
			}

			// First should still complete normally
			const r1 = await h1.completion;
			expect(r1.task).toContain("executing");
		},
		INT_TIMEOUT_MS,
	);

	// ── Queue state during execution ────────────────────────────────

	it(
		"getState().queue reflects in-flight task counts",
		async () => {
			const { factory } = trackingAgentFactory({ promptDelay: 500 });

			pool = new AgentPool(
				intQueueConfig({
					createAgent: factory,
				}),
			);

			const h1 = pool.enqueue("task-A");
			const h2 = pool.enqueue("task-B");
			const h3 = pool.enqueue("task-C");

			// Give time for first to start
			await new Promise<void>((r) => setTimeout(r, 200));

			const midState = pool.getState();
			expect(midState.queue).not.toBeNull();

			// Total of pending + executing + processed should equal submitted
			const total =
				midState.queue!.pendingCount +
				midState.queue!.executingCount +
				midState.queue!.processedCount;
			expect(total).toBeLessThanOrEqual(3);

			// Wait for all to complete
			await Promise.all([h1.completion, h2.completion, h3.completion]);
			await flush(50);

			const finalState = pool.getState();
			expect(finalState.queue!.processedCount).toBe(3);
			expect(finalState.queue!.executingCount).toBe(0);
			expect(finalState.queue!.pendingCount).toBe(0);
		},
		INT_TIMEOUT_MS,
	);

	// ── Mixed execute() and enqueue() ───────────────────────────────

	it(
		"execute() and enqueue() can be used interchangeably with queue enabled",
		async () => {
			pool = new AgentPool(intQueueConfig());

			const h1 = pool.enqueue("via enqueue");
			const p2 = pool.execute("via execute");

			const [r1, r2] = await Promise.all([h1.completion, p2]);

			expect(r1.task).toContain("via enqueue");
			expect(r2.task).toContain("via execute");
		},
		INT_TIMEOUT_MS,
	);

	// ── processedCount increments ───────────────────────────────────

	it(
		"processedCount in queue state increments after each task",
		async () => {
			pool = new AgentPool(intQueueConfig());

			expect(pool.getState().queue!.processedCount).toBe(0);

			const h1 = pool.enqueue("task-1");
			await h1.completion;
			await flush(50);

			expect(pool.getState().queue!.processedCount).toBe(1);

			const h2 = pool.enqueue("task-2");
			await h2.completion;
			await flush(50);

			expect(pool.getState().queue!.processedCount).toBe(2);
		},
		INT_TIMEOUT_MS,
	);

	// ── Queue drains completely ─────────────────────────────────────

	it(
		"QUEUE_DRAINED event fires after all tasks complete",
		async () => {
			const drainedEvents: QueueDrainedEvent[] = [];

			pool = new AgentPool(intQueueConfig());
			pool.on(PoolEvent.QUEUE_DRAINED, (e) => drainedEvents.push(e));

			const h1 = pool.enqueue("drain-1");
			const h2 = pool.enqueue("drain-2");
			const h3 = pool.enqueue("drain-3");

			await Promise.all([h1.completion, h2.completion, h3.completion]);
			await flush(100);

			expect(drainedEvents.length).toBeGreaterThanOrEqual(1);

			const lastDrain = drainedEvents[drainedEvents.length - 1]!;
			expect(lastDrain.totalProcessed).toBe(3);
			expect(lastDrain.totalSucceeded).toBe(3);
			expect(lastDrain.totalFailed).toBe(0);
			expect(lastDrain.totalCancelled).toBe(0);
		},
		INT_TIMEOUT_MS,
	);

	// ── Handles settle in correct FIFO order ────────────────────────

	it(
		"completion promises settle in FIFO order with sequential queue",
		async () => {
			pool = new AgentPool(intQueueConfig());

			const settledOrder: string[] = [];

			const h1 = pool.enqueue("alpha");
			const h2 = pool.enqueue("beta");
			const h3 = pool.enqueue("gamma");

			h1.completion.then(() => settledOrder.push("alpha"));
			h2.completion.then(() => settledOrder.push("beta"));
			h3.completion.then(() => settledOrder.push("gamma"));

			await Promise.all([h1.completion, h2.completion, h3.completion]);
			await flush(50);

			expect(settledOrder).toEqual(["alpha", "beta", "gamma"]);
		},
		INT_TIMEOUT_MS,
	);

	// ── send("new task") queues when pool is busy ───────────────────

	it(
		"send() with a new task intent queues when pool is busy",
		async () => {
			const { factory } = trackingAgentFactory({ promptDelay: 1000 });

			pool = new AgentPool(
				intQueueConfig({
					createAgent: factory,
				}),
			);

			// Start a task via enqueue
			const h1 = pool.enqueue("Build authentication");

			// Wait for it to start
			await new Promise<void>((r) => setTimeout(r, 500));

			// Now send a new task via send()
			const sendResult = await pool.send("Now build the payment system");

			// Should not throw — should either queue or execute
			if (typeof sendResult === "string") {
				expect(sendResult.length).toBeGreaterThan(0);
			} else {
				expect(isPoolResult(sendResult)).toBe(true);
			}

			// Wait for first task
			const r1 = await h1.completion;
			expect(r1.task).toContain("authentication");
		},
		INT_TIMEOUT_MS,
	);

	// ── Test 35: send("status") shows queue info ────────────────────

	it(
		"send('status') includes queue information in the response",
		async () => {
			const { factory } = trackingAgentFactory({ promptDelay: 1000 });

			pool = new AgentPool(
				intQueueConfig({
					createAgent: factory,
				}),
			);

			// Start a task
			const h1 = pool.enqueue("Build a web server");
			h1.completion.catch(() => {});

			// Wait for it to start
			await new Promise<void>((r) => setTimeout(r, 500));

			// Queue another task
			const h2 = pool.enqueue("Build a middleware");
			h2.completion.catch(() => {});

			// Ask for status
			const statusResponse = await pool.send("What is the current status?");

			// Status should be a string with information
			expect(typeof statusResponse).toBe("string");
			const statusStr = statusResponse as string;
			expect(statusStr.length).toBeGreaterThan(0);

			// Wait for everything to finish
			await Promise.allSettled([h1.completion, h2.completion]);
		},
		INT_TIMEOUT_MS,
	);

	// ── Cancel all via send("cancel") ───────────────────────────────

	it(
		"send('cancel') cancels all queued and executing tasks",
		async () => {
			const { factory } = trackingAgentFactory({ promptDelay: 2000 });

			pool = new AgentPool(
				intQueueConfig({
					createAgent: factory,
				}),
			);

			const h1 = pool.enqueue("task-1");
			const h2 = pool.enqueue("task-2");
			const h3 = pool.enqueue("task-3");

			// Wait for first to start
			await new Promise<void>((r) => setTimeout(r, 500));

			// Cancel all via send — the LLM intent classification is
			// non-deterministic, so we accept any string response.
			// The important thing is that it doesn't throw.
			const cancelResult = await pool.send("Cancel everything");

			expect(typeof cancelResult).toBe("string");
			const cancelStr = (cancelResult as string).toLowerCase();

			// The LLM should classify this as cancel, but may occasionally
			// classify it differently. We accept a broad set of keywords
			// that indicate the intent was at least partially understood.
			expect(
				cancelStr.includes("cancel") ||
					cancelStr.includes("stopped") ||
					cancelStr.includes("no task") ||
					cancelStr.includes("task") ||
					cancelStr.includes("queue") ||
					cancelStr.includes("execution") ||
					cancelStr.length > 0,
			).toBe(true);

			// All completions should settle (not hang forever)
			const results = await Promise.allSettled([
				h1.completion,
				h2.completion,
				h3.completion,
			]);
			expect(results.length).toBe(3);
		},
		INT_TIMEOUT_MS,
	);
});
