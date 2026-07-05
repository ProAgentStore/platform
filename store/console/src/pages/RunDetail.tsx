import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { api, getToken, API } from "@proagentstore/sdk/client";
import { usePolling } from "@proagentstore/sdk/hooks";
import type { RuntimeTask, RuntimeEvent } from "../lib/types";
import { ArrowLeft, Play, Pause, ChevronLeft, ChevronRight, Trash2 } from "lucide-react";

/**
 * A real, routed run-detail page (not a popup) for any browser-runtime task: a
 * timestamped activity log of everything the agent did, plus a SCREENSHOT REPLAY
 * — one shot per action, scrub/step/auto-play through the whole run and see the
 * page the agent saw at each step. Standard detail view for browser agents.
 */
const fmtTime = (t?: string) => (t ? new Date(t).toLocaleTimeString() : "");
const fmtClock = (t?: string) => (t ? new Date(t).toLocaleString() : "");

/** Plain-language line for a raw event (hides empty-accessible-name noise). */
function humanEvent(ev: RuntimeEvent): string {
	if (ev.type === "task.created") return "Started the application";
	if (ev.type === "agent.needs_input") return ev.message || "Paused — needs your answer";
	if (ev.type === "job.human_handoff_required") return ev.message || "Paused — waiting for you";
	if (ev.type === "task.completed") return ev.message || "Completed";
	if (ev.type === "task.failed") return ev.message || "Failed";
	const m = (ev.message || ev.type || "").replace(/\s*(?:in|into textbox|into)\s*""/gi, "").replace(/\s+/g, " ").trim();
	return m || ev.type;
}

function levelClass(type: string): string {
	if (/failed|error|stuck/.test(type)) return "text-red";
	if (/completed|resumed|dryrun/.test(type)) return "text-green";
	if (/needs_input|handoff|captcha/.test(type)) return "text-amber-500";
	return "text-muted";
}

interface Shot { seq: number; action: string; name: string; url: string; at?: string; msg: string }

/**
 * Live remote control of the agent's browser — which runs on a REMOTE machine
 * (the box running `pags up`), so you can't just alt-tab to it. Polls
 * /takeover/:taskId/frame for JPEG frames and relays your mouse + keyboard to
 * /takeover/:taskId/input (CDP Input on the runner). Coordinates map into the
 * frame's CSS-viewport space (width/height from the frame response), so clicks
 * land precisely regardless of how the frame is scaled in the browser.
 */
function TakeoverLive({ instanceId, taskId, kind, onResume, onClose }: { instanceId: string; taskId: string; kind: string; onResume: () => void; onClose: () => void }) {
	const [frame, setFrame] = useState<{ frame: string; width: number; height: number } | null>(null);
	const [connErr, setConnErr] = useState("");
	const imgRef = useRef<HTMLImageElement>(null);
	const boxRef = useRef<HTMLDivElement>(null);
	const lastMove = useRef(0);

	const poll = useCallback(async () => {
		try {
			const f = await api<{ frame: string; width: number; height: number }>(`/v1/instances/${instanceId}/takeover/${taskId}/frame`);
			if (f?.frame && f.frame.length > 30) { setFrame(f); setConnErr(""); }
			else setConnErr("The runner returned an empty frame (no live page to capture).");
		} catch (e) { setConnErr(e instanceof Error ? e.message : String(e)); }
	}, [instanceId, taskId]);

	useEffect(() => { poll(); }, [poll]);
	usePolling(poll, 500, true); // ~2 fps; shares the high-rate takeover bucket
	// Full-screen overlay: focus for keyboard capture + lock body scroll while open.
	useEffect(() => {
		boxRef.current?.focus();
		const prev = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => { document.body.style.overflow = prev; };
	}, []);

	const send = (body: Record<string, unknown>) =>
		api(`/v1/instances/${instanceId}/takeover/${taskId}/input`, { method: "POST", body: JSON.stringify(body) }).catch(() => {});

	const toXY = (clientX: number, clientY: number) => {
		const img = imgRef.current; if (!img || !frame) return null;
		const r = img.getBoundingClientRect();
		if (!r.width || !r.height) return null;
		return { x: Math.round(((clientX - r.left) / r.width) * frame.width), y: Math.round(((clientY - r.top) / r.height) * frame.height) };
	};

	const onClick = (e: React.MouseEvent) => { const c = toXY(e.clientX, e.clientY); if (c) { send({ type: "click", ...c }); boxRef.current?.focus(); setTimeout(poll, 150); } };
	const onMove = (e: React.MouseEvent) => { const now = Date.now(); if (now - lastMove.current < 90) return; lastMove.current = now; const c = toXY(e.clientX, e.clientY); if (c) send({ type: "move", ...c }); };
	const onWheel = (e: React.WheelEvent) => { const c = toXY(e.clientX, e.clientY); if (c) send({ type: "scroll", ...c, deltaX: e.deltaX, deltaY: e.deltaY }); };
	const onKey = (e: React.KeyboardEvent) => {
		if (e.key === "Escape") { onClose(); return; }
		if (e.key === "Tab") return; // let focus leave the panel
		e.preventDefault();
		if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) send({ type: "text", text: e.key });
		else send({ type: "key", key: e.key, code: e.code, keyCode: e.keyCode });
		setTimeout(poll, 150);
	};
	const endTakeover = async () => { await api(`/v1/instances/${instanceId}/takeover/${taskId}/end`, { method: "POST" }).catch(() => {}); onClose(); };

	// Full-screen, non-scrolling overlay: a fixed toolbar + the live frame filling the rest.
	return (
		<div
			ref={boxRef}
			tabIndex={0}
			onKeyDown={onKey}
			className="fixed inset-0 z-[100] bg-black flex flex-col outline-none"
		>
			<div className="flex items-center gap-3 px-3 sm:px-4 py-2 bg-panel border-b border-line shrink-0">
				<span className="font-bold text-ink text-sm">{kind === "captcha" ? "🔐 Live remote control — solve the verification" : "🖥 Live remote control"}</span>
				<span className="text-xs text-muted-soft hidden md:inline">Click &amp; type here — sent live to the agent's browser (~2 fps).</span>
				<div className="ml-auto flex items-center gap-2">
					<button type="button" onClick={onResume} className="px-4 py-1.5 rounded-lg bg-green/20 text-green font-bold text-sm">Resume — done</button>
					<button type="button" onClick={endTakeover} className="px-3 py-1.5 rounded-lg bg-red/15 text-red text-sm font-semibold">End</button>
					<button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg bg-panel border border-line text-muted text-sm hover:text-ink">Close ✕</button>
				</div>
			</div>
			<div className="flex-1 min-h-0 flex items-center justify-center overflow-hidden bg-black">
				{frame ? (
					<img
						ref={imgRef}
						src={frame.frame}
						onClick={onClick}
						onMouseMove={onMove}
						onWheel={onWheel}
						draggable={false}
						alt="Live agent browser"
						className="max-w-full max-h-full object-contain cursor-crosshair select-none"
					/>
				) : (
					<div className="text-sm text-white/70 max-w-lg text-center px-4">
						{connErr ? (
							<>
								<div className="font-semibold text-red mb-1">Live view error</div>
								<div className="text-xs text-white/60 break-words font-mono">{connErr}</div>
							</>
						) : "Connecting to the live browser…"}
					</div>
				)}
			</div>
		</div>
	);
}

export default function RunDetail() {
	const { id: instanceId = "", taskId = "" } = useParams();
	const navigate = useNavigate();
	const [task, setTask] = useState<RuntimeTask | null>(null);
	const [events, setEvents] = useState<RuntimeEvent[]>([]);
	const [shotUrls, setShotUrls] = useState<Record<number, string>>({});
	const [idx, setIdx] = useState(0);
	const [playing, setPlaying] = useState(false);
	const [inputVal, setInputVal] = useState("");
	const [takeoverOpen, setTakeoverOpen] = useState(false);
	const urlsRef = useRef<Record<number, string>>({});

	const load = useCallback(async () => {
		try { setTask(await api<RuntimeTask>(`/v1/instances/${instanceId}/tasks/${taskId}`)); } catch { /* keep */ }
		try {
			const d = await api<{ events: RuntimeEvent[] }>(`/v1/instances/${instanceId}/task-events?limit=500`);
			const mine = (d.events || []).filter((e) => String(e.taskId ?? (e.data as Record<string, unknown>)?.taskId ?? "") === taskId);
			mine.sort((a, b) => new Date(a.createdAt ?? a.timestamp ?? 0).getTime() - new Date(b.createdAt ?? b.timestamp ?? 0).getTime());
			setEvents(mine);
		} catch { /* keep */ }
	}, [instanceId, taskId]);

	useEffect(() => { load(); }, [load]);
	const running = task?.status === "running" || task?.status === "needs_human" || task?.needs_human;
	usePolling(load, 3000, !!running);

	const needsHuman = task?.status === "needs_human" || task?.needs_human;
	const isFinished = task ? ["completed", "cancelled", "failed", "blocked", "expired"].includes(task.status) : false;

	// What the agent needs from you (from the handoff events) — same detection as the board.
	const handoffEv = events.slice().reverse().find((e) => e.type === "job.human_handoff_required");
	const needsInputEv = events.slice().reverse().find((e) => e.type === "agent.needs_input");
	const reason = String((handoffEv?.data as Record<string, unknown>)?.reason ?? "");
	const kind: "value" | "captcha" | "stuck" =
		reason === "needs_input" || !!needsInputEv || /needs a value|enter it/i.test(handoffEv?.message ?? "") ? "value"
		: reason === "challenge" || /captcha|verify you|human check/i.test(`${handoffEv?.message ?? ""}`) ? "captcha" : "stuck";
	const detail = needsInputEv?.message ?? handoffEv?.message ?? "";
	const field = task?.handoff_field || detail.replace(/^Needs your input\s*[—-]\s*/i, "").split("(")[0].trim() || "your answer";
	const paren = detail.match(/\(([^)]*)\)/)?.[1] ?? "";
	const fromIdx = paren.toLowerCase().indexOf("from:");
	const options = fromIdx >= 0 ? paren.slice(fromIdx + 5).split(",").map((s) => s.trim()).filter((s) => s && s.length < 70).slice(0, 16) : [];

	const sendValue = async (v: string) => {
		const t = v.trim(); if (!t) return;
		await api(`/v1/instances/${instanceId}/input`, { method: "POST", body: JSON.stringify({ taskId, value: t }) }).catch((e) => alert(e instanceof Error ? e.message : String(e)));
		setInputVal(""); load();
	};
	const resume = async () => { await api(`/v1/instances/${instanceId}/takeover/${taskId}/resume`, { method: "POST" }).catch(() => api(`/v1/instances/${instanceId}/tasks/${taskId}/resume`, { method: "POST" })); load(); };
	const remove = async () => {
		if (!isFinished && !confirm("Delete this ticket? If it's still running it will be stopped first.")) return;
		await api(`/v1/instances/${instanceId}/tasks/${taskId}`, { method: "DELETE" }).catch((e) => alert(e instanceof Error ? e.message : String(e)));
		navigate(-1);
	};

	const shots: Shot[] = useMemo(() =>
		events
			.filter((e) => e.type === "agent.shot" && (e.data as Record<string, unknown>)?.seq != null)
			.map((e) => {
				const d = (e.data ?? {}) as Record<string, unknown>;
				return { seq: Number(d.seq), action: String(d.action ?? ""), name: String(d.name ?? ""), url: String(d.url ?? ""), at: e.createdAt ?? e.timestamp, msg: e.message ?? "" };
			})
			.sort((a, b) => a.seq - b.seq),
	[events]);

	// Fetch each shot blob with auth (an <img src> can't send a Bearer header) → object URL.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			const tok = getToken();
			for (const s of shots) {
				if (urlsRef.current[s.seq]) continue;
				try {
					const res = await fetch(`${API}/v1/instances/${instanceId}/tasks/${taskId}/shots/${s.seq}`, { headers: { Authorization: `Bearer ${tok}` } });
					if (!res.ok) continue;
					const blob = await res.blob();
					if (cancelled) return;
					urlsRef.current[s.seq] = URL.createObjectURL(blob);
					setShotUrls({ ...urlsRef.current });
				} catch { /* skip */ }
			}
		})();
		return () => { cancelled = true; };
	}, [shots, instanceId, taskId]);

	useEffect(() => () => { Object.values(urlsRef.current).forEach(URL.revokeObjectURL); }, []);
	useEffect(() => { if (idx > shots.length - 1) setIdx(Math.max(0, shots.length - 1)); }, [shots.length, idx]);

	useEffect(() => {
		if (!playing || shots.length === 0) return;
		const t = setInterval(() => setIdx((i) => { if (i >= shots.length - 1) { setPlaying(false); return i; } return i + 1; }), 1200);
		return () => clearInterval(t);
	}, [playing, shots.length]);

	const cur = shots[idx];
	const status = task?.status ?? "";
	const url = String(task?.input?.url ?? "");

	return (
		<div className="max-w-[1100px] mx-auto px-3 py-3 sm:px-6 sm:py-5">
			<div className="flex items-center justify-between gap-2 mb-3">
				<button type="button" onClick={() => navigate(-1)} className="flex items-center gap-1.5 text-sm text-muted hover:text-accent">
					<ArrowLeft size={15} /> Back
				</button>
				<button type="button" onClick={remove} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-red/15 text-red font-semibold hover:bg-red/25">
					<Trash2 size={14} /> Delete
				</button>
			</div>

			<div className="mb-4">
				<h1 className="text-xl font-bold break-words">Run detail</h1>
				<div className="flex items-center gap-2 flex-wrap mt-1 text-xs">
					{status && <span className="px-2 py-0.5 rounded-full font-semibold bg-panel border border-line">{status === "needs_human" ? "Waiting for you" : status}</span>}
					{task?.createdAt && <span className="text-muted-soft">started {fmtClock(task.createdAt)}</span>}
				</div>
				{url && <a href={url} target="_blank" rel="noreferrer" className="text-xs text-accent break-all hover:underline">{url}</a>}
			</div>

			{needsHuman && kind === "value" && (
				<div className="bg-amber-500/10 border border-amber-500/40 rounded-xl p-4 sm:p-5 mb-5">
					<div className="text-lg font-bold text-ink">✏️ The agent needs one answer to continue</div>
					<div className="text-sm text-muted mt-0.5 mb-3">It won’t guess personal or legal details — answer once and it keeps going.</div>
					<div className="text-base font-semibold text-ink">{field}</div>
					{options.length > 0 && (
						<div className="mt-3">
							<div className="text-xs font-bold uppercase tracking-wide text-muted-soft mb-2">Tap your answer</div>
							<div className="flex flex-wrap gap-2">
								{options.map((opt) => (
									<button key={opt} type="button" onClick={() => sendValue(opt)} className="px-3.5 py-2 rounded-lg bg-panel border border-line hover:border-accent hover:bg-accent/10 text-sm text-ink font-medium">{opt}</button>
								))}
							</div>
							<div className="text-xs text-muted-soft mt-3 mb-1.5">…or type a different answer</div>
						</div>
					)}
					<div className="flex gap-2 mt-2">
						<input autoFocus value={inputVal} onChange={(e) => setInputVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") sendValue(inputVal); }} placeholder={field} className="flex-1 min-w-0 bg-panel border border-line rounded-lg px-3 py-2.5 text-base text-ink" />
						<button type="button" disabled={!inputVal.trim()} onClick={() => sendValue(inputVal)} className="px-5 py-2.5 rounded-lg bg-accent text-white font-bold text-base disabled:opacity-40 shrink-0">Send</button>
					</div>
				</div>
			)}

			{needsHuman && kind !== "value" && (
				<div className="bg-amber-500/10 border border-amber-500/40 rounded-xl p-4 sm:p-5 mb-5">
					<div className="text-lg font-bold text-ink">{kind === "captcha" ? "🔐 A human verification appeared" : "✋ The agent is stuck on one step"}</div>
					<div className="text-sm text-muted mt-0.5 mb-3">The agent runs on your remote machine — take control of its browser here, {kind === "captcha" ? "solve the verification" : "do the blocked step"}, then press Resume.</div>
					<div className="flex flex-wrap gap-2">
						<button type="button" onClick={() => setTakeoverOpen(true)} className="px-5 py-2.5 rounded-lg bg-accent text-white font-bold text-base">🖥 Take over (live)</button>
						<button type="button" onClick={resume} className="px-5 py-2.5 rounded-lg bg-green/15 text-green font-bold text-base">Resume — I’ve done it</button>
					</div>
				</div>
			)}
			{takeoverOpen && (
				<TakeoverLive instanceId={instanceId} taskId={taskId} kind={kind} onClose={() => setTakeoverOpen(false)} onResume={() => { setTakeoverOpen(false); resume(); }} />
			)}

			{/* ── Screenshot replay ─────────────────────────────────────────── */}
			{shots.length > 0 ? (
				<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-5">
					<div className="flex items-center gap-3 mb-3">
						<button type="button" onClick={() => setPlaying((p) => !p)} className="w-9 h-9 flex items-center justify-center rounded-lg bg-accent text-white shrink-0" aria-label={playing ? "Pause" : "Play"}>
							{playing ? <Pause size={16} /> : <Play size={16} />}
						</button>
						<button type="button" onClick={() => { setPlaying(false); setIdx((i) => Math.max(0, i - 1)); }} disabled={idx <= 0} className="w-8 h-8 flex items-center justify-center rounded-lg border border-line text-muted disabled:opacity-30" aria-label="Previous"><ChevronLeft size={16} /></button>
						<button type="button" onClick={() => { setPlaying(false); setIdx((i) => Math.min(shots.length - 1, i + 1)); }} disabled={idx >= shots.length - 1} className="w-8 h-8 flex items-center justify-center rounded-lg border border-line text-muted disabled:opacity-30" aria-label="Next"><ChevronRight size={16} /></button>
						<input type="range" min={0} max={Math.max(0, shots.length - 1)} value={idx} onChange={(e) => { setPlaying(false); setIdx(Number(e.target.value)); }} className="flex-1 min-w-0 accent-accent" />
						<span className="text-xs text-muted-soft font-mono shrink-0">{idx + 1}/{shots.length}</span>
					</div>

					<div className="rounded-lg overflow-hidden border border-line bg-paper flex items-center justify-center min-h-[240px]">
						{cur && shotUrls[cur.seq] ? (
							<img src={shotUrls[cur.seq]} alt={`Step ${cur.seq}`} className="w-full max-h-[520px] object-contain" />
						) : (
							<span className="text-sm text-muted-soft py-16">Loading screenshot…</span>
						)}
					</div>

					{cur && (
						<div className="flex items-baseline justify-between gap-3 mt-2.5">
							<div className="text-sm text-ink">
								<span className="font-semibold">Step {cur.seq}:</span> {cur.msg || humanEvent({ type: "agent.decision", message: cur.action } as RuntimeEvent)}
							</div>
							<span className="text-xs text-muted-soft font-mono shrink-0">{fmtTime(cur.at)}</span>
						</div>
					)}
				</div>
			) : (
				<div className="bg-panel border border-line rounded-xl p-4 mb-5 text-sm text-muted-soft">
					No screenshots for this run{running ? " yet — they appear as the agent acts." : " (older run, before screenshot capture)."}
				</div>
			)}

			{/* ── Full timestamped activity log ─────────────────────────────── */}
			<div className="bg-panel border border-line rounded-xl p-3 sm:p-4">
				<h2 className="text-sm font-bold mb-3">Activity — everything the agent did</h2>
				{events.length === 0 ? (
					<div className="text-sm text-muted-soft py-4 text-center">No activity yet.</div>
				) : (
					<div className="flex flex-col">
						{events.filter((e) => e.type !== "agent.shot").map((ev) => {
							const thought = (ev.data as Record<string, unknown>)?.thought as string | undefined;
							return (
								<div key={ev.id} className="flex gap-3 py-1.5 border-b border-line last:border-0 text-sm">
									<span className="text-xs font-mono text-muted-soft shrink-0 w-[68px] pt-0.5">{fmtTime(ev.createdAt ?? ev.timestamp)}</span>
									<div className="min-w-0 flex-1">
										<div className={levelClass(ev.type)}>{humanEvent(ev)}</div>
										{thought && <div className="text-xs text-muted-soft mt-0.5 line-clamp-2">{thought}</div>}
									</div>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}
