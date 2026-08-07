/**
 * The proper nouns the PLATFORM already knows, handed to the transcriber (#372).
 *
 * `buildTranscribePrompt`'s `extra` parameter has always been documented as "any extra proper
 * nouns, e.g. attached repo names". Its one caller passed a single string — the instance's own
 * name — while the repo names, the terminal targets and the subordinate agents the user says out
 * loud all sat in the database the page had already read. In the reported thread (#371) the user
 * said **tmux** and the browser returned **Timo**; every session name was knowable from a call the
 * agent had made three times in that same conversation.
 *
 * Asking a user to type a word into a settings box (#373) to fix one the platform can enumerate is
 * the wrong first move, so this lands first: no UI, no migration, no user effort.
 *
 * ── THE ENTRY RULE
 *
 * A term earns a place only if it is BOTH **likely to be said aloud** and **likely to be
 * mis-heard**. The same rule is stated at the top of `packages/sdk/src/voice/prompt.ts` and both
 * ends of the pipe have to apply it, because the budget is shared.
 *
 * IN:
 *   - the instance's display name and its agent's name — what the user calls the thing they are
 *     talking to, and by construction not an English word ("Heartfull", "Coder Lead")
 *   - attached coding repo names and their `owner/repo` — said constantly ("what's on platform?")
 *   - the names of subordinate instances — said aloud precisely to delegate ("ask the auditor")
 *
 * OUT, deliberately, though every one is a column away:
 *   - clone URLs, `workdir` paths, branch names, session ids, ids of any kind. Enumerable and
 *     never spoken in that form; a bias term nobody says is pure dilution.
 *   - collection names and file names. Said sometimes, but they are ordinary words far more often
 *     than not ("notes", "leads", "resume"), so they are the wrong side of the second half of the
 *     rule — and biasing an ordinary word bends real speech toward it.
 *   - tmux/terminal targets, which #372 lists first. They live on the RUNNER, not in D1: reading
 *     them means a relay round trip on the voice-config path, which is the one path #284 spent
 *     effort taking round trips OUT of. The static `TMUX_TERMS` list (#371) covers the vocabulary
 *     that made that agent's turns fail; a live target list can follow if the names turn out to
 *     be the residual failure.
 *
 * ── THE #332 INTERACTION
 *
 * Everything here is a proper noun, which is exactly the class that comes back verbatim from a
 * low-information clip and reads as the user's own words. `isTranscribeBiasEcho` catches the
 * MULTI-word case only, and deliberately so. Two things keep this the right trade anyway: every
 * multi-token identifier ships its spoken form beside it (`ProAgentStore/platform` →
 * "Pro Agent Store platform"), so the echo of either is caught; and the list is capped hard, so
 * the number of single-word candidates a silent clip can reach for stays small and stays the
 * user's OWN vocabulary rather than a generic list. The residual risk — a one-word agent or repo
 * name echoed alone — is real, is uncaught, and is the price of the bias being useful at all.
 */

import type { Env } from "../types.js";

/** How many derived terms may be sent. Deliberately below the SDK's MAX_EXTRA_TERMS (30): a
 *  user-configured vocabulary (#373) shares the same budget and must not be crowded out by
 *  machine-derived names, which are the less deliberate half of the list. */
export const MAX_DERIVED_TERMS = 20;

/** Longer than this is not a word anyone says in one breath — it is a path or a sentence. */
const MAX_TERM_LEN = 40;
/** A hex-ish blob of this length or more is an id, whatever column it arrived in. */
const ID_LIKE = /^[0-9a-f]{8,}$/i;

/**
 * Clean a raw list of names into bias terms: in order, deduped case-insensitively, capped.
 *
 * PURE — the whole judgement about what a usable term is lives here, so it is testable without a
 * database and so the rule above is enforced in one place rather than at each query.
 */
export function pickVocabularyTerms(raw: (string | null | undefined)[], limit = MAX_DERIVED_TERMS): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of raw) {
		const term = (value || "").trim();
		if (!term || term.length > MAX_TERM_LEN) continue;
		// Two characters bias nothing and collide with everything; a token with no letters is an
		// id or a number; an id is an id even when it is spelled out of a `name` column.
		if (term.length < 3 || !/\p{L}/u.test(term) || ID_LIKE.test(term)) continue;
		// A URL or an absolute path is a thing nobody pronounces. `owner/repo` survives, which is
		// the shape we want — it has no scheme and no leading slash.
		if (/^[a-z]+:\/\//i.test(term) || term.startsWith("/") || term.startsWith("~")) continue;
		const key = term.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(term);
		if (out.length >= limit) break;
	}
	return out;
}

/**
 * The derived vocabulary for one instance, most-relevant-first so the cap truncates the tail.
 *
 * Ordered: what the user calls THIS agent, then its repos newest-first (a repo attached five
 * minutes ago is the one being talked about), then the agents it can delegate to. Every query is
 * `user_id`-scoped like the rest of the instance surface.
 *
 * Never throws: a bias list is an accuracy nicety, and a failed read here must degrade to the
 * static term lists rather than fail the voice-settings load that carries it.
 */
export async function deriveVoiceVocabulary(env: Env, instanceId: string, userId: string): Promise<string[]> {
	try {
		const [self, repos, subordinates] = await Promise.all([
			env.DB.prepare(
				`SELECT i.config AS config, a.name AS agent_name
				   FROM agent_instances i JOIN agents a ON a.id = i.agent_id
				  WHERE i.id = ?1 AND i.user_id = ?2`,
			)
				.bind(instanceId, userId)
				.first<{ config: string | null; agent_name: string | null }>(),
			env.DB.prepare(
				`SELECT name, github_repo FROM coding_repos
				  WHERE instance_id = ?1 AND user_id = ?2 ORDER BY updated_at DESC LIMIT 20`,
			)
				.bind(instanceId, userId)
				.all<{ name: string | null; github_repo: string | null }>(),
			env.DB.prepare(
				`SELECT i.config AS config, a.name AS agent_name
				   FROM agent_supervision s
				   JOIN agent_instances i ON i.id = s.subordinate_instance_id
				   JOIN agents a ON a.id = i.agent_id
				  WHERE s.supervisor_instance_id = ?1 AND s.user_id = ?2 AND s.enabled = 1 LIMIT 10`,
			)
				.bind(instanceId, userId)
				.all<{ config: string | null; agent_name: string | null }>(),
		]);
		const displayName = (row: { config: string | null } | null): string => {
			if (!row?.config) return "";
			try {
				const o = JSON.parse(row.config) as { displayName?: unknown; name?: unknown };
				const n = typeof o.displayName === "string" ? o.displayName : typeof o.name === "string" ? o.name : "";
				return n;
			} catch {
				return "";
			}
		};
		const terms: (string | null | undefined)[] = [displayName(self), self?.agent_name];
		for (const r of repos.results || []) {
			terms.push(r.name);
			// The repo half of `owner/repo` as well as the whole: "platform" is what gets said,
			// "ProAgentStore/platform" is what gets written, and the two spellings bias differently.
			if (r.github_repo) terms.push(r.github_repo, r.github_repo.split("/").pop());
		}
		for (const s of subordinates.results || []) terms.push(displayName(s), s.agent_name);
		return pickVocabularyTerms(terms);
	} catch {
		return [];
	}
}
