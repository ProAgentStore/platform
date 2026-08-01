import { useEffect, useState } from "react";
import { api, fmtInt, fmtUsd } from "../lib/api";
import { ErrorBox, Loading, Panel, Stat, TrendBars } from "../lib/ui";

interface Spending {
	totals: { costMicros: number; calls: number };
	daily: Array<{ date: string; costMicros: number }>;
	byok: { costMicros: number };
	platformAiEnabled: boolean;
	platformPaid: { costMicros: number };
}
interface UsersResp { total: number }

export default function Overview() {
	const [spend, setSpend] = useState<Spending | null>(null);
	const [users, setUsers] = useState<UsersResp | null>(null);
	const [err, setErr] = useState("");

	useEffect(() => {
		Promise.all([
			api<Spending>("/v1/admin/spending?range=30d"),
			api<UsersResp>("/v1/admin/users?limit=1"),
		])
			.then(([s, u]) => { setSpend(s); setUsers(u); })
			.catch((e) => setErr(e.message));
	}, []);

	if (err) return <ErrorBox message={err} />;
	if (!spend || !users) return <Loading />;

	return (
		<div>
			<div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
				<Stat label="Platform-paid AI (30d, est.)" value={fmtUsd(spend.platformPaid.costMicros)} accent />
				<Stat label="BYOK spend (30d)" value={fmtUsd(spend.byok.costMicros)} />
				<Stat label="AI calls (30d)" value={fmtInt(spend.totals.calls)} />
				<Stat label="Users" value={fmtInt(users.total)} />
			</div>
			<Panel title="AI spend — last 30 days">
				<TrendBars points={spend.daily} />
			</Panel>
			<p className="text-sm text-muted">
				Platform-paid AI is currently <strong className={spend.platformAiEnabled ? "text-green" : "text-muted"}>{spend.platformAiEnabled ? "ON" : "OFF"}</strong>.
				See <em>Spending</em> for the platform-vs-BYOK breakdown and <em>Users</em> for per-account detail.
			</p>
		</div>
	);
}
