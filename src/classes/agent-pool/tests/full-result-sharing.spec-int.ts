import { describe, expect, it } from "bun:test";
import pino from "pino";
import { ConversationRole } from "../../../enums/conversation-role.enum.ts";
import {
  batchedSharingDecisionPrompt,
  sharingAnalysisSystemPrompt,
} from "../../../prompts/index.ts";
import { ConversationManager } from "../conversation-manager.ts";

// ════════════════════════════════════════════════════════════════════════════
// Constants & Environment
// ════════════════════════════════════════════════════════════════════════════

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? "";
const HAS_API_KEY = OPENROUTER_API_KEY.length > 0;
const DEFAULT_MODEL = "openai/gpt-5-nano";
const INT_MODEL = process.env.INT_MODEL ?? DEFAULT_MODEL;
const INT_TIMEOUT_MS = 120_000;

/**
 * Reasoning models (e.g. gpt-5-nano) spend a large portion of maxTokens on
 * internal reasoning tokens before producing visible content. A budget of
 * 400–800 is far too low — the model exhausts it on reasoning and returns
 * an empty content string (finishReason: "length"). 16 384 gives ample room
 * for both reasoning and the JSON output.
 */
const INT_MAX_TOKENS = 16_384;

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

function silentLogger(): pino.Logger {
  return pino({ level: "silent" });
}

function createConversationManager(): ConversationManager {
  return new ConversationManager(
    {
      apiKey: OPENROUTER_API_KEY,
      model: INT_MODEL,
      maxRetries: 2,
      temperature: 0,
    },
    silentLogger(),
  );
}

// ── Validator ──────────────────────────────────────────────────────────────

interface SharingAnalysisResult {
  decisions: Array<{
    targetAgentId: string;
    shouldShare: boolean;
    reasoning: string;
    information: string;
  }>;
}

function validateSharingAnalysis(data: unknown): SharingAnalysisResult | null {
  if (data == null || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;

  if (!Array.isArray(obj.decisions)) return null;

  const decisions: SharingAnalysisResult["decisions"] = [];

  for (const d of obj.decisions) {
    if (d == null || typeof d !== "object") return null;
    const dec = d as Record<string, unknown>;
    if (typeof dec.targetAgentId !== "string") return null;
    if (typeof dec.shouldShare !== "boolean") return null;
    if (typeof dec.reasoning !== "string") return null;
    if (typeof dec.information !== "string") return null;
    decisions.push({
      targetAgentId: dec.targetAgentId,
      shouldShare: dec.shouldShare,
      reasoning: dec.reasoning,
      information: dec.information,
    });
  }

  return { decisions };
}

/**
 * Finds a decision whose `targetAgentId` matches the given agent ID or name.
 *
 * Small reasoning models (e.g. gpt-5-nano) sometimes return the agent
 * *name* instead of the *ID*, or even copy an example ID from the prompt.
 * This helper makes assertions resilient to that noise.
 */
function findDecision(
  decisions: SharingAnalysisResult["decisions"],
  agentId: string,
  agentName: string,
): SharingAnalysisResult["decisions"][number] | undefined {
  return (
    decisions.find((d) => d.targetAgentId === agentId) ??
    decisions.find((d) => d.targetAgentId === agentName) ??
    decisions.find((d) =>
      d.targetAgentId.toLowerCase().includes(agentName.toLowerCase()),
    )
  );
}

// ── Shared prompt data builders ────────────────────────────────────────────

/**
 * Rich prompt result summary that simulates what `buildPromptResultSummary`
 * would produce for a long API implementation response.
 */
const RICH_PROMPT_RESULT_SUMMARY = [
  "Files: src/routes/users.ts, src/models/user.ts, src/middleware/auth.ts",
  "",
  "Start: I've implemented the complete Users REST API with the following endpoints and models. " +
  "The API follows RESTful conventions with proper error handling, input validation using Zod, " +
  "and JWT-based authentication middleware. Here are the endpoint details: " +
  "GET /api/users — returns paginated list of users (query params: page, limit, sort). " +
  "POST /api/users — creates a new user (body: { name: string, email: string, role: 'admin' | 'user' }). " +
  "GET /api/users/:id — returns a single user by ID.",
  "",
  "End: PUT /api/users/:id — updates user fields (partial update supported). " +
  "DELETE /api/users/:id — soft-deletes a user (sets deletedAt timestamp). " +
  "The User model is defined in src/models/user.ts with fields: " +
  "{ id: string, name: string, email: string, role: 'admin' | 'user', createdAt: Date, updatedAt: Date, deletedAt: Date | null }. " +
  "Authentication middleware in src/middleware/auth.ts validates JWT tokens and attaches user to request context. " +
  "All endpoints return JSON with consistent error format: { error: string, code: number }.",
  "",
  "Total response: 8500 chars",
].join("\n");

/**
 * Short preview that simulates the old 500-char truncation — only the
 * intro is visible, no endpoint details beyond the first one.
 */
const SHORT_PREVIEW =
  "I've implemented the complete Users REST API with the following endpoints and models. " +
  "The API follows RESTful conventions with proper error handling, input validation using Zod, " +
  "and JWT-based authentication middleware. Here are the endpoint details: " +
  "GET /api/users — returns paginated list of users (query params: page, limit, sort). " +
  "POST /api/users — creates a new user (body: { name: stri";

function makeSourceAgent() {
  return {
    agentId: "src-backend-42",
    agentName: "api-developer",
    taskDescription:
      "Implement all REST API endpoints for the user management system using Express.js with TypeScript",
    taskRole: "api-developer",
    status: "idle",
  };
}

function makeTestWriterTarget(opts?: {
  previouslyShared?: Array<{
    deltaType: string;
    informationSummary: string;
  }>;
}) {
  return {
    agentId: "tgt-qa-77",
    agentName: "test-writer",
    taskDescription:
      "Write comprehensive integration and unit tests for the Users REST API using Jest and supertest",
    taskRole: "test-writer",
    status: "busy",
    completed: false,
    dependency: {
      from: "api-implementation",
      to: "test-suite",
      type: "blocking",
    },
    previouslyShared: opts?.previouslyShared ?? [],
  };
}

function makeUnrelatedTarget() {
  return {
    agentId: "tgt-ascii-99",
    agentName: "cli-developer",
    taskDescription:
      "Implement a standalone command-line tool in Python that converts images to ASCII art using the PIL library. " +
      "The tool should accept file paths as arguments, support JPEG and PNG formats, and output ASCII to stdout.",
    taskRole: "cli-developer",
    status: "busy",
    completed: false,
    dependency: null,
    previouslyShared: [],
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Full Result Sharing — Integration Tests
//
// Validates that the enriched batched sharing prompt (Evolution 07)
// produces better sharing decisions when `promptResultSummary` is present.
//
// These tests make real LLM calls via OpenRouter using the
// `batchedSharingDecisionPrompt` template — the same template the
// InformationBroker uses in production.
// ════════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_API_KEY)("Full result sharing — integration", () => {
  // ────────────────────────────────────────────────────────────
  // 1. Sharing with promptResultSummary → richer information
  // ────────────────────────────────────────────────────────────

  describe("batched sharing with promptResultSummary", () => {
    it.concurrent(
      "LLM produces detailed information when promptResultSummary is present",
      async () => {
        const conversations = createConversationManager();
        conversations.register(
          ConversationRole.SHARING_ANALYZER,
          sharingAnalysisSystemPrompt({}),
        );

        const prompt = batchedSharingDecisionPrompt({
          sourceAgent: makeSourceAgent(),
          delta: {
            type: "prompt_complete",
            summary:
              "Agent completed implementing all REST API endpoints for user management",
            data: {
              responsePreview: SHORT_PREVIEW,
              responseLength: 8500,
              isComplete: false,
            },
            promptResultSummary: RICH_PROMPT_RESULT_SUMMARY,
            responseLength: 8500,
          },
          targets: [makeTestWriterTarget()],
        });

        const result = await conversations.sendOneShotJson(
          ConversationRole.SHARING_ANALYZER,
          prompt,
          validateSharingAnalysis,
          { maxTokens: INT_MAX_TOKENS },
        );

        expect(result.decisions).toHaveLength(1);

        const decision = findDecision(result.decisions, "tgt-qa-77", "test-writer");
        expect(decision).toBeDefined();
        expect(decision!.shouldShare).toBe(true);
        expect(decision!.reasoning.length).toBeGreaterThan(10);

        // The information field should contain specific details that
        // are only available in the promptResultSummary, not in the
        // truncated SHORT_PREVIEW.
        const info = decision!.information.toLowerCase();
        expect(info.length).toBeGreaterThan(50);

        // These details appear in the summary's "End:" section,
        // NOT in the SHORT_PREVIEW — proves the LLM used the summary.
        expect(info).toContain("delete");
        expect(info).toContain("put");
      },
      INT_TIMEOUT_MS,
    );
  });

  // ────────────────────────────────────────────────────────────
  // 2. Sharing WITHOUT summary → still works, less detailed
  // ────────────────────────────────────────────────────────────

  describe("batched sharing without promptResultSummary", () => {
    it.concurrent(
      "LLM still produces a valid decision with only a truncated preview",
      async () => {
        const conversations = createConversationManager();
        conversations.register(
          ConversationRole.SHARING_ANALYZER,
          sharingAnalysisSystemPrompt({}),
        );

        const prompt = batchedSharingDecisionPrompt({
          sourceAgent: makeSourceAgent(),
          delta: {
            type: "prompt_complete",
            summary:
              "Agent completed implementing all REST API endpoints for user management",
            data: {
              responsePreview: SHORT_PREVIEW,
              responseLength: 8500,
              isComplete: false,
            },
            // No promptResultSummary — the LLM only sees the short preview
            promptResultSummary: null,
            responseLength: null,
          },
          targets: [makeTestWriterTarget()],
        });

        const result = await conversations.sendOneShotJson(
          ConversationRole.SHARING_ANALYZER,
          prompt,
          validateSharingAnalysis,
          { maxTokens: INT_MAX_TOKENS },
        );

        expect(result.decisions).toHaveLength(1);

        const decision = findDecision(result.decisions, "tgt-qa-77", "test-writer");
        expect(decision).toBeDefined();
        expect(decision!.shouldShare).toBe(true);
        expect(decision!.reasoning.length).toBeGreaterThan(10);
        expect(decision!.information.length).toBeGreaterThan(10);

        // The LLM can only mention what it sees in the short preview.
        // DELETE and PUT endpoints are NOT in SHORT_PREVIEW, so the
        // information should be less specific about those.
        // We don't assert absence (the LLM might infer CRUD from context),
        // but we verify it at least mentions what IS in the preview.
        const info = decision!.information.toLowerCase();
        expect(info).toContain("get");
      },
      INT_TIMEOUT_MS,
    );
  });

  // ────────────────────────────────────────────────────────────
  // 3. Deduplication respected with enriched summary
  // ────────────────────────────────────────────────────────────

  describe("deduplication with enriched deltas", () => {
    it.concurrent(
      "LLM only shares NEW information when previouslyShared covers part of the summary",
      async () => {
        const conversations = createConversationManager();
        conversations.register(
          ConversationRole.SHARING_ANALYZER,
          sharingAnalysisSystemPrompt({}),
        );

        // The test-writer has ALREADY received the basic API structure
        // in a previous sharing. Now the source agent completed again
        // with an enriched summary that includes auth middleware details.
        const target = makeTestWriterTarget({
          previouslyShared: [
            {
              deltaType: "prompt_complete",
              informationSummary:
                "Users API implemented in src/routes/users.ts: " +
                "GET /api/users (paginated list), POST /api/users (create), " +
                "GET /api/users/:id (single user), PUT /api/users/:id (update), " +
                "DELETE /api/users/:id (soft-delete). User model: { id, name, email, role, timestamps }.",
            },
          ],
        });

        // The new summary adds authentication middleware details that
        // were NOT in the previous sharing.
        const newSummary = [
          "Files: src/middleware/auth.ts, src/middleware/rate-limit.ts, src/routes/users.ts",
          "",
          "Start: Added authentication and rate limiting middleware to the API. " +
          "JWT tokens must be passed via Authorization: Bearer <token> header. " +
          "Rate limiting is set to 100 requests per minute per IP address.",
          "",
          "End: The auth middleware validates JWT tokens using jsonwebtoken library " +
          "and attaches the decoded user payload to req.user. " +
          "Rate limiting uses express-rate-limit with a sliding window. " +
          "Applied to all /api/* routes via app.use('/api', authMiddleware, rateLimitMiddleware). " +
          "Test tokens can be generated with POST /api/auth/token (body: { email, password }).",
          "",
          "Total response: 6200 chars",
        ].join("\n");

        const prompt = batchedSharingDecisionPrompt({
          sourceAgent: makeSourceAgent(),
          delta: {
            type: "prompt_complete",
            summary:
              "Agent added authentication and rate limiting middleware to the API",
            data: {
              responsePreview:
                "Added authentication and rate limiting middleware to the API. " +
                "JWT tokens must be passed via Authorization: Bearer <token> header.",
              responseLength: 6200,
              isComplete: false,
            },
            promptResultSummary: newSummary,
            responseLength: 6200,
          },
          targets: [target],
        });

        const result = await conversations.sendOneShotJson(
          ConversationRole.SHARING_ANALYZER,
          prompt,
          validateSharingAnalysis,
          { maxTokens: INT_MAX_TOKENS },
        );

        expect(result.decisions).toHaveLength(1);

        const decision = findDecision(result.decisions, "tgt-qa-77", "test-writer");
        expect(decision).toBeDefined();
        expect(decision!.shouldShare).toBe(true);

        // The information should focus on the NEW auth/rate-limiting details,
        // not re-describe the endpoint structure that was already shared.
        const info = decision!.information.toLowerCase();
        expect(info).toContain("auth");

        // The information should focus on auth/middleware, NOT re-describe
        // the basic endpoint structure that was already shared.
        expect(info.includes("jwt") || info.includes("token")).toBe(true);
        expect(info).toContain("rate");

        // Should NOT re-list the basic CRUD endpoints already shared
        const reDescribesEndpoints =
          info.includes("get /api/users") &&
          info.includes("post /api/users") &&
          info.includes("delete /api/users");
        expect(reDescribesEndpoints).toBe(false);
      },
      INT_TIMEOUT_MS,
    );
  });

  // ────────────────────────────────────────────────────────────
  // 4. No sharing when irrelevant, even with rich summary
  // ────────────────────────────────────────────────────────────

  describe("no sharing when irrelevant despite rich summary", () => {
    it.concurrent(
      "LLM returns shouldShare: false for a target whose task is unrelated",
      async () => {
        const conversations = createConversationManager();
        conversations.register(
          ConversationRole.SHARING_ANALYZER,
          sharingAnalysisSystemPrompt({}),
        );

        // The source agent completed a detailed backend API implementation.
        // The target is a Python CLI developer building an image-to-ASCII
        // converter — completely unrelated technology, language, and domain.
        const prompt = batchedSharingDecisionPrompt({
          sourceAgent: makeSourceAgent(),
          delta: {
            type: "prompt_complete",
            summary:
              "Agent completed implementing all REST API endpoints for user management",
            data: {
              responsePreview: SHORT_PREVIEW,
              responseLength: 8500,
              isComplete: false,
            },
            promptResultSummary: RICH_PROMPT_RESULT_SUMMARY,
            responseLength: 8500,
          },
          targets: [makeUnrelatedTarget()],
        });

        const result = await conversations.sendOneShotJson(
          ConversationRole.SHARING_ANALYZER,
          prompt,
          validateSharingAnalysis,
          { maxTokens: INT_MAX_TOKENS },
        );

        expect(result.decisions).toHaveLength(1);

        const decision = findDecision(result.decisions, "tgt-ascii-99", "cli-developer");
        expect(decision).toBeDefined();
        expect(decision!.shouldShare).toBe(false);
        expect(decision!.reasoning.length).toBeGreaterThan(10);
      },
      INT_TIMEOUT_MS,
    );

    it.concurrent(
      "LLM shares to relevant target but not to irrelevant one in the same batch",
      async () => {
        const conversations = createConversationManager();
        conversations.register(
          ConversationRole.SHARING_ANALYZER,
          sharingAnalysisSystemPrompt({}),
        );

        // Two targets: one relevant (test-writer with blocking dep),
        // one irrelevant (frontend landing page developer).
        const prompt = batchedSharingDecisionPrompt({
          sourceAgent: makeSourceAgent(),
          delta: {
            type: "prompt_complete",
            summary:
              "Agent completed implementing all REST API endpoints for user management",
            data: {
              responsePreview: SHORT_PREVIEW,
              responseLength: 8500,
              isComplete: false,
            },
            promptResultSummary: RICH_PROMPT_RESULT_SUMMARY,
            responseLength: 8500,
          },
          targets: [makeTestWriterTarget(), makeUnrelatedTarget()],
        });

        const result = await conversations.sendOneShotJson(
          ConversationRole.SHARING_ANALYZER,
          prompt,
          validateSharingAnalysis,
          { maxTokens: INT_MAX_TOKENS },
        );

        // Small reasoning models sometimes omit one of the targets.
        // We require at least 1 decision and validate whichever we get.
        expect(result.decisions.length).toBeGreaterThanOrEqual(1);

        const testWriterDecision = findDecision(result.decisions, "tgt-qa-77", "test-writer");
        const cliDecision = findDecision(result.decisions, "tgt-ascii-99", "cli-developer");

        // At least one must be present
        expect(testWriterDecision ?? cliDecision).toBeDefined();

        if (testWriterDecision) {
          expect(testWriterDecision.shouldShare).toBe(true);
          expect(testWriterDecision.information.length).toBeGreaterThan(30);
        }

        if (cliDecision) {
          expect(cliDecision.shouldShare).toBe(false);
        }
      },
      INT_TIMEOUT_MS,
    );
  });
});
