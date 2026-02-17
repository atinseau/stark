import Handlebars from "handlebars";
import "./helpers.ts";

// ── Notification Decision: User Prompt ─────────────────────────────────────

const NOTIFICATION_DECISION_SOURCE = `This context delta has already passed significance ({{delta.significance}} ≥ threshold) and type filters. Your job is purely semantic: decide if this event is genuinely worth interrupting the user for, or if it's routine noise that passed the numeric filters but lacks real informational value.

{{#if decisionJournal}}
## Your Recent Notification Decisions
These are your most recent decisions in this execution. Maintain consistency and avoid notification fatigue — if you've already notified about similar events recently, be more selective.

{{decisionJournal}}

{{#if recentNotificationCount}}
⚠️ You have sent {{recentNotificationCount}} notification(s) in the last 60 seconds. Be increasingly selective to avoid overwhelming the user.
{{/if}}
{{/if}}

## What Happened
**Agent**: {{delta.agentName}} (role: {{delta.agentRole}})
**Event**: {{delta.type}} — {{delta.summary}}
**Significance**: {{delta.significance}}

## Agent's Task
{{agentTask}}

{{#if otherAgentsContext}}
## Broader Context
{{otherAgentsContext}}
{{/if}}

## Decision Guide
Notify ONLY if this event represents:
- A meaningful milestone (subtask completion, all tests passing)
- An error the user should know about (missing dependency, permission issue, repeated failures)
- An unexpected or concerning outcome
- The final completion of the overall task or a major phase

Do NOT notify for:
- Routine progress that the user would expect
- Events the agent is handling autonomously
- Intermediate steps in a larger process

## Examples

### Notify: Significant milestone
Delta: Agent "api-developer" completed all API endpoints successfully. Significance: 0.9.
{
  "shouldNotify": true,
  "reasoning": "The API implementation is a major milestone that the user likely wants to know about — it represents completion of a significant portion of the task.",
  "message": "✅ api-developer has finished implementing all REST API endpoints (users CRUD + products CRUD)."
}

### Don't notify: Routine progress
Delta: Agent "test-writer" read file src/routes/users.ts. Significance: 0.5.
{
  "shouldNotify": false,
  "reasoning": "Reading a file is routine agent behavior. Notifying about every file read would be excessive noise.",
  "message": ""
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
  "reasoning": "<concise explanation of why this is or isn't worth the user's attention>",
  "message": "<clear, human-friendly notification — required if shouldNotify is true, empty string if false>"
}`;

export const notificationDecisionPrompt = Handlebars.compile(
	NOTIFICATION_DECISION_SOURCE,
	{ noEscape: true },
);
