import { useState, useEffect, useCallback } from "react";
import PrefOverride from "../components/PrefOverride";
import LoadFailed from "../components/LoadFailed";
import VoiceFields from "../components/VoiceFields";
import TranslationFields from "../components/TranslationFields";
import { api } from "@proagentstore/sdk/client";
import { invalidateVoiceConfig } from "@proagentstore/sdk/hooks";
import type { SettingsField } from "../lib/types";
import TeamworkSection from "./TeamworkSection";
import LoopPresetsSection from "./LoopPresetsSection";
import LoopRunsSection from "./LoopRunsSection";
import TriggersSection from "./TriggersSection";
import RunnerPanel from "../components/RunnerPanel";
import ToolPermissions from "../components/ToolPermissions";
import { showsConnector, showsFileConnector, type ConnectorReach, type InstanceConnectorPolicy } from "../lib/connectorState";
import { voiceSummary } from "../lib/voiceSummary";
import { FileConnectorPanel } from "../components/FileConnectorPanel";
import Button from "../components/Button";
import Card from "../components/Card";

interface Props {
	instanceId: string;
	isApply: boolean;
	/** True when the agent declares the `coding` surface — adds a repo pointer to "Where things live". */
	isCoding?: boolean;
	/** True when the agent declares the `repo` surface — adds a repo pointer to "Where things live". */
	isRepo?: boolean;
	/** The agent's declared subscriber settings (from capabilities). */
	settingsSchema?: SettingsField[];
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

export default function SettingsTab({ instanceId, isApply, isCoding, isRepo, settingsSchema, onUnsubscribe }: Props) {
	const [maintMsg, setMaintMsg] = useState("");
	// Agent-declared settings: the schema prop is the fast path; the GET also returns
	// `fields` so the form never depends on a stale instance-list cache.
	const [agentFields, setAgentFields] = useState<SettingsField[]>(settingsSchema ?? []);
	const [agentSettings, setAgentSettings] = useState<Record<string, string | number | boolean>>({});
	const [settingsMsg, setSettingsMsg] = useState("");
	const [voiceSettings, setVoiceSettings] = useState<Record<string, unknown> | null>(null);
	// PRESENCE of a per-agent override (#211), not "do the values differ" — an override that
	// happens to match your defaults is still a choice the user made.
	const [voiceOverride, setVoiceOverride] = useState(false);
	const [trOverride, setTrOverride] = useState(false);
	const [trLoaded, setTrLoaded] = useState(false);
	const [hasOpenAiKey, setHasOpenAiKey] = useState<boolean | null>(null);
	// Per-instance display name (distinguishes multiple instances of one agent).
	const [instName, setInstName] = useState("");
	const [instNameMsg, setInstNameMsg] = useState("");
	// Under-message translation (Assistant feature): translated text under each reply.
	const [trEnabled, setTrEnabled] = useState(false);
	const [trTarget, setTrTarget] = useState("English");
	const [trTranslit, setTrTranslit] = useState(false);
	const [trWordTap, setTrWordTap] = useState(true);
	const [trFontSize, setTrFontSize] = useState("medium");
	const [trLanguages, setTrLanguages] = useState<Array<{ name: string; tag: string }>>([]);
	// Connector STATUS only — no connect/disconnect state lives here any more (#355). This tab
	// reads whether the account connection exists so it can show the per-agent grant; the
	// connection itself is made on Preferences → Connections, where its scope is.
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
	// THIS agent's verdict on each connector (#352), which the account-level status above cannot
	// give: one Drive connection is shared by every instance, so `connected` is identical for an
	// agent that reads documents and one that drives a terminal.
	const [connectorPolicy, setConnectorPolicy] = useState<InstanceConnectorPolicy[] | null>(null);
	// Triggers moved to <TriggersSection/> (#16/#18/#19) — it owns its own state and loading.

	/**
	 * Every read this tab needs, in one loader, with ONE failure report (#291).
	 *
	 * All eleven of these swallowed their error, and on a settings page that is a distinctive
	 * kind of wrong: the state each one failed to fill is not blank, it is a DEFAULT. So a failed
	 * voice-settings read did not render "unknown", it rendered the standard voice; a failed
	 * connector-status read rendered "not connected". The user is shown a settings page that
	 * describes a configuration nobody has — and the controls are live, so the next save writes
	 * that fiction back.
	 *
	 * One accumulated banner rather than eleven inline error states, because they load together,
	 * fail together (the usual cause is one dropped connection or an expired session), and the
	 * useful action is identical for all of them. Naming WHICH parts failed is what keeps it from
	 * being a vague "something went wrong" — it tells the user which controls on the page in front
	 * of them they may not trust.
	 */
	const [loadFailures, setLoadFailures] = useState<string[]>([]);
	const loadAll = useCallback(() => {
		(async () => {
			const failed: string[] = [];
			try {
				// Current display name — my/instances resolves displayName over the agent name.
				const d = await api<{ instances?: Array<{ id: string; name: string }> }>("/v1/instances/my/instances");
				const mine = (d.instances || []).find((i) => i.id === instanceId);
				if (mine) setInstName(mine.name);
			} catch { failed.push("your instance name"); }
			try {
				const d = await api<{ settings?: Record<string, string | number | boolean>; fields?: SettingsField[] }>(`/v1/instances/${instanceId}/settings`);
				setAgentSettings(d.settings || {});
				if (d.fields?.length) setAgentFields(d.fields);
			} catch { failed.push("agent settings"); }
			try {
				const d = await api<{ translation?: { enabled: boolean; target: string; transliterate?: boolean; wordTap?: boolean; fontSize?: string }; languages?: Array<{ name: string; tag: string }>; hasOverride?: boolean }>(`/v1/instances/${instanceId}/translation`);
				setTrEnabled(d.translation?.enabled === true);
				setTrTarget(d.translation?.target || "English");
				setTrTranslit(d.translation?.transliterate === true);
				setTrWordTap(d.translation?.wordTap !== false);
				setTrFontSize(d.translation?.fontSize || "medium");
				setTrLanguages(d.languages || []);
				setTrOverride(d.hasOverride === true);
				setTrLoaded(true);
			} catch { failed.push("translation settings"); }
			try {
				const d = await api<{ voiceSettings?: Record<string, unknown>; hasOverride?: boolean }>(`/v1/instances/${instanceId}/voice-settings`);
				const vs = d.voiceSettings || {};
				setVoiceSettings(vs);
				setVoiceOverride(d.hasOverride === true);
				// No per-field unpacking here any more: VoiceFields seeds itself from `value`, so
				// this component only has to know WHICH object to hand it and whether it is an
				// override. That is the whole benefit of sharing the controls with Preferences.
			} catch { failed.push("voice settings"); }
			// Is there an OpenAI key? Smart (AI) recognition silently falls back to
			// browser dictation without one, so surface it explicitly.
			try {
				const k = await api<{ providers?: Array<{ id: string; hasKey: boolean }> }>("/v1/keys/status");
				setHasOpenAiKey(!!k.providers?.find((p) => p.id === "openai")?.hasKey);
			} catch {
				setHasOpenAiKey(false);
			}
			try {
				const s = await api<{ connected: boolean; configured: boolean; email?: string | null }>("/v1/email/status");
				setEmailStatus(s);
			} catch { failed.push("the email connection"); }
			try {
				const s = await api<DriveStatus>("/v1/drive/status");
				setDriveStatus(s);
			} catch { failed.push("the Drive connection"); }
			try {
				const d = await api<{ grants?: ConnectorGrant[] }>(`/v1/drive/instances/${instanceId}/grants`);
				setDriveGrants(d.grants || []);
			} catch { failed.push("your Drive folders"); }
			try {
				const s = await api<WorkdriveStatus>("/v1/workdrive/status");
				setWorkdriveStatus(s);
			} catch { failed.push("the WorkDrive connection"); }
			try {
				const d = await api<{ grants?: ConnectorGrant[] }>(`/v1/workdrive/instances/${instanceId}/grants`);
				setWorkdriveGrants(d.grants || []);
			} catch { failed.push("your WorkDrive folders"); }
			try {
				const p = await api<{ connectors?: InstanceConnectorPolicy[] }>(`/v1/instances/${instanceId}/connectors`);
				setConnectorPolicy(p.connectors || []);
			} catch { failed.push("connector policy"); }
			try {
				const st = await api<{ permissions?: { email?: boolean } }>(`/v1/instances/${instanceId}/state`);
				setEmailPermission(st.permissions?.email === true);
			} catch { failed.push("agent permissions"); }
			setLoadFailures(failed);
		})();
	}, [instanceId]);

	useEffect(() => { loadAll(); }, [loadAll]);

	// Cloud connectors open OAuth in a popup; re-check when the user returns to this tab.
	// (<RunnerPanel/> keeps its own focus listener for the same reason — a machine can connect,
	// disconnect or be taken over with `pags up --force` while this tab sits open.)
	useEffect(() => {
		const onFocus = () => {
			api<{ connected: boolean; configured: boolean; email?: string | null }>("/v1/email/status").then(setEmailStatus).catch(() => {});
			api<DriveStatus>("/v1/drive/status").then(setDriveStatus).catch(() => {});
			api<WorkdriveStatus>("/v1/workdrive/status").then(setWorkdriveStatus).catch(() => {});
		};
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, []);

	// Agent settings save (patch semantics — only the changed field is sent).
	const saveSetting = async (id: string, value: string | number | boolean) => {
		setAgentSettings((s) => ({ ...s, [id]: value }));
		try {
			const d = await api<{ settings?: Record<string, string | number | boolean> }>(`/v1/instances/${instanceId}/settings`, {
				method: "PUT",
				body: JSON.stringify({ settings: { [id]: value } }),
			});
			if (d.settings) setAgentSettings(d.settings);
			// A voiceLanguage field drives STT/TTS, but the language is no longer COPIED into
			// voice settings (#211) — the server resolves it live from the declared setting. So
			// re-read the resolved object rather than mirroring a value locally, which would now
			// disagree with the next GET.
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

	// Merge so a PUT (which replaces the whole object) doesn't wipe other settings. Writing at all
	// CREATES the override, which is why the radio flips to "Customise" on the first change.
	const saveVoice = async (patch: Record<string, unknown>) => {
		const next = { ...(voiceSettings || {}), ...patch };
		setVoiceSettings(next);
		const d = await api<{ voiceSettings?: Record<string, unknown> }>(`/v1/instances/${instanceId}/voice-settings`, {
			method: "PUT",
			body: JSON.stringify(next),
		});
		setVoiceOverride(true);
		if (d.voiceSettings) setVoiceSettings(d.voiceSettings);
		// The voice hook serves its config from cache and revalidates behind it, so the mic can
		// open without a round trip (#284). Drop the cache here — this is the one moment we know
		// it is wrong — and the new setting applies on the very next mic start.
		invalidateVoiceConfig();
	};

	/** "Use my defaults" — DELETE the override and repaint from what the account resolves to.
	 *  Deliberately NOT caught, here or in clearTrOverride: a rejection must reach PrefOverride, which owns the radio whose position is the claim (the reasoning lives there). */
	const clearVoiceOverride = async () => {
		const d = await api<{ voiceSettings?: Record<string, unknown> }>(`/v1/instances/${instanceId}/voice-settings`, { method: "DELETE" });
		setVoiceOverride(false);
		if (d?.voiceSettings) setVoiceSettings(d.voiceSettings);
		invalidateVoiceConfig(); // same reason as saveVoice: the cached config just became wrong
	};

	const saveTranslationOverride = async (next: { enabled: boolean; target: string; transliterate: boolean; wordTap: boolean; fontSize: string }) => {
		setTrEnabled(next.enabled); setTrTarget(next.target); setTrTranslit(next.transliterate);
		setTrWordTap(next.wordTap); setTrFontSize(next.fontSize);
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

	// The blast-radius line under the grant list is account-wide, so it goes stale the moment
	// THIS page changes a grant. Re-read rather than guess: the count it shows is the count
	// the disconnect confirmation will quote.
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
			setEmailPermission(!on); // revert on failure
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

	const unsubscribe = async () => {
		if (!confirm("Unsubscribe from this agent? Your data stays unless you clear it.")) return;
		try {
			await api(`/v1/instances/${instanceId}/cancel`, { method: "POST" });
			onUnsubscribe();
		} catch (e) {
			alert(e instanceof Error ? e.message : String(e));
		}
	};

	const saveInstName = async () => {
		try {
			await api(`/v1/instances/${instanceId}/name`, { method: "PUT", body: JSON.stringify({ name: instName }) });
			setInstNameMsg("Saved — updating…");
			// The header + instance lists read the name at load time — reload to reflect it everywhere.
			setTimeout(() => window.location.reload(), 600);
		} catch (e) {
			setInstNameMsg(e instanceof Error ? e.message : "Failed");
		}
	};

	// #353: a connector with no OAuth client on this deployment is not ON this page — it used to
	// be a red warning plus a dead row with no button. Why, and the three states: lib/connectorState.
	//
	// #355 narrowed Drive/WorkDrive further, from "connectable" to CONNECTED. What is left on this
	// tab for them is the folder grant, and a grant against an account you have not connected is
	// not a control — it is the dead row #353 removed, wearing a different hat. On a deployment
	// where nobody has connected Drive, the block is simply absent from every agent, which is the
	// reported symptom gone. Gmail is the exception below and says why.
	//
	// #352 adds the half neither of those could reach: what the AGENT is. Connecting Drive once is
	// an account act, so #355's `connected` check answers the same for all 26 instances — the
	// panel came back everywhere, terminal Operators included. `GET /v1/instances/:id/connectors`
	// judges each one against the agent's own declared tools; the rule is in
	// workers/api/src/lib/instance-connector-policy.ts and the combination in lib/connectorState.
	const showsEmail = showsConnector(emailStatus);
	const showsDrive = showsFileConnector(driveStatus, connectorPolicy, "google_drive");
	const showsWorkdrive = showsFileConnector(workdriveStatus, connectorPolicy, "zoho_workdrive");

	return (
		// min-w-0 lets this shrink inside the flex scroll wrapper; overflow-x-hidden is a
		// hard guard so no rigid-width descendant can ever make the whole page scroll
		// sideways (the cards are all w-full, so one over-wide child would clip them all).
		<div className="min-w-0 overflow-x-hidden">
			{/* Named parts, not "something went wrong": this tells the user which of the controls
			  * below them are showing a default rather than their own setting (#291). */}
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
			{/* Instance name — distinguishes multiple instances of the same agent */}
			<Card className="mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-1" id="inst-name-label">Instance name</h3>
				<p className="text-sm text-muted mb-3">
					Shown on your dashboard and in the header — rename it to tell multiple instances of the same agent apart (e.g. "Legal PDFs" vs "Product Manuals").
				</p>
				<div className="flex gap-2 items-center flex-wrap">
					{/* The heading IS this field's label — associate them rather than repeating the
					    text, so a screen reader announces the same words a sighted user reads. */}
					<input
						aria-labelledby="inst-name-label"
						value={instName}
						onChange={(e) => setInstName(e.target.value)}
						maxLength={60}
						className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5 w-full sm:w-72"
					/>
					<Button variant="primary" onClick={saveInstName}>Save</Button>
					{instNameMsg && <span className="text-xs text-muted">{instNameMsg}</span>}
				</div>
			</Card>

			{/* Agent settings — typed fields the agent declares (settingsSchema) */}
			{agentFields.length > 0 && (
				<Card className="mb-3 sm:mb-4">
					<h3 className="text-base font-bold mb-1">Agent settings</h3>
					<p className="text-sm text-muted mb-3">
						Settings this agent understands. They apply to every conversation with it.
					</p>
					{agentFields.map((f) => {
						const controlId = `agent-setting-${f.id}`;
						return (
						<div key={f.id} className="mb-3">
							<label htmlFor={controlId} className="block text-sm font-semibold mb-1">{f.label}</label>
							{f.description && <p className="text-xs text-muted mb-1">{f.description}</p>}
							{f.type === "select" && (
								<select
									id={controlId}
									value={String(agentSettings[f.id] ?? "")}
									onChange={(e) => saveSetting(f.id, e.target.value)}
									className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5 block w-full sm:w-auto"
								>
									{agentSettings[f.id] === undefined && <option value="">Choose…</option>}
									{(f.options || []).map((o) => (
										<option key={o.value} value={o.value}>{o.label}</option>
									))}
								</select>
							)}
							{f.type === "toggle" && (
								<label className="flex items-center gap-2 text-sm cursor-pointer">
									<input
										id={controlId}
										type="checkbox"
										checked={agentSettings[f.id] === true}
										onChange={(e) => saveSetting(f.id, e.target.checked)}
									/>
									<span className="text-muted">Enabled</span>
								</label>
							)}
							{f.type === "text" && (
								<input
									id={controlId}
									value={String(agentSettings[f.id] ?? "")}
									onChange={(e) => setAgentSettings((s) => ({ ...s, [f.id]: e.target.value }))}
									onBlur={(e) => saveSetting(f.id, e.target.value)}
									className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5 block w-full sm:w-96"
								/>
							)}
							{f.type === "number" && (
								<input
									id={controlId}
									type="number"
									value={agentSettings[f.id] === undefined ? "" : Number(agentSettings[f.id])}
									onChange={(e) => setAgentSettings((s) => ({ ...s, [f.id]: Number(e.target.value) }))}
									onBlur={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) saveSetting(f.id, n); }}
									className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5 block w-full sm:w-40"
								/>
							)}
							{f.voiceLanguage && (
								<p className="text-xs text-muted mt-1">Also sets the voice language for speech recognition and speaking.</p>
							)}
						</div>
						);
					})}
					{settingsMsg && <div className="text-sm text-muted mt-1">{settingsMsg}</div>}
				</Card>
			)}

			{/* Board maintenance */}
			<Card className="mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-1">Board maintenance</h3>
				<p className="text-sm text-muted mb-3">
					Tidy up the board. These only clear your view of finished items.
				</p>
				<div className="flex gap-2 flex-wrap">
					<Button onClick={clearFinished}>Clear finished tasks</Button>
				</div>
				{maintMsg && <div className="text-sm text-muted mt-2">{maintMsg}</div>}
			</Card>

			{/* Runner — its own data, its own refresh cycle, its own writes; nothing else on this tab
			    reads any of it. Cloud-only agents (runtime:null) get a one-line note instead. */}
			<RunnerPanel instanceId={instanceId} />

			{/* Where things live */}
			<Card className="mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-1">Where things live</h3>
				<ul className="text-sm text-muted leading-relaxed pl-4 list-disc">
					{isApply && <li><b>Resume</b> & documents → Knowledge → Documents</li>}
					{isApply && <li><b>Job application details</b> & preferences → Profile</li>}
					{isCoding && <li><b>Repository</b> → configure it in the Coding tab</li>}
					{isRepo && <li><b>Repository</b> → add it in the Repo tab</li>}
					<li><b>Rules / special instructions</b> → Knowledge → Rules & Tips</li>
					<li><b>Logins & secrets</b> → Knowledge → Credentials</li>
				</ul>
			</Card>

			{/* Permissions & Connections */}
			<Card className="mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-1">Permissions &amp; Connections</h3>
				<p className="text-sm text-muted mb-3">
					What <b>this agent</b> may do, and which of your connected folders it may read. Connecting
					or disconnecting an account is account-wide and lives in <b>Preferences → Connections</b>.
				</p>

				{/* The tool switches, the connector write-consent checkboxes and the outbound-MCP grants:
				    three views of one allow-list, which is why they live together. */}
				<ToolPermissions instanceId={instanceId} />

				{showsDrive && (
					<FileConnectorPanel
						label="Google Drive"
						account={driveStatus?.email}
						reach={driveStatus?.reach}
						grants={driveGrants}
						grantRef={driveGrantRef}
						onGrantRefChange={setDriveGrantRef}
						onAddGrant={addDriveGrant}
						onRemoveGrant={(g) => removeDriveGrant(g as ConnectorGrant)}
					/>
				)}

				{showsWorkdrive && (
					<FileConnectorPanel
						label="Zoho WorkDrive"
						account={workdriveStatus?.account}
						reach={workdriveStatus?.reach}
						grants={workdriveGrants}
						grantRef={workdriveGrantRef}
						onGrantRefChange={setWorkdriveGrantRef}
						onAddGrant={addWorkdriveGrant}
						onRemoveGrant={(g) => removeWorkdriveGrant(g as ConnectorGrant)}
					/>
				)}

				{/* The inbox permission is genuinely per-agent — a flag in THIS agent's own state, not
				    an account row — so it stays. It is shown whenever the deployment can do Gmail at
				    all, disabled rather than hidden while the account is disconnected, because
				    `agent-think.ts` still offers `find_confirmation_link` on this flag alone: hiding
				    the checkbox would remove the only control that turns off something still set.

				    The LABEL said "read my inbox for sign-in links & codes", which was exact when
				    `find_confirmation_link` was the only Gmail tool and became badly wrong once this
				    same flag started gating search, read, attachments, reply, send and archive
				    (#711/#713/#716). Someone looking for the switch that lets an inbox agent read
				    their mail would scan that line, decide it was about verification codes, and go
				    on looking — which is exactly what happened. A permission control has to describe
				    the permission, not the first thing that ever used it. */}
				{showsEmail && (
				<label className={`flex items-center gap-2 text-sm ${emailStatus?.connected ? "" : "opacity-50"}`}>
					<input
						type="checkbox"
						checked={emailPermission === true}
						disabled={!emailStatus?.connected}
						onChange={(e) => toggleEmailPermission(e.target.checked)}
					/>
					<span>
						Allow <b>this agent</b> to reach my Gmail
						<span className="block text-xs text-muted-soft mt-0.5">
							Without this it cannot read or act on any message, whatever tools it declares. Which
							of them it may actually use is the list above — and sending, archiving and marking
							read each need write access granted there as well.
						</span>
					</span>
				</label>
				)}
				{showsEmail && !emailStatus?.connected && (
					<p className="text-xs text-muted mt-1">Connect Gmail in <b>Preferences → Connections</b> to enable this.</p>
				)}
				{emailMsg && <div className="text-xs text-muted mt-2">{emailMsg}</div>}
				{driveMsg && <div className="text-xs text-muted mt-2">{driveMsg}</div>}
				{workdriveMsg && <div className="text-xs text-muted mt-2">{workdriveMsg}</div>}
			</Card>

			{/* Teamwork — supervision + connections (#182). Placed before Triggers: both are about
			    work arriving from elsewhere, and wiring agents together is the more common one. */}
			<TeamworkSection instanceId={instanceId} />

			{/* The objectives offered wherever a Loop starts (#234) — next to the runs those loops
			    produce, so "what it can do" and "what it did" sit together. */}
			<LoopPresetsSection instanceId={instanceId} />

			{/* Autonomous runs (#158/#182). Renders nothing until there is history, so it does
			    not add clutter for agents that never run an objective. */}
			<LoopRunsSection instanceId={instanceId} />

			{/* Triggers — inbound webhooks + schedules (#16/#18/#19). Self-contained: it owns
			    its own state, its schedule/preview logic and its run history. Grants are passed
			    down because this page edits them live and a sync trigger needs the current list. */}
			<TriggersSection instanceId={instanceId} driveGrants={driveGrants} workdriveGrants={workdriveGrants} />

			{/* Voice — an OVERRIDE of your account defaults (#211). The controls themselves live in
			    components/VoiceFields, shared verbatim with the Preferences page, so the two can
			    never drift apart. This card only owns the choice of WHERE a change is written. */}
			<Card className="mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-2">Voice</h3>
				<PrefOverride
					label="voice settings"
					// `voiceSettings` is null until the GET lands. Without this the radios are live
					// while the real value is still in flight, and the response overwrites the click.
					loaded={voiceSettings !== null}
					hasOverride={voiceOverride}
					// "What am I actually getting" — resolved against the OpenAI key, because half of
					// these settings silently fall back to the browser without one (lib/voiceSummary).
					summary={voiceSummary(voiceSettings, hasOpenAiKey)}
					onUseDefaults={clearVoiceOverride}
					onCustomise={() => setVoiceOverride(true)}
				/>
				{/* `voiceSettings || {}` — NOT `&& voiceSettings`. Gating on the fetched object means a
				    failed or slow GET silently disables the customise UI with no explanation; the
				    fields seed themselves from platform defaults instead, which is always editable. */}
				{voiceOverride && (
					<VoiceFields value={voiceSettings || {}} onPatch={saveVoice} hasOpenAiKey={hasOpenAiKey} />
				)}
			</Card>

			{/* Translation — same override contract as Voice. */}
			<Card className="mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-1">Translation</h3>
				<PrefOverride
					label="translation settings"
					loaded={trLoaded}
					hasOverride={trOverride}
					summary={trEnabled ? `On — ${trTarget}` : "Off"}
					onUseDefaults={clearTrOverride}
					onCustomise={() => setTrOverride(true)}
				/>
				{trOverride && (
					<TranslationFields
						value={{ enabled: trEnabled, target: trTarget, transliterate: trTranslit, wordTap: trWordTap, fontSize: trFontSize }}
						onSave={saveTranslationOverride}
						languages={trLanguages}
					/>
				)}
			</Card>

			{/* Danger zone */}
			<Card>
				<h3 className="text-base font-bold mb-1 text-danger">Danger zone</h3>
				<p className="text-sm text-muted mb-3">
					Stop using this agent. Your data stays unless you clear it above.
				</p>
				<Button variant="danger" onClick={unsubscribe}>Unsubscribe from this agent</Button>
			</Card>
		</div>
	);
}
