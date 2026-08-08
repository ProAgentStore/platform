// The Terminal view's history: what it holds, how it pages, and what it says when empty (#432).
//
// Lifted out of `CodingTab.tsx` rather than added to it. Everything here is one cohesive job —
// the persisted snapshots, the cursor that walks back through them, the stitch that joins them,
// and the sentence shown when there is nothing — and CodingTab is a 1300-line component under a
// size ratchet (#302) that is already the biggest file in the coder UI. The decisions are pure
// and live in ./terminal-history; this is the React state around them.

import { useCallback, useRef, useState, type RefObject } from "react";
import { api } from "@proagentstore/sdk/client";
import { appendSnapshot, stitchSnapshots, type TerminalPage, terminalPlaceholder } from "./terminal-history";

export interface CaptureSnapshot {
	pane?: string;
	runState?: string;
	alive?: boolean;
	runnerConnected?: boolean;
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

	const page = useCallback(
		async (sessionId: string, before?: number) => {
			const q = before === undefined ? "" : `&before=${before}`;
			return await api<TerminalPage>(`/v1/instances/${instanceId}/coding/sessions/${sessionId}/timeline?terminal=1${q}`);
		},
		[instanceId],
	);

	/**
	 * A session is being opened: reset if it is a DIFFERENT one, then load the newest page.
	 *
	 * The previous fallback is kept only when the same session is reopened. Keeping it across a
	 * switch would show one repo's output under another repo's header, which is worse than the
	 * flash it would remove.
	 */
	const open = useCallback(
		async (sessionId: string) => {
			const reopening = sessionRef.current === sessionId;
			sessionRef.current = sessionId;
			setLoadingHistory(true);
			loadingRef.current = true;
			setLive(false);
			if (!reopening) {
				setSaved("");
				savedRef.current = "";
				setText(terminalPlaceholder({ loadingHistory: true }));
			}
			try {
				const p = await page(sessionId);
				const stitched = stitchSnapshots(p.terminal || []);
				setOldestSeq(p.oldestSeq ?? null);
				setHasOlder(!!p.hasMore);
				if (stitched) {
					setSaved(stitched);
					savedRef.current = stitched;
					setText(stitched);
				}
			} catch (e) {
				console.error("[coding] terminal history load failed:", e);
			} finally {
				setLoadingHistory(false);
				loadingRef.current = false;
			}
		},
		[page],
	);

	/** Walk one page further back and PREPEND it, without yanking the view to the bottom. */
	const loadOlder = useCallback(
		async (sessionId: string) => {
			if (oldestSeq === null || loadingOlder) return;
			setLoadingOlder(true);
			try {
				const p = await page(sessionId, oldestSeq);
				const older = stitchSnapshots(p.terminal || []);
				if (older) {
					setSaved((prev) => appendSnapshot(older, prev));
					setText((prev) => appendSnapshot(older, prev));
				}
				setOldestSeq(p.oldestSeq ?? oldestSeq);
				setHasOlder(!!p.hasMore);
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
				terminalPlaceholder({ runnerConnected: snap.runnerConnected, alive: snap.alive, runState: snap.runState, loadingHistory: loadingRef.current });
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
