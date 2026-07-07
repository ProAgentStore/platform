/**
 * Deterministic labeling for a coding session's terminal, so the Chat/Co-pilot stop
 * flip-flopping between "LIVE (captured just now)" and "stale snapshot".
 *
 * The old code collapsed three distinct situations — runner offline, a capture that
 * FAILED while the runner was online, and a genuinely-live-but-idle pane — into one
 * boolean `live`, recomputed per turn from whether that turn's WS round-trip happened
 * to succeed. So the same session oscillated labels across turns, and idle scrollback
 * got stamped "captured just now = current activity".
 *
 * This is a pure function of the signals we ALREADY receive from `/coding/capture`
 * (`pane`, `alive`, `runState`) plus the runner-online check and the last stored
 * snapshot — no new I/O. Keep it pure so every branch is unit-tested.
 */

export type TerminalKind =
	| "runner-offline" // runner not connected — nothing is running
	| "capture-failed" // runner online but the capture request failed this turn (do NOT infer idle/done)
	| "empty-pane" // runner online, capture ok, but the pane is blank right now
	| "live-idle" // runner online, pane has content, session is idle — real current scrollback, but may be OLD output
	| "live-active" // runner online, pane has content, engine is actively working — genuinely live
	| "none"; // no data at all (no live pane, no stored snapshot)

export interface TerminalView {
	kind: TerminalKind;
	/** The text to show the model (a live pane, or the last stored snapshot as historical context). */
	text: string;
	/** For offline/failed, when the stored snapshot was last updated (the session's updatedAt). */
	asOf?: string;
}

export interface TerminalInputs {
	runnerOnline: boolean;
	/** The `/coding/capture` round-trip returned (snap !== null) — distinguishes a failed capture from offline. */
	captureOk: boolean;
	/** snap.pane, whitespace-collapsed + trimmed (already sliced by the caller). */
	pane: string | null;
	/** snap.alive — the agent process is running. */
	alive: boolean | null;
	/** snap.runState — "idle" | "thinking" | "responding". */
	runState: string | null;
	/** lastTerminal() — the last persisted terminal snapshot, for the offline/failed/empty branches. */
	lastSnapshot: string | null;
	/** session.updatedAt — timestamp for a stored snapshot. */
	updatedAt: string | null;
}

/** Resolve the terminal situation deterministically. Priority order matters. */
export function describeTerminal(i: TerminalInputs): TerminalView {
	const snap = (i.lastSnapshot || "").trim();
	// 1. Runner not connected — nothing live at all.
	if (!i.runnerOnline) {
		return { kind: snap ? "runner-offline" : "none", text: snap, asOf: i.updatedAt ?? undefined };
	}
	// 2. Online but the capture round-trip failed — must NOT be read as "idle/done".
	if (!i.captureOk) {
		return { kind: "capture-failed", text: snap, asOf: i.updatedAt ?? undefined };
	}
	const pane = (i.pane || "").trim();
	// 3. Online, capture ok, but nothing on screen.
	if (!pane) {
		return { kind: snap ? "empty-pane" : "none", text: snap, asOf: i.updatedAt ?? undefined };
	}
	// 4/5. Real current pane — distinguish active work from idle scrollback via runState/alive.
	const active = i.runState === "thinking" || i.runState === "responding" || (i.runState !== "idle" && i.alive === true);
	return { kind: active ? "live-active" : "live-idle", text: pane };
}

/** Render one session's terminal line for the chat system prompt. Wording is the
 *  guardrail: an idle pane is explicitly "may be OLD output", a failed capture is
 *  explicitly "do NOT infer idle/done" — so the model can't launder stale text into
 *  a claim about current state. */
export function renderTerminalLine(view: TerminalView): string {
	const t = view.text || "(none captured)";
	switch (view.kind) {
		case "live-active":
			return `  CURRENT terminal (runner online, engine actively running — this is live): ${view.text}`;
		case "live-idle":
			return `  CURRENT terminal contents (runner online, session IDLE — this is the existing on-screen scrollback, which may be OLD output, NOT proof anything just happened): ${view.text}`;
		case "empty-pane":
			return `  Terminal is EMPTY on screen right now (runner online, nothing displayed). Last saved output was: ${t}`;
		case "capture-failed":
			return `  Terminal UNAVAILABLE this turn (runner online but the capture request failed — do NOT infer the session is idle or finished). Last saved snapshot (as of ${view.asOf ?? "unknown"}): ${t}`;
		case "runner-offline":
			return `  Runner OFFLINE — no live terminal. Last saved snapshot (as of ${view.asOf ?? "unknown"}): ${t}`;
		default:
			return "";
	}
}
