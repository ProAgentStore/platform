import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import { Check, X } from "lucide-react";
import Button from "../components/Button";
import Page from "../components/Page";
import type { DeviceDecisionResponse, DeviceRequestResponse, DeviceRequestView } from "../lib/deviceAuth";

/**
 * Approve a machine's `pags login --device` (#1157) — the page its link and code lead to, from any device.
 *
 * It shows which machine asked, from which address and when BEFORE the owner can approve, because the one way this
 * flow is abused is a code someone else started and sent: approving signs THAT machine in as you.
 */
export default function DeviceApprove() {
	const [params, setParams] = useSearchParams();
	const code = params.get("code") ?? "";
	const [typed, setTyped] = useState(code);
	const [request, setRequest] = useState<DeviceRequestView | null>(null);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	// How long this machine stays signed in (#1184): "" = the owner's own default for new machines (30 days unless changed).
	const [lifetime, setLifetime] = useState("");
	// Runner only (#1192): the machine's sign-in can run `pags up` but not manage the account. Pre-ticked when the machine asked.
	const [runnerOnly, setRunnerOnly] = useState<boolean | null>(null);

	const load = useCallback(async () => {
		if (!code) return;
		try {
			const res = await api<DeviceRequestResponse>(`/v1/auth/device/requests/${encodeURIComponent(code)}`);
			setRequest(res.request);
			setError("");
		} catch (e) {
			setRequest(null);
			setError(e instanceof Error ? e.message : "Could not load this sign-in");
		}
	}, [code]);

	useEffect(() => {
		void load();
	}, [load]);

	const decide = async (approve: boolean) => {
		setBusy(true);
		try {
			const res = await api<DeviceDecisionResponse>(`/v1/auth/device/requests/${encodeURIComponent(code)}`, { method: "POST", body: JSON.stringify({ approve, ...(approve && lifetime ? { lifetimeDays: Number(lifetime) } : {}), ...(approve ? { runnerOnly: runnerOnly ?? request?.requestedScope === "runner" } : {}) }) });
			if (res.request) setRequest(res.request);
			else setRequest((r) => (r ? { ...r, status: approve ? "approved" : "denied" } : r));
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not record your answer");
		} finally {
			setBusy(false);
		}
	};

	return (
		<Page>
			<h1 className="font-display text-xl font-bold mb-4">Sign in a machine</h1>
			<div className="max-w-xl flex flex-col gap-4" data-testid="device-approve">
				{!code && (
					<form
						className="flex gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							setParams({ code: typed.trim().toUpperCase() });
						}}
					>
						<input
							className="flex-1 border border-line rounded-lg px-3 py-2 bg-paper font-mono tracking-widest uppercase"
							placeholder="BCDF-GHJK"
							value={typed}
							onChange={(e) => setTyped(e.target.value)}
							aria-label="The code `pags login --device` shows"
						/>
						<Button type="submit" variant="primary">Continue</Button>
					</form>
				)}
				{error && <p className="text-warning text-sm" data-testid="device-error">{error}</p>}
				{request && (
					<>
						<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm border border-line rounded-lg p-4 bg-paper">
							<dt className="text-muted">Code</dt>
							<dd className="font-mono tracking-widest">{request.userCode}</dd>
							<dt className="text-muted">Machine</dt>
							<dd>{request.node ?? "did not say"}</dd>
							<dt className="text-muted">From</dt>
							<dd>{[request.ip, request.country].filter(Boolean).join(" · ") || "unknown"}</dd>
							<dt className="text-muted">Asked</dt>
							<dd>{new Date(request.createdAt).toLocaleString()}</dd>
							<dt className="text-muted">Expires</dt>
							<dd>{new Date(request.expiresAt).toLocaleString()}</dd>
						</dl>
						{request.status === "pending" ? (
							<>
								<p className="text-sm">
									Approve only if <strong>you</strong> just ran <code>pags login</code> on this machine and it shows this same code. Approving signs that machine in to
									your account.
								</p>
								<label className="text-sm flex flex-wrap items-center gap-2" htmlFor="device-lifetime">
									<span className="text-muted">Stay signed in for</span>
									<select id="device-lifetime" value={lifetime} onChange={(e) => setLifetime(e.target.value)} className="rounded border border-line bg-paper px-2 py-1 text-sm" data-testid="device-lifetime">
										<option value="">my default</option>
										<option value="30">30 days</option>
										<option value="90">90 days</option>
										<option value="180">180 days</option>
									</select>
									<span className="text-xs text-muted">A running machine renews itself; you can revoke it any time with <code>pags devices revoke</code>.</span>
								</label>
								<label className="text-sm flex items-start gap-2" htmlFor="device-runner-only">
									<input id="device-runner-only" type="checkbox" className="mt-1" checked={runnerOnly ?? request.requestedScope === "runner"} onChange={(e) => setRunnerOnly(e.target.checked)} data-testid="device-runner-only" />
									<span>
										<strong>Runner only</strong> — this machine can run <code>pags up</code> but cannot manage your account. Recommended for an unattended machine:
										a coding engine on it can read the sign-in file, and a runner-only one is worth little if it does.
										{request.requestedScope === "runner" && <em className="text-muted"> (The machine asked for this.)</em>}
									</span>
								</label>
								<div className="flex gap-2">
									<Button variant="primary" onClick={() => void decide(true)} disabled={busy} data-testid="device-approve-button">
										<Check size={16} /> Approve
									</Button>
									<Button variant="secondary" onClick={() => void decide(false)} disabled={busy} data-testid="device-deny-button">
										<X size={16} /> Deny
									</Button>
								</div>
							</>
						) : (
							<p className={request.status === "denied" ? "text-muted" : "text-success"} data-testid="device-status">
								{request.status === "denied" ? "Denied — that machine was not signed in." : "Approved — the machine signs in within a few seconds. You can close this page."}
							</p>
						)}
					</>
				)}
			</div>
		</Page>
	);
}
