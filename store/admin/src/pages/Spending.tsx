import { useEffect, useState } from "react";
import { api, fmtInt, fmtUsd } from "../lib/api";
import { ErrorBox, Loading, Panel, SplitBar, Stat, TrendBars } from "../lib/ui";

interface Bucket { key: string; label?: string; costMicros: number; inputTokens: number; outputTokens: number; calls: number }
interface Spending {
	range: string;
	totals: { costMicros: number; calls: number };
	daily: Array<{ date: string; costMicros: number }>;
	byok: { costMicros: number; calls: number };
	topSpenders: Bucket[];
	topModels: Bucket[];
	platformAiEnabled: boolean;
	platformPaid: { costMicros: number; calls: number; metered: boolean; estimated: boolean; note: string };
}

const RANGES = ["7d", "30d", "90d", "all"];

export default function Spending() {
	const [range, setRange] = useState("30d");
	const [data, setData] = useState<Spending | null>(null);
	const [err, setErr] = useState("");

	useEffect(() => {
		setData(null);
		setErr("");
		api<Spending>(`/v1/admin/spending?range=${range}`).then(setData).catch((e) => setErr(e.message));
	}, [range]);

	const rangeCtl = (
		<select value={range} onChange={(e) => setRange(e.target.value)} className="!w-auto text-sm">
			{RANGES.map((r) => <option key={r} value={r}>{r}</option>)}
		</select>
	);

	if (err) return <ErrorBox message={err} />;
	if (!data) return <Loading />;

	return (
		<div>
			<div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
				<Stat label={`Platform-paid (${range}, est.)`} value={fmtUsd(data.platformPaid.costMicros)} accent />
				<Stat label={`BYOK spend (${range})`} value={fmtUsd(data.byok.costMicros)} />
				<Stat label="Total AI calls" value={fmtInt(data.totals.calls)} />
				<Stat label="Platform AI" value={data.platformAiEnabled ? "ON" : "OFF"} />
			</div>

			<Panel title="Platform-paid vs BYOK">
				<SplitBar platform={data.platformPaid.costMicros} byok={data.byok.costMicros} />
				<p className="text-xs text-muted-soft mt-3">{data.platformPaid.note}</p>
			</Panel>

			<Panel title="Spend trend" right={rangeCtl}>
				<TrendBars points={data.daily} />
			</Panel>

			<div className="grid md:grid-cols-2 gap-4">
				<Panel title="Top spenders">
					<BucketTable rows={data.topSpenders} nameHead="User" />
				</Panel>
				<Panel title="Top models">
					<BucketTable rows={data.topModels} nameHead="Model" />
				</Panel>
			</div>
		</div>
	);
}

function BucketTable({ rows, nameHead }: { rows: Bucket[]; nameHead: string }) {
	if (!rows.length) return <div className="text-muted-soft text-sm">None yet.</div>;
	return (
		<table className="w-full text-sm">
			<thead>
				<tr className="text-muted text-xs uppercase text-left border-b border-line">
					<th className="py-1.5">{nameHead}</th>
					<th className="text-right">Calls</th>
					<th className="text-right">Cost</th>
				</tr>
			</thead>
			<tbody>
				{rows.map((b) => (
					<tr key={b.key} className="border-b border-line/50">
						<td className="py-1.5 truncate max-w-[180px]">{b.label || b.key}</td>
						<td className="text-right">{fmtInt(b.calls)}</td>
						<td className="text-right">{fmtUsd(b.costMicros)}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}
