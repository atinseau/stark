import Handlebars from "handlebars";
import "./helpers.ts";

// ── Notification Decision: User Prompt ─────────────────────────────────────

const NOTIFICATION_DECISION_SOURCE = `Determine if the user should be notified about this agent pool context change.

## User Preference
- **Enabled**: {{preference.enabled}}
- **Min Significance**: {{preference.minSignificance}}
{{#if preference.types}}- **Interested Types**: {{#each preference.types}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}
{{/if}}

## Delta
- **Agent**: {{delta.agentName}} ({{delta.agentId}})
- **Type**: {{delta.type}}
- **Summary**: {{delta.summary}}
- **Significance**: {{delta.significance}}

## Agent Task
{{agentTask}}

## Criteria
1. Does delta meet minimum significance?
2. Does delta type match user's interests (if specified)?
3. Is this genuinely useful vs. noise?

## Examples

### Notify: Significant milestone
Delta: Agent "api-developer" completed all API endpoints successfully. Significance: 0.9.
{
  "shouldNotify": true,
  "reasoning": "The API implementation is a major milestone that the user likely wants to know about — it represents completion of a significant portion of the task.",
  "message": "✅ api-developer has finished implementing all REST API endpoints (users CRUD + products CRUD)."
}

### Don't notify: Routine progress
Delta: Agent "test-writer" read file src/routes/users.ts. Significance: 0.1.
{
  "shouldNotify": false,
  "reasoning": "Reading a file is routine agent behavior. Notifying about every file read would be excessive noise."
}

### Notify: Error requiring attention
Delta: Agent "api-developer" encountered an error — npm package 'pg' not found. Significance: 0.9.
{
  "shouldNotify": true,
  "reasoning": "A missing dependency blocks the agent's progress and may require user intervention to resolve.",
  "message": "⚠️ api-developer hit an error: npm package 'pg' is not installed. The agent may need the dependency added to proceed."
}

## JSON Output
{
  "shouldNotify": true | false,
  "reasoning": "<why>",
  "message": "<notification message if shouldNotify is true>"
}`;

export const notificationDecisionPrompt = Handlebars.compile(
	NOTIFICATION_DECISION_SOURCE,
	{ noEscape: true },
);
