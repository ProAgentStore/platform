import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Card from "../../components/Card";

interface AutoPickupSettings {
	enabled: boolean;
	priorityLabels: string[];
	excludeLabels: string[];
	maxPerDay: number;
	maxIterations: number;
}
interface AutoPickupView {
	settings: AutoPickupSettings | null;
	builtinExcludeLabels: string[];
	activeWhenQueueEmpties: "triage" | "auto_pickup";
	recent: Array<{ repo: string | null; issue: number | null; outcome: string; detail: string | null; at: number }>;
}

const OUTCOME: Record<string, string> = { started: "Started", none_eligible: "Nothing eligible", skipped_failed: "Skipped (failed twice)", capped: "Daily cap reached" };
const list = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);

/**
 * Brain-free auto-pickup (#1233): when this coder's queue empties, start its next open issue by
 * priority label, bug before enhancement, board order, then oldest — with zero model calls. Off by
 * default and independent of the coder brain; with the brain's triage on, triage picks instead.
 */
export default function AutoPickupSection({ instanceId }: { instanceId: string }) {
	const [view, setView] = useState<AutoPickupView | null>(null);
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);

	const load = useCallback(async () => {
		try {
			setView(await api<AutoPickupView>(`/v1/instances/${instanceId}/auto-pickup`));
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Could not load auto-pickup.");
		}
	}, [instanceId]);
	useEffect(() => { void load(); }, [load]);

	const save = async (patch: Partial<AutoPickupSettings>) => {
		setBusy(true); setMessage("");
		try {
			setView(await api<AutoPickupView>(`/v1/instances/${instanceId}/auto-pickup`, { method: "PUT", body: JSON.stringify(patch) }));
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Could not save.");
		} finally { setBusy(false); }
	};

	const s = view?.settings ?? { enabled: false, priorityLabels: ["P0", "P1", "P2", "P3"], excludeLabels: [], maxPerDay: 10, maxIterations: 30 };
	const field = (label: string, key: "priorityLabels" | "excludeLabels") => (
		<label className="flex flex-col gap-1 text-xs">
			{label}
			<input key={`${key}-${s[key].join(",")}`} aria-label={label} defaultValue={s[key].join(", ")} disabled={busy || !s.enabled} className="w-full min-w-0 rounded border border-line bg-paper px-2 py-1" onBlur={(e) => list(e.target.value).join(",") !== s[key].join(",") && void save({ [key]: list(e.target.value) })} />
		</label>
	);
	const num = (label: string, key: "maxPerDay" | "maxIterations") => (
		<label className="flex items-center justify-between gap-2 text-xs">
			{label}
			<input key={`${key}-${s[key]}`} aria-label={label} type="number" defaultValue={s[key]} disabled={busy || !s.enabled} className="w-20 rounded border border-line bg-paper px-1 py-0.5" onBlur={(e) => Number(e.target.value) !== s[key] && void save({ [key]: Number(e.target.value) })} />
		</label>
	);
	return <Card className="mt-4" aria-labelledby="auto-pickup-heading" data-testid="auto-pickup">
		<h2 id="auto-pickup-heading" className="font-semibold">Auto-pickup</h2>
		<p className="text-xs text-muted-soft mt-1">Off by default. When this coder's queue empties, it starts the next open issue by priority label, bugs before enhancements, then board order, then oldest — no AI, no tokens. It never picks an issue labelled {(view?.builtinExcludeLabels ?? ["needs-human", "blocked-on-serge", "blocked", "question", "wontfix"]).join(", ")}, one assigned to a person, one already queued, or one two auto-picked runs failed on.</p>
		<label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={s.enabled} disabled={busy} onChange={(e) => void save({ enabled: e.target.checked })} /> Auto-pickup on</label>
		{s.enabled && view?.activeWhenQueueEmpties === "triage" && <p className="mt-1 text-xs text-warning">The coder brain's product-owner triage is on, so triage picks the next issue instead.</p>}
		<div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
			{field("Priority labels, highest first", "priorityLabels")}
			{field("Also never pick (labels)", "excludeLabels")}
			{num("Auto-picked runs per day", "maxPerDay")}
			{num("Iterations per run", "maxIterations")}
		</div>
		{message && <p className="mt-2 text-xs text-danger" role="status">{message}</p>}
		{!!view?.recent.length && (
			<ul className="mt-3 flex flex-col gap-1 text-xs" data-testid="auto-pickup-recent">
				{view.recent.map((r) => (
					<li key={`${r.at}-${r.outcome}-${r.issue ?? ""}`} className="break-words">
						<span className="font-semibold">{OUTCOME[r.outcome] ?? r.outcome}</span>
						{r.issue ? ` — ${r.repo}#${r.issue}` : ""}
						{r.detail ? `: ${r.detail}` : ""} <span className="text-muted-soft">· {new Date(r.at).toLocaleString()}</span>
					</li>
				))}
			</ul>
		)}
	</Card>;
}
