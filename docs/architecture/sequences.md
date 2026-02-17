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
    participant L as 📝 Logger
    participant TM as 🖥️ TerminalManager
    participant CTX as 📋 ContextManager
    participant SUH as 🔀 SessionUpdateHandler
    participant ACF as 🏭 ACPClientFactory
    participant PROC as ⚙️ copilot process

    Note over U,A: Construction (synchrone)

    U->>+A: new Agent(config)

    A->>L: createLogger(identity)
    L-->>A: pino logger

    A->>CTX: new AgentContextManager()
    A->>TM: new TerminalManager()

    A->>SUH: new SessionUpdateHandler(logger, emitEvent)
    A->>ACF: new ACPClientFactory(logger, emitEvent, TM, config)

    A->>TM: setOutputCallback(cb)
    A->>TM: setExitCallback(cb)

    Note over A: Status: INITIALIZING

    A-->>U: agent (ready = Promise<void>)

    Note over A,PROC: Initialisation async (agent.ready)

    rect rgb(40, 40, 70)
        Note over A,PROC: Phase 1 — Spawn du processus

        A->>PROC: spawn("copilot", ["--acp", "--stdio"])
        PROC-->>A: ChildProcess (stdin/stdout pipes)
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

        A->>PROC: connection.initialize({ protocolVersion, capabilities })
        PROC-->>A: { protocolVersion, agentInfo }
        A->>L: info("ACP protocol initialized")
    end

    rect rgb(40, 40, 70)
        Note over A,PROC: Phase 4 — Création de session

        A->>PROC: connection.newSession({ cwd, mcpServers })
        PROC-->>A: { sessionId }
        A->>L: info("Session created")
    end

    Note over A: Status: IDLE

    A->>A: emit(AGENT_READY, { sessionId })
    A-->>U: ready resolved ✅
```

!!! info "Gestion des erreurs"
    Si n'importe quelle phase échoue, le status passe à `ERROR`, et un événement `agent:error` est émis.
    La promise `agent.ready` est rejetée.

---

## 2. Envoi d'un prompt

Le flux principal : l'utilisateur envoie un message, l'agent IA traite et répond en streaming.

```mermaid
sequenceDiagram
    participant U as 👤 Utilisateur
    participant A as 🤖 Agent
    participant CTX as 📋 ContextManager
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
            SUH->>A: emitEvent(TOOL_START)

        else usage_update
            SUH->>A: emitEvent(USAGE_UPDATE, { percent, cost })

        else plan
            SUH->>A: emitEvent(PLAN_UPDATE, { entries })
        end
    end

    CONN-->>-A: { stopReason, usage }

    A->>A: emit(PROMPT_COMPLETE, { stopReason, fullText })
    A->>L: info("Prompt completed")

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
    participant L as 📝 Logger
    participant A as 🤖 Agent

    PROC->>CONN: requestPermission({ toolCall, options })
    CONN->>ACF: handlePermission(params)

    alt autoApprove = true
        ACF->>ACF: Cherche option "allow_once" ou "allow_always"
        ACF->>A: emitEvent(PERMISSION_GRANTED)
        ACF-->>CONN: { outcome: "selected", optionId }
    else autoApprove = false
        ACF->>A: emitEvent(PERMISSION_DENIED)
        ACF-->>CONN: { outcome: "cancelled" }
    end

    PROC->>CONN: createTerminal({ command: "node server.js", cwd })
    CONN->>ACF: handleCreateTerminal(params)
    ACF->>TM: create({ command, args, cwd, env })
    TM->>TM: spawn(command, args, { cwd, shell: true })
    TM-->>ACF: ManagedTerminal { terminalId, child }

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
    participant FS as 📂 Node.js FS
    participant A as 🤖 Agent

    Note over PROC,ACF: Écriture de fichier

    PROC->>CONN: writeTextFile({ path, content })
    CONN->>ACF: handleWriteTextFile(params)
    ACF->>A: emitEvent(FS_WRITE, { path, contentLength })

    ACF->>FS: mkdir(dirname(path), { recursive: true })
    ACF->>FS: writeFile(path, content, "utf-8")
    FS-->>ACF: ✅

    ACF-->>CONN: {}

    Note over PROC,ACF: Lecture de fichier

    PROC->>CONN: readTextFile({ path })
    CONN->>ACF: handleReadTextFile(params)

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
    participant A as 🤖 Agent

    PROC->>SUH: handle({ sessionUpdate: "tool_call", toolCallId, title, kind })

    SUH->>SUH: toolCalls.set(toolCallId, { title, kind })
    SUH->>A: emitEvent(TOOL_START, { toolCallId, title, kind, command })

    loop Updates intermédiaires
        PROC->>SUH: handle({ sessionUpdate: "tool_call_update", status: "in_progress" })
        SUH->>A: emitEvent(TOOL_UPDATE, { output, exitCode })
    end

    alt status === "completed"
        PROC->>SUH: handle({ sessionUpdate: "tool_call_update", status: "completed" })
        SUH->>A: emitEvent(TOOL_COMPLETE, { title, exitCode })

    else status === "failed"
        PROC->>SUH: handle({ sessionUpdate: "tool_call_update", status: "failed" })
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

    Note over A: Status: IDLE

    U->>A: agent.injectContext("Utilise TypeScript strict mode")

    A->>A: queued = false (status !== BUSY)
    A->>A: emit(CONTEXT_INJECTED, { instructions, queued: false })
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

    A-->>-U: void (destroy terminé)
```

!!! warning "Point important"
    Le status est mis à `DESTROYED` **en tout premier** dans le flux de destruction.
    Cela empêche le handler d'événement `process.exit` d'émettre un faux
    `AGENT_ERROR` quand le processus se termine suite à notre `SIGTERM`.

---

## Résumé des interactions

| Flux | Composants impliqués | Événements émis |
|------|---------------------|-----------------|
| **Init** | Agent → ACP → Process | `agent:ready` / `agent:error` |
| **Prompt** | Agent → ContextManager → ACP → SUH | `prompt:start` → `prompt:chunk`* → `prompt:complete` |
| **Tool call** | SUH, ACF → TerminalManager | `tool:start` → `tool:update`* → `tool:complete` / `tool:failed` |
| **Terminal** | ACF → TerminalManager → Agent | `terminal:created` → `terminal:output`* → `terminal:exit` |
| **Permission** | ACF → Agent | `permission:requested` → `permission:granted` / `permission:denied` |
| **FS** | ACF → Node.js FS | `fs:read` / `fs:write` |
| **Context** | Agent → ContextManager | `context:injected` |
| **Destroy** | Agent → TerminalManager → Process | `agent:destroyed` |

---

## Prochaines lectures

- [**Agent**](../components/agent.md) — L'orchestrateur qui pilote tous ces flux
- [**SessionUpdateHandler**](../components/session-update-handler.md) — Le routeur d'events ACP
- [**Événements typés**](../concepts/events.md) — Le détail de chaque événement émis
- [**Cycle de vie**](../concepts/lifecycle.md) — La machine à états de l'agent