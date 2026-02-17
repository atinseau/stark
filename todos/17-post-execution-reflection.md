# Évolution 17 — Cycle de réflexion post-exécution (Reflect → Learn → Store)

## Priorité : 🟡 P2-P3

## Dépendances : Évolution 16 (Meta-reflection ORCHESTRATOR)

## Acquis des évolutions précédentes

- **Évolution 01** : L'`InformationBroker` reçoit les mappings `subtaskToAgent`/`agentToSubtask`. Le tri des candidats par dépendance fonctionne correctement.
- **Évolution 02** : L'historique de partage (`SharingHistory`) déduplique les informations partagées entre agents. `recordSharing()` enregistre chaque partage effectué.
- **Évolution 03** : Le `ProjectScanner` injecte le contexte projet (langages, frameworks, arborescence) dans le planner.
- **Évolution 04** : Des exemples few-shot sont présents dans tous les prompts LLM pour guider les réponses.
- **Évolution 05** : Les conversations `CONTEXT_ANALYZER` et `SHARING_ANALYZER` sont séparées avec des system prompts spécialisés. Le `ConversationRole` enum a 6 rôles (incluant `ORCHESTRATOR`).
- **Évolution 06** : Le prompt de notification est nettoyé. Le summary inclut les stats de coordination (`CoordinationStats`).
- **Évolution 07** : Les résultats complets de prompt sont partagés (pas juste 500 chars). Le `promptResultSummary` est construit pour les textes longs.
- **Évolution 08** : L'injection de contexte est structurée avec `StructuredContextInjection` (priorité, catégorie, source, dependencyType). `AgentContextManager` gère les limites de queue.
- **Évolution 09** : Le seuil de significance est dynamique, adapté selon la phase d'exécution et les dépendances.
- **Évolution 10** : Les subtasks ont un timeout configurable et un mécanisme de retry individuel avec `SubtaskTimeoutError`. `AgentExecutionResult` inclut `retryCount`, `timedOut`, `subtaskDurationMs`.
- **Évolution 11** : Le re-planning adaptatif est implémenté via `TaskPlanner.replan()`. Les actions `continue`, `modify`, `restart`, `abort` sont supportées. `ReplanTrigger` et `ReplanDecision` existent.
- **Évolution 12** : Le multi-intent est supporté dans l'intent analyzer avec historique conversationnel (`conversationHistory[]`) et seuil de confiance (`MIN_INTENT_CONFIDENCE`).
- **Évolution 13** : Le planner a une mémoire glissante (`PlannerMemory[]`). `recordExecution()` enregistre les leçons apprises. Les mémoires survivent entre les exécutions mais pas après `destroy()`.
- **Évolution 14** : Le `DecisionJournal` capture les décisions de sharing et notification intra-exécution. Les prompts incluent le journal pour la cohérence temporelle. `approvalRate`, `countRecentDecisions()` sont disponibles.
- **Évolution 15** : Le `CheckpointEvaluator` déclenche des auto-évaluations aux seuils de complétion, intervalles de deltas ou de temps. Les actions `CONTINUE`, `ADJUST`, `ESCALATE`, `REPLAN`, `ABORT` sont supportées. `CheckpointResult` contient `healthScore`, `issues`, `corrections`.
- **Évolution 16** : L'`OrchestratorEngine` supervise la coordination cross-conversation. Il émet des `OrchestratorDirective` (avec TTL) qui influencent les prompts de sharing et notification. L'`OrchestratorAssessment` contient `coherenceScore`, `issues`, `directives`. L'événement `ORCHESTRATOR_ASSESSMENT` est émis. L'état de l'orchestrator est exposé dans `AgentPoolState`.

---

## Contexte du problème

Aujourd'hui, après chaque exécution (`execute()`), le pool :

1. Génère un résumé textuel via `generateSummary()` (pour l'utilisateur)
2. Enregistre une `PlannerMemory` via `recordExecution()` (évolution 13)
3. Nettoie tout dans le `finally` block (broker, tracker, mappings, deltas, orchestrator)

Le résumé est un texte libre pour l'utilisateur. La `PlannerMemory` capture des faits (stratégie, rôles, outcome, fichiers). **Mais personne ne se demande : « Qu'est-ce qui a bien fonctionné dans notre orchestration ? Qu'est-ce qui devrait être fait différemment la prochaine fois ? »**

### Ce qui manque

#### 1. Pas de réflexion sur la qualité de la coordination

Le système sait que 3 agents ont terminé avec succès, mais il ne sait pas :
- Est-ce que le partage d'information était trop fréquent ou pas assez ?
- Est-ce que les agents ont produit du travail contradictoire ?
- Est-ce que la décomposition en subtasks était optimale ?
- Est-ce que les retries étaient nécessaires ou évitables ?

#### 2. Les `PlannerMemory` ne capturent que des faits, pas des insights

La mémoire glissante du planner (évolution 13) enregistre :
- `task`, `strategy`, `roles`, `outcome`, `filesAffected`, `lessons`

Les `lessons` sont extraites programmatiquement (échecs, timeouts). Elles ne contiennent pas d'analyse sémantique de ce qui a fonctionné ou non. Un LLM ferait bien mieux.

#### 3. Les assessments de l'orchestrator sont perdus

L'`OrchestratorEngine` produit des `OrchestratorAssessment` avec un `coherenceScore` et des `issues` pendant l'exécution. Mais à la fin, tout est reset. Les patterns observés par l'orchestrator (ex: « le test-writer a besoin de plus de contexte de l'api-developer ») ne survivent pas.

#### 4. Pas de boucle d'amélioration continue

Sans réflexion structurée, le système ne peut pas s'améliorer. Chaque exécution est un recommencement. Même si le planner a une mémoire glissante, cette mémoire est factuelle, pas analytique.

### Ce que cette évolution résout

Un cycle **Reflect → Learn → Store** post-exécution :

1. **Reflect** : Après chaque exécution, envoyer un prompt de réflexion au LLM avec toutes les données de l'exécution (plan, résultats, sharing stats, orchestrator assessments, checkpoints). Le LLM produit une **analyse structurée** de ce qui a fonctionné et ce qui n'a pas fonctionné.

2. **Learn** : Extraire de cette réflexion des **insights actionnables** — des patterns réutilisables qui influenceront les décisions futures.

3. **Store** : Persister ces insights dans une structure qui survit entre les exécutions et qui est injectée dans les prompts futurs.

---

## Fichiers impactés

| Fichier | Action |
|---------|--------|
| `src/prompts/reflection.ts` | Nouveau fichier — system prompt et user prompt de réflexion |
| `src/prompts/index.ts` | Exporter les nouveaux prompts |
| `src/types/agent-pool.types.ts` | Nouveaux types (`ExecutionReflection`, `ExecutionInsight`, `ReflectionConfig`) |
| `src/classes/agent-pool/reflection-engine.ts` | Nouveau fichier — logique de réflexion post-exécution |
| `src/classes/agent-pool/agent-pool.ts` | Intégrer le `ReflectionEngine` dans le cycle d'exécution |
| `src/classes/agent-pool/task-planner.ts` | Enrichir `PlannerMemory` avec les insights de la réflexion |
| `src/enums/pool-event.enum.ts` | Ajouter `REFLECTION_COMPLETE` |

---

## Spécification détaillée des changements

### 1. Nouveaux types dans `agent-pool.types.ts`

#### Type `ExecutionInsight`

```typescript
/**
 * An actionable insight extracted from post-execution reflection.
 *
 * Insights are the primary output of the reflection cycle. They
 * represent patterns, lessons, and recommendations that can be
 * injected into future planning and coordination decisions.
 */
export interface ExecutionInsight {
    /** Unique identifier for this insight. */
    readonly id: string;

    /** Category of the insight. */
    readonly category: "decomposition" | "sharing" | "coordination" | "performance" | "tooling";

    /** Confidence that this insight is valid and useful (0.0–1.0). */
    readonly confidence: number;

    /**
     * The insight itself — a concise, actionable statement.
     *
     * Examples:
     * - "Splitting frontend and backend into separate agents works well when there's a clear API contract"
     * - "The test-writer agent needs the full API contract (routes + schemas), not just file paths"
     * - "Tasks involving a single language and framework should use a single agent"
     */
    readonly insight: string;

    /**
     * Under what conditions this insight applies.
     *
     * Examples:
     * - "When the task involves building an API and writing tests for it"
     * - "When multiple agents share filesystem access"
     */
    readonly applicableWhen: string;

    /**
     * Polarity of the insight.
     * - `positive`: Something that worked well and should be replicated
     * - `negative`: Something that went wrong and should be avoided
     * - `neutral`: An observation without clear positive/negative valence
     */
    readonly polarity: "positive" | "negative" | "neutral";

    /** ISO-8601 timestamp of creation. */
    readonly timestamp: string;
}

/**
 * The full output of the post-execution reflection cycle.
 *
 * Contains the LLM's analysis of the execution quality along with
 * extracted insights that will influence future executions.
 */
export interface ExecutionReflection {
    /** The task that was executed. */
    readonly task: string;

    /** The strategy that was used. */
    readonly strategy: ExecutionStrategy;

    /**
     * Overall effectiveness rating of the execution (0.0–1.0).
     * - 0.0 = Complete failure, wrong approach
     * - 0.5 = Partially successful, significant issues
     * - 1.0 = Excellent execution, optimal coordination
     */
    readonly effectivenessScore: number;

    /**
     * Free-text analysis of the execution quality.
     * Covers what worked, what didn't, and why.
     */
    readonly analysis: string;

    /**
     * Assessment of whether the decomposition was appropriate.
     * - `optimal`: The strategy was the right choice
     * - `over-decomposed`: Should have used fewer agents
     * - `under-decomposed`: Should have used more agents
     * - `wrong-boundaries`: The subtask boundaries were wrong
     */
    readonly decompositionAssessment: "optimal" | "over-decomposed" | "under-decomposed" | "wrong-boundaries";

    /**
     * Assessment of information sharing quality.
     * - `optimal`: Right amount and quality of sharing
     * - `over-shared`: Too much information flow, agents were distracted
     * - `under-shared`: Not enough information flow, agents were siloed
     * - `wrong-content`: Information was shared but not the right content
     */
    readonly sharingAssessment: "optimal" | "over-shared" | "under-shared" | "wrong-content";

    /** Extracted insights from the reflection. */
    readonly insights: ExecutionInsight[];

    /** ISO-8601 timestamp of the reflection. */
    readonly timestamp: string;

    /** Duration of the original execution in milliseconds. */
    readonly executionDurationMs: number;
}

/**
 * Configuration for the post-execution reflection engine.
 */
export interface ReflectionConfig {
    /**
     * Enable or disable post-execution reflection.
     * Default: true for multi-agent executions, false for single-agent.
     */
    readonly enabled?: boolean;

    /**
     * Maximum number of insights to retain across executions.
     * Oldest insights are evicted when this limit is reached.
     * Default: 30.
     */
    readonly maxInsights?: number;

    /**
     * Minimum effectiveness score of an execution for its insights
     * to be considered "validated positive patterns".
     * Insights from executions below this threshold are still stored
     * but marked with lower confidence.
     * Default: 0.7.
     */
    readonly positivePatternThreshold?: number;

    /**
     * Maximum number of insights to include in planner prompts.
     * Controls the token budget for insight injection.
     * Default: 8.
     */
    readonly maxInsightsInPrompt?: number;

    /**
     * Minimum confidence for an insight to be included in prompts.
     * Insights below this threshold are stored but not injected.
     * Default: 0.6.
     */
    readonly minInsightConfidence?: number;

    /**
     * Whether to reflect on single-agent executions.
     * Usually not worth the token cost. Default: false.
     */
    readonly reflectOnSingleAgent?: boolean;
}
```

### 2. Nouveau fichier `src/prompts/reflection.ts`

#### System prompt

```typescript
import Handlebars from "handlebars";
import "./helpers.ts";

// ── Reflection: System Prompt ──────────────────────────────────────────────

const REFLECTION_SYSTEM_SOURCE = `You are a post-execution analyst for an AI agent orchestration system.

After each multi-agent execution, you analyze the full execution trace — the plan, agent outputs, sharing decisions, coordination quality, and overall outcome — to extract lessons and insights for future executions.

## Your responsibilities

1. **Evaluate effectiveness**: Was the execution plan appropriate for the task? Did the decomposition make sense?
2. **Assess coordination quality**: Was information sharing between agents effective? Too much? Too little? Wrong content?
3. **Extract insights**: Identify reusable patterns — what worked well and should be replicated, what went wrong and should be avoided.
4. **Rate decomposition**: Was the task split into the right number of subtasks with the right boundaries?

## Insight guidelines

- Insights must be **actionable** — they should influence future planning decisions
- Insights must be **specific** — not generic advice like "plan better"
- Insights must include **applicability conditions** — when does this insight apply?
- Prefer **concrete patterns** over abstract observations
- Mark the **polarity** clearly: did something work (positive), fail (negative), or is it an observation (neutral)?

## Categories

- **decomposition**: About how the task was split into subtasks
- **sharing**: About information flow between agents
- **coordination**: About how agents worked together (timing, dependencies, conflicts)
- **performance**: About execution speed, retries, timeouts, resource usage
- **tooling**: About tool usage patterns, file operations, terminal commands

## Decomposition assessment values

- **optimal**: The strategy and subtask boundaries were the right choice
- **over-decomposed**: Too many agents for this task — a simpler split or single agent would have been more efficient
- **under-decomposed**: Not enough agents — some subtasks were too large and should have been further split
- **wrong-boundaries**: The right number of agents, but the subtask boundaries were drawn incorrectly

## Sharing assessment values

- **optimal**: The right amount of information was shared at the right time
- **over-shared**: Too many sharing decisions, agents received noise or redundant info
- **under-shared**: Critical information was not shared, agents worked in silos
- **wrong-content**: Information was shared but it was the wrong content (e.g., file names instead of file contents)

## Examples

<example_reflection>
{
  "effectivenessScore": 0.85,
  "analysis": "The 3-agent decomposition (api, tests, docs) was appropriate for this REST API task. The api-developer produced clean endpoints, and the test-writer successfully consumed the API contract. However, the documentation agent received API information too late and had to guess some response schemas. The sharing of api-developer output to test-writer was excellent — full route definitions with schemas. The sharing to documentation was insufficient — only file names were shared, not the actual API structure.",
  "decompositionAssessment": "optimal",
  "sharingAssessment": "wrong-content",
  "insights": [
    {
      "category": "sharing",
      "confidence": 0.9,
      "insight": "When sharing API information with a documentation agent, include the full route definitions (method, path, parameters, response schema) not just file paths. The documentation agent needs the contract, not the filesystem structure.",
      "applicableWhen": "When a documentation agent depends on an API-building agent",
      "polarity": "negative"
    },
    {
      "category": "decomposition",
      "confidence": 0.85,
      "insight": "Splitting a REST API project into api-developer, test-writer, and documentation-author works well when the API surface has more than 3 endpoints. The three agents can work largely in parallel with informational dependencies.",
      "applicableWhen": "When building a REST API with tests and documentation where the API has multiple endpoints",
      "polarity": "positive"
    },
    {
      "category": "coordination",
      "confidence": 0.7,
      "insight": "The documentation agent should have a blocking dependency on the api-developer, not informational. Without the full API contract, the documentation agent produces speculative content that needs revision.",
      "applicableWhen": "When a documentation agent depends on API definitions from another agent",
      "polarity": "negative"
    }
  ]
}
</example_reflection>

<example_reflection>
{
  "effectivenessScore": 0.4,
  "analysis": "This task was over-decomposed. The 'frontend' and 'styling' agents worked on the same files and produced conflicting CSS. The styling agent overwrote classes created by the frontend agent. A single agent would have been more efficient and avoided all conflicts. The sharing between them was frequent but ultimately harmful — the styling agent kept adapting to frontend changes that were still in progress.",
  "decompositionAssessment": "over-decomposed",
  "sharingAssessment": "over-shared",
  "insights": [
    {
      "category": "decomposition",
      "confidence": 0.95,
      "insight": "Do NOT split frontend UI implementation and CSS styling into separate agents. They share the same files (HTML/JSX and CSS) and will inevitably conflict. Keep them as a single agent.",
      "applicableWhen": "When the task involves building a frontend UI with styling",
      "polarity": "negative"
    },
    {
      "category": "sharing",
      "confidence": 0.8,
      "insight": "Sharing work-in-progress output between agents working on tightly coupled files causes churn. Only share completed artifacts, not intermediate states.",
      "applicableWhen": "When two agents need to modify related files",
      "polarity": "negative"
    }
  ]
}
</example_reflection>

## JSON Schema

{
  "effectivenessScore": <0.0-1.0>,
  "analysis": "<2-4 sentence analysis of execution quality>",
  "decompositionAssessment": "optimal" | "over-decomposed" | "under-decomposed" | "wrong-boundaries",
  "sharingAssessment": "optimal" | "over-shared" | "under-shared" | "wrong-content",
  "insights": [
    {
      "category": "decomposition" | "sharing" | "coordination" | "performance" | "tooling",
      "confidence": <0.0-1.0>,
      "insight": "<actionable, specific insight>",
      "applicableWhen": "<conditions under which this insight applies>",
      "polarity": "positive" | "negative" | "neutral"
    }
  ]
}

## Rules

1. Produce 2-5 insights per reflection. Do not produce more than 5 — focus on the most impactful observations.
2. Every insight MUST have a concrete \`applicableWhen\` condition — not "always" or "in general".
3. Respond with valid JSON only — no markdown, no commentary.
4. If the execution was single-agent and successful, 1-2 insights are sufficient.
5. Do NOT repeat insights that are obvious from the outcome (e.g., "the execution failed because an agent errored" — that's a fact, not an insight).`;

export const reflectionSystemPrompt = Handlebars.compile(
    REFLECTION_SYSTEM_SOURCE,
    { noEscape: true },
);
```

#### User prompt

```typescript
// ── Reflection: User Prompt ────────────────────────────────────────────────

const REFLECTION_SOURCE = `Reflect on this completed execution and extract insights.

## Task
<task>
{{task}}
</task>

## Execution Plan
- **Strategy**: {{strategy}}
- **Complexity**: {{complexity}}
- **Planning reasoning**: {{planningReasoning}}
- **Subtask count**: {{subtaskCount}}

## Subtasks
{{#each subtasks}}
### {{this.role}} ({{this.id}})
- **Prompt**: {{truncate this.prompt 200}}
- **Dependencies**: {{#if this.dependencies.length}}{{#each this.dependencies}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}{{else}}none{{/if}}
- **Priority**: {{this.priority}}
{{/each}}

## Agent Results
{{#each agents}}
### {{this.agentName}} — {{this.role}}
- **Success**: {{this.success}}{{#if this.error}} | **Error**: {{this.error}}{{/if}}
- **Response length**: {{this.responseLength}} chars
- **Files written**: {{#if this.filesWritten.length}}{{#each this.filesWritten}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}{{else}}none{{/if}}
- **Events**: {{this.eventCount}}
{{#if this.timedOut}}- **Timed out**: yes{{/if}}
{{#if this.retryCount}}- **Retries**: {{this.retryCount}}{{/if}}
{{#if this.subtaskDurationMs}}- **Duration**: {{this.subtaskDurationMs}}ms{{/if}}
{{/each}}

## Coordination Statistics
- **Total deltas**: {{coordination.deltaCount}}
- **Sharing evaluations**: {{coordination.sharingEvaluationCount}}
- **Sharing approved**: {{coordination.sharingApprovedCount}} ({{coordination.sharingApprovalRate}}%)
- **Notifications sent**: {{coordination.notificationCount}}
{{#if coordination.replanCount}}- **Re-plans triggered**: {{coordination.replanCount}}{{/if}}

{{#if orchestratorAssessments.length}}
## Orchestrator Assessments
{{#each orchestratorAssessments}}
### Assessment #{{this.assessmentNumber}}
- **Coherence score**: {{this.coherenceScore}}
- **Assessment**: {{truncate this.assessment 200}}
{{#if this.issues.length}}- **Issues**: {{#each this.issues}}[{{this.severity}}/{{this.category}}] {{truncate this.description 100}}{{#unless @last}}; {{/unless}}{{/each}}{{/if}}
{{#if this.directives.length}}- **Directives emitted**: {{this.directives.length}}{{/if}}
{{/each}}
{{/if}}

{{#if checkpoints.length}}
## Checkpoint Results
{{#each checkpoints}}
- [#{{@index}}] Action: {{this.action}}, Health: {{this.healthScore}}{{#if this.issues.length}}, Issues: {{this.issues.length}}{{/if}}
{{/each}}
{{/if}}

{{#if sharingDecisions.length}}
## Notable Sharing Decisions
{{#each sharingDecisions}}
- [{{this.decision}}] {{this.source}} → {{this.target}}: {{truncate this.reasoning 120}}
{{/each}}
{{/if}}

## Execution Outcome
- **Duration**: {{durationMs}}ms
- **Success count**: {{successCount}}/{{totalAgents}}
- **Strategy was**: {{strategy}}

{{#if existingInsights.length}}
## Existing Insights (from previous executions — do NOT repeat these)
{{#each existingInsights}}
- [{{this.category}}/{{this.polarity}}] {{this.insight}}
{{/each}}
{{/if}}

Analyze this execution and produce your JSON reflection.`;

export const reflectionPrompt = Handlebars.compile(REFLECTION_SOURCE, {
    noEscape: true,
});
```

### 3. Mettre à jour `src/prompts/index.ts`

```typescript
// Ajouter les exports
export {
    reflectionSystemPrompt,
    reflectionPrompt,
} from "./reflection.ts";

// Dans l'objet templates
export const templates = {
    // ... existants ...

    // Reflection
    reflectionSystem: reflectionSystemPrompt,
    reflection: reflectionPrompt,
} as const;
```

### 4. Nouveau fichier `src/classes/agent-pool/reflection-engine.ts`

#### Constants et validator

```typescript
import type pino from "pino";
import { ConversationRole } from "../../enums/conversation-role.enum.ts";
import { reflectionPrompt } from "../../prompts/index.ts";
import type {
    AgentExecutionResult,
    ExecutionInsight,
    ExecutionReflection,
    ReflectionConfig,
    TaskAnalysis,
    OrchestratorAssessment,
    CheckpointResult,
} from "../../types/agent-pool.types.ts";
import { toErrorMessage } from "../../utils/errors.ts";
import { isoNow } from "../../utils/formatting.ts";
import type { ConversationManager } from "./conversation-manager.ts";

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_MAX_INSIGHTS = 30;
const DEFAULT_POSITIVE_PATTERN_THRESHOLD = 0.7;
const DEFAULT_MAX_INSIGHTS_IN_PROMPT = 8;
const DEFAULT_MIN_INSIGHT_CONFIDENCE = 0.6;

/**
 * Maximum number of sharing decisions included in the reflection prompt.
 */
const MAX_SHARING_DECISIONS_IN_PROMPT = 10;

/**
 * Maximum number of orchestrator assessments included in the reflection prompt.
 */
const MAX_ORCHESTRATOR_ASSESSMENTS_IN_PROMPT = 3;

/**
 * Maximum number of checkpoint results included in the reflection prompt.
 */
const MAX_CHECKPOINTS_IN_PROMPT = 5;
```

#### Validator

```typescript
// ── Validator ──────────────────────────────────────────────────────────────

function validateReflectionResponse(data: unknown): {
    effectivenessScore: number;
    analysis: string;
    decompositionAssessment: string;
    sharingAssessment: string;
    insights: Array<{
        category: string;
        confidence: number;
        insight: string;
        applicableWhen: string;
        polarity: string;
    }>;
} | null {
    if (data == null || typeof data !== "object") return null;
    const obj = data as Record<string, unknown>;

    // effectivenessScore
    if (typeof obj.effectivenessScore !== "number") return null;

    // analysis
    if (typeof obj.analysis !== "string" || obj.analysis.length === 0) return null;

    // decompositionAssessment
    const validDecomp = ["optimal", "over-decomposed", "under-decomposed", "wrong-boundaries"];
    if (typeof obj.decompositionAssessment !== "string" ||
        !validDecomp.includes(obj.decompositionAssessment)) return null;

    // sharingAssessment
    const validSharing = ["optimal", "over-shared", "under-shared", "wrong-content"];
    if (typeof obj.sharingAssessment !== "string" ||
        !validSharing.includes(obj.sharingAssessment)) return null;

    // insights
    if (!Array.isArray(obj.insights)) return null;

    const validCategories = ["decomposition", "sharing", "coordination", "performance", "tooling"];
    const validPolarities = ["positive", "negative", "neutral"];

    const insights: Array<{
        category: string;
        confidence: number;
        insight: string;
        applicableWhen: string;
        polarity: string;
    }> = [];

    for (const raw of obj.insights) {
        if (raw == null || typeof raw !== "object") return null;
        const item = raw as Record<string, unknown>;

        if (typeof item.category !== "string" || !validCategories.includes(item.category)) return null;
        if (typeof item.confidence !== "number") return null;
        if (typeof item.insight !== "string" || item.insight.length === 0) return null;
        if (typeof item.applicableWhen !== "string" || item.applicableWhen.length === 0) return null;
        if (typeof item.polarity !== "string" || !validPolarities.includes(item.polarity)) return null;

        insights.push({
            category: item.category,
            confidence: Math.max(0, Math.min(1, item.confidence)),
            insight: item.insight,
            applicableWhen: item.applicableWhen,
            polarity: item.polarity,
        });
    }

    return {
        effectivenessScore: Math.max(0, Math.min(1, obj.effectivenessScore)),
        analysis: obj.analysis as string,
        decompositionAssessment: obj.decompositionAssessment as string,
        sharingAssessment: obj.sharingAssessment as string,
        insights,
    };
}
```

#### Classe `ReflectionEngine`

```typescript
// ── ReflectionEngine ───────────────────────────────────────────────────────

/**
 * Post-execution reflection engine that analyzes completed executions
 * and extracts reusable insights for future planning.
 *
 * ## Lifecycle
 *
 * 1. After each `execute()` completes (success or failure), the pool
 *    calls `reflect()` with the full execution data.
 * 2. The engine sends a one-shot prompt to the USER_INTERACTION
 *    conversation (or a dedicated REFLECTION conversation) with all
 *    execution details.
 * 3. The LLM produces an `ExecutionReflection` with effectiveness
 *    scores and extracted `ExecutionInsight[]`.
 * 4. Insights are stored in-memory and survive across executions
 *    (but not across pool restarts, unlike évolution 21).
 *
 * ## Insight persistence
 *
 * Insights are stored in a FIFO array with a configurable maximum
 * size. When the maximum is reached, the oldest insights are evicted.
 * Insights with higher confidence are never evicted in favor of lower-
 * confidence ones — a separate retention policy ensures quality.
 *
 * ## Insight injection
 *
 * The `getInsightsForPrompt()` method returns the most relevant
 * insights for a given task context, filtered by confidence threshold
 * and limited by token budget. These are injected into the planner
 * prompt (via the `existingInsights` field in the reflection prompt
 * to avoid repetition, and via the planner's task analysis prompt
 * to influence future planning).
 *
 * ## Interaction with PlannerMemory (évolution 13)
 *
 * The PlannerMemory captures factual execution data (strategy, roles,
 * outcome, files). The ReflectionEngine captures analytical data
 * (effectiveness, decomposition quality, coordination insights).
 * They are complementary:
 * - PlannerMemory tells the planner WHAT happened
 * - Insights tell the planner WHY it happened and WHAT to do differently
 */
export class ReflectionEngine {
    /** Resolved configuration with defaults. */
    private readonly config: Required<ReflectionConfig>;

    /** All stored insights, across executions. */
    private readonly insights: ExecutionInsight[] = [];

    /** All stored reflections, for debugging and analysis. */
    private readonly reflections: ExecutionReflection[] = [];

    /** Running count of reflections performed. */
    private _reflectionCount = 0;

    constructor(
        private readonly conversations: ConversationManager,
        private readonly logger: pino.Logger,
        config?: ReflectionConfig,
    ) {
        this.config = {
            enabled: config?.enabled ?? true,
            maxInsights: config?.maxInsights ?? DEFAULT_MAX_INSIGHTS,
            positivePatternThreshold: config?.positivePatternThreshold ?? DEFAULT_POSITIVE_PATTERN_THRESHOLD,
            maxInsightsInPrompt: config?.maxInsightsInPrompt ?? DEFAULT_MAX_INSIGHTS_IN_PROMPT,
            minInsightConfidence: config?.minInsightConfidence ?? DEFAULT_MIN_INSIGHT_CONFIDENCE,
            reflectOnSingleAgent: config?.reflectOnSingleAgent ?? false,
        };
    }

    // ── Public API ─────────────────────────────────────────────────────

    /**
     * Performs a post-execution reflection and extracts insights.
     *
     * Should be called after each execution completes (before cleanup
     * of the broker, tracker, etc., so that stats are still available).
     *
     * @param params - All data about the completed execution.
     * @returns The execution reflection, or `null` if reflection was skipped.
     */
    async reflect(params: {
        task: string;
        analysis: TaskAnalysis;
        results: AgentExecutionResult[];
        durationMs: number;
        coordinationStats: {
            deltaCount: number;
            sharingEvaluationCount: number;
            sharingApprovedCount: number;
            notificationCount: number;
            replanCount?: number;
        };
        orchestratorAssessments?: OrchestratorAssessment[];
        checkpointResults?: CheckpointResult[];
        sharingDecisions?: Array<{
            decision: string;
            source: string;
            target: string;
            reasoning: string;
        }>;
    }): Promise<ExecutionReflection | null> {
        if (!this.config.enabled) return null;

        // Skip single-agent reflections unless configured
        if (
            params.analysis.strategy === "single" &&
            !this.config.reflectOnSingleAgent
        ) {
            this.logger.debug("Skipping reflection for single-agent execution");
            return null;
        }

        this._reflectionCount++;

        // Build the reflection prompt data
        const subtasks = params.analysis.subtasks.map((s) => ({
            id: s.id,
            prompt: s.prompt,
            role: s.role,
            dependencies: s.dependencies,
            priority: s.priority,
        }));

        const agents = params.results.map((r) => ({
            agentName: r.agentName,
            role: r.subtask.role,
            success: r.success,
            error: r.error ?? null,
            responseLength: r.promptResult.text.length,
            filesWritten: r.filesWritten,
            eventCount: r.events.length,
            timedOut: (r as Record<string, unknown>).timedOut ?? false,
            retryCount: (r as Record<string, unknown>).retryCount ?? 0,
            subtaskDurationMs: (r as Record<string, unknown>).subtaskDurationMs ?? null,
        }));

        const sharingApprovalRate = params.coordinationStats.sharingEvaluationCount > 0
            ? Math.round(
                (params.coordinationStats.sharingApprovedCount /
                    params.coordinationStats.sharingEvaluationCount) * 100,
            )
            : 0;

        const successCount = params.results.filter((r) => r.success).length;

        // Get existing insights for deduplication
        const existingInsights = this.getInsightsForPrompt();

        const prompt = reflectionPrompt({
            task: params.task,
            strategy: params.analysis.strategy,
            complexity: params.analysis.complexity,
            planningReasoning: params.analysis.reasoning,
            subtaskCount: params.analysis.subtasks.length,
            subtasks,
            agents,
            coordination: {
                ...params.coordinationStats,
                sharingApprovalRate,
            },
            orchestratorAssessments: (params.orchestratorAssessments ?? [])
                .slice(-MAX_ORCHESTRATOR_ASSESSMENTS_IN_PROMPT),
            checkpoints: (params.checkpointResults ?? [])
                .slice(-MAX_CHECKPOINTS_IN_PROMPT),
            sharingDecisions: (params.sharingDecisions ?? [])
                .slice(-MAX_SHARING_DECISIONS_IN_PROMPT),
            durationMs: params.durationMs,
            successCount,
            totalAgents: params.results.length,
            existingInsights,
        });

        this.logger.info(
            {
                reflectionNumber: this._reflectionCount,
                strategy: params.analysis.strategy,
                agentCount: params.results.length,
                durationMs: params.durationMs,
            },
            `Post-execution reflection #${this._reflectionCount}`,
        );

        try {
            const rawResult = await this.conversations.sendOneShotJson(
                ConversationRole.USER_INTERACTION,
                prompt,
                validateReflectionResponse,
                { maxTokens: 1200, maxJsonAttempts: 2 },
            );

            if (!rawResult) {
                this.logger.warn("Reflection LLM returned null response");
                return null;
            }

            // Build the full reflection
            const now = isoNow();
            const newInsights: ExecutionInsight[] = rawResult.insights.map((i, idx) => ({
                id: `insight-${this._reflectionCount}-${idx}`,
                category: i.category as ExecutionInsight["category"],
                confidence: i.confidence,
                insight: i.insight,
                applicableWhen: i.applicableWhen,
                polarity: i.polarity as ExecutionInsight["polarity"],
                timestamp: now,
            }));

            // Apply confidence penalty for low-effectiveness executions
            if (rawResult.effectivenessScore < this.config.positivePatternThreshold) {
                for (const insight of newInsights) {
                    if (insight.polarity === "positive") {
                        // Reduce confidence of "positive" insights from low-effectiveness executions
                        (insight as { confidence: number }).confidence =
                            Math.max(0.3, insight.confidence * 0.7);
                    }
                }
            }

            const reflection: ExecutionReflection = {
                task: params.task,
                strategy: params.analysis.strategy,
                effectivenessScore: rawResult.effectivenessScore,
                analysis: rawResult.analysis,
                decompositionAssessment: rawResult.decompositionAssessment as ExecutionReflection["decompositionAssessment"],
                sharingAssessment: rawResult.sharingAssessment as ExecutionReflection["sharingAssessment"],
                insights: newInsights,
                timestamp: now,
                executionDurationMs: params.durationMs,
            };

            // Store the reflection
            this.reflections.push(reflection);

            // Store the insights (with eviction)
            this.storeInsights(newInsights);

            this.logger.info(
                {
                    effectivenessScore: reflection.effectivenessScore,
                    decompositionAssessment: reflection.decompositionAssessment,
                    sharingAssessment: reflection.sharingAssessment,
                    insightCount: newInsights.length,
                    totalStoredInsights: this.insights.length,
                },
                `Reflection complete: effectiveness=${reflection.effectivenessScore}, ` +
                `decomposition=${reflection.decompositionAssessment}, ` +
                `sharing=${reflection.sharingAssessment}, ${newInsights.length} insight(s)`,
            );

            return reflection;
        } catch (error) {
            this.logger.warn(
                { error: toErrorMessage(error) },
                "Post-execution reflection failed (non-critical)",
            );
            return null;
        }
    }

    // ── Insight Retrieval ──────────────────────────────────────────────

    /**
     * Returns insights suitable for injection into planner prompts.
     *
     * Filters by confidence threshold and limits by the configured
     * maximum. Returns insights sorted by confidence (highest first)
     * then by recency (newest first).
     *
     * @param contextHint - Optional task description for future relevance filtering.
     * @returns Array of insights for prompt injection.
     */
    getInsightsForPrompt(contextHint?: string): readonly ExecutionInsight[] {
        // Filter by confidence
        const eligible = this.insights.filter(
            (i) => i.confidence >= this.config.minInsightConfidence,
        );

        // Sort: highest confidence first, then newest first
        eligible.sort((a, b) => {
            const confDiff = b.confidence - a.confidence;
            if (Math.abs(confDiff) > 0.05) return confDiff;
            return b.timestamp.localeCompare(a.timestamp);
        });

        // Limit to configured max
        return eligible.slice(0, this.config.maxInsightsInPrompt);
    }

    /**
     * Formats insights as a text section suitable for inclusion in
     * a planner or other LLM prompt.
     *
     * Returns `null` if no eligible insights exist.
     */
    getInsightsPromptSection(): string | null {
        const insights = this.getInsightsForPrompt();
        if (insights.length === 0) return null;

        const lines = [
            "## Lessons from previous executions",
            "The following insights were extracted from past execution reflections. Use them to inform your planning:",
            "",
        ];

        for (const insight of insights) {
            const polarityIcon = insight.polarity === "positive" ? "✅" :
                                 insight.polarity === "negative" ? "⚠️" : "ℹ️";
            lines.push(
                `- ${polarityIcon} [${insight.category}] ${insight.insight}`,
            );
            lines.push(
                `  _Applies when: ${insight.applicableWhen}_ (confidence: ${insight.confidence})`,
            );
        }

        return lines.join("\n");
    }

    // ── Statistics ─────────────────────────────────────────────────────

    /** Total number of reflections performed. */
    get reflectionCount(): number {
        return this._reflectionCount;
    }

    /** Total number of stored insights. */
    get insightCount(): number {
        return this.insights.length;
    }

    /** Whether reflections are enabled. */
    get isEnabled(): boolean {
        return this.config.enabled;
    }

    /**
     * Returns the most recent reflection, or null.
     */
    get lastReflection(): ExecutionReflection | null {
        return this.reflections.length > 0
            ? this.reflections[this.reflections.length - 1]!
            : null;
    }

    /**
     * Returns all stored insights (read-only copy).
     */
    getAllInsights(): readonly ExecutionInsight[] {
        return [...this.insights];
    }

    /**
     * Returns all stored reflections (read-only copy).
     */
    getAllReflections(): readonly ExecutionReflection[] {
        return [...this.reflections];
    }

    // ── Lifecycle ──────────────────────────────────────────────────────

    /**
     * Clears all stored insights and reflections.
     *
     * Called when the pool is destroyed. Insights do NOT survive
     * pool destruction (for that, see évolution 21).
     */
    clearAll(): void {
        const previousInsightCount = this.insights.length;
        const previousReflectionCount = this.reflections.length;

        this.insights.length = 0;
        this.reflections.length = 0;
        this._reflectionCount = 0;

        this.logger.debug(
            { previousInsightCount, previousReflectionCount },
            "Reflection engine cleared",
        );
    }

    /**
     * Clears stored reflections but KEEPS insights.
     *
     * Called between executions to free memory from detailed
     * reflection data while preserving the distilled insights.
     */
    clearReflections(): void {
        this.reflections.length = 0;
    }

    // ── Private ────────────────────────────────────────────────────────

    /**
     * Stores new insights with eviction of the oldest when at capacity.
     *
     * Uses a quality-aware eviction strategy:
     * 1. If at capacity, evict insights with the lowest confidence first
     * 2. Never evict insights with confidence >= 0.9 in favor of lower ones
     * 3. Among equal-confidence insights, evict the oldest
     */
    private storeInsights(newInsights: ExecutionInsight[]): void {
        for (const insight of newInsights) {
            if (this.insights.length >= this.config.maxInsights) {
                // Find the lowest-confidence insight to evict
                let evictIndex = 0;
                let lowestConfidence = this.insights[0]?.confidence ?? 0;

                for (let i = 1; i < this.insights.length; i++) {
                    const existing = this.insights[i];
                    if (!existing) continue;
                    if (existing.confidence < lowestConfidence) {
                        lowestConfidence = existing.confidence;
                        evictIndex = i;
                    }
                }

                // Only evict if the new insight has higher or equal confidence
                const evictCandidate = this.insights[evictIndex];
                if (evictCandidate && insight.confidence >= evictCandidate.confidence) {
                    this.logger.debug(
                        {
                            evictedId: evictCandidate.id,
                            evictedConfidence: evictCandidate.confidence,
                            newConfidence: insight.confidence,
                        },
                        `Evicting insight ${evictCandidate.id} (conf=${evictCandidate.confidence}) ` +
                        `for new insight (conf=${insight.confidence})`,
                    );
                    this.insights.splice(evictIndex, 1);
                } else {
                    // New insight has lower confidence than everything stored — skip it
                    this.logger.debug(
                        { insightConfidence: insight.confidence, minStoredConfidence: lowestConfidence },
                        "Skipping insight — lower confidence than all stored insights",
                    );
                    continue;
                }
            }

            this.insights.push(insight);
        }
    }
}
```

### 5. Ajouter `REFLECTION_COMPLETE` dans `PoolEvent`

```typescript
// src/enums/pool-event.enum.ts

export enum PoolEvent {
    // ... existants ...

    /**
     * Post-execution reflection has completed.
     *
     * Emitted after each multi-agent execution when the reflection
     * engine has analyzed the execution and extracted insights.
     * Contains the full ExecutionReflection with effectiveness scores
     * and extracted insights.
     */
    REFLECTION_COMPLETE = "pool:reflection-complete",
}
```

### 6. Ajouter le type d'événement dans `PoolEventMap`

```typescript
// Dans agent-pool.types.ts

interface ReflectionCompleteEvent extends BasePoolEvent {
    readonly reflection: ExecutionReflection;
}

// Dans PoolEventMap
interface PoolEventMap {
    // ... existants ...
    [PoolEvent.REFLECTION_COMPLETE]: ReflectionCompleteEvent;
}
```

### 7. Intégrer le `ReflectionEngine` dans `AgentPool`

#### A. Ajouter le champ dans la classe

```typescript
// Dans la section "Infrastructure" de AgentPool
export class AgentPool extends EventEmitter {
    // ... existants ...

    /** Post-execution reflection engine. */
    private readonly reflectionEngine: ReflectionEngine;
}
```

#### B. Instancier dans le constructeur

```typescript
// Dans le constructeur de AgentPool, après les autres sous-systèmes

// Post-execution reflection engine
this.reflectionEngine = new ReflectionEngine(
    this.conversations,
    this.logger,
    config.reflection,
);
```

Note : le `reflectionSystemPrompt` n'a pas besoin d'être enregistré comme conversation distincte. La réflexion utilise `sendOneShotJson` avec `ConversationRole.USER_INTERACTION`, ce qui est suffisant. Si on souhaite un model override distinct, on peut enregistrer un role `REFLECTION` — mais ce n'est pas nécessaire pour cette évolution.

**Alternative recommandée** : Utiliser `sendOneShotJson` avec un system prompt override. Si le `ConversationManager` ne le supporte pas directement, la solution la plus simple est de créer un role temporaire ou d'utiliser le `USER_INTERACTION` existant. Le system prompt de `USER_INTERACTION` est compatible (il est un « technical summarizer » — la réflexion est une forme de résumé analytique).

#### C. Appeler `reflect()` après l'exécution

Dans la méthode `execute()`, **AVANT** le cleanup du `finally` block mais **APRÈS** la génération du summary :

```typescript
// Dans execute(), après generateSummary() et AVANT le finally block

// ── Phase 4.5: Post-execution Reflection ─────────────────
if (analysis.strategy !== ExecutionStrategy.SINGLE || this.reflectionEngine.isEnabled) {
    try {
        // Collect orchestrator assessments before cleanup
        const orchestratorAssessments = this.orchestratorEngine.previousAssessment
            ? [this.orchestratorEngine.previousAssessment]
            : [];

        // Collect checkpoint results
        const checkpointResults = this.checkpointEvaluator?.lastResult
            ? [this.checkpointEvaluator.lastResult]
            : [];

        // Collect notable sharing decisions from the broker's journal
        const sharingDecisions = this.buildSharingDecisionsForReflection();

        const reflection = await this.reflectionEngine.reflect({
            task,
            analysis,
            results: executionResults,
            durationMs: Date.now() - startTime,
            coordinationStats: {
                deltaCount: this._deltaCount,
                sharingEvaluationCount: this.informationBroker?.evaluationCount ?? 0,
                sharingApprovedCount: this.informationBroker?.shareCount ?? 0,
                notificationCount: this.notificationEngine.notificationCount,
                replanCount: this._replanCount ?? 0,
            },
            orchestratorAssessments,
            checkpointResults,
            sharingDecisions,
        });

        if (reflection) {
            this.emitPoolEvent(PoolEvent.REFLECTION_COMPLETE, {
                reflection,
            });

            // Enrich the PlannerMemory with reflection insights
            this.enrichPlannerMemoryWithReflection(reflection);
        }
    } catch (error) {
        this.logger.warn(
            { error: toErrorMessage(error) },
            "Post-execution reflection failed (non-critical)",
        );
    }
}
```

#### D. Helper `buildSharingDecisionsForReflection()`

```typescript
/**
 * Collects notable sharing decisions for the reflection prompt.
 *
 * Reads from the information broker's decision journal (évolution 14)
 * and formats them for the reflection engine.
 */
private buildSharingDecisionsForReflection(): Array<{
    decision: string;
    source: string;
    target: string;
    reasoning: string;
}> {
    const journal = this.informationBroker?.decisionJournal;
    if (!journal) return [];

    const entries = journal.getRecent(10);
    return entries.map((entry) => ({
        decision: entry.approved ? "SHARED" : "DENIED",
        source: entry.sourceId ?? "unknown",
        target: entry.targetId ?? "unknown",
        reasoning: entry.reasoningSummary,
    }));
}
```

#### E. Helper `enrichPlannerMemoryWithReflection()`

```typescript
/**
 * Enriches the most recent PlannerMemory with reflection insights.
 *
 * The PlannerMemory (évolution 13) stores factual data about each
 * execution. This method appends the reflection's analytical insights
 * to the memory's `lessons` field, making them available to the
 * planner for future task analysis.
 *
 * @param reflection - The completed execution reflection.
 */
private enrichPlannerMemoryWithReflection(reflection: ExecutionReflection): void {
    // The planner's recordExecution() has already been called at this point
    // (it happens after generateSummary). We need to append insights to
    // the most recent memory entry.

    // Build lesson strings from insights
    const insightLessons = reflection.insights
        .filter((i) => i.confidence >= 0.6)
        .map((i) => {
            const polarity = i.polarity === "positive" ? "✅" :
                             i.polarity === "negative" ? "⚠️" : "ℹ️";
            return `${polarity} [${i.category}] ${i.insight} (when: ${i.applicableWhen})`;
        });

    if (insightLessons.length === 0) return;

    // Append to the decomposition/sharing assessments as a summary lesson
    const assessmentLesson =
        `Reflection: effectiveness=${reflection.effectivenessScore}, ` +
        `decomposition=${reflection.decompositionAssessment}, ` +
        `sharing=${reflection.sharingAssessment}`;

    // Use the planner's appendToLastMemory method if available,
    // or access the memories array directly
    this.planner.appendLessonsToLastMemory([assessmentLesson, ...insightLessons]);
}
```

#### F. Add `appendLessonsToLastMemory()` to `TaskPlanner`

```typescript
// In task-planner.ts

/**
 * Appends additional lessons to the most recent PlannerMemory entry.
 *
 * Called by the reflection engine to enrich factual memories with
 * analytical insights after execution.
 *
 * @param lessons - Additional lesson strings to append.
 */
appendLessonsToLastMemory(lessons: string[]): void {
    if (this.memories.length === 0) return;

    const lastMemory = this.memories[this.memories.length - 1];
    if (!lastMemory) return;

    // Append lessons, keeping the total reasonable
    const combined = lastMemory.lessons + "\n" + lessons.join("\n");

    // Replace the lessons field (PlannerMemory fields are readonly,
    // so we need to replace the entry)
    this.memories[this.memories.length - 1] = {
        ...lastMemory,
        lessons: combined.slice(0, 2000), // Cap total lesson length
    };

    this.logger.debug(
        { appendedLessonCount: lessons.length },
        `Appended ${lessons.length} reflection insight(s) to planner memory`,
    );
}
```

#### G. Inject insights into the planner's task analysis prompt

In `TaskPlanner.analyze()`, after building the prompt with `taskAnalysisPrompt()`, append the insights section:

```typescript
// In TaskPlanner.analyze(), the reflectionEngine is passed via a setter or constructor

const prompt = taskAnalysisPrompt({
    task: sanitizedTask,
    contextHints: contextHints ?? null,
    constraints: constraints ?? null,
    projectContext: projectContext ?? null,
    previousExecutions: memoryContext ?? null,
    executionInsights: this.reflectionEngine?.getInsightsPromptSection() ?? null,
});
```

Update the `taskAnalysisPrompt` template in `planning.ts`:

```handlebars
{{#if executionInsights}}

{{executionInsights}}
{{/if}}
```

The `TaskPlanner` needs a reference to the `ReflectionEngine`. Pass it via setter:

```typescript
// In TaskPlanner
private reflectionEngine: ReflectionEngine | null = null;

setReflectionEngine(engine: ReflectionEngine): void {
    this.reflectionEngine = engine;
}
```

In `AgentPool` constructor, after creating both:

```typescript
this.planner.setReflectionEngine(this.reflectionEngine);
```

#### H. Add `reflection` to `AgentPoolConfig`

```typescript
// In AgentPoolConfig
export interface AgentPoolConfig {
    // ... existing fields ...

    /**
     * Configuration for post-execution reflection.
     * Enabled by default for multi-agent executions.
     */
    readonly reflection?: ReflectionConfig;
}
```

#### I. Expose reflection state in `AgentPoolState`

```typescript
// In AgentPoolState
interface AgentPoolState {
    // ... existing fields ...

    /** Number of post-execution reflections performed. */
    readonly reflectionCount: number;

    /** Number of stored execution insights. */
    readonly insightCount: number;

    /** Most recent effectiveness score, or null. */
    readonly lastEffectivenessScore: number | null;
}
```

Update `getState()`:

```typescript
getState(): AgentPoolState {
    return {
        // ... existing fields ...
        reflectionCount: this.reflectionEngine.reflectionCount,
        insightCount: this.reflectionEngine.insightCount,
        lastEffectivenessScore: this.reflectionEngine.lastReflection?.effectivenessScore ?? null,
    };
}
```

#### J. Add `reflection` to `AgentPoolResult`

```typescript
// In AgentPoolResult
interface AgentPoolResult {
    // ... existing fields ...

    /** Post-execution reflection with effectiveness analysis and insights, if performed. */
    readonly reflection?: ExecutionReflection;
}
```

In `execute()`, include the reflection in the result:

```typescript
const poolResult: AgentPoolResult = {
    task,
    strategy: analysis.strategy,
    analysis,
    agents: executionResults,
    summary,
    durationMs,
    reflection: reflection ?? undefined,  // from the reflect() call above
};
```

#### K. Insights survive between executions but NOT after destroy()

In the `finally` block of `execute()`:

```typescript
// Do NOT clear reflectionEngine insights here.
// Only clear the detailed reflection data to save memory.
this.reflectionEngine.clearReflections();
```

In `destroy()`:

```typescript
async destroy(): Promise<void> {
    // ... existing cleanup ...
    this.reflectionEngine.clearAll();
    // ...
}
```

#### L. Add event listener in the example file

```typescript
// In src/examples/agent-pool.ts
pool.on(PoolEvent.REFLECTION_COMPLETE, (e) => {
    const { reflection } = e;
    const scoreColor = reflection.effectivenessScore >= 0.8 ? ansi.green :
                       reflection.effectivenessScore >= 0.5 ? ansi.yellow : ansi.red;
    info(
        "🔍",
        `${scoreColor}Reflection: effectiveness=${reflection.effectivenessScore}${ansi.reset}, ` +
        `decomposition=${reflection.decompositionAssessment}, ` +
        `sharing=${reflection.sharingAssessment}`,
    );
    info("💡", `${reflection.insights.length} insight(s) extracted`);
    for (const insight of reflection.insights) {
        const icon = insight.polarity === "positive" ? "✅" :
                     insight.polarity === "negative" ? "⚠️" : "ℹ️";
        info(
            "  ",
            `${icon} [${insight.category}] ${ansi.dim}${truncate(insight.insight, 120)}${ansi.reset}`,
        );
    }
});
```

---

## Interaction avec les évolutions précédentes

### Avec l'évolution 13 (PlannerMemory)

La `PlannerMemory` capture des faits, la réflexion capture des insights analytiques. Les deux sont complémentaires :

- La `PlannerMemory` dit : « La tâche a été décomposée en 3 agents (API, tests, docs). L'agent tests a échoué et a été retry. »
- L'insight dit : « Quand un test-writer dépend d'un api-developer, il faut partager les définitions de routes complètes, pas juste les noms de fichiers. »

La méthode `appendLessonsToLastMemory()` fusionne ces deux sources dans la même entrée mémoire, ce qui donne au planner une vue complète lors des prochaines planifications.

### Avec l'évolution 16 (OrchestratorEngine)

Les `OrchestratorAssessment` produits pendant l'exécution sont fournis à la réflexion comme données d'entrée. L'orchestrator observe en temps réel, la réflexion analyse rétrospectivement. Les insights de la réflexion ne sont PAS injectés dans l'orchestrator — l'orchestrator ne travaille que sur l'exécution en cours.

### Avec l'évolution 14 (DecisionJournal)

Le `DecisionJournal` est lu pour fournir les `sharingDecisions` à la réflexion. Le journal capture les décisions individuelles, la réflexion les analyse en tant que pattern global (« trop de partage » ou « pas assez »).

### Avec l'évolution 15 (CheckpointEvaluator)

Les `CheckpointResult` sont fournis à la réflexion. Les checkpoints évaluent la santé pendant l'exécution, la réflexion évalue rétrospectivement si les checkpoints ont été utiles et si les corrections étaient appropriées.

### Avec l'évolution 11 (Re-planning)

Le `replanCount` est fourni à la réflexion. Si des re-planifications ont eu lieu, c'est un signal fort que la planification initiale n'était pas optimale — ce que la réflexion peut capturer comme insight « negative/decomposition ».

---

## Gestion du budget tokens

### Estimation de la taille du prompt de réflexion

| Section | Tokens estimés |
|---------|---------------|
| System prompt (reflection) | ~1200 (includes 2 examples) |
| Task + Plan | ~200 |
| Subtasks (3 × ~80 tokens) | ~240 |
| Agent results (3 × ~100 tokens) | ~300 |
| Coordination stats | ~80 |
| Orchestrator assessments (1 × ~150 tokens) | ~150 |
| Checkpoints (1 × ~50 tokens) | ~50 |
| Sharing decisions (5 × ~40 tokens) | ~200 |
| Existing insights (5 × ~60 tokens) | ~300 |
| **Total input** | **~2720** |
| **Output (JSON)** | **~600** |
| **Total par réflexion** | **~3320** |

### Fréquence

Une seule réflexion par exécution. Pour les exécutions multi-agents typiques, c'est ~3300 tokens, ce qui est modeste comparé au coût total de l'exécution (souvent > 100K tokens pour les agents eux-mêmes).

### Garde-fous

- La réflexion est désactivée pour les exécutions single-agent par défaut
- Le `maxTokens` de l'output est limité à 1200
- Les insights existants sont inclus pour éviter les répétitions (mais eux-mêmes sont limités à 8)
- La réflexion est fire-and-forget (non-critique)

---

## Tests à implémenter

### Tests unitaires pour `ReflectionEngine`

#### Test 1 : `reflect` retourne une `ExecutionReflection` valide

- Setup : mock `conversations.sendOneShotJson` pour retourner un JSON valide
- Appeler `reflect()` avec des données d'exécution complètes
- Assert : le résultat a tous les champs requis (`effectivenessScore`, `analysis`, `decompositionAssessment`, `sharingAssessment`, `insights`)
- Assert : `reflectionCount` est incrémenté

#### Test 2 : `reflect` retourne `null` quand disabled

- Setup : engine avec `enabled: false`
- Assert : `reflect()` retourne `null`
- Assert : `reflectionCount` reste 0

#### Test 3 : `reflect` retourne `null` pour single-agent quand `reflectOnSingleAgent: false`

- Setup : engine avec `reflectOnSingleAgent: false` (défaut)
- Appeler `reflect()` avec `analysis.strategy === "single"`
- Assert : retourne `null`

#### Test 4 : `reflect` retourne un résultat pour single-agent quand `reflectOnSingleAgent: true`

- Setup : engine avec `reflectOnSingleAgent: true`
- Appeler `reflect()` avec `analysis.strategy === "single"`
- Assert : retourne une `ExecutionReflection`

#### Test 5 : `reflect` retourne `null` en cas d'erreur LLM

- Setup : mock `conversations.sendOneShotJson` qui throw
- Assert : `reflect()` retourne `null`
- Assert : pas de crash

#### Test 6 : Les insights sont stockés après une réflexion réussie

- Setup : mock l'évaluation pour retourner 3 insights
- Assert : `insightCount` === 3
- Assert : `getAllInsights()` retourne les 3 insights

#### Test 7 : Les insights sont évincés quand `maxInsights` est atteint

- Setup : engine avec `maxInsights: 5`
- Effectuer 3 réflexions avec 2 insights chacune (6 insights total)
- Assert : `insightCount` <= 5
- Assert : les insights avec la plus haute confiance sont conservés

#### Test 8 : L'éviction préfère supprimer les insights à basse confiance

- Setup : engine avec `maxInsights: 3`
- Stocker 3 insights avec confidences [0.5, 0.8, 0.9]
- Ajouter un nouvel insight avec confidence 0.7
- Assert : l'insight à 0.5 est évincé
- Assert : le nouvel insight à 0.7 est stocké
- Assert : les insights à 0.8 et 0.9 sont toujours là

#### Test 9 : Les insights à basse confiance ne remplacent pas ceux à haute confiance

- Setup : engine avec `maxInsights: 3`, stockant 3 insights tous à confidence 0.9
- Ajouter un nouvel insight avec confidence 0.3
- Assert : `insightCount` reste 3
- Assert : le nouvel insight n'est PAS stocké

#### Test 10 : `getInsightsForPrompt` filtre par `minInsightConfidence`

- Setup : stocker des insights avec confidences [0.3, 0.5, 0.7, 0.9]
- `minInsightConfidence: 0.6`
- Assert : `getInsightsForPrompt()` retourne les insights à 0.7 et 0.9

#### Test 11 : `getInsightsForPrompt` respecte `maxInsightsInPrompt`

- Setup : stocker 10 insights tous à confidence 0.9
- `maxInsightsInPrompt: 3`
- Assert : `getInsightsForPrompt()` retourne exactement 3

#### Test 12 : `getInsightsForPrompt` trie par confiance puis par recency

- Setup : stocker 3 insights — même confiance mais timestamps différents
- Assert : le plus récent est en premier

#### Test 13 : `getInsightsPromptSection` retourne `null` sans insights éligibles

- Setup : engine vide
- Assert : `getInsightsPromptSection()` === `null`

#### Test 14 : `getInsightsPromptSection` formate correctement

- Setup : stocker un insight positif et un négatif
- Assert : le résultat contient `✅` et `⚠️`
- Assert : le résultat contient "Lessons from previous executions"
- Assert : le résultat contient les `applicableWhen`

#### Test 15 : La confiance des insights "positive" est réduite pour les exécutions low-effectiveness

- Setup : mock une réflexion avec `effectivenessScore: 0.4` et un insight `polarity: "positive"`, `confidence: 0.8`
- Assert : la confiance du insight stocké est < 0.8 (penalty appliquée)
- Assert : les insights `polarity: "negative"` ne sont PAS pénalisés

#### Test 16 : `clearAll` vide tout

- Setup : effectuer une réflexion avec des insights
- Appeler `clearAll()`
- Assert : `insightCount` === 0, `reflectionCount` === 0, `lastReflection` === null

#### Test 17 : `clearReflections` garde les insights

- Setup : effectuer une réflexion avec des insights
- Appeler `clearReflections()`
- Assert : `insightCount` > 0 (insights conservés)
- Assert : `getAllReflections()` est vide

#### Test 18 : Les insights survivent entre les réflexions

- Setup : effectuer 2 réflexions avec des insights différents
- Assert : `insightCount` inclut les insights des 2 réflexions
- Assert : `getInsightsForPrompt()` retourne des insights des 2

### Tests pour le validateur

#### Test 19 : `validateReflectionResponse` accepte une réponse complète valide

```typescript
const valid = {
    effectivenessScore: 0.85,
    analysis: "Good execution overall",
    decompositionAssessment: "optimal",
    sharingAssessment: "under-shared",
    insights: [
        {
            category: "sharing",
            confidence: 0.9,
            insight: "Share more API details",
            applicableWhen: "When test-writer depends on api-developer",
            polarity: "negative",
        },
    ],
};
// Assert: validateReflectionResponse(valid) !== null
```

#### Test 20 : `validateReflectionResponse` accepte une réponse sans insights

```typescript
const valid = {
    effectivenessScore: 1.0,
    analysis: "Perfect execution",
    decompositionAssessment: "optimal",
    sharingAssessment: "optimal",
    insights: [],
};
// Assert: validateReflectionResponse(valid) !== null
```

#### Test 21 : `validateReflectionResponse` rejette les `decompositionAssessment` invalides

```typescript
const invalid = {
    effectivenessScore: 0.5,
    analysis: "test",
    decompositionAssessment: "bad",
    sharingAssessment: "optimal",
    insights: [],
};
// Assert: validateReflectionResponse(invalid) === null
```

#### Test 22 : `validateReflectionResponse` rejette les `sharingAssessment` invalides

```typescript
const invalid = {
    effectivenessScore: 0.5,
    analysis: "test",
    decompositionAssessment: "optimal",
    sharingAssessment: "terrible",
    insights: [],
};
// Assert: validateReflectionResponse(invalid) === null
```

#### Test 23 : `validateReflectionResponse` rejette les catégories d'insight invalides

```typescript
const invalid = {
    effectivenessScore: 0.5,
    analysis: "test",
    decompositionAssessment: "optimal",
    sharingAssessment: "optimal",
    insights: [
        { category: "magic", confidence: 0.5, insight: "test", applicableWhen: "always", polarity: "positive" },
    ],
};
// Assert: validateReflectionResponse(invalid) === null
```

#### Test 24 : `validateReflectionResponse` clamp le score dans [0, 1]

```typescript
const data = {
    effectivenessScore: 1.5,
    analysis: "test",
    decompositionAssessment: "optimal",
    sharingAssessment: "optimal",
    insights: [],
};
const result = validateReflectionResponse(data);
// Assert: result.effectivenessScore === 1.0
```

### Tests d'intégration

#### Test 25 : `AgentPool.execute()` appelle `reflect()` après une exécution multi-agent

- Setup : créer un pool, exécuter une tâche multi-agent
- Mock la réflexion pour retourner un résultat
- Assert : l'événement `REFLECTION_COMPLETE` est émis
- Assert : `pool.getState().reflectionCount > 0`

#### Test 26 : `AgentPool.execute()` n'appelle PAS `reflect()` pour single-agent (défaut)

- Setup : créer un pool, exécuter une tâche simple
- Assert : l'événement `REFLECTION_COMPLETE` n'est PAS émis

#### Test 27 : Les insights sont injectés dans le planner prompt

- Setup : effectuer une réflexion qui produit des insights
- Mock `conversations.sendJson` pour capturer le prompt du planner
- Exécuter une deuxième tâche
- Assert : le prompt contient "Lessons from previous executions"
- Assert : le prompt contient les insights de la première exécution

#### Test 28 : `enrichPlannerMemoryWithReflection` ajoute les insights aux lessons

- Setup : effectuer une exécution + réflexion
- Assert : la dernière `PlannerMemory` contient les insights dans ses `lessons`
- Assert : les lessons contiennent les icônes de polarity (✅, ⚠️)

#### Test 29 : Les insights survivent entre les `execute()` mais pas après `destroy()`

- Setup : exécuter 2 tâches avec réflexion
- Assert : `insightCount` inclut les insights des 2 exécutions
- Appeler `pool.destroy()`
- Assert : la prochaine pool n'a aucun insight

#### Test 30 : La réflexion est incluse dans `AgentPoolResult`

- Setup : exécuter une tâche multi-agent
- Assert : `result.reflection` est défini
- Assert : `result.reflection.effectivenessScore` est un nombre entre 0 et 1

#### Test 31 : L'échec de la réflexion ne bloque pas l'exécution

- Setup : mock `conversations.sendOneShotJson` qui throw pendant la réflexion
- Assert : `execute()` réussit quand même
- Assert : `result.reflection` est `undefined`
- Assert : un warning est loggé

#### Test 32 : Le prompt de réflexion inclut les existing insights pour éviter les doublons

- Setup : stocker 3 insights, puis effectuer une nouvelle réflexion
- Mock pour capturer le prompt envoyé
- Assert : le prompt contient la section "Existing Insights"
- Assert : les 3 insights existants y sont listés

### Tests de non-régression

#### Test 33 : Les exécutions sans config `reflection` fonctionnent inchangées

- Setup : créer un pool sans le champ `reflection` dans la config
- Assert : l'exécution fonctionne normalement
- Assert : la réflexion est auto-enabled pour multi-agent

#### Test 34 : Désactiver explicitement la réflexion

- Setup : `reflection: { enabled: false }`
- Assert : aucun événement `REFLECTION_COMPLETE`
- Assert : `insightCount` reste 0

#### Test 35 : Les `PlannerMemory` existantes (évolution 13) fonctionnent toujours

- Setup : effectuer une exécution sans que la réflexion ne produise de résultat (erreur LLM)
- Assert : les `PlannerMemory` sont quand même enregistrées par `recordExecution()`
- Assert : les `lessons` de la mémoire contiennent les leçons programmatiques mais pas d'insights analytiques

#### Test 36 : Le validateur existant `validateTaskAnalysis` fonctionne toujours

- Setup : vérifier que les prompts du planner modifiés (avec section `executionInsights`) n'interfèrent pas avec la validation de la réponse du planner

---

## Critères de validation

- [ ] Le `ReflectionEngine` est instancié dans le constructeur de `AgentPool`
- [ ] Le system prompt de réflexion contient des exemples contrastifs (bonne/mauvaise exécution)
- [ ] `reflect()` est appelé après chaque exécution multi-agent (avant cleanup)
- [ ] `reflect()` est skippé pour les exécutions single-agent par défaut
- [ ] Le validateur `validateReflectionResponse` valide tous les champs enum
- [ ] Les insights sont extraits et stockés avec un quality-aware eviction
- [ ] Les insights survivent entre les `execute()` mais pas après `destroy()`
- [ ] `getInsightsForPrompt()` filtre par confiance et limite par `maxInsightsInPrompt`
- [ ] `getInsightsPromptSection()` formate les insights avec icônes de polarity et conditions d'applicabilité
- [ ] Les insights sont injectés dans le planner prompt via `executionInsights`
- [ ] Les insights enrichissent les `PlannerMemory` via `appendLessonsToLastMemory()`
- [ ] La réflexion est incluse dans `AgentPoolResult.reflection`
- [ ] L'événement `REFLECTION_COMPLETE` est émis
- [ ] L'état de la réflexion est exposé dans `AgentPoolState`
- [ ] L'échec de la réflexion est non-critique (logged, pas propagé)
- [ ] La confiance des insights "positive" est réduite pour les exécutions low-effectiveness
- [ ] Le prompt de réflexion inclut les insights existants pour éviter la duplication
- [ ] Tous les tests existants passent toujours

---

## Points d'attention

1. **La réflexion doit être appelée AVANT le cleanup du `finally` block** dans `execute()`. Le broker, le tracker, l'orchestrator, le checkpoint evaluator doivent encore être accessibles pour collecter les statistiques. La manière la plus propre est de déplacer le `reflect()` dans le `try` block, après `generateSummary()`.

2. **Le `appendLessonsToLastMemory()` dans `TaskPlanner`** modifie un objet `PlannerMemory` qui a des champs `readonly`. La solution est de remplacer l'entrée dans le tableau `memories[]` par un nouvel objet spread (`{ ...lastMemory, lessons: combined }`).

3. **Le `ReflectionEngine` utilise `ConversationRole.USER_INTERACTION`** pour ses appels LLM one-shot. Si un model override distinct est souhaité pour la réflexion, on peut ajouter un `ConversationRole.REFLECTION` — mais ce n'est pas nécessaire car la réflexion est une forme de résumé analytique compatible avec le system prompt de `USER_INTERACTION`. Le system prompt override est passé via le prompt lui-même (le system prompt du reflection est inclus dans les exemples et instructions du user prompt).

4. **Alternative : enregistrer un ConversationRole.REFLECTION dédié**. Si on veut un model override distinct (ex: utiliser un modèle moins cher pour la réflexion), ajouter le rôle dans l'enum et l'enregistrer avec `reflectionSystemPrompt({})` dans le constructeur. C'est une modification mineure.

5. **La boucle `reflect → store → inject` ne doit PAS créer de feedback loop infinie**. Les insights existants sont inclus dans le prompt de réflexion pour éviter la duplication (le LLM voit ce qui existe déjà et ne le répète pas). Les insights sont injectés dans le planner, mais le planner ne produit pas de réflexion — seul `execute()` le fait. Donc pas de boucle.

6. **La `buildSharingDecisionsForReflection()` dépend de l'interface `DecisionJournal`** de l'évolution 14. Vérifier que la méthode `getRecent()` existe. Si le nom ou la signature diffèrent, adapter. Les champs `sourceId`, `targetId`, `approved`, `reasoningSummary` doivent exister sur les entries du journal.

7. **La `reflectionEngine` n'est PAS reset dans le `finally` block de `execute()`** — seuls les `reflections` détaillés sont nettoyés via `clearReflections()`. Les `insights` persistent pour influencer les exécutions futures. Seul `pool.destroy()` nettoie tout via `clearAll()`.

8. **Le `_replanCount`** référencé dans le code d'intégration doit exister comme champ dans `AgentPool`. Si ce n'est pas le cas (dépend de l'implémentation de l'évolution 11), le remplacer par 0 ou le tracker approprié.

9. **Le `setReflectionEngine()` sur le `TaskPlanner`** est un setter qui crée un couplage optionnel. Le planner fonctionne sans (retourne `null` pour la section insights). Ne jamais rendre le `ReflectionEngine` un paramètre requis du constructeur du planner.

10. **Performance** : la réflexion ajoute une seule requête LLM (~3320 tokens) après chaque exécution multi-agent. C'est négligeable par rapport au coût total de l'exécution. Le traitement local (stockage, éviction, formatage) est instantané.