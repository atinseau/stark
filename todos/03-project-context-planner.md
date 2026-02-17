# Évolution 03 — Injection du contexte projet dans le Planner

## Priorité : 🟠 P1

## Dépendances : Aucune

## Acquis des évolutions précédentes

- **Évolution 01** : L'`InformationBroker` reçoit les mappings `subtaskToAgent` / `agentToSubtask` via son constructeur. La méthode `isAgentForSubtask()` fonctionne. Le tri des candidats par dépendance est opérationnel. La méthode `findDependency()` traduit correctement entre agent IDs et subtask IDs.
- **Évolution 02** : L'`InformationBroker` maintient un `SharingHistory` indexé par agent cible. Le prompt de partage inclut les partages précédents pour éviter la redondance. `recordSharing()` est appelé après chaque injection réussie. Le type `SharingRecord` existe dans `agent-pool.types.ts`.

---

## Contexte du problème

Le `TaskPlanner` analyse une tâche utilisateur et décide de la stratégie d'exécution (single vs multi-agent). Pour prendre cette décision, il se base **uniquement** sur le texte de la tâche — il n'a aucune connaissance du projet dans lequel les agents vont travailler.

### Ce que le planner ne sait pas aujourd'hui

1. **Structure du projet** : quels fichiers/dossiers existent déjà, quel est le langage principal, quel framework est utilisé
2. **Dépendances** : quel package manager, quelles libs sont installées (package.json, Cargo.toml, pyproject.toml, etc.)
3. **Conventions** : structure des dossiers, patterns utilisés, fichier de config (tsconfig, biome, eslint, etc.)
4. **État actuel** : y a-t-il déjà du code ? est-ce un projet vierge ? y a-t-il des tests existants ?

### Conséquences

- Le planner peut décider de créer un subtask « setup the project structure » alors que le projet existe déjà
- Il peut décomposer un projet Python en subtasks « frontend developer » et « backend developer » alors que c'est un CLI
- Il ne peut pas exploiter les conventions existantes pour rédiger des prompts de subtask plus précis
- Les prompts de subtask qu'il génère sont génériques au lieu d'être contextualisés (ex: « Create a REST API » au lieu de « Add new routes to the existing Express app in src/routes/ »)

### Impact mesuré

La qualité de décomposition est le **facteur #1** de la qualité d'exécution multi-agent. Un mauvais plan ne peut pas être compensé par de bons agents — chaque agent travaille avec le prompt de subtask qu'il reçoit. Contextualiser le planner a un impact direct et immédiat sur toute la chaîne.

---

## Fichiers impactés

| Fichier | Action |
|---------|--------|
| `src/classes/agent-pool/agent-pool.ts` | Construire le contexte projet et le passer au planner |
| `src/classes/agent-pool/task-planner.ts` | Accepter et transmettre le contexte projet au prompt |
| `src/prompts/planning.ts` | Enrichir le system prompt et le user prompt avec le contexte |
| `src/types/agent-pool.types.ts` | Ajouter le type `ProjectContext` |
| `src/classes/agent-pool/project-scanner.ts` | **Nouveau fichier** — scanner le projet pour extraire le contexte |
| `src/classes/agent-pool/tests/` | Tests unitaires pour le scanner et l'intégration |

---

## Spécification détaillée des changements

### 1. Nouveau type `ProjectContext` dans `agent-pool.types.ts`

```typescript
/**
 * Contexte du projet de travail, extrait par le ProjectScanner.
 *
 * Ce contexte est injecté dans le prompt du planner pour qu'il puisse
 * prendre des décisions de décomposition informées par l'état réel
 * du projet.
 */
export interface ProjectContext {
    /** Le chemin absolu du répertoire de travail. */
    readonly cwd: string;

    /**
     * Arborescence du projet (fichiers et dossiers principaux).
     * Limitée en profondeur et filtrée (sans node_modules, .git, etc.).
     * Format : liste de chemins relatifs, un par ligne.
     * Exemple : ["src/", "src/index.ts", "src/routes/", "package.json"]
     */
    readonly fileTree: string[];

    /**
     * Langages principaux détectés, ordonnés par fréquence.
     * Exemple : ["typescript", "json", "markdown"]
     */
    readonly languages: string[];

    /**
     * Fichiers de configuration détectés avec leur contenu résumé.
     * Clé = nom du fichier, valeur = résumé ou contenu partiel.
     * Exemple : { "package.json": "{ name: my-app, deps: express, jest }" }
     */
    readonly configFiles: Record<string, string>;

    /**
     * Framework(s) ou runtime(s) détectés.
     * Exemple : ["express", "react", "jest"]
     */
    readonly detectedFrameworks: string[];

    /**
     * Résumé textuel compact du projet pour injection dans les prompts LLM.
     * Construit à partir des champs ci-dessus.
     * Limité à ~1000 caractères pour ne pas saturer le prompt.
     */
    readonly summary: string;

    /**
     * Indique si le projet semble vierge (aucun fichier source détecté).
     */
    readonly isEmpty: boolean;
}
```

### 2. Nouveau fichier `src/classes/agent-pool/project-scanner.ts`

Créer une classe utilitaire stateless qui scanne un répertoire et produit un `ProjectContext`.

#### Responsabilités du scanner

1. **Lister l'arborescence** — récursif, limité à 3-4 niveaux de profondeur, filtrant les dossiers ignorés (node_modules, .git, dist, build, coverage, __pycache__, .next, .nuxt, target, vendor, etc.)
2. **Détecter les langages** — par extension de fichier (.ts, .js, .py, .rs, .go, .java, etc.)
3. **Extraire les fichiers de config** — lire et résumer les fichiers clés :
   - `package.json` → name, scripts clés, dependencies (noms seulement, pas les versions)
   - `tsconfig.json` → options principales (strict, target, module)
   - `Cargo.toml` → name, dependencies (noms seulement)
   - `pyproject.toml` / `requirements.txt` → dependencies (noms seulement)
   - `go.mod` → module name, require (noms seulement)
   - `.env.example` / `.env.local` → noms de variables (sans valeurs !)
   - `docker-compose.yml` → noms de services
   - `biome.json` / `.eslintrc*` / `.prettierrc*` → détecté mais contenu non lu
4. **Détecter les frameworks** — à partir des dépendances et des fichiers (ex: présence de `next.config.js` → Next.js, `express` dans package.json → Express)
5. **Construire le résumé** — une description textuelle compacte
6. **Détecter si le projet est vide** — aucun fichier source (seulement des configs ou rien)

#### Structure de la classe

```typescript
import { readdir, readFile, stat } from "node:fs/promises";
import { join, extname, relative } from "node:path";
import type { ProjectContext } from "../../types/agent-pool.types.ts";

// ── Constants ──────────────────────────────────────────────────────────────

/** Dossiers ignorés lors du scan récursif. */
const IGNORED_DIRECTORIES = new Set([
    "node_modules", ".git", "dist", "build", "coverage",
    "__pycache__", ".next", ".nuxt", ".svelte-kit", "target",
    "vendor", ".cache", ".turbo", ".output", "out",
    ".vscode", ".idea", ".DS_Store", "logs",
]);

/** Profondeur maximale de scan de l'arborescence. */
const MAX_SCAN_DEPTH = 4;

/** Nombre maximum de fichiers dans l'arborescence (pour les très gros projets). */
const MAX_FILE_TREE_SIZE = 150;

/** Taille max du résumé en caractères. */
const MAX_SUMMARY_LENGTH = 1500;

/** Mapping extension → langage. */
const EXTENSION_TO_LANGUAGE: ReadonlyMap<string, string> = new Map([
    [".ts", "typescript"], [".tsx", "typescript"],
    [".js", "javascript"], [".jsx", "javascript"],
    [".py", "python"],
    [".rs", "rust"],
    [".go", "go"],
    [".java", "java"],
    [".kt", "kotlin"],
    [".rb", "ruby"],
    [".php", "php"],
    [".cs", "csharp"],
    [".cpp", "cpp"], [".cc", "cpp"], [".h", "cpp"], [".hpp", "cpp"],
    [".c", "c"],
    [".swift", "swift"],
    [".vue", "vue"],
    [".svelte", "svelte"],
    [".html", "html"],
    [".css", "css"], [".scss", "scss"], [".less", "less"],
    [".json", "json"],
    [".yaml", "yaml"], [".yml", "yaml"],
    [".md", "markdown"],
    [".sql", "sql"],
    [".sh", "shell"], [".bash", "shell"],
    [".toml", "toml"],
]);

/**
 * Config files to read and summarize.
 * Key = filename, value = summarizer function or max chars to read.
 */
const CONFIG_FILES_TO_READ: ReadonlyMap<string, number> = new Map([
    ["package.json", 2000],
    ["tsconfig.json", 1000],
    ["Cargo.toml", 1500],
    ["pyproject.toml", 1500],
    ["requirements.txt", 1000],
    ["go.mod", 1000],
    ["docker-compose.yml", 1500],
    ["Makefile", 500],
    ["Dockerfile", 500],
]);

/** Frameworks detected from dependency names. */
const FRAMEWORK_INDICATORS: ReadonlyMap<string, string> = new Map([
    ["express", "Express.js"],
    ["fastify", "Fastify"],
    ["koa", "Koa"],
    ["hono", "Hono"],
    ["next", "Next.js"],
    ["nuxt", "Nuxt"],
    ["react", "React"],
    ["vue", "Vue.js"],
    ["svelte", "Svelte"],
    ["angular", "Angular"],
    ["solid-js", "SolidJS"],
    ["jest", "Jest"],
    ["vitest", "Vitest"],
    ["mocha", "Mocha"],
    ["pytest", "pytest"],
    ["django", "Django"],
    ["flask", "Flask"],
    ["fastapi", "FastAPI"],
    ["actix-web", "Actix Web"],
    ["axum", "Axum"],
    ["gin", "Gin"],
    ["tailwindcss", "Tailwind CSS"],
    ["prisma", "Prisma"],
    ["drizzle-orm", "Drizzle ORM"],
    ["typeorm", "TypeORM"],
    ["sequelize", "Sequelize"],
    ["mongoose", "Mongoose"],
]);

// ── ProjectScanner ─────────────────────────────────────────────────────────

/**
 * Scans a project directory and extracts a structured ProjectContext
 * suitable for injection into LLM planning prompts.
 *
 * The scanner is intentionally fast and lightweight:
 * - No file contents are read except config files
 * - Directory traversal is depth-limited
 * - Large projects are truncated gracefully
 * - Sensitive data (.env values, secrets) is never included
 *
 * This is a stateless utility — instantiate, call scan(), discard.
 */
export class ProjectScanner {

    /**
     * Scans the given directory and returns a ProjectContext.
     *
     * @param cwd - The root directory to scan.
     * @returns A structured project context.
     */
    async scan(cwd: string): Promise<ProjectContext> {
        // 1. Scan file tree
        // 2. Detect languages from extensions
        // 3. Read and summarize config files
        // 4. Detect frameworks from dependencies
        // 5. Build summary string
        // 6. Determine if project is empty
    }

    // ... private methods for each step
}
```

#### Détail des méthodes internes

##### `scanFileTree(cwd: string, depth: number): Promise<string[]>`

Parcours récursif limité en profondeur. Retourne des chemins relatifs triés. Les dossiers se terminent par `/`. Respecte `MAX_FILE_TREE_SIZE` — si dépassé, tronquer et ajouter `"... (N more files)"`.

##### `detectLanguages(fileTree: string[]): string[]`

Compte les extensions, trie par fréquence descendante. Retourne les noms de langages (pas les extensions). Ignore `json`, `yaml`, `markdown` pour le classement principal sauf s'ils sont les seuls.

##### `readConfigFiles(cwd: string, fileTree: string[]): Promise<Record<string, string>>`

Pour chaque fichier de config trouvé dans l'arborescence :
- Lire le contenu (limité en taille via `CONFIG_FILES_TO_READ`)
- **Pour `package.json`** : parser le JSON et produire un résumé structuré :
  ```
  Name: my-app
  Scripts: dev, build, test, lint
  Dependencies: express, cors, helmet
  DevDependencies: typescript, jest, @types/node
  ```
  Ne PAS inclure les versions. Ne PAS inclure le lockfile.
- **Pour les autres** : tronquer à la taille max configurée
- **SÉCURITÉ** : ne jamais lire `.env`, `.env.local`, `.env.production` etc. Seulement `.env.example` pour les noms de variables (pas les valeurs).

##### `detectFrameworks(configFiles: Record<string, string>, fileTree: string[]): string[]`

Détecter les frameworks à partir de :
1. Les noms de dépendances dans le résumé de `package.json`, `Cargo.toml`, etc. (via `FRAMEWORK_INDICATORS`)
2. Les fichiers spéciaux dans l'arborescence :
   - `next.config.*` → Next.js
   - `nuxt.config.*` → Nuxt
   - `vite.config.*` → Vite
   - `svelte.config.*` → Svelte
   - `angular.json` → Angular
   - `manage.py` → Django
   - `app.py` ou `main.py` avec `flask` ou `fastapi` dans les deps → Flask / FastAPI

##### `buildSummary(context: Omit<ProjectContext, "summary">): string`

Construire un résumé textuel compact :

```
Project: my-app (TypeScript)
Frameworks: Express.js, Jest
Structure: src/ with routes/, models/, utils/
Config: tsconfig (strict), biome, docker-compose
Dependencies: express, cors, helmet, prisma
Status: Existing project with 45 source files
```

Limité à `MAX_SUMMARY_LENGTH` caractères. Si le projet est vide :

```
Project: Empty directory
Status: No source files detected — this is a new project
```

##### `isEmpty(fileTree: string[], languages: string[]): boolean`

Retourne `true` si :
- Aucun fichier source détecté (languages vide ou seulement json/yaml/markdown)
- OU l'arborescence ne contient que des fichiers de config/meta

---

### 3. Modifier `TaskPlanner` pour accepter le contexte projet

#### Modifier la méthode `analyze()`

Ajouter un paramètre optionnel `projectContext` :

```typescript
async analyze(
    task: string,
    contextHints?: string,
    constraints?: string[],
    projectContext?: ProjectContext,  // ← NOUVEAU
): Promise<TaskAnalysis> {
    // ...

    const prompt = taskAnalysisPrompt({
        task: sanitizedTask,
        contextHints: contextHints ?? null,
        constraints: constraints ?? null,
        projectContext: projectContext ?? null,  // ← NOUVEAU
    });

    // ... reste inchangé
}
```

### 4. Enrichir les prompts dans `planning.ts`

#### System prompt : ajouter une section sur l'utilisation du contexte

Ajouter dans le system prompt, après la section `## Rules` :

```handlebars
## Project Context Usage
When project context is provided:
1. Use the existing file structure to inform your decomposition — do NOT create subtasks for work that's already done.
2. Reference specific existing files/directories in subtask prompts so agents know where to work.
3. Match the project's language, framework, and conventions in subtask descriptions.
4. If the project is empty, include setup instructions in the first subtask.
5. If the project uses specific tools (e.g., biome for linting, jest for tests), mention them in relevant subtasks.
6. Each subtask prompt should reference the project context so the agent knows what exists.
```

#### User prompt : injecter le contexte projet

Ajouter dans le template `TASK_ANALYSIS_SOURCE`, après le block `{{#if constraints}}` :

```handlebars
{{#if projectContext}}
## Project Context
{{#if projectContext.isEmpty}}
This is a NEW/EMPTY project — no existing source files.
Working directory: {{projectContext.cwd}}
{{else}}
**Working directory**: {{projectContext.cwd}}
**Languages**: {{#each projectContext.languages}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}
{{#if projectContext.detectedFrameworks.length}}
**Frameworks**: {{#each projectContext.detectedFrameworks}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}
{{/if}}

### File Structure
```
{{#each projectContext.fileTree}}
{{this}}
{{/each}}
```

{{#each projectContext.configFiles}}
### {{@key}}
{{this}}

{{/each}}
{{/if}}
{{/if}}
```

### 5. Appeler le scanner depuis `AgentPool.execute()`

Dans `agent-pool.ts`, avant l'appel au planner :

```typescript
// ── Phase 1: Planning ────────────────────────────────────────
this.emitPoolEvent(PoolEvent.PLANNING_START, { task });
this.logger.info({ taskLength: task.length }, "Phase 1: Planning");

// Scan the project context if a working directory is configured
let projectContext: ProjectContext | undefined;
if (this.config.cwd) {
    try {
        const scanner = new ProjectScanner();
        projectContext = await scanner.scan(this.config.cwd);
        this.logger.info(
            {
                languages: projectContext.languages,
                frameworks: projectContext.detectedFrameworks,
                fileCount: projectContext.fileTree.length,
                isEmpty: projectContext.isEmpty,
            },
            `Project scanned: ${projectContext.languages.join(", ")} — ${projectContext.fileTree.length} files`,
        );
    } catch (error) {
        this.logger.warn(
            { error: toErrorMessage(error) },
            "Project scanning failed — planning without project context",
        );
    }
}

const analysis = await this.planner.analyze(
    task,
    undefined,     // contextHints
    undefined,     // constraints
    projectContext, // ← NOUVEAU
);
```

### 6. Importer le ProjectScanner dans `agent-pool.ts`

Ajouter l'import :

```typescript
import { ProjectScanner } from "./project-scanner.ts";
```

Et l'import du type dans les fichiers concernés :

```typescript
import type { ProjectContext } from "../../types/agent-pool.types.ts";
```

---

## Gestion de la taille du prompt

Le contexte projet peut être volumineux. Mesures de protection :

1. **`MAX_FILE_TREE_SIZE = 150`** — même un gros projet ne génère pas plus de 150 lignes d'arborescence
2. **`MAX_SUMMARY_LENGTH = 1500`** — le résumé est capé
3. **Config files sont résumés** — `package.json` est parsé et condensé (noms seulement, pas de versions), pas copié brut
4. **Profondeur limitée à 4** — on ne descend pas dans les sous-sous-sous-dossiers
5. **Les fichiers source ne sont jamais lus** — seuls les fichiers de config sont lus, le reste est déduit des noms/extensions

Estimation de la taille ajoutée au prompt : **500-2000 tokens** selon la taille du projet. C'est acceptable par rapport au budget du planner qui fait un seul appel par exécution.

---

## Sécurité

1. **Ne JAMAIS lire `.env`** ou tout fichier susceptible de contenir des secrets. Seul `.env.example` est lu pour les noms de variables.
2. **Ne JAMAIS inclure les valeurs de configuration** — seulement les clés, les noms de dépendances, les noms de scripts.
3. **Le contenu des fichiers source n'est jamais lu** — le scanner ne lit que les fichiers de config listés explicitement dans `CONFIG_FILES_TO_READ`.
4. **Les chemins sont relatifs** au `cwd` — pas de fuite de chemin absolu dans les prompts LLM (sauf le `cwd` lui-même qui est nécessaire pour le contexte).

---

## Tests à implémenter

### Tests unitaires pour `ProjectScanner`

#### Test 1 : Scan d'un projet TypeScript/Express typique

- Setup : créer un dossier temporaire avec la structure :
  ```
  src/index.ts
  src/routes/users.ts
  src/routes/products.ts
  src/models/user.ts
  tests/users.test.ts
  package.json (contenant express, jest comme deps)
  tsconfig.json
  ```
- Assert : `languages` contient `"typescript"` en premier
- Assert : `detectedFrameworks` contient `"Express.js"` et `"Jest"`
- Assert : `fileTree` contient tous les fichiers/dossiers (avec `/` pour les dossiers)
- Assert : `configFiles["package.json"]` contient `"express"` mais pas de versions
- Assert : `isEmpty` est `false`
- Assert : `summary` contient le nom du projet et les frameworks

#### Test 2 : Scan d'un projet vide

- Setup : créer un dossier temporaire vide (ou avec seulement un `.gitkeep`)
- Assert : `isEmpty` est `true`
- Assert : `languages` est vide
- Assert : `summary` contient « empty » ou « new project »

#### Test 3 : Les dossiers ignorés sont exclus

- Setup : créer un dossier avec `node_modules/express/index.js`, `src/app.ts`, `.git/config`
- Assert : `fileTree` contient `src/app.ts` mais PAS `node_modules/` ni `.git/`

#### Test 4 : Profondeur maximale respectée

- Setup : créer une arborescence profonde (6+ niveaux)
- Assert : `fileTree` ne contient pas de fichiers au-delà de `MAX_SCAN_DEPTH`

#### Test 5 : Taille maximale du fileTree respectée

- Setup : créer un projet avec 200+ fichiers source
- Assert : `fileTree.length` ≤ `MAX_FILE_TREE_SIZE`
- Assert : le dernier élément est un indicateur de troncation (ex: `"... (50 more files)"`)

#### Test 6 : Les fichiers .env ne sont jamais lus

- Setup : créer un `.env` avec `SECRET_KEY=abc123` et un `.env.example` avec `SECRET_KEY=`
- Assert : `configFiles` ne contient PAS `.env`
- Assert : si `.env.example` est lu, il ne contient pas la valeur `abc123`

#### Test 7 : Détection des frameworks par fichiers spéciaux

- Setup : créer `next.config.js` et `vite.config.ts` dans le projet
- Assert : `detectedFrameworks` contient `"Next.js"` et `"Vite"`

#### Test 8 : Le résumé respecte MAX_SUMMARY_LENGTH

- Setup : créer un très gros projet avec beaucoup de fichiers et de configs
- Assert : `summary.length` ≤ `MAX_SUMMARY_LENGTH`

#### Test 9 : Les résumés de package.json excluent les versions

- Setup : `package.json` avec `"express": "^4.18.2"` dans les deps
- Assert : le résumé contient `"express"` mais PAS `"4.18.2"` ni `"^4.18.2"`

#### Test 10 : Projet Rust (Cargo.toml)

- Setup : créer un projet avec `Cargo.toml`, `src/main.rs`, `src/lib.rs`
- Assert : `languages` contient `"rust"`
- Assert : `configFiles` contient `"Cargo.toml"`
- Assert : le résumé mentionne Rust

#### Test 11 : Projet Python (pyproject.toml)

- Setup : créer un projet avec `pyproject.toml`, `src/main.py`, `tests/test_main.py`
- Assert : `languages` contient `"python"`
- Assert : `configFiles` contient `"pyproject.toml"`

### Tests d'intégration

#### Test 12 : Le planner reçoit le contexte projet dans le prompt

- Mocker `ConversationManager.sendJson()` pour capturer le prompt envoyé
- Appeler `planner.analyze("Build an API", undefined, undefined, mockProjectContext)`
- Assert : le prompt contient la section `## Project Context`
- Assert : le prompt contient les langages, frameworks, et file tree du contexte

#### Test 13 : Le planner fonctionne sans contexte projet (backward compatibility)

- Appeler `planner.analyze("Build an API")` sans `projectContext`
- Assert : aucune erreur
- Assert : le prompt ne contient PAS de section `## Project Context`

#### Test 14 : `AgentPool.execute()` scanne le projet avant le planning

- Mocker le `ProjectScanner` et le `TaskPlanner`
- Appeler `pool.execute("Build an API")`
- Assert : `scanner.scan()` est appelé avec `this.config.cwd`
- Assert : `planner.analyze()` reçoit le `ProjectContext` retourné par le scanner

#### Test 15 : L'échec du scan ne bloque pas l'exécution

- Mocker `ProjectScanner.scan()` pour throw une erreur (ex: permission denied)
- Appeler `pool.execute("Build an API")`
- Assert : l'exécution continue normalement
- Assert : `planner.analyze()` est appelé avec `projectContext` = `undefined`
- Assert : un warning est loggé

---

## Critères de validation

- [ ] Le `ProjectScanner` existe et scanne correctement des projets TypeScript, Rust, Python, Go
- [ ] Le `ProjectContext` est injecté dans le prompt du planner quand un `cwd` est configuré
- [ ] Le planner system prompt contient des instructions sur l'utilisation du contexte projet
- [ ] Le résumé de `package.json` ne contient ni versions ni informations sensibles
- [ ] Les fichiers `.env` ne sont jamais lus (seulement `.env.example` et uniquement les noms de variables)
- [ ] L'arborescence est limitée en profondeur (`MAX_SCAN_DEPTH`) et en taille (`MAX_FILE_TREE_SIZE`)
- [ ] Le résumé est limité à `MAX_SUMMARY_LENGTH` caractères
- [ ] L'échec du scanner est gracieux — l'exécution continue sans contexte
- [ ] Le planner fonctionne toujours normalement sans contexte projet (backward compatibility)
- [ ] Les dossiers ignorés (`node_modules`, `.git`, etc.) n'apparaissent jamais dans le scan
- [ ] Tous les tests existants passent toujours
- [ ] Les nouveaux tests couvrent les langages majeurs et les edge cases

---

## Points d'attention

1. **Performance** : le scan doit être rapide (< 500ms même sur de gros projets). Utiliser `readdir` avec `withFileTypes: true` pour éviter des `stat()` supplémentaires. Ne pas lire le contenu des fichiers source — seulement les fichiers de config listés dans `CONFIG_FILES_TO_READ`.
2. **Erreurs filesystem** : le scanner doit être résilient aux erreurs de permission, liens symboliques cassés, et fichiers spéciaux. Wraper chaque opération fs dans un try/catch et ignorer les erreurs silencieusement.
3. **Ne pas scanner si pas de `cwd`** : si `this.config.cwd` n'est pas défini, ne pas instancier le scanner du tout. Le `ProjectContext` est optionnel à tous les niveaux.
4. **Idempotence** : le scanner est stateless et le scan peut être relancé à tout moment. Le résultat dépend uniquement de l'état du filesystem au moment du scan.
5. **Le prompt peut devenir long** pour les gros projets — c'est géré par les limites (`MAX_FILE_TREE_SIZE`, `MAX_SUMMARY_LENGTH`, taille des configs lues). Si dans le futur ça pose problème de tokens, on pourra réduire ces limites ou ajouter un résumé LLM-generated du contexte projet.
6. **Encodage** : lire les fichiers de config avec `encoding: "utf-8"`. Ignorer les fichiers binaires. Si un fichier de config ne peut pas être lu comme UTF-8, le skip silencieusement.
7. **Liens symboliques** : les suivre pour les fichiers mais PAS pour les dossiers (risque de boucle infinie). Utiliser `{ withFileTypes: true }` et vérifier `dirent.isDirectory()` vs `dirent.isSymbolicLink()`.
8. **Le `cwd` dans le `ProjectContext`** est le chemin absolu tel que fourni par la config. Il est utile pour le planner dans le prompt mais ne doit pas fuiter vers des systèmes externes. Les agents reçoivent déjà leur `cwd` via leur config propre.