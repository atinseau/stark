import { describe, expect, it } from "bun:test";
import type { DecisionJournalEntry } from "../../../types/agent-pool.types.ts";
import { DecisionJournal } from "../decision-journal.ts";

// ════════════════════════════════════════════════════════════════════════════
// DecisionJournal Unit Tests
// ════════════════════════════════════════════════════════════════════════════

describe("DecisionJournal", () => {
	// ── Test 1: record() adds an entry ─────────────────────────────────

	it("record() adds an entry with correct values", () => {
		const journal = new DecisionJournal();

		const entry: DecisionJournalEntry = {
			timestamp: "2024-01-15T10:30:00Z",
			type: "sharing",
			sourceAgentName: "api-developer",
			targetName: "test-writer",
			deltaType: "prompt_complete",
			approved: true,
			reasoningSummary: "API implementation details are critical.",
		};

		journal.record(entry);

		expect(journal.entryCount).toBe(1);

		const entries = journal.getAllEntries();
		expect(entries[0]!.timestamp).toBe("2024-01-15T10:30:00Z");
		expect(entries[0]!.type).toBe("sharing");
		expect(entries[0]!.sourceAgentName).toBe("api-developer");
		expect(entries[0]!.targetName).toBe("test-writer");
		expect(entries[0]!.deltaType).toBe("prompt_complete");
		expect(entries[0]!.approved).toBe(true);
		expect(entries[0]!.reasoningSummary).toBe(
			"API implementation details are critical.",
		);
	});

	// ── Test 2: record() truncates reasoningSummary ────────────────────

	it("record() truncates reasoningSummary when it exceeds maxReasoningLength", () => {
		const journal = new DecisionJournal({ maxReasoningLength: 50 });

		const longReasoning = "A".repeat(300);

		journal.record({
			timestamp: "2024-01-15T10:30:00Z",
			type: "sharing",
			sourceAgentName: "api-developer",
			targetName: "test-writer",
			deltaType: "prompt_complete",
			approved: true,
			reasoningSummary: longReasoning,
		});

		const entries = journal.getAllEntries();
		expect(entries[0]!.reasoningSummary.length).toBe(51); // 50 chars + "…"
		expect(entries[0]!.reasoningSummary.endsWith("…")).toBe(true);
		expect(entries[0]!.reasoningSummary).toBe(`${"A".repeat(50)}…`);
	});

	it("record() does NOT truncate reasoningSummary when exactly at limit", () => {
		const journal = new DecisionJournal({ maxReasoningLength: 20 });

		const exactReasoning = "B".repeat(20);

		journal.record({
			timestamp: "2024-01-15T10:30:00Z",
			type: "sharing",
			sourceAgentName: "api-developer",
			targetName: "test-writer",
			deltaType: "prompt_complete",
			approved: true,
			reasoningSummary: exactReasoning,
		});

		const entries = journal.getAllEntries();
		expect(entries[0]!.reasoningSummary).toBe(exactReasoning);
		expect(entries[0]!.reasoningSummary.length).toBe(20);
	});

	// ── Test 3: record() evicts oldest when maxEntries exceeded ────────

	it("record() evicts oldest entries when maxEntries is exceeded", () => {
		const journal = new DecisionJournal({ maxEntries: 5 });

		for (let i = 0; i < 7; i++) {
			journal.record({
				timestamp: `2024-01-15T10:${String(i).padStart(2, "0")}:00Z`,
				type: "sharing",
				sourceAgentName: `agent-${i}`,
				targetName: "target",
				deltaType: "prompt_complete",
				approved: i % 2 === 0,
				reasoningSummary: `Reasoning ${i}`,
			});
		}

		expect(journal.entryCount).toBe(5);

		const entries = journal.getAllEntries();
		// First two entries (agent-0, agent-1) should have been evicted
		expect(entries[0]!.sourceAgentName).toBe("agent-2");
		expect(entries[1]!.sourceAgentName).toBe("agent-3");
		expect(entries[2]!.sourceAgentName).toBe("agent-4");
		expect(entries[3]!.sourceAgentName).toBe("agent-5");
		expect(entries[4]!.sourceAgentName).toBe("agent-6");
	});

	// ── Test 4: toPromptSection() returns null when empty ──────────────

	it("toPromptSection() returns null when the journal is empty", () => {
		const journal = new DecisionJournal();
		expect(journal.toPromptSection()).toBeNull();
	});

	// ── Test 5: toPromptSection() returns formatted text ───────────────

	it("toPromptSection() returns formatted text with correct entries", () => {
		const journal = new DecisionJournal();

		// Use timestamps very close to now so the relative time is predictable
		const now = new Date();

		journal.record({
			timestamp: new Date(now.getTime() - 5000).toISOString(), // 5s ago
			type: "sharing",
			sourceAgentName: "api-dev",
			targetName: "test-writer",
			deltaType: "prompt_complete",
			approved: true,
			reasoningSummary: "API details needed for tests.",
		});

		journal.record({
			timestamp: new Date(now.getTime() - 10000).toISOString(), // 10s ago
			type: "sharing",
			sourceAgentName: "frontend-dev",
			targetName: "doc-writer",
			deltaType: "file_written",
			approved: false,
			reasoningSummary: "CSS changes irrelevant for documentation.",
		});

		journal.record({
			timestamp: new Date(now.getTime() - 15000).toISOString(), // 15s ago
			type: "notification",
			sourceAgentName: "api-dev",
			targetName: "user",
			deltaType: "agent_error",
			approved: true,
			reasoningSummary: "Error is significant for user awareness.",
		});

		const section = journal.toPromptSection();
		expect(section).not.toBeNull();

		// Check for APPROVED / DENIED markers
		const approvedCount = (section!.match(/✅ APPROVED/g) ?? []).length;
		const deniedCount = (section!.match(/❌ DENIED/g) ?? []).length;
		expect(approvedCount).toBe(2);
		expect(deniedCount).toBe(1);

		// Check for agent names
		expect(section!).toContain("api-dev");
		expect(section!).toContain("test-writer");
		expect(section!).toContain("frontend-dev");
		expect(section!).toContain("doc-writer");

		// Check for reasoning summaries
		expect(section!).toContain("API details needed for tests.");
		expect(section!).toContain("CSS changes irrelevant for documentation.");
		expect(section!).toContain("Error is significant for user awareness.");

		// Check for delta types
		expect(section!).toContain("prompt_complete");
		expect(section!).toContain("file_written");
		expect(section!).toContain("agent_error");

		// Check for notification-style arrow
		expect(section!).toContain("→ user notification");
	});

	// ── Test 6: toPromptSection() respects maxEntriesInPrompt ──────────

	it("toPromptSection() respects maxEntriesInPrompt", () => {
		const journal = new DecisionJournal({
			maxEntries: 15,
			maxEntriesInPrompt: 3,
		});

		for (let i = 0; i < 10; i++) {
			journal.record({
				timestamp: `2024-01-15T10:${String(i).padStart(2, "0")}:00Z`,
				type: "sharing",
				sourceAgentName: `agent-${i}`,
				targetName: "target",
				deltaType: "prompt_complete",
				approved: true,
				reasoningSummary: `Reasoning for entry ${i}`,
			});
		}

		expect(journal.entryCount).toBe(10);

		const section = journal.toPromptSection();
		expect(section).not.toBeNull();

		// Should only contain the 3 most recent entries (agent-7, agent-8, agent-9)
		expect(section!).toContain("agent-7");
		expect(section!).toContain("agent-8");
		expect(section!).toContain("agent-9");

		// Should NOT contain older entries
		expect(section!).not.toContain("agent-0");
		expect(section!).not.toContain("agent-5");
		expect(section!).not.toContain("agent-6");

		// Count the numbered entries (1., 2., 3.)
		const entryMatches = section!.match(/^\d+\.\s/gm);
		expect(entryMatches).toHaveLength(3);
	});

	// ── Test 7: recordSharingDecision() convenience method ─────────────

	it("recordSharingDecision() creates correct sharing entry", () => {
		const journal = new DecisionJournal();

		journal.recordSharingDecision(
			"api-dev",
			"test-writer",
			"prompt_complete",
			true,
			"API implementation details are critical for test-writer's blocking dependency.",
			"2024-01-15T10:00:00Z",
		);

		expect(journal.entryCount).toBe(1);

		const entries = journal.getAllEntries();
		expect(entries[0]!.type).toBe("sharing");
		expect(entries[0]!.sourceAgentName).toBe("api-dev");
		expect(entries[0]!.targetName).toBe("test-writer");
		expect(entries[0]!.deltaType).toBe("prompt_complete");
		expect(entries[0]!.approved).toBe(true);
		expect(entries[0]!.timestamp).toBe("2024-01-15T10:00:00Z");
		expect(entries[0]!.reasoningSummary).toContain("API implementation");
	});

	// ── Test 8: recordNotificationDecision() convenience method ────────

	it("recordNotificationDecision() creates correct notification entry", () => {
		const journal = new DecisionJournal();

		journal.recordNotificationDecision(
			"api-dev",
			"prompt_complete",
			false,
			"Not noteworthy — routine progress",
			"2024-01-15T10:00:00Z",
		);

		expect(journal.entryCount).toBe(1);

		const entries = journal.getAllEntries();
		expect(entries[0]!.type).toBe("notification");
		expect(entries[0]!.sourceAgentName).toBe("api-dev");
		expect(entries[0]!.targetName).toBe("user");
		expect(entries[0]!.deltaType).toBe("prompt_complete");
		expect(entries[0]!.approved).toBe(false);
		expect(entries[0]!.reasoningSummary).toContain("Not noteworthy");
	});

	// ── Test 9: approvalRate calculates correctly ──────────────────────

	it("approvalRate, approvedCount, deniedCount compute correctly", () => {
		const journal = new DecisionJournal();

		// 3 approved
		for (let i = 0; i < 3; i++) {
			journal.record({
				timestamp: new Date().toISOString(),
				type: "sharing",
				sourceAgentName: "agent",
				targetName: "target",
				deltaType: "prompt_complete",
				approved: true,
				reasoningSummary: "approved",
			});
		}

		// 2 denied
		for (let i = 0; i < 2; i++) {
			journal.record({
				timestamp: new Date().toISOString(),
				type: "sharing",
				sourceAgentName: "agent",
				targetName: "target",
				deltaType: "prompt_complete",
				approved: false,
				reasoningSummary: "denied",
			});
		}

		expect(journal.approvedCount).toBe(3);
		expect(journal.deniedCount).toBe(2);
		expect(journal.approvalRate).toBeCloseTo(0.6, 5);
	});

	// ── Test 10: approvalRate returns 0 for empty journal ──────────────

	it("approvalRate returns 0 for an empty journal", () => {
		const journal = new DecisionJournal();
		expect(journal.approvalRate).toBe(0);
		expect(journal.approvedCount).toBe(0);
		expect(journal.deniedCount).toBe(0);
	});

	// ── Test 11: countRecentDecisions() filters by time window ─────────

	it("countRecentDecisions() filters by time window", () => {
		const journal = new DecisionJournal();
		const now = Date.now();

		// Entry 10 seconds ago
		journal.record({
			timestamp: new Date(now - 10_000).toISOString(),
			type: "sharing",
			sourceAgentName: "agent-a",
			targetName: "target",
			deltaType: "prompt_complete",
			approved: true,
			reasoningSummary: "recent-1",
		});

		// Entry 30 seconds ago
		journal.record({
			timestamp: new Date(now - 30_000).toISOString(),
			type: "sharing",
			sourceAgentName: "agent-b",
			targetName: "target",
			deltaType: "prompt_complete",
			approved: true,
			reasoningSummary: "recent-2",
		});

		// Entry 120 seconds ago
		journal.record({
			timestamp: new Date(now - 120_000).toISOString(),
			type: "sharing",
			sourceAgentName: "agent-c",
			targetName: "target",
			deltaType: "prompt_complete",
			approved: true,
			reasoningSummary: "old",
		});

		expect(journal.countRecentDecisions(60)).toBe(2);
		expect(journal.countRecentDecisions(15)).toBe(1);
		expect(journal.countRecentDecisions(300)).toBe(3);
	});

	// ── Test 12: countRecentApprovedForTarget() ────────────────────────

	it("countRecentApprovedForTarget() filters by target AND time window", () => {
		const journal = new DecisionJournal();
		const now = Date.now();

		// approved for test-writer 10s ago
		journal.record({
			timestamp: new Date(now - 10_000).toISOString(),
			type: "sharing",
			sourceAgentName: "agent",
			targetName: "test-writer",
			deltaType: "prompt_complete",
			approved: true,
			reasoningSummary: "r1",
		});

		// denied for test-writer 20s ago
		journal.record({
			timestamp: new Date(now - 20_000).toISOString(),
			type: "sharing",
			sourceAgentName: "agent",
			targetName: "test-writer",
			deltaType: "prompt_complete",
			approved: false,
			reasoningSummary: "r2",
		});

		// approved for doc-writer 30s ago
		journal.record({
			timestamp: new Date(now - 30_000).toISOString(),
			type: "sharing",
			sourceAgentName: "agent",
			targetName: "doc-writer",
			deltaType: "file_written",
			approved: true,
			reasoningSummary: "r3",
		});

		// approved for test-writer 120s ago
		journal.record({
			timestamp: new Date(now - 120_000).toISOString(),
			type: "sharing",
			sourceAgentName: "agent",
			targetName: "test-writer",
			deltaType: "prompt_complete",
			approved: true,
			reasoningSummary: "r4",
		});

		expect(journal.countRecentApprovedForTarget("test-writer", 60)).toBe(1);
		expect(journal.countRecentApprovedForTarget("doc-writer", 60)).toBe(1);
		expect(journal.countRecentApprovedForTarget("test-writer", 300)).toBe(2);
		expect(journal.countRecentApprovedForTarget("nonexistent", 300)).toBe(0);
	});

	// ── Test 13: clear() empties the journal ───────────────────────────

	it("clear() empties the journal completely", () => {
		const journal = new DecisionJournal();

		for (let i = 0; i < 5; i++) {
			journal.record({
				timestamp: new Date().toISOString(),
				type: "sharing",
				sourceAgentName: `agent-${i}`,
				targetName: "target",
				deltaType: "prompt_complete",
				approved: true,
				reasoningSummary: "reason",
			});
		}

		expect(journal.entryCount).toBe(5);

		journal.clear();

		expect(journal.entryCount).toBe(0);
		expect(journal.toPromptSection()).toBeNull();
		expect(journal.getAllEntries()).toHaveLength(0);
		expect(journal.approvalRate).toBe(0);
	});

	// ── Test 14: toTemplateData() returns structured data ──────────────

	it("toTemplateData() returns structured data with correct fields", () => {
		const journal = new DecisionJournal();

		journal.record({
			timestamp: new Date(Date.now() - 5000).toISOString(),
			type: "sharing",
			sourceAgentName: "api-dev",
			targetName: "test-writer",
			deltaType: "prompt_complete",
			approved: true,
			reasoningSummary: "Important info",
		});

		journal.record({
			timestamp: new Date(Date.now() - 10000).toISOString(),
			type: "notification",
			sourceAgentName: "frontend-dev",
			targetName: "user",
			deltaType: "agent_error",
			approved: false,
			reasoningSummary: "Not noteworthy",
		});

		const data = journal.toTemplateData();
		expect(data).toHaveLength(2);

		// First entry
		expect(data[0]!.decision).toBe("APPROVED");
		expect(data[0]!.sourceAgentName).toBe("api-dev");
		expect(data[0]!.targetName).toBe("test-writer");
		expect(data[0]!.deltaType).toBe("prompt_complete");
		expect(data[0]!.approved).toBe(true);
		expect(data[0]!.reasoningSummary).toBe("Important info");
		expect(typeof data[0]!.timeAgo).toBe("string");
		expect(data[0]!.timeAgo).toMatch(/\d+s ago/);

		// Second entry
		expect(data[1]!.decision).toBe("DENIED");
		expect(data[1]!.sourceAgentName).toBe("frontend-dev");
		expect(data[1]!.targetName).toBe("user");
		expect(data[1]!.approved).toBe(false);
	});

	it("toTemplateData() respects maxEntriesInPrompt", () => {
		const journal = new DecisionJournal({
			maxEntries: 10,
			maxEntriesInPrompt: 2,
		});

		for (let i = 0; i < 5; i++) {
			journal.record({
				timestamp: new Date().toISOString(),
				type: "sharing",
				sourceAgentName: `agent-${i}`,
				targetName: "target",
				deltaType: "prompt_complete",
				approved: true,
				reasoningSummary: `reason-${i}`,
			});
		}

		const data = journal.toTemplateData();
		expect(data).toHaveLength(2);
		// Should be the 2 most recent
		expect(data[0]!.sourceAgentName).toBe("agent-3");
		expect(data[1]!.sourceAgentName).toBe("agent-4");
	});

	it("toTemplateData() returns empty array when journal is empty", () => {
		const journal = new DecisionJournal();
		expect(journal.toTemplateData()).toEqual([]);
	});

	// ── Test 15: formatRelativeTime produces readable labels ───────────

	it("formatRelativeTime produces readable labels via toPromptSection", () => {
		const journal = new DecisionJournal();
		const now = Date.now();

		// 5 seconds ago → "5s ago"
		journal.record({
			timestamp: new Date(now - 5000).toISOString(),
			type: "sharing",
			sourceAgentName: "agent-5s",
			targetName: "target",
			deltaType: "prompt_complete",
			approved: true,
			reasoningSummary: "test",
		});

		let section = journal.toPromptSection();
		expect(section).not.toBeNull();
		expect(section!).toMatch(/\ds ago/);

		journal.clear();

		// 90 seconds ago → "1m ago"
		journal.record({
			timestamp: new Date(now - 90_000).toISOString(),
			type: "sharing",
			sourceAgentName: "agent-90s",
			targetName: "target",
			deltaType: "prompt_complete",
			approved: true,
			reasoningSummary: "test",
		});

		section = journal.toPromptSection();
		expect(section!).toMatch(/1m ago/);

		journal.clear();

		// 3600+ seconds ago → "1h ago"
		journal.record({
			timestamp: new Date(now - 3_660_000).toISOString(),
			type: "sharing",
			sourceAgentName: "agent-1h",
			targetName: "target",
			deltaType: "prompt_complete",
			approved: true,
			reasoningSummary: "test",
		});

		section = journal.toPromptSection();
		expect(section!).toMatch(/1h ago/);

		journal.clear();

		// Future timestamp → "just now"
		journal.record({
			timestamp: new Date(now + 60_000).toISOString(),
			type: "sharing",
			sourceAgentName: "agent-future",
			targetName: "target",
			deltaType: "prompt_complete",
			approved: true,
			reasoningSummary: "test",
		});

		section = journal.toPromptSection();
		expect(section!).toContain("just now");

		journal.clear();

		// Invalid timestamp → "just now"
		journal.record({
			timestamp: "not-a-date",
			type: "sharing",
			sourceAgentName: "agent-invalid",
			targetName: "target",
			deltaType: "prompt_complete",
			approved: true,
			reasoningSummary: "test",
		});

		section = journal.toPromptSection();
		expect(section!).toContain("just now");
	});

	// ── Default config ─────────────────────────────────────────────────

	it("uses default config values when no config provided", () => {
		const journal = new DecisionJournal();

		// Default maxEntries is 15 — add 16 entries
		for (let i = 0; i < 16; i++) {
			journal.record({
				timestamp: new Date().toISOString(),
				type: "sharing",
				sourceAgentName: `agent-${i}`,
				targetName: "target",
				deltaType: "prompt_complete",
				approved: true,
				reasoningSummary: "reason",
			});
		}

		expect(journal.entryCount).toBe(15); // maxEntries default = 15
	});

	it("default maxReasoningLength is 120", () => {
		const journal = new DecisionJournal();

		const reasoning = "X".repeat(200);
		journal.record({
			timestamp: new Date().toISOString(),
			type: "sharing",
			sourceAgentName: "agent",
			targetName: "target",
			deltaType: "prompt_complete",
			approved: true,
			reasoningSummary: reasoning,
		});

		const entries = journal.getAllEntries();
		expect(entries[0]!.reasoningSummary.length).toBe(121); // 120 + "…"
	});

	// ── getAllEntries returns a copy ────────────────────────────────────

	it("getAllEntries() returns a copy (not a reference)", () => {
		const journal = new DecisionJournal();

		journal.record({
			timestamp: new Date().toISOString(),
			type: "sharing",
			sourceAgentName: "agent",
			targetName: "target",
			deltaType: "prompt_complete",
			approved: true,
			reasoningSummary: "reason",
		});

		const entries1 = journal.getAllEntries();
		const entries2 = journal.getAllEntries();

		expect(entries1).not.toBe(entries2); // Different array references
		expect(entries1).toEqual(entries2); // Same content
	});

	// ── toPromptSection with sharing vs notification arrows ────────────

	it("toPromptSection uses correct arrow format for sharing vs notification", () => {
		const journal = new DecisionJournal();

		journal.record({
			timestamp: new Date().toISOString(),
			type: "sharing",
			sourceAgentName: "source-agent",
			targetName: "target-agent",
			deltaType: "prompt_complete",
			approved: true,
			reasoningSummary: "sharing reason",
		});

		journal.record({
			timestamp: new Date().toISOString(),
			type: "notification",
			sourceAgentName: "source-agent",
			targetName: "user",
			deltaType: "agent_error",
			approved: true,
			reasoningSummary: "notification reason",
		});

		const section = journal.toPromptSection()!;

		// Sharing: "source-agent → target-agent"
		expect(section).toContain("source-agent → target-agent");

		// Notification: "source-agent → user notification"
		expect(section).toContain("source-agent → user notification");
	});

	// ── Mixed approved/denied in prompt ────────────────────────────────

	it("toPromptSection shows numbered entries starting from 1", () => {
		const journal = new DecisionJournal({ maxEntriesInPrompt: 3 });

		for (let i = 0; i < 3; i++) {
			journal.record({
				timestamp: new Date().toISOString(),
				type: "sharing",
				sourceAgentName: `agent-${i}`,
				targetName: "target",
				deltaType: "prompt_complete",
				approved: i !== 1,
				reasoningSummary: `reason ${i}`,
			});
		}

		const section = journal.toPromptSection()!;
		expect(section).toMatch(/^1\./);
		expect(section).toContain("2.");
		expect(section).toContain("3.");
	});

	// ── Edge case: maxEntriesInPrompt > maxEntries ─────────────────────

	it("handles maxEntriesInPrompt > actual entries gracefully", () => {
		const journal = new DecisionJournal({
			maxEntries: 10,
			maxEntriesInPrompt: 20,
		});

		journal.record({
			timestamp: new Date().toISOString(),
			type: "sharing",
			sourceAgentName: "agent",
			targetName: "target",
			deltaType: "prompt_complete",
			approved: true,
			reasoningSummary: "reason",
		});

		const section = journal.toPromptSection();
		expect(section).not.toBeNull();
		const data = journal.toTemplateData();
		expect(data).toHaveLength(1);
	});

	// ── countRecentDecisions with empty journal ────────────────────────

	it("countRecentDecisions returns 0 for empty journal", () => {
		const journal = new DecisionJournal();
		expect(journal.countRecentDecisions(60)).toBe(0);
	});

	it("countRecentApprovedForTarget returns 0 for empty journal", () => {
		const journal = new DecisionJournal();
		expect(journal.countRecentApprovedForTarget("user", 60)).toBe(0);
	});

	// ── Multiple record + eviction stress test ─────────────────────────

	it("handles rapid recording with small maxEntries correctly", () => {
		const journal = new DecisionJournal({ maxEntries: 2 });

		for (let i = 0; i < 100; i++) {
			journal.record({
				timestamp: new Date().toISOString(),
				type: "sharing",
				sourceAgentName: `agent-${i}`,
				targetName: "target",
				deltaType: "prompt_complete",
				approved: true,
				reasoningSummary: `reason-${i}`,
			});
		}

		expect(journal.entryCount).toBe(2);
		const entries = journal.getAllEntries();
		expect(entries[0]!.sourceAgentName).toBe("agent-98");
		expect(entries[1]!.sourceAgentName).toBe("agent-99");
	});

	// ── Convenience methods truncate reasoning ─────────────────────────

	it("recordSharingDecision truncates long reasoning", () => {
		const journal = new DecisionJournal({ maxReasoningLength: 10 });

		journal.recordSharingDecision(
			"source",
			"target",
			"prompt_complete",
			true,
			"This is a very long reasoning that should be truncated",
			new Date().toISOString(),
		);

		const entries = journal.getAllEntries();
		expect(entries[0]!.reasoningSummary.length).toBe(11); // 10 + "…"
	});

	it("recordNotificationDecision truncates long reasoning", () => {
		const journal = new DecisionJournal({ maxReasoningLength: 10 });

		journal.recordNotificationDecision(
			"source",
			"agent_error",
			true,
			"This is a very long reasoning that should be truncated",
			new Date().toISOString(),
		);

		const entries = journal.getAllEntries();
		expect(entries[0]!.reasoningSummary.length).toBe(11); // 10 + "…"
	});
});
