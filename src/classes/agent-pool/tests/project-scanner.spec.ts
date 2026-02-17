import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProjectScanner } from "../project-scanner.ts";

// ════════════════════════════════════════════════════════════════════════════
// ProjectScanner Unit Tests
// ════════════════════════════════════════════════════════════════════════════

describe("ProjectScanner", () => {
	let scanner: ProjectScanner;
	let tempDir: string;

	beforeEach(async () => {
		scanner = new ProjectScanner();
		tempDir = await mkdtemp(join(tmpdir(), "project-scanner-test-"));
	});

	afterEach(async () => {
		try {
			await rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// ── Helpers ────────────────────────────────────────────────────────────

	/** Creates a file with optional content, creating parent directories. */
	async function createFile(relativePath: string, content = ""): Promise<void> {
		const fullPath = join(tempDir, relativePath);
		const dir = fullPath.slice(0, fullPath.lastIndexOf("/"));
		await mkdir(dir, { recursive: true });
		await writeFile(fullPath, content, "utf-8");
	}

	// ════════════════════════════════════════════════════════════════════════
	// Test 1: Scan of a typical TypeScript/Express project
	// ════════════════════════════════════════════════════════════════════════

	describe("TypeScript/Express project", () => {
		beforeEach(async () => {
			await createFile("src/index.ts", 'import express from "express";');
			await createFile("src/routes/users.ts", "export const usersRouter = {};");
			await createFile(
				"src/routes/products.ts",
				"export const productsRouter = {};",
			);
			await createFile("src/models/user.ts", "export interface User {}");
			await createFile(
				"tests/users.test.ts",
				'import { describe } from "bun:test";',
			);
			await createFile(
				"package.json",
				JSON.stringify({
					name: "my-express-app",
					scripts: { dev: "ts-node src/index.ts", build: "tsc", test: "jest" },
					dependencies: {
						express: "^4.18.2",
						cors: "^2.8.5",
						helmet: "^7.1.0",
					},
					devDependencies: {
						typescript: "^5.3.0",
						jest: "^29.7.0",
						"@types/node": "^20.10.0",
						"@types/express": "^4.17.21",
					},
				}),
			);
			await createFile(
				"tsconfig.json",
				JSON.stringify({
					compilerOptions: {
						strict: true,
						target: "ES2022",
						module: "Node16",
					},
				}),
			);
		});

		it("detects typescript as the primary language", async () => {
			const ctx = await scanner.scan(tempDir);
			expect(ctx.languages[0]).toBe("typescript");
		});

		it("detects Express.js and Jest as frameworks", async () => {
			const ctx = await scanner.scan(tempDir);
			expect(ctx.detectedFrameworks).toContain("Express.js");
			expect(ctx.detectedFrameworks).toContain("Jest");
		});

		it("includes all files and directories in the file tree", async () => {
			const ctx = await scanner.scan(tempDir);
			expect(ctx.fileTree).toContain("src/");
			expect(ctx.fileTree).toContain("src/index.ts");
			expect(ctx.fileTree).toContain("src/routes/");
			expect(ctx.fileTree).toContain("src/routes/users.ts");
			expect(ctx.fileTree).toContain("src/routes/products.ts");
			expect(ctx.fileTree).toContain("src/models/");
			expect(ctx.fileTree).toContain("src/models/user.ts");
			expect(ctx.fileTree).toContain("tests/");
			expect(ctx.fileTree).toContain("tests/users.test.ts");
			expect(ctx.fileTree).toContain("package.json");
			expect(ctx.fileTree).toContain("tsconfig.json");
		});

		it("summarizes package.json with dependency names but no versions", async () => {
			const ctx = await scanner.scan(tempDir);
			const pkgSummary = ctx.configFiles["package.json"];
			expect(pkgSummary).toBeDefined();
			expect(pkgSummary).toContain("express");
			expect(pkgSummary).toContain("cors");
			expect(pkgSummary).toContain("helmet");
			expect(pkgSummary).toContain("typescript");
			expect(pkgSummary).toContain("jest");
			// Versions must NOT appear
			expect(pkgSummary).not.toContain("4.18.2");
			expect(pkgSummary).not.toContain("^4.18.2");
			expect(pkgSummary).not.toContain("5.3.0");
			expect(pkgSummary).not.toContain("^29.7.0");
		});

		it("sets isEmpty to false", async () => {
			const ctx = await scanner.scan(tempDir);
			expect(ctx.isEmpty).toBe(false);
		});

		it("summary mentions the project name and frameworks", async () => {
			const ctx = await scanner.scan(tempDir);
			expect(ctx.summary).toContain("my-express-app");
			expect(ctx.summary).toContain("Express.js");
		});

		it("sets cwd to the provided directory", async () => {
			const ctx = await scanner.scan(tempDir);
			expect(ctx.cwd).toBe(tempDir);
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Test 2: Scan of an empty project
	// ════════════════════════════════════════════════════════════════════════

	describe("empty project", () => {
		it("returns isEmpty true for a completely empty directory", async () => {
			const ctx = await scanner.scan(tempDir);
			expect(ctx.isEmpty).toBe(true);
			expect(ctx.languages).toEqual([]);
			expect(ctx.summary.toLowerCase()).toMatch(/empty|new project/);
		});

		it("returns isEmpty true for a directory with only a .gitkeep", async () => {
			await createFile(".gitkeep", "");
			const ctx = await scanner.scan(tempDir);
			expect(ctx.isEmpty).toBe(true);
		});

		it("returns isEmpty true for a directory with only config files", async () => {
			await createFile(
				"package.json",
				JSON.stringify({ name: "empty-project" }),
			);
			const ctx = await scanner.scan(tempDir);
			expect(ctx.isEmpty).toBe(true);
			expect(ctx.languages).not.toContain("typescript");
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Test 3: Ignored directories are excluded
	// ════════════════════════════════════════════════════════════════════════

	describe("ignored directories", () => {
		it("excludes node_modules from the file tree", async () => {
			await createFile("node_modules/express/index.js", "module.exports = {};");
			await createFile("src/app.ts", "console.log('hello');");
			const ctx = await scanner.scan(tempDir);

			expect(ctx.fileTree).toContain("src/app.ts");

			const hasNodeModules = ctx.fileTree.some((p) =>
				p.includes("node_modules"),
			);
			expect(hasNodeModules).toBe(false);
		});

		it("excludes .git from the file tree", async () => {
			await createFile(".git/config", "[core]");
			await createFile(".git/HEAD", "ref: refs/heads/main");
			await createFile("src/app.ts", "console.log('hello');");
			const ctx = await scanner.scan(tempDir);

			const hasGit = ctx.fileTree.some((p) => p.startsWith(".git"));
			expect(hasGit).toBe(false);
		});

		it("excludes dist, build, coverage, __pycache__", async () => {
			await createFile("dist/index.js", "compiled");
			await createFile("build/output.js", "compiled");
			await createFile("coverage/lcov.info", "coverage data");
			await createFile("__pycache__/main.cpython-311.pyc", "bytecode");
			await createFile("src/main.ts", "const x = 1;");
			const ctx = await scanner.scan(tempDir);

			for (const ignored of ["dist", "build", "coverage", "__pycache__"]) {
				const found = ctx.fileTree.some(
					(p) => p.startsWith(`${ignored}/`) || p === `${ignored}/`,
				);
				expect(found).toBe(false);
			}
			expect(ctx.fileTree).toContain("src/main.ts");
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Test 4: Maximum scan depth is respected
	// ════════════════════════════════════════════════════════════════════════

	describe("scan depth limit", () => {
		it("does not include files beyond MAX_SCAN_DEPTH (4)", async () => {
			// Create deeply nested structure: depth 0 through 6
			// depth 0 = root, so files at root are depth 0
			// directories count as depth increments
			await createFile("a/b/c/d/at-depth-4.ts", "// depth 4");
			await createFile("a/b/c/d/e/at-depth-5.ts", "// depth 5");
			await createFile("a/b/c/d/e/f/at-depth-6.ts", "// depth 6");

			const ctx = await scanner.scan(tempDir);

			// Files at depth ≤ 4 should be present
			expect(ctx.fileTree).toContain("a/b/c/d/at-depth-4.ts");

			// Files at depth > 4 should NOT be present
			const hasDepth5 = ctx.fileTree.some((p) => p.includes("at-depth-5.ts"));
			const hasDepth6 = ctx.fileTree.some((p) => p.includes("at-depth-6.ts"));
			expect(hasDepth5).toBe(false);
			expect(hasDepth6).toBe(false);
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Test 5: Maximum file tree size is respected
	// ════════════════════════════════════════════════════════════════════════

	describe("file tree size limit", () => {
		it("truncates fileTree to MAX_FILE_TREE_SIZE and adds indicator", async () => {
			// Create > 150 files in a flat structure
			const fileCount = 200;
			const promises: Promise<void>[] = [];
			for (let i = 0; i < fileCount; i++) {
				promises.push(
					createFile(`src/file-${String(i).padStart(3, "0")}.ts`, `// ${i}`),
				);
			}
			await Promise.all(promises);

			const ctx = await scanner.scan(tempDir);

			// The file tree (excluding the truncation indicator) should be ≤ 150
			const nonIndicatorEntries = ctx.fileTree.filter(
				(p) => !p.startsWith("..."),
			);
			expect(nonIndicatorEntries.length).toBeLessThanOrEqual(150);

			// Should have a truncation indicator
			const indicator = ctx.fileTree.find((p) => p.startsWith("..."));
			expect(indicator).toBeDefined();
			expect(indicator).toMatch(/\.\.\. \(\d+ more files\)/);
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Test 6: .env files are never read
	// ════════════════════════════════════════════════════════════════════════

	describe(".env security", () => {
		it("never reads .env files", async () => {
			await createFile(".env", "SECRET_KEY=abc123\nDB_PASSWORD=supersecret");
			await createFile("src/app.ts", "");
			const ctx = await scanner.scan(tempDir);

			expect(ctx.configFiles[".env"]).toBeUndefined();

			// Make sure the secret doesn't appear anywhere in the context
			const allText = JSON.stringify(ctx);
			expect(allText).not.toContain("abc123");
			expect(allText).not.toContain("supersecret");
		});

		it("never reads .env.local, .env.production, .env.development", async () => {
			await createFile(".env.local", "API_KEY=local-secret");
			await createFile(".env.production", "API_KEY=prod-secret");
			await createFile(".env.development", "API_KEY=dev-secret");
			await createFile("src/app.ts", "");
			const ctx = await scanner.scan(tempDir);

			expect(ctx.configFiles[".env.local"]).toBeUndefined();
			expect(ctx.configFiles[".env.production"]).toBeUndefined();
			expect(ctx.configFiles[".env.development"]).toBeUndefined();
		});

		it("reads .env.example for variable names only, never values", async () => {
			await createFile(
				".env.example",
				"DATABASE_URL=postgres://localhost:5432/mydb\nAPI_KEY=your-key-here\nPORT=3000\n# Comment line\n",
			);
			await createFile("src/app.ts", "");
			const ctx = await scanner.scan(tempDir);

			const envExample = ctx.configFiles[".env.example"];
			expect(envExample).toBeDefined();
			expect(envExample).toContain("DATABASE_URL");
			expect(envExample).toContain("API_KEY");
			expect(envExample).toContain("PORT");
			// Values must NOT appear
			expect(envExample).not.toContain("postgres://localhost:5432/mydb");
			expect(envExample).not.toContain("your-key-here");
			expect(envExample).not.toContain("3000");
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Test 7: Framework detection from special files
	// ════════════════════════════════════════════════════════════════════════

	describe("framework detection from special files", () => {
		it("detects Next.js from next.config.js", async () => {
			await createFile("next.config.js", "module.exports = {};");
			await createFile("src/app.tsx", "export default function App() {}");
			const ctx = await scanner.scan(tempDir);
			expect(ctx.detectedFrameworks).toContain("Next.js");
		});

		it("detects Next.js from next.config.ts", async () => {
			await createFile("next.config.ts", "export default {};");
			await createFile("src/app.tsx", "export default function App() {}");
			const ctx = await scanner.scan(tempDir);
			expect(ctx.detectedFrameworks).toContain("Next.js");
		});

		it("detects Vite from vite.config.ts", async () => {
			await createFile(
				"vite.config.ts",
				'import { defineConfig } from "vite";',
			);
			await createFile("src/main.ts", "");
			const ctx = await scanner.scan(tempDir);
			expect(ctx.detectedFrameworks).toContain("Vite");
		});

		it("detects Nuxt from nuxt.config.ts", async () => {
			await createFile("nuxt.config.ts", "export default defineNuxtConfig({})");
			await createFile("app.vue", "<template></template>");
			const ctx = await scanner.scan(tempDir);
			expect(ctx.detectedFrameworks).toContain("Nuxt");
		});

		it("detects Svelte from svelte.config.js", async () => {
			await createFile("svelte.config.js", "export default {};");
			await createFile("src/App.svelte", "<script></script>");
			const ctx = await scanner.scan(tempDir);
			expect(ctx.detectedFrameworks).toContain("Svelte");
		});

		it("detects Angular from angular.json", async () => {
			await createFile("angular.json", "{}");
			await createFile("src/app.ts", "");
			const ctx = await scanner.scan(tempDir);
			expect(ctx.detectedFrameworks).toContain("Angular");
		});

		it("detects Django from manage.py", async () => {
			await createFile("manage.py", "#!/usr/bin/env python");
			await createFile("app/models.py", "class User: pass");
			const ctx = await scanner.scan(tempDir);
			expect(ctx.detectedFrameworks).toContain("Django");
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Test 8: Summary respects MAX_SUMMARY_LENGTH
	// ════════════════════════════════════════════════════════════════════════

	describe("summary length limit", () => {
		it("keeps summary within MAX_SUMMARY_LENGTH (1500) characters", async () => {
			// Create a complex project with many files and large config
			const largeDeps: Record<string, string> = {};
			for (let i = 0; i < 100; i++) {
				largeDeps[`dependency-with-long-name-${i}`] = `^${i}.0.0`;
			}
			await createFile(
				"package.json",
				JSON.stringify({
					name: "huge-project-with-lots-of-dependencies",
					scripts: {
						dev: "ts-node src/index.ts",
						build: "tsc",
						test: "jest",
						lint: "eslint",
						format: "prettier",
					},
					dependencies: largeDeps,
				}),
			);

			// Create many source files
			const promises: Promise<void>[] = [];
			for (let i = 0; i < 50; i++) {
				promises.push(createFile(`src/module-${i}.ts`, `// module ${i}`));
			}
			await Promise.all(promises);

			const ctx = await scanner.scan(tempDir);
			expect(ctx.summary.length).toBeLessThanOrEqual(1500);
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Test 9: package.json summary excludes versions
	// ════════════════════════════════════════════════════════════════════════

	describe("package.json summarization", () => {
		it("includes dependency names but excludes versions", async () => {
			await createFile(
				"package.json",
				JSON.stringify({
					name: "version-test",
					dependencies: {
						express: "^4.18.2",
						cors: "~2.8.5",
						helmet: "7.1.0",
					},
					devDependencies: {
						typescript: "^5.3.0",
					},
				}),
			);
			await createFile("src/index.ts", "");

			const ctx = await scanner.scan(tempDir);
			const summary = ctx.configFiles["package.json"]!;

			// Names present
			expect(summary).toContain("express");
			expect(summary).toContain("cors");
			expect(summary).toContain("helmet");
			expect(summary).toContain("typescript");

			// Versions absent
			expect(summary).not.toContain("4.18.2");
			expect(summary).not.toContain("^4.18.2");
			expect(summary).not.toContain("~2.8.5");
			expect(summary).not.toContain("7.1.0");
			expect(summary).not.toContain("^5.3.0");
		});

		it("includes script names", async () => {
			await createFile(
				"package.json",
				JSON.stringify({
					name: "scripts-test",
					scripts: {
						dev: "ts-node src/index.ts",
						build: "tsc",
						test: "jest",
						lint: "biome check",
					},
				}),
			);
			await createFile("src/index.ts", "");

			const ctx = await scanner.scan(tempDir);
			const summary = ctx.configFiles["package.json"]!;

			expect(summary).toContain("dev");
			expect(summary).toContain("build");
			expect(summary).toContain("test");
			expect(summary).toContain("lint");
		});

		it("includes the project name", async () => {
			await createFile("package.json", JSON.stringify({ name: "my-cool-app" }));
			await createFile("src/index.ts", "");

			const ctx = await scanner.scan(tempDir);
			const summary = ctx.configFiles["package.json"]!;
			expect(summary).toContain("my-cool-app");
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Test 10: Rust project (Cargo.toml)
	// ════════════════════════════════════════════════════════════════════════

	describe("Rust project", () => {
		beforeEach(async () => {
			await createFile(
				"Cargo.toml",
				[
					"[package]",
					'name = "my-rust-app"',
					'version = "0.1.0"',
					'edition = "2021"',
					"",
					"[dependencies]",
					'actix-web = "4"',
					'serde = { version = "1", features = ["derive"] }',
					'tokio = { version = "1", features = ["full"] }',
				].join("\n"),
			);
			await createFile("src/main.rs", "fn main() {}");
			await createFile("src/lib.rs", "pub mod routes;");
			await createFile("src/routes.rs", "pub fn hello() {}");
		});

		it("detects rust as the primary language", async () => {
			const ctx = await scanner.scan(tempDir);
			expect(ctx.languages).toContain("rust");
			expect(ctx.languages[0]).toBe("rust");
		});

		it("includes Cargo.toml in config files", async () => {
			const ctx = await scanner.scan(tempDir);
			expect(ctx.configFiles["Cargo.toml"]).toBeDefined();
			expect(ctx.configFiles["Cargo.toml"]).toContain("my-rust-app");
		});

		it("summary mentions Rust", async () => {
			const ctx = await scanner.scan(tempDir);
			expect(ctx.summary.toLowerCase()).toContain("rust");
		});

		it("detects Actix Web from Cargo.toml dependencies", async () => {
			const ctx = await scanner.scan(tempDir);
			expect(ctx.detectedFrameworks).toContain("Actix Web");
		});

		it("sets isEmpty to false", async () => {
			const ctx = await scanner.scan(tempDir);
			expect(ctx.isEmpty).toBe(false);
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Test 11: Python project (pyproject.toml)
	// ════════════════════════════════════════════════════════════════════════

	describe("Python project", () => {
		beforeEach(async () => {
			await createFile(
				"pyproject.toml",
				[
					"[project]",
					'name = "my-python-app"',
					'version = "0.1.0"',
					"",
					"[project.dependencies]",
					'"fastapi"',
					'"uvicorn"',
				].join("\n"),
			);
			await createFile("src/main.py", "from fastapi import FastAPI");
			await createFile("tests/test_main.py", "def test_hello(): pass");
		});

		it("detects python as the primary language", async () => {
			const ctx = await scanner.scan(tempDir);
			expect(ctx.languages).toContain("python");
			expect(ctx.languages[0]).toBe("python");
		});

		it("includes pyproject.toml in config files", async () => {
			const ctx = await scanner.scan(tempDir);
			expect(ctx.configFiles["pyproject.toml"]).toBeDefined();
			expect(ctx.configFiles["pyproject.toml"]).toContain("my-python-app");
		});

		it("sets isEmpty to false", async () => {
			const ctx = await scanner.scan(tempDir);
			expect(ctx.isEmpty).toBe(false);
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Test 12: Language detection ordering
	// ════════════════════════════════════════════════════════════════════════

	describe("language detection", () => {
		it("orders languages by file frequency", async () => {
			// More TS files than JS files
			await createFile("src/a.ts", "");
			await createFile("src/b.ts", "");
			await createFile("src/c.ts", "");
			await createFile("lib/d.js", "");

			const ctx = await scanner.scan(tempDir);
			const tsIndex = ctx.languages.indexOf("typescript");
			const jsIndex = ctx.languages.indexOf("javascript");
			expect(tsIndex).toBeLessThan(jsIndex);
		});

		it("places meta languages after source languages", async () => {
			await createFile("src/app.ts", "");
			await createFile("config.json", "{}");
			await createFile("README.md", "# Hello");
			await createFile("data.yaml", "key: value");

			const ctx = await scanner.scan(tempDir);
			const tsIndex = ctx.languages.indexOf("typescript");
			const jsonIndex = ctx.languages.indexOf("json");
			const mdIndex = ctx.languages.indexOf("markdown");
			const yamlIndex = ctx.languages.indexOf("yaml");

			expect(tsIndex).toBeLessThan(jsonIndex);
			expect(tsIndex).toBeLessThan(mdIndex);
			expect(tsIndex).toBeLessThan(yamlIndex);
		});

		it("returns meta languages if they are the only ones", async () => {
			await createFile("config.json", "{}");
			await createFile("README.md", "# Docs");

			const ctx = await scanner.scan(tempDir);
			expect(ctx.languages).toContain("json");
			expect(ctx.languages).toContain("markdown");
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Test 13: Config file detection (detect-only)
	// ════════════════════════════════════════════════════════════════════════

	describe("detect-only config files", () => {
		it("detects biome.json without reading content", async () => {
			await createFile(
				"biome.json",
				JSON.stringify({ organizeImports: { enabled: true } }),
			);
			await createFile("src/app.ts", "");

			const ctx = await scanner.scan(tempDir);
			expect(ctx.configFiles["biome.json"]).toBe("(detected)");
		});

		it("detects eslint config files without reading content", async () => {
			await createFile(".eslintrc.json", JSON.stringify({ rules: {} }));
			await createFile("src/app.ts", "");

			const ctx = await scanner.scan(tempDir);
			expect(ctx.configFiles[".eslintrc.json"]).toBe("(detected)");
		});

		it("detects prettier config files without reading content", async () => {
			await createFile(".prettierrc", JSON.stringify({ semi: false }));
			await createFile("src/app.ts", "");

			const ctx = await scanner.scan(tempDir);
			expect(ctx.configFiles[".prettierrc"]).toBe("(detected)");
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Test 14: tsconfig.json is read
	// ════════════════════════════════════════════════════════════════════════

	describe("tsconfig.json reading", () => {
		it("includes tsconfig.json content in config files", async () => {
			await createFile(
				"tsconfig.json",
				JSON.stringify({
					compilerOptions: {
						strict: true,
						target: "ES2022",
						module: "Node16",
					},
				}),
			);
			await createFile("src/app.ts", "");

			const ctx = await scanner.scan(tempDir);
			expect(ctx.configFiles["tsconfig.json"]).toBeDefined();
			expect(ctx.configFiles["tsconfig.json"]).toContain("strict");
			expect(ctx.configFiles["tsconfig.json"]).toContain("ES2022");
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Test 15: Docker detection
	// ════════════════════════════════════════════════════════════════════════

	describe("Docker and docker-compose detection", () => {
		it("reads Dockerfile content", async () => {
			await createFile("Dockerfile", "FROM node:20-alpine\nWORKDIR /app");
			await createFile("src/app.ts", "");

			const ctx = await scanner.scan(tempDir);
			expect(ctx.configFiles.Dockerfile).toBeDefined();
			expect(ctx.configFiles.Dockerfile).toContain("node:20-alpine");
		});

		it("reads docker-compose.yml content", async () => {
			await createFile(
				"docker-compose.yml",
				"version: '3'\nservices:\n  web:\n    build: .\n  db:\n    image: postgres:15",
			);
			await createFile("src/app.ts", "");

			const ctx = await scanner.scan(tempDir);
			expect(ctx.configFiles["docker-compose.yml"]).toBeDefined();
			expect(ctx.configFiles["docker-compose.yml"]).toContain("services");
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Test 16: Framework detection from dependencies
	// ════════════════════════════════════════════════════════════════════════

	describe("framework detection from dependencies", () => {
		it("detects React from package.json dependencies", async () => {
			await createFile(
				"package.json",
				JSON.stringify({
					name: "react-app",
					dependencies: { react: "^18.2.0", "react-dom": "^18.2.0" },
				}),
			);
			await createFile("src/App.tsx", "export default function App() {}");

			const ctx = await scanner.scan(tempDir);
			expect(ctx.detectedFrameworks).toContain("React");
		});

		it("detects Tailwind CSS from devDependencies", async () => {
			await createFile(
				"package.json",
				JSON.stringify({
					name: "tailwind-app",
					devDependencies: { tailwindcss: "^3.4.0" },
				}),
			);
			await createFile("src/app.ts", "");

			const ctx = await scanner.scan(tempDir);
			expect(ctx.detectedFrameworks).toContain("Tailwind CSS");
		});

		it("detects Prisma from dependencies", async () => {
			await createFile(
				"package.json",
				JSON.stringify({
					name: "prisma-app",
					dependencies: { prisma: "^5.0.0" },
				}),
			);
			await createFile("src/db.ts", "");

			const ctx = await scanner.scan(tempDir);
			expect(ctx.detectedFrameworks).toContain("Prisma");
		});

		it("detects Vitest from devDependencies", async () => {
			await createFile(
				"package.json",
				JSON.stringify({
					name: "vitest-app",
					devDependencies: { vitest: "^1.0.0" },
				}),
			);
			await createFile("src/app.ts", "");

			const ctx = await scanner.scan(tempDir);
			expect(ctx.detectedFrameworks).toContain("Vitest");
		});

		it("detects multiple frameworks in one project", async () => {
			await createFile(
				"package.json",
				JSON.stringify({
					name: "fullstack-app",
					dependencies: {
						react: "^18.2.0",
						express: "^4.18.0",
						prisma: "^5.0.0",
					},
					devDependencies: {
						jest: "^29.0.0",
						tailwindcss: "^3.4.0",
					},
				}),
			);
			await createFile("src/index.tsx", "");

			const ctx = await scanner.scan(tempDir);
			expect(ctx.detectedFrameworks).toContain("React");
			expect(ctx.detectedFrameworks).toContain("Express.js");
			expect(ctx.detectedFrameworks).toContain("Prisma");
			expect(ctx.detectedFrameworks).toContain("Jest");
			expect(ctx.detectedFrameworks).toContain("Tailwind CSS");
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Test 17: Go project (go.mod)
	// ════════════════════════════════════════════════════════════════════════

	describe("Go project", () => {
		it("detects go as the primary language", async () => {
			await createFile(
				"go.mod",
				"module github.com/user/my-go-app\n\ngo 1.21\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n)",
			);
			await createFile("main.go", "package main\nfunc main() {}");
			await createFile("handlers/user.go", "package handlers");

			const ctx = await scanner.scan(tempDir);
			expect(ctx.languages[0]).toBe("go");
			expect(ctx.configFiles["go.mod"]).toBeDefined();
			expect(ctx.configFiles["go.mod"]).toContain("my-go-app");
			expect(ctx.isEmpty).toBe(false);
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Test 18: File tree sorting
	// ════════════════════════════════════════════════════════════════════════

	describe("file tree sorting", () => {
		it("returns entries sorted alphabetically", async () => {
			await createFile("zebra.ts", "");
			await createFile("alpha.ts", "");
			await createFile("middle.ts", "");

			const ctx = await scanner.scan(tempDir);

			const files = ctx.fileTree.filter((p) => p.endsWith(".ts"));
			const sorted = [...files].sort();
			expect(files).toEqual(sorted);
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Test 19: Directories end with /
	// ════════════════════════════════════════════════════════════════════════

	describe("directory naming convention", () => {
		it("directories in fileTree end with /", async () => {
			await createFile("src/index.ts", "");
			await createFile("lib/utils.ts", "");

			const ctx = await scanner.scan(tempDir);

			const dirs = ctx.fileTree.filter((p) => p === "src/" || p === "lib/");
			expect(dirs.length).toBe(2);
			for (const dir of dirs) {
				expect(dir.endsWith("/")).toBe(true);
			}
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Test 20: Resilience to filesystem errors
	// ════════════════════════════════════════════════════════════════════════

	describe("error resilience", () => {
		it("scan returns a valid context for a non-existent directory", async () => {
			const nonExistent = join(tempDir, "does-not-exist");
			const ctx = await scanner.scan(nonExistent);

			expect(ctx.cwd).toBe(nonExistent);
			expect(ctx.fileTree).toEqual([]);
			expect(ctx.languages).toEqual([]);
			expect(ctx.isEmpty).toBe(true);
		});

		it("handles malformed package.json gracefully", async () => {
			await createFile("package.json", "{ this is not valid json !!!");
			await createFile("src/app.ts", "");

			const ctx = await scanner.scan(tempDir);

			// Should still have a config file entry, just with raw content
			expect(ctx.configFiles["package.json"]).toBeDefined();
			// Should not throw
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Test 21: requirements.txt detection
	// ════════════════════════════════════════════════════════════════════════

	describe("requirements.txt", () => {
		it("reads requirements.txt as a config file", async () => {
			await createFile(
				"requirements.txt",
				"flask==2.3.0\nrequests>=2.28.0\npytest\n",
			);
			await createFile("app.py", "from flask import Flask");

			const ctx = await scanner.scan(tempDir);
			expect(ctx.configFiles["requirements.txt"]).toBeDefined();
			expect(ctx.configFiles["requirements.txt"]).toContain("flask");
			expect(ctx.configFiles["requirements.txt"]).toContain("pytest");
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Test 22: Multiple language detection
	// ════════════════════════════════════════════════════════════════════════

	describe("multi-language projects", () => {
		it("detects multiple languages in a polyglot project", async () => {
			await createFile("frontend/app.tsx", "");
			await createFile("frontend/styles.css", "");
			await createFile("backend/server.py", "");
			await createFile("scripts/deploy.sh", "");
			await createFile("db/schema.sql", "");

			const ctx = await scanner.scan(tempDir);

			expect(ctx.languages).toContain("typescript");
			expect(ctx.languages).toContain("python");
			expect(ctx.languages).toContain("css");
			expect(ctx.languages).toContain("shell");
			expect(ctx.languages).toContain("sql");
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Test 23: isEmpty edge cases
	// ════════════════════════════════════════════════════════════════════════

	describe("isEmpty edge cases", () => {
		it("returns true when only json and markdown files exist", async () => {
			await createFile("README.md", "# Project");
			await createFile("config.json", "{}");
			await createFile("data.yaml", "key: value");

			const ctx = await scanner.scan(tempDir);
			expect(ctx.isEmpty).toBe(true);
		});

		it("returns false when at least one source file exists", async () => {
			await createFile("README.md", "# Project");
			await createFile("src/main.py", "print('hello')");

			const ctx = await scanner.scan(tempDir);
			expect(ctx.isEmpty).toBe(false);
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Test 24: Makefile detection
	// ════════════════════════════════════════════════════════════════════════

	describe("Makefile detection", () => {
		it("reads Makefile content", async () => {
			await createFile(
				"Makefile",
				"build:\n\tgo build -o bin/app\n\ntest:\n\tgo test ./...",
			);
			await createFile("main.go", "package main");

			const ctx = await scanner.scan(tempDir);
			expect(ctx.configFiles.Makefile).toBeDefined();
			expect(ctx.configFiles.Makefile).toContain("build");
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Test 25: Summary content for empty project
	// ════════════════════════════════════════════════════════════════════════

	describe("empty project summary", () => {
		it("summary indicates empty/new project", async () => {
			const ctx = await scanner.scan(tempDir);
			const lower = ctx.summary.toLowerCase();
			expect(lower).toContain("empty");
			expect(lower).toContain("no source files");
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Test 26: Summary for existing project has structure info
	// ════════════════════════════════════════════════════════════════════════

	describe("existing project summary", () => {
		it("contains structure and file count information", async () => {
			await createFile("src/index.ts", "");
			await createFile("src/utils.ts", "");
			await createFile("tests/app.test.ts", "");
			await createFile(
				"package.json",
				JSON.stringify({ name: "summary-test" }),
			);

			const ctx = await scanner.scan(tempDir);
			expect(ctx.summary).toContain("summary-test");
			expect(ctx.summary).toContain("src");
			expect(ctx.summary).toMatch(/\d+ source file/);
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Test 27: Stateless scanner
	// ════════════════════════════════════════════════════════════════════════

	describe("stateless behavior", () => {
		it("produces identical results when scanning the same directory twice", async () => {
			await createFile("src/app.ts", "console.log('hello');");
			await createFile(
				"package.json",
				JSON.stringify({ name: "idempotent-test" }),
			);

			const ctx1 = await scanner.scan(tempDir);
			const ctx2 = await scanner.scan(tempDir);

			expect(ctx1.fileTree).toEqual(ctx2.fileTree);
			expect(ctx1.languages).toEqual(ctx2.languages);
			expect(ctx1.configFiles).toEqual(ctx2.configFiles);
			expect(ctx1.detectedFrameworks).toEqual(ctx2.detectedFrameworks);
			expect(ctx1.isEmpty).toBe(ctx2.isEmpty);
			expect(ctx1.summary).toBe(ctx2.summary);
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Test 28: Vue, Svelte file extensions detected as languages
	// ════════════════════════════════════════════════════════════════════════

	describe("special file extensions", () => {
		it("detects .vue files as vue language", async () => {
			await createFile("src/App.vue", "<template></template>");
			await createFile("src/main.ts", "");

			const ctx = await scanner.scan(tempDir);
			expect(ctx.languages).toContain("vue");
		});

		it("detects .svelte files as svelte language", async () => {
			await createFile("src/App.svelte", "<script></script>");
			await createFile("src/main.ts", "");

			const ctx = await scanner.scan(tempDir);
			expect(ctx.languages).toContain("svelte");
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Test 29: Frameworks array is sorted
	// ════════════════════════════════════════════════════════════════════════

	describe("frameworks sorting", () => {
		it("returns detected frameworks in sorted order", async () => {
			await createFile(
				"package.json",
				JSON.stringify({
					name: "sorted-test",
					dependencies: {
						react: "^18.0.0",
						express: "^4.0.0",
					},
					devDependencies: {
						jest: "^29.0.0",
					},
				}),
			);
			await createFile("src/app.tsx", "");

			const ctx = await scanner.scan(tempDir);
			const sorted = [...ctx.detectedFrameworks].sort();
			expect(ctx.detectedFrameworks).toEqual(sorted);
		});
	});

	// ════════════════════════════════════════════════════════════════════════
	// Test 30: peerDependencies are included in package.json summary
	// ════════════════════════════════════════════════════════════════════════

	describe("peerDependencies in package.json summary", () => {
		it("includes peerDependencies names", async () => {
			await createFile(
				"package.json",
				JSON.stringify({
					name: "peer-test",
					peerDependencies: {
						react: "^18.0.0",
						"react-dom": "^18.0.0",
					},
				}),
			);
			await createFile("src/index.tsx", "");

			const ctx = await scanner.scan(tempDir);
			const summary = ctx.configFiles["package.json"]!;
			expect(summary).toContain("PeerDependencies");
			expect(summary).toContain("react");
			expect(summary).toContain("react-dom");
			// No versions
			expect(summary).not.toContain("18.0.0");
		});
	});
});
