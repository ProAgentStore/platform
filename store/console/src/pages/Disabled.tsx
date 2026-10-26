import { api } from "@proagentstore/sdk/client";
import { PowerOff, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Button from "../components/Button";
import Card from "../components/Card";
import Page from "../components/Page";
import { useAuth } from "../lib/AuthContext";
import { DISABLED_INSTANCES_PATH, type DisabledInstance, type DisabledInstancesResponse, describeDisabled, type PauseResponse } from "../lib/instancePause";

/**
 * Every agent you have switched off (#1383) — hidden from every other list, shown here with what you need to decide whether to bring it back:
 * the reason you gave, when, its repos, the machine it is pinned to and its last run. One click enables it; nothing is ever deleted, and
 * enabling restores pins, repos, queue and schedules exactly.
 */
export default function Disabled() {
	const { user } = useAuth();
	const [data, setData] = useState<DisabledInstancesResponse | null>(null);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState<string | null>(null);
	const [note, setNote] = useState("");

	const load = useCallback(async () => {
		setLoading(true);
		try {
			setData(await api<DisabledInstancesResponse>(DISABLED_INSTANCES_PATH));
			setError("");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
		setLoading(false);
	}, []);
	useEffect(() => {
		void load();
	}, [load]);

	const enable = async (i: DisabledInstance) => {
		setBusy(i.id);
		setNote("");
		try {
			await api<PauseResponse>(`/v1/instances/${i.id}/enable`, { method: "POST" });
			// Read the list again rather than dropping the row locally: the server is the authority on what is still disabled.
			setNote(`Enabled ${i.name ?? i.id}. It is back in your lists.`);
			await load();
		} catch (e) {
			setNote(e instanceof Error ? e.message : String(e));
		}
		setBusy(null);
	};

	const rows = data?.instances ?? [];
	return (
		<Page>
			<div className="flex flex-wrap justify-between items-center gap-2 mb-1">
				<div className="flex items-center gap-2.5">
					<PowerOff size={20} className="text-accent" />
					<h1 className="font-display text-xl font-bold">Disabled</h1>
				</div>
				<Button onClick={() => void load()} disabled={loading} aria-label="Reload disabled agents">
					<RefreshCw size={14} className={loading ? "animate-spin" : ""} />
				</Button>
			</div>
			<p className="text-sm text-muted mb-4">
				Agents you have switched off. They are hidden everywhere else and run nothing. Enabling one brings back its repos, queue, schedules and pinned machine exactly; nothing here is deleted.
			</p>

			{error && (
				<Card className="mb-4 text-sm text-danger border-danger-line" role="alert">
					Could not load the disabled list: {error}
				</Card>
			)}
			{note && <p className="text-xs text-muted mb-3" id="disabled-note">{note}</p>}
			{data?.truncated && <p className="text-2xs text-warning mb-3">More than {data.total} agents are disabled; the most recently disabled are shown. Enable some to see the rest.</p>}

			{loading && !data ? (
				<p className="text-center py-8 text-muted text-sm">Loading…</p>
			) : rows.length === 0 ? (
				<Card className="text-sm text-muted">No agents are disabled. Disable one from its Settings tab, or with the disable_instance tool; it will be listed here.</Card>
			) : (
				<ul className="space-y-3 list-none p-0 m-0">
					{rows.map((i) => (
						<li key={i.id}>
							<Card>
								<div className="flex flex-wrap justify-between items-start gap-2">
									<div className="min-w-0">
										<Link to={`/instances/${i.id}`} className="font-semibold hover:text-accent">
											{i.name ?? i.slug ?? i.id}
										</Link>
										<p className="text-xs text-muted mt-0.5">{describeDisabled(i.disabled, user?.id)}</p>
									</div>
									<Button onClick={() => void enable(i)} disabled={busy === i.id}>
										Enable
									</Button>
								</div>
								<dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 mt-3 text-xs">
									<div>
										<dt className="inline text-muted-soft">Repos: </dt>
										<dd className="inline">{i.repos.length ? i.repos.map((r) => r.githubRepo ?? r.name).join(", ") : "none"}</dd>
									</div>
									<div>
										<dt className="inline text-muted-soft">Pinned to: </dt>
										<dd className="inline">{i.pinnedMachine ? i.pinnedMachine.node : "no machine"}</dd>
									</div>
									<div>
										<dt className="inline text-muted-soft">Last run: </dt>
										<dd className="inline">
											{i.lastRun ? `${i.lastRun.status}${i.lastRun.stopReason ? ` (${i.lastRun.stopReason})` : ""}, ${new Date(i.lastRun.startedAt).toLocaleDateString()}` : "never run"}
										</dd>
									</div>
									<div>
										<dt className="inline text-muted-soft">Queued objectives: </dt>
										<dd className="inline">{i.queuedObjectives}</dd>
									</div>
								</dl>
							</Card>
						</li>
					))}
				</ul>
			)}
		</Page>
	);
}
