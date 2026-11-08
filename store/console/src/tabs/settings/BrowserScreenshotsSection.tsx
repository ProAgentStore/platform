import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Card from "../../components/Card";
import LoadFailed from "../../components/LoadFailed";
import type { BrowserScreenshotsView } from "../../lib/browserScreenshots";

/**
 * Capture and form-field blur are independent settings (#1064, #1433). Both are read when a run
 * starts. Changing either never changes existing runs or stored screenshots.
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

	const save = async (patch: Partial<Pick<BrowserScreenshotsView, "enabled" | "blurFormFields">>) => {
		setSaving(true);
		setMsg("");
		try {
			setData(await api<BrowserScreenshotsView>(`/v1/instances/${instanceId}/browser-screenshots`, { method: "PUT", body: JSON.stringify(patch) }));
			setMsg("Saved — applies to future runs. Existing screenshots stay unchanged.");
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
		setSaving(false);
	};

	return (
		<Card className="mb-3 sm:mb-4" data-testid="browser-screenshot-settings">
			<h3 className="text-base font-bold mb-1">Browser screenshots</h3>
			<details className="text-xs text-muted mb-3">
				<summary className="cursor-pointer font-semibold min-h-6 inline-flex items-center">How screenshots work</summary>
				<p className="mt-1">{data.explained}</p>
			</details>
			<label className="flex gap-2 items-center text-sm font-semibold">
				<input type="checkbox" checked={data.enabled} disabled={saving} onChange={(e) => void save({ enabled: e.target.checked })} data-testid="bs-enabled" />
				Capture screenshots for run replay
			</label>
			{!data.enabled && <p className="text-xs text-muted mt-2">Screenshot capture is off. Future runs save no screenshots, regardless of the blur setting.</p>}
			<label className="flex gap-2 items-center text-sm font-semibold mt-3">
				<input type="checkbox" checked={data.blurFormFields !== false} disabled={saving} onChange={(e) => void save({ blurFormFields: e.target.checked })} data-testid="bs-blur-form-fields" />
				Blur form fields
			</label>
			<p className="text-xs text-muted mt-2">When blur is off, screenshots include visible form values in your owner-only replay; the site's password bullets stay as shown.</p>
			{msg && <p role="status" className="text-xs mt-2">{msg}</p>}
		</Card>
	);
}
