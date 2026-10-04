import { useMemo } from "react";
import ToolPermissions from "../../components/ToolPermissions";
import AgentAccountChoice from "../../components/AgentAccountChoice";
import { FileConnectorPanel } from "../../components/FileConnectorPanel";
import { showsConnector, showsFileConnector, type ConnectorReach, type InstanceConnectorPolicy } from "../../lib/connectorState";
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
		<Card className="mb-3 sm:mb-4">
			<h3 className="text-base font-bold mb-1">Permissions &amp; Connections</h3>
			<p className="text-sm text-muted mb-3">
				What <b>this agent</b> may do, and which of your connected folders it may read. Connecting or disconnecting an account is account-wide and lives
				in <b>Preferences → Connections</b>.
			</p>

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
		</Card>
	);
}
