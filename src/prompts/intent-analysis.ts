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

## Examples

### Example 1: New task
**Message**: "Create a login page with email and password fields"
**Response**:
{
  "intent": "new_task",
  "confidence": 0.95,
  "parameters": { "task": "Create a login page with email and password fields" },
  "reasoning": "Clear request to build something new."
}

### Example 2: Status query
**Message**: "How's it going?"
**Response**:
{
  "intent": "status_query",
  "confidence": 0.85,
  "parameters": {},
  "reasoning": "Informal progress check."
}

### Example 3: Notification preference
**Message**: "Let me know when the tests finish"
**Response**:
{
  "intent": "notification_preference",
  "confidence": 0.9,
  "parameters": { "enabled": true, "minSignificance": 0.7 },
  "reasoning": "User wants to be notified about task completion."
}

### Example 4: Approval (with pending approvals)
**Message**: "yes"
**Pool state**: 1 pending approval for agent "backend-dev"
**Response**:
{
  "intent": "approve_agent",
  "confidence": 0.9,
  "parameters": { "approved": true, "scope": "all" },
  "reasoning": "Short affirmative with pending approvals — interpreted as blanket approval."
}

### Example 5: Context injection
**Message**: "By the way, use port 3000 for the server, not 8080"
**Pool state**: executing, 2 active agents
**Response**:
{
  "intent": "context_injection",
  "confidence": 0.9,
  "parameters": { "instructions": "Use port 3000 for the server instead of 8080", "targetAgent": "all" },
  "reasoning": "User providing additional constraint to active agents."
}

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
