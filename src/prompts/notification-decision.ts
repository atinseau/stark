import Handlebars from "handlebars";
import "./helpers.ts";

// ── Notification Decision: User Prompt ─────────────────────────────────────

const NOTIFICATION_DECISION_SOURCE = `A context change occurred in the agent pool. Determine if the user should be notified.

## User Notification Preference
- **Enabled**: {{preference.enabled}}
- **Minimum Significance**: {{preference.minSignificance}}
{{#if preference.types}}
- **Interested In**: {{#each preference.types}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}
{{/if}}

## Delta
- **Agent**: {{delta.agentName}} ({{delta.agentId}})
- **Type**: {{delta.type}}
- **Summary**: {{delta.summary}}
- **Significance**: {{delta.significance}}

## Agent's Task
{{agentTask}}

## Decision Criteria

1. Does the delta meet the user's minimum significance threshold?
2. If the user specified interested types, does this delta match?
3. Is this notification genuinely useful vs. noise?
4. Craft a concise, informative notification message if warranted.

Respond with valid JSON only:
{
  "shouldNotify": true | false,
  "reasoning": "<why the user should or shouldn't be notified>",
  "message": "<the notification message, if shouldNotify is true>"
}`;

export const notificationDecisionPrompt = Handlebars.compile(
	NOTIFICATION_DECISION_SOURCE,
	{ noEscape: true },
);
