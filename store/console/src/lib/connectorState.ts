// What a deployment-level connector (Gmail, Google Drive, Zoho WorkDrive) IS to the person
// looking at the Settings tab (#353).
//
// `/v1/{email,drive,workdrive}/status` answers two different questions in two flags, and the
// console collapsed them into one: `configured:false` — the deployment has no OAuth client, so
// no amount of clicking will connect it — was rendered in RED, the colour reserved for something
// that went wrong and that you should deal with. Zoho WorkDrive has never been configured on this
// deployment, so every subscriber saw an operator's unfinished work styled as their own error, on
// every instance, forever, with no action available to them.
//
// The platform already draws this distinction elsewhere and it is the same one: #263's MCP probe
// keeps `unsupported` (a correct answer about the server) apart from `unreadable` (we could not
// ask), and #348 made an unmeasured session read as UNMETERED rather than $0. A state is not a
// failure just because it is not the happy one.
//
// So the flags resolve to a named state, and the page renders from that name — `unavailable` is
// deployment information, not user information, and belongs where the deployment is administered.

/** The shape every one of the three status endpoints returns. */
export interface ConnectorStatus {
	connected: boolean;
	configured: boolean;
}

export type ConnectorState =
	/** Not answered yet. Distinct from "not connected" so a slow reply never flashes as absence. */
	| "unknown"
	/** No OAuth client on this deployment. Nothing the person reading the page can do. */
	| "unavailable"
	/** Connectable, and the owner has not connected it. This is the setup step. */
	| "disconnected"
	/** Connected. */
	| "connected";

export function connectorState(status: ConnectorStatus | null | undefined): ConnectorState {
	if (!status) return "unknown";
	if (!status.configured) return "unavailable";
	return status.connected ? "connected" : "disconnected";
}

/**
 * Should this connector appear on a subscriber's Settings tab at all?
 *
 * False while unknown as well as when unavailable: rendering a row before the answer arrives
 * makes a connected account flicker through "not connected", which reads as a disconnection.
 */
export function showsConnector(status: ConnectorStatus | null | undefined): boolean {
	const state = connectorState(status);
	return state === "connected" || state === "disconnected";
}

/**
 * One entry of `GET /v1/instances/:id/connectors` (#352) — this AGENT's verdict on a connector,
 * as opposed to the account-level answer above.
 *
 * The two questions are genuinely different and the page needs both. `ConnectorStatus` says what
 * the deployment and the account did; this says whether the agent in front of you could use the
 * result. Connect Drive once and the account answer is `connected:true` for all 26 instances,
 * including terminal Operators that will never read a document — which is the state #352 is named
 * for, and the one #353 and #355 could not reach because both narrowed on the account.
 */
export interface InstanceConnectorPolicy {
	id: string;
	allowed: boolean;
	reason: string;
}

/**
 * Should THIS agent's Settings tab show the folder-grant panel for a file connector?
 *
 * Two independent conditions, in the order they became true: the account must hold the connection
 * (#355 — a grant against an account you have not connected is a dead row), and the agent must be
 * able to use what a grant would import (#352 — a Drive import lands in the knowledge base and
 * nowhere else, so an agent that cannot read one gains nothing from the folder).
 *
 * An unanswered or failed policy request falls back to SHOWING the panel. There is no safety
 * property here to fail closed on — the grant routes are owner-scoped and the agent has no Drive
 * tool to call either way — so the risk worth avoiding is the opposite one: a new endpoint being
 * unreachable must not remove a control the owner came to this page to use.
 */
export function showsFileConnector(
	status: ConnectorStatus | null | undefined,
	policy: InstanceConnectorPolicy[] | null,
	id: string,
): boolean {
	if (status?.connected !== true) return false;
	if (!policy) return true;
	return policy.find((p) => p.id === id)?.allowed !== false;
}

/** What a file connector's disconnect would destroy: folder grants, across agents (#357). */
export interface ConnectorReach {
	grants: number;
	instances: number;
}

/**
 * The disconnect confirmation for a file connector, stating the blast radius (#357).
 *
 * Disconnecting Drive/WorkDrive deleted only the account's token row and left every per-instance
 * folder grant standing — invisible in both directions, so reconnecting re-armed all of them with
 * no user action. Disconnect now revokes, which is what "I revoked that" already meant to the
 * person clicking it; this is where the product says so, BEFORE the click rather than after.
 *
 * The counts come from the status route rather than the grant list on screen, because the reach
 * is account-wide: the grants being destroyed mostly belong to agents this page is not showing.
 */
export function disconnectPrompt(label: string, reach?: ConnectorReach | null): string {
	const kept = `Documents already imported stay in each agent's knowledge base.`;
	if (!reach || reach.grants === 0) {
		return `Disconnect ${label}?\n\nNo agent currently holds a ${label} folder grant. ${kept}`;
	}
	const folders = reach.grants === 1 ? "1 folder grant" : `${reach.grants} folder grants`;
	const agents = reach.instances === 1 ? "1 agent" : `${reach.instances} agents`;
	return `Disconnect ${label}?\n\nThis also REVOKES ${folders} across ${agents}. Reconnecting will not bring them back — you would grant each folder again.\n\n${kept}`;
}
