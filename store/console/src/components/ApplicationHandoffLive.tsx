import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import { useTieredPolling } from "@proagentstore/sdk/hooks";
import Button from "./Button";
import RemoteBrowser, { type RemoteFrame } from "./RemoteBrowser";
import { deviceKind } from "../lib/browserTakeovers";
import type { ApplicationHandoffResumeResponse } from "../lib/types";

// The phone entry lives with the remote browser it belongs to (#1105); re-exported for this view's callers.
export { MobileTakeoverEntry, mobileTakeoverKey, mobileTakeoverText } from "./RemoteBrowser";

/**
 * Live control for one #1013 Application Runner handoff.
 *
 * The link and this component intentionally know an opaque handoff id only long enough to resolve
 * it server-side.  All browser operations are instead bound to the returned runner run id; the
 * worker checks owner, Runner, application, profile and expiry again on every operation.  Frames
 * are rendered here but never put in React state outside this mounted, authenticated view, stored
 * in localStorage, or copied into an application trace.
 */
export default function ApplicationHandoffLive({ instanceId, runId, handoffId, reconciliation = false, onClose, onChanged }: {
	instanceId: string;
	runId: string;
	handoffId: string;
	/** A reconciliation session permits only login/CAPTCHA input and a read-only recheck. */
	reconciliation?: boolean;
	onClose: () => void;
	onChanged: () => void;
}) {
	// Every operation carries the opaque continuity id as well as the run.  A run id alone is not
	// a capability: this lets the API reject a stale, duplicate, or different-profile handoff.
	const handoffPath = reconciliation ? "reconciliation/handoff" : "handoff";
	const base = `/v1/instances/${encodeURIComponent(instanceId)}/application-runs/${encodeURIComponent(runId)}/${handoffPath}?handoff_id=${encodeURIComponent(handoffId)}`;
	const [frame, setFrame] = useState<RemoteFrame | null>(null);
	// Three lifetimes, three states. A frame poll owns ONLY `frameError`: a successful poll every 500ms
	// used to clear the one shared error, erasing an input refusal or the read-only notice ~150ms after it
	// appeared. An input refusal changes only with the next input's outcome; a resume notice only with the
	// next resume. Ending or closing unmounts the view, which clears all three.
	const [frameError, setFrameError] = useState("");
	const [inputNotice, setInputNotice] = useState("");
	const [resumeNotice, setResumeNotice] = useState("");
	const [endError, setEndError] = useState("");
	/** Only the latest input's outcome may set or clear `inputNotice` — an older send resolving late may not. */
	const inputSeq = useRef(0);
	const mobileEntryRef = useRef<HTMLInputElement>(null);

	const poll = useCallback(async () => {
		try {
			const next = await api<RemoteFrame>(withPath(base, "frame"));
			if (!next?.frame || next.frame.length < 30) throw new Error("The runner has no live browser frame.");
			setFrame(next);
			setFrameError("");
		} catch (e) {
			// An expired/lost/ended handoff must stay visibly unresolved.  In particular, do not
			// translate a missing page into "done" — that would erase submit uncertainty.
			setFrame(null);
			setFrameError(e instanceof Error ? e.message : String(e));
		}
	}, [base]);

	useEffect(() => { poll(); }, [poll]);
	useTieredPolling(poll, { activeMs: 500, passiveMs: 500 }, false);
	useEffect(() => {
		const old = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => { document.body.style.overflow = old; };
	}, []);

	const send = useCallback(async (body: Record<string, unknown>) => {
		const seq = ++inputSeq.current;
		try {
			await api(withPath(base, "input"), { method: "POST", body: JSON.stringify(body) });
			// An accepted input is the transition that retires an earlier refusal.
			if (seq === inputSeq.current) setInputNotice("");
			return true;
		} catch {
			// Never echo a login/OTP value.  The Runner has already enforced the bounded blocker
			// boundary, so a refusal means this mobile control cannot be an application-fill path.
			if (seq === inputSeq.current) setInputNotice("Secure sign-in input is no longer available. Recheck or end this handoff.");
			return false;
		}
	}, [base]);
	const resume = async () => {
		try {
			const result = await api<ApplicationHandoffResumeResponse>(withPath(base, "resume"), { method: "POST" });
			if (reconciliation && result?.state === "running") {
				setResumeNotice("Authenticated read-only inspection remains live. This session cannot conclude submission status until a validated SEEK receipt/history contract exists.");
				poll();
				return;
			}
			onChanged();
			onClose();
		} catch (e) { setResumeNotice(e instanceof Error ? e.message : String(e)); }
	};
	const end = async () => {
		setEndError("");
		try {
			await api(withPath(base, "end"), { method: "POST" });
			onChanged();
			onClose();
		} catch (e) { setEndError(`Couldn't end the handoff — the Runner may still have the browser. ${e instanceof Error ? e.message : String(e)}`); }
	};

	return <div role="dialog" aria-modal="true" aria-label="Live Application Runner browser control" className="fixed inset-0 z-[100] bg-black flex flex-col">
		<div className="flex items-center gap-3 px-3 sm:px-4 py-2 bg-panel border-b border-line shrink-0">
			<span className="font-bold text-ink text-sm">🖥 {reconciliation ? "Application reconciliation — read-only browser" : "Application Runner — live browser control"}</span>
			<span className="text-xs text-muted-soft hidden md:inline">{reconciliation ? "Sign in or complete the site challenge only. This browser cannot fill, upload, submit, or clear the original uncertainty." : "Sign in or complete the site step in this existing browser, then resume. A sign-in alone never changes submission status."}</span>
			<div className="ml-auto flex items-center gap-2">
				<Button variant="primary" size="lg" onClick={resume}>{reconciliation ? "Recheck — done" : "Resume — done"}</Button>
				<Button variant="danger" size="md" onClick={end}>End</Button>
				<Button variant="secondary" size="md" onClick={onClose}>Close ✕</Button>
			</div>
		</div>
		<RemoteBrowser
			frame={frame}
			alt="Live Application Runner browser"
			send={(input) => void send(input)}
			refresh={poll}
			onEscape={onClose}
			entryRef={mobileEntryRef}
			entryNote={reconciliation ? "after authentication the read-only Runner rejects further input." : "this remains the existing owner-authorized live handoff only."}
			onTapped={reconciliation ? () => mobileEntryRef.current?.focus() : undefined}
			defaultImmersive={deviceKind() === "mobile"}
			notices={<>
				{endError && <div data-testid="application-handoff-end-error" className="shrink-0 px-3 sm:px-4 py-2 bg-danger-soft border-b border-danger-line text-danger text-xs font-semibold break-words">{endError}</div>}
				{resumeNotice && <div data-testid="application-handoff-resume-notice" className="shrink-0 px-3 sm:px-4 py-2 bg-danger-soft border-b border-danger-line text-danger text-xs font-semibold break-words">{resumeNotice}</div>}
				{inputNotice && <div data-testid="application-handoff-input-error" className="shrink-0 px-3 sm:px-4 py-2 bg-danger-soft border-b border-danger-line text-danger text-xs font-semibold break-words">{inputNotice}</div>}
			</>}
			placeholder={frameError ? <><div className="font-semibold text-danger mb-1">Live handoff unavailable</div><div className="text-xs text-white/60 break-words font-mono">{frameError}</div></> : "Connecting to the existing Runner browser…"}
		/>
	</div>;
}

/** Add a route segment before the query string; `${base}/input` would corrupt it. */
function withPath(base: string, suffix: string): string {
	const [path, query] = base.split("?", 2);
	return `${path}/${suffix}${query ? `?${query}` : ""}`;
}
