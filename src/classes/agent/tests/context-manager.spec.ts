import { describe, expect, it } from "bun:test";
import {
	ContextInjectionCategory,
	ContextInjectionPriority,
	type StructuredContextInjection,
} from "../../../types/agent-pool.types.ts";
import { AgentContextManager } from "../agent-context-manager.ts";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeInjection(
	overrides?: Partial<StructuredContextInjection>,
): StructuredContextInjection {
	return {
		content: overrides?.content ?? "Some injected content",
		priority: overrides?.priority ?? ContextInjectionPriority.NORMAL,
		category: overrides?.category ?? ContextInjectionCategory.SHARED_CONTEXT,
		source: overrides?.source ?? "test-agent",
		dependencyType: overrides?.dependencyType ?? null,
		timestamp: overrides?.timestamp ?? new Date().toISOString(),
	};
}

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

// ── AgentContextManager — inject() (legacy) ─────────────────────────────────────

describe("AgentContextManager — inject() (legacy)", () => {
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

	it("preserves insertion order (FIFO) with --- CONTEXT --- headers", () => {
		const ctx = new AgentContextManager();

		ctx.inject("First");
		ctx.inject("Second");
		ctx.inject("Third");

		const merged = ctx.drain();
		expect(merged).toBe(
			"--- CONTEXT ---\nFirst\n\n---\n\n--- CONTEXT ---\nSecond\n\n---\n\n--- CONTEXT ---\nThird",
		);
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
		expect(ctx.drain()).toBe("--- CONTEXT ---\nLine 1\nLine 2\nLine 3");
	});
});

// ── AgentContextManager — drain() (legacy only) ────────────────────────────────

describe("AgentContextManager — drain() (legacy only)", () => {
	it("returns merged instructions separated by --- with headers", () => {
		const ctx = new AgentContextManager();

		ctx.inject("Use strict mode");
		ctx.inject("Add validation");

		const result = ctx.drain();
		expect(result).toBe(
			"--- CONTEXT ---\nUse strict mode\n\n---\n\n--- CONTEXT ---\nAdd validation",
		);
	});

	it("returns a single instruction with header", () => {
		const ctx = new AgentContextManager();

		ctx.inject("Only one instruction");

		expect(ctx.drain()).toBe("--- CONTEXT ---\nOnly one instruction");
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
		expect(ctx.drain()).toBe("--- CONTEXT ---\nFirst batch");

		ctx.inject("Second batch");
		expect(ctx.drain()).toBe("--- CONTEXT ---\nSecond batch");
	});
});

// ── AgentContextManager — buildPromptWithContext() (legacy only) ────────────────

describe("AgentContextManager — buildPromptWithContext() (legacy only)", () => {
	it("prepends context to the prompt text", () => {
		const ctx = new AgentContextManager();

		ctx.inject("Use TypeScript");

		const result = ctx.buildPromptWithContext("Create a REST API");

		expect(result).toBe(
			"--- CONTEXT ---\nUse TypeScript\n\n---\n\nUser request:\nCreate a REST API",
		);
	});

	it("prepends multiple context instructions", () => {
		const ctx = new AgentContextManager();

		ctx.inject("Use TypeScript");
		ctx.inject("Add error handling");

		const result = ctx.buildPromptWithContext("Build the server");

		expect(result).toBe(
			"--- CONTEXT ---\nUse TypeScript\n\n---\n\n--- CONTEXT ---\nAdd error handling\n\n---\n\nUser request:\nBuild the server",
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

		expect(result).toBe(
			"--- CONTEXT ---\nSome context\n\n---\n\nUser request:\n",
		);
	});
});

// ── AgentContextManager — hasPending() and pendingCount ─────────────────────────

describe("AgentContextManager — hasPending() and pendingCount", () => {
	it("hasPending is false when empty", () => {
		const ctx = new AgentContextManager();
		expect(ctx.hasPending()).toBe(false);
	});

	it("hasPending is true after inject (legacy)", () => {
		const ctx = new AgentContextManager();
		ctx.inject("test");
		expect(ctx.hasPending()).toBe(true);
	});

	it("hasPending is true after injectStructured", () => {
		const ctx = new AgentContextManager();
		ctx.injectStructured(makeInjection());
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

	it("pendingCount reflects exact number of injected items (both types)", () => {
		const ctx = new AgentContextManager();

		expect(ctx.pendingCount).toBe(0);

		ctx.inject("a");
		expect(ctx.pendingCount).toBe(1);

		ctx.injectStructured(makeInjection());
		expect(ctx.pendingCount).toBe(2);

		ctx.inject("c");
		expect(ctx.pendingCount).toBe(3);
	});

	it("pendingCount resets to 0 after drain", () => {
		const ctx = new AgentContextManager();

		ctx.inject("a");
		ctx.injectStructured(makeInjection());
		expect(ctx.pendingCount).toBe(2);

		ctx.drain();
		expect(ctx.pendingCount).toBe(0);
	});
});

// ── AgentContextManager — drain vs buildPromptWithContext interaction ────────────

describe("AgentContextManager — drain vs buildPromptWithContext interaction", () => {
	it("drain and buildPromptWithContext both consume the queue", () => {
		const ctx = new AgentContextManager();

		ctx.inject("A");
		ctx.inject("B");

		// drain consumes A and B
		const drained = ctx.drain();
		expect(drained).toBe("--- CONTEXT ---\nA\n\n---\n\n--- CONTEXT ---\nB");

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
		expect(ctx.drain()).toBe(
			"--- CONTEXT ---\nRound 1 - A\n\n---\n\n--- CONTEXT ---\nRound 1 - B",
		);
		expect(ctx.pendingCount).toBe(0);

		// Cycle 2
		ctx.inject("Round 2 - X");
		expect(ctx.buildPromptWithContext("Go")).toBe(
			"--- CONTEXT ---\nRound 2 - X\n\n---\n\nUser request:\nGo",
		);
		expect(ctx.pendingCount).toBe(0);

		// Cycle 3
		ctx.inject("Round 3");
		expect(ctx.drain()).toBe("--- CONTEXT ---\nRound 3");
		expect(ctx.drain()).toBeNull();
	});
});

// ══════════════════════════════════════════════════════════════════════════════
// ── Structured Injection Tests (Evolution 08) ───────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════

// ── Test 1: injectStructured adds a structured injection ────────────────────

describe("AgentContextManager — injectStructured()", () => {
	it("adds a structured injection to the queue", () => {
		const ctx = new AgentContextManager();

		ctx.injectStructured(
			makeInjection({ priority: ContextInjectionPriority.CRITICAL }),
		);

		expect(ctx.hasPending()).toBe(true);
		expect(ctx.pendingCount).toBe(1);
	});

	it("returns dropped count of 0 when within limits", () => {
		const ctx = new AgentContextManager();

		const result = ctx.injectStructured(makeInjection());

		expect(result.dropped).toBe(0);
	});
});

// ── Test 2: drain() formats structured injections with correct headers ──────

describe("AgentContextManager — drain() structured formatting", () => {
	it("formats injections with category headers and source attribution", () => {
		const ctx = new AgentContextManager();

		ctx.injectStructured(
			makeInjection({
				content: "API endpoints are ready",
				priority: ContextInjectionPriority.CRITICAL,
				category: ContextInjectionCategory.DEPENDENCY_OUTPUT,
				source: "api-dev",
				dependencyType: "blocking",
			}),
		);
		ctx.injectStructured(
			makeInjection({
				content: "Docs use OpenAPI format",
				priority: ContextInjectionPriority.NORMAL,
				category: ContextInjectionCategory.SHARED_CONTEXT,
				source: "doc-writer",
			}),
		);

		const result = ctx.drain()!;

		expect(result).toContain(
			"[📦 DEPENDENCY OUTPUT from api-dev | priority: CRITICAL | blocking dependency]",
		);
		expect(result).toContain(
			"[🔗 SHARED CONTEXT from doc-writer | priority: NORMAL]",
		);
		// CRITICAL should appear BEFORE NORMAL
		const criticalIdx = result.indexOf("CRITICAL");
		const normalIdx = result.indexOf("priority: NORMAL");
		expect(criticalIdx).toBeLessThan(normalIdx);
	});
});

// ── Test 3: drain() sorts by priority (CRITICAL > HIGH > NORMAL > LOW) ──────

describe("AgentContextManager — drain() priority sorting", () => {
	it("sorts injections by priority: CRITICAL > HIGH > NORMAL > LOW", () => {
		const ctx = new AgentContextManager();

		// Inject in reverse order
		ctx.injectStructured(
			makeInjection({
				content: "low-content",
				priority: ContextInjectionPriority.LOW,
				source: "low-src",
			}),
		);
		ctx.injectStructured(
			makeInjection({
				content: "normal-content",
				priority: ContextInjectionPriority.NORMAL,
				source: "normal-src",
			}),
		);
		ctx.injectStructured(
			makeInjection({
				content: "critical-content",
				priority: ContextInjectionPriority.CRITICAL,
				source: "critical-src",
			}),
		);
		ctx.injectStructured(
			makeInjection({
				content: "high-content",
				priority: ContextInjectionPriority.HIGH,
				source: "high-src",
			}),
		);

		const result = ctx.drain()!;

		const criticalIdx = result.indexOf("critical-content");
		const highIdx = result.indexOf("high-content");
		const normalIdx = result.indexOf("normal-content");
		const lowIdx = result.indexOf("low-content");

		expect(criticalIdx).toBeLessThan(highIdx);
		expect(highIdx).toBeLessThan(normalIdx);
		expect(normalIdx).toBeLessThan(lowIdx);
	});
});

// ── Test 4: drain() mixes structured and legacy ─────────────────────────────

describe("AgentContextManager — drain() mixed mode", () => {
	it("outputs structured injections BEFORE legacy ones", () => {
		const ctx = new AgentContextManager();

		ctx.injectStructured(
			makeInjection({
				content: "Structured info",
				priority: ContextInjectionPriority.NORMAL,
				category: ContextInjectionCategory.SHARED_CONTEXT,
				source: "agent-x",
			}),
		);
		ctx.inject("Legacy string info");

		const result = ctx.drain()!;

		// Structured header
		expect(result).toContain("🔗 SHARED CONTEXT from agent-x");
		// Legacy header
		expect(result).toContain("--- CONTEXT ---");

		// Structured should be before legacy
		const structuredIdx = result.indexOf("SHARED CONTEXT");
		const legacyIdx = result.indexOf("--- CONTEXT ---");
		expect(structuredIdx).toBeLessThan(legacyIdx);
	});
});

// ── Test 5: buildPromptWithContext() with structured context ─────────────────

describe("AgentContextManager — buildPromptWithContext() with structured context", () => {
	it("prepends structured context and ends with User request", () => {
		const ctx = new AgentContextManager();

		ctx.injectStructured(
			makeInjection({
				content: "Critical dep info",
				priority: ContextInjectionPriority.CRITICAL,
				category: ContextInjectionCategory.DEPENDENCY_OUTPUT,
				source: "api-dev",
				dependencyType: "blocking",
			}),
		);

		const result = ctx.buildPromptWithContext("Write tests");

		// Starts with the structured header
		expect(result).toMatch(/^\[📦 DEPENDENCY OUTPUT/);
		// Ends with user request
		expect(result).toContain("User request:\nWrite tests");
		// Separated by ---
		expect(result).toContain("---\n\nUser request:");
	});
});

// ── Test 6: buildPromptWithContext() returns text unchanged without injections ───

describe("AgentContextManager — buildPromptWithContext() without injections", () => {
	it("returns the text unchanged when nothing is pending", () => {
		const ctx = new AgentContextManager();

		const result = ctx.buildPromptWithContext("Write tests");

		expect(result).toBe("Write tests");
	});
});

// ── Test 7: enforceQueueLimits drops LOW priority first ─────────────────────

describe("AgentContextManager — enforceQueueLimits (count)", () => {
	it("drops LOW priority injections when count exceeds MAX_PENDING_INJECTIONS (15)", () => {
		const ctx = new AgentContextManager();

		// Inject 17 LOW priority injections (15 max)
		for (let i = 0; i < 17; i++) {
			ctx.injectStructured(
				makeInjection({
					content: `low-${i}`,
					priority: ContextInjectionPriority.LOW,
				}),
			);
		}

		// Should have been trimmed to 15
		expect(ctx.pendingCount).toBe(15);
	});

	it("drops the oldest LOW injections first", () => {
		const ctx = new AgentContextManager();

		// Inject 17 LOW priority injections with unique content
		for (let i = 0; i < 17; i++) {
			ctx.injectStructured(
				makeInjection({
					content: `item_${String(i).padStart(3, "0")}_low`,
					priority: ContextInjectionPriority.LOW,
				}),
			);
		}

		const result = ctx.drain()!;

		// The two oldest (item_000, item_001) should have been dropped
		expect(result).not.toContain("item_000_low");
		expect(result).not.toContain("item_001_low");
		// The rest should still be there
		expect(result).toContain("item_002_low");
		expect(result).toContain("item_016_low");
	});
});

// ── Test 8: enforceQueueLimits drops NORMAL if no LOW left ──────────────────

describe("AgentContextManager — enforceQueueLimits drops NORMAL after LOW", () => {
	it("drops NORMAL injections when no LOW remain and count exceeds limit", () => {
		const ctx = new AgentContextManager();

		// Inject 16 NORMAL priority injections (1 over limit of 15)
		for (let i = 0; i < 16; i++) {
			ctx.injectStructured(
				makeInjection({
					content: `normal-${i}`,
					priority: ContextInjectionPriority.NORMAL,
				}),
			);
		}

		// Should have been trimmed to 15
		expect(ctx.pendingCount).toBe(15);

		const result = ctx.drain()!;
		// The oldest NORMAL (normal-0) should have been dropped
		expect(result).not.toContain("normal-0");
		expect(result).toContain("normal-1");
	});
});

// ── Test 9: enforceQueueLimits NEVER drops CRITICAL or HIGH ─────────────────

describe("AgentContextManager — enforceQueueLimits never drops CRITICAL or HIGH", () => {
	it("preserves all CRITICAL injections even beyond the limit", () => {
		const ctx = new AgentContextManager();

		// Inject 20 CRITICAL priority injections (5 over limit of 15)
		for (let i = 0; i < 20; i++) {
			ctx.injectStructured(
				makeInjection({
					content: `critical-${i}`,
					priority: ContextInjectionPriority.CRITICAL,
				}),
			);
		}

		// Nothing should be dropped — CRITICAL is never dropped
		expect(ctx.pendingCount).toBe(20);

		const result = ctx.drain()!;
		for (let i = 0; i < 20; i++) {
			expect(result).toContain(`critical-${i}`);
		}
	});

	it("preserves all HIGH injections even beyond the limit", () => {
		const ctx = new AgentContextManager();

		// Inject 20 HIGH priority injections
		for (let i = 0; i < 20; i++) {
			ctx.injectStructured(
				makeInjection({
					content: `high-${i}`,
					priority: ContextInjectionPriority.HIGH,
				}),
			);
		}

		expect(ctx.pendingCount).toBe(20);
	});

	it("drops only LOW and NORMAL when mixed with HIGH and CRITICAL", () => {
		const ctx = new AgentContextManager();

		// Fill up with a mix: 8 CRITICAL, 4 HIGH, 3 NORMAL, 3 LOW = 18 total
		for (let i = 0; i < 8; i++) {
			ctx.injectStructured(
				makeInjection({
					content: `critical-${i}`,
					priority: ContextInjectionPriority.CRITICAL,
				}),
			);
		}
		for (let i = 0; i < 4; i++) {
			ctx.injectStructured(
				makeInjection({
					content: `high-${i}`,
					priority: ContextInjectionPriority.HIGH,
				}),
			);
		}
		for (let i = 0; i < 3; i++) {
			ctx.injectStructured(
				makeInjection({
					content: `normal-${i}`,
					priority: ContextInjectionPriority.NORMAL,
				}),
			);
		}
		for (let i = 0; i < 3; i++) {
			ctx.injectStructured(
				makeInjection({
					content: `low-${i}`,
					priority: ContextInjectionPriority.LOW,
				}),
			);
		}

		// 18 total, limit is 15, so 3 should be dropped
		// LOW dropped first (3), brings us to 15 exactly
		expect(ctx.pendingCount).toBe(15);

		const result = ctx.drain()!;

		// All CRITICAL and HIGH should remain
		for (let i = 0; i < 8; i++) {
			expect(result).toContain(`critical-${i}`);
		}
		for (let i = 0; i < 4; i++) {
			expect(result).toContain(`high-${i}`);
		}
		// All NORMAL should remain (LOW was dropped first)
		for (let i = 0; i < 3; i++) {
			expect(result).toContain(`normal-${i}`);
		}
		// All LOW should be dropped
		for (let i = 0; i < 3; i++) {
			expect(result).not.toContain(`low-${i}`);
		}
	});
});

// ── Test 10: enforceQueueLimits respects MAX_PENDING_CHARS ──────────────────

describe("AgentContextManager — enforceQueueLimits (chars)", () => {
	it("drops LOW injections when total chars exceed MAX_PENDING_CHARS (15000)", () => {
		const ctx = new AgentContextManager();

		// Inject 3 LOW injections of 6000 chars each (total 18000 > 15000)
		for (let i = 0; i < 3; i++) {
			ctx.injectStructured(
				makeInjection({
					content: `${"x".repeat(6000)}`,
					priority: ContextInjectionPriority.LOW,
				}),
			);
		}

		// At least 1 should have been dropped (18000 > 15000)
		expect(ctx.pendingCount).toBeLessThanOrEqual(2);

		// After dropping, verify the content fits within limit
		// (we can't easily access totalPendingChars from outside,
		// but we know it should be <= 15000 after enforcement)
		const result = ctx.drain()!;
		// With 2 left: 2 * 6000 = 12000 which is <= 15000
		expect(result.length).toBeGreaterThan(0);
	});
});

// ── Test 11: drain() empties the queue ──────────────────────────────────────

describe("AgentContextManager — drain() empties queue", () => {
	it("empties both structured and legacy queues after drain", () => {
		const ctx = new AgentContextManager();

		ctx.injectStructured(makeInjection({ content: "structured" }));
		ctx.injectStructured(makeInjection({ content: "structured-2" }));
		ctx.inject("legacy");

		const result = ctx.drain();
		expect(result).not.toBeNull();

		expect(ctx.hasPending()).toBe(false);
		expect(ctx.pendingCount).toBe(0);
	});
});

// ── Test 12: drain() returns null when queue is empty ────────────────────────

describe("AgentContextManager — drain() on empty queue", () => {
	it("returns null when nothing has been injected", () => {
		const ctx = new AgentContextManager();

		expect(ctx.drain()).toBeNull();
	});

	it("returns null after everything was already drained", () => {
		const ctx = new AgentContextManager();

		ctx.injectStructured(makeInjection());
		ctx.drain();

		expect(ctx.drain()).toBeNull();
	});
});

// ── Test 13: Format includes dependency type when present ───────────────────

describe("AgentContextManager — dependency type formatting", () => {
	it("includes 'blocking dependency' label when dependencyType is blocking", () => {
		const ctx = new AgentContextManager();

		ctx.injectStructured(
			makeInjection({
				content: "Schema definitions",
				dependencyType: "blocking",
				category: ContextInjectionCategory.DEPENDENCY_OUTPUT,
				source: "db-agent",
			}),
		);

		const result = ctx.drain()!;
		expect(result).toContain("blocking dependency");
	});

	it("includes 'informational dependency' label when dependencyType is informational", () => {
		const ctx = new AgentContextManager();

		ctx.injectStructured(
			makeInjection({
				content: "Some info",
				dependencyType: "informational",
				category: ContextInjectionCategory.DEPENDENCY_OUTPUT,
				source: "info-agent",
			}),
		);

		const result = ctx.drain()!;
		expect(result).toContain("informational dependency");
	});
});

// ── Test 14: Format omits dependency type when null ─────────────────────────

describe("AgentContextManager — no dependency type formatting", () => {
	it("does NOT contain 'dependency' label when dependencyType is null", () => {
		const ctx = new AgentContextManager();

		ctx.injectStructured(
			makeInjection({
				content: "Just context",
				dependencyType: null,
				source: "some-agent",
			}),
		);

		const result = ctx.drain()!;
		expect(result).not.toContain("dependency");
	});
});

// ── Test 21: Legacy injectContext(string) backward compatibility ─────────────

describe("AgentContextManager — legacy backward compatibility", () => {
	it("produces the expected format for legacy inject + buildPromptWithContext", () => {
		const ctx = new AgentContextManager();

		ctx.inject("Do X");

		const result = ctx.buildPromptWithContext("Task");

		expect(result).toBe("--- CONTEXT ---\nDo X\n\n---\n\nUser request:\nTask");
	});
});

// ── Test 22: drain() interacts correctly with buildPromptWithContext() ───────

describe("AgentContextManager — drain + buildPromptWithContext interaction (mixed)", () => {
	it("structured + legacy are properly ordered in buildPromptWithContext", () => {
		const ctx = new AgentContextManager();

		ctx.injectStructured(
			makeInjection({
				content: "Structured data",
				priority: ContextInjectionPriority.CRITICAL,
				category: ContextInjectionCategory.DEPENDENCY_OUTPUT,
				source: "api-dev",
				dependencyType: "blocking",
			}),
		);
		ctx.inject("Legacy data");

		const result = ctx.buildPromptWithContext("Task");

		// Structured comes first
		expect(result).toContain("📦 DEPENDENCY OUTPUT from api-dev");
		expect(result).toContain("--- CONTEXT ---\nLegacy data");
		expect(result).toContain("User request:\nTask");

		const structuredIdx = result.indexOf("DEPENDENCY OUTPUT");
		const legacyIdx = result.indexOf("--- CONTEXT ---");
		const userIdx = result.indexOf("User request:");

		expect(structuredIdx).toBeLessThan(legacyIdx);
		expect(legacyIdx).toBeLessThan(userIdx);
	});

	it("second call to buildPromptWithContext returns plain text (queue empty)", () => {
		const ctx = new AgentContextManager();

		ctx.injectStructured(makeInjection({ content: "First" }));
		ctx.inject("Second");

		ctx.buildPromptWithContext("Task 1");

		const result = ctx.buildPromptWithContext("Task 2");
		expect(result).toBe("Task 2");
	});
});

// ── Category headers ────────────────────────────────────────────────────────

describe("AgentContextManager — category headers", () => {
	it("uses correct emoji headers for each category", () => {
		const ctx = new AgentContextManager();

		ctx.injectStructured(
			makeInjection({
				content: "dep",
				category: ContextInjectionCategory.DEPENDENCY_OUTPUT,
				source: "s1",
			}),
		);
		ctx.injectStructured(
			makeInjection({
				content: "shared",
				category: ContextInjectionCategory.SHARED_CONTEXT,
				source: "s2",
			}),
		);
		ctx.injectStructured(
			makeInjection({
				content: "user",
				category: ContextInjectionCategory.USER_INSTRUCTION,
				source: "s3",
			}),
		);
		ctx.injectStructured(
			makeInjection({
				content: "alert",
				category: ContextInjectionCategory.COORDINATION_ALERT,
				source: "s4",
			}),
		);

		const result = ctx.drain()!;

		expect(result).toContain("📦 DEPENDENCY OUTPUT from s1");
		expect(result).toContain("🔗 SHARED CONTEXT from s2");
		expect(result).toContain("👤 USER INSTRUCTION from s3");
		expect(result).toContain("⚠️ COORDINATION ALERT from s4");
	});
});

// ── injectStructured returns dropped count ──────────────────────────────────

describe("AgentContextManager — injectStructured dropped reporting", () => {
	it("reports the number of dropped injections on overflow", () => {
		const ctx = new AgentContextManager();

		// Fill up to limit with LOW
		for (let i = 0; i < 15; i++) {
			ctx.injectStructured(
				makeInjection({
					content: `low-${i}`,
					priority: ContextInjectionPriority.LOW,
				}),
			);
		}

		// This 16th injection should trigger a drop
		const result = ctx.injectStructured(
			makeInjection({
				content: "low-overflow",
				priority: ContextInjectionPriority.LOW,
			}),
		);

		// At least 1 drop should have occurred
		expect(result.dropped).toBeGreaterThanOrEqual(1);
		expect(ctx.pendingCount).toBe(15);
	});

	it("reports 0 drops when adding CRITICAL beyond limit", () => {
		const ctx = new AgentContextManager();

		// Fill up to limit with CRITICAL
		for (let i = 0; i < 15; i++) {
			ctx.injectStructured(
				makeInjection({
					content: `critical-${i}`,
					priority: ContextInjectionPriority.CRITICAL,
				}),
			);
		}

		// Adding more CRITICAL should NOT drop anything
		const result = ctx.injectStructured(
			makeInjection({
				content: "critical-overflow",
				priority: ContextInjectionPriority.CRITICAL,
			}),
		);

		expect(result.dropped).toBe(0);
		expect(ctx.pendingCount).toBe(16);
	});
});

// ── Stable sort within same priority ────────────────────────────────────────

describe("AgentContextManager — stable sort within same priority", () => {
	it("maintains insertion order for injections with the same priority", () => {
		const ctx = new AgentContextManager();

		ctx.injectStructured(
			makeInjection({
				content: "first-normal",
				priority: ContextInjectionPriority.NORMAL,
				source: "src1",
			}),
		);
		ctx.injectStructured(
			makeInjection({
				content: "second-normal",
				priority: ContextInjectionPriority.NORMAL,
				source: "src2",
			}),
		);
		ctx.injectStructured(
			makeInjection({
				content: "third-normal",
				priority: ContextInjectionPriority.NORMAL,
				source: "src3",
			}),
		);

		const result = ctx.drain()!;

		const firstIdx = result.indexOf("first-normal");
		const secondIdx = result.indexOf("second-normal");
		const thirdIdx = result.indexOf("third-normal");

		expect(firstIdx).toBeLessThan(secondIdx);
		expect(secondIdx).toBeLessThan(thirdIdx);
	});
});
