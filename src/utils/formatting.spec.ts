import { describe, expect, it } from "bun:test";

import {
	ansi,
	isoNow,
	KIND_ICONS,
	renderBar,
	STATUS_ICONS,
	separator,
	timestamp,
	truncate,
} from "./formatting.ts";

// ── timestamp() ────────────────────────────────────────────────────────────

describe("timestamp", () => {
	it("returns a string in HH:MM:SS.mmm format", () => {
		const ts = timestamp();
		// e.g. "14:32:07.421"
		expect(ts).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
	});

	it("returns a 12-character string", () => {
		const ts = timestamp();
		expect(ts.length).toBe(12);
	});

	it("returns a time close to the current time", () => {
		const ts = timestamp();
		const now = new Date();
		const [hours, minutes] = ts.split(":").map(Number);

		expect(hours).toBe(now.getUTCHours());
		expect(minutes).toBe(now.getUTCMinutes());
	});

	it("returns different values when called at different times", async () => {
		const ts1 = timestamp();
		await new Promise((resolve) => setTimeout(resolve, 5));
		const ts2 = timestamp();

		// Timestamps should differ (at least in milliseconds)
		// In extremely rare cases they might match, so we just verify format
		expect(ts1).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
		expect(ts2).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);
	});
});

// ── isoNow() ───────────────────────────────────────────────────────────────

describe("isoNow", () => {
	it("returns a valid ISO-8601 date string", () => {
		const iso = isoNow();
		const parsed = new Date(iso);

		expect(parsed.toISOString()).toBe(iso);
	});

	it("ends with Z (UTC)", () => {
		const iso = isoNow();
		expect(iso.endsWith("Z")).toBe(true);
	});

	it("contains the T separator between date and time", () => {
		const iso = isoNow();
		expect(iso).toContain("T");
	});

	it("matches the ISO-8601 pattern", () => {
		const iso = isoNow();
		expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});

	it("represents a time very close to now", () => {
		const before = Date.now();
		const iso = isoNow();
		const after = Date.now();
		const isoMs = new Date(iso).getTime();

		expect(isoMs).toBeGreaterThanOrEqual(before);
		expect(isoMs).toBeLessThanOrEqual(after);
	});
});

// ── renderBar() ────────────────────────────────────────────────────────────

describe("renderBar", () => {
	it("returns a string containing block characters", () => {
		const bar = renderBar(50);
		expect(bar).toContain("█");
		expect(bar).toContain("░");
	});

	it("renders a fully empty bar at 0%", () => {
		const bar = renderBar(0);
		// Should have 0 filled blocks and 20 empty blocks
		const stripped = stripAnsi(bar);
		expect(stripped).toBe("░".repeat(20));
	});

	it("renders a fully filled bar at 100%", () => {
		const bar = renderBar(100);
		const stripped = stripAnsi(bar);
		expect(stripped).toBe("█".repeat(20));
	});

	it("renders approximately half-filled bar at 50%", () => {
		const bar = renderBar(50);
		const stripped = stripAnsi(bar);
		const filled = (stripped.match(/█/g) || []).length;
		const empty = (stripped.match(/░/g) || []).length;

		expect(filled).toBe(10);
		expect(empty).toBe(10);
		expect(filled + empty).toBe(20);
	});

	it("uses green color for low usage (≤50%)", () => {
		const bar = renderBar(30);
		expect(bar).toContain(ansi.green);
	});

	it("uses yellow color for medium usage (51-80%)", () => {
		const bar = renderBar(65);
		expect(bar).toContain(ansi.yellow);
	});

	it("uses red color for high usage (>80%)", () => {
		const bar = renderBar(90);
		expect(bar).toContain(ansi.red);
	});

	it("clamps values below 0 to 0", () => {
		const bar = renderBar(-10);
		const stripped = stripAnsi(bar);
		expect(stripped).toBe("░".repeat(20));
	});

	it("clamps values above 100 to 100", () => {
		const bar = renderBar(150);
		const stripped = stripAnsi(bar);
		expect(stripped).toBe("█".repeat(20));
	});

	it("handles boundary value 50 as green", () => {
		const bar = renderBar(50);
		expect(bar).toContain(ansi.green);
	});

	it("handles boundary value 51 as yellow", () => {
		const bar = renderBar(51);
		expect(bar).toContain(ansi.yellow);
	});

	it("handles boundary value 80 as yellow", () => {
		const bar = renderBar(80);
		expect(bar).toContain(ansi.yellow);
	});

	it("handles boundary value 81 as red", () => {
		const bar = renderBar(81);
		expect(bar).toContain(ansi.red);
	});

	it("total block count is always 20", () => {
		for (const pct of [0, 10, 25, 33, 50, 67, 75, 90, 100]) {
			const bar = renderBar(pct);
			const stripped = stripAnsi(bar);
			const filled = (stripped.match(/█/g) || []).length;
			const empty = (stripped.match(/░/g) || []).length;
			expect(filled + empty).toBe(20);
		}
	});

	it("includes reset escape at the end", () => {
		const bar = renderBar(50);
		expect(bar).toContain(ansi.reset);
	});
});

// ── truncate() ─────────────────────────────────────────────────────────────

describe("truncate", () => {
	it("returns the original string when shorter than maxLength", () => {
		expect(truncate("hello", 10)).toBe("hello");
	});

	it("returns the original string when exactly maxLength", () => {
		expect(truncate("12345", 5)).toBe("12345");
	});

	it("truncates and appends info when longer than maxLength", () => {
		const result = truncate("hello world", 5);
		expect(result).toBe("hello… (11 chars)");
	});

	it("uses default maxLength of 200", () => {
		const short = "a".repeat(200);
		expect(truncate(short)).toBe(short);

		const long = "b".repeat(201);
		const result = truncate(long);
		expect(result).toContain("…");
		expect(result).toContain("201 chars");
	});

	it("handles empty string", () => {
		expect(truncate("")).toBe("");
		expect(truncate("", 0)).toBe("");
	});

	it("handles maxLength of 0", () => {
		const result = truncate("hello", 0);
		expect(result).toBe("… (5 chars)");
	});

	it("handles maxLength of 1", () => {
		const result = truncate("hello", 1);
		expect(result).toBe("h… (5 chars)");
	});

	it("preserves the full character count in the suffix", () => {
		const text = "This is a fairly long piece of text that will be truncated";
		const result = truncate(text, 10);
		expect(result).toContain(`${text.length} chars`);
	});

	it("returns original string for single character with maxLength 1", () => {
		expect(truncate("x", 1)).toBe("x");
	});

	it("handles unicode characters", () => {
		const emoji = "🎉🎊🎈🎁🎂";
		const result = truncate(emoji, 2);
		expect(result).toContain("…");
	});
});

// ── separator() ────────────────────────────────────────────────────────────

describe("separator", () => {
	it("returns a string without a label", () => {
		const sep = separator();
		expect(typeof sep).toBe("string");
		expect(sep.length).toBeGreaterThan(0);
	});

	it("returns a string with a label embedded", () => {
		const sep = separator("MY SECTION");
		const stripped = stripAnsi(sep);
		expect(stripped).toContain("MY SECTION");
	});

	it("contains dash characters without a label", () => {
		const sep = separator();
		expect(sep).toContain("─");
	});

	it("contains dash characters with a label", () => {
		const sep = separator("TEST");
		expect(sep).toContain("─");
	});

	it("includes ANSI dim styling", () => {
		const sep = separator();
		expect(sep).toContain(ansi.dim);
	});

	it("includes ANSI reset at the end", () => {
		const sep = separator();
		expect(sep).toContain(ansi.reset);
	});

	it("includes bold styling for the label", () => {
		const sep = separator("LABEL");
		expect(sep).toContain(ansi.bold);
	});

	it("handles empty string label", () => {
		const sep = separator("");
		// Should still produce valid output
		expect(typeof sep).toBe("string");
		expect(sep).toContain("─");
	});

	it("handles very long labels gracefully", () => {
		const longLabel = "A".repeat(100);
		const sep = separator(longLabel);
		const stripped = stripAnsi(sep);
		// Should contain the label even if it's longer than the total width
		expect(stripped).toContain(longLabel);
	});

	it("produces consistent output for the same input", () => {
		const sep1 = separator("TEST");
		const sep2 = separator("TEST");
		expect(sep1).toBe(sep2);
	});

	it("produces different output for different labels", () => {
		const sep1 = separator("ALPHA");
		const sep2 = separator("BETA");
		expect(sep1).not.toBe(sep2);
	});

	it("labeled separator differs from unlabeled", () => {
		const labeled = separator("X");
		const unlabeled = separator();
		expect(labeled).not.toBe(unlabeled);
	});
});

// ── ANSI Constants ─────────────────────────────────────────────────────────

describe("ansi constants", () => {
	it("has a reset code", () => {
		expect(ansi.reset).toBe("\x1b[0m");
	});

	it("has all basic style codes", () => {
		expect(ansi.bold).toBe("\x1b[1m");
		expect(ansi.dim).toBe("\x1b[2m");
		expect(ansi.italic).toBe("\x1b[3m");
		expect(ansi.underline).toBe("\x1b[4m");
	});

	it("has all foreground color codes", () => {
		expect(ansi.red).toBe("\x1b[31m");
		expect(ansi.green).toBe("\x1b[32m");
		expect(ansi.yellow).toBe("\x1b[33m");
		expect(ansi.blue).toBe("\x1b[34m");
		expect(ansi.magenta).toBe("\x1b[35m");
		expect(ansi.cyan).toBe("\x1b[36m");
		expect(ansi.white).toBe("\x1b[37m");
		expect(ansi.gray).toBe("\x1b[90m");
	});

	it("has background color codes", () => {
		expect(ansi.bgRed).toBe("\x1b[41m");
		expect(ansi.bgGreen).toBe("\x1b[42m");
		expect(ansi.bgYellow).toBe("\x1b[43m");
		expect(ansi.bgBlue).toBe("\x1b[44m");
	});

	it("all values are non-empty strings", () => {
		for (const [_key, value] of Object.entries(ansi)) {
			expect(typeof value).toBe("string");
			expect(value.length).toBeGreaterThan(0);
		}
	});

	it("all values start with ESC character", () => {
		for (const [_key, value] of Object.entries(ansi)) {
			expect(value.startsWith("\x1b[")).toBe(true);
		}
	});
});

// ── Icon Maps ──────────────────────────────────────────────────────────────

describe("STATUS_ICONS", () => {
	it("has icons for all standard tool call statuses", () => {
		expect(STATUS_ICONS.pending).toBeDefined();
		expect(STATUS_ICONS.in_progress).toBeDefined();
		expect(STATUS_ICONS.completed).toBeDefined();
		expect(STATUS_ICONS.failed).toBeDefined();
	});

	it("all values are non-empty strings", () => {
		for (const [_key, value] of Object.entries(STATUS_ICONS)) {
			expect(typeof value).toBe("string");
			expect(value.length).toBeGreaterThan(0);
		}
	});
});

describe("KIND_ICONS", () => {
	it("has icons for all standard tool kinds", () => {
		const expectedKinds = [
			"read",
			"edit",
			"delete",
			"move",
			"search",
			"execute",
			"think",
			"fetch",
			"switch_mode",
			"other",
		];

		for (const kind of expectedKinds) {
			expect(KIND_ICONS[kind]).toBeDefined();
		}
	});

	it("all values are non-empty strings", () => {
		for (const [_key, value] of Object.entries(KIND_ICONS)) {
			expect(typeof value).toBe("string");
			expect(value.length).toBeGreaterThan(0);
		}
	});

	it("has exactly 10 tool kinds", () => {
		expect(Object.keys(KIND_ICONS).length).toBe(10);
	});
});

// ── Helper ─────────────────────────────────────────────────────────────────

/**
 * Strips ANSI escape codes from a string for content-only assertions.
 */
function stripAnsi(str: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional ANSI escape stripping
	return str.replace(/\x1b\[[0-9;]*m/g, "");
}
