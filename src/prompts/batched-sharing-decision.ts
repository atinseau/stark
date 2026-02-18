import Handlebars from "handlebars";
import "./helpers.ts";

// ── Batched Sharing Decision: User Prompt ──────────────────────────────────

const BATCHED_SHARING_DECISION_SOURCE = `Determine if information from one agent should be shared with other agents.
{{#if decisionJournal}}

## Recent Sharing Decisions (your session memory)
These are your most recent decisions in this execution. Use them to maintain consistency and detect patterns. Do NOT re-share information you already approved sharing, and respect reasoning from previous denials unless circumstances have changed.

{{decisionJournal}}
{{/if}}

## Source Agent
- **Name**: {{sourceAgent.agentName}} ({{sourceAgent.agentId}})
- **Task**: {{sourceAgent.taskDescription}}
- **Role**: {{sourceAgent.taskRole}} | **Status**: {{sourceAgent.status}}

## Delta (new information)
- **Type**: {{delta.type}}
- **Summary**: {{delta.summary}}
- **Data**:
{{json delta.data}}
{{#if delta.promptResultSummary}}

### Extended Response Summary
The agent's full response was {{delta.responseLength}} characters. Here is an extracted summary of the key content:

<response_summary>
{{delta.promptResultSummary}}
</response_summary>
{{/if}}

## Target Agents
{{#each targets}}
### Target: {{this.agentName}} ({{this.agentId}})
- **Task**: {{this.taskDescription}}
- **Role**: {{this.taskRole}} | **Status**: {{this.status}} | **Completed**: {{this.completed}}
{{#if this.dependency}}
- **Dependency**: {{this.dependency.from}} → {{this.dependency.to}} ({{this.dependency.type}})
{{/if}}
{{#if this.previouslyShared.length}}
- **Previously shared to this agent** (do NOT re-share redundant information):
{{#each this.previouslyShared}}
  - [{{this.deltaType}}] {{this.informationSummary}}
{{/each}}
{{/if}}

{{/each}}

## Criteria
1. Is this genuinely useful for the target agent's specific task?
2. Would it help the target produce better output?
3. Is the target in a state where it can use this (not completed/destroyed)?
4. Is the information concrete and actionable?
5. Has similar or identical information already been shared to this target? If yes, do NOT re-share — only share genuinely NEW information that adds value beyond what was previously communicated.

## Examples

### Example 1: Share — blocking dependency fulfilled
Source agent "api-developer" just completed writing \`src/routes/users.ts\` with endpoints GET/POST/PUT/DELETE /users.
Target agent "test-writer" is working on writing integration tests for the API.
Previously shared: Nothing yet.

Good decision:
{
  "decisions": [
    {
      "targetAgentId": "agent-test-writer-id",
      "shouldShare": true,
      "reasoning": "The test writer needs to know the exact endpoint signatures and response formats to write accurate tests. This is a blocking dependency.",
      "information": "The users API has been implemented in src/routes/users.ts with the following endpoints: GET /users (returns User[]), POST /users (body: {name, email}, returns User), PUT /users/:id (body: partial User, returns User), DELETE /users/:id (returns 204). User model: {id: string, name: string, email: string, createdAt: Date}."
    }
  ]
}

### Example 2: Share new info only — avoids redundancy with previous shares
Same source agent later writes \`src/routes/products.ts\`.
Previously shared to test-writer: "[file_written] The users API has been implemented in src/routes/users.ts with the following endpoints..."

Good decision (only shares NEW information):
{
  "decisions": [
    {
      "targetAgentId": "agent-test-writer-id",
      "shouldShare": true,
      "reasoning": "New products API endpoints are relevant for the test writer. User API info was already shared — only sharing the NEW products information.",
      "information": "A new products API has been added in src/routes/products.ts: GET /products, POST /products (body: {name, price}), GET /products/:id. Product model: {id: string, name: string, price: number}."
    }
  ]
}

### Example 3: Don't share — irrelevant to target's task
Source "frontend-dev" updated CSS styling. Target "test-writer" writes backend tests.
{
  "decisions": [
    {
      "targetAgentId": "agent-test-writer-id",
      "shouldShare": false,
      "reasoning": "CSS styling changes are purely visual and have no impact on backend test logic. Sharing would be noise.",
      "information": ""
    }
  ]
}

{{#if orchestratorDirectives}}

{{orchestratorDirectives}}
{{/if}}

## JSON Output
Return one decision per target agent:
{
  "decisions": [
    { "targetAgentId": "<agent ID>", "shouldShare": true | false, "reasoning": "<why>", "information": "<distilled info if shouldShare>" }
  ]
}`;

export const batchedSharingDecisionPrompt = Handlebars.compile(
	BATCHED_SHARING_DECISION_SOURCE,
	{ noEscape: true },
);
