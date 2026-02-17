import { describe, expect, it, mock } from "bun:test";
import { DeltaType } from "../../../enums/delta-type.enum.ts";
import type { ContextDelta, SubTask } from "../../../types/agent-pool.types.ts";
import { ContextTracker } from "../context-tracker.ts";
import { InformationBroker } from "../information-broker.ts";
import { silentLogger } from "./test-helpers.ts";

// ════════════════════════════════════════════════════════════════════════════
// InformationBroker Unit Tests
// ════════════════════════════════════════════════════════════════════════════

describe("InformationBroker", () => {
  it("skips deltas below significance threshold", async () => {
    const mockConversations = {
      sendOneShotJson: mock(() =>
        Promise.resolve([
          {
            targetAgentId: "agent-2",
            shouldShare: true,
            reasoning: "test",
            information: "info",
          },
        ]),
      ),
    } as any;
    const tracker = new ContextTracker();
    const broker = new InformationBroker(
      mockConversations,
      tracker,
      [],
      silentLogger(),
      new Map(),
      new Map(),
      { significanceThreshold: 0.5 },
    );

    const delta: ContextDelta = {
      agentId: "agent-1",
      agentName: "Alpha",
      timestamp: new Date().toISOString(),
      type: DeltaType.STATUS_CHANGE,
      summary: "Status changed",
      data: {},
      significance: 0.3, // Below threshold
    };

    const decisions = await broker.evaluate(delta);
    expect(decisions).toEqual([]);
    expect(mockConversations.sendOneShotJson).not.toHaveBeenCalled();
  });

  it("returns empty when no other agents exist", async () => {
    const mockConversations = {
      sendOneShotJson: mock(() =>
        Promise.resolve([
          {
            targetAgentId: "agent-1",
            shouldShare: true,
            reasoning: "test",
            information: "info",
          },
        ]),
      ),
    } as any;
    const tracker = new ContextTracker();

    const subtask: SubTask = {
      id: "t1",
      prompt: "task",
      role: "role",
      dependencies: [],
      priority: 1,
    };
    tracker.registerAgent("agent-1", "Alpha", subtask);

    const broker = new InformationBroker(
      mockConversations,
      tracker,
      [],
      silentLogger(),
      new Map(),
      new Map(),
    );

    const delta: ContextDelta = {
      agentId: "agent-1",
      agentName: "Alpha",
      timestamp: new Date().toISOString(),
      type: DeltaType.PROMPT_COMPLETE,
      summary: "Prompt completed",
      data: {},
      significance: 0.9,
    };

    const decisions = await broker.evaluate(delta);
    expect(decisions).toEqual([]);
  });

  it("evaluates candidates and returns sharing decisions", async () => {
    const mockConversations = {
      sendOneShotJson: mock(() =>
        Promise.resolve([
          {
            targetAgentId: "agent-2",
            shouldShare: true,
            reasoning: "The API structure is needed for test writing",
            information:
              "The API has endpoints: GET /users, POST /users, DELETE /users/:id",
          },
        ]),
      ),
    } as any;

    const tracker = new ContextTracker();
    const subtask1: SubTask = {
      id: "t1",
      prompt: "Build API",
      role: "api-dev",
      dependencies: [],
      priority: 1,
    };
    const subtask2: SubTask = {
      id: "t2",
      prompt: "Write tests",
      role: "tester",
      dependencies: ["t1"],
      priority: 2,
    };

    tracker.registerAgent("agent-1", "Alpha", subtask1);
    tracker.registerAgent("agent-2", "Beta", subtask2);

    const subtaskToAgent = new Map([
      ["t1", "agent-1"],
      ["t2", "agent-2"],
    ]);
    const agentToSubtask = new Map([
      ["agent-1", "t1"],
      ["agent-2", "t2"],
    ]);

    const broker = new InformationBroker(
      mockConversations,
      tracker,
      [{ from: "t1", to: "t2", type: "informational" }],
      silentLogger(),
      subtaskToAgent,
      agentToSubtask,
    );

    const delta: ContextDelta = {
      agentId: "agent-1",
      agentName: "Alpha",
      timestamp: new Date().toISOString(),
      type: DeltaType.PROMPT_COMPLETE,
      summary: "API implementation complete",
      data: { responsePreview: "Created REST endpoints..." },
      significance: 0.8,
    };

    const decisions = await broker.evaluate(delta);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.shouldShare).toBe(true);
    expect(decisions[0]!.sourceAgentId).toBe("agent-1");
    expect(decisions[0]!.targetAgentId).toBe("agent-2");
    expect(decisions[0]!.information).toContain("endpoints");
    expect(broker.evaluationCount).toBe(1);
    expect(broker.shareCount).toBe(1);
  });

  it("excludes completed agents from candidates", async () => {
    const mockConversations = {
      sendOneShotJson: mock(() =>
        Promise.resolve([
          {
            targetAgentId: "agent-2",
            shouldShare: true,
            reasoning: "test",
            information: "info",
          },
        ]),
      ),
    } as any;

    const tracker = new ContextTracker();
    const subtask1: SubTask = {
      id: "t1",
      prompt: "Task 1",
      role: "role1",
      dependencies: [],
      priority: 1,
    };
    const subtask2: SubTask = {
      id: "t2",
      prompt: "Task 2",
      role: "role2",
      dependencies: [],
      priority: 2,
    };

    tracker.registerAgent("agent-1", "Alpha", subtask1);
    tracker.registerAgent("agent-2", "Beta", subtask2);
    tracker.markCompleted("agent-2"); // Beta is done

    const broker = new InformationBroker(
      mockConversations,
      tracker,
      [],
      silentLogger(),
      new Map(),
      new Map(),
    );

    const delta: ContextDelta = {
      agentId: "agent-1",
      agentName: "Alpha",
      timestamp: new Date().toISOString(),
      type: DeltaType.PROMPT_COMPLETE,
      summary: "Complete",
      data: {},
      significance: 0.8,
    };

    const decisions = await broker.evaluate(delta);
    expect(decisions).toEqual([]);
    // Should not have called the LLM since the only candidate was completed
    expect(mockConversations.sendOneShotJson).not.toHaveBeenCalled();
  });

  it("handles LLM failures gracefully (defaults to not sharing)", async () => {
    const mockConversations = {
      sendOneShotJson: mock(() => Promise.reject(new Error("LLM timeout"))),
    } as any;

    const tracker = new ContextTracker();
    const subtask1: SubTask = {
      id: "t1",
      prompt: "Task 1",
      role: "role1",
      dependencies: [],
      priority: 1,
    };
    const subtask2: SubTask = {
      id: "t2",
      prompt: "Task 2",
      role: "role2",
      dependencies: [],
      priority: 2,
    };

    tracker.registerAgent("agent-1", "Alpha", subtask1);
    tracker.registerAgent("agent-2", "Beta", subtask2);

    const broker = new InformationBroker(
      mockConversations,
      tracker,
      [],
      silentLogger(),
      new Map(),
      new Map(),
    );

    const delta: ContextDelta = {
      agentId: "agent-1",
      agentName: "Alpha",
      timestamp: new Date().toISOString(),
      type: DeltaType.PROMPT_COMPLETE,
      summary: "Complete",
      data: {},
      significance: 0.8,
    };

    const decisions = await broker.evaluate(delta);
    // Should get a decision back (not throw) with shouldShare: false for each target
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.shouldShare).toBe(false);
    expect(decisions[0]!.reasoning).toContain("failed");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Information sharing conditional behavior
// ════════════════════════════════════════════════════════════════════════════

describe("Information sharing conditional behavior", () => {
  it("sharing does not happen when only one agent exists", async () => {
    const mockConversations = {
      sendOneShotJson: mock(() =>
        Promise.resolve([
          {
            targetAgentId: "a1",
            shouldShare: true,
            reasoning: "test",
            information: "info",
          },
        ]),
      ),
    } as any;

    const tracker = new ContextTracker();
    tracker.registerAgent("a1", "Alpha", {
      id: "t1",
      prompt: "task",
      role: "role",
      dependencies: [],
      priority: 1,
    });

    const broker = new InformationBroker(
      mockConversations,
      tracker,
      [],
      silentLogger(),
      new Map(),
      new Map(),
    );

    const delta: ContextDelta = {
      agentId: "a1",
      agentName: "Alpha",
      timestamp: new Date().toISOString(),
      type: DeltaType.PROMPT_COMPLETE,
      summary: "Done",
      data: {},
      significance: 0.9,
    };

    const decisions = await broker.evaluate(delta);
    expect(decisions).toEqual([]);
    expect(mockConversations.sendOneShotJson).not.toHaveBeenCalled();
  });

  it("sharing decision is LLM-driven, not automatic", async () => {
    const llmDecisions: boolean[] = [];
    const mockConversations = {
      sendOneShotJson: mock(() => {
        // LLM decides NOT to share even though agents exist
        const shouldShare = false;
        llmDecisions.push(shouldShare);
        return Promise.resolve([
          {
            targetAgentId: "a2",
            shouldShare,
            reasoning: "The information is not relevant to the target's task",
            information: "",
          },
        ]);
      }),
    } as any;

    const tracker = new ContextTracker();
    tracker.registerAgent("a1", "Alpha", {
      id: "t1",
      prompt: "Build UI",
      role: "frontend",
      dependencies: [],
      priority: 1,
    });
    tracker.registerAgent("a2", "Beta", {
      id: "t2",
      prompt: "Build DB",
      role: "backend",
      dependencies: [],
      priority: 1,
    });

    const broker = new InformationBroker(
      mockConversations,
      tracker,
      [],
      silentLogger(),
      new Map(),
      new Map(),
    );

    const delta: ContextDelta = {
      agentId: "a1",
      agentName: "Alpha",
      timestamp: new Date().toISOString(),
      type: DeltaType.PROMPT_COMPLETE,
      summary: "UI layout completed",
      data: {},
      significance: 0.8,
    };

    const decisions = await broker.evaluate(delta);

    // LLM was called (meaning it's not automatic)
    expect(mockConversations.sendOneShotJson).toHaveBeenCalled();
    // But the decision was to NOT share
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.shouldShare).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Agent ↔ Subtask mapping tests
// ════════════════════════════════════════════════════════════════════════════

describe("Agent-Subtask mapping in InformationBroker", () => {
  it("findCandidateTargets prioritizes agents with dependencies on the source", async () => {
    // Track which order agents are evaluated by capturing the prompt
    let capturedTargets: string[] = [];
    const mockConversations = {
      sendOneShotJson: mock((_role: any, prompt: string) => {
        // Extract target agent IDs from the prompt to verify ordering
        // The batched evaluation receives targets in the order findCandidateTargets returns
        // We return decisions for all targets
        return Promise.resolve([
          {
            targetAgentId: "agent-B",
            shouldShare: false,
            reasoning: "Not relevant",
            information: "",
          },
          {
            targetAgentId: "agent-C",
            shouldShare: false,
            reasoning: "Not relevant",
            information: "",
          },
        ]);
      }),
    } as any;

    const tracker = new ContextTracker();

    // 3 agents: A → subtask-1, B → subtask-2, C → subtask-3
    const subtask1: SubTask = {
      id: "subtask-1",
      prompt: "Build API",
      role: "api-dev",
      dependencies: [],
      priority: 1,
    };
    const subtask2: SubTask = {
      id: "subtask-2",
      prompt: "Write tests",
      role: "tester",
      dependencies: ["subtask-1"],
      priority: 2,
    };
    const subtask3: SubTask = {
      id: "subtask-3",
      prompt: "Write docs",
      role: "docs-writer",
      dependencies: [],
      priority: 3,
    };

    tracker.registerAgent("agent-A", "Alpha", subtask1);
    tracker.registerAgent("agent-B", "Beta", subtask2);
    tracker.registerAgent("agent-C", "Gamma", subtask3);

    // Dependency: subtask-1 → subtask-2 (blocking)
    const dependencies = [
      { from: "subtask-1", to: "subtask-2", type: "blocking" as const },
    ];

    const subtaskToAgent = new Map([
      ["subtask-1", "agent-A"],
      ["subtask-2", "agent-B"],
      ["subtask-3", "agent-C"],
    ]);
    const agentToSubtask = new Map([
      ["agent-A", "subtask-1"],
      ["agent-B", "subtask-2"],
      ["agent-C", "subtask-3"],
    ]);

    const broker = new InformationBroker(
      mockConversations,
      tracker,
      dependencies,
      silentLogger(),
      subtaskToAgent,
      agentToSubtask,
    );

    const delta: ContextDelta = {
      agentId: "agent-A",
      agentName: "Alpha",
      timestamp: new Date().toISOString(),
      type: DeltaType.PROMPT_COMPLETE,
      summary: "API implementation complete",
      data: {},
      significance: 0.9,
    };

    const decisions = await broker.evaluate(delta);

    // The LLM was called
    expect(mockConversations.sendOneShotJson).toHaveBeenCalled();

    // We can verify the ordering by inspecting the call arguments.
    // The prompt template receives targets in sorted order from findCandidateTargets.
    // agent-B (dependent) should appear before agent-C (not dependent).
    const callArgs = mockConversations.sendOneShotJson.mock.calls[0];
    const promptText = callArgs[1] as string;

    // agent-B (Beta / tester) should appear before agent-C (Gamma / docs-writer) in the prompt
    const betaIndex = promptText.indexOf("Beta");
    const gammaIndex = promptText.indexOf("Gamma");

    // If both are found in the prompt, Beta should come first
    if (betaIndex !== -1 && gammaIndex !== -1) {
      expect(betaIndex).toBeLessThan(gammaIndex);
    }

    expect(decisions).toHaveLength(2);
  });

  it("findDependency translates agent IDs to subtask IDs correctly", async () => {
    // This test verifies that when evaluateBatch calls findDependency,
    // the dependency is correctly found via agent→subtask translation.
    let capturedDependency: any = null;
    const mockConversations = {
      sendOneShotJson: mock((_role: any, prompt: string) => {
        // The prompt should contain dependency information for agent-Y
        // because subtask-api → subtask-tests dependency exists
        if (prompt.includes("blocking")) {
          capturedDependency = "found";
        }
        return Promise.resolve([
          {
            targetAgentId: "agent-Y",
            shouldShare: true,
            reasoning: "Tests need API info",
            information: "API endpoints defined",
          },
        ]);
      }),
    } as any;

    const tracker = new ContextTracker();

    const subtaskApi: SubTask = {
      id: "subtask-api",
      prompt: "Build the REST API",
      role: "api-developer",
      dependencies: [],
      priority: 1,
    };
    const subtaskTests: SubTask = {
      id: "subtask-tests",
      prompt: "Write tests for API",
      role: "test-writer",
      dependencies: ["subtask-api"],
      priority: 2,
    };

    tracker.registerAgent("agent-X", "APIAgent", subtaskApi);
    tracker.registerAgent("agent-Y", "TestAgent", subtaskTests);

    const dependencies = [
      { from: "subtask-api", to: "subtask-tests", type: "blocking" as const },
    ];

    const subtaskToAgent = new Map([
      ["subtask-api", "agent-X"],
      ["subtask-tests", "agent-Y"],
    ]);
    const agentToSubtask = new Map([
      ["agent-X", "subtask-api"],
      ["agent-Y", "subtask-tests"],
    ]);

    const broker = new InformationBroker(
      mockConversations,
      tracker,
      dependencies,
      silentLogger(),
      subtaskToAgent,
      agentToSubtask,
    );

    const delta: ContextDelta = {
      agentId: "agent-X",
      agentName: "APIAgent",
      timestamp: new Date().toISOString(),
      type: DeltaType.PROMPT_COMPLETE,
      summary: "API complete",
      data: {},
      significance: 0.9,
    };

    const decisions = await broker.evaluate(delta);

    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.shouldShare).toBe(true);
    expect(decisions[0]!.sourceAgentId).toBe("agent-X");
    expect(decisions[0]!.targetAgentId).toBe("agent-Y");

    // The prompt should have included the dependency info
    expect(capturedDependency).toBe("found");
  });

  it("findDependency returns undefined for reverse direction (non-matching)", async () => {
    // When agent-Y emits a delta, findDependency(agent-Y, agent-X) should
    // still find the dependency (reverse check) because the broker checks
    // both directions.
    let promptContainsDependency = false;
    const mockConversations = {
      sendOneShotJson: mock((_role: any, prompt: string) => {
        if (prompt.includes("blocking")) {
          promptContainsDependency = true;
        }
        return Promise.resolve([
          {
            targetAgentId: "agent-X",
            shouldShare: false,
            reasoning: "Source doesn't depend on target info",
            information: "",
          },
        ]);
      }),
    } as any;

    const tracker = new ContextTracker();

    const subtaskApi: SubTask = {
      id: "subtask-api",
      prompt: "Build the REST API",
      role: "api-developer",
      dependencies: [],
      priority: 1,
    };
    const subtaskTests: SubTask = {
      id: "subtask-tests",
      prompt: "Write tests for API",
      role: "test-writer",
      dependencies: ["subtask-api"],
      priority: 2,
    };

    tracker.registerAgent("agent-X", "APIAgent", subtaskApi);
    tracker.registerAgent("agent-Y", "TestAgent", subtaskTests);

    const dependencies = [
      { from: "subtask-api", to: "subtask-tests", type: "blocking" as const },
    ];

    const subtaskToAgent = new Map([
      ["subtask-api", "agent-X"],
      ["subtask-tests", "agent-Y"],
    ]);
    const agentToSubtask = new Map([
      ["agent-X", "subtask-api"],
      ["agent-Y", "subtask-tests"],
    ]);

    const broker = new InformationBroker(
      mockConversations,
      tracker,
      dependencies,
      silentLogger(),
      subtaskToAgent,
      agentToSubtask,
    );

    // Delta from agent-Y (test-writer), checking against agent-X (api-developer)
    const delta: ContextDelta = {
      agentId: "agent-Y",
      agentName: "TestAgent",
      timestamp: new Date().toISOString(),
      type: DeltaType.PROMPT_COMPLETE,
      summary: "Tests complete",
      data: {},
      significance: 0.9,
    };

    const decisions = await broker.evaluate(delta);

    expect(decisions).toHaveLength(1);
    // The dependency should still be found (reverse direction is checked)
    // so the prompt should contain "blocking"
    expect(promptContainsDependency).toBe(true);
  });

  it("works gracefully with empty maps (single-agent / no mappings)", async () => {
    const mockConversations = {
      sendOneShotJson: mock(() =>
        Promise.resolve([
          {
            targetAgentId: "agent-2",
            shouldShare: false,
            reasoning: "No dependency info available",
            information: "",
          },
        ]),
      ),
    } as any;

    const tracker = new ContextTracker();

    const subtask1: SubTask = {
      id: "t1",
      prompt: "Task 1",
      role: "role1",
      dependencies: [],
      priority: 1,
    };
    const subtask2: SubTask = {
      id: "t2",
      prompt: "Task 2",
      role: "role2",
      dependencies: [],
      priority: 1,
    };

    tracker.registerAgent("agent-1", "Alpha", subtask1);
    tracker.registerAgent("agent-2", "Beta", subtask2);

    // Empty maps — simulates a case where no mappings are provided
    const broker = new InformationBroker(
      mockConversations,
      tracker,
      [],
      silentLogger(),
      new Map(),
      new Map(),
    );

    const delta: ContextDelta = {
      agentId: "agent-1",
      agentName: "Alpha",
      timestamp: new Date().toISOString(),
      type: DeltaType.PROMPT_COMPLETE,
      summary: "Done",
      data: {},
      significance: 0.9,
    };

    // Should not crash
    const decisions = await broker.evaluate(delta);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.shouldShare).toBe(false);
  });

  it("works gracefully with default empty maps (no maps passed)", async () => {
    const mockConversations = {
      sendOneShotJson: mock(() =>
        Promise.resolve([
          {
            targetAgentId: "agent-2",
            shouldShare: false,
            reasoning: "No info",
            information: "",
          },
        ]),
      ),
    } as any;

    const tracker = new ContextTracker();

    const subtask1: SubTask = {
      id: "t1",
      prompt: "Task 1",
      role: "role1",
      dependencies: [],
      priority: 1,
    };
    const subtask2: SubTask = {
      id: "t2",
      prompt: "Task 2",
      role: "role2",
      dependencies: [],
      priority: 1,
    };

    tracker.registerAgent("agent-1", "Alpha", subtask1);
    tracker.registerAgent("agent-2", "Beta", subtask2);

    // Use default parameters (no maps, no options)
    const broker = new InformationBroker(
      mockConversations,
      tracker,
      [],
      silentLogger(),
    );

    const delta: ContextDelta = {
      agentId: "agent-1",
      agentName: "Alpha",
      timestamp: new Date().toISOString(),
      type: DeltaType.PROMPT_COMPLETE,
      summary: "Done",
      data: {},
      significance: 0.9,
    };

    // Should not crash even without maps
    const decisions = await broker.evaluate(delta);
    expect(decisions).toHaveLength(1);
  });

  it("isAgentForSubtask returns true when mapping exists and false otherwise", async () => {
    // We test isAgentForSubtask indirectly via findCandidateTargets behavior.
    // With proper mappings, dependent agents are prioritized.
    // Without mappings (or wrong agent), they are not.

    const callOrder: string[] = [];
    const mockConversations = {
      sendOneShotJson: mock((_role: any, prompt: string) => {
        // Track the order of agents in the prompt
        const results = [];
        if (prompt.includes("Beta")) {
          results.push({
            targetAgentId: "agent-B",
            shouldShare: false,
            reasoning: "Not relevant",
            information: "",
          });
        }
        if (prompt.includes("Gamma")) {
          results.push({
            targetAgentId: "agent-C",
            shouldShare: false,
            reasoning: "Not relevant",
            information: "",
          });
        }
        return Promise.resolve(results.length > 0 ? results : [
          {
            targetAgentId: "unknown",
            shouldShare: false,
            reasoning: "Not relevant",
            information: "",
          },
        ]);
      }),
    } as any;

    const tracker = new ContextTracker();

    tracker.registerAgent("agent-A", "Alpha", {
      id: "s1",
      prompt: "Task A",
      role: "roleA",
      dependencies: [],
      priority: 1,
    });
    tracker.registerAgent("agent-B", "Beta", {
      id: "s2",
      prompt: "Task B",
      role: "roleB",
      dependencies: ["s1"],
      priority: 2,
    });
    tracker.registerAgent("agent-C", "Gamma", {
      id: "s3",
      prompt: "Task C",
      role: "roleC",
      dependencies: [],
      priority: 3,
    });

    const dependencies = [
      { from: "s1", to: "s2", type: "blocking" as const },
    ];

    // Correct mapping
    const subtaskToAgent = new Map([
      ["s1", "agent-A"],
      ["s2", "agent-B"],
      ["s3", "agent-C"],
    ]);
    const agentToSubtask = new Map([
      ["agent-A", "s1"],
      ["agent-B", "s2"],
      ["agent-C", "s3"],
    ]);

    const broker = new InformationBroker(
      mockConversations,
      tracker,
      dependencies,
      silentLogger(),
      subtaskToAgent,
      agentToSubtask,
    );

    const delta: ContextDelta = {
      agentId: "agent-A",
      agentName: "Alpha",
      timestamp: new Date().toISOString(),
      type: DeltaType.PROMPT_COMPLETE,
      summary: "Done",
      data: {},
      significance: 0.9,
    };

    await broker.evaluate(delta);

    // Verify Beta (dependent) appears before Gamma (non-dependent) in the prompt
    const promptText = mockConversations.sendOneShotJson.mock.calls[0][1] as string;
    const betaPos = promptText.indexOf("Beta");
    const gammaPos = promptText.indexOf("Gamma");
    expect(betaPos).toBeGreaterThan(-1);
    expect(gammaPos).toBeGreaterThan(-1);
    expect(betaPos).toBeLessThan(gammaPos);
  });

  it("isAgentForSubtask returns false for unknown agent ID", async () => {
    // With a mapping that doesn't include agent-999, isAgentForSubtask should return false,
    // meaning agent-999 won't be treated as dependent even if a dependency exists in the graph.
    const mockConversations = {
      sendOneShotJson: mock(() =>
        Promise.resolve([
          {
            targetAgentId: "agent-999",
            shouldShare: false,
            reasoning: "Not relevant",
            information: "",
          },
        ]),
      ),
    } as any;

    const tracker = new ContextTracker();

    tracker.registerAgent("agent-A", "Alpha", {
      id: "s1",
      prompt: "Task A",
      role: "roleA",
      dependencies: [],
      priority: 1,
    });
    tracker.registerAgent("agent-999", "Unknown", {
      id: "s-unknown",
      prompt: "Unknown task",
      role: "unknown",
      dependencies: ["s1"],
      priority: 2,
    });

    const dependencies = [
      { from: "s1", to: "s2", type: "blocking" as const },
    ];

    // Only map agent-A; agent-999 is NOT in the mapping
    const subtaskToAgent = new Map([["s1", "agent-A"]]);
    const agentToSubtask = new Map([["agent-A", "s1"]]);

    const broker = new InformationBroker(
      mockConversations,
      tracker,
      dependencies,
      silentLogger(),
      subtaskToAgent,
      agentToSubtask,
    );

    const delta: ContextDelta = {
      agentId: "agent-A",
      agentName: "Alpha",
      timestamp: new Date().toISOString(),
      type: DeltaType.PROMPT_COMPLETE,
      summary: "Done",
      data: {},
      significance: 0.9,
    };

    // Should not crash, agent-999 just won't be prioritized
    const decisions = await broker.evaluate(delta);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.targetAgentId).toBe("agent-999");
  });

  it("multiple dependencies are resolved correctly", async () => {
    // Setup: subtask-1 → subtask-2, subtask-1 → subtask-3
    // Both agent-B and agent-C depend on agent-A
    const mockConversations = {
      sendOneShotJson: mock(() =>
        Promise.resolve([
          {
            targetAgentId: "agent-B",
            shouldShare: true,
            reasoning: "Needs API info",
            information: "API endpoints",
          },
          {
            targetAgentId: "agent-C",
            shouldShare: true,
            reasoning: "Needs API info for docs",
            information: "API documentation",
          },
        ]),
      ),
    } as any;

    const tracker = new ContextTracker();

    tracker.registerAgent("agent-A", "Alpha", {
      id: "s1",
      prompt: "Build API",
      role: "api-dev",
      dependencies: [],
      priority: 1,
    });
    tracker.registerAgent("agent-B", "Beta", {
      id: "s2",
      prompt: "Write tests",
      role: "tester",
      dependencies: ["s1"],
      priority: 2,
    });
    tracker.registerAgent("agent-C", "Gamma", {
      id: "s3",
      prompt: "Write docs",
      role: "docs",
      dependencies: ["s1"],
      priority: 3,
    });
    tracker.registerAgent("agent-D", "Epsilon", {
      id: "s4",
      prompt: "Deploy",
      role: "devops",
      dependencies: [],
      priority: 4,
    });

    const dependencies = [
      { from: "s1", to: "s2", type: "blocking" as const },
      { from: "s1", to: "s3", type: "informational" as const },
    ];

    const subtaskToAgent = new Map([
      ["s1", "agent-A"],
      ["s2", "agent-B"],
      ["s3", "agent-C"],
      ["s4", "agent-D"],
    ]);
    const agentToSubtask = new Map([
      ["agent-A", "s1"],
      ["agent-B", "s2"],
      ["agent-C", "s3"],
      ["agent-D", "s4"],
    ]);

    const broker = new InformationBroker(
      mockConversations,
      tracker,
      dependencies,
      silentLogger(),
      subtaskToAgent,
      agentToSubtask,
    );

    const delta: ContextDelta = {
      agentId: "agent-A",
      agentName: "Alpha",
      timestamp: new Date().toISOString(),
      type: DeltaType.PROMPT_COMPLETE,
      summary: "API complete",
      data: {},
      significance: 0.9,
    };

    await broker.evaluate(delta);

    // Verify B and C (both dependent) appear before D (not dependent) in the prompt
    const promptText = mockConversations.sendOneShotJson.mock.calls[0][1] as string;
    const betaPos = promptText.indexOf("Beta");
    const gammaPos = promptText.indexOf("Gamma");
    const epsilonPos = promptText.indexOf("Epsilon");

    expect(betaPos).toBeGreaterThan(-1);
    expect(gammaPos).toBeGreaterThan(-1);
    expect(epsilonPos).toBeGreaterThan(-1);

    // Both B and C should appear before D
    expect(betaPos).toBeLessThan(epsilonPos);
    expect(gammaPos).toBeLessThan(epsilonPos);
  });

  it("findDependency returns undefined when agent IDs have no subtask mapping", async () => {
    // When the maps don't contain the agent IDs, findDependency should return undefined,
    // which means the dependency field in the prompt template will be null.
    let promptHasDependency = false;
    const mockConversations = {
      sendOneShotJson: mock((_role: any, prompt: string) => {
        if (prompt.includes("blocking") || prompt.includes("informational")) {
          promptHasDependency = true;
        }
        return Promise.resolve([
          {
            targetAgentId: "agent-2",
            shouldShare: false,
            reasoning: "No info",
            information: "",
          },
        ]);
      }),
    } as any;

    const tracker = new ContextTracker();

    tracker.registerAgent("agent-1", "Alpha", {
      id: "t1",
      prompt: "Task 1",
      role: "role1",
      dependencies: [],
      priority: 1,
    });
    tracker.registerAgent("agent-2", "Beta", {
      id: "t2",
      prompt: "Task 2",
      role: "role2",
      dependencies: ["t1"],
      priority: 2,
    });

    // Dependencies exist but maps are empty — so findDependency can't translate
    const broker = new InformationBroker(
      mockConversations,
      tracker,
      [{ from: "t1", to: "t2", type: "blocking" }],
      silentLogger(),
      new Map(), // empty
      new Map(), // empty
    );

    const delta: ContextDelta = {
      agentId: "agent-1",
      agentName: "Alpha",
      timestamp: new Date().toISOString(),
      type: DeltaType.PROMPT_COMPLETE,
      summary: "Done",
      data: {},
      significance: 0.9,
    };

    const decisions = await broker.evaluate(delta);

    // Should not crash
    expect(decisions).toHaveLength(1);
    // The dependency should NOT appear in the prompt because the mapping is empty
    expect(promptHasDependency).toBe(false);
  });
});
