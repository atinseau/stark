import type pino from "pino";
import { ConversationRole } from "../../enums/conversation-role.enum.ts";
import {
  checkpointPrompt,
  checkpointSystemPrompt,
} from "../../prompts/index.ts";
import {
  CheckpointAction,
  type CheckpointConfig,
  type CheckpointResult,
  CheckpointTrigger,
  type TaskAnalysis,
} from "../../types/agent-pool.types.ts";
import { toErrorMessage } from "../../utils/errors.ts";
import { isoNow } from "../../utils/formatting.ts";
import type { ContextTracker } from "./context-tracker.ts";
import type { ConversationManager } from "./conversation-manager.ts";

// ── Constants ──────────────────────────────────────────────────────────────

/** Default checkpoint configuration values. */
const DEFAULT_CONFIG: Required<CheckpointConfig> = {
  enabled: true,
  completionPercentages: 50,
  deltaInterval: 30,
  timeIntervalMs: 60_000,
  notifyOnCheckpoint: false,
};

// ── Validator ──────────────────────────────────────────────────────────────

/**
 * Validates the LLM response for a checkpoint evaluation.
 *
 * Returns a validated object with `corrections` as a plain `Record`
 * (converted to a `ReadonlyMap` by the caller), or `null` if the
 * response is structurally invalid.
 */
export function validateCheckpointResponse(data: unknown): {
  action: CheckpointAction;
  healthScore: number;
  reasoning: string;
  statusSummary: string;
  issues: Array<{
    severity: "info" | "warning" | "critical";
    description: string;
    affectedAgents: string[];
  }>;
  corrections: Record<string, string>;
} | null {
  if (data == null || typeof data !== "object") return null;

  const obj = data as Record<string, unknown>;

  // action
  const validActions: string[] = [
    "continue",
    "adjust",
    "replan",
    "escalate",
    "abort",
  ];
  if (typeof obj.action !== "string" || !validActions.includes(obj.action))
    return null;

  // healthScore
  if (typeof obj.healthScore !== "number") return null;

  // reasoning
  if (typeof obj.reasoning !== "string" || obj.reasoning.length === 0)
    return null;

  // statusSummary
  if (typeof obj.statusSummary !== "string" || obj.statusSummary.length === 0)
    return null;

  // issues — tolerant: invalid entries are filtered, not rejected
  const issues: Array<{
    severity: "info" | "warning" | "critical";
    description: string;
    affectedAgents: string[];
  }> = [];

  if (Array.isArray(obj.issues)) {
    for (const raw of obj.issues) {
      if (raw == null || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;

      const severity = item.severity;
      if (
        severity !== "info" &&
        severity !== "warning" &&
        severity !== "critical"
      )
        continue;

      if (typeof item.description !== "string" || item.description.length === 0)
        continue;

      const affectedAgents = Array.isArray(item.affectedAgents)
        ? item.affectedAgents.filter((a): a is string => typeof a === "string")
        : [];

      issues.push({
        severity: severity as "info" | "warning" | "critical",
        description: item.description,
        affectedAgents,
      });
    }
  }

  // corrections — tolerant: non-string values are filtered
  const corrections: Record<string, string> = {};
  if (obj.corrections != null && typeof obj.corrections === "object") {
    for (const [key, value] of Object.entries(
      obj.corrections as Record<string, unknown>,
    )) {
      if (typeof value === "string" && value.length > 0) {
        corrections[key] = value;
      }
    }
  }

  return {
    action: obj.action as CheckpointAction,
    healthScore: Math.max(0, Math.min(1, obj.healthScore)),
    reasoning: obj.reasoning,
    statusSummary: obj.statusSummary,
    issues,
    corrections,
  };
}

// ── CheckpointEvaluator ────────────────────────────────────────────────────

/**
 * Evaluates the health of a multi-agent execution at predetermined
 * checkpoint moments and recommends corrective actions if needed.
 *
 * ## Trigger Conditions
 *
 * Checkpoints are triggered by multiple independent conditions:
 *
 * - **Completion percentage**: When a configured percentage of subtasks
 *   have completed (default: 50%). Supports multiple thresholds.
 *
 * - **Delta count interval**: After every N deltas processed (default: 30).
 *   Provides periodic assessment during long-running tasks.
 *
 * - **Time interval**: After every N milliseconds elapsed (default: 60s).
 *   Ensures assessment even when few deltas are produced.
 *
 * - **Agent failure**: When an agent fails, providing additional context
 *   beyond what the ReplanTrigger (evolution 11) evaluates.
 *
 * - **User request**: When the user asks for status via STATUS_QUERY
 *   intent, a checkpoint evaluation enriches the response.
 *
 * ## Evaluation Process
 *
 * When a trigger fires, the evaluator:
 *
 * 1. Collects the current state of all agents from the ContextTracker
 * 2. Gathers recent coordination decisions from the session memory
 *    (evolution 14) if available
 * 3. Sends a one-shot prompt to the LLM with the full execution state
 * 4. Parses and validates the LLM's assessment
 * 5. Returns a CheckpointResult with the recommended action
 *
 * The pool orchestrator then acts on the result:
 * - **continue**: No action, log the checkpoint
 * - **adjust**: Inject corrections into affected agents via structured
 *   context injection (evolution 08)
 * - **replan**: Trigger the re-planning mechanism (evolution 11)
 * - **escalate**: Notify the user with the checkpoint summary
 * - **abort**: Cancel the execution
 *
 * ## Rate Limiting
 *
 * To prevent excessive LLM calls, the evaluator enforces a minimum
 * interval between checkpoints (MIN_CHECKPOINT_INTERVAL_MS). If a
 * trigger fires but a checkpoint was evaluated recently, the trigger
 * is silently skipped.
 *
 * ## Conversation Isolation
 *
 * Checkpoint evaluations use one-shot prompts to avoid accumulating
 * history. However, the previous checkpoint result (if any) is included
 * in the prompt so the LLM can track evolution of issues.
 */
export class CheckpointEvaluator {
  /** Resolved configuration with defaults applied. */
  private readonly config: Required<CheckpointConfig>;

  /** The previous checkpoint result, included in subsequent evaluations. */
  private previousResult: CheckpointResult | null = null;

  /** Timestamp of the last checkpoint evaluation. */
  private lastCheckpointTime: number = 0;

  /** Delta count at the last checkpoint. */
  private lastCheckpointDeltaCount: number = 0;

  /** Completion percentage thresholds that have already been triggered. */
  private triggeredPercentages = new Set<number>();

  /** Running count of checkpoints evaluated. */
  private _checkpointCount = 0;

  /**
   * Minimum interval between checkpoint evaluations in milliseconds.
   * Prevents excessive LLM calls when multiple triggers fire in quick
   * succession.
   */
  static readonly MIN_CHECKPOINT_INTERVAL_MS = 15_000;

  constructor(
    private readonly conversations: ConversationManager,
    private readonly contextTracker: ContextTracker,
    private readonly logger: pino.Logger,
    config?: CheckpointConfig,
  ) {
    this.config = {
      enabled: config?.enabled ?? DEFAULT_CONFIG.enabled,
      completionPercentages:
        config?.completionPercentages ?? DEFAULT_CONFIG.completionPercentages,
      deltaInterval: config?.deltaInterval ?? DEFAULT_CONFIG.deltaInterval,
      timeIntervalMs: config?.timeIntervalMs ?? DEFAULT_CONFIG.timeIntervalMs,
      notifyOnCheckpoint:
        config?.notifyOnCheckpoint ?? DEFAULT_CONFIG.notifyOnCheckpoint,
    };
  }

  // ── Trigger Checks ─────────────────────────────────────────────────

  /**
   * Checks whether a checkpoint should be triggered based on the
   * current execution state. Called after each delta is processed.
   *
   * Returns the trigger type if a checkpoint should fire, or null
   * if no checkpoint is warranted.
   *
   * @param deltaCount - Total deltas processed so far.
   * @param completedSubtasks - Number of subtasks that have completed.
   * @param totalSubtasks - Total number of subtasks.
   * @param elapsedMs - Time elapsed since execution started.
   * @returns The trigger type, or null.
   */
  shouldTrigger(
    deltaCount: number,
    completedSubtasks: number,
    totalSubtasks: number,
    elapsedMs: number,
  ): CheckpointTrigger | null {
    if (!this.config.enabled) return null;
    if (totalSubtasks <= 1) return null; // Skip for single-agent

    // Rate limiting
    const now = Date.now();
    if (
      this.lastCheckpointTime > 0 &&
      now - this.lastCheckpointTime <
      CheckpointEvaluator.MIN_CHECKPOINT_INTERVAL_MS
    ) {
      return null;
    }

    // Check completion percentage trigger
    const completionPercent =
      totalSubtasks > 0
        ? Math.round((completedSubtasks / totalSubtasks) * 100)
        : 0;

    const percentages = Array.isArray(this.config.completionPercentages)
      ? this.config.completionPercentages
      : [this.config.completionPercentages];

    for (const threshold of percentages) {
      if (
        completionPercent >= threshold &&
        !this.triggeredPercentages.has(threshold)
      ) {
        this.triggeredPercentages.add(threshold);
        return CheckpointTrigger.COMPLETION_PERCENTAGE;
      }
    }

    // Check delta count interval trigger
    if (
      deltaCount - this.lastCheckpointDeltaCount >=
      this.config.deltaInterval
    ) {
      return CheckpointTrigger.DELTA_COUNT;
    }

    // Check time interval trigger
    if (
      this.lastCheckpointTime === 0
        ? elapsedMs >= this.config.timeIntervalMs
        : now - this.lastCheckpointTime >= this.config.timeIntervalMs
    ) {
      return CheckpointTrigger.TIME_INTERVAL;
    }

    return null;
  }

  /**
   * Forces a checkpoint trigger. Used for AGENT_FAILURE and
   * USER_REQUESTED triggers which bypass the normal check cycle.
   *
   * @param trigger - The trigger type.
   * @returns The trigger type (pass-through), or null if rate-limited.
   */
  forceTrigger(trigger: CheckpointTrigger): CheckpointTrigger | null {
    if (!this.config.enabled) return null;

    // Rate limiting still applies, but with a shorter minimum for forced triggers
    const now = Date.now();
    const minInterval =
      trigger === CheckpointTrigger.USER_REQUESTED
        ? 5_000 // Users can request more frequently
        : CheckpointEvaluator.MIN_CHECKPOINT_INTERVAL_MS;

    if (
      this.lastCheckpointTime > 0 &&
      now - this.lastCheckpointTime < minInterval
    ) {
      return null;
    }

    return trigger;
  }

  // ── Evaluation ─────────────────────────────────────────────────────

  /**
   * Evaluates the current execution state at a checkpoint.
   *
   * Sends a one-shot prompt to the LLM with the full execution state
   * and returns a structured assessment with recommended action.
   *
   * @param trigger - What triggered this checkpoint.
   * @param task - The original task description.
   * @param analysis - The task analysis from the planner.
   * @param deltaCount - Total deltas processed so far.
   * @param sharingCount - Total sharing decisions made.
   * @param elapsedMs - Time elapsed since execution started.
   * @param recentDecisions - Optional recent coordination decisions from
   *                          the session memory (evolution 14).
   * @returns A CheckpointResult with the recommended action.
   */
  async evaluate(
    trigger: CheckpointTrigger,
    task: string,
    analysis: TaskAnalysis,
    deltaCount: number,
    sharingCount: number,
    elapsedMs: number,
    recentDecisions?: Array<{ type: string; summary: string }>,
  ): Promise<CheckpointResult> {
    this._checkpointCount++;
    this.lastCheckpointTime = Date.now();
    this.lastCheckpointDeltaCount = deltaCount;

    // Collect agent states
    const agentStates = this.contextTracker.getAllAgentStates();

    // Count completion stats
    const completedSubtasks = agentStates.filter(
      (s) => s.completed && !s.error,
    ).length;
    const failedSubtasks = agentStates.filter(
      (s) => s.completed && s.error,
    ).length;
    const inProgressSubtasks = agentStates.filter((s) => !s.completed).length;

    // Build the checkpoint prompt
    const prompt = checkpointPrompt({
      task,
      strategy: analysis.strategy,
      complexity: analysis.complexity,
      planningReasoning: analysis.reasoning,
      trigger,
      elapsedMs,
      totalSubtasks: analysis.subtasks.length,
      completedSubtasks,
      failedSubtasks,
      inProgressSubtasks,
      deltaCount,
      sharingCount,
      agents: agentStates.map((state) => ({
        agentName: state.agentName,
        taskRole: state.taskRole,
        taskDescription: state.taskDescription,
        status: state.status,
        completed: state.completed,
        error: state.error,
        filesWritten: state.filesWritten,
        filesRead: state.filesRead,
        events: state.events,
        lastDelta: state.lastDelta,
      })),
      recentDecisions: recentDecisions ?? null,
      previousCheckpoint: this.previousResult
        ? {
          action: this.previousResult.action,
          healthScore: this.previousResult.healthScore,
          statusSummary: this.previousResult.statusSummary,
          issues: this.previousResult.issues,
        }
        : null,
    });

    this.logger.info(
      {
        trigger,
        checkpointNumber: this._checkpointCount,
        completedSubtasks,
        failedSubtasks,
        inProgressSubtasks,
        deltaCount,
        elapsedMs,
      },
      `Checkpoint #${this._checkpointCount} triggered: ${trigger}`,
    );

    try {
      // Use the CONTEXT_ANALYZER conversation for checkpoint evaluations.
      // The checkpoint system prompt is used as a one-shot system prompt
      // override — we send the checkpoint system + user prompt together,
      // not appending to the CONTEXT_ANALYZER's notification-focused history.

      const rawResult = await this.conversations.sendOneShotJson(
        ConversationRole.CONTEXT_ANALYZER,
        `${checkpointSystemPrompt({})}\n\n---\n\n${prompt}`,
        validateCheckpointResponse,
        { maxTokens: 4096, maxJsonAttempts: 2 },
      );

      const result: CheckpointResult = {
        action: rawResult.action,
        trigger,
        reasoning: rawResult.reasoning,
        healthScore: rawResult.healthScore,
        statusSummary: rawResult.statusSummary,
        issues: rawResult.issues,
        corrections: new Map(Object.entries(rawResult.corrections)),
        timestamp: isoNow(),
      };

      this.previousResult = result;

      this.logger.info(
        {
          action: result.action,
          healthScore: result.healthScore,
          issueCount: result.issues.length,
          correctionCount: result.corrections.size,
        },
        `Checkpoint #${this._checkpointCount} result: ${result.action} (health: ${result.healthScore})`,
      );

      if (result.issues.length > 0) {
        for (const issue of result.issues) {
          this.logger.warn(
            {
              severity: issue.severity,
              affectedAgents: issue.affectedAgents,
            },
            `Checkpoint issue [${issue.severity}]: ${issue.description}`,
          );
        }
      }

      return result;
    } catch (error) {
      this.logger.warn(
        { error: toErrorMessage(error), trigger },
        "Checkpoint evaluation failed — defaulting to continue",
      );

      // Safe default: if the evaluation fails, don't intervene
      const fallback: CheckpointResult = {
        action: CheckpointAction.CONTINUE,
        trigger,
        reasoning: `Checkpoint evaluation failed: ${toErrorMessage(error)}. Defaulting to continue.`,
        healthScore: 0.5,
        statusSummary: "Checkpoint evaluation failed. Execution continues.",
        issues: [],
        corrections: new Map(),
        timestamp: isoNow(),
      };

      this.previousResult = fallback;
      return fallback;
    }
  }

  // ── Queries ────────────────────────────────────────────────────────

  /** Number of checkpoints evaluated so far. */
  get checkpointCount(): number {
    return this._checkpointCount;
  }

  /** The most recent checkpoint result, or null if none evaluated yet. */
  get lastResult(): CheckpointResult | null {
    return this.previousResult;
  }

  /** Whether the evaluator is enabled. */
  get isEnabled(): boolean {
    return this.config.enabled;
  }

  // ── Reset ──────────────────────────────────────────────────────────

  /**
   * Resets the evaluator state for a new execution.
   * Called between executions to clear previous results and counters.
   */
  reset(): void {
    this.previousResult = null;
    this.lastCheckpointTime = 0;
    this.lastCheckpointDeltaCount = 0;
    this.triggeredPercentages.clear();
    this._checkpointCount = 0;
  }
}
