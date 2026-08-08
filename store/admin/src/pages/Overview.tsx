import { useEffect, useState } from "react";
import { api, fmtInt, fmtUsd } from "../lib/api";
import { BarChart, ErrorBox, Loading, Panel, Stat } from "../lib/ui";

interface Overview {
	users: number;
	agents: number;
	agentsPublished: number;
	instancesActive: number;
	errors24h: number;
	aiCalls24h: number;
	value30dMicros: number;
	platformSpend30dMicros: number;
}
interface Spending {
	daily: Array<{ date: string; costMicros: number; calls: number }>;
	byok: { chargedMicros: number };
	platformAiEnabled: boolean;
}

export default function OverviewPage() {
	const [o, setO] = useState<Overview | null>(null);
	const [s, setS] = useState<Spending | null>(null);
	const [err, setErr] = useState("");

	useEffect(() => {
		Promise.all([
			api<Overview>("/v1/admin/overview"),
			api<Spending>("/v1/admin/spending?range=30d"),
		]).then(([ov, sp]) => { setO(ov); setS(sp); }).catch((e) => setErr(e.message));
	}, []);

	if (err) return <ErrorBox message={err} />;
	if (!o || !s) return <Loading />;

	return (
		<div>
			<div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
				<Stat label="Users" value={fmtInt(o.users)} />
				<Stat label="Agents" value={`${fmtInt(o.agents)} (${o.agentsPublished} pub)`} />
				<Stat label="Active instances" value={fmtInt(o.instancesActive)} />
				<Stat label="Errors (24h)" value={fmtInt(o.errors24h)} accent={o.errors24h > 0} />
				<Stat label="Platform-paid AI (30d, est.)" value={fmtUsd(o.platformSpend30dMicros)} accent />
				<Stat label="BYOK spend (30d)" value={fmtUsd(s.byok.chargedMicros)} />
				<Stat label="AI calls (24h)" value={fmtInt(o.aiCalls24h)} />
				<Stat label="Platform AI" value={s.platformAiEnabled ? "ON" : "OFF"} />
			</div>
			<div className="grid md:grid-cols-2 gap-4">
				<Panel title="AI value — last 30 days (list price)">
					<BarChart
						points={s.daily.map((d) => ({ date: d.date, value: d.costMicros, secondary: d.calls }))}
						format={fmtUsd}
						secondaryLabel="calls"
						secondaryFormat={fmtInt}
					/>
				</Panel>
				<Panel title="AI calls — last 30 days">
					<BarChart points={s.daily.map((d) => ({ date: d.date, value: d.calls }))} format={fmtInt} />
				</Panel>
			</div>
			<p className="text-sm text-muted">
				Platform-paid AI is <strong className={s.platformAiEnabled ? "text-success" : "text-muted"}>{s.platformAiEnabled ? "ON" : "OFF"}</strong>.
				See <em>Errors</em> to learn from recurring failures, <em>Spending</em>/<em>Usage</em> for cost, <em>Terminals</em> for connected CLIs, and <em>Audit</em> for the admin action log.
			</p>
		</div>
	);
}
