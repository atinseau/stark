/**
 * Centralized registry of all trace span names used across the project.
 *
 * Using an enum instead of scattered string literals ensures:
 *   - Typos are caught at compile time
 *   - Refactoring span names is a single-point change
 *   - All span names are discoverable via IDE autocompletion
 *
 * Naming convention: `<domain>.<operation>[.<sub_operation>]`
 *
 * @example
 * ```ts
 * tracer.wrap(SpanName.AGENT_PROMPT, { "prompt.index": 1 }, async (span) => {
 *   await tracer.wrap(SpanName.AGENT_TOOL_CALL, async () => { ... });
 * });
 * ```
 */
export enum SpanName {
	// ── Agent ──────────────────────────────────────────────────────────

	/** Root span for the entire agent session lifetime. */
	AGENT_SESSION = "agent.session",

	/** Agent initialization phase (spawn + ACP init + session creation). */
	AGENT_INITIALIZE = "agent.initialize",

	/** Sub-phase: spawning the ACP child process. */
	AGENT_SPAWN_PROCESS = "agent.initialize.spawn_process",

	/** Sub-phase: ACP protocol initialization handshake. */
	AGENT_ACP_PROTOCOL_INIT = "agent.initialize.acp_protocol_init",

	/** Sub-phase: creating the ACP session. */
	AGENT_CREATE_SESSION = "agent.initialize.create_session",

	/** A single prompt turn (user → agent → response). */
	AGENT_PROMPT = "agent.prompt",

	/** A tool call invoked by the agent during a prompt. */
	AGENT_TOOL_CALL = "agent.tool_call",

	/** A permission request for a tool call. */
	AGENT_PERMISSION = "agent.permission",

	/** A terminal session spawned by the agent. */
	AGENT_TERMINAL = "agent.terminal",

	/** A file system write operation. */
	AGENT_FS_WRITE = "agent.fs.write",

	/** A file system read operation. */
	AGENT_FS_READ = "agent.fs.read",

	// ── Pool ──────────────────────────────────────────────────────────

	/** Root span for the entire pool lifetime. */
	POOL_LIFECYCLE = "pool.lifecycle",

	/** A single task execution (planning → spawn → execute → summary). */
	POOL_EXECUTION = "pool.execution",

	/** Phase 1: LLM-based task analysis and subtask decomposition. */
	POOL_PLANNING = "pool.planning",

	/** Phase 2: spawning all agents in parallel. */
	POOL_SPAWN_AGENTS = "pool.spawn_agents",

	/** Per-agent spawn within the spawn phase. */
	POOL_AGENT_SPAWN = "pool.agent.spawn",

	/** Phase 3: executing all subtasks in parallel. */
	POOL_EXECUTE_SUBTASKS = "pool.execute_subtasks",

	/** Per-subtask execution within the execute phase. */
	POOL_SUBTASK_EXECUTE = "pool.subtask.execute",

	/** Phase 4: generating the execution summary. */
	POOL_SUMMARY = "pool.summary",

	/** Phase 5: destroying managed agents after execution. */
	POOL_CLEANUP = "pool.cleanup",

	/** Intent analysis for a user message in conversational mode. */
	POOL_INTENT_ANALYSIS = "pool.intent_analysis",
}
