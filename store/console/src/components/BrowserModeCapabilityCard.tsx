import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Card from "./Card";
import LoadFailed from "./LoadFailed";
import BrowserSettingsFields, { BrowserSettingsHelp } from "./BrowserSettingsFields";
import { browserCapabilitiesPatch, type BrowserCapabilities, type BrowserSettings } from "../lib/browserSettings";

/** Template defaults; each owner can override fields for their private instance. */
export default function BrowserModeCapabilityCard({ agentId }: { agentId: string }) {
	const [data, setData] = useState<BrowserCapabilities | null>(null);
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	const [saving, setSaving] = useState(false);
	const load = useCallback(async () => {
		try {
			setData(await api<BrowserCapabilities>(`/v1/agents/${agentId}/capabilities`));
			setError("");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [agentId]);
	useEffect(() => { void load(); }, [load]);
	if (error && !data) return <LoadFailed what="browser defaults" detail={error} onRetry={load} />;
	if (!data) return null;
	const save = async (patch: Partial<BrowserSettings>) => {
		setSaving(true);
		setMessage("");
		try {
			setData(await api<BrowserCapabilities>(`/v1/agents/${agentId}/capabilities`, { method: "PUT", body: JSON.stringify(browserCapabilitiesPatch(patch)) }));
			setMessage("Saved — applies on the next browser launch. Current tasks continue unchanged.");
		} catch (e) {
			setMessage(e instanceof Error ? e.message : String(e));
		}
		setSaving(false);
	};
	return (
		<Card className="mb-4" data-testid="browser-mode-default">
			<h3 className="text-base font-semibold mb-1">Browser defaults</h3>
			<p className="text-sm text-muted mb-3">Choose this agent's browser, window mode and profile. Each subscriber can override individual settings. Changes apply on the next browser launch; current tasks continue unchanged.</p>
			<BrowserSettingsFields value={{ mode: data.browserMode ?? null, engine: data.browserEngine ?? null, profile: data.browserProfilePolicy ?? null }} disabled={saving} onChange={(patch) => void save(patch)} />
			<BrowserSettingsHelp />
			{message && <p role="status" className="text-xs mt-2">{message}</p>}
		</Card>
	);
}
