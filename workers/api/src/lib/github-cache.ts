/**
 * GitHub conditional requests — "don't fetch if nothing changed", made true (#401).
 *
 * There are two caching layers between the console and GitHub and the repo only had the cheap
 * one. `routes/coding-repos.ts` computes a weak ETag over the MERGED build list and answers the
 * browser's `If-None-Match` with a 304 — that saves bytes and re-renders, and it happens AFTER
 * GitHub has already been called. This module is the other layer: we store the ETag GitHub itself
 * returned and send it back as `If-None-Match`, so an unchanged resource costs a 304 instead of a
 * body and does not spend the REST primary rate limit at all.
 *
 * ── A 304 is still a request ──
 *
 * The primary rate limit is the only budget a 304 is exempt from. Secondary/abuse limits still
 * count it, and so does GitHub's patience. So this is a mechanism for making an EXISTING poll
 * cheaper, not a licence to poll harder: every caller keeps the interval it had.
 *
 * ── THE CACHE KEY IS A TENANCY BOUNDARY ──
 *
 * `SECURITY.md` names the GitHub-App installation binding as the thing that stops cross-tenant
 * private-repo access: a token mints only for an installation this user has been VERIFIED to
 * control (`lib/github-app.ts`). A cache keyed by `(repo, resource)` would route straight around
 * that — one tenant's authorised fetch populates an entry, and a second tenant with no
 * installation on that repo reads the private issue list out of it without a single GitHub call
 * to discover they may not. The whole point of a cache is that the second read does not go and
 * ask.
 *
 * So the key is `(user, repo, resource)` and the ENTRY additionally records the auth context it
 * was fetched under (`anon` or `installation:<id>`). A hit requires all four to match the caller —
 * user, auth context, repo, resource. Anything else, including a differing auth context or an
 * entry this module did not write, is a MISS, never a hit: fail closed.
 *
 * The auth context is carried in the entry rather than in the key on purpose. The user is already
 * the isolation boundary, so per-auth KEYS would buy no isolation — but they would make write
 * invalidation unable to name the entry it has to drop, because nothing at a write site knows
 * which auth contexts a user has previously read under. That is the failure this module's
 * `invalidateGithubCache` exists to prevent (see below), so the entry-side check is strictly
 * better: it is the same fail-closed answer AND one deletable key. There is deliberately NO
 * cross-user sharing of public-repo entries; if that is ever wanted it is a separate, explicit
 * decision that puts the auth state in the key.
 *
 * ── Invalidation on our own writes ──
 *
 * `github_create_issue` opens an issue and the very next `github_list_issues` must not read the
 * pre-write entry — that is `agent-think.ts`'s documented `get_tasks`-after-`create_task` failure
 * reappearing one layer out. A mutating call site drops the `(user, repo, issues)` entry, which is
 * one line and much cheaper than a TTL short enough to hide the problem.
 *
 * Storage is KV (`OAUTH_KV`, the only provisioned namespace, under a `ghcond:` prefix — the same
 * reasoning as `lib/build-history.ts`). With no KV binding the cache is simply OFF and every
 * caller behaves exactly as it did before this module existed.
 */
import { installationTokenForOwner, listUserInstallations } from "./github-app.js";
import type { Env } from "../types.js";

/** Bumped when the entry shape changes — an old entry then fails the shape check and is a miss. */
const ENTRY_VERSION = 1;

/** How long an untouched entry survives in KV. It is a cache, not a history. */
const ENTRY_TTL_SECONDS = 24 * 60 * 60;

/**
 * How many query VARIANTS one entry holds (open issues, closed issues, a label filter…).
 *
 * Variants live inside a single entry rather than in keys of their own precisely so invalidation
 * can drop every variant of a resource with one delete. Beyond the cap the least recently fetched
 * is evicted: overflowing simply costs a normal fetch, which is what the caller did before.
 */
const MAX_VARIANTS = 8;

/** Don't store a payload bigger than this. A cache is not a place to discover a KV size limit. */
const MAX_PAYLOAD_BYTES = 256 * 1024;

/**
 * The auth context an entry was fetched under. `anon` is an unauthenticated read (public repos,
 * ~60/hr shared IP); `installation:<id>` is a verified GitHub-App installation binding.
 */
export type GithubAuthContext = string;

interface CacheVariant {
	etag: string;
	payload: unknown;
	/** ms epoch of the fetch that produced it — the eviction order and the staleness report. */
	at: number;
}

interface GithubCacheEntry {
	v: number;
	user: string;
	auth: GithubAuthContext;
	repo: string;
	resource: string;
	variants: Record<string, CacheVariant>;
}

/** The identity a cached read is made under. `authContext: null` means "do not cache at all". */
export interface GithubCacheIdentity {
	userId: string;
	authContext: GithubAuthContext | null;
}

/** Normalised repo coordinate — GitHub is case-insensitive about owner/name, KV is not. */
function normRepo(repo: string): string {
	return String(repo || "").trim().toLowerCase();
}

/**
 * The KV key: `(user, repo, resource)`. The user is IN the key — that is the tenancy boundary,
 * and the reason a repo-keyed cache was rejected.
 */
export function githubCacheKey(userId: string, repo: string, resource: string): string {
	return `ghcond:${ENTRY_VERSION}:${userId}:${normRepo(repo)}:${resource}`;
}

/**
 * The auth context for a read, or `null` when the read must not be cached.
 *
 * `null` (fail closed) covers three cases: no KV binding at all; an authenticated read whose
 * installation we cannot name; and anything that throws. Not caching costs a request. Caching
 * under a context we could not establish is what this module is written to prevent.
 */
export async function githubAuthContext(env: Env, userId: string, owner: string, token: string | null): Promise<GithubAuthContext | null> {
	if (!env.OAUTH_KV || !userId) return null;
	if (!token) return "anon";
	try {
		const installs = await listUserInstallations(env, userId);
		const match = installs.find((i) => i.account?.toLowerCase() === String(owner || "").toLowerCase());
		return match ? `installation:${match.id}` : null;
	} catch {
		return null;
	}
}

/** Token + auth context together, for the callers that need both. Never throws. */
export async function resolveGithubRead(env: Env, userId: string, owner: string): Promise<{ token: string | null; authContext: GithubAuthContext | null }> {
	const token = await installationTokenForOwner(env, userId, owner).catch(() => null);
	return { token, authContext: await githubAuthContext(env, userId, owner, token) };
}

/**
 * Read the stored entry, and return it ONLY if it belongs to this caller.
 *
 * Every field is re-checked against the caller rather than trusted from the key: user, auth
 * context, repo and resource. A mismatch is a MISS. Exported for the tests that drive exactly
 * that — the cross-tenant one is the deliverable of #401's self-review.
 */
export async function readGithubCache(env: Env, id: GithubCacheIdentity, repo: string, resource: string): Promise<GithubCacheEntry | null> {
	if (!env.OAUTH_KV || !id.authContext) return null;
	try {
		const raw = await env.OAUTH_KV.get(githubCacheKey(id.userId, repo, resource));
		if (!raw) return null;
		const entry = JSON.parse(raw) as GithubCacheEntry;
		if (!entry || typeof entry !== "object" || entry.v !== ENTRY_VERSION) return null;
		// Fail closed. Any one of these not matching means the stored bytes were fetched under a
		// different authority than the caller has, so they are not this caller's to read.
		if (entry.user !== id.userId) return null;
		if (entry.auth !== id.authContext) return null;
		if (entry.repo !== normRepo(repo)) return null;
		if (entry.resource !== resource) return null;
		if (!entry.variants || typeof entry.variants !== "object") return null;
		return entry;
	} catch {
		return null;
	}
}

/** Best-effort write of one variant, merged into the caller's own entry. Never throws. */
async function writeGithubCache(
	env: Env,
	id: GithubCacheIdentity,
	repo: string,
	resource: string,
	variant: string,
	value: CacheVariant,
): Promise<void> {
	if (!env.OAUTH_KV || !id.authContext) return;
	try {
		const existing = await readGithubCache(env, id, repo, resource);
		const variants: Record<string, CacheVariant> = { ...(existing?.variants ?? {}), [variant]: value };
		// Evict the least recently fetched rather than the first inserted — the recently-read
		// variant is the one a poll will ask for again.
		const keys = Object.keys(variants);
		if (keys.length > MAX_VARIANTS) {
			keys.sort((a, b) => (variants[a].at ?? 0) - (variants[b].at ?? 0));
			for (const k of keys.slice(0, keys.length - MAX_VARIANTS)) delete variants[k];
		}
		const entry: GithubCacheEntry = {
			v: ENTRY_VERSION,
			user: id.userId,
			auth: id.authContext,
			repo: normRepo(repo),
			resource,
			variants,
		};
		const body = JSON.stringify(entry);
		if (body.length > MAX_PAYLOAD_BYTES) return;
		await env.OAUTH_KV.put(githubCacheKey(id.userId, repo, resource), body, { expirationTtl: ENTRY_TTL_SECONDS });
	} catch {
		// best-effort: a storage failure must never fail the read path
	}
}

/**
 * Drop every variant of `(user, repo, resource)`.
 *
 * Called from the platform's OWN write paths (opening an issue), so an agent cannot read back the
 * list it just changed. Never throws — a failed invalidation must not fail the write that
 * succeeded, and the next fetch is a normal conditional request either way.
 */
export async function invalidateGithubCache(env: Env, userId: string, repo: string, resource: string): Promise<void> {
	if (!env.OAUTH_KV || !userId) return;
	try {
		await env.OAUTH_KV.delete(githubCacheKey(userId, repo, resource));
	} catch {
		// best-effort
	}
}

export type ConditionalResult<T> =
	| { ok: true; data: T; fromCache: boolean; stale: boolean }
	| { ok: false; status: number | null };

export interface ConditionalFetchArgs {
	/** Who is asking, and under what authority — decides whether anything is cached at all. */
	identity: GithubCacheIdentity;
	/** `owner/name`, for the key. */
	repo: string;
	/** The resource family — `issues`, `issue`, `pulls`, `pull`, `reviews`, `runs`. */
	resource: string;
	/** What distinguishes this read WITHIN the resource (the query string, an issue number). */
	variant: string;
	url: string;
	headers: Record<string, string>;
}

/**
 * Fetch JSON from GitHub with `If-None-Match`, serving the stored payload on 304.
 *
 * Failure handling is deliberately asymmetric, because the two kinds of failure mean opposite
 * things:
 *
 *   • 401/403/404/410 — access CHANGED (an installation was removed, a repo went private). The
 *     stored copy was fetched under an authority the caller may no longer have, so it is dropped
 *     and the error is reported. Serving it would be exactly the cross-tenant read this module
 *     exists to prevent, only separated in time rather than between accounts.
 *   • 5xx / 429 / a network error — GitHub is UNREACHABLE, which says nothing about permission.
 *     The stored copy is served and flagged `stale`, the same graceful degradation the durable
 *     build history already gives `/deployments`.
 */
export async function githubConditionalJson<T>(env: Env, args: ConditionalFetchArgs): Promise<ConditionalResult<T>> {
	const { identity, repo, resource, variant, url } = args;
	const entry = await readGithubCache(env, identity, repo, resource);
	const cached = entry?.variants?.[variant];
	const headers = { ...args.headers, ...(cached?.etag ? { "If-None-Match": cached.etag } : {}) };

	let res: Response;
	try {
		res = await fetch(url, { headers });
	} catch {
		return cached ? { ok: true, data: cached.payload as T, fromCache: true, stale: true } : { ok: false, status: null };
	}

	if (res.status === 304) {
		// A 304 without a stored payload can only mean the entry vanished between the read and the
		// response. There is nothing to serve, and inventing an empty list would report "no issues"
		// for a repo full of them.
		return cached ? { ok: true, data: cached.payload as T, fromCache: true, stale: false } : { ok: false, status: 304 };
	}

	if (!res.ok) {
		if (res.status === 401 || res.status === 403 || res.status === 404 || res.status === 410) {
			await invalidateGithubCache(env, identity.userId, repo, resource);
			return { ok: false, status: res.status };
		}
		return cached ? { ok: true, data: cached.payload as T, fromCache: true, stale: true } : { ok: false, status: res.status };
	}

	let data: T;
	try {
		data = (await res.json()) as T;
	} catch {
		return cached ? { ok: true, data: cached.payload as T, fromCache: true, stale: true } : { ok: false, status: res.status };
	}
	// `headers` is optional on the Response doubles several suites hand us, and a missing ETag is
	// simply "this resource is not conditional" — store nothing and fetch normally next time.
	const etag = res.headers?.get?.("etag") ?? null;
	if (etag) await writeGithubCache(env, identity, repo, resource, variant, { etag, payload: data, at: Date.now() });
	return { ok: true, data, fromCache: false, stale: false };
}
