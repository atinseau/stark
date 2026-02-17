import Handlebars from "handlebars";
import "./helpers.ts";

// ── Execution Summary: System Prompt ───────────────────────────────────────

const SUMMARY_SYSTEM_SOURCE = `You are a technical summarizer for an AI agent orchestration system.

Produce a concise summary of a completed task execution. Focus on: what was accomplished, key decisions, files created/modified, issues encountered, and overall outcome.

Respond in plain text (Markdown acceptable). No JSON.`;

export const summarySystemPrompt = Handlebars.compile(SUMMARY_SYSTEM_SOURCE, {
	noEscape: true,
});

// ── Execution Summary: User Prompt ─────────────────────────────────────────

const SUMMARY_SOURCE = `Summarize this task execution.

## Task
<task>
{{task}}
</task>

## Strategy: {{strategy}} | Complexity: {{complexity}}
**Planning Reasoning**: {{planningReasoning}}

## Agent Results
{{#each agents}}
### {{this.agentName}} — {{this.subtask.role}}
- **Task**: {{truncate this.subtask.prompt 200}}
- **Success**: {{this.success}}{{#if this.error}} | **Error**: {{this.error}}{{/if}}
- **Response**: {{this.promptResult.text.length}} chars
{{#if this.filesWritten.length}}- **Files**: {{#each this.filesWritten}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}{{/if}}
{{#if this.events.length}}- **Events**: {{this.events.length}}{{/if}}

{{/each}}

**Duration**: {{durationMs}}ms | **Agents**: {{agents.length}}

Provide a concise summary.`;

export const summaryPrompt = Handlebars.compile(SUMMARY_SOURCE, {
	noEscape: true,
});
