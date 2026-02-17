# Évolution 07 — Partage des résultats complets de prompt (pas juste 500 chars)

## Priorité : 🟠 P1-P2

## Dépendances : Évolution 01 (Fix agent-subtask mapping), Évolution 02 (Sharing deduplication)

## Acquis des évolutions précédentes

- **Évolution 01** : L'`InformationBroker` reçoit les mappings `subtaskToAgent` / `agentToSubtask` via son constructeur. `isAgentForSubtask()` fonctionne. Le tri des candidats par dépendance est opérationnel. `findDependency()` traduit correctement entre agent IDs et subtask IDs.
- **Évolution 02** : L'`InformationBroker` maintient un `SharingHistory` indexé par agent cible. Le prompt de partage inclut les partages précédents (`previouslyShared`). `recordSharing()` est appelé après chaque injection réussie. Le type `SharingRecord` existe dans `agent-pool.types.ts`.
- **Évolution 03** : Le `ProjectScanner` scanne le répertoire de travail et produit un `ProjectContext`. Le planner reçoit le contexte projet.
- **Évolution 04** : Tous les prompts LLM contiennent des exemples few-shot contrastifs.
- **Évolution 05** : Le rôle `ConversationRole.SHARING_ANALYZER` existe. Le system prompt `SHARING_ANALYZER` est dédié au partage inter-agents. L'`InformationBroker` utilise `SHARING_ANALYZER`.
- **Évolution 06** : Le notification prompt est nettoyé (plus de vérifications redondantes). Le summary prompt inclut les `CoordinationStats` et les `sharingSummaries`. `durationMs` est correctement calculé.

---

## Contexte du problème

Quand un agent termine un prompt, le `ContextTracker` capture l'événement `PROMPT_COMPLETE` et crée un `ContextDelta`. Cependant, les données incluses dans le delta sont **drastiquement tronquées** :

```typescript
// src/classes/agent-pool/context-tracker.ts — extractRelevantData(), ligne ~411
case AgentEvent.PROMPT_COMPLETE:
    return {
        stopReason: payload.stopReason,
        responsePreview:
            typeof payload.fullText === "string"
                ? payload.fullText.slice(0, 500)  // ← Seulement 500 caractères !
                : undefined,
        responseLength:
            typeof payload.fullText === "string" ? payload.fullText.length : 0,
        usage: payload.usage,
    };
```

### Pourquoi 500 caractères est insuffisant

1. **Les réponses d'agents sont typiquement 2000-20000+ caractères** — 500 chars ne couvre souvent que l'introduction ou les premières lignes de code, pas le contenu actionnable.

2. **L'`InformationBroker` reçoit cette data tronquée dans le prompt LLM** — quand le broker évalue si l'info doit être partagée, le LLM ne voit que les 500 premiers caractères de la réponse de l'agent source. Il ne peut pas juger de la pertinence de l'information complète.

3. **Le champ `information` généré par le LLM de sharing est limité** par ce qu'il voit — si le LLM ne voit que « Created a REST API with the following endpoints: GET /users... » (tronqué), il ne peut pas distiller les détails des endpoints suivants (POST, PUT, DELETE) dans le message de partage.

4. **Les dépendances `blocking` sont les plus impactées** — quand un agent termine un subtask dont un autre dépend, le résultat complet est critique. Un agent `test-writer` qui attend les résultats de l'agent `api-developer` ne recevra qu'un preview de 500 chars de l'API implémentée.

### Les `promptResults` existent mais ne sont jamais exploités

Le `ContextTracker` stocke séparément les résultats complets des prompts :

```typescript
// src/classes/agent-pool/context-tracker.ts — recordPromptResult()
recordPromptResult(agentId: string, result: PromptResult): void {
    const state = this.agents.get(agentId);
    if (!state) return;
    state.promptResults.push(result);  // ← Le résultat COMPLET est stocké ici
}
```

Et dans `AgentContextState` :

```typescript
// src/types/agent-pool.types.ts — AgentContextState
/** Results from completed prompts. */
promptResults: PromptResult[];
```

Ces `promptResults` contiennent le texte **complet** de chaque réponse d'agent. Mais l'`InformationBroker` ne les utilise jamais — il se base uniquement sur les `ContextDelta` qui ne contiennent que le preview de 500 chars.

### Ampleur du problème

Dans une exécution multi-agent typique avec 3 agents et des dépendances, chaque agent produit 1-3 prompt results. Le broker évalue chaque delta `PROMPT_COMPLETE` pour le partage mais ne voit jamais le contenu réel. C'est comme essayer de décider quoi traduire d'un livre en ne lisant que la première page.

---

## Fichiers impactés

| Fichier | Action |
|---------|--------|
| `src/classes/agent-pool/context-tracker.ts` | Augmenter le preview et ajouter un résumé LLM-generated pour les gros résultats |
| `src/classes/agent-pool/information-broker.ts` | Utiliser les `promptResults` complets pour les évaluations de partage sur dépendances blocking |
| `src/classes/agent-pool/agent-pool.ts` | Déclencher un partage enrichi quand un subtask avec dépendances blocking termine |
| `src/types/agent-pool.types.ts` | Ajouter le champ `promptResultSummary` dans `ContextDelta` |
| `src/prompts/batched-sharing-decision.ts` | Enrichir le prompt pour inclure plus de contenu quand disponible |
| `src/classes/agent-pool/tests/` | Tests unitaires |

---

## Spécification détaillée des changements

### 1. Augmenter le preview dans `extractRelevantData()`

Dans `src/classes/agent-pool/context-tracker.ts`, augmenter le preview pour `PROMPT_COMPLETE` :

```typescript
case AgentEvent.PROMPT_COMPLETE:
    return {
        stopReason: payload.stopReason,
        responsePreview:
            typeof payload.fullText === "string"
                ? payload.fullText.slice(0, 2000)  // ← Augmenté de 500 à 2000
                : undefined,
        responseLength:
            typeof payload.fullText === "string" ? payload.fullText.length : 0,
        usage: payload.usage,
        isComplete:
            typeof payload.fullText === "string"
                ? payload.fullText.length <= 2000  // ← Indique si le preview est complet
                : false,
    };
```

**Justification** : 2000 caractères couvrent typiquement la description des endpoints d'une API, les signatures de fonctions, ou le résumé d'une architecture. C'est le bon compromis entre exhaustivité et taille de prompt.

### 2. Ajouter un champ `promptResultSummary` dans `ContextDelta`

Le preview de 2000 chars est suffisant pour beaucoup de cas, mais les réponses très longues (10000+ chars, ex: un agent qui écrit un fichier complet) perdent encore des informations. Pour ces cas, on ajoute un résumé dédié.

Dans `src/types/agent-pool.types.ts`, dans l'interface `ContextDelta` :

```typescript
export interface ContextDelta {
    /** The agent that produced this delta. */
    readonly agentId: string;
    /** The agent's human-friendly name. */
    readonly agentName: string;
    /** ISO-8601 timestamp of the delta. */
    readonly timestamp: string;
    /** Classified type of the change. */
    readonly type: DeltaType;
    /** Human-readable summary of the change. */
    readonly summary: string;
    /** Structured data specific to this delta type. */
    readonly data: Record<string, unknown>;
    /** Estimated significance of this delta (0.0 to 1.0). */
    readonly significance: number;

    /**
     * For PROMPT_COMPLETE deltas: a structured summary of the agent's response,
     * extracted to provide more context than the truncated responsePreview.
     *
     * This field is populated for prompt completions where the full response
     * exceeds the preview limit, giving downstream consumers (like the
     * InformationBroker) enough context to make informed sharing decisions.
     *
     * `null` for non-PROMPT_COMPLETE deltas or when the preview is already complete.
     */
    readonly promptResultSummary: string | null;
}
```

### 3. Construire le `promptResultSummary` dans le `ContextTracker`

Modifier la méthode `processEvent()` dans `context-tracker.ts` pour construire le résumé quand un `PROMPT_COMPLETE` event arrive et que le texte dépasse le preview :

```typescript
processEvent(
    agentId: string,
    event: string,
    payload: Record<string, unknown>,
): ContextDelta | null {
    const state = this.agents.get(agentId);
    if (!state) return null;

    const contextEvent = this.buildContextEvent(event, payload);
    state.events.push(contextEvent);

    if (state.events.length > MAX_EVENTS_PER_AGENT) {
        state.events = state.events.slice(-MAX_EVENTS_PER_AGENT);
    }

    this.updateDerivedState(state, event, payload);

    const mapping = EVENT_SIGNIFICANCE.get(event);
    if (!mapping) return null;

    // Build prompt result summary for PROMPT_COMPLETE events
    let promptResultSummary: string | null = null;
    if (event === AgentEvent.PROMPT_COMPLETE && typeof payload.fullText === "string") {
        const fullText = payload.fullText;
        if (fullText.length > PROMPT_RESULT_PREVIEW_LENGTH) {
            promptResultSummary = this.buildPromptResultSummary(fullText);
        }
    }

    const delta: ContextDelta = {
        agentId: state.agentId,
        agentName: state.agentName,
        timestamp: contextEvent.timestamp,
        type: mapping.deltaType,
        summary: contextEvent.summary,
        data: contextEvent.data,
        significance: mapping.significance,
        promptResultSummary,  // ← NOUVEAU
    };

    state.lastDelta = delta;
    return delta;
}
```

#### Extraire le preview length en constante

```typescript
/**
 * Maximum length of the response preview in delta data.
 * Responses longer than this are summarized in `promptResultSummary`.
 */
const PROMPT_RESULT_PREVIEW_LENGTH = 2000;
```

#### Méthode `buildPromptResultSummary()`

Cette méthode extrait les points saillants d'une longue réponse d'agent **sans appel LLM** (pour ne pas bloquer le processus d'événements) :

```typescript
/**
 * Builds a structured summary of a long prompt result.
 *
 * Uses heuristic extraction (no LLM call) to identify key elements:
 * - File paths mentioned
 * - Function/class/endpoint names
 * - Key decisions or conclusions
 * - Error messages if present
 *
 * This is intentionally fast and imperfect — the goal is to provide
 * enough context for the sharing LLM to make informed decisions,
 * not to produce a polished summary.
 *
 * @param fullText - The complete agent response text.
 * @returns A structured summary string, limited to ~1000 chars.
 */
private buildPromptResultSummary(fullText: string): string {
    const MAX_SUMMARY_LENGTH = 1500;
    const sections: string[] = [];

    // 1. Extract file paths mentioned (common patterns)
    const filePaths = this.extractFilePaths(fullText);
    if (filePaths.length > 0) {
        sections.push(`Files: ${filePaths.slice(0, 10).join(", ")}`);
    }

    // 2. Extract the first and last ~500 chars as bookends
    // (Introduction usually states what was done, conclusion summarizes)
    const intro = fullText.slice(0, 500).trim();
    const outro = fullText.slice(-500).trim();

    sections.push(`Start: ${intro}`);
    if (fullText.length > 1000) {
        sections.push(`End: ${outro}`);
    }

    // 3. Total length info
    sections.push(`Total response: ${fullText.length} chars`);

    const summary = sections.join("\n\n");
    return summary.length > MAX_SUMMARY_LENGTH
        ? summary.slice(0, MAX_SUMMARY_LENGTH) + "…"
        : summary;
}

/**
 * Extracts file paths from agent response text.
 * Looks for common patterns like `src/foo/bar.ts`, `./config.json`, etc.
 */
private extractFilePaths(text: string): string[] {
    // Match paths like src/foo.ts, ./config.json, /home/user/file.py
    const pathPattern = /(?:\.\/|src\/|lib\/|app\/|tests?\/|config\/|public\/|docs?\/|scripts?\/)\S+\.\w{1,10}/g;
    const matches = text.match(pathPattern) ?? [];

    // Deduplicate
    return [...new Set(matches)].slice(0, 15);
}
```

### 4. Enrichir le prompt de sharing avec le `promptResultSummary`

Dans `src/prompts/batched-sharing-decision.ts`, ajouter le résumé quand il est disponible :

```handlebars
## Delta (new information)
- **Type**: {{delta.type}}
- **Summary**: {{delta.summary}}
- **Data**:
{{json delta.data}}
{{#if delta.promptResultSummary}}

### Extended Response Summary
The agent's full response was {{delta.responseLength}} characters. Here is an extracted summary of the key content:

<response_summary>
{{delta.promptResultSummary}}
</response_summary>
{{/if}}
```

### 5. Passer le `promptResultSummary` au prompt dans `InformationBroker.evaluateBatch()`

Dans `src/classes/agent-pool/information-broker.ts`, dans `evaluateBatch()`, enrichir les données du delta passées au template :

```typescript
private async evaluateBatch(
    delta: ContextDelta,
    sourceState: AgentContextState,
    targetStates: AgentContextState[],
): Promise<SharingDecision[]> {
    const targets = targetStates.map((targetState) => {
        // ... existing target building ...
    });

    const prompt = batchedSharingDecisionPrompt({
        sourceAgent: {
            agentId: sourceState.agentId,
            agentName: sourceState.agentName,
            taskDescription: sourceState.taskDescription,
            taskRole: sourceState.taskRole,
            status: sourceState.status,
        },
        delta: {
            type: delta.type,
            summary: delta.summary,
            data: delta.data,
            promptResultSummary: delta.promptResultSummary ?? null,  // ← NOUVEAU
            responseLength: typeof delta.data.responseLength === "number"
                ? delta.data.responseLength
                : null,  // ← NOUVEAU
        },
        targets,
    });

    // ... rest unchanged
}
```

### 6. Partage enrichi pour les dépendances blocking

Quand un agent qui a des dépendances `blocking` sur lui termine, le résultat complet (pas juste le delta) devrait être disponible pour l'évaluation de partage.

Ajouter une nouvelle méthode dans `InformationBroker` pour les cas de blocking completion :

```typescript
/**
 * Evaluates sharing for a completed prompt result, with access to the
 * full result text. This is called specifically for PROMPT_COMPLETE
 * deltas where the source agent has blocking dependents.
 *
 * Unlike the standard `evaluate()` which only sees the delta preview,
 * this method includes the full prompt result (or a substantial portion)
 * in the LLM prompt, enabling more accurate distillation of the
 * information to share.
 *
 * @param delta - The PROMPT_COMPLETE delta.
 * @param fullResultText - The full text of the agent's response.
 * @returns Sharing decisions with richer `information` fields.
 */
async evaluateWithFullResult(
    delta: ContextDelta,
    fullResultText: string,
): Promise<SharingDecision[]> {
    // Check if this agent has any blocking dependents
    const sourceSubtaskId = this.agentToSubtask.get(delta.agentId);
    if (!sourceSubtaskId) {
        // No subtask mapping — fall back to standard evaluate
        return this.evaluate(delta);
    }

    const hasBlockingDependents = this.dependencies.some(
        dep => dep.from === sourceSubtaskId && dep.type === "blocking"
    );

    if (!hasBlockingDependents) {
        // No blocking dependents — standard evaluation is fine
        return this.evaluate(delta);
    }

    // For blocking dependents, create an enriched delta with more content
    const enrichedDelta: ContextDelta = {
        ...delta,
        data: {
            ...delta.data,
            // Replace the truncated preview with more content
            responsePreview: fullResultText.slice(0, 5000),
            responseLength: fullResultText.length,
            isComplete: fullResultText.length <= 5000,
        },
        promptResultSummary: delta.promptResultSummary
            ?? this.buildQuickSummary(fullResultText),
    };

    return this.evaluate(enrichedDelta);
}

/**
 * Builds a quick summary of a long text for sharing evaluation.
 * Used as fallback when promptResultSummary is not available.
 */
private buildQuickSummary(text: string): string {
    if (text.length <= 2000) return text;

    const intro = text.slice(0, 800);
    const outro = text.slice(-800);
    return `${intro}\n\n[...${text.length - 1600} chars omitted...]\n\n${outro}`;
}
```

### 7. Appeler `evaluateWithFullResult` depuis `AgentPool.handleDelta()`

Dans `src/classes/agent-pool/agent-pool.ts`, dans `handleDelta()`, utiliser la méthode enrichie pour les `PROMPT_COMPLETE` :

```typescript
private async handleDelta(delta: ContextDelta): Promise<void> {
    try {
        // ── Information Sharing ─────────────────────────────────────
        if (this.informationBroker && this.contextTracker.agentCount > 1) {
            let decisions: SharingDecision[];

            // For PROMPT_COMPLETE deltas, use the full result if available
            if (delta.type === DeltaType.PROMPT_COMPLETE) {
                const agentState = this.contextTracker.getAgentState(delta.agentId);
                const lastPromptResult = agentState?.promptResults.at(-1);

                if (lastPromptResult?.text) {
                    decisions = await this.informationBroker.evaluateWithFullResult(
                        delta,
                        lastPromptResult.text,
                    );
                } else {
                    decisions = await this.informationBroker.evaluate(delta);
                }
            } else {
                decisions = await this.informationBroker.evaluate(delta);
            }

            for (const decision of decisions) {
                this._sharingDecisionCount++;
                this.emitPoolEvent(PoolEvent.SHARING_DECISION, { decision });

                if (decision.shouldShare) {
                    // ... existing injection code unchanged ...
                }
            }
        }

        // ── Notification Engine ────────────────────────────────────
        // ... unchanged ...
    } catch (error) {
        // ... unchanged ...
    }
}
```

### 8. Mise à jour de la construction de `ContextDelta` pour les deltas existants

Tous les deltas existants (non-PROMPT_COMPLETE) doivent avoir `promptResultSummary: null` pour respecter la nouvelle interface. Modifier la construction du delta dans `processEvent()` :

Le changement est déjà couvert par le point 3 ci-dessus — le `promptResultSummary` est initialisé à `null` et n'est peuplé que pour les `PROMPT_COMPLETE` events qui dépassent le preview.

### 9. Augmenter le `maxTokens` pour les évaluations de blocking deps

Dans `evaluateBatch()`, quand on sait que c'est un prompt complet avec des dependants blocking, augmenter le budget de tokens pour que le LLM ait assez d'espace pour distiller l'information complète :

```typescript
const effectiveMaxTokens = delta.promptResultSummary
    ? 500 * targetStates.length  // Plus de tokens pour des réponses riches
    : 300 * targetStates.length; // Standard

const batchDecisions = await this.conversations.sendOneShotJson(
    ConversationRole.SHARING_ANALYZER,
    prompt,
    validateBatchedSharingDecision,
    { maxTokens: effectiveMaxTokens, maxJsonAttempts: 2 },
);
```

---

## Gestion de la taille du prompt

L'augmentation du preview et l'ajout du `promptResultSummary` augmentent la taille du prompt envoyé au broker. Mesures de protection :

### Budget tokens estimé par évaluation de partage

| Composant | Avant | Après |
|-----------|-------|-------|
| `responsePreview` dans `delta.data` | 500 chars (~125 tokens) | 2000 chars (~500 tokens) |
| `promptResultSummary` | N/A | ~1500 chars (~375 tokens) |
| Extended response pour blocking deps | N/A | ~5000 chars (~1250 tokens) |

### Cas typique (non-blocking)

Augmentation de ~750 tokens par évaluation de partage. Avec 5-10 évaluations par exécution multi-agent, c'est ~3750-7500 tokens supplémentaires au total. Acceptable.

### Cas blocking dependency

Augmentation de ~1250 tokens pour l'évaluation enrichie. Ce cas est rare (typiquement 1-2 fois par exécution) et le plus critique — le budget supplémentaire est justifié.

### Garde-fous

1. **`PROMPT_RESULT_PREVIEW_LENGTH = 2000`** — le preview standard est capé
2. **`MAX_SUMMARY_LENGTH = 1500`** dans `buildPromptResultSummary()` — le résumé est capé
3. **`fullResultText.slice(0, 5000)`** dans `evaluateWithFullResult()` — même en mode enrichi, on ne passe pas plus de 5000 chars de texte brut
4. **`isComplete` flag** — indique au LLM si le preview est complet ou tronqué, pour qu'il sache s'il a toute l'info

---

## Tests à implémenter

### Tests unitaires pour `ContextTracker`

#### Test 1 : `extractRelevantData` retourne un preview de 2000 chars pour PROMPT_COMPLETE

- Setup : créer un payload avec `fullText` de 5000 caractères
- Appeler `processEvent()` avec `AgentEvent.PROMPT_COMPLETE`
- Assert : `delta.data.responsePreview.length` === 2000
- Assert : `delta.data.isComplete` === `false`

#### Test 2 : `extractRelevantData` marque `isComplete: true` si le texte est court

- Setup : créer un payload avec `fullText` de 1500 caractères
- Appeler `processEvent()` avec `AgentEvent.PROMPT_COMPLETE`
- Assert : `delta.data.responsePreview.length` === 1500
- Assert : `delta.data.isComplete` === `true`

#### Test 3 : `promptResultSummary` est `null` pour les textes courts

- Setup : `fullText` de 1500 chars (< `PROMPT_RESULT_PREVIEW_LENGTH`)
- Assert : `delta.promptResultSummary` === `null`

#### Test 4 : `promptResultSummary` est construit pour les textes longs

- Setup : `fullText` de 10000 chars contenant des file paths comme `src/routes/users.ts`
- Assert : `delta.promptResultSummary` !== `null`
- Assert : `delta.promptResultSummary` contient `"src/routes/users.ts"` (extrait des file paths)
- Assert : `delta.promptResultSummary` contient les premiers ~500 chars du texte (intro)
- Assert : `delta.promptResultSummary` contient les derniers ~500 chars du texte (outro)
- Assert : `delta.promptResultSummary.length` ≤ 1500

#### Test 5 : `promptResultSummary` est `null` pour les deltas non-PROMPT_COMPLETE

- Setup : émettre un `AgentEvent.TOOL_COMPLETE`
- Assert : `delta.promptResultSummary` === `null`

#### Test 6 : `extractFilePaths` extrait correctement les chemins

- Input : texte contenant `src/routes/users.ts`, `./config.json`, `tests/api.test.ts`
- Assert : retourne `["src/routes/users.ts", "./config.json", "tests/api.test.ts"]`
- Assert : pas de doublons
- Assert : limité à 15 chemins max

#### Test 7 : `extractFilePaths` ne retourne pas de faux positifs

- Input : texte contenant `"this.users"`, `http://example.com`, `version 1.0`
- Assert : retourne un tableau vide (ou sans ces faux positifs)

#### Test 8 : `buildPromptResultSummary` respecte `MAX_SUMMARY_LENGTH`

- Input : un texte très long (50000 chars) avec beaucoup de file paths
- Assert : le résumé fait ≤ 1500 chars

### Tests unitaires pour `InformationBroker`

#### Test 9 : `evaluateWithFullResult` utilise le standard evaluate pour les non-blocking deps

- Setup : créer un broker avec des dépendances uniquement `informational`
- Appeler `evaluateWithFullResult(delta, fullText)` pour un agent sans blocking dependents
- Assert : le comportement est identique à `evaluate(delta)` (pas d'enrichissement)

#### Test 10 : `evaluateWithFullResult` enrichit le delta pour les blocking deps

- Setup : créer un broker avec une dépendance `blocking` depuis l'agent source
- Mocker `sendOneShotJson` pour capturer le prompt
- Appeler `evaluateWithFullResult(delta, fullText)` avec `fullText` de 10000 chars
- Assert : le prompt envoyé au LLM contient un `responsePreview` de 5000 chars (pas 2000)
- Assert : le prompt contient un `promptResultSummary`

#### Test 11 : `evaluateWithFullResult` retourne des décisions normalement

- Setup : mocker le LLM pour retourner une décision de partage positive
- Assert : les décisions retournées sont conformes à `SharingDecision[]`
- Assert : `shouldShare`, `reasoning`, `information` sont correctement remplis

#### Test 12 : `buildQuickSummary` fonctionne comme fallback

- Input : texte de 5000 chars, `delta.promptResultSummary` est `null`
- Assert : un résumé est généré avec intro/outro et un indicateur de longueur omise

### Tests d'intégration

#### Test 13 : `AgentPool.handleDelta()` utilise `evaluateWithFullResult` pour PROMPT_COMPLETE

- Mocker l'`InformationBroker` avec les deux méthodes (`evaluate` et `evaluateWithFullResult`)
- Simuler un delta `PROMPT_COMPLETE` avec un `promptResult` disponible dans le `contextTracker`
- Assert : `evaluateWithFullResult` est appelé (pas `evaluate`)
- Assert : le `fullResultText` passé correspond au texte du dernier `promptResult`

#### Test 14 : `AgentPool.handleDelta()` utilise `evaluate` standard pour les autres delta types

- Simuler un delta `TOOL_COMPLETE`
- Assert : `evaluate` standard est appelé (pas `evaluateWithFullResult`)

#### Test 15 : Le prompt de sharing inclut le `promptResultSummary` quand disponible

- Mocker `sendOneShotJson` pour capturer le prompt
- Passer un delta avec `promptResultSummary` non-null
- Assert : le prompt contient `"### Extended Response Summary"`
- Assert : le prompt contient le contenu du summary dans des balises `<response_summary>`

#### Test 16 : Le prompt de sharing n'inclut PAS le summary quand il est null

- Passer un delta avec `promptResultSummary: null`
- Assert : le prompt ne contient PAS `"### Extended Response Summary"`

#### Test 17 : Le `maxTokens` est augmenté quand un `promptResultSummary` est présent

- Mocker `sendOneShotJson` pour capturer les options
- Passer un delta avec `promptResultSummary` non-null et 3 targets
- Assert : `maxTokens` est `500 * 3 = 1500` (pas `300 * 3 = 900`)

### Tests de non-régression

#### Test 18 : Les deltas non-PROMPT_COMPLETE sont inchangés

- Émettre des événements `TOOL_COMPLETE`, `TOOL_FAILED`, `FS_WRITE`, `AGENT_ERROR`
- Assert : chaque delta a `promptResultSummary: null`
- Assert : les données dans `delta.data` sont identiques à avant (pas de nouveau champ inattendu)

#### Test 19 : La déduplication (évolution 02) fonctionne toujours avec les deltas enrichis

- Simuler un premier partage (enregistré via `recordSharing`)
- Simuler un deuxième delta `PROMPT_COMPLETE` depuis le même agent source
- Assert : le prompt de sharing inclut toujours `previouslyShared` pour le target
- Assert : la déduplication ne bloque pas les partages de contenu réellement nouveau

---

## Critères de validation

- [ ] Le preview dans `extractRelevantData` pour `PROMPT_COMPLETE` est augmenté de 500 à 2000 caractères
- [ ] Le champ `isComplete` est ajouté dans les data de delta pour `PROMPT_COMPLETE`
- [ ] Le champ `promptResultSummary` est ajouté dans l'interface `ContextDelta`
- [ ] Le `promptResultSummary` est construit automatiquement pour les réponses > 2000 chars
- [ ] Le `promptResultSummary` est `null` pour les deltas non-PROMPT_COMPLETE et les réponses courtes
- [ ] Le `buildPromptResultSummary()` extrait les file paths, l'intro et l'outro du texte
- [ ] Le `buildPromptResultSummary()` est limité à 1500 caractères
- [ ] Le `extractFilePaths()` détecte les chemins de fichiers courants sans faux positifs excessifs
- [ ] La méthode `evaluateWithFullResult()` existe dans `InformationBroker`
- [ ] `evaluateWithFullResult()` enrichit le delta avec un preview de 5000 chars pour les blocking deps
- [ ] `evaluateWithFullResult()` délègue à `evaluate()` standard pour les non-blocking deps
- [ ] `AgentPool.handleDelta()` utilise `evaluateWithFullResult()` pour les `PROMPT_COMPLETE`
- [ ] Le prompt de sharing inclut le `promptResultSummary` quand disponible (section `### Extended Response Summary`)
- [ ] Le `maxTokens` du sharing LLM est augmenté quand un `promptResultSummary` est présent
- [ ] Aucune régression sur les deltas non-PROMPT_COMPLETE
- [ ] La déduplication de l'évolution 02 fonctionne avec les deltas enrichis
- [ ] Tous les tests existants passent toujours

---

## Points d'attention

1. **`buildPromptResultSummary` est heuristique, pas LLM-driven** — on ne fait PAS d'appel LLM dans le ContextTracker. Le tracker est synchrone (ou très rapide) et ne doit pas bloquer le flux d'événements. L'extraction de file paths et le bookending (intro + outro) sont des heuristiques suffisantes pour donner du contexte au LLM de sharing qui, lui, fait le vrai travail d'analyse.

2. **Le preview de 5000 chars dans `evaluateWithFullResult()` est un maximum** — pour les réponses plus courtes, le texte complet est passé. Le but n'est pas de toujours tronquer, mais de capguarder les cas extrêmes (agents qui écrivent des fichiers de 50000+ chars).

3. **Le champ `promptResultSummary` dans `ContextDelta` casse la backward compatibility du type** — tous les endroits qui créent un `ContextDelta` doivent inclure ce champ. Vérifier qu'il n'y a pas d'autres créations de `ContextDelta` en dehors de `ContextTracker.processEvent()`. Si oui, ajouter `promptResultSummary: null` à chaque endroit.

4. **Les `promptResults` dans `AgentContextState` sont accédés via `agentState?.promptResults.at(-1)`** — la méthode `.at(-1)` retourne le dernier élément. S'assurer que le timing est correct : `recordPromptResult()` est appelé dans `executeSubtasks()` APRÈS `agent.prompt()` retourne, et `handleDelta()` est appelé de manière asynchrone (fire-and-forget) quand le delta `PROMPT_COMPLETE` est émis. Il faut vérifier que `recordPromptResult()` a déjà été appelé au moment où `handleDelta()` accède à `promptResults.at(-1)`.

   **Risque de race condition** : le delta `PROMPT_COMPLETE` est émis par l'agent via l'event `AgentEvent.PROMPT_COMPLETE`, qui est émis DANS `agent.prompt()` AVANT que `prompt()` retourne. Donc `recordPromptResult()` est appelé APRÈS le delta. Le `handleDelta()` est fire-and-forget (`void this.handleDelta(delta)`), mais il est asynchrone (fait un appel LLM). Normalement, au moment où le LLM répond (~1-3s plus tard), `recordPromptResult()` a déjà été appelé. Mais pour être sûr, ajouter un guard :

   ```typescript
   if (delta.type === DeltaType.PROMPT_COMPLETE) {
       // Small delay to ensure recordPromptResult has been called
       await new Promise(resolve => setTimeout(resolve, 50));
       const agentState = this.contextTracker.getAgentState(delta.agentId);
       const lastPromptResult = agentState?.promptResults.at(-1);
       // ...
   }
   ```

   Alternativement, restructurer `executeSubtasks()` pour appeler `recordPromptResult()` AVANT le delta est émis, mais cela nécessiterait de modifier la séquence d'événements dans `Agent.prompt()`, ce qui est hors scope.

5. **Le regex `extractFilePaths` est volontairement restrictif** — il ne match que les chemins commençant par des préfixes courants (`src/`, `lib/`, `app/`, `tests/`, `./`, etc.). Cela évite les faux positifs comme les URLs ou les numéros de version. Des vrais file paths dans des locations non-standard seront manqués, mais c'est acceptable.

6. **L'augmentation du preview de 500 à 2000 impacte aussi le `summarizeEvent()`** — la méthode `summarizeEvent()` pour `PROMPT_COMPLETE` utilise `payload.fullText.length` pour reporter la taille, pas le preview. Pas d'impact.

7. **Les `TOOL_COMPLETE` et `TOOL_FAILED` gardent leurs previews existants** (300 et 500 chars respectivement). Ces types de deltas sont moins critiques pour le sharing — les outils produisent des outputs techniques (exit codes, logs) qui sont moins utiles bruts pour un autre agent. L'augmentation se concentre sur les `PROMPT_COMPLETE` qui contiennent le raisonnement et les artefacts créés par l'agent.

8. **Le `promptResultSummary` est stocké dans le delta mais pas dans l'`AgentContextState`** — c'est voulu. Le summary est éphémère, utile seulement pour l'évaluation de partage immédiate. Le `ContextTracker` ne le persiste pas au-delà du delta lui-même.

9. **Impact sur les prompts de l'évolution 04 (few-shot)** — les exemples dans le batched sharing prompt ne mentionnent pas `promptResultSummary`. Comme le champ est conditionnel (`{{#if delta.promptResultSummary}}`), les exemples restent valides — ils représentent le cas où le summary n'est pas présent. Pas besoin de modifier les exemples.

10. **Impact sur la déduplication (évolution 02)** — les partages enrichis (avec plus de contenu) devraient produire des `information` plus détaillées dans les `SharingDecision`. Ces informations plus longues seront tronquées à 200 chars dans le `SharingRecord.informationSummary` (évolution 02). C'est correct — le but du record est de donner au LLM assez de contexte pour éviter les doublons, pas de reproduire l'information complète.