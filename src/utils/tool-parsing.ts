/**
 * Utilities for parsing raw ACP tool call data into clean, consumer-friendly values.
 *
 * The ACP protocol sends `rawInput` and `rawOutput` as opaque `unknown` blobs
 * whose shape depends on the tool kind and the agent implementation. These
 * helpers centralise the parsing logic so that the Agent class can emit
 * pre-parsed fields on tool events, saving every consumer from having to
 * reverse-engineer the ACP data format.
 *
 * Known ACP shapes (as of SDK 0.14.x / Copilot 0.0.410):
 *
 *   rawInput  (execute): { command: "docker info 2>&1" }
 *   rawOutput (execute): { content: "...\n<exited with exit code 0>", detailedContent: "..." }
 */

// ── Command Extraction ─────────────────────────────────────────────────────

/**
 * Extracts the shell command string from a tool's `rawInput`.
 *
 * For "execute" tools, the ACP agent typically sends `{ command: "..." }`.
 * Returns `undefined` when the input doesn't match any known shape.
 *
 * @param rawInput - The opaque `rawInput` from a `tool_call` session update.
 * @returns The shell command string, or `undefined`.
 *
 * @example
 * ```ts
 * parseToolCommand({ command: "docker info" }); // "docker info"
 * parseToolCommand(null);                        // undefined
 * ```
 */
export function parseToolCommand(rawInput: unknown): string | undefined {
	if (rawInput == null || typeof rawInput !== "object") return undefined;

	const obj = rawInput as Record<string, unknown>;

	// Primary shape: { command: "..." }
	if (typeof obj.command === "string" && obj.command.trim()) {
		return obj.command.trim();
	}

	return undefined;
}

// ── Output Extraction ──────────────────────────────────────────────────────

/**
 * Extracts cleaned text output from a tool's `rawOutput`.
 *
 * The ACP agent wraps command output in `{ content, detailedContent }`.
 * This function extracts the text and strips the trailing
 * `<exited with exit code N>` marker that the agent appends.
 *
 * @param rawOutput - The opaque `rawOutput` from a `tool_call_update` session update.
 * @returns The cleaned output string, or `undefined` if nothing useful was found.
 *
 * @example
 * ```ts
 * parseToolOutput({
 *   content: "hello world\n<exited with exit code 0>",
 *   detailedContent: "hello world\n<exited with exit code 0>",
 * });
 * // → "hello world"
 * ```
 */
export function parseToolOutput(rawOutput: unknown): string | undefined {
	const text = extractRawText(rawOutput);
	if (text == null) return undefined;

	const cleaned = stripExitMarker(text).trim();
	return cleaned || undefined;
}

// ── Exit Code Extraction ───────────────────────────────────────────────────

/**
 * Extracts the process exit code from a tool's `rawOutput`.
 *
 * The ACP agent appends `<exited with exit code N>` to command output.
 * This function parses that marker.
 *
 * @param rawOutput - The opaque `rawOutput` from a `tool_call_update` session update.
 * @returns The numeric exit code, or `undefined` if not found.
 *
 * @example
 * ```ts
 * parseExitCode({ content: "ok\n<exited with exit code 0>" });   // 0
 * parseExitCode({ content: "err\n<exited with exit code 127>" }); // 127
 * parseExitCode({ content: "no marker" });                        // undefined
 * ```
 */
export function parseExitCode(rawOutput: unknown): number | undefined {
	const text = extractRawText(rawOutput);
	if (text == null) return undefined;

	const match = text.match(/<exited with exit code (\d+)>/);
	if (match?.[1] != null) {
		return parseInt(match[1], 10);
	}

	return undefined;
}

// ── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Extracts the best raw text string from an ACP rawOutput value.
 *
 * Handles the known shapes:
 *   - Plain string
 *   - `{ content: string }`
 *   - `{ detailedContent: string }`
 *   - `{ content: string, detailedContent: string }` (prefers `content`)
 */
function extractRawText(rawOutput: unknown): string | undefined {
	if (rawOutput == null) return undefined;

	if (typeof rawOutput === "string") return rawOutput;

	if (typeof rawOutput === "object") {
		const obj = rawOutput as Record<string, unknown>;

		if (typeof obj.content === "string") return obj.content;
		if (typeof obj.detailedContent === "string") return obj.detailedContent;

		// Last resort: JSON-serialize the object so consumers at least get something
		try {
			return JSON.stringify(rawOutput, null, 2);
		} catch {
			return String(rawOutput);
		}
	}

	return String(rawOutput);
}

/**
 * Removes the `<exited with exit code N>` marker that the ACP agent
 * appends to command output.
 */
function stripExitMarker(text: string): string {
	return text.replace(/\n?<exited with exit code \d+>\s*$/, "");
}
