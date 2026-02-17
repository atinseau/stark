# Évolution 21 — Mémoire persistante inter-exécutions

## Priorité : 🟢 P3

## Dépendances : Évolution 17 (Post-execution reflection), Évolution 19 (Cost & token budget management)

## Acquis des évolutions précédentes

- **Évolution 01** : Le mapping `subtaskToAgent` / `agentToSubtask` est fonctionnel dans l'`InformationBroker`.
- **Évolution 02** : Le `SharingHistory` déduplique les partages intra-exécution.
- **Évolution 03** : Le `ProjectScanner` injecte le contexte projet (fichiers, langages, frameworks) dans le planner.
- **Évolution 04** : Des exemples few-shot enrichissent tous les prompts LLM.
- **Évolution 05** : La conversation `SHARING_ANALYZER` est séparée de `CONTEXT_ANALYZER`.
- **Évolution 06** : Les prompts notification et summary sont nettoyés et enrichis avec les `CoordinationStats`.
- **Évolution 07** : Les résultats complets de prompt sont partagés (pas juste 500 chars).
- **Évolution 08** : Le `StructuredContextInjection` avec priorité, catégorie et source structure les injections.
- **Évolution 09** : Le seuil de significance est dynamique selon la phase et les dépendances.
- **Évolution 10** : Le timeout et retry par subtask sont implémentés (`SubtaskTimeoutConfig`, `SubtaskRetryConfig`).
- **Évolution 11** : Le re-planning adaptatif (`TaskPlanner.replan()`) permet de modifier le plan en cours d'exécution.
- **Évolution 12** : Le multi-intent et l'historique conversationnel sont supportés dans l'intent analyzer.
- **Évolution 13** : Le `PlannerMemory` avec mémoire glissante persiste les résumés d'exécutions passées (en RAM uniquement, perdu au `destroy()`).
- **Évolution 14** : Le `DecisionJournal` maintient une mémoire de session pour le context analyzer intra-exécution.
- **Évolution 15** : Les `CheckpointEvaluator` effectuent des évaluations mid-execution avec des `CheckpointResult`.
- **Évolution 16** : L'`OrchestratorEngine` produit des `OrchestratorAssessment` et des `OrchestratorDirective`.
- **Évolution 17** : Le `ReflectionEngine` produit des `ExecutionReflection` et des `ExecutionInsight` après chaque exécution. Les insights survivent entre les `execute()` mais sont perdus au `destroy()` ou au redémarrage du process.
- **Évolution 18** : Le `ConflictDetector` détecte les conflits inter-agents (structurels et sémantiques).
- **Évolution 19** : Le `CostTracker` agrège les coûts et le `ConversationManager.compress()` compresse les conversations longues.
- **Évolution 20** : La `TaskQueue` gère l'exécution séquentielle et concurrente de tâches.

---

## Contexte du problème

Après l'évolution 17, le système génère des `ExecutionInsight`s et des `ExecutionReflection`s de haute qualité. Après l'évolution 13, le `PlannerMemory` accumule les résumés d'exécutions passées pour guider les planifications futures. Mais toute cette intelligence **disparaît** dès que la pool est détruite ou que le process redémarre :

```typescript
// Dans AgentPool.destroy()
async destroy(): Promise<void> {
    // ...
    this._destroyed = true;
    await this.destroyManagedAgents();
    // → Les PlannerMemory, ExecutionInsights, ExecutionReflections
    //   sont toutes des structures in-memory qui meurent ici.
}
```

### Ce qui est perdu aujourd'hui

1. **`PlannerMemory[]`** (évolution 13) — Les résumés d'exécutions passées (tâche, stratégie, rôles, outcome, leçons, fichiers) qui guident le planner sur les follow-up tasks.
2. **`ExecutionInsight[]`** (évolution 17) — Les patterns appris par la réflexion post-exécution (ex : « le splitting backend/frontend fonctionne bien pour les projets web »).
3. **`ExecutionReflection[]`** (évolution 17) — Les réflexions complètes avec `effectivenessScore`, `decompositionAssessment`, `sharingAssessment`.
4. **`UsageSnapshot[]`** (évolution 19) — L'historique de consommation de tokens/coûts par exécution.
5. **Les patterns de coordination** — Quels types de partage ont été utiles, quels conflits récurrents ont été détectés, quels types de tâches bénéficient réellement du multi-agent.

### Conséquences

- Chaque nouvelle instance d'`AgentPool` repart de zéro — aucun apprentissage n'est capitalisé.
- Les mêmes erreurs de planification sont répétées entre les sessions.
- Le planner ne sait pas que la même tâche a déjà été tentée (et a peut-être échoué).
- Les insights de haute confiance accumulés au fil de 10 exécutions sont perdus.
- Aucune possibilité d'auditer l'historique d'exécutions pour le debugging.

### Ce que cette évolution résout

Un système de **mémoire persistante** qui :
1. **Sauvegarde** automatiquement les données apprises après chaque exécution
2. **Charge** les données au démarrage d'une nouvelle pool
3. **Injecte** les insights et patterns pertinents dans les prompts du planner
4. **Expose** un historique navigable pour l'audit et le debugging
5. **Gère** la croissance des données avec des politiques de rétention configurables

---

## Fichiers impactés

| Fichier | Action |
|---------|--------|
| `src/types/agent-pool.types.ts` | Ajouter `ExecutionMemoryConfig`, `PersistedMemory`, `MemoryAdapter` |
| `src/classes/agent-pool/memory-store.ts` | **Nouveau** — Classe `MemoryStore` pour la persistance |
| `src/classes/agent-pool/adapters/file-memory-adapter.ts` | **Nouveau** — Adapter fichier (NDJSON) par défaut |
| `src/classes/agent-pool/adapters/index.ts` | **Nouveau** — Export des adapters |
| `src/classes/agent-pool/agent-pool.ts` | Intégrer le `MemoryStore`, charger au démarrage, sauvegarder après exécution |
| `src/classes/agent-pool/task-planner.ts` | Charger les mémoires persistées au lieu des seules RAM memories |
| `src/prompts/planning.ts` | Enrichir le system/user prompt avec les insights persistés |
| `src/prompts/index.ts` | Exporter les nouveaux templates si nécessaire |

---

## Spécification détaillée des changements

### 1. Nouveaux types dans `agent-pool.types.ts`

#### Type `MemoryAdapter`

Interface abstraite pour la persistance. Le pattern Adapter permet de supporter différents backends (fichier, SQLite, Redis, S3, etc.) sans coupler le core au mécanisme de stockage.

```typescript
/**
 * Interface abstraite pour la persistance de la mémoire inter-exécutions.
 *
 * Implémentée par des adapters concrets (fichier, base de données, etc.).
 * Le MemoryStore utilise cet adapter pour lire et écrire les données.
 *
 * Chaque méthode doit être idempotente et safe en cas d'erreur I/O :
 * le système doit pouvoir fonctionner même si la persistance échoue.
 */
export interface MemoryAdapter {
    /**
     * Charge toute la mémoire persistée depuis le backend.
     * Retourne `null` si aucune mémoire n'existe (premier lancement).
     * Ne doit JAMAIS throw — retourner `null` en cas d'erreur.
     */
    load(): Promise<PersistedMemory | null>;

    /**
     * Sauvegarde l'intégralité de la mémoire dans le backend.
     * Doit être atomique ou au minimum crash-safe (écriture dans un
     * fichier temporaire puis rename).
     *
     * @returns `true` si la sauvegarde a réussi, `false` sinon.
     */
    save(memory: PersistedMemory): Promise<boolean>;

    /**
     * Supprime toute la mémoire persistée.
     * Utilisé pour le reset manuel (ex: `pool.clearMemory()`).
     */
    clear(): Promise<void>;

    /**
     * Retourne le chemin ou l'identifiant du backend de stockage.
     * Utilisé pour le logging et le debugging.
     */
    readonly location: string;
}
```

#### Type `PersistedMemory`

Structure complète de ce qui est sauvegardé :

```typescript
/**
 * Structure de la mémoire persistée entre les exécutions.
 *
 * Contient toutes les données apprises par la pool au fil des
 * exécutions, dans un format sérialisable en JSON.
 */
export interface PersistedMemory {
    /** Version du schema pour la migration future. */
    readonly version: number;

    /** ISO-8601 timestamp de la dernière sauvegarde. */
    readonly lastSavedAt: string;

    /** Nombre total d'exécutions enregistrées depuis la création. */
    readonly totalExecutions: number;

    /**
     * Résumés d'exécutions passées (ex-`PlannerMemory`).
     * Utilisés par le planner pour contextualiser les planifications futures.
     */
    readonly executionSummaries: PersistedExecutionSummary[];

    /**
     * Insights appris par le `ReflectionEngine` (ex-`ExecutionInsight`).
     * Filtrés par confiance et pertinence avant injection dans les prompts.
     */
    readonly insights: PersistedInsight[];

    /**
     * Patterns de coordination observés sur plusieurs exécutions.
     * Agrégés automatiquement à partir des réflexions individuelles.
     */
    readonly coordinationPatterns: CoordinationPattern[];

    /**
     * Historique de consommation agrégé par exécution.
     * Permet de monitorer les tendances de coût.
     */
    readonly usageHistory: PersistedUsageRecord[];

    /**
     * Tâches connues — index des tâches déjà exécutées avec leur hash.
     * Permet de détecter les ré-exécutions de tâches similaires.
     */
    readonly knownTasks: KnownTask[];
}
```

#### Types de données individuelles

```typescript
/**
 * Résumé d'exécution persisté.
 * Dérivé de `PlannerMemory` (évolution 13) avec des champs additionnels
 * pour l'historique long-terme.
 */
export interface PersistedExecutionSummary {
    /** Identifiant unique de l'exécution. */
    readonly id: string;

    /** Description courte de la tâche (tronquée à 200 chars). */
    readonly task: string;

    /** Hash normalisé de la tâche pour la déduplication. */
    readonly taskHash: string;

    /** Stratégie choisie par le planner. */
    readonly strategy: ExecutionStrategy;

    /** Complexité évaluée. */
    readonly complexity: TaskComplexity;

    /** Rôles assignés aux agents. */
    readonly roles: string[];

    /** Résultat de l'exécution : "success", "partial", "failure". */
    readonly outcome: "success" | "partial" | "failure";

    /** Leçons tirées par le planner (résumé textuel). */
    readonly lessons: string;

    /** Fichiers affectés (créés, modifiés) — top 20. */
    readonly filesAffected: string[];

    /** Score d'efficacité issu de la réflexion (0.0-1.0), ou null si pas de réflexion. */
    readonly effectivenessScore: number | null;

    /** Évaluation de la décomposition par le ReflectionEngine. */
    readonly decompositionAssessment: string | null;

    /** Évaluation du partage par le ReflectionEngine. */
    readonly sharingAssessment: string | null;

    /** Durée de l'exécution en millisecondes. */
    readonly durationMs: number;

    /** ISO-8601 timestamp de l'exécution. */
    readonly timestamp: string;
}

/**
 * Insight persisté.
 * Dérivé de `ExecutionInsight` (évolution 17) avec un compteur d'occurrences.
 */
export interface PersistedInsight {
    /** Identifiant unique de l'insight. */
    readonly id: string;

    /** Catégorie : "planning", "sharing", "coordination", "error_handling". */
    readonly category: string;

    /** Confiance dans cet insight (0.0-1.0). Augmente avec les confirmations. */
    confidence: number;

    /** Le pattern ou la leçon apprise. */
    readonly insight: string;

    /** Conditions d'applicabilité (quand ce pattern s'applique). */
    readonly applicableWhen: string;

    /** Polarité : "positive" (à reproduire) ou "negative" (à éviter). */
    readonly polarity: "positive" | "negative";

    /**
     * Nombre de fois que cet insight a été confirmé par des réflexions indépendantes.
     * Un insight confirmé 5 fois est très fiable.
     */
    confirmationCount: number;

    /** ISO-8601 timestamp de la première observation. */
    readonly firstSeenAt: string;

    /** ISO-8601 timestamp de la dernière confirmation. */
    lastConfirmedAt: string;
}

/**
 * Pattern de coordination agrégé sur plusieurs exécutions.
 * Construit automatiquement à partir des `ExecutionReflection`.
 */
export interface CoordinationPattern {
    /** Identifiant unique du pattern. */
    readonly id: string;

    /**
     * Type de pattern observé :
     * - "effective_split" : un type de décomposition qui fonctionne bien
     * - "ineffective_split" : un type de décomposition qui fonctionne mal
     * - "sharing_benefit" : un type de partage qui améliore les résultats
     * - "sharing_noise" : un type de partage qui est du bruit
     * - "recurring_conflict" : un conflit qui se reproduit
     * - "optimal_agent_count" : un nombre d'agents qui fonctionne bien pour un type de tâche
     */
    readonly type: string;

    /** Description textuelle du pattern. */
    readonly description: string;

    /** Nombre d'occurrences observées. */
    observationCount: number;

    /**
     * Confiance dans le pattern (0.0-1.0).
     * Calculée comme moyenne des effectivenessScores des exécutions
     * où ce pattern a été observé.
     */
    confidence: number;

    /** Conditions d'applicabilité (types de tâches, de projets, etc.). */
    readonly applicableWhen: string;

    /** ISO-8601 timestamp de la dernière observation. */
    lastObservedAt: string;
}

/**
 * Enregistrement d'usage par exécution, pour l'historique des coûts.
 */
export interface PersistedUsageRecord {
    /** ISO-8601 timestamp de l'exécution. */
    readonly timestamp: string;

    /** Description courte de la tâche (tronquée). */
    readonly task: string;

    /** Stratégie utilisée. */
    readonly strategy: ExecutionStrategy;

    /** Nombre d'agents utilisés. */
    readonly agentCount: number;

    /** Tokens d'entrée consommés (estimation). */
    readonly inputTokens: number;

    /** Tokens de sortie consommés (estimation). */
    readonly outputTokens: number;

    /** Coût estimé en USD, ou null si non disponible. */
    readonly estimatedCostUsd: number | null;

    /** Durée de l'exécution en millisecondes. */
    readonly durationMs: number;
}

/**
 * Entrée de tâche connue pour la détection de ré-exécution.
 */
export interface KnownTask {
    /** Hash normalisé de la tâche. */
    readonly taskHash: string;

    /** Description courte (tronquée à 100 chars). */
    readonly taskPreview: string;

    /** Nombre de fois que cette tâche (ou une similaire) a été exécutée. */
    executionCount: number;

    /** Dernier résultat : "success", "partial", "failure". */
    readonly lastOutcome: "success" | "partial" | "failure";

    /** Stratégie utilisée la dernière fois. */
    readonly lastStrategy: ExecutionStrategy;

    /** ISO-8601 timestamp de la dernière exécution. */
    lastExecutedAt: string;
}
```

#### Configuration

```typescript
/**
 * Configuration de la mémoire persistante inter-exécutions.
 */
export interface ExecutionMemoryConfig {
    /**
     * Activer/désactiver la mémoire persistante.
     * Défaut : `false` — opt-in explicite.
     */
    readonly enabled?: boolean;

    /**
     * Adapter de persistance à utiliser.
     * Si non fourni et `enabled: true`, un `FileMemoryAdapter` est
     * créé automatiquement avec le chemin par défaut.
     */
    readonly adapter?: MemoryAdapter;

    /**
     * Chemin du fichier de mémoire quand l'adapter par défaut (fichier) est utilisé.
     * Ignoré si un adapter custom est fourni.
     * Défaut : `{cwd}/.stark/memory.json`
     */
    readonly filePath?: string;

    /**
     * Nombre maximum d'exécution summaries conservés.
     * Les plus anciens sont évincés quand la limite est atteinte.
     * Défaut : 50
     */
    readonly maxExecutionSummaries?: number;

    /**
     * Nombre maximum d'insights conservés.
     * Défaut : 100
     */
    readonly maxInsights?: number;

    /**
     * Nombre maximum de coordination patterns conservés.
     * Défaut : 30
     */
    readonly maxCoordinationPatterns?: number;

    /**
     * Nombre maximum d'enregistrements d'usage conservés.
     * Défaut : 100
     */
    readonly maxUsageRecords?: number;

    /**
     * Nombre maximum de tâches connues conservées.
     * Défaut : 200
     */
    readonly maxKnownTasks?: number;

    /**
     * Confiance minimale pour qu'un insight soit persisté.
     * Les insights à basse confiance sont considérés comme du bruit.
     * Défaut : 0.4
     */
    readonly minInsightConfidence?: number;

    /**
     * Nombre maximum d'insights inclus dans le prompt du planner.
     * Défaut : 10
     */
    readonly maxInsightsInPrompt?: number;

    /**
     * Nombre maximum d'exécution summaries inclus dans le prompt du planner.
     * Défaut : 5
     */
    readonly maxSummariesInPrompt?: number;

    /**
     * Nombre maximum de coordination patterns inclus dans le prompt.
     * Défaut : 5
     */
    readonly maxPatternsInPrompt?: number;

    /**
     * Sauvegarder automatiquement après chaque exécution.
     * Si `false`, il faut appeler `pool.saveMemory()` manuellement.
     * Défaut : `true`
     */
    readonly autoSave?: boolean;

    /**
     * Charger automatiquement la mémoire au démarrage de la pool.
     * Si `false`, il faut appeler `pool.loadMemory()` manuellement.
     * Défaut : `true`
     */
    readonly autoLoad?: boolean;
}
```

#### Enrichir `AgentPoolConfig`

```typescript
interface AgentPoolConfig {
    // ... champs existants ...

    /**
     * Configuration de la mémoire persistante inter-exécutions.
     * Permet à la pool d'apprendre au fil des exécutions en sauvegardant
     * les insights, patterns et résumés d'exécutions passées.
     *
     * Opt-in : désactivé par défaut pour préserver le comportement existant.
     */
    readonly executionMemory?: ExecutionMemoryConfig;
}
```

#### Enrichir `AgentPoolResult`

```typescript
interface AgentPoolResult {
    // ... champs existants ...

    /**
     * Indique si la mémoire a été sauvegardée après cette exécution.
     * `null` si la mémoire persistante n'est pas activée.
     */
    readonly memorySaved?: boolean;

    /**
     * Indique si une tâche similaire a déjà été exécutée.
     * Renseigné uniquement si la mémoire persistante est activée.
     */
    readonly previousExecution?: {
        /** Nombre de fois qu'une tâche similaire a été exécutée. */
        readonly count: number;
        /** Dernier résultat de cette tâche. */
        readonly lastOutcome: "success" | "partial" | "failure";
        /** Dernière stratégie utilisée. */
        readonly lastStrategy: ExecutionStrategy;
    } | null;
}
```

#### Enrichir `AgentPoolState`

```typescript
interface AgentPoolState {
    // ... champs existants ...

    /** Statistiques de la mémoire persistante. */
    readonly memory?: {
        /** Si la mémoire persistante est activée. */
        readonly enabled: boolean;
        /** Chemin ou identifiant du backend de stockage. */
        readonly location: string;
        /** Nombre total d'exécutions dans la mémoire. */
        readonly totalExecutions: number;
        /** Nombre d'insights persistés. */
        readonly insightCount: number;
        /** Nombre de coordination patterns. */
        readonly patternCount: number;
        /** Nombre de tâches connues. */
        readonly knownTaskCount: number;
    };
}
```

---

### 2. Nouveau fichier `src/classes/agent-pool/adapters/file-memory-adapter.ts`

Implémentation par défaut basée sur un fichier JSON. C'est le backend le plus simple et le plus portable — aucune dépendance externe.

#### Responsabilités

- Lire le fichier de mémoire au démarrage
- Écrire atomiquement (temp file + rename) après chaque exécution
- Gérer les erreurs I/O gracieusement (retourner `null` au lieu de throw)
- Supporter la migration de schema via le champ `version`
- Créer le répertoire parent si nécessaire

#### Structure

```typescript
import { readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type pino from "pino";
import type { MemoryAdapter, PersistedMemory } from "../../../types/agent-pool.types.ts";

/** Version actuelle du schema de mémoire. */
const CURRENT_SCHEMA_VERSION = 1;

/** Chemin par défaut du fichier de mémoire (relatif au cwd). */
const DEFAULT_MEMORY_PATH = ".stark/memory.json";

/**
 * Adapter de persistance basé sur un fichier JSON.
 *
 * Utilise un pattern d'écriture atomique (temp file + rename) pour
 * éviter la corruption en cas de crash pendant l'écriture.
 *
 * Le fichier est un JSON formaté pour être lisible par un humain.
 * La taille typique est de 50-200 KB après 50 exécutions.
 *
 * @example
 * ```ts
 * const adapter = new FileMemoryAdapter("/project/.stark/memory.json", logger);
 * const memory = await adapter.load();
 * if (memory) {
 *     console.log(`Loaded ${memory.totalExecutions} executions`);
 * }
 * ```
 */
export class FileMemoryAdapter implements MemoryAdapter {
    readonly location: string;

    constructor(
        filePath?: string,
        private readonly cwd?: string,
        private readonly logger?: pino.Logger,
    ) {
        this.location = filePath ?? join(cwd ?? process.cwd(), DEFAULT_MEMORY_PATH);
    }

    async load(): Promise<PersistedMemory | null> {
        try {
            const content = await readFile(this.location, "utf-8");
            const data = JSON.parse(content);

            // Schema version check
            if (data.version !== CURRENT_SCHEMA_VERSION) {
                this.logger?.warn(
                    { fileVersion: data.version, currentVersion: CURRENT_SCHEMA_VERSION },
                    "Memory file schema version mismatch — attempting migration",
                );
                return this.migrate(data);
            }

            // Structural validation
            if (!this.validate(data)) {
                this.logger?.warn("Memory file failed validation — ignoring");
                return null;
            }

            this.logger?.info(
                {
                    totalExecutions: data.totalExecutions,
                    insightCount: data.insights?.length ?? 0,
                    patternCount: data.coordinationPatterns?.length ?? 0,
                },
                `Memory loaded: ${data.totalExecutions} execution(s), ${data.insights?.length ?? 0} insight(s)`,
            );

            return data as PersistedMemory;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                // File doesn't exist — first launch, this is expected
                this.logger?.debug("No memory file found — first launch");
                return null;
            }

            this.logger?.warn(
                { error: error instanceof Error ? error.message : String(error) },
                "Failed to load memory file — starting fresh",
            );
            return null;
        }
    }

    async save(memory: PersistedMemory): Promise<boolean> {
        try {
            // Ensure directory exists
            const dir = dirname(this.location);
            await mkdir(dir, { recursive: true });

            // Atomic write: write to temp file, then rename
            const tempPath = `${this.location}.tmp.${Date.now()}`;
            const content = JSON.stringify(memory, null, 2);

            await writeFile(tempPath, content, "utf-8");
            await rename(tempPath, this.location);

            this.logger?.info(
                {
                    path: this.location,
                    sizeBytes: Buffer.byteLength(content, "utf-8"),
                    totalExecutions: memory.totalExecutions,
                },
                `Memory saved (${Buffer.byteLength(content, "utf-8")} bytes)`,
            );

            return true;
        } catch (error) {
            this.logger?.warn(
                { error: error instanceof Error ? error.message : String(error) },
                "Failed to save memory file",
            );
            return false;
        }
    }

    async clear(): Promise<void> {
        try {
            await unlink(this.location);
            this.logger?.info({ path: this.location }, "Memory file deleted");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                this.logger?.warn(
                    { error: error instanceof Error ? error.message : String(error) },
                    "Failed to delete memory file",
                );
            }
        }
    }

    // ── Private ────────────────────────────────────────────────────────

    /**
     * Validates the structural integrity of loaded data.
     * Does NOT validate every field — just checks the top-level shape.
     */
    private validate(data: unknown): boolean {
        if (data == null || typeof data !== "object") return false;
        const obj = data as Record<string, unknown>;

        if (typeof obj.version !== "number") return false;
        if (typeof obj.lastSavedAt !== "string") return false;
        if (typeof obj.totalExecutions !== "number") return false;
        if (!Array.isArray(obj.executionSummaries)) return false;
        if (!Array.isArray(obj.insights)) return false;
        if (!Array.isArray(obj.coordinationPatterns)) return false;
        if (!Array.isArray(obj.usageHistory)) return false;
        if (!Array.isArray(obj.knownTasks)) return false;

        return true;
    }

    /**
     * Attempts to migrate an older schema version to the current one.
     * Returns null if migration is not possible.
     */
    private migrate(data: Record<string, unknown>): PersistedMemory | null {
        // For now, only version 1 exists. Future versions will add
        // migration logic here.
        this.logger?.warn(
            { version: data.version },
            "Cannot migrate unknown schema version — starting fresh",
        );
        return null;
    }
}
```

#### Fichier d'index pour les adapters

```typescript
// src/classes/agent-pool/adapters/index.ts
export { FileMemoryAdapter } from "./file-memory-adapter.ts";
```

---

### 3. Nouveau fichier `src/classes/agent-pool/memory-store.ts`

Classe centrale qui orchestre la mémoire : chargement, sauvegarde, requêtes, agrégation. Elle est indépendante du backend de persistance grâce à l'interface `MemoryAdapter`.

#### Responsabilités

- Charger la mémoire depuis l'adapter au démarrage
- Enregistrer les résultats d'exécution (summaries, insights, usage)
- Agréger les coordination patterns à partir des réflexions
- Appliquer les politiques de rétention (max entries, confiance minimale)
- Fournir des données formatées pour l'injection dans les prompts
- Détecter les tâches similaires déjà exécutées
- Sauvegarder vers l'adapter

#### Structure de la classe

```typescript
import type pino from "pino";
import type {
    CoordinationPattern,
    ExecutionMemoryConfig,
    ExecutionReflection,
    ExecutionStrategy,
    KnownTask,
    MemoryAdapter,
    PersistedExecutionSummary,
    PersistedInsight,
    PersistedMemory,
    PersistedUsageRecord,
    TaskComplexity,
    UsageSnapshot,
} from "../../types/agent-pool.types.ts";
import { isoNow } from "../../utils/formatting.ts";

// ── Constants ──────────────────────────────────────────────────────────────

const CURRENT_SCHEMA_VERSION = 1;

const DEFAULT_MAX_EXECUTION_SUMMARIES = 50;
const DEFAULT_MAX_INSIGHTS = 100;
const DEFAULT_MAX_COORDINATION_PATTERNS = 30;
const DEFAULT_MAX_USAGE_RECORDS = 100;
const DEFAULT_MAX_KNOWN_TASKS = 200;

const DEFAULT_MIN_INSIGHT_CONFIDENCE = 0.4;

const DEFAULT_MAX_INSIGHTS_IN_PROMPT = 10;
const DEFAULT_MAX_SUMMARIES_IN_PROMPT = 5;
const DEFAULT_MAX_PATTERNS_IN_PROMPT = 5;

/** Maximum length of task description stored in summaries. */
const MAX_TASK_LENGTH = 200;

/** Maximum number of files stored per execution summary. */
const MAX_FILES_PER_SUMMARY = 20;

/** Maximum length of lessons string. */
const MAX_LESSONS_LENGTH = 500;

// ── MemoryStore ────────────────────────────────────────────────────────────

/**
 * Manages the pool's persistent inter-execution memory.
 *
 * The MemoryStore is the single source of truth for all learned
 * knowledge. It sits between the pool (which generates data) and the
 * adapter (which persists it). The store handles:
 *
 * - **Loading**: Reads persisted data from the adapter at startup.
 * - **Recording**: Stores new execution results, insights, and usage.
 * - **Querying**: Provides formatted data for prompt injection.
 * - **Aggregation**: Builds coordination patterns from individual reflections.
 * - **Retention**: Applies size limits and confidence thresholds.
 * - **Saving**: Writes the current state to the adapter.
 *
 * ## Thread Safety
 *
 * The store is NOT thread-safe. It is designed to be used by a single
 * AgentPool instance. Concurrent writes from multiple pool instances
 * to the same adapter will cause data loss. Use separate file paths
 * or a database-backed adapter for concurrent pools.
 *
 * ## Failure Tolerance
 *
 * All adapter interactions are wrapped in try/catch. If the adapter
 * fails (disk full, permission denied, etc.), the store continues
 * functioning with in-memory data only — nothing crashes.
 *
 * @example
 * ```ts
 * const store = new MemoryStore(adapter, config, logger);
 *
 * // Load previous memory
 * await store.load();
 *
 * // After an execution
 * store.recordExecution(task, analysis, results, reflection, usage);
 *
 * // Save to disk
 * await store.save();
 *
 * // Get data for the planner
 * const section = store.buildPlannerPromptSection(currentTask);
 * ```
 */
export class MemoryStore {
    private readonly config: Required<
        Pick<
            ExecutionMemoryConfig,
            | "maxExecutionSummaries"
            | "maxInsights"
            | "maxCoordinationPatterns"
            | "maxUsageRecords"
            | "maxKnownTasks"
            | "minInsightConfidence"
            | "maxInsightsInPrompt"
            | "maxSummariesInPrompt"
            | "maxPatternsInPrompt"
            | "autoSave"
            | "autoLoad"
        >
    >;

    /** In-memory state, loaded from the adapter or built fresh. */
    private memory: PersistedMemory;

    /** Whether the memory has been loaded from the adapter. */
    private _loaded = false;

    /** Whether there are unsaved changes. */
    private _dirty = false;

    constructor(
        private readonly adapter: MemoryAdapter,
        config: ExecutionMemoryConfig,
        private readonly logger: pino.Logger,
    ) {
        this.config = {
            maxExecutionSummaries: config.maxExecutionSummaries ?? DEFAULT_MAX_EXECUTION_SUMMARIES,
            maxInsights: config.maxInsights ?? DEFAULT_MAX_INSIGHTS,
            maxCoordinationPatterns: config.maxCoordinationPatterns ?? DEFAULT_MAX_COORDINATION_PATTERNS,
            maxUsageRecords: config.maxUsageRecords ?? DEFAULT_MAX_USAGE_RECORDS,
            maxKnownTasks: config.maxKnownTasks ?? DEFAULT_MAX_KNOWN_TASKS,
            minInsightConfidence: config.minInsightConfidence ?? DEFAULT_MIN_INSIGHT_CONFIDENCE,
            maxInsightsInPrompt: config.maxInsightsInPrompt ?? DEFAULT_MAX_INSIGHTS_IN_PROMPT,
            maxSummariesInPrompt: config.maxSummariesInPrompt ?? DEFAULT_MAX_SUMMARIES_IN_PROMPT,
            maxPatternsInPrompt: config.maxPatternsInPrompt ?? DEFAULT_MAX_PATTERNS_IN_PROMPT,
            autoSave: config.autoSave ?? true,
            autoLoad: config.autoLoad ?? true,
        };

        this.memory = this.buildEmptyMemory();
    }

    // ── Lifecycle ──────────────────────────────────────────────────────

    /**
     * Loads the persisted memory from the adapter.
     *
     * If no memory exists (first launch), the store starts empty.
     * If loading fails, the store starts empty and logs a warning.
     *
     * This method is idempotent — calling it multiple times is safe.
     */
    async load(): Promise<void> {
        try {
            const loaded = await this.adapter.load();

            if (loaded) {
                this.memory = loaded;
                this._loaded = true;
                this._dirty = false;

                this.logger.info(
                    {
                        totalExecutions: loaded.totalExecutions,
                        insightCount: loaded.insights.length,
                        patternCount: loaded.coordinationPatterns.length,
                        knownTaskCount: loaded.knownTasks.length,
                        location: this.adapter.location,
                    },
                    `Memory loaded: ${loaded.totalExecutions} execution(s), ${loaded.insights.length} insight(s), ${loaded.coordinationPatterns.length} pattern(s)`,
                );
            } else {
                this.memory = this.buildEmptyMemory();
                this._loaded = true;

                this.logger.info("No previous memory found — starting fresh");
            }
        } catch (error) {
            this.logger.warn(
                { error: error instanceof Error ? error.message : String(error) },
                "Failed to load memory — starting fresh",
            );

            this.memory = this.buildEmptyMemory();
            this._loaded = true;
        }
    }

    /**
     * Saves the current memory to the adapter.
     *
     * @returns `true` if the save succeeded, `false` otherwise.
     */
    async save(): Promise<boolean> {
        if (!this._dirty) {
            this.logger.debug("No changes to save");
            return true;
        }

        const updatedMemory: PersistedMemory = {
            ...this.memory,
            lastSavedAt: isoNow(),
        };

        const success = await this.adapter.save(updatedMemory);

        if (success) {
            this.memory = updatedMemory;
            this._dirty = false;
        }

        return success;
    }

    /**
     * Clears all persisted memory.
     * Resets the in-memory state and deletes the persisted data.
     */
    async clear(): Promise<void> {
        this.memory = this.buildEmptyMemory();
        this._dirty = false;
        await this.adapter.clear();

        this.logger.info("Memory cleared");
    }

    // ── Recording ──────────────────────────────────────────────────────

    /**
     * Records the results of a completed execution.
     *
     * This is the main data ingestion point. It:
     * 1. Creates a `PersistedExecutionSummary` from the execution results.
     * 2. Merges `ExecutionInsight`s from the reflection, deduplicating
     *    and updating confidence for existing insights.
     * 3. Updates coordination patterns from the reflection's assessments.
     * 4. Records the usage snapshot.
     * 5. Updates the known tasks index.
     * 6. Applies retention limits.
     *
     * @param task - The original task description.
     * @param strategy - The chosen execution strategy.
     * @param complexity - The assessed task complexity.
     * @param roles - The agent roles used.
     * @param outcome - The execution outcome.
     * @param lessons - Lessons from the PlannerMemory.
     * @param filesAffected - Files created or modified.
     * @param durationMs - Execution duration.
     * @param reflection - The post-execution reflection (may be null).
     * @param usage - The usage snapshot (may be null).
     */
    recordExecution(params: {
        task: string;
        strategy: ExecutionStrategy;
        complexity: TaskComplexity;
        roles: string[];
        outcome: "success" | "partial" | "failure";
        lessons: string;
        filesAffected: string[];
        durationMs: number;
        reflection: ExecutionReflection | null;
        usage: UsageSnapshot | null;
    }): void {
        const now = isoNow();
        const taskHash = this.hashTask(params.task);

        // 1. Create execution summary
        const summary: PersistedExecutionSummary = {
            id: `exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            task: params.task.slice(0, MAX_TASK_LENGTH),
            taskHash,
            strategy: params.strategy,
            complexity: params.complexity,
            roles: params.roles,
            outcome: params.outcome,
            lessons: params.lessons.slice(0, MAX_LESSONS_LENGTH),
            filesAffected: [...new Set(params.filesAffected)].slice(0, MAX_FILES_PER_SUMMARY),
            effectivenessScore: params.reflection?.effectivenessScore ?? null,
            decompositionAssessment: params.reflection?.decompositionAssessment ?? null,
            sharingAssessment: params.reflection?.sharingAssessment ?? null,
            durationMs: params.durationMs,
            timestamp: now,
        };

        this.memory = {
            ...this.memory,
            totalExecutions: this.memory.totalExecutions + 1,
            executionSummaries: [
                ...this.memory.executionSummaries,
                summary,
            ],
        };

        // 2. Merge insights from reflection
        if (params.reflection?.insights && params.reflection.insights.length > 0) {
            this.mergeInsights(params.reflection.insights);
        }

        // 3. Update coordination patterns from reflection
        if (params.reflection) {
            this.updateCoordinationPatterns(params.reflection, params.strategy, params.roles);
        }

        // 4. Record usage
        if (params.usage) {
            const usageRecord: PersistedUsageRecord = {
                timestamp: now,
                task: params.task.slice(0, 100),
                strategy: params.strategy,
                agentCount: params.roles.length,
                inputTokens: params.usage.inputTokens,
                outputTokens: params.usage.outputTokens,
                estimatedCostUsd: params.usage.estimatedCostUsd,
                durationMs: params.durationMs,
            };

            this.memory = {
                ...this.memory,
                usageHistory: [...this.memory.usageHistory, usageRecord],
            };
        }

        // 5. Update known tasks
        this.updateKnownTask(taskHash, params.task, params.outcome, params.strategy);

        // 6. Apply retention limits
        this.enforceRetentionLimits();

        this._dirty = true;

        this.logger.info(
            {
                executionId: summary.id,
                totalExecutions: this.memory.totalExecutions,
                insightCount: this.memory.insights.length,
                patternCount: this.memory.coordinationPatterns.length,
            },
            `Execution recorded: ${summary.outcome}, total: ${this.memory.totalExecutions}`,
        );
    }

    // ── Querying ───────────────────────────────────────────────────────

    /**
     * Returns the known task entry for a task hash, if it exists.
     * Used to detect re-executions of similar tasks.
     */
    findKnownTask(task: string): KnownTask | null {
        const hash = this.hashTask(task);
        return this.memory.knownTasks.find(t => t.taskHash === hash) ?? null;
    }

    /**
     * Returns recent execution summaries relevant to the given task.
     *
     * The relevance is determined by:
     * 1. Exact task hash match (same task re-executed)
     * 2. Recent executions (last N, regardless of task)
     *
     * Results are ordered most-recent-first and capped at `maxSummariesInPrompt`.
     */
    getRelevantSummaries(task: string): readonly PersistedExecutionSummary[] {
        const limit = this.config.maxSummariesInPrompt;
        const hash = this.hashTask(task);

        // Prioritize exact matches, then recent
        const exactMatches = this.memory.executionSummaries
            .filter(s => s.taskHash === hash)
            .slice(-2); // At most 2 previous runs of the same task

        const recent = this.memory.executionSummaries
            .filter(s => s.taskHash !== hash)
            .slice(-(limit - exactMatches.length));

        const combined = [...exactMatches, ...recent]
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
            .slice(0, limit);

        return combined;
    }

    /**
     * Returns the top insights eligible for prompt injection.
     *
     * Filtered by confidence threshold, sorted by confidence (descending),
     * then by recency (most recently confirmed first).
     */
    getTopInsights(): readonly PersistedInsight[] {
        const minConf = this.config.minInsightConfidence;
        const limit = this.config.maxInsightsInPrompt;

        return this.memory.insights
            .filter(i => i.confidence >= minConf)
            .sort((a, b) => {
                const confDiff = b.confidence - a.confidence;
                if (Math.abs(confDiff) > 0.05) return confDiff;
                return b.lastConfirmedAt.localeCompare(a.lastConfirmedAt);
            })
            .slice(0, limit);
    }

    /**
     * Returns the top coordination patterns for prompt injection.
     */
    getTopPatterns(): readonly CoordinationPattern[] {
        return this.memory.coordinationPatterns
            .filter(p => p.confidence >= 0.4 && p.observationCount >= 2)
            .sort((a, b) => {
                const confDiff = b.confidence - a.confidence;
                if (Math.abs(confDiff) > 0.05) return confDiff;
                return b.observationCount - a.observationCount;
            })
            .slice(0, this.config.maxPatternsInPrompt);
    }

    /**
     * Builds a prompt section for the planner with relevant memory data.
     *
     * Returns `null` if there is no relevant memory to inject.
     *
     * The section is designed to be injected into the `taskAnalysisPrompt`
     * template via a Handlebars variable.
     *
     * @param currentTask - The task being planned (used for relevance matching).
     */
    buildPlannerPromptSection(currentTask: string): string | null {
        const summaries = this.getRelevantSummaries(currentTask);
        const insights = this.getTopInsights();
        const patterns = this.getTopPatterns();
        const knownTask = this.findKnownTask(currentTask);

        if (summaries.length === 0 && insights.length === 0 && patterns.length === 0 && !knownTask) {
            return null;
        }

        const sections: string[] = [];

        // Known task warning
        if (knownTask) {
            sections.push(
                `⚠️ This task (or a very similar one) has been executed ${knownTask.executionCount} time(s) before.`,
                `Last outcome: ${knownTask.lastOutcome}, last strategy: ${knownTask.lastStrategy}.`,
                `Consider what worked and what didn't in previous attempts.`,
                "",
            );
        }

        // Recent execution summaries
        if (summaries.length > 0) {
            sections.push("### Previous Executions");
            for (const s of summaries) {
                const status = s.outcome === "success" ? "✅" : s.outcome === "partial" ? "⚠️" : "❌";
                sections.push(
                    `- ${status} **${s.strategy}** (${s.complexity}) — ${s.roles.join(", ")}`,
                    `  Task: ${s.task}`,
                    `  ${s.outcome} in ${s.durationMs}ms${s.effectivenessScore != null ? `, effectiveness: ${s.effectivenessScore}` : ""}`,
                );
                if (s.lessons) {
                    sections.push(`  Lessons: ${s.lessons}`);
                }
                if (s.decompositionAssessment) {
                    sections.push(`  Decomposition: ${s.decompositionAssessment}`);
                }
            }
            sections.push("");
        }

        // Insights
        if (insights.length > 0) {
            sections.push("### Learned Patterns");
            for (const i of insights) {
                const icon = i.polarity === "positive" ? "✅" : "⚠️";
                const confirmed = i.confirmationCount > 1 ? ` (confirmed ${i.confirmationCount}x)` : "";
                sections.push(
                    `- ${icon} [${i.category}] ${i.insight}${confirmed}`,
                    `  When: ${i.applicableWhen}`,
                );
            }
            sections.push("");
        }

        // Coordination patterns
        if (patterns.length > 0) {
            sections.push("### Coordination Patterns");
            for (const p of patterns) {
                sections.push(
                    `- [${p.type}] ${p.description} (observed ${p.observationCount}x, confidence: ${p.confidence.toFixed(2)})`,
                    `  When: ${p.applicableWhen}`,
                );
            }
            sections.push("");
        }

        return sections.join("\n");
    }

    // ── Introspection ──────────────────────────────────────────────────

    /** Whether the memory has been loaded from the adapter. */
    get isLoaded(): boolean {
        return this._loaded;
    }

    /** Whether there are unsaved changes. */
    get isDirty(): boolean {
        return this._dirty;
    }

    /** Total number of executions recorded. */
    get totalExecutions(): number {
        return this.memory.totalExecutions;
    }

    /** Number of persisted insights. */
    get insightCount(): number {
        return this.memory.insights.length;
    }

    /** Number of coordination patterns. */
    get patternCount(): number {
        return this.memory.coordinationPatterns.length;
    }

    /** Number of known tasks. */
    get knownTaskCount(): number {
        return this.memory.knownTasks.length;
    }

    /** Number of execution summaries stored. */
    get summaryCount(): number {
        return this.memory.executionSummaries.length;
    }

    /** Number of usage records stored. */
    get usageRecordCount(): number {
        return this.memory.usageHistory.length;
    }

    /** The adapter location (file path or identifier). */
    get location(): string {
        return this.adapter.location;
    }

    /** Returns a snapshot of the current memory for external inspection. */
    getSnapshot(): Readonly<PersistedMemory> {
        return { ...this.memory };
    }

    /** Whether autoSave is configured. */
    get autoSave(): boolean {
        return this.config.autoSave;
    }

    /** Whether autoLoad is configured. */
    get autoLoad(): boolean {
        return this.config.autoLoad;
    }

    // ── Private: Insight Merging ───────────────────────────────────────

    /**
     * Merges new insights from a reflection into the persisted store.
     *
     * For each new insight:
     * - If a similar insight already exists (same category + similar text),
     *   the existing one is updated: confidence is increased and
     *   confirmationCount is incremented.
     * - If no match is found, the insight is added as new.
     *
     * The similarity check uses a simple normalized substring match.
     * This is a heuristic — false negatives are acceptable (duplicate insights
     * are better than missed confirmations).
     */
    private mergeInsights(newInsights: ReadonlyArray<{ category: string; confidence: number; insight: string; applicableWhen: string; polarity: "positive" | "negative" }>): void {
        const now = isoNow();
        const updatedInsights = [...this.memory.insights];

        for (const newInsight of newInsights) {
            if (newInsight.confidence < this.config.minInsightConfidence) {
                continue; // Skip low-confidence insights
            }

            const existingIndex = updatedInsights.findIndex(
                existing =>
                    existing.category === newInsight.category &&
                    existing.polarity === newInsight.polarity &&
                    this.isSimilarText(existing.insight, newInsight.insight),
            );

            if (existingIndex >= 0) {
                // Update existing insight
                const existing = updatedInsights[existingIndex]!;
                updatedInsights[existingIndex] = {
                    ...existing,
                    confidence: Math.min(1.0, existing.confidence + 0.1),
                    confirmationCount: existing.confirmationCount + 1,
                    lastConfirmedAt: now,
                };

                this.logger.debug(
                    { insightId: existing.id, newConfidence: updatedInsights[existingIndex]!.confidence },
                    `Insight confirmed: ${existing.insight.slice(0, 80)}`,
                );
            } else {
                // Add new insight
                const persistedInsight: PersistedInsight = {
                    id: `insight-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                    category: newInsight.category,
                    confidence: newInsight.confidence,
                    insight: newInsight.insight,
                    applicableWhen: newInsight.applicableWhen,
                    polarity: newInsight.polarity,
                    confirmationCount: 1,
                    firstSeenAt: now,
                    lastConfirmedAt: now,
                };

                updatedInsights.push(persistedInsight);

                this.logger.debug(
                    { insightId: persistedInsight.id },
                    `New insight stored: ${newInsight.insight.slice(0, 80)}`,
                );
            }
        }

        this.memory = {
            ...this.memory,
            insights: updatedInsights,
        };
    }

    // ── Private: Coordination Patterns ─────────────────────────────────

    /**
     * Updates coordination patterns based on an execution reflection.
     *
     * Extracts pattern signals from the reflection's assessments and
     * either confirms existing patterns or creates new ones.
     */
    private updateCoordinationPatterns(
        reflection: ExecutionReflection,
        strategy: ExecutionStrategy,
        roles: string[],
    ): void {
        const now = isoNow();
        const updatedPatterns = [...this.memory.coordinationPatterns];

        // Pattern: effective/ineffective split
        if (strategy === "multi" && reflection.decompositionAssessment) {
            const isEffective = reflection.effectivenessScore >= 0.7;
            const type = isEffective ? "effective_split" : "ineffective_split";
            const description = isEffective
                ? `Splitting into roles [${roles.join(", ")}] worked well.`
                : `Splitting into roles [${roles.join(", ")}] was suboptimal.`;
            const applicableWhen = `Multi-agent tasks with roles similar to [${roles.join(", ")}]`;

            this.upsertPattern(updatedPatterns, {
                type,
                description,
                applicableWhen,
                confidence: reflection.effectivenessScore,
            }, now);
        }

        // Pattern: sharing benefit/noise
        if (reflection.sharingAssessment) {
            const sharingAssessmentLower = reflection.sharingAssessment.toLowerCase();
            if (sharingAssessmentLower.includes("beneficial") || sharingAssessmentLower.includes("effective") || sharingAssessmentLower.includes("helped")) {
                this.upsertPattern(updatedPatterns, {
                    type: "sharing_benefit",
                    description: `Information sharing between [${roles.join(", ")}] improved coordination.`,
                    applicableWhen: `Tasks with roles [${roles.join(", ")}] that have interdependencies.`,
                    confidence: Math.min(1.0, reflection.effectivenessScore + 0.1),
                }, now);
            } else if (sharingAssessmentLower.includes("noise") || sharingAssessmentLower.includes("unnecessary") || sharingAssessmentLower.includes("overhead")) {
                this.upsertPattern(updatedPatterns, {
                    type: "sharing_noise",
                    description: `Information sharing between [${roles.join(", ")}] added overhead without clear benefit.`,
                    applicableWhen: `Tasks where agents work on independent, non-overlapping concerns.`,
                    confidence: 0.5,
                }, now);
            }
        }

        // Pattern: optimal agent count
        if (strategy === "multi" && reflection.effectivenessScore >= 0.7) {
            this.upsertPattern(updatedPatterns, {
                type: "optimal_agent_count",
                description: `${roles.length} agents was effective for this type of task.`,
                applicableWhen: `Tasks with ${roles.length} clearly separable concerns.`,
                confidence: reflection.effectivenessScore,
            }, now);
        }

        this.memory = {
            ...this.memory,
            coordinationPatterns: updatedPatterns,
        };
    }

    /**
     * Inserts or updates a coordination pattern.
     * If a similar pattern exists (same type + similar description),
     * it is updated. Otherwise, a new pattern is created.
     */
    private upsertPattern(
        patterns: CoordinationPattern[],
        data: {
            type: string;
            description: string;
            applicableWhen: string;
            confidence: number;
        },
        now: string,
    ): void {
        const existingIndex = patterns.findIndex(
            p => p.type === data.type && this.isSimilarText(p.description, data.description),
        );

        if (existingIndex >= 0) {
            const existing = patterns[existingIndex]!;
            patterns[existingIndex] = {
                ...existing,
                observationCount: existing.observationCount + 1,
                confidence: (existing.confidence * existing.observationCount + data.confidence) /
                    (existing.observationCount + 1),
                lastObservedAt: now,
            };
        } else {
            patterns.push({
                id: `pattern-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                type: data.type,
                description: data.description,
                observationCount: 1,
                confidence: data.confidence,
                applicableWhen: data.applicableWhen,
                lastObservedAt: now,
            });
        }
    }

    // ── Private: Known Tasks ───────────────────────────────────────────

    /**
     * Updates the known tasks index with a new execution.
     */
    private updateKnownTask(
        taskHash: string,
        task: string,
        outcome: "success" | "partial" | "failure",
        strategy: ExecutionStrategy,
    ): void {
        const updatedTasks = [...this.memory.knownTasks];
        const existingIndex = updatedTasks.findIndex(t => t.taskHash === taskHash);

        if (existingIndex >= 0) {
            const existing = updatedTasks[existingIndex]!;
            updatedTasks[existingIndex] = {
                ...existing,
                executionCount: existing.executionCount + 1,
                lastOutcome: outcome,
                lastStrategy: strategy,
                lastExecutedAt: isoNow(),
            };
        } else {
            updatedTasks.push({
                taskHash,
                taskPreview: task.slice(0, 100),
                executionCount: 1,
                lastOutcome: outcome,
                lastStrategy: strategy,
                lastExecutedAt: isoNow(),
            });
        }

        this.memory = {
            ...this.memory,
            knownTasks: updatedTasks,
        };
    }

    // ── Private: Retention ─────────────────────────────────────────────

    /**
     * Applies retention limits to all data collections.
     * Evicts the oldest/least-valuable entries when limits are exceeded.
     */
    private enforceRetentionLimits(): void {
        let { executionSummaries, insights, coordinationPatterns, usageHistory, knownTasks } = this.memory;

        // Execution summaries: keep most recent
        if (executionSummaries.length > this.config.maxExecutionSummaries) {
            executionSummaries = executionSummaries.slice(-this.config.maxExecutionSummaries);
        }

        // Insights: evict lowest confidence first
        if (insights.length > this.config.maxInsights) {
            insights = [...insights]
                .sort((a, b) => b.confidence - a.confidence)
                .slice(0, this.config.maxInsights);
        }

        // Coordination patterns: evict lowest confidence + fewest observations
        if (coordinationPatterns.length > this.config.maxCoordinationPatterns) {
            coordinationPatterns = [...coordinationPatterns]
                .sort((a, b) => {
                    const score = (p: CoordinationPattern) => p.confidence * 0.6 + Math.min(p.observationCount / 10, 0.4);
                    return score(b) - score(a);
                })
                .slice(0, this.config.maxCoordinationPatterns);
        }

        // Usage history: keep most recent
        if (usageHistory.length > this.config.maxUsageRecords) {
            usageHistory = usageHistory.slice(-this.config.maxUsageRecords);
        }

        // Known tasks: evict least recently executed
        if (knownTasks.length > this.config.maxKnownTasks) {
            knownTasks = [...knownTasks]
                .sort((a, b) => b.lastExecutedAt.localeCompare(a.lastExecutedAt))
                .slice(0, this.config.maxKnownTasks);
        }

        this.memory = {
            ...this.memory,
            executionSummaries,
            insights,
            coordinationPatterns,
            usageHistory,
            knownTasks,
        };
    }

    // ── Private: Helpers ───────────────────────────────────────────────

    /**
     * Builds an empty memory structure with the current schema version.
     */
    private buildEmptyMemory(): PersistedMemory {
        return {
            version: CURRENT_SCHEMA_VERSION,
            lastSavedAt: isoNow(),
            totalExecutions: 0,
            executionSummaries: [],
            insights: [],
            coordinationPatterns: [],
            usageHistory: [],
            knownTasks: [],
        };
    }

    /**
     * Generates a normalized hash for a task description.
     *
     * The hash is designed to match semantically similar tasks:
     * - Lowercased
     * - Whitespace normalized
     * - Punctuation stripped
     * - First 150 chars only (to avoid length-based divergence)
     *
     * This is a simple heuristic. Exact duplicate detection is easy;
     * near-duplicate detection is intentionally loose to err on the
     * side of recognizing similar tasks.
     */
    private hashTask(task: string): string {
        const normalized = task
            .toLowerCase()
            .replace(/[^\w\s]/g, "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 150);

        // Simple hash using string folding
        let hash = 0;
        for (let i = 0; i < normalized.length; i++) {
            const char = normalized.charCodeAt(i);
            hash = ((hash << 5) - hash + char) | 0;
        }
        return `task-${Math.abs(hash).toString(36)}`;
    }

    /**
     * Checks if two texts are similar enough to be considered the same concept.
     *
     * Uses a simple approach: lowercased, first 100 chars, check if one
     * contains a significant portion of the other's words.
     */
    private isSimilarText(a: string, b: string): boolean {
        const normalize = (s: string) =>
            s.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter(w => w.length > 3);

        const wordsA = normalize(a);
        const wordsB = normalize(b);

        if (wordsA.length === 0 || wordsB.length === 0) return false;

        const setB = new Set(wordsB);
        const overlap = wordsA.filter(w => setB.has(w)).length;

        // More than 50% of words overlap → similar
        return overlap / Math.min(wordsA.length, wordsB.length) > 0.5;
    }
}
```

---

### 4. Enrichir le template `taskAnalysisPrompt` dans `planning.ts`

Ajouter une section optionnelle pour les données de mémoire persistée :

```handlebars
{{#if persistedMemory}}
## Execution Memory (learned from {{persistedMemory.totalExecutions}} previous execution(s))

{{{persistedMemory.content}}}

Use this historical data to inform your planning decisions. Pay special attention to:
- Tasks that failed before and why
- Decomposition strategies that worked well or poorly
- Coordination patterns that were effective or noisy
{{/if}}
```

Note : la variable `persistedMemory` est distincte de `previousExecutions` (évolution 13 — mémoire glissante en RAM). La mémoire persistée a un scope plus large (survit au `destroy()`) et contient les insights et patterns, tandis que `previousExecutions` ne contient que les PlannerMemory de la session courante.

---

### 5. Enrichir le Planning System Prompt

Ajouter dans la section des règles :

```text
## Execution Memory
When execution memory is provided, use it to:
- AVOID repeating strategies that failed for similar tasks
- PREFER strategies that scored high on effectiveness
- Respect learned coordination patterns (what types of sharing work, how many agents are optimal)
- Acknowledge when a task has been attempted before and adapt accordingly
Do NOT blindly follow past patterns — each task may have different requirements. Use the memory as guidance, not as law.
```

---

### 6. Intégrer le `MemoryStore` dans `AgentPool`

#### A. Ajouter le champ dans la classe

```typescript
class AgentPool extends EventEmitter {
    // ... existing fields ...

    /** Persistent inter-execution memory store. */
    private readonly memoryStore: MemoryStore | null = null;
}
```

#### B. Instancier dans le constructeur

```typescript
// After other subsystem initialization

if (config.executionMemory?.enabled) {
    const adapter = config.executionMemory.adapter
        ?? new FileMemoryAdapter(
            config.executionMemory.filePath,
            config.cwd,
            this.logger,
        );

    this.memoryStore = new MemoryStore(
        adapter,
        config.executionMemory,
        this.logger,
    );

    this.logger.info(
        { location: adapter.location },
        `Persistent memory enabled — adapter: ${adapter.location}`,
    );
}
```

#### C. Charger la mémoire au démarrage (auto-load)

L'auto-load est déclenché au premier `execute()` ou `send()`, pas dans le constructeur, pour éviter les I/O bloquantes à l'instanciation :

```typescript
/**
 * Ensures the memory store is loaded before first use.
 * Called lazily at the start of execute() and send().
 */
private async ensureMemoryLoaded(): Promise<void> {
    if (this.memoryStore && this.memoryStore.autoLoad && !this.memoryStore.isLoaded) {
        await this.memoryStore.load();
    }
}
```

Appeler `ensureMemoryLoaded()` au début de `execute()` et `send()` :

```typescript
async execute(task: string): Promise<AgentPoolResult> {
    this.assertNotDestroyed();
    await this.conversations.client.validateModel();
    await this.ensureMemoryLoaded(); // ← NEW

    // ... rest of execute()
}

async send(message: string): Promise<string | AgentPoolResult> {
    this.assertNotDestroyed();
    await this.conversations.client.validateModel();
    await this.ensureMemoryLoaded(); // ← NEW

    // ... rest of send()
}
```

#### D. Injecter la mémoire dans le planner

Dans `execute()`, après le scan du projet (évolution 03) et avant l'appel à `this.planner.analyze()`, construire la section de mémoire :

```typescript
// Build persisted memory section for the planner
let persistedMemorySection: string | null = null;
let previousExecution: AgentPoolResult["previousExecution"] = null;

if (this.memoryStore) {
    persistedMemorySection = this.memoryStore.buildPlannerPromptSection(task);

    const knownTask = this.memoryStore.findKnownTask(task);
    if (knownTask) {
        previousExecution = {
            count: knownTask.executionCount,
            lastOutcome: knownTask.lastOutcome,
            lastStrategy: knownTask.lastStrategy,
        };

        this.logger.info(
            {
                executionCount: knownTask.executionCount,
                lastOutcome: knownTask.lastOutcome,
            },
            `Task previously executed ${knownTask.executionCount} time(s) — last outcome: ${knownTask.lastOutcome}`,
        );
    }
}

const analysis = await this.planner.analyze(
    task,
    contextHints,       // existing
    constraints,        // existing
    projectContext,     // from evolution 03
    persistedMemorySection, // ← NEW — passed as an additional context hint
);
```

**Note on integration** : Pour éviter de modifier la signature de `planner.analyze()` qui a déjà évolué avec les évolutions 03 et 13, la section de mémoire persistée est concaténée aux `contextHints` existants :

```typescript
const allContextHints = [
    contextHints,
    persistedMemorySection,
].filter(Boolean).join("\n\n") || undefined;

const analysis = await this.planner.analyze(task, allContextHints, constraints);
```

Alternativement, ajouter un paramètre `persistedMemory` à `analyze()`. Voir la section sur l'interaction avec l'évolution 13 pour les détails.

#### E. Enregistrer l'exécution après complétion

Dans `execute()`, juste après `generateSummary()` et avant la construction du `poolResult`, enregistrer l'exécution dans la mémoire :

```typescript
// Record execution in persistent memory
let memorySaved = false;
if (this.memoryStore) {
    const successCount = executionResults.filter(r => r.success).length;
    const outcome: "success" | "partial" | "failure" =
        successCount === executionResults.length ? "success" :
        successCount > 0 ? "partial" :
        "failure";

    const allFiles = executionResults.flatMap(r => r.filesWritten);
    const roles = analysis.subtasks.map(s => s.role);

    // Get the reflection from the reflection engine (if available)
    const reflection = this.reflectionEngine?.lastReflection ?? null;

    // Get the usage snapshot from the cost tracker (if available)
    const usage = this.costTracker?.getSnapshot() ?? null;

    // Get lessons from the planner memory (evolution 13)
    const plannerMemories = this.planner.getLastMemory?.() ?? null;
    const lessons = plannerMemories?.lessons ?? "";

    this.memoryStore.recordExecution({
        task,
        strategy: analysis.strategy,
        complexity: analysis.complexity,
        roles,
        outcome,
        lessons,
        filesAffected: allFiles,
        durationMs: Date.now() - startTime,
        reflection,
        usage,
    });

    // Auto-save if configured
    if (this.memoryStore.autoSave) {
        memorySaved = await this.memoryStore.save();
    }
}
```

#### F. Inclure les données de mémoire dans le résultat

```typescript
const poolResult: AgentPoolResult = {
    task,
    strategy: analysis.strategy,
    analysis,
    agents: executionResults,
    summary,
    durationMs,
    memorySaved: this.memoryStore ? memorySaved : undefined,
    previousExecution: previousExecution ?? undefined,
    // ... other fields from previous evolutions
};
```

#### G. Exposer la mémoire dans `getState()`

```typescript
getState(): AgentPoolState {
    return {
        // ... existing fields ...
        memory: this.memoryStore ? {
            enabled: true,
            location: this.memoryStore.location,
            totalExecutions: this.memoryStore.totalExecutions,
            insightCount: this.memoryStore.insightCount,
            patternCount: this.memoryStore.patternCount,
            knownTaskCount: this.memoryStore.knownTaskCount,
        } : undefined,
    };
}
```

#### H. Ajouter les méthodes publiques de gestion mémoire

```typescript
/**
 * Loads the persistent memory from the adapter.
 *
 * Called automatically on first `execute()`/`send()` if `autoLoad` is true.
 * Call manually if `autoLoad` is false.
 */
async loadMemory(): Promise<void> {
    if (!this.memoryStore) {
        throw new Error("Persistent memory is not enabled. Set executionMemory.enabled: true in config.");
    }
    await this.memoryStore.load();
}

/**
 * Saves the persistent memory to the adapter.
 *
 * Called automatically after each execution if `autoSave` is true.
 * Call manually if `autoSave` is false or to force a save.
 */
async saveMemory(): Promise<boolean> {
    if (!this.memoryStore) {
        throw new Error("Persistent memory is not enabled.");
    }
    return this.memoryStore.save();
}

/**
 * Clears all persistent memory.
 * Deletes the persisted data and resets the in-memory state.
 */
async clearMemory(): Promise<void> {
    if (!this.memoryStore) {
        throw new Error("Persistent memory is not enabled.");
    }
    await this.memoryStore.clear();
}

/**
 * Returns a snapshot of the current persistent memory.
 * Useful for debugging and inspection.
 */
getMemorySnapshot(): Readonly<PersistedMemory> | null {
    return this.memoryStore?.getSnapshot() ?? null;
}
```

#### I. Enrichir le STATUS_QUERY intent

```typescript
case UserIntent.STATUS_QUERY: {
    const state = this.getState();
    const lines: string[] = [
        // ... existing status lines ...
    ];

    // Add memory info
    if (state.memory?.enabled) {
        lines.push("");
        lines.push("**Persistent Memory**:");
        lines.push(`- Total executions: ${state.memory.totalExecutions}`);
        lines.push(`- Insights: ${state.memory.insightCount}`);
        lines.push(`- Coordination patterns: ${state.memory.patternCount}`);
        lines.push(`- Known tasks: ${state.memory.knownTaskCount}`);
    }

    return lines.join("\n");
}
```

#### J. Cleanup dans `destroy()`

La mémoire n'est PAS effacée au `destroy()` — c'est toute la raison d'être de cette évolution. Mais on sauvegarde les données non sauvegardées :

```typescript
async destroy(): Promise<void> {
    if (this._destroyed) return;

    // Save any unsaved memory before destroying
    if (this.memoryStore?.isDirty) {
        await this.memoryStore.save();
    }

    // ... existing destroy logic ...
}
```

---

### 7. Interaction avec l'évolution 13 (Planner sliding memory)

L'évolution 13 a introduit les `PlannerMemory` en RAM, injectées dans le prompt via `previousExecutions`. L'évolution 21 ajoute les `PersistedExecutionSummary` via `persistedMemory`. Les deux coexistent :

- **`PlannerMemory` (évolution 13)** — Mémoire de session courte (intra-process). Contient les 5 dernières exécutions. Perdue au `destroy()`. Utilisée via `previousExecutions` dans le template.
- **`PersistedMemory` (évolution 21)** — Mémoire long-terme (inter-process). Contient jusqu'à 50 exécutions + insights + patterns. Survit au `destroy()`. Utilisée via `persistedMemory` dans le template.

#### Reconciliation

Au démarrage, si la mémoire persistée est chargée, les `PlannerMemory` en RAM commencent vides (comme aujourd'hui). Après la première exécution de la session, elles s'accumulent normalement. La mémoire persistée est un complément, pas un remplacement.

Pour éviter les doublons dans le prompt, le `buildPlannerPromptSection()` peut être configuré pour exclure les exécutions déjà présentes dans les `PlannerMemory` en RAM. Cela se fait en passant les timestamps des PlannerMemory comme paramètre d'exclusion :

```typescript
buildPlannerPromptSection(currentTask: string, excludeAfter?: string): string | null {
    // Filter out summaries that are already in PlannerMemory (same session)
    let summaries = this.getRelevantSummaries(currentTask);
    if (excludeAfter) {
        summaries = summaries.filter(s => s.timestamp < excludeAfter);
    }
    // ...
}
```

---

### 8. Nouveau pool event

```typescript
enum PoolEvent {
    // ... existing events ...

    /** Persistent memory was saved successfully. */
    MEMORY_SAVED = "pool:memory-saved",

    /** Persistent memory was loaded at startup. */
    MEMORY_LOADED = "pool:memory-loaded",
}

interface MemorySavedEvent extends BasePoolEvent {
    readonly totalExecutions: number;
    readonly insightCount: number;
    readonly patternCount: number;
    readonly location: string;
}

interface MemoryLoadedEvent extends BasePoolEvent {
    readonly totalExecutions: number;
    readonly insightCount: number;
    readonly patternCount: number;
    readonly location: string;
}

interface PoolEventMap {
    // ... existing mappings ...
    [PoolEvent.MEMORY_SAVED]: MemorySavedEvent;
    [PoolEvent.MEMORY_LOADED]: MemoryLoadedEvent;
}
```

---

## Configuration examples

### Pas de mémoire persistante (défaut — comportement legacy)

```typescript
const pool = new AgentPool({
    openRouterApiKey: apiKey,
    // executionMemory not specified → disabled
});
```

### Mémoire persistante avec adapter fichier par défaut

```typescript
const pool = new AgentPool({
    openRouterApiKey: apiKey,
    cwd: "/my/project",
    executionMemory: {
        enabled: true,
        // Fichier : /my/project/.stark/memory.json (par défaut)
    },
});
```

### Mémoire persistante avec chemin custom

```typescript
const pool = new AgentPool({
    openRouterApiKey: apiKey,
    executionMemory: {
        enabled: true,
        filePath: "/home/user/.stark-memory/project-x.json",
    },
});
```

### Mémoire avec rétention agressive

```typescript
const pool = new AgentPool({
    openRouterApiKey: apiKey,
    executionMemory: {
        enabled: true,
        maxExecutionSummaries: 20,   // Only keep last 20
        maxInsights: 50,             // Only keep top 50 insights
        maxCoordinationPatterns: 15,
        maxUsageRecords: 30,
        minInsightConfidence: 0.6,   // Only persist high-confidence insights
    },
});
```

### Mémoire avec sauvegarde manuelle

```typescript
const pool = new AgentPool({
    openRouterApiKey: apiKey,
    executionMemory: {
        enabled: true,
        autoSave: false,  // Don't save after each execution
        autoLoad: true,   // But do load at startup
    },
});

const result = await pool.execute("Build API");
// ... inspect result ...

// Explicitly save when satisfied
await pool.saveMemory();
```

### Mémoire avec adapter custom (ex: SQLite)

```typescript
class SQLiteMemoryAdapter implements MemoryAdapter {
    readonly location: string;
    constructor(dbPath: string) { this.location = dbPath; }
    async load(): Promise<PersistedMemory | null> { /* ... */ }
    async save(memory: PersistedMemory): Promise<boolean> { /* ... */ }
    async clear(): Promise<void> { /* ... */ }
}

const pool = new AgentPool({
    openRouterApiKey: apiKey,
    executionMemory: {
        enabled: true,
        adapter: new SQLiteMemoryAdapter("/data/stark.db"),
    },
});
```

---

## Gestion de la taille du fichier de mémoire

### Estimation de la taille par exécution

| Donnée | Taille estimée |
|--------|---------------|
| `PersistedExecutionSummary` | ~500 bytes (task, roles, lessons, files) |
| `PersistedInsight` (nouveau) | ~300 bytes |
| `PersistedInsight` (confirmation) | +0 bytes (mise à jour in-place) |
| `CoordinationPattern` | ~250 bytes |
| `PersistedUsageRecord` | ~200 bytes |
| `KnownTask` | ~150 bytes |

### Taille totale après N exécutions (avec défauts)

| Exécutions | Taille estimée |
|-----------|---------------|
| 10 | ~15 KB |
| 50 | ~60 KB |
| 100 | ~100 KB (limites de rétention actives) |
| 200+ | ~100 KB (plafonné par rétention) |

La taille est bornée par les limites de rétention. Le fichier ne croît pas indéfiniment.

### Garde-fous

- Le `FileMemoryAdapter` fait un `JSON.stringify` avec indentation — lisible par un humain mais plus volumineux. Pour les très gros volumes, un adapter NDJSON serait plus compact.
- L'écriture atomique (temp + rename) protège contre la corruption.
- Le `validate()` au chargement protège contre les fichiers corrompus.
- Le champ `version` permet la migration future du schema.

---

## Sécurité

### Contenu sensible

Le fichier de mémoire contient des descriptions de tâches, des noms de fichiers, et des patterns. Il ne contient PAS :
- Les prompts complets envoyés aux agents
- Le contenu des fichiers écrits par les agents
- Les clés API ou credentials
- Les réponses complètes des agents

### Recommandations

- Ajouter `.stark/` au `.gitignore` du projet si le fichier mémoire est dans le répertoire du projet
- Documenter que le fichier peut contenir des descriptions de tâches potentiellement sensibles
- Les adapters custom (ex: cloud) doivent gérer le chiffrement eux-mêmes

---

## Tests à implémenter

### Tests unitaires pour `FileMemoryAdapter`

#### Test 1 : `load` retourne `null` quand le fichier n'existe pas

- Setup : aucun fichier créé
- Assert : `adapter.load()` retourne `null` sans erreur

#### Test 2 : `save` crée le répertoire parent si nécessaire

- Setup : chemin avec répertoire inexistant (`/tmp/test-stark/deep/path/memory.json`)
- Appeler `adapter.save(validMemory)`
- Assert : le fichier est créé avec le bon contenu
- Cleanup : supprimer le répertoire

#### Test 3 : `save` + `load` roundtrip préserve les données

- Setup : créer un `PersistedMemory` avec toutes les collections remplies
- Appeler `adapter.save(memory)`
- Appeler `adapter.load()`
- Assert : les données retournées sont identiques à celles sauvegardées

#### Test 4 : `save` est atomique (pas de fichier partiel)

- Setup : écrire un fichier initial
- Simuler un crash pendant `save()` (impossible à 100% en test, mais vérifier que le fichier temp est utilisé)
- Assert : le fichier original n'est pas corrompu

#### Test 5 : `load` retourne `null` pour un fichier JSON invalide

- Setup : écrire un fichier avec du contenu non-JSON
- Assert : `adapter.load()` retourne `null` sans throw

#### Test 6 : `load` retourne `null` pour un schema version inconnu

- Setup : écrire un fichier avec `{ "version": 999, ... }`
- Assert : `adapter.load()` retourne `null` (migration impossible)

#### Test 7 : `clear` supprime le fichier

- Setup : sauvegarder un fichier
- Appeler `adapter.clear()`
- Assert : le fichier n'existe plus
- Assert : `adapter.load()` retourne `null`

#### Test 8 : `clear` ne throw pas si le fichier n'existe pas

- Assert : `adapter.clear()` ne throw pas

#### Test 9 : `load` valide la structure minimale

- Setup : écrire un fichier avec `{ "version": 1 }` (manque les arrays)
- Assert : `adapter.load()` retourne `null`

#### Test 10 : Le chemin par défaut utilise `.stark/memory.json`

- Setup : créer un adapter avec `cwd: "/project"` et pas de `filePath`
- Assert : `adapter.location` est `/project/.stark/memory.json`

### Tests unitaires pour `MemoryStore`

#### Test 11 : `recordExecution` crée un summary correct

- Appeler `recordExecution` avec des données de test
- Assert : `totalExecutions` est 1
- Assert : `summaryCount` est 1
- Assert : le summary contient les bonnes valeurs (task tronqué, roles, outcome)
- Assert : `isDirty` est `true`

#### Test 12 : `recordExecution` met à jour les known tasks

- Appeler `recordExecution` une première fois
- Assert : `knownTaskCount` est 1
- Appeler `recordExecution` avec la même tâche
- Assert : `knownTaskCount` est toujours 1 (même hash)
- Assert : le `executionCount` du known task est 2

#### Test 13 : `recordExecution` fusionne les insights existants

- Setup : créer un insight existant avec confidence 0.6
- Appeler `recordExecution` avec un insight similaire (même category, texte proche)
- Assert : `insightCount` n'a pas augmenté (fusion)
- Assert : la confidence de l'insight existant a augmenté
- Assert : le `confirmationCount` est 2

#### Test 14 : `recordExecution` ajoute un nouvel insight

- Appeler `recordExecution` avec un insight nouveau (catégorie ou texte différent)
- Assert : `insightCount` a augmenté de 1
- Assert : le nouvel insight a `confirmationCount: 1`

#### Test 15 : `recordExecution` ignore les insights sous le seuil de confiance

- Appeler `recordExecution` avec un insight de confidence 0.1 (sous le seuil 0.4)
- Assert : `insightCount` n'a pas changé

#### Test 16 : `enforceRetentionLimits` évince les summaries les plus anciens

- Setup : config `maxExecutionSummaries: 3`
- Enregistrer 5 exécutions
- Assert : `summaryCount` est 3
- Assert : les 2 plus anciens ont été évincés

#### Test 17 : `enforceRetentionLimits` évince les insights à basse confiance

- Setup : config `maxInsights: 3`
- Ajouter 5 insights avec des confidences variées
- Assert : `insightCount` est 3
- Assert : les 3 insights restants ont les confidences les plus élevées

#### Test 18 : `findKnownTask` détecte les tâches similaires

- Enregistrer une exécution avec la tâche "Build a REST API"
- Assert : `findKnownTask("Build a REST API")` retourne l'entrée
- Assert : `findKnownTask("Something completely different")` retourne `null`

#### Test 19 : `hashTask` est déterministe et normalisé

- Assert : `hashTask("Build API")` === `hashTask("build api")` (case insensitive)
- Assert : `hashTask("Build  API")` === `hashTask("Build API")` (whitespace normalized)
- Assert : `hashTask("Build API!")` === `hashTask("Build API")` (punctuation stripped)
- Assert : `hashTask("Build API")` !== `hashTask("Deploy server")` (different tasks)

#### Test 20 : `isSimilarText` détecte les textes proches

- Assert : `isSimilarText("splitting backend frontend works", "splitting backend and frontend worked well")` est `true`
- Assert : `isSimilarText("use TypeScript", "implement Python script")` est `false`

#### Test 21 : `getRelevantSummaries` priorise les tâches identiques

- Enregistrer 3 exécutions dont 1 avec la même tâche que la requête
- Assert : la tâche identique apparaît en premier dans les résultats
- Assert : le résultat contient au max `maxSummariesInPrompt` entrées

#### Test 22 : `getTopInsights` filtre et trie correctement

- Ajouter des insights avec des confidences variées
- Assert : seuls ceux au-dessus du seuil sont retournés
- Assert : triés par confidence décroissante
- Assert : limités à `maxInsightsInPrompt`

#### Test 23 : `getTopPatterns` filtre par observation minimum

- Ajouter des patterns avec `observationCount: 1` et `observationCount: 3`
- Assert : seul le pattern avec `observationCount >= 2` est retourné

#### Test 24 : `buildPlannerPromptSection` retourne `null` sans données

- Setup : mémoire vide
- Assert : `buildPlannerPromptSection("any task")` retourne `null`

#### Test 25 : `buildPlannerPromptSection` contient les sections attendues

- Setup : ajouter des summaries, insights et patterns
- Assert : le résultat contient "Previous Executions"
- Assert : le résultat contient "Learned Patterns"
- Assert : le résultat contient "Coordination Patterns"

#### Test 26 : `buildPlannerPromptSection` inclut l'avertissement de tâche connue

- Enregistrer une exécution avec la tâche "Build API"
- Assert : `buildPlannerPromptSection("Build API")` contient "has been executed"

#### Test 27 : `updateCoordinationPatterns` crée un pattern "effective_split"

- Enregistrer une exécution multi-agent avec `effectivenessScore: 0.8`
- Assert : un pattern `effective_split` est créé
- Assert : sa confidence est ~0.8

#### Test 28 : `updateCoordinationPatterns` confirme un pattern existant

- Créer un pattern `effective_split`
- Enregistrer une autre exécution similaire
- Assert : `observationCount` est 2
- Assert : `confidence` est la moyenne des deux scores

#### Test 29 : `save` et `load` préservent l'état complet

- Enregistrer plusieurs exécutions avec insights et patterns
- Appeler `save()`
- Créer un nouveau `MemoryStore` avec le même adapter
- Appeler `load()`
- Assert : toutes les données sont identiques

#### Test 30 : Le store fonctionne quand l'adapter échoue

- Créer un adapter mock qui throw sur `save()`
- Assert : `save()` retourne `false` sans throw
- Assert : les données en mémoire sont préservées

### Tests d'intégration

#### Test 31 : `AgentPool.execute()` charge la mémoire au premier appel

- Créer un pool avec mémoire activée et un fichier mémoire pré-existant
- Appeler `execute()`
- Assert : `pool.getState().memory.totalExecutions` reflète les données du fichier

#### Test 32 : `AgentPool.execute()` sauvegarde après chaque exécution (autoSave)

- Créer un pool avec `autoSave: true`
- Appeler `execute()`
- Assert : le fichier mémoire existe et contient 1 exécution

#### Test 33 : `AgentPool.execute()` ne sauvegarde PAS avec `autoSave: false`

- Créer un pool avec `autoSave: false`
- Appeler `execute()`
- Assert : le fichier mémoire n'existe pas (ou est vide)
- Appeler `pool.saveMemory()`
- Assert : le fichier existe maintenant

#### Test 34 : Le planner reçoit la section de mémoire persistée

- Créer un pool avec mémoire et un fichier contenant des insights
- Mocker `planner.analyze()` pour capturer le prompt
- Appeler `execute()`
- Assert : le prompt contient la section "Execution Memory"

#### Test 35 : `pool.clearMemory()` supprime toutes les données persistées

- Enregistrer des exécutions, sauvegarder
- Appeler `pool.clearMemory()`
- Assert : `pool.getState().memory.totalExecutions` est 0
- Assert : le fichier mémoire a été supprimé

#### Test 36 : `pool.getMemorySnapshot()` retourne un snapshot lisible

- Enregistrer des exécutions
- Assert : `pool.getMemorySnapshot()` retourne un objet avec toutes les collections
- Assert : c'est une copie (pas une référence mutable)

#### Test 37 : `pool.destroy()` sauvegarde les données non sauvegardées

- Créer un pool avec `autoSave: false`
- Appeler `execute()` (des données sont en RAM mais non sauvegardées)
- Appeler `pool.destroy()`
- Assert : le fichier mémoire contient les données

#### Test 38 : La mémoire survit entre deux instances de pool

- Instance 1 : exécuter une tâche, sauvegarder
- Instance 2 : créer un nouveau pool avec le même chemin fichier
- Assert : `pool2.getState().memory.totalExecutions` est ≥ 1
- Assert : le planner de pool2 reçoit les insights de pool1

#### Test 39 : `AgentPoolResult` inclut `previousExecution` quand une tâche est ré-exécutée

- Instance 1 : exécuter "Build API", sauvegarder
- Instance 2 : exécuter "Build API" à nouveau
- Assert : `result.previousExecution.count` est 1
- Assert : `result.previousExecution.lastOutcome` est correct

#### Test 40 : `STATUS_QUERY` affiche les infos mémoire

- Créer un pool avec mémoire
- Enregistrer des exécutions
- Appeler `pool.send("What's the status?")`
- Assert : la réponse contient "Persistent Memory" avec les statistiques

### Tests de non-régression

#### Test 41 : Le pool fonctionne sans `executionMemory` config

- Créer un pool sans config mémoire
- Appeler `execute()`
- Assert : pas d'erreur
- Assert : `pool.getState().memory` est `undefined`
- Assert : `result.memorySaved` est `undefined`

#### Test 42 : Les `PlannerMemory` (évolution 13) fonctionnent toujours

- Créer un pool avec mémoire persistante ET PlannerMemory (évolution 13)
- Exécuter deux tâches séquentielles
- Assert : le planner reçoit à la fois les PlannerMemory en RAM et la section persistée
- Assert : pas de duplication dans le prompt

#### Test 43 : Le `ReflectionEngine` (évolution 17) fonctionne toujours

- Créer un pool avec mémoire persistante ET réflexion
- Exécuter une tâche multi-agent
- Assert : la réflexion est générée ET ses insights sont persistés dans la mémoire

#### Test 44 : Le `CostTracker` (évolution 19) fonctionne toujours

- Créer un pool avec mémoire persistante ET cost tracking
- Exécuter une tâche
- Assert : le `PersistedUsageRecord` est créé avec les données du cost tracker

#### Test 45 : Les insights avec `confirmationCount` élevé ne sont jamais évincés

- Remplir la mémoire au-delà de `maxInsights`
- Assert : les insights avec `confirmationCount > 3` sont préservés même si d'autres insights ont une confidence plus élevée
- Note : ce test valide que la rétention considère la durabilité, pas juste la confidence récente

---

## Critères de validation

- [ ] L'interface `MemoryAdapter` est abstraite et découplée du backend de stockage
- [ ] Le `FileMemoryAdapter` effectue des écritures atomiques (temp + rename)
- [ ] Le `FileMemoryAdapter` ne throw jamais — retourne `null` ou `false` en cas d'erreur
- [ ] Le `MemoryStore` charge la mémoire au premier usage (lazy loading)
- [ ] Le `MemoryStore` enregistre les exécutions avec tous les détails pertinents
- [ ] Les insights sont fusionnés (pas dupliqués) quand des patterns similaires sont détectés
- [ ] Les `CoordinationPattern` sont agrégés automatiquement depuis les réflexions
- [ ] Les `KnownTask` détectent les ré-exécutions de tâches similaires
- [ ] Les limites de rétention sont appliquées après chaque enregistrement
- [ ] Le `buildPlannerPromptSection()` produit un texte structuré et pertinent
- [ ] Les données mémoire sont injectées dans le prompt du planner
- [ ] L'auto-save sauvegarde après chaque exécution quand configuré
- [ ] `pool.destroy()` sauvegarde les données non sauvegardées
- [ ] La mémoire survit entre deux instances de pool (test de persistance)
- [ ] Le pool fonctionne identiquement sans mémoire persistante (backward compatibility)
- [ ] Les pool events `MEMORY_SAVED` et `MEMORY_LOADED` sont émis
- [ ] `AgentPoolResult` inclut `previousExecution` pour les tâches connues
- [ ] `AgentPoolState` expose les statistiques mémoire
- [ ] Les tests couvrent les cas d'erreur I/O (adapter qui échoue)
- [ ] Tous les tests existants passent toujours

---

## Points d'attention

1. **Le fichier mémoire ne doit PAS être versionné** — ajouter `.stark/` au `.gitignore` dans la documentation et éventuellement dans l'exemple. Les données sont spécifiques à l'utilisateur et à la machine.

2. **Le `hashTask` est un heuristic, pas un hash cryptographique** — deux tâches très différentes pourraient (rarement) avoir le même hash. C'est acceptable : un faux positif de `findKnownTask` est bénin (il affiche juste un avertissement).

3. **L'`isSimilarText` est volontairement permissif** — il vaut mieux fusionner deux insights légèrement différents que de les garder en double. Les faux positifs (fusion incorrecte) sont moins graves que les faux négatifs (doublons qui polluent le prompt).

4. **Ne PAS utiliser la mémoire persistée comme source de vérité pour le planning** — elle est un guide, pas une contrainte. Le system prompt du planner doit explicitement dire « use as guidance, not as law ».

5. **L'adapter `save()` doit être idempotent** — appeler `save()` deux fois de suite avec les mêmes données ne doit pas créer de problème. Le `FileMemoryAdapter` le garantit car il écrase le fichier à chaque fois.

6. **La mémoire persistée et les `PlannerMemory` (évolution 13) sont complémentaires** — ne pas essayer de fusionner les deux en un seul système. Les PlannerMemory sont légères, en RAM, et contiennent les N dernières exécutions de la session. La mémoire persistée est plus riche, sur disque, et contient l'historique long-terme avec insights et patterns.

7. **Le schema `version` est critique** — toujours incrémenter la version quand la structure de `PersistedMemory` change. Implémenter les migrations dans `FileMemoryAdapter.migrate()` pour ne pas perdre les données des utilisateurs.

8. **Attention à la taille du prompt** — le `buildPlannerPromptSection()` peut ajouter 500-1500 tokens au prompt du planner. Les limites `maxInsightsInPrompt`, `maxSummariesInPrompt`, `maxPatternsInPrompt` sont là pour ça. Si le budget tokens (évolution 19) est serré, réduire ces limites.

9. **Le `recordExecution` ne doit PAS être appelé pour les exécutions qui échouent fatalement** (ex: erreur de configuration, model invalide) — seulement pour les exécutions qui ont produit au moins une tentative de subtask. Vérifier cette condition dans `execute()`.

10. **Thread safety** — le `MemoryStore` n'est PAS thread-safe. Si la `TaskQueue` (évolution 20) est configurée en mode concurrent (`maxConcurrent > 1`), les `recordExecution()` concurrents pourraient causer des races. Solution : protéger avec un mutex simple ou sérialiser les enregistrements via un queue interne. Documenter cette limitation.

11. **Le `FileMemoryAdapter` utilise `JSON.stringify` avec indentation** — pour les très grands volumes (>1MB), envisager un mode compact (`JSON.stringify(memory)` sans indentation) ou un adapter binaire. Pour l'usage typique (<100KB), l'indentation est préférable pour la lisibilité.

12. **Ne pas charger la mémoire dans le constructeur** — utiliser le pattern de chargement lazy (`ensureMemoryLoaded()`) pour éviter les I/O bloquantes à l'instanciation. L'utilisateur peut créer un pool et ne jamais appeler `execute()`.