import { EventEmitter } from "node:events";
import { AgentEvent } from "../../../enums/agent-event.enum.ts";
import { AgentStatus } from "../../../enums/agent-status.enum.ts";
import type { AgentIdentity } from "../../../types/agent.types.ts";
import type {
	AgentPoolConfig,
	AgentPoolResult,
	PoolManagedAgent,
} from "../../../types/agent-pool.types.ts";
import { createMockAgent, createMockAgentFactory } from "./test-helpers.ts";

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_MODEL = "openai/gpt-5-nano";

export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
export const HAS_API_KEY = OPENROUTER_API_KEY.length > 0;

/** Use a fast, cheap model for int tests to minimize cost. */
export const INT_MODEL = process.env.int_MODEL ?? DEFAULT_MODEL;

/** Generous timeout for LLM round-trips. */
export const INT_TIMEOUT_MS = 120_000;

// ── Config Helper ──────────────────────────────────────────────────────────

/**
 * Creates a pool config wired to real OpenRouter but with mock agents.
 * All logs are silenced to keep test output clean.
 * Temperature is set to 0 for maximum determinism in intent classification.
 */
export function intPoolConfig(
	overrides?: Partial<AgentPoolConfig>,
): AgentPoolConfig {
	return {
		openRouterApiKey: OPENROUTER_API_KEY,
		model: INT_MODEL,
		maxAgents: 3,
		maxRetries: 2,
		temperature: 0,
		logOutput: { console: false, json: false },
		logLevel: "silent" as any,
		createAgent: createMockAgentFactory(),
		...overrides,
	};
}

// ── Type Guard ─────────────────────────────────────────────────────────────

/**
 * Helper: checks whether a `send()` response is a string or an AgentPoolResult.
 * LLM intent classification is non-deterministic, so tests must accept both.
 */
export function isPoolResult(value: unknown): value is AgentPoolResult {
	return (
		typeof value === "object" &&
		value !== null &&
		"task" in value &&
		"strategy" in value &&
		"agents" in value
	);
}

// ── Tracking Agent Factory ─────────────────────────────────────────────────

/**
 * Creates a mock agent factory that tracks all spawned agents
 * and allows configuring per-agent behavior.
 */
export function trackingAgentFactory(options?: {
	promptDelay?: number;
	promptText?: string;
}): {
	factory: (config?: { name?: string }) => PoolManagedAgent;
	agents: PoolManagedAgent[];
	promptCalls: Array<{ agentName: string; promptText: string }>;
} {
	const agents: PoolManagedAgent[] = [];
	const promptCalls: Array<{ agentName: string; promptText: string }> = [];

	const factory = (config?: { name?: string }) => {
		const agent = createMockAgent({
			name: config?.name ?? `int-Agent-${agents.length + 1}`,
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

// ── Approval Agent Factory ─────────────────────────────────────────────────

/**
 * Creates a mock agent that emits APPROVE_REQUEST during prompt
 * and blocks until the approval is resolved — exactly like a real
 * agent with `autoApprove: false`.
 */
export function createApprovalAgent(opts?: {
	name?: string;
	toolCallId?: string;
	toolCallTitle?: string;
}): PoolManagedAgent {
	const id = crypto.randomUUID();
	const name = opts?.name ?? "ApprovalAgent";
	const identity: AgentIdentity = { id, name };
	let status = AgentStatus.IDLE;
	const emitter = new EventEmitter();

	const toolCallId =
		opts?.toolCallId ?? `tc-${crypto.randomUUID().slice(0, 8)}`;
	const toolCallTitle = opts?.toolCallTitle ?? "execute_command";

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
		ready: Promise.resolve(),
		prompt: async (_text: string) => {
			status = AgentStatus.BUSY;
			emitter.emit(AgentEvent.AGENT_BUSY, {
				event: AgentEvent.AGENT_BUSY,
				timestamp: new Date().toISOString(),
				agent: identity,
				promptText: _text,
			});

			// Block until approval is resolved — mirrors real agent behavior
			const approved = await new Promise<boolean>((resolve) => {
				emitter.emit(AgentEvent.APPROVE_REQUEST, {
					event: AgentEvent.APPROVE_REQUEST,
					timestamp: new Date().toISOString(),
					agent: identity,
					toolCallId,
					toolCallTitle,
					options: [
						{ id: "allow", name: "Allow", allowed: true },
						{ id: "deny", name: "Deny", allowed: false },
					],
					resolve,
				});
			});

			const resultText = approved
				? "Tool approved — action completed successfully."
				: "Tool denied — action was blocked.";

			emitter.emit(AgentEvent.PROMPT_COMPLETE, {
				event: AgentEvent.PROMPT_COMPLETE,
				timestamp: new Date().toISOString(),
				agent: identity,
				stopReason: "end_turn",
				fullText: resultText,
				usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
			});

			status = AgentStatus.IDLE;
			emitter.emit(AgentEvent.AGENT_IDLE, {
				event: AgentEvent.AGENT_IDLE,
				timestamp: new Date().toISOString(),
				agent: identity,
				previousStatus: AgentStatus.BUSY,
			});

			return {
				stopReason: "end_turn" as const,
				text: resultText,
				usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
			};
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
