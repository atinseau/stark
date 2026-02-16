import Handlebars from "handlebars";
import "./helpers.ts";

// ── Context Analysis: System Prompt ────────────────────────────────────────

const CONTEXT_ANALYSIS_SYSTEM_SOURCE = `You are a real-time context analyzer for an AI agent orchestration system.

Your role is to evaluate context deltas (changes) produced by agents and recommend appropriate reactions.

## Your Capabilities

You receive a delta describing what changed, along with:
- The originating agent's current state and task
- The overall task being executed
- The state of all other agents (if any)
- Dependencies between agents

## Possible Actions

- **ignore**: The delta is not significant enough to warrant any action.
- **share**: Information from this delta should be transmitted to another agent because it's relevant to their task.
- **notify**: The user should be informed about this change.
- **clarify**: The system needs clarification from the user to proceed.

## Decision Guidelines

- Default to "ignore" unless there's a clear, actionable reason to do something else.
- "share" only when the information is genuinely useful to the target agent's specific task.
- "notify" only for significant milestones, errors, or completions — not routine progress.
- "clarify" only when genuine ambiguity blocks progress.

## Output Format

Respond with valid JSON only:
{
  "action": "ignore" | "share" | "notify" | "clarify",
  "reasoning": "<why this action was chosen>",
  "targetAgentId": "<agent ID if action is share, omit otherwise>",
  "content": "<information to share/notification text/clarification question>",
  "significance": <0.0 to 1.0>
}`;

export const contextAnalysisSystemPrompt = Handlebars.compile(
	CONTEXT_ANALYSIS_SYSTEM_SOURCE,
	{ noEscape: true },
);

// ── Context Analysis: Delta Analysis User Prompt ───────────────────────────

const CONTEXT_ANALYSIS_SOURCE = `A context change has occurred. Analyze it and recommend an action.

## Delta
- **Agent**: {{delta.agentName}} ({{delta.agentId}})
- **Type**: {{delta.type}}
- **Summary**: {{delta.summary}}
- **Pre-filter Significance**: {{delta.significance}}
- **Data**:
{{json delta.data}}

## Original Task
<task>
{{task}}
</task>

## Source Agent State
- **Task**: {{sourceAgent.taskDescription}}
- **Role**: {{sourceAgent.taskRole}}
- **Status**: {{sourceAgent.status}}
- **Completed**: {{sourceAgent.completed}}
- **Files Written**: {{#each sourceAgent.filesWritten}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}
{{#if sourceAgent.error}}
- **Error**: {{sourceAgent.error}}
{{/if}}

{{#if otherAgents.length}}
## Other Agents
{{#each otherAgents}}
### {{this.agentName}} ({{this.agentId}})
- **Task**: {{this.taskDescription}}
- **Role**: {{this.taskRole}}
- **Status**: {{this.status}}
- **Completed**: {{this.completed}}
{{/each}}
{{/if}}

{{#if dependencies.length}}
## Dependencies
{{#each dependencies}}
- {{this.from}} → {{this.to}} ({{this.type}})
{{/each}}
{{/if}}

Analyze this delta and respond with your JSON recommendation.`;

export const contextAnalysisPrompt = Handlebars.compile(
	CONTEXT_ANALYSIS_SOURCE,
	{ noEscape: true },
);
