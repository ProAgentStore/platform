import { useState, useEffect, useCallback } from "react";
import LoadFailed from "../components/LoadFailed";
import BrainModelCard from "../components/BrainModelCard";
import CodingEngineCard from "../components/CodingEngineCard";
import RunnerPanel from "../components/RunnerPanel";
import SecureInputHistory from "../components/SecureInputHistory";
import TeamworkSection from "./TeamworkSection";
import LoopPresetsSection from "./LoopPresetsSection";
import LoopRunsSection from "./LoopRunsSection";
import TriggersSection from "./TriggersSection";
import { api } from "@proagentstore/sdk/client";
import { invalidateVoiceConfig } from "@proagentstore/sdk/hooks";
import type { SettingsField } from "../lib/types";
import type { ConnectorReach, InstanceConnectorPolicy } from "../lib/connectorState";
import type { RosterInstance } from "../lib/unsubscribeScope";
import { MY_INSTANCES_WITH_PAUSED } from "../lib/instancePause";

// Import refactored modules
import InstanceInfo from "./settings/InstanceInfo";
import AgentSettingsSection from "./settings/AgentSettingsSection";
import ConnectorsSection from "./settings/ConnectorsSection";
import VoiceTranslationSection from "./settings/VoiceTranslationSection";
import MiscellaneousSection from "./settings/MiscellaneousSection";
import LocalBrowserSection from "./settings/LocalBrowserSection";

interface Props {
	instanceId: string;
	instanceName?: string;
	isApply: boolean;
	isCoding?: boolean;
	isRepo?: boolean;
	/** A local CLI browser research agent (#946) — shows its own settings section. */
	isLocalBrowser?: boolean;
	onUnsubscribe: () => void;
}

interface ConnectorGrant {
	id: string;
	provider: "google_drive" | "zoho_workdrive";
	resourceId: string;
	resourceName: string;
	resourceType: string;
	resourceUrl?: string | null;
}

interface DriveStatus {
	connected: boolean;
	configured: boolean;
	email?: string | null;
	reach?: ConnectorReach;
}

interface WorkdriveStatus {
	connected: boolean;
	configured: boolean;
	account?: string | null;
	reach?: ConnectorReach;
}

export default function SettingsTab({ instanceId, instanceName, isApply, isCoding, isRepo, isLocalBrowser, onUnsubscribe }: Props) {
	const [maintMsg, setMaintMsg] = useState("");
	const [resyncMsg, setResyncMsg] = useState("");
	const [agentFields, setAgentFields] = useState<SettingsField[]>([]);
	const [agentSettings, setAgentSettings] = useState<Record<string, string | number | boolean>>({});
	const [settingsMsg, setSettingsMsg] = useState("");
	const [voiceSettings, setVoiceSettings] = useState<Record<string, unknown> | null>(null);
	const [voiceOverride, setVoiceOverride] = useState(false);
	const [trOverride, setTrOverride] = useState(false);
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
	const [emailStatus, setEmailStatus] = useState<{ connected: boolean; configured: boolean; email?: string | null } | null>(null);
	const [emailPermission, setEmailPermission] = useState<boolean | null>(null);
	const [emailMsg, setEmailMsg] = useState("");
	const [driveStatus, setDriveStatus] = useState<DriveStatus | null>(null);
	const [driveMsg, setDriveMsg] = useState("");
	const [driveGrantRef, setDriveGrantRef] = useState("");
	const [driveGrants, setDriveGrants] = useState<ConnectorGrant[]>([]);
	const [workdriveStatus, setWorkdriveStatus] = useState<WorkdriveStatus | null>(null);
	const [workdriveMsg, setWorkdriveMsg] = useState("");
	const [workdriveGrantRef, setWorkdriveGrantRef] = useState("");
	const [workdriveGrants, setWorkdriveGrants] = useState<ConnectorGrant[]>([]);
	const [connectorPolicy, setConnectorPolicy] = useState<InstanceConnectorPolicy[] | null>(null);
	const [loadFailures, setLoadFailures] = useState<string[]>([]);
	const [roster, setRoster] = useState<RosterInstance[] | null>(null);
	const [instStatus, setInstStatus] = useState<string | null>(null);

	const loadAll = useCallback(() => {
		(async () => {
			const failed: string[] = [];
			try {
				const d = await api<{ instances?: RosterInstance[] }>(MY_INSTANCES_WITH_PAUSED);
				const mine = (d.instances || []).find((i) => i.id === instanceId);
				if (mine?.name) setInstName(mine.name);
				setRoster(d.instances || []);
				setInstStatus(mine?.status ?? null);
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
				const s = await api<{ connected: boolean; configured: boolean; email?: string | null }>("/v1/email/status");
				setEmailStatus(s);
			} catch {
				failed.push("the email connection");
			}
			try {
				const s = await api<DriveStatus>("/v1/drive/status");
				setDriveStatus(s);
			} catch {
				failed.push("the Drive connection");
			}
			try {
				const d = await api<{ grants?: ConnectorGrant[] }>(`/v1/drive/instances/${instanceId}/grants`);
				setDriveGrants(d.grants || []);
			} catch {
				failed.push("your Drive folders");
			}
			try {
				const s = await api<WorkdriveStatus>("/v1/workdrive/status");
				setWorkdriveStatus(s);
			} catch {
				failed.push("the WorkDrive connection");
			}
			try {
				const d = await api<{ grants?: ConnectorGrant[] }>(`/v1/workdrive/instances/${instanceId}/grants`);
				setWorkdriveGrants(d.grants || []);
			} catch {
				failed.push("your WorkDrive folders");
			}
			try {
				const p = await api<{ connectors?: InstanceConnectorPolicy[] }>(`/v1/instances/${instanceId}/connectors`);
				setConnectorPolicy(p.connectors || []);
			} catch {
				failed.push("connector policy");
			}
			try {
				const st = await api<{ permissions?: { email?: boolean } }>(`/v1/instances/${instanceId}/state`);
				setEmailPermission(st.permissions?.email === true);
			} catch {
				failed.push("agent permissions");
			}
			setLoadFailures(failed);
		})();
	}, [instanceId]);

	useEffect(() => {
		loadAll();
	}, [loadAll]);

	useEffect(() => {
		const onFocus = () => {
			api<{ connected: boolean; configured: boolean; email?: string | null }>("/v1/email/status").then(setEmailStatus).catch(() => {});
			api<DriveStatus>("/v1/drive/status").then(setDriveStatus).catch(() => {});
			api<WorkdriveStatus>("/v1/workdrive/status").then(setWorkdriveStatus).catch(() => {});
		};
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, []);

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
		if (d?.translation) {
			setTrEnabled(d.translation.enabled === true);
			setTrTarget(d.translation.target || "English");
			setTrTranslit(d.translation.transliterate === true);
			setTrWordTap(d.translation.wordTap !== false);
			setTrFontSize(d.translation.fontSize || "medium");
		}
	};

	const refreshDriveReach = () => {
		api<DriveStatus>("/v1/drive/status").then(setDriveStatus).catch(() => {});
	};

	const refreshWorkdriveReach = () => {
		api<WorkdriveStatus>("/v1/workdrive/status").then(setWorkdriveStatus).catch(() => {});
	};

	const addDriveGrant = async () => {
		if (!driveGrantRef.trim()) return;
		try {
			const d = await api<{ grant: ConnectorGrant }>(`/v1/drive/instances/${instanceId}/grants`, {
				method: "POST",
				body: JSON.stringify({ url: driveGrantRef.trim() }),
			});
			setDriveGrants((grants) => [d.grant, ...grants.filter((g) => g.id !== d.grant.id && g.resourceId !== d.grant.resourceId)]);
			setDriveGrantRef("");
			setDriveMsg(`Granted this agent access to ${d.grant.resourceName}.`);
			refreshDriveReach();
		} catch (e) {
			setDriveMsg(e instanceof Error ? e.message : "Failed to grant Drive folder");
		}
	};

	const removeDriveGrant = async (grant: ConnectorGrant) => {
		try {
			await api(`/v1/drive/instances/${instanceId}/grants/${grant.id}`, { method: "DELETE" });
			setDriveGrants((grants) => grants.filter((g) => g.id !== grant.id));
			setDriveMsg(`Removed access to ${grant.resourceName}.`);
			refreshDriveReach();
		} catch (e) {
			setDriveMsg(e instanceof Error ? e.message : "Failed to remove Drive access");
		}
	};

	const addWorkdriveGrant = async () => {
		if (!workdriveGrantRef.trim()) return;
		try {
			const d = await api<{ grant: ConnectorGrant }>(`/v1/workdrive/instances/${instanceId}/grants`, {
				method: "POST",
				body: JSON.stringify({ url: workdriveGrantRef.trim() }),
			});
			setWorkdriveGrants((grants) => [d.grant, ...grants.filter((g) => g.id !== d.grant.id && g.resourceId !== d.grant.resourceId)]);
			setWorkdriveGrantRef("");
			setWorkdriveMsg(`Granted this agent access to ${d.grant.resourceName}.`);
			refreshWorkdriveReach();
		} catch (e) {
			setWorkdriveMsg(e instanceof Error ? e.message : "Failed to grant WorkDrive folder");
		}
	};

	const removeWorkdriveGrant = async (grant: ConnectorGrant) => {
		try {
			await api(`/v1/workdrive/instances/${instanceId}/grants/${grant.id}`, { method: "DELETE" });
			setWorkdriveGrants((grants) => grants.filter((g) => g.id !== grant.id));
			setWorkdriveMsg(`Removed access to ${grant.resourceName}.`);
			refreshWorkdriveReach();
		} catch (e) {
			setWorkdriveMsg(e instanceof Error ? e.message : "Failed to remove WorkDrive access");
		}
	};

	const toggleEmailPermission = async (on: boolean) => {
		setEmailPermission(on);
		try {
			await api(`/v1/instances/${instanceId}/state`, { method: "PUT", body: JSON.stringify({ permissions: { email: on } }) });
			setEmailMsg(on ? "This agent can now reach your Gmail. What it may do with it is the tool list above." : "Gmail access turned off for this agent.");
		} catch (e) {
			setEmailPermission(!on);
			setEmailMsg(e instanceof Error ? e.message : "Failed");
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

	return (
		<div className="min-w-0 overflow-x-hidden">
			{loadFailures.length > 0 && (
				<div className="mb-3">
					<LoadFailed
						what={`${loadFailures.join(", ")} — the controls below may show defaults instead of your settings`}
						onRetry={loadAll}
						testId="settings-load-failed"
						compact
					/>
				</div>
			)}

			<InstanceInfo
				instanceId={instanceId}
				instName={instName}
				instNameMsg={instNameMsg}
				isRepo={isRepo}
				onInstNameChange={setInstName}
				onSaveInstName={saveInstName}
			/>

			<AgentSettingsSection
				agentFields={agentFields}
				agentSettings={agentSettings}
				settingsMsg={settingsMsg}
				onSettingChange={(id, value) => setAgentSettings((s) => ({ ...s, [id]: value }))}
				onSaveSetting={saveSetting}
			/>

			<BrainModelCard instanceId={instanceId} />
			{isCoding && <CodingEngineCard instanceId={instanceId} />}
			{isLocalBrowser && <LocalBrowserSection instanceId={instanceId} />}

			<RunnerPanel instanceId={instanceId} />
			<SecureInputHistory instanceId={instanceId} />

			<ConnectorsSection
				instanceId={instanceId}
				emailStatus={emailStatus}
				emailPermission={emailPermission}
				emailMsg={emailMsg}
				driveStatus={driveStatus}
				driveMsg={driveMsg}
				driveGrantRef={driveGrantRef}
				driveGrants={driveGrants}
				workdriveStatus={workdriveStatus}
				workdriveMsg={workdriveMsg}
				workdriveGrantRef={workdriveGrantRef}
				workdriveGrants={workdriveGrants}
				connectorPolicy={connectorPolicy}
				onEmailPermissionChange={toggleEmailPermission}
				onDriveGrantRefChange={setDriveGrantRef}
				onAddDriveGrant={addDriveGrant}
				onRemoveDriveGrant={removeDriveGrant}
				onWorkdriveGrantRefChange={setWorkdriveGrantRef}
				onAddWorkdriveGrant={addWorkdriveGrant}
				onRemoveWorkdriveGrant={removeWorkdriveGrant}
			/>

			<TeamworkSection instanceId={instanceId} />
			<LoopPresetsSection instanceId={instanceId} />
			<LoopRunsSection instanceId={instanceId} />
			<TriggersSection instanceId={instanceId} driveGrants={driveGrants} workdriveGrants={workdriveGrants} />

			<VoiceTranslationSection
				voiceSettings={voiceSettings}
				voiceOverride={voiceOverride}
				hasOpenAiKey={hasOpenAiKey}
				trLoaded={trLoaded}
				trOverride={trOverride}
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
				onSetVoiceOverride={setVoiceOverride}
				onSetTrOverride={setTrOverride}
			/>

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
				onClearFinished={clearFinished}
				onResyncIdentity={resyncIdentity}
				onUnsubscribe={onUnsubscribe}
			/>
		</div>
	);
}
