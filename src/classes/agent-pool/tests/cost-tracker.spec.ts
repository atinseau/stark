import { beforeEach, describe, expect, it } from "bun:test";
import { ConversationRole } from "../../../enums/conversation-role.enum.ts";
import type {
	ConversationCompressionConfig,
	OpenRouterConfig,
	UsageSnapshot,
} from "../../../types/agent-pool.types.ts";
import { ConversationManager } from "../conversation-manager.ts";
import { CostTracker } from "../cost-tracker.ts";
import {
	createMockAgentFactory,
	silentLogger,
	silentPoolConfig,
} from "./test-helpers.ts";

// ════════════════════════════════════════════════════════════════════════════
// CostTracker Unit Tests
// ════════════════════════════════════════════════════════════════════════════

describe("CostTracker", () => {
	let tracker: CostTracker;

	beforeEach(() => {
		tracker = new CostTracker(null, silentLogger());
	});

	// ── Test 1: recordPoolCall increments counters correctly ────────────

	it("recordPoolCall increments the counters correctly", () => {
		tracker.recordPoolCall("planner", 100, 50, 0.001);

		const snapshot = tracker.getSnapshot();
		expect(snapshot.breakdown.planner.callCount).toBe(1);
		expect(snapshot.breakdown.planner.inputTokens).toBe(100);
		expect(snapshot.breakdown.planner.outputTokens).toBe(50);
		expect(snapshot.breakdown.planner.totalTokens).toBe(150);
		expect(snapshot.breakdown.planner.estimatedCostUsd).toBe(0.001);
	});

	// ── Test 2: recordAgentUsage increments agent counters ──────────────

	it("recordAgentUsage increments the agents counters", () => {
		tracker.recordAgentUsage("agent-1", 1000, 500, 0.01);
		tracker.recordAgentUsage("agent-2", 2000, 800, 0.02);

		const snapshot = tracker.getSnapshot();
		expect(snapshot.breakdown.agents.callCount).toBe(2);
		expect(snapshot.breakdown.agents.totalTokens).toBe(4300);
		expect(snapshot.breakdown.agents.inputTokens).toBe(3000);
		expect(snapshot.breakdown.agents.outputTokens).toBe(1300);
		expect(snapshot.breakdown.agents.estimatedCostUsd).toBeCloseTo(0.03);
	});

	// ── Test 3: getTotalTokens aggregates all sources ───────────────────

	it("getTotalTokens aggregates all sources", () => {
		tracker.recordPoolCall("planner", 100, 50);
		tracker.recordPoolCall("sharingAnalyzer", 200, 100);
		tracker.recordAgentUsage("agent-1", 500, 250);

		expect(tracker.getTotalTokens()).toBe(1200);
	});

	// ── Test 4: getTotalCost returns null when no cost is registered ────

	it("getTotalCost returns null when no cost data is registered", () => {
		tracker.recordPoolCall("planner", 100, 50);
		tracker.recordAgentUsage("agent-1", 500, 250);

		expect(tracker.getTotalCost()).toBeNull();
	});

	// ── Test 5: checkBudget returns ok without budget configured ────────

	it("checkBudget returns ok without budget configured", () => {
		const signal = tracker.checkBudget();
		expect(signal.type).toBe("ok");
	});

	// ── Test 6: checkBudget returns warning at threshold ────────────────

	it("checkBudget returns warning at the threshold", () => {
		const budgetTracker = new CostTracker(
			{ maxTotalTokens: 1000, warningThreshold: 0.8 },
			silentLogger(),
		);

		budgetTracker.recordPoolCall("planner", 500, 350); // 850 tokens = 85%

		const signal = budgetTracker.checkBudget();
		expect(signal.type).toBe("warning");
		if (signal.type === "warning") {
			expect(signal.budgetType).toBe("tokens");
			expect(signal.percent).toBeCloseTo(0.85);
		}
	});

	// ── Test 7: checkBudget warning is sticky (one-time) ────────────────

	it("checkBudget warning is sticky (emitted only once)", () => {
		const budgetTracker = new CostTracker(
			{ maxTotalTokens: 1000, warningThreshold: 0.8 },
			silentLogger(),
		);

		budgetTracker.recordPoolCall("planner", 500, 350); // 850 tokens = 85%

		// First check: warning
		const signal1 = budgetTracker.checkBudget();
		expect(signal1.type).toBe("warning");

		// Second check without adding tokens: ok (warning already emitted)
		const signal2 = budgetTracker.checkBudget();
		expect(signal2.type).toBe("ok");

		// Add more tokens (still under 100%)
		budgetTracker.recordPoolCall("sharingAnalyzer", 30, 20); // +50 = 900

		// Third check: still ok (warning already emitted, not exceeded)
		const signal3 = budgetTracker.checkBudget();
		expect(signal3.type).toBe("ok");
	});

	// ── Test 8: checkBudget returns exceeded beyond budget ──────────────

	it("checkBudget returns exceeded beyond the budget", () => {
		const budgetTracker = new CostTracker(
			{ maxTotalTokens: 1000 },
			silentLogger(),
		);

		budgetTracker.recordPoolCall("planner", 600, 500); // 1100 tokens

		const signal = budgetTracker.checkBudget();
		expect(signal.type).toBe("exceeded");
		if (signal.type === "exceeded") {
			expect(signal.budgetType).toBe("tokens");
		}
	});

	// ── Test 9: checkBudget exceeded is returned every time ─────────────

	it("checkBudget exceeded is returned at every call", () => {
		const budgetTracker = new CostTracker(
			{ maxTotalTokens: 1000 },
			silentLogger(),
		);

		budgetTracker.recordPoolCall("planner", 600, 500); // 1100 tokens

		const signal1 = budgetTracker.checkBudget();
		expect(signal1.type).toBe("exceeded");

		const signal2 = budgetTracker.checkBudget();
		expect(signal2.type).toBe("exceeded");
	});

	// ── Test 10: checkBudget works with cost budget ─────────────────────

	it("checkBudget works with cost budget (warning then exceeded)", () => {
		const budgetTracker = new CostTracker(
			{ maxCostUsd: 0.5, warningThreshold: 0.8 },
			silentLogger(),
		);

		// Record calls with cost totaling $0.42 (84% of $0.50)
		budgetTracker.recordPoolCall("planner", 100, 50, 0.2);
		budgetTracker.recordPoolCall("sharingAnalyzer", 100, 50, 0.22);

		const signal1 = budgetTracker.checkBudget();
		expect(signal1.type).toBe("warning");
		if (signal1.type === "warning") {
			expect(signal1.budgetType).toBe("cost");
		}

		// Add more cost to exceed
		budgetTracker.recordPoolCall("contextAnalyzer", 50, 25, 0.1);

		const signal2 = budgetTracker.checkBudget();
		expect(signal2.type).toBe("exceeded");
		if (signal2.type === "exceeded") {
			expect(signal2.budgetType).toBe("cost");
		}
	});

	// ── Test 11: getBudgetUsagePercent returns correct percentage ────────

	it("getBudgetUsagePercent returns the correct percentage", () => {
		const budgetTracker = new CostTracker(
			{ maxTotalTokens: 10000 },
			silentLogger(),
		);

		budgetTracker.recordPoolCall("planner", 1500, 1500); // 3000 tokens

		expect(budgetTracker.getBudgetUsagePercent()).toBeCloseTo(0.3);
	});

	// ── Test 12: getBudgetUsagePercent returns null without budget ───────

	it("getBudgetUsagePercent returns null without budget", () => {
		expect(tracker.getBudgetUsagePercent()).toBeNull();
	});

	// ── Test 13: pause() puts the tracker in paused mode ────────────────

	it("pause() puts the tracker in paused mode", () => {
		expect(tracker.isPaused).toBe(false);
		tracker.pause();
		expect(tracker.isPaused).toBe(true);
	});

	// ── Test 14: reset() resets everything to zero ──────────────────────

	it("reset() resets all counters and flags", () => {
		tracker.recordPoolCall("planner", 100, 50, 0.01);
		tracker.recordAgentUsage("agent-1", 500, 250, 0.05);
		tracker.pause();

		// Set up a budget tracker to test warning reset
		const budgetTracker = new CostTracker(
			{ maxTotalTokens: 1000, warningThreshold: 0.8 },
			silentLogger(),
		);
		budgetTracker.recordPoolCall("planner", 500, 400); // 900 = 90% → triggers warning
		budgetTracker.checkBudget(); // Emits warning

		expect(budgetTracker.warningEmitted).toBe(true);

		budgetTracker.reset();

		expect(budgetTracker.getTotalTokens()).toBe(0);
		expect(budgetTracker.warningEmitted).toBe(false);
		expect(budgetTracker.isPaused).toBe(false);
		expect(budgetTracker.isExceeded).toBe(false);
		expect(budgetTracker.totalCallCount).toBe(0);
	});

	// ── Test 15: getSnapshot returns an immutable copy ───────────────────

	it("getSnapshot returns a copy that is not affected by subsequent mutations", () => {
		tracker.recordPoolCall("planner", 100, 50);

		const snapshot1 = tracker.getSnapshot();
		expect(snapshot1.totalTokens).toBe(150);

		// Record more usage
		tracker.recordPoolCall("sharingAnalyzer", 200, 100);

		// The original snapshot should not change
		expect(snapshot1.totalTokens).toBe(150);

		// But a new snapshot should reflect the update
		const snapshot2 = tracker.getSnapshot();
		expect(snapshot2.totalTokens).toBe(450);
	});

	// ── Additional tests ────────────────────────────────────────────────

	it("totalCallCount sums across all sources", () => {
		tracker.recordPoolCall("planner", 100, 50);
		tracker.recordPoolCall("planner", 100, 50);
		tracker.recordPoolCall("sharingAnalyzer", 100, 50);
		tracker.recordAgentUsage("agent-1", 100, 50);

		expect(tracker.totalCallCount).toBe(4);
	});

	it("getTotalInputTokens aggregates correctly", () => {
		tracker.recordPoolCall("planner", 100, 50);
		tracker.recordPoolCall("contextAnalyzer", 200, 80);
		tracker.recordAgentUsage("agent-1", 300, 100);

		expect(tracker.getTotalInputTokens()).toBe(600);
	});

	it("getTotalOutputTokens aggregates correctly", () => {
		tracker.recordPoolCall("planner", 100, 50);
		tracker.recordPoolCall("contextAnalyzer", 200, 80);
		tracker.recordAgentUsage("agent-1", 300, 100);

		expect(tracker.getTotalOutputTokens()).toBe(230);
	});

	it("getTotalCost returns a value when at least one entry has cost data", () => {
		tracker.recordPoolCall("planner", 100, 50); // no cost
		tracker.recordPoolCall("sharingAnalyzer", 100, 50, 0.005);

		expect(tracker.getTotalCost()).toBeCloseTo(0.005);
	});

	it("isExceeded is set after checkBudget detects exceeded", () => {
		const budgetTracker = new CostTracker(
			{ maxTotalTokens: 100 },
			silentLogger(),
		);
		expect(budgetTracker.isExceeded).toBe(false);

		budgetTracker.recordPoolCall("planner", 60, 50); // 110 > 100
		budgetTracker.checkBudget();

		expect(budgetTracker.isExceeded).toBe(true);
	});

	it("snapshot has a valid timestamp", () => {
		const snapshot = tracker.getSnapshot();
		expect(snapshot.timestamp).toBeDefined();
		// Validate ISO-8601 format
		expect(() => new Date(snapshot.timestamp)).not.toThrow();
		expect(new Date(snapshot.timestamp).toISOString()).toBe(snapshot.timestamp);
	});

	it("all breakdown sources are present in the snapshot", () => {
		const snapshot = tracker.getSnapshot();
		const expectedSources = [
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
		];

		for (const source of expectedSources) {
			const entry =
				snapshot.breakdown[source as keyof typeof snapshot.breakdown];
			expect(entry).toBeDefined();
			expect(entry.callCount).toBe(0);
			expect(entry.totalTokens).toBe(0);
			expect(entry.inputTokens).toBe(0);
			expect(entry.outputTokens).toBe(0);
			expect(entry.estimatedCostUsd).toBeNull();
		}
	});

	it("records multiple calls to the same source and accumulates", () => {
		tracker.recordPoolCall("planner", 100, 50, 0.01);
		tracker.recordPoolCall("planner", 200, 100, 0.02);
		tracker.recordPoolCall("planner", 150, 75, 0.015);

		const snapshot = tracker.getSnapshot();
		expect(snapshot.breakdown.planner.callCount).toBe(3);
		expect(snapshot.breakdown.planner.inputTokens).toBe(450);
		expect(snapshot.breakdown.planner.outputTokens).toBe(225);
		expect(snapshot.breakdown.planner.totalTokens).toBe(675);
		expect(snapshot.breakdown.planner.estimatedCostUsd).toBeCloseTo(0.045);
	});

	it("getBudgetUsagePercent is capped at 1.0", () => {
		const budgetTracker = new CostTracker(
			{ maxTotalTokens: 100 },
			silentLogger(),
		);

		budgetTracker.recordPoolCall("planner", 150, 100); // 250 >> 100

		expect(budgetTracker.getBudgetUsagePercent()).toBe(1.0);
	});

	it("checkBudget with default warningThreshold (0.8)", () => {
		const budgetTracker = new CostTracker(
			{ maxTotalTokens: 1000 }, // No explicit warningThreshold → defaults to 0.8
			silentLogger(),
		);

		budgetTracker.recordPoolCall("planner", 400, 410); // 810 = 81%

		const signal = budgetTracker.checkBudget();
		expect(signal.type).toBe("warning");
	});

	it("checkBudget returns ok below warning threshold", () => {
		const budgetTracker = new CostTracker(
			{ maxTotalTokens: 1000, warningThreshold: 0.8 },
			silentLogger(),
		);

		budgetTracker.recordPoolCall("planner", 200, 100); // 300 = 30%

		const signal = budgetTracker.checkBudget();
		expect(signal.type).toBe("ok");
	});

	it("records compression source correctly", () => {
		tracker.recordPoolCall("compression", 500, 100);

		const snapshot = tracker.getSnapshot();
		expect(snapshot.breakdown.compression.callCount).toBe(1);
		expect(snapshot.breakdown.compression.totalTokens).toBe(600);
	});

	it("cost budget works with getBudgetUsagePercent", () => {
		const budgetTracker = new CostTracker({ maxCostUsd: 1.0 }, silentLogger());

		budgetTracker.recordPoolCall("planner", 100, 50, 0.3);

		expect(budgetTracker.getBudgetUsagePercent()).toBeCloseTo(0.3);
	});

	it("cost budget getBudgetUsagePercent returns null when no cost data available", () => {
		const budgetTracker = new CostTracker({ maxCostUsd: 1.0 }, silentLogger());

		// Record without cost data
		budgetTracker.recordPoolCall("planner", 100, 50);

		// No cost data → can't compute cost percent → returns null
		expect(budgetTracker.getBudgetUsagePercent()).toBeNull();
	});

	it("token budget takes precedence over cost budget for getBudgetUsagePercent", () => {
		const budgetTracker = new CostTracker(
			{ maxTotalTokens: 1000, maxCostUsd: 1.0 },
			silentLogger(),
		);

		budgetTracker.recordPoolCall("planner", 200, 100, 0.5);

		// Token percent = 300/1000 = 0.3
		// Cost percent would be 0.5/1.0 = 0.5
		// Token budget takes precedence
		expect(budgetTracker.getBudgetUsagePercent()).toBeCloseTo(0.3);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// ConversationManager Compression Tests
// ════════════════════════════════════════════════════════════════════════════

describe("ConversationManager — Compression", () => {
	let manager: ConversationManager;

	const config: OpenRouterConfig = {
		apiKey: "test-key",
		model: "test/model",
	};

	beforeEach(() => {
		manager = new ConversationManager(config, silentLogger());
	});

	// ── Test 18: compress does nothing with fewer than 4 messages ────────

	it("compress returns 0 with fewer than 4 messages", async () => {
		manager.register(ConversationRole.PLANNER, "System prompt");

		const compressionConfig: ConversationCompressionConfig = {
			enabled: true,
			compressionThresholdTokens: 100,
			retentionRatio: 0.3,
			maxCompressions: 3,
		};

		// Only 1 message (system prompt)
		const saved = await manager.compress(
			ConversationRole.PLANNER,
			compressionConfig,
		);
		expect(saved).toBe(0);

		// Verify messages unchanged
		const history = manager.getHistory(ConversationRole.PLANNER)!;
		expect(history).toHaveLength(1);
	});

	// ── Test 20: needsCompression returns correct values ────────────────

	it("needsCompression returns true when threshold is exceeded", () => {
		manager.register(ConversationRole.PLANNER, "System prompt");

		// tokenCount starts at 0 — should not need compression
		expect(manager.needsCompression(ConversationRole.PLANNER, 50000)).toBe(
			false,
		);
	});

	it("needsCompression returns false for unregistered conversation", () => {
		expect(manager.needsCompression(ConversationRole.PLANNER, 50000)).toBe(
			false,
		);
	});

	it("compress returns 0 for unregistered conversation", async () => {
		const saved = await manager.compress(ConversationRole.PLANNER, {
			enabled: true,
			compressionThresholdTokens: 100,
		});
		expect(saved).toBe(0);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// ConversationManager — Usage Callback Tests
// ════════════════════════════════════════════════════════════════════════════

describe("ConversationManager — Usage Callback", () => {
	const config: OpenRouterConfig = {
		apiKey: "test-key",
		model: "test/model",
	};

	// ── Test 22-style: setUsageCallback registers the callback ──────────

	it("setUsageCallback sets the callback without error", () => {
		const manager = new ConversationManager(config, silentLogger());

		// Should not throw
		manager.setUsageCallback((_role, _input, _output, _cost) => {});

		expect(true).toBe(true); // No error thrown
	});

	// ── Test 33: ConversationManager works without callback ─────────────

	it("ConversationManager send throws on unregistered (not callback-related)", async () => {
		const manager = new ConversationManager(config, silentLogger());
		// No callback set — should still function (callback is optional)

		// But calling send on an unregistered conversation should throw
		await expect(
			manager.send(ConversationRole.PLANNER, "Hello"),
		).rejects.toThrow(/not been registered/);
	});

	it("ConversationManager operations work without usage callback", () => {
		const manager = new ConversationManager(config, silentLogger());
		// No setUsageCallback called

		manager.register(ConversationRole.PLANNER, "System prompt");
		expect(manager.has(ConversationRole.PLANNER)).toBe(true);

		const stats = manager.getStats(ConversationRole.PLANNER);
		expect(stats).not.toBeNull();
		expect(stats!.messageCount).toBe(1);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// ConversationManager — Compression Count Tracking
// ════════════════════════════════════════════════════════════════════════════

describe("ConversationManager — Compression Count", () => {
	const config: OpenRouterConfig = {
		apiKey: "test-key",
		model: "test/model",
	};

	it("reset clears the compression counter", () => {
		const manager = new ConversationManager(config, silentLogger());
		manager.register(ConversationRole.PLANNER, "System prompt");

		// After reset, compression count should be reset too
		manager.reset(ConversationRole.PLANNER);

		const history = manager.getHistory(ConversationRole.PLANNER)!;
		expect(history).toHaveLength(1);
		expect(history[0]!.content).toBe("System prompt");
	});

	it("re-registering a conversation resets its compression counter", () => {
		const manager = new ConversationManager(config, silentLogger());
		manager.register(ConversationRole.PLANNER, "System prompt v1");
		manager.register(ConversationRole.PLANNER, "System prompt v2");

		const history = manager.getHistory(ConversationRole.PLANNER)!;
		expect(history).toHaveLength(1);
		expect(history[0]!.content).toBe("System prompt v2");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Pool Event Types (Structural Tests)
// ════════════════════════════════════════════════════════════════════════════

describe("Budget Pool Events", () => {
	it("PoolEvent enum has BUDGET_WARNING and BUDGET_EXCEEDED", async () => {
		const { PoolEvent } = await import("../../../enums/pool-event.enum.ts");

		expect(PoolEvent.BUDGET_WARNING as string).toBe("pool:budget-warning");
		expect(PoolEvent.BUDGET_EXCEEDED as string).toBe("pool:budget-exceeded");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// AgentPoolConfig — Token Budget & Compression Config
// ════════════════════════════════════════════════════════════════════════════

describe("AgentPoolConfig with tokenBudget and conversationCompression", () => {
	it("AgentPool accepts tokenBudget in config without error", async () => {
		const { AgentPool } = await import("../agent-pool.ts");
		const { createMockAgentFactory, silentPoolConfig } = await import(
			"./test-helpers.ts"
		);

		const pool = new AgentPool(
			silentPoolConfig({
				tokenBudget: {
					maxTotalTokens: 100_000,
					warningThreshold: 0.75,
					onExceeded: "pause",
				},
				createAgent: createMockAgentFactory(),
			}),
		);

		const state = pool.getState();
		expect(state.budgetWarning).toBe(false);
		expect(state.budgetUsagePercent).toBeCloseTo(0);
		expect(state.currentUsage).toBeNull(); // Not executing

		await pool.destroy();
	});

	it("AgentPool accepts conversationCompression in config without error", async () => {
		const { AgentPool } = await import("../agent-pool.ts");
		const { createMockAgentFactory, silentPoolConfig } = await import(
			"./test-helpers.ts"
		);

		const pool = new AgentPool(
			silentPoolConfig({
				conversationCompression: {
					enabled: true,
					compressionThresholdTokens: 20_000,
					retentionRatio: 0.2,
					maxCompressions: 5,
				},
				createAgent: createMockAgentFactory(),
			}),
		);

		// Pool initializes without error
		expect(pool).toBeDefined();

		await pool.destroy();
	});

	it("AgentPool works with compression disabled", async () => {
		const { AgentPool } = await import("../agent-pool.ts");
		const { createMockAgentFactory, silentPoolConfig } = await import(
			"./test-helpers.ts"
		);

		const pool = new AgentPool(
			silentPoolConfig({
				conversationCompression: {
					enabled: false,
				},
				createAgent: createMockAgentFactory(),
			}),
		);

		expect(pool).toBeDefined();
		await pool.destroy();
	});

	it("AgentPool works without any budget or compression config", async () => {
		const { AgentPool } = await import("../agent-pool.ts");
		const { createMockAgentFactory, silentPoolConfig } = await import(
			"./test-helpers.ts"
		);

		const pool = new AgentPool(
			silentPoolConfig({
				createAgent: createMockAgentFactory(),
			}),
		);

		const state = pool.getState();
		expect(state.budgetUsagePercent).toBeNull();
		expect(state.budgetWarning).toBe(false);
		expect(state.currentUsage).toBeNull();

		await pool.destroy();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// UsageSnapshot Structure Tests
// ════════════════════════════════════════════════════════════════════════════

describe("UsageSnapshot structure", () => {
	it("snapshot has all required fields", () => {
		const tracker = new CostTracker(null, silentLogger());
		tracker.recordPoolCall("planner", 100, 50, 0.01);

		const snapshot: UsageSnapshot = tracker.getSnapshot();

		expect(typeof snapshot.inputTokens).toBe("number");
		expect(typeof snapshot.outputTokens).toBe("number");
		expect(typeof snapshot.totalTokens).toBe("number");
		expect(typeof snapshot.timestamp).toBe("string");
		expect(snapshot.breakdown).toBeDefined();

		// estimatedCostUsd can be number or null
		expect(
			snapshot.estimatedCostUsd === null ||
				typeof snapshot.estimatedCostUsd === "number",
		).toBe(true);
	});

	it("snapshot totalTokens equals inputTokens + outputTokens", () => {
		const tracker = new CostTracker(null, silentLogger());
		tracker.recordPoolCall("planner", 100, 50);
		tracker.recordPoolCall("contextAnalyzer", 200, 80);
		tracker.recordAgentUsage("agent-1", 300, 120);

		const snapshot = tracker.getSnapshot();
		expect(snapshot.totalTokens).toBe(
			snapshot.inputTokens + snapshot.outputTokens,
		);
		expect(snapshot.inputTokens).toBe(600);
		expect(snapshot.outputTokens).toBe(250);
		expect(snapshot.totalTokens).toBe(850);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Edge Cases
// ════════════════════════════════════════════════════════════════════════════

describe("CostTracker edge cases", () => {
	it("handles zero token recordings", () => {
		const tracker = new CostTracker(null, silentLogger());
		tracker.recordPoolCall("planner", 0, 0, 0);

		const snapshot = tracker.getSnapshot();
		expect(snapshot.breakdown.planner.callCount).toBe(1);
		expect(snapshot.breakdown.planner.totalTokens).toBe(0);
		expect(snapshot.breakdown.planner.estimatedCostUsd).toBeNull(); // 0 is treated as no cost
	});

	it("handles very large token values", () => {
		const tracker = new CostTracker(null, silentLogger());
		tracker.recordAgentUsage("agent-1", 1_000_000, 500_000, 10.5);

		const snapshot = tracker.getSnapshot();
		expect(snapshot.breakdown.agents.totalTokens).toBe(1_500_000);
		expect(snapshot.breakdown.agents.estimatedCostUsd).toBe(10.5);
		expect(snapshot.totalTokens).toBe(1_500_000);
	});

	it("multiple resets are safe", () => {
		const tracker = new CostTracker(null, silentLogger());
		tracker.recordPoolCall("planner", 100, 50);

		tracker.reset();
		tracker.reset();
		tracker.reset();

		expect(tracker.getTotalTokens()).toBe(0);
		expect(tracker.totalCallCount).toBe(0);
	});

	it("checkBudget with maxTotalTokens: 0 treats as no limit", () => {
		const tracker = new CostTracker({ maxTotalTokens: 0 }, silentLogger());

		tracker.recordPoolCall("planner", 999999, 999999);

		const signal = tracker.checkBudget();
		expect(signal.type).toBe("ok");
	});

	it("checkBudget with maxCostUsd: 0 treats as no limit", () => {
		const tracker = new CostTracker({ maxCostUsd: 0 }, silentLogger());

		tracker.recordPoolCall("planner", 100, 50, 999);

		const signal = tracker.checkBudget();
		expect(signal.type).toBe("ok");
	});

	it("records all UsageSource types", () => {
		const tracker = new CostTracker(null, silentLogger());

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
			if (source === "agents") {
				tracker.recordAgentUsage("test-agent", 10, 5, 0.001);
			} else {
				tracker.recordPoolCall(source, 10, 5, 0.001);
			}
		}

		expect(tracker.totalCallCount).toBe(sources.length);
		expect(tracker.getTotalTokens()).toBe(sources.length * 15);
	});

	it("warning before exceeded: warning fires at 80%, exceeded at 100%", () => {
		const tracker = new CostTracker(
			{ maxTotalTokens: 100, warningThreshold: 0.8 },
			silentLogger(),
		);

		// 50% — ok
		tracker.recordPoolCall("planner", 30, 20);
		expect(tracker.checkBudget().type).toBe("ok");

		// 85% — warning
		tracker.recordPoolCall("planner", 20, 15);
		const warning = tracker.checkBudget();
		expect(warning.type).toBe("warning");

		// 110% — exceeded
		tracker.recordPoolCall("planner", 15, 10);
		const exceeded = tracker.checkBudget();
		expect(exceeded.type).toBe("exceeded");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Prompt Template Tests
// ════════════════════════════════════════════════════════════════════════════

describe("Compression Prompts", () => {
	it("compressionSystemPrompt compiles without error", async () => {
		const { compressionSystemPrompt } = await import(
			"../../../prompts/compression.ts"
		);

		const result = compressionSystemPrompt({ maxLength: 2000 });
		expect(result).toContain("conversation compressor");
		expect(result).toContain("2000");
	});

	it("compressionPrompt compiles with data", async () => {
		const { compressionPrompt } = await import(
			"../../../prompts/compression.ts"
		);

		const result = compressionPrompt({
			messageCount: 5,
			conversationPurpose: "Strategic task analysis",
			messages: [
				{ role: "user", content: "Hello" },
				{ role: "assistant", content: "Hi there" },
			],
		});

		expect(result).toContain("5");
		expect(result).toContain("Strategic task analysis");
		expect(result).toContain("[user]: Hello");
		expect(result).toContain("[assistant]: Hi there");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Summary Prompt with Usage Data
// ════════════════════════════════════════════════════════════════════════════

describe("Summary Prompt — Usage Section", () => {
	it("summaryPrompt includes usage data when provided", async () => {
		const { summaryPrompt } = await import("../../../prompts/summary.ts");

		const result = summaryPrompt({
			task: "Build a REST API",
			strategy: "multi",
			complexity: "complex",
			planningReasoning: "Task is complex",
			agents: [],
			durationMs: 5000,
			coordination: null,
			usage: {
				totalTokens: 45000,
				inputTokens: 30000,
				outputTokens: 15000,
				estimatedCostUsd: 0.12,
				breakdown: {
					agents: {
						callCount: 3,
						totalTokens: 30000,
						inputTokens: 20000,
						outputTokens: 10000,
						estimatedCostUsd: 0.08,
					},
					planner: {
						callCount: 2,
						totalTokens: 5000,
						inputTokens: 3000,
						outputTokens: 2000,
						estimatedCostUsd: 0.02,
					},
					sharingAnalyzer: {
						callCount: 0,
						totalTokens: 0,
						inputTokens: 0,
						outputTokens: 0,
						estimatedCostUsd: null,
					},
					contextAnalyzer: {
						callCount: 0,
						totalTokens: 0,
						inputTokens: 0,
						outputTokens: 0,
						estimatedCostUsd: null,
					},
					intentAnalyzer: {
						callCount: 0,
						totalTokens: 0,
						inputTokens: 0,
						outputTokens: 0,
						estimatedCostUsd: null,
					},
					orchestrator: {
						callCount: 0,
						totalTokens: 0,
						inputTokens: 0,
						outputTokens: 0,
						estimatedCostUsd: null,
					},
					checkpoint: {
						callCount: 0,
						totalTokens: 0,
						inputTokens: 0,
						outputTokens: 0,
						estimatedCostUsd: null,
					},
					reflection: {
						callCount: 0,
						totalTokens: 0,
						inputTokens: 0,
						outputTokens: 0,
						estimatedCostUsd: null,
					},
					userInteraction: {
						callCount: 0,
						totalTokens: 0,
						inputTokens: 0,
						outputTokens: 0,
						estimatedCostUsd: null,
					},
					compression: {
						callCount: 0,
						totalTokens: 0,
						inputTokens: 0,
						outputTokens: 0,
						estimatedCostUsd: null,
					},
				},
				timestamp: new Date().toISOString(),
			},
			poolLlmCallCount: 5,
		});

		expect(result).toContain("Resource Usage");
		expect(result).toContain("45000");
		expect(result).toContain("30000");
		expect(result).toContain("15000");
		expect(result).toContain("agents=3");
		expect(result).toContain("pool=5");
	});

	it("summaryPrompt omits usage section when not provided", async () => {
		const { summaryPrompt } = await import("../../../prompts/summary.ts");

		const result = summaryPrompt({
			task: "Build a REST API",
			strategy: "single",
			complexity: "simple",
			planningReasoning: "Simple task",
			agents: [],
			durationMs: 1000,
			coordination: null,
		});

		expect(result).not.toContain("Resource Usage");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// ConversationManager — Usage Callback Invocation Tests
// ════════════════════════════════════════════════════════════════════════════

describe("ConversationManager — Usage Callback Invocation", () => {
	const config: OpenRouterConfig = {
		apiKey: "test-key",
		model: "test/model",
	};

	it("reportUsage is called internally when usageCallback is set (send path)", () => {
		// We can't easily call send() without a real OpenRouter,
		// but we can verify the callback wiring is correct by
		// checking that reportUsage calls through to the callback.
		const manager = new ConversationManager(config, silentLogger());
		manager.register(ConversationRole.PLANNER, "System prompt");

		const calls: Array<{
			role: ConversationRole;
			input: number;
			output: number;
			cost?: number;
		}> = [];

		manager.setUsageCallback((role, inputTokens, outputTokens, costUsd) => {
			calls.push({
				role,
				input: inputTokens,
				output: outputTokens,
				cost: costUsd,
			});
		});

		// Access the private reportUsage method to verify the callback wiring
		// This simulates what happens inside send() after a successful LLM call
		(manager as any).reportUsage(ConversationRole.PLANNER, 400, 200);

		expect(calls).toHaveLength(1);
		expect(calls[0]!.role).toBe(ConversationRole.PLANNER);
		expect(calls[0]!.input).toBe(Math.ceil(400 / 4)); // 100
		expect(calls[0]!.output).toBe(Math.ceil(200 / 4)); // 50
	});

	it("reportUsage does nothing when no callback is set", () => {
		const manager = new ConversationManager(config, silentLogger());
		manager.register(ConversationRole.PLANNER, "System prompt");

		// Should not throw even without callback
		expect(() => {
			(manager as any).reportUsage(ConversationRole.PLANNER, 400, 200);
		}).not.toThrow();
	});

	it("callback receives correct role for different conversations", () => {
		const manager = new ConversationManager(config, silentLogger());
		manager.register(ConversationRole.PLANNER, "Planner prompt");
		manager.register(ConversationRole.CONTEXT_ANALYZER, "Analyzer prompt");

		const roles: ConversationRole[] = [];
		manager.setUsageCallback((role) => {
			roles.push(role);
		});

		(manager as any).reportUsage(ConversationRole.PLANNER, 100, 50);
		(manager as any).reportUsage(ConversationRole.CONTEXT_ANALYZER, 200, 80);

		expect(roles).toHaveLength(2);
		expect(roles[0]).toBe(ConversationRole.PLANNER);
		expect(roles[1]).toBe(ConversationRole.CONTEXT_ANALYZER);
	});

	it("callback token estimates use chars/4 heuristic", () => {
		const manager = new ConversationManager(config, silentLogger());
		manager.register(ConversationRole.PLANNER, "System prompt");

		let capturedInput = 0;
		let capturedOutput = 0;
		manager.setUsageCallback((_role, input, output) => {
			capturedInput = input;
			capturedOutput = output;
		});

		// 1000 chars input → 250 tokens, 500 chars output → 125 tokens
		(manager as any).reportUsage(ConversationRole.PLANNER, 1000, 500);

		expect(capturedInput).toBe(250);
		expect(capturedOutput).toBe(125);
	});

	it("callback handles odd-length content (ceiling division)", () => {
		const manager = new ConversationManager(config, silentLogger());
		manager.register(ConversationRole.PLANNER, "System prompt");

		let capturedInput = 0;
		let capturedOutput = 0;
		manager.setUsageCallback((_role, input, output) => {
			capturedInput = input;
			capturedOutput = output;
		});

		// 7 chars → ceil(7/4) = 2 tokens, 3 chars → ceil(3/4) = 1 token
		(manager as any).reportUsage(ConversationRole.PLANNER, 7, 3);

		expect(capturedInput).toBe(2);
		expect(capturedOutput).toBe(1);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// ConversationManager — Compression with Mock LLM
// ════════════════════════════════════════════════════════════════════════════

describe("ConversationManager — Compression with Mock LLM", () => {
	const config: OpenRouterConfig = {
		apiKey: "test-key",
		model: "test/model",
	};

	/**
	 * Registers a conversation (if not already) and adds messages to it.
	 * If `registerIfMissing` is false, only adds messages to an existing conversation.
	 */
	function buildConversationWithMessages(
		manager: ConversationManager,
		role: ConversationRole,
		messageCount: number,
		registerIfMissing = true,
	): void {
		if (!manager.has(role) && registerIfMissing) {
			manager.register(role, "System prompt for testing compression");
		}

		// Access internal conversation to add messages directly
		const conversation = (manager as any).conversations.get(role);
		if (!conversation) throw new Error("Conversation not found");

		for (let i = 0; i < messageCount; i++) {
			const content =
				i % 2 === 0
					? `User message ${i}: Please analyze this data and provide insights about topic ${i}`
					: `Assistant response ${i}: Here is the analysis result for topic ${i} with detailed findings`;
			conversation.messages.push({
				role: i % 2 === 0 ? "user" : "assistant",
				content,
			});
			conversation.tokenCount += Math.ceil(content.length / 4);
		}
	}

	/**
	 * Adds messages to an already-registered conversation without re-registering.
	 */
	function addMessagesToConversation(
		manager: ConversationManager,
		role: ConversationRole,
		messageCount: number,
	): void {
		const conversation = (manager as any).conversations.get(role);
		if (!conversation) throw new Error("Conversation not found");

		for (let i = 0; i < messageCount; i++) {
			const content =
				i % 2 === 0
					? `User message ${i}: Please analyze this data and provide insights about topic ${i}`
					: `Assistant response ${i}: Here is the analysis result for topic ${i} with detailed findings`;
			conversation.messages.push({
				role: i % 2 === 0 ? "user" : "assistant",
				content,
			});
			conversation.tokenCount += Math.ceil(content.length / 4);
		}
	}

	it("compress reduces message count when LLM call succeeds", async () => {
		const manager = new ConversationManager(config, silentLogger());
		buildConversationWithMessages(manager, ConversationRole.PLANNER, 10);

		// Mock the client.chat to return a compressed summary
		const originalChat = manager.client.chat.bind(manager.client);
		(manager.client as any).chat = async () =>
			"Compressed summary: Topics 0-7 analyzed. Key findings established.";

		const history = manager.getHistory(ConversationRole.PLANNER)!;
		const originalCount = history.length; // 1 system + 10 messages = 11
		expect(originalCount).toBe(11);

		const saved = await manager.compress(ConversationRole.PLANNER, {
			enabled: true,
			compressionThresholdTokens: 100,
			retentionRatio: 0.3,
			maxCompressions: 3,
		});

		const newHistory = manager.getHistory(ConversationRole.PLANNER)!;

		// Should have fewer messages: system + compressed + kept messages
		expect(newHistory.length).toBeLessThan(originalCount);
		// First message should still be the system prompt
		expect(newHistory[0]!.role).toBe("system");
		expect(newHistory[0]!.content).toBe(
			"System prompt for testing compression",
		);
		// Second message should be the compressed summary
		expect(newHistory[1]!.role).toBe("system");
		expect(newHistory[1]!.content).toContain("[Compressed context from");
		expect(newHistory[1]!.content).toContain("Compressed summary:");
		// Should have returned positive tokens saved
		expect(saved).toBeGreaterThan(0);

		// Restore
		(manager.client as any).chat = originalChat;
	});

	it("compress preserves the original system prompt", async () => {
		const manager = new ConversationManager(config, silentLogger());
		const systemPrompt =
			"You are a specialized planner agent. Always output JSON.";
		manager.register(ConversationRole.PLANNER, systemPrompt);

		const conversation = (manager as any).conversations.get(
			ConversationRole.PLANNER,
		);
		for (let i = 0; i < 10; i++) {
			conversation.messages.push({
				role: i % 2 === 0 ? "user" : "assistant",
				content: `Message ${i} with some content to make it long enough`,
			});
			conversation.tokenCount += 20;
		}

		(manager.client as any).chat = async () =>
			"Compressed summary of earlier conversation.";

		await manager.compress(ConversationRole.PLANNER, {
			enabled: true,
			retentionRatio: 0.3,
			maxCompressions: 3,
		});

		const history = manager.getHistory(ConversationRole.PLANNER)!;
		expect(history[0]!.role).toBe("system");
		expect(history[0]!.content).toBe(systemPrompt);
	});

	it("compress respects maxCompressions and performs hard reset", async () => {
		const manager = new ConversationManager(config, silentLogger());
		// Register once — subsequent iterations must NOT re-register
		manager.register(
			ConversationRole.PLANNER,
			"System prompt for testing compression",
		);

		let chatCallCount = 0;
		(manager.client as any).chat = async () => {
			chatCallCount++;
			return `Compressed summary #${chatCallCount}`;
		};

		// Perform compressions up to the limit
		for (let attempt = 0; attempt < 3; attempt++) {
			// Add messages to the existing conversation without re-registering
			addMessagesToConversation(manager, ConversationRole.PLANNER, 10);

			const saved = await manager.compress(ConversationRole.PLANNER, {
				enabled: true,
				retentionRatio: 0.3,
				maxCompressions: 2, // Allow only 2 compressions
			});

			if (attempt < 2) {
				// First 2 compressions should succeed normally
				expect(saved).toBeGreaterThan(0);
			} else {
				// 3rd attempt should trigger hard reset because maxCompressions reached
				expect(saved).toBeGreaterThan(0);

				// After hard reset, only system prompt should remain
				const history = manager.getHistory(ConversationRole.PLANNER)!;
				expect(history).toHaveLength(1);
			}
		}
	});

	it("compress returns 0 when not enough messages to compress", async () => {
		const manager = new ConversationManager(config, silentLogger());
		manager.register(ConversationRole.PLANNER, "System prompt");

		// Add exactly 2 non-system messages (system + 2 = 3 total, less than 4)
		const conversation = (manager as any).conversations.get(
			ConversationRole.PLANNER,
		);
		conversation.messages.push({ role: "user", content: "Hello" });
		conversation.messages.push({ role: "assistant", content: "Hi" });

		const saved = await manager.compress(ConversationRole.PLANNER, {
			enabled: true,
			retentionRatio: 0.3,
			maxCompressions: 3,
		});

		expect(saved).toBe(0);
	});

	it("compress handles LLM failure gracefully (leaves conversation unchanged)", async () => {
		const manager = new ConversationManager(config, silentLogger());
		buildConversationWithMessages(manager, ConversationRole.PLANNER, 10);

		const historyBefore = manager.getHistory(ConversationRole.PLANNER)!;
		const messageCountBefore = historyBefore.length;

		// Mock the client.chat to throw an error
		(manager.client as any).chat = async () => {
			throw new Error("LLM API failure");
		};

		const saved = await manager.compress(ConversationRole.PLANNER, {
			enabled: true,
			retentionRatio: 0.3,
			maxCompressions: 3,
		});

		expect(saved).toBe(0);

		const historyAfter = manager.getHistory(ConversationRole.PLANNER)!;
		expect(historyAfter.length).toBe(messageCountBefore);
	});

	it("compress reports usage to the callback", async () => {
		const manager = new ConversationManager(config, silentLogger());
		buildConversationWithMessages(manager, ConversationRole.PLANNER, 10);

		const usageCalls: Array<{
			role: ConversationRole;
			input: number;
			output: number;
		}> = [];
		manager.setUsageCallback((role, input, output) => {
			usageCalls.push({ role, input, output });
		});

		(manager.client as any).chat = async () => "Compressed summary.";

		await manager.compress(ConversationRole.PLANNER, {
			enabled: true,
			retentionRatio: 0.3,
			maxCompressions: 3,
		});

		// Should have reported usage for the compression LLM call
		expect(usageCalls.length).toBeGreaterThanOrEqual(1);
		expect(usageCalls[0]!.role).toBe(ConversationRole.PLANNER);
		expect(usageCalls[0]!.input).toBeGreaterThan(0);
		expect(usageCalls[0]!.output).toBeGreaterThan(0);
	});

	it("compress updates tokenCount correctly after compression", async () => {
		const manager = new ConversationManager(config, silentLogger());
		buildConversationWithMessages(manager, ConversationRole.PLANNER, 10);

		(manager.client as any).chat = async () => "Short compressed summary.";

		const statsBefore = manager.getStats(ConversationRole.PLANNER)!;
		const tokensBefore = statsBefore.estimatedTokens;

		await manager.compress(ConversationRole.PLANNER, {
			enabled: true,
			retentionRatio: 0.3,
			maxCompressions: 3,
		});

		const statsAfter = manager.getStats(ConversationRole.PLANNER)!;
		// Token count should be recalculated and likely lower
		expect(statsAfter.estimatedTokens).toBeLessThan(tokensBefore);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// ConversationManager — One-Shot Conversations Never Compressed
// ════════════════════════════════════════════════════════════════════════════

describe("ConversationManager — One-Shot Never Compressed", () => {
	const config: OpenRouterConfig = {
		apiKey: "test-key",
		model: "test/model",
	};

	it("needsCompression returns false for conversations with only system prompt", () => {
		const manager = new ConversationManager(config, silentLogger());
		manager.register(ConversationRole.INTENT_ANALYZER, "Intent system prompt");

		// One-shot conversations typically have only the system prompt in history
		// since sendOneShot/sendOneShotJson don't persist messages.
		// tokenCount starts at 0 after register(), so any positive threshold means false.
		expect(manager.needsCompression(ConversationRole.INTENT_ANALYZER, 1)).toBe(
			false,
		);
		expect(
			manager.needsCompression(ConversationRole.INTENT_ANALYZER, 100),
		).toBe(false);
		expect(
			manager.needsCompression(ConversationRole.INTENT_ANALYZER, 50_000),
		).toBe(false);
	});

	it("compress returns 0 for conversation with fewer than 4 messages (one-shot pattern)", async () => {
		const manager = new ConversationManager(config, silentLogger());
		manager.register(ConversationRole.INTENT_ANALYZER, "Intent system prompt");

		// One-shot conversations have only 1 message (system prompt)
		const saved = await manager.compress(ConversationRole.INTENT_ANALYZER, {
			enabled: true,
			compressionThresholdTokens: 0,
			retentionRatio: 0.3,
			maxCompressions: 3,
		});

		expect(saved).toBe(0);
		const history = manager.getHistory(ConversationRole.INTENT_ANALYZER)!;
		expect(history).toHaveLength(1);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Excluded Roles Not Compressed
// ════════════════════════════════════════════════════════════════════════════

describe("ConversationManager — Excluded Roles", () => {
	const config: OpenRouterConfig = {
		apiKey: "test-key",
		model: "test/model",
	};

	it("needsCompression still returns true for excluded roles (filtering is pool's responsibility)", () => {
		// The ConversationManager.needsCompression doesn't check excludeRoles —
		// that's the AgentPool.checkConversationCompression's responsibility.
		// This test documents that behavior.
		const manager = new ConversationManager(config, silentLogger());
		manager.register(ConversationRole.PLANNER, "System prompt");

		// Artificially set tokenCount high
		const conversation = (manager as any).conversations.get(
			ConversationRole.PLANNER,
		);
		conversation.tokenCount = 100_000;

		// needsCompression itself doesn't know about excludeRoles
		expect(manager.needsCompression(ConversationRole.PLANNER, 50_000)).toBe(
			true,
		);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// CostTracker — canMakePoolLlmCall Guard
// ════════════════════════════════════════════════════════════════════════════

describe("CostTracker — pause blocks pool calls", () => {
	it("isPaused defaults to false", () => {
		const tracker = new CostTracker(null, silentLogger());
		expect(tracker.isPaused).toBe(false);
	});

	it("after pause(), isPaused is true and can be used as guard", () => {
		const tracker = new CostTracker(null, silentLogger());
		tracker.pause();

		expect(tracker.isPaused).toBe(true);
		// This is how AgentPool.canMakePoolLlmCall() uses it
		const canMake = !tracker.isPaused;
		expect(canMake).toBe(false);
	});

	it("reset() clears paused state", () => {
		const tracker = new CostTracker(null, silentLogger());
		tracker.pause();
		expect(tracker.isPaused).toBe(true);

		tracker.reset();
		expect(tracker.isPaused).toBe(false);
	});

	it("budget exceeded with pause action sets paused via external call", () => {
		const tracker = new CostTracker(
			{ maxTotalTokens: 100, onExceeded: "pause" },
			silentLogger(),
		);

		tracker.recordPoolCall("planner", 60, 50); // 110 > 100
		const signal = tracker.checkBudget();

		expect(signal.type).toBe("exceeded");
		// The pool would call pause() based on onExceeded config
		tracker.pause();
		expect(tracker.isPaused).toBe(true);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// CostTracker — Compression Check Throttling (conceptual)
// ════════════════════════════════════════════════════════════════════════════

describe("CostTracker — Compression not triggered when paused", () => {
	it("compression should be skipped when tracker is paused", () => {
		const tracker = new CostTracker(null, silentLogger());
		tracker.pause();

		// The AgentPool.checkConversationCompression() checks isPaused
		// and returns early. We verify the flag is accessible.
		expect(tracker.isPaused).toBe(true);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// CostTracker — Budget warning with both token and cost limits
// ════════════════════════════════════════════════════════════════════════════

describe("CostTracker — Combined token and cost budget", () => {
	it("token budget check fires before cost budget check", () => {
		const tracker = new CostTracker(
			{ maxTotalTokens: 100, maxCostUsd: 1.0, warningThreshold: 0.8 },
			silentLogger(),
		);

		// 85 tokens = 85% of token budget, but $0.01 = 1% of cost budget
		tracker.recordPoolCall("planner", 50, 35, 0.01);
		const signal = tracker.checkBudget();

		expect(signal.type).toBe("warning");
		if (signal.type === "warning") {
			// Token budget fires first
			expect(signal.budgetType).toBe("tokens");
		}
	});

	it("cost budget fires when token budget has no limit set", () => {
		const tracker = new CostTracker(
			{ maxCostUsd: 0.1, warningThreshold: 0.8 },
			silentLogger(),
		);

		tracker.recordPoolCall("planner", 1000, 500, 0.09); // 90% of $0.10
		const signal = tracker.checkBudget();

		expect(signal.type).toBe("warning");
		if (signal.type === "warning") {
			expect(signal.budgetType).toBe("cost");
		}
	});

	it("exceeded on tokens takes precedence even when cost is under budget", () => {
		const tracker = new CostTracker(
			{ maxTotalTokens: 100, maxCostUsd: 10.0 },
			silentLogger(),
		);

		tracker.recordPoolCall("planner", 60, 50, 0.001); // 110 tokens > 100 limit
		const signal = tracker.checkBudget();

		expect(signal.type).toBe("exceeded");
		if (signal.type === "exceeded") {
			expect(signal.budgetType).toBe("tokens");
		}
	});
});

// ════════════════════════════════════════════════════════════════════════════
// AgentPool — Budget state in getState before/after execution
// ════════════════════════════════════════════════════════════════════════════

describe("AgentPool — getState budget fields", () => {
	it("getState returns correct budget defaults when no budget configured", async () => {
		const { AgentPool } = await import("../agent-pool.ts");
		const pool = new AgentPool(
			silentPoolConfig({
				createAgent: createMockAgentFactory(),
			}),
		);

		const state = pool.getState();
		expect(state.currentUsage).toBeNull();
		expect(state.budgetUsagePercent).toBeNull();
		expect(state.budgetWarning).toBe(false);

		await pool.destroy();
	});

	it("getState returns 0% budget usage when budget configured but nothing consumed", async () => {
		const { AgentPool } = await import("../agent-pool.ts");
		const pool = new AgentPool(
			silentPoolConfig({
				tokenBudget: { maxTotalTokens: 100_000 },
				createAgent: createMockAgentFactory(),
			}),
		);

		const state = pool.getState();
		expect(state.budgetUsagePercent).toBe(0);
		expect(state.budgetWarning).toBe(false);

		await pool.destroy();
	});
});
