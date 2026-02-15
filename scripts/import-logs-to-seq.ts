#!/usr/bin/env bun
/**
 * Import existing NDJSON logs into Seq.
 *
 * Usage:
 *   bun run scripts/import-logs-to-seq.ts [file] [seq-url]
 *
 * Arguments:
 *   file     Path to the NDJSON log file (default: ./logs/agent.ndjson)
 *   seq-url  Seq ingestion URL (default: http://localhost:5341)
 *
 * Examples:
 *   bun run scripts/import-logs-to-seq.ts
 *   bun run scripts/import-logs-to-seq.ts ./logs/agent.ndjson http://localhost:5341
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Pino level → Seq/CLEF level mapping ──────────────────────────────────
const PINO_TO_SEQ_LEVEL: Record<number, string> = {
  10: "Verbose", // trace
  20: "Debug", // debug
  30: "Information", // info
  40: "Warning", // warn
  50: "Error", // error
  60: "Fatal", // fatal
};

function pinoToClef(line: string): string | null {
  try {
    const log = JSON.parse(line);

    // Build a CLEF (Compact Log Event Format) event that Seq understands
    const clef: Record<string, unknown> = {
      "@t": log.time ? new Date(log.time).toISOString() : new Date().toISOString(),
      "@mt": log.msg ?? "",
      "@l": PINO_TO_SEQ_LEVEL[log.level] ?? "Information",
    };

    // Forward all other properties as-is (excluding pino internals)
    const skip = new Set(["level", "time", "msg", "pid", "hostname", "v"]);
    for (const [key, value] of Object.entries(log)) {
      if (!skip.has(key)) {
        clef[key] = value;
      }
    }

    return JSON.stringify(clef);
  } catch {
    return null;
  }
}

async function main() {
  const filePath = resolve(process.argv[2] ?? "./logs/agent.ndjson");
  const seqUrl = process.argv[3] ?? process.env.SEQ_URL ?? "http://localhost:5341";
  const seqUiUrl = process.env.SEQ_UI_URL ?? "http://localhost:8082";
  const ingestUrl = `${seqUrl}/api/events/raw?clef`;

  console.log(`📂 Reading logs from: ${filePath}`);
  console.log(`🎯 Seq server:        ${seqUrl}`);
  console.log(`🌐 Seq UI:            ${seqUiUrl}\n`);

  // Read and parse the NDJSON file
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch (err) {
    console.error(`❌ Could not read file: ${filePath}`);
    console.error(`   Make sure the file exists and the path is correct.`);
    process.exit(1);
  }

  const lines = content.trim().split("\n").filter(Boolean);
  console.log(`📊 Found ${lines.length} log entries\n`);

  // Convert each line to CLEF format
  const clefEvents = lines.map(pinoToClef).filter(Boolean) as string[];

  if (clefEvents.length === 0) {
    console.log("⚠️  No valid log entries to import.");
    process.exit(0);
  }

  // Send to Seq in a single batch (CLEF newline-delimited)
  const body = clefEvents.join("\n");

  try {
    const response = await fetch(ingestUrl, {
      method: "POST",
      headers: { "Content-Type": "application/vnd.serilog.clef" },
      body,
    });

    if (response.ok) {
      console.log(`✅ Successfully imported ${clefEvents.length} log entries into Seq!`);
      console.log(`\n🔗 Open ${seqUiUrl} to explore your logs.`);
    } else {
      const text = await response.text();
      console.error(`❌ Seq responded with ${response.status}: ${text}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`❌ Could not connect to Seq at ${seqUrl}`);
    console.error(`   Make sure Seq is running: docker compose up -d`);
    console.error(`   Error: ${(err as Error).message}`);
    process.exit(1);
  }
}

main();
