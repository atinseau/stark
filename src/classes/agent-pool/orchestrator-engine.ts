import type pino from "pino";
import { ConversationRole } from "../../enums/conversation-role.enum.ts";
import { orchestratorEvaluationPrompt } from "../../prompts/index.ts";
import type {
  CheckpointResult,
  DirectiveTarget,
  OrchestratorAssessment,
  OrchestratorConfig,
  OrchestratorDirective,
  OrchestratorIssue,
  TaskAnalysis,
} from "../../types/agent-pool.types.ts";
import { toErrorMessage } from "../../utils/errors.ts";
import { isoNow } from "../../utils/formatting.ts";
import type { ContextTracker } from "./context-tracker.ts";
import type { ConversationManager } from "./conversation-manager.ts";
import type { DecisionJournal } from "./decision-journal.ts";
import type { InformationBroker } from "./information-broker.ts";
import type { NotificationEngine } from "./notification-engine.ts";

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_DELTA_INTERVAL = 8;
const DEFAULT_MIN_INTERVAL_MS = 30_000;
const DEFAULT_MAX_ACTIVE_DIRECTIVES = 10;
const DEFAULT_DIRECTIVE_TTL = 5;

/** Minimum number of agents required to activate the orchestrator. */
const MIN_AGENTS_FOR_ORCHESTRATOR = 2;

// ── Validator ──────────────────────────────────────────────────────────────

/**
 * Validates a raw parsed JSON value from the ORCHESTRATOR conversation
 * against the expected assessment schema.
 *
 * Returns `null` on invalid data so the OpenRouter client can retry
 * with a correction prompt.
 *
 * @internal Exported for testing only.
 */
export function validateOrchestratorResponse(data: unknown): {
  coherenceScore: number;
  assessment: string;
  issues: Array<{
    category: string;
    severity: string;
    description: string;
    affected: string[];
  }>;
  directives: Array<{
    target: string;
    instruction: string;
    priority: string;
    ttlEvaluations: number;
  }>;
} | null {
  if (data == null || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;

  // coherenceScore
  if (typeof obj.coherenceScore !== "number") return null;

  // assessment
  if (typeof obj.assessment !== "string" || obj.assessment.length === 0)
    return null;

  // issues
  if (!Array.isArray(obj.issues)) return null;
  const validCategories = [
    "coherence",
    "efficiency",
    "drift",
    "conflict",
    "communication",
  ];
  const validSeverities = ["low", "medium", "high"];

  for (const issue of obj.issues) {
    if (issue == null || typeof issue !== "object") return null;
    const i = issue as Record<string, unknown>;
    if (typeof i.category !== "string" || !validCategories.includes(i.category))
      return null;
    if (typeof i.severity !== "string" || !validSeverities.includes(i.severity))
      return null;
    if (typeof i.description !== "string" || i.description.length === 0)
      return null;
    if (!Array.isArray(i.affected)) return null;
  }

  // directives
  if (!Array.isArray(obj.directives)) return null;
  const validTargets = [
    "sharing",
    "notification",
    "planner",
    "checkpoint",
    "all",
  ];
  const validPriorities = ["suggestion", "recommendation", "strong"];

  for (const dir of obj.directives) {
    if (dir == null || typeof dir !== "object") return null;
    const d = dir as Record<string, unknown>;
    if (typeof d.target !== "string" || !validTargets.includes(d.target))
      return null;
    if (typeof d.instruction !== "string" || d.instruction.length === 0)
      return null;
    if (typeof d.priority !== "string" || !validPriorities.includes(d.priority))
      return null;
    if (typeof d.ttlEvaluations !== "number" || d.ttlEvaluations < 1)
      return null;
  }

  return {
    coherenceScore: Math.max(0, Math.min(1, obj.coherenceScore)),
    assessment: obj.assessment as string,
    issues: (obj.issues as Array<Record<string, unknown>>).map((i) => ({
      category: i.category as string,
      severity: i.severity as string,
      description: i.description as string,
      affected: (i.affected as unknown[]).filter(
        (a): a is string => typeof a === "string",
      ),
    })),
    directives: (obj.directives as Array<Record<string, unknown>>).map((d) => ({
      target: d.target as string,
      instruction: d.instruction as string,
      priority: d.priority as string,
      ttlEvaluations: d.ttlEvaluations as number,
    })),
  };
}

// ── OrchestratorEngine ─────────────────────────────────────────────────────

/**
 * Meta-reflection engine that supervises cross-conversation coordination.
 *
 * The OrchestratorEngine periodically evaluates the quality of coordination
 * across all active agents and emits directives to improve coherence.
 *
 * ## Trigger conditions
 *
 * The orchestrator evaluates when:
 * 1. A configurable number of deltas have been processed since the last evaluation
 * 2. A minimum time interval has elapsed since the last evaluation
 *
 * Both conditions must be met to prevent over-evaluation in either
 * high-frequency (many rapid deltas) or low-frequency (long pauses) scenarios.
 *
 * ## Directive lifecycle
 *
 * Directives have a TTL measured in evaluation cycles. After each evaluation:
 * 1. All directives' TTL is decremented
 * 2. Directives with TTL ≤ 0 are removed
 * 3. New directives from the evaluation are added
 *
 * Directives are consumed by subsystems through the `getDirectivesFor()` method,
 * which returns all active directives relevant to a specific target.
 *
 * ## Conversation isolation
 *
 * The orchestrator uses one-shot prompts (`sendOneShotJson`) to avoid
 * unbounded history growth. The `previousAssessment` field provides
 * continuity between evaluations without maintaining full conversation history.
 */
export class OrchestratorEngine {
  /** Resolved configuration with defaults. */
  private readonly config: Required<OrchestratorConfig>;

  /** Currently active directives. */
  private readonly activeDirectives: OrchestratorDirective[] = [];

  /** The most recent assessment, for continuity between evaluations. */
  private _previousAssessment: OrchestratorAssessment | null = null;

  /** Number of deltas processed since the last evaluation. */
  private _deltasSinceLastEval = 0;

  /** Timestamp of the last evaluation. */
  private _lastEvalTime = 0;

  /** Sequential counter for assessments. */
  private _assessmentCount = 0;

  /** Running total of directives emitted. */
  private _totalDirectivesEmitted = 0;

  constructor(
    private readonly conversations: ConversationManager,
    private readonly contextTracker: ContextTracker,
    private readonly logger: pino.Logger,
    config?: OrchestratorConfig,
  ) {
    this.config = {
      enabled: config?.enabled ?? true,
      deltaInterval: config?.deltaInterval ?? DEFAULT_DELTA_INTERVAL,
      minIntervalMs: config?.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
      maxActiveDirectives:
        config?.maxActiveDirectives ?? DEFAULT_MAX_ACTIVE_DIRECTIVES,
      defaultDirectiveTtl: config?.defaultDirectiveTtl ?? DEFAULT_DIRECTIVE_TTL,
    };
  }

  // ── Trigger Check ──────────────────────────────────────────────────

  /**
   * Records that a delta was processed and checks if the orchestrator
   * should trigger an evaluation.
   *
   * Both the delta interval AND time interval must be satisfied.
   *
   * @returns `true` if the orchestrator should evaluate now.
   */
  recordDelta(): boolean {
    if (!this.config.enabled) return false;

    this._deltasSinceLastEval++;

    // Check delta interval
    if (this._deltasSinceLastEval < this.config.deltaInterval) return false;

    // Check time interval
    const now = Date.now();
    if (now - this._lastEvalTime < this.config.minIntervalMs) return false;

    // Check minimum agent count
    if (this.contextTracker.agentCount < MIN_AGENTS_FOR_ORCHESTRATOR)
      return false;

    return true;
  }

  // ── Evaluation ─────────────────────────────────────────────────────

  /**
   * Performs a meta-reflection evaluation of the current coordination state.
   *
   * Builds a comprehensive snapshot of all subsystem activity and sends
   * it to the ORCHESTRATOR conversation for analysis.
   *
   * @param task - The original task description.
   * @param analysis - The current task analysis.
   * @param broker - The information broker (for sharing stats).
   * @param notificationEngine - The notification engine (for notification stats).
   * @param checkpointResult - The most recent checkpoint result, if any.
   * @param sharingJournal - The sharing decision journal, if available.
   * @returns The orchestrator's assessment with directives.
   */
  async evaluate(
    task: string,
    analysis: TaskAnalysis,
    broker: InformationBroker,
    notificationEngine: NotificationEngine,
    checkpointResult?: CheckpointResult | null,
    sharingJournal?: DecisionJournal | null,
  ): Promise<OrchestratorAssessment | null> {
    if (!this.config.enabled) return null;

    this._deltasSinceLastEval = 0;
    this._lastEvalTime = Date.now();
    this._assessmentCount++;

    // Decrement TTL on existing directives before evaluation
    this.tickDirectives();

    // Build the evaluation snapshot
    const agentStates = this.contextTracker.getAllAgentStates();
    const agents = agentStates.map((state) => ({
      agentName: state.agentName,
      taskRole: state.taskRole,
      taskDescription: state.taskDescription,
      status: state.status,
      completed: state.completed,
      error: state.error,
      filesWritten: state.filesWritten,
      eventCount: state.events.length,
      promptCount: state.promptResults.length,
      lastDeltaSummary: state.lastDelta?.summary ?? null,
    }));

    // Build sharing activity snapshot
    const sharingData = {
      totalEvaluations: broker.evaluationCount,
      approvedCount: broker.shareCount,
      approvalRate:
        broker.evaluationCount > 0
          ? Math.round((broker.shareCount / broker.evaluationCount) * 100)
          : 0,
      recentDecisions: this.getRecentSharingDecisions(sharingJournal),
    };

    // Build notification activity snapshot
    const notificationData = {
      sentCount: notificationEngine.notificationCount,
      evaluationCount: notificationEngine.evaluationCount,
    };

    // Build active directives snapshot (with remaining TTL)
    const activeDirectivesSnapshot = this.activeDirectives.map((d) => ({
      target: d.target,
      priority: d.priority,
      instruction: d.instruction,
      remainingTtl: d.ttlEvaluations,
    }));

    // Build the prompt
    const prompt = orchestratorEvaluationPrompt({
      task,
      strategy: analysis.strategy,
      complexity: analysis.complexity,
      planningReasoning: analysis.reasoning,
      totalSubtasks: analysis.subtasks.length,
      agents,
      sharing: sharingData,
      notification: notificationData,
      checkpoint: checkpointResult ?? null,
      previousAssessment: this._previousAssessment,
      activeDirectives: activeDirectivesSnapshot,
    });

    this.logger.info(
      {
        assessmentNumber: this._assessmentCount,
        agentCount: agents.length,
        activeDirectiveCount: this.activeDirectives.length,
      },
      `Orchestrator evaluation #${this._assessmentCount}`,
    );

    try {
      const rawResult = await this.conversations.sendOneShotJson(
        ConversationRole.ORCHESTRATOR,
        prompt,
        validateOrchestratorResponse,
        { maxTokens: 4096, maxJsonAttempts: 2 },
      );

      if (!rawResult) {
        this.logger.warn("Orchestrator evaluation returned null");
        return null;
      }

      // Build the full assessment
      const now = isoNow();
      const newDirectives: OrchestratorDirective[] = rawResult.directives.map(
        (d, idx) => ({
          id: `dir-${this._assessmentCount}-${idx}-${Date.now().toString(36)}`,
          target: d.target as OrchestratorDirective["target"],
          instruction: d.instruction,
          priority: d.priority as OrchestratorDirective["priority"],
          ttlEvaluations: d.ttlEvaluations,
          timestamp: now,
        }),
      );

      // Add new directives, enforce max limit
      for (const directive of newDirectives) {
        this.activeDirectives.push(directive);
        this._totalDirectivesEmitted++;
      }
      this.enforceDirectiveLimit();

      const assessment: OrchestratorAssessment = {
        coherenceScore: rawResult.coherenceScore,
        assessment: rawResult.assessment,
        issues: rawResult.issues.map((i) => ({
          category: i.category as OrchestratorIssue["category"],
          severity: i.severity as OrchestratorIssue["severity"],
          description: i.description,
          affected: i.affected,
        })),
        directives: newDirectives,
        timestamp: now,
        assessmentNumber: this._assessmentCount,
      };

      this._previousAssessment = assessment;

      this.logger.info(
        {
          coherenceScore: assessment.coherenceScore,
          issueCount: assessment.issues.length,
          newDirectiveCount: newDirectives.length,
          activeDirectiveCount: this.activeDirectives.length,
        },
        `Orchestrator assessment: coherence=${assessment.coherenceScore}, ` +
        `${assessment.issues.length} issue(s), ${newDirectives.length} new directive(s)`,
      );

      return assessment;
    } catch (error) {
      this.logger.warn(
        { error: toErrorMessage(error) },
        "Orchestrator evaluation failed — skipping",
      );
      return null;
    }
  }

  // ── Directive Access ───────────────────────────────────────────────

  /**
   * Returns all active directives targeting a specific subsystem.
   *
   * Includes directives targeting `"all"` in addition to the
   * specified target.
   *
   * @param target - The subsystem to get directives for.
   * @returns Active directives for this target, sorted by priority (strong first).
   */
  getDirectivesFor(target: DirectiveTarget): readonly OrchestratorDirective[] {
    const matching = this.activeDirectives.filter(
      (d) => d.target === target || d.target === "all",
    );

    const priorityOrder: Record<string, number> = {
      strong: 0,
      recommendation: 1,
      suggestion: 2,
    };

    return matching.sort(
      (a, b) =>
        (priorityOrder[a.priority] ?? 99) - (priorityOrder[b.priority] ?? 99),
    );
  }

  /**
   * Formats active directives for a target as a prompt section.
   *
   * Returns `null` if no directives are active for this target.
   * The returned string is suitable for inclusion in LLM prompts.
   *
   * @param target - The subsystem target.
   * @returns A formatted string of directives, or `null`.
   */
  getDirectivePromptSection(target: DirectiveTarget): string | null {
    const directives = this.getDirectivesFor(target);
    if (directives.length === 0) return null;

    const lines = [
      "## Active Orchestrator Directives",
      "The following directives come from the meta-orchestrator and should influence your decisions:",
      "",
    ];

    for (const d of directives) {
      lines.push(`- [${d.priority.toUpperCase()}] ${d.instruction}`);
    }

    return lines.join("\n");
  }

  // ── Statistics ─────────────────────────────────────────────────────

  /** Total number of assessments performed. */
  get assessmentCount(): number {
    return this._assessmentCount;
  }

  /** Total number of directives emitted across all assessments. */
  get totalDirectivesEmitted(): number {
    return this._totalDirectivesEmitted;
  }

  /** Number of currently active directives. */
  get activeDirectiveCount(): number {
    return this.activeDirectives.length;
  }

  /** The most recent assessment, or null. */
  get previousAssessment(): OrchestratorAssessment | null {
    return this._previousAssessment;
  }

  /** Whether the orchestrator is enabled. */
  get isEnabled(): boolean {
    return this.config.enabled;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Resets all orchestrator state for a new execution.
   */
  reset(): void {
    this.activeDirectives.length = 0;
    this._previousAssessment = null;
    this._deltasSinceLastEval = 0;
    this._lastEvalTime = 0;
    this._assessmentCount = 0;
    this._totalDirectivesEmitted = 0;
  }

  // ── Private ────────────────────────────────────────────────────────

  /**
   * Decrements TTL on all active directives and removes expired ones.
   */
  private tickDirectives(): void {
    for (let i = this.activeDirectives.length - 1; i >= 0; i--) {
      const directive = this.activeDirectives[i];
      if (!directive) continue;

      // Decrement TTL by creating a new object (readonly fields)
      const updated: OrchestratorDirective = {
        ...directive,
        ttlEvaluations: directive.ttlEvaluations - 1,
      };

      if (updated.ttlEvaluations <= 0) {
        this.activeDirectives.splice(i, 1);
        this.logger.debug(
          { directiveId: directive.id, target: directive.target },
          `Directive expired: ${directive.instruction.slice(0, 80)}`,
        );
      } else {
        this.activeDirectives[i] = updated;
      }
    }
  }

  /**
   * Removes the oldest directives if the count exceeds the max limit.
   */
  private enforceDirectiveLimit(): void {
    while (this.activeDirectives.length > this.config.maxActiveDirectives) {
      const removed = this.activeDirectives.shift();
      if (removed) {
        this.logger.debug(
          { directiveId: removed.id },
          `Directive evicted (limit reached): ${removed.instruction.slice(0, 80)}`,
        );
      }
    }
  }

  /**
   * Extracts recent sharing decisions from the DecisionJournal for the prompt.
   *
   * Returns the last 5 decisions formatted for the orchestrator prompt.
   */
  private getRecentSharingDecisions(
    journal: DecisionJournal | null | undefined,
  ): Array<{
    decision: string;
    sourceAgent: string;
    targetAgent: string;
    reasoning: string;
  }> {
    if (!journal) return [];

    const allEntries = journal.getAllEntries();
    const recentEntries = allEntries.slice(-5);

    return recentEntries.map((entry) => ({
      decision: entry.approved ? "SHARED" : "DENIED",
      sourceAgent: entry.sourceAgentName,
      targetAgent: entry.targetName,
      reasoning: entry.reasoningSummary,
    }));
  }
}
