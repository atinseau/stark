import pino from "pino";

import type { LogOutputConfig } from "../types/agent.types.ts";
import type { AgentIdentity } from "../types/agent.types.ts";
import type { TraceContext } from "../tracer/agent-tracer.ts";

/**
 * Creates a configured pino logger instance for an Agent.
 *
 * Supports three output modes that can be independently enabled:
 *
 *   1. **Console** (`logOutput.console`): Colorized, human-readable output
 *      via `pino-pretty`. Great for development and debugging.
 *
 *   2. **JSON** (`logOutput.json`): Structured NDJSON output suitable for
 *      log aggregation and analysis. Can write to stdout (`true`) or to
 *      a file path (string).
 *
 *   3. **Seq** (`logOutput.seq`): Streams structured logs to a Seq instance
 *      via `pino-seq` for real-time visualization in a web UI.
 *      Pass `true` to target `http://localhost:5341` or a custom URL string.
 *      Requires a running Seq server (see `docker-compose.yml`).
 *
 * All transports can be active simultaneously. If none is enabled,
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
 *
 * @example
 * ```ts
 * // With Seq enabled (requires `docker compose up -d`):
 * const logger = createLogger(
 *   { id: "abc-123", name: "Swift Nova" },
 *   { logOutput: { console: true, json: "./logs/agent.ndjson", seq: true }, logLevel: "debug" }
 * );
 * // Then open http://localhost:8082 to visualize logs in real time.
 * ```
 */
export function createLogger(
  identity: AgentIdentity,
  config?: {
    logOutput?: LogOutputConfig;
    logLevel?: pino.Level;
    /**
     * Optional trace context from the AgentTracer.
     * When provided, every log line carries `TraceId` and `SpanId` fields
     * so Seq can automatically correlate logs ↔ traces in its UI.
     */
    traceContext?: TraceContext;
  },
): pino.Logger {
  const level = config?.logLevel ?? "info";
  const consoleEnabled = config?.logOutput?.console ?? true;
  const jsonOutput = config?.logOutput?.json ?? false;

  const seqOutput = config?.logOutput?.seq ?? false;

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

  // ── Seq transport (pino-seq) ───────────────────────────────────────────
  if (seqOutput) {
    const serverUrl =
      typeof seqOutput === "string"
        ? seqOutput
        : (process.env.SEQ_URL ?? "http://localhost:5341");

    targets.push({
      target: "pino-seq",
      options: {
        serverUrl,
        // Batch logs every 2s for performance
        batchSizeLimit: 50,
        eventSizeLimit: 1_048_576,
        // Gracefully handle Seq being unavailable
        onError(e: Error) {
          console.warn(`[pino-seq] Failed to send logs to Seq: ${e.message}`);
        },
      },
      level,
    });
  }

  // ── No transports → silent logger ──────────────────────────────────────
  if (targets.length === 0) {
    return pino({ level: "silent" });
  }

  // ── Build the multi-transport logger ───────────────────────────────────
  const transport = pino.transport({ targets });

  // Build base bindings: agent identity + optional trace context.
  // Seq recognises PascalCase `TraceId` / `SpanId` fields and uses them
  // to link log events to their parent trace automatically.
  const base: Record<string, string> = {
    agentId: identity.id,
    agentName: identity.name,
  };

  if (config?.traceContext) {
    base.TraceId = config.traceContext.TraceId;
    base.SpanId = config.traceContext.SpanId;
  }

  return pino(
    {
      level,
      base,
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
