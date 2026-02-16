import type {
	Cost,
	PermissionOption,
	PlanEntry,
	SessionConfigOption,
	StopReason,
	ToolCallLocation,
	ToolCallStatus,
	ToolKind,
	Usage,
} from "@agentclientprotocol/sdk";

import type { AgentEvent } from "../enums/agent-event.enum.ts";
import type { AgentStatus } from "../enums/agent-status.enum.ts";
import type { AgentIdentity } from "./agent.types.ts";

// ── Base Event ─────────────────────────────────────────────────────────────

/** Every agent event carries at least these fields. */
export interface BaseAgentEvent {
	/** The event type discriminator. */
	readonly event: AgentEvent;
	/** ISO-8601 timestamp of when the event was created. */
	readonly timestamp: string;
	/** Identity of the agent that emitted the event. */
	readonly agent: AgentIdentity;
}

// ── Agent Lifecycle Events ─────────────────────────────────────────────────

export interface AgentReadyEvent extends BaseAgentEvent {
	readonly event: AgentEvent.AGENT_READY;
	/** The ACP session ID that was created. */
	readonly sessionId: string;
}

export interface AgentBusyEvent extends BaseAgentEvent {
	readonly event: AgentEvent.AGENT_BUSY;
	/** The prompt text that triggered the busy state. */
	readonly promptText: string;
}

export interface AgentIdleEvent extends BaseAgentEvent {
	readonly event: AgentEvent.AGENT_IDLE;
	/** The previous status before transitioning to IDLE. */
	readonly previousStatus: AgentStatus;
}

export interface AgentErrorEvent extends BaseAgentEvent {
	readonly event: AgentEvent.AGENT_ERROR;
	/** The error that occurred. */
	readonly error: Error;
	/** Human-readable context about what was happening when the error occurred. */
	readonly context: string;
}

export interface AgentDestroyedEvent extends BaseAgentEvent {
	readonly event: AgentEvent.AGENT_DESTROYED;
}

// ── Prompt Turn Events ─────────────────────────────────────────────────────

export interface PromptStartEvent extends BaseAgentEvent {
	readonly event: AgentEvent.PROMPT_START;
	/** The prompt text that was sent. */
	readonly promptText: string;
	/** Sequential prompt number for this agent instance. */
	readonly promptIndex: number;
}

export interface PromptChunkEvent extends BaseAgentEvent {
	readonly event: AgentEvent.PROMPT_CHUNK;
	/** The text chunk received from the agent. */
	readonly text: string;
}

export interface PromptThoughtEvent extends BaseAgentEvent {
	readonly event: AgentEvent.PROMPT_THOUGHT;
	/** The reasoning/thought text chunk. */
	readonly text: string;
}

export interface PromptCompleteEvent extends BaseAgentEvent {
	readonly event: AgentEvent.PROMPT_COMPLETE;
	/** Why the agent stopped generating. */
	readonly stopReason: StopReason;
	/** Full accumulated response text. */
	readonly fullText: string;
	/** Token usage for this turn, if available. */
	readonly usage?: Usage | null;
}

// ── Tool Call Events ───────────────────────────────────────────────────────

export interface ToolStartEvent extends BaseAgentEvent {
	readonly event: AgentEvent.TOOL_START;
	/** Unique identifier for this tool call. */
	readonly toolCallId: string;
	/** Human-readable title describing what the tool is doing. */
	readonly title: string;
	/** Category of tool being invoked. */
	readonly kind?: ToolKind;
	/** File locations affected by this tool call. */
	readonly locations?: ToolCallLocation[];
	/** The shell command being executed (parsed from rawInput for "execute" tools). */
	readonly command?: string;
	/** Raw input parameters, if available. */
	readonly rawInput?: unknown;
}

export interface ToolUpdateEvent extends BaseAgentEvent {
	readonly event: AgentEvent.TOOL_UPDATE;
	/** The tool call being updated. */
	readonly toolCallId: string;
	/** Updated title, if changed. */
	readonly title?: string | null;
	/** Updated execution status. */
	readonly status?: ToolCallStatus | null;
	/** Updated file locations. */
	readonly locations?: ToolCallLocation[] | null;
	/** Cleaned text output from the tool (parsed from rawOutput). */
	readonly output?: string;
	/** Exit code of the command, if available (parsed from rawOutput). */
	readonly exitCode?: number;
	/** Raw output produced so far. */
	readonly rawOutput?: unknown;
}

export interface ToolCompleteEvent extends BaseAgentEvent {
	readonly event: AgentEvent.TOOL_COMPLETE;
	/** The tool call that completed. */
	readonly toolCallId: string;
	/** Final title of the tool call. */
	readonly title: string;
	/** The shell command that was executed (for "execute" tools). */
	readonly command?: string;
	/** Final cleaned text output from the tool. */
	readonly output?: string;
	/** Exit code of the command, if available. */
	readonly exitCode?: number;
}

export interface ToolFailedEvent extends BaseAgentEvent {
	readonly event: AgentEvent.TOOL_FAILED;
	/** The tool call that failed. */
	readonly toolCallId: string;
	/** Final title of the tool call. */
	readonly title: string;
	/** The shell command that was executed (for "execute" tools). */
	readonly command?: string;
	/** Error/output text from the tool. */
	readonly output?: string;
	/** Exit code of the command, if available. */
	readonly exitCode?: number;
}

// ── Plan Events ────────────────────────────────────────────────────────────

export interface PlanUpdateEvent extends BaseAgentEvent {
	readonly event: AgentEvent.PLAN_UPDATE;
	/** The complete list of plan entries with their current statuses. */
	readonly entries: PlanEntry[];
}

// ── Permission Events ──────────────────────────────────────────────────────

export interface PermissionRequestedEvent extends BaseAgentEvent {
	readonly event: AgentEvent.PERMISSION_REQUESTED;
	/** The tool call that requires permission. */
	readonly toolCallId: string;
	/** Title of the tool call requesting permission. */
	readonly toolCallTitle?: string | null;
	/** Available permission options. */
	readonly options: PermissionOption[];
}

export interface PermissionGrantedEvent extends BaseAgentEvent {
	readonly event: AgentEvent.PERMISSION_GRANTED;
	/** The tool call that was granted permission. */
	readonly toolCallId: string;
	/** The option that was selected. */
	readonly optionId: string;
	/** The name of the selected option. */
	readonly optionName: string;
}

export interface PermissionDeniedEvent extends BaseAgentEvent {
	readonly event: AgentEvent.PERMISSION_DENIED;
	/** The tool call that was denied permission. */
	readonly toolCallId: string;
	/** Reason the permission was denied. */
	readonly reason: string;
}

// ── Terminal Events ────────────────────────────────────────────────────────

export interface TerminalCreatedEvent extends BaseAgentEvent {
	readonly event: AgentEvent.TERMINAL_CREATED;
	/** The terminal identifier. */
	readonly terminalId: string;
	/** The command being executed. */
	readonly command: string;
	/** Arguments passed to the command. */
	readonly args: string[];
	/** Working directory for the command. */
	readonly cwd: string;
}

export interface TerminalOutputEvent extends BaseAgentEvent {
	readonly event: AgentEvent.TERMINAL_OUTPUT;
	/** The terminal that produced output. */
	readonly terminalId: string;
	/** The output stream: stdout or stderr. */
	readonly stream: "stdout" | "stderr";
	/** The text content of the output. */
	readonly text: string;
}

export interface TerminalExitEvent extends BaseAgentEvent {
	readonly event: AgentEvent.TERMINAL_EXIT;
	/** The terminal that exited. */
	readonly terminalId: string;
	/** Exit code of the process, if available. */
	readonly exitCode?: number | null;
	/** Signal that terminated the process, if any. */
	readonly signal?: string | null;
}

export interface TerminalReleasedEvent extends BaseAgentEvent {
	readonly event: AgentEvent.TERMINAL_RELEASED;
	/** The terminal that was released. */
	readonly terminalId: string;
}

// ── File System Events ─────────────────────────────────────────────────────

export interface FsReadEvent extends BaseAgentEvent {
	readonly event: AgentEvent.FS_READ;
	/** The file path that was read. */
	readonly path: string;
	/** Length of the content in characters. */
	readonly contentLength: number;
}

export interface FsWriteEvent extends BaseAgentEvent {
	readonly event: AgentEvent.FS_WRITE;
	/** The file path that was written. */
	readonly path: string;
	/** Length of the content in characters. */
	readonly contentLength: number;
}

// ── Usage Events ───────────────────────────────────────────────────────────

export interface UsageUpdateEvent extends BaseAgentEvent {
	readonly event: AgentEvent.USAGE_UPDATE;
	/** Total context window size in tokens. */
	readonly contextSize: number;
	/** Tokens currently in use. */
	readonly contextUsed: number;
	/** Percentage of context window used (0–100). */
	readonly contextPercent: number;
	/** Cumulative cost information, if available. */
	readonly cost?: Cost | null;
}

// ── Context Injection Events ───────────────────────────────────────────────

export interface ContextInjectedEvent extends BaseAgentEvent {
	readonly event: AgentEvent.CONTEXT_INJECTED;
	/** The instructions that were injected. */
	readonly instructions: string;
	/** Whether the instructions will be sent immediately or queued for the next prompt. */
	readonly queued: boolean;
}

// ── Mode Change Events ─────────────────────────────────────────────────────

export interface ModeChangeEvent extends BaseAgentEvent {
	readonly event: AgentEvent.MODE_CHANGE;
	/** The new mode identifier. */
	readonly modeId: string;
}

// ── Config Update Events ───────────────────────────────────────────────────

export interface ConfigUpdateEvent extends BaseAgentEvent {
	readonly event: AgentEvent.CONFIG_UPDATE;
	/** The updated configuration options. */
	readonly configOptions: SessionConfigOption[];
}

// ── Union of All Events ────────────────────────────────────────────────────

/** Discriminated union of every event an Agent can emit. */
export type AgentEventPayload =
	| AgentReadyEvent
	| AgentBusyEvent
	| AgentIdleEvent
	| AgentErrorEvent
	| AgentDestroyedEvent
	| PromptStartEvent
	| PromptChunkEvent
	| PromptThoughtEvent
	| PromptCompleteEvent
	| ToolStartEvent
	| ToolUpdateEvent
	| ToolCompleteEvent
	| ToolFailedEvent
	| PlanUpdateEvent
	| PermissionRequestedEvent
	| PermissionGrantedEvent
	| PermissionDeniedEvent
	| TerminalCreatedEvent
	| TerminalOutputEvent
	| TerminalExitEvent
	| TerminalReleasedEvent
	| FsReadEvent
	| FsWriteEvent
	| UsageUpdateEvent
	| ContextInjectedEvent
	| ModeChangeEvent
	| ConfigUpdateEvent;

// ── Event Map (for strongly-typed EventEmitter) ────────────────────────────

/**
 * Maps each `AgentEvent` enum member to its corresponding payload type.
 * Used to type the `on()`, `once()`, and `emit()` methods of the Agent.
 */
export interface AgentEventMap {
	[AgentEvent.AGENT_READY]: AgentReadyEvent;
	[AgentEvent.AGENT_BUSY]: AgentBusyEvent;
	[AgentEvent.AGENT_IDLE]: AgentIdleEvent;
	[AgentEvent.AGENT_ERROR]: AgentErrorEvent;
	[AgentEvent.AGENT_DESTROYED]: AgentDestroyedEvent;

	[AgentEvent.PROMPT_START]: PromptStartEvent;
	[AgentEvent.PROMPT_CHUNK]: PromptChunkEvent;
	[AgentEvent.PROMPT_THOUGHT]: PromptThoughtEvent;
	[AgentEvent.PROMPT_COMPLETE]: PromptCompleteEvent;

	[AgentEvent.TOOL_START]: ToolStartEvent;
	[AgentEvent.TOOL_UPDATE]: ToolUpdateEvent;
	[AgentEvent.TOOL_COMPLETE]: ToolCompleteEvent;
	[AgentEvent.TOOL_FAILED]: ToolFailedEvent;

	[AgentEvent.PLAN_UPDATE]: PlanUpdateEvent;

	[AgentEvent.PERMISSION_REQUESTED]: PermissionRequestedEvent;
	[AgentEvent.PERMISSION_GRANTED]: PermissionGrantedEvent;
	[AgentEvent.PERMISSION_DENIED]: PermissionDeniedEvent;

	[AgentEvent.TERMINAL_CREATED]: TerminalCreatedEvent;
	[AgentEvent.TERMINAL_OUTPUT]: TerminalOutputEvent;
	[AgentEvent.TERMINAL_EXIT]: TerminalExitEvent;
	[AgentEvent.TERMINAL_RELEASED]: TerminalReleasedEvent;

	[AgentEvent.FS_READ]: FsReadEvent;
	[AgentEvent.FS_WRITE]: FsWriteEvent;

	[AgentEvent.USAGE_UPDATE]: UsageUpdateEvent;

	[AgentEvent.CONTEXT_INJECTED]: ContextInjectedEvent;

	[AgentEvent.MODE_CHANGE]: ModeChangeEvent;

	[AgentEvent.CONFIG_UPDATE]: ConfigUpdateEvent;
}
