import { EventEmitter } from "node:events";
import { mkdir } from "node:fs/promises";
import type { PermissionOption, StopReason } from "@agentclientprotocol/sdk";

import type pino from "pino";
import { AgentEvent } from "../../enums/agent-event.enum.ts";
import { AgentStatus } from "../../enums/agent-status.enum.ts";
import { ConversationRole } from "../../enums/conversation-role.enum.ts";
import { DeltaType } from "../../enums/delta-type.enum.ts";
import { ExecutionStrategy } from "../../enums/execution-strategy.enum.ts";
import { PoolEvent } from "../../enums/pool-event.enum.ts";
import type { TaskComplexity } from "../../enums/task-complexity.enum.ts";

import { UserIntent } from "../../enums/user-intent.enum.ts";
import { createLogger } from "../../logger/create-logger.ts";
import {
	contextAnalysisSystemPrompt,
	intentAnalysisPrompt,
	intentAnalysisSystemPrompt,
	sharingAnalysisSystemPrompt,
	summaryPrompt,
	summarySystemPrompt,
} from "../../prompts/index.ts";
import type {
	AgentConfig,
	LogOutputConfig,
	PromptResult,
} from "../../types/agent.types.ts";
import type {
	AgentContextState,
	AgentExecutionResult,
	AgentFactory,
	AgentPoolConfig,
	AgentPoolResult,
	AgentPoolState,
	BasePoolEvent,
	ContextDelta,
	ContextEvent,
	CoordinationStats,
	DetectedIntent,
	IntentAnalysis,
	NotificationPreference,
	PoolEventMap,
	PoolManagedAgent,
	ProjectContext,
	ReplanDecision,
	ReplanRequest,
	SharingDecision,
	SignificanceContext,
	StructuredContextInjection,
	SubTask,
	SubtaskRetryConfig,
	TaskAnalysis,
	TaskDependency,
} from "../../types/agent-pool.types.ts";
import {
	ContextInjectionCategory,
	ContextInjectionPriority,
	ReplanTrigger,
} from "../../types/agent-pool.types.ts";
import {
	ReplanRestartError,
	SubtaskTimeoutError,
	toErrorMessage,
} from "../../utils/errors.ts";
import { isoNow } from "../../utils/formatting.ts";
import { generateIdentity } from "../../utils/identity.ts";
import { Agent } from "../agent/agent.ts";

import {
	ApprovalManager,
	type ApprovalResolution,
} from "./approval-manager.ts";
import { ContextTracker } from "./context-tracker.ts";
import { ConversationManager } from "./conversation-manager.ts";
import { InformationBroker } from "./information-broker.ts";
import { NotificationEngine } from "./notification-engine.ts";
import { ProjectScanner } from "./project-scanner.ts";
import { TaskPlanner } from "./task-planner.ts";

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_MODEL = "anthropic/claude-opus-4.6";
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
 *   model: "anthropic/claude-opus-4.6",
 *   logOutput: { console: true, seq: true },
 *   logLevel: "info",
 *   cwd: "/my/project",
 *   agentConfig: { autoApprove: true },
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

	/** Pool identity for logging. */
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

	/** Pending approval request manager (active when autoApprove is false). */
	private readonly approvalManager: ApprovalManager;

	// ── Runtime State ──────────────────────────────────────────────────

	/** Whether the pool is currently executing a task. */
	private _executing = false;

	/** The current task description, if any. */
	private _currentTask: string | null = null;

	/** The current execution strategy, if planning is complete. */
	private _currentStrategy: ExecutionStrategy | null = null;

	/** The current task analysis, if planning is complete. */
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

	/** Sharing events collected for the execution summary. */
	private _sharingSummaries: Array<{
		readonly sourceAgentName: string;
		readonly targetAgentName: string;
		readonly informationPreview: string;
	}> = [];

	/** Whether the pool has been destroyed. */
	private _destroyed = false;

	/**
	 * Recent conversation history between the user and the pool.
	 * Used by the intent analyzer to resolve references and maintain
	 * conversational context across consecutive send() calls.
	 *
	 * Each entry is a { role: "user"|"pool", content: string } pair.
	 * Limited to the last N exchanges to keep the prompt bounded.
	 */
	private readonly conversationHistory: Array<{
		role: "user" | "pool";
		content: string;
		timestamp: string;
	}> = [];

	/**
	 * Maximum number of conversation turns (user + pool messages combined)
	 * to include in the intent analysis prompt.
	 */
	private static readonly MAX_CONVERSATION_HISTORY = 6;

	/**
	 * Minimum confidence threshold for an intent to be processed.
	 * Intents below this threshold are filtered out.
	 */
	private static readonly MIN_INTENT_CONFIDENCE = 0.4;

	/** Running count of subtask retries performed during current execution. */
	private _retryCount = 0;

	/** Running count of subtask timeouts triggered during current execution. */
	private _timeoutCount = 0;

	/** Number of replanning attempts in the current execution. */
	private _replanCount = 0;

	/** Maximum replanning attempts (from config). */
	private readonly _maxReplanAttempts: number;

	/** Whether replanning is enabled (from config). */
	private readonly _enableReplanning: boolean;

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

		// Replanning configuration
		this._maxReplanAttempts = config.maxReplanAttempts ?? 2;
		this._enableReplanning = config.enableReplanning !== false; // default true

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

		// Logger — uses pool-level logOutput/logLevel (not agentConfig).
		this.logger = createLogger(this.identity, {
			logOutput: poolLogOutput,
			logLevel: poolLogLevel,
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
		const modelOverrides = this.config.modelOverrides ?? {};
		this.conversations.register(
			ConversationRole.CONTEXT_ANALYZER,
			contextAnalysisSystemPrompt({}),
			modelOverrides[ConversationRole.CONTEXT_ANALYZER],
		);
		this.conversations.register(
			ConversationRole.SHARING_ANALYZER,
			sharingAnalysisSystemPrompt({}),
			modelOverrides[ConversationRole.SHARING_ANALYZER],
		);
		this.conversations.register(
			ConversationRole.USER_INTERACTION,
			summarySystemPrompt({}),
			modelOverrides[ConversationRole.USER_INTERACTION],
		);
		this.conversations.register(
			ConversationRole.INTENT_ANALYZER,
			intentAnalysisSystemPrompt({}),
			modelOverrides[ConversationRole.INTENT_ANALYZER],
		);

		// Sub-systems
		this.planner = new TaskPlanner(
			this.conversations,
			this.logger,
			modelOverrides[ConversationRole.PLANNER],
		);
		this.contextTracker = new ContextTracker();
		this.notificationEngine = new NotificationEngine(
			this.conversations,
			this.logger,
		);
		this.approvalManager = new ApprovalManager();

		this.logger.info(
			{
				model: this.config.model,
				maxAgents: this.config.maxAgents,
			},
			`Pool initialized — model: ${this.config.model}, max agents: ${this.config.maxAgents}`,
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

		// ── Model validation (cached — only hits OpenRouter API once) ────
		await this.conversations.client.validateModel();

		if (this._executing) {
			throw new Error(
				"AgentPool is already executing a task. Wait for the current execution to complete or cancel it.",
			);
		}

		const MAX_RESTARTS = 1; // Only allow one full restart
		let restartCount = 0;

		while (restartCount <= MAX_RESTARTS) {
			try {
				return await this._executeInternal(task);
			} catch (error) {
				if (
					error instanceof ReplanRestartError &&
					restartCount < MAX_RESTARTS
				) {
					this.logger.info(
						{
							restartCount,
							reasoning: error.decision.reasoning,
						},
						"Restarting execution due to replan decision",
					);
					restartCount++;
					// Reset state and retry
					await this.destroyManagedAgents();
					this.subtaskToAgent.clear();
					this.agentToSubtask.clear();
					this._deltaCount = 0;
					this._sharingDecisionCount = 0;
					this._replanCount = 0; // Reset replan count for the fresh start
					continue;
				}
				throw error;
			}
		}

		throw new Error("Execution restart loop exceeded maximum attempts");
	}

	/**
	 * Internal execution logic, extracted from execute() to support restart.
	 *
	 * Contains the full 5-phase execution pipeline:
	 * 1. Planning
	 * 2. Agent spawning
	 * 3. Subtask execution (with replanning support)
	 * 4. Summary generation
	 * 5. Cleanup
	 */
	private async _executeInternal(task: string): Promise<AgentPoolResult> {
		const startTime = Date.now();
		this._executing = true;
		this._currentTask = task;

		this.emitPoolEvent(PoolEvent.TASK_RECEIVED, { task });

		try {
			// ── Phase 1: Planning ────────────────────────────────────────
			this.emitPoolEvent(PoolEvent.PLANNING_START, { task });
			this.logger.info({ taskLength: task.length }, "Phase 1: Planning");

			// Scan the project context if a working directory is configured
			let projectContext: ProjectContext | undefined;
			if (this.config.cwd) {
				try {
					const scanner = new ProjectScanner();
					projectContext = await scanner.scan(this.config.cwd);
					this.logger.info(
						{
							languages: projectContext.languages,
							frameworks: projectContext.detectedFrameworks,
							fileCount: projectContext.fileTree.length,
							isEmpty: projectContext.isEmpty,
						},
						`Project scanned: ${projectContext.languages.join(", ")} — ${projectContext.fileTree.length} files`,
					);
				} catch (error) {
					this.logger.warn(
						{ error: toErrorMessage(error) },
						"Project scanning failed — planning without project context",
					);
				}
			}

			const analysis = await this.planner.analyze(
				task,
				undefined, // contextHints
				undefined, // constraints
				projectContext, // project context from scanner
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

			this.logger.info(
				{ subtaskCount: analysis.subtasks.length },
				`Spawning ${analysis.subtasks.length} agent(s)`,
			);
			const agents = await this.spawnAgents(analysis);
			this.logger.info(
				{ agentCount: agents.size },
				`All ${agents.size} agent(s) spawned`,
			);

			// ── Phase 3: Execute Subtasks ────────────────────────────────
			this.logger.info("Phase 3: Executing subtasks");

			// Create the information broker for this execution
			this.informationBroker = new InformationBroker(
				this.conversations,
				this.contextTracker,
				analysis.dependencies,
				this.logger,
				this.subtaskToAgent,
				this.agentToSubtask,
			);

			this.logger.info(
				{ subtaskCount: analysis.subtasks.length },
				`Executing ${analysis.subtasks.length} subtask(s)`,
			);
			const executionResults = await this.executeSubtasks(analysis, agents);
			this.logger.info(
				{
					resultCount: executionResults.length,
					successCount: executionResults.filter((r) => r.success).length,
					failureCount: executionResults.filter((r) => !r.success).length,
				},
				`All subtasks finished`,
			);

			// ── Phase 4 & 5: Summary + Cleanup (parallel) ────────────────
			this.logger.info("Phase 4+5: Summary & Cleanup (parallel)");

			// Build coordination stats for the summary (multi-agent only)
			const coordinationStats: CoordinationStats | undefined =
				analysis.strategy === ExecutionStrategy.MULTI && this.informationBroker
					? {
							deltaCount: this._deltaCount,
							sharingEvaluationCount: this.informationBroker.evaluationCount,
							sharingApprovedCount: this.informationBroker.shareCount,
							notificationCount: this.notificationEngine.notificationCount,
							sharingSummaries: this.buildSharingSummaries(),
							retryCount: this._retryCount,
							timeoutCount: this._timeoutCount,
						}
					: undefined;

			// Calculate duration BEFORE the summary so the prompt gets the real value
			const durationMs = Date.now() - startTime;

			const [summary] = await Promise.all([
				this.generateSummary(
					task,
					analysis,
					executionResults,
					durationMs,
					coordinationStats,
				),
				this.destroyManagedAgents(),
			]);

			// Record execution in planner memory for future planning context.
			// Wrapped in try/catch so a bug in memory recording never crashes
			// the execution pipeline.
			try {
				this.planner.recordExecution(task, analysis, executionResults);
			} catch (error) {
				this.logger.warn(
					{ error: toErrorMessage(error) },
					"Failed to record planner memory — continuing without",
				);
			}

			// Log decision journal analytics before cleanup
			if (this.informationBroker) {
				const sharingJournal = this.informationBroker.journal;
				this.logger.info(
					{
						sharingDecisions: sharingJournal.entryCount,
						sharingApprovalRate: sharingJournal.approvalRate,
					},
					`Sharing journal: ${sharingJournal.entryCount} decisions, ${(sharingJournal.approvalRate * 100).toFixed(0)}% approval rate`,
				);
			}

			{
				const notifJournal = this.notificationEngine.journal;
				this.logger.info(
					{
						notificationDecisions: notifJournal.entryCount,
						notificationApprovalRate: notifJournal.approvalRate,
					},
					`Notification journal: ${notifJournal.entryCount} decisions, ${(notifJournal.approvalRate * 100).toFixed(0)}% approval rate`,
				);
			}

			const poolResult: AgentPoolResult = {
				task,
				strategy: analysis.strategy,
				analysis,
				agents: executionResults,
				summary,
				durationMs,
			};

			this.emitPoolEvent(PoolEvent.EXECUTION_COMPLETE, {
				result: poolResult,
			});

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

			return poolResult;
		} catch (error) {
			// Let ReplanRestartError propagate to execute() for restart handling
			if (error instanceof ReplanRestartError) {
				throw error;
			}

			const errorMessage = toErrorMessage(error);

			this.emitPoolEvent(PoolEvent.ERROR, {
				error: errorMessage,
				context: "execute",
			});

			this.logger.error({ error: errorMessage }, "Execution failed");

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
			this._sharingSummaries = [];
			this._retryCount = 0;
			this._timeoutCount = 0;
			this._replanCount = 0;

			// Clear notification journal between executions
			// (broker journal is cleaned naturally since broker is recreated)
			this.notificationEngine.journal.clear();
		}
	}

	// ── Public API: Send Message ───────────────────────────────────────

	/**
	 * Sends a message to the agent pool for processing.
	 *
	 * The message is analyzed by the intent analyzer to determine the
	 * user's intent(s), then routed to the appropriate handler(s).
	 *
	 * Supports multi-intent messages: if the user expresses multiple
	 * desires in a single message (e.g., "Start tests and notify me"),
	 * all detected intents are processed in order.
	 *
	 * - **new_task**: Starts a new execution via `execute()`.
	 * - **notification_preference**: Updates notification settings.
	 * - **status_query**: Returns current pool state as a string.
	 * - **context_injection**: Injects context into active agents.
	 * - **cancel**: Cancels the current execution.
	 * - **approve_agent**: Approves or denies a pending agent action.
	 * - **replan**: Requests replanning of the current execution.
	 * - **unknown**: Returns a help message.
	 *
	 * @param message - The user's message.
	 * @returns A response string, or an `AgentPoolResult` for new tasks.
	 */
	async send(message: string): Promise<string | AgentPoolResult> {
		this.assertNotDestroyed();

		// ── Model validation (cached — only hits OpenRouter API once) ────
		await this.conversations.client.validateModel();

		// Record user message in conversation history
		this.recordConversation("user", message);

		this.logger.info(
			{ messageLength: message.length },
			"Processing user message",
		);

		// Analyze intent
		const analysis = await this.analyzeIntent(message);

		this.logger.info(
			{
				primaryIntent: analysis.primaryIntent,
				intentCount: analysis.intents.length,
				intents: analysis.intents.map((i) => ({
					intent: i.intent,
					confidence: i.confidence,
				})),
			},
			`Intent classified: ${analysis.intents.map((i) => i.intent).join(" + ")} ` +
				`(primary: ${analysis.primaryIntent})`,
		);

		// Filter out low-confidence intents
		const confidentIntents = analysis.intents.filter(
			(i) => i.confidence >= AgentPool.MIN_INTENT_CONFIDENCE,
		);

		// If no confident intents remain, treat as unknown
		if (confidentIntents.length === 0) {
			const response =
				"I'm not sure I understood your request. Could you rephrase? You can:\n" +
				"- Send a task to execute\n" +
				"- Ask about current status\n" +
				"- Request notifications\n" +
				"- Inject context into running agents\n" +
				"- Cancel the current execution";

			this.recordConversation("pool", response);
			return response;
		}

		// Resolve conflicts between intents
		const resolvedIntents = this.resolveIntentConflicts(confidentIntents);

		// Process intents in order — the primary intent determines the return type.
		// Secondary intents are processed for their side effects (notifications, context, etc.)
		// but do NOT change the return value.
		let primaryResponse: string | AgentPoolResult | null = null;
		const sideEffectResponses: string[] = [];

		for (const detected of resolvedIntents) {
			const result = await this.handleSingleIntent(detected, message);

			if (primaryResponse === null) {
				// First intent processed = primary → its result is the return value
				primaryResponse = result;
			} else if (typeof result === "string") {
				// Secondary intents' string responses are collected
				sideEffectResponses.push(result);
			} else {
				// Secondary intent returned an AgentPoolResult — log warning, ignore
				this.logger.warn(
					{ intent: detected.intent },
					"Secondary intent returned AgentPoolResult — ignoring (only primary intent's result is returned)",
				);
			}
		}

		// Build final response
		let finalResponse: string | AgentPoolResult;

		if (primaryResponse === null) {
			// No intents processed (shouldn't happen due to validation, but guard)
			finalResponse = "I couldn't understand your request.";
		} else if (
			typeof primaryResponse === "string" &&
			sideEffectResponses.length > 0
		) {
			// Combine primary string response with side effect responses
			finalResponse = [primaryResponse, ...sideEffectResponses].join("\n\n");
		} else {
			finalResponse = primaryResponse;
		}

		// Record pool response in conversation history
		if (typeof finalResponse === "string") {
			this.recordConversation("pool", finalResponse);
		} else {
			this.recordConversation(
				"pool",
				`Task executed: ${finalResponse.summary.slice(0, 200)}`,
			);
		}

		return finalResponse;
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
			retryCount: this._retryCount,
			timeoutCount: this._timeoutCount,
			pendingApprovals: this.approvalManager.getPendingSummary(),
			plannerMemoryCount: this.planner.memoryCount,
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
	 * Clears the conversation history.
	 */
	async destroy(): Promise<void> {
		if (this._destroyed) return;

		// Deny all pending approvals so blocked agents can unblock
		this.approvalManager.clear();

		this._destroyed = true;

		this.logger.info("Destroying AgentPool");

		// Clear planner memory — memories do not survive pool destruction
		this.planner.clearMemory();

		await this.destroyManagedAgents();

		// Clear conversation history
		this.conversationHistory.length = 0;

		this.emitPoolEvent(PoolEvent.DESTROYED, {});

		this.logger.info("AgentPool destroyed");
	}

	/**
	 * Clears the planner's execution memory.
	 *
	 * Useful when switching to a completely different project context
	 * or when the accumulated memory is no longer relevant.
	 * Called automatically during pool.destroy().
	 */
	clearPlannerMemory(): void {
		this.planner.clearMemory();
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

		// Ensure the working directory exists before spawning any agent
		if (this.config.cwd) {
			await mkdir(this.config.cwd, { recursive: true });
		}

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
			} catch (error) {
				const errorMessage = toErrorMessage(error);

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

					// Fire-and-forget: don't block the agent event handler
					void this.handleDelta(delta);
				}
			});
		}

		// ── Approval Request Forwarding ──────────────────────────────────
		// When autoApprove is false, agents emit APPROVE_REQUEST when they
		// need permission for a tool call. We capture these, store them in
		// the ApprovalManager, and forward them as pool-level events.
		// The agent blocks until resolve() is called — other agents are
		// completely unaffected.
		agent.on(AgentEvent.APPROVE_REQUEST, (...args: unknown[]) => {
			const payload = (args[0] ?? {}) as Record<string, unknown>;

			const toolCallId = payload.toolCallId as string;
			const toolCallTitle = (payload.toolCallTitle as string) ?? "unknown tool";
			const options = (payload.options as PermissionOption[]) ?? [];
			const originalResolve = payload.resolve as (approved: boolean) => void;

			if (!toolCallId || !originalResolve) {
				this.logger.warn(
					{ agentId: agent.id },
					"Received malformed APPROVE_REQUEST event — missing toolCallId or resolve",
				);
				return;
			}

			this.logger.info(
				{
					agentId: agent.id,
					agentName: agent.name,
					toolCallId,
					toolCallTitle,
				},
				`Agent ${agent.name} requests approval for: ${toolCallTitle}`,
			);

			// Register in the approval manager
			this.approvalManager.addRequest({
				agentId: agent.id,
				agentName: agent.name,
				toolCallId,
				toolCallTitle,
				options,
				timestamp: isoNow(),
				resolve: originalResolve,
			});

			// Emit pool-level event so external consumers can handle it
			// directly (e.g., a UI can show a confirmation dialog).
			// The resolve callback in the pool event is the same one-shot
			// wrapper from ApprovalManager, so calling it from either the
			// pool event or via send() both work — whichever fires first wins.
			const pendingEntry = this.approvalManager.getByToolCallId(toolCallId);
			if (pendingEntry) {
				this.emitPoolEvent(PoolEvent.APPROVE_REQUEST, {
					agentId: agent.id,
					agentName: agent.name,
					toolCallId,
					toolCallTitle,
					resolve: pendingEntry.resolve,
				});
			}
		});
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

		// Build blocking dependency adjacency — rebuilt after replan modify
		const rebuildBlockingDeps = (): Map<string, Set<string>> => {
			const blockingDeps = new Map<string, Set<string>>();
			for (const subtask of analysis.subtasks) {
				if (completed.has(subtask.id)) continue; // Skip completed subtasks
				const blockers = new Set<string>();
				for (const depId of subtask.dependencies) {
					const dep = analysis.dependencies.find(
						(d) => d.from === depId && d.to === subtask.id,
					);
					if (!dep || dep.type === "blocking") {
						blockers.add(depId);
					}
				}
				blockingDeps.set(subtask.id, blockers);
			}
			return blockingDeps;
		};

		let blockingDeps = rebuildBlockingDeps();

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

				// ── Replan on deadlock ────────────────────────────────────
				const deadlockDecision = await this.evaluateReplan(
					ReplanTrigger.DEADLOCK,
					analysis,
					agents,
					completed,
					failed,
					remaining,
					`Deadlock detected: subtasks ${[...remaining].join(", ")} have unsatisfiable dependencies. ` +
						`Completed: ${[...completed].join(", ")}. Failed: ${[...failed].join(", ")}.`,
				);

				if (deadlockDecision && deadlockDecision.action === "modify") {
					const result = await this.applyReplanDecision(
						deadlockDecision,
						analysis,
						agents,
						completed,
						failed,
						remaining,
					);
					if (result.continueExecution) {
						// Rebuild blocking deps with the new subtasks
						blockingDeps = rebuildBlockingDeps();
						continue; // Try again with the modified plan
					}
				}

				// If replan didn't happen or said continue/abort, use existing deadlock handling
				for (const id of remaining) {
					const entry = agents.get(id);
					if (entry) {
						this.contextTracker.markFailed(
							entry.agent.id,
							"Deadlocked: blocking dependencies could not be satisfied",
						);
						results.push(
							this.buildFailedResult(
								entry.agent,
								entry.subtask,
								"Deadlocked: blocking dependencies could not be satisfied",
								0,
								false,
								0,
								this.contextTracker.getAgentState(entry.agent.id)?.events,
								this.contextTracker.getAgentState(entry.agent.id)?.filesWritten,
							),
						);
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

					results.push(
						this.buildFailedResult(
							agent,
							subtask,
							agentState.error,
							0,
							false,
							0,
							agentState.events,
							agentState.filesWritten,
						),
					);
					return;
				}

				this.logger.info(
					{
						agentId: agent.id,
						subtaskId,
						role: subtask.role,
					},
					`Executing subtask: ${subtask.role}`,
				);

				// Use executeSubtaskWithRetry instead of direct prompt
				const executionResult = await this.executeSubtaskWithRetry(
					subtask,
					agent,
					analysis,
					agents,
				);

				results.push(executionResult);

				if (executionResult.success) {
					completed.add(subtaskId);
				} else {
					failed.add(subtaskId);
					inProgress.delete(subtaskId);

					// ── Replan on subtask failure (post-retry exhaustion) ──
					const failedCount = failed.size;
					const trigger =
						failedCount >= 2
							? ReplanTrigger.CASCADING_FAILURES
							: ReplanTrigger.SUBTASK_FAILURE;

					const replanDecision = await this.evaluateReplan(
						trigger,
						analysis,
						agents,
						completed,
						failed,
						remaining,
						`Subtask "${subtaskId}" (${subtask.role}) failed after ${executionResult.retryCount} retries: ${executionResult.error ?? "unknown"}`,
					);

					if (replanDecision && replanDecision.action !== "continue") {
						const replanResult = await this.applyReplanDecision(
							replanDecision,
							analysis,
							agents,
							completed,
							failed,
							remaining,
						);

						if (replanResult.restart) {
							// Break out of executeSubtasks and restart execute()
							throw new ReplanRestartError(replanDecision);
						}
						// For "modify": rebuild blocking deps, continue the while loop
						if (replanResult.continueExecution) {
							blockingDeps = rebuildBlockingDeps();
						}
					}

					// Store in managed agents map and emit event (already done for success below)
					const managedEntry = this.managedAgents.get(executionResult.agentId);
					if (managedEntry) {
						managedEntry.result = executionResult;
					}
					this.emitPoolEvent(PoolEvent.AGENT_ERROR, {
						agentId: executionResult.agentId,
						agentName: executionResult.agentName,
						error: executionResult.error ?? "unknown",
					});
					return;
				}
				inProgress.delete(subtaskId);

				// Store in managed agents map
				const managedEntry = this.managedAgents.get(executionResult.agentId);
				if (managedEntry) {
					managedEntry.result = executionResult;
				}

				this.emitPoolEvent(PoolEvent.AGENT_COMPLETED, {
					agentId: executionResult.agentId,
					agentName: executionResult.agentName,
					result: executionResult,
				});
			});

			await Promise.allSettled(executionPromises);
		}

		return results;
	}

	// ── Private: Timeout Wrapper ───────────────────────────────────────

	/**
	 * Executes a subtask prompt with an optional timeout.
	 *
	 * If the timeout is reached, the agent is destroyed (to stop any
	 * in-flight tool calls) and a SubtaskTimeoutError is thrown. The caller
	 * is responsible for handling the error (retry or mark as failed).
	 *
	 * @param agent - The agent to prompt.
	 * @param prompt - The prompt text.
	 * @param timeoutMs - The timeout in milliseconds. 0 or Infinity disables.
	 * @param subtaskId - The subtask ID (for logging/events).
	 * @returns The prompt result.
	 * @throws SubtaskTimeoutError if the timeout is exceeded.
	 * @throws Any error from the underlying agent.prompt() call.
	 */
	private async executeWithTimeout(
		agent: PoolManagedAgent,
		prompt: string,
		timeoutMs: number,
		subtaskId: string,
	): Promise<PromptResult> {
		// No timeout — just call prompt directly
		if (!timeoutMs || timeoutMs === Infinity || timeoutMs <= 0) {
			return agent.prompt(prompt);
		}

		const startTime = Date.now();

		// Create a timeout promise that rejects after the specified duration
		let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timeoutHandle = setTimeout(() => {
				const elapsed = Date.now() - startTime;

				this.logger.warn(
					{
						agentId: agent.id,
						agentName: agent.name,
						subtaskId,
						timeoutMs,
						elapsedMs: elapsed,
					},
					`Subtask timed out after ${elapsed}ms (limit: ${timeoutMs}ms)`,
				);

				this._timeoutCount++;

				this.contextTracker.markTimedOut(agent.id, timeoutMs, elapsed);

				this.emitPoolEvent(PoolEvent.AGENT_TIMEOUT, {
					agentId: agent.id,
					agentName: agent.name,
					subtaskId,
					timeoutMs,
					elapsedMs: elapsed,
				});

				// Destroy the agent to stop in-flight operations
				agent.destroy().catch((err) => {
					this.logger.warn(
						{ agentId: agent.id, error: toErrorMessage(err) },
						"Failed to destroy timed-out agent",
					);
				});

				reject(
					new SubtaskTimeoutError(agent.name, subtaskId, timeoutMs, elapsed),
				);
			}, timeoutMs);
		});

		try {
			// Race the prompt against the timeout
			const result = await Promise.race([agent.prompt(prompt), timeoutPromise]);

			return result;
		} finally {
			// Always clear the timeout to prevent leaks
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
			}
		}
	}

	// ── Private: Retry Logic ───────────────────────────────────────────

	/**
	 * Executes a single subtask with retry support.
	 *
	 * On failure, if retries are configured and the error is eligible:
	 * 1. The failed agent is destroyed
	 * 2. A new agent is spawned for the same subtask
	 * 3. The prompt is augmented with error context from the previous attempt
	 * 4. The subtask is re-executed
	 *
	 * @param subtask - The subtask to execute.
	 * @param agent - The initial agent (may be replaced on retry).
	 * @param analysis - The full task analysis (for dependency context).
	 * @param agents - The agents map (updated on retry with the new agent).
	 * @returns The execution result.
	 */
	private async executeSubtaskWithRetry(
		subtask: SubTask,
		agent: PoolManagedAgent,
		analysis: TaskAnalysis,
		agents: Map<string, { agent: PoolManagedAgent; subtask: SubTask }>,
	): Promise<AgentExecutionResult> {
		const retryConfig = this.resolveRetryConfig();
		const timeoutMs = this.resolveTimeoutMs(analysis.complexity);

		let currentAgent = agent;
		let lastError: string | null = null;
		let retryCount = 0;
		let timedOut = false;

		for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
			const isRetry = attempt > 0;
			const subtaskStartTime = Date.now();

			if (isRetry) {
				this._retryCount++;

				this.logger.info(
					{
						subtaskId: subtask.id,
						attempt: attempt + 1,
						maxAttempts: retryConfig.maxRetries + 1,
						previousError: lastError,
					},
					`Retrying subtask ${subtask.role} (attempt ${attempt + 1}/${retryConfig.maxRetries + 1})`,
				);

				this.emitPoolEvent(PoolEvent.AGENT_RETRY, {
					agentId: currentAgent.id,
					agentName: currentAgent.name,
					subtaskId: subtask.id,
					attempt,
					maxRetries: retryConfig.maxRetries,
					previousError: lastError ?? "unknown",
				});

				// Wait before retrying
				if (retryConfig.retryDelayMs > 0) {
					await new Promise((resolve) =>
						setTimeout(resolve, retryConfig.retryDelayMs),
					);
				}

				// Spawn a fresh agent for the retry
				try {
					currentAgent = await this.spawnRetryAgent(subtask);

					// Update the agents map with the new agent
					agents.set(subtask.id, { agent: currentAgent, subtask });
				} catch (spawnError) {
					const errorMsg = toErrorMessage(spawnError);
					this.logger.error(
						{ subtaskId: subtask.id, error: errorMsg },
						"Failed to spawn retry agent — giving up",
					);
					return this.buildFailedResult(
						currentAgent,
						subtask,
						errorMsg,
						retryCount,
						false,
						0,
					);
				}
			}

			// Build the prompt (with error context if retrying)
			const prompt =
				isRetry && retryConfig.includeErrorContext
					? this.buildRetryPrompt(subtask, lastError, attempt)
					: subtask.prompt;

			try {
				const promptResult = await this.executeWithTimeout(
					currentAgent,
					prompt,
					timeoutMs,
					subtask.id,
				);

				const subtaskDuration = Date.now() - subtaskStartTime;

				this.contextTracker.recordPromptResult(currentAgent.id, promptResult);
				this.contextTracker.markCompleted(currentAgent.id);

				const finalState = this.contextTracker.getAgentState(currentAgent.id);

				return {
					agentId: currentAgent.id,
					agentName: currentAgent.name,
					subtask,
					promptResult,
					events: finalState?.events ?? [],
					filesWritten: finalState?.filesWritten ?? [],
					success: true,
					retryCount,
					timedOut: false,
					subtaskDurationMs: subtaskDuration,
				};
			} catch (error) {
				const errorMessage = toErrorMessage(error);
				const isTimeoutError = error instanceof SubtaskTimeoutError;
				timedOut = isTimeoutError;
				lastError = errorMessage;
				retryCount = attempt + 1;

				this.logger.warn(
					{
						subtaskId: subtask.id,
						attempt: attempt + 1,
						isTimeout: isTimeoutError,
						error: errorMessage,
					},
					`Subtask attempt ${attempt + 1} failed: ${errorMessage}`,
				);

				// Check if we should retry
				const canRetry = attempt < retryConfig.maxRetries;
				const shouldRetryTimeout = isTimeoutError && retryConfig.retryOnTimeout;
				const shouldRetry = canRetry && (shouldRetryTimeout || !isTimeoutError);

				if (!shouldRetry) {
					// No more retries — mark as failed
					this.contextTracker.markFailed(currentAgent.id, errorMessage);

					const subtaskDuration = Date.now() - subtaskStartTime;
					const finalState = this.contextTracker.getAgentState(currentAgent.id);

					return this.buildFailedResult(
						currentAgent,
						subtask,
						errorMessage,
						retryCount,
						isTimeoutError,
						subtaskDuration,
						finalState?.events,
						finalState?.filesWritten,
					);
				}

				// Destroy the current agent before retrying
				if (currentAgent.status !== AgentStatus.DESTROYED) {
					try {
						await currentAgent.destroy();
					} catch {
						// Agent may already be destroyed (e.g., from timeout handler)
					}
				}
			}
		}

		// Should never reach here, but safety fallback
		return this.buildFailedResult(
			currentAgent,
			subtask,
			lastError ?? "unknown",
			retryCount,
			timedOut,
			0,
		);
	}

	// ── Private: Timeout/Retry Helpers ─────────────────────────────────

	/**
	 * Resolves the effective retry configuration with defaults.
	 */
	private resolveRetryConfig(): Required<SubtaskRetryConfig> {
		const userConfig = this.config.retry;

		return {
			maxRetries: userConfig?.maxRetries ?? 1,
			includeErrorContext: userConfig?.includeErrorContext ?? true,
			retryDelayMs: userConfig?.retryDelayMs ?? 2000,
			retryOnTimeout: userConfig?.retryOnTimeout ?? true,
		};
	}

	/**
	 * Resolves the effective timeout in milliseconds for a subtask,
	 * considering the task complexity and any complexity-specific overrides.
	 *
	 * @param complexity - The assessed task complexity.
	 * @returns The timeout in milliseconds, or 0 if disabled.
	 */
	private resolveTimeoutMs(complexity: TaskComplexity): number {
		const timeoutConfig = this.config.timeout;

		if (!timeoutConfig) {
			// Default timeout: 5 minutes
			return 300_000;
		}

		if (
			timeoutConfig.subtaskTimeoutMs === 0 ||
			timeoutConfig.subtaskTimeoutMs === Infinity
		) {
			return 0; // Disabled
		}

		// Check for complexity-specific override
		if (timeoutConfig.complexityTimeouts) {
			const complexityKey = complexity.toLowerCase() as
				| "simple"
				| "moderate"
				| "complex";
			const override = timeoutConfig.complexityTimeouts[complexityKey];
			if (override !== undefined) {
				return override;
			}
		}

		return timeoutConfig.subtaskTimeoutMs;
	}

	/**
	 * Builds the prompt for a retry attempt, including error context
	 * from the previous attempt.
	 *
	 * @param subtask - The original subtask.
	 * @param previousError - The error message from the previous attempt.
	 * @param attemptNumber - The retry attempt number (1-based).
	 * @returns The augmented prompt.
	 */
	private buildRetryPrompt(
		subtask: SubTask,
		previousError: string | null,
		attemptNumber: number,
	): string {
		const errorContext = previousError
			? `\n\nThe previous attempt (#${attemptNumber}) FAILED with the following error:\n${previousError}\n\nPlease avoid the same mistake. If the previous approach didn't work, try a different strategy.`
			: "";

		return `${subtask.prompt}${errorContext}`;
	}

	/**
	 * Spawns a fresh agent for a retry attempt.
	 *
	 * Creates a new agent with the same configuration as the original,
	 * registers it with the context tracker, and wires events.
	 *
	 * @param subtask - The subtask to retry.
	 * @returns The newly spawned agent.
	 */
	private async spawnRetryAgent(subtask: SubTask): Promise<PoolManagedAgent> {
		const agentConfig: AgentConfig = {
			logOutput: this.config.logOutput,
			logLevel: this.config.logLevel,
			cwd: this.config.cwd,
			...this.config.agentConfig,
			name: `${subtask.role}-retry`,
		};

		const agent = this.agentFactory(agentConfig);

		// Register with context tracker
		this.contextTracker.registerAgent(agent.id, agent.name, subtask);

		// Update subtask ↔ agent mappings (the old agent's mapping is stale)
		this.subtaskToAgent.set(subtask.id, agent.id);
		this.agentToSubtask.set(agent.id, subtask.id);

		// Wire agent events
		this.wireAgentEvents(agent, subtask);

		// Store in managed agents
		const entry = {
			agent,
			subtask,
			result: null as AgentExecutionResult | null,
		};
		this.managedAgents.set(agent.id, entry);

		this.emitPoolEvent(PoolEvent.AGENT_SPAWNED, {
			agentId: agent.id,
			agentName: agent.name,
			subtask,
		});

		// Wait for agent to be ready
		await agent.ready;

		return agent;
	}

	/**
	 * Builds an AgentExecutionResult for a failed subtask.
	 */
	private buildFailedResult(
		agent: PoolManagedAgent,
		subtask: SubTask,
		error: string,
		retryCount: number,
		timedOut: boolean,
		subtaskDurationMs: number,
		events?: ContextEvent[],
		filesWritten?: string[],
	): AgentExecutionResult {
		return {
			agentId: agent.id,
			agentName: agent.name,
			subtask,
			promptResult: {
				stopReason: "error" as StopReason,
				text: "",
				usage: null,
			},
			events: events ?? [],
			filesWritten: filesWritten ?? [],
			success: false,
			error,
			retryCount,
			timedOut,
			subtaskDurationMs,
		};
	}

	// ── Private: Replanning ────────────────────────────────────────────

	/**
	 * Evaluates whether the current execution should be replanned.
	 *
	 * Called when:
	 * - A subtask fails after exhausting all retries (SUBTASK_FAILURE)
	 * - A deadlock is detected in executeSubtasks() (DEADLOCK)
	 * - Multiple subtasks have failed (CASCADING_FAILURES)
	 *
	 * @param trigger - What caused the replan evaluation.
	 * @param analysis - The original task analysis.
	 * @param agents - The spawned agents map.
	 * @param completed - Set of completed subtask IDs.
	 * @param failed - Set of failed subtask IDs.
	 * @param remaining - Set of remaining subtask IDs.
	 * @param problemDescription - Human-readable description of the problem.
	 * @returns The replan decision, or null if replanning is disabled/exhausted.
	 */
	private async evaluateReplan(
		trigger: ReplanTrigger,
		analysis: TaskAnalysis,
		agents: Map<string, { agent: PoolManagedAgent; subtask: SubTask }>,
		completed: Set<string>,
		failed: Set<string>,
		remaining: Set<string>,
		problemDescription: string,
	): Promise<ReplanDecision | null> {
		// Guard: replanning disabled or max attempts reached
		if (!this._enableReplanning) return null;
		if (this._replanCount >= this._maxReplanAttempts) {
			this.logger.info(
				{ replanCount: this._replanCount, max: this._maxReplanAttempts },
				"Max replan attempts reached — proceeding without replanning",
			);
			return null;
		}

		// Guard: single-agent strategy doesn't benefit from replanning
		if (analysis.strategy === ExecutionStrategy.SINGLE) return null;

		this._replanCount++;

		this.emitPoolEvent(PoolEvent.REPLAN_START, {
			trigger,
			problemDescription,
		});

		// Build the replan request
		const agentStates = analysis.subtasks.map((subtask) => {
			const entry = agents.get(subtask.id);
			const ctxState = entry
				? this.contextTracker.getAgentState(entry.agent.id)
				: undefined;

			return {
				subtaskId: subtask.id,
				agentName: entry?.agent.name ?? subtask.role,
				role: subtask.role,
				completed: completed.has(subtask.id),
				failed: failed.has(subtask.id),
				error: ctxState?.error ?? null,
				accomplishedSummary: this.buildAccomplishedSummary(ctxState),
				filesWritten: ctxState?.filesWritten ?? [],
			};
		});

		const blockedSubtaskIds = [...remaining].filter((id) => !failed.has(id));

		const request: ReplanRequest = {
			trigger,
			originalTask: this._currentTask ?? "",
			originalAnalysis: analysis,
			agentStates,
			blockedSubtaskIds,
			problemDescription,
		};

		const decision = await this.planner.replan(request);

		this.emitPoolEvent(PoolEvent.REPLAN_COMPLETE, { decision });

		return decision;
	}

	/**
	 * Builds a short summary of what an agent accomplished based on its context state.
	 */
	private buildAccomplishedSummary(
		state: AgentContextState | undefined,
	): string {
		if (!state) return "No information available.";

		const parts: string[] = [];

		if (state.promptResults.length > 0) {
			const lastResult = state.promptResults[state.promptResults.length - 1];
			if (lastResult?.text) {
				parts.push(
					`Response (${lastResult.text.length} chars): ${lastResult.text.slice(0, 300)}`,
				);
			}
		}

		if (state.filesWritten.length > 0) {
			parts.push(`Files written: ${state.filesWritten.join(", ")}`);
		}

		if (state.events.length > 0) {
			parts.push(`Events: ${state.events.length} total`);
		}

		return parts.length > 0
			? parts.join(". ")
			: "Agent did not produce significant output.";
	}

	/**
	 * Applies a replan decision to the current execution.
	 *
	 * For "modify": destroys failed/blocked agents, spawns new agents
	 * for the new subtasks, and injects the completedWorkSummary.
	 *
	 * For "restart": destroys all agents and throws ReplanRestartError.
	 *
	 * For "abort": throws an error.
	 *
	 * For "continue": no action (caller continues the execution loop).
	 *
	 * @param decision - The replan decision to apply.
	 * @param analysis - The original analysis (mutated for "modify").
	 * @param agents - The agents map (mutated for "modify").
	 * @param completed - Set of completed subtask IDs (preserved).
	 * @param failed - Set of failed subtask IDs (cleared for modified tasks).
	 * @param remaining - Set of remaining subtask IDs (replaced for modified tasks).
	 * @returns Whether execution should continue (true) or restart/abort (false).
	 */
	private async applyReplanDecision(
		decision: ReplanDecision,
		analysis: TaskAnalysis,
		agents: Map<string, { agent: PoolManagedAgent; subtask: SubTask }>,
		completed: Set<string>,
		failed: Set<string>,
		remaining: Set<string>,
	): Promise<{ continueExecution: boolean; restart: boolean }> {
		switch (decision.action) {
			case "continue":
				this.logger.info("Replan decision: continue with current plan");
				return { continueExecution: true, restart: false };

			case "abort":
				this.logger.warn(
					{ reasoning: decision.reasoning },
					"Replan decision: abort execution",
				);
				throw new Error(
					`Execution aborted by replanner: ${decision.reasoning}`,
				);

			case "restart":
				this.logger.info("Replan decision: restart from scratch");
				await this.destroyManagedAgents();
				return { continueExecution: false, restart: true };

			case "modify": {
				this.logger.info(
					{
						newSubtaskCount: decision.newSubtasks.length,
						newDepCount: decision.newDependencies.length,
					},
					`Replan decision: modify plan — ${decision.newSubtasks.length} new subtask(s)`,
				);

				// 1. Destroy agents for failed and blocked subtasks
				for (const subtaskId of [...failed, ...remaining]) {
					const entry = agents.get(subtaskId);
					if (entry) {
						if (entry.agent.status !== AgentStatus.DESTROYED) {
							await entry.agent.destroy().catch(() => {});
						}
						this.managedAgents.delete(entry.agent.id);
						this.contextTracker.unregisterAgent(entry.agent.id);
						this.agentToSubtask.delete(entry.agent.id);
					}
					agents.delete(subtaskId);
					this.subtaskToAgent.delete(subtaskId);
				}

				// 2. Clear failed and remaining sets
				failed.clear();
				remaining.clear();

				// 3. Update analysis with new subtasks and dependencies
				// Note: we mutate the analysis object here — it's local to executeSubtasks
				const mergedSubtasks = [
					...analysis.subtasks.filter((s) => completed.has(s.id)),
					...decision.newSubtasks,
				];
				(analysis as { subtasks: SubTask[] }).subtasks = mergedSubtasks;
				(analysis as { dependencies: TaskDependency[] }).dependencies =
					decision.newDependencies;

				// 4. Add new subtask IDs to remaining
				for (const subtask of decision.newSubtasks) {
					remaining.add(subtask.id);
				}

				// 5. Spawn new agents for the new subtasks
				for (const subtask of decision.newSubtasks) {
					const agentConfig: AgentConfig = {
						logOutput: this.config.logOutput,
						logLevel: this.config.logLevel,
						cwd: this.config.cwd,
						...this.config.agentConfig,
						name: subtask.role,
					};

					const agent = this.agentFactory(agentConfig);

					this.contextTracker.registerAgent(agent.id, agent.name, subtask);
					this.subtaskToAgent.set(subtask.id, agent.id);
					this.agentToSubtask.set(agent.id, subtask.id);
					this.wireAgentEvents(agent, subtask);

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

					try {
						await agent.ready;
					} catch (err) {
						this.contextTracker.markFailed(agent.id, toErrorMessage(err));
					}

					// 6. Inject completed work summary into new agents
					if (decision.completedWorkSummary) {
						agent.injectContext({
							content: decision.completedWorkSummary,
							priority: ContextInjectionPriority.HIGH,
							category: ContextInjectionCategory.SHARED_CONTEXT,
							source: "replanner",
							dependencyType: null,
							timestamp: isoNow(),
						});
					}
				}

				// 7. Update the information broker with new dependencies
				this.informationBroker = new InformationBroker(
					this.conversations,
					this.contextTracker,
					decision.newDependencies,
					this.logger,
					this.subtaskToAgent,
					this.agentToSubtask,
				);

				return { continueExecution: true, restart: false };
			}

			default:
				this.logger.warn(
					{ action: decision.action },
					"Unknown replan action — continuing",
				);
				return { continueExecution: true, restart: false };
		}
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
				// Update the significance context before evaluation
				const sigContext = this.buildSignificanceContext();
				this.informationBroker.updateSignificanceContext(sigContext);

				let decisions: SharingDecision[];

				if (delta.type === DeltaType.PROMPT_COMPLETE) {
					await new Promise((resolve) => setTimeout(resolve, 50));
					const agentState = this.contextTracker.getAgentState(delta.agentId);
					const lastPromptResult = agentState?.promptResults.at(-1);

					if (lastPromptResult?.text) {
						decisions = await this.informationBroker.evaluateWithFullResult(
							delta,
							lastPromptResult.text,
						);
					} else {
						decisions = await this.informationBroker.evaluate(delta);
					}
				} else {
					decisions = await this.informationBroker.evaluate(delta);
				}

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
								// Determine the dependency type between source and target
								const sourceSubtaskId = this.agentToSubtask.get(
									decision.sourceAgentId,
								);
								const targetSubtaskId = this.agentToSubtask.get(
									decision.targetAgentId,
								);

								let depType: "blocking" | "informational" | null = null;
								if (
									sourceSubtaskId &&
									targetSubtaskId &&
									this.informationBroker
								) {
									const dep = this.informationBroker.findDependencyBySubtaskIds(
										sourceSubtaskId,
										targetSubtaskId,
									);
									depType = dep?.type ?? null;
								}

								// Determine priority based on dependency type and delta significance
								let priority: ContextInjectionPriority;
								if (depType === "blocking") {
									priority = ContextInjectionPriority.CRITICAL;
								} else if (depType === "informational") {
									priority = ContextInjectionPriority.HIGH;
								} else if (delta.significance >= 0.8) {
									priority = ContextInjectionPriority.HIGH;
								} else {
									priority = ContextInjectionPriority.NORMAL;
								}

								// Determine category
								const category = depType
									? ContextInjectionCategory.DEPENDENCY_OUTPUT
									: ContextInjectionCategory.SHARED_CONTEXT;

								// Get source agent name
								const sourceEntry = this.managedAgents.get(
									decision.sourceAgentId,
								);
								const sourceName =
									sourceEntry?.agent.name ?? decision.sourceAgentId;

								// Inject as structured context
								const injection: StructuredContextInjection = {
									content: decision.information,
									priority,
									category,
									source: sourceName,
									dependencyType: depType,
									timestamp: isoNow(),
								};

								targetEntry.agent.injectContext(injection);

								// Record the sharing for deduplication in future evaluations
								this.informationBroker?.recordSharing(decision, delta.type);

								// Track sharing event for execution summary
								this._sharingSummaries.push({
									sourceAgentName: sourceName,
									targetAgentName: targetEntry.agent.name,
									informationPreview: decision.information.slice(0, 150),
								});

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
										priority,
										category,
									},
									"Context shared between agents (structured)",
								);
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
					error: toErrorMessage(error),
				},
				"Delta handling failed (non-critical)",
			);
		}
	}

	// ── Private: Significance Context ──────────────────────────────────

	/**
	 * Builds the current SignificanceContext from the execution state.
	 * Called before each sharing evaluation to provide up-to-date
	 * contextual information for dynamic threshold computation.
	 */
	private buildSignificanceContext(): SignificanceContext {
		const allStates = this.contextTracker.getAllAgentStates();
		const totalSubtasks = allStates.length;
		const completedSubtasks = allStates.filter(
			(s) => s.completed && !s.error,
		).length;
		const failedSubtasks = allStates.filter(
			(s) => s.completed && !!s.error,
		).length;

		// Compute phase from completion ratio
		const completionRatio =
			totalSubtasks > 0
				? (completedSubtasks + failedSubtasks) / totalSubtasks
				: 0;
		let phase: "early" | "mid" | "late";
		if (completionRatio < 0.3) {
			phase = "early";
		} else if (completionRatio < 0.7) {
			phase = "mid";
		} else {
			phase = "late";
		}

		return {
			totalSubtasks,
			completedSubtasks,
			failedSubtasks,
			phase,
			totalDeltasProcessed: this._deltaCount,
		};
	}

	// ── Private: Summary ───────────────────────────────────────────────

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
		durationMs: number,
		coordinationStats?: CoordinationStats,
	): Promise<string> {
		const successCount = results.filter((r) => r.success).length;
		const failCount = results.length - successCount;

		// For single-agent tasks, skip the LLM summary call entirely.
		// This saves a full LLM round-trip (~3-8s) for the most common case.
		if (
			analysis.strategy === ExecutionStrategy.SINGLE &&
			results.length === 1
		) {
			const agent = results[0];
			if (!agent) {
				return `Task "${task.slice(0, 100)}" completed with single strategy.`;
			}
			const status = agent.success
				? "completed successfully"
				: `failed: ${agent.error ?? "unknown error"}`;
			const filesInfo =
				agent.filesWritten.length > 0
					? ` Files written: ${agent.filesWritten.join(", ")}.`
					: "";
			return `Task "${task.slice(0, 100)}" ${status} (single-agent strategy, role: ${agent.subtask.role}).${filesInfo}`;
		}

		// For multi-agent tasks, use LLM summary
		try {
			const prompt = summaryPrompt({
				task,
				strategy: analysis.strategy,
				complexity: analysis.complexity,
				planningReasoning: analysis.reasoning,
				agents: results,
				durationMs,
				coordination: coordinationStats ?? null,
			});

			const summary = await this.conversations.sendOneShot(
				ConversationRole.USER_INTERACTION,
				prompt,
			);

			return summary;
		} catch (error) {
			this.logger.warn(
				{
					error: toErrorMessage(error),
				},
				"Summary generation failed, using fallback",
			);

			return (
				`Task "${task.slice(0, 100)}" completed with ${analysis.strategy} strategy. ` +
				`${successCount} subtask(s) succeeded, ${failCount} failed.`
			);
		}
	}

	// ── Private: Coordination Summary ──────────────────────────────────

	/**
	 * Builds a summary of sharing events for inclusion in the execution summary.
	 * Returns the most recent sharing events, limited to avoid prompt bloat.
	 */
	private buildSharingSummaries(): CoordinationStats["sharingSummaries"] {
		const MAX_SHARING_SUMMARIES = 10;
		return this._sharingSummaries.slice(-MAX_SHARING_SUMMARIES);
	}

	// ── Private: Intent Analysis ───────────────────────────────────────

	/**
	 * Analyzes a user message to determine their intent(s).
	 *
	 * Uses the intent-analyzer LLM conversation to classify the
	 * message into one or more intent categories. Includes recent
	 * conversation history for contextual reference resolution.
	 */
	private async analyzeIntent(message: string): Promise<IntentAnalysis> {
		try {
			// Sanitize the message
			const sanitized = this.conversations.client.sanitize(message);

			const poolState = this.getState();

			const prompt = intentAnalysisPrompt({
				message: sanitized,
				poolState,
				conversationHistory: this.conversationHistory.slice(
					-AgentPool.MAX_CONVERSATION_HISTORY,
				),
			});

			const analysis = await this.conversations.sendOneShotJson(
				ConversationRole.INTENT_ANALYZER,
				prompt,
				validateIntentAnalysis,
				{ maxTokens: 500 },
			);

			return analysis;
		} catch (error) {
			this.logger.warn(
				{
					error: toErrorMessage(error),
				},
				"Intent analysis failed, defaulting to new_task",
			);

			// Fallback: treat the message as a new task
			return {
				intents: [
					{
						intent: UserIntent.NEW_TASK,
						confidence: 0.5,
						parameters: { task: message },
					},
				],
				primaryIntent: UserIntent.NEW_TASK,
				reasoning: "Intent analysis failed — defaulting to new_task",
			};
		}
	}

	// ── Private: Conversation History ──────────────────────────────────

	/**
	 * Records a message in the conversation history.
	 * Enforces MAX_CONVERSATION_HISTORY limit.
	 */
	private recordConversation(role: "user" | "pool", content: string): void {
		this.conversationHistory.push({
			role,
			content: content.slice(0, 500), // Truncate long responses
			timestamp: isoNow(),
		});

		// Enforce limit
		while (
			this.conversationHistory.length > AgentPool.MAX_CONVERSATION_HISTORY
		) {
			this.conversationHistory.shift();
		}
	}

	// ── Private: Intent Conflict Resolution ────────────────────────────

	/**
	 * Resolves conflicts between detected intents.
	 *
	 * Rules:
	 * 1. If `cancel` is present with `new_task`, keep only `cancel`.
	 * 2. If `cancel` is present with `context_injection`, keep only `cancel`.
	 * 3. If multiple `new_task` are present, keep only the first.
	 * 4. `approve_agent` is always processed first if present.
	 *
	 * @param intents - The detected intents to resolve.
	 * @returns The resolved intents, potentially reordered or filtered.
	 */
	private resolveIntentConflicts(intents: DetectedIntent[]): DetectedIntent[] {
		const hasCancel = intents.some((i) => i.intent === UserIntent.CANCEL);

		if (hasCancel) {
			// Cancel overrides new_task and context_injection
			return intents.filter(
				(i) =>
					i.intent === UserIntent.CANCEL ||
					i.intent === UserIntent.STATUS_QUERY ||
					i.intent === UserIntent.NOTIFICATION_PREFERENCE,
			);
		}

		// Move approve_agent to the front (must be processed first to unblock agents)
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

	// ── Private: Single Intent Handler ─────────────────────────────────

	/**
	 * Handles a single detected intent and returns a response.
	 *
	 * This method contains the dispatch logic for each intent type,
	 * factored out from the old switch/case in send() to be called
	 * per-intent in the multi-intent loop.
	 *
	 * @param detected - The detected intent with parameters.
	 * @param originalMessage - The original user message (used as fallback for task text).
	 * @returns The response string or AgentPoolResult.
	 */
	private async handleSingleIntent(
		detected: DetectedIntent,
		originalMessage: string,
	): Promise<string | AgentPoolResult> {
		switch (detected.intent) {
			case UserIntent.APPROVE_AGENT: {
				return this.handleApprovalIntent(detected);
			}

			case UserIntent.NEW_TASK: {
				const taskText =
					typeof detected.parameters.task === "string"
						? detected.parameters.task
						: originalMessage;
				return this.execute(taskText);
			}

			case UserIntent.NOTIFICATION_PREFERENCE: {
				const enabled = detected.parameters.enabled !== false;
				const minSignificance =
					typeof detected.parameters.minSignificance === "number"
						? detected.parameters.minSignificance
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
					typeof detected.parameters.instructions === "string"
						? detected.parameters.instructions
						: originalMessage;

				if (this.managedAgents.size === 0) {
					return "No active agents to inject context into.";
				}

				// Inject into all active agents as structured context
				let injectedCount = 0;
				for (const { agent } of this.managedAgents.values()) {
					if (agent.status !== AgentStatus.DESTROYED) {
						try {
							const injection: StructuredContextInjection = {
								content: instructions,
								priority: ContextInjectionPriority.HIGH,
								category: ContextInjectionCategory.USER_INSTRUCTION,
								source: "user",
								dependencyType: null,
								timestamp: isoNow(),
							};
							agent.injectContext(injection);
							injectedCount++;
						} catch {
							// Agent may have been destroyed between the check and the call
						}
					}
				}

				return `Context injected into ${injectedCount} active agent(s).`;
			}

			case UserIntent.CANCEL: {
				if (!this._executing) {
					return "No task is currently executing.";
				}

				await this.destroyManagedAgents();
				return "Current execution cancelled. All agents destroyed.";
			}

			case UserIntent.REPLAN: {
				if (!this._executing || !this._currentAnalysis) {
					return "No active execution to replan.";
				}

				// Note: Full user-triggered replanning requires async coordination
				// with the running execution loop. For this evolution, the intent
				// is recognized but the actual trigger mechanism uses automatic
				// triggers (failure, deadlock, cascading failures).
				return "Replan evaluation requested. The system will evaluate whether the current plan should be modified.";
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

	// ── Private: Approval Handling ─────────────────────────────────────

	/**
	 * Handles an `APPROVE_AGENT` intent from the user.
	 *
	 * Resolves pending approval requests based on the intent parameters:
	 * - If `targetAgent` is specified, resolves only that agent's approvals.
	 * - Otherwise, resolves all pending approvals.
	 * - Supports both approval (`approved: true`) and denial (`approved: false`).
	 *
	 * @param detected - The detected intent with approval parameters.
	 * @returns A human-readable summary of the resolution.
	 */
	private handleApprovalIntent(detected: DetectedIntent): string {
		if (!this.approvalManager.hasPending()) {
			return "No pending approval requests to resolve.";
		}

		const approved = detected.parameters.approved !== false;
		const targetAgent =
			typeof detected.parameters.targetAgent === "string"
				? detected.parameters.targetAgent
				: undefined;

		let resolution: ApprovalResolution;

		if (targetAgent) {
			// Try by agent name first (most natural for user messages)
			resolution = this.approvalManager.resolveByAgentName(
				targetAgent,
				approved,
			);

			// If not found by name, try by ID as fallback
			if (!resolution.resolved) {
				resolution = this.approvalManager.resolveByAgentId(
					targetAgent,
					approved,
				);
			}
		} else {
			// No specific target — resolve all pending approvals
			resolution = this.approvalManager.resolveAll(approved);
		}

		const action = approved ? "approved" : "denied";
		this.logger.info(
			{
				action,
				targetAgent: targetAgent ?? "all",
				resolved: resolution.resolved,
				count: resolution.count,
			},
			`Approval intent handled: ${resolution.summary}`,
		);

		return resolution.summary;
	}

	// ── Private: Agent Cleanup ─────────────────────────────────────────

	/**
	 * Destroys all currently managed agents and cleans up state.
	 */
	private async destroyManagedAgents(): Promise<void> {
		// Deny all pending approvals so blocked agents can unblock before destroy
		this.approvalManager.clear();

		const destroyPromises: Promise<void>[] = [];

		for (const { agent } of this.managedAgents.values()) {
			if (agent.status !== AgentStatus.DESTROYED) {
				destroyPromises.push(
					agent.destroy().catch((err) => {
						this.logger.warn(
							{
								agentId: agent.id,
								error: toErrorMessage(err),
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
