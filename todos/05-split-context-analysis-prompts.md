# Évolution 05 — Séparation du system prompt Context Analyzer en rôles spécialisés

## Priorité : 🟠 P1

## Dépendances : Aucune

## Acquis des évolutions précédentes

- **Évolution 01** : L'`InformationBroker` reçoit les mappings `subtaskToAgent` / `agentToSubtask` via son constructeur. `isAgentForSubtask()` fonctionne. Le tri des candidats par dépendance est opérationnel. `findDependency()` traduit correctement entre agent IDs et subtask IDs.
- **Évolution 02** : L'`InformationBroker` maintient un `SharingHistory` indexé par agent cible. Le prompt de partage inclut les partages précédents (`previouslyShared`). `recordSharing()` est appelé après chaque injection réussie. Le type `SharingRecord` existe dans `agent-pool.types.ts`.
- **Évolution 03** : Le `ProjectScanner` scanne le répertoire de travail et produit un `ProjectContext`. Le planner reçoit le contexte projet (arborescence, langages, frameworks, configs résumés). Le system prompt du planner inclut une section `## Project Context Usage`.
- **Évolution 04** : Tous les prompts LLM contiennent des exemples few-shot contrastifs. Les validateurs acceptent les JSON des exemples. Le summary system prompt a été restructuré avec des sections et un exemple.

---

## Contexte du problème

Le rôle `ConversationRole.CONTEXT_ANALYZER` est actuellement un **rôle unique** utilisé par **deux sous-systèmes très différents** :

1. **L'`InformationBroker`** — utilise le context analyzer pour décider si un delta d'un agent doit être partagé avec d'autres agents. C'est une décision de **coordination inter-agents**.
2. **Le `NotificationEngine`** — utilise le context analyzer pour décider si un delta justifie de notifier l'utilisateur. C'est une décision de **communication utilisateur**.

Ces deux usages partagent le **même system prompt** :

```typescript
// src/prompts/context-analysis.ts (CONTEXT_ANALYSIS_SYSTEM_SOURCE)
`You are a real-time context analyzer for an AI agent orchestration system.

Evaluate context deltas (changes) from agents and recommend actions.
...
## Actions
- **ignore**: Delta not significant enough for action (default).
- **share**: Information should be sent to another agent...
- **notify**: User should be informed...
- **clarify**: System needs user clarification to proceed.`
```

### Problèmes identifiés

#### 1. Confusion de responsabilités dans le system prompt

Le system prompt demande au LLM de remplir 4 rôles en même temps (ignore, share, notify, clarify). Quand l'`InformationBroker` pose une question de sharing, le LLM a en tête les actions `notify` et `clarify` qui ne sont pas pertinentes — et vice versa. Cela dilue la qualité de chaque décision.

#### 2. L'action `clarify` n'est jamais implémentée

L'action `clarify` est définie dans le system prompt mais **aucun code dans la pool ne la traite**. Le LLM pourrait recommander `clarify` et cette recommandation serait silencieusement ignorée (ou pire, causerait une erreur de validation). C'est du bruit dans le prompt et une promesse non tenue au LLM.

#### 3. Pas de spécialisation des instructions

Le broker et le notification engine ont des critères de décision **fondamentalement différents** :

- **Broker** : « Cette information est-elle pertinente pour la tâche spécifique d'un autre agent ? Comment la distiller pour qu'elle soit actionnable ? »
- **Notification** : « Est-ce que cet événement est assez important pour interrompre l'utilisateur ? Le message est-il clair et informatif pour un humain ? »

Un system prompt unique ne peut pas optimiser pour les deux en même temps.

#### 4. Isolation conversationnelle compromise

Même si les deux usages sont one-shot (`sendOneShotJson`), ils partagent le même system prompt chargé dans le même `ConversationRole`. Si dans le futur on passe à des appels avec historique (cf. évolution 14), les deux usages pollueraient la même conversation.

#### 5. Pas de possibilité de model override indépendant

Le système de `modelOverrides` dans `AgentPoolConfig` permet de spécifier un modèle différent par `ConversationRole`. Comme le broker et le notification engine partagent `CONTEXT_ANALYZER`, il est impossible d'utiliser un modèle rapide/bon marché pour les notifications et un modèle plus puissant pour le sharing.

---

## Fichiers impactés

| Fichier | Action |
|---------|--------|
| `src/enums/conversation-role.enum.ts` | Ajouter `SHARING_ANALYZER` |
| `src/prompts/context-analysis.ts` | Séparer en deux system prompts spécialisés |
| `src/prompts/index.ts` | Exporter le nouveau prompt |
| `src/classes/agent-pool/agent-pool.ts` | Enregistrer la nouvelle conversation + model override |
| `src/classes/agent-pool/information-broker.ts` | Utiliser `SHARING_ANALYZER` au lieu de `CONTEXT_ANALYZER` |
| `src/classes/agent-pool/notification-engine.ts` | Garder `CONTEXT_ANALYZER` (renommé conceptuellement en rôle notification) |
| `src/types/agent-pool.types.ts` | Mettre à jour le type `AgentPoolConfig.modelOverrides` si nécessaire |
| `src/classes/agent-pool/tests/` | Tests unitaires pour la séparation |

---

## Spécification détaillée des changements

### 1. Ajouter `SHARING_ANALYZER` dans `ConversationRole`

Dans `src/enums/conversation-role.enum.ts` :

```typescript
export enum ConversationRole {
    /** Strategic task analysis and decomposition. */
    PLANNER = "planner",

    /** Real-time context delta analysis for user notifications. */
    CONTEXT_ANALYZER = "context-analyzer",

    /**
     * Cross-agent information sharing evaluation.
     *
     * Dedicated conversation for the InformationBroker to evaluate
     * whether deltas from one agent should be shared with others.
     * Separated from CONTEXT_ANALYZER to enable:
     * - Specialized system prompts for sharing vs notification
     * - Independent model overrides (e.g., fast model for notifications, powerful for sharing)
     * - Future independent conversation history management
     */
    SHARING_ANALYZER = "sharing-analyzer",

    /** User-facing interaction and response generation. */
    USER_INTERACTION = "user-interaction",

    /** User intent classification and routing. */
    INTENT_ANALYZER = "intent-analyzer",
}
```

### 2. Créer le system prompt spécialisé pour le sharing

Dans `src/prompts/context-analysis.ts`, ajouter un nouveau template `SHARING_ANALYSIS_SYSTEM_SOURCE` dédié au broker :

```handlebars
You are a cross-agent information sharing specialist for an AI agent orchestration system.

Your sole responsibility is deciding whether information from one agent's activity should be forwarded to other agents working on related subtasks. You do NOT notify users or request clarification — other systems handle those concerns.

## Decision Framework

For each target agent, evaluate:

1. **Relevance**: Does the delta contain information directly useful for the target's specific subtask?
2. **Actionability**: Can the target agent act on this information? Vague or abstract information is rarely worth sharing.
3. **Timing**: Is the target in a state where it can use this? Sharing to a completed or destroyed agent is wasteful.
4. **Novelty**: Has similar information already been shared to this target? Redundant sharing pollutes the target's context window.
5. **Distillation**: If sharing is warranted, extract only the relevant details — do NOT forward raw data. Write concise, specific instructions the target agent can directly use.

## When to share
- API contracts, schemas, or interfaces that a dependent agent needs
- File paths and structure decisions that affect another agent's work
- Error information that another agent needs to work around
- Completed artifacts that unblock a waiting agent (blocking dependency)

## When NOT to share
- Routine events (file reads, status transitions, minor progress)
- Information the target agent can discover on its own (reading the same files)
- Raw output dumps — always distill to what matters for the target's task
- Information already shared in a previous decision (check previouslyShared)

## Dependency types
- **blocking**: The target CANNOT proceed without the source's output. Always evaluate sharing for blocking dependencies. Distill the critical output.
- **informational**: The target CAN proceed independently but MAY benefit from the source's output. Only share if the information provides clear, concrete value.

## JSON Output Format
Return one decision per target agent:
{
  "decisions": [
    {
      "targetAgentId": "<agent ID>",
      "shouldShare": true | false,
      "reasoning": "<concise explanation of why sharing is or isn't warranted>",
      "information": "<distilled, actionable information for the target agent — required when shouldShare is true, empty string when false>"
    }
  ]
}
```

### 3. Refactorer le system prompt existant `CONTEXT_ANALYZER` pour les notifications

Réécrire `CONTEXT_ANALYSIS_SYSTEM_SOURCE` en tant que prompt spécialisé notification. Retirer les actions `share` et `clarify` :

```handlebars
You are a notification evaluator for an AI agent orchestration system.

Your sole responsibility is deciding whether a context change from an agent's activity warrants notifying the human user. You do NOT decide on cross-agent sharing — another system handles that.

## Guiding Principle: Silence by Default

Users have explicitly opted in to notifications with a significance threshold. Your job is to be a final semantic filter — even though the delta passed numeric filters, you decide if it's genuinely worth the user's attention.

Most deltas should NOT generate notifications. Only notify for:
- **Milestones**: Major subtask completions, all tests passing, deployment success
- **Errors requiring intervention**: Missing dependencies, permission errors, configuration problems the agent cannot resolve
- **Unexpected outcomes**: Agent completed but with warnings, partial failures, unexpected results
- **Completion**: The full task or a significant phase is done

Do NOT notify for:
- Routine progress (file reads, tool calls, status transitions)
- Errors the agent is handling or retrying on its own
- Intermediate completions that are part of a larger task
- Events below the user's significance threshold (already filtered — but confirm semantic value)

## JSON Output
{
  "shouldNotify": true | false,
  "reasoning": "<why this delta does or does not warrant user attention>",
  "message": "<human-friendly notification message — required when shouldNotify is true, empty string when false>"
}
```

### 4. Renommer et restructurer dans `context-analysis.ts`

Le fichier `src/prompts/context-analysis.ts` contiendra désormais :

```typescript
import Handlebars from "handlebars";
import "./helpers.ts";

// ── Notification Evaluation: System Prompt ─────────────────────────────────

const NOTIFICATION_ANALYSIS_SYSTEM_SOURCE = `...`; // Le prompt ci-dessus pour les notifications

export const contextAnalysisSystemPrompt = Handlebars.compile(
    NOTIFICATION_ANALYSIS_SYSTEM_SOURCE,
    { noEscape: true },
);

// ── Sharing Evaluation: System Prompt ──────────────────────────────────────

const SHARING_ANALYSIS_SYSTEM_SOURCE = `...`; // Le prompt ci-dessus pour le sharing

export const sharingAnalysisSystemPrompt = Handlebars.compile(
    SHARING_ANALYSIS_SYSTEM_SOURCE,
    { noEscape: true },
);

// ── Context Analysis: Delta Analysis User Prompt ───────────────────────────
// (Reste inchangé — utilisé par d'autres systèmes si besoin)

const CONTEXT_ANALYSIS_SOURCE = `...`; // Le user prompt existant, inchangé

export const contextAnalysisPrompt = Handlebars.compile(
    CONTEXT_ANALYSIS_SOURCE,
    { noEscape: true },
);
```

**Note** : l'export `contextAnalysisSystemPrompt` garde le même nom pour la backward compatibility. Son contenu change (spécialisé notifications au lieu de générique), mais le nom d'export est stable.

### 5. Mettre à jour `src/prompts/index.ts`

Ajouter l'export du nouveau prompt :

```typescript
export {
    contextAnalysisPrompt,
    contextAnalysisSystemPrompt,
    sharingAnalysisSystemPrompt,  // ← NOUVEAU
} from "./context-analysis.ts";
```

Mettre à jour l'objet `templates` :

```typescript
export const templates = {
    // ...existing...

    // Context analysis (notifications)
    contextAnalysisSystem: contextAnalysisSystemPrompt,
    contextAnalysis: contextAnalysisPrompt,

    // Sharing analysis (cross-agent)
    sharingAnalysisSystem: sharingAnalysisSystemPrompt,  // ← NOUVEAU

    // ...existing...
} as const;
```

### 6. Enregistrer la conversation `SHARING_ANALYZER` dans `AgentPool`

Dans `src/classes/agent-pool/agent-pool.ts`, dans le constructeur, après l'enregistrement de `CONTEXT_ANALYZER` :

```typescript
// Register all conversation roles with their system prompts
const modelOverrides = this.config.modelOverrides ?? {};

this.conversations.register(
    ConversationRole.CONTEXT_ANALYZER,
    contextAnalysisSystemPrompt({}),
    modelOverrides[ConversationRole.CONTEXT_ANALYZER],
);

// ← NOUVEAU : conversation dédiée au sharing inter-agents
this.conversations.register(
    ConversationRole.SHARING_ANALYZER,
    sharingAnalysisSystemPrompt({}),
    modelOverrides[ConversationRole.SHARING_ANALYZER],
);

this.conversations.register(
    ConversationRole.USER_INTERACTION,
    summarySystemPrompt({}),
    modelOverrides[ConversationRole.USER_INTERACTION],
);

this.conversations.register(
    ConversationRole.INTENT_ANALYZER,
    intentAnalysisSystemPrompt({}),
    modelOverrides[ConversationRole.INTENT_ANALYZER],
);
```

Ajouter l'import du nouveau prompt :

```typescript
import {
    contextAnalysisSystemPrompt,
    sharingAnalysisSystemPrompt,  // ← NOUVEAU
    intentAnalysisPrompt,
    intentAnalysisSystemPrompt,
    summaryPrompt,
    summarySystemPrompt,
} from "../../prompts/index.ts";
```

### 7. Modifier `InformationBroker` pour utiliser `SHARING_ANALYZER`

Dans `src/classes/agent-pool/information-broker.ts`, dans la méthode `evaluateBatch()`, changer le rôle de conversation utilisé :

```typescript
// AVANT :
const batchDecisions = await this.conversations.sendOneShotJson(
    ConversationRole.CONTEXT_ANALYZER,  // ← Ancienne valeur
    prompt,
    validateBatchedSharingDecision,
    { maxTokens: 300 * targetStates.length, maxJsonAttempts: 2 },
);

// APRÈS :
const batchDecisions = await this.conversations.sendOneShotJson(
    ConversationRole.SHARING_ANALYZER,  // ← Nouvelle valeur
    prompt,
    validateBatchedSharingDecision,
    { maxTokens: 300 * targetStates.length, maxJsonAttempts: 2 },
);
```

Mettre à jour l'import :

```typescript
// AVANT :
import { ConversationRole } from "../../enums/conversation-role.enum.ts";
// Pas de changement d'import, le enum est le même, juste une nouvelle valeur.
```

### 8. Vérifier que `NotificationEngine` utilise toujours `CONTEXT_ANALYZER`

Dans `src/classes/agent-pool/notification-engine.ts`, vérifier que tous les appels utilisent `ConversationRole.CONTEXT_ANALYZER` — c'est déjà le cas et cela ne doit PAS changer :

```typescript
// src/classes/agent-pool/notification-engine.ts — evaluateWithLlm()
const decision = await this.conversations.sendOneShotJson(
    ConversationRole.CONTEXT_ANALYZER,  // ← Garde cette valeur
    prompt,
    validateNotificationDecision,
    { maxTokens: 200, maxJsonAttempts: 2 },
);
```

### 9. Mettre à jour le type `modelOverrides` dans `AgentPoolConfig`

Vérifier que le type `modelOverrides` dans `src/types/agent-pool.types.ts` accepte le nouveau rôle. Actuellement, si `modelOverrides` est typé comme `Partial<Record<ConversationRole, string>>`, il acceptera automatiquement `SHARING_ANALYZER` car c'est une nouvelle valeur de l'enum `ConversationRole`. Aucun changement de type nécessaire dans ce cas.

Si `modelOverrides` est typé différemment (ex: union de string literals), ajouter `"sharing-analyzer"` à la liste.

Vérifier dans `agent-pool.types.ts`, dans l'interface `AgentPoolConfig` :

```typescript
/**
 * Optional model overrides per conversation role.
 * Allows using different models for planning, analysis, sharing, etc.
 *
 * Example:
 * ```ts
 * modelOverrides: {
 *   [ConversationRole.PLANNER]: "anthropic/claude-opus-4.6",
 *   [ConversationRole.SHARING_ANALYZER]: "anthropic/claude-sonnet-4", // Fast model for sharing
 *   [ConversationRole.CONTEXT_ANALYZER]: "google/gemini-flash-1.5",   // Cheap model for notifications
 * }
 * ```
 */
readonly modelOverrides?: Partial<Record<ConversationRole, string>>;
```

---

## Conséquences architecturales

### Avant (1 conversation partagée)

```
                    ┌─────────────────────┐
InformationBroker ──┤  CONTEXT_ANALYZER   │──── System prompt générique
                    │  (shared history)    │     (share/notify/clarify/ignore)
NotificationEngine ─┤                     │
                    └─────────────────────┘
```

### Après (2 conversations spécialisées)

```
                    ┌─────────────────────┐
InformationBroker ──┤  SHARING_ANALYZER   │──── System prompt: cross-agent sharing
                    │  (dedicated)        │     (décisions de partage uniquement)
                    └─────────────────────┘

                    ┌─────────────────────┐
NotificationEngine ─┤  CONTEXT_ANALYZER   │──── System prompt: user notifications
                    │  (dedicated)        │     (décisions de notification uniquement)
                    └─────────────────────┘
```

### Avantages de la séparation

1. **Chaque LLM reçoit un rôle unique et clair** — pas de confusion entre sharing et notification
2. **Model overrides indépendants** — possibilité d'utiliser un modèle rapide/cheap pour les notifications (haute fréquence, faible complexité) et un modèle puissant pour le sharing (faible fréquence, haute complexité)
3. **Historiques de conversation indépendants** — prépare le terrain pour l'évolution 14 (session memory) où chaque conversation accumule du contexte utile pour son domaine
4. **Prompts plus courts et plus efficaces** — chaque system prompt ne contient que les instructions pertinentes pour son domaine, sans bruit
5. **Évolutivité** — on peut ajouter de nouvelles capacités au sharing analyzer (ex: priorité de partage, partage conditionnel) sans impacter le notification engine, et vice versa

---

## Gestion du prompt `contextAnalysisPrompt` (le user prompt)

Le user prompt `contextAnalysisPrompt` (template `CONTEXT_ANALYSIS_SOURCE`) reste **inchangé**. Il est utilisé comme template pour les user messages envoyés aux conversations one-shot. Il n'est actuellement utilisé directement que par un code potentiel d'analyse générique.

Les user prompts effectivement utilisés par le broker et le notification engine sont :
- **Broker** : `batchedSharingDecisionPrompt` (template dédié dans `batched-sharing-decision.ts`)
- **Notification** : `notificationDecisionPrompt` (template dédié dans `notification-decision.ts`)

Donc le user prompt `contextAnalysisPrompt` n'est pas impacté par cette évolution. Il reste disponible pour un usage futur ou pour des appels d'analyse générique.

---

## Retrait de l'action `clarify`

L'action `clarify` est retirée du nouveau system prompt de notification ET n'est pas incluse dans le system prompt de sharing. Elle n'existait que dans l'ancien system prompt générique et n'a jamais eu de handler dans le code.

Si l'action `clarify` devait être implémentée dans le futur, elle devrait être gérée par un système dédié (ex: un `ClarificationEngine` avec son propre `ConversationRole.CLARIFICATION`) plutôt qu'être injectée dans un prompt partagé.

Pour cette évolution, il suffit de ne pas inclure `clarify` dans les nouveaux prompts spécialisés. L'ancien prompt `CONTEXT_ANALYSIS_SOURCE` (user prompt, pas le system prompt) peut garder la mention de `clarify` si elle y figure, car ce template n'est pas activement utilisé par le broker ni le notification engine.

---

## Tests à implémenter

### Tests unitaires pour la séparation des prompts

#### Test 1 : Le nouveau system prompt `sharingAnalysisSystemPrompt` compile

- Appeler `sharingAnalysisSystemPrompt({})`
- Assert : retourne une string non-vide
- Assert : contient `"cross-agent information sharing"` ou `"sharing specialist"`
- Assert : ne contient PAS `"notify"` comme action recommandable (le mot peut apparaître en contexte négatif, ex: "you do NOT notify")
- Assert : ne contient PAS `"clarify"`

#### Test 2 : Le system prompt `contextAnalysisSystemPrompt` est spécialisé notifications

- Appeler `contextAnalysisSystemPrompt({})`
- Assert : retourne une string non-vide
- Assert : contient `"notification"` ou `"notify"`
- Assert : ne contient PAS `"share"` comme action recommandable directe
- Assert : ne contient PAS `"clarify"`
- Assert : contient `"shouldNotify"` (format JSON attendu)

#### Test 3 : Les deux system prompts sont distincts

- Appeler les deux prompts et comparer
- Assert : `contextAnalysisSystemPrompt({}) !== sharingAnalysisSystemPrompt({})`
- Assert : ils ne partagent pas le même texte d'introduction

#### Test 4 : Le nouveau rôle `SHARING_ANALYZER` existe dans l'enum

- Assert : `ConversationRole.SHARING_ANALYZER` est défini
- Assert : sa valeur est `"sharing-analyzer"`
- Assert : il est distinct de tous les autres rôles

### Tests d'intégration

#### Test 5 : `InformationBroker.evaluateBatch()` utilise `SHARING_ANALYZER`

- Mocker `ConversationManager.sendOneShotJson()`
- Appeler `broker.evaluate(delta)` avec un delta significatif et des targets actifs
- Assert : `sendOneShotJson` est appelé avec `ConversationRole.SHARING_ANALYZER` (pas `CONTEXT_ANALYZER`)

#### Test 6 : `NotificationEngine.evaluateWithLlm()` utilise `CONTEXT_ANALYZER`

- Mocker `ConversationManager.sendOneShotJson()`
- Configurer une preference de notification active
- Appeler `engine.evaluate(delta, agentState)` avec un delta au-dessus du seuil
- Assert : `sendOneShotJson` est appelé avec `ConversationRole.CONTEXT_ANALYZER` (pas `SHARING_ANALYZER`)

#### Test 7 : `AgentPool` enregistre les deux conversations

- Instancier un `AgentPool` avec la config minimale
- Assert : `conversations.has(ConversationRole.CONTEXT_ANALYZER)` retourne `true`
- Assert : `conversations.has(ConversationRole.SHARING_ANALYZER)` retourne `true`

#### Test 8 : Les model overrides fonctionnent indépendamment

- Instancier un `AgentPool` avec :
  ```typescript
  modelOverrides: {
      [ConversationRole.SHARING_ANALYZER]: "anthropic/claude-sonnet-4",
      [ConversationRole.CONTEXT_ANALYZER]: "google/gemini-flash-1.5",
  }
  ```
- Mocker le `ConversationManager` pour vérifier que chaque conversation reçoit le bon modèle
- Assert : `SHARING_ANALYZER` est enregistré avec `"anthropic/claude-sonnet-4"`
- Assert : `CONTEXT_ANALYZER` est enregistré avec `"google/gemini-flash-1.5"`

#### Test 9 : Backward compatibility — config sans model override pour SHARING_ANALYZER

- Instancier un `AgentPool` sans `modelOverrides`
- Assert : `SHARING_ANALYZER` utilise le modèle par défaut (celui de la config `model`)
- Assert : pas d'erreur

### Tests de non-régression

#### Test 10 : Les validateurs existants fonctionnent toujours

- `validateBatchedSharingDecision` accepte les mêmes données qu'avant
- `validateNotificationDecision` accepte les mêmes données qu'avant
- Aucun changement de format de réponse attendu

#### Test 11 : Le user prompt `batchedSharingDecisionPrompt` compile toujours

- Appeler avec des mock data
- Assert : compile sans erreur
- Assert : contient les sections attendues (Source Agent, Delta, Target Agents)

#### Test 12 : Le user prompt `notificationDecisionPrompt` compile toujours

- Appeler avec des mock data
- Assert : compile sans erreur
- Assert : contient les sections attendues (User Preference, Delta, Agent Task)

---

## Critères de validation

- [ ] Le nouveau rôle `ConversationRole.SHARING_ANALYZER` existe dans l'enum
- [ ] Le system prompt de `SHARING_ANALYZER` est dédié au partage inter-agents et ne mentionne pas la notification utilisateur comme action possible
- [ ] Le system prompt de `CONTEXT_ANALYZER` est dédié à l'évaluation des notifications et ne mentionne pas le partage inter-agents comme action possible
- [ ] L'action `clarify` n'apparaît dans aucun des deux nouveaux system prompts
- [ ] L'`InformationBroker` utilise `ConversationRole.SHARING_ANALYZER` pour tous ses appels LLM
- [ ] Le `NotificationEngine` continue à utiliser `ConversationRole.CONTEXT_ANALYZER` pour ses appels LLM
- [ ] L'`AgentPool` enregistre les deux conversations dans son constructeur
- [ ] Les `modelOverrides` acceptent `ConversationRole.SHARING_ANALYZER` comme clé
- [ ] Le system prompt de `SHARING_ANALYZER` contient des instructions sur les dependency types (`blocking` vs `informational`)
- [ ] Le system prompt de `SHARING_ANALYZER` contient des instructions sur la déduplication (référence à `previouslyShared`)
- [ ] Le system prompt de `CONTEXT_ANALYZER` (notifications) contient des instructions sur le principe "silence by default"
- [ ] L'export `contextAnalysisSystemPrompt` garde le même nom (backward compatibility)
- [ ] Le nouvel export `sharingAnalysisSystemPrompt` est ajouté dans `prompts/index.ts`
- [ ] L'objet `templates` dans `prompts/index.ts` est mis à jour
- [ ] Tous les tests existants passent toujours
- [ ] Les nouveaux tests couvrent la séparation, l'indépendance des model overrides, et la backward compatibility

---

## Points d'attention

1. **Le nom d'export `contextAnalysisSystemPrompt` ne change PAS** — c'est un refactoring interne. Le contenu change (spécialisé notifications au lieu de générique) mais le nom reste stable pour ne pas casser les imports existants. Le nouveau prompt s'appelle `sharingAnalysisSystemPrompt`.

2. **Le user prompt `contextAnalysisPrompt` reste inchangé** — il n'est pas activement utilisé par le broker (qui utilise `batchedSharingDecisionPrompt`) ni par le notification engine (qui utilise `notificationDecisionPrompt`). Il reste disponible pour un usage futur.

3. **Les exemples few-shot de l'évolution 04** — si l'évolution 04 a ajouté des exemples dans `contextAnalysisSystemPrompt`, il faut les adapter :
   - Les exemples de sharing (action: share) vont dans `sharingAnalysisSystemPrompt`
   - Les exemples de notification (action: notify) et d'ignore restent dans `contextAnalysisSystemPrompt`
   - Les exemples d'ignore pertinents au sharing (ex: "file read is not worth sharing") sont dupliqués dans le sharing prompt

4. **Le prompt de sharing doit mentionner `previouslyShared`** — puisque l'évolution 02 a ajouté ce champ dans les données de target, le system prompt de sharing doit indiquer au LLM de le consulter. Ajouter dans les instructions : « Check the previouslyShared field for each target to avoid redundant sharing. »

5. **Nombre total de conversations** — après cette évolution, l'`AgentPool` gère **5 conversations** :
   - `PLANNER` (planification)
   - `CONTEXT_ANALYZER` (notifications)
   - `SHARING_ANALYZER` (partage inter-agents) ← NOUVEAU
   - `USER_INTERACTION` (résumés et réponses utilisateur)
   - `INTENT_ANALYZER` (classification d'intent)
   
   C'est raisonnable. Chaque conversation est one-shot ou a un historique court, donc l'impact mémoire est négligeable.

6. **Performance** — la séparation n'ajoute pas d'appels LLM supplémentaires. Le même nombre d'appels est fait, ils vont juste vers des conversations différentes avec des system prompts plus adaptés. L'impact performance est neutre ou légèrement positif (prompts plus courts = réponses plus rapides).

7. **Migration des tests existants** — si des tests unitaires existants dans `src/classes/agent-pool/tests/` vérifient que l'`InformationBroker` utilise `ConversationRole.CONTEXT_ANALYZER`, ces assertions doivent être mises à jour pour `ConversationRole.SHARING_ANALYZER`.

8. **Le system prompt de sharing doit être cohérent avec le user prompt `batchedSharingDecisionPrompt`** — le format de réponse attendu dans le system prompt (`decisions` array) doit matcher ce que `batchedSharingDecisionPrompt` demande dans sa section `## JSON Output`. Vérifier qu'il n'y a pas de contradiction.

9. **Le `SHARING_ANALYZER` doit avoir la section dependency types** — contrairement au `CONTEXT_ANALYZER` qui ne gère pas les dépendances, le `SHARING_ANALYZER` doit inclure des instructions spécifiques sur comment traiter les `blocking` vs `informational` dependencies. C'est la valeur ajoutée de la spécialisation.

10. **Pas de changement dans le `NotificationEngine`** — cette classe utilise déjà `ConversationRole.CONTEXT_ANALYZER` et c'est toujours le bon rôle. Le seul changement visible pour elle est que le system prompt est désormais spécialisé pour les notifications, ce qui devrait améliorer la qualité des décisions.