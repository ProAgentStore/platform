import { useState, useEffect, useCallback } from "react";
import { api } from "@proagentstore/sdk/client";
import LoadFailed from "../components/LoadFailed";
import ReleaseNotesPanel from "../components/ReleaseNotesPanel";
import type { InstanceConnectorPolicy } from "../lib/connectorState";
import { permissionRequestFocus } from "../lib/permissionRequestFocus";
import ConnectorsSection, { type DriveStatus, type WorkdriveStatus } from "./settings/ConnectorsSection";
import type { DiscordConnectorGrant, DiscordGrantListResponse, DiscordGrantResponse } from "../lib/discordTypes";
import type { ConnectorGrant } from "./TriggersSection";

interface Props {
	instanceId: string;
	instanceName?: string;
}

/**
 * Permissions — what this agent may reach and do (#1060): the permission-request card a push focuses,
 * tool permissions, and its Gmail / Drive / WorkDrive connections. Split out of Settings (what the
 * agent IS: name, brain, engine, runner, triggers) so each is its own page; the controls are unchanged.
 */
export default function PermissionsTab({ instanceId, instanceName }: Props) {
	const permissionRequest = permissionRequestFocus(window.location.search);
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
	const [discordGrants, setDiscordGrants] = useState<DiscordConnectorGrant[]>([]);
	const [discordMsg, setDiscordMsg] = useState("");
	const discordChanges = discordGrants.map((g) => g.id).join(",");
	const [connectorPolicy, setConnectorPolicy] = useState<InstanceConnectorPolicy[] | null>(null);
	const [loadFailures, setLoadFailures] = useState<string[]>([]);

	const loadAll = useCallback(() => {
		(async () => {
			const failed: string[] = [];
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
				const d = await api<DiscordGrantListResponse>(`/v1/discord/instances/${instanceId}/grants`);
				setDiscordGrants(d.grants);
			} catch {
				failed.push("your Discord channels");
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

	const addDiscordGrant = async (channelId: string) => {
		const d = await api<DiscordGrantResponse>(`/v1/discord/instances/${instanceId}/grants`, {
			method: "POST",
			body: JSON.stringify({ channelId }),
		});
		setDiscordGrants((grants) => [d.grant, ...grants.filter((grant) => grant.id !== d.grant.id && grant.resourceId !== d.grant.resourceId)]);
		setDiscordMsg(`Granted this agent access to ${d.grant.resourceName}.`);
	};

	const removeDiscordGrant = async (grant: DiscordConnectorGrant) => {
		await api(`/v1/discord/instances/${instanceId}/grants/${grant.id}`, { method: "DELETE" });
		setDiscordGrants((grants) => grants.filter((entry) => entry.id !== grant.id));
		setDiscordMsg(`Removed access to ${grant.resourceName}.`);
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

	return (
		<div className="min-w-0 overflow-x-hidden">
			{loadFailures.length > 0 && (
				<div className="mb-3">
					<LoadFailed
						what={`${loadFailures.join(", ")} — the controls below may show defaults instead of your settings`}
						onRetry={loadAll}
						testId="permissions-load-failed"
						compact
					/>
				</div>
			)}
			<ConnectorsSection
				instanceId={instanceId}
				instanceName={instanceName}
				permissionRequestId={permissionRequest?.requestId}
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
				discordGrants={discordGrants}
				discordMsg={discordMsg}
				connectorPolicy={connectorPolicy}
				onEmailPermissionChange={toggleEmailPermission}
				onDriveGrantRefChange={setDriveGrantRef}
				onAddDriveGrant={addDriveGrant}
				onRemoveDriveGrant={removeDriveGrant}
				onWorkdriveGrantRefChange={setWorkdriveGrantRef}
				onAddWorkdriveGrant={addWorkdriveGrant}
				onRemoveWorkdriveGrant={removeWorkdriveGrant}
				onAddDiscordGrant={addDiscordGrant}
				onRemoveDiscordGrant={removeDiscordGrant}
			/>
			{/* #1217: who receives this agent's release notes, across its Discord and Slack grants. */}
			<ReleaseNotesPanel instanceId={instanceId} refreshKey={discordChanges} />
		</div>
	);
}
