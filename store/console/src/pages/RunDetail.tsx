import { useState, useEffect, useCallback, useRef, useMemo, useId, type ReactNode } from "react";
import Page from "../components/Page";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import { api, getToken, API } from "@proagentstore/sdk/client";
import { usePolling, useTieredPolling } from "@proagentstore/sdk/hooks";
import type { RuntimeTask, RuntimeEvent } from "../lib/types";
import { ArrowLeft, Play, Pause, ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import Card from "../components/Card";

/**
 * A real, routed run-detail page (not a popup) for any browser-runtime task: a
 * timestamped activity log of everything the agent did, plus a SCREENSHOT REPLAY
 * — one shot per action, scrub/step/auto-play through the whole run and see the
 * page the agent saw at each step. Standard detail view for browser agents.
 */
const fmtClock = (t?: string) => (t ? new Date(t).toLocaleString() : "");
/** Date + time for the activity log — a run can span days (retries, overnight handoffs). */
const fmtStamp = (t?: string) =>
	t ? new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";

/** Plain-language line for a raw event (hides empty-accessible-name noise). */
function humanEvent(ev: RuntimeEvent): string {
	if (ev.type === "task.created") return "Started the application";
	if (ev.type === "agent.needs_input") return ev.message || "Paused — needs your answer";
	if (ev.type === "job.human_handoff_required") return ev.message || "Paused — waiting for you";
	if (ev.type === "task.completed") return ev.message || "Completed";
	if (ev.type === "task.failed") return ev.message || "Failed";
	if (ev.type === "job.confirmation_email") return `📧 Confirmation email: ${ev.message || "received"}`;
	if (ev.type === "job.email") return `📧 ${ev.message || "Read an email"}`;
	const m = (ev.message || ev.type || "").replace(/\s*(?:in|into textbox|into)\s*""/gi, "").replace(/\s+/g, " ").trim();
	return m || ev.type;
}

/** Render text with any http(s) URL turned into a clickable new-tab link. Only
 *  http/https is linkified (never javascript:/data:), so it's XSS-safe. */
function linkify(text: string): ReactNode {
	if (!text) return text;
	const parts = text.split(/(https?:\/\/[^\s"'<>)\]]+)/g);
	return parts.map((p) =>
		/^https?:\/\//.test(p)
			? <a key={p} href={p} target="_blank" rel="noreferrer" className="text-accent hover:underline break-all">{p}</a>
			: p,
	);
}

function levelClass(type: string): string {
	if (type === "job.confirmation_email") return "text-success";
	if (/failed|error|stuck/.test(type)) return "text-danger";
	if (/completed|resumed|dryrun/.test(type)) return "text-success";
	if (/needs_input|handoff|captcha/.test(type)) return "text-amber-500";
	if (type === "job.email") return "text-accent";
	return "text-muted";
}

interface Shot { seq: number; action: string; name: string; url: string; at?: string; msg: string }

interface TicketTurn { id: string; role: "user" | "agent"; text: string; at: string }

/**
 * The per-ticket conversation (#150 P2) — ask THIS ticket why it decided what it did.
 *
 * Deliberately not the Assistant tab: a question asked here is answered from this ticket's
 * own reasoning, declared action and activity, so the answer is about this unit of work
 * rather than the instance in general. The thread has no tools — it explains what happened,
 * it never does anything, and approving is still the only thing that runs a ticket's action.
 */
function TicketThread({ instanceId, taskId, autoFocus }: { instanceId: string; taskId: string; autoFocus?: boolean }) {
	const [turns, setTurns] = useState<TicketTurn[]>([]);
	const [draft, setDraft] = useState("");
	const [asking, setAsking] = useState(false);
	const [err, setErr] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);
	const askLabelId = useId();
	// Arriving from the board's Ask button (`?ask=1`), the thread is well below the fold —
	// past the activity log and the screenshot replay — so landing at the top of the page
	// would look like the button did nothing.
	useEffect(() => {
		if (!autoFocus) return;
		inputRef.current?.scrollIntoView({ block: "center" });
		inputRef.current?.focus({ preventScroll: true });
	}, [autoFocus]);

	const load = useCallback(async () => {
		try { setTurns((await api<{ turns?: TicketTurn[] }>(`/v1/instances/${instanceId}/tasks/${taskId}/thread`)).turns || []); }
		catch { /* keep what's on screen */ }
	}, [instanceId, taskId]);
	useEffect(() => { load(); }, [load]);

	const ask = async () => {
		const q = draft.trim();
		if (!q || asking) return;
		setAsking(true); setErr("");
		// Show the question immediately — the server persists it before the model call, so an
		// inference failure leaves it on the ticket rather than losing what was typed.
		setTurns((t) => [...t, { id: `local-${Date.now()}`, role: "user", text: q, at: new Date().toISOString() }]);
		setDraft("");
		try {
			const res = await api<{ answer?: TicketTurn }>(`/v1/instances/${instanceId}/tasks/${taskId}/thread`, { method: "POST", body: JSON.stringify({ message: q }) });
			if (res.answer) setTurns((t) => [...t, res.answer as TicketTurn]);
		} catch (e) {
			setErr(e instanceof Error ? e.message : String(e));
		} finally {
			setAsking(false);
			load();
		}
	};

	return (
		<Card className="mb-5">
			<h2 id={askLabelId} className="text-sm font-bold mb-1">Ask about this ticket</h2>
			<p className="text-xs text-muted-soft mb-3">Answered from this ticket's record only — its reasoning, what it declared it would do, and what it logged. It can't start work from here.</p>
			{turns.length > 0 && (
				<div className="flex flex-col gap-2 mb-3">
					{turns.map((t) => (
						<div key={t.id} className={`text-sm rounded-lg px-3 py-2 whitespace-pre-line break-words ${t.role === "user" ? "bg-accent-soft text-ink self-end max-w-[85%]" : "bg-paper border border-line text-ink self-start max-w-[95%]"}`}>
							{linkify(t.text)}
							<div className="text-2xs text-muted-soft mt-1">{t.role === "user" ? "You" : "Agent"}{t.at ? ` · ${fmtStamp(t.at)}` : ""}</div>
						</div>
					))}
				</div>
			)}
			{asking && <div className="text-xs text-muted mb-2">Thinking…</div>}
			{err && <div className="text-xs px-3 py-2 mb-2 rounded-lg bg-danger-soft border border-danger-line text-danger">{err}</div>}
			<div className="flex gap-2">
				<input
					ref={inputRef}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => { if (e.key === "Enter") ask(); }}
					// Named by the heading that is already on screen, rather than by the placeholder —
					// which is an EXAMPLE question ("Why did you decide this?"), not the field's name,
					// and disappears as soon as you type your own.
					aria-labelledby={askLabelId}
					placeholder="Why did you decide this?"
					className="flex-1 min-w-0 bg-paper border border-line rounded-lg px-3 py-2 text-sm text-ink"
				/>
				<button type="button" disabled={asking || !draft.trim()} onClick={ask} className="px-4 py-2 rounded-lg bg-accent text-white font-bold text-sm disabled:opacity-40 shrink-0">Ask</button>
			</div>
		</Card>
	);
}

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
	// A failed End, kept separate from `connErr`: that one only renders in place of a missing
	// frame, and an End typically fails while the frame is arriving perfectly well.
	const [endErr, setEndErr] = useState("");
	const imgRef = useRef<HTMLImageElement>(null);
	const boxRef = useRef<HTMLDivElement>(null);
	const lastMove = useRef(0);
	const frameRef = useRef<{ frame: string; width: number; height: number } | null>(null);
	frameRef.current = frame;

	const poll = useCallback(async () => {
		try {
			const f = await api<{ frame: string; width: number; height: number }>(`/v1/instances/${instanceId}/takeover/${taskId}/frame`);
			if (f?.frame && f.frame.length > 30) { setFrame(f); setConnErr(""); }
			else setConnErr("The runner returned an empty frame (no live page to capture).");
		} catch (e) { setConnErr(e instanceof Error ? e.message : String(e)); }
	}, [instanceId, taskId]);

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
	// Full-screen overlay: focus for keyboard capture + lock body scroll while open.
	useEffect(() => {
		boxRef.current?.focus();
		const prev = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		return () => { document.body.style.overflow = prev; };
	}, []);

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
		api(`/v1/instances/${instanceId}/takeover/${taskId}/input`, { method: "POST", body: JSON.stringify(body) }).catch(() => {}), [instanceId, taskId]);

	const toXY = (clientX: number, clientY: number) => {
		const img = imgRef.current; if (!img || !frame) return null;
		const r = img.getBoundingClientRect();
		if (!r.width || !r.height) return null;
		return { x: Math.round(((clientX - r.left) / r.width) * frame.width), y: Math.round(((clientY - r.top) / r.height) * frame.height) };
	};

	const onClick = (e: React.MouseEvent) => { const c = toXY(e.clientX, e.clientY); if (c) { send({ type: "click", ...c }); boxRef.current?.focus(); setTimeout(poll, 150); } };
	const onMove = (e: React.MouseEvent) => { const now = Date.now(); if (now - lastMove.current < 90) return; lastMove.current = now; const c = toXY(e.clientX, e.clientY); if (c) send({ type: "move", ...c }); };

	// Scroll must be a NATIVE, non-passive wheel listener (React's onWheel is passive, so
	// preventDefault is ignored and the local overlay eats the gesture). Throttle + ROUND the
	// deltas — CDP mouseWheel ignores fractional deltaY, which is why remote scroll did nothing.
	useEffect(() => {
		const img = imgRef.current;
		if (!img) return;
		let lastWheel = 0;
		const onWheelNative = (ev: WheelEvent) => {
			ev.preventDefault();
			const now = Date.now();
			if (now - lastWheel < 40) return;
			lastWheel = now;
			const f = frameRef.current;
			const r = img.getBoundingClientRect();
			if (!f || !r.width || !r.height) return;
			send({
				type: "scroll",
				x: Math.round(((ev.clientX - r.left) / r.width) * f.width),
				y: Math.round(((ev.clientY - r.top) / r.height) * f.height),
				deltaX: Math.round(ev.deltaX),
				deltaY: Math.round(ev.deltaY),
			});
			setTimeout(poll, 120);
		};
		img.addEventListener("wheel", onWheelNative, { passive: false });
		return () => img.removeEventListener("wheel", onWheelNative);
	}, [poll, send]); // attach once the frame (img) mounts
	const onKey = (e: React.KeyboardEvent) => {
		if (e.key === "Escape") { onClose(); return; }
		if (e.key === "Tab") return; // let focus leave the panel
		e.preventDefault();
		if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) send({ type: "text", text: e.key });
		else send({ type: "key", key: e.key, code: e.code, keyCode: e.keyCode });
		setTimeout(poll, 150);
	};
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
			await api(`/v1/instances/${instanceId}/takeover/${taskId}/end`, { method: "POST" });
			onClose();
		} catch (e) {
			setEndErr(`Couldn't end the takeover — the agent still has the browser. ${e instanceof Error ? e.message : String(e)}`);
		}
	};

	// Full-screen, non-scrolling overlay: a fixed toolbar + the live frame filling the rest.
	return (
		<div
			ref={boxRef}
			role="application"
			aria-label="Live remote browser control"
			// biome-ignore lint/a11y/noNoninteractiveTabindex: this full-screen remote-control surface must capture keyboard input for the agent browser.
			tabIndex={0}
			onKeyDown={onKey}
			className="fixed inset-0 z-[100] bg-black flex flex-col outline-none"
		>
			<div className="flex items-center gap-3 px-3 sm:px-4 py-2 bg-panel border-b border-line shrink-0">
				<span className="font-bold text-ink text-sm">{kind === "captcha" ? "🔐 Live remote control — solve the verification" : "🖥 Live remote control"}</span>
				<span className="text-xs text-muted-soft hidden md:inline">Click &amp; type here — sent live to the agent's browser (~2 fps).</span>
				<div className="ml-auto flex items-center gap-2">
					<button type="button" onClick={onResume} className="px-4 py-1.5 rounded-lg bg-success-soft text-success font-bold text-sm">Resume — done</button>
					<button type="button" onClick={endTakeover} className="px-3 py-1.5 rounded-lg bg-danger-soft text-danger text-sm font-semibold">End</button>
					<button type="button" onClick={onClose} className="px-3 py-1.5 rounded-lg bg-panel border border-line text-muted text-sm hover:text-ink">Close ✕</button>
				</div>
			</div>
			{endErr && (
				<div data-testid="takeover-end-error" className="shrink-0 px-3 sm:px-4 py-2 bg-danger-soft border-b border-danger-line text-danger text-xs font-semibold break-words">
					{endErr}
				</div>
			)}
			<div className="flex-1 min-h-0 flex items-center justify-center overflow-hidden bg-black">
				{frame ? (
					// biome-ignore lint/a11y/useKeyWithClickEvents: remote browser clicks require pointer coordinates from the rendered screenshot.
					<img
							ref={imgRef}
							src={frame.frame}
							width={1280}
							height={720}
							onClick={onClick}
							onMouseMove={onMove}
						draggable={false}
						alt="Live agent browser"
						className="max-w-full max-h-full object-contain cursor-crosshair select-none"
					/>
				) : (
					<div className="text-sm text-white/70 max-w-lg text-center px-4">
						{connErr ? (
							<>
								<div className="font-semibold text-danger mb-1">Live view error</div>
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
	// `?ask=1` — the board's Ask button asked for this ticket's conversation specifically,
	// not just the ticket. Without it the thread is the feature you only find by scrolling.
	const [searchParams] = useSearchParams();
	const askIntent = searchParams.get("ask") === "1";
	const [task, setTask] = useState<RuntimeTask | null>(null);
	const [events, setEvents] = useState<RuntimeEvent[]>([]);
	const [shotUrls, setShotUrls] = useState<Record<number, string>>({});
	const [idx, setIdx] = useState(0);
	const [playing, setPlaying] = useState(false);
	const [inputVal, setInputVal] = useState("");
	const [takeoverOpen, setTakeoverOpen] = useState(false);
	const fieldLabelId = useId();
	// Which attempt of the job this run is (JSW-style: each retry is a separate,
	// numbered run with its own activity log). Resolved from the board's grouping.
	const [attempt, setAttempt] = useState<{ num: number; total: number } | null>(null);
	// A handoff notification outlives the handoff (#349): the tap can come hours later, after the
	// run finished — or after it was deleted. A finished run needs nothing special (it loads, and
	// `needsHuman` is simply false, so the takeover prompt is absent). A run that is GONE used to
	// leave every fetch failing silently and render an empty shell titled "Run detail" with "No
	// activity yet", which reads like a broken page rather than an answered one. Say so, and offer
	// the Board — the same "degrade to a real page" #344 chose for a session id that no longer
	// resolves. Only a 404 counts; a network blip must keep whatever is on screen.
	const [gone, setGone] = useState(false);
	const urlsRef = useRef<Record<number, string>>({});

	const load = useCallback(async () => {
		try {
			setTask(await api<RuntimeTask>(`/v1/instances/${instanceId}/tasks/${taskId}`));
			setGone(false);
		} catch (e) {
			// "Task not found" / "Instance not found" from the API, or the client's own `HTTP 404`.
			if (/not found|\b404\b/i.test(e instanceof Error ? e.message : String(e))) setGone(true);
		}
		try {
			const d = await api<{ events: RuntimeEvent[] }>(`/v1/instances/${instanceId}/task-events?limit=500`);
			const mine = (d.events || []).filter((e) => String(e.taskId ?? (e.data as Record<string, unknown>)?.taskId ?? "") === taskId);
			mine.sort((a, b) => new Date(a.createdAt ?? a.timestamp ?? 0).getTime() - new Date(b.createdAt ?? b.timestamp ?? 0).getTime());
			setEvents(mine);
		} catch { /* keep */ }
		try {
			// Find this run's attempt number within its job (attempts are newest-first).
			const b = await api<{ items?: { attempts?: { id: string }[] }[] }>(`/v1/instances/${instanceId}/board`);
			const item = (b.items || []).find((it) => it.attempts?.some((a) => a.id === taskId));
			if (item?.attempts) {
				const i = item.attempts.findIndex((a) => a.id === taskId);
				if (i >= 0) setAttempt({ num: item.attempts.length - i, total: item.attempts.length });
			}
		} catch { /* keep */ }
	}, [instanceId, taskId]);

	useEffect(() => { load(); }, [load]);
	const running = task?.status === "running" || task?.status === "needs_human" || task?.needs_human;
	// Left on a plain interval on purpose (#272): it is already gated on the run being in
	// flight, which is precisely the "busy" a tiered poll would compute — and busy beats hidden,
	// so it would resolve to this same 3s anyway. It is also what keeps the run itself live
	// while the frame poll above is halted, so a user who tabs away mid-takeover still comes
	// back to the right status. A finished run turns it off entirely.
	usePolling(load, 3000, !!running);

	const needsHuman = task?.status === "needs_human" || task?.needs_human;
	const isFinished = task ? ["completed", "cancelled", "failed", "blocked", "expired"].includes(task.status) : false;

	// What the agent needs from you (from the handoff events) — same detection as the board.
	const handoffEv = events.slice().reverse().find((e) => e.type === "job.human_handoff_required");
	const needsInputEv = events.slice().reverse().find((e) => e.type === "agent.needs_input");
	const reason = String((handoffEv?.data as Record<string, unknown>)?.reason ?? "");
	const kind: "value" | "captcha" | "stuck" =
		reason === "needs_input" || needsInputEv || /needs a value|enter it/i.test(handoffEv?.message ?? "") ? "value"
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

	// Fetch each shot blob with auth; browser image elements cannot send a Bearer header.
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

	if (gone && !task) {
		return (
			<Page width={1100}>
				<button type="button" onClick={() => navigate(-1)} className="flex items-center gap-1.5 text-sm text-muted hover:text-accent mb-4">
					<ArrowLeft size={15} /> Back
				</button>
				<div className="bg-panel border border-line rounded-xl p-6 text-center">
					<h1 className="text-lg font-bold mb-1">This run is no longer here</h1>
					<p className="text-sm text-muted mb-4">It was deleted, or it belongs to an agent you no longer have. Anything the notification was asking for has been resolved or removed.</p>
					<button type="button" onClick={() => navigate(`/instances/${instanceId}/board`)} className="px-4 py-2 rounded-lg bg-accent text-white font-bold text-sm">Open the Board</button>
				</div>
			</Page>
		);
	}

	return (
		<Page width={1100}>
			<div className="flex items-center justify-between gap-2 mb-3">
				<button type="button" onClick={() => navigate(-1)} className="flex items-center gap-1.5 text-sm text-muted hover:text-accent">
					<ArrowLeft size={15} /> Back
				</button>
				<button type="button" onClick={remove} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-danger-soft text-danger font-semibold hover:bg-danger-soft">
					<Trash2 size={14} /> Delete
				</button>
			</div>

			<div className="mb-4">
				<h1 className="text-xl font-bold break-words">{task?.title || "Run detail"}</h1>
				<div className="flex items-center gap-2 flex-wrap mt-1 text-xs">
					{status && <span className="px-2 py-0.5 rounded-full font-semibold bg-panel border border-line">{status === "needs_human" ? "Waiting for you" : status}</span>}
					{attempt && attempt.total > 1 && (
						<span className="px-2 py-0.5 rounded-full font-semibold bg-accent-soft text-accent border border-accent/30" title="Each retry is a separate run with its own activity log">
							Attempt {attempt.num} of {attempt.total}
						</span>
					)}
					{task?.createdAt && <span className="text-muted-soft">started {fmtClock(task.createdAt)}</span>}
				</div>
				{url && <a href={url} target="_blank" rel="noreferrer" className="text-xs text-accent break-all hover:underline">{url}</a>}
			</div>

			{/* ── Ticket content: description + the WHY (reasoning/audit) ──────── */}
			{(task?.description || task?.reasoning) && (
				<Card className="mb-5">
					{task?.description && <div className="text-sm text-ink mb-3 whitespace-pre-line break-words">{linkify(task.description)}</div>}
					{task?.reasoning && (
						<div>
							<h2 className="text-xs font-bold uppercase tracking-wide text-muted-soft mb-1.5">Why — what the agent did &amp; decided</h2>
							<div className="text-sm text-ink whitespace-pre-line break-words leading-relaxed">{linkify(task.reasoning)}</div>
						</div>
					)}
				</Card>
			)}

			{needsHuman && kind === "value" && (
				<div className="bg-amber-500/10 border border-amber-500/40 rounded-xl p-4 sm:p-5 mb-5">
					<div className="text-lg font-bold text-ink">✏️ The agent needs one answer to continue</div>
					<div className="text-sm text-muted mt-0.5 mb-3">It won’t guess personal or legal details — answer once and it keeps going.</div>
					<div id={fieldLabelId} className="text-base font-semibold text-ink">{field}</div>
					{options.length > 0 && (
						<div className="mt-3">
							<div className="text-xs font-bold uppercase tracking-wide text-muted-soft mb-2">Tap your answer</div>
							<div className="flex flex-wrap gap-2">
								{options.map((opt) => (
									<button key={opt} type="button" onClick={() => sendValue(opt)} className="px-3.5 py-2 rounded-lg bg-panel border border-line hover:border-accent hover:bg-accent-soft text-sm text-ink font-medium">{opt}</button>
								))}
							</div>
							<div className="text-xs text-muted-soft mt-3 mb-1.5">…or type a different answer</div>
						</div>
					)}
					<div className="flex gap-2 mt-2">
						{/* The agent's question is already rendered above; point at it instead of
						    duplicating it into a placeholder that vanishes mid-answer. This is the
						    field where someone types a legal name or a salary because the agent
						    refused to guess — losing the question while typing is the worst case. */}
						<input aria-labelledby={fieldLabelId} value={inputVal} onChange={(e) => setInputVal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") sendValue(inputVal); }} placeholder={field} className="flex-1 min-w-0 bg-panel border border-line rounded-lg px-3 py-2.5 text-base text-ink" />
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
						<button type="button" onClick={resume} className="px-5 py-2.5 rounded-lg bg-success-soft text-success font-bold text-base">Resume — I’ve done it</button>
					</div>
				</div>
			)}
			{takeoverOpen && (
				<TakeoverLive instanceId={instanceId} taskId={taskId} kind={kind} onClose={() => setTakeoverOpen(false)} onResume={() => { setTakeoverOpen(false); resume(); }} />
			)}

			{/* ── Per-ticket conversation (#150 P2) ─────────────────────────── */}
			<TicketThread instanceId={instanceId} taskId={taskId} autoFocus={askIntent} />

			{/* ── Screenshot replay ─────────────────────────────────────────── */}
			{shots.length > 0 ? (
				<Card className="mb-5">
					<div className="flex items-center gap-3 mb-3">
						<button type="button" onClick={() => setPlaying((p) => !p)} className="w-9 h-9 flex items-center justify-center rounded-lg bg-accent text-white shrink-0" aria-label={playing ? "Pause" : "Play"}>
							{playing ? <Pause size={16} /> : <Play size={16} />}
						</button>
						<button type="button" onClick={() => { setPlaying(false); setIdx((i) => Math.max(0, i - 1)); }} disabled={idx <= 0} className="w-8 h-8 flex items-center justify-center rounded-lg border border-line text-muted disabled:opacity-30" aria-label="Previous"><ChevronLeft size={16} /></button>
						<button type="button" onClick={() => { setPlaying(false); setIdx((i) => Math.min(shots.length - 1, i + 1)); }} disabled={idx >= shots.length - 1} className="w-8 h-8 flex items-center justify-center rounded-lg border border-line text-muted disabled:opacity-30" aria-label="Next"><ChevronRight size={16} /></button>
						{/* The play/prev/next buttons around it are all named; the scrubber — the only
						    one you can drag to an arbitrary step — was not, and the "3/12" beside it
						    is a separate node a screen reader does not attach. */}
						<input type="range" min={0} max={Math.max(0, shots.length - 1)} value={idx} onChange={(e) => { setPlaying(false); setIdx(Number(e.target.value)); }} className="flex-1 min-w-0 accent-accent" aria-label="Step" aria-valuetext={`Step ${idx + 1} of ${shots.length}`} />
						<span className="text-xs text-muted-soft font-mono shrink-0">{idx + 1}/{shots.length}</span>
					</div>

					<div className="rounded-lg overflow-hidden border border-line bg-paper flex items-center justify-center min-h-[240px]">
							{cur && shotUrls[cur.seq] ? (
								<img src={shotUrls[cur.seq]} alt={`Step ${cur.seq}`} width={1280} height={720} className="w-full max-h-[520px] object-contain" />
							) : (
							<span className="text-sm text-muted-soft py-16">Loading screenshot…</span>
						)}
					</div>

					{cur && (
						<div className="flex items-baseline justify-between gap-3 mt-2.5">
							<div className="text-sm text-ink">
								<span className="font-semibold">Step {cur.seq}:</span> {cur.msg || humanEvent({ type: "agent.decision", message: cur.action } as RuntimeEvent)}
							</div>
							<span className="text-xs text-muted-soft font-mono shrink-0">{fmtStamp(cur.at)}</span>
						</div>
					)}
				</Card>
			) : (
				<div className="bg-panel border border-line rounded-xl p-4 mb-5 text-sm text-muted-soft">
					No screenshots for this run{running ? " yet — they appear as the agent acts." : " (older run, before screenshot capture)."}
				</div>
			)}

			{/* ── Full timestamped activity log ─────────────────────────────── */}
			<Card>
				<h2 className="text-sm font-bold mb-3">Activity — everything the agent did</h2>
				{events.length === 0 ? (
					<div className="text-sm text-muted-soft py-4 text-center">No activity yet.</div>
				) : (
					<div className="flex flex-col">
						{events.filter((e) => e.type !== "agent.shot").map((ev) => {
							const data = (ev.data as Record<string, unknown>) ?? {};
							const thought = data.thought as string | undefined;
							// An email the agent read/received → a click-through to open it in Gmail.
							const gmailUrl = typeof data.gmailUrl === "string" ? data.gmailUrl : "";
							const emailFrom = typeof data.from === "string" ? data.from : "";
							return (
								<div key={ev.id} className="flex gap-3 py-1.5 border-b border-line last:border-0 text-sm">
									<span className="text-xs font-mono text-muted-soft shrink-0 w-[124px] pt-0.5">{fmtStamp(ev.createdAt ?? ev.timestamp)}</span>
									<div className="min-w-0 flex-1">
										<div className={levelClass(ev.type)}>{linkify(humanEvent(ev))}</div>
										{gmailUrl && (
											<div className="text-xs mt-0.5">
												{emailFrom && <span className="text-muted-soft">from {emailFrom} · </span>}
												<a href={gmailUrl} target="_blank" rel="noreferrer" className="text-accent font-semibold hover:underline">Open in Gmail →</a>
											</div>
										)}
										{thought && <div className="text-xs text-muted-soft mt-0.5 line-clamp-2">{linkify(thought)}</div>}
									</div>
								</div>
							);
						})}
					</div>
				)}
			</Card>
		</Page>
	);
}
