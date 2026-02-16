# 🧠 AgentPool — Orchestration multi-agents adaptative

> `AgentPool` est le système d'orchestration intelligent de Stark.
> Il analyse dynamiquement chaque tâche pour décider de sa propre architecture
> d'exécution : un seul agent ou plusieurs agents spécialisés coordonnés.

---

## Rôle et importance

L'`AgentPool` est la **couche supérieure** d'orchestration de Stark. Là où l'`Agent` gère
un seul processus IA, l'`AgentPool` pilote un ensemble d'agents en fonction de la nature
de la tâche. Il remplit **8 missions fondamentales** :

| Mission | Description |
|---------|-------------|
| 🧠 **Planification adaptative** | Analyse chaque tâche via LLM pour décider : single ou multi-agent |
| 🔀 **Exécution parallèle conditionnelle** | Respecte le graphe de dépendances entre subtasks |
| 🧵 **Conversations LLM isolées** | 4 conversations séparées pour éviter la contamination token |
| 📡 **Suivi de contexte temps réel** | Capture et distille chaque événement agent en deltas structurés |
| 🔗 **Partage d'information conditionnel** | LLM-driven, jamais automatique, agents inconscients les uns des autres |
| 🔔 **Notifications silence-by-default** | Aucun message sans demande explicite de l'utilisateur |
| 🛡️ **Protection injection prompt** | Double couche : patterns regex + wrapping |
| 🔐 **OpenRouter exclusif** | Provider non interchangeable, retry exponentiel, validation JSON stricte |

```mermaid
graph TB
    subgraph "🧠 AgentPool"
        direction TB
        AP[<b>AgentPool</b><br/><em>extends EventEmitter</em>]

        subgraph "Conversations LLM isolées"
            direction LR
            PLAN[🗺️ Planner]
            CTXA[🔍 Context<br/>Analyzer]
            INTENT[🎯 Intent<br/>Analyzer]
            UI[💬 User<br/>Interaction]
        end

        subgraph "Moteurs décisionnels"
            direction LR
            TP[TaskPlanner]
            IB[InformationBroker]
            NE[NotificationEngine]
        end

        subgraph "Infrastructure"
            direction LR
            CM[ConversationManager]
            CT[ContextTracker]
            ORC[OpenRouterClient]
        end

        AP --> TP
        AP --> IB
        AP --> NE
        AP --> CM
        AP --> CT

        TP --> PLAN
        IB --> CTXA
        NE --> CTXA
        AP --> INTENT
        AP --> UI

        CM --> ORC
    end

    subgraph "🤖 Agents gérés"
        A1[Agent A<br/><em>rôle spécialisé</em>]
        A2[Agent B<br/><em>rôle spécialisé</em>]
        AN[Agent N<br/><em>…</em>]
    end

    U[👤 Utilisateur] -->|"execute() / send()"| AP
    AP -->|"spawn + prompt"| A1
    AP -->|"spawn + prompt"| A2
    AP -->|"spawn + prompt"| AN
    AP -->|events + result| U

    A1 -.->|events| CT
    A2 -.->|events| CT
    AN -.->|events| CT

    IB -.->|"injectContext()"| A2

    style AP fill:#7c3aed,stroke:#5b21b6,color:#fff
    style U fill:#f59e0b,stroke:#d97706
    style A1 fill:#3b82f6,stroke:#2563eb,color:#fff
    style A2 fill:#3b82f6,stroke:#2563eb,color:#fff
    style AN fill:#3b82f6,stroke:#2563eb,color:#fff
    style ORC fill:#ef4444,stroke:#dc2626,color:#fff
    style TP fill:#8b5cf6,stroke:#7c3aed,color:#fff
    style IB fill:#8b5cf6,stroke:#7c3aed,color:#fff
    style NE fill:#8b5cf6,stroke:#7c3aed,color:#fff
    style CM fill:#1e293b,stroke:#475569,color:#fff
    style CT fill:#1e293b,stroke:#475569,color:#fff
    style PLAN fill:#10b981,stroke:#059669,color:#fff
    style CTXA fill:#10b981,stroke:#059669,color:#fff
    style INTENT fill:#10b981,stroke:#059669,color:#fff
    style UI fill:#10b981,stroke:#059669,color:#fff
```

---

## Architecture complète

### Vue d'ensemble des composants

```mermaid
graph LR
    subgraph "Entrée"
        TASK["execute(task)"]
        MSG["send(message)"]
    end

    subgraph "Analyse"
        IA[Intent<br/>Analyzer]
        TP[Task<br/>Planner]
    end

    subgraph "Décision"
        STRAT{Stratégie ?}
    end

    subgraph "Exécution"
        SINGLE[1 Agent]
        MULTI[N Agents]
    end

    subgraph "Observation"
        CT[Context<br/>Tracker]
        IB[Information<br/>Broker]
        NE[Notification<br/>Engine]
    end

    subgraph "Sortie"
        RES[AgentPoolResult]
        NOTIF[Notifications]
    end

    TASK --> TP
    MSG --> IA
    IA -->|new_task| TP
    IA -->|status_query| RES
    IA -->|notification_pref| NE

    TP --> STRAT
    STRAT -->|"simple"| SINGLE
    STRAT -->|"complexe"| MULTI

    SINGLE --> CT
    MULTI --> CT

    CT --> IB
    CT --> NE

    IB -.->|"injectContext"| MULTI

    SINGLE --> RES
    MULTI --> RES
    NE --> NOTIF

    style STRAT fill:#f59e0b,stroke:#d97706
    style TP fill:#8b5cf6,stroke:#7c3aed,color:#fff
    style IA fill:#8b5cf6,stroke:#7c3aed,color:#fff
    style IB fill:#10b981,stroke:#059669,color:#fff
    style NE fill:#10b981,stroke:#059669,color:#fff
    style CT fill:#1e293b,stroke:#475569,color:#fff
```

---

## Flow d'exécution global

Le pipeline complet de `execute(task)` en 5 phases :

```mermaid
sequenceDiagram
    actor U as Utilisateur
    participant AP as AgentPool
    participant TP as TaskPlanner
    participant CM as ConversationManager
    participant OR as OpenRouter
    participant CT as ContextTracker
    participant IB as InformationBroker
    participant NE as NotificationEngine
    participant A1 as Agent A
    participant A2 as Agent B

    Note over U,A2: Phase 1 — Planification

    U->>AP: execute("Build REST API with tests")
    AP->>AP: emit(TASK_RECEIVED)
    AP->>TP: analyze(task)
    TP->>CM: sendJson(PLANNER, prompt)
    CM->>OR: chat(messages, jsonMode)
    OR-->>CM: TaskAnalysis JSON
    CM-->>TP: validated TaskAnalysis
    TP-->>AP: { strategy: "multi", subtasks: [...] }
    AP->>AP: emit(PLANNING_COMPLETE)

    Note over U,A2: Phase 2 — Spawn des agents

    AP->>A1: new Agent({ name: "api-developer" })
    AP->>CT: registerAgent(A1.id, subtask)
    AP->>AP: wireAgentEvents(A1)
    AP->>AP: emit(AGENT_SPAWNED)
    AP->>A2: new Agent({ name: "test-writer" })
    AP->>CT: registerAgent(A2.id, subtask)
    AP->>AP: wireAgentEvents(A2)
    AP->>AP: emit(AGENT_SPAWNED)

    Note over U,A2: Phase 3 — Exécution (wave-based)

    par Wave 1 (pas de dépendances bloquantes)
        AP->>A1: prompt("Build the REST API…")
        A1-->>CT: events (tool:start, fs:write, prompt:complete)
        CT->>CT: processEvent → ContextDelta
        AP->>AP: emit(DELTA_DETECTED)
        AP->>IB: evaluate(delta)
        IB->>CM: sendOneShotJson(CONTEXT_ANALYZER, prompt)
        CM->>OR: chat(messages)
        OR-->>CM: SharingDecision
        IB-->>AP: [{ shouldShare: true, information: "..." }]
        AP->>A2: injectContext("API has endpoints: GET /users, POST /users…")
        AP->>AP: emit(CONTEXT_SHARED)
        AP->>NE: evaluate(delta, agentState)
        NE-->>AP: null (silence by default)
        A1-->>AP: PromptResult
        AP->>CT: markCompleted(A1.id)
        AP->>AP: emit(AGENT_COMPLETED)
    end

    par Wave 2 (dépendance sur A1 satisfaite)
        AP->>A2: prompt("Write tests for the API…")
        A2-->>AP: PromptResult
        AP->>CT: markCompleted(A2.id)
        AP->>AP: emit(AGENT_COMPLETED)
    end

    Note over U,A2: Phase 4 — Résumé

    AP->>CM: sendOneShot(USER_INTERACTION, summaryPrompt)
    CM->>OR: chat(messages)
    OR-->>AP: "Execution summary…"

    Note over U,A2: Phase 5 — Cleanup

    AP->>A1: destroy()
    AP->>A2: destroy()
    AP->>AP: emit(EXECUTION_COMPLETE)
    AP-->>U: AgentPoolResult
```

---

## Décision adaptative : single vs multi-agent

Le point le plus critique de l'architecture. Le `TaskPlanner` **ne force jamais** le multi-agents :

```mermaid
flowchart TD
    TASK[Tâche utilisateur] --> SANITIZE[Sanitize<br/><em>anti-injection</em>]
    SANITIZE --> LLM[LLM Planner<br/><em>conversation dédiée</em>]

    LLM --> PARSE[Parse JSON +<br/>Validation structurelle]
    PARSE --> SEM{Validation<br/>sémantique ?}

    SEM -->|❌ Erreurs| RETRY{Retry<br/>< max ?}
    RETRY -->|Oui| CORRECT[Prompt de<br/>correction] --> LLM
    RETRY -->|Non| FALLBACK[Fallback<br/>single-agent]

    SEM -->|✅ Valide| DECIDE{strategy ?}

    DECIDE -->|"single"| SINGLE["1 subtask<br/>prompt = tâche originale<br/>parallelismBenefit = 0"]
    DECIDE -->|"multi"| MULTI["N subtasks<br/>prompts distincts<br/>dépendances déclarées"]

    FALLBACK --> SINGLE

    style TASK fill:#f59e0b,stroke:#d97706
    style LLM fill:#7c3aed,stroke:#5b21b6,color:#fff
    style DECIDE fill:#10b981,stroke:#059669,color:#fff
    style FALLBACK fill:#ef4444,stroke:#dc2626,color:#fff
    style SINGLE fill:#3b82f6,stroke:#2563eb,color:#fff
    style MULTI fill:#3b82f6,stroke:#2563eb,color:#fff
```

### Critères de décision (LLM-driven)

Le planner est guidé par un system prompt strict :

| Choisir `single` quand… | Choisir `multi` quand… |
|---|---|
| Tâche directe et autonome | Responsabilités clairement distinctes |
| Pas de séparation naturelle | Subtasks parallélisables |
| Le découpage ajouterait de l'overhead | Chaque subtask = livrable indépendant |
| Raisonnement séquentiel profond | Bénéfice réel de la spécialisation |
| Sortie = un artefact unique | Frontières naturelles entre domaines |

### Validations

Chaque `TaskAnalysis` subit une double validation :

1. **Structurelle** — via `validateTaskAnalysis()` : types corrects, champs requis, cohérence strategy/subtask count
2. **Sémantique** — via `semanticValidationErrors()` :
    - IDs de subtasks uniques
    - Références de dépendances valides
    - Pas d'auto-dépendance
    - Pas de dépendances circulaires (DFS)
    - Single strategy → 0 dépendances

---

## Exécution topologique des subtasks

Quand la stratégie est `multi`, les subtasks sont exécutées par **vagues** en respectant le graphe de dépendances :

```mermaid
flowchart TD
    START([Début]) --> READY[Calculer subtasks<br/>prêtes à exécuter]

    READY --> HAS_READY{Subtasks<br/>prêtes ?}

    HAS_READY -->|Oui| LAUNCH["Lancer en parallèle<br/>(Promise.allSettled)"]
    LAUNCH --> WAIT[Attendre complétion<br/>de la wave]
    WAIT --> UPDATE[Mettre à jour :<br/>completed / failed]
    UPDATE --> REMAINING{Reste des<br/>subtasks ?}
    REMAINING -->|Oui| READY
    REMAINING -->|Non| DONE([Fin])

    HAS_READY -->|Non| IN_PROGRESS{Subtasks<br/>en cours ?}
    IN_PROGRESS -->|Oui| POLL["Attendre 500ms<br/>(poll)"] --> READY
    IN_PROGRESS -->|Non| DEADLOCK["⚠️ Deadlock détecté<br/>Marquer restantes<br/>comme failed"]
    DEADLOCK --> DONE

    style START fill:#10b981,stroke:#059669,color:#fff
    style DONE fill:#10b981,stroke:#059669,color:#fff
    style DEADLOCK fill:#ef4444,stroke:#dc2626,color:#fff
    style LAUNCH fill:#3b82f6,stroke:#2563eb,color:#fff
```

### Exemple concret de graphe de dépendances

```mermaid
graph LR
    subgraph "Wave 1 (parallèle)"
        API[subtask-api<br/><em>api-developer</em><br/>priority: 1]
        SCHEMA[subtask-schema<br/><em>db-designer</em><br/>priority: 1]
    end

    subgraph "Wave 2 (après API)"
        TESTS[subtask-tests<br/><em>test-writer</em><br/>priority: 2]
    end

    subgraph "Wave 3 (après tout)"
        DOCS[subtask-docs<br/><em>doc-author</em><br/>priority: 3]
    end

    API -->|blocking| TESTS
    SCHEMA -->|informational| API
    API -->|blocking| DOCS
    TESTS -->|blocking| DOCS

    style API fill:#3b82f6,stroke:#2563eb,color:#fff
    style SCHEMA fill:#3b82f6,stroke:#2563eb,color:#fff
    style TESTS fill:#f59e0b,stroke:#d97706
    style DOCS fill:#10b981,stroke:#059669,color:#fff
```

!!! info "Types de dépendances"
    - **`blocking`** : La subtask cible **ne peut pas démarrer** tant que la source n'est pas terminée.
    - **`informational`** : La subtask cible **bénéficierait** de la sortie de la source, mais peut démarrer sans.

---

## Conversations LLM isolées

L'un des choix architecturaux les plus importants : **4 conversations séparées** avec des historiques indépendants.

```mermaid
graph TB
    subgraph "ConversationManager"
        direction TB
        ORC[OpenRouterClient<br/><em>stateless</em>]

        subgraph "Conversation: Planner"
            P_SYS[System Prompt<br/><em>stratégie de décomposition</em>]
            P_H["Historique accumulé<br/><em>planning multi-turn</em>"]
        end

        subgraph "Conversation: Context Analyzer"
            C_SYS[System Prompt<br/><em>analyse de deltas</em>]
            C_H["One-shot uniquement<br/><em>pas d'historique</em>"]
        end

        subgraph "Conversation: Intent Analyzer"
            I_SYS[System Prompt<br/><em>classification d'intent</em>]
            I_H["One-shot uniquement<br/><em>pas d'historique</em>"]
        end

        subgraph "Conversation: User Interaction"
            U_SYS[System Prompt<br/><em>résumé technique</em>]
            U_H["One-shot uniquement<br/><em>pas d'historique</em>"]
        end
    end

    ORC -->|API calls| OR[(OpenRouter)]

    style ORC fill:#ef4444,stroke:#dc2626,color:#fff
    style OR fill:#ef4444,stroke:#dc2626,color:#fff
    style P_SYS fill:#8b5cf6,stroke:#7c3aed,color:#fff
    style C_SYS fill:#10b981,stroke:#059669,color:#fff
    style I_SYS fill:#f59e0b,stroke:#d97706
    style U_SYS fill:#3b82f6,stroke:#2563eb,color:#fff
```

### Pourquoi l'isolation ?

| Problème sans isolation | Solution avec isolation |
|---|---|
| L'historique de planning pollue l'analyse de deltas | Chaque conversation a son propre contexte |
| Les tokens explosent en contexte partagé | Budget token maîtrisé par conversation |
| Les décisions de notification influencent le planning | Responsabilités strictement séparées |
| Impossible de scaler indépendamment | Chaque conversation peut être reset sans affecter les autres |

### Méthodes d'envoi

| Méthode | Historique | Usage |
|---|---|---|
| `send()` | ✅ Accumulé | Planning multi-turn |
| `sendJson()` | ✅ Accumulé | Planning avec validation JSON |
| `sendOneShot()` | ❌ Stateless | Résumés, analyse ponctuelle |
| `sendOneShotJson()` | ❌ Stateless | Décisions de partage/notification |

---

## Modèle de contexte et delta

### ContextTracker — Suivi par agent

Chaque agent géré possède un `AgentContextState` mis à jour incrémentalement :

```mermaid
graph TD
    subgraph "AgentContextState"
        direction TB
        META["🏷️ Métadonnées<br/>agentId, agentName<br/>taskDescription, taskRole"]
        STATUS["📊 Status<br/>INITIALIZING → IDLE → BUSY → IDLE<br/>↘ ERROR"]
        EVENTS["📋 Événements<br/>max 200 par agent<br/>FIFO avec éviction"]
        RESULTS["📝 PromptResults<br/>stopReason, text, usage"]
        FILES["📁 Fichiers<br/>filesWritten[], filesRead[]"]
        DELTA["🔄 Dernier Delta<br/>lastDelta: ContextDelta | null"]
        COMPLETION["✅ État final<br/>completed, error"]
    end

    style META fill:#1e293b,stroke:#475569,color:#fff
    style STATUS fill:#3b82f6,stroke:#2563eb,color:#fff
    style EVENTS fill:#8b5cf6,stroke:#7c3aed,color:#fff
    style DELTA fill:#f59e0b,stroke:#d97706
```

### Pipeline de delta

```mermaid
flowchart LR
    EVENT["Événement agent<br/><em>(prompt:complete,<br/>tool:complete, …)</em>"] --> RECORD["Enregistrer dans<br/>events[]"]

    RECORD --> DERIVE["Mettre à jour<br/>état dérivé<br/><em>(status, files, error)</em>"]

    DERIVE --> SIG{"Significance<br/>mapping ?"}

    SIG -->|"Non (prompt:chunk,<br/>terminal:output…)"| IGNORE["return null<br/><em>pas de delta</em>"]

    SIG -->|Oui| DELTA["Construire<br/>ContextDelta"]

    DELTA --> EMIT["emit(DELTA_DETECTED)"]
    EMIT --> HANDLE["handleDelta()"]
    HANDLE --> BROKER["InformationBroker<br/>.evaluate()"]
    HANDLE --> NOTIF["NotificationEngine<br/>.evaluate()"]

    style EVENT fill:#3b82f6,stroke:#2563eb,color:#fff
    style DELTA fill:#f59e0b,stroke:#d97706
    style IGNORE fill:#6b7280,stroke:#4b5563,color:#fff
    style BROKER fill:#10b981,stroke:#059669,color:#fff
    style NOTIF fill:#10b981,stroke:#059669,color:#fff
```

### Table de significance

| Événement agent | DeltaType | Significance |
|---|---|---|
| `prompt:complete` | `PROMPT_COMPLETE` | **0.8** |
| `tool:failed` | `TOOL_FAILED` | **0.9** |
| `agent:error` | `AGENT_ERROR` | **1.0** |
| `plan:update` | `PLAN_UPDATE` | 0.6 |
| `tool:complete` | `TOOL_COMPLETE` | 0.5 |
| `fs:write` | `FILE_WRITTEN` | 0.5 |
| `agent:idle` | `STATUS_CHANGE` | 0.3 |
| `fs:read` | `FILE_READ` | 0.2 |
| `agent:busy` | `STATUS_CHANGE` | 0.1 |

!!! tip "Pre-filtre avant LLM"
    Seuls les événements avec un mapping de significance produisent un delta.
    Les événements bruyants (`prompt:chunk`, `terminal:output`, `permission:granted`)
    sont enregistrés dans l'historique mais ne déclenchent **aucune** analyse LLM.

---

## Partage d'information conditionnel

Le `InformationBroker` est le **seul arbitre** du partage inter-agents. Les agents ne se connaissent jamais entre eux.

```mermaid
flowchart TD
    DELTA[ContextDelta<br/>from Agent A] --> THRESH{significance<br/>≥ threshold ?}

    THRESH -->|"< 0.4"| SKIP["Ignorer<br/><em>(trop peu significatif)</em>"]

    THRESH -->|"≥ 0.4"| CANDIDATES["Trouver agents<br/>candidats cibles"]

    CANDIDATES --> FILTER["Filtrer :<br/>- pas l'agent source<br/>- pas completed<br/>- pas DESTROYED"]

    FILTER --> EMPTY{Candidats ?}
    EMPTY -->|Aucun| NO_SHARE["return []<br/><em>rien à évaluer</em>"]

    EMPTY -->|"≥ 1"| PARALLEL["Évaluer chaque<br/>candidat en parallèle"]

    PARALLEL --> LLM["LLM Context Analyzer<br/><em>(sendOneShotJson)</em>"]

    LLM --> DECISION{shouldShare ?}

    DECISION -->|Non| LOG_NO["Loguer décision<br/>return { shouldShare: false }"]
    DECISION -->|Oui| DISTILL["LLM distille<br/>l'information pertinente"]
    DISTILL --> INJECT["pool.injectContext()<br/>→ target agent"]

    style DELTA fill:#f59e0b,stroke:#d97706
    style LLM fill:#7c3aed,stroke:#5b21b6,color:#fff
    style INJECT fill:#10b981,stroke:#059669,color:#fff
    style SKIP fill:#6b7280,stroke:#4b5563,color:#fff
    style NO_SHARE fill:#6b7280,stroke:#4b5563,color:#fff
```

!!! warning "Coordination émergente, pas automatique"
    Même quand une dépendance `blocking` ou `informational` existe entre deux agents,
    le broker **consulte toujours le LLM** pour décider si le contenu du delta est
    réellement pertinent pour l'agent cible. Le partage n'est **jamais** automatique.

---

## Notifications utilisateur

Le `NotificationEngine` applique une politique stricte de **silence par défaut** :

```mermaid
flowchart TD
    DELTA[ContextDelta] --> PREF{Préférence<br/>définie ?}

    PREF -->|"Non (null)"| SILENCE1["return null<br/><em>silence absolu</em>"]

    PREF -->|Oui| ENABLED{enabled ?}
    ENABLED -->|Non| SILENCE2["return null"]

    ENABLED -->|Oui| THRESH{significance<br/>≥ minSignificance ?}
    THRESH -->|Non| SILENCE3["return null<br/><em>sous le seuil</em>"]

    THRESH -->|Oui| TYPES{Type dans<br/>types[] ?}
    TYPES -->|"Non (et types définis)"| SILENCE4["return null<br/><em>type non souhaité</em>"]

    TYPES -->|"Oui (ou pas de filtre)"| LLM["LLM Context Analyzer<br/><em>(sendOneShotJson)</em>"]

    LLM --> NOTIFY{shouldNotify ?}
    NOTIFY -->|Non| SILENCE5["return null<br/><em>LLM : pas pertinent</em>"]
    NOTIFY -->|Oui| MESSAGE["UserNotification<br/><em>message, significance,<br/>agentId, type, timestamp</em>"]
    MESSAGE --> EMIT["emit(NOTIFICATION)"]

    style DELTA fill:#f59e0b,stroke:#d97706
    style SILENCE1 fill:#6b7280,stroke:#4b5563,color:#fff
    style SILENCE2 fill:#6b7280,stroke:#4b5563,color:#fff
    style SILENCE3 fill:#6b7280,stroke:#4b5563,color:#fff
    style SILENCE4 fill:#6b7280,stroke:#4b5563,color:#fff
    style SILENCE5 fill:#6b7280,stroke:#4b5563,color:#fff
    style LLM fill:#7c3aed,stroke:#5b21b6,color:#fff
    style MESSAGE fill:#10b981,stroke:#059669,color:#fff
```

### Cycle de vie des préférences

```mermaid
stateDiagram-v2
    [*] --> Silence : Construction
    Silence --> Actif : setPreference({ enabled: true })
    Actif --> Silence : setPreference({ enabled: false })
    Actif --> Silence : clearPreference()
    Actif --> Actif : setPreference({ enabled: true, minSignificance: 0.8 })
    Silence --> Silence : Tout delta → null

    state Actif {
        [*] --> Évaluation
        Évaluation --> PreFilter : significance >= min ?
        PreFilter --> TypeFilter : type match ?
        TypeFilter --> LLMDecision : sendOneShotJson
        LLMDecision --> Notification : shouldNotify = true
        LLMDecision --> Ignoré : shouldNotify = false
    }
```

---

## Analyse d'intent utilisateur

Quand un message arrive via `send()`, il passe par l'`Intent Analyzer` :

```mermaid
flowchart LR
    MSG["send(message)"] --> SANITIZE[Sanitize<br/>anti-injection]
    SANITIZE --> LLM[LLM Intent Analyzer<br/><em>sendOneShotJson</em>]

    LLM --> INTENT{Intent classifié}

    INTENT -->|new_task| EXEC["execute(task)"]
    INTENT -->|notification_preference| PREF["setPreference()"]
    INTENT -->|status_query| STATE["getState() → string"]
    INTENT -->|context_injection| INJECT["injectContext()\n→ tous les agents actifs"]
    INTENT -->|cancel| CANCEL["destroyManagedAgents()"]
    INTENT -->|unknown| HELP["Message d'aide"]

    style MSG fill:#f59e0b,stroke:#d97706
    style LLM fill:#7c3aed,stroke:#5b21b6,color:#fff
    style EXEC fill:#3b82f6,stroke:#2563eb,color:#fff
    style PREF fill:#10b981,stroke:#059669,color:#fff
```

---

## Graphe de dépendances interne

```mermaid
graph TD
    AP[AgentPool] -->|crée| TP[TaskPlanner]
    AP -->|crée| CM[ConversationManager]
    AP -->|crée| CT[ContextTracker]
    AP -->|crée| NE[NotificationEngine]
    AP -->|"crée (par exécution)"| IB[InformationBroker]

    CM -->|crée| ORC[OpenRouterClient]

    TP -->|utilise| CM
    IB -->|utilise| CM
    IB -->|utilise| CT
    NE -->|utilise| CM

    AP -->|"agentFactory()"| AGENTS[Agents gérés]
    AGENTS -.->|"events"| CT

    AP -.->|"emit()"| EVENTS[Pool Events]

    style AP fill:#7c3aed,stroke:#5b21b6,color:#fff
    style ORC fill:#ef4444,stroke:#dc2626,color:#fff

    classDef engine fill:#8b5cf6,stroke:#6d28d9,color:#fff
    class TP,IB,NE engine

    classDef infra fill:#1e293b,stroke:#475569,color:#fff
    class CM,CT,ORC infra

    classDef external fill:#3b82f6,stroke:#2563eb,color:#fff
    class AGENTS external
```

!!! info "Composition Root"
    Le constructeur d'`AgentPool` est le seul point d'assemblage.
    `InformationBroker` est recréé à chaque exécution car il dépend
    des dépendances spécifiques à la tâche en cours.

---

## Système d'événements

`AgentPool` étend `EventEmitter` avec un typage strict via `PoolEventMap` :

```mermaid
graph LR
    subgraph "Événements Pool"
        direction TB
        TR[TASK_RECEIVED]
        PS[PLANNING_START]
        PC[PLANNING_COMPLETE]
        AS[AGENT_SPAWNED]
        AC[AGENT_COMPLETED]
        AE[AGENT_ERROR]
        DD[DELTA_DETECTED]
        SD[SHARING_DECISION]
        CS[CONTEXT_SHARED]
        N[NOTIFICATION]
        EC[EXECUTION_COMPLETE]
        E[ERROR]
        D[DESTROYED]
    end

    subgraph "Timeline d'exécution"
        direction TB
        T1["1. TASK_RECEIVED"] --> T2["2. PLANNING_START"]
        T2 --> T3["3. PLANNING_COMPLETE"]
        T3 --> T4["4. AGENT_SPAWNED (×N)"]
        T4 --> T5["5. DELTA_DETECTED (×...)"]
        T5 --> T6["6. SHARING_DECISION"]
        T6 --> T7["7. CONTEXT_SHARED"]
        T5 --> T8["8. NOTIFICATION"]
        T4 --> T9["9. AGENT_COMPLETED (×N)"]
        T9 --> T10["10. EXECUTION_COMPLETE"]
    end

    style TR fill:#3b82f6,stroke:#2563eb,color:#fff
    style EC fill:#10b981,stroke:#059669,color:#fff
    style AE fill:#ef4444,stroke:#dc2626,color:#fff
    style E fill:#ef4444,stroke:#dc2626,color:#fff
    style D fill:#6b7280,stroke:#4b5563,color:#fff
```

---

## OpenRouter — Client LLM

Le `OpenRouterClient` est le seul point de contact avec un fournisseur LLM :

```mermaid
flowchart TD
    subgraph "OpenRouterClient"
        direction TB
        CHAT["chat(messages)"]
        CHATJ["chatJson(messages, validator)"]
        SAN["sanitize(input)"]
    end

    CHATJ --> JSON_MODE["responseFormat:<br/>json_object"]
    JSON_MODE --> SEND["sdk.chat.send()"]
    CHAT --> SEND

    SEND --> RETRY["@openrouter/sdk<br/><em>retry automatique<br/>backoff exponentiel</em>"]

    RETRY --> RESP{Réponse}
    RESP -->|Texte| EXTRACT["extractContent()"]

    CHATJ --> PARSE["JSON.parse()"]
    PARSE --> VALIDATE{validator() ?}
    VALIDATE -->|null| CORRECT["Prompt de correction<br/><em>jusqu'à maxAttempts</em>"]
    CORRECT --> SEND
    VALIDATE -->|valid| RETURN["return T"]
    VALIDATE -->|"max atteint"| THROW["throw JsonValidationError"]

    SAN --> PATTERNS["6 patterns regex<br/><em>injection detection</em>"]
    PATTERNS --> MATCH{Matches ?}
    MATCH -->|"≥ 2"| REJECT["throw PromptInjectionError"]
    MATCH -->|"1"| WARN["⚠️ Warning + pass-through"]
    MATCH -->|"0"| PASS["Pass-through"]

    style SEND fill:#ef4444,stroke:#dc2626,color:#fff
    style RETRY fill:#f59e0b,stroke:#d97706
    style RETURN fill:#10b981,stroke:#059669,color:#fff
    style THROW fill:#ef4444,stroke:#dc2626,color:#fff
    style REJECT fill:#ef4444,stroke:#dc2626,color:#fff
```

---

## Prompts Handlebars

Tous les prompts sont des templates Handlebars pré-compilés :

| Template | Rôle | Conversation |
|---|---|---|
| `planningSystemPrompt` | System prompt du planner | PLANNER |
| `taskAnalysisPrompt` | Prompt d'analyse de tâche | PLANNER |
| `contextAnalysisSystemPrompt` | System prompt de l'analyseur de contexte | CONTEXT_ANALYZER |
| `contextAnalysisPrompt` | Prompt d'analyse de delta | CONTEXT_ANALYZER |
| `sharingDecisionPrompt` | Prompt de décision de partage | CONTEXT_ANALYZER |
| `notificationDecisionPrompt` | Prompt de décision de notification | CONTEXT_ANALYZER |
| `intentAnalysisSystemPrompt` | System prompt de l'analyseur d'intent | INTENT_ANALYZER |
| `intentAnalysisPrompt` | Prompt de classification d'intent | INTENT_ANALYZER |
| `summarySystemPrompt` | System prompt du résumé | USER_INTERACTION |
| `summaryPrompt` | Prompt de génération de résumé | USER_INTERACTION |

!!! tip "Helpers Handlebars"
    Trois helpers sont enregistrés globalement :
    
    - `{{json obj}}` — Sérialise en JSON indenté (SafeString)
    - `{{eq a b}}` — Comparaison d'égalité
    - `{{truncate text length}}` — Troncature avec ellipsis

---

## API publique

### `execute(task)` — Exécuter une tâche

```typescript
const pool = new AgentPool({
  openRouterApiKey: process.env.OPENROUTER_API_KEY!,
  model: "anthropic/claude-sonnet-4-20250514",
  agentConfig: { cwd: "/my/project", autoApprove: true },
});

const result = await pool.execute("Build a REST API with tests");

console.log(result.strategy);   // "single" | "multi"
console.log(result.summary);    // Résumé LLM de l'exécution
console.log(result.agents);     // Résultats par agent
console.log(result.durationMs); // Temps total
```

### `send(message)` — Envoyer un message

```typescript
// Le message est analysé par le LLM pour classifier l'intent
await pool.send("Notify me of important changes");     // → notification_preference
await pool.send("What's the current status?");          // → status_query
await pool.send("Add authentication to the API");       // → new_task → execute()
await pool.send("Focus on security best practices");    // → context_injection
await pool.send("Stop everything");                     // → cancel
```

### `getState()` — Inspecter l'état

```typescript
const state = pool.getState();
// {
//   executing: boolean,
//   currentTask: string | null,
//   strategy: "single" | "multi" | null,
//   activeAgentCount: number,
//   agents: [{ agentId, agentName, status, taskRole, completed }],
//   notificationsEnabled: boolean,
//   deltaCount: number,
//   sharingDecisionCount: number,
// }
```

### `setNotificationPreference(pref)` — Configurer les notifications

```typescript
// Bypass le LLM intent analyzer — configuration directe
pool.setNotificationPreference({
  enabled: true,
  minSignificance: 0.6,
  types: [DeltaType.PROMPT_COMPLETE, DeltaType.AGENT_ERROR],
});
```

### `destroy()` — Destruction propre

```typescript
await pool.destroy();
// Détruit tous les agents gérés
// Émet DESTROYED
// Le pool ne peut plus être réutilisé
```

### Événements typés

```typescript
pool.on(PoolEvent.PLANNING_COMPLETE, (event) => {
  console.log(event.analysis.strategy);   // Typé : PlanningCompleteEvent
});

pool.on(PoolEvent.AGENT_SPAWNED, (event) => {
  console.log(event.agentName, event.subtask.role);
});

pool.on(PoolEvent.CONTEXT_SHARED, (event) => {
  console.log(`${event.sourceAgentId} → ${event.targetAgentId}`);
});

pool.on(PoolEvent.NOTIFICATION, (event) => {
  console.log(event.notification.message);
});
```

---

## Configuration

```typescript
interface AgentPoolConfig {
  /** Clé API OpenRouter (obligatoire). */
  openRouterApiKey: string;

  /** Modèle LLM. Défaut : "anthropic/claude-sonnet-4-20250514" */
  model?: string;

  /** Config de base pour les agents spawnés. */
  agentConfig?: AgentConfig;

  /** Agents concurrents max. Défaut : 5 */
  maxAgents?: number;

  /** Retry API max. Défaut : 3 */
  maxRetries?: number;

  /** Température LLM. Défaut : 0.2 */
  temperature?: number;

  /** Factory d'agents pour les tests. */
  createAgent?: AgentFactory;
}
```

---

## Séparation des responsabilités

| Composant | Sait | Ne sait pas |
|---|---|---|
| **AgentPool** | Orchestrer le pipeline complet | Les détails du protocole ACP |
| **TaskPlanner** | Analyser et décomposer une tâche | L'existence des agents réels |
| **ConversationManager** | Gérer N conversations isolées | Le domaine métier |
| **OpenRouterClient** | Communiquer avec OpenRouter | Ce qu'est un agent |
| **ContextTracker** | Suivre l'état de chaque agent | Comment partager l'information |
| **InformationBroker** | Décider du partage inter-agents | Comment exécuter une subtask |
| **NotificationEngine** | Décider de notifier l'utilisateur | Le graphe de dépendances |
| **Agent** (externe) | Exécuter un prompt | Qu'un AgentPool existe |

---

## Contraintes architecturales

```mermaid
graph LR
    subgraph "🔴 Interdit"
        X1["Agent connaît<br/>AgentPool"]
        X2["Logique décisionnelle<br/>hardcodée"]
        X3["Multi-agents<br/>forcé"]
        X4["Provider LLM<br/>interchangeable"]
        X5["Partage automatique<br/>entre agents"]
        X6["Notifications<br/>par défaut"]
    end

    subgraph "🟢 Garanti"
        Y1["Agent ignorant<br/>du pool"]
        Y2["Décisions<br/>LLM-driven"]
        Y3["Single quand<br/>approprié"]
        Y4["OpenRouter<br/>uniquement"]
        Y5["Partage<br/>LLM-décidé"]
        Y6["Silence<br/>par défaut"]
    end

    X1 -.->|remplacé par| Y1
    X2 -.->|remplacé par| Y2
    X3 -.->|remplacé par| Y3
    X4 -.->|remplacé par| Y4
    X5 -.->|remplacé par| Y5
    X6 -.->|remplacé par| Y6

    style X1 fill:#ef4444,stroke:#dc2626,color:#fff
    style X2 fill:#ef4444,stroke:#dc2626,color:#fff
    style X3 fill:#ef4444,stroke:#dc2626,color:#fff
    style X4 fill:#ef4444,stroke:#dc2626,color:#fff
    style X5 fill:#ef4444,stroke:#dc2626,color:#fff
    style X6 fill:#ef4444,stroke:#dc2626,color:#fff
    style Y1 fill:#10b981,stroke:#059669,color:#fff
    style Y2 fill:#10b981,stroke:#059669,color:#fff
    style Y3 fill:#10b981,stroke:#059669,color:#fff
    style Y4 fill:#10b981,stroke:#059669,color:#fff
    style Y5 fill:#10b981,stroke:#059669,color:#fff
    style Y6 fill:#10b981,stroke:#059669,color:#fff
```

---

## Liens

- [Architecture — Vue d'ensemble](../architecture/overview.md)
- [Agent — L'orchestrateur principal](agent.md)
- [Événements typés](../concepts/events.md)
- [Cycle de vie](../concepts/lifecycle.md)