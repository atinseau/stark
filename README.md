# Stark

Stark is a TypeScript client for the [Agent Client Protocol (ACP)](https://agentclientprotocol.com/) that wraps an ACP-compatible agent process into a high-level, event-driven `Agent` class. It manages the full lifecycle — spawning, protocol negotiation, prompting, permission handling, terminal management, file I/O — and exposes a clean API designed for building agent pools and orchestration layers.

Built with [Bun](https://bun.sh).

---

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Architecture](#architecture)
- [API Reference](#api-reference)
  - [Agent](#agent)
  - [AgentConfig](#agentconfig)
  - [AgentStatus](#agentstatus)
  - [AgentEvent](#agentevent)
  - [PromptResult](#promptresult)
  - [AgentSnapshot](#agentsnapshot)
- [Event System](#event-system)
- [Context Injection](#context-injection)
- [Logging](#logging)
- [Testing](#testing)
- [Project Structure](#project-structure)
- [License](#license)

---

## Features

- **Full ACP lifecycle management** — spawn, initialize, create session, prompt, destroy
- **Automatic permission handling** — auto-approve tool permissions or plug in your own policy
- **Strongly-typed event system** — 30+ event types across lifecycle, tools, plans, file I/O, terminals, usage, and more
- **Real-time streaming** — receive prompt chunks, tool progress, and terminal output as they happen
- **Context injection** — steer an agent mid-execution by injecting instructions (queued or immediate)
- **Terminal management** — spawn, track, kill, and collect output from child processes
- **Structured logging** — dual-output via [pino](https://github.com/pinojs/pino): colorized console (pino-pretty) and/or structured NDJSON
- **Agent identity** — each agent gets a unique UUID + human-friendly name via [Faker](https://fakerjs.dev/)
- **Pool-ready design** — snapshots, events, and identity make it trivial to orchestrate multiple agents
- **Comprehensive test suite** — 161 tests covering identity, formatting, terminal management, and agent behavior

---

## Requirements

- [Bun](https://bun.sh) ≥ 1.x
- An ACP-compatible agent binary (e.g. `copilot`) available in your `$PATH` or specified via config

---

## Installation

```sh
git clone <repo-url> stark
cd stark
bun install
```

---

## Quick Start

```ts
import { Agent } from "./src/classes/Agent.ts";
import { AgentEvent } from "./src/enums/agent-event.enum.ts";

const agent = new Agent({
  cwd: process.cwd(),
  autoApprove: true,
});

// Wait for ACP initialization
await agent.ready;

// Subscribe to events
agent.on(AgentEvent.TOOL_START, (e) => {
  console.log(`🔧 ${e.title}`);
});

agent.on(AgentEvent.PROMPT_CHUNK, (e) => {
  process.stdout.write(e.text);
});

// Send a prompt
const result = await agent.prompt("Create a hello world HTTP server in Node.js");
console.log(`\nDone: ${result.stopReason}, ${result.text.length} chars`);

// Clean up
await agent.destroy();
```

Run the included demo:

```sh
bun run src/index.ts
# or with a custom prompt:
bun run src/index.ts "Refactor the utils folder"
```

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `COPILOT_CLI_PATH` | Path to the ACP agent binary | `"copilot"` |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                          Your Code                              │
│                                                                 │
│   agent.prompt("...")    agent.on("tool:start", ...)            │
│        │                        ▲                               │
│        ▼                        │                               │
│  ┌──────────────────────────────┴──────────────────────────┐    │
│  │                      Agent Class                        │    │
│  │                                                         │    │
│  │  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │    │
│  │  │   Identity   │  │    Logger    │  │ EventEmitter  │  │    │
│  │  │  (Faker ID)  │  │   (pino)    │  │ (30+ events)  │  │    │
│  │  └─────────────┘  └──────────────┘  └───────────────┘  │    │
│  │                                                         │    │
│  │  ┌─────────────────────────────────────────────────┐    │    │
│  │  │              ACP Client (SDK)                   │    │    │
│  │  │   initialize → newSession → prompt → ...        │    │    │
│  │  └─────────────────────────────────────────────────┘    │    │
│  │                                                         │    │
│  │  ┌─────────────────────────────────────────────────┐    │    │
│  │  │           Terminal Manager                      │    │    │
│  │  │   spawn / track / kill / collect output         │    │    │
│  │  └─────────────────────────────────────────────────┘    │    │
│  └─────────────────────────────────────────────────────────┘    │
│        │                        ▲                               │
│        ▼                        │                               │
│  ┌──────────────────────────────┴──────────────────────────┐    │
│  │              ACP Agent Process (stdio)                  │    │
│  │              e.g. copilot --acp --stdio                 │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

---

## API Reference

### Agent

The main class. Extends `EventEmitter`.

```ts
import { Agent } from "./src/classes/Agent.ts";

const agent = new Agent(config?: AgentConfig);
```

#### Properties

| Property | Type | Description |
|---|---|---|
| `id` | `string` | UUID v4 identifier |
| `name` | `string` | Human-friendly name (e.g. `"Swift Elena"`) |
| `status` | `AgentStatus` | Current lifecycle status |
| `sessionId` | `string \| null` | ACP session ID (available after `ready`) |
| `logger` | `pino.Logger` | The agent's logger instance |
| `ready` | `Promise<void>` | Resolves when the agent is initialized and ready |

#### Methods

##### `prompt(text: string): Promise<PromptResult>`

Sends a user message to the agent and waits for the full response. The agent transitions to `BUSY` while processing and back to `IDLE` when done.

```ts
const result = await agent.prompt("Build a REST API");
console.log(result.text);        // Full response text
console.log(result.stopReason);  // "end_turn" | "cancelled" | ...
console.log(result.usage);       // { inputTokens, outputTokens, ... }
```

##### `injectContext(instructions: string): void`

Injects new instructions into the agent's conversation context. See [Context Injection](#context-injection).

##### `snapshot(): AgentSnapshot`

Returns a read-only snapshot of the agent's current state. Each call returns a fresh copy.

```ts
const snap = agent.snapshot();
// { identity, status, sessionId, promptCount, pendingContextCount }
```

##### `destroy(): Promise<void>`

Gracefully shuts down the agent: closes streams, terminates the child process, releases all terminals. Idempotent — safe to call multiple times.

```ts
await agent.destroy();
// agent.status === "destroyed"
```

##### `on(event, listener)` / `once(event, listener)` / `off(event, listener)`

Standard EventEmitter methods, typed for all `AgentEvent` payloads.

---

### AgentConfig

All fields are optional.

```ts
interface AgentConfig {
  // Identity
  id?: string;                    // Override UUID
  name?: string;                  // Override display name

  // ACP process
  executable?: string;            // Agent binary path (default: $COPILOT_CLI_PATH or "copilot")
  cwd?: string;                   // Working directory (default: process.cwd())
  mcpServers?: McpServer[];       // MCP servers to connect

  // Behavior
  autoApprove?: boolean;          // Auto-approve permissions (default: true)

  // Logging
  logOutput?: {
    console?: boolean;            // Colorized console output (default: true)
    json?: boolean | string;      // JSON output: true = stdout, string = file path
  };
  logLevel?: pino.Level;          // "trace" | "debug" | "info" | "warn" | "error" | "fatal"
}
```

---

### AgentStatus

```ts
enum AgentStatus {
  INITIALIZING = "initializing",  // Spawning process, negotiating protocol
  IDLE         = "idle",          // Ready for prompts
  BUSY         = "busy",         // Processing a prompt
  ERROR        = "error",        // Unrecoverable error
  DESTROYED    = "destroyed",    // Shut down, cannot be reused
}
```

State transitions:

```
INITIALIZING → IDLE → BUSY → IDLE
                            ↘ ERROR
Any state    → DESTROYED
```

---

### PromptResult

```ts
interface PromptResult {
  stopReason: StopReason;      // "end_turn" | "cancelled" | ...
  text: string;                // Full accumulated response text
  usage?: Usage | null;        // Token usage stats
}
```

---

### AgentSnapshot

```ts
interface AgentSnapshot {
  identity: AgentIdentity;         // { id, name }
  status: AgentStatus;
  sessionId: string | null;
  promptCount: number;
  pendingContextCount: number;
}
```

---

## Event System

The Agent emits **30+ strongly-typed events** grouped by domain. Every event payload extends `BaseAgentEvent`:

```ts
interface BaseAgentEvent {
  event: AgentEvent;       // Event type discriminator
  timestamp: string;       // ISO-8601
  agent: AgentIdentity;    // { id, name } of the emitting agent
}
```

### Event Categories

| Domain | Events | Description |
|---|---|---|
| **Lifecycle** | `agent:ready`, `agent:busy`, `agent:idle`, `agent:error`, `agent:destroyed` | Agent state transitions |
| **Prompt** | `prompt:start`, `prompt:chunk`, `prompt:thought`, `prompt:complete` | Prompt turn lifecycle and streaming |
| **Tool** | `tool:start`, `tool:update`, `tool:complete`, `tool:failed` | Tool call tracking |
| **Plan** | `plan:update` | Execution plan updates |
| **Permission** | `permission:requested`, `permission:granted`, `permission:denied` | Permission decisions |
| **Terminal** | `terminal:created`, `terminal:output`, `terminal:exit`, `terminal:released` | Terminal process lifecycle |
| **File System** | `fs:read`, `fs:write` | File operations |
| **Usage** | `usage:update` | Token usage and cost tracking |
| **Context** | `context:injected` | Context injection tracking |
| **Mode** | `mode:change` | Session mode changes |
| **Config** | `config:update` | Configuration updates |

### Usage Examples

```ts
// Stream response text in real-time
agent.on(AgentEvent.PROMPT_CHUNK, (e) => {
  process.stdout.write(e.text);
});

// Track tool calls
agent.on(AgentEvent.TOOL_START, (e) => {
  console.log(`🔧 ${e.title} [${e.kind}]`);
  for (const loc of e.locations ?? []) {
    console.log(`   📄 ${loc.path}:${loc.line}`);
  }
});

// Monitor token usage
agent.on(AgentEvent.USAGE_UPDATE, (e) => {
  console.log(`Context: ${e.contextPercent}% (${e.contextUsed}/${e.contextSize})`);
  if (e.cost) console.log(`Cost: $${e.cost.amount.toFixed(4)}`);
});

// Watch file writes
agent.on(AgentEvent.FS_WRITE, (e) => {
  console.log(`💾 Wrote ${e.path} (${e.contentLength} chars)`);
});

// Pool orchestration: track agent readiness
agent.on(AgentEvent.AGENT_READY, (e) => {
  pool.markReady(e.agent.id, e.sessionId);
});
```

---

## Context Injection

`injectContext()` lets you steer an agent without starting a new session. The behavior adapts to the agent's state:

| Agent Status | Behavior |
|---|---|
| **IDLE** | Instructions are sent immediately as a follow-up prompt |
| **BUSY** | Instructions are queued and sent automatically after the current prompt completes |

```ts
// Inject while idle — sent immediately
agent.injectContext("Use TypeScript strict mode for all code");

// Inject while busy — queued
const promptPromise = agent.prompt("Build the API layer");
agent.injectContext("Also add input validation");  // queued
agent.injectContext("Use Zod for schemas");         // queued
await promptPromise;
// → Both injections are automatically sent as a follow-up prompt
```

Multiple queued injections are concatenated and sent as a single follow-up prompt for efficiency.

---

## Logging

Stark uses [pino](https://github.com/pinojs/pino) with support for two independent output channels:

### Console (pino-pretty)

Colorized, human-readable output on stderr. Enabled by default.

```
[14:32:07.421] INFO (Swift Elena): Agent created, initializing…
[14:32:08.103] INFO (Swift Elena): ACP protocol initialized
[14:32:08.245] INFO (Swift Elena): Session created
[14:32:08.246] INFO (Swift Elena): Prompt: Build a REST API with Express
```

### Structured JSON

NDJSON output to stdout or a file. Ideal for log aggregation.

```ts
const agent = new Agent({
  logOutput: {
    console: true,                    // Keep pretty console output
    json: "./logs/agent.ndjson",      // Also write structured JSON
  },
  logLevel: "debug",
});
```

Every log line includes the agent's identity (`agentId`, `agentName`) as base bindings.

### Disabling Logs

```ts
const agent = new Agent({
  logOutput: { console: false, json: false },
  logLevel: "silent",
});
```

---

## Testing

The project includes **161 unit tests** covering identity generation, formatting utilities, terminal management, and agent behavior.

```sh
# Run all tests
bun test

# Run a specific test file
bun test tests/agent.test.ts
bun test tests/identity.test.ts
bun test tests/terminal-manager.test.ts
bun test tests/formatting.test.ts
```

Tests use `bun:test` and a preload script (`tests/preload.ts`) that filters out benign ACP SDK noise from `console.error` during teardown.

### Test Coverage

| File | Tests | Covers |
|---|---|---|
| `agent.test.ts` | 55 | Identity, state, snapshots, destroy, events, guards, context injection, config, status transitions, enums, EventEmitter, multi-instance, logger config |
| `terminal-manager.test.ts` | 37 | Create, output accumulation, getOutput, waitForExit, release, kill, destroyAll, callbacks, edge cases |
| `formatting.test.ts` | 58 | `timestamp`, `isoNow`, `renderBar`, `truncate`, `separator`, ANSI constants, `STATUS_ICONS`, `KIND_ICONS` |
| `identity.test.ts` | 11 | UUID generation, name generation, overrides, uniqueness |

---

## Project Structure

```
stark/
├── src/
│   ├── index.ts                     # Demo entry point
│   ├── classes/
│   │   └── Agent.ts                 # Main Agent class
│   ├── enums/
│   │   ├── agent-event.enum.ts      # 30+ typed event names
│   │   ├── agent-status.enum.ts     # Lifecycle states
│   │   └── index.ts
│   ├── logger/
│   │   └── create-logger.ts         # pino logger factory
│   ├── types/
│   │   ├── agent.types.ts           # AgentConfig, AgentIdentity, PromptResult, AgentSnapshot
│   │   ├── events.types.ts          # All event payload interfaces + AgentEventMap
│   │   └── index.ts
│   └── utils/
│       ├── formatting.ts            # ANSI codes, icons, timestamp, renderBar, truncate, separator
│       ├── identity.ts              # Agent name + UUID generator (Faker)
│       └── terminal-manager.ts      # Child process lifecycle manager
├── tests/
│   ├── preload.ts                   # Suppresses ACP SDK console noise
│   ├── agent.test.ts
│   ├── formatting.test.ts
│   ├── identity.test.ts
│   └── terminal-manager.test.ts
├── index.ts                         # Legacy raw ACP client (pre-refactor)
├── bunfig.toml                      # Bun test configuration
├── tsconfig.json
└── package.json
```

---

## Dependencies

| Package | Purpose |
|---|---|
| [`@agentclientprotocol/sdk`](https://www.npmjs.com/package/@agentclientprotocol/sdk) | ACP protocol client, types, and stream utilities |
| [`@faker-js/faker`](https://fakerjs.dev/) | Human-friendly agent name generation |
| [`pino`](https://github.com/pinojs/pino) | Structured logging |
| [`pino-pretty`](https://github.com/pinojs/pino-pretty) | Colorized console log output |

---

## License

Private — not published.
