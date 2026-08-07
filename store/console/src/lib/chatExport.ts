/**
 * "Copy JSON" — the transcript, as a thing you can paste into a bug report.
 *
 * The only real content in it is one regex, and a regex nobody can see is a regex nobody can
 * check. Every turn the agent runs may carry a `[Context: …]` preamble the server prepends —
 * retrieved documents, settings, the attached-repos block — which is machinery, not conversation,
 * and is often longer than the message. It is stripped here.
 *
 * Two properties of that strip are load-bearing and neither is visible at the call site:
 *
 *   ANCHORED. It only removes a preamble at the START of a message. A message that merely
 *   QUOTES `[Context: …]` (asking the agent about its own prompt is a normal thing to do) keeps
 *   its text.
 *
 *   NON-GREEDY. `[\s\S]*?` stops at the first `]`. A greedy version, or one that took the `m`
 *   flag so `^` matched every line, would eat everything up to the last bracket in the message —
 *   silently, and only on the transcripts long enough for anyone to be exporting.
 */
import type { Message } from "./types";

/** One turn, as it appears in the exported JSON. */
export interface ExportedMessage {
	role: string;
	content: string;
	timestamp?: string;
}

export interface ChatExport {
	instanceId: string;
	count: number;
	messages: ExportedMessage[];
}

/** Drop a server-prepended `[Context: …]` preamble, if the message opens with one. */
export function stripContextPreamble(content: string): string {
	return (content || "").replace(/^\[Context:[\s\S]*?\]\s*\n*/i, "");
}

/** The clipboard payload for a whole thread. */
export function chatExportPayload(instanceId: string, messages: Message[]): ChatExport {
	const msgs = (messages || []).map((m) => ({
		role: m.role,
		content: stripContextPreamble(m.content),
		timestamp: m.createdAt,
	}));
	return { instanceId, count: msgs.length, messages: msgs };
}
