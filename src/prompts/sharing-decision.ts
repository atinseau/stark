import Handlebars from "handlebars";
import "./helpers.ts";

// ── Sharing Decision: User Prompt ──────────────────────────────────────────

const SHARING_DECISION_SOURCE = `Determine if information from one agent should be shared with another.

## Source Agent
- **Name**: {{sourceAgent.agentName}} ({{sourceAgent.agentId}})
- **Task**: {{sourceAgent.taskDescription}}
- **Role**: {{sourceAgent.taskRole}} | **Status**: {{sourceAgent.status}}

## Delta (new information)
- **Type**: {{delta.type}}
- **Summary**: {{delta.summary}}
- **Data**:
{{json delta.data}}

## Target Agent
- **Name**: {{targetAgent.agentName}} ({{targetAgent.agentId}})
- **Task**: {{targetAgent.taskDescription}}
- **Role**: {{targetAgent.taskRole}} | **Status**: {{targetAgent.status}} | **Completed**: {{targetAgent.completed}}

{{#if dependency}}
## Dependency
- {{dependency.from}} → {{dependency.to}} ({{dependency.type}})
{{/if}}

## Criteria
1. Is this genuinely useful for the target agent's specific task?
2. Would it help the target produce better output?
3. Is the target in a state where it can use this (not completed/destroyed)?
4. Is the information concrete and actionable?

## JSON Output
{
  "shouldShare": true | false,
  "reasoning": "<why>",
  "information": "<distilled info to inject into target agent, if shouldShare>"
}`;

export const sharingDecisionPrompt = Handlebars.compile(
	SHARING_DECISION_SOURCE,
	{ noEscape: true },
);
