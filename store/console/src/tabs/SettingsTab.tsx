import { useState, useEffect, useCallback, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import LoadFailed from "../components/LoadFailed";
import BrainModelCard from "../components/BrainModelCard";
import PilotModelCard from "../components/PilotModelCard";
import CodingEngineCard from "../components/CodingEngineCard";
import RunnerPanel from "../components/RunnerPanel";
import ActionsRunnerCard from "../components/ActionsRunnerCard";
import TeamworkSection from "./TeamworkSection";
import LoopPresetsSection from "./LoopPresetsSection";
import LoopRunsLine from "./settings/LoopRunsLine";
import TriggersSection, { type ConnectorGrant } from "./TriggersSection";
import { api } from "@proagentstore/sdk/client";
import { invalidateVoiceConfig } from "@proagentstore/sdk/hooks";
import type { SettingsField } from "../lib/types";
import type { RosterInstance } from "../lib/unsubscribeScope";
import { type DisabledRecord, MY_INSTANCES_WITH_PAUSED } from "../lib/instancePause";
import {
	searchWithSettingsSubtab,
	SETTINGS_SUBTAB_LABELS,
	settingsSubtabFromSearch,
	visibleSettingsSubtabs,
	type SettingsSubtab,
	type SettingsSubtabCaps,
} from "../lib/settingsSubtab";

// Import refactored modules
import InstanceInfo from "./settings/InstanceInfo";
import AgentSettingsSection from "./settings/AgentSettingsSection";
import VoiceTranslationSection from "./settings/VoiceTranslationSection";
import MiscellaneousSection from "./settings/MiscellaneousSection";
import NotificationPolicySection from "./settings/NotificationPolicySection";
import LocalBrowserSection from "./settings/LocalBrowserSection";
import BrowserVerificationSection from "./settings/BrowserVerificationSection";
import BrowserScreenshotsSection from "./settings/BrowserScreenshotsSection";
import BrowserModeSection from "./settings/BrowserModeSection";
import GmailScoutSection from "./settings/GmailScoutSection";
import CoderBrainSection from "./settings/CoderBrainSection";
import AutoPickupSection from "./settings/AutoPickupSection";
import OperatorManualCard from "../components/OperatorManualCard";
import ConnectionGuide from "../components/ConnectionGuide";

interface Props {
	instanceId: string;
	instanceName?: string;
	isApply: boolean;
	isCoding?: boolean;
	isRepo?: boolean;
	/** A local CLI browser research agent (#946) — shows its own settings section. */
	isLocalBrowser?: boolean;
	/** Dedicated inbox Scout: its Gmail source is configured here, not through generic mail tools. */
	isGmailScout?: boolean;
	/** The agent runs a browser, so the screenshot switch applies (#1064). */
	takesScreenshots?: boolean;
	/** What decides which sub-tabs show (`lib/settingsSubtab.ts`): the same caps surfaces.tsx derives the booleans above from. */
	caps: SettingsSubtabCaps;
	onUnsubscribe: () => void;
}

export default function SettingsTab({ instanceId, instanceName, isApply, isCoding, isRepo, isLocalBrowser, isGmailScout, takesScreenshots, caps, onUnsubscribe }: Props) {
	const [searchParams, setSearchParams] = useSearchParams();
	const subtabs = visibleSettingsSubtabs(caps);
	const active = settingsSubtabFromSearch(searchParams, caps);
	// A sub-tab mounts on first visit and stays mounted (hidden) after, so its drafts and fetches survive switching (#1589).
	const [visited, setVisited] = useState<ReadonlySet<SettingsSubtab>>(() => new Set([active]));
	if (!visited.has(active)) setVisited(new Set([...visited, active]));
	const selectSubtab = (id: SettingsSubtab) => setSearchParams(searchWithSettingsSubtab(searchParams, id));
	const [maintMsg, setMaintMsg] = useState("");
	const [resyncMsg, setResyncMsg] = useState("");
	const [agentFields, setAgentFields] = useState<SettingsField[]>([]);
	const [agentSettings, setAgentSettings] = useState<Record<string, string | number | boolean>>({});
	const [settingsMsg, setSettingsMsg] = useState("");
	const [voiceSettings, setVoiceSettings] = useState<Record<string, unknown> | null>(null);
	const [voiceOverride, setVoiceOverride] = useState(false);
	const [trOverride, setTrOverride] = useState(false);
	// Local "Override for this agent" reveal, separate from the server's hasOverride: nothing is written until the first field change (#1599).
	const [voiceRevealed, setVoiceRevealed] = useState(false);
	const [trRevealed, setTrRevealed] = useState(false);
	const [trLoaded, setTrLoaded] = useState(false);
	const [hasOpenAiKey, setHasOpenAiKey] = useState<boolean | null>(null);
	const [instName, setInstName] = useState("");
	const [instNameMsg, setInstNameMsg] = useState("");
	const [trEnabled, setTrEnabled] = useState(false);
	const [trTarget, setTrTarget] = useState("English");
	const [trTranslit, setTrTranslit] = useState(false);
	const [trWordTap, setTrWordTap] = useState(true);
	const [trFontSize, setTrFontSize] = useState("medium");
	const [trLanguages, setTrLanguages] = useState<Array<{ name: string; tag: string }>>([]);
	const [driveGrants, setDriveGrants] = useState<ConnectorGrant[]>([]);
	const [workdriveGrants, setWorkdriveGrants] = useState<ConnectorGrant[]>([]);
	const [loadFailures, setLoadFailures] = useState<string[]>([]);
	const [roster, setRoster] = useState<RosterInstance[] | null>(null);
	const [instStatus, setInstStatus] = useState<string | null>(null);
	const [instDisabled, setInstDisabled] = useState<DisabledRecord | null>(null);

	const loadAll = useCallback(() => {
		(async () => {
			const failed: string[] = [];
			try {
				const d = await api<{ instances?: RosterInstance[] }>(MY_INSTANCES_WITH_PAUSED);
				const mine = (d.instances || []).find((i) => i.id === instanceId);
				if (mine?.name) setInstName(mine.name);
				setRoster(d.instances || []);
				setInstStatus(mine?.status ?? null);
				setInstDisabled(mine?.disabled ?? null);
			} catch {
				failed.push("your instance name");
			}
			try {
				const d = await api<{ settings?: Record<string, string | number | boolean>; fields?: SettingsField[] }>(`/v1/instances/${instanceId}/settings`);
				setAgentSettings(d.settings || {});
				if (d.fields?.length) setAgentFields(d.fields);
			} catch {
				failed.push("agent settings");
			}
			try {
				const d = await api<{
					translation?: { enabled: boolean; target: string; transliterate?: boolean; wordTap?: boolean; fontSize?: string };
					languages?: Array<{ name: string; tag: string }>;
					hasOverride?: boolean;
				}>(`/v1/instances/${instanceId}/translation`);
				setTrEnabled(d.translation?.enabled === true);
				setTrTarget(d.translation?.target || "English");
				setTrTranslit(d.translation?.transliterate === true);
				setTrWordTap(d.translation?.wordTap !== false);
				setTrFontSize(d.translation?.fontSize || "medium");
				setTrLanguages(d.languages || []);
				setTrOverride(d.hasOverride === true);
				setTrLoaded(true);
			} catch {
				failed.push("translation settings");
			}
			try {
				const d = await api<{ voiceSettings?: Record<string, unknown>; hasOverride?: boolean }>(`/v1/instances/${instanceId}/voice-settings`);
				const vs = d.voiceSettings || {};
				setVoiceSettings(vs);
				setVoiceOverride(d.hasOverride === true);
			} catch {
				failed.push("voice settings");
			}
			try {
				const k = await api<{ providers?: Array<{ id: string; hasKey: boolean }> }>("/v1/keys/status");
				setHasOpenAiKey(!!k.providers?.find((p) => p.id === "openai")?.hasKey);
			} catch {
				setHasOpenAiKey(false);
			}
			try {
				const d = await api<{ grants?: ConnectorGrant[] }>(`/v1/drive/instances/${instanceId}/grants`);
				setDriveGrants(d.grants || []);
			} catch {
				failed.push("your Drive folders");
			}
			try {
				const d = await api<{ grants?: ConnectorGrant[] }>(`/v1/workdrive/instances/${instanceId}/grants`);
				setWorkdriveGrants(d.grants || []);
			} catch {
				failed.push("your WorkDrive folders");
			}
			setLoadFailures(failed);
		})();
	}, [instanceId]);

	useEffect(() => {
		loadAll();
	}, [loadAll]);

	const saveSetting = async (id: string, value: string | number | boolean) => {
		setAgentSettings((s) => ({ ...s, [id]: value }));
		try {
			const d = await api<{ settings?: Record<string, string | number | boolean> }>(`/v1/instances/${instanceId}/settings`, {
				method: "PUT",
				body: JSON.stringify({ settings: { [id]: value } }),
			});
			if (d.settings) setAgentSettings(d.settings);
			const field = agentFields.find((f) => f.id === id);
			if (field?.voiceLanguage && typeof value === "string") {
				api<{ voiceSettings?: Record<string, unknown> }>(`/v1/instances/${instanceId}/voice-settings`)
					.then((d) => d.voiceSettings && setVoiceSettings(d.voiceSettings))
					.catch(() => undefined);
			}
			setSettingsMsg("Saved — applies on your next turn");
			setTimeout(() => setSettingsMsg(""), 2500);
		} catch (e) {
			setSettingsMsg(e instanceof Error ? e.message : "Failed");
		}
	};

	const saveVoice = async (patch: Record<string, unknown>) => {
		const next = { ...(voiceSettings || {}), ...patch };
		setVoiceSettings(next);
		const d = await api<{ voiceSettings?: Record<string, unknown> }>(`/v1/instances/${instanceId}/voice-settings`, {
			method: "PUT",
			body: JSON.stringify(next),
		});
		setVoiceOverride(true);
		if (d.voiceSettings) setVoiceSettings(d.voiceSettings);
		invalidateVoiceConfig();
	};

	const clearVoiceOverride = async () => {
		const d = await api<{ voiceSettings?: Record<string, unknown> }>(`/v1/instances/${instanceId}/voice-settings`, { method: "DELETE" });
		setVoiceOverride(false);
		setVoiceRevealed(false);
		if (d?.voiceSettings) setVoiceSettings(d.voiceSettings);
		invalidateVoiceConfig();
	};

	const saveTranslationOverride = async (next: { enabled: boolean; target: string; transliterate: boolean; wordTap: boolean; fontSize: string }) => {
		setTrEnabled(next.enabled);
		setTrTarget(next.target);
		setTrTranslit(next.transliterate);
		setTrWordTap(next.wordTap);
		setTrFontSize(next.fontSize);
		await api(`/v1/instances/${instanceId}/translation`, { method: "PUT", body: JSON.stringify(next) });
		setTrOverride(true);
	};

	const clearTrOverride = async () => {
		const d = await api<{ translation?: { enabled: boolean; target: string; transliterate?: boolean; wordTap?: boolean; fontSize?: string } }>(
			`/v1/instances/${instanceId}/translation`,
			{ method: "DELETE" },
		);
		setTrOverride(false);
		setTrRevealed(false);
		if (d?.translation) {
			setTrEnabled(d.translation.enabled === true);
			setTrTarget(d.translation.target || "English");
			setTrTranslit(d.translation.transliterate === true);
			setTrWordTap(d.translation.wordTap !== false);
			setTrFontSize(d.translation.fontSize || "medium");
		}
	};

	const clearFinished = async () => {
		try {
			await api(`/v1/instances/${instanceId}/tasks/clear-finished`, { method: "POST" });
			setMaintMsg("Cleared finished tasks");
			setTimeout(() => setMaintMsg(""), 3000);
		} catch (e) {
			setMaintMsg(e instanceof Error ? e.message : "Failed");
		}
	};

	const resyncIdentity = async () => {
		setResyncMsg("Syncing…");
		try {
			type ResyncResult = { personality?: string; changed?: boolean };
			const d = await api<ResyncResult>(`/v1/instances/${instanceId}/resync-identity`, { method: "POST" });
			setResyncMsg(d.changed ? "Updated — the agent's personality is now in sync with its template." : "Already in sync — nothing changed.");
			setTimeout(() => setResyncMsg(""), 4000);
		} catch (e) {
			setResyncMsg(e instanceof Error ? e.message : "Failed");
		}
	};

	const saveInstName = async () => {
		try {
			await api(`/v1/instances/${instanceId}/name`, { method: "PUT", body: JSON.stringify({ name: instName }) });
			setInstNameMsg("Saved — updating…");
			setTimeout(() => window.location.reload(), 600);
		} catch (e) {
			setInstNameMsg(e instanceof Error ? e.message : "Failed");
		}
	};

	const panels: Record<SettingsSubtab, ReactNode> = {
		agent: (
			<>
				<Section id="agent-settings">
					<AgentSettingsSection
						agentFields={agentFields}
						agentSettings={agentSettings}
						settingsMsg={settingsMsg}
						onSettingChange={(id, value) => setAgentSettings((s) => ({ ...s, [id]: value }))}
						onSaveSetting={saveSetting}
					/>
				</Section>

				{/* #1592: what this agent does comes first (its source, then its research); the generic model choice after. */}
				{isGmailScout && <Section id="gmail-scout"><GmailScoutSection instanceId={instanceId} /></Section>}
				{isLocalBrowser && <Section id="local-browser"><LocalBrowserSection instanceId={instanceId} /></Section>}

				{/* #1043: the Brain (advisory, may use an API key) and the Coding engine (the subscription CLI that
				    writes code, #1042) are two different things, set in two separate sections. */}
				<section aria-labelledby="settings-brain-heading" data-testid="settings-brain-section">
					<h2 id="settings-brain-heading" className="text-lg font-semibold mb-2">Brain — advises and orchestrates</h2>
					<BrainModelCard instanceId={instanceId} />
					{isCoding && <CoderBrainSection instanceId={instanceId} />}
					{isCoding && <AutoPickupSection instanceId={instanceId} />}
				</section>
				{isCoding && <Section id="pilot-model"><PilotModelCard instanceId={instanceId} /></Section>}
				{isCoding && (
					<section aria-labelledby="settings-coding-heading" data-testid="settings-coding-section" className="border-t border-line pt-4 mt-2">
						<h2 id="settings-coding-heading" className="text-lg font-semibold mb-2">Coding — edits, tests and deploys</h2>
						<CodingEngineCard instanceId={instanceId} />
					</section>
				)}
			</>
		),
		browser: (
			<>
				{isLocalBrowser && <Section id="browser-verification"><BrowserVerificationSection instanceId={instanceId} /></Section>}
				{takesScreenshots && <Section id="browser-screenshots"><BrowserScreenshotsSection instanceId={instanceId} /></Section>}
				{takesScreenshots && <Section id="browser-mode"><BrowserModeSection instanceId={instanceId} legacyLists={isLocalBrowser} /></Section>}
			</>
		),
		automation: (
			<>
				<Section id="runner"><RunnerPanel instanceId={instanceId} /></Section>
				{isCoding && <Section id="actions-runner"><ActionsRunnerCard instanceId={instanceId} /></Section>}
				<Section id="teamwork"><TeamworkSection instanceId={instanceId} /></Section>
				<Section id="loop-presets"><LoopPresetsSection instanceId={instanceId} /></Section>
				<Section id="loop-runs"><LoopRunsLine instanceId={instanceId} /></Section>
				<Section id="triggers"><TriggersSection instanceId={instanceId} driveGrants={driveGrants} workdriveGrants={workdriveGrants} /></Section>
			</>
		),
		// What this agent may tell the owner, and where (#992) — every agent has notifications,
		// so this is ungated, like Behaviour.
		notifications: <Section id="notification-policy"><NotificationPolicySection instanceId={instanceId} /></Section>,
		instructions: (
			<>
				{/* Operator manual — the template's, inherited, above this instance's own (#1237) */}
				<Section id="operator-manual"><OperatorManualCard instanceId={instanceId} /></Section>
				<Section id="connection-guide">
					<div className="mb-3 sm:mb-4">
						<ConnectionGuide instanceId={instanceId} />
					</div>
				</Section>
			</>
		),
		general: (
			<>
				<Section id="instance-info">
					<InstanceInfo
						instanceId={instanceId}
						instName={instName}
						instNameMsg={instNameMsg}
						isRepo={isRepo}
						onInstNameChange={setInstName}
						onSaveInstName={saveInstName}
					/>
				</Section>
				<MiscellaneousSection
					instanceId={instanceId}
					instanceName={instanceName}
					isApply={isApply}
					isCoding={isCoding}
					isRepo={isRepo}
					roster={roster}
					maintMsg={maintMsg}
					resyncMsg={resyncMsg}
					instStatus={instStatus}
					instDisabled={instDisabled}
					onClearFinished={clearFinished}
					onResyncIdentity={resyncIdentity}
					onUnsubscribe={onUnsubscribe}
				>
					<Section id="voice-translation">
						<VoiceTranslationSection
							voiceSettings={voiceSettings}
							voiceLoad={voiceSettings !== null ? "loaded" : loadFailures.includes("voice settings") ? "failed" : "loading"}
							voiceOverride={voiceOverride}
							voiceRevealed={voiceRevealed}
							hasOpenAiKey={hasOpenAiKey}
							trLoad={trLoaded ? "loaded" : loadFailures.includes("translation settings") ? "failed" : "loading"}
							trOverride={trOverride}
							trRevealed={trRevealed}
							trEnabled={trEnabled}
							trTarget={trTarget}
							trTranslit={trTranslit}
							trWordTap={trWordTap}
							trFontSize={trFontSize}
							trLanguages={trLanguages}
							onSaveVoice={saveVoice}
							onClearVoiceOverride={clearVoiceOverride}
							onSaveTranslationOverride={saveTranslationOverride}
							onClearTrOverride={clearTrOverride}
							onSetVoiceRevealed={setVoiceRevealed}
							onSetTrRevealed={setTrRevealed}
						/>
					</Section>
				</MiscellaneousSection>
			</>
		),
	};

	return (
		<div className="min-w-0 overflow-x-hidden">
			{loadFailures.length > 0 && (
				<div className="mb-3">
					<LoadFailed
						what={`${loadFailures.join(", ")} — some settings may show defaults instead of yours`}
						onRetry={loadAll}
						testId="settings-load-failed"
						compact
					/>
				</div>
			)}

			{/* Plain buttons in a scrolling row, as Knowledge's bar — not a <nav>: the shell allows no second primary navbar. */}
			<div className="flex gap-0 border-b border-line mb-4 overflow-x-auto" data-testid="settings-subtabs">
				{subtabs.map((id) => (
					<button
						key={id}
						type="button"
						onClick={() => selectSubtab(id)}
						aria-current={active === id ? "true" : undefined}
						data-testid={`settings-subtab-${id}`}
						className={`min-h-6 min-w-6 px-3 py-2 text-sm font-bold border-b-2 whitespace-nowrap transition-all ${
							active === id ? "text-accent border-accent" : "text-muted border-transparent hover:text-ink"
						}`}
					>
						{SETTINGS_SUBTAB_LABELS[id]}
					</button>
				))}
			</div>

			{subtabs.map((id) => (
				<div key={id} hidden={active !== id} data-testid={`settings-panel-${id}`}>
					{visited.has(id) && panels[id]}
				</div>
			))}
		</div>
	);
}

/** Marks one section so a test can say which sub-tab it lives in. */
function Section({ id, children }: { id: string; children: ReactNode }) {
	return <div data-testid={`settings-section-${id}`}>{children}</div>;
}
