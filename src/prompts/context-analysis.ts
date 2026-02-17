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

## Examples

### Example 1: Ignore — low-value routine delta
Agent "api-dev" read file package.json.
{
  "action": "ignore",
  "reasoning": "Reading a config file is routine exploration. No action needed.",
  "significance": 0.1
}

### Example 2: Share — output relevant to another agent
Agent "api-dev" completed implementing the users REST API with all CRUD endpoints.
Another agent "test-writer" is working on writing tests for the API.
{
  "action": "share",
  "reasoning": "The test writer needs the API structure to write accurate tests. The implementation details are directly relevant.",
  "targetAgentId": "agent-test-writer-id",
  "content": "Users API implemented in src/routes/users.ts with GET/POST/PUT/DELETE /users endpoints. User model: {id, name, email, createdAt}.",
  "significance": 0.8
}

### Example 3: Notify — critical error requiring attention
Agent "deploy-agent" encountered error: permission denied writing to /etc/nginx/conf.d/.
{
  "action": "notify",
  "reasoning": "Permission error on system directory — agent cannot proceed without user intervention.",
  "content": "Agent deploy-agent hit a permission error writing to /etc/nginx/conf.d/. Manual intervention may be needed.",
  "significance": 1.0
}

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
