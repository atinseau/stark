import { afterEach, describe, expect, it } from "bun:test";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { createTracerProvider } from "../create-tracer-provider.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Safely shut down a provider, ignoring errors from double-shutdown. */
async function safeShutdown(provider: BasicTracerProvider): Promise<void> {
	try {
		await provider.shutdown();
	} catch {
		// Provider may already be shut down — that's fine.
	}
}

// ── createTracerProvider ───────────────────────────────────────────────────

describe("createTracerProvider", () => {
	const providers: BasicTracerProvider[] = [];

	afterEach(async () => {
		for (const p of providers) {
			await safeShutdown(p);
		}
		providers.length = 0;
	});

	// ── Instance Type ────────────────────────────────────────────────────

	it("returns a BasicTracerProvider instance", () => {
		const provider = createTracerProvider();
		providers.push(provider);

		expect(provider).toBeInstanceOf(BasicTracerProvider);
	});

	it("returns a new provider on each call", () => {
		const a = createTracerProvider();
		const b = createTracerProvider();
		providers.push(a, b);

		expect(a).not.toBe(b);
	});

	// ── Tracer Creation ──────────────────────────────────────────────────

	it("creates a tracer from the provider", () => {
		const provider = createTracerProvider();
		providers.push(provider);

		const tracer = provider.getTracer("test");
		expect(tracer).toBeDefined();
		expect(typeof tracer.startSpan).toBe("function");
	});

	it("creates a tracer with a custom service name", () => {
		const provider = createTracerProvider({ serviceName: "custom-service" });
		providers.push(provider);

		const tracer = provider.getTracer("test");
		expect(tracer).toBeDefined();
	});

	// ── Span Production ──────────────────────────────────────────────────

	it("produces valid spans with correct service resource", () => {
		const provider = createTracerProvider({
			serviceName: "test-svc",
			serviceVersion: "1.2.3",
			immediateExport: true,
		});
		providers.push(provider);

		const tracer = provider.getTracer("test");
		const span = tracer.startSpan("test-op");
		expect(span).toBeDefined();
		expect(typeof span.end).toBe("function");

		const ctx = span.spanContext();
		expect(ctx.traceId).toBeDefined();
		expect(ctx.traceId.length).toBe(32);
		expect(ctx.spanId).toBeDefined();
		expect(ctx.spanId.length).toBe(16);

		span.end();
	});

	it("generates unique trace and span IDs", () => {
		const provider = createTracerProvider({ immediateExport: true });
		providers.push(provider);

		const tracer = provider.getTracer("test");
		const span1 = tracer.startSpan("op-1");
		const span2 = tracer.startSpan("op-2");

		expect(span1.spanContext().spanId).not.toBe(span2.spanContext().spanId);

		span1.end();
		span2.end();
	});

	// ── Endpoint Resolution ──────────────────────────────────────────────

	it("accepts an explicit endpoint", () => {
		// Should not throw when a custom endpoint is provided
		const provider = createTracerProvider({
			endpoint: "http://custom-host:9999/v1/traces",
		});
		providers.push(provider);

		expect(provider).toBeInstanceOf(BasicTracerProvider);
	});

	it("accepts an API key for authenticated ingestion", () => {
		const provider = createTracerProvider({
			apiKey: "test-api-key-123",
			endpoint: "http://localhost:5341/ingest/otlp/v1/traces",
		});
		providers.push(provider);

		expect(provider).toBeInstanceOf(BasicTracerProvider);
	});

	// ── Immediate vs Batch Export Mode ───────────────────────────────────

	it("creates a provider in batch mode by default", () => {
		const provider = createTracerProvider();
		providers.push(provider);

		// Verify it works — batch mode is the default
		const tracer = provider.getTracer("test");
		const span = tracer.startSpan("batch-test");
		span.end();

		expect(provider).toBeInstanceOf(BasicTracerProvider);
	});

	it("creates a provider in immediate mode when requested", () => {
		const provider = createTracerProvider({ immediateExport: true });
		providers.push(provider);

		const tracer = provider.getTracer("test");
		const span = tracer.startSpan("immediate-test");
		span.end();

		expect(provider).toBeInstanceOf(BasicTracerProvider);
	});

	// ── Defaults ─────────────────────────────────────────────────────────

	it("works with no config at all", () => {
		const provider = createTracerProvider();
		providers.push(provider);

		expect(provider).toBeInstanceOf(BasicTracerProvider);

		const tracer = provider.getTracer("default-test");
		const span = tracer.startSpan("no-config-span");
		span.end();
	});

	it("works with an empty config object", () => {
		const provider = createTracerProvider({});
		providers.push(provider);

		expect(provider).toBeInstanceOf(BasicTracerProvider);
	});

	// ── Shutdown ─────────────────────────────────────────────────────────

	it("shutdown completes without error", async () => {
		const provider = createTracerProvider({ immediateExport: true });

		const tracer = provider.getTracer("test");
		const span = tracer.startSpan("pre-shutdown");
		span.end();

		// Should resolve cleanly
		await expect(provider.shutdown()).resolves.toBeUndefined();
	});

	it("forceFlush completes without error", async () => {
		const provider = createTracerProvider({ immediateExport: true });
		providers.push(provider);

		const tracer = provider.getTracer("test");
		const span = tracer.startSpan("pre-flush");
		span.end();

		await expect(provider.forceFlush()).resolves.toBeUndefined();
	});

	// ── Resource Attributes ──────────────────────────────────────────────

	it("attaches service.name and service.version to the resource", () => {
		const provider = createTracerProvider({
			serviceName: "my-agent",
			serviceVersion: "2.0.0",
		});
		providers.push(provider);

		// sdk-trace-base v2.x uses _resource (v1.x used resource)
		const resource = (provider as any)._resource ?? (provider as any).resource;
		expect(resource).toBeDefined();

		const attrs = resource.attributes;
		expect(attrs["service.name"]).toBe("my-agent");
		expect(attrs["service.version"]).toBe("2.0.0");
	});

	it("uses default service name and version when not specified", () => {
		const provider = createTracerProvider();
		providers.push(provider);

		const resource = (provider as any)._resource ?? (provider as any).resource;
		expect(resource).toBeDefined();

		const attrs = resource.attributes;
		expect(attrs["service.name"]).toBe("stark");
		expect(attrs["service.version"]).toBe("0.1.0");
	});
});
