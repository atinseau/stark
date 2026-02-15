import type {
  McpServer,
  StopReason,
  Usage,
} from "@agentclientprotocol/sdk";
import type pino from "pino";

import type { AgentStatus } from "../enums/agent-status.enum.ts";

// ── Agent Identity ─────────────────────────────────────────────────────────

/** Unique identity assigned to an agent at creation time. */
export interface AgentIdentity {
  /** Programmatic identifier (UUID v4) for use in pools and registries. */
  readonly id: string;
  /** Human-friendly display name generated via Faker. */
  readonly name: string;
}

// ── Agent Configuration ────────────────────────────────────────────────────

/** Log output modes that can be independently enabled. */
export interface LogOutputConfig {
  /** Colorized, human-readable console output via pino-pretty. Defaults to `true`. */
  console?: boolean;
  /** Structured JSON output — either `true` (writes to stdout) or a file path. */
  json?: boolean | string;
}

/** Options passed to the Agent constructor. */
export interface AgentConfig {
  /** Override the agent's human-friendly name instead of generating one. */
  name?: string;

  /** Override the programmatic identifier instead of generating a UUID. */
  id?: string;

  /**
   * Path or command used to launch the ACP-compatible agent process.
   * Falls back to the `COPILOT_CLI_PATH` env var, then to `"copilot"`.
   */
  executable?: string;

  /** Working directory the agent session should operate in. Defaults to `process.cwd()`. */
  cwd?: string;

  /** MCP servers to connect during session creation. */
  mcpServers?: McpServer[];

  /** Configure which log outputs are active. */
  logOutput?: LogOutputConfig;

  /** Minimum pino log level. Defaults to `"info"`. */
  logLevel?: pino.Level;

  /**
   * When `true`, all permission requests are automatically approved
   * by selecting the first "allow" option. Defaults to `true`.
   */
  autoApprove?: boolean;
}

// ── Prompt Result ──────────────────────────────────────────────────────────

/** Resolved value returned by `Agent.prompt()`. */
export interface PromptResult {
  /** Why the agent stopped generating. */
  stopReason: StopReason;

  /** Accumulated text output produced during the prompt turn. */
  text: string;

  /** Token usage statistics for this turn, if reported by the agent. */
  usage?: Usage | null;
}

// ── Agent State Snapshot ───────────────────────────────────────────────────

/** Read-only snapshot of the agent's current state, useful for pool orchestration. */
export interface AgentSnapshot {
  /** The agent's unique identity. */
  identity: AgentIdentity;

  /** Current lifecycle status. */
  status: AgentStatus;

  /** ACP session ID, available once initialization is complete. */
  sessionId: string | null;

  /** Number of prompts processed since creation. */
  promptCount: number;

  /** Queued context instructions waiting to be sent. */
  pendingContextCount: number;
}
