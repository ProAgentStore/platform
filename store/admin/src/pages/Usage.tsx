import { useEffect, useState } from "react";
import { api, fmtInt, fmtUsd } from "../lib/api";
import { ErrorBox, Loading, Panel, TrendBars } from "../lib/ui";

interface Bucket { key: string; label?: string; inputTokens: number; outputTokens: number; costMicros: number; calls: number }
interface UsageResp {
	range: string;
	totals: { inputTokens: number; outputTokens: number; costMicros: number; calls: number };
	daily: Array<{ date: string; costMicros: number }>;
	byProvider: Bucket[]; byModel: Bucket[]; byKind: Bucket[]; byUser: Bucket[]; byAgent: Bucket[];
	split: { platformPaid: { costMicros: number; calls: number }; byok: { costMicros: number; calls: number } };
}
const RANGES = ["7d", "30d", "90d", "all"];

export default function Usage() {
	const [range, setRange] = useState("30d");
	const [d, setD] = useState<UsageResp | null>(null);
	const [err, setErr] = useState("");
	useEffect(() => { setD(null); setErr(""); api<UsageResp>(`/v1/admin/usage?range=${range}`).then(setD).catch((e) => setErr(e.message)); }, [range]);

	if (err) return <ErrorBox message={err} />;
	if (!d) return <Loading />;

	return (
		<div>
			<div className="flex items-center justify-between mb-3">
				<h1 className="font-display text-xl font-bold">Usage</h1>
				<select value={range} onChange={(e) => setRange(e.target.value)} className="!w-auto text-sm">{RANGES.map((r) => <option key={r}>{r}</option>)}</select>
			</div>
			<Panel title="Cost trend"><TrendBars points={d.daily} /></Panel>
			<div className="grid md:grid-cols-2 gap-4">
				<Panel title="By activity"><BucketTable rows={d.byKind} head="Kind" /></Panel>
				<Panel title="By model"><BucketTable rows={d.byModel} head="Model" /></Panel>
				<Panel title="By provider"><BucketTable rows={d.byProvider} head="Provider" /></Panel>
				<Panel title="By user"><BucketTable rows={d.byUser} head="User" /></Panel>
				<Panel title="By agent"><BucketTable rows={d.byAgent} head="Agent" /></Panel>
			</div>
		</div>
	);
}

function BucketTable({ rows, head }: { rows: Bucket[]; head: string }) {
	if (!rows?.length) return <div className="text-muted-soft text-sm">None.</div>;
	return (
		<table className="w-full text-sm">
			<thead><tr className="text-muted text-xs uppercase text-left border-b border-line"><th className="py-1.5">{head}</th><th className="text-right">Calls</th><th className="text-right">Tokens</th><th className="text-right">Cost</th></tr></thead>
			<tbody>
				{rows.map((b) => (
					<tr key={b.key} className="border-b border-line/50">
						<td className="py-1.5 truncate max-w-[180px]">{b.label || b.key}</td>
						<td className="text-right">{fmtInt(b.calls)}</td>
						<td className="text-right">{fmtInt(b.inputTokens + b.outputTokens)}</td>
						<td className="text-right">{fmtUsd(b.costMicros)}</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}
