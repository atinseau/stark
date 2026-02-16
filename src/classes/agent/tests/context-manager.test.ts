import { describe, expect, it } from "bun:test";

import { AgentContextManager } from "../agent-context-manager.ts";

// ── AgentContextManager — Initial State ─────────────────────────────────────────

describe("AgentContextManager — Initial State", () => {
	it("starts with no pending context", () => {
		const ctx = new AgentContextManager();

		expect(ctx.hasPending()).toBe(false);
		expect(ctx.pendingCount).toBe(0);
	});

	it("drain returns null when empty", () => {
		const ctx = new AgentContextManager();

		expect(ctx.drain()).toBeNull();
	});

	it("buildPromptWithContext returns original text when empty", () => {
		const ctx = new AgentContextManager();

		expect(ctx.buildPromptWithContext("Hello agent")).toBe("Hello agent");
	});
});

// ── AgentContextManager — inject() ──────────────────────────────────────────────

describe("AgentContextManager — inject()", () => {
	it("adds a single instruction to the queue", () => {
		const ctx = new AgentContextManager();

		ctx.inject("Use TypeScript strict mode");

		expect(ctx.hasPending()).toBe(true);
		expect(ctx.pendingCount).toBe(1);
	});

	it("adds multiple instructions to the queue", () => {
		const ctx = new AgentContextManager();

		ctx.inject("Use TypeScript strict mode");
		ctx.inject("Prefer functional style");
		ctx.inject("Add error handling");

		expect(ctx.pendingCount).toBe(3);
	});

	it("preserves insertion order (FIFO)", () => {
		const ctx = new AgentContextManager();

		ctx.inject("First");
		ctx.inject("Second");
		ctx.inject("Third");

		const merged = ctx.drain();
		expect(merged).toBe("First\n\n---\n\nSecond\n\n---\n\nThird");
	});

	it("accepts empty strings", () => {
		const ctx = new AgentContextManager();

		ctx.inject("");

		expect(ctx.hasPending()).toBe(true);
		expect(ctx.pendingCount).toBe(1);
	});

	it("accepts multi-line instructions", () => {
		const ctx = new AgentContextManager();

		ctx.inject("Line 1\nLine 2\nLine 3");

		expect(ctx.pendingCount).toBe(1);
		expect(ctx.drain()).toBe("Line 1\nLine 2\nLine 3");
	});
});

// ── AgentContextManager — drain() ───────────────────────────────────────────────

describe("AgentContextManager — drain()", () => {
	it("returns merged instructions separated by ---", () => {
		const ctx = new AgentContextManager();

		ctx.inject("Use strict mode");
		ctx.inject("Add validation");

		const result = ctx.drain();
		expect(result).toBe("Use strict mode\n\n---\n\nAdd validation");
	});

	it("returns a single instruction without separators", () => {
		const ctx = new AgentContextManager();

		ctx.inject("Only one instruction");

		expect(ctx.drain()).toBe("Only one instruction");
	});

	it("clears the queue after draining", () => {
		const ctx = new AgentContextManager();

		ctx.inject("Instruction A");
		ctx.inject("Instruction B");

		ctx.drain();

		expect(ctx.hasPending()).toBe(false);
		expect(ctx.pendingCount).toBe(0);
	});

	it("returns null on subsequent calls after drain", () => {
		const ctx = new AgentContextManager();

		ctx.inject("Something");
		ctx.drain();

		expect(ctx.drain()).toBeNull();
	});

	it("can be re-used after draining", () => {
		const ctx = new AgentContextManager();

		ctx.inject("First batch");
		expect(ctx.drain()).toBe("First batch");

		ctx.inject("Second batch");
		expect(ctx.drain()).toBe("Second batch");
	});
});

// ── AgentContextManager — buildPromptWithContext() ──────────────────────────────

describe("AgentContextManager — buildPromptWithContext()", () => {
	it("prepends context to the prompt text", () => {
		const ctx = new AgentContextManager();

		ctx.inject("Use TypeScript");

		const result = ctx.buildPromptWithContext("Create a REST API");

		expect(result).toBe(
			"Use TypeScript\n\n---\n\nUser request:\nCreate a REST API",
		);
	});

	it("prepends multiple context instructions", () => {
		const ctx = new AgentContextManager();

		ctx.inject("Use TypeScript");
		ctx.inject("Add error handling");

		const result = ctx.buildPromptWithContext("Build the server");

		expect(result).toBe(
			"Use TypeScript\n\n---\n\nAdd error handling\n\n---\n\nUser request:\nBuild the server",
		);
	});

	it("clears the queue after building", () => {
		const ctx = new AgentContextManager();

		ctx.inject("Context");
		ctx.buildPromptWithContext("Prompt");

		expect(ctx.hasPending()).toBe(false);
		expect(ctx.pendingCount).toBe(0);
	});

	it("returns original text when no context is pending", () => {
		const ctx = new AgentContextManager();

		const result = ctx.buildPromptWithContext("Just the prompt");

		expect(result).toBe("Just the prompt");
	});

	it("returns original text after context was already consumed by drain()", () => {
		const ctx = new AgentContextManager();

		ctx.inject("Already drained");
		ctx.drain();

		const result = ctx.buildPromptWithContext("Clean prompt");

		expect(result).toBe("Clean prompt");
	});

	it("handles empty prompt text with context", () => {
		const ctx = new AgentContextManager();

		ctx.inject("Some context");

		const result = ctx.buildPromptWithContext("");

		expect(result).toBe("Some context\n\n---\n\nUser request:\n");
	});
});

// ── AgentContextManager — hasPending() and pendingCount ─────────────────────────

describe("AgentContextManager — hasPending() and pendingCount", () => {
	it("hasPending is false when empty", () => {
		const ctx = new AgentContextManager();
		expect(ctx.hasPending()).toBe(false);
	});

	it("hasPending is true after inject", () => {
		const ctx = new AgentContextManager();
		ctx.inject("test");
		expect(ctx.hasPending()).toBe(true);
	});

	it("hasPending is false after drain", () => {
		const ctx = new AgentContextManager();
		ctx.inject("test");
		ctx.drain();
		expect(ctx.hasPending()).toBe(false);
	});

	it("hasPending is false after buildPromptWithContext", () => {
		const ctx = new AgentContextManager();
		ctx.inject("test");
		ctx.buildPromptWithContext("prompt");
		expect(ctx.hasPending()).toBe(false);
	});

	it("pendingCount reflects exact number of injected items", () => {
		const ctx = new AgentContextManager();

		expect(ctx.pendingCount).toBe(0);

		ctx.inject("a");
		expect(ctx.pendingCount).toBe(1);

		ctx.inject("b");
		expect(ctx.pendingCount).toBe(2);

		ctx.inject("c");
		expect(ctx.pendingCount).toBe(3);
	});

	it("pendingCount resets to 0 after drain", () => {
		const ctx = new AgentContextManager();

		ctx.inject("a");
		ctx.inject("b");
		expect(ctx.pendingCount).toBe(2);

		ctx.drain();
		expect(ctx.pendingCount).toBe(0);
	});
});

// ── AgentContextManager — Interaction between drain and buildPromptWithContext ───

describe("AgentContextManager — drain vs buildPromptWithContext interaction", () => {
	it("drain and buildPromptWithContext both consume the queue", () => {
		const ctx = new AgentContextManager();

		ctx.inject("A");
		ctx.inject("B");

		// drain consumes A and B
		const drained = ctx.drain();
		expect(drained).toBe("A\n\n---\n\nB");

		// Nothing left for buildPromptWithContext
		const prompt = ctx.buildPromptWithContext("My prompt");
		expect(prompt).toBe("My prompt");
	});

	it("buildPromptWithContext then drain returns null", () => {
		const ctx = new AgentContextManager();

		ctx.inject("Context");

		ctx.buildPromptWithContext("Prompt");

		expect(ctx.drain()).toBeNull();
	});

	it("interleaved inject and drain cycles work correctly", () => {
		const ctx = new AgentContextManager();

		// Cycle 1
		ctx.inject("Round 1 - A");
		ctx.inject("Round 1 - B");
		expect(ctx.drain()).toBe("Round 1 - A\n\n---\n\nRound 1 - B");
		expect(ctx.pendingCount).toBe(0);

		// Cycle 2
		ctx.inject("Round 2 - X");
		expect(ctx.buildPromptWithContext("Go")).toBe(
			"Round 2 - X\n\n---\n\nUser request:\nGo",
		);
		expect(ctx.pendingCount).toBe(0);

		// Cycle 3
		ctx.inject("Round 3");
		expect(ctx.drain()).toBe("Round 3");
		expect(ctx.drain()).toBeNull();
	});
});
