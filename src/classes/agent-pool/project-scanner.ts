import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import type { ProjectContext } from "../../types/agent-pool.types.ts";

// ── Constants ──────────────────────────────────────────────────────────────

/** Dossiers ignorés lors du scan récursif. */
const IGNORED_DIRECTORIES = new Set([
	"node_modules",
	".git",
	"dist",
	"build",
	"coverage",
	"__pycache__",
	".next",
	".nuxt",
	".svelte-kit",
	"target",
	"vendor",
	".cache",
	".turbo",
	".output",
	"out",
	".vscode",
	".idea",
	".DS_Store",
	"logs",
]);

/** Profondeur maximale de scan de l'arborescence. */
const MAX_SCAN_DEPTH = 4;

/** Nombre maximum de fichiers dans l'arborescence (pour les très gros projets). */
const MAX_FILE_TREE_SIZE = 150;

/** Taille max du résumé en caractères. */
const MAX_SUMMARY_LENGTH = 1500;

/** Mapping extension → langage. */
const EXTENSION_TO_LANGUAGE: ReadonlyMap<string, string> = new Map([
	[".ts", "typescript"],
	[".tsx", "typescript"],
	[".js", "javascript"],
	[".jsx", "javascript"],
	[".py", "python"],
	[".rs", "rust"],
	[".go", "go"],
	[".java", "java"],
	[".kt", "kotlin"],
	[".rb", "ruby"],
	[".php", "php"],
	[".cs", "csharp"],
	[".cpp", "cpp"],
	[".cc", "cpp"],
	[".h", "cpp"],
	[".hpp", "cpp"],
	[".c", "c"],
	[".swift", "swift"],
	[".vue", "vue"],
	[".svelte", "svelte"],
	[".html", "html"],
	[".css", "css"],
	[".scss", "scss"],
	[".less", "less"],
	[".json", "json"],
	[".yaml", "yaml"],
	[".yml", "yaml"],
	[".md", "markdown"],
	[".sql", "sql"],
	[".sh", "shell"],
	[".bash", "shell"],
	[".toml", "toml"],
]);

/**
 * Config files to read and summarize.
 * Key = filename, value = max chars to read.
 */
const CONFIG_FILES_TO_READ: ReadonlyMap<string, number> = new Map([
	["package.json", 2000],
	["tsconfig.json", 1000],
	["Cargo.toml", 1500],
	["pyproject.toml", 1500],
	["requirements.txt", 1000],
	["go.mod", 1000],
	["docker-compose.yml", 1500],
	["docker-compose.yaml", 1500],
	["Makefile", 500],
	["Dockerfile", 500],
]);

/**
 * Config files that are detected but whose content is NOT read.
 * Their mere presence is noted in configFiles with a placeholder.
 */
const CONFIG_FILES_DETECT_ONLY = new Set([
	"biome.json",
	"biome.jsonc",
	".eslintrc",
	".eslintrc.js",
	".eslintrc.cjs",
	".eslintrc.json",
	".eslintrc.yml",
	".eslintrc.yaml",
	"eslint.config.js",
	"eslint.config.mjs",
	"eslint.config.cjs",
	".prettierrc",
	".prettierrc.js",
	".prettierrc.cjs",
	".prettierrc.json",
	".prettierrc.yml",
	".prettierrc.yaml",
	"prettier.config.js",
	"prettier.config.cjs",
]);

/**
 * .env files whose variable NAMES (not values) may be read.
 */
const ENV_EXAMPLE_FILES = new Set([".env.example", ".env.sample"]);

/**
 * .env files that must NEVER be read.
 */
const ENV_SECRET_FILES = new Set([
	".env",
	".env.local",
	".env.production",
	".env.staging",
	".env.development",
	".env.test",
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

/** Framework detection from special files in the project root. */
const FILE_FRAMEWORK_INDICATORS: ReadonlyMap<string, string> = new Map([
	["next.config.js", "Next.js"],
	["next.config.mjs", "Next.js"],
	["next.config.ts", "Next.js"],
	["nuxt.config.js", "Nuxt"],
	["nuxt.config.ts", "Nuxt"],
	["vite.config.js", "Vite"],
	["vite.config.ts", "Vite"],
	["vite.config.mjs", "Vite"],
	["svelte.config.js", "Svelte"],
	["svelte.config.ts", "Svelte"],
	["angular.json", "Angular"],
	["manage.py", "Django"],
]);

/**
 * Languages considered "meta" — not counted as source languages
 * unless they are the only languages present.
 */
const META_LANGUAGES = new Set(["json", "yaml", "markdown", "toml"]);

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
		const fileTree = await this.scanFileTree(cwd, 0);

		// 2. Detect languages from extensions
		const languages = this.detectLanguages(fileTree);

		// 3. Read and summarize config files
		const configFiles = await this.readConfigFiles(cwd, fileTree);

		// 4. Detect frameworks from dependencies and special files
		const detectedFrameworks = this.detectFrameworks(configFiles, fileTree);

		// 5. Determine if the project is empty
		const isEmpty = this.isEmpty(fileTree, languages);

		// 6. Build the summary string
		const summary = this.buildSummary({
			cwd,
			fileTree,
			languages,
			configFiles,
			detectedFrameworks,
			isEmpty,
		});

		return {
			cwd,
			fileTree,
			languages,
			configFiles,
			detectedFrameworks,
			summary,
			isEmpty,
		};
	}

	// ── Private Methods ────────────────────────────────────────────────

	/**
	 * Recursively scans the file tree, respecting depth limits and
	 * ignoring directories in IGNORED_DIRECTORIES.
	 *
	 * Returns relative paths sorted alphabetically.
	 * Directories end with `/`.
	 */
	private async scanFileTree(
		dir: string,
		depth: number,
		rootDir?: string,
	): Promise<string[]> {
		const root = rootDir ?? dir;

		if (depth > MAX_SCAN_DEPTH) return [];

		let entries: Dirent[];
		try {
			entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
		} catch {
			// Permission denied, broken symlink, etc.
			return [];
		}

		const results: string[] = [];
		let totalCollected = 0;

		// Sort entries for deterministic output
		entries.sort((a, b) => a.name.localeCompare(b.name));

		for (const entry of entries) {
			if (totalCollected >= MAX_FILE_TREE_SIZE) break;

			const name = entry.name;

			// Skip ignored directories
			if (IGNORED_DIRECTORIES.has(name)) continue;

			// Skip hidden files/dirs (except specific config files)
			if (
				name.startsWith(".") &&
				!CONFIG_FILES_DETECT_ONLY.has(name) &&
				!ENV_EXAMPLE_FILES.has(name) &&
				!ENV_SECRET_FILES.has(name) &&
				name !== ".env.example" &&
				name !== ".env.sample"
			) {
				// Allow dotfiles that are config-detect-only or env examples
				// but skip all other hidden entries
				if (!entry.isFile()) continue;
				// For hidden files, still skip unless they are known config files
				if (
					!CONFIG_FILES_TO_READ.has(name) &&
					!CONFIG_FILES_DETECT_ONLY.has(name)
				) {
					continue;
				}
			}

			const fullPath = join(dir, name);
			const relativePath = relative(root, fullPath);

			if (entry.isDirectory() && !entry.isSymbolicLink()) {
				results.push(`${relativePath}/`);
				totalCollected++;

				// Recurse into subdirectory
				const subEntries = await this.scanFileTree(fullPath, depth + 1, root);
				for (const sub of subEntries) {
					if (totalCollected >= MAX_FILE_TREE_SIZE) break;
					results.push(sub);
					totalCollected++;
				}
			} else if (entry.isFile() || entry.isSymbolicLink()) {
				results.push(relativePath);
				totalCollected++;
			}
		}

		// If at root level and we hit the limit, count remaining
		if (depth === 0 && totalCollected >= MAX_FILE_TREE_SIZE) {
			const fullCount = await this.countFiles(dir, 0, root);
			const remaining = fullCount - MAX_FILE_TREE_SIZE;
			if (remaining > 0) {
				results.push(`... (${remaining} more files)`);
			}
		}

		return results;
	}

	/**
	 * Counts total files in a directory (used for the truncation indicator).
	 */
	private async countFiles(
		dir: string,
		depth: number,
		rootDir: string,
	): Promise<number> {
		if (depth > MAX_SCAN_DEPTH) return 0;

		let entries: Dirent[];
		try {
			entries = (await readdir(dir, { withFileTypes: true })) as Dirent[];
		} catch {
			return 0;
		}

		let count = 0;

		for (const entry of entries) {
			if (IGNORED_DIRECTORIES.has(entry.name)) continue;
			if (
				entry.name.startsWith(".") &&
				!CONFIG_FILES_DETECT_ONLY.has(entry.name) &&
				!ENV_EXAMPLE_FILES.has(entry.name)
			) {
				if (!entry.isFile()) continue;
				if (
					!CONFIG_FILES_TO_READ.has(entry.name) &&
					!CONFIG_FILES_DETECT_ONLY.has(entry.name)
				) {
					continue;
				}
			}

			if (entry.isDirectory() && !entry.isSymbolicLink()) {
				count++; // count the directory itself
				count += await this.countFiles(
					join(dir, entry.name),
					depth + 1,
					rootDir,
				);
			} else if (entry.isFile() || entry.isSymbolicLink()) {
				count++;
			}
		}

		return count;
	}

	/**
	 * Detects programming languages from file extensions in the tree.
	 *
	 * Returns language names sorted by frequency (descending).
	 * Meta languages (json, yaml, markdown) are placed at the end
	 * unless they are the only languages present.
	 */
	private detectLanguages(fileTree: string[]): string[] {
		const counts = new Map<string, number>();

		for (const path of fileTree) {
			// Skip directories and truncation indicators
			if (path.endsWith("/") || path.startsWith("...")) continue;

			const ext = extname(path).toLowerCase();
			const lang = EXTENSION_TO_LANGUAGE.get(ext);
			if (lang) {
				counts.set(lang, (counts.get(lang) ?? 0) + 1);
			}
		}

		// Separate source languages from meta languages
		const sourceLangs: [string, number][] = [];
		const metaLangs: [string, number][] = [];

		for (const [lang, count] of counts) {
			if (META_LANGUAGES.has(lang)) {
				metaLangs.push([lang, count]);
			} else {
				sourceLangs.push([lang, count]);
			}
		}

		// Sort each group by count (descending)
		sourceLangs.sort((a, b) => b[1] - a[1]);
		metaLangs.sort((a, b) => b[1] - a[1]);

		// If no source languages, return meta languages
		if (sourceLangs.length === 0) {
			return metaLangs.map(([lang]) => lang);
		}

		// Source languages first, then meta
		return [
			...sourceLangs.map(([lang]) => lang),
			...metaLangs.map(([lang]) => lang),
		];
	}

	/**
	 * Reads and summarizes configuration files found in the project.
	 *
	 * - package.json is parsed and condensed (names only, no versions)
	 * - Other config files are truncated to their max size
	 * - .env files are NEVER read (only .env.example for variable names)
	 * - Detect-only config files get a placeholder entry
	 */
	private async readConfigFiles(
		cwd: string,
		fileTree: string[],
	): Promise<Record<string, string>> {
		const result: Record<string, string> = {};

		// Collect root-level filenames from the tree
		const rootFiles = new Set<string>();
		for (const path of fileTree) {
			if (path.startsWith("...")) continue;
			// Root-level files have no directory separator
			if (!path.includes("/")) {
				rootFiles.add(path);
			}
		}

		// Read config files that should be summarized
		for (const [filename, maxChars] of CONFIG_FILES_TO_READ) {
			if (!rootFiles.has(filename)) continue;

			try {
				const content = await readFile(join(cwd, filename), {
					encoding: "utf-8",
				});
				const truncated = content.slice(0, maxChars);

				if (filename === "package.json") {
					result[filename] = this.summarizePackageJson(truncated);
				} else {
					result[filename] = truncated;
				}
			} catch {
				// File can't be read — skip silently
			}
		}

		// Detect-only config files
		for (const filename of CONFIG_FILES_DETECT_ONLY) {
			if (rootFiles.has(filename)) {
				result[filename] = "(detected)";
			}
		}

		// .env.example — read variable names only
		for (const filename of ENV_EXAMPLE_FILES) {
			if (!rootFiles.has(filename)) continue;

			try {
				const content = await readFile(join(cwd, filename), {
					encoding: "utf-8",
				});
				result[filename] = this.extractEnvVariableNames(content);
			} catch {
				// Skip silently
			}
		}

		return result;
	}

	/**
	 * Summarizes a package.json into a compact format:
	 * - Name
	 * - Script names (not content)
	 * - Dependency names (not versions)
	 * - DevDependency names (not versions)
	 */
	private summarizePackageJson(content: string): string {
		try {
			const pkg = JSON.parse(content);
			const lines: string[] = [];

			if (pkg.name) {
				lines.push(`Name: ${pkg.name}`);
			}

			if (pkg.scripts && typeof pkg.scripts === "object") {
				const scriptNames = Object.keys(pkg.scripts);
				if (scriptNames.length > 0) {
					lines.push(`Scripts: ${scriptNames.join(", ")}`);
				}
			}

			if (pkg.dependencies && typeof pkg.dependencies === "object") {
				const depNames = Object.keys(pkg.dependencies);
				if (depNames.length > 0) {
					lines.push(`Dependencies: ${depNames.join(", ")}`);
				}
			}

			if (pkg.devDependencies && typeof pkg.devDependencies === "object") {
				const devDepNames = Object.keys(pkg.devDependencies);
				if (devDepNames.length > 0) {
					lines.push(`DevDependencies: ${devDepNames.join(", ")}`);
				}
			}

			if (pkg.peerDependencies && typeof pkg.peerDependencies === "object") {
				const peerDepNames = Object.keys(pkg.peerDependencies);
				if (peerDepNames.length > 0) {
					lines.push(`PeerDependencies: ${peerDepNames.join(", ")}`);
				}
			}

			return lines.join("\n");
		} catch {
			// If JSON is malformed, return truncated raw content
			return content.slice(0, 500);
		}
	}

	/**
	 * Extracts variable names from a .env.example file.
	 * Returns only the KEY names, never the values.
	 */
	private extractEnvVariableNames(content: string): string {
		const names: string[] = [];

		for (const line of content.split("\n")) {
			const trimmed = line.trim();
			// Skip empty lines and comments
			if (!trimmed || trimmed.startsWith("#")) continue;

			const eqIndex = trimmed.indexOf("=");
			if (eqIndex > 0) {
				const key = trimmed.slice(0, eqIndex).trim();
				if (key.length > 0) {
					names.push(key);
				}
			}
		}

		if (names.length === 0) return "(no variables)";
		return `Variables: ${names.join(", ")}`;
	}

	/**
	 * Detects frameworks from dependency names and special files.
	 *
	 * Sources:
	 * 1. Dependency names in package.json / Cargo.toml / etc.
	 * 2. Special config files (next.config.js, vite.config.ts, etc.)
	 */
	private detectFrameworks(
		configFiles: Record<string, string>,
		fileTree: string[],
	): string[] {
		const frameworks = new Set<string>();

		// 1. Detect from dependency names in config file summaries
		const allConfigText = Object.values(configFiles).join("\n");

		for (const [depName, frameworkName] of FRAMEWORK_INDICATORS) {
			// Check if the dependency name appears as a word boundary in the config text.
			// We look for it in Dependencies/DevDependencies lines or general config.
			// Use a simple check: the dep name appears surrounded by non-alphanumeric chars
			// or at the start/end of the text.
			if (this.containsDependency(allConfigText, depName)) {
				frameworks.add(frameworkName);
			}
		}

		// 2. Detect from special files in the file tree
		for (const path of fileTree) {
			if (path.startsWith("...")) continue;

			// Only check root-level files for framework indicators
			const file = basename(path);
			const frameworkName = FILE_FRAMEWORK_INDICATORS.get(file);
			if (frameworkName && !path.includes("/")) {
				frameworks.add(frameworkName);
			}
		}

		return [...frameworks].sort();
	}

	/**
	 * Checks if a dependency name appears in the config text.
	 * Uses word-boundary-like matching to avoid false positives.
	 * Checks ALL occurrences, not just the first, so that names
	 * embedded in project names (e.g., "express" in "my-express-app")
	 * don't prevent detection of the actual dependency entry.
	 */
	private containsDependency(text: string, depName: string): boolean {
		// Acceptable boundary chars: space, comma, colon, quote, newline, start/end, slash, tab
		const boundaryChars = new Set([
			" ",
			",",
			":",
			'"',
			"'",
			"\n",
			"\t",
			"/",
			"[",
			"]",
			"{",
			"}",
		]);

		let startFrom = 0;

		while (startFrom < text.length) {
			const index = text.indexOf(depName, startFrom);
			if (index === -1) return false;

			// Verify it's a word boundary (not a substring of a longer word)
			const charBefore = index > 0 ? (text[index - 1] ?? " ") : " ";
			const charAfter =
				index + depName.length < text.length
					? (text[index + depName.length] ?? " ")
					: " ";

			const beforeOk = boundaryChars.has(charBefore) || index === 0;
			const afterOk =
				boundaryChars.has(charAfter) || index + depName.length === text.length;

			if (beforeOk && afterOk) return true;

			// Move past this occurrence and try the next one
			startFrom = index + depName.length;
		}

		return false;
	}

	/**
	 * Builds a compact textual summary of the project context.
	 * Limited to MAX_SUMMARY_LENGTH characters.
	 */
	private buildSummary(context: Omit<ProjectContext, "summary">): string {
		if (context.isEmpty) {
			return "Project: Empty directory\nStatus: No source files detected — this is a new project";
		}

		const lines: string[] = [];

		// Project name from config if available
		const pkgSummary = context.configFiles["package.json"];
		const cargoSummary = context.configFiles["Cargo.toml"];
		const goMod = context.configFiles["go.mod"];
		const pyproject = context.configFiles["pyproject.toml"];

		let projectName: string | null = null;
		if (pkgSummary) {
			const nameMatch = pkgSummary.match(/^Name:\s*(.+)$/m);
			if (nameMatch?.[1]) projectName = nameMatch[1].trim();
		} else if (cargoSummary) {
			const nameMatch = cargoSummary.match(/^\s*name\s*=\s*"([^"]+)"/m);
			if (nameMatch?.[1]) projectName = nameMatch[1].trim();
		} else if (goMod) {
			const moduleMatch = goMod.match(/^module\s+(.+)$/m);
			if (moduleMatch?.[1]) projectName = moduleMatch[1].trim();
		} else if (pyproject) {
			const nameMatch = pyproject.match(/^\s*name\s*=\s*"([^"]+)"/m);
			if (nameMatch?.[1]) projectName = nameMatch[1].trim();
		}

		// Main language
		const mainLang =
			context.languages.find((l) => !META_LANGUAGES.has(l)) ??
			context.languages[0] ??
			"unknown";

		if (projectName) {
			lines.push(`Project: ${projectName} (${mainLang})`);
		} else {
			lines.push(`Project: ${mainLang} project`);
		}

		// Frameworks
		if (context.detectedFrameworks.length > 0) {
			lines.push(`Frameworks: ${context.detectedFrameworks.join(", ")}`);
		}

		// Structure summary — extract top-level directories
		const topDirs = context.fileTree
			.filter(
				(p) =>
					p.endsWith("/") &&
					!p.slice(0, -1).includes("/") &&
					!p.startsWith("..."),
			)
			.map((p) => p.replace(/\/$/, ""));

		if (topDirs.length > 0) {
			lines.push(`Structure: ${topDirs.join(", ")}`);
		}

		// Config files detected
		const configNames = Object.keys(context.configFiles);
		if (configNames.length > 0) {
			lines.push(`Config: ${configNames.join(", ")}`);
		}

		// Dependencies summary (from package.json)
		if (pkgSummary) {
			const depsMatch = pkgSummary.match(/^Dependencies:\s*(.+)$/m);
			if (depsMatch) {
				const deps = (depsMatch[1] ?? "").trim();
				// Truncate if too long
				if (deps.length > 200) {
					lines.push(`Dependencies: ${deps.slice(0, 200)}...`);
				} else {
					lines.push(`Dependencies: ${deps}`);
				}
			}
		}

		// File count
		const sourceFileCount = context.fileTree.filter(
			(p) => !p.endsWith("/") && !p.startsWith("...") && this.isSourceFile(p),
		).length;

		lines.push(
			`Status: Existing project with ${sourceFileCount} source file${sourceFileCount !== 1 ? "s" : ""}`,
		);

		let summary = lines.join("\n");

		// Enforce max length
		if (summary.length > MAX_SUMMARY_LENGTH) {
			summary = `${summary.slice(0, MAX_SUMMARY_LENGTH - 3)}...`;
		}

		return summary;
	}

	/**
	 * Checks if a file path looks like a source file (not config/meta).
	 */
	private isSourceFile(path: string): boolean {
		const ext = extname(path).toLowerCase();
		const lang = EXTENSION_TO_LANGUAGE.get(ext);
		return lang !== undefined && !META_LANGUAGES.has(lang);
	}

	/**
	 * Determines if the project appears empty (no source files).
	 *
	 * Returns true if:
	 * - No source languages detected (only meta languages or nothing)
	 * - OR the file tree only contains config/meta files
	 */
	private isEmpty(fileTree: string[], languages: string[]): boolean {
		// Check if any non-meta language was detected
		const hasSourceLanguage = languages.some(
			(lang) => !META_LANGUAGES.has(lang),
		);

		if (hasSourceLanguage) return false;

		// Even without detected languages, check if there are any
		// non-directory, non-meta entries in the tree
		const hasSourceFiles = fileTree.some((path) => {
			if (path.endsWith("/") || path.startsWith("...")) return false;
			return this.isSourceFile(path);
		});

		return !hasSourceFiles;
	}
}
