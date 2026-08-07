import { type ConnectorReach } from "../lib/connectorState";

/**
 * One account-level file connector (Google Drive, Zoho WorkDrive) as the Settings tab shows it:
 * the connection row, and — when connected — the per-agent folder grants plus what disconnecting
 * would do to them.
 *
 * Extracted from SettingsTab because the two were byte-for-byte the same block with the nouns
 * swapped, and #357 had to change the same three things in both: the reconnect affordance, the
 * grant list, and the standing statement of blast radius. A permission surface that has to say
 * the same true thing twice will eventually say it once.
 */
export interface FileConnectorPanelProps {
	/** Product name, used verbatim in every string ("Google Drive"). */
	label: string;
	connected: boolean;
	/** Which account, when the status route knows it. */
	account?: string | null;
	/** Account-wide grant count for this connector — what a disconnect destroys (#357). */
	reach?: ConnectorReach | null;
	grants: Array<{ id: string; resourceName: string }>;
	grantRef: string;
	onGrantRefChange: (value: string) => void;
	onConnect: () => void;
	onDisconnect: () => void;
	onAddGrant: () => void;
	onRemoveGrant: (grant: { id: string; resourceName: string }) => void;
}

const BTN = "text-xs px-3 py-1.5 rounded-lg border border-line text-muted font-bold";
const BTN_ACCENT = `${BTN} hover:border-accent hover:text-accent`;

export function FileConnectorPanel({
	label,
	connected,
	account,
	reach,
	grants,
	grantRef,
	onGrantRefChange,
	onConnect,
	onDisconnect,
	onAddGrant,
	onRemoveGrant,
}: FileConnectorPanelProps) {
	return (
		<>
			<div className="flex items-center justify-between gap-3 mb-3">
				<div className="text-sm">
					<span className="font-semibold">{label}</span>{" "}
					{connected
						? <span className="text-green">· connected{account ? ` (${account})` : ""}</span>
						: <span className="text-muted">· not connected</span>}
				</div>
				{connected ? (
					<div className="flex gap-2 shrink-0">
						{/* Reconnect exists so an expired token is not a reason to disconnect. Now that
						    disconnect revokes every folder grant, "disconnect then connect again" is a
						    destructive way to refresh a credential — this is the non-destructive one. */}
						<button type="button" onClick={onConnect} className={BTN_ACCENT}>Reconnect</button>
						<button type="button" onClick={onDisconnect} className={`${BTN} hover:border-red hover:text-red`}>
							Disconnect
						</button>
					</div>
				) : (
					<button type="button" onClick={onConnect} className={`${BTN_ACCENT} shrink-0`}>Connect {label}</button>
				)}
			</div>
			{connected && (
				<div className="mb-4 pl-0 sm:pl-3 border-l-0 sm:border-l sm:border-line">
					<div className="flex gap-2 flex-wrap mb-2">
						<input
							value={grantRef}
							onChange={(e) => onGrantRefChange(e.target.value)}
							onKeyDown={(e) => { if (e.key === "Enter") onAddGrant(); }}
							aria-label={`${label} folder to grant this agent`}
							placeholder={`${label} folder URL or ID`}
							className="flex-1 min-w-0 sm:min-w-[14rem] bg-paper border border-line rounded-lg px-3 py-2 text-sm"
						/>
						<button type="button" onClick={onAddGrant} disabled={!grantRef.trim()} className={`${BTN_ACCENT} disabled:opacity-50`}>
							Grant folder
						</button>
					</div>
					<div className="flex flex-col gap-1.5">
						{grants.length === 0 ? (
							<p className="text-xs text-muted">No {label} folders granted to this agent yet.</p>
						) : grants.map((grant) => (
							<div key={grant.id} className="flex items-center justify-between gap-2 text-xs bg-paper border border-line rounded-lg px-2.5 py-2">
								<span className="min-w-0 truncate">{grant.resourceName}</span>
								<button type="button" onClick={() => onRemoveGrant(grant)} className="shrink-0 text-muted hover:text-red">Remove</button>
							</div>
						))}
					</div>
					{/* States the account-level consequence where the per-agent decision is made. A grant
					    is made here and destroyed from the row above; without this the two ends of the
					    same permission never mention each other (#357). */}
					<p className="text-[0.68rem] text-muted-soft mt-1.5">
						{reach?.grants
							? `Disconnecting ${label} revokes all ${reach.grants} folder grant${reach.grants === 1 ? "" : "s"} on ${reach.instances} agent${reach.instances === 1 ? "" : "s"}, including these.`
							: `Disconnecting ${label} revokes every folder grant, on this agent and all your others.`}
					</p>
				</div>
			)}
		</>
	);
}

export default FileConnectorPanel;
