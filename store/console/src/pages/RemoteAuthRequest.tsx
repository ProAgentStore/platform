import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import { ExternalLink, KeyRound } from "lucide-react";
import Button from "../components/Button";
import Page from "../components/Page";
import LoadFailed from "../components/LoadFailed";
import { REMOTE_AUTH_QUIET_MS, type RemoteAuthRequestResponse, type RemoteAuthRequestView, remoteAuthCanSignIn, remoteAuthStatusLine } from "../lib/remoteAuth";

/**
 * One PAS remote sign-in request (#1005) — the page a "Approve a ProAppStore sign-in" push opens.
 *
 * Shows exactly what the owner's machine asked for (agent, machine, service, resource, scopes) BEFORE any
 * sign-in, then hands the owner to ProAppStore's own approval page in their browser. PAGS never calls PAS
 * and never sees a PAS credential: approval, the Google/GitHub sign-in and consent all happen at
 * ProAppStore, and the machine collects its result there directly. This page only reflects what the
 * machine reports.
 */
export default function RemoteAuthRequest() {
	const { requestId } = useParams<{ requestId: string }>();
	const [request, setRequest] = useState<RemoteAuthRequestView | null>(null);
	const [loadError, setLoadError] = useState("");
	const [copied, setCopied] = useState(false);

	const load = useCallback(async () => {
		if (!requestId) return;
		try {
			const res = await api<RemoteAuthRequestResponse>(`/v1/remote-auth/requests/${encodeURIComponent(requestId)}`);
			setRequest(res.request);
			setLoadError("");
		} catch (e) {
			setLoadError(e instanceof Error ? e.message : "Could not load this request");
		}
	}, [requestId]);

	useEffect(() => {
		void load();
	}, [load]);

	const status = request ? remoteAuthStatusLine(request.effectiveState) : null;
	// While the request can still move, follow the machine's reports.
	useEffect(() => {
		if (!status || status.terminal) return;
		const t = setInterval(() => void load(), 5_000);
		return () => clearInterval(t);
	}, [status, load]);

	const heading = <h1 className="font-display text-xl font-bold mb-4">Approve a ProAppStore sign-in</h1>;
	if (loadError && !request) {
		return (
			<Page>
				{heading}
				<LoadFailed what="this sign-in request" detail={loadError} onRetry={() => void load()} />
			</Page>
		);
	}
	if (!request || !status) {
		return (
			<Page>
				{heading}
				<div className="text-muted text-sm">Loading…</div>
			</Page>
		);
	}

	const quiet = !status.terminal && Date.now() - Date.parse(request.lastReportedAt) > REMOTE_AUTH_QUIET_MS;
	const copyPageLink = async () => {
		await navigator.clipboard?.writeText(window.location.href).catch(() => undefined);
		setCopied(true);
	};

	return (
		<Page>
			{heading}
			<div className="max-w-xl flex flex-col gap-4" data-testid="remote-auth-request">
				<p className={status.tone === "ok" ? "text-success" : status.tone === "warn" ? "text-warning" : "text-muted"} data-testid="remote-auth-status">
					{status.text}
				</p>
				{quiet && <p className="text-muted text-sm">The machine has not reported for a few minutes — it may be offline. The request stays open until it expires.</p>}

				<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm border border-line rounded-lg p-4 bg-paper">
					<dt className="text-muted">Agent</dt>
					<dd>{request.agent.label}</dd>
					<dt className="text-muted">Machine</dt>
					<dd>
						{request.machine.label}
						{request.relayedBy.node && <span className="text-muted"> · relayed by {request.relayedBy.node}</span>}
					</dd>
					<dt className="text-muted">Service</dt>
					<dd>{request.service}</dd>
					<dt className="text-muted">Access</dt>
					<dd className="break-all">{request.resource}</dd>
					<dt className="text-muted">Scopes</dt>
					<dd>{request.scopes.length ? request.scopes.join(", ") : "none beyond this resource"}</dd>
					<dt className="text-muted">Expires</dt>
					<dd>{new Date(request.expiresAt).toLocaleString()}</dd>
				</dl>

				{remoteAuthCanSignIn(request.effectiveState) && (
					<div className="flex flex-col gap-2">
						<a href={request.approvalUrl} target="_blank" rel="noopener noreferrer" data-testid="remote-auth-sign-in">
							<Button>
								<KeyRound size={16} /> Sign in at ProAppStore <ExternalLink size={14} />
							</Button>
						</a>
						<p className="text-muted text-sm">
							This opens ProAppStore's own sign-in page in your browser, where you choose Google or GitHub and approve. If it opens inside another app's preview and Google refuses there, open
							this page in Safari or Chrome instead:{" "}
							<button type="button" className="underline" onClick={() => void copyPageLink()}>
								{copied ? "link copied" : "copy this page's link"}
							</button>
							.
						</p>
					</div>
				)}
			</div>
		</Page>
	);
}
