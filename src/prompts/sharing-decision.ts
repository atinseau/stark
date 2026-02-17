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

## Examples

### Share: Relevant new information
Source "backend-dev" completed database schema. Target "api-dev" needs to build endpoints.
{
  "shouldShare": true,
  "reasoning": "The API developer needs the exact schema to implement correct endpoint handlers and validation.",
  "information": "Database schema created: users(id UUID PK, name TEXT NOT NULL, email TEXT UNIQUE, created_at TIMESTAMPTZ). Migration file: db/migrations/001_users.sql."
}

### Don't share: Irrelevant to target's task
Source "frontend-dev" updated CSS styling. Target "test-writer" writes backend tests.
{
  "shouldShare": false,
  "reasoning": "CSS styling changes are purely visual and have no impact on backend test logic. Sharing would be noise."
}

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
