# Évolution 16 — Conversation ORCHESTRATOR pour la réflexion cross-conversation

## Priorité : 🟡 P2-P3

## Dépendances : Évolution 14 (Context analyzer session memory), Évolution 15 (Mid-execution checkpoints)

## Acquis des évolutions précédentes

- **Évolution 01** : L'`InformationBroker` reçoit les mappings `subtaskToAgent`/`agentToSubtask`. Le tri des candidats par dépendance fonctionne correctement.
- **Évolution 02** : L'historique de partage (`SharingHistory`) déduplique les informations partagées entre agents. `recordSharing()` enregistre chaque partage effectué.
- **Évolution 03** : Le `ProjectScanner` injecte le contexte projet (langages, frameworks, arborescence) dans le planner.
- **Évolution 04** : Des exemples few-shot sont présents dans tous les prompts LLM pour guider les réponses.
- **Évolution 05** : Les conversations `CONTEXT_ANALYZER` et `SHARING_ANALYZER` sont séparées avec des system prompts spécialisés. Le `ConversationRole` enum a 5 rôles.
- **Évolution 06** : Le prompt de notification est nettoyé (pas de re-vérification des pré-filtres). Le summary inclut les stats de coordination.
- **Évolution 07** : Les résultats complets de prompt sont partagés (pas juste 500 chars). Le `promptResultSummary` est construit pour les textes longs.
- **Évolution 08** : L'injection de contexte est structurée avec `StructuredContextInjection` (priorité, catégorie, source, dependencyType).
- **Évolution 09** : Le seuil de significance est dynamique, adapté selon la phase d'exécution et les dépendances.
- **Évolution 10** : Les subtasks ont un timeout configurable et un mécanisme de retry individuel avec `SubtaskTimeoutError`.
- **Évolution 11** : Le re-planning adaptatif est implémenté via `TaskPlanner.replan()`. Les actions `continue`, `modify`, `restart`, `abort` sont supportées.
- **Évolution 12** : Le multi-intent est supporté dans l'intent analyzer avec historique conversationnel et seuil de confiance.
- **Évolution 13** : Le planner a une mémoire glissante (`PlannerMemory[]`) qui survit entre les exécutions. `recordExecution()` enregistre les leçons apprises.
- **Évolution 14** : Le `DecisionJournal` capture les décisions de sharing et notification intra-exécution. Les prompts incluent le journal pour la cohérence temporelle.
- **Évolution 15** : Le `CheckpointEvaluator` déclenche des auto-évaluations à des seuils de complétion, intervalles de deltas ou de temps. Les actions `CONTINUE`, `ADJUST`, `ESCALATE`, `REPLAN`, `ABORT` sont supportées.

---

## Contexte du problème

L'AgentPool maintient aujourd'hui **5 conversations LLM isolées** (PLANNER, CONTEXT_ANALYZER, SHARING_ANALYZER, INTENT_ANALYZER, USER_INTERACTION), chacune avec son propre system prompt et son propre historique. Cette isolation est un choix architectural fort qui évite la contamination de tokens entre préoccupations distinctes.

Cependant, cette isolation crée un **problème de cohérence globale** : aucune instance ne possède une vision transversale de ce qui se passe dans le système.

### Scénarios problématiques

#### 1. Le planner et le context analyzer ne communiquent pas

Le planner décide de décomposer une tâche en 3 subtasks (API, tests, docs). Pendant l'exécution, le context analyzer observe que l'agent API a produit une architecture REST complètement différente de ce que le planner avait anticipé. Le planner ne le sait jamais — il reste sur son plan initial, et le re-planning (évolution 11) ne se déclenche que sur échec, pas sur dérive.

#### 2. Les décisions de sharing et de notification sont incohérentes

Le sharing analyzer décide de partager l'output de l'agent API avec l'agent tests. Simultanément, le notification engine décide de ne PAS notifier l'utilisateur de ce même output. Ces deux décisions sont prises par deux conversations séparées qui ne voient pas l'une l'autre — mais une vue d'ensemble dirait « si l'info est assez importante pour être partagée entre agents, l'utilisateur devrait au moins être au courant ».

#### 3. Les checkpoints ne bénéficient pas de l'historique de sharing

Le checkpoint evaluator (évolution 15) évalue la santé de l'exécution, mais il ne sait pas combien d'informations ont été partagées, si les partages ont été utiles, ou si des patterns de conflit émergent. Il juge la santé sur l'état brut des agents, pas sur la qualité de la coordination.

#### 4. Pas de vision « big picture » sur la qualité de coordination

Personne dans le système ne se demande : « Est-ce que notre orchestration fonctionne bien globalement ? Les agents convergent-ils vers l'objectif ? Les décisions prises par les différentes conversations sont-elles cohérentes entre elles ? »

### Ce que l'ORCHESTRATOR résout

Un 6ème rôle de conversation — `ORCHESTRATOR` — agit comme un **méta-analyste** qui :

1. Reçoit périodiquement un résumé condensé de l'activité de chaque conversation
2. Évalue la cohérence globale et la qualité de coordination
3. Émet des **directives** qui influencent les autres conversations
4. Détecte les dérives stratégiques avant qu'elles ne deviennent des échecs

L'ORCHESTRATOR ne remplace aucune conversation existante — il les **supervise** et les **synchronise**.

---

## Fichiers impactés

| Fichier | Action |
|---------|--------|
| `src/enums/conversation-role.enum.ts` | Ajouter `ORCHESTRATOR` |
| `src/prompts/orchestrator.ts` | Nouveau fichier — system prompt et user prompt |
| `src/prompts/index.ts` | Exporter les nouveaux prompts |
| `src/classes/agent-pool/orchestrator-engine.ts` | Nouveau fichier — logique de meta-réflexion |
| `src/types/agent-pool.types.ts` | Nouveaux types (`OrchestratorAssessment`, `OrchestratorDirective`, `OrchestratorConfig`) |
| `src/classes/agent-pool/agent-pool.ts` | Intégrer l'`OrchestratorEngine` dans le cycle d'exécution |
| `src/enums/pool-event.enum.ts` | Ajouter `ORCHESTRATOR_ASSESSMENT` |
| `src/types/events.types.ts` ou `agent-pool.types.ts` | Ajouter le type d'événement |
| `src/classes/agent-pool/conversation-manager.ts` | Aucune modification (utilisation standard `register()` + `sendOneShotJson()`) |

---

## Spécification détaillée des changements

### 1. Ajouter `ORCHESTRATOR` dans `ConversationRole`

```typescript
// src/enums/conversation-role.enum.ts

export enum ConversationRole {
    PLANNER = "planner",
    CONTEXT_ANALYZER = "context-analyzer",
    SHARING_ANALYZER = "sharing-analyzer",     // Ajouté en évolution 05
    USER_INTERACTION = "user-interaction",
    INTENT_ANALYZER = "intent-analyzer",
    ORCHESTRATOR = "orchestrator",             // ← NOUVEAU
}
```

### 2. Nouveaux types dans `agent-pool.types.ts`

#### Type `OrchestratorDirective`

```typescript
/**
 * Une directive émise par l'ORCHESTRATOR pour influencer une autre conversation.
 *
 * Les directives ne sont pas des ordres impératifs — elles sont des
 * recommandations contextuelles que les sous-systèmes intègrent dans
 * leurs prochaines décisions.
 */
export interface OrchestratorDirective {
    /** L'identifiant unique de cette directive. */
    readonly id: string;

    /** Le sous-système ciblé par cette directive. */
    readonly target: "sharing" | "notification" | "planner" | "checkpoint" | "all";

    /** L'instruction à intégrer dans les prochaines décisions du sous-système. */
    readonly instruction: string;

    /** Niveau de priorité de la directive. */
    readonly priority: "suggestion" | "recommendation" | "strong";

    /** Durée de vie en nombre d'évaluations avant expiration automatique. */
    readonly ttlEvaluations: number;

    /** ISO-8601 timestamp de création. */
    readonly timestamp: string;
}

/**
 * Type de la cible d'une directive pour validation.
 */
export type DirectiveTarget = OrchestratorDirective["target"];
```

#### Type `OrchestratorAssessment`

```typescript
/**
 * Résultat d'une évaluation de l'ORCHESTRATOR.
 *
 * Produit périodiquement pour donner une vue d'ensemble de la qualité
 * de coordination dans le système.
 */
export interface OrchestratorAssessment {
    /** Score de cohérence globale (0.0 = chaos, 1.0 = parfaitement coordonné). */
    readonly coherenceScore: number;

    /** Évaluation textuelle de l'état de la coordination. */
    readonly assessment: string;

    /** Problèmes détectés par la meta-analyse. */
    readonly issues: OrchestratorIssue[];

    /** Directives émises pour corriger les problèmes détectés. */
    readonly directives: OrchestratorDirective[];

    /** ISO-8601 timestamp de cette évaluation. */
    readonly timestamp: string;

    /** Numéro séquentiel de cette évaluation dans l'exécution courante. */
    readonly assessmentNumber: number;
}

/**
 * Un problème détecté par l'ORCHESTRATOR.
 */
export interface OrchestratorIssue {
    /** Catégorie du problème. */
    readonly category: "coherence" | "efficiency" | "drift" | "conflict" | "communication";

    /** Sévérité du problème. */
    readonly severity: "low" | "medium" | "high";

    /** Description humainement lisible du problème. */
    readonly description: string;

    /** Les agents ou sous-systèmes concernés. */
    readonly affected: string[];
}
```

#### Type `OrchestratorConfig`

```typescript
/**
 * Configuration de l'ORCHESTRATOR engine.
 */
export interface OrchestratorConfig {
    /** Activer/désactiver l'ORCHESTRATOR (défaut: true pour multi-agent, false pour single). */
    readonly enabled?: boolean;

    /**
     * Intervalle minimum entre deux évaluations en nombre de deltas.
     * L'ORCHESTRATOR ne se déclenche pas à chaque delta — il attend
     * qu'un nombre suffisant de changements s'accumule pour que
     * l'évaluation ait de la matière.
     * Défaut : 8.
     */
    readonly deltaInterval?: number;

    /**
     * Intervalle minimum entre deux évaluations en millisecondes.
     * Même si le deltaInterval est atteint, l'ORCHESTRATOR attend
     * au moins ce délai entre deux évaluations.
     * Défaut : 30000 (30 secondes).
     */
    readonly minIntervalMs?: number;

    /**
     * Nombre maximum de directives actives simultanément.
     * Au-delà, les plus anciennes expirent automatiquement.
     * Défaut : 10.
     */
    readonly maxActiveDirectives?: number;

    /**
     * Durée de vie par défaut des directives en nombre d'évaluations.
     * Défaut : 5.
     */
    readonly defaultDirectiveTtl?: number;
}
```

### 3. Ajouter `orchestrator` dans `AgentPoolConfig`

```typescript
// Dans l'interface AgentPoolConfig existante
export interface AgentPoolConfig {
    // ... champs existants ...

    /**
     * Configuration de l'ORCHESTRATOR (méta-réflexion cross-conversation).
     * Activé automatiquement pour les exécutions multi-agent.
     * Désactivé pour les exécutions single-agent (inutile).
     */
    readonly orchestrator?: OrchestratorConfig;
}
```

### 4. Nouveau fichier `src/prompts/orchestrator.ts`

#### System prompt

```typescript
import Handlebars from "handlebars";
import "./helpers.ts";

// ── Orchestrator: System Prompt ────────────────────────────────────────────

const ORCHESTRATOR_SYSTEM_SOURCE = `You are a meta-orchestrator for an AI agent coordination system.

Your role is to **supervise the coordination quality** across multiple independent AI agents working on different parts of a task. You do NOT execute tasks — you observe, analyze, and emit directives to improve coordination.

## What you observe

You receive periodic snapshots containing:
1. **The original task and execution plan** — the strategic context
2. **Agent states** — what each agent is doing, has done, and has produced
3. **Sharing decisions** — what information was shared between agents (and what was not)
4. **Notification decisions** — what the user was told (and what was silenced)
5. **Checkpoint results** — previous health assessments from the checkpoint system
6. **Your previous assessment** — your last evaluation for continuity

## What you produce

A JSON assessment with:
- **coherenceScore** (0.0–1.0): How well are agents working together toward the shared goal?
- **issues**: Problems you've detected in coordination quality
- **directives**: Actionable instructions for specific subsystems to improve coordination

## Issue categories

- **coherence**: Agents are producing contradictory outputs or making conflicting assumptions
- **efficiency**: Too much or too little information sharing; redundant work being done
- **drift**: An agent is drifting away from its intended subtask toward something different
- **conflict**: Shared information conflicts with what an agent has already done
- **communication**: Important information is NOT being shared when it should be

## Directive targets

- **sharing**: Affects how the InformationBroker evaluates sharing decisions
- **notification**: Affects when the user is notified
- **planner**: Recommendations for plan adjustments (fed into re-planning if triggered)
- **checkpoint**: Affects checkpoint sensitivity
- **all**: A global directive that applies to all subsystems

## Directive priority levels

- **suggestion**: Nice-to-have, may be ignored if it conflicts with local context
- **recommendation**: Should be followed unless there's a strong local reason not to
- **strong**: Must be followed — indicates a critical coordination issue

## Examples

<example_assessment>
{
  "coherenceScore": 0.7,
  "assessment": "Agents are mostly aligned but the test-writer is writing tests for endpoints that the api-developer hasn't implemented yet. This is likely because the sharing of the API contract was too brief (only file names, not the actual route definitions). The documentation agent is waiting idle without clear reason.",
  "issues": [
    {
      "category": "communication",
      "severity": "high",
      "description": "Test-writer is guessing API endpoints because the shared context only included file names, not route definitions",
      "affected": ["test-writer", "api-developer"]
    },
    {
      "category": "efficiency",
      "severity": "medium",
      "description": "Documentation agent has been idle for 45 seconds while other agents are actively producing content it could reference",
      "affected": ["documentation-author"]
    }
  ],
  "directives": [
    {
      "target": "sharing",
      "instruction": "When api-developer produces output, share the actual route definitions (method, path, parameters, response schema) not just file names. The test-writer needs the contract, not the structure.",
      "priority": "strong",
      "ttlEvaluations": 3
    },
    {
      "target": "sharing",
      "instruction": "Proactively share api-developer output with documentation-author even at lower significance thresholds — the doc agent appears starved for content.",
      "priority": "recommendation",
      "ttlEvaluations": 2
    }
  ]
}
</example_assessment>

<example_assessment>
{
  "coherenceScore": 0.95,
  "assessment": "Excellent coordination. All agents are producing complementary outputs with no conflicts. The sharing decisions have been appropriate and the information flow is efficient.",
  "issues": [],
  "directives": []
}
</example_assessment>

## Rules

1. **Do NOT re-evaluate individual sharing decisions** — the sharing analyzer handles that. Focus on patterns across decisions.
2. **Do NOT judge agent output quality** — you judge coordination quality.
3. **Be conservative with directives** — only emit them when there's a genuine coordination problem. An empty directives array is perfectly acceptable.
4. **Coherence score should reflect the WHOLE picture**, not just the latest delta.
5. **Respond with valid JSON only** — no markdown, no commentary.

## JSON Schema
{
  "coherenceScore": <0.0-1.0>,
  "assessment": "<2-3 sentence assessment of coordination quality>",
  "issues": [
    {
      "category": "coherence" | "efficiency" | "drift" | "conflict" | "communication",
      "severity": "low" | "medium" | "high",
      "description": "<what's wrong>",
      "affected": ["<agent name or subsystem>"]
    }
  ],
  "directives": [
    {
      "target": "sharing" | "notification" | "planner" | "checkpoint" | "all",
      "instruction": "<what the subsystem should do differently>",
      "priority": "suggestion" | "recommendation" | "strong",
      "ttlEvaluations": <number, typically 2-5>
    }
  ]
}`;

export const orchestratorSystemPrompt = Handlebars.compile(
    ORCHESTRATOR_SYSTEM_SOURCE,
    { noEscape: true },
);
```

#### User prompt (évaluation périodique)

```typescript
// ── Orchestrator: Evaluation User Prompt ───────────────────────────────────

const ORCHESTRATOR_EVALUATION_SOURCE = `Evaluate the current coordination quality across all agents.

## Original Task
<task>
{{task}}
</task>

## Execution Plan
- **Strategy**: {{strategy}}
- **Complexity**: {{complexity}}
- **Reasoning**: {{planningReasoning}}
- **Total subtasks**: {{totalSubtasks}}

## Agent States
{{#each agents}}
### {{this.agentName}} ({{this.taskRole}})
- **Task**: {{truncate this.taskDescription 150}}
- **Status**: {{this.status}} | **Completed**: {{this.completed}}{{#if this.error}} | **Error**: {{this.error}}{{/if}}
- **Files Written**: {{#if this.filesWritten.length}}{{#each this.filesWritten}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}{{else}}none{{/if}}
- **Events**: {{this.eventCount}} | **Prompts completed**: {{this.promptCount}}
{{#if this.lastDeltaSummary}}- **Last activity**: {{this.lastDeltaSummary}}
{{/if}}
{{/each}}

## Sharing Activity
- **Total evaluations**: {{sharing.totalEvaluations}}
- **Approved shares**: {{sharing.approvedCount}} ({{sharing.approvalRate}}%)
{{#if sharing.recentDecisions.length}}
### Recent sharing decisions
{{#each sharing.recentDecisions}}
- [{{this.decision}}] {{this.sourceAgent}} → {{this.targetAgent}}: {{truncate this.reasoning 100}}
{{/each}}
{{/if}}

## Notification Activity
- **Notifications sent**: {{notification.sentCount}}
- **Evaluations performed**: {{notification.evaluationCount}}

{{#if checkpoint}}
## Latest Checkpoint
- **Action**: {{checkpoint.action}}
- **Health Score**: {{checkpoint.healthScore}}
- **Status**: {{truncate checkpoint.statusSummary 200}}
{{#if checkpoint.issues.length}}
- **Issues**: {{checkpoint.issues.length}}
{{/if}}
{{/if}}

{{#if previousAssessment}}
## Your Previous Assessment
- **Coherence Score**: {{previousAssessment.coherenceScore}}
- **Assessment**: {{truncate previousAssessment.assessment 300}}
{{#if previousAssessment.issues.length}}- **Previous issues**: {{previousAssessment.issues.length}}
{{/if}}
{{#if previousAssessment.directives.length}}- **Active directives**: {{previousAssessment.directives.length}}
{{/if}}
{{/if}}

{{#if activeDirectives.length}}
## Currently Active Directives
{{#each activeDirectives}}
- [{{this.target}}/{{this.priority}}] {{this.instruction}} (TTL: {{this.remainingTtl}})
{{/each}}
{{/if}}

Analyze coordination quality and respond with your JSON assessment.`;

export const orchestratorEvaluationPrompt = Handlebars.compile(
    ORCHESTRATOR_EVALUATION_SOURCE,
    { noEscape: true },
);
```

### 5. Mettre à jour `src/prompts/index.ts`

```typescript
// Ajouter les exports
export {
    orchestratorSystemPrompt,
    orchestratorEvaluationPrompt,
} from "./orchestrator.ts";

// Dans l'objet templates
export const templates = {
    // ... existants ...

    // Orchestrator
    orchestratorSystem: orchestratorSystemPrompt,
    orchestratorEvaluation: orchestratorEvaluationPrompt,
} as const;
```

### 6. Nouveau fichier `src/classes/agent-pool/orchestrator-engine.ts`

#### Structure de la classe

```typescript
import type pino from "pino";
import { ConversationRole } from "../../enums/conversation-role.enum.ts";
import { orchestratorEvaluationPrompt } from "../../prompts/index.ts";
import type {
    CheckpointResult,
    OrchestratorAssessment,
    OrchestratorConfig,
    OrchestratorDirective,
    OrchestratorIssue,
    TaskAnalysis,
} from "../../types/agent-pool.types.ts";
import { toErrorMessage } from "../../utils/errors.ts";
import { isoNow } from "../../utils/formatting.ts";
import { generateId } from "../../utils/identity.ts";
import type { ContextTracker } from "./context-tracker.ts";
import type { ConversationManager } from "./conversation-manager.ts";
import type { DecisionJournal } from "./decision-journal.ts";
import type { InformationBroker } from "./information-broker.ts";
import type { NotificationEngine } from "./notification-engine.ts";

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_DELTA_INTERVAL = 8;
const DEFAULT_MIN_INTERVAL_MS = 30_000;
const DEFAULT_MAX_ACTIVE_DIRECTIVES = 10;
const DEFAULT_DIRECTIVE_TTL = 5;

/** Minimum number of agents required to activate the orchestrator. */
const MIN_AGENTS_FOR_ORCHESTRATOR = 2;
```

#### Validator

```typescript
// ── Validator ──────────────────────────────────────────────────────────────

function validateOrchestratorResponse(data: unknown): {
    coherenceScore: number;
    assessment: string;
    issues: Array<{
        category: string;
        severity: string;
        description: string;
        affected: string[];
    }>;
    directives: Array<{
        target: string;
        instruction: string;
        priority: string;
        ttlEvaluations: number;
    }>;
} | null {
    if (data == null || typeof data !== "object") return null;
    const obj = data as Record<string, unknown>;

    // coherenceScore
    if (typeof obj.coherenceScore !== "number") return null;

    // assessment
    if (typeof obj.assessment !== "string" || obj.assessment.length === 0) return null;

    // issues
    if (!Array.isArray(obj.issues)) return null;
    const validCategories = ["coherence", "efficiency", "drift", "conflict", "communication"];
    const validSeverities = ["low", "medium", "high"];

    for (const issue of obj.issues) {
        if (issue == null || typeof issue !== "object") return null;
        const i = issue as Record<string, unknown>;
        if (typeof i.category !== "string" || !validCategories.includes(i.category)) return null;
        if (typeof i.severity !== "string" || !validSeverities.includes(i.severity)) return null;
        if (typeof i.description !== "string" || i.description.length === 0) return null;
        if (!Array.isArray(i.affected)) return null;
    }

    // directives
    if (!Array.isArray(obj.directives)) return null;
    const validTargets = ["sharing", "notification", "planner", "checkpoint", "all"];
    const validPriorities = ["suggestion", "recommendation", "strong"];

    for (const dir of obj.directives) {
        if (dir == null || typeof dir !== "object") return null;
        const d = dir as Record<string, unknown>;
        if (typeof d.target !== "string" || !validTargets.includes(d.target)) return null;
        if (typeof d.instruction !== "string" || d.instruction.length === 0) return null;
        if (typeof d.priority !== "string" || !validPriorities.includes(d.priority)) return null;
        if (typeof d.ttlEvaluations !== "number" || d.ttlEvaluations < 1) return null;
    }

    return {
        coherenceScore: Math.max(0, Math.min(1, obj.coherenceScore)),
        assessment: obj.assessment as string,
        issues: (obj.issues as Array<Record<string, unknown>>).map((i) => ({
            category: i.category as string,
            severity: i.severity as string,
            description: i.description as string,
            affected: (i.affected as unknown[]).filter((a): a is string => typeof a === "string"),
        })),
        directives: (obj.directives as Array<Record<string, unknown>>).map((d) => ({
            target: d.target as string,
            instruction: d.instruction as string,
            priority: d.priority as string,
            ttlEvaluations: d.ttlEvaluations as number,
        })),
    };
}
```

#### Classe `OrchestratorEngine`

```typescript
// ── OrchestratorEngine ─────────────────────────────────────────────────────

/**
 * Meta-reflection engine that supervises cross-conversation coordination.
 *
 * The OrchestratorEngine periodically evaluates the quality of coordination
 * across all active agents and emits directives to improve coherence.
 *
 * ## Trigger conditions
 *
 * The orchestrator evaluates when:
 * 1. A configurable number of deltas have been processed since the last evaluation
 * 2. A minimum time interval has elapsed since the last evaluation
 *
 * Both conditions must be met to prevent over-evaluation in either
 * high-frequency (many rapid deltas) or low-frequency (long pauses) scenarios.
 *
 * ## Directive lifecycle
 *
 * Directives have a TTL measured in evaluation cycles. After each evaluation:
 * 1. All directives' TTL is decremented
 * 2. Directives with TTL ≤ 0 are removed
 * 3. New directives from the evaluation are added
 *
 * Directives are consumed by subsystems through the `getDirectivesFor()` method,
 * which returns all active directives relevant to a specific target.
 *
 * ## Conversation isolation
 *
 * The orchestrator uses one-shot prompts (`sendOneShotJson`) to avoid
 * unbounded history growth. The `previousAssessment` field provides
 * continuity between evaluations without maintaining full conversation history.
 */
export class OrchestratorEngine {
    /** Resolved configuration with defaults. */
    private readonly config: Required<OrchestratorConfig>;

    /** Currently active directives. */
    private readonly activeDirectives: OrchestratorDirective[] = [];

    /** The most recent assessment, for continuity between evaluations. */
    private _previousAssessment: OrchestratorAssessment | null = null;

    /** Number of deltas processed since the last evaluation. */
    private _deltasSinceLastEval = 0;

    /** Timestamp of the last evaluation. */
    private _lastEvalTime = 0;

    /** Sequential counter for assessments. */
    private _assessmentCount = 0;

    /** Running total of directives emitted. */
    private _totalDirectivesEmitted = 0;

    constructor(
        private readonly conversations: ConversationManager,
        private readonly contextTracker: ContextTracker,
        private readonly logger: pino.Logger,
        config?: OrchestratorConfig,
    ) {
        this.config = {
            enabled: config?.enabled ?? true,
            deltaInterval: config?.deltaInterval ?? DEFAULT_DELTA_INTERVAL,
            minIntervalMs: config?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
            maxActiveDirectives: config?.maxActiveDirectives ?? DEFAULT_MAX_ACTIVE_DIRECTIVES,
            defaultDirectiveTtl: config?.defaultDirectiveTtl ?? DEFAULT_DIRECTIVE_TTL,
        };
    }

    // ── Trigger Check ──────────────────────────────────────────────────

    /**
     * Records that a delta was processed and checks if the orchestrator
     * should trigger an evaluation.
     *
     * Both the delta interval AND time interval must be satisfied.
     *
     * @returns `true` if the orchestrator should evaluate now.
     */
    recordDelta(): boolean {
        if (!this.config.enabled) return false;

        this._deltasSinceLastEval++;

        // Check delta interval
        if (this._deltasSinceLastEval < this.config.deltaInterval) return false;

        // Check time interval
        const now = Date.now();
        if (now - this._lastEvalTime < this.config.minIntervalMs) return false;

        // Check minimum agent count
        if (this.contextTracker.agentCount < MIN_AGENTS_FOR_ORCHESTRATOR) return false;

        return true;
    }

    // ── Evaluation ─────────────────────────────────────────────────────

    /**
     * Performs a meta-reflection evaluation of the current coordination state.
     *
     * Builds a comprehensive snapshot of all subsystem activity and sends
     * it to the ORCHESTRATOR conversation for analysis.
     *
     * @param task - The original task description.
     * @param analysis - The current task analysis.
     * @param broker - The information broker (for sharing stats).
     * @param notificationEngine - The notification engine (for notification stats).
     * @param checkpointResult - The most recent checkpoint result, if any.
     * @param sharingJournal - The sharing decision journal, if available.
     * @returns The orchestrator's assessment with directives.
     */
    async evaluate(
        task: string,
        analysis: TaskAnalysis,
        broker: InformationBroker,
        notificationEngine: NotificationEngine,
        checkpointResult?: CheckpointResult | null,
        sharingJournal?: DecisionJournal | null,
    ): Promise<OrchestratorAssessment | null> {
        if (!this.config.enabled) return null;

        this._deltasSinceLastEval = 0;
        this._lastEvalTime = Date.now();
        this._assessmentCount++;

        // Decrement TTL on existing directives before evaluation
        this.tickDirectives();

        // Build the evaluation snapshot
        const agentStates = this.contextTracker.getAllAgentStates();
        const agents = agentStates.map((state) => ({
            agentName: state.agentName,
            taskRole: state.taskRole,
            taskDescription: state.taskDescription,
            status: state.status,
            completed: state.completed,
            error: state.error,
            filesWritten: state.filesWritten,
            eventCount: state.events.length,
            promptCount: state.promptResults.length,
            lastDeltaSummary: state.lastDelta?.summary ?? null,
        }));

        // Build sharing activity snapshot
        const sharingData = {
            totalEvaluations: broker.evaluationCount,
            approvedCount: broker.shareCount,
            approvalRate: broker.evaluationCount > 0
                ? Math.round((broker.shareCount / broker.evaluationCount) * 100)
                : 0,
            recentDecisions: this.getRecentSharingDecisions(sharingJournal),
        };

        // Build notification activity snapshot
        const notificationData = {
            sentCount: notificationEngine.notificationCount,
            evaluationCount: notificationEngine.evaluationCount,
        };

        // Build active directives snapshot (with remaining TTL)
        const activeDirectivesSnapshot = this.activeDirectives.map((d) => ({
            target: d.target,
            priority: d.priority,
            instruction: d.instruction,
            remainingTtl: d.ttlEvaluations,
        }));

        // Build the prompt
        const prompt = orchestratorEvaluationPrompt({
            task,
            strategy: analysis.strategy,
            complexity: analysis.complexity,
            planningReasoning: analysis.reasoning,
            totalSubtasks: analysis.subtasks.length,
            agents,
            sharing: sharingData,
            notification: notificationData,
            checkpoint: checkpointResult ?? null,
            previousAssessment: this._previousAssessment,
            activeDirectives: activeDirectivesSnapshot,
        });

        this.logger.info(
            {
                assessmentNumber: this._assessmentCount,
                agentCount: agents.length,
                activeDirectiveCount: this.activeDirectives.length,
            },
            `Orchestrator evaluation #${this._assessmentCount}`,
        );

        try {
            const rawResult = await this.conversations.sendOneShotJson(
                ConversationRole.ORCHESTRATOR,
                prompt,
                validateOrchestratorResponse,
                { maxTokens: 800, maxJsonAttempts: 2 },
            );

            if (!rawResult) {
                this.logger.warn("Orchestrator evaluation returned null");
                return null;
            }

            // Build the full assessment
            const now = isoNow();
            const newDirectives: OrchestratorDirective[] = rawResult.directives.map((d) => ({
                id: `dir-${this._assessmentCount}-${generateId()}`,
                target: d.target as OrchestratorDirective["target"],
                instruction: d.instruction,
                priority: d.priority as OrchestratorDirective["priority"],
                ttlEvaluations: d.ttlEvaluations,
                timestamp: now,
            }));

            // Add new directives, enforce max limit
            for (const directive of newDirectives) {
                this.activeDirectives.push(directive);
                this._totalDirectivesEmitted++;
            }
            this.enforceDirectiveLimit();

            const assessment: OrchestratorAssessment = {
                coherenceScore: rawResult.coherenceScore,
                assessment: rawResult.assessment,
                issues: rawResult.issues.map((i) => ({
                    category: i.category as OrchestratorIssue["category"],
                    severity: i.severity as OrchestratorIssue["severity"],
                    description: i.description,
                    affected: i.affected,
                })),
                directives: newDirectives,
                timestamp: now,
                assessmentNumber: this._assessmentCount,
            };

            this._previousAssessment = assessment;

            this.logger.info(
                {
                    coherenceScore: assessment.coherenceScore,
                    issueCount: assessment.issues.length,
                    newDirectiveCount: newDirectives.length,
                    activeDirectiveCount: this.activeDirectives.length,
                },
                `Orchestrator assessment: coherence=${assessment.coherenceScore}, ` +
                `${assessment.issues.length} issue(s), ${newDirectives.length} new directive(s)`,
            );

            return assessment;
        } catch (error) {
            this.logger.warn(
                { error: toErrorMessage(error) },
                "Orchestrator evaluation failed — skipping",
            );
            return null;
        }
    }

    // ── Directive Access ───────────────────────────────────────────────

    /**
     * Returns all active directives targeting a specific subsystem.
     *
     * Includes directives targeting `"all"` in addition to the
     * specified target.
     *
     * @param target - The subsystem to get directives for.
     * @returns Active directives for this target, sorted by priority (strong first).
     */
    getDirectivesFor(target: DirectiveTarget): readonly OrchestratorDirective[] {
        const matching = this.activeDirectives.filter(
            (d) => d.target === target || d.target === "all",
        );

        const priorityOrder: Record<string, number> = {
            strong: 0,
            recommendation: 1,
            suggestion: 2,
        };

        return matching.sort(
            (a, b) => (priorityOrder[a.priority] ?? 99) - (priorityOrder[b.priority] ?? 99),
        );
    }

    /**
     * Formats active directives for a target as a prompt section.
     *
     * Returns `null` if no directives are active for this target.
     * The returned string is suitable for inclusion in LLM prompts.
     *
     * @param target - The subsystem target.
     * @returns A formatted string of directives, or `null`.
     */
    getDirectivePromptSection(target: DirectiveTarget): string | null {
        const directives = this.getDirectivesFor(target);
        if (directives.length === 0) return null;

        const lines = [
            "## Active Orchestrator Directives",
            "The following directives come from the meta-orchestrator and should influence your decisions:",
            "",
        ];

        for (const d of directives) {
            lines.push(`- [${d.priority.toUpperCase()}] ${d.instruction}`);
        }

        return lines.join("\n");
    }

    // ── Statistics ─────────────────────────────────────────────────────

    /** Total number of assessments performed. */
    get assessmentCount(): number {
        return this._assessmentCount;
    }

    /** Total number of directives emitted across all assessments. */
    get totalDirectivesEmitted(): number {
        return this._totalDirectivesEmitted;
    }

    /** Number of currently active directives. */
    get activeDirectiveCount(): number {
        return this.activeDirectives.length;
    }

    /** The most recent assessment, or null. */
    get previousAssessment(): OrchestratorAssessment | null {
        return this._previousAssessment;
    }

    /** Whether the orchestrator is enabled. */
    get isEnabled(): boolean {
        return this.config.enabled;
    }

    // ── Lifecycle ──────────────────────────────────────────────────────

    /**
     * Resets all orchestrator state for a new execution.
     */
    reset(): void {
        this.activeDirectives.length = 0;
        this._previousAssessment = null;
        this._deltasSinceLastEval = 0;
        this._lastEvalTime = 0;
        this._assessmentCount = 0;
        this._totalDirectivesEmitted = 0;
    }

    // ── Private ────────────────────────────────────────────────────────

    /**
     * Decrements TTL on all active directives and removes expired ones.
     */
    private tickDirectives(): void {
        for (let i = this.activeDirectives.length - 1; i >= 0; i--) {
            const directive = this.activeDirectives[i];
            if (!directive) continue;

            // Decrement TTL by creating a new object (readonly fields)
            const updated: OrchestratorDirective = {
                ...directive,
                ttlEvaluations: directive.ttlEvaluations - 1,
            };

            if (updated.ttlEvaluations <= 0) {
                this.activeDirectives.splice(i, 1);
                this.logger.debug(
                    { directiveId: directive.id, target: directive.target },
                    `Directive expired: ${directive.instruction.slice(0, 80)}`,
                );
            } else {
                this.activeDirectives[i] = updated;
            }
        }
    }

    /**
     * Removes the oldest directives if the count exceeds the max limit.
     */
    private enforceDirectiveLimit(): void {
        while (this.activeDirectives.length > this.config.maxActiveDirectives) {
            const removed = this.activeDirectives.shift();
            if (removed) {
                this.logger.debug(
                    { directiveId: removed.id },
                    `Directive evicted (limit reached): ${removed.instruction.slice(0, 80)}`,
                );
            }
        }
    }

    /**
     * Extracts recent sharing decisions from the DecisionJournal for the prompt.
     *
     * Returns the last 5 decisions formatted for the orchestrator prompt.
     */
    private getRecentSharingDecisions(
        journal: DecisionJournal | null | undefined,
    ): Array<{ decision: string; sourceAgent: string; targetAgent: string; reasoning: string }> {
        if (!journal) return [];

        const entries = journal.getRecent(5);
        return entries.map((entry) => ({
            decision: entry.approved ? "SHARED" : "DENIED",
            sourceAgent: entry.sourceId ?? "unknown",
            targetAgent: entry.targetId ?? "unknown",
            reasoning: entry.reasoningSummary,
        }));
    }
}
```

### 7. Ajouter `ORCHESTRATOR_ASSESSMENT` dans `PoolEvent`

```typescript
// src/enums/pool-event.enum.ts

export enum PoolEvent {
    // ... existants ...

    /**
     * The meta-orchestrator has completed an assessment of coordination quality.
     *
     * Emitted periodically during multi-agent executions when the
     * orchestrator engine evaluates cross-conversation coherence.
     */
    ORCHESTRATOR_ASSESSMENT = "pool:orchestrator-assessment",
}
```

### 8. Ajouter le type d'événement dans `PoolEventMap`

```typescript
// Dans agent-pool.types.ts

interface OrchestratorAssessmentEvent extends BasePoolEvent {
    readonly assessment: OrchestratorAssessment;
}

// Dans PoolEventMap
interface PoolEventMap {
    // ... existants ...
    [PoolEvent.ORCHESTRATOR_ASSESSMENT]: OrchestratorAssessmentEvent;
}
```

### 9. Intégrer l'`OrchestratorEngine` dans `AgentPool`

#### A. Ajouter le champ dans la classe

```typescript
// Dans la section "Infrastructure" de AgentPool
export class AgentPool extends EventEmitter {
    // ... existants ...

    /** Meta-reflection orchestrator engine. */
    private readonly orchestratorEngine: OrchestratorEngine;
}
```

#### B. Instancier dans le constructeur

```typescript
// Dans le constructeur de AgentPool, après les autres sous-systèmes

// Register the orchestrator conversation
this.conversations.register(
    ConversationRole.ORCHESTRATOR,
    orchestratorSystemPrompt({}),
    modelOverrides[ConversationRole.ORCHESTRATOR],
);

// Meta-reflection orchestrator
this.orchestratorEngine = new OrchestratorEngine(
    this.conversations,
    this.contextTracker,
    this.logger,
    config.orchestrator,
);
```

#### C. Déclencher l'évaluation dans `handleDelta()`

```typescript
// Dans handleDelta(), après le traitement de sharing et notification

// ── Meta-Reflection Orchestrator ────────────────────────────
if (this.orchestratorEngine.isEnabled && this.orchestratorEngine.recordDelta()) {
    // Fire-and-forget: don't block delta processing
    void this.evaluateOrchestrator();
}
```

#### D. Méthode `evaluateOrchestrator()` dans `AgentPool`

```typescript
/**
 * Triggers an orchestrator evaluation and processes the resulting directives.
 *
 * Called when the orchestrator's trigger conditions are met.
 * Errors are caught and logged — orchestrator failure is non-critical.
 */
private async evaluateOrchestrator(): Promise<void> {
    if (!this._currentTask || !this._currentAnalysis) return;

    try {
        // Get the checkpoint evaluator's last result if available
        const checkpointResult = this.checkpointEvaluator?.lastResult ?? null;

        // Get the sharing journal from the information broker
        const sharingJournal = this.informationBroker?.decisionJournal ?? null;

        const assessment = await this.orchestratorEngine.evaluate(
            this._currentTask,
            this._currentAnalysis,
            this.informationBroker!,
            this.notificationEngine,
            checkpointResult,
            sharingJournal,
        );

        if (assessment) {
            this.emitPoolEvent(PoolEvent.ORCHESTRATOR_ASSESSMENT, {
                assessment,
            });

            // Log high-severity issues
            for (const issue of assessment.issues) {
                if (issue.severity === "high") {
                    this.logger.warn(
                        {
                            category: issue.category,
                            affected: issue.affected,
                        },
                        `Orchestrator issue [${issue.severity}]: ${issue.description}`,
                    );
                }
            }
        }
    } catch (error) {
        this.logger.warn(
            { error: toErrorMessage(error) },
            "Orchestrator evaluation failed (non-critical)",
        );
    }
}
```

#### E. Inject directives into subsystem prompts

The directive injection happens **passively** — when a subsystem (sharing, notification, checkpoint) constructs its prompt, it queries the orchestrator for active directives and includes them if present.

##### In `InformationBroker.evaluateBatch()`

```typescript
// Before building the sharing prompt, get orchestrator directives
const orchestratorSection = this.orchestratorEngine?.getDirectivePromptSection("sharing") ?? null;

const prompt = batchedSharingDecisionPrompt({
    sourceAgent: { /* ... */ },
    delta: { /* ... */ },
    targets,
    // ← Add this new field to the template
    orchestratorDirectives: orchestratorSection,
});
```

The `InformationBroker` needs a reference to the `OrchestratorEngine`. Pass it via constructor or setter:

```typescript
// Option: setter method on InformationBroker
setOrchestratorEngine(engine: OrchestratorEngine): void {
    this._orchestratorEngine = engine;
}
```

##### In `NotificationEngine.evaluateWithLlm()`

```typescript
// Before building the notification prompt, get orchestrator directives
const orchestratorSection = this.orchestratorEngine?.getDirectivePromptSection("notification") ?? null;

const prompt = notificationDecisionPrompt({
    delta: { /* ... */ },
    agentTask: agentState.taskDescription,
    orchestratorDirectives: orchestratorSection,
});
```

The `NotificationEngine` needs a reference to the `OrchestratorEngine` (same pattern as broker).

##### In prompt templates

Add an optional section at the end of `batched-sharing-decision.ts`:

```handlebars
{{#if orchestratorDirectives}}

{{orchestratorDirectives}}
{{/if}}
```

Add the same section to `notification-decision.ts`.

#### F. Reset in `execute()` finally block

```typescript
// In the finally block of execute()
this.orchestratorEngine.reset();
```

#### G. Disable for single-agent strategy

The `OrchestratorEngine.recordDelta()` already checks `contextTracker.agentCount < 2`, which naturally disables it for single-agent executions. No additional logic needed.

### 10. Expose orchestrator state in `AgentPoolState`

```typescript
// In AgentPoolState
interface AgentPoolState {
    // ... existing fields ...

    /** Number of orchestrator assessments performed in the current execution. */
    readonly orchestratorAssessmentCount: number;

    /** Number of currently active orchestrator directives. */
    readonly activeDirectiveCount: number;

    /** Most recent coherence score from the orchestrator, or null. */
    readonly coherenceScore: number | null;
}
```

Update `getState()`:

```typescript
getState(): AgentPoolState {
    return {
        // ... existing fields ...
        orchestratorAssessmentCount: this.orchestratorEngine.assessmentCount,
        activeDirectiveCount: this.orchestratorEngine.activeDirectiveCount,
        coherenceScore: this.orchestratorEngine.previousAssessment?.coherenceScore ?? null,
    };
}
```

### 11. Add event listener in the example file

```typescript
// In src/examples/agent-pool.ts
pool.on(PoolEvent.ORCHESTRATOR_ASSESSMENT, (e) => {
    const { assessment } = e;
    const scoreColor = assessment.coherenceScore >= 0.8 ? ansi.green :
                       assessment.coherenceScore >= 0.5 ? ansi.yellow : ansi.red;
    info(
        "🔮",
        `${scoreColor}Orchestrator: coherence=${assessment.coherenceScore}${ansi.reset}, ` +
        `${assessment.issues.length} issue(s), ${assessment.directives.length} directive(s)`,
    );
    if (assessment.issues.length > 0) {
        for (const issue of assessment.issues) {
            const icon = issue.severity === "high" ? "🚨" : issue.severity === "medium" ? "⚠️" : "ℹ️";
            info("  ", `${icon} [${issue.category}] ${truncate(issue.description, 120)}`);
        }
    }
});
```

---

## Interaction avec les évolutions précédentes

### Avec l'évolution 14 (DecisionJournal)

Le `DecisionJournal` capture les décisions de sharing et notification au niveau granulaire. L'ORCHESTRATOR consomme ces données en lecture seule pour construire sa vue d'ensemble. Il ne modifie jamais le journal.

Les directives de l'ORCHESTRATOR ne sont **pas** écrites dans le journal — elles vivent dans leur propre structure (`activeDirectives`). Le journal reste le domaine du sharing/notification.

### Avec l'évolution 15 (Checkpoints)

Le `CheckpointEvaluator` évalue la santé de l'exécution au niveau tactique (agents, progression, erreurs). L'ORCHESTRATOR évalue la coordination au niveau stratégique (cohérence, communication, dérive).

La distinction est :
- **Checkpoint** : « Est-ce que les agents produisent le bon output ? »
- **Orchestrator** : « Est-ce que les agents communiquent bien entre eux ? »

Le checkpoint peut déclencher un re-planning (évolution 11). L'orchestrator n'a PAS ce pouvoir — il émet des directives qui influencent les décisions, mais ne change pas le plan. Si une situation critique est détectée, la directive `target: "planner"` sera consommée lors du prochain re-planning éventuel.

### Avec l'évolution 09 (Seuil dynamique)

Les directives ciblant `"sharing"` peuvent influencer le comportement du broker. Par exemple, une directive « Proactively share api-developer output with test-writer » ne modifie pas directement le seuil, mais le LLM du sharing analyzer la voit dans son prompt et ajuste ses décisions en conséquence.

### Avec l'évolution 11 (Re-planning)

Si l'orchestrator détecte un problème de `"drift"` (un agent qui dévie de sa tâche), la directive ciblant `"planner"` sera incluse dans le contexte si un re-planning est déclenché. Cela permet au planner de tenir compte des observations de l'orchestrator lors de la re-décomposition.

---

## Gestion du budget tokens

### Estimation de la taille du prompt d'évaluation

| Section | Tokens estimés |
|---------|---------------|
| System prompt (orchestrator) | ~800 |
| Agent states (3 agents × ~150 tokens) | ~450 |
| Sharing activity | ~200 |
| Notification activity | ~50 |
| Checkpoint result | ~100 |
| Previous assessment | ~200 |
| Active directives | ~100 |
| **Total input** | **~1900** |
| **Output (JSON)** | **~400** |
| **Total par évaluation** | **~2300** |

### Fréquence estimée

Avec `deltaInterval: 8` et `minIntervalMs: 30000`, dans une exécution typique de 3 agents produisant 10-15 deltas significatifs chacun :

- Total deltas : ~30-45
- Évaluations orchestrator : ~3-5
- **Coût total** : ~7000-11500 tokens

C'est modeste comparé au volume total de tokens consommés par les agents eux-mêmes.

### Garde-fous

- Le `deltaInterval` et `minIntervalMs` empêchent la sur-évaluation
- Le `maxActiveDirectives` (10) empêche l'accumulation excessive
- Le `ttlEvaluations` expire automatiquement les directives obsolètes
- L'ORCHESTRATOR est désactivé pour les exécutions single-agent

---

## Tests à implémenter

### Tests unitaires pour `OrchestratorEngine`

#### Test 1 : `recordDelta` retourne `false` quand disabled

- Setup : créer un engine avec `enabled: false`
- Appeler `recordDelta()` 100 fois
- Assert : retourne toujours `false`

#### Test 2 : `recordDelta` retourne `true` après deltaInterval deltas et minIntervalMs

- Setup : engine avec `deltaInterval: 3`, `minIntervalMs: 0`
- Appeler `recordDelta()` 2 fois → assert `false`
- Appeler `recordDelta()` 1 fois → assert `true` (3ème delta)
- Note : configurer le contextTracker mock pour retourner `agentCount >= 2`

#### Test 3 : `recordDelta` retourne `false` si le temps minimum n'est pas écoulé

- Setup : engine avec `deltaInterval: 1`, `minIntervalMs: 60000`
- Forcer `_lastEvalTime` à `Date.now()`
- Appeler `recordDelta()` → assert `false` (temps non écoulé)

#### Test 4 : `recordDelta` retourne `false` si moins de 2 agents

- Setup : engine avec `deltaInterval: 1`, `minIntervalMs: 0`
- Mock `contextTracker.agentCount` → 1
- Appeler `recordDelta()` → assert `false`

#### Test 5 : `evaluate` produit un assessment valide

- Setup : mock `conversations.sendOneShotJson` pour retourner un JSON valide
- Appeler `evaluate()` avec les bons paramètres
- Assert : le résultat a les champs `coherenceScore`, `assessment`, `issues`, `directives`
- Assert : `assessmentCount` est incrémenté

#### Test 6 : `evaluate` retourne `null` quand disabled

- Setup : engine avec `enabled: false`
- Assert : `evaluate()` retourne `null`

#### Test 7 : `evaluate` retourne `null` en cas d'erreur LLM

- Setup : mock `conversations.sendOneShotJson` qui throw
- Assert : `evaluate()` retourne `null`
- Assert : pas de crash

#### Test 8 : Les directives sont ajoutées aux activeDirectives

- Setup : mock l'évaluation pour retourner 2 directives
- Assert : `activeDirectiveCount` === 2
- Assert : `getDirectivesFor("sharing")` retourne les directives ciblant "sharing"

#### Test 9 : Les directives expirent après leur TTL

- Setup : ajouter une directive avec `ttlEvaluations: 2`
- Appeler `evaluate()` 1 fois → assert directive toujours active
- Appeler `evaluate()` 1 fois → assert directive expirée (TTL = 0 après 2 ticks)

#### Test 10 : `getDirectivesFor` inclut les directives "all"

- Setup : ajouter une directive `target: "all"` et une `target: "sharing"`
- Assert : `getDirectivesFor("sharing")` retourne les 2
- Assert : `getDirectivesFor("notification")` retourne seulement la "all"

#### Test 11 : `getDirectivesFor` trie par priorité (strong first)

- Setup : ajouter des directives "suggestion", "strong", "recommendation"
- Assert : `getDirectivesFor("all")` les retourne dans l'ordre strong, recommendation, suggestion

#### Test 12 : `getDirectivePromptSection` retourne `null` sans directives

- Assert : `getDirectivePromptSection("sharing")` === `null`

#### Test 13 : `getDirectivePromptSection` formate correctement

- Setup : ajouter une directive `target: "sharing"`, `priority: "strong"`, `instruction: "Share more"`
- Assert : le résultat contient `[STRONG] Share more`
- Assert : le résultat contient le header "Active Orchestrator Directives"

#### Test 14 : `enforceDirectiveLimit` évince les plus anciennes

- Setup : engine avec `maxActiveDirectives: 3`
- Ajouter 5 directives (via 5 évaluations mockées)
- Assert : `activeDirectiveCount` === 3
- Assert : les 3 directives restantes sont les plus récentes

#### Test 15 : `reset` nettoie tout l'état

- Setup : effectuer une évaluation, ajouter des directives
- Appeler `reset()`
- Assert : `assessmentCount` === 0
- Assert : `activeDirectiveCount` === 0
- Assert : `previousAssessment` === null

### Tests pour le validateur

#### Test 16 : `validateOrchestratorResponse` accepte un assessment valide complet

```typescript
const valid = {
    coherenceScore: 0.85,
    assessment: "Coordination is good overall",
    issues: [
        {
            category: "efficiency",
            severity: "low",
            description: "Slight redundancy in sharing",
            affected: ["agent-A"],
        },
    ],
    directives: [
        {
            target: "sharing",
            instruction: "Share less frequently",
            priority: "suggestion",
            ttlEvaluations: 3,
        },
    ],
};
// Assert: validateOrchestratorResponse(valid) !== null
```

#### Test 17 : `validateOrchestratorResponse` accepte un assessment sans issues ni directives

```typescript
const valid = {
    coherenceScore: 1.0,
    assessment: "Perfect coordination",
    issues: [],
    directives: [],
};
// Assert: validateOrchestratorResponse(valid) !== null
```

#### Test 18 : `validateOrchestratorResponse` rejette les catégories invalides

```typescript
const invalid = {
    coherenceScore: 0.5,
    assessment: "test",
    issues: [{ category: "invalid_category", severity: "low", description: "test", affected: [] }],
    directives: [],
};
// Assert: validateOrchestratorResponse(invalid) === null
```

#### Test 19 : `validateOrchestratorResponse` rejette les priorités invalides

```typescript
const invalid = {
    coherenceScore: 0.5,
    assessment: "test",
    issues: [],
    directives: [{ target: "sharing", instruction: "test", priority: "urgent", ttlEvaluations: 3 }],
};
// Assert: validateOrchestratorResponse(invalid) === null
```

#### Test 20 : `validateOrchestratorResponse` clamp le coherenceScore dans [0, 1]

```typescript
const data = {
    coherenceScore: 1.5,
    assessment: "test",
    issues: [],
    directives: [],
};
const result = validateOrchestratorResponse(data);
// Assert: result.coherenceScore === 1.0
```

### Tests d'intégration

#### Test 21 : `AgentPool.handleDelta()` déclenche l'orchestrator quand les conditions sont remplies

- Setup : créer un pool multi-agent avec `orchestrator: { deltaInterval: 2, minIntervalMs: 0 }`
- Simuler 2 deltas
- Assert : l'événement `ORCHESTRATOR_ASSESSMENT` est émis

#### Test 22 : L'orchestrator n'est PAS déclenché pour les exécutions single-agent

- Setup : créer un pool avec une tâche simple (single-agent)
- Simuler 100 deltas
- Assert : aucun événement `ORCHESTRATOR_ASSESSMENT`

#### Test 23 : Les directives sont incluses dans les prompts de sharing

- Setup : créer une directive `target: "sharing"`
- Mock `conversations.sendOneShotJson` pour capturer le prompt
- Déclencher une évaluation de sharing
- Assert : le prompt contient "Active Orchestrator Directives"

#### Test 24 : Les directives sont incluses dans les prompts de notification

- Setup : créer une directive `target: "notification"`
- Mock `conversations.sendOneShotJson` pour capturer le prompt
- Déclencher une évaluation de notification
- Assert : le prompt contient "Active Orchestrator Directives"

#### Test 25 : L'orchestrator state est exposé dans `getState()`

- Setup : effectuer une évaluation
- Assert : `getState().orchestratorAssessmentCount > 0`
- Assert : `getState().coherenceScore !== null`
- Assert : `getState().activeDirectiveCount >= 0`

#### Test 26 : L'orchestrator est reset entre les exécutions

- Setup : exécuter une tâche multi-agent, vérifier assessmentCount > 0
- Exécuter une seconde tâche
- Assert : assessmentCount redémarre à 0
- Assert : aucune directive de l'exécution précédente

### Tests de non-régression

#### Test 27 : Les exécutions sans orchestrator config fonctionnent inchangées

- Setup : créer un pool sans le champ `orchestrator` dans la config
- Assert : l'exécution fonctionne normalement
- Assert : l'orchestrator est auto-enabled pour multi-agent (config par défaut)

#### Test 28 : Désactiver explicitement l'orchestrator

- Setup : `orchestrator: { enabled: false }`
- Assert : aucun événement `ORCHESTRATOR_ASSESSMENT` même en multi-agent

#### Test 29 : Le sharing et la notification fonctionnent sans directives

- Setup : exécution multi-agent avec orchestrator enabled mais avant le premier assessment
- Assert : les prompts de sharing/notification ne contiennent PAS la section "Orchestrator Directives"
- Assert : tout fonctionne normalement

---

## Critères de validation

- [ ] Le `ConversationRole.ORCHESTRATOR` est ajouté et la conversation est enregistrée au démarrage du pool
- [ ] Le system prompt de l'ORCHESTRATOR contient des exemples contrastifs (bon/mauvais coordination)
- [ ] Le `OrchestratorEngine` se déclenche uniquement pour les exécutions multi-agent
- [ ] Le trigger respecte le `deltaInterval` ET le `minIntervalMs`
- [ ] Les évaluations produisent des `OrchestratorAssessment` avec coherenceScore, issues, et directives
- [ ] Les directives ont un TTL et expirent automatiquement
- [ ] `getDirectivesFor()` inclut les directives "all" et trie par priorité
- [ ] `getDirectivePromptSection()` retourne un texte formaté pour inclusion dans les prompts LLM
- [ ] Les directives sont injectées dans les prompts du sharing analyzer et du notification engine
- [ ] L'événement `ORCHESTRATOR_ASSESSMENT` est émis à chaque évaluation
- [ ] L'état de l'orchestrator est exposé dans `AgentPoolState`
- [ ] L'orchestrator est reset dans le `finally` block de `execute()`
- [ ] L'échec de l'orchestrator est non-critique (logged, pas propagé)
- [ ] Le validateur `validateOrchestratorResponse` valide les catégories, sévérités, targets et priorités
- [ ] Tous les tests existants passent toujours
- [ ] Les nouveaux tests couvrent trigger, évaluation, directives, intégration et non-régression

---

## Points d'attention

1. **L'ORCHESTRATOR ne remplace rien** — il ne prend pas de décisions de sharing, de notification, ou de re-planning. Il émet des directives qui **influencent** ces décisions. Les subsystèmes restent souverains.

2. **La référence à l'`OrchestratorEngine` dans `InformationBroker` et `NotificationEngine`** nécessite un setter ou un passage par constructeur. Le setter est préféré car l'orchestrator est instancié après le broker/notification engine. Ne pas casser les constructeurs existants.

3. **Le `DecisionJournal` de l'évolution 14 est consommé en lecture seule** par l'orchestrator. Vérifier que la méthode `getRecent()` (ou équivalent) existe sur le journal. Si le nom diffère, adapter.

4. **Le `generateId()` dans les identifiants de directives** : vérifier que `src/utils/identity.ts` expose une fonction utilisable pour générer des IDs courts. Si seul `generateIdentity()` existe, ajouter un `generateId()` simple ou utiliser `crypto.randomUUID().slice(0, 8)`.

5. **Ne pas faire d'évaluation orchestrator pour les checkpoints** — les checkpoints (évolution 15) et l'orchestrator sont complémentaires mais indépendants. Un checkpoint ne déclenche PAS une évaluation orchestrator, et vice versa.

6. **Le `previousAssessment` dans le prompt** fournit la continuité. Mais il ne faut PAS inclure les `directives` du previous assessment dans la section `previousAssessment` — elles sont déjà listées séparément dans `activeDirectives` avec leur TTL mis à jour. Éviter la duplication.

7. **Le model override pour ORCHESTRATOR** doit être ajouté dans le type `modelOverrides` de `AgentPoolConfig`. On peut utiliser un modèle moins cher pour l'orchestrator (ex: `claude-sonnet`) car ses évaluations sont moins critiques que les décisions de sharing.

8. **La section `orchestratorDirectives` dans les templates Handlebars** est optionnelle (`{{#if orchestratorDirectives}}`). Les templates existants ne sont pas cassés — le champ est simplement absent quand aucune directive n'est active.