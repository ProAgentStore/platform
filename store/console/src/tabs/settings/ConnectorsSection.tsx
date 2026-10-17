import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import ToolPermissions from "../../components/ToolPermissions";
import AgentAccountChoice from "../../components/AgentAccountChoice";
import { DiscordConnectorPanel, type DiscordConnectorGrant } from "../../components/DiscordConnectorPanel";
import { FileConnectorPanel } from "../../components/FileConnectorPanel";
import { showsConnector, showsFileConnector, type ConnectorReach, type InstanceConnectorPolicy } from "../../lib/connectorState";
import type { InstancePermissionRequest, InstancePermissionRequestDecisionResponse, InstancePermissionRequestResponse } from "../../lib/types";
import Card from "../../components/Card";
import { permissionCardActions, permissionCardExpiry, permissionCardInstanceLabel } from "../../lib/permissionCard";

interface ConnectorGrant {
	id: string;
	provider: "google_drive" | "zoho_workdrive" | "discord";
	resourceId: string;
	resourceName: string;
	resourceType: string;
	resourceUrl?: string | null;
}

export interface DriveStatus {
	connected: boolean;
	configured: boolean;
	email?: string | null;
	reach?: ConnectorReach;
}

export interface WorkdriveStatus {
	connected: boolean;
	configured: boolean;
	account?: string | null;
	reach?: ConnectorReach;
}

interface Props {
	instanceId: string;
	/** Named on the permission card the push focuses (#1009). */
	instanceName?: string;
	permissionRequestId?: string | null;
	emailStatus: { connected: boolean; configured: boolean; email?: string | null } | null;
	emailPermission: boolean | null;
	emailMsg: string;
	driveStatus: DriveStatus | null;
	driveMsg: string;
	driveGrantRef: string;
	driveGrants: ConnectorGrant[];
	workdriveStatus: WorkdriveStatus | null;
	workdriveMsg: string;
	workdriveGrantRef: string;
	workdriveGrants: ConnectorGrant[];
	discordGrants: DiscordConnectorGrant[];
	discordMsg: string;
	connectorPolicy: InstanceConnectorPolicy[] | null;
	onEmailPermissionChange: (on: boolean) => Promise<void>;
	onDriveGrantRefChange: (value: string) => void;
	onAddDriveGrant: () => Promise<void>;
	onRemoveDriveGrant: (grant: ConnectorGrant) => Promise<void>;
	onWorkdriveGrantRefChange: (value: string) => void;
	onAddWorkdriveGrant: () => Promise<void>;
	onRemoveWorkdriveGrant: (grant: ConnectorGrant) => Promise<void>;
	onAddDiscordGrant: (channelId: string) => Promise<void>;
	onRemoveDiscordGrant: (grant: DiscordConnectorGrant) => Promise<void>;
}

export default function ConnectorsSection({
	instanceId,
	instanceName,
	permissionRequestId,
	emailStatus,
	emailPermission,
	emailMsg,
	driveStatus,
	driveMsg,
	driveGrantRef,
	driveGrants,
	workdriveStatus,
	workdriveMsg,
	workdriveGrantRef,
	workdriveGrants,
	discordGrants,
	discordMsg,
	connectorPolicy,
	onEmailPermissionChange,
	onDriveGrantRefChange,
	onAddDriveGrant,
	onRemoveDriveGrant,
	onWorkdriveGrantRefChange,
	onAddWorkdriveGrant,
	onRemoveWorkdriveGrant,
	onAddDiscordGrant,
	onRemoveDiscordGrant,
}: Props) {
	const focusRef = useRef<HTMLDivElement>(null);
	const [request, setRequest] = useState<InstancePermissionRequest | null>(null);
	const [requestMsg, setRequestMsg] = useState("");
	const [now, setNow] = useState(() => Date.now());
	const expiry = request ? permissionCardExpiry(request, now) : null;
	const choices = request ? permissionCardActions(request) : null;
	// Keep the time left current while a request waits, so it turns expired on screen at its deadline.
	const waiting = request?.status === "pending" && expiry?.expired === false;
	useEffect(() => {
		if (!waiting) return;
		const t = setInterval(() => setNow(Date.now()), 15_000);
		return () => clearInterval(t);
	}, [waiting]);
	useEffect(() => {
		if (!permissionRequestId) return;
		focusRef.current?.scrollIntoView({ block: "center" }); focusRef.current?.focus();
		api<InstancePermissionRequestResponse>(`/v1/instances/${instanceId}/permission-requests/${encodeURIComponent(permissionRequestId)}`).then((d) => setRequest(d.request)).catch((e) => setRequestMsg(e instanceof Error ? e.message : "This permission request is no longer available."));
	}, [instanceId, permissionRequestId]);
	const decide = async (decision: "approve" | "deny", mode?: "always" | "ask") => {
		if (!request) return; setRequestMsg("");
		try { const d = await api<InstancePermissionRequestDecisionResponse>(`/v1/instances/${instanceId}/permission-requests/${request.id}/${decision}`, { method:"POST", body: JSON.stringify(mode ? { mode } : {}) }); setRequest({ ...request, status:d.status }); setRequestMsg(decision === "approve" ? permissionCardActions(request).approved : "Permission request denied; nothing was run."); }
		catch (e) { setRequestMsg(e instanceof Error ? e.message : "Could not update permission request"); }
	};
	const showsEmail = useMemo(() => showsConnector(emailStatus), [emailStatus]);
	const showsDrive = useMemo(
		() => showsFileConnector(driveStatus, connectorPolicy, "google_drive"),
		[driveStatus, connectorPolicy],
	);
	const showsWorkdrive = useMemo(
		() => showsFileConnector(workdriveStatus, connectorPolicy, "zoho_workdrive"),
		[workdriveStatus, connectorPolicy],
	);
	const showsDiscord = useMemo(
		() => connectorPolicy?.find((policy) => policy.id === "discord")?.allowed !== false,
		[connectorPolicy],
	);

	return (
		<div id="permissions-and-connections" tabIndex={-1} ref={focusRef} data-testid="permissions-and-connections"><Card className="mb-3 sm:mb-4">
			<h3 className="text-base font-bold mb-1">Permissions &amp; Connections</h3>
			<p className="text-sm text-muted mb-3">
				What <b>this agent</b> may do, and which of your connected folders it may read. Connecting or disconnecting an account is account-wide and lives
				in <b>Preferences → Connections</b>.
			</p>
			{request && (
				<div className="mb-3 rounded border p-3 text-sm" style={{ borderColor: "var(--color-warning-line)", background: "var(--color-warning-soft)" }} data-testid="permission-request">
					<div className="font-semibold">Permission needed for <span data-testid="permission-request-instance">{permissionCardInstanceLabel(instanceName, instanceId)}</span></div>
					<p className="text-xs text-muted mt-1">{request.reason}</p>
					<p className="text-xs text-muted mt-1">Connector: {request.connector ?? "this control"} · Current scope: {request.currentScope ?? "none"} · Requested minimum: {request.requestedScope}</p>
					<p className="text-xs text-muted mt-1">Resource: {request.resourceId ?? "this instance"} · Operation: {request.operationKind}</p>
					{expiry && <p className={`text-xs mt-1 ${expiry.expired ? "font-semibold" : "text-muted"}`} data-testid={expiry.expired ? "permission-request-expired" : "permission-request-expires"}>{expiry.text}</p>}
					{request.status === "pending" && !expiry?.expired && <>
						{choices?.note && <p className="text-xs mt-1" data-testid="permission-request-note">{choices.note}</p>}
						<div className="flex gap-2 mt-2">{choices?.actions.map((a) => <button key={a.label} type="button" className={`btn text-xs${a.primary ? " btn-primary" : ""}`} onClick={() => void decide(a.decision, a.mode)}>{a.label}</button>)}</div>
					</>}
					{requestMsg && <p className="text-xs mt-2">{requestMsg}</p>}
				</div>
			)}

			<ToolPermissions instanceId={instanceId} />

			<AgentAccountChoice instanceId={instanceId} />

			{showsDrive && (
				<FileConnectorPanel
					label="Google Drive"
					account={driveStatus?.email}
					reach={driveStatus?.reach}
					grants={driveGrants}
					grantRef={driveGrantRef}
					onGrantRefChange={onDriveGrantRefChange}
					onAddGrant={onAddDriveGrant}
					onRemoveGrant={(g) => onRemoveDriveGrant(g as ConnectorGrant)}
				/>
			)}

			{showsWorkdrive && (
				<FileConnectorPanel
					label="Zoho WorkDrive"
					account={workdriveStatus?.account}
					reach={workdriveStatus?.reach}
					grants={workdriveGrants}
					grantRef={workdriveGrantRef}
					onGrantRefChange={onWorkdriveGrantRefChange}
					onAddGrant={onAddWorkdriveGrant}
					onRemoveGrant={(g) => onRemoveWorkdriveGrant(g as ConnectorGrant)}
				/>
			)}

			{showsDiscord && <DiscordConnectorPanel grants={discordGrants} message={discordMsg} onAddGrant={onAddDiscordGrant} onRemoveGrant={onRemoveDiscordGrant} />}

			{showsEmail && (
				<div className="mt-4" data-testid="settings-gmail-group">
					<div className="text-sm mb-2">
						<span className="font-semibold">Gmail</span>
						{emailStatus?.connected ? (
							<span className="text-success"> · connected{emailStatus.email ? ` (${emailStatus.email})` : ""}</span>
						) : (
							<span className="text-muted"> · not connected</span>
						)}
					</div>
					<label className={`flex items-center gap-2 text-sm ${emailStatus?.connected ? "" : "opacity-50"}`}>
						<input
							type="checkbox"
							checked={emailPermission === true}
							disabled={!emailStatus?.connected}
							onChange={(e) => onEmailPermissionChange(e.target.checked)}
						/>
						<span>
							Allow <b>this agent</b> to reach my Gmail
							<span className="block text-xs text-muted-soft mt-0.5">
								Without this it cannot read or act on any message, whatever tools it declares. Which of them it may actually use is the list above — and
								sending, archiving and marking read each need write access granted there as well.
							</span>
						</span>
					</label>
					{!emailStatus?.connected && <p className="text-xs text-muted mt-1">Connect Gmail in <b>Preferences → Connections</b> to enable this.</p>}
				</div>
			)}
			{emailMsg && <div className="text-xs text-muted mt-2">{emailMsg}</div>}
			{driveMsg && <div className="text-xs text-muted mt-2">{driveMsg}</div>}
			{workdriveMsg && <div className="text-xs text-muted mt-2">{workdriveMsg}</div>}
		</Card></div>
	);
}
