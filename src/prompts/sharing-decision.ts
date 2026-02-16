import Handlebars from "handlebars";
import "./helpers.ts";

// ── Sharing Decision: User Prompt ──────────────────────────────────────────

const SHARING_DECISION_SOURCE = `An agent has produced output that may be relevant to another agent. Determine if the information should be shared.

## Source Agent
- **Name**: {{sourceAgent.agentName}} ({{sourceAgent.agentId}})
- **Task**: {{sourceAgent.taskDescription}}
- **Role**: {{sourceAgent.taskRole}}
- **Status**: {{sourceAgent.status}}

## Delta (the new information)
- **Type**: {{delta.type}}
- **Summary**: {{delta.summary}}
- **Data**:
{{json delta.data}}

## Target Agent
- **Name**: {{targetAgent.agentName}} ({{targetAgent.agentId}})
- **Task**: {{targetAgent.taskDescription}}
- **Role**: {{targetAgent.taskRole}}
- **Status**: {{targetAgent.status}}
- **Completed**: {{targetAgent.completed}}

{{#if dependency}}
## Dependency Relationship
- **From**: {{dependency.from}}
- **To**: {{dependency.to}}
- **Type**: {{dependency.type}}
{{/if}}

## Decision Criteria

1. Is this information genuinely useful for the target agent's specific task?
2. Would sharing this information help the target produce better output?
3. Is the target agent in a state where it can use this information (not completed/destroyed)?
4. Is the information concrete enough to be actionable?

Respond with valid JSON only:
{
  "shouldShare": true | false,
  "reasoning": "<why sharing is or isn't beneficial>",
  "information": "<distilled information to inject into the target agent's context, if shouldShare is true>"
}`;

export const sharingDecisionPrompt = Handlebars.compile(
	SHARING_DECISION_SOURCE,
	{ noEscape: true },
);
