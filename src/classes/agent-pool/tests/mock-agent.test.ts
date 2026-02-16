import { describe, expect, it } from "bun:test";

import { AgentEvent } from "../../../enums/agent-event.enum.ts";
import { AgentStatus } from "../../../enums/agent-status.enum.ts";
import type { PromptResult } from "../../../types/agent.types.ts";
import { createMockAgent, createMockAgentFactory } from "./test-helpers.ts";

// ════════════════════════════════════════════════════════════════════════════
// Mock Agent Factory Tests
// ════════════════════════════════════════════════════════════════════════════

describe("Mock Agent (test infrastructure)", () => {
	it("creates agents with correct interface", () => {
		const agent = createMockAgent({ name: "TestAgent" });

		expect(agent.id).toBeDefined();
		expect(agent.name).toBe("TestAgent");
		expect(agent.status).toBe(AgentStatus.IDLE);
		expect(agent.identity.id).toBe(agent.id);
		expect(agent.identity.name).toBe(agent.name);
	});

	it("prompt returns configured result", async () => {
		const customResult: PromptResult = {
			stopReason: "end_turn",
			text: "Custom response",
			usage: { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
		};

		const agent = createMockAgent({ promptResult: customResult });
		const result = await agent.prompt("test prompt");

		expect(result.text).toBe("Custom response");
		expect(result.stopReason).toBe("end_turn");
	});

	it("prompt throws configured error", async () => {
		const agent = createMockAgent({
			promptError: new Error("Prompt failed"),
		});

		await expect(agent.prompt("test")).rejects.toThrow("Prompt failed");
	});

	it("ready rejects with configured error", async () => {
		const agent = createMockAgent({
			readyError: new Error("Init failed"),
		});

		await expect(agent.ready).rejects.toThrow("Init failed");
	});

	it("emits events during prompt execution", async () => {
		const agent = createMockAgent();
		const events: string[] = [];

		agent.on(AgentEvent.AGENT_BUSY, () => events.push("busy"));
		agent.on(AgentEvent.PROMPT_COMPLETE, () => events.push("complete"));
		agent.on(AgentEvent.AGENT_IDLE, () => events.push("idle"));

		await agent.prompt("test");

		expect(events).toEqual(["busy", "complete", "idle"]);
	});

	it("destroy transitions to DESTROYED status", async () => {
		const agent = createMockAgent();
		expect(agent.status).toBe(AgentStatus.IDLE);

		await agent.destroy();
		expect(agent.status).toBe(AgentStatus.DESTROYED);
	});

	it("snapshot returns correct data", () => {
		const agent = createMockAgent({ id: "test-id", name: "TestName" });
		const snap = agent.snapshot();

		expect(snap.identity.id).toBe("test-id");
		expect(snap.identity.name).toBe("TestName");
		expect(snap.status).toBe(AgentStatus.IDLE);
		expect(snap.sessionId).toBe("mock-session-id");
		expect(snap.promptCount).toBe(0);
		expect(snap.pendingContextCount).toBe(0);
	});

	it("injectContext emits context:injected event", () => {
		const agent = createMockAgent();
		const events: any[] = [];

		agent.on(AgentEvent.CONTEXT_INJECTED, (e: any) => events.push(e));

		agent.injectContext("New instructions");

		expect(events).toHaveLength(1);
		expect(events[0].instructions).toBe("New instructions");
	});

	it("factory creates multiple independent agents", () => {
		const factory = createMockAgentFactory();

		const agent1 = factory({ name: "Agent-1" });
		const agent2 = factory({ name: "Agent-2" });

		expect(agent1.id).not.toBe(agent2.id);
		expect(agent1.name).toBe("Agent-1");
		expect(agent2.name).toBe("Agent-2");

		expect((factory as any).agents).toHaveLength(2);
	});
});
