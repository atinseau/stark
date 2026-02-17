# Évolution 15 — Points de contrôle et auto-évaluation en cours d'exécution

## Priorité : 🟡 P2

## Dépendances : Évolution 11 (Adaptive re-planning), Évolution 14 (Context analyzer session memory)

## Acquis des évolutions précédentes

- **Évolution 01** : L'`InformationBroker` reçoit les mappings `subtaskToAgent` / `agentToSubtask` via son constructeur. `isAgentForSubtask()` fonctionne. Le tri des candidats par dépendance est opérationnel. `findDependency()` traduit correctement entre agent IDs et subtask IDs.
- **Évolution 02** : L'`InformationBroker` maintient un `SharingHistory` indexé par agent cible. Le prompt de partage inclut les partages précédents (`previouslyShared`). `recordSharing()` est appelé après chaque injection réussie. Le type `SharingRecord` existe.
- **Évolution 03** : Le `ProjectScanner` scanne le répertoire de travail et produit un `ProjectContext`. Le planner reçoit le contexte projet (arborescence, langages, frameworks, configs résumés).
- **Évolution 04** : Tous les prompts LLM contiennent des exemples few-shot contrastifs.
- **Évolution 05** : Le rôle `ConversationRole.SHARING_ANALYZER` existe. Le system prompt `SHARING_ANALYZER` est dédié au partage inter-agents. L'`InformationBroker` utilise `SHARING_ANALYZER`. Le `CONTEXT_ANALYZER` est spécialisé notifications.
- **Évolution 06** : Le notification prompt est nettoyé (plus de vérifications redondantes). Le summary prompt inclut les `CoordinationStats` et `sharingSummaries`. `durationMs` est correctement calculé.
- **Évolution 07** : Le preview dans les deltas `PROMPT_COMPLETE` est augmenté à 2000 chars. Le champ `promptResultSummary` existe dans `ContextDelta`. L'`InformationBroker` dispose de `evaluateWithFullResult()` pour les blocking deps.
- **Évolution 08** : L'injection de contexte est structurée et priorisée. Les types `StructuredContextInjection`, `ContextInjectionPriority`, `ContextInjectionCategory` existent. L'`AgentContextManager` supporte les injections structurées avec tri par priorité, headers catégorisés, et overflow management (drop LOW/NORMAL, jamais CRITICAL/HIGH).
- **Évolution 09** : Le seuil de significance de l'`InformationBroker` est dynamique — plus bas en début d'exécution (exploration), plus haut en fin (focus), avec override par type de dépendance (seuil 0.3 pour blocking deps). Le `DynamicThresholdCalculator` ajuste le seuil en fonction de la phase d'exécution et du nombre de deltas traités.
- **Évolution 10** : Les subtasks ont un timeout configurable (`subtaskTimeoutMs`). Les agents qui dépassent le timeout sont marqués comme failed. Un mécanisme de retry individuel (`maxSubtaskRetries`) respawn un agent pour un subtask échoué avec le contexte d'erreur du précédent. Le `RetryTracker` suit les tentatives. Les retries sont injectés avec les informations d'échec précédentes.
- **Évolution 11** : Le `TaskPlanner` dispose d'une méthode `replan()` qui réévalue le plan en cours d'exécution quand des conditions le justifient (multiples échecs, deadlock, changements significatifs de contexte). Le `ReplanTrigger` détecte les conditions de replan. L'`AgentPool` peut créer de nouvelles subtasks et en abandonner d'autres via le replanning.
- **Évolution 12** : L'`IntentAnalyzer` supporte le multi-intent (retourne un `IntentAnalysis[]`). L'historique conversationnel (2-3 derniers échanges user-pool) est inclus dans le prompt d'intent analysis. Un seuil de confirmation pour les intents à faible confiance demande une clarification à l'utilisateur.
- **Évolution 13** : Le `TaskPlanner` utilise un résumé glissant au lieu d'un reset total. Avant chaque reset, les 3-5 dernières planifications sont résumées en un paragraphe condensé qui est prepend au system prompt. Le planner a une « mémoire de travail » inter-exécutions sans explosion de tokens.
- **Évolution 14** : Le `CONTEXT_ANALYZER` et le `SHARING_ANALYZER` maintiennent un journal de réflexion condensé intra-exécution. Les 5-10 dernières décisions (avec leur reasoning) sont accumulées dans la conversation. Le LLM peut détecter des patterns émergents dans les deltas et les décisions de partage. Le journal est purgé entre les exécutions.

---

## Contexte du problème

L'`AgentPool` exécute ses subtasks de manière **fire-and-forget** — une fois le plan lancé, le système fonce tête baissée jusqu'à la fin sans jamais prendre de recul pour évaluer si l'exécution va dans la bonne direction.

### Ce qui manque aujourd'hui

1. **Pas de point de contrôle** : le pool ne s'arrête jamais pour vérifier l'état global. Si un agent diverge de sa tâche (ex: commence à implémenter autre chose que demandé), personne ne le détecte avant la fin.

2. **Pas d'auto-évaluation globale** : le `ContextTracker` suit les deltas individuels, mais aucune analyse ne croise tous les deltas pour évaluer la cohérence d'ensemble. Deux agents pourraient créer des fichiers contradictoires sans que le système s'en rende compte.

3. **Le re-planning (évolution 11) est réactif, pas proactif** : il ne se déclenche que sur des événements négatifs (échecs, deadlocks). Il n'y a pas de vérification proactive « est-ce qu'on est toujours sur la bonne voie ? ».

4. **Le journal de réflexion (évolution 14) accumule des observations** mais ne tire jamais de conclusion globale — chaque décision est évaluée indépendamment, sans synthèse.

5. **L'utilisateur n'a aucune visibilité intermédiaire** : il doit attendre la fin de l'exécution pour avoir un résumé. Pour des exécutions longues (multi-agent, tâches complexes), cela peut prendre plusieurs minutes sans feedback.

### Impact

Sans checkpoints, les problèmes sont détectés trop tard. Un agent qui diverge pendant 2 minutes de travail gaspille des tokens et du temps. Un conflit entre deux agents (ex: l'un crée un fichier que l'autre supprime) n'est jamais détecté. Le re-planning n'est déclenché que par des échecs explicites, pas par des dérives subtiles.

---

## Fichiers impactés

| Fichier | Action |
|---------|--------|
| `src/classes/agent-pool/checkpoint-evaluator.ts` | **Nouveau fichier** — logique d'évaluation des checkpoints |
| `src/classes/agent-pool/agent-pool.ts` | Intégrer les checkpoints dans le cycle d'exécution |
| `src/prompts/checkpoint.ts` | **Nouveau fichier** — prompts pour l'évaluation de checkpoint |
| `src/prompts/index.ts` | Exporter les nouveaux prompts |
| `src/enums/pool-event.enum.ts` | Ajouter `CHECKPOINT_EVALUATED` |
| `src/types/agent-pool.types.ts` | Ajouter les types `CheckpointResult`, `CheckpointTrigger`, `CheckpointAction` |
| `src/enums/conversation-role.enum.ts` | Optionnel — potentiellement un rôle `CHECKPOINT_EVALUATOR` ou réutilisation de `CONTEXT_ANALYZER` |
| `src/classes/agent-pool/tests/` | Tests unitaires pour le `CheckpointEvaluator` |

---

## Spécification détaillée des changements

### 1. Nouveaux types dans `agent-pool.types.ts`

```typescript
/**
 * Conditions qui déclenchent une évaluation de checkpoint.
 */
export enum CheckpointTrigger {
    /** Un pourcentage de subtasks ont terminé (configurable). */
    COMPLETION_PERCENTAGE = "completion_percentage",

    /** Un nombre fixe de deltas ont été traités depuis le dernier checkpoint. */
    DELTA_COUNT = "delta_count",

    /** Un intervalle de temps s'est écoulé depuis le dernier checkpoint. */
    TIME_INTERVAL = "time_interval",

    /** Un agent a échoué (complémentaire au ReplanTrigger de l'évolution 11). */
    AGENT_FAILURE = "agent_failure",

    /** Déclenché manuellement par l'utilisateur via un STATUS_QUERY intent. */
    USER_REQUESTED = "user_requested",
}

/**
 * Actions recommandées par l'évaluation de checkpoint.
 */
export enum CheckpointAction {
    /** Tout va bien — continuer l'exécution sans changement. */
    CONTINUE = "continue",

    /** Des ajustements mineurs sont recommandés (ex: injecter du contexte correctif). */
    ADJUST = "adjust",

    /** Un re-planning est recommandé (déclencher le mécanisme de l'évolution 11). */
    REPLAN = "replan",

    /** L'exécution devrait être escaladée à l'utilisateur pour décision. */
    ESCALATE = "escalate",

    /** L'exécution devrait être annulée (dommages irréversibles détectés). */
    ABORT = "abort",
}

/**
 * Résultat d'une évaluation de checkpoint.
 *
 * Produit par le CheckpointEvaluator après analyse de l'état
 * global de l'exécution à un point donné.
 */
export interface CheckpointResult {
    /** L'action recommandée. */
    readonly action: CheckpointAction;

    /** Le trigger qui a déclenché ce checkpoint. */
    readonly trigger: CheckpointTrigger;

    /** Explication humainement lisible de l'évaluation. */
    readonly reasoning: string;

    /**
     * Score de santé de l'exécution (0.0 à 1.0).
     * 0.0 = critique, 1.0 = parfait.
     */
    readonly healthScore: number;

    /**
     * Résumé de l'état actuel de l'exécution pour notification utilisateur.
     * Inclut les progrès, les problèmes détectés, et les recommandations.
     */
    readonly statusSummary: string;

    /**
     * Problèmes détectés lors du checkpoint (peut être vide).
     * Chaque entrée est un problème distinct avec sa sévérité.
     */
    readonly issues: ReadonlyArray<{
        readonly severity: "info" | "warning" | "critical";
        readonly description: string;
        readonly affectedAgents: readonly string[];
    }>;

    /**
     * Instructions correctives à injecter dans des agents spécifiques.
     * Non-vide seulement quand action === ADJUST.
     * Clé = agent ID, valeur = instruction corrective.
     */
    readonly corrections: ReadonlyMap<string, string>;

    /** ISO-8601 timestamp du checkpoint. */
    readonly timestamp: string;
}

/**
 * Configuration des checkpoints dans AgentPoolConfig.
 */
export interface CheckpointConfig {
    /**
     * Active ou désactive les checkpoints.
     * Défaut : true pour multi-agent, false pour single-agent.
     */
    readonly enabled?: boolean;

    /**
     * Pourcentage de complétion qui déclenche un checkpoint.
     * Défaut : 50 (checkpoint à mi-parcours).
     * Peut être un tableau pour plusieurs checkpoints : [25, 50, 75].
     */
    readonly completionPercentages?: number | number[];

    /**
     * Nombre de deltas entre chaque checkpoint temporel.
     * Défaut : 30.
     */
    readonly deltaInterval?: number;

    /**
     * Intervalle de temps en millisecondes entre les checkpoints temporels.
     * Défaut : 60000 (1 minute).
     */
    readonly timeIntervalMs?: number;

    /**
     * Détermine si le checkpoint notifie l'utilisateur automatiquement.
     * Défaut : false (seuls les ESCALATE et ABORT notifient).
     */
    readonly notifyOnCheckpoint?: boolean;
}
```

### 2. Ajouter `checkpoints` dans `AgentPoolConfig`

Dans l'interface `AgentPoolConfig` existante :

```typescript
/**
 * Configuration for mid-execution checkpoints.
 * Checkpoints evaluate overall execution health and detect issues
 * proactively. Only active for multi-agent executions.
 *
 * @default { enabled: true, completionPercentages: 50, deltaInterval: 30, timeIntervalMs: 60000 }
 */
readonly checkpoints?: CheckpointConfig;
```

### 3. Ajouter l'événement `CHECKPOINT_EVALUATED` dans `PoolEvent`

Dans `src/enums/pool-event.enum.ts` :

```typescript
/** A mid-execution checkpoint was evaluated. */
CHECKPOINT_EVALUATED = "pool:checkpoint-evaluated",
```

Et dans l'interface `PoolEventMap` dans `agent-pool.types.ts` :

```typescript
interface CheckpointEvaluatedEvent extends BasePoolEvent {
    readonly result: CheckpointResult;
}

// Dans PoolEventMap :
[PoolEvent.CHECKPOINT_EVALUATED]: CheckpointEvaluatedEvent;
```

### 4. Nouveau fichier `src/prompts/checkpoint.ts`

```typescript
import Handlebars from "handlebars";
import "./helpers.ts";

// ── Checkpoint Evaluation: System Prompt ───────────────────────────────────

const CHECKPOINT_SYSTEM_SOURCE = `You are a mid-execution health evaluator for an AI agent orchestration system.

Your role is to assess whether a multi-agent execution is proceeding correctly. You are called at checkpoints during execution — NOT at the end.

## Your Assessment Must Determine:

1. **Progress**: Are agents making meaningful progress toward their subtasks?
2. **Coherence**: Are agents' outputs consistent with each other? Any contradictions?
3. **Quality**: Does the work produced so far align with the original task requirements?
4. **Risk**: Are there signs of divergence, loops, or wasted effort?
5. **Coordination**: Is information sharing working effectively? Any missed sharing opportunities?

## Actions You Can Recommend:

- **continue**: Everything looks healthy. Proceed without intervention.
- **adjust**: Minor issues detected. Provide specific corrections to inject into affected agents.
- **replan**: Significant structural problems. The task decomposition should be revisited.
- **escalate**: Issues require human judgment. Provide a clear description for the user.
- **abort**: Critical problems detected (e.g., agents working against each other, data corruption risk). Recommend stopping immediately.

## Bias Toward "continue"

Most checkpoints should result in "continue". Only recommend intervention when there is clear evidence of a problem. Do NOT micro-manage agents — they are autonomous and may take different approaches than you would expect. That's fine.

## Examples

### Healthy execution — continue
Agents are making steady progress. Files are being created. No errors. Outputs are coherent.
{
  "action": "continue",
  "healthScore": 0.9,
  "reasoning": "All agents are progressing normally. The API developer has created 3 route files and the test writer is producing tests for the completed routes. No issues detected.",
  "statusSummary": "Execution is on track. 2/3 subtasks in progress, 0 errors.",
  "issues": [],
  "corrections": {}
}

### Minor issue — adjust
One agent is using a different port than what the other agent expects.
{
  "action": "adjust",
  "healthScore": 0.7,
  "reasoning": "The API developer is using port 8080 but the test writer's tests are hitting port 3000. This will cause all integration tests to fail.",
  "statusSummary": "Port mismatch detected between API and tests. Sending correction to test writer.",
  "issues": [
    { "severity": "warning", "description": "Port mismatch: API on 8080, tests expect 3000", "affectedAgents": ["agent-test-writer-id"] }
  ],
  "corrections": {
    "agent-test-writer-id": "IMPORTANT CORRECTION: The API server is running on port 8080, not 3000. Update all test URLs to use http://localhost:8080 instead of http://localhost:3000."
  }
}

### Structural problem — replan
An agent failed and its subtask is a dependency for others. Retry has been exhausted.
{
  "action": "replan",
  "healthScore": 0.3,
  "reasoning": "The database setup agent has failed twice and its subtask is blocking both the API and test agents. The current plan cannot succeed without a working database. Recommend re-planning to either combine database setup into the API subtask or use a mock database.",
  "statusSummary": "Database setup failed. Blocking all downstream work. Re-planning recommended.",
  "issues": [
    { "severity": "critical", "description": "Database setup failed after 2 retries, blocking 2 other subtasks", "affectedAgents": ["agent-db-setup-id", "agent-api-id", "agent-test-id"] }
  ],
  "corrections": {}
}

## JSON Output
{
  "action": "continue" | "adjust" | "replan" | "escalate" | "abort",
  "healthScore": <0.0-1.0>,
  "reasoning": "<detailed explanation>",
  "statusSummary": "<concise user-facing summary>",
  "issues": [
    { "severity": "info" | "warning" | "critical", "description": "<what's wrong>", "affectedAgents": ["<agent IDs>"] }
  ],
  "corrections": {
    "<agentId>": "<corrective instruction to inject>"
  }
}`;

export const checkpointSystemPrompt = Handlebars.compile(
    CHECKPOINT_SYSTEM_SOURCE,
    { noEscape: true },
);

// ── Checkpoint Evaluation: User Prompt ─────────────────────────────────────

const CHECKPOINT_SOURCE = `Evaluate the current state of this multi-agent execution.

## Original Task
<task>
{{task}}
</task>

## Plan
- **Strategy**: {{strategy}}
- **Complexity**: {{complexity}}
- **Planning Reasoning**: {{truncate planningReasoning 300}}

## Trigger
This checkpoint was triggered by: **{{trigger}}**

## Execution Progress
- **Elapsed time**: {{elapsedMs}}ms
- **Subtasks total**: {{totalSubtasks}}
- **Subtasks completed**: {{completedSubtasks}}
- **Subtasks failed**: {{failedSubtasks}}
- **Subtasks in progress**: {{inProgressSubtasks}}
- **Deltas processed**: {{deltaCount}}
- **Information shared**: {{sharingCount}} time(s)

## Agent States
{{#each agents}}
### {{this.agentName}} — {{this.taskRole}}
- **Task**: {{truncate this.taskDescription 200}}
- **Status**: {{this.status}}
- **Completed**: {{this.completed}}
{{#if this.error}}- **Error**: {{this.error}}
{{/if}}- **Files written**: {{#if this.filesWritten.length}}{{#each this.filesWritten}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}{{else}}none{{/if}}
- **Files read**: {{#if this.filesRead.length}}{{this.filesRead.length}} files{{else}}none{{/if}}
- **Events**: {{this.events.length}}
{{#if this.lastDelta}}- **Last activity**: [{{this.lastDelta.type}}] {{truncate this.lastDelta.summary 100}} (significance: {{this.lastDelta.significance}})
{{/if}}

{{/each}}

{{#if recentDecisions}}
## Recent Coordination Decisions
{{#each recentDecisions}}
- [{{this.type}}] {{this.summary}}
{{/each}}
{{/if}}

{{#if previousCheckpoint}}
## Previous Checkpoint
- **Action**: {{previousCheckpoint.action}}
- **Health**: {{previousCheckpoint.healthScore}}
- **Summary**: {{previousCheckpoint.statusSummary}}
{{#if previousCheckpoint.issues.length}}- **Issues identified**: {{previousCheckpoint.issues.length}}
{{/if}}
{{/if}}

Evaluate the execution health and recommend an action. Be concise but thorough.`;

export const checkpointPrompt = Handlebars.compile(CHECKPOINT_SOURCE, {
    noEscape: true,
});
```

### 5. Mettre à jour `src/prompts/index.ts`

Ajouter les exports :

```typescript
export {
    checkpointSystemPrompt,
    checkpointPrompt,
} from "./checkpoint.ts";
```

Et dans l'objet `templates` :

```typescript
export const templates = {
    // ... existing ...

    // Checkpoint evaluation
    checkpointSystem: checkpointSystemPrompt,
    checkpoint: checkpointPrompt,

    // ... existing ...
} as const;
```

### 6. Nouveau fichier `src/classes/agent-pool/checkpoint-evaluator.ts`

```typescript
import type pino from "pino";
import { ConversationRole } from "../../enums/conversation-role.enum.ts";
import {
    checkpointPrompt,
    checkpointSystemPrompt,
} from "../../prompts/index.ts";
import type {
    AgentContextState,
    CheckpointAction,
    CheckpointConfig,
    CheckpointResult,
    CheckpointTrigger,
    TaskAnalysis,
} from "../../types/agent-pool.types.ts";
import { toErrorMessage } from "../../utils/errors.ts";
import { isoNow } from "../../utils/formatting.ts";
import type { ContextTracker } from "./context-tracker.ts";
import type { ConversationManager } from "./conversation-manager.ts";

// ── Constants ──────────────────────────────────────────────────────────────

/** Default checkpoint configuration values. */
const DEFAULT_CONFIG: Required<CheckpointConfig> = {
    enabled: true,
    completionPercentages: 50,
    deltaInterval: 30,
    timeIntervalMs: 60_000,
    notifyOnCheckpoint: false,
};

// ── Validator ──────────────────────────────────────────────────────────────

/**
 * Validates the LLM response for a checkpoint evaluation.
 */
function validateCheckpointResponse(data: unknown): Omit<
    CheckpointResult,
    "trigger" | "timestamp" | "corrections"
> & { corrections: Record<string, string> } | null {
    if (data == null || typeof data !== "object") return null;

    const obj = data as Record<string, unknown>;

    // action
    const validActions = ["continue", "adjust", "replan", "escalate", "abort"];
    if (typeof obj.action !== "string" || !validActions.includes(obj.action))
        return null;

    // healthScore
    if (typeof obj.healthScore !== "number") return null;

    // reasoning
    if (typeof obj.reasoning !== "string" || obj.reasoning.length === 0)
        return null;

    // statusSummary
    if (typeof obj.statusSummary !== "string" || obj.statusSummary.length === 0)
        return null;

    // issues
    const issues: Array<{
        severity: "info" | "warning" | "critical";
        description: string;
        affectedAgents: string[];
    }> = [];

    if (Array.isArray(obj.issues)) {
        for (const raw of obj.issues) {
            if (raw == null || typeof raw !== "object") continue;
            const item = raw as Record<string, unknown>;

            const severity = item.severity;
            if (severity !== "info" && severity !== "warning" && severity !== "critical")
                continue;

            if (typeof item.description !== "string" || item.description.length === 0)
                continue;

            const affectedAgents = Array.isArray(item.affectedAgents)
                ? item.affectedAgents.filter((a): a is string => typeof a === "string")
                : [];

            issues.push({
                severity: severity as "info" | "warning" | "critical",
                description: item.description,
                affectedAgents,
            });
        }
    }

    // corrections
    const corrections: Record<string, string> = {};
    if (obj.corrections != null && typeof obj.corrections === "object") {
        for (const [key, value] of Object.entries(
            obj.corrections as Record<string, unknown>,
        )) {
            if (typeof value === "string" && value.length > 0) {
                corrections[key] = value;
            }
        }
    }

    return {
        action: obj.action as CheckpointAction,
        healthScore: Math.max(0, Math.min(1, obj.healthScore)),
        reasoning: obj.reasoning,
        statusSummary: obj.statusSummary,
        issues,
        corrections,
    };
}

// ── CheckpointEvaluator ────────────────────────────────────────────────────

/**
 * Evaluates the health of a multi-agent execution at predetermined
 * checkpoint moments and recommends corrective actions if needed.
 *
 * ## Trigger Conditions
 *
 * Checkpoints are triggered by multiple independent conditions:
 *
 * - **Completion percentage**: When a configured percentage of subtasks
 *   have completed (default: 50%). Supports multiple thresholds.
 *
 * - **Delta count interval**: After every N deltas processed (default: 30).
 *   Provides periodic assessment during long-running tasks.
 *
 * - **Time interval**: After every N milliseconds elapsed (default: 60s).
 *   Ensures assessment even when few deltas are produced.
 *
 * - **Agent failure**: When an agent fails, providing additional context
 *   beyond what the ReplanTrigger (evolution 11) evaluates.
 *
 * - **User request**: When the user asks for status via STATUS_QUERY
 *   intent, a checkpoint evaluation enriches the response.
 *
 * ## Evaluation Process
 *
 * When a trigger fires, the evaluator:
 *
 * 1. Collects the current state of all agents from the ContextTracker
 * 2. Gathers recent coordination decisions from the session memory
 *    (evolution 14) if available
 * 3. Sends a one-shot prompt to the LLM with the full execution state
 * 4. Parses and validates the LLM's assessment
 * 5. Returns a CheckpointResult with the recommended action
 *
 * The pool orchestrator then acts on the result:
 * - **continue**: No action, log the checkpoint
 * - **adjust**: Inject corrections into affected agents via structured
 *   context injection (evolution 08)
 * - **replan**: Trigger the re-planning mechanism (evolution 11)
 * - **escalate**: Notify the user with the checkpoint summary
 * - **abort**: Cancel the execution
 *
 * ## Rate Limiting
 *
 * To prevent excessive LLM calls, the evaluator enforces a minimum
 * interval between checkpoints (MIN_CHECKPOINT_INTERVAL_MS). If a
 * trigger fires but a checkpoint was evaluated recently, the trigger
 * is silently skipped.
 *
 * ## Conversation Isolation
 *
 * Checkpoint evaluations use one-shot prompts to avoid accumulating
 * history. However, the previous checkpoint result (if any) is included
 * in the prompt so the LLM can track evolution of issues.
 */
export class CheckpointEvaluator {
    /** Resolved configuration with defaults applied. */
    private readonly config: Required<CheckpointConfig>;

    /** The previous checkpoint result, included in subsequent evaluations. */
    private previousResult: CheckpointResult | null = null;

    /** Timestamp of the last checkpoint evaluation. */
    private lastCheckpointTime: number = 0;

    /** Delta count at the last checkpoint. */
    private lastCheckpointDeltaCount: number = 0;

    /** Completion percentage thresholds that have already been triggered. */
    private triggeredPercentages = new Set<number>();

    /** Running count of checkpoints evaluated. */
    private _checkpointCount = 0;

    /**
     * Minimum interval between checkpoint evaluations in milliseconds.
     * Prevents excessive LLM calls when multiple triggers fire in quick
     * succession.
     */
    private static readonly MIN_CHECKPOINT_INTERVAL_MS = 15_000;

    constructor(
        private readonly conversations: ConversationManager,
        private readonly contextTracker: ContextTracker,
        private readonly logger: pino.Logger,
        config?: CheckpointConfig,
    ) {
        this.config = {
            enabled: config?.enabled ?? DEFAULT_CONFIG.enabled,
            completionPercentages:
                config?.completionPercentages ?? DEFAULT_CONFIG.completionPercentages,
            deltaInterval: config?.deltaInterval ?? DEFAULT_CONFIG.deltaInterval,
            timeIntervalMs: config?.timeIntervalMs ?? DEFAULT_CONFIG.timeIntervalMs,
            notifyOnCheckpoint:
                config?.notifyOnCheckpoint ?? DEFAULT_CONFIG.notifyOnCheckpoint,
        };

        // Register the checkpoint conversation if not already present
        if (!this.conversations.has(ConversationRole.CONTEXT_ANALYZER)) {
            // Reuse CONTEXT_ANALYZER for checkpoints — they share the same
            // analytical purpose. A dedicated role can be added if needed.
            // Note: we use one-shot prompts so conversation history is not polluted.
        }
    }

    // ── Trigger Checks ─────────────────────────────────────────────────

    /**
     * Checks whether a checkpoint should be triggered based on the
     * current execution state. Called after each delta is processed.
     *
     * Returns the trigger type if a checkpoint should fire, or null
     * if no checkpoint is warranted.
     *
     * @param deltaCount - Total deltas processed so far.
     * @param completedSubtasks - Number of subtasks that have completed.
     * @param totalSubtasks - Total number of subtasks.
     * @param elapsedMs - Time elapsed since execution started.
     * @returns The trigger type, or null.
     */
    shouldTrigger(
        deltaCount: number,
        completedSubtasks: number,
        totalSubtasks: number,
        elapsedMs: number,
    ): CheckpointTrigger | null {
        if (!this.config.enabled) return null;
        if (totalSubtasks <= 1) return null; // Skip for single-agent

        // Rate limiting
        const now = Date.now();
        if (
            now - this.lastCheckpointTime <
            CheckpointEvaluator.MIN_CHECKPOINT_INTERVAL_MS
        ) {
            return null;
        }

        // Check completion percentage trigger
        const completionPercent =
            totalSubtasks > 0
                ? Math.round((completedSubtasks / totalSubtasks) * 100)
                : 0;

        const percentages = Array.isArray(this.config.completionPercentages)
            ? this.config.completionPercentages
            : [this.config.completionPercentages];

        for (const threshold of percentages) {
            if (
                completionPercent >= threshold &&
                !this.triggeredPercentages.has(threshold)
            ) {
                this.triggeredPercentages.add(threshold);
                return CheckpointTrigger.COMPLETION_PERCENTAGE;
            }
        }

        // Check delta count interval trigger
        if (
            deltaCount - this.lastCheckpointDeltaCount >=
            this.config.deltaInterval
        ) {
            return CheckpointTrigger.DELTA_COUNT;
        }

        // Check time interval trigger
        if (
            this.lastCheckpointTime === 0
                ? elapsedMs >= this.config.timeIntervalMs
                : now - this.lastCheckpointTime >= this.config.timeIntervalMs
        ) {
            return CheckpointTrigger.TIME_INTERVAL;
        }

        return null;
    }

    /**
     * Forces a checkpoint trigger. Used for AGENT_FAILURE and
     * USER_REQUESTED triggers which bypass the normal check cycle.
     *
     * @param trigger - The trigger type.
     * @returns The trigger type (pass-through), or null if rate-limited.
     */
    forceTrigger(trigger: CheckpointTrigger): CheckpointTrigger | null {
        if (!this.config.enabled) return null;

        // Rate limiting still applies, but with a shorter minimum for forced triggers
        const now = Date.now();
        const minInterval =
            trigger === CheckpointTrigger.USER_REQUESTED
                ? 5_000 // Users can request more frequently
                : CheckpointEvaluator.MIN_CHECKPOINT_INTERVAL_MS;

        if (now - this.lastCheckpointTime < minInterval) {
            // Return the previous result if available and recent enough
            return null;
        }

        return trigger;
    }

    // ── Evaluation ─────────────────────────────────────────────────────

    /**
     * Evaluates the current execution state at a checkpoint.
     *
     * Sends a one-shot prompt to the LLM with the full execution state
     * and returns a structured assessment with recommended action.
     *
     * @param trigger - What triggered this checkpoint.
     * @param task - The original task description.
     * @param analysis - The task analysis from the planner.
     * @param deltaCount - Total deltas processed so far.
     * @param sharingCount - Total sharing decisions made.
     * @param elapsedMs - Time elapsed since execution started.
     * @param recentDecisions - Optional recent coordination decisions from
     *                          the session memory (evolution 14).
     * @returns A CheckpointResult with the recommended action.
     */
    async evaluate(
        trigger: CheckpointTrigger,
        task: string,
        analysis: TaskAnalysis,
        deltaCount: number,
        sharingCount: number,
        elapsedMs: number,
        recentDecisions?: Array<{ type: string; summary: string }>,
    ): Promise<CheckpointResult> {
        this._checkpointCount++;
        this.lastCheckpointTime = Date.now();
        this.lastCheckpointDeltaCount = deltaCount;

        // Collect agent states
        const agentStates = this.contextTracker.getAllAgentStates();

        // Count completion stats
        const completedSubtasks = agentStates.filter((s) => s.completed && !s.error).length;
        const failedSubtasks = agentStates.filter((s) => s.completed && s.error).length;
        const inProgressSubtasks = agentStates.filter((s) => !s.completed).length;

        // Build the checkpoint prompt
        const prompt = checkpointPrompt({
            task,
            strategy: analysis.strategy,
            complexity: analysis.complexity,
            planningReasoning: analysis.reasoning,
            trigger,
            elapsedMs,
            totalSubtasks: analysis.subtasks.length,
            completedSubtasks,
            failedSubtasks,
            inProgressSubtasks,
            deltaCount,
            sharingCount,
            agents: agentStates.map((state) => ({
                agentName: state.agentName,
                taskRole: state.taskRole,
                taskDescription: state.taskDescription,
                status: state.status,
                completed: state.completed,
                error: state.error,
                filesWritten: state.filesWritten,
                filesRead: state.filesRead,
                events: state.events,
                lastDelta: state.lastDelta,
            })),
            recentDecisions: recentDecisions ?? null,
            previousCheckpoint: this.previousResult
                ? {
                      action: this.previousResult.action,
                      healthScore: this.previousResult.healthScore,
                      statusSummary: this.previousResult.statusSummary,
                      issues: this.previousResult.issues,
                  }
                : null,
        });

        this.logger.info(
            {
                trigger,
                checkpointNumber: this._checkpointCount,
                completedSubtasks,
                failedSubtasks,
                inProgressSubtasks,
                deltaCount,
                elapsedMs,
            },
            `Checkpoint #${this._checkpointCount} triggered: ${trigger}`,
        );

        try {
            // Use the CONTEXT_ANALYZER conversation for checkpoint evaluations.
            // The checkpoint system prompt is used as a one-shot system prompt
            // override — we send the checkpoint system + user prompt together,
            // not appending to the CONTEXT_ANALYZER's notification-focused history.

            const rawResult = await this.conversations.sendOneShotJson(
                ConversationRole.CONTEXT_ANALYZER,
                `${checkpointSystemPrompt({})}\n\n---\n\n${prompt}`,
                validateCheckpointResponse,
                { maxTokens: 800, maxJsonAttempts: 2 },
            );

            const result: CheckpointResult = {
                action: rawResult.action,
                trigger,
                reasoning: rawResult.reasoning,
                healthScore: rawResult.healthScore,
                statusSummary: rawResult.statusSummary,
                issues: rawResult.issues,
                corrections: new Map(Object.entries(rawResult.corrections)),
                timestamp: isoNow(),
            };

            this.previousResult = result;

            this.logger.info(
                {
                    action: result.action,
                    healthScore: result.healthScore,
                    issueCount: result.issues.length,
                    correctionCount: result.corrections.size,
                },
                `Checkpoint #${this._checkpointCount} result: ${result.action} (health: ${result.healthScore})`,
            );

            if (result.issues.length > 0) {
                for (const issue of result.issues) {
                    this.logger.warn(
                        {
                            severity: issue.severity,
                            affectedAgents: issue.affectedAgents,
                        },
                        `Checkpoint issue [${issue.severity}]: ${issue.description}`,
                    );
                }
            }

            return result;
        } catch (error) {
            this.logger.warn(
                { error: toErrorMessage(error), trigger },
                "Checkpoint evaluation failed — defaulting to continue",
            );

            // Safe default: if the evaluation fails, don't intervene
            const fallback: CheckpointResult = {
                action: CheckpointAction.CONTINUE,
                trigger,
                reasoning: `Checkpoint evaluation failed: ${toErrorMessage(error)}. Defaulting to continue.`,
                healthScore: 0.5,
                statusSummary: "Checkpoint evaluation failed. Execution continues.",
                issues: [],
                corrections: new Map(),
                timestamp: isoNow(),
            };

            this.previousResult = fallback;
            return fallback;
        }
    }

    // ── Queries ────────────────────────────────────────────────────────

    /** Number of checkpoints evaluated so far. */
    get checkpointCount(): number {
        return this._checkpointCount;
    }

    /** The most recent checkpoint result, or null if none evaluated yet. */
    get lastResult(): CheckpointResult | null {
        return this.previousResult;
    }

    /** Whether the evaluator is enabled. */
    get isEnabled(): boolean {
        return this.config.enabled;
    }

    // ── Reset ──────────────────────────────────────────────────────────

    /**
     * Resets the evaluator state for a new execution.
     * Called between executions to clear previous results and counters.
     */
    reset(): void {
        this.previousResult = null;
        this.lastCheckpointTime = 0;
        this.lastCheckpointDeltaCount = 0;
        this.triggeredPercentages.clear();
        this._checkpointCount = 0;
    }
}
```

### 7. Intégrer les checkpoints dans `AgentPool`

#### 7.1 Ajouter le `CheckpointEvaluator` comme dépendance

Dans `src/classes/agent-pool/agent-pool.ts` :

```typescript
import { CheckpointEvaluator } from "./checkpoint-evaluator.ts";
import {
    CheckpointAction,
    CheckpointTrigger,
    type CheckpointResult,
    type CheckpointConfig,
    ContextInjectionPriority,
    ContextInjectionCategory,
    type StructuredContextInjection,
} from "../../types/agent-pool.types.ts";
```

Ajouter le champ dans la classe :

```typescript
/** Mid-execution checkpoint evaluator (multi-agent only). */
private checkpointEvaluator: CheckpointEvaluator | null = null;

/** Execution start time for checkpoint timing. */
private _executionStartTime: number = 0;
```

#### 7.2 Instancier le `CheckpointEvaluator` dans `execute()`

Après la création de l'`InformationBroker` et avant l'exécution des subtasks :

```typescript
// Create the checkpoint evaluator for multi-agent executions
if (analysis.strategy === ExecutionStrategy.MULTI) {
    this.checkpointEvaluator = new CheckpointEvaluator(
        this.conversations,
        this.contextTracker,
        this.logger,
        this.config.checkpoints,
    );
}
this._executionStartTime = Date.now();
```

#### 7.3 Déclencher les checkpoints dans `handleDelta()`

À la fin de `handleDelta()`, après le sharing et la notification :

```typescript
private async handleDelta(delta: ContextDelta): Promise<void> {
    try {
        // ── Information Sharing ─────────────────────────────────────
        // ... existing code ...

        // ── Notification Engine ────────────────────────────────────
        // ... existing code ...

        // ── Checkpoint Evaluation ──────────────────────────────────
        if (this.checkpointEvaluator && this._currentAnalysis) {
            const completedCount = this.contextTracker
                .getAllAgentStates()
                .filter((s) => s.completed).length;

            const trigger = this.checkpointEvaluator.shouldTrigger(
                this._deltaCount,
                completedCount,
                this._currentAnalysis.subtasks.length,
                Date.now() - this._executionStartTime,
            );

            if (trigger) {
                // Fire-and-forget — don't block the delta handler
                void this.executeCheckpoint(trigger);
            }
        }
    } catch (error) {
        // ... existing error handling ...
    }
}
```

#### 7.4 Méthode `executeCheckpoint()` dans `AgentPool`

```typescript
/**
 * Executes a checkpoint evaluation and acts on the result.
 *
 * This method is called fire-and-forget from handleDelta() when a
 * checkpoint trigger fires. It evaluates the execution health and
 * applies the recommended action.
 *
 * @param trigger - The trigger type that caused this checkpoint.
 */
private async executeCheckpoint(trigger: CheckpointTrigger): Promise<void> {
    if (!this.checkpointEvaluator || !this._currentAnalysis || !this._currentTask) {
        return;
    }

    try {
        const result = await this.checkpointEvaluator.evaluate(
            trigger,
            this._currentTask,
            this._currentAnalysis,
            this._deltaCount,
            this._sharingDecisionCount,
            Date.now() - this._executionStartTime,
            // recentDecisions — pass from session memory if available (evolution 14)
            undefined,
        );

        // Emit the checkpoint event
        this.emitPoolEvent(PoolEvent.CHECKPOINT_EVALUATED, { result });

        // Act on the result
        switch (result.action) {
            case CheckpointAction.CONTINUE:
                // Nothing to do — just log
                this.logger.debug(
                    { healthScore: result.healthScore },
                    "Checkpoint: continue",
                );
                break;

            case CheckpointAction.ADJUST:
                // Inject corrections into affected agents
                for (const [agentId, correction] of result.corrections) {
                    const entry = this.managedAgents.get(agentId);
                    if (entry && entry.agent.status !== AgentStatus.DESTROYED) {
                        const injection: StructuredContextInjection = {
                            content: correction,
                            priority: ContextInjectionPriority.HIGH,
                            category: ContextInjectionCategory.COORDINATION_ALERT,
                            source: "checkpoint-evaluator",
                            dependencyType: null,
                            timestamp: isoNow(),
                        };

                        try {
                            entry.agent.injectContext(injection);
                            this.logger.info(
                                { agentId, correctionLength: correction.length },
                                "Checkpoint correction injected",
                            );
                        } catch {
                            this.logger.warn(
                                { agentId },
                                "Failed to inject checkpoint correction",
                            );
                        }
                    }
                }
                break;

            case CheckpointAction.REPLAN:
                // Trigger re-planning (evolution 11 mechanism)
                this.logger.warn(
                    { reasoning: result.reasoning },
                    "Checkpoint recommends re-planning",
                );
                // If the replan mechanism from evolution 11 is available:
                // void this.triggerReplan(result.reasoning);
                // For now, log and notify the user
                if (this.notificationEngine.isEnabled) {
                    this.emitPoolEvent(PoolEvent.NOTIFICATION, {
                        notification: {
                            message: `⚠️ Checkpoint alert: ${result.statusSummary}`,
                            significance: 0.9,
                            agentId: "pool",
                            agentName: "AgentPool",
                            type: DeltaType.PLAN_UPDATE,
                            timestamp: isoNow(),
                        },
                    });
                }
                break;

            case CheckpointAction.ESCALATE:
                // Always notify the user for escalation
                this.emitPoolEvent(PoolEvent.NOTIFICATION, {
                    notification: {
                        message: `🚨 Execution needs your attention: ${result.statusSummary}`,
                        significance: 1.0,
                        agentId: "pool",
                        agentName: "AgentPool",
                        type: DeltaType.AGENT_ERROR,
                        timestamp: isoNow(),
                    },
                });
                this.logger.warn(
                    { reasoning: result.reasoning },
                    "Checkpoint escalated to user",
                );
                break;

            case CheckpointAction.ABORT:
                this.logger.error(
                    { reasoning: result.reasoning },
                    "Checkpoint recommends aborting execution",
                );
                // Notify user before aborting
                this.emitPoolEvent(PoolEvent.NOTIFICATION, {
                    notification: {
                        message: `🛑 Execution aborted by checkpoint: ${result.statusSummary}`,
                        significance: 1.0,
                        agentId: "pool",
                        agentName: "AgentPool",
                        type: DeltaType.AGENT_ERROR,
                        timestamp: isoNow(),
                    },
                });
                // Cancel execution
                await this.destroyManagedAgents();
                break;
        }

        // Notify user if configured to do so on every checkpoint
        if (
            this.config.checkpoints?.notifyOnCheckpoint &&
            result.action !== CheckpointAction.CONTINUE &&
            result.action !== CheckpointAction.ESCALATE &&
            result.action !== CheckpointAction.ABORT
        ) {
            this.emitPoolEvent(PoolEvent.NOTIFICATION, {
                notification: {
                    message: `📊 Checkpoint: ${result.statusSummary}`,
                    significance: 0.6,
                    agentId: "pool",
                    agentName: "AgentPool",
                    type: DeltaType.STATUS_CHANGE,
                    timestamp: isoNow(),
                },
            });
        }
    } catch (error) {
        this.logger.warn(
            { error: toErrorMessage(error), trigger },
            "Checkpoint execution failed (non-critical)",
        );
    }
}
```

#### 7.5 Enrich STATUS_QUERY intent with checkpoint data

In the `send()` method, when handling `UserIntent.STATUS_QUERY`, trigger a checkpoint evaluation if the evaluator is active:

```typescript
case UserIntent.STATUS_QUERY: {
    const state = this.getState();
    if (!state.executing) {
        return "The pool is idle. No task is currently being executed.";
    }

    // Trigger a checkpoint for enriched status if available
    if (this.checkpointEvaluator && this._currentAnalysis && this._currentTask) {
        const forcedTrigger = this.checkpointEvaluator.forceTrigger(
            CheckpointTrigger.USER_REQUESTED,
        );

        if (forcedTrigger) {
            try {
                const checkpoint = await this.checkpointEvaluator.evaluate(
                    forcedTrigger,
                    this._currentTask,
                    this._currentAnalysis,
                    this._deltaCount,
                    this._sharingDecisionCount,
                    Date.now() - this._executionStartTime,
                );

                // Return the enriched status with checkpoint analysis
                const lines: string[] = [
                    `**Current Task**: ${state.currentTask}`,
                    `**Strategy**: ${state.strategy}`,
                    `**Health Score**: ${(checkpoint.healthScore * 100).toFixed(0)}%`,
                    "",
                    `**Assessment**: ${checkpoint.statusSummary}`,
                    "",
                    `**Agents** (${state.activeAgentCount}):`,
                ];

                for (const agent of state.agents) {
                    lines.push(
                        `- ${agent.agentName} (${agent.taskRole}): ${agent.completed ? "✅ completed" : `⚙️ ${agent.status}`}`,
                    );
                }

                if (checkpoint.issues.length > 0) {
                    lines.push("", "**Issues**:");
                    for (const issue of checkpoint.issues) {
                        const icon =
                            issue.severity === "critical"
                                ? "🔴"
                                : issue.severity === "warning"
                                    ? "🟡"
                                    : "🔵";
                        lines.push(`- ${icon} ${issue.description}`);
                    }
                }

                return lines.join("\n");
            } catch {
                // Fall through to standard status response
            }
        }
    }

    // Standard status response (unchanged from before)
    const lines: string[] = [
        `**Current Task**: ${state.currentTask}`,
        `**Strategy**: ${state.strategy}`,
        `**Active Agents**: ${state.activeAgentCount}`,
        "",
        "**Agents**:",
    ];

    for (const agent of state.agents) {
        lines.push(
            `- ${agent.agentName} (${agent.taskRole}): ${agent.completed ? "✅ completed" : `⚙️ ${agent.status}`}`,
        );
    }

    return lines.join("\n");
}
```

#### 7.6 Cleanup in `execute()` finally block

```typescript
finally {
    // ... existing cleanup ...
    this.checkpointEvaluator?.reset();
    this.checkpointEvaluator = null;
    this._executionStartTime = 0;
}
```

---

## Tests à implémenter

### Tests unitaires pour `CheckpointEvaluator`

#### Test 1 : `shouldTrigger` retourne `null` quand disabled

- Setup : config `{ enabled: false }`
- Assert : `shouldTrigger(100, 2, 3, 60000)` retourne `null`

#### Test 2 : `shouldTrigger` retourne `null` pour single-agent (totalSubtasks <= 1)

- Setup : config `{ enabled: true }`
- Assert : `shouldTrigger(10, 0, 1, 30000)` retourne `null`

#### Test 3 : `shouldTrigger` retourne `COMPLETION_PERCENTAGE` au seuil

- Setup : config `{ completionPercentages: 50 }`, 4 subtasks total
- Assert : `shouldTrigger(10, 1, 4, 30000)` retourne `null` (25%)
- Assert : `shouldTrigger(15, 2, 4, 30000)` retourne `COMPLETION_PERCENTAGE` (50%)
- Assert : `shouldTrigger(20, 3, 4, 30000)` retourne `null` (75%, seuil 50 déjà déclenché)

#### Test 4 : `shouldTrigger` supporte des seuils multiples

- Setup : config `{ completionPercentages: [25, 50, 75] }`, 4 subtasks total
- Assert : à 25% → trigger, à 50% → trigger, à 75% → trigger
- Assert : chaque seuil ne se déclenche qu'une fois

#### Test 5 : `shouldTrigger` retourne `DELTA_COUNT` après l'intervalle

- Setup : config `{ deltaInterval: 30 }`
- Simuler que le dernier checkpoint était à delta count 0
- Assert : `shouldTrigger(29, 0, 3, 0)` retourne `null`
- Assert : `shouldTrigger(30, 0, 3, 0)` retourne `DELTA_COUNT`

#### Test 6 : `shouldTrigger` retourne `TIME_INTERVAL` après le délai

- Setup : config `{ timeIntervalMs: 60000 }`
- Assert : `shouldTrigger(5, 0, 3, 59999)` retourne `null`
- Assert : `shouldTrigger(5, 0, 3, 60001)` retourne `TIME_INTERVAL`

#### Test 7 : Rate limiting empêche les checkpoints trop fréquents

- Appeler `evaluate()` (met à jour `lastCheckpointTime`)
- Immédiatement appeler `shouldTrigger()` avec des conditions qui déclencheraient un trigger
- Assert : retourne `null` (rate limited)

#### Test 8 : `forceTrigger` bypass le `shouldTrigger` check

- Assert : `forceTrigger(CheckpointTrigger.AGENT_FAILURE)` retourne le trigger
- Assert : rate limiting s'applique toujours (mais avec un intervalle plus court pour USER_REQUESTED)

#### Test 9 : `forceTrigger` retourne `null` quand disabled

- Setup : config `{ enabled: false }`
- Assert : `forceTrigger(CheckpointTrigger.USER_REQUESTED)` retourne `null`

#### Test 10 : `evaluate` retourne un `CheckpointResult` valide

- Mocker le `ConversationManager.sendOneShotJson()` pour retourner une réponse valide
- Appeler `evaluate()` avec des données de test
- Assert : le résultat contient `action`, `healthScore`, `reasoning`, `statusSummary`, `issues`, `corrections`, `timestamp`
- Assert : `checkpointCount` est incrémenté

#### Test 11 : `evaluate` retourne un fallback `CONTINUE` en cas d'erreur LLM

- Mocker le `ConversationManager.sendOneShotJson()` pour throw une erreur
- Appeler `evaluate()`
- Assert : le résultat a `action: "continue"`, `healthScore: 0.5`
- Assert : le `reasoning` mentionne l'erreur

#### Test 12 : `evaluate` inclut le résultat du checkpoint précédent dans le prompt

- Appeler `evaluate()` une première fois (mock response)
- Mocker pour capturer le prompt du deuxième appel
- Appeler `evaluate()` une deuxième fois
- Assert : le prompt contient `## Previous Checkpoint` avec les données du premier résultat

#### Test 13 : `reset` réinitialise tout l'état

- Évaluer 2 checkpoints, déclencher un seuil de pourcentage
- Appeler `reset()`
- Assert : `checkpointCount` retourne 0
- Assert : `lastResult` retourne `null`
- Assert : les seuils de pourcentage sont remis à zéro (le même seuil peut être re-déclenché)

#### Test 14 : `validateCheckpointResponse` rejette les données invalides

- Assert : `validateCheckpointResponse(null)` retourne `null`
- Assert : `validateCheckpointResponse({ action: "invalid" })` retourne `null`
- Assert : `validateCheckpointResponse({ action: "continue", healthScore: "not a number" })` retourne `null`
- Assert : `validateCheckpointResponse({ action: "continue", healthScore: 0.9, reasoning: "", ... })` retourne `null` (reasoning vide)

#### Test 15 : `validateCheckpointResponse` accepte les données valides

- Assert : une réponse complète et valide retourne l'objet parsed
- Assert : `healthScore` est clampé entre 0 et 1
- Assert : `issues` avec des entrées invalides sont filtrées (pas rejetées en bloc)
- Assert : `corrections` avec des valeurs non-string sont filtrées

### Tests d'intégration

#### Test 16 : `AgentPool.handleDelta()` déclenche un checkpoint quand les conditions sont remplies

- Mocker le `CheckpointEvaluator` avec `shouldTrigger()` retournant `DELTA_COUNT`
- Simuler un delta
- Assert : `executeCheckpoint()` est appelé avec le bon trigger

#### Test 17 : `AgentPool.executeCheckpoint()` injecte les corrections pour ADJUST

- Mocker l'évaluateur pour retourner `action: "adjust"` avec des corrections pour un agent
- Assert : `agent.injectContext()` est appelé avec une `StructuredContextInjection`
- Assert : la `priority` est `HIGH`
- Assert : la `category` est `COORDINATION_ALERT`
- Assert : le `source` est `"checkpoint-evaluator"`

#### Test 18 : `AgentPool.executeCheckpoint()` notifie l'utilisateur pour ESCALATE

- Mocker l'évaluateur pour retourner `action: "escalate"`
- Assert : un événement `NOTIFICATION` est émis
- Assert : le message contient le `statusSummary` du checkpoint
- Assert : la significance est `1.0`

#### Test 19 : `AgentPool.executeCheckpoint()` annule l'exécution pour ABORT

- Mocker l'évaluateur pour retourner `action: "abort"`
- Assert : `destroyManagedAgents()` est appelé
- Assert : un événement `NOTIFICATION` est émis avant l'abort
- Assert : le message contient « aborted »

#### Test 20 : STATUS_QUERY enrichi avec checkpoint

- Mocker l'évaluateur et le pool en état d'exécution
- Appeler `pool.send("What's the status?")` (classifié comme `STATUS_QUERY`)
- Assert : la réponse contient `**Health Score**:`
- Assert : la réponse contient `**Assessment**:`
- Assert : si des issues existent, elles sont listées avec les icônes de sévérité

#### Test 21 : Le checkpoint est nettoyé entre les exécutions

- Exécuter une tâche multi-agent avec des checkpoints
- Vérifier que le `CheckpointEvaluator` est reset dans le `finally` block
- Exécuter une deuxième tâche
- Assert : les seuils de pourcentage ne sont pas pré-déclenchés
- Assert : `checkpointCount` repart de 0

#### Test 22 : Pas de checkpoint pour les exécutions single-agent

- Exécuter une tâche single-agent
- Assert : `checkpointEvaluator` est `null`
- Assert : aucun événement `CHECKPOINT_EVALUATED` n'est émis

### Tests du prompt

#### Test 23 : Le prompt checkpoint compile avec les données fournies

- Appeler `checkpointPrompt({...fullMockData})` avec toutes les sections remplies
- Assert : le résultat contient `## Original Task`
- Assert : le résultat contient `## Execution Progress`
- Assert : le résultat contient `## Agent States`

#### Test 24 : Le prompt checkpoint gère les sections optionnelles

- Appeler `checkpointPrompt({...mockData, recentDecisions: null, previousCheckpoint: null})`
- Assert : le résultat ne contient PAS `## Recent Coordination Decisions`
- Assert : le résultat ne contient PAS `## Previous Checkpoint`

#### Test 25 : Le prompt checkpoint inclut le checkpoint précédent quand disponible

- Appeler avec `previousCheckpoint: { action: "adjust", healthScore: 0.7, statusSummary: "...", issues: [...] }`
- Assert : le résultat contient `## Previous Checkpoint`
- Assert : le résultat contient `Action: adjust`

#### Test 26 : Le system prompt contient les exemples few-shot

- Appeler `checkpointSystemPrompt({})`
- Assert : contient un exemple `continue`
- Assert : contient un exemple `adjust`
- Assert : contient un exemple `replan`
- Assert : les JSON dans les exemples sont valides (parsables)

#### Test 27 : Les JSON des exemples passent le validateur

- Extraire les JSON des exemples du system prompt
- Les passer à `validateCheckpointResponse()`
- Assert : tous retournent un objet non-null

---

## Critères de validation

- [ ] Le type `CheckpointResult` existe dans `agent-pool.types.ts` avec tous les champs spécifiés
- [ ] Les enums `CheckpointTrigger` et `CheckpointAction` existent avec les valeurs spécifiées
- [ ] Le type `CheckpointConfig` existe avec les options de configuration
- [ ] L'`AgentPoolConfig` accepte un champ `checkpoints?: CheckpointConfig`
- [ ] L'événement `PoolEvent.CHECKPOINT_EVALUATED` existe et est typé dans `PoolEventMap`
- [ ] Le fichier `checkpoint-evaluator.ts` existe et contient la classe `CheckpointEvaluator`
- [ ] Le fichier `src/prompts/checkpoint.ts` existe avec les deux templates (system + user)
- [ ] Les prompts sont exportés dans `prompts/index.ts` et dans l'objet `templates`
- [ ] `CheckpointEvaluator.shouldTrigger()` détecte les 3 triggers automatiques (completion, delta, time)
- [ ] `CheckpointEvaluator.forceTrigger()` supporte les triggers manuels (failure, user)
- [ ] Le rate limiting empêche les checkpoints trop fréquents (`MIN_CHECKPOINT_INTERVAL_MS`)
- [ ] `CheckpointEvaluator.evaluate()` envoie un prompt one-shot avec l'état complet de l'exécution
- [ ] Le prompt inclut le résultat du checkpoint précédent pour le suivi des issues
- [ ] Le validateur `validateCheckpointResponse()` vérifie les champs requis et clamp le `healthScore`
- [ ] L'évaluation échouée retourne un fallback `CONTINUE` avec `healthScore: 0.5`
- [ ] `AgentPool.handleDelta()` vérifie les triggers de checkpoint après chaque delta
- [ ] `AgentPool.executeCheckpoint()` agit sur les 5 actions : CONTINUE, ADJUST, REPLAN, ESCALATE, ABORT
- [ ] L'action ADJUST injecte des corrections structurées (priority HIGH, category COORDINATION_ALERT) dans les agents concernés
- [ ] L'action ESCALATE et ABORT notifient toujours l'utilisateur (significance 1.0)
- [ ] L'action ABORT appelle `destroyManagedAgents()` pour annuler l'exécution
- [ ] Le STATUS_QUERY intent est enrichi avec les données du checkpoint quand disponible
- [ ] Le `CheckpointEvaluator` est reset entre les exécutions (`reset()` dans le `finally` block)
- [ ] Les checkpoints ne sont pas activés pour les exécutions single-agent
- [ ] Le system prompt du checkpoint contient des exemples few-shot pour `continue`, `adjust`, et `replan`
- [ ] Les JSON des exemples passent le `validateCheckpointResponse()`
- [ ] Le prompt user du checkpoint inclut les sections conditionnelles (`recentDecisions`, `previousCheckpoint`)
- [ ] Tous les tests existants passent toujours
- [ ] Les nouveaux tests couvrent les triggers, l'évaluation, les actions, le rate limiting, le cleanup, et la backward compatibility

---

## Points d'attention

1. **Les checkpoints sont fire-and-forget** — `void this.executeCheckpoint(trigger)` ne bloque pas le flux d'événements. Cela signifie que l'exécution continue pendant que le checkpoint est évalué. Le LLM prend ~1-3s pour répondre, pendant lesquels des deltas supplémentaires peuvent arriver et modifier l'état. C'est acceptable — le checkpoint est une photo à un instant T, pas une évaluation en temps réel.

2. **Race condition avec ABORT** — si le checkpoint recommande `ABORT` et appelle `destroyManagedAgents()`, des `handleDelta()` en cours peuvent encore essayer d'accéder aux agents détruits. Le guard existant `agent.status !== AgentStatus.DESTROYED` protège contre ça. S'assurer que `executeCheckpoint()` vérifie `this._executing` avant d'agir.

3. **Le `CONTEXT_ANALYZER` est réutilisé** pour les checkpoints — on envoie le system prompt du checkpoint dans le user message en one-shot (technique « system prompt override »). C'est un compromis : ajouter un 6ème `ConversationRole` est plus propre mais augmente le nombre de conversations enregistrées. Comme les checkpoints sont one-shot et peu fréquents, la réutilisation du CONTEXT_ANALYZER est acceptable. Si des problèmes de qualité sont observés, créer un `ConversationRole.CHECKPOINT_EVALUATOR` dédié.

4. **Le `corrections` map dans `CheckpointResult`** — le LLM retourne un objet JSON `{ "agentId": "correction text" }`. Les agent IDs dans cette map doivent correspondre aux vrais IDs des agents managés. Si le LLM invente un ID, la correction est silencieusement ignorée (pas de match dans `this.managedAgents`). Pour aider le LLM, les IDs complets des agents sont inclus dans le prompt (via `agentStates`).

5. **Interaction avec le re-planning (évolution 11)** — quand le checkpoint recommande `REPLAN`, il devrait déclencher le mécanisme de re-planning. Pour cette évolution, le code effectue un log + notification. La connexion effective avec `triggerReplan()` est commentée avec un `// If the replan mechanism from evolution 11 is available:`. L'intégration sera faite une fois que les deux systèmes sont en place.

6. **Le `notifyOnCheckpoint` config** — par défaut `false`. Quand activé, chaque checkpoint non-CONTINUE émet une notification. C'est utile pour le debugging mais bruyant en production. Les ESCALATE et ABORT notifient toujours, indépendamment de ce flag.

7. **Les `issues` dans le `CheckpointResult`** sont filtrées lors de la validation — si le LLM retourne des issues mal formées, elles sont silencieusement ignorées (pas d'erreur de validation globale). Seules les issues avec `severity`, `description` et `affectedAgents` valides sont conservées. C'est plus tolérant que de rejeter tout le résultat pour une issue mal formée.

8. **Le `healthScore` est clampé entre 0 et 1** — même si le LLM retourne une valeur hors bornes, elle est normalisée. Cela évite les cas aberrants (healthScore de -1 ou de 100).

9. **Le STATUS_QUERY enrichi** — quand l'utilisateur demande le status pendant une exécution multi-agent, un checkpoint est forcé pour donner une réponse enrichie. Le `forceTrigger` a un rate limiting plus court (5s) pour permettre des requêtes plus fréquentes de l'utilisateur. Si le force trigger est rate-limited, le status standard (sans checkpoint) est retourné.

10. **Les checkpoints ne s'appliquent qu'aux exécutions multi-agent** — pour le single-agent, `checkpointEvaluator` est `null`. Il n'y a pas de valeur ajoutée à évaluer la santé d'un seul agent — le résultat du prompt suffit. Les checkpoints apportent de la valeur quand il y a coordination inter-agents, cohérence à vérifier, et dépendances à surveiller.

11. **Impact sur les tokens** — chaque checkpoint coûte ~1000-1500 tokens (prompt + response). Avec les défauts (1 checkpoint par minute, 1 par 30 deltas, 1 à 50%), une exécution typique de 3 minutes avec 3 agents génère ~2-4 checkpoints, soit ~4000-6000 tokens supplémentaires. C'est un investissement modeste pour la détection proactive de problèmes.

12. **Le prompt inclut `truncate` pour les champs longs** — les task descriptions et planning reasoning sont tronqués pour limiter la taille du prompt. Les événements par agent sont comptés mais pas listés individuellement. Seul le dernier delta de chaque agent est inclus en détail.

13. **Persistence du `previousResult`** — le résultat du checkpoint précédent est stocké en mémoire dans le `CheckpointEvaluator` (pas persisté sur disque). Il est inclus dans le prompt du checkpoint suivant pour que le LLM puisse suivre l'évolution des problèmes (« le port mismatch que j'ai identifié au checkpoint précédent a-t-il été corrigé ? »). C'est un mécanisme de mémoire de travail léger qui ne survit pas au-delà de l'exécution courante.

14. **Le `COORDINATION_ALERT` category** défini dans l'évolution 08 est utilisé ici pour les corrections injectées par le checkpoint. C'est le premier usage réel de cette catégorie — elle avait été préparée exactement pour ce cas d'usage.