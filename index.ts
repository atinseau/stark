import * as acp from "@agentclientprotocol/sdk";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";

// ── ANSI colors for pretty terminal output ──────────────────────────────────
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  bgBlue: "\x1b[44m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgRed: "\x1b[41m",
};

function timestamp(): string {
  return `${c.gray}[${new Date().toISOString().slice(11, 23)}]${c.reset}`;
}

function log(icon: string, category: string, message: string, color: string = c.white) {
  process.stderr.write(`${timestamp()} ${icon}  ${c.bold}${color}${category}${c.reset} ${message}\n`);
}

function separator(label?: string) {
  const line = "─".repeat(60);
  if (label) {
    process.stderr.write(`\n${c.dim}──── ${c.bold}${label} ${c.dim}${"─".repeat(Math.max(0, 54 - label.length))}${c.reset}\n`);
  } else {
    process.stderr.write(`${c.dim}${line}${c.reset}\n`);
  }
}

// ── Track tool call state ───────────────────────────────────────────────────
const toolCalls = new Map<string, { title: string; kind?: string; status?: string }>();

const statusIcon: Record<string, string> = {
  pending: "⏳",
  in_progress: "⚙️ ",
  completed: "✅",
  failed: "❌",
};

const kindIcon: Record<string, string> = {
  read: "📖",
  edit: "✏️ ",
  delete: "🗑️ ",
  move: "📦",
  search: "🔍",
  execute: "▶️ ",
  think: "🧠",
  fetch: "🌐",
  switch_mode: "🔄",
  other: "🔧",
};

async function main() {
  separator("ACP CLIENT STARTING");
  const executable = process.env.COPILOT_CLI_PATH ?? "copilot";
  log("🚀", "INIT", `Spawning agent: ${c.cyan}${executable} --acp --stdio${c.reset}`);

  const copilotProcess = spawn(executable, ["--acp", "--stdio"], {
    stdio: ["pipe", "pipe", "inherit"],
  });

  if (!copilotProcess.stdin || !copilotProcess.stdout) {
    throw new Error("Failed to start Copilot ACP process with piped stdio.");
  }

  log("✅", "INIT", `Agent process spawned ${c.dim}(pid: ${copilotProcess.pid})${c.reset}`);

  const output = Writable.toWeb(copilotProcess.stdin) as WritableStream<Uint8Array>;
  const input = Readable.toWeb(copilotProcess.stdout) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(output, input);

  const client: acp.Client = {
    // ── Permission requests ───────────────────────────────────────────
    async requestPermission(params) {
      separator("PERMISSION REQUEST");
      log("🔐", "PERMISSION", `Tool call: ${c.cyan}${params.toolCall.title ?? params.toolCall.toolCallId}${c.reset}`);
      log("🔐", "PERMISSION", `Options:`);
      for (const opt of params.options) {
        const icon = opt.kind.startsWith("allow") ? "🟢" : "🔴";
        log("  ", `  ${icon}`, `${c.bold}${opt.name}${c.reset} ${c.dim}(kind: ${opt.kind}, id: ${opt.optionId})${c.reset}`);
      }

      const allowOption = params.options.find(
        (o) => o.kind === "allow_always" || o.kind === "allow_once"
      );

      if (allowOption) {
        log("✅", "PERMISSION", `${c.green}Auto-approved → selected "${allowOption.name}" (${allowOption.optionId})${c.reset}`);
        return { outcome: { outcome: "selected" as const, optionId: allowOption.optionId } };
      }

      log("❌", "PERMISSION", `${c.red}No allow option available → cancelled${c.reset}`);
      return { outcome: { outcome: "cancelled" as const } };
    },

    // ── Session updates (the main event stream) ───────────────────────
    async sessionUpdate(params) {
      const update = params.update;

      switch (update.sessionUpdate) {
        // ── Agent text output ───────────────────────────────────────
        case "agent_message_chunk": {
          if (update.content.type === "text") {
            process.stdout.write(update.content.text);
          } else {
            log("💬", "AGENT MSG", `${c.dim}(non-text content: ${update.content.type})${c.reset}`);
          }
          break;
        }

        // ── Agent thinking / reasoning ──────────────────────────────
        case "agent_thought_chunk": {
          if (update.content.type === "text") {
            process.stderr.write(`${c.magenta}${c.italic}${update.content.text}${c.reset}`);
          } else {
            log("🧠", "THOUGHT", `${c.magenta}(non-text thought: ${update.content.type})${c.reset}`);
          }
          break;
        }

        // ── User message echo ───────────────────────────────────────
        case "user_message_chunk": {
          if (update.content.type === "text") {
            log("👤", "USER", `${c.blue}${update.content.text}${c.reset}`);
          }
          break;
        }

        // ── New tool call created ───────────────────────────────────
        case "tool_call": {
          const ki = update.kind ? kindIcon[update.kind] ?? "🔧" : "🔧";
          const st = update.status ? statusIcon[update.status] ?? "❓" : "❓";
          toolCalls.set(update.toolCallId, {
            title: update.title,
            kind: update.kind ?? undefined,
            status: update.status ?? undefined,
          });

          separator(`TOOL CALL: ${update.title}`);
          log(ki, "TOOL CALL", `${c.bold}${update.title}${c.reset}`);
          log("  ", "  ID", `${c.dim}${update.toolCallId}${c.reset}`);
          if (update.kind) log("  ", "  Kind", `${update.kind}`);
          if (update.status) log("  ", "  Status", `${st} ${update.status}`);

          if (update.locations && update.locations.length > 0) {
            log("  ", "  Locations", ``);
            for (const loc of update.locations) {
              const lineInfo = loc.line != null ? `:${loc.line}` : "";
              log("  ", "    📄", `${c.cyan}${loc.path}${lineInfo}${c.reset}`);
            }
          }

          if (update.rawInput != null) {
            const inputStr = typeof update.rawInput === "string"
              ? update.rawInput
              : JSON.stringify(update.rawInput, null, 2);
            if (inputStr.length <= 500) {
              log("  ", "  Input", `${c.dim}${inputStr}${c.reset}`);
            } else {
              log("  ", "  Input", `${c.dim}${inputStr.slice(0, 500)}… (${inputStr.length} chars)${c.reset}`);
            }
          }

          // Log tool call content (diffs, terminal references, etc.)
          if (update.content && update.content.length > 0) {
            for (const item of update.content) {
              logToolCallContent(item);
            }
          }
          break;
        }

        // ── Tool call progress update ───────────────────────────────
        case "tool_call_update": {
          const existing = toolCalls.get(update.toolCallId);
          const title = update.title ?? existing?.title ?? update.toolCallId;

          if (update.title && existing) existing.title = update.title;
          if (update.status && existing) existing.status = update.status;
          if (update.kind && existing) existing.kind = update.kind;

          const st = update.status ? statusIcon[update.status] ?? "❓" : "🔄";
          const statusLabel = update.status ?? "update";

          log(st, "TOOL UPDATE", `${c.bold}${title}${c.reset} → ${c.yellow}${statusLabel}${c.reset}`);

          if (update.locations && update.locations.length > 0) {
            for (const loc of update.locations) {
              const lineInfo = loc.line != null ? `:${loc.line}` : "";
              log("  ", "  📄", `${c.cyan}${loc.path}${lineInfo}${c.reset}`);
            }
          }

          if (update.rawOutput != null) {
            const outputStr = typeof update.rawOutput === "string"
              ? update.rawOutput
              : JSON.stringify(update.rawOutput, null, 2);
            if (outputStr.length <= 300) {
              log("  ", "  Output", `${c.dim}${outputStr}${c.reset}`);
            } else {
              log("  ", "  Output", `${c.dim}${outputStr.slice(0, 300)}… (${outputStr.length} chars)${c.reset}`);
            }
          }

          if (update.content && update.content.length > 0) {
            for (const item of update.content) {
              logToolCallContent(item);
            }
          }
          break;
        }

        // ── Execution plan ──────────────────────────────────────────
        case "plan": {
          separator("EXECUTION PLAN");
          for (const entry of update.entries) {
            const st = statusIcon[entry.status] ?? "❓";
            const priorityColor = entry.priority === "high" ? c.red : entry.priority === "medium" ? c.yellow : c.dim;
            log(st, entry.status.toUpperCase().padEnd(11), `${priorityColor}[${entry.priority}]${c.reset} ${entry.content}`);
          }
          break;
        }

        // ── Available commands ──────────────────────────────────────
        case "available_commands_update": {
          log("📋", "COMMANDS", `${c.dim}Available commands updated (${update.availableCommands.length} commands)${c.reset}`);
          for (const cmd of update.availableCommands) {
            log("  ", `  ▸`, `${c.cyan}${cmd.name}${c.reset}${cmd.description ? ` — ${c.dim}${cmd.description}${c.reset}` : ""}`);
          }
          break;
        }

        // ── Mode change ─────────────────────────────────────────────
        case "current_mode_update": {
          log("🔄", "MODE", `Switched to: ${c.bold}${c.cyan}${update.currentModeId}${c.reset}`);
          break;
        }

        // ── Config option change ────────────────────────────────────
        case "config_option_update": {
          log("⚙️ ", "CONFIG", `${c.dim}Config updated: ${JSON.stringify(update.configOptions)}${c.reset}`);
          break;
        }

        // ── Session info ────────────────────────────────────────────
        case "session_info_update": {
          log("ℹ️ ", "SESSION", `${c.dim}Session info updated${update.title ? `: ${update.title}` : ""}${c.reset}`);
          break;
        }

        // ── Token usage ─────────────────────────────────────────────
        case "usage_update": {
          const pct = update.size > 0 ? Math.round((update.used / update.size) * 100) : 0;
          const bar = renderBar(pct);
          let costStr = "";
          if (update.cost) {
            costStr = ` | ${c.yellow}Cost: ${update.cost.amount.toFixed(4)} ${update.cost.currency}${c.reset}`;
          }
          log("📊", "USAGE", `Context: ${bar} ${pct}% (${update.used.toLocaleString()}/${update.size.toLocaleString()} tokens)${costStr}`);
          break;
        }

        default: {
          log("❓", "UNKNOWN", `${c.dim}Unhandled session update: ${JSON.stringify(update).slice(0, 200)}${c.reset}`);
          break;
        }
      }
    },

    // ── File system: write ────────────────────────────────────────────
    async writeTextFile(params) {
      log("💾", "FS WRITE", `${c.green}${params.path}${c.reset} ${c.dim}(${params.content.length} chars)${c.reset}`);
      const { writeFile, mkdir } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdir(dirname(params.path), { recursive: true });
      await writeFile(params.path, params.content, "utf-8");
      log("✅", "FS WRITE", `${c.green}Done: ${params.path}${c.reset}`);
      return {};
    },

    // ── File system: read ─────────────────────────────────────────────
    async readTextFile(params) {
      log("📖", "FS READ", `${c.cyan}${params.path}${c.reset}`);
      const { readFile } = await import("node:fs/promises");
      const content = await readFile(params.path, "utf-8");
      log("✅", "FS READ", `${c.cyan}${params.path}${c.reset} ${c.dim}(${content.length} chars)${c.reset}`);
      return { content };
    },

    // ── Terminal: create ──────────────────────────────────────────────
    async createTerminal(params) {
      separator("TERMINAL");
      log("▶️ ", "TERMINAL", `${c.yellow}Creating terminal${c.reset}`);
      log("  ", "  Command", `${c.bold}${params.command}${c.reset}`);
      if (params.args && params.args.length > 0) {
        log("  ", "  Args", `${c.dim}${params.args.join(" ")}${c.reset}`);
      }
      if (params.cwd) {
        log("  ", "  CWD", `${c.dim}${params.cwd}${c.reset}`);
      }

      const { spawn: spawnTerminal } = await import("node:child_process");
      const args = params.args ?? [];
      const child = spawnTerminal(params.command, args, {
        cwd: params.cwd ?? process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          ...(params.env ? Object.fromEntries(params.env.map((e) => [e.name, e.value])) : {}),
        },
        shell: true,
      });

      const termId = `term-${child.pid}`;
      let output = "";

      child.stdout?.on("data", (data: Buffer) => {
        const text = data.toString();
        output += text;
        log("  ", `  ${c.dim}[stdout]${c.reset}`, `${c.dim}${text.trimEnd()}${c.reset}`);
      });

      child.stderr?.on("data", (data: Buffer) => {
        const text = data.toString();
        output += text;
        log("  ", `  ${c.red}[stderr]${c.reset}`, `${c.red}${text.trimEnd()}${c.reset}`);
      });

      const exitPromise = new Promise<{ exitCode?: number | null; signal?: string | null }>((resolve) => {
        child.on("exit", (code, signal) => {
          log("  ", "  EXIT", `${c.dim}code=${code}, signal=${signal}${c.reset}`);
          resolve({ exitCode: code, signal: signal ?? undefined });
        });
      });

      // Store terminal data for later retrieval
      terminals.set(termId, { child, output: () => output, exitPromise });

      log("✅", "TERMINAL", `Created: ${c.dim}${termId}${c.reset}`);
      return { terminalId: termId };
    },

    // ── Terminal: get output ──────────────────────────────────────────
    async terminalOutput(params) {
      const term = terminals.get(params.terminalId);
      if (!term) {
        log("❌", "TERMINAL", `${c.red}Unknown terminal: ${params.terminalId}${c.reset}`);
        return { output: "", exitStatus: null, truncated: false };
      }
      const output = term.output();
      log("📋", "TERMINAL OUTPUT", `${c.dim}${params.terminalId} → ${output.length} chars${c.reset}`);

      // Check if process has exited
      let exitStatus: { exitCode?: number | null; signal?: string | null } | null = null;
      if (term.child.exitCode !== null) {
        exitStatus = { exitCode: term.child.exitCode };
      }

      return { output, exitStatus, truncated: false };
    },

    // ── Terminal: wait for exit ───────────────────────────────────────
    async waitForTerminalExit(params) {
      const term = terminals.get(params.terminalId);
      if (!term) {
        log("❌", "TERMINAL", `${c.red}Unknown terminal for wait: ${params.terminalId}${c.reset}`);
        return { exitStatus: { exitCode: 1 } };
      }
      log("⏳", "TERMINAL WAIT", `${c.dim}Waiting for ${params.terminalId}…${c.reset}`);
      const exitStatus = await term.exitPromise;
      log("✅", "TERMINAL WAIT", `${c.dim}${params.terminalId} exited (code=${exitStatus.exitCode})${c.reset}`);
      return { exitCode: exitStatus.exitCode, signal: exitStatus.signal };
    },

    // ── Terminal: release ─────────────────────────────────────────────
    async releaseTerminal(params) {
      const term = terminals.get(params.terminalId);
      if (term) {
        term.child.kill("SIGTERM");
        terminals.delete(params.terminalId);
        log("🗑️ ", "TERMINAL", `${c.dim}Released: ${params.terminalId}${c.reset}`);
      }
      return {};
    },

    // ── Terminal: kill ────────────────────────────────────────────────
    async killTerminal(params) {
      const term = terminals.get(params.terminalId);
      if (term) {
        term.child.kill("SIGKILL");
        log("💀", "TERMINAL", `${c.red}Killed: ${params.terminalId}${c.reset}`);
      }
    },
  };

  // ── Terminal storage ────────────────────────────────────────────────
  const terminals = new Map<
    string,
    {
      child: ReturnType<typeof spawn>;
      output: () => string;
      exitPromise: Promise<{ exitCode?: number | null; signal?: string | null }>;
    }
  >();

  // ── Connect and initialize ──────────────────────────────────────────
  separator("CONNECTING");
  const connection = new acp.ClientSideConnection((_agent) => client, stream);

  log("🤝", "INIT", "Sending initialize request…");
  const initResult = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
      terminal: true,
    },
  });

  log("✅", "INIT", `Protocol version: ${c.cyan}${initResult.protocolVersion}${c.reset}`);
  if (initResult.agentInfo) {
    log("🤖", "AGENT", `${c.bold}${initResult.agentInfo.name}${c.reset} ${c.dim}v${initResult.agentInfo.version ?? "?"}${c.reset}`);
  }
  if (initResult.agentCapabilities) {
    log("📦", "CAPABILITIES", `${c.dim}${JSON.stringify(initResult.agentCapabilities)}${c.reset}`);
  }

  // ── Create session ──────────────────────────────────────────────────
  separator("NEW SESSION");
  log("📂", "SESSION", `CWD: ${c.cyan}${process.cwd()}${c.reset}`);

  const sessionResult = await connection.newSession({
    cwd: process.cwd(),
    mcpServers: [],
  });

  log("✅", "SESSION", `ID: ${c.cyan}${sessionResult.sessionId}${c.reset}`);

  // ── Send prompt ─────────────────────────────────────────────────────
  separator("PROMPT");
  const promptText = "I want to rewrite the index.ts in rust in a rust_implementation folder";
  log("💬", "PROMPT", `${c.bold}${c.blue}${promptText}${c.reset}`);
  log("⏳", "PROMPT", `Waiting for agent response…`);

  const promptResult = await connection.prompt({
    sessionId: sessionResult.sessionId,
    prompt: [{ type: "text", text: promptText }],
  });

  // ── Done ────────────────────────────────────────────────────────────
  separator("RESULT");
  process.stdout.write("\n");
  log("🏁", "DONE", `Stop reason: ${c.bold}${promptResult.stopReason}${c.reset}`);

  if (promptResult.usage) {
    const u = promptResult.usage;
    log("📊", "FINAL USAGE", `Input: ${u.inputTokens} | Output: ${u.outputTokens} | Total: ${u.totalTokens}${u.thoughtTokens ? ` | Thought: ${u.thoughtTokens}` : ""}`);
  }

  if (promptResult.stopReason !== "end_turn") {
    process.stderr.write(`${c.yellow}⚠️  Prompt finished with stopReason=${promptResult.stopReason}${c.reset}\n`);
  }

  // ── Summary of tool calls ──────────────────────────────────────────
  if (toolCalls.size > 0) {
    separator("TOOL CALL SUMMARY");
    for (const [id, tc] of toolCalls) {
      const st = tc.status ? statusIcon[tc.status] ?? "❓" : "❓";
      const ki = tc.kind ? kindIcon[tc.kind] ?? "🔧" : "🔧";
      log(st, `${ki} `, `${tc.title} ${c.dim}(${id})${c.reset}`);
    }
  }

  // ── Cleanup ─────────────────────────────────────────────────────────
  separator("CLEANUP");
  log("🧹", "CLEANUP", "Ending agent process…");
  copilotProcess.stdin.end();
  copilotProcess.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    copilotProcess.once("exit", (code, signal) => {
      log("✅", "CLEANUP", `Agent exited ${c.dim}(code=${code}, signal=${signal})${c.reset}`);
      resolve();
    });
    setTimeout(() => {
      log("⚠️ ", "CLEANUP", `${c.yellow}Timeout waiting for agent exit${c.reset}`);
      resolve();
    }, 2000);
  });

  separator("ALL DONE");
}

// ── Helpers ───────────────────────────────────────────────────────────────

function logToolCallContent(item: { type: string } & Record<string, any>) {
  switch (item.type) {
    case "diff": {
      log("  ", "  📝 DIFF", `${c.cyan}${item.path}${c.reset}`);
      if (item.oldText != null) {
        log("  ", "    Old", `${c.red}${c.dim}${item.oldText.slice(0, 100)}${item.oldText.length > 100 ? "…" : ""}${c.reset}`);
      } else {
        log("  ", "    Old", `${c.dim}(new file)${c.reset}`);
      }
      if (item.newText != null) {
        const preview = item.newText.slice(0, 200);
        log("  ", "    New", `${c.green}${c.dim}${preview}${item.newText.length > 200 ? "…" : ""} (${item.newText.length} chars)${c.reset}`);
      }
      break;
    }
    case "terminal": {
      log("  ", "  🖥️  TERM", `${c.dim}terminalId: ${item.terminalId}${c.reset}`);
      break;
    }
    case "content": {
      log("  ", "  📄 CONTENT", `${c.dim}${JSON.stringify(item).slice(0, 200)}${c.reset}`);
      break;
    }
    default: {
      log("  ", "  ❓ UNKNOWN", `${c.dim}${JSON.stringify(item).slice(0, 200)}${c.reset}`);
      break;
    }
  }
}

function renderBar(pct: number): string {
  const width = 20;
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  const color = pct > 80 ? c.red : pct > 50 ? c.yellow : c.green;
  return `${color}${"█".repeat(filled)}${c.dim}${"░".repeat(empty)}${c.reset}`;
}

main().catch((error) => {
  log("💥", "FATAL", `${c.red}${error}${c.reset}`);
  console.error(error);
  process.exitCode = 1;
});
