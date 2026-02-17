import Handlebars from "handlebars";
import "./helpers.ts";

// ── Context Analysis: System Prompt ────────────────────────────────────────

const CONTEXT_ANALYSIS_SYSTEM_SOURCE = `You are a real-time context analyzer for an AI agent orchestration system.

Evaluate context deltas (changes) from agents and recommend actions.

You receive: a delta describing what changed, the originating agent's state/task, the overall task, other agents' states, and dependencies.

## Actions
- **ignore**: Delta not significant enough for action (default).
- **share**: Information should be sent to another agent because it's relevant to their task.
- **notify**: User should be informed (only for significant milestones, errors, or completions).
- **clarify**: System needs user clarification to proceed.

## JSON Output
{
  "action": "ignore" | "share" | "notify" | "clarify",
  "reasoning": "<why>",
  "targetAgentId": "<agent ID if share>",
  "content": "<info to share/notification/question>",
  "significance": <0.0-1.0>
}`;

export const contextAnalysisSystemPrompt = Handlebars.compile(
	CONTEXT_ANALYSIS_SYSTEM_SOURCE,
	{ noEscape: true },
);

// ── Context Analysis: Delta Analysis User Prompt ───────────────────────────

const CONTEXT_ANALYSIS_SOURCE = `Analyze this context change and recommend an action.

## Delta
- **Agent**: {{delta.agentName}} ({{delta.agentId}})
- **Type**: {{delta.type}}
- **Summary**: {{delta.summary}}
- **Significance**: {{delta.significance}}
- **Data**:
{{json delta.data}}

## Original Task
<task>
{{task}}
</task>

## Source Agent
- **Task**: {{sourceAgent.taskDescription}}
- **Role**: {{sourceAgent.taskRole}}
- **Status**: {{sourceAgent.status}}
- **Completed**: {{sourceAgent.completed}}
- **Files Written**: {{#each sourceAgent.filesWritten}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}
{{#if sourceAgent.error}}- **Error**: {{sourceAgent.error}}
{{/if}}

{{#if otherAgents.length}}
## Other Agents
{{#each otherAgents}}
### {{this.agentName}} ({{this.agentId}})
- **Task**: {{this.taskDescription}} | **Role**: {{this.taskRole}} | **Status**: {{this.status}} | **Completed**: {{this.completed}}
{{/each}}
{{/if}}

{{#if dependencies.length}}
## Dependencies
{{#each dependencies}}
- {{this.from}} → {{this.to}} ({{this.type}})
{{/each}}
{{/if}}

Respond with JSON recommendation.`;

export const contextAnalysisPrompt = Handlebars.compile(
	CONTEXT_ANALYSIS_SOURCE,
	{ noEscape: true },
);
