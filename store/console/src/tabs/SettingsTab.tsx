import { useState, useEffect, useCallback, useId } from "react";
import PrefOverride from "../components/PrefOverride";
import VoiceFields from "../components/VoiceFields";
import TranslationFields from "../components/TranslationFields";
import { api } from "@proagentstore/sdk/client";
import { invalidateVoiceConfig } from "@proagentstore/sdk/hooks";
import type { SettingsField } from "../lib/types";
import TeamworkSection from "./TeamworkSection";
import LoopPresetsSection from "./LoopPresetsSection";
import LoopRunsSection from "./LoopRunsSection";
import TriggersSection from "./TriggersSection";
import McpConnections from "../components/McpConnections";
import { hasMcpCapability, type McpGrant } from "../lib/mcpConnections";

/** Shape of the runner-node endpoint (per-instance `connected` + machine-level `nodeOnline`). */
type RunnerNodeResp = { runnerNode: string | null; nodes: string[]; nodesDetail?: Array<{ node: string; connected: boolean; nodeOnline?: boolean }> };

/** One of the user's machines (from /v1/terminals/nodes) — used to render the "Runs on" tiles. */
type Machine = {
	node: string;
	placement?: string;
	runnerVersion?: string;
	lastSeenAt?: string | null;
	connected: boolean;
	instances?: Array<{ instanceId: string; connected: boolean; bound?: boolean }>;
};

/** Compact relative time for a machine's last-seen. */
function agoShort(iso?: string | null): string {
	if (!iso) return "never";
	const t = Date.parse(iso.includes("T") ? iso : `${iso.replace(" ", "T")}Z`);
	if (Number.isNaN(t)) return "";
	const s = Math.max(0, Math.round((Date.now() - t) / 1000));
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86400) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86400)}d ago`;
}

interface Props {
	instanceId: string;
	isApply: boolean;
	/** The agent's declared subscriber settings (from capabilities). */
	settingsSchema?: SettingsField[];
	onUnsubscribe: () => void;
}

/** One registry tool + this instance's verdict on it (GET /v1/instances/:id/tools). */
interface ToolPolicyEntry {
	name: string;
	connector?: string;
	scope: "read" | "write";
	description: string;
	allowed: boolean;
	disabled: boolean;
	reason: "ok" | "not_declared" | "disabled_by_owner";
}

interface ConnectorGrant {
	id: string;
	provider: "google_drive" | "zoho_workdrive";
	resourceId: string;
	resourceName: string;
	resourceType: string;
	resourceUrl?: string | null;
}

export default function SettingsTab({ instanceId, isApply, settingsSchema, onUnsubscribe }: Props) {
	const runsOnLabelId = useId();
	const [maintMsg, setMaintMsg] = useState("");
	// Agent-declared settings: the schema prop is the fast path; the GET also returns
	// `fields` so the form never depends on a stale instance-list cache.
	const [agentFields, setAgentFields] = useState<SettingsField[]>(settingsSchema ?? []);
	const [agentSettings, setAgentSettings] = useState<Record<string, string | number | boolean>>({});
	const [settingsMsg, setSettingsMsg] = useState("");
	const [runtimeInfo, setRuntimeInfo] = useState<Record<string, unknown> | null>(null);
	// Node binding: which machine this instance runs on ("" = automatic).
	const [runnerNode, setRunnerNode] = useState("");
	const [runnerNodesDetail, setRunnerNodesDetail] = useState<Array<{ node: string; connected: boolean; nodeOnline?: boolean }>>([]);
	const [runnerNodeMsg, setRunnerNodeMsg] = useState("");
	const [runnerRefreshing, setRunnerRefreshing] = useState(false);
	const [machines, setMachines] = useState<Machine[]>([]);
	// Does this agent use a local runtime (browser/coding)? Only then is the Runner panel
	// relevant. Default true (show) until we learn it's cloud-only, so it never flickers off
	// for a runner agent. Set from capabilities.runtime.
	const [agentNeedsRunner, setAgentNeedsRunner] = useState(true);
	// Connector write-consent (#90): connectors this agent's tools can WRITE with, and
	// which the owner has granted. A write tool (e.g. browser_navigate/act) refuses until
	// its connector is granted here — the human gate for an agent acting AS the user.
	const [writeConnectors, setWriteConnectors] = useState<string[]>([]);
	const [grantedConnectors, setGrantedConnectors] = useState<string[]>([]);
	const [consentMsg, setConsentMsg] = useState("");
	// Outbound-MCP grants (#262). The connector checkbox above cannot name a server — the
	// endpoint is config supplied at call time — so `mcp` write is granted per (server, tool).
	// The panel that edits them lives in <McpConnections/> (#266); this component only owns the
	// list, because the connector checkboxes above have to reflect what granting a server did.
	const [mcpGrants, setMcpGrants] = useState<McpGrant[]>([]);
	// Tool policy: every registry tool with THIS instance's verdict on it. The answer to
	// "what can this agent actually do", including what it can't and why — an allow-list you
	// can't read is not something you can trust.
	const [toolPolicy, setToolPolicy] = useState<ToolPolicyEntry[]>([]);
	const [toolMsg, setToolMsg] = useState("");

	// Switch one tool off/on for this instance (optimistic; reverts on failure).
	const toggleTool = async (name: string, enabled: boolean) => {
		setToolPolicy((p) => p.map((t) => (t.name === name ? { ...t, allowed: enabled, disabled: !enabled, reason: enabled ? "ok" : "disabled_by_owner" } : t)));
		try {
			await api(`/v1/instances/${instanceId}/tools/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ enabled }) });
			setToolMsg(`${name} ${enabled ? "enabled" : "switched off"}`);
			setTimeout(() => setToolMsg(""), 2500);
		} catch (e) {
			setToolPolicy((p) => p.map((t) => (t.name === name ? { ...t, allowed: !enabled, disabled: enabled, reason: enabled ? "disabled_by_owner" : "ok" } : t)));
			setToolMsg(e instanceof Error ? e.message : "Could not change that tool");
		}
	};

	// Toggle a connector's write consent (optimistic; reverts on failure).
	const toggleConnectorConsent = async (connector: string, enabled: boolean) => {
		setGrantedConnectors((g) => (enabled ? [...new Set([...g, connector])] : g.filter((c) => c !== connector)));
		try {
			await api(`/v1/instances/${instanceId}/connectors/${connector}/consent`, { method: "PUT", body: JSON.stringify({ enabled }) });
			setConsentMsg(`${connector} write access ${enabled ? "granted" : "revoked"}`);
			setTimeout(() => setConsentMsg(""), 2500);
		} catch (e) {
			setGrantedConnectors((g) => (enabled ? g.filter((c) => c !== connector) : [...new Set([...g, connector])]));
			setConsentMsg(e instanceof Error ? e.message : "Failed");
		}
	};

	// Re-check the runner (live RelayDO truth) on demand — used by the Refresh button and
	// the tab-focus re-check, so a just-started/stopped `pags up` reflects without a reload.
	// Also pulls the full machine list (all your `pags up` nodes) for the "Runs on" tiles.
	const refreshRunner = useCallback(async () => {
		setRunnerRefreshing(true);
		try {
			const [st, rn, tn] = await Promise.all([
				api<Record<string, unknown>>(`/v1/instances/${instanceId}/runtime/status`).catch(() => null),
				api<RunnerNodeResp>(`/v1/instances/${instanceId}/runner-node`).catch(() => null),
				api<{ nodes: Machine[] }>(`/v1/terminals/nodes`).catch(() => null),
			]);
			if (st) setRuntimeInfo(st);
			if (rn) { setRunnerNode(rn.runnerNode || ""); setRunnerNodesDetail(rn.nodesDetail || []); }
			if (tn) setMachines(tn.nodes || []);
		} finally { setRunnerRefreshing(false); }
	}, [instanceId]);

	// The pinned machine's live state: `nodeOnline` = the machine runs a runner for ANY of
	// your agents (Terminals' node-level truth), even if THIS agent isn't attached to it.
	const pinnedDetail = runnerNodesDetail.find((d) => d.node === runnerNode);
	const pinnedNodeOnline = pinnedDetail?.nodeOnline === true;
	// Is THIS agent's runner live? /runtime/status carries it at relay.connected (there is
	// no top-level `connected`), and the machine name at relay.runnerNode — reading the wrong
	// (top-level) keys made the panel read "Offline" permanently. `connected` on the pinned
	// node's detail is the same RelayDO truth, used as a fallback when the probe hasn't loaded.
	const relayInfo = (runtimeInfo as { relay?: { connected?: boolean; runnerNode?: string | null } } | null)?.relay;
	// Why it isn't attached, computed server-side (#237). The panel used to show only an amber
	// "agent not attached", which is a symptom with no cause and no remedy — the CLI knew both
	// and printed them to a terminal nobody was watching.
	const attachment = (runtimeInfo as { attachment?: { state?: string; message?: string; remedy?: string | null } } | null)?.attachment;
	const agentOnline = relayInfo?.connected === true || pinnedDetail?.connected === true;
	const agentNode = relayInfo?.runnerNode || runnerNode || "";
	// The machines to render as "Runs on" tiles: all your `pags up` nodes, plus the pinned
	// one if it's dropped off the live list (so you always see what this agent is bound to).
	const machinesToShow: Machine[] = runnerNode && !machines.some((m) => m.node === runnerNode)
		? [{ node: runnerNode, connected: false, instances: [] }, ...machines]
		: machines;
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
	// Account-level GitHub identity link (for Coder build status / repo access). Google
	// sign-in leaves github_login = your email, which can't authorize the GitHub App —
	// linking records your real GitHub username without switching accounts.
	const [githubLinked, setGithubLinked] = useState<string | null>(null);
	const [githubMsg, setGithubMsg] = useState("");
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
	// Triggers moved to <TriggersSection/> (#16/#18/#19) — it owns its own state and loading.

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
				const d = await api<RunnerNodeResp>(`/v1/instances/${instanceId}/runner-node`);
				setRunnerNode(d.runnerNode || "");
				setRunnerNodesDetail(d.nodesDetail || []);
			} catch {}
			try {
				const d = await api<{ nodes: Machine[] }>(`/v1/terminals/nodes`);
				setMachines(d.nodes || []);
			} catch {}
			try {
				// Which connectors can this agent WRITE with, and what's already granted?
				// writeConnectors = the agent's declared tools ∩ the registry's write tools.
				const [inst, toolsRes, consentRes] = await Promise.all([
					api<{ instances?: Array<{ id: string; capabilities?: { tools?: string[]; runtime?: string | null } }> }>("/v1/instances/my/instances"),
					api<{ tools?: ToolPolicyEntry[] }>(`/v1/instances/${instanceId}/tools`),
					api<{ consents?: Array<{ connector: string; scope: string }> }>(`/v1/instances/${instanceId}/connectors/consent`),
				]);
				const mine = (inst.instances || []).find((i) => i.id === instanceId);
				setAgentNeedsRunner(mine?.capabilities?.runtime != null);
				const policy = toolsRes.tools || [];
				setToolPolicy(policy);
				// Which connectors can this agent WRITE with? Read off the server's verdict rather
				// than re-deriving it client-side — the gate and the UI must not be able to disagree.
				const writeConns = new Set<string>();
				for (const t of policy) if (t.scope === "write" && t.connector && (t.allowed || t.disabled)) writeConns.add(t.connector);
				setWriteConnectors([...writeConns]);
				setGrantedConnectors((consentRes.consents || []).filter((x) => x.scope === "write").map((x) => x.connector));
			} catch {}
			try {
				const d = await api<{ grants?: McpGrant[] }>(`/v1/instances/${instanceId}/mcp/consent`);
				setMcpGrants(d.grants || []);
			} catch {}
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
			} catch {}
			try {
				const d = await api<{ voiceSettings?: Record<string, unknown>; hasOverride?: boolean }>(`/v1/instances/${instanceId}/voice-settings`);
				const vs = d.voiceSettings || {};
				setVoiceSettings(vs);
				setVoiceOverride(d.hasOverride === true);
				// No per-field unpacking here any more: VoiceFields seeds itself from `value`, so
				// this component only has to know WHICH object to hand it and whether it is an
				// override. That is the whole benefit of sharing the controls with Preferences.
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
			refreshRunner();
		};
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [instanceId, refreshRunner]);

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

	/** "Use my defaults" — DELETE the override and repaint from what the account resolves to. */
	const clearVoiceOverride = async () => {
		const d = await api<{ voiceSettings?: Record<string, unknown> }>(`/v1/instances/${instanceId}/voice-settings`, { method: "DELETE" })
			.catch(() => null);
		setVoiceOverride(false);
		if (d?.voiceSettings) setVoiceSettings(d.voiceSettings);
		invalidateVoiceConfig(); // same reason as saveVoice: the cached config just became wrong
	};

	/** A one-line "what am I actually getting" for the radio, so the choice is informed. */
	const voiceSummary = (() => {
		const vs = voiceSettings || {};
		const stt = vs.sttMode === "openai" ? "Whisper" : "Dictation";
		const tts = typeof vs.provider === "string" && vs.provider.includes("openai") ? "OpenAI voice" : "Browser voice";
		const spd = typeof vs.speed === "number" ? `${(vs.speed / 100).toFixed(2).replace(/0$/, "")}×` : "1×";
		return `${stt} · ${tts} · ${spd}`;
	})();

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
		).catch(() => null);
		setTrOverride(false);
		if (d?.translation) {
			setTrEnabled(d.translation.enabled === true);
			setTrTarget(d.translation.target || "English");
			setTrTranslit(d.translation.transliterate === true);
			setTrWordTap(d.translation.wordTap !== false);
			setTrFontSize(d.translation.fontSize || "medium");
		}
	};

	// Link a real GitHub username to this account (account-level). Full-page redirect
	// (not a popup) — the callback sets linked_github_login then bounces back with
	// ?github_linked=<login>, which the effect below reads.
	const connectGithub = async () => {
		try {
			const returnTo = window.location.origin + window.location.pathname;
			const { url } = await api<{ url: string }>(`/v1/auth/github/link/start?return_to=${encodeURIComponent(returnTo)}`);
			window.location.href = url;
		} catch (e) {
			alert(e instanceof Error ? e.message : "Couldn't start GitHub link");
		}
	};

	// Load the current GitHub link state, and surface the link-callback's return param.
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const justLinked = params.get("github_linked");
		if (justLinked) {
			setGithubLinked(justLinked);
			const bound = params.get("github_bound");
			if (bound) setGithubMsg(`Connected as ${justLinked} — ${bound} org${bound === "1" ? "" : "s"} linked. Build status will show for their repos.`);
			params.delete("github_linked");
			params.delete("github_bound");
			const q = params.toString();
			window.history.replaceState({}, "", window.location.pathname + (q ? `?${q}` : ""));
		}
		api<{ githubLinked?: string | null }>("/v1/auth/me").then((d) => setGithubLinked(d.githubLinked ?? null)).catch(() => {});
	}, []);

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
		// min-w-0 lets this shrink inside the flex scroll wrapper; overflow-x-hidden is a
		// hard guard so no rigid-width descendant can ever make the whole page scroll
		// sideways (the cards are all w-full, so one over-wide child would clip them all).
		<div className="min-w-0 overflow-x-hidden">
			{/* Instance name — distinguishes multiple instances of the same agent */}
			<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4">
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

			{/* Runner info — only for agents that use a local runtime (browser/coding).
			    Cloud-only agents (runtime:null) show a one-line note instead of the panel. */}
			{agentNeedsRunner ? (
			<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4">
				<div className="flex items-center justify-between gap-2 mb-1">
					<h3 className="text-base font-bold">Runner</h3>
					<button type="button" onClick={refreshRunner} disabled={runnerRefreshing} className="text-xs px-2.5 py-1 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-semibold disabled:opacity-50">{runnerRefreshing ? "Refreshing…" : "Refresh"}</button>
				</div>
				<div className="text-sm text-muted leading-relaxed">
					{runtimeInfo ? (
						<>
							Status: <span className={agentOnline ? "text-green" : ""}>{agentOnline ? "Online" : "Offline"}</span>
							{/* Agent's own socket down while the machine is up for OTHER agents. */}
							{!agentOnline && pinnedNodeOnline && <span className="text-amber-500"> · machine online, agent not attached</span>}
							{agentNode && <> · Node: {agentNode}</>}
							{/* The cause + the one command that fixes it. `pags up` is the WRONG advice when
							    the machine is already running, which is exactly the confusing case. */}
							{!agentOnline && attachment?.message && (
								<div className="mt-1 text-[0.8rem] text-muted-soft">
									{attachment.message}
									{attachment.remedy && (
										<> Run <code className="px-1 py-0.5 rounded bg-paper border border-line font-mono text-[0.75rem]">{attachment.remedy}</code>.</>
									)}
								</div>
							)}
						</>
					) : (
						"Checking runner status..."
					)}
				</div>

				{/* Node binding — ONE machine per agent (no auto-any). A tile per machine you run
				    `pags up` on; click one to bind this agent there. */}
				{/* This <label> named nothing — what it labels is the GRID of machine tiles, and a
				    label can only name one form control. A named group announces the same thing. */}
				{/* biome-ignore lint/a11y/useSemanticElements: a <fieldset> renders its <legend> inside its own top border, and the only border here IS a top rule — role="group" carries the same semantics without cutting the rule in half. */}
				<div className="mt-3 pt-3 border-t border-line/60" role="group" aria-labelledby={runsOnLabelId}>
					<div id={runsOnLabelId} className="block text-sm font-semibold mb-1">Runs on</div>
					<p className="text-xs text-muted-soft mb-2">
						Bind this agent to exactly one machine running <code className="text-accent">pags up</code> — its runner tasks (chat tools, apply, coding) route there.
					</p>
					{machinesToShow.length === 0 ? (
						<div className="text-xs text-muted px-3 py-3 border border-dashed border-line rounded-lg">
							No machines connected yet. Run <code className="text-accent">pags up</code> on a machine — it appears here and on the <span className="text-accent">Terminals</span> page.
						</div>
					) : (
						<div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
							{machinesToShow.map((m) => {
								const attached = (m.instances || []).some((i) => i.instanceId === instanceId && i.connected);
								const machineOnline = m.connected;
								const pinned = runnerNode === m.node;
								const tone = attached ? "green" : machineOnline ? "amber" : "off";
								const statusText = attached ? "Attached · online" : machineOnline ? "Online · agent not attached" : "Offline";
								return (
									<button
										key={m.node}
										type="button"
										onClick={() => saveRunnerNode(m.node)}
										aria-pressed={pinned}
										title={pinned ? "This agent is bound to this machine" : "Bind this agent to this machine"}
										className={`text-left rounded-xl border p-3 transition-colors ${pinned ? "border-accent bg-accent/10" : "border-line bg-paper hover:border-accent/60"}`}
									>
										<div className="flex items-center gap-2 min-w-0">
											<span className={`w-2.5 h-2.5 rounded-full shrink-0 ${tone === "green" ? "bg-green" : tone === "amber" ? "bg-amber-500" : "bg-muted-soft"}`} />
											<span className="font-semibold text-sm truncate">{m.node}</span>
											{pinned && <span className="ml-auto shrink-0 text-[0.6rem] font-bold uppercase tracking-wide text-accent border border-accent/40 rounded px-1.5 py-0.5">Pinned</span>}
										</div>
										<div className={`text-[0.7rem] mt-1 ${tone === "green" ? "text-green" : tone === "amber" ? "text-amber-500" : "text-muted-soft"}`}>{statusText}</div>
										<div className="text-[0.7rem] text-muted-soft mt-0.5">
											{m.placement === "managed" ? "cloud" : "local"}{m.runnerVersion ? ` · v${m.runnerVersion}` : ""} · seen {agoShort(m.lastSeenAt)}
										</div>
									</button>
								);
							})}
						</div>
					)}
					{/* Pinned machine not serving THIS agent → guidance (machine-online vs fully-offline). */}
					{runnerNode && pinnedDetail && !pinnedDetail.connected && (
						pinnedNodeOnline ? (
							<p className="text-xs text-amber-500 mt-2">
								⚠ <b>{runnerNode}</b> is online, but this agent isn't attached to it yet. Restart <code className="text-accent">pags up</code> on it (it attaches newly-subscribed agents on start).
							</p>
						) : (
							<p className="text-xs text-amber-500 mt-2">
								⚠ <b>{runnerNode}</b> isn't connected. This agent's runner tasks won't run until you start <code className="text-accent">pags up</code> on it, or pick another machine.
							</p>
						)
					)}
					{!runnerNode && machinesToShow.length > 0 && <p className="text-xs text-amber-500 mt-2">Pick a machine above to run this agent on.</p>}
					{runnerNodeMsg && <p className="text-xs text-muted mt-1">{runnerNodeMsg}</p>}
				</div>
			</div>
			) : (
				<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4 text-sm text-muted">
					<h3 className="text-base font-bold mb-1">Runner</h3>
					This agent runs entirely in the cloud — no local runner (<code className="text-accent">pags up</code>) needed.
				</div>
			)}

			{/* Where things live */}
			<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-1">Where things live</h3>
				<ul className="text-sm text-muted leading-relaxed pl-4 list-disc">
					{isApply && <li><b>Resume</b> & documents → Knowledge → Documents</li>}
					{isApply && <li><b>Job application details</b> & preferences → Profile</li>}
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

				{/* Tools — the full, honest answer to "what can this agent do?". Shows what it
				    MAY run and what it may not, with the reason, so "read-only" is verifiable
				    rather than asserted. Toggling here changes the agent's real capability:
				    a tool switched off is withheld from its chat AND refused by the API/MCP. */}
				{toolPolicy.length > 0 && (
					<div className="mb-3 pb-3 border-b border-line">
						<div className="text-sm font-semibold mb-0.5">Tools</div>
						<p className="text-[0.7rem] text-muted-soft mb-2">
							Everything this agent is allowed to do. Switch any of them off — it applies to the agent's chat, the API and MCP alike.
							{toolPolicy.some((t) => t.allowed && t.scope === "write")
								? " This agent has write tools; each one also needs its connector granted below."
								: " This agent has no write tools — it can only read."}
						</p>
						{toolPolicy
							.filter((t) => t.allowed || t.disabled)
							.map((t) => (
								<label key={t.name} className="flex items-start gap-2 text-sm cursor-pointer mb-1.5">
									<input
										type="checkbox"
										checked={t.allowed}
										onChange={(e) => toggleTool(t.name, e.target.checked)}
										className="w-4 h-4 accent-accent mt-0.5"
									/>
									<span className="min-w-0">
										<span className="font-mono text-[0.78rem] font-semibold">{t.name}</span>
										<span
											className={`ml-1.5 text-[0.62rem] uppercase tracking-wide ${t.scope === "write" ? "text-red" : "text-muted"}`}
										>
											{t.scope}
										</span>
										{t.connector && <span className="ml-1.5 text-[0.68rem] text-muted-soft">{t.connector}</span>}
										{t.disabled && <span className="ml-1.5 text-[0.68rem] text-muted">— off</span>}
										<span className="block text-[0.68rem] text-muted-soft leading-snug">{t.description}</span>
									</span>
								</label>
							))}
						{toolPolicy.every((t) => !t.allowed && !t.disabled) && (
							<p className="text-xs text-muted">This agent declares no tools — it can only talk.</p>
						)}
						{toolMsg && <p className="text-xs text-green mt-1">{toolMsg}</p>}
					</div>
				)}

				{/* Connector write-consent (#90): the human gate for tools that act AS you
				    (e.g. the browser agent's navigate/click/type). Off until you check it. */}
				{writeConnectors.length > 0 && (
					<div className="mb-3 pb-3 border-b border-line">
						<div className="text-sm font-semibold mb-0.5">Agent write access</div>
						<p className="text-[0.7rem] text-muted-soft mb-2">
							Lets this agent act as you — click, type, and navigate — through the connector on your machine. Off by default; enable only what you want it to do.
						</p>
						{writeConnectors.map((connector) => (
							<label key={connector} className="flex items-center gap-2 text-sm cursor-pointer mb-1.5">
								<input
									type="checkbox"
									checked={grantedConnectors.includes(connector)}
									onChange={(e) => toggleConnectorConsent(connector, e.target.checked)}
									className="w-4 h-4 accent-accent"
								/>
								<span className="capitalize font-semibold">{connector}</span>
								<span className="text-muted">write access</span>
							</label>
						))}
						{consentMsg && <p className="text-xs text-green mt-1">{consentMsg}</p>}
						{writeConnectors.includes("mcp") && (
							<p className="text-[0.7rem] text-muted-soft mt-1.5">
								MCP write access is a kill switch, not a permission: the agent still can’t call anything until you name a server and tool below.
							</p>
						)}
					</div>
				)}

				{/* Outbound-MCP connections (#262 grants + #266 setup lifecycle). Every other
				    connector IS the remote system, so a connector-level grant names it. An MCP
				    endpoint is config supplied at call time, so reach has to be named per server
				    and per tool — and you can only name a tool you have been shown, which is why
				    this is a discover-then-approve panel rather than two text inputs.
				    Gated on ANY mcp tool, read or write: gating on write hid the panel until the
				    user had already granted a capability they couldn't yet see. */}
				{hasMcpCapability(toolPolicy) && (
					<McpConnections
						instanceId={instanceId}
						grants={mcpGrants}
						onGrantsChanged={(g) => {
							setMcpGrants(g);
							// Granting a server implies the connector-level write gate (the PUT sets it
							// server-side); reflect what actually happened rather than leaving the
							// checkbox above looking off.
							if (g.length) setGrantedConnectors((c) => [...new Set([...c, "mcp"])]);
						}}
					/>
				)}

				{emailStatus && !emailStatus.configured && (
					<p className="text-xs text-red mb-2">Email connection isn’t configured on this deployment yet.</p>
				)}
				{driveStatus && !driveStatus.configured && (
					<p className="text-xs text-red mb-2">Google Drive connection isn’t configured on this deployment yet.</p>
				)}
				{workdriveStatus && !workdriveStatus.configured && (
					<p className="text-xs text-red mb-2">Zoho WorkDrive connection isn’t configured on this deployment yet.</p>
				)}

				{/* GitHub identity — account-level. Needed for Coder build status + repo access
				    (esp. if you signed in with Google, whose github_login is your email). */}
				<div className="flex items-start justify-between gap-3 mb-3">
					<div className="text-sm min-w-0">
						<span className="font-semibold">GitHub</span>{" "}
						{githubLinked
							? <span className="text-green">· connected as {githubLinked}</span>
							: <span className="text-muted">· not connected</span>}
						<p className="text-[0.7rem] text-muted-soft mt-0.5">Links your GitHub username so the Coder can show build status and reach your repos. Account-level — applies to all your agents.</p>
					</div>
					<button type="button" onClick={connectGithub} className="text-xs px-3 py-1.5 rounded-lg border border-line text-muted hover:border-accent hover:text-accent font-bold shrink-0">
						{githubLinked ? "Reconnect" : "Connect GitHub"}
					</button>
				</div>
				{githubMsg && <p className="text-xs text-green mb-3 -mt-1">{githubMsg}</p>}

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
								aria-label="Google Drive folder to grant this agent"
								placeholder="Google Drive folder URL or ID"
								className="flex-1 min-w-0 sm:min-w-[14rem] bg-paper border border-line rounded-lg px-3 py-2 text-sm"
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
								aria-label="Zoho WorkDrive folder to grant this agent"
								placeholder="Zoho WorkDrive folder URL or ID"
								className="flex-1 min-w-0 sm:min-w-[14rem] bg-paper border border-line rounded-lg px-3 py-2 text-sm"
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
			<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4">
				<h3 className="text-base font-bold mb-2">Voice</h3>
				<PrefOverride
					label="voice settings"
					// `voiceSettings` is null until the GET lands. Without this the radios are live
					// while the real value is still in flight, and the response overwrites the click.
					loaded={voiceSettings !== null}
					hasOverride={voiceOverride}
					summary={voiceSummary}
					onUseDefaults={clearVoiceOverride}
					onCustomise={() => setVoiceOverride(true)}
				/>
				{/* `voiceSettings || {}` — NOT `&& voiceSettings`. Gating on the fetched object means a
				    failed or slow GET silently disables the customise UI with no explanation; the
				    fields seed themselves from platform defaults instead, which is always editable. */}
				{voiceOverride && (
					<VoiceFields value={voiceSettings || {}} onPatch={saveVoice} hasOpenAiKey={hasOpenAiKey} />
				)}
			</div>

			{/* Translation — same override contract as Voice. */}
			<div className="bg-panel border border-line rounded-xl p-3 sm:p-4 mb-3 sm:mb-4">
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
