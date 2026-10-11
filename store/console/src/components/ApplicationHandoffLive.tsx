import { useCallback, useEffect, useRef, useState, type MouseEvent, type KeyboardEvent } from "react";
import { api } from "@proagentstore/sdk/client";
import { useTieredPolling } from "@proagentstore/sdk/hooks";
import Button from "./Button";
import type { ApplicationHandoffResumeResponse } from "../lib/types";

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
	const [frame, setFrame] = useState<{ frame: string; width: number; height: number } | null>(null);
	const [error, setError] = useState("");
	const [endError, setEndError] = useState("");
	const imageRef = useRef<HTMLImageElement>(null);
	const boxRef = useRef<HTMLDivElement>(null);
	const lastMove = useRef(0);
	const frameRef = useRef<typeof frame>(null);
	frameRef.current = frame;

	const poll = useCallback(async () => {
		try {
			const next = await api<{ frame: string; width: number; height: number }>(withPath(base, "frame"));
			if (!next?.frame || next.frame.length < 30) throw new Error("The runner has no live browser frame.");
			setFrame(next);
			setError("");
		} catch (e) {
			// An expired/lost/ended handoff must stay visibly unresolved.  In particular, do not
			// translate a missing page into "done" — that would erase submit uncertainty.
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [base]);

	useEffect(() => { poll(); }, [poll]);
	useTieredPolling(poll, { activeMs: 500, passiveMs: 500 }, false);
	useEffect(() => {
		boxRef.current?.focus();
		const old = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => { document.body.style.overflow = old; };
	}, []);

	const send = useCallback((body: Record<string, unknown>) =>
		api(withPath(base, "input"), { method: "POST", body: JSON.stringify(body) }).catch(() => {
			// Per-event input errors are visible in the next frame/state poll.  Never echo typed
			// text into an error, notification, or trace.
		}), [base]);
	const toPoint = (clientX: number, clientY: number) => {
		const image = imageRef.current;
		if (!image || !frame) return null;
		const rect = image.getBoundingClientRect();
		if (!rect.width || !rect.height) return null;
		return { x: Math.round(((clientX - rect.left) / rect.width) * frame.width), y: Math.round(((clientY - rect.top) / rect.height) * frame.height) };
	};
	const click = (e: MouseEvent) => {
		const point = toPoint(e.clientX, e.clientY);
		if (!point) return;
		send({ type: "click", ...point });
		boxRef.current?.focus();
		setTimeout(poll, 150);
	};
	const move = (e: MouseEvent) => {
		const now = Date.now();
		if (now - lastMove.current < 90) return;
		lastMove.current = now;
		const point = toPoint(e.clientX, e.clientY);
		if (point) send({ type: "move", ...point });
	};
	useEffect(() => {
		const image = imageRef.current;
		if (!image) return;
		let lastWheel = 0;
		const wheel = (event: WheelEvent) => {
			event.preventDefault();
			const now = Date.now();
			if (now - lastWheel < 40) return;
			lastWheel = now;
			const current = frameRef.current;
			const rect = image.getBoundingClientRect();
			if (!current || !rect.width || !rect.height) return;
			send({ type: "scroll", x: Math.round(((event.clientX - rect.left) / rect.width) * current.width), y: Math.round(((event.clientY - rect.top) / rect.height) * current.height), deltaX: Math.round(event.deltaX), deltaY: Math.round(event.deltaY) });
			setTimeout(poll, 120);
		};
		image.addEventListener("wheel", wheel, { passive: false });
		return () => image.removeEventListener("wheel", wheel);
	}, [poll, send]);
	const key = (e: KeyboardEvent) => {
		if (e.key === "Escape") { onClose(); return; }
		if (e.key === "Tab") return;
		e.preventDefault();
		if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) send({ type: "text", text: e.key });
		else send({ type: "key", key: e.key, code: e.code, keyCode: e.keyCode });
		setTimeout(poll, 150);
	};
	const resume = async () => {
		try {
			const result = await api<ApplicationHandoffResumeResponse>(withPath(base, "resume"), { method: "POST" });
			if (reconciliation && result?.state === "running") {
				setError("Authenticated read-only inspection remains live. This session cannot conclude submission status until a validated SEEK receipt/history contract exists.");
				poll();
				return;
			}
			onChanged();
			onClose();
		} catch (e) { setError(e instanceof Error ? e.message : String(e)); }
	};
	const end = async () => {
		setEndError("");
		try {
			await api(withPath(base, "end"), { method: "POST" });
			onChanged();
			onClose();
		} catch (e) { setEndError(`Couldn't end the handoff — the Runner may still have the browser. ${e instanceof Error ? e.message : String(e)}`); }
	};

	// biome-ignore lint/a11y/noNoninteractiveTabindex: this full-screen remote-control surface must capture keyboard input for the existing Runner browser.
	return <div ref={boxRef} role="application" aria-label="Live Application Runner browser control" tabIndex={0} onKeyDown={key} className="fixed inset-0 z-[100] bg-black flex flex-col outline-none">
		<div className="flex items-center gap-3 px-3 sm:px-4 py-2 bg-panel border-b border-line shrink-0">
			<span className="font-bold text-ink text-sm">🖥 {reconciliation ? "Application reconciliation — read-only browser" : "Application Runner — live browser control"}</span>
			<span className="text-xs text-muted-soft hidden md:inline">{reconciliation ? "Sign in or complete the site challenge only. This browser cannot fill, upload, submit, or clear the original uncertainty." : "Sign in or complete the site step in this existing browser, then resume. A sign-in alone never changes submission status."}</span>
			<div className="ml-auto flex items-center gap-2">
				<Button variant="primary" size="lg" onClick={resume}>{reconciliation ? "Recheck — done" : "Resume — done"}</Button>
				<Button variant="danger" size="md" onClick={end}>End</Button>
				<Button variant="secondary" size="md" onClick={onClose}>Close ✕</Button>
			</div>
		</div>
		{endError && <div data-testid="application-handoff-end-error" className="shrink-0 px-3 sm:px-4 py-2 bg-danger-soft border-b border-danger-line text-danger text-xs font-semibold break-words">{endError}</div>}
		<div className="flex-1 min-h-0 flex items-center justify-center overflow-hidden bg-black">
			{frame ? (
				// biome-ignore lint/a11y/useKeyWithClickEvents: remote browser clicks require pointer coordinates from the rendered screenshot.
				<img ref={imageRef} src={frame.frame} width={1280} height={720} onClick={click} onMouseMove={move} draggable={false} alt="Live Application Runner browser" className="max-w-full max-h-full object-contain cursor-crosshair select-none" />
			) : <div className="text-sm text-white/70 max-w-lg text-center px-4">{error ? <><div className="font-semibold text-danger mb-1">Live handoff unavailable</div><div className="text-xs text-white/60 break-words font-mono">{error}</div></> : "Connecting to the existing Runner browser…"}</div>}
		</div>
	</div>;
}

/** Add a route segment before the query string; `${base}/input` would corrupt it. */
function withPath(base: string, suffix: string): string {
	const [path, query] = base.split("?", 2);
	return `${path}/${suffix}${query ? `?${query}` : ""}`;
}
