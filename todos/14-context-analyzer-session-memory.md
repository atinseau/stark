# Évolution 14 — Mémoire de session pour le Context Analyzer intra-exécution

## Priorité : 🟡 P2

## Dépendances : Évolution 05 (Séparation des prompts Context Analyzer)

## Acquis des évolutions précédentes

- **Évolution 01** : L'`InformationBroker` reçoit les mappings `subtaskToAgent` / `agentToSubtask` via son constructeur. `isAgentForSubtask()` fonctionne. Le tri des candidats par dépendance est opérationnel. `findDependency()` traduit correctement entre agent IDs et subtask IDs.
- **Évolution 02** : L'`InformationBroker` maintient un `SharingHistory` indexé par agent cible. Le prompt de partage inclut les partages précédents (`previouslyShared`). `recordSharing()` est appelé après chaque injection réussie. Le type `SharingRecord` existe.
- **Évolution 03** : Le `ProjectScanner` scanne le répertoire de travail et produit un `ProjectContext`. Le planner reçoit le contexte projet.
- **Évolution 04** : Tous les prompts LLM contiennent des exemples few-shot contrastifs.
- **Évolution 05** : Le rôle `ConversationRole.SHARING_ANALYZER` existe, dédié au partage inter-agents. Le rôle `ConversationRole.CONTEXT_ANALYZER` est spécialisé pour les notifications. L'`InformationBroker` utilise `SHARING_ANALYZER`. Le `NotificationEngine` utilise `CONTEXT_ANALYZER`.
- **Évolution 06** : Le notification prompt est nettoyé (plus de vérifications redondantes). Le summary prompt inclut les `CoordinationStats` et `sharingSummaries`.
- **Évolution 07** : Le preview dans les deltas `PROMPT_COMPLETE` est augmenté à 2000 chars. Le champ `promptResultSummary` existe dans `ContextDelta`. L'`InformationBroker` dispose de `evaluateWithFullResult()` pour les blocking deps.
- **Évolution 08** : L'injection de contexte est structurée avec `StructuredContextInjection`, priorisée (CRITICAL > HIGH > NORMAL > LOW), catégorisée, et protégée contre l'overflow.
- **Évolution 09** : Le seuil de significance est dynamique, adaptatif selon la phase d'exécution, le type de dépendance, et le nombre d'agents actifs.
- **Évolution 10** : Les subtasks ont un timeout configurable et un mécanisme de retry individuel avec contexte d'erreur injecté au nouvel agent.
- **Évolution 11** : Le planner peut être reconsulté en cours d'exécution pour adapter le plan suite à des échecs ou changements significatifs.
- **Évolution 12** : L'intent analyzer supporte les multi-intents et maintient un historique conversationnel court (3-5 derniers échanges).
- **Évolution 13** : Le planner utilise un résumé glissant au lieu d'un reset total, conservant un condensé des planifications précédentes.

---

## Contexte du problème

Les deux conversations d'analyse de contexte (`SHARING_ANALYZER` et `CONTEXT_ANALYZER`) fonctionnent actuellement en mode **one-shot exclusif** : chaque évaluation est indépendante, sans aucune mémoire des décisions précédentes au sein d'une même exécution.

### Mécanisme actuel

```typescript
// src/classes/agent-pool/information-broker.ts — evaluateBatch()
const batchDecisions = await this.conversations.sendOneShotJson(
    ConversationRole.SHARING_ANALYZER,  // ← One-shot : system prompt + user message uniquement
    prompt,
    validateBatchedSharingDecision,
    { maxTokens: 300 * targetStates.length, maxJsonAttempts: 2 },
);
```

```typescript
// src/classes/agent-pool/notification-engine.ts — evaluateWithLlm()
const decision = await this.conversations.sendOneShotJson(
    ConversationRole.CONTEXT_ANALYZER,  // ← One-shot : system prompt + user message uniquement
    prompt,
    validateNotificationDecision,
    { maxTokens: 200, maxJsonAttempts: 2 },
);
```

Les deux utilisent `sendOneShotJson()` — aucun historique conversationnel n'est accumulé. Chaque appel envoie uniquement le system prompt + le message courant.

### Problèmes causés par l'absence de mémoire de session

#### 1. Incapacité à détecter les patterns émergents

Le sharing analyzer ne peut pas observer que « j'ai déjà partagé 4 informations de type file_write vers cet agent, il est probablement au courant de la structure du filesystem ». Chaque décision est prise dans le vide, sans conscience du contexte accumulé par les décisions précédentes.

L'évolution 02 (SharingHistory) compense **partiellement** ce problème en injectant `previouslyShared` dans le prompt, mais c'est une liste statique de records, pas un raisonnement accumulé. Le LLM ne peut pas construire une compréhension progressive de la dynamique inter-agents.

#### 2. Incohérence des décisions dans le temps

Sans mémoire, le sharing analyzer peut prendre des décisions contradictoires :
- T1 : « Ne pas partager car le test-writer n'en est pas encore à la phase d'implémentation »
- T2 (30 secondes plus tard) : « Partager cette info car le test-writer pourrait en avoir besoin » (même type d'info, même cible)

Le LLM n'a aucun moyen de savoir qu'il a refusé une décision similaire récemment et pourquoi.

#### 3. Pas d'apprentissage intra-exécution

Au fur et à mesure d'une exécution multi-agent, le sharing analyzer accumule une compréhension implicite de :
- Quel agent produit quel type d'output
- Quel agent a besoin de quel type d'input
- À quel rythme les agents progressent
- Quels partages ont été utiles vs inutiles

En mode one-shot, cette compréhension est reconstruite **from scratch** à chaque évaluation, gaspillant des tokens et dégradant la qualité.

#### 4. Le notification engine ne peut pas ajuster sa sensibilité

Le notification engine ne peut pas apprendre qu'il a déjà notifié l'utilisateur 3 fois dans les 30 dernières secondes et devrait peut-être réduire la fréquence. Chaque notification est évaluée indépendamment.

### Pourquoi le one-shot a été choisi initialement

Le choix du one-shot était intentionnel et documenté :

```typescript
// Commentaire dans notification-engine.ts
// Token Efficiency
// Notification decisions use one-shot prompts (via `sendOneShotJson`)
// to avoid accumulating decision history in the conversation context.
// Only the system prompt and the current delta are sent, keeping token
// usage constant per evaluation regardless of how many deltas have
// been processed.
```

La préoccupation était la croissance linéaire des tokens avec le nombre de deltas. C'est une préoccupation valide — mais la solution n'est pas de supprimer toute mémoire, c'est de la **gérer intelligemment** avec un journal condensé.

---

## Solution : Journal de réflexion condensé (Decision Journal)

Au lieu de basculer du one-shot vers un historique conversationnel complet (qui causerait une explosion de tokens), implémenter un **journal de décisions condensé** qui est injecté dans chaque prompt one-shot.

### Concept

Après chaque décision (sharing ou notification), un condensé de la décision est ajouté à un journal interne. Ce journal est maintenu à une taille fixe (les N entrées les plus récentes). À chaque nouvelle évaluation, le journal est inclus dans le prompt one-shot, donnant au LLM un **contexte historique limité mais pertinent**.

### Avantages par rapport au full history

| Aspect | Full history | Decision Journal |
|--------|-------------|-----------------|
| Tokens par appel | Croissance linéaire (O(n)) | Constant (journal capé) |
| Qualité contextuelle | Maximale | Bonne (condensé des dernières décisions) |
| Risque de pollution | Élevé (vieilles décisions diluent) | Faible (journal rotatif) |
| Coût par exécution | Potentiellement explosif | Borné et prévisible |

---

## Fichiers impactés

| Fichier | Action |
|---------|--------|
| `src/classes/agent-pool/decision-journal.ts` | **Nouveau fichier** — Journal de décisions condensé |
| `src/classes/agent-pool/information-broker.ts` | Intégrer le journal de partage dans les évaluations |
| `src/classes/agent-pool/notification-engine.ts` | Intégrer le journal de notification dans les évaluations |
| `src/prompts/batched-sharing-decision.ts` | Enrichir le prompt avec le journal de partage |
| `src/prompts/notification-decision.ts` | Enrichir le prompt avec le journal de notification |
| `src/types/agent-pool.types.ts` | Ajouter les types `DecisionJournalEntry`, `DecisionJournalConfig` |
| `src/classes/agent-pool/agent-pool.ts` | Instancier et connecter les journaux |
| `src/classes/agent-pool/tests/` | Tests unitaires et d'intégration |

---

## Spécification détaillée des changements

### 1. Nouveaux types dans `agent-pool.types.ts`

```typescript
/**
 * A condensed record of a decision made by the sharing or notification analyzer.
 *
 * Each entry captures the essential information about a past decision
 * to provide context for future decisions without accumulating full
 * conversation history.
 */
export interface DecisionJournalEntry {
    /** ISO-8601 timestamp of the decision. */
    readonly timestamp: string;

    /** Type of decision: sharing or notification. */
    readonly type: "sharing" | "notification";

    /** The agent that produced the delta being evaluated. */
    readonly sourceAgentName: string;

    /**
     * For sharing decisions: the target agent name.
     * For notification decisions: "user".
     */
    readonly targetName: string;

    /** The delta type that triggered the evaluation. */
    readonly deltaType: string;

    /** Whether the decision was positive (share/notify) or negative (skip). */
    readonly approved: boolean;

    /**
     * Condensed reasoning for the decision (max ~100 chars).
     * Extracted from the LLM's reasoning field.
     */
    readonly reasoningSummary: string;
}

/**
 * Configuration for a DecisionJournal instance.
 */
export interface DecisionJournalConfig {
    /**
     * Maximum number of entries retained in the journal.
     * Oldest entries are evicted when the limit is reached.
     * Default: 15
     */
    readonly maxEntries?: number;

    /**
     * Maximum number of entries included in the LLM prompt.
     * Should be <= maxEntries. Entries beyond this are still stored
     * for analytics but not shown to the LLM.
     * Default: 8
     */
    readonly maxEntriesInPrompt?: number;

    /**
     * Maximum character length of the reasoningSummary per entry.
     * Truncated with "…" if exceeded.
     * Default: 120
     */
    readonly maxReasoningLength?: number;
}
```

### 2. Nouveau fichier `src/classes/agent-pool/decision-journal.ts`

```typescript
import type {
    DecisionJournalConfig,
    DecisionJournalEntry,
} from "../../types/agent-pool.types.ts";

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_MAX_ENTRIES = 15;
const DEFAULT_MAX_ENTRIES_IN_PROMPT = 8;
const DEFAULT_MAX_REASONING_LENGTH = 120;

// ── DecisionJournal ────────────────────────────────────────────────────────

/**
 * Maintains a rolling window of condensed decision records for
 * injection into LLM prompts.
 *
 * The journal serves as a lightweight "session memory" for the
 * sharing and notification analyzers. Instead of maintaining full
 * conversation history (which grows linearly with deltas), the journal
 * keeps a fixed-size window of decision summaries that gives the LLM
 * enough context to:
 *
 * - Detect patterns in its own decisions (e.g., "I've been sharing
 *   a lot of file_write events to this agent")
 * - Maintain consistency (e.g., "I refused this type of sharing
 *   earlier for good reason")
 * - Adjust behavior over time (e.g., "I've already notified the
 *   user 3 times in the last minute, I should be more selective")
 *
 * ## Design Decisions
 *
 * - **Fixed window, not summarization**: The journal uses a simple
 *   FIFO eviction strategy rather than LLM-based summarization.
 *   This keeps the journal management synchronous and free of
 *   additional LLM calls.
 *
 * - **Separate from SharingHistory**: The SharingHistory (evolution 02)
 *   tracks what was shared TO each target agent for deduplication.
 *   The DecisionJournal tracks ALL decisions (including rejections)
 *   to provide reasoning context. They serve complementary purposes.
 *
 * - **One journal per analyzer**: The sharing analyzer and notification
 *   engine each have their own journal instance. This prevents
 *   cross-contamination of decision contexts.
 *
 * ## Token Budget
 *
 * With `maxEntriesInPrompt = 8` and `maxReasoningLength = 120`,
 * the journal section adds approximately:
 * - 8 entries × ~200 chars each = ~1600 chars ≈ ~400 tokens
 *
 * This is a modest, bounded overhead per LLM call.
 *
 * @example
 * ```ts
 * const journal = new DecisionJournal({ maxEntries: 15 });
 *
 * journal.record({
 *     timestamp: "2024-01-15T10:30:00Z",
 *     type: "sharing",
 *     sourceAgentName: "api-developer",
 *     targetName: "test-writer",
 *     deltaType: "prompt_complete",
 *     approved: true,
 *     reasoningSummary: "API implementation details are critical for test-writer's blocking dependency.",
 * });
 *
 * const promptSection = journal.toPromptSection();
 * // Returns formatted text ready for inclusion in an LLM prompt
 * ```
 */
export class DecisionJournal {
    private readonly entries: DecisionJournalEntry[] = [];
    private readonly maxEntries: number;
    private readonly maxEntriesInPrompt: number;
    private readonly maxReasoningLength: number;

    constructor(config?: DecisionJournalConfig) {
        this.maxEntries = config?.maxEntries ?? DEFAULT_MAX_ENTRIES;
        this.maxEntriesInPrompt = config?.maxEntriesInPrompt ?? DEFAULT_MAX_ENTRIES_IN_PROMPT;
        this.maxReasoningLength = config?.maxReasoningLength ?? DEFAULT_MAX_REASONING_LENGTH;
    }

    // ── Recording ──────────────────────────────────────────────────────

    /**
     * Records a new decision in the journal.
     *
     * The `reasoningSummary` is automatically truncated to
     * `maxReasoningLength` characters if necessary.
     *
     * If the journal exceeds `maxEntries`, the oldest entry is evicted.
     *
     * @param entry - The decision to record.
     */
    record(entry: DecisionJournalEntry): void {
        // Truncate reasoning if needed
        const truncatedEntry: DecisionJournalEntry = {
            ...entry,
            reasoningSummary: entry.reasoningSummary.length > this.maxReasoningLength
                ? entry.reasoningSummary.slice(0, this.maxReasoningLength) + "…"
                : entry.reasoningSummary,
        };

        this.entries.push(truncatedEntry);

        // Evict oldest if over limit
        while (this.entries.length > this.maxEntries) {
            this.entries.shift();
        }
    }

    /**
     * Records a sharing decision from an InformationBroker evaluation.
     *
     * Convenience method that constructs the journal entry from
     * the sharing decision fields.
     *
     * @param sourceAgentName - Name of the agent that produced the delta.
     * @param targetAgentName - Name of the target agent evaluated.
     * @param deltaType - The type of delta being evaluated.
     * @param approved - Whether sharing was approved.
     * @param reasoning - The LLM's reasoning (will be truncated).
     * @param timestamp - ISO-8601 timestamp.
     */
    recordSharingDecision(
        sourceAgentName: string,
        targetAgentName: string,
        deltaType: string,
        approved: boolean,
        reasoning: string,
        timestamp: string,
    ): void {
        this.record({
            timestamp,
            type: "sharing",
            sourceAgentName,
            targetName: targetAgentName,
            deltaType,
            approved,
            reasoningSummary: reasoning,
        });
    }

    /**
     * Records a notification decision from the NotificationEngine.
     *
     * @param sourceAgentName - Name of the agent that produced the delta.
     * @param deltaType - The type of delta being evaluated.
     * @param approved - Whether notification was sent.
     * @param reasoning - The LLM's reasoning (will be truncated).
     * @param timestamp - ISO-8601 timestamp.
     */
    recordNotificationDecision(
        sourceAgentName: string,
        deltaType: string,
        approved: boolean,
        reasoning: string,
        timestamp: string,
    ): void {
        this.record({
            timestamp,
            type: "notification",
            sourceAgentName,
            targetName: "user",
            deltaType,
            approved,
            reasoningSummary: reasoning,
        });
    }

    // ── Prompt Generation ──────────────────────────────────────────────

    /**
     * Generates a formatted text section suitable for inclusion in
     * an LLM prompt.
     *
     * Returns the most recent `maxEntriesInPrompt` entries formatted
     * as a numbered list with key fields. Returns `null` if the
     * journal is empty.
     *
     * @returns A formatted string for prompt injection, or `null`.
     */
    toPromptSection(): string | null {
        if (this.entries.length === 0) return null;

        const entriesToShow = this.entries.slice(-this.maxEntriesInPrompt);

        const lines = entriesToShow.map((entry, index) => {
            const decision = entry.approved ? "✅ APPROVED" : "❌ DENIED";
            const arrow = entry.type === "sharing"
                ? `${entry.sourceAgentName} → ${entry.targetName}`
                : `${entry.sourceAgentName} → user notification`;
            const timeAgo = this.formatRelativeTime(entry.timestamp);

            return (
                `${index + 1}. [${decision}] ${arrow} (${entry.deltaType}, ${timeAgo})\n` +
                `   Reasoning: ${entry.reasoningSummary}`
            );
        });

        return lines.join("\n\n");
    }

    /**
     * Returns the journal entries as a structured array suitable
     * for inclusion in Handlebars templates.
     *
     * @returns Array of entries for template rendering, or empty array.
     */
    toTemplateData(): Array<{
        decision: string;
        sourceAgentName: string;
        targetName: string;
        deltaType: string;
        approved: boolean;
        reasoningSummary: string;
        timeAgo: string;
    }> {
        const entriesToShow = this.entries.slice(-this.maxEntriesInPrompt);

        return entriesToShow.map((entry) => ({
            decision: entry.approved ? "APPROVED" : "DENIED",
            sourceAgentName: entry.sourceAgentName,
            targetName: entry.targetName,
            deltaType: entry.deltaType,
            approved: entry.approved,
            reasoningSummary: entry.reasoningSummary,
            timeAgo: this.formatRelativeTime(entry.timestamp),
        }));
    }

    // ── Query ──────────────────────────────────────────────────────────

    /** Returns the total number of entries in the journal. */
    get entryCount(): number {
        return this.entries.length;
    }

    /** Returns the number of approved decisions in the journal. */
    get approvedCount(): number {
        return this.entries.filter((e) => e.approved).length;
    }

    /** Returns the number of denied decisions in the journal. */
    get deniedCount(): number {
        return this.entries.filter((e) => !e.approved).length;
    }

    /**
     * Returns the approval rate as a number between 0 and 1.
     * Returns 0 if the journal is empty.
     */
    get approvalRate(): number {
        if (this.entries.length === 0) return 0;
        return this.approvedCount / this.entries.length;
    }

    /**
     * Returns the number of decisions made in the last N seconds.
     * Useful for rate limiting (e.g., "too many notifications in a short time").
     *
     * @param seconds - The time window in seconds.
     * @returns Number of decisions within the window.
     */
    countRecentDecisions(seconds: number): number {
        const cutoff = Date.now() - seconds * 1000;
        return this.entries.filter((e) => new Date(e.timestamp).getTime() > cutoff).length;
    }

    /**
     * Returns the number of approved decisions for a specific target
     * in the last N seconds.
     *
     * @param targetName - The target agent name or "user".
     * @param seconds - The time window in seconds.
     * @returns Number of approved decisions for this target within the window.
     */
    countRecentApprovedForTarget(targetName: string, seconds: number): number {
        const cutoff = Date.now() - seconds * 1000;
        return this.entries.filter(
            (e) =>
                e.targetName === targetName &&
                e.approved &&
                new Date(e.timestamp).getTime() > cutoff,
        ).length;
    }

    /**
     * Returns all entries as a read-only array.
     */
    getAllEntries(): readonly DecisionJournalEntry[] {
        return [...this.entries];
    }

    // ── Lifecycle ──────────────────────────────────────────────────────

    /**
     * Clears all entries from the journal.
     * Called between executions or on pool reset.
     */
    clear(): void {
        this.entries.length = 0;
    }

    // ── Private ────────────────────────────────────────────────────────

    /**
     * Formats a timestamp as a human-readable relative time string.
     * Examples: "5s ago", "2m ago", "1h ago"
     *
     * @param timestamp - ISO-8601 timestamp.
     * @returns Human-readable relative time.
     */
    private formatRelativeTime(timestamp: string): string {
        const now = Date.now();
        const then = new Date(timestamp).getTime();
        const diffMs = now - then;

        if (Number.isNaN(diffMs) || diffMs < 0) return "just now";

        const diffS = Math.floor(diffMs / 1000);
        if (diffS < 60) return `${diffS}s ago`;

        const diffM = Math.floor(diffS / 60);
        if (diffM < 60) return `${diffM}m ago`;

        const diffH = Math.floor(diffM / 60);
        return `${diffH}h ago`;
    }
}
```

### 3. Intégrer le journal dans l'`InformationBroker`

#### Ajouter le journal au constructeur

```typescript
// src/classes/agent-pool/information-broker.ts

import { DecisionJournal } from "./decision-journal.ts";

export class InformationBroker {
    // ... existing fields ...

    /** Rolling journal of sharing decisions for session memory. */
    private readonly decisionJournal: DecisionJournal;

    constructor(
        private readonly conversations: ConversationManager,
        private readonly contextTracker: ContextTracker,
        private readonly dependencies: ReadonlyArray<TaskDependency>,
        private readonly logger: pino.Logger,
        private readonly subtaskToAgent: ReadonlyMap<string, string>,
        private readonly agentToSubtask: ReadonlyMap<string, string>,
        options?: {
            significanceThreshold?: number;
            journalConfig?: DecisionJournalConfig;
        },
    ) {
        this.significanceThreshold = options?.significanceThreshold ?? 0.6;
        this.decisionJournal = new DecisionJournal(options?.journalConfig);
    }
```

#### Enregistrer les décisions dans le journal

Dans `evaluateBatch()`, après avoir reçu les décisions du LLM :

```typescript
private async evaluateBatch(
    delta: ContextDelta,
    sourceState: AgentContextState,
    targetStates: AgentContextState[],
): Promise<SharingDecision[]> {
    // ... existing target building ...
    // ... existing prompt building ...

    // ── NOUVEAU : inclure le journal dans le prompt ──────────────
    const journalSection = this.decisionJournal.toPromptSection();

    const prompt = batchedSharingDecisionPrompt({
        sourceAgent: { /* ... existing ... */ },
        delta: { /* ... existing ... */ },
        targets,
        decisionJournal: journalSection,  // ← NOUVEAU
    });

    // ... existing LLM call ...

    const results: SharingDecision[] = batchDecisions.map((decision) => ({
        shouldShare: decision.shouldShare,
        reasoning: decision.reasoning,
        information: decision.information,
        sourceAgentId: sourceState.agentId,
        targetAgentId: decision.targetAgentId,
    }));

    // ── NOUVEAU : enregistrer les décisions dans le journal ──────
    for (const decision of results) {
        const targetState = targetStates.find((t) => t.agentId === decision.targetAgentId);
        const targetName = targetState?.agentName ?? decision.targetAgentId;

        this.decisionJournal.recordSharingDecision(
            sourceState.agentName,
            targetName,
            delta.type,
            decision.shouldShare,
            decision.reasoning,
            delta.timestamp,
        );
    }

    // ... existing logging and stats ...

    return results;
}
```

#### Exposer le journal pour le cleanup

```typescript
/**
 * Returns the decision journal for inspection or cleanup.
 * Used by the pool for end-of-execution analytics.
 */
get journal(): DecisionJournal {
    return this.decisionJournal;
}
```

### 4. Enrichir le prompt de sharing avec le journal

Dans `src/prompts/batched-sharing-decision.ts`, ajouter la section du journal :

```handlebars
{{#if decisionJournal}}
## Recent Sharing Decisions (your session memory)
These are your most recent decisions in this execution. Use them to maintain consistency and detect patterns. Do NOT re-share information you already approved sharing, and respect reasoning from previous denials unless circumstances have changed.

{{decisionJournal}}
{{/if}}

## Source Agent
- **Name**: {{sourceAgent.agentName}} ({{sourceAgent.agentId}})
...
```

Placer la section du journal **avant** le delta et les targets dans le prompt, pour que le LLM ait le contexte de ses décisions passées avant d'évaluer la décision courante.

### 5. Intégrer le journal dans le `NotificationEngine`

#### Ajouter le journal au constructeur

```typescript
// src/classes/agent-pool/notification-engine.ts

import { DecisionJournal } from "./decision-journal.ts";

export class NotificationEngine {
    // ... existing fields ...

    /** Rolling journal of notification decisions for session memory. */
    private readonly decisionJournal: DecisionJournal;

    constructor(
        private readonly conversations: ConversationManager,
        private readonly logger: pino.Logger,
        journalConfig?: DecisionJournalConfig,
    ) {
        this.decisionJournal = new DecisionJournal(journalConfig);
    }
```

#### Enregistrer les décisions et les inclure dans le prompt

Dans `evaluateWithLlm()` :

```typescript
private async evaluateWithLlm(
    delta: ContextDelta,
    agentState: AgentContextState,
): Promise<UserNotification | null> {
    if (!this.preference) return null;

    // ── NOUVEAU : inclure le journal dans le prompt ──────────────
    const journalSection = this.decisionJournal.toPromptSection();
    const recentNotificationCount = this.decisionJournal.countRecentApprovedForTarget("user", 60);

    const prompt = notificationDecisionPrompt({
        delta: {
            agentName: delta.agentName,
            agentRole: agentState.taskRole,
            type: delta.type,
            summary: delta.summary,
            significance: delta.significance,
        },
        agentTask: agentState.taskDescription,
        otherAgentsContext: null,
        decisionJournal: journalSection,  // ← NOUVEAU
        recentNotificationCount,          // ← NOUVEAU (for rate awareness)
    });

    this._evaluationCount++;

    try {
        const decision = await this.conversations.sendOneShotJson(
            ConversationRole.CONTEXT_ANALYZER,
            prompt,
            validateNotificationDecision,
            { maxTokens: 200, maxJsonAttempts: 2 },
        );

        if (!decision) {
            this.logger.warn(
                { agentId: delta.agentId },
                "Notification decision validation returned null",
            );
            return null;
        }

        // ── NOUVEAU : enregistrer la décision dans le journal ────────
        this.decisionJournal.recordNotificationDecision(
            delta.agentName,
            delta.type,
            decision.shouldNotify,
            decision.reasoning,
            delta.timestamp,
        );

        if (!decision.shouldNotify) {
            // ... existing deny logging ...
            return null;
        }

        // ... existing notification building ...
    } catch (error) {
        // ... existing error handling ...
    }
}
```

#### Exposer le journal

```typescript
/**
 * Returns the decision journal for inspection or cleanup.
 */
get journal(): DecisionJournal {
    return this.decisionJournal;
}
```

### 6. Enrichir le prompt de notification avec le journal

Dans `src/prompts/notification-decision.ts`, ajouter :

```handlebars
{{#if decisionJournal}}
## Your Recent Notification Decisions
These are your most recent decisions in this execution. Maintain consistency and avoid notification fatigue — if you've already notified about similar events recently, be more selective.

{{decisionJournal}}

{{#if recentNotificationCount}}
⚠️ You have sent {{recentNotificationCount}} notification(s) in the last 60 seconds. Be increasingly selective to avoid overwhelming the user.
{{/if}}
{{/if}}

This context delta has already passed significance ({{delta.significance}} ≥ threshold) and type filters...
```

La section de rate awareness (`recentNotificationCount`) aide le LLM à auto-réguler la fréquence de notification. Si 3 notifications ont été envoyées dans la dernière minute, le LLM sera plus sélectif.

### 7. Connecter les journaux dans `AgentPool`

#### Instanciation

Les journaux sont créés automatiquement par le broker et le notification engine via leurs constructeurs. Pas de changement nécessaire dans le constructeur de l'`AgentPool`.

Le broker est recréé à chaque exécution (`this.informationBroker = new InformationBroker(...)`) — le journal est donc naturellement nettoyé entre les exécutions.

Le `NotificationEngine` est un singleton persistant sur la pool. Son journal accumule entre les exécutions. Si c'est un problème, ajouter un `clearJournal()` dans le cleanup de `execute()` :

```typescript
// Dans execute(), finally block
finally {
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

    // ← NOUVEAU : clear notification journal between executions
    this.notificationEngine.journal.clear();
}
```

#### Analytics

Optionnellement, logguer les statistiques du journal en fin d'exécution :

```typescript
// Avant le cleanup, dans execute()
if (this.informationBroker) {
    const sharingJournal = this.informationBroker.journal;
    this.logger.info(
        {
            sharingDecisions: sharingJournal.entryCount,
            sharingApprovalRate: sharingJournal.approvalRate,
        },
        `Sharing journal: ${sharingJournal.entryCount} decisions, ${(sharingJournal.approvalRate * 100).toFixed(0)}% approval rate`,
    );
}

{
    const notifJournal = this.notificationEngine.journal;
    this.logger.info(
        {
            notificationDecisions: notifJournal.entryCount,
            notificationApprovalRate: notifJournal.approvalRate,
        },
        `Notification journal: ${notifJournal.entryCount} decisions, ${(notifJournal.approvalRate * 100).toFixed(0)}% approval rate`,
    );
}
```

---

## Interaction avec les évolutions précédentes

### Évolution 02 (SharingHistory) — Complémentaire, pas redondante

| Aspect | SharingHistory (évo 02) | DecisionJournal (évo 14) |
|--------|------------------------|-------------------------|
| **Contenu** | Partages effectués uniquement | Toutes les décisions (approuvées ET refusées) |
| **Indexation** | Par agent cible | Chronologique |
| **Objectif** | Déduplication technique | Contexte de raisonnement |
| **Données** | `informationSummary` (quoi a été partagé) | `reasoningSummary` (pourquoi) |
| **Scope dans le prompt** | Dans la section de chaque target (`previouslyShared`) | Dans une section globale au début du prompt |

Les deux mécanismes coexistent et servent des objectifs distincts. Le LLM voit les deux : `previouslyShared` pour savoir QUOI a été partagé à chaque target, et le journal pour savoir POURQUOI les décisions ont été prises.

### Évolution 05 (Split des prompts) — Prérequis

La séparation en `SHARING_ANALYZER` et `CONTEXT_ANALYZER` (évolution 05) permet d'avoir un journal dédié par rôle. Sans cette séparation, un seul journal mélangerait les décisions de sharing et de notification, ce qui serait confus pour le LLM.

### Évolution 09 (Seuil dynamique) — Synergie

Le journal contient des informations temporelles (`countRecentDecisions`) qui pourraient alimenter le seuil dynamique. Par exemple, si le journal montre que 80% des évaluations récentes ont été refusées, le seuil pourrait être temporairement relevé pour éviter des appels LLM inutiles. Ce n'est pas implémenté dans cette évolution mais le journal fournit les données nécessaires.

---

## Tests à implémenter

### Tests unitaires pour `DecisionJournal`

#### Test 1 : `record()` ajoute une entrée

- Créer un journal, enregistrer une entrée
- Assert : `entryCount` === 1
- Assert : `getAllEntries()[0]` contient les bonnes valeurs

#### Test 2 : `record()` tronque le `reasoningSummary`

- Enregistrer une entrée avec un reasoning de 300 chars
- Assert : l'entrée stockée a un `reasoningSummary` de `maxReasoningLength` chars + "…"

#### Test 3 : `record()` évicte les plus anciennes quand `maxEntries` est dépassé

- Créer un journal avec `maxEntries: 5`
- Enregistrer 7 entrées
- Assert : `entryCount` === 5
- Assert : les 2 premières entrées ont été évincées
- Assert : les 5 dernières entrées sont celles restantes

#### Test 4 : `toPromptSection()` retourne `null` quand le journal est vide

- Créer un journal vide
- Assert : `toPromptSection()` === `null`

#### Test 5 : `toPromptSection()` retourne un texte formaté avec les bonnes entrées

- Enregistrer 3 entrées (2 approuvées, 1 refusée)
- Appeler `toPromptSection()`
- Assert : le résultat contient `"✅ APPROVED"` 2 fois et `"❌ DENIED"` 1 fois
- Assert : le résultat contient les noms d'agents source et target
- Assert : le résultat contient les résumés de reasoning
- Assert : le résultat contient les delta types

#### Test 6 : `toPromptSection()` respecte `maxEntriesInPrompt`

- Créer un journal avec `maxEntries: 15, maxEntriesInPrompt: 3`
- Enregistrer 10 entrées
- Appeler `toPromptSection()`
- Assert : le résultat contient exactement 3 entrées (les 3 plus récentes)

#### Test 7 : `recordSharingDecision()` convenience method

- Appeler `recordSharingDecision("api-dev", "test-writer", "prompt_complete", true, "reason", "2024-01-15T10:00:00Z")`
- Assert : l'entrée a `type: "sharing"`, `sourceAgentName: "api-dev"`, `targetName: "test-writer"`

#### Test 8 : `recordNotificationDecision()` convenience method

- Appeler `recordNotificationDecision("api-dev", "prompt_complete", false, "not noteworthy", "2024-01-15T10:00:00Z")`
- Assert : l'entrée a `type: "notification"`, `targetName: "user"`

#### Test 9 : `approvalRate` calcule correctement

- Enregistrer 3 approuvées et 2 refusées
- Assert : `approvalRate` === 0.6
- Assert : `approvedCount` === 3
- Assert : `deniedCount` === 2

#### Test 10 : `approvalRate` retourne 0 pour un journal vide

- Assert : `approvalRate` === 0

#### Test 11 : `countRecentDecisions()` filtre par fenêtre temporelle

- Enregistrer 3 entrées avec des timestamps :
  - il y a 10 secondes
  - il y a 30 secondes
  - il y a 120 secondes
- Assert : `countRecentDecisions(60)` === 2 (les deux premières)
- Assert : `countRecentDecisions(15)` === 1 (seulement la première)
- Assert : `countRecentDecisions(300)` === 3 (toutes)

#### Test 12 : `countRecentApprovedForTarget()` filtre par target et fenêtre

- Enregistrer :
  - approved pour "test-writer" il y a 10s
  - denied pour "test-writer" il y a 20s
  - approved pour "doc-writer" il y a 30s
  - approved pour "test-writer" il y a 120s
- Assert : `countRecentApprovedForTarget("test-writer", 60)` === 1
- Assert : `countRecentApprovedForTarget("doc-writer", 60)` === 1
- Assert : `countRecentApprovedForTarget("test-writer", 300)` === 2

#### Test 13 : `clear()` vide le journal

- Enregistrer 5 entrées
- Appeler `clear()`
- Assert : `entryCount` === 0
- Assert : `toPromptSection()` === `null`

#### Test 14 : `toTemplateData()` retourne les données structurées

- Enregistrer 2 entrées
- Appeler `toTemplateData()`
- Assert : retourne un tableau de 2 objets avec les champs attendus
- Assert : chaque objet a `decision`, `sourceAgentName`, `targetName`, `deltaType`, `approved`, `reasoningSummary`, `timeAgo`

#### Test 15 : `formatRelativeTime()` produit des labels lisibles

- Tester avec des timestamps à différentes distances :
  - 5 secondes ago → `"5s ago"`
  - 90 secondes ago → `"1m ago"`
  - 3600+ secondes ago → `"1h ago"`
  - timestamp dans le futur → `"just now"`
  - timestamp invalide → `"just now"`

### Tests d'intégration

#### Test 16 : Le prompt de sharing inclut le journal quand il n'est pas vide

- Créer un broker, enregistrer 3 décisions dans le journal
- Mocker `sendOneShotJson` pour capturer le prompt
- Déclencher `evaluateBatch()`
- Assert : le prompt capturé contient `"Recent Sharing Decisions"`
- Assert : le prompt contient les 3 entrées du journal

#### Test 17 : Le prompt de sharing n'inclut PAS le journal quand il est vide

- Créer un broker (journal vide)
- Mocker `sendOneShotJson` pour capturer le prompt
- Déclencher `evaluateBatch()`
- Assert : le prompt capturé ne contient PAS `"Recent Sharing Decisions"`

#### Test 18 : Les décisions de sharing sont enregistrées dans le journal

- Mocker le LLM pour retourner 2 décisions (1 approved, 1 denied)
- Déclencher `evaluateBatch()`
- Assert : `broker.journal.entryCount` === 2
- Assert : `broker.journal.approvedCount` === 1
- Assert : `broker.journal.deniedCount` === 1

#### Test 19 : Le prompt de notification inclut le journal et le rate awareness

- Créer un notification engine, enregistrer 2 notifications approuvées dans le journal
- Mocker `sendOneShotJson` pour capturer le prompt
- Déclencher `evaluateWithLlm()`
- Assert : le prompt contient `"Your Recent Notification Decisions"`
- Assert : le prompt contient `"2 notification(s) in the last 60 seconds"` (si les timestamps sont récents)

#### Test 20 : Les décisions de notification sont enregistrées dans le journal

- Mocker le LLM pour retourner `shouldNotify: true`
- Déclencher `evaluateWithLlm()`
- Assert : `engine.journal.entryCount` === 1
- Assert : l'entrée a `type: "notification"` et `approved: true`

#### Test 21 : Le journal de notification est nettoyé entre les exécutions

- Exécuter une tâche (le journal du notification engine accumule des entrées)
- Vérifier que le journal est non-vide après l'exécution
- Le `finally` block de `execute()` appelle `notificationEngine.journal.clear()`
- Assert : le journal est vide après le cleanup

#### Test 22 : Le journal du broker est nettoyé naturellement (nouveau broker par exécution)

- Exécuter une tâche → le broker est créé avec un journal vide
- Assert : le journal est vide au début de chaque exécution
- (Pas besoin de clear explicite car le broker est recréé)

#### Test 23 : Les analytics du journal sont loggées en fin d'exécution

- Mocker le logger
- Exécuter une tâche multi-agent avec quelques deltas et partages
- Assert : le logger contient un message avec `"Sharing journal"` et les stats (entryCount, approvalRate)
- Assert : le logger contient un message avec `"Notification journal"` et les stats

### Tests de non-régression

#### Test 24 : Le sharing fonctionne identiquement quand le journal est vide

- Mocker le LLM pour retourner les mêmes décisions qu'avant
- Comparer le prompt envoyé avec journal vide vs sans journal
- Assert : le seul différence est l'absence de la section journal
- Assert : les décisions retournées sont identiques

#### Test 25 : La déduplication (SharingHistory, évolution 02) fonctionne toujours

- Vérifier que `previouslyShared` est toujours inclus dans le prompt
- Vérifier que le journal et le `previouslyShared` n'interfèrent pas

---

## Critères de validation

- [ ] La classe `DecisionJournal` existe dans `src/classes/agent-pool/decision-journal.ts`
- [ ] Le type `DecisionJournalEntry` existe dans `agent-pool.types.ts`
- [ ] Le type `DecisionJournalConfig` existe dans `agent-pool.types.ts`
- [ ] Le journal a une taille fixe (`maxEntries`) avec éviction FIFO des plus anciens
- [ ] Le `reasoningSummary` est automatiquement tronqué à `maxReasoningLength`
- [ ] `toPromptSection()` retourne `null` quand le journal est vide
- [ ] `toPromptSection()` formate les entrées avec `✅ APPROVED` / `❌ DENIED`, noms d'agents, delta types, et raisonnement
- [ ] `toPromptSection()` ne retourne que les `maxEntriesInPrompt` entrées les plus récentes
- [ ] `countRecentDecisions()` filtre correctement par fenêtre temporelle
- [ ] `countRecentApprovedForTarget()` filtre par target ET fenêtre temporelle
- [ ] L'`InformationBroker` enregistre chaque décision (approuvée ET refusée) dans le journal
- [ ] L'`InformationBroker` inclut le journal dans le prompt de sharing (section `## Recent Sharing Decisions`)
- [ ] Le `NotificationEngine` enregistre chaque décision (notifiée ET refusée) dans le journal
- [ ] Le `NotificationEngine` inclut le journal dans le prompt de notification (section `## Your Recent Notification Decisions`)
- [ ] Le prompt de notification inclut un avertissement de fréquence quand `recentNotificationCount > 0`
- [ ] Le journal du broker est nettoyé naturellement (broker recréé par exécution)
- [ ] Le journal du notification engine est nettoyé dans le `finally` de `execute()`
- [ ] Les analytics du journal (entryCount, approvalRate) sont loggées en fin d'exécution
- [ ] La section journal est placée AVANT le delta et les targets dans le prompt de sharing
- [ ] La section journal est placée AVANT le delta dans le prompt de notification
- [ ] Le budget tokens ajouté par le journal est borné (~400 tokens max par appel)
- [ ] La `SharingHistory` (évolution 02) et le `DecisionJournal` coexistent sans conflit
- [ ] `previouslyShared` est toujours inclus dans la section de chaque target (pas remplacé par le journal)
- [ ] Tous les tests existants passent toujours
- [ ] Les nouveaux tests couvrent le recording, la troncation, l'éviction, le formatting, la query temporelle, et l'intégration avec broker/notification engine

---

## Points d'attention

1. **Le journal est PAS un remplacement de la SharingHistory** — les deux mécanismes servent des objectifs complémentaires. La `SharingHistory` répond à « quoi a été partagé à ce target ? » (déduplication). Le `DecisionJournal` répond à « quelles décisions ai-je prises récemment et pourquoi ? » (cohérence de raisonnement). Ne pas confondre les deux et ne pas essayer de fusionner.

2. **Le journal enregistre les REFUS aussi** — c'est une différence clé avec la `SharingHistory` qui ne track que les partages effectués. Les refus sont précieux pour la cohérence : si le LLM a refusé un partage il y a 30 secondes avec un bon reasoning, il devrait maintenir cette position sauf si les circonstances ont changé.

3. **Le rate awareness pour les notifications est simple et efficace** — `countRecentApprovedForTarget("user", 60)` donne au LLM un signal numérique de fréquence. Pas besoin de logique complexe — le LLM est capable d'interpréter « you've sent 5 notifications in the last 60 seconds » et d'ajuster sa sensibilité en conséquence.

4. **`formatRelativeTime` est une heuristique** — elle utilise `Date.now()` ce qui signifie que les labels relatifs changent à chaque appel. C'est voulu : quand le LLM lit « 5s ago » vs « 2m ago », il a une intuition de l'urgence relative. Si les tests ont besoin de stabilité, mocker `Date.now()`.

5. **Le journal est synchrone** — `record()` est O(1) (avec amortissement pour l'éviction). Aucun appel async, aucun appel LLM. Il peut être appelé dans des paths synchrones (handlers d'événements) sans risque.

6. **Le choix de `maxEntriesInPrompt = 8`** est un compromis. Avec ~200 chars par entrée formatée, 8 entrées = ~1600 chars ≈ 400 tokens. C'est environ 5-10% du budget typique d'un prompt de sharing (4000-8000 tokens). Suffisant pour le contexte, pas assez pour dominer le prompt. Cette valeur peut être ajustée en config.

7. **Le journal ne persiste pas entre les exécutions** — le broker est recréé, le notification engine est nettoyé dans le `finally`. Si la persistance inter-exécution est souhaitée (évolution 21), le journal pourrait être sérialisé/désérialisé, mais ce n'est pas le scope de cette évolution.

8. **Ne pas ajouter de journal au planner** — le planner a déjà un résumé glissant (évolution 13) qui remplit un rôle similaire. Ajouter un journal au planner serait redondant. Les journaux sont spécifiques aux évaluations de delta (sharing et notification) qui sont les processus les plus fréquents et les plus impactés par l'absence de mémoire.

9. **Les convenience methods `recordSharingDecision` et `recordNotificationDecision`** sont préférées à l'appel direct de `record()` car elles encapsulent la construction de l'entrée. Si le format évolue, un seul endroit à modifier. Les appelants (broker, notification engine) n'ont pas à connaître la structure interne de `DecisionJournalEntry`.

10. **Impact sur le prompt `batched-sharing-decision.ts`** — la section journal est ajoutée via la variable Handlebars `{{decisionJournal}}` qui contient le texte pré-formaté par `toPromptSection()`. Ce n'est PAS un loop Handlebars — c'est un block de texte brut injecté. Si dans le futur on veut un formatage Handlebars plus fin, utiliser `toTemplateData()` à la place et un loop `{{#each}}`.

11. **Ordre des sections dans le prompt** — le journal est placé AVANT les données du delta et des targets. C'est intentionnel : le LLM doit d'abord lire son « historique mental » avant d'évaluer la nouvelle situation. C'est similaire au « chain-of-thought » prompting où le contexte précède la question.

12. **Le `DecisionJournal` pourrait être utile pour l'évolution 15 (checkpoints mid-execution)** — les stats du journal (`approvalRate`, `countRecentDecisions`) sont des signaux utiles pour décider si un checkpoint de réflexion est justifié. Par exemple, un taux d'approbation qui chute brutalement pourrait déclencher un checkpoint. Ce n'est pas implémenté ici mais les données sont disponibles.