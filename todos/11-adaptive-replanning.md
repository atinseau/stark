# Évolution 11 — Re-planification adaptative en cours d'exécution

## Priorité : 🟡 P2

## Dépendances : Évolution 10 (Subtask timeout et retry)

## Acquis des évolutions précédentes

- **Évolution 01** : L'`InformationBroker` reçoit les mappings `subtaskToAgent` / `agentToSubtask` via son constructeur. `isAgentForSubtask()` fonctionne. `findDependency()` traduit correctement entre agent IDs et subtask IDs.
- **Évolution 02** : L'`InformationBroker` maintient un `SharingHistory` indexé par agent cible. Le prompt de partage inclut les partages précédents (`previouslyShared`). `recordSharing()` est appelé après chaque injection réussie.
- **Évolution 03** : Le `ProjectScanner` scanne le répertoire de travail et produit un `ProjectContext`. Le planner reçoit le contexte projet (arborescence, langages, frameworks, configs résumés).
- **Évolution 04** : Tous les prompts LLM contiennent des exemples few-shot contrastifs.
- **Évolution 05** : Le rôle `ConversationRole.SHARING_ANALYZER` existe. Le system prompt est dédié au partage. L'`InformationBroker` utilise `SHARING_ANALYZER`.
- **Évolution 06** : Le notification prompt est nettoyé. Le summary prompt inclut les `CoordinationStats`. `durationMs` est correctement calculé.
- **Évolution 07** : Le preview dans les deltas `PROMPT_COMPLETE` est augmenté à 2000 chars. Le champ `promptResultSummary` existe dans `ContextDelta`. L'`InformationBroker` dispose de `evaluateWithFullResult()` pour les blocking deps.
- **Évolution 08** : L'injection de contexte est structurée et priorisée via `StructuredContextInjection`. Les injections `CRITICAL` (blocking deps) apparaissent en premier. L'`AgentContextManager` gère l'overflow en droppant les LOW/NORMAL en premier.
- **Évolution 09** : Le seuil de significance dans l'`InformationBroker` est dynamique selon la phase d'exécution, le type de delta, et les dépendances. Le `DynamicSignificanceCalculator` ajuste les seuils en temps réel.
- **Évolution 10** : Le `SubtaskExecutor` gère les timeouts par subtask (`subtaskTimeoutMs`) et les retries individuels (`maxSubtaskRetries`). Les agents échoués sont respawnés avec le contexte d'erreur du précédent. Les retries sont trackés dans `AgentExecutionResult.retryCount`.

---

## Contexte du problème

Le plan d'exécution produit par le `TaskPlanner` en Phase 1 est actuellement **immuable**. Une fois que le planner a décidé de la stratégie (single/multi), des subtasks, et des dépendances, rien ne peut changer ce plan en cours d'exécution.

### Scénarios où le plan initial échoue

#### 1. Échec en cascade

L'agent `api-developer` échoue (même après les retries de l'évolution 10). Les agents `test-writer` et `docs-writer` qui en dépendent sont bloqués ou travaillent avec des informations incomplètes. Le plan ne peut pas être adapté pour :
- Fusionner les subtasks restants en un seul agent
- Redistribuer le travail de l'agent échoué
- Simplifier le plan en supprimant les subtasks dépendants devenus impossibles

#### 2. Découverte d'information en cours d'exécution

L'agent `api-developer` découvre que le framework choisi ne supporte pas une feature requise et doit pivoter vers un autre framework. Les subtasks des autres agents qui référencent le framework initial sont désormais incorrects.

#### 3. Surcharge de complexité

Le planner a sous-estimé la complexité et créé 2 subtasks, mais en réalité 4 seraient plus efficaces. Ou inversement, il a créé 4 subtasks mais 2 suffisaient — les agents se marchent sur les pieds.

#### 4. Deadlock résolu mais suboptimal

Le système de deadlock detection dans `executeSubtasks()` marque les subtasks restants comme `failed` avec le message `"Deadlocked: blocking dependencies could not be satisfied"`. C'est un aveu d'échec brutal — un replanning pourrait sauver l'exécution.

### Conséquence actuelle

Sans replanning, les échecs sont définitifs. Le seul recours est de relancer toute l'exécution depuis le début, perdant tout le travail déjà accompli.

---

## Fichiers impactés

| Fichier | Action |
|---------|--------|
| `src/classes/agent-pool/task-planner.ts` | Ajouter la méthode `replan()` pour le replanning contextuel |
| `src/classes/agent-pool/agent-pool.ts` | Intégrer le replanning dans le cycle d'exécution |
| `src/prompts/planning.ts` | Ajouter le template de replanning |
| `src/types/agent-pool.types.ts` | Ajouter les types `ReplanRequest`, `ReplanDecision` |
| `src/enums/pool-event.enum.ts` | Ajouter `REPLAN_START`, `REPLAN_COMPLETE` |
| `src/classes/agent-pool/tests/` | Tests unitaires et d'intégration |

---

## Spécification détaillée des changements

### 1. Nouveaux types dans `agent-pool.types.ts`

```typescript
/**
 * Trigger conditions that can initiate a replanning evaluation.
 */
export enum ReplanTrigger {
    /** A subtask failed after exhausting all retries. */
    SUBTASK_FAILURE = "subtask_failure",

    /** A deadlock was detected in the dependency graph. */
    DEADLOCK = "deadlock",

    /** An agent reported a fundamental blocker (framework mismatch, missing capability). */
    AGENT_BLOCKER = "agent_blocker",

    /** Multiple subtasks failed, suggesting systemic issues. */
    CASCADING_FAILURES = "cascading_failures",

    /** Manual replan requested by the user. */
    USER_REQUESTED = "user_requested",
}

/**
 * Request for replanning, containing the context needed for the planner
 * to make an informed decision about how to proceed.
 */
export interface ReplanRequest {
    /** What triggered the replan evaluation. */
    readonly trigger: ReplanTrigger;

    /** The original task description. */
    readonly originalTask: string;

    /** The original plan that was being executed. */
    readonly originalAnalysis: TaskAnalysis;

    /** Current state of all agents (completed, failed, in-progress). */
    readonly agentStates: ReadonlyArray<{
        readonly subtaskId: string;
        readonly agentName: string;
        readonly role: string;
        readonly completed: boolean;
        readonly failed: boolean;
        readonly error: string | null;
        /** Summary of what was accomplished before failure/completion. */
        readonly accomplishedSummary: string;
        /** Files written by this agent. */
        readonly filesWritten: readonly string[];
    }>;

    /** Subtask IDs that are blocked and cannot proceed. */
    readonly blockedSubtaskIds: readonly string[];

    /** Human-readable description of the problem that triggered replanning. */
    readonly problemDescription: string;
}

/**
 * The planner's decision on how to proceed after evaluating the replan request.
 */
export interface ReplanDecision {
    /** Whether the plan should be modified. */
    readonly shouldReplan: boolean;

    /**
     * The chosen strategy for the replan.
     * - `"continue"` — Keep going with the current plan despite issues.
     * - `"modify"` — Adjust the plan: add, remove, or change subtasks.
     * - `"restart"` — Abandon current progress and restart from scratch.
     * - `"abort"` — Stop execution entirely, the task cannot be completed.
     */
    readonly action: "continue" | "modify" | "restart" | "abort";

    /** Human-readable reasoning for the decision. */
    readonly reasoning: string;

    /**
     * If action is "modify": the new subtasks to execute.
     * These replace the remaining (non-completed) subtasks in the original plan.
     * Already-completed subtasks are NOT re-executed.
     */
    readonly newSubtasks: SubTask[];

    /**
     * If action is "modify": updated dependency graph for the new subtasks.
     */
    readonly newDependencies: TaskDependency[];

    /**
     * Context that should be injected into new agents, summarizing
     * what was already accomplished by the completed subtasks.
     */
    readonly completedWorkSummary: string;
}
```

### 2. Nouveau prompt de replanning dans `planning.ts`

Ajouter un nouveau template `REPLAN_PROMPT_SOURCE` :

```handlebars
The current execution plan has encountered a problem and needs your evaluation.

## Original Task
<task>
{{originalTask}}
</task>

## Original Plan
- **Strategy**: {{originalAnalysis.strategy}}
- **Complexity**: {{originalAnalysis.complexity}}
- **Subtasks**: {{originalAnalysis.subtasks.length}}
- **Reasoning**: {{originalAnalysis.reasoning}}

### Original Subtasks
{{#each originalAnalysis.subtasks}}
- **{{this.id}}** ({{this.role}}): {{truncate this.prompt 150}}
  - Dependencies: {{#if this.dependencies.length}}{{#each this.dependencies}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}{{else}}none{{/if}}
{{/each}}

## Current Execution State
{{#each agentStates}}
### {{this.agentName}} ({{this.role}}) — subtask: {{this.subtaskId}}
- **Status**: {{#if this.completed}}✅ Completed{{else if this.failed}}❌ Failed: {{this.error}}{{else}}⚙️ In progress{{/if}}
{{#if this.accomplishedSummary}}- **Accomplished**: {{this.accomplishedSummary}}{{/if}}
{{#if this.filesWritten.length}}- **Files written**: {{#each this.filesWritten}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}{{/if}}

{{/each}}

## Problem
**Trigger**: {{trigger}}
**Blocked subtasks**: {{#each blockedSubtaskIds}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}

{{problemDescription}}

## Your Decision

Evaluate the situation and decide how to proceed. Your options:

1. **continue** — The issue is minor. Keep the current plan and let remaining subtasks proceed.
2. **modify** — Adjust the plan. Provide NEW subtasks that replace the remaining (non-completed) work. Already-completed subtasks are preserved — do NOT re-do them. New subtask prompts must reference what was already accomplished.
3. **restart** — The situation is too broken to salvage. Abandon all progress and start fresh.
4. **abort** — The task fundamentally cannot be completed (e.g., impossible requirements).

## Important Rules
- Prefer **continue** for minor, recoverable issues.
- Prefer **modify** when specific subtasks failed but other work can be preserved.
- Use **restart** only if the majority of work is invalidated.
- Use **abort** only if the task is genuinely impossible.
- When modifying: new subtask prompts MUST reference completed work. Example: "The API has already been implemented in src/routes/users.ts. Write tests for it."
- When modifying: do NOT change subtask IDs of already-completed subtasks.
- Include `completedWorkSummary` that describes what was already done — this will be injected into new agents.

## JSON Output
{
  "shouldReplan": true | false,
  "action": "continue" | "modify" | "restart" | "abort",
  "reasoning": "<why this decision>",
  "newSubtasks": [
    { "id": "...", "prompt": "...", "role": "...", "dependencies": [], "priority": 1 }
  ],
  "newDependencies": [
    { "from": "...", "to": "...", "type": "blocking" | "informational" }
  ],
  "completedWorkSummary": "<summary of what completed agents accomplished, for injection into new agents>"
}

For "continue" and "abort": newSubtasks and newDependencies should be empty arrays.
```

Export the new template :

```typescript
export const replanPrompt = Handlebars.compile(REPLAN_PROMPT_SOURCE, {
    noEscape: true,
});
```

Add to `src/prompts/index.ts` :

```typescript
export { planningSystemPrompt, taskAnalysisPrompt, replanPrompt } from "./planning.ts";
```

### 3. Ajouter la méthode `replan()` dans `TaskPlanner`

```typescript
/**
 * Evaluates whether the current plan should be modified given the
 * current execution state and a triggering problem.
 *
 * Uses the planner LLM conversation to analyze the situation and
 * decide on the best course of action. The planner has full context
 * about what was originally planned, what has been accomplished,
 * and what went wrong.
 *
 * @param request - The replan request with full execution context.
 * @returns A decision on how to proceed.
 */
async replan(request: ReplanRequest): Promise<ReplanDecision> {
    // Reset the planner conversation for a fresh analysis
    this.conversations.reset(ConversationRole.PLANNER);

    const prompt = replanPrompt({
        originalTask: this.conversations.client.sanitize(request.originalTask),
        originalAnalysis: request.originalAnalysis,
        agentStates: request.agentStates,
        trigger: request.trigger,
        blockedSubtaskIds: request.blockedSubtaskIds,
        problemDescription: request.problemDescription,
    });

    this.logger.info(
        {
            trigger: request.trigger,
            completedCount: request.agentStates.filter(a => a.completed).length,
            failedCount: request.agentStates.filter(a => a.failed).length,
            blockedCount: request.blockedSubtaskIds.length,
        },
        `Evaluating replan (trigger: ${request.trigger})`,
    );

    try {
        const decision = await this.conversations.sendJson(
            ConversationRole.PLANNER,
            prompt,
            validateReplanDecision,
        );

        // Semantic validation for "modify" decisions
        if (decision.action === "modify") {
            const errors = this.validateModifyDecision(decision, request);
            if (errors.length > 0) {
                this.logger.warn(
                    { errors },
                    "Replan modify decision has semantic errors — falling back to continue",
                );
                return {
                    shouldReplan: false,
                    action: "continue",
                    reasoning: `Replan decision was invalid (${errors.join("; ")}). Continuing with original plan.`,
                    newSubtasks: [],
                    newDependencies: [],
                    completedWorkSummary: "",
                };
            }
        }

        this.logger.info(
            {
                action: decision.action,
                shouldReplan: decision.shouldReplan,
                newSubtaskCount: decision.newSubtasks.length,
            },
            `Replan decision: ${decision.action} — ${decision.reasoning.slice(0, 100)}`,
        );

        return decision;
    } catch (error) {
        this.logger.warn(
            { error: toErrorMessage(error) },
            "Replan evaluation failed — defaulting to continue",
        );

        return {
            shouldReplan: false,
            action: "continue",
            reasoning: `Replan evaluation failed: ${toErrorMessage(error)}. Continuing with original plan.`,
            newSubtasks: [],
            newDependencies: [],
            completedWorkSummary: "",
        };
    }
}

/**
 * Validates that a "modify" decision doesn't re-create already-completed subtasks
 * or reference non-existent subtask IDs in dependencies.
 */
private validateModifyDecision(
    decision: ReplanDecision,
    request: ReplanRequest,
): string[] {
    const errors: string[] = [];

    const completedIds = new Set(
        request.agentStates
            .filter(a => a.completed && !a.failed)
            .map(a => a.subtaskId)
    );

    // Check that no new subtask reuses a completed subtask ID
    for (const subtask of decision.newSubtasks) {
        if (completedIds.has(subtask.id)) {
            errors.push(`New subtask "${subtask.id}" reuses a completed subtask ID`);
        }
    }

    // Check dependency validity
    const allIds = new Set([
        ...completedIds,
        ...decision.newSubtasks.map(s => s.id),
    ]);

    for (const dep of decision.newDependencies) {
        if (!allIds.has(dep.from)) {
            errors.push(`Dependency references unknown subtask "${dep.from}"`);
        }
        if (!allIds.has(dep.to)) {
            errors.push(`Dependency references unknown subtask "${dep.to}"`);
        }
        if (dep.from === dep.to) {
            errors.push(`Subtask "${dep.from}" depends on itself`);
        }
    }

    // Check that new subtasks don't have empty prompts
    for (const subtask of decision.newSubtasks) {
        if (!subtask.prompt || subtask.prompt.trim().length === 0) {
            errors.push(`Subtask "${subtask.id}" has an empty prompt`);
        }
    }

    return errors;
}
```

### 4. Validator pour `ReplanDecision`

Ajouter dans `task-planner.ts` :

```typescript
/**
 * Validates that a raw parsed JSON value conforms to the ReplanDecision schema.
 */
function validateReplanDecision(data: unknown): ReplanDecision | null {
    if (data == null || typeof data !== "object") return null;

    const obj = data as Record<string, unknown>;

    // shouldReplan
    if (typeof obj.shouldReplan !== "boolean") return null;

    // action
    const validActions = ["continue", "modify", "restart", "abort"];
    if (typeof obj.action !== "string" || !validActions.includes(obj.action)) return null;

    // reasoning
    if (typeof obj.reasoning !== "string" || obj.reasoning.length === 0) return null;

    // newSubtasks
    const newSubtasks: SubTask[] = [];
    if (Array.isArray(obj.newSubtasks)) {
        for (const raw of obj.newSubtasks) {
            const subtask = validateSubTask(raw);
            if (!subtask) return null;
            newSubtasks.push(subtask);
        }
    }

    // newDependencies
    const newDependencies: TaskDependency[] = [];
    if (Array.isArray(obj.newDependencies)) {
        for (const raw of obj.newDependencies) {
            const dep = validateDependency(raw);
            if (!dep) return null;
            newDependencies.push(dep);
        }
    }

    // completedWorkSummary
    const completedWorkSummary = typeof obj.completedWorkSummary === "string"
        ? obj.completedWorkSummary
        : "";

    // Consistency checks
    if (obj.action === "modify" && newSubtasks.length === 0) return null;
    if ((obj.action === "continue" || obj.action === "abort") && newSubtasks.length > 0) return null;

    return {
        shouldReplan: obj.shouldReplan,
        action: obj.action as ReplanDecision["action"],
        reasoning: obj.reasoning,
        newSubtasks,
        newDependencies,
        completedWorkSummary,
    };
}
```

### 5. Ajouter les pool events

Dans `src/enums/pool-event.enum.ts` :

```typescript
/** A replanning evaluation has started. */
REPLAN_START = "pool:replan-start",

/** A replanning evaluation has completed with a decision. */
REPLAN_COMPLETE = "pool:replan-complete",
```

Add the corresponding event interfaces in `agent-pool.types.ts` :

```typescript
interface ReplanStartEvent extends BasePoolEvent {
    readonly trigger: ReplanTrigger;
    readonly problemDescription: string;
}

interface ReplanCompleteEvent extends BasePoolEvent {
    readonly decision: ReplanDecision;
}
```

Update `PoolEventMap` to include the new events.

### 6. Intégrer le replanning dans `AgentPool`

#### A. Configuration

Ajouter dans `AgentPoolConfig` :

```typescript
/**
 * Whether adaptive replanning is enabled.
 * When enabled, the pool will consult the planner when subtasks fail
 * after retries, when deadlocks are detected, or when cascading
 * failures suggest the plan is unviable.
 *
 * Default: true
 */
readonly enableReplanning?: boolean;

/**
 * Maximum number of replanning attempts per execution.
 * Prevents infinite replan loops.
 *
 * Default: 2
 */
readonly maxReplanAttempts?: number;
```

#### B. Runtime state

Add to the pool class :

```typescript
/** Number of replanning attempts in the current execution. */
private _replanCount = 0;

/** Maximum replanning attempts (from config). */
private readonly _maxReplanAttempts: number;

/** Whether replanning is enabled (from config). */
private readonly _enableReplanning: boolean;
```

Initialize in the constructor :

```typescript
this._maxReplanAttempts = config.maxReplanAttempts ?? 2;
this._enableReplanning = config.enableReplanning !== false; // default true
```

Reset in the `finally` block of `execute()` :

```typescript
this._replanCount = 0;
```

#### C. Trigger replanning on subtask failure

After the retry mechanism of evolution 10 is exhausted, instead of just marking the subtask as definitively failed, evaluate whether replanning is possible :

```typescript
/**
 * Evaluates whether the current execution should be replanned.
 *
 * Called when:
 * - A subtask fails after exhausting all retries (SUBTASK_FAILURE)
 * - A deadlock is detected in executeSubtasks() (DEADLOCK)
 * - Multiple subtasks have failed (CASCADING_FAILURES)
 *
 * @param trigger - What caused the replan evaluation.
 * @param analysis - The original task analysis.
 * @param agents - The spawned agents map.
 * @param completed - Set of completed subtask IDs.
 * @param failed - Set of failed subtask IDs.
 * @param remaining - Set of remaining subtask IDs.
 * @param problemDescription - Human-readable description of the problem.
 * @returns The replan decision, or null if replanning is disabled/exhausted.
 */
private async evaluateReplan(
    trigger: ReplanTrigger,
    analysis: TaskAnalysis,
    agents: Map<string, { agent: PoolManagedAgent; subtask: SubTask }>,
    completed: Set<string>,
    failed: Set<string>,
    remaining: Set<string>,
    problemDescription: string,
): Promise<ReplanDecision | null> {
    // Guard: replanning disabled or max attempts reached
    if (!this._enableReplanning) return null;
    if (this._replanCount >= this._maxReplanAttempts) {
        this.logger.info(
            { replanCount: this._replanCount, max: this._maxReplanAttempts },
            "Max replan attempts reached — proceeding without replanning",
        );
        return null;
    }

    // Guard: single-agent strategy doesn't benefit from replanning
    if (analysis.strategy === ExecutionStrategy.SINGLE) return null;

    this._replanCount++;

    this.emitPoolEvent(PoolEvent.REPLAN_START, {
        trigger,
        problemDescription,
    });

    // Build the replan request
    const agentStates = analysis.subtasks.map(subtask => {
        const entry = agents.get(subtask.id);
        const ctxState = entry
            ? this.contextTracker.getAgentState(entry.agent.id)
            : undefined;

        return {
            subtaskId: subtask.id,
            agentName: entry?.agent.name ?? subtask.role,
            role: subtask.role,
            completed: completed.has(subtask.id),
            failed: failed.has(subtask.id),
            error: ctxState?.error ?? null,
            accomplishedSummary: this.buildAccomplishedSummary(ctxState),
            filesWritten: ctxState?.filesWritten ?? [],
        };
    });

    const blockedSubtaskIds = [...remaining].filter(id => !failed.has(id));

    const request: ReplanRequest = {
        trigger,
        originalTask: this._currentTask!,
        originalAnalysis: analysis,
        agentStates,
        blockedSubtaskIds,
        problemDescription,
    };

    const decision = await this.planner.replan(request);

    this.emitPoolEvent(PoolEvent.REPLAN_COMPLETE, { decision });

    return decision;
}

/**
 * Builds a short summary of what an agent accomplished based on its context state.
 */
private buildAccomplishedSummary(
    state: AgentContextState | undefined,
): string {
    if (!state) return "No information available.";

    const parts: string[] = [];

    if (state.promptResults.length > 0) {
        const lastResult = state.promptResults[state.promptResults.length - 1];
        if (lastResult?.text) {
            parts.push(`Response (${lastResult.text.length} chars): ${lastResult.text.slice(0, 300)}`);
        }
    }

    if (state.filesWritten.length > 0) {
        parts.push(`Files written: ${state.filesWritten.join(", ")}`);
    }

    if (state.events.length > 0) {
        parts.push(`Events: ${state.events.length} total`);
    }

    return parts.length > 0
        ? parts.join(". ")
        : "Agent did not produce significant output.";
}
```

#### D. Apply the replan decision

```typescript
/**
 * Applies a replan decision to the current execution.
 *
 * For "modify": destroys failed/blocked agents, spawns new agents
 * for the new subtasks, and injects the completedWorkSummary.
 *
 * For "restart": destroys all agents and re-executes from scratch.
 *
 * For "abort": destroys all agents and throws an error.
 *
 * For "continue": no action (caller continues the execution loop).
 *
 * @param decision - The replan decision to apply.
 * @param analysis - The original analysis (mutated for "modify").
 * @param agents - The agents map (mutated for "modify").
 * @param completed - Set of completed subtask IDs (preserved).
 * @param failed - Set of failed subtask IDs (cleared for modified tasks).
 * @param remaining - Set of remaining subtask IDs (replaced for modified tasks).
 * @returns Whether execution should continue (true) or restart/abort (false).
 */
private async applyReplanDecision(
    decision: ReplanDecision,
    analysis: TaskAnalysis,
    agents: Map<string, { agent: PoolManagedAgent; subtask: SubTask }>,
    completed: Set<string>,
    failed: Set<string>,
    remaining: Set<string>,
): Promise<{ continueExecution: boolean; restart: boolean }> {
    switch (decision.action) {
        case "continue":
            this.logger.info("Replan decision: continue with current plan");
            return { continueExecution: true, restart: false };

        case "abort":
            this.logger.warn(
                { reasoning: decision.reasoning },
                "Replan decision: abort execution",
            );
            throw new Error(
                `Execution aborted by replanner: ${decision.reasoning}`,
            );

        case "restart":
            this.logger.info("Replan decision: restart from scratch");
            await this.destroyManagedAgents();
            return { continueExecution: false, restart: true };

        case "modify": {
            this.logger.info(
                {
                    newSubtaskCount: decision.newSubtasks.length,
                    newDepCount: decision.newDependencies.length,
                },
                `Replan decision: modify plan — ${decision.newSubtasks.length} new subtask(s)`,
            );

            // 1. Destroy agents for failed and blocked subtasks
            for (const subtaskId of [...failed, ...remaining]) {
                const entry = agents.get(subtaskId);
                if (entry && entry.agent.status !== "destroyed") {
                    await entry.agent.destroy().catch(() => {});
                    this.managedAgents.delete(entry.agent.id);
                    this.contextTracker.unregisterAgent(entry.agent.id);
                }
                agents.delete(subtaskId);
                this.subtaskToAgent.delete(subtaskId);
            }

            // 2. Clear failed and remaining sets
            failed.clear();
            remaining.clear();

            // 3. Update analysis with new subtasks and dependencies
            // Note: we mutate the analysis object here — it's local to executeSubtasks
            const mergedSubtasks = [
                ...analysis.subtasks.filter(s => completed.has(s.id)),
                ...decision.newSubtasks,
            ];
            (analysis as { subtasks: SubTask[] }).subtasks = mergedSubtasks;
            (analysis as { dependencies: TaskDependency[] }).dependencies = decision.newDependencies;

            // 4. Add new subtask IDs to remaining
            for (const subtask of decision.newSubtasks) {
                remaining.add(subtask.id);
            }

            // 5. Spawn new agents for the new subtasks
            for (const subtask of decision.newSubtasks) {
                const agentConfig: AgentConfig = {
                    logOutput: this.config.logOutput,
                    logLevel: this.config.logLevel,
                    cwd: this.config.cwd,
                    ...this.config.agentConfig,
                    name: subtask.role,
                };

                const agent = this.agentFactory(agentConfig);

                this.contextTracker.registerAgent(agent.id, agent.name, subtask);
                this.subtaskToAgent.set(subtask.id, agent.id);
                this.agentToSubtask.set(agent.id, subtask.id);
                this.wireAgentEvents(agent, subtask);

                const entry = { agent, subtask, result: null };
                this.managedAgents.set(agent.id, entry);
                agents.set(subtask.id, { agent, subtask });

                this.emitPoolEvent(PoolEvent.AGENT_SPAWNED, {
                    agentId: agent.id,
                    agentName: agent.name,
                    subtask,
                });

                try {
                    await agent.ready;
                } catch (err) {
                    this.contextTracker.markFailed(agent.id, toErrorMessage(err));
                }

                // 6. Inject completed work summary into new agents
                if (decision.completedWorkSummary) {
                    agent.injectContext({
                        content: decision.completedWorkSummary,
                        priority: ContextInjectionPriority.HIGH,
                        category: ContextInjectionCategory.SHARED_CONTEXT,
                        source: "replanner",
                        dependencyType: null,
                        timestamp: isoNow(),
                    });
                }
            }

            // 7. Update the information broker with new dependencies
            this.informationBroker = new InformationBroker(
                this.conversations,
                this.contextTracker,
                decision.newDependencies,
                this.logger,
                this.subtaskToAgent,
                this.agentToSubtask,
            );

            return { continueExecution: true, restart: false };
        }

        default:
            this.logger.warn(
                { action: decision.action },
                "Unknown replan action — continuing",
            );
            return { continueExecution: true, restart: false };
    }
}
```

#### E. Integration points in `executeSubtasks()`

There are three places in `executeSubtasks()` where replanning should be triggered :

##### 1. After a subtask fails (post-retry exhaustion)

After the retry mechanism from evolution 10 has been exhausted and the subtask is definitively marked as failed :

```typescript
// After all retries exhausted for a subtask
failed.add(subtaskId);
inProgress.delete(subtaskId);

// Check if we should replan
const failedCount = failed.size;
const trigger = failedCount >= 2
    ? ReplanTrigger.CASCADING_FAILURES
    : ReplanTrigger.SUBTASK_FAILURE;

const decision = await this.evaluateReplan(
    trigger,
    analysis,
    agents,
    completed,
    failed,
    remaining,
    `Subtask "${subtaskId}" (${subtask.role}) failed after ${retryCount} retries: ${errorMessage}`,
);

if (decision && decision.action !== "continue") {
    const result = await this.applyReplanDecision(
        decision, analysis, agents, completed, failed, remaining,
    );

    if (result.restart) {
        // Break out of executeSubtasks and restart execute()
        // This requires refactoring execute() to support restart — see below
        throw new ReplanRestartError(decision);
    }
    // For "modify": continue the while loop — new subtasks are in `remaining`
    continue;
}
```

##### 2. On deadlock detection

Replace the current deadlock handling (which just marks everything as failed) :

```typescript
// Current deadlock handling:
// "Subtask execution deadlocked — remaining tasks have unsatisfiable dependencies"

const decision = await this.evaluateReplan(
    ReplanTrigger.DEADLOCK,
    analysis,
    agents,
    completed,
    failed,
    remaining,
    `Deadlock detected: subtasks ${[...remaining].join(", ")} have unsatisfiable dependencies. ` +
    `Completed: ${[...completed].join(", ")}. Failed: ${[...failed].join(", ")}.`,
);

if (decision && decision.action === "modify") {
    const result = await this.applyReplanDecision(
        decision, analysis, agents, completed, failed, remaining,
    );
    if (result.continueExecution) {
        continue; // Try again with the modified plan
    }
}

// If replan didn't happen or said continue/abort, use existing deadlock handling
```

### 7. New error class for restart

```typescript
/**
 * Thrown when a replan decision requires restarting the entire execution.
 * Caught by execute() to trigger a full restart.
 */
class ReplanRestartError extends Error {
    constructor(readonly decision: ReplanDecision) {
        super(`Replan requires restart: ${decision.reasoning}`);
        this.name = "ReplanRestartError";
    }
}
```

### 8. Handle restart in `execute()`

Wrap the execution in a retry loop for restart :

```typescript
async execute(task: string): Promise<AgentPoolResult> {
    this.assertNotDestroyed();
    await this.conversations.client.validateModel();

    if (this._executing) {
        throw new Error("AgentPool is already executing a task...");
    }

    const MAX_RESTARTS = 1; // Only allow one full restart
    let restartCount = 0;

    while (restartCount <= MAX_RESTARTS) {
        try {
            return await this._executeInternal(task);
        } catch (error) {
            if (error instanceof ReplanRestartError && restartCount < MAX_RESTARTS) {
                this.logger.info(
                    { restartCount, reasoning: error.decision.reasoning },
                    "Restarting execution due to replan decision",
                );
                restartCount++;
                // Reset state and retry
                await this.destroyManagedAgents();
                this.subtaskToAgent.clear();
                this.agentToSubtask.clear();
                this._deltaCount = 0;
                this._sharingDecisionCount = 0;
                this._replanCount = 0; // Reset replan count for the fresh start
                continue;
            }
            throw error;
        }
    }

    throw new Error("Execution restart loop exceeded maximum attempts");
}

/**
 * Internal execution logic, extracted from execute() to support restart.
 */
private async _executeInternal(task: string): Promise<AgentPoolResult> {
    // ... existing execute() logic (phases 1-5) ...
}
```

### 9. Add `replan` intent to the user

Add a new intent `REPLAN` in the intent system so users can trigger replanning manually via `pool.send()` :

In `UserIntent` enum :

```typescript
/** The user wants to trigger a replan of the current execution. */
REPLAN = "replan",
```

In the intent analysis system prompt, add :

```
- **replan**: User wants to change the current plan or ask the system to re-evaluate its approach.
```

In `AgentPool.send()`, handle the new intent :

```typescript
case UserIntent.REPLAN: {
    if (!this._executing || !this._currentAnalysis) {
        return "No active execution to replan.";
    }

    const reason = typeof intent.parameters.reason === "string"
        ? intent.parameters.reason
        : message;

    // Trigger a manual replan evaluation
    // (The actual replan will be evaluated asynchronously — this returns immediately)
    return "Replan evaluation requested. The system will evaluate whether the current plan should be modified.";
}
```

**Note** : A full implementation of user-triggered replanning would require more complex async coordination with the running execution loop. For this evolution, the user intent is recognized but the actual trigger mechanism is deferred to a follow-up. The automatic triggers (failure, deadlock, cascading) are the primary mechanism.

---

## Replan flow diagram

```
Subtask fails (after retries) or Deadlock detected
                    │
                    ▼
         ┌──────────────────┐
         │ evaluateReplan() │
         │                  │
         │ • Check guards   │
         │ • Build request  │
         │ • Call planner   │
         └────────┬─────────┘
                  │
                  ▼
         ┌──────────────────┐
         │ planner.replan() │
         │                  │
         │ • Send to LLM    │
         │ • Validate JSON  │
         │ • Semantic check │
         └────────┬─────────┘
                  │
         ┌────────┴────────────────────────────────────┐
         │              │              │               │
         ▼              ▼              ▼               ▼
     continue        modify        restart          abort
         │              │              │               │
         │              ▼              ▼               ▼
         │     applyReplanDecision     │          throw Error
         │              │              │
         │              ▼              ▼
         │     • Destroy failed   ReplanRestartError
         │     • Spawn new agents      │
         │     • Inject summary        ▼
         │     • Update broker    execute() catches
         │              │         and restarts
         │              ▼
         └─────► Continue execution loop
```

---

## Tests à implémenter

### Tests unitaires pour `TaskPlanner.replan()`

#### Test 1 : `replan()` retourne `continue` pour un problème mineur

- Setup : 1 subtask sur 3 a échoué, les 2 autres sont complétés
- Mock le LLM pour retourner `action: "continue"`
- Assert : `decision.action === "continue"`
- Assert : `decision.newSubtasks.length === 0`

#### Test 2 : `replan()` retourne `modify` avec de nouveaux subtasks valides

- Setup : 1 subtask échoué, 1 complété, 1 bloqué
- Mock le LLM pour retourner `action: "modify"` avec 2 nouveaux subtasks
- Assert : `decision.action === "modify"`
- Assert : `decision.newSubtasks.length === 2`
- Assert : les subtasks sont validés (`validateSubTask` passe)
- Assert : `decision.completedWorkSummary` n'est pas vide

#### Test 3 : `replan()` rejette un modify qui réutilise un completed subtask ID

- Mock le LLM pour retourner un subtask avec un ID déjà completed
- Assert : le fallback `continue` est retourné à cause de la validation sémantique

#### Test 4 : `replan()` valide les dépendances dans le modify

- Mock le LLM pour retourner des dépendances référençant des IDs inexistants
- Assert : le fallback `continue` est retourné à cause de la validation sémantique

#### Test 5 : `replan()` retourne un fallback safe quand le LLM échoue

- Mock le LLM pour throw une erreur
- Assert : `decision.action === "continue"`
- Assert : le reasoning mentionne l'erreur

#### Test 6 : `validateReplanDecision` rejette les données invalides

- Assert : `null` pour `action` manquant
- Assert : `null` pour `modify` sans `newSubtasks`
- Assert : `null` pour `continue` avec `newSubtasks` non-vide
- Assert : valide pour un decision `continue` correct
- Assert : valide pour un decision `modify` correct avec subtasks et deps

### Tests unitaires pour `AgentPool` replanning integration

#### Test 7 : `evaluateReplan` n'est pas appelé quand `enableReplanning` est false

- Config : `enableReplanning: false`
- Simuler un échec de subtask
- Assert : le planner `replan()` n'est jamais appelé

#### Test 8 : `evaluateReplan` n'est pas appelé au-delà de `maxReplanAttempts`

- Config : `maxReplanAttempts: 1`
- Simuler 2 échecs de subtask séquentiels
- Assert : `replan()` n'est appelé qu'une seule fois
- Assert : le deuxième échec utilise le handling standard (pas de replan)

#### Test 9 : `evaluateReplan` n'est pas appelé pour single-agent strategy

- Simuler un échec en mode single-agent
- Assert : `replan()` n'est jamais appelé (le fallback standard s'applique)

#### Test 10 : `applyReplanDecision` avec `modify` spawns new agents

- Simuler un modify avec 2 nouveaux subtasks
- Assert : 2 nouveaux agents sont spawnés
- Assert : les agents de subtasks failed/blocked sont détruits
- Assert : les agents de subtasks completed sont préservés
- Assert : le `completedWorkSummary` est injecté dans les nouveaux agents

#### Test 11 : `applyReplanDecision` avec `modify` recreates the InformationBroker

- Simuler un modify
- Assert : un nouveau `InformationBroker` est créé avec les nouvelles dépendances
- Assert : les anciens mappings subtaskToAgent sont nettoyés pour les subtasks supprimés
- Assert : les nouveaux mappings sont ajoutés pour les nouveaux subtasks

#### Test 12 : `applyReplanDecision` avec `restart` throws ReplanRestartError

- Simuler un restart decision
- Assert : `ReplanRestartError` est thrown
- Assert : `destroyManagedAgents()` est appelé

#### Test 13 : `applyReplanDecision` avec `abort` throws a regular Error

- Simuler un abort decision
- Assert : une `Error` est thrown avec le reasoning du planner

#### Test 14 : `execute()` retries on ReplanRestartError

- Mock `_executeInternal` pour throw `ReplanRestartError` au premier appel, puis succeed au second
- Assert : `execute()` retourne un résultat valide (deuxième tentative)
- Assert : `_executeInternal` est appelé 2 fois

#### Test 15 : `execute()` doesn't loop forever on restart

- Mock `_executeInternal` pour throw `ReplanRestartError` à chaque appel
- Assert : `execute()` throws après `MAX_RESTARTS + 1` tentatives

#### Test 16 : Deadlock triggers replanning instead of immediate failure

- Simuler un deadlock (subtasks restants avec dépendances insatisfaisables)
- Assert : `evaluateReplan()` est appelé avec `ReplanTrigger.DEADLOCK`
- Assert : si le replan retourne `modify`, le deadlock est résolu

#### Test 17 : CASCADING_FAILURES trigger when multiple subtasks fail

- Simuler 2 subtasks qui échouent
- Assert : le trigger est `CASCADING_FAILURES` (pas `SUBTASK_FAILURE`)

### Tests d'intégration

#### Test 18 : Pool events REPLAN_START and REPLAN_COMPLETE are emitted

- Simuler un échec de subtask qui déclenche un replan
- Assert : `PoolEvent.REPLAN_START` est émis avec le trigger et la description
- Assert : `PoolEvent.REPLAN_COMPLETE` est émis avec la decision

#### Test 19 : Le replan prompt contient le bon contexte

- Mocker `sendJson` pour capturer le prompt
- Déclencher un replan
- Assert : le prompt contient le task original
- Assert : le prompt contient les subtasks originaux avec leurs statuts
- Assert : le prompt contient les fichiers écrits par les agents complétés
- Assert : le prompt contient la description du problème

#### Test 20 : Full integration — subtask fails, replan modifies, new subtask succeeds

- Scénario end-to-end avec des agents mockés :
  1. Plan : 3 subtasks (A → B → C)
  2. A complète avec succès
  3. B échoue (après retries)
  4. Replan : modify avec nouveau subtask B' (différent prompt, référence le travail de A)
  5. B' complète avec succès
  6. C complète avec succès
- Assert : le résultat final est un succès avec 4 agents au total (A, B failed, B' success, C success)
- Assert : le summary mentionne le replanning

---

## Critères de validation

- [ ] Le `TaskPlanner` a une méthode `replan()` qui accepte un `ReplanRequest` et retourne un `ReplanDecision`
- [ ] Le prompt de replanning inclut le contexte complet (task original, plan, état des agents, fichiers écrits, erreurs)
- [ ] Le validator `validateReplanDecision` vérifie la structure JSON et les contraintes de cohérence
- [ ] La validation sémantique vérifie que les modify ne réutilisent pas des IDs complétés et que les dépendances sont valides
- [ ] Le fallback en cas d'erreur LLM ou de validation est `continue` (pas d'action destructive)
- [ ] L'`AgentPool` déclenche le replan sur les triggers : subtask failure, deadlock, cascading failures
- [ ] L'`AgentPool` respecte `enableReplanning` et `maxReplanAttempts`
- [ ] Le replan n'est pas déclenché pour les stratégies single-agent
- [ ] `applyReplanDecision` avec `modify` : détruit les agents failed/bloqués, spawne de nouveaux agents, injecte le `completedWorkSummary`, met à jour le broker
- [ ] `applyReplanDecision` avec `restart` : déclenche un restart complet via `ReplanRestartError`
- [ ] `applyReplanDecision` avec `abort` : throw une erreur descriptive
- [ ] `execute()` supporte le restart (boucle avec `MAX_RESTARTS = 1`)
- [ ] Les events `REPLAN_START` et `REPLAN_COMPLETE` sont émis
- [ ] Le `_replanCount` est réinitialisé entre les exécutions et entre les restarts
- [ ] Le deadlock handling dans `executeSubtasks()` utilise le replan au lieu de marquer tout comme failed
- [ ] Les agents complétés ne sont JAMAIS détruits ni re-exécutés lors d'un modify
- [ ] Le `completedWorkSummary` est injecté dans les nouveaux agents avec priority `HIGH` et category `SHARED_CONTEXT`
- [ ] Tous les tests existants passent toujours
- [ ] Les nouveaux tests couvrent tous les triggers, toutes les actions de decision, la validation, et le flow end-to-end

---

## Points d'attention

1. **Le replanning est coûteux** — chaque appel `planner.replan()` est un appel LLM complet avec un prompt potentiellement long (état de tous les agents, fichiers, erreurs). C'est pourquoi `maxReplanAttempts` est limité à 2 par défaut et le guard single-agent est en place.

2. **Mutation de `analysis` dans `applyReplanDecision`** — pour simplifier l'intégration, l'objet `TaskAnalysis` est muté en place lors d'un `modify`. C'est un compromis pragmatique : l'alternative serait de retourner un nouveau `TaskAnalysis` et de le propager partout dans `executeSubtasks()`, ce qui nécessiterait un refactoring significatif. La mutation est locale (dans la portée de `executeSubtasks()`) et documentée.

3. **L'`InformationBroker` est recréé après un modify** — c'est nécessaire car les dépendances changent. Le broker précédent est abandonné (GC'ed). L'historique de sharing est perdu, mais c'est acceptable car les agents qui avaient reçu des partages sont soit complétés (pas besoin de plus de partages) soit détruits (le sharing n'a plus de cible).

4. **Le `completedWorkSummary` est crucial** — sans lui, les nouveaux agents ne sauraient pas ce qui a déjà été fait. Le planner LLM doit produire un résumé actionnable. Si le résumé est vide ou absent, les nouveaux agents pourraient refaire du travail déjà accompli.

5. **Le restart efface tout** — c'est intentionnel. Un restart est le dernier recours quand le plan est fondamentalement cassé. Le `_replanCount` est reset pour que le nouveau plan ait aussi droit à des replans si nécessaire.

6. **L'`execute()` refactoring** — extraire la logique interne dans `_executeInternal()` est un changement de structure significatif. S'assurer que tous les états (try/catch, finally, event emission) sont correctement propagés entre `execute()` et `_executeInternal()`.

7. **Race conditions avec `handleDelta()`** — les deltas sont traités en fire-and-forget. Pendant un replan (qui est async), des deltas peuvent encore arriver des agents qui ne sont pas encore détruits. Les handlers doivent être résilients aux agents qui disparaissent pendant le traitement d'un delta.

8. **Le user intent `REPLAN`** est reconnu mais pas pleinement implémenté dans cette évolution. L'intégration complète (signaler l'exécution en cours qu'un replan est demandé) nécessiterait un mécanisme de signal inter-async (ex: un flag `_replanRequested` vérifié dans la boucle d'exécution). Pour cette évolution, les triggers automatiques sont le mécanisme principal.

9. **Ne pas confondre replan et retry** (évolution 10) — le retry relance le MÊME subtask avec le MÊME prompt (+ contexte d'erreur). Le replan change le PLAN (nouveaux subtasks, nouvelles dépendances, nouveaux prompts). Les deux mécanismes sont complémentaires : le retry est la première ligne de défense, le replan intervient quand le retry est épuisé.

10. **Les subtasks complétés sont considérés comme immuables** — le replan ne peut pas annuler ou modifier le travail d'un agent complété. Si le travail complété est problématique (ex: a créé des fichiers incorrects), la seule option est `restart`. Cela simplifie considérablement la logique de replan.

11. **Testing du prompt** — le prompt de replanning est le plus contextuel de tout le système (il inclut l'état complet de l'exécution). Les tests doivent vérifier que toutes les informations pertinentes sont incluses et que le format est parsable par le LLM. Tester avec des scénarios variés : 1 subtask failed, deadlock, cascading, etc.

12. **Le `buildAccomplishedSummary`** est heuristique — il extrait les 300 premiers caractères du dernier prompt result et la liste des fichiers écrits. C'est suffisant pour donner au planner une idée de ce qui a été fait, sans un appel LLM supplémentaire. Dans le futur, on pourrait utiliser le `promptResultSummary` de l'évolution 07 pour un résumé plus riche.