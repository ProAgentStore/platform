import { useState, useEffect } from "react";
import { api } from "@proagentstore/sdk/client";
import type { SettingsField } from "../lib/types";

interface Props {
	instanceId: string;
	isApply: boolean;
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

type TriggerActionType = "create_task" | "add_knowledge" | "log_event" | "sync_connector";
type ConnectorProviderType = "google_drive" | "zoho_workdrive";

interface InstanceTrigger {
	id: string;
	name: string;
	type: "webhook" | "cron";
	action: TriggerActionType;
	enabled: boolean;
	schedule?: string | null;
	config?: { provider?: ConnectorProviderType; grantId?: string };
	webhookUrl?: string;
	lastRunAt?: string | null;
	nextRunAt?: string | null;
	failureCount?: number;
	lastError?: string | null;
}

export default function SettingsTab({ instanceId, isApply, settingsSchema, onUnsubscribe }: Props) {
	const [maintMsg, setMaintMsg] = useState("");
	// Agent-declared settings: the schema prop is the fast path; the GET also returns
	// `fields` so the form never depends on a stale instance-list cache.
	const [agentFields, setAgentFields] = useState<SettingsField[]>(settingsSchema ?? []);
	const [agentSettings, setAgentSettings] = useState<Record<string, string | number | boolean>>({});
	const [settingsMsg, setSettingsMsg] = useState("");
	const [runtimeInfo, setRuntimeInfo] = useState<Record<string, unknown> | null>(null);
	// Node binding: which machine this instance runs on ("" = automatic).
	const [runnerNode, setRunnerNode] = useState("");
	const [runnerNodes, setRunnerNodes] = useState<string[]>([]);
	const [runnerNodesDetail, setRunnerNodesDetail] = useState<Array<{ node: string; connected: boolean }>>([]);
	const [runnerNodeMsg, setRunnerNodeMsg] = useState("");
	const [voiceSettings, setVoiceSettings] = useState<Record<string, unknown> | null>(null);
	const [silenceMs, setSilenceMs] = useState(1500);
	const [sensitivity, setSensitivity] = useState(1);
	const [sttMode, setSttMode] = useState("browser");
	const [ttsProvider, setTtsProvider] = useState("browser");
	const [ttsVoice, setTtsVoice] = useState("alloy");
	const [speed, setSpeed] = useState(100);
	const [language, setLanguage] = useState("en-US");
	const [commandsEnabled, setCommandsEnabled] = useState(true);
	const [hasOpenAiKey, setHasOpenAiKey] = useState<boolean | null>(null);
	const [voiceMsg, setVoiceMsg] = useState("");
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
	const [trMsg, setTrMsg] = useState("");
	const [emailStatus, setEmailStatus] = useState<{ connected: boolean; configured: boolean; email?: string | null } | null>(null);
	const [emailPermission, setEmailPermission] = useState<boolean | null>(null);
	const [emailMsg, setEmailMsg] = useState("");
	const [driveStatus, setDriveStatus] = useState<{ connected: boolean; configured: boolean; email?: string | null } | null>(null);
	const [driveMsg, setDriveMsg] = useState("");
	const [driveGrantRef, setDriveGrantRef] = useState("");
	const [driveGrants, setDriveGrants] = useState<ConnectorGrant[]>([]);
	const [workdriveStatus, setWorkdriveStatus] = useState<{ connected: boolean; configured: boolean; account?: string | null } | null>(null);
	const [workdriveMsg, setWorkdriveMsg] = useState("");
	const [workdriveGrantRef, setWorkdriveGrantRef] = useState("");
	const [workdriveGrants, setWorkdriveGrants] = useState<ConnectorGrant[]>([]);
	const [triggers, setTriggers] = useState<InstanceTrigger[]>([]);
	const [triggerMsg, setTriggerMsg] = useState("");
	const [triggerName, setTriggerName] = useState("");
	const [triggerType, setTriggerType] = useState<"webhook" | "cron">("webhook");
	const [triggerAction, setTriggerAction] = useState<TriggerActionType>("create_task");
	const [triggerSchedule, setTriggerSchedule] = useState("@daily");
	const [triggerConnectorProvider, setTriggerConnectorProvider] = useState<ConnectorProviderType>("google_drive");
	const [triggerConnectorGrantId, setTriggerConnectorGrantId] = useState("");
	const triggerConnectorGrants = triggerConnectorProvider === "google_drive" ? driveGrants : workdriveGrants;

	// biome-ignore lint/correctness/useExhaustiveDependencies: initial settings hydration calls the trigger loader once for this instance; trigger CRUD refreshes itself.
	useEffect(() => {
		(async () => {
			try {
				// Current display name — my/instances resolves displayName over the agent name.
				const d = await api<{ instances?: Array<{ id: string; name: string }> }>("/v1/instances/my/instances");
				const mine = (d.instances || []).find((i) => i.id === instanceId);
				if (mine) setInstName(mine.name);
			} catch {}
			try {
				const d = await api<{ settings?: Record<string, string | number | boolean>; fields?: SettingsField[] }>(`/v1/instances/${instanceId}/settings`);
				setAgentSettings(d.settings || {});
				if (d.fields?.length) setAgentFields(d.fields);
			} catch {}
			try {
				const d = await api<Record<string, unknown>>(`/v1/instances/${instanceId}/runtime/status`);
				setRuntimeInfo(d);
			} catch {}
			try {
				const d = await api<{ runnerNode: string | null; nodes: string[]; nodesDetail?: Array<{ node: string; connected: boolean }> }>(`/v1/instances/${instanceId}/runner-node`);
				setRunnerNode(d.runnerNode || "");
				setRunnerNodes(d.nodes || []);
				setRunnerNodesDetail(d.nodesDetail || []);
			} catch {}
			try {
				const d = await api<{ translation?: { enabled: boolean; target: string; transliterate?: boolean; wordTap?: boolean; fontSize?: string }; languages?: Array<{ name: string; tag: string }> }>(`/v1/instances/${instanceId}/translation`);
				setTrEnabled(d.translation?.enabled === true);
				setTrTarget(d.translation?.target || "English");
				setTrTranslit(d.translation?.transliterate === true);
				setTrWordTap(d.translation?.wordTap !== false);
				setTrFontSize(d.translation?.fontSize || "medium");
				setTrLanguages(d.languages || []);
			} catch {}
			try {
				const d = await api<{ voiceSettings?: Record<string, unknown> }>(`/v1/instances/${instanceId}/voice-settings`);
				const vs = d.voiceSettings || {};
				setVoiceSettings(vs);
				if (typeof vs.silenceMs === "number") setSilenceMs(vs.silenceMs);
				if (typeof vs.sensitivity === "number") setSensitivity(vs.sensitivity);
				if (typeof vs.sttMode === "string") setSttMode(vs.sttMode);
				if (typeof vs.provider === "string") setTtsProvider(vs.provider);
				if (typeof vs.speed === "number") setSpeed(vs.speed);
				if (typeof vs.language === "string") setLanguage(vs.language);
				if (typeof vs.commandsEnabled === "boolean") setCommandsEnabled(vs.commandsEnabled);
				const oa = vs.openai as Record<string, unknown> | undefined;
				if (oa && typeof oa.voice === "string") setTtsVoice(oa.voice);
			} catch {}
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
			} catch {}
			try {
				const s = await api<{ connected: boolean; configured: boolean; email?: string | null }>("/v1/drive/status");
				setDriveStatus(s);
			} catch {}
			try {
				const d = await api<{ grants?: ConnectorGrant[] }>(`/v1/drive/instances/${instanceId}/grants`);
				setDriveGrants(d.grants || []);
			} catch {}
			try {
				const s = await api<{ connected: boolean; configured: boolean; account?: string | null }>("/v1/workdrive/status");
				setWorkdriveStatus(s);
			} catch {}
			try {
				const d = await api<{ grants?: ConnectorGrant[] }>(`/v1/workdrive/instances/${instanceId}/grants`);
				setWorkdriveGrants(d.grants || []);
			} catch {}
			try {
				const st = await api<{ permissions?: { email?: boolean } }>(`/v1/instances/${instanceId}/state`);
				setEmailPermission(st.permissions?.email === true);
			} catch {}
			loadTriggers();
		})();
	}, [instanceId]);

	// Cloud connectors open OAuth in a popup; re-check when the user returns to this tab.
	// Also re-check the RUNNER: a machine can connect/disconnect (or be taken over with
	// `pags up --force`) while this tab is open, and the runner card + "Runs on" picker are
	// otherwise fetched only once on mount — so without this they'd show stale online/offline
	// state (and a stale "⚠ machine offline" warning) until a full reload.
	useEffect(() => {
		const onFocus = () => {
			api<{ connected: boolean; configured: boolean; email?: string | null }>("/v1/email/status").then(setEmailStatus).catch(() => {});
			api<{ connected: boolean; configured: boolean; email?: string | null }>("/v1/drive/status").then(setDriveStatus).catch(() => {});
			api<{ connected: boolean; configured: boolean; account?: string | null }>("/v1/workdrive/status").then(setWorkdriveStatus).catch(() => {});
			api<Record<string, unknown>>(`/v1/instances/${instanceId}/runtime/status`).then(setRuntimeInfo).catch(() => {});
			api<{ runnerNode: string | null; nodes: string[]; nodesDetail?: Array<{ node: string; connected: boolean }> }>(`/v1/instances/${instanceId}/runner-node`).then((d) => {
				setRunnerNode(d.runnerNode || "");
				setRunnerNodes(d.nodes || []);
				setRunnerNodesDetail(d.nodesDetail || []);
			}).catch(() => {});
		};
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [instanceId]);

	// Agent settings save (patch semantics — only the changed field is sent).
	const saveSetting = async (id: string, value: string | number | boolean) => {
		setAgentSettings((s) => ({ ...s, [id]: value }));
		try {
			const d = await api<{ settings?: Record<string, string | number | boolean> }>(`/v1/instances/${instanceId}/settings`, {
				method: "PUT",
				body: JSON.stringify({ settings: { [id]: value } }),
			});
			if (d.settings) setAgentSettings(d.settings);
			// A voiceLanguage field also updated the server's voice-settings language —
			// mirror it locally so the Voice section's Language select (same page)
			// doesn't show a stale value until reload.
			const field = agentFields.find((f) => f.id === id);
			if (field?.voiceLanguage && typeof value === "string") {
				setLanguage(value);
				setVoiceSettings((s) => ({ ...(s || {}), language: value }));
			}
			setSettingsMsg("Saved — applies on your next turn");
			setTimeout(() => setSettingsMsg(""), 2500);
		} catch (e) {
			setSettingsMsg(e instanceof Error ? e.message : "Failed");
		}
	};

	// Merge so a PUT (which replaces the whole object) doesn't wipe other settings.
	const saveVoice = async (patch: Record<string, unknown>) => {
		const next = { ...(voiceSettings || {}), ...patch };
		setVoiceSettings(next);
		try {
			await api(`/v1/instances/${instanceId}/voice-settings`, { method: "PUT", body: JSON.stringify(next) });
			setVoiceMsg("Saved — applies on your next turn");
			setTimeout(() => setVoiceMsg(""), 2500);
		} catch (e) {
			setVoiceMsg(e instanceof Error ? e.message : "Failed");
		}
	};

	const connectGmail = async () => {
		try {
			const { url } = await api<{ url: string }>("/v1/email/google/start");
			window.open(url, "_blank", "noopener");
			setEmailMsg("Complete the Google sign-in in the new tab, then come back here.");
		} catch (e) {
			setEmailMsg(e instanceof Error ? e.message : "Failed to start Gmail connection");
		}
	};

	const disconnectGmail = async () => {
		if (!confirm("Disconnect Gmail? Agents will no longer be able to read your inbox for sign-in links.")) return;
		try {
			await api("/v1/email/google", { method: "DELETE" });
			setEmailStatus((s) => (s ? { ...s, connected: false } : s));
			setEmailMsg("Gmail disconnected.");
		} catch (e) {
			setEmailMsg(e instanceof Error ? e.message : "Failed");
		}
	};

	const connectDrive = async () => {
		try {
			const { url } = await api<{ url: string }>("/v1/drive/google/start");
			window.open(url, "_blank", "noopener");
			setDriveMsg("Complete the Google sign-in in the new tab, then come back here.");
		} catch (e) {
			setDriveMsg(e instanceof Error ? e.message : "Failed to start Google Drive connection");
		}
	};

	const disconnectDrive = async () => {
		if (!confirm("Disconnect Google Drive? You can keep existing imported documents, but new Drive imports will stop working.")) return;
		try {
			await api("/v1/drive/google", { method: "DELETE" });
			setDriveStatus((s) => (s ? { ...s, connected: false } : s));
			setDriveMsg("Google Drive disconnected.");
		} catch (e) {
			setDriveMsg(e instanceof Error ? e.message : "Failed");
		}
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
		} catch (e) {
			setDriveMsg(e instanceof Error ? e.message : "Failed to grant Drive folder");
		}
	};

	const removeDriveGrant = async (grant: ConnectorGrant) => {
		try {
			await api(`/v1/drive/instances/${instanceId}/grants/${grant.id}`, { method: "DELETE" });
			setDriveGrants((grants) => grants.filter((g) => g.id !== grant.id));
			setDriveMsg(`Removed access to ${grant.resourceName}.`);
		} catch (e) {
			setDriveMsg(e instanceof Error ? e.message : "Failed to remove Drive access");
		}
	};

	const connectWorkdrive = async () => {
		try {
			const { url } = await api<{ url: string }>("/v1/workdrive/zoho/start");
			window.open(url, "_blank", "noopener");
			setWorkdriveMsg("Complete the Zoho sign-in in the new tab, then come back here.");
		} catch (e) {
			setWorkdriveMsg(e instanceof Error ? e.message : "Failed to start Zoho WorkDrive connection");
		}
	};

	const disconnectWorkdrive = async () => {
		if (!confirm("Disconnect Zoho WorkDrive? Existing imported documents stay, but new WorkDrive imports will stop working.")) return;
		try {
			await api("/v1/workdrive/zoho", { method: "DELETE" });
			setWorkdriveStatus((s) => (s ? { ...s, connected: false } : s));
			setWorkdriveMsg("Zoho WorkDrive disconnected.");
		} catch (e) {
			setWorkdriveMsg(e instanceof Error ? e.message : "Failed");
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
		} catch (e) {
			setWorkdriveMsg(e instanceof Error ? e.message : "Failed to grant WorkDrive folder");
		}
	};

	const removeWorkdriveGrant = async (grant: ConnectorGrant) => {
		try {
			await api(`/v1/workdrive/instances/${instanceId}/grants/${grant.id}`, { method: "DELETE" });
			setWorkdriveGrants((grants) => grants.filter((g) => g.id !== grant.id));
			setWorkdriveMsg(`Removed access to ${grant.resourceName}.`);
		} catch (e) {
			setWorkdriveMsg(e instanceof Error ? e.message : "Failed to remove WorkDrive access");
		}
	};

	const toggleEmailPermission = async (on: boolean) => {
		setEmailPermission(on);
		try {
			await api(`/v1/instances/${instanceId}/state`, { method: "PUT", body: JSON.stringify({ permissions: { email: on } }) });
			setEmailMsg(on ? "This agent can now read your inbox for sign-in links & codes." : "Email access turned off for this agent.");
		} catch (e) {
			setEmailPermission(!on); // revert on failure
			setEmailMsg(e instanceof Error ? e.message : "Failed");
		}
	};

	const saveTranslation = async (enabled: boolean, target: string, transliterate: boolean, wordTap: boolean, fontSize: string) => {
		setTrEnabled(enabled);
		setTrTarget(target);
		setTrTranslit(transliterate);
		setTrWordTap(wordTap);
		setTrFontSize(fontSize);
		try {
			await api(`/v1/instances/${instanceId}/translation`, { method: "PUT", body: JSON.stringify({ enabled, target, transliterate, wordTap, fontSize }) });
			setTrMsg("Saved — applies on your next message");
			setTimeout(() => setTrMsg(""), 2500);
		} catch (e) {
			setTrMsg(e instanceof Error ? e.message : "Failed");
		}
	};

	const loadTriggers = async () => {
		try {
			const d = await api<{ triggers?: InstanceTrigger[] }>(`/v1/triggers?instanceId=${encodeURIComponent(instanceId)}`);
			setTriggers(d.triggers || []);
		} catch (e) {
			setTriggerMsg(e instanceof Error ? e.message : "Failed to load triggers");
		}
	};

	const createTrigger = async () => {
		try {
			const syncGrantId = triggerConnectorGrantId || triggerConnectorGrants[0]?.id || "";
			if (triggerAction === "sync_connector" && !syncGrantId) {
				setTriggerMsg(`Grant a ${triggerConnectorProvider === "google_drive" ? "Google Drive" : "Zoho WorkDrive"} folder before creating a sync trigger.`);
				return;
			}
			const name = triggerName.trim() || (
				triggerAction === "sync_connector"
					? `${triggerConnectorProvider === "google_drive" ? "Google Drive" : "WorkDrive"} sync`
					: triggerType === "webhook" ? "Inbound webhook" : "Scheduled run"
			);
			await api("/v1/triggers", {
				method: "POST",
				body: JSON.stringify({
					instanceId,
					name,
					type: triggerType,
					action: triggerAction,
					schedule: triggerType === "cron" ? triggerSchedule : undefined,
					config: triggerAction === "sync_connector" ? {
						provider: triggerConnectorProvider,
						grantId: syncGrantId,
					} : undefined,
				}),
			});
			setTriggerName("");
			setTriggerMsg("Trigger created.");
			await loadTriggers();
		} catch (e) {
			setTriggerMsg(e instanceof Error ? e.message : "Failed");
		}
	};

	const runTrigger = async (id: string) => {
		try {
			await api(`/v1/triggers/${id}/run`, { method: "POST", body: JSON.stringify({ manual: true }) });
			setTriggerMsg("Trigger run queued.");
			await loadTriggers();
		} catch (e) {
			setTriggerMsg(e instanceof Error ? e.message : "Failed");
		}
	};

	const deleteTrigger = async (trigger: InstanceTrigger) => {
		if (!confirm(`Delete trigger "${trigger.name}"?`)) return;
		try {
			await api(`/v1/triggers/${trigger.id}`, { method: "DELETE" });
			setTriggerMsg("Trigger deleted.");
			await loadTriggers();
		} catch (e) {
			setTriggerMsg(e instanceof Error ? e.message : "Failed");
		}
	};

	const copyWebhook = async (url: string) => {
		await navigator.clipboard?.writeText(url).catch(() => undefined);
		setTriggerMsg("Webhook URL copied.");
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

	const saveRunnerNode = async (node: string) => {
		setRunnerNode(node);
		setRunnerNodeMsg("Saving…");
		try {
			await api(`/v1/instances/${instanceId}/runner-node`, { method: "PUT", body: JSON.stringify({ runnerNode: node || null }) });
			setRunnerNodeMsg(node ? `Pinned to ${node}` : "Set to automatic");
		} catch (e) {
			setRunnerNodeMsg(e instanceof Error ? e.message : "Failed");
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

	return (
		<div>
			{/* Instance name — distinguishes multiple instances of the same agent */}
			<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-1">Instance name</h3>
				<p className="text-sm text-muted mb-3">
					Shown on your dashboard and in the header — rename it to tell multiple instances of the same agent apart (e.g. "Legal PDFs" vs "Product Manuals").
				</p>
				<div className="flex gap-2 items-center flex-wrap">
					<input
						value={instName}
						onChange={(e) => setInstName(e.target.value)}
						maxLength={60}
						className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5 w-full sm:w-72"
					/>
					<button type="button" onClick={saveInstName} className="text-xs px-3 py-1.5 rounded-lg bg-accent text-white font-bold">Save</button>
					{instNameMsg && <span className="text-xs text-muted">{instNameMsg}</span>}
				</div>
			</div>

			{/* Agent settings — typed fields the agent declares (settingsSchema) */}
			{agentFields.length > 0 && (
				<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4">
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
										className="w-4 h-4 accent-accent"
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
				</div>
			)}

			{/* Board maintenance */}
			<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-1">Board maintenance</h3>
				<p className="text-sm text-muted mb-3">
					Tidy up the board. These only clear your view of finished items.
				</p>
				<div className="flex gap-2 flex-wrap">
					<button
						type="button"
						onClick={clearFinished}
						className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-bold"
					>
						Clear finished tasks
					</button>
				</div>
				{maintMsg && <div className="text-sm text-muted mt-2">{maintMsg}</div>}
			</div>

			{/* Runner info */}
			<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-1">Runner</h3>
				<div className="text-sm text-muted leading-relaxed">
					{runtimeInfo ? (
						<>
							Status: {String((runtimeInfo as Record<string, unknown>).connected ? "Online" : "Offline")}
							{(runtimeInfo as Record<string, unknown>).node && (
								<> · Node: {String((runtimeInfo as Record<string, unknown>).node)}</>
							)}
						</>
					) : (
						"Checking runner status..."
					)}
				</div>

				{/* Node binding — pin this agent to a specific machine (CLI). Platform-wide:
				    any agent can be bound to any of your connected nodes. */}
				<div className="mt-3 pt-3 border-t border-line/60">
					<label className="block text-sm font-semibold mb-1">Runs on</label>
					<select
						value={runnerNode}
						onChange={(e) => saveRunnerNode(e.target.value)}
						className="w-full sm:w-auto bg-panel border border-line rounded-lg px-2.5 py-1.5 text-sm"
					>
						<option value="">Automatic (any connected machine)</option>
						{/* The pinned node may not be in the currently-registered list (machine offline) — keep it selectable. */}
						{runnerNode && !runnerNodes.includes(runnerNode) && <option value={runnerNode}>{runnerNode} (offline)</option>}
						{runnerNodes.map((n) => {
							// Live status per machine (RelayDO truth). An offline machine is still selectable
							// but clearly labeled so a pin to it doesn't silently look "connected".
							const online = runnerNodesDetail.find((d) => d.node === n)?.connected;
							return <option key={n} value={n}>{n}{online === false ? " (offline)" : ""}</option>;
						})}
					</select>
					<p className="text-xs text-muted-soft mt-1">
						Pin this agent to one of your machines running <code className="text-accent">pags up</code>. Its runner tasks (chat tools, apply, coding) route there.
						{runnerNodes.length === 0 && !runnerNode && <> No machines connected yet — see <span className="text-accent">Terminals</span>.</>}
					</p>
					{/* Pinned to a machine that isn't connected → the agent is offline until you start that
					    machine or repin. Called out because a strict pin never silently falls back. */}
					{runnerNode && runnerNodesDetail.some((d) => d.node === runnerNode && !d.connected) && (
						<p className="text-xs text-amber-500 mt-0.5">
							⚠ <b>{runnerNode}</b> isn't connected. This agent's runner tasks won't run until you start <code className="text-accent">pags up</code> on it, or pick another machine above.
						</p>
					)}
					{runnerNodeMsg && <p className="text-xs text-muted mt-0.5">{runnerNodeMsg}</p>}
				</div>
			</div>

			{/* Where things live */}
			<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-1">Where things live</h3>
				<ul className="text-sm text-muted leading-relaxed pl-4 list-disc">
					{isApply && <li><b>Resume</b> & documents → Knowledge → Documents</li>}
					{isApply && <li><b>Candidate profile</b> & job preferences → Profile</li>}
					<li><b>Rules / special instructions</b> → Knowledge → Rules & Tips</li>
					<li><b>Logins & secrets</b> → Knowledge → Credentials</li>
				</ul>
			</div>

			{/* Permissions & Connections */}
			<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-1">Permissions &amp; Connections</h3>
				<p className="text-sm text-muted mb-3">
					Connect accounts once, then grant this agent access to only the folders it should use.
				</p>

				{emailStatus && !emailStatus.configured && (
					<p className="text-xs text-red mb-2">Email connection isn’t configured on this deployment yet.</p>
				)}
				{driveStatus && !driveStatus.configured && (
					<p className="text-xs text-red mb-2">Google Drive connection isn’t configured on this deployment yet.</p>
				)}
				{workdriveStatus && !workdriveStatus.configured && (
					<p className="text-xs text-red mb-2">Zoho WorkDrive connection isn’t configured on this deployment yet.</p>
				)}

				<div className="flex items-center justify-between gap-3 mb-3">
					<div className="text-sm">
						<span className="font-semibold">Gmail</span>{" "}
						{emailStatus?.connected
							? <span className="text-green">· connected{emailStatus.email ? ` (${emailStatus.email})` : ""}</span>
							: <span className="text-muted">· not connected</span>}
					</div>
					{emailStatus?.configured && (
						emailStatus.connected ? (
							<button type="button" onClick={disconnectGmail} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted hover:border-red hover:text-red font-bold">
								Disconnect
							</button>
						) : (
							<button type="button" onClick={connectGmail} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-bold">
								Connect Gmail
							</button>
						)
					)}
				</div>

				<div className="flex items-center justify-between gap-3 mb-3">
					<div className="text-sm">
						<span className="font-semibold">Google Drive</span>{" "}
						{driveStatus?.connected
							? <span className="text-green">· connected{driveStatus.email ? ` (${driveStatus.email})` : ""}</span>
							: <span className="text-muted">· not connected</span>}
					</div>
					{driveStatus?.configured && (
						driveStatus.connected ? (
							<button type="button" onClick={disconnectDrive} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted hover:border-red hover:text-red font-bold">
								Disconnect
							</button>
						) : (
							<button type="button" onClick={connectDrive} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-bold">
								Connect Drive
							</button>
						)
					)}
				</div>
				{driveStatus?.connected && (
					<div className="mb-4 pl-0 sm:pl-3 border-l-0 sm:border-l sm:border-line">
						<div className="flex gap-2 flex-wrap mb-2">
							<input
								value={driveGrantRef}
								onChange={(e) => setDriveGrantRef(e.target.value)}
								onKeyDown={(e) => { if (e.key === "Enter") addDriveGrant(); }}
								placeholder="Google Drive folder URL or ID"
								className="flex-1 min-w-[14rem] bg-paper border border-line rounded-lg px-3 py-2 text-sm"
							/>
							<button type="button" onClick={addDriveGrant} disabled={!driveGrantRef.trim()} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-bold disabled:opacity-50">
								Grant folder
							</button>
						</div>
						<div className="flex flex-col gap-1.5">
							{driveGrants.length === 0 ? (
								<p className="text-xs text-muted">No Drive folders granted to this agent yet.</p>
							) : driveGrants.map((grant) => (
								<div key={grant.id} className="flex items-center justify-between gap-2 text-xs bg-paper border border-line rounded-lg px-2.5 py-2">
									<span className="min-w-0 truncate">{grant.resourceName}</span>
									<button type="button" onClick={() => removeDriveGrant(grant)} className="shrink-0 text-muted hover:text-red">Remove</button>
								</div>
							))}
						</div>
					</div>
				)}

				<div className="flex items-center justify-between gap-3 mb-3">
					<div className="text-sm">
						<span className="font-semibold">Zoho WorkDrive</span>{" "}
						{workdriveStatus?.connected
							? <span className="text-green">· connected{workdriveStatus.account ? ` (${workdriveStatus.account})` : ""}</span>
							: <span className="text-muted">· not connected</span>}
					</div>
					{workdriveStatus?.configured && (
						workdriveStatus.connected ? (
							<button type="button" onClick={disconnectWorkdrive} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted hover:border-red hover:text-red font-bold">
								Disconnect
							</button>
						) : (
							<button type="button" onClick={connectWorkdrive} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-bold">
								Connect WorkDrive
							</button>
						)
					)}
				</div>
				{workdriveStatus?.connected && (
					<div className="mb-4 pl-0 sm:pl-3 border-l-0 sm:border-l sm:border-line">
						<div className="flex gap-2 flex-wrap mb-2">
							<input
								value={workdriveGrantRef}
								onChange={(e) => setWorkdriveGrantRef(e.target.value)}
								onKeyDown={(e) => { if (e.key === "Enter") addWorkdriveGrant(); }}
								placeholder="Zoho WorkDrive folder URL or ID"
								className="flex-1 min-w-[14rem] bg-paper border border-line rounded-lg px-3 py-2 text-sm"
							/>
							<button type="button" onClick={addWorkdriveGrant} disabled={!workdriveGrantRef.trim()} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-bold disabled:opacity-50">
								Grant folder
							</button>
						</div>
						<div className="flex flex-col gap-1.5">
							{workdriveGrants.length === 0 ? (
								<p className="text-xs text-muted">No WorkDrive folders granted to this agent yet.</p>
							) : workdriveGrants.map((grant) => (
								<div key={grant.id} className="flex items-center justify-between gap-2 text-xs bg-paper border border-line rounded-lg px-2.5 py-2">
									<span className="min-w-0 truncate">{grant.resourceName}</span>
									<button type="button" onClick={() => removeWorkdriveGrant(grant)} className="shrink-0 text-muted hover:text-red">Remove</button>
								</div>
							))}
						</div>
					</div>
				)}

				<label className={`flex items-center gap-2 text-sm ${emailStatus?.connected ? "" : "opacity-50"}`}>
					<input
						type="checkbox"
						checked={emailPermission === true}
						disabled={!emailStatus?.connected}
						onChange={(e) => toggleEmailPermission(e.target.checked)}
					/>
					<span>Allow <b>this agent</b> to read my inbox for sign-in links &amp; codes</span>
				</label>
				{!emailStatus?.connected && (
					<p className="text-xs text-muted mt-1">Connect Gmail above to enable this.</p>
				)}
				{emailMsg && <div className="text-xs text-muted mt-2">{emailMsg}</div>}
				{driveMsg && <div className="text-xs text-muted mt-2">{driveMsg}</div>}
				{workdriveMsg && <div className="text-xs text-muted mt-2">{workdriveMsg}</div>}
			</div>

			{/* Triggers */}
			<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-1">Triggers</h3>
				<p className="text-sm text-muted mb-3">
					Start work from an inbound webhook or a schedule. Triggers run inside this private instance.
				</p>
				<div className="grid grid-cols-1 md:grid-cols-[1.2fr_0.8fr_0.9fr_0.9fr_auto] gap-2 items-end mb-4">
					<label className="flex flex-col gap-1">
						<span className="text-xs font-semibold">Name</span>
						<input value={triggerName} onChange={(e) => setTriggerName(e.target.value)} placeholder="Daily digest" className="text-sm bg-paper border border-line rounded-lg px-3 py-2 w-full" />
					</label>
					<label className="flex flex-col gap-1">
						<span className="text-xs font-semibold">Type</span>
						<select value={triggerType} onChange={(e) => setTriggerType(e.target.value as "webhook" | "cron")} className="text-sm bg-paper border border-line rounded-lg px-3 py-2 w-full">
							<option value="webhook">Webhook</option>
							<option value="cron">Cron</option>
						</select>
					</label>
					<label className="flex flex-col gap-1">
						<span className="text-xs font-semibold">Action</span>
						<select value={triggerAction} onChange={(e) => setTriggerAction(e.target.value as TriggerActionType)} className="text-sm bg-paper border border-line rounded-lg px-3 py-2 w-full">
							<option value="create_task">Create task</option>
							<option value="add_knowledge">Add knowledge</option>
							<option value="sync_connector">Sync folder</option>
							<option value="log_event">Log event</option>
						</select>
					</label>
					<label className="flex flex-col gap-1">
						<span className="text-xs font-semibold">Schedule</span>
						<input disabled={triggerType !== "cron"} value={triggerSchedule} onChange={(e) => setTriggerSchedule(e.target.value)} placeholder="@daily" className="text-sm bg-paper border border-line rounded-lg px-3 py-2 w-full disabled:opacity-50" />
					</label>
					<button type="button" onClick={createTrigger} className="text-xs px-3 py-2 rounded-lg bg-accent text-white font-bold">Add</button>
				</div>
				{triggerAction === "sync_connector" && (
					<div className="grid grid-cols-1 md:grid-cols-2 gap-2 items-end mb-4">
						<label className="flex flex-col gap-1">
							<span className="text-xs font-semibold">Connector</span>
							<select
								value={triggerConnectorProvider}
								onChange={(e) => {
									setTriggerConnectorProvider(e.target.value as ConnectorProviderType);
									setTriggerConnectorGrantId("");
								}}
								className="text-sm bg-paper border border-line rounded-lg px-3 py-2 w-full"
							>
								<option value="google_drive">Google Drive</option>
								<option value="zoho_workdrive">Zoho WorkDrive</option>
							</select>
						</label>
						<label className="flex flex-col gap-1">
							<span className="text-xs font-semibold">Folder grant</span>
							<select
								value={triggerConnectorGrantId || triggerConnectorGrants[0]?.id || ""}
								onChange={(e) => setTriggerConnectorGrantId(e.target.value)}
								className="text-sm bg-paper border border-line rounded-lg px-3 py-2 w-full"
							>
								{triggerConnectorGrants.length === 0 ? (
									<option value="">No granted folders</option>
								) : triggerConnectorGrants.map((grant) => (
									<option key={grant.id} value={grant.id}>{grant.resourceName}</option>
								))}
							</select>
						</label>
					</div>
				)}
				<div className="flex flex-col gap-2">
					{triggers.length === 0 ? (
						<p className="text-xs text-muted">No triggers configured yet.</p>
					) : triggers.map((trigger) => (
						<div key={trigger.id} className="bg-paper border border-line rounded-lg p-3">
							<div className="flex items-start justify-between gap-3">
								<div className="min-w-0">
									<div className="text-sm font-bold">{trigger.name}</div>
									<div className="text-xs text-muted mt-0.5">
										{trigger.type} · {trigger.action.replace("_", " ")}
										{trigger.schedule ? ` · ${trigger.schedule}` : ""}
										{trigger.action === "sync_connector" && trigger.config?.provider ? ` · ${trigger.config.provider === "google_drive" ? "Google Drive" : "WorkDrive"}` : ""}
										{trigger.nextRunAt ? ` · next ${new Date(trigger.nextRunAt).toLocaleString()}` : ""}
									</div>
									{trigger.lastError && <div className="text-xs text-red mt-1">{trigger.lastError}</div>}
								</div>
								<div className="flex gap-2 shrink-0 flex-wrap justify-end">
									<button type="button" onClick={() => runTrigger(trigger.id)} className="text-xs px-2.5 py-1 rounded-md border border-line text-muted hover:text-accent hover:border-accent font-semibold">Run now</button>
									<button type="button" onClick={() => deleteTrigger(trigger)} className="text-xs px-2.5 py-1 rounded-md border border-line text-muted hover:text-red hover:border-red font-semibold">Delete</button>
								</div>
							</div>
							{trigger.webhookUrl && (
								<div className="flex gap-2 mt-2">
									<input readOnly value={trigger.webhookUrl} className="flex-1 min-w-0 text-xs bg-panel border border-line rounded px-2 py-1.5 font-mono" />
									<button type="button" onClick={() => copyWebhook(trigger.webhookUrl || "")} className="text-xs px-2.5 py-1 rounded-md border border-line text-muted hover:text-accent hover:border-accent font-semibold">Copy</button>
								</div>
							)}
						</div>
					))}
				</div>
				{triggerMsg && <div className="text-xs text-muted mt-2">{triggerMsg}</div>}
			</div>

			{/* Voice */}
			<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-2">Voice</h3>

				<label htmlFor="voice-stt-mode" className="block text-sm font-semibold mb-1">Speech recognition (how it hears you)</label>
				<p className="text-xs text-muted mb-2">
					<b>Dictation</b> shows words <b>live as you speak</b> (real-time) — on-device, instant, but error-prone with accents. <b>Smart (AI)</b> records your whole turn and transcribes it with OpenAI Whisper — far more accurate, but the text only appears <b>at the end</b> (no live words). Whisper needs your OpenAI key (Knowledge → Credentials; falls back to Dictation without it).
				</p>
				<select
					id="voice-stt-mode"
					value={sttMode}
					onChange={(e) => { setSttMode(e.target.value); saveVoice({ sttMode: e.target.value }); }}
					className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5 mb-2 block w-full sm:w-auto"
				>
					<option value="browser">Dictation — real-time, words as you speak</option>
					<option value="openai">Smart (AI) — Whisper, most accurate (appears at end)</option>
				</select>
				{sttMode === "openai" && hasOpenAiKey !== null && (
					hasOpenAiKey ? (
						<p className="text-xs text-green mb-4">✓ OpenAI key found — voice is transcribed with Whisper (AI).</p>
					) : (
						<p className="text-xs text-red mb-4">⚠ No OpenAI key found — Smart (AI) can't run, so it's still using plain dictation. Add your key in <b>Knowledge → Credentials</b> to enable Whisper.</p>
					)
				)}

				<label htmlFor="voice-tts-provider" className="block text-sm font-semibold mb-1 mt-4">Voice output (how it speaks back)</label>
				<p className="text-xs text-muted mb-2">
					<b>Browser voice</b> is built-in and free. <b>Natural (OpenAI)</b> uses OpenAI TTS for a far more human voice (needs your OpenAI key; falls back to the browser voice without it).
				</p>
				<select
					id="voice-tts-provider"
					value={ttsProvider}
					onChange={(e) => { setTtsProvider(e.target.value); saveVoice({ provider: e.target.value }); }}
					className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5 mb-2 block w-full sm:w-auto"
				>
					<option value="browser">Browser voice — free, on-device</option>
					<option value="openai-realtime">Natural (OpenAI) — human-sounding</option>
				</select>
				{ttsProvider.includes("openai") && hasOpenAiKey === false && (
					<p className="text-xs text-red mb-2">⚠ No OpenAI key — using the browser voice. Add your key in <b>Knowledge → Credentials</b>.</p>
				)}
				{ttsProvider.includes("openai") && (
					<div className="mb-2">
						<label htmlFor="voice-openai-voice" className="block text-xs font-semibold mb-1">Voice</label>
						<select
							id="voice-openai-voice"
							value={ttsVoice}
							onChange={(e) => { setTtsVoice(e.target.value); saveVoice({ openai: { ...((voiceSettings?.openai as Record<string, unknown>) || {}), voice: e.target.value } }); }}
							className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5"
						>
							{["alloy", "echo", "fable", "onyx", "nova", "shimmer"].map((v) => (
								<option key={v} value={v}>{v[0].toUpperCase() + v.slice(1)}</option>
							))}
						</select>
					</div>
				)}
				<div className="mb-1">
					<label htmlFor="voice-speed" className="block text-xs font-semibold mb-1">Speaking speed</label>
					<select
						id="voice-speed"
						value={speed}
						onChange={(e) => { setSpeed(Number(e.target.value)); saveVoice({ speed: Number(e.target.value) }); }}
						className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5"
					>
						<option value={75}>Slow — 0.75×</option>
						<option value={100}>Normal — 1×</option>
						<option value={125}>Fast — 1.25×</option>
						<option value={150}>Faster — 1.5×</option>
					</select>
				</div>

				<div className="border-t border-line my-3" />

				<label htmlFor="voice-silence" className="block text-sm font-semibold mb-1">Conversation — pause before sending</label>
				<p className="text-xs text-muted mb-2">
					How long to keep listening after you stop talking. Higher = pause mid-sentence without being cut off.
				</p>
				<div className="flex items-center gap-2 flex-wrap">
					<select
						id="voice-silence"
						value={silenceMs}
						onChange={(e) => { setSilenceMs(Number(e.target.value)); saveVoice({ silenceMs: Number(e.target.value) }); }}
						className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5"
					>
						<option value={800}>Quick — 0.8s pause</option>
						<option value={1500}>Normal — 1.5s pause</option>
						<option value={2500}>Relaxed — 2.5s pause</option>
						<option value={4000}>Patient — 4s pause</option>
					</select>
					{voiceMsg && <span className="text-sm text-muted">{voiceMsg}</span>}
				</div>

				{/* Mic sensitivity — only Whisper (AI) uses the mic-level pause detector. */}
				{sttMode === "openai" && (
					<div className="mt-4">
						<label htmlFor="voice-sensitivity" className="block text-sm font-semibold mb-1">Mic sensitivity</label>
						<p className="text-xs text-muted mb-2">
							If it keeps listening and never sends, your mic is noisy — lower this. If it cuts you off too soon, raise it.
						</p>
						<select
							id="voice-sensitivity"
							value={sensitivity}
							onChange={(e) => { setSensitivity(Number(e.target.value)); saveVoice({ sensitivity: Number(e.target.value) }); }}
							className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5"
						>
							<option value={0.6}>Low — noisy mic / room</option>
							<option value={1}>Normal</option>
							<option value={1.5}>High — quiet mic / soft voice</option>
						</select>
					</div>
				)}

				<div className="border-t border-line my-3" />

				<label htmlFor="voice-language" className="block text-sm font-semibold mb-1">Language</label>
				<p className="text-xs text-muted mb-2">Language for both speech recognition and the spoken voice.</p>
				<select
					id="voice-language"
					value={language}
					onChange={(e) => { setLanguage(e.target.value); saveVoice({ language: e.target.value }); }}
					className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5 mb-1 block w-full sm:w-auto"
				>
					{[["en-US", "English (US)"], ["en-GB", "English (UK)"], ["en-AU", "English (Australia)"], ["es-ES", "Spanish"], ["fr-FR", "French"], ["de-DE", "German"], ["it-IT", "Italian"], ["pt-BR", "Portuguese (Brazil)"], ["hi-IN", "Hindi"], ["zh-CN", "Chinese (Mandarin)"], ["ja-JP", "Japanese"], ["ko-KR", "Korean"]].map(([code, label]) => (
						<option key={code} value={code}>{label}</option>
					))}
				</select>

				<div className="border-t border-line my-3" />

				<div className="block text-sm font-semibold mb-1">Voice commands</div>
				<p className="text-xs text-muted mb-2">
					In hands-free mode, speak a command instead of a message and it acts locally:
				</p>
				<ul className="text-xs text-muted mb-2 space-y-1">
					<li>• <b>"Repeat"</b> (or "say again", "pardon", "what did you say") — re-speaks the agent's last reply.</li>
				</ul>
				<label className="flex items-center gap-2 text-sm cursor-pointer">
					<input
						type="checkbox"
						checked={commandsEnabled}
						onChange={(e) => { setCommandsEnabled(e.target.checked); saveVoice({ commandsEnabled: e.target.checked }); }}
						className="w-4 h-4 accent-accent"
					/>
					Enable voice commands
				</label>
				<p className="text-[0.7rem] text-muted-soft mt-1">Off = a spoken "repeat" is sent as a normal message.</p>
			</div>

			{/* Translation — translated text shown under each assistant reply */}
			<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-1">Translation</h3>
				<p className="text-sm text-muted mb-3">
					Show a translation beneath each of the agent's replies — useful when it chats with you in a language you're learning. The agent stops translating inline; the platform does it instead.
				</p>
				<label className="flex items-center gap-2 text-sm cursor-pointer mb-2">
					<input
						type="checkbox"
						checked={trEnabled}
						onChange={(e) => saveTranslation(e.target.checked, trTarget, trTranslit, trWordTap, trFontSize)}
						className="w-4 h-4 accent-accent"
					/>
					<span className="text-muted">Show translation under replies</span>
				</label>
				{trEnabled && (
					<>
						<label htmlFor="translation-target" className="block text-xs font-semibold mb-1">Translate into</label>
						<select
							id="translation-target"
							value={trTarget}
							onChange={(e) => saveTranslation(true, e.target.value, trTranslit, trWordTap, trFontSize)}
							className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5 mb-2 block w-full sm:w-auto"
						>
							{(trLanguages.length ? trLanguages : [{ name: trTarget, tag: "" }]).map((l) => (
								<option key={l.name} value={l.name}>{l.name}</option>
							))}
						</select>
						<label className="flex items-center gap-2 text-sm cursor-pointer mb-2">
							<input
								type="checkbox"
								checked={trTranslit}
								onChange={(e) => saveTranslation(true, trTarget, e.target.checked, trWordTap, trFontSize)}
								className="w-4 h-4 accent-accent"
							/>
							<span className="text-muted">Also show transliteration (pinyin / romaji / romanization)</span>
						</label>
						<label className="flex items-center gap-2 text-sm cursor-pointer mb-2">
							<input
								type="checkbox"
								checked={trWordTap}
								onChange={(e) => saveTranslation(true, trTarget, trTranslit, e.target.checked, trFontSize)}
								className="w-4 h-4 accent-accent"
							/>
							<span className="text-muted">Tap a word to hear it pronounced (long-press still selects text)</span>
						</label>
						<label htmlFor="translation-text-size" className="block text-xs font-semibold mb-1">Text size</label>
						<select
							id="translation-text-size"
							value={trFontSize}
							onChange={(e) => saveTranslation(true, trTarget, trTranslit, trWordTap, e.target.value)}
							className="text-sm bg-paper border border-line rounded-lg px-3 py-1.5 block w-full sm:w-auto"
						>
							<option value="small">Small</option>
							<option value="medium">Medium</option>
							<option value="large">Large</option>
						</select>
					</>
				)}
				{trMsg && <div className="text-sm text-muted mt-2">{trMsg}</div>}
			</div>

			{/* Danger zone */}
			<div className="bg-panel border border-line rounded-xl p-3 sm:p-4">
				<h3 className="text-base font-bold mb-1 text-red">Danger zone</h3>
				<p className="text-sm text-muted mb-3">
					Stop using this agent. Your data stays unless you clear it above.
				</p>
				<button
					type="button"
					onClick={unsubscribe}
					className="text-xs px-3 py-1.5 rounded-lg border border-red text-red font-bold hover:bg-red/10"
				>
					Unsubscribe from this agent
				</button>
			</div>
		</div>
	);
}
