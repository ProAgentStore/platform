// The measured state of a silent provider stream, and the per-call stream deadlines (#907).
// Its own module so the controller recovery and the failure recorder share one definition without
// growing `user-ai.ts`.

/** A silent stream, measured at the moment its deadline fired (#907). */
export interface StreamPhase {
	/** Had the model produced content (a content block), or only connection framing (`message_start`, `ping`)? */
	contentStarted: boolean;
	eventsSeen: number;
	lastEventType: string | null;
	/** How long the stream had been silent when the deadline fired. */
	silentForMs: number;
	/** How long since the request began. */
	elapsedMs: number;
}

/** Per-call stream deadlines (#907): the controllers pass the owner's validated settings; absent keeps the defaults. */
export interface StreamDeadlines {
	/** Until the first CONTENT event. Framing frames keep the stream alive but never end this phase. */
	preContentMs?: number;
	/** Silence allowed between chunks once content has begun. */
	silenceMs?: number;
	/** Wall-clock cap for this one request, never above `AI_TOTAL_TIMEOUT_MS`. */
	totalMs?: number;
	/** Which attempt this is under the controller recovery policy — recorded on the usage row (#1040). */
	attempt?: number;
}

/** The measured phase as a message suffix (#907) — parsed back by `streamPhaseFromMessage`. */
export function streamPhaseSuffix(p: StreamPhase): string {
	return ` [stream: phase=${p.contentStarted ? "mid-reply" : "pre-content"} events=${p.eventsSeen} last=${p.lastEventType ?? "none"} silent=${Math.round(p.silentForMs / 1000)}s elapsed=${Math.round(p.elapsedMs / 1000)}s]`;
}

/** Recover a measured phase from an error that crossed a step boundary with only its message (#907). */
export function streamPhaseFromMessage(message: string): StreamPhase | null {
	const m = /\[stream: phase=(pre-content|mid-reply) events=(\d+) last=([\w-]+) silent=(\d+)s elapsed=(\d+)s\]/.exec(message);
	if (!m) return null;
	return { contentStarted: m[1] === "mid-reply", eventsSeen: Number(m[2]), lastEventType: m[3] === "none" ? null : m[3], silentForMs: Number(m[4]) * 1000, elapsedMs: Number(m[5]) * 1000 };
}
