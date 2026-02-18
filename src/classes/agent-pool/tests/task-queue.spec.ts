import { describe, expect, it } from "bun:test";
import { ExecutionStrategy } from "../../../enums/execution-strategy.enum.ts";
import { TaskComplexity } from "../../../enums/task-complexity.enum.ts";
import type {
	AgentPoolResult,
	QueuedTask,
} from "../../../types/agent-pool.types.ts";
import { TaskQueue, type TaskQueueCallbacks } from "../task-queue.ts";
import { silentLogger } from "./test-helpers.ts";

// ════════════════════════════════════════════════════════════════════════════
// Test Helpers
// ════════════════════════════════════════════════════════════════════════════

/** Creates a minimal valid AgentPoolResult for test purposes. */
function makeMockResult(task: string): AgentPoolResult {
	return {
		task,
		strategy: ExecutionStrategy.SINGLE,
		analysis: {
			strategy: ExecutionStrategy.SINGLE,
			complexity: TaskComplexity.SIMPLE,
			reasoning: "test",
			subtasks: [
				{
					id: "sub-1",
					prompt: task,
					role: "test-agent",
					dependencies: [],
					priority: 1,
				},
			],
			dependencies: [],
			parallelismBenefit: 0,
		},
		agents: [],
		summary: `Completed: ${task}`,
		durationMs: 100,
		usage: {
			inputTokens: 100,
			outputTokens: 50,
			totalTokens: 150,
			estimatedCostUsd: 0.001,
			breakdown: {
				agents: {
					callCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					estimatedCostUsd: null,
				},
				planner: {
					callCount: 1,
					totalTokens: 150,
					inputTokens: 100,
					outputTokens: 50,
					estimatedCostUsd: 0.001,
				},
				sharingAnalyzer: {
					callCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					estimatedCostUsd: null,
				},
				contextAnalyzer: {
					callCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					estimatedCostUsd: null,
				},
				intentAnalyzer: {
					callCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					estimatedCostUsd: null,
				},
				orchestrator: {
					callCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					estimatedCostUsd: null,
				},
				checkpoint: {
					callCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					estimatedCostUsd: null,
				},
				reflection: {
					callCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					estimatedCostUsd: null,
				},
				userInteraction: {
					callCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					estimatedCostUsd: null,
				},
				compression: {
					callCount: 0,
					totalTokens: 0,
					inputTokens: 0,
					outputTokens: 0,
					estimatedCostUsd: null,
				},
			},
			timestamp: new Date().toISOString(),
		},
	};
}

/**
 * Creates a deferred promise — a promise plus external resolve/reject.
 * Useful for controlling when an executor completes in tests.
 */
function deferred<T>(): {
	promise: Promise<T>;
	resolve: (val: T) => void;
	reject: (err: Error) => void;
} {
	let resolve!: (val: T) => void;
	let reject!: (err: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Creates mock callbacks that track all invocations. */
function createMockCallbacks() {
	const queuedCalls: Array<{
		task: QueuedTask;
		position: number;
		queueSize: number;
	}> = [];
	const dequeuedCalls: Array<{ task: QueuedTask; waitTimeMs: number }> = [];
	const drainedCalls: Array<{
		total: number;
		succeeded: number;
		failed: number;
		cancelled: number;
	}> = [];
	const cancelledCalls: Array<{
		task: QueuedTask;
		wasExecuting: boolean;
	}> = [];
	const expiredCalls: Array<{ task: QueuedTask; waitTimeMs: number }> = [];

	const callbacks: TaskQueueCallbacks = {
		onQueued: (task, position, queueSize) => {
			queuedCalls.push({ task, position, queueSize });
		},
		onDequeued: (task, waitTimeMs) => {
			dequeuedCalls.push({ task, waitTimeMs });
		},
		onDrained: (stats) => {
			drainedCalls.push(stats);
		},
		onCancelled: (task, wasExecuting) => {
			cancelledCalls.push({ task, wasExecuting });
		},
		onExpired: (task, waitTimeMs) => {
			expiredCalls.push({ task, waitTimeMs });
		},
	};

	return {
		callbacks,
		queuedCalls,
		dequeuedCalls,
		drainedCalls,
		cancelledCalls,
		expiredCalls,
	};
}

/** Flush microtasks and short timers. */
async function flush(ms = 10): Promise<void> {
	await new Promise<void>((r) => setTimeout(r, ms));
}

// ════════════════════════════════════════════════════════════════════════════
// TaskQueue Unit Tests
// ════════════════════════════════════════════════════════════════════════════

describe("TaskQueue", () => {
	const logger = silentLogger();

	// ── Test 1: enqueue returns a valid TaskHandle ─────────────────────

	it("enqueue returns a TaskHandle with id, position, completion, and cancel", async () => {
		const { callbacks } = createMockCallbacks();
		const executor = async (task: string) => makeMockResult(task);
		const queue = new TaskQueue(
			executor,
			callbacks,
			{ maxConcurrent: 1 },
			logger,
		);

		const handle = queue.enqueue("test task");

		expect(handle.id).toBeTruthy();
		expect(typeof handle.id).toBe("string");
		expect(handle.position).toBe(0);
		expect(handle.completion).toBeInstanceOf(Promise);
		expect(typeof handle.cancel).toBe("function");

		// Wait for completion
		const result = await handle.completion;
		expect(result.task).toBe("test task");
	});

	// ── Test 2: Tasks are executed in FIFO order ──────────────────────

	it("executes tasks in FIFO order with maxConcurrent: 1", async () => {
		const { callbacks } = createMockCallbacks();
		const executionOrder: string[] = [];

		// Use a blocking executor to control sequencing
		const blockers: Array<{
			resolve: (val: AgentPoolResult) => void;
		}> = [];

		const executor = async (task: string): Promise<AgentPoolResult> => {
			const d = deferred<AgentPoolResult>();
			blockers.push(d);
			executionOrder.push(task);
			return d.promise;
		};

		const queue = new TaskQueue(
			executor,
			callbacks,
			{ maxConcurrent: 1 },
			logger,
		);

		const h1 = queue.enqueue("task-A");
		const h2 = queue.enqueue("task-B");
		const h3 = queue.enqueue("task-C");

		// Wait for drain to start the first task
		await flush();

		// Only task-A should have started
		expect(executionOrder).toEqual(["task-A"]);

		// Complete task-A
		blockers[0]!.resolve(makeMockResult("task-A"));
		await flush();

		// task-B should start
		expect(executionOrder).toEqual(["task-A", "task-B"]);

		// Complete task-B
		blockers[1]!.resolve(makeMockResult("task-B"));
		await flush();

		// task-C should start
		expect(executionOrder).toEqual(["task-A", "task-B", "task-C"]);

		// Complete task-C
		blockers[2]!.resolve(makeMockResult("task-C"));

		const [r1, r2, r3] = await Promise.all([
			h1.completion,
			h2.completion,
			h3.completion,
		]);

		expect(r1.task).toBe("task-A");
		expect(r2.task).toBe("task-B");
		expect(r3.task).toBe("task-C");
	});

	// ── Test 3: Priority overrides FIFO order ─────────────────────────

	it("priority overrides FIFO order", async () => {
		const { callbacks } = createMockCallbacks();
		const executionOrder: string[] = [];

		const blockers: Array<{
			resolve: (val: AgentPoolResult) => void;
		}> = [];

		const executor = async (task: string): Promise<AgentPoolResult> => {
			const d = deferred<AgentPoolResult>();
			blockers.push(d);
			executionOrder.push(task);
			return d.promise;
		};

		const queue = new TaskQueue(
			executor,
			callbacks,
			{ maxConcurrent: 1 },
			logger,
		);

		// First, enqueue a blocking task so the rest go into the pending queue
		const h0 = queue.enqueue("blocking-task");
		await flush();

		// Now enqueue 3 tasks with different priorities while slot is busy
		const hA = queue.enqueue("task-A", { priority: 0 });
		const hB = queue.enqueue("task-B", { priority: 10 });
		const hC = queue.enqueue("task-C", { priority: 5 });

		// Complete the blocking task
		blockers[0]!.resolve(makeMockResult("blocking-task"));
		await flush();

		// task-B (priority 10) should run first
		expect(executionOrder[1]).toBe("task-B");

		// Complete task-B
		blockers[1]!.resolve(makeMockResult("task-B"));
		await flush();

		// task-C (priority 5) should run second
		expect(executionOrder[2]).toBe("task-C");

		// Complete task-C
		blockers[2]!.resolve(makeMockResult("task-C"));
		await flush();

		// task-A (priority 0) should run last
		expect(executionOrder[3]).toBe("task-A");

		// Complete task-A
		blockers[3]!.resolve(makeMockResult("task-A"));

		await Promise.all([
			h0.completion,
			hA.completion,
			hB.completion,
			hC.completion,
		]);
	});

	// ── Test 4: FIFO within same priority ─────────────────────────────

	it("maintains FIFO order within the same priority", async () => {
		const { callbacks } = createMockCallbacks();
		const executionOrder: string[] = [];

		const blockers: Array<{
			resolve: (val: AgentPoolResult) => void;
		}> = [];

		const executor = async (task: string): Promise<AgentPoolResult> => {
			const d = deferred<AgentPoolResult>();
			blockers.push(d);
			executionOrder.push(task);
			return d.promise;
		};

		const queue = new TaskQueue(
			executor,
			callbacks,
			{ maxConcurrent: 1 },
			logger,
		);

		// Block the first slot
		queue.enqueue("blocker");
		await flush();

		// Enqueue 3 tasks with same priority
		queue.enqueue("task-A", { priority: 5 });
		queue.enqueue("task-B", { priority: 5 });
		queue.enqueue("task-C", { priority: 5 });

		// Release blocker
		blockers[0]!.resolve(makeMockResult("blocker"));
		await flush();

		expect(executionOrder[1]).toBe("task-A");
		blockers[1]!.resolve(makeMockResult("task-A"));
		await flush();

		expect(executionOrder[2]).toBe("task-B");
		blockers[2]!.resolve(makeMockResult("task-B"));
		await flush();

		expect(executionOrder[3]).toBe("task-C");
		blockers[3]!.resolve(makeMockResult("task-C"));

		await flush();
	});

	// ── Test 5: maxConcurrent: 2 executes two tasks in parallel ───────

	it("maxConcurrent: 2 starts two tasks immediately", async () => {
		const { callbacks } = createMockCallbacks();
		const executionOrder: string[] = [];

		const blockers: Array<{
			resolve: (val: AgentPoolResult) => void;
		}> = [];

		const executor = async (task: string): Promise<AgentPoolResult> => {
			const d = deferred<AgentPoolResult>();
			blockers.push(d);
			executionOrder.push(task);
			return d.promise;
		};

		const queue = new TaskQueue(
			executor,
			callbacks,
			{ maxConcurrent: 2 },
			logger,
		);

		queue.enqueue("task-A");
		queue.enqueue("task-B");
		await flush();

		// Both tasks should have started immediately
		expect(executionOrder).toEqual(["task-A", "task-B"]);
		expect(queue.executingCount).toBe(2);
		expect(queue.pendingCount).toBe(0);

		// Complete both
		blockers[0]!.resolve(makeMockResult("task-A"));
		blockers[1]!.resolve(makeMockResult("task-B"));
		await flush();
	});

	// ── Test 6: maxConcurrent: 2 queues the 3rd task ─────────────────

	it("maxConcurrent: 2 queues the 3rd task and processes it when a slot frees", async () => {
		const { callbacks } = createMockCallbacks();
		const executionOrder: string[] = [];

		const blockers: Array<{
			resolve: (val: AgentPoolResult) => void;
		}> = [];

		const executor = async (task: string): Promise<AgentPoolResult> => {
			const d = deferred<AgentPoolResult>();
			blockers.push(d);
			executionOrder.push(task);
			return d.promise;
		};

		const queue = new TaskQueue(
			executor,
			callbacks,
			{ maxConcurrent: 2 },
			logger,
		);

		const h1 = queue.enqueue("task-A");
		const h2 = queue.enqueue("task-B");
		const h3 = queue.enqueue("task-C");

		await flush();

		// Only 2 should be executing, 1 pending
		expect(executionOrder).toEqual(["task-A", "task-B"]);
		expect(queue.executingCount).toBe(2);
		expect(queue.pendingCount).toBe(1);

		// Check task-C is queued
		const state = queue.getState();
		expect(state.pendingTasks.length).toBe(1);
		expect(state.pendingTasks[0]!.task).toBe("task-C");

		// Complete task-A → task-C should start
		blockers[0]!.resolve(makeMockResult("task-A"));
		await flush();

		expect(executionOrder).toEqual(["task-A", "task-B", "task-C"]);
		expect(queue.executingCount).toBe(2);
		expect(queue.pendingCount).toBe(0);

		// Complete remaining
		blockers[1]!.resolve(makeMockResult("task-B"));
		blockers[2]!.resolve(makeMockResult("task-C"));

		await Promise.all([h1.completion, h2.completion, h3.completion]);
	});

	// ── Test 7: maxQueueSize rejects excess tasks ─────────────────────

	it("maxQueueSize rejects tasks when the pending queue is full", async () => {
		const { callbacks } = createMockCallbacks();

		const blockers: Array<{
			resolve: (val: AgentPoolResult) => void;
		}> = [];

		const executor = async (_task: string): Promise<AgentPoolResult> => {
			const d = deferred<AgentPoolResult>();
			blockers.push(d);
			return d.promise;
		};

		const queue = new TaskQueue(
			executor,
			callbacks,
			{ maxConcurrent: 1, maxQueueSize: 2 },
			logger,
		);

		// 1 executing + 2 pending = OK
		queue.enqueue("task-1");
		await flush(); // task-1 starts executing
		queue.enqueue("task-2"); // pending
		queue.enqueue("task-3"); // pending

		// 4th task should throw
		expect(() => queue.enqueue("task-4")).toThrow("TaskQueue is full");

		// Cleanup
		for (const b of blockers) {
			b.resolve(makeMockResult("x"));
		}
		await flush();
	});

	// ── Test 8: cancelTask cancels a pending task ─────────────────────

	it("cancelTask cancels a pending task and rejects its completion promise", async () => {
		const { callbacks, cancelledCalls } = createMockCallbacks();

		const blockers: Array<{
			resolve: (val: AgentPoolResult) => void;
		}> = [];

		const executor = async (_task: string): Promise<AgentPoolResult> => {
			const d = deferred<AgentPoolResult>();
			blockers.push(d);
			return d.promise;
		};

		const queue = new TaskQueue(
			executor,
			callbacks,
			{ maxConcurrent: 1 },
			logger,
		);

		queue.enqueue("task-1");
		const h2 = queue.enqueue("task-2");
		await flush();

		// task-2 is pending
		const cancelled = await queue.cancelTask(h2.id);
		expect(cancelled).toBe(true);

		// The completion promise should reject
		await expect(h2.completion).rejects.toThrow("Task cancelled");

		// Callback should have been called
		expect(cancelledCalls.length).toBe(1);
		expect(cancelledCalls[0]!.task.id).toBe(h2.id);
		expect(cancelledCalls[0]!.wasExecuting).toBe(false);

		// The task status should be cancelled
		const taskState = queue.getTask(h2.id);
		expect(taskState?.status).toBe("cancelled");

		// Cleanup
		blockers[0]!.resolve(makeMockResult("task-1"));
		await flush();
	});

	// ── Test 9: cancelTask cancels an executing task ──────────────────

	it("cancelTask cancels an executing task and signals abort", async () => {
		const { callbacks, cancelledCalls } = createMockCallbacks();

		const blockers: Array<{
			resolve: (val: AgentPoolResult) => void;
		}> = [];

		const executor = async (_task: string): Promise<AgentPoolResult> => {
			const d = deferred<AgentPoolResult>();
			blockers.push(d);
			return d.promise;
		};

		const queue = new TaskQueue(
			executor,
			callbacks,
			{ maxConcurrent: 1 },
			logger,
		);

		const h1 = queue.enqueue("task-1");
		await flush();

		// task-1 is executing
		expect(queue.executingCount).toBe(1);

		const cancelled = await queue.cancelTask(h1.id);
		expect(cancelled).toBe(true);

		// Callback
		expect(cancelledCalls.length).toBe(1);
		expect(cancelledCalls[0]!.wasExecuting).toBe(true);

		// Completion should reject
		await expect(h1.completion).rejects.toThrow("Task cancelled");

		// The executing set should be cleared
		expect(queue.executingCount).toBe(0);
	});

	// ── Test 10: cancelTask returns false for a completed task ────────

	it("cancelTask returns false for an already-completed task", async () => {
		const { callbacks } = createMockCallbacks();
		const executor = async (task: string) => makeMockResult(task);
		const queue = new TaskQueue(
			executor,
			callbacks,
			{ maxConcurrent: 1 },
			logger,
		);

		const handle = queue.enqueue("fast-task");
		const result = await handle.completion;
		expect(result.task).toBe("fast-task");

		const cancelled = await handle.cancel();
		expect(cancelled).toBe(false);
	});

	// ── Test 11: queueTimeoutMs expires pending tasks ─────────────────

	it("queueTimeoutMs expires tasks that wait too long", async () => {
		const { callbacks, expiredCalls } = createMockCallbacks();

		const blockers: Array<{
			resolve: (val: AgentPoolResult) => void;
		}> = [];

		const executor = async (_task: string): Promise<AgentPoolResult> => {
			const d = deferred<AgentPoolResult>();
			blockers.push(d);
			return d.promise;
		};

		const queue = new TaskQueue(
			executor,
			callbacks,
			{ maxConcurrent: 1, queueTimeoutMs: 50 },
			logger,
		);

		const h1 = queue.enqueue("task-1"); // executing
		const h2 = queue.enqueue("task-2"); // pending, will timeout

		// Attach catch handler immediately to avoid unhandled rejection
		const h2Rejection = h2.completion.catch((e) => e);

		await flush();

		// Wait for the timeout to fire
		await new Promise<void>((r) => setTimeout(r, 80));

		// task-2 should be expired
		expect(expiredCalls.length).toBe(1);
		expect(expiredCalls[0]!.task.id).toBe(h2.id);

		const taskState = queue.getTask(h2.id);
		expect(taskState?.status).toBe("expired");

		// Completion should reject
		const error = await h2Rejection;
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("expired");

		// Cleanup
		blockers[0]!.resolve(makeMockResult("task-1"));
		await h1.completion;
		await flush();
	});

	// ── Test 12: Timeout is cleared when the task starts ──────────────

	it("timeout is cleared when the task starts executing", async () => {
		const { callbacks, expiredCalls } = createMockCallbacks();
		const executor = async (task: string) => {
			// Simulate work that takes longer than the queue timeout
			await new Promise<void>((r) => setTimeout(r, 80));
			return makeMockResult(task);
		};

		const queue = new TaskQueue(
			executor,
			callbacks,
			{ maxConcurrent: 1, queueTimeoutMs: 200 },
			logger,
		);

		const handle = queue.enqueue("task-1");
		await flush();

		// The task starts immediately (no wait in queue), timeout should be cleared
		// Wait past the timeout period
		await new Promise<void>((r) => setTimeout(r, 250));

		// Task should NOT be expired — it started immediately
		expect(expiredCalls.length).toBe(0);

		const result = await handle.completion;
		expect(result.task).toBe("task-1");
	});

	// ── Test 13: shutdown cancels pending tasks ───────────────────────

	it("shutdown(false) cancels all pending and executing tasks", async () => {
		const { callbacks, cancelledCalls } = createMockCallbacks();

		const blockers: Array<{
			resolve: (val: AgentPoolResult) => void;
		}> = [];

		const executor = async (_task: string): Promise<AgentPoolResult> => {
			const d = deferred<AgentPoolResult>();
			blockers.push(d);
			return d.promise;
		};

		const queue = new TaskQueue(
			executor,
			callbacks,
			{ maxConcurrent: 1 },
			logger,
		);

		const h1 = queue.enqueue("task-1"); // executing
		const h2 = queue.enqueue("task-2"); // pending
		const h3 = queue.enqueue("task-3"); // pending

		// Attach catch handlers immediately to avoid unhandled rejections
		const h1Rejection = h1.completion.catch((e) => e);
		const h2Rejection = h2.completion.catch((e) => e);
		const h3Rejection = h3.completion.catch((e) => e);

		await flush();

		await queue.shutdown(false);

		// All 3 should be cancelled
		expect(cancelledCalls.length).toBe(3);

		expect(queue.isAccepting).toBe(false);

		// Completion promises should all reject with cancellation error
		const e1 = await h1Rejection;
		const e2 = await h2Rejection;
		const e3 = await h3Rejection;
		expect(e1).toBeInstanceOf(Error);
		expect((e1 as Error).message).toContain("cancelled");
		expect(e2).toBeInstanceOf(Error);
		expect((e2 as Error).message).toContain("cancelled");
		expect(e3).toBeInstanceOf(Error);
		expect((e3 as Error).message).toContain("cancelled");
	});

	// ── Test 14: shutdown(true) waits for executing tasks ─────────────

	it("shutdown(true) waits for executing tasks to complete", async () => {
		const { callbacks } = createMockCallbacks();

		let executorResolve: ((val: AgentPoolResult) => void) | null = null;

		const executor = async (_task: string): Promise<AgentPoolResult> => {
			return new Promise((resolve) => {
				executorResolve = resolve;
			});
		};

		const queue = new TaskQueue(
			executor,
			callbacks,
			{ maxConcurrent: 1 },
			logger,
		);

		const h1 = queue.enqueue("task-1"); // executing
		const h2 = queue.enqueue("task-2"); // pending

		// Attach catch handler immediately to avoid unhandled rejection
		const h2Rejection = h2.completion.catch((e) => e);

		await flush();

		// Start shutdown in background
		let shutdownDone = false;
		const shutdownPromise = queue.shutdown(true).then(() => {
			shutdownDone = true;
		});

		await flush(50);

		// Pending tasks should be cancelled
		const h2Error = await h2Rejection;
		expect(h2Error).toBeInstanceOf(Error);
		expect((h2Error as Error).message).toContain("cancelled");

		// But executing task should NOT be cancelled yet
		expect(shutdownDone).toBe(false);

		// Complete the executing task
		executorResolve!(makeMockResult("task-1"));
		await flush(200);
		await shutdownPromise;

		expect(shutdownDone).toBe(true);

		// The executing task should have completed (not cancelled)
		const result = await h1.completion;
		expect(result.task).toBe("task-1");
	});

	// ── Test 15: shutdown prevents new enqueue calls ──────────────────

	it("shutdown prevents new enqueue calls", async () => {
		const { callbacks } = createMockCallbacks();
		const executor = async (task: string) => makeMockResult(task);

		const queue = new TaskQueue(
			executor,
			callbacks,
			{ maxConcurrent: 1 },
			logger,
		);

		await queue.shutdown(false);

		expect(() => queue.enqueue("new task")).toThrow(
			"TaskQueue has been shut down",
		);
	});

	// ── Test 16: getState returns correct snapshot ────────────────────

	it("getState returns a correct snapshot of queue state", async () => {
		const { callbacks } = createMockCallbacks();

		const blockers: Array<{
			resolve: (val: AgentPoolResult) => void;
		}> = [];

		const executor = async (_task: string): Promise<AgentPoolResult> => {
			const d = deferred<AgentPoolResult>();
			blockers.push(d);
			return d.promise;
		};

		const queue = new TaskQueue(
			executor,
			callbacks,
			{ maxConcurrent: 1, maxQueueSize: 10 },
			logger,
		);

		const _h1 = queue.enqueue("executing-task");
		const _h2 = queue.enqueue("pending-1");
		const _h3 = queue.enqueue("pending-2");
		await flush();

		const state = queue.getState();

		expect(state.pendingCount).toBe(2);
		expect(state.executingCount).toBe(1);
		expect(state.processedCount).toBe(0);
		expect(state.maxConcurrent).toBe(1);

		expect(state.pendingTasks.length).toBe(2);
		expect(state.pendingTasks[0]!.task).toBe("pending-1");
		expect(state.pendingTasks[1]!.task).toBe("pending-2");

		expect(state.executingTasks.length).toBe(1);
		expect(state.executingTasks[0]!.task).toBe("executing-task");
		expect(state.executingTasks[0]!.startedAt).toBeTruthy();

		// Cleanup
		for (const b of blockers) {
			b.resolve(makeMockResult("x"));
		}
		await flush();
	});

	// ── Test 17: pruneCompleted cleans up old tasks ───────────────────

	it("pruneCompleted removes old completed tasks beyond the retention limit", async () => {
		const { callbacks } = createMockCallbacks();
		let _callCount = 0;

		const executor = async (task: string): Promise<AgentPoolResult> => {
			_callCount++;
			return makeMockResult(task);
		};

		const queue = new TaskQueue(
			executor,
			callbacks,
			{ maxConcurrent: 10 }, // High concurrency so all run fast
			logger,
		);

		// Enqueue 20 tasks
		const handles = [];
		for (let i = 0; i < 20; i++) {
			handles.push(queue.enqueue(`task-${i}`));
		}

		// Wait for all to complete
		await Promise.all(handles.map((h) => h.completion));
		await flush();

		// pruneCompleted is called automatically after each task
		// but let's call it explicitly with a small limit
		queue.pruneCompleted(5);

		// Only the 5 most recent should be retained
		let foundCount = 0;
		for (let i = 0; i < 20; i++) {
			const task = queue.getTask(handles[i]!.id);
			if (task) foundCount++;
		}

		expect(foundCount).toBe(5);
	});

	// ── Test 18: onDrained callback is called when all tasks complete ─

	it("onDrained is called when all tasks are completed", async () => {
		const { callbacks, drainedCalls } = createMockCallbacks();
		const executor = async (task: string) => makeMockResult(task);

		const queue = new TaskQueue(
			executor,
			callbacks,
			{ maxConcurrent: 2 },
			logger,
		);

		const h1 = queue.enqueue("task-1");
		const h2 = queue.enqueue("task-2");
		const h3 = queue.enqueue("task-3");

		await Promise.all([h1.completion, h2.completion, h3.completion]);
		await flush();

		expect(drainedCalls.length).toBeGreaterThanOrEqual(1);
		const lastDrain = drainedCalls[drainedCalls.length - 1]!;
		expect(lastDrain.total).toBe(3);
		expect(lastDrain.succeeded).toBe(3);
		expect(lastDrain.failed).toBe(0);
		expect(lastDrain.cancelled).toBe(0);
	});

	// ── Test 19: Failed tasks don't block subsequent tasks ────────────

	it("a failed task does not prevent subsequent tasks from running", async () => {
		const { callbacks } = createMockCallbacks();
		let callIndex = 0;

		const executor = async (task: string): Promise<AgentPoolResult> => {
			callIndex++;
			if (callIndex === 2) {
				throw new Error("Intentional failure");
			}
			return makeMockResult(task);
		};

		const queue = new TaskQueue(
			executor,
			callbacks,
			{ maxConcurrent: 1 },
			logger,
		);

		const h1 = queue.enqueue("task-1"); // succeeds
		const h2 = queue.enqueue("task-2"); // fails
		const h3 = queue.enqueue("task-3"); // succeeds

		// task-1 should succeed
		const r1 = await h1.completion;
		expect(r1.task).toBe("task-1");

		// task-2 should fail
		await expect(h2.completion).rejects.toThrow("Intentional failure");

		// task-3 should still succeed
		const r3 = await h3.completion;
		expect(r3.task).toBe("task-3");

		expect(queue.processedCount).toBe(3);
	});

	// ── Test 20: Drain does not cause reentrance or stack overflow ────

	it("rapid enqueue does not cause reentrance issues", async () => {
		const { callbacks } = createMockCallbacks();
		const executor = async (task: string) => makeMockResult(task);

		const queue = new TaskQueue(
			executor,
			callbacks,
			{ maxConcurrent: 1 },
			logger,
		);

		// Rapidly enqueue many tasks
		const handles = [];
		for (let i = 0; i < 50; i++) {
			handles.push(queue.enqueue(`task-${i}`));
		}

		// Wait for all to complete without error
		const results = await Promise.all(handles.map((h) => h.completion));
		expect(results.length).toBe(50);
		expect(results.every((r) => r.task.startsWith("task-"))).toBe(true);
		expect(queue.processedCount).toBe(50);
	});

	// ── Additional edge case tests ────────────────────────────────────

	describe("Edge Cases", () => {
		it("getTask returns null for unknown task ID", () => {
			const { callbacks } = createMockCallbacks();
			const executor = async (task: string) => makeMockResult(task);
			const queue = new TaskQueue(
				executor,
				callbacks,
				{ maxConcurrent: 1 },
				logger,
			);

			expect(queue.getTask("nonexistent")).toBeNull();
		});

		it("cancelTask returns false for unknown task ID", async () => {
			const { callbacks } = createMockCallbacks();
			const executor = async (task: string) => makeMockResult(task);
			const queue = new TaskQueue(
				executor,
				callbacks,
				{ maxConcurrent: 1 },
				logger,
			);

			const result = await queue.cancelTask("nonexistent");
			expect(result).toBe(false);
		});

		it("hasAvailableSlot reflects current state", async () => {
			const { callbacks } = createMockCallbacks();

			const blockers: Array<{
				resolve: (val: AgentPoolResult) => void;
			}> = [];

			const executor = async (_task: string): Promise<AgentPoolResult> => {
				const d = deferred<AgentPoolResult>();
				blockers.push(d);
				return d.promise;
			};

			const queue = new TaskQueue(
				executor,
				callbacks,
				{ maxConcurrent: 2 },
				logger,
			);

			expect(queue.hasAvailableSlot).toBe(true);

			queue.enqueue("task-1");
			await flush();
			expect(queue.hasAvailableSlot).toBe(true); // 1/2 slots used

			queue.enqueue("task-2");
			await flush();
			expect(queue.hasAvailableSlot).toBe(false); // 2/2 slots used

			// Free a slot
			blockers[0]!.resolve(makeMockResult("task-1"));
			await flush();
			expect(queue.hasAvailableSlot).toBe(true); // 1/2 slots used

			// Cleanup
			blockers[1]!.resolve(makeMockResult("task-2"));
			await flush();
		});

		it("default priority is used when none is specified", async () => {
			const { callbacks, queuedCalls } = createMockCallbacks();
			const executor = async (task: string) => makeMockResult(task);
			const queue = new TaskQueue(
				executor,
				callbacks,
				{ maxConcurrent: 10, defaultPriority: 42 },
				logger,
			);

			queue.enqueue("task-with-default-priority");
			await flush();

			expect(queuedCalls.length).toBe(1);
			expect(queuedCalls[0]!.task.priority).toBe(42);
		});

		it("callbacks are invoked with correct data", async () => {
			const { callbacks, queuedCalls, dequeuedCalls } = createMockCallbacks();
			const executor = async (task: string) => makeMockResult(task);

			const queue = new TaskQueue(
				executor,
				callbacks,
				{ maxConcurrent: 1 },
				logger,
			);

			queue.enqueue("callback-test", { priority: 7 });
			await flush();

			// onQueued should have been called
			expect(queuedCalls.length).toBe(1);
			expect(queuedCalls[0]!.task.task).toBe("callback-test");
			expect(queuedCalls[0]!.task.priority).toBe(7);
			expect(queuedCalls[0]!.task.status).toBe("queued");
			expect(queuedCalls[0]!.position).toBe(0);
			expect(queuedCalls[0]!.queueSize).toBe(1);

			// Wait for completion — onDequeued should have been called
			await flush(50);
			expect(dequeuedCalls.length).toBe(1);
			expect(dequeuedCalls[0]!.task.task).toBe("callback-test");
		});

		it("cancelTask on a cancelled task returns false", async () => {
			const { callbacks } = createMockCallbacks();

			const blockers: Array<{
				resolve: (val: AgentPoolResult) => void;
			}> = [];

			const executor = async (_task: string): Promise<AgentPoolResult> => {
				const d = deferred<AgentPoolResult>();
				blockers.push(d);
				return d.promise;
			};

			const queue = new TaskQueue(
				executor,
				callbacks,
				{ maxConcurrent: 1 },
				logger,
			);

			const h1 = queue.enqueue("blocker");
			const h2 = queue.enqueue("to-cancel");

			// Attach catch handler immediately to avoid unhandled rejection
			h2.completion.catch(() => {});

			await flush();

			// Cancel once
			const first = await queue.cancelTask(h2.id);
			expect(first).toBe(true);

			// Cancel again — should return false
			const second = await queue.cancelTask(h2.id);
			expect(second).toBe(false);

			// Cleanup
			blockers[0]!.resolve(makeMockResult("blocker"));
			await h1.completion;
			await flush();
		});

		it("cancelTask on an expired task returns false", async () => {
			const { callbacks } = createMockCallbacks();

			const blockers: Array<{
				resolve: (val: AgentPoolResult) => void;
			}> = [];

			const executor = async (_task: string): Promise<AgentPoolResult> => {
				const d = deferred<AgentPoolResult>();
				blockers.push(d);
				return d.promise;
			};

			const queue = new TaskQueue(
				executor,
				callbacks,
				{ maxConcurrent: 1, queueTimeoutMs: 30 },
				logger,
			);

			const h1 = queue.enqueue("blocker");
			const h2 = queue.enqueue("will-expire");

			// Attach catch handler immediately to avoid unhandled rejection
			h2.completion.catch(() => {});

			await flush();

			// Wait for expiration
			await new Promise<void>((r) => setTimeout(r, 60));

			// Task should be expired now
			const taskState = queue.getTask(h2.id);
			expect(taskState?.status).toBe("expired");

			// Cancelling an expired task returns false
			const result = await queue.cancelTask(h2.id);
			expect(result).toBe(false);

			// Cleanup
			blockers[0]!.resolve(makeMockResult("blocker"));
			await h1.completion;
			await flush();
		});

		it("mixed priorities and concurrency work correctly", async () => {
			const { callbacks } = createMockCallbacks();
			const executionOrder: string[] = [];

			const blockers: Array<{
				resolve: (val: AgentPoolResult) => void;
			}> = [];

			const executor = async (task: string): Promise<AgentPoolResult> => {
				const d = deferred<AgentPoolResult>();
				blockers.push(d);
				executionOrder.push(task);
				return d.promise;
			};

			const queue = new TaskQueue(
				executor,
				callbacks,
				{ maxConcurrent: 2 },
				logger,
			);

			// Fill both slots
			queue.enqueue("slot-1");
			queue.enqueue("slot-2");
			await flush();

			// Queue tasks with different priorities
			queue.enqueue("low", { priority: 1 });
			queue.enqueue("high", { priority: 100 });
			queue.enqueue("medium", { priority: 50 });

			expect(executionOrder).toEqual(["slot-1", "slot-2"]);

			// Free both slots
			blockers[0]!.resolve(makeMockResult("slot-1"));
			blockers[1]!.resolve(makeMockResult("slot-2"));
			await flush();

			// high (100) and medium (50) should start (2 slots)
			expect(executionOrder).toEqual(["slot-1", "slot-2", "high", "medium"]);

			// Free a slot
			blockers[2]!.resolve(makeMockResult("high"));
			await flush();

			// low (1) should start
			expect(executionOrder).toEqual([
				"slot-1",
				"slot-2",
				"high",
				"medium",
				"low",
			]);

			// Cleanup
			blockers[3]!.resolve(makeMockResult("medium"));
			blockers[4]!.resolve(makeMockResult("low"));
			await flush();
		});

		it("getState handles empty queue correctly", () => {
			const { callbacks } = createMockCallbacks();
			const executor = async (task: string) => makeMockResult(task);
			const queue = new TaskQueue(
				executor,
				callbacks,
				{ maxConcurrent: 1 },
				logger,
			);

			const state = queue.getState();
			expect(state.pendingCount).toBe(0);
			expect(state.executingCount).toBe(0);
			expect(state.processedCount).toBe(0);
			expect(state.maxConcurrent).toBe(1);
			expect(state.pendingTasks).toEqual([]);
			expect(state.executingTasks).toEqual([]);
		});

		it("QueuedTask fields are correctly populated through lifecycle", async () => {
			const { callbacks } = createMockCallbacks();

			const blockers: Array<{
				resolve: (val: AgentPoolResult) => void;
			}> = [];

			const executor = async (_task: string): Promise<AgentPoolResult> => {
				const d = deferred<AgentPoolResult>();
				blockers.push(d);
				return d.promise;
			};

			const queue = new TaskQueue(
				executor,
				callbacks,
				{ maxConcurrent: 1 },
				logger,
			);

			const handle = queue.enqueue("lifecycle-test", { priority: 3 });
			await flush();

			// Check executing state
			let task = queue.getTask(handle.id);
			expect(task).not.toBeNull();
			expect(task!.task).toBe("lifecycle-test");
			expect(task!.priority).toBe(3);
			expect(task!.status).toBe("executing");
			expect(task!.submittedAt).toBeTruthy();
			expect(task!.startedAt).toBeTruthy();
			expect(task!.completedAt).toBeNull();
			expect(task!.result).toBeNull();
			expect(task!.error).toBeNull();

			// Complete the task
			const mockResult = makeMockResult("lifecycle-test");
			blockers[0]!.resolve(mockResult);
			await handle.completion;
			await flush();

			// Check completed state
			task = queue.getTask(handle.id);
			expect(task!.status).toBe("completed");
			expect(task!.completedAt).toBeTruthy();
			expect(task!.result).not.toBeNull();
			expect(task!.result!.task).toBe("lifecycle-test");
			expect(task!.error).toBeNull();
		});

		it("failed task has error field populated", async () => {
			const { callbacks } = createMockCallbacks();

			const executor = async (_task: string): Promise<AgentPoolResult> => {
				throw new Error("Execution failed badly");
			};

			const queue = new TaskQueue(
				executor,
				callbacks,
				{ maxConcurrent: 1 },
				logger,
			);

			const handle = queue.enqueue("will-fail");
			await expect(handle.completion).rejects.toThrow("Execution failed badly");
			await flush();

			const task = queue.getTask(handle.id);
			expect(task!.status).toBe("failed");
			expect(task!.error).toBe("Execution failed badly");
			expect(task!.completedAt).toBeTruthy();
		});

		it("pruneCompleted is a no-op when under the limit", async () => {
			const { callbacks } = createMockCallbacks();
			const executor = async (task: string) => makeMockResult(task);
			const queue = new TaskQueue(
				executor,
				callbacks,
				{ maxConcurrent: 10 },
				logger,
			);

			// Complete 3 tasks
			const handles = [
				queue.enqueue("a"),
				queue.enqueue("b"),
				queue.enqueue("c"),
			];
			await Promise.all(handles.map((h) => h.completion));
			await flush();

			// Prune with limit higher than count — no-op
			queue.pruneCompleted(50);

			// All 3 should still be retrievable
			for (const h of handles) {
				expect(queue.getTask(h.id)).not.toBeNull();
			}
		});

		it("maxConcurrent defaults to 1", async () => {
			const { callbacks } = createMockCallbacks();
			const executionOrder: string[] = [];

			const blockers: Array<{
				resolve: (val: AgentPoolResult) => void;
			}> = [];

			const executor = async (task: string): Promise<AgentPoolResult> => {
				const d = deferred<AgentPoolResult>();
				blockers.push(d);
				executionOrder.push(task);
				return d.promise;
			};

			// No maxConcurrent specified — should default to 1
			const queue = new TaskQueue(executor, callbacks, {}, logger);

			queue.enqueue("task-1");
			queue.enqueue("task-2");
			await flush();

			// Only one should be executing
			expect(executionOrder).toEqual(["task-1"]);
			expect(queue.getState().maxConcurrent).toBe(1);

			// Cleanup
			for (const b of blockers) {
				b.resolve(makeMockResult("x"));
			}
			await flush();
		});

		it("handle.cancel() delegates to cancelTask", async () => {
			const { callbacks, cancelledCalls } = createMockCallbacks();

			const blockers: Array<{
				resolve: (val: AgentPoolResult) => void;
			}> = [];

			const executor = async (_task: string): Promise<AgentPoolResult> => {
				const d = deferred<AgentPoolResult>();
				blockers.push(d);
				return d.promise;
			};

			const queue = new TaskQueue(
				executor,
				callbacks,
				{ maxConcurrent: 1 },
				logger,
			);

			const h1 = queue.enqueue("blocker");
			const h2 = queue.enqueue("to-cancel-via-handle");

			// Attach catch handler immediately to avoid unhandled rejection
			h2.completion.catch(() => {});

			await flush();

			const result = await h2.cancel();
			expect(result).toBe(true);
			expect(cancelledCalls.length).toBe(1);

			// Cleanup
			blockers[0]!.resolve(makeMockResult("blocker"));
			await h1.completion;
			await flush();
		});

		it("onDrained includes cancelled count", async () => {
			const { callbacks, drainedCalls } = createMockCallbacks();
			const executor = async (task: string) => makeMockResult(task);

			const queue = new TaskQueue(
				executor,
				callbacks,
				{ maxConcurrent: 1 },
				logger,
			);

			// This one starts executing immediately
			const h1 = queue.enqueue("task-1");
			await flush();

			// These are queued
			const h2 = queue.enqueue("task-2");
			const h3 = queue.enqueue("task-3");

			// Attach catch handler before cancelling to avoid unhandled rejection
			h3.completion.catch(() => {});

			// Cancel task-3
			await h3.cancel();

			// Wait for remaining tasks
			await h1.completion;
			await h2.completion;
			await flush(50);

			// Drain should reflect 1 cancelled
			const lastDrain = drainedCalls[drainedCalls.length - 1]!;
			expect(lastDrain.succeeded).toBe(2);
			expect(lastDrain.cancelled).toBe(1);
		});

		it("cancelAll cancels all pending and executing tasks", async () => {
			const { callbacks, cancelledCalls } = createMockCallbacks();
			const blockers = [
				deferred<AgentPoolResult>(),
				deferred<AgentPoolResult>(),
				deferred<AgentPoolResult>(),
			];
			let callIdx = 0;
			const executor = async (_task: string) => {
				const d = blockers[callIdx++]!;
				return d.promise;
			};

			const queue = new TaskQueue(
				executor,
				callbacks,
				{ maxConcurrent: 1 },
				logger,
			);

			const h1 = queue.enqueue("task-1");
			await flush();
			const h2 = queue.enqueue("task-2");
			const h3 = queue.enqueue("task-3");

			h1.completion.catch(() => {});
			h2.completion.catch(() => {});
			h3.completion.catch(() => {});

			// h1 is executing, h2 and h3 are pending
			expect(queue.executingCount).toBe(1);
			expect(queue.pendingCount).toBe(2);

			const cancelledCount = await queue.cancelAll();

			// All 3 should be cancelled (1 executing + 2 pending)
			expect(cancelledCount).toBe(3);
			expect(cancelledCalls.length).toBe(3);

			// The executing task should have wasExecuting = true
			const executingCancel = cancelledCalls.find((c) => c.wasExecuting);
			expect(executingCancel).toBeTruthy();
			expect(executingCancel!.task.id).toBe(h1.id);

			// Pending tasks should have wasExecuting = false
			const pendingCancels = cancelledCalls.filter((c) => !c.wasExecuting);
			expect(pendingCancels.length).toBe(2);
		});

		it("cancelAll keeps the queue open for new submissions", async () => {
			const { callbacks } = createMockCallbacks();
			const blocker = deferred<AgentPoolResult>();
			let useBlocker = true;

			const executor = async (task: string) => {
				if (useBlocker) {
					return blocker.promise;
				}
				return makeMockResult(task);
			};

			const queue = new TaskQueue(
				executor,
				callbacks,
				{ maxConcurrent: 1 },
				logger,
			);

			const h1 = queue.enqueue("old-task-1");
			await flush();
			const h2 = queue.enqueue("old-task-2");

			h1.completion.catch(() => {});
			h2.completion.catch(() => {});

			// Cancel all
			await queue.cancelAll();

			// Queue should still accept new tasks (unlike shutdown)
			expect(queue.isAccepting).toBe(true);

			// Switch executor to non-blocking mode for new tasks
			useBlocker = false;

			const h3 = queue.enqueue("new-task-after-cancel");
			const result = await h3.completion;
			expect(result.task).toBe("new-task-after-cancel");
		});

		it("cancelAll returns 0 when queue is empty", async () => {
			const { callbacks } = createMockCallbacks();
			const executor = async (task: string) => makeMockResult(task);

			const queue = new TaskQueue(
				executor,
				callbacks,
				{ maxConcurrent: 1 },
				logger,
			);

			const cancelledCount = await queue.cancelAll();
			expect(cancelledCount).toBe(0);
		});

		it("concurrent tasks with maxConcurrent: 3 produce independent results", async () => {
			const { callbacks } = createMockCallbacks();
			const results = new Map<string, AgentPoolResult>();

			const executor = async (task: string) => {
				// Each task gets a unique result
				const result = makeMockResult(task);
				results.set(task, result);
				return result;
			};

			const queue = new TaskQueue(
				executor,
				callbacks,
				{ maxConcurrent: 3 },
				logger,
			);

			const h1 = queue.enqueue("alpha");
			const h2 = queue.enqueue("beta");
			const h3 = queue.enqueue("gamma");

			const [r1, r2, r3] = await Promise.all([
				h1.completion,
				h2.completion,
				h3.completion,
			]);

			// Each result should correspond to its own task
			expect(r1.task).toBe("alpha");
			expect(r2.task).toBe("beta");
			expect(r3.task).toBe("gamma");

			// Results should be distinct objects
			expect(r1).not.toBe(r2);
			expect(r2).not.toBe(r3);
		});

		it("executor throwing synchronously is handled as a failed task", async () => {
			const { callbacks } = createMockCallbacks();
			let callCount = 0;

			const executor = async (task: string): Promise<AgentPoolResult> => {
				callCount++;
				if (task === "fail-me") {
					throw new Error("Synchronous kaboom");
				}
				return makeMockResult(task);
			};

			const queue = new TaskQueue(
				executor,
				callbacks,
				{ maxConcurrent: 1 },
				logger,
			);

			const hFail = queue.enqueue("fail-me");
			const hOk = queue.enqueue("succeed");

			// The failed task should reject
			await expect(hFail.completion).rejects.toThrow("Synchronous kaboom");

			// The subsequent task should still run and succeed
			const result = await hOk.completion;
			expect(result.task).toBe("succeed");

			// Both should have been attempted
			expect(callCount).toBe(2);

			// Queue state reflects both
			const task = queue.getTask(hFail.id);
			expect(task).not.toBeNull();
			expect(task!.status).toBe("failed");
			expect(task!.error).toBe("Synchronous kaboom");
		});

		it("multiple timeouts expire independently", async () => {
			const { callbacks, expiredCalls } = createMockCallbacks();
			const blocker = deferred<AgentPoolResult>();

			const executor = async (_task: string) => {
				return blocker.promise;
			};

			const queue = new TaskQueue(
				executor,
				callbacks,
				{ maxConcurrent: 1, queueTimeoutMs: 80 },
				logger,
			);

			// First task starts executing — not subject to queue timeout
			const h1 = queue.enqueue("executing-task");
			await flush();

			// These are queued and will timeout
			const h2 = queue.enqueue("will-expire-1");
			const h3 = queue.enqueue("will-expire-2");

			h1.completion.catch(() => {});
			h2.completion.catch(() => {});
			h3.completion.catch(() => {});

			// Wait for timeouts to fire
			await flush(150);

			// Both pending tasks should have expired
			expect(expiredCalls.length).toBe(2);

			const t2 = queue.getTask(h2.id);
			const t3 = queue.getTask(h3.id);
			expect(t2!.status).toBe("expired");
			expect(t3!.status).toBe("expired");

			// The executing task should NOT be expired
			const t1 = queue.getTask(h1.id);
			expect(t1!.status).toBe("executing");

			// Clean up
			blocker.resolve(makeMockResult("done"));
			await flush();
		});

		it("enqueue with empty string task is allowed", async () => {
			const { callbacks } = createMockCallbacks();
			const executor = async (task: string) => makeMockResult(task);

			const queue = new TaskQueue(
				executor,
				callbacks,
				{ maxConcurrent: 1 },
				logger,
			);

			const handle = queue.enqueue("");
			const result = await handle.completion;
			expect(result.task).toBe("");
		});

		it("processedCount increments correctly across mixed outcomes", async () => {
			const { callbacks } = createMockCallbacks();
			let callIndex = 0;

			const executor = async (task: string): Promise<AgentPoolResult> => {
				callIndex++;
				if (callIndex === 2) throw new Error("fail");
				return makeMockResult(task);
			};

			const queue = new TaskQueue(
				executor,
				callbacks,
				{ maxConcurrent: 1 },
				logger,
			);

			const h1 = queue.enqueue("t1");
			const h2 = queue.enqueue("t2");
			const h3 = queue.enqueue("t3");
			const h4 = queue.enqueue("t4");

			h2.completion.catch(() => {});

			// Cancel h3 before it executes
			await flush();
			// h1 is executing, h2-h4 are pending
			h3.completion.catch(() => {});
			await h3.cancel();

			await h1.completion;
			await h4.completion.catch(() => {});
			await flush(50);

			// processedCount = succeeded + failed (not cancelled — cancelled
			// tasks are tracked separately)
			expect(queue.processedCount).toBeGreaterThanOrEqual(2);

			const state = queue.getState();
			expect(state.executingCount).toBe(0);
			expect(state.pendingCount).toBe(0);
		});
	});
});
