import { EventEmitter } from "node:events";
import pino from "pino";

import { AgentEvent } from "../../../enums/agent-event.enum.ts";
import { AgentStatus } from "../../../enums/agent-status.enum.ts";
import { ExecutionStrategy } from "../../../enums/execution-strategy.enum.ts";
import type { PoolEvent } from "../../../enums/pool-event.enum.ts";
import { TaskComplexity } from "../../../enums/task-complexity.enum.ts";
import type {
	AgentConfig,
	AgentIdentity,
	PromptResult,
} from "../../../types/agent.types.ts";
import type {
	AgentPoolConfig,
	PoolManagedAgent,
	TaskAnalysis,
} from "../../../types/agent-pool.types.ts";
import type { AgentPool } from "../agent-pool.ts";

// ── Silent logger for component tests ──────────────────────────────────────

export function silentLogger(): pino.Logger {
	return pino({ level: "silent" });
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Silent pool config that suppresses all log output. */
export function silentPoolConfig(
	overrides?: Partial<AgentPoolConfig>,
): AgentPoolConfig {
	return {
		openRouterApiKey: "test-key-not-real",
		model: "test/model",
		logOutput: { console: false, json: false },
		logLevel: "silent" as any,
		...overrides,
	};
}

/** Creates a mock agent that simulates the Agent class interface. */
export function createMockAgent(
	overrides?: Partial<{
		id: string;
		name: string;
		status: AgentStatus;
		promptResult: PromptResult;
		readyError: Error | null;
		promptError: Error | null;
	}>,
): PoolManagedAgent {
	const id = overrides?.id ?? crypto.randomUUID();
	const name = overrides?.name ?? "MockAgent";
	const identity: AgentIdentity = { id, name };
	let status = overrides?.status ?? AgentStatus.IDLE;
	const emitter = new EventEmitter();

	const promptResult: PromptResult = overrides?.promptResult ?? {
		stopReason: "end_turn",
		text: "Mock response text",
		usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
	};

	const agent: PoolManagedAgent = {
		identity,
		get id() {
			return identity.id;
		},
		get name() {
			return identity.name;
		},
		get status() {
			return status;
		},
		ready: overrides?.readyError
			? Promise.reject(overrides.readyError)
			: Promise.resolve(),
		prompt: async (_text: string) => {
			if (overrides?.promptError) throw overrides.promptError;
			status = AgentStatus.BUSY;
			// Simulate some events
			emitter.emit(AgentEvent.AGENT_BUSY, {
				event: AgentEvent.AGENT_BUSY,
				timestamp: new Date().toISOString(),
				agent: identity,
				promptText: _text,
			});

			// Simulate prompt completion
			emitter.emit(AgentEvent.PROMPT_COMPLETE, {
				event: AgentEvent.PROMPT_COMPLETE,
				timestamp: new Date().toISOString(),
				agent: identity,
				stopReason: promptResult.stopReason,
				fullText: promptResult.text,
				usage: promptResult.usage,
			});

			status = AgentStatus.IDLE;
			emitter.emit(AgentEvent.AGENT_IDLE, {
				event: AgentEvent.AGENT_IDLE,
				timestamp: new Date().toISOString(),
				agent: identity,
				previousStatus: AgentStatus.BUSY,
			});

			return promptResult;
		},
		injectContext: (_instructions: string) => {
			emitter.emit(AgentEvent.CONTEXT_INJECTED, {
				event: AgentEvent.CONTEXT_INJECTED,
				timestamp: new Date().toISOString(),
				agent: identity,
				instructions: _instructions,
				queued: status === AgentStatus.BUSY,
			});
		},
		snapshot: () => ({
			identity: { ...identity },
			status,
			sessionId: "mock-session-id",
			promptCount: 0,
			pendingContextCount: 0,
		}),
		destroy: async () => {
			status = AgentStatus.DESTROYED;
			emitter.emit(AgentEvent.AGENT_DESTROYED, {
				event: AgentEvent.AGENT_DESTROYED,
				timestamp: new Date().toISOString(),
				agent: identity,
			});
		},
		on: (event: string, listener: (...args: any[]) => void) =>
			emitter.on(event, listener),
		once: (event: string, listener: (...args: any[]) => void) =>
			emitter.once(event, listener),
		off: (event: string, listener: (...args: any[]) => void) =>
			emitter.off(event, listener),
	};

	return agent;
}

/** Creates a mock agent factory. */
export function createMockAgentFactory(
	agentOptions?: Parameters<typeof createMockAgent>[0],
): (config?: AgentConfig) => PoolManagedAgent {
	const agents: PoolManagedAgent[] = [];

	const factory = (_config?: AgentConfig) => {
		const agent = createMockAgent({
			name: _config?.name ?? `Agent-${agents.length + 1}`,
			...agentOptions,
		});
		agents.push(agent);
		return agent;
	};

	// Attach the created agents for inspection
	(factory as any).agents = agents;

	return factory;
}

/** Builds a valid single-strategy TaskAnalysis. */
export function singleTaskAnalysis(task: string): TaskAnalysis {
	return {
		strategy: ExecutionStrategy.SINGLE,
		complexity: TaskComplexity.SIMPLE,
		reasoning: "This task is straightforward and self-contained.",
		subtasks: [
			{
				id: "task-1",
				prompt: task,
				role: "general-agent",
				dependencies: [],
				priority: 1,
			},
		],
		dependencies: [],
		parallelismBenefit: 0,
	};
}

/** Builds a valid multi-strategy TaskAnalysis. */
export function multiTaskAnalysis(): TaskAnalysis {
	return {
		strategy: ExecutionStrategy.MULTI,
		complexity: TaskComplexity.COMPLEX,
		reasoning:
			"This task has clearly separable concerns that benefit from specialization.",
		subtasks: [
			{
				id: "subtask-api",
				prompt: "Build the REST API endpoints with Express.js",
				role: "api-developer",
				dependencies: [],
				priority: 1,
			},
			{
				id: "subtask-tests",
				prompt: "Write comprehensive tests for the REST API",
				role: "test-writer",
				dependencies: ["subtask-api"],
				priority: 2,
			},
		],
		dependencies: [
			{
				from: "subtask-api",
				to: "subtask-tests",
				type: "blocking",
			},
		],
		parallelismBenefit: 0.4,
	};
}

/** Collects all events of a given type emitted by a pool. */
export function collectPoolEvents<T>(pool: AgentPool, event: PoolEvent): T[] {
	const collected: T[] = [];
	pool.on(event, ((payload: T) => {
		collected.push(payload);
	}) as any);
	return collected;
}
