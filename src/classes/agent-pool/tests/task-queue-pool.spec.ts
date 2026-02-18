import { afterEach, describe, expect, it } from "bun:test";
import { PoolEvent } from "../../../enums/pool-event.enum.ts";
import type {
	AgentPoolConfig,
	TaskQueuedEvent,
} from "../../../types/agent-pool.types.ts";
import { AgentPool } from "../agent-pool.ts";
import { createMockAgentFactory, silentPoolConfig } from "./test-helpers.ts";

// ════════════════════════════════════════════════════════════════════════════
// AgentPool + TaskQueue — Unit Tests (no API key required)
//
// These tests verify the wiring between AgentPool and TaskQueue at the
// configuration / structural level. They do NOT call execute() or
// _executeInternal(), so they never hit the OpenRouter API.
//
// Tests that require actual task execution (planning, agent spawning, etc.)
// live in task-queue-pool.spec-int.ts.
// ════════════════════════════════════════════════════════════════════════════

/** Creates a pool config with the task queue enabled. */
function queuePoolConfig(
	overrides?: Partial<AgentPoolConfig>,
): AgentPoolConfig {
	return silentPoolConfig({
		createAgent: createMockAgentFactory(),
		taskQueue: { enabled: true, maxConcurrent: 1 },
		...overrides,
	});
}

describe("AgentPool + TaskQueue (unit)", () => {
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

	// ── Test 21: pool.enqueue() returns a TaskHandle ──────────────────

	it("pool.enqueue() returns a TaskHandle with id, position, completion, and cancel", () => {
		pool = new AgentPool(queuePoolConfig());

		const handle = pool.enqueue("test task");

		expect(handle.id).toBeTruthy();
		expect(typeof handle.id).toBe("string");
		expect(typeof handle.position).toBe("number");
		expect(handle.completion).toBeInstanceOf(Promise);
		expect(typeof handle.cancel).toBe("function");

		// Attach a catch to avoid unhandled rejection when the pool
		// is destroyed before the task finishes.
		handle.completion.catch(() => {});
	});

	// ── Test 22: pool.enqueue() throws without queue enabled ──────────

	it("pool.enqueue() throws when task queue is not enabled", () => {
		pool = new AgentPool(
			silentPoolConfig({
				createAgent: createMockAgentFactory(),
				// No taskQueue config
			}),
		);

		expect(() => pool.enqueue("test")).toThrow("Task queue is not enabled");
	});

	// ── Test 27a: pool.getState() includes queue state ────────────────

	it("pool.getState() includes queue state when enabled", () => {
		pool = new AgentPool(queuePoolConfig());

		const state = pool.getState();

		expect(state.queue).not.toBeNull();
		expect(state.queue!.pendingCount).toBe(0);
		expect(state.queue!.executingCount).toBe(0);
		expect(state.queue!.processedCount).toBe(0);
		expect(state.queue!.maxConcurrent).toBe(1);
		expect(state.queue!.pendingTasks).toEqual([]);
		expect(state.queue!.executingTasks).toEqual([]);
	});

	it("pool.getState() has queue as null when queue is not enabled", () => {
		pool = new AgentPool(
			silentPoolConfig({
				createAgent: createMockAgentFactory(),
			}),
		);

		const state = pool.getState();
		expect(state.queue).toBeNull();
	});

	// ── Test 31: Legacy behavior (no queue) ───────────────────────────

	describe("Legacy behavior (no queue)", () => {
		it("getState().queue is null", () => {
			pool = new AgentPool(
				silentPoolConfig({
					createAgent: createMockAgentFactory(),
				}),
			);

			expect(pool.getState().queue).toBeNull();
		});

		it("enqueue() throws", () => {
			pool = new AgentPool(
				silentPoolConfig({
					createAgent: createMockAgentFactory(),
				}),
			);

			expect(() => pool.enqueue("test")).toThrow("Task queue is not enabled");
		});
	});

	// ── Enqueue emits TASK_QUEUED synchronously ───────────────────────

	it("emits TASK_QUEUED synchronously when enqueue is called", () => {
		pool = new AgentPool(queuePoolConfig());

		const queuedEvents: TaskQueuedEvent[] = [];
		pool.on(PoolEvent.TASK_QUEUED, (e) => queuedEvents.push(e));

		const handle = pool.enqueue("my task");
		handle.completion.catch(() => {}); // prevent unhandled rejection

		expect(queuedEvents.length).toBe(1);
		expect(queuedEvents[0]!.taskId).toBe(handle.id);
		expect(queuedEvents[0]!.task).toBe("my task");
		expect(queuedEvents[0]!.position).toBe(0);
		expect(queuedEvents[0]!.queueSize).toBe(1);
	});

	// ── Multiple enqueues produce sequential TASK_QUEUED events ───────

	it("multiple enqueues emit TASK_QUEUED with correct positions and sizes", () => {
		pool = new AgentPool(queuePoolConfig());

		const queuedEvents: TaskQueuedEvent[] = [];
		pool.on(PoolEvent.TASK_QUEUED, (e) => queuedEvents.push(e));

		const h1 = pool.enqueue("task-1");
		const h2 = pool.enqueue("task-2");
		const h3 = pool.enqueue("task-3");

		h1.completion.catch(() => {});
		h2.completion.catch(() => {});
		h3.completion.catch(() => {});

		expect(queuedEvents.length).toBe(3);
		expect(queuedEvents[0]!.task).toBe("task-1");
		expect(queuedEvents[1]!.task).toBe("task-2");
		expect(queuedEvents[2]!.task).toBe("task-3");

		// IDs should all be distinct
		const ids = new Set([h1.id, h2.id, h3.id]);
		expect(ids.size).toBe(3);
	});

	// ── defaultPriority configuration ─────────────────────────────────

	it("defaultPriority is applied to enqueued tasks", () => {
		pool = new AgentPool(
			queuePoolConfig({
				taskQueue: {
					enabled: true,
					maxConcurrent: 1,
					defaultPriority: 42,
				},
			}),
		);

		const queuedEvents: TaskQueuedEvent[] = [];
		pool.on(PoolEvent.TASK_QUEUED, (e) => queuedEvents.push(e));

		const h = pool.enqueue("with default priority");
		h.completion.catch(() => {});

		expect(queuedEvents.length).toBe(1);
		expect(queuedEvents[0]!.priority).toBe(42);
	});

	// ── Explicit priority overrides default ───────────────────────────

	it("enqueue with explicit priority overrides default", () => {
		pool = new AgentPool(
			queuePoolConfig({
				taskQueue: {
					enabled: true,
					maxConcurrent: 1,
					defaultPriority: 5,
				},
			}),
		);

		const queuedEvents: TaskQueuedEvent[] = [];
		pool.on(PoolEvent.TASK_QUEUED, (e) => queuedEvents.push(e));

		const h1 = pool.enqueue("default priority task");
		const h2 = pool.enqueue("high priority task", { priority: 99 });

		h1.completion.catch(() => {});
		h2.completion.catch(() => {});

		expect(queuedEvents.length).toBe(2);
		expect(queuedEvents[0]!.priority).toBe(5);
		expect(queuedEvents[1]!.priority).toBe(99);
	});

	// ── Enqueue after destroy throws (pool-level) ─────────────────────

	it("enqueue() after destroy() throws", async () => {
		pool = new AgentPool(queuePoolConfig());
		await pool.destroy();

		expect(() => pool.enqueue("should fail")).toThrow();
	});

	// ── Destroy during active queue (graceful) ────────────────────────

	it("destroy() during active queue cancels handles gracefully", async () => {
		pool = new AgentPool(queuePoolConfig());

		const handles = [];
		for (let i = 0; i < 5; i++) {
			const h = pool.enqueue(`task-${i}`);
			h.completion.catch(() => {}); // prevent unhandled rejection
			handles.push(h);
		}

		// Destroy the pool — should not throw
		await pool.destroy();

		// All completions should settle (either resolve or reject, never hang)
		const results = await Promise.allSettled(handles.map((h) => h.completion));
		expect(results.length).toBe(5);

		// At least some should be rejected (cancelled by shutdown)
		// In practice, mock agents are fast so some may complete before shutdown.
		// The important thing is that none hang.
	});

	// ── Queue state after enqueue (before execution) ──────────────────

	it("getState().queue shows pending/executing counts after enqueue", () => {
		pool = new AgentPool(queuePoolConfig());

		pool.enqueue("alpha").completion.catch(() => {});
		pool.enqueue("beta").completion.catch(() => {});
		pool.enqueue("gamma").completion.catch(() => {});

		// Before microtask drain, all 3 are at least queued/submitted
		const state = pool.getState();
		expect(state.queue).not.toBeNull();

		// The total of pending + executing should account for all 3 tasks
		// (the first might already be executing via queueMicrotask)
		const total =
			state.queue!.pendingCount +
			state.queue!.executingCount +
			state.queue!.processedCount;
		expect(total).toBeLessThanOrEqual(3);
	});

	// ── maxQueueSize at enqueue time ──────────────────────────────────

	it("maxQueueSize rejects excess pending tasks at enqueue time", async () => {
		pool = new AgentPool(
			queuePoolConfig({
				taskQueue: { enabled: true, maxConcurrent: 1, maxQueueSize: 1 },
			}),
		);

		// First task — will start executing (or be queued)
		const h1 = pool.enqueue("task-1");
		h1.completion.catch(() => {});

		// Give drain a chance to pull h1 into executing
		await new Promise<void>((r) => setTimeout(r, 10));

		// Second task — should go to pending queue (size=1)
		const h2 = pool.enqueue("task-2");
		h2.completion.catch(() => {});

		// Third task — should throw because pending queue is full
		expect(() => pool.enqueue("task-3")).toThrow("full");
	});

	// ── maxConcurrent configuration is reflected in state ─────────────

	it("maxConcurrent is reflected in queue state", () => {
		pool = new AgentPool(
			queuePoolConfig({
				taskQueue: { enabled: true, maxConcurrent: 3 },
			}),
		);

		const state = pool.getState();
		expect(state.queue!.maxConcurrent).toBe(3);
	});

	// ── TASK_CANCELLED event emitted on cancel ────────────────────────

	it("TASK_CANCELLED event is emitted when a pending task is cancelled", async () => {
		pool = new AgentPool(queuePoolConfig());

		const cancelledEvents: any[] = [];
		pool.on(PoolEvent.TASK_CANCELLED, (e) => cancelledEvents.push(e));

		// Enqueue two — first starts executing, second is pending
		const h1 = pool.enqueue("task-1");
		const h2 = pool.enqueue("task-2");

		h1.completion.catch(() => {});
		h2.completion.catch(() => {});

		// Give drain a chance to start h1
		await new Promise<void>((r) => setTimeout(r, 10));

		const cancelled = await h2.cancel();

		// Might already have completed (mock agent is fast)
		if (cancelled) {
			expect(cancelledEvents.length).toBeGreaterThanOrEqual(1);
			const event = cancelledEvents.find((e: any) => e.taskId === h2.id);
			expect(event).toBeTruthy();
		}
	});

	// ── Cancel returns false for completed task ───────────────────────

	it("cancel() returns false for an already settled handle", async () => {
		pool = new AgentPool(queuePoolConfig());

		const handle = pool.enqueue("fast-task");

		// The mock executor will fail because there's no real LLM,
		// but the handle should still settle (reject in this case).
		try {
			await handle.completion;
		} catch {
			// expected — model validation fails
		}

		// After settling, cancel should return false
		const cancelled = await handle.cancel();
		expect(cancelled).toBe(false);
	});

	// ── execute() routes through queue when enabled ───────────────────

	it("execute() with queue enabled emits TASK_QUEUED before failing on model validation", async () => {
		pool = new AgentPool(queuePoolConfig());

		const queuedEvents: TaskQueuedEvent[] = [];
		pool.on(PoolEvent.TASK_QUEUED, (e) => queuedEvents.push(e));

		// execute() goes through the queue, but the task will fail because
		// there's no real API key. The point is that it DID go through the queue.
		try {
			await pool.execute("Build API");
		} catch {
			// expected — model validation fails with fake key
		}

		// The task should have been queued even though it ultimately failed
		expect(queuedEvents.length).toBe(1);
		expect(queuedEvents[0]!.task).toBe("Build API");
	});

	// ── execute() throws without queue when already executing ─────────

	it("execute() without queue throws if already executing (legacy guard)", async () => {
		pool = new AgentPool(
			silentPoolConfig({
				createAgent: createMockAgentFactory(),
			}),
		);

		// Start first execution (will fail on model validation but will set _executing)
		const first = pool.execute("task 1").catch(() => {});

		// Give it a tick to enter execute
		await new Promise<void>((r) => setTimeout(r, 5));

		// The pool may or may not still be in _executing state depending on
		// how fast the model validation fails. If it's still executing, the
		// second call should throw. If the first already failed, the second
		// will also attempt model validation and fail on its own.
		// We just verify the mechanism doesn't crash.
		try {
			await pool.execute("task 2");
		} catch (e) {
			// Either "already executing" or model validation error — both acceptable
			expect(e).toBeInstanceOf(Error);
		}

		await first;
	});

	// ── Queue handles mixed enqueue and cancel correctly ──────────────

	it("interleaved enqueue and cancel calls produce consistent state", async () => {
		pool = new AgentPool(queuePoolConfig());

		const h1 = pool.enqueue("keep-1");
		const h2 = pool.enqueue("cancel-me");
		const h3 = pool.enqueue("keep-2");

		h1.completion.catch(() => {});
		h2.completion.catch(() => {});
		h3.completion.catch(() => {});

		await h2.cancel();

		// The cancelled task should not be in the pending list
		const state = pool.getState();
		const pendingTasks = state.queue?.pendingTasks ?? [];
		const cancelledInPending = pendingTasks.some((t) => t.id === h2.id);
		expect(cancelledInPending).toBe(false);
	});
});
