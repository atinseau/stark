import Handlebars from "handlebars";
import "./helpers.ts";

// ── Batched Sharing Decision: User Prompt ──────────────────────────────────

const BATCHED_SHARING_DECISION_SOURCE = `Determine if information from one agent should be shared with other agents.

## Source Agent
- **Name**: {{sourceAgent.agentName}} ({{sourceAgent.agentId}})
- **Task**: {{sourceAgent.taskDescription}}
- **Role**: {{sourceAgent.taskRole}} | **Status**: {{sourceAgent.status}}

## Delta (new information)
- **Type**: {{delta.type}}
- **Summary**: {{delta.summary}}
- **Data**:
{{json delta.data}}

## Target Agents
{{#each targets}}
### Target: {{this.agentName}} ({{this.agentId}})
- **Task**: {{this.taskDescription}}
- **Role**: {{this.taskRole}} | **Status**: {{this.status}} | **Completed**: {{this.completed}}
{{#if this.dependency}}
- **Dependency**: {{this.dependency.from}} → {{this.dependency.to}} ({{this.dependency.type}})
{{/if}}
{{#if this.previouslyShared.length}}
- **Previously shared to this agent** (do NOT re-share redundant information):
{{#each this.previouslyShared}}
  - [{{this.deltaType}}] {{this.informationSummary}}
{{/each}}
{{/if}}

{{/each}}

## Criteria
1. Is this genuinely useful for the target agent's specific task?
2. Would it help the target produce better output?
3. Is the target in a state where it can use this (not completed/destroyed)?
4. Is the information concrete and actionable?
5. Has similar or identical information already been shared to this target? If yes, do NOT re-share — only share genuinely NEW information that adds value beyond what was previously communicated.

## JSON Output
Return one decision per target agent:
{
  "decisions": [
    { "targetAgentId": "<agent ID>", "shouldShare": true | false, "reasoning": "<why>", "information": "<distilled info if shouldShare>" }
  ]
}`;

export const batchedSharingDecisionPrompt = Handlebars.compile(
	BATCHED_SHARING_DECISION_SOURCE,
	{ noEscape: true },
);
