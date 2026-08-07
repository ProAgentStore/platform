// The account's connected accounts, as the Preferences page shows them (#355).
//
// Connecting Gmail, Google Drive or Zoho WorkDrive is an ACCOUNT act — one token row in
// `user_api_keys`, shared by every agent — but the buttons lived inside one instance's Settings
// tab, under a heading carrying that agent's name. Disconnecting Gmail from the Coder's settings
// disconnected it for the Job Application Assistant too, and nothing on screen said so. That is a
// comprehension bug on a permission surface: the reader is configuring one agent, and the control
// they are touching changes all of them.
//
// So the account half moves to the account page, and the instance half (folder grants, the
// per-agent inbox permission) stays on the instance. This module is the part of that move worth
// testing without a browser: which catalog rows are connections a person can act on, what each
// row SAYS, and what its disconnect confirmation has to state before the click.
//
// Everything here is driven by `GET /v1/connectors` (#352 Stage 1). There is deliberately no
// per-connector knowledge in this file or the component that renders it — no "if google_drive".
// The rule the move establishes is that account scope lives in one place; a console that still
// knew the connectors by name would be one `if` away from breaking it again.

import { disconnectPrompt, type ConnectorReach } from "./connectorState";

/** One entry of `GET /v1/connectors`, resolved for the caller. */
export interface ConnectorEntry {
	id: string;
	label: string;
	auth: string;
	grantModel: "user" | "instance-resource";
	/** Can this DEPLOYMENT connect it at all — distinct from "have YOU" (#353). */
	configured: boolean;
	/** `null` for a connector that holds no credential (relay/app auth): nothing to connect. */
	connected: boolean | null;
	account: string | null;
	connectedAt: string | null;
	/** What a disconnect revokes: folder grants, across agents. `null` when reach isn't grants. */
	reach: ConnectorReach | null;
	/** The live endpoints, named by the server. `null` = no connect step exists. */
	flow: { start: string; disconnect: string } | null;
}

/**
 * The rows the Connections section renders, in the order it renders them.
 *
 * Filtered, not styled-away: a connector this deployment cannot connect has no action behind it,
 * and #353 already established that an operator's unfinished work must not render as the owner's
 * error. One without a `flow` is the same case seen from the other side — a row whose buttons
 * would do nothing.
 *
 * Connected first, then alphabetical. What you have connected is what you came to check.
 */
export function accountConnections(entries: ConnectorEntry[]): ConnectorEntry[] {
	return entries
		.filter((e) => e.connected !== null && e.configured && e.flow !== null)
		.sort((a, b) => Number(b.connected) - Number(a.connected) || a.label.localeCompare(b.label));
}

/** The status line for a row: which account, and — where reach is grants — how far it goes. */
export function connectionSummary(entry: ConnectorEntry): string {
	if (!entry.connected) return "not connected";
	const who = entry.account ? `connected as ${entry.account}` : "connected";
	const reach = entry.reach;
	if (!reach || reach.grants === 0) return who;
	const folders = `${reach.grants} folder grant${reach.grants === 1 ? "" : "s"}`;
	const agents = `${reach.instances} agent${reach.instances === 1 ? "" : "s"}`;
	return `${who} · ${folders} on ${agents}`;
}

/**
 * The confirmation text for disconnecting one connector.
 *
 * The old copy — "Agents will no longer be able to read your inbox" — was wrong in a way a
 * pluralisation fix would not have reached: it does not say WHICH agents, and the system knows.
 * A grant-holding connector can now name the count it is about to destroy; Gmail cannot, because
 * its reach is a per-agent permission flag this account-level route cannot see, so it says that
 * instead of implying a cleanup it does not perform.
 */
export function disconnectPromptFor(entry: ConnectorEntry): string {
	if (entry.grantModel === "instance-resource") return disconnectPrompt(entry.label, entry.reach);
	return `Disconnect ${entry.label}?\n\nEvery agent loses access immediately. Any per-agent permission you granted is NOT cleared, so reconnecting ${entry.label} restores it — turn that permission off on the agent's own Settings tab if you want it gone for good.`;
}

/** What to report after a successful disconnect, including anything it revoked on the way. */
export function disconnectedMessage(entry: ConnectorEntry, revoked?: ConnectorReach | null): string {
	if (!revoked?.grants) return `${entry.label} disconnected.`;
	const folders = `${revoked.grants} folder grant${revoked.grants === 1 ? "" : "s"}`;
	const agents = `${revoked.instances} agent${revoked.instances === 1 ? "" : "s"}`;
	return `${entry.label} disconnected. Revoked ${folders} across ${agents}.`;
}
