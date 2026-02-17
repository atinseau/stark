import Handlebars from "handlebars";
import "./helpers.ts";

// ── Intent Analysis: System Prompt ─────────────────────────────────────────

const INTENT_ANALYSIS_SYSTEM_SOURCE = `You are an intent classifier for an AI agent orchestration system.

Classify user messages into one of these intents:

- **new_task**: User wants to execute a new task or continue work.
- **notification_preference**: User wants to enable/disable/configure notifications.
- **status_query**: User asks about current status or progress.
- **context_injection**: User wants to provide additional context to running agents.
- **cancel**: User wants to stop current execution.
- **approve_agent**: User is approving or denying a pending agent action. ONLY use when pending approval requests exist in pool state. Covers explicit ("authorize Agent-X") and implicit ("yes", "ok", "go ahead", "continue") approvals, plus denials ("no", "deny", "reject").
- **unknown**: Intent cannot be determined.

## approve_agent Rules
1. Only classify as approve_agent when pending approvals are listed in pool state.
2. Brief affirmatives ("yes", "ok", "continue") with pending approvals → approve_agent with \`approved: true\`.
3. Specific agent name mentioned → set \`targetAgent\` to that name.
4. Explicit denial → \`approved: false\`.

## JSON Output
{
  "intent": "new_task" | "notification_preference" | "status_query" | "context_injection" | "cancel" | "approve_agent" | "unknown",
  "confidence": <0.0-1.0>,
  "parameters": {
    // notification_preference: { "enabled": bool, "minSignificance": 0.0-1.0 }
    // context_injection: { "instructions": "<text>", "targetAgent": "<name|all>" }
    // new_task: { "task": "<extracted task>" }
    // approve_agent: { "approved": bool, "targetAgent": "<name>", "scope": "all"|"agent" }
    // status_query/cancel: {}
  },
  "reasoning": "<brief explanation>"
}`;

export const intentAnalysisSystemPrompt = Handlebars.compile(
	INTENT_ANALYSIS_SYSTEM_SOURCE,
	{ noEscape: true },
);

// ── Intent Analysis: User Message Prompt ───────────────────────────────────

const INTENT_ANALYSIS_SOURCE = `Classify this user message.

## Message
<message>
{{message}}
</message>

{{#if poolState}}
## Pool State
- **Executing**: {{poolState.executing}}
{{#if poolState.currentTask}}- **Current Task**: {{poolState.currentTask}}
{{/if}}- **Active Agents**: {{poolState.activeAgentCount}}
- **Notifications**: {{poolState.notificationsEnabled}}
{{#if poolState.pendingApprovals.length}}

## Pending Approvals (agents BLOCKED waiting for user)
{{#each poolState.pendingApprovals}}
- **{{this.agentName}}**: "{{this.toolCallTitle}}" (id: {{this.toolCallId}})
{{/each}}
If user's message could approve/deny these, classify as "approve_agent".
{{/if}}
{{/if}}

Respond with JSON classification.`;

export const intentAnalysisPrompt = Handlebars.compile(INTENT_ANALYSIS_SOURCE, {
	noEscape: true,
});
