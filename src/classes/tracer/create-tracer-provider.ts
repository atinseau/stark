import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
	AlwaysOffSampler,
	AlwaysOnSampler,
	BasicTracerProvider,
	BatchSpanProcessor,
	ParentBasedSampler,
	SimpleSpanProcessor,
	TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import {
	ATTR_SERVICE_NAME,
	ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { DEFAULT_SERVICE_NAME, DEFAULT_SERVICE_VERSION } from "./constants.ts";

/**
 * Configuration options for the OpenTelemetry tracer provider.
 */
export interface TracerProviderConfig {
	/**
	 * OTLP endpoint URL for trace ingestion.
	 *
	 * For Seq, this is typically `http://localhost:5341/ingest/otlp/v1/traces`.
	 * Falls back to `SEQ_URL` env var (with the OTLP path appended),
	 * then to the default `http://localhost:5341/ingest/otlp/v1/traces`.
	 */
	endpoint?: string;

	/**
	 * Optional API key for authenticated ingestion (Seq `X-Seq-ApiKey`).
	 * Not required for local dev with no authentication.
	 */
	apiKey?: string;

	/**
	 * Service name reported in traces.
	 * @default "stark"
	 */
	serviceName?: string;

	/**
	 * Service version reported in traces.
	 * @default "0.1.0"
	 */
	serviceVersion?: string;

	/**
	 * When `true`, spans are exported immediately (useful for debugging).
	 * When `false`, spans are batched for better performance.
	 * @default false
	 */
	immediateExport?: boolean;

	/**
	 * Sampling ratio (0.0 to 1.0) for trace sampling.
	 * - `1.0` (default) — sample all traces
	 * - `0.5` — sample ~50% of traces
	 * - `0.0` — sample no traces
	 *
	 * Uses `ParentBasedSampler` wrapping `TraceIdRatioBasedSampler`
	 * so that child spans inherit the parent's sampling decision.
	 */
	samplingRatio?: number;

	/**
	 * Configuration for the batch span processor.
	 * Only used when `immediateExport` is `false` (the default).
	 */
	batchConfig?: {
		/** Maximum number of spans in the export queue. @default 512 */
		maxQueueSize?: number;
		/** Maximum batch size per export. @default 64 */
		maxExportBatchSize?: number;
		/** Delay between scheduled exports in milliseconds. @default 2000 */
		scheduledDelayMillis?: number;
	};
}

/**
 * Builds the default OTLP endpoint from the SEQ_URL env var or a fallback.
 *
 * Seq exposes its OTLP trace ingestion on the same port as the regular
 * ingestion API, under the path `/ingest/otlp/v1/traces`.
 */
function resolveEndpoint(explicit?: string): string {
	if (explicit) return explicit;

	const seqUrl = process.env.SEQ_URL ?? "http://localhost:5341";
	// Strip trailing slash if present, then append the OTLP traces path
	return `${seqUrl.replace(/\/+$/, "")}/ingest/otlp/v1/traces`;
}

/**
 * Creates and registers a `BasicTracerProvider` configured to export
 * spans to a Seq instance (or any OTLP-compatible backend) via HTTP.
 *
 * The returned provider is **not** set as the global provider — this is
 * intentional so that each Agent instance can own its own provider and
 * shut it down cleanly via `provider.shutdown()` in `Agent.destroy()`.
 *
 * @param config - Optional configuration overrides.
 * @returns A configured `BasicTracerProvider` ready to create tracers.
 *
 * @example
 * ```ts
 * const provider = createTracerProvider({ serviceName: "my-agent" });
 * const tracer = provider.getTracer("agent");
 *
 * const span = tracer.startSpan("my-operation");
 * // ... do work ...
 * span.end();
 *
 * await provider.shutdown(); // flush all pending spans
 * ```
 */
export function createTracerProvider(
	config?: TracerProviderConfig,
): BasicTracerProvider {
	const endpoint = resolveEndpoint(config?.endpoint);
	const serviceName = config?.serviceName ?? DEFAULT_SERVICE_NAME;
	const serviceVersion = config?.serviceVersion ?? DEFAULT_SERVICE_VERSION;

	// ── Sampler ─────────────────────────────────────────────────────────
	const ratio = config?.samplingRatio ?? 1.0;
	const sampler =
		ratio >= 1.0
			? new AlwaysOnSampler()
			: ratio <= 0.0
				? new AlwaysOffSampler()
				: new ParentBasedSampler({
						root: new TraceIdRatioBasedSampler(ratio),
					});

	// ── OTLP Exporter ───────────────────────────────────────────────────
	const headers: Record<string, string> = {};
	if (config?.apiKey) {
		headers["X-Seq-ApiKey"] = config.apiKey;
	}

	const exporter = new OTLPTraceExporter({
		url: endpoint,
		headers,
	});

	// ── Resource ────────────────────────────────────────────────────────
	const resource = resourceFromAttributes({
		[ATTR_SERVICE_NAME]: serviceName,
		[ATTR_SERVICE_VERSION]: serviceVersion,
	});

	// ── Provider ────────────────────────────────────────────────────────
	const provider = new BasicTracerProvider({
		resource,
		sampler,
		spanProcessors: [
			config?.immediateExport
				? new SimpleSpanProcessor(exporter)
				: new BatchSpanProcessor(exporter, {
						maxQueueSize: config?.batchConfig?.maxQueueSize ?? 512,
						maxExportBatchSize: config?.batchConfig?.maxExportBatchSize ?? 64,
						scheduledDelayMillis:
							config?.batchConfig?.scheduledDelayMillis ?? 2_000,
					}),
		],
	});

	return provider;
}
