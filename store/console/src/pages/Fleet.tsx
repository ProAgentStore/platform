import { Activity, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import Button from "../components/Button";
import Card from "../components/Card";
import FleetCharts from "../components/FleetCharts";
import Page from "../components/Page";
import { useFleet } from "../hooks/useFleet";
import { type FleetRow, type FleetTier, type StatusTone, seriesColor, sortedRows } from "../lib/fleetTelemetry";

const PILL: Record<StatusTone, string> = {
	success: "bg-success-soft text-success border-success-line",
	warning: "bg-warning-soft text-warning border-warning-line",
	danger: "bg-danger-soft text-danger border-danger-line",
	muted: "bg-panel text-muted border-line",
};

function Pill({ row }: { row: FleetRow }) {
	return (
		<span className={`inline-block rounded-full border px-2 py-0.5 text-2xs font-semibold whitespace-nowrap ${PILL[row.status.tone]}`} title={row.status.issues.join("\n") || "No rule fired"}>
			{row.status.label}
		</span>
	);
}

const RANGES: Array<{ tier: FleetTier; label: string }> = [
	{ tier: "dense", label: "Last 2 h" },
	{ tier: "coarse", label: "Last 24 h" },
];

/**
 * Live telemetry for every runner machine you own (#1259): the same graphs the Terminals page cannot draw, one screen, shared scales,
 * and a heartbeat's worth of new points appended about every 30 s without a reload. The rules and geometry are in lib/fleetTelemetry.ts.
 */
export default function Fleet() {
	const [tier, setTier] = useState<FleetTier>("dense");
	const { data, loading, error, updatedAt, nowMs, reload } = useFleet(tier);
	const machines = data?.machines ?? [];
	const rows = sortedRows(machines);

	return (
		<Page width={1100}>
			<div className="flex flex-wrap justify-between items-center gap-2 mb-1">
				<div className="flex items-center gap-2.5">
					<Activity size={20} className="text-accent" />
					<h1 className="font-display text-xl font-bold">Fleet</h1>
				</div>
				<div className="flex items-center gap-2">
					<fieldset className="inline-flex rounded-md border border-line overflow-hidden m-0 p-0 min-w-0">
						<legend className="sr-only">Range</legend>
						{RANGES.map((r) => (
							<button
								key={r.tier}
								type="button"
								onClick={() => setTier(r.tier)}
								aria-pressed={tier === r.tier}
								className={`px-3 py-1 text-xs ${tier === r.tier ? "bg-accent-soft text-accent font-semibold" : "text-muted hover:bg-panel-hover"}`}
							>
								{r.label}
							</button>
						))}
					</fieldset>
					<Button onClick={() => void reload()} disabled={loading} aria-label="Reload fleet telemetry">
						<RefreshCw size={14} className={loading ? "animate-spin" : ""} />
					</Button>
				</div>
			</div>
			<p className="text-sm text-muted mb-4">
				Resource telemetry for every machine running <code className="text-accent">pags up</code> under your account. Live: new heartbeats appear here about every 30 seconds.
				{updatedAt !== null && <span className="text-muted-soft"> Updated {new Date(updatedAt).toLocaleTimeString()}.</span>}
			</p>

			{error && (
				<Card className="mb-4 text-sm text-danger border-danger-line" role="alert">
					Could not refresh: {error}. {data ? "Showing the last data received." : ""}
				</Card>
			)}
			{data?.truncated && <p className="text-2xs text-warning mb-3">More machines than fit on this page; the most recently seen are shown.</p>}

			{loading && !data ? (
				<p className="text-center py-8 text-muted text-sm">Loading…</p>
			) : machines.length === 0 ? (
				<Card className="text-sm text-muted">
					No machines yet. Run <code className="text-accent">pags up</code> on a machine — it appears here once it has sent a heartbeat. See <Link to="/terminals" className="text-accent">Terminals</Link>.
				</Card>
			) : (
				<>
					<Card className="mb-4 overflow-x-auto">
						<table className="w-full text-xs min-w-[760px]">
							<thead>
								<tr className="text-left text-muted-soft">
									{["Machine", "Status", "Hardware", "Sessions / max", "Disk", "Load/core 24 h", "Relay p50", "Restarts", "Supervisor", "Last sample"].map((h) => (
										<th key={h} className="font-semibold pb-2 pr-3 whitespace-nowrap">
											{h}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{rows.map((r) => {
									const idx = machines.findIndex((m) => m.key === r.key);
									const m = machines[idx];
									return (
										<tr key={r.key} className="border-t border-line align-top">
											<td className="py-1.5 pr-3 font-semibold whitespace-nowrap">
												<span aria-hidden="true" className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: seriesColor(idx) }} />
												{m.machineId ? (
													<Link to={`/terminals/machines/${encodeURIComponent(m.machineId)}`} className="hover:text-accent">
														{r.name}
													</Link>
												) : (
													r.name
												)}
											</td>
											<td className="py-1.5 pr-3">
												<Pill row={r} />
											</td>
											<td className="py-1.5 pr-3 text-muted whitespace-nowrap">{r.hardware}</td>
											<td className="py-1.5 pr-3">{r.sessions}</td>
											<td className="py-1.5 pr-3">{r.disk}</td>
											<td className="py-1.5 pr-3 whitespace-nowrap">{r.load24h}</td>
											<td className="py-1.5 pr-3">{r.relayP50}</td>
											<td className="py-1.5 pr-3">{r.restarts}</td>
											<td className="py-1.5 pr-3">{r.supervisor}</td>
											<td className="py-1.5 text-muted-soft whitespace-nowrap">{r.lastSample}</td>
										</tr>
									);
								})}
							</tbody>
						</table>
						<p className="text-2xs text-muted-soft mt-2">Load and relay figures are from 5-minute worst-of buckets over the last 24 hours. A machine with no heartbeat for 3 minutes is offline; its line ends where it stopped.</p>
					</Card>
					<FleetCharts machines={machines} tier={tier} nowMs={nowMs} />
				</>
			)}
		</Page>
	);
}
