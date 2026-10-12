import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Card from "../../components/Card";
import { type CoderBrainView, reportSummary } from "../../lib/poTriage";

/**
 * The coder brain switch and its scheduled product-owner triage (#1025, #1027). Both default off.
 * Triage runs on `run_po_triage` cron triggers — their schedule, timezone and dry run are edited
 * like any other trigger; this card turns them on or off and shows what each wake decided.
 */
export default function CoderBrainSection({ instanceId }: { instanceId: string }) {
	const [view, setView] = useState<CoderBrainView | null>(null);
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);

	const load = useCallback(async () => {
		try {
			setView(await api<CoderBrainView>(`/v1/instances/${instanceId}/po-triage/reports?limit=5`));
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Could not load the coder brain settings.");
		}
	}, [instanceId]);

	useEffect(() => { void load(); }, [load]);

	const save = async (patch: { enabled?: boolean; poEnabled?: boolean }) => {
		setBusy(true); setMessage("");
		try {
			await api(`/v1/instances/${instanceId}/coder-brain`, { method: "PUT", body: JSON.stringify(patch) });
			await load();
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Could not save.");
		} finally { setBusy(false); }
	};

	const s = view?.settings ?? { enabled: false, poEnabled: false };
	return <Card className="mt-4" aria-labelledby="coder-brain-heading" data-testid="coder-brain">
		<h2 id="coder-brain-heading" className="font-semibold">Coder brain</h2>
		<p className="text-xs text-muted-soft mt-1">Off by default. Product-owner triage reads this coder's open issues on a schedule: it queues the ready ones, leaves what waits on you, notes what is blocked, and comments once on an issue that needs more detail. It never edits, closes or deletes an issue.</p>
		<label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={s.enabled} disabled={busy} onChange={(e) => void save({ enabled: e.target.checked })} /> Coder brain on</label>
		<label className="mt-2 flex items-center gap-2 text-sm"><input type="checkbox" checked={s.poEnabled} disabled={busy || !s.enabled} onChange={(e) => void save({ poEnabled: e.target.checked })} /> Scheduled product-owner triage</label>
		{message && <p className="mt-2 text-xs text-danger" role="status">{message}</p>}
		{view?.triggers.length ? (
			<ul className="mt-3 flex flex-col gap-1 text-xs text-muted" aria-label="Triage schedules">
				{view.triggers.map((t) => (
					<li key={t.id}>{t.name}: <code>{t.schedule}</code> {t.config.timezone ?? "UTC"} · {t.enabled ? "on" : "off"}{t.config.dryRun !== false ? " · dry run" : ""}{t.nextRunAt ? ` · next ${new Date(t.nextRunAt).toLocaleString()}` : ""}</li>
				))}
			</ul>
		) : null}
		{view?.reports?.length ? (
			<div className="mt-4" data-testid="po-triage-reports">
				<h3 className="text-xs text-muted-soft mb-1">Recent triage</h3>
				<ul className="flex flex-col gap-1 text-xs">
					{view.reports.map((r) => (
						<li key={r.id}>
							<details>
								<summary>{new Date(r.slot).toLocaleString()} · <span className={r.status === "failed" ? "text-danger" : "text-muted"}>{reportSummary(r)}</span></summary>
								<ul className="ml-4 mt-1 flex flex-col gap-0.5">
									{r.report?.items.map((i) => <li key={`${i.repo}#${i.number}`}>{i.repo}#{i.number} {i.title} — {i.category.replace(/_/g, " ")}, {i.action.replace(/_/g, " ")}: {i.reason}</li>)}
								</ul>
							</details>
						</li>
					))}
				</ul>
			</div>
		) : null}
	</Card>;
}
