import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type Ref } from "react";
import { ArrowLeft, ArrowRight, Maximize2, Minimize2, RotateCw, ZoomIn, ZoomOut } from "lucide-react";
import Button from "./Button";
import { type Box, clampView, doubleTap, fitBox, IDENTITY, panBy, type Point, toPage, transformOf, type View, zoomAt } from "../lib/remoteView";

/** One frame of the remote page: a JPEG, the page's CSS viewport, and — from a 0.4.136+ runner — its address. */
export interface RemoteFrame {
	frame: string;
	width: number;
	height: number;
	url?: string;
}

const TAP_SLOP = 8; // px a finger may wander and still be a tap
const DOUBLE_TAP_MS = 280;
const DOUBLE_TAP_SLOP = 30;

/**
 * The live remote browser, as a browser (#1105) — shared by every takeover view.
 *
 * On a phone the page was a postage stamp nobody could read or tap. So: pinch and double-tap zoom with
 * pan, one finger scrolls the page when not zoomed, a tap reaches the exact page point at any zoom
 * (`lib/remoteView.ts`); full-screen by default on a touch device with one overlaid exit button; and
 * back, forward, reload and an editable address bar, because SEEK's apply flow detours through its
 * sign-in and back and a wrong turn stranded the session. A single tap waits out the double-tap window
 * before it clicks, so a zoom never also presses whatever was under the finger.
 */
export default function RemoteBrowser({ frame, placeholder, notices, alt, send, refresh, entryNote, entryRef, onEscape, onTapped, defaultImmersive = false }: {
	frame: RemoteFrame | null;
	placeholder: ReactNode;
	/** The view's own refusals and errors: shown under the controls, full-screen or not. */
	notices?: ReactNode;
	alt: string;
	/** Relay one input event to the page (fire-and-forget; the frame poll is the feedback). */
	send: (input: Record<string, unknown>) => void;
	/** Poll a frame soon, after an action. */
	refresh: () => void;
	entryNote: string;
	entryRef?: Ref<HTMLInputElement>;
	onEscape: () => void;
	onTapped?: () => void;
	defaultImmersive?: boolean;
}) {
	const rootRef = useRef<HTMLDivElement>(null);
	const areaRef = useRef<HTMLDivElement>(null);
	const stageRef = useRef<HTMLDivElement>(null);
	const [area, setArea] = useState<Box>({ w: 0, h: 0 });
	const [view, setView] = useState<View>(IDENTITY);
	const [immersive, setImmersive] = useState(false);
	const [address, setAddress] = useState("");
	const [editing, setEditing] = useState(false);
	const viewRef = useRef(view);
	viewRef.current = view;
	const box = frame ? fitBox(area, frame) : { w: 0, h: 0 };
	const boxRef = useRef(box);
	boxRef.current = box;
	const frameRef = useRef(frame);
	frameRef.current = frame;

	useEffect(() => {
		if (!editing && frame?.url) setAddress(frame.url);
	}, [frame?.url, editing]);

	useEffect(() => {
		const el = areaRef.current;
		if (!el) return;
		const read = () => setArea({ w: el.clientWidth, h: el.clientHeight });
		read();
		const ro = new ResizeObserver(read);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	// A resize (rotation, the keyboard opening) changes the stage: keep the view inside it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the stage SIZE; `box` is a fresh object every render.
	useEffect(() => setView((v) => clampView(v, boxRef.current)), [box.w, box.h]);

	const enterImmersive = useCallback(() => {
		setImmersive(true);
		// Real full-screen where the platform allows it; an iPhone does not, and the overlay covering the
		// viewport is the full-screen there. Either way there is one way out: the exit button.
		rootRef.current?.requestFullscreen?.().catch(() => undefined);
	}, []);
	const exitImmersive = useCallback(() => {
		setImmersive(false);
		if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
	}, []);
	useEffect(() => {
		if (defaultImmersive) enterImmersive();
		const left = () => {
			if (!document.fullscreenElement) setImmersive(false);
		};
		document.addEventListener("fullscreenchange", left);
		return () => {
			document.removeEventListener("fullscreenchange", left);
			if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
		};
	}, [defaultImmersive, enterImmersive]);

	const stagePoint = (clientX: number, clientY: number): Point | null => {
		const r = stageRef.current?.getBoundingClientRect();
		return r ? { x: clientX - r.left, y: clientY - r.top } : null;
	};
	const pagePoint = (p: Point | null) => (p && frameRef.current ? toPage(viewRef.current, p, boxRef.current, frameRef.current) : null);

	const click = (p: Point | null) => {
		const at = pagePoint(p);
		if (!at) return;
		send({ type: "click", ...at });
		rootRef.current?.focus();
		onTapped?.();
		setTimeout(refresh, 150);
	};

	// ── gestures ───────────────────────────────────────────────────────────────────────────────
	const pointers = useRef(new Map<number, Point>());
	const gesture = useRef<{ kind: "tap" | "pan" | "scroll" | "pinch"; start: Point; last: Point; t0: number; dist?: number; base?: View; mid?: Point } | null>(null);
	const lastTap = useRef<{ at: Point; t: number; timer: ReturnType<typeof setTimeout> } | null>(null);
	const lastMove = useRef(0);
	const lastScroll = useRef(0);
	const midOf = () => {
		const [a, b] = [...pointers.current.values()];
		return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
	};

	const onDown = (e: PointerEvent) => {
		const p = stagePoint(e.clientX, e.clientY);
		if (!p) return;
		e.currentTarget.setPointerCapture(e.pointerId);
		pointers.current.set(e.pointerId, p);
		if (pointers.current.size === 1) gesture.current = { kind: "tap", start: p, last: p, t0: Date.now() };
		else if (pointers.current.size === 2) {
			const { mid, dist } = midOf();
			gesture.current = { kind: "pinch", start: mid, last: mid, t0: Date.now(), dist, base: viewRef.current, mid };
		}
	};
	const onMove = (e: PointerEvent) => {
		const p = stagePoint(e.clientX, e.clientY);
		if (!p) return;
		if (!pointers.current.has(e.pointerId)) {
			// A mouse hovering: the page's own hover states (menus) need it, throttled.
			const now = Date.now();
			if (e.pointerType === "mouse" && now - lastMove.current > 90) {
				lastMove.current = now;
				const at = pagePoint(p);
				if (at) send({ type: "move", ...at });
			}
			return;
		}
		pointers.current.set(e.pointerId, p);
		const g = gesture.current;
		if (!g) return;
		if (g.kind === "pinch" && pointers.current.size >= 2 && g.base && g.mid && g.dist) {
			const { mid, dist } = midOf();
			const zoomed = zoomAt(g.base, g.base.scale * (dist / g.dist), g.mid, boxRef.current);
			setView(panBy(zoomed, mid.x - g.mid.x, mid.y - g.mid.y, boxRef.current));
			return;
		}
		if (g.kind === "tap" && Math.hypot(p.x - g.start.x, p.y - g.start.y) > TAP_SLOP) g.kind = viewRef.current.scale > 1 ? "pan" : "scroll";
		if (g.kind === "pan") setView((v) => panBy(v, p.x - g.last.x, p.y - g.last.y, boxRef.current));
		if (g.kind === "scroll") {
			const now = Date.now();
			if (now - lastScroll.current < 40) return; // keep `last` so the skipped distance is sent next time
			lastScroll.current = now;
			const at = pagePoint(p);
			const k = frameRef.current && boxRef.current.w ? frameRef.current.width / boxRef.current.w : 1;
			if (at) send({ type: "scroll", ...at, deltaX: Math.round((g.last.x - p.x) * k), deltaY: Math.round((g.last.y - p.y) * k) });
			setTimeout(refresh, 120);
		}
		g.last = p;
	};
	const onUp = (e: PointerEvent) => {
		pointers.current.delete(e.pointerId);
		const g = gesture.current;
		if (pointers.current.size > 0) {
			// One finger of a pinch lifted: carry on as a pan from where the other one is.
			if (g?.kind === "pinch") {
				const rest = [...pointers.current.values()][0];
				gesture.current = { kind: "pan", start: rest, last: rest, t0: Date.now() };
			}
			return;
		}
		gesture.current = null;
		if (g?.kind !== "tap" || Date.now() - g.t0 > 600) return;
		if (e.pointerType === "mouse") return click(g.start); // no double-tap zoom on a mouse: click at once
		const prev = lastTap.current;
		if (prev && Date.now() - prev.t < DOUBLE_TAP_MS && Math.hypot(prev.at.x - g.start.x, prev.at.y - g.start.y) < DOUBLE_TAP_SLOP) {
			clearTimeout(prev.timer);
			lastTap.current = null;
			setView((v) => doubleTap(v, g.start, boxRef.current));
			return;
		}
		const at = g.start;
		lastTap.current = { at, t: Date.now(), timer: setTimeout(() => {
			lastTap.current = null;
			click(at);
		}, DOUBLE_TAP_MS) };
	};

	// Wheel: scroll the page; ctrl/⌘ + wheel (a trackpad pinch) zooms. Native and non-passive, or
	// preventDefault is ignored and the overlay eats the gesture.
	useEffect(() => {
		const el = areaRef.current;
		if (!el) return;
		let last = 0;
		const wheel = (ev: WheelEvent) => {
			ev.preventDefault();
			const r = stageRef.current?.getBoundingClientRect();
			if (!r) return;
			const p = { x: ev.clientX - r.left, y: ev.clientY - r.top };
			if (ev.ctrlKey || ev.metaKey) return setView((v) => zoomAt(v, v.scale * Math.exp(-ev.deltaY / 200), p, boxRef.current));
			const now = Date.now();
			if (now - last < 40) return;
			last = now;
			const f = frameRef.current;
			const at = f ? toPage(viewRef.current, p, boxRef.current, f) : null;
			if (at) send({ type: "scroll", ...at, deltaX: Math.round(ev.deltaX), deltaY: Math.round(ev.deltaY) });
			setTimeout(refresh, 120);
		};
		el.addEventListener("wheel", wheel, { passive: false });
		return () => el.removeEventListener("wheel", wheel);
	}, [send, refresh]);

	const onKey = (e: KeyboardEvent) => {
		if (e.key === "Escape") return immersive ? exitImmersive() : onEscape();
		if (e.key === "Tab") return;
		e.preventDefault();
		if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) send({ type: "text", text: e.key });
		else send({ type: "key", key: e.key, code: e.code, keyCode: e.keyCode });
		setTimeout(refresh, 150);
	};
	const control = (type: "back" | "forward" | "reload") => () => {
		send({ type });
		setTimeout(refresh, 400);
	};
	const zoomBy = (factor: number) => setView((v) => zoomAt(v, v.scale * factor, { x: boxRef.current.w / 2, y: boxRef.current.h / 2 }, boxRef.current));

	return (
		// biome-ignore lint/a11y/noNoninteractiveTabindex: the remote page's keyboard is captured here.
		<div ref={rootRef} role="application" aria-label={`${alt} control`} tabIndex={0} onKeyDown={onKey} data-testid="remote-browser" data-immersive={immersive ? "true" : "false"} className={`${immersive ? "fixed inset-0 z-[110]" : "relative flex-1 min-h-0"} bg-black flex flex-col outline-none`}>
			<form
				className="shrink-0 flex items-center gap-1 px-2 py-1.5 bg-panel border-b border-line"
				onSubmit={(e) => {
					e.preventDefault();
					setEditing(false);
					if (address.trim()) send({ type: "navigate", url: address.trim() });
					setTimeout(refresh, 600);
				}}
			>
				<Button size="icon" variant="ghost" onClick={control("back")} aria-label="Back" data-testid="remote-back"><ArrowLeft size={16} /></Button>
				<Button size="icon" variant="ghost" onClick={control("forward")} aria-label="Forward" data-testid="remote-forward"><ArrowRight size={16} /></Button>
				<Button size="icon" variant="ghost" onClick={control("reload")} aria-label="Reload" data-testid="remote-reload"><RotateCw size={16} /></Button>
				<input
					aria-label="Address"
					data-testid="remote-address"
					value={address}
					inputMode="url"
					enterKeyHint="go"
					autoCapitalize="none"
					autoCorrect="off"
					spellCheck={false}
					onFocus={() => setEditing(true)}
					onBlur={() => setEditing(false)}
					onChange={(e) => setAddress(e.currentTarget.value)}
					onKeyDown={(e) => e.stopPropagation()}
					className="min-w-0 flex-1 rounded border border-line bg-paper px-2 py-1 text-sm text-ink"
				/>
				<Button size="icon" variant="ghost" onClick={() => zoomBy(1 / 1.5)} aria-label="Zoom out" data-testid="remote-zoom-out"><ZoomOut size={16} /></Button>
				<Button size="icon" variant="ghost" onClick={() => zoomBy(1.5)} aria-label="Zoom in" data-testid="remote-zoom-in"><ZoomIn size={16} /></Button>
				{!immersive && <Button size="icon" variant="ghost" onClick={enterImmersive} aria-label="Full screen" data-testid="remote-fullscreen"><Maximize2 size={16} /></Button>}
			</form>
			<MobileTakeoverEntry
				inputRef={entryRef}
				onText={(value) => {
					const ev = mobileTakeoverText(value);
					if (ev) send(ev);
					setTimeout(refresh, 150);
				}}
				onKey={(key) => {
					send(mobileTakeoverKey(key));
					setTimeout(refresh, 150);
				}}
				note={entryNote}
			/>
			{notices}
			<div
				ref={areaRef}
				className="relative flex-1 min-h-0 overflow-hidden flex items-center justify-center select-none"
				style={{ touchAction: "none" }}
				onPointerDown={onDown}
				onPointerMove={onMove}
				onPointerUp={onUp}
				onPointerCancel={onUp}
				data-testid="remote-stage-area"
			>
				{frame ? (
					<div ref={stageRef} className="relative overflow-hidden" style={{ width: box.w, height: box.h }} data-testid="remote-stage" data-scale={view.scale}>
						<img
							src={frame.frame}
							alt={alt}
							draggable={false}
							width={frame.width}
							height={frame.height}
							className="absolute left-0 top-0 max-w-none origin-top-left cursor-crosshair"
							style={{ width: box.w, height: box.h, transform: transformOf(view) }}
						/>
					</div>
				) : (
					<div className="text-sm text-white/70 max-w-lg text-center px-4">{placeholder}</div>
				)}
			</div>
			{/* Outside the gesture area, so a tap on it is never the start of a pan or a page tap. */}
			{immersive && (
				<Button variant="secondary" size="sm" className="absolute right-3 bottom-3" onClick={exitImmersive} data-testid="remote-exit-fullscreen">
					<Minimize2 size={14} /> Exit full screen
				</Button>
			)}
		</div>
	);
}

/**
 * The only text-bearing relay this component can make.  It is intentionally a browser takeover
 * event, not an application-field action: the Runner rechecks that a login/CAPTCHA blocker is
 * still present before accepting it.  Callers clear the native control immediately afterwards.
 */
export function mobileTakeoverText(value: string): { type: "text"; text: string } | null {
	return value ? { type: "text", text: value } : null;
}

/** Mobile keyboards do not reliably emit physical key events, so expose only login-safe keys. */
export function mobileTakeoverKey(key: "Enter" | "Backspace"): { type: "key"; key: string; code: string } {
	return { type: "key", key, code: key === "Enter" ? "Enter" : "Backspace" };
}

/**
 * The phone's way in: a native input that summons the keyboard. A captured `<div>` gets no keystrokes on
 * a phone, so without this a remote sign-in page is visible but cannot be typed into (#1100). Used by
 * every live browser view the console opens.
 */
export function MobileTakeoverEntry({ inputRef, onText, onKey, note }: { inputRef?: Ref<HTMLInputElement>; onText: (value: string) => void; onKey: (key: "Enter" | "Backspace") => void; note: string }) {
	return (
		<div className="shrink-0 flex flex-wrap items-center gap-2 px-3 sm:px-4 py-2 bg-panel border-b border-line" data-testid="application-handoff-mobile-entry">
			<label className="sr-only" htmlFor="application-handoff-mobile-entry">Secure sign-in or verification entry</label>
			<input
				id="application-handoff-mobile-entry"
				ref={inputRef}
				type="text"
				inputMode="text"
				enterKeyHint="next"
				autoComplete="off"
				autoCapitalize="none"
				autoCorrect="off"
				spellCheck={false}
				data-testid="application-handoff-mobile-text-entry"
				placeholder="Tap after selecting the login or code field"
				className="min-w-0 flex-1 rounded border border-line bg-paper px-3 py-2 text-base text-ink"
				onChange={(e) => {
					onText(e.currentTarget.value);
					// Native input is ephemeral: it exists to summon the phone keyboard, never as a credential
					// store or a rendered echo. The remote page alone receives its text event.
					e.currentTarget.value = "";
				}}
				onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Enter" || e.key === "Backspace") { e.preventDefault(); onKey(e.key); } }}
			/>
			<Button type="button" variant="secondary" size="sm" onClick={() => onKey("Backspace")}>Delete</Button>
			<Button type="button" variant="secondary" size="sm" onClick={() => onKey("Enter")}>Continue</Button>
			<p className="basis-full text-xs text-muted-soft">Phone-only sign-in/CAPTCHA control. Text is forwarded once and immediately cleared here; {note}</p>
		</div>
	);
}
