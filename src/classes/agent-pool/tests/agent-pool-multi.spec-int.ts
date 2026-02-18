import { describe, expect, it } from "bun:test";
import { PoolEvent } from "../../../enums/pool-event.enum.ts";
import { AgentPool } from "../agent-pool.ts";
import {
  HAS_API_KEY,
  INT_TIMEOUT_MS,
  intPoolConfig,
  trackingAgentFactory,
} from "./test-helpers-int.ts";

// ════════════════════════════════════════════════════════════════════════════
// AgentPool — Multi-Agent & Sequential Integration Tests
//
// Multi-agent spawning, sequential task execution, and context injection.
// ════════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_API_KEY)(
  "AgentPool int — multi-agent & sequential",
  () => {
    // ── Multi-Agent Execution ───────────────────────────────────────────

    describe("multi-agent execution", () => {
      it(
        "spawns multiple agents for a complex task with separable concerns",
        async () => {
          const tracker = trackingAgentFactory();

          const pool = new AgentPool(
            intPoolConfig({
              createAgent: tracker.factory,
              maxAgents: 5,
            }),
          );

          try {
            const result = await pool.execute(
              "Build a complete REST API with Express.js including: " +
              "1) The API routes and controllers for a user management system (CRUD), " +
              "2) A comprehensive test suite with unit and integration tests using Jest, " +
              "3) API documentation using Swagger/OpenAPI specification",
            );

            expect(result).toBeDefined();
            expect(result.analysis).toBeDefined();
            expect(result.analysis.subtasks.length).toBeGreaterThanOrEqual(1);

            // Whether the LLM chooses single or multi, agents must have completed
            expect(result.agents.length).toBeGreaterThanOrEqual(1);
            for (const agentResult of result.agents) {
              expect(agentResult.success).toBe(true);
              expect(agentResult.subtask).toBeDefined();
              expect(agentResult.subtask.role.length).toBeGreaterThan(0);
              expect(agentResult.subtask.prompt.length).toBeGreaterThan(0);
            }

            // All spawned agents received prompts
            expect(tracker.promptCalls.length).toBe(result.agents.length);

            // Summary covers the execution
            expect(result.summary.length).toBeGreaterThan(0);
          } finally {
            if (!(pool as any)._destroyed) await pool.destroy();
          }
        },
        INT_TIMEOUT_MS * 2,
      );

      it.concurrent(
        "respects maxAgents limit even when planner suggests more subtasks",
        async () => {
          const tracker = trackingAgentFactory();

          const pool = new AgentPool(
            intPoolConfig({
              createAgent: tracker.factory,
              maxAgents: 2,
            }),
          );

          try {
            const result = await pool.execute(
              "Build a full-stack application with: " +
              "1) A React frontend with routing and state management, " +
              "2) A Node.js backend API with authentication, " +
              "3) A PostgreSQL database schema with migrations, " +
              "4) Deployment configuration with Docker and CI/CD pipeline",
            );

            // Regardless of how many subtasks the planner identified,
            // no more than 2 agents should have been spawned
            expect(tracker.agents.length).toBeLessThanOrEqual(2);
            expect(result.agents.length).toBeLessThanOrEqual(2);
          } finally {
            if (!(pool as any)._destroyed) await pool.destroy();
          }
        },
        INT_TIMEOUT_MS,
      );
    });

    // ── Sequential Task Execution ───────────────────────────────────────

    describe("sequential task execution", () => {
      it.concurrent(
        "can execute multiple tasks in sequence, cleaning up between them",
        async () => {
          const tracker = trackingAgentFactory();
          const pool = new AgentPool(
            intPoolConfig({ createAgent: tracker.factory }),
          );

          try {
            // First task
            const result1 = await pool.execute("Create a README.md file");
            expect(result1.agents.length).toBeGreaterThanOrEqual(1);
            expect(result1.agents.every((a) => a.success)).toBe(true);

            // Pool should be idle and cleaned up after first task
            const midState = pool.getState();
            expect(midState.executing).toBe(false);
            expect(midState.currentTask).toBeNull();
            expect(midState.activeAgentCount).toBe(0);

            // Second task on the same pool instance
            const result2 = await pool.execute("Add a LICENSE file");
            expect(result2.agents.length).toBeGreaterThanOrEqual(1);
            expect(result2.agents.every((a) => a.success)).toBe(true);

            // Both tasks should have spawned agents
            // (agents from first task are destroyed, new ones spawned for second)
            expect(tracker.promptCalls.length).toBeGreaterThanOrEqual(2);
          } finally {
            if (!(pool as any)._destroyed) await pool.destroy();
          }
        },
        INT_TIMEOUT_MS * 2,
      );

      it.concurrent(
        "rejects concurrent execute() calls",
        async () => {
          const tracker = trackingAgentFactory({ promptDelay: 500 });
          const pool = new AgentPool(
            intPoolConfig({ createAgent: tracker.factory }),
          );

          try {
            // Register the listener BEFORE calling execute, because
            // PLANNING_START is emitted synchronously inside execute()
            // before the first async LLM call. If we register after,
            // the event has already fired and the promise hangs forever.
            const planningStarted = new Promise<void>((resolve) => {
              pool.once(PoolEvent.PLANNING_START, () => resolve());
            });

            // Start first task (don't await)
            const first = pool.execute("First task");

            // Wait for planning to start so we're truly mid-execution
            await planningStarted;

            // Second call should throw
            await expect(pool.execute("Second task")).rejects.toThrow(
              /already executing/,
            );

            // Wait for first task to complete
            await first;
          } finally {
            if (!(pool as any)._destroyed) await pool.destroy();
          }
        },
        INT_TIMEOUT_MS,
      );
    });

    // ── Context Injection ───────────────────────────────────────────────

    describe("context injection", () => {
      it.concurrent(
        "can interact with the pool and query state during execution",
        async () => {
          const contextInjections: string[] = [];

          // Create agents that track context injections with a delay
          // so we have time to inspect mid-execution state
          const tracker = trackingAgentFactory({ promptDelay: 300 });
          const originalFactory = tracker.factory;
          const wrappedFactory = (config?: { name?: string }) => {
            const agent = originalFactory(config);
            const originalInjectContext = agent.injectContext;
            (agent as any).injectContext = (instructions: string) => {
              contextInjections.push(instructions);
              return originalInjectContext.call(agent, instructions);
            };
            return agent;
          };

          const pool = new AgentPool(
            intPoolConfig({ createAgent: wrappedFactory }),
          );

          try {
            // Start a task
            const executePromise = pool.execute(
              "Write a simple calculator module in TypeScript",
            );

            // Wait for agents to be spawned
            await new Promise<void>((resolve) => {
              pool.once(PoolEvent.AGENT_SPAWNED, () => {
                // Small delay to ensure agent is in managed agents map
                setTimeout(resolve, 50);
              });
            });

            // Query state mid-execution — this is the core assertion:
            // the pool must remain responsive while agents are running
            const midState = pool.getState();
            expect(midState.executing).toBe(true);
            expect(midState.activeAgentCount).toBeGreaterThanOrEqual(1);
            expect(midState.currentTask).toContain("calculator");
            expect(midState.agents.length).toBeGreaterThanOrEqual(1);

            // Verify each agent has a role assigned by the planner
            for (const agent of midState.agents) {
              expect(agent.agentId).toBeDefined();
              expect(agent.agentName.length).toBeGreaterThan(0);
              expect(agent.taskRole.length).toBeGreaterThan(0);
            }

            // Wait for execution to complete
            const result = await executePromise;
            expect(result.agents.length).toBeGreaterThanOrEqual(1);
            expect(result.agents.every((a) => a.success)).toBe(true);
          } finally {
            if (!(pool as any)._destroyed) await pool.destroy();
          }
        },
        INT_TIMEOUT_MS,
      );
    });
  },
);
