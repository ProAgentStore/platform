import type { ReactNode } from "react";
import WebsiteAccessFields from "./WebsiteAccessFields";
import { BROWSER_FIELDS, BROWSER_SETTING_SOURCE_LABELS, browserSettingLabel, type BrowserSettings, type BrowserSettingsView } from "../lib/browserSettings";

export default function BrowserSettingsFields({ value, inherited, effective, sources, disabled, compact, onChange }: {
	value: BrowserSettings;
	inherited?: BrowserSettings;
	effective?: BrowserSettings;
	sources?: BrowserSettingsView["sources"];
	disabled?: boolean;
	compact?: boolean;
	onChange: (patch: Partial<BrowserSettings>) => void;
}) {
	return <div className="flex flex-col gap-3">
		{BROWSER_FIELDS.map((field) => <div key={field.key}>
			<label className="flex flex-col gap-1 text-sm font-semibold">
				{field.label}
				<select className="bg-paper border border-line rounded px-2 py-1 text-sm font-normal w-full sm:max-w-sm" value={value[field.key] ?? ""} disabled={disabled} onChange={(e) => onChange({ [field.key]: e.target.value || null })}>
					<option value="">{inherited ? `Use agent default (${browserSettingLabel(field.key, inherited[field.key])})` : field.key === "profile" ? "Use workflow default" : "Use runner default"}</option>
					{field.options.map(([option, label]) => <option key={option} value={option}>{label}</option>)}
				</select>
			</label>
			{effective && sources && <p className="text-xs mt-1" data-testid={`browser-effective-${field.key}`}>Effective setting: {browserSettingLabel(field.key, effective[field.key])} ({field.key === "profile" && sources.profile === "runner" ? "chosen by workflow" : BROWSER_SETTING_SOURCE_LABELS[sources[field.key]]}).</p>}
		</div>)}
		<WebsiteAccessFields value={value.websiteAccess} inherited={inherited ? inherited.websiteAccess ?? null : undefined} effective={effective?.websiteAccess} source={sources?.websiteAccess} disabled={disabled} compact={compact} onChange={(websiteAccess) => onChange({ websiteAccess })} />
	</div>;
}

/** `collapsed` (the instance page, #1593) puts the paragraphs behind one keyboard-operable disclosure; the agent page shows them. */
export function BrowserSettingsHelp({ collapsed, children }: { collapsed?: boolean; children?: ReactNode }) {
	if (collapsed) return <details className="text-xs text-muted mt-3" data-testid="browser-settings-help">
		<summary className="cursor-pointer font-semibold min-h-6 inline-flex items-center">How browser settings work</summary>
		<BrowserSettingsHelp>{children}</BrowserSettingsHelp>
	</details>;
	return <div className="text-xs text-muted mt-3 space-y-2">
		<p>Chrome and Edge use the browser installed on the runner machine. Playwright browsers need their matching browser download. Playwright WebKit is not the Safari application. An explicit choice never silently switches to another browser.</p>
		<p>Persistent profiles belong to this agent instance and browser, separate from your personal browser profile, and remember logins. Ephemeral profiles start fresh for each run and discard their session when it ends.</p>
		<p>Choosing a browser uses a clean, dedicated profile. You may need to sign in again; your previous profile is kept. With no profile choice, the workflow chooses its usual policy.</p>
		<p>Visible mode needs a desktop session on the runner machine. Screenshot replay works in either mode.</p>
		{children}
	</div>;
}
