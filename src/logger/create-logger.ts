import pino from "pino";

import type { LogOutputConfig } from "../types/agent.types.ts";
import type { AgentIdentity } from "../types/agent.types.ts";

/**
 * Creates a configured pino logger instance for an Agent.
 *
 * Supports two output modes that can be independently enabled:
 *
 *   1. **Console** (`logOutput.console`): Colorized, human-readable output
 *      via `pino-pretty`. Great for development and debugging.
 *
 *   2. **JSON** (`logOutput.json`): Structured NDJSON output suitable for
 *      log aggregation and analysis. Can write to stdout (`true`) or to
 *      a file path (string).
 *
 * Both transports can be active simultaneously. If neither is enabled,
 * a silent logger is returned (useful in tests).
 *
 * @param identity - The agent's identity, used to tag every log line.
 * @param config   - Which outputs to enable and at what log level.
 * @returns A configured `pino.Logger` instance.
 *
 * @example
 * ```ts
 * const logger = createLogger(
 *   { id: "abc-123", name: "Swift Nova" },
 *   { logOutput: { console: true, json: "/var/log/agent.ndjson" }, logLevel: "debug" }
 * );
 *
 * logger.info({ toolCallId: "tc-1" }, "Tool call started");
 * ```
 */
export function createLogger(
  identity: AgentIdentity,
  config?: {
    logOutput?: LogOutputConfig;
    logLevel?: pino.Level;
  },
): pino.Logger {
  const level = config?.logLevel ?? "info";
  const consoleEnabled = config?.logOutput?.console ?? true;
  const jsonOutput = config?.logOutput?.json ?? false;

  // Collect transports to enable
  const targets: pino.TransportTargetOptions[] = [];

  // ── Console transport (pino-pretty) ────────────────────────────────────
  if (consoleEnabled) {
    targets.push({
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss.l",
        ignore: "pid,hostname",
        messageFormat: "{agentName} | {msg}",
        // Show the agent name in every pretty-printed line
        customPrettifiers: {},
      },
      level,
    });
  }

  // ── JSON transport ─────────────────────────────────────────────────────
  if (jsonOutput) {
    if (typeof jsonOutput === "string") {
      // Write JSON to a file
      targets.push({
        target: "pino/file",
        options: { destination: jsonOutput, mkdir: true },
        level,
      });
    } else {
      // Write JSON to stdout (fd 1)
      targets.push({
        target: "pino/file",
        options: { destination: 1 },
        level,
      });
    }
  }

  // ── No transports → silent logger ──────────────────────────────────────
  if (targets.length === 0) {
    return pino({ level: "silent" });
  }

  // ── Build the multi-transport logger ───────────────────────────────────
  const transport = pino.transport({ targets });

  return pino(
    {
      level,
      // Attach agent identity as base bindings so every log line carries them
      base: {
        agentId: identity.id,
        agentName: identity.name,
      },
    },
    transport,
  );
}

/**
 * Creates a minimal silent logger for testing purposes.
 * No output is produced regardless of log level.
 */
export function createSilentLogger(): pino.Logger {
  return pino({ level: "silent" });
}
