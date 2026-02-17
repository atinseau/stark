import type { AgentEvent } from "../enums/agent-event.enum.ts";
import type { AgentEventMap, BaseAgentEvent } from "./events.types.ts";

// ── Typed Event Emission ───────────────────────────────────────────────────

/**
 * Callback signature used by agent sub-components to emit typed events.
 *
 * Matches the `emitTyped` pattern from the Agent class so that child
 * components (session update handler, ACP client factory) don't need
 * to know about EventEmitter internals.
 *
 * The `BaseAgentEvent` fields (event type, timestamp, agent identity)
 * are injected automatically by the Agent — callers only supply the
 * domain-specific payload.
 */
export type EmitEventFn = <K extends AgentEvent>(
	event: K,
	payload: Omit<AgentEventMap[K], keyof BaseAgentEvent>,
) => void;
