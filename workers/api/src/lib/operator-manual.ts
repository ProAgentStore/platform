/**
 * The operator manual's three layers: the ACCOUNT's manual (#1238), the agent TEMPLATE's (#1237), and the instance's own (#739).
 * Precedence is account -> template -> instance: each later layer is an addendum that wins where it conflicts with the one before.
 *
 * The account manual is the INSTANCE OWNER's (the subscriber's), never the template creator's — a creator's account manual must not
 * reach other people's instances; the creator's own standards are what the template layer is for.
 *
 * The template's and the account's text are read LIVE from `agents.operator_manual` on every read — never copied onto an
 * instance — so an edit reaches every existing and future instance of the template on its next read,
 * with no resync. Every reader of "this instance's manual" goes through here: the operator-manual
 * route, the agent's `read_operator_manual`, the prompt's notice and the connection guide.
 */
import type { Env } from "../types.js";

/**
 * Maximum length of either manual in characters. The `PUT` routes reject above this cap rather than
 * silently truncating — open question 1 in #739 resolved in favour of a 400 naming the submitted length.
 */
export const OPERATOR_MANUAL_MAX_CHARS = 16_000;

export interface OperatorManualLayers {
	/** The owner's account-level manual (#1238), applied across every template they run. "" when none is set. */
	account: string;
	/** The template's manual, inherited by every instance of it. "" when none is set. */
	inherited: string;
	/** This instance's own manual. "" when none is set. */
	instance: string;
}

/** All three layers for one instance, in one read. Owner-scoped by the caller's `userId` — the account layer is that owner's. */
export async function operatorManualLayers(env: Pick<Env, "DB">, instanceId: string, userId: string): Promise<OperatorManualLayers> {
	const row = await env.DB.prepare(
		`SELECT i.operator_manual AS own, a.operator_manual AS inherited, m.manual AS account
		   FROM agent_instances i
		   LEFT JOIN agents a ON a.id = i.agent_id
		   LEFT JOIN account_operator_manuals m ON m.user_id = i.user_id
		  WHERE i.id = ?1 AND i.user_id = ?2`,
	)
		.bind(instanceId, userId)
		.first<{ own: string | null; inherited: string | null; account: string | null }>();
	return { account: row?.account ?? "", inherited: row?.inherited ?? "", instance: row?.own ?? "" };
}

const ACCOUNT_HEADING = "## Inherited from your account";
const TEMPLATE_HEADING = "## Inherited from the agent template";
const INSTANCE_HEADING = "## This instance's own manual (addendum — where it conflicts with the inherited text, this wins)";

/**
 * The layers as ONE document, clearly sectioned and in precedence order: the account manual first, the template's next, the instance's
 * own last — each later one an addendum that overrides the ones before where they conflict. A layer that is empty is left out, so a
 * manual with only one layer reads exactly as that layer (an instance-only manual has no heading at all). "" when none is set.
 */
export function combinedOperatorManual(layers: Partial<OperatorManualLayers> & Pick<OperatorManualLayers, "inherited" | "instance">): string {
	const account = (layers.account ?? "").trim();
	const inherited = layers.inherited.trim();
	const own = layers.instance.trim();
	if (!account && !inherited) return own;
	const parts: string[] = [];
	if (account) parts.push(`${ACCOUNT_HEADING}\n\n${account}`);
	if (inherited) parts.push(`${TEMPLATE_HEADING}\n\n${inherited}`);
	if (own) parts.push(`${INSTANCE_HEADING}\n\n${own}`);
	return parts.join("\n\n");
}

/** The owner's account-level manual ("" when none is set). */
export async function readAccountOperatorManual(env: Pick<Env, "DB">, userId: string): Promise<string> {
	const row = await env.DB.prepare("SELECT manual FROM account_operator_manuals WHERE user_id = ?1").bind(userId).first<{ manual: string }>();
	return row?.manual ?? "";
}

/** Replace the owner's account-level manual; "" clears it. The caller has already checked the cap. */
export async function writeAccountOperatorManual(env: Pick<Env, "DB">, userId: string, manual: string): Promise<void> {
	await env.DB.prepare(
		"INSERT INTO account_operator_manuals (user_id, manual, updated_at) VALUES (?1, ?2, datetime('now')) ON CONFLICT(user_id) DO UPDATE SET manual = excluded.manual, updated_at = excluded.updated_at",
	)
		.bind(userId, manual)
		.run();
}

/** The 400 a PUT answers with when a manual is over the cap, or null. */
export function operatorManualTooLong(manual: string): string | null {
	return manual.length > OPERATOR_MANUAL_MAX_CHARS ? `Operator manual too long: ${manual.length} chars (max ${OPERATOR_MANUAL_MAX_CHARS}).` : null;
}
