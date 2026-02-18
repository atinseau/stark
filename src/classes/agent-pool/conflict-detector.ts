import type pino from "pino";
import { ConversationRole } from "../../enums/conversation-role.enum.ts";
import { DeltaType } from "../../enums/delta-type.enum.ts";
import { conflictAnalysisPrompt } from "../../prompts/index.ts";
import type {
	ConflictDetectorConfig,
	ConflictRecord,
	ConflictType,
	ContextDelta,
} from "../../types/agent-pool.types.ts";
import { toErrorMessage } from "../../utils/errors.ts";
import { isoNow } from "../../utils/formatting.ts";
import type { ContextTracker } from "./context-tracker.ts";
import type { ConversationManager } from "./conversation-manager.ts";
import type { InformationBroker } from "./information-broker.ts";

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_MIN_ALERT_SEVERITY = 0.5;
const DEFAULT_MAX_CONFLICTS = 50;

/**
 * Delta types that can trigger conflict analysis.
 * Not every delta needs conflict checking — only those that produce
 * tangible outputs that could contradict other agents' work.
 */
const CONFLICT_TRIGGERING_DELTA_TYPES: ReadonlySet<DeltaType> = new Set([
	DeltaType.FILE_WRITTEN,
	DeltaType.PROMPT_COMPLETE,
	DeltaType.TOOL_COMPLETE,
]);

/**
 * Minimum significance for a delta to be evaluated for conflicts.
 * Low-significance deltas (file reads, status changes) rarely cause conflicts.
 */
const MIN_CONFLICT_CHECK_SIGNIFICANCE = 0.4;

// ── Validator ──────────────────────────────────────────────────────────────

export function validateConflictAnalysisResponse(data: unknown): {
	hasConflict: boolean;
	conflicts?: Array<{
		type: string;
		severity: number;
		description: string;
		affectedAgentIds: string[];
		recommendation: string;
		staleInformation?: string;
	}>;
	reasoning: string;
} | null {
	if (data == null || typeof data !== "object") return null;
	const obj = data as Record<string, unknown>;

	if (typeof obj.hasConflict !== "boolean") return null;
	if (typeof obj.reasoning !== "string" || obj.reasoning.length === 0)
		return null;

	if (!obj.hasConflict) {
		return {
			hasConflict: false,
			reasoning: obj.reasoning as string,
		};
	}

	// hasConflict === true — validate the conflicts array
	if (!Array.isArray(obj.conflicts) || obj.conflicts.length === 0) return null;

	const validTypes: string[] = [
		"file_overlap",
		"stale_share",
		"semantic_conflict",
		"dependency_violation",
	];

	const conflicts: Array<{
		type: string;
		severity: number;
		description: string;
		affectedAgentIds: string[];
		recommendation: string;
		staleInformation?: string;
	}> = [];

	for (const raw of obj.conflicts) {
		if (raw == null || typeof raw !== "object") return null;
		const c = raw as Record<string, unknown>;

		if (typeof c.type !== "string" || !validTypes.includes(c.type)) return null;
		if (typeof c.severity !== "number") return null;
		if (typeof c.description !== "string" || c.description.length === 0)
			return null;
		if (!Array.isArray(c.affectedAgentIds)) return null;
		if (typeof c.recommendation !== "string" || c.recommendation.length === 0)
			return null;

		conflicts.push({
			type: c.type,
			severity: Math.max(0, Math.min(1, c.severity)),
			description: c.description,
			affectedAgentIds: (c.affectedAgentIds as unknown[]).filter(
				(id): id is string => typeof id === "string",
			),
			recommendation: c.recommendation,
			staleInformation:
				typeof c.staleInformation === "string" ? c.staleInformation : undefined,
		});
	}

	if (conflicts.length === 0) return null;

	return {
		hasConflict: true,
		conflicts,
		reasoning: obj.reasoning as string,
	};
}

// ── ConflictDetector ───────────────────────────────────────────────────────

/**
 * Detects and records conflicts between agent activities.
 *
 * The ConflictDetector operates on two levels:
 *
 * ## Level 1: Structural detection (no LLM cost)
 *
 * Detects conflicts purely from data available in the ContextTracker:
 * - **File overlaps**: Two agents writing to the same file path
 * - **Stale shares**: A file that was shared-about is subsequently rewritten
 *
 * Structural detection is always performed and has zero LLM cost.
 *
 * ## Level 2: Semantic detection (LLM-driven)
 *
 * When `enableSemanticAnalysis` is true, the detector sends a prompt
 * to the SHARING_ANALYZER conversation to evaluate whether a delta
 * creates semantic conflicts with other agents' work.
 *
 * Semantic detection catches subtler conflicts (contradictory assumptions,
 * incompatible API contracts, etc.) but costs tokens per evaluation.
 *
 * ## Lifecycle
 *
 * 1. After each significant delta, `evaluate()` is called
 * 2. Structural checks are performed (file overlaps, stale shares)
 * 3. If enabled, semantic analysis is performed via LLM
 * 4. Detected conflicts are recorded and returned
 * 5. The AgentPool handles alerting affected agents and emitting events
 *
 * ## Integration with other systems
 *
 * - **ORCHESTRATOR** (évolution 16): Conflict records are available to the
 *   orchestrator for its coherenceScore assessment. High-severity conflicts
 *   lower the coherence score.
 * - **StructuredContextInjection** (évolution 08): Conflict alerts are
 *   injected into affected agents with CRITICAL priority and
 *   `coordination_alert` category.
 * - **CheckpointEvaluator** (évolution 15): Conflict count is included
 *   in checkpoint health assessments.
 */
export class ConflictDetector {
	/** Resolved configuration with defaults. */
	private readonly config: Required<ConflictDetectorConfig>;

	/** All detected conflicts in the current execution. */
	private readonly conflicts: ConflictRecord[] = [];

	/** Counter for unique conflict IDs. */
	private _conflictIdCounter = 0;

	/** Running count of evaluations performed. */
	private _evaluationCount = 0;

	/** Running count of structural checks performed. */
	private _structuralCheckCount = 0;

	/** Running count of semantic analyses performed (LLM calls). */
	private _semanticAnalysisCount = 0;

	constructor(
		private readonly conversations: ConversationManager,
		private readonly contextTracker: ContextTracker,
		private readonly logger: pino.Logger,
		config?: ConflictDetectorConfig,
	) {
		this.config = {
			enabled: config?.enabled ?? true,
			enableSemanticAnalysis: config?.enableSemanticAnalysis ?? true,
			minAlertSeverity: config?.minAlertSeverity ?? DEFAULT_MIN_ALERT_SEVERITY,
			maxConflicts: config?.maxConflicts ?? DEFAULT_MAX_CONFLICTS,
		};
	}

	// ── Public API ─────────────────────────────────────────────────────

	/**
	 * Evaluates a context delta for potential conflicts with other agents.
	 *
	 * Performs structural checks first (zero LLM cost), then optionally
	 * runs semantic analysis if enabled.
	 *
	 * @param delta - The delta to evaluate.
	 * @param broker - The information broker (for sharing history).
	 * @returns An array of detected conflicts (may be empty).
	 */
	async evaluate(
		delta: ContextDelta,
		broker: InformationBroker | null,
	): Promise<ConflictRecord[]> {
		if (!this.config.enabled) return [];

		// Pre-filter: only check conflict-triggering delta types
		if (!CONFLICT_TRIGGERING_DELTA_TYPES.has(delta.type)) return [];

		// Pre-filter: skip low-significance deltas
		if (delta.significance < MIN_CONFLICT_CHECK_SIGNIFICANCE) return [];

		// Pre-filter: need at least 2 agents for conflicts
		if (this.contextTracker.agentCount < 2) return [];

		this._evaluationCount++;

		const newConflicts: ConflictRecord[] = [];

		// ── Level 1: Structural detection ──────────────────────────
		const structuralConflicts = this.detectStructuralConflicts(delta, broker);
		this._structuralCheckCount++;
		newConflicts.push(...structuralConflicts);

		// ── Level 2: Semantic detection (optional) ─────────────────
		if (this.config.enableSemanticAnalysis && newConflicts.length === 0) {
			// Only run semantic analysis if no structural conflicts were found.
			// Structural conflicts are definitive — no need for LLM confirmation.
			// Semantic analysis catches the subtler cases that structural checks miss.
			const semanticConflicts = await this.detectSemanticConflicts(
				delta,
				broker,
			);
			newConflicts.push(...semanticConflicts);
		}

		// Store and enforce limits
		for (const conflict of newConflicts) {
			if (this.conflicts.length >= this.config.maxConflicts) {
				// Evict the oldest resolved conflict, or the oldest overall
				const resolvedIndex = this.conflicts.findIndex((c) => c.resolved);
				if (resolvedIndex >= 0) {
					this.conflicts.splice(resolvedIndex, 1);
				} else {
					this.conflicts.shift();
				}
			}
			this.conflicts.push(conflict);
		}

		if (newConflicts.length > 0) {
			this.logger.info(
				{
					sourceAgentId: delta.agentId,
					deltaType: delta.type,
					conflictCount: newConflicts.length,
					types: newConflicts.map((c) => c.type),
					severities: newConflicts.map((c) => c.severity),
				},
				`${newConflicts.length} conflict(s) detected from ${delta.agentName}`,
			);
		}

		return newConflicts;
	}

	/**
	 * Marks a conflict as resolved (alert sent to affected agents).
	 *
	 * @param conflictId - The conflict to mark as resolved.
	 */
	markResolved(conflictId: string): void {
		const conflict = this.conflicts.find((c) => c.id === conflictId);
		if (conflict) {
			conflict.resolved = true;
		}
	}

	/**
	 * Returns all conflicts that should trigger alerts (severity >= threshold
	 * and not yet resolved).
	 */
	getUnresolvedAlerts(): readonly ConflictRecord[] {
		return this.conflicts.filter(
			(c) => !c.resolved && c.severity >= this.config.minAlertSeverity,
		);
	}

	// ── Query ──────────────────────────────────────────────────────────

	/** All detected conflicts. */
	getAllConflicts(): readonly ConflictRecord[] {
		return [...this.conflicts];
	}

	/** Total number of conflicts detected. */
	get conflictCount(): number {
		return this.conflicts.length;
	}

	/** Total evaluations performed. */
	get evaluationCount(): number {
		return this._evaluationCount;
	}

	/** Total structural checks performed. */
	get structuralCheckCount(): number {
		return this._structuralCheckCount;
	}

	/** Total semantic analysis (LLM) calls performed. */
	get semanticAnalysisCount(): number {
		return this._semanticAnalysisCount;
	}

	/** Whether conflict detection is enabled. */
	get isEnabled(): boolean {
		return this.config.enabled;
	}

	/** Number of unresolved high-severity conflicts. */
	get unresolvedHighSeverityCount(): number {
		return this.conflicts.filter((c) => !c.resolved && c.severity >= 0.7)
			.length;
	}

	/**
	 * Returns a summary suitable for inclusion in checkpoint or
	 * orchestrator prompts.
	 */
	getSummary(): string | null {
		if (this.conflicts.length === 0) return null;

		const unresolved = this.conflicts.filter((c) => !c.resolved);
		const highSeverity = unresolved.filter((c) => c.severity >= 0.7);

		const lines: string[] = [
			"## Conflict Summary",
			`- Total detected: ${this.conflicts.length}`,
			`- Unresolved: ${unresolved.length}`,
			`- High severity (≥0.7): ${highSeverity.length}`,
		];

		if (highSeverity.length > 0) {
			lines.push("", "### High Severity Conflicts");
			for (const c of highSeverity.slice(0, 5)) {
				lines.push(`- [${c.type}] ${c.description}`);
			}
		}

		return lines.join("\n");
	}

	// ── Lifecycle ──────────────────────────────────────────────────────

	/** Resets all state for a new execution. */
	reset(): void {
		this.conflicts.length = 0;
		this._conflictIdCounter = 0;
		this._evaluationCount = 0;
		this._structuralCheckCount = 0;
		this._semanticAnalysisCount = 0;
	}

	// ── Private: Structural Detection ──────────────────────────────────

	/**
	 * Detects structural conflicts from data available in the ContextTracker.
	 *
	 * Zero LLM cost — purely data-driven.
	 */
	private detectStructuralConflicts(
		delta: ContextDelta,
		broker: InformationBroker | null,
	): ConflictRecord[] {
		const conflicts: ConflictRecord[] = [];

		// ── File overlap detection ─────────────────────────────────
		if (delta.type === DeltaType.FILE_WRITTEN) {
			const filePath = delta.data.path as string | undefined;
			if (filePath) {
				const fileOverlapConflicts = this.detectFileOverlaps(
					delta.agentId,
					delta.agentName,
					filePath,
				);
				conflicts.push(...fileOverlapConflicts);
			}
		}

		// ── Stale share detection ──────────────────────────────────
		if (broker && delta.type === DeltaType.FILE_WRITTEN) {
			const filePath = delta.data.path as string | undefined;
			if (filePath) {
				const staleConflicts = this.detectStaleShares(
					delta.agentId,
					delta.agentName,
					filePath,
					broker,
				);
				conflicts.push(...staleConflicts);
			}
		}

		return conflicts;
	}

	/**
	 * Checks if a file was already written by another agent.
	 */
	private detectFileOverlaps(
		sourceAgentId: string,
		sourceAgentName: string,
		filePath: string,
	): ConflictRecord[] {
		const conflicts: ConflictRecord[] = [];
		const otherStates = this.contextTracker.getOtherAgentStates(sourceAgentId);

		for (const other of otherStates) {
			if (other.completed) continue; // Completed agents are not affected

			if (other.filesWritten.includes(filePath)) {
				// Check if we already have a conflict for this exact file + agents pair
				const existing = this.conflicts.find(
					(c) =>
						c.type === "file_overlap" &&
						c.filePath === filePath &&
						((c.sourceAgentId === sourceAgentId &&
							c.affectedAgentIds.includes(other.agentId)) ||
							(c.sourceAgentId === other.agentId &&
								c.affectedAgentIds.includes(sourceAgentId))),
				);

				if (existing) continue; // Already detected

				this._conflictIdCounter++;
				conflicts.push({
					id: `conflict-${this._conflictIdCounter}`,
					type: "file_overlap",
					severity: 0.8, // File overlaps are high severity by default
					description:
						`File "${filePath}" was written by both ${sourceAgentName} and ${other.agentName}. ` +
						`The later write (by ${sourceAgentName}) may have overwritten or conflicted with ` +
						`${other.agentName}'s version.`,
					sourceAgentId,
					sourceAgentName,
					affectedAgentIds: [other.agentId],
					filePath,
					recommendation:
						`Alert ${other.agentName} that "${filePath}" has been modified by ${sourceAgentName}. ` +
						`${other.agentName} should verify their work is still consistent with the updated file.`,
					timestamp: isoNow(),
					resolved: false,
				});
			}
		}

		return conflicts;
	}

	/**
	 * Checks if a file write invalidates previously shared information.
	 *
	 * If agent A shared info about file X with agent B, and agent A
	 * subsequently rewrites file X, the shared info may be stale.
	 */
	private detectStaleShares(
		sourceAgentId: string,
		sourceAgentName: string,
		filePath: string,
		broker: InformationBroker,
	): ConflictRecord[] {
		const conflicts: ConflictRecord[] = [];

		// Check if any sharing records reference this file
		// The sharing history is indexed by target agent
		const otherStates = this.contextTracker.getOtherAgentStates(sourceAgentId);

		for (const other of otherStates) {
			if (other.completed) continue;

			// Get what was shared FROM the source TO this target
			const previousShares = broker.getRecentSharingsForTarget(other.agentId);

			for (const share of previousShares) {
				if (share.sourceAgentId !== sourceAgentId) continue;

				// Check if the share mentions the file path
				const fileName = filePath.split("/").pop() ?? "";
				const mentionsFile =
					share.informationSummary.includes(filePath) ||
					(fileName.length > 0 && share.informationSummary.includes(fileName));

				if (!mentionsFile) continue;

				// Check if this is a new write (not the same event that triggered the share)
				// We detect staleness by seeing that the file was written AGAIN after sharing
				const alreadyDetected = this.conflicts.find(
					(c) =>
						c.type === "stale_share" &&
						c.filePath === filePath &&
						c.sourceAgentId === sourceAgentId &&
						c.affectedAgentIds.includes(other.agentId),
				);

				if (alreadyDetected) continue;

				this._conflictIdCounter++;
				conflicts.push({
					id: `conflict-${this._conflictIdCounter}`,
					type: "stale_share",
					severity: 0.7,
					description:
						`${sourceAgentName} modified "${filePath}" after information about it was shared ` +
						`with ${other.agentName}. The previously shared information may now be stale.`,
					sourceAgentId,
					sourceAgentName,
					affectedAgentIds: [other.agentId],
					filePath,
					staleInformation: share.informationSummary,
					recommendation:
						`Re-share updated information about "${filePath}" with ${other.agentName}. ` +
						`The previously shared info was: "${share.informationSummary.slice(0, 150)}".`,
					timestamp: isoNow(),
					resolved: false,
				});
			}
		}

		return conflicts;
	}

	// ── Private: Semantic Detection ────────────────────────────────────

	/**
	 * Uses the LLM to detect semantic conflicts that structural checks miss.
	 *
	 * Sends a one-shot prompt to the SHARING_ANALYZER conversation with
	 * the delta context and other agents' states.
	 */
	private async detectSemanticConflicts(
		delta: ContextDelta,
		broker: InformationBroker | null,
	): Promise<ConflictRecord[]> {
		this._semanticAnalysisCount++;

		const sourceState = this.contextTracker.getAgentState(delta.agentId);
		if (!sourceState) return [];

		const otherAgents = this.contextTracker
			.getOtherAgentStates(delta.agentId)
			.filter((s) => !s.completed && s.status !== "destroyed");

		if (otherAgents.length === 0) return [];

		// Build file overlap data for the prompt
		const fileOverlaps = this.buildFileOverlapData(delta.agentId);

		// Get sharing history
		const previouslySharedToSource = broker
			? this.getSharingsToAgent(delta.agentId, broker)
			: [];
		const previouslySharedFromSource = broker
			? this.getSharingsFromAgent(delta.agentId, broker)
			: [];

		const prompt = conflictAnalysisPrompt({
			sourceAgent: {
				agentName: sourceState.agentName,
				taskRole: sourceState.taskRole,
			},
			eventType: delta.type,
			eventSummary: delta.summary,
			filePath: (delta.data.path as string | undefined) ?? null,
			eventData: delta.data,
			otherAgents: otherAgents.map((s) => ({
				agentName: s.agentName,
				taskRole: s.taskRole,
				taskDescription: s.taskDescription,
				status: s.status,
				completed: s.completed,
				filesWritten: s.filesWritten,
				filesRead: s.filesRead,
			})),
			previouslySharedToSource:
				previouslySharedToSource.length > 0 ? previouslySharedToSource : null,
			previouslySharedFromSource:
				previouslySharedFromSource.length > 0
					? previouslySharedFromSource
					: null,
			fileOverlaps: fileOverlaps.length > 0 ? fileOverlaps : null,
		});

		try {
			const result = await this.conversations.sendOneShotJson(
				ConversationRole.SHARING_ANALYZER,
				prompt,
				validateConflictAnalysisResponse,
				{ maxTokens: 500, maxJsonAttempts: 2 },
			);

			if (!result || !result.hasConflict || !result.conflicts) {
				this.logger.debug(
					{ agentId: delta.agentId, deltaType: delta.type },
					"Semantic analysis: no conflict detected",
				);
				return [];
			}

			// Convert LLM response to ConflictRecords
			return result.conflicts.map((c) => {
				this._conflictIdCounter++;
				return {
					id: `conflict-${this._conflictIdCounter}`,
					type: c.type as ConflictType,
					severity: c.severity,
					description: c.description,
					sourceAgentId: delta.agentId,
					sourceAgentName: delta.agentName,
					affectedAgentIds: c.affectedAgentIds,
					filePath: (delta.data.path as string | undefined) ?? undefined,
					staleInformation: c.staleInformation,
					recommendation: c.recommendation,
					timestamp: isoNow(),
					resolved: false,
				};
			});
		} catch (error) {
			this.logger.warn(
				{ error: toErrorMessage(error) },
				"Semantic conflict analysis failed — skipping",
			);
			return [];
		}
	}

	// ── Private: Helpers ───────────────────────────────────────────────

	/**
	 * Builds file overlap data: files that have been written by multiple agents.
	 */
	private buildFileOverlapData(
		_currentAgentId: string,
	): Array<{ filePath: string; agents: string[] }> {
		const fileToAgents = new Map<string, Set<string>>();

		for (const state of this.contextTracker.getAllAgentStates()) {
			for (const file of state.filesWritten) {
				let agents = fileToAgents.get(file);
				if (!agents) {
					agents = new Set();
					fileToAgents.set(file, agents);
				}
				agents.add(state.agentName);
			}
		}

		// Return only files with 2+ writers
		const overlaps: Array<{ filePath: string; agents: string[] }> = [];
		for (const [filePath, agents] of fileToAgents) {
			if (agents.size >= 2) {
				overlaps.push({ filePath, agents: [...agents] });
			}
		}

		return overlaps;
	}

	/**
	 * Gets sharing records where the target is the specified agent.
	 */
	private getSharingsToAgent(
		agentId: string,
		broker: InformationBroker,
	): Array<{
		deltaType: string;
		sourceAgentName: string;
		informationSummary: string;
	}> {
		const records = broker.getRecentSharingsForTarget(agentId, 5);
		return records.map((r) => {
			const sourceName =
				this.contextTracker.getAgentState(r.sourceAgentId)?.agentName ??
				"unknown";
			return {
				deltaType: r.deltaType,
				sourceAgentName: sourceName,
				informationSummary: r.informationSummary,
			};
		});
	}

	/**
	 * Gets sharing records where the source is the specified agent.
	 */
	private getSharingsFromAgent(
		agentId: string,
		broker: InformationBroker,
	): Array<{
		deltaType: string;
		targetAgentName: string;
		informationSummary: string;
	}> {
		// We need to check all agents' sharing histories for records from this source
		const results: Array<{
			deltaType: string;
			targetAgentName: string;
			informationSummary: string;
		}> = [];

		for (const state of this.contextTracker.getAllAgentStates()) {
			if (state.agentId === agentId) continue;

			const records = broker.getRecentSharingsForTarget(state.agentId, 10);
			for (const r of records) {
				if (r.sourceAgentId === agentId) {
					results.push({
						deltaType: r.deltaType,
						targetAgentName: state.agentName,
						informationSummary: r.informationSummary,
					});
				}
			}
		}

		return results.slice(0, 5);
	}
}
