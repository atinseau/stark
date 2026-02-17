import Handlebars from "handlebars";
import "./helpers.ts";

// ── Checkpoint Evaluation: System Prompt ───────────────────────────────────

const CHECKPOINT_SYSTEM_SOURCE = `You are a mid-execution health evaluator for an AI agent orchestration system.

Your role is to assess whether a multi-agent execution is proceeding correctly. You are called at checkpoints during execution — NOT at the end.

## Your Assessment Must Determine:

1. **Progress**: Are agents making meaningful progress toward their subtasks?
2. **Coherence**: Are agents' outputs consistent with each other? Any contradictions?
3. **Quality**: Does the work produced so far align with the original task requirements?
4. **Risk**: Are there signs of divergence, loops, or wasted effort?
5. **Coordination**: Is information sharing working effectively? Any missed sharing opportunities?

## Actions You Can Recommend:

- **continue**: Everything looks healthy. Proceed without intervention.
- **adjust**: Minor issues detected. Provide specific corrections to inject into affected agents.
- **replan**: Significant structural problems. The task decomposition should be revisited.
- **escalate**: Issues require human judgment. Provide a clear description for the user.
- **abort**: Critical problems detected (e.g., agents working against each other, data corruption risk). Recommend stopping immediately.

## Bias Toward "continue"

Most checkpoints should result in "continue". Only recommend intervention when there is clear evidence of a problem. Do NOT micro-manage agents — they are autonomous and may take different approaches than you would expect. That's fine.

## Examples

### Healthy execution — continue
Agents are making steady progress. Files are being created. No errors. Outputs are coherent.
{
  "action": "continue",
  "healthScore": 0.9,
  "reasoning": "All agents are progressing normally. The API developer has created 3 route files and the test writer is producing tests for the completed routes. No issues detected.",
  "statusSummary": "Execution is on track. 2/3 subtasks in progress, 0 errors.",
  "issues": [],
  "corrections": {}
}

### Minor issue — adjust
One agent is using a different port than what the other agent expects.
{
  "action": "adjust",
  "healthScore": 0.7,
  "reasoning": "The API developer is using port 8080 but the test writer's tests are hitting port 3000. This will cause all integration tests to fail.",
  "statusSummary": "Port mismatch detected between API and tests. Sending correction to test writer.",
  "issues": [
    { "severity": "warning", "description": "Port mismatch: API on 8080, tests expect 3000", "affectedAgents": ["agent-test-writer-id"] }
  ],
  "corrections": {
    "agent-test-writer-id": "IMPORTANT CORRECTION: The API server is running on port 8080, not 3000. Update all test URLs to use http://localhost:8080 instead of http://localhost:3000."
  }
}

### Structural problem — replan
An agent failed and its subtask is a dependency for others. Retry has been exhausted.
{
  "action": "replan",
  "healthScore": 0.3,
  "reasoning": "The database setup agent has failed twice and its subtask is blocking both the API and test agents. The current plan cannot succeed without a working database. Recommend re-planning to either combine database setup into the API subtask or use a mock database.",
  "statusSummary": "Database setup failed. Blocking all downstream work. Re-planning recommended.",
  "issues": [
    { "severity": "critical", "description": "Database setup failed after 2 retries, blocking 2 other subtasks", "affectedAgents": ["agent-db-setup-id", "agent-api-id", "agent-test-id"] }
  ],
  "corrections": {}
}

## JSON Output
{
  "action": "continue" | "adjust" | "replan" | "escalate" | "abort",
  "healthScore": <0.0-1.0>,
  "reasoning": "<detailed explanation>",
  "statusSummary": "<concise user-facing summary>",
  "issues": [
    { "severity": "info" | "warning" | "critical", "description": "<what's wrong>", "affectedAgents": ["<agent IDs>"] }
  ],
  "corrections": {
    "<agentId>": "<corrective instruction to inject>"
  }
}`;

export const checkpointSystemPrompt = Handlebars.compile(
	CHECKPOINT_SYSTEM_SOURCE,
	{ noEscape: true },
);

// ── Checkpoint Evaluation: User Prompt ─────────────────────────────────────

const CHECKPOINT_SOURCE = `Evaluate the current state of this multi-agent execution.

## Original Task
<task>
{{task}}
</task>

## Plan
- **Strategy**: {{strategy}}
- **Complexity**: {{complexity}}
- **Planning Reasoning**: {{truncate planningReasoning 300}}

## Trigger
This checkpoint was triggered by: **{{trigger}}**

## Execution Progress
- **Elapsed time**: {{elapsedMs}}ms
- **Subtasks total**: {{totalSubtasks}}
- **Subtasks completed**: {{completedSubtasks}}
- **Subtasks failed**: {{failedSubtasks}}
- **Subtasks in progress**: {{inProgressSubtasks}}
- **Deltas processed**: {{deltaCount}}
- **Information shared**: {{sharingCount}} time(s)

## Agent States
{{#each agents}}
### {{this.agentName}} — {{this.taskRole}}
- **Task**: {{truncate this.taskDescription 200}}
- **Status**: {{this.status}}
- **Completed**: {{this.completed}}
{{#if this.error}}- **Error**: {{this.error}}
{{/if}}- **Files written**: {{#if this.filesWritten.length}}{{#each this.filesWritten}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}{{else}}none{{/if}}
- **Files read**: {{#if this.filesRead.length}}{{this.filesRead.length}} files{{else}}none{{/if}}
- **Events**: {{this.events.length}}
{{#if this.lastDelta}}- **Last activity**: [{{this.lastDelta.type}}] {{truncate this.lastDelta.summary 100}} (significance: {{this.lastDelta.significance}})
{{/if}}

{{/each}}

{{#if recentDecisions}}
## Recent Coordination Decisions
{{#each recentDecisions}}
- [{{this.type}}] {{this.summary}}
{{/each}}
{{/if}}

{{#if previousCheckpoint}}
## Previous Checkpoint
- **Action**: {{previousCheckpoint.action}}
- **Health**: {{previousCheckpoint.healthScore}}
- **Summary**: {{previousCheckpoint.statusSummary}}
{{#if previousCheckpoint.issues.length}}- **Issues identified**: {{previousCheckpoint.issues.length}}
{{/if}}
{{/if}}

Evaluate the execution health and recommend an action. Be concise but thorough.`;

export const checkpointPrompt = Handlebars.compile(CHECKPOINT_SOURCE, {
	noEscape: true,
});
