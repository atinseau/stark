import { EventEmitter } from "node:events";
import type { StopReason } from "@agentclientprotocol/sdk";
import type pino from "pino";
import { AgentEvent } from "../../enums/agent-event.enum.ts";
import { AgentStatus } from "../../enums/agent-status.enum.ts";
import { ConversationRole } from "../../enums/conversation-role.enum.ts";
import type { ExecutionStrategy } from "../../enums/execution-strategy.enum.ts";
import { PoolEvent } from "../../enums/pool-event.enum.ts";
import { UserIntent } from "../../enums/user-intent.enum.ts";
import { createLogger } from "../../logger/create-logger.ts";
import {
	contextAnalysisSystemPrompt,
	intentAnalysisPrompt,
	intentAnalysisSystemPrompt,
	summaryPrompt,
	summarySystemPrompt,
} from "../../prompts/index.ts";
import type { AgentConfig, LogOutputConfig } from "../../types/agent.types.ts";
import type {
	AgentExecutionResult,
	AgentFactory,
	AgentPoolConfig,
	AgentPoolResult,
	AgentPoolState,
	BasePoolEvent,
	ContextDelta,
	IntentAnalysis,
	NotificationPreference,
	PoolEventMap,
	PoolManagedAgent,
	SubTask,
	TaskAnalysis,
} from "../../types/agent-pool.types.ts";
import { isoNow } from "../../utils/formatting.ts";
import { generateIdentity } from "../../utils/identity.ts";
import { Agent } from "../agent/agent.ts";
import { Tracer } from "../tracer/tracer.ts";
import { ContextTracker } from "./context-tracker.ts";
import { ConversationManager } from "./conversation-manager.ts";
import { InformationBroker } from "./information-broker.ts";
import { NotificationEngine } from "./notification-engine.ts";
import { TaskPlanner } from "./task-planner.ts";

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-20250514";
const DEFAULT_MAX_AGENTS = 5;

// ── Intent Validator ───────────────────────────────────────────────────────

function validateIntentAnalysis(data: unknown): IntentAnalysis | null {
	if (data == null || typeof data !== "object") return null;
	const obj = data as Record<string, unknown>;

	const validIntents = [
		"new_task",
		"notification_preference",
		"status_query",
		"context_injection",
		"cancel",
		"unknown",
	];
	if (typeof obj.intent !== "string" || !validIntents.includes(obj.intent))
		return null;
	if (typeof obj.confidence !== "number") return null;
	if (typeof obj.reasoning !== "string") return null;

	return {
		intent: obj.intent as IntentAnalysis["intent"],
		confidence: Math.max(0, Math.min(1, obj.confidence)),
		parameters:
			obj.parameters != null && typeof obj.parameters === "object"
				? (obj.parameters as Record<string, unknown>)
				: {},
		reasoning: obj.reasoning,
	};
}

// ── AgentPool ──────────────────────────────────────────────────────────────

/**
 * Adaptive multi-agent orchestrator that dynamically decides its own
 * execution architecture based on the nature of the incoming task.
 *
 * AgentPool is the central coordination point for the Stark agent system.
 * It does **not** hardcode whether to use one agent or many — instead, it
 * uses an LLM-driven planner to analyze each task and determine the
 * optimal execution strategy at runtime.
 *
 * ## Core Capabilities
 *
 * - **Adaptive Planning**: An LLM conversation analyzes task complexity,
 *   identifies separable concerns, and decides between single-agent and
 *   multi-agent execution. Simple tasks get a single agent; genuinely
 *   complex tasks with distinct responsibilities get multiple specialized
 *   agents. No artificial splitting.
 *
 * - **Multi-Conversation Isolation**: Four separate LLM conversations
 *   (planner, context-analyzer, intent-analyzer, user-interaction) each
 *   maintain their own message history. This prevents token contamination
 *   and keeps each conversation focused on its responsibility.
 *
 * - **Context Delta Tracking**: Every significant agent event (prompt
 *   completion, tool calls, file writes, errors) is captured and distilled
 *   into structured deltas. These deltas drive the sharing and notification
 *   engines.
 *
 * - **Conditional Information Sharing**: When multiple agents are active,
 *   the information broker evaluates whether output from one agent is
 *   relevant to another's task. Sharing is never automatic — the LLM
 *   decides based on semantic analysis. Agents never know about each other.
 *
 * - **Silence-by-Default Notifications**: No automatic user notifications
 *   are sent unless the user explicitly requests them. Preferences are
 *   memorized and applied to all subsequent deltas.
 *
 * - **OpenRouter-Only LLM**: All orchestration intelligence runs through
 *   the `@openrouter/sdk`. The model is configurable but the provider is
 *   not interchangeable.
 *
 * ## Distributed Tracing
 *
 * When `tracing` is enabled in the pool config, the AgentPool creates a
 * root trace that encompasses the entire execution lifecycle. All agents
 * spawned by the pool automatically inherit the pool's trace context via
 * `parentSpanContext`, creating a unified trace hierarchy visible in Seq
 * (or any OTLP-compatible backend):
 *
 *   pool.execution (AgentPool root span)
 *   ├── pool.planning
 *   ├── pool.spawn-agents
 *   │   └── pool.agent.spawn (per agent)
 *   │       └── agent.session (Agent root — linked via parentSpanContext)
 *   │           ├── agent.prompt
 *   │           │   ├── agent.tool_call
 *   │           │   └── …
 *   │           └── …
 *   ├── pool.execute-subtasks
 *   │   └── pool.subtask.execute (per subtask)
 *   ├── pool.summary
 *   ├── pool.cleanup
 *   └── pool.send / pool.intent-analysis / …
 *
 * ## Architecture Constraints
 *
 * - The `Agent` class is **never modified**. AgentPool wraps it.
 * - No inverse dependency: Agent does not know about AgentPool.
 * - Decision logic is **never hardcoded** — it's LLM-driven.
 * - Multi-agent is **never forced** — single agent when appropriate.
 *
 * ## Event System
 *
 * AgentPool extends `EventEmitter` with a typed event system for
 * pool-level events (planning, agent lifecycle, sharing decisions,
 * notifications, etc.). Consumers can subscribe to fine-grained
 * events for monitoring and debugging.
 *
 * @example
 * ```ts
 * const pool = new AgentPool({
 *   openRouterApiKey: process.env.OPENROUTER_API_KEY!,
 *   model: "anthropic/claude-sonnet-4-20250514",
 *   logOutput: { console: true, seq: true },
 *   logLevel: "info",
 *   cwd: "/my/project",
 *   agentConfig: { autoApprove: true },
 *   tracing: true, // enable distributed tracing
 * });
 *
 * // Execute a task — the pool decides the strategy
 * const result = await pool.execute("Build a REST API with tests");
 * console.log(result.strategy);  // "single" or "multi"
 * console.log(result.summary);   // LLM-generated execution summary
 *
 * // Send a follow-up message
 * await pool.send("Notify me of important changes");
 * await pool.send("Now add authentication to the API");
 *
 * await pool.destroy();
 * ```
 */
export class AgentPool extends EventEmitter {
	// ── Identity ───────────────────────────────────────────────────────

	/** Pool identity for logging and tracing. */
	private readonly identity = generateIdentity({ name: "AgentPool" });

	// ── Configuration ──────────────────────────────────────────────────

	/** Resolved configuration with defaults applied. */
	private readonly config: Required<
		Pick<AgentPoolConfig, "model" | "maxAgents" | "maxRetries" | "temperature">
	> &
		AgentPoolConfig;

	/** Factory function for creating agent instances. */
	private readonly agentFactory: AgentFactory;

	// ── Infrastructure ─────────────────────────────────────────────────

	/** Structured logger for pool operations. */
	readonly logger: pino.Logger;

	/** Multi-conversation LLM manager. */
	private readonly conversations: ConversationManager;

	/** Task analysis and decomposition engine. */
	private readonly planner: TaskPlanner;

	/** Per-agent context state and delta computation. */
	private readonly contextTracker: ContextTracker;

	/** User notification engine (silence by default). */
	private readonly notificationEngine: NotificationEngine;

	/** OpenTelemetry tracer for distributed tracing. */
	private readonly tracer: Tracer;

	// ── Runtime State ──────────────────────────────────────────────────

	/** Whether the pool is currently executing a task. */
	private _executing = false;

	/** The current task description, if any. */
	private _currentTask: string | null = null;

	/** The current execution strategy, if planning is complete. */
	private _currentStrategy: ExecutionStrategy | null = null;

	/** The current task analysis, if planning is complete. */
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: tracked for future introspection and debugging
	private _currentAnalysis: TaskAnalysis | null = null;

	/** All currently managed agents, keyed by agent ID. */
	private readonly managedAgents = new Map<
		string,
		{
			agent: PoolManagedAgent;
			subtask: SubTask;
			result: AgentExecutionResult | null;
		}
	>();

	/** Maps subtask IDs to agent IDs for dependency resolution. */
	private readonly subtaskToAgent = new Map<string, string>();

	/** Maps agent IDs to subtask IDs (reverse of above). */
	private readonly agentToSubtask = new Map<string, string>();

	/** Information broker (created per-execution since it needs dependencies). */
	private informationBroker: InformationBroker | null = null;

	/** Running count of deltas detected. */
	private _deltaCount = 0;

	/** Running count of sharing decisions made. */
	private _sharingDecisionCount = 0;

	/** Whether the pool has been destroyed. */
	private _destroyed = false;

	// ── Constructor ────────────────────────────────────────────────────

	constructor(config: AgentPoolConfig) {
		super();

		// Apply defaults
		this.config = {
			model: config.model ?? DEFAULT_MODEL,
			maxAgents: config.maxAgents ?? DEFAULT_MAX_AGENTS,
			maxRetries: config.maxRetries ?? 3,
			temperature: config.temperature ?? 0.2,
			...config,
		};

		// Agent factory — defaults to real Agent class
		this.agentFactory =
			config.createAgent ??
			((agentCfg?: AgentConfig): PoolManagedAgent =>
				new Agent(agentCfg) as unknown as PoolManagedAgent);

		// Resolve pool-level log output config — used for both the pool's
		// own logger AND forwarded to all spawned agents.
		const poolLogOutput: LogOutputConfig = config.logOutput ?? {
			console: true,
		};
		const poolLogLevel = config.logLevel ?? "info";

		// Create tracer (no-op when tracing is disabled) — must be created
		// BEFORE the logger so we can inject trace context into log bindings.
		// When logOutput.seq is explicitly false, tracing is disabled
		// regardless of config.tracing — nothing should be sent to Seq.
		const tracingConfig = this.config.tracing;
		const seqDisabled = config.logOutput?.seq === false;
		this.tracer = new Tracer({
			enabled: !!tracingConfig && !seqDisabled,
			...(typeof tracingConfig === "string" ? { endpoint: tracingConfig } : {}),
			serviceName: "stark-agent-pool",
			tracerName: "stark-agent-pool",
		});

		// Start the root span immediately so traceId is available for the logger.
		// This root span lives for the entire lifetime of the pool.
		this.tracer.startRootSpan("pool.lifecycle", {
			"pool.id": this.identity.id,
			"pool.name": this.identity.name,
			"pool.model": this.config.model,
			"pool.max_agents": this.config.maxAgents,
		});

		// Logger — with dynamic trace context correlation
		// Uses pool-level logOutput/logLevel (not agentConfig).
		this.logger = createLogger(this.identity, {
			logOutput: poolLogOutput,
			logLevel: poolLogLevel,
			traceContextProvider: () => this.tracer.getTraceContext(),
		});

		// Multi-conversation LLM manager
		this.conversations = new ConversationManager(
			{
				apiKey: this.config.openRouterApiKey,
				model: this.config.model,
				maxRetries: this.config.maxRetries,
				temperature: this.config.temperature,
			},
			this.logger,
		);

		// Register all conversation roles with their system prompts
		this.conversations.register(
			ConversationRole.CONTEXT_ANALYZER,
			contextAnalysisSystemPrompt({}),
		);
		this.conversations.register(
			ConversationRole.USER_INTERACTION,
			summarySystemPrompt({}),
		);
		this.conversations.register(
			ConversationRole.INTENT_ANALYZER,
			intentAnalysisSystemPrompt({}),
		);

		// Sub-systems
		this.planner = new TaskPlanner(this.conversations, this.logger);
		this.contextTracker = new ContextTracker();
		this.notificationEngine = new NotificationEngine(
			this.conversations,
			this.logger,
		);

		this.logger.info(
			{
				model: this.config.model,
				maxAgents: this.config.maxAgents,
			},
			"AgentPool created",
		);
	}

	// ── Public API: Execute ────────────────────────────────────────────

	/**
	 * Executes a task by analyzing it, deciding on a strategy, spawning
	 * agent(s), and orchestrating the full execution pipeline.
	 *
	 * This is the main entry point for task execution. The method:
	 *
	 * 1. Analyzes the task via the LLM-driven planner
	 * 2. Decides: single agent or multiple agents
	 * 3. Spawns the appropriate number of agents
	 * 4. Executes subtasks (respecting dependencies and parallelism)
	 * 5. Monitors context deltas for sharing and notifications
	 * 6. Aggregates results and generates an execution summary
	 *
	 * @param task - The user's task description.
	 * @returns A complete {@link AgentPoolResult} with all execution details.
	 * @throws If the pool has been destroyed.
	 */
	async execute(task: string): Promise<AgentPoolResult> {
		this.assertNotDestroyed();

		if (this._executing) {
			throw new Error(
				"AgentPool is already executing a task. Wait for the current execution to complete or cancel it.",
			);
		}

		const startTime = Date.now();
		this._executing = true;
		this._currentTask = task;

		this.emitPoolEvent(PoolEvent.TASK_RECEIVED, { task });

		// ── Tracing: start execution span ────────────────────────────────
		const executionSpan = this.tracer.startActiveSpan("pool.execution", {
			"pool.task": task.slice(0, 500),
			"pool.task_length": task.length,
		});

		try {
			// ── Phase 1: Planning ────────────────────────────────────────
			this.emitPoolEvent(PoolEvent.PLANNING_START, { task });
			this.logger.info({ taskLength: task.length }, "Phase 1: Planning");

			const analysis = await this.tracer.traced(
				"pool.planning",
				async (span) => {
					const result = await this.planner.analyze(task);
					span.setAttribute("pool.planning.strategy", result.strategy);
					span.setAttribute(
						"pool.planning.subtask_count",
						result.subtasks.length,
					);
					span.setAttribute("pool.planning.complexity", result.complexity);
					return result;
				},
				{ parent: "active" },
			);

			this._currentAnalysis = analysis;
			this._currentStrategy = analysis.strategy;

			this.emitPoolEvent(PoolEvent.PLANNING_COMPLETE, { analysis });

			this.logger.info(
				{
					strategy: analysis.strategy,
					subtaskCount: analysis.subtasks.length,
					complexity: analysis.complexity,
				},
				`Planning complete: ${analysis.strategy} strategy, ${analysis.subtasks.length} subtask(s)`,
			);

			// ── Phase 2: Spawn Agents ────────────────────────────────────
			this.logger.info("Phase 2: Spawning agents");

			const agents = await this.tracer.traced(
				"pool.spawn-agents",
				async (span) => {
					const result = await this.spawnAgents(analysis);
					span.setAttribute("pool.spawn.agent_count", result.size);
					return result;
				},
				{ parent: "active" },
			);

			// ── Phase 3: Execute Subtasks ────────────────────────────────
			this.logger.info("Phase 3: Executing subtasks");

			// Create the information broker for this execution
			this.informationBroker = new InformationBroker(
				this.conversations,
				this.contextTracker,
				analysis.dependencies,
				this.logger,
			);

			const executionResults = await this.tracer.traced(
				"pool.execute-subtasks",
				async (span) => {
					const results = await this.executeSubtasks(analysis, agents);
					span.setAttribute("pool.execute.result_count", results.length);
					span.setAttribute(
						"pool.execute.success_count",
						results.filter((r) => r.success).length,
					);
					span.setAttribute(
						"pool.execute.failure_count",
						results.filter((r) => !r.success).length,
					);
					return results;
				},
				{ parent: "active" },
			);

			// ── Phase 4: Generate Summary ────────────────────────────────
			this.logger.info("Phase 4: Generating summary");

			const summary = await this.tracer.traced(
				"pool.summary",
				async (_span) => {
					return this.generateSummary(task, analysis, executionResults);
				},
				{ parent: "active" },
			);

			// ── Phase 5: Cleanup ─────────────────────────────────────────
			this.logger.info("Phase 5: Cleanup");

			await this.tracer.traced(
				"pool.cleanup",
				async (_span) => {
					await this.destroyManagedAgents();
				},
				{ parent: "active" },
			);

			const durationMs = Date.now() - startTime;

			const result: AgentPoolResult = {
				task,
				strategy: analysis.strategy,
				analysis,
				agents: executionResults,
				summary,
				durationMs,
			};

			this.emitPoolEvent(PoolEvent.EXECUTION_COMPLETE, { result });

			this.logger.info(
				{
					strategy: analysis.strategy,
					agentCount: executionResults.length,
					durationMs,
					deltaCount: this._deltaCount,
					sharingDecisions: this._sharingDecisionCount,
				},
				`Execution complete in ${durationMs}ms`,
			);

			// ── Tracing: end execution span (success) ────────────────────
			if (executionSpan.isRecording()) {
				executionSpan.setAttribute(
					"pool.execution.strategy",
					analysis.strategy,
				);
				executionSpan.setAttribute(
					"pool.execution.agent_count",
					executionResults.length,
				);
				executionSpan.setAttribute("pool.execution.duration_ms", durationMs);
				executionSpan.setAttribute(
					"pool.execution.delta_count",
					this._deltaCount,
				);
				executionSpan.setAttribute(
					"pool.execution.sharing_decisions",
					this._sharingDecisionCount,
				);
			}
			this.tracer.endActiveSpan(executionSpan);

			return result;
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);

			this.emitPoolEvent(PoolEvent.ERROR, {
				error: errorMessage,
				context: "execute",
			});

			this.logger.error({ error: errorMessage }, "Execution failed");

			// ── Tracing: end execution span (error) ──────────────────────
			this.tracer.endActiveSpan(
				executionSpan,
				error instanceof Error ? error : new Error(String(error)),
			);

			// Cleanup on failure
			await this.destroyManagedAgents();

			throw error;
		} finally {
			this._executing = false;
			this._currentTask = null;
			this._currentStrategy = null;
			this._currentAnalysis = null;
			this.informationBroker = null;
			this.subtaskToAgent.clear();
			this.agentToSubtask.clear();
			this._deltaCount = 0;
			this._sharingDecisionCount = 0;
		}
	}

	// ── Public API: Send Message ───────────────────────────────────────

	/**
	 * Sends a message to the agent pool for processing.
	 *
	 * The message is analyzed by the intent analyzer to determine the
	 * user's intent, then routed to the appropriate handler:
	 *
	 * - **new_task**: Starts a new execution via `execute()`.
	 * - **notification_preference**: Updates notification settings.
	 * - **status_query**: Returns current pool state as a string.
	 * - **context_injection**: Injects context into active agents.
	 * - **cancel**: Cancels the current execution.
	 * - **unknown**: Returns a help message.
	 *
	 * @param message - The user's message.
	 * @returns A response string, or an `AgentPoolResult` for new tasks.
	 */
	async send(message: string): Promise<string | AgentPoolResult> {
		this.assertNotDestroyed();

		this.logger.info(
			{ messageLength: message.length },
			"Processing user message",
		);

		// Analyze intent
		const intent = await this.tracer.traced(
			"pool.intent-analysis",
			async (span) => {
				const result = await this.analyzeIntent(message);
				span.setAttribute("pool.intent.type", result.intent);
				span.setAttribute("pool.intent.confidence", result.confidence);
				return result;
			},
			{
				attributes: {
					"pool.send.message_length": message.length,
				},
				parent: "root",
			},
		);

		this.logger.info(
			{
				intent: intent.intent,
				confidence: intent.confidence,
			},
			`Intent classified: ${intent.intent} (confidence: ${intent.confidence})`,
		);

		switch (intent.intent) {
			case UserIntent.NEW_TASK: {
				const taskText =
					typeof intent.parameters.task === "string"
						? intent.parameters.task
						: message;
				return this.execute(taskText);
			}

			case UserIntent.NOTIFICATION_PREFERENCE: {
				const enabled = intent.parameters.enabled !== false;
				const minSignificance =
					typeof intent.parameters.minSignificance === "number"
						? intent.parameters.minSignificance
						: 0.5;

				this.notificationEngine.setPreference({
					enabled,
					minSignificance,
				});

				return enabled
					? `Notifications enabled (minimum significance: ${minSignificance}).`
					: "Notifications disabled.";
			}

			case UserIntent.STATUS_QUERY: {
				const state = this.getState();
				if (!state.executing) {
					return "The pool is idle. No task is currently being executed.";
				}

				const lines: string[] = [
					`**Current Task**: ${state.currentTask}`,
					`**Strategy**: ${state.strategy}`,
					`**Active Agents**: ${state.activeAgentCount}`,
					"",
					"**Agents**:",
				];

				for (const agent of state.agents) {
					lines.push(
						`- ${agent.agentName} (${agent.taskRole}): ${agent.completed ? "✅ completed" : `⚙️ ${agent.status}`}`,
					);
				}

				return lines.join("\n");
			}

			case UserIntent.CONTEXT_INJECTION: {
				const instructions =
					typeof intent.parameters.instructions === "string"
						? intent.parameters.instructions
						: message;

				if (this.managedAgents.size === 0) {
					return "No active agents to inject context into.";
				}

				// Inject into all active agents
				let injectedCount = 0;
				for (const { agent } of this.managedAgents.values()) {
					if (agent.status !== AgentStatus.DESTROYED) {
						try {
							agent.injectContext(instructions);
							injectedCount++;
						} catch {
							// Agent may have been destroyed between the check and the call
						}
					}
				}

				this.tracer.recordEvent("root", "pool.context_injected", {
					"pool.inject.agent_count": injectedCount,
					"pool.inject.instructions_length": instructions.length,
				});

				return `Context injected into ${injectedCount} active agent(s).`;
			}

			case UserIntent.CANCEL: {
				if (!this._executing) {
					return "No task is currently executing.";
				}

				this.tracer.recordEvent("root", "pool.execution_cancelled");

				await this.destroyManagedAgents();
				return "Current execution cancelled. All agents destroyed.";
			}

			default:
				return (
					"I couldn't understand your request. You can:\n" +
					"- Send a task to execute\n" +
					"- Ask about current status\n" +
					"- Request notifications (e.g., 'notify me of important changes')\n" +
					"- Inject context into running agents\n" +
					"- Cancel the current execution"
				);
		}
	}

	// ── Public API: State ──────────────────────────────────────────────

	/**
	 * Returns a read-only snapshot of the pool's current state.
	 */
	getState(): AgentPoolState {
		const agents = Array.from(this.managedAgents.values()).map(
			({ agent, subtask }) => ({
				agentId: agent.id,
				agentName: agent.name,
				status: agent.status,
				taskRole: subtask.role,
				completed:
					this.contextTracker.getAgentState(agent.id)?.completed ?? false,
			}),
		);

		return {
			executing: this._executing,
			currentTask: this._currentTask,
			strategy: this._currentStrategy,
			activeAgentCount: this.managedAgents.size,
			agents,
			notificationsEnabled: this.notificationEngine.isEnabled,
			deltaCount: this._deltaCount,
			sharingDecisionCount: this._sharingDecisionCount,
		};
	}

	/**
	 * Sets the user's notification preference directly.
	 *
	 * This is a convenience method that bypasses intent analysis.
	 * Equivalent to sending a message like "Notify me of important changes"
	 * but without the LLM roundtrip.
	 *
	 * @param preference - The notification preference to apply.
	 */
	setNotificationPreference(preference: NotificationPreference): void {
		this.notificationEngine.setPreference(preference);
	}

	// ── Public API: Destroy ────────────────────────────────────────────

	/**
	 * Destroys the pool and all managed agents.
	 *
	 * After calling `destroy()`, the pool cannot be reused.
	 */
	async destroy(): Promise<void> {
		if (this._destroyed) return;

		this._destroyed = true;

		this.logger.info("Destroying AgentPool");

		await this.destroyManagedAgents();

		this.emitPoolEvent(PoolEvent.DESTROYED, {});

		this.logger.info("AgentPool destroyed");

		// ── Tracing: flush all spans and shut down after the last log ────
		// Placed at the very end so that all logs above retain their
		// TraceId/SpanId via the pino mixin (shutdown nulls rootSpan).
		await this.tracer.shutdown();
	}

	// ── Typed EventEmitter Overrides ───────────────────────────────────

	override on<K extends PoolEvent>(
		event: K,
		listener: (payload: PoolEventMap[K]) => void,
	): this {
		return super.on(event, listener);
	}

	override once<K extends PoolEvent>(
		event: K,
		listener: (payload: PoolEventMap[K]) => void,
	): this {
		return super.once(event, listener);
	}

	override off<K extends PoolEvent>(
		event: K,
		listener: (payload: PoolEventMap[K]) => void,
	): this {
		return super.off(event, listener);
	}

	override emit<K extends PoolEvent>(
		event: K,
		payload: PoolEventMap[K],
	): boolean {
		return super.emit(event, payload);
	}

	// ── Private: Agent Spawning ────────────────────────────────────────

	/**
	 * Spawns agents for all subtasks and waits for them to be ready.
	 *
	 * Enforces the `maxAgents` configuration limit. Each agent is
	 * registered with the context tracker and wired to emit pool events.
	 *
	 * When tracing is enabled, each agent receives the pool's current
	 * active span context as its `parentSpanContext`, linking the agent's
	 * entire trace tree under the pool's spawn span.
	 *
	 * @param analysis - The task analysis with subtasks to spawn agents for.
	 * @returns A map of subtask ID → managed agent entry.
	 */
	private async spawnAgents(
		analysis: TaskAnalysis,
	): Promise<Map<string, { agent: PoolManagedAgent; subtask: SubTask }>> {
		const agents = new Map<
			string,
			{ agent: PoolManagedAgent; subtask: SubTask }
		>();

		// Enforce max agents
		const subtasksToSpawn = analysis.subtasks.slice(0, this.config.maxAgents);

		if (subtasksToSpawn.length < analysis.subtasks.length) {
			this.logger.warn(
				{
					requested: analysis.subtasks.length,
					limit: this.config.maxAgents,
					spawning: subtasksToSpawn.length,
				},
				`Subtask count exceeds maxAgents limit (${this.config.maxAgents}), truncating`,
			);
		}

		// Spawn all agents in parallel
		const spawnPromises = subtasksToSpawn.map(async (subtask) => {
			// ── Tracing: per-agent spawn span ────────────────────────────
			const spawnSpan = this.tracer.startOperation(
				"pool.agent.spawn",
				{
					"pool.agent.subtask_id": subtask.id,
					"pool.agent.role": subtask.role,
				},
				"active",
			);
			this.tracer.enterSpan(spawnSpan);

			try {
				// Resolve the parent span context for the agent's tracer.
				// The agent's root span will be a child of this spawn span,
				// creating the unified trace hierarchy.
				const parentSpanContext = this.tracer.getActiveSpanContext();

				// Build the agent config, forwarding pool-level logOutput,
				// logLevel, and cwd as defaults. agentConfig can override them.
				const agentConfig: AgentConfig = {
					// Pool-level defaults
					logOutput: this.config.logOutput,
					logLevel: this.config.logLevel,
					cwd: this.config.cwd,
					// Agent-specific overrides
					...this.config.agentConfig,
					// Always set the subtask role as agent name
					name: subtask.role,
					// Propagate tracing to agents so they are always linked
					...(this.config.tracing
						? {
								tracing: this.config.tracing,
								parentSpanContext,
							}
						: {}),
				};

				const agent = this.agentFactory(agentConfig);

				// Register with context tracker
				this.contextTracker.registerAgent(agent.id, agent.name, subtask);

				// Map subtask ↔ agent IDs
				this.subtaskToAgent.set(subtask.id, agent.id);
				this.agentToSubtask.set(agent.id, subtask.id);

				// Wire agent events to pool delta tracking
				this.wireAgentEvents(agent, subtask);

				// Store in managed agents
				const entry = {
					agent,
					subtask,
					result: null as AgentExecutionResult | null,
				};
				this.managedAgents.set(agent.id, entry);
				agents.set(subtask.id, { agent, subtask });

				this.emitPoolEvent(PoolEvent.AGENT_SPAWNED, {
					agentId: agent.id,
					agentName: agent.name,
					subtask,
				});

				this.logger.info(
					{
						agentId: agent.id,
						agentName: agent.name,
						subtaskId: subtask.id,
						role: subtask.role,
					},
					`Agent spawned: ${agent.name} for ${subtask.role}`,
				);

				// Wait for agent to be ready
				try {
					await agent.ready;

					if (spawnSpan.isRecording()) {
						spawnSpan.setAttribute("pool.agent.id", agent.id);
						spawnSpan.setAttribute("pool.agent.name", agent.name);
					}
				} catch (error) {
					const errorMessage =
						error instanceof Error ? error.message : String(error);

					this.logger.error(
						{
							agentId: agent.id,
							error: errorMessage,
						},
						`Agent failed to initialize: ${errorMessage}`,
					);

					this.contextTracker.markFailed(agent.id, errorMessage);

					this.emitPoolEvent(PoolEvent.AGENT_ERROR, {
						agentId: agent.id,
						agentName: agent.name,
						error: errorMessage,
					});
				}

				this.tracer.endOperation(spawnSpan);
			} catch (error) {
				this.tracer.endOperation(
					spawnSpan,
					error instanceof Error ? error : new Error(String(error)),
				);
			} finally {
				this.tracer.leaveSpan(spawnSpan);
			}

			return { subtask, agent: agents.get(subtask.id)?.agent };
		});

		await Promise.allSettled(spawnPromises);

		return agents;
	}

	/**
	 * Wires an agent's events to the pool's delta tracking system.
	 *
	 * Subscribes to all significant agent events and feeds them into
	 * the context tracker. When a delta is produced, it triggers
	 * sharing evaluation and notification checking.
	 */
	private wireAgentEvents(agent: PoolManagedAgent, _subtask: SubTask): void {
		const significantEvents = [
			AgentEvent.PROMPT_COMPLETE,
			AgentEvent.TOOL_START,
			AgentEvent.TOOL_COMPLETE,
			AgentEvent.TOOL_FAILED,
			AgentEvent.AGENT_ERROR,
			AgentEvent.AGENT_IDLE,
			AgentEvent.AGENT_BUSY,
			AgentEvent.AGENT_READY,
			AgentEvent.AGENT_DESTROYED,
			AgentEvent.PLAN_UPDATE,
			AgentEvent.FS_WRITE,
			AgentEvent.FS_READ,
			AgentEvent.USAGE_UPDATE,
		];

		for (const eventType of significantEvents) {
			agent.on(eventType, (...args: unknown[]) => {
				const payload = (args[0] ?? {}) as Record<string, unknown>;
				const delta = this.contextTracker.processEvent(
					agent.id,
					eventType,
					payload,
				);

				if (delta) {
					this._deltaCount++;
					this.emitPoolEvent(PoolEvent.DELTA_DETECTED, { delta });

					// Record delta as a trace event on the root span
					this.tracer.recordEvent("root", "pool.delta_detected", {
						"delta.agent_id": delta.agentId,
						"delta.type": delta.type,
						"delta.significance": delta.significance,
					});

					// Fire-and-forget: don't block the agent event handler
					void this.handleDelta(delta);
				}
			});
		}
	}

	// ── Private: Subtask Execution ─────────────────────────────────────

	/**
	 * Executes all subtasks respecting their dependency graph.
	 *
	 * Uses a topological-sort-like approach:
	 * 1. Find all subtasks with no unsatisfied dependencies → run in parallel
	 * 2. When a subtask completes, check if it unblocks any waiting subtasks
	 * 3. Repeat until all subtasks are done or all remaining have unsatisfiable deps
	 *
	 * For single-agent strategy, this degenerates to a single sequential prompt.
	 *
	 * @param analysis - The task analysis with subtasks and dependencies.
	 * @param agents   - The spawned agents mapped by subtask ID.
	 * @returns An array of execution results for all subtasks.
	 */
	private async executeSubtasks(
		analysis: TaskAnalysis,
		agents: Map<string, { agent: PoolManagedAgent; subtask: SubTask }>,
	): Promise<AgentExecutionResult[]> {
		const results: AgentExecutionResult[] = [];
		const completed = new Set<string>();
		const failed = new Set<string>();
		const inProgress = new Set<string>();
		const remaining = new Set(analysis.subtasks.map((s) => s.id));

		// Build blocking dependency adjacency
		const blockingDeps = new Map<string, Set<string>>();
		for (const subtask of analysis.subtasks) {
			const blockers = new Set<string>();
			for (const depId of subtask.dependencies) {
				// Check if this dependency is blocking
				const dep = analysis.dependencies.find(
					(d) => d.from === depId && d.to === subtask.id,
				);
				if (!dep || dep.type === "blocking") {
					blockers.add(depId);
				}
			}
			blockingDeps.set(subtask.id, blockers);
		}

		/**
		 * Returns subtask IDs that are ready to execute:
		 * - Not yet started
		 * - All blocking dependencies are satisfied (completed or failed)
		 */
		const getReady = (): string[] => {
			const ready: string[] = [];
			for (const id of remaining) {
				if (inProgress.has(id)) continue;
				const blockers = blockingDeps.get(id) ?? new Set();
				const allSatisfied = [...blockers].every(
					(b) => completed.has(b) || failed.has(b),
				);
				if (allSatisfied) {
					ready.push(id);
				}
			}
			// Sort by priority (lower = higher priority)
			ready.sort((a, b) => {
				const subtaskA = analysis.subtasks.find((s) => s.id === a);
				const subtaskB = analysis.subtasks.find((s) => s.id === b);
				return (subtaskA?.priority ?? 99) - (subtaskB?.priority ?? 99);
			});
			return ready;
		};

		// Execute in waves until all are done
		while (remaining.size > 0) {
			const readyIds = getReady();

			if (readyIds.length === 0) {
				if (inProgress.size > 0) {
					// Wait for in-progress tasks to finish
					await new Promise<void>((resolve) => setTimeout(resolve, 500));
					continue;
				}

				// Deadlock: remaining tasks have unsatisfiable dependencies
				this.logger.warn(
					{
						remaining: [...remaining],
						completed: [...completed],
						failed: [...failed],
					},
					"Subtask execution deadlocked — remaining tasks have unsatisfiable dependencies",
				);

				// Record deadlock as a trace event
				this.tracer.recordEvent("active", "pool.subtask_deadlock", {
					"pool.deadlock.remaining_count": remaining.size,
				});

				// Mark remaining as failed
				for (const id of remaining) {
					const entry = agents.get(id);
					if (entry) {
						this.contextTracker.markFailed(
							entry.agent.id,
							"Deadlocked: blocking dependencies could not be satisfied",
						);
						results.push({
							agentId: entry.agent.id,
							agentName: entry.agent.name,
							subtask: entry.subtask,
							promptResult: {
								stopReason: "error" as StopReason,
								text: "",
								usage: null,
							},
							events:
								this.contextTracker.getAgentState(entry.agent.id)?.events ?? [],
							filesWritten:
								this.contextTracker.getAgentState(entry.agent.id)
									?.filesWritten ?? [],
							success: false,
							error: "Deadlocked: blocking dependencies could not be satisfied",
						});
					}
				}
				break;
			}

			// Launch ready subtasks in parallel
			const executionPromises = readyIds.map(async (subtaskId) => {
				inProgress.add(subtaskId);
				remaining.delete(subtaskId);

				const entry = agents.get(subtaskId);
				if (!entry) {
					this.logger.error({ subtaskId }, "No agent found for subtask");
					failed.add(subtaskId);
					inProgress.delete(subtaskId);
					return;
				}

				const { agent, subtask } = entry;

				// Check if the agent initialized successfully
				const agentState = this.contextTracker.getAgentState(agent.id);
				if (agentState?.error) {
					this.logger.warn(
						{ agentId: agent.id, error: agentState.error },
						"Skipping subtask — agent failed to initialize",
					);

					failed.add(subtaskId);
					inProgress.delete(subtaskId);

					results.push({
						agentId: agent.id,
						agentName: agent.name,
						subtask,
						promptResult: {
							stopReason: "error" as StopReason,
							text: "",
							usage: null,
						},
						events: agentState.events,
						filesWritten: agentState.filesWritten,
						success: false,
						error: agentState.error,
					});
					return;
				}

				// ── Tracing: per-subtask execution span ──────────────────
				const subtaskSpan = this.tracer.startOperation(
					"pool.subtask.execute",
					{
						"pool.subtask.id": subtaskId,
						"pool.subtask.role": subtask.role,
						"pool.subtask.agent_id": agent.id,
						"pool.subtask.agent_name": agent.name,
					},
					"active",
				);
				this.tracer.enterSpan(subtaskSpan);

				try {
					this.logger.info(
						{
							agentId: agent.id,
							subtaskId,
							role: subtask.role,
						},
						`Executing subtask: ${subtask.role}`,
					);

					const promptResult = await agent.prompt(subtask.prompt);

					this.contextTracker.recordPromptResult(agent.id, promptResult);
					this.contextTracker.markCompleted(agent.id);

					completed.add(subtaskId);
					inProgress.delete(subtaskId);

					const finalState = this.contextTracker.getAgentState(agent.id);

					const executionResult: AgentExecutionResult = {
						agentId: agent.id,
						agentName: agent.name,
						subtask,
						promptResult,
						events: finalState?.events ?? [],
						filesWritten: finalState?.filesWritten ?? [],
						success: true,
					};

					results.push(executionResult);

					// Store in managed agents map
					const managedEntry = this.managedAgents.get(agent.id);
					if (managedEntry) {
						managedEntry.result = executionResult;
					}

					this.emitPoolEvent(PoolEvent.AGENT_COMPLETED, {
						agentId: agent.id,
						agentName: agent.name,
						result: executionResult,
					});

					this.logger.info(
						{
							agentId: agent.id,
							subtaskId,
							role: subtask.role,
							responseLength: promptResult.text.length,
							stopReason: promptResult.stopReason,
						},
						`Subtask completed: ${subtask.role}`,
					);

					// ── Tracing: end subtask span (success) ──────────────
					if (subtaskSpan.isRecording()) {
						subtaskSpan.setAttribute(
							"pool.subtask.stop_reason",
							promptResult.stopReason,
						);
						subtaskSpan.setAttribute(
							"pool.subtask.response_length",
							promptResult.text.length,
						);
					}
					this.tracer.endOperation(subtaskSpan);
				} catch (error) {
					const errorMessage =
						error instanceof Error ? error.message : String(error);

					this.contextTracker.markFailed(agent.id, errorMessage);

					failed.add(subtaskId);
					inProgress.delete(subtaskId);

					const finalState = this.contextTracker.getAgentState(agent.id);

					results.push({
						agentId: agent.id,
						agentName: agent.name,
						subtask,
						promptResult: {
							stopReason: "error" as StopReason,
							text: "",
							usage: null,
						},
						events: finalState?.events ?? [],
						filesWritten: finalState?.filesWritten ?? [],
						success: false,
						error: errorMessage,
					});

					this.emitPoolEvent(PoolEvent.AGENT_ERROR, {
						agentId: agent.id,
						agentName: agent.name,
						error: errorMessage,
					});

					this.logger.error(
						{
							agentId: agent.id,
							subtaskId,
							error: errorMessage,
						},
						`Subtask failed: ${subtask.role}`,
					);

					// ── Tracing: end subtask span (error) ────────────────
					this.tracer.endOperation(
						subtaskSpan,
						error instanceof Error ? error : new Error(String(error)),
					);
				} finally {
					this.tracer.leaveSpan(subtaskSpan);
				}
			});

			await Promise.allSettled(executionPromises);
		}

		return results;
	}

	// ── Private: Delta Handling ─────────────────────────────────────────

	/**
	 * Handles a context delta by evaluating it for sharing and notifications.
	 *
	 * This method is called fire-and-forget from agent event handlers.
	 * Errors are caught and logged rather than propagated.
	 *
	 * @param delta - The context delta to process.
	 */
	private async handleDelta(delta: ContextDelta): Promise<void> {
		try {
			// ── Information Sharing ─────────────────────────────────────
			if (this.informationBroker && this.contextTracker.agentCount > 1) {
				const decisions = await this.informationBroker.evaluate(delta);

				for (const decision of decisions) {
					this._sharingDecisionCount++;

					this.emitPoolEvent(PoolEvent.SHARING_DECISION, {
						decision,
					});

					if (decision.shouldShare) {
						// Find the target agent and inject context
						const targetEntry = this.managedAgents.get(decision.targetAgentId);

						if (
							targetEntry &&
							targetEntry.agent.status !== AgentStatus.DESTROYED
						) {
							try {
								targetEntry.agent.injectContext(decision.information);

								this.emitPoolEvent(PoolEvent.CONTEXT_SHARED, {
									sourceAgentId: decision.sourceAgentId,
									targetAgentId: decision.targetAgentId,
									information: decision.information,
								});

								this.logger.info(
									{
										sourceAgentId: decision.sourceAgentId,
										targetAgentId: decision.targetAgentId,
										informationLength: decision.information.length,
									},
									"Context shared between agents",
								);

								this.tracer.recordEvent("root", "pool.context_shared", {
									"pool.sharing.source_agent_id": decision.sourceAgentId,
									"pool.sharing.target_agent_id": decision.targetAgentId,
									"pool.sharing.information_length":
										decision.information.length,
								});
							} catch (injectError) {
								this.logger.warn(
									{
										targetAgentId: decision.targetAgentId,
										error:
											injectError instanceof Error
												? injectError.message
												: String(injectError),
									},
									"Failed to inject shared context",
								);
							}
						}
					}
				}
			}

			// ── Notification Engine ────────────────────────────────────
			const agentState = this.contextTracker.getAgentState(delta.agentId);

			if (agentState) {
				const notification = await this.notificationEngine.evaluate(
					delta,
					agentState,
				);

				if (notification) {
					this.emitPoolEvent(PoolEvent.NOTIFICATION, {
						notification,
					});
				}
			}
		} catch (error) {
			this.logger.warn(
				{
					agentId: delta.agentId,
					deltaType: delta.type,
					error: error instanceof Error ? error.message : String(error),
				},
				"Delta handling failed (non-critical)",
			);
		}
	}

	// ── Private: Summary Generation ────────────────────────────────────

	/**
	 * Generates an LLM-powered summary of the full execution.
	 *
	 * Uses the user-interaction conversation to produce a concise,
	 * human-readable summary of what was accomplished.
	 */
	private async generateSummary(
		task: string,
		analysis: TaskAnalysis,
		results: AgentExecutionResult[],
	): Promise<string> {
		try {
			const prompt = summaryPrompt({
				task,
				strategy: analysis.strategy,
				complexity: analysis.complexity,
				planningReasoning: analysis.reasoning,
				agents: results,
				durationMs: 0, // Not known yet at this point
			});

			const summary = await this.conversations.sendOneShot(
				ConversationRole.USER_INTERACTION,
				prompt,
			);

			return summary;
		} catch (error) {
			this.logger.warn(
				{
					error: error instanceof Error ? error.message : String(error),
				},
				"Summary generation failed, using fallback",
			);

			// Fallback: generate a basic summary without LLM
			const successCount = results.filter((r) => r.success).length;
			const failCount = results.length - successCount;

			return (
				`Task "${task.slice(0, 100)}" completed with ${analysis.strategy} strategy. ` +
				`${successCount} subtask(s) succeeded, ${failCount} failed.`
			);
		}
	}

	// ── Private: Intent Analysis ───────────────────────────────────────

	/**
	 * Analyzes a user message to determine their intent.
	 *
	 * Uses the intent-analyzer LLM conversation to classify the
	 * message into one of the defined intent categories.
	 */
	private async analyzeIntent(message: string): Promise<IntentAnalysis> {
		try {
			// Sanitize the message
			const sanitized = this.conversations.client.sanitize(message);

			const prompt = intentAnalysisPrompt({
				message: sanitized,
				poolState: this.getState(),
			});

			const analysis = await this.conversations.sendOneShotJson(
				ConversationRole.INTENT_ANALYZER,
				prompt,
				validateIntentAnalysis,
			);

			return analysis;
		} catch (error) {
			this.logger.warn(
				{
					error: error instanceof Error ? error.message : String(error),
				},
				"Intent analysis failed, defaulting to new_task",
			);

			// Fallback: treat the message as a new task
			return {
				intent: UserIntent.NEW_TASK,
				confidence: 0.5,
				parameters: { task: message },
				reasoning: "Intent analysis failed — defaulting to new_task",
			};
		}
	}

	// ── Private: Agent Cleanup ─────────────────────────────────────────

	/**
	 * Destroys all currently managed agents and cleans up state.
	 */
	private async destroyManagedAgents(): Promise<void> {
		const destroyPromises: Promise<void>[] = [];

		for (const { agent } of this.managedAgents.values()) {
			if (agent.status !== AgentStatus.DESTROYED) {
				destroyPromises.push(
					agent.destroy().catch((err) => {
						this.logger.warn(
							{
								agentId: agent.id,
								error: err instanceof Error ? err.message : String(err),
							},
							"Agent destroy failed",
						);
					}),
				);
			}
		}

		await Promise.allSettled(destroyPromises);

		this.managedAgents.clear();
	}

	// ── Private: Helpers ───────────────────────────────────────────────

	/**
	 * Throws if the pool has been destroyed.
	 */
	private assertNotDestroyed(): void {
		if (this._destroyed) {
			throw new Error("AgentPool has been destroyed and cannot be reused");
		}
	}

	/**
	 * Emits a typed pool event with automatic timestamp injection.
	 */
	private emitPoolEvent<K extends PoolEvent>(
		event: K,
		payload: Omit<PoolEventMap[K], keyof BasePoolEvent>,
	): void {
		const fullPayload = {
			event,
			timestamp: isoNow(),
			...payload,
		} as PoolEventMap[K];

		this.emit(event, fullPayload);
	}
}
