import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Button from "./Button";
import Card from "./Card";
import { actionsScope, canRequestActionsRecovery, recoveryPending, type ActionsRunnerItem, type ActionsRunnerStatus } from "../lib/actionsRunnerStatus";

function when(ms?: number): string {
	return ms && Number.isFinite(ms) ? new Date(ms).toLocaleString() : "Never";
}

export function ActionsRunnerStatusView({ status, busy, note, onRefresh, onRecover }: {
	status: ActionsRunnerStatus;
	busy: boolean;
	note: string;
	onRefresh: () => void;
	onRecover: (item: ActionsRunnerItem) => void;
}) {
	return <Card className="p-4" data-testid="actions-runner-card">
		<div className="flex items-center justify-between gap-3">
			<div><h3 className="font-semibold text-sm">GitHub Actions runners</h3><p className="text-xs text-muted mt-1">Local service and GitHub job routing are reported separately.</p></div>
			<Button onClick={onRefresh} disabled={busy}>Refresh</Button>
		</div>
		{status.machineHealth === "unknown" && <p className="text-sm text-warning mt-3" role="status">Machine status unknown: {status.machineNote ?? "the pinned machine did not answer."}</p>}
		{status.machineHealth === "current" && status.installed.length === 0 && <p className="text-sm text-muted mt-3">No Actions runners are installed on this machine.</p>}
		{note && <p className="text-sm mt-3" role="status">{note}</p>}
		<div className="mt-3 grid gap-3">
			{status.installed.map((item) => {
				const recovery = item.supervisor?.lastRecovery;
				const canRecover = canRequestActionsRecovery(item);
				return <div key={item.dir} className="rounded-lg border border-line p-3 text-sm" data-testid="actions-runner-item">
					<div className="font-medium break-all">{item.name || item.url || "Unnamed runner"}</div>
					<div className="text-xs text-muted break-all">{item.url || "Scope unknown"}</div>
					<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 mt-2 text-xs">
						<dt className="text-muted">Service</dt><dd>{item.serviceMode || "unknown"}{item.serviceState ? ` · ${item.serviceState}` : ""}</dd>
						<dt className="text-muted">Local</dt><dd>{item.localHealth === "current" ? item.supervisor?.health || "unknown" : item.localHealth || "unknown"}{item.localHealth === "stale" ? " (stale sample)" : ""}{item.supervisor?.activeJob ? " · active job" : ""}</dd>
						<dt className="text-muted">GitHub</dt><dd>{item.ci ? item.ci.registered ? `${item.ci.online ? "online" : "offline"} · ${item.ci.busy ? "busy" : "idle"} · ${item.ci.routable ? "routable" : "not routable"}` : "not registered" : `unknown${item.ciNote ? ` — ${item.ciNote}` : ""}`}</dd>
						<dt className="text-muted">AC recovery</dt><dd>{item.acRecoveryEnabled === undefined ? "unknown" : item.acRecoveryEnabled ? "on" : "off"}{item.supervisor?.acPower ? ` · power ${item.supervisor.acPower}` : ""}</dd>
						<dt className="text-muted">Last AC return</dt><dd>{when(item.supervisor?.lastAcReturnAt)}</dd>
						<dt className="text-muted">Last restart</dt><dd>{when(item.supervisor?.lastRestartAt)}{item.supervisor?.lastRestartReason ? ` · ${item.supervisor.lastRestartReason}` : ""}</dd>
						<dt className="text-muted">Last ready</dt><dd>{when(item.supervisor?.lastReadyAt)}</dd>
						{recovery && <><dt className="text-muted">Recovery</dt><dd>{recovery.state} · {recovery.reason || "manual"} · {recovery.id} · requested {when(recovery.requestedAt)}{recovery.completedAt ? ` · completed ${when(recovery.completedAt)}` : ""}</dd></>}
					</dl>
					{item.supervisor?.lastError && <p className="text-xs text-danger mt-2" role="alert">{item.supervisor.lastError}</p>}
					{recovery?.error && <p className="text-xs text-danger mt-2" role="alert">Recovery: {recovery.error}</p>}
					{item.supervisorNote && <p className="text-xs text-muted mt-2">{item.supervisorNote}</p>}
					{canRecover && <div className="mt-3"><Button onClick={() => onRecover(item)} disabled={busy || recoveryPending(item)}>{item.supervisor?.activeJob ? "Queue recovery after job" : "Request recovery"}</Button></div>}
				</div>;
			})}
		</div>
	</Card>;
}

export default function ActionsRunnerCard({ instanceId }: { instanceId: string }) {
	const [status, setStatus] = useState<ActionsRunnerStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState("");
	const [watchRecovery, setWatchRecovery] = useState<{ id: string; until: number } | null>(null);
	const load = useCallback(async () => {
		try {
			const next = await api<ActionsRunnerStatus>(`/v1/instances/${encodeURIComponent(instanceId)}/actions-runner`);
			setStatus(next);
			setWatchRecovery((current) => current && next.installed.some((item) => {
				const r = item.supervisor?.lastRecovery;
				return r?.id === current.id && ["ready", "error"].includes(r.state);
			}) ? null : current);
		} catch (error) {
			setStatus({ node: null, machineHealth: "unknown", machineNote: error instanceof Error ? error.message : "Could not read Actions runner status.", installed: [] });
		}
	}, [instanceId]);
	useEffect(() => { void load(); }, [load]);
	useEffect(() => {
		if (!watchRecovery) return;
		const timer = window.setInterval(() => {
			if (watchRecovery && Date.now() >= watchRecovery.until) {
				setWatchRecovery(null);
				setNote(`Recovery ${watchRecovery.id} is still pending or its outcome could not be read. Refresh to check later.`);
				return;
			}
			void load();
		}, 5000);
		return () => window.clearInterval(timer);
	}, [load, watchRecovery]);
	const recover = async (item: ActionsRunnerItem) => {
		const scope = actionsScope(item.url);
		if (!scope || !canRequestActionsRecovery(item)) return;
		const target = "org" in scope ? scope.org : scope.repo;
		const message = item.supervisor?.activeJob
			? `Queue recovery for ${target} on this machine? The active GitHub Actions job will finish before the listener restarts.`
			: `Request recovery for ${target} on this machine? The managed Actions listener will restart; other runners and pags up stay running.`;
		if (!window.confirm(message)) return;
		setBusy(true);
		setNote("");
		try {
			const result = await api<{ recovery: { id: string; state: string } }>(`/v1/instances/${encodeURIComponent(instanceId)}/actions-runner/recover`, { method: "POST", body: JSON.stringify({ scope }) });
			setWatchRecovery({ id: result.recovery.id, until: Date.now() + 120_000 });
			setNote(`Recovery ${result.recovery.id}: ${result.recovery.state}. The outcome will appear below.`);
			await load();
		} catch (error) {
			setNote(error instanceof Error ? error.message : "Could not request recovery.");
		} finally {
			setBusy(false);
		}
	};
	return status ? <ActionsRunnerStatusView status={status} busy={busy} note={note} onRefresh={() => void load()} onRecover={(item) => void recover(item)} /> : <Card className="p-4 text-sm text-muted">Loading GitHub Actions runners…</Card>;
}
