import Handlebars from "handlebars";

// ── Handlebars Helpers ─────────────────────────────────────────────────────

Handlebars.registerHelper("json", (context: unknown) => {
	return new Handlebars.SafeString(JSON.stringify(context, null, 2));
});

Handlebars.registerHelper("eq", (a: unknown, b: unknown) => a === b);

Handlebars.registerHelper("gt", (a: number, b: number) => a > b);

Handlebars.registerHelper("truncate", (text: string, length: number) => {
	if (typeof text !== "string") return "";
	if (text.length <= length) return text;
	return `${text.slice(0, length)}…`;
});
