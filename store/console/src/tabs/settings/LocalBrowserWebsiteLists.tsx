import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Button from "../../components/Button";
import LocalBrowserWebsiteFields from "./LocalBrowserWebsiteFields";
import { accessPatchFromForm, type SettingsForm, formFromSettings } from "../../lib/localBrowser";
import type { LocalBrowserConsentEntry, LocalBrowserConsentList, LocalBrowserSettingsResponse, LocalBrowserSettingsSaved } from "../../lib/types";

type Lists = Pick<SettingsForm, "allowDomains" | "denyDomains">;

/**
 * The older site lists and "Your decisions", inside Browser settings' one Website access block (#1593). Shown only while
 * website access is not set, which is when a run reads them. Saving sends the lists alone: the endpoint takes a partial
 * patch, so Research settings and these lists never rewrite each other.
 */
export default function LocalBrowserWebsiteLists({ instanceId }: { instanceId: string }) {
	const [allowDomains, setAllowDomains] = useState<string[]>([]);
	const [form, setForm] = useState<Lists | null>(null);
	const [sites, setSites] = useState<LocalBrowserConsentEntry[]>([]);
	const [error, setError] = useState("");
	const [msg, setMsg] = useState("");
	const [saving, setSaving] = useState(false);
	const load = useCallback(async () => {
		try {
			const [s, c] = await Promise.all([
				api<LocalBrowserSettingsResponse>(`/v1/instances/${instanceId}/local-browser/settings`),
				api<LocalBrowserConsentList>(`/v1/instances/${instanceId}/local-browser/consent`),
			]);
			const { allowDomains: allow, denyDomains: deny } = formFromSettings(s.settings);
			setAllowDomains(s.capability.allowDomains);
			setForm({ allowDomains: allow, denyDomains: deny });
			setSites(c.consent.filter((e) => e.scope === "navigate"));
			setError("");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [instanceId]);
	useEffect(() => { void load(); }, [load]);
	const save = async () => {
		if (!form) return;
		setSaving(true);
		setMsg("");
		try {
			const r = await api<LocalBrowserSettingsSaved>(`/v1/instances/${instanceId}/local-browser/settings`, { method: "PUT", body: JSON.stringify(accessPatchFromForm(form)) });
			const { allowDomains: allow, denyDomains: deny } = formFromSettings(r.settings);
			setForm({ allowDomains: allow, denyDomains: deny });
			setMsg("Saved.");
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
		setSaving(false);
	};
	const decide = async (body: Record<string, unknown>) => {
		try {
			setSites((await api<LocalBrowserConsentList>(`/v1/instances/${instanceId}/local-browser/consent`, { method: "PUT", body: JSON.stringify(body) })).consent.filter((e) => e.scope === "navigate"));
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
	};
	return <section aria-label="Site lists used by default access" data-testid="legacy-website-lists" className="mt-4 border-t border-line pt-3 min-w-0">
		<h4 className="font-semibold text-sm mb-2">Used while website access is the agent/workflow default</h4>
		{error && !form && <div role="alert" className="text-xs text-danger"><p>{error}</p><button type="button" className="underline mt-1" onClick={() => void load()}>Retry loading site lists</button></div>}
		{form && <>
			<LocalBrowserWebsiteFields allowDomains={allowDomains} form={form} sites={sites} set={(patch) => setForm((f) => (f ? { ...f, ...patch } : f))} decide={(body) => void decide(body)} />
			<div className="flex gap-2 items-center flex-wrap">
				<Button variant="primary" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save site lists"}</Button>
				{msg && <span role="status" className={`text-xs ${msg === "Saved." ? "text-success" : "text-danger"}`}>{msg}</span>}
			</div>
		</>}
	</section>;
}
