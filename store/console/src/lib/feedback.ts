import type { Message } from "./types";

/**
 * Turning "this message is wrong" into a record someone can act on (#514).
 *
 * The field list is not a guess. It is what actually turned out to be load-bearing when #503,
 * #504, #505 and #510–#512 were filed by hand from transcripts and traces:
 *
 *   – the message complained about, verbatim              → `targetText`
 *   – **the turn before it**, because half those issues   → `promptText`
 *     were about a claim that did not match the question
 *   – the trace id, which reaches the tool calls          → `traceId`
 *   – for a voice turn, the audio and what the            → `context.audioKey` / `.dictation`
 *     recognizer heard
 *
 * Everything else is decoration. Building it is pure, so the console's obligation — grab the
 * neighbouring turn, not just the one that was clicked — is a tested property rather than
 * something a component happens to do.
 */

export interface FeedbackCapture {
	instanceId: string;
	body: string;
	surface: "chat" | "coding" | "board" | "apply" | "other";
	sentiment?: "bad" | "good";
	traceId?: string;
	messageId?: string;
	sessionId?: string;
	timelineSeq?: number;
	targetRole?: string;
	targetText?: string;
	targetAt?: string;
	promptText?: string;
	context?: Record<string, unknown>;
}

/** One stored row, as `/v1/feedback` returns it. */
export interface FeedbackRow {
	id: string;
	ts: number;
	created_at: string;
	instance_id: string;
	author: string;
	surface: string;
	sentiment: string | null;
	body: string;
	trace_id: string | null;
	message_id: string | null;
	session_id: string | null;
	timeline_seq: number | null;
	target_role: string | null;
	target_text: string | null;
	target_at: string | null;
	prompt_text: string | null;
	context: string | null;
	status: string;
	issue_url: string | null;
	updated_at: string;
}

export const FEEDBACK_STATUS_LABEL: Record<string, string> = {
	open: "Open",
	triaged: "Triaged",
	filed: "Filed",
	dismissed: "Dismissed",
};

/** The user turn that PROVOKED `index`, or the one before it when `index` is itself a user turn. */
function promptTurnFor(messages: Message[], index: number): Message | undefined {
	const from = messages[index]?.role === "user" ? index - 1 : index;
	for (let i = from; i >= 0; i--) {
		if (messages[i]?.role === "user" && i !== index) return messages[i];
	}
	return undefined;
}

/**
 * Build the capture for the message at `index`.
 *
 * Voice provenance is taken from the target when the target has it, and otherwise from the turn
 * that prompted it — because on an assistant message the mishearing is one turn earlier, which is
 * exactly the shape of #510–#512 (`content: "…how many agents do you have"` vs
 * `dictation: "…how many ages does Kevin total"`). `voiceFrom` records which, so a reader is never
 * left guessing whose audio they are about to play.
 */
export function buildCapture(opts: {
	instanceId: string;
	messages: Message[];
	index: number;
	body: string;
	agentSlug?: string;
	model?: string;
	sentiment?: "bad" | "good";
}): FeedbackCapture {
	const target = opts.messages[opts.index];
	const prompt = promptTurnFor(opts.messages, opts.index);
	const voice = target?.audioKey || target?.dictation ? target : prompt?.audioKey || prompt?.dictation ? prompt : undefined;
	const context: Record<string, unknown> = {};
	if (opts.agentSlug) context.agentSlug = opts.agentSlug;
	if (opts.model) context.model = opts.model;
	if (voice?.audioKey) context.audioKey = voice.audioKey;
	if (voice?.dictation) context.dictation = voice.dictation;
	if (voice) context.voiceFrom = voice === target ? "target" : "prompt";
	return {
		instanceId: opts.instanceId,
		body: opts.body.trim(),
		surface: "chat",
		...(opts.sentiment ? { sentiment: opts.sentiment } : {}),
		// A message written before #514 step 1 has no trace id, and one written over the WebSocket
		// path never will. That is a degraded record, not a broken one — the snapshot below still
		// carries the evidence — so it is simply omitted rather than faked.
		...(target?.traceId ? { traceId: target.traceId } : {}),
		...(target?.id ? { messageId: target.id } : {}),
		...(target?.role ? { targetRole: target.role } : {}),
		...(target?.content ? { targetText: target.content } : {}),
		...(target?.createdAt ? { targetAt: target.createdAt } : {}),
		...(prompt?.content ? { promptText: prompt.content } : {}),
		...(Object.keys(context).length ? { context } : {}),
	};
}

/** A short, single-line preview of a stored row's target, for a list row. */
export function previewOf(text: string | null, max = 140): string {
	if (!text) return "";
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
