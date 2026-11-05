import { availabilityLanes, heartbeatAge } from "../lib/fleetAvailability";
import { type FleetMachine, type FleetTier, seriesColor, TIER_WINDOW_MS } from "../lib/fleetTelemetry";
import Card from "./Card";

/** PAGS receipt history comes first; resource samples and host-power guesses are not inputs. */
export default function AvailabilityTimeline({ machines, tier, nowMs }: { machines: readonly FleetMachine[]; tier: FleetTier; nowMs: number }) {
	const lanes = availabilityLanes(machines, tier, nowMs);
	const stamp = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
	return (
		<Card className="mb-4" role="region" aria-label="Availability history">
			<h2 className="text-sm font-bold">Availability — PAGS heartbeat</h2>
			<p className="text-2xs text-muted-soft mt-1 mb-3">Marks show heartbeats received by PAGS. Gray means no heartbeat recorded; availability is unknown.</p>
			<div className="space-y-2">
				{lanes.map((lane) => (
					<div key={lane.key} className="grid grid-cols-[108px_minmax(0,1fr)] gap-2 items-center" data-availability-machine={lane.key}>
						<div className="min-w-0">
							<div className="text-xs font-semibold truncate" title={lane.name}>
								<span aria-hidden="true" className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: seriesColor(lane.colorIndex) }} />{lane.name}
							</div>
							<div className="text-2xs text-muted-soft">{lane.readError ? "History unavailable" : heartbeatAge(lane.lastReceivedAt, nowMs)}{lane.partial ? " · partial" : ""}</div>
						</div>
						<svg className="w-full h-5 rounded" viewBox="0 0 1000 20" preserveAspectRatio="none" role="img" aria-label={`${lane.name}: ${lane.readError ? "heartbeat history unavailable" : `${lane.marks.reduce((total, mark) => total + mark.receipts, 0)} recorded heartbeats; ${heartbeatAge(lane.lastReceivedAt, nowMs)}`}`}>
							<rect width="1000" height="20" fill="var(--color-line)" />
							{lane.marks.map((mark) => (
								<g key={`${mark.firstMs}:${mark.lastMs}`} fill={seriesColor(lane.colorIndex)}>
									<title>{mark.receipts} heartbeat{mark.receipts === 1 ? "" : "s"} received: {new Date(mark.firstMs).toLocaleString()}{mark.lastMs !== mark.firstMs ? ` — ${new Date(mark.lastMs).toLocaleString()}` : ""}</title>
									{/* Only observed receipt endpoints are solid. A span joins the first/last receipt,
									    and does not extend to the bin edges or imply continuous uptime. */}
									{mark.lastX > mark.firstX && <rect x={mark.firstX} y="8" width={mark.lastX - mark.firstX} height="4" opacity="0.35" />}
									<rect x={Math.min(998, mark.firstX)} y="3" width="2" height="14" />
									{mark.lastX !== mark.firstX && <rect x={Math.min(998, mark.lastX)} y="3" width="2" height="14" />}
								</g>
							))}
						</svg>
					</div>
				))}
			</div>
			<div className="ml-[116px] flex justify-between text-2xs text-muted-soft mt-1" aria-hidden="true">
				{[0, 0.5, 1].map((fraction) => <span key={fraction}>{stamp(nowMs - TIER_WINDOW_MS[tier] * (1 - fraction))}</span>)}
			</div>
			<p className="text-2xs text-muted-soft mt-2">Heartbeat history is collected after this update. Empty earlier periods are unknown. Hover over a mark for receipt counts and times.</p>
		</Card>
	);
}
