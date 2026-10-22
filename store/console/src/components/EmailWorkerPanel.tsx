import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Button from "./Button";

/**
 * Console control for the Cloudflare Email Routing/Sending bridge.  The bridge secret is never an
 * input on this page: enrollment opens the existing one-shot secure-input page in a new tab, then
 * this page consumes it server-side after the owner says it is ready.
 */
type Sender = { address: string; approved: boolean; replyIdentity: boolean };
type Identities = {
	provider?: "cloudflare" | "generic";
	health?: { reachable?: boolean | null; lastCheckedAt?: string | null; lastFailureClass?: string | null };
	senders?: Sender[];
	routes?: Array<{ address: string; destination: string | null; canSend: boolean }>;
};
type Connection = {
	endpoint: string;
	accountId: string;
	label: string | null;
	contractVersion: string | null;
	pinnedToThisInstance: boolean;
	identities: Identities;
};
type Enrollment = { enrollmentId: string; state: "pending" | "ready" | "connected" | "probe_failed" | "expired" | "consumed"; failureClass: string | null };
type Status = {
	state: "absent" | "ambiguous" | "stale_pin" | "connected" | "blocked";
	connections: Connection[];
	resolved: { endpoint: string; accountId: string; label: string } | null;
	blockers: Array<{ code: string; message: string }>;
	readyToRead: boolean;
	readyToSend: boolean;
	enrollment?: Enrollment | null;
};

const enrollmentKey = (instanceId: string) => `pags:email-worker-enrollment:${instanceId}`;
/** Console SSR tests (and privacy-restricted browsers) may expose `window` without storage. A
 * setup bookmark is only a convenience — losing it must never stop the normal status read. */
function savedEnrollment(instanceId: string): string {
	try { return typeof window === "undefined" ? "" : window.sessionStorage?.getItem(enrollmentKey(instanceId)) ?? ""; } catch { return ""; }
}
function rememberEnrollment(instanceId: string, id: string | null): void {
	try {
		if (typeof window === "undefined" || !window.sessionStorage) return;
		if (id) window.sessionStorage.setItem(enrollmentKey(instanceId), id);
		else window.sessionStorage.removeItem(enrollmentKey(instanceId));
	} catch {
		// The bridge enrollment remains on the server; storage only helps this page resume it.
	}
}
const connectionKey = (connection: Pick<Connection, "endpoint" | "accountId">) => JSON.stringify([connection.endpoint, connection.accountId]);
const parseConnectionKey = (key: string): { endpoint: string; accountId: string } | null => {
	try {
		const value: unknown = JSON.parse(key);
		if (Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "string") return { endpoint: value[0], accountId: value[1] };
	} catch {
		// A stale local value is not a connection selection.
	}
	return null;
};

export default function EmailWorkerPanel({ instanceId }: { instanceId: string }) {
	const [status, setStatus] = useState<Status | null>(null);
	const [endpoint, setEndpoint] = useState("");
	const [label, setLabel] = useState("Hiring mail bridge");
	const [enrollmentId, setEnrollmentId] = useState(() => savedEnrollment(instanceId));
	const [selected, setSelected] = useState("");
	const [approved, setApproved] = useState<string[]>([]);
	const [replyIdentity, setReplyIdentity] = useState("");
	const [message, setMessage] = useState("");
	const [busy, setBusy] = useState(false);

	const load = useCallback(async () => {
		const query = enrollmentId ? `?enrollment=${encodeURIComponent(enrollmentId)}` : "";
		const data = await api<Status>(`/v1/instances/${instanceId}/email-worker/status${query}`);
		setStatus(data);
		const resolved = data.resolved;
		if (resolved) setSelected(JSON.stringify([resolved.endpoint, resolved.accountId]));
	}, [instanceId, enrollmentId]);

	useEffect(() => { void load().catch((e) => setMessage(e instanceof Error ? e.message : "Could not load the Cloudflare mail bridge.")); }, [load]);
	useEffect(() => {
		if (!enrollmentId || status?.enrollment?.state !== "pending") return;
		const timer = window.setInterval(() => void load().catch(() => undefined), 4000);
		return () => window.clearInterval(timer);
	}, [enrollmentId, status?.enrollment?.state, load]);

	const chosen = useMemo(() => status?.connections.find((connection) => connectionKey(connection) === selected) ?? null, [status, selected]);
	useEffect(() => {
		if (!chosen) return;
		const senders = chosen.identities.senders ?? [];
		setApproved(senders.filter((sender) => sender.approved).map((sender) => sender.address));
		setReplyIdentity(senders.find((sender) => sender.replyIdentity)?.address ?? "");
	}, [chosen?.endpoint, chosen?.accountId]);

	const beginEnrollment = async () => {
		if (!endpoint.trim()) { setMessage("Enter the HTTPS URL of the deployed Cloudflare Email Bridge."); return; }
		setBusy(true); setMessage("");
		try {
			const data = await api<{ enrollmentId: string; consoleUrl: string }>(`/v1/instances/${instanceId}/email-worker/enrollments`, { method: "POST", body: JSON.stringify({ endpoint: endpoint.trim(), label: label.trim() || undefined }) });
			setEnrollmentId(data.enrollmentId);
			rememberEnrollment(instanceId, data.enrollmentId);
			window.open(data.consoleUrl, "_blank", "noopener");
			setMessage("Enter the bridge secret in the secure tab, then return here and choose Finish connection. The secret is never shown to this page or to an agent.");
		} catch (e) { setMessage(e instanceof Error ? e.message : "Could not open secure enrollment."); }
		finally { setBusy(false); }
	};

	const finishEnrollment = async () => {
		if (!enrollmentId) return;
		setBusy(true); setMessage("");
		try {
			const data = await api<{ ok: boolean; error?: string }>(`/v1/instances/${instanceId}/email-worker/enrollments/${encodeURIComponent(enrollmentId)}/complete`, { method: "POST" });
			if (!data.ok) { setMessage(data.error ?? "The bridge secret has not been entered yet."); return; }
			rememberEnrollment(instanceId, null);
			setEnrollmentId("");
			setMessage("Cloudflare Email Bridge connected. Pin it to this agent, then approve a sender below.");
			await load();
		} catch (e) { setMessage(e instanceof Error ? e.message : "Could not complete the bridge connection."); }
		finally { setBusy(false); }
	};

	const pin = async () => {
		const target = parseConnectionKey(selected);
		if (!target) return;
		setBusy(true); setMessage("");
		try {
			await api(`/v1/instances/${instanceId}/email-worker/account`, { method: "PUT", body: JSON.stringify(target) });
			setMessage("This agent is now pinned to the selected Cloudflare mail bridge.");
			await load();
		} catch (e) { setMessage(e instanceof Error ? e.message : "Could not pin this bridge."); }
		finally { setBusy(false); }
	};

	const test = async () => {
		setBusy(true); setMessage("");
		try {
			const data = await api<{ ok: boolean; error?: string }>(`/v1/instances/${instanceId}/email-worker/test`, { method: "POST" });
			setMessage(data.ok ? "Bridge health check passed." : data.error ?? "Bridge health check failed.");
			await load();
		} catch (e) { setMessage(e instanceof Error ? e.message : "Could not test this bridge."); }
		finally { setBusy(false); }
	};

	const saveIdentities = async () => {
		if (!chosen) return;
		setBusy(true); setMessage("");
		try {
			await api("/v1/email-worker/connections/identities", { method: "PUT", body: JSON.stringify({ endpoint: chosen.endpoint, accountId: chosen.accountId, approvedSenders: approved, replyIdentity: replyIdentity || null }) });
			setMessage("Approved senders and reply identity saved.");
			await load();
		} catch (e) { setMessage(e instanceof Error ? e.message : "Could not save sender approvals."); }
		finally { setBusy(false); }
	};

	const enrollment = status?.enrollment;
	const cloudflare = chosen?.identities.provider === "cloudflare";
	return (
		<div className="mt-4 pt-4 border-t border-line" data-testid="cloudflare-email-bridge-panel">
			<div className="text-sm font-semibold">Cloudflare Email Bridge</div>
			<p className="text-2xs text-muted-soft mt-0.5">Use Cloudflare Email Routing and Email Sending as this agent’s mailbox. The bridge secret goes only into a one-shot secure form, never into chat or a tool call.</p>

			{status?.connections.length === 0 && !enrollmentId && (
				<div className="mt-2 grid gap-2 sm:grid-cols-2">
					<input aria-label="Cloudflare Email Bridge URL" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://mail.example.com" className="min-w-0 bg-paper border border-line rounded-lg px-3 py-2 text-sm" />
					<input aria-label="Cloudflare Email Bridge label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Hiring mail bridge" className="min-w-0 bg-paper border border-line rounded-lg px-3 py-2 text-sm" />
					<div className="sm:col-span-2"><Button onClick={() => void beginEnrollment()} disabled={busy}>Connect Cloudflare bridge</Button></div>
				</div>
			)}

			{enrollmentId && (
				<div className="mt-2 rounded-lg border border-line bg-panel p-3 text-xs">
					<p className="font-semibold">Bridge enrollment {enrollment?.state === "ready" ? "is ready to finish" : "is waiting for the secure secret"}.</p>
					<p className="text-muted-soft mt-0.5">{enrollment?.state === "probe_failed" ? `The bridge rejected the stored secret (${enrollment.failureClass ?? "unknown"}). Fix the bridge and finish again; you do not need to re-enter the secret.` : "The secure form is open in a separate tab so this setup page stays available."}</p>
					<div className="mt-2"><Button onClick={() => void finishEnrollment()} disabled={busy || enrollment?.state === "pending"}>Finish connection</Button></div>
				</div>
			)}

			{status && status.connections.length > 0 && (
				<div className="mt-3 space-y-3">
					<div className="flex flex-wrap gap-2 items-end">
						<label className="flex-1 min-w-0 text-2xs text-muted-soft">Bridge this agent uses
							<select aria-label="Cloudflare Email Bridge connection" value={selected} onChange={(e) => setSelected(e.target.value)} className="mt-1 block w-full bg-paper border border-line rounded-lg px-3 py-2 text-sm text-ink">
								{status.connections.map((connection) => <option key={connectionKey(connection)} value={connectionKey(connection)}>{connection.label || connection.endpoint}{connection.pinnedToThisInstance ? " · pinned" : ""}</option>)}
							</select>
						</label>
						<Button onClick={() => void pin()} disabled={busy || !chosen || chosen.pinnedToThisInstance}>Pin to this agent</Button>
						<Button onClick={() => void test()} disabled={busy || !status.resolved}>Test bridge</Button>
					</div>
					{chosen && <p className="text-2xs text-muted-soft">{chosen.identities.health?.reachable === false ? `Last bridge check failed: ${chosen.identities.health.lastFailureClass ?? "unknown"}.` : chosen.identities.health?.reachable === true ? "Bridge last checked successfully." : "Bridge has not been checked yet."}</p>}

					{cloudflare && chosen && (
						<div className="rounded-lg border border-line p-3">
							<p className="text-sm font-semibold">Approved senders</p>
							<p className="text-2xs text-muted-soft mt-0.5">Only sender identities reported by this Cloudflare bridge can be approved. An Email Routing address alone cannot send.</p>
							<div className="mt-2 space-y-1">
								{(chosen.identities.senders ?? []).map((sender) => <label key={sender.address} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={approved.includes(sender.address)} onChange={(e) => setApproved((current) => e.target.checked ? [...new Set([...current, sender.address])] : current.filter((address) => address !== sender.address))} />{sender.address}</label>)}
								{(chosen.identities.senders ?? []).length === 0 && <p className="text-xs text-muted">No send-capable identities were reported. Test the bridge after configuring Email Sending.</p>}
							</div>
							<label className="block mt-2 text-2xs text-muted-soft">Reply identity
								<select aria-label="Cloudflare reply identity" value={replyIdentity} onChange={(e) => setReplyIdentity(e.target.value)} className="mt-1 block w-full bg-paper border border-line rounded-lg px-3 py-2 text-sm text-ink"><option value="">No reply identity</option>{approved.map((address) => <option key={address} value={address}>{address}</option>)}</select>
							</label>
							<div className="mt-2"><Button onClick={() => void saveIdentities()} disabled={busy}>Save sender approvals</Button></div>
						</div>
					)}
					{status.blockers.length > 0 && <div className="text-xs text-amber-700 dark:text-amber-300">{status.blockers.map((blocker) => <p key={blocker.code}>{blocker.message}</p>)}</div>}
				</div>
			)}
			{message && <p className="mt-2 text-xs text-muted">{message}</p>}
		</div>
	);
}
