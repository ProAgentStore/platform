import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Card from "../../components/Card";
import LoadFailed from "../../components/LoadFailed";
import type { BrowserScreenshotsView } from "../../lib/browserScreenshots";

/**
 * Settings → Browser screenshots (#1064). One switch for every browser run this agent makes. It is
 * read when a run STARTS, so flipping it never changes a run already going; turning it off deletes
 * nothing already stored.
 */
export default function BrowserScreenshotsSection({ instanceId }: { instanceId: string }) {
	const [data, setData] = useState<BrowserScreenshotsView | null>(null);
	const [error, setError] = useState("");
	const [msg, setMsg] = useState("");
	const [saving, setSaving] = useState(false);

	const load = useCallback(async () => {
		try {
			setData(await api<BrowserScreenshotsView>(`/v1/instances/${instanceId}/browser-screenshots`));
			setError("");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [instanceId]);
	useEffect(() => {
		load();
	}, [load]);

	if (error && !data) return <LoadFailed what="browser screenshot settings" detail={error} onRetry={load} />;
	if (!data) return null;

	const toggle = async (enabled: boolean) => {
		setSaving(true);
		setMsg("");
		try {
			setData(await api<BrowserScreenshotsView>(`/v1/instances/${instanceId}/browser-screenshots`, { method: "PUT", body: JSON.stringify({ enabled }) }));
			setMsg(enabled ? "On — runs started from now take replay screenshots." : "Off — runs started from now take no screenshots.");
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
		setSaving(false);
	};

	return (
		<Card className="mb-3 sm:mb-4">
			<h3 className="text-base font-bold mb-1">Browser screenshots</h3>
			<p className="text-sm text-muted mb-3">{data.explained}</p>
			<label className="flex gap-2 items-center text-sm font-semibold">
				<input type="checkbox" checked={data.enabled} disabled={saving} onChange={(e) => void toggle(e.target.checked)} data-testid="bs-enabled" />
				Capture screenshots for run replay
			</label>
			{msg && <p className="text-xs mt-2">{msg}</p>}
		</Card>
	);
}
