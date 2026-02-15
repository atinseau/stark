import { spawn, type ChildProcess } from "node:child_process";

import type {
  CreateTerminalRequest,
  TerminalExitStatus,
  TerminalOutputResponse,
  WaitForTerminalExitResponse,
} from "@agentclientprotocol/sdk";

// ── Types ──────────────────────────────────────────────────────────────────

/** Internal state tracked for each managed terminal. */
export interface ManagedTerminal {
  /** The underlying child process. */
  readonly child: ChildProcess;
  /** The terminal identifier returned to the ACP agent. */
  readonly terminalId: string;
  /** The command that was executed. */
  readonly command: string;
  /** Arguments passed to the command. */
  readonly args: string[];
  /** Working directory the command was spawned in. */
  readonly cwd: string;
  /** Accumulated stdout + stderr output. */
  output: string;
  /** Resolves when the child process exits. */
  readonly exitPromise: Promise<TerminalExitResult>;
}

/** Result returned when a terminal process exits. */
export interface TerminalExitResult {
  exitCode?: number | null;
  signal?: string | null;
}

/**
 * Callback invoked whenever a managed terminal produces output on stdout or stderr.
 * Useful for logging or emitting events in real-time.
 */
export type TerminalOutputCallback = (
  terminalId: string,
  stream: "stdout" | "stderr",
  text: string,
) => void;

/**
 * Callback invoked when a managed terminal process exits.
 */
export type TerminalExitCallback = (
  terminalId: string,
  result: TerminalExitResult,
) => void;

// ── Counter for deterministic terminal IDs ─────────────────────────────────

let terminalCounter = 0;

/**
 * Manages the full lifecycle of terminal processes spawned by an ACP agent.
 *
 * Responsibilities:
 *   - Spawning child processes with the correct environment
 *   - Accumulating stdout/stderr output
 *   - Tracking exit status
 *   - Providing output snapshots and exit-wait semantics
 *   - Killing and releasing terminals
 *
 * This class is intentionally decoupled from the Agent so it can be tested
 * and reused independently.
 *
 * @example
 * ```ts
 * const manager = new TerminalManager();
 * const term = manager.create({ command: "ls", args: ["-la"], cwd: "/tmp" });
 * const result = await manager.waitForExit(term.terminalId);
 * console.log(term.output, result.exitCode);
 * manager.release(term.terminalId);
 * ```
 */
export class TerminalManager {
  /** All terminals currently tracked, keyed by terminal ID. */
  private readonly terminals = new Map<string, ManagedTerminal>();

  /** Optional callback fired on every stdout/stderr chunk. */
  private onOutput: TerminalOutputCallback | null = null;

  /** Optional callback fired when a terminal exits. */
  private onExit: TerminalExitCallback | null = null;

  // ── Lifecycle Hooks ────────────────────────────────────────────────────

  /** Register a callback for terminal output events. */
  setOutputCallback(cb: TerminalOutputCallback): void {
    this.onOutput = cb;
  }

  /** Register a callback for terminal exit events. */
  setExitCallback(cb: TerminalExitCallback): void {
    this.onExit = cb;
  }

  // ── Core Operations ────────────────────────────────────────────────────

  /**
   * Spawns a new terminal process and begins tracking it.
   *
   * @param params - The ACP `CreateTerminalRequest` parameters.
   * @returns The `ManagedTerminal` record with all tracking state.
   */
  create(params: CreateTerminalRequest): ManagedTerminal {
    const args = params.args ?? [];
    const cwd = params.cwd ?? process.cwd();

    // Build environment: inherit current env + any ACP-provided env vars
    const env: Record<string, string | undefined> = { ...process.env };
    if (params.env) {
      for (const envVar of params.env) {
        env[envVar.name] = envVar.value;
      }
    }

    const child = spawn(params.command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env,
      shell: true,
    });

    const terminalId = `term-${++terminalCounter}-${child.pid ?? "nopid"}`;
    const terminal: ManagedTerminal = {
      child,
      terminalId,
      command: params.command,
      args,
      cwd,
      output: "",
      exitPromise: this.createExitPromise(child, terminalId),
    };

    // Stream stdout
    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      terminal.output += text;
      this.onOutput?.(terminalId, "stdout", text);
    });

    // Stream stderr
    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      terminal.output += text;
      this.onOutput?.(terminalId, "stderr", text);
    });

    this.terminals.set(terminalId, terminal);
    return terminal;
  }

  /**
   * Returns the current accumulated output and exit status of a terminal.
   *
   * @param terminalId - The terminal to query.
   * @returns An ACP-compatible `TerminalOutputResponse`.
   * @throws If the terminal ID is unknown.
   */
  getOutput(terminalId: string): TerminalOutputResponse {
    const terminal = this.getOrThrow(terminalId);

    let exitStatus: TerminalExitStatus | undefined;
    if (terminal.child.exitCode !== null) {
      exitStatus = { exitCode: terminal.child.exitCode };
    }

    return {
      output: terminal.output,
      truncated: false,
      exitStatus,
    };
  }

  /**
   * Waits for a terminal's process to exit and returns its exit status.
   *
   * @param terminalId - The terminal to wait on.
   * @returns An ACP-compatible `WaitForTerminalExitResponse`.
   * @throws If the terminal ID is unknown.
   */
  async waitForExit(terminalId: string): Promise<WaitForTerminalExitResponse> {
    const terminal = this.getOrThrow(terminalId);
    const result = await terminal.exitPromise;
    return {
      exitCode: result.exitCode,
      signal: result.signal,
    };
  }

  /**
   * Sends SIGTERM to a terminal's process and removes it from tracking.
   * No-op if the terminal has already been released.
   *
   * @param terminalId - The terminal to release.
   */
  release(terminalId: string): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;

    if (terminal.child.exitCode === null) {
      terminal.child.kill("SIGTERM");
    }
    this.terminals.delete(terminalId);
  }

  /**
   * Sends SIGKILL to a terminal's process without releasing it.
   * The terminal remains tracked so its output can still be retrieved.
   *
   * @param terminalId - The terminal to kill.
   */
  kill(terminalId: string): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;

    if (terminal.child.exitCode === null) {
      terminal.child.kill("SIGKILL");
    }
  }

  /**
   * Returns whether a terminal with the given ID exists and is tracked.
   */
  has(terminalId: string): boolean {
    return this.terminals.has(terminalId);
  }

  /**
   * Returns the number of terminals currently tracked.
   */
  get size(): number {
    return this.terminals.size;
  }

  /**
   * Kills and releases all tracked terminals.
   * Call this during agent cleanup / destroy.
   */
  destroyAll(): void {
    for (const [id] of this.terminals) {
      this.release(id);
    }
  }

  // ── Internal Helpers ───────────────────────────────────────────────────

  /**
   * Retrieves a managed terminal or throws a descriptive error.
   */
  private getOrThrow(terminalId: string): ManagedTerminal {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) {
      throw new Error(`TerminalManager: unknown terminal "${terminalId}"`);
    }
    return terminal;
  }

  /**
   * Creates a promise that resolves when the child process exits,
   * and notifies the exit callback.
   */
  private createExitPromise(child: ChildProcess, terminalId: string): Promise<TerminalExitResult> {
    return new Promise<TerminalExitResult>((resolve) => {
      child.on("exit", (code, signal) => {
        const result: TerminalExitResult = {
          exitCode: code,
          signal: signal ?? undefined,
        };
        this.onExit?.(terminalId, result);
        resolve(result);
      });
    });
  }
}
