import { describe, expect, it, mock } from "bun:test";

import { AgentStatus } from "../../../enums/agent-status.enum.ts";
import { DeltaType } from "../enums.ts";
import { NotificationEngine } from "../notification-engine.ts";
import type { ContextDelta } from "../types.ts";
import { silentLogger } from "./test-helpers.ts";

// ════════════════════════════════════════════════════════════════════════════
// NotificationEngine Unit Tests
// ════════════════════════════════════════════════════════════════════════════

describe("NotificationEngine", () => {
	it("returns null when no preference is set (silence by default)", async () => {
		const mockConversations = {
			sendOneShotJson: mock(() =>
				Promise.resolve({
					shouldNotify: true,
					reasoning: "test",
					message: "hello",
				}),
			),
			has: mock(() => true),
		} as any;

		const engine = new NotificationEngine(mockConversations, silentLogger());

		const delta: ContextDelta = {
			agentId: "agent-1",
			agentName: "Alpha",
			timestamp: new Date().toISOString(),
			type: DeltaType.PROMPT_COMPLETE,
			summary: "Prompt completed",
			data: {},
			significance: 0.9,
		};

		const agentState = {
			agentId: "agent-1",
			agentName: "Alpha",
			taskDescription: "Do something",
			taskRole: "general",
			status: AgentStatus.IDLE,
			events: [],
			promptResults: [],
			lastDelta: delta,
			filesWritten: [],
			filesRead: [],
			completed: false,
			error: null,
		};

		const result = await engine.evaluate(delta, agentState);
		expect(result).toBeNull();
		// LLM should NOT have been called
		expect(mockConversations.sendOneShotJson).not.toHaveBeenCalled();
	});

	it("returns null when notifications are disabled", async () => {
		const mockConversations = {
			sendOneShotJson: mock(() =>
				Promise.resolve({
					shouldNotify: true,
					reasoning: "test",
					message: "hello",
				}),
			),
		} as any;

		const engine = new NotificationEngine(mockConversations, silentLogger());
		engine.setPreference({ enabled: false });

		const delta: ContextDelta = {
			agentId: "agent-1",
			agentName: "Alpha",
			timestamp: new Date().toISOString(),
			type: DeltaType.PROMPT_COMPLETE,
			summary: "Prompt completed",
			data: {},
			significance: 0.9,
		};

		const result = await engine.evaluate(delta, {
			agentId: "agent-1",
			agentName: "Alpha",
			taskDescription: "Do something",
			taskRole: "general",
			status: AgentStatus.IDLE,
			events: [],
			promptResults: [],
			lastDelta: delta,
			filesWritten: [],
			filesRead: [],
			completed: false,
			error: null,
		});

		expect(result).toBeNull();
		expect(mockConversations.sendOneShotJson).not.toHaveBeenCalled();
	});

	it("returns null when delta significance is below threshold", async () => {
		const mockConversations = {
			sendOneShotJson: mock(() =>
				Promise.resolve({
					shouldNotify: true,
					reasoning: "test",
					message: "hello",
				}),
			),
		} as any;

		const engine = new NotificationEngine(mockConversations, silentLogger());
		engine.setPreference({ enabled: true, minSignificance: 0.8 });

		const delta: ContextDelta = {
			agentId: "agent-1",
			agentName: "Alpha",
			timestamp: new Date().toISOString(),
			type: DeltaType.TOOL_COMPLETE,
			summary: "Tool completed",
			data: {},
			significance: 0.5, // Below threshold of 0.8
		};

		const result = await engine.evaluate(delta, {
			agentId: "agent-1",
			agentName: "Alpha",
			taskDescription: "Do something",
			taskRole: "general",
			status: AgentStatus.IDLE,
			events: [],
			promptResults: [],
			lastDelta: delta,
			filesWritten: [],
			filesRead: [],
			completed: false,
			error: null,
		});

		expect(result).toBeNull();
		expect(mockConversations.sendOneShotJson).not.toHaveBeenCalled();
	});

	it("returns null when delta type is not in user's interested types", async () => {
		const mockConversations = {
			sendOneShotJson: mock(() =>
				Promise.resolve({
					shouldNotify: true,
					reasoning: "test",
					message: "hello",
				}),
			),
		} as any;

		const engine = new NotificationEngine(mockConversations, silentLogger());
		engine.setPreference({
			enabled: true,
			minSignificance: 0.1,
			types: [DeltaType.AGENT_ERROR], // Only interested in errors
		});

		const delta: ContextDelta = {
			agentId: "agent-1",
			agentName: "Alpha",
			timestamp: new Date().toISOString(),
			type: DeltaType.TOOL_COMPLETE, // Not an error
			summary: "Tool completed",
			data: {},
			significance: 0.9,
		};

		const result = await engine.evaluate(delta, {
			agentId: "agent-1",
			agentName: "Alpha",
			taskDescription: "Do something",
			taskRole: "general",
			status: AgentStatus.IDLE,
			events: [],
			promptResults: [],
			lastDelta: delta,
			filesWritten: [],
			filesRead: [],
			completed: false,
			error: null,
		});

		expect(result).toBeNull();
	});

	it("calls LLM and returns notification when all filters pass", async () => {
		const mockConversations = {
			sendOneShotJson: mock(() =>
				Promise.resolve({
					shouldNotify: true,
					reasoning: "The agent completed an important task",
					message: "Agent Alpha has completed the API implementation.",
				}),
			),
		} as any;

		const engine = new NotificationEngine(mockConversations, silentLogger());
		engine.setPreference({ enabled: true, minSignificance: 0.3 });

		const delta: ContextDelta = {
			agentId: "agent-1",
			agentName: "Alpha",
			timestamp: new Date().toISOString(),
			type: DeltaType.PROMPT_COMPLETE,
			summary: "Prompt completed",
			data: {},
			significance: 0.8,
		};

		const result = await engine.evaluate(delta, {
			agentId: "agent-1",
			agentName: "Alpha",
			taskDescription: "Build the API",
			taskRole: "api-developer",
			status: AgentStatus.IDLE,
			events: [],
			promptResults: [],
			lastDelta: delta,
			filesWritten: [],
			filesRead: [],
			completed: false,
			error: null,
		});

		expect(result).not.toBeNull();
		expect(result!.message).toBe(
			"Agent Alpha has completed the API implementation.",
		);
		expect(result!.agentId).toBe("agent-1");
		expect(result!.agentName).toBe("Alpha");
		expect(result!.type).toBe(DeltaType.PROMPT_COMPLETE);
		expect(engine.notificationCount).toBe(1);
		expect(engine.evaluationCount).toBe(1);
	});

	it("returns null when LLM decides not to notify", async () => {
		const mockConversations = {
			sendOneShotJson: mock(() =>
				Promise.resolve({
					shouldNotify: false,
					reasoning: "This is routine progress, not noteworthy",
					message: "",
				}),
			),
		} as any;

		const engine = new NotificationEngine(mockConversations, silentLogger());
		engine.setPreference({ enabled: true, minSignificance: 0.3 });

		const delta: ContextDelta = {
			agentId: "agent-1",
			agentName: "Alpha",
			timestamp: new Date().toISOString(),
			type: DeltaType.STATUS_CHANGE,
			summary: "Agent became idle",
			data: {},
			significance: 0.3,
		};

		const result = await engine.evaluate(delta, {
			agentId: "agent-1",
			agentName: "Alpha",
			taskDescription: "Build the API",
			taskRole: "api-developer",
			status: AgentStatus.IDLE,
			events: [],
			promptResults: [],
			lastDelta: delta,
			filesWritten: [],
			filesRead: [],
			completed: false,
			error: null,
		});

		expect(result).toBeNull();
		expect(engine.notificationCount).toBe(0);
		expect(engine.evaluationCount).toBe(1);
	});

	it("returns null when LLM call fails (graceful degradation)", async () => {
		const mockConversations = {
			sendOneShotJson: mock(() => Promise.reject(new Error("Network error"))),
		} as any;

		const engine = new NotificationEngine(mockConversations, silentLogger());
		engine.setPreference({ enabled: true, minSignificance: 0.3 });

		const delta: ContextDelta = {
			agentId: "agent-1",
			agentName: "Alpha",
			timestamp: new Date().toISOString(),
			type: DeltaType.PROMPT_COMPLETE,
			summary: "Prompt completed",
			data: {},
			significance: 0.8,
		};

		const result = await engine.evaluate(delta, {
			agentId: "agent-1",
			agentName: "Alpha",
			taskDescription: "Build the API",
			taskRole: "api-developer",
			status: AgentStatus.IDLE,
			events: [],
			promptResults: [],
			lastDelta: delta,
			filesWritten: [],
			filesRead: [],
			completed: false,
			error: null,
		});

		// Should not throw, should return null (silence on failure)
		expect(result).toBeNull();
	});

	it("manages preferences correctly", () => {
		const engine = new NotificationEngine({} as any, silentLogger());

		expect(engine.isEnabled).toBe(false);
		expect(engine.getPreference()).toBeNull();

		engine.setPreference({ enabled: true, minSignificance: 0.7 });
		expect(engine.isEnabled).toBe(true);
		expect(engine.getPreference()!.enabled).toBe(true);
		expect(engine.getPreference()!.minSignificance).toBe(0.7);

		engine.clearPreference();
		expect(engine.isEnabled).toBe(false);
		expect(engine.getPreference()).toBeNull();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Notification conditional behavior
// ════════════════════════════════════════════════════════════════════════════

describe("Notification conditional behavior", () => {
	it("notification is conditional — only fires when user has preference", async () => {
		const llmCalls: string[] = [];
		const mockConversations = {
			sendOneShotJson: mock((..._args: any[]) => {
				llmCalls.push("sendOneShotJson");
				return Promise.resolve({
					shouldNotify: true,
					reasoning: "important",
					message: "Something happened",
				});
			}),
		} as any;

		const engine = new NotificationEngine(mockConversations, silentLogger());

		const delta: ContextDelta = {
			agentId: "a1",
			agentName: "Alpha",
			timestamp: new Date().toISOString(),
			type: DeltaType.PROMPT_COMPLETE,
			summary: "Done",
			data: {},
			significance: 0.9,
		};

		const agentState = {
			agentId: "a1",
			agentName: "Alpha",
			taskDescription: "task",
			taskRole: "role",
			status: AgentStatus.IDLE,
			events: [],
			promptResults: [],
			lastDelta: delta,
			filesWritten: [],
			filesRead: [],
			completed: false,
			error: null,
		};

		// No preference → silence
		const r1 = await engine.evaluate(delta, agentState);
		expect(r1).toBeNull();
		expect(llmCalls).toHaveLength(0);

		// Set preference → LLM is called
		engine.setPreference({ enabled: true, minSignificance: 0.3 });
		const r2 = await engine.evaluate(delta, agentState);
		expect(r2).not.toBeNull();
		expect(llmCalls).toHaveLength(1);

		// Disable → silence again
		engine.setPreference({ enabled: false });
		const r3 = await engine.evaluate(delta, agentState);
		expect(r3).toBeNull();
		expect(llmCalls).toHaveLength(1); // No new LLM call
	});
});
