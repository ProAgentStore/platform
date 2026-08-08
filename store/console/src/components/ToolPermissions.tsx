import { useEffect, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import McpConnections from "./McpConnections";
import { hasMcpCapability, type McpGrant } from "../lib/mcpConnections";
import { consentChip, listedTools, type ToolPolicyEntry, toolScopeSummary, writeConnectors } from "../lib/toolPolicy";

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
	// Connector write-consent (#90): which connectors the owner has granted. A write tool (e.g.
	// browser_navigate/act) refuses until its connector is granted here — the human gate for an
	// agent acting AS the user.
	const [granted, setGranted] = useState<string[]>([]);
	const [consentMsg, setConsentMsg] = useState("");
	// Outbound-MCP grants (#262). The connector checkbox cannot name a server — the endpoint is
	// config supplied at call time — so `mcp` write is granted per (server, tool). The panel that
	// edits them is <McpConnections/> (#266); this component only owns the list, because the
	// connector checkboxes above have to reflect what granting a server did.
	const [mcpGrants, setMcpGrants] = useState<McpGrant[]>([]);

	useEffect(() => {
		(async () => {
			try {
				const [toolsRes, consentRes] = await Promise.all([
					api<{ tools?: ToolPolicyEntry[] }>(`/v1/instances/${instanceId}/tools`),
					api<{ consents?: Array<{ connector: string; scope: string }> }>(`/v1/instances/${instanceId}/connectors/consent`),
				]);
				setToolPolicy(toolsRes.tools || []);
				setGranted((consentRes.consents || []).filter((x) => x.scope === "write").map((x) => x.connector));
			} catch {}
			try {
				const d = await api<{ grants?: McpGrant[] }>(`/v1/instances/${instanceId}/mcp/consent`);
				setMcpGrants(d.grants || []);
			} catch {}
		})();
	}, [instanceId]);

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
	const toggleConsent = async (connector: string, enabled: boolean) => {
		setGranted((g) => (enabled ? [...new Set([...g, connector])] : g.filter((c) => c !== connector)));
		try {
			await api(`/v1/instances/${instanceId}/connectors/${connector}/consent`, { method: "PUT", body: JSON.stringify({ enabled }) });
			setConsentMsg(`${connector} write access ${enabled ? "granted" : "revoked"}`);
			setTimeout(() => setConsentMsg(""), 2500);
		} catch (e) {
			setGranted((g) => (enabled ? g.filter((c) => c !== connector) : [...new Set([...g, connector])]));
			setConsentMsg(e instanceof Error ? e.message : "Failed");
		}
	};

	const listed = listedTools(toolPolicy);
	const connectors = writeConnectors(toolPolicy);

	return (
		<>
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

			{/* Connector write-consent (#90): the human gate for tools that act AS you (e.g. the
			    browser agent's navigate/click/type). Off until you check it. */}
			{connectors.length > 0 && (
				<div className="mb-3 pb-3 border-b border-line">
					<div className="text-sm font-semibold mb-0.5">Agent write access</div>
					<p className="text-2xs text-muted-soft mb-2">
						Lets this agent act as you — click, type, and navigate — through the connector on your machine. Off by default; enable only what you want it to do.
					</p>
					{connectors.map((connector) => (
						<label key={connector} className="flex items-center gap-2 text-sm cursor-pointer mb-1.5">
							<input
								type="checkbox"
								checked={granted.includes(connector)}
								onChange={(e) => toggleConsent(connector, e.target.checked)}
							/>
							<span className="capitalize font-semibold">{connector}</span>
							<span className="text-muted">write access</span>
						</label>
					))}
					{consentMsg && <p className="text-xs text-success mt-1">{consentMsg}</p>}
					{connectors.includes("mcp") && (
						<p className="text-2xs text-muted-soft mt-1.5">
							MCP write access is a kill switch, not a permission: the agent still can’t call anything until you name a server and tool below.
						</p>
					)}
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
						// Granting a server implies the connector-level write gate (the PUT sets it
						// server-side); reflect what actually happened rather than leaving the checkbox
						// above looking off.
						if (g.length) setGranted((c) => [...new Set([...c, "mcp"])]);
					}}
				/>
			)}
		</>
	);
}
