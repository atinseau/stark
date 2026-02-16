import Handlebars from "handlebars";

// ── Handlebars Helpers ─────────────────────────────────────────────────────

Handlebars.registerHelper("json", (context: unknown) => {
	return new Handlebars.SafeString(JSON.stringify(context, null, 2));
});

Handlebars.registerHelper("eq", (a: unknown, b: unknown) => a === b);

Handlebars.registerHelper("gt", (a: number, b: number) => a > b);

Handlebars.registerHelper("truncate", (text: string, length: number) => {
	if (typeof text !== "string") return "";
	if (text.length <= length) return text;
	return `${text.slice(0, length)}…`;
});

// ── Planning: System Prompt ────────────────────────────────────────────────

const PLANNING_SYSTEM_SOURCE = `You are a strategic task planner for an AI agent orchestration system called AgentPool.

Your role is to analyze incoming tasks and decide the optimal execution strategy:
- **single**: One agent handles the entire task.
- **multi**: The task is decomposed into distinct subtasks, each handled by a separate agent.

## Decision Criteria

Choose "single" when:
- The task is straightforward and self-contained
- There are no naturally separable concerns
- Decomposition would add overhead without benefit
- The task requires deep sequential reasoning on one topic
- The output is a single cohesive artifact

Choose "multi" when:
- The task has clearly distinct responsibilities (e.g., backend + frontend + tests)
- Subtasks can meaningfully execute in parallel
- Each subtask produces an independent deliverable
- The complexity genuinely benefits from specialization
- There are natural boundaries between concerns

## Critical Rules

1. NEVER force multi-agent when a single agent suffices. Artificial splitting wastes resources.
2. Each subtask prompt must be self-contained and contextually complete.
3. Subtask prompts must reflect realistic responsibilities, not arbitrary divisions.
4. Dependencies must be logically sound — a subtask cannot depend on something that depends on it.
5. The parallelismBenefit score must honestly reflect how much parallel execution helps.
6. You MUST respond with valid JSON only. No markdown, no commentary outside the JSON.

## Output Format

Respond with a single JSON object matching this schema exactly:
{
  "strategy": "single" | "multi",
  "complexity": "simple" | "moderate" | "complex",
  "reasoning": "<your analysis of why this strategy was chosen>",
  "subtasks": [
    {
      "id": "subtask-1",
      "prompt": "<the complete prompt text for the agent>",
      "role": "<a descriptive role label>",
      "dependencies": [],
      "priority": 1
    }
  ],
  "dependencies": [
    {
      "from": "subtask-1",
      "to": "subtask-2",
      "type": "blocking" | "informational"
    }
  ],
  "parallelismBenefit": 0.0
}

For "single" strategy: subtasks array has exactly 1 entry, dependencies is empty, parallelismBenefit is 0.
For "multi" strategy: subtasks array has 2+ entries with meaningful decomposition.`;

export const planningSystemPrompt = Handlebars.compile(PLANNING_SYSTEM_SOURCE, {
	noEscape: true,
});

// ── Planning: Task Analysis User Prompt ────────────────────────────────────

const TASK_ANALYSIS_SOURCE = `Analyze the following task and determine the optimal execution strategy.

## Task
<task>
{{task}}
</task>

{{#if contextHints}}
## Additional Context
{{contextHints}}
{{/if}}

{{#if constraints}}
## Constraints
{{#each constraints}}
- {{this}}
{{/each}}
{{/if}}

Respond with the JSON analysis object. Remember: only use "multi" if there is a genuine, meaningful benefit to decomposition. A single agent is often the better choice.`;

export const taskAnalysisPrompt = Handlebars.compile(TASK_ANALYSIS_SOURCE, {
	noEscape: true,
});

// ── Context Analysis: System Prompt ────────────────────────────────────────

const CONTEXT_ANALYSIS_SYSTEM_SOURCE = `You are a real-time context analyzer for an AI agent orchestration system.

Your role is to evaluate context deltas (changes) produced by agents and recommend appropriate reactions.

## Your Capabilities

You receive a delta describing what changed, along with:
- The originating agent's current state and task
- The overall task being executed
- The state of all other agents (if any)
- Dependencies between agents

## Possible Actions

- **ignore**: The delta is not significant enough to warrant any action.
- **share**: Information from this delta should be transmitted to another agent because it's relevant to their task.
- **notify**: The user should be informed about this change.
- **clarify**: The system needs clarification from the user to proceed.

## Decision Guidelines

- Default to "ignore" unless there's a clear, actionable reason to do something else.
- "share" only when the information is genuinely useful to the target agent's specific task.
- "notify" only for significant milestones, errors, or completions — not routine progress.
- "clarify" only when genuine ambiguity blocks progress.

## Output Format

Respond with valid JSON only:
{
  "action": "ignore" | "share" | "notify" | "clarify",
  "reasoning": "<why this action was chosen>",
  "targetAgentId": "<agent ID if action is share, omit otherwise>",
  "content": "<information to share/notification text/clarification question>",
  "significance": <0.0 to 1.0>
}`;

export const contextAnalysisSystemPrompt = Handlebars.compile(
	CONTEXT_ANALYSIS_SYSTEM_SOURCE,
	{ noEscape: true },
);

// ── Context Analysis: Delta Analysis User Prompt ───────────────────────────

const CONTEXT_ANALYSIS_SOURCE = `A context change has occurred. Analyze it and recommend an action.

## Delta
- **Agent**: {{delta.agentName}} ({{delta.agentId}})
- **Type**: {{delta.type}}
- **Summary**: {{delta.summary}}
- **Pre-filter Significance**: {{delta.significance}}
- **Data**:
{{json delta.data}}

## Original Task
<task>
{{task}}
</task>

## Source Agent State
- **Task**: {{sourceAgent.taskDescription}}
- **Role**: {{sourceAgent.taskRole}}
- **Status**: {{sourceAgent.status}}
- **Completed**: {{sourceAgent.completed}}
- **Files Written**: {{#each sourceAgent.filesWritten}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}
{{#if sourceAgent.error}}
- **Error**: {{sourceAgent.error}}
{{/if}}

{{#if otherAgents.length}}
## Other Agents
{{#each otherAgents}}
### {{this.agentName}} ({{this.agentId}})
- **Task**: {{this.taskDescription}}
- **Role**: {{this.taskRole}}
- **Status**: {{this.status}}
- **Completed**: {{this.completed}}
{{/each}}
{{/if}}

{{#if dependencies.length}}
## Dependencies
{{#each dependencies}}
- {{this.from}} → {{this.to}} ({{this.type}})
{{/each}}
{{/if}}

Analyze this delta and respond with your JSON recommendation.`;

export const contextAnalysisPrompt = Handlebars.compile(
	CONTEXT_ANALYSIS_SOURCE,
	{ noEscape: true },
);

// ── Sharing Decision: User Prompt ──────────────────────────────────────────

const SHARING_DECISION_SOURCE = `An agent has produced output that may be relevant to another agent. Determine if the information should be shared.

## Source Agent
- **Name**: {{sourceAgent.agentName}} ({{sourceAgent.agentId}})
- **Task**: {{sourceAgent.taskDescription}}
- **Role**: {{sourceAgent.taskRole}}
- **Status**: {{sourceAgent.status}}

## Delta (the new information)
- **Type**: {{delta.type}}
- **Summary**: {{delta.summary}}
- **Data**:
{{json delta.data}}

## Target Agent
- **Name**: {{targetAgent.agentName}} ({{targetAgent.agentId}})
- **Task**: {{targetAgent.taskDescription}}
- **Role**: {{targetAgent.taskRole}}
- **Status**: {{targetAgent.status}}
- **Completed**: {{targetAgent.completed}}

{{#if dependency}}
## Dependency Relationship
- **From**: {{dependency.from}}
- **To**: {{dependency.to}}
- **Type**: {{dependency.type}}
{{/if}}

## Decision Criteria

1. Is this information genuinely useful for the target agent's specific task?
2. Would sharing this information help the target produce better output?
3. Is the target agent in a state where it can use this information (not completed/destroyed)?
4. Is the information concrete enough to be actionable?

Respond with valid JSON only:
{
  "shouldShare": true | false,
  "reasoning": "<why sharing is or isn't beneficial>",
  "information": "<distilled information to inject into the target agent's context, if shouldShare is true>"
}`;

export const sharingDecisionPrompt = Handlebars.compile(
	SHARING_DECISION_SOURCE,
	{ noEscape: true },
);

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

// ── Template Index ─────────────────────────────────────────────────────────

/**
 * All compiled Handlebars templates used by the AgentPool system.
 *
 * Each template is pre-compiled at module load time for performance.
 * Templates use `noEscape: true` to prevent HTML entity encoding,
 * which is unnecessary for LLM prompts and would corrupt code snippets.
 */
export const templates = {
	// Planning
	planningSystem: planningSystemPrompt,
	taskAnalysis: taskAnalysisPrompt,

	// Context analysis
	contextAnalysisSystem: contextAnalysisSystemPrompt,
	contextAnalysis: contextAnalysisPrompt,

	// Information sharing
	sharingDecision: sharingDecisionPrompt,

	// Notifications
	notificationDecision: notificationDecisionPrompt,

	// Intent analysis
	intentAnalysisSystem: intentAnalysisSystemPrompt,
	intentAnalysis: intentAnalysisPrompt,

	// Execution summary
	summarySystem: summarySystemPrompt,
	summary: summaryPrompt,
} as const;
