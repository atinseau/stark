import { afterEach, describe, expect, it } from "bun:test";

import { AgentPool } from "../src/classes/agent-pool/agent-pool.ts";
import {
	collectPoolEvents,
	createMockAgent,
	createMockAgentFactory,
} from "../src/classes/agent-pool/tests/test-helpers.ts";
import { PoolEvent } from "../src/enums/pool-event.enum.ts";
import type {
	AgentPoolConfig,
	AgentPoolResult,
	AgentPoolState,
	PoolManagedAgent,
} from "../src/types/agent-pool.types.ts";

/**
 * Helper: checks whether a `send()` response is a string or an AgentPoolResult.
 * LLM intent classification is non-deterministic, so tests must accept both.
 */
function isPoolResult(value: unknown): value is AgentPoolResult {
	return (
		typeof value === "object" &&
		value !== null &&
		"task" in value &&
		"strategy" in value &&
		"agents" in value
	);
}

// ════════════════════════════════════════════════════════════════════════════
// AgentPool — End-to-End Tests
//
// These tests exercise the full AgentPool orchestration pipeline with
// real OpenRouter LLM calls for planning, intent analysis, summary
// generation, and information sharing. Mock agents are used in place
// of real ACP processes, but all orchestration intelligence is live.
//
// Run exclusively via:  bun run test:e2e
//
// Requires:  OPENROUTER_API_KEY environment variable
// ════════════════════════════════════════════════════════════════════════════

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
const HAS_API_KEY = OPENROUTER_API_KEY.length > 0;

// Use a fast, cheap model for E2E tests to minimize cost
const E2E_MODEL = process.env.E2E_MODEL ?? "anthropic/claude-sonnet-4-20250514";

// Generous timeout for LLM round-trips
const E2E_TIMEOUT_MS = 120_000;

/**
 * Creates a pool config wired to real OpenRouter but with mock agents.
 * All logs are silenced to keep test output clean.
 * Temperature is set to 0 for maximum determinism in intent classification.
 */
function e2ePoolConfig(overrides?: Partial<AgentPoolConfig>): AgentPoolConfig {
	return {
		openRouterApiKey: OPENROUTER_API_KEY,
		model: E2E_MODEL,
		maxAgents: 3,
		maxRetries: 2,
		temperature: 0,
		logOutput: { console: false, json: false },
		logLevel: "silent" as any,
		createAgent: createMockAgentFactory(),
		...overrides,
	};
}

/**
 * Creates a mock agent factory that tracks all spawned agents
 * and allows configuring per-agent behavior.
 */
function trackingAgentFactory(options?: {
	promptDelay?: number;
	promptText?: string;
}) {
	const agents: PoolManagedAgent[] = [];
	const promptCalls: Array<{ agentName: string; promptText: string }> = [];

	const factory = (config?: { name?: string }) => {
		const agent = createMockAgent({
			name: config?.name ?? `E2E-Agent-${agents.length + 1}`,
			promptResult: {
				stopReason: "end_turn",
				text:
					options?.promptText ??
					`Task completed successfully by ${config?.name ?? "agent"}.`,
				usage: { inputTokens: 150, outputTokens: 80, totalTokens: 230 },
			},
		});

		// Wrap prompt to track calls and optionally add delay
		const originalPrompt = agent.prompt;
		(agent as any).prompt = async (text: string) => {
			promptCalls.push({ agentName: agent.name, promptText: text });
			if (options?.promptDelay) {
				await new Promise((resolve) =>
					setTimeout(resolve, options.promptDelay),
				);
			}
			return originalPrompt(text);
		};

		agents.push(agent);
		return agent;
	};

	return { factory, agents, promptCalls };
}

// ════════════════════════════════════════════════════════════════════════════
// Test Suite
// ════════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_API_KEY)("AgentPool E2E", () => {
	let pool: AgentPool;

	afterEach(async () => {
		if (pool && !(pool as any)._destroyed) {
			await pool.destroy();
		}
	});

	// ── 1. Single Agent Spawning & Task Completion ─────────────────────

	describe("single agent execution", () => {
		it(
			"spawns a single agent and completes a simple task",
			async () => {
				const tracker = trackingAgentFactory();

				pool = new AgentPool(e2ePoolConfig({ createAgent: tracker.factory }));

				const result = await pool.execute(
					"Create a file called hello.txt with the content 'Hello World'",
				);

				// ── Strategy validation ──────────────────────────────────
				expect(result).toBeDefined();
				expect(result.task).toContain("hello.txt");
				expect(result.strategy).toBeDefined();
				expect(["single", "multi"]).toContain(result.strategy);

				// ── Analysis was produced by the LLM planner ─────────────
				expect(result.analysis).toBeDefined();
				expect(result.analysis.reasoning.length).toBeGreaterThan(10);
				expect(result.analysis.subtasks.length).toBeGreaterThanOrEqual(1);
				expect(result.analysis.complexity).toBeDefined();

				// ── At least one agent was spawned and completed ──────────
				expect(tracker.agents.length).toBeGreaterThanOrEqual(1);
				expect(result.agents.length).toBeGreaterThanOrEqual(1);

				const firstAgent = result.agents[0]!;
				expect(firstAgent.success).toBe(true);
				expect(firstAgent.agentName).toBeDefined();
				expect(firstAgent.promptResult.text.length).toBeGreaterThan(0);

				// ── Summary was generated by the LLM ─────────────────────
				expect(result.summary.length).toBeGreaterThan(10);

				// ── Duration is tracked ──────────────────────────────────
				expect(result.durationMs).toBeGreaterThan(0);

				// ── All agents received prompts ──────────────────────────
				expect(tracker.promptCalls.length).toBeGreaterThanOrEqual(1);
			},
			E2E_TIMEOUT_MS,
		);

		it(
			"emits lifecycle events during single-agent execution",
			async () => {
				const tracker = trackingAgentFactory();

				pool = new AgentPool(e2ePoolConfig({ createAgent: tracker.factory }));

				const taskReceivedEvents = collectPoolEvents(
					pool,
					PoolEvent.TASK_RECEIVED,
				);
				const planningStartEvents = collectPoolEvents(
					pool,
					PoolEvent.PLANNING_START,
				);
				const planningCompleteEvents = collectPoolEvents(
					pool,
					PoolEvent.PLANNING_COMPLETE,
				);
				const agentSpawnedEvents = collectPoolEvents(
					pool,
					PoolEvent.AGENT_SPAWNED,
				);
				const agentCompletedEvents = collectPoolEvents(
					pool,
					PoolEvent.AGENT_COMPLETED,
				);
				const executionCompleteEvents = collectPoolEvents(
					pool,
					PoolEvent.EXECUTION_COMPLETE,
				);

				await pool.execute("Fix a typo in the README file");

				expect(taskReceivedEvents.length).toBe(1);
				expect(planningStartEvents.length).toBe(1);
				expect(planningCompleteEvents.length).toBe(1);
				expect(agentSpawnedEvents.length).toBeGreaterThanOrEqual(1);
				expect(agentCompletedEvents.length).toBeGreaterThanOrEqual(1);
				expect(executionCompleteEvents.length).toBe(1);
			},
			E2E_TIMEOUT_MS,
		);
	});

	// ── 2. Multi-Agent Spawning ───────────────────────────────────────

	describe("multi-agent execution", () => {
		it(
			"spawns multiple agents for a complex task with separable concerns",
			async () => {
				const tracker = trackingAgentFactory();

				pool = new AgentPool(
					e2ePoolConfig({
						createAgent: tracker.factory,
						maxAgents: 5,
					}),
				);

				const result = await pool.execute(
					"Build a complete REST API with Express.js including: " +
						"1) The API routes and controllers for a user management system (CRUD), " +
						"2) A comprehensive test suite with unit and integration tests using Jest, " +
						"3) API documentation using Swagger/OpenAPI specification",
				);

				expect(result).toBeDefined();
				expect(result.analysis).toBeDefined();
				expect(result.analysis.subtasks.length).toBeGreaterThanOrEqual(1);

				// Whether the LLM chooses single or multi, agents must have completed
				expect(result.agents.length).toBeGreaterThanOrEqual(1);
				for (const agentResult of result.agents) {
					expect(agentResult.success).toBe(true);
					expect(agentResult.subtask).toBeDefined();
					expect(agentResult.subtask.role.length).toBeGreaterThan(0);
					expect(agentResult.subtask.prompt.length).toBeGreaterThan(0);
				}

				// All spawned agents received prompts
				expect(tracker.promptCalls.length).toBe(result.agents.length);

				// Summary covers the execution
				expect(result.summary.length).toBeGreaterThan(0);
			},
			E2E_TIMEOUT_MS,
		);

		it(
			"respects maxAgents limit even when planner suggests more subtasks",
			async () => {
				const tracker = trackingAgentFactory();

				pool = new AgentPool(
					e2ePoolConfig({
						createAgent: tracker.factory,
						maxAgents: 2,
					}),
				);

				const result = await pool.execute(
					"Build a full-stack application with: " +
						"1) A React frontend with routing and state management, " +
						"2) A Node.js backend API with authentication, " +
						"3) A PostgreSQL database schema with migrations, " +
						"4) Deployment configuration with Docker and CI/CD pipeline",
				);

				// Regardless of how many subtasks the planner identified,
				// no more than 2 agents should have been spawned
				expect(tracker.agents.length).toBeLessThanOrEqual(2);
				expect(result.agents.length).toBeLessThanOrEqual(2);
			},
			E2E_TIMEOUT_MS,
		);
	});

	// ── 3. Status Query During & After Execution ──────────────────────

	describe("status querying", () => {
		it("getState reflects idle state before execution", () => {
			const tracker = trackingAgentFactory();
			pool = new AgentPool(e2ePoolConfig({ createAgent: tracker.factory }));

			const state = pool.getState();

			expect(state.executing).toBe(false);
			expect(state.currentTask).toBeNull();
			expect(state.strategy).toBeNull();
			expect(state.activeAgentCount).toBe(0);
			expect(state.agents).toEqual([]);
			expect(state.notificationsEnabled).toBe(false);
			expect(state.deltaCount).toBe(0);
			expect(state.sharingDecisionCount).toBe(0);
		});

		it(
			"getState reflects executing state during task execution",
			async () => {
				const stateSnapshots: AgentPoolState[] = [];

				// Use a delay so we can capture state mid-execution
				const tracker = trackingAgentFactory({ promptDelay: 200 });

				pool = new AgentPool(e2ePoolConfig({ createAgent: tracker.factory }));

				// Capture state when agents are spawned (they'll be executing)
				pool.on(PoolEvent.AGENT_SPAWNED, () => {
					stateSnapshots.push(pool.getState());
				});

				await pool.execute("Write a simple greeting function in TypeScript");

				// We should have captured at least one state snapshot during execution
				expect(stateSnapshots.length).toBeGreaterThanOrEqual(1);

				const midExecutionState = stateSnapshots[0]!;
				expect(midExecutionState.executing).toBe(true);
				expect(midExecutionState.currentTask).toContain("greeting");
				expect(midExecutionState.strategy).toBeDefined();
				expect(midExecutionState.activeAgentCount).toBeGreaterThanOrEqual(1);
				expect(midExecutionState.agents.length).toBeGreaterThanOrEqual(1);

				// After execution, state should be back to idle
				const finalState = pool.getState();
				expect(finalState.executing).toBe(false);
				expect(finalState.currentTask).toBeNull();
				expect(finalState.activeAgentCount).toBe(0);
			},
			E2E_TIMEOUT_MS,
		);

		it(
			"send with status_query intent returns a response (string or result)",
			async () => {
				const tracker = trackingAgentFactory();
				pool = new AgentPool(e2ePoolConfig({ createAgent: tracker.factory }));

				// The LLM intent analyzer may classify this as status_query or new_task.
				// Both are valid outcomes — we just verify the pool processes it without error.
				const response = await pool.send("status");

				expect(response).toBeDefined();

				if (typeof response === "string") {
					// Classified as status_query — should mention idle or no task
					expect(response.length).toBeGreaterThan(0);
				} else {
					// Classified as new_task — should return a valid result
					expect(isPoolResult(response)).toBe(true);
				}
			},
			E2E_TIMEOUT_MS,
		);

		it("getState provides accurate status information directly (no LLM)", () => {
			const tracker = trackingAgentFactory();
			pool = new AgentPool(e2ePoolConfig({ createAgent: tracker.factory }));

			const state = pool.getState();

			// Direct API call — no LLM involved, fully deterministic
			expect(state.executing).toBe(false);
			expect(state.currentTask).toBeNull();
			expect(state.activeAgentCount).toBe(0);
			expect(state.agents).toEqual([]);
		});
	});

	// ── 4. Send Message & Intent Routing ──────────────────────────────

	describe("send message and intent routing", () => {
		it(
			"send with a task description triggers execution and returns a result",
			async () => {
				const tracker = trackingAgentFactory();
				pool = new AgentPool(e2ePoolConfig({ createAgent: tracker.factory }));

				const result = await pool.send(
					"Please create a utility function that formats dates in ISO format",
				);

				// The LLM should classify this as new_task and return an AgentPoolResult.
				// In rare cases it may return a string — both are acceptable from the
				// intent routing pipeline.
				expect(result).toBeDefined();

				if (isPoolResult(result)) {
					expect(result.task).toBeDefined();
					expect(result.strategy).toBeDefined();
					expect(result.agents.length).toBeGreaterThanOrEqual(1);
					expect(result.summary.length).toBeGreaterThan(0);

					// Agents should have been spawned and executed
					expect(tracker.agents.length).toBeGreaterThanOrEqual(1);
					expect(tracker.promptCalls.length).toBeGreaterThanOrEqual(1);
				} else {
					// Still a valid routing outcome — the pool processed the message
					expect(typeof result).toBe("string");
					expect((result as string).length).toBeGreaterThan(0);
				}
			},
			E2E_TIMEOUT_MS,
		);

		it("setNotificationPreference directly enables notifications (deterministic)", () => {
			const tracker = trackingAgentFactory();
			pool = new AgentPool(e2ePoolConfig({ createAgent: tracker.factory }));

			expect(pool.getState().notificationsEnabled).toBe(false);

			pool.setNotificationPreference({
				enabled: true,
				minSignificance: 0.6,
			});

			expect(pool.getState().notificationsEnabled).toBe(true);
		});

		it(
			"send routes messages through the intent analysis pipeline",
			async () => {
				const tracker = trackingAgentFactory();
				pool = new AgentPool(e2ePoolConfig({ createAgent: tracker.factory }));

				// Send a notification preference message via the LLM pipeline
				const response = await pool.send(
					"Enable notifications. Notify me of all important changes.",
				);

				// The intent analyzer may classify this as notification_preference
				// or as a new_task — both are valid pipeline outcomes.
				expect(response).toBeDefined();

				// Regardless of classification, the pool should not have thrown
				if (
					typeof response === "string" &&
					response.toLowerCase().includes("notif")
				) {
					expect(pool.getState().notificationsEnabled).toBe(true);
				}
			},
			E2E_TIMEOUT_MS,
		);

		it(
			"send with cancel-like message when idle returns a response",
			async () => {
				const tracker = trackingAgentFactory();
				pool = new AgentPool(e2ePoolConfig({ createAgent: tracker.factory }));

				const response = await pool.send("Cancel everything, stop all agents");

				// Whether classified as cancel, unknown, or even new_task,
				// the pool must return a valid response without throwing.
				expect(response).toBeDefined();

				if (typeof response === "string") {
					expect(response.length).toBeGreaterThan(0);
				} else {
					expect(isPoolResult(response)).toBe(true);
				}
			},
			E2E_TIMEOUT_MS,
		);
	});

	// ── 5. Context Injection ──────────────────────────────────────────

	describe("context injection", () => {
		it(
			"can interact with the pool and query state during execution",
			async () => {
				const contextInjections: string[] = [];

				// Create agents that track context injections with a delay
				// so we have time to inspect mid-execution state
				const tracker = trackingAgentFactory({ promptDelay: 300 });
				const originalFactory = tracker.factory;
				const wrappedFactory = (config?: { name?: string }) => {
					const agent = originalFactory(config);
					const originalInjectContext = agent.injectContext;
					(agent as any).injectContext = (instructions: string) => {
						contextInjections.push(instructions);
						return originalInjectContext.call(agent, instructions);
					};
					return agent;
				};

				pool = new AgentPool(e2ePoolConfig({ createAgent: wrappedFactory }));

				// Start a task
				const executePromise = pool.execute(
					"Write a simple calculator module in TypeScript",
				);

				// Wait for agents to be spawned
				await new Promise<void>((resolve) => {
					pool.once(PoolEvent.AGENT_SPAWNED, () => {
						// Small delay to ensure agent is in managed agents map
						setTimeout(resolve, 50);
					});
				});

				// Query state mid-execution — this is the core assertion:
				// the pool must remain responsive while agents are running
				const midState = pool.getState();
				expect(midState.executing).toBe(true);
				expect(midState.activeAgentCount).toBeGreaterThanOrEqual(1);
				expect(midState.currentTask).toContain("calculator");
				expect(midState.agents.length).toBeGreaterThanOrEqual(1);

				// Verify each agent has a role assigned by the planner
				for (const agent of midState.agents) {
					expect(agent.agentId).toBeDefined();
					expect(agent.agentName.length).toBeGreaterThan(0);
					expect(agent.taskRole.length).toBeGreaterThan(0);
				}

				// Wait for execution to complete
				const result = await executePromise;
				expect(result.agents.length).toBeGreaterThanOrEqual(1);
				expect(result.agents.every((a) => a.success)).toBe(true);
			},
			E2E_TIMEOUT_MS,
		);
	});

	// ── 6. Notification Preferences ───────────────────────────────────

	describe("notification preferences", () => {
		it(
			"setNotificationPreference enables notifications and execution tracks deltas",
			async () => {
				const tracker = trackingAgentFactory();
				pool = new AgentPool(e2ePoolConfig({ createAgent: tracker.factory }));

				// Enable notifications before execution
				pool.setNotificationPreference({
					enabled: true,
					minSignificance: 0.3,
				});

				expect(pool.getState().notificationsEnabled).toBe(true);

				const deltaEvents = collectPoolEvents(pool, PoolEvent.DELTA_DETECTED);

				const result = await pool.execute("Create a simple hello world script");

				expect(result).toBeDefined();
				expect(result.agents.length).toBeGreaterThanOrEqual(1);

				// Deltas should have been detected from agent activity
				// (mock agents emit AGENT_BUSY, PROMPT_COMPLETE, AGENT_IDLE events)
				expect(deltaEvents.length).toBeGreaterThanOrEqual(1);
			},
			E2E_TIMEOUT_MS,
		);
	});

	// ── 7. Sequential Executions ──────────────────────────────────────

	describe("sequential task execution", () => {
		it(
			"can execute multiple tasks in sequence, cleaning up between them",
			async () => {
				const tracker = trackingAgentFactory();
				pool = new AgentPool(e2ePoolConfig({ createAgent: tracker.factory }));

				// First task
				const result1 = await pool.execute("Create a README.md file");
				expect(result1.agents.length).toBeGreaterThanOrEqual(1);
				expect(result1.agents.every((a) => a.success)).toBe(true);

				// Pool should be idle and cleaned up after first task
				const midState = pool.getState();
				expect(midState.executing).toBe(false);
				expect(midState.currentTask).toBeNull();
				expect(midState.activeAgentCount).toBe(0);

				// Second task on the same pool instance
				const result2 = await pool.execute("Add a LICENSE file");
				expect(result2.agents.length).toBeGreaterThanOrEqual(1);
				expect(result2.agents.every((a) => a.success)).toBe(true);

				// Both tasks should have spawned agents
				// (agents from first task are destroyed, new ones spawned for second)
				expect(tracker.promptCalls.length).toBeGreaterThanOrEqual(2);
			},
			E2E_TIMEOUT_MS * 2,
		);

		it(
			"rejects concurrent execute() calls",
			async () => {
				const tracker = trackingAgentFactory({ promptDelay: 500 });
				pool = new AgentPool(e2ePoolConfig({ createAgent: tracker.factory }));

				// Register the listener BEFORE calling execute, because
				// PLANNING_START is emitted synchronously inside execute()
				// before the first async LLM call. If we register after,
				// the event has already fired and the promise hangs forever.
				const planningStarted = new Promise<void>((resolve) => {
					pool.once(PoolEvent.PLANNING_START, () => resolve());
				});

				// Start first task (don't await)
				const first = pool.execute("First task");

				// Wait for planning to start so we're truly mid-execution
				await planningStarted;

				// Second call should throw
				await expect(pool.execute("Second task")).rejects.toThrow(
					/already executing/,
				);

				// Wait for first task to complete
				await first;
			},
			E2E_TIMEOUT_MS,
		);
	});

	// ── 8. Error Handling ─────────────────────────────────────────────

	describe("error handling", () => {
		it(
			"handles agent prompt failures gracefully",
			async () => {
				const factory = (config?: { name?: string }) => {
					return createMockAgent({
						name: config?.name ?? "FailingAgent",
						promptError: new Error("Simulated prompt failure"),
					});
				};

				pool = new AgentPool(e2ePoolConfig({ createAgent: factory }));

				const errorEvents = collectPoolEvents(pool, PoolEvent.AGENT_ERROR);

				const result = await pool.execute("Do a simple task that will fail");

				// Execution should complete (not throw) even with agent failures
				expect(result).toBeDefined();
				expect(result.agents.length).toBeGreaterThanOrEqual(1);

				// At least one agent should have failed
				const failedAgents = result.agents.filter((a) => !a.success);
				expect(failedAgents.length).toBeGreaterThanOrEqual(1);
				expect(failedAgents[0]!.error).toContain("Simulated prompt failure");

				// Error events should have been emitted
				expect(errorEvents.length).toBeGreaterThanOrEqual(1);
			},
			E2E_TIMEOUT_MS,
		);

		it(
			"handles agent initialization failures gracefully",
			async () => {
				const factory = (config?: { name?: string }) => {
					return createMockAgent({
						name: config?.name ?? "FailInitAgent",
						readyError: new Error("Simulated init failure"),
					});
				};

				pool = new AgentPool(e2ePoolConfig({ createAgent: factory }));

				const result = await pool.execute(
					"Do a task where the agent fails to initialize",
				);

				// Execution should complete without throwing
				expect(result).toBeDefined();

				// Agents should have failed with init errors
				const failedAgents = result.agents.filter((a) => !a.success);
				expect(failedAgents.length).toBeGreaterThanOrEqual(1);
			},
			E2E_TIMEOUT_MS,
		);

		it("throws when calling execute after destroy", async () => {
			const tracker = trackingAgentFactory();
			pool = new AgentPool(e2ePoolConfig({ createAgent: tracker.factory }));

			await pool.destroy();

			await expect(pool.execute("This should fail")).rejects.toThrow(
				/destroyed/,
			);
		});

		it("throws when calling send after destroy", async () => {
			const tracker = trackingAgentFactory();
			pool = new AgentPool(e2ePoolConfig({ createAgent: tracker.factory }));

			await pool.destroy();

			await expect(pool.send("This should also fail")).rejects.toThrow(
				/destroyed/,
			);
		});
	});

	// ── 9. Event-Driven Monitoring ────────────────────────────────────

	describe("event-driven monitoring", () => {
		it(
			"emits a full lifecycle event sequence during execution",
			async () => {
				const tracker = trackingAgentFactory();
				pool = new AgentPool(e2ePoolConfig({ createAgent: tracker.factory }));

				const eventLog: string[] = [];

				pool.on(PoolEvent.TASK_RECEIVED, () => eventLog.push("task_received"));
				pool.on(PoolEvent.PLANNING_START, () =>
					eventLog.push("planning_start"),
				);
				pool.on(PoolEvent.PLANNING_COMPLETE, () =>
					eventLog.push("planning_complete"),
				);
				pool.on(PoolEvent.AGENT_SPAWNED, () => eventLog.push("agent_spawned"));
				pool.on(PoolEvent.AGENT_COMPLETED, () =>
					eventLog.push("agent_completed"),
				);
				pool.on(PoolEvent.EXECUTION_COMPLETE, () =>
					eventLog.push("execution_complete"),
				);
				pool.on(PoolEvent.DELTA_DETECTED, () =>
					eventLog.push("delta_detected"),
				);

				await pool.execute("Write a function that adds two numbers");

				// Verify the canonical event ordering
				expect(eventLog.indexOf("task_received")).toBe(0);
				expect(eventLog.indexOf("planning_start")).toBe(1);
				expect(eventLog.indexOf("planning_complete")).toBe(2);
				expect(eventLog.indexOf("agent_spawned")).toBeGreaterThan(2);

				// Completed and execution_complete should come after spawned
				const spawnedIdx = eventLog.indexOf("agent_spawned");
				const completedIdx = eventLog.indexOf("agent_completed");
				const executionCompleteIdx = eventLog.indexOf("execution_complete");

				expect(completedIdx).toBeGreaterThan(spawnedIdx);
				expect(executionCompleteIdx).toBeGreaterThan(completedIdx);

				// Delta events should have been fired (from mock agent events)
				expect(
					eventLog.filter((e) => e === "delta_detected").length,
				).toBeGreaterThanOrEqual(1);
			},
			E2E_TIMEOUT_MS,
		);

		it(
			"all pool events include timestamp and event type",
			async () => {
				const tracker = trackingAgentFactory();
				pool = new AgentPool(e2ePoolConfig({ createAgent: tracker.factory }));

				const allEvents: Array<{ event: string; timestamp: string }> = [];

				for (const eventType of Object.values(PoolEvent)) {
					pool.on(eventType, ((payload: any) => {
						allEvents.push({
							event: payload.event,
							timestamp: payload.timestamp,
						});
					}) as any);
				}

				await pool.execute("Create a config file");

				expect(allEvents.length).toBeGreaterThan(0);

				for (const evt of allEvents) {
					expect(evt.event).toBeDefined();
					expect(typeof evt.event).toBe("string");
					expect(evt.timestamp).toBeDefined();
					expect(typeof evt.timestamp).toBe("string");
					// Timestamp should be ISO 8601
					expect(new Date(evt.timestamp).toISOString()).toBeTruthy();
				}
			},
			E2E_TIMEOUT_MS,
		);
	});

	// ── 10. Full Pipeline: Execute → Query → Modify → Re-Execute ─────

	describe("full pipeline integration", () => {
		it(
			"executes a task, queries status, modifies preferences, then executes another task",
			async () => {
				const tracker = trackingAgentFactory();
				pool = new AgentPool(e2ePoolConfig({ createAgent: tracker.factory }));

				// ── Step 1: Execute initial task ─────────────────────────
				const result1 = await pool.execute(
					"Create a utility module for string manipulation",
				);

				expect(result1).toBeDefined();
				expect(result1.agents.every((a) => a.success)).toBe(true);

				// ── Step 2: Query status (should be idle) ────────────────
				const stateAfterFirst = pool.getState();
				expect(stateAfterFirst.executing).toBe(false);
				expect(stateAfterFirst.activeAgentCount).toBe(0);

				// ── Step 3: Modify notification preference ───────────────
				pool.setNotificationPreference({
					enabled: true,
					minSignificance: 0.5,
				});
				expect(pool.getState().notificationsEnabled).toBe(true);

				// ── Step 4: Execute a follow-up task with notifications on ──
				const deltaEvents = collectPoolEvents(pool, PoolEvent.DELTA_DETECTED);

				const result2 = await pool.execute(
					"Add unit tests for the string manipulation module",
				);

				expect(result2).toBeDefined();
				expect(result2.agents.every((a) => a.success)).toBe(true);

				// Deltas should have been tracked
				expect(deltaEvents.length).toBeGreaterThanOrEqual(1);

				// ── Step 5: Verify the pool is reusable ──────────────────
				const finalState = pool.getState();
				expect(finalState.executing).toBe(false);
				expect(finalState.notificationsEnabled).toBe(true);

				// Total agents spawned should be >= 2 (at least 1 per task)
				expect(tracker.agents.length).toBeGreaterThanOrEqual(2);
			},
			E2E_TIMEOUT_MS * 2,
		);

		it(
			"uses send() to drive a multi-step workflow with mixed intents",
			async () => {
				const tracker = trackingAgentFactory();
				pool = new AgentPool(e2ePoolConfig({ createAgent: tracker.factory }));

				// ── Step 1: Send a task via send() ───────────────────────
				const taskResult = await pool.send("Create a simple logging utility");

				// The LLM may classify this as new_task (AgentPoolResult) or
				// route it differently (string). Both are valid.
				expect(taskResult).toBeDefined();
				if (isPoolResult(taskResult)) {
					expect(taskResult.agents.length).toBeGreaterThanOrEqual(1);
				}

				// ── Step 2: Query status via send() ──────────────────────
				const statusResponse = await pool.send("status");

				// May return a string (status_query) or AgentPoolResult (new_task)
				expect(statusResponse).toBeDefined();

				// ── Step 3: Enable notifications directly (deterministic) ─
				pool.setNotificationPreference({
					enabled: true,
					minSignificance: 0.5,
				});
				expect(pool.getState().notificationsEnabled).toBe(true);

				// ── Step 4: Destroy and verify ───────────────────────────
				await pool.destroy();

				await expect(
					pool.send("This should fail after destroy"),
				).rejects.toThrow(/destroyed/);
			},
			E2E_TIMEOUT_MS * 2,
		);
	});
});
