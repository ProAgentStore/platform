// Generic connector OAuth2 (issue #147). ONE authorize/callback flow for every oauth connector —
// since #352 Stage 2 including Google Drive, Zoho WorkDrive and Gmail, whose dedicated flows are
// gone (the flow itself is `lib/connector-oauth-flow.ts`). Adding an OAuth SaaS is a declaration
// plus an OAuth app registration pointing its redirect at `/v1/connectors/<id>/oauth/callback`, or
// at the id-less `/v1/connectors/oauth/callback` — no bespoke route code.
import { Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { CONNECTORS, getConnector } from "../lib/connectors/registry.js";
import { resolveOauthConfig } from "../lib/connectors/client.js";
import { connectorGrantReach, connectorGrantReachByProvider, revokeUserConnectorGrants } from "../lib/connector-grants.js";
import { unattendedClassOf } from "../lib/connectors/unattended.js";
import type { Connector, OptionalGrant } from "../lib/connectors/types.js";
import { connectorStateProvider } from "../lib/connector-oauth.js";
import { completeConnectorOauth, startConnectorOauth } from "../lib/connector-oauth-flow.js";
import { listConnectorAccounts } from "../lib/connector-accounts.js";
import { OAUTH_BIND_ERROR } from "../lib/oauth-nonce.js";
import type { Env } from "../types.js";

export const connectorRoutes = new Hono<{ Bindings: Env }>();

/**
 * Is this connector usable ON THIS DEPLOYMENT at all? Distinct from "the caller connected it" —
 * the same distinction #353 had to draw in the console, where an unconfigured connector was
 * rendered as the owner's error.
 */
function isConfigured(env: Env, connector: Connector): boolean {
	const e = env as unknown as Record<string, string | undefined>;
	// A connector that names its credential env vars is judged on those — the only way to answer
	// for one whose OAuth endpoints are not manifest-expressible (Zoho WorkDrive). See types.ts.
	if (connector.credentialEnv?.length) return connector.credentialEnv.every((k) => !!e[k]?.trim());
	switch (connector.auth) {
		case "oauth": {
			const creds = resolveOauthConfig(env, connector.id);
			return !!(creds.clientId && creds.clientSecret && creds.tokenUrl);
		}
		// A platform-token connector needs its env var; a vault-backed one is configured by
		// definition (the credential is the user's to supply).
		case "token":
			return connector.tokenEnv ? !!env[connector.tokenEnv]?.trim() : true;
		case "app":
			return !!(env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY);
		case "none":
			return true;
	}
}

/**
 * Which connect/disconnect flow is live for a connector (#355). Since #352 Stage 2 there is one:
 * the dedicated Drive/WorkDrive/Gmail pairs were retired into the generic flow, so every oauth
 * connector that declares where to send the browser connects at `/v1/connectors/<id>/oauth/start`.
 * The console reads this rather than knowing it, which is why retiring a flow needed no console
 * change.
 */
/** The endpoints a UI should call to connect/disconnect, or null when there is nothing to call. */
function connectFlow(connector: Connector): { start: string; disconnect: string } | null {
	// The generic flow can only be offered to a connector whose manifest declares where to send
	// the browser. Anything else has no connect step a caller could take.
	if (connector.auth !== "oauth" || !connector.oauth) return null;
	const id = encodeURIComponent(connector.id);
	return { start: `/v1/connectors/${id}/oauth/start`, disconnect: `/v1/connectors/${id}/oauth` };
}

/**
 * GET /v1/connectors — the catalog, resolved for the caller (#352 Stage 1).
 *
 * The registry has been the single source of truth for connectors since #86, but nothing could
 * READ it from outside the Worker, so every consumer that needed "which connectors exist and is
 * this one connected" wrote its own list: two route files, three hand-written console blocks, an
 * MCP `PROVIDERS` map plus a matching Zod enum, and the `sync_connector` trigger branch. Five
 * copies, each a place a sixth connector has to be remembered. This is the one answer they can
 * all derive from — the next consumer is a `.map()`.
 *
 * `connected` is one indexed read over `user_api_keys` for the whole catalog rather than one per
 * connector, because the list is short and the round trips are not. `reach` is the same trick
 * over `instance_connector_grants`: the account page states what a disconnect would revoke BEFORE
 * the click (#355/#357), and it has to state it for every row, not the one being confirmed.
 */
/**
 * Google accepts `email` and `profile` on the way in and hands back the canonical userinfo URLs
 * on the way out. Comparing the two forms as strings therefore NEVER matches (#715 follow-up).
 *
 * That is not a hypothetical: every Gmail connection reported `email` permanently missing, so
 * every account rendered as "read-only — reconnect to allow sending" no matter what the owner had
 * just granted, including a mailbox connected seconds earlier with the send box ticked. The
 * reconnect it asked for could never clear it, because the mismatch is in the comparison rather
 * than in the grant.
 */
const SCOPE_ALIASES: Readonly<Record<string, string>> = {
	email: "https://www.googleapis.com/auth/userinfo.email",
	profile: "https://www.googleapis.com/auth/userinfo.profile",
};

/** Scopes that CONTAIN other scopes. Granting one satisfies everything it covers. */
const SCOPE_SUPERSETS: ReadonlyArray<{ scope: string; covers: (s: string) => boolean }> = [
	// Full-mailbox access. A caller holding this can do everything gmail.* allows, so reporting
	// gmail.send "missing" against it would be a false alarm of the same family as the alias bug.
	{ scope: "https://mail.google.com/", covers: (s) => s.startsWith("https://www.googleapis.com/auth/gmail.") },
	// gmail.modify includes reading. Someone who grants modify but declines the separate readonly
	// checkbox is not missing anything, and saying they are would send them round a reconnect that
	// changes nothing — the failure this whole comparison was rewritten to stop.
	{ scope: "https://www.googleapis.com/auth/gmail.modify", covers: (s) => s === "https://www.googleapis.com/auth/gmail.readonly" },
];

function canonicalScope(scope: string): string {
	return SCOPE_ALIASES[scope] ?? scope;
}

/**
 * Which of a connector's declared OAuth scopes this stored grant does NOT have.
 *
 * `null` means unanswerable — either the connector declares no scopes, or the grant predates
 * `granted_scopes` and we genuinely do not know. Callers must render that differently from an
 * empty array; see the field comment below.
 */
export function missingScopesFor(
	connector: { oauth?: { scopes?: readonly string[] } },
	grantedScopes: string | null | undefined,
): string[] | null {
	const declared = connector.oauth?.scopes;
	if (!declared?.length || !grantedScopes) return null;
	return absentScopes(declared, grantedScopes);
}

/** Which of `wanted` a grant string does not hold, honouring provider aliases and superset scopes. */
function absentScopes(wanted: readonly string[], grantedScopes: string): string[] {
	const held = new Set(grantedScopes.split(/\s+/).filter(Boolean).map(canonicalScope));
	const supersets = SCOPE_SUPERSETS.filter((sup) => held.has(sup.scope));
	return wanted.filter((raw) => {
		const want = canonicalScope(raw);
		if (held.has(want)) return false;
		return !supersets.some((sup) => sup.covers(want));
	});
}

/**
 * The connector's optional grants (#718), each with whether this stored grant holds it. An unrecorded
 * grant (pre-migration-0133) holds none as far as anyone can prove, so each is offered — asking again
 * with `include_granted_scopes` costs a consent screen, never a power already held.
 */
export function optionalGrantsFor(
	connector: { oauth?: { optionalGrants?: readonly OptionalGrant[] } },
	grantedScopes: string | null | undefined,
): Array<{ id: string; label: string; held: boolean }> {
	return (connector.oauth?.optionalGrants ?? []).map((g) => ({
		id: g.id,
		label: g.label,
		held: !!grantedScopes && absentScopes(g.scopes, grantedScopes).length === 0,
	}));
}

connectorRoutes.get("/", async (c) => {
	const session = await requireUser(c);
	const [rows, reachByProvider] = await Promise.all([
		c.env.DB.prepare(
			"SELECT provider, account_id, created_at, account_label, granted_scopes FROM user_api_keys WHERE user_id = ?1 ORDER BY created_at DESC, account_id ASC",
		)
			.bind(session.uid)
			.all<{ provider: string; account_id: string; created_at: string; account_label: string | null; granted_scopes: string | null }>(),
		connectorGrantReachByProvider(c.env, session.uid),
	]);
	// GROUPED, not keyed (#715). This was `new Map(rows.map(r => [r.provider, r]))`, which with two
	// Gmail rows silently kept whichever came last — the catalog would name one mailbox and the
	// agent could use the other. A provider now carries its accounts, and the single-account
	// fields below are computed from that list rather than from a row that happened to win.
	const byProvider = new Map<string, typeof rows.results>();
	for (const r of rows.results ?? []) {
		const list = byProvider.get(r.provider) ?? [];
		list.push(r);
		byProvider.set(r.provider, list);
	}
	return c.json({
		connectors: CONNECTORS.map((connector) => {
			const accounts = byProvider.get(connector.id) ?? [];
			// The legacy single-connection fields describe the ONE account when there is one, and
			// go null when there are several — see /v1/email/status for the same reasoning.
			const row = accounts.length === 1 ? accounts[0] : undefined;
			// Only a connector that HOLDS a credential can be "connected". A relay/no-auth one has
			// nothing to connect, and reporting `connected:false` for it would read as a gap.
			const holdsCredential = connector.auth === "oauth" || (connector.auth === "token" && !connector.tokenEnv);
			return {
				id: connector.id,
				label: connector.label,
				auth: connector.auth,
				scopes: connector.scopes,
				grantModel: connector.grantModel,
				unattended: unattendedClassOf(connector),
				tools: connector.tools.map((t) => t.name),
				configured: isConfigured(c.env, connector),
				connected: holdsCredential ? accounts.length > 0 : null,
				account: row?.account_label ?? null,
				connectedAt: row?.created_at ?? null,
				// Every credential the owner holds for this connector, so a console can list them
				// and an instance can be pointed at one.
				accounts: accounts.map((a) => ({
					accountId: a.account_id ?? "",
					label: a.account_label,
					connectedAt: a.created_at,
					missingScopes: missingScopesFor(connector, a.granted_scopes),
					optionalGrants: optionalGrantsFor(connector, a.granted_scopes),
				})),
				// Only meaningful where a grant IS the reach. A `user`-model connector has no grants
				// to count, and `{grants:0}` on it would read as "nothing uses this" rather than
				// "this is not how its reach works".
				reach: connector.grantModel === "instance-resource"
					? (reachByProvider.get(connector.id) ?? { grants: 0, instances: 0 })
					: null,
				// What this stored grant was actually authorised FOR (migration 0133), and which of
				// the connector's DECLARED scopes it is missing.
				//
				// Generic rather than Gmail-specific, though Gmail is what forced it (#713): any
				// connector that gains a scope leaves its existing connections holding the old one,
				// and the refresh token goes on minting access tokens perfectly happily, so nothing
				// looks broken until the provider refuses one call. Comparing the two is the only
				// way to say "connected, but not for that" before it happens.
				//
				// `null`, not `[]`, when the grant predates the column: "we did not record this" and
				// "nothing is missing" are different answers, and collapsing them would report an
				// old read-only connection as fully capable.
				grantedScopes: row?.granted_scopes ? row.granted_scopes.split(/\s+/).filter(Boolean) : null,
				missingScopes: missingScopesFor(connector, row?.granted_scopes),
				// What can be ALLOWED on top of the baseline, and whether it is (#718). Per account above;
				// here for the one account, or held:false throughout when there is none or several.
				optionalGrants: optionalGrantsFor(connector, row?.granted_scopes),
				flow: connectFlow(connector),
			};
		}),
	});
});

/** GET /v1/connectors/:id/oauth/start — return the provider authorize URL (signed, browser-bound state). */
connectorRoutes.get("/:id/oauth/start", (c) => startConnectorOauth(c, c.req.param("id")));

/** GET /v1/connectors/:id/oauth/callback — exchange the code, store the credential. */
connectorRoutes.get("/:id/oauth/callback", (c) => completeConnectorOauth(c, c.req.param("id")));

/**
 * GET /v1/connectors/oauth/callback — the ONE redirect URI an OAuth app needs for every connector it
 * serves (#352 Stage 2). The URL does not name the connector, so the state's claim chooses which to
 * verify against; verification still pins the state to that connector, its signature and the
 * browser that started it, so a forged claim only selects a check that fails.
 */
connectorRoutes.get("/oauth/callback", (c) => {
	const provider = connectorStateProvider(c.req.query("state") ?? "");
	if (!provider || getConnector(provider)?.auth !== "oauth") return c.text(OAUTH_BIND_ERROR, 400);
	return completeConnectorOauth(c, provider);
});

/** GET /v1/connectors/:id/oauth/status — is this oauth connector connected for the caller? */
connectorRoutes.get("/:id/oauth/status", async (c) => {
	const session = await requireUser(c);
	const id = c.req.param("id");
	const connector = getConnector(id);
	if (connector?.auth !== "oauth") throw new HttpError(404, `No OAuth connector "${id}".`);
	const creds = resolveOauthConfig(c.env, id);
	const row = await c.env.DB.prepare("SELECT created_at, account_label FROM user_api_keys WHERE user_id = ?1 AND provider = ?2")
		.bind(session.uid, id)
		.first<{ created_at: string; account_label: string | null }>();
	// Grant-holding connectors report what a disconnect would revoke, the same contract
	// /v1/{drive,workdrive}/status carry (#357) — so a caller can state it before confirming.
	const reach = connector.grantModel === "instance-resource"
		? await connectorGrantReach(c.env, session.uid, id)
		: undefined;
	return c.json({
		connected: !!row,
		account: row?.account_label ?? null,
		connectedAt: row?.created_at ?? null,
		configured: !!(creds.clientId && creds.clientSecret),
		...(reach ? { reach } : {}),
	});
});

/**
 * DELETE /v1/connectors/:id/oauth — disconnect: drop the stored refresh token AND, for a
 * connector whose reach is per-instance grants, those grants.
 *
 * Declaring Drive/WorkDrive (#352 Stage 1) makes this route a SECOND way to disconnect them, so
 * without the cascade it would have quietly re-opened #357 through a different door: token gone,
 * grants standing, restored by the next reconnect. A permission rule that only holds on one of
 * two paths is not a rule.
 */
connectorRoutes.delete("/:id/oauth", async (c) => {
	const session = await requireUser(c);
	const id = c.req.param("id");
	const connector = getConnector(id);
	// `?account=` removes ONE account of a connector that keys a row per account (Gmail's mailboxes,
	// #715) — the contract the retired `DELETE /v1/email/google` carried, now the generic route's.
	const perAccount = connector?.oauth?.identity?.perAccount === true;
	const account = perAccount ? c.req.query("account") : undefined;
	const revoked = connector?.grantModel === "instance-resource"
		? await revokeUserConnectorGrants(c.env, session.uid, id)
		: undefined;
	const result = account === undefined
		? await c.env.DB.prepare("DELETE FROM user_api_keys WHERE user_id = ?1 AND provider = ?2").bind(session.uid, id).run()
		: await c.env.DB.prepare("DELETE FROM user_api_keys WHERE user_id = ?1 AND provider = ?2 AND account_id = ?3").bind(session.uid, id, account).run();
	const remaining = perAccount ? (await listConnectorAccounts(c.env, session.uid, id)).map((a) => ({ accountId: a.accountId, label: a.label })) : undefined;
	return c.json({ success: true, ...(revoked ? { revoked } : {}), ...(perAccount ? { removed: result.meta?.changes ?? 0, remaining } : {}) });
});
