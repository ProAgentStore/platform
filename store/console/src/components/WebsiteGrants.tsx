import { useCallback, useEffect, useState } from "react";
import { getWebsiteGrants, revokeWebsiteGrant } from "../lib/websiteAccess";

export default function WebsiteGrants({ instanceId }: { instanceId: string }) {
	const [decisions, setDecisions] = useState<Array<{ hostname: string; decision: "allow" | "deny" }>>([]);
	const [loaded, setLoaded] = useState(false);
	const [error, setError] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const [message, setMessage] = useState("");
	const load = useCallback(async () => {
		try { const response = await getWebsiteGrants(instanceId); setDecisions(response.decisions ?? response.domains.map((hostname) => ({ hostname, decision: "allow" as const }))); setLoaded(true); setError(""); }
		catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
	}, [instanceId]);
	useEffect(() => { setDecisions([]); setLoaded(false); setMessage(""); void load(); }, [load]);
	const revoke = async (hostname: string) => {
		setBusy(hostname); setMessage("");
		try { await revokeWebsiteGrant(instanceId, hostname); setDecisions((current) => current.filter((entry) => entry.hostname !== hostname)); setError(""); setMessage(`Remembered decision removed for ${hostname}.`); }
		catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
		finally { setBusy(null); }
	};
	return <section aria-label="Remembered website access" className="mt-4 border-t border-line pt-3 min-w-0">
		<h4 className="font-semibold text-sm">Remembered websites</h4>
		<p className="text-xs text-muted mt-1">Your saved allow and deny decisions for this agent; forgetting one removes it.</p>
		{loaded && decisions.length === 0 && <p className="text-sm mt-2">No remembered websites.</p>}
		{decisions.length > 0 && <ul className="mt-2 divide-y divide-line">{decisions.map(({ hostname, decision }) => <li key={hostname} className="flex items-center justify-between gap-3 py-2">
			<span className="text-sm break-all min-w-0">{hostname} <span className="text-muted">— {decision === "allow" ? "Allowed" : "Denied"}</span></span>
			<button type="button" className="shrink-0 text-sm text-danger disabled:opacity-50" disabled={busy !== null} aria-label={`Forget decision for ${hostname}`} onClick={() => void revoke(hostname)}>{busy === hostname ? "Forgetting…" : "Forget"}</button>
		</li>)}</ul>}
		{error && <div role="alert" className="text-xs text-danger mt-2"><p>{error}</p><button type="button" className="underline mt-1" onClick={() => void load()}>Retry loading websites</button></div>}
		{message && <p role="status" className="text-xs mt-2 break-words">{message}</p>}
	</section>;
}
