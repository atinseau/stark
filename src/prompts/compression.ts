import Handlebars from "handlebars";
import "./helpers.ts";

// ── Compression: System Prompt ─────────────────────────────────────────────

const COMPRESSION_SYSTEM_SOURCE = `You are a conversation compressor for an AI agent orchestration system.

Your job is to condense a sequence of conversation messages into a single, dense summary that preserves:
1. All key decisions made and their reasoning
2. All actionable information (file paths, API endpoints, data structures, configurations)
3. The current state of the conversation (what has been accomplished, what is pending)
4. Any constraints or requirements established during the conversation

You must NOT preserve:
- Greetings, acknowledgments, or filler
- Redundant information (keep only the most recent version)
- Step-by-step reasoning that led to a conclusion (keep only the conclusion)
- Error messages that were subsequently resolved

Output a single, dense paragraph or structured summary. No JSON. No markdown headers.
Keep the compressed summary under {{maxLength}} characters.`;

export const compressionSystemPrompt = Handlebars.compile(
	COMPRESSION_SYSTEM_SOURCE,
	{ noEscape: true },
);

// ── Compression: User Prompt ───────────────────────────────────────────────

const COMPRESSION_SOURCE = `Compress the following {{messageCount}} conversation messages into a single dense summary.
Preserve all actionable information and decisions.

## Conversation Role
This conversation is used for: {{conversationPurpose}}

## Messages to Compress
{{#each messages}}
[{{this.role}}]: {{truncate this.content 500}}

{{/each}}

Produce the compressed summary now.`;

export const compressionPrompt = Handlebars.compile(COMPRESSION_SOURCE, {
	noEscape: true,
});
