import { describe, expect, it } from "bun:test";

import { ApprovalManager } from "../approval-manager.ts";

// ════════════════════════════════════════════════════════════════════════════
// ApprovalManager Unit Tests
// ════════════════════════════════════════════════════════════════════════════

function createRequest(
	overrides?: Partial<{
		agentId: string;
		agentName: string;
		toolCallId: string;
		toolCallTitle: string;
		resolve: (approved: boolean) => void;
	}>,
) {
	return {
		agentId: overrides?.agentId ?? "agent-1",
		agentName: overrides?.agentName ?? "Alpha",
		toolCallId:
			overrides?.toolCallId ?? `tool-${crypto.randomUUID().slice(0, 8)}`,
		toolCallTitle: overrides?.toolCallTitle ?? "execute_command",
		options: [],
		timestamp: new Date().toISOString(),
		resolve: overrides?.resolve ?? (() => {}),
	};
}

describe("ApprovalManager", () => {
	// ── Construction & Initial State ────────────────────────────────────

	describe("initial state", () => {
		it("starts with no pending approvals", () => {
			const manager = new ApprovalManager();

			expect(manager.hasPending()).toBe(false);
			expect(manager.pendingCount).toBe(0);
			expect(manager.getPending()).toEqual([]);
			expect(manager.getPendingSummary()).toEqual([]);
		});
	});

	// ── addRequest ─────────────────────────────────────────────────────

	describe("addRequest", () => {
		it("registers a pending approval", () => {
			const manager = new ApprovalManager();
			const req = createRequest({ toolCallId: "tc-1" });

			manager.addRequest(req);

			expect(manager.hasPending()).toBe(true);
			expect(manager.pendingCount).toBe(1);

			const pending = manager.getPending();
			expect(pending).toHaveLength(1);
			expect(pending[0]!.agentId).toBe("agent-1");
			expect(pending[0]!.agentName).toBe("Alpha");
			expect(pending[0]!.toolCallId).toBe("tc-1");
			expect(pending[0]!.toolCallTitle).toBe("execute_command");
		});

		it("registers multiple approvals for different agents", () => {
			const manager = new ApprovalManager();

			manager.addRequest(
				createRequest({
					agentId: "agent-1",
					agentName: "Alpha",
					toolCallId: "tc-1",
				}),
			);
			manager.addRequest(
				createRequest({
					agentId: "agent-2",
					agentName: "Beta",
					toolCallId: "tc-2",
				}),
			);

			expect(manager.pendingCount).toBe(2);
		});

		it("registers multiple approvals for the same agent", () => {
			const manager = new ApprovalManager();

			manager.addRequest(
				createRequest({
					agentId: "agent-1",
					toolCallId: "tc-1",
					toolCallTitle: "read_file",
				}),
			);
			manager.addRequest(
				createRequest({
					agentId: "agent-1",
					toolCallId: "tc-2",
					toolCallTitle: "write_file",
				}),
			);

			expect(manager.pendingCount).toBe(2);
			expect(manager.getPendingForAgent("agent-1")).toHaveLength(2);
		});

		it("ignores duplicate registrations for the same toolCallId", () => {
			const manager = new ApprovalManager();
			const resolve1 = { called: false };
			const resolve2 = { called: false };

			manager.addRequest(
				createRequest({
					toolCallId: "tc-dup",
					resolve: () => {
						resolve1.called = true;
					},
				}),
			);
			manager.addRequest(
				createRequest({
					toolCallId: "tc-dup",
					resolve: () => {
						resolve2.called = true;
					},
				}),
			);

			expect(manager.pendingCount).toBe(1);

			// Resolving should call the first resolve, not the second
			manager.resolveByToolCallId("tc-dup", true);
			expect(resolve1.called).toBe(true);
			expect(resolve2.called).toBe(false);
		});
	});

	// ── resolveByToolCallId ────────────────────────────────────────────

	describe("resolveByToolCallId", () => {
		it("resolves and removes the approval", () => {
			const manager = new ApprovalManager();
			const resolveResults: boolean[] = [];

			manager.addRequest(
				createRequest({
					toolCallId: "tc-1",
					toolCallTitle: "run_tests",
					agentName: "Alpha",
					resolve: (v) => {
						resolveResults.push(v);
					},
				}),
			);

			const result = manager.resolveByToolCallId("tc-1", true);

			expect(result.resolved).toBe(true);
			expect(result.count).toBe(1);
			expect(result.summary).toContain("Approved");
			expect(result.summary).toContain("run_tests");
			expect(result.summary).toContain("Alpha");
			expect(resolveResults).toEqual([true]);
			expect(manager.hasPending()).toBe(false);
		});

		it("resolves with denial", () => {
			const manager = new ApprovalManager();
			const resolveResults: boolean[] = [];

			manager.addRequest(
				createRequest({
					toolCallId: "tc-1",
					resolve: (v) => {
						resolveResults.push(v);
					},
				}),
			);

			const result = manager.resolveByToolCallId("tc-1", false);

			expect(result.resolved).toBe(true);
			expect(result.summary).toContain("Denied");
			expect(resolveResults).toEqual([false]);
		});

		it("returns not-resolved for unknown toolCallId", () => {
			const manager = new ApprovalManager();

			const result = manager.resolveByToolCallId("nonexistent", true);

			expect(result.resolved).toBe(false);
			expect(result.count).toBe(0);
		});

		it("resolve callback is one-shot — second call is a no-op", () => {
			const manager = new ApprovalManager();
			let callCount = 0;

			manager.addRequest(
				createRequest({
					toolCallId: "tc-1",
					resolve: () => {
						callCount++;
					},
				}),
			);

			const pending = manager.getByToolCallId("tc-1");
			expect(pending).toBeDefined();

			// First call succeeds
			pending!.resolve(true);
			expect(callCount).toBe(1);

			// Second call is a no-op
			pending!.resolve(false);
			expect(callCount).toBe(1);
		});

		it("only removes the targeted approval, leaving others intact", () => {
			const manager = new ApprovalManager();

			manager.addRequest(
				createRequest({
					agentId: "agent-1",
					toolCallId: "tc-1",
				}),
			);
			manager.addRequest(
				createRequest({
					agentId: "agent-2",
					toolCallId: "tc-2",
				}),
			);

			manager.resolveByToolCallId("tc-1", true);

			expect(manager.pendingCount).toBe(1);
			expect(manager.getByToolCallId("tc-2")).toBeDefined();
			expect(manager.getByToolCallId("tc-1")).toBeUndefined();
		});
	});

	// ── resolveByAgentId ───────────────────────────────────────────────

	describe("resolveByAgentId", () => {
		it("resolves all approvals for a specific agent", () => {
			const manager = new ApprovalManager();
			const results: boolean[] = [];

			manager.addRequest(
				createRequest({
					agentId: "agent-1",
					agentName: "Alpha",
					toolCallId: "tc-1",
					resolve: (v) => {
						results.push(v);
					},
				}),
			);
			manager.addRequest(
				createRequest({
					agentId: "agent-1",
					agentName: "Alpha",
					toolCallId: "tc-2",
					resolve: (v) => {
						results.push(v);
					},
				}),
			);
			manager.addRequest(
				createRequest({
					agentId: "agent-2",
					agentName: "Beta",
					toolCallId: "tc-3",
				}),
			);

			const result = manager.resolveByAgentId("agent-1", true);

			expect(result.resolved).toBe(true);
			expect(result.count).toBe(2);
			expect(result.summary).toContain("Alpha");
			expect(result.summary).toContain("2");
			expect(results).toEqual([true, true]);
			// agent-2's approval should remain
			expect(manager.pendingCount).toBe(1);
		});

		it("returns not-resolved for unknown agentId", () => {
			const manager = new ApprovalManager();

			const result = manager.resolveByAgentId("unknown", true);

			expect(result.resolved).toBe(false);
			expect(result.count).toBe(0);
		});
	});

	// ── resolveByAgentName ─────────────────────────────────────────────

	describe("resolveByAgentName", () => {
		it("resolves by agent name (case-insensitive)", () => {
			const manager = new ApprovalManager();
			let resolved = false;

			manager.addRequest(
				createRequest({
					agentId: "agent-1",
					agentName: "Alpha",
					toolCallId: "tc-1",
					resolve: () => {
						resolved = true;
					},
				}),
			);

			const result = manager.resolveByAgentName("alpha", true);

			expect(result.resolved).toBe(true);
			expect(result.count).toBe(1);
			expect(resolved).toBe(true);
		});

		it("resolves with mixed case", () => {
			const manager = new ApprovalManager();

			manager.addRequest(
				createRequest({
					agentName: "Backend-Developer",
					toolCallId: "tc-1",
				}),
			);

			const result = manager.resolveByAgentName("BACKEND-DEVELOPER", true);

			expect(result.resolved).toBe(true);
		});

		it("returns not-resolved for unknown agent name", () => {
			const manager = new ApprovalManager();

			manager.addRequest(
				createRequest({
					agentName: "Alpha",
					toolCallId: "tc-1",
				}),
			);

			const result = manager.resolveByAgentName("nonexistent", true);

			expect(result.resolved).toBe(false);
			expect(result.count).toBe(0);
		});
	});

	// ── resolveAll ─────────────────────────────────────────────────────

	describe("resolveAll", () => {
		it("approves all pending approvals across all agents", () => {
			const manager = new ApprovalManager();
			const results: boolean[] = [];

			manager.addRequest(
				createRequest({
					agentId: "agent-1",
					toolCallId: "tc-1",
					resolve: (v) => {
						results.push(v);
					},
				}),
			);
			manager.addRequest(
				createRequest({
					agentId: "agent-2",
					toolCallId: "tc-2",
					resolve: (v) => {
						results.push(v);
					},
				}),
			);
			manager.addRequest(
				createRequest({
					agentId: "agent-3",
					toolCallId: "tc-3",
					resolve: (v) => {
						results.push(v);
					},
				}),
			);

			const result = manager.resolveAll(true);

			expect(result.resolved).toBe(true);
			expect(result.count).toBe(3);
			expect(results).toEqual([true, true, true]);
			expect(manager.hasPending()).toBe(false);
		});

		it("denies all pending approvals", () => {
			const manager = new ApprovalManager();
			const results: boolean[] = [];

			manager.addRequest(
				createRequest({
					toolCallId: "tc-1",
					resolve: (v) => {
						results.push(v);
					},
				}),
			);
			manager.addRequest(
				createRequest({
					toolCallId: "tc-2",
					resolve: (v) => {
						results.push(v);
					},
				}),
			);

			const result = manager.resolveAll(false);

			expect(result.resolved).toBe(true);
			expect(result.summary).toContain("Denied");
			expect(results).toEqual([false, false]);
		});

		it("returns not-resolved when there are no pending approvals", () => {
			const manager = new ApprovalManager();

			const result = manager.resolveAll(true);

			expect(result.resolved).toBe(false);
			expect(result.count).toBe(0);
		});
	});

	// ── clear ──────────────────────────────────────────────────────────

	describe("clear", () => {
		it("denies and removes all pending approvals", () => {
			const manager = new ApprovalManager();
			const results: boolean[] = [];

			manager.addRequest(
				createRequest({
					toolCallId: "tc-1",
					resolve: (v) => {
						results.push(v);
					},
				}),
			);
			manager.addRequest(
				createRequest({
					toolCallId: "tc-2",
					resolve: (v) => {
						results.push(v);
					},
				}),
			);

			manager.clear();

			expect(manager.hasPending()).toBe(false);
			expect(manager.pendingCount).toBe(0);
			expect(results).toEqual([false, false]);
		});

		it("is safe to call when no pending approvals exist", () => {
			const manager = new ApprovalManager();
			manager.clear(); // Should not throw
			expect(manager.hasPending()).toBe(false);
		});

		it("is safe to call multiple times", () => {
			const manager = new ApprovalManager();
			let callCount = 0;

			manager.addRequest(
				createRequest({
					toolCallId: "tc-1",
					resolve: () => {
						callCount++;
					},
				}),
			);

			manager.clear();
			manager.clear();

			// The resolve should only have been called once (one-shot)
			expect(callCount).toBe(1);
		});
	});

	// ── Query Methods ──────────────────────────────────────────────────

	describe("queries", () => {
		it("getPendingForAgent returns only that agent's approvals", () => {
			const manager = new ApprovalManager();

			manager.addRequest(
				createRequest({
					agentId: "agent-1",
					toolCallId: "tc-1",
					toolCallTitle: "read_file",
				}),
			);
			manager.addRequest(
				createRequest({
					agentId: "agent-1",
					toolCallId: "tc-2",
					toolCallTitle: "write_file",
				}),
			);
			manager.addRequest(
				createRequest({
					agentId: "agent-2",
					toolCallId: "tc-3",
				}),
			);

			const agent1Pending = manager.getPendingForAgent("agent-1");
			expect(agent1Pending).toHaveLength(2);
			expect(agent1Pending[0]!.toolCallId).toBe("tc-1");
			expect(agent1Pending[1]!.toolCallId).toBe("tc-2");

			const agent2Pending = manager.getPendingForAgent("agent-2");
			expect(agent2Pending).toHaveLength(1);
		});

		it("getPendingForAgent returns empty for unknown agent", () => {
			const manager = new ApprovalManager();

			expect(manager.getPendingForAgent("unknown")).toEqual([]);
		});

		it("getByToolCallId returns the specific approval", () => {
			const manager = new ApprovalManager();

			manager.addRequest(
				createRequest({
					toolCallId: "tc-1",
					toolCallTitle: "execute_command",
				}),
			);

			const entry = manager.getByToolCallId("tc-1");
			expect(entry).toBeDefined();
			expect(entry!.toolCallTitle).toBe("execute_command");
		});

		it("getByToolCallId returns undefined for unknown id", () => {
			const manager = new ApprovalManager();

			expect(manager.getByToolCallId("unknown")).toBeUndefined();
		});

		it("getPendingSummary returns serializable data without resolve", () => {
			const manager = new ApprovalManager();

			manager.addRequest(
				createRequest({
					agentId: "agent-1",
					agentName: "Alpha",
					toolCallId: "tc-1",
					toolCallTitle: "deploy",
				}),
			);

			const summary = manager.getPendingSummary();
			expect(summary).toHaveLength(1);
			expect(summary[0]).toEqual({
				agentId: "agent-1",
				agentName: "Alpha",
				toolCallId: "tc-1",
				toolCallTitle: "deploy",
				timestamp: expect.any(String),
			});

			// Should not contain the resolve function
			expect((summary[0] as any).resolve).toBeUndefined();
		});
	});

	// ── Agent Index Cleanup ────────────────────────────────────────────

	describe("agent index cleanup", () => {
		it("removes agent from index when last approval is resolved", () => {
			const manager = new ApprovalManager();

			manager.addRequest(
				createRequest({
					agentId: "agent-1",
					toolCallId: "tc-1",
				}),
			);

			manager.resolveByToolCallId("tc-1", true);

			// Agent should be removed from the index
			expect(manager.getPendingForAgent("agent-1")).toEqual([]);
		});

		it("keeps agent in index when it still has other pending approvals", () => {
			const manager = new ApprovalManager();

			manager.addRequest(
				createRequest({
					agentId: "agent-1",
					toolCallId: "tc-1",
				}),
			);
			manager.addRequest(
				createRequest({
					agentId: "agent-1",
					toolCallId: "tc-2",
				}),
			);

			manager.resolveByToolCallId("tc-1", true);

			expect(manager.getPendingForAgent("agent-1")).toHaveLength(1);
			expect(manager.getPendingForAgent("agent-1")[0]!.toolCallId).toBe("tc-2");
		});
	});

	// ── Concurrency Scenarios ──────────────────────────────────────────

	describe("concurrency", () => {
		it("multiple agents can have independent pending approvals", () => {
			const manager = new ApprovalManager();
			const resolveResults = new Map<string, boolean>();

			for (let i = 0; i < 5; i++) {
				manager.addRequest(
					createRequest({
						agentId: `agent-${i}`,
						agentName: `Agent-${i}`,
						toolCallId: `tc-${i}`,
						resolve: (v) => {
							resolveResults.set(`agent-${i}`, v);
						},
					}),
				);
			}

			expect(manager.pendingCount).toBe(5);

			// Approve only agent-2
			manager.resolveByAgentId("agent-2", true);
			expect(manager.pendingCount).toBe(4);
			expect(resolveResults.get("agent-2")).toBe(true);
			expect(resolveResults.has("agent-0")).toBe(false);

			// Deny agent-4
			manager.resolveByAgentId("agent-4", false);
			expect(manager.pendingCount).toBe(3);
			expect(resolveResults.get("agent-4")).toBe(false);

			// Remaining agents are still pending
			expect(manager.getPendingForAgent("agent-0")).toHaveLength(1);
			expect(manager.getPendingForAgent("agent-1")).toHaveLength(1);
			expect(manager.getPendingForAgent("agent-3")).toHaveLength(1);
		});

		it("resolving does not affect other agents' approvals", () => {
			const manager = new ApprovalManager();
			let agent1Resolved = false;
			let agent2Resolved = false;

			manager.addRequest(
				createRequest({
					agentId: "agent-1",
					agentName: "Alpha",
					toolCallId: "tc-1",
					resolve: () => {
						agent1Resolved = true;
					},
				}),
			);
			manager.addRequest(
				createRequest({
					agentId: "agent-2",
					agentName: "Beta",
					toolCallId: "tc-2",
					resolve: () => {
						agent2Resolved = true;
					},
				}),
			);

			// Resolve only agent-1
			manager.resolveByAgentName("Alpha", true);

			expect(agent1Resolved).toBe(true);
			expect(agent2Resolved).toBe(false);
			expect(manager.pendingCount).toBe(1);
		});
	});

	// ── Edge Cases ─────────────────────────────────────────────────────

	describe("edge cases", () => {
		it("handles rapid add-then-resolve cycles", () => {
			const manager = new ApprovalManager();
			const resolved: string[] = [];

			for (let i = 0; i < 10; i++) {
				const toolCallId = `tc-${i}`;
				manager.addRequest(
					createRequest({
						toolCallId,
						resolve: () => {
							resolved.push(toolCallId);
						},
					}),
				);
				manager.resolveByToolCallId(toolCallId, true);
			}

			expect(resolved).toHaveLength(10);
			expect(manager.hasPending()).toBe(false);
		});

		it("resolveAll followed by resolveByToolCallId is safe", () => {
			const manager = new ApprovalManager();
			let callCount = 0;

			manager.addRequest(
				createRequest({
					toolCallId: "tc-1",
					resolve: () => {
						callCount++;
					},
				}),
			);

			const savedEntry = manager.getByToolCallId("tc-1");
			manager.resolveAll(true);
			expect(callCount).toBe(1);

			// The saved reference's resolve is one-shot, so calling again is a no-op
			savedEntry!.resolve(false);
			expect(callCount).toBe(1);
		});

		it("clear after partial resolution only denies remaining", () => {
			const manager = new ApprovalManager();
			const results = new Map<string, boolean>();

			manager.addRequest(
				createRequest({
					toolCallId: "tc-1",
					resolve: (v) => {
						results.set("tc-1", v);
					},
				}),
			);
			manager.addRequest(
				createRequest({
					toolCallId: "tc-2",
					resolve: (v) => {
						results.set("tc-2", v);
					},
				}),
			);

			// Approve one
			manager.resolveByToolCallId("tc-1", true);

			// Clear remaining
			manager.clear();

			expect(results.get("tc-1")).toBe(true);
			expect(results.get("tc-2")).toBe(false);
		});
	});
});
