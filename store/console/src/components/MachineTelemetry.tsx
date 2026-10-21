import { useState } from "react";
import { useFleet } from "../hooks/useFleet";
import type { FleetTier } from "../lib/fleetTelemetry";
import Card from "./Card";
import FleetCharts from "./FleetCharts";

/** This one machine's live graphs (#1259) — the same charts and live updates as the Fleet page, narrowed to a single series. */
export default function MachineTelemetry({ machineId }: { machineId: string }) {
	const [tier, setTier] = useState<FleetTier>("dense");
	const { data, loading, error, nowMs } = useFleet(tier);
	const machine = data?.machines.find((m) => m.machineId === machineId);
	return (
		<section className="mt-4" aria-label="Resource telemetry">
			<div className="flex items-center justify-between mb-2">
				<h2 className="text-sm font-bold">Resources</h2>
				<fieldset className="inline-flex rounded-md border border-line overflow-hidden m-0 p-0 min-w-0">
					<legend className="sr-only">Range</legend>
					{(["dense", "coarse"] as const).map((t) => (
						<button key={t} type="button" onClick={() => setTier(t)} aria-pressed={tier === t} className={`px-2.5 py-0.5 text-2xs ${tier === t ? "bg-accent-soft text-accent font-semibold" : "text-muted hover:bg-panel-hover"}`}>
							{t === "dense" ? "2 h" : "24 h"}
						</button>
					))}
				</fieldset>
			</div>
			{error && !data ? (
				<Card className="text-sm text-danger border-danger-line" role="alert">Could not load telemetry: {error}</Card>
			) : !machine ? (
				<Card className="text-sm text-muted">{loading ? "Loading…" : "This machine has not sent a resource sample yet."}</Card>
			) : (
				<FleetCharts machines={[machine]} tier={tier} nowMs={nowMs} />
			)}
		</section>
	);
}
