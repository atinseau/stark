/**
 * All event types emitted by an Agent instance.
 *
 * Events are grouped by domain:
 *   - `agent:*`      → Agent lifecycle events
 *   - `prompt:*`     → Prompt turn events
 *   - `tool:*`       → Tool call events
 *   - `plan:*`       → Execution plan events
 *   - `permission:*` → Permission request/response events
 *   - `terminal:*`   → Terminal lifecycle events
 *   - `fs:*`         → File system operation events
 *   - `usage:*`      → Token usage and cost events
 *   - `context:*`    → Context injection events
 *   - `mode:*`       → Session mode events
 *   - `config:*`     → Session config events
 */
export enum AgentEvent {
  // ── Agent lifecycle ──────────────────────────────────────────────────
  /** Agent has completed initialization and is ready to receive prompts. */
  AGENT_READY = "agent:ready",
  /** Agent transitioned to BUSY (processing a prompt). */
  AGENT_BUSY = "agent:busy",
  /** Agent transitioned back to IDLE after completing work. */
  AGENT_IDLE = "agent:idle",
  /** Agent encountered an error. */
  AGENT_ERROR = "agent:error",
  /** Agent has been destroyed and can no longer be used. */
  AGENT_DESTROYED = "agent:destroyed",

  // ── Prompt turn ──────────────────────────────────────────────────────
  /** A new prompt has been sent to the agent. */
  PROMPT_START = "prompt:start",
  /** A chunk of the agent's response text was received. */
  PROMPT_CHUNK = "prompt:chunk",
  /** A chunk of the agent's internal reasoning was received. */
  PROMPT_THOUGHT = "prompt:thought",
  /** The prompt turn has completed. */
  PROMPT_COMPLETE = "prompt:complete",

  // ── Tool calls ───────────────────────────────────────────────────────
  /** A new tool call was created by the agent. */
  TOOL_START = "tool:start",
  /** An existing tool call received a progress update. */
  TOOL_UPDATE = "tool:update",
  /** A tool call completed successfully. */
  TOOL_COMPLETE = "tool:complete",
  /** A tool call failed. */
  TOOL_FAILED = "tool:failed",

  // ── Execution plan ───────────────────────────────────────────────────
  /** The agent published or updated its execution plan. */
  PLAN_UPDATE = "plan:update",

  // ── Permissions ──────────────────────────────────────────────────────
  /** The agent requested permission to perform an action. */
  PERMISSION_REQUESTED = "permission:requested",
  /** A permission request was granted (an allow option was selected). */
  PERMISSION_GRANTED = "permission:granted",
  /** A permission request was denied (no allow option or cancelled). */
  PERMISSION_DENIED = "permission:denied",

  // ── Terminal ─────────────────────────────────────────────────────────
  /** A new terminal was created to run a command. */
  TERMINAL_CREATED = "terminal:created",
  /** A terminal produced stdout or stderr output. */
  TERMINAL_OUTPUT = "terminal:output",
  /** A terminal command exited. */
  TERMINAL_EXIT = "terminal:exit",
  /** A terminal was released and its resources freed. */
  TERMINAL_RELEASED = "terminal:released",

  // ── File system ──────────────────────────────────────────────────────
  /** A file was read from the file system. */
  FS_READ = "fs:read",
  /** A file was written to the file system. */
  FS_WRITE = "fs:write",

  // ── Usage & cost ─────────────────────────────────────────────────────
  /** Token usage or cost information was updated. */
  USAGE_UPDATE = "usage:update",

  // ── Context injection ────────────────────────────────────────────────
  /** New instructions were injected into the agent's context. */
  CONTEXT_INJECTED = "context:injected",

  // ── Session mode ─────────────────────────────────────────────────────
  /** The agent's session mode changed (e.g. "ask", "code", "architect"). */
  MODE_CHANGE = "mode:change",

  // ── Session config ───────────────────────────────────────────────────
  /** A session configuration option was updated. */
  CONFIG_UPDATE = "config:update",
}
