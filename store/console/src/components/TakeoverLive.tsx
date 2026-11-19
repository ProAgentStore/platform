import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import { useModalLock, useTieredPolling } from "@proagentstore/sdk/hooks";
import RemoteBrowser, { type RemoteFrame } from "./RemoteBrowser";
import { deviceKind } from "../lib/browserTakeovers";

/**
 * Live remote control of the agent's browser — which runs on a REMOTE machine
 * (the box running `pags up`), so you can't just alt-tab to it. Polls
 * /takeover/:taskId/frame for JPEG frames and relays your mouse + keyboard to
 * /takeover/:taskId/input (CDP Input on the runner). Coordinates map into the
 * frame's CSS-viewport space (width/height from the frame response), so clicks
 * land precisely regardless of how the frame is scaled in the browser.
 */
export default function TakeoverLive({ base, kind, onResume, onClose, withEnd = true }: { base: string; kind: string; onResume: () => void; onClose: () => void; withEnd?: boolean }) {
	// `base` is the route prefix that serves `/frame`, `/input` and `/end` for this subject: a runner
	// task's `/v1/instances/:id/takeover/:taskId`, or a paused research run's
	// `/v1/instances/:id/local-browser/runs/:runId` (#1673, which has no `/end`: `withEnd={false}`).
	const [frame, setFrame] = useState<RemoteFrame | null>(null);
	const [connErr, setConnErr] = useState("");
	// A failed End, kept separate from `connErr`: that one only renders in place of a missing
	// frame, and an End typically fails while the frame is arriving perfectly well.
	const [endErr, setEndErr] = useState("");

	const poll = useCallback(async () => {
		try {
			const f = await api<RemoteFrame>(`${base}/frame?device=${deviceKind()}`);
			if (f?.frame && f.frame.length > 30) { setFrame(f); setConnErr(""); }
			else setConnErr("The runner returned an empty frame (no live page to capture).");
		} catch (e) { setConnErr(e instanceof Error ? e.message : String(e)); }
	}, [base]);

	useEffect(() => { poll(); }, [poll]);
	// ~2 fps; shares the high-rate takeover bucket. The highest-frequency poll in the product,
	// and the only one whose payload is a JPEG of a remote screen (#272).
	//
	// It is NOT a mechanical conversion, because it has no idle tier to fall back to: this
	// component only exists while the takeover overlay is open, and a remote screen at 1 fps is
	// not a cheaper version of the feature, it is a broken one. So the two tiers are the same
	// 500ms and the whole decision is the hidden one.
	//
	// Hidden it stops — even mid-takeover, which is exactly the state the ticket flags as real:
	// the user tabs away BECAUSE the takeover asked them to do something elsewhere (read the
	// verification email, find the code). That is 120 frames a minute of a screen nobody can
	// see, relayed off their own laptop. Nothing is lost by stopping, because nothing here
	// advances off the frame poll — input is user-driven (and a hidden tab has no user input),
	// the run's own status stays live on the page's separate `load` poll, and the resume that
	// ends a takeover is decided server-side. The catch-up fetch means the first thing they see
	// on returning is a fresh frame, not the stale one they left.
	useTieredPolling(poll, { activeMs: 500, passiveMs: 500 }, false);
	// Full-screen overlay: freeze the page's real scroll owners while open (RemoteBrowser captures the keyboard).
	const dialogRef = useRef<HTMLDivElement>(null);
	useModalLock(dialogRef, { focus: false });

	/**
	 * IGNORABLE (#291), and this is the clearest case in the console.
	 *
	 * These are individual remote-input events — a mouse move every 90ms, a keystroke, a wheel
	 * tick — and the ~2fps frame poll IS the feedback: a click that did not land is visible as a
	 * page that did not change, immediately and without being told. An error state per event would
	 * be both unreadable at this rate and less informative than the screen the user is already
	 * watching. `endTakeover` above is the opposite case and is handled there, because ending is
	 * the one action here whose result the frame cannot show.
	 */
	const send = useCallback((body: Record<string, unknown>) =>
		api(`${base}/input?device=${deviceKind()}`, { method: "POST", body: JSON.stringify(body) }).catch(() => {}), [base]);

	/**
	 * End the takeover — the only control here whose failure is not self-evident on the next frame.
	 *
	 * It used to `.catch(() => {})` and then `onClose()` unconditionally (#291), so a failed End
	 * looked identical to a successful one: the overlay went away. But ending a takeover is what
	 * hands control back, and the run is PAUSED waiting for exactly that — so the swallow left the
	 * agent's browser still in takeover, the run still blocked, and the person who was going to
	 * unblock it now looking at a screen that says they already did. Nothing else would tell them.
	 *
	 * So the overlay stays open on failure. It is the only place the End button exists, and closing
	 * over an error would remove the retry along with the message.
	 */
	const endTakeover = async () => {
		setEndErr("");
		try {
			await api(`${base}/end`, { method: "POST" });
			onClose();
		} catch (e) {
			setEndErr(`Couldn't end the takeover — the agent still has the browser. ${e instanceof Error ? e.message : String(e)}`);
		}
	};

	// Full-screen overlay: the takeover's own bar, then the remote page as a browser (#1105).
	return (
		<div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Live remote browser control" className="fixed inset-0 z-[100] bg-black flex flex-col">
			<div className="flex items-center gap-3 px-3 sm:px-4 py-2 bg-panel border-b border-line shrink-0">
				<span className="font-bold text-ink text-sm">{kind === "captcha" ? "🔐 Live remote control — solve the verification" : "🖥 Live remote control"}</span>
				<span className="text-xs text-muted-soft hidden md:inline">Click &amp; type here — sent live to the agent's browser (~2 fps).</span>
				<div className="ml-auto flex items-center gap-2">
					<button type="button" onClick={onResume} className="px-4 py-1.5 rounded-lg bg-success-soft text-success font-bold text-sm">Resume — done</button>
					{withEnd && <button type="button" onClick={endTakeover} className="px-3 py-1.5 rounded-lg bg-danger-soft text-danger text-sm font-semibold">End</button>}
					<button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg bg-panel border border-line text-muted text-sm hover:text-ink">Close ✕</button>
				</div>
			</div>
			<RemoteBrowser
				frame={frame}
				notices={endErr && (
					<div data-testid="takeover-end-error" className="shrink-0 px-3 sm:px-4 py-2 bg-danger-soft border-b border-danger-line text-danger text-xs font-semibold break-words">
						{endErr}
					</div>
				)}
				alt="Live agent browser"
				send={send}
				refresh={poll}
				onEscape={onClose}
				entryNote="it goes only to the page shown below."
				defaultImmersive={deviceKind() === "mobile"}
				placeholder={connErr ? (
					<>
						<div className="font-semibold text-danger mb-1">Live view error</div>
						<div className="text-xs text-white/60 break-words font-mono">{connErr}</div>
					</>
				) : "Connecting to the live browser…"}
			/>
		</div>
	);
}
