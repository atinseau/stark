# Évolution 01 — Fix du mapping Agent ↔ Subtask dans l'InformationBroker

## Priorité : 🔴 P0 (Bug critique)

## Dépendances : Aucune

## Contexte du problème

L'`InformationBroker` est responsable de décider si l'information produite par un agent doit être partagée avec d'autres agents. Pour prioriser les candidats, il s'appuie sur le graphe de dépendances (`TaskDependency[]`) qui utilise des **subtask IDs** (ex: `"subtask-api"`, `"subtask-tests"`).

Or, les agents sont identifiés par des **agent IDs** (UUIDs générés à la création). Le broker a donc besoin d'un mapping `subtaskId ↔ agentId` pour savoir quel agent correspond à quel subtask dans le graphe de dépendances.

**Le bug** : la méthode `isAgentForSubtask()` dans `InformationBroker` retourne **toujours `false`**, rendant tout le système de priorisation par dépendances inopérant :

```typescript
// src/classes/agent-pool/information-broker.ts (lignes ~346-359)
private isAgentForSubtask(_agentId: string, _subtaskId: string): boolean {
    // Default implementation: the agent-to-subtask mapping is
    // handled externally by the pool. This method can be overridden
    // or augmented with a proper mapping.
    // For now, we always return false and let the LLM decide based
    // on semantic analysis rather than structural matching.
    return false;
}
```

Pendant ce temps, l'`AgentPool` **possède** les mappings nécessaires mais ne les transmet jamais au broker :

```typescript
// src/classes/agent-pool/agent-pool.ts (lignes ~222-225)
private readonly subtaskToAgent = new Map<string, string>();
private readonly agentToSubtask = new Map<string, string>();
```

Ces maps sont correctement peuplées dans `spawnAgents()` :

```typescript
// src/classes/agent-pool/agent-pool.ts (dans spawnAgents())
this.subtaskToAgent.set(subtask.id, agent.id);
this.agentToSubtask.set(agent.id, subtask.id);
```

Mais le broker est instancié sans elles :

```typescript
// src/classes/agent-pool/agent-pool.ts (ligne ~408)
this.informationBroker = new InformationBroker(
    this.conversations,
    this.contextTracker,
    analysis.dependencies,
    this.logger,
);
```

### Conséquence directe

La méthode `findCandidateTargets()` du broker trie les agents candidats pour que ceux avec des dépendances déclarées sur l'agent source soient évalués en premier. Comme `isAgentForSubtask()` retourne toujours `false` :

1. `dependentIds` est toujours vide
2. `isAgentDependentOnSource()` retourne toujours `false`
3. Le tri par dépendance ne fait rien — l'ordre des candidats est aléatoire
4. Les agents avec des dépendances `blocking` ne sont pas priorisés

Le LLM de partage compense partiellement via l'analyse sémantique, mais il perd l'information structurelle critique des dépendances déclarées dans le plan.

---

## Fichiers impactés

| Fichier | Action |
|---------|--------|
| `src/classes/agent-pool/information-broker.ts` | Modifier le constructeur + `isAgentForSubtask()` |
| `src/classes/agent-pool/agent-pool.ts` | Passer les mappings au broker lors de l'instanciation |
| `src/classes/agent-pool/tests/` | Ajouter/modifier les tests unitaires |

---

## Spécification détaillée des changements

### 1. Modifier le constructeur de `InformationBroker`

Ajouter deux paramètres au constructeur pour recevoir les mappings bidirectionnels :

```typescript
constructor(
    private readonly conversations: ConversationManager,
    private readonly contextTracker: ContextTracker,
    private readonly dependencies: ReadonlyArray<TaskDependency>,
    private readonly logger: pino.Logger,
    private readonly subtaskToAgent: ReadonlyMap<string, string>,
    private readonly agentToSubtask: ReadonlyMap<string, string>,
    options?: {
        significanceThreshold?: number;
    },
)
```

Les maps sont `ReadonlyMap` pour exprimer que le broker ne doit pas les modifier — il est un consommateur, pas un propriétaire de ces données.

### 2. Ré-implémenter `isAgentForSubtask()`

Remplacer le stub par une implémentation fonctionnelle utilisant les mappings :

```typescript
private isAgentForSubtask(agentId: string, subtaskId: string): boolean {
    // Vérification directe : l'agent ID correspond-il au subtask ID via le mapping ?
    const mappedAgentId = this.subtaskToAgent.get(subtaskId);
    if (mappedAgentId === agentId) return true;

    // Vérification inverse : le subtask de cet agent correspond-il ?
    const mappedSubtaskId = this.agentToSubtask.get(agentId);
    if (mappedSubtaskId === subtaskId) return true;

    return false;
}
```

### 3. Mettre à jour `findCandidateTargets()`

La méthode actuelle construit `dependentIds` en cherchant les dépendances depuis le `sourceAgentId`. Mais les dépendances utilisent des subtask IDs. Il faut traduire l'agent ID source en subtask ID avant de chercher :

```typescript
private findCandidateTargets(sourceAgentId: string): AgentContextState[] {
    const others = this.contextTracker.getOtherAgentStates(sourceAgentId);

    const active = others.filter(
        (state) => !state.completed && state.status !== "destroyed",
    );

    if (active.length === 0) return [];

    // Traduire l'agent ID source en subtask ID
    const sourceSubtaskId = this.agentToSubtask.get(sourceAgentId);

    // Trouver les subtask IDs qui dépendent du subtask source
    const dependentSubtaskIds = new Set<string>();
    if (sourceSubtaskId) {
        for (const dep of this.dependencies) {
            if (dep.from === sourceSubtaskId) {
                dependentSubtaskIds.add(dep.to);
            }
        }
    }

    // Trier : les agents dont le subtask dépend du source en premier
    return active.sort((a, b) => {
        const aDependent = this.isAgentDependentOnSource(a.agentId, dependentSubtaskIds);
        const bDependent = this.isAgentDependentOnSource(b.agentId, dependentSubtaskIds);

        if (aDependent && !bDependent) return -1;
        if (!aDependent && bDependent) return 1;
        return 0;
    });
}
```

### 4. Mettre à jour `isAgentDependentOnSource()`

Cette méthode doit utiliser le mapping pour vérifier si un agent est assigné à un subtask dépendant :

```typescript
private isAgentDependentOnSource(
    agentId: string,
    dependentSubtaskIds: Set<string>,
): boolean {
    // Trouver le subtask ID de cet agent
    const agentSubtaskId = this.agentToSubtask.get(agentId);
    if (agentSubtaskId && dependentSubtaskIds.has(agentSubtaskId)) {
        return true;
    }

    // Fallback : vérifier via isAgentForSubtask pour chaque subtask dépendant
    for (const depId of dependentSubtaskIds) {
        if (this.isAgentForSubtask(agentId, depId)) {
            return true;
        }
    }
    return false;
}
```

### 5. Mettre à jour `findDependency()`

La méthode `findDependency()` (utilisée dans `evaluateBatch()`) cherche une dépendance entre deux agents. Elle doit aussi traduire les agent IDs en subtask IDs :

Vérifier l'implémentation actuelle de `findDependency()` et s'assurer qu'elle traduit les agent IDs via les mappings avant de chercher dans `this.dependencies`.

```typescript
private findDependency(
    sourceAgentId: string,
    targetAgentId: string,
): TaskDependency | null {
    const sourceSubtaskId = this.agentToSubtask.get(sourceAgentId);
    const targetSubtaskId = this.agentToSubtask.get(targetAgentId);

    if (!sourceSubtaskId || !targetSubtaskId) return null;

    return this.dependencies.find(
        (dep) => dep.from === sourceSubtaskId && dep.to === targetSubtaskId,
    ) ?? null;
}
```

### 6. Mettre à jour l'instanciation dans `AgentPool`

Dans `agent-pool.ts`, passer les mappings au broker lors de sa création :

```typescript
// Dans execute(), après spawnAgents()
this.informationBroker = new InformationBroker(
    this.conversations,
    this.contextTracker,
    analysis.dependencies,
    this.logger,
    this.subtaskToAgent,   // ← nouveau
    this.agentToSubtask,   // ← nouveau
);
```

Note : les maps `this.subtaskToAgent` et `this.agentToSubtask` sont peuplées dans `spawnAgents()` qui est appelé **avant** la création du broker, donc les données sont disponibles. Comme les maps sont passées par référence, même les ajouts tardifs seront visibles par le broker (mais en pratique tous les agents sont spawnés avant l'exécution).

---

## Tests à implémenter

### Tests unitaires pour `InformationBroker`

Créer ou enrichir `src/classes/agent-pool/tests/information-broker.spec.ts` :

#### Test 1 : `isAgentForSubtask` retourne `true` quand le mapping existe

- Setup : créer des maps `subtaskToAgent` et `agentToSubtask` avec les entrées `{ "subtask-api" → "agent-123" }` et `{ "agent-123" → "subtask-api" }`
- Assert : `isAgentForSubtask("agent-123", "subtask-api")` retourne `true`
- Assert : `isAgentForSubtask("agent-999", "subtask-api")` retourne `false`

Note : `isAgentForSubtask` est private, donc tester via `findCandidateTargets` ou exposer pour les tests.

#### Test 2 : `findCandidateTargets` priorise les agents dépendants

- Setup : 3 agents (`agent-A` → `subtask-1`, `agent-B` → `subtask-2`, `agent-C` → `subtask-3`)
- Dépendance : `subtask-1 → subtask-2` (blocking)
- Delta émis par `agent-A`
- Assert : `agent-B` apparaît avant `agent-C` dans les candidats

#### Test 3 : `findDependency` traduit correctement les agent IDs

- Setup : dépendance `{ from: "subtask-api", to: "subtask-tests", type: "blocking" }`
- Mapping : `agent-X → subtask-api`, `agent-Y → subtask-tests`
- Assert : `findDependency("agent-X", "agent-Y")` retourne la dépendance
- Assert : `findDependency("agent-Y", "agent-X")` retourne `null`

#### Test 4 : Le broker fonctionne avec des maps vides (single-agent graceful)

- Setup : maps vides (cas single-agent, pas de dépendances)
- Assert : le broker ne crash pas, retourne un tableau vide de décisions

### Tests d'intégration

#### Test 5 : Vérifier que `AgentPool.execute()` passe les maps au broker

- Mocker le constructeur de `InformationBroker`
- Exécuter une tâche multi-agent
- Assert : le constructeur reçoit des maps non-vides avec les bons mappings subtask ↔ agent

---

## Critères de validation

- [ ] `isAgentForSubtask()` ne retourne plus systématiquement `false`
- [ ] Les agents avec des dépendances `blocking` sur l'agent source sont évalués en premier par le broker
- [ ] `findDependency()` traduit correctement entre agent IDs et subtask IDs
- [ ] Le broker reçoit les mappings depuis l'`AgentPool`
- [ ] Aucune régression : le mode single-agent (maps vides) fonctionne toujours
- [ ] Tous les tests existants dans `src/classes/agent-pool/tests/` passent toujours
- [ ] Les nouveaux tests couvrent les cas nominaux et les edge cases (maps vides, agent inconnu)

---

## Points d'attention

1. **Ne pas modifier la signature de `evaluate()`** — l'API publique du broker ne change pas, seul le constructeur évolue.
2. **Les maps sont partagées par référence** — ne pas cloner, le broker lit les mêmes instances que la pool. Mais utiliser `ReadonlyMap` dans le type pour exprimer l'intention.
3. **Backward compatibility** — si d'autres endroits du code instancient `InformationBroker` (tests, exemples), les mettre à jour pour passer les nouveaux paramètres.
4. **Le prompt de sharing (`batched-sharing-decision.ts`) inclut déjà un champ `dependency`** dans les targets — ce fix fait en sorte que ce champ soit correctement renseigné au lieu d'être toujours `null`.