# 🚀 Démarrage rapide

> Ce guide vous accompagne pas-à-pas pour installer, configurer et lancer votre
> premier agent Stark. En 5 minutes, vous aurez un agent autonome qui exécute
> des tâches avec une observabilité complète.

---

## Prérequis

Avant de commencer, assurez-vous d'avoir installé :

| Outil | Version minimale | Vérification |
|-------|-----------------|-------------|
| **Bun** | 1.0+ | `bun --version` |
| **Docker** & **Docker Compose** | 20.10+ | `docker compose version` |
| **Copilot CLI** | 0.0.410+ | `copilot --version` |

!!! tip "Copilot CLI"
    L'exécutable `copilot` est l'agent IA compatible ACP utilisé par Stark.
    Si le binaire n'est pas dans votre `PATH`, vous pouvez définir la variable
    d'environnement `COPILOT_CLI_PATH` ou le passer via la config `executable`.

---

## Étape 1 — Cloner et installer

```bash
# Cloner le projet
git clone <repo-url> stark
cd stark

# Installer les dépendances
bun install
```

Les dépendances principales installées :

| Package | Rôle |
|---------|------|
| `@agentclientprotocol/sdk` | SDK du protocole ACP |
| `pino` + `pino-pretty` + `pino-seq` | Logging multi-transport |
| `@opentelemetry/*` | Tracing distribué |
| `@faker-js/faker` | Génération de noms d'agents |

---

## Étape 2 — Lancer les services

Stark utilise Docker Compose pour deux services :

- **Seq** — Visualisation des logs et traces (`http://localhost:8082`)
- **MkDocs** — Cette documentation (`http://localhost:8083`)

```bash
# Lancer les services en arrière-plan
bun run up
# ou directement :
docker compose up -d
```

Vérifiez que les services sont en bonne santé :

```bash
docker compose ps
```

Vous devriez voir :

```
NAME          STATUS          PORTS
stark-seq     Up (healthy)    0.0.0.0:8082->80/tcp, 0.0.0.0:5341->5341/tcp
stark-docs    Up (healthy)    0.0.0.0:8083->8000/tcp
```

!!! success "Vérification"
    Ouvrez ces URLs dans votre navigateur :

    - **Seq** : [http://localhost:8082](http://localhost:8082) — Interface de logs
    - **Documentation** : [http://localhost:8083](http://localhost:8083) — Ce site

---

## Étape 3 — Lancer votre premier agent

### Via la commande `start`

Le script `start` lance le fichier `src/index.ts` qui démontre toutes les capacités :

```bash
# Avec le prompt par défaut
bun run start

# Avec un prompt personnalisé
bun run start "Crée un fichier hello.ts qui affiche Hello World"
```

### Via du code TypeScript

Créez un fichier `my-agent.ts` :

```typescript
import { Agent } from "./src/classes/agent/agent.ts";
import { AgentEvent } from "./src/enums/agent-event.enum.ts";

async function main() {
  // 1. Créer l'agent
  const agent = new Agent({
    cwd: process.cwd(),
    logOutput: { console: true, seq: true },
    tracing: true,
    autoApprove: true,
  });

  // 2. Écouter le streaming en temps réel
  agent.on(AgentEvent.PROMPT_CHUNK, (e) => {
    process.stdout.write(e.text);
  });

  // 3. Attendre que l'agent soit prêt
  await agent.ready;
  console.error(`\n✅ Agent "${agent.name}" prêt !\n`);

  // 4. Envoyer un prompt
  const result = await agent.prompt("Dis-moi bonjour en 3 langues différentes");

  console.error(`\n📊 Stop: ${result.stopReason}`);
  if (result.usage) {
    console.error(`📊 Tokens: ${result.usage.totalTokens}`);
  }

  // 5. Nettoyer
  await agent.destroy();
}

main().catch(console.error);
```

Lancez-le :

```bash
bun run my-agent.ts
```

---

## Étape 4 — Observer dans Seq

Ouvrez [http://localhost:8082](http://localhost:8082) dans votre navigateur.

### Logs structurés

Vous verrez les logs de votre agent avec :

- Le **nom de l'agent** comme préfixe
- Les **tool calls**, **terminaux** et **opérations FS**
- Les **métriques d'usage** (tokens, coûts)

### Traces (OpenTelemetry)

Cliquez sur un log qui porte un `TraceId` pour voir la **trace complète** :

- Le **root span** `agent.session` englobe toute la vie de l'agent
- Les **prompt spans** montrent la durée de chaque prompt
- Les **tool call spans** montrent ce que l'agent a exécuté

---

## Étape 5 — Écouter les événements

L'agent émet des événements typés pour chaque action. Voici un exemple
qui affiche un résumé des actions effectuées :

```typescript
import { Agent } from "./src/classes/agent/agent.ts";
import { AgentEvent } from "./src/enums/agent-event.enum.ts";

async function main() {
  const agent = new Agent({
    cwd: process.cwd(),
    logOutput: { console: true },
    autoApprove: true,
  });

  // Streaming de la réponse
  agent.on(AgentEvent.PROMPT_CHUNK, (e) => {
    process.stdout.write(e.text);
  });

  // Suivi des outils
  agent.on(AgentEvent.TOOL_START, (e) => {
    console.error(`  🔧 ${e.title}${e.command ? ` → $ ${e.command}` : ""}`);
  });

  agent.on(AgentEvent.TOOL_COMPLETE, (e) => {
    console.error(`  ✅ ${e.title} (exit ${e.exitCode ?? "?"})`);
  });

  agent.on(AgentEvent.TOOL_FAILED, (e) => {
    console.error(`  ❌ ${e.title} (exit ${e.exitCode ?? "?"})`);
  });

  // Fichiers
  agent.on(AgentEvent.FS_WRITE, (e) => {
    console.error(`  💾 Wrote: ${e.path} (${e.contentLength} chars)`);
  });

  // Usage
  agent.on(AgentEvent.USAGE_UPDATE, (e) => {
    let msg = `  📊 Context: ${e.contextPercent}%`;
    if (e.cost) msg += ` | $${e.cost.amount.toFixed(4)}`;
    console.error(msg);
  });

  await agent.ready;
  console.error(`\n🤖 Agent "${agent.name}" (${agent.id})`);
  console.error(`📡 Session: ${agent.sessionId}\n`);

  const result = await agent.prompt(
    process.argv[2] ?? "Crée un fichier hello.ts avec un Hello World"
  );

  console.error(`\n✅ Terminé: ${result.stopReason}`);

  // Snapshot final
  const snap = agent.snapshot();
  console.error(`📊 Prompts: ${snap.promptCount}`);

  await agent.destroy();
}

main().catch(console.error);
```

---

## Étape 6 — Injection de contexte

L'injection de contexte permet de modifier le comportement de l'agent entre les prompts :

```typescript
import { Agent } from "./src/classes/agent/agent.ts";
import { AgentEvent } from "./src/enums/agent-event.enum.ts";

async function main() {
  const agent = new Agent({
    cwd: process.cwd(),
    logOutput: { console: true },
    autoApprove: true,
  });

  agent.on(AgentEvent.PROMPT_CHUNK, (e) => {
    process.stdout.write(e.text);
  });

  await agent.ready;

  // Premier prompt — création d'un fichier
  console.error("\n── Prompt 1: Création ──\n");
  await agent.prompt("Crée un fichier utils.ts avec une fonction add(a, b)");

  // Injection de contexte — modifie le comportement pour la suite
  agent.injectContext("À partir de maintenant, ajoute des commentaires JSDoc à tout le code.");
  agent.injectContext("Utilise TypeScript strict mode avec des types explicites.");

  // Second prompt — le contexte injecté influence le résultat
  console.error("\n\n── Prompt 2: Amélioration (avec contexte injecté) ──\n");
  await agent.prompt("Ajoute une fonction multiply au même fichier");

  await agent.destroy();
}

main().catch(console.error);
```

---

## Arrêter les services

```bash
# Arrêter Seq et MkDocs
bun run down
# ou directement :
docker compose down
```

Pour supprimer aussi les volumes (données Seq) :

```bash
docker compose down -v
```

---

## Structure du projet

```
stark/
├── src/
│   ├── classes/
│   │   ├── agent/                   # Agent + composants internes
│   │   │   ├── agent.ts             # Orchestrateur principal
│   │   │   ├── agent-context-manager.ts
│   │   │   ├── agent-session-update-handler.ts
│   │   │   └── agent-acp-client-factory.ts
│   │   ├── terminal-manager/        # Gestion des processus
│   │   │   └── terminal-manager.ts
│   │   └── tracer/                  # Tracing OpenTelemetry
│   │       ├── tracer.ts
│   │       ├── create-tracer-provider.ts
│   │       └── constants.ts
│   ├── enums/                       # AgentEvent, AgentStatus, SessionUpdateType
│   ├── logger/                      # createLogger (Pino multi-transport)
│   ├── types/                       # Types TypeScript (events, config, observability)
│   ├── utils/                       # Formatting, identity, tool-parsing
│   └── index.ts                     # Point d'entrée / démo
├── docs/                            # Cette documentation (MkDocs)
├── tests/                           # Tests unitaires
├── logs/                            # Fichiers de logs NDJSON
├── docker-compose.yml               # Seq + MkDocs
├── mkdocs.yml                       # Configuration MkDocs
├── package.json
├── tsconfig.json
└── biome.json                       # Linter / formatter
```

---

## Scripts npm

| Script | Commande | Description |
|--------|----------|-------------|
| `start` | `bun run src/index.ts` | Lance la démo de l'agent |
| `test` | `bun test` | Lance les tests unitaires |
| `check` | `biome check --write` | Lint + format automatique |
| `check-types` | `tsc --noEmit` | Vérification des types TypeScript |
| `up` | `docker compose up -d` | Lance Seq + MkDocs |
| `down` | `docker compose down` | Arrête les services |

---

## Prochaines étapes

Maintenant que votre premier agent fonctionne, explorez le système en profondeur :

- [**Architecture**](../architecture/overview.md) — Comprendre les composants et leurs relations
- [**Agent**](../components/agent.md) — API complète de l'orchestrateur
- [**Configuration**](configuration.md) — Toutes les options de configuration
- [**Événements typés**](../concepts/events.md) — Les 27 événements disponibles
- [**Cycle de vie**](../concepts/lifecycle.md) — Machine à états de l'agent
- [**Flux & Séquences**](../architecture/sequences.md) — Comprendre les flux internes

!!! success "Félicitations !"
    Vous avez lancé votre premier agent Stark ! 🎉
    Explorez les autres sections de la documentation pour maîtriser toutes les
    possibilités du système.