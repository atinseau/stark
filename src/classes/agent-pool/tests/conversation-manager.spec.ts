import { describe, expect, it } from "bun:test";
import { ConversationRole } from "../../../enums/conversation-role.enum.ts";
import type { OpenRouterConfig } from "../../../types/agent-pool.types.ts";
import { ConversationManager } from "../conversation-manager.ts";
import { silentLogger } from "./test-helpers.ts";

// ════════════════════════════════════════════════════════════════════════════
// ConversationManager Unit Tests
// ════════════════════════════════════════════════════════════════════════════

describe("ConversationManager", () => {
	it("registers conversations and tracks them", () => {
		// We can't easily test the full flow without mocking OpenRouter,
		// but we can test registration and state management
		const config: OpenRouterConfig = {
			apiKey: "test-key",
			model: "test/model",
		};
		const manager = new ConversationManager(config, silentLogger());

		expect(manager.has(ConversationRole.PLANNER)).toBe(false);

		manager.register(ConversationRole.PLANNER, "You are a planner.");
		expect(manager.has(ConversationRole.PLANNER)).toBe(true);

		const stats = manager.getStats(ConversationRole.PLANNER);
		expect(stats).not.toBeNull();
		expect(stats!.messageCount).toBe(1); // System prompt
		expect(stats!.systemPromptLength).toBe("You are a planner.".length);
	});

	it("returns null stats for unregistered conversations", () => {
		const config: OpenRouterConfig = {
			apiKey: "test-key",
			model: "test/model",
		};
		const manager = new ConversationManager(config, silentLogger());

		expect(manager.getStats(ConversationRole.PLANNER)).toBeNull();
	});

	it("returns null history for unregistered conversations", () => {
		const config: OpenRouterConfig = {
			apiKey: "test-key",
			model: "test/model",
		};
		const manager = new ConversationManager(config, silentLogger());

		expect(manager.getHistory(ConversationRole.PLANNER)).toBeNull();
	});

	it("getHistory returns a defensive copy", () => {
		const config: OpenRouterConfig = {
			apiKey: "test-key",
			model: "test/model",
		};
		const manager = new ConversationManager(config, silentLogger());

		manager.register(ConversationRole.PLANNER, "System prompt");

		const history1 = manager.getHistory(ConversationRole.PLANNER)!;
		const history2 = manager.getHistory(ConversationRole.PLANNER)!;

		expect(history1).toEqual(history2);
		expect(history1).not.toBe(history2); // Different array references
	});

	it("reset clears conversation history except system prompt", () => {
		const config: OpenRouterConfig = {
			apiKey: "test-key",
			model: "test/model",
		};
		const manager = new ConversationManager(config, silentLogger());

		manager.register(ConversationRole.PLANNER, "You are a planner.");

		// Manually check that history starts with system prompt
		const history = manager.getHistory(ConversationRole.PLANNER)!;
		expect(history).toHaveLength(1);
		expect(history[0]!.role).toBe("system");
		expect(history[0]!.content).toBe("You are a planner.");

		manager.reset(ConversationRole.PLANNER);

		const historyAfterReset = manager.getHistory(ConversationRole.PLANNER)!;
		expect(historyAfterReset).toHaveLength(1);
		expect(historyAfterReset[0]!.role).toBe("system");
	});

	it("throws when sending to an unregistered conversation", async () => {
		const config: OpenRouterConfig = {
			apiKey: "test-key",
			model: "test/model",
		};
		const manager = new ConversationManager(config, silentLogger());

		await expect(
			manager.send(ConversationRole.PLANNER, "Hello"),
		).rejects.toThrow(/not been registered/);
	});

	it("conversations are isolated — separate message histories", () => {
		const config: OpenRouterConfig = {
			apiKey: "test-key",
			model: "test/model",
		};
		const manager = new ConversationManager(config, silentLogger());

		manager.register(ConversationRole.PLANNER, "Planner system prompt");
		manager.register(
			ConversationRole.CONTEXT_ANALYZER,
			"Analyzer system prompt",
		);

		const plannerHistory = manager.getHistory(ConversationRole.PLANNER)!;
		const analyzerHistory = manager.getHistory(
			ConversationRole.CONTEXT_ANALYZER,
		)!;

		// Each has its own system prompt
		expect(plannerHistory[0]!.content).toBe("Planner system prompt");
		expect(analyzerHistory[0]!.content).toBe("Analyzer system prompt");

		// They are separate arrays
		expect(plannerHistory).not.toBe(analyzerHistory);
	});

	it("resetAll resets all conversations", () => {
		const config: OpenRouterConfig = {
			apiKey: "test-key",
			model: "test/model",
		};
		const manager = new ConversationManager(config, silentLogger());

		manager.register(ConversationRole.PLANNER, "Planner");
		manager.register(ConversationRole.CONTEXT_ANALYZER, "Analyzer");

		manager.resetAll();

		// Both should have only the system prompt
		expect(manager.getHistory(ConversationRole.PLANNER)!).toHaveLength(1);
		expect(manager.getHistory(ConversationRole.CONTEXT_ANALYZER)!).toHaveLength(
			1,
		);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Conversation Isolation Tests
// ════════════════════════════════════════════════════════════════════════════

describe("Conversation isolation", () => {
	it("each conversation role has independent message history", () => {
		const config: OpenRouterConfig = {
			apiKey: "test-key",
			model: "test/model",
		};
		const manager = new ConversationManager(config, silentLogger());

		manager.register(ConversationRole.PLANNER, "Planner instructions");
		manager.register(
			ConversationRole.CONTEXT_ANALYZER,
			"Analyzer instructions",
		);
		manager.register(ConversationRole.INTENT_ANALYZER, "Intent instructions");
		manager.register(
			ConversationRole.USER_INTERACTION,
			"Interaction instructions",
		);

		// Verify each conversation has its own system prompt
		const plannerHistory = manager.getHistory(ConversationRole.PLANNER)!;
		const analyzerHistory = manager.getHistory(
			ConversationRole.CONTEXT_ANALYZER,
		)!;
		const intentHistory = manager.getHistory(ConversationRole.INTENT_ANALYZER)!;
		const interactionHistory = manager.getHistory(
			ConversationRole.USER_INTERACTION,
		)!;

		expect(plannerHistory[0]!.content).toBe("Planner instructions");
		expect(analyzerHistory[0]!.content).toBe("Analyzer instructions");
		expect(intentHistory[0]!.content).toBe("Intent instructions");
		expect(interactionHistory[0]!.content).toBe("Interaction instructions");

		// Verify they are completely separate objects
		expect(plannerHistory).not.toBe(analyzerHistory);
		expect(analyzerHistory).not.toBe(intentHistory);
		expect(intentHistory).not.toBe(interactionHistory);
	});

	it("resetting one conversation does not affect others", () => {
		const config: OpenRouterConfig = {
			apiKey: "test-key",
			model: "test/model",
		};
		const manager = new ConversationManager(config, silentLogger());

		manager.register(ConversationRole.PLANNER, "Planner");
		manager.register(ConversationRole.CONTEXT_ANALYZER, "Analyzer");

		// Reset only the planner
		manager.reset(ConversationRole.PLANNER);

		// Planner should be reset
		const plannerStats = manager.getStats(ConversationRole.PLANNER)!;
		expect(plannerStats.messageCount).toBe(1); // Just system prompt

		// Analyzer should be untouched
		const analyzerStats = manager.getStats(ConversationRole.CONTEXT_ANALYZER)!;
		expect(analyzerStats.messageCount).toBe(1); // Just system prompt
	});

	it("registering a conversation with the same role replaces it", () => {
		const config: OpenRouterConfig = {
			apiKey: "test-key",
			model: "test/model",
		};
		const manager = new ConversationManager(config, silentLogger());

		manager.register(ConversationRole.PLANNER, "Original instructions");
		manager.register(ConversationRole.PLANNER, "Updated instructions");

		const history = manager.getHistory(ConversationRole.PLANNER)!;
		expect(history).toHaveLength(1);
		expect(history[0]!.content).toBe("Updated instructions");
	});
});
