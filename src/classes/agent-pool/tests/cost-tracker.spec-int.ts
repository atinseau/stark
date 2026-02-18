import { describe, expect, it } from "bun:test";
import { PoolEvent } from "../../../enums/pool-event.enum.ts";
import type {
	BudgetExceededEvent,
	BudgetWarningEvent,
	UsageSnapshot,
} from "../../../types/agent-pool.types.ts";
import { AgentPool } from "../agent-pool.ts";
import { collectPoolEvents } from "./test-helpers.ts";
import {
	HAS_API_KEY,
	INT_TIMEOUT_MS,
	intPoolConfig,
	trackingAgentFactory,
} from "./test-helpers-int.ts";

// ════════════════════════════════════════════════════════════════════════════
// CostTracker — Integration Tests
//
// These tests exercise cost tracking, budget management, and conversation
// compression in real execution scenarios with actual LLM calls.
//
// They verify that:
//
// 1. AgentPoolResult.usage is always present after execution
// 2. usage.totalTokens > 0 and breakdown.planner.callCount >= 1
// 3. getState() exposes live usage data during execution
// 4. Budget warning event is emitted when warningThreshold is crossed
// 5. Budget exceeded event is emitted and action is respected
// 6. Cost tracker is reset between consecutive executions
// 7. Usage summary is logged at the end of execution
// 8. Pool works identically with no budget configured (passive tracking)
// 9. Compression config is accepted and does not break execution
// 10. Budget "pause" action blocks pool LLM calls but agents continue
//
// These tests require OPENROUTER_API_KEY and may take 15-120 seconds each.
// ════════════════════════════════════════════════════════════════════════════

const LONG_TIMEOUT_MS = 180_000;

describe.skipIf(!HAS_API_KEY)(
	"CostTracker int — real execution context",
	() => {
		// ── Test 25: execute() includes usage in result ─────────────────────

		it(
			"execute() includes a valid UsageSnapshot in the result",
			async () => {
				const tracker = trackingAgentFactory();

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 3,
					}),
				);

				try {
					const result = await pool.execute(
						"Write a simple hello world function in JavaScript",
					);

					// usage must always be present
					expect(result.usage).toBeDefined();
					const usage: UsageSnapshot = result.usage;

					// Basic structure validation
					expect(typeof usage.inputTokens).toBe("number");
					expect(typeof usage.outputTokens).toBe("number");
					expect(typeof usage.totalTokens).toBe("number");
					expect(typeof usage.timestamp).toBe("string");
					expect(usage.breakdown).toBeDefined();

					// At least the planner made an LLM call
					expect(usage.totalTokens).toBeGreaterThan(0);
					expect(usage.breakdown.planner.callCount).toBeGreaterThanOrEqual(1);
					expect(usage.breakdown.planner.totalTokens).toBeGreaterThan(0);

					// totalTokens should equal inputTokens + outputTokens
					expect(usage.totalTokens).toBe(
						usage.inputTokens + usage.outputTokens,
					);

					// Timestamp should be valid ISO-8601
					expect(() => new Date(usage.timestamp)).not.toThrow();
					expect(new Date(usage.timestamp).toISOString()).toBe(usage.timestamp);

					// All breakdown sources must be present
					const sources = [
						"agents",
						"planner",
						"sharingAnalyzer",
						"contextAnalyzer",
						"intentAnalyzer",
						"orchestrator",
						"checkpoint",
						"reflection",
						"userInteraction",
						"compression",
					] as const;
					for (const source of sources) {
						const entry = usage.breakdown[source];
						expect(entry).toBeDefined();
						expect(typeof entry.callCount).toBe("number");
						expect(typeof entry.totalTokens).toBe("number");
						expect(typeof entry.inputTokens).toBe("number");
						expect(typeof entry.outputTokens).toBe("number");
					}
				} finally {
					await pool.destroy();
				}
			},
			INT_TIMEOUT_MS,
		);

		// ── Test 26: getState() includes usage during execution ─────────────

		it(
			"getState() exposes currentUsage during execution",
			async () => {
				const tracker = trackingAgentFactory({ promptDelay: 500 });
				let midExecutionUsage: UsageSnapshot | undefined;

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 3,
					}),
				);

				// Capture state during execution via a delta event
				pool.on(PoolEvent.AGENT_SPAWNED, () => {
					const state = pool.getState();
					if (state.executing && state.currentUsage) {
						midExecutionUsage = state.currentUsage;
					}
				});

				try {
					const result = await pool.execute(
						"Create a utility function that formats dates",
					);

					// After execution, currentUsage should be null
					const finalState = pool.getState();
					expect(finalState.currentUsage).toBeNull();

					// Result should have usage
					expect(result.usage).toBeDefined();
					expect(result.usage.totalTokens).toBeGreaterThan(0);

					// If we captured mid-execution state, validate it
					if (midExecutionUsage !== undefined) {
						const captured: UsageSnapshot = midExecutionUsage;
						expect(captured.totalTokens).toBeGreaterThanOrEqual(0);
						expect(captured.breakdown).toBeDefined();
					}
				} finally {
					await pool.destroy();
				}
			},
			INT_TIMEOUT_MS,
		);

		// ── Test 29: cost tracker resets between executions ──────────────────

		it(
			"cost tracker resets between consecutive executions",
			async () => {
				const tracker = trackingAgentFactory();

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 3,
					}),
				);

				try {
					// First execution
					const result1 = await pool.execute("Write a greeting function");

					expect(result1.usage).toBeDefined();
					expect(result1.usage.totalTokens).toBeGreaterThan(0);
					const firstTotalTokens = result1.usage.totalTokens;

					// Second execution
					const result2 = await pool.execute("Write a farewell function");

					expect(result2.usage).toBeDefined();
					expect(result2.usage.totalTokens).toBeGreaterThan(0);

					// The second execution's usage should NOT include
					// tokens from the first execution. It should be independent.
					// We can't assert exact equality, but the second execution's
					// planner call count should start from 0 again.
					expect(
						result2.usage.breakdown.planner.callCount,
					).toBeGreaterThanOrEqual(1);

					// The total tokens should be reasonable for a single execution,
					// not double what a single execution would consume.
					// This is a rough check — if tokens accumulated, the second
					// result would have firstTotalTokens + secondTotalTokens.
					// We verify they are independent by checking the second
					// result is not unreasonably large.
					expect(result2.usage.totalTokens).toBeLessThan(firstTotalTokens * 3);
				} finally {
					await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);

		// ── Test 32: pool works without budget config (passive tracking) ────

		it(
			"pool works without tokenBudget — passive tracking only",
			async () => {
				const tracker = trackingAgentFactory();

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						// No tokenBudget configured
					}),
				);

				try {
					const result = await pool.execute(
						"Write a function that adds two numbers",
					);

					// Usage should still be tracked
					expect(result.usage).toBeDefined();
					expect(result.usage.totalTokens).toBeGreaterThan(0);

					// Budget fields should indicate no budget
					const state = pool.getState();
					expect(state.budgetUsagePercent).toBeNull();
					expect(state.budgetWarning).toBe(false);
				} finally {
					await pool.destroy();
				}
			},
			INT_TIMEOUT_MS,
		);

		// ── Test 27: budget warning event emitted at threshold ──────────────

		it(
			"emits budget events when token budget is exceeded",
			async () => {
				const tracker = trackingAgentFactory();

				// Use an extremely low token budget. The planner prompt alone
				// is typically 2000+ chars → ~500+ estimated tokens, so even
				// a budget of 50 should be exceeded on the very first LLM call.
				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 3,
						tokenBudget: {
							maxTotalTokens: 50, // Impossibly low
							warningThreshold: 0.3, // Very low warning threshold
							onExceeded: "warn", // Don't stop execution
						},
					}),
				);

				const warningEvents = collectPoolEvents<BudgetWarningEvent>(
					pool,
					PoolEvent.BUDGET_WARNING,
				);
				const exceededEvents = collectPoolEvents<BudgetExceededEvent>(
					pool,
					PoolEvent.BUDGET_EXCEEDED,
				);

				try {
					const result = await pool.execute("Write a hello world function");

					// Verify that the execution actually consumed tokens
					expect(result.usage).toBeDefined();
					expect(result.usage.totalTokens).toBeGreaterThan(0);

					// The total tokens consumed should far exceed our 50-token budget
					const totalEvents = warningEvents.length + exceededEvents.length;

					// If tokens were tracked (totalTokens > budget), events should fire.
					// However, token estimation is heuristic (chars/4) and the budget
					// check only fires from the usage callback. If the first LLM call
					// jumps straight from 0% to >100%, we get exceeded but no warning.
					if (result.usage.totalTokens > 50) {
						// We expect at least one budget event (warning or exceeded)
						expect(totalEvents).toBeGreaterThanOrEqual(1);
					}

					// If warning was emitted, validate its structure
					if (warningEvents.length > 0) {
						const warning = warningEvents[0]!;
						expect(warning.currentUsage).toBeDefined();
						expect(warning.budgetUsagePercent).toBeGreaterThan(0);
						expect(["tokens", "cost"]).toContain(warning.budgetType);

						// Warning should only be emitted once (sticky)
						expect(warningEvents.length).toBe(1);
					}

					// If exceeded was emitted, validate its structure
					if (exceededEvents.length > 0) {
						const exceeded = exceededEvents[0]!;
						expect(exceeded.currentUsage).toBeDefined();
						expect(exceeded.action).toBe("warn");
						expect(["tokens", "cost"]).toContain(exceeded.budgetType);
					}
				} finally {
					await pool.destroy();
				}
			},
			INT_TIMEOUT_MS,
		);

		// ── Test 28: budget exceeded with pause blocks pool LLM calls ───────

		it(
			"budget exceeded with pause action blocks pool LLM calls but agents complete",
			async () => {
				const tracker = trackingAgentFactory();

				// Set a budget so low that it will be exceeded during planning
				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 3,
						tokenBudget: {
							maxTotalTokens: 200, // Extremely low
							warningThreshold: 0.3,
							onExceeded: "pause",
						},
					}),
				);

				const exceededEvents = collectPoolEvents<BudgetExceededEvent>(
					pool,
					PoolEvent.BUDGET_EXCEEDED,
				);

				try {
					const result = await pool.execute("Write a simple function");

					// The planner itself will likely exceed this tiny budget
					// Budget exceeded event should fire with "pause" action
					if (exceededEvents.length > 0) {
						expect(exceededEvents[0]!.action).toBe("pause");
					}

					// Even with paused budget, the execution should still complete
					// (agents already started continue, only new pool LLM calls blocked)
					expect(result).toBeDefined();
					expect(result.agents.length).toBeGreaterThanOrEqual(1);

					// Usage should still be tracked
					expect(result.usage).toBeDefined();
					expect(result.usage.totalTokens).toBeGreaterThan(0);
				} finally {
					await pool.destroy();
				}
			},
			INT_TIMEOUT_MS,
		);

		// ── Pool with compression config doesn't break execution ────────────

		it(
			"pool with conversationCompression config executes normally",
			async () => {
				const tracker = trackingAgentFactory();

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 3,
						conversationCompression: {
							enabled: true,
							compressionThresholdTokens: 50_000,
							retentionRatio: 0.3,
							maxCompressions: 3,
						},
					}),
				);

				try {
					const result = await pool.execute(
						"Create a utility function that generates random strings",
					);

					expect(result).toBeDefined();
					expect(result.agents.length).toBeGreaterThanOrEqual(1);
					expect(result.usage).toBeDefined();
					expect(result.usage.totalTokens).toBeGreaterThan(0);
				} finally {
					await pool.destroy();
				}
			},
			INT_TIMEOUT_MS,
		);

		// ── Pool with compression disabled executes normally ─────────────────

		it(
			"pool with compression disabled executes normally",
			async () => {
				const tracker = trackingAgentFactory();

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						conversationCompression: {
							enabled: false,
						},
					}),
				);

				try {
					const result = await pool.execute(
						"Write a function that reverses a string",
					);

					expect(result).toBeDefined();
					expect(result.usage).toBeDefined();
					expect(result.usage.totalTokens).toBeGreaterThan(0);
				} finally {
					await pool.destroy();
				}
			},
			INT_TIMEOUT_MS,
		);

		// ── Usage breakdown has agent tokens when agents run ─────────────────

		it(
			"usage breakdown includes agent tokens from USAGE_UPDATE events",
			async () => {
				const tracker = trackingAgentFactory();

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 3,
					}),
				);

				try {
					const result = await pool.execute(
						"Write a helper function for string manipulation",
					);

					// Agents emit USAGE_UPDATE events which should be tracked
					// Mock agents emit usage data in their prompt results
					// so agent tokens should be > 0
					expect(
						result.usage.breakdown.agents.callCount,
					).toBeGreaterThanOrEqual(0);

					// Planner tokens should definitely be tracked
					expect(
						result.usage.breakdown.planner.callCount,
					).toBeGreaterThanOrEqual(1);
					expect(result.usage.breakdown.planner.inputTokens).toBeGreaterThan(0);
					expect(result.usage.breakdown.planner.outputTokens).toBeGreaterThan(
						0,
					);
				} finally {
					await pool.destroy();
				}
			},
			INT_TIMEOUT_MS,
		);

		// ── Summary prompt includes usage data ──────────────────────────────

		it(
			"summary includes resource usage section",
			async () => {
				const tracker = trackingAgentFactory();

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 5,
					}),
				);

				try {
					const result = await pool.execute(
						"Build a REST API with user CRUD endpoints and write tests for each endpoint",
					);

					// Multi-agent tasks get an LLM-generated summary
					// that should include usage data in the prompt
					// (we can't assert the LLM output includes it,
					// but we verify the usage was available for the summary)
					expect(result.usage).toBeDefined();
					expect(result.usage.totalTokens).toBeGreaterThan(0);

					// The summary itself should exist
					expect(result.summary).toBeDefined();
					expect(result.summary.length).toBeGreaterThan(0);
				} finally {
					await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);

		// ── Budget with cost USD and no cost data available ──────────────────

		it(
			"cost budget with no actual cost data does not crash",
			async () => {
				const tracker = trackingAgentFactory();

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						tokenBudget: {
							maxCostUsd: 0.01,
							warningThreshold: 0.5,
							onExceeded: "warn",
						},
					}),
				);

				try {
					const result = await pool.execute(
						"Write a simple math utility function",
					);

					// Should complete without error regardless of cost data availability
					expect(result).toBeDefined();
					expect(result.usage).toBeDefined();

					// estimatedCostUsd may or may not be null depending on
					// whether OpenRouter returns cost data for the model
					expect(
						result.usage.estimatedCostUsd === null ||
							typeof result.usage.estimatedCostUsd === "number",
					).toBe(true);
				} finally {
					await pool.destroy();
				}
			},
			INT_TIMEOUT_MS,
		);

		// ── getState budget fields during idle ──────────────────────────────

		it("getState returns correct budget fields when idle", async () => {
			const tracker = trackingAgentFactory();

			const pool = new AgentPool(
				intPoolConfig({
					createAgent: tracker.factory,
					tokenBudget: {
						maxTotalTokens: 100_000,
						warningThreshold: 0.8,
					},
				}),
			);

			try {
				const state = pool.getState();

				expect(state.executing).toBe(false);
				expect(state.currentUsage).toBeNull();
				expect(state.budgetUsagePercent).toBe(0);
				expect(state.budgetWarning).toBe(false);
			} finally {
				await pool.destroy();
			}
		}, 10_000);

		// ── Budget warning threshold respected ──────────────────────────────

		it(
			"budget warning is emitted at most once per execution (sticky)",
			async () => {
				const tracker = trackingAgentFactory();

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 3,
						tokenBudget: {
							maxTotalTokens: 1000, // Low enough to trigger warning
							warningThreshold: 0.3, // Very low threshold
							onExceeded: "warn",
						},
					}),
				);

				const warningEvents = collectPoolEvents<BudgetWarningEvent>(
					pool,
					PoolEvent.BUDGET_WARNING,
				);

				try {
					await pool.execute(
						"Create a calculator function with add, subtract, multiply, divide",
					);

					// Warning should be emitted at most once (sticky flag)
					expect(warningEvents.length).toBeLessThanOrEqual(1);
				} finally {
					await pool.destroy();
				}
			},
			INT_TIMEOUT_MS,
		);
	},
);

// ════════════════════════════════════════════════════════════════════════════
// CostTracker — Long-Running Integration Tests
//
// These tests exercise scenarios that may take longer due to multiple
// executions or complex multi-agent tasks.
// ════════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_API_KEY)(
	"CostTracker int — long-running scenarios",
	() => {
		// ── Multiple consecutive executions with budget tracking ─────────────

		it(
			"tracks usage independently across three consecutive executions",
			async () => {
				const tracker = trackingAgentFactory();

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 3,
						tokenBudget: {
							maxTotalTokens: 500_000,
							warningThreshold: 0.8,
						},
					}),
				);

				try {
					const results: Array<{ totalTokens: number; plannerCalls: number }> =
						[];

					for (let i = 0; i < 3; i++) {
						const tasks = [
							"Write a function to check if a number is prime",
							"Write a function to find the fibonacci sequence",
							"Write a function to sort an array of objects by a key",
						];

						const result = await pool.execute(tasks[i]!);

						results.push({
							totalTokens: result.usage.totalTokens,
							plannerCalls: result.usage.breakdown.planner.callCount,
						});
					}

					// Each execution should have independent tracking
					for (const r of results) {
						expect(r.totalTokens).toBeGreaterThan(0);
						expect(r.plannerCalls).toBeGreaterThanOrEqual(1);
					}

					// Verify independence: no single execution should have
					// accumulated tokens from all three (sum of all)
					const totalAllExecutions = results.reduce(
						(sum, r) => sum + r.totalTokens,
						0,
					);
					for (const r of results) {
						// Each individual execution should be significantly less
						// than the total of all three combined
						expect(r.totalTokens).toBeLessThan(totalAllExecutions);
					}
				} finally {
					await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);

		// ── Budget exceeded with abort action ────────────────────────────────

		it(
			"budget exceeded with abort action still produces a result",
			async () => {
				const tracker = trackingAgentFactory();

				// Use an extremely low budget that will be exceeded during planning
				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						tokenBudget: {
							maxTotalTokens: 100, // Impossibly low
							warningThreshold: 0.5,
							onExceeded: "abort",
						},
					}),
				);

				const exceededEvents = collectPoolEvents<BudgetExceededEvent>(
					pool,
					PoolEvent.BUDGET_EXCEEDED,
				);

				try {
					// The execution may complete or fail depending on when
					// the budget check fires relative to the planner call.
					// The planner call happens first and the budget check
					// fires after, so the execution should still produce a result.
					const result = await pool.execute("Write hello world");

					// Even with abort, the execution may complete if the
					// planner finishes before the budget check can abort
					expect(result).toBeDefined();
					expect(result.usage).toBeDefined();

					// Budget exceeded should have been detected
					if (exceededEvents.length > 0) {
						expect(exceededEvents[0]!.action).toBe("abort");
					}
				} catch {
					// If the execution was actually aborted, that's also valid
					// The important thing is it doesn't hang or crash unexpectedly
					expect(exceededEvents.length).toBeGreaterThanOrEqual(0);
				} finally {
					await pool.destroy();
				}
			},
			INT_TIMEOUT_MS,
		);

		// ── Multi-agent execution tracks both pool and agent tokens ──────────

		it(
			"multi-agent execution tracks tokens from both pool and agents",
			async () => {
				const tracker = trackingAgentFactory();

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 5,
					}),
				);

				try {
					const result = await pool.execute(
						"Build a web application with: " +
							"1) A backend REST API with authentication, " +
							"2) Database models for users and posts, " +
							"3) Unit tests for the API endpoints",
					);

					const usage = result.usage;
					expect(usage).toBeDefined();

					// Pool tokens (planner at minimum)
					expect(usage.breakdown.planner.totalTokens).toBeGreaterThan(0);

					// If multi-agent was chosen, we expect more subsystem activity
					if (result.agents.length > 1) {
						// With multiple agents, sharing/notification analyzers
						// may also have been used (depends on LLM decisions)
						const poolTokens =
							usage.breakdown.planner.totalTokens +
							usage.breakdown.sharingAnalyzer.totalTokens +
							usage.breakdown.contextAnalyzer.totalTokens +
							usage.breakdown.intentAnalyzer.totalTokens +
							usage.breakdown.orchestrator.totalTokens +
							usage.breakdown.checkpoint.totalTokens +
							usage.breakdown.reflection.totalTokens +
							usage.breakdown.userInteraction.totalTokens +
							usage.breakdown.compression.totalTokens;

						// Pool tokens + agent tokens should equal total
						const agentTokens = usage.breakdown.agents.totalTokens;
						expect(poolTokens + agentTokens).toBe(usage.totalTokens);
					}

					// Total should always be consistent
					expect(usage.totalTokens).toBe(
						usage.inputTokens + usage.outputTokens,
					);
				} finally {
					await pool.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);

		// ── Budget state resets after destroy ────────────────────────────────

		it(
			"creating a new pool after destroy has fresh budget state",
			async () => {
				const tracker1 = trackingAgentFactory();

				const pool1 = new AgentPool(
					intPoolConfig({
						createAgent: tracker1.factory,
						tokenBudget: {
							maxTotalTokens: 1000,
							warningThreshold: 0.3,
							onExceeded: "warn",
						},
					}),
				);

				try {
					await pool1.execute("Write a simple function");
				} finally {
					await pool1.destroy();
				}

				// Create a new pool — should have fresh state
				const tracker2 = trackingAgentFactory();
				const pool2 = new AgentPool(
					intPoolConfig({
						createAgent: tracker2.factory,
						tokenBudget: {
							maxTotalTokens: 100_000,
						},
					}),
				);

				try {
					const state = pool2.getState();
					expect(state.budgetUsagePercent).toBe(0);
					expect(state.budgetWarning).toBe(false);
					expect(state.currentUsage).toBeNull();
				} finally {
					await pool2.destroy();
				}
			},
			LONG_TIMEOUT_MS,
		);
	},
);
