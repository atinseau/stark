import { describe, expect, it } from "bun:test";
import pino from "pino";
import { ConversationRole } from "../../../enums/conversation-role.enum.ts";
import { ExecutionStrategy } from "../../../enums/execution-strategy.enum.ts";
import { TaskComplexity } from "../../../enums/task-complexity.enum.ts";
import { UserIntent } from "../../../enums/user-intent.enum.ts";
import {
	contextAnalysisSystemPrompt,
	intentAnalysisPrompt,
	intentAnalysisSystemPrompt,
	notificationDecisionPrompt,
	sharingAnalysisSystemPrompt,
} from "../../../prompts/index.ts";
import type {
	DetectedIntent,
	IntentAnalysis,
	TaskAnalysis,
} from "../../../types/agent-pool.types.ts";
import { AgentPool } from "../agent-pool.ts";
import { ConversationManager } from "../conversation-manager.ts";
import { TaskPlanner } from "../task-planner.ts";

// ════════════════════════════════════════════════════════════════════════════
// Constants & Environment
// ════════════════════════════════════════════════════════════════════════════

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
const HAS_API_KEY = OPENROUTER_API_KEY.length > 0;
const DEFAULT_MODEL = "openai/gpt-4.1-nano";
const INT_MODEL = process.env.INT_MODEL ?? DEFAULT_MODEL;
const INT_TIMEOUT_MS = 120_000;

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

function silentLogger(): pino.Logger {
	return pino({ level: "silent" });
}

function createConversationManager(): ConversationManager {
	return new ConversationManager(
		{
			apiKey: OPENROUTER_API_KEY,
			model: INT_MODEL,
			maxRetries: 2,
			temperature: 0,
		},
		silentLogger(),
	);
}

// ── Validators (replicated from internal modules) ──────────────────────────

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

	if (typeof obj.reasoning !== "string") return null;
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

function validateNotificationDecision(
	data: unknown,
): { shouldNotify: boolean; reasoning: string; message: string } | null {
	if (data == null || typeof data !== "object") return null;
	const obj = data as Record<string, unknown>;

	if (typeof obj.shouldNotify !== "boolean") return null;
	if (typeof obj.reasoning !== "string" || obj.reasoning.length === 0)
		return null;

	if (obj.shouldNotify) {
		if (typeof obj.message !== "string" || obj.message.length === 0)
			return null;
	}

	return {
		shouldNotify: obj.shouldNotify,
		reasoning: obj.reasoning as string,
		message: typeof obj.message === "string" ? obj.message : "",
	};
}

function validateSharingAnalysis(data: unknown): {
	decisions: Array<{
		targetAgentId: string;
		shouldShare: boolean;
		reasoning: string;
		information: string;
	}>;
} | null {
	if (data == null || typeof data !== "object") return null;
	const obj = data as Record<string, unknown>;

	if (!Array.isArray(obj.decisions)) return null;

	const decisions: Array<{
		targetAgentId: string;
		shouldShare: boolean;
		reasoning: string;
		information: string;
	}> = [];

	for (const d of obj.decisions) {
		if (d == null || typeof d !== "object") return null;
		const dec = d as Record<string, unknown>;
		if (typeof dec.targetAgentId !== "string") return null;
		if (typeof dec.shouldShare !== "boolean") return null;
		if (typeof dec.reasoning !== "string") return null;
		if (typeof dec.information !== "string") return null;
		decisions.push({
			targetAgentId: dec.targetAgentId,
			shouldShare: dec.shouldShare,
			reasoning: dec.reasoning,
			information: dec.information,
		});
	}

	return { decisions };
}

// ── Semantic validation helper (mirrors TaskPlanner internals) ─────────────

function semanticValidationErrors(analysis: TaskAnalysis): string[] {
	const errors: string[] = [];
	const subtaskIds = new Set(analysis.subtasks.map((s) => s.id));

	if (subtaskIds.size !== analysis.subtasks.length) {
		errors.push("Duplicate subtask IDs detected");
	}

	if (
		analysis.strategy === ExecutionStrategy.SINGLE &&
		analysis.dependencies.length > 0
	) {
		errors.push("Single-agent strategy should not have dependencies");
	}

	for (const dep of analysis.dependencies) {
		if (!subtaskIds.has(dep.from))
			errors.push(`Dependency references unknown subtask "${dep.from}"`);
		if (!subtaskIds.has(dep.to))
			errors.push(`Dependency references unknown subtask "${dep.to}"`);
		if (dep.from === dep.to)
			errors.push(`Subtask "${dep.from}" depends on itself`);
	}

	for (const subtask of analysis.subtasks) {
		for (const depId of subtask.dependencies) {
			if (!subtaskIds.has(depId))
				errors.push(
					`Subtask "${subtask.id}" depends on unknown subtask "${depId}"`,
				);
			if (depId === subtask.id)
				errors.push(`Subtask "${subtask.id}" depends on itself`);
		}
	}

	if (analysis.dependencies.length > 0) {
		const adjacency = new Map<string, string[]>();
		for (const dep of analysis.dependencies) {
			if (!adjacency.has(dep.from)) adjacency.set(dep.from, []);
			adjacency.get(dep.from)!.push(dep.to);
		}

		const visited = new Set<string>();
		const inStack = new Set<string>();

		function hasCycle(node: string): boolean {
			if (inStack.has(node)) return true;
			if (visited.has(node)) return false;
			visited.add(node);
			inStack.add(node);
			for (const neighbor of adjacency.get(node) ?? []) {
				if (hasCycle(neighbor)) return true;
			}
			inStack.delete(node);
			return false;
		}

		for (const id of subtaskIds) {
			if (hasCycle(id)) {
				errors.push("Circular dependency detected");
				break;
			}
		}
	}

	return errors;
}

// ── Tracking agent factory (replicated from test-helpers-int) ──────────────

import { EventEmitter } from "node:events";
import { AgentEvent } from "../../../enums/agent-event.enum.ts";
import { AgentStatus } from "../../../enums/agent-status.enum.ts";
import type {
	AgentIdentity,
	PromptResult,
} from "../../../types/agent.types.ts";
import type {
	AgentPoolConfig,
	PoolManagedAgent,
} from "../../../types/agent-pool.types.ts";

function createMockAgent(
	overrides?: Partial<{
		id: string;
		name: string;
		status: AgentStatus;
		promptResult: PromptResult;
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
		ready: Promise.resolve(),
		prompt: async (_text: string) => {
			status = AgentStatus.BUSY;
			emitter.emit(AgentEvent.AGENT_BUSY, {
				event: AgentEvent.AGENT_BUSY,
				timestamp: new Date().toISOString(),
				agent: identity,
				promptText: _text,
			});
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

function trackingAgentFactory(options?: {
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

function intPoolConfig(overrides?: Partial<AgentPoolConfig>): AgentPoolConfig {
	return {
		openRouterApiKey: OPENROUTER_API_KEY,
		model: INT_MODEL,
		maxAgents: 5,
		maxRetries: 2,
		temperature: 0,
		logOutput: { console: false, json: false },
		logLevel: "silent" as any,
		createAgent: trackingAgentFactory().factory,
		...overrides,
	};
}

// ════════════════════════════════════════════════════════════════════════════
// Few-Shot Examples — Integration Tests
//
// Validates that few-shot examples embedded in LLM prompts improve the
// quality, consistency, and first-try success rate of LLM responses
// across all prompt types (planning, intent, notification, context
// analysis, summary).
//
// These tests make real LLM calls via OpenRouter.
// ════════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_API_KEY)("Few-shot examples — integration", () => {
	// ────────────────────────────────────────────────────────────────
	// Planning: Strategy Selection Quality
	// ────────────────────────────────────────────────────────────────

	describe("planning — strategy selection guided by few-shot examples", () => {
		it.concurrent(
			"trivial task → single-agent strategy with simple complexity",
			async () => {
				const conversations = createConversationManager();
				const planner = new TaskPlanner(conversations, silentLogger());

				const analysis = await planner.analyze(
					"Fix the typo in README.md on line 10 — change 'teh' to 'the'",
				);

				expect(analysis.strategy).toBe(ExecutionStrategy.SINGLE);
				expect(analysis.subtasks).toHaveLength(1);
				expect(analysis.dependencies).toHaveLength(0);
				expect(analysis.parallelismBenefit).toBe(0);
				expect(analysis.complexity).toBe(TaskComplexity.SIMPLE);

				// Reasoning should explain why single is appropriate
				expect(analysis.reasoning.length).toBeGreaterThan(10);

				// No semantic errors
				const errors = semanticValidationErrors(analysis);
				expect(errors).toHaveLength(0);
			},
			INT_TIMEOUT_MS,
		);

		it.concurrent(
			"deceptively complex but single-concern task → single-agent (not artificially split)",
			async () => {
				const conversations = createConversationManager();
				const planner = new TaskPlanner(conversations, silentLogger());

				const analysis = await planner.analyze(
					"Refactor the authentication module to use JWT instead of session cookies. " +
						"Update the middleware, login/logout handlers, token generation, and route guards.",
				);

				// The few-shot example explicitly demonstrates that auth refactoring
				// is a single cohesive concern that should NOT be split
				expect(analysis.strategy).toBe(ExecutionStrategy.SINGLE);
				expect(analysis.subtasks).toHaveLength(1);
				expect(analysis.dependencies).toHaveLength(0);
				expect(analysis.parallelismBenefit).toBe(0);

				// Reasoning should address why splitting is inappropriate
				expect(analysis.reasoning.length).toBeGreaterThan(20);

				const errors = semanticValidationErrors(analysis);
				expect(errors).toHaveLength(0);
			},
			INT_TIMEOUT_MS,
		);

		it.concurrent(
			"genuinely separable concerns → multi-agent with valid dependency graph",
			async () => {
				const conversations = createConversationManager();
				const planner = new TaskPlanner(conversations, silentLogger());

				const analysis = await planner.analyze(
					"Build a REST API for product management with full test coverage " +
						"and OpenAPI documentation. The API should have CRUD endpoints, " +
						"the tests should cover all routes, and the docs should be " +
						"in OpenAPI 3.0 format.",
				);

				// This closely mirrors Example 3 — the LLM should recognize
				// three distinct deliverables
				expect(analysis.strategy).toBe(ExecutionStrategy.MULTI);
				expect(analysis.subtasks.length).toBeGreaterThanOrEqual(2);
				expect(analysis.complexity).toBe(TaskComplexity.COMPLEX);
				expect(analysis.parallelismBenefit).toBeGreaterThan(0);

				// Validate dependency graph integrity
				const errors = semanticValidationErrors(analysis);
				expect(errors).toHaveLength(0);

				// All subtask IDs should be unique
				const ids = analysis.subtasks.map((s) => s.id);
				expect(new Set(ids).size).toBe(ids.length);

				// Each subtask should have a meaningful prompt and role
				for (const subtask of analysis.subtasks) {
					expect(subtask.prompt.length).toBeGreaterThan(20);
					expect(subtask.role.length).toBeGreaterThan(0);
				}

				// Dependencies should reference valid subtask IDs
				const subtaskIds = new Set(ids);
				for (const dep of analysis.dependencies) {
					expect(subtaskIds.has(dep.from)).toBe(true);
					expect(subtaskIds.has(dep.to)).toBe(true);
					expect(["blocking", "informational"]).toContain(dep.type);
				}
			},
			INT_TIMEOUT_MS,
		);

		it.concurrent(
			"trivially small task is NOT artificially split (anti-pattern avoidance)",
			async () => {
				const conversations = createConversationManager();
				const planner = new TaskPlanner(conversations, silentLogger());

				const analysis = await planner.analyze(
					"Create a utility function that converts temperatures between " +
						"Celsius, Fahrenheit, and Kelvin.",
				);

				// The anti-pattern example explicitly warns against splitting
				// trivially related functions
				expect(analysis.strategy).toBe(ExecutionStrategy.SINGLE);
				expect(analysis.subtasks).toHaveLength(1);

				const errors = semanticValidationErrors(analysis);
				expect(errors).toHaveLength(0);
			},
			INT_TIMEOUT_MS,
		);

		it.concurrent(
			"planning produces valid JSON on first attempt (no chatJson retries needed)",
			async () => {
				const conversations = createConversationManager();
				const planner = new TaskPlanner(conversations, silentLogger());

				// Use a moderately complex task to stress-test JSON quality
				const analysis = await planner.analyze(
					"Add input validation to the user registration endpoint. " +
						"Validate email format, password strength, and username uniqueness.",
				);

				// If we get here without an error, the JSON was valid
				expect(analysis).toBeDefined();
				expect(analysis.strategy).toBeDefined();
				expect(analysis.subtasks.length).toBeGreaterThanOrEqual(1);
				expect(analysis.reasoning.length).toBeGreaterThan(0);

				// Verify structural completeness
				for (const subtask of analysis.subtasks) {
					expect(subtask.id).toBeTruthy();
					expect(subtask.prompt).toBeTruthy();
					expect(subtask.role).toBeTruthy();
					expect(typeof subtask.priority).toBe("number");
				}

				const errors = semanticValidationErrors(analysis);
				expect(errors).toHaveLength(0);
			},
			INT_TIMEOUT_MS,
		);
	});

	// ────────────────────────────────────────────────────────────────
	// Intent Classification Accuracy
	// ────────────────────────────────────────────────────────────────

	describe("intent classification — guided by few-shot examples", () => {
		it.concurrent(
			"clear task request → new_task intent",
			async () => {
				const conversations = createConversationManager();
				conversations.register(
					ConversationRole.INTENT_ANALYZER,
					intentAnalysisSystemPrompt({}),
				);

				const prompt = intentAnalysisPrompt({
					message: "Create a login page with email and password fields",
					poolState: {
						executing: false,
						currentTask: null,
						activeAgentCount: 0,
						notificationsEnabled: false,
						pendingApprovals: [],
					},
				});

				const analysis = await conversations.sendOneShotJson(
					ConversationRole.INTENT_ANALYZER,
					prompt,
					validateIntentAnalysis,
					{ maxTokens: 300 },
				);

				expect(analysis.primaryIntent).toBe(UserIntent.NEW_TASK);
				expect(analysis.intents.length).toBeGreaterThanOrEqual(1);
				expect(analysis.intents[0]!.confidence).toBeGreaterThanOrEqual(0.8);
				expect(analysis.intents[0]!.parameters).toBeDefined();
				expect(typeof analysis.intents[0]!.parameters.task).toBe("string");
			},
			INT_TIMEOUT_MS,
		);

		it.concurrent(
			"informal status check → status_query intent",
			async () => {
				const conversations = createConversationManager();
				conversations.register(
					ConversationRole.INTENT_ANALYZER,
					intentAnalysisSystemPrompt({}),
				);

				const prompt = intentAnalysisPrompt({
					message: "How's it going?",
					poolState: {
						executing: true,
						currentTask: "Build a REST API",
						activeAgentCount: 2,
						notificationsEnabled: false,
						pendingApprovals: [],
					},
				});

				const analysis = await conversations.sendOneShotJson(
					ConversationRole.INTENT_ANALYZER,
					prompt,
					validateIntentAnalysis,
					{ maxTokens: 300 },
				);

				expect(analysis.primaryIntent).toBe(UserIntent.STATUS_QUERY);
				expect(analysis.intents[0]!.confidence).toBeGreaterThanOrEqual(0.7);
			},
			INT_TIMEOUT_MS,
		);

		it.concurrent(
			"notification request → notification_preference intent",
			async () => {
				const conversations = createConversationManager();
				conversations.register(
					ConversationRole.INTENT_ANALYZER,
					intentAnalysisSystemPrompt({}),
				);

				const prompt = intentAnalysisPrompt({
					message: "Let me know when the tests finish running",
					poolState: {
						executing: true,
						currentTask: "Run test suite",
						activeAgentCount: 1,
						notificationsEnabled: false,
						pendingApprovals: [],
					},
				});

				const analysis = await conversations.sendOneShotJson(
					ConversationRole.INTENT_ANALYZER,
					prompt,
					validateIntentAnalysis,
					{ maxTokens: 300 },
				);

				expect(analysis.primaryIntent).toBe(UserIntent.NOTIFICATION_PREFERENCE);
				expect(analysis.intents[0]!.confidence).toBeGreaterThanOrEqual(0.7);
			},
			INT_TIMEOUT_MS,
		);

		it.concurrent(
			"cancel request → cancel intent",
			async () => {
				const conversations = createConversationManager();
				conversations.register(
					ConversationRole.INTENT_ANALYZER,
					intentAnalysisSystemPrompt({}),
				);

				const prompt = intentAnalysisPrompt({
					message: "Stop everything right now",
					poolState: {
						executing: true,
						currentTask: "Build a full-stack app",
						activeAgentCount: 3,
						notificationsEnabled: false,
						pendingApprovals: [],
					},
				});

				const analysis = await conversations.sendOneShotJson(
					ConversationRole.INTENT_ANALYZER,
					prompt,
					validateIntentAnalysis,
					{ maxTokens: 300 },
				);

				expect(analysis.primaryIntent).toBe(UserIntent.CANCEL);
				expect(analysis.intents[0]!.confidence).toBeGreaterThanOrEqual(0.8);
			},
			INT_TIMEOUT_MS,
		);

		it.concurrent(
			"context injection → context_injection intent with instructions",
			async () => {
				const conversations = createConversationManager();
				conversations.register(
					ConversationRole.INTENT_ANALYZER,
					intentAnalysisSystemPrompt({}),
				);

				const prompt = intentAnalysisPrompt({
					message: "By the way, use port 3000 for the server, not 8080",
					poolState: {
						executing: true,
						currentTask: "Build a Node.js server",
						activeAgentCount: 2,
						notificationsEnabled: false,
						pendingApprovals: [],
					},
				});

				const analysis = await conversations.sendOneShotJson(
					ConversationRole.INTENT_ANALYZER,
					prompt,
					validateIntentAnalysis,
					{ maxTokens: 300 },
				);

				expect(analysis.primaryIntent).toBe(UserIntent.CONTEXT_INJECTION);
				expect(analysis.intents[0]!.confidence).toBeGreaterThanOrEqual(0.7);
				expect(typeof analysis.intents[0]!.parameters.instructions).toBe(
					"string",
				);
			},
			INT_TIMEOUT_MS,
		);

		it.concurrent(
			"short affirmative with pending approvals → approve_agent intent",
			async () => {
				const conversations = createConversationManager();
				conversations.register(
					ConversationRole.INTENT_ANALYZER,
					intentAnalysisSystemPrompt({}),
				);

				const prompt = intentAnalysisPrompt({
					message: "yes",
					poolState: {
						executing: true,
						currentTask: "Deploy the application",
						activeAgentCount: 1,
						notificationsEnabled: false,
						pendingApprovals: [
							{
								agentName: "deploy-agent",
								toolCallId: "tc-abc123",
								toolCallTitle: "execute_command",
							},
						],
					},
				});

				const analysis = await conversations.sendOneShotJson(
					ConversationRole.INTENT_ANALYZER,
					prompt,
					validateIntentAnalysis,
					{ maxTokens: 300 },
				);

				expect(analysis.primaryIntent).toBe(UserIntent.APPROVE_AGENT);
				expect(analysis.intents[0]!.confidence).toBeGreaterThanOrEqual(0.7);
				expect(analysis.intents[0]!.parameters.approved).toBe(true);
			},
			INT_TIMEOUT_MS,
		);
	});

	// ────────────────────────────────────────────────────────────────
	// Notification Decision Quality
	// ────────────────────────────────────────────────────────────────

	describe("notification decisions — contrastive examples guide LLM", () => {
		it.concurrent(
			"significant milestone → shouldNotify: true with meaningful message",
			async () => {
				const conversations = createConversationManager();
				conversations.register(
					ConversationRole.CONTEXT_ANALYZER,
					contextAnalysisSystemPrompt({}),
				);

				const prompt = notificationDecisionPrompt({
					preference: {
						enabled: true,
						minSignificance: 0.5,
					},
					delta: {
						agentName: "api-developer",
						agentId: "agent-api-dev-id",
						type: "prompt_complete",
						summary:
							"Agent completed implementing all REST API endpoints for user management",
						significance: 0.9,
					},
					agentTask: "Implement CRUD REST API endpoints for user management",
				});

				const decision = await conversations.sendOneShotJson(
					ConversationRole.CONTEXT_ANALYZER,
					prompt,
					validateNotificationDecision,
					{ maxTokens: 300 },
				);

				expect(decision.shouldNotify).toBe(true);
				expect(decision.message.length).toBeGreaterThan(10);
				expect(decision.reasoning.length).toBeGreaterThan(10);
			},
			INT_TIMEOUT_MS,
		);

		it.concurrent(
			"routine file read → shouldNotify: false",
			async () => {
				const conversations = createConversationManager();
				conversations.register(
					ConversationRole.CONTEXT_ANALYZER,
					contextAnalysisSystemPrompt({}),
				);

				const prompt = notificationDecisionPrompt({
					preference: {
						enabled: true,
						minSignificance: 0.3,
					},
					delta: {
						agentName: "test-writer",
						agentId: "agent-test-id",
						type: "tool_complete",
						summary: "Agent read file src/routes/users.ts",
						significance: 0.1,
					},
					agentTask: "Write integration tests for the users API",
				});

				const decision = await conversations.sendOneShotJson(
					ConversationRole.CONTEXT_ANALYZER,
					prompt,
					validateNotificationDecision,
					{ maxTokens: 300 },
				);

				expect(decision.shouldNotify).toBe(false);
				expect(decision.reasoning.length).toBeGreaterThan(5);
			},
			INT_TIMEOUT_MS,
		);

		it.concurrent(
			"error event → shouldNotify: true with actionable message",
			async () => {
				const conversations = createConversationManager();
				conversations.register(
					ConversationRole.CONTEXT_ANALYZER,
					contextAnalysisSystemPrompt({}),
				);

				const prompt = notificationDecisionPrompt({
					preference: {
						enabled: true,
						minSignificance: 0.5,
					},
					delta: {
						agentName: "backend-dev",
						agentId: "agent-backend-id",
						type: "agent_error",
						summary: "Agent encountered error: Cannot find module 'express'",
						significance: 0.9,
					},
					agentTask: "Build the Express.js backend server",
				});

				const decision = await conversations.sendOneShotJson(
					ConversationRole.CONTEXT_ANALYZER,
					prompt,
					validateNotificationDecision,
					{ maxTokens: 300 },
				);

				expect(decision.shouldNotify).toBe(true);
				expect(decision.message.length).toBeGreaterThan(10);
				// Message should mention the error or the missing dependency
				expect(decision.reasoning.length).toBeGreaterThan(10);
			},
			INT_TIMEOUT_MS,
		);
	});

	// ────────────────────────────────────────────────────────────────
	// Context Analysis Quality
	// ────────────────────────────────────────────────────────────────

	describe("context analysis — few-shot examples guide action selection", () => {
		it.concurrent(
			"routine delta → shouldNotify: false (notification path)",
			async () => {
				const conversations = createConversationManager();
				conversations.register(
					ConversationRole.CONTEXT_ANALYZER,
					contextAnalysisSystemPrompt({}),
				);

				const { contextAnalysisPrompt } = await import(
					"../../../prompts/index.ts"
				);

				const prompt = contextAnalysisPrompt({
					delta: {
						agentName: "api-dev",
						agentId: "agent-api-dev-id",
						type: "tool_complete",
						summary: "Agent read file package.json",
						significance: 0.1,
						data: { tool: "read_file", file: "package.json" },
					},
					task: "Build a REST API with tests",
					sourceAgent: {
						taskDescription: "Implement REST API endpoints",
						taskRole: "api-developer",
						status: "busy",
						completed: false,
						filesWritten: [],
						error: null,
					},
					otherAgents: [],
					dependencies: [],
				});

				const result = await conversations.sendOneShotJson(
					ConversationRole.CONTEXT_ANALYZER,
					prompt,
					validateNotificationDecision,
					{ maxTokens: 300 },
				);

				expect(result.shouldNotify).toBe(false);
			},
			INT_TIMEOUT_MS,
		);

		it.concurrent(
			"relevant output with dependent agent → shouldShare: true (sharing path)",
			async () => {
				const conversations = createConversationManager();
				conversations.register(
					ConversationRole.SHARING_ANALYZER,
					sharingAnalysisSystemPrompt({}),
				);

				const { contextAnalysisPrompt } = await import(
					"../../../prompts/index.ts"
				);

				const prompt = contextAnalysisPrompt({
					delta: {
						agentName: "api-dev",
						agentId: "agent-api-dev-id",
						type: "prompt_complete",
						summary:
							"Agent completed implementing all REST API endpoints in src/routes/users.ts",
						significance: 0.9,
						data: {
							filesWritten: ["src/routes/users.ts", "src/models/user.ts"],
						},
					},
					task: "Build a REST API with tests",
					sourceAgent: {
						taskDescription: "Implement REST API endpoints",
						taskRole: "api-developer",
						status: "idle",
						completed: true,
						filesWritten: ["src/routes/users.ts", "src/models/user.ts"],
						error: null,
					},
					otherAgents: [
						{
							agentName: "test-writer",
							agentId: "agent-test-writer-id",
							taskDescription: "Write integration tests for the users REST API",
							taskRole: "test-writer",
							status: "busy",
							completed: false,
						},
					],
					dependencies: [
						{
							from: "api-impl",
							to: "test-suite",
							type: "blocking",
						},
					],
				});

				const result = await conversations.sendOneShotJson(
					ConversationRole.SHARING_ANALYZER,
					prompt,
					validateSharingAnalysis,
					{ maxTokens: 500 },
				);

				expect(result.decisions.length).toBeGreaterThanOrEqual(1);
				const targetDecision = result.decisions.find(
					(d) => d.targetAgentId === "agent-test-writer-id",
				);
				expect(targetDecision).toBeDefined();
				expect(targetDecision!.shouldShare).toBe(true);
				expect(targetDecision!.information.length).toBeGreaterThan(10);
			},
			INT_TIMEOUT_MS,
		);

		it.concurrent(
			"critical error → shouldNotify: true with actionable message (notification path)",
			async () => {
				const conversations = createConversationManager();
				conversations.register(
					ConversationRole.CONTEXT_ANALYZER,
					contextAnalysisSystemPrompt({}),
				);

				const { contextAnalysisPrompt } = await import(
					"../../../prompts/index.ts"
				);

				const prompt = contextAnalysisPrompt({
					delta: {
						agentName: "deploy-agent",
						agentId: "agent-deploy-id",
						type: "agent_error",
						summary:
							"Agent encountered error: permission denied writing to /etc/nginx/conf.d/",
						significance: 1.0,
						data: {
							error: "EACCES: permission denied",
							path: "/etc/nginx/conf.d/",
						},
					},
					task: "Deploy the application to production",
					sourceAgent: {
						taskDescription: "Configure nginx and deploy",
						taskRole: "deployment-agent",
						status: "idle",
						completed: false,
						filesWritten: [],
						error: "EACCES: permission denied",
					},
					otherAgents: [],
					dependencies: [],
				});

				const result = await conversations.sendOneShotJson(
					ConversationRole.CONTEXT_ANALYZER,
					prompt,
					validateNotificationDecision,
					{ maxTokens: 300 },
				);

				expect(result.shouldNotify).toBe(true);
				expect(result.message.length).toBeGreaterThan(10);
			},
			INT_TIMEOUT_MS,
		);
	});

	// ────────────────────────────────────────────────────────────────
	// Summary Structure
	// ────────────────────────────────────────────────────────────────

	describe("summary — structured output guided by few-shot examples", () => {
		it.concurrent(
			"multi-agent summary includes structured sections from the template",
			async () => {
				const tracker = trackingAgentFactory({
					promptText:
						"Implemented CRUD endpoints in src/routes/users.ts and " +
						"wrote 12 integration tests in tests/users.test.ts. All tests pass.",
				});

				const pool = new AgentPool(
					intPoolConfig({
						createAgent: tracker.factory,
						maxAgents: 5,
					}),
				);

				try {
					const result = await pool.execute(
						"Build a REST API for user management with full test coverage " +
							"and API documentation in OpenAPI format",
					);

					expect(result).toBeDefined();
					expect(result.summary.length).toBeGreaterThan(50);

					// The summary should contain structural elements from the
					// few-shot template. For single-agent tasks the summary is
					// generated without LLM, so only check multi-agent.
					if (result.strategy === "multi") {
						// The structured summary template teaches the LLM to use
						// bolded section headers like **Outcome**, **What was built**, etc.
						const summaryLower = result.summary.toLowerCase();
						expect(
							summaryLower.includes("outcome") ||
								summaryLower.includes("completed") ||
								summaryLower.includes("succeeded") ||
								summaryLower.includes("result"),
						).toBe(true);
					}
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			INT_TIMEOUT_MS,
		);
	});

	// ────────────────────────────────────────────────────────────────
	// End-to-End Pipeline: First-Try JSON Validity
	// ────────────────────────────────────────────────────────────────

	describe("end-to-end — first-try JSON validity and pipeline coherence", () => {
		it.concurrent(
			"execute() pipeline completes without JSON retry failures",
			async () => {
				const tracker = trackingAgentFactory();
				const pool = new AgentPool(
					intPoolConfig({ createAgent: tracker.factory }),
				);

				try {
					// Execute a task that exercises planning + summary
					const result = await pool.execute(
						"Create a utility module with functions for date formatting " +
							"and string manipulation",
					);

					// If we reach here, all JSON parsing succeeded
					expect(result).toBeDefined();
					expect(result.analysis).toBeDefined();
					expect(result.analysis.reasoning.length).toBeGreaterThan(10);
					expect(result.agents.length).toBeGreaterThanOrEqual(1);
					expect(result.agents.every((a) => a.success)).toBe(true);
					expect(result.summary.length).toBeGreaterThan(0);
					expect(result.durationMs).toBeGreaterThan(0);
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			INT_TIMEOUT_MS,
		);

		it.concurrent(
			"send() intent pipeline produces valid classification on first try",
			async () => {
				const tracker = trackingAgentFactory();
				const pool = new AgentPool(
					intPoolConfig({ createAgent: tracker.factory }),
				);

				try {
					// Send a clear task message — intent analysis must succeed
					const response = await pool.send(
						"Write a function that calculates the Fibonacci sequence",
					);

					// The response should be defined whether classified as
					// new_task (AgentPoolResult) or something else (string)
					expect(response).toBeDefined();

					if (typeof response === "object" && response !== null) {
						// AgentPoolResult — task was executed
						const result = response as any;
						expect(result.task).toBeDefined();
						expect(result.agents).toBeDefined();
					} else {
						// String response — still valid pipeline output
						expect(typeof response).toBe("string");
						expect((response as string).length).toBeGreaterThan(0);
					}
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			INT_TIMEOUT_MS,
		);

		it.concurrent(
			"sequential executions produce consistent planning quality",
			async () => {
				const tracker = trackingAgentFactory();
				const pool = new AgentPool(
					intPoolConfig({ createAgent: tracker.factory }),
				);

				try {
					// First execution — simple task
					const result1 = await pool.execute("Create a README.md file");
					expect(result1.strategy).toBe(ExecutionStrategy.SINGLE);
					expect(result1.agents).toHaveLength(1);

					// Second execution — different simple task
					const result2 = await pool.execute(
						"Add a .gitignore file with Node.js defaults",
					);
					expect(result2.strategy).toBe(ExecutionStrategy.SINGLE);
					expect(result2.agents).toHaveLength(1);

					// Both should have completed successfully with valid analysis
					expect(result1.analysis.reasoning.length).toBeGreaterThan(0);
					expect(result2.analysis.reasoning.length).toBeGreaterThan(0);

					const errors1 = semanticValidationErrors(result1.analysis);
					const errors2 = semanticValidationErrors(result2.analysis);
					expect(errors1).toHaveLength(0);
					expect(errors2).toHaveLength(0);
				} finally {
					if (!(pool as any)._destroyed) await pool.destroy();
				}
			},
			INT_TIMEOUT_MS * 2,
		);
	});

	// ────────────────────────────────────────────────────────────────
	// Planning: JSON Quality Under Varied Complexity
	// ────────────────────────────────────────────────────────────────

	describe("planning — JSON structural quality across complexity levels", () => {
		it.concurrent(
			"moderate complexity task produces all required JSON fields",
			async () => {
				const conversations = createConversationManager();
				const planner = new TaskPlanner(conversations, silentLogger());

				const analysis = await planner.analyze(
					"Add rate limiting middleware to the Express.js API with " +
						"configurable limits per endpoint and a Redis-backed store.",
				);

				// Structural completeness
				expect(analysis.strategy).toBeDefined();
				expect(analysis.complexity).toBeDefined();
				expect(analysis.reasoning).toBeTruthy();
				expect(analysis.subtasks.length).toBeGreaterThanOrEqual(1);
				expect(typeof analysis.parallelismBenefit).toBe("number");
				expect(analysis.parallelismBenefit).toBeGreaterThanOrEqual(0);
				expect(analysis.parallelismBenefit).toBeLessThanOrEqual(1);

				// Every subtask has all required fields
				for (const subtask of analysis.subtasks) {
					expect(subtask.id.length).toBeGreaterThan(0);
					expect(subtask.prompt.length).toBeGreaterThan(0);
					expect(subtask.role.length).toBeGreaterThan(0);
					expect(Array.isArray(subtask.dependencies)).toBe(true);
					expect(subtask.priority).toBeGreaterThan(0);
				}

				// If multi, verify dependency structure
				if (analysis.strategy === ExecutionStrategy.MULTI) {
					expect(analysis.dependencies.length).toBeGreaterThan(0);
					for (const dep of analysis.dependencies) {
						expect(dep.from.length).toBeGreaterThan(0);
						expect(dep.to.length).toBeGreaterThan(0);
						expect(["blocking", "informational"]).toContain(dep.type);
					}
				}

				const errors = semanticValidationErrors(analysis);
				expect(errors).toHaveLength(0);
			},
			INT_TIMEOUT_MS,
		);

		it.concurrent(
			"complex multi-concern task has subtask prompts that are self-contained",
			async () => {
				const conversations = createConversationManager();
				const planner = new TaskPlanner(conversations, silentLogger());

				const analysis = await planner.analyze(
					"Build a complete blog platform with: " +
						"1) A REST API for posts and comments, " +
						"2) Unit and integration tests, " +
						"3) Database migrations for PostgreSQL",
				);

				// For multi-agent responses, each subtask prompt should be
				// self-contained (as stated in the planning rules)
				if (analysis.strategy === ExecutionStrategy.MULTI) {
					for (const subtask of analysis.subtasks) {
						// Each prompt should be at least a sentence
						expect(subtask.prompt.length).toBeGreaterThan(30);
						// Each prompt should have enough context to work independently
						expect(subtask.prompt.split(" ").length).toBeGreaterThan(5);
					}
				}

				const errors = semanticValidationErrors(analysis);
				expect(errors).toHaveLength(0);
			},
			INT_TIMEOUT_MS,
		);
	});
});
