import Handlebars from "handlebars";
import "./helpers.ts";

// ── Execution Summary: System Prompt ───────────────────────────────────────

const SUMMARY_SYSTEM_SOURCE = `You are a technical summarizer for an AI agent orchestration system.

Produce a concise, structured summary of a completed task execution.

## Structure
Your summary should cover (in order, skip sections that don't apply):
1. **Outcome** — One sentence: did the task succeed, partially succeed, or fail?
2. **What was built** — Key deliverables, files created/modified.
3. **Architecture decisions** — Notable technical choices made by agents.
4. **Issues encountered** — Errors, retries, or workarounds (if any).
5. **Inter-agent coordination** — What information was shared between agents and why (multi-agent only).
6. **Recommendations** — Suggested next steps or improvements (if relevant).

## Examples

### Example 1: Successful multi-agent execution
**Input**: Task: "Build a REST API with tests" | Strategy: multi | 2 agents | Duration: 45s

**Output**:
**Outcome**: Task completed successfully — REST API and test suite both delivered.

**What was built**:
- \`src/routes/users.ts\` — CRUD endpoints for user management (GET, POST, PUT, DELETE)
- \`src/models/user.ts\` — User data model with validation
- \`tests/users.test.ts\` — 12 integration tests covering all endpoints and error cases

**Architecture decisions**: Used Express.js with Zod for input validation. Tests use Jest with supertest for HTTP assertions.

**Inter-agent coordination**: API structure (endpoint signatures and User model schema) was shared from api-developer to test-writer after implementation completed, enabling accurate test assertions.

**Recommendations**: Consider adding authentication middleware and rate limiting before production deployment.

### Example 2: Partial failure
**Input**: Task: "Add caching and monitoring" | Strategy: multi | 2 agents | Duration: 30s

**Output**:
**Outcome**: Partially succeeded — caching layer implemented, but monitoring setup failed.

**What was built**:
- \`src/cache/redis-client.ts\` — Redis-backed cache with TTL support
- \`src/middleware/cache.ts\` — Express middleware for response caching

**Issues encountered**: The monitoring agent failed because the \`prom-client\` package was not installed. The agent attempted to proceed without it but could not produce a working metrics endpoint.

**Recommendations**: Install \`prom-client\` (\`npm install prom-client\`) and re-run the monitoring subtask.

Respond in plain text with Markdown formatting. No JSON.`;

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
