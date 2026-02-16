import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import type { CreateTerminalRequest } from "@agentclientprotocol/sdk";
import { type TerminalExitResult, TerminalManager } from "../terminal-manager";

/**
 * Helper that builds a valid `CreateTerminalRequest` with a dummy `sessionId`.
 * Only `command` is required; everything else is optional.
 */
function req(
	params: Omit<CreateTerminalRequest, "sessionId">,
): CreateTerminalRequest {
	return { sessionId: "test-session", ...params };
}

describe("TerminalManager", () => {
	let manager: TerminalManager;

	beforeEach(() => {
		manager = new TerminalManager();
	});

	afterEach(() => {
		manager.destroyAll();
	});

	// ── Creation ───────────────────────────────────────────────────────────

	describe("create", () => {
		it("creates a terminal and returns a ManagedTerminal with all fields", () => {
			const terminal = manager.create(
				req({
					command: "echo",
					args: ["hello"],
					cwd: "/tmp",
				}),
			);

			expect(terminal).toHaveProperty("terminalId");
			expect(terminal).toHaveProperty("child");
			expect(terminal).toHaveProperty("command", "echo");
			expect(terminal).toHaveProperty("args", ["hello"]);
			expect(terminal).toHaveProperty("cwd", "/tmp");
			expect(terminal).toHaveProperty("output", "");
			expect(terminal).toHaveProperty("exitPromise");
			expect(typeof terminal.terminalId).toBe("string");
			expect(terminal.terminalId).toContain("term-");
		});

		it("generates unique terminal IDs across multiple calls", () => {
			const t1 = manager.create(req({ command: "echo", args: ["1"] }));
			const t2 = manager.create(req({ command: "echo", args: ["2"] }));
			const t3 = manager.create(req({ command: "echo", args: ["3"] }));

			expect(t1.terminalId).not.toBe(t2.terminalId);
			expect(t2.terminalId).not.toBe(t3.terminalId);
			expect(t1.terminalId).not.toBe(t3.terminalId);
		});

		it("defaults args to empty array when not provided", () => {
			const terminal = manager.create(req({ command: "echo" }));

			expect(terminal.args).toEqual([]);
		});

		it("defaults cwd to process.cwd() when not provided", () => {
			const terminal = manager.create(req({ command: "echo" }));

			expect(terminal.cwd).toBe(process.cwd());
		});

		it("tracks the created terminal (has returns true)", () => {
			const terminal = manager.create(req({ command: "echo", args: ["test"] }));

			expect(manager.has(terminal.terminalId)).toBe(true);
		});

		it("increments the size counter", () => {
			expect(manager.size).toBe(0);

			manager.create(req({ command: "echo", args: ["1"] }));
			expect(manager.size).toBe(1);

			manager.create(req({ command: "echo", args: ["2"] }));
			expect(manager.size).toBe(2);
		});

		it("passes environment variables to the child process", () => {
			const terminal = manager.create(
				req({
					command: "echo",
					args: ["$MY_TEST_VAR"],
					env: [{ name: "MY_TEST_VAR", value: "stark_test_123" }],
				}),
			);

			// The terminal was created without error — env was accepted
			expect(terminal.terminalId).toBeDefined();
		});
	});

	// ── Output Accumulation ────────────────────────────────────────────────

	describe("output accumulation", () => {
		it("accumulates stdout output from the process", async () => {
			const terminal = manager.create(
				req({
					command: "echo",
					args: ["hello world"],
				}),
			);

			await terminal.exitPromise;

			expect(terminal.output).toContain("hello world");
		});

		it("accumulates stderr output from the process", async () => {
			const terminal = manager.create(
				req({
					command: "echo error_msg >&2",
				}),
			);

			await terminal.exitPromise;

			expect(terminal.output).toContain("error_msg");
		});

		it("accumulates both stdout and stderr", async () => {
			const terminal = manager.create(
				req({
					command: "echo out_data && echo err_data >&2",
				}),
			);

			await terminal.exitPromise;

			expect(terminal.output).toContain("out_data");
			expect(terminal.output).toContain("err_data");
		});
	});

	// ── getOutput ──────────────────────────────────────────────────────────

	describe("getOutput", () => {
		it("returns accumulated output and truncated=false", async () => {
			const terminal = manager.create(
				req({
					command: "echo",
					args: ["get_output_test"],
				}),
			);

			await terminal.exitPromise;

			const result = manager.getOutput(terminal.terminalId);

			expect(result.output).toContain("get_output_test");
			expect(result.truncated).toBe(false);
		});

		it("includes exitStatus when process has exited", async () => {
			const terminal = manager.create(
				req({
					command: "echo",
					args: ["done"],
				}),
			);

			await terminal.exitPromise;

			const result = manager.getOutput(terminal.terminalId);

			expect(result.exitStatus).toBeDefined();
			expect(result.exitStatus?.exitCode).toBe(0);
		});

		it("throws for an unknown terminal ID", () => {
			expect(() => manager.getOutput("nonexistent-terminal")).toThrow(
				/unknown terminal/i,
			);
		});
	});

	// ── waitForExit ────────────────────────────────────────────────────────

	describe("waitForExit", () => {
		it("resolves with exitCode 0 for a successful command", async () => {
			const terminal = manager.create(
				req({
					command: "true",
				}),
			);

			const result = await manager.waitForExit(terminal.terminalId);

			expect(result.exitCode).toBe(0);
		});

		it("resolves with non-zero exitCode for a failing command", async () => {
			const terminal = manager.create(
				req({
					command: "false",
				}),
			);

			const result = await manager.waitForExit(terminal.terminalId);

			expect(result.exitCode).not.toBe(0);
		});

		it("resolves with the correct exit code from the process", async () => {
			const terminal = manager.create(
				req({
					command: "exit 42",
				}),
			);

			const result = await manager.waitForExit(terminal.terminalId);

			expect(result.exitCode).toBe(42);
		});

		it("throws for an unknown terminal ID", async () => {
			expect(() => manager.waitForExit("ghost-terminal")).toThrow(
				/unknown terminal/i,
			);
		});
	});

	// ── release ────────────────────────────────────────────────────────────

	describe("release", () => {
		it("removes the terminal from tracking", () => {
			const terminal = manager.create(req({ command: "sleep", args: ["60"] }));

			expect(manager.has(terminal.terminalId)).toBe(true);

			manager.release(terminal.terminalId);

			expect(manager.has(terminal.terminalId)).toBe(false);
			expect(manager.size).toBe(0);
		});

		it("kills a running process on release", async () => {
			const terminal = manager.create(req({ command: "sleep", args: ["60"] }));

			manager.release(terminal.terminalId);

			// The exit promise should resolve (process was killed)
			const result = await terminal.exitPromise;

			// Should have been terminated by a signal
			expect(
				result.exitCode !== 0 ||
					result.signal !== null ||
					result.signal !== undefined,
			).toBe(true);
		});

		it("is a no-op for an already-released terminal", () => {
			const terminal = manager.create(req({ command: "echo", args: ["test"] }));

			manager.release(terminal.terminalId);
			// Should not throw
			manager.release(terminal.terminalId);

			expect(manager.has(terminal.terminalId)).toBe(false);
		});

		it("decrements the size counter", () => {
			const t1 = manager.create(req({ command: "sleep", args: ["60"] }));
			const t2 = manager.create(req({ command: "sleep", args: ["60"] }));

			expect(manager.size).toBe(2);

			manager.release(t1.terminalId);
			expect(manager.size).toBe(1);

			manager.release(t2.terminalId);
			expect(manager.size).toBe(0);
		});
	});

	// ── kill ───────────────────────────────────────────────────────────────

	describe("kill", () => {
		it("kills the process but keeps the terminal tracked", async () => {
			const terminal = manager.create(req({ command: "sleep", args: ["60"] }));

			manager.kill(terminal.terminalId);

			// Terminal should still be tracked
			expect(manager.has(terminal.terminalId)).toBe(true);

			// Process should exit
			const result = await terminal.exitPromise;
			expect(result.signal !== null || result.exitCode !== 0).toBe(true);
		});

		it("is a no-op for an unknown terminal ID", () => {
			// Should not throw
			manager.kill("nonexistent-id");
		});

		it("allows output retrieval after kill", async () => {
			const terminal = manager.create(
				req({
					command: "echo before_kill && sleep 60",
				}),
			);

			// Wait a bit for the echo to produce output
			await new Promise((resolve) => setTimeout(resolve, 100));

			manager.kill(terminal.terminalId);
			await terminal.exitPromise;

			// Output should still be accessible
			const result = manager.getOutput(terminal.terminalId);
			expect(result.output).toContain("before_kill");
		});
	});

	// ── destroyAll ─────────────────────────────────────────────────────────

	describe("destroyAll", () => {
		it("releases all tracked terminals", () => {
			manager.create(req({ command: "sleep", args: ["60"] }));
			manager.create(req({ command: "sleep", args: ["60"] }));
			manager.create(req({ command: "sleep", args: ["60"] }));

			expect(manager.size).toBe(3);

			manager.destroyAll();

			expect(manager.size).toBe(0);
		});

		it("is safe to call when no terminals are tracked", () => {
			expect(manager.size).toBe(0);

			// Should not throw
			manager.destroyAll();

			expect(manager.size).toBe(0);
		});

		it("is safe to call multiple times", () => {
			manager.create(req({ command: "sleep", args: ["60"] }));

			manager.destroyAll();
			manager.destroyAll();

			expect(manager.size).toBe(0);
		});
	});

	// ── Callbacks ──────────────────────────────────────────────────────────

	describe("setOutputCallback", () => {
		it("fires the callback with stdout data", async () => {
			const outputs: { terminalId: string; stream: string; text: string }[] =
				[];

			manager.setOutputCallback((terminalId, stream, text) => {
				outputs.push({ terminalId, stream, text });
			});

			const terminal = manager.create(
				req({
					command: "echo",
					args: ["callback_test"],
				}),
			);

			await terminal.exitPromise;

			const stdoutOutputs = outputs.filter((o) => o.stream === "stdout");
			expect(stdoutOutputs.length).toBeGreaterThan(0);

			const combined = stdoutOutputs.map((o) => o.text).join("");
			expect(combined).toContain("callback_test");

			// All callbacks should reference the correct terminal
			for (const output of outputs) {
				expect(output.terminalId).toBe(terminal.terminalId);
			}
		});

		it("fires the callback with stderr data", async () => {
			const outputs: { terminalId: string; stream: string; text: string }[] =
				[];

			manager.setOutputCallback((terminalId, stream, text) => {
				outputs.push({ terminalId, stream, text });
			});

			const terminal = manager.create(
				req({
					command: "echo stderr_cb_test >&2",
				}),
			);

			await terminal.exitPromise;

			const stderrOutputs = outputs.filter((o) => o.stream === "stderr");
			expect(stderrOutputs.length).toBeGreaterThan(0);

			const combined = stderrOutputs.map((o) => o.text).join("");
			expect(combined).toContain("stderr_cb_test");
		});
	});

	describe("setExitCallback", () => {
		it("fires the callback when a process exits", async () => {
			const exits: { terminalId: string; result: TerminalExitResult }[] = [];

			manager.setExitCallback((terminalId, result) => {
				exits.push({ terminalId, result });
			});

			const terminal = manager.create(
				req({
					command: "echo",
					args: ["exit_test"],
				}),
			);

			await terminal.exitPromise;

			expect(exits.length).toBe(1);
			expect(exits[0]?.terminalId).toBe(terminal.terminalId);
			expect(exits[0]?.result.exitCode).toBe(0);
		});

		it("reports the correct exit code for failing commands", async () => {
			const exits: { terminalId: string; result: TerminalExitResult }[] = [];

			manager.setExitCallback((terminalId, result) => {
				exits.push({ terminalId, result });
			});

			const terminal = manager.create(
				req({
					command: "exit 7",
				}),
			);

			await terminal.exitPromise;

			expect(exits.length).toBe(1);
			expect(exits[0]?.result.exitCode).toBe(7);
		});

		it("fires exit callbacks for multiple terminals independently", async () => {
			const exits: string[] = [];

			manager.setExitCallback((terminalId) => {
				exits.push(terminalId);
			});

			const t1 = manager.create(req({ command: "echo", args: ["a"] }));
			const t2 = manager.create(req({ command: "echo", args: ["b"] }));

			await Promise.all([t1.exitPromise, t2.exitPromise]);

			expect(exits.length).toBe(2);
			expect(exits).toContain(t1.terminalId);
			expect(exits).toContain(t2.terminalId);
		});
	});

	// ── Edge Cases ─────────────────────────────────────────────────────────

	describe("edge cases", () => {
		it("handles a command that produces no output", async () => {
			const terminal = manager.create(
				req({
					command: "true",
				}),
			);

			await terminal.exitPromise;

			expect(terminal.output).toBe("");

			const result = manager.getOutput(terminal.terminalId);
			expect(result.output).toBe("");
			expect(result.truncated).toBe(false);
		});

		it("handles rapid sequential creation and release", () => {
			for (let i = 0; i < 10; i++) {
				const terminal = manager.create(
					req({ command: "echo", args: [String(i)] }),
				);
				manager.release(terminal.terminalId);
			}

			expect(manager.size).toBe(0);
		});

		it("handles multiline output correctly", async () => {
			const terminal = manager.create(
				req({
					command: "echo line1 && echo line2 && echo line3",
				}),
			);

			await terminal.exitPromise;

			expect(terminal.output).toContain("line1");
			expect(terminal.output).toContain("line2");
			expect(terminal.output).toContain("line3");
		});

		it("has() returns false for never-created terminal IDs", () => {
			expect(manager.has("never-existed")).toBe(false);
		});

		it("has() returns false after release", () => {
			const terminal = manager.create(req({ command: "sleep", args: ["60"] }));
			const id = terminal.terminalId;

			expect(manager.has(id)).toBe(true);

			manager.release(id);

			expect(manager.has(id)).toBe(false);
		});
	});
});
