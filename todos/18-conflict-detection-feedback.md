# Évolution 18 — Détection de conflits et canal de feedback inter-agents

## Priorité : 🟡 P2-P3

## Dépendances : Évolution 08 (Structured context injection), Évolution 16 (Meta-reflection ORCHESTRATOR)

## Acquis des évolutions précédentes

- **Évolution 01** : L'`InformationBroker` reçoit les mappings `subtaskToAgent`/`agentToSubtask`. Le tri des candidats par dépendance fonctionne correctement. `findDependency()` traduit entre agent IDs et subtask IDs.
- **Évolution 02** : L'historique de partage (`SharingHistory`) déduplique les informations partagées entre agents. `recordSharing()` enregistre chaque partage effectué. `getRecentSharingsForTarget()` est disponible.
- **Évolution 03** : Le `ProjectScanner` injecte le contexte projet (langages, frameworks, arborescence) dans le planner.
- **Évolution 04** : Des exemples few-shot sont présents dans tous les prompts LLM.
- **Évolution 05** : Les conversations `CONTEXT_ANALYZER`, `SHARING_ANALYZER` et `ORCHESTRATOR` sont séparées avec des system prompts spécialisés.
- **Évolution 06** : Le prompt de notification est nettoyé. Le summary inclut les stats de coordination (`CoordinationStats`).
- **Évolution 07** : Les résultats complets de prompt sont partagés (pas juste 500 chars). Le `promptResultSummary` est construit pour les textes longs.
- **Évolution 08** : L'injection de contexte est structurée avec `StructuredContextInjection` (priorité `CRITICAL`/`HIGH`/`NORMAL`/`LOW`, catégorie `dependency_output`/`shared_context`/`user_instruction`/`coordination_alert`, source, dependencyType). `AgentContextManager` gère les limites de queue et le tri par priorité. La méthode `injectStructured()` est disponible sur `PoolManagedAgent`.
- **Évolution 09** : Le seuil de significance est dynamique, adapté selon la phase d'exécution et les dépendances. `computeThreshold()` existe dans `InformationBroker`.
- **Évolution 10** : Les subtasks ont un timeout configurable et un mécanisme de retry individuel. `AgentExecutionResult` inclut `retryCount`, `timedOut`, `subtaskDurationMs`.
- **Évolution 11** : Le re-planning adaptatif est implémenté via `TaskPlanner.replan()`. Les actions `continue`, `modify`, `restart`, `abort` sont supportées. `ReplanTrigger` et `ReplanDecision` existent.
- **Évolution 12** : Le multi-intent est supporté dans l'intent analyzer avec historique conversationnel et seuil de confiance.
- **Évolution 13** : Le planner a une mémoire glissante (`PlannerMemory[]`). `recordExecution()` enregistre les leçons apprises.
- **Évolution 14** : Le `DecisionJournal` capture les décisions de sharing et notification intra-exécution. `approvalRate`, `countRecentDecisions()`, `getRecent()` sont disponibles.
- **Évolution 15** : Le `CheckpointEvaluator` déclenche des auto-évaluations. Les actions `CONTINUE`, `ADJUST`, `ESCALATE`, `REPLAN`, `ABORT` sont supportées. `CheckpointResult` contient `healthScore`, `issues`, `corrections`.
- **Évolution 16** : L'`OrchestratorEngine` supervise la coordination cross-conversation. Il émet des `OrchestratorDirective` (avec TTL) qui influencent les prompts de sharing et notification. `getDirectivesFor()` et `getDirectivePromptSection()` sont disponibles. L'`OrchestratorAssessment` contient `coherenceScore`, `issues` (catégories: `coherence`, `efficiency`, `drift`, `conflict`, `communication`), `directives`. L'événement `ORCHESTRATOR_ASSESSMENT` est émis.
- **Évolution 17** : Le `ReflectionEngine` analyse les exécutions post-facto. `ExecutionInsight` avec `category`, `confidence`, `polarity`, `applicableWhen`. `getInsightsForPrompt()` et `getInsightsPromptSection()` injectent les leçons dans le planner. `appendLessonsToLastMemory()` enrichit les `PlannerMemory`.

---

## Contexte du problème

Le partage d'information dans l'AgentPool est aujourd'hui **unidirectionnel** : le broker décide de partager une information de l'agent A vers l'agent B, et l'agent B la reçoit passivement via `injectContext()`. L'agent B n'a aucun moyen de signaler un problème avec l'information reçue.

### Scénarios problématiques

#### 1. Conflit de fichiers silencieux

L'agent `api-developer` écrit `src/models/user.ts` avec un schéma Prisma. L'agent `test-writer` reçoit cette information et commence à écrire des tests. Pendant ce temps, `api-developer` réécrit `src/models/user.ts` avec un schéma complètement différent (ajout de champs, renommage). Les tests écrits par `test-writer` sont désormais invalides, mais personne ne le sait — le système n'a aucune détection de conflit.

#### 2. Contradiction entre contexte injecté et travail en cours

L'agent `frontend-developer` reçoit un contexte partagé : « L'API utilise le format snake_case pour tous les champs JSON ». Mais le frontend-developer a déjà écrit 200 lignes de code qui suppose du camelCase (basé sur une convention standard). Il n'a aucun moyen de dire « cette information contredit mon travail en cours ».

#### 3. Information obsolète sans correction

Le broker partage « Le serveur écoute sur le port 3000 ». L'agent `api-developer` change ensuite le port à 8080 dans sa config. L'agent `test-writer` continue à cibler le port 3000. Le système détecte peut-être le `FS_WRITE` sur le fichier config, mais il n'a pas la capacité sémantique de comprendre que l'information précédemment partagée est désormais obsolète.

#### 4. Pas de feedback loop sur la qualité du partage

Le broker ne sait jamais si ses décisions de partage ont été utiles ou nuisibles. Il partage, et c'est fini. Il n'y a pas de signal « cette info m'a aidé » ou « cette info m'a fait perdre du temps ».

### Ce qui existe déjà (et pourquoi c'est insuffisant)

- **L'ORCHESTRATOR (évolution 16)** détecte les problèmes de coordination au niveau macro — mais il n'a pas de visibilité sur les conflits spécifiques de fichiers ou de données entre agents.
- **Le `CheckpointEvaluator` (évolution 15)** évalue la santé globale — mais il ne compare pas les outputs des agents entre eux.
- **Le `ContextTracker`** capture les événements de fichiers (`FS_WRITE`, `FS_READ`) — mais il ne compare pas les contenus ni ne détecte les écrasements.

### Ce que cette évolution résout

1. **Détection automatique de conflits** basée sur l'activité des agents (fichiers modifiés en commun, informations contradictoires)
2. **Canal de feedback** permettant de signaler les conflits comme un nouveau type de delta
3. **Alertes structurées** injectées aux agents concernés via le système de `StructuredContextInjection` (évolution 08) avec priorité `CRITICAL`
4. **Enrichissement de l'ORCHESTRATOR** avec les données de conflit pour de meilleures directives

---

## Fichiers impactés

| Fichier | Action |
|---------|--------|
| `src/enums/delta-type.enum.ts` | Ajouter `CONFLICT_DETECTED` |
| `src/types/agent-pool.types.ts` | Nouveaux types (`ConflictRecord`, `ConflictDetectorConfig`, `ConflictType`) |
| `src/classes/agent-pool/conflict-detector.ts` | Nouveau fichier — logique de détection de conflits |
| `src/prompts/conflict-analysis.ts` | Nouveau fichier — prompt d'analyse de conflit |
| `src/prompts/index.ts` | Exporter les nouveaux prompts |
| `src/classes/agent-pool/context-tracker.ts` | Ajouter la détection de fichiers en conflit |
| `src/classes/agent-pool/agent-pool.ts` | Intégrer le `ConflictDetector` dans le cycle d'exécution |
| `src/enums/pool-event.enum.ts` | Ajouter `CONFLICT_DETECTED` |
| `src/classes/agent-pool/information-broker.ts` | Réagir aux conflits détectés |

---

## Spécification détaillée des changements

### 1. Ajouter `CONFLICT_DETECTED` dans `DeltaType`

```typescript
// src/enums/delta-type.enum.ts

export enum DeltaType {
    // ... existants ...

    /** A conflict was detected between two agents' outputs or activities. */
    CONFLICT_DETECTED = "conflict_detected",
}
```

### 2. Ajouter `CONFLICT_DETECTED` dans `PoolEvent`

```typescript
// src/enums/pool-event.enum.ts

export enum PoolEvent {
    // ... existants ...

    /**
     * A conflict was detected between two agents' activities.
     *
     * Emitted when the conflict detector identifies contradictory
     * outputs, overlapping file writes, or stale shared information.
     */
    CONFLICT_DETECTED = "pool:conflict-detected",
}
```

### 3. Nouveaux types dans `agent-pool.types.ts`

#### Type `ConflictType`

```typescript
/**
 * Categories of conflicts that can be detected between agents.
 */
export type ConflictType =
    | "file_overlap"        // Two agents wrote to the same file
    | "stale_share"         // Previously shared info was invalidated by a subsequent change
    | "semantic_conflict"   // LLM-detected semantic contradiction between agent outputs
    | "dependency_violation"; // An agent's output contradicts its dependency contract
```

#### Type `ConflictRecord`

```typescript
/**
 * A detected conflict between two agents or between an agent's
 * current output and previously shared information.
 */
export interface ConflictRecord {
    /** Unique identifier for this conflict. */
    readonly id: string;

    /** The type of conflict detected. */
    readonly type: ConflictType;

    /** Severity assessment (0.0–1.0). */
    readonly severity: number;

    /** Human-readable description of the conflict. */
    readonly description: string;

    /**
     * The agent whose activity revealed the conflict.
     * This is the agent that wrote/produced the conflicting output.
     */
    readonly sourceAgentId: string;
    readonly sourceAgentName: string;

    /**
     * The agent(s) affected by the conflict.
     * These agents may need to be notified or have their work corrected.
     */
    readonly affectedAgentIds: string[];

    /**
     * The file path involved, if the conflict is file-related.
     */
    readonly filePath?: string;

    /**
     * The stale information that was previously shared, if this
     * is a `stale_share` conflict.
     */
    readonly staleInformation?: string;

    /**
     * LLM-generated resolution recommendation.
     */
    readonly recommendation: string;

    /** ISO-8601 timestamp of detection. */
    readonly timestamp: string;

    /** Whether this conflict has been addressed (alert sent to affected agents). */
    resolved: boolean;
}
```

#### Type `ConflictDetectorConfig`

```typescript
/**
 * Configuration for the conflict detection engine.
 */
export interface ConflictDetectorConfig {
    /**
     * Enable or disable conflict detection.
     * Default: true for multi-agent executions.
     */
    readonly enabled?: boolean;

    /**
     * Whether to use LLM-driven semantic conflict analysis.
     * When false, only structural conflicts (file overlaps, stale shares)
     * are detected. Semantic analysis costs more tokens but catches
     * subtler conflicts.
     * Default: true.
     */
    readonly enableSemanticAnalysis?: boolean;

    /**
     * Minimum severity for a conflict to trigger an alert to affected agents.
     * Conflicts below this threshold are logged but not acted upon.
     * Default: 0.5.
     */
    readonly minAlertSeverity?: number;

    /**
     * Maximum number of conflicts to retain per execution.
     * Prevents unbounded memory growth in pathological cases.
     * Default: 50.
     */
    readonly maxConflicts?: number;
}
```

#### Pool event type

```typescript
// In the event types section

interface ConflictDetectedEvent extends BasePoolEvent {
    readonly conflict: ConflictRecord;
}

// In PoolEventMap
interface PoolEventMap {
    // ... existants ...
    [PoolEvent.CONFLICT_DETECTED]: ConflictDetectedEvent;
}
```

### 4. Ajouter `conflictDetection` dans `AgentPoolConfig`

```typescript
// In AgentPoolConfig
export interface AgentPoolConfig {
    // ... existing fields ...

    /**
     * Configuration for inter-agent conflict detection.
     * Enabled by default for multi-agent executions.
     */
    readonly conflictDetection?: ConflictDetectorConfig;
}
```

### 5. Nouveau fichier `src/prompts/conflict-analysis.ts`

#### System prompt (optionnel — utilise `CONTEXT_ANALYZER` ou `SHARING_ANALYZER`)

La détection sémantique utilise le `SHARING_ANALYZER` conversation en one-shot. Pas besoin d'un rôle dédié.

#### User prompt pour l'analyse de conflit

```typescript
import Handlebars from "handlebars";
import "./helpers.ts";

// ── Conflict Analysis: User Prompt ─────────────────────────────────────────

const CONFLICT_ANALYSIS_SOURCE = `Analyze whether the following agent activity creates a conflict with other agents or previously shared information.

## Source Agent Activity
- **Agent**: {{sourceAgent.agentName}} ({{sourceAgent.taskRole}})
- **Event type**: {{eventType}}
- **Summary**: {{eventSummary}}
{{#if filePath}}
- **File**: {{filePath}}
{{/if}}
{{#if eventData}}
- **Details**:
{{json eventData}}
{{/if}}

## Other Active Agents
{{#each otherAgents}}
### {{this.agentName}} ({{this.taskRole}})
- **Task**: {{truncate this.taskDescription 150}}
- **Status**: {{this.status}} | **Completed**: {{this.completed}}
- **Files written**: {{#if this.filesWritten.length}}{{#each this.filesWritten}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}{{else}}none{{/if}}
- **Files read**: {{#if this.filesRead.length}}{{#each this.filesRead}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}{{else}}none{{/if}}
{{/each}}

{{#if previouslySharedToSource}}
## Information Previously Shared TO the Source Agent
{{#each previouslySharedToSource}}
- [{{this.deltaType}}] From {{this.sourceAgentName}}: {{this.informationSummary}}
{{/each}}
{{/if}}

{{#if previouslySharedFromSource}}
## Information Previously Shared FROM the Source Agent
{{#each previouslySharedFromSource}}
- [{{this.deltaType}}] To {{this.targetAgentName}}: {{this.informationSummary}}
{{/each}}
{{/if}}

{{#if fileOverlaps}}
## Detected File Overlaps
The following files have been written by multiple agents:
{{#each fileOverlaps}}
- **{{this.filePath}}**: written by {{#each this.agents}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}
{{/each}}
{{/if}}

## Analysis Required

Determine if there is a genuine conflict. Consider:

1. **File overlap conflicts**: Did two agents write to the same file? If so, is it a real conflict (contradictory changes) or expected (sequential updates)?
2. **Stale share conflicts**: Did the source agent's action invalidate information that was previously shared with another agent? (e.g., changing a port number, renaming an API endpoint, modifying a schema)
3. **Semantic conflicts**: Does the source agent's output semantically contradict what another agent is doing or has done?
4. **Dependency violations**: Does the source agent's output break an assumption that a dependent agent relies on?

If NO conflict exists, respond with:
{
  "hasConflict": false,
  "reasoning": "<why there is no conflict>"
}

If a conflict IS detected, respond with:
{
  "hasConflict": true,
  "conflicts": [
    {
      "type": "file_overlap" | "stale_share" | "semantic_conflict" | "dependency_violation",
      "severity": <0.0-1.0>,
      "description": "<clear description of the conflict>",
      "affectedAgentIds": ["<agent IDs that are affected>"],
      "recommendation": "<what should be done to resolve this>",
      "staleInformation": "<if stale_share: what was the stale info>"
    }
  ],
  "reasoning": "<overall analysis>"
}`;

export const conflictAnalysisPrompt = Handlebars.compile(
    CONFLICT_ANALYSIS_SOURCE,
    { noEscape: true },
);
```

### 6. Mettre à jour `src/prompts/index.ts`

```typescript
export { conflictAnalysisPrompt } from "./conflict-analysis.ts";

// In templates object
export const templates = {
    // ... existants ...

    // Conflict analysis
    conflictAnalysis: conflictAnalysisPrompt,
} as const;
```

### 7. Nouveau fichier `src/classes/agent-pool/conflict-detector.ts`

#### Constants and validator

```typescript
import type pino from "pino";
import { ConversationRole } from "../../enums/conversation-role.enum.ts";
import { DeltaType } from "../../enums/delta-type.enum.ts";
import { conflictAnalysisPrompt } from "../../prompts/index.ts";
import type {
    AgentContextState,
    ConflictDetectorConfig,
    ConflictRecord,
    ConflictType,
    ContextDelta,
    SharingRecord,
} from "../../types/agent-pool.types.ts";
import { toErrorMessage } from "../../utils/errors.ts";
import { isoNow } from "../../utils/formatting.ts";
import type { ContextTracker } from "./context-tracker.ts";
import type { ConversationManager } from "./conversation-manager.ts";
import type { InformationBroker } from "./information-broker.ts";

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_MIN_ALERT_SEVERITY = 0.5;
const DEFAULT_MAX_CONFLICTS = 50;

/**
 * Delta types that can trigger conflict analysis.
 * Not every delta needs conflict checking — only those that produce
 * tangible outputs that could contradict other agents' work.
 */
const CONFLICT_TRIGGERING_DELTA_TYPES: ReadonlySet<DeltaType> = new Set([
    DeltaType.FILE_WRITTEN,
    DeltaType.PROMPT_COMPLETE,
    DeltaType.TOOL_COMPLETE,
]);

/**
 * Minimum significance for a delta to be evaluated for conflicts.
 * Low-significance deltas (file reads, status changes) rarely cause conflicts.
 */
const MIN_CONFLICT_CHECK_SIGNIFICANCE = 0.4;
```

#### Validator

```typescript
// ── Validator ──────────────────────────────────────────────────────────────

function validateConflictAnalysisResponse(data: unknown): {
    hasConflict: boolean;
    conflicts?: Array<{
        type: string;
        severity: number;
        description: string;
        affectedAgentIds: string[];
        recommendation: string;
        staleInformation?: string;
    }>;
    reasoning: string;
} | null {
    if (data == null || typeof data !== "object") return null;
    const obj = data as Record<string, unknown>;

    if (typeof obj.hasConflict !== "boolean") return null;
    if (typeof obj.reasoning !== "string" || obj.reasoning.length === 0) return null;

    if (!obj.hasConflict) {
        return {
            hasConflict: false,
            reasoning: obj.reasoning as string,
        };
    }

    // hasConflict === true — validate the conflicts array
    if (!Array.isArray(obj.conflicts) || obj.conflicts.length === 0) return null;

    const validTypes: string[] = ["file_overlap", "stale_share", "semantic_conflict", "dependency_violation"];

    const conflicts: Array<{
        type: string;
        severity: number;
        description: string;
        affectedAgentIds: string[];
        recommendation: string;
        staleInformation?: string;
    }> = [];

    for (const raw of obj.conflicts) {
        if (raw == null || typeof raw !== "object") return null;
        const c = raw as Record<string, unknown>;

        if (typeof c.type !== "string" || !validTypes.includes(c.type)) return null;
        if (typeof c.severity !== "number") return null;
        if (typeof c.description !== "string" || c.description.length === 0) return null;
        if (!Array.isArray(c.affectedAgentIds)) return null;
        if (typeof c.recommendation !== "string" || c.recommendation.length === 0) return null;

        conflicts.push({
            type: c.type,
            severity: Math.max(0, Math.min(1, c.severity)),
            description: c.description,
            affectedAgentIds: (c.affectedAgentIds as unknown[]).filter(
                (id): id is string => typeof id === "string",
            ),
            recommendation: c.recommendation,
            staleInformation: typeof c.staleInformation === "string" ? c.staleInformation : undefined,
        });
    }

    if (conflicts.length === 0) return null;

    return {
        hasConflict: true,
        conflicts,
        reasoning: obj.reasoning as string,
    };
}
```

#### Class `ConflictDetector`

```typescript
// ── ConflictDetector ───────────────────────────────────────────────────────

/**
 * Detects and records conflicts between agent activities.
 *
 * The ConflictDetector operates on two levels:
 *
 * ## Level 1: Structural detection (no LLM cost)
 *
 * Detects conflicts purely from data available in the ContextTracker:
 * - **File overlaps**: Two agents writing to the same file path
 * - **Stale shares**: A file that was shared-about is subsequently rewritten
 *
 * Structural detection is always performed and has zero LLM cost.
 *
 * ## Level 2: Semantic detection (LLM-driven)
 *
 * When `enableSemanticAnalysis` is true, the detector sends a prompt
 * to the SHARING_ANALYZER conversation to evaluate whether a delta
 * creates semantic conflicts with other agents' work.
 *
 * Semantic detection catches subtler conflicts (contradictory assumptions,
 * incompatible API contracts, etc.) but costs tokens per evaluation.
 *
 * ## Lifecycle
 *
 * 1. After each significant delta, `evaluate()` is called
 * 2. Structural checks are performed (file overlaps, stale shares)
 * 3. If enabled, semantic analysis is performed via LLM
 * 4. Detected conflicts are recorded and returned
 * 5. The AgentPool handles alerting affected agents and emitting events
 *
 * ## Integration with other systems
 *
 * - **ORCHESTRATOR** (évolution 16): Conflict records are available to the
 *   orchestrator for its coherenceScore assessment. High-severity conflicts
 *   lower the coherence score.
 * - **StructuredContextInjection** (évolution 08): Conflict alerts are
 *   injected into affected agents with CRITICAL priority and
 *   `coordination_alert` category.
 * - **CheckpointEvaluator** (évolution 15): Conflict count is included
 *   in checkpoint health assessments.
 */
export class ConflictDetector {
    /** Resolved configuration with defaults. */
    private readonly config: Required<ConflictDetectorConfig>;

    /** All detected conflicts in the current execution. */
    private readonly conflicts: ConflictRecord[] = [];

    /** Counter for unique conflict IDs. */
    private _conflictIdCounter = 0;

    /** Running count of evaluations performed. */
    private _evaluationCount = 0;

    /** Running count of structural checks performed. */
    private _structuralCheckCount = 0;

    /** Running count of semantic analyses performed (LLM calls). */
    private _semanticAnalysisCount = 0;

    constructor(
        private readonly conversations: ConversationManager,
        private readonly contextTracker: ContextTracker,
        private readonly logger: pino.Logger,
        config?: ConflictDetectorConfig,
    ) {
        this.config = {
            enabled: config?.enabled ?? true,
            enableSemanticAnalysis: config?.enableSemanticAnalysis ?? true,
            minAlertSeverity: config?.minAlertSeverity ?? DEFAULT_MIN_ALERT_SEVERITY,
            maxConflicts: config?.maxConflicts ?? DEFAULT_MAX_CONFLICTS,
        };
    }

    // ── Public API ─────────────────────────────────────────────────────

    /**
     * Evaluates a context delta for potential conflicts with other agents.
     *
     * Performs structural checks first (zero LLM cost), then optionally
     * runs semantic analysis if enabled.
     *
     * @param delta - The delta to evaluate.
     * @param broker - The information broker (for sharing history).
     * @returns An array of detected conflicts (may be empty).
     */
    async evaluate(
        delta: ContextDelta,
        broker: InformationBroker | null,
    ): Promise<ConflictRecord[]> {
        if (!this.config.enabled) return [];

        // Pre-filter: only check conflict-triggering delta types
        if (!CONFLICT_TRIGGERING_DELTA_TYPES.has(delta.type)) return [];

        // Pre-filter: skip low-significance deltas
        if (delta.significance < MIN_CONFLICT_CHECK_SIGNIFICANCE) return [];

        // Pre-filter: need at least 2 agents for conflicts
        if (this.contextTracker.agentCount < 2) return [];

        this._evaluationCount++;

        const newConflicts: ConflictRecord[] = [];

        // ── Level 1: Structural detection ──────────────────────────
        const structuralConflicts = this.detectStructuralConflicts(delta, broker);
        this._structuralCheckCount++;
        newConflicts.push(...structuralConflicts);

        // ── Level 2: Semantic detection (optional) ─────────────────
        if (this.config.enableSemanticAnalysis && newConflicts.length === 0) {
            // Only run semantic analysis if no structural conflicts were found.
            // Structural conflicts are definitive — no need for LLM confirmation.
            // Semantic analysis catches the subtler cases that structural checks miss.
            const semanticConflicts = await this.detectSemanticConflicts(delta, broker);
            newConflicts.push(...semanticConflicts);
        }

        // Store and enforce limits
        for (const conflict of newConflicts) {
            if (this.conflicts.length >= this.config.maxConflicts) {
                // Evict the oldest resolved conflict, or the oldest overall
                const resolvedIndex = this.conflicts.findIndex((c) => c.resolved);
                if (resolvedIndex >= 0) {
                    this.conflicts.splice(resolvedIndex, 1);
                } else {
                    this.conflicts.shift();
                }
            }
            this.conflicts.push(conflict);
        }

        if (newConflicts.length > 0) {
            this.logger.info(
                {
                    sourceAgentId: delta.agentId,
                    deltaType: delta.type,
                    conflictCount: newConflicts.length,
                    types: newConflicts.map((c) => c.type),
                    severities: newConflicts.map((c) => c.severity),
                },
                `${newConflicts.length} conflict(s) detected from ${delta.agentName}`,
            );
        }

        return newConflicts;
    }

    /**
     * Marks a conflict as resolved (alert sent to affected agents).
     *
     * @param conflictId - The conflict to mark as resolved.
     */
    markResolved(conflictId: string): void {
        const conflict = this.conflicts.find((c) => c.id === conflictId);
        if (conflict) {
            conflict.resolved = true;
        }
    }

    /**
     * Returns all conflicts that should trigger alerts (severity >= threshold
     * and not yet resolved).
     */
    getUnresolvedAlerts(): readonly ConflictRecord[] {
        return this.conflicts.filter(
            (c) => !c.resolved && c.severity >= this.config.minAlertSeverity,
        );
    }

    // ── Query ──────────────────────────────────────────────────────────

    /** All detected conflicts. */
    getAllConflicts(): readonly ConflictRecord[] {
        return [...this.conflicts];
    }

    /** Total number of conflicts detected. */
    get conflictCount(): number {
        return this.conflicts.length;
    }

    /** Total evaluations performed. */
    get evaluationCount(): number {
        return this._evaluationCount;
    }

    /** Total structural checks performed. */
    get structuralCheckCount(): number {
        return this._structuralCheckCount;
    }

    /** Total semantic analysis (LLM) calls performed. */
    get semanticAnalysisCount(): number {
        return this._semanticAnalysisCount;
    }

    /** Whether conflict detection is enabled. */
    get isEnabled(): boolean {
        return this.config.enabled;
    }

    /** Number of unresolved high-severity conflicts. */
    get unresolvedHighSeverityCount(): number {
        return this.conflicts.filter(
            (c) => !c.resolved && c.severity >= 0.7,
        ).length;
    }

    /**
     * Returns a summary suitable for inclusion in checkpoint or
     * orchestrator prompts.
     */
    getSummary(): string | null {
        if (this.conflicts.length === 0) return null;

        const unresolved = this.conflicts.filter((c) => !c.resolved);
        const highSeverity = unresolved.filter((c) => c.severity >= 0.7);

        const lines: string[] = [
            `## Conflict Summary`,
            `- Total detected: ${this.conflicts.length}`,
            `- Unresolved: ${unresolved.length}`,
            `- High severity (≥0.7): ${highSeverity.length}`,
        ];

        if (highSeverity.length > 0) {
            lines.push("", "### High Severity Conflicts");
            for (const c of highSeverity.slice(0, 5)) {
                lines.push(`- [${c.type}] ${c.description}`);
            }
        }

        return lines.join("\n");
    }

    // ── Lifecycle ──────────────────────────────────────────────────────

    /** Resets all state for a new execution. */
    reset(): void {
        this.conflicts.length = 0;
        this._conflictIdCounter = 0;
        this._evaluationCount = 0;
        this._structuralCheckCount = 0;
        this._semanticAnalysisCount = 0;
    }

    // ── Private: Structural Detection ──────────────────────────────────

    /**
     * Detects structural conflicts from data available in the ContextTracker.
     *
     * Zero LLM cost — purely data-driven.
     */
    private detectStructuralConflicts(
        delta: ContextDelta,
        broker: InformationBroker | null,
    ): ConflictRecord[] {
        const conflicts: ConflictRecord[] = [];

        // ── File overlap detection ─────────────────────────────────
        if (delta.type === DeltaType.FILE_WRITTEN) {
            const filePath = delta.data.path as string | undefined;
            if (filePath) {
                const fileOverlapConflicts = this.detectFileOverlaps(
                    delta.agentId,
                    delta.agentName,
                    filePath,
                );
                conflicts.push(...fileOverlapConflicts);
            }
        }

        // ── Stale share detection ──────────────────────────────────
        if (broker && delta.type === DeltaType.FILE_WRITTEN) {
            const filePath = delta.data.path as string | undefined;
            if (filePath) {
                const staleConflicts = this.detectStaleShares(
                    delta.agentId,
                    delta.agentName,
                    filePath,
                    broker,
                );
                conflicts.push(...staleConflicts);
            }
        }

        return conflicts;
    }

    /**
     * Checks if a file was already written by another agent.
     */
    private detectFileOverlaps(
        sourceAgentId: string,
        sourceAgentName: string,
        filePath: string,
    ): ConflictRecord[] {
        const conflicts: ConflictRecord[] = [];
        const otherStates = this.contextTracker.getOtherAgentStates(sourceAgentId);

        for (const other of otherStates) {
            if (other.completed) continue; // Completed agents are not affected

            if (other.filesWritten.includes(filePath)) {
                // Check if we already have a conflict for this exact file + agents pair
                const existing = this.conflicts.find(
                    (c) =>
                        c.type === "file_overlap" &&
                        c.filePath === filePath &&
                        (c.sourceAgentId === sourceAgentId || c.affectedAgentIds.includes(sourceAgentId)) &&
                        (c.sourceAgentId === other.agentId || c.affectedAgentIds.includes(other.agentId)),
                );

                if (existing) continue; // Already detected

                this._conflictIdCounter++;
                conflicts.push({
                    id: `conflict-${this._conflictIdCounter}`,
                    type: "file_overlap",
                    severity: 0.8, // File overlaps are high severity by default
                    description:
                        `File "${filePath}" was written by both ${sourceAgentName} and ${other.agentName}. ` +
                        `The later write (by ${sourceAgentName}) may have overwritten or conflicted with ` +
                        `${other.agentName}'s version.`,
                    sourceAgentId,
                    sourceAgentName,
                    affectedAgentIds: [other.agentId],
                    filePath,
                    recommendation:
                        `Alert ${other.agentName} that "${filePath}" has been modified by ${sourceAgentName}. ` +
                        `${other.agentName} should verify their work is still consistent with the updated file.`,
                    timestamp: isoNow(),
                    resolved: false,
                });
            }
        }

        return conflicts;
    }

    /**
     * Checks if a file write invalidates previously shared information.
     *
     * If agent A shared info about file X with agent B, and agent A
     * subsequently rewrites file X, the shared info may be stale.
     */
    private detectStaleShares(
        sourceAgentId: string,
        sourceAgentName: string,
        filePath: string,
        broker: InformationBroker,
    ): ConflictRecord[] {
        const conflicts: ConflictRecord[] = [];

        // Check if any sharing records reference this file
        // The sharing history is indexed by target agent
        const otherStates = this.contextTracker.getOtherAgentStates(sourceAgentId);

        for (const other of otherStates) {
            if (other.completed) continue;

            // Get what was shared FROM the source TO this target
            const previousShares = broker.getRecentSharingsForTarget(other.agentId);

            for (const share of previousShares) {
                if (share.sourceAgentId !== sourceAgentId) continue;

                // Check if the share mentions the file path
                const mentionsFile =
                    share.informationSummary.includes(filePath) ||
                    share.informationSummary.includes(filePath.split("/").pop() ?? "");

                if (!mentionsFile) continue;

                // Check if this is a new write (not the same event that triggered the share)
                // We detect staleness by seeing that the file was written AGAIN after sharing
                const alreadyDetected = this.conflicts.find(
                    (c) =>
                        c.type === "stale_share" &&
                        c.filePath === filePath &&
                        c.sourceAgentId === sourceAgentId &&
                        c.affectedAgentIds.includes(other.agentId),
                );

                if (alreadyDetected) continue;

                this._conflictIdCounter++;
                conflicts.push({
                    id: `conflict-${this._conflictIdCounter}`,
                    type: "stale_share",
                    severity: 0.7,
                    description:
                        `${sourceAgentName} modified "${filePath}" after information about it was shared ` +
                        `with ${other.agentName}. The previously shared information may now be stale.`,
                    sourceAgentId,
                    sourceAgentName,
                    affectedAgentIds: [other.agentId],
                    filePath,
                    staleInformation: share.informationSummary,
                    recommendation:
                        `Re-share updated information about "${filePath}" with ${other.agentName}. ` +
                        `The previously shared info was: "${share.informationSummary.slice(0, 150)}".`,
                    timestamp: isoNow(),
                    resolved: false,
                });
            }
        }

        return conflicts;
    }

    // ── Private: Semantic Detection ────────────────────────────────────

    /**
     * Uses the LLM to detect semantic conflicts that structural checks miss.
     *
     * Sends a one-shot prompt to the SHARING_ANALYZER conversation with
     * the delta context and other agents' states.
     */
    private async detectSemanticConflicts(
        delta: ContextDelta,
        broker: InformationBroker | null,
    ): Promise<ConflictRecord[]> {
        this._semanticAnalysisCount++;

        const sourceState = this.contextTracker.getAgentState(delta.agentId);
        if (!sourceState) return [];

        const otherAgents = this.contextTracker.getOtherAgentStates(delta.agentId)
            .filter((s) => !s.completed && s.status !== "destroyed");

        if (otherAgents.length === 0) return [];

        // Build file overlap data for the prompt
        const fileOverlaps = this.buildFileOverlapData(delta.agentId);

        // Get sharing history
        const previouslySharedToSource = broker
            ? this.getSharingsToAgent(delta.agentId, broker)
            : [];
        const previouslySharedFromSource = broker
            ? this.getSharingsFromAgent(delta.agentId, broker)
            : [];

        const prompt = conflictAnalysisPrompt({
            sourceAgent: {
                agentName: sourceState.agentName,
                taskRole: sourceState.taskRole,
            },
            eventType: delta.type,
            eventSummary: delta.summary,
            filePath: (delta.data.path as string | undefined) ?? null,
            eventData: delta.data,
            otherAgents: otherAgents.map((s) => ({
                agentName: s.agentName,
                taskRole: s.taskRole,
                taskDescription: s.taskDescription,
                status: s.status,
                completed: s.completed,
                filesWritten: s.filesWritten,
                filesRead: s.filesRead,
            })),
            previouslySharedToSource: previouslySharedToSource.length > 0
                ? previouslySharedToSource
                : null,
            previouslySharedFromSource: previouslySharedFromSource.length > 0
                ? previouslySharedFromSource
                : null,
            fileOverlaps: fileOverlaps.length > 0 ? fileOverlaps : null,
        });

        try {
            const result = await this.conversations.sendOneShotJson(
                ConversationRole.SHARING_ANALYZER,
                prompt,
                validateConflictAnalysisResponse,
                { maxTokens: 500, maxJsonAttempts: 2 },
            );

            if (!result || !result.hasConflict || !result.conflicts) {
                this.logger.debug(
                    { agentId: delta.agentId, deltaType: delta.type },
                    "Semantic analysis: no conflict detected",
                );
                return [];
            }

            // Convert LLM response to ConflictRecords
            return result.conflicts.map((c) => {
                this._conflictIdCounter++;
                return {
                    id: `conflict-${this._conflictIdCounter}`,
                    type: c.type as ConflictType,
                    severity: c.severity,
                    description: c.description,
                    sourceAgentId: delta.agentId,
                    sourceAgentName: delta.agentName,
                    affectedAgentIds: c.affectedAgentIds,
                    filePath: (delta.data.path as string | undefined) ?? undefined,
                    staleInformation: c.staleInformation,
                    recommendation: c.recommendation,
                    timestamp: isoNow(),
                    resolved: false,
                };
            });
        } catch (error) {
            this.logger.warn(
                { error: toErrorMessage(error) },
                "Semantic conflict analysis failed — skipping",
            );
            return [];
        }
    }

    // ── Private: Helpers ───────────────────────────────────────────────

    /**
     * Builds file overlap data: files that have been written by multiple agents.
     */
    private buildFileOverlapData(
        currentAgentId: string,
    ): Array<{ filePath: string; agents: string[] }> {
        const fileToAgents = new Map<string, Set<string>>();

        for (const state of this.contextTracker.getAllAgentStates()) {
            for (const file of state.filesWritten) {
                let agents = fileToAgents.get(file);
                if (!agents) {
                    agents = new Set();
                    fileToAgents.set(file, agents);
                }
                agents.add(state.agentName);
            }
        }

        // Return only files with 2+ writers
        const overlaps: Array<{ filePath: string; agents: string[] }> = [];
        for (const [filePath, agents] of fileToAgents) {
            if (agents.size >= 2) {
                overlaps.push({ filePath, agents: [...agents] });
            }
        }

        return overlaps;
    }

    /**
     * Gets sharing records where the target is the specified agent.
     */
    private getSharingsToAgent(
        agentId: string,
        broker: InformationBroker,
    ): Array<{ deltaType: string; sourceAgentName: string; informationSummary: string }> {
        const records = broker.getRecentSharingsForTarget(agentId, 5);
        return records.map((r) => {
            const sourceName = this.contextTracker.getAgentState(r.sourceAgentId)?.agentName ?? "unknown";
            return {
                deltaType: r.deltaType,
                sourceAgentName: sourceName,
                informationSummary: r.informationSummary,
            };
        });
    }

    /**
     * Gets sharing records where the source is the specified agent.
     */
    private getSharingsFromAgent(
        agentId: string,
        broker: InformationBroker,
    ): Array<{ deltaType: string; targetAgentName: string; informationSummary: string }> {
        // We need to check all agents' sharing histories for records from this source
        const results: Array<{ deltaType: string; targetAgentName: string; informationSummary: string }> = [];

        for (const state of this.contextTracker.getAllAgentStates()) {
            if (state.agentId === agentId) continue;

            const records = broker.getRecentSharingsForTarget(state.agentId, 10);
            for (const r of records) {
                if (r.sourceAgentId === agentId) {
                    results.push({
                        deltaType: r.deltaType,
                        targetAgentName: state.agentName,
                        informationSummary: r.informationSummary,
                    });
                }
            }
        }

        return results.slice(0, 5);
    }
}
```

### 8. Intégrer le `ConflictDetector` dans `AgentPool`

#### A. Ajouter le champ dans la classe

```typescript
// In the "Infrastructure" section of AgentPool
export class AgentPool extends EventEmitter {
    // ... existants ...

    /** Inter-agent conflict detection engine. */
    private conflictDetector: ConflictDetector | null = null;
}
```

#### B. Instancier dans `execute()`, après le spawn

```typescript
// In execute(), after creating the InformationBroker
// (the conflict detector needs the context tracker and conversations)

if (analysis.strategy !== ExecutionStrategy.SINGLE) {
    this.conflictDetector = new ConflictDetector(
        this.conversations,
        this.contextTracker,
        this.logger,
        this.config.conflictDetection,
    );
}
```

#### C. Call conflict detection in `handleDelta()`

```typescript
// In handleDelta(), after sharing and notification evaluation

// ── Conflict Detection ─────────────────────────────────────
if (this.conflictDetector?.isEnabled) {
    try {
        const conflicts = await this.conflictDetector.evaluate(
            delta,
            this.informationBroker,
        );

        for (const conflict of conflicts) {
            this.emitPoolEvent(PoolEvent.CONFLICT_DETECTED, { conflict });

            // Alert affected agents if severity is above threshold
            if (conflict.severity >= (this.config.conflictDetection?.minAlertSeverity ?? 0.5)) {
                this.alertAffectedAgents(conflict);
            }
        }
    } catch (error) {
        this.logger.warn(
            { error: toErrorMessage(error), agentId: delta.agentId },
            "Conflict detection failed (non-critical)",
        );
    }
}
```

#### D. Method `alertAffectedAgents()`

```typescript
/**
 * Sends structured conflict alerts to all affected agents.
 *
 * Uses the StructuredContextInjection system (évolution 08) with
 * CRITICAL priority and coordination_alert category.
 *
 * @param conflict - The detected conflict to alert about.
 */
private alertAffectedAgents(conflict: ConflictRecord): void {
    for (const targetAgentId of conflict.affectedAgentIds) {
        const targetEntry = this.managedAgents.get(targetAgentId);
        if (!targetEntry || targetEntry.agent.status === AgentStatus.DESTROYED) continue;

        const alertContent =
            `⚠️ CONFLICT ALERT: ${conflict.description}\n\n` +
            `Recommendation: ${conflict.recommendation}` +
            (conflict.staleInformation
                ? `\n\nPreviously shared info that may be stale: "${conflict.staleInformation}"`
                : "");

        try {
            targetEntry.agent.injectStructured({
                content: alertContent,
                priority: "critical",
                category: "coordination_alert",
                source: `conflict-detector (from ${conflict.sourceAgentName})`,
                dependencyType: null,
                timestamp: conflict.timestamp,
            });

            this.logger.info(
                {
                    conflictId: conflict.id,
                    conflictType: conflict.type,
                    targetAgentId,
                    targetAgentName: targetEntry.agent.name,
                    severity: conflict.severity,
                },
                `Conflict alert sent to ${targetEntry.agent.name}: ${conflict.description.slice(0, 100)}`,
            );
        } catch (injectError) {
            this.logger.warn(
                {
                    targetAgentId,
                    error: toErrorMessage(injectError),
                },
                "Failed to inject conflict alert",
            );
        }
    }

    // Mark as resolved (alert sent)
    this.conflictDetector?.markResolved(conflict.id);
}
```

#### E. Expose conflict data to orchestrator and checkpoint

The `ConflictDetector.getSummary()` method returns formatted text suitable for inclusion in orchestrator and checkpoint prompts. These subsystems can query it:

```typescript
// In evaluateOrchestrator() — add conflict summary to the evaluation data
const conflictSummary = this.conflictDetector?.getSummary() ?? null;

// Pass to the orchestrator's evaluation prompt (extend the template)
```

```typescript
// In executeCheckpoint() — add conflict data to checkpoint context
const conflictCount = this.conflictDetector?.conflictCount ?? 0;
const unresolvedHighSeverity = this.conflictDetector?.unresolvedHighSeverityCount ?? 0;
```

#### F. Expose conflict state in `AgentPoolState`

```typescript
// In AgentPoolState
interface AgentPoolState {
    // ... existing fields ...

    /** Number of conflicts detected in the current execution. */
    readonly conflictCount: number;

    /** Number of unresolved high-severity conflicts. */
    readonly unresolvedConflictCount: number;
}
```

Update `getState()`:

```typescript
getState(): AgentPoolState {
    return {
        // ... existing fields ...
        conflictCount: this.conflictDetector?.conflictCount ?? 0,
        unresolvedConflictCount: this.conflictDetector?.unresolvedHighSeverityCount ?? 0,
    };
}
```

#### G. Cleanup in `execute()` finally block

```typescript
// In the finally block of execute()
this.conflictDetector = null;
```

#### H. Add event listener in the example file

```typescript
// In src/examples/agent-pool.ts
pool.on(PoolEvent.CONFLICT_DETECTED, (e) => {
    const { conflict } = e;
    const severityColor = conflict.severity >= 0.7 ? ansi.red :
                          conflict.severity >= 0.4 ? ansi.yellow : ansi.dim;
    info(
        "⚡",
        `${severityColor}Conflict [${conflict.type}]: ${truncate(conflict.description, 120)}${ansi.reset}`,
    );
    info(
        "  ",
        `${ansi.dim}Severity: ${conflict.severity}, Affected: ${conflict.affectedAgentIds.join(", ")}${ansi.reset}`,
    );
    info(
        "  ",
        `${ansi.dim}Recommendation: ${truncate(conflict.recommendation, 100)}${ansi.reset}`,
    );
});
```

---

## Interaction avec les évolutions précédentes

### Avec l'évolution 08 (Structured context injection)

Les alertes de conflit sont injectées via `injectStructured()` avec :
- `priority: "critical"` — les conflits sont les plus urgents
- `category: "coordination_alert"` — catégorie dédiée pour la coordination
- `source: "conflict-detector"` — identifie l'origine

L'`AgentContextManager` (évolution 08) trie par priorité. Les alertes `CRITICAL` apparaissent en premier dans le prompt de l'agent, avant tout autre contexte injecté. Cela garantit que l'agent voit l'alerte de conflit immédiatement.

### Avec l'évolution 02 (SharingHistory)

Le `ConflictDetector` lit l'historique de partage via `broker.getRecentSharingsForTarget()` pour détecter les `stale_share` conflicts. Il ne modifie jamais l'historique — il est un consommateur en lecture seule.

### Avec l'évolution 16 (OrchestratorEngine)

L'`OrchestratorEngine` reçoit les données de conflit via `conflictDetector.getSummary()`. Les conflits de haute sévérité réduisent le `coherenceScore` de l'orchestrator. L'orchestrator peut émettre des directives pour améliorer le partage en réponse aux conflits (ex: « Share more frequently between api-developer and test-writer to prevent stale information »).

La catégorie d'issue `"conflict"` dans l'`OrchestratorAssessment` est maintenant alimentée par de vraies données de conflit, pas seulement des observations LLM.

### Avec l'évolution 15 (CheckpointEvaluator)

Le nombre de conflits et leur sévérité sont inclus dans les données du checkpoint. Un checkpoint peut déclencher un `REPLAN` si trop de conflits de haute sévérité s'accumulent.

### Avec l'évolution 09 (Dynamic significance threshold)

La détection de conflits utilise son propre seuil (`MIN_CONFLICT_CHECK_SIGNIFICANCE = 0.4`) distinct du seuil de sharing. Les `FILE_WRITTEN` events ont une significance de 0.5 dans le `ContextTracker`, ce qui les rend éligibles à la détection de conflit mais pas nécessairement au sharing (seuil dynamique peut être > 0.5).

### Avec l'évolution 11 (Adaptive re-planning)

Des conflits répétés entre les mêmes agents peuvent signaler un problème de décomposition. Si le conflit detector rapporte 3+ conflits `file_overlap` entre deux agents, cela peut déclencher un re-planning avec le trigger `CASCADING_FAILURES` ou un nouveau trigger `CONFLICT_ESCALATION`.

---

## Gestion du budget tokens

### Structural detection : zéro coût LLM

La détection de file overlaps et de stale shares est purement programmatique. Aucun appel LLM. Ce niveau de détection est toujours actif et gratuit.

### Semantic detection : coût conditionnel

| Section | Tokens estimés |
|---------|---------------|
| System prompt (reuses SHARING_ANALYZER) | 0 (déjà chargé) |
| User prompt (conflict analysis) | ~400-600 |
| Output (JSON) | ~200-300 |
| **Total par évaluation** | **~600-900** |

### Fréquence des évaluations sémantiques

L'analyse sémantique n'est déclenchée que si :
1. Le delta est un `FILE_WRITTEN`, `PROMPT_COMPLETE`, ou `TOOL_COMPLETE`
2. La significance est ≥ 0.4
3. Il y a ≥ 2 agents actifs
4. Aucun conflit structurel n'a été trouvé (les conflits structurels sont définitifs)

Dans une exécution typique avec 3 agents et 10-15 deltas significatifs par agent :
- Deltas éligibles : ~15-20 (après filtrage de type et significance)
- Conflits structurels détectés : ~2-5 (ceux-ci ne déclenchent PAS d'analyse sémantique)
- Analyses sémantiques : ~10-15
- **Coût total** : ~6000-13500 tokens

### Garde-fous

- `enableSemanticAnalysis: false` désactive complètement le coût LLM tout en gardant la détection structurelle
- Le semantic analysis est skippé quand un conflit structurel est trouvé (pas besoin de confirmation LLM)
- `maxConflicts: 50` empêche l'accumulation mémoire
- Le pre-filter sur le type de delta et la significance réduit le nombre d'évaluations

---

## Tests à implémenter

### Tests unitaires pour `ConflictDetector`

#### Test 1 : `evaluate` retourne un tableau vide quand disabled

- Setup : créer un detector avec `enabled: false`
- Appeler `evaluate()` avec un delta significatif
- Assert : retourne `[]`
- Assert : `evaluationCount` === 0

#### Test 2 : `evaluate` retourne un tableau vide pour les delta types non-triggering

- Setup : créer un detector
- Appeler `evaluate()` avec un delta de type `STATUS_CHANGE`
- Assert : retourne `[]`

#### Test 3 : `evaluate` retourne un tableau vide avec moins de 2 agents

- Setup : mock `contextTracker.agentCount` → 1
- Assert : retourne `[]`

#### Test 4 : `detectFileOverlaps` détecte quand deux agents écrivent le même fichier

- Setup : agent-A a écrit `src/index.ts`, agent-B écrit `src/index.ts`
- Évaluer un delta `FILE_WRITTEN` de agent-B pour `src/index.ts`
- Assert : un conflit `file_overlap` est retourné
- Assert : severity >= 0.7
- Assert : `affectedAgentIds` contient agent-A

#### Test 5 : `detectFileOverlaps` ne signale PAS un conflit si l'autre agent a terminé

- Setup : agent-A a écrit `src/index.ts` et est `completed: true`
- Évaluer un delta de agent-B pour le même fichier
- Assert : aucun conflit (l'agent terminé n'est pas affecté)

#### Test 6 : `detectFileOverlaps` ne signale PAS un conflit en double

- Setup : agent-A et agent-B écrivent le même fichier
- Premier `evaluate()` → 1 conflit
- Deuxième `evaluate()` (même fichier, même agents) → 0 conflit (déjà détecté)

#### Test 7 : `detectStaleShares` détecte quand un fichier partagé est réécrit

- Setup : agent-A partage info sur `src/routes.ts` avec agent-B (via SharingHistory)
- Agent-A écrit à nouveau `src/routes.ts`
- Assert : un conflit `stale_share` est retourné
- Assert : `staleInformation` contient le résumé de l'info partagée

#### Test 8 : `detectStaleShares` ne signale PAS de staleness pour des fichiers non mentionnés

- Setup : agent-A partage info sur `src/routes.ts` avec agent-B
- Agent-A écrit `src/models.ts` (fichier différent)
- Assert : aucun conflit stale_share

#### Test 9 : Semantic analysis est skippé quand un conflit structurel est trouvé

- Setup : file overlap détecté
- Assert : `semanticAnalysisCount` n'est pas incrémenté
- Assert : pas d'appel LLM

#### Test 10 : Semantic analysis est appelé quand aucun conflit structurel n'est trouvé

- Setup : `enableSemanticAnalysis: true`, pas de file overlap
- Mock `conversations.sendOneShotJson` pour retourner `{ hasConflict: false }`
- Assert : `semanticAnalysisCount` est incrémenté

#### Test 11 : Semantic analysis retourne des conflits quand le LLM en détecte

- Setup : mock `conversations.sendOneShotJson` pour retourner un conflit sémantique
- Assert : le conflit est retourné avec le bon type et les bons champs

#### Test 12 : Semantic analysis retourne un tableau vide en cas d'erreur LLM

- Setup : mock `conversations.sendOneShotJson` qui throw
- Assert : retourne `[]`
- Assert : pas de crash, un warning est loggé

#### Test 13 : `markResolved` marque un conflit comme résolu

- Setup : détecter un conflit, noter son ID
- Appeler `markResolved(conflictId)`
- Assert : le conflit a `resolved: true`

#### Test 14 : `getUnresolvedAlerts` filtre par severity et résolution

- Setup : créer 3 conflits — severity 0.3, 0.6, 0.9
- Assert : `getUnresolvedAlerts()` retourne 2 conflits (0.6 et 0.9)
- Résoudre le conflit 0.6
- Assert : `getUnresolvedAlerts()` retourne 1 conflit (0.9)

#### Test 15 : `maxConflicts` évince les anciens conflits

- Setup : detector avec `maxConflicts: 3`
- Détecter 5 conflits
- Assert : `conflictCount` === 3
- Assert : les 3 conflits restants sont les plus récents

#### Test 16 : `maxConflicts` évince les résolus en priorité

- Setup : detector avec `maxConflicts: 3`
- Détecter 3 conflits, résoudre le premier
- Détecter un 4ème
- Assert : `conflictCount` === 3
- Assert : le conflit résolu est évincé, pas les non-résolus

#### Test 17 : `getSummary` retourne `null` sans conflits

- Assert : `getSummary()` === `null`

#### Test 18 : `getSummary` formate correctement

- Setup : détecter 2 conflits, un à severity 0.8 et un à 0.3
- Assert : le résumé contient "High Severity Conflicts"
- Assert : le résumé contient le conflit à 0.8
- Assert : le résumé montre le compte total

#### Test 19 : `reset` nettoie tout l'état

- Setup : détecter des conflits, effectuer des évaluations
- Appeler `reset()`
- Assert : `conflictCount` === 0, `evaluationCount` === 0

### Tests pour le validateur

#### Test 20 : `validateConflictAnalysisResponse` accepte une réponse sans conflit

```typescript
const valid = {
    hasConflict: false,
    reasoning: "No conflicts detected",
};
// Assert: validateConflictAnalysisResponse(valid) !== null
// Assert: result.hasConflict === false
```

#### Test 21 : `validateConflictAnalysisResponse` accepte une réponse avec conflit

```typescript
const valid = {
    hasConflict: true,
    conflicts: [
        {
            type: "semantic_conflict",
            severity: 0.7,
            description: "API uses snake_case but frontend expects camelCase",
            affectedAgentIds: ["agent-B"],
            recommendation: "Align on JSON naming convention",
        },
    ],
    reasoning: "Naming convention mismatch detected",
};
// Assert: validateConflictAnalysisResponse(valid) !== null
// Assert: result.hasConflict === true
// Assert: result.conflicts.length === 1
```

#### Test 22 : `validateConflictAnalysisResponse` rejette `hasConflict: true` sans conflits array

```typescript
const invalid = {
    hasConflict: true,
    reasoning: "There is a conflict",
};
// Assert: validateConflictAnalysisResponse(invalid) === null
```

#### Test 23 : `validateConflictAnalysisResponse` rejette un type de conflit invalide

```typescript
const invalid = {
    hasConflict: true,
    conflicts: [
        { type: "magic_conflict", severity: 0.5, description: "test", affectedAgentIds: [], recommendation: "test" },
    ],
    reasoning: "test",
};
// Assert: validateConflictAnalysisResponse(invalid) === null
```

#### Test 24 : `validateConflictAnalysisResponse` clamp la severity dans [0, 1]

```typescript
const data = {
    hasConflict: true,
    conflicts: [
        { type: "file_overlap", severity: 1.5, description: "test", affectedAgentIds: ["a"], recommendation: "test" },
    ],
    reasoning: "test",
};
const result = validateConflictAnalysisResponse(data);
// Assert: result.conflicts[0].severity === 1.0
```

### Tests d'intégration

#### Test 25 : `AgentPool.handleDelta()` déclenche la détection de conflit en multi-agent

- Setup : créer un pool multi-agent, configurer 2 agents qui écrivent le même fichier
- Assert : l'événement `CONFLICT_DETECTED` est émis

#### Test 26 : Les alertes de conflit sont injectées dans les agents affectés

- Setup : détecter un conflit avec severity >= 0.5
- Mock `agent.injectStructured` pour capturer l'appel
- Assert : `injectStructured` est appelé avec `priority: "critical"` et `category: "coordination_alert"`
- Assert : le contenu contient la description du conflit et la recommandation

#### Test 27 : Les conflits en dessous du seuil ne déclenchent PAS d'alerte

- Setup : détecter un conflit avec severity 0.3, `minAlertSeverity: 0.5`
- Assert : `injectStructured` n'est PAS appelé
- Assert : le conflit est quand même stocké dans `getAllConflicts()`

#### Test 28 : Le conflict detector n'est PAS instancié pour les exécutions single-agent

- Setup : exécuter une tâche simple (single-agent)
- Assert : `getState().conflictCount === 0`

#### Test 29 : L'état des conflits est exposé dans `getState()`

- Setup : détecter 2 conflits, un résolu et un non-résolu
- Assert : `getState().conflictCount === 2`
- Assert : `getState().unresolvedConflictCount === 1`

#### Test 30 : Le conflict detector est nettoyé entre les exécutions

- Setup : exécuter une tâche, détecter des conflits
- Exécuter une seconde tâche
- Assert : `conflictCount` redémarre à 0

#### Test 31 : Le `getSummary()` du conflict detector est accessible par l'orchestrator

- Setup : détecter des conflits high-severity
- Assert : `conflictDetector.getSummary()` retourne un texte non-null
- Assert : le texte contient "High Severity Conflicts"

### Tests de non-régression

#### Test 32 : Le sharing fonctionne normalement sans conflits

- Setup : exécution multi-agent sans file overlaps
- Assert : le sharing évalue et partage normalement
- Assert : `conflictCount === 0`

#### Test 33 : Le `StructuredContextInjection` (évolution 08) accepte les alertes de conflit

- Setup : injecter une alerte de conflit via `injectStructured`
- Assert : le `drain()` de l'`AgentContextManager` retourne le contenu avec le header `[COORDINATION ALERT]`
- Assert : les alertes CRITICAL apparaissent avant le contexte NORMAL

#### Test 34 : Les exécutions sans config `conflictDetection` fonctionnent inchangées

- Setup : créer un pool sans le champ `conflictDetection`
- Assert : l'exécution fonctionne normalement
- Assert : la détection de conflit est auto-enabled pour multi-agent (config par défaut)

#### Test 35 : Désactiver la détection sémantique préserve la détection structurelle

- Setup : `conflictDetection: { enableSemanticAnalysis: false }`
- Créer un file overlap
- Assert : le conflit `file_overlap` est détecté (structurel)
- Assert : `semanticAnalysisCount === 0` (pas d'appel LLM)

---

## Critères de validation

- [ ] Le `DeltaType.CONFLICT_DETECTED` est ajouté à l'enum
- [ ] Le `PoolEvent.CONFLICT_DETECTED` est ajouté et émis lors de la détection
- [ ] Le `ConflictDetector` détecte les file overlaps (structurel, zero LLM cost)
- [ ] Le `ConflictDetector` détecte les stale shares (structurel, zero LLM cost)
- [ ] Le `ConflictDetector` détecte les conflits sémantiques via LLM (optionnel)
- [ ] L'analyse sémantique est skippée quand un conflit structurel est trouvé
- [ ] Les alertes de conflit sont injectées via `injectStructured()` avec `priority: "critical"`
- [ ] `markResolved()` marque un conflit et empêche les alertes en double
- [ ] Le dedup empêche de signaler le même file overlap deux fois
- [ ] L'état des conflits est exposé dans `AgentPoolState` (`conflictCount`, `unresolvedConflictCount`)
- [ ] `getSummary()` retourne un texte formaté pour les prompts de l'orchestrator et du checkpoint
- [ ] Le conflict detector n'est PAS instancié pour les exécutions single-agent
- [ ] Le validateur `validateConflictAnalysisResponse` valide les types de conflit
- [ ] Le `maxConflicts` empêche la croissance mémoire non bornée (éviction FIFO avec priorité aux résolus)
- [ ] L'échec de la détection de conflit est non-critique (logged, pas propagé)
- [ ] Le conflict detector est nettoyé dans le `finally` block de `execute()`
- [ ] Tous les tests existants passent toujours
- [ ] Les nouveaux tests couvrent structurel, sémantique, intégration et non-régression

---

## Points d'attention

1. **Le `ConflictDetector` utilise `SHARING_ANALYZER`** pour l'analyse sémantique. Il ne crée PAS de nouveau `ConversationRole`. Le system prompt du `SHARING_ANALYZER` (évolution 05) est suffisamment générique pour supporter l'analyse de conflit. Si on constate que le prompt ne guide pas assez bien les réponses de conflit, on pourra créer un `ConversationRole.CONFLICT_ANALYZER` dans une évolution future.

2. **Le `detectStaleShares` dépend de `broker.getRecentSharingsForTarget()`** (évolution 02). Vérifier que cette méthode existe et retourne des `SharingRecord` avec les champs `sourceAgentId`, `deltaType`, `informationSummary`. Si les noms de champs diffèrent, adapter.

3. **Le `injectStructured()` sur `PoolManagedAgent`** (évolution 08) doit être disponible. Vérifier que l'interface `PoolManagedAgent` expose cette méthode. Si seul `injectContext(string)` est exposé au niveau de l'interface, il faut soit mettre à jour l'interface, soit caster. L'évolution 08 devrait avoir ajouté `injectStructured` à l'interface.

4. **Les file overlaps ne sont pas toujours des conflits réels**. Deux agents peuvent écrire au même fichier intentionnellement (ex: l'un crée le squelette, l'autre ajoute du contenu). La severity de 0.8 est un default conservateur — le LLM sémantique (si activé) peut la réduire. Mais en structural-only mode, tous les file overlaps sont signalés à 0.8.

5. **Les stale shares sont une heuristique basée sur le nom de fichier**. Le `informationSummary` du `SharingRecord` est tronqué à 200 caractères (évolution 02). La recherche du nom de fichier dans ce résumé est un simple `includes()` — c'est un best-effort. Des faux positifs sont possibles (ex: un fichier nommé `index.ts` apparaît dans de nombreux résumés). Des faux négatifs aussi (le résumé ne mentionne pas le fichier par son chemin complet). C'est acceptable pour une première version.

6. **La détection sémantique n'est PAS exécutée si un conflit structurel est trouvé**. C'est une optimisation token — les conflits structurels sont définitifs et ne nécessitent pas de confirmation LLM. Si on veut aussi de l'analyse sémantique dans ces cas (pour des recommandations plus riches), on peut rendre ce comportement configurable.

7. **Le `ConflictDetector` est instancié par exécution** (comme l'`InformationBroker`). Il est créé dans `execute()` et nettoyé dans `finally`. Les conflits ne survivent pas entre les exécutions — c'est voulu car les agents changent à chaque exécution.

8. **Le feedback loop complet** (agent B signale un conflit → le broker re-partage l'info corrigée) n'est PAS implémenté dans cette évolution. La détection est proactive (le système détecte les conflits) mais la résolution est manuelle (l'agent reçoit une alerte et adapte son comportement). Une évolution future pourrait automatiser la re-partage.

9. **Le pre-filter `MIN_CONFLICT_CHECK_SIGNIFICANCE = 0.4`** est distinct du seuil dynamique de sharing (évolution 09). Les `FILE_WRITTEN` events ont une significance de 0.5, donc ils passent ce filtre. Les `FILE_READ` ont 0.2, donc ils sont exclus — ce qui est correct car lire un fichier ne crée jamais de conflit.

10. **La méthode `getSharingsFromAgent()`** est coûteuse : elle itère tous les agents et tous leurs sharing records. C'est O(agents × records). Pour les exécutions avec < 10 agents et < 20 records par agent, c'est négligeable. Pour de plus grandes échelles, on pourrait ajouter un index secondaire dans le `SharingHistory` (indexé par sourceAgentId en plus de targetAgentId).