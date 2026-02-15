// ── Test Preload ───────────────────────────────────────────────────────────
// Filters out known noisy console.error messages from the ACP SDK that fire
// during teardown in tests (e.g. "ACP write error", "stream is closing or
// closed", AbortError). These are benign — the SDK catches write failures
// on a closed stream and logs them, but they clutter test output.

const originalConsoleError = console.error;

const SUPPRESSED_PATTERNS = [
  "ACP write error",
  "stream is closing or closed",
  "The operation was aborted",
  "ABORT_ERR",
  "Error handling request",
  "Error handling notification",
  "Failed to parse JSON message",
];

console.error = (...args: unknown[]) => {
  const first = args[0];

  // Check if the first argument (string or Error) matches any suppressed pattern
  if (typeof first === "string") {
    for (const pattern of SUPPRESSED_PATTERNS) {
      if (first.includes(pattern)) return;
    }
  }

  // Some errors are passed as the second argument (e.g. `console.error("ACP write error:", error)`)
  if (args.length > 1) {
    const second = args[1];
    if (second instanceof Error) {
      const msg = second.message ?? String(second);
      for (const pattern of SUPPRESSED_PATTERNS) {
        if (msg.includes(pattern)) return;
      }
      // Also check the error name (e.g. "AbortError")
      if (second.name === "AbortError") return;
    }
  }

  originalConsoleError(...args);
};
