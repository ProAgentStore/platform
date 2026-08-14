/**
 * What the server publishes ABOUT a tool, as opposed to what the tool does.
 *
 * Everything here is advisory metadata read by the calling host and model. None of it is a
 * check: `safety.ts` remains the only thing that decides whether a call runs.
 */

/**
 * Sent once, in the `initialize` response, and read by the host alongside every tool's own
 * description. Until #561 the second `McpServer` constructor argument was absent, so this
 * server said NOTHING about itself: 135 tools with no ordering between them, and no way for
 * a model to learn that almost every tool needs an instance id it can only get from
 * `my_instances`.
 *
 * OpenAI's guidance: "Use server instructions for guidance that applies across tools, such
 * as required tool sequences … Keep the most important details in the first 512 characters."
 * So the sequence comes first and the safety vocabulary second — a caller that reads no
 * further than the cut still learns the order it has to call things in.
 */
export const SERVER_INSTRUCTIONS = [
	"ProAgentStore hosts server-side AI agents. Almost every tool acts on ONE agent instance, so start by getting an id: my_instances lists the ones the connected user already runs; list_agents is the public catalogue and subscribe_agent creates an instance from it.",
	"To debug what an agent did, call agent_trace first (chat turns, steps and errors on one timeline), then instance_messages or list_errors for detail. usage_summary reports spend.",
	"Tool annotations are accurate: readOnlyHint true means the tool only reads. A tool that changes state takes dry_run — call it that way first to see what would happen. The most consequential tools also require an exact confirm string and a connection holding the destructive scope; those refusals are real and cannot be argued past.",
].join(" ");

/** Words that read wrong in sentence case — expanded rather than title-cased. */
const ACRONYMS: Record<string, string> = {
	ai: "AI",
	api: "API",
	cli: "CLI",
	kb: "KB",
	mcp: "MCP",
	sdk: "SDK",
	url: "URL",
};

/**
 * A human-readable title, DERIVED from the tool's own name rather than written down
 * per tool — `coding_session_capture` → "Coding session capture".
 *
 * OpenAI's plugin guidance asks each tool for "an action-oriented name and human-readable
 * title", and the title is one of the fields its review scan imports. A hand-written title
 * per tool would be 135 strings that no test could hold to the name they belong to; derived,
 * a renamed tool retitles itself.
 */
export function titleFor(name: string): string {
	const words = name.split("_").filter(Boolean);
	if (words.length === 0) return name;
	return words
		.map((word, index) => {
			const acronym = ACRONYMS[word];
			if (acronym) return acronym;
			return index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word;
		})
		.join(" ");
}
