import type { ApplicationRunnerSettingsView } from "../lib/types";
import Button from "./Button";

export const FULL_BROWSER_DISCLOSURE_REVISION = "full_playwright_v1" as const;
export type ToolAccessPatch = { toolAccess: "guarded" } | { toolAccess: "full"; acknowledgeFullBrowserTools: typeof FULL_BROWSER_DISCLOSURE_REVISION };

type Props = {
	settings: Pick<ApplicationRunnerSettingsView["settings"], "toolAccess" | "toolAccessAcceptance">;
	disclosure?: ApplicationRunnerSettingsView["toolAccessDisclosure"];
	busy: boolean;
	acknowledged: boolean;
	onAcknowledge: (value: boolean) => void;
	onChange: (patch: ToolAccessPatch) => void;
};

export default function ApplicationToolAccessSettings({ settings, disclosure, busy, acknowledged, onAcknowledge, onChange }: Props) {
	const full = settings.toolAccess === "full";
	const currentDisclosure = disclosure?.revision === FULL_BROWSER_DISCLOSURE_REVISION;
	return (
		<section className="mb-4 rounded border border-line p-3" aria-label="Browser tool access">
			<h3 className="text-base font-bold">Browser tool access</h3>
			<p className="text-sm mt-1">{full ? "Full Playwright tool access is enabled." : "Guarded tools are enabled."}</p>
			<p className="text-xs text-muted mt-1">Escalation decides when the model asks for help. Tool access decides which browser capabilities it can use.</p>
			{disclosure && <div className="mt-2 text-sm">
				<p className="font-semibold">{disclosure.title}</p>
				<ul className="list-disc pl-5 mt-1 space-y-1">{disclosure.risks.map((risk) => <li key={risk}>{risk}</li>)}</ul>
			</div>}
			{full ? <>
				{settings.toolAccessAcceptance && <p className="text-xs text-muted mt-2">Acceptance recorded {settings.toolAccessAcceptance.acceptedAt} · {settings.toolAccessAcceptance.revision}</p>}
				<Button size="sm" variant="secondary" disabled={busy} onClick={() => { if (!busy) onChange({ toolAccess: "guarded" }); }}>Use guarded tools for new runs</Button>
			</> : <>
				{!currentDisclosure && <p className="text-sm text-muted mt-2">The current risk disclosure is unavailable. Reload after the platform update before enabling full tools.</p>}
				<label className="flex items-start gap-2 text-sm mt-3">
					<input type="checkbox" checked={acknowledged} disabled={busy || !currentDisclosure} onChange={(event) => onAcknowledge(event.target.checked)} />
					<span>I understand and accept these risks for this agent instance, including unintended real actions even when I ask it only to fill or inspect.</span>
				</label>
				<Button size="sm" variant="danger" disabled={busy || !acknowledged || !currentDisclosure} onClick={() => { if (!busy && acknowledged && currentDisclosure) onChange({ toolAccess: "full", acknowledgeFullBrowserTools: FULL_BROWSER_DISCLOSURE_REVISION }); }}>Accept risks and enable full tools</Button>
			</>}
			<p className="text-xs text-muted mt-2">Disabling full tools invalidates queued full-tool runs. Active runs keep their frozen access until stopped. Use Stop to request that it stop; Stop cannot undo completed actions or guarantee interruption of an action already in progress.</p>
		</section>
	);
}
