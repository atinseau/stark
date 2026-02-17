# Évolution 13 — Mémoire glissante du Planner (résumé au lieu de reset total)

## Priorité : 🟡 P2

## Dépendances : Évolution 03 (Contexte projet dans le planner)

## Acquis des évolutions précédentes

- **Évolution 01** : L'`InformationBroker` reçoit les mappings `subtaskToAgent` / `agentToSubtask` via son constructeur. `isAgentForSubtask()` fonctionne. Le tri des candidats par dépendance est opérationnel. `findDependency()` traduit correctement entre agent IDs et subtask IDs.
- **Évolution 02** : L'`InformationBroker` maintient un `SharingHistory` indexé par agent cible. Le prompt de partage inclut les partages précédents (`previouslyShared`). `recordSharing()` est appelé après chaque injection réussie. Le type `SharingRecord` existe.
- **Évolution 03** : Le `ProjectScanner` scanne le répertoire de travail et produit un `ProjectContext`. Le planner reçoit le contexte projet (arborescence, langages, frameworks, configs résumés). Le system prompt du planner inclut une section `## Project Context Usage`. Le `taskAnalysisPrompt` accepte un paramètre `projectContext`.
- **Évolution 04** : Tous les prompts LLM contiennent des exemples few-shot contrastifs. Les validateurs acceptent les JSON des exemples.
- **Évolution 05** : Le rôle `ConversationRole.SHARING_ANALYZER` existe. Le system prompt `SHARING_ANALYZER` est dédié au partage inter-agents. L'`InformationBroker` utilise `SHARING_ANALYZER`. Le `CONTEXT_ANALYZER` est spécialisé pour les notifications.
- **Évolution 06** : Le notification prompt est nettoyé. Le summary prompt inclut les `CoordinationStats` et `sharingSummaries`. `durationMs` est correctement calculé.
- **Évolution 07** : Le preview dans les deltas `PROMPT_COMPLETE` est augmenté à 2000 chars. Le champ `promptResultSummary` existe dans `ContextDelta`. L'`InformationBroker` dispose de `evaluateWithFullResult()` pour les blocking deps.
- **Évolution 08** : L'injection de contexte est structurée avec `StructuredContextInjection`, priorisée (`CRITICAL` > `HIGH` > `NORMAL` > `LOW`), catégorisée et avec gestion d'overflow.
- **Évolution 09** : Le seuil de significance de l'`InformationBroker` est dynamique, adapté selon la phase d'exécution, le type de dépendance et le nombre d'agents.
- **Évolution 10** : Les subtasks ont un timeout configurable (`subtaskTimeoutMs`). Les agents qui dépassent le timeout sont marqués `failed` et un retry peut être déclenché (`maxSubtaskRetries`). L'agent défaillant est détruit et un nouveau est spawné avec le même prompt + le contexte d'erreur.
- **Évolution 11** : Le planner peut être re-consulté en cours d'exécution via `replan()`. Quand un subtask échoue de manière irrécupérable ou que le contexte change significativement, la pool demande au planner de réévaluer le plan avec l'état courant. Le re-planning peut modifier les subtasks restants.
- **Évolution 12** : L'intent analyzer supporte le multi-intent (retourne `intents[]` au lieu d'un seul `intent`). Il dispose d'un historique conversationnel des 3 derniers échanges user-pool inclus dans le prompt. Un seuil de confirmation existe pour les intents à faible confiance.

---

## Contexte du problème

Le `TaskPlanner` effectue un **reset total** de sa conversation à chaque appel à `analyze()` :

```typescript
// src/classes/agent-pool/task-planner.ts — analyze() (lignes ~231-235)
async analyze(
    task: string,
    contextHints?: string,
    constraints?: string[],
    projectContext?: ProjectContext,
): Promise<TaskAnalysis> {
    // Reset planner conversation to prevent history accumulation
    // across sequential executions. Each planning call starts fresh,
    // but semantic retry loops within a single call still work because
    // sendJson appends to the conversation during correction attempts.
    this.conversations.reset(ConversationRole.PLANNER);

    // ...
}
```

### Conséquences du reset total

1. **Perte de contexte inter-exécutions** : Si l'utilisateur fait `execute("Build the API")` puis `send("Now add tests for it")`, le planner n'a aucune mémoire de la première tâche. Il ne sait pas quels fichiers ont été créés, quelle architecture a été choisie, quels agents ont été utilisés, ce qui a fonctionné ou échoué.

2. **Décisions de décomposition dégradées** : Sans connaître l'historique, le planner pourrait re-créer un subtask pour du travail déjà accompli (ex : re-setup le projet, re-écrire le routing). Même avec le `ProjectScanner` (évolution 03) qui détecte les fichiers existants, le planner ne sait pas **pourquoi** ces fichiers existent ni **comment** ils ont été créés.

3. **Pas d'apprentissage des erreurs** : Si une décomposition multi-agent a échoué (ex : le split frontend/backend a causé des conflits), le planner referait la même erreur lors de la prochaine exécution car il n'a aucune mémoire des échecs.

4. **Le re-planning (évolution 11) atténue mais ne résout pas** : Le re-planning permet d'ajuster le plan **pendant** une exécution, mais les leçons ne survivent pas à la fin de l'exécution (`finally` block dans `execute()` nettoie tout).

5. **Les follow-up tasks sont traités comme des tâches vierges** : `pool.send("Now add authentication")` est analysé par le planner comme si c'était le premier contact avec le projet. Le planner ne sait pas que l'API existe déjà, que les tests sont déjà écrits, que le framework Express a été choisi.

### Pourquoi le reset existe

Le commentaire dans le code explique la raison : « prevent history accumulation across sequential executions ». C'est une précaution légitime — sans contrôle, l'historique de conversation du planner grossirait indéfiniment, finissant par saturer la fenêtre de contexte et par coûter de plus en plus de tokens.

### La solution : mémoire glissante

Au lieu de choisir entre « tout garder » (explosion de tokens) et « tout supprimer » (amnésie), la solution est un **résumé glissant** : avant chaque reset, résumer les informations clés de la session précédente en un paragraphe condensé qui est injecté comme contexte de la session suivante.

---

## Fichiers impactés

| Fichier | Action |
|---------|--------|
| `src/classes/agent-pool/task-planner.ts` | Implémenter la mémoire glissante avec résumé avant reset |
| `src/classes/agent-pool/agent-pool.ts` | Transmettre les résultats d'exécution au planner pour le résumé |
| `src/prompts/planning.ts` | Ajouter la section `## Previous Execution Context` dans les prompts |
| `src/types/agent-pool.types.ts` | Ajouter le type `PlannerMemory` |
| `src/classes/agent-pool/tests/` | Tests unitaires |

---

## Spécification détaillée des changements

### 1. Nouveau type `PlannerMemory` dans `agent-pool.types.ts`

```typescript
/**
 * Condensed memory of a previous planning + execution cycle.
 *
 * Stored by the TaskPlanner between analyze() calls and injected
 * as context into subsequent planning prompts. This enables the
 * planner to make informed decisions about follow-up tasks without
 * carrying the full conversation history.
 *
 * The memory is intentionally small (~500-800 tokens) to avoid
 * bloating the planner's context window over multiple cycles.
 */
export interface PlannerMemory {
    /**
     * The original task that was planned.
     * Truncated to 200 chars for memory efficiency.
     */
    readonly task: string;

    /**
     * The strategy chosen by the planner (single/multi).
     */
    readonly strategy: ExecutionStrategy;

    /**
     * Brief list of subtask roles executed.
     * Example: ["api-developer", "test-writer"]
     */
    readonly roles: string[];

    /**
     * Execution outcome summary.
     * Example: "2/3 subtasks succeeded. api-developer and test-writer completed. docs-writer failed (timeout)."
     */
    readonly outcome: string;

    /**
     * Key files created or modified during execution.
     * Limited to 15 entries.
     */
    readonly filesAffected: string[];

    /**
     * Lessons learned — what worked well or poorly.
     * Example: "Multi-agent split worked well for API+tests. Documentation agent timed out — consider single-agent for docs."
     */
    readonly lessons: string;

    /**
     * ISO-8601 timestamp of when this memory was created.
     */
    readonly timestamp: string;
}
```

### 2. Ajouter le stockage de mémoire dans `TaskPlanner`

```typescript
export class TaskPlanner {
    /** Maximum number of semantic correction attempts before fallback. */
    private static readonly MAX_SEMANTIC_RETRIES = 2;

    /**
     * Maximum number of previous execution memories retained.
     * Older memories are discarded to prevent unbounded growth.
     * Each memory is ~500-800 tokens, so 3 memories ≈ 1500-2400 tokens.
     */
    private static readonly MAX_MEMORY_ENTRIES = 3;

    /**
     * Rolling memory of previous planning + execution cycles.
     * Newest entries are at the end. Oldest are discarded when
     * MAX_MEMORY_ENTRIES is exceeded.
     */
    private readonly memories: PlannerMemory[] = [];

    constructor(
        private readonly conversations: ConversationManager,
        private readonly logger: pino.Logger,
        plannerModel?: string,
    ) {
        if (!this.conversations.has(ConversationRole.PLANNER)) {
            this.conversations.register(
                ConversationRole.PLANNER,
                planningSystemPrompt({}),
                plannerModel,
            );
        }
    }

    // ... existing code
}
```

### 3. Méthode `recordExecution()` dans `TaskPlanner`

Ajouter une méthode publique pour enregistrer les résultats d'une exécution terminée :

```typescript
/**
 * Records the results of a completed execution for future planning context.
 *
 * Called by the AgentPool after execute() completes (success or failure).
 * The execution details are condensed into a PlannerMemory entry that
 * will be injected into the next analyze() call's prompt.
 *
 * @param task - The original task description.
 * @param analysis - The TaskAnalysis produced by the planner.
 * @param results - The execution results for all subtasks.
 */
recordExecution(
    task: string,
    analysis: TaskAnalysis,
    results: AgentExecutionResult[],
): void {
    const successCount = results.filter((r) => r.success).length;
    const failedResults = results.filter((r) => !r.success);

    // Build outcome summary
    const outcomeLines: string[] = [];
    outcomeLines.push(
        `${successCount}/${results.length} subtask(s) succeeded.`,
    );

    for (const result of results) {
        const status = result.success
            ? "completed"
            : `failed: ${result.error?.slice(0, 100) ?? "unknown"}`;
        outcomeLines.push(`- ${result.subtask.role}: ${status}`);
    }

    // Collect all files affected
    const allFiles = results.flatMap((r) => r.filesWritten);
    const uniqueFiles = [...new Set(allFiles)].slice(0, 15);

    // Build lessons learned
    const lessonParts: string[] = [];

    if (analysis.strategy === ExecutionStrategy.MULTI) {
        if (failedResults.length === 0) {
            lessonParts.push(
                `Multi-agent decomposition worked well for this type of task (${analysis.complexity} complexity).`,
            );
        } else {
            const failedRoles = failedResults.map((r) => r.subtask.role).join(", ");
            lessonParts.push(
                `Multi-agent: ${failedRoles} failed. Consider alternative decomposition or single-agent for these concerns.`,
            );
        }
    } else {
        if (failedResults.length === 0) {
            lessonParts.push("Single-agent strategy was appropriate and succeeded.");
        } else {
            lessonParts.push(
                `Single-agent failed: ${failedResults[0]?.error?.slice(0, 100) ?? "unknown"}. Consider different approach.`,
            );
        }
    }

    // Check for timeout failures specifically
    const timeoutFailures = failedResults.filter(
        (r) => r.error?.toLowerCase().includes("timeout"),
    );
    if (timeoutFailures.length > 0) {
        const timeoutRoles = timeoutFailures.map((r) => r.subtask.role).join(", ");
        lessonParts.push(
            `Timeout(s) on: ${timeoutRoles}. These subtasks may need simpler scope.`,
        );
    }

    const memory: PlannerMemory = {
        task: task.slice(0, 200),
        strategy: analysis.strategy,
        roles: analysis.subtasks.map((s) => s.role),
        outcome: outcomeLines.join(" "),
        filesAffected: uniqueFiles,
        lessons: lessonParts.join(" "),
        timestamp: isoNow(),
    };

    this.memories.push(memory);

    // Enforce memory limit — discard oldest
    while (this.memories.length > TaskPlanner.MAX_MEMORY_ENTRIES) {
        this.memories.shift();
    }

    this.logger.info(
        {
            memoryCount: this.memories.length,
            taskPreview: memory.task.slice(0, 60),
            strategy: memory.strategy,
            outcome: memory.outcome.slice(0, 80),
        },
        `Planner memory recorded (${this.memories.length}/${TaskPlanner.MAX_MEMORY_ENTRIES} slots)`,
    );
}
```

### 4. Modifier `analyze()` pour injecter les mémoires

Au lieu de simplement reset la conversation, injecter les mémoires dans le prompt :

```typescript
async analyze(
    task: string,
    contextHints?: string,
    constraints?: string[],
    projectContext?: ProjectContext,
): Promise<TaskAnalysis> {
    // Reset planner conversation — memories survive because they are
    // stored outside the conversation history.
    this.conversations.reset(ConversationRole.PLANNER);

    // Sanitize the task text against prompt injection
    const sanitizedTask = this.conversations.client.sanitize(task);

    // Build the memory context string for injection
    const memoryContext = this.buildMemoryContext();

    // Build the analysis prompt from the Handlebars template
    const prompt = taskAnalysisPrompt({
        task: sanitizedTask,
        contextHints: contextHints ?? null,
        constraints: constraints ?? null,
        projectContext: projectContext ?? null,
        previousExecutions: memoryContext,  // ← NOUVEAU
    });

    this.logger.info(
        {
            taskLength: task.length,
            memoryCount: this.memories.length,
            hasMemoryContext: memoryContext !== null,
        },
        `Analyzing task (${task.length} chars, ${this.memories.length} memory entries)`,
    );

    // ... rest of analyze() unchanged (retry loop, fallback, etc.)
}
```

### 5. Méthode `buildMemoryContext()` dans `TaskPlanner`

```typescript
/**
 * Builds a condensed text representation of the planner's rolling memory
 * for injection into the analysis prompt.
 *
 * Returns `null` if there are no memories (first execution ever).
 *
 * The output is a structured text block that gives the planner context
 * about what has been done before without carrying the full conversation
 * history. Each memory entry is typically 200-400 tokens.
 *
 * @returns A formatted memory context string, or `null` if no memories exist.
 */
private buildMemoryContext(): string | null {
    if (this.memories.length === 0) return null;

    const sections: string[] = [];

    for (let i = 0; i < this.memories.length; i++) {
        const memory = this.memories[i]!;
        const index = i + 1;

        const lines: string[] = [
            `### Execution ${index} (${memory.timestamp})`,
            `- **Task**: ${memory.task}`,
            `- **Strategy**: ${memory.strategy} (${memory.roles.join(", ")})`,
            `- **Outcome**: ${memory.outcome}`,
        ];

        if (memory.filesAffected.length > 0) {
            lines.push(
                `- **Files**: ${memory.filesAffected.slice(0, 10).join(", ")}${memory.filesAffected.length > 10 ? ` (+${memory.filesAffected.length - 10} more)` : ""}`,
            );
        }

        lines.push(`- **Lessons**: ${memory.lessons}`);

        sections.push(lines.join("\n"));
    }

    return sections.join("\n\n");
}
```

### 6. Méthode `clearMemory()` dans `TaskPlanner`

```typescript
/**
 * Clears all stored planner memories.
 *
 * Useful when the user wants to start fresh or when the pool
 * is used for a completely different project context.
 */
clearMemory(): void {
    const previousCount = this.memories.length;
    this.memories.length = 0;

    this.logger.info(
        { previousCount },
        "Planner memory cleared",
    );
}
```

### 7. Getter `memoryCount` dans `TaskPlanner`

```typescript
/**
 * Returns the number of execution memories currently stored.
 */
get memoryCount(): number {
    return this.memories.length;
}

/**
 * Returns a read-only view of the current memories.
 * Primarily for debugging and introspection.
 */
getMemories(): readonly PlannerMemory[] {
    return this.memories;
}
```

### 8. Modifier le template `taskAnalysisPrompt` dans `planning.ts`

Ajouter une section conditionnelle pour le contexte des exécutions précédentes dans `TASK_ANALYSIS_SOURCE` :

```handlebars
Analyze this task and determine the optimal execution strategy.

## Task
<task>
{{task}}
</task>

{{#if previousExecutions}}
## Previous Execution Context
The following tasks have been executed recently in this session. Use this context to:
1. Avoid re-doing work that was already completed successfully.
2. Reference files and structures that already exist from previous executions.
3. Learn from failures — if a strategy failed before, consider alternatives.
4. Understand the user's ongoing workflow and intent.

{{previousExecutions}}
{{/if}}

{{#if contextHints}}
## Context
{{contextHints}}
{{/if}}

{{#if projectContext}}
## Project Context
{{! ... existing project context block from evolution 03 ... }}
{{/if}}

{{#if constraints}}
## Constraints
{{#each constraints}}
- {{this}}
{{/each}}
{{/if}}

Only use "multi" if decomposition provides genuine, meaningful benefit. Single agent is often better. Respond with the JSON analysis object.
```

**Important** : La section `## Previous Execution Context` est placée **après** le `## Task` et **avant** le `## Project Context`. Cet ordre est intentionnel :
1. Le LLM lit d'abord la tâche à analyser
2. Puis le contexte des exécutions précédentes (ce qui a déjà été fait)
3. Puis l'état actuel du projet (fichiers existants, frameworks)
4. Puis les contraintes

### 9. Enrichir le Planning System Prompt

Ajouter une section dans `PLANNING_SYSTEM_SOURCE` pour guider l'utilisation du contexte des exécutions précédentes :

```handlebars
## Previous Execution Memory
When previous execution context is provided:
1. Do NOT re-plan work that was already completed successfully — reference existing files instead.
2. If a previous multi-agent decomposition failed, consider a different split or single-agent approach.
3. If a previous single-agent execution timed out, consider splitting the work into smaller subtasks.
4. Adapt subtask prompts to reference artifacts from previous executions (e.g., "The API is already implemented in src/routes/users.ts — write tests for it").
5. Maintain consistency with previous architectural decisions (framework, language, code style) unless the user explicitly asks for a change.
6. If the new task is clearly a follow-up to a previous one, make subtask prompts that build on the existing code rather than starting from scratch.
```

### 10. Appeler `recordExecution()` depuis `AgentPool.execute()`

Dans `src/classes/agent-pool/agent-pool.ts`, dans la méthode `execute()`, après que le summary est généré et avant le cleanup final :

```typescript
// ── Phase 4+5: Summary + Cleanup (parallel) ────────────────
this.logger.info("Phase 4+5: Summary & Cleanup (parallel)");

const durationMs = Date.now() - startTime;

const [summary] = await Promise.all([
    this.generateSummary(task, analysis, executionResults, durationMs, coordinationStats),
    this.destroyManagedAgents(),
]);

// ← NOUVEAU : Record execution in planner memory
this.planner.recordExecution(task, analysis, executionResults);

const poolResult: AgentPoolResult = {
    task,
    strategy: analysis.strategy,
    analysis,
    agents: executionResults,
    summary,
    durationMs,
};

// ... rest unchanged
```

**Placement** : `recordExecution()` est appelé APRÈS la summary generation et le cleanup, mais AVANT la construction de `poolResult` et l'émission de l'event `EXECUTION_COMPLETE`. Cela garantit que :
- Le planner a reçu les résultats complets
- Les agents sont déjà détruits (pas de race condition)
- La mémoire est disponible pour la prochaine exécution

**Important** : `recordExecution()` est appelé dans le `try` block, PAS dans le `finally` block. En cas d'erreur fatale, on ne veut pas enregistrer une mémoire incomplète. Le `finally` block ne reset PAS les mémoires du planner — elles survivent entre les exécutions.

### 11. Ne PAS reset les mémoires dans le `finally` block

Vérifier que le `finally` block de `execute()` ne touche PAS au planner directement :

```typescript
} finally {
    this._executing = false;
    this._currentTask = null;
    this._currentStrategy = null;
    this._currentAnalysis = null;
    this.informationBroker = null;
    this.subtaskToAgent.clear();
    this.agentToSubtask.clear();
    this._deltaCount = 0;
    this._sharingDecisionCount = 0;
    this._sharingSummaries = [];
    // NOTE: this.planner memories are NOT cleared here — they survive between executions
}
```

### 12. Ajouter `clearPlannerMemory()` dans `AgentPool`

Exposer la possibilité de reset manuellement la mémoire du planner :

```typescript
/**
 * Clears the planner's execution memory.
 *
 * Useful when switching to a completely different project context
 * or when the accumulated memory is no longer relevant.
 * Called automatically during pool.destroy().
 */
clearPlannerMemory(): void {
    this.planner.clearMemory();
}
```

Appeler aussi dans `destroy()` :

```typescript
async destroy(): Promise<void> {
    if (this._destroyed) return;

    this.approvalManager.clear();
    this._destroyed = true;

    this.logger.info("Destroying AgentPool");

    this.planner.clearMemory();  // ← NOUVEAU

    await this.destroyManagedAgents();

    this.emitPoolEvent(PoolEvent.DESTROYED, {});
    this.logger.info("AgentPool destroyed");
}
```

### 13. Exposer les mémoires dans `AgentPoolState`

Ajouter un champ dans `AgentPoolState` pour l'introspection :

```typescript
export interface AgentPoolState {
    // ... existing fields ...

    /**
     * Number of execution memories stored by the planner.
     * These memories influence future planning decisions.
     */
    plannerMemoryCount: number;
}
```

Mettre à jour `getState()` dans `AgentPool` :

```typescript
getState(): AgentPoolState {
    // ... existing code ...
    return {
        // ... existing fields ...
        plannerMemoryCount: this.planner.memoryCount,  // ← NOUVEAU
    };
}
```

---

## Gestion du budget tokens

### Estimation de la taille des mémoires

| Composant | Taille estimée |
|-----------|---------------|
| 1 `PlannerMemory` formatée | ~200-400 tokens |
| Section `## Previous Execution Context` header + instructions | ~50 tokens |
| 3 mémoires max (`MAX_MEMORY_ENTRIES`) | ~600-1200 tokens |
| **Total ajouté au prompt** | **~650-1250 tokens** |

### Comparaison avec l'approche « tout garder »

Sans mémoire glissante, garder l'historique complet de 3 exécutions ajouterait :
- 3 prompts user complets (~2000-5000 tokens chacun)
- 3 réponses assistant complètes (~1000-3000 tokens chacune)
- **Total : 9000-24000 tokens**

La mémoire glissante réduit ce coût de **90-95%** tout en préservant les informations les plus utiles.

### Garde-fous

1. **`MAX_MEMORY_ENTRIES = 3`** — limite stricte sur le nombre de mémoires
2. **`task.slice(0, 200)`** — tronque la description de la tâche
3. **`filesAffected` limité à 15** — ne stocke pas des centaines de fichiers
4. **`error?.slice(0, 100)`** — tronque les messages d'erreur
5. **Pas de stockage du texte des réponses** — seuls les métadonnées et les leçons sont conservées

---

## Cycle de vie de la mémoire

```
┌─────────────────┐
│  Pool created    │  memories = []
└────────┬────────┘
         ▼
┌─────────────────┐
│  execute(task1)  │
│  analyze() →     │  memories = [] (premier appel, pas de contexte)
│  ...execution... │
│  recordExec()    │  memories = [mem1]
└────────┬────────┘
         ▼
┌─────────────────┐
│  execute(task2)  │
│  analyze() →     │  memories = [mem1] → injecté dans le prompt
│  ...execution... │
│  recordExec()    │  memories = [mem1, mem2]
└────────┬────────┘
         ▼
┌─────────────────┐
│  execute(task3)  │
│  analyze() →     │  memories = [mem1, mem2] → injecté dans le prompt
│  ...execution... │
│  recordExec()    │  memories = [mem1, mem2, mem3]
└────────┬────────┘
         ▼
┌─────────────────┐
│  execute(task4)  │
│  analyze() →     │  memories = [mem1, mem2, mem3] → injecté
│  ...execution... │
│  recordExec()    │  memories = [mem2, mem3, mem4] (mem1 évincée, FIFO)
└────────┬────────┘
         ▼
┌─────────────────┐
│  pool.destroy()  │  memories = [] (nettoyé)
└─────────────────┘
```

---

## Interaction avec le re-planning (évolution 11)

L'évolution 11 introduit la possibilité de re-planifier pendant une exécution. La mémoire glissante ne concerne PAS le re-planning intra-exécution — elle concerne le contexte **inter-exécutions**.

- **Re-planning (évolution 11)** : ajuste le plan actuel en cours d'exécution, basé sur l'état courant des agents
- **Mémoire glissante (cette évolution)** : donne au planner un contexte des exécutions passées quand il planifie une nouvelle exécution

Les deux sont complémentaires et n'interfèrent pas :
- `replan()` ne modifie pas les `memories`
- `recordExecution()` n'est appelé qu'à la fin d'une exécution, pas pendant le re-planning
- Le re-planning bénéficie de la mémoire car `analyze()` est aussi appelé par `replan()`, donc les mémoires sont disponibles pour la re-planification si nécessaire

### Cas spécial : re-planning + mémoire

Si le planner est re-consulté pendant une exécution (via `replan()`), il recevra les mémoires des exécutions **précédentes** mais PAS la mémoire de l'exécution en cours (qui n'est pas encore terminée). C'est le comportement souhaité — le re-planning reçoit l'état courant de l'exécution via d'autres canaux (état des agents, erreurs, etc.).

---

## Tests à implémenter

### Tests unitaires pour `TaskPlanner`

#### Test 1 : `recordExecution` crée une mémoire correcte

- Setup : créer un planner
- Appeler `recordExecution(task, analysis, results)` avec des données valides
- Assert : `memoryCount` retourne 1
- Assert : `getMemories()[0]` contient les bonnes valeurs
- Assert : `task` est tronqué à 200 chars
- Assert : `roles` contient les rôles de tous les subtasks
- Assert : `outcome` contient le ratio succès/total
- Assert : `filesAffected` contient les fichiers écrits (dédupliqués)

#### Test 2 : `recordExecution` respecte `MAX_MEMORY_ENTRIES`

- Appeler `recordExecution` 5 fois (MAX = 3)
- Assert : `memoryCount` retourne 3
- Assert : les 3 mémoires sont les 3 plus récentes (les 2 premières ont été évincées)
- Assert : `getMemories()[0].task` correspond à la 3ème exécution (pas la 1ère)

#### Test 3 : `clearMemory` vide toutes les mémoires

- Enregistrer 3 exécutions
- Appeler `clearMemory()`
- Assert : `memoryCount` retourne 0
- Assert : `getMemories()` retourne un tableau vide

#### Test 4 : `buildMemoryContext` retourne `null` sans mémoires

- Assert : `buildMemoryContext()` retourne `null` quand `memories` est vide

#### Test 5 : `buildMemoryContext` formate les mémoires correctement

- Enregistrer 2 exécutions
- Appeler `buildMemoryContext()` (exposer via un helper de test ou accéder via le prompt)
- Assert : le résultat contient `"### Execution 1"` et `"### Execution 2"`
- Assert : le résultat contient la task, la strategy, l'outcome de chaque mémoire
- Assert : le résultat contient les fichiers affectés
- Assert : le résultat contient les leçons apprises

#### Test 6 : `analyze` injecte les mémoires dans le prompt

- Mocker `ConversationManager.sendJson()` pour capturer le prompt envoyé
- Enregistrer 1 exécution passée
- Appeler `analyze("New task")`
- Assert : le prompt capturé contient `"## Previous Execution Context"`
- Assert : le prompt capturé contient la task de la mémoire
- Assert : le prompt capturé contient les leçons

#### Test 7 : `analyze` n'injecte PAS de mémoires au premier appel

- Ne pas enregistrer d'exécution
- Mocker `ConversationManager.sendJson()` pour capturer le prompt
- Appeler `analyze("First task")`
- Assert : le prompt ne contient PAS `"## Previous Execution Context"`

#### Test 8 : `analyze` reset toujours la conversation mais préserve les mémoires

- Enregistrer 2 exécutions
- Appeler `analyze("Task A")`
- Assert : la conversation est resetée (nouveau contexte, pas d'historique de la précédente analyse)
- Assert : `memoryCount` est toujours 2 (les mémoires ne sont pas affectées par le reset)
- Appeler `analyze("Task B")`
- Assert : le prompt de Task B contient les mêmes 2 mémoires

#### Test 9 : `recordExecution` gère les exécutions échouées

- Enregistrer une exécution où tous les subtasks ont échoué
- Assert : `outcome` contient `"0/2 subtask(s) succeeded"`
- Assert : `lessons` contient des indications sur les échecs
- Assert : `strategy` est correcte

#### Test 10 : `recordExecution` détecte les timeouts dans les leçons

- Enregistrer une exécution avec un subtask ayant échoué avec l'erreur "Timeout: exceeded 60000ms"
- Assert : `lessons` contient `"Timeout"` et le rôle de l'agent qui a timeout

#### Test 11 : `filesAffected` est dédupliqué et limité

- Enregistrer une exécution avec 2 agents qui ont tous les deux écrit `src/index.ts`
- Assert : `filesAffected` contient `src/index.ts` une seule fois
- Enregistrer une exécution avec 20 fichiers uniques
- Assert : `filesAffected.length` ≤ 15

#### Test 12 : Les mémoires survivent entre `analyze()` mais pas entre `destroy()`

- Enregistrer 2 exécutions
- Appeler `analyze("Task A")` → les mémoires sont injectées
- Appeler `analyze("Task B")` → les mêmes mémoires sont injectées + la mémoire de Task A si recordExec a été appelé entre temps
- Appeler `clearMemory()`
- Appeler `analyze("Task C")` → pas de mémoires (prompt sans `## Previous Execution Context`)

### Tests d'intégration

#### Test 13 : `AgentPool.execute()` appelle `recordExecution()` après une exécution réussie

- Mocker l'agent et le planner
- Appeler `pool.execute("Build API")`
- Assert : `planner.recordExecution()` a été appelé
- Assert : les arguments passés correspondent à la tâche, l'analyse et les résultats

#### Test 14 : `AgentPool.execute()` n'appelle PAS `recordExecution()` en cas d'erreur fatale

- Mocker le planner pour qu'il throw une erreur pendant `analyze()`
- Appeler `pool.execute("Failing task")` et catcher l'erreur
- Assert : `planner.recordExecution()` n'a PAS été appelé

#### Test 15 : Les mémoires influencent les décisions de planification sur des follow-up tasks

- Exécuter `pool.execute("Build REST API")` avec succès
- Appeler `pool.execute("Add tests for the API")` (ou via `pool.send()`)
- Capturer le prompt du deuxième `analyze()`
- Assert : le prompt contient les informations de la première exécution
- Assert : le prompt mentionne les fichiers créés par la première exécution

#### Test 16 : `pool.destroy()` clear la mémoire du planner

- Enregistrer des exécutions
- Appeler `pool.destroy()`
- Recréer un pool avec le même planner (si applicable)
- Assert : les mémoires sont vides

#### Test 17 : `pool.getState()` inclut `plannerMemoryCount`

- Exécuter une tâche
- Appeler `pool.getState()`
- Assert : `state.plannerMemoryCount` === 1

#### Test 18 : `pool.clearPlannerMemory()` fonctionne

- Enregistrer 2 exécutions
- Assert : `pool.getState().plannerMemoryCount` === 2
- Appeler `pool.clearPlannerMemory()`
- Assert : `pool.getState().plannerMemoryCount` === 0

### Tests de non-régression

#### Test 19 : La conversation du planner est toujours resetée à chaque `analyze()`

- Enregistrer une exécution
- Appeler `analyze()` → la conversation est resetée
- Assert : l'historique de conversation après `analyze()` ne contient que le system prompt + le dernier échange (pas d'accumulation)

#### Test 20 : Le planner fonctionne identiquement sans mémoires (premier appel)

- Appeler `analyze("Build API")` sans aucune mémoire préalable
- Assert : le comportement est identique à avant cette évolution
- Assert : le prompt ne contient pas de section `## Previous Execution Context`
- Assert : la qualité de l'analyse est inchangée

#### Test 21 : Les retry sémantiques dans `analyze()` fonctionnent avec les mémoires

- Enregistrer une mémoire
- Mocker le LLM pour retourner une analyse avec erreurs sémantiques au premier essai
- Assert : le retry loop fonctionne normalement
- Assert : le correction prompt inclut toujours les mémoires (puisqu'il est basé sur le prompt original qui les contient)

---

## Critères de validation

- [ ] Le type `PlannerMemory` existe dans `agent-pool.types.ts`
- [ ] Le `TaskPlanner` stocke les mémoires dans un tableau interne avec limite `MAX_MEMORY_ENTRIES = 3`
- [ ] `recordExecution()` crée un `PlannerMemory` condensé à partir des résultats d'exécution
- [ ] `recordExecution()` tronque correctement les champs longs (task 200 chars, error 100 chars, files 15 max)
- [ ] `recordExecution()` évince les mémoires les plus anciennes quand `MAX_MEMORY_ENTRIES` est atteint
- [ ] `buildMemoryContext()` retourne `null` quand il n'y a pas de mémoires
- [ ] `buildMemoryContext()` formate les mémoires en sections numérotées avec task, strategy, outcome, files, lessons
- [ ] `analyze()` reset toujours la conversation mais injecte les mémoires dans le prompt via `previousExecutions`
- [ ] Le template `taskAnalysisPrompt` inclut une section conditionnelle `## Previous Execution Context`
- [ ] Le system prompt du planner inclut des instructions sur l'utilisation du contexte des exécutions précédentes
- [ ] `AgentPool.execute()` appelle `recordExecution()` après le summary et le cleanup
- [ ] `AgentPool.execute()` ne reset PAS les mémoires dans le `finally` block
- [ ] `AgentPool.destroy()` clear les mémoires du planner
- [ ] `clearPlannerMemory()` est exposé publiquement sur `AgentPool`
- [ ] `plannerMemoryCount` est exposé dans `AgentPoolState`
- [ ] Les mémoires survivent entre les appels `execute()` mais pas entre `destroy()`
- [ ] L'estimation de tokens ajoutés est ~650-1250 tokens pour 3 mémoires
- [ ] Le comportement sans mémoires (premier appel) est identique à avant cette évolution
- [ ] Les retry sémantiques dans `analyze()` fonctionnent toujours avec les mémoires
- [ ] La détection des timeouts dans les leçons fonctionne
- [ ] `filesAffected` est dédupliqué
- [ ] Tous les tests existants passent toujours
- [ ] Les nouveaux tests couvrent le stockage, le formatage, l'injection, le lifecycle et les edge cases

---

## Points d'attention

1. **Les mémoires vivent dans le `TaskPlanner`, pas dans la conversation** — le reset de conversation (`this.conversations.reset(ConversationRole.PLANNER)`) ne les affecte pas. Les mémoires sont un état interne du planner, indépendant de l'historique de conversation. C'est la clé de l'architecture : la conversation est stateless (resetée à chaque appel), mais le planner a une mémoire à long terme.

2. **Les mémoires sont locales à l'instance de `TaskPlanner`** — si la pool est détruite et recréée, les mémoires sont perdues. Pour une persistance inter-sessions, voir l'évolution 21 (Inter-execution memory). Cette évolution se concentre sur la mémoire **intra-session** (entre plusieurs `execute()` sur la même instance de pool).

3. **`MAX_MEMORY_ENTRIES = 3` est intentionnellement bas** — 3 mémoires suffisent pour donner un contexte de follow-up tout en restant sous contrôle en termes de tokens. Au-delà de 3 exécutions, les premières sont probablement moins pertinentes. Si l'observation montre que plus de mémoires sont utiles, la constante peut être augmentée.

4. **Le `recordExecution()` est appelé DANS le `try` block** — si `generateSummary()` ou `destroyManagedAgents()` échoue, `recordExecution()` ne sera pas appelé. C'est voulu : on ne veut pas enregistrer une mémoire pour une exécution qui a crashé avant de produire des résultats exploitables. Le `catch` block ne devrait pas appeler `recordExecution()` car les résultats sont potentiellement incomplets.

5. **Interaction avec le `ProjectScanner` (évolution 03)** — le scanner et les mémoires sont complémentaires :
   - Le scanner dit « quels fichiers existent actuellement dans le projet »
   - Les mémoires disent « quels fichiers ont été créés par les exécutions précédentes et pourquoi »
   - Ensemble, le planner a une vue beaucoup plus riche du contexte

6. **Les leçons apprises sont heuristiques** — `recordExecution()` génère les leçons programmatiquement (pas via LLM) pour être rapide et gratuit en tokens. Les leçons sont donc un peu génériques (« Multi-agent decomposition worked well ») mais suffisantes pour guider le planner. Dans l'évolution 17 (Post-execution reflection), un LLM pourrait être utilisé pour générer des leçons plus fines.

7. **Le champ `outcome` combine le ratio et les détails** — ex : « 2/3 subtask(s) succeeded. - api-developer: completed - test-writer: completed - docs-writer: failed: timeout ». C'est un format dense mais lisible pour le LLM du planner. Ne pas séparer en champs distincts pour économiser les tokens.

8. **Le timing de `recordExecution()`** — il est appelé après le `destroyManagedAgents()` (qui est parallélisé avec le summary). À ce stade, les agents sont détruits mais les `executionResults` sont déjà collectés. Il n'y a pas de race condition car les résultats sont des données collectées pendant l'exécution, pas des données lues depuis les agents en temps réel.

9. **Impact sur le prompt du planner** — le prompt grandit avec les mémoires. Estimation de la taille du prompt du planner pour un appel typique :
   - System prompt (avec few-shots, évolution 04) : ~1500 tokens
   - User prompt (tâche + contexte projet + mémoires) : ~1000-3000 tokens
   - Total : ~2500-4500 tokens
   
   C'est bien dans les limites d'un modèle 128K tokens. Même avec un modèle 16K, c'est <30% de la fenêtre.

10. **Le `buildMemoryContext()` est une méthode private** — pour les tests, soit exposer via un getter `getMemoryContext()`, soit tester indirectement via le prompt capturé de `analyze()`. La deuxième approche est préférable car elle teste le comportement réel plutôt qu'une méthode interne.

11. **Les erreurs dans `recordExecution()` ne doivent PAS crasher l'exécution** — wraper l'appel dans un try/catch dans `AgentPool.execute()` :
    ```typescript
    try {
        this.planner.recordExecution(task, analysis, executionResults);
    } catch (error) {
        this.logger.warn(
            { error: toErrorMessage(error) },
            "Failed to record planner memory — continuing without",
        );
    }
    ```
    Cela garantit que un bug dans la mémoire n'affecte pas le résultat de l'exécution.

12. **Pas de LLM call dans `recordExecution()`** — toute la construction de mémoire est programmatique. C'est un choix délibéré pour la performance (pas de latence ajoutée, pas de coût de tokens) et la fiabilité (pas de risque d'erreur LLM dans le critical path). L'évolution 17 (Post-execution reflection) ajoutera une réflexion LLM-driven qui pourrait enrichir les mémoires, mais elle sera optionnelle et asynchrone.