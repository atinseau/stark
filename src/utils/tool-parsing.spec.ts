import { describe, expect, it } from "bun:test";

import {
	parseExitCode,
	parseToolCommand,
	parseToolOutput,
} from "./tool-parsing.ts";

// ── parseToolCommand ───────────────────────────────────────────────────────

describe("parseToolCommand", () => {
	it("extracts command from { command: '...' } shape", () => {
		expect(parseToolCommand({ command: "docker info" })).toBe("docker info");
	});

	it("extracts complex shell commands", () => {
		expect(
			parseToolCommand({
				command: 'docker info 2>&1 || echo "Docker not running"',
			}),
		).toBe('docker info 2>&1 || echo "Docker not running"');
	});

	it("extracts piped commands", () => {
		expect(
			parseToolCommand({ command: "sleep 5 && docker info 2>&1 | head -20" }),
		).toBe("sleep 5 && docker info 2>&1 | head -20");
	});

	it("trims whitespace from command", () => {
		expect(parseToolCommand({ command: "  ls -la  " })).toBe("ls -la");
	});

	it("returns undefined for null input", () => {
		expect(parseToolCommand(null)).toBeUndefined();
	});

	it("returns undefined for undefined input", () => {
		expect(parseToolCommand(undefined)).toBeUndefined();
	});

	it("returns undefined for non-object input", () => {
		expect(parseToolCommand("not an object")).toBeUndefined();
		expect(parseToolCommand(42)).toBeUndefined();
		expect(parseToolCommand(true)).toBeUndefined();
	});

	it("returns undefined for object without command field", () => {
		expect(parseToolCommand({ path: "/some/file" })).toBeUndefined();
		expect(parseToolCommand({})).toBeUndefined();
	});

	it("returns undefined when command is not a string", () => {
		expect(parseToolCommand({ command: 42 })).toBeUndefined();
		expect(parseToolCommand({ command: null })).toBeUndefined();
		expect(parseToolCommand({ command: true })).toBeUndefined();
		expect(parseToolCommand({ command: ["ls", "-la"] })).toBeUndefined();
	});

	it("returns undefined for empty or whitespace-only command", () => {
		expect(parseToolCommand({ command: "" })).toBeUndefined();
		expect(parseToolCommand({ command: "   " })).toBeUndefined();
	});

	it("ignores extra fields in the input object", () => {
		expect(
			parseToolCommand({ command: "echo hello", otherField: "ignored" }),
		).toBe("echo hello");
	});
});

// ── parseToolOutput ────────────────────────────────────────────────────────

describe("parseToolOutput", () => {
	it("extracts and cleans output from { content, detailedContent } shape", () => {
		const rawOutput = {
			content: "hello world\n<exited with exit code 0>",
			detailedContent: "hello world\n<exited with exit code 0>",
		};
		expect(parseToolOutput(rawOutput)).toBe("hello world");
	});

	it("extracts output from { content } alone", () => {
		expect(
			parseToolOutput({ content: "some output\n<exited with exit code 0>" }),
		).toBe("some output");
	});

	it("falls back to detailedContent when content is missing", () => {
		expect(
			parseToolOutput({
				detailedContent: "detailed output\n<exited with exit code 1>",
			}),
		).toBe("detailed output");
	});

	it("strips the exit code marker from output", () => {
		const rawOutput = {
			content:
				"Client:\n Version: 28.5.2\nCannot connect\n<exited with exit code 0>",
		};
		expect(parseToolOutput(rawOutput)).toBe(
			"Client:\n Version: 28.5.2\nCannot connect",
		);
	});

	it("handles output with non-zero exit codes", () => {
		expect(
			parseToolOutput({ content: "error\n<exited with exit code 127>" }),
		).toBe("error");
	});

	it("handles output without an exit code marker", () => {
		expect(parseToolOutput({ content: "just some output" })).toBe(
			"just some output",
		);
	});

	it("handles multiline output", () => {
		const content = "line 1\nline 2\nline 3\n<exited with exit code 0>";
		expect(parseToolOutput({ content })).toBe("line 1\nline 2\nline 3");
	});

	it("handles plain string rawOutput", () => {
		expect(parseToolOutput("plain output")).toBe("plain output");
	});

	it("handles plain string with exit marker", () => {
		expect(parseToolOutput("output\n<exited with exit code 0>")).toBe("output");
	});

	it("trims whitespace from result", () => {
		expect(
			parseToolOutput({ content: "  spaced  \n<exited with exit code 0>" }),
		).toBe("spaced");
	});

	it("returns undefined for null input", () => {
		expect(parseToolOutput(null)).toBeUndefined();
	});

	it("returns undefined for undefined input", () => {
		expect(parseToolOutput(undefined)).toBeUndefined();
	});

	it("returns undefined for empty content", () => {
		expect(parseToolOutput({ content: "" })).toBeUndefined();
	});

	it("returns undefined when content is only the exit marker", () => {
		expect(
			parseToolOutput({ content: "<exited with exit code 0>" }),
		).toBeUndefined();
	});

	it("returns undefined when content is only whitespace + exit marker", () => {
		expect(
			parseToolOutput({ content: "\n<exited with exit code 0>" }),
		).toBeUndefined();
	});

	it("JSON-stringifies objects without content or detailedContent", () => {
		const result = parseToolOutput({ foo: "bar", baz: 42 });
		expect(result).toBeDefined();
		const parsed = JSON.parse(result!);
		expect(parsed.foo).toBe("bar");
		expect(parsed.baz).toBe(42);
	});

	it("handles number input by converting to string", () => {
		expect(parseToolOutput(42)).toBe("42");
	});

	it("handles boolean input by converting to string", () => {
		expect(parseToolOutput(true)).toBe("true");
	});

	it("handles empty string input", () => {
		expect(parseToolOutput("")).toBeUndefined();
	});

	it("handles whitespace-only string input", () => {
		expect(parseToolOutput("   ")).toBeUndefined();
	});

	it("preserves output content before exit marker exactly", () => {
		const content =
			"PASS: all tests passed\nTotal: 42\n<exited with exit code 0>";
		expect(parseToolOutput({ content })).toBe(
			"PASS: all tests passed\nTotal: 42",
		);
	});
});

// ── parseExitCode ──────────────────────────────────────────────────────────

describe("parseExitCode", () => {
	it("extracts exit code 0 from content", () => {
		expect(
			parseExitCode({ content: "output\n<exited with exit code 0>" }),
		).toBe(0);
	});

	it("extracts non-zero exit codes", () => {
		expect(parseExitCode({ content: "error\n<exited with exit code 1>" })).toBe(
			1,
		);
		expect(
			parseExitCode({ content: "not found\n<exited with exit code 127>" }),
		).toBe(127);
		expect(
			parseExitCode({ content: "killed\n<exited with exit code 137>" }),
		).toBe(137);
	});

	it("extracts exit code from detailedContent when content is missing", () => {
		expect(
			parseExitCode({ detailedContent: "output\n<exited with exit code 2>" }),
		).toBe(2);
	});

	it("extracts exit code from plain string rawOutput", () => {
		expect(parseExitCode("output\n<exited with exit code 0>")).toBe(0);
	});

	it("extracts exit code from { content, detailedContent } shape", () => {
		expect(
			parseExitCode({
				content: "ok\n<exited with exit code 0>",
				detailedContent: "ok\n<exited with exit code 0>",
			}),
		).toBe(0);
	});

	it("returns undefined when there is no exit marker", () => {
		expect(parseExitCode({ content: "no marker here" })).toBeUndefined();
	});

	it("returns undefined for null input", () => {
		expect(parseExitCode(null)).toBeUndefined();
	});

	it("returns undefined for undefined input", () => {
		expect(parseExitCode(undefined)).toBeUndefined();
	});

	it("returns undefined for empty content", () => {
		expect(parseExitCode({ content: "" })).toBeUndefined();
	});

	it("returns undefined for object without content fields", () => {
		expect(parseExitCode({ foo: "bar" })).toBeUndefined();
	});

	it("extracts exit code when marker is the only content", () => {
		expect(parseExitCode({ content: "<exited with exit code 42>" })).toBe(42);
	});

	it("extracts exit code from multiline output", () => {
		const content = "line 1\nline 2\nline 3\nline 4\n<exited with exit code 0>";
		expect(parseExitCode({ content })).toBe(0);
	});

	it("handles large exit codes", () => {
		expect(parseExitCode({ content: "<exited with exit code 255>" })).toBe(255);
	});
});

// ── Integration: parseToolCommand + parseToolOutput + parseExitCode ────────

describe("Tool parsing integration", () => {
	it("handles a full execute tool lifecycle", () => {
		// Simulate what the Agent receives from ACP for an execute tool
		const rawInput = { command: "docker info 2>&1" };
		const rawOutput = {
			content:
				"Client:\n Version: 28.5.2\nCannot connect to the Docker daemon\n<exited with exit code 1>",
			detailedContent:
				"Client:\n Version: 28.5.2\nCannot connect to the Docker daemon\n<exited with exit code 1>",
		};

		const command = parseToolCommand(rawInput);
		const output = parseToolOutput(rawOutput);
		const exitCode = parseExitCode(rawOutput);

		expect(command).toBe("docker info 2>&1");
		expect(output).toBe(
			"Client:\n Version: 28.5.2\nCannot connect to the Docker daemon",
		);
		expect(exitCode).toBe(1);
	});

	it("handles a successful command with clean output", () => {
		const rawInput = { command: "echo hello" };
		const rawOutput = {
			content: "hello\n<exited with exit code 0>",
			detailedContent: "hello\n<exited with exit code 0>",
		};

		expect(parseToolCommand(rawInput)).toBe("echo hello");
		expect(parseToolOutput(rawOutput)).toBe("hello");
		expect(parseExitCode(rawOutput)).toBe(0);
	});

	it("handles a command with empty output", () => {
		const rawInput = { command: "open -a OrbStack" };
		const rawOutput = {
			content: "\n<exited with exit code 0>",
			detailedContent: "\n<exited with exit code 0>",
		};

		expect(parseToolCommand(rawInput)).toBe("open -a OrbStack");
		expect(parseToolOutput(rawOutput)).toBeUndefined();
		expect(parseExitCode(rawOutput)).toBe(0);
	});

	it("handles non-execute tools gracefully", () => {
		// A "read" tool might have a path-based rawInput
		const rawInput = { path: "/some/file.ts" };

		expect(parseToolCommand(rawInput)).toBeUndefined();
	});

	it("handles missing rawInput and rawOutput", () => {
		expect(parseToolCommand(undefined)).toBeUndefined();
		expect(parseToolOutput(undefined)).toBeUndefined();
		expect(parseExitCode(undefined)).toBeUndefined();
	});
});
