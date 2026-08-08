import { type ConnectorReach } from "../lib/connectorState";

/**
 * The per-agent half of a file connector (Google Drive, Zoho WorkDrive): which folders THIS agent
 * may read, out of the account that is already connected.
 *
 * Extracted from SettingsTab because the two were byte-for-byte the same block with the nouns
 * swapped, and #357 had to change the same things in both. A permission surface that has to say
 * the same true thing twice will eventually say it once.
 *
 * It no longer connects or disconnects (#355). Connecting is an account act — one token row shared
 * by every agent — and rendering the button here, under a heading carrying one agent's name, was
 * why disconnecting Gmail from the Coder's settings silently disconnected it for every other
 * agent. Connect/disconnect live on Preferences → Connections; a grant is the thing that is
 * genuinely per-agent, and it is all that is left here. The panel renders only when the account
 * connection exists, because a grant against nothing is not a control, it is a dead row.
 */
export interface FileConnectorPanelProps {
	/** Product name, used verbatim in every string ("Google Drive"). */
	label: string;
	/** Which account is connected, when the status route knows it — context for whose folders these are. */
	account?: string | null;
	/** Account-wide grant count for this connector — what an account-level disconnect destroys (#357). */
	reach?: ConnectorReach | null;
	grants: Array<{ id: string; resourceName: string }>;
	grantRef: string;
	onGrantRefChange: (value: string) => void;
	onAddGrant: () => void;
	onRemoveGrant: (grant: { id: string; resourceName: string }) => void;
}

const BTN = "text-xs px-3 py-1.5 rounded-lg border border-line text-muted font-bold";
const BTN_ACCENT = `${BTN} hover:border-accent hover:text-accent`;

export function FileConnectorPanel({
	label,
	account,
	reach,
	grants,
	grantRef,
	onGrantRefChange,
	onAddGrant,
	onRemoveGrant,
}: FileConnectorPanelProps) {
	return (
		<div className="mb-4">
			<div className="text-sm mb-2">
				<span className="font-semibold">{label}</span>{" "}
				<span className="text-success">· connected{account ? ` (${account})` : ""}</span>
				<p className="text-2xs text-muted-soft mt-0.5">Folders this agent may read. Other agents get their own.</p>
			</div>
			<div className="pl-0 sm:pl-3 border-l-0 sm:border-l sm:border-line">
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
							<button type="button" onClick={() => onRemoveGrant(grant)} className="shrink-0 text-muted hover:text-danger">Remove</button>
						</div>
					))}
				</div>
				{/* States the account-level consequence where the per-agent decision is made. The
				    disconnect that destroys these now lives on another page, so this is the only place
				    the two ends of the same permission can mention each other (#357/#355). */}
				<p className="text-2xs text-muted-soft mt-1.5">
					{reach?.grants
						? `Disconnecting ${label} in Preferences → Connections revokes all ${reach.grants} folder grant${reach.grants === 1 ? "" : "s"} on ${reach.instances} agent${reach.instances === 1 ? "" : "s"}, including these.`
						: `Disconnecting ${label} in Preferences → Connections revokes every folder grant, on this agent and all your others.`}
				</p>
			</div>
		</div>
	);
}

export default FileConnectorPanel;
