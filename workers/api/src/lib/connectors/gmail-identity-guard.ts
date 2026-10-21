// The Gmail connector's per-instance identity gates (#1279), kept out of connectors/gmail.ts so that file stays about
// the tools. Every function returns a plain refusal STRING (or a value); the handler turns a string into `fail(...)`.
//
// An instance with no pinned identity gets `{ pin: null }` everywhere and behaves exactly as before.
import type { Env } from "../../types.js";
import { formatMailbox, GmailError, listSendAs } from "../gmail.js";
import {
	addressesIn,
	type GmailIdentityPin,
	IDENTITY_UNREADABLE,
	loadGmailIdentity,
	type RecipientHeaders,
	recipientInScope,
	resolveSender,
	type SendAsAlias,
} from "../gmail-identity.js";

/** The pin for this call, `null` for an unconfigured instance, or a refusal when a configured one cannot be read. */
export async function identityFor(env: Env, instanceId: string | undefined): Promise<{ pin: GmailIdentityPin | null } | { refusal: string }> {
	const id = await loadGmailIdentity(env, instanceId);
	if (id.state === "none") return { pin: null };
	if (id.state === "invalid") return { refusal: IDENTITY_UNREADABLE(id.reason) };
	return { pin: id.pin };
}

/** Is this message outside the instance's inbound scope? An unscoped pin (or no pin) never is. */
export function outsideScope(pin: GmailIdentityPin | null, headers: RecipientHeaders): boolean {
	return !!pin && pin.inboundScope.length > 0 && !recipientInScope(pin.inboundScope, headers);
}

export const NOT_IN_SCOPE = "That message is not addressed to this agent's mailbox, so nothing from it was returned or changed.";

export interface ResolvedSender {
	alias: SendAsAlias;
	/** Sanitised `From:` value, built from the VERIFIED alias and its owner-set display name — never from the model. */
	from: string;
	/** Sanitised `Reply-To:` value: the alias's own reply-to when Gmail has one, else the alias. */
	replyTo: string;
	/** Addresses that are "this agent" — dropped from a reply-all so it does not copy itself. */
	own: string[];
}

/** Verify the pinned sender against the account's CURRENT send-as list. Missing, unverified or unreadable → refuse. */
export async function resolvePinnedSender(token: string, pin: GmailIdentityPin): Promise<{ sender: ResolvedSender } | { refusal: string }> {
	let aliases: SendAsAlias[];
	try {
		aliases = await listSendAs(token);
	} catch (e) {
		return { refusal: `The sender address could not be verified, so nothing was sent. ${e instanceof GmailError ? e.message : "Gmail did not answer the send-as lookup."}` };
	}
	const r = resolveSender(aliases, pin.sendAs);
	if (!r.ok) return { refusal: r.message };
	try {
		return {
			sender: {
				alias: r.alias,
				from: formatMailbox(r.alias.email, r.alias.displayName),
				replyTo: formatMailbox(r.alias.replyToAddress || r.alias.email),
				own: [r.alias.email, ...pin.inboundScope],
			},
		};
	} catch (e) {
		return { refusal: e instanceof GmailError ? e.message : "The sender identity could not be formed, so nothing was sent." };
	}
}

/** A reply-all Cc: the original To/Cc as plain mailboxes, minus this agent's own addresses and the primary recipient. */
export function replyAllCc(parent: { to: string; cc: string }, exclude: readonly string[]): string | undefined {
	const list = [...addressesIn(parent.to), ...addressesIn(parent.cc)].filter((a, i, all) => !exclude.includes(a) && all.indexOf(a) === i);
	return list.length > 0 ? list.join(", ") : undefined;
}
