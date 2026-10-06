import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import Button from "../../components/Button";
import Card from "../../components/Card";
import LoadFailed from "../../components/LoadFailed";
import { type SettingsForm, authModeChoices, engineAuthLabel, formFromSettings, patchFromForm, TONE_CLASS } from "../../lib/localBrowser";
import type { LocalBrowserConsentEntry, LocalBrowserConsentList, LocalBrowserRunList, LocalBrowserSettingsResponse, LocalBrowserSettingsSaved } from "../../lib/types";

const input = "bg-paper border border-line rounded px-2 py-1.5 text-sm";
const LIMITS = [
	["maxMinutes", "Minutes per run"],
	["maxPages", "Pages per run"],
	["maxActions", "Browser actions per run"],
	["maxConcurrent", "Runs at once"],
] as const;

/**
 * Settings → Local browser research (#946). Everything a run is started with, within the agent's
 * own ceilings — and nothing about repositories. The machine it runs on is the instance's runner
 * pin, chosen in the Runner card below; the server refuses anything outside what the agent allows
 * and the refusal is shown as it is.
 */
export default function LocalBrowserSection({ instanceId }: { instanceId: string }) {
	const [data, setData] = useState<LocalBrowserSettingsResponse | null>(null);
	const [form, setForm] = useState<SettingsForm | null>(null);
	const [consent, setConsent] = useState<LocalBrowserConsentEntry[]>([]);
	const [lastAuth, setLastAuth] = useState<string | null>(null);
	const [error, setError] = useState("");
	const [msg, setMsg] = useState("");
	const [saving, setSaving] = useState(false);

	const load = useCallback(async () => {
		try {
			const [s, c, runs] = await Promise.all([
				api<LocalBrowserSettingsResponse>(`/v1/instances/${instanceId}/local-browser/settings`),
				api<LocalBrowserConsentList>(`/v1/instances/${instanceId}/local-browser/consent`),
				api<LocalBrowserRunList>(`/v1/instances/${instanceId}/local-browser/runs?limit=1`),
			]);
			setData(s);
			setForm(formFromSettings(s.settings));
			setConsent(c.consent);
			setLastAuth(runs.runs[0]?.engineAuth ?? null);
			setError("");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [instanceId]);
	useEffect(() => {
		load();
	}, [load]);

	if (error && !data) return <LoadFailed what="local browser settings" detail={error} onRetry={load} />;
	if (!data || !form) return null;
	const cap = data.capability;
	const set = (patch: Partial<SettingsForm>) => setForm((f) => (f ? { ...f, ...patch } : f));

	const save = async () => {
		setSaving(true);
		setMsg("");
		try {
			const r = await api<LocalBrowserSettingsSaved>(`/v1/instances/${instanceId}/local-browser/settings`, { method: "PUT", body: JSON.stringify(patchFromForm(form)) });
			setForm(formFromSettings(r.settings));
			setMsg("Saved.");
		} catch (e) {
			// The server says exactly what is out of bounds and why; show it as it is.
			setMsg(e instanceof Error ? e.message : String(e));
		}
		setSaving(false);
	};
	const decide = async (body: Record<string, unknown>) => {
		try {
			setConsent((await api<LocalBrowserConsentList>(`/v1/instances/${instanceId}/local-browser/consent`, { method: "PUT", body: JSON.stringify(body) })).consent);
		} catch (e) {
			setMsg(e instanceof Error ? e.message : String(e));
		}
	};
	const profileAllowed = consent.some((c) => c.scope === "signed_in_profile" && c.decision === "allow");
	const sites = consent.filter((c) => c.scope === "navigate");
	const auth = engineAuthLabel(lastAuth);

	return (
		<Card className="mb-3 sm:mb-4">
			<h3 className="text-base font-bold mb-1">Local browser research</h3>
			<p className="text-sm text-muted mb-3">
				Runs on <span className="font-semibold">{data.runnerNode ?? "whichever machine runs `pags up`"}</span> — choose the machine in the Runner card below. PAGS keeps the run and asks you first; the CLI signed in on that machine does the browsing.
			</p>
			{data.problem && <p className="text-sm text-warning mb-3">{data.problem}</p>}

			<div className="grid sm:grid-cols-2 gap-3 mb-3">
				<label className="flex flex-col gap-1 text-xs font-semibold">
					Task engine
					<select className={input} value={form.engine} onChange={(e) => set({ engine: e.target.value })}>
						<option value="">Agent default ({cap.engines[0] === "claude" ? "Claude Code" : "Codex"})</option>
						{cap.engines.map((e) => (
							<option key={e} value={e}>
								{e === "claude" ? "Claude Code" : "Codex"}
							</option>
						))}
					</select>
				</label>
				<label className="flex flex-col gap-1 text-xs font-semibold">
					Sign-in
					<select className={input} value={form.authMode} onChange={(e) => set({ authMode: e.target.value })}>
						<option value="">Agent default (subscription)</option>
						{authModeChoices(cap).map((m) => (
							<option key={m.value} value={m.value}>
								{m.label}
							</option>
						))}
					</select>
					<span className="font-normal text-muted">
						Last run: <span className={TONE_CLASS[auth.tone]}>{auth.label}</span>. Checked on the machine at the start of every run.
					</span>
				</label>
			</div>

			<fieldset className="mb-3">
				<legend className="text-xs font-semibold mb-1">Workspace</legend>
				<div className="flex flex-col gap-1 text-sm">
					<label className="flex gap-2 items-center">
						<input type="radio" checked={form.workspace === "scratch"} onChange={() => set({ workspace: "scratch" })} /> A managed scratch folder per run (recommended)
					</label>
					<label className="flex gap-2 items-center flex-wrap">
						<input type="radio" checked={form.workspace === "path"} onChange={() => set({ workspace: "path" })} /> A folder in your home:
						<input className={`${input} flex-1 min-w-40`} value={form.workspacePath} placeholder="~/jobs" disabled={form.workspace !== "path"} onChange={(e) => set({ workspacePath: e.target.value })} />
					</label>
				</div>
			</fieldset>

			<fieldset className="mb-3">
				<legend className="text-xs font-semibold mb-1">Browser</legend>
				<div className="flex flex-col gap-1 text-sm">
					<label className="flex gap-2 items-center">
						<input type="radio" checked={form.browserProfile === "isolated"} onChange={() => set({ browserProfile: "isolated" })} /> A fresh browser with no sign-ins
					</label>
					<label className="flex gap-2 items-center">
						<input type="radio" checked={form.browserProfile === "default"} onChange={() => set({ browserProfile: "default" })} /> My own browser profile, with my sign-ins
					</label>
					{form.browserProfile === "default" && (
						<label className="flex gap-2 items-center text-xs text-muted ml-5">
							<input type="checkbox" checked={profileAllowed} onChange={(e) => decide({ scope: "signed_in_profile", decision: e.target.checked ? "allow" : null })} />
							I allow research in my signed-in profile (a run waits for this otherwise)
						</label>
					)}
				</div>
			</fieldset>

			<div className="grid sm:grid-cols-2 gap-3 mb-3">
				<label className="flex flex-col gap-1 text-xs font-semibold">
					Allowed sites <span className="font-normal text-muted">One per line. Empty = any public site, each asked about first{cap.allowDomains.length ? `. This agent allows: ${cap.allowDomains.join(", ")}` : ""}.</span>
					<textarea className={input} rows={3} value={form.allowDomains} onChange={(e) => set({ allowDomains: e.target.value })} />
				</label>
				<label className="flex flex-col gap-1 text-xs font-semibold">
					Never visit <span className="font-normal text-muted">One per line; covers subdomains.</span>
					<textarea className={input} rows={3} value={form.denyDomains} onChange={(e) => set({ denyDomains: e.target.value })} />
				</label>
			</div>
			{sites.length > 0 && (
				<div className="mb-3">
					<div className="text-xs font-semibold mb-1">Your decisions</div>
					<ul className="flex flex-wrap gap-1.5">
						{sites.map((c) => (
							<li key={c.domain} className="text-xs border border-line rounded px-1.5 py-0.5 flex gap-1 items-center">
								<span className={c.decision === "allow" ? "text-success" : "text-danger"}>{c.decision === "allow" ? "✓" : "✕"}</span> {c.domain}
								<button type="button" className="text-muted-soft hover:text-ink" aria-label={`Forget ${c.domain}`} onClick={() => decide({ scope: "navigate", domain: c.domain, decision: null })}>
									×
								</button>
							</li>
						))}
					</ul>
				</div>
			)}

			<fieldset className="mb-3">
				<legend className="text-xs font-semibold mb-1">Limits <span className="font-normal text-muted">Empty = the agent's default; never above its ceiling.</span></legend>
				<div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
					{LIMITS.map(([key, label]) => (
						<label key={key} className="flex flex-col gap-1 text-xs">
							{label}
							<input className={input} type="number" min={1} max={cap.limits[key]} placeholder={String(cap.limits[key])} value={form[key]} onChange={(e) => set({ [key]: e.target.value })} />
						</label>
					))}
				</div>
			</fieldset>

			<div className="grid sm:grid-cols-2 gap-3 mb-3">
				<label className="flex flex-col gap-1 text-xs font-semibold">
					Results collection <span className="font-normal text-muted">Where findings you save are stored{cap.collection ? ` (agent default: ${cap.collection.name})` : ""}.</span>
					<input className={input} value={form.collection} placeholder={cap.collection?.name ?? "job_leads"} onChange={(e) => set({ collection: e.target.value })} />
				</label>
				<label className="flex flex-col gap-1 text-xs font-semibold">
					Duplicate key <span className="font-normal text-muted">The field that makes two findings the same. Default: url.</span>
					<input className={input} value={form.keyField} placeholder="url" onChange={(e) => set({ keyField: e.target.value })} />
				</label>
			</div>

			<div className="flex gap-2 items-center flex-wrap">
				<Button variant="primary" disabled={saving} onClick={save}>
					{saving ? "Saving…" : "Save research settings"}
				</Button>
				{msg && <span className={`text-xs ${msg === "Saved." ? "text-success" : "text-danger"}`}>{msg}</span>}
			</div>
		</Card>
	);
}
