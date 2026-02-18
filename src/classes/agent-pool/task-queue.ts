import type pino from "pino";
import type {
	AgentPoolResult,
	QueuedTask,
	TaskHandle,
	TaskQueueConfig,
	TaskQueueState,
} from "../../types/agent-pool.types.ts";
import { isoNow } from "../../utils/formatting.ts";
import { generateIdentity } from "../../utils/identity.ts";

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_PRIORITY = 0;

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * An executor function that runs a single task and returns the result.
 * The TaskQueue calls this function when a slot is available.
 * The function receives the task description and the queue task ID.
 * It should throw on failure.
 */
export type TaskExecutor = (
	task: string,
	queueTaskId: string,
) => Promise<AgentPoolResult>;

/**
 * Callback for queue lifecycle events.
 * The TaskQueue uses these callbacks instead of directly emitting events
 * to avoid coupling with the EventEmitter. The AgentPool translates
 * these into pool-level events.
 */
export interface TaskQueueCallbacks {
	readonly onQueued: (
		task: QueuedTask,
		position: number,
		queueSize: number,
	) => void;
	readonly onDequeued: (task: QueuedTask, waitTimeMs: number) => void;
	readonly onDrained: (stats: {
		total: number;
		succeeded: number;
		failed: number;
		cancelled: number;
	}) => void;
	readonly onCancelled: (task: QueuedTask, wasExecuting: boolean) => void;
	readonly onExpired: (task: QueuedTask, waitTimeMs: number) => void;
}

/**
 * Internal representation of a task in the queue with mutable state
 * and promise resolution callbacks.
 */
interface InternalTask {
	readonly id: string;
	readonly task: string;
	priority: number;
	status: QueuedTask["status"];
	readonly submittedAt: string;
	startedAt: string | null;
	completedAt: string | null;
	result: AgentPoolResult | null;
	error: string | null;

	/** Resolve callback for the completion promise. */
	readonly resolve: (result: AgentPoolResult) => void;

	/** Reject callback for the completion promise. */
	readonly reject: (error: Error) => void;

	/** Timer for queue timeout (if configured). */
	timeoutHandle: ReturnType<typeof setTimeout> | null;

	/** AbortController for cancellation during execution. */
	abortController: AbortController | null;
}

// ── TaskQueue ──────────────────────────────────────────────────────────────

/**
 * Priority-based FIFO task queue with configurable concurrency.
 *
 * The TaskQueue manages the lifecycle of tasks from submission to
 * completion. Tasks are executed by calling the provided `executor`
 * function when a concurrency slot is available.
 *
 * ## Ordering
 *
 * Tasks are ordered by:
 * 1. Priority (higher = executed first)
 * 2. Submission time (FIFO within same priority)
 *
 * ## Concurrency
 *
 * The queue supports configurable parallelism:
 * - `maxConcurrent: 1` — Tasks run one at a time (default)
 * - `maxConcurrent: N` — Up to N tasks run in parallel
 *
 * Each task's internal parallelism (multi-agent) is independent
 * of the queue's concurrency — they compose.
 *
 * ## Lifecycle
 *
 * ```
 * enqueue() → [queued] → [executing] → [completed]
 *                 ↓            ↓             ↓
 *            [expired]   [cancelled]     [failed]
 *            [cancelled]
 * ```
 *
 * ## Non-blocking API
 *
 * `enqueue()` returns immediately with a `TaskHandle` that provides
 * a `completion` promise for async waiting. The caller decides whether
 * to await or fire-and-forget.
 *
 * @example
 * ```ts
 * const queue = new TaskQueue(executor, callbacks, config, logger);
 *
 * // Submit tasks — returns immediately
 * const handle1 = queue.enqueue("Build API");
 * const handle2 = queue.enqueue("Write tests", { priority: 10 });
 *
 * // handle2 runs first (higher priority), then handle1
 *
 * // Wait for a specific task
 * const result = await handle1.completion;
 *
 * // Or cancel a task
 * await handle2.cancel();
 * ```
 */
export class TaskQueue {
	/** Resolved configuration with defaults. */
	private readonly config: Required<
		Pick<
			TaskQueueConfig,
			"maxConcurrent" | "maxQueueSize" | "defaultPriority" | "queueTimeoutMs"
		>
	>;

	/** The executor function provided by AgentPool. */
	private readonly executor: TaskExecutor;

	/** Callbacks for queue lifecycle events. */
	private readonly callbacks: TaskQueueCallbacks;

	/** All tasks (pending, executing, and recently completed). */
	private readonly tasks = new Map<string, InternalTask>();

	/** Ordered list of pending task IDs (sorted by priority + submission order). */
	private readonly pendingIds: string[] = [];

	/** Set of currently executing task IDs. */
	private readonly executingIds = new Set<string>();

	/** Counter for statistics. */
	private _processedCount = 0;
	private _succeededCount = 0;
	private _failedCount = 0;
	private _cancelledCount = 0;

	/** Whether the queue is accepting new tasks. */
	private _accepting = true;

	/** Whether the queue is currently draining (processing pending tasks). */
	private _draining = false;

	constructor(
		executor: TaskExecutor,
		callbacks: TaskQueueCallbacks,
		config: TaskQueueConfig,
		private readonly logger: pino.Logger,
	) {
		this.executor = executor;
		this.callbacks = callbacks;

		this.config = {
			maxConcurrent: config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
			maxQueueSize: config.maxQueueSize ?? 0,
			defaultPriority: config.defaultPriority ?? DEFAULT_PRIORITY,
			queueTimeoutMs: config.queueTimeoutMs ?? 0,
		};

		this.logger.info(
			{
				maxConcurrent: this.config.maxConcurrent,
				maxQueueSize: this.config.maxQueueSize,
				defaultPriority: this.config.defaultPriority,
				queueTimeoutMs: this.config.queueTimeoutMs,
			},
			`TaskQueue initialized — concurrency: ${this.config.maxConcurrent}`,
		);
	}

	// ── Public API ─────────────────────────────────────────────────────

	/**
	 * Adds a task to the queue and returns a non-blocking handle.
	 *
	 * The task will be executed when a concurrency slot becomes available,
	 * respecting priority ordering and FIFO within the same priority.
	 *
	 * @param task - The task description.
	 * @param options - Optional overrides for this task.
	 * @returns A `TaskHandle` for tracking and cancellation.
	 * @throws If the queue is full (`maxQueueSize` reached).
	 * @throws If the queue has been shut down.
	 */
	enqueue(task: string, options?: { priority?: number }): TaskHandle {
		if (!this._accepting) {
			throw new Error(
				"TaskQueue has been shut down and is no longer accepting tasks.",
			);
		}

		// Check queue size limit (only count pending, not executing)
		if (
			this.config.maxQueueSize > 0 &&
			this.pendingIds.length >= this.config.maxQueueSize
		) {
			throw new Error(
				`TaskQueue is full (${this.pendingIds.length}/${this.config.maxQueueSize} pending tasks). ` +
					`Wait for tasks to complete or increase maxQueueSize.`,
			);
		}

		const id = generateIdentity({ name: "task" }).id;
		const priority = options?.priority ?? this.config.defaultPriority;
		const now = isoNow();

		// Create the completion promise and capture resolve/reject
		let resolve!: (result: AgentPoolResult) => void;
		let reject!: (error: Error) => void;
		const completion = new Promise<AgentPoolResult>((res, rej) => {
			resolve = res;
			reject = rej;
		});

		// Prevent unhandled promise rejection when the task is cancelled
		// during shutdown/destroy and no external caller has .catch()'d the
		// completion promise. This does NOT swallow errors for callers that
		// DO await/catch — it merely registers a handler so the runtime
		// doesn't report an unhandled rejection.
		completion.catch(() => {});

		const internalTask: InternalTask = {
			id,
			task,
			priority,
			status: "queued",
			submittedAt: now,
			startedAt: null,
			completedAt: null,
			result: null,
			error: null,
			resolve,
			reject,
			timeoutHandle: null,
			abortController: null,
		};

		this.tasks.set(id, internalTask);

		// Insert into pendingIds maintaining priority order (highest first)
		const insertIndex = this.findInsertionIndex(priority);
		this.pendingIds.splice(insertIndex, 0, id);

		const position = this.pendingIds.indexOf(id);

		this.logger.info(
			{
				taskId: id,
				priority,
				position,
				queueSize: this.pendingIds.length,
			},
			`Task queued: "${task.slice(0, 80)}" at position ${position}`,
		);

		// Setup queue timeout if configured
		if (this.config.queueTimeoutMs > 0) {
			internalTask.timeoutHandle = setTimeout(() => {
				this.expireTask(id);
			}, this.config.queueTimeoutMs);
		}

		// Notify callback
		this.callbacks.onQueued(
			this.toQueuedTask(internalTask),
			position,
			this.pendingIds.length,
		);

		// Build the cancel function for the handle
		const cancel = async (): Promise<boolean> => {
			return this.cancelTask(id);
		};

		// Trigger drain to process this task if a slot is available
		this.scheduleDrain();

		return {
			id,
			position,
			completion,
			cancel,
		};
	}

	/**
	 * Cancels a task by ID.
	 *
	 * If the task is pending (queued), it is removed from the queue immediately.
	 * If the task is executing, it signals the executor to abort (best-effort).
	 * If the task is already completed/failed/cancelled, this is a no-op.
	 *
	 * @param taskId - The ID of the task to cancel.
	 * @returns `true` if the task was cancelled, `false` if already terminal.
	 */
	async cancelTask(taskId: string): Promise<boolean> {
		const task = this.tasks.get(taskId);
		if (!task) return false;

		if (
			task.status === "completed" ||
			task.status === "failed" ||
			task.status === "cancelled" ||
			task.status === "expired"
		) {
			return false;
		}

		const wasExecuting = task.status === "executing";

		// Clear queue timeout
		if (task.timeoutHandle) {
			clearTimeout(task.timeoutHandle);
			task.timeoutHandle = null;
		}

		task.status = "cancelled";
		task.completedAt = isoNow();
		task.error = "Task cancelled by user";
		this._cancelledCount++;

		if (wasExecuting) {
			// Signal the executor to abort
			task.abortController?.abort();
			this.executingIds.delete(taskId);
		} else {
			// Remove from pending queue
			const index = this.pendingIds.indexOf(taskId);
			if (index !== -1) {
				this.pendingIds.splice(index, 1);
			}
		}

		this.logger.info(
			{
				taskId,
				wasExecuting,
			},
			`Task cancelled: "${task.task.slice(0, 80)}" (was ${wasExecuting ? "executing" : "queued"})`,
		);

		this.callbacks.onCancelled(this.toQueuedTask(task), wasExecuting);

		this.safeReject(task, new Error("Task cancelled by user"));

		// Trigger drain to process next pending task (if a slot freed up)
		if (wasExecuting) {
			this.scheduleDrain();
		}

		return true;
	}

	/**
	 * Returns a read-only snapshot of the queue's current state.
	 */
	getState(): TaskQueueState {
		const pendingTasks = this.pendingIds
			.map((id) => this.tasks.get(id))
			.filter((t): t is InternalTask => t != null && t.status === "queued")
			.map((t) => ({
				id: t.id,
				task: t.task,
				priority: t.priority,
				submittedAt: t.submittedAt,
			}));

		const executingTasks = [...this.executingIds]
			.map((id) => this.tasks.get(id))
			.filter((t): t is InternalTask => t != null)
			.map((t) => ({
				id: t.id,
				task: t.task,
				priority: t.priority,
				startedAt: t.startedAt,
			}));

		return {
			pendingCount: this.pendingIds.length,
			executingCount: this.executingIds.size,
			processedCount: this._processedCount,
			maxConcurrent: this.config.maxConcurrent,
			pendingTasks,
			executingTasks,
		};
	}

	/**
	 * Cancels all pending and executing tasks without shutting down
	 * the queue. The queue remains open for new submissions after
	 * this call completes.
	 *
	 * Use this for user-initiated "cancel all" operations where the
	 * pool should remain usable afterwards. Use `shutdown()` when
	 * the pool is being destroyed and no more tasks should be accepted.
	 *
	 * @returns The number of tasks that were cancelled.
	 */
	async cancelAll(): Promise<number> {
		let cancelledCount = 0;

		this.logger.info(
			{
				pendingCount: this.pendingIds.length,
				executingCount: this.executingIds.size,
			},
			"Cancelling all queued and executing tasks",
		);

		// Cancel all pending tasks
		const pendingIdsCopy = [...this.pendingIds];
		for (const id of pendingIdsCopy) {
			const cancelled = await this.cancelTask(id);
			if (cancelled) cancelledCount++;
		}

		// Cancel all executing tasks
		const executingIdsCopy = [...this.executingIds];
		for (const id of executingIdsCopy) {
			const cancelled = await this.cancelTask(id);
			if (cancelled) cancelledCount++;
		}

		this.logger.info(
			{ cancelledCount },
			`Cancelled ${cancelledCount} task(s) — queue remains open`,
		);

		return cancelledCount;
	}

	/**
	 * Shuts down the queue gracefully.
	 *
	 * - Stops accepting new tasks.
	 * - Cancels all pending tasks.
	 * - Optionally waits for executing tasks to complete.
	 *
	 * @param waitForExecuting - If `true`, waits for executing tasks
	 *   to finish. If `false`, cancels them too. Default: false.
	 */
	async shutdown(waitForExecuting = false): Promise<void> {
		this._accepting = false;

		this.logger.info(
			{
				pendingCount: this.pendingIds.length,
				executingCount: this.executingIds.size,
				waitForExecuting,
			},
			"TaskQueue shutting down",
		);

		// Cancel all pending tasks
		const pendingIdsCopy = [...this.pendingIds];
		for (const id of pendingIdsCopy) {
			await this.cancelTask(id);
		}

		if (waitForExecuting) {
			// Wait for executing tasks to finish naturally
			if (this.executingIds.size > 0) {
				const executingTasks = [...this.executingIds]
					.map((id) => this.tasks.get(id))
					.filter((t): t is InternalTask => t != null);

				await Promise.allSettled(
					executingTasks.map(
						(t) =>
							new Promise<void>((resolve) => {
								const check = () => {
									if (t.status !== "executing") {
										resolve();
									} else {
										setTimeout(check, 100);
									}
								};
								check();
							}),
					),
				);
			}
		} else {
			// Cancel executing tasks too
			const executingIdsCopy = [...this.executingIds];
			for (const id of executingIdsCopy) {
				await this.cancelTask(id);
			}
		}

		this.logger.info("TaskQueue shut down complete");
	}

	/**
	 * Returns a specific task by ID (read-only).
	 */
	getTask(taskId: string): QueuedTask | null {
		const task = this.tasks.get(taskId);
		return task ? this.toQueuedTask(task) : null;
	}

	/**
	 * Cleans up completed/failed/cancelled tasks from the internal
	 * map to prevent memory growth. Only keeps tasks from the current
	 * drain cycle.
	 *
	 * @param maxRetained - Maximum number of completed tasks to keep.
	 */
	pruneCompleted(maxRetained = 50): void {
		const completed: string[] = [];
		for (const [id, task] of this.tasks) {
			if (
				task.status === "completed" ||
				task.status === "failed" ||
				task.status === "cancelled" ||
				task.status === "expired"
			) {
				completed.push(id);
			}
		}

		if (completed.length <= maxRetained) return;

		// Sort by completedAt, oldest first
		completed.sort((a, b) => {
			const ta = this.tasks.get(a)?.completedAt ?? "";
			const tb = this.tasks.get(b)?.completedAt ?? "";
			return ta.localeCompare(tb);
		});

		// Remove the oldest
		const toRemove = completed.slice(0, completed.length - maxRetained);
		for (const id of toRemove) {
			this.tasks.delete(id);
		}
	}

	// ── Getters ────────────────────────────────────────────────────────

	/**
	 * Returns whether the queue is accepting new tasks.
	 */
	get isAccepting(): boolean {
		return this._accepting;
	}

	/**
	 * Returns the number of pending tasks.
	 */
	get pendingCount(): number {
		return this.pendingIds.length;
	}

	/**
	 * Returns the number of executing tasks.
	 */
	get executingCount(): number {
		return this.executingIds.size;
	}

	/**
	 * Returns the total number of processed tasks.
	 */
	get processedCount(): number {
		return this._processedCount;
	}

	/**
	 * Checks if there's an available execution slot.
	 */
	get hasAvailableSlot(): boolean {
		return this.executingIds.size < this.config.maxConcurrent;
	}

	// ── Private: Drain Logic ───────────────────────────────────────────

	/**
	 * Schedules a drain cycle to process pending tasks.
	 *
	 * Uses `queueMicrotask` to avoid re-entrant execution within
	 * the same event loop tick. Multiple calls within the same tick
	 * are collapsed into a single drain.
	 */
	private scheduleDrain(): void {
		if (this._draining) return;

		queueMicrotask(() => {
			void this.drain();
		});
	}

	/**
	 * Processes pending tasks up to the concurrency limit.
	 *
	 * Picks the highest-priority pending tasks and starts them
	 * in parallel up to `maxConcurrent - executingCount`.
	 *
	 * Each task execution is fire-and-forget — completion/failure
	 * is handled by the executor callback. When a task finishes,
	 * another drain cycle is triggered to fill the freed slot.
	 */
	private async drain(): Promise<void> {
		if (this._draining) return;
		this._draining = true;

		try {
			while (
				this.pendingIds.length > 0 &&
				this.executingIds.size < this.config.maxConcurrent
			) {
				const taskId = this.pendingIds.shift();
				if (!taskId) break;

				const task = this.tasks.get(taskId);
				if (!task) continue;

				// Skip expired or cancelled tasks that haven't been cleaned up
				if (task.status !== "queued") continue;

				// Clear queue timeout
				if (task.timeoutHandle) {
					clearTimeout(task.timeoutHandle);
					task.timeoutHandle = null;
				}

				// Transition to executing
				task.status = "executing";
				task.startedAt = isoNow();
				task.abortController = new AbortController();
				this.executingIds.add(taskId);

				const waitTimeMs = Date.now() - new Date(task.submittedAt).getTime();

				this.logger.info(
					{
						taskId,
						waitTimeMs,
						executingCount: this.executingIds.size,
						remainingPending: this.pendingIds.length,
					},
					`Task dequeued: "${task.task.slice(0, 80)}" (waited ${waitTimeMs}ms)`,
				);

				this.callbacks.onDequeued(this.toQueuedTask(task), waitTimeMs);

				// Execute the task (fire-and-forget — completion is handled below)
				void this.executeTask(task);
			}

			// Check if the queue is fully drained
			if (
				this.pendingIds.length === 0 &&
				this.executingIds.size === 0 &&
				this._processedCount > 0
			) {
				this.callbacks.onDrained({
					total: this._processedCount,
					succeeded: this._succeededCount,
					failed: this._failedCount,
					cancelled: this._cancelledCount,
				});
			}
		} finally {
			this._draining = false;
		}
	}

	/**
	 * Executes a single task using the provided executor function.
	 *
	 * On completion or failure, updates the task state, resolves/rejects
	 * the completion promise, and triggers a new drain cycle to process
	 * pending tasks.
	 *
	 * @param task - The internal task to execute.
	 */
	private async executeTask(task: InternalTask): Promise<void> {
		try {
			const result = await this.executor(task.task, task.id);

			// Task completed successfully
			task.status = "completed";
			task.completedAt = isoNow();
			task.result = result;
			this._processedCount++;
			this._succeededCount++;

			this.logger.info(
				{
					taskId: task.id,
					strategy: result.strategy,
					durationMs: result.durationMs,
				},
				`Queued task completed: "${task.task.slice(0, 80)}"`,
			);

			task.resolve(result);
		} catch (error) {
			// Check if this was a cancellation
			if (task.status === "cancelled") {
				// Already handled by cancelTask()
				return;
			}

			const errorMessage =
				error instanceof Error ? error.message : String(error);

			task.status = "failed";
			task.completedAt = isoNow();
			task.error = errorMessage;
			this._processedCount++;
			this._failedCount++;

			this.logger.error(
				{
					taskId: task.id,
					error: errorMessage,
				},
				`Queued task failed: "${task.task.slice(0, 80)}"`,
			);

			task.reject(error instanceof Error ? error : new Error(errorMessage));
		} finally {
			this.executingIds.delete(task.id);
			task.abortController = null;

			// Prune old completed tasks to prevent memory leaks
			this.pruneCompleted(50);

			// Trigger drain to process next pending task
			this.scheduleDrain();
		}
	}

	// ── Private: Expiration ────────────────────────────────────────────

	/**
	 * Expires a task that has been waiting in the queue too long.
	 *
	 * Only applies to pending (queued) tasks. Executing tasks are
	 * not subject to queue timeout — they have their own subtask
	 * timeouts (évolution 10).
	 *
	 * @param taskId - The ID of the task to expire.
	 */
	private expireTask(taskId: string): void {
		const task = this.tasks.get(taskId);
		if (!task || task.status !== "queued") return;

		task.status = "expired";
		task.completedAt = isoNow();
		task.error = `Task expired after ${this.config.queueTimeoutMs}ms in queue`;
		task.timeoutHandle = null;

		// Remove from pending queue
		const index = this.pendingIds.indexOf(taskId);
		if (index !== -1) {
			this.pendingIds.splice(index, 1);
		}

		const waitTimeMs = Date.now() - new Date(task.submittedAt).getTime();

		this.logger.warn(
			{
				taskId,
				waitTimeMs,
				queueTimeoutMs: this.config.queueTimeoutMs,
			},
			`Task expired: "${task.task.slice(0, 80)}" (waited ${waitTimeMs}ms)`,
		);

		this.callbacks.onExpired(this.toQueuedTask(task), waitTimeMs);

		this.safeReject(task, new Error(task.error));
	}

	// ── Private: Safe Rejection ────────────────────────────────────────

	/**
	 * Safely rejects a task's completion promise without risking an
	 * unhandled rejection report from the runtime.
	 *
	 * Bun's test runner can report `# Unhandled error between tests`
	 * even when `.catch(() => {})` is pre-registered on the promise,
	 * if the rejection is triggered synchronously during teardown
	 * (e.g. `afterEach` → `destroy()` → `shutdown()` → `cancelTask()`).
	 *
	 * Deferring the reject to a microtask ensures the runtime's
	 * unhandled-rejection detection window has closed by the time
	 * the rejection fires, while still delivering the error to any
	 * caller that `.catch()`'d or `await`'d the completion promise.
	 */
	private safeReject(task: InternalTask, error: Error): void {
		queueMicrotask(() => {
			try {
				task.reject(error);
			} catch {
				// Swallow — the promise may already be settled
			}
		});
	}

	// ── Private: Helpers ───────────────────────────────────────────────

	/**
	 * Finds the correct insertion index in `pendingIds` for a task
	 * with the given priority, maintaining descending priority order
	 * and FIFO within the same priority.
	 */
	private findInsertionIndex(priority: number): number {
		// Find the position after all tasks with equal or higher priority
		// (FIFO: new tasks go at the end of their priority group)
		for (let i = 0; i < this.pendingIds.length; i++) {
			const pendingId = this.pendingIds[i];
			if (!pendingId) continue;
			const existingTask = this.tasks.get(pendingId);
			if (existingTask && existingTask.priority < priority) {
				return i;
			}
		}
		return this.pendingIds.length;
	}

	/**
	 * Converts an InternalTask to a read-only QueuedTask.
	 */
	private toQueuedTask(task: InternalTask): QueuedTask {
		return {
			id: task.id,
			task: task.task,
			priority: task.priority,
			status: task.status,
			submittedAt: task.submittedAt,
			startedAt: task.startedAt,
			completedAt: task.completedAt,
			result: task.result,
			error: task.error,
		};
	}
}
