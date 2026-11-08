import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Button from "../../components/Button";
import Card from "../../components/Card";
import HistoryLine from "../../components/HistoryLine";
import type { HistoryLineState } from "../../lib/historyLine";
import { FOLLOWS_RUNNER_LINE, type FinderForm, type FinderScope, type OriginalFinderOverview, finderLine, formFromSettings, patchFromForm } from "../../lib/originalFinder";

const input = "bg-paper border border-line rounded px-2 py-1.5 text-sm";

/** Under an empty Roles box: the scope the Finder is actually working to. */
export function ScopeNote({ scope }: { scope: FinderScope }) {
	return (
		<p className="text-xs text-muted mb-3" data-testid="finder-scope">
			{FOLLOWS_RUNNER_LINE}
			{scope.roles.length > 0 ? `: ${scope.roles.join(", ")}` : " (none set yet)"}
		</p>
	);
}

/**
 * Settings → Agent → Original Finder (#1616): the research budget and scope of the agent that looks up a lead's
 * original posting. Shown only for a Finder (`Instance.originalFinder`, the server's verdict). Saving sends only the
 * fields that changed; the server refuses what is invalid and its text is shown as it is.
 */
export default function OriginalFinderSection({ instanceId }: { instanceId: string }) {
	const [overview, setOverview] = useState<OriginalFinderOverview | null>(null);
	const [form, setForm] = useState<FinderForm | null>(null);
	const [line, setLine] = useState<HistoryLineState>({ status: "loading" });
	const [msg, setMsg] = useState("");
	const [saving, setSaving] = useState(false);

	const load = useCallback(async () => {
		try {
			const o = await api<OriginalFinderOverview>(`/v1/instances/${instanceId}/original-finder`);
			setOverview(o);
			setForm(formFromSettings(o.settings));
			setLine(finderLine(o));
		} catch {
			setLine({ status: "failed" });
		}
	}, [instanceId]);
	useEffect(() => {
		void load();
	}, [load]);

	const set = (patch: Partial<FinderForm>) => setForm((f) => (f ? { ...f, ...patch } : f));
	const save = async () => {
		if (!overview || !form) return;
		setSaving(true);
		setMsg("");
		try {
			await api(`/v1/instances/${instanceId}/original-finder/settings`, { method: "PUT", body: JSON.stringify(patchFromForm(form, overview.settings)) });
			await load();
			setMsg("Saved.");
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
		setSaving(false);
	};

	const scope = overview?.scope;
	const rolesEmpty = form !== null && form.roles.trim() === "";
	return (
		<Card className="mb-3 sm:mb-4" data-testid="settings-original-finder">
			<h3 className="text-base font-bold mb-1">Original Finder</h3>
			<p className="text-sm text-muted mb-3">Looks up the original company posting for leads that came from a job board or alert. Each lookup is one research run.</p>
			<HistoryLine instanceId={instanceId} panel="finder" state={line} testId="finder-line" />
			{form && (
				<div className="mt-3">
					<label className="flex flex-col gap-1 text-xs font-semibold mb-3 sm:max-w-xs">
						Daily research budget
						<span className="font-normal text-muted">Research runs per 24 hours, 0 to 50. 0 pauses lookups.</span>
						<input className={input} type="number" inputMode="numeric" min={0} max={50} step={1} value={form.dailyCap} aria-label="Daily research budget" onChange={(e) => set({ dailyCap: e.target.value })} />
					</label>
					<label className="flex flex-col gap-1 text-xs font-semibold mb-1">
						Roles
						<span className="font-normal text-muted">One per line. Only leads matching a role are researched.</span>
						<textarea className={input} rows={3} value={form.roles} aria-label="Roles" onChange={(e) => set({ roles: e.target.value })} />
					</label>
					{rolesEmpty && scope && <ScopeNote scope={scope} />}
					<div className="grid sm:grid-cols-2 gap-3 mb-3">
						<label className="flex flex-col gap-1 text-xs font-semibold">
							Locations
							<span className="font-normal text-muted">One per line. Empty: any location.</span>
							<textarea className={input} rows={3} value={form.locations} aria-label="Locations" onChange={(e) => set({ locations: e.target.value })} />
						</label>
						<label className="flex flex-col gap-1 text-xs font-semibold">
							Exclude
							<span className="font-normal text-muted">One per line. Leads mentioning these are skipped.</span>
							<textarea className={input} rows={3} value={form.exclude} aria-label="Exclude" onChange={(e) => set({ exclude: e.target.value })} />
						</label>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<Button size="sm" onClick={() => void save()} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
						{msg && <span className="text-xs text-muted" role="status">{msg}</span>}
					</div>
				</div>
			)}
		</Card>
	);
}
