# Évolution 02 — Déduplication du partage inter-agents

## Priorité : 🔴 P0

## Dépendances : Évolution 01 (Fix agent-subtask mapping)

## Acquis des évolutions précédentes

- **Évolution 01** : L'`InformationBroker` reçoit désormais les mappings `subtaskToAgent` et `agentToSubtask` via son constructeur. La méthode `isAgentForSubtask()` fonctionne correctement. Le tri des candidats par dépendance est opérationnel. La méthode `findDependency()` traduit correctement entre agent IDs et subtask IDs.

---

## Contexte du problème

L'`InformationBroker` n'a **aucune mémoire** de ce qu'il a déjà partagé. Chaque delta est évalué indépendamment, sans savoir si une information similaire ou identique a déjà été transmise à un agent cible.

### Scénario problématique concret

1. L'agent `api-developer` écrit le fichier `src/routes/users.ts` → delta `FILE_WRITTEN`, significance 0.5 (augmentée à 0.8 car blocking dep)
2. Le broker évalue et décide de partager avec `test-writer` : « L'API users a les endpoints GET /users, POST /users, PUT /users/:id »
3. L'agent `api-developer` écrit le fichier `src/routes/products.ts` → nouveau delta `FILE_WRITTEN`
4. Le broker évalue à nouveau et décide de partager avec `test-writer` : « L'API a les endpoints GET /users, POST /users, PUT /users/:id, GET /products, POST /products »
5. L'information sur les endpoints users est **redondante** — elle a déjà été partagée

Ce problème se multiplie avec chaque outil complété, chaque fichier écrit, chaque prompt terminé. Le résultat :

- **Gaspillage de tokens** : le LLM du broker raisonne sur des décisions déjà prises
- **Pollution du contexte cible** : l'agent target reçoit des instructions répétitives qui diluent son attention
- **Coût API inutile** : chaque évaluation LLM coûte des tokens OpenRouter

### Ampleur du problème

Dans une exécution multi-agent typique avec 3 agents et 10-15 deltas significatifs par agent, le broker peut faire **30-45 évaluations LLM** dont une proportion importante (estimée 30-50%) produit des partages redondants.

---

## Fichiers impactés

| Fichier | Action |
|---------|--------|
| `src/classes/agent-pool/information-broker.ts` | Ajouter le `SharingHistory` + logique de déduplication |
| `src/types/agent-pool.types.ts` | Ajouter le type `SharingRecord` |
| `src/prompts/batched-sharing-decision.ts` | Enrichir le prompt avec l'historique de partage par target |
| `src/classes/agent-pool/tests/` | Tests unitaires pour la déduplication |

---

## Spécification détaillée des changements

### 1. Nouveau type `SharingRecord` dans `agent-pool.types.ts`

Ajouter un type pour représenter un enregistrement de partage effectué :

```typescript
/**
 * Enregistrement d'un partage d'information effectué entre deux agents.
 * Stocké dans l'historique du broker pour la déduplication.
 */
export interface SharingRecord {
    /** ISO-8601 timestamp du partage. */
    readonly timestamp: string;

    /** L'agent source qui a produit l'information. */
    readonly sourceAgentId: string;

    /** L'agent cible qui a reçu l'information. */
    readonly targetAgentId: string;

    /** Le type de delta qui a déclenché le partage. */
    readonly deltaType: DeltaType;

    /** Résumé condensé de l'information partagée (pour inclusion dans les prompts futurs). */
    readonly informationSummary: string;
}
```

### 2. Ajouter `SharingHistory` dans `InformationBroker`

Créer une structure de données interne au broker pour tracker les partages effectués :

```typescript
/**
 * Historique des partages effectués, indexé par agent cible.
 *
 * Structure : targetAgentId → SharingRecord[]
 *
 * L'indexation par target est choisie car la question de déduplication
 * est toujours posée du point de vue du target : « cet agent a-t-il
 * déjà reçu cette information ? »
 */
private readonly sharingHistory = new Map<string, SharingRecord[]>();
```

Constantes associées :

```typescript
/**
 * Nombre maximum d'enregistrements de partage conservés par agent cible.
 * Limite la croissance mémoire en ne gardant que les partages les plus récents.
 * Les plus anciens sont considérés comme suffisamment intégrés par l'agent.
 */
const MAX_SHARING_RECORDS_PER_TARGET = 20;

/**
 * Nombre maximum d'enregistrements inclus dans le prompt LLM pour le contexte.
 * Réduit la consommation de tokens tout en donnant au LLM assez de contexte
 * pour éviter les doublons.
 */
const MAX_SHARING_RECORDS_IN_PROMPT = 5;
```

### 3. Méthode `recordSharing()` dans `InformationBroker`

Ajouter une méthode pour enregistrer un partage effectué :

```typescript
/**
 * Enregistre un partage effectué pour la déduplication future.
 *
 * Appelé après qu'un partage a été approuvé ET injecté dans l'agent cible.
 * Tronque l'information à un résumé court pour limiter l'usage mémoire
 * et la taille des prompts futurs.
 *
 * @param decision - La décision de partage qui a été exécutée.
 */
recordSharing(decision: SharingDecision): void {
    const record: SharingRecord = {
        timestamp: isoNow(),
        sourceAgentId: decision.sourceAgentId,
        targetAgentId: decision.targetAgentId,
        deltaType: // le type de delta courant, à passer en paramètre ou stocker
        informationSummary: decision.information.slice(0, 200),
    };

    let records = this.sharingHistory.get(decision.targetAgentId);
    if (!records) {
        records = [];
        this.sharingHistory.set(decision.targetAgentId, records);
    }
    records.push(record);

    // Enforce limit — supprimer les plus anciens
    if (records.length > MAX_SHARING_RECORDS_PER_TARGET) {
        records.splice(0, records.length - MAX_SHARING_RECORDS_PER_TARGET);
    }
}
```

**Note** : il faut aussi passer le `DeltaType` du delta courant au record. Le plus propre est de modifier la signature pour accepter le delta type :

```typescript
recordSharing(decision: SharingDecision, deltaType: DeltaType): void {
```

### 4. Méthode `getRecentSharingsForTarget()` dans `InformationBroker`

Ajouter une méthode pour récupérer l'historique récent pour un agent cible :

```typescript
/**
 * Retourne les partages récents effectués vers un agent cible.
 * Utilisé pour enrichir le prompt de décision de partage et permettre
 * au LLM d'éviter les doublons.
 *
 * @param targetAgentId - L'agent cible.
 * @param limit - Nombre maximum de records à retourner (défaut: MAX_SHARING_RECORDS_IN_PROMPT).
 * @returns Les records les plus récents, du plus ancien au plus récent.
 */
getRecentSharingsForTarget(
    targetAgentId: string,
    limit: number = MAX_SHARING_RECORDS_IN_PROMPT,
): readonly SharingRecord[] {
    const records = this.sharingHistory.get(targetAgentId);
    if (!records || records.length === 0) return [];

    // Retourner les N plus récents
    return records.slice(-limit);
}
```

### 5. Enrichir `evaluateBatch()` avec l'historique

Dans la méthode `evaluateBatch()`, enrichir les données de chaque target avec son historique de partage :

```typescript
private async evaluateBatch(
    delta: ContextDelta,
    sourceState: AgentContextState,
    targetStates: AgentContextState[],
): Promise<SharingDecision[]> {
    const targets = targetStates.map((targetState) => {
        const dependency = this.findDependency(
            sourceState.agentId,
            targetState.agentId,
        );

        // ← NOUVEAU : récupérer l'historique de partage pour ce target
        const previouslyShared = this.getRecentSharingsForTarget(targetState.agentId);

        return {
            agentId: targetState.agentId,
            agentName: targetState.agentName,
            taskDescription: targetState.taskDescription,
            taskRole: targetState.taskRole,
            status: targetState.status,
            completed: targetState.completed,
            dependency: dependency ?? null,
            previouslyShared,  // ← NOUVEAU
        };
    });

    // ... reste inchangé
}
```

### 6. Mettre à jour le prompt `batched-sharing-decision.ts`

Enrichir le template Handlebars pour inclure l'historique de partage par target :

```handlebars
## Target Agents
{{#each targets}}
### Target: {{this.agentName}} ({{this.agentId}})
- **Task**: {{this.taskDescription}}
- **Role**: {{this.taskRole}} | **Status**: {{this.status}} | **Completed**: {{this.completed}}
{{#if this.dependency}}
- **Dependency**: {{this.dependency.from}} → {{this.dependency.to}} ({{this.dependency.type}})
{{/if}}
{{#if this.previouslyShared.length}}
- **Previously shared to this agent** (do NOT re-share redundant information):
{{#each this.previouslyShared}}
  - [{{this.deltaType}}] {{this.informationSummary}}
{{/each}}
{{/if}}

{{/each}}
```

Ajouter un critère explicite dans la section `## Criteria` :

```handlebars
## Criteria
1. Is this genuinely useful for the target agent's specific task?
2. Would it help the target produce better output?
3. Is the target in a state where it can use this (not completed/destroyed)?
4. Is the information concrete and actionable?
5. Has similar or identical information already been shared to this target? If yes, do NOT re-share — only share genuinely NEW information that adds value beyond what was previously communicated.
```

### 7. Appeler `recordSharing()` depuis `AgentPool.handleDelta()`

Dans `agent-pool.ts`, dans la méthode `handleDelta()`, après qu'un partage est effectivement injecté dans l'agent cible, enregistrer le partage dans le broker :

```typescript
// Dans handleDelta(), après l'injection réussie
if (decision.shouldShare) {
    const targetEntry = this.managedAgents.get(decision.targetAgentId);

    if (targetEntry && targetEntry.agent.status !== AgentStatus.DESTROYED) {
        try {
            targetEntry.agent.injectContext(decision.information);

            // ← NOUVEAU : enregistrer le partage pour la déduplication
            this.informationBroker?.recordSharing(decision, delta.type);

            this.emitPoolEvent(PoolEvent.CONTEXT_SHARED, {
                sourceAgentId: decision.sourceAgentId,
                targetAgentId: decision.targetAgentId,
                information: decision.information,
            });

            // ... log existant
        } catch (injectError) {
            // ... gestion d'erreur existante
        }
    }
}
```

### 8. Méthode `clearHistory()` pour le cleanup

Ajouter une méthode de nettoyage (utilisée quand l'exécution se termine) :

```typescript
/**
 * Efface tout l'historique de partage.
 * Appelé en fin d'exécution lors du cleanup.
 */
clearHistory(): void {
    this.sharingHistory.clear();
}
```

Le broker est recréé à chaque exécution (`this.informationBroker = new InformationBroker(...)`) donc l'historique est naturellement nettoyé. Cette méthode est un filet de sécurité explicite.

### 9. Exposer les statistiques de déduplication

Ajouter un getter pour observer l'efficacité de la déduplication dans les logs/events :

```typescript
/** Nombre total de partages enregistrés dans l'historique. */
get totalRecordedSharings(): number {
    let count = 0;
    for (const records of this.sharingHistory.values()) {
        count += records.length;
    }
    return count;
}
```

---

## Tests à implémenter

### Tests unitaires pour `InformationBroker` (déduplication)

#### Test 1 : `recordSharing` enregistre correctement un partage

- Setup : créer un broker avec les dépendances de l'évolution 01
- Appeler `recordSharing()` avec une décision de partage
- Assert : `getRecentSharingsForTarget(targetId)` retourne 1 record avec les bonnes valeurs
- Assert : `totalRecordedSharings` retourne 1

#### Test 2 : `recordSharing` respecte la limite `MAX_SHARING_RECORDS_PER_TARGET`

- Setup : enregistrer `MAX_SHARING_RECORDS_PER_TARGET + 5` partages vers le même target
- Assert : `getRecentSharingsForTarget(targetId)` retourne exactement `MAX_SHARING_RECORDS_PER_TARGET` records
- Assert : les records retournés sont les plus récents (les 5 premiers ont été évincés)

#### Test 3 : `getRecentSharingsForTarget` retourne un tableau vide pour un target inconnu

- Assert : `getRecentSharingsForTarget("agent-inexistant")` retourne `[]`

#### Test 4 : `getRecentSharingsForTarget` respecte le paramètre `limit`

- Setup : enregistrer 10 partages vers un target
- Assert : `getRecentSharingsForTarget(targetId, 3)` retourne les 3 plus récents

#### Test 5 : `clearHistory` vide tout l'historique

- Setup : enregistrer des partages vers plusieurs targets
- Appeler `clearHistory()`
- Assert : `totalRecordedSharings` retourne 0
- Assert : `getRecentSharingsForTarget()` retourne `[]` pour tous les anciens targets

#### Test 6 : L'historique est indépendant par target

- Setup : enregistrer 3 partages vers `agent-A` et 2 vers `agent-B`
- Assert : `getRecentSharingsForTarget("agent-A")` retourne 3 records
- Assert : `getRecentSharingsForTarget("agent-B")` retourne 2 records
- Assert : les records ne se mélangent pas

#### Test 7 : Les records incluent l'`informationSummary` tronqué à 200 caractères

- Setup : enregistrer un partage avec une `information` de 500 caractères
- Assert : le `informationSummary` du record fait au plus 200 caractères

### Tests d'intégration

#### Test 8 : Le prompt LLM inclut l'historique de partage

- Mocker le `ConversationManager.sendOneShotJson()` pour capturer le prompt envoyé
- Enregistrer un partage passé vers un target
- Déclencher `evaluateBatch()` avec ce même target
- Assert : le prompt contient la section « Previously shared to this agent »
- Assert : le prompt contient le résumé de l'information précédemment partagée

#### Test 9 : `handleDelta` dans `AgentPool` appelle `recordSharing` après injection

- Mocker l'agent cible et le broker
- Simuler un delta avec une décision de partage `shouldShare: true`
- Assert : `recordSharing()` est appelé avec la bonne décision et le bon delta type
- Assert : l'appel se fait APRÈS `injectContext()` (pas avant, pas si l'injection échoue)

---

## Critères de validation

- [ ] Le broker maintient un historique de partage indexé par agent cible
- [ ] L'historique est transmis au LLM dans le prompt de décision de partage
- [ ] Le prompt contient un critère explicite de non-redondance
- [ ] `recordSharing()` est appelé uniquement après une injection réussie
- [ ] L'historique respecte la limite `MAX_SHARING_RECORDS_PER_TARGET`
- [ ] Le `informationSummary` est tronqué pour limiter les tokens
- [ ] L'historique est naturellement nettoyé quand le broker est recréé entre exécutions
- [ ] `getRecentSharingsForTarget()` retourne les records les plus récents en premier
- [ ] Tous les tests existants passent toujours
- [ ] Les nouveaux tests couvrent les cas nominaux et les edge cases

---

## Points d'attention

1. **Ne pas stocker l'information complète** — seul un résumé de 200 chars est conservé. L'objectif est de donner au LLM assez de contexte pour détecter les doublons, pas de reconstruire l'information originale.
2. **La limite `MAX_SHARING_RECORDS_IN_PROMPT` (5) est distincte de `MAX_SHARING_RECORDS_PER_TARGET` (20)** — on garde plus en mémoire qu'on n'en montre au LLM. Cela permet d'avoir un historique plus profond pour des usages futurs (analytics, debugging).
3. **Ne pas faire de déduplication programmatique côté broker** — c'est le LLM qui décide si l'info est redondante ou non, avec l'historique comme contexte. Le broker fournit l'info, le LLM juge.
4. **L'`informationSummary` est un simple `slice(0, 200)`** — dans une évolution future, on pourrait utiliser un résumé LLM-generated, mais pour l'instant le truncation est suffisant et ne coûte rien.
5. **Le type `DeltaType` doit être importé dans `information-broker.ts`** s'il ne l'est pas déjà — vérifier les imports existants.
6. **Le `recordSharing()` doit recevoir le `deltaType`** — le plus propre est de le passer en paramètre séparé plutôt que de le stocker sur la `SharingDecision` (qui est un type existant qu'on ne veut pas modifier pour cette évolution).