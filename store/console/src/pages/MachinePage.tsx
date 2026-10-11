import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, CircleAlert, RefreshCw, Terminal } from "lucide-react";
import { api } from "@proagentstore/sdk/client";
import { useTieredPolling } from "@proagentstore/sdk/hooks";
import Button from "../components/Button";
import Card from "../components/Card";
import Page from "../components/Page";
import {
	machineAutoUpdateEnabled,
	machineCanRunAutomaticUpdates,
	machineAutoUpdateIsBusy,
	machineAutoUpdateStatus,
	machineBlockerLabel,
	machineFromResponse,
	machineLastAttempt,
	machineLatestVersion,
	machineObservationOutcome,
	machineRetryOverdue,
	machineStatusDetail,
	machineUpdateDiagnostics,
	type MachineDetail,
	type MachineDetailResponse,
} from "../lib/machineDetail";

function displayTime(iso: string | null | undefined): string {
	if (!iso) return "Never";
	const at = Date.parse(iso);
	return Number.isFinite(at) ? new Date(at).toLocaleString() : iso;
}

/**
 * One durable physical machine, rather than one of its historical hostnames. Policy belongs
 * here because a rename must not make the owner hunt for (or accidentally configure) a second
 * switch. The server remains authoritative: each poll reads back the policy and the runner's
 * lifecycle report, including updates that happened while this screen was closed.
 */
export default function MachinePage() {
	const { machineId = "" } = useParams();
	const [machine, setMachine] = useState<MachineDetail | null>(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");

	const load = useCallback(async () => {
		if (!machineId) {
			setError("This machine link is missing its machine ID.");
			setLoading(false);
			return;
		}
		try {
			const response = await api<MachineDetailResponse>(`/v1/terminals/machines/${encodeURIComponent(machineId)}`);
			setMachine(machineFromResponse(response));
			setError("");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not load this machine.");
		} finally {
			setLoading(false);
		}
	}, [machineId]);

	useEffect(() => { void load(); }, [load]);
	useTieredPolling(load, { activeMs: 5000, passiveMs: 20000 }, machineAutoUpdateIsBusy(machine));

	const setAutoUpdate = useCallback(async (autoUpdate: boolean) => {
		if (!machineId || !machine) return;
		setSaving(true);
		setError("");
		try {
			const response = await api<MachineDetailResponse>(`/v1/terminals/machines/${encodeURIComponent(machineId)}/policy`, {
				method: "PUT",
				body: JSON.stringify({ auto_update: autoUpdate }),
			});
			// Policy writes normally return the refreshed machine. A reload keeps the UI correct
			// against an older worker that acknowledges a write without returning that representation.
			if (response && typeof response === "object") setMachine(machineFromResponse(response));
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not update automatic updates.");
		} finally {
			setSaving(false);
		}
	}, [load, machine, machineId]);

	const status = machine ? machineAutoUpdateStatus(machine) : {};
	const enabled = machine ? machineAutoUpdateEnabled(machine) : false;
	const canRunAutomaticUpdates = machine ? machineCanRunAutomaticUpdates(machine) : false;
	const lastAttempt = machine ? machineLastAttempt(machine) : null;
	const diagnostics = machine ? machineUpdateDiagnostics(machine) : null;
	const blocker = machineBlockerLabel(diagnostics?.blocker_class);
	const overdue = machineRetryOverdue(diagnostics);

	return (
		<Page width={960}>
			<Link to="/terminals" className="text-sm text-muted mb-3 inline-flex items-center gap-1 hover:text-ink">
				<ArrowLeft size={14} /> Back to terminals
			</Link>
			<div className="flex justify-between items-start gap-3 mb-4">
				<div className="min-w-0">
					<div className="flex items-center gap-2">
						<Terminal size={20} className="text-accent shrink-0" />
						<h1 className="font-display text-xl font-bold truncate">{machine?.node || "Machine"}</h1>
					</div>
					<p className="text-sm text-muted mt-1">Machine settings and automatic CLI updates.</p>
				</div>
				<Button onClick={() => void load()} disabled={loading || saving} aria-label="Refresh machine details" data-testid="machine-detail-refresh">
					<RefreshCw size={13} /> Refresh
				</Button>
			</div>

			{error && (
				<div role="alert" className="mb-4 px-3 py-2 border border-danger rounded-xl bg-danger-soft text-danger text-sm flex items-start gap-2" data-testid="machine-detail-error">
					<CircleAlert size={16} className="shrink-0 mt-0.5" /> {error}
				</div>
			)}

			{loading && !machine ? <p className="text-center py-8 text-muted text-sm">Loading machine…</p> : machine && (
				<div className="flex flex-col gap-4">
					<Card className="p-4" data-testid="machine-detail-info">
						<h2 className="font-semibold text-sm mb-3">Machine</h2>
						<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
							<dt className="text-muted">Connection</dt><dd>{machine.connected ? <span className="text-success">Connected</span> : <span className="text-muted-soft">Offline</span>}</dd>
							<dt className="text-muted">CLI version</dt><dd>{machine.runnerVersion || "Unknown"}</dd>
							<dt className="text-muted">Latest version</dt><dd>{machineLatestVersion(machine) || "Not checked yet"}</dd>
							<dt className="text-muted">Last seen</dt><dd>{displayTime(machine.lastSeenAt)}</dd>
							<dt className="text-muted">Machine ID</dt><dd className="font-mono text-xs break-all">{machine.machineId || machineId}</dd>
							{machine.aka?.length ? <><dt className="text-muted">Also known as</dt><dd>{machine.aka.join(" · ")}</dd></> : null}
						</dl>
					</Card>

					<Card className="p-4" data-testid="machine-auto-update-settings">
						<div className="flex items-start justify-between gap-4">
							<div>
								<h2 className="font-semibold text-sm">Automatic CLI updates</h2>
								<p className="text-sm text-muted mt-1">When enabled, this machine checks for a newer trusted CLI release and installs it only when it is idle.</p>
							</div>
							<label className="inline-flex items-center gap-2 shrink-0 text-sm cursor-pointer">
								<span className="text-muted">{enabled ? "On" : "Off"}</span>
								<input type="checkbox" checked={enabled} disabled={saving} onChange={(event) => void setAutoUpdate(event.target.checked)} aria-label="Enable automatic updates" data-testid="machine-auto-update-toggle" />
							</label>
						</div>
						{saving && <p role="status" className="text-xs text-muted mt-3">Saving automatic update policy…</p>}
						{!canRunAutomaticUpdates && <p className="text-xs text-warning mt-3" data-testid="machine-auto-update-compatibility">
							This runner must first be safely updated to CLI 0.4.92 or later. This toggle stores the policy, but an older running CLI will not install updates from it.
						</p>}
					</Card>

					<Card className="p-4" data-testid="machine-auto-update-status">
						<h2 className="font-semibold text-sm mb-3">Automatic update status</h2>
						<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
							<dt className="text-muted">State</dt><dd className="capitalize">{status.state?.replace(/[-_]/g, " ") || "Idle"}</dd>
							<dt className="text-muted">Detail</dt><dd>{machineStatusDetail(machine)}</dd>
							<dt className="text-muted">Last attempt</dt><dd>{displayTime(lastAttempt)}</dd>
						</dl>
					</Card>

					{diagnostics && (
						<Card className="p-4" data-testid="machine-auto-update-diagnostics">
							<h2 className="font-semibold text-sm mb-1">What the updater last did</h2>
							<p className="text-xs text-muted mb-3">Read-only. Hearing from the runner is not the same as it checking or deciding.</p>
							<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
								{blocker && <><dt className="text-muted">Waiting because</dt><dd data-testid="machine-update-blocker">{blocker}</dd></>}
								<dt className="text-muted">Last heard from</dt><dd>{displayTime(diagnostics.last_heartbeat_at)}</dd>
								<dt className="text-muted">Last check</dt><dd>{displayTime(diagnostics.last_check_at)}</dd>
								<dt className="text-muted">Last decision</dt><dd>{displayTime(diagnostics.last_decision_at)}</dd>
								<dt className="text-muted">Next retry due</dt>
								<dd data-testid="machine-update-next-retry">
									{diagnostics.next_retry_due_at ? displayTime(diagnostics.next_retry_due_at) : "None scheduled"}
									{overdue && <span className="text-warning ml-2" data-testid="machine-update-retry-overdue">Overdue — the runner is still reporting, but its retry has not run.</span>}
								</dd>
							</dl>
							{diagnostics.observations?.length ? (
								<>
									<h3 className="text-xs text-muted mt-3 mb-1">Recent busy checks</h3>
									<ul className="text-xs flex flex-col gap-1" data-testid="machine-update-observations">
										{diagnostics.observations.map((o, i) => {
											const outcome = machineObservationOutcome(o);
											return (
												// biome-ignore lint/suspicious/noArrayIndexKey: a fixed, ordered list of at most five samples
												<li key={i}>
													<span className={outcome === "ok" ? "text-success" : "text-warning"}>{outcome === "ok" ? "Read" : outcome === "unreadable" ? "Unreadable" : "Failed"}</span>{" "}
													{o.source} · {displayTime(o.sampled_at)}
												</li>
											);
										})}
									</ul>
								</>
							) : null}
						</Card>
					)}
				</div>
			)}
		</Page>
	);
}
