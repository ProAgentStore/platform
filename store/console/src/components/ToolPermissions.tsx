import { useCallback, useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import LoadFailed from "./LoadFailed";
import McpConnections from "./McpConnections";
import { hasMcpCapability, type McpGrant } from "../lib/mcpConnections";
import type { ConnectorConsentsResponse } from "../lib/types";
import { CONSENT_CONFIRMATION, CONSENT_MODE_OPTIONS, type ConnectorConsentMode, type ConnectorPolicyEntry, consentChip, listedTools, type ToolPolicyEntry, toolScopeSummary, writeConnectors, writeConsentCopy } from "../lib/toolPolicy";

/**
 * "What can this agent actually do?" — the tool switches, the connector write-consent checkboxes
 * and the outbound-MCP grants, which are three views of one allow-list.
 *
 * Extracted from SettingsTab at #305. They belong together because they are read together: a
 * refusal chip on a tool row names a connector, that connector's grant is a checkbox below it, and
 * for MCP the grant is per (server, tool) further down again. Splitting them across the file is how
 * the three drifted — the sentence over the switches counted write tools differently from the
 * checkboxes it pointed at (see `lib/toolPolicy.ts`, where all three now derive from one predicate).
 *
 * Every phrase here comes from that module. What is left is fetching, the two optimistic toggles,
 * and JSX.
 */
export interface ToolPermissionsProps {
	instanceId: string;
}

export default function ToolPermissions({ instanceId }: ToolPermissionsProps) {
	// Tool policy: every registry tool with THIS instance's verdict on it. The answer to "what can
	// this agent actually do", including what it can't and why — an allow-list you can't read is
	// not something you can trust.
	const [toolPolicy, setToolPolicy] = useState<ToolPolicyEntry[]>([]);
	const [toolMsg, setToolMsg] = useState("");
	// Connector write-consent (#90, #722): what the owner has granted each connector, as one of
	// three positions rather than a checkbox. A write tool (e.g. browser_navigate/act) refuses
	// until its connector is granted here — the human gate for an agent acting AS the user — and
	// "Ask each time" is the finer gate: granted, but each individual call waits on the board.
	//
	// A connector ABSENT from this map is off. That keeps one meaning for "no grant" on the client
	// exactly as the server keeps one for "no row", instead of a second way to say no that can
	// drift from the first.
	const [modes, setModes] = useState<Record<string, ConnectorConsentMode>>({});
	const [consentMsg, setConsentMsg] = useState("");
	// Outbound-MCP grants (#262). The connector checkbox cannot name a server — the endpoint is
	// config supplied at call time — so `mcp` write is granted per (server, tool). The panel that
	// edits them is <McpConnections/> (#266); this component only owns the list, because the
	// connector checkboxes above have to reflect what granting a server did.
	const [mcpGrants, setMcpGrants] = useState<McpGrant[]>([]);
	// What each connector's WRITE grant permits, in the owner's terms (#720). A LOOKUP only: the
	// checkbox set below is still `writeConnectors(toolPolicy)`, the server's own tool verdict, so
	// the gate and the UI cannot disagree about which grant a refusal asks for (#351). Read
	// separately from the two above precisely so a failure here costs the sentence and not the
	// control — see the block below on why an absent checkbox is the worst outcome on this panel.
	const [connectorInfo, setConnectorInfo] = useState<ConnectorPolicyEntry[]>([]);
	// Why these two reads are the worst possible place for a silent fallback (#291).
	//
	// Every panel below is GATED on what they return, so a dropped request does not render an
	// empty list — it removes the permission surface altogether. `toolPolicy.length > 0` hides the
	// tool switches, `writeConnectors([])` hides the write-consent checkboxes, and the user is left
	// on a Settings tab that quietly says this agent can do nothing and has been granted nothing.
	// The consent half is the sharper edge: an unchecked box is a claim that the agent CANNOT act
	// as you, and that claim is the whole reason the gate exists (#90).
	//
	// The two stay independent — MCP grants failing must not take the tool switches with them — but
	// they share one notice, because a user meeting two versions of the same sentence learns
	// nothing from the second.
	const [loadErr, setLoadErr] = useState("");

	const load = useCallback(async () => {
		setLoadErr("");
		const fail = (e: unknown) => setLoadErr(e instanceof Error ? e.message : String(e));
		try {
			const [toolsRes, consentRes] = await Promise.all([
				api<{ tools?: ToolPolicyEntry[] }>(`/v1/instances/${instanceId}/tools`),
				api<ConnectorConsentsResponse>(`/v1/instances/${instanceId}/connectors/consent`),
			]);
			setToolPolicy(toolsRes.tools || []);
			setModes(
				Object.fromEntries(
					(consentRes.consents || [])
						.filter((x) => x.scope === "write")
						// A row written before migration 0155, or by a caller that sent no mode, IS
						// `always` — the server defaults the column, and reading it as anything else
						// here would show a gate on the panel that the gate itself does not apply.
						.map((x) => [x.connector, x.mode === "ask" ? "ask" : "always"] as const),
				),
			);
		} catch (e) {
			fail(e);
		}
		try {
			const d = await api<{ grants?: McpGrant[] }>(`/v1/instances/${instanceId}/mcp/consent`);
			setMcpGrants(d.grants || []);
		} catch (e) {
			fail(e);
		}
		try {
			const d = await api<{ connectors?: ConnectorPolicyEntry[] }>(`/v1/instances/${instanceId}/connectors`);
			setConnectorInfo(d.connectors || []);
		} catch (e) {
			fail(e);
		}
	}, [instanceId]);

	useEffect(() => { void load(); }, [load]);

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

	// Set a connector's write-consent mode (optimistic; reverts on failure).
	const setConsentMode = async (connector: string, mode: ConnectorConsentMode | "off") => {
		const before = modes[connector];
		setModes((m) => {
			const next = { ...m };
			if (mode === "off") delete next[connector];
			else next[connector] = mode;
			return next;
		});
		try {
			await api(`/v1/instances/${instanceId}/connectors/${connector}/consent`, { method: "PUT", body: JSON.stringify({ mode }) });
			setConsentMsg(`${connector} write access ${CONSENT_CONFIRMATION[mode]}`);
			setTimeout(() => setConsentMsg(""), 2500);
		} catch (e) {
			setModes((m) => {
				const next = { ...m };
				if (before) next[connector] = before;
				else delete next[connector];
				return next;
			});
			setConsentMsg(e instanceof Error ? e.message : "Failed");
		}
	};

	const listed = listedTools(toolPolicy);
	const connectors = writeConnectors(toolPolicy);

	return (
		<>
			{loadErr && (
				<div className="mb-3">
					<LoadFailed compact what="this agent's permissions" detail={loadErr} onRetry={() => void load()} testId="tool-permissions-load-failed" />
				</div>
			)}
			{/* Tools — the full, honest answer to "what can this agent do?". Shows what it MAY run
			    and what it may not, with the reason, so "read-only" is verifiable rather than
			    asserted. Toggling here changes the agent's real capability: a tool switched off is
			    withheld from its chat AND refused by the API/MCP. */}
			{toolPolicy.length > 0 && (
				<div className="mb-3 pb-3 border-b border-line">
					<div className="text-sm font-semibold mb-0.5">Tools</div>
					<p className="text-2xs text-muted-soft mb-2">
						Everything this agent is allowed to do. Switch any of them off — it applies to the agent's chat, the API and MCP alike.
						{toolScopeSummary(toolPolicy)}
					</p>
					{listed.map((t) => (
						<label key={t.name} className="flex items-start gap-2 text-sm cursor-pointer mb-1.5">
							<input
								type="checkbox"
								checked={t.allowed}
								onChange={(e) => toggleTool(t.name, e.target.checked)}
								className="mt-0.5"
							/>
							<span className="min-w-0">
								<span className="font-mono text-xs font-semibold">{t.name}</span>
								<span className={`ml-1.5 text-2xs uppercase tracking-wide ${t.scope === "write" ? "text-danger" : "text-muted"}`}>{t.scope}</span>
								{t.connector && <span className="ml-1.5 text-2xs text-muted-soft">{t.connector}</span>}
								{t.disabled && <span className="ml-1.5 text-2xs text-muted">— off</span>}
								{consentChip(t) && <span className="ml-1.5 text-2xs text-amber-500">— {consentChip(t)}</span>}
								<span className="block text-2xs text-muted-soft leading-snug">{t.description}</span>
							</span>
						</label>
					))}
					{listed.length === 0 && <p className="text-xs text-muted">This agent declares no tools — it can only talk.</p>}
					{toolMsg && <p className="text-xs text-success mt-1">{toolMsg}</p>}
				</div>
			)}

			{/* Connector write-consent (#90): the human gate for a tool that acts with a credential of
			    yours. Off until you check it. The SET comes from `writeConnectors(toolPolicy)` — the
			    server's own tool verdict — and must keep doing so (#351): re-deriving it from the
			    connectors response would let the gate and the UI disagree about which grant a refusal
			    is asking for. `connectorInfo` is a lookup for the words, never for the membership. */}
			{connectors.length > 0 && (
				<div className="mb-3 pb-3 border-b border-line">
					<div className="text-sm font-semibold mb-0.5">Agent write access</div>
					{/* One paragraph that makes NO per-connector claim (#720). The sentence here used to
					    read "act as you — click, type, and navigate — through the connector on your
					    machine", which was written for `browser` and is exact for it. Measured live over
					    43 instances: this panel rendered on 32, 27 of those showed a checkbox for a
					    connector that is not on the owner's machine (github 23, mcp 3, supervision 1,
					    http 1), and `browser` rendered on none of them. The specific claim now lives on
					    each connector — `Connector.writeMeaning` — which is what stopped a second
					    hardcoded `connectors.includes(...)` branch from being the fix. */}
					<p className="text-2xs text-muted-soft mb-2">
						Each of these lets the agent act with a credential of yours. Off by default; read what each one permits before
						enabling it. <b>Ask each time</b> keeps the grant but holds every individual call on the board until you approve it.
					</p>
					{connectors.map((connector) => {
						const { label, meaning } = writeConsentCopy(connector, connectorInfo);
						const mode: ConnectorConsentMode | "off" = modes[connector] ?? "off";
						return (
							<div key={connector} className="mb-2.5" data-testid={`consent-${connector}`}>
								{/* min-w-0 so a long meaning wraps inside the row instead of widening the
								    card — the same shape the tool rows above use. */}
								<div className="min-w-0 text-sm">
									<span className="font-semibold">{label}</span>
									<span className="text-muted"> — write access</span>
									{meaning && <span className="block text-2xs text-muted-soft leading-snug">{meaning}</span>}
								</div>
								{/* Three radios rather than a select: the positions differ in what they PERMIT,
								    so each one carries its own sentence and all three are readable at once.
								    Collapsed into a dropdown, "Ask each time" is a thing you have to already
								    know exists in order to find it. */}
								<div className="mt-1 flex flex-col gap-0.5">
									{CONSENT_MODE_OPTIONS.map((opt) => (
										<label key={opt.value} className="flex items-start gap-2 text-2xs cursor-pointer">
											<input
												type="radio"
												className="mt-0.5"
												name={`consent-${connector}`}
												checked={mode === opt.value}
												onChange={() => setConsentMode(connector, opt.value)}
											/>
											<span className="min-w-0">
												<span className="font-semibold">{opt.label}</span>
												<span className="text-muted-soft"> — {opt.blurb}</span>
											</span>
										</label>
									))}
								</div>
							</div>
						);
					})}
					{consentMsg && <p className="text-xs text-success mt-1">{consentMsg}</p>}
				</div>
			)}

			{/* Outbound-MCP connections (#262 grants + #266 setup lifecycle). Every other connector IS
			    the remote system, so a connector-level grant names it. An MCP endpoint is config
			    supplied at call time, so reach has to be named per server and per tool — and you can
			    only name a tool you have been shown, which is why this is a discover-then-approve
			    panel rather than two text inputs. Gated on ANY mcp tool, read or write: gating on
			    write hid the panel until the user had already granted a capability they couldn't yet
			    see. */}
			{hasMcpCapability(toolPolicy) && (
				<McpConnections
					instanceId={instanceId}
					grants={mcpGrants}
					onGrantsChanged={(g) => {
						setMcpGrants(g);
						// Granting a server implies the connector-level write gate (the PUT creates it
						// server-side); reflect what actually happened rather than leaving the control
						// above looking off. It only CREATES — an `mcp` grant already set to "Ask each
						// time" keeps that position, so this must not overwrite one either (#722).
						if (g.length) setModes((m) => (m.mcp ? m : { ...m, mcp: "always" }));
					}}
				/>
			)}
		</>
	);
}
