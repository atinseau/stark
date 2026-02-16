# 🔀 Flux & Diagrammes de séquence

> Cette page détaille les flux principaux du système à travers des diagrammes de séquence.
> Chaque diagramme montre **qui appelle qui**, **dans quel ordre**, et **quelles données transitent**.

---

## Vue d'ensemble des flux

Le système Stark s'articule autour de **5 flux majeurs** :

| Flux | Déclencheur | Description |
|------|-------------|-------------|
| [Initialisation](#1-initialisation-de-lagent) | `new Agent(config)` | Spawn du processus, négociation ACP, création de session |
| [Envoi de prompt](#2-envoi-dun-prompt) | `agent.prompt(text)` | Envoi d'un message, réception streaming, accumulation réponse |
| [Tool call](#3-exécution-dun-tool-call) | Décision de l'IA | L'agent IA demande d'exécuter une commande ou manipuler un fichier |
| [Injection de contexte](#4-injection-de-contexte) | `agent.injectContext(text)` | Ajout d'instructions au vol, immédiat ou en file d'attente |
| [Destruction](#5-destruction-de-lagent) | `agent.destroy()` | Arrêt propre de tous les composants et processus |

---

## 1. Initialisation de l'agent

Quand on instancie `new Agent(config)`, le constructeur lance une chaîne d'initialisation asynchrone.
Le consommateur attend `await agent.ready` avant d'envoyer des prompts.

```mermaid
sequenceDiagram
    participant U as 👤 Utilisateur
    participant A as 🤖 Agent
    participant T as 📡 Tracer
    participant L as 📝 Logger
    participant TM as 🖥️ TerminalManager
    participant CTX as 📋 ContextManager
    participant SUH as 🔀 SessionUpdateHandler
    participant ACF as 🏭 ACPClientFactory
    participant PROC as ⚙️ copilot process

    Note over U,A: Construction (synchrone)

    U->>+A: new Agent(config)

    A->>T: new Tracer({ enabled, endpoint })
    T-->>A: tracer instance

    A->>T: startRootSpan("agent.session")
    T-->>A: root span

    A->>L: createLogger(identity, { traceContextProvider })
    L-->>A: pino logger

    A->>CTX: new AgentContextManager()
    A->>TM: new TerminalManager()

    A->>SUH: new SessionUpdateHandler(logger, tracer, emitEvent)
    A->>ACF: new ACPClientFactory(logger, tracer, emitEvent, TM, config)

    A->>TM: setOutputCallback(cb)
    A->>TM: setExitCallback(cb)

    Note over A: Status: INITIALIZING

    A-->>U: agent (ready = Promise<void>)

    Note over A,PROC: Initialisation async (agent.ready)

    A->>T: startOperation("agent.initialize")

    rect rgb(40, 40, 70)
        Note over A,PROC: Phase 1 — Spawn du processus

        A->>T: startOperation("agent.initialize.spawn-process")
        A->>PROC: spawn("copilot", ["--acp", "--stdio"])
        PROC-->>A: ChildProcess (stdin/stdout pipes)
        A->>T: endOperation(spawnPhase)
    end

    rect rgb(40, 40, 70)
        Note over A,PROC: Phase 2 — Connexion ACP

        A->>A: ndJsonStream(stdin, stdout)
        A->>ACF: build(onSessionUpdate)
        ACF-->>A: acp.Client

        A->>A: new ClientSideConnection(client, stream)
    end

    rect rgb(40, 40, 70)
        Note over A,PROC: Phase 3 — Handshake ACP

        A->>T: startOperation("agent.initialize.acp-protocol-init")
        A->>PROC: connection.initialize({ protocolVersion, capabilities })
        PROC-->>A: { protocolVersion, agentInfo }
        A->>T: endOperation(acpInitPhase)
        A->>L: info("ACP protocol initialized")
    end

    rect rgb(40, 40, 70)
        Note over A,PROC: Phase 4 — Création de session

        A->>T: startOperation("agent.initialize.create-session")
        A->>PROC: connection.newSession({ cwd, mcpServers })
        PROC-->>A: { sessionId }
        A->>T: endOperation(sessionPhase)
        A->>L: info("Session created")
    end

    A->>T: endOperation(initSpan)

    Note over A: Status: IDLE

    A->>A: emit(AGENT_READY, { sessionId })
    A-->>U: ready resolved ✅
```

!!! info "Gestion des erreurs"
    Si n'importe quelle phase échoue, l'erreur est propagée via le span de tracing
    (marqué `ERROR`), le status passe à `ERROR`, et un événement `agent:error` est émis.
    La promise `agent.ready` est rejetée.

---

## 2. Envoi d'un prompt

Le flux principal : l'utilisateur envoie un message, l'agent IA traite et répond en streaming.

```mermaid
sequenceDiagram
    participant U as 👤 Utilisateur
    participant A as 🤖 Agent
    participant CTX as 📋 ContextManager
    participant T as 📡 Tracer
    participant SUH as 🔀 SessionUpdateHandler
    participant L as 📝 Logger
    participant CONN as 🔌 ACP Connection
    participant PROC as ⚙️ copilot

    U->>+A: agent.prompt("Crée un serveur HTTP")

    A->>A: assertReady()
    Note over A: Vérifie status === IDLE

    A->>CTX: buildPromptWithContext(text)
    CTX-->>A: fullPrompt (avec contexte prépendé si présent)

    A->>A: _promptCount++
    A->>SUH: resetResponseText()

    Note over A: Status: BUSY

    A->>A: emit(AGENT_BUSY)
    A->>A: emit(PROMPT_START, { promptText, promptIndex })

    A->>T: startActiveSpan("agent.prompt", { index, text })
    T-->>A: promptSpan

    A->>L: info("Prompt: Crée un serveur HTTP")

    A->>+CONN: connection.prompt({ sessionId, prompt })
    CONN->>PROC: NDJSON request

    loop Streaming des updates
        PROC-->>CONN: SessionUpdate (agent_message_chunk)
        CONN-->>SUH: handle(update)

        alt agent_message_chunk
            SUH->>SUH: _responseText += chunk
            SUH->>A: emitEvent(PROMPT_CHUNK, { text })
            Note over U: L'utilisateur reçoit le texte en temps réel

        else agent_thought_chunk
            SUH->>L: debug("Agent thinking")
            SUH->>A: emitEvent(PROMPT_THOUGHT, { text })

        else tool_call
            Note over SUH: Voir flux "Tool Call" ci-dessous
            SUH->>T: startOperation("agent.tool_call")
            SUH->>A: emitEvent(TOOL_START)

        else usage_update
            SUH->>T: recordEvent("usage.update")
            SUH->>A: emitEvent(USAGE_UPDATE, { percent, cost })

        else plan
            SUH->>A: emitEvent(PLAN_UPDATE, { entries })
        end
    end

    CONN-->>-A: { stopReason, usage }

    A->>A: emit(PROMPT_COMPLETE, { stopReason, fullText })
    A->>L: info("Prompt completed")

    A->>T: endActiveSpan(promptSpan)

    Note over A: Status: IDLE

    A->>A: emit(AGENT_IDLE)
    A->>A: drainPendingContext()

    A-->>-U: PromptResult { stopReason, text, usage }
```

!!! tip "Streaming en temps réel"
    L'événement `prompt:chunk` est émis à chaque fragment de texte reçu.
    C'est ce qui permet d'afficher la réponse en temps réel dans le terminal
    (via `process.stdout.write(e.text)`).

---

## 3. Exécution d'un tool call

Quand l'agent IA décide d'exécuter une action (commande shell, lecture/écriture de fichier),
un flux de tool call se déclenche **à l'intérieur** d'un prompt.

### 3a. Exécution d'une commande terminal

```mermaid
sequenceDiagram
    participant PROC as ⚙️ copilot
    participant CONN as 🔌 ACP Connection
    participant ACF as 🏭 ACPClientFactory
    participant TM as 🖥️ TerminalManager
    participant T as 📡 Tracer
    participant L as 📝 Logger
    participant A as 🤖 Agent

    PROC->>CONN: requestPermission({ toolCall, options })
    CONN->>ACF: handlePermission(params)

    ACF->>T: tracePermissionStart(toolCallId)

    alt autoApprove = true
        ACF->>ACF: Cherche option "allow_once" ou "allow_always"
        ACF->>A: emitEvent(PERMISSION_GRANTED)
        ACF->>T: tracePermissionEnd(span, "granted")
        ACF-->>CONN: { outcome: "selected", optionId }
    else autoApprove = false
        ACF->>A: emitEvent(PERMISSION_DENIED)
        ACF->>T: tracePermissionEnd(span, "denied")
        ACF-->>CONN: { outcome: "cancelled" }
    end

    PROC->>CONN: createTerminal({ command: "node server.js", cwd })
    CONN->>ACF: handleCreateTerminal(params)
    ACF->>TM: create({ command, args, cwd, env })
    TM->>TM: spawn(command, args, { cwd, shell: true })
    TM-->>ACF: ManagedTerminal { terminalId, child }

    ACF->>T: traceTerminalStart(terminalId, command)
    ACF->>A: emitEvent(TERMINAL_CREATED)
    ACF-->>CONN: { terminalId }

    loop Terminal en cours d'exécution
        TM-->>A: onOutput(terminalId, "stdout", text)
        A->>A: emit(TERMINAL_OUTPUT)
    end

    PROC->>CONN: waitForTerminalExit({ terminalId })
    CONN->>ACF: waitForTerminalExit
    ACF->>TM: waitForExit(terminalId)
    TM-->>ACF: { exitCode: 0 }

    TM-->>A: onExit(terminalId, { exitCode: 0 })
    A->>T: traceTerminalEnd(terminalId, exitCode)
    A->>A: emit(TERMINAL_EXIT, { exitCode: 0 })

    ACF-->>CONN: { exitCode: 0 }

    PROC->>CONN: releaseTerminal({ terminalId })
    CONN->>ACF: handleReleaseTerminal
    ACF->>TM: release(terminalId)
    TM->>TM: SIGTERM + delete from map
    ACF-->>CONN: {}
```

### 3b. Lecture / écriture de fichier

```mermaid
sequenceDiagram
    participant PROC as ⚙️ copilot
    participant CONN as 🔌 ACP Connection
    participant ACF as 🏭 ACPClientFactory
    participant T as 📡 Tracer
    participant FS as 📂 Node.js FS
    participant A as 🤖 Agent

    Note over PROC,ACF: Écriture de fichier

    PROC->>CONN: writeTextFile({ path, content })
    CONN->>ACF: handleWriteTextFile(params)
    ACF->>A: emitEvent(FS_WRITE, { path, contentLength })

    ACF->>T: traced("agent.fs.write", async (span) => ...)
    T-->>ACF: span context

    ACF->>FS: mkdir(dirname(path), { recursive: true })
    ACF->>FS: writeFile(path, content, "utf-8")
    FS-->>ACF: ✅

    ACF->>T: span.end() (via traced)
    ACF-->>CONN: {}

    Note over PROC,ACF: Lecture de fichier

    PROC->>CONN: readTextFile({ path })
    CONN->>ACF: handleReadTextFile(params)

    ACF->>T: traced("agent.fs.read", async (span) => ...)

    ACF->>FS: readFile(path, "utf-8")
    FS-->>ACF: content

    ACF->>A: emitEvent(FS_READ, { path, contentLength })
    ACF-->>CONN: { content }
```

### 3c. Cycle de vie d'un tool call (updates)

```mermaid
sequenceDiagram
    participant PROC as ⚙️ copilot
    participant SUH as 🔀 SessionUpdateHandler
    participant T as 📡 Tracer
    participant A as 🤖 Agent

    PROC->>SUH: handle({ sessionUpdate: "tool_call", toolCallId, title, kind })

    SUH->>SUH: toolCalls.set(toolCallId, { title, kind })
    SUH->>T: startOperation("agent.tool_call")
    SUH->>T: trackSpan(toolCallId, span)
    SUH->>T: enterSpan(span)
    SUH->>A: emitEvent(TOOL_START, { toolCallId, title, kind, command })

    loop Updates intermédiaires
        PROC->>SUH: handle({ sessionUpdate: "tool_call_update", status: "in_progress" })
        SUH->>T: span.addEvent("tool.update")
        SUH->>A: emitEvent(TOOL_UPDATE, { output, exitCode })
    end

    alt status === "completed"
        PROC->>SUH: handle({ sessionUpdate: "tool_call_update", status: "completed" })
        SUH->>T: removeTrackedSpan(toolCallId)
        SUH->>T: span.setStatus(OK)
        SUH->>T: leaveSpan(span)
        SUH->>T: span.end()
        SUH->>A: emitEvent(TOOL_COMPLETE, { title, exitCode })

    else status === "failed"
        PROC->>SUH: handle({ sessionUpdate: "tool_call_update", status: "failed" })
        SUH->>T: removeTrackedSpan(toolCallId)
        SUH->>T: span.setStatus(ERROR)
        SUH->>T: leaveSpan(span)
        SUH->>T: span.end()
        SUH->>A: emitEvent(TOOL_FAILED, { title, output, exitCode })
    end
```

---

## 4. Injection de contexte

L'injection de contexte permet de modifier le comportement de l'agent entre les prompts
(ou pendant un prompt, en file d'attente).

### 4a. Injection immédiate (agent IDLE)

```mermaid
sequenceDiagram
    participant U as 👤 Utilisateur
    participant A as 🤖 Agent
    participant CTX as 📋 ContextManager
    participant T as 📡 Tracer

    Note over A: Status: IDLE

    U->>A: agent.injectContext("Utilise TypeScript strict mode")

    A->>A: queued = false (status !== BUSY)
    A->>A: emit(CONTEXT_INJECTED, { instructions, queued: false })
    A->>T: recordEvent("active", "context.injected")
    A->>CTX: inject(instructions)
    CTX->>CTX: pending.push(instructions)

    Note over A: Drain immédiat car IDLE

    A->>A: drainPendingContext()
    A->>CTX: drain()
    CTX-->>A: "Utilise TypeScript strict mode"

    A->>A: prompt(mergedInstructions)
    Note over A: Exécute un prompt avec le contexte injecté
```

### 4b. Injection en file d'attente (agent BUSY)

```mermaid
sequenceDiagram
    participant U as 👤 Utilisateur
    participant A as 🤖 Agent
    participant CTX as 📋 ContextManager
    participant PROC as ⚙️ copilot

    Note over A: Status: BUSY (prompt en cours)

    U->>A: agent.injectContext("Ajoute de la validation")
    A->>A: queued = true (status === BUSY)
    A->>A: emit(CONTEXT_INJECTED, { queued: true })
    A->>CTX: inject("Ajoute de la validation")
    Note over CTX: pending = ["Ajoute de la validation"]

    U->>A: agent.injectContext("Utilise Zod")
    A->>CTX: inject("Utilise Zod")
    Note over CTX: pending = ["Ajoute de la validation", "Utilise Zod"]

    Note over A,PROC: ... prompt en cours termine ...

    PROC-->>A: PromptResult

    Note over A: Status: IDLE

    A->>A: drainPendingContext()
    A->>CTX: drain()
    CTX-->>A: "Ajoute de la validation\n\n---\n\nUtilise Zod"

    A->>A: prompt(mergedInstructions)
    Note over A: Exécute un follow-up prompt automatique
```

### 4c. Contexte prépendé au prochain prompt

```mermaid
sequenceDiagram
    participant U as 👤 Utilisateur
    participant A as 🤖 Agent
    participant CTX as 📋 ContextManager

    U->>A: agent.injectContext("Préfère le style fonctionnel")
    A->>CTX: inject(instructions)

    Note over CTX: pending = ["Préfère le style fonctionnel"]

    U->>A: agent.prompt("Crée une API REST")
    A->>CTX: buildPromptWithContext("Crée une API REST")

    Note over CTX: Construit le prompt enrichi

    CTX-->>A: "Préfère le style fonctionnel\n\n---\n\nUser request:\nCrée une API REST"

    Note over CTX: pending = [] (vidée)

    A->>A: Envoie le prompt enrichi au processus ACP
```

---

## 5. Destruction de l'agent

Le flux de destruction assure un arrêt propre de **tous** les composants.

```mermaid
sequenceDiagram
    participant U as 👤 Utilisateur
    participant A as 🤖 Agent
    participant TM as 🖥️ TerminalManager
    participant T as 📡 Tracer
    participant PROC as ⚙️ copilot process
    participant CONN as 🔌 ACP Connection

    U->>+A: agent.destroy()

    Note over A: Status: DESTROYED (immédiat)
    Note over A: Empêche les erreurs "process exited unexpectedly"

    rect rgb(60, 30, 30)
        Note over A,TM: Phase 1 — Nettoyage des terminaux
        A->>TM: destroyAll()
        TM->>TM: Pour chaque terminal : kill(SIGTERM) + delete
    end

    rect rgb(60, 30, 30)
        Note over A,CONN: Phase 2 — Fermeture du stream ACP
        A->>CONN: outputStream.close()
        Note over CONN: Le SDK détecte la fermeture

        A->>CONN: await connection.closed (timeout 500ms)
    end

    rect rgb(60, 30, 30)
        Note over A,PROC: Phase 3 — Arrêt du processus
        A->>PROC: stdin.end()
        A->>PROC: kill(SIGTERM)

        alt Processus se termine dans les 2s
            PROC-->>A: exit event
        else Timeout 2s dépassé
            A->>PROC: kill(SIGKILL)
        end
    end

    A->>A: emit(AGENT_DESTROYED)
    A->>A: logger.info("Agent destroyed")

    rect rgb(30, 40, 60)
        Note over A,T: Phase 4 — Flush du tracing
        A->>T: shutdown()

        T->>T: Ferme les spans en attente (tracked, active)
        T->>T: endRootSpan()
        T->>T: provider.forceFlush()
        Note over T: Tous les spans sont envoyés à Seq

        T->>T: provider.shutdown()
    end

    A-->>-U: void (destroy terminé)
```

!!! warning "Point important"
    Le status est mis à `DESTROYED` **en tout premier** dans le flux de destruction.
    Cela empêche le handler d'événement `process.exit` d'émettre un faux
    `AGENT_ERROR` quand le processus se termine suite à notre `SIGTERM`.

---

## 6. Flux de tracing complet

Ce diagramme montre la hiérarchie complète des spans créés pendant une session typique.

```mermaid
gantt
    title Hiérarchie des spans OpenTelemetry
    dateFormat X
    axisFormat %s

    section Root
    agent.session                    :active, root, 0, 100

    section Init
    agent.initialize                 :init, 0, 15
    spawn-process                    :spawn, 1, 4
    acp-protocol-init                :acp, 5, 9
    create-session                   :sess, 10, 14

    section Prompt 1
    agent.prompt (1)                 :p1, 16, 55

    section Tool Calls
    agent.tool_call (read file)      :tc1, 20, 28
    agent.permission                 :perm1, 21, 23
    agent.fs.read                    :fs1, 24, 27
    agent.tool_call (exec command)   :tc2, 30, 48
    agent.permission                 :perm2, 31, 33
    agent.terminal                   :term1, 34, 46

    section Prompt 2
    agent.prompt (2)                 :p2, 56, 85
    agent.tool_call (write file)     :tc3, 60, 72
    agent.fs.write                   :fs2, 62, 70
```

### Corrélation Logs ↔ Traces

```mermaid
flowchart LR
    subgraph "Span actif"
        S[agent.tool_call<br/>SpanId: abc123]
    end

    subgraph "pino mixin"
        M["tracer.getTraceContext()"]
    end

    subgraph "Log line"
        LOG["{ msg: 'Tool started',<br/>  TraceId: 'xxx',<br/>  SpanId: 'abc123',<br/>  ParentSpanId: 'yyy' }"]
    end

    subgraph "Seq"
        SEQ[Corrélation automatique<br/>Log → Span → Trace]
    end

    S --> M
    M --> LOG
    LOG -->|pino-seq| SEQ

    style S fill:#f59e0b,stroke:#d97706
    style SEQ fill:#10b981,stroke:#059669,color:#fff
```

!!! tip "Corrélation automatique"
    Grâce au `mixin` Pino qui appelle `tracer.getTraceContext()` à chaque ligne de log,
    **chaque log porte automatiquement le `SpanId` du span le plus spécifique** en cours.
    Seq utilise ces champs (`TraceId`, `SpanId`, `ParentSpanId`) pour reconstruire la hiérarchie.

---

## Résumé des interactions

| Flux | Composants impliqués | Événements émis |
|------|---------------------|-----------------|
| **Init** | Agent → Tracer → ACP → Process | `agent:ready` / `agent:error` |
| **Prompt** | Agent → ContextManager → ACP → SUH → Tracer | `prompt:start` → `prompt:chunk`* → `prompt:complete` |
| **Tool call** | SUH → Tracer, ACF → TerminalManager | `tool:start` → `tool:update`* → `tool:complete` / `tool:failed` |
| **Terminal** | ACF → TerminalManager → Agent | `terminal:created` → `terminal:output`* → `terminal:exit` |
| **Permission** | ACF → Tracer → Agent | `permission:requested` → `permission:granted` / `permission:denied` |
| **FS** | ACF → Tracer → Node.js FS | `fs:read` / `fs:write` |
| **Context** | Agent → ContextManager | `context:injected` |
| **Destroy** | Agent → TerminalManager → Tracer → Process | `agent:destroyed` |

---

## Prochaines lectures

- [**Agent**](../components/agent.md) — L'orchestrateur qui pilote tous ces flux
- [**SessionUpdateHandler**](../components/session-update-handler.md) — Le routeur d'events ACP
- [**Événements typés**](../concepts/events.md) — Le détail de chaque événement émis
- [**Cycle de vie**](../concepts/lifecycle.md) — La machine à états de l'agent