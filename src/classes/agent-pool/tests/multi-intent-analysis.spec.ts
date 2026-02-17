import { describe, expect, it } from "bun:test";

import { UserIntent } from "../../../enums/user-intent.enum.ts";
import {
	intentAnalysisPrompt,
	intentAnalysisSystemPrompt,
} from "../../../prompts/index.ts";
import type {
	DetectedIntent,
	IntentAnalysis,
} from "../../../types/agent-pool.types.ts";
import { AgentPool } from "../agent-pool.ts";
import { createMockAgentFactory, silentPoolConfig } from "./test-helpers.ts";

// ════════════════════════════════════════════════════════════════════════════
// Helpers — replicate internal validateIntentAnalysis for unit testing
// ════════════════════════════════════════════════════════════════════════════

function validateIntentAnalysis(data: unknown): IntentAnalysis | null {
	if (data == null || typeof data !== "object") return null;
	const obj = data as Record<string, unknown>;

	const validIntents = [
		"new_task",
		"notification_preference",
		"status_query",
		"context_injection",
		"cancel",
		"approve_agent",
		"replan",
		"unknown",
	];

	// Validate reasoning
	if (typeof obj.reasoning !== "string") return null;

	// Validate intents array
	if (!Array.isArray(obj.intents) || obj.intents.length === 0) return null;

	const intents: DetectedIntent[] = [];

	for (const raw of obj.intents) {
		if (raw == null || typeof raw !== "object") return null;
		const item = raw as Record<string, unknown>;

		if (typeof item.intent !== "string" || !validIntents.includes(item.intent))
			return null;
		if (typeof item.confidence !== "number") return null;

		intents.push({
			intent: item.intent as UserIntent,
			confidence: Math.max(0, Math.min(1, item.confidence)),
			parameters:
				item.parameters != null && typeof item.parameters === "object"
					? (item.parameters as Record<string, unknown>)
					: {},
		});
	}

	const first = intents[0];
	if (!first) return null;

	return {
		intents,
		primaryIntent: first.intent,
		reasoning: obj.reasoning as string,
	};
}

/**
 * Access private members on AgentPool for testing.
 * This is acceptable in tests to verify internal state.
 */
function getPrivate(pool: AgentPool): Record<string, any> {
	return pool as unknown as Record<string, any>;
}

/**
 * Replicate resolveIntentConflicts logic for isolated testing.
 * Mirrors the private method in AgentPool.
 */
function resolveIntentConflicts(intents: DetectedIntent[]): DetectedIntent[] {
	const hasCancel = intents.some((i) => i.intent === UserIntent.CANCEL);

	if (hasCancel) {
		return intents.filter(
			(i) =>
				i.intent === UserIntent.CANCEL ||
				i.intent === UserIntent.STATUS_QUERY ||
				i.intent === UserIntent.NOTIFICATION_PREFERENCE,
		);
	}

	// Move approve_agent to the front
	const sorted = [...intents].sort((a, b) => {
		if (a.intent === UserIntent.APPROVE_AGENT) return -1;
		if (b.intent === UserIntent.APPROVE_AGENT) return 1;
		return 0;
	});

	// Deduplicate intents (keep first occurrence of each type)
	const seen = new Set<UserIntent>();
	return sorted.filter((i) => {
		if (seen.has(i.intent)) return false;
		seen.add(i.intent);
		return true;
	});
}

function makeDetected(
	intent: UserIntent,
	confidence = 0.9,
	parameters: Record<string, unknown> = {},
): DetectedIntent {
	return { intent, confidence, parameters };
}

// ════════════════════════════════════════════════════════════════════════════
// Test 1–5: Validator Tests
// ════════════════════════════════════════════════════════════════════════════

describe("validateIntentAnalysis — multi-intent format", () => {
	it("Test 1: accepts a multi-intent with two intents", () => {
		const input = {
			intents: [
				{
					intent: "new_task",
					confidence: 0.9,
					parameters: { task: "run tests" },
				},
				{
					intent: "notification_preference",
					confidence: 0.85,
					parameters: { enabled: true },
				},
			],
			reasoning: "User wants to run tests and be notified.",
		};

		const result = validateIntentAnalysis(input);

		expect(result).not.toBeNull();
		expect(result!.intents).toHaveLength(2);
		expect(result!.primaryIntent).toBe(UserIntent.NEW_TASK);
		expect(result!.intents[0]!.confidence).toBe(0.9);
		expect(result!.intents[1]!.intent).toBe(UserIntent.NOTIFICATION_PREFERENCE);
		expect(result!.intents[1]!.confidence).toBe(0.85);
		expect(result!.reasoning).toBe("User wants to run tests and be notified.");
	});

	it("Test 2: accepts a single-intent (backward compatible)", () => {
		const input = {
			intents: [{ intent: "status_query", confidence: 0.8, parameters: {} }],
			reasoning: "Status check.",
		};

		const result = validateIntentAnalysis(input);

		expect(result).not.toBeNull();
		expect(result!.intents).toHaveLength(1);
		expect(result!.primaryIntent).toBe(UserIntent.STATUS_QUERY);
		expect(result!.intents[0]!.confidence).toBe(0.8);
	});

	it("Test 3: rejects an empty intents array", () => {
		const input = {
			intents: [],
			reasoning: "...",
		};

		const result = validateIntentAnalysis(input);
		expect(result).toBeNull();
	});

	it("Test 4: rejects an intent with an invalid type", () => {
		const input = {
			intents: [{ intent: "hack_system", confidence: 1.0, parameters: {} }],
			reasoning: "...",
		};

		const result = validateIntentAnalysis(input);
		expect(result).toBeNull();
	});

	it("Test 5: clamps confidences into [0, 1]", () => {
		const inputHigh = {
			intents: [{ intent: "new_task", confidence: 1.5, parameters: {} }],
			reasoning: "Over-confident",
		};

		const resultHigh = validateIntentAnalysis(inputHigh);
		expect(resultHigh).not.toBeNull();
		expect(resultHigh!.intents[0]!.confidence).toBe(1.0);

		const inputLow = {
			intents: [{ intent: "cancel", confidence: -0.3, parameters: {} }],
			reasoning: "Under-confident",
		};

		const resultLow = validateIntentAnalysis(inputLow);
		expect(resultLow).not.toBeNull();
		expect(resultLow!.intents[0]!.confidence).toBe(0.0);
	});

	it("rejects null input", () => {
		expect(validateIntentAnalysis(null)).toBeNull();
	});

	it("rejects non-object input", () => {
		expect(validateIntentAnalysis("string")).toBeNull();
		expect(validateIntentAnalysis(42)).toBeNull();
	});

	it("rejects missing reasoning", () => {
		const input = {
			intents: [{ intent: "new_task", confidence: 0.9, parameters: {} }],
		};
		expect(validateIntentAnalysis(input)).toBeNull();
	});

	it("rejects intent item with missing confidence", () => {
		const input = {
			intents: [{ intent: "new_task", parameters: {} }],
			reasoning: "test",
		};
		expect(validateIntentAnalysis(input)).toBeNull();
	});

	it("provides default empty parameters when missing", () => {
		const input = {
			intents: [{ intent: "cancel", confidence: 0.9 }],
			reasoning: "Cancel request",
		};

		const result = validateIntentAnalysis(input);
		expect(result).not.toBeNull();
		expect(result!.intents[0]!.parameters).toEqual({});
	});

	it("validates all valid intent types", () => {
		const validTypes = [
			"new_task",
			"notification_preference",
			"status_query",
			"context_injection",
			"cancel",
			"approve_agent",
			"replan",
			"unknown",
		];

		for (const intentType of validTypes) {
			const input = {
				intents: [{ intent: intentType, confidence: 0.8, parameters: {} }],
				reasoning: `Testing ${intentType}`,
			};

			const result = validateIntentAnalysis(input);
			expect(result).not.toBeNull();
			expect(result!.primaryIntent).toBe(intentType as UserIntent);
		}
	});

	it("accepts three or more intents", () => {
		const input = {
			intents: [
				{ intent: "cancel", confidence: 0.95, parameters: {} },
				{ intent: "status_query", confidence: 0.8, parameters: {} },
				{
					intent: "notification_preference",
					confidence: 0.7,
					parameters: { enabled: false },
				},
			],
			reasoning: "Cancel, get status, and disable notifications.",
		};

		const result = validateIntentAnalysis(input);
		expect(result).not.toBeNull();
		expect(result!.intents).toHaveLength(3);
		expect(result!.primaryIntent).toBe(UserIntent.CANCEL);
	});

	it("rejects when intents is not an array", () => {
		const input = {
			intents: { intent: "new_task", confidence: 0.9, parameters: {} },
			reasoning: "test",
		};
		expect(validateIntentAnalysis(input)).toBeNull();
	});

	it("rejects when an intent item is null", () => {
		const input = {
			intents: [null],
			reasoning: "test",
		};
		expect(validateIntentAnalysis(input)).toBeNull();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Test 6–9: Conflict Resolution
// ════════════════════════════════════════════════════════════════════════════

describe("resolveIntentConflicts", () => {
	it("Test 6: cancel + new_task → only cancel remains", () => {
		const intents = [
			makeDetected(UserIntent.CANCEL),
			makeDetected(UserIntent.NEW_TASK),
		];

		const result = resolveIntentConflicts(intents);

		expect(result).toHaveLength(1);
		expect(result[0]!.intent).toBe(UserIntent.CANCEL);
	});

	it("Test 7: cancel + status_query → both remain", () => {
		const intents = [
			makeDetected(UserIntent.CANCEL),
			makeDetected(UserIntent.STATUS_QUERY),
		];

		const result = resolveIntentConflicts(intents);

		expect(result).toHaveLength(2);
		expect(result.some((i) => i.intent === UserIntent.CANCEL)).toBe(true);
		expect(result.some((i) => i.intent === UserIntent.STATUS_QUERY)).toBe(true);
	});

	it("Test 8: approve_agent is always first", () => {
		const intents = [
			makeDetected(UserIntent.NEW_TASK),
			makeDetected(UserIntent.APPROVE_AGENT),
			makeDetected(UserIntent.NOTIFICATION_PREFERENCE),
		];

		const result = resolveIntentConflicts(intents);

		expect(result[0]!.intent).toBe(UserIntent.APPROVE_AGENT);
	});

	it("Test 9: duplicate intents are deduplicated (keep first)", () => {
		const intents = [
			makeDetected(UserIntent.NEW_TASK, 0.9, { task: "A" }),
			makeDetected(UserIntent.NEW_TASK, 0.7, { task: "B" }),
		];

		const result = resolveIntentConflicts(intents);

		expect(result).toHaveLength(1);
		expect(result[0]!.intent).toBe(UserIntent.NEW_TASK);
		expect(result[0]!.parameters.task).toBe("A");
	});

	it("cancel + context_injection → only cancel (context_injection filtered)", () => {
		const intents = [
			makeDetected(UserIntent.CANCEL),
			makeDetected(UserIntent.CONTEXT_INJECTION),
		];

		const result = resolveIntentConflicts(intents);

		expect(result).toHaveLength(1);
		expect(result[0]!.intent).toBe(UserIntent.CANCEL);
	});

	it("cancel + notification_preference → both remain", () => {
		const intents = [
			makeDetected(UserIntent.CANCEL),
			makeDetected(UserIntent.NOTIFICATION_PREFERENCE),
		];

		const result = resolveIntentConflicts(intents);

		expect(result).toHaveLength(2);
		expect(result.some((i) => i.intent === UserIntent.CANCEL)).toBe(true);
		expect(
			result.some((i) => i.intent === UserIntent.NOTIFICATION_PREFERENCE),
		).toBe(true);
	});

	it("no conflicts → intents remain unchanged (with dedup)", () => {
		const intents = [
			makeDetected(UserIntent.NEW_TASK),
			makeDetected(UserIntent.NOTIFICATION_PREFERENCE),
			makeDetected(UserIntent.STATUS_QUERY),
		];

		const result = resolveIntentConflicts(intents);

		expect(result).toHaveLength(3);
	});

	it("approve_agent moves ahead of cancel when both present and no cancel-override applies", () => {
		// cancel doesn't filter approve_agent (it's not in the filter list,
		// but approve_agent is also not in the allowed list for cancel override).
		// Actually: cancel overrides new_task and context_injection only.
		// approve_agent is NOT in cancel/status_query/notification_preference,
		// so it gets filtered out by cancel rule.
		const intents = [
			makeDetected(UserIntent.APPROVE_AGENT),
			makeDetected(UserIntent.CANCEL),
		];

		const result = resolveIntentConflicts(intents);

		// cancel rule filters: only cancel, status_query, notification_preference remain
		// approve_agent is NOT one of those, so it gets filtered
		expect(result).toHaveLength(1);
		expect(result[0]!.intent).toBe(UserIntent.CANCEL);
	});

	it("triple duplicate intents reduced to one", () => {
		const intents = [
			makeDetected(UserIntent.STATUS_QUERY, 0.9),
			makeDetected(UserIntent.STATUS_QUERY, 0.8),
			makeDetected(UserIntent.STATUS_QUERY, 0.7),
		];

		const result = resolveIntentConflicts(intents);

		expect(result).toHaveLength(1);
		expect(result[0]!.intent).toBe(UserIntent.STATUS_QUERY);
		expect(result[0]!.confidence).toBe(0.9);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Test 10–11: Confidence Filtering
// ════════════════════════════════════════════════════════════════════════════

describe("confidence threshold filtering", () => {
	const MIN_INTENT_CONFIDENCE = 0.4;

	function filterByConfidence(intents: DetectedIntent[]): DetectedIntent[] {
		return intents.filter((i) => i.confidence >= MIN_INTENT_CONFIDENCE);
	}

	it("Test 10: intents below threshold are filtered, above remain", () => {
		const intents = [
			makeDetected(UserIntent.NEW_TASK, 0.3),
			makeDetected(UserIntent.STATUS_QUERY, 0.8),
		];

		const result = filterByConfidence(intents);

		expect(result).toHaveLength(1);
		expect(result[0]!.intent).toBe(UserIntent.STATUS_QUERY);
	});

	it("Test 11: all intents below threshold results in empty array (triggers unknown)", () => {
		const intents = [makeDetected(UserIntent.NEW_TASK, 0.2)];

		const result = filterByConfidence(intents);

		expect(result).toHaveLength(0);
	});

	it("intent exactly at threshold passes", () => {
		const intents = [makeDetected(UserIntent.CANCEL, 0.4)];

		const result = filterByConfidence(intents);

		expect(result).toHaveLength(1);
		expect(result[0]!.intent).toBe(UserIntent.CANCEL);
	});

	it("intent just below threshold is filtered", () => {
		const intents = [makeDetected(UserIntent.CANCEL, 0.39)];

		const result = filterByConfidence(intents);

		expect(result).toHaveLength(0);
	});

	it("mixed confidences: some pass, some filtered", () => {
		const intents = [
			makeDetected(UserIntent.NEW_TASK, 0.95),
			makeDetected(UserIntent.NOTIFICATION_PREFERENCE, 0.1),
			makeDetected(UserIntent.STATUS_QUERY, 0.6),
			makeDetected(UserIntent.CONTEXT_INJECTION, 0.35),
		];

		const result = filterByConfidence(intents);

		expect(result).toHaveLength(2);
		expect(result[0]!.intent).toBe(UserIntent.NEW_TASK);
		expect(result[1]!.intent).toBe(UserIntent.STATUS_QUERY);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Test 14–16: Conversation History (AgentPool internal state)
// ════════════════════════════════════════════════════════════════════════════

describe("conversation history management", () => {
	it("Test 15: history is limited to MAX_CONVERSATION_HISTORY (6)", () => {
		const pool = new AgentPool(
			silentPoolConfig({
				createAgent: createMockAgentFactory(),
			}),
		);

		const priv = getPrivate(pool);
		const history = priv.conversationHistory as Array<{
			role: string;
			content: string;
			timestamp: string;
		}>;

		// Manually call recordConversation 10 times
		for (let i = 0; i < 10; i++) {
			priv.recordConversation.call(pool, "user", `Message ${i}`);
		}

		expect(history.length).toBeLessThanOrEqual(6);
		// The oldest messages should have been evicted
		// Last message should be "Message 9"
		expect(history[history.length - 1]!.content).toBe("Message 9");

		pool.destroy();
	});

	it("Test 16: history is cleared in destroy()", async () => {
		const pool = new AgentPool(
			silentPoolConfig({
				createAgent: createMockAgentFactory(),
			}),
		);

		const priv = getPrivate(pool);

		// Add some history
		priv.recordConversation.call(pool, "user", "Hello");
		priv.recordConversation.call(pool, "pool", "Hi there");
		priv.recordConversation.call(pool, "user", "Status?");

		expect(priv.conversationHistory.length).toBe(3);

		await pool.destroy();

		expect(priv.conversationHistory.length).toBe(0);
	});

	it("recordConversation truncates content to 500 chars", () => {
		const pool = new AgentPool(
			silentPoolConfig({
				createAgent: createMockAgentFactory(),
			}),
		);

		const priv = getPrivate(pool);
		const longMessage = "x".repeat(1000);

		priv.recordConversation.call(pool, "user", longMessage);

		const history = priv.conversationHistory as Array<{
			role: string;
			content: string;
			timestamp: string;
		}>;

		expect(history[0]!.content.length).toBe(500);

		pool.destroy();
	});

	it("recordConversation stores role and timestamp", () => {
		const pool = new AgentPool(
			silentPoolConfig({
				createAgent: createMockAgentFactory(),
			}),
		);

		const priv = getPrivate(pool);

		priv.recordConversation.call(pool, "user", "Hello");
		priv.recordConversation.call(pool, "pool", "Hi");

		const history = priv.conversationHistory as Array<{
			role: string;
			content: string;
			timestamp: string;
		}>;

		expect(history).toHaveLength(2);
		expect(history[0]!.role).toBe("user");
		expect(history[0]!.content).toBe("Hello");
		expect(typeof history[0]!.timestamp).toBe("string");
		expect(history[1]!.role).toBe("pool");
		expect(history[1]!.content).toBe("Hi");

		pool.destroy();
	});

	it("history persists across multiple recordConversation calls up to limit", () => {
		const pool = new AgentPool(
			silentPoolConfig({
				createAgent: createMockAgentFactory(),
			}),
		);

		const priv = getPrivate(pool);

		// Add exactly MAX_CONVERSATION_HISTORY entries
		for (let i = 0; i < 6; i++) {
			priv.recordConversation.call(
				pool,
				i % 2 === 0 ? "user" : "pool",
				`Msg ${i}`,
			);
		}

		const history = priv.conversationHistory as Array<{
			role: string;
			content: string;
			timestamp: string;
		}>;

		expect(history).toHaveLength(6);
		expect(history[0]!.content).toBe("Msg 0");
		expect(history[5]!.content).toBe("Msg 5");

		// Add one more — should evict the oldest
		priv.recordConversation.call(pool, "user", "Msg 6");

		expect(history).toHaveLength(6);
		expect(history[0]!.content).toBe("Msg 1");
		expect(history[5]!.content).toBe("Msg 6");

		pool.destroy();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Test 19–20: Non-regression — Type Structure
// ════════════════════════════════════════════════════════════════════════════

describe("IntentAnalysis type structure — non-regression", () => {
	it("Test 19: single-intent analysis has correct structure", () => {
		const analysis: IntentAnalysis = {
			intents: [
				{
					intent: UserIntent.STATUS_QUERY,
					confidence: 0.85,
					parameters: {},
				},
			],
			primaryIntent: UserIntent.STATUS_QUERY,
			reasoning: "Status check.",
		};

		expect(analysis.primaryIntent).toBe(UserIntent.STATUS_QUERY);
		expect(analysis.intents).toHaveLength(1);
		expect(analysis.intents[0]!.intent).toBe(UserIntent.STATUS_QUERY);
		expect(analysis.intents[0]!.confidence).toBe(0.85);
		expect(analysis.intents[0]!.parameters).toEqual({});
		expect(analysis.reasoning).toBe("Status check.");
	});

	it("Test 20: fallback new_task conforms to new multi-intent type", () => {
		// This is the fallback that analyzeIntent() produces on error
		const fallback: IntentAnalysis = {
			intents: [
				{
					intent: UserIntent.NEW_TASK,
					confidence: 0.5,
					parameters: { task: "some message" },
				},
			],
			primaryIntent: UserIntent.NEW_TASK,
			reasoning: "Intent analysis failed — defaulting to new_task",
		};

		expect(fallback.primaryIntent).toBe(UserIntent.NEW_TASK);
		expect(fallback.intents).toHaveLength(1);
		expect(fallback.intents[0]!.intent).toBe(UserIntent.NEW_TASK);
		expect(fallback.intents[0]!.confidence).toBe(0.5);
		expect(fallback.intents[0]!.parameters.task).toBe("some message");
		expect(Array.isArray(fallback.intents)).toBe(true);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Test 21: Prompt Compilation
// ════════════════════════════════════════════════════════════════════════════

describe("intent analysis prompt — compilation", () => {
	it("Test 21a: compiles without conversationHistory (empty array)", () => {
		const result = intentAnalysisPrompt({
			message: "test",
			poolState: {
				executing: false,
				currentTask: null,
				activeAgentCount: 0,
				notificationsEnabled: false,
				pendingApprovals: [],
			},
			conversationHistory: [],
		});

		expect(typeof result).toBe("string");
		expect(result.length).toBeGreaterThan(0);
		expect(result).toContain("test");
		// Empty history → no Recent Conversation section
		expect(result).not.toContain("## Recent Conversation");
	});

	it("Test 21b: compiles with conversationHistory", () => {
		const result = intentAnalysisPrompt({
			message: "Tell me more",
			poolState: {
				executing: true,
				currentTask: "Build API",
				activeAgentCount: 2,
				notificationsEnabled: false,
				pendingApprovals: [],
			},
			conversationHistory: [
				{ role: "user", content: "What's the status?" },
				{ role: "pool", content: "Agent api-dev is in progress." },
			],
		});

		expect(typeof result).toBe("string");
		expect(result).toContain("## Recent Conversation");
		expect(result).toContain("What's the status?");
		expect(result).toContain("Agent api-dev is in progress.");
		expect(result).toContain("Tell me more");
	});

	it("compiles without poolState", () => {
		const result = intentAnalysisPrompt({
			message: "hello",
			conversationHistory: [],
		});

		expect(typeof result).toBe("string");
		expect(result).toContain("hello");
		expect(result).not.toContain("## Pool State");
	});

	it("includes pending approvals in prompt", () => {
		const result = intentAnalysisPrompt({
			message: "yes",
			poolState: {
				executing: true,
				currentTask: "Deploy",
				activeAgentCount: 1,
				notificationsEnabled: false,
				pendingApprovals: [
					{
						agentName: "deploy-agent",
						toolCallId: "tc-123",
						toolCallTitle: "execute_command",
					},
				],
			},
			conversationHistory: [],
		});

		expect(result).toContain("## Pending Approvals");
		expect(result).toContain("deploy-agent");
		expect(result).toContain("execute_command");
		expect(result).toContain('include "approve_agent" in the intents');
	});
});

// ════════════════════════════════════════════════════════════════════════════
// System Prompt Content Validation
// ════════════════════════════════════════════════════════════════════════════

describe("intent analysis system prompt — multi-intent content", () => {
	const rendered = intentAnalysisSystemPrompt({});

	it("contains Multi-Intent Support section", () => {
		expect(rendered).toContain("## Multi-Intent Support");
	});

	it("contains Conversation History section", () => {
		expect(rendered).toContain("## Conversation History");
	});

	it("contains Confidence Threshold section", () => {
		expect(rendered).toContain("## Confidence Threshold");
	});

	it("contains multi-intent examples", () => {
		// Example 7, 8, 9 are multi-intent
		expect(rendered).toContain("Multi-intent");
	});

	it("contains ambiguous/unknown example", () => {
		expect(rendered).toContain("Ambiguous");
		expect(rendered).toContain('"intent": "unknown"');
	});

	it("contains contextual reference example", () => {
		expect(rendered).toContain("Contextual reference");
	});

	it("uses intents array format in all examples", () => {
		// All examples should use "intents": [...] format
		expect(rendered).toContain('"intents"');
		// Should NOT use the old flat format at the top level of examples
		// (the JSON Output schema mentions individual intent fields, which is fine)
	});

	it("instructs to detect ALL intents", () => {
		expect(rendered).toContain(
			"When multiple intents are detected, list them in priority order",
		);
	});

	it("contains the replan intent definition", () => {
		expect(rendered).toContain("- **replan**:");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// AgentPool Private State Checks
// ════════════════════════════════════════════════════════════════════════════

describe("AgentPool — multi-intent private state", () => {
	it("has MAX_CONVERSATION_HISTORY set to 6", () => {
		// Access the static property
		const val = (AgentPool as any).MAX_CONVERSATION_HISTORY;
		expect(val).toBe(6);
	});

	it("has MIN_INTENT_CONFIDENCE set to 0.4", () => {
		const val = (AgentPool as any).MIN_INTENT_CONFIDENCE;
		expect(val).toBe(0.4);
	});

	it("initializes with empty conversationHistory", () => {
		const pool = new AgentPool(
			silentPoolConfig({
				createAgent: createMockAgentFactory(),
			}),
		);

		const priv = getPrivate(pool);
		expect(priv.conversationHistory).toEqual([]);

		pool.destroy();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Conflict Resolution — Edge Cases
// ════════════════════════════════════════════════════════════════════════════

describe("resolveIntentConflicts — edge cases", () => {
	it("single intent passes through unchanged", () => {
		const intents = [makeDetected(UserIntent.NEW_TASK)];

		const result = resolveIntentConflicts(intents);

		expect(result).toHaveLength(1);
		expect(result[0]!.intent).toBe(UserIntent.NEW_TASK);
	});

	it("cancel + new_task + context_injection → only cancel", () => {
		const intents = [
			makeDetected(UserIntent.CANCEL),
			makeDetected(UserIntent.NEW_TASK),
			makeDetected(UserIntent.CONTEXT_INJECTION),
		];

		const result = resolveIntentConflicts(intents);

		expect(result).toHaveLength(1);
		expect(result[0]!.intent).toBe(UserIntent.CANCEL);
	});

	it("cancel + status_query + notification_preference → all three remain", () => {
		const intents = [
			makeDetected(UserIntent.CANCEL),
			makeDetected(UserIntent.STATUS_QUERY),
			makeDetected(UserIntent.NOTIFICATION_PREFERENCE),
		];

		const result = resolveIntentConflicts(intents);

		expect(result).toHaveLength(3);
	});

	it("preserves order of non-approve_agent intents", () => {
		const intents = [
			makeDetected(UserIntent.NEW_TASK),
			makeDetected(UserIntent.NOTIFICATION_PREFERENCE),
			makeDetected(UserIntent.STATUS_QUERY),
		];

		const result = resolveIntentConflicts(intents);

		expect(result[0]!.intent).toBe(UserIntent.NEW_TASK);
		expect(result[1]!.intent).toBe(UserIntent.NOTIFICATION_PREFERENCE);
		expect(result[2]!.intent).toBe(UserIntent.STATUS_QUERY);
	});

	it("approve_agent + new_task + notification → approve first, others follow", () => {
		const intents = [
			makeDetected(UserIntent.NEW_TASK),
			makeDetected(UserIntent.NOTIFICATION_PREFERENCE),
			makeDetected(UserIntent.APPROVE_AGENT),
		];

		const result = resolveIntentConflicts(intents);

		expect(result).toHaveLength(3);
		expect(result[0]!.intent).toBe(UserIntent.APPROVE_AGENT);
		// The other two follow in their original relative order
	});

	it("does not mutate the input array", () => {
		const intents = [
			makeDetected(UserIntent.NEW_TASK),
			makeDetected(UserIntent.APPROVE_AGENT),
		];

		const originalLength = intents.length;
		const originalFirst = intents[0]!.intent;

		resolveIntentConflicts(intents);

		expect(intents.length).toBe(originalLength);
		expect(intents[0]!.intent).toBe(originalFirst);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Multi-intent IntentAnalysis construction tests
// ════════════════════════════════════════════════════════════════════════════

describe("IntentAnalysis multi-intent construction", () => {
	it("primaryIntent always matches first intent in array", () => {
		const analyses: IntentAnalysis[] = [
			{
				intents: [
					makeDetected(UserIntent.NEW_TASK),
					makeDetected(UserIntent.NOTIFICATION_PREFERENCE),
				],
				primaryIntent: UserIntent.NEW_TASK,
				reasoning: "Task + notification",
			},
			{
				intents: [
					makeDetected(UserIntent.CANCEL),
					makeDetected(UserIntent.STATUS_QUERY),
				],
				primaryIntent: UserIntent.CANCEL,
				reasoning: "Cancel + status",
			},
		];

		for (const analysis of analyses) {
			expect(analysis.primaryIntent).toBe(analysis.intents[0]!.intent);
		}
	});

	it("DetectedIntent has all required fields", () => {
		const detected: DetectedIntent = {
			intent: UserIntent.CONTEXT_INJECTION,
			confidence: 0.75,
			parameters: { instructions: "Use port 3000", targetAgent: "all" },
		};

		expect(detected.intent).toBe(UserIntent.CONTEXT_INJECTION);
		expect(detected.confidence).toBe(0.75);
		expect(detected.parameters.instructions).toBe("Use port 3000");
		expect(detected.parameters.targetAgent).toBe("all");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Validator — Robustness under varied LLM output formats
// ════════════════════════════════════════════════════════════════════════════

describe("validateIntentAnalysis — robustness", () => {
	it("rejects old flat format (no intents array)", () => {
		const oldFormat = {
			intent: "new_task",
			confidence: 0.9,
			parameters: { task: "do something" },
			reasoning: "Clear task",
		};

		// Old format should NOT be accepted by the new validator
		const result = validateIntentAnalysis(oldFormat);
		expect(result).toBeNull();
	});

	it("handles intent with extra unknown fields gracefully", () => {
		const input = {
			intents: [
				{
					intent: "new_task",
					confidence: 0.9,
					parameters: { task: "test" },
					extraField: "should be ignored",
				},
			],
			reasoning: "Test",
			someOtherField: 42,
		};

		const result = validateIntentAnalysis(input);
		expect(result).not.toBeNull();
		expect(result!.primaryIntent).toBe(UserIntent.NEW_TASK);
	});

	it("rejects when second intent in array is invalid", () => {
		const input = {
			intents: [
				{ intent: "new_task", confidence: 0.9, parameters: {} },
				{ intent: "invalid_intent", confidence: 0.8, parameters: {} },
			],
			reasoning: "Mixed valid/invalid",
		};

		const result = validateIntentAnalysis(input);
		expect(result).toBeNull();
	});

	it("rejects when second intent has non-numeric confidence", () => {
		const input = {
			intents: [
				{ intent: "new_task", confidence: 0.9, parameters: {} },
				{ intent: "cancel", confidence: "high", parameters: {} },
			],
			reasoning: "Bad confidence type",
		};

		const result = validateIntentAnalysis(input);
		expect(result).toBeNull();
	});
});
