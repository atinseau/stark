# Évolution 08 — Injection de contexte structurée et priorisée

## Priorité : 🟡 P2

## Dépendances : Évolution 07 (Full prompt results sharing)

## Acquis des évolutions précédentes

- **Évolution 01** : L'`InformationBroker` reçoit les mappings `subtaskToAgent` / `agentToSubtask` via son constructeur. `isAgentForSubtask()` fonctionne. Le tri des candidats par dépendance est opérationnel. `findDependency()` traduit correctement entre agent IDs et subtask IDs.
- **Évolution 02** : L'`InformationBroker` maintient un `SharingHistory` indexé par agent cible. Le prompt de partage inclut les partages précédents (`previouslyShared`). `recordSharing()` est appelé après chaque injection réussie. Le type `SharingRecord` existe.
- **Évolution 03** : Le `ProjectScanner` scanne le répertoire de travail et produit un `ProjectContext`. Le planner reçoit le contexte projet.
- **Évolution 04** : Tous les prompts LLM contiennent des exemples few-shot contrastifs.
- **Évolution 05** : Le rôle `ConversationRole.SHARING_ANALYZER` existe. Le system prompt `SHARING_ANALYZER` est dédié au partage inter-agents. L'`InformationBroker` utilise `SHARING_ANALYZER`.
- **Évolution 06** : Le notification prompt est nettoyé. Le summary prompt inclut les `CoordinationStats` et `sharingSummaries`. `durationMs` est correctement calculé.
- **Évolution 07** : Le preview dans les deltas `PROMPT_COMPLETE` est augmenté à 2000 chars. Le champ `promptResultSummary` existe dans `ContextDelta`. L'`InformationBroker` dispose de `evaluateWithFullResult()` pour les blocking deps. Le prompt de sharing inclut l'`Extended Response Summary`.

---

## Contexte du problème

Quand l'`InformationBroker` décide de partager de l'information entre agents, le mécanisme d'injection est **brut et non structuré** :

```typescript
// src/classes/agent/agent-context-manager.ts — buildPromptWithContext()
buildPromptWithContext(text: string): string {
    if (this.pending.length === 0) return text;

    const context = this.pending.splice(0);
    const prefix = context.join("\n\n---\n\n");
    return `${prefix}\n\n---\n\nUser request:\n${text}`;
}
```

### Problèmes identifiés

#### 1. Pas de structure dans les injections

Toutes les injections sont traitées de manière identique — simple concaténation de texte avec `---` comme séparateur. L'agent qui reçoit ces injections ne peut pas distinguer :
- Une information critique d'une dépendance blocking (ex: « voici le schema de la base de données que tu dois utiliser »)
- Un contexte informatif optionnel (ex: « l'autre agent a choisi d'utiliser Zod pour la validation »)
- Une instruction de l'utilisateur (ex: « utilise le port 3000 »)

#### 2. Pas de priorisation

Si 3 injections arrivent pendant qu'un agent est `BUSY`, elles sont toutes empilées dans l'ordre d'arrivée (FIFO). Un contexte critique d'une dépendance blocking peut se retrouver **après** un contexte informatif mineur, dilué dans le bruit.

#### 3. Accumulation sans limite

Aucune limite sur la quantité de contexte accumulée. Si 10 partages arrivent pendant qu'un agent travaille sur un long prompt, l'agent recevra un mur de texte de 10 sections concaténées avant sa prochaine instruction. Cela :
- Sature la fenêtre de contexte de l'agent
- Dilue l'attention du LLM agent sur le bruit au lieu de la tâche
- Peut causer des comportements inattendus si le contexte injecté est contradictoire

#### 4. Pas de catégorisation

Le LLM de l'agent ne sait pas d'où vient chaque injection ni pourquoi elle est là. Il ne peut pas prioriser entre « information critique pour ta tâche » et « contexte de fond informatif ».

#### 5. Pas de résumé en cas de surcharge

Quand trop de contexte s'accumule, il n'y a aucun mécanisme de condensation. Le tout est envoyé brut.

---

## Fichiers impactés

| Fichier | Action |
|---------|--------|
| `src/classes/agent/agent-context-manager.ts` | Refactorer pour supporter les injections structurées |
| `src/types/agent-pool.types.ts` | Ajouter le type `StructuredContextInjection` |
| `src/classes/agent-pool/agent-pool.ts` | Utiliser les injections structurées lors du partage |
| `src/classes/agent/agent.ts` | Adapter `injectContext()` pour supporter la nouvelle structure |
| `src/classes/agent-pool/tests/` | Tests unitaires |

---

## Spécification détaillée des changements

### 1. Nouveau type `StructuredContextInjection` dans `agent-pool.types.ts`

```typescript
/**
 * Priority levels for context injections.
 *
 * Determines the order in which injections are presented to the agent
 * when multiple are pending. Higher priority = presented first.
 */
export enum ContextInjectionPriority {
    /** Critical information the agent cannot proceed correctly without.
     *  Typically from blocking dependencies. */
    CRITICAL = "critical",

    /** Important information that significantly improves the agent's output.
     *  Typically from informational dependencies or significant sharing decisions. */
    HIGH = "high",

    /** Supplementary context that may be useful but is not essential.
     *  Typically from non-dependent agents or routine observations. */
    NORMAL = "normal",

    /** Background information provided for awareness only.
     *  Will be dropped first if the queue is overloaded. */
    LOW = "low",
}

/**
 * A categorized, prioritized instruction injected into an agent's context.
 *
 * Unlike raw string injections, structured injections carry metadata
 * that allows the AgentContextManager to:
 * - Present them in priority order (CRITICAL first)
 * - Format them with clear source attribution
 * - Limit accumulation per priority level
 * - Drop low-priority injections when the queue is overloaded
 */
export interface StructuredContextInjection {
    /** The raw instruction text to inject. */
    readonly content: string;

    /** Priority level for ordering and overflow management. */
    readonly priority: ContextInjectionPriority;

    /**
     * Category describing the nature of this injection.
     * Used for formatting the injection header in the agent's prompt.
     */
    readonly category: ContextInjectionCategory;

    /** Human-readable source label (e.g., "api-developer", "user"). */
    readonly source: string;

    /**
     * Optional dependency type if this injection comes from a dependency.
     * `null` for user-injected context or non-dependency sharing.
     */
    readonly dependencyType: "blocking" | "informational" | null;

    /** ISO-8601 timestamp when the injection was created. */
    readonly timestamp: string;
}

/**
 * Categories of context injections.
 * Used to format clear headers in the injected prompt.
 */
export enum ContextInjectionCategory {
    /** Output from a dependent agent that this agent needs. */
    DEPENDENCY_OUTPUT = "dependency_output",

    /** Information shared from another agent working on a related task. */
    SHARED_CONTEXT = "shared_context",

    /** Additional instructions or constraints from the user. */
    USER_INSTRUCTION = "user_instruction",

    /** Error or conflict information from the coordination system. */
    COORDINATION_ALERT = "coordination_alert",
}
```

### 2. Refactorer `AgentContextManager`

Remplacer la queue simple de strings par une queue structurée :

```typescript
import type {
    ContextInjectionPriority,
    StructuredContextInjection,
} from "../../types/agent-pool.types.ts";
import { isoNow } from "../../utils/formatting.ts";

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Maximum number of pending injections before overflow management kicks in.
 * When exceeded, LOW priority injections are dropped first, then NORMAL.
 */
const MAX_PENDING_INJECTIONS = 15;

/**
 * Maximum total character count of all pending injections combined.
 * When exceeded, the oldest LOW priority injections are dropped.
 */
const MAX_PENDING_CHARS = 15000;

/**
 * Priority ordering — lower number = presented first in the prompt.
 */
const PRIORITY_ORDER: Record<string, number> = {
    critical: 0,
    high: 1,
    normal: 2,
    low: 3,
};

/**
 * Headers for each injection category, used in the formatted prompt.
 */
const CATEGORY_HEADERS: Record<string, string> = {
    dependency_output: "📦 DEPENDENCY OUTPUT",
    shared_context: "🔗 SHARED CONTEXT",
    user_instruction: "👤 USER INSTRUCTION",
    coordination_alert: "⚠️ COORDINATION ALERT",
};

// ── AgentContextManager ────────────────────────────────────────────────────

export class AgentContextManager {
    /** Structured injection queue, ordered by arrival time. */
    private readonly pending: StructuredContextInjection[] = [];

    /** Legacy string injection queue for backward compatibility. */
    private readonly pendingLegacy: string[] = [];

    // ── Query ──────────────────────────────────────────────────────────

    /** Returns `true` if there are queued instructions waiting to be sent. */
    hasPending(): boolean {
        return this.pending.length > 0 || this.pendingLegacy.length > 0;
    }

    /** Number of instructions currently queued (both structured and legacy). */
    get pendingCount(): number {
        return this.pending.length + this.pendingLegacy.length;
    }

    // ── Mutation (structured) ──────────────────────────────────────────

    /**
     * Pushes a structured injection onto the pending queue.
     *
     * If the queue exceeds MAX_PENDING_INJECTIONS or MAX_PENDING_CHARS,
     * the lowest-priority and oldest injections are dropped to make room.
     *
     * @param injection - The structured injection to enqueue.
     */
    injectStructured(injection: StructuredContextInjection): void {
        this.pending.push(injection);
        this.enforceQueueLimits();
    }

    // ── Mutation (legacy — backward compatible) ────────────────────────

    /**
     * Pushes raw string instructions onto the pending queue.
     * Maintained for backward compatibility with `agent.injectContext(string)`.
     *
     * @param instructions - The instruction text to enqueue.
     */
    inject(instructions: string): void {
        this.pendingLegacy.push(instructions);
    }

    // ── Drain ──────────────────────────────────────────────────────────

    /**
     * Drains all pending instructions (both structured and legacy)
     * and returns them merged into a single formatted string.
     *
     * Structured injections are sorted by priority (CRITICAL first)
     * and formatted with category headers and source attribution.
     *
     * Legacy string injections are appended after structured ones
     * with a generic header.
     *
     * If the queue is empty, returns `null`.
     *
     * @returns The merged, formatted instruction string, or `null`.
     */
    drain(): string | null {
        if (!this.hasPending()) return null;

        const sections: string[] = [];

        // 1. Drain structured injections (sorted by priority)
        if (this.pending.length > 0) {
            const sorted = this.pending
                .splice(0)
                .sort((a, b) => {
                    const priorityDiff =
                        (PRIORITY_ORDER[a.priority] ?? 3) -
                        (PRIORITY_ORDER[b.priority] ?? 3);
                    if (priorityDiff !== 0) return priorityDiff;
                    // Same priority — maintain insertion order (already sorted by timestamp)
                    return 0;
                });

            for (const injection of sorted) {
                sections.push(this.formatInjection(injection));
            }
        }

        // 2. Drain legacy string injections
        if (this.pendingLegacy.length > 0) {
            const legacyItems = this.pendingLegacy.splice(0);
            for (const item of legacyItems) {
                sections.push(`--- CONTEXT ---\n${item}`);
            }
        }

        return sections.join("\n\n---\n\n");
    }

    /**
     * Builds the final prompt string by prepending any queued context
     * instructions to the user's prompt text.
     *
     * Structured injections are sorted by priority and formatted with
     * category headers. Legacy injections follow.
     *
     * If no instructions are queued, the original text is returned unchanged.
     * The queue is emptied as a side effect.
     *
     * @param text - The user's original prompt text.
     * @returns The prompt with context prepended, or the original text.
     */
    buildPromptWithContext(text: string): string {
        const context = this.drain();
        if (!context) return text;
        return `${context}\n\n---\n\nUser request:\n${text}`;
    }

    // ── Private ────────────────────────────────────────────────────────

    /**
     * Formats a single structured injection into a prompt-ready string.
     *
     * Output format:
     * ```
     * [📦 DEPENDENCY OUTPUT from api-developer | priority: CRITICAL | blocking dependency]
     * <content here>
     * ```
     */
    private formatInjection(injection: StructuredContextInjection): string {
        const header = CATEGORY_HEADERS[injection.category] ?? "CONTEXT";
        const priorityLabel = injection.priority.toUpperCase();
        const depLabel = injection.dependencyType
            ? ` | ${injection.dependencyType} dependency`
            : "";

        return (
            `[${header} from ${injection.source} | priority: ${priorityLabel}${depLabel}]\n` +
            injection.content
        );
    }

    /**
     * Enforces queue limits by dropping low-priority injections when
     * the queue exceeds MAX_PENDING_INJECTIONS or MAX_PENDING_CHARS.
     *
     * Drop strategy:
     * 1. Drop LOW priority injections (oldest first)
     * 2. If still over limit, drop NORMAL priority injections (oldest first)
     * 3. Never drop HIGH or CRITICAL injections
     *
     * This ensures that critical information from blocking dependencies
     * is never lost, even when the queue is saturated.
     */
    private enforceQueueLimits(): void {
        // Check count limit
        while (this.pending.length > MAX_PENDING_INJECTIONS) {
            if (!this.dropLowestPriority()) break;
        }

        // Check character limit
        while (this.totalPendingChars() > MAX_PENDING_CHARS) {
            if (!this.dropLowestPriority()) break;
        }
    }

    /**
     * Drops the oldest injection with the lowest droppable priority.
     * Returns true if an injection was dropped, false if nothing can be dropped.
     */
    private dropLowestPriority(): boolean {
        // Try to drop LOW first
        const lowIdx = this.pending.findIndex(
            (i) => i.priority === "low"
        );
        if (lowIdx !== -1) {
            this.pending.splice(lowIdx, 1);
            return true;
        }

        // Then NORMAL
        const normalIdx = this.pending.findIndex(
            (i) => i.priority === "normal"
        );
        if (normalIdx !== -1) {
            this.pending.splice(normalIdx, 1);
            return true;
        }

        // HIGH and CRITICAL are never dropped
        return false;
    }

    /**
     * Returns the total character count of all pending structured injections.
     */
    private totalPendingChars(): number {
        let total = 0;
        for (const injection of this.pending) {
            total += injection.content.length;
        }
        return total;
    }
}
```

### 3. Adapter `Agent.injectContext()` pour supporter les deux modes

Dans `src/classes/agent/agent.ts`, modifier `injectContext()` pour supporter à la fois les injections string (backward compatible) et structurées :

```typescript
/**
 * Injects new instructions into the agent's context.
 *
 * Accepts either a raw string (backward compatible) or a
 * StructuredContextInjection (for prioritized, categorized injections).
 *
 * @param instructions - The instructions to inject (string or structured).
 */
injectContext(instructions: string | StructuredContextInjection): void {
    if (this._status === AgentStatus.DESTROYED) {
        throw new Error(`Agent "${this.name}" (${this.id}) has been destroyed`);
    }

    const queued = this._status === AgentStatus.BUSY;

    if (typeof instructions === "string") {
        // Legacy mode — backward compatible
        this.logger.info(
            { queued },
            `Context injected (legacy): ${truncate(instructions, 100)}`,
        );

        this.emitTyped(AgentEvent.CONTEXT_INJECTED, {
            instructions,
            queued,
        });

        this.contextManager.inject(instructions);
    } else {
        // Structured mode — prioritized and categorized
        this.logger.info(
            {
                queued,
                priority: instructions.priority,
                category: instructions.category,
                source: instructions.source,
            },
            `Context injected (structured, ${instructions.priority}): ${truncate(instructions.content, 100)}`,
        );

        this.emitTyped(AgentEvent.CONTEXT_INJECTED, {
            instructions: instructions.content,
            queued,
            structured: true,
            priority: instructions.priority,
            category: instructions.category,
        });

        this.contextManager.injectStructured(instructions);
    }

    if (!queued) {
        void this.drainPendingContext();
    }
}
```

**Note** : L'interface `PoolManagedAgent` dans `agent-pool.types.ts` définit `injectContext(instructions: string): void`. Il faudra la mettre à jour pour supporter le type union :

```typescript
export interface PoolManagedAgent {
    // ... existing fields ...
    injectContext(instructions: string | StructuredContextInjection): void;
    // ... existing fields ...
}
```

### 4. Utiliser les injections structurées dans `AgentPool.handleDelta()`

Dans `src/classes/agent-pool/agent-pool.ts`, quand un partage est approuvé et injecté, utiliser le mode structuré :

```typescript
// Dans handleDelta(), quand shouldShare est true
if (decision.shouldShare) {
    const targetEntry = this.managedAgents.get(decision.targetAgentId);

    if (
        targetEntry &&
        targetEntry.agent.status !== AgentStatus.DESTROYED
    ) {
        try {
            // Determine the dependency type between source and target
            const sourceSubtaskId = this.agentToSubtask.get(decision.sourceAgentId);
            const targetSubtaskId = this.agentToSubtask.get(decision.targetAgentId);

            let depType: "blocking" | "informational" | null = null;
            if (sourceSubtaskId && targetSubtaskId) {
                const dep = this.informationBroker?.findDependencyBySubtaskIds?.(
                    sourceSubtaskId,
                    targetSubtaskId,
                );
                depType = dep?.type ?? null;
            }

            // Determine priority based on dependency type and delta significance
            let priority: ContextInjectionPriority;
            if (depType === "blocking") {
                priority = ContextInjectionPriority.CRITICAL;
            } else if (depType === "informational") {
                priority = ContextInjectionPriority.HIGH;
            } else if (delta.significance >= 0.8) {
                priority = ContextInjectionPriority.HIGH;
            } else {
                priority = ContextInjectionPriority.NORMAL;
            }

            // Determine category
            const category = depType
                ? ContextInjectionCategory.DEPENDENCY_OUTPUT
                : ContextInjectionCategory.SHARED_CONTEXT;

            // Get source agent name
            const sourceEntry = this.managedAgents.get(decision.sourceAgentId);
            const sourceName = sourceEntry?.agent.name ?? decision.sourceAgentId;

            // Inject as structured context
            const injection: StructuredContextInjection = {
                content: decision.information,
                priority,
                category,
                source: sourceName,
                dependencyType: depType,
                timestamp: isoNow(),
            };

            targetEntry.agent.injectContext(injection);

            // Record sharing for deduplication (evolution 02)
            this.informationBroker?.recordSharing(decision, delta.type);

            this.emitPoolEvent(PoolEvent.CONTEXT_SHARED, {
                sourceAgentId: decision.sourceAgentId,
                targetAgentId: decision.targetAgentId,
                information: decision.information,
            });

            this.logger.info(
                {
                    sourceAgentId: decision.sourceAgentId,
                    targetAgentId: decision.targetAgentId,
                    informationLength: decision.information.length,
                    priority,
                    category,
                },
                "Context shared between agents (structured)",
            );
        } catch (injectError) {
            // ... existing error handling ...
        }
    }
}
```

### 5. Adapter les injections utilisateur (context_injection intent)

Dans `AgentPool.send()`, quand l'intent est `CONTEXT_INJECTION`, utiliser le mode structuré :

```typescript
case UserIntent.CONTEXT_INJECTION: {
    const instructions =
        typeof intent.parameters.instructions === "string"
            ? intent.parameters.instructions
            : message;

    if (this.managedAgents.size === 0) {
        return "No active agents to inject context into.";
    }

    let injectedCount = 0;
    for (const { agent } of this.managedAgents.values()) {
        if (agent.status !== AgentStatus.DESTROYED) {
            try {
                const injection: StructuredContextInjection = {
                    content: instructions,
                    priority: ContextInjectionPriority.HIGH,
                    category: ContextInjectionCategory.USER_INSTRUCTION,
                    source: "user",
                    dependencyType: null,
                    timestamp: isoNow(),
                };
                agent.injectContext(injection);
                injectedCount++;
            } catch {
                // Agent may have been destroyed between check and call
            }
        }
    }

    return `Context injected into ${injectedCount} active agent(s).`;
}
```

### 6. Exposer `findDependencyBySubtaskIds` dans `InformationBroker`

Le `handleDelta` code ci-dessus a besoin de chercher une dépendance entre deux subtask IDs. La méthode `findDependency` existante prend des agent IDs. Ajouter une variante publique qui prend des subtask IDs :

```typescript
/**
 * Finds a dependency between two subtask IDs.
 * Public method for use by the pool orchestrator when building
 * structured injections.
 *
 * @param fromSubtaskId - The source subtask ID.
 * @param toSubtaskId - The target subtask ID.
 * @returns The dependency, or null if none exists.
 */
findDependencyBySubtaskIds(
    fromSubtaskId: string,
    toSubtaskId: string,
): TaskDependency | null {
    return this.dependencies.find(
        (dep) => dep.from === fromSubtaskId && dep.to === toSubtaskId,
    ) ?? null;
}
```

---

## Format de sortie des injections structurées

Quand un agent reçoit des injections structurées, le prompt final ressemblera à :

```
[📦 DEPENDENCY OUTPUT from api-developer | priority: CRITICAL | blocking dependency]
The users API has been implemented in src/routes/users.ts with the following endpoints:
GET /users → returns User[], POST /users → body: {name, email}, returns User, ...

---

[🔗 SHARED CONTEXT from docs-writer | priority: NORMAL]
The documentation uses OpenAPI 3.0 format and is located in docs/openapi.yaml.

---

[👤 USER INSTRUCTION from user | priority: HIGH]
Use port 3000 for the server, not 8080.

---

User request:
Write comprehensive integration tests for the user management REST API.
```

Ce format permet au LLM agent de :
1. **Voir immédiatement les informations critiques** (en premier, avec le header `CRITICAL`)
2. **Comprendre la source et la nature** de chaque injection
3. **Distinguer les instructions utilisateur** du contexte système
4. **Ignorer le contexte de faible priorité** si la fenêtre est saturée

---

## Gestion de l'overflow

### Scénario d'overflow

Si un agent est `BUSY` pendant longtemps et que 20 injections arrivent :

1. Les injections `LOW` sont droppées en premier (les plus anciennes d'abord)
2. Puis les injections `NORMAL` si le count/chars dépasse encore les limites
3. Les injections `HIGH` et `CRITICAL` ne sont **jamais** droppées

### Limites configurées

| Limite | Valeur | Justification |
|--------|--------|---------------|
| `MAX_PENDING_INJECTIONS` | 15 | Empêche l'accumulation de trop de sections distinctes |
| `MAX_PENDING_CHARS` | 15000 | ~3750 tokens — environ 25% d'une fenêtre de 16K tokens |

### Logging des drops

Quand une injection est droppée, un log `warn` est émis pour la traçabilité :

```typescript
private dropLowestPriority(): boolean {
    // ... existing logic ...
    if (lowIdx !== -1) {
        const dropped = this.pending.splice(lowIdx, 1)[0];
        // Note: le ContextManager n'a pas de logger.
        // Le logging sera fait au niveau de l'Agent si nécessaire.
        return true;
    }
    // ...
}
```

**Note** : L'`AgentContextManager` est une classe pure sans dépendances (pas de logger, pas d'events). Le logging des drops devrait être fait au niveau de l'`Agent` qui appelle `injectStructured()`. Alternativement, `enforceQueueLimits()` peut retourner le nombre d'injections droppées :

```typescript
/**
 * Enforces queue limits and returns the number of injections dropped.
 */
private enforceQueueLimits(): number {
    let dropped = 0;

    while (this.pending.length > MAX_PENDING_INJECTIONS) {
        if (!this.dropLowestPriority()) break;
        dropped++;
    }

    while (this.totalPendingChars() > MAX_PENDING_CHARS) {
        if (!this.dropLowestPriority()) break;
        dropped++;
    }

    return dropped;
}
```

Et dans `injectStructured()` :

```typescript
injectStructured(injection: StructuredContextInjection): { dropped: number } {
    this.pending.push(injection);
    const dropped = this.enforceQueueLimits();
    return { dropped };
}
```

L'`Agent` peut alors logger si `dropped > 0`.

---

## Tests à implémenter

### Tests unitaires pour `AgentContextManager`

#### Test 1 : `injectStructured` ajoute une injection structurée

- Créer un manager, appeler `injectStructured()` avec une injection `CRITICAL`
- Assert : `hasPending()` retourne `true`
- Assert : `pendingCount` retourne 1

#### Test 2 : `drain()` formate les injections structurées avec les bons headers

- Injecter 2 injections :
  - `CRITICAL`, `DEPENDENCY_OUTPUT`, source `"api-dev"`
  - `NORMAL`, `SHARED_CONTEXT`, source `"doc-writer"`
- Appeler `drain()`
- Assert : le résultat contient `"📦 DEPENDENCY OUTPUT from api-dev | priority: CRITICAL"`
- Assert : le résultat contient `"🔗 SHARED CONTEXT from doc-writer | priority: NORMAL"`
- Assert : l'injection CRITICAL apparaît AVANT l'injection NORMAL

#### Test 3 : `drain()` trie par priorité (CRITICAL > HIGH > NORMAL > LOW)

- Injecter 4 injections dans l'ordre LOW, NORMAL, CRITICAL, HIGH
- Appeler `drain()`
- Assert : l'ordre dans le résultat est CRITICAL, HIGH, NORMAL, LOW

#### Test 4 : `drain()` mélange structured et legacy

- Injecter 1 injection structurée et 1 injection legacy
- Appeler `drain()`
- Assert : le résultat contient le header structuré
- Assert : le résultat contient `"--- CONTEXT ---"` pour le legacy
- Assert : les structurés sont AVANT les legacy

#### Test 5 : `buildPromptWithContext()` prépend le contexte structuré au texte

- Injecter 1 injection structurée CRITICAL
- Appeler `buildPromptWithContext("Write tests")`
- Assert : le résultat commence par le header structuré
- Assert : le résultat se termine par `"User request:\nWrite tests"`
- Assert : les deux parties sont séparées par `"---"`

#### Test 6 : `buildPromptWithContext()` retourne le texte inchangé sans injections

- Ne rien injecter
- Appeler `buildPromptWithContext("Write tests")`
- Assert : le résultat est exactement `"Write tests"`

#### Test 7 : `enforceQueueLimits` droppe les LOW priority en premier

- Injecter `MAX_PENDING_INJECTIONS + 2` injections de priorité LOW
- Assert : `pendingCount` === `MAX_PENDING_INJECTIONS`
- Assert : les 2 plus anciennes LOW ont été supprimées

#### Test 8 : `enforceQueueLimits` droppe NORMAL si pas de LOW

- Injecter `MAX_PENDING_INJECTIONS + 1` injections de priorité NORMAL (aucune LOW)
- Assert : `pendingCount` === `MAX_PENDING_INJECTIONS`
- Assert : la plus ancienne NORMAL a été supprimée

#### Test 9 : `enforceQueueLimits` ne droppe JAMAIS CRITICAL ou HIGH

- Injecter `MAX_PENDING_INJECTIONS + 5` injections toutes en CRITICAL
- Assert : `pendingCount` === `MAX_PENDING_INJECTIONS + 5` (rien n'est droppé)
- Assert : toutes les injections CRITICAL sont préservées

#### Test 10 : `enforceQueueLimits` respecte `MAX_PENDING_CHARS`

- Injecter 3 injections LOW de 6000 chars chacune (total 18000 > MAX_PENDING_CHARS)
- Assert : au moins 1 injection LOW a été droppée
- Assert : `totalPendingChars()` ≤ `MAX_PENDING_CHARS`

#### Test 11 : `drain()` vide la queue

- Injecter 3 injections
- Appeler `drain()`
- Assert : `hasPending()` retourne `false`
- Assert : `pendingCount` retourne 0

#### Test 12 : `drain()` retourne `null` quand la queue est vide

- Ne rien injecter
- Assert : `drain()` retourne `null`

#### Test 13 : Le format d'injection inclut le dependency type quand présent

- Injecter une injection avec `dependencyType: "blocking"`
- Appeler `drain()`
- Assert : le résultat contient `"blocking dependency"`

#### Test 14 : Le format d'injection omet le dependency type quand null

- Injecter une injection avec `dependencyType: null`
- Appeler `drain()`
- Assert : le résultat ne contient PAS `"dependency"`

### Tests d'intégration

#### Test 15 : `Agent.injectContext()` accepte les deux modes

- Appeler `agent.injectContext("raw string")` → pas d'erreur
- Appeler `agent.injectContext({ content: "...", priority: "critical", ... })` → pas d'erreur
- Assert : les deux modes ajoutent à la queue et émettent `CONTEXT_INJECTED`

#### Test 16 : `AgentPool.handleDelta()` injecte en mode structuré

- Mocker l'agent target et le broker
- Simuler un partage approuvé avec une dépendance blocking
- Assert : `agent.injectContext()` est appelé avec un objet `StructuredContextInjection`
- Assert : la `priority` est `CRITICAL` (car blocking dep)
- Assert : la `category` est `DEPENDENCY_OUTPUT`

#### Test 17 : `AgentPool.handleDelta()` injecte en HIGH pour les informational deps

- Simuler un partage approuvé avec une dépendance informational
- Assert : la `priority` est `HIGH`
- Assert : la `category` est `DEPENDENCY_OUTPUT`

#### Test 18 : `AgentPool.handleDelta()` injecte en NORMAL sans dépendance

- Simuler un partage approuvé sans dépendance entre les agents
- Assert : la `priority` est `NORMAL`
- Assert : la `category` est `SHARED_CONTEXT`

#### Test 19 : `AgentPool.send()` avec CONTEXT_INJECTION utilise le mode structuré

- Simuler `pool.send("Use port 3000")` quand des agents sont actifs
- Assert : `agent.injectContext()` est appelé avec un objet structuré
- Assert : la `priority` est `HIGH`
- Assert : la `category` est `USER_INSTRUCTION`
- Assert : le `source` est `"user"`

#### Test 20 : L'overflow logging fonctionne dans l'Agent

- Injecter `MAX_PENDING_INJECTIONS + 5` injections LOW dans un agent
- Assert : le logger de l'agent émet au moins un warning pour les injections droppées

### Tests de non-régression

#### Test 21 : Les appels legacy `agent.injectContext(string)` fonctionnent inchangés

- Appeler `agent.injectContext("Do X")` (raw string, pas d'objet structuré)
- Assert : le contexte est correctement ajouté à la queue legacy
- Assert : `buildPromptWithContext("Task")` produit `"--- CONTEXT ---\nDo X\n\n---\n\nUser request:\nTask"`

#### Test 22 : Le `drain()` interagit correctement avec `buildPromptWithContext()`

- Injecter des injections structurées + legacy
- Appeler `buildPromptWithContext("Task")`
- Assert : le résultat contient les deux types dans le bon ordre
- Appeler `buildPromptWithContext("Task")` à nouveau
- Assert : le résultat est exactement `"Task"` (queue vide, rien à prépend)

---

## Critères de validation

- [ ] Le type `StructuredContextInjection` existe dans `agent-pool.types.ts`
- [ ] L'enum `ContextInjectionPriority` existe avec les valeurs `CRITICAL`, `HIGH`, `NORMAL`, `LOW`
- [ ] L'enum `ContextInjectionCategory` existe avec les valeurs `DEPENDENCY_OUTPUT`, `SHARED_CONTEXT`, `USER_INSTRUCTION`, `COORDINATION_ALERT`
- [ ] `AgentContextManager` supporte les injections structurées via `injectStructured()`
- [ ] `AgentContextManager` maintient la backward compatibility via `inject(string)`
- [ ] `drain()` trie les injections par priorité (CRITICAL first)
- [ ] `drain()` formate les injections avec des headers catégorisés et des labels de source
- [ ] `drain()` inclut les legacy injections après les structurées
- [ ] `enforceQueueLimits()` droppe les LOW d'abord, puis les NORMAL
- [ ] `enforceQueueLimits()` ne droppe JAMAIS les CRITICAL ou HIGH
- [ ] `MAX_PENDING_INJECTIONS` et `MAX_PENDING_CHARS` sont respectés
- [ ] `Agent.injectContext()` accepte `string | StructuredContextInjection`
- [ ] `PoolManagedAgent.injectContext()` accepte `string | StructuredContextInjection`
- [ ] `AgentPool.handleDelta()` utilise les injections structurées avec priority/category correctes
- [ ] Les injections de blocking deps ont priority `CRITICAL`
- [ ] Les injections informational deps ont priority `HIGH`
- [ ] Les injections sans dépendance ont priority `NORMAL`
- [ ] Les injections utilisateur (CONTEXT_INJECTION intent) ont priority `HIGH` et category `USER_INSTRUCTION`
- [ ] La méthode `findDependencyBySubtaskIds()` existe dans `InformationBroker`
- [ ] Tous les tests existants passent toujours (backward compatibility)
- [ ] Les nouveaux tests couvrent le tri, le formatting, l'overflow, et les deux modes d'injection

---

## Points d'attention

1. **Backward compatibility est critique** — `Agent.injectContext(string)` doit continuer à fonctionner exactement comme avant pour tout code externe qui l'utilise. Le mode structuré est un ajout, pas un remplacement. Les tests legacy doivent produire le même output qu'avant.

2. **Le `ContextManager` est une classe pure** — pas de logger, pas d'events, pas de side effects. Le logging des drops doit être fait au niveau de l'`Agent` qui appelle `injectStructured()`. Le manager retourne le nombre de drops comme feedback.

3. **Les emojis dans les headers** (`📦`, `🔗`, `👤`, `⚠️`) sont intentionnels — ils servent de repères visuels pour le LLM agent qui traite le prompt. Les LLM modernes traitent les emojis correctement et ils aident à structurer visuellement le prompt. Si des problèmes d'encoding surviennent, ils peuvent être remplacés par des tags textuels (`[DEPENDENCY]`, `[SHARED]`, etc.).

4. **Le `timestamp` dans `StructuredContextInjection`** n'est pas affiché dans le prompt formaté — il est stocké pour le debugging et l'éventuelle gestion future de l'expiration des injections. Ne pas l'inclure dans le output de `formatInjection()` pour économiser des tokens.

5. **Le `COORDINATION_ALERT` category** est défini mais pas encore utilisé — il sera utilisé dans l'évolution 18 (Conflict detection). Le définir maintenant évite de modifier le type plus tard.

6. **Le `findDependencyBySubtaskIds`** expose publiquement une recherche qui était interne au broker. C'est nécessaire car la pool a besoin de cette info pour déterminer la priority. Alternativement, le broker pourrait retourner le dependency type dans la `SharingDecision` (ajouter un champ `dependencyType` à `SharingDecision`), ce qui serait plus propre mais touche plus de code. Choisir l'approche la plus simple pour cette évolution.

7. **L'interface `PoolManagedAgent`** doit être mise à jour pour accepter le type union — c'est un changement de type qui peut impacter les tests existants qui mockent cette interface. S'assurer que les mocks sont mis à jour.

8. **Impact sur l'évolution 02 (deduplication)** — le `recordSharing()` est toujours appelé après injection réussie. Le changement de mode d'injection (structured vs legacy) n'affecte pas la déduplication qui opère au niveau du broker, pas du manager de contexte.

9. **Impact sur l'évolution 07 (full prompt results)** — les résultats enrichis de prompt sont toujours passés dans `decision.information`. Le changement est dans comment cette information est **emballée** avant injection (structurée vs brute). Le contenu textuel est le même.

10. **Les constantes `MAX_PENDING_INJECTIONS` et `MAX_PENDING_CHARS`** sont des valeurs initiales conservatrices. Elles peuvent être ajustées en fonction de l'observation en production. Dans le futur, elles pourraient être configurables via `AgentConfig` ou `AgentPoolConfig`.

11. **Les injections droppées sont perdues définitivement** — il n'y a pas de mécanisme de récupération. Si une injection LOW est droppée parce que la queue est pleine, l'information est perdue pour cet agent. C'est acceptable car les injections LOW sont par définition non-essentielles. Si la perte d'information est critique, le LLM de sharing devrait utiliser une priorité plus élevée.