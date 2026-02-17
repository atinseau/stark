# Évolution 19 — Tracking des coûts et gestion du budget tokens avec compression

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

---

## Contexte du problème

Le `ConversationManager` estime les tokens consommés avec une heuristique grossière (`Math.ceil((content.length + response.length) / 4)`) mais **ne fait rien de cette information**. Le `tokenCount` est tracké par conversation mais jamais exploité :

```typescript
// src/classes/agent-pool/conversation-manager.ts (lignes ~128-130)
// Rough token estimate (4 chars ≈ 1 token)
conversation.tokenCount += Math.ceil(
    (content.length + response.length) / 4,
);
```

Par ailleurs, les agents émettent des événements `USAGE_UPDATE` avec les données de consommation réelles (token count, context percent, coût) mais celles-ci **ne sont jamais agrégées** au niveau du pool :

```typescript
// src/classes/agent-pool/context-tracker.ts
case AgentEvent.USAGE_UPDATE:
    return {
        contextPercent: payload.contextPercent,
        contextUsed: payload.contextUsed,
        contextSize: payload.contextSize,
        cost: payload.cost,
    };
```

### Problèmes identifiés

#### 1. Pas de visibilité sur le coût total

L'utilisateur n'a aucun moyen de savoir combien une exécution a coûté en tokens/dollars. Les `USAGE_UPDATE` events sont capturés dans les events de chaque agent mais jamais agrégés.

#### 2. Pas de tracking des appels LLM de la pool elle-même

La pool fait de nombreux appels LLM via le `ConversationManager` (planner, context analyzer, sharing analyzer, intent analyzer, notification engine, orchestrator, checkpoint evaluator, reflection engine) mais ne les comptabilise pas.

#### 3. Pas de gestion du budget tokens des conversations

Le `tokenCount` par conversation n'est jamais utilisé pour déclencher une action. Les conversations peuvent croître indéfiniment (en théorie, même si beaucoup sont one-shot). Les conversations qui utilisent l'historique (`PLANNER` avant reset, `USER_INTERACTION` pour le summary) n'ont aucune protection contre l'explosion des tokens.

#### 4. Pas de compression/pruning des conversations longues

Quand une conversation approche de la limite de contexte du modèle, il n'y a aucun mécanisme de résumé ou de sliding window. Le seul mécanisme est `reset()` qui efface tout brutalement.

#### 5. Pas de budget configurable

L'utilisateur ne peut pas définir un budget maximum en tokens ou en coût pour une exécution. Aucun garde-fou contre les exécutions coûteuses.

### Impact mesuré

Dans une exécution multi-agent typique avec 3 agents et l'ensemble des sous-systèmes activés :

| Source | Appels LLM estimés | Tokens estimés par appel | Total estimé |
|--------|-------|-------|-------|
| Planner | 1-3 | 2000-5000 | 5000-15000 |
| Sharing evaluations | 5-15 | 500-1500 | 2500-22500 |
| Notification evaluations | 3-8 | 200-500 | 600-4000 |
| Orchestrator | 2-5 | 1000-3000 | 2000-15000 |
| Checkpoints | 1-3 | 1000-2000 | 1000-6000 |
| Reflection | 1 | 2000-4000 | 2000-4000 |
| Intent analysis | 1-3 | 200-500 | 200-1500 |
| Summary | 0-1 | 500-1500 | 0-1500 |
| **Agent prompts (ACP)** | **3-9** | **5000-50000** | **15000-450000** |
| **Total** | | | **28300-519500** |

Sans tracking, l'utilisateur ne sait rien de cette consommation.

---

## Fichiers impactés

| Fichier | Action |
|---------|--------|
| `src/types/agent-pool.types.ts` | Ajouter les types `CostTracker`, `TokenBudgetConfig`, `ConversationCompressionConfig`, `UsageSnapshot` |
| `src/classes/agent-pool/cost-tracker.ts` | **Nouveau** — Agrégation des coûts et budget management |
| `src/classes/agent-pool/conversation-manager.ts` | Ajouter la compression automatique des conversations |
| `src/classes/agent-pool/agent-pool.ts` | Intégrer le cost tracker, exposer les stats |
| `src/classes/agent-pool/context-tracker.ts` | Extraire les données de coût des `USAGE_UPDATE` events |
| `src/enums/pool-event.enum.ts` | Ajouter `BUDGET_WARNING` et `BUDGET_EXCEEDED` |
| `src/prompts/compression.ts` | **Nouveau** — Prompt de compression de conversation |
| `src/prompts/index.ts` | Exporter les nouveaux prompts |
| `src/classes/agent-pool/tests/` | Tests unitaires |

---

## Spécification détaillée des changements

### 1. Nouveaux types dans `agent-pool.types.ts`

#### Type `UsageSnapshot`

Un snapshot de la consommation à un instant donné :

```typescript
/**
 * Snapshot de la consommation de tokens et du coût à un instant donné.
 * Agrégé depuis les agents (USAGE_UPDATE events) et les appels LLM de la pool.
 */
export interface UsageSnapshot {
    /** Nombre total de tokens d'entrée (prompt) consommés. */
    readonly inputTokens: number;

    /** Nombre total de tokens de sortie (completion) consommés. */
    readonly outputTokens: number;

    /** Nombre total de tokens (input + output). */
    readonly totalTokens: number;

    /** Coût total estimé en USD (si disponible depuis OpenRouter). */
    readonly estimatedCostUsd: number | null;

    /** Détail par source de consommation. */
    readonly breakdown: UsageBreakdown;

    /** ISO-8601 timestamp du snapshot. */
    readonly timestamp: string;
}

/**
 * Détail de la consommation par source.
 */
export interface UsageBreakdown {
    /** Tokens consommés par les agents (ACP prompts). */
    readonly agents: UsageEntry;

    /** Tokens consommés par le planner. */
    readonly planner: UsageEntry;

    /** Tokens consommés par le sharing analyzer. */
    readonly sharingAnalyzer: UsageEntry;

    /** Tokens consommés par le context analyzer (notifications). */
    readonly contextAnalyzer: UsageEntry;

    /** Tokens consommés par l'intent analyzer. */
    readonly intentAnalyzer: UsageEntry;

    /** Tokens consommés par l'orchestrator. */
    readonly orchestrator: UsageEntry;

    /** Tokens consommés par le checkpoint evaluator. */
    readonly checkpoint: UsageEntry;

    /** Tokens consommés par le reflection engine. */
    readonly reflection: UsageEntry;

    /** Tokens consommés par le user interaction (summary). */
    readonly userInteraction: UsageEntry;

    /** Tokens consommés par la compression de conversations. */
    readonly compression: UsageEntry;
}

/**
 * Entrée de consommation pour une source individuelle.
 */
export interface UsageEntry {
    /** Nombre d'appels LLM effectués. */
    readonly callCount: number;

    /** Nombre total de tokens consommés. */
    readonly totalTokens: number;

    /** Nombre de tokens d'entrée (prompt). */
    readonly inputTokens: number;

    /** Nombre de tokens de sortie (completion). */
    readonly outputTokens: number;

    /** Coût estimé en USD (si disponible). */
    readonly estimatedCostUsd: number | null;
}
```

#### Type `TokenBudgetConfig`

Configuration du budget tokens/coût :

```typescript
/**
 * Configuration du budget tokens et coût pour une exécution.
 *
 * Quand un seuil est atteint, le pool émet un événement et peut
 * prendre des mesures automatiques (compression, arrêt).
 */
export interface TokenBudgetConfig {
    /**
     * Budget maximum de tokens total pour une exécution.
     * Inclut les agents ET les appels LLM de la pool.
     * 0 ou undefined = pas de limite.
     */
    readonly maxTotalTokens?: number;

    /**
     * Budget maximum en USD pour une exécution.
     * 0 ou undefined = pas de limite.
     */
    readonly maxCostUsd?: number;

    /**
     * Pourcentage du budget auquel émettre un avertissement (0.0-1.0).
     * Défaut : 0.8 (80%).
     */
    readonly warningThreshold?: number;

    /**
     * Action à entreprendre quand le budget est dépassé.
     * - `"warn"`: Émettre un événement BUDGET_EXCEEDED mais continuer.
     * - `"pause"`: Arrêter de lancer de nouveaux appels LLM de la pool
     *   (les agents en cours continuent).
     * - `"abort"`: Arrêter l'exécution immédiatement.
     * Défaut : `"warn"`.
     */
    readonly onExceeded?: "warn" | "pause" | "abort";
}
```

#### Type `ConversationCompressionConfig`

Configuration de la compression automatique des conversations :

```typescript
/**
 * Configuration de la compression automatique des conversations.
 *
 * Quand une conversation dépasse un seuil de tokens, les messages
 * les plus anciens sont résumés en un seul message condensé.
 * Le system prompt est toujours préservé.
 */
export interface ConversationCompressionConfig {
    /**
     * Activer la compression automatique.
     * Défaut : true.
     */
    readonly enabled?: boolean;

    /**
     * Seuil de tokens (estimés) au-delà duquel déclencher la compression.
     * Défaut : 50_000.
     */
    readonly compressionThresholdTokens?: number;

    /**
     * Pourcentage de l'historique à conserver après compression (0.0-1.0).
     * Les messages les plus récents sont préservés, les anciens résumés.
     * Défaut : 0.3 (garder 30% des messages les plus récents).
     */
    readonly retentionRatio?: number;

    /**
     * Nombre maximum de compressions par conversation avant un reset hard.
     * Évite les résumés-de-résumés à l'infini.
     * Défaut : 3.
     */
    readonly maxCompressions?: number;

    /**
     * Conversations à ne jamais compresser (par ConversationRole).
     * Les conversations one-shot sont naturellement exclues.
     */
    readonly excludeRoles?: ConversationRole[];
}
```

#### Enrichir `AgentPoolConfig`

Ajouter les nouvelles options :

```typescript
export interface AgentPoolConfig {
    // ... champs existants ...

    /**
     * Configuration du budget tokens/coût.
     * Si non fourni, aucune limite n'est appliquée mais le tracking
     * reste actif pour la visibilité.
     */
    readonly tokenBudget?: TokenBudgetConfig;

    /**
     * Configuration de la compression automatique des conversations.
     * Si non fourni, les valeurs par défaut sont utilisées.
     */
    readonly conversationCompression?: ConversationCompressionConfig;
}
```

#### Enrichir `AgentPoolResult`

Ajouter les données de consommation au résultat :

```typescript
export interface AgentPoolResult {
    // ... champs existants ...

    /**
     * Snapshot de la consommation finale de l'exécution.
     * Toujours disponible, même sans budget configuré.
     */
    readonly usage: UsageSnapshot;
}
```

#### Enrichir `AgentPoolState`

Ajouter les données de consommation live :

```typescript
export interface AgentPoolState {
    // ... champs existants ...

    /**
     * Snapshot de la consommation courante.
     * `null` si aucune exécution n'est en cours.
     */
    readonly currentUsage: UsageSnapshot | null;

    /**
     * Pourcentage du budget consommé (0.0-1.0).
     * `null` si aucun budget n'est configuré.
     */
    readonly budgetUsagePercent: number | null;

    /**
     * Indicateur d'avertissement de budget.
     */
    readonly budgetWarning: boolean;
}
```

### 2. Nouveaux pool events

Ajouter dans `pool-event.enum.ts` :

```typescript
export enum PoolEvent {
    // ... events existants ...

    /**
     * Le budget tokens/coût approche du seuil d'avertissement.
     * Émis une seule fois quand le seuil est franchi.
     */
    BUDGET_WARNING = "pool:budget-warning",

    /**
     * Le budget tokens/coût a été dépassé.
     * Le comportement dépend de `tokenBudget.onExceeded`.
     */
    BUDGET_EXCEEDED = "pool:budget-exceeded",
}
```

Ajouter les types d'événements dans `PoolEventMap` :

```typescript
export interface BudgetWarningEvent extends BasePoolEvent {
    readonly currentUsage: UsageSnapshot;
    readonly budgetUsagePercent: number;
    readonly budgetType: "tokens" | "cost";
}

export interface BudgetExceededEvent extends BasePoolEvent {
    readonly currentUsage: UsageSnapshot;
    readonly budgetType: "tokens" | "cost";
    readonly action: "warn" | "pause" | "abort";
}

export interface PoolEventMap {
    // ... events existants ...
    [PoolEvent.BUDGET_WARNING]: BudgetWarningEvent;
    [PoolEvent.BUDGET_EXCEEDED]: BudgetExceededEvent;
}
```

### 3. Nouveau fichier `src/classes/agent-pool/cost-tracker.ts`

#### Responsabilités

Le `CostTracker` est un agrégateur pur de données de consommation. Il :

1. Reçoit les rapports de consommation de chaque source (agents, conversations)
2. Maintient un compteur par source dans un `UsageBreakdown`
3. Évalue le budget et émet des signaux quand les seuils sont atteints
4. Produit des `UsageSnapshot` à la demande

Il n'émet pas d'événements lui-même — il retourne des signaux au pool qui se charge de l'émission.

#### Structure de la classe

```typescript
import type pino from "pino";
import type {
    TokenBudgetConfig,
    UsageBreakdown,
    UsageEntry,
    UsageSnapshot,
} from "../../types/agent-pool.types.ts";
import { isoNow } from "../../utils/formatting.ts";

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Sources de consommation reconnues par le cost tracker.
 * Correspond aux clés de `UsageBreakdown`.
 */
type UsageSource =
    | "agents"
    | "planner"
    | "sharingAnalyzer"
    | "contextAnalyzer"
    | "intentAnalyzer"
    | "orchestrator"
    | "checkpoint"
    | "reflection"
    | "userInteraction"
    | "compression";

/**
 * Signal retourné par `checkBudget()` indiquant l'état du budget.
 */
export type BudgetSignal =
    | { readonly type: "ok" }
    | { readonly type: "warning"; readonly budgetType: "tokens" | "cost"; readonly percent: number }
    | { readonly type: "exceeded"; readonly budgetType: "tokens" | "cost" };

// ── CostTracker ────────────────────────────────────────────────────────────

/**
 * Agrégateur de consommation tokens/coût pour l'AgentPool.
 *
 * Collecte les données de consommation depuis :
 * - Les agents (via les événements USAGE_UPDATE capturés par le ContextTracker)
 * - Les appels LLM de la pool (via instrumentation du ConversationManager)
 *
 * Le tracker est un composant passif — il ne prend aucune action automatique.
 * L'AgentPool interroge le tracker après chaque appel LLM et prend les
 * décisions appropriées (émettre un warning, pauser, ou aborter).
 *
 * ## Budget Management
 *
 * Le budget est optionnel. Quand configuré, le tracker compare la
 * consommation courante aux limites définies et retourne un `BudgetSignal`
 * que le pool peut convertir en événement et/ou action.
 *
 * Le warning est émis une seule fois quand le seuil est franchi (sticky flag).
 * Le exceeded est évalué à chaque appel à `checkBudget()`.
 *
 * ## Thread Safety
 *
 * Le tracker est conçu pour un accès séquentiel (JavaScript single-threaded).
 * Les `record*()` et `checkBudget()` sont safe à appeler depuis des handlers
 * async concurrents car les mutations sont atomiques (pas d'await entre
 * lecture et écriture).
 *
 * @example
 * ```ts
 * const tracker = new CostTracker(budgetConfig, logger);
 *
 * tracker.recordPoolCall("planner", 1200, 800, 0.003);
 * tracker.recordAgentUsage("agent-1", 5000, 2000, 0.01);
 *
 * const signal = tracker.checkBudget();
 * if (signal.type === "warning") {
 *   pool.emitPoolEvent(PoolEvent.BUDGET_WARNING, ...);
 * }
 *
 * const snapshot = tracker.getSnapshot();
 * console.log(snapshot.totalTokens); // 9000
 * ```
 */
export class CostTracker {
    // ... implementation below
}
```

#### Champs internes

```typescript
/** Compteurs par source. */
private readonly counters: Record<UsageSource, {
    callCount: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
}>;

/** Configuration du budget (optionnelle). */
private readonly budget: TokenBudgetConfig | null;

/** Indique si le warning a déjà été émis (sticky). */
private _warningEmitted = false;

/** Indique si le budget a été dépassé. */
private _exceeded = false;

/** Indique si le pool est en mode "paused" (plus de nouveaux appels LLM de la pool). */
private _paused = false;
```

#### Initialisation

Le constructeur initialise tous les compteurs à zéro :

```typescript
constructor(
    budget: TokenBudgetConfig | null,
    private readonly logger: pino.Logger,
) {
    this.budget = budget;

    const emptyEntry = () => ({
        callCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
    });

    this.counters = {
        agents: emptyEntry(),
        planner: emptyEntry(),
        sharingAnalyzer: emptyEntry(),
        contextAnalyzer: emptyEntry(),
        intentAnalyzer: emptyEntry(),
        orchestrator: emptyEntry(),
        checkpoint: emptyEntry(),
        reflection: emptyEntry(),
        userInteraction: emptyEntry(),
        compression: emptyEntry(),
    };
}
```

#### Méthodes d'enregistrement

```typescript
/**
 * Enregistre la consommation d'un appel LLM de la pool.
 *
 * Appelé par le ConversationManager (ou directement par le pool)
 * après chaque appel réussi à l'OpenRouter API.
 *
 * @param source - La source de l'appel (planner, sharingAnalyzer, etc.)
 * @param inputTokens - Nombre de tokens d'entrée.
 * @param outputTokens - Nombre de tokens de sortie.
 * @param costUsd - Coût en USD (si fourni par OpenRouter).
 */
recordPoolCall(
    source: UsageSource,
    inputTokens: number,
    outputTokens: number,
    costUsd?: number,
): void {
    const entry = this.counters[source];
    entry.callCount++;
    entry.inputTokens += inputTokens;
    entry.outputTokens += outputTokens;
    if (costUsd !== undefined) {
        entry.estimatedCostUsd += costUsd;
    }

    this.logger.debug(
        {
            source,
            inputTokens,
            outputTokens,
            costUsd,
            totalForSource: entry.inputTokens + entry.outputTokens,
        },
        `Cost tracked: ${source} +${inputTokens + outputTokens} tokens`,
    );
}

/**
 * Enregistre la consommation d'un agent (depuis un événement USAGE_UPDATE).
 *
 * Les données proviennent du ContextTracker qui capture les événements
 * USAGE_UPDATE émis par les agents ACP.
 *
 * @param agentId - L'agent qui a consommé.
 * @param inputTokens - Nombre de tokens d'entrée.
 * @param outputTokens - Nombre de tokens de sortie.
 * @param costUsd - Coût en USD (si disponible).
 */
recordAgentUsage(
    agentId: string,
    inputTokens: number,
    outputTokens: number,
    costUsd?: number,
): void {
    const entry = this.counters.agents;
    entry.callCount++;
    entry.inputTokens += inputTokens;
    entry.outputTokens += outputTokens;
    if (costUsd !== undefined) {
        entry.estimatedCostUsd += costUsd;
    }

    this.logger.debug(
        {
            agentId,
            inputTokens,
            outputTokens,
            costUsd,
        },
        `Agent cost tracked: ${agentId} +${inputTokens + outputTokens} tokens`,
    );
}
```

#### Méthode `checkBudget()`

```typescript
/**
 * Évalue l'état du budget et retourne un signal.
 *
 * Le signal `warning` est retourné une seule fois (sticky flag).
 * Le signal `exceeded` est retourné à chaque appel tant que le budget
 * est dépassé (permet au pool de réagir même s'il a ignoré le premier).
 *
 * @returns Un `BudgetSignal` indiquant l'état actuel.
 */
checkBudget(): BudgetSignal {
    if (!this.budget) {
        return { type: "ok" };
    }

    const total = this.getTotalTokens();
    const totalCost = this.getTotalCost();

    // Check token budget
    if (this.budget.maxTotalTokens && this.budget.maxTotalTokens > 0) {
        const percent = total / this.budget.maxTotalTokens;

        if (percent >= 1.0) {
            this._exceeded = true;
            return { type: "exceeded", budgetType: "tokens" };
        }

        const warningThreshold = this.budget.warningThreshold ?? 0.8;
        if (percent >= warningThreshold && !this._warningEmitted) {
            this._warningEmitted = true;
            return { type: "warning", budgetType: "tokens", percent };
        }
    }

    // Check cost budget
    if (this.budget.maxCostUsd && this.budget.maxCostUsd > 0 && totalCost !== null) {
        const percent = totalCost / this.budget.maxCostUsd;

        if (percent >= 1.0) {
            this._exceeded = true;
            return { type: "exceeded", budgetType: "cost" };
        }

        const warningThreshold = this.budget.warningThreshold ?? 0.8;
        if (percent >= warningThreshold && !this._warningEmitted) {
            this._warningEmitted = true;
            return { type: "warning", budgetType: "cost", percent };
        }
    }

    return { type: "ok" };
}
```

#### Méthode `getSnapshot()`

```typescript
/**
 * Produit un snapshot complet de la consommation courante.
 *
 * Le snapshot est une copie — les mutations ultérieures du tracker
 * n'affectent pas les snapshots déjà produits.
 */
getSnapshot(): UsageSnapshot {
    const breakdown = this.getBreakdown();
    const totalTokens = this.getTotalTokens();
    const totalCost = this.getTotalCost();

    return {
        inputTokens: this.getTotalInputTokens(),
        outputTokens: this.getTotalOutputTokens(),
        totalTokens,
        estimatedCostUsd: totalCost,
        breakdown,
        timestamp: isoNow(),
    };
}
```

#### Méthodes helpers

```typescript
/**
 * Retourne le nombre total de tokens consommés (toutes sources).
 */
getTotalTokens(): number {
    let total = 0;
    for (const entry of Object.values(this.counters)) {
        total += entry.inputTokens + entry.outputTokens;
    }
    return total;
}

/**
 * Retourne le nombre total de tokens d'entrée (toutes sources).
 */
getTotalInputTokens(): number {
    let total = 0;
    for (const entry of Object.values(this.counters)) {
        total += entry.inputTokens;
    }
    return total;
}

/**
 * Retourne le nombre total de tokens de sortie (toutes sources).
 */
getTotalOutputTokens(): number {
    let total = 0;
    for (const entry of Object.values(this.counters)) {
        total += entry.outputTokens;
    }
    return total;
}

/**
 * Retourne le coût total estimé en USD, ou null si aucune donnée de coût.
 */
getTotalCost(): number | null {
    let total = 0;
    let hasCost = false;
    for (const entry of Object.values(this.counters)) {
        if (entry.estimatedCostUsd > 0) {
            hasCost = true;
            total += entry.estimatedCostUsd;
        }
    }
    return hasCost ? total : null;
}

/**
 * Retourne le détail par source sous forme de `UsageBreakdown`.
 */
private getBreakdown(): UsageBreakdown {
    const toEntry = (source: UsageSource): UsageEntry => {
        const c = this.counters[source];
        return {
            callCount: c.callCount,
            totalTokens: c.inputTokens + c.outputTokens,
            inputTokens: c.inputTokens,
            outputTokens: c.outputTokens,
            estimatedCostUsd: c.estimatedCostUsd > 0 ? c.estimatedCostUsd : null,
        };
    };

    return {
        agents: toEntry("agents"),
        planner: toEntry("planner"),
        sharingAnalyzer: toEntry("sharingAnalyzer"),
        contextAnalyzer: toEntry("contextAnalyzer"),
        intentAnalyzer: toEntry("intentAnalyzer"),
        orchestrator: toEntry("orchestrator"),
        checkpoint: toEntry("checkpoint"),
        reflection: toEntry("reflection"),
        userInteraction: toEntry("userInteraction"),
        compression: toEntry("compression"),
    };
}

/**
 * Retourne le pourcentage du budget consommé (0.0-1.0).
 * `null` si aucun budget n'est configuré.
 */
getBudgetUsagePercent(): number | null {
    if (!this.budget) return null;

    if (this.budget.maxTotalTokens && this.budget.maxTotalTokens > 0) {
        return Math.min(1.0, this.getTotalTokens() / this.budget.maxTotalTokens);
    }

    const totalCost = this.getTotalCost();
    if (this.budget.maxCostUsd && this.budget.maxCostUsd > 0 && totalCost !== null) {
        return Math.min(1.0, totalCost / this.budget.maxCostUsd);
    }

    return null;
}

/** Whether the budget has been exceeded. */
get isExceeded(): boolean {
    return this._exceeded;
}

/** Whether the pool LLM calls are paused due to budget. */
get isPaused(): boolean {
    return this._paused;
}

/** Pause pool LLM calls due to budget exceeded. */
pause(): void {
    this._paused = true;
    this.logger.warn("Pool LLM calls paused due to budget limit");
}

/** Whether the warning threshold has been reached. */
get warningEmitted(): boolean {
    return this._warningEmitted;
}

/**
 * Nombre total d'appels LLM effectués (toutes sources).
 */
get totalCallCount(): number {
    let total = 0;
    for (const entry of Object.values(this.counters)) {
        total += entry.callCount;
    }
    return total;
}

/**
 * Resets all counters and flags. Called between executions.
 */
reset(): void {
    for (const entry of Object.values(this.counters)) {
        entry.callCount = 0;
        entry.inputTokens = 0;
        entry.outputTokens = 0;
        entry.estimatedCostUsd = 0;
    }
    this._warningEmitted = false;
    this._exceeded = false;
    this._paused = false;
}
```

### 4. Instrumenter le `ConversationManager` pour le tracking

Le `ConversationManager` doit reporter la consommation de chaque appel LLM au `CostTracker`. L'approche est d'ajouter un callback optionnel que le pool injecte après construction.

#### Ajouter un callback de tracking

```typescript
// Dans ConversationManager

/**
 * Callback appelé après chaque appel LLM réussi pour reporter la consommation.
 * Injecté par l'AgentPool pour connecter le ConversationManager au CostTracker.
 */
private usageCallback: ((
    role: ConversationRole,
    inputTokens: number,
    outputTokens: number,
    costUsd?: number,
) => void) | null = null;

/**
 * Définit le callback de tracking de consommation.
 *
 * @param callback - La fonction à appeler après chaque appel LLM.
 */
setUsageCallback(
    callback: (
        role: ConversationRole,
        inputTokens: number,
        outputTokens: number,
        costUsd?: number,
    ) => void,
): void {
    this.usageCallback = callback;
}
```

#### Modifier `send()` et `sendJson()` pour reporter

Dans les méthodes `send()`, `sendOneShot()`, `sendJson()`, et `sendOneShotJson()`, après un appel réussi, appeler le callback :

```typescript
// Exemple dans send() après réception de la réponse :

// Report usage if callback is set
if (this.usageCallback) {
    // Estimate tokens from content length (will be refined when
    // OpenRouter provides actual usage data in the response)
    const estimatedInputTokens = Math.ceil(content.length / 4);
    const estimatedOutputTokens = Math.ceil(response.length / 4);
    this.usageCallback(
        role,
        estimatedInputTokens,
        estimatedOutputTokens,
    );
}
```

#### Améliorer l'estimation des tokens avec les données OpenRouter

L'`OpenRouterClient` reçoit les données de usage dans la réponse API. Modifier `chat()` et `chatJson()` pour retourner les données de usage en plus du texte :

```typescript
/**
 * Résultat d'un appel chat incluant les données de consommation.
 */
export interface ChatResult {
    /** Le texte de la réponse. */
    readonly text: string;

    /** Données de consommation depuis l'API OpenRouter. */
    readonly usage: {
        readonly promptTokens: number;
        readonly completionTokens: number;
        readonly totalTokens: number;
    } | null;

    /** Coût en USD (si fourni par OpenRouter). */
    readonly costUsd: number | null;
}
```

Modifier les méthodes de `OpenRouterClient` pour retourner `ChatResult` au lieu de `string`. Adapter le `ConversationManager` pour consommer ce nouveau type et reporter les données réelles au lieu des estimations.

**Note importante** : cette modification de l'API interne de `OpenRouterClient` est un changement breaking pour `ConversationManager`. Les méthodes publiques de `ConversationManager` (`send()`, `sendJson()`, etc.) continuent de retourner les mêmes types — seul le reporting interne change.

### 5. Compression automatique des conversations dans `ConversationManager`

#### Nouveau prompt de compression

Créer `src/prompts/compression.ts` :

```typescript
import Handlebars from "handlebars";
import "./helpers.ts";

// ── Compression: System Prompt ─────────────────────────────────────────────

const COMPRESSION_SYSTEM_SOURCE = `You are a conversation compressor for an AI agent orchestration system.

Your job is to condense a sequence of conversation messages into a single, dense summary that preserves:
1. All key decisions made and their reasoning
2. All actionable information (file paths, API endpoints, data structures, configurations)
3. The current state of the conversation (what has been accomplished, what is pending)
4. Any constraints or requirements established during the conversation

You must NOT preserve:
- Greetings, acknowledgments, or filler
- Redundant information (keep only the most recent version)
- Step-by-step reasoning that led to a conclusion (keep only the conclusion)
- Error messages that were subsequently resolved

Output a single, dense paragraph or structured summary. No JSON. No markdown headers.
Keep the compressed summary under {{maxLength}} characters.`;

export const compressionSystemPrompt = Handlebars.compile(
    COMPRESSION_SYSTEM_SOURCE,
    { noEscape: true },
);

// ── Compression: User Prompt ───────────────────────────────────────────────

const COMPRESSION_SOURCE = `Compress the following {{messageCount}} conversation messages into a single dense summary.
Preserve all actionable information and decisions.

## Conversation Role
This conversation is used for: {{conversationPurpose}}

## Messages to Compress
{{#each messages}}
[{{this.role}}]: {{truncate this.content 500}}

{{/each}}

Produce the compressed summary now.`;

export const compressionPrompt = Handlebars.compile(COMPRESSION_SOURCE, {
    noEscape: true,
});
```

Mettre à jour `src/prompts/index.ts` pour exporter les nouveaux prompts :

```typescript
export { compressionSystemPrompt, compressionPrompt } from "./compression.ts";

// Dans le templates object :
const templates = {
    // ... existants ...
    compressionSystem: compressionSystemPrompt,
    compression: compressionPrompt,
} as const;
```

#### Ajouter la méthode `compress()` dans `ConversationManager`

```typescript
/**
 * Compresse l'historique d'une conversation en résumant les messages
 * les plus anciens et en gardant les plus récents intacts.
 *
 * Le processus :
 * 1. Calcule combien de messages garder (basé sur `retentionRatio`)
 * 2. Envoie les messages à compresser au LLM via un one-shot call
 * 3. Remplace les messages compressés par un unique message `system`
 *    contenant le résumé
 * 4. Préserve le system prompt original en première position
 *
 * @param role - La conversation à compresser.
 * @param config - Configuration de compression.
 * @returns Le nombre de tokens estimés économisés, ou 0 si pas de compression.
 */
async compress(
    role: ConversationRole,
    config: ConversationCompressionConfig,
): Promise<number> {
    const conversation = this.conversations.get(role);
    if (!conversation) return 0;

    const messages = conversation.messages;

    // Minimum de 4 messages pour que la compression ait du sens
    // (system + au moins 3 user/assistant exchanges)
    if (messages.length < 4) return 0;

    // Check compression count limit
    const maxCompressions = config.maxCompressions ?? 3;
    if ((conversation as any)._compressionCount >= maxCompressions) {
        this.logger.warn(
            { conversationRole: role, maxCompressions },
            `Max compressions reached for ${role}, performing hard reset`,
        );
        this.reset(role);
        return conversation.tokenCount;
    }

    const retentionRatio = config.retentionRatio ?? 0.3;

    // Messages to keep (most recent) — exclude the system prompt
    const nonSystemMessages = messages.slice(1);
    const keepCount = Math.max(2, Math.ceil(nonSystemMessages.length * retentionRatio));
    const compressCount = nonSystemMessages.length - keepCount;

    if (compressCount < 2) return 0; // Not enough to compress

    const messagesToCompress = nonSystemMessages.slice(0, compressCount);
    const messagesToKeep = nonSystemMessages.slice(compressCount);

    // Determine conversation purpose for the compression prompt
    const purposeMap: Record<string, string> = {
        "planner": "Strategic task analysis and decomposition",
        "context-analyzer": "Notification evaluation for user-facing updates",
        "sharing-analyzer": "Cross-agent information sharing decisions",
        "user-interaction": "User-facing response generation",
        "intent-analyzer": "User intent classification",
        "orchestrator": "Cross-conversation meta-reflection",
    };
    const purpose = purposeMap[role] ?? role;

    // Build the compression prompt
    const prompt = compressionPrompt({
        messageCount: messagesToCompress.length,
        conversationPurpose: purpose,
        messages: messagesToCompress.map(m => ({
            role: m.role,
            content: m.content,
        })),
    });

    this.logger.info(
        {
            conversationRole: role,
            totalMessages: messages.length,
            compressing: compressCount,
            keeping: keepCount,
        },
        `Compressing ${compressCount} messages in ${role} conversation`,
    );

    try {
        // Use a one-shot call to avoid recursion (don't add to this conversation)
        const compressedSummary = await this.client.chat(
            [
                { role: "system", content: compressionSystemPrompt({ maxLength: 2000 }) },
                { role: "user", content: prompt },
            ],
        );

        // Estimate tokens saved
        const oldTokenCount = messagesToCompress.reduce(
            (acc, m) => acc + Math.ceil(m.content.length / 4),
            0,
        );
        const newTokenCount = Math.ceil(compressedSummary.length / 4);
        const tokensSaved = Math.max(0, oldTokenCount - newTokenCount);

        // Rebuild the conversation: system prompt + compressed summary + kept messages
        const compressedMessage: OpenRouterMessage = {
            role: "system",
            content: `[Compressed context from ${compressCount} earlier messages]\n\n${compressedSummary}`,
        };

        conversation.messages = [
            messages[0], // Original system prompt
            compressedMessage,
            ...messagesToKeep,
        ];

        // Update token count
        conversation.tokenCount = conversation.messages.reduce(
            (acc, m) => acc + Math.ceil(m.content.length / 4),
            0,
        );

        // Track compression count
        (conversation as any)._compressionCount =
            ((conversation as any)._compressionCount ?? 0) + 1;

        this.logger.info(
            {
                conversationRole: role,
                tokensSaved,
                newMessageCount: conversation.messages.length,
                newEstimatedTokens: conversation.tokenCount,
                compressionNumber: (conversation as any)._compressionCount,
            },
            `Compression complete: saved ~${tokensSaved} tokens`,
        );

        return tokensSaved;
    } catch (error) {
        this.logger.warn(
            {
                conversationRole: role,
                error: error instanceof Error ? error.message : String(error),
            },
            `Compression failed for ${role} — conversation left unchanged`,
        );
        return 0;
    }
}

/**
 * Vérifie si une conversation a besoin de compression.
 *
 * @param role - La conversation à vérifier.
 * @param thresholdTokens - Le seuil de tokens au-delà duquel compresser.
 * @returns `true` si la conversation dépasse le seuil.
 */
needsCompression(role: ConversationRole, thresholdTokens: number): boolean {
    const conversation = this.conversations.get(role);
    if (!conversation) return false;
    return conversation.tokenCount >= thresholdTokens;
}
```

#### Modifier `register()` pour initialiser le compteur de compression

```typescript
register(role: ConversationRole, systemPrompt: string, model?: string): void {
    const conversation: Conversation & { _compressionCount?: number } = {
        role,
        systemPrompt,
        messages: [{ role: "system", content: systemPrompt }],
        tokenCount: 0,
        model,
    };
    (conversation as any)._compressionCount = 0;
    this.conversations.set(role, conversation);

    // ... existing logging ...
}
```

**Note** : Le `_compressionCount` est ajouté de manière ad-hoc avec un cast pour éviter de modifier le type `Conversation` dans cette évolution. Si une refactorisation du type est préférée, ajouter un champ optionnel `compressionCount?: number` dans `Conversation`.

### 6. Intégrer le `CostTracker` dans `AgentPool`

#### A. Ajouter le champ dans la classe

```typescript
export class AgentPool extends EventEmitter {
    // ... champs existants ...

    /** Agrégateur de coûts et de consommation tokens. */
    private readonly costTracker: CostTracker;

    /** Configuration de la compression des conversations. */
    private readonly compressionConfig: ConversationCompressionConfig;
}
```

#### B. Instancier dans le constructeur

```typescript
constructor(config: AgentPoolConfig) {
    super();

    // ... existing config resolution ...

    // Cost tracker
    this.costTracker = new CostTracker(
        config.tokenBudget ?? null,
        this.logger,
    );

    // Compression config
    this.compressionConfig = {
        enabled: config.conversationCompression?.enabled ?? true,
        compressionThresholdTokens: config.conversationCompression?.compressionThresholdTokens ?? 50_000,
        retentionRatio: config.conversationCompression?.retentionRatio ?? 0.3,
        maxCompressions: config.conversationCompression?.maxCompressions ?? 3,
        excludeRoles: config.conversationCompression?.excludeRoles ?? [],
    };

    // Wire the usage callback from ConversationManager to CostTracker
    this.conversations.setUsageCallback((role, inputTokens, outputTokens, costUsd) => {
        const sourceMap: Record<string, UsageSource> = {
            [ConversationRole.PLANNER]: "planner",
            [ConversationRole.CONTEXT_ANALYZER]: "contextAnalyzer",
            [ConversationRole.SHARING_ANALYZER]: "sharingAnalyzer",
            [ConversationRole.USER_INTERACTION]: "userInteraction",
            [ConversationRole.INTENT_ANALYZER]: "intentAnalyzer",
            [ConversationRole.ORCHESTRATOR]: "orchestrator",
        };

        const source = sourceMap[role] ?? "userInteraction";
        this.costTracker.recordPoolCall(source, inputTokens, outputTokens, costUsd);

        // Check budget after every pool LLM call
        this.handleBudgetSignal(this.costTracker.checkBudget());
    });

    // ... rest of constructor ...
}
```

#### C. Méthode `handleBudgetSignal()`

```typescript
/**
 * Handles a budget signal from the cost tracker.
 * Emits pool events and takes action based on the signal type
 * and the configured `onExceeded` behavior.
 */
private handleBudgetSignal(signal: BudgetSignal): void {
    if (signal.type === "ok") return;

    if (signal.type === "warning") {
        const snapshot = this.costTracker.getSnapshot();

        this.emitPoolEvent(PoolEvent.BUDGET_WARNING, {
            currentUsage: snapshot,
            budgetUsagePercent: signal.percent,
            budgetType: signal.budgetType,
        });

        this.logger.warn(
            {
                budgetType: signal.budgetType,
                percent: Math.round(signal.percent * 100),
                totalTokens: snapshot.totalTokens,
                estimatedCostUsd: snapshot.estimatedCostUsd,
            },
            `Budget warning: ${Math.round(signal.percent * 100)}% of ${signal.budgetType} budget consumed`,
        );
        return;
    }

    if (signal.type === "exceeded") {
        const snapshot = this.costTracker.getSnapshot();
        const action = this.config.tokenBudget?.onExceeded ?? "warn";

        this.emitPoolEvent(PoolEvent.BUDGET_EXCEEDED, {
            currentUsage: snapshot,
            budgetType: signal.budgetType,
            action,
        });

        this.logger.error(
            {
                budgetType: signal.budgetType,
                action,
                totalTokens: snapshot.totalTokens,
                estimatedCostUsd: snapshot.estimatedCostUsd,
            },
            `Budget exceeded: ${signal.budgetType} limit reached — action: ${action}`,
        );

        switch (action) {
            case "pause":
                this.costTracker.pause();
                break;
            case "abort":
                // Abort will be handled by the caller checking costTracker.isExceeded
                // before making new LLM calls
                this.costTracker.pause();
                break;
            case "warn":
                // No action — just the event
                break;
        }
    }
}
```

#### D. Collecter les USAGE_UPDATE des agents dans le cost tracker

Dans `wireAgentEvents()`, ajouter un handler spécifique pour `USAGE_UPDATE` :

```typescript
// Dans wireAgentEvents(), ajouter :
agent.on(AgentEvent.USAGE_UPDATE, (...args: unknown[]) => {
    const payload = (args[0] ?? {}) as Record<string, unknown>;

    const contextUsed = payload.contextUsed as number | undefined;
    const contextSize = payload.contextSize as number | undefined;
    const cost = payload.cost as number | undefined;

    // Estimate input/output split (rough — ACP doesn't distinguish)
    if (contextUsed !== undefined) {
        const estimatedInput = Math.ceil(contextUsed * 0.7);
        const estimatedOutput = contextUsed - estimatedInput;
        this.costTracker.recordAgentUsage(
            agent.id,
            estimatedInput,
            estimatedOutput,
            cost,
        );

        // Check budget
        this.handleBudgetSignal(this.costTracker.checkBudget());
    }
});
```

#### E. Vérifier le budget avant chaque appel LLM de la pool

Ajouter un guard dans les méthodes qui font des appels LLM :

```typescript
/**
 * Guard that checks if pool LLM calls are allowed.
 * Returns false if the budget is exceeded and the action is "pause" or "abort".
 */
private canMakePoolLlmCall(): boolean {
    if (this.costTracker.isPaused) {
        this.logger.debug("Pool LLM call blocked — budget paused");
        return false;
    }
    return true;
}
```

Utiliser ce guard avant les appels dans `handleDelta()`, `analyzeIntent()`, `generateSummary()`, et les méthodes des sous-systèmes (orchestrator, checkpoint, etc.) :

```typescript
// Exemple dans handleDelta() :
private async handleDelta(delta: ContextDelta): Promise<void> {
    try {
        // Information Sharing
        if (this.informationBroker && this.contextTracker.agentCount > 1) {
            if (this.canMakePoolLlmCall()) {
                const decisions = await this.informationBroker.evaluate(delta);
                // ... existing sharing logic ...
            }
        }

        // Notification Engine
        if (this.canMakePoolLlmCall()) {
            const agentState = this.contextTracker.getAgentState(delta.agentId);
            if (agentState) {
                const notification = await this.notificationEngine.evaluate(delta, agentState);
                // ... existing notification logic ...
            }
        }

        // Auto-compression check
        await this.checkConversationCompression();
    } catch (error) {
        // ... existing error handling ...
    }
}
```

#### F. Compression automatique dans `handleDelta()`

```typescript
/**
 * Checks all conversations and compresses any that exceed the threshold.
 * Called periodically from handleDelta() (fire-and-forget).
 */
private async checkConversationCompression(): Promise<void> {
    if (!this.compressionConfig.enabled) return;

    const threshold = this.compressionConfig.compressionThresholdTokens ?? 50_000;
    const excludeRoles = this.compressionConfig.excludeRoles ?? [];

    const rolesToCheck: ConversationRole[] = [
        ConversationRole.PLANNER,
        ConversationRole.CONTEXT_ANALYZER,
        ConversationRole.SHARING_ANALYZER,
        ConversationRole.USER_INTERACTION,
        ConversationRole.ORCHESTRATOR,
    ].filter(role =>
        !excludeRoles.includes(role) &&
        this.conversations.has(role) &&
        this.conversations.needsCompression(role, threshold)
    );

    for (const role of rolesToCheck) {
        const saved = await this.conversations.compress(role, this.compressionConfig);
        if (saved > 0) {
            this.costTracker.recordPoolCall("compression",
                Math.ceil(saved * 0.3), // Rough estimate of compression input
                Math.ceil(saved * 0.1), // Rough estimate of compression output
            );
        }
    }
}
```

#### G. Inclure le usage dans `AgentPoolResult`

Dans `execute()`, après la phase de summary :

```typescript
const poolResult: AgentPoolResult = {
    task,
    strategy: analysis.strategy,
    analysis,
    agents: executionResults,
    summary,
    durationMs,
    usage: this.costTracker.getSnapshot(), // ← NEW
};
```

#### H. Inclure le usage dans `AgentPoolState`

Dans `getState()` :

```typescript
getState(): AgentPoolState {
    // ... existing state ...

    return {
        // ... existing fields ...
        currentUsage: this._executing ? this.costTracker.getSnapshot() : null,
        budgetUsagePercent: this.costTracker.getBudgetUsagePercent(),
        budgetWarning: this.costTracker.warningEmitted,
    };
}
```

#### I. Reset le cost tracker entre les exécutions

Dans le `finally` block de `execute()` :

```typescript
} finally {
    // ... existing cleanup ...
    this.costTracker.reset();
}
```

#### J. Log le résumé de consommation en fin d'exécution

Avant le return de `execute()`, logger un résumé :

```typescript
const usageSnapshot = this.costTracker.getSnapshot();
this.logger.info(
    {
        totalTokens: usageSnapshot.totalTokens,
        inputTokens: usageSnapshot.inputTokens,
        outputTokens: usageSnapshot.outputTokens,
        estimatedCostUsd: usageSnapshot.estimatedCostUsd,
        totalLlmCalls: this.costTracker.totalCallCount,
        breakdown: {
            agents: usageSnapshot.breakdown.agents.totalTokens,
            planner: usageSnapshot.breakdown.planner.totalTokens,
            sharing: usageSnapshot.breakdown.sharingAnalyzer.totalTokens,
            notification: usageSnapshot.breakdown.contextAnalyzer.totalTokens,
            orchestrator: usageSnapshot.breakdown.orchestrator.totalTokens,
            checkpoint: usageSnapshot.breakdown.checkpoint.totalTokens,
            reflection: usageSnapshot.breakdown.reflection.totalTokens,
        },
    },
    `Usage summary: ${usageSnapshot.totalTokens} tokens, ${this.costTracker.totalCallCount} LLM calls` +
    (usageSnapshot.estimatedCostUsd !== null ? `, $${usageSnapshot.estimatedCostUsd.toFixed(4)}` : ""),
);
```

### 7. Enrichir le prompt de Summary avec les données de coût

Modifier le template `SUMMARY_SOURCE` dans `summary.ts` pour inclure les stats de consommation :

```handlebars
{{#if usage}}
## Resource Usage
- **Total Tokens**: {{usage.totalTokens}} (input: {{usage.inputTokens}}, output: {{usage.outputTokens}})
{{#if usage.estimatedCostUsd}}- **Estimated Cost**: ${{usage.estimatedCostUsd}}
{{/if}}- **LLM Calls**: agents={{usage.breakdown.agents.callCount}}, pool={{poolLlmCallCount}}
{{/if}}
```

Passer les données dans `generateSummary()` :

```typescript
const prompt = summaryPrompt({
    task,
    strategy: analysis.strategy,
    complexity: analysis.complexity,
    planningReasoning: analysis.reasoning,
    agents: results,
    durationMs,
    coordination: coordinationStats,
    usage: this.costTracker.getSnapshot(), // ← NEW
    poolLlmCallCount: this.costTracker.totalCallCount - this.costTracker.getSnapshot().breakdown.agents.callCount,
});
```

---

## Configuration examples

### Pas de limite (défaut)

```typescript
const pool = new AgentPool({
    openRouterApiKey: "...",
    // Pas de tokenBudget → tracking actif mais pas de limite
});

const result = await pool.execute("Build a REST API");
console.log(result.usage.totalTokens);      // 45000
console.log(result.usage.estimatedCostUsd);  // 0.12
console.log(result.usage.breakdown.planner.callCount); // 2
```

### Budget strict en tokens

```typescript
const pool = new AgentPool({
    openRouterApiKey: "...",
    tokenBudget: {
        maxTotalTokens: 100_000,
        warningThreshold: 0.75,
        onExceeded: "pause",
    },
});

pool.on(PoolEvent.BUDGET_WARNING, (e) => {
    console.warn(`${Math.round(e.budgetUsagePercent * 100)}% budget used`);
});

pool.on(PoolEvent.BUDGET_EXCEEDED, (e) => {
    console.error(`Budget exceeded — action: ${e.action}`);
});
```

### Budget en coût USD

```typescript
const pool = new AgentPool({
    openRouterApiKey: "...",
    tokenBudget: {
        maxCostUsd: 1.00, // Max $1 par exécution
        warningThreshold: 0.8,
        onExceeded: "abort",
    },
});
```

### Compression agressive

```typescript
const pool = new AgentPool({
    openRouterApiKey: "...",
    conversationCompression: {
        enabled: true,
        compressionThresholdTokens: 20_000,
        retentionRatio: 0.2, // Garder seulement 20% des messages récents
        maxCompressions: 5,
    },
});
```

### Désactiver la compression

```typescript
const pool = new AgentPool({
    openRouterApiKey: "...",
    conversationCompression: {
        enabled: false,
    },
});
```

---

## Interaction avec les évolutions précédentes

### Avec l'évolution 09 (Seuil dynamique)

Quand le budget approche de la limite, le seuil de significance devrait augmenter automatiquement pour réduire le nombre d'évaluations LLM. Le `computeThreshold()` de l'évolution 09 peut être enrichi pour prendre en compte `costTracker.getBudgetUsagePercent()`.

### Avec l'évolution 14 (DecisionJournal)

Les entrées du `DecisionJournal` contiennent le reasoning des décisions LLM. Quand une conversation est compressée, le journal reste intact (il est indépendant des conversations).

### Avec l'évolution 16 (OrchestratorEngine)

L'orchestrator peut inclure les données de consommation dans son évaluation : « la consommation de tokens est 3x plus élevée que la moyenne — les agents sont peut-être bloqués en boucle ».

### Avec l'évolution 17 (ReflectionEngine)

La réflexion post-exécution peut inclure les données de coût dans son analyse : « cette exécution a consommé 200k tokens, dont 60% pour le sharing — le seuil de significance devrait être augmenté pour ce type de tâche ».

---

## Gestion de la précision des estimations

### Estimation vs données réelles

Le tracking utilise deux sources de données :

1. **Données réelles OpenRouter** : l'API retourne `usage.prompt_tokens`, `usage.completion_tokens`, et `usage.total_cost` dans la réponse. Ces données sont précises.

2. **Estimation heuristique** : quand les données réelles ne sont pas disponibles (ACP agents, fallback), on utilise `chars / 4` comme estimation grossière.

### Priorisation

- Pour les appels de la pool (via `ConversationManager`), utiliser les données réelles d'OpenRouter quand disponibles.
- Pour les agents ACP, utiliser les données des événements `USAGE_UPDATE` quand disponibles, sinon estimer.
- Le coût USD n'est disponible que depuis OpenRouter — les agents ACP ne le fournissent généralement pas.

### Ne pas bloquer sur l'absence de données

Si OpenRouter ne retourne pas de données de usage (erreur, timeout, etc.), le cost tracker doit continuer à fonctionner avec les estimations. Le tracking est best-effort.

---

## Tests à implémenter

### Tests unitaires pour `CostTracker`

#### Test 1 : `recordPoolCall` incrémente les compteurs correctement

- Setup : créer un `CostTracker` sans budget
- Appeler `recordPoolCall("planner", 100, 50, 0.001)`
- Assert : `getSnapshot().breakdown.planner.callCount === 1`
- Assert : `getSnapshot().breakdown.planner.inputTokens === 100`
- Assert : `getSnapshot().breakdown.planner.outputTokens === 50`
- Assert : `getSnapshot().breakdown.planner.totalTokens === 150`
- Assert : `getSnapshot().breakdown.planner.estimatedCostUsd === 0.001`

#### Test 2 : `recordAgentUsage` incrémente les compteurs agents

- Setup : créer un `CostTracker`
- Appeler `recordAgentUsage("agent-1", 1000, 500, 0.01)`
- Appeler `recordAgentUsage("agent-2", 2000, 800, 0.02)`
- Assert : `getSnapshot().breakdown.agents.callCount === 2`
- Assert : `getSnapshot().breakdown.agents.totalTokens === 4300`
- Assert : `getSnapshot().breakdown.agents.estimatedCostUsd === 0.03`

#### Test 3 : `getTotalTokens` agrège toutes les sources

- Setup : enregistrer des appels sur 3 sources différentes
- Assert : `getTotalTokens()` retourne la somme de tous les tokens

#### Test 4 : `getTotalCost` retourne null quand aucun coût n'est enregistré

- Setup : enregistrer des appels sans costUsd
- Assert : `getTotalCost() === null`

#### Test 5 : `checkBudget` retourne `ok` sans budget configuré

- Setup : créer un `CostTracker` avec `budget: null`
- Assert : `checkBudget()` retourne `{ type: "ok" }`

#### Test 6 : `checkBudget` retourne `warning` au seuil

- Setup : budget `{ maxTotalTokens: 1000, warningThreshold: 0.8 }`
- Enregistrer 850 tokens
- Assert : `checkBudget()` retourne `{ type: "warning", budgetType: "tokens", percent: 0.85 }`

#### Test 7 : `checkBudget` warning est sticky (une seule fois)

- Setup : même que test 6
- Assert : premier `checkBudget()` retourne `warning`
- Assert : deuxième `checkBudget()` retourne `ok` (sans ajout de tokens)
- Enregistrer 50 tokens supplémentaires
- Assert : `checkBudget()` retourne `ok` (warning déjà émis)

#### Test 8 : `checkBudget` retourne `exceeded` au-delà du budget

- Setup : budget `{ maxTotalTokens: 1000 }`
- Enregistrer 1100 tokens
- Assert : `checkBudget()` retourne `{ type: "exceeded", budgetType: "tokens" }`

#### Test 9 : `checkBudget` exceeded est retourné à chaque appel

- Setup : même que test 8
- Assert : premier `checkBudget()` retourne `exceeded`
- Assert : deuxième `checkBudget()` retourne aussi `exceeded`

#### Test 10 : `checkBudget` fonctionne avec le budget coût

- Setup : budget `{ maxCostUsd: 0.50, warningThreshold: 0.8 }`
- Enregistrer des appels avec costUsd totalisant $0.42
- Assert : `checkBudget()` retourne `warning`
- Enregistrer $0.10 supplémentaires
- Assert : `checkBudget()` retourne `exceeded`

#### Test 11 : `getBudgetUsagePercent` retourne le bon pourcentage

- Setup : budget `{ maxTotalTokens: 10000 }`
- Enregistrer 3000 tokens
- Assert : `getBudgetUsagePercent() === 0.3`

#### Test 12 : `getBudgetUsagePercent` retourne null sans budget

- Setup : `budget: null`
- Assert : `getBudgetUsagePercent() === null`

#### Test 13 : `pause()` met le tracker en mode paused

- Appeler `pause()`
- Assert : `isPaused === true`

#### Test 14 : `reset()` remet tout à zéro

- Setup : enregistrer des appels, émettre un warning
- Appeler `reset()`
- Assert : `getTotalTokens() === 0`
- Assert : `warningEmitted === false`
- Assert : `isPaused === false`
- Assert : `isExceeded === false`
- Assert : `totalCallCount === 0`

#### Test 15 : `getSnapshot` retourne une copie immutable

- Setup : prendre un snapshot, puis enregistrer un appel supplémentaire
- Assert : le snapshot original n'a pas changé

### Tests unitaires pour la compression dans `ConversationManager`

#### Test 16 : `compress` réduit le nombre de messages

- Setup : enregistrer une conversation avec 10 messages
- Appeler `compress()` avec `retentionRatio: 0.3`
- Assert : la conversation a maintenant 3 messages (system + compressed + ~2 récents)
- Assert : le premier message est toujours le system prompt

#### Test 17 : `compress` préserve le system prompt original

- Setup : conversation avec un system prompt spécifique
- Appeler `compress()`
- Assert : `messages[0].content` est inchangé

#### Test 18 : `compress` n'agit pas avec moins de 4 messages

- Setup : conversation avec 3 messages
- Appeler `compress()`
- Assert : retourne 0
- Assert : les messages sont inchangés

#### Test 19 : `compress` respecte `maxCompressions`

- Setup : `maxCompressions: 2`
- Appeler `compress()` 2 fois
- Au 3ème appel, la conversation est reset (pas compressée)

#### Test 20 : `needsCompression` retourne true quand le seuil est dépassé

- Setup : conversation avec `tokenCount` = 60000
- Assert : `needsCompression(role, 50000) === true`
- Assert : `needsCompression(role, 70000) === false`

#### Test 21 : `compress` retourne une estimation des tokens sauvés

- Setup : conversation volumineuse
- Appeler `compress()`
- Assert : retourne un nombre > 0

### Tests unitaires pour le callback de usage dans `ConversationManager`

#### Test 22 : `setUsageCallback` est appelé après chaque `send()`

- Mocker le `OpenRouterClient` pour retourner une réponse
- Définir le callback via `setUsageCallback()`
- Appeler `send()`
- Assert : le callback a été appelé avec le bon role, inputTokens > 0, outputTokens > 0

#### Test 23 : Le callback n'est pas appelé quand `send()` échoue

- Mocker le client pour throw
- Assert : le callback n'est pas appelé

#### Test 24 : Le callback fonctionne pour `sendOneShot()` aussi

- Même test que 22 mais avec `sendOneShot()`
- Assert : le callback est appelé

### Tests d'intégration

#### Test 25 : `AgentPool.execute()` inclut `usage` dans le résultat

- Exécuter une tâche
- Assert : `result.usage` est un `UsageSnapshot` valide
- Assert : `result.usage.totalTokens > 0`
- Assert : `result.usage.breakdown.planner.callCount >= 1`

#### Test 26 : `AgentPool.getState()` inclut les données de consommation pendant l'exécution

- Pendant une exécution, appeler `getState()`
- Assert : `state.currentUsage` n'est pas null
- Assert : `state.currentUsage.totalTokens >= 0`

#### Test 27 : Le budget warning est émis au seuil

- Configurer un budget de 10000 tokens
- Mocker les appels pour consommer ~8500 tokens
- Assert : l'événement `BUDGET_WARNING` est émis une fois

#### Test 28 : Le budget exceeded avec `onExceeded: "pause"` bloque les appels pool

- Configurer un budget de 5000 tokens avec `onExceeded: "pause"`
- Consommer plus de 5000 tokens
- Assert : l'événement `BUDGET_EXCEEDED` est émis
- Assert : les appels de sharing/notification sont skippés
- Assert : les agents en cours continuent

#### Test 29 : Le cost tracker est reset entre les exécutions

- Exécuter une tâche
- Vérifier que `result.usage.totalTokens > 0`
- Exécuter une deuxième tâche
- Assert : la deuxième exécution a un usage indépendant

#### Test 30 : La compression se déclenche automatiquement

- Configurer `compressionThresholdTokens: 100` (très bas pour le test)
- Enregistrer une conversation volumineuse
- Déclencher un delta
- Assert : la compression est déclenchée
- Assert : le nombre de messages a diminué

#### Test 31 : L'usage résumé est loggé en fin d'exécution

- Exécuter une tâche
- Assert : un log `info` contenant "Usage summary" est émis

### Tests de non-régression

#### Test 32 : Le pool fonctionne sans `tokenBudget` ni `conversationCompression`

- Créer un pool avec la config minimale (juste `openRouterApiKey`)
- Exécuter une tâche
- Assert : `result.usage` existe et est valide
- Assert : `result.usage.estimatedCostUsd` peut être null (pas de données)

#### Test 33 : Le `ConversationManager` fonctionne sans callback de usage

- Ne pas appeler `setUsageCallback()`
- Assert : `send()` et `sendJson()` fonctionnent normalement

#### Test 34 : Les conversations one-shot ne sont jamais compressées

- L'intent analyzer utilise `sendOneShotJson()` — pas d'historique
- Assert : `needsCompression()` retourne false pour les conversations sans historique

#### Test 35 : La compression n'affecte pas les conversations exclues

- Configurer `excludeRoles: [ConversationRole.PLANNER]`
- Même avec un planner dépassant le seuil, pas de compression
- Assert : les messages du planner sont intacts

---

## Critères de validation

- [ ] Le `CostTracker` agrège correctement les tokens de toutes les sources (agents + pool)
- [ ] Le `UsageSnapshot` est inclus dans `AgentPoolResult` après chaque exécution
- [ ] Le `UsageBreakdown` détaille la consommation par source (planner, sharing, notification, etc.)
- [ ] Le budget warning est émis une seule fois quand le seuil est atteint
- [ ] Le budget exceeded déclenche l'action configurée (`warn`, `pause`, ou `abort`)
- [ ] En mode `pause`, les appels LLM de la pool sont bloqués mais les agents continuent
- [ ] En mode `abort`, l'exécution est interrompue
- [ ] Le `ConversationManager` reporte la consommation via le callback de usage
- [ ] Les données réelles OpenRouter sont utilisées quand disponibles (au lieu des estimations)
- [ ] La compression se déclenche automatiquement quand une conversation dépasse le seuil
- [ ] La compression préserve le system prompt et les messages les plus récents
- [ ] La compression respecte `maxCompressions` et fait un reset hard après
- [ ] Le cost tracker est reset entre les exécutions
- [ ] Le pool fonctionne identiquement sans budget configuré (tracking passif)
- [ ] Les conversations one-shot ne sont jamais compressées
- [ ] Tous les tests existants passent toujours

---

## Points d'attention

1. **Ne pas modifier le type de retour des méthodes publiques du `ConversationManager`** — `send()` retourne toujours `string`, `sendJson()` retourne toujours `T`. Le tracking est un side-effect interne.

2. **Le callback de usage est optionnel** — le `ConversationManager` doit fonctionner sans callback (backward compatibility pour les tests et usages standalone).

3. **La compression est un appel LLM supplémentaire** — elle coûte des tokens. Le cost tracker doit enregistrer ce coût sous la source `"compression"`. Ne pas déclencher la compression si le budget est déjà en mode `paused`.

4. **Le `_compressionCount` sur `Conversation` est un hack** — idéalement, ajouter un champ optionnel au type `Conversation`. Mais pour limiter le blast radius de cette évolution, le cast est acceptable.

5. **L'estimation input/output pour les agents ACP est grossière** (70/30 split) — c'est un compromis acceptable car les agents ACP ne fournissent souvent que le total. Si l'ACP fournit des données plus détaillées à l'avenir, le tracker peut être enrichi.

6. **Le budget en USD dépend de la disponibilité des données de coût** — si OpenRouter ne retourne pas de `total_cost`, le budget en USD est ineffectif. Logger un warning dans ce cas pour informer l'utilisateur.

7. **Ne pas déclencher `checkConversationCompression()` à chaque delta** — cela ferait trop d'appels à `needsCompression()`. Déclencher toutes les 10 deltas ou toutes les 30 secondes, au choix. Utiliser un counter/timer simple.

8. **La modification de `OpenRouterClient.chat()` pour retourner `ChatResult` est invasive** — considérer d'abord une approche non-breaking : ajouter une méthode `chatWithUsage()` séparée, et migrer progressivement les call sites. Ou bien, stocker le dernier usage dans un champ mutable de `OpenRouterClient` que le `ConversationManager` lit après chaque appel.

9. **Le `reset()` du cost tracker dans le `finally` block signifie que le snapshot final doit être capturé avant le cleanup** — s'assurer que `getSnapshot()` est appelé avant `reset()`.

10. **Les données de `USAGE_UPDATE` sont cumulatives dans certains agents ACP** — le tracker doit gérer le cas où les valeurs augmentent progressivement (différentiel) vs le cas où chaque event est indépendant. Commencer par l'approche indépendante et ajuster si nécessaire.