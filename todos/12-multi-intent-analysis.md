# Évolution 12 — Support multi-intent et historique conversationnel dans l'Intent Analyzer

## Priorité : 🟡 P2

## Dépendances : Aucune (indépendante)

## Acquis des évolutions précédentes

- **Évolution 01** : L'`InformationBroker` reçoit les mappings `subtaskToAgent` / `agentToSubtask` via son constructeur. `isAgentForSubtask()` fonctionne. Le tri des candidats par dépendance est opérationnel. `findDependency()` traduit correctement entre agent IDs et subtask IDs.
- **Évolution 02** : L'`InformationBroker` maintient un `SharingHistory` indexé par agent cible. Le prompt de partage inclut les partages précédents (`previouslyShared`). `recordSharing()` est appelé après chaque injection réussie. Le type `SharingRecord` existe.
- **Évolution 03** : Le `ProjectScanner` scanne le répertoire de travail et produit un `ProjectContext`. Le planner reçoit le contexte projet.
- **Évolution 04** : Tous les prompts LLM contiennent des exemples few-shot contrastifs.
- **Évolution 05** : Le rôle `ConversationRole.SHARING_ANALYZER` existe. Le system prompt `SHARING_ANALYZER` est dédié au partage inter-agents. L'`InformationBroker` utilise `SHARING_ANALYZER`. Le system prompt `CONTEXT_ANALYZER` est désormais spécialisé pour les notifications.
- **Évolution 06** : Le notification prompt est nettoyé (plus de vérifications redondantes). Le summary prompt inclut les `CoordinationStats` et `sharingSummaries`. `durationMs` est correctement calculé.
- **Évolution 07** : Le preview dans les deltas `PROMPT_COMPLETE` est augmenté à 2000 chars. Le champ `promptResultSummary` existe dans `ContextDelta`. L'`InformationBroker` dispose de `evaluateWithFullResult()` pour les blocking deps.
- **Évolution 08** : L'injection de contexte est structurée via `StructuredContextInjection` avec `ContextInjectionPriority` et `ContextInjectionCategory`. La queue du `AgentContextManager` trie par priorité et gère l'overflow.
- **Évolution 09** : Le seuil de significance de l'`InformationBroker` est dynamique selon la phase d'exécution, le type de delta, et les dépendances.
- **Évolution 10** : Le timeout par subtask et le retry individuel sont implémentés via `subtaskTimeoutMs`, `maxSubtaskRetries`, et la classe `RetryableSubtaskExecutor`.
- **Évolution 11** : Le re-planning adaptatif est implémenté. Le planner peut être re-consulté quand le nombre de failures dépasse un seuil configurable. Le `ReplanningEngine` analyse l'état courant et produit un plan révisé.

---

## Contexte du problème

L'`AgentPool.send()` utilise un `INTENT_ANALYZER` pour classifier chaque message utilisateur en un **unique intent**. Ce système a deux limitations majeures :

### Problème 1 : Mono-intent — Un seul intent par message

Le système actuel ne peut détecter qu'un seul intent par message :

```typescript
// src/classes/agent-pool/agent-pool.ts — analyzeIntent()
const analysis = await this.conversations.sendOneShotJson(
    ConversationRole.INTENT_ANALYZER,
    prompt,
    validateIntentAnalysis,
    { maxTokens: 300 },
);
// analysis.intent est un SEUL UserIntent
```

Et dans `send()`, un `switch` dispatche vers un seul handler :

```typescript
switch (intent.intent) {
    case UserIntent.APPROVE_AGENT: { return this.handleApprovalIntent(intent); }
    case UserIntent.NEW_TASK: { /* ... */ return this.execute(taskText); }
    case UserIntent.NOTIFICATION_PREFERENCE: { /* ... */ }
    // ...
}
```

#### Scénarios perdus

1. **« Lance les tests et notifie-moi quand c'est fini »** → devrait être `new_task` + `notification_preference`, mais le système ne capture qu'un seul (probablement `new_task`, et la préférence de notification est perdue).

2. **« Arrête tout et dis-moi ce qui a été fait »** → devrait être `cancel` + `status_query`, mais le système ne capture qu'un seul.

3. **« Oui, continue et aussi utilise le port 3000 »** → devrait être `approve_agent` + `context_injection`, mais le système ne capture qu'un seul.

4. **« Commence le refactoring et rappelle-moi quand il y a des erreurs importantes »** → devrait être `new_task` + `notification_preference` (avec filtre sur erreurs).

### Problème 2 : Pas de mémoire conversationnelle

L'intent analyzer est **one-shot** (`sendOneShotJson`). Il n'a aucune mémoire des échanges précédents :

```typescript
// src/classes/agent-pool/agent-pool.ts — analyzeIntent()
const analysis = await this.conversations.sendOneShotJson(
    ConversationRole.INTENT_ANALYZER,
    prompt,
    validateIntentAnalysis,
    { maxTokens: 300 },
);
```

#### Scénarios perdus

1. **Pool** : « L'exécution est terminée. Voulez-vous lancer les tests ? »
   **User** : « oui »
   → L'analyzer ne voit que « oui » sans le contexte de la question précédente. Il classifie probablement en `approve_agent` (s'il y a des pending approvals) ou `unknown` au lieu de `new_task` (lancer les tests).

2. **User** : « Notifie-moi des erreurs »
   **Pool** : « Notifications activées. »
   **User** : « Et aussi des completions »
   → L'analyzer ne sait pas que le message fait référence aux notifications. Il pourrait classifier en `context_injection` ou `unknown` au lieu d'ajouter un type de notification.

3. **User** : « Quel est le status ? »
   **Pool** : « Agent api-dev est en cours, agent test-writer attend. »
   **User** : « Donne plus de détails sur le premier »
   → L'analyzer ne sait pas que « le premier » fait référence à « api-dev ». Pas de résolution de référence possible.

### Problème 3 : Pas de seuil de confirmation pour les intents à faible confiance

Le fallback actuel pour un intent non-reconnu est `new_task` avec `confidence: 0.5` :

```typescript
// src/classes/agent-pool/agent-pool.ts — analyzeIntent() catch block
return {
    intent: UserIntent.NEW_TASK,
    confidence: 0.5,
    parameters: { task: message },
    reasoning: "Intent analysis failed — defaulting to new_task",
};
```

Cela signifie que tout message ambigu (ex: « hmm, pas sûr ») déclenche une exécution de tâche potentiellement coûteuse (planning LLM + spawn d'agent + prompt ACP).

---

## Fichiers impactés

| Fichier | Action |
|---------|--------|
| `src/types/agent-pool.types.ts` | Modifier `IntentAnalysis` pour supporter un tableau d'intents |
| `src/enums/user-intent.enum.ts` | Aucun changement (les intents existants suffisent) |
| `src/prompts/intent-analysis.ts` | Modifier le system prompt et le user prompt pour le multi-intent |
| `src/classes/agent-pool/agent-pool.ts` | Refactorer `analyzeIntent()`, `send()`, et ajouter un historique conversationnel |
| `src/classes/agent-pool/openrouter-client.ts` | Aucun changement |
| `src/classes/agent-pool/tests/` | Tests unitaires pour le multi-intent et l'historique |

---

## Spécification détaillée des changements

### 1. Modifier le type `IntentAnalysis` dans `agent-pool.types.ts`

Remplacer le type existant par un type supportant plusieurs intents :

```typescript
/**
 * Result of the intent analyzer's classification of a user message.
 *
 * Supports multi-intent messages where the user expresses more than
 * one intention in a single message (e.g., "Start the tests and
 * notify me when done" → new_task + notification_preference).
 *
 * The `intents` array is ordered by priority: the primary intent first,
 * secondary intents after. When only one intent is detected, the array
 * contains a single element.
 */
export interface IntentAnalysis {
    /**
     * The detected intents, ordered by priority (primary first).
     * Guaranteed to have at least one entry.
     */
    readonly intents: DetectedIntent[];

    /**
     * Convenience accessor: the primary (first) intent.
     * Equivalent to `intents[0].intent`.
     * Kept for backward compatibility with code that reads `analysis.intent`.
     */
    readonly primaryIntent: UserIntent;

    /** Human-readable reasoning for the overall classification. */
    readonly reasoning: string;
}

/**
 * A single detected intent within a multi-intent analysis.
 */
export interface DetectedIntent {
    /** The classified intent type. */
    readonly intent: UserIntent;

    /** Confidence score for this specific intent (0.0 to 1.0). */
    readonly confidence: number;

    /** Extracted parameters relevant to this intent. */
    readonly parameters: Record<string, unknown>;
}
```

**Backward compatibility note** : L'ancien type avait les champs `intent`, `confidence`, `parameters`, `reasoning` à plat. Le nouveau type a `primaryIntent` + `intents[]` + `reasoning`. Il faut adapter tout le code qui lisait `analysis.intent` pour lire `analysis.primaryIntent`, et `analysis.confidence` pour `analysis.intents[0].confidence`, et `analysis.parameters` pour `analysis.intents[0].parameters`.

### 2. Ajouter un historique conversationnel dans `AgentPool`

Stocker les derniers échanges user ↔ pool pour les inclure dans le prompt d'intent :

```typescript
// src/classes/agent-pool/agent-pool.ts — nouveaux champs privés

/**
 * Recent conversation history between the user and the pool.
 * Used by the intent analyzer to resolve references and maintain
 * conversational context across consecutive send() calls.
 *
 * Each entry is a { role: "user"|"pool", content: string } pair.
 * Limited to the last N exchanges to keep the prompt bounded.
 */
private readonly conversationHistory: Array<{
    role: "user" | "pool";
    content: string;
    timestamp: string;
}> = [];

/**
 * Maximum number of conversation turns (user + pool messages combined)
 * to include in the intent analysis prompt.
 */
private static readonly MAX_CONVERSATION_HISTORY = 6;
```

#### Enregistrer les échanges dans `send()`

Au début de `send()`, enregistrer le message utilisateur :

```typescript
async send(message: string): Promise<string | AgentPoolResult> {
    this.assertNotDestroyed();
    await this.conversations.client.validateModel();

    // Record user message in conversation history
    this.recordConversation("user", message);

    this.logger.info(
        { messageLength: message.length },
        "Processing user message",
    );

    // ... analyze intent and dispatch ...

    // Record pool response in conversation history
    // (done after the response is generated)
}
```

À la fin de `send()`, avant de retourner, enregistrer la réponse de la pool :

```typescript
// After the switch/case that handles each intent:
let response: string | AgentPoolResult;

switch (intent.primaryIntent) {
    // ... existing cases, but assign to `response` instead of returning directly ...
}

// Record pool response (only for string responses, not AgentPoolResult)
if (typeof response === "string") {
    this.recordConversation("pool", response);
}

return response;
```

#### Méthode `recordConversation()`

```typescript
/**
 * Records a message in the conversation history.
 * Enforces MAX_CONVERSATION_HISTORY limit.
 */
private recordConversation(role: "user" | "pool", content: string): void {
    this.conversationHistory.push({
        role,
        content: content.slice(0, 500), // Truncate long responses
        timestamp: isoNow(),
    });

    // Enforce limit
    while (this.conversationHistory.length > AgentPool.MAX_CONVERSATION_HISTORY) {
        this.conversationHistory.shift();
    }
}
```

#### Nettoyer l'historique entre exécutions

Dans le `finally` de `execute()`, ne PAS nettoyer l'historique — les conversations entre `send()` devraient persister tant que la pool existe. L'historique est nettoyé uniquement dans `destroy()` :

```typescript
async destroy(): Promise<void> {
    // ... existing cleanup ...
    this.conversationHistory.length = 0;
}
```

### 3. Modifier le prompt d'intent analysis

#### System prompt (`INTENT_ANALYSIS_SYSTEM_SOURCE`)

Modifier le system prompt pour supporter le multi-intent et référencer l'historique :

```handlebars
You are an intent classifier for an AI agent orchestration system.

Classify user messages into one or more intents from this list:

- **new_task**: User wants to execute a new task or continue work.
- **notification_preference**: User wants to enable/disable/configure notifications.
- **status_query**: User asks about current status or progress.
- **context_injection**: User wants to provide additional context to running agents.
- **cancel**: User wants to stop current execution.
- **approve_agent**: User is approving or denying a pending agent action. ONLY use when pending approval requests exist in pool state.
- **unknown**: Intent cannot be determined.

## Multi-Intent Support
A single user message can contain MULTIPLE intents. Examples:
- "Start the tests and notify me when done" → new_task + notification_preference
- "Yes, continue, and also use port 3000" → approve_agent + context_injection
- "Stop everything and tell me what was done" → cancel + status_query

When multiple intents are detected, list them in priority order (most important first).
If only one intent is detected, return a single-element array.

## Conversation History
You may receive recent conversation history between the user and the system. Use it to:
1. Resolve references ("the first one", "that agent", "yes", "do it")
2. Understand follow-up messages in context
3. Avoid misclassifying short affirmatives — "yes" after a question about tests ≠ approve_agent (unless there are pending approvals)

## approve_agent Rules
1. Only classify as approve_agent when pending approvals are listed in pool state.
2. Brief affirmatives ("yes", "ok", "continue") with pending approvals → approve_agent.
3. Specific agent name mentioned → set `targetAgent` to that name.
4. Explicit denial ("no", "deny", "reject") → approved: false.

## Confidence Threshold
- If ALL intents have confidence < 0.5, return a single "unknown" intent.
- Do NOT guess — if the message is truly ambiguous, classify as "unknown" rather than risk an expensive wrong action.

## JSON Output
{
  "intents": [
    {
      "intent": "new_task",
      "confidence": 0.95,
      "parameters": { "task": "run the test suite" }
    },
    {
      "intent": "notification_preference",
      "confidence": 0.85,
      "parameters": { "enabled": true, "minSignificance": 0.7 }
    }
  ],
  "reasoning": "User wants to start tests AND be notified when they finish."
}

## Examples

### Single intent
Message: "Fix the bug in auth.ts"
{
  "intents": [{ "intent": "new_task", "confidence": 0.95, "parameters": { "task": "Fix the bug in auth.ts" } }],
  "reasoning": "Clear single task request."
}

### Multi-intent
Message: "Start the API migration and let me know if there are errors"
{
  "intents": [
    { "intent": "new_task", "confidence": 0.9, "parameters": { "task": "Start the API migration" } },
    { "intent": "notification_preference", "confidence": 0.85, "parameters": { "enabled": true, "minSignificance": 0.8 } }
  ],
  "reasoning": "User wants to start a task AND receive error notifications."
}

### Contextual reference (using conversation history)
History: User asked "What's the status?", Pool replied with agent details.
Message: "Tell me more about the first agent"
{
  "intents": [{ "intent": "status_query", "confidence": 0.85, "parameters": { "detail": true, "targetAgent": "<first agent name from history>" } }],
  "reasoning": "Follow-up to previous status query — 'first agent' refers to the first agent listed in the pool's previous response."
}

### Ambiguous — classify as unknown
Message: "hmm maybe"
{
  "intents": [{ "intent": "unknown", "confidence": 0.3, "parameters": {} }],
  "reasoning": "Message is too ambiguous to classify with confidence."
}
```

#### User prompt (`INTENT_ANALYSIS_SOURCE`)

Enrichir avec l'historique conversationnel :

```handlebars
Classify this user message.

## Message
<message>
{{message}}
</message>

{{#if conversationHistory.length}}
## Recent Conversation
{{#each conversationHistory}}
**{{this.role}}**: {{this.content}}
{{/each}}
{{/if}}

{{#if poolState}}
## Pool State
- **Executing**: {{poolState.executing}}
{{#if poolState.currentTask}}- **Current Task**: {{poolState.currentTask}}
{{/if}}- **Active Agents**: {{poolState.activeAgentCount}}
- **Notifications**: {{poolState.notificationsEnabled}}
{{#if poolState.pendingApprovals.length}}

## Pending Approvals (agents BLOCKED waiting for user)
{{#each poolState.pendingApprovals}}
- **{{this.agentName}}**: "{{this.toolCallTitle}}" (id: {{this.toolCallId}})
{{/each}}
If user's message could approve/deny these, include "approve_agent" in the intents.
{{/if}}
{{/if}}

Respond with JSON classification. Remember: detect ALL intents if the message expresses multiple desires.
```

### 4. Modifier le validateur `validateIntentAnalysis`

Adapter le validateur pour le nouveau format :

```typescript
function validateIntentAnalysis(data: unknown): IntentAnalysis | null {
    if (data == null || typeof data !== "object") return null;
    const obj = data as Record<string, unknown>;

    const validIntents = [
        "new_task", "notification_preference", "status_query",
        "context_injection", "cancel", "approve_agent", "unknown",
    ];

    // Validate reasoning
    if (typeof obj.reasoning !== "string") return null;

    // Validate intents array
    if (!Array.isArray(obj.intents) || obj.intents.length === 0) return null;

    const intents: DetectedIntent[] = [];

    for (const raw of obj.intents) {
        if (raw == null || typeof raw !== "object") return null;
        const item = raw as Record<string, unknown>;

        if (typeof item.intent !== "string" || !validIntents.includes(item.intent)) return null;
        if (typeof item.confidence !== "number") return null;

        intents.push({
            intent: item.intent as UserIntent,
            confidence: Math.max(0, Math.min(1, item.confidence)),
            parameters:
                item.parameters != null && typeof item.parameters === "object"
                    ? (item.parameters as Record<string, unknown>)
                    : {},
        });
    }

    return {
        intents,
        primaryIntent: intents[0].intent,
        reasoning: obj.reasoning as string,
    };
}
```

### 5. Refactorer `send()` pour supporter le multi-intent

Remplacer le `switch` mono-intent par une boucle sur les intents détectés :

```typescript
async send(message: string): Promise<string | AgentPoolResult> {
    this.assertNotDestroyed();
    await this.conversations.client.validateModel();

    this.recordConversation("user", message);

    this.logger.info(
        { messageLength: message.length },
        "Processing user message",
    );

    const analysis = await this.analyzeIntent(message);

    this.logger.info(
        {
            primaryIntent: analysis.primaryIntent,
            intentCount: analysis.intents.length,
            intents: analysis.intents.map(i => ({ intent: i.intent, confidence: i.confidence })),
        },
        `Intent classified: ${analysis.intents.map(i => i.intent).join(" + ")} ` +
        `(primary: ${analysis.primaryIntent})`,
    );

    // Process intents in order — the primary intent determines the return type.
    // Secondary intents are processed for their side effects (notifications, context, etc.)
    // but do NOT change the return value.

    let primaryResponse: string | AgentPoolResult | null = null;
    const sideEffectResponses: string[] = [];

    for (const detected of analysis.intents) {
        const result = await this.handleSingleIntent(detected, message);

        if (primaryResponse === null) {
            // First intent processed = primary → its result is the return value
            primaryResponse = result;
        } else if (typeof result === "string") {
            // Secondary intents' string responses are collected
            sideEffectResponses.push(result);
        }
        // If a secondary intent returns an AgentPoolResult, we ignore it
        // because we can't return two AgentPoolResults.
        // This is logged as a warning.
    }

    // Build final response
    let finalResponse: string | AgentPoolResult;

    if (primaryResponse === null) {
        // No intents processed (shouldn't happen due to validation, but guard)
        finalResponse = "I couldn't understand your request.";
    } else if (typeof primaryResponse === "string" && sideEffectResponses.length > 0) {
        // Combine primary string response with side effect responses
        finalResponse = [primaryResponse, ...sideEffectResponses].join("\n\n");
    } else {
        finalResponse = primaryResponse;
    }

    // Record pool response
    if (typeof finalResponse === "string") {
        this.recordConversation("pool", finalResponse);
    } else {
        this.recordConversation("pool", `Task executed: ${finalResponse.summary.slice(0, 200)}`);
    }

    return finalResponse;
}
```

### 6. Extraire `handleSingleIntent()` depuis l'ancien `switch`

Extraire la logique de dispatch dans une méthode dédiée :

```typescript
/**
 * Handles a single detected intent and returns a response.
 *
 * This method contains the same logic as the old switch/case in send(),
 * factored out to be called per-intent in the multi-intent loop.
 *
 * @param detected - The detected intent with parameters.
 * @param originalMessage - The original user message (used as fallback for task text).
 * @returns The response string or AgentPoolResult.
 */
private async handleSingleIntent(
    detected: DetectedIntent,
    originalMessage: string,
): Promise<string | AgentPoolResult> {
    switch (detected.intent) {
        case UserIntent.APPROVE_AGENT: {
            // Build a minimal IntentAnalysis for backward compat with handleApprovalIntent
            return this.handleApprovalIntent({
                intents: [detected],
                primaryIntent: detected.intent,
                reasoning: "",
            });
        }

        case UserIntent.NEW_TASK: {
            const taskText =
                typeof detected.parameters.task === "string"
                    ? detected.parameters.task
                    : originalMessage;
            return this.execute(taskText);
        }

        case UserIntent.NOTIFICATION_PREFERENCE: {
            const enabled = detected.parameters.enabled !== false;
            const minSignificance =
                typeof detected.parameters.minSignificance === "number"
                    ? detected.parameters.minSignificance
                    : 0.5;

            this.notificationEngine.setPreference({
                enabled,
                minSignificance,
            });

            return enabled
                ? `Notifications enabled (minimum significance: ${minSignificance}).`
                : "Notifications disabled.";
        }

        case UserIntent.STATUS_QUERY: {
            const state = this.getState();
            if (!state.executing) {
                return "The pool is idle. No task is currently being executed.";
            }

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

        case UserIntent.CONTEXT_INJECTION: {
            const instructions =
                typeof detected.parameters.instructions === "string"
                    ? detected.parameters.instructions
                    : originalMessage;

            if (this.managedAgents.size === 0) {
                return "No active agents to inject context into.";
            }

            let injectedCount = 0;
            for (const { agent } of this.managedAgents.values()) {
                if (agent.status !== AgentStatus.DESTROYED) {
                    try {
                        agent.injectContext(instructions);
                        injectedCount++;
                    } catch {
                        // Agent may have been destroyed
                    }
                }
            }

            return `Context injected into ${injectedCount} active agent(s).`;
        }

        case UserIntent.CANCEL: {
            if (!this._executing) {
                return "No task is currently executing.";
            }

            await this.destroyManagedAgents();
            return "Current execution cancelled. All agents destroyed.";
        }

        default:
            return (
                "I couldn't understand your request. You can:\n" +
                "- Send a task to execute\n" +
                "- Ask about current status\n" +
                "- Request notifications (e.g., 'notify me of important changes')\n" +
                "- Inject context into running agents\n" +
                "- Cancel the current execution"
            );
    }
}
```

### 7. Adapter `handleApprovalIntent()`

L'`handleApprovalIntent()` reçoit actuellement un `IntentAnalysis` complet. Adapter pour le nouveau type :

```typescript
private handleApprovalIntent(analysis: IntentAnalysis): string {
    if (!this.approvalManager.hasPending()) {
        return "No pending approval requests to resolve.";
    }

    const approvalIntent = analysis.intents.find(i => i.intent === UserIntent.APPROVE_AGENT);
    if (!approvalIntent) {
        return "No approval intent found.";
    }

    const approved = approvalIntent.parameters.approved !== false;
    const targetAgent =
        typeof approvalIntent.parameters.targetAgent === "string"
            ? approvalIntent.parameters.targetAgent
            : undefined;

    // ... rest unchanged (resolveByAgentName, resolveByAgentId, resolveAll) ...
}
```

### 8. Passer l'historique conversationnel au prompt d'intent

Dans `analyzeIntent()` :

```typescript
private async analyzeIntent(message: string): Promise<IntentAnalysis> {
    try {
        const sanitized = this.conversations.client.sanitize(message);
        const poolState = this.getState();

        const prompt = intentAnalysisPrompt({
            message: sanitized,
            poolState,
            conversationHistory: this.conversationHistory.slice(-AgentPool.MAX_CONVERSATION_HISTORY),
        });

        const analysis = await this.conversations.sendOneShotJson(
            ConversationRole.INTENT_ANALYZER,
            prompt,
            validateIntentAnalysis,
            { maxTokens: 500 },  // Increased from 300 to accommodate multi-intent
        );

        return analysis;
    } catch (error) {
        this.logger.warn(
            { error: toErrorMessage(error) },
            "Intent analysis failed, defaulting to new_task",
        );

        return {
            intents: [{
                intent: UserIntent.NEW_TASK,
                confidence: 0.5,
                parameters: { task: message },
            }],
            primaryIntent: UserIntent.NEW_TASK,
            reasoning: "Intent analysis failed — defaulting to new_task",
        };
    }
}
```

### 9. Ajouter un seuil de confirmation pour les intents à faible confiance

Dans `send()`, avant de dispatcher les intents, filtrer ceux à faible confiance :

```typescript
// Filter out low-confidence intents (below 0.4)
const MIN_INTENT_CONFIDENCE = 0.4;

const confidentIntents = analysis.intents.filter(
    i => i.confidence >= MIN_INTENT_CONFIDENCE
);

// If no confident intents remain, treat as unknown
if (confidentIntents.length === 0) {
    const response = "I'm not sure I understood your request. Could you rephrase? You can:\n" +
        "- Send a task to execute\n" +
        "- Ask about current status\n" +
        "- Request notifications\n" +
        "- Inject context into running agents\n" +
        "- Cancel the current execution";

    this.recordConversation("pool", response);
    return response;
}

// Process only confident intents
for (const detected of confidentIntents) {
    // ...
}
```

### 10. Gestion des conflits d'intents

Certaines combinaisons d'intents sont incompatibles :

- `cancel` + `new_task` → Contradictoire. Traiter `cancel` d'abord, puis ignorer `new_task`.
- `cancel` + `context_injection` → Contradictoire. Traiter `cancel` d'abord.
- Deux `new_task` → Seul le premier est traité.

Ajouter une méthode de résolution de conflits :

```typescript
/**
 * Resolves conflicts between detected intents.
 *
 * Rules:
 * 1. If `cancel` is present with `new_task`, keep only `cancel`.
 * 2. If `cancel` is present with `context_injection`, keep only `cancel`.
 * 3. If multiple `new_task` are present, keep only the first.
 * 4. `approve_agent` is always processed first if present.
 *
 * @param intents - The detected intents to resolve.
 * @returns The resolved intents, potentially reordered or filtered.
 */
private resolveIntentConflicts(intents: DetectedIntent[]): DetectedIntent[] {
    const hasCancel = intents.some(i => i.intent === UserIntent.CANCEL);

    if (hasCancel) {
        // Cancel overrides new_task and context_injection
        return intents.filter(i =>
            i.intent === UserIntent.CANCEL ||
            i.intent === UserIntent.STATUS_QUERY ||
            i.intent === UserIntent.NOTIFICATION_PREFERENCE
        );
    }

    // Move approve_agent to the front (must be processed first to unblock agents)
    const sorted = [...intents].sort((a, b) => {
        if (a.intent === UserIntent.APPROVE_AGENT) return -1;
        if (b.intent === UserIntent.APPROVE_AGENT) return 1;
        return 0;
    });

    // Deduplicate intents (keep first occurrence of each type)
    const seen = new Set<UserIntent>();
    return sorted.filter(i => {
        if (seen.has(i.intent)) return false;
        seen.add(i.intent);
        return true;
    });
}
```

Appeler cette méthode dans `send()` avant le dispatch :

```typescript
const resolvedIntents = this.resolveIntentConflicts(confidentIntents);
```

---

## Gestion de l'historique conversationnel

### Taille de l'historique

`MAX_CONVERSATION_HISTORY = 6` signifie 3 échanges user-pool maximum. C'est suffisant pour résoudre la plupart des références contextuelles sans surcharger le prompt.

### Troncation des messages

Les messages de l'historique sont tronqués à 500 caractères pour limiter l'impact sur les tokens du prompt d'intent. Le message courant est transmis en entier.

### Impact tokens

Estimation : 6 messages × 500 chars / 4 = ~750 tokens supplémentaires par appel d'intent. Acceptable car l'intent analyzer est appelé une seule fois par `send()`.

### Persistance

L'historique vit en mémoire dans l'instance de l'`AgentPool`. Il est perdu quand la pool est détruite. Il n'est PAS nettoyé entre les `execute()` pour permettre les conversations suivies comme « lance les tests » → « maintenant ajoute l'auth ».

### Cas de l'`AgentPoolResult`

Quand `send()` retourne un `AgentPoolResult` (pour un `new_task`), la réponse enregistrée dans l'historique est un résumé tronqué du summary : `"Task executed: {summary first 200 chars}"`. Cela donne au prochain appel d'intent le contexte que la tâche a été exécutée.

---

## Tests à implémenter

### Tests unitaires pour le validateur

#### Test 1 : Le validateur accepte un multi-intent valide

- Input :
  ```json
  {
    "intents": [
      { "intent": "new_task", "confidence": 0.9, "parameters": { "task": "run tests" } },
      { "intent": "notification_preference", "confidence": 0.85, "parameters": { "enabled": true } }
    ],
    "reasoning": "User wants to run tests and be notified."
  }
  ```
- Assert : retourne un `IntentAnalysis` non-null
- Assert : `result.intents.length` === 2
- Assert : `result.primaryIntent` === `UserIntent.NEW_TASK`
- Assert : `result.intents[0].confidence` === 0.9
- Assert : `result.intents[1].intent` === `UserIntent.NOTIFICATION_PREFERENCE`

#### Test 2 : Le validateur accepte un single-intent (backward compatible)

- Input :
  ```json
  {
    "intents": [{ "intent": "status_query", "confidence": 0.8, "parameters": {} }],
    "reasoning": "Status check."
  }
  ```
- Assert : retourne un `IntentAnalysis` non-null
- Assert : `result.intents.length` === 1
- Assert : `result.primaryIntent` === `UserIntent.STATUS_QUERY`

#### Test 3 : Le validateur rejette un tableau d'intents vide

- Input : `{ "intents": [], "reasoning": "..." }`
- Assert : retourne `null`

#### Test 4 : Le validateur rejette un intent avec un type invalide

- Input : `{ "intents": [{ "intent": "hack_system", "confidence": 1.0 }], "reasoning": "..." }`
- Assert : retourne `null`

#### Test 5 : Le validateur clamp les confidences dans [0, 1]

- Input : intent avec `confidence: 1.5`
- Assert : `result.intents[0].confidence` === 1.0
- Input : intent avec `confidence: -0.3`
- Assert : `result.intents[0].confidence` === 0.0

### Tests unitaires pour la résolution de conflits

#### Test 6 : `cancel` + `new_task` → seul `cancel` reste

- Input : `[{ intent: "cancel" }, { intent: "new_task" }]`
- Assert : résultat contient uniquement `cancel`

#### Test 7 : `cancel` + `status_query` → les deux restent

- Input : `[{ intent: "cancel" }, { intent: "status_query" }]`
- Assert : résultat contient `cancel` et `status_query`

#### Test 8 : `approve_agent` est toujours en premier

- Input : `[{ intent: "new_task" }, { intent: "approve_agent" }, { intent: "notification_preference" }]`
- Assert : résultat[0].intent === `approve_agent`

#### Test 9 : Les intents dupliqués sont dédupliqués

- Input : `[{ intent: "new_task", params: { task: "A" } }, { intent: "new_task", params: { task: "B" } }]`
- Assert : résultat contient un seul `new_task` (le premier)

### Tests unitaires pour le seuil de confiance

#### Test 10 : Les intents sous le seuil MIN_INTENT_CONFIDENCE sont filtrés

- Input : `[{ intent: "new_task", confidence: 0.3 }, { intent: "status_query", confidence: 0.8 }]`
- Assert : seul `status_query` est traité
- Assert : `new_task` est ignoré

#### Test 11 : Si tous les intents sont sous le seuil, réponse "unknown"

- Input : `[{ intent: "new_task", confidence: 0.2 }]`
- Assert : la réponse contient « I'm not sure I understood » ou un message d'aide

### Tests d'intégration

#### Test 12 : `send()` exécute deux intents combinés

- Mocker l'intent analyzer pour retourner `[new_task, notification_preference]`
- Appeler `pool.send("Start tests and notify me")`
- Assert : `execute()` est appelé (pour `new_task`)
- Assert : `notificationEngine.setPreference()` est appelé (pour `notification_preference`)

#### Test 13 : Le retour combine les réponses string des intents secondaires

- Mocker l'intent analyzer pour retourner `[status_query, notification_preference]`
- Appeler `pool.send("Status and enable notifications")`
- Assert : la réponse contient le status ET le message de notification enabled

#### Test 14 : L'historique conversationnel est inclus dans le prompt d'intent

- Appeler `pool.send("What's the status?")` puis `pool.send("Tell me more")`
- Mocker `sendOneShotJson` pour capturer le prompt du 2e appel
- Assert : le prompt contient la section `## Recent Conversation`
- Assert : le prompt contient « What's the status? » dans l'historique
- Assert : le prompt contient la réponse de la pool dans l'historique

#### Test 15 : L'historique est limité à MAX_CONVERSATION_HISTORY

- Appeler `pool.send()` 10 fois
- Assert : `conversationHistory.length` ≤ `MAX_CONVERSATION_HISTORY`
- Assert : les messages les plus anciens ont été évincés

#### Test 16 : L'historique est nettoyé dans `destroy()`

- Appeler `pool.send()` 3 fois puis `pool.destroy()`
- Assert : `conversationHistory` est vide

#### Test 17 : `handleSingleIntent` est appelé pour chaque intent détecté

- Mocker l'intent analyzer pour retourner 3 intents
- Spy sur `handleSingleIntent`
- Assert : `handleSingleIntent` est appelé 3 fois

#### Test 18 : Les `AgentPoolResult` retournés par les intents secondaires sont ignorés

- Mocker pour retourner `[new_task (primary), new_task (secondary)]` (après dedup, un seul reste)
- Vérifier que le dedup fonctionne et qu'un seul `new_task` est traité

### Tests de non-régression

#### Test 19 : Les appels `send()` avec un seul intent fonctionnent inchangés

- Mocker l'intent analyzer pour retourner un single intent `status_query`
- Assert : la réponse est identique au comportement d'avant le refactoring

#### Test 20 : Le fallback `new_task` fonctionne quand l'intent analysis échoue

- Mocker `sendOneShotJson` pour throw une erreur
- Assert : le fallback retourne un `IntentAnalysis` avec `primaryIntent: NEW_TASK`
- Assert : le format du fallback est conforme au nouveau type (intents array)

#### Test 21 : Le prompt d'intent compile avec et sans historique conversationnel

- Appeler `intentAnalysisPrompt({ message: "test", poolState: {...}, conversationHistory: [] })`
- Assert : compile sans erreur
- Assert : ne contient PAS `## Recent Conversation` (array vide)

- Appeler avec `conversationHistory: [{ role: "user", content: "hi" }]`
- Assert : contient `## Recent Conversation`

---

## Critères de validation

- [ ] Le type `IntentAnalysis` supporte un tableau `intents: DetectedIntent[]`
- [ ] Le champ `primaryIntent` existe pour la backward compatibility
- [ ] Le type `DetectedIntent` a les champs `intent`, `confidence`, `parameters`
- [ ] Le validateur `validateIntentAnalysis` accepte le format multi-intent
- [ ] Le validateur rejette les intents invalides, les tableaux vides, et les confidences hors bornes
- [ ] Le system prompt du `INTENT_ANALYZER` documente le multi-intent, l'historique, et le seuil de confiance
- [ ] Le user prompt inclut `conversationHistory` quand disponible
- [ ] L'historique conversationnel est maintenu dans `AgentPool` (max `MAX_CONVERSATION_HISTORY` entrées)
- [ ] Les messages user et les réponses pool sont enregistrés dans l'historique
- [ ] L'historique est tronqué à 500 chars par message
- [ ] L'historique est nettoyé dans `destroy()` mais PAS entre les `execute()`
- [ ] `send()` dispatche tous les intents détectés, pas seulement le premier
- [ ] Le résultat de `send()` est déterminé par le primary intent
- [ ] Les réponses string des intents secondaires sont concaténées au résultat string
- [ ] Les intents avec `confidence < MIN_INTENT_CONFIDENCE` (0.4) sont filtrés
- [ ] Si tous les intents sont sous le seuil, un message d'aide est retourné (pas un fallback `new_task`)
- [ ] Les conflits d'intents sont résolus (`cancel` override `new_task`, `approve_agent` en premier, dedup)
- [ ] `maxTokens` est augmenté de 300 à 500 pour accommoder les réponses multi-intent
- [ ] Le fallback en cas d'erreur d'intent analysis est conforme au nouveau type
- [ ] Tous les tests existants passent toujours
- [ ] Les nouveaux tests couvrent le multi-intent, l'historique, le seuil de confiance, et la résolution de conflits

---

## Points d'attention

1. **Backward compatibility du type `IntentAnalysis`** — L'ancien code utilise `analysis.intent`, `analysis.confidence`, `analysis.parameters`. Ces champs n'existent plus directement. Il faut migrer tout le code vers `analysis.primaryIntent`, `analysis.intents[0].confidence`, `analysis.intents[0].parameters`. Chercher toutes les occurrences dans le codebase avec `grep`.

2. **L'`handleApprovalIntent()` attend un `IntentAnalysis` complet** — Adapter pour utiliser `analysis.intents.find(i => i.intent === UserIntent.APPROVE_AGENT)` au lieu de `analysis.parameters`.

3. **Les exemples few-shot de l'évolution 04** dans le system prompt d'intent — Ils utilisent l'ancien format single-intent. Il faut les remplacer par le nouveau format multi-intent (wrapping dans un array `intents: [...]`). Tous les exemples doivent utiliser le nouveau schema.

4. **Le `maxTokens: 500`** (augmenté de 300) est nécessaire car le JSON multi-intent est plus long. Un message avec 3 intents produit ~200-300 tokens de JSON. Avec le reasoning, 500 est un bon budget.

5. **La résolution de conflits est heuristique** — Elle ne fait pas appel au LLM. C'est voulu : les conflits sont structurels (cancel vs new_task) et ne nécessitent pas de raisonnement sémantique. Le LLM a déjà fait son travail en détectant les intents.

6. **Le seuil `MIN_INTENT_CONFIDENCE = 0.4` est une constante** — Dans le futur, il pourrait être configurable dans `AgentPoolConfig`. Pour cette évolution, une constante suffit.

7. **Le `recordConversation` tronque à 500 chars** — C'est suffisant pour la résolution de références. Les status queries longues (liste de tous les agents) sont tronquées mais le début (qui contient le titre de la tâche et la stratégie) est conservé.

8. **L'historique n'est PAS nettoyé entre les `execute()`** — C'est voulu. Un utilisateur qui dit « lance les tests » puis « maintenant ajoute l'auth » attend que la pool se souvienne de la conversation. L'historique est nettoyé uniquement quand la pool est détruite.

9. **Le `send()` refactoré assigne à une variable `response`** au lieu de `return` directement dans chaque case. C'est nécessaire pour enregistrer la réponse dans l'historique après le dispatch. Ce changement de pattern (assign + return at end vs return in each case) doit être fait soigneusement pour ne pas introduire de bugs de flow control.

10. **Les intents secondaires qui retournent un `AgentPoolResult`** (ex: deux `new_task` non-dédupliqués) sont un edge case. La résolution de conflits devrait empêcher ce cas, mais si ça arrive, seul le résultat du primary intent est retourné. Un warning est loggé pour les intents secondaires qui retournent un `AgentPoolResult`.

11. **Interactions avec l'évolution 10 (retry) et 11 (re-planning)** — Si un intent `new_task` déclenche un `execute()` qui échoue et retry, les intents secondaires (ex: notification_preference) sont déjà traités avant le retry. Pas de re-traitement des intents secondaires.

12. **Performance** — L'ajout de l'historique conversationnel (~750 tokens) et l'augmentation de `maxTokens` (300 → 500) augmentent le coût de chaque `send()` d'environ 1000-1250 tokens. C'est acceptable car `send()` est appelé par l'utilisateur (fréquence humaine, pas automatique).