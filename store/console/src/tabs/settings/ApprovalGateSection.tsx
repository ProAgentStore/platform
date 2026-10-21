import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import Button from "../../components/Button";
import Card from "../../components/Card";

interface GateAction {
	id: string;
	label: string;
	description: string;
	defaultOn: boolean;
}
interface GateView {
	enabled: boolean;
	actions: string[];
	expirySeconds: number;
	pending: number;
	limits: { minExpirySeconds: number; maxExpirySeconds: number };
	available: GateAction[];
}
interface Approval {
	id: string;
	status: "pending" | "approved" | "denied" | "cancelled" | "applied" | "expired" | "failed";
	action: string;
	target: string;
	diff: { label?: string; summary?: string; method?: string; path?: string };
	expiresAt: string;
	createdAt: string;
	decidedAt: string | null;
	decidedByDevice: string | null;
	result: { status: number; detail: string | null } | null;
}

interface ApprovalList {
	approvals: Approval[];
}
interface GateSaveResult {
	gate?: GateView;
	status?: string;
}

const EXPIRY: Array<[number, string]> = [[3600, "1 hour"], [21600, "6 hours"], [86400, "24 hours"], [259200, "3 days"], [604800, "7 days"]];
const STATUS: Record<Approval["status"], string> = { pending: "Waiting for you", approved: "Approved, applying", applied: "Applied", denied: "Denied", cancelled: "Withdrawn", expired: "Expired", failed: "Not applied" };

/**
 * The account approval gate (#1268): which configuration changes wait for your approval before they take effect.
 *
 * A held change is stored exactly as asked and applied once, if you approve it before it expires and the thing it changes
 * has not moved. The same list is the audit: every request, who decided it from which device, and what the change answered.
 * Turning the gate off, or taking an action off the list, is itself held while the gate is on.
 */
export default function ApprovalGateSection() {
	const [gate, setGate] = useState<GateView | null>(null);
	const [approvals, setApprovals] = useState<Approval[]>([]);
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);
	const [params] = useSearchParams();
	const focus = params.get("approval");

	const load = useCallback(async () => {
		try {
			const [g, a] = await Promise.all([api<GateView>("/v1/approval-gate"), api<ApprovalList>("/v1/approvals?limit=30")]);
			setGate(g);
			setApprovals(a.approvals);
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Could not load the approval gate.");
		}
	}, []);
	useEffect(() => { void load(); }, [load]);
	useEffect(() => {
		const onPending = () => void load();
		window.addEventListener("pags:approval-pending", onPending);
		return () => window.removeEventListener("pags:approval-pending", onPending);
	}, [load]);
	const loaded = approvals.length > 0;
	useEffect(() => {
		if (focus && loaded) document.getElementById(`approval-${focus}`)?.scrollIntoView({ block: "center" });
	}, [focus, loaded]);

	const save = async (patch: Partial<Pick<GateView, "enabled" | "actions" | "expirySeconds">>) => {
		setBusy(true);
		setMessage("");
		try {
			const out = await api<GateSaveResult>("/v1/approval-gate", { method: "PUT", body: JSON.stringify(patch) });
			if (out.status === "approval_pending") setMessage("This change weakens the gate, so it is waiting for your approval below. Nothing has changed yet.");
			await load();
		} catch (error) {
			setMessage(error instanceof Error ? error.message : "Could not save.");
		} finally {
			setBusy(false);
		}
	};

	const decide = async (a: Approval, verb: "approve" | "deny" | "cancel") => {
		setBusy(true);
		setMessage("");
		try {
			await api(`/v1/approvals/${a.id}/${verb}`, { method: "POST", body: JSON.stringify({ device: navigator.userAgent }) });
		} catch (error) {
			setMessage(error instanceof Error ? error.message : `Could not ${verb} that.`);
		} finally {
			await load();
			setBusy(false);
		}
	};

	const toggleAction = (id: string) => {
		if (!gate) return;
		const actions = gate.actions.includes(id) ? gate.actions.filter((x) => x !== id) : [...gate.actions, id];
		void save({ actions });
	};

	const pending = approvals.filter((a) => a.status === "pending");
	const history = approvals.filter((a) => a.status !== "pending");

	return (
		<Card className="mb-3 sm:mb-4" aria-labelledby="approval-gate-heading" data-testid="approval-gate">
			<h2 id="approval-gate-heading" className="font-semibold">Approval gate</h2>
			<p className="text-xs text-muted-soft mt-1">
				Off by default. When on, the changes you tick below — from the console, the API or an assistant over MCP — are not applied. They wait here and on your phone until you approve the exact change. A request that expires, is denied, or finds what it changes has moved is never applied.
			</p>
			<label className="mt-3 flex items-center gap-2 text-sm">
				<input type="checkbox" checked={gate?.enabled ?? false} disabled={busy || !gate} onChange={(e) => void save({ enabled: e.target.checked })} /> Require approval for configuration changes
			</label>
			{gate?.enabled && (
				<>
					<fieldset className="mt-3 flex flex-col gap-2" disabled={busy}>
						<legend className="text-xs font-semibold">Changes that need approval</legend>
						{gate.available.map((a) => (
							<label key={a.id} className="flex items-start gap-2 text-sm">
								<input type="checkbox" className="mt-1" checked={gate.actions.includes(a.id)} onChange={() => toggleAction(a.id)} />
								<span>
									{a.label}
									<span className="block text-xs text-muted-soft">{a.description}</span>
								</span>
							</label>
						))}
					</fieldset>
					<label className="mt-3 flex items-center justify-between gap-2 text-sm">
						A request stays open for
						<select aria-label="Approval expiry" className="rounded border border-line bg-paper px-2 py-1" value={gate.expirySeconds} disabled={busy} onChange={(e) => void save({ expirySeconds: Number(e.target.value) })}>
							{!EXPIRY.some(([s]) => s === gate.expirySeconds) && <option value={gate.expirySeconds}>{Math.round(gate.expirySeconds / 60)} minutes</option>}
							{EXPIRY.map(([s, label]) => <option key={s} value={s}>{label}</option>)}
						</select>
					</label>
				</>
			)}
			{message && <p className="mt-2 text-xs text-warning" role="status">{message}</p>}

			{pending.length > 0 && (
				<div className="mt-4" data-testid="approval-pending">
					<h3 className="text-sm font-semibold">Waiting for you</h3>
					<ul className="mt-2 flex flex-col gap-3">
						{pending.map((a) => (
							<li key={a.id} id={`approval-${a.id}`} className={`rounded border p-3 text-sm ${focus === a.id ? "border-warning" : "border-line"}`}>
								<p className="font-semibold">{a.diff.label ?? a.action}</p>
								<p className="text-xs text-muted-soft break-words">{a.target}</p>
								<pre className="mt-2 whitespace-pre-wrap break-words text-xs">{a.diff.summary || "No arguments."}</pre>
								<p className="mt-1 text-xs text-muted-soft">Nothing has changed yet. Expires {new Date(a.expiresAt).toLocaleString()}.</p>
								<div className="mt-2 flex gap-2">
									<Button variant="primary" size="sm" disabled={busy} onClick={() => void decide(a, "approve")}>Approve</Button>
									<Button size="sm" disabled={busy} onClick={() => void decide(a, "deny")}>Deny</Button>
								</div>
							</li>
						))}
					</ul>
				</div>
			)}

			{history.length > 0 && (
				<div className="mt-4" data-testid="approval-history">
					<h3 className="text-sm font-semibold">History</h3>
					<ul className="mt-2 flex flex-col gap-1 text-xs">
						{history.map((a) => (
							<li key={a.id} id={`approval-${a.id}`} className="break-words">
								<span className="font-semibold">{STATUS[a.status]}</span> — {a.diff.label ?? a.action}: {a.target}
								<span className="text-muted-soft"> · {new Date(a.decidedAt ?? a.createdAt).toLocaleString()}{a.decidedByDevice ? ` · ${a.decidedByDevice}` : ""}</span>
								{a.status === "failed" && a.result?.detail && <span className="block text-danger">{a.result.detail}</span>}
							</li>
						))}
					</ul>
				</div>
			)}
		</Card>
	);
}
