import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Card from "./Card";
import LoadFailed from "./LoadFailed";
import BrowserModeSelect, { type BrowserMode } from "./BrowserModeSelect";

/** A template default; an owner can override it for their private instance. */
export default function BrowserModeCapabilityCard({ agentId }: { agentId: string }) {
	const [data, setData] = useState<{ browserMode?: BrowserMode | null } | null>(null);
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	const [saving, setSaving] = useState(false);
	const load = useCallback(async () => {
		try {
			setData(await api<{ browserMode?: BrowserMode | null }>(`/v1/agents/${agentId}/capabilities`));
			setError("");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [agentId]);
	useEffect(() => { void load(); }, [load]);
	if (error && !data) return <LoadFailed what="browser mode default" detail={error} onRetry={load} />;
	if (!data) return null;
	const save = async (browserMode: BrowserMode | null) => {
		setSaving(true);
		setMessage("");
		try {
			setData(await api<{ browserMode?: BrowserMode | null }>(`/v1/agents/${agentId}/capabilities`, { method: "PUT", body: JSON.stringify({ browserMode }) }));
			setMessage("Saved — applies on the next browser launch. Current tasks continue unchanged.");
		} catch (e) {
			setMessage(e instanceof Error ? e.message : String(e));
		}
		setSaving(false);
	};
	return (
		<Card className="mb-4" data-testid="browser-mode-default">
			<h3 className="text-base font-semibold mb-1">Browser mode default</h3>
			<p className="text-sm text-muted mb-3">Choose whether this agent opens a visible window on its runner machine. Each subscriber can override this in their instance settings. Changes apply on the next browser launch; current tasks continue unchanged.</p>
			<BrowserModeSelect value={data.browserMode ?? null} inheritLabel="Use runner default" disabled={saving} onChange={(mode) => void save(mode)} />
			<p className="text-xs text-muted mt-2">Visible mode needs a desktop session on the runner machine. Headless mode runs without a window. Screenshot replay works in either mode.</p>
			{message && <p role="status" className="text-xs mt-2">{message}</p>}
		</Card>
	);
}
