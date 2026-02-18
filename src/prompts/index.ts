export { batchedSharingDecisionPrompt } from "./batched-sharing-decision.ts";
export {
	checkpointPrompt,
	checkpointSystemPrompt,
} from "./checkpoint.ts";
export {
	contextAnalysisPrompt,
	contextAnalysisSystemPrompt,
	sharingAnalysisSystemPrompt,
} from "./context-analysis.ts";
export {
	intentAnalysisPrompt,
	intentAnalysisSystemPrompt,
} from "./intent-analysis.ts";
export { notificationDecisionPrompt } from "./notification-decision.ts";
export {
	orchestratorEvaluationPrompt,
	orchestratorSystemPrompt,
} from "./orchestrator.ts";
export {
	planningSystemPrompt,
	replanPrompt,
	taskAnalysisPrompt,
} from "./planning.ts";
export { sharingDecisionPrompt } from "./sharing-decision.ts";
export { summaryPrompt, summarySystemPrompt } from "./summary.ts";

// ── Template Index ─────────────────────────────────────────────────────────

import { batchedSharingDecisionPrompt } from "./batched-sharing-decision.ts";
import { checkpointPrompt, checkpointSystemPrompt } from "./checkpoint.ts";
import {
	contextAnalysisPrompt,
	contextAnalysisSystemPrompt,
	sharingAnalysisSystemPrompt,
} from "./context-analysis.ts";
import {
	intentAnalysisPrompt,
	intentAnalysisSystemPrompt,
} from "./intent-analysis.ts";
import { notificationDecisionPrompt } from "./notification-decision.ts";
import {
	orchestratorEvaluationPrompt,
	orchestratorSystemPrompt,
} from "./orchestrator.ts";
import {
	planningSystemPrompt,
	replanPrompt,
	taskAnalysisPrompt,
} from "./planning.ts";
import { sharingDecisionPrompt } from "./sharing-decision.ts";
import { summaryPrompt, summarySystemPrompt } from "./summary.ts";

/**
 * All compiled Handlebars templates used by the AgentPool system.
 *
 * Each template is pre-compiled at module load time for performance.
 * Templates use `noEscape: true` to prevent HTML entity encoding,
 * which is unnecessary for LLM prompts and would corrupt code snippets.
 */
export const templates = {
	// Planning
	planningSystem: planningSystemPrompt,
	taskAnalysis: taskAnalysisPrompt,
	replan: replanPrompt,

	// Context analysis (notifications)
	contextAnalysisSystem: contextAnalysisSystemPrompt,
	contextAnalysis: contextAnalysisPrompt,

	// Sharing analysis (cross-agent)
	sharingAnalysisSystem: sharingAnalysisSystemPrompt,

	// Information sharing
	sharingDecision: sharingDecisionPrompt,
	batchedSharingDecision: batchedSharingDecisionPrompt,

	// Notifications
	notificationDecision: notificationDecisionPrompt,

	// Intent analysis
	intentAnalysisSystem: intentAnalysisSystemPrompt,
	intentAnalysis: intentAnalysisPrompt,

	// Checkpoint evaluation
	checkpointSystem: checkpointSystemPrompt,
	checkpoint: checkpointPrompt,

	// Orchestrator (meta-reflection)
	orchestratorSystem: orchestratorSystemPrompt,
	orchestratorEvaluation: orchestratorEvaluationPrompt,

	// Execution summary
	summarySystem: summarySystemPrompt,
	summary: summaryPrompt,
} as const;
