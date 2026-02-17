# Évolution 09 — Seuil de significance adaptatif selon le contexte

## Priorité : 🟡 P2

## Dépendances : Évolution 01 (Fix agent-subtask mapping)

## Acquis des évolutions précédentes

- **Évolution 01** : L'`InformationBroker` reçoit les mappings `subtaskToAgent` / `agentToSubtask` via son constructeur. `isAgentForSubtask()` fonctionne. Le tri des candidats par dépendance est opérationnel. `findDependency()` traduit correctement entre agent IDs et subtask IDs.
- **Évolution 02** : L'`InformationBroker` maintient un `SharingHistory` indexé par agent cible. Le prompt de partage inclut les partages précédents (`previouslyShared`). `recordSharing()` est appelé après chaque injection réussie. Le type `SharingRecord` existe.
- **Évolution 03** : Le `ProjectScanner` scanne le répertoire de travail et produit un `ProjectContext`. Le planner reçoit le contexte projet.
- **Évolution 04** : Tous les prompts LLM contiennent des exemples few-shot contrastifs.
- **Évolution 05** : Le rôle `ConversationRole.SHARING_ANALYZER` existe. Le system prompt `SHARING_ANALYZER` est dédié au partage inter-agents. L'`InformationBroker` utilise `SHARING_ANALYZER`.
- **Évolution 06** : Le notification prompt est nettoyé. Le summary prompt inclut les `CoordinationStats` et `sharingSummaries`. `durationMs` est correctement calculé.
- **Évolution 07** : Le preview dans les deltas `PROMPT_COMPLETE` est augmenté à 2000 chars. Le champ `promptResultSummary` existe dans `ContextDelta`. L'`InformationBroker` dispose de `evaluateWithFullResult()` pour les blocking deps.
- **Évolution 08** : Les injections de contexte sont structurées avec `StructuredContextInjection` (priorité, catégorie, source). Le `AgentContextManager` trie par priorité, droppe les LOW en cas d'overflow, et formate avec des headers catégorisés. `findDependencyBySubtaskIds()` est exposé publiquement dans l'`InformationBroker`.

---

## Contexte du problème

L'`InformationBroker` utilise un **seuil de significance statique** pour décider quels deltas valent la peine d'être évalués par le LLM pour le partage :

```typescript
// src/classes/agent-pool/information-broker.ts — constructeur
this.significanceThreshold = options?.significanceThreshold ?? 0.6;
```

```typescript
// src/classes/agent-pool/information-broker.ts — evaluate()
if (delta.significance < this.significanceThreshold) {
    this.logger.debug(
        { ... },
        "Delta below significance threshold, skipping sharing evaluation",
    );
    return [];
}
```

### Problèmes identifiés

#### 1. Les `TOOL_COMPLETE` sont systématiquement ignorés

Les événements `TOOL_COMPLETE` ont une significance fixe de **0.5** (définie dans `context-tracker.ts`), ce qui est **en dessous** du seuil par défaut de **0.6** :

```typescript
// src/classes/agent-pool/context-tracker.ts — EVENT_SIGNIFICANCE
[AgentEvent.TOOL_COMPLETE, { deltaType: DeltaType.TOOL_COMPLETE, significance: 0.5 }],
```

Résultat : **aucun** `TOOL_COMPLETE` n'est jamais évalué pour le partage. Pourtant, un outil qui échoue avec un test rouge (`exitCode: 1`) ou qui produit un output critique (ex: résultat d'une commande `curl` vers une API tierce) peut être extrêmement pertinent pour les autres agents.

#### 2. Les `PLAN_UPDATE` sont à la limite

Les `PLAN_UPDATE` ont une significance de **0.6**, pile sur le seuil. En pratique, certaines mises à jour de plan sont triviales (ajout d'une étape mineure) tandis que d'autres sont critiques (restructuration complète du plan). Le seuil fixe ne fait pas la distinction.

#### 3. Le seuil ne tient pas compte du contexte d'exécution

- **Début d'exécution** : les agents démarrent et explorent. Même les observations mineures peuvent être utiles aux autres agents pour s'aligner. Le seuil devrait être **plus bas**.
- **Milieu d'exécution** : les agents sont en pleine production. Les partages doivent être focalisés sur les résultats concrets. Le seuil devrait être **normal**.
- **Fin d'exécution** : les agents finissent. Seules les informations critiques (erreurs, résultats finaux) justifient un partage. Le seuil devrait être **plus haut**.

#### 4. Le seuil ne tient pas compte des dépendances

Un delta de significance 0.4 (ex: `FILE_WRITTEN`) d'un agent qui a des dépendances `blocking` vers d'autres agents devrait être évalué — le résultat pourrait débloquer un agent en attente. Avec le seuil fixe, ces deltas sont silencieusement ignorés.

#### 5. Le seuil est le même pour tous les types de delta

`AGENT_BUSY` (significance 0.1) et `TOOL_COMPLETE` (significance 0.5) sont traités de la même manière vis-à-vis du seuil : en dessous → ignoré. Mais la valeur informationnelle d'un `TOOL_COMPLETE` avec un `exitCode: 1` est incomparablement plus élevée qu'un `AGENT_BUSY`.

### Impact mesuré

Avec le seuil actuel de 0.6, seuls 4 types de deltas sur 9 passent le filtre :
- `PROMPT_COMPLETE` (0.8) ✅
- `TOOL_FAILED` (0.9) ✅
- `AGENT_ERROR` (1.0) ✅
- `PLAN_UPDATE` (0.6) ✅ (pile sur le seuil)

Sont exclus :
- `TOOL_COMPLETE` (0.5) ❌ — Potentiellement critique
- `FILE_WRITTEN` (0.5) ❌ — Potentiellement utile pour les agents dépendants
- `STATUS_CHANGE/IDLE` (0.3) ❌ — Acceptable
- `STATUS_CHANGE/BUSY` (0.1) ❌ — Acceptable
- `FILE_READ` (0.2) ❌ — Acceptable

Le problème n'est pas que `TOOL_COMPLETE` et `FILE_WRITTEN` sont toujours importants — c'est qu'ils ne sont **jamais** évalués, même quand le contexte rendrait leur évaluation pertinente.

---

## Fichiers impactés

| Fichier | Action |
|---------|--------|
| `src/classes/agent-pool/information-broker.ts` | Remplacer le seuil fixe par un calcul dynamique |
| `src/classes/agent-pool/context-tracker.ts` | Ajouter un mécanisme de significance contextuelle |
| `src/types/agent-pool.types.ts` | Ajouter le type `SignificanceContext` |
| `src/classes/agent-pool/agent-pool.ts` | Passer le contexte d'exécution au broker |
| `src/classes/agent-pool/tests/` | Tests unitaires |

---

## Spécification détaillée des changements

### 1. Nouveau type `SignificanceContext` dans `agent-pool.types.ts`

```typescript
/**
 * Contextual information used by the InformationBroker to compute
 * dynamic significance thresholds for delta evaluation.
 *
 * The threshold adapts based on the current state of execution,
 * the relationship between agents, and the nature of the delta.
 */
export interface SignificanceContext {
    /** Total number of subtasks in the current execution. */
    readonly totalSubtasks: number;

    /** Number of subtasks that have completed. */
    readonly completedSubtasks: number;

    /** Number of subtasks that have failed. */
    readonly failedSubtasks: number;

    /**
     * Execution phase derived from completion ratio.
     * - "early": 0-30% completion — exploration, alignment phase
     * - "mid": 30-70% completion — active production phase
     * - "late": 70-100% completion — finalization, integration phase
     */
    readonly phase: "early" | "mid" | "late";

    /**
     * Whether the source agent has any blocking dependents
     * (other agents that cannot proceed without its output).
     */
    readonly hasBlockingDependents: boolean;

    /**
     * Whether the source agent has any informational dependents.
     */
    readonly hasInformationalDependents: boolean;

    /**
     * Total number of deltas already processed in this execution.
     * Used to detect "chatty" executions where the threshold should
     * be raised to reduce LLM call volume.
     */
    readonly totalDeltasProcessed: number;
}
```

### 2. Ajouter la méthode `computeThreshold()` dans `InformationBroker`

Remplacer le champ `significanceThreshold` fixe par une méthode de calcul dynamique :

```typescript
// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Base significance threshold — the starting point for dynamic computation.
 * Adjusted up or down based on contextual factors.
 */
const BASE_SIGNIFICANCE_THRESHOLD = 0.5;

/**
 * Absolute minimum threshold — never go below this to avoid
 * evaluating every trivial event (STATUS_CHANGE, FILE_READ, etc.).
 */
const MIN_SIGNIFICANCE_THRESHOLD = 0.2;

/**
 * Absolute maximum threshold — never go above this to ensure
 * critical events (AGENT_ERROR at 1.0) are always evaluated.
 */
const MAX_SIGNIFICANCE_THRESHOLD = 0.85;

/**
 * Threshold reduction for agents with blocking dependents.
 * These agents' output is critical — we evaluate more aggressively.
 */
const BLOCKING_DEPENDENT_REDUCTION = 0.2;

/**
 * Threshold reduction for agents with informational dependents.
 * Less aggressive than blocking, but still reduces the threshold.
 */
const INFORMATIONAL_DEPENDENT_REDUCTION = 0.1;

/**
 * Phase-based threshold adjustments.
 */
const PHASE_ADJUSTMENTS: Record<string, number> = {
    early: -0.1,   // Lower threshold early — more exploration sharing
    mid: 0.0,      // Normal threshold during active work
    late: 0.1,     // Higher threshold late — only critical info
};

/**
 * Number of total deltas after which the "chatty execution" penalty kicks in.
 * Raises the threshold slightly to reduce LLM call volume.
 */
const CHATTY_EXECUTION_DELTA_THRESHOLD = 50;

/**
 * Threshold increase per 50 deltas beyond CHATTY_EXECUTION_DELTA_THRESHOLD.
 * Caps at +0.15 to prevent total suppression.
 */
const CHATTY_PENALTY_PER_BATCH = 0.05;
const MAX_CHATTY_PENALTY = 0.15;
```

```typescript
// ── In InformationBroker class ─────────────────────────────────────────────

/**
 * The execution context used for dynamic threshold computation.
 * Set by the pool orchestrator when the execution state changes.
 * `null` means no context is available — falls back to the base threshold.
 */
private significanceContext: SignificanceContext | null = null;

/**
 * The base threshold provided at construction time.
 * Used as the starting point for dynamic computation.
 */
private readonly baseThreshold: number;

constructor(
    private readonly conversations: ConversationManager,
    private readonly contextTracker: ContextTracker,
    private readonly dependencies: ReadonlyArray<TaskDependency>,
    private readonly logger: pino.Logger,
    private readonly subtaskToAgent: ReadonlyMap<string, string>,
    private readonly agentToSubtask: ReadonlyMap<string, string>,
    options?: {
        /** Override the base significance threshold (default: 0.5). */
        significanceThreshold?: number;
    },
) {
    this.baseThreshold = options?.significanceThreshold ?? BASE_SIGNIFICANCE_THRESHOLD;
}

/**
 * Updates the execution context used for dynamic threshold computation.
 *
 * Called by the pool orchestrator whenever the execution state changes
 * (agent completion, failure, new delta processed, etc.).
 *
 * @param context - The updated significance context.
 */
updateSignificanceContext(context: SignificanceContext): void {
    this.significanceContext = context;
}

/**
 * Computes the effective significance threshold for a given delta,
 * taking into account the current execution context.
 *
 * The computation applies a series of adjustments to the base threshold:
 *
 * 1. **Phase adjustment**: Lower threshold in early execution (more exploration),
 *    higher in late execution (only critical info).
 *
 * 2. **Dependency adjustment**: Lower threshold when the source agent has
 *    blocking or informational dependents — their output is more valuable.
 *
 * 3. **Chatty penalty**: Slightly raise threshold when the execution has
 *    produced an unusually high number of deltas (reduces LLM call volume).
 *
 * 4. **Clamping**: The final threshold is clamped to [MIN, MAX] to prevent
 *    extreme values.
 *
 * If no context is available, falls back to the base threshold.
 *
 * @param delta - The delta to compute the threshold for.
 * @returns The effective significance threshold (0.0 to 1.0).
 */
private computeThreshold(delta: ContextDelta): number {
    if (!this.significanceContext) {
        return this.baseThreshold;
    }

    const ctx = this.significanceContext;
    let threshold = this.baseThreshold;

    // 1. Phase adjustment
    const phaseAdjustment = PHASE_ADJUSTMENTS[ctx.phase] ?? 0;
    threshold += phaseAdjustment;

    // 2. Dependency adjustment — does the source agent have dependents?
    if (ctx.hasBlockingDependents) {
        threshold -= BLOCKING_DEPENDENT_REDUCTION;
    } else if (ctx.hasInformationalDependents) {
        threshold -= INFORMATIONAL_DEPENDENT_REDUCTION;
    }

    // 3. Chatty execution penalty
    if (ctx.totalDeltasProcessed > CHATTY_EXECUTION_DELTA_THRESHOLD) {
        const excessBatches = Math.floor(
            (ctx.totalDeltasProcessed - CHATTY_EXECUTION_DELTA_THRESHOLD) / 50
        );
        const chattyPenalty = Math.min(
            excessBatches * CHATTY_PENALTY_PER_BATCH,
            MAX_CHATTY_PENALTY,
        );
        threshold += chattyPenalty;
    }

    // 4. Clamp to valid range
    threshold = Math.max(MIN_SIGNIFICANCE_THRESHOLD, Math.min(MAX_SIGNIFICANCE_THRESHOLD, threshold));

    // Log the computed threshold if it differs from base
    if (Math.abs(threshold - this.baseThreshold) > 0.01) {
        this.logger.debug(
            {
                baseThreshold: this.baseThreshold,
                effectiveThreshold: threshold,
                phase: ctx.phase,
                hasBlockingDeps: ctx.hasBlockingDependents,
                hasInfoDeps: ctx.hasInformationalDependents,
                totalDeltas: ctx.totalDeltasProcessed,
                deltaType: delta.type,
                deltaSignificance: delta.significance,
            },
            `Dynamic threshold: ${threshold.toFixed(2)} (base: ${this.baseThreshold})`,
        );
    }

    return threshold;
}
```

### 3. Modifier `evaluate()` pour utiliser le seuil dynamique

Dans `src/classes/agent-pool/information-broker.ts`, remplacer la comparaison fixe :

```typescript
// AVANT :
async evaluate(delta: ContextDelta): Promise<SharingDecision[]> {
    if (delta.significance < this.significanceThreshold) {
        this.logger.debug(
            { ... },
            "Delta below significance threshold, skipping sharing evaluation",
        );
        return [];
    }
    // ...
}

// APRÈS :
async evaluate(delta: ContextDelta): Promise<SharingDecision[]> {
    const effectiveThreshold = this.computeThreshold(delta);

    if (delta.significance < effectiveThreshold) {
        this.logger.debug(
            {
                agentId: delta.agentId,
                deltaType: delta.type,
                significance: delta.significance,
                threshold: effectiveThreshold,
                phase: this.significanceContext?.phase ?? "unknown",
            },
            `Delta below dynamic threshold (${delta.significance.toFixed(2)} < ${effectiveThreshold.toFixed(2)}), skipping`,
        );
        return [];
    }

    // ...rest unchanged
}
```

### 4. Construire le `SignificanceContext` dans `AgentPool`

Dans `src/classes/agent-pool/agent-pool.ts`, mettre à jour le contexte du broker quand l'état d'exécution change.

#### a. Helper pour construire le contexte

```typescript
/**
 * Builds the current SignificanceContext from the execution state.
 * Called whenever the execution state changes (delta processed,
 * agent completion, agent failure).
 */
private buildSignificanceContext(sourceAgentId: string): SignificanceContext {
    const allStates = this.contextTracker.getAllAgentStates();
    const totalSubtasks = allStates.length;
    const completedSubtasks = allStates.filter(s => s.completed && !s.error).length;
    const failedSubtasks = allStates.filter(s => s.completed && !!s.error).length;

    // Compute phase
    const completionRatio = totalSubtasks > 0
        ? (completedSubtasks + failedSubtasks) / totalSubtasks
        : 0;
    let phase: "early" | "mid" | "late";
    if (completionRatio < 0.3) {
        phase = "early";
    } else if (completionRatio < 0.7) {
        phase = "mid";
    } else {
        phase = "late";
    }

    // Check if the source agent has dependents
    const sourceSubtaskId = this.agentToSubtask.get(sourceAgentId);
    let hasBlockingDependents = false;
    let hasInformationalDependents = false;

    if (sourceSubtaskId && this._currentAnalysis) {
        for (const dep of this._currentAnalysis.dependencies) {
            if (dep.from === sourceSubtaskId) {
                if (dep.type === "blocking") {
                    hasBlockingDependents = true;
                } else if (dep.type === "informational") {
                    hasInformationalDependents = true;
                }
            }
        }
    }

    return {
        totalSubtasks,
        completedSubtasks,
        failedSubtasks,
        phase,
        hasBlockingDependents,
        hasInformationalDependents,
        totalDeltasProcessed: this._deltaCount,
    };
}
```

**Note** : `this._currentAnalysis` est actuellement marqué avec `biome-ignore lint/correctness/noUnusedPrivateClassMembers` car il était « tracked for future introspection ». Cette évolution lui donne un usage concret — retirer le biome-ignore.

#### b. Mettre à jour le contexte avant chaque évaluation de sharing

Dans `handleDelta()`, avant d'appeler le broker :

```typescript
private async handleDelta(delta: ContextDelta): Promise<void> {
    try {
        // ── Information Sharing ─────────────────────────────────────
        if (this.informationBroker && this.contextTracker.agentCount > 1) {
            // Update the significance context before evaluation
            const sigContext = this.buildSignificanceContext(delta.agentId);
            this.informationBroker.updateSignificanceContext(sigContext);

            // ... existing evaluation code (evaluate or evaluateWithFullResult) ...
        }

        // ... rest unchanged ...
    } catch (error) {
        // ... unchanged ...
    }
}
```

### 5. Supprimer l'ancien champ fixe `significanceThreshold`

Dans l'`InformationBroker`, le champ `private readonly significanceThreshold: number` est remplacé par `private readonly baseThreshold: number` et la méthode `computeThreshold()`. Supprimer l'ancienne propriété et toute référence à elle.

### 6. Gérer le cas `_currentAnalysis` pour accéder aux dépendances

Actuellement, `_currentAnalysis` est reset à `null` dans le `finally` de `execute()`. Cependant, `handleDelta()` est fire-and-forget et peut encore s'exécuter pendant le cleanup. Pour éviter un `NullPointerException`, `buildSignificanceContext()` gère le cas où `_currentAnalysis` est `null` en retournant `hasBlockingDependents: false` et `hasInformationalDependents: false`.

Alternativement, on peut stocker les dépendances dans le broker (elles y sont déjà via `this.dependencies`), et ne pas dépendre de `_currentAnalysis` dans la pool. Le broker peut calculer `hasBlockingDependents` en interne à partir de `this.dependencies` et `this.agentToSubtask`. Cette approche est plus robuste :

```typescript
// Dans computeThreshold(), le broker calcule lui-même les dépendances
private computeThreshold(delta: ContextDelta): number {
    // ...

    // 2. Dependency adjustment — compute from broker's own dependency data
    const sourceSubtaskId = this.agentToSubtask.get(delta.agentId);
    let hasBlockingDependents = false;
    let hasInformationalDependents = false;

    if (sourceSubtaskId) {
        for (const dep of this.dependencies) {
            if (dep.from === sourceSubtaskId) {
                if (dep.type === "blocking") hasBlockingDependents = true;
                if (dep.type === "informational") hasInformationalDependents = true;
            }
        }
    }

    if (hasBlockingDependents) {
        threshold -= BLOCKING_DEPENDENT_REDUCTION;
    } else if (hasInformationalDependents) {
        threshold -= INFORMATIONAL_DEPENDENT_REDUCTION;
    }

    // ...
}
```

**Si on choisit cette approche**, le `SignificanceContext` n'a plus besoin des champs `hasBlockingDependents` et `hasInformationalDependents` — le broker les calcule lui-même. Le contexte ne contient plus que les infos que le broker ne peut pas calculer seul (phase, totalDeltas, completion counts). C'est une meilleure séparation des responsabilités.

→ **Choisir cette approche** : le `SignificanceContext` est simplifié, et le broker calcule les dépendances en interne puisqu'il a déjà toutes les données nécessaires.

### 7. `SignificanceContext` simplifié

```typescript
export interface SignificanceContext {
    /** Total number of subtasks in the current execution. */
    readonly totalSubtasks: number;

    /** Number of subtasks that have completed successfully. */
    readonly completedSubtasks: number;

    /** Number of subtasks that have failed. */
    readonly failedSubtasks: number;

    /**
     * Execution phase derived from completion ratio.
     * - "early": 0-30% completion
     * - "mid": 30-70% completion
     * - "late": 70-100% completion
     */
    readonly phase: "early" | "mid" | "late";

    /**
     * Total number of deltas already processed in this execution.
     */
    readonly totalDeltasProcessed: number;
}
```

Et `buildSignificanceContext()` dans la pool est simplifié (sans la partie dépendances).

---

## Tableau des seuils effectifs par scénario

### Exemples de seuils calculés

| Scénario | Base | Phase | Deps | Chatty | Effectif | `TOOL_COMPLETE` (0.5) |
|----------|------|-------|------|--------|----------|----------------------|
| Début, avec blocking deps | 0.5 | -0.1 | -0.2 | 0 | **0.2** | ✅ Évalué |
| Début, sans deps | 0.5 | -0.1 | 0 | 0 | **0.4** | ✅ Évalué |
| Milieu, avec blocking deps | 0.5 | 0 | -0.2 | 0 | **0.3** | ✅ Évalué |
| Milieu, sans deps | 0.5 | 0 | 0 | 0 | **0.5** | ✅ Évalué (pile) |
| Fin, avec blocking deps | 0.5 | +0.1 | -0.2 | 0 | **0.4** | ✅ Évalué |
| Fin, sans deps | 0.5 | +0.1 | 0 | 0 | **0.6** | ❌ Ignoré |
| Milieu, chatty (100 deltas) | 0.5 | 0 | 0 | +0.05 | **0.55** | ❌ Ignoré |
| Milieu, très chatty (200 deltas) | 0.5 | 0 | 0 | +0.15 | **0.65** | ❌ Ignoré |

### Résultat clé

Avec le seuil dynamique, les `TOOL_COMPLETE` sont évalués dans les phases early/mid et quand il y a des dépendances — les cas où leur information est la plus pertinente. En phase late sans dépendances, ils sont toujours ignorés (comportement acceptable).

### Comparaison avec le seuil fixe

| Delta Type | Significance | Seuil fixe (0.6) | Seuil dynamique (fourchette) |
|------------|-------------|-------------------|------------------------------|
| `AGENT_ERROR` | 1.0 | ✅ Toujours | ✅ Toujours |
| `TOOL_FAILED` | 0.9 | ✅ Toujours | ✅ Toujours |
| `PROMPT_COMPLETE` | 0.8 | ✅ Toujours | ✅ Toujours |
| `PLAN_UPDATE` | 0.6 | ✅ Pile | ✅ Toujours (sauf late+chatty) |
| `TOOL_COMPLETE` | 0.5 | ❌ Jamais | ✅ Souvent (early/mid + deps) |
| `FILE_WRITTEN` | 0.5 | ❌ Jamais | ✅ Souvent (early/mid + deps) |
| `STATUS_CHANGE/IDLE` | 0.3 | ❌ Jamais | ✅ Rarement (early + blocking) |
| `FILE_READ` | 0.2 | ❌ Jamais | ✅ Rarement (early + blocking) |
| `STATUS_CHANGE/BUSY` | 0.1 | ❌ Jamais | ❌ Jamais (MIN=0.2) |

---

## Impact sur le nombre d'appels LLM

Le seuil dynamique augmente le nombre d'évaluations LLM dans certains scénarios :

### Estimation par exécution multi-agent (3 agents, 10-15 deltas significatifs chacun)

| Scénario | Seuil fixe (0.6) | Seuil dynamique | Variation |
|----------|-----------------|-----------------|-----------|
| Pas de dépendances | ~15 évaluations | ~20 évaluations | +33% |
| Avec blocking deps | ~15 évaluations | ~25 évaluations | +67% |
| Chatty (100+ deltas) | ~30 évaluations | ~25 évaluations | -17% |

### Mitigation du coût

1. Le seuil dynamique est **plus élevé en fin d'exécution** — réduit les appels quand les agents finissent
2. Le **chatty penalty** augmente le seuil pour les exécutions bruyantes — auto-régulation
3. Les évaluations supplémentaires sont souvent des `TOOL_COMPLETE` et `FILE_WRITTEN` qui produisent des sharing decisions **plus utiles** — le coût est justifié par la qualité

### Garde-fou absolu

Le seuil ne descend **jamais** en dessous de `MIN_SIGNIFICANCE_THRESHOLD = 0.2`, ce qui exclut toujours `STATUS_CHANGE/BUSY` (0.1) et la plupart des `FILE_READ` (0.2 pile — rarement évalué).

---

## Tests à implémenter

### Tests unitaires pour `computeThreshold()`

#### Test 1 : Seuil de base sans contexte

- Ne pas appeler `updateSignificanceContext()`
- Appeler `computeThreshold(delta)` avec un delta quelconque
- Assert : retourne `BASE_SIGNIFICANCE_THRESHOLD` (0.5)

#### Test 2 : Phase early réduit le seuil

- Context : `phase: "early"`, pas de deps, 0 deltas
- Assert : threshold === 0.5 - 0.1 === 0.4

#### Test 3 : Phase late augmente le seuil

- Context : `phase: "late"`, pas de deps, 0 deltas
- Assert : threshold === 0.5 + 0.1 === 0.6

#### Test 4 : Blocking dependents réduisent le seuil

- Context : `phase: "mid"`, source agent has blocking deps
- Assert : threshold === 0.5 - 0.2 === 0.3

#### Test 5 : Informational dependents réduisent moins

- Context : `phase: "mid"`, source agent has informational deps only
- Assert : threshold === 0.5 - 0.1 === 0.4

#### Test 6 : Combinaison early + blocking deps

- Context : `phase: "early"`, blocking deps
- Assert : threshold === 0.5 - 0.1 - 0.2 === 0.2 (clamped to MIN)

#### Test 7 : Le seuil ne descend pas en dessous de MIN

- Context : `phase: "early"`, blocking deps (threshold calculé = 0.2)
- Assert : threshold === MIN_SIGNIFICANCE_THRESHOLD (0.2)
- Context encore plus agressif (ex: ajuster base à 0.3)
- Assert : threshold ne descend pas en dessous de 0.2

#### Test 8 : Le seuil ne monte pas au-dessus de MAX

- Context : `phase: "late"`, chatty (200+ deltas), pas de deps
- Threshold calculé = 0.5 + 0.1 + 0.15 = 0.75
- Assert : threshold ≤ MAX_SIGNIFICANCE_THRESHOLD (0.85)
- Avec un base threshold plus élevé (0.7), vérifie le clamp à 0.85

#### Test 9 : Chatty penalty s'applique progressivement

- Context : `totalDeltasProcessed: 50` → pas de penalty
- Context : `totalDeltasProcessed: 100` → penalty = +0.05
- Context : `totalDeltasProcessed: 150` → penalty = +0.10
- Context : `totalDeltasProcessed: 300` → penalty = +0.15 (capped at MAX_CHATTY_PENALTY)

#### Test 10 : Chatty penalty caps at MAX_CHATTY_PENALTY

- Context : `totalDeltasProcessed: 1000` → penalty ne dépasse pas 0.15
- Assert : total penalty === MAX_CHATTY_PENALTY (0.15)

#### Test 11 : Le broker calcule les dépendances en interne

- Setup : broker avec dependencies `[{ from: "st-1", to: "st-2", type: "blocking" }]`
- Mapping : `agent-A → st-1`
- Delta from `agent-A`
- Assert : le seuil est réduit de `BLOCKING_DEPENDENT_REDUCTION`
- Delta from `agent-B` (pas de dependants)
- Assert : le seuil n'est PAS réduit

### Tests d'intégration

#### Test 12 : `evaluate()` utilise le seuil dynamique au lieu du fixe

- Setup : broker avec `BASE_SIGNIFICANCE_THRESHOLD = 0.5`
- Context : `phase: "early"` → seuil effectif = 0.4
- Delta : `TOOL_COMPLETE` avec significance 0.5
- Assert : le delta EST évalué (0.5 ≥ 0.4)
- Vérifier qu'avec le seuil fixe ancien (0.6), il aurait été ignoré

#### Test 13 : `TOOL_COMPLETE` est évalué en phase early avec blocking deps

- Context : early phase, agent source a des blocking deps
- Seuil effectif ≈ 0.2
- Delta : `TOOL_COMPLETE` significance 0.5
- Assert : le delta est évalué (pas skipped)
- Assert : `sendOneShotJson` est appelé (le LLM évalue le sharing)

#### Test 14 : `TOOL_COMPLETE` est ignoré en phase late sans deps

- Context : late phase, pas de deps
- Seuil effectif ≈ 0.6
- Delta : `TOOL_COMPLETE` significance 0.5
- Assert : le delta est ignoré (0.5 < 0.6)

#### Test 15 : `AgentPool.handleDelta()` met à jour le contexte avant l'évaluation

- Mocker l'`InformationBroker` pour capturer les appels
- Simuler un delta
- Assert : `updateSignificanceContext()` est appelé AVANT `evaluate()` ou `evaluateWithFullResult()`
- Assert : le contexte passé contient les bonnes valeurs (phase, totalDeltas, etc.)

#### Test 16 : La phase est correctement calculée

- 0 agents complétés sur 3 → phase = "early"
- 1 agent complété sur 3 → phase = "mid" (33%)
- 2 agents complétés sur 3 → phase = "late" (67%)
- 3 agents complétés sur 3 → phase = "late" (100%)

#### Test 17 : Le fallback fonctionne sans contexte

- Ne pas appeler `updateSignificanceContext()`
- Appeler `evaluate()` avec un delta
- Assert : le seuil utilisé est le `baseThreshold` (pas d'erreur, pas de NullPointer)

### Tests de non-régression

#### Test 18 : Le comportement avec un seul agent est inchangé

- En single-agent, `this.contextTracker.agentCount > 1` est `false`
- Le broker n'est jamais appelé
- Assert : aucune évaluation de sharing, pas d'appel à `computeThreshold()`

#### Test 19 : Le `options.significanceThreshold` override fonctionne toujours

- Instancier le broker avec `options: { significanceThreshold: 0.3 }`
- Sans context, le seuil utilisé est 0.3 (pas 0.5)
- Assert : les deltas avec significance ≥ 0.3 sont évalués

#### Test 20 : Les deltas `AGENT_ERROR` (1.0) passent toujours le seuil

- Dans tous les scénarios possibles (late, chatty, no deps)
- Assert : `AGENT_ERROR` est toujours évalué (significance 1.0 > MAX_THRESHOLD 0.85)

---

## Critères de validation

- [ ] Le seuil de significance est dynamique et non plus fixe
- [ ] Le seuil s'adapte à la phase d'exécution (early/mid/late)
- [ ] Le seuil est réduit quand l'agent source a des blocking dependents
- [ ] Le seuil est réduit quand l'agent source a des informational dependents
- [ ] Le seuil augmente pour les exécutions chatty (> 50 deltas)
- [ ] Le seuil est toujours clampé entre `MIN_SIGNIFICANCE_THRESHOLD` et `MAX_SIGNIFICANCE_THRESHOLD`
- [ ] Le broker calcule les dépendances en interne à partir de `this.dependencies` et `this.agentToSubtask`
- [ ] `updateSignificanceContext()` est appelé par la pool avant chaque évaluation de sharing
- [ ] Le fallback au `baseThreshold` fonctionne quand aucun contexte n'est fourni
- [ ] Les `TOOL_COMPLETE` (0.5) sont évalués en phase early/mid avec des dépendances
- [ ] Les `TOOL_COMPLETE` (0.5) sont ignorés en phase late sans dépendances (comportement acceptable)
- [ ] Les `AGENT_ERROR` (1.0) passent toujours le seuil dans tous les scénarios
- [ ] Les `STATUS_CHANGE/BUSY` (0.1) ne passent jamais le seuil (MIN = 0.2)
- [ ] Le biome-ignore sur `_currentAnalysis` est retiré si `_currentAnalysis` est maintenant utilisé
- [ ] L'`options.significanceThreshold` override du constructeur fonctionne toujours
- [ ] Tous les tests existants passent toujours
- [ ] Les nouveaux tests couvrent toutes les combinaisons de facteurs (phase × deps × chatty)

---

## Points d'attention

1. **Le `SignificanceContext` est léger** — il ne contient que des compteurs et un enum de phase. Le coût de construction dans `buildSignificanceContext()` est O(n) avec n = nombre d'agents (typiquement 2-5). Négligeable.

2. **`updateSignificanceContext()` est appelé avant chaque `evaluate()`** — cela signifie que le contexte est recalculé à chaque delta. C'est voulu : la phase et les compteurs changent pendant l'exécution. Le coût est minime.

3. **Le broker calcule les dépendances en interne** — c'est la meilleure séparation des responsabilités. La pool fournit les infos globales (phase, compteurs), le broker utilise ses propres données (dependencies, mappings) pour les infos spécifiques à l'agent. Pas de duplication.

4. **Le `_currentAnalysis` dans AgentPool** — si on choisit l'approche où le broker calcule les dépendances en interne (recommandé), `_currentAnalysis` n'est plus nécessaire dans `buildSignificanceContext()`. Il peut rester `biome-ignore` pour l'instant ou être utilisé par le `buildSignificanceContext()` simplifié pour calculer la phase. Dans tous les cas, ne PAS modifier la logique de reset dans le `finally` de `execute()`.

5. **Les constantes sont conservatrices** — les valeurs choisies (`BASE = 0.5`, `BLOCKING_REDUCTION = 0.2`, etc.) sont des estimations initiales. Elles devraient être ajustées après observation en production. Dans le futur, elles pourraient être configurables via `AgentPoolConfig`.

6. **L'`evaluateWithFullResult()` (évolution 07) utilise aussi `evaluate()` en interne** — le seuil dynamique s'applique automatiquement car `evaluate()` est le point d'entrée. Pas de changement nécessaire dans `evaluateWithFullResult()`.

7. **Le logging est important** — la méthode `computeThreshold()` log quand le seuil diffère du base. Cela permet de diagnostiquer des comportements inattendus (trop ou pas assez de partage) en observant les logs. Le log est en `debug` pour ne pas polluer les logs en production.

8. **La phase "mid" a un ajustement de 0** — c'est voulu. La phase mid est le comportement « normal ». Les ajustements early et late sont des modifications par rapport à la norme. Cela rend le système facile à raisonner : le base threshold est le comportement en phase mid sans dépendances.

9. **Impact sur l'évolution 08 (structured injection)** — le seuil dynamique peut entraîner plus de partages en phase early/mid. Ces partages supplémentaires seront correctement structurés grâce aux injections structurées (priorité, catégorie). Le système d'overflow de l'`AgentContextManager` protège contre la surcharge. Les deux systèmes se complètent.

10. **Test de régression critique** : vérifier que le changement de `this.significanceThreshold` (propriété) en `computeThreshold()` (méthode) ne casse pas les tests existants qui pourraient vérifier directement la propriété. Si des tests accèdent à `broker.significanceThreshold`, ils doivent être mis à jour pour utiliser `broker.baseThreshold` ou `broker.computeThreshold(delta)`.