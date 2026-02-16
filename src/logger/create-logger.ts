import pino from "pino";
import pretty from "pino-pretty";
import { createStream as createSeqStream } from "pino-seq";
import type { AgentIdentity, LogOutputConfig } from "../types/agent.types.ts";
import type { LogTraceProvider } from "../types/observability.types.ts";

// ── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Resolves whether a console transport config is enabled and at what level.
 */
function resolveConsole(
	config: LogOutputConfig["console"],
	fallbackLevel: pino.Level,
): { enabled: boolean; level: pino.Level } {
	if (config == null || config === true) {
		return { enabled: config ?? true, level: fallbackLevel };
	}
	if (config === false) {
		return { enabled: false, level: fallbackLevel };
	}
	// Object form: ConsoleTransportConfig
	return { enabled: config.enabled, level: config.level ?? fallbackLevel };
}

/**
 * Resolves whether a JSON transport config is enabled, where to write, and at what level.
 */
function resolveJson(
	config: LogOutputConfig["json"],
	fallbackLevel: pino.Level,
): {
	enabled: boolean;
	destination: string | number | false;
	level: pino.Level;
} {
	if (config == null || config === false) {
		return { enabled: false, destination: false, level: fallbackLevel };
	}
	if (config === true) {
		// Write to stdout (fd 1)
		return { enabled: true, destination: 1, level: fallbackLevel };
	}
	if (typeof config === "string") {
		return { enabled: true, destination: config, level: fallbackLevel };
	}
	// Object form: JsonTransportConfig
	const dest = config.destination === true ? 1 : config.destination;
	return {
		enabled: true,
		destination: dest,
		level: config.level ?? fallbackLevel,
	};
}

/**
 * Resolves whether a Seq transport config is enabled, the server URL, and the level.
 */
function resolveSeq(
	config: LogOutputConfig["seq"],
	fallbackLevel: pino.Level,
): { enabled: boolean; serverUrl: string; level: pino.Level } {
	const defaultUrl = process.env.SEQ_URL ?? "http://localhost:5341";

	if (config == null || config === false) {
		return { enabled: false, serverUrl: defaultUrl, level: fallbackLevel };
	}
	if (config === true) {
		return { enabled: true, serverUrl: defaultUrl, level: fallbackLevel };
	}
	if (typeof config === "string") {
		return { enabled: true, serverUrl: config, level: fallbackLevel };
	}
	// Object form: SeqTransportConfig
	return {
		enabled: true,
		serverUrl: config.url ?? defaultUrl,
		level: config.level ?? fallbackLevel,
	};
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Creates a configured pino logger instance for an Agent.
 *
 * Uses `pino.multistream()` instead of `pino.transport()` so that all
 * streams run in the main thread — avoiding the `thread-stream` /
 * `worker_threads` mechanism that is not fully supported by Bun.
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
 * Each transport can have its own log level. When the transport config is
 * a simple boolean/string, the global `logLevel` is used. When the transport
 * config is an object with a `level` field, that level takes precedence:
 *
 * ```ts
 * // Console shows info, JSON captures debug, Seq captures everything
 * const logger = createLogger(identity, {
 *   logOutput: {
 *     console: { enabled: true, level: "info" },
 *     json:    { destination: "./logs/agent.ndjson", level: "debug" },
 *     seq:     { level: "trace" },
 *   },
 *   logLevel: "info",
 * });
 * ```
 *
 * ### Trace Context Correlation
 *
 * When `traceContextProvider` is supplied, every log line dynamically carries
 * the `TraceId` and `SpanId` of the **currently active** span (via pino's
 * `mixin` option). This allows Seq to correlate logs with the correct span,
 * even as the active span changes across prompts and tool calls.
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
 * // With dynamic trace context:
 * const logger = createLogger(
 *   { id: "abc-123", name: "Swift Nova" },
 *   {
 *     logOutput: { console: true, seq: true },
 *     logLevel: "info",
 *     traceContextProvider: () => tracer.getTraceContext(),
 *   }
 * );
 * // Every log line now carries the TraceId/SpanId of the active span.
 * ```
 */
export function createLogger(
	identity: AgentIdentity,
	config?: {
		logOutput?: LogOutputConfig;
		logLevel?: pino.Level;
		/**
		 * Dynamic trace context provider.
		 *
		 * Called on every log write via pino's `mixin` option. Returns the
		 * `TraceId` and `SpanId` of the currently active span so that Seq
		 * can correlate each log line with the correct span.
		 *
		 * Ensures logs are correlated with the correct span at all times.
		 */
		traceContextProvider?: LogTraceProvider;
	},
): pino.Logger {
	const globalLevel = config?.logLevel ?? "info";

	// ── Resolve transport configs ──────────────────────────────────────
	const consoleCfg = resolveConsole(config?.logOutput?.console, globalLevel);
	const jsonCfg = resolveJson(config?.logOutput?.json, globalLevel);
	const seqCfg = resolveSeq(config?.logOutput?.seq, globalLevel);

	// Collect streams for pino.multistream()
	const streams: pino.StreamEntry[] = [];

	// ── Console stream (pino-pretty) ───────────────────────────────────
	if (consoleCfg.enabled) {
		const prettyStream = pretty({
			colorize: true,
			translateTime: "HH:MM:ss.l",
			ignore: "pid,hostname",
			messageFormat: "{agentName} | {msg}",
		});

		streams.push({
			level: consoleCfg.level,
			stream: prettyStream,
		});
	}

	// ── JSON stream ────────────────────────────────────────────────────
	if (jsonCfg.enabled && jsonCfg.destination !== false) {
		const dest =
			typeof jsonCfg.destination === "string"
				? pino.destination({
						dest: jsonCfg.destination,
						mkdir: true,
						sync: false,
					})
				: pino.destination({ dest: jsonCfg.destination, sync: false });

		streams.push({
			level: jsonCfg.level,
			stream: dest,
		});
	}

	// ── Seq stream (pino-seq) ──────────────────────────────────────────
	if (seqCfg.enabled) {
		const seqStream = createSeqStream({
			serverUrl: seqCfg.serverUrl,
			batchSizeLimit: 50,
			eventSizeLimit: 1_048_576,
			onError(e: Error) {
				console.warn(`[pino-seq] Failed to send logs to Seq: ${e.message}`);
			},
		});

		streams.push({
			level: seqCfg.level,
			stream: seqStream,
		});
	}

	// ── No streams → silent logger ─────────────────────────────────────
	if (streams.length === 0) {
		return pino({ level: "silent" });
	}

	// ── Build the multi-stream logger ──────────────────────────────────
	const multistream = pino.multistream(streams);

	// ── Base bindings: agent identity ──────────────────────────────────
	// Static fields that never change across the logger's lifetime.
	const base: Record<string, string> = {
		agentId: identity.id,
		agentName: identity.name,
	};

	// ── Dynamic trace context via mixin ────────────────────────────────
	// When a traceContextProvider is supplied, pino calls our mixin on
	// every log write to inject the current TraceId/SpanId. This ensures
	// logs are correlated with the *active* span, not just the root session.
	const traceProvider = config?.traceContextProvider;
	const mixin = traceProvider
		? (): Record<string, string> => {
				const ctx = traceProvider();
				if (ctx) {
					return {
						TraceId: ctx.TraceId,
						SpanId: ctx.SpanId,
						...(ctx.ParentSpanId && { ParentSpanId: ctx.ParentSpanId }),
					};
				}
				return {};
			}
		: undefined;

	// The global level must be the lowest of all transport levels so that
	// pino doesn't filter out messages before they reach a transport that
	// wants them. Each transport's own `level` acts as a secondary filter.
	const lowestLevel = findLowestLevel(
		globalLevel,
		consoleCfg.enabled ? consoleCfg.level : undefined,
		jsonCfg.enabled ? jsonCfg.level : undefined,
		seqCfg.enabled ? seqCfg.level : undefined,
	);

	return pino(
		{
			level: lowestLevel,
			base,
			...(mixin && { mixin }),
		},
		multistream,
	);
}

/**
 * Creates a minimal silent logger for testing purposes.
 * No output is produced regardless of log level.
 */
export function createSilentLogger(): pino.Logger {
	return pino({ level: "silent" });
}

// ── Level Ordering ─────────────────────────────────────────────────────────

/** pino levels ordered from most to least verbose. */
const LEVEL_ORDER: pino.Level[] = [
	"trace",
	"debug",
	"info",
	"warn",
	"error",
	"fatal",
];

/**
 * Returns the most verbose (lowest) level among the provided values.
 * This ensures the root logger doesn't filter out messages that a
 * more verbose transport still wants to receive.
 */
function findLowestLevel(...levels: (pino.Level | undefined)[]): pino.Level {
	let lowestIndex = LEVEL_ORDER.length - 1;

	for (const level of levels) {
		if (!level) continue;
		const idx = LEVEL_ORDER.indexOf(level);
		if (idx !== -1 && idx < lowestIndex) {
			lowestIndex = idx;
		}
	}

	return LEVEL_ORDER[lowestIndex] ?? "info";
}
