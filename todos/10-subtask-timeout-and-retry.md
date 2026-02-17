# Évolution 10 — Mécanisme de timeout et retry par subtask

## Priorité : 🟡 P2

## Dépendances : Aucune

## Acquis des évolutions précédentes

- **Évolution 01** : L'`InformationBroker` reçoit les mappings `subtaskToAgent` / `agentToSubtask` via son constructeur. `isAgentForSubtask()` fonctionne. Le tri des candidats par dépendance est opérationnel. `findDependency()` traduit correctement entre agent IDs et subtask IDs.
- **Évolution 02** : L'`InformationBroker` maintient un `SharingHistory` indexé par agent cible. Le prompt de partage inclut les partages précédents (`previouslyShared`). `recordSharing()` est appelé après chaque injection réussie. Le type `SharingRecord` existe.
- **Évolution 03** : Le `ProjectScanner` scanne le répertoire de travail et produit un `ProjectContext`. Le planner reçoit le contexte projet.
- **Évolution 04** : Tous les prompts LLM contiennent des exemples few-shot contrastifs.
- **Évolution 05** : Le rôle `ConversationRole.SHARING_ANALYZER` existe. Le system prompt `SHARING_ANALYZER` est dédié au partage inter-agents. L'`InformationBroker` utilise `SHARING_ANALYZER`.
- **Évolution 06** : Le notification prompt est nettoyé. Le summary prompt inclut les `CoordinationStats` et `sharingSummaries`. `durationMs` est correctement calculé.
- **Évolution 07** : Le preview dans les deltas `PROMPT_COMPLETE` est augmenté à 2000 chars. Le champ `promptResultSummary` existe dans `ContextDelta`. L'`InformationBroker` dispose de `evaluateWithFullResult()` pour les blocking deps.
- **Évolution 08** : L'injection de contexte est structurée avec `StructuredContextInjection`, `ContextInjectionPriority` et `ContextInjectionCategory`. Les injections sont triées par priorité. L'overflow est géré (drop LOW puis NORMAL). Les CRITICAL/HIGH ne sont jamais droppées. `AgentContextManager` supporte les deux modes (legacy string et structured).
- **Évolution 09** : Le seuil de significance est dynamique, adapté selon la phase d'exécution, le type de dépendance et le nombre d'agents actifs. La constante statique `0.6` est remplacée par un calcul contextuel.

---

## Contexte du problème

### Pas de timeout par subtask

Un agent peut rester bloqué indéfiniment sans que le pool n'intervienne. Les causes possibles :

1. **Boucle infinie dans un tool** — l'agent demande un outil (ex: terminal) qui ne retourne jamais (ex: `npm run dev` qui lance un serveur)
2. **LLM qui ne termine pas** — le provider LLM est lent ou ne répond plus
3. **Agent qui itère excessivement** — l'agent fait des dizaines de tool calls sans converger (lit des fichiers en boucle, essaie la même commande qui échoue, etc.)
4. **Deadlock ACP** — le process ACP sous-jacent est bloqué (rare mais possible)

Actuellement, le pool attend indéfiniment dans `executeSubtasks()` :

```typescript
// src/classes/agent-pool/agent-pool.ts — executeSubtasks()
const promptResult = await agent.prompt(subtask.prompt);  // ← Peut bloquer indéfiniment
```

Il n'y a aucun mécanisme de timeout, de watchdog, ni de circuit breaker.

### Pas de retry individuel par subtask

Quand un agent échoue (erreur, crash du process ACP, etc.), le subtask est marqué `failed` et c'est terminé :

```typescript
// src/classes/agent-pool/agent-pool.ts — executeSubtasks(), dans le catch
this.contextTracker.markFailed(agent.id, errorMessage);
failed.add(subtaskId);
inProgress.delete(subtaskId);

results.push({
    // ...
    success: false,
    error: errorMessage,
});
```

Aucune tentative de relance. Si l'erreur est transitoire (timeout réseau, process crash récupérable), l'opportunité de récupération est perdue.

### Conséquences

- **Exécutions bloquées** — une tâche multi-agent peut rester suspendue indéfiniment si un agent bloque
- **Gaspillage de travail** — si 2 agents sur 3 réussissent et le 3ème échoue sur une erreur transitoire, tout le travail des 2 premiers est perdu (pas de retry, et les agents downstream avec des blocking deps sont deadlockés)
- **Pas de visibilité** — l'utilisateur n'a aucune indication qu'un agent est bloqué (sauf s'il poll `getState()` régulièrement)

---

## Fichiers impactés

| Fichier | Action |
|---------|--------|
| `src/types/agent-pool.types.ts` | Ajouter les types `SubtaskTimeoutConfig`, `SubtaskRetryConfig`, enrichir `AgentPoolConfig` et `AgentExecutionResult` |
| `src/classes/agent-pool/agent-pool.ts` | Implémenter le timeout wrapper, le retry loop, et les nouvelles phases d'exécution |
| `src/enums/pool-event.enum.ts` | Ajouter `AGENT_TIMEOUT` et `AGENT_RETRY` events |
| `src/types/agent-pool.types.ts` | Ajouter les event types correspondants dans `PoolEventMap` |
| `src/classes/agent-pool/context-tracker.ts` | Ajouter `markTimedOut()` |
| `src/classes/agent-pool/tests/` | Tests unitaires pour timeout et retry |

---

## Spécification détaillée des changements

### 1. Nouveaux types dans `agent-pool.types.ts`

#### Configuration du timeout

```typescript
/**
 * Configuration for subtask-level timeouts.
 *
 * A timeout is applied to each individual subtask's `agent.prompt()` call.
 * When a subtask exceeds its timeout, the agent is destroyed and the
 * subtask is either retried (if retries are configured) or marked as failed.
 */
export interface SubtaskTimeoutConfig {
    /**
     * Maximum duration (in milliseconds) for a single subtask execution.
     *
     * This includes the full `agent.prompt()` call — all tool calls,
     * file operations, and LLM round-trips within that prompt.
     *
     * Default: 300_000 (5 minutes).
     *
     * Set to `0` or `Infinity` to disable timeout.
     */
    readonly subtaskTimeoutMs: number;

    /**
     * Optional per-complexity timeout overrides.
     *
     * If provided, overrides `subtaskTimeoutMs` based on the assessed
     * task complexity from the planner. This allows giving more time
     * to complex subtasks without inflating the timeout for simple ones.
     *
     * If a complexity level is not specified, `subtaskTimeoutMs` is used.
     */
    readonly complexityTimeouts?: {
        readonly simple?: number;
        readonly moderate?: number;
        readonly complex?: number;
    };
}
```

#### Configuration du retry

```typescript
/**
 * Configuration for subtask-level retry behavior.
 *
 * When a subtask fails (error or timeout), it can be retried with
 * a fresh agent instance. The retry prompt includes the error context
 * from the previous attempt to help the agent avoid the same mistake.
 */
export interface SubtaskRetryConfig {
    /**
     * Maximum number of retry attempts per subtask (not counting the initial attempt).
     *
     * Default: 1 (one retry allowed, so 2 total attempts).
     * Set to 0 to disable retries.
     */
    readonly maxRetries: number;

    /**
     * Whether to include the error context from the previous attempt
     * in the retry prompt.
     *
     * When `true`, the retry prompt is augmented with:
     * - The error message from the previous attempt
     * - A summary of what the previous agent did before failing
     * - Instructions to avoid the same mistake
     *
     * Default: true.
     */
    readonly includeErrorContext: boolean;

    /**
     * Delay in milliseconds before retrying a failed subtask.
     *
     * Useful for transient errors (network issues, rate limiting).
     * Default: 2000 (2 seconds).
     */
    readonly retryDelayMs: number;

    /**
     * Whether to retry on timeout specifically (as opposed to only on errors).
     *
     * Default: true.
     */
    readonly retryOnTimeout: boolean;
}
```

#### Enrichir `AgentPoolConfig`

```typescript
export interface AgentPoolConfig {
    // ... existing fields ...

    /**
     * Subtask timeout configuration.
     *
     * When specified, each subtask execution is bounded by a timeout.
     * Agents that exceed the timeout are destroyed and the subtask
     * is either retried or marked as failed.
     *
     * Default: { subtaskTimeoutMs: 300_000 } (5 minutes).
     * Set `subtaskTimeoutMs: 0` or `subtaskTimeoutMs: Infinity` to disable.
     */
    readonly timeout?: SubtaskTimeoutConfig;

    /**
     * Subtask retry configuration.
     *
     * When specified, failed subtasks can be retried with fresh agent instances.
     * The retry prompt includes error context from the previous attempt.
     *
     * Default: { maxRetries: 1, includeErrorContext: true, retryDelayMs: 2000, retryOnTimeout: true }.
     * Set `maxRetries: 0` to disable retries.
     */
    readonly retry?: SubtaskRetryConfig;
}
```

#### Enrichir `AgentExecutionResult`

```typescript
export interface AgentExecutionResult {
    // ... existing fields ...

    /**
     * Number of retry attempts made for this subtask.
     * 0 means the subtask succeeded (or failed) on the first attempt.
     */
    readonly retryCount: number;

    /**
     * Whether this subtask was terminated due to a timeout.
     * `true` means the agent exceeded the configured timeout and was destroyed.
     */
    readonly timedOut: boolean;

    /**
     * Duration in milliseconds for this subtask's execution
     * (last attempt only — does not include retry delays).
     */
    readonly subtaskDurationMs: number;
}
```

### 2. Nouveaux pool events

Dans `src/enums/pool-event.enum.ts` :

```typescript
export enum PoolEvent {
    // ... existing events ...

    /**
     * An agent exceeded its subtask timeout and was destroyed.
     *
     * Emitted before a retry attempt (if configured) or before
     * marking the subtask as failed.
     */
    AGENT_TIMEOUT = "pool:agent-timeout",

    /**
     * A failed subtask is being retried with a fresh agent.
     *
     * Emitted when a subtask that failed (error or timeout) is
     * about to be retried. The payload includes the attempt number
     * and the error from the previous attempt.
     */
    AGENT_RETRY = "pool:agent-retry",
}
```

Dans `src/types/agent-pool.types.ts`, ajouter les event types dans `PoolEventMap` :

```typescript
export interface AgentTimeoutEvent extends BasePoolEvent {
    readonly agentId: string;
    readonly agentName: string;
    readonly subtaskId: string;
    readonly timeoutMs: number;
    readonly elapsedMs: number;
}

export interface AgentRetryEvent extends BasePoolEvent {
    readonly agentId: string;
    readonly agentName: string;
    readonly subtaskId: string;
    readonly attempt: number;
    readonly maxRetries: number;
    readonly previousError: string;
}

export interface PoolEventMap {
    // ... existing mappings ...
    [PoolEvent.AGENT_TIMEOUT]: AgentTimeoutEvent;
    [PoolEvent.AGENT_RETRY]: AgentRetryEvent;
}
```

### 3. Ajouter `markTimedOut()` dans `ContextTracker`

Dans `src/classes/agent-pool/context-tracker.ts` :

```typescript
/**
 * Marks an agent as timed out.
 *
 * Similar to `markFailed()` but records the timeout specifically
 * so it can be distinguished from other failures in logs and events.
 *
 * @param agentId - The agent that timed out.
 * @param timeoutMs - The timeout duration that was exceeded.
 * @param elapsedMs - The actual elapsed time before timeout was triggered.
 */
markTimedOut(agentId: string, timeoutMs: number, elapsedMs: number): void {
    const state = this.agents.get(agentId);
    if (!state) return;

    state.completed = true;
    state.error = `Timed out after ${elapsedMs}ms (limit: ${timeoutMs}ms)`;
    state.status = AgentStatus.ERROR;
}
```

### 4. Implémenter le timeout wrapper

Créer une utility function privée dans `agent-pool.ts` pour wrapper l'appel `agent.prompt()` avec un timeout :

```typescript
/**
 * Executes a subtask prompt with an optional timeout.
 *
 * If the timeout is reached, the agent is destroyed (to stop any
 * in-flight tool calls) and a TimeoutError is thrown. The caller
 * is responsible for handling the error (retry or mark as failed).
 *
 * @param agent - The agent to prompt.
 * @param prompt - The prompt text.
 * @param timeoutMs - The timeout in milliseconds. 0 or Infinity disables.
 * @param subtaskId - The subtask ID (for logging/events).
 * @returns The prompt result.
 * @throws TimeoutError if the timeout is exceeded.
 * @throws Any error from the underlying agent.prompt() call.
 */
private async executeWithTimeout(
    agent: PoolManagedAgent,
    prompt: string,
    timeoutMs: number,
    subtaskId: string,
): Promise<PromptResult> {
    // No timeout — just call prompt directly
    if (!timeoutMs || timeoutMs === Infinity || timeoutMs <= 0) {
        return agent.prompt(prompt);
    }

    const startTime = Date.now();

    // Create a timeout promise that rejects after the specified duration
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
            const elapsed = Date.now() - startTime;

            this.logger.warn(
                {
                    agentId: agent.id,
                    agentName: agent.name,
                    subtaskId,
                    timeoutMs,
                    elapsedMs: elapsed,
                },
                `Subtask timed out after ${elapsed}ms (limit: ${timeoutMs}ms)`,
            );

            this.contextTracker.markTimedOut(agent.id, timeoutMs, elapsed);

            this.emitPoolEvent(PoolEvent.AGENT_TIMEOUT, {
                agentId: agent.id,
                agentName: agent.name,
                subtaskId,
                timeoutMs,
                elapsedMs: elapsed,
            });

            // Destroy the agent to stop in-flight operations
            agent.destroy().catch((err) => {
                this.logger.warn(
                    { agentId: agent.id, error: toErrorMessage(err) },
                    "Failed to destroy timed-out agent",
                );
            });

            reject(new SubtaskTimeoutError(agent.name, subtaskId, timeoutMs, elapsed));
        }, timeoutMs);
    });

    try {
        // Race the prompt against the timeout
        const result = await Promise.race([
            agent.prompt(prompt),
            timeoutPromise,
        ]);

        return result;
    } finally {
        // Always clear the timeout to prevent leaks
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
    }
}
```

### 5. Créer `SubtaskTimeoutError`

Add a custom error class (either in `agent-pool.ts` or in `src/utils/errors.ts`):

```typescript
/**
 * Thrown when a subtask exceeds its configured timeout.
 *
 * Distinguished from other errors so the retry logic can check
 * `retryOnTimeout` configuration.
 */
export class SubtaskTimeoutError extends Error {
    readonly isTimeout = true;

    constructor(
        readonly agentName: string,
        readonly subtaskId: string,
        readonly timeoutMs: number,
        readonly elapsedMs: number,
    ) {
        super(
            `Subtask "${subtaskId}" (agent: ${agentName}) timed out ` +
            `after ${elapsedMs}ms (limit: ${timeoutMs}ms)`,
        );
        this.name = "SubtaskTimeoutError";
    }
}
```

### 6. Implémenter le retry loop dans `executeSubtasks()`

Refactorer la logique d'exécution d'un subtask individuel dans `executeSubtasks()` pour inclure le retry :

```typescript
/**
 * Executes a single subtask with retry support.
 *
 * On failure, if retries are configured and the error is eligible:
 * 1. The failed agent is destroyed
 * 2. A new agent is spawned for the same subtask
 * 3. The prompt is augmented with error context from the previous attempt
 * 4. The subtask is re-executed
 *
 * @param subtask - The subtask to execute.
 * @param agent - The initial agent (may be replaced on retry).
 * @param analysis - The full task analysis (for dependency context).
 * @param agents - The agents map (updated on retry with the new agent).
 * @returns The execution result.
 */
private async executeSubtaskWithRetry(
    subtask: SubTask,
    agent: PoolManagedAgent,
    analysis: TaskAnalysis,
    agents: Map<string, { agent: PoolManagedAgent; subtask: SubTask }>,
): Promise<AgentExecutionResult> {
    const retryConfig = this.resolveRetryConfig();
    const timeoutMs = this.resolveTimeoutMs(analysis.complexity);

    let currentAgent = agent;
    let lastError: string | null = null;
    let retryCount = 0;
    let timedOut = false;

    for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
        const isRetry = attempt > 0;
        const subtaskStartTime = Date.now();

        if (isRetry) {
            this.logger.info(
                {
                    subtaskId: subtask.id,
                    attempt: attempt + 1,
                    maxAttempts: retryConfig.maxRetries + 1,
                    previousError: lastError,
                },
                `Retrying subtask ${subtask.role} (attempt ${attempt + 1}/${retryConfig.maxRetries + 1})`,
            );

            this.emitPoolEvent(PoolEvent.AGENT_RETRY, {
                agentId: currentAgent.id,
                agentName: currentAgent.name,
                subtaskId: subtask.id,
                attempt,
                maxRetries: retryConfig.maxRetries,
                previousError: lastError ?? "unknown",
            });

            // Wait before retrying
            if (retryConfig.retryDelayMs > 0) {
                await new Promise(resolve => setTimeout(resolve, retryConfig.retryDelayMs));
            }

            // Spawn a fresh agent for the retry
            try {
                currentAgent = await this.spawnRetryAgent(subtask);

                // Update the agents map with the new agent
                agents.set(subtask.id, { agent: currentAgent, subtask });
            } catch (spawnError) {
                const errorMsg = toErrorMessage(spawnError);
                this.logger.error(
                    { subtaskId: subtask.id, error: errorMsg },
                    "Failed to spawn retry agent — giving up",
                );
                return this.buildFailedResult(
                    currentAgent, subtask, errorMsg, retryCount, false, 0,
                );
            }
        }

        // Build the prompt (with error context if retrying)
        const prompt = isRetry && retryConfig.includeErrorContext
            ? this.buildRetryPrompt(subtask, lastError, attempt)
            : subtask.prompt;

        try {
            const promptResult = await this.executeWithTimeout(
                currentAgent,
                prompt,
                timeoutMs,
                subtask.id,
            );

            const subtaskDuration = Date.now() - subtaskStartTime;

            this.contextTracker.recordPromptResult(currentAgent.id, promptResult);
            this.contextTracker.markCompleted(currentAgent.id);

            const finalState = this.contextTracker.getAgentState(currentAgent.id);

            return {
                agentId: currentAgent.id,
                agentName: currentAgent.name,
                subtask,
                promptResult,
                events: finalState?.events ?? [],
                filesWritten: finalState?.filesWritten ?? [],
                success: true,
                retryCount,
                timedOut: false,
                subtaskDurationMs: subtaskDuration,
            };
        } catch (error) {
            const errorMessage = toErrorMessage(error);
            const isTimeoutError = error instanceof SubtaskTimeoutError;
            timedOut = isTimeoutError;
            lastError = errorMessage;
            retryCount = attempt + 1;

            this.logger.warn(
                {
                    subtaskId: subtask.id,
                    attempt: attempt + 1,
                    isTimeout: isTimeoutError,
                    error: errorMessage,
                },
                `Subtask attempt ${attempt + 1} failed: ${errorMessage}`,
            );

            // Check if we should retry
            const canRetry = attempt < retryConfig.maxRetries;
            const shouldRetryTimeout = isTimeoutError && retryConfig.retryOnTimeout;
            const shouldRetry = canRetry && (shouldRetryTimeout || !isTimeoutError);

            if (!shouldRetry) {
                // No more retries — mark as failed
                this.contextTracker.markFailed(currentAgent.id, errorMessage);

                const subtaskDuration = Date.now() - subtaskStartTime;
                const finalState = this.contextTracker.getAgentState(currentAgent.id);

                return this.buildFailedResult(
                    currentAgent, subtask, errorMessage, retryCount,
                    isTimeoutError, subtaskDuration,
                    finalState?.events, finalState?.filesWritten,
                );
            }

            // Destroy the current agent before retrying
            if (currentAgent.status !== AgentStatus.DESTROYED) {
                try {
                    await currentAgent.destroy();
                } catch {
                    // Agent may already be destroyed (e.g., from timeout handler)
                }
            }
        }
    }

    // Should never reach here, but safety fallback
    return this.buildFailedResult(
        currentAgent, subtask, lastError ?? "unknown", retryCount, timedOut, 0,
    );
}
```

### 7. Helper methods

#### `resolveRetryConfig()`

```typescript
/**
 * Resolves the effective retry configuration with defaults.
 */
private resolveRetryConfig(): Required<SubtaskRetryConfig> {
    const userConfig = this.config.retry;

    return {
        maxRetries: userConfig?.maxRetries ?? 1,
        includeErrorContext: userConfig?.includeErrorContext ?? true,
        retryDelayMs: userConfig?.retryDelayMs ?? 2000,
        retryOnTimeout: userConfig?.retryOnTimeout ?? true,
    };
}
```

#### `resolveTimeoutMs()`

```typescript
/**
 * Resolves the effective timeout in milliseconds for a subtask,
 * considering the task complexity and any complexity-specific overrides.
 *
 * @param complexity - The assessed task complexity.
 * @returns The timeout in milliseconds, or 0 if disabled.
 */
private resolveTimeoutMs(complexity: TaskComplexity): number {
    const timeoutConfig = this.config.timeout;

    if (!timeoutConfig) {
        // Default timeout: 5 minutes
        return 300_000;
    }

    if (timeoutConfig.subtaskTimeoutMs === 0 ||
        timeoutConfig.subtaskTimeoutMs === Infinity) {
        return 0; // Disabled
    }

    // Check for complexity-specific override
    if (timeoutConfig.complexityTimeouts) {
        const complexityKey = complexity.toLowerCase() as "simple" | "moderate" | "complex";
        const override = timeoutConfig.complexityTimeouts[complexityKey];
        if (override !== undefined) {
            return override;
        }
    }

    return timeoutConfig.subtaskTimeoutMs;
}
```

#### `buildRetryPrompt()`

```typescript
/**
 * Builds the prompt for a retry attempt, including error context
 * from the previous attempt.
 *
 * The prompt is structured to:
 * 1. State the original task clearly
 * 2. Describe what went wrong in the previous attempt
 * 3. Instruct the agent to avoid the same mistake
 * 4. Encourage a fresh approach if the same strategy failed
 *
 * @param subtask - The original subtask.
 * @param previousError - The error message from the previous attempt.
 * @param attemptNumber - The retry attempt number (1-based).
 * @returns The augmented prompt.
 */
private buildRetryPrompt(
    subtask: SubTask,
    previousError: string | null,
    attemptNumber: number,
): string {
    const errorContext = previousError
        ? `\n\nThe previous attempt (#${attemptNumber}) FAILED with the following error:\n${previousError}\n\nPlease avoid the same mistake. If the previous approach didn't work, try a different strategy.`
        : "";

    return `${subtask.prompt}${errorContext}`;
}
```

#### `spawnRetryAgent()`

```typescript
/**
 * Spawns a fresh agent for a retry attempt.
 *
 * Creates a new agent with the same configuration as the original,
 * registers it with the context tracker, and wires events.
 *
 * @param subtask - The subtask to retry.
 * @returns The newly spawned agent.
 */
private async spawnRetryAgent(subtask: SubTask): Promise<PoolManagedAgent> {
    const agentConfig: AgentConfig = {
        logOutput: this.config.logOutput,
        logLevel: this.config.logLevel,
        cwd: this.config.cwd,
        ...this.config.agentConfig,
        name: `${subtask.role}-retry`,
    };

    const agent = this.agentFactory(agentConfig);

    // Register with context tracker
    this.contextTracker.registerAgent(agent.id, agent.name, subtask);

    // Update subtask ↔ agent mappings (the old agent's mapping is stale)
    this.subtaskToAgent.set(subtask.id, agent.id);
    this.agentToSubtask.set(agent.id, subtask.id);

    // Wire agent events
    this.wireAgentEvents(agent, subtask);

    // Store in managed agents
    const entry = {
        agent,
        subtask,
        result: null as AgentExecutionResult | null,
    };
    this.managedAgents.set(agent.id, entry);

    this.emitPoolEvent(PoolEvent.AGENT_SPAWNED, {
        agentId: agent.id,
        agentName: agent.name,
        subtask,
    });

    // Wait for agent to be ready
    await agent.ready;

    return agent;
}
```

#### `buildFailedResult()`

```typescript
/**
 * Builds an AgentExecutionResult for a failed subtask.
 */
private buildFailedResult(
    agent: PoolManagedAgent,
    subtask: SubTask,
    error: string,
    retryCount: number,
    timedOut: boolean,
    subtaskDurationMs: number,
    events?: ContextEvent[],
    filesWritten?: string[],
): AgentExecutionResult {
    return {
        agentId: agent.id,
        agentName: agent.name,
        subtask,
        promptResult: {
            stopReason: "error" as StopReason,
            text: "",
            usage: null,
        },
        events: events ?? [],
        filesWritten: filesWritten ?? [],
        success: false,
        error,
        retryCount,
        timedOut,
        subtaskDurationMs,
    };
}
```

### 8. Refactorer `executeSubtasks()` pour utiliser la nouvelle méthode

Remplacer le bloc d'exécution individuelle dans `executeSubtasks()` par un appel à `executeSubtaskWithRetry()` :

```typescript
// Dans executeSubtasks(), dans le bloc des executionPromises
const executionPromises = readyIds.map(async (subtaskId) => {
    inProgress.add(subtaskId);
    remaining.delete(subtaskId);

    const entry = agents.get(subtaskId);
    if (!entry) {
        this.logger.error({ subtaskId }, "No agent found for subtask");
        failed.add(subtaskId);
        inProgress.delete(subtaskId);
        return;
    }

    const { agent, subtask } = entry;

    // Check if the agent initialized successfully
    const agentState = this.contextTracker.getAgentState(agent.id);
    if (agentState?.error) {
        this.logger.warn(
            { agentId: agent.id, error: agentState.error },
            "Skipping subtask — agent failed to initialize",
        );

        failed.add(subtaskId);
        inProgress.delete(subtaskId);

        results.push(this.buildFailedResult(
            agent, subtask, agentState.error, 0, false, 0,
            agentState.events, agentState.filesWritten,
        ));
        return;
    }

    this.logger.info(
        { agentId: agent.id, subtaskId, role: subtask.role },
        `Executing subtask: ${subtask.role}`,
    );

    // ← CHANGED: Use executeSubtaskWithRetry instead of direct prompt
    const executionResult = await this.executeSubtaskWithRetry(
        subtask, agent, analysis, agents,
    );

    results.push(executionResult);

    if (executionResult.success) {
        completed.add(subtaskId);
    } else {
        failed.add(subtaskId);
    }
    inProgress.delete(subtaskId);

    // Store in managed agents map
    const managedEntry = this.managedAgents.get(executionResult.agentId);
    if (managedEntry) {
        managedEntry.result = executionResult;
    }

    if (executionResult.success) {
        this.emitPoolEvent(PoolEvent.AGENT_COMPLETED, {
            agentId: executionResult.agentId,
            agentName: executionResult.agentName,
            result: executionResult,
        });
    } else {
        this.emitPoolEvent(PoolEvent.AGENT_ERROR, {
            agentId: executionResult.agentId,
            agentName: executionResult.agentName,
            error: executionResult.error ?? "unknown",
        });
    }
});

await Promise.allSettled(executionPromises);
```

### 9. Apply defaults in `AgentPool` constructor

In the constructor, resolve default config:

```typescript
this.config = {
    model: config.model ?? DEFAULT_MODEL,
    maxAgents: config.maxAgents ?? DEFAULT_MAX_AGENTS,
    maxRetries: config.maxRetries ?? 3,
    temperature: config.temperature ?? 0.2,
    timeout: config.timeout ?? { subtaskTimeoutMs: 300_000 },
    retry: config.retry ?? {
        maxRetries: 1,
        includeErrorContext: true,
        retryDelayMs: 2000,
        retryOnTimeout: true,
    },
    ...config,
};
```

**Note**: Be careful with the spread — `...config` at the end means user-provided values override defaults. The `timeout` and `retry` fields should use `config.timeout ?? defaultValue` before the spread to allow partial overrides. Review the existing pattern to be consistent.

### 10. Update `AgentPoolState` with retry/timeout info

Add retry and timeout statistics to the pool state:

```typescript
export interface AgentPoolState {
    // ... existing fields ...

    /** Number of subtask retries performed during current execution. */
    readonly retryCount: number;

    /** Number of subtask timeouts triggered during current execution. */
    readonly timeoutCount: number;
}
```

Track these counters in the pool class:

```typescript
private _retryCount = 0;
private _timeoutCount = 0;
```

Increment `_timeoutCount` in `executeWithTimeout` when a timeout fires, and `_retryCount` in `executeSubtaskWithRetry` when a retry is triggered. Reset both in the `finally` block of `execute()`.

### 11. Add retry/timeout info to the summary prompt

If retries or timeouts occurred, include them in the `CoordinationStats` passed to the summary (from evolution 06):

```typescript
export interface CoordinationStats {
    // ... existing fields ...

    /** Number of subtask retries performed. */
    readonly retryCount: number;

    /** Number of subtask timeouts triggered. */
    readonly timeoutCount: number;
}
```

And in the summary template:

```handlebars
{{#if coordination}}
## Inter-Agent Coordination
- **Deltas detected**: {{coordination.deltaCount}}
- **Sharing evaluations**: {{coordination.sharingEvaluationCount}}
- **Information shared**: {{coordination.sharingApprovedCount}} time(s)
- **User notifications**: {{coordination.notificationCount}}
{{#if (gt coordination.retryCount 0)}}- **Retries**: {{coordination.retryCount}} subtask(s) retried{{/if}}
{{#if (gt coordination.timeoutCount 0)}}- **Timeouts**: {{coordination.timeoutCount}} subtask(s) timed out{{/if}}
{{/if}}
```

---

## Timeout behavior details

### What happens when a timeout fires

1. The `setTimeout` callback fires
2. `contextTracker.markTimedOut()` is called — records the timeout in agent state
3. `AGENT_TIMEOUT` pool event is emitted
4. `agent.destroy()` is called — kills the ACP process, cleans up resources
5. The `timeoutPromise` rejects with a `SubtaskTimeoutError`
6. `Promise.race` resolves with the rejection
7. The `clearTimeout` in `finally` is a no-op (timer already fired)
8. The error is caught by `executeSubtaskWithRetry()`
9. Retry logic decides whether to retry or give up

### What happens to in-flight tool calls

When `agent.destroy()` is called:
- The ACP process is killed (`proc.kill()`)
- The NDJSON streams are closed
- Any in-flight tool calls are abandoned
- The agent's status transitions to `DESTROYED`
- Any pending context injections are discarded

This is a hard stop — there is no graceful shutdown of individual tool calls. This is intentional: a timed-out agent is by definition stuck, and waiting for graceful completion would defeat the purpose of the timeout.

### Timeout does NOT apply to the overall execution

The timeout is per-subtask, not per-execution. If the pool has 3 subtasks with a 5-minute timeout each, the total execution can take up to 15 minutes (plus overhead). An overall execution timeout could be added in a future evolution if needed.

---

## Retry behavior details

### What changes between attempts

| Aspect | First attempt | Retry attempt |
|--------|---------------|---------------|
| Agent instance | Original agent from `spawnAgents()` | Fresh agent from `spawnRetryAgent()` |
| Agent name | `subtask.role` (e.g., "api-developer") | `subtask.role + "-retry"` (e.g., "api-developer-retry") |
| Prompt | Original `subtask.prompt` | Original prompt + error context |
| Context tracker | Original registration | New registration (fresh event history) |
| Subtask ↔ Agent mapping | Original mapping | Updated to point to new agent |
| Shared context history | From previous sharing | Not carried over (fresh agent) |

### What is preserved between attempts

- The subtask definition itself (id, prompt, role, dependencies, priority)
- The pool's sharing history (evolution 02) — deduplication still applies
- The dependency graph — blocking deps still apply to the retried subtask
- Other agents' state — they continue unaffected

### What is NOT preserved

- The failed agent's conversation history (ACP session is destroyed)
- Tool call outputs from the failed attempt (files written MAY persist on disk)
- In-flight context injections that were queued but not yet drained

### Retry prompt format

When `includeErrorContext` is true, the retry prompt looks like:

```
<original subtask prompt>

The previous attempt (#1) FAILED with the following error:
Subtask "api-impl" (agent: api-developer) timed out after 305000ms (limit: 300000ms)

Please avoid the same mistake. If the previous approach didn't work, try a different strategy.
```

This gives the fresh agent enough context to avoid repeating the error while not constraining it to a specific fix.

---

## Configuration examples

### Default configuration (implicit)

```typescript
const pool = new AgentPool({
    openRouterApiKey: "...",
    // timeout defaults to { subtaskTimeoutMs: 300_000 } (5 min)
    // retry defaults to { maxRetries: 1, includeErrorContext: true, retryDelayMs: 2000, retryOnTimeout: true }
});
```

### Aggressive timeout, no retry

```typescript
const pool = new AgentPool({
    openRouterApiKey: "...",
    timeout: { subtaskTimeoutMs: 120_000 }, // 2 minutes
    retry: { maxRetries: 0, includeErrorContext: false, retryDelayMs: 0, retryOnTimeout: false },
});
```

### Generous timeout with complexity scaling

```typescript
const pool = new AgentPool({
    openRouterApiKey: "...",
    timeout: {
        subtaskTimeoutMs: 300_000, // 5 min default
        complexityTimeouts: {
            simple: 120_000,    // 2 min for simple
            moderate: 300_000,  // 5 min for moderate
            complex: 600_000,   // 10 min for complex
        },
    },
    retry: {
        maxRetries: 2,
        includeErrorContext: true,
        retryDelayMs: 5000,
        retryOnTimeout: true,
    },
});
```

### Disable timeout entirely

```typescript
const pool = new AgentPool({
    openRouterApiKey: "...",
    timeout: { subtaskTimeoutMs: 0 }, // or Infinity
});
```

---

## Tests à implémenter

### Tests unitaires pour le timeout

#### Test 1 : `executeWithTimeout` completes normally within timeout

- Setup : mock `agent.prompt()` to resolve after 100ms
- Call `executeWithTimeout(agent, "prompt", 5000, "task-1")`
- Assert : returns the prompt result
- Assert : `AGENT_TIMEOUT` event was NOT emitted
- Assert : the timeout timer was cleared (no pending timers)

#### Test 2 : `executeWithTimeout` throws SubtaskTimeoutError on timeout

- Setup : mock `agent.prompt()` to never resolve (e.g., `new Promise(() => {})`)
- Call `executeWithTimeout(agent, "prompt", 100, "task-1")` (100ms timeout)
- Assert : throws `SubtaskTimeoutError` after ~100ms
- Assert : `error.isTimeout` is `true`
- Assert : `error.timeoutMs` is 100
- Assert : `agent.destroy()` was called
- Assert : `AGENT_TIMEOUT` event was emitted with correct payload
- Assert : `contextTracker.markTimedOut()` was called

#### Test 3 : `executeWithTimeout` with timeout 0 disables timeout

- Setup : mock `agent.prompt()` to resolve after 500ms
- Call `executeWithTimeout(agent, "prompt", 0, "task-1")`
- Assert : returns normally after 500ms (no timeout applied)

#### Test 4 : `executeWithTimeout` with timeout Infinity disables timeout

- Same as Test 3 but with `Infinity`

#### Test 5 : Timeout timer is cleared on normal completion

- Setup : mock `agent.prompt()` to resolve immediately
- Call `executeWithTimeout(agent, "prompt", 60000, "task-1")` (60s timeout)
- Assert : returns immediately
- Assert : no pending timer (use `jest.useFakeTimers()` or equivalent to verify)

### Tests unitaires pour le retry

#### Test 6 : `executeSubtaskWithRetry` succeeds on first attempt (no retry needed)

- Setup : mock agent to succeed on prompt
- Call `executeSubtaskWithRetry(subtask, agent, analysis, agents)`
- Assert : result `success` is `true`
- Assert : result `retryCount` is 0
- Assert : `AGENT_RETRY` event was NOT emitted

#### Test 7 : `executeSubtaskWithRetry` retries on error and succeeds

- Setup : first `agent.prompt()` rejects, `spawnRetryAgent()` returns new agent, new agent succeeds
- Config : `maxRetries: 1`
- Assert : result `success` is `true`
- Assert : result `retryCount` is 1
- Assert : `AGENT_RETRY` event was emitted once
- Assert : `AGENT_ERROR` event was NOT emitted (retry succeeded)

#### Test 8 : `executeSubtaskWithRetry` exhausts retries and fails

- Setup : all agent prompts reject
- Config : `maxRetries: 2`
- Assert : result `success` is `false`
- Assert : result `retryCount` is 2 (or 3 if counting attempts minus one)
- Assert : `AGENT_RETRY` event was emitted twice
- Assert : result `error` is the last error message

#### Test 9 : `executeSubtaskWithRetry` retries on timeout when configured

- Setup : `agent.prompt()` times out (never resolves), `retryOnTimeout: true`
- Config : `maxRetries: 1`, `subtaskTimeoutMs: 100`
- Assert : result `retryCount` is 1
- Assert : `AGENT_TIMEOUT` event was emitted
- Assert : `AGENT_RETRY` event was emitted

#### Test 10 : `executeSubtaskWithRetry` does NOT retry on timeout when `retryOnTimeout: false`

- Setup : `agent.prompt()` times out, `retryOnTimeout: false`
- Config : `maxRetries: 1`, `subtaskTimeoutMs: 100`
- Assert : result `success` is `false`
- Assert : result `retryCount` is 0 (no retry attempted)
- Assert : result `timedOut` is `true`
- Assert : `AGENT_RETRY` event was NOT emitted

#### Test 11 : `executeSubtaskWithRetry` does not retry when `maxRetries: 0`

- Setup : `agent.prompt()` rejects
- Config : `maxRetries: 0`
- Assert : result `success` is `false`
- Assert : result `retryCount` is 0
- Assert : `AGENT_RETRY` event was NOT emitted

#### Test 12 : Retry prompt includes error context when `includeErrorContext: true`

- Setup : first attempt fails with "ENOENT: file not found"
- Capture the prompt passed to the retry agent
- Assert : retry prompt contains the original `subtask.prompt`
- Assert : retry prompt contains "ENOENT: file not found"
- Assert : retry prompt contains "avoid the same mistake"

#### Test 13 : Retry prompt is unmodified when `includeErrorContext: false`

- Config : `includeErrorContext: false`
- Capture the prompt passed to the retry agent
- Assert : retry prompt is exactly `subtask.prompt` (no error context appended)

#### Test 14 : `spawnRetryAgent` creates a fresh agent with correct config

- Mock the `agentFactory`
- Call `spawnRetryAgent(subtask)`
- Assert : factory was called with the correct config (cwd, logOutput, etc.)
- Assert : agent name ends with `-retry`
- Assert : agent was registered in context tracker
- Assert : subtask-agent mappings were updated

#### Test 15 : Retry delay is respected

- Config : `retryDelayMs: 500`
- Setup : first attempt fails, retry succeeds
- Measure the time between first failure and retry start
- Assert : at least 500ms elapsed

### Tests pour `resolveTimeoutMs()`

#### Test 16 : Default timeout is 300_000 when no config

- Assert : `resolveTimeoutMs(TaskComplexity.MODERATE)` returns 300_000 when `this.config.timeout` is undefined

#### Test 17 : Complexity-specific overrides are applied

- Config : `complexityTimeouts: { simple: 60000, complex: 600000 }`
- Assert : `resolveTimeoutMs(TaskComplexity.SIMPLE)` returns 60000
- Assert : `resolveTimeoutMs(TaskComplexity.COMPLEX)` returns 600000
- Assert : `resolveTimeoutMs(TaskComplexity.MODERATE)` returns `subtaskTimeoutMs` (default)

#### Test 18 : Timeout disabled when `subtaskTimeoutMs: 0`

- Config : `subtaskTimeoutMs: 0`
- Assert : `resolveTimeoutMs(any)` returns 0

### Tests d'intégration

#### Test 19 : Full execution with timeout and successful retry

- Setup : mock agent that times out on first attempt, succeeds on retry
- Config : `subtaskTimeoutMs: 100`, `maxRetries: 1`
- Execute a single-agent task
- Assert : `AgentPoolResult` shows success
- Assert : `result.agents[0].retryCount` is 1
- Assert : `result.agents[0].timedOut` is false (the final attempt succeeded)
- Assert : pool state shows `retryCount: 1` and `timeoutCount: 1`

#### Test 20 : Full execution with timeout and failed retry

- Setup : mock agent that always times out
- Config : `subtaskTimeoutMs: 100`, `maxRetries: 1`
- Execute a single-agent task
- Assert : `AgentPoolResult` shows the agent failed
- Assert : `result.agents[0].retryCount` is 1
- Assert : `result.agents[0].timedOut` is true
- Assert : `result.agents[0].error` contains "timed out"

#### Test 21 : Multi-agent execution where one agent times out and retries

- Setup : 2 agents, agent-A succeeds, agent-B times out and succeeds on retry
- Config : `subtaskTimeoutMs: 100`, `maxRetries: 1`
- Assert : both agents ultimately succeed
- Assert : agent-B's result has `retryCount: 1`
- Assert : agent-A's result has `retryCount: 0`
- Assert : sharing between agents still works after retry

#### Test 22 : Retry agent receives shared context from previously completed agents

- Setup : 3 agents with blocking deps A → B → C. Agent B fails and retries.
- Assert : the retry agent for B receives shared context from A's completion
- Assert : the context tracker has the updated agent mapping for the retry agent

#### Test 23 : `AgentExecutionResult` includes `retryCount`, `timedOut`, and `subtaskDurationMs`

- Execute a task (single-agent, no timeouts, no retries)
- Assert : `result.agents[0].retryCount` is 0
- Assert : `result.agents[0].timedOut` is false
- Assert : `result.agents[0].subtaskDurationMs` is > 0

---

## Critères de validation

- [ ] Le type `SubtaskTimeoutConfig` existe dans `agent-pool.types.ts`
- [ ] Le type `SubtaskRetryConfig` existe dans `agent-pool.types.ts`
- [ ] `AgentPoolConfig` accepte les champs `timeout` et `retry`
- [ ] `AgentExecutionResult` inclut `retryCount`, `timedOut`, et `subtaskDurationMs`
- [ ] `PoolEvent.AGENT_TIMEOUT` et `PoolEvent.AGENT_RETRY` existent dans l'enum et dans `PoolEventMap`
- [ ] `ContextTracker.markTimedOut()` existe et enregistre le timeout dans l'état de l'agent
- [ ] `SubtaskTimeoutError` existe avec les champs `isTimeout`, `timeoutMs`, `elapsedMs`
- [ ] `executeWithTimeout()` wrappe `agent.prompt()` avec un timeout configurable
- [ ] `executeWithTimeout()` détruit l'agent quand le timeout fire
- [ ] `executeWithTimeout()` clear le timer quand le prompt termine normalement
- [ ] `executeWithTimeout()` ne fait rien quand le timeout est 0 ou Infinity
- [ ] `executeSubtaskWithRetry()` retrie les subtasks en cas d'erreur ou de timeout
- [ ] `executeSubtaskWithRetry()` respecte `maxRetries`, `retryDelayMs`, `retryOnTimeout`
- [ ] `executeSubtaskWithRetry()` inclut le contexte d'erreur dans le prompt de retry quand `includeErrorContext: true`
- [ ] `spawnRetryAgent()` crée un agent frais avec le bon nom, la bonne config, et les bons mappings
- [ ] `resolveTimeoutMs()` supporte les overrides par complexité
- [ ] Les defaults sont raisonnables : 5min timeout, 1 retry, 2s delay, error context on, retry on timeout
- [ ] Le timeout est par-subtask, pas par-exécution globale
- [ ] Les counters `_retryCount` et `_timeoutCount` sont trackés et exposés dans `AgentPoolState`
- [ ] Les retries/timeouts sont inclus dans les `CoordinationStats` du summary
- [ ] L'exécution multi-agent n'est pas impactée quand aucun timeout/retry ne se produit
- [ ] Les agents retry reçoivent le contexte partagé des agents déjà terminés
- [ ] Les subtask-agent mappings sont mis à jour après un retry
- [ ] Tous les tests existants passent toujours
- [ ] Les nouveaux tests couvrent timeout, retry, configuration, edge cases

---

## Points d'attention

1. **Le timeout est appliqué à `agent.prompt()`**, pas à l'initialisation de l'agent. L'initialisation (spawn process, ACP handshake, session creation) a son propre timeout implicite via le protocole ACP. Si l'init échoue, l'agent est marqué `error` et le subtask est skippé (ou retried si configuré).

2. **`agent.destroy()` dans le timeout handler est fire-and-forget** — on ne bloque pas le rejet du timeout promise en attendant que le destroy termine. Le destroy peut prendre du temps si le process ACP ne répond pas au kill signal. La promise de timeout rejette immédiatement après avoir initié le destroy.

3. **Race condition potentielle** : si `agent.prompt()` résout au même instant que le timeout fire, les deux branches de `Promise.race` sont en compétition. Le `clearTimeout` dans le `finally` garantit que si le prompt gagne, le timeout est annulé. Si le timeout gagne, le prompt result est ignoré (mais le prompt n'est pas annulé côté agent — c'est le `destroy()` qui s'en charge).

4. **`maxRetries` de `AgentPoolConfig.retry` est différent de `AgentPoolConfig.maxRetries`** — l'ancien `maxRetries` concerne les retries de l'`OpenRouterClient` (appels API LLM). Le nouveau `retry.maxRetries` concerne les retries de subtask (re-spawn d'agent + re-prompt). Nommage potentiellement confus — documenter clairement la distinction.

5. **Le retry agent a un nom différent** (`role-retry`) — ceci est important pour le logging et les events, mais ne change pas la logique. Les mappings subtask-agent sont mis à jour pour pointer vers le nouvel agent.

6. **Les fichiers écrits par l'agent qui a échoué persistent sur disque** — le retry agent peut les voir et les lire. C'est une feature, pas un bug : l'agent de retry peut continuer là où le précédent s'est arrêté si les fichiers partiellement écrits sont utilisables. Cependant, les fichiers corrompus ou incomplets peuvent aussi causer des problèmes. Le message d'erreur dans le retry prompt aide l'agent à comprendre le contexte.

7. **La notification engine (évolution 06) verra les events de timeout et retry** — le `AGENT_TIMEOUT` et `AGENT_RETRY` events sont émis au niveau pool. Si les notifications sont activées, l'utilisateur sera informé des timeouts et retries via le mécanisme de notification existant. Pas besoin de traitement spécial — le `contextTracker.markTimedOut()` émet les bons events.

8. **Le `retryCount` dans `AgentExecutionResult`** compte le nombre de retries effectués, pas le nombre total d'attempts. Donc `retryCount: 0` = succès au premier essai, `retryCount: 1` = succès au deuxième essai, etc. C'est la convention la plus intuitive.

9. **L'`informationBroker` est créé une fois par exécution** — les retry agents utilisent le même broker, donc la déduplication de l'évolution 02 s'applique correctement. Si l'agent original a déjà partagé de l'info avant de timeout, le retry agent ne recevra pas les mêmes infos en double.

10. **L'overflow de context injection (évolution 08)** pourrait être impacté si un retry agent reçoit beaucoup de contexte partagé accumulé pendant le timeout. Les guards d'overflow (`MAX_PENDING_INJECTIONS`, `MAX_PENDING_CHARS`) protègent contre ce cas — les injections LOW seront droppées si la queue est saturée.

11. **Les `complexityTimeouts` utilisent la complexité globale de la tâche**, pas une complexité par subtask. Si le planner juge la tâche `complex`, TOUS les subtasks reçoivent le timeout `complex`, même si certains sont triviaux. Une future amélioration pourrait ajouter une complexité par subtask dans `TaskAnalysis`, mais c'est hors scope de cette évolution.

12. **Le `subtaskDurationMs` dans `AgentExecutionResult` mesure la durée du DERNIER attempt seulement**, pas la durée cumulative incluant les retries et les delays. C'est voulu : la durée cumulative peut être calculée à partir de `retryCount * (subtaskDurationMs + retryDelayMs)` si nécessaire. La durée du dernier attempt est plus utile pour le debugging (« combien de temps l'agent a-t-il travaillé ? »).

13. **Le `buildRetryPrompt()` est intentionnellement simple** — il append le contexte d'erreur à la fin du prompt original. Il n'essaie PAS de modifier le prompt original (ex: « cette fois-ci, utilise une approche différente »). Le LLM agent est assez intelligent pour comprendre l'erreur et adapter sa stratégie. Des instructions trop prescriptives dans le retry prompt pourraient être contre-productives.

14. **Les tests avec des timeouts réels** (`setTimeout` de 100ms) peuvent être flaky en CI. Utiliser `jest.useFakeTimers()` ou l'équivalent Bun pour contrôler le temps dans les tests. Pour les tests d'intégration qui doivent utiliser des vrais timeouts, utiliser des marges généreuses (asserter `> 80ms` au lieu de `=== 100ms`).