import { useModalLock } from "@proagentstore/sdk/hooks";
import { Info, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { ChartSpec } from "../lib/fleetTelemetry";
import Button from "./Button";
import Card from "./Card";

type Metric = ChartSpec["id"] | "availability";

const HELP: Record<Metric, readonly string[]> = {
	availability: [
		"Each mark is a heartbeat's server receipt: PAGS received a message from that machine at that time. Hover over a mark for receipt counts and the first and last times in its bucket. Joining those endpoints does not establish continuous availability between them.",
		"Gray means no heartbeat was recorded; availability is unknown. This is not a ping test and does not prove whether the computer is powered on or coding. History is collected after this update, so empty earlier periods are unknown too.",
	],
	load: [
		"The system's one-minute load divided by CPU core count. This is a load ratio, not a CPU usage percentage. The 1.5 line is an overload guide.",
		"The vertical axis is logarithmic: each tenfold increase occupies the same distance. Windows has no load average, so its line is omitted rather than shown as idle.",
	],
	disk: [
		"Percentage of storage used on the checkout volume, where PAGS keeps its working copies. This does not measure every drive on the computer. The 90% guide highlights limited room for checkouts and builds.",
	],
	relay: [
		"PAGS relay round-trip time in milliseconds. It measures how long a correlated request and reply took through the relay, not how much coding work was completed.",
		"The vertical axis is logarithmic: each tenfold increase occupies the same distance. A late reply can indicate a transport delay; it does not establish whether the computer is powered off.",
	],
	restarts: [
		"The reported count of runner process starts in the preceding 24 hours, including updates and manual restarts. These are PAGS runner starts, not computer reboots.",
		"An increase alone does not establish a crash loop. Use the runner's logs to determine why it restarted.",
	],
	sessions: [
		"The machine's reported session count. Sessions can include retained or waiting contexts, so this count does not establish how many agents are actively coding.",
		"Each dashed line is that machine's hardware-based recommended maximum. It is guidance and may differ from the configured admission limit that controls whether more work can start.",
	],
	memory: [
		"Percentage of RAM reported as used on Linux and Windows. macOS is omitted because its cache-inclusive used-memory figure would make a healthy machine look under pressure.",
		"A high reading alone does not establish a memory leak. This graph does not measure macOS memory pressure.",
	],
};

const RESOURCE_HISTORY = "Missing samples appear as gaps, not zero. A stale line ends at its last reading. The 24-hour resource view uses the worst readings in five-minute buckets; an old reading does not establish current availability.";
const ICON_TARGET = "shrink-0 w-11 h-11 sm:w-7 sm:h-7 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

function GraphInfoDialog({ metric, title, id, onClose }: { metric: Metric; title: string; id: string; onClose: () => void }) {
	const panel = useRef<HTMLDivElement>(null);
	useModalLock(panel);
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [onClose]);
	return (
		<div className="fixed inset-0 z-[100] bg-black/50 grid place-items-center p-4" role="presentation" data-graph-info-backdrop onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
			<div ref={panel} id={id} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`} className="relative w-full max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto overscroll-contain">
				<Card>
					<div className="flex items-center justify-between gap-3 mb-3">
						<h2 id={`${id}-title`} className="text-base font-bold">About {title}</h2>
						<Button variant="ghost" size="icon" className={ICON_TARGET} aria-label="Close graph information" onClick={onClose}><X size={18} aria-hidden="true" /></Button>
					</div>
					<div id={`${id}-body`} className="text-sm space-y-3">
						{HELP[metric].map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
						{metric !== "availability" && <p>{RESOURCE_HISTORY}</p>}
					</div>
				</Card>
			</div>
		</div>
	);
}

export default function GraphInfo({ metric, title }: { metric: Metric; title: string }) {
	const [open, setOpen] = useState(false);
	const id = useId();
	return <>
		<Button variant="ghost" size="icon" className={ICON_TARGET} aria-label={`About ${title}`} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={(event) => { event.currentTarget.focus(); setOpen(true); }}><Info size={16} aria-hidden="true" /></Button>
		{open && <GraphInfoDialog metric={metric} title={title} id={id} onClose={() => setOpen(false)} />}
	</>;
}
