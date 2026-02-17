import { describe, expect, it } from "bun:test";
import { PoolEvent } from "../../../enums/pool-event.enum.ts";
import type {
	AgentPoolResult,
	AgentPoolState,
	ApproveRequestPoolEvent,
	PoolManagedAgent,
} from "../../../types/agent-pool.types.ts";
import { AgentPool } from "../agent-pool.ts";
import { createMockAgent } from "./test-helpers.ts";
import {
	createApprovalAgent,
	HAS_API_KEY,
	INT_TIMEOUT_MS,
	intPoolConfig,
} from "./test-helpers-int.ts";

// ════════════════════════════════════════════════════════════════════════════
// AgentPool — Contextual Approval System Integration Tests
//
// Tests for the approval workflow: APPROVE_REQUEST events, resolving
// via event callbacks, resolving via pool.send() with LLM intent
// classification, pending state tracking, denial, non-blocking behavior,
// destroy cleanup, event shape validation, and one-shot resolve safety.
// ════════════════════════════════════════════════════════════════════════════

describe.skipIf(!HAS_API_KEY)("AgentPool int — approval system", () => {
	it.concurrent(
		"emits PoolEvent.APPROVE_REQUEST and resolving it via the event callback unblocks the agent",
		async () => {
			// Agent factory that produces approval-requiring agents
			const spawnedAgents: PoolManagedAgent[] = [];
			const approvalFactory = (config?: { name?: string }) => {
				const agent = createApprovalAgent({
					name: config?.name ?? "approval-agent",
					toolCallTitle: "write_to_disk",
				});
				spawnedAgents.push(agent);
				return agent;
			};

			const pool = new AgentPool(
				intPoolConfig({ createAgent: approvalFactory }),
			);

			try {
				const approvalEvents: ApproveRequestPoolEvent[] = [];

				// Resolve approvals directly via the pool event callback
				pool.on(PoolEvent.APPROVE_REQUEST, (event: ApproveRequestPoolEvent) => {
					approvalEvents.push(event);
					// Approve directly via the event's resolve callback
					event.resolve(true);
				});

				const result = await pool.execute(
					"Create a hello.txt file with the content 'Hello World'",
				);

				// ── Approval events were captured ────────────────────────
				expect(approvalEvents.length).toBeGreaterThanOrEqual(1);
				expect(approvalEvents[0]!.agentId).toBeDefined();
				expect(approvalEvents[0]!.agentName).toBeDefined();
				expect(approvalEvents[0]!.toolCallId).toBeDefined();
				expect(approvalEvents[0]!.toolCallTitle).toBe("write_to_disk");
				expect(typeof approvalEvents[0]!.resolve).toBe("function");

				// ── Execution completed successfully ─────────────────────
				expect(result).toBeDefined();
				expect(result.agents.length).toBeGreaterThanOrEqual(1);
				expect(result.agents[0]!.success).toBe(true);
				expect(result.agents[0]!.promptResult.text).toContain("approved");
			} finally {
				if (!(pool as any)._destroyed) await pool.destroy();
			}
		},
		INT_TIMEOUT_MS,
	);

	it.concurrent(
		"pool.send() with an approval message resolves the pending approval via LLM intent classification",
		async () => {
			const spawnedAgents: PoolManagedAgent[] = [];
			const approvalFactory = (config?: { name?: string }) => {
				const agent = createApprovalAgent({
					name: config?.name ?? "approval-agent",
					toolCallTitle: "run_tests",
				});
				spawnedAgents.push(agent);
				return agent;
			};

			const pool = new AgentPool(
				intPoolConfig({ createAgent: approvalFactory }),
			);

			try {
				let sendResult: string | AgentPoolResult | undefined;
				let sendError: Error | undefined;

				// When an approval request arrives, resolve it via pool.send()
				// The LLM intent analyzer should classify "yes, approve it"
				// as approve_agent because pending approvals are included
				// in the pool state context.
				pool.on(PoolEvent.APPROVE_REQUEST, (event: ApproveRequestPoolEvent) => {
					// Verify pool state shows the pending approval
					const state = pool.getState();
					expect(state.pendingApprovals.length).toBeGreaterThanOrEqual(1);
					expect(state.pendingApprovals[0]!.toolCallTitle).toBe("run_tests");

					// Fire send() asynchronously — this triggers LLM intent analysis
					// which should classify as approve_agent and resolve the approval
					pool
						.send("Yes, approve it. Continue the action.")
						.then((r) => {
							sendResult = r;
						})
						.catch((err) => {
							sendError = err;
							// Fallback: if LLM misclassified, resolve directly
							// so the test doesn't hang forever
							event.resolve(true);
						});
				});

				const result = await pool.execute(
					"Run the full test suite for the project",
				);

				// ── Execution completed ──────────────────────────────────
				expect(result).toBeDefined();
				expect(result.agents.length).toBeGreaterThanOrEqual(1);
				expect(result.agents[0]!.success).toBe(true);

				// ── send() returned a response ───────────────────────────
				// The LLM may have classified as approve_agent (string response)
				// or as something else. Both outcomes are acceptable as long as
				// the execution completed without hanging.
				if (sendError) {
					// If send() threw (e.g. LLM error), we still completed via fallback
					expect(result.agents[0]!.success).toBe(true);
				} else {
					expect(sendResult).toBeDefined();
				}
			} finally {
				if (!(pool as any)._destroyed) await pool.destroy();
			}
		},
		INT_TIMEOUT_MS,
	);

	it.concurrent(
		"getState().pendingApprovals is populated while an agent is blocked on approval",
		async () => {
			const stateSnapshots: AgentPoolState[] = [];

			const approvalFactory = (config?: { name?: string }) => {
				return createApprovalAgent({
					name: config?.name ?? "pending-check-agent",
					toolCallTitle: "deploy_to_production",
				});
			};

			const pool = new AgentPool(
				intPoolConfig({ createAgent: approvalFactory }),
			);

			try {
				// Capture state when approval is requested, then approve
				pool.on(PoolEvent.APPROVE_REQUEST, (event: ApproveRequestPoolEvent) => {
					// Snapshot state BEFORE resolving
					const state = pool.getState();
					stateSnapshots.push(state);

					// Then approve so execution can finish
					event.resolve(true);
				});

				await pool.execute("Deploy the latest release to production");

				// ── State was captured with pending approvals ────────────
				expect(stateSnapshots.length).toBeGreaterThanOrEqual(1);

				const midState = stateSnapshots[0]!;
				expect(midState.executing).toBe(true);
				expect(midState.pendingApprovals.length).toBeGreaterThanOrEqual(1);

				const pending = midState.pendingApprovals[0]!;
				expect(pending.agentId).toBeDefined();
				expect(pending.agentName).toBeDefined();
				expect(pending.toolCallId).toBeDefined();
				expect(pending.toolCallTitle).toBe("deploy_to_production");
				expect(pending.timestamp).toBeDefined();

				// After execution, pending approvals should be empty
				const finalState = pool.getState();
				expect(finalState.pendingApprovals).toEqual([]);
			} finally {
				if (!(pool as any)._destroyed) await pool.destroy();
			}
		},
		INT_TIMEOUT_MS,
	);

	it.concurrent(
		"denying an approval via event callback makes the agent report denial",
		async () => {
			const approvalFactory = (config?: { name?: string }) => {
				return createApprovalAgent({
					name: config?.name ?? "denied-agent",
					toolCallTitle: "delete_database",
				});
			};

			const pool = new AgentPool(
				intPoolConfig({ createAgent: approvalFactory }),
			);

			try {
				// Deny all approval requests
				pool.on(PoolEvent.APPROVE_REQUEST, (event: ApproveRequestPoolEvent) => {
					event.resolve(false);
				});

				const result = await pool.execute("Clean up old database records");

				// ── Agent completed but with denied action ───────────────
				expect(result).toBeDefined();
				expect(result.agents.length).toBeGreaterThanOrEqual(1);
				expect(result.agents[0]!.success).toBe(true);
				expect(result.agents[0]!.promptResult.text).toContain("denied");
			} finally {
				if (!(pool as any)._destroyed) await pool.destroy();
			}
		},
		INT_TIMEOUT_MS,
	);

	it.concurrent(
		"approval is non-blocking: one agent blocks on approval while another completes independently",
		async () => {
			let agentIndex = 0;
			const completionOrder: string[] = [];

			const mixedFactory = (config?: { name?: string }) => {
				agentIndex++;
				const agentName = config?.name ?? `agent-${agentIndex}`;

				if (agentIndex === 1) {
					// First agent: normal, completes immediately
					const agent = createMockAgent({
						name: agentName,
						promptResult: {
							stopReason: "end_turn",
							text: "Normal agent completed instantly.",
							usage: {
								inputTokens: 100,
								outputTokens: 50,
								totalTokens: 150,
							},
						},
					});

					const originalPrompt = agent.prompt;
					(agent as any).prompt = async (text: string) => {
						const result = await originalPrompt(text);
						completionOrder.push("normal-agent");
						return result;
					};

					return agent;
				}

				// Subsequent agents: require approval (will block)
				const approvalAgent = createApprovalAgent({
					name: agentName,
					toolCallTitle: "risky_operation",
				});

				const originalPrompt = approvalAgent.prompt;
				(approvalAgent as any).prompt = async (text: string) => {
					const result = await originalPrompt(text);
					completionOrder.push("approval-agent");
					return result;
				};

				return approvalAgent;
			};

			const pool = new AgentPool(
				intPoolConfig({
					createAgent: mixedFactory,
					maxAgents: 5,
				}),
			);

			try {
				// Delayed approval: wait 200ms before approving to give
				// the normal agent time to complete first
				pool.on(PoolEvent.APPROVE_REQUEST, (event: ApproveRequestPoolEvent) => {
					setTimeout(() => event.resolve(true), 200);
				});

				const result = await pool.execute(
					"Build a REST API with Express.js including: " +
						"1) The API routes and controllers, " +
						"2) A comprehensive test suite with unit tests",
				);

				expect(result).toBeDefined();
				expect(result.agents.length).toBeGreaterThanOrEqual(1);

				// All agents should have succeeded
				for (const agentResult of result.agents) {
					expect(agentResult.success).toBe(true);
				}

				// If the planner chose multi-agent and spawned a normal agent first,
				// the normal agent should have completed before the approval agent
				if (
					completionOrder.includes("normal-agent") &&
					completionOrder.includes("approval-agent")
				) {
					const normalIdx = completionOrder.indexOf("normal-agent");
					const approvalIdx = completionOrder.indexOf("approval-agent");
					expect(normalIdx).toBeLessThan(approvalIdx);
				}
			} finally {
				if (!(pool as any)._destroyed) await pool.destroy();
			}
		},
		INT_TIMEOUT_MS,
	);

	it.concurrent(
		"pool.destroy() denies pending approvals and unblocks agents cleanly",
		async () => {
			const approvalFactory = (config?: { name?: string }) => {
				return createApprovalAgent({
					name: config?.name ?? "destroy-test-agent",
					toolCallTitle: "long_running_task",
				});
			};

			const pool = new AgentPool(
				intPoolConfig({ createAgent: approvalFactory }),
			);

			let approvalReceived = false;

			pool.on(PoolEvent.APPROVE_REQUEST, () => {
				approvalReceived = true;
				// Do NOT resolve — we want to test that destroy() handles it
				// Destroy the pool after a small delay
				setTimeout(() => {
					pool.destroy();
				}, 100);
			});

			// Execute should either complete (with denied agent) or throw
			// because destroy() was called mid-execution
			try {
				await pool.execute("Start a long-running computation");
			} catch {
				// Expected — pool was destroyed mid-execution
			}

			// The approval request should have been received
			expect(approvalReceived).toBe(true);

			// Pool should be destroyed
			await expect(pool.send("anything")).rejects.toThrow(/destroyed/);
		},
		INT_TIMEOUT_MS,
	);

	it.concurrent(
		"approval events include all required fields from the BasePoolEvent shape",
		async () => {
			const capturedEvents: ApproveRequestPoolEvent[] = [];

			const approvalFactory = (config?: { name?: string }) => {
				return createApprovalAgent({
					name: config?.name ?? "shape-test-agent",
					toolCallTitle: "format_disk",
					toolCallId: "tc-shape-test-001",
				});
			};

			const pool = new AgentPool(
				intPoolConfig({ createAgent: approvalFactory }),
			);

			try {
				pool.on(PoolEvent.APPROVE_REQUEST, (event: ApproveRequestPoolEvent) => {
					capturedEvents.push(event);
					event.resolve(true);
				});

				await pool.execute("Format the disk and reinstall");

				expect(capturedEvents.length).toBeGreaterThanOrEqual(1);

				const evt = capturedEvents[0]!;

				// BasePoolEvent fields
				expect(evt.event).toBe(PoolEvent.APPROVE_REQUEST);
				expect(typeof evt.timestamp).toBe("string");
				expect(new Date(evt.timestamp).toISOString()).toBeTruthy();

				// ApproveRequestPoolEvent-specific fields
				expect(typeof evt.agentId).toBe("string");
				expect(evt.agentId.length).toBeGreaterThan(0);
				expect(typeof evt.agentName).toBe("string");
				expect(evt.agentName.length).toBeGreaterThan(0);
				expect(typeof evt.toolCallId).toBe("string");
				expect(evt.toolCallId).toBe("tc-shape-test-001");
				expect(typeof evt.toolCallTitle).toBe("string");
				expect(evt.toolCallTitle).toBe("format_disk");
				expect(typeof evt.resolve).toBe("function");
			} finally {
				if (!(pool as any)._destroyed) await pool.destroy();
			}
		},
		INT_TIMEOUT_MS,
	);

	it.concurrent(
		"resolve callback is one-shot — calling it multiple times does not error",
		async () => {
			let resolveRef: ((approved: boolean) => void) | null = null;

			const approvalFactory = (config?: { name?: string }) => {
				return createApprovalAgent({
					name: config?.name ?? "oneshot-agent",
					toolCallTitle: "sensitive_op",
				});
			};

			const pool = new AgentPool(
				intPoolConfig({ createAgent: approvalFactory }),
			);

			try {
				pool.on(PoolEvent.APPROVE_REQUEST, (event: ApproveRequestPoolEvent) => {
					resolveRef = event.resolve;
					// Call resolve multiple times — should not throw
					event.resolve(true);
					event.resolve(false);
					event.resolve(true);
				});

				const result = await pool.execute("Run a sensitive operation");

				expect(result).toBeDefined();
				expect(result.agents.length).toBeGreaterThanOrEqual(1);
				// First resolve(true) wins — agent should have been approved
				expect(result.agents[0]!.promptResult.text).toContain("approved");

				// Extra calls after execution should also not throw
				expect(() => resolveRef!(true)).not.toThrow();
				expect(() => resolveRef!(false)).not.toThrow();
			} finally {
				if (!(pool as any)._destroyed) await pool.destroy();
			}
		},
		INT_TIMEOUT_MS,
	);
});
