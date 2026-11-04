import { useEffect, useState } from "react";
import { parseWebsiteDomains, WEBSITE_ACCESS_LABELS, websiteAccessLabel, type WebsiteAccessSettings, type WebsiteAccessMode } from "../lib/websiteAccess";
import type { BrowserSettingSource } from "../lib/browserSettings";
import Button from "./Button";

export default function WebsiteAccessFields({ value, inherited, effective, source, disabled, onChange }: {
	value: WebsiteAccessSettings | null | undefined;
	inherited?: WebsiteAccessSettings | null;
	effective?: WebsiteAccessSettings | null;
	source?: BrowserSettingSource;
	disabled?: boolean;
	onChange: (value: WebsiteAccessSettings | null) => void;
}) {
	const [domains, setDomains] = useState((value?.domains ?? []).join("\n"));
	const [error, setError] = useState("");
	useEffect(() => { setDomains((value?.domains ?? []).join("\n")); setError(""); }, [value]);
	const select = (mode: string) => {
		setError("");
		onChange(mode ? { mode: mode as WebsiteAccessMode, domains: mode === "allow_all" ? [] : value?.domains ?? inherited?.domains ?? [] } : null);
	};
	return <div className="border-t border-line pt-3 mt-1 min-w-0">
		<label className="flex flex-col gap-1 text-sm font-semibold">Website access
			<select value={value?.mode ?? ""} disabled={disabled} onChange={(event) => select(event.target.value)} className="bg-paper border border-line rounded px-2 py-1 text-sm font-normal w-full sm:max-w-sm">
				<option value="">{inherited !== undefined ? `Use agent default (${websiteAccessLabel(inherited)})` : "Use workflow default"}</option>
				{Object.entries(WEBSITE_ACCESS_LABELS).map(([mode, label]) => <option key={mode} value={mode}>{label}</option>)}
			</select>
		</label>
		{source && <p className="text-xs mt-1">Effective access: {websiteAccessLabel(effective)} ({source === "instance" ? "instance override" : source === "agent" ? "from agent" : "workflow default"}).</p>}
		{!value && effective?.domains.length ? <p className="text-xs mt-2 break-words">Always allowed websites: {effective.domains.join(", ")}</p> : null}
		<p className="text-xs text-muted mt-2">A website permission applies to its exact hostname. For example, example.com and login.example.com are separate websites.</p>
		{value?.mode === "allow_all" && <p className="text-xs text-muted mt-2">This agent can visit any website. Its other action and submission approvals still apply.</p>}
		{value?.mode === "ask_once" && <p className="text-xs text-muted mt-2">The agent pauses before visiting a new website. Your allow or deny decision is remembered for this agent until you remove it.</p>}
		{value && value.mode !== "allow_all" && <div className="mt-3 space-y-2">
			<label className="flex flex-col gap-1 text-sm">{value.mode === "allowlist" ? "Allowed websites" : "Always allowed websites (optional)"}
				<textarea value={domains} disabled={disabled} onChange={(event) => { setDomains(event.target.value); setError(""); }} rows={4} placeholder={"example.com\nlogin.example.com"} spellCheck={false} autoCapitalize="none" className="w-full bg-paper border border-line rounded px-2 py-2 text-sm" />
			</label>
			<p className="text-xs text-muted">One hostname per line, up to 100. {value.mode === "allowlist" ? "An empty list allows no websites." : "An empty list asks for each new website. Listed websites are allowed even if a previous request was denied."}</p>
			<Button variant="primary" disabled={disabled} onClick={() => { try { const parsed = parseWebsiteDomains(domains); setError(""); onChange({ mode: value.mode, domains: parsed }); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}>Save website list</Button>
			{error && <p role="alert" className="text-xs text-danger">{error}</p>}
		</div>}
	</div>;
}
