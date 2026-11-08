/**
 * The one line a Settings card keeps for a panel that moved to Activity → History (#1590).
 * Pattern `<state> · <Action>`; it never asserts a state before its data loaded.
 */
export type HistoryLineState = { status: "loading" } | { status: "failed" } | { status: "ready"; text: string | null; tone: "warn" | "bad" | "muted" };

export interface HistoryLineView {
	text: string;
	tone: "warn" | "bad" | "muted";
	/** False for `Checking…`: nothing to open yet. */
	link: boolean;
}

export const VIEW_IN_ACTIVITY = "View in Activity";

/** Null when the card has nothing to say (the "otherwise no line" cases). */
export function historyLineView(state: HistoryLineState): HistoryLineView | null {
	if (state.status === "loading") return { text: "Checking…", tone: "muted", link: false };
	if (state.status === "failed") return { text: "Couldn't check", tone: "muted", link: true };
	return state.text === null ? null : { text: state.text, tone: state.tone, link: true };
}

const waiting = (n: number): HistoryLineState => ({ status: "ready", text: `${n} waiting for you`, tone: "warn" });

/** Automation, loop runs: always a line once loaded. */
export const loopRunsLine = (needsInput: number): HistoryLineState => (needsInput > 0 ? waiting(needsInput) : { status: "ready", text: "No runs waiting", tone: "muted" });
/** Browser, takeovers: a line only while one is live. */
export const takeoversLine = (live: number): HistoryLineState => (live > 0 ? waiting(live) : { status: "ready", text: null, tone: "muted" });
/** Automation, deliveries: a line only while something is undelivered. */
export const deliveriesLine = (undelivered: number): HistoryLineState => (undelivered > 0 ? { status: "ready", text: `${undelivered} undelivered`, tone: "bad" } : { status: "ready", text: null, tone: "muted" });
/** Browser, last launch: a line only when the saved setting differs from what last launched. */
export const launchLine = (differs: boolean): HistoryLineState => (differs ? { status: "ready", text: "Differs from last launch", tone: "muted" } : { status: "ready", text: null, tone: "muted" });
