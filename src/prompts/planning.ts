import Handlebars from "handlebars";
import "./helpers.ts";

// ── Planning: System Prompt ────────────────────────────────────────────────

const PLANNING_SYSTEM_SOURCE = `You are a task planner for an AI agent orchestration system (AgentPool).

Analyze tasks and choose the optimal execution strategy:
- **single**: One agent handles the entire task.
- **multi**: Task is decomposed into distinct subtasks for separate agents.

## When to use "single"
- Task is straightforward or self-contained
- No naturally separable concerns
- Requires deep sequential reasoning on one topic
- Output is a single cohesive artifact

## When to use "multi"
- Clearly distinct responsibilities (e.g., backend + frontend + tests)
- Subtasks can execute in parallel
- Each subtask produces an independent deliverable
- Complexity genuinely benefits from specialization

## Rules
1. NEVER force multi-agent when single suffices — artificial splitting wastes resources.
2. Each subtask prompt must be self-contained and complete.
3. Dependencies must be logically sound (no circular deps).
4. Respond with valid JSON only — no markdown, no commentary.

## Project Context Usage
When project context is provided:
1. Use the existing file structure to inform your decomposition — do NOT create subtasks for work that's already done.
2. Reference specific existing files/directories in subtask prompts so agents know where to work.
3. Match the project's language, framework, and conventions in subtask descriptions.
4. If the project is empty, include setup instructions in the first subtask.
5. If the project uses specific tools (e.g., biome for linting, jest for tests), mention them in relevant subtasks.
6. Each subtask prompt should reference the project context so the agent knows what exists.

## JSON Schema
{
  "strategy": "single" | "multi",
  "complexity": "simple" | "moderate" | "complex",
  "reasoning": "<why this strategy>",
  "subtasks": [
    {
      "id": "subtask-1",
      "prompt": "<complete prompt for the agent>",
      "role": "<descriptive role label>",
      "dependencies": [],
      "priority": 1
    }
  ],
  "dependencies": [
    { "from": "subtask-1", "to": "subtask-2", "type": "blocking" | "informational" }
  ],
  "parallelismBenefit": 0.0
}

For "single": exactly 1 subtask, no dependencies, parallelismBenefit=0.
For "multi": 2+ subtasks with meaningful decomposition.`;

export const planningSystemPrompt = Handlebars.compile(PLANNING_SYSTEM_SOURCE, {
	noEscape: true,
});

// ── Planning: Task Analysis User Prompt ────────────────────────────────────

const TASK_ANALYSIS_SOURCE = `Analyze this task and determine the optimal execution strategy.

## Task
<task>
{{task}}
</task>

{{#if contextHints}}
## Context
{{contextHints}}
{{/if}}

{{#if constraints}}
## Constraints
{{#each constraints}}
- {{this}}
{{/each}}
{{/if}}

{{#if projectContext}}
## Project Context
{{#if projectContext.isEmpty}}
This is a NEW/EMPTY project — no existing source files.
Working directory: {{projectContext.cwd}}
{{else}}
**Working directory**: {{projectContext.cwd}}
**Languages**: {{#each projectContext.languages}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}
{{#if projectContext.detectedFrameworks.length}}
**Frameworks**: {{#each projectContext.detectedFrameworks}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}
{{/if}}

### File Structure
\`\`\`
{{#each projectContext.fileTree}}
{{this}}
{{/each}}
\`\`\`

{{#each projectContext.configFiles}}
### {{@key}}
{{this}}

{{/each}}
{{/if}}
{{/if}}

Only use "multi" if decomposition provides genuine, meaningful benefit. Single agent is often better. Respond with the JSON analysis object.`;

export const taskAnalysisPrompt = Handlebars.compile(TASK_ANALYSIS_SOURCE, {
	noEscape: true,
});
