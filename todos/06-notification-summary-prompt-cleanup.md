# Évolution 06 — Nettoyage des prompts Notification et Summary

## Priorité : 🟠 P1

## Dépendances : Évolution 05 (Séparation des prompts Context Analyzer)

## Acquis des évolutions précédentes

- **Évolution 01** : L'`InformationBroker` reçoit les mappings `subtaskToAgent` / `agentToSubtask` via son constructeur. `isAgentForSubtask()` fonctionne. Le tri des candidats par dépendance est opérationnel. `findDependency()` traduit correctement entre agent IDs et subtask IDs.
- **Évolution 02** : L'`InformationBroker` maintient un `SharingHistory` indexé par agent cible. Le prompt de partage inclut les partages précédents (`previouslyShared`). `recordSharing()` est appelé après chaque injection réussie. Le type `SharingRecord` existe.
- **Évolution 03** : Le `ProjectScanner` scanne le répertoire de travail et produit un `ProjectContext`. Le planner reçoit le contexte projet. Le system prompt du planner inclut une section `## Project Context Usage`.
- **Évolution 04** : Tous les prompts LLM contiennent des exemples few-shot contrastifs. Le summary system prompt a été restructuré avec des sections et un exemple complet. Les validateurs acceptent les JSON des exemples.
- **Évolution 05** : Le rôle `ConversationRole.SHARING_ANALYZER` existe. Le system prompt `CONTEXT_ANALYZER` est désormais spécialisé pour les notifications. Le system prompt `SHARING_ANALYZER` est dédié au partage inter-agents. L'action `clarify` a été retirée des deux prompts. L'`InformationBroker` utilise `SHARING_ANALYZER`, le `NotificationEngine` utilise `CONTEXT_ANALYZER`.

---

## Contexte du problème

Deux prompts du système ont des problèmes de qualité qui limitent l'efficacité des décisions LLM :

### Problème 1 : Le Notification Decision Prompt est redondant

Le prompt `notification-decision.ts` demande au LLM de re-vérifier des critères **déjà validés programmatiquement** par les pré-filtres du `NotificationEngine` :

```typescript
// src/classes/agent-pool/notification-engine.ts — evaluate()
// Filtre 2: Significance threshold (déjà vérifié avant l'appel LLM)
if (delta.significance < minSig) { return null; }

// Filtre 3: Type filter (déjà vérifié avant l'appel LLM)
if (this.preference.types && !this.preference.types.includes(delta.type)) { return null; }
```

Puis dans le prompt :

```handlebars
## Criteria
1. Does delta meet minimum significance?   ← Déjà vérifié !
2. Does delta type match user's interests?  ← Déjà vérifié !
3. Is this genuinely useful vs. noise?      ← Seul critère qui nécessite le LLM
```

Les critères 1 et 2 gaspillent de l'attention LLM sur des vérifications déjà faites. Le LLM devrait se concentrer uniquement sur l'évaluation sémantique.

### Problème 2 : Le prompt inclut des métadonnées inutiles pour la décision

Le prompt inclut la préférence complète de l'utilisateur (enabled, minSignificance, types) — information inutile puisque le LLM est appelé **uniquement** si les pré-filtres ont déjà passé. Montrer `enabled: true` et `minSignificance: 0.7` ne guide pas la décision sémantique.

### Problème 3 : Le Summary User Prompt manque de contexte de coordination

Le prompt `summary.ts` (user prompt `SUMMARY_SOURCE`) ne transmet aucune information sur :
- Les décisions de partage entre agents (combien, quoi, pourquoi)
- Les notifications générées
- Le coût en tokens / appels LLM
- Les problèmes de coordination rencontrés

Le résumé est donc purement une description des résultats individuels des agents, sans vue sur la **coordination**, qui est pourtant la valeur ajoutée du système AgentPool.

### Problème 4 : Le Summary User Prompt n'utilise pas la `durationMs`

Le champ `durationMs` est passé au template mais vaut toujours `0` au moment de l'appel :

```typescript
// src/classes/agent-pool/agent-pool.ts — generateSummary()
const prompt = summaryPrompt({
    task,
    strategy: analysis.strategy,
    complexity: analysis.complexity,
    planningReasoning: analysis.reasoning,
    agents: results,
    durationMs: 0, // ← Not known yet at this point
});
```

Le commentaire dit que la durée n'est pas encore connue. C'est vrai car le summary est généré en parallèle du cleanup. Soit passer la vraie durée (calculer avant l'appel summary), soit retirer le champ du template.

---

## Fichiers impactés

| Fichier | Action |
|---------|--------|
| `src/prompts/notification-decision.ts` | Réécrire le prompt pour supprimer les vérifications redondantes |
| `src/prompts/summary.ts` | Enrichir le user prompt avec les données de coordination |
| `src/classes/agent-pool/agent-pool.ts` | Passer les données de coordination au prompt summary + fixer `durationMs` |
| `src/classes/agent-pool/notification-engine.ts` | Adapter les données envoyées au prompt (retirer preference) |
| `src/types/agent-pool.types.ts` | Ajouter les types pour les stats de coordination dans le summary |
| `src/classes/agent-pool/tests/` | Tests pour les prompts modifiés |

---

## Spécification détaillée des changements

### 1. Réécrire le Notification Decision Prompt

Remplacer le contenu de `src/prompts/notification-decision.ts` :

**Ancien prompt** :

```handlebars
Determine if the user should be notified about this agent pool context change.

## User Preference
- **Enabled**: {{preference.enabled}}
- **Min Significance**: {{preference.minSignificance}}
{{#if preference.types}}- **Interested Types**: {{#each preference.types}}...{{/each}}
{{/if}}

## Delta
- **Agent**: {{delta.agentName}} ({{delta.agentId}})
- **Type**: {{delta.type}}
- **Summary**: {{delta.summary}}
- **Significance**: {{delta.significance}}

## Agent Task
{{agentTask}}

## Criteria
1. Does delta meet minimum significance?
2. Does delta type match user's interests (if specified)?
3. Is this genuinely useful vs. noise?

## JSON Output
{ "shouldNotify": true | false, "reasoning": "<why>", "message": "<notification message if shouldNotify is true>" }
```

**Nouveau prompt** :

```handlebars
This context delta has already passed significance ({{delta.significance}} ≥ threshold) and type filters. Your job is purely semantic: decide if this event is genuinely worth interrupting the user for, or if it's routine noise that passed the numeric filters but lacks real informational value.

## What Happened
**Agent**: {{delta.agentName}} (role: {{delta.agentRole}})
**Event**: {{delta.type}} — {{delta.summary}}
**Significance**: {{delta.significance}}

## Agent's Task
{{agentTask}}

{{#if otherAgentsContext}}
## Broader Context
{{otherAgentsContext}}
{{/if}}

## Decision Guide
Notify ONLY if this event represents:
- A meaningful milestone (subtask completion, all tests passing)
- An error the user should know about (missing dependency, permission issue, repeated failures)
- An unexpected or concerning outcome
- The final completion of the overall task or a major phase

Do NOT notify for:
- Routine progress that the user would expect
- Events the agent is handling autonomously
- Intermediate steps in a larger process

## JSON Output
{
  "shouldNotify": true | false,
  "reasoning": "<concise explanation of why this is or isn't worth the user's attention>",
  "message": "<clear, human-friendly notification — required if shouldNotify is true, empty string if false>"
}
```

#### Changements clés :

1. **Retiré la section `## User Preference`** — inutile car les filtres sont déjà passés
2. **Ajouté un framing clair** — « This delta has already passed filters. Your job is purely semantic. »
3. **Ajouté `delta.agentRole`** — plus informatif que l'agent ID pour le LLM
4. **Ajouté `otherAgentsContext`** (optionnel) — donne une vue d'ensemble pour contextualiser l'événement
5. **Remplacé les critères redondants** par un guide de décision sémantique
6. **Message de notification mieux cadré** — « clear, human-friendly notification »

### 2. Adapter le `NotificationEngine` pour le nouveau prompt

Dans `src/classes/agent-pool/notification-engine.ts`, méthode `evaluateWithLlm()`, adapter la construction du prompt :

```typescript
private async evaluateWithLlm(
    delta: ContextDelta,
    agentState: AgentContextState,
): Promise<UserNotification | null> {
    if (!this.preference) return null;

    // Build the notification decision prompt with the new template
    const prompt = notificationDecisionPrompt({
        delta: {
            agentName: delta.agentName,
            agentRole: agentState.taskRole,        // ← NOUVEAU
            type: delta.type,
            summary: delta.summary,
            significance: delta.significance,
        },
        agentTask: agentState.taskDescription,
        otherAgentsContext: null,  // ← NOUVEAU (optionnel, rempli si multi-agent context disponible)
    });

    // ... reste inchangé
}
```

**Note** : Le champ `otherAgentsContext` est `null` pour cette évolution. Il sera rempli dans une future évolution quand le `NotificationEngine` aura accès au `ContextTracker` pour récupérer l'état des autres agents. Pour l'instant, la section est simplement omise dans le prompt grâce au `{{#if otherAgentsContext}}`.

Le champ `agentRole` nécessite que le `NotificationEngine` ait accès à l'`AgentContextState`, ce qui est déjà le cas — l'état est passé en paramètre de `evaluate()` et transmis à `evaluateWithLlm()`.

### 3. Enrichir le Summary User Prompt avec les données de coordination

#### Nouveau type pour les stats de coordination

Dans `src/types/agent-pool.types.ts`, ajouter :

```typescript
/**
 * Statistics about cross-agent coordination during execution.
 * Used to enrich the execution summary with coordination context.
 */
export interface CoordinationStats {
    /** Number of context deltas detected across all agents. */
    readonly deltaCount: number;

    /** Number of sharing evaluations performed by the broker. */
    readonly sharingEvaluationCount: number;

    /** Number of positive sharing decisions (information actually shared). */
    readonly sharingApprovedCount: number;

    /** Number of notifications sent to the user. */
    readonly notificationCount: number;

    /**
     * Summary of information shared between agents.
     * Each entry describes a sharing event: source → target and what was shared.
     * Limited to the most significant sharing events.
     */
    readonly sharingSummaries: Array<{
        readonly sourceAgentName: string;
        readonly targetAgentName: string;
        readonly informationPreview: string;
    }>;
}
```

#### Modifier le template `SUMMARY_SOURCE`

Enrichir le prompt dans `src/prompts/summary.ts` :

```handlebars
Summarize this task execution.

## Task
<task>
{{task}}
</task>

## Strategy: {{strategy}} | Complexity: {{complexity}}
**Planning Reasoning**: {{planningReasoning}}

## Agent Results
{{#each agents}}
### {{this.agentName}} — {{this.subtask.role}}
- **Task**: {{truncate this.subtask.prompt 200}}
- **Success**: {{this.success}}{{#if this.error}} | **Error**: {{this.error}}{{/if}}
- **Response**: {{this.promptResult.text.length}} chars
{{#if this.filesWritten.length}}- **Files**: {{#each this.filesWritten}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}{{/if}}
{{#if this.events.length}}- **Events**: {{this.events.length}}{{/if}}

{{/each}}

{{#if coordination}}
## Inter-Agent Coordination
- **Deltas detected**: {{coordination.deltaCount}}
- **Sharing evaluations**: {{coordination.sharingEvaluationCount}}
- **Information shared**: {{coordination.sharingApprovedCount}} time(s)
- **User notifications**: {{coordination.notificationCount}}
{{#if coordination.sharingSummaries.length}}

### Information Flow
{{#each coordination.sharingSummaries}}
- **{{this.sourceAgentName}}** → **{{this.targetAgentName}}**: {{this.informationPreview}}
{{/each}}
{{/if}}
{{/if}}

**Agents**: {{agents.length}}

Provide a concise summary following the structure defined in your system prompt.
```

#### Changements clés du summary prompt :

1. **Ajouté la section `## Inter-Agent Coordination`** — statistiques de coordination et détails des partages
2. **Retiré `**Duration**: {{durationMs}}ms`** — car la valeur est toujours 0 au moment de l'appel (on la remet quand le bug sera fixé, voir ci-dessous)
3. **Ajouté l'instruction** « following the structure defined in your system prompt » — pour que le LLM utilise la structure définie dans le system prompt (sections Outcome, What was built, etc. de l'évolution 04)

### 4. Fixer le `durationMs` dans `generateSummary()`

Deux options pour le fix :

**Option A (recommandée)** : Calculer la durée avant le summary au lieu de paralléliser summary+cleanup

```typescript
// Dans execute(), Phase 4+5
const durationMs = Date.now() - startTime;  // ← Calculer AVANT le summary

const [summary] = await Promise.all([
    this.generateSummary(task, analysis, executionResults, durationMs),  // ← Passer la vraie durée
    this.destroyManagedAgents(),
]);
```

Modifier la signature de `generateSummary()` :

```typescript
private async generateSummary(
    task: string,
    analysis: TaskAnalysis,
    results: AgentExecutionResult[],
    durationMs: number,  // ← NOUVEAU
): Promise<string> {
```

Et le calcul final dans `execute()` :

```typescript
// La durée a déjà été calculée avant le summary
const poolResult: AgentPoolResult = {
    task,
    strategy: analysis.strategy,
    analysis,
    agents: executionResults,
    summary,
    durationMs,  // ← Utiliser la même valeur
};
```

**Note** : La durée calculée avant le summary sera légèrement inférieure à la durée totale (car elle exclut le temps du summary+cleanup), mais c'est plus honnête — la durée représente le temps d'exécution des agents, pas le temps de reporting.

Avec cette option, remettre `durationMs` dans le template summary :

```handlebars
**Duration**: {{durationMs}}ms | **Agents**: {{agents.length}}
```

**Option B** : Retirer `durationMs` du template et ne le reporter que dans `AgentPoolResult`. Moins propre mais plus simple.

→ **Choisir l'option A.**

### 5. Passer les stats de coordination à `generateSummary()`

Modifier `generateSummary()` pour accepter et transmettre les stats de coordination :

```typescript
private async generateSummary(
    task: string,
    analysis: TaskAnalysis,
    results: AgentExecutionResult[],
    durationMs: number,
    coordinationStats?: CoordinationStats,  // ← NOUVEAU
): Promise<string> {
    // ... (skip single-agent shortcut) ...

    const prompt = summaryPrompt({
        task,
        strategy: analysis.strategy,
        complexity: analysis.complexity,
        planningReasoning: analysis.reasoning,
        agents: results,
        durationMs,
        coordination: coordinationStats ?? null,  // ← NOUVEAU
    });

    // ... reste inchangé
}
```

Construire les `CoordinationStats` dans `execute()` avant l'appel au summary :

```typescript
// Build coordination stats for the summary
const coordinationStats: CoordinationStats | undefined =
    analysis.strategy === ExecutionStrategy.MULTI && this.informationBroker
        ? {
            deltaCount: this._deltaCount,
            sharingEvaluationCount: this.informationBroker.evaluationCount,
            sharingApprovedCount: this.informationBroker.shareCount,
            notificationCount: this.notificationEngine.notificationCount,
            sharingSummaries: this.buildSharingSummaries(),
        }
        : undefined;

const durationMs = Date.now() - startTime;

const [summary] = await Promise.all([
    this.generateSummary(task, analysis, executionResults, durationMs, coordinationStats),
    this.destroyManagedAgents(),
]);
```

### 6. Ajouter la méthode `buildSharingSummaries()` dans `AgentPool`

```typescript
/**
 * Builds a summary of sharing events for inclusion in the execution summary.
 * Returns the most recent sharing events, limited to avoid prompt bloat.
 */
private buildSharingSummaries(): CoordinationStats["sharingSummaries"] {
    if (!this.informationBroker) return [];

    const MAX_SHARING_SUMMARIES = 10;
    const summaries: CoordinationStats["sharingSummaries"] = [];

    // The sharing history is maintained by the InformationBroker (evolution 02).
    // We need to expose it or collect sharing events as they happen.
    // For now, we collect them from pool events emitted during execution.
    // This requires tracking sharing events in a local array.
    return this._sharingSummaries.slice(-MAX_SHARING_SUMMARIES);
}
```

**Note** : Ceci nécessite de maintenir un `_sharingSummaries` array dans la pool, peuplé dans `handleDelta()` quand un partage est effectué :

```typescript
// Dans handleDelta(), après le context share réussi :
if (decision.shouldShare) {
    // ... existing injection code ...

    // Track for summary
    this._sharingSummaries.push({
        sourceAgentName: sourceEntry?.agent.name ?? decision.sourceAgentId,
        targetAgentName: targetEntry.agent.name,
        informationPreview: decision.information.slice(0, 150),
    });
}
```

Ajouter le champ dans la classe :

```typescript
/** Sharing events collected for the execution summary. */
private _sharingSummaries: CoordinationStats["sharingSummaries"] = [];
```

Et le réinitialiser dans le `finally` de `execute()` :

```typescript
finally {
    // ... existing cleanup ...
    this._sharingSummaries = [];
}
```

---

## Tests à implémenter

### Tests unitaires pour le prompt Notification

#### Test 1 : Le nouveau notification prompt ne contient pas la section User Preference

- Appeler `notificationDecisionPrompt({...mockData})` avec des données de test
- Assert : le résultat ne contient PAS `"## User Preference"`
- Assert : le résultat ne contient PAS `"Enabled"` comme label de section
- Assert : le résultat ne contient PAS `"Min Significance"` comme label de section

#### Test 2 : Le nouveau notification prompt contient le framing sémantique

- Appeler `notificationDecisionPrompt({...mockData})` avec `delta.significance: 0.8`
- Assert : le résultat contient `"already passed significance"` ou `"already passed"` + le seuil
- Assert : le résultat contient `"purely semantic"` ou `"semantic"`
- Assert : le résultat contient `"## Decision Guide"`

#### Test 3 : Le prompt inclut le `agentRole`

- Appeler avec `delta.agentRole: "test-writer"`
- Assert : le résultat contient `"test-writer"` avec le label `"role:"`

#### Test 4 : La section `otherAgentsContext` est omise quand `null`

- Appeler avec `otherAgentsContext: null`
- Assert : le résultat ne contient PAS `"## Broader Context"`

#### Test 5 : La section `otherAgentsContext` est incluse quand fournie

- Appeler avec `otherAgentsContext: "2 other agents are active..."`
- Assert : le résultat contient `"## Broader Context"`
- Assert : le résultat contient `"2 other agents are active"`

### Tests unitaires pour le prompt Summary

#### Test 6 : Le summary prompt inclut la section coordination quand fournie

- Appeler `summaryPrompt({...mockData, coordination: { deltaCount: 15, sharingEvaluationCount: 8, sharingApprovedCount: 3, notificationCount: 2, sharingSummaries: [...] }})` 
- Assert : le résultat contient `"## Inter-Agent Coordination"`
- Assert : le résultat contient `"Deltas detected"` et `"15"`
- Assert : le résultat contient `"Information shared"` et `"3 time(s)"`
- Assert : le résultat contient `"### Information Flow"`

#### Test 7 : Le summary prompt omet la section coordination quand non fournie

- Appeler `summaryPrompt({...mockData, coordination: null})`
- Assert : le résultat ne contient PAS `"## Inter-Agent Coordination"`
- Assert : le résultat ne contient PAS `"### Information Flow"`

#### Test 8 : Le summary prompt inclut `durationMs` avec la vraie valeur

- Appeler avec `durationMs: 12345`
- Assert : le résultat contient `"12345ms"` ou `"12345"`
- Assert : le résultat ne contient PAS `"0ms"` (sauf si la durée est réellement 0)

#### Test 9 : Les sharingSummaries sont affichées avec le format source → target

- Appeler avec `sharingSummaries: [{ sourceAgentName: "api-dev", targetAgentName: "test-writer", informationPreview: "API endpoints..." }]`
- Assert : le résultat contient `"**api-dev** → **test-writer**"`
- Assert : le résultat contient `"API endpoints..."`

### Tests d'intégration

#### Test 10 : `NotificationEngine.evaluateWithLlm()` envoie les bonnes données au prompt

- Mocker `ConversationManager.sendOneShotJson()` pour capturer le prompt
- Appeler `engine.evaluate(delta, agentState)` avec un delta au-dessus du seuil
- Assert : le prompt capturé contient `agentState.taskRole` dans le champ `agentRole`
- Assert : le prompt capturé ne contient PAS `preference.enabled`

#### Test 11 : `AgentPool.generateSummary()` reçoit les `CoordinationStats` en multi-agent

- Mocker le `ConversationManager` et le `InformationBroker`
- Simuler une exécution multi-agent avec 2+ agents, 5 deltas, 2 partages
- Assert : `generateSummary()` est appelé avec des `CoordinationStats` non-nulles
- Assert : les stats contiennent les bonnes valeurs (deltaCount, sharingApprovedCount, etc.)

#### Test 12 : `AgentPool.generateSummary()` n'envoie pas de `CoordinationStats` en single-agent

- Simuler une exécution single-agent
- Assert : `generateSummary()` est appelé avec `coordinationStats: undefined`
- Assert : le summary ne contient pas la section coordination

#### Test 13 : `durationMs` est non-zéro dans le prompt summary

- Mocker l'exécution avec un délai artificiel (ex: `setTimeout` de 100ms)
- Assert : le `durationMs` passé au prompt est > 0
- Assert : le `durationMs` dans `AgentPoolResult` est cohérent (≥ celui du prompt)

#### Test 14 : Les `_sharingSummaries` sont collectées dans `handleDelta()`

- Mocker l'`InformationBroker` pour retourner `shouldShare: true` pour un delta
- Mocker l'agent cible pour que `injectContext()` réussisse
- Assert : `_sharingSummaries` contient un enregistrement avec les bonnes valeurs
- Assert : `informationPreview` est tronqué à 150 caractères

#### Test 15 : Les `_sharingSummaries` sont réinitialisées entre les exécutions

- Exécuter deux tâches successives avec des partages
- Assert : les summaries de la deuxième exécution ne contiennent pas celles de la première

---

## Critères de validation

- [ ] Le notification prompt ne contient plus la section `## User Preference`
- [ ] Le notification prompt ne demande plus au LLM de vérifier le seuil de significance ou le type filter
- [ ] Le notification prompt contient un framing clair indiquant que les filtres numériques sont déjà passés
- [ ] Le notification prompt inclut le `agentRole` pour contextualiser l'agent
- [ ] Le notification prompt supporte un champ optionnel `otherAgentsContext`
- [ ] Le summary prompt inclut une section `## Inter-Agent Coordination` pour les exécutions multi-agent
- [ ] Le summary prompt affiche les partages inter-agents avec le format source → target
- [ ] Le `durationMs` dans le prompt summary est la vraie durée (non-zéro)
- [ ] Le `durationMs` est calculé avant l'appel `generateSummary()` (option A)
- [ ] Les `CoordinationStats` sont construites uniquement pour les exécutions multi-agent
- [ ] Les `_sharingSummaries` sont collectées dans `handleDelta()` et réinitialisées entre exécutions
- [ ] Le nombre de sharingSummaries passées au prompt est limité (`MAX_SHARING_SUMMARIES = 10`)
- [ ] L'`informationPreview` est tronqué à 150 caractères
- [ ] Le type `CoordinationStats` est ajouté dans `agent-pool.types.ts`
- [ ] Tous les tests existants passent toujours
- [ ] Les nouveaux tests couvrent les prompts modifiés et l'intégration

---

## Points d'attention

1. **Ne PAS supprimer le champ `preference` du template `notification-decision.ts`** — le retirer du template Handlebars mais s'assurer que le code dans `NotificationEngine.evaluateWithLlm()` ne passe plus les données de preference au template. Si Handlebars reçoit des données non-référencées dans le template, elles sont silencieusement ignorées (pas d'erreur). Donc on peut mettre à jour le template et le code d'appel indépendamment si nécessaire.

2. **Le `otherAgentsContext` est `null` pour cette évolution** — c'est un placeholder pour le futur. Le `NotificationEngine` n'a pas accès au `ContextTracker` actuellement. Connecter les deux serait un changement architectural qui dépasse le scope de cette évolution. Le champ est juste préparé dans le template.

3. **Les `_sharingSummaries` sont stockées dans la pool, pas dans le broker** — c'est voulu. Le broker gère l'historique de déduplication (évolution 02), la pool gère la collecte pour le résumé. Les deux structures ont des objectifs différents : le broker a besoin de l'historique complet par target pour la déduplication, la pool a besoin d'une liste plate limitée pour le résumé.

4. **Le summary prompt ne doit pas être trop long** — la section coordination est conditionnelle (`{{#if coordination}}`). En single-agent, elle est omise. En multi-agent, les `sharingSummaries` sont limitées à 10 entrées de 150 chars max chacune. L'overhead est d'environ 200-400 tokens au maximum.

5. **Le calcul de `durationMs` avant le summary** (option A) signifie que la durée reportée dans le summary et dans `AgentPoolResult` est celle **au moment du calcul**, pas à la fin de toute l'opération. La différence est le temps du summary LLM (~2-5s) et du destroy des agents. C'est acceptable et même plus honnête — l'utilisateur veut savoir combien de temps les agents ont travaillé, pas combien de temps le reporting a pris.

6. **Le champ `delta.agentId` est retiré du notification prompt** — le LLM n'a pas besoin de l'UUID technique. Le `agentName` et le `agentRole` suffisent pour la contextualisation. L'ID est toujours disponible dans le code pour le logging et le tracking.

7. **Backward compatibility du template notification** — si du code externe compile le template `notificationDecisionPrompt` avec l'ancienne structure de données (incluant `preference`), Handlebars ignorera silencieusement les champs non-référencés dans le template. Pas de breaking change, mais le prompt ne les affichera plus.

8. **Le résumé single-agent** dans `generateSummary()` court-circuite déjà l'appel LLM (retourne un résumé hardcodé). Ce court-circuit reste inchangé — les `CoordinationStats` ne sont même pas construites pour le single-agent. Le summary enrichi ne s'applique qu'aux exécutions multi-agent.

9. **Importer `CoordinationStats`** dans `agent-pool.ts` si c'est un type séparé. Vérifier que les imports sont corrects dans tous les fichiers modifiés.

10. **Les exemples few-shot de l'évolution 04** dans le notification prompt — il faut vérifier que les exemples ajoutés précédemment sont toujours cohérents avec le nouveau format de prompt. Les exemples doivent refléter le nouveau framing (pas de vérification de preference, focus sémantique). Adapter les exemples si nécessaire pour qu'ils soient cohérents avec le nouveau prompt.