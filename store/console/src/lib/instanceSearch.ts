// Type-to-filter over the instances you already have (#795).
//
// Client-side and nothing else. The array this filters is the one `GET /v1/instances/my/instances`
// already returned IN FULL — that endpoint has no pagination and no query parameter — so there is
// no round trip to spend and no server state to reconcile. Filtering is a pure function over that
// array precisely so it can be tested as a value: this console has no component harness, and the
// matching is the part worth proving. Same seam `lastRoute.ts` draws for #794.
//
// ── What is matched, and what deliberately is not
//
// Substring, case-insensitive, over the two fields that NAME an instance:
//
//   name   what the card's title shows, and what a rename writes. There is no separate
//          `nickname` column on `Instance` — #795 asks for "name/nickname/slug", and a renamed
//          instance's nickname IS its `name`. Both halves of that phrasing land here.
//   slug   the stable handle. Not on the card, but it is what appears in URLs and in every MCP
//          tool call, so it is frequently the string a user actually has in mind.
//
// NOT `description`. It is prose, it is the longest field on the card, and a two-letter query
// would match most of the list through it — a filter that narrows nothing is worse than no filter,
// because the user reads the result as "these all matched" and stops looking. Nor is it fuzzy or
// token-wise: #795 scoped this to substring explicitly, so "app assistant" does not find "Job
// Application Assistant". That is a real limit and a deliberate one; loosening it later is additive
// and this module is where it would happen.

import type { Instance } from "./types";

/**
 * A query reduced to what matching actually uses.
 *
 * Trimmed because a trailing space is what typing looks like mid-word, and an untrimmed " job"
 * matches nothing — the list would blank on a keystroke the user cannot see. Empty means no filter.
 */
export function normalizeQuery(q: string): string {
	return (q || "").trim().toLowerCase();
}

/**
 * Does one instance match?
 *
 * Normalizes its own query rather than trusting the caller to have done it. The alternative —
 * documenting "q must already be lowercased" — is a contract that reads fine and silently returns
 * NO MATCHES the first time someone passes raw input. At this list size the repeated normalize
 * costs nothing worth the trap.
 */
export function instanceMatches(inst: Instance, query: string): boolean {
	const q = normalizeQuery(query);
	if (!q) return true;
	return (inst.name || "").toLowerCase().includes(q) || (inst.slug || "").toLowerCase().includes(q);
}

/**
 * The instances to render for `query`.
 *
 * An empty query returns the SAME array, not a copy. This runs on every keystroke and on every
 * render of the tab, and handing back a fresh array for an unchanged list is a new identity for no
 * new content — the thing that makes a `useMemo` or a memoized child downstream quietly useless.
 */
export function filterInstances(instances: Instance[], query: string): Instance[] {
	const q = normalizeQuery(query);
	if (!q) return instances;
	return instances.filter((inst) => instanceMatches(inst, q));
}
