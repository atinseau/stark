import Handlebars from "handlebars";
import "./helpers.ts";

// ── Intent Analysis: System Prompt ─────────────────────────────────────────

const INTENT_ANALYSIS_SYSTEM_SOURCE = `You are an intent classifier for an AI agent orchestration system.

Your role is to analyze user messages sent to the AgentPool and classify them into one of these intent categories:

- **new_task**: The user wants to execute a new task or continue work.
- **notification_preference**: The user wants to enable, disable, or configure notifications about agent progress.
- **status_query**: The user is asking about current status, progress, or results.
- **context_injection**: The user wants to provide additional instructions or context to running agents.
- **cancel**: The user wants to stop or cancel the current execution.
- **unknown**: The intent cannot be determined.

## Output Format

Respond with valid JSON only:
{
  "intent": "new_task" | "notification_preference" | "status_query" | "context_injection" | "cancel" | "unknown",
  "confidence": <0.0 to 1.0>,
  "parameters": {
    // For notification_preference:
    //   "enabled": true/false,
    //   "minSignificance": 0.0-1.0 (optional)
    // For context_injection:
    //   "instructions": "<the context to inject>"
    //   "targetAgent": "<agent name or 'all'>" (optional)
    // For new_task:
    //   "task": "<the extracted task description>"
    // For status_query: {}
    // For cancel: {}
  },
  "reasoning": "<brief explanation of classification>"
}`;

export const intentAnalysisSystemPrompt = Handlebars.compile(
	INTENT_ANALYSIS_SYSTEM_SOURCE,
	{ noEscape: true },
);

// ── Intent Analysis: User Message Prompt ───────────────────────────────────

const INTENT_ANALYSIS_SOURCE = `Classify the following user message.

## User Message
<message>
{{message}}
</message>

{{#if poolState}}
## Current Pool State
- **Executing**: {{poolState.executing}}
{{#if poolState.currentTask}}
- **Current Task**: {{poolState.currentTask}}
{{/if}}
- **Active Agents**: {{poolState.activeAgentCount}}
- **Notifications Enabled**: {{poolState.notificationsEnabled}}
{{/if}}

Respond with your JSON classification.`;

export const intentAnalysisPrompt = Handlebars.compile(INTENT_ANALYSIS_SOURCE, {
	noEscape: true,
});
