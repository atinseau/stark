import { describe, expect, it, mock } from "bun:test";

import { DeltaType } from "../../../enums/delta-type.enum.ts";
import { PoolEvent } from "../../../enums/pool-event.enum.ts";
import {
	type ContextDelta,
	ContextInjectionCategory,
	ContextInjectionPriority,
	type StructuredContextInjection,
	type SubTask,
} from "../../../types/agent-pool.types.ts";
import { AgentPool } from "../agent-pool.ts";
import { createMockAgent, silentPoolConfig } from "./test-helpers.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeDelta(overrides?: Partial<ContextDelta>): ContextDelta {
	return {
		agentId: overrides?.agentId ?? "agent-1",
		agentName: overrides?.agentName ?? "Alpha",
		timestamp: overrides?.timestamp ?? new Date().toISOString(),
		type: overrides?.type ?? DeltaType.TOOL_COMPLETE,
		summary: overrides?.summary ?? "Tool completed",
		data: overrides?.data ?? {},
		significance: overrides?.significance ?? 0.7,
		promptResultSummary: overrides?.promptResultSummary ?? null,
	};
}

function setupPoolWithTwoAgents(): {
	pool: AgentPool;
	mockAgent1: ReturnType<typeof createMockAgent>;
	mockAgent2: ReturnType<typeof createMockAgent>;
} {
	const mockAgent1 = createMockAgent({ id: "agent-1", name: "Alpha" });
	const mockAgent2 = createMockAgent({ id: "agent-2", name: "Beta" });

	let agentIdx = 0;
	const agents = [mockAgent1, mockAgent2];

	const pool = new AgentPool(
		silentPoolConfig({
			createAgent: () => agents[agentIdx++] ?? createMockAgent(),
		}),
	);

	const subtask1: SubTask = {
		id: "t1",
		prompt: "Do work",
		role: "role1",
		dependencies: [],
		priority: 1,
	};
	const subtask2: SubTask = {
		id: "t2",
		prompt: "Do other work",
		role: "role2",
		dependencies: [],
		priority: 2,
	};

	const tracker = (pool as any).contextTracker;
	tracker.registerAgent("agent-1", "Alpha", subtask1);
	tracker.registerAgent("agent-2", "Beta", subtask2);

	return { pool, mockAgent1, mockAgent2 };
}

// ── Test 15: Agent.injectContext() accepts both modes ───────────────────────

describe("Agent injectContext — dual mode support (via mock)", () => {
	it("accepts a raw string without error", () => {
		const agent = createMockAgent();
		expect(() => agent.injectContext("raw string")).not.toThrow();
	});

	it("accepts a StructuredContextInjection without error", () => {
		const agent = createMockAgent();
		const injection: StructuredContextInjection = {
			content: "Structured info",
			priority: ContextInjectionPriority.CRITICAL,
			category: ContextInjectionCategory.DEPENDENCY_OUTPUT,
			source: "api-dev",
			dependencyType: "blocking",
			timestamp: new Date().toISOString(),
		};
		expect(() => agent.injectContext(injection)).not.toThrow();
	});

	it("emits CONTEXT_INJECTED event for both modes", () => {
		const agent = createMockAgent();
		const events: unknown[] = [];

		agent.on("context:injected", (e: unknown) => events.push(e));

		agent.injectContext("legacy string");
		agent.injectContext({
			content: "Structured",
			priority: ContextInjectionPriority.HIGH,
			category: ContextInjectionCategory.SHARED_CONTEXT,
			source: "test",
			dependencyType: null,
			timestamp: new Date().toISOString(),
		});

		expect(events.length).toBe(2);
	});
});

// ── Test 16: AgentPool.handleDelta() injects structured for blocking deps ───

describe("AgentPool handleDelta — structured injection for blocking dependency", () => {
	it("injects CRITICAL priority with DEPENDENCY_OUTPUT category for blocking deps", async () => {
		const { pool, mockAgent2 } = setupPoolWithTwoAgents();

		// Set up subtask-to-agent and agent-to-subtask mappings
		(pool as any).subtaskToAgent.set("t1", "agent-1");
		(pool as any).subtaskToAgent.set("t2", "agent-2");
		(pool as any).agentToSubtask.set("agent-1", "t1");
		(pool as any).agentToSubtask.set("agent-2", "t2");

		// Track what gets injected
		let injectedArg: string | StructuredContextInjection | null = null;
		const originalInject = mockAgent2.injectContext;
		(mockAgent2 as any).injectContext = (
			arg: string | StructuredContextInjection,
		) => {
			injectedArg = arg;
			originalInject.call(mockAgent2, arg);
		};

		// Create a mock broker that approves sharing with blocking dep info
		const mockBroker = {
			evaluate: mock(async () => [
				{
					shouldShare: true,
					reasoning: "Critical info",
					sourceAgentId: "agent-1",
					targetAgentId: "agent-2",
					information: "API schema is ready",
				},
			]),
			evaluateWithFullResult: mock(async () => []),
			recordSharing: mock(() => undefined),
			updateSignificanceContext: mock(() => undefined),
			findDependencyBySubtaskIds: mock((from: string, to: string) => {
				if ((from === "t1" && to === "t2") || (from === "t2" && to === "t1")) {
					return { from: "t1", to: "t2", type: "blocking" as const };
				}
				return null;
			}),
		};

		(pool as any).informationBroker = mockBroker;

		// Register agent-2 in managedAgents map
		(pool as any).managedAgents.set("agent-2", {
			agent: mockAgent2,
			subtask: {
				id: "t2",
				prompt: "Do other work",
				role: "role2",
				dependencies: ["t1"],
				priority: 2,
			},
			result: null,
		});
		(pool as any).managedAgents.set("agent-1", {
			agent: createMockAgent({ id: "agent-1", name: "Alpha" }),
			subtask: {
				id: "t1",
				prompt: "Do work",
				role: "role1",
				dependencies: [],
				priority: 1,
			},
			result: null,
		});

		const delta = makeDelta({
			agentId: "agent-1",
			agentName: "Alpha",
			significance: 0.9,
		});

		await (pool as any).handleDelta(delta);

		// Should have been called with a structured injection
		expect(injectedArg).not.toBeNull();
		expect(typeof injectedArg).toBe("object");

		const structured = injectedArg! as unknown as StructuredContextInjection;
		expect(structured.priority).toBe(ContextInjectionPriority.CRITICAL);
		expect(structured.category).toBe(
			ContextInjectionCategory.DEPENDENCY_OUTPUT,
		);
		expect(structured.dependencyType).toBe("blocking");
		expect(structured.content).toBe("API schema is ready");
		expect(structured.source).toBeDefined();
	});
});

// ── Test 17: AgentPool.handleDelta() injects HIGH for informational deps ────

describe("AgentPool handleDelta — structured injection for informational dependency", () => {
	it("injects HIGH priority with DEPENDENCY_OUTPUT category for informational deps", async () => {
		const { pool, mockAgent2 } = setupPoolWithTwoAgents();

		(pool as any).subtaskToAgent.set("t1", "agent-1");
		(pool as any).subtaskToAgent.set("t2", "agent-2");
		(pool as any).agentToSubtask.set("agent-1", "t1");
		(pool as any).agentToSubtask.set("agent-2", "t2");

		let injectedArg: string | StructuredContextInjection | null = null;
		const originalInject = mockAgent2.injectContext;
		(mockAgent2 as any).injectContext = (
			arg: string | StructuredContextInjection,
		) => {
			injectedArg = arg;
			originalInject.call(mockAgent2, arg);
		};

		const mockBroker = {
			evaluate: mock(async () => [
				{
					shouldShare: true,
					reasoning: "Useful info",
					sourceAgentId: "agent-1",
					targetAgentId: "agent-2",
					information: "Using Zod for validation",
				},
			]),
			evaluateWithFullResult: mock(async () => []),
			recordSharing: mock(() => undefined),
			updateSignificanceContext: mock(() => undefined),
			findDependencyBySubtaskIds: mock((from: string, to: string) => {
				if ((from === "t1" && to === "t2") || (from === "t2" && to === "t1")) {
					return { from: "t1", to: "t2", type: "informational" as const };
				}
				return null;
			}),
		};

		(pool as any).informationBroker = mockBroker;

		(pool as any).managedAgents.set("agent-2", {
			agent: mockAgent2,
			subtask: {
				id: "t2",
				prompt: "Do other work",
				role: "role2",
				dependencies: ["t1"],
				priority: 2,
			},
			result: null,
		});
		(pool as any).managedAgents.set("agent-1", {
			agent: createMockAgent({ id: "agent-1", name: "Alpha" }),
			subtask: {
				id: "t1",
				prompt: "Do work",
				role: "role1",
				dependencies: [],
				priority: 1,
			},
			result: null,
		});

		const delta = makeDelta({ agentId: "agent-1", significance: 0.7 });

		await (pool as any).handleDelta(delta);

		expect(injectedArg).not.toBeNull();
		expect(typeof injectedArg).toBe("object");

		const structured = injectedArg! as unknown as StructuredContextInjection;
		expect(structured.priority).toBe(ContextInjectionPriority.HIGH);
		expect(structured.category).toBe(
			ContextInjectionCategory.DEPENDENCY_OUTPUT,
		);
		expect(structured.dependencyType).toBe("informational");
	});
});

// ── Test 18: AgentPool.handleDelta() injects NORMAL without dependency ──────

describe("AgentPool handleDelta — structured injection without dependency", () => {
	it("injects NORMAL priority with SHARED_CONTEXT category when no dependency", async () => {
		const { pool, mockAgent2 } = setupPoolWithTwoAgents();

		(pool as any).subtaskToAgent.set("t1", "agent-1");
		(pool as any).subtaskToAgent.set("t2", "agent-2");
		(pool as any).agentToSubtask.set("agent-1", "t1");
		(pool as any).agentToSubtask.set("agent-2", "t2");

		let injectedArg: string | StructuredContextInjection | null = null;
		const originalInject = mockAgent2.injectContext;
		(mockAgent2 as any).injectContext = (
			arg: string | StructuredContextInjection,
		) => {
			injectedArg = arg;
			originalInject.call(mockAgent2, arg);
		};

		const mockBroker = {
			evaluate: mock(async () => [
				{
					shouldShare: true,
					reasoning: "Might help",
					sourceAgentId: "agent-1",
					targetAgentId: "agent-2",
					information: "FYI: using port 5000",
				},
			]),
			evaluateWithFullResult: mock(async () => []),
			recordSharing: mock(() => undefined),
			updateSignificanceContext: mock(() => undefined),
			findDependencyBySubtaskIds: mock(() => null),
		};

		(pool as any).informationBroker = mockBroker;

		(pool as any).managedAgents.set("agent-2", {
			agent: mockAgent2,
			subtask: {
				id: "t2",
				prompt: "Do other work",
				role: "role2",
				dependencies: [],
				priority: 2,
			},
			result: null,
		});
		(pool as any).managedAgents.set("agent-1", {
			agent: createMockAgent({ id: "agent-1", name: "Alpha" }),
			subtask: {
				id: "t1",
				prompt: "Do work",
				role: "role1",
				dependencies: [],
				priority: 1,
			},
			result: null,
		});

		const delta = makeDelta({ agentId: "agent-1", significance: 0.7 });

		await (pool as any).handleDelta(delta);

		expect(injectedArg).not.toBeNull();
		expect(typeof injectedArg).toBe("object");

		const structured = injectedArg! as unknown as StructuredContextInjection;
		expect(structured.priority).toBe(ContextInjectionPriority.NORMAL);
		expect(structured.category).toBe(ContextInjectionCategory.SHARED_CONTEXT);
		expect(structured.dependencyType).toBeNull();
	});

	it("injects HIGH priority when no dependency but significance >= 0.8", async () => {
		const { pool, mockAgent2 } = setupPoolWithTwoAgents();

		(pool as any).subtaskToAgent.set("t1", "agent-1");
		(pool as any).subtaskToAgent.set("t2", "agent-2");
		(pool as any).agentToSubtask.set("agent-1", "t1");
		(pool as any).agentToSubtask.set("agent-2", "t2");

		let injectedArg: string | StructuredContextInjection | null = null;
		const originalInject = mockAgent2.injectContext;
		(mockAgent2 as any).injectContext = (
			arg: string | StructuredContextInjection,
		) => {
			injectedArg = arg;
			originalInject.call(mockAgent2, arg);
		};

		const mockBroker = {
			evaluate: mock(async () => [
				{
					shouldShare: true,
					reasoning: "Significant event",
					sourceAgentId: "agent-1",
					targetAgentId: "agent-2",
					information: "Major change detected",
				},
			]),
			evaluateWithFullResult: mock(async () => []),
			recordSharing: mock(() => undefined),
			updateSignificanceContext: mock(() => undefined),
			findDependencyBySubtaskIds: mock(() => null),
		};

		(pool as any).informationBroker = mockBroker;

		(pool as any).managedAgents.set("agent-2", {
			agent: mockAgent2,
			subtask: {
				id: "t2",
				prompt: "Do other work",
				role: "role2",
				dependencies: [],
				priority: 2,
			},
			result: null,
		});
		(pool as any).managedAgents.set("agent-1", {
			agent: createMockAgent({ id: "agent-1", name: "Alpha" }),
			subtask: {
				id: "t1",
				prompt: "Do work",
				role: "role1",
				dependencies: [],
				priority: 1,
			},
			result: null,
		});

		// Significance >= 0.8 → HIGH priority even without dependency
		const delta = makeDelta({ agentId: "agent-1", significance: 0.85 });

		await (pool as any).handleDelta(delta);

		expect(injectedArg).not.toBeNull();
		const structured = injectedArg! as unknown as StructuredContextInjection;
		expect(structured.priority).toBe(ContextInjectionPriority.HIGH);
		expect(structured.category).toBe(ContextInjectionCategory.SHARED_CONTEXT);
	});
});

// ── Test 19: AgentPool.send() CONTEXT_INJECTION uses structured mode ────────

describe("AgentPool send — CONTEXT_INJECTION uses structured injection", () => {
	it("injects with HIGH priority, USER_INSTRUCTION category, and 'user' source", async () => {
		const mockAgent = createMockAgent({ id: "agent-x", name: "TestAgent" });

		const pool = new AgentPool(
			silentPoolConfig({
				createAgent: () => mockAgent,
			}),
		);

		// Register agent in managedAgents
		(pool as any).managedAgents.set("agent-x", {
			agent: mockAgent,
			subtask: {
				id: "t1",
				prompt: "Work",
				role: "worker",
				dependencies: [],
				priority: 1,
			},
			result: null,
		});

		let injectedArg: string | StructuredContextInjection | null = null;
		const originalInject = mockAgent.injectContext;
		(mockAgent as any).injectContext = (
			arg: string | StructuredContextInjection,
		) => {
			injectedArg = arg;
			originalInject.call(mockAgent, arg);
		};

		// Mock the intent analyzer to return CONTEXT_INJECTION
		(pool as any).analyzeIntent = mock(async () => ({
			intent: "context_injection",
			confidence: 0.95,
			parameters: { instructions: "Use port 3000" },
			reasoning: "User wants to inject context",
		}));

		// Mock model validation
		(pool as any).conversations = {
			...(pool as any).conversations,
			client: { validateModel: async () => {} },
		};

		const result = await pool.send("Use port 3000");

		expect(result).toContain("Context injected into 1 active agent(s)");
		expect(injectedArg).not.toBeNull();
		expect(typeof injectedArg).toBe("object");

		const structured = injectedArg! as unknown as StructuredContextInjection;
		expect(structured.priority).toBe(ContextInjectionPriority.HIGH);
		expect(structured.category).toBe(ContextInjectionCategory.USER_INSTRUCTION);
		expect(structured.source).toBe("user");
		expect(structured.dependencyType).toBeNull();
		expect(structured.content).toBe("Use port 3000");
	});
});

// ── Test: handleDelta still records sharing after structured injection ───────

describe("AgentPool handleDelta — recordSharing still called after structured injection", () => {
	it("calls recordSharing for deduplication after successful structured injection", async () => {
		const { pool, mockAgent2 } = setupPoolWithTwoAgents();

		(pool as any).subtaskToAgent.set("t1", "agent-1");
		(pool as any).subtaskToAgent.set("t2", "agent-2");
		(pool as any).agentToSubtask.set("agent-1", "t1");
		(pool as any).agentToSubtask.set("agent-2", "t2");

		const recordSharingMock = mock(() => undefined);

		const mockBroker = {
			evaluate: mock(async () => [
				{
					shouldShare: true,
					reasoning: "Share it",
					sourceAgentId: "agent-1",
					targetAgentId: "agent-2",
					information: "Some info",
				},
			]),
			evaluateWithFullResult: mock(async () => []),
			recordSharing: recordSharingMock,
			updateSignificanceContext: mock(() => undefined),
			findDependencyBySubtaskIds: mock(() => null),
		};

		(pool as any).informationBroker = mockBroker;

		(pool as any).managedAgents.set("agent-2", {
			agent: mockAgent2,
			subtask: {
				id: "t2",
				prompt: "Work",
				role: "role2",
				dependencies: [],
				priority: 2,
			},
			result: null,
		});
		(pool as any).managedAgents.set("agent-1", {
			agent: createMockAgent({ id: "agent-1", name: "Alpha" }),
			subtask: {
				id: "t1",
				prompt: "Work",
				role: "role1",
				dependencies: [],
				priority: 1,
			},
			result: null,
		});

		const delta = makeDelta({ agentId: "agent-1" });

		await (pool as any).handleDelta(delta);

		expect(recordSharingMock).toHaveBeenCalledTimes(1);
	});
});

// ── Test: handleDelta emits CONTEXT_SHARED event with structured injection ──

describe("AgentPool handleDelta — CONTEXT_SHARED event emitted with structured injection", () => {
	it("emits CONTEXT_SHARED event after structured injection", async () => {
		const { pool, mockAgent2 } = setupPoolWithTwoAgents();

		(pool as any).subtaskToAgent.set("t1", "agent-1");
		(pool as any).subtaskToAgent.set("t2", "agent-2");
		(pool as any).agentToSubtask.set("agent-1", "t1");
		(pool as any).agentToSubtask.set("agent-2", "t2");

		const mockBroker = {
			evaluate: mock(async () => [
				{
					shouldShare: true,
					reasoning: "Share it",
					sourceAgentId: "agent-1",
					targetAgentId: "agent-2",
					information: "Important data",
				},
			]),
			evaluateWithFullResult: mock(async () => []),
			recordSharing: mock(() => undefined),
			updateSignificanceContext: mock(() => undefined),
			findDependencyBySubtaskIds: mock(() => null),
		};

		(pool as any).informationBroker = mockBroker;

		(pool as any).managedAgents.set("agent-2", {
			agent: mockAgent2,
			subtask: {
				id: "t2",
				prompt: "Work",
				role: "role2",
				dependencies: [],
				priority: 2,
			},
			result: null,
		});
		(pool as any).managedAgents.set("agent-1", {
			agent: createMockAgent({ id: "agent-1", name: "Alpha" }),
			subtask: {
				id: "t1",
				prompt: "Work",
				role: "role1",
				dependencies: [],
				priority: 1,
			},
			result: null,
		});

		const contextSharedEvents: unknown[] = [];
		pool.on(PoolEvent.CONTEXT_SHARED, ((e: unknown) =>
			contextSharedEvents.push(e)) as any);

		const delta = makeDelta({ agentId: "agent-1" });
		await (pool as any).handleDelta(delta);

		expect(contextSharedEvents.length).toBe(1);
		const event = contextSharedEvents[0] as any;
		expect(event.sourceAgentId).toBe("agent-1");
		expect(event.targetAgentId).toBe("agent-2");
		expect(event.information).toBe("Important data");
	});
});

// ── Test: InformationBroker.findDependencyBySubtaskIds ──────────────────────

describe("InformationBroker — findDependencyBySubtaskIds", () => {
	it("is exposed as a public method on the broker", async () => {
		const { pool } = setupPoolWithTwoAgents();

		// Set up dependencies and mappings
		(pool as any).subtaskToAgent.set("t1", "agent-1");
		(pool as any).subtaskToAgent.set("t2", "agent-2");
		(pool as any).agentToSubtask.set("agent-1", "t1");
		(pool as any).agentToSubtask.set("agent-2", "t2");

		// Create broker with actual dependencies
		const { InformationBroker } = await import("../information-broker.ts");
		const { ContextTracker } = await import("../context-tracker.ts");

		const tracker = new ContextTracker();

		const dependencies = [{ from: "t1", to: "t2", type: "blocking" as const }];

		const broker = new InformationBroker(
			{} as any, // conversations (not used for this test)
			tracker,
			dependencies,
			{
				level: "silent",
				info: () => {},
				debug: () => {},
				warn: () => {},
			} as any,
			new Map([
				["t1", "agent-1"],
				["t2", "agent-2"],
			]),
			new Map([
				["agent-1", "t1"],
				["agent-2", "t2"],
			]),
		);

		// Test findDependencyBySubtaskIds
		const dep = broker.findDependencyBySubtaskIds("t1", "t2");
		expect(dep).not.toBeNull();
		expect(dep!.from).toBe("t1");
		expect(dep!.to).toBe("t2");
		expect(dep!.type).toBe("blocking");

		// Test reverse direction
		const depReverse = broker.findDependencyBySubtaskIds("t2", "t1");
		expect(depReverse).not.toBeNull();
		expect(depReverse!.type).toBe("blocking");

		// Test non-existent dependency
		const depNone = broker.findDependencyBySubtaskIds("t1", "t-nonexistent");
		expect(depNone).toBeNull();
	});
});

// ── Test: Structured injection includes timestamp ───────────────────────────

describe("AgentPool handleDelta — structured injection has timestamp", () => {
	it("sets a valid ISO-8601 timestamp on the structured injection", async () => {
		const { pool, mockAgent2 } = setupPoolWithTwoAgents();

		(pool as any).subtaskToAgent.set("t1", "agent-1");
		(pool as any).subtaskToAgent.set("t2", "agent-2");
		(pool as any).agentToSubtask.set("agent-1", "t1");
		(pool as any).agentToSubtask.set("agent-2", "t2");

		let injectedArg: string | StructuredContextInjection | null = null;
		const originalInject = mockAgent2.injectContext;
		(mockAgent2 as any).injectContext = (
			arg: string | StructuredContextInjection,
		) => {
			injectedArg = arg;
			originalInject.call(mockAgent2, arg);
		};

		const mockBroker = {
			evaluate: mock(async () => [
				{
					shouldShare: true,
					reasoning: "Share",
					sourceAgentId: "agent-1",
					targetAgentId: "agent-2",
					information: "Data",
				},
			]),
			evaluateWithFullResult: mock(async () => []),
			recordSharing: mock(() => undefined),
			updateSignificanceContext: mock(() => undefined),
			findDependencyBySubtaskIds: mock(() => null),
		};

		(pool as any).informationBroker = mockBroker;

		(pool as any).managedAgents.set("agent-2", {
			agent: mockAgent2,
			subtask: {
				id: "t2",
				prompt: "Work",
				role: "role2",
				dependencies: [],
				priority: 2,
			},
			result: null,
		});
		(pool as any).managedAgents.set("agent-1", {
			agent: createMockAgent({ id: "agent-1", name: "Alpha" }),
			subtask: {
				id: "t1",
				prompt: "Work",
				role: "role1",
				dependencies: [],
				priority: 1,
			},
			result: null,
		});

		const before = new Date().toISOString();
		await (pool as any).handleDelta(makeDelta({ agentId: "agent-1" }));
		const after = new Date().toISOString();

		expect(injectedArg).not.toBeNull();
		const structured = injectedArg! as unknown as StructuredContextInjection;
		expect(structured.timestamp).toBeDefined();
		expect(structured.timestamp >= before).toBe(true);
		expect(structured.timestamp <= after).toBe(true);
	});
});

// ── Test: Structured injection source is set to source agent name ────────────

describe("AgentPool handleDelta — structured injection source name", () => {
	it("sets the source to the agent's name", async () => {
		const { pool, mockAgent2 } = setupPoolWithTwoAgents();

		(pool as any).subtaskToAgent.set("t1", "agent-1");
		(pool as any).subtaskToAgent.set("t2", "agent-2");
		(pool as any).agentToSubtask.set("agent-1", "t1");
		(pool as any).agentToSubtask.set("agent-2", "t2");

		let injectedArg: string | StructuredContextInjection | null = null;
		const originalInject = mockAgent2.injectContext;
		(mockAgent2 as any).injectContext = (
			arg: string | StructuredContextInjection,
		) => {
			injectedArg = arg;
			originalInject.call(mockAgent2, arg);
		};

		const sourceAgent = createMockAgent({ id: "agent-1", name: "AlphaSource" });

		const mockBroker = {
			evaluate: mock(async () => [
				{
					shouldShare: true,
					reasoning: "Share",
					sourceAgentId: "agent-1",
					targetAgentId: "agent-2",
					information: "Info",
				},
			]),
			evaluateWithFullResult: mock(async () => []),
			recordSharing: mock(() => undefined),
			updateSignificanceContext: mock(() => undefined),
			findDependencyBySubtaskIds: mock(() => null),
		};

		(pool as any).informationBroker = mockBroker;

		(pool as any).managedAgents.set("agent-1", {
			agent: sourceAgent,
			subtask: {
				id: "t1",
				prompt: "Work",
				role: "role1",
				dependencies: [],
				priority: 1,
			},
			result: null,
		});
		(pool as any).managedAgents.set("agent-2", {
			agent: mockAgent2,
			subtask: {
				id: "t2",
				prompt: "Work",
				role: "role2",
				dependencies: [],
				priority: 2,
			},
			result: null,
		});

		await (pool as any).handleDelta(makeDelta({ agentId: "agent-1" }));

		expect(injectedArg).not.toBeNull();
		const structured = injectedArg! as unknown as StructuredContextInjection;
		expect(structured.source).toBe("AlphaSource");
	});
});

// ── Test: Sharing summaries still tracked after structured injection ─────────

describe("AgentPool handleDelta — sharing summaries tracked", () => {
	it("pushes to _sharingSummaries after structured injection", async () => {
		const { pool, mockAgent2 } = setupPoolWithTwoAgents();

		(pool as any).subtaskToAgent.set("t1", "agent-1");
		(pool as any).subtaskToAgent.set("t2", "agent-2");
		(pool as any).agentToSubtask.set("agent-1", "t1");
		(pool as any).agentToSubtask.set("agent-2", "t2");

		const mockBroker = {
			evaluate: mock(async () => [
				{
					shouldShare: true,
					reasoning: "Useful",
					sourceAgentId: "agent-1",
					targetAgentId: "agent-2",
					information: "Shared data for summary tracking",
				},
			]),
			evaluateWithFullResult: mock(async () => []),
			recordSharing: mock(() => undefined),
			updateSignificanceContext: mock(() => undefined),
			findDependencyBySubtaskIds: mock(() => null),
		};

		(pool as any).informationBroker = mockBroker;

		(pool as any).managedAgents.set("agent-1", {
			agent: createMockAgent({ id: "agent-1", name: "Alpha" }),
			subtask: {
				id: "t1",
				prompt: "Work",
				role: "role1",
				dependencies: [],
				priority: 1,
			},
			result: null,
		});
		(pool as any).managedAgents.set("agent-2", {
			agent: mockAgent2,
			subtask: {
				id: "t2",
				prompt: "Work",
				role: "role2",
				dependencies: [],
				priority: 2,
			},
			result: null,
		});

		const summariesBefore = (pool as any)._sharingSummaries.length;

		await (pool as any).handleDelta(makeDelta({ agentId: "agent-1" }));

		const summariesAfter = (pool as any)._sharingSummaries.length;
		expect(summariesAfter).toBe(summariesBefore + 1);

		const lastSummary = (pool as any)._sharingSummaries.at(-1);
		expect(lastSummary.targetAgentName).toBe("Beta");
		expect(lastSummary.informationPreview).toContain("Shared data");
	});
});
