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
