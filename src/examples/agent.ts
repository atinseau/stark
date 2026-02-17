/**
 * Stark — ACP Agent Client Demo
 *
 * This file demonstrates every public capability of the Agent class:
 *
 *   1. Creating an agent with custom configuration
 *   2. Subscribing to typed events (tool calls, plans, file I/O, etc.)
 *   3. Interactive permission approval via APPROVE_REQUEST event
 *   4. Sending a prompt and reading the result
 *   5. Injecting context mid-execution
 *   6. Inspecting agent state via snapshots
 *   7. Graceful shutdown
 *
 * Run with:
 *   bun run src/index.ts
 */

import * as readline from "node:readline";
import { Agent } from "../classes/agent/agent.ts";
import { AgentEvent } from "../enums/agent-event.enum.ts";
import { ansi, renderBar, separator } from "../utils/formatting.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Pretty-print a section header to stderr so it doesn't mix with agent output. */
function heading(label: string): void {
	process.stderr.write(`\n${separator(label)}\n`);
}

/** Write an info line to stderr. */
function info(icon: string, msg: string): void {
	process.stderr.write(`  ${icon}  ${msg}\n`);
}

/** Indent every line of a multi-line string with a fixed prefix. */
function indentBlock(text: string, prefix = "       "): string {
	return text
		.split("\n")
		.map((line) => `${prefix}${line}`)
		.join("\n");
}

/**
 * Prompt the user on stdin with a yes/no question.
 * Returns `true` for yes, `false` for no.
 */
function askYesNo(question: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stderr,
		});

		rl.question(
			`  ❓  ${question} ${ansi.bold}(yes/no)${ansi.reset}: `,
			(answer) => {
				rl.close();
				const normalized = answer.trim().toLowerCase();
				resolve(normalized === "yes" || normalized === "y");
			},
		);
	});
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	heading("CREATING AGENT");

	// ┌─────────────────────────────────────────────────────────────────────┐
	// │  1. Create an agent with custom config                             │
	// │                                                                    │
	// │  autoApprove is set to false — the agent will emit an              │
	// │  APPROVE_REQUEST event for each permission request, and we         │
	// │  handle it below by asking the user on stdin.                      │
	// └─────────────────────────────────────────────────────────────────────┘

	const agent = new Agent({
		// Let Faker generate a fun name, or override:
		// name: "My Custom Agent",
		// id: "agent-001",

		// Path to the ACP executable (falls back to $COPILOT_CLI_PATH → "copilot")
		// executable: "/usr/local/bin/copilot",

		// Working directory the agent operates in
		cwd: process.cwd(),

		// Logger configuration
		logOutput: {
			json: "./logs/agent.ndjson",
			console: true, // Colorized pino-pretty output on stderr
			seq: true, // Stream structured logs to Seq (http://localhost:8082)
		},
		logLevel: "info",

		// OpenTelemetry tracing → Seq (docker compose up -d)
		tracing: true,

		// Interactive approval — each tool permission request will block
		// until the user confirms via stdin (Yes/No)
		autoApprove: false,
	});

	info(
		"🤖",
		`Agent: ${ansi.bold}${agent.name}${ansi.reset} ${ansi.dim}(${agent.id})${ansi.reset}`,
	);
	info("📊", `Status: ${agent.status}`);
	info(
		"🔐",
		`Auto-approve: ${ansi.yellow}off${ansi.reset} — you will be prompted for each permission request`,
	);

	// ┌─────────────────────────────────────────────────────────────────────┐
	// │  2. Subscribe to typed events                                      │
	// └─────────────────────────────────────────────────────────────────────┘

	heading("SUBSCRIBING TO EVENTS");

	// Agent lifecycle
	agent.on(AgentEvent.AGENT_READY, (e) => {
		info(
			"✅",
			`Agent ready — session: ${ansi.cyan}${e.sessionId}${ansi.reset}`,
		);
	});

	agent.on(AgentEvent.AGENT_ERROR, (e) => {
		info(
			"❌",
			`${ansi.red}Error: ${e.error.message} (${e.context})${ansi.reset}`,
		);
	});

	// Prompt output — stream agent text to stdout in real-time
	agent.on(AgentEvent.PROMPT_CHUNK, (e) => {
		process.stdout.write(e.text);
	});

	// Agent reasoning (if the model supports it)
	agent.on(AgentEvent.PROMPT_THOUGHT, (e) => {
		process.stderr.write(`${ansi.magenta}${ansi.italic}${e.text}${ansi.reset}`);
	});

	// Tool calls — see what the agent is doing
	agent.on(AgentEvent.TOOL_START, (e) => {
		const kindLabel = e.kind ? ` [${e.kind}]` : "";
		info(
			"🔧",
			`Tool started: ${ansi.bold}${e.title}${ansi.reset}${ansi.dim}${kindLabel}${ansi.reset}`,
		);

		if (e.locations && e.locations.length > 0) {
			for (const loc of e.locations) {
				const line = loc.line != null ? `:${loc.line}` : "";
				info("  ", `📄 ${ansi.cyan}${loc.path}${line}${ansi.reset}`);
			}
		}

		// Show the actual command (pre-parsed by Agent from rawInput)
		if (e.command) {
			process.stderr.write(
				`${ansi.dim}${indentBlock(`$ ${ansi.reset}${ansi.yellow}${e.command}${ansi.reset}`)}${ansi.reset}\n`,
			);
		}
	});

	// Tool progress — show intermediate output (pre-parsed by Agent from rawOutput)
	agent.on(AgentEvent.TOOL_UPDATE, (e) => {
		if (e.output) {
			const lines = e.output.split("\n");
			const preview =
				lines.length > 20
					? [
							...lines.slice(0, 20),
							`${ansi.dim}… (${lines.length - 20} more lines)${ansi.reset}`,
						].join("\n")
					: e.output;
			process.stderr.write(`${ansi.dim}${indentBlock(preview)}${ansi.reset}\n`);
		}
	});

	agent.on(AgentEvent.TOOL_COMPLETE, (e) => {
		const exitLabel =
			e.exitCode != null ? ` ${ansi.dim}(exit ${e.exitCode})${ansi.reset}` : "";
		info("✅", `Tool done: ${ansi.dim}${e.title}${ansi.reset}${exitLabel}`);
	});

	agent.on(AgentEvent.TOOL_FAILED, (e) => {
		const exitLabel =
			e.exitCode != null ? ` ${ansi.dim}(exit ${e.exitCode})${ansi.reset}` : "";
		info("❌", `Tool failed: ${ansi.red}${e.title}${ansi.reset}${exitLabel}`);
		if (e.output) {
			process.stderr.write(
				`${ansi.red}${indentBlock(e.output)}${ansi.reset}\n`,
			);
		}
	});

	// Execution plan — track what the agent intends to do
	agent.on(AgentEvent.PLAN_UPDATE, (e) => {
		heading("EXECUTION PLAN");
		for (const entry of e.entries) {
			const statusIcon =
				entry.status === "completed"
					? "✅"
					: entry.status === "in_progress"
						? "⚙️ "
						: "⏳";
			const priorityColor =
				entry.priority === "high"
					? ansi.red
					: entry.priority === "medium"
						? ansi.yellow
						: ansi.dim;
			info(
				statusIcon,
				`${priorityColor}[${entry.priority}]${ansi.reset} ${entry.content}`,
			);
		}
	});

	// File system operations
	agent.on(AgentEvent.FS_WRITE, (e) => {
		info(
			"💾",
			`Write: ${ansi.green}${e.path}${ansi.reset} ${ansi.dim}(${e.contentLength} chars)${ansi.reset}`,
		);
	});

	agent.on(AgentEvent.FS_READ, (e) => {
		info(
			"📖",
			`Read: ${ansi.cyan}${e.path}${ansi.reset} ${ansi.dim}(${e.contentLength} chars)${ansi.reset}`,
		);
	});

	// Terminal activity
	agent.on(AgentEvent.TERMINAL_CREATED, (e) => {
		info(
			"▶️ ",
			`Terminal: ${ansi.yellow}${e.command} ${e.args.join(" ")}${ansi.reset} ${ansi.dim}in ${e.cwd}${ansi.reset}`,
		);
	});

	agent.on(AgentEvent.TERMINAL_EXIT, (e) => {
		const code = e.exitCode ?? "?";
		const color = e.exitCode === 0 ? ansi.green : ansi.red;
		info("🏁", `Terminal exited: ${color}code=${code}${ansi.reset}`);
	});

	// Permission decisions
	agent.on(AgentEvent.PERMISSION_GRANTED, (e) => {
		info("🔓", `Permission granted: ${ansi.green}${e.optionName}${ansi.reset}`);
	});

	agent.on(AgentEvent.PERMISSION_DENIED, (e) => {
		info("🔒", `Permission denied: ${ansi.red}${e.reason}${ansi.reset}`);
	});

	// ┌─────────────────────────────────────────────────────────────────────┐
	// │  3. Interactive approval handler                                   │
	// │                                                                    │
	// │  Because autoApprove is false, the agent emits APPROVE_REQUEST     │
	// │  whenever it needs permission. We block on stdin until the user    │
	// │  types "yes" or "no".                                              │
	// └─────────────────────────────────────────────────────────────────────┘

	agent.on(AgentEvent.APPROVE_REQUEST, (e) => {
		process.stderr.write(
			`\n${ansi.bold}${ansi.yellow}┌── Permission Request ──────────────────────────────────┐${ansi.reset}\n`,
		);
		info("🔐", `Tool: ${ansi.bold}${e.toolCallTitle}${ansi.reset}`);
		info("🆔", `Tool call ID: ${ansi.dim}${e.toolCallId}${ansi.reset}`);

		if (e.options.length > 0) {
			info("📋", "Available options:");
			for (const opt of e.options) {
				info("  ", `  ${ansi.dim}[${opt.kind}]${ansi.reset} ${opt.name}`);
			}
		}

		process.stderr.write(
			`${ansi.bold}${ansi.yellow}└────────────────────────────────────────────────────────┘${ansi.reset}\n`,
		);

		askYesNo("Do you approve this action?").then((approved) => {
			if (approved) {
				info("✅", `${ansi.green}User approved${ansi.reset}`);
			} else {
				info("🚫", `${ansi.red}User denied${ansi.reset}`);
			}
			e.resolve(approved);
		});
	});

	// Token usage
	agent.on(AgentEvent.USAGE_UPDATE, (e) => {
		const bar = renderBar(e.contextPercent);
		let costStr = "";
		if (e.cost) {
			costStr = ` | ${ansi.yellow}$${e.cost.amount.toFixed(4)} ${e.cost.currency}${ansi.reset}`;
		}
		info(
			"📊",
			`Context: ${bar} ${e.contextPercent}% (${e.contextUsed.toLocaleString()}/${e.contextSize.toLocaleString()})${costStr}`,
		);
	});

	// Context injection tracking
	agent.on(AgentEvent.CONTEXT_INJECTED, (e) => {
		const status = e.queued
			? `${ansi.yellow}queued${ansi.reset}`
			: `${ansi.green}immediate${ansi.reset}`;
		info(
			"💉",
			`Context injected (${status}): ${ansi.dim}${e.instructions.slice(0, 80)}${e.instructions.length > 80 ? "…" : ""}${ansi.reset}`,
		);
	});

	// Mode changes
	agent.on(AgentEvent.MODE_CHANGE, (e) => {
		info("🔄", `Mode: ${ansi.cyan}${e.modeId}${ansi.reset}`);
	});

	info("📡", "All event listeners registered");

	// ┌─────────────────────────────────────────────────────────────────────┐
	// │  4. Wait for the agent to be ready                                 │
	// └─────────────────────────────────────────────────────────────────────┘

	heading("WAITING FOR AGENT READY");

	try {
		await agent.ready;
	} catch (err) {
		info("💥", `${ansi.red}Agent failed to initialize: ${err}${ansi.reset}`);
		process.exitCode = 1;
		return;
	}

	info(
		"✅",
		`Agent is ${ansi.green}${agent.status}${ansi.reset}, session: ${ansi.cyan}${agent.sessionId}${ansi.reset}`,
	);

	// ┌─────────────────────────────────────────────────────────────────────┐
	// │  5. Send a prompt                                                  │
	// └─────────────────────────────────────────────────────────────────────┘

	heading("SENDING PROMPT");

	const promptText =
		process.argv[2] ??
		"Je veux que lances un container docker que tu supprimeras juste apres qui devra faire un simple hello world dans le terminal";
	info("💬", `Prompt: ${ansi.blue}${promptText}${ansi.reset}`);

	process.stdout.write("\n"); // Blank line before agent output

	const result = await agent.prompt(promptText);

	process.stdout.write("\n"); // Blank line after agent output

	heading("PROMPT RESULT");
	info("🏁", `Stop reason: ${ansi.bold}${result.stopReason}${ansi.reset}`);
	info(
		"📝",
		`Response length: ${ansi.dim}${result.text.length} chars${ansi.reset}`,
	);

	if (result.usage) {
		const u = result.usage;
		info(
			"📊",
			`Tokens — in: ${u.inputTokens} | out: ${u.outputTokens} | total: ${u.totalTokens}${u.thoughtTokens ? ` | thought: ${u.thoughtTokens}` : ""}`,
		);
	}

	// ┌─────────────────────────────────────────────────────────────────────┐
	// │  6. Demonstrate context injection                                  │
	// │                                                                    │
	// │  This shows how a pool orchestrator could alter the agent's        │
	// │  behavior between prompts. The injected context becomes part of    │
	// │  the ongoing conversation.                                         │
	// └─────────────────────────────────────────────────────────────────────┘

	// Uncomment the block below to see context injection in action:
	//
	// heading("CONTEXT INJECTION DEMO");
	//
	// // Inject context while idle — will be sent with the next prompt
	// agent.injectContext("From now on, add comprehensive error handling to all code you write.");
	//
	// // Send another prompt that benefits from the injected context
	// const result2 = await agent.prompt("Add a health check endpoint to the server");
	// info("🏁", `Second prompt: ${result2.stopReason}, ${result2.text.length} chars`);
	//
	// // You can also inject context while the agent is busy.
	// // It will be queued and sent automatically after the current prompt completes:
	// //
	// // const promptPromise = agent.prompt("Build the database layer");
	// // agent.injectContext("Use connection pooling"); // queued!
	// // await promptPromise; // injected context is sent as follow-up

	// ┌─────────────────────────────────────────────────────────────────────┐
	// │  7. Inspect agent state via snapshot                               │
	// └─────────────────────────────────────────────────────────────────────┘

	heading("AGENT SNAPSHOT");

	const snap = agent.snapshot();
	info("🆔", `ID: ${snap.identity.id}`);
	info("📛", `Name: ${snap.identity.name}`);
	info("📊", `Status: ${snap.status}`);
	info("🔢", `Prompts processed: ${snap.promptCount}`);
	info("📋", `Pending context: ${snap.pendingContextCount}`);
	info("🔗", `Session: ${snap.sessionId ?? "none"}`);

	// ┌─────────────────────────────────────────────────────────────────────┐
	// │  8. Graceful shutdown                                              │
	// └─────────────────────────────────────────────────────────────────────┘

	heading("SHUTTING DOWN");
	await agent.destroy();
	info(
		"👋",
		`Agent ${ansi.bold}${agent.name}${ansi.reset} destroyed. Status: ${ansi.dim}${agent.status}${ansi.reset}`,
	);

	heading("ALL DONE");
}

// ── Entry Point ────────────────────────────────────────────────────────────

main().catch((err) => {
	process.stderr.write(
		`\n${ansi.red}${ansi.bold}Fatal error:${ansi.reset} ${err}\n`,
	);
	if (err instanceof Error && err.stack) {
		process.stderr.write(`${ansi.dim}${err.stack}${ansi.reset}\n`);
	}
	process.exitCode = 1;
});
