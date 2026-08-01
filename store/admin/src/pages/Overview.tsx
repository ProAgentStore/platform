import { useEffect, useState } from "react";
import { api, fmtInt, fmtUsd } from "../lib/api";
import { ErrorBox, Loading, Panel, Stat, TrendBars } from "../lib/ui";

interface Overview {
	users: number;
	agents: number;
	agentsPublished: number;
	instancesActive: number;
	errors24h: number;
	aiCalls24h: number;
	spend30dMicros: number;
	platformSpend30dMicros: number;
}
interface Spending {
	daily: Array<{ date: string; costMicros: number }>;
	byok: { costMicros: number };
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
				<Stat label="BYOK spend (30d)" value={fmtUsd(s.byok.costMicros)} />
				<Stat label="AI calls (24h)" value={fmtInt(o.aiCalls24h)} />
				<Stat label="Platform AI" value={s.platformAiEnabled ? "ON" : "OFF"} />
			</div>
			<Panel title="AI spend — last 30 days">
				<TrendBars points={s.daily} />
			</Panel>
			<p className="text-sm text-muted">
				Platform-paid AI is <strong className={s.platformAiEnabled ? "text-green" : "text-muted"}>{s.platformAiEnabled ? "ON" : "OFF"}</strong>.
				See <em>Spending</em> for the platform-vs-BYOK breakdown, <em>Agents</em> for the catalog, and <em>Activity</em> for errors + the admin audit log.
			</p>
		</div>
	);
}
