import { afterEach, describe, expect, it } from "bun:test";
import { SpanStatusCode } from "@opentelemetry/api";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Tracer } from "../tracer.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Creates an InMemorySpanExporter + BasicTracerProvider for test inspection. */
function createTestProvider(): {
	exporter: InMemorySpanExporter;
	provider: BasicTracerProvider;
} {
	const exporter = new InMemorySpanExporter();
	const provider = new BasicTracerProvider({
		spanProcessors: [new SimpleSpanProcessor(exporter)],
	});
	return { exporter, provider };
}

/** Creates a Tracer wired to an in-memory exporter for assertions. */
function createTestTracer(
	parentSpanContext?: import("@opentelemetry/api").SpanContext,
): {
	tracer: Tracer;
	exporter: InMemorySpanExporter;
	provider: BasicTracerProvider;
} {
	const { exporter, provider } = createTestProvider();
	const tracer = new Tracer({
		enabled: true,
		provider,
		parentSpanContext,
	});
	return { tracer, exporter, provider };
}

/** Finds a span by name from a list of finished spans. */
function findSpan(
	spans: ReadableSpan[],
	name: string,
): ReadableSpan | undefined {
	return spans.find((s) => s.name === name);
}

/** Finds all spans with the given name. */
function findSpans(spans: ReadableSpan[], name: string): ReadableSpan[] {
	return spans.filter((s) => s.name === name);
}

/**
 * Extracts the parent span ID from a ReadableSpan.
 * In sdk-trace-base v2.x, parentSpanId was replaced by parentSpanContext.
 */
function parentSpanId(span: ReadableSpan): string | undefined {
	const parentCtx = (span as any).parentSpanContext;
	if (parentCtx && typeof parentCtx.spanId === "string") {
		return parentCtx.spanId;
	}
	return (span as any).parentSpanId;
}

/**
 * Ends all live spans on a tracer, flushes them to the exporter, then
 * snapshots the finished spans BEFORE shutdown clears the exporter.
 */
async function shutdownAndCollect(
	tracer: Tracer,
	exporter: InMemorySpanExporter,
): Promise<ReadableSpan[]> {
	await tracer.flush();
	const spans = [...exporter.getFinishedSpans()];
	await tracer.shutdown();
	return spans;
}

/**
 * Builds a lookup: spanId → list of child spans.
 */
function buildChildrenMap(spans: ReadableSpan[]): Map<string, ReadableSpan[]> {
	const map = new Map<string, ReadableSpan[]>();
	for (const span of spans) {
		const pid = parentSpanId(span);
		if (pid) {
			const children = map.get(pid) ?? [];
			children.push(span);
			map.set(pid, children);
		}
	}
	return map;
}

/**
 * Verifies that every parentSpanId referenced in the span set exists
 * as an actual spanId in the same set. Returns the list of orphan
 * parentSpanIds (should be empty for "0 Missing").
 */
function findMissingParents(spans: ReadableSpan[]): string[] {
	const knownIds = new Set(spans.map((s) => s.spanContext().spanId));
	const missing: string[] = [];
	for (const span of spans) {
		const pid = parentSpanId(span);
		if (pid && !knownIds.has(pid)) {
			missing.push(pid);
		}
	}
	return [...new Set(missing)];
}

// ── Types for the simulation ───────────────────────────────────────────────

interface SimulatedAgent {
	name: string;
	tracer: Tracer;
	exporter: InMemorySpanExporter;
}

const AGENT_ROLES = [
	"backend-developer",
	"frontend-developer",
	"test-engineer",
] as const;

// ── Test Suite ─────────────────────────────────────────────────────────────

describe("Tracer — Pool Hierarchy (Full Lifecycle)", () => {
	let poolTracer: Tracer;
	let poolExporter: InMemorySpanExporter;
	let _poolProvider: BasicTracerProvider;
	const agents: SimulatedAgent[] = [];

	afterEach(async () => {
		for (const agent of agents) {
			await agent.tracer.shutdown();
		}
		agents.length = 0;
		if (poolTracer) {
			await poolTracer.shutdown();
		}
	});

	/**
	 * Simulates the full AgentPool lifecycle using the new ALS-based API:
	 *
	 *   pool.lifecycle (root)
	 *     └─ pool.execution
	 *          ├─ pool.planning
	 *          ├─ pool.spawn-agents
	 *          │    ├─ pool.agent.spawn: backend-developer   (siblings!)
	 *          │    │    └─ agent.session: backend-developer
	 *          │    │         ├─ agent.initialize
	 *          │    │         └─ agent.prompt
	 *          │    │              └─ agent.tool_call
	 *          │    ├─ pool.agent.spawn: frontend-developer  (siblings!)
	 *          │    │    └─ agent.session: frontend-developer
	 *          │    │         ├─ agent.initialize
	 *          │    │         └─ agent.prompt
	 *          │    │              └─ agent.tool_call
	 *          │    └─ pool.agent.spawn: test-engineer       (siblings!)
	 *          │         └─ agent.session: test-engineer
	 *          │              ├─ agent.initialize
	 *          │              └─ agent.prompt
	 *          │                   └─ agent.tool_call
	 *          ├─ pool.execute-subtasks
	 *          │    ├─ pool.subtask.execute: backend-developer   (siblings!)
	 *          │    ├─ pool.subtask.execute: frontend-developer  (siblings!)
	 *          │    └─ pool.subtask.execute: test-engineer       (siblings!)
	 *          ├─ pool.summary
	 *          └─ pool.cleanup
	 *
	 * With ALS, parent resolution is automatic:
	 * - Inside `wrap("pool.spawn-agents", ...)`, any nested `wrap()` is
	 *   automatically a child of pool.spawn-agents — even in `Promise.all`.
	 * - No need for explicit parent passing or enterSpan/leaveSpan.
	 *
	 * Returns all spans from both the pool and all agent tracers, merged.
	 */
	async function simulateFullLifecycle(): Promise<ReadableSpan[]> {
		// ── Pool Tracer Setup ────────────────────────────────────────
		({
			tracer: poolTracer,
			exporter: poolExporter,
			provider: _poolProvider,
		} = createTestTracer());

		poolTracer.startRootSpan("pool.lifecycle", {
			"pool.id": "pool-001",
			"pool.name": "Test Pool",
			"pool.model": "anthropic/claude-opus-4",
			"pool.max_agents": 3,
		});

		// ── pool.execution ───────────────────────────────────────────
		await poolTracer.wrap(
			"pool.execution",
			{
				"pool.task": "Build a REST API",
				"pool.task_length": 17,
			},
			async (_executionSpan) => {
				// ── Phase 1: Planning ────────────────────────────────────
				await poolTracer.wrap("pool.planning", async (span) => {
					span.setAttribute("pool.planning.strategy", "parallel");
					span.setAttribute("pool.planning.subtask_count", 3);
					span.setAttribute("pool.planning.complexity", "medium");
				});

				// ── Phase 2: Spawn Agents ────────────────────────────────
				// With ALS, each wrap() inside Promise.all automatically gets
				// pool.spawn-agents as parent — no explicit parent needed.
				await poolTracer.wrap("pool.spawn-agents", async (spawnAgentsSpan) => {
					// Log emitted inside wrap callback — carries pool.spawn-agents SpanId
					const ctxBeforeSpawns = poolTracer.getContext();
					expect(ctxBeforeSpawns?.SpanId).toBe(
						spawnAgentsSpan.spanContext().spanId,
					);

					// Spawn all agents in parallel
					await Promise.all(
						AGENT_ROLES.map(async (role) => {
							// Each pool.agent.spawn is automatically a child of
							// pool.spawn-agents via ALS context propagation
							await poolTracer.wrap(
								"pool.agent.spawn",
								{
									"pool.agent.role": role,
									"pool.agent.subtask_id": `subtask-${role}`,
								},
								async (spawnSpan) => {
									// Get this spawn's own context for the child agent
									const agentParentCtx = spawnSpan.spanContext();

									// Create a child agent tracer linked to this spawnSpan
									const agentSetup = createTestTracer(agentParentCtx);
									const agent: SimulatedAgent = {
										name: role,
										tracer: agentSetup.tracer,
										exporter: agentSetup.exporter,
									};
									agents.push(agent);

									// Agent starts its root span (agent.session)
									agent.tracer.startRootSpan("agent.session", {
										"agent.id": `agent-${role}`,
										"agent.name": role,
									});

									// Agent emits a log with root span context
									const agentRootCtx = agent.tracer.getContext();
									expect(agentRootCtx).toBeDefined();
									expect(agentRootCtx!.SpanId).toBe(
										agent.tracer.getRootSpanContext()!.spanId,
									);

									// Agent initialize phase (child of root via ALS)
									await agent.tracer.wrap("agent.initialize", async () => {});

									// Mark spawn complete
									spawnSpan.setAttribute("pool.agent.id", `agent-${role}`);
									spawnSpan.setAttribute("pool.agent.name", role);
								},
							);
						}),
					);

					spawnAgentsSpan.setAttribute("pool.spawn.agent_count", agents.length);

					// Log after spawns — still carries pool.spawn-agents SpanId
					const ctxAfterSpawns = poolTracer.getContext();
					expect(ctxAfterSpawns?.SpanId).toBe(
						spawnAgentsSpan.spanContext().spanId,
					);
				});

				// ── Phase 3: Execute Subtasks ────────────────────────────
				await poolTracer.wrap("pool.execute-subtasks", async (executeSpan) => {
					// Log inside wrap callback — carries pool.execute-subtasks SpanId
					const ctxInside = poolTracer.getContext();
					expect(ctxInside?.SpanId).toBe(executeSpan.spanContext().spanId);

					// Execute all subtasks in parallel
					await Promise.all(
						agents.map(async (agent) => {
							// Each pool.subtask.execute is automatically a child of
							// pool.execute-subtasks via ALS
							await poolTracer.wrap(
								"pool.subtask.execute",
								{
									"pool.subtask.role": agent.name,
									"pool.subtask.agent_id": `agent-${agent.name}`,
									"pool.subtask.agent_name": agent.name,
								},
								async (subtaskSpan) => {
									// Simulate agent prompt
									await agent.tracer.wrap(
										"agent.prompt",
										{
											"prompt.index": 1,
											"prompt.text": `Implement ${agent.name} tasks`,
										},
										async () => {
											// Simulate a tool call inside the prompt
											await agent.tracer.wrap(
												"agent.tool_call",
												{
													"tool.call_id": `tc-${agent.name}`,
													"tool.title": "Edit file",
													"tool.kind": "edit",
												},
												async () => {},
											);
										},
									);

									subtaskSpan.setAttribute(
										"pool.subtask.stop_reason",
										"end_turn",
									);
								},
							);
						}),
					);

					executeSpan.setAttribute("pool.execute.result_count", agents.length);
					executeSpan.setAttribute("pool.execute.success_count", agents.length);
					executeSpan.setAttribute("pool.execute.failure_count", 0);
				});

				// ── Phase 4+5: Summary + Cleanup (parallel) ──────────────
				// With ALS, both wrap() calls share executionSpan as parent
				// because we're inside the pool.execution wrap() callback.
				await Promise.all([
					poolTracer.wrap("pool.summary", async (_span) => {
						// Simulates generateSummary()
					}),
					poolTracer.wrap("pool.cleanup", async (_span) => {
						// Simulates destroyManagedAgents()
						for (const agent of agents) {
							await agent.tracer.flush();
						}
					}),
				]);
			},
		);

		// forceExport — non-destructive
		await poolTracer.forceExport();

		// ── Collect all spans ────────────────────────────────────────
		const poolSpans = await shutdownAndCollect(poolTracer, poolExporter);

		const agentSpans: ReadableSpan[] = [];
		for (const agent of agents) {
			const spans = [...agent.exporter.getFinishedSpans()];
			agentSpans.push(...spans);
			await agent.tracer.shutdown();
		}

		return [...poolSpans, ...agentSpans];
	}

	// ── Core Hierarchy Tests ───────────────────────────────────────────

	it("produces 0 missing spans — every parentSpanId references an existing span", async () => {
		const allSpans = await simulateFullLifecycle();
		const missing = findMissingParents(allSpans);
		expect(missing).toEqual([]);
	});

	it("produces the expected span counts (13 pool + 12 agent = 25 total)", async () => {
		const allSpans = await simulateFullLifecycle();

		// Pool spans: pool.lifecycle, pool.execution, pool.planning,
		//   pool.spawn-agents, 3x pool.agent.spawn, pool.execute-subtasks,
		//   3x pool.subtask.execute, pool.summary, pool.cleanup = 13
		// Agent spans: 3x agent.session, 3x agent.initialize,
		//   3x agent.prompt, 3x agent.tool_call = 12
		// Total = 25

		const poolSpanNames = allSpans
			.filter((s) => s.name.startsWith("pool."))
			.map((s) => s.name);
		const agentSpanNames = allSpans
			.filter((s) => s.name.startsWith("agent."))
			.map((s) => s.name);

		expect(poolSpanNames).toContain("pool.lifecycle");
		expect(poolSpanNames).toContain("pool.execution");
		expect(poolSpanNames).toContain("pool.planning");
		expect(poolSpanNames).toContain("pool.spawn-agents");
		expect(poolSpanNames).toContain("pool.execute-subtasks");
		expect(poolSpanNames).toContain("pool.summary");
		expect(poolSpanNames).toContain("pool.cleanup");
		expect(findSpans(allSpans, "pool.agent.spawn")).toHaveLength(3);
		expect(findSpans(allSpans, "pool.subtask.execute")).toHaveLength(3);

		expect(agentSpanNames).toContain("agent.session");
		expect(agentSpanNames).toContain("agent.initialize");
		expect(agentSpanNames).toContain("agent.prompt");
		expect(agentSpanNames).toContain("agent.tool_call");
		expect(findSpans(allSpans, "agent.session")).toHaveLength(3);
		expect(findSpans(allSpans, "agent.initialize")).toHaveLength(3);
		expect(findSpans(allSpans, "agent.prompt")).toHaveLength(3);
		expect(findSpans(allSpans, "agent.tool_call")).toHaveLength(3);

		expect(allSpans).toHaveLength(25);
	});

	it("all spans share the same traceId", async () => {
		const allSpans = await simulateFullLifecycle();

		const traceIds = new Set(allSpans.map((s) => s.spanContext().traceId));
		expect(traceIds.size).toBe(1);
	});

	it("pool.lifecycle is the root span (no parent)", async () => {
		const allSpans = await simulateFullLifecycle();

		const root = findSpan(allSpans, "pool.lifecycle");
		expect(root).toBeDefined();
		expect(parentSpanId(root!)).toBeUndefined();
	});

	it("pool.execution is a child of pool.lifecycle", async () => {
		const allSpans = await simulateFullLifecycle();

		const root = findSpan(allSpans, "pool.lifecycle")!;
		const execution = findSpan(allSpans, "pool.execution")!;

		expect(parentSpanId(execution)).toBe(root.spanContext().spanId);
	});

	it("pool.planning, pool.spawn-agents, pool.execute-subtasks, pool.summary, pool.cleanup are all children of pool.execution", async () => {
		const allSpans = await simulateFullLifecycle();

		const execution = findSpan(allSpans, "pool.execution")!;
		const executionId = execution.spanContext().spanId;

		const expectedChildren = [
			"pool.planning",
			"pool.spawn-agents",
			"pool.execute-subtasks",
			"pool.summary",
			"pool.cleanup",
		];

		for (const name of expectedChildren) {
			const span = findSpan(allSpans, name);
			expect(span).toBeDefined();
			expect(parentSpanId(span!)).toBe(executionId);
		}
	});

	it("all 3 pool.agent.spawn spans are siblings under pool.spawn-agents (NOT chained)", async () => {
		const allSpans = await simulateFullLifecycle();

		const spawnAgents = findSpan(allSpans, "pool.spawn-agents")!;
		const spawnAgentsId = spawnAgents.spanContext().spanId;

		const spawnSpans = findSpans(allSpans, "pool.agent.spawn");
		expect(spawnSpans).toHaveLength(3);

		// Every spawn span must be a child of pool.spawn-agents
		for (const spawn of spawnSpans) {
			expect(parentSpanId(spawn)).toBe(spawnAgentsId);
		}

		// Verify they are NOT chained: no spawn span should be a parent of another
		const spawnIds = new Set(spawnSpans.map((s) => s.spanContext().spanId));
		for (const spawn of spawnSpans) {
			const pid = parentSpanId(spawn)!;
			expect(spawnIds.has(pid)).toBe(false);
		}
	});

	it("all 3 pool.subtask.execute spans are siblings under pool.execute-subtasks (NOT chained)", async () => {
		const allSpans = await simulateFullLifecycle();

		const executeSubtasks = findSpan(allSpans, "pool.execute-subtasks")!;
		const executeSubtasksId = executeSubtasks.spanContext().spanId;

		const subtaskSpans = findSpans(allSpans, "pool.subtask.execute");
		expect(subtaskSpans).toHaveLength(3);

		for (const subtask of subtaskSpans) {
			expect(parentSpanId(subtask)).toBe(executeSubtasksId);
		}

		// Verify they are NOT chained
		const subtaskIds = new Set(subtaskSpans.map((s) => s.spanContext().spanId));
		for (const subtask of subtaskSpans) {
			const pid = parentSpanId(subtask)!;
			expect(subtaskIds.has(pid)).toBe(false);
		}
	});

	it("pool.summary and pool.cleanup are siblings under pool.execution (NOT chained)", async () => {
		const allSpans = await simulateFullLifecycle();

		const execution = findSpan(allSpans, "pool.execution")!;
		const executionId = execution.spanContext().spanId;

		const summary = findSpan(allSpans, "pool.summary")!;
		const cleanup = findSpan(allSpans, "pool.cleanup")!;

		// Both must be children of pool.execution, not of each other
		expect(parentSpanId(summary)).toBe(executionId);
		expect(parentSpanId(cleanup)).toBe(executionId);
		expect(parentSpanId(cleanup)).not.toBe(summary.spanContext().spanId);
	});

	it("each agent.session is a child of its corresponding pool.agent.spawn", async () => {
		const allSpans = await simulateFullLifecycle();

		const spawnSpans = findSpans(allSpans, "pool.agent.spawn");
		const sessionSpans = findSpans(allSpans, "agent.session");

		expect(spawnSpans).toHaveLength(3);
		expect(sessionSpans).toHaveLength(3);

		// Each agent.session's parent must be one of the pool.agent.spawn spans
		const spawnIds = new Set(spawnSpans.map((s) => s.spanContext().spanId));
		for (const session of sessionSpans) {
			const pid = parentSpanId(session);
			expect(pid).toBeDefined();
			expect(spawnIds.has(pid!)).toBe(true);
		}

		// Each spawn should have exactly one agent.session child
		for (const spawn of spawnSpans) {
			const children = sessionSpans.filter(
				(s) => parentSpanId(s) === spawn.spanContext().spanId,
			);
			expect(children).toHaveLength(1);
		}
	});

	it("each agent.initialize is a child of its agent.session", async () => {
		const allSpans = await simulateFullLifecycle();

		const sessionSpans = findSpans(allSpans, "agent.session");
		const initSpans = findSpans(allSpans, "agent.initialize");

		expect(initSpans).toHaveLength(3);

		const sessionIds = new Set(sessionSpans.map((s) => s.spanContext().spanId));
		for (const init of initSpans) {
			expect(sessionIds.has(parentSpanId(init)!)).toBe(true);
		}
	});

	it("each agent.prompt is a child of its agent.session", async () => {
		const allSpans = await simulateFullLifecycle();

		const sessionSpans = findSpans(allSpans, "agent.session");
		const promptSpans = findSpans(allSpans, "agent.prompt");

		expect(promptSpans).toHaveLength(3);

		const sessionIds = new Set(sessionSpans.map((s) => s.spanContext().spanId));
		for (const prompt of promptSpans) {
			expect(sessionIds.has(parentSpanId(prompt)!)).toBe(true);
		}
	});

	it("each agent.tool_call is a child of its agent.prompt", async () => {
		const allSpans = await simulateFullLifecycle();

		const promptSpans = findSpans(allSpans, "agent.prompt");
		const toolSpans = findSpans(allSpans, "agent.tool_call");

		expect(toolSpans).toHaveLength(3);

		const promptIds = new Set(promptSpans.map((s) => s.spanContext().spanId));
		for (const tool of toolSpans) {
			expect(promptIds.has(parentSpanId(tool)!)).toBe(true);
		}
	});

	// ── Trace Context (log correlation) Tests ──────────────────────────

	it("pool.spawn-agents span is visible in trace context during its callback", async () => {
		const { tracer, exporter } = createTestTracer();
		poolTracer = tracer;
		poolExporter = exporter;

		tracer.startRootSpan("pool.lifecycle");

		await tracer.wrap("pool.execution", async () => {
			let spawnAgentsSpanId: string | undefined;

			await tracer.wrap("pool.spawn-agents", async (span) => {
				spawnAgentsSpanId = span.spanContext().spanId;

				// getContext should return the pool.spawn-agents span's ID
				const ctx = tracer.getContext();
				expect(ctx).toBeDefined();
				expect(ctx!.SpanId).toBe(spawnAgentsSpanId);
			});

			expect(spawnAgentsSpanId).toBeDefined();
		});
	});

	it("pool.execute-subtasks span is visible in trace context during its callback", async () => {
		const { tracer, exporter } = createTestTracer();
		poolTracer = tracer;
		poolExporter = exporter;

		tracer.startRootSpan("pool.lifecycle");

		await tracer.wrap("pool.execution", async () => {
			let executeSpanId: string | undefined;

			await tracer.wrap("pool.execute-subtasks", async (span) => {
				executeSpanId = span.spanContext().spanId;

				const ctx = tracer.getContext();
				expect(ctx).toBeDefined();
				expect(ctx!.SpanId).toBe(executeSpanId);
			});

			expect(executeSpanId).toBeDefined();
		});
	});

	it("agent.session root span is visible in trace context before initialize starts", async () => {
		const { provider: parentProvider } = createTestProvider();
		const parentTracer = new Tracer({
			enabled: true,
			provider: parentProvider,
		});
		parentTracer.startRootSpan("pool.lifecycle");

		await parentTracer.wrap("pool.execution", async () => {
			await parentTracer.wrap("pool.agent.spawn", async (spawnSpan) => {
				const parentCtx = spawnSpan.spanContext();

				// Create agent tracer linked to pool
				const agentSetup = createTestTracer(parentCtx);
				const agentTracer = agentSetup.tracer;

				agentTracer.startRootSpan("agent.session", {
					"agent.id": "test-id",
					"agent.name": "test-agent",
				});

				// BEFORE initialize pushes any child span, getContext
				// should resolve to the root span (agent.session)
				const ctx = agentTracer.getContext();
				expect(ctx).toBeDefined();
				expect(ctx!.SpanId).toBe(agentTracer.getRootSpanContext()!.spanId);

				// Now simulate initialize pushing a child span via wrap
				await agentTracer.wrap("agent.initialize", async () => {
					// After entering wrap, getContext should return initSpan's ID
					const ctxAfterInit = agentTracer.getContext();
					expect(ctxAfterInit!.SpanId).not.toBe(
						agentTracer.getRootSpanContext()!.spanId,
					);
				});

				// After wrap completes, context reverts to root
				const ctxAfterWrap = agentTracer.getContext();
				expect(ctxAfterWrap!.SpanId).toBe(
					agentTracer.getRootSpanContext()!.spanId,
				);

				await agentTracer.shutdown();
			});
		});

		await parentTracer.shutdown();

		// Prevent afterEach from double-shutting down
		poolTracer = new Tracer({ enabled: false });
	});

	// ── forceExport Tests ──────────────────────────────────────────────

	it("forceExport does not destroy tracer state", async () => {
		const { tracer, exporter } = createTestTracer();
		poolTracer = tracer;
		poolExporter = exporter;

		tracer.startRootSpan("pool.lifecycle");

		await tracer.wrap("pool.execution", async (execSpan) => {
			// End a child span so there's something to export
			await tracer.wrap("pool.planning", async () => {});

			// forceExport should NOT end the root or execution span
			await tracer.forceExport();

			// Root span should still be alive
			expect(tracer.getRootSpanContext()).toBeDefined();

			// getContext should still work (we're inside wrap)
			const ctx = tracer.getContext();
			expect(ctx).toBeDefined();
			expect(ctx!.SpanId).toBe(execSpan.spanContext().spanId);

			// We can still create new spans
			await tracer.wrap("pool.after-export", async (newSpan) => {
				expect(newSpan.isRecording()).toBe(true);
			});
		});
	});

	// ── Concurrency Safety Tests ───────────────────────────────────────

	it("concurrent wrap() calls within a parent wrap() produce correct siblings (ALS handles concurrency)", async () => {
		const { tracer, exporter } = createTestTracer();
		poolTracer = tracer;
		poolExporter = exporter;

		tracer.startRootSpan("pool.lifecycle");

		await tracer.wrap("pool.execution", async () => {
			await tracer.wrap("pool.spawn-agents", async (_spawnAgentsSpan) => {
				// Simulate concurrent spawns — ALS automatically resolves each
				// wrap() parent to pool.spawn-agents
				const concurrentWork = AGENT_ROLES.map(async (role) => {
					await tracer.wrap(
						"pool.agent.spawn",
						{ "pool.agent.role": role },
						async () => {
							// Simulate async work
							await new Promise((resolve) => setTimeout(resolve, 5));
						},
					);
				});

				await Promise.all(concurrentWork);
			});
		});

		const spans = await shutdownAndCollect(tracer, exporter);

		const spawnAgents = findSpan(spans, "pool.spawn-agents")!;
		const spawnSpans = findSpans(spans, "pool.agent.spawn");

		expect(spawnSpans).toHaveLength(3);

		// All spawn spans must be siblings under pool.spawn-agents
		for (const spawn of spawnSpans) {
			expect(parentSpanId(spawn)).toBe(spawnAgents.spanContext().spanId);
		}

		// Verify they are NOT chained
		const spawnIds = new Set(spawnSpans.map((s) => s.spanContext().spanId));
		for (const spawn of spawnSpans) {
			const pid = parentSpanId(spawn)!;
			expect(spawnIds.has(pid)).toBe(false);
		}
	});

	it("concurrent Promise.all wrap() calls produce correct siblings (ALS fixes the old chaining bug)", async () => {
		const { tracer, exporter } = createTestTracer();
		poolTracer = tracer;
		poolExporter = exporter;

		tracer.startRootSpan("pool.lifecycle");

		await tracer.wrap("pool.execution", async (executionSpan) => {
			const _executionId = executionSpan.spanContext().spanId;

			// With ALS, both wrap() calls get pool.execution as parent
			// because ALS context is inherited per-callback (not shared stack)
			await Promise.all([
				tracer.wrap("pool.summary", async (_span) => {
					await new Promise((resolve) => setTimeout(resolve, 5));
				}),
				tracer.wrap("pool.cleanup", async (_span) => {
					await new Promise((resolve) => setTimeout(resolve, 5));
				}),
			]);

			// Verify after the fact (spans are already ended)
			// We need to check the exporter
		});

		const spans = await shutdownAndCollect(tracer, exporter);

		const execution = findSpan(spans, "pool.execution")!;
		const executionId = execution.spanContext().spanId;
		const summary = findSpan(spans, "pool.summary")!;
		const cleanup = findSpan(spans, "pool.cleanup")!;

		// BOTH should be children of pool.execution — not chained!
		expect(parentSpanId(summary)).toBe(executionId);
		expect(parentSpanId(cleanup)).toBe(executionId);
		// cleanup should NOT be a child of summary
		expect(parentSpanId(cleanup)).not.toBe(summary.spanContext().spanId);
	});

	// ── Full structural equality check ─────────────────────────────────

	it("the complete span tree matches the expected hierarchy exactly", async () => {
		const allSpans = await simulateFullLifecycle();

		const childrenMap = buildChildrenMap(allSpans);

		// Build the actual hierarchy as a simplified tree structure
		function getTree(sid: string): Record<string, any> {
			const children = childrenMap.get(sid) ?? [];
			const node: Record<string, any> = {};
			for (const child of children) {
				const key = child.name;
				const subtree = getTree(child.spanContext().spanId);
				// Handle duplicate names by appending role attribute
				const role =
					(child.attributes["pool.agent.role"] as string) ??
					(child.attributes["pool.subtask.role"] as string) ??
					(child.attributes["agent.name"] as string);
				const uniqueKey = role ? `${key}:${role}` : key;
				node[uniqueKey] = Object.keys(subtree).length > 0 ? subtree : "leaf";
			}
			return node;
		}

		const root = findSpan(allSpans, "pool.lifecycle")!;
		const tree = getTree(root.spanContext().spanId);

		// Verify top level
		expect(tree).toHaveProperty(["pool.execution"]);
		const execution = tree["pool.execution"];

		// Verify execution children
		expect(execution).toHaveProperty(["pool.planning"]);
		expect(execution).toHaveProperty(["pool.spawn-agents"]);
		expect(execution).toHaveProperty(["pool.execute-subtasks"]);
		expect(execution).toHaveProperty(["pool.summary"]);
		expect(execution).toHaveProperty(["pool.cleanup"]);

		// Verify spawn-agents children (3 siblings)
		const spawnAgents = execution["pool.spawn-agents"];
		const spawnKeys = Object.keys(spawnAgents);
		expect(spawnKeys).toHaveLength(3);

		for (const role of AGENT_ROLES) {
			const spawnKey = `pool.agent.spawn:${role}`;
			expect(spawnAgents).toHaveProperty([spawnKey]);

			// Each spawn should have exactly one child: agent.session
			const spawnChildren = spawnAgents[spawnKey];
			const sessionKey = `agent.session:${role}`;
			expect(spawnChildren).toHaveProperty([sessionKey]);

			// Each session should have agent.initialize and agent.prompt
			const sessionChildren = spawnChildren[sessionKey];
			expect(sessionChildren).toHaveProperty(["agent.initialize"]);
			expect(sessionChildren).toHaveProperty(["agent.prompt"]);

			// Each prompt should have agent.tool_call
			const promptChildren = sessionChildren["agent.prompt"];
			expect(promptChildren).toHaveProperty(["agent.tool_call"]);
		}

		// Verify execute-subtasks children (3 siblings)
		const executeSubtasks = execution["pool.execute-subtasks"];
		const subtaskKeys = Object.keys(executeSubtasks);
		expect(subtaskKeys).toHaveLength(3);

		for (const role of AGENT_ROLES) {
			expect(executeSubtasks).toHaveProperty([`pool.subtask.execute:${role}`]);
		}

		// Summary and cleanup are leaves (no children)
		expect(execution["pool.planning"]).toBe("leaf");
		expect(execution["pool.summary"]).toBe("leaf");
		expect(execution["pool.cleanup"]).toBe("leaf");
	});

	it("every span has a unique spanId", async () => {
		const allSpans = await simulateFullLifecycle();

		const ids = allSpans.map((s) => s.spanContext().spanId);
		const uniqueIds = new Set(ids);
		expect(uniqueIds.size).toBe(ids.length);
	});

	it("every span has a valid 16-hex-char spanId and 32-hex-char traceId", async () => {
		const allSpans = await simulateFullLifecycle();

		for (const span of allSpans) {
			const ctx = span.spanContext();
			expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
			expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
		}
	});

	it("all spans end with OK status (no errors in happy path)", async () => {
		const allSpans = await simulateFullLifecycle();

		for (const span of allSpans) {
			expect(span.status.code).toBe(SpanStatusCode.OK);
		}
	});
});
