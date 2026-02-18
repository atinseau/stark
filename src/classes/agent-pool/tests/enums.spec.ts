import { describe, expect, it } from "bun:test";

import { ConversationRole } from "../../../enums/conversation-role.enum.ts";
import { DeltaType } from "../../../enums/delta-type.enum.ts";
import { ExecutionStrategy } from "../../../enums/execution-strategy.enum.ts";
import { PoolEvent } from "../../../enums/pool-event.enum.ts";
import { TaskComplexity } from "../../../enums/task-complexity.enum.ts";
import { UserIntent } from "../../../enums/user-intent.enum.ts";

// ════════════════════════════════════════════════════════════════════════════
// Enum Tests
// ════════════════════════════════════════════════════════════════════════════

describe("Pool Enums", () => {
	it("PoolEvent has all expected lifecycle events", () => {
		expect(PoolEvent.TASK_RECEIVED as string).toBe("pool:task-received");
		expect(PoolEvent.PLANNING_START as string).toBe("pool:planning-start");
		expect(PoolEvent.PLANNING_COMPLETE as string).toBe(
			"pool:planning-complete",
		);
		expect(PoolEvent.AGENT_SPAWNED as string).toBe("pool:agent-spawned");
		expect(PoolEvent.AGENT_COMPLETED as string).toBe("pool:agent-completed");
		expect(PoolEvent.AGENT_ERROR as string).toBe("pool:agent-error");
		expect(PoolEvent.DELTA_DETECTED as string).toBe("pool:delta-detected");
		expect(PoolEvent.SHARING_DECISION as string).toBe("pool:sharing-decision");
		expect(PoolEvent.CONTEXT_SHARED as string).toBe("pool:context-shared");
		expect(PoolEvent.NOTIFICATION as string).toBe("pool:notification");
		expect(PoolEvent.EXECUTION_COMPLETE as string).toBe(
			"pool:execution-complete",
		);
		expect(PoolEvent.ERROR as string).toBe("pool:error");
		expect(PoolEvent.DESTROYED as string).toBe("pool:destroyed");
		expect(PoolEvent.APPROVE_REQUEST as string).toBe("pool:approve-request");
		expect(PoolEvent.ORCHESTRATOR_ASSESSMENT as string).toBe(
			"pool:orchestrator-assessment",
		);
		expect(PoolEvent.REFLECTION_COMPLETE as string).toBe(
			"pool:reflection-complete",
		);
		expect(PoolEvent.CONFLICT_DETECTED as string).toBe(
			"pool:conflict-detected",
		);
	});

	it("ConversationRole has all expected roles", () => {
		expect(ConversationRole.PLANNER as string).toBe("planner");
		expect(ConversationRole.CONTEXT_ANALYZER as string).toBe(
			"context-analyzer",
		);
		expect(ConversationRole.SHARING_ANALYZER as string).toBe(
			"sharing-analyzer",
		);
		expect(ConversationRole.USER_INTERACTION as string).toBe(
			"user-interaction",
		);
		expect(ConversationRole.INTENT_ANALYZER as string).toBe("intent-analyzer");
		expect(ConversationRole.ORCHESTRATOR as string).toBe("orchestrator");
	});

	it("ExecutionStrategy has single and multi", () => {
		expect(ExecutionStrategy.SINGLE as string).toBe("single");
		expect(ExecutionStrategy.MULTI as string).toBe("multi");
	});

	it("TaskComplexity has all levels", () => {
		expect(TaskComplexity.SIMPLE as string).toBe("simple");
		expect(TaskComplexity.MODERATE as string).toBe("moderate");
		expect(TaskComplexity.COMPLEX as string).toBe("complex");
	});

	it("DeltaType has all expected types", () => {
		expect(DeltaType.PROMPT_COMPLETE as string).toBe("prompt_complete");
		expect(DeltaType.TOOL_COMPLETE as string).toBe("tool_complete");
		expect(DeltaType.TOOL_FAILED as string).toBe("tool_failed");
		expect(DeltaType.AGENT_ERROR as string).toBe("agent_error");
		expect(DeltaType.STATUS_CHANGE as string).toBe("status_change");
		expect(DeltaType.PLAN_UPDATE as string).toBe("plan_update");
		expect(DeltaType.FILE_WRITTEN as string).toBe("file_written");
		expect(DeltaType.FILE_READ as string).toBe("file_read");
		expect(DeltaType.CONFLICT_DETECTED as string).toBe("conflict_detected");
	});

	it("UserIntent has all expected intents", () => {
		expect(UserIntent.NEW_TASK as string).toBe("new_task");
		expect(UserIntent.NOTIFICATION_PREFERENCE as string).toBe(
			"notification_preference",
		);
		expect(UserIntent.STATUS_QUERY as string).toBe("status_query");
		expect(UserIntent.CONTEXT_INJECTION as string).toBe("context_injection");
		expect(UserIntent.CANCEL as string).toBe("cancel");
		expect(UserIntent.APPROVE_AGENT as string).toBe("approve_agent");
		expect(UserIntent.UNKNOWN as string).toBe("unknown");
	});
});
