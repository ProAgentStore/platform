import type { SettingsForm } from "../../lib/localBrowser";
import type { LocalBrowserConsentEntry } from "../../lib/types";
import type { WebsiteAccessSettings } from "../../lib/websiteAccess";

const input = "bg-paper border border-line rounded px-2 py-1.5 text-sm";

export default function LocalBrowserWebsiteFields({ websiteAccess, allowDomains, form, sites, set, decide }: {
	websiteAccess?: WebsiteAccessSettings | null;
	allowDomains: string[];
	form: Pick<SettingsForm, "allowDomains" | "denyDomains">;
	sites: LocalBrowserConsentEntry[];
	set: (patch: Partial<SettingsForm>) => void;
	decide: (body: Record<string, unknown>) => void;
}) {
	if (websiteAccess) return <p className="text-sm text-muted mb-3">Website access is managed in Browser settings.</p>;
	return <>
			<div className="grid sm:grid-cols-2 gap-3 mb-3">
				<label className="flex flex-col gap-1 text-xs font-semibold">
					Allowed sites <span className="font-normal text-muted">One per line. Empty = any public site, each asked about first{allowDomains.length ? `. This agent allows: ${allowDomains.join(", ")}` : ""}.</span>
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
	</>;
}
