/**
 * Gmail connection for the permissioned agent email tools.
 *
 * A user connects their Gmail so agents they have granted email permission can read it and —
 * since #713 — reply from it. We request offline access and persist ONLY the refresh token,
 * encrypted in the key vault as provider "gmail". Access tokens are minted on demand and never
 * stored.
 *
 * What is requested is the OWNER's choice (#718). A plain connect asks for `gmail.readonly` alone;
 * `gmail.send` and `gmail.modify` are the manifest's optional grants, asked for only when named in
 * `?grant=` — ticked at connect, or "Allow …" on the account page later. `gmail.send` is send-ONLY:
 * it cannot read, delete or modify. `gmail.modify` is the archive/mark-read/relabel power (#716);
 * Google publishes no narrower scope for it.
 *
 * Allowing more never takes anything away. Every authorize URL carries `include_granted_scopes`, so
 * Google's grant covers what this client already held, and the stored `granted_scopes` is MERGED
 * with what comes back rather than overwritten — a reconnect or an elevate that asks for less than
 * the account already has cannot narrow it.
 *
 * What that costs, stated rather than assumed. `gmail.modify` can move a message to Trash, so a
 * bug could hide mail — but it CANNOT permanently delete: that needs `https://mail.google.com/`,
 * which this codebase never requests anywhere, and there is no delete tool to reach it with. So
 * the worst an agent can do to a message is recoverable by the owner from Trash or All Mail.
 *
 * For one release the scopes this route asked for drifted from the manifest (#716 added
 * `gmail.modify` to one list only), so `gmail_archive` and `gmail_mark_read` could never succeed.
 * Since #352 Stage 2 there is no second list: Gmail connects through the generic flow
 * (`lib/connector-oauth-flow.ts`), which asks for exactly the manifest's scopes and declared optional
 * grants. What remains here is the account-level status and disconnect, and the two OAuth paths as
 * aliases of the generic flow.
 *
 * `prompt=consent` below means an ALREADY connected user genuinely re-asks and picks a newly chosen
 * scope up; without it Google returns the old grant and the elevate changes nothing. Only what was
 * actually granted is recorded, so someone who unticks a box at Google still holds everything else,
 * and the console offers the missing power again (`store/console/src/lib/accountConnections.ts`).
 *
 * A connection made before #713 holds `gmail.readonly` alone. Its refresh token keeps working and
 * keeps minting access tokens, so nothing looks broken until a send 403s at Google. That is why
 * the granted scopes are recorded (migration 0133) and surfaced as `canSend` — the read half of
 * an old connection is unaffected, and the send half says "reconnect" instead of failing raw.
 */
import { Hono } from "hono";
import { requireUser } from "../lib/auth.js";
import { decryptKey } from "../lib/crypto.js";
import { mintGmailAccessToken, scopesAllowSend } from "../lib/gmail.js";
import { listConnectorAccounts } from "../lib/connector-accounts.js";
import { completeConnectorOauth, startConnectorOauth } from "../lib/connector-oauth-flow.js";
import type { Env } from "../types.js";

export const emailRoutes = new Hono<{ Bindings: Env }>();

/** The vault provider Gmail's connection is stored under. */
const PROVIDER = "gmail";

// #352 Stage 2 — the OAuth flow is the generic one (`lib/connector-oauth-flow.ts`). These two paths
// stay mounted as aliases, never as a second implementation: `/v1/email/google/callback` is the redirect URI
// the provider's OAuth app has registered (the connector declares it as `redirectPath`), and the start
// path keeps any caller written before the console read `flow.start` from `GET /v1/connectors`.
emailRoutes.get("/google/start", (c) => startConnectorOauth(c, PROVIDER));
emailRoutes.get("/google/callback", (c) => completeConnectorOauth(c, PROVIDER));

/**
 * Which Gmail accounts the current user has connected (#715).
 *
 * Was a single-row lookup, which stopped being correct the moment the vault could hold two
 * mailboxes: the query still matched, `.first()` still returned something, and WHICH something
 * was whatever SQLite felt like. A silent wrong-mailbox answer is precisely what this feature
 * must not introduce, so the route now returns the list.
 *
 * The top-level `email` / `connectedAt` / `canSend` fields are kept for callers written before
 * this, and describe the ONE account when there is exactly one. With several connected they go
 * null / false — not "the first one" — because a single answer to "which mailbox is this?" does
 * not exist any more, and inventing one is the bug.
 */
emailRoutes.get("/status", async (c) => {
	const session = await requireUser(c);
	const configured = !!(c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET);
	const accounts = await listConnectorAccounts(c.env, session.uid, "gmail");

	// Backfill the address for a connection made before we captured it (and verify the token
	// still works — a revoked one makes minting throw). Only for a lone unlabelled row: with
	// several rows there is no way to know which mailbox a probe just described.
	//
	// It deliberately fills `account_label` only, not `account_id`. Changing an id would move a
	// primary key and could collide with a row already at that address; the row identifies itself
	// properly on its next reconnect, which is the cheap and safe moment.
	if (accounts.length === 1 && !accounts[0].label && accounts[0].accountId === "" && configured && c.env.KEY_ENCRYPTION_KEY) {
		try {
			const row = await c.env.DB.prepare(
				"SELECT key_ciphertext, dek_wrapped, iv FROM user_api_keys WHERE user_id = ?1 AND provider = 'gmail' AND account_id = ''",
			)
				.bind(session.uid)
				.first<{ key_ciphertext: ArrayBuffer; dek_wrapped: ArrayBuffer; iv: ArrayBuffer }>();
			if (row) {
				const refresh = await decryptKey(new Uint8Array(row.key_ciphertext), new Uint8Array(row.dek_wrapped), new Uint8Array(row.iv), c.env.KEY_ENCRYPTION_KEY);
				const accessToken = await mintGmailAccessToken(c.env, refresh);
				const ui = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { Authorization: `Bearer ${accessToken}` } });
				if (ui.ok) {
					const found = ((await ui.json()) as { email?: string }).email ?? null;
					if (found) {
						await c.env.DB.prepare(
							"UPDATE user_api_keys SET account_label = ?1 WHERE user_id = ?2 AND provider = 'gmail' AND account_id = ''",
						)
							.bind(found, session.uid)
							.run();
						accounts[0].label = found;
					}
				}
			}
		} catch {
			/* token may be revoked/expired — leave the label null, still "connected" per the row */
		}
	}

	const only = accounts.length === 1 ? accounts[0] : null;
	return c.json({
		connected: accounts.length > 0,
		email: only?.label ?? null,
		connectedAt: only?.connectedAt ?? null,
		configured,
		// Fail-closed with several accounts: whichever one an agent resolves to must be able to
		// send, so "yes" is only honest when every one of them can.
		canSend: accounts.length > 0 && accounts.every((a) => scopesAllowSend(a.grantedScopes)),
		accounts: accounts.map((a) => ({
			accountId: a.accountId,
			label: a.label,
			connectedAt: a.connectedAt,
			canSend: scopesAllowSend(a.grantedScopes),
		})),
	});
});

/**
 * Disconnect ONE Gmail account, or all of them.
 *
 * `?account=<id>` removes that mailbox; omitting it removes every Gmail connection, which is
 * what the pre-#715 route did and what a caller written against it still expects. The response
 * says how many rows went, so a console can report "disconnected 1 of 2" rather than implying
 * the whole provider is gone.
 */
emailRoutes.delete("/google", async (c) => {
	const session = await requireUser(c);
	const account = c.req.query("account");
	const result = account === undefined
		? await c.env.DB.prepare("DELETE FROM user_api_keys WHERE user_id = ?1 AND provider = 'gmail'").bind(session.uid).run()
		: await c.env.DB.prepare("DELETE FROM user_api_keys WHERE user_id = ?1 AND provider = 'gmail' AND account_id = ?2").bind(session.uid, account).run();
	const remaining = await listConnectorAccounts(c.env, session.uid, "gmail");
	return c.json({
		success: true,
		removed: result.meta?.changes ?? 0,
		remaining: remaining.map((a) => ({ accountId: a.accountId, label: a.label })),
	});
});
