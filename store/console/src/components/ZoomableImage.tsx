import { useEffect, useRef, useState, type ReactNode } from "react";
import { Maximize2, Minus, Plus, X } from "lucide-react";

const STEPS = [1, 1.5, 2, 3, 4];

/**
 * A browser preview that fits the available width and opens full-screen on tap (#1668).
 * The full-screen view has labelled zoom controls (so zoom never depends on a pinch), and the
 * image stays scrollable and pinch-zoomable by the browser (`touch-action: pan-x pan-y pinch-zoom`).
 * `overlayExtra` renders pinned to the bottom of the overlay — the primary action stays reachable.
 */
export default function ZoomableImage({ src, alt, width, height, className = "", overlayExtra }: {
	src: string;
	alt: string;
	width?: number;
	height?: number;
	className?: string;
	overlayExtra?: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const [step, setStep] = useState(0);
	const closeRef = useRef<HTMLButtonElement>(null);
	const openerRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
		window.addEventListener("keydown", onKey, true);
		closeRef.current?.focus();
		const opener = openerRef.current;
		return () => { window.removeEventListener("keydown", onKey, true); opener?.focus(); };
	}, [open]);
	const close = () => { setOpen(false); setStep(0); };
	return <>
		<button ref={openerRef} type="button" onClick={() => setOpen(true)} aria-label="Zoom preview" data-testid="preview-zoom-open" className="relative block w-full min-w-0 cursor-zoom-in">
			<img src={src} alt={alt} width={width} height={height} className={`w-full max-h-[640px] object-contain ${className}`} />
			<span aria-hidden="true" className="absolute bottom-2 right-2 rounded-lg bg-panel border border-line p-2 text-muted"><Maximize2 size={16} /></span>
		</button>
		{open && (
			<div role="dialog" aria-modal="true" aria-label="Zoomed preview" data-testid="preview-zoom-dialog" className="fixed inset-0 z-[90] bg-black/90 flex flex-col">
				<div className="flex items-center justify-end gap-2 p-2 shrink-0">
					<button type="button" aria-label="Zoom out" disabled={step === 0} onClick={() => setStep((s) => Math.max(0, s - 1))} className="min-w-11 min-h-11 flex items-center justify-center rounded-lg bg-panel border border-line text-ink disabled:opacity-40"><Minus size={18} /></button>
					<span className="text-sm text-white font-mono min-w-12 text-center" aria-live="polite" data-testid="preview-zoom-level">{Math.round(STEPS[step] * 100)}%</span>
					<button type="button" aria-label="Zoom in" disabled={step === STEPS.length - 1} onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))} className="min-w-11 min-h-11 flex items-center justify-center rounded-lg bg-panel border border-line text-ink disabled:opacity-40"><Plus size={18} /></button>
					<button ref={closeRef} type="button" aria-label="Close preview" onClick={close} className="min-w-11 min-h-11 flex items-center justify-center rounded-lg bg-panel border border-line text-ink"><X size={18} /></button>
				</div>
				<div className="flex-1 min-h-0 overflow-auto" style={{ touchAction: "pan-x pan-y pinch-zoom" }} data-testid="preview-zoom-scroller">
					<img src={src} alt={alt} style={{ width: `${STEPS[step] * 100}%`, maxWidth: "none" }} className="block h-auto mx-auto" />
				</div>
				{overlayExtra && <div className="shrink-0 flex justify-center p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{overlayExtra}</div>}
			</div>
		)}
	</>;
}
