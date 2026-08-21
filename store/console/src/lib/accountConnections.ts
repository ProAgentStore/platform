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
	/** Scopes this stored grant actually holds. `null` = made before we recorded them (#713). */
	grantedScopes?: string[] | null;
	/** Declared scopes the grant is missing. `null` = unanswerable, which is NOT the same as none. */
	missingScopes?: string[] | null;
	/** Does the connector declare any write reach at all? */
	scopes?: { read: boolean; write: boolean };
	/** Every account the owner holds for this connector (#715). One entry is the ordinary case. */
	accounts?: ConnectorAccountRow[];
}

/** One connected account within a connector row. */
export interface ConnectorAccountRow {
	accountId: string;
	label: string | null;
	connectedAt: string | null;
	missingScopes?: string[] | null;
}

/**
 * The accounts to render under a connector, and how each reads.
 *
 * Kept here rather than in the component for the reason the rest of this module exists: the
 * sentence a permission surface shows is worth testing without a browser.
 */
export function accountRows(entry: ConnectorEntry): Array<{ accountId: string; name: string; note: string | null }> {
	return (entry.accounts ?? []).map((a) => ({
		accountId: a.accountId,
		// An account with no captured address still has to be nameable, or it cannot be disconnected.
		name: a.label?.trim() || a.accountId || "unnamed connection",
		note: scopeShortfallNote(a.missingScopes, entry.scopes?.write === true),
	}));
}

/**
 * Does this connector hold more than one account, i.e. does an agent have to be told which to use?
 *
 * The threshold is two, not one: with a single account every agent resolves to it and nothing
 * needs configuring, which is why nobody who never adds a second sees any change.
 */
export function needsPerAgentChoice(entry: ConnectorEntry): boolean {
	return (entry.accounts?.length ?? 0) > 1;
}

/**
 * Is this connection short of what the connector now declares — and therefore due a reconnect?
 *
 * Two distinct causes, one remedy. `missingScopes` non-empty is the certain case: the grant is
 * recorded and provably lacks something. `missingScopes === null` on a CONNECTED, write-capable
 * connector is the uncertain one: the grant predates the recording, so it was made when the
 * connector asked for less, and for Gmail that population is exactly the read-only set (#713).
 *
 * Treating "unknown" as stale is the fail direction that costs a user one unnecessary reconnect,
 * against the alternative of an agent discovering the gap as a provider 403 mid-task. Only for a
 * connector that declares write, because a read-only one has nothing a reconnect would add.
 */
export function accountNeedsReconnect(missingScopes: string[] | null | undefined, connectorCanWrite: boolean): boolean {
	if (missingScopes?.length) return true;
	// Unknown is treated as stale, but only where a reconnect could ADD something: an unrecorded
	// grant on a read-only connector is not short of anything.
	return (missingScopes === null || missingScopes === undefined) && connectorCanWrite;
}

/**
 * WHICH scopes are absent decides the sentence — not merely that some are (#717).
 *
 * The note used to be binary: any shortfall at all rendered as "read-only — reconnect to allow
 * sending". The shortfall is not binary. An account that granted send but declined manage-mail
 * was told it was read-only, which is false on both halves — it is not read-only, and what it
 * lacks is not send. Being told the wrong thing about a permission is worse than being told
 * nothing, because the remedy offered does not match the gap.
 *
 * Matched on the scope URL's last segment rather than on the connector id. This module is
 * deliberately generic over connectors — there is no `if (id === "gmail")` here and the account
 * page's whole design rests on there not being one — but a scope string IS the vocabulary of one
 * provider, and pretending otherwise would mean either a per-connector table (the thing this file
 * exists to avoid) or a sentence too vague to act on. A connector whose missing scopes are none of
 * these falls through to the generic sentence, exactly as before.
 *
 * `null`/`undefined` missing-scopes is the unrecorded pre-migration-0133 grant: we do not know
 * what it holds, and for Gmail that population is precisely the read-only set (#713), so it keeps
 * the original sentence.
 */
export function scopeShortfallNote(missingScopes: string[] | null | undefined, connectorCanWrite: boolean): string | null {
	if (!accountNeedsReconnect(missingScopes, connectorCanWrite)) return null;
	const missing = new Set((missingScopes ?? []).map((s) => s.split("/").pop() ?? s));
	const send = missing.has("gmail.send");
	const modify = missing.has("gmail.modify");
	if (send && modify) return "read-only — reconnect to allow sending and managing mail";
	if (modify) return "cannot archive or mark read — reconnect to allow managing mail";
	return "read-only — reconnect to allow sending";
}

export function needsReconnect(entry: ConnectorEntry): boolean {
	if (!entry.connected) return false;
	// With several accounts the connector-level scope fields describe none of them — the route
	// sends null there on purpose, because a single answer to "which mailbox is this?" no longer
	// exists. Reading that null as "unrecorded, therefore stale" made the summary line say
	// "read-only" over a list in which each account was already stating its own verdict, and said
	// it even when every one of them could send. The per-account rows are the answer here.
	if ((entry.accounts?.length ?? 0) > 1) return false;
	return accountNeedsReconnect(entry.missingScopes, entry.scopes?.write === true);
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

/** The status line for a row: which account, how far it reaches, and whether it is short of scope. */
export function connectionSummary(entry: ConnectorEntry): string {
	if (!entry.connected) return "not connected";
	const who = entry.account ? `connected as ${entry.account}` : "connected";
	// Said on the row rather than left for an agent to discover: a connection that cannot do what
	// the connector now offers is a state the OWNER has to fix, in Settings, not in a chat
	// transcript where a tool refusal would otherwise be the first anyone hears of it.
	// Which sentence comes from `scopeShortfallNote`, shared with `accountRows` so the summary and
	// the rows beneath it cannot say different things about the same grant. WHETHER to say it is
	// still `needsReconnect`'s call, because only it knows about the multi-account short-circuit.
	const note = needsReconnect(entry) ? scopeShortfallNote(entry.missingScopes, entry.scopes?.write === true) : null;
	const short = note ? ` · ${note}` : "";
	const reach = entry.reach;
	if (!reach || reach.grants === 0) return `${who}${short}`;
	const folders = `${reach.grants} folder grant${reach.grants === 1 ? "" : "s"}`;
	const agents = `${reach.instances} agent${reach.instances === 1 ? "" : "s"}`;
	return `${who}${short} · ${folders} on ${agents}`;
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
