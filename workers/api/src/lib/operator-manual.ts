/**
 * The operator manual's two layers (#1237): the agent TEMPLATE's manual, inherited by every instance,
 * and the instance's own (#739), shown after it as an addendum that wins where the two disagree.
 *
 * The template's text is read LIVE from `agents.operator_manual` on every read — never copied onto an
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
	/** The template's manual, inherited by every instance of it. "" when none is set. */
	inherited: string;
	/** This instance's own manual. "" when none is set. */
	instance: string;
}

/** Both layers for one instance, in one read. Owner-scoped by the caller's `userId`. */
export async function operatorManualLayers(env: Pick<Env, "DB">, instanceId: string, userId: string): Promise<OperatorManualLayers> {
	const row = await env.DB.prepare(
		"SELECT i.operator_manual AS own, a.operator_manual AS inherited FROM agent_instances i LEFT JOIN agents a ON a.id = i.agent_id WHERE i.id = ?1 AND i.user_id = ?2",
	)
		.bind(instanceId, userId)
		.first<{ own: string | null; inherited: string | null }>();
	return { inherited: row?.inherited ?? "", instance: row?.own ?? "" };
}

/**
 * The two layers as ONE document, clearly sectioned: the inherited manual first, then the instance's
 * own as an addendum that overrides it where they conflict. A layer that is empty is left out, so a
 * manual with only one layer reads exactly as that layer. "" when neither is set.
 */
export function combinedOperatorManual(layers: OperatorManualLayers): string {
	const inherited = layers.inherited.trim();
	const own = layers.instance.trim();
	if (!inherited) return own;
	if (!own) return `## Inherited from the agent template\n\n${inherited}`;
	return `## Inherited from the agent template\n\n${inherited}\n\n## This instance's own manual (addendum — where it conflicts with the inherited text, this wins)\n\n${own}`;
}

/** The 400 a PUT answers with when a manual is over the cap, or null. */
export function operatorManualTooLong(manual: string): string | null {
	return manual.length > OPERATOR_MANUAL_MAX_CHARS ? `Operator manual too long: ${manual.length} chars (max ${OPERATOR_MANUAL_MAX_CHARS}).` : null;
}
