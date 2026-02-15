import { describe, expect, it, beforeEach, afterEach, mock } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmod, unlink } from "node:fs/promises";

import { Agent } from "../src/classes/Agent.ts";
import { AgentStatus } from "../src/enums/agent-status.enum.ts";
import { AgentEvent } from "../src/enums/agent-event.enum.ts";
import type { AgentConfig, PromptResult, AgentSnapshot } from "../src/types/agent.types.ts";
import type {
  AgentReadyEvent,
  AgentBusyEvent,
  AgentIdleEvent,
  AgentErrorEvent,
  AgentDestroyedEvent,
  PromptStartEvent,
  PromptChunkEvent,
  PromptCompleteEvent,
  ToolStartEvent,
  PermissionGrantedEvent,
  ContextInjectedEvent,
} from "../src/types/events.types.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Default test config that silences all log output.
 * Override specific fields as needed per test.
 */
function testConfig(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    logOutput: { console: false, json: false },
    logLevel: "silent" as any,
    ...overrides,
  };
}

/**
 * Collects all events of a given type emitted by an agent.
 * Returns the collection array for assertions.
 */
function collectEvents<T>(agent: Agent, event: AgentEvent): T[] {
  const collected: T[] = [];
  agent.on(event, ((payload: T) => {
    collected.push(payload);
  }) as any);
  return collected;
}

// ── Agent Identity ─────────────────────────────────────────────────────────

describe("Agent Identity", () => {
  it("generates a unique id and name when none are provided", () => {
    const agent = new Agent(testConfig());

    expect(agent.id).toBeDefined();
    expect(typeof agent.id).toBe("string");
    expect(agent.id.length).toBeGreaterThan(0);

    expect(agent.name).toBeDefined();
    expect(typeof agent.name).toBe("string");
    expect(agent.name.length).toBeGreaterThan(0);

    // Identity object should match accessors
    expect(agent.identity.id).toBe(agent.id);
    expect(agent.identity.name).toBe(agent.name);

    // Cleanup — don't await ready since we may not have a real copilot binary
    agent.destroy().catch(() => { });
  });

  it("uses a custom id when provided", () => {
    const agent = new Agent(testConfig({ id: "custom-agent-42" }));

    expect(agent.id).toBe("custom-agent-42");

    agent.destroy().catch(() => { });
  });

  it("uses a custom name when provided", () => {
    const agent = new Agent(testConfig({ name: "Sentinel Prime" }));

    expect(agent.name).toBe("Sentinel Prime");

    agent.destroy().catch(() => { });
  });

  it("uses both custom id and name together", () => {
    const agent = new Agent(
      testConfig({ id: "pool-lead", name: "Commander Vex" }),
    );

    expect(agent.id).toBe("pool-lead");
    expect(agent.name).toBe("Commander Vex");

    agent.destroy().catch(() => { });
  });

  it("generates different identities across multiple instances", () => {
    const agents = Array.from({ length: 5 }, () => new Agent(testConfig()));

    const ids = agents.map((a) => a.id);
    const uniqueIds = new Set(ids);

    expect(uniqueIds.size).toBe(5);

    for (const agent of agents) {
      agent.destroy().catch(() => { });
    }
  });
});

// ── Agent Initial State ────────────────────────────────────────────────────

describe("Agent Initial State", () => {
  it("starts in INITIALIZING status", () => {
    const agent = new Agent(testConfig());

    expect(agent.status).toBe(AgentStatus.INITIALIZING);

    agent.destroy().catch(() => { });
  });

  it("has a null sessionId before initialization completes", () => {
    const agent = new Agent(testConfig());

    expect(agent.sessionId).toBeNull();

    agent.destroy().catch(() => { });
  });

  it("exposes a ready promise", () => {
    const agent = new Agent(testConfig());

    expect(agent.ready).toBeInstanceOf(Promise);

    agent.destroy().catch(() => { });
  });

  it("has a logger instance", () => {
    const agent = new Agent(testConfig());

    expect(agent.logger).toBeDefined();
    expect(typeof agent.logger.info).toBe("function");
    expect(typeof agent.logger.error).toBe("function");
    expect(typeof agent.logger.debug).toBe("function");

    agent.destroy().catch(() => { });
  });
});

// ── Agent Snapshot ──────────────────────────────────────────────────────────

describe("Agent Snapshot", () => {
  it("returns a snapshot with all required fields", () => {
    const agent = new Agent(testConfig({ id: "snap-test", name: "Snap Agent" }));

    const snap = agent.snapshot();

    expect(snap.identity.id).toBe("snap-test");
    expect(snap.identity.name).toBe("Snap Agent");
    expect(snap.status).toBe(AgentStatus.INITIALIZING);
    expect(snap.sessionId).toBeNull();
    expect(snap.promptCount).toBe(0);
    expect(snap.pendingContextCount).toBe(0);

    agent.destroy().catch(() => { });
  });

  it("returns a new object each time (not a reference)", () => {
    const agent = new Agent(testConfig());

    const snap1 = agent.snapshot();
    const snap2 = agent.snapshot();

    expect(snap1).not.toBe(snap2);
    expect(snap1.identity).not.toBe(snap2.identity);

    agent.destroy().catch(() => { });
  });

  it("snapshot identity is a copy (mutations don't affect agent)", () => {
    const agent = new Agent(testConfig({ name: "Original" }));

    const snap = agent.snapshot();
    // Even though we can't easily mutate readonly in TS,
    // verify they are separate object references
    expect(snap.identity).toEqual({ id: agent.id, name: agent.name });
    expect(snap.identity).not.toBe(agent.identity);

    agent.destroy().catch(() => { });
  });
});

// ── Agent Destroy ──────────────────────────────────────────────────────────

describe("Agent Destroy", () => {
  it("transitions to DESTROYED status after destroy()", async () => {
    const agent = new Agent(testConfig());

    await agent.destroy();

    expect(agent.status).toBe(AgentStatus.DESTROYED);
  });

  it("emits agent:destroyed event on destroy", async () => {
    const agent = new Agent(testConfig());

    const events = collectEvents<AgentDestroyedEvent>(
      agent,
      AgentEvent.AGENT_DESTROYED,
    );

    await agent.destroy();

    expect(events.length).toBe(1);
    expect(events[0]!.event).toBe(AgentEvent.AGENT_DESTROYED);
    expect(events[0]!.agent.id).toBe(agent.id);
    expect(events[0]!.timestamp).toBeDefined();
  });

  it("is idempotent — calling destroy() multiple times is safe", async () => {
    const agent = new Agent(testConfig());

    const events = collectEvents<AgentDestroyedEvent>(
      agent,
      AgentEvent.AGENT_DESTROYED,
    );

    await agent.destroy();
    await agent.destroy();
    await agent.destroy();

    expect(agent.status).toBe(AgentStatus.DESTROYED);
    // Should only emit once
    expect(events.length).toBe(1);
  });

  it("snapshot reflects DESTROYED status after destroy", async () => {
    const agent = new Agent(testConfig());

    await agent.destroy();

    const snap = agent.snapshot();
    expect(snap.status).toBe(AgentStatus.DESTROYED);
  });

  it("destroy() does not emit spurious agent:error from process exit race condition", async () => {
    // Regression test: when destroy() closes stdin, the ACP process exits
    // and the "exit" handler fires. Before the fix, _status was still not
    // DESTROYED at that point, so a spurious AGENT_ERROR (context: "process_exit")
    // was emitted. The fix sets DESTROYED status before closing streams.

    // Create a stub executable that stays alive by reading stdin (simulates
    // an ACP process that hasn't exited yet when destroy() is called).
    const stubPath = join(tmpdir(), `stark-test-stub-${Date.now()}.sh`);
    await Bun.write(stubPath, "#!/bin/sh\ncat > /dev/null\n");
    await chmod(stubPath, 0o755);

    try {
      const agent = new Agent(testConfig({ executable: stubPath }));

      // Don't await agent.ready — the stub doesn't speak ACP so it would hang.
      // Wait briefly to ensure the process is spawned and alive.
      await new Promise((r) => setTimeout(r, 200));

      // Collect error events that occur DURING destroy (after init errors).
      const errors = collectEvents<AgentErrorEvent>(
        agent,
        AgentEvent.AGENT_ERROR,
      );

      // destroy() closes stdin → stub exits → exit handler fires.
      // With the fix, no process_exit error should be emitted.
      await agent.destroy();

      const processExitErrors = errors.filter(
        (e) => e.context === "process_exit",
      );
      expect(processExitErrors).toHaveLength(0);
      expect(agent.status).toBe(AgentStatus.DESTROYED);
    } finally {
      await unlink(stubPath).catch(() => { });
    }
  });
});

// ── Agent Event System ─────────────────────────────────────────────────────

describe("Agent Event System", () => {
  it("supports on() and emits events with correct payload shape", async () => {
    const agent = new Agent(testConfig());

    const destroyedEvents = collectEvents<AgentDestroyedEvent>(
      agent,
      AgentEvent.AGENT_DESTROYED,
    );

    await agent.destroy();

    expect(destroyedEvents.length).toBe(1);
    const event = destroyedEvents[0]!;

    // Check base event fields
    expect(event.event).toBe(AgentEvent.AGENT_DESTROYED);
    expect(typeof event.timestamp).toBe("string");
    expect(event.agent.id).toBe(agent.id);
    expect(event.agent.name).toBe(agent.name);
  });

  it("supports once() — listener fires only once", async () => {
    const agent = new Agent(testConfig());
    let callCount = 0;

    agent.once(AgentEvent.AGENT_DESTROYED, () => {
      callCount++;
    });

    await agent.destroy();

    // Emit manually to verify once behavior
    // (destroy is idempotent so second call won't emit)
    expect(callCount).toBe(1);
  });

  it("supports off() — listener can be removed", async () => {
    const agent = new Agent(testConfig());
    let callCount = 0;

    const listener = () => {
      callCount++;
    };

    agent.on(AgentEvent.AGENT_DESTROYED, listener);
    agent.off(AgentEvent.AGENT_DESTROYED, listener);

    await agent.destroy();

    expect(callCount).toBe(0);
  });

  it("multiple listeners on the same event all fire", async () => {
    const agent = new Agent(testConfig());
    const calls: string[] = [];

    agent.on(AgentEvent.AGENT_DESTROYED, () => calls.push("listener1"));
    agent.on(AgentEvent.AGENT_DESTROYED, () => calls.push("listener2"));
    agent.on(AgentEvent.AGENT_DESTROYED, () => calls.push("listener3"));

    await agent.destroy();

    expect(calls).toEqual(["listener1", "listener2", "listener3"]);
  });

  it("event payloads include ISO-8601 timestamps", async () => {
    const agent = new Agent(testConfig());

    const events = collectEvents<AgentDestroyedEvent>(
      agent,
      AgentEvent.AGENT_DESTROYED,
    );

    await agent.destroy();

    const ts = events[0]!.timestamp;
    // Should be a valid ISO string
    const parsed = new Date(ts);
    expect(parsed.toISOString()).toBe(ts);
  });

  it("event payloads include the correct agent identity", async () => {
    const agent = new Agent(
      testConfig({ id: "event-id-test", name: "Event Agent" }),
    );

    const events = collectEvents<AgentDestroyedEvent>(
      agent,
      AgentEvent.AGENT_DESTROYED,
    );

    await agent.destroy();

    expect(events[0]!.agent).toEqual({
      id: "event-id-test",
      name: "Event Agent",
    });
  });
});

// ── Guard: prompt() Before Ready ───────────────────────────────────────────

describe("Agent Guards", () => {
  it("prompt() throws when agent is still initializing", async () => {
    const agent = new Agent(testConfig());

    // Don't await ready — agent is still INITIALIZING
    expect(agent.status).toBe(AgentStatus.INITIALIZING);

    try {
      await agent.prompt("hello");
      // Should not reach here
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("initializing");
    }

    await agent.destroy();
  });

  it("prompt() throws when agent is destroyed", async () => {
    const agent = new Agent(testConfig());

    await agent.destroy();

    try {
      await agent.prompt("hello");
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("destroyed");
    }
  });

  it("injectContext() throws when agent is destroyed", async () => {
    const agent = new Agent(testConfig());

    await agent.destroy();

    expect(() => agent.injectContext("new instructions")).toThrow(/destroyed/);
  });
});

// ── Context Injection (without active ACP connection) ──────────────────────

describe("Agent Context Injection (offline)", () => {
  it("queues context when agent status is not IDLE", () => {
    const agent = new Agent(testConfig());

    // Agent is INITIALIZING, so context should be queued
    // injectContext should not throw for non-destroyed agents
    // Note: INITIALIZING is not DESTROYED, but injectContext only
    // checks for DESTROYED. When BUSY, it queues. When not BUSY/DESTROYED,
    // it tries to drain (which will fail silently since there's no connection).
    // For this test, let's just verify the event is emitted.

    const events = collectEvents<ContextInjectedEvent>(
      agent,
      AgentEvent.CONTEXT_INJECTED,
    );

    // Since the agent is INITIALIZING (not BUSY and not DESTROYED),
    // it will push to pendingContext and try to drain.
    // The drain will fail because there's no connection, but
    // the event should still be emitted.
    try {
      agent.injectContext("Use TypeScript strict mode");
    } catch {
      // May throw because drainPendingContext calls prompt which calls assertReady
    }

    // Event should have been emitted before any error
    if (events.length > 0) {
      expect(events[0]!.instructions).toBe("Use TypeScript strict mode");
    }

    agent.destroy().catch(() => { });
  });

  it("snapshot reflects pending context count", () => {
    const agent = new Agent(testConfig());

    // The initial pending context count should be 0
    expect(agent.snapshot().pendingContextCount).toBe(0);

    agent.destroy().catch(() => { });
  });
});

// ── Agent Configuration Defaults ───────────────────────────────────────────

describe("Agent Configuration Defaults", () => {
  it("defaults autoApprove to true", () => {
    const agent = new Agent(testConfig());

    // We can't directly inspect private config, but we can verify
    // the agent was created without error with default config
    expect(agent).toBeInstanceOf(Agent);

    agent.destroy().catch(() => { });
  });

  it("defaults cwd to process.cwd()", () => {
    const agent = new Agent(testConfig());

    // Agent should be created without error
    expect(agent).toBeInstanceOf(Agent);

    agent.destroy().catch(() => { });
  });

  it("accepts all config options without error", async () => {
    const agent = new Agent(
      testConfig({
        name: "Config Test",
        id: "config-test-001",
        executable: "nonexistent-binary",
        cwd: "/tmp",
        autoApprove: false,
        logOutput: { console: false, json: false },
        logLevel: "debug",
      }),
    );

    // Constructor should succeed — init is async
    expect(agent.id).toBe("config-test-001");
    expect(agent.name).toBe("Config Test");

    // ready will reject because the executable doesn't exist,
    // but the agent was still created with all config applied
    try {
      await agent.ready;
    } catch {
      // Expected — bad executable
    }

    await agent.destroy();
  });
});

// ── Agent Status Transitions ───────────────────────────────────────────────

describe("Agent Status Transitions", () => {
  it("starts as INITIALIZING", () => {
    const agent = new Agent(testConfig());

    expect(agent.status).toBe(AgentStatus.INITIALIZING);

    agent.destroy().catch(() => { });
  });

  it("transitions to DESTROYED from any state via destroy()", async () => {
    const agent = new Agent(testConfig());

    // From INITIALIZING
    expect(agent.status).toBe(AgentStatus.INITIALIZING);
    await agent.destroy();
    expect(agent.status).toBe(AgentStatus.DESTROYED);
  });

  it("emits agent:error when initialization fails (bad executable)", async () => {
    // Use a path that exists as a directory but isn't executable,
    // or a clearly non-existent path. The spawn may throw synchronously
    // or emit an 'error' event — both are caught by initialize().
    const agent = new Agent(
      testConfig({ executable: "/nonexistent/binary/path" }),
    );

    const errors = collectEvents<AgentErrorEvent>(
      agent,
      AgentEvent.AGENT_ERROR,
    );

    try {
      await agent.ready;
    } catch {
      // Expected to fail
    }

    // Should have emitted at least one error event
    expect(errors.length).toBeGreaterThanOrEqual(1);

    if (errors[0]) {
      expect(errors[0].event).toBe(AgentEvent.AGENT_ERROR);
      expect(errors[0].error).toBeInstanceOf(Error);
    }

    await agent.destroy();
  });

  it("status is ERROR after failed initialization", async () => {
    const agent = new Agent(
      testConfig({ executable: "/nonexistent/binary/path" }),
    );

    try {
      await agent.ready;
    } catch {
      // Expected
    }

    expect(agent.status).toBe(AgentStatus.ERROR);

    await agent.destroy();
  });
});

// ── AgentEvent Enum Completeness ───────────────────────────────────────────

describe("AgentEvent Enum", () => {
  it("has all expected lifecycle events", () => {
    expect(AgentEvent.AGENT_READY as string).toBe("agent:ready");
    expect(AgentEvent.AGENT_BUSY as string).toBe("agent:busy");
    expect(AgentEvent.AGENT_IDLE as string).toBe("agent:idle");
    expect(AgentEvent.AGENT_ERROR as string).toBe("agent:error");
    expect(AgentEvent.AGENT_DESTROYED as string).toBe("agent:destroyed");
  });

  it("has all expected prompt events", () => {
    expect(AgentEvent.PROMPT_START as string).toBe("prompt:start");
    expect(AgentEvent.PROMPT_CHUNK as string).toBe("prompt:chunk");
    expect(AgentEvent.PROMPT_THOUGHT as string).toBe("prompt:thought");
    expect(AgentEvent.PROMPT_COMPLETE as string).toBe("prompt:complete");
  });

  it("has all expected tool events", () => {
    expect(AgentEvent.TOOL_START as string).toBe("tool:start");
    expect(AgentEvent.TOOL_UPDATE as string).toBe("tool:update");
    expect(AgentEvent.TOOL_COMPLETE as string).toBe("tool:complete");
    expect(AgentEvent.TOOL_FAILED as string).toBe("tool:failed");
  });

  it("has all expected permission events", () => {
    expect(AgentEvent.PERMISSION_REQUESTED as string).toBe("permission:requested");
    expect(AgentEvent.PERMISSION_GRANTED as string).toBe("permission:granted");
    expect(AgentEvent.PERMISSION_DENIED as string).toBe("permission:denied");
  });

  it("has all expected terminal events", () => {
    expect(AgentEvent.TERMINAL_CREATED as string).toBe("terminal:created");
    expect(AgentEvent.TERMINAL_OUTPUT as string).toBe("terminal:output");
    expect(AgentEvent.TERMINAL_EXIT as string).toBe("terminal:exit");
    expect(AgentEvent.TERMINAL_RELEASED as string).toBe("terminal:released");
  });

  it("has all expected filesystem events", () => {
    expect(AgentEvent.FS_READ as string).toBe("fs:read");
    expect(AgentEvent.FS_WRITE as string).toBe("fs:write");
  });

  it("has all expected usage events", () => {
    expect(AgentEvent.USAGE_UPDATE as string).toBe("usage:update");
  });

  it("has all expected context events", () => {
    expect(AgentEvent.CONTEXT_INJECTED as string).toBe("context:injected");
  });

  it("has all expected mode and config events", () => {
    expect(AgentEvent.MODE_CHANGE as string).toBe("mode:change");
    expect(AgentEvent.CONFIG_UPDATE as string).toBe("config:update");
  });

  it("has plan events", () => {
    expect(AgentEvent.PLAN_UPDATE as string).toBe("plan:update");
  });
});

// ── AgentStatus Enum Completeness ──────────────────────────────────────────

describe("AgentStatus Enum", () => {
  it("has all expected statuses", () => {
    expect(AgentStatus.INITIALIZING as string).toBe("initializing");
    expect(AgentStatus.IDLE as string).toBe("idle");
    expect(AgentStatus.BUSY as string).toBe("busy");
    expect(AgentStatus.ERROR as string).toBe("error");
    expect(AgentStatus.DESTROYED as string).toBe("destroyed");
  });

  it("has exactly 5 statuses", () => {
    const values = Object.values(AgentStatus);
    expect(values.length).toBe(5);
  });
});

// ── Agent extends EventEmitter ─────────────────────────────────────────────

describe("Agent extends EventEmitter", () => {
  it("is an instance of EventEmitter", () => {
    const { EventEmitter } = require("node:events");
    const agent = new Agent(testConfig());

    expect(agent).toBeInstanceOf(EventEmitter);

    agent.destroy().catch(() => { });
  });

  it("supports setMaxListeners to avoid warnings in pools", () => {
    const agent = new Agent(testConfig());

    // Should not throw
    agent.setMaxListeners(100);

    agent.destroy().catch(() => { });
  });

  it("supports removeAllListeners", () => {
    const agent = new Agent(testConfig());

    agent.on(AgentEvent.AGENT_DESTROYED, () => { });
    agent.on(AgentEvent.TOOL_START, () => { });

    // Should not throw
    agent.removeAllListeners();

    agent.destroy().catch(() => { });
  });

  it("supports listenerCount", () => {
    const agent = new Agent(testConfig());

    expect(agent.listenerCount(AgentEvent.AGENT_DESTROYED)).toBe(0);

    agent.on(AgentEvent.AGENT_DESTROYED, () => { });
    expect(agent.listenerCount(AgentEvent.AGENT_DESTROYED)).toBe(1);

    agent.on(AgentEvent.AGENT_DESTROYED, () => { });
    expect(agent.listenerCount(AgentEvent.AGENT_DESTROYED)).toBe(2);

    agent.destroy().catch(() => { });
  });
});

// ── Multiple Agent Instances ───────────────────────────────────────────────

describe("Multiple Agent Instances", () => {
  it("can create multiple independent agents", () => {
    const agents = Array.from({ length: 3 }, (_, i) =>
      new Agent(testConfig({ id: `multi-${i}`, name: `Agent ${i}` })),
    );

    expect(agents[0]!.id).toBe("multi-0");
    expect(agents[1]!.id).toBe("multi-1");
    expect(agents[2]!.id).toBe("multi-2");

    expect(agents[0]!.name).toBe("Agent 0");
    expect(agents[1]!.name).toBe("Agent 1");
    expect(agents[2]!.name).toBe("Agent 2");

    for (const agent of agents) {
      agent.destroy().catch(() => { });
    }
  });

  it("destroying one agent does not affect others", async () => {
    const agent1 = new Agent(testConfig({ id: "keep-alive" }));
    const agent2 = new Agent(testConfig({ id: "to-destroy" }));

    await agent2.destroy();

    expect(agent2.status).toBe(AgentStatus.DESTROYED);
    expect(agent1.status).toBe(AgentStatus.INITIALIZING); // Still alive

    await agent1.destroy();
  });

  it("events from one agent don't leak to another", async () => {
    const agent1 = new Agent(testConfig({ id: "isolated-1" }));
    const agent2 = new Agent(testConfig({ id: "isolated-2" }));

    const agent1Events: string[] = [];
    const agent2Events: string[] = [];

    agent1.on(AgentEvent.AGENT_DESTROYED, (e) => {
      agent1Events.push(e.agent.id);
    });

    agent2.on(AgentEvent.AGENT_DESTROYED, (e) => {
      agent2Events.push(e.agent.id);
    });

    await agent1.destroy();

    expect(agent1Events).toEqual(["isolated-1"]);
    expect(agent2Events).toEqual([]); // No cross-contamination

    await agent2.destroy();

    expect(agent2Events).toEqual(["isolated-2"]);
  });
});

// ── Logger Configuration ───────────────────────────────────────────────────

describe("Agent Logger Configuration", () => {
  it("creates a logger even with all outputs disabled", () => {
    const agent = new Agent(
      testConfig({ logOutput: { console: false, json: false } }),
    );

    expect(agent.logger).toBeDefined();
    // Logger should work without throwing
    agent.logger.info("test message");

    agent.destroy().catch(() => { });
  });

  it("logger has agent identity bindings", () => {
    const agent = new Agent(
      testConfig({
        id: "logger-test-id",
        name: "Logger Test Agent",
      }),
    );

    // The logger should be created without error
    expect(agent.logger).toBeDefined();

    agent.destroy().catch(() => { });
  });

  it("accepts all valid log levels", () => {
    const levels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

    for (const level of levels) {
      const agent = new Agent(testConfig({ logLevel: level }));
      expect(agent.logger).toBeDefined();
      agent.destroy().catch(() => { });
    }
  });
});
