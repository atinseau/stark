# 🏗️ Architecture — Vue d'ensemble

> Cette page décrit l'architecture globale de Stark, les composants qui le composent,
> et comment ils interagissent pour former un système d'agent autonome observable.

---

## Philosophie

Stark suit trois principes architecturaux fondamentaux :

1. **Séparation des responsabilités** — Chaque brique a un rôle unique et bien défini
2. **Composition par injection** — Les dépendances sont injectées, jamais instanciées en interne
3. **Observabilité native** — Chaque action est loguée, tracée et émise comme événement

Le résultat : un système où chaque composant peut être testé, remplacé ou étendu indépendamment.

---

## Diagramme d'architecture

```mermaid
graph TB
    subgraph "👤 Utilisateur"
        USER[Code appelant<br/><code>agent.prompt&lpar;&rpar;</code>]
    end

    subgraph "🤖 Agent <small>(orchestrateur)</small>"
        direction TB
        AGENT[<b>Agent</b><br/>EventEmitter typé]

        subgraph "Composants internes"
            direction LR
            CTX[AgentContextManager<br/><em>File de contexte</em>]
            SUH[SessionUpdateHandler<br/><em>Routeur d'updates</em>]
            ACF[ACPClientFactory<br/><em>Client ACP</em>]
        end

        AGENT --> CTX
        AGENT --> SUH
        AGENT --> ACF
    end

    subgraph "🔧 Infrastructure"
        direction LR
        TM[TerminalManager<br/><em>Processus enfants</em>]
        TRACER[Tracer<br/><em>OpenTelemetry</em>]
        LOGGER[Logger<br/><em>Pino multi-stream</em>]
    end

    subgraph "📡 ACP Layer"
        CONN[ClientSideConnection<br/><em>NDJSON / stdio</em>]
        PROC[Agent Process<br/><code>copilot --acp --stdio</code>]
    end

    subgraph "📊 Backends"
        direction LR
        SEQ[(Seq<br/><em>Logs + Traces</em>)]
        CONSOLE[Console<br/><em>pino-pretty</em>]
        FILE[Fichier<br/><em>NDJSON</em>]
    end

    USER -->|prompt / injectContext| AGENT
    AGENT --> TM
    AGENT --> TRACER
    AGENT --> LOGGER
    ACF --> CONN
    CONN <-->|stdio| PROC
    ACF --> TM

    TRACER -->|OTLP proto| SEQ
    LOGGER -->|pino-seq| SEQ
    LOGGER -->|stream| CONSOLE
    LOGGER -->|stream| FILE

    SUH -->|events| AGENT
    SUH --> LOGGER
    SUH --> TRACER

    style AGENT fill:#7c3aed,stroke:#5b21b6,color:#fff
    style TRACER fill:#f59e0b,stroke:#d97706,color:#000
    style LOGGER fill:#3b82f6,stroke:#2563eb,color:#fff
    style SEQ fill:#10b981,stroke:#059669,color:#fff
    style PROC fill:#ef4444,stroke:#dc2626,color:#fff
    style CTX fill:#8b5cf6,stroke:#7c3aed,color:#fff
    style SUH fill:#8b5cf6,stroke:#7c3aed,color:#fff
    style ACF fill:#8b5cf6,stroke:#7c3aed,color:#fff
```

---

## Les 8 briques

Le système se décompose en **8 composants** répartis en 3 couches :

### Couche Orchestration

| Composant | Fichier | Rôle |
|-----------|---------|------|
| [**Agent**](../components/agent.md) | `classes/agent/agent.ts` | Orchestrateur principal. Étend `EventEmitter` avec un typage fort. Gère le cycle de vie complet : spawn du processus, négociation ACP, envoi de prompts, destruction. |

### Couche Logique métier

| Composant | Fichier | Rôle |
|-----------|---------|------|
| [**AgentContextManager**](../components/context-manager.md) | `classes/agent/agent-context-manager.ts` | File FIFO pure (aucune dépendance) qui gère l'injection de contexte entre les prompts. |
| [**SessionUpdateHandler**](../components/session-update-handler.md) | `classes/agent/agent-session-update-handler.ts` | Routeur qui dispatche chaque `SessionUpdate` ACP vers le bon handler (logging, tracing, événements). |
| [**ACPClientFactory**](../components/acp-client-factory.md) | `classes/agent/agent-acp-client-factory.ts` | Fabrique du client ACP : implémente les callbacks de permissions, filesystem et terminal. |

### Couche Infrastructure

| Composant | Fichier | Rôle |
|-----------|---------|------|
| [**Tracer**](../components/tracer.md) | `classes/tracer/tracer.ts` | Wrapper générique OpenTelemetry. Gère la hiérarchie root → active → operation spans. |
| [**Logger**](../components/logger.md) | `logger/create-logger.ts` | Fabrique de loggers Pino multi-transport (console, JSON, Seq) avec corrélation trace. |
| [**TerminalManager**](../components/terminal-manager.md) | `classes/terminal-manager/terminal-manager.ts` | Gestionnaire de processus enfants : spawn, output, exit, kill. |

---

## Flux de données

Le système présente **trois flux de données** distincts :

### 1. Flux de commande (descendant)

```mermaid
flowchart LR
    A[Utilisateur] -->|"prompt(text)"| B[Agent]
    B -->|"buildPromptWithContext()"| C[ContextManager]
    C -->|prompt enrichi| B
    B -->|"connection.prompt()"| D[ACP Connection]
    D -->|stdio NDJSON| E[Agent Process]

    style A fill:#f59e0b,stroke:#d97706
    style B fill:#7c3aed,stroke:#5b21b6,color:#fff
    style E fill:#ef4444,stroke:#dc2626,color:#fff
```

### 2. Flux de données (ascendant)

```mermaid
flowchart LR
    E[Agent Process] -->|SessionUpdate| D[ACP Connection]
    D -->|"onSessionUpdate()"| SUH[SessionUpdateHandler]
    SUH -->|"emitEvent()"| A[Agent EventEmitter]
    SUH -->|"logger.info()"| L[Logger]
    SUH -->|"tracer.*()"| T[Tracer]

    style E fill:#ef4444,stroke:#dc2626,color:#fff
    style A fill:#7c3aed,stroke:#5b21b6,color:#fff
    style L fill:#3b82f6,stroke:#2563eb,color:#fff
    style T fill:#f59e0b,stroke:#d97706
```

### 3. Flux d'observabilité (transversal)

```mermaid
flowchart LR
    subgraph Sources
        AG[Agent]
        SUH[SessionUpdateHandler]
        ACF[ACPClientFactory]
    end

    subgraph "Tracer (OTel)"
        RS[Root Span]
        AS[Active Span]
        OS[Operation Spans]
        RS --> AS --> OS
    end

    subgraph "Logger (Pino)"
        MX[Mixin TraceContext]
        MS[Multi-stream]
    end

    subgraph Backends
        SEQ[(Seq)]
    end

    AG --> RS
    SUH --> OS
    ACF --> OS

    AG --> MX
    SUH --> MS
    MX --> MS

    OS -->|OTLP| SEQ
    MS -->|pino-seq| SEQ

    style SEQ fill:#10b981,stroke:#059669,color:#fff
```

---

## Graphe de dépendances

Chaque composant reçoit ses dépendances par injection dans le constructeur.
L'`Agent` est le seul point d'assemblage (composition root) :

```mermaid
graph TD
    AGENT[Agent] -->|crée| TRACER[Tracer]
    AGENT -->|crée| LOGGER[Logger]
    AGENT -->|crée| CTX[ContextManager]
    AGENT -->|crée| TM[TerminalManager]

    AGENT -->|injecte logger, tracer, emitEvent| SUH[SessionUpdateHandler]
    AGENT -->|injecte logger, tracer, emitEvent, TM, config| ACF[ACPClientFactory]

    TRACER -.->|"getTraceContext()"| LOGGER
    ACF -->|utilise| TM

    style AGENT fill:#7c3aed,stroke:#5b21b6,color:#fff

    classDef injected fill:#8b5cf6,stroke:#6d28d9,color:#fff
    class SUH,ACF injected

    classDef infra fill:#1e293b,stroke:#475569,color:#fff
    class TRACER,LOGGER,TM,CTX infra
```

!!! info "Composition Root"
    Le constructeur de `Agent` est le seul endroit où les dépendances sont assemblées.
    Aucun composant interne n'instancie lui-même ses dépendances — tout est injecté.

---

## Communication inter-composants

Les composants communiquent via **trois mécanismes** :

| Mécanisme | Utilisé par | Direction |
|-----------|------------|-----------|
| **Appels directs** | `Agent` → `ContextManager`, `TerminalManager` | Descendant |
| **Callbacks injectés** | `emitEvent` passé à `SessionUpdateHandler`, `ACPClientFactory` | Ascendant |
| **EventEmitter** | `Agent.on()` pour les consommateurs externes | Sortant |

```mermaid
flowchart TB
    EXT[Code externe] -->|"agent.on('tool:start', cb)"| AGENT

    AGENT -->|appel direct| CTX[ContextManager]
    AGENT -->|appel direct| TM[TerminalManager]

    SUH -->|"emitEvent(AgentEvent.TOOL_START, payload)"| AGENT
    ACF -->|"emitEvent(AgentEvent.FS_WRITE, payload)"| AGENT

    AGENT -.->|"EventEmitter.emit()"| EXT

    style AGENT fill:#7c3aed,stroke:#5b21b6,color:#fff
    style EXT fill:#f59e0b,stroke:#d97706
```

---

## Séparation des responsabilités

Chaque composant a un **périmètre strict** :

| Composant | Sait | Ne sait pas |
|-----------|------|-------------|
| **Agent** | Comment orchestrer le tout | Les détails du protocole ACP |
| **ContextManager** | Gérer une file FIFO | Qu'un agent existe |
| **SessionUpdateHandler** | Router des updates vers les bons handlers | Comment spawner un processus |
| **ACPClientFactory** | Implémenter les callbacks ACP | Le cycle de vie de l'agent |
| **TerminalManager** | Spawner et gérer des processus | Le protocole ACP |
| **Tracer** | Gérer des spans OpenTelemetry | Le domaine métier |
| **Logger** | Écrire des logs structurés | Ce qu'est un agent |

!!! tip "Principe Open/Closed"
    Le `Tracer` est volontairement générique (domain-agnostic). Pour tracer un nouveau concept
    métier, on crée des **fonctions helper externes** qui composent l'API du Tracer —
    sans jamais modifier la classe elle-même.

---

## Prochaines étapes

- [**Flux & Séquences**](sequences.md) — Diagrammes de séquence détaillés de chaque flux
- [**Agent**](../components/agent.md) — Plongée dans l'orchestrateur principal
- [**Démarrage rapide**](../guide/quickstart.md) — Lancez votre premier agent