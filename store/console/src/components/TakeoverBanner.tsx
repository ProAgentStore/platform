import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Button from "./Button";
import { type BrowserTakeover, type BrowserTakeoverListResponse, type BrowserTakeoverTransitionResponse, deviceKind, isLive, remoteViewBlocked, takeoverLine } from "../lib/browserTakeovers";

/**
 * The durable takeover for one run or task (#1031), read from the record — so what the page says about
 * "you are being asked to take over" is a fact someone can read back, not the runner's memory. Shows the
 * latest takeover for the subject and the moves the owner can make: hand it back (resume) or decline.
 */
export default function TakeoverBanner({ instanceId, subjectKind, subjectId }: { instanceId: string; subjectKind: "local_browser_run" | "runtime_task"; subjectId: string }) {
	const [takeover, setTakeover] = useState<BrowserTakeover | null>(null);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState("");

	const load = useCallback(async () => {
		try {
			const r = await api<BrowserTakeoverListResponse>(`/v1/instances/${instanceId}/browser-takeovers?subject_kind=${subjectKind}&subject_id=${encodeURIComponent(subjectId)}&limit=1`);
			setTakeover(r.takeovers[0] ?? null);
		} catch {
			// An older API without the route: no banner, nothing broken.
		}
	}, [instanceId, subjectKind, subjectId]);
	useEffect(() => {
		load();
		const t = setInterval(load, 15_000);
		return () => clearInterval(t);
	}, [load]);

	if (!takeover) return null;
	const line = takeoverLine(takeover);
	const move = async (state: "resumed" | "ended") => {
		setBusy(true);
		setErr("");
		try {
			const r = await api<BrowserTakeoverTransitionResponse>(`/v1/instances/${instanceId}/browser-takeovers/${takeover.id}`, { method: "PATCH", body: JSON.stringify({ state, device: deviceKind() }) });
			setTakeover(r.takeover);
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		}
		setBusy(false);
	};
	return (
		<div role="status" data-testid="takeover-banner" className={`rounded-lg border px-3 py-2 text-sm ${line.tone === "warn" ? "border-warning text-warning" : line.tone === "ok" ? "border-line text-success" : "border-line text-muted"}`}>
			{line.text}
			{isLive(takeover) && remoteViewBlocked(takeover, deviceKind()) && <div className="text-xs mt-1">{remoteViewBlocked(takeover, deviceKind())}</div>}
			{isLive(takeover) && (
				<div className="flex gap-2 mt-2">
					<Button size="sm" onClick={() => void move("resumed")} disabled={busy} data-testid="takeover-resume">I'm done — resume</Button>
					<Button size="sm" variant="ghost" onClick={() => void move("ended")} disabled={busy} data-testid="takeover-decline">Decline</Button>
				</div>
			)}
			{err && <div className="text-xs text-danger mt-1">{err}</div>}
		</div>
	);
}
