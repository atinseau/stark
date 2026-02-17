# 🏭 ACPClientFactory — Construction du client ACP

> L'`ACPClientFactory` est la **fabrique** qui construit l'objet `acp.Client` —
> l'implémentation concrète de tous les callbacks que l'agent IA peut invoquer :
> permissions, filesystem, terminal. C'est le pont entre le protocole ACP et
> l'infrastructure de Stark.

---

## Rôle et importance

Quand l'agent IA veut exécuter une commande, lire un fichier ou demander une permission,
il envoie une requête via le protocole ACP. Le SDK ACP route cette requête vers le bon
callback de l'objet `acp.Client`. L'ACPClientFactory **construit cet objet** en câblant
chaque callback aux bons composants de Stark.

| Responsabilité | Description |
|----------------|-------------|
| 🏗️ **Construction** | Produit un `acp.Client` complet via `build()` |
| 🔐 **Permissions** | Gère les demandes d'autorisation (auto-approve ou refus) |
| 📂 **Filesystem** | Implémente la lecture et l'écriture de fichiers |
| 🖥️ **Terminal** | Délègue au [TerminalManager](terminal-manager.md) pour les processus |
| 📊 **Observabilité** | Chaque opération est loguée et émise comme événement |
| 🧩 **Découplé** | Ne connaît pas l'Agent — communique uniquement via les dépendances injectées |

```mermaid
flowchart TB
    subgraph "ACPClientFactory"
        BUILD["build(onSessionUpdate)"]
        BUILD --> CLIENT["acp.Client"]

        subgraph "Callbacks"
            PERM["requestPermission"]
            WRITE["writeTextFile"]
            READ["readTextFile"]
            CREATE_T["createTerminal"]
            OUTPUT_T["terminalOutput"]
            WAIT_T["waitForTerminalExit"]
            RELEASE_T["releaseTerminal"]
            KILL_T["killTerminal"]
            SESSION["sessionUpdate"]
        end

        CLIENT --> PERM & WRITE & READ & CREATE_T
        CLIENT --> OUTPUT_T & WAIT_T & RELEASE_T & KILL_T
        CLIENT --> SESSION
    end

    subgraph "Dépendances injectées"
        L["Logger"]
        E["emitEvent"]
        TM["TerminalManager"]
        CFG["Config { autoApprove }"]
    end

    L --> BUILD
    E --> BUILD
    TM --> BUILD
    CFG --> BUILD

    style BUILD fill:#8b5cf6,stroke:#7c3aed,color:#fff
    style CLIENT fill:#7c3aed,stroke:#5b21b6,color:#fff
    style L fill:#3b82f6,stroke:#2563eb,color:#fff
    style E fill:#10b981,stroke:#059669,color:#fff
    style TM fill:#1e293b,stroke:#475569,color:#fff
```

---

## Instanciation

L'ACPClientFactory reçoit ses **quatre dépendances** par injection dans le constructeur :

```typescript
import { AgentAcpClientFactory } from "./classes/agent/agent-acp-client-factory.ts";

const factory = new AgentAcpClientFactory(
  logger,           // pino.Logger — logging structuré
  emitEvent,        // EmitEventFn — callback d'émission d'événements
  terminalManager,  // TerminalManager — gestion des processus
  { autoApprove: true },  // Config — comportement des permissions
);
```

### Instanciation dans l'Agent

```typescript
// Dans le constructeur de Agent :
this.acpClientFactory = new AgentAcpClientFactory(
  this.logger,
  this.emitTyped.bind(this),
  this.terminalManager,
  { autoApprove: this.config.autoApprove },
);
```

---

## La méthode `build()` — Construire le client ACP

C'est la méthode principale. Elle retourne un objet `acp.Client` complet :

```typescript
const client = acpClientFactory.build((update) => {
  sessionUpdateHandler.handle(update);
});

// Le client est ensuite passé au SDK ACP :
const connection = new ClientSideConnection(client, ndJsonStream);
```

### Structure du client retourné

```mermaid
graph TB
    BUILD["build(onSessionUpdate)"] --> CLIENT["acp.Client"]

    CLIENT --> P["requestPermission()"]
    CLIENT --> SU["sessionUpdate()"]
    CLIENT --> W["writeTextFile()"]
    CLIENT --> R["readTextFile()"]
    CLIENT --> CT["createTerminal()"]
    CLIENT --> TO["terminalOutput()"]
    CLIENT --> WE["waitForTerminalExit()"]
    CLIENT --> RT["releaseTerminal()"]
    CLIENT --> KT["killTerminal()"]

    P -.- P_DESC["Gère auto-approve / refus"]
    SU -.- SU_DESC["Délègue au SessionUpdateHandler"]
    W -.- W_DESC["Écriture fichier + mkdir récursif"]
    R -.- R_DESC["Lecture fichier UTF-8"]
    CT -.- CT_DESC["Délègue au TerminalManager"]
    TO -.- TO_DESC["Récupère l'output accumulé"]
    WE -.- WE_DESC["Attend la fin du processus"]
    RT -.- RT_DESC["Release + SIGTERM"]
    KT -.- KT_DESC["Kill immédiat"]

    style BUILD fill:#8b5cf6,stroke:#7c3aed,color:#fff
    style CLIENT fill:#7c3aed,stroke:#5b21b6,color:#fff
```

---

## Les callbacks en détail

### 1. `requestPermission` — Gestion des permissions

C'est le callback de **sécurité**. Avant chaque action sensible, l'agent IA demande
l'autorisation au client.

```mermaid
sequenceDiagram
    participant ACP as Agent IA
    participant ACF as ACPClientFactory
    participant A as Agent Events

    ACP->>ACF: requestPermission({ toolCall, options })

    ACF->>A: emitEvent(PERMISSION_REQUESTED)

    alt autoApprove = true
        ACF->>ACF: Cherche option "allow_once" ou "allow_always"

        alt Option trouvée
            ACF->>A: emitEvent(PERMISSION_GRANTED, { optionId, optionName })
            ACF-->>ACP: { outcome: "selected", optionId }
        else Aucune option "allow"
            ACF->>A: emitEvent(PERMISSION_DENIED, { reason })
            ACF-->>ACP: { outcome: "cancelled" }
        end

    else autoApprove = false
        ACF->>A: emitEvent(PERMISSION_DENIED, { reason: "Auto-approve disabled" })
        ACF-->>ACP: { outcome: "cancelled" }
    end
```

#### Options de permission

L'agent IA propose toujours plusieurs options. L'ACPClientFactory cherche la première
option de type "allow" :

```typescript
const allowOption = params.options.find(
  (o) => o.kind === "allow_always" || o.kind === "allow_once",
);
```

| Kind de l'option | Description | Sélectionné par autoApprove ? |
|------------------|-------------|-------------------------------|
| `allow_once` | Autoriser cette fois | ✅ Oui (prioritaire) |
| `allow_always` | Autoriser toujours | ✅ Oui |
| `deny` | Refuser | ❌ Non |

!!! info "Denial ≠ Error"
    Un refus de permission est un **résultat métier valide**, pas une erreur opérationnelle.

---

### 2. `sessionUpdate` — Notifications de session

Ce callback transmet les `SessionUpdate` au handler injecté via `build()` :

```typescript
sessionUpdate: (update) => {
  onSessionUpdate(update);
},
```

C'est un simple pass-through vers le [SessionUpdateHandler](session-update-handler.md).

---

### 3. `writeTextFile` — Écriture de fichier

Quand l'agent IA veut créer ou modifier un fichier :

```mermaid
sequenceDiagram
    participant ACP as Agent IA
    participant ACF as ACPClientFactory
    participant FS as Node.js FS
    participant A as Agent Events

    ACP->>ACF: writeTextFile({ path: "/src/server.ts", content: "..." })

    ACF->>A: emitEvent(FS_WRITE, { path, contentLength })

    ACF->>FS: mkdir(dirname(path), { recursive: true })
    ACF->>FS: writeFile(path, content, "utf-8")
    FS-->>ACF: ✅

    ACF-->>ACP: {}
```

**Points importants :**

- Le répertoire parent est créé automatiquement avec `mkdir({ recursive: true })`
- L'écriture est encodée en UTF-8
- L'événement `FS_WRITE` est émis **avant** l'écriture (pour le suivi en temps réel)

```typescript
private async handleWriteTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
  // Événement émis AVANT l'écriture
  this.logAndEmit(
    AgentEvent.FS_WRITE,
    { path: params.path, contentLength: params.content.length },
    `FS write: ${params.path}`,
  );

  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");

  await mkdir(dirname(params.path), { recursive: true });
  await writeFile(params.path, params.content, "utf-8");

  return {};
}
```

---

### 4. `readTextFile` — Lecture de fichier

Quand l'agent IA veut lire le contenu d'un fichier :

```mermaid
sequenceDiagram
    participant ACP as Agent IA
    participant ACF as ACPClientFactory
    participant FS as Node.js FS
    participant A as Agent Events

    ACP->>ACF: readTextFile({ path: "/src/server.ts" })

    ACF->>FS: readFile(path, "utf-8")
    FS-->>ACF: content (string)

    ACF->>A: emitEvent(FS_READ, { path, contentLength })
    ACF-->>ACP: { content }
```

**Différence avec `writeTextFile` :** L'événement `FS_READ` est émis **après** la lecture
(car on a besoin de la taille du contenu).

---

### 5. `createTerminal` — Création d'un terminal

Quand l'agent IA veut exécuter une commande shell :

```mermaid
sequenceDiagram
    participant ACP as Agent IA
    participant ACF as ACPClientFactory
    participant TM as TerminalManager
    participant A as Agent Events

    ACP->>ACF: createTerminal({ command: "npm", args: ["test"], cwd: "/project" })

    ACF->>TM: create(params)
    TM-->>ACF: ManagedTerminal { terminalId: "term-1-12345" }

    ACF->>A: emitEvent(TERMINAL_CREATED, { terminalId, command, args, cwd })

    ACF-->>ACP: { terminalId: "term-1-12345" }
```

---

### 6. `terminalOutput` — Sortie d'un terminal

Retourne l'output accumulé d'un terminal :

```typescript
terminalOutput: (params) => {
  return this.terminalManager.getOutput(params.terminalId);
},
```

---

### 7. `waitForTerminalExit` — Attente de fin

Attend qu'un terminal se termine et retourne son code de sortie :

```typescript
waitForTerminalExit: async (params) => {
  return this.terminalManager.waitForExit(params.terminalId);
},
```

---

### 8. `releaseTerminal` — Libération d'un terminal

Libère un terminal (SIGTERM + suppression de la map) :

```typescript
releaseTerminal: (params) => {
  this.terminalManager.release(params.terminalId);
  this.logAndEmit(
    AgentEvent.TERMINAL_RELEASED,
    { terminalId: params.terminalId },
    `Terminal released: ${params.terminalId}`,
  );
  return {};
},
```

---

### 9. `killTerminal` — Kill d'un terminal

Kill immédiat d'un terminal (SIGKILL) :

```typescript
killTerminal: (params) => {
  this.terminalManager.kill(params.terminalId);
  return {};
},
```

---

## Le helper `logAndEmit`

Un pattern récurrent dans l'ACPClientFactory : chaque action doit à la fois :

1. Produire un **log structuré** (pour l'observabilité)
2. Émettre un **événement typé** (pour l'orchestration)

Le helper `logAndEmit` combine les deux en un seul appel :

```typescript
private logAndEmit<K extends AgentEvent>(
  event: K,
  payload: Omit<AgentEventMap[K], keyof BaseAgentEvent>,
  message: string,
): void {
  this.logger.info(payload, message);
  this.emitEvent(event, payload);
}
```

**Exemples d'utilisation :**

```typescript
// Écriture de fichier
this.logAndEmit(AgentEvent.FS_WRITE, { path, contentLength }, `FS write: ${path}`);

// Lecture de fichier
this.logAndEmit(AgentEvent.FS_READ, { path, contentLength }, `FS read: ${path}`);

// Création de terminal
this.logAndEmit(
  AgentEvent.TERMINAL_CREATED,
  { terminalId, command, args, cwd },
  `Terminal created: ${command}`,
);
```

---

## Diagramme d'architecture interne

```mermaid
graph TB
    subgraph "ACPClientFactory"
        CTOR["constructor(logger, emitEvent, TM, config)"]
        BUILD_M["build(onSessionUpdate)"]
        BUILD_M --> CLIENT["acp.Client { 9 callbacks }"]

        subgraph "Private handlers"
            HP["handlePermission()"]
            HW["handleWriteTextFile()"]
            HR["handleReadTextFile()"]
            HCT["handleCreateTerminal()"]
            HRT["handleReleaseTerminal()"]
        end

        subgraph "Private utilities"
            LAE["logAndEmit()"]
        end

        CLIENT --> HP & HW & HR & HCT & HRT
        HP --> LAE
        HW --> LAE
        HR --> LAE
        HCT --> LAE
    end

    style CLIENT fill:#7c3aed,stroke:#5b21b6,color:#fff
    style BUILD_M fill:#8b5cf6,stroke:#7c3aed,color:#fff
```

---

## Comparaison avec le SessionUpdateHandler

L'ACPClientFactory et le [SessionUpdateHandler](session-update-handler.md) sont les **deux faces**
de la communication ACP :

```mermaid
flowchart LR
    subgraph "Agent IA → Client"
        direction TB
        REQ["Requêtes<br/>(permission, FS, terminal)"]
        ACF["ACPClientFactory<br/><em>Gère les requêtes</em>"]
        REQ --> ACF
    end

    subgraph "Agent IA → Client (notifications)"
        direction TB
        NOTIF["Notifications<br/>(SessionUpdate)"]
        SUH["SessionUpdateHandler<br/><em>Route les updates</em>"]
        NOTIF --> SUH
    end

    style ACF fill:#8b5cf6,stroke:#7c3aed,color:#fff
    style SUH fill:#8b5cf6,stroke:#7c3aed,color:#fff
```

| Aspect | ACPClientFactory | SessionUpdateHandler |
|--------|-----------------|---------------------|
| **Direction** | Agent IA → Client (requêtes) | Agent IA → Client (notifications) |
| **Modèle** | Request/Response | Fire-and-forget |
| **Retour** | Chaque callback retourne une réponse | Pas de retour (`void`) |
| **Actions** | Effectue des actions (FS, terminal, permissions) | Observe et dispatche |
| **État** | Pas d'état interne significatif | `toolCalls` map + `responseText` |
| **Dépendances** | Logger, emitEvent, **TerminalManager**, config | Logger, emitEvent |

---

## Flux complet — De la requête ACP au résultat

Voici un flux complet montrant comment une requête ACP traverse l'ACPClientFactory :

```mermaid
sequenceDiagram
    participant PROC as ⚙️ copilot
    participant SDK as 📦 ACP SDK
    participant CLIENT as 🏭 acp.Client
    participant ACF as ACPClientFactory
    participant TM as TerminalManager
    participant L as Logger
    participant A as Agent Events

    Note over PROC,SDK: L'agent IA veut exécuter "npm test"

    PROC->>SDK: JSON-RPC request: createTerminal
    SDK->>CLIENT: client.createTerminal({ command: "npm", args: ["test"] })
    CLIENT->>ACF: handleCreateTerminal(params)

    ACF->>TM: create(params)
    TM->>TM: spawn("npm", ["test"], { shell: true })
    TM-->>ACF: ManagedTerminal { terminalId: "term-1-42" }

    ACF->>L: info("Terminal created: npm")
    ACF->>A: emitEvent(TERMINAL_CREATED, { terminalId, command, args })

    ACF-->>CLIENT: { terminalId: "term-1-42" }
    CLIENT-->>SDK: response
    SDK-->>PROC: JSON-RPC response: { terminalId: "term-1-42" }

    Note over PROC: L'agent IA attend la fin

    PROC->>SDK: waitForTerminalExit({ terminalId })
    SDK->>CLIENT: client.waitForTerminalExit(params)
    CLIENT->>ACF: (delegate)
    ACF->>TM: waitForExit("term-1-42")

    Note over TM: Attend l'événement exit du processus

    TM-->>ACF: { exitCode: 0 }
    ACF-->>CLIENT: { exitCode: 0 }
    CLIENT-->>SDK: response
    SDK-->>PROC: { exitCode: 0 }
```

---

## Séparation des responsabilités

L'ACPClientFactory est le **seul** composant qui interagit directement avec le
[TerminalManager](terminal-manager.md) pour les requêtes ACP. L'Agent câble les callbacks
du TerminalManager (output, exit) séparément.

```mermaid
graph TB
    subgraph "Requêtes ACP (via ACPClientFactory)"
        ACF["ACPClientFactory"]
        ACF -->|"create()"| TM["TerminalManager"]
        ACF -->|"getOutput()"| TM
        ACF -->|"waitForExit()"| TM
        ACF -->|"release()"| TM
        ACF -->|"kill()"| TM
    end

    subgraph "Callbacks (câblés par l'Agent)"
        AGENT["Agent"]
        TM -->|"onOutput()"| AGENT
        TM -->|"onExit()"| AGENT
    end

    style ACF fill:#8b5cf6,stroke:#7c3aed,color:#fff
    style AGENT fill:#7c3aed,stroke:#5b21b6,color:#fff
    style TM fill:#1e293b,stroke:#475569,color:#fff
```

!!! tip "Pourquoi cette séparation ?"
    L'ACPClientFactory gère les **requêtes synchrones** de l'ACP (create, getOutput, etc.),
    tandis que l'Agent gère les **événements asynchrones** du TerminalManager (output, exit).
    Cela évite un couplage circulaire et permet de tester chaque flux indépendamment.

---

## Configuration

L'ACPClientFactory n'a qu'un seul paramètre de configuration :

```typescript
interface AgentAcpClientFactoryConfig {
  /** Quand true, les permissions sont automatiquement approuvées */
  autoApprove: boolean;
}
```

| Valeur | Comportement |
|--------|-------------|
| `true` (défaut) | Sélectionne la première option "allow" disponible |
| `false` | Refuse toutes les demandes de permission |

---

## Exemple d'utilisation autonome

L'ACPClientFactory peut être instancié indépendamment pour les tests :

```typescript
import { AgentAcpClientFactory } from "./classes/agent/agent-acp-client-factory.ts";
import { TerminalManager } from "./classes/terminal-manager/terminal-manager.ts";
import { createSilentLogger } from "./logger/create-logger.ts";
import { AgentEvent } from "./enums/agent-event.enum.ts";

// Créer les dépendances
const logger = createSilentLogger();
const terminalManager = new TerminalManager();

const events: Array<{ event: string; payload: unknown }> = [];
const emitEvent = (event: AgentEvent, payload: unknown) => {
  events.push({ event, payload });
};

// Créer la factory
const factory = new AgentAcpClientFactory(
  logger,
  emitEvent,
  terminalManager,
  { autoApprove: true },
);

// Construire le client
const client = factory.build((update) => {
  console.log("Session update:", update.sessionUpdate);
});

// Utiliser un callback directement
const writeResult = await client.writeTextFile({
  path: "/tmp/test.txt",
  content: "Hello World",
});
console.log(writeResult); // {}
console.log(events[0].event); // "fs:write"

// Créer un terminal
const termResult = await client.createTerminal({
  command: "echo",
  args: ["test"],
  cwd: "/tmp",
});
console.log(termResult.terminalId); // "term-1-..."

// Nettoyer
terminalManager.destroyAll();
```

---

## Résumé

| Concept | Description |
|---------|-------------|
| **Pattern** | Factory — produit un `acp.Client` via `build()` |
| **Callbacks** | 9 callbacks couvrant permissions, FS et terminal |
| **Permissions** | Auto-approve configurable |
| **Filesystem** | Read/write avec mkdir récursif |
| **Terminal** | Délégation complète au TerminalManager |
| **Helper** | `logAndEmit()` combine logging + événement en un appel |
| **Dépendances** | Logger, emitEvent, TerminalManager, config |
| **État** | Minimal — pas de Map ni d'accumulateur |

---

## Liens

- [**Architecture**](../architecture/overview.md) — Vue d'ensemble du système
- [**Agent**](agent.md) — L'orchestrateur qui crée l'ACPClientFactory
- [**Agent Client Protocol**](acp.md) — Le protocole dont cette factory implémente le client
- [**SessionUpdateHandler**](session-update-handler.md) — L'autre face de la communication ACP
- [**TerminalManager**](terminal-manager.md) — Gestion des processus, utilisé par la factory
- [**Événements typés**](../concepts/events.md) — Events émis par la factory
- [**Flux & Séquences**](../architecture/sequences.md) — Diagrammes montrant la factory en action