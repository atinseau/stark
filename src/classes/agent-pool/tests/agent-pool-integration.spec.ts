import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { PoolEvent } from "../../../enums/pool-event.enum.ts";
import { AgentPool } from "../agent-pool.ts";
import {
	collectPoolEvents,
	createMockAgentFactory,
	silentPoolConfig,
} from "./test-helpers.ts";

// ════════════════════════════════════════════════════════════════════════════
// AgentPool Integration Tests (with mocked agents and LLM)
// ════════════════════════════════════════════════════════════════════════════

describe("AgentPool", () => {
	describe("construction", () => {
		it("creates a pool with default configuration", () => {
			const pool = new AgentPool(
				silentPoolConfig({
					createAgent: createMockAgentFactory(),
				}),
			);

			expect(pool).toBeInstanceOf(EventEmitter);
			expect(pool.getState().executing).toBe(false);
			expect(pool.getState().currentTask).toBeNull();
			expect(pool.getState().strategy).toBeNull();
			expect(pool.getState().activeAgentCount).toBe(0);
			expect(pool.getState().notificationsEnabled).toBe(false);
		});
	});

	describe("state management", () => {
		it("getState returns correct idle state", () => {
			const pool = new AgentPool(
				silentPoolConfig({
					createAgent: createMockAgentFactory(),
				}),
			);

			const state = pool.getState();
			expect(state.executing).toBe(false);
			expect(state.currentTask).toBeNull();
			expect(state.strategy).toBeNull();
			expect(state.activeAgentCount).toBe(0);
			expect(state.agents).toEqual([]);
			expect(state.notificationsEnabled).toBe(false);
			expect(state.deltaCount).toBe(0);
			expect(state.sharingDecisionCount).toBe(0);
		});

		it("setNotificationPreference updates notification state", () => {
			const pool = new AgentPool(
				silentPoolConfig({
					createAgent: createMockAgentFactory(),
				}),
			);

			expect(pool.getState().notificationsEnabled).toBe(false);

			pool.setNotificationPreference({
				enabled: true,
				minSignificance: 0.6,
			});

			expect(pool.getState().notificationsEnabled).toBe(true);
		});
	});

	describe("destroy", () => {
		it("transitions to destroyed state", async () => {
			const pool = new AgentPool(
				silentPoolConfig({
					createAgent: createMockAgentFactory(),
				}),
			);

			const events = collectPoolEvents(pool, PoolEvent.DESTROYED);

			await pool.destroy();

			expect(events).toHaveLength(1);
		});

		it("is idempotent — calling destroy() twice is safe", async () => {
			const pool = new AgentPool(
				silentPoolConfig({
					createAgent: createMockAgentFactory(),
				}),
			);

			await pool.destroy();
			await pool.destroy(); // Should not throw
		});

		it("execute throws after destroy", async () => {
			const pool = new AgentPool(
				silentPoolConfig({
					createAgent: createMockAgentFactory(),
				}),
			);

			await pool.destroy();

			await expect(pool.execute("do something")).rejects.toThrow(/destroyed/);
		});

		it("send throws after destroy", async () => {
			const pool = new AgentPool(
				silentPoolConfig({
					createAgent: createMockAgentFactory(),
				}),
			);

			await pool.destroy();

			await expect(pool.send("hello")).rejects.toThrow(/destroyed/);
		});
	});

	describe("event system", () => {
		it("supports on/off/once with typed events", async () => {
			const pool = new AgentPool(
				silentPoolConfig({
					createAgent: createMockAgentFactory(),
				}),
			);

			const destroyedEvents: any[] = [];
			const listener = (e: any) => destroyedEvents.push(e);

			pool.on(PoolEvent.DESTROYED, listener);
			await pool.destroy();

			expect(destroyedEvents).toHaveLength(1);
			expect(destroyedEvents[0].event).toBe(PoolEvent.DESTROYED);
			expect(destroyedEvents[0].timestamp).toBeDefined();
		});

		it("once listener fires only once", async () => {
			const pool = new AgentPool(
				silentPoolConfig({
					createAgent: createMockAgentFactory(),
				}),
			);

			let callCount = 0;
			pool.once(PoolEvent.DESTROYED, () => {
				callCount++;
			});

			await pool.destroy();
			// Emit another one manually to test once
			pool.emit(PoolEvent.DESTROYED, {
				event: PoolEvent.DESTROYED,
				timestamp: new Date().toISOString(),
			});

			expect(callCount).toBe(1);
		});

		it("off removes listeners", async () => {
			const pool = new AgentPool(
				silentPoolConfig({
					createAgent: createMockAgentFactory(),
				}),
			);

			let callCount = 0;
			const listener = () => {
				callCount++;
			};

			pool.on(PoolEvent.DESTROYED, listener);
			pool.off(PoolEvent.DESTROYED, listener);

			await pool.destroy();
			expect(callCount).toBe(0);
		});
	});
});
