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
	machineFromResponse,
	machineLastAttempt,
	machineLatestVersion,
	machineStatusDetail,
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
				</div>
			)}
		</Page>
	);
}
