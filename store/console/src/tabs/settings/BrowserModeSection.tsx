import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@proagentstore/sdk/client";
import Card from "../../components/Card";
import LoadFailed from "../../components/LoadFailed";
import BrowserSettingsFields, { BrowserSettingsHelp } from "../../components/BrowserSettingsFields";
import WebsiteGrants from "../../components/WebsiteGrants";
import LocalBrowserWebsiteLists from "./LocalBrowserWebsiteLists";
import { useBrowserSession } from "../../components/BrowserSessionReceipt";
import HistoryLine from "../../components/HistoryLine";
import { launchDiffersFromSettings } from "../../lib/browserLaunchCompare";
import { type HistoryLineState, launchLine } from "../../lib/historyLine";
import { type CliWarning, browserCliWarning } from "../../lib/browserCliWarning";
import type { RunnerNodeRead } from "../../lib/releaseGate";
import type { Machine } from "../../lib/runnerPanel";
import type { BrowserSettings, BrowserSettingsView } from "../../lib/browserSettings";

/**
 * One Website access block (#1593): the mode, then the older site lists while no mode is set (a run reads them only then),
 * then remembered websites. `legacyLists` is for local-browser agents; screenshot-only agents never had those lists.
 */
export function BrowserModeSettings({ data, saving, message, onChange, instanceId, legacyLists, cliWarning }: { instanceId?: string; data: BrowserSettingsView; saving: boolean; message: string; onChange: (patch: Partial<BrowserSettings>) => void; legacyLists?: boolean; cliWarning?: CliWarning | null }) {
	return (
		<Card className="mb-3 sm:mb-4" data-testid="browser-mode-settings">
			<h3 className="text-base font-bold mb-1">Browser settings</h3>
			<p className="text-sm text-muted mb-3">Changes apply on the next browser launch; current tasks continue unchanged.</p>
			{cliWarning && <p className="text-xs text-warning mb-3" data-testid="browser-cli-warning">
				{cliWarning.state} · <Link to={cliWarning.href} className="inline-flex items-center min-h-6 underline">Update from Terminals</Link>
			</p>}
			<BrowserSettingsFields value={data} inherited={data.agentDefaults} effective={data.effective} sources={data.sources} disabled={saving} compact onChange={onChange} />
			{legacyLists && instanceId && !data.effective?.websiteAccess && <LocalBrowserWebsiteLists key={instanceId} instanceId={instanceId} />}
			{instanceId && <WebsiteGrants key={instanceId} instanceId={instanceId} />}
			<BrowserSettingsHelp collapsed>{data.explained && <p>{data.explained}</p>}</BrowserSettingsHelp>
			{message && <p role="status" className="text-xs mt-2">{message}</p>}
		</Card>
	);
}

/** The pinned machine's CLI against what the saved settings need; null while loading, when a read fails, or when nothing is wrong. */
function useCliWarning(instanceId: string, requiredCli: string | null | undefined): CliWarning | null {
	const [reads, setReads] = useState<{ rn: RunnerNodeRead | null; machines: Machine[] | null } | null>(null);
	useEffect(() => {
		let live = true;
		void Promise.all([
			api<RunnerNodeRead>(`/v1/instances/${instanceId}/runner-node`).catch(() => null),
			api<{ nodes: Machine[] }>("/v1/terminals/nodes").then((r) => r.nodes ?? null).catch(() => null),
		]).then(([rn, machines]) => { if (live) setReads({ rn, machines }); });
		return () => { live = false; };
	}, [instanceId]);
	return reads ? browserCliWarning(requiredCli, reads.rn, reads.machines) : null;
}

export default function BrowserModeSection({ instanceId, legacyLists }: { instanceId: string; legacyLists?: boolean }) {
	const [data, setData] = useState<BrowserSettingsView | null>(null);
	const [error, setError] = useState("");
	const [message, setMessage] = useState("");
	const [saving, setSaving] = useState(false);
	// What the runner last launched is history (Activity → History, #1590); here it only says when the saved setting differs.
	const session = useBrowserSession(instanceId);
	const load = useCallback(async () => {
		try {
			setData(await api<BrowserSettingsView>(`/v1/instances/${instanceId}/browser-settings`));
			setError("");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, [instanceId]);
	useEffect(() => { void load(); }, [load]);
	const cliWarning = useCliWarning(instanceId, data?.requiredCli);
	if (error && !data) return <LoadFailed what="browser settings" detail={error} onRetry={load} />;
	if (!data) return null;
	const launch: HistoryLineState = session.loading && !session.data ? { status: "loading" } : session.error && !session.data ? { status: "failed" } : launchLine(session.data?.status === "connected" && launchDiffersFromSettings(data.effective, session.data.launch));
	const save = async (patch: Partial<BrowserSettings>) => {
		setSaving(true);
		setMessage("");
		try {
			setData(await api<BrowserSettingsView>(`/v1/instances/${instanceId}/browser-settings`, { method: "PUT", body: JSON.stringify(patch) }));
			setMessage("Saved — applies on the next browser launch. Current tasks continue unchanged.");
		} catch (e) {
			setMessage(e instanceof Error ? e.message : String(e));
		}
		setSaving(false);
	};
	return <>
		<BrowserModeSettings instanceId={instanceId} data={data} saving={saving} message={message} legacyLists={legacyLists} cliWarning={cliWarning} onChange={(patch) => void save(patch)} />
		<div className="mb-3 sm:mb-4"><HistoryLine instanceId={instanceId} panel="browser-launch" state={launch} testId="browser-launch-line" /></div>
	</>;
}
