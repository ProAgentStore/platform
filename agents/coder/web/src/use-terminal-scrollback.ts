// The Terminal view's history: what it holds, how it pages, and what it says when empty (#432).
//
// Lifted out of `CodingTab.tsx` rather than added to it. Everything here is one cohesive job —
// the persisted snapshots, the cursor that walks back through them, the stitch that joins them,
// and the sentence shown when there is nothing — and CodingTab is a 1300-line component under a
// size ratchet (#302) that is already the biggest file in the coder UI. The decisions are pure
// and live in ./terminal-history; this is the React state around them.

import { useCallback, useRef, useState, type RefObject } from "react";
import { api } from "@proagentstore/sdk/client";
import { readTerminalCache, writeTerminalCache } from "./terminal-cache";
import { appendSnapshot, stitchSnapshots, type TerminalPage, terminalPlaceholder } from "./terminal-history";

export interface CaptureSnapshot {
	pane?: string;
	runState?: string;
	alive?: boolean;
	runnerConnected?: boolean;
	/** How the engine's last turn ended (#545). Absent on a runner older than CLI 0.4.51. */
	lastTurn?: { verdict?: string };
}

export function useTerminalScrollback(instanceId: string, termRef: RefObject<HTMLPreElement | null>) {
	/** What the pane renders: the stitched history, plus the live pane, or a placeholder. */
	const [text, setText] = useState("");
	/** The stitched PERSISTED history alone. `stale` in the view means this is all there is. */
	const [saved, setSaved] = useState("");
	const [live, setLive] = useState(false);
	/** Cursor for the next page back, and whether one exists. */
	const [oldestSeq, setOldestSeq] = useState<number | null>(null);
	const [hasOlder, setHasOlder] = useState(false);
	const [loadingOlder, setLoadingOlder] = useState(false);
	/**
	 * True from the moment a session opens until its snapshots arrive.
	 *
	 * This state used to be indistinguishable from "there is no output": `openTerminal` cleared
	 * the fallback and THEN awaited two round-trips, and the 1.5s poll in between resolved
	 * `live || saved || "(waiting for output...)"` to the placeholder. So the empty message
	 * flashed on EVERY session open, including sessions with hours of saved output.
	 */
	const [loadingHistory, setLoadingHistory] = useState(false);

	const textRef = useRef(text);
	textRef.current = text;
	const savedRef = useRef(saved);
	savedRef.current = saved;
	const loadingRef = useRef(loadingHistory);
	loadingRef.current = loadingHistory;
	/** Which session the state currently belongs to — reopening the SAME one keeps it. */
	const sessionRef = useRef<string | null>(null);
	/**
	 * Where the rendered history reaches, in `seq`, as refs rather than state (#550).
	 *
	 * `open` needs all three — the newest row it holds (the `after=` cursor), and the two that
	 * describe the far end (what `before=` would ask for, and whether the control shows) — and
	 * reading them from state would put them in the callback's deps, rebuilding `open` on every
	 * page load and with it the `openTerminal` identity the auto-open effect keys on.
	 */
	const newestSeqRef = useRef<number | null>(null);
	const oldestSeqRef = useRef<number | null>(null);
	const hasOlderRef = useRef(false);

	const page = useCallback(
		async (sessionId: string, cursor?: { before?: number; after?: number }) => {
			const q = cursor?.before !== undefined ? `&before=${cursor.before}` : cursor?.after !== undefined ? `&after=${cursor.after}` : "";
			return await api<TerminalPage>(`/v1/instances/${instanceId}/coding/sessions/${sessionId}/timeline?terminal=1${q}`);
		},
		[instanceId],
	);

	/**
	 * A session is being opened: paint what we already have, then ask only for what is new.
	 *
	 * The previous fallback is kept only when the same session is reopened. Keeping it across a
	 * switch would show one repo's output under another repo's header, which is worse than the
	 * flash it would remove. A DIFFERENT session therefore starts from its OWN cached page or from
	 * nothing — never from what is on screen.
	 *
	 * The cache read is synchronous and happens before the first `await`, which is the whole point:
	 * the pane paints its history in the same frame the session opens (#550). Then the fetch goes
	 * out anyway, as a tail — `after=` the newest row we hold — so anything appended while the tab
	 * was closed still lands (#550 AC 2), and a page the server says does not join what we hold
	 * (`tail:false`) replaces it wholesale rather than being stitched over a gap.
	 */
	const open = useCallback(
		async (sessionId: string) => {
			const reopening = sessionRef.current === sessionId;
			sessionRef.current = sessionId;
			setLoadingHistory(true);
			loadingRef.current = true;
			setLive(false);
			if (!reopening) {
				const cached = readTerminalCache(instanceId, sessionId);
				setSaved(cached?.text ?? "");
				savedRef.current = cached?.text ?? "";
				setText(cached?.text || terminalPlaceholder({ loadingHistory: true }));
				newestSeqRef.current = cached?.newestSeq ?? null;
				oldestSeqRef.current = cached?.oldestSeq ?? null;
				hasOlderRef.current = cached?.hasOlder ?? false;
				setOldestSeq(oldestSeqRef.current);
				setHasOlder(hasOlderRef.current);
			}
			try {
				const from = newestSeqRef.current;
				const p = await page(sessionId, from === null ? undefined : { after: from });
				const stitched = stitchSnapshots(p.terminal || []);
				if (p.tail) {
					// A delta. It EXTENDS what is on screen, and says nothing about how far back
					// that reaches, so the "load older" cursor is left exactly as it was.
					if (stitched) {
						const merged = appendSnapshot(savedRef.current, stitched);
						setSaved(merged);
						savedRef.current = merged;
						setText(merged);
					}
					newestSeqRef.current = p.newestSeq ?? from;
				} else {
					oldestSeqRef.current = p.oldestSeq ?? null;
					hasOlderRef.current = !!p.hasMore;
					setOldestSeq(oldestSeqRef.current);
					setHasOlder(hasOlderRef.current);
					newestSeqRef.current = p.newestSeq ?? null;
					if (stitched) {
						setSaved(stitched);
						savedRef.current = stitched;
						setText(stitched);
					}
				}
				writeTerminalCache(instanceId, sessionId, {
					text: savedRef.current,
					newestSeq: newestSeqRef.current,
					oldestSeq: oldestSeqRef.current,
					hasOlder: hasOlderRef.current,
				});
			} catch (e) {
				console.error("[coding] terminal history load failed:", e);
			} finally {
				setLoadingHistory(false);
				loadingRef.current = false;
			}
		},
		[instanceId, page],
	);

	/**
	 * Walk one page further back and PREPEND it, without yanking the view to the bottom.
	 *
	 * Deliberately does NOT write the cache (#550). What it produces is a scrollback, not a page:
	 * it grows with every click, and the cache caps one entry — so caching it would mean trimming
	 * the head, which leaves `oldestSeq` pointing past a hole and makes the next "load older"
	 * prepend a page that does not join what is on screen. The cache stays what `open` stored.
	 */
	const loadOlder = useCallback(
		async (sessionId: string) => {
			if (oldestSeq === null || loadingOlder) return;
			setLoadingOlder(true);
			try {
				const p = await page(sessionId, { before: oldestSeq });
				const older = stitchSnapshots(p.terminal || []);
				if (older) {
					setSaved((prev) => appendSnapshot(older, prev));
					setText((prev) => appendSnapshot(older, prev));
				}
				oldestSeqRef.current = p.oldestSeq ?? oldestSeq;
				hasOlderRef.current = !!p.hasMore;
				setOldestSeq(oldestSeqRef.current);
				setHasOlder(hasOlderRef.current);
			} catch (e) {
				console.error("[coding] load older terminal failed:", e);
			} finally {
				setLoadingOlder(false);
			}
		},
		[page, oldestSeq, loadingOlder],
	);

	/**
	 * Fold one `/capture` reply into the pane.
	 *
	 * The live pane overlaps the stored history almost entirely — it is the same growing
	 * transcript — so it is STITCHED on rather than concatenated or substituted. Substituting was
	 * the old behaviour and is why the terminal could only ever show one pane's worth.
	 */
	const applyCapture = useCallback(
		(snap: CaptureSnapshot) => {
			const pane = (snap.pane || "").trim() ? (snap.pane as string) : "";
			setLive(!!pane);
			const next =
				appendSnapshot(savedRef.current, pane) ||
				terminalPlaceholder({
					runnerConnected: snap.runnerConnected,
					alive: snap.alive,
					runState: snap.runState,
					loadingHistory: loadingRef.current,
					// A turn that ran, produced nothing and refused is a FIFTH cause of an empty
					// pane, and the only one where "send the engine an instruction" is the wrong
					// advice — one was sent (#545).
					lastTurnFailed: snap.lastTurn?.verdict === "failed",
				});
			if (next === textRef.current) return;
			// Never redraw under a live text selection — the user is copying something.
			const sel = window.getSelection();
			if (sel && sel.toString().length > 0 && termRef.current?.contains(sel.anchorNode)) return;
			setText(next);
		},
		[termRef],
	);

	return { text, setText, saved, live, hasOlder, loadingOlder, loadOlder, open, applyCapture };
}
