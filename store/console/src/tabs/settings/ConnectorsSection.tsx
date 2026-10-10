import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@proagentstore/sdk/client";
import ToolPermissions from "../../components/ToolPermissions";
import AgentAccountChoice from "../../components/AgentAccountChoice";
import { FileConnectorPanel } from "../../components/FileConnectorPanel";
import { showsConnector, showsFileConnector, type ConnectorReach, type InstanceConnectorPolicy } from "../../lib/connectorState";
import type { InstancePermissionRequest, InstancePermissionRequestDecisionResponse, InstancePermissionRequestResponse } from "../../lib/types";
import Card from "../../components/Card";

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

interface Props {
	instanceId: string;
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
	connectorPolicy: InstanceConnectorPolicy[] | null;
	onEmailPermissionChange: (on: boolean) => Promise<void>;
	onDriveGrantRefChange: (value: string) => void;
	onAddDriveGrant: () => Promise<void>;
	onRemoveDriveGrant: (grant: ConnectorGrant) => Promise<void>;
	onWorkdriveGrantRefChange: (value: string) => void;
	onAddWorkdriveGrant: () => Promise<void>;
	onRemoveWorkdriveGrant: (grant: ConnectorGrant) => Promise<void>;
}

export default function ConnectorsSection({
	instanceId,
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
	connectorPolicy,
	onEmailPermissionChange,
	onDriveGrantRefChange,
	onAddDriveGrant,
	onRemoveDriveGrant,
	onWorkdriveGrantRefChange,
	onAddWorkdriveGrant,
	onRemoveWorkdriveGrant,
}: Props) {
	const focusRef = useRef<HTMLDivElement>(null);
	const [request, setRequest] = useState<InstancePermissionRequest | null>(null);
	const [requestMsg, setRequestMsg] = useState("");
	useEffect(() => {
		if (!permissionRequestId) return;
		focusRef.current?.scrollIntoView({ block: "center" }); focusRef.current?.focus();
		api<InstancePermissionRequestResponse>(`/v1/instances/${instanceId}/permission-requests/${encodeURIComponent(permissionRequestId)}`).then((d) => setRequest(d.request)).catch((e) => setRequestMsg(e instanceof Error ? e.message : "This permission request is no longer available."));
	}, [instanceId, permissionRequestId]);
	const decide = async (decision: "approve" | "deny", mode?: "always" | "ask") => {
		if (!request) return; setRequestMsg("");
		try { const d = await api<InstancePermissionRequestDecisionResponse>(`/v1/instances/${instanceId}/permission-requests/${request.id}/${decision}`, { method:"POST", body: JSON.stringify(mode ? { mode } : {}) }); setRequest({ ...request, status:d.status }); setRequestMsg(decision === "approve" ? "Permission verified. The blocked operation may resume once through its verified continuation." : "Permission request denied; nothing was run."); }
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

	return (
		<div id="permissions-and-connections" tabIndex={-1} ref={focusRef} data-testid="permissions-and-connections"><Card className="mb-3 sm:mb-4">
			<h3 className="text-base font-bold mb-1">Permissions &amp; Connections</h3>
			<p className="text-sm text-muted mb-3">
				What <b>this agent</b> may do, and which of your connected folders it may read. Connecting or disconnecting an account is account-wide and lives
				in <b>Preferences → Connections</b>.
			</p>
			{request && (
				<div className="mb-3 rounded border p-3 text-sm" style={{ borderColor: "var(--color-warning-line)", background: "var(--color-warning-soft)" }} data-testid="permission-request">
					<div className="font-semibold">Permission needed for this instance</div>
					<p className="text-xs text-muted mt-1">{request.reason}</p>
					<p className="text-xs text-muted mt-1">Connector: {request.connector ?? "this control"} · Current scope: {request.currentScope ?? "none"} · Requested minimum: {request.requestedScope}</p>
					<p className="text-xs text-muted mt-1">Resource: {request.resourceId ?? "this instance"} · Operation: {request.operationKind}</p>
					{request.status === "pending" && <div className="flex gap-2 mt-2"><button type="button" className="btn btn-primary text-xs" onClick={() => void decide("approve", "always")}>Allow write access</button><button type="button" className="btn text-xs" onClick={() => void decide("approve", "ask")}>Ask each time</button><button type="button" className="btn text-xs" onClick={() => void decide("deny")}>Deny</button></div>}
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
