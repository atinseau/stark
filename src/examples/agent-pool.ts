/**
 * Stark — AgentPool Orchestration Demo
 *
 * This file demonstrates every public capability of the AgentPool class:
 *
 *   1. Creating a pool with OpenRouter configuration
 *   2. Subscribing to pool-level typed events
 *   3. Executing a task (adaptive single/multi-agent decision)
 *   4. Sending follow-up messages (notifications, status, context injection)
 *   5. Inspecting pool state
 *   6. Graceful shutdown
 *
 * Run with:
 *   bun run src/examples/agent-pool.ts
 *
 * Requires:
 *   - OPENROUTER_API_KEY environment variable
 *   - A running ACP-compatible agent executable (e.g. Copilot CLI)
 */

import { join } from "node:path";
import { AgentPool } from "../classes/agent-pool/agent-pool.ts";
import { PoolEvent } from "../enums/pool-event.enum.ts";
import { ansi, separator, truncate } from "../utils/formatting.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Pretty-print a section header to stderr. */
function heading(label: string): void {
	process.stderr.write(`\n${separator(label)}\n`);
}

/** Write an info line to stderr. */
function info(icon: string, msg: string): void {
	process.stderr.write(`  ${icon}  ${msg}\n`);
}

// ── Main ───────────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
	// ┌─────────────────────────────────────────────────────────────────────┐
	// │  0. Validate environment                                           │
	// └─────────────────────────────────────────────────────────────────────┘

	const apiKey = process.env.OPENROUTER_API_KEY;
	if (!apiKey) {
		process.stderr.write(
			`\n${ansi.red}${ansi.bold}Error:${ansi.reset} OPENROUTER_API_KEY environment variable is not set.\n` +
				`Set it to your OpenRouter API key before running this example.\n\n`,
		);
		process.exitCode = 1;
		return;
	}

	// ┌─────────────────────────────────────────────────────────────────────┐
	// │  1. Create an AgentPool with configuration                          │
	// └─────────────────────────────────────────────────────────────────────┘

	heading("CREATING AGENT POOL");

	const pool = new AgentPool({
		// OpenRouter credentials — the only LLM provider supported
		openRouterApiKey: apiKey,

		// Model used for orchestration (planning, analysis, sharing decisions)
		// The agents themselves use their own model via ACP
		model: "anthropic/claude-opus-4.6",

		// Log output config — applies to the pool AND all spawned agents
		logOutput: {
			console: true,
			json: "./logs/agent-pool.ndjson",
			seq: true,
		},
		logLevel: "info",

		// Working directory for all spawned agents
		cwd: join(process.cwd()),

		// Agent-specific configuration (no need to repeat logOutput/logLevel/cwd)
		agentConfig: {
			autoApprove: true,
		},

		// Maximum concurrent agents (prevents resource exhaustion)
		maxAgents: 5,

		// Retry configuration for OpenRouter API calls
		maxRetries: 3,

		// Temperature for orchestration LLM calls (lower = more deterministic)
		temperature: 0.2,
	});

	info("🏗️ ", "AgentPool created");
	info(
		"📊",
		`State: executing=${pool.getState().executing}, agents=${pool.getState().activeAgentCount}`,
	);

	// ┌─────────────────────────────────────────────────────────────────────┐
	// │  2. Subscribe to pool-level events                                 │
	// └─────────────────────────────────────────────────────────────────────┘

	heading("SUBSCRIBING TO EVENTS");

	// Planning events — see how the pool decides its strategy
	pool.on(PoolEvent.PLANNING_START, (e) => {
		info(
			"🧠",
			`Planning started for: ${ansi.dim}${truncate(e.task, 80)}${ansi.reset}`,
		);
	});

	pool.on(PoolEvent.PLANNING_COMPLETE, (e) => {
		const { analysis } = e;
		info(
			"✅",
			`Planning complete: ${ansi.bold}${analysis.strategy}${ansi.reset} strategy, ` +
				`${ansi.cyan}${analysis.complexity}${ansi.reset} complexity, ` +
				`${analysis.subtasks.length} subtask(s)`,
		);
		info(
			"💭",
			`Reasoning: ${ansi.dim}${truncate(analysis.reasoning, 120)}${ansi.reset}`,
		);

		if (analysis.subtasks.length > 1) {
			for (const subtask of analysis.subtasks) {
				info(
					"  ",
					`📋 ${ansi.bold}${subtask.role}${ansi.reset}: ${ansi.dim}${truncate(subtask.prompt, 80)}${ansi.reset}`,
				);
			}
		}
	});

	// Agent lifecycle events
	pool.on(PoolEvent.AGENT_SPAWNED, (e) => {
		info(
			"🤖",
			`Agent spawned: ${ansi.bold}${e.agentName}${ansi.reset} (${ansi.dim}${e.subtask.role}${ansi.reset})`,
		);
	});

	pool.on(PoolEvent.AGENT_COMPLETED, (e) => {
		info(
			"✅",
			`Agent completed: ${ansi.bold}${e.agentName}${ansi.reset} — ` +
				`${ansi.dim}${e.result.promptResult.text.length} chars, ` +
				`${e.result.filesWritten.length} files written${ansi.reset}`,
		);
	});

	pool.on(PoolEvent.AGENT_ERROR, (e) => {
		info(
			"❌",
			`Agent error: ${ansi.red}${e.agentName}: ${e.error}${ansi.reset}`,
		);
	});

	// Delta and sharing events — observe the adaptive orchestration
	pool.on(PoolEvent.DELTA_DETECTED, (e) => {
		info(
			"📡",
			`Delta: ${ansi.dim}[${e.delta.type}] ${e.delta.agentName}: ` +
				`${truncate(e.delta.summary, 80)} (significance: ${e.delta.significance})${ansi.reset}`,
		);
	});

	pool.on(PoolEvent.SHARING_DECISION, (e) => {
		const { decision } = e;
		const icon = decision.shouldShare ? "🔗" : "🔇";
		const color = decision.shouldShare ? ansi.green : ansi.dim;
		info(
			icon,
			`${color}Sharing ${decision.shouldShare ? "approved" : "denied"}: ` +
				`${decision.sourceAgentId.slice(0, 8)}… → ${decision.targetAgentId.slice(0, 8)}…${ansi.reset}`,
		);
		if (decision.shouldShare) {
			info(
				"  ",
				`${ansi.dim}Info: ${truncate(decision.information, 100)}${ansi.reset}`,
			);
		}
	});

	pool.on(PoolEvent.CONTEXT_SHARED, (e) => {
		info(
			"💉",
			`Context shared: ${ansi.cyan}${e.sourceAgentId.slice(0, 8)}… → ` +
				`${e.targetAgentId.slice(0, 8)}…${ansi.reset} ` +
				`${ansi.dim}(${e.information.length} chars)${ansi.reset}`,
		);
	});

	// User notifications (only fire when user has opted in)
	pool.on(PoolEvent.NOTIFICATION, (e) => {
		info(
			"🔔",
			`${ansi.yellow}${ansi.bold}Notification:${ansi.reset} ${e.notification.message}`,
		);
	});

	// Execution lifecycle
	pool.on(PoolEvent.EXECUTION_COMPLETE, (e) => {
		info(
			"🏁",
			`Execution complete in ${ansi.bold}${e.result.durationMs}ms${ansi.reset} — ` +
				`${e.result.agents.length} agent(s), strategy: ${e.result.strategy}`,
		);
	});

	pool.on(PoolEvent.ERROR, (e) => {
		info("💥", `${ansi.red}Pool error: ${e.error} (${e.context})${ansi.reset}`);
	});

	info("📡", "All pool event listeners registered");

	// ┌─────────────────────────────────────────────────────────────────────┐
	// │  3. Optionally enable notifications                                │
	// │                                                                    │
	// │  By default, the pool is silent — no automatic notifications.      │
	// │  You can enable them via setNotificationPreference() or by         │
	// │  sending a natural language message like:                          │
	// │  "Notify me when important things happen"                          │
	// └─────────────────────────────────────────────────────────────────────┘

	heading("NOTIFICATION PREFERENCE");

	// Option A: Direct API call
	pool.setNotificationPreference({
		enabled: true,
		minSignificance: 0.7, // Only notify for significant events
	});

	info(
		"🔔",
		`Notifications: ${ansi.green}enabled${ansi.reset} (min significance: 0.7)`,
	);

	// Option B: Natural language via pool.send() — uncomment to try:
	// const notifResult = await pool.send("Notify me when agents complete their tasks");
	// info("🔔", `Notification response: ${notifResult}`);

	// ┌─────────────────────────────────────────────────────────────────────┐
	// │  4. Execute a task                                                 │
	// │                                                                    │
	// │  The pool will:                                                    │
	// │  - Analyze the task via its planner LLM conversation               │
	// │  - Decide: single agent or multiple agents                         │
	// │  - Spawn agent(s) with appropriate prompts                         │
	// │  - Monitor execution, compute deltas                               │
	// │  - Conditionally share information between agents                  │
	// │  - Generate an execution summary                                   │
	// └─────────────────────────────────────────────────────────────────────┘

	heading("EXECUTING TASK");

	const task =
		process.argv[2] ??
		"I want to develop a morpion game in javascript with a server and a client. Client wait for an user to join the game and then start. The game is won when a player align 3 pieces. Write the code for the server and the client, and write tests for the server. Ui should have a fency ui with animations and sounds.";

	info("💬", `Task: ${ansi.blue}${truncate(task, 120)}${ansi.reset}`);
	process.stderr.write("\n");

	try {
		const result = await pool.execute(task);

		// ┌─────────────────────────────────────────────────────────────────┐
		// │  5. Inspect the result                                         │
		// └─────────────────────────────────────────────────────────────────┘

		heading("EXECUTION RESULT");

		info("🎯", `Strategy: ${ansi.bold}${result.strategy}${ansi.reset}`);
		info("🧩", `Complexity: ${result.analysis.complexity}`);
		info("⏱️ ", `Duration: ${ansi.bold}${result.durationMs}ms${ansi.reset}`);
		info("🤖", `Agents used: ${result.agents.length}`);

		for (const agentResult of result.agents) {
			const statusIcon = agentResult.success ? "✅" : "❌";
			info(
				statusIcon,
				`${ansi.bold}${agentResult.agentName}${ansi.reset} (${agentResult.subtask.role}): ` +
					`${agentResult.promptResult.text.length} chars, ` +
					`${agentResult.filesWritten.length} files, ` +
					`${agentResult.events.length} events`,
			);
			if (agentResult.error) {
				info("  ", `${ansi.red}Error: ${agentResult.error}${ansi.reset}`);
			}
		}

		heading("EXECUTION SUMMARY");
		process.stderr.write(`\n${result.summary}\n\n`);

		// ┌─────────────────────────────────────────────────────────────────┐
		// │  6. Inspect pool state                                         │
		// └─────────────────────────────────────────────────────────────────┘

		heading("POOL STATE (post-execution)");

		const state = pool.getState();
		info("📊", `Executing: ${state.executing}`);
		info("📋", `Current task: ${state.currentTask ?? "none"}`);
		info("🤖", `Active agents: ${state.activeAgentCount}`);
		info("🔔", `Notifications enabled: ${state.notificationsEnabled}`);
		info("📡", `Total deltas: ${state.deltaCount}`);
		info("🔗", `Sharing decisions: ${state.sharingDecisionCount}`);

		// ┌─────────────────────────────────────────────────────────────────┐
		// │  7. Demonstrate follow-up messages via pool.send()             │
		// │                                                                │
		// │  The send() method analyzes user intent and routes to:         │
		// │  - New task execution                                          │
		// │  - Status queries                                              │
		// │  - Notification preference changes                             │
		// │  - Context injection into running agents                       │
		// │  - Cancellation                                                │
		// └─────────────────────────────────────────────────────────────────┘

		// Uncomment to try follow-up interactions:
		//
		// heading("FOLLOW-UP: STATUS QUERY");
		// const statusResponse = await pool.send("What's the current status?");
		// info("📊", `Status: ${statusResponse}`);
		//
		// heading("FOLLOW-UP: NEW TASK");
		// const followUpResult = await pool.send("Now add unit tests for the utility module");
		// if (typeof followUpResult !== "string") {
		//   info("🏁", `Follow-up completed: ${followUpResult.strategy} strategy, ${followUpResult.durationMs}ms`);
		// }
	} catch (err) {
		info("💥", `${ansi.red}Execution failed: ${err}${ansi.reset}`);
	}

	// ┌─────────────────────────────────────────────────────────────────────┐
	// │  8. Graceful shutdown                                              │
	// └─────────────────────────────────────────────────────────────────────┘

	heading("SHUTTING DOWN");
	await pool.destroy();
	info("👋", "AgentPool destroyed");

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
