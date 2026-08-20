/**
 * Which of the owner's accounts a connector call uses (#715).
 *
 * The vault holds several credentials per provider since migration 0135 — two Gmail mailboxes, a
 * personal and a work Drive. Something has to choose between them per agent, and the interesting
 * part is not the lookup but what happens when the answer is not obvious.
 *
 * ── Refusing beats picking ──────────────────────────────────────────────────
 *
 * With two mailboxes connected and no choice recorded for this agent, `resolveConnectorAccount`
 * REFUSES. It does not take the first row, the newest, or the one used last.
 *
 * That is deliberate and it is the whole design. Sending mail from the wrong identity is not a
 * degraded outcome that a user shrugs at — it reaches a real person under a name the owner did
 * not choose, and it cannot be recalled. The same holds for reading: "search my mail" against the
 * wrong mailbox silently answers from the wrong life. A refusal costs one click in Settings; a
 * wrong pick costs something no click undoes.
 *
 * This is also exactly the failure migration 0083 had to clean up for MCP, where one credential
 * slot per provider meant "a token issued by server A was therefore sent, verbatim, to server B".
 * The lesson recorded there is that an ambiguous credential must never resolve by convention.
 *
 * ── A pin that has gone stale refuses too ───────────────────────────────────
 *
 * If an agent is pinned to an account the owner has since disconnected, this refuses rather than
 * falling back to whatever else is connected. Falling back would be the wrong-identity bug
 * arriving by a slower route, and it would arrive at exactly the moment nobody is watching —
 * a scheduled run, weeks after the disconnect.
 *
 * ── One account keeps working with no configuration ─────────────────────────
 *
 * Everyone who never connects a second account sees no change: one row resolves to itself
 * whether or not a choice is recorded, and the reserved id '' is what every caller that has not
 * been made account-aware still asks for.
 */
import type { Env } from "../types.js";

/** One connected account, as the owner sees it. Never carries credential material. */
export interface ConnectorAccount {
	/** The provider's own id for the account (a mailbox address for Google). '' = the unnamed default. */
	accountId: string;
	/** Human label — the address, when we captured one. */
	label: string | null;
	connectedAt: string | null;
	/** What this grant was authorised for (#713), space-separated, or null if never recorded. */
	grantedScopes: string | null;
}

export type AccountResolution =
	| { ok: true; account: ConnectorAccount }
	| { ok: false; reason: "not_connected" | "ambiguous" | "pinned_account_gone"; message: string };

/** List the owner's connected accounts for one provider, newest first. Credential-free. */
export async function listConnectorAccounts(
	env: Env,
	userId: string,
	provider: string,
): Promise<ConnectorAccount[]> {
	const rows = await env.DB.prepare(
		`SELECT account_id, account_label, created_at, granted_scopes
       FROM user_api_keys
      WHERE user_id = ?1 AND provider = ?2
      ORDER BY created_at DESC, account_id ASC`,
	)
		.bind(userId, provider)
		.all<{ account_id: string; account_label: string | null; created_at: string | null; granted_scopes: string | null }>();
	return (rows.results ?? []).map((r) => ({
		accountId: r.account_id ?? "",
		label: r.account_label,
		connectedAt: r.created_at,
		grantedScopes: r.granted_scopes,
	}));
}

/** How an account reads in a refusal: the address if we have one, else the id, else "unnamed". */
function describe(account: ConnectorAccount): string {
	return account.label?.trim() || account.accountId || "an unnamed connection";
}

/**
 * Pick the account for this call. PURE — the caller supplies what is connected and what the
 * agent is pinned to, so every branch is testable without a database.
 *
 * `pinned` is the instance's recorded choice (`config.connectorAccounts[provider]`), or undefined.
 */
export function resolveConnectorAccount(
	accounts: readonly ConnectorAccount[],
	pinned: string | undefined,
	displayName: string,
): AccountResolution {
	if (accounts.length === 0) {
		return { ok: false, reason: "not_connected", message: `${displayName} is not connected.` };
	}

	if (pinned !== undefined && pinned !== "") {
		const match = accounts.find((a) => a.accountId === pinned);
		if (match) return { ok: true, account: match };
		// Do NOT fall back. See the header: a stale pin resolving to a different identity is the
		// wrong-mailbox bug arriving on a schedule, when nobody is watching.
		return {
			ok: false,
			reason: "pinned_account_gone",
			message:
				`This agent is set to use the ${displayName} account "${pinned}", which is no longer connected. ` +
				`Reconnect it, or choose a different account for this agent in its Settings. ` +
				`Currently connected: ${accounts.map(describe).join(", ")}.`,
		};
	}

	if (accounts.length === 1) return { ok: true, account: accounts[0] };

	return {
		ok: false,
		reason: "ambiguous",
		message:
			`You have ${accounts.length} ${displayName} accounts connected and this agent is not set to use one of them: ` +
			`${accounts.map(describe).join(", ")}. ` +
			`Choose which account this agent should use in its Settings — nothing is sent or read until you do.`,
	};
}

/** The instance's recorded account choices, if any. Shape: { "gmail": "me@example.com" }. */
export function pinnedAccountsFrom(config: unknown): Record<string, string> {
	if (typeof config !== "object" || config === null) return {};
	const raw = (config as { connectorAccounts?: unknown }).connectorAccounts;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
	const out: Record<string, string> = {};
	for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof value === "string" && value.trim()) out[provider] = value.trim();
	}
	return out;
}

/** Read an instance's pinned account for one provider straight from D1. */
export async function pinnedAccountFor(
	env: Env,
	instanceId: string | undefined,
	provider: string,
): Promise<string | undefined> {
	if (!instanceId) return undefined;
	const row = await env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1")
		.bind(instanceId)
		.first<{ config: string | null }>();
	if (!row?.config) return undefined;
	try {
		return pinnedAccountsFrom(JSON.parse(row.config))[provider];
	} catch {
		return undefined;
	}
}
