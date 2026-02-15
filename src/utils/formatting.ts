/**
 * Shared formatting utilities for console output.
 *
 * These helpers are used by the logger's pretty-print transport
 * and can be reused anywhere human-readable terminal output is needed.
 */

// ── ANSI Color Codes ───────────────────────────────────────────────────────

/** ANSI escape sequences for terminal styling. */
export const ansi = {
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

  bgRed: "\x1b[41m",
  bgGreen: "\x1b[42m",
  bgYellow: "\x1b[43m",
  bgBlue: "\x1b[44m",
} as const;

// ── Icon Maps ──────────────────────────────────────────────────────────────

/** Maps tool call execution statuses to display icons. */
export const STATUS_ICONS: Record<string, string> = {
  pending: "⏳",
  in_progress: "⚙️ ",
  completed: "✅",
  failed: "❌",
};

/** Maps tool kinds (read, edit, execute, etc.) to display icons. */
export const KIND_ICONS: Record<string, string> = {
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

// ── Formatting Functions ───────────────────────────────────────────────────

/**
 * Returns a compact ISO timestamp showing only the time portion with milliseconds.
 *
 * @example
 * ```ts
 * timestamp(); // "14:32:07.421"
 * ```
 */
export function timestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

/**
 * Returns the current time as a full ISO-8601 string.
 *
 * @example
 * ```ts
 * isoNow(); // "2025-01-15T14:32:07.421Z"
 * ```
 */
export function isoNow(): string {
  return new Date().toISOString();
}

/**
 * Renders a horizontal bar chart in the terminal using block characters.
 *
 * The bar is 20 characters wide and color-coded:
 *   - Green  when usage ≤ 50%
 *   - Yellow when usage ≤ 80%
 *   - Red    when usage > 80%
 *
 * @param percent - A value between 0 and 100.
 * @returns A colorized string like `████████████░░░░░░░░`
 *
 * @example
 * ```ts
 * renderBar(42);  // green bar, 42% filled
 * renderBar(75);  // yellow bar, 75% filled
 * renderBar(95);  // red bar, 95% filled
 * ```
 */
export function renderBar(percent: number): string {
  const width = 20;
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  const color = clamped > 80 ? ansi.red : clamped > 50 ? ansi.yellow : ansi.green;

  return `${color}${"█".repeat(filled)}${ansi.dim}${"░".repeat(empty)}${ansi.reset}`;
}

/**
 * Truncates a string to `maxLength` characters, appending an ellipsis and
 * a character count if truncation occurred.
 *
 * @param text     - The input string.
 * @param maxLength - Maximum number of characters before truncation. Defaults to 200.
 * @returns The original string if short enough, or a truncated version.
 *
 * @example
 * ```ts
 * truncate("hello", 10);       // "hello"
 * truncate("hello world", 5);  // "hello… (11 chars)"
 * ```
 */
export function truncate(text: string, maxLength = 200): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}… (${text.length} chars)`;
}

/**
 * Formats a section separator line for console output.
 *
 * When a label is provided, it appears inline within the separator:
 *   `──── MY SECTION ──────────────────────────────────────────`
 *
 * Without a label, a plain line of dashes is returned:
 *   `────────────────────────────────────────────────────────────`
 *
 * @param label - Optional section label.
 * @returns A dim, styled separator string (no trailing newline).
 */
export function separator(label?: string): string {
  const totalWidth = 60;
  if (label) {
    const remaining = Math.max(0, totalWidth - 5 - label.length);
    return `${ansi.dim}──── ${ansi.bold}${label} ${ansi.dim}${"─".repeat(remaining)}${ansi.reset}`;
  }
  return `${ansi.dim}${"─".repeat(totalWidth)}${ansi.reset}`;
}
