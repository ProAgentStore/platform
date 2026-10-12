/**
 * Durable browser takeovers (#1031) — the console's half of `workers/api/src/routes/instances-browser-takeovers.ts`,
 * reading the same rows MCP's browser_takeover_list / _get read and making the same moves as
 * browser_takeover_transition. Pure, so the sentences are tested.
 */
export type TakeoverState = "requested" | "active" | "resumed" | "ended" | "expired";

export interface BrowserTakeover {
	id: string;
	subjectKind: "local_browser_run" | "runtime_task" | "manual";
	subjectId: string;
	state: TakeoverState;
	reason: string;
	mobileAllowed: boolean;
	endReason: string | null;
	expiresAt: string;
	createdAt: string;
	activatedAt: string | null;
	endedAt: string | null;
}

/** `GET …/browser-takeovers` — guarded against the Worker's own declaration in `types.test.ts`. */
export interface BrowserTakeoverListResponse {
	takeovers: BrowserTakeover[];
}

/** `PATCH …/browser-takeovers/:takeoverId` — the console reads only the takeover back. */
export interface BrowserTakeoverTransitionResponse {
	takeover: BrowserTakeover;
}

export const isLive = (t: BrowserTakeover): boolean => t.state === "requested" || t.state === "active";

/** The device the console is on, as the takeover routes take it: the owner's own statement. */
export const deviceKind = (): "mobile" | "desktop" =>
	typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches ? "mobile" : "desktop";

const STATE_WORDS: Record<TakeoverState, string> = {
	requested: "Waiting for you to take over",
	active: "You are taking over",
	resumed: "Handed back to the run",
	ended: "Takeover ended",
	expired: "The takeover request expired",
};

const END_WORDS: Record<string, string> = {
	declined: "you declined it",
	run_finished: "the run finished",
	resumed_at_machine: "it was resumed at the machine",
	expired: "nobody took over in time",
};

/** One takeover as the banner reads it: the state, why, and until when. */
export function takeoverLine(t: BrowserTakeover, now = Date.now()): { text: string; tone: "warn" | "ok" | "muted" } {
	const why = t.reason === "manual" ? "" : ` (${t.reason.replace(/_/g, " ")})`;
	if (isLive(t)) {
		const mins = Math.max(0, Math.round((Date.parse(t.expiresAt) - now) / 60_000));
		return { text: `${STATE_WORDS[t.state]}${why} — the request expires in ${mins} min.`, tone: "warn" };
	}
	const how = t.endReason && END_WORDS[t.endReason] ? `: ${END_WORDS[t.endReason]}` : "";
	return { text: `${STATE_WORDS[t.state]}${how}.`, tone: t.state === "resumed" ? "ok" : "muted" };
}

/** May the remote view be opened from here? The server refuses too; this says why before trying. */
export function remoteViewBlocked(t: BrowserTakeover, device: "mobile" | "desktop"): string | null {
	if (!isLive(t)) return "This takeover is closed.";
	if (device === "mobile" && !t.mobileAllowed) return "Taking over from a phone is off for this agent — take over at the machine, or allow it in Settings → Browser verification.";
	return null;
}
