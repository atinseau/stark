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
