import Handlebars from "handlebars";
import "./helpers.ts";

// ── Conflict Analysis: User Prompt ─────────────────────────────────────────

const CONFLICT_ANALYSIS_SOURCE = `Analyze whether the following agent activity creates a conflict with other agents or previously shared information.

## Source Agent Activity
- **Agent**: {{sourceAgent.agentName}} ({{sourceAgent.taskRole}})
- **Event type**: {{eventType}}
- **Summary**: {{eventSummary}}
{{#if filePath}}
- **File**: {{filePath}}
{{/if}}
{{#if eventData}}
- **Details**:
{{json eventData}}
{{/if}}

## Other Active Agents
{{#each otherAgents}}
### {{this.agentName}} ({{this.taskRole}})
- **Task**: {{truncate this.taskDescription 150}}
- **Status**: {{this.status}} | **Completed**: {{this.completed}}
- **Files written**: {{#if this.filesWritten.length}}{{#each this.filesWritten}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}{{else}}none{{/if}}
- **Files read**: {{#if this.filesRead.length}}{{#each this.filesRead}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}{{else}}none{{/if}}
{{/each}}

{{#if previouslySharedToSource}}
## Information Previously Shared TO the Source Agent
{{#each previouslySharedToSource}}
- [{{this.deltaType}}] From {{this.sourceAgentName}}: {{this.informationSummary}}
{{/each}}
{{/if}}

{{#if previouslySharedFromSource}}
## Information Previously Shared FROM the Source Agent
{{#each previouslySharedFromSource}}
- [{{this.deltaType}}] To {{this.targetAgentName}}: {{this.informationSummary}}
{{/each}}
{{/if}}

{{#if fileOverlaps}}
## Detected File Overlaps
The following files have been written by multiple agents:
{{#each fileOverlaps}}
- **{{this.filePath}}**: written by {{#each this.agents}}{{this}}{{#unless @last}}, {{/unless}}{{/each}}
{{/each}}
{{/if}}

## Analysis Required

Determine if there is a genuine conflict. Consider:

1. **File overlap conflicts**: Did two agents write to the same file? If so, is it a real conflict (contradictory changes) or expected (sequential updates)?
2. **Stale share conflicts**: Did the source agent's action invalidate information that was previously shared with another agent? (e.g., changing a port number, renaming an API endpoint, modifying a schema)
3. **Semantic conflicts**: Does the source agent's output semantically contradict what another agent is doing or has done?
4. **Dependency violations**: Does the source agent's output break an assumption that a dependent agent relies on?

If NO conflict exists, respond with:
{
  "hasConflict": false,
  "reasoning": "<why there is no conflict>"
}

If a conflict IS detected, respond with:
{
  "hasConflict": true,
  "conflicts": [
    {
      "type": "file_overlap" | "stale_share" | "semantic_conflict" | "dependency_violation",
      "severity": <0.0-1.0>,
      "description": "<clear description of the conflict>",
      "affectedAgentIds": ["<agent IDs that are affected>"],
      "recommendation": "<what should be done to resolve this>",
      "staleInformation": "<if stale_share: what was the stale info>"
    }
  ],
  "reasoning": "<overall analysis>"
}`;

export const conflictAnalysisPrompt = Handlebars.compile(
	CONFLICT_ANALYSIS_SOURCE,
	{ noEscape: true },
);
