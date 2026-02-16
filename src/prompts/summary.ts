import Handlebars from "handlebars";
import "./helpers.ts";

// ── Execution Summary: System Prompt ───────────────────────────────────────

const SUMMARY_SYSTEM_SOURCE = `You are a technical summarizer for an AI agent orchestration system.

Your role is to produce a concise, informative summary of a completed task execution.

Focus on:
- What was accomplished
- Key decisions made
- Files created or modified
- Any issues encountered
- Overall outcome

Keep the summary clear and actionable. Do not use JSON — respond in plain text (Markdown is acceptable).`;

export const summarySystemPrompt = Handlebars.compile(SUMMARY_SYSTEM_SOURCE, {
	noEscape: true,
});

// ── Execution Summary: User Prompt ─────────────────────────────────────────

const SUMMARY_SOURCE = `Summarize the following task execution.

## Original Task
<task>
{{task}}
</task>

## Strategy
- **Type**: {{strategy}}
- **Complexity**: {{complexity}}
- **Planning Reasoning**: {{planningReasoning}}

## Agent Results
{{#each agents}}
### {{this.agentName}} — {{this.subtask.role}}
- **Task**: {{truncate this.subtask.prompt 200}}
- **Success**: {{this.success}}
{{#if this.error}}
- **Error**: {{this.error}}
{{/if}}
- **Response Length**: {{this.promptResult.text.length}} chars
{{#if this.filesWritten.length}}
- **Files Written**: {{#each this.filesWritten}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}
{{/if}}
{{#if this.events.length}}
- **Key Events**: {{this.events.length}} captured
{{/if}}

{{/each}}

## Execution Stats
- **Duration**: {{durationMs}}ms
- **Total Agents**: {{agents.length}}

Provide a concise summary of what was accomplished and any notable observations.`;

export const summaryPrompt = Handlebars.compile(SUMMARY_SOURCE, {
	noEscape: true,
});
