import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Button from "./Button";
import Card from "./Card";
import { formatUsd } from "../../../../workers/api/src/lib/ai-pricing";
import type { DriverBucket, SavingsComparison, SpendDrivers as Drivers } from "../../../../workers/api/src/lib/usage-drivers";

/** `GET /v1/budget/limits`, the one field this panel reads — the alert it sets beside the ceilings. */
export interface SpendAlertLimits {
	stored: { spendAlertMicros: number | null };
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const VERDICT_CLASS: Record<SavingsComparison["verdict"], string> = {
	saving: "text-success",
	regression: "text-danger",
	"no-change": "text-muted",
	"insufficient-data": "text-muted",
};

function Top({ title, rows }: { title: string; rows: DriverBucket[] }) {
	return (
		<div>
			<h4 className="text-xs font-semibold mb-1">{title}</h4>
			{rows.length === 0 ? (
				<p className="text-xs text-muted-soft">Nothing recorded.</p>
			) : (
				<ul className="text-xs space-y-0.5">
					{rows.slice(0, 5).map((r) => (
						<li key={r.key} className="flex justify-between gap-2">
							<span className="truncate" title={r.key}>{r.label ?? r.key}</span>
							<span className="tabular-nums text-muted shrink-0">{formatUsd(r.costMicros)} · {r.calls}</span>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/**
 * What is driving spend and whether a change saved anything (#1040) — rendered from the API's own
 * report, with every opportunity's estimate, its basis and where to act. Nothing here changes a
 * setting except the spend alert, which only notifies.
 */
export function SpendDriversView({ drivers, savings }: { drivers: Drivers; savings: SavingsComparison | null }) {
	const t = drivers.totals;
	return (
		<div data-testid="spend-drivers">
			<p className="text-xs text-muted mb-3" data-testid="spend-drivers-totals">
				{t.calls} calls · {formatUsd(t.costMicros)} estimated · cache served {pct(t.cacheReadShare)} of prompt tokens · {t.toolCallTurns} turns asked for tools ·{" "}
				{t.retryCalls} retried ({formatUsd(t.retryMicros)}) · {t.duplicateCalls} duplicated ({formatUsd(t.duplicateMicros)})
				{t.unattributedMicros > 0 && <> · {formatUsd(t.unattributedMicros)} with no objective recorded</>}
			</p>
			<div className="grid sm:grid-cols-2 gap-4 mb-4">
				<Top title="Top objectives (trace id)" rows={drivers.byObjective} />
				<Top title="Top phases" rows={drivers.byPhase} />
				<Top title="Top instances" rows={drivers.byInstance} />
				<Top title="Top models" rows={drivers.byModel} />
			</div>
			<h4 className="text-xs font-semibold mb-1">Where it could be cheaper</h4>
			<ul className="text-xs space-y-2 mb-4" data-testid="spend-opportunities">
				{drivers.opportunities.map((o) => (
					<li key={o.id}>
						<div className="flex justify-between gap-2">
							<span className="font-semibold">{o.label}</span>
							<span className="tabular-nums shrink-0">~{formatUsd(o.estimatedMicros)} · {o.calls} calls</span>
						</div>
						<p className="text-muted-soft">{o.basis} {o.action}</p>
					</li>
				))}
			</ul>
			{savings && (
				<p className={`text-xs ${VERDICT_CLASS[savings.verdict]}`} data-testid="spend-savings">
					Against the previous period: {savings.summary}
				</p>
			)}
			{drivers.truncated && <p className="text-xs text-warning mt-2">Only the newest calls in this period were read.</p>}
		</div>
	);
}

export default function SpendDrivers() {
	const [days, setDays] = useState(7);
	const [drivers, setDrivers] = useState<Drivers | null>(null);
	const [savings, setSavings] = useState<SavingsComparison | null>(null);
	const [alert, setAlert] = useState("");
	const [msg, setMsg] = useState("");

	const load = useCallback(async () => {
		const [d, s, b] = await Promise.all([
			api<Drivers>(`/v1/usage/drivers?days=${days}`).catch(() => null),
			api<SavingsComparison>(`/v1/usage/savings?days=${days}`).catch(() => null),
			api<SpendAlertLimits>("/v1/budget/limits").catch(() => null),
		]);
		setDrivers(d);
		setSavings(s);
		if (b) setAlert(b.stored.spendAlertMicros !== null ? String(b.stored.spendAlertMicros / 1_000_000) : "");
	}, [days]);
	useEffect(() => { void load(); }, [load]);

	// The budget route patches: sending only this field leaves every ceiling as stored (#501).
	const saveAlert = async () => {
		const v = alert.trim() === "" ? null : Math.round(parseFloat(alert) * 1_000_000);
		if (v !== null && (Number.isNaN(v) || v < 0)) return setMsg("Enter a dollar amount, or leave blank for no alert.");
		try {
			await api("/v1/budget/limits", { method: "PUT", body: JSON.stringify({ spendAlertMicros: v }) });
			setMsg(v === null ? "Alert off." : `You'll be notified when 24h charged spend reaches ${formatUsd(v)} — at most once a day. Nothing is stopped.`);
		} catch (e) {
			setMsg(e instanceof Error ? e.message : "Failed to save.");
		}
	};

	return (
		<Card className="mt-6">
			<div className="flex items-center justify-between gap-2 mb-3">
				<h3 className="text-sm font-bold">Spend drivers</h3>
				<select aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))} className="text-xs bg-paper border border-line rounded-lg px-2 py-1">
					<option value={7}>Last 7 days</option>
					<option value={30}>Last 30 days</option>
				</select>
			</div>
			{drivers ? <SpendDriversView drivers={drivers} savings={savings} /> : <p className="text-xs text-muted">Couldn’t load spend drivers.</p>}
			<div className="flex flex-wrap items-end gap-2 mt-4 pt-3 border-t border-line">
				<label className="text-xs font-semibold" htmlFor="spend-alert">Daily spend alert (USD, charged, rolling 24h)</label>
				<input id="spend-alert" type="number" min={0} step={1} placeholder="off" value={alert} onChange={(e) => setAlert(e.target.value)} className="w-28 text-sm px-2 py-1 rounded-lg border border-line bg-panel" />
				<Button size="sm" variant="secondary" onClick={() => void saveAlert()}>Save alert</Button>
			</div>
			{msg && <p className="text-xs text-muted mt-2">{msg}</p>}
		</Card>
	);
}
