# Évolution 20 — File d'attente de tâches (exécution séquentielle et concurrente)

## Priorité : 🟢 P3

## Dépendances : Aucune (indépendante)

## Acquis des évolutions précédentes

- **Évolution 01** : L'`InformationBroker` reçoit les mappings `subtaskToAgent`/`agentToSubtask`. Le tri des candidats par dépendance est fonctionnel.
- **Évolution 02** : Le broker maintient un `SharingHistory` pour la déduplication. `recordSharing()` enregistre chaque partage effectué.
- **Évolution 03** : Le `ProjectScanner` injecte le contexte projet dans le planner. Le `TaskPlanner.analyze()` accepte un `ProjectContext`.
- **Évolution 04** : Des exemples few-shot sont inclus dans tous les prompts LLM.
- **Évolution 05** : Les conversations `CONTEXT_ANALYZER` et `SHARING_ANALYZER` sont séparées avec des system prompts spécialisés.
- **Évolution 06** : Les prompts notification et summary sont nettoyés. Les `CoordinationStats` sont passées au summary.
- **Évolution 07** : Les résultats complets de prompt sont partagés via `promptResultSummary` dans les `ContextDelta`.
- **Évolution 08** : L'injection de contexte est structurée via `StructuredContextInjection` avec priorités et catégories.
- **Évolution 09** : Le seuil de significance est dynamique, calculé par `computeThreshold()` en fonction de la phase d'exécution et des dépendances.
- **Évolution 10** : Mécanisme de timeout et retry par subtask. `SubtaskTimeoutConfig` et `SubtaskRetryConfig` dans la config.
- **Évolution 11** : Re-planification adaptative via `TaskPlanner.replan()`. `ReplanDecision` avec actions `continue`/`modify`/`restart`/`abort`.
- **Évolution 12** : Support multi-intent dans l'intent analyzer. Historique conversationnel dans `AgentPool.send()`.
- **Évolution 13** : Mémoire glissante du planner via `PlannerMemory[]`. `recordExecution()` stocke les résumés d'exécution.
- **Évolution 14** : `DecisionJournal` pour le context analyzer intra-exécution. Journal de réflexion condensé dans les prompts sharing/notification.
- **Évolution 15** : `CheckpointEvaluator` pour les points de contrôle mid-execution. Triggers par completion %, delta count, time interval.
- **Évolution 16** : `OrchestratorEngine` pour la réflexion cross-conversation. Directives injectées dans les prompts sharing/notification.
- **Évolution 17** : `ReflectionEngine` pour le cycle Reflect → Learn → Store post-exécution. `ExecutionInsight` persistés entre exécutions.
- **Évolution 18** : `ConflictDetector` pour la détection de conflits inter-agents. Alertes structurées injectées via `StructuredContextInjection`.
- **Évolution 19** : `CostTracker` pour l'agrégation des coûts et tokens. `TokenBudgetConfig` et `ConversationCompressionConfig`. Compression automatique des conversations. `UsageSnapshot` dans `AgentPoolResult`.

---

## Contexte du problème

Actuellement, l'`AgentPool` ne supporte qu'**une seule exécution à la fois**. Si `execute()` est appelé pendant qu'une tâche est en cours, le pool lève une exception :

```typescript
// src/classes/agent-pool/agent-pool.ts (lignes ~298-301)
if (this._executing) {
    throw new Error(
        "AgentPool is already executing a task. Wait for the current execution to complete or cancel it.",
    );
}
```

De même, `send()` avec un intent `new_task` appelle `execute()` en interne, ce qui provoque la même erreur si une exécution est en cours.

### Problèmes identifiés

#### 1. Pas de file d'attente

L'utilisateur ne peut pas enchaîner des tâches. Il doit attendre la fin d'une exécution avant de soumettre la suivante. Cela rend l'utilisation interactive pénible :

```typescript
// L'utilisateur doit faire :
const result1 = await pool.execute("Build the API");
const result2 = await pool.execute("Now add tests"); // Doit attendre result1

// Il ne peut PAS faire :
pool.execute("Build the API");       // fire-and-forget
pool.execute("Now add tests");       // ❌ THROWS — pool is already executing
```

#### 2. Pas de soumission non-bloquante

Le seul moyen de lancer une tâche est `execute()` qui est `async` et bloque le caller. Il n'y a pas de méthode `enqueue()` qui retourne immédiatement un handle pour suivre la progression.

#### 3. Pas de gestion de concurrence configurable

Certaines tâches sont indépendantes et pourraient s'exécuter en parallèle (ex: « Build the API » et « Write the documentation »). Mais la pool interdit structurellement toute concurrence au niveau des tâches (pas des subtasks — celles-ci sont parallélisées dans une même tâche).

#### 4. `send("new task")` pendant une exécution est perdu

Quand l'utilisateur envoie un message classé `new_task` via `send()` pendant qu'une exécution est en cours, le pool tente d'appeler `execute()` qui throw. Le message est perdu.

### Impact utilisateur

- **Workflow séquentiel obligatoire** : l'utilisateur doit orchestrer manuellement la séquence des tâches
- **Pas d'experience interactive fluide** : dans une UI/CLI, les messages envoyés pendant une exécution sont rejetés
- **Sous-utilisation des ressources** : les tâches indépendantes sont forcément séquentielles

---

## Fichiers impactés

| Fichier | Action |
|---------|--------|
| `src/types/agent-pool.types.ts` | Ajouter `TaskQueueConfig`, `QueuedTask`, `TaskHandle`, `TaskQueueState` |
| `src/classes/agent-pool/task-queue.ts` | **Nouveau** — File d'attente de tâches avec gestion de concurrence |
| `src/classes/agent-pool/agent-pool.ts` | Intégrer la `TaskQueue`, modifier `execute()` et `send()` |
| `src/enums/pool-event.enum.ts` | Ajouter `TASK_QUEUED`, `TASK_DEQUEUED`, `QUEUE_DRAINED` |
| `src/types/events.types.ts` | Ajouter les types d'événements correspondants |
| `src/prompts/index.ts` | Aucun changement de prompt (cette évolution est purement structurelle) |
| `src/classes/agent-pool/tests/` | Tests unitaires |

---

## Spécification détaillée des changements

### 1. Nouveaux types dans `agent-pool.types.ts`

#### Type `TaskQueueConfig`

```typescript
/**
 * Configuration de la file d'attente de tâches.
 *
 * Par défaut, la queue est désactivée — le pool se comporte comme
 * aujourd'hui (une seule tâche à la fois, throw si déjà en cours).
 *
 * Quand activée, les tâches soumises pendant une exécution sont
 * mises en file d'attente et exécutées automatiquement.
 */
export interface TaskQueueConfig {
    /**
     * Activer la file d'attente de tâches.
     * Défaut : false (comportement legacy — throw si déjà en cours).
     */
    readonly enabled?: boolean;

    /**
     * Nombre maximum de tâches pouvant s'exécuter en parallèle.
     * - `1` : Exécution séquentielle (FIFO). Les tâches sont exécutées
     *   une par une dans l'ordre de soumission.
     * - `2+` : Exécution concurrente. Jusqu'à N tâches s'exécutent en
     *   parallèle. Les tâches sont démarrées dans l'ordre FIFO dès
     *   qu'un slot se libère.
     * Défaut : 1 (séquentiel).
     *
     * Note : chaque tâche en parallèle peut elle-même avoir plusieurs
     * agents (multi-agent strategy). Le nombre total d'agents actifs
     * est limité par `maxAgents` au niveau de la pool, partagé entre
     * toutes les tâches concurrentes.
     */
    readonly maxConcurrent?: number;

    /**
     * Nombre maximum de tâches en attente dans la queue.
     * Au-delà, les nouvelles soumissions sont rejetées avec une erreur.
     * 0 ou undefined = pas de limite.
     */
    readonly maxQueueSize?: number;

    /**
     * Priorité par défaut pour les tâches sans priorité explicite.
     * Les tâches à priorité plus élevée sont exécutées en premier (FIFO
     * à priorité égale).
     * Défaut : 0.
     */
    readonly defaultPriority?: number;

    /**
     * Timeout maximum qu'une tâche peut rester dans la queue avant
     * d'être automatiquement rejetée (en millisecondes).
     * 0 ou undefined = pas de timeout de queue.
     */
    readonly queueTimeoutMs?: number;
}
```

#### Type `QueuedTask`

```typescript
/**
 * Représentation d'une tâche dans la file d'attente.
 */
export interface QueuedTask {
    /** Identifiant unique de la tâche dans la queue. */
    readonly id: string;

    /** Description textuelle de la tâche. */
    readonly task: string;

    /** Priorité de la tâche (plus grand = plus prioritaire). */
    readonly priority: number;

    /** État de la tâche dans la queue. */
    readonly status: "queued" | "executing" | "completed" | "failed" | "cancelled" | "expired";

    /** ISO-8601 timestamp de soumission. */
    readonly submittedAt: string;

    /** ISO-8601 timestamp de début d'exécution (null si pas encore démarrée). */
    readonly startedAt: string | null;

    /** ISO-8601 timestamp de fin (null si pas encore terminée). */
    readonly completedAt: string | null;

    /** Résultat de l'exécution (null si pas encore terminée). */
    readonly result: AgentPoolResult | null;

    /** Message d'erreur si la tâche a échoué ou a été rejetée. */
    readonly error: string | null;
}
```

#### Type `TaskHandle`

```typescript
/**
 * Handle retourné lors de la soumission d'une tâche à la queue.
 *
 * Permet au caller de suivre la progression et d'attendre la complétion
 * sans bloquer la soumission.
 *
 * @example
 * ```ts
 * const handle = pool.enqueue("Build a REST API");
 * console.log(handle.id);       // "task-abc123"
 * console.log(handle.position); // 0 (premier dans la queue)
 *
 * // Non-bloquant — le caller peut continuer
 * const result = await handle.completion;
 * console.log(result.strategy); // "multi"
 * ```
 */
export interface TaskHandle {
    /** Identifiant unique de la tâche dans la queue. */
    readonly id: string;

    /** Position dans la queue au moment de la soumission (0-based). */
    readonly position: number;

    /**
     * Promise qui se résout quand la tâche est terminée.
     * Se résout avec le `AgentPoolResult` en cas de succès.
     * Se rejette avec une `Error` en cas d'échec, annulation, ou expiration.
     */
    readonly completion: Promise<AgentPoolResult>;

    /**
     * Annule la tâche si elle est encore en attente.
     * Si la tâche est déjà en cours d'exécution, tente de l'annuler
     * (destroy des agents en cours).
     *
     * @returns `true` si la tâche a été annulée, `false` si elle était
     *          déjà terminée ou annulée.
     */
    readonly cancel: () => Promise<boolean>;
}
```

#### Type `TaskQueueState`

```typescript
/**
 * État observable de la file d'attente de tâches.
 */
export interface TaskQueueState {
    /** Nombre de tâches actuellement en attente. */
    readonly pendingCount: number;

    /** Nombre de tâches actuellement en cours d'exécution. */
    readonly executingCount: number;

    /** Nombre total de tâches traitées (complétées + échouées). */
    readonly processedCount: number;

    /** Nombre maximum de tâches concurrentes configuré. */
    readonly maxConcurrent: number;

    /** Détail des tâches en attente (les plus proches d'être exécutées en premier). */
    readonly pendingTasks: readonly Pick<QueuedTask, "id" | "task" | "priority" | "submittedAt">[];

    /** Détail des tâches en cours d'exécution. */
    readonly executingTasks: readonly Pick<QueuedTask, "id" | "task" | "priority" | "startedAt">[];
}
```

#### Enrichir `AgentPoolConfig`

```typescript
export interface AgentPoolConfig {
    // ... champs existants ...

    /**
     * Configuration de la file d'attente de tâches.
     * Si non fourni ou `enabled: false`, le pool se comporte comme
     * aujourd'hui (une seule tâche à la fois, throw si déjà en cours).
     */
    readonly taskQueue?: TaskQueueConfig;
}
```

#### Enrichir `AgentPoolState`

```typescript
export interface AgentPoolState {
    // ... champs existants ...

    /**
     * État de la file d'attente de tâches.
     * `null` si la queue n'est pas activée.
     */
    readonly queue: TaskQueueState | null;
}
```

### 2. Nouveaux pool events

Ajouter dans `pool-event.enum.ts` :

```typescript
export enum PoolEvent {
    // ... events existants ...

    /**
     * Une tâche a été ajoutée à la file d'attente.
     * Émis immédiatement lors de l'appel à `enqueue()`.
     */
    TASK_QUEUED = "pool:task-queued",

    /**
     * Une tâche en attente a commencé son exécution.
     * Émis quand un slot d'exécution se libère et que la tâche
     * passe de "queued" à "executing".
     */
    TASK_DEQUEUED = "pool:task-dequeued",

    /**
     * Toutes les tâches de la queue ont été traitées.
     * La queue est vide et aucune exécution n'est en cours.
     */
    QUEUE_DRAINED = "pool:queue-drained",

    /**
     * Une tâche en queue a été annulée.
     */
    TASK_CANCELLED = "pool:task-cancelled",

    /**
     * Une tâche en queue a expiré (dépassé le `queueTimeoutMs`).
     */
    TASK_EXPIRED = "pool:task-expired",
}
```

Ajouter les types d'événements correspondants :

```typescript
export interface TaskQueuedEvent extends BasePoolEvent {
    readonly taskId: string;
    readonly task: string;
    readonly priority: number;
    readonly position: number;
    readonly queueSize: number;
}

export interface TaskDequeuedEvent extends BasePoolEvent {
    readonly taskId: string;
    readonly task: string;
    readonly waitTimeMs: number;
}

export interface QueueDrainedEvent extends BasePoolEvent {
    readonly totalProcessed: number;
    readonly totalSucceeded: number;
    readonly totalFailed: number;
    readonly totalCancelled: number;
}

export interface TaskCancelledEvent extends BasePoolEvent {
    readonly taskId: string;
    readonly task: string;
    readonly wasExecuting: boolean;
}

export interface TaskExpiredEvent extends BasePoolEvent {
    readonly taskId: string;
    readonly task: string;
    readonly waitTimeMs: number;
}

export interface PoolEventMap {
    // ... events existants ...
    [PoolEvent.TASK_QUEUED]: TaskQueuedEvent;
    [PoolEvent.TASK_DEQUEUED]: TaskDequeuedEvent;
    [PoolEvent.QUEUE_DRAINED]: QueueDrainedEvent;
    [PoolEvent.TASK_CANCELLED]: TaskCancelledEvent;
    [PoolEvent.TASK_EXPIRED]: TaskExpiredEvent;
}
```

### 3. Nouveau fichier `src/classes/agent-pool/task-queue.ts`

#### Responsabilités

La `TaskQueue` est un composant pur de gestion de file d'attente. Elle :

1. Stocke les tâches en attente dans une priority queue FIFO
2. Gère la concurrence (nombre de slots d'exécution parallèle)
3. Détecte l'expiration des tâches en attente
4. Fournit des `TaskHandle` pour le suivi non-bloquant
5. Permet l'annulation de tâches (en attente ou en cours)

Elle **ne connaît pas** l'`AgentPool` ni le `ConversationManager`. Elle reçoit une fonction d'exécution (`executor`) qui encapsule la logique d'exécution d'une tâche.

#### Structure de la classe

```typescript
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
type TaskExecutor = (task: string, queueTaskId: string) => Promise<AgentPoolResult>;

/**
 * Callback for queue lifecycle events.
 * The TaskQueue uses these callbacks instead of directly emitting events
 * to avoid coupling with the EventEmitter. The AgentPool translates
 * these into pool-level events.
 */
interface TaskQueueCallbacks {
    readonly onQueued: (task: QueuedTask, position: number, queueSize: number) => void;
    readonly onDequeued: (task: QueuedTask, waitTimeMs: number) => void;
    readonly onDrained: (stats: { total: number; succeeded: number; failed: number; cancelled: number }) => void;
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
    // ... implementation details below
}
```

#### Champs internes

```typescript
/** Resolved configuration with defaults. */
private readonly config: Required<Pick<
    TaskQueueConfig,
    "maxConcurrent" | "maxQueueSize" | "defaultPriority" | "queueTimeoutMs"
>>;

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
```

#### Constructeur

```typescript
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
```

#### Méthode `enqueue()`

```typescript
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
enqueue(
    task: string,
    options?: { priority?: number },
): TaskHandle {
    if (!this._accepting) {
        throw new Error("TaskQueue has been shut down and is no longer accepting tasks.");
    }

    // Check queue size limit
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
```

#### Méthode `scheduleDrain()`

```typescript
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
        if (this.pendingIds.length === 0 && this.executingIds.size === 0) {
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
```

#### Méthode `executeTask()`

```typescript
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

        const errorMessage = error instanceof Error ? error.message : String(error);

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

        // Trigger drain to process next pending task
        this.scheduleDrain();
    }
}
```

#### Méthode `cancelTask()`

```typescript
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

    if (task.status === "completed" || task.status === "failed" || task.status === "cancelled" || task.status === "expired") {
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

    task.reject(new Error("Task cancelled by user"));

    // Trigger drain to process next pending task (if a slot freed up)
    if (wasExecuting) {
        this.scheduleDrain();
    }

    return true;
}
```

#### Méthode `expireTask()`

```typescript
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

    task.reject(new Error(task.error));
}
```

#### Méthode `getState()`

```typescript
/**
 * Returns a read-only snapshot of the queue's current state.
 */
getState(): TaskQueueState {
    const pendingTasks = this.pendingIds
        .map(id => this.tasks.get(id))
        .filter((t): t is InternalTask => t != null && t.status === "queued")
        .map(t => ({
            id: t.id,
            task: t.task,
            priority: t.priority,
            submittedAt: t.submittedAt,
        }));

    const executingTasks = [...this.executingIds]
        .map(id => this.tasks.get(id))
        .filter((t): t is InternalTask => t != null)
        .map(t => ({
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
```

#### Méthode `shutdown()`

```typescript
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
        const executingPromises: Promise<void>[] = [];
        for (const id of this.executingIds) {
            const task = this.tasks.get(id);
            if (task) {
                executingPromises.push(
                    task.resolve
                        ? // Wait for the completion promise to settle
                          new Promise<void>(resolve => {
                              // The completion promise will resolve or reject
                              // when the executor finishes
                              void Promise.allSettled([
                                  new Promise<AgentPoolResult>((res, rej) => {
                                      // We can't easily await the original promise
                                      // because it may already be settled.
                                      // Instead, just wait a tick and check.
                                  }),
                              ]).then(() => resolve());
                          })
                        : Promise.resolve(),
                );
            }
        }

        // Simplified: just wait for all executing tasks via their IDs
        if (this.executingIds.size > 0) {
            const executingTasks = [...this.executingIds]
                .map(id => this.tasks.get(id))
                .filter((t): t is InternalTask => t != null);

            await Promise.allSettled(
                executingTasks.map(t =>
                    new Promise<void>(resolve => {
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
```

#### Méthodes helpers

```typescript
/**
 * Finds the correct insertion index in `pendingIds` for a task
 * with the given priority, maintaining descending priority order
 * and FIFO within the same priority.
 */
private findInsertionIndex(priority: number): number {
    // Find the position after all tasks with equal or higher priority
    // (FIFO: new tasks go at the end of their priority group)
    for (let i = 0; i < this.pendingIds.length; i++) {
        const existingTask = this.tasks.get(this.pendingIds[i]!);
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
```

### 4. Intégrer la `TaskQueue` dans `AgentPool`

#### A. Ajouter le champ dans la classe

```typescript
export class AgentPool extends EventEmitter {
    // ... existing fields ...

    /** Task queue for non-blocking task submission (null if not enabled). */
    private readonly taskQueue: TaskQueue | null;
}
```

#### B. Instancier dans le constructeur

```typescript
constructor(config: AgentPoolConfig) {
    super();

    // ... existing constructor ...

    // Task queue
    if (config.taskQueue?.enabled) {
        this.taskQueue = new TaskQueue(
            // Executor: wraps the pool's internal execute logic
            async (task: string, _queueTaskId: string) => {
                return this.executeInternal(task);
            },
            // Callbacks: translate to pool events
            {
                onQueued: (task, position, queueSize) => {
                    this.emitPoolEvent(PoolEvent.TASK_QUEUED, {
                        taskId: task.id,
                        task: task.task,
                        priority: task.priority,
                        position,
                        queueSize,
                    });
                },
                onDequeued: (task, waitTimeMs) => {
                    this.emitPoolEvent(PoolEvent.TASK_DEQUEUED, {
                        taskId: task.id,
                        task: task.task,
                        waitTimeMs,
                    });
                },
                onDrained: (stats) => {
                    this.emitPoolEvent(PoolEvent.QUEUE_DRAINED, {
                        totalProcessed: stats.total,
                        totalSucceeded: stats.succeeded,
                        totalFailed: stats.failed,
                        totalCancelled: stats.cancelled,
                    });
                },
                onCancelled: (task, wasExecuting) => {
                    this.emitPoolEvent(PoolEvent.TASK_CANCELLED, {
                        taskId: task.id,
                        task: task.task,
                        wasExecuting,
                    });
                },
                onExpired: (task, waitTimeMs) => {
                    this.emitPoolEvent(PoolEvent.TASK_EXPIRED, {
                        taskId: task.id,
                        task: task.task,
                        waitTimeMs,
                    });
                },
            },
            config.taskQueue,
            this.logger,
        );
    } else {
        this.taskQueue = null;
    }
}
```

#### C. Refactorer `execute()` pour supporter la queue

L'actuel `execute()` fait deux choses :
1. Guard contre l'exécution concurrente
2. Exécute la tâche

On sépare ces responsabilités :

```typescript
/**
 * Executes a task by analyzing it, deciding on a strategy, spawning
 * agent(s), and orchestrating the full execution pipeline.
 *
 * ## Behavior with TaskQueue
 *
 * When the task queue is enabled (`taskQueue.enabled: true`):
 * - If a slot is available, the task executes immediately.
 * - If all slots are busy, the task is queued and executed when
 *   a slot frees up.
 * - The method still returns a Promise<AgentPoolResult> that resolves
 *   when the task completes (which may be later if queued).
 *
 * When the task queue is NOT enabled (default):
 * - Throws if a task is already executing (legacy behavior).
 *
 * @param task - The user's task description.
 * @returns A complete {@link AgentPoolResult} with all execution details.
 * @throws If the pool has been destroyed.
 * @throws If already executing and queue is not enabled.
 */
async execute(task: string): Promise<AgentPoolResult> {
    this.assertNotDestroyed();

    // If queue is enabled, go through the queue
    if (this.taskQueue) {
        const handle = this.taskQueue.enqueue(task);
        return handle.completion;
    }

    // Legacy behavior: no queue, single execution
    if (this._executing) {
        throw new Error(
            "AgentPool is already executing a task. Wait for the current execution to complete or cancel it.",
        );
    }

    return this.executeInternal(task);
}
```

#### D. Extraire `executeInternal()`

Renommer le corps actuel de `execute()` (tout ce qui est après le guard `_executing`) en une méthode privée `executeInternal()` :

```typescript
/**
 * Internal execution method — runs the full pipeline for a single task.
 *
 * This is the actual implementation of task execution, extracted from
 * `execute()` to support both direct calls and queue-based execution.
 *
 * The `_executing` flag management changes depending on whether
 * the queue is enabled:
 * - Without queue: `_executing` is a boolean — only one task at a time.
 * - With queue: `_executingCount` tracks concurrent executions. The
 *   `_executing` flag remains `true` as long as any task is running.
 *
 * @param task - The task description.
 * @returns The execution result.
 */
private async executeInternal(task: string): Promise<AgentPoolResult> {
    // ── Model validation (cached — only hits OpenRouter API once) ────
    await this.conversations.client.validateModel();

    const startTime = Date.now();
    this._executingCount++;
    this._executing = true;

    // NOTE: _currentTask is only meaningful for single-execution mode.
    // With the queue, multiple tasks may overlap and _currentTask
    // reflects the most recently started one.
    this._currentTask = task;

    this.emitPoolEvent(PoolEvent.TASK_RECEIVED, { task });

    try {
        // ... all the existing execution phases ...
        // (planning, spawn, execute subtasks, summary, cleanup)
        // ... identical to the current execute() body ...

        return poolResult;
    } catch (error) {
        // ... existing error handling ...
        throw error;
    } finally {
        this._executingCount--;
        if (this._executingCount === 0) {
            this._executing = false;
            this._currentTask = null;
        }
        this._currentStrategy = null;
        this._currentAnalysis = null;
        this.informationBroker = null;
        this.subtaskToAgent.clear();
        this.agentToSubtask.clear();
        this._deltaCount = 0;
        this._sharingDecisionCount = 0;
    }
}
```

**Important** : Ajouter un champ `private _executingCount = 0;` à la classe pour tracker le nombre d'exécutions concurrentes.

#### E. Ajouter la méthode publique `enqueue()`

```typescript
/**
 * Submits a task to the queue for non-blocking execution.
 *
 * Returns immediately with a `TaskHandle` that provides a `completion`
 * promise and a `cancel()` method.
 *
 * Only available when the task queue is enabled in the configuration.
 * Throws if the queue is not enabled.
 *
 * @param task - The task description.
 * @param options - Optional overrides (priority).
 * @returns A `TaskHandle` for tracking and cancellation.
 * @throws If the queue is not enabled.
 * @throws If the queue is full.
 * @throws If the pool has been destroyed.
 *
 * @example
 * ```ts
 * const pool = new AgentPool({
 *   openRouterApiKey: "...",
 *   taskQueue: { enabled: true, maxConcurrent: 2 },
 * });
 *
 * // Non-blocking
 * const handle1 = pool.enqueue("Build the API");
 * const handle2 = pool.enqueue("Write documentation");
 *
 * // Both run in parallel (maxConcurrent: 2)
 * const [result1, result2] = await Promise.all([
 *   handle1.completion,
 *   handle2.completion,
 * ]);
 *
 * // Or cancel one
 * await handle2.cancel();
 * ```
 */
enqueue(task: string, options?: { priority?: number }): TaskHandle {
    this.assertNotDestroyed();

    if (!this.taskQueue) {
        throw new Error(
            "Task queue is not enabled. Set `taskQueue: { enabled: true }` " +
            "in the AgentPool configuration, or use `execute()` for single-task execution.",
        );
    }

    return this.taskQueue.enqueue(task, options);
}
```

#### F. Modifier `send()` pour utiliser la queue quand disponible

Dans le handler `UserIntent.NEW_TASK` du `send()` :

```typescript
case UserIntent.NEW_TASK: {
    const taskText =
        typeof intent.parameters.task === "string"
            ? intent.parameters.task
            : message;

    // If queue is enabled and pool is busy, queue the task
    if (this.taskQueue) {
        const handle = this.taskQueue.enqueue(taskText);
        return `Task queued (ID: ${handle.id}, position: ${handle.position}). ` +
            `It will execute when a slot is available.`;
    }

    // Legacy behavior: execute directly
    return this.execute(taskText);
}
```

**Note** : Quand la queue est active et une tâche est soumise via `send()`, on retourne un message string au lieu de l'`AgentPoolResult`. L'utilisateur peut ensuite interroger le statut via `send("what's the status?")`.

#### G. Enrichir `getState()` avec l'état de la queue

```typescript
getState(): AgentPoolState {
    // ... existing state ...

    return {
        // ... existing fields ...
        queue: this.taskQueue ? this.taskQueue.getState() : null,
    };
}
```

#### H. Enrichir le STATUS_QUERY pour afficher la queue

Dans le handler `UserIntent.STATUS_QUERY` du `send()` :

```typescript
case UserIntent.STATUS_QUERY: {
    const state = this.getState();

    const lines: string[] = [];

    if (state.queue) {
        lines.push(`**Queue**: ${state.queue.pendingCount} pending, ${state.queue.executingCount} executing, ${state.queue.processedCount} processed`);
        lines.push("");

        if (state.queue.executingTasks.length > 0) {
            lines.push("**Executing Tasks**:");
            for (const t of state.queue.executingTasks) {
                lines.push(`- 🔄 ${t.task.slice(0, 80)} (started: ${t.startedAt})`);
            }
            lines.push("");
        }

        if (state.queue.pendingTasks.length > 0) {
            lines.push("**Pending Tasks**:");
            for (const t of state.queue.pendingTasks) {
                lines.push(`- ⏳ ${t.task.slice(0, 80)} (priority: ${t.priority})`);
            }
            lines.push("");
        }
    }

    if (!state.executing && (!state.queue || state.queue.executingCount === 0)) {
        lines.push("The pool is idle. No task is currently being executed.");
    } else if (state.executing && !state.queue) {
        lines.push(`**Current Task**: ${state.currentTask}`);
        lines.push(`**Strategy**: ${state.strategy}`);
        lines.push(`**Active Agents**: ${state.activeAgentCount}`);
        lines.push("");
        lines.push("**Agents**:");

        for (const agent of state.agents) {
            lines.push(
                `- ${agent.agentName} (${agent.taskRole}): ${agent.completed ? "✅ completed" : `⚙️ ${agent.status}`}`,
            );
        }
    }

    return lines.join("\n");
}
```

#### I. Ajouter le `cancel` intent support pour les tasks queueées

Enrichir le handler `UserIntent.CANCEL` dans `send()` :

```typescript
case UserIntent.CANCEL: {
    if (this.taskQueue) {
        // If a specific task ID is mentioned, cancel it
        const targetTaskId =
            typeof intent.parameters.taskId === "string"
                ? intent.parameters.taskId
                : undefined;

        if (targetTaskId) {
            const cancelled = await this.taskQueue.cancelTask(targetTaskId);
            return cancelled
                ? `Task ${targetTaskId} cancelled.`
                : `Task ${targetTaskId} not found or already completed.`;
        }

        // Cancel all pending + executing
        await this.taskQueue.shutdown(false);
        return "All queued and executing tasks cancelled.";
    }

    // Legacy behavior
    if (!this._executing) {
        return "No task is currently executing.";
    }

    await this.destroyManagedAgents();
    return "Current execution cancelled. All agents destroyed.";
}
```

#### J. Shutdown la queue dans `destroy()`

```typescript
async destroy(): Promise<void> {
    if (this._destroyed) return;

    // Shutdown the queue first (cancels pending, optionally waits for executing)
    if (this.taskQueue) {
        await this.taskQueue.shutdown(false);
    }

    // ... existing destroy logic ...
}
```

### 5. Concurrency et isolation des exécutions

Quand `maxConcurrent > 1`, plusieurs tâches s'exécutent en parallèle. Il y a des points d'attention pour l'isolation :

#### A. Le `ConversationManager` est partagé

Toutes les tâches concurrentes partagent le même `ConversationManager` et ses conversations. Les conversations one-shot (`sendOneShotJson`) sont safe car elles n'accumulent pas d'historique. Les conversations avec historique (`PLANNER`) sont reset per-execution, ce qui est safe si chaque tâche reset avant d'utiliser.

**Solution** : Le `PLANNER` reset déjà sa conversation dans `analyze()`. Les autres conversations utilisent `sendOneShotJson`. Pas de changement nécessaire.

#### B. Le `ContextTracker` accumule les agents de toutes les tâches

Les agents de tâches concurrentes cohabitent dans le même `ContextTracker`. C'est acceptable car le tracker indexe par `agentId` (unique). L'`InformationBroker` est recréé per-execution et n'opère que sur les agents de sa tâche.

**Solution** : L'`InformationBroker` est instancié dans `executeInternal()` en variable locale (pas un champ de la classe). Chaque tâche a son propre broker. Modifier `executeInternal()` pour utiliser un broker local au lieu du champ `this.informationBroker`.

```typescript
// Dans executeInternal(), au lieu de :
// this.informationBroker = new InformationBroker(...);
// Utiliser :
const informationBroker = new InformationBroker(...);
// Et passer ce broker local aux méthodes qui en ont besoin
```

#### C. Le `maxAgents` est partagé

Le nombre total d'agents actifs (toutes tâches confondues) doit respecter `maxAgents`. Chaque tâche consomme un sous-ensemble de la pool d'agents.

**Solution** : Avant de spawner les agents d'une tâche, calculer le nombre de slots disponibles :

```typescript
const currentActiveAgentCount = this.managedAgents.size;
const availableSlots = Math.max(0, this.config.maxAgents - currentActiveAgentCount);
const subtasksToSpawn = analysis.subtasks.slice(0, availableSlots);
```

#### D. Les compteurs `_deltaCount`, `_sharingDecisionCount` sont partagés

Ces compteurs sont par-pool, pas per-execution. Avec la concurrence, ils reflètent l'activité cumulée, ce qui est acceptable pour les stats globales.

**Solution** : Aucun changement nécessaire — les stats sont globales.

### 6. Gestion du `maxAgents` en mode concurrent

L'implémentation actuelle de `spawnAgents()` tronque les subtasks au `maxAgents` global. En mode concurrent, il faut aussi tenir compte des agents déjà actifs d'autres tâches :

```typescript
private async spawnAgents(
    analysis: TaskAnalysis,
): Promise<Map<string, { agent: PoolManagedAgent; subtask: SubTask }>> {
    // ... existing code ...

    // Enforce max agents INCLUDING agents from concurrent tasks
    const currentActiveCount = this.managedAgents.size;
    const availableSlots = Math.max(0, this.config.maxAgents - currentActiveCount);

    const subtasksToSpawn = analysis.subtasks.slice(0, availableSlots);

    if (subtasksToSpawn.length === 0) {
        this.logger.warn(
            {
                requested: analysis.subtasks.length,
                currentActive: currentActiveCount,
                limit: this.config.maxAgents,
            },
            "No agent slots available — maxAgents limit reached by concurrent tasks",
        );
        // Fall back to a single agent when all slots are taken
        // This ensures the task can still proceed, even if reduced
        // The subtask will be retried by the pool when slots free up
        throw new Error(
            `Cannot spawn agents — all ${this.config.maxAgents} slots are in use by concurrent tasks. ` +
            `Consider increasing maxAgents or reducing maxConcurrent.`,
        );
    }

    if (subtasksToSpawn.length < analysis.subtasks.length) {
        this.logger.warn(
            {
                requested: analysis.subtasks.length,
                available: availableSlots,
                limit: this.config.maxAgents,
                spawning: subtasksToSpawn.length,
            },
            `Subtask count limited by concurrent agent usage (${currentActiveCount}/${this.config.maxAgents} slots in use)`,
        );
    }

    // ... rest of existing spawn logic ...
}
```

---

## Configuration examples

### Pas de queue (défaut — comportement legacy)

```typescript
const pool = new AgentPool({
    openRouterApiKey: "...",
    // Pas de taskQueue → comportement inchangé
});

const result = await pool.execute("Build API"); // Bloquant
```

### Queue séquentielle (FIFO)

```typescript
const pool = new AgentPool({
    openRouterApiKey: "...",
    taskQueue: {
        enabled: true,
        maxConcurrent: 1,
    },
});

// Trois tâches soumises — exécutées une par une dans l'ordre
const h1 = pool.enqueue("Build API");
const h2 = pool.enqueue("Write tests");
const h3 = pool.enqueue("Write docs");

// Attendre toutes les tâches
const results = await Promise.all([
    h1.completion,
    h2.completion,
    h3.completion,
]);
```

### Queue concurrente avec priorité

```typescript
const pool = new AgentPool({
    openRouterApiKey: "...",
    maxAgents: 10, // Enough for 2 multi-agent tasks
    taskQueue: {
        enabled: true,
        maxConcurrent: 2,
        maxQueueSize: 10,
        defaultPriority: 0,
    },
});

// Normal priority
pool.enqueue("Generate README");

// High priority — executed first if slot is available
pool.enqueue("Fix critical bug in auth", { priority: 100 });

// Also high priority — after the bug fix
pool.enqueue("Deploy hotfix", { priority: 99 });
```

### Queue avec timeout

```typescript
const pool = new AgentPool({
    openRouterApiKey: "...",
    taskQueue: {
        enabled: true,
        maxConcurrent: 1,
        queueTimeoutMs: 300_000, // Tasks expire if they wait 5+ minutes
    },
});

pool.on(PoolEvent.TASK_EXPIRED, (e) => {
    console.warn(`Task expired: ${e.task} (waited ${e.waitTimeMs}ms)`);
});
```

### Utilisation avec `send()` pendant une exécution

```typescript
const pool = new AgentPool({
    openRouterApiKey: "...",
    taskQueue: { enabled: true },
});

// First task starts immediately
await pool.send("Build the REST API");
// → Executes immediately

// Second task while first is running
await pool.send("Now add authentication");
// → Returns "Task queued (ID: task-xyz, position: 0)..."

// Check status
await pool.send("What's the status?");
// → Shows queue state with pending/executing tasks
```

---

## Interaction avec les évolutions précédentes

### Avec l'évolution 10 (Timeout & Retry)

Les timeouts de subtask s'appliquent **à l'intérieur** de chaque tâche, indépendamment de la queue. Le `queueTimeoutMs` s'applique au temps d'attente **dans la queue** (avant l'exécution). Les deux sont orthogonaux.

### Avec l'évolution 11 (Adaptive Re-planning)

Le re-planning s'exécute dans le contexte d'une tâche individuelle. Si une tâche en cours fait un `restart` (via `ReplanRestartError`), elle recommence dans le même slot d'exécution — pas besoin de re-queue.

### Avec l'évolution 13 (Planner Memory)

Les `PlannerMemory` sont partagées entre toutes les tâches. Si deux tâches s'exécutent en parallèle et que la première termine, son `recordExecution()` enrichit la mémoire pour la deuxième tâche qui est peut-être déjà en cours de planning. C'est un bénéfice collatéral — pas un problème.

### Avec l'évolution 17 (Reflection)

La réflexion post-exécution se fait per-task dans `executeInternal()`. Les `ExecutionInsight` sont stockés dans le `ReflectionEngine` partagé, donc les tâches suivantes dans la queue bénéficient des insights des tâches précédentes.

### Avec l'évolution 19 (Cost Tracking)

Le `CostTracker` agrège les coûts de **toutes** les tâches concurrentes. Le budget est partagé — si deux tâches s'exécutent en parallèle et consomment beaucoup de tokens, le budget est atteint plus vite. Le `UsageSnapshot` dans `AgentPoolResult` reflète uniquement la consommation de cette tâche spécifique.

**Point d'attention** : Pour isoler le coût par tâche, il faudrait soit un cost tracker per-task, soit un mécanisme de tagging des appels par taskId. Pour cette évolution, le cost tracker reste global et le `UsageSnapshot` dans le résultat est un snapshot global au moment de la complétion de la tâche. L'isolation du coût per-task est laissée pour une évolution future.

---

## Tests à implémenter

### Tests unitaires pour `TaskQueue`

#### Test 1 : `enqueue` retourne un `TaskHandle` valide

- Setup : créer une queue avec un executor mock
- Appeler `enqueue("test task")`
- Assert : le handle a un `id` non-vide, `position: 0`, `completion` est une Promise, `cancel` est une function

#### Test 2 : Les tâches sont exécutées en FIFO

- Setup : queue avec `maxConcurrent: 1`
- Enqueuer 3 tâches avec un executor qui enregistre l'ordre
- Attendre la complétion
- Assert : les tâches ont été exécutées dans l'ordre de soumission

#### Test 3 : La priorité override l'ordre FIFO

- Setup : queue avec `maxConcurrent: 1`, exécuter une tâche qui bloque
- Enqueuer task-A (priority: 0), task-B (priority: 10), task-C (priority: 5)
- Libérer le slot
- Assert : l'ordre d'exécution est task-B, task-C, task-A

#### Test 4 : FIFO au sein d'une même priorité

- Setup : queue avec `maxConcurrent: 1`
- Enqueuer task-A (priority: 5), task-B (priority: 5), task-C (priority: 5)
- Assert : l'ordre d'exécution est task-A, task-B, task-C

#### Test 5 : `maxConcurrent: 2` exécute deux tâches en parallèle

- Setup : queue avec `maxConcurrent: 2`, executor qui prend 100ms
- Enqueuer 2 tâches simultanément
- Assert : les deux tâches démarrent immédiatement (pas de queue)
- Assert : `executingCount === 2`

#### Test 6 : `maxConcurrent: 2` queue la 3ème tâche

- Setup : queue avec `maxConcurrent: 2`
- Enqueuer 3 tâches, les 2 premières bloquantes
- Assert : la 3ème est en statut "queued"
- Compléter une des deux premières
- Assert : la 3ème passe en "executing"

#### Test 7 : `maxQueueSize` rejette les tâches excédentaires

- Setup : queue avec `maxConcurrent: 1`, `maxQueueSize: 2`
- Enqueuer 3 tâches (1 executing + 2 pending = ok)
- Enqueuer une 4ème
- Assert : throw avec message "TaskQueue is full"

#### Test 8 : `cancelTask` annule une tâche en attente

- Setup : queue avec `maxConcurrent: 1`
- Enqueuer 2 tâches (1 executing, 1 pending)
- Appeler `cancelTask` sur la tâche pending
- Assert : retourne `true`
- Assert : le statut de la tâche est "cancelled"
- Assert : `handle.completion` est rejetée avec "Task cancelled"

#### Test 9 : `cancelTask` annule une tâche en cours d'exécution

- Setup : queue avec un executor qui attend un signal
- Enqueuer 1 tâche, attendre qu'elle démarre
- Appeler `cancelTask`
- Assert : retourne `true`
- Assert : le `abortController` est signalé
- Assert : le statut est "cancelled"

#### Test 10 : `cancelTask` retourne `false` pour une tâche terminée

- Setup : queue avec un executor rapide
- Enqueuer 1 tâche, attendre sa complétion
- Appeler `cancelTask`
- Assert : retourne `false`

#### Test 11 : `queueTimeoutMs` expire les tâches en attente

- Setup : queue avec `maxConcurrent: 1`, `queueTimeoutMs: 50`
- Enqueuer 2 tâches (1 executing, 1 pending)
- Attendre 60ms
- Assert : la tâche pending est expirée (statut: "expired")
- Assert : le callback `onExpired` a été appelé
- Assert : `handle.completion` est rejetée

#### Test 12 : Le timeout est annulé quand la tâche commence

- Setup : queue avec `queueTimeoutMs: 200`
- Enqueuer 1 tâche (démarre immédiatement — pas de timeout à déclencher)
- Assert : le timeout handle est nettoyé
- Attendre 250ms
- Assert : la tâche n'est PAS expirée

#### Test 13 : `shutdown` cancelle les tâches pending

- Setup : queue avec 3 tâches (1 executing, 2 pending)
- Appeler `shutdown(false)`
- Assert : les 2 pending sont cancelled
- Assert : la tâche executing est cancelled
- Assert : `isAccepting === false`

#### Test 14 : `shutdown(true)` attend les tâches executing

- Setup : queue avec un executor qui prend 100ms
- Enqueuer 1 tâche
- Appeler `shutdown(true)`
- Assert : la méthode attend que la tâche se termine
- Assert : la tâche est "completed" (pas "cancelled")

#### Test 15 : `shutdown` empêche les nouveaux enqueue

- Setup : `shutdown(false)`
- Appeler `enqueue()`
- Assert : throw "TaskQueue has been shut down"

#### Test 16 : `getState` retourne un snapshot correct

- Setup : queue avec 1 executing et 2 pending
- Assert : `pendingCount === 2`
- Assert : `executingCount === 1`
- Assert : `pendingTasks.length === 2`
- Assert : `executingTasks.length === 1`

#### Test 17 : `pruneCompleted` nettoie les vieilles tâches

- Setup : compléter 100 tâches
- Appeler `pruneCompleted(10)`
- Assert : seules les 10 plus récentes sont conservées

#### Test 18 : Le callback `onDrained` est appelé quand tout est terminé

- Setup : queue avec 3 tâches
- Attendre toutes les complétions
- Assert : `onDrained` a été appelé avec `{ total: 3, succeeded: 3, ... }`

#### Test 19 : Les tâches échouées n'empêchent pas les suivantes

- Setup : queue avec `maxConcurrent: 1`, executor qui fail sur la 2ème tâche
- Enqueuer 3 tâches
- Assert : la 1ère réussit, la 2ème échoue, la 3ème réussit
- Assert : `processedCount === 3`

#### Test 20 : Le drain ne crée pas de réentrance

- Setup : queue avec executor synchrone (résolution immédiate)
- Enqueuer 5 tâches rapidement
- Assert : toutes sont traitées sans erreur
- Assert : pas de stack overflow

### Tests d'intégration avec `AgentPool`

#### Test 21 : `pool.enqueue()` retourne un `TaskHandle`

- Configurer `taskQueue: { enabled: true }`
- Appeler `pool.enqueue("test")`
- Assert : retourne un handle avec `id`, `position`, `completion`, `cancel`

#### Test 22 : `pool.enqueue()` throw sans queue activée

- Configurer sans `taskQueue`
- Appeler `pool.enqueue("test")`
- Assert : throw "Task queue is not enabled"

#### Test 23 : `pool.execute()` queue la tâche quand la queue est activée et un slot est libre

- Configurer `taskQueue: { enabled: true }`
- Appeler `pool.execute("test")`
- Assert : la tâche s'exécute et retourne un résultat
- Assert : l'événement `TASK_QUEUED` est émis

#### Test 24 : `pool.execute()` queue la tâche quand le pool est busy

- Configurer `taskQueue: { enabled: true, maxConcurrent: 1 }`
- Appeler `pool.execute("task1")` (fire-and-forget)
- Appeler `pool.execute("task2")` (ne throw PAS — queued)
- Assert : les deux tâches sont complétées séquentiellement

#### Test 25 : `pool.execute()` throw quand le pool est busy sans queue

- Configurer sans `taskQueue`
- Appeler `pool.execute("task1")` (fire-and-forget)
- Appeler `pool.execute("task2")`
- Assert : throw "AgentPool is already executing"

#### Test 26 : `pool.send("new task")` queue quand la pool est busy

- Configurer `taskQueue: { enabled: true }`
- Lancer une exécution
- Appeler `pool.send("Do another thing")`
- Assert : retourne un message "Task queued..."
- Assert : la tâche est dans la queue

#### Test 27 : `pool.getState()` inclut la queue state

- Configurer `taskQueue: { enabled: true }`
- Enqueuer 2 tâches
- Assert : `state.queue.pendingCount >= 0`
- Assert : `state.queue.executingCount >= 0`

#### Test 28 : `pool.destroy()` shutdown la queue

- Configurer `taskQueue: { enabled: true }`
- Enqueuer 3 tâches
- Appeler `pool.destroy()`
- Assert : toutes les tâches pending sont cancelled
- Assert : la queue n'accepte plus de tâches

#### Test 29 : Les événements de queue sont émis correctement

- S'abonner à `TASK_QUEUED`, `TASK_DEQUEUED`, `QUEUE_DRAINED`
- Enqueuer et compléter 2 tâches
- Assert : `TASK_QUEUED` émis 2 fois
- Assert : `TASK_DEQUEUED` émis 2 fois
- Assert : `QUEUE_DRAINED` émis 1 fois

#### Test 30 : `maxAgents` est respecté avec des tâches concurrentes

- Configurer `maxAgents: 3`, `taskQueue: { enabled: true, maxConcurrent: 2 }`
- Enqueuer 2 tâches multi-agent (3 subtasks chacune)
- Assert : le nombre total d'agents actifs ne dépasse jamais 3
- Assert : au moins une des tâches a ses subtasks tronquées

### Tests de non-régression

#### Test 31 : Le pool sans queue se comporte identiquement

- Ne pas configurer `taskQueue`
- Assert : `execute()` bloque comme avant
- Assert : `execute()` pendant une exécution throw comme avant
- Assert : `getState().queue === null`
- Assert : `enqueue()` throw

#### Test 32 : Les événements existants sont toujours émis

- Configurer `taskQueue: { enabled: true }`
- Exécuter une tâche via la queue
- Assert : `TASK_RECEIVED`, `PLANNING_START`, `PLANNING_COMPLETE`, `AGENT_SPAWNED`, `EXECUTION_COMPLETE` sont toujours émis

#### Test 33 : Le `PlannerMemory` fonctionne avec la queue

- Exécuter 2 tâches séquentiellement via la queue
- Assert : le planner memory de la première est disponible pour la deuxième

#### Test 34 : Le `CostTracker` agrège les coûts de toutes les tâches

- Configurer `taskQueue: { enabled: true, maxConcurrent: 2 }`
- Exécuter 2 tâches en parallèle
- Assert : le `UsageSnapshot` final reflète les coûts des deux tâches

#### Test 35 : Le `send("status")` affiche les infos de la queue

- Configurer `taskQueue: { enabled: true }`
- Enqueuer 2 tâches
- Appeler `send("What's the status?")`
- Assert : la réponse contient les infos de queue (pending, executing)

---

## Critères de validation

- [ ] La `TaskQueue` est un composant découplé de l'`AgentPool` (testable unitairement)
- [ ] `enqueue()` retourne immédiatement un `TaskHandle` sans bloquer
- [ ] Le `TaskHandle.completion` promise se résout quand la tâche est terminée
- [ ] Le `TaskHandle.cancel()` annule une tâche pending ou executing
- [ ] Les tâches sont exécutées en FIFO au sein d'une même priorité
- [ ] Les tâches haute priorité passent devant les basse priorité
- [ ] `maxConcurrent: 1` exécute les tâches séquentiellement
- [ ] `maxConcurrent: N` exécute jusqu'à N tâches en parallèle
- [ ] `maxQueueSize` rejette les tâches excédentaires
- [ ] `queueTimeoutMs` expire les tâches en attente trop longtemps
- [ ] `execute()` utilise la queue quand elle est activée
- [ ] `execute()` throw en mode legacy quand le pool est busy
- [ ] `send("new task")` queue la tâche au lieu de throw quand la queue est activée
- [ ] `getState()` inclut l'état de la queue
- [ ] `destroy()` shutdown la queue proprement
- [ ] Les événements de queue sont émis (`TASK_QUEUED`, `TASK_DEQUEUED`, `QUEUE_DRAINED`, `TASK_CANCELLED`, `TASK_EXPIRED`)
- [ ] `maxAgents` est respecté entre les tâches concurrentes
- [ ] Le comportement legacy (sans queue) est inchangé
- [ ] Tous les tests existants passent toujours
- [ ] Les sous-systèmes (planner memory, reflection, cost tracker) fonctionnent avec la queue

---

## Points d'attention

1. **Backward compatibility absolue** — Sans `taskQueue` dans la config, le pool se comporte **exactement** comme avant. Aucun changement de comportement pour les utilisateurs existants.

2. **`executeInternal()` doit être re-entrant** — Quand `maxConcurrent > 1`, plusieurs appels à `executeInternal()` sont en vol simultanément. Les champs mutables de la classe (`managedAgents`, `subtaskToAgent`, `agentToSubtask`, etc.) sont partagés. Il faut s'assurer que chaque tâche opère sur ses propres agents sans interférence. Le plus sûr est de localiser les maps per-execution dans `executeInternal()` et de ne plus utiliser les champs de classe.

3. **L'`InformationBroker` doit être local à chaque exécution** — Actuellement `this.informationBroker` est un champ de classe réassigné à chaque exécution. En mode concurrent, il faut en faire une variable locale dans `executeInternal()`.

4. **Le `_currentTask` n'a plus de sens en mode concurrent** — Avec plusieurs tâches en cours, `_currentTask` est ambigu. En mode queue, `_currentTask` devrait être `null` ou un résumé. Le statut détaillé est dans `queue.getState()`.

5. **Les `PoolEvent` existants (`TASK_RECEIVED`, etc.) sont émis per-task** — En mode concurrent, plusieurs `TASK_RECEIVED` peuvent être émis simultanément. Les consumers d'events doivent être robustes à ça.

6. **Ne pas utiliser `Promise.all()` dans le send handler** — Quand `send()` queue une tâche, il retourne un `string` (pas un `AgentPoolResult`). L'utilisateur doit utiliser `enqueue()` s'il veut le handle.

7. **Le `shutdown()` de la queue doit être appelé AVANT le `destroy()` de la pool** — Sinon, les tâches en cours pourraient tenter d'utiliser des ressources destroyed.

8. **Memory leaks** — Les tâches complétées restent dans `tasks` Map. Appeler `pruneCompleted()` périodiquement ou après chaque drain. Ne pas garder plus de 50-100 tâches historiques en mémoire.

9. **Le retry d'une tâche queueée n'est PAS dans le scope** — Si une tâche échoue, elle est marquée `failed` et la promesse est rejetée. Le retry est géré au niveau subtask (évolution 10), pas au niveau tâche. L'utilisateur peut re-soumettre manuellement.

10. **La sérialisation de `QueuedTask.result`** — Le `result` dans `QueuedTask` est un `AgentPoolResult` complet qui peut être volumineux. Pour `getState()`, on ne l'inclut pas — seulement les métadonnées. Le résultat complet est accessible via `TaskHandle.completion`.