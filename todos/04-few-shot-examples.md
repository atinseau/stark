# Évolution 04 — Ajout d'exemples Few-Shot dans tous les prompts LLM

## Priorité : 🟠 P1

## Dépendances : Évolution 03 (Contexte projet dans le planner)

## Acquis des évolutions précédentes

- **Évolution 01** : L'`InformationBroker` reçoit les mappings `subtaskToAgent` / `agentToSubtask`. La méthode `isAgentForSubtask()` fonctionne. Le tri des candidats par dépendance est opérationnel. `findDependency()` traduit correctement entre agent IDs et subtask IDs.
- **Évolution 02** : L'`InformationBroker` maintient un `SharingHistory` indexé par agent cible. Le prompt de partage inclut les partages précédents (`previouslyShared`). `recordSharing()` est appelé après chaque injection réussie. Le type `SharingRecord` existe.
- **Évolution 03** : Le `ProjectScanner` scanne le répertoire de travail et produit un `ProjectContext`. Le planner reçoit le contexte projet (arborescence, langages, frameworks, fichiers de config résumés). Le system prompt du planner contient des instructions sur l'utilisation du contexte projet. Les prompts Handlebars intègrent le bloc `{{#if projectContext}}`.

---

## Contexte du problème

Tous les prompts LLM du système (planning, sharing, notification, intent, summary, context analysis) fonctionnent exclusivement avec des **instructions abstraites** et des **schémas JSON**. Aucun ne contient d'**exemples concrets** illustrant les réponses attendues.

Les LLM sont considérablement plus performants avec des exemples (few-shot prompting) qu'avec des instructions seules (zero-shot). L'ajout d'exemples :

1. **Réduit l'ambiguïté** — le LLM voit exactement le format et le niveau de détail attendus
2. **Réduit les erreurs de parsing JSON** — moins de corrections nécessaires via `chatJson`
3. **Calibre le ton et la granularité** — le LLM s'aligne sur le style des exemples
4. **Accélère la convergence** — moins de tokens gaspillés en hésitation et reformulation
5. **Réduit les retries** — les validateurs (`validateTaskAnalysis`, etc.) reçoivent des réponses plus conformes dès le premier essai

### Mesure de l'impact attendu

Actuellement, `OpenRouterClient.chatJson()` fait jusqu'à `maxJsonAttempts` (défaut 3) tentatives si le JSON est invalide. Chaque retry coûte ~200-500 tokens supplémentaires. Avec des exemples bien choisis, le taux de première réponse valide devrait passer de ~70% à ~90%+, réduisant le coût moyen de chaque décision LLM.

---

## Fichiers impactés

| Fichier | Action |
|---------|--------|
| `src/prompts/planning.ts` | Ajouter des exemples few-shot dans le system prompt |
| `src/prompts/batched-sharing-decision.ts` | Ajouter un exemple de décision de partage |
| `src/prompts/sharing-decision.ts` | Ajouter un exemple de décision unitaire |
| `src/prompts/notification-decision.ts` | Ajouter un exemple de décision de notification |
| `src/prompts/intent-analysis.ts` | Ajouter des exemples de classification d'intent |
| `src/prompts/context-analysis.ts` | Ajouter un exemple d'analyse de delta |
| `src/prompts/summary.ts` | Ajouter un exemple de résumé structuré |

---

## Principes de conception des exemples

### 1. Exemples contrastifs

Chaque prompt doit contenir **au moins un exemple positif et un exemple négatif** (ou deux exemples contrastifs) pour montrer la frontière de décision. Par exemple pour le planner : un cas où `multi` est justifié ET un cas où `single` est le bon choix malgré une tâche qui semble complexe.

### 2. Concision

Les exemples doivent être courts (50-150 tokens chacun). Ils montrent la structure et le niveau de détail, pas un cas exhaustif. Les champs longs (`prompt`, `reasoning`, `information`) sont tronqués avec `...` pour indiquer qu'ils seraient plus longs en pratique.

### 3. Réalisme

Les exemples utilisent des scénarios crédibles de développement logiciel (API REST, tests, documentation, frontend/backend). Pas de cas artificiels.

### 4. Placement

Les exemples sont placés **après les règles et avant le schema JSON** dans les system prompts, ou **à la fin du system prompt** pour les prompts plus courts. Le positionnement après les règles permet au LLM de voir les règles comme le cadre et les exemples comme l'application.

### 5. Balisage

Les exemples sont délimités par des balises claires pour que le LLM distingue les instructions des démonstrations :

```
## Examples

### Example 1: Single-agent task (correct)
**Task**: "Fix the typo in README.md line 42"
**Response**:
{...}

### Example 2: Multi-agent task (correct)
**Task**: "Build a REST API with authentication, tests, and API documentation"
**Response**:
{...}
```

---

## Spécification détaillée des changements

### 1. Planning System Prompt (`planning.ts`)

Ajouter dans `PLANNING_SYSTEM_SOURCE`, après la section `## Project Context Usage` (ajoutée en évolution 03) et avant la section `## JSON Schema` :

```handlebars
## Examples

### Example 1: Single-agent — simple task
**Task**: "Fix the typo in README.md on line 42 — 'recieve' should be 'receive'"
**Response**:
{
  "strategy": "single",
  "complexity": "simple",
  "reasoning": "This is a trivial single-file text fix. No decomposition needed.",
  "subtasks": [
    {
      "id": "fix-typo",
      "prompt": "Open README.md and fix the typo on line 42: change 'recieve' to 'receive'. Save the file.",
      "role": "editor",
      "dependencies": [],
      "priority": 1
    }
  ],
  "dependencies": [],
  "parallelismBenefit": 0.0
}

### Example 2: Single-agent — deceptively complex but single-concern
**Task**: "Refactor the authentication module to use JWT instead of sessions"
**Response**:
{
  "strategy": "single",
  "complexity": "moderate",
  "reasoning": "Although this touches multiple files, authentication is a single cohesive concern. Splitting it across agents would create coordination overhead without benefit — the refactor requires understanding the full auth flow as a unit.",
  "subtasks": [
    {
      "id": "refactor-auth",
      "prompt": "Refactor the authentication module from session-based to JWT-based authentication. Update the middleware, login/logout handlers, token generation, and any route guards. Ensure all existing auth tests are updated to reflect the new approach.",
      "role": "auth-developer",
      "dependencies": [],
      "priority": 1
    }
  ],
  "dependencies": [],
  "parallelismBenefit": 0.0
}

### Example 3: Multi-agent — genuinely separable concerns
**Task**: "Build a REST API for user management with full test coverage and OpenAPI documentation"
**Response**:
{
  "strategy": "multi",
  "complexity": "complex",
  "reasoning": "This task has three clearly distinct deliverables: the API implementation, the test suite, and the API documentation. The tests depend on the API being implemented first (blocking), while documentation can reference the API structure but can start in parallel with partial information (informational dependency).",
  "subtasks": [
    {
      "id": "api-impl",
      "prompt": "Implement a REST API for user management with the following endpoints: GET /users, GET /users/:id, POST /users, PUT /users/:id, DELETE /users/:id. Use Express.js with TypeScript. Include input validation, error handling, and proper HTTP status codes. Create the route handlers in src/routes/users.ts and the data models in src/models/user.ts.",
      "role": "api-developer",
      "dependencies": [],
      "priority": 1
    },
    {
      "id": "test-suite",
      "prompt": "Write comprehensive integration tests for the user management REST API. Cover all CRUD endpoints (GET /users, GET /users/:id, POST /users, PUT /users/:id, DELETE /users/:id) including success cases, validation errors, not-found cases, and edge cases. Use Jest with supertest. Place tests in tests/users.test.ts.",
      "role": "test-writer",
      "dependencies": ["api-impl"],
      "priority": 2
    },
    {
      "id": "api-docs",
      "prompt": "Create OpenAPI 3.0 documentation for the user management API. Document all endpoints, request/response schemas, error formats, and include usage examples. Output as docs/openapi.yaml.",
      "role": "documentation-author",
      "dependencies": ["api-impl"],
      "priority": 3
    }
  ],
  "dependencies": [
    { "from": "api-impl", "to": "test-suite", "type": "blocking" },
    { "from": "api-impl", "to": "api-docs", "type": "informational" }
  ],
  "parallelismBenefit": 0.6
}

### Anti-pattern: Artificial splitting (DO NOT do this)
**Task**: "Create a utility function that converts temperatures"
**BAD response** (do NOT imitate):
{
  "strategy": "multi",
  "subtasks": [
    { "id": "celsius-to-fahrenheit", "prompt": "Write celsius to fahrenheit...", "role": "converter-1" },
    { "id": "fahrenheit-to-celsius", "prompt": "Write fahrenheit to celsius...", "role": "converter-2" }
  ]
}
**Why it's bad**: These are trivially related functions that belong in the same file. Splitting wastes resources and creates unnecessary coordination.
```

### 2. Batched Sharing Decision Prompt (`batched-sharing-decision.ts`)

Ajouter dans `BATCHED_SHARING_DECISION_SOURCE`, après la section `## Criteria` et avant `## JSON Output` :

```handlebars
## Example

**Source agent** "api-developer" just completed writing `src/routes/users.ts` with endpoints GET/POST/PUT/DELETE /users.
**Target agent** "test-writer" is working on writing integration tests for the API.
**Previously shared**: Nothing yet.

Good decision:
{
  "decisions": [
    {
      "targetAgentId": "agent-test-writer-id",
      "shouldShare": true,
      "reasoning": "The test writer needs to know the exact endpoint signatures and response formats to write accurate tests. This is a blocking dependency.",
      "information": "The users API has been implemented in src/routes/users.ts with the following endpoints: GET /users (returns User[]), POST /users (body: {name, email}, returns User), PUT /users/:id (body: partial User, returns User), DELETE /users/:id (returns 204). User model: {id: string, name: string, email: string, createdAt: Date}."
    }
  ]
}

**Same source agent** later writes `src/routes/products.ts`.
**Previously shared to test-writer**: "[file_written] The users API has been implemented in src/routes/users.ts with the following endpoints..."

Good decision (avoids redundancy):
{
  "decisions": [
    {
      "targetAgentId": "agent-test-writer-id",
      "shouldShare": true,
      "reasoning": "New products API endpoints are relevant for the test writer. User API info was already shared — only sharing the NEW products information.",
      "information": "A new products API has been added in src/routes/products.ts: GET /products, POST /products (body: {name, price}), GET /products/:id. Product model: {id: string, name: string, price: number}."
    }
  ]
}
```

### 3. Sharing Decision Prompt (`sharing-decision.ts`)

Ajouter dans `SHARING_DECISION_SOURCE`, après `## Criteria` et avant `## JSON Output` :

```handlebars
## Examples

### Share: Relevant new information
Source "backend-dev" completed database schema. Target "api-dev" needs to build endpoints.
{
  "shouldShare": true,
  "reasoning": "The API developer needs the exact schema to implement correct endpoint handlers and validation.",
  "information": "Database schema created: users(id UUID PK, name TEXT NOT NULL, email TEXT UNIQUE, created_at TIMESTAMPTZ). Migration file: db/migrations/001_users.sql."
}

### Don't share: Irrelevant to target's task
Source "frontend-dev" updated CSS styling. Target "test-writer" writes backend tests.
{
  "shouldShare": false,
  "reasoning": "CSS styling changes are purely visual and have no impact on backend test logic. Sharing would be noise."
}
```

### 4. Notification Decision Prompt (`notification-decision.ts`)

Ajouter dans `NOTIFICATION_DECISION_SOURCE`, après `## Criteria` et avant `## JSON Output` :

```handlebars
## Examples

### Notify: Significant milestone
Delta: Agent "api-developer" completed all API endpoints successfully.
{
  "shouldNotify": true,
  "reasoning": "The API implementation is a major milestone that the user likely wants to know about — it represents completion of a significant portion of the task.",
  "message": "✅ api-developer has finished implementing all REST API endpoints (users CRUD + products CRUD)."
}

### Don't notify: Routine progress
Delta: Agent "test-writer" read file src/routes/users.ts.
{
  "shouldNotify": false,
  "reasoning": "Reading a file is routine agent behavior. Notifying about every file read would be excessive noise."
}

### Notify: Error requiring attention
Delta: Agent "api-developer" encountered an error — npm package 'pg' not found.
{
  "shouldNotify": true,
  "reasoning": "A missing dependency blocks the agent's progress and may require user intervention to resolve.",
  "message": "⚠️ api-developer hit an error: npm package 'pg' is not installed. The agent may need the dependency added to proceed."
}
```

### 5. Intent Analysis System Prompt (`intent-analysis.ts`)

Ajouter dans `INTENT_ANALYSIS_SYSTEM_SOURCE`, après les `## approve_agent Rules` et avant `## JSON Output` :

```handlebars
## Examples

### New task
Message: "Create a login page with email and password fields"
{
  "intent": "new_task",
  "confidence": 0.95,
  "parameters": { "task": "Create a login page with email and password fields" },
  "reasoning": "Clear request to build something new."
}

### Status query
Message: "How's it going?"
{
  "intent": "status_query",
  "confidence": 0.85,
  "parameters": {},
  "reasoning": "Informal progress check."
}

### Notification preference
Message: "Let me know when the tests finish"
{
  "intent": "notification_preference",
  "confidence": 0.9,
  "parameters": { "enabled": true, "minSignificance": 0.7 },
  "reasoning": "User wants to be notified about task completion."
}

### Approval (with pending approvals)
Message: "yes"
Pool state: 1 pending approval for agent "backend-dev"
{
  "intent": "approve_agent",
  "confidence": 0.9,
  "parameters": { "approved": true, "scope": "all" },
  "reasoning": "Short affirmative with pending approvals — interpreted as blanket approval."
}

### Context injection
Message: "By the way, use port 3000 for the server, not 8080"
Pool state: executing, 2 active agents
{
  "intent": "context_injection",
  "confidence": 0.9,
  "parameters": { "instructions": "Use port 3000 for the server instead of 8080", "targetAgent": "all" },
  "reasoning": "User providing additional constraint to active agents."
}
```

### 6. Context Analysis System Prompt (`context-analysis.ts`)

Ajouter dans `CONTEXT_ANALYSIS_SYSTEM_SOURCE`, après la section `## Actions` et avant `## JSON Output` :

```handlebars
## Examples

### Ignore: Low-value delta
Agent "api-dev" read file package.json.
{
  "action": "ignore",
  "reasoning": "Reading a config file is routine exploration. No action needed.",
  "significance": 0.1
}

### Share: Output relevant to another agent
Agent "api-dev" completed implementing the users REST API with all CRUD endpoints.
Another agent "test-writer" is working on writing tests for the API.
{
  "action": "share",
  "reasoning": "The test writer needs the API structure to write accurate tests. The implementation details are directly relevant.",
  "targetAgentId": "agent-test-writer-id",
  "content": "Users API implemented in src/routes/users.ts with GET/POST/PUT/DELETE /users endpoints. User model: {id, name, email, createdAt}.",
  "significance": 0.8
}

### Notify: Critical error
Agent "deploy-agent" encountered error: permission denied writing to /etc/nginx/conf.d/.
{
  "action": "notify",
  "reasoning": "Permission error on system directory — agent cannot proceed without user intervention.",
  "content": "Agent deploy-agent hit a permission error writing to /etc/nginx/conf.d/. Manual intervention may be needed.",
  "significance": 1.0
}
```

### 7. Summary System Prompt (`summary.ts`)

Remplacer le `SUMMARY_SYSTEM_SOURCE` minimaliste par une version avec structure et exemple :

```handlebars
You are a technical summarizer for an AI agent orchestration system.

Produce a concise, structured summary of a completed task execution.

## Structure
Your summary should cover (in order, skip sections that don't apply):
1. **Outcome** — One sentence: did the task succeed, partially succeed, or fail?
2. **What was built** — Key deliverables, files created/modified.
3. **Architecture decisions** — Notable technical choices made by agents.
4. **Issues encountered** — Errors, retries, or workarounds (if any).
5. **Inter-agent coordination** — What information was shared between agents and why (multi-agent only).
6. **Recommendations** — Suggested next steps or improvements (if relevant).

## Example

### Input
Task: "Build a REST API with tests" | Strategy: multi | 2 agents | Duration: 45s

### Output
**Outcome**: Task completed successfully — REST API and test suite both delivered.

**What was built**:
- `src/routes/users.ts` — CRUD endpoints for user management (GET, POST, PUT, DELETE)
- `src/models/user.ts` — User data model with validation
- `tests/users.test.ts` — 12 integration tests covering all endpoints and error cases

**Architecture decisions**: Used Express.js with Zod for input validation. Tests use Jest with supertest for HTTP assertions.

**Inter-agent coordination**: API structure (endpoint signatures and User model schema) was shared from api-developer to test-writer after implementation completed, enabling accurate test assertions.

**Recommendations**: Consider adding authentication middleware and rate limiting before production deployment.

Respond in plain text with Markdown formatting. No JSON.
```

---

## Impact sur les tokens

### Estimation de l'augmentation par prompt

| Prompt | Tokens ajoutés (estimé) | Fréquence d'appel | Impact total par exécution |
|--------|------------------------|-------------------|---------------------------|
| Planning system | ~600 tokens | 1x par exécution | ~600 tokens |
| Batched sharing | ~300 tokens | 1-10x par exécution (one-shot, dans le user message) | ~300-3000 tokens |
| Sharing decision | ~200 tokens | Rarement utilisé (le batched est préféré) | ~0-200 tokens |
| Notification | ~250 tokens | 1-5x par exécution (one-shot) | ~250-1250 tokens |
| Intent analysis | ~350 tokens | 1x par appel `send()` | ~350 tokens |
| Context analysis | ~300 tokens | System prompt, chargé 1x | ~300 tokens |
| Summary system | ~300 tokens | 1x par exécution | ~300 tokens |

### Estimation totale

- **Cas single-agent** : ~1500 tokens supplémentaires par exécution (planning + summary + éventuels intents)
- **Cas multi-agent typique (3 agents)** : ~3000-5000 tokens supplémentaires par exécution
- **Économies via réduction des retries** : ~500-1500 tokens économisés par exécution (moins de corrections JSON)

**Bilan net** : augmentation modeste de ~1000-3500 tokens par exécution, largement compensée par l'amélioration de qualité des réponses et la réduction des retries.

---

## Placement des exemples dans les prompts

### Règle : exemples dans les system prompts vs user prompts

- **System prompts** (planning, context analysis, intent analysis, summary) : les exemples vont dans le **system prompt**. Ils font partie des instructions permanentes du rôle et sont chargés une seule fois.
- **User prompts one-shot** (batched sharing, notification decision) : les exemples vont dans le **template user**. Comme ces prompts sont one-shot (pas d'historique), le system prompt est rechargé à chaque appel de toute façon, donc la distinction est moindre. Mais placer les exemples dans le user prompt permet de les contextualiser davantage si nécessaire dans le futur.

### Règle : ne pas mettre d'exemples dans les templates qui reçoivent des données dynamiques volumineuses

Le `taskAnalysisPrompt` (user prompt du planner) reçoit déjà la tâche, le contexte projet (depuis évolution 03), les contraintes, etc. Ne PAS y ajouter d'exemples — ils vont dans le system prompt (`planningSystemPrompt`).

Idem pour `contextAnalysisPrompt` (user prompt du context analyzer) qui reçoit le delta, l'état des agents, etc.

---

## Tests à implémenter

### Tests unitaires par prompt

Pour chaque prompt modifié, vérifier que le template Handlebars compile et produit le output attendu :

#### Test 1 : Planning system prompt contient les exemples

- Appeler `planningSystemPrompt({})` (pas de paramètres dynamiques dans le system prompt)
- Assert : le résultat contient `"Example 1: Single-agent"`
- Assert : le résultat contient `"Example 2: Single-agent — deceptively complex"`
- Assert : le résultat contient `"Example 3: Multi-agent"`
- Assert : le résultat contient `"Anti-pattern: Artificial splitting"`
- Assert : le résultat contient les JSON exemples valides (parser chaque bloc JSON)

#### Test 2 : Batched sharing prompt contient l'exemple

- Appeler `batchedSharingDecisionPrompt({...mockData})` avec des données de test
- Assert : le résultat contient `"Example"` ou `"example"`
- Assert : le résultat contient `"avoids redundancy"`

#### Test 3 : Notification prompt contient les exemples

- Appeler `notificationDecisionPrompt({...mockData})` avec des données de test
- Assert : le résultat contient `"Notify: Significant milestone"`
- Assert : le résultat contient `"Don't notify: Routine progress"`

#### Test 4 : Intent system prompt contient les exemples

- Appeler `intentAnalysisSystemPrompt({})` 
- Assert : le résultat contient au moins 4 exemples distincts (new_task, status_query, notification_preference, approve_agent)
- Assert : chaque exemple contient un bloc JSON parsable

#### Test 5 : Context analysis system prompt contient les exemples

- Appeler `contextAnalysisSystemPrompt({})`
- Assert : le résultat contient `"Ignore"`, `"Share"`, et `"Notify"` examples
- Assert : chaque exemple contient un bloc JSON parsable

#### Test 6 : Summary system prompt contient la structure et l'exemple

- Appeler `summarySystemPrompt({})`
- Assert : le résultat contient `"## Structure"` et `"## Example"`
- Assert : le résultat contient les sections attendues (Outcome, What was built, etc.)

### Tests de validation JSON dans les exemples

#### Test 7 : Tous les blocs JSON dans les exemples sont syntaxiquement valides

Pour chaque prompt compilé :
- Extraire tous les blocs JSON (entre `{` et `}` dans les sections `Example`)
- Parser chacun avec `JSON.parse()`
- Assert : aucune erreur de parsing

Ce test est important car une erreur de syntaxe dans un exemple few-shot **dégraderait** la performance au lieu de l'améliorer.

### Tests de non-régression

#### Test 8 : Les prompts existants sans exemples fonctionnent toujours

- Pour chaque prompt, vérifier que les parties existantes (instructions, schema, règles) sont toujours présentes et inchangées
- Les exemples sont un **ajout**, pas un remplacement

#### Test 9 : Les validateurs existants acceptent les réponses des exemples

- Pour le planning : passer les JSON des exemples dans `validateTaskAnalysis()` → ils doivent retourner un objet valide
- Pour le sharing : passer les JSON dans `validateBatchedSharingDecision()` → valide
- Pour l'intent : passer les JSON dans `validateIntentAnalysis()` → valide
- Pour la notification : passer les JSON dans `validateNotificationDecision()` → valide

Ce test garantit que les exemples ne montrent pas un format que le validateur rejetterait.

---

## Critères de validation

- [ ] Chaque prompt LLM contient au moins 2 exemples contrastifs (un positif, un négatif ou deux cas différents)
- [ ] Le planning prompt contient un anti-pattern explicite (mauvais split) avec explication
- [ ] Le summary prompt est restructuré avec des sections nommées et un exemple complet
- [ ] Tous les blocs JSON dans les exemples sont syntaxiquement valides et parsables
- [ ] Tous les JSON des exemples passent les validateurs correspondants (`validateTaskAnalysis`, etc.)
- [ ] Les exemples sont concis (~50-150 tokens chacun, hors JSON)
- [ ] Les exemples utilisent des scénarios réalistes de développement logiciel
- [ ] Les parties existantes des prompts (instructions, règles, schema) sont intactes
- [ ] L'augmentation de tokens par exécution est estimée à < 5000 tokens au total
- [ ] Les exemples sont clairement délimités avec des headers (`### Example 1: ...`)
- [ ] Tous les tests existants passent toujours
- [ ] Les nouveaux tests couvrent la présence, la validité JSON, et la compatibilité des exemples

---

## Points d'attention

1. **Ne pas surcharger** — 2-4 exemples par prompt maximum. Au-delà, les exemples se font concurrence et le LLM peut se perdre ou copier un exemple au lieu de raisonner.
2. **Les exemples du planner sont les plus critiques** — le planner reçoit le prompt le plus complexe et produit la décision la plus impactante. Investir le plus de soin dans ces exemples.
3. **Les exemples du sharing doivent montrer la déduplication** — puisque l'évolution 02 a ajouté le champ `previouslyShared`, les exemples de sharing doivent montrer comment l'historique influence la décision (ne pas re-partager ce qui a déjà été dit).
4. **Attention aux exemples trop spécifiques** — si un exemple mentionne « Express.js » et que le projet utilise Fastify, le LLM pourrait être biaisé. Utiliser des technologies variées dans les exemples ou des termes génériques quand le choix n'importe pas.
5. **Le summary prompt change significativement** — l'ancien system prompt était 2 lignes. Le nouveau est structuré avec des sections et un exemple. S'assurer que les appels à `summarySystemPrompt({})` n'attendent pas un format spécifique de la réponse.
6. **Les exemples JSON doivent utiliser des IDs réalistes** — utiliser `"agent-test-writer-id"` plutôt que `"abc123"` pour que le LLM comprenne le pattern de nommage.
7. **Ne pas inclure le bloc `## JSON Output` dans les exemples** — les exemples montrent le JSON directement, le schema formel reste dans sa propre section. Pas de duplication du schema.
8. **Encoding des exemples dans Handlebars** — les exemples sont du texte statique (pas de variables Handlebars). Ils sont compilés une seule fois avec le template et ne changent jamais. Comme `noEscape: true` est déjà configuré sur tous les templates, les caractères spéciaux dans les exemples (guillemets, accolades) ne seront pas échappés.
9. **Validation croisée** — s'assurer que l'exemple du planner multi-agent avec `"dependencies": ["api-impl"]` dans le subtask ET `"dependencies": [{ "from": "api-impl", "to": "test-suite" }]` au niveau global est cohérent avec la validation sémantique de `semanticValidationErrors()`. Les deux systèmes de dépendances (dans le subtask et au niveau global) doivent être alignés dans l'exemple.