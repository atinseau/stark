import type { PermissionOption } from "@agentclientprotocol/sdk";

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * A pending approval request from an agent waiting for user authorization.
 *
 * Created when an agent with `autoApprove: false` attempts to use a tool
 * and emits an `APPROVE_REQUEST` event. The agent's prompt is blocked
 * until `resolve()` is called.
 */
export interface PendingApproval {
	/** The agent's unique ID. */
	readonly agentId: string;

	/** The agent's human-friendly name. */
	readonly agentName: string;

	/** Unique identifier for the tool call requiring approval. */
	readonly toolCallId: string;

	/** Human-readable title of the tool call. */
	readonly toolCallTitle: string;

	/** Available permission options from the ACP layer. */
	readonly options: PermissionOption[];

	/** ISO-8601 timestamp of when the request was created. */
	readonly timestamp: string;

	/**
	 * Callback to approve (`true`) or deny (`false`) the request.
	 * Calling this unblocks the agent's prompt execution.
	 * Can only be called once — subsequent calls are no-ops.
	 */
	readonly resolve: (approved: boolean) => void;
}

/**
 * Result of an approval resolution attempt.
 */
export interface ApprovalResolution {
	/** Whether one or more approvals were resolved. */
	readonly resolved: boolean;

	/** Number of approvals that were resolved. */
	readonly count: number;

	/** Human-readable summary of what was resolved. */
	readonly summary: string;
}

// ── ApprovalManager ────────────────────────────────────────────────────────

/**
 * Manages pending approval requests from agents in the pool.
 *
 * This is a pure state manager — it stores pending approvals, provides
 * lookup/resolution methods, and tracks resolved state. It does NOT
 * emit events or interact with the LLM. The AgentPool orchestrates
 * the event flow around this manager.
 *
 * ## Non-blocking by Design
 *
 * Each approval request is tied to a single agent's blocked Promise.
 * Other agents in the pool continue executing independently. Resolving
 * an approval only unblocks the specific agent that requested it.
 *
 * ## Lifecycle
 *
 * 1. Agent emits `APPROVE_REQUEST` → pool calls `addRequest()`
 * 2. Request is stored and available via `getPending()` / `hasPending()`
 * 3. User approves via `pool.send()` or external listener → pool calls
 *    `resolveByAgent()`, `resolveByToolCallId()`, or `resolveAll()`
 * 4. The stored `resolve` callback is invoked, unblocking the agent
 * 5. The request is removed from pending state
 *
 * ## Safety
 *
 * - Each `resolve` callback is wrapped so it can only fire once.
 * - Resolving a non-existent approval is a safe no-op.
 * - `clear()` denies all remaining approvals on pool shutdown.
 */
export class ApprovalManager {
	/**
	 * Pending approvals keyed by `toolCallId`.
	 * A single agent can have multiple pending approvals if it triggers
	 * multiple tool calls that all require permission.
	 */
	private readonly pending = new Map<string, PendingApproval>();

	/**
	 * Secondary index: agent ID → Set of tool call IDs.
	 * Enables efficient lookup of all pending approvals for a given agent.
	 */
	private readonly agentIndex = new Map<string, Set<string>>();

	// ── Mutators ───────────────────────────────────────────────────────

	/**
	 * Registers a new pending approval request.
	 *
	 * The `resolve` callback is wrapped to ensure it can only fire once
	 * and that the approval is automatically removed from pending state
	 * when resolved.
	 *
	 * @param request - The approval request to track (without the
	 *                  one-shot wrapper — that is applied internally).
	 */
	addRequest(
		request: Omit<PendingApproval, "resolve"> & {
			resolve: (approved: boolean) => void;
		},
	): void {
		const { toolCallId, agentId, resolve: originalResolve } = request;

		// Guard against duplicate registrations for the same tool call
		if (this.pending.has(toolCallId)) {
			return;
		}

		// Wrap resolve to be one-shot and auto-clean
		let resolved = false;
		const wrappedResolve = (approved: boolean): void => {
			if (resolved) return;
			resolved = true;

			// Remove from pending state
			this.pending.delete(toolCallId);
			const agentToolCalls = this.agentIndex.get(agentId);
			if (agentToolCalls) {
				agentToolCalls.delete(toolCallId);
				if (agentToolCalls.size === 0) {
					this.agentIndex.delete(agentId);
				}
			}

			// Invoke the original callback to unblock the agent
			originalResolve(approved);
		};

		const entry: PendingApproval = {
			agentId: request.agentId,
			agentName: request.agentName,
			toolCallId: request.toolCallId,
			toolCallTitle: request.toolCallTitle,
			options: request.options,
			timestamp: request.timestamp,
			resolve: wrappedResolve,
		};

		this.pending.set(toolCallId, entry);

		// Update secondary index
		let agentToolCalls = this.agentIndex.get(agentId);
		if (!agentToolCalls) {
			agentToolCalls = new Set();
			this.agentIndex.set(agentId, agentToolCalls);
		}
		agentToolCalls.add(toolCallId);
	}

	/**
	 * Resolves a specific approval by tool call ID.
	 *
	 * @returns Resolution result indicating success/failure.
	 */
	resolveByToolCallId(
		toolCallId: string,
		approved: boolean,
	): ApprovalResolution {
		const entry = this.pending.get(toolCallId);
		if (!entry) {
			return {
				resolved: false,
				count: 0,
				summary: `No pending approval found for tool call "${toolCallId}".`,
			};
		}

		entry.resolve(approved);

		const action = approved ? "Approved" : "Denied";
		return {
			resolved: true,
			count: 1,
			summary: `${action} "${entry.toolCallTitle}" for agent ${entry.agentName}.`,
		};
	}

	/**
	 * Resolves all pending approvals for a specific agent.
	 *
	 * Useful for messages like "authorize Agent-X" without specifying
	 * which tool call.
	 *
	 * @param agentId - The agent's unique ID.
	 * @param approved - Whether to approve or deny all pending requests.
	 * @returns Resolution result with count of resolved approvals.
	 */
	resolveByAgentId(agentId: string, approved: boolean): ApprovalResolution {
		const toolCallIds = this.agentIndex.get(agentId);
		if (!toolCallIds || toolCallIds.size === 0) {
			return {
				resolved: false,
				count: 0,
				summary: `No pending approvals found for agent "${agentId}".`,
			};
		}

		// Snapshot the IDs since resolve() mutates the set
		const ids = [...toolCallIds];
		let agentName = "unknown";

		for (const toolCallId of ids) {
			const entry = this.pending.get(toolCallId);
			if (entry) {
				agentName = entry.agentName;
				entry.resolve(approved);
			}
		}

		const action = approved ? "Approved" : "Denied";
		return {
			resolved: true,
			count: ids.length,
			summary: `${action} ${ids.length} pending approval(s) for agent ${agentName}.`,
		};
	}

	/**
	 * Resolves all pending approvals for a specific agent, looked up
	 * by the agent's human-friendly name (case-insensitive).
	 *
	 * @param agentName - The agent's display name.
	 * @param approved - Whether to approve or deny.
	 * @returns Resolution result.
	 */
	resolveByAgentName(agentName: string, approved: boolean): ApprovalResolution {
		const normalizedTarget = agentName.toLowerCase();

		for (const [agentId, toolCallIds] of this.agentIndex.entries()) {
			if (toolCallIds.size === 0) continue;

			// Find an entry to check the agent name
			const firstToolCallId = toolCallIds.values().next().value;
			if (!firstToolCallId) continue;

			const entry = this.pending.get(firstToolCallId);
			if (!entry) continue;

			if (entry.agentName.toLowerCase() === normalizedTarget) {
				return this.resolveByAgentId(agentId, approved);
			}
		}

		return {
			resolved: false,
			count: 0,
			summary: `No pending approvals found for agent named "${agentName}".`,
		};
	}

	/**
	 * Resolves all pending approvals across all agents.
	 *
	 * Useful for blanket "yes, continue" messages.
	 *
	 * @param approved - Whether to approve or deny all pending requests.
	 * @returns Resolution result with total count.
	 */
	resolveAll(approved: boolean): ApprovalResolution {
		const count = this.pending.size;
		if (count === 0) {
			return {
				resolved: false,
				count: 0,
				summary: "No pending approvals to resolve.",
			};
		}

		// Snapshot entries since resolve() mutates the map
		const entries = [...this.pending.values()];
		for (const entry of entries) {
			entry.resolve(approved);
		}

		const action = approved ? "Approved" : "Denied";
		return {
			resolved: true,
			count,
			summary: `${action} ${count} pending approval(s) across all agents.`,
		};
	}

	/**
	 * Denies and removes all pending approvals.
	 *
	 * Called during pool shutdown to ensure no agent is left blocking
	 * indefinitely.
	 */
	clear(): void {
		if (this.pending.size > 0) {
			this.resolveAll(false);
		}
		// Defensive: ensure maps are truly empty
		this.pending.clear();
		this.agentIndex.clear();
	}

	// ── Queries ────────────────────────────────────────────────────────

	/**
	 * Returns whether there are any pending approvals.
	 */
	hasPending(): boolean {
		return this.pending.size > 0;
	}

	/**
	 * Returns the number of pending approvals.
	 */
	get pendingCount(): number {
		return this.pending.size;
	}

	/**
	 * Returns all pending approvals as a read-only array.
	 *
	 * The returned objects still contain the live `resolve` callback,
	 * so external consumers CAN resolve them directly. This is
	 * intentional — it enables the pool event listener pattern.
	 */
	getPending(): readonly PendingApproval[] {
		return [...this.pending.values()];
	}

	/**
	 * Returns all pending approvals for a specific agent.
	 */
	getPendingForAgent(agentId: string): readonly PendingApproval[] {
		const toolCallIds = this.agentIndex.get(agentId);
		if (!toolCallIds) return [];

		const results: PendingApproval[] = [];
		for (const toolCallId of toolCallIds) {
			const entry = this.pending.get(toolCallId);
			if (entry) results.push(entry);
		}
		return results;
	}

	/**
	 * Returns a specific pending approval by tool call ID.
	 */
	getByToolCallId(toolCallId: string): PendingApproval | undefined {
		return this.pending.get(toolCallId);
	}

	/**
	 * Returns a serializable summary of pending approvals.
	 *
	 * Used by the intent analyzer to include approval context
	 * in the classification prompt.
	 */
	getPendingSummary(): Array<{
		agentId: string;
		agentName: string;
		toolCallId: string;
		toolCallTitle: string;
		timestamp: string;
	}> {
		return [...this.pending.values()].map((entry) => ({
			agentId: entry.agentId,
			agentName: entry.agentName,
			toolCallId: entry.toolCallId,
			toolCallTitle: entry.toolCallTitle,
			timestamp: entry.timestamp,
		}));
	}
}
