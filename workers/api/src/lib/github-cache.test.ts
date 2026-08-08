/**
 * The GitHub conditional-request cache (#401), and above all the thing it must never become.
 *
 * `SECURITY.md` names the verified GitHub-App installation binding as what stops cross-tenant
 * private-repo access. A cache is a way to answer without asking — so a cache keyed loosely enough
 * to be shared between accounts routes straight around that binding, and does it silently: the
 * second tenant's read never reaches GitHub to discover it was not allowed. The first describe
 * block below is the deliverable of the issue's self-review.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	githubAuthContext,
	githubCacheKey,
	githubConditionalJson,
	invalidateGithubCache,
	readGithubCache,
} from "./github-cache.js";
import { fetchWorkflowRuns } from "./github-actions.js";
import type { Env } from "../types.js";

vi.mock("./github-app.js", () => ({
	installationTokenForOwner: vi.fn(async () => "tok"),
	listUserInstallations: vi.fn(async (_e: unknown, userId: string) =>
		userId === "alice" ? [{ id: 11, account: "acme", type: "Organization" }] : [],
	),
}));

/** An in-memory KV that behaves like `OAUTH_KV` — get/put/delete over a plain Map. */
function kvEnv() {
	const store = new Map<string, string>();
	const env = {
		OAUTH_KV: {
			get: async (k: string) => store.get(k) ?? null,
			put: async (k: string, v: string) => {
				store.set(k, v);
			},
			delete: async (k: string) => {
				store.delete(k);
			},
		},
	} as unknown as Env;
	return { env, store };
}

/** A Response double with real headers, so the ETag round-trip is actually exercised. */
function ghResponse(status: number, body: unknown, etag?: string) {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: { get: (h: string) => (h.toLowerCase() === "etag" && etag ? etag : null) },
		json: async () => body,
	} as unknown as Response;
}

afterEach(() => {
	vi.restoreAllMocks();
});

const ALICE = { userId: "alice", authContext: "installation:11" };
const BOB = { userId: "bob", authContext: "installation:11" };

async function seedAlice(env: Env) {
	globalThis.fetch = vi.fn(async () => ghResponse(200, [{ number: 1, title: "private thing" }], 'W/"e1"')) as unknown as typeof fetch;
	return githubConditionalJson<Array<{ number: number }>>(env, {
		identity: ALICE,
		repo: "acme/secret",
		resource: "issues",
		variant: "state=open",
		url: "https://api.github.com/repos/acme/secret/issues?state=open",
		headers: {},
	});
}

describe("the cache key is a tenancy boundary", () => {
	it("puts the user IN the key, so two tenants cannot land on the same entry", () => {
		expect(githubCacheKey("alice", "acme/secret", "issues")).not.toBe(githubCacheKey("bob", "acme/secret", "issues"));
		expect(githubCacheKey("alice", "acme/secret", "issues")).toContain("alice");
	});

	it("normalises the repo's case — GitHub is case-insensitive about owner/name and KV is not", () => {
		expect(githubCacheKey("alice", "ACME/Secret", "issues")).toBe(githubCacheKey("alice", "acme/secret", "issues"));
	});

	it("does NOT serve one tenant's authorised fetch to another tenant", async () => {
		const { env } = kvEnv();
		const seeded = await seedAlice(env);
		expect(seeded).toMatchObject({ ok: true, fromCache: false });

		// Bob has the same auth CONTEXT string (a deliberately hostile setup — it removes the
		// "different installation id saved him" escape) and is simply a different account.
		expect(await readGithubCache(env, BOB, "acme/secret", "issues")).toBeNull();

		// And the miss is not merely "no hit": Bob's read must actually go to GitHub, where his own
		// lack of access is decided, rather than being answered locally.
		const fetchSpy = vi.fn(async () => ghResponse(404, { message: "Not Found" }));
		globalThis.fetch = fetchSpy as unknown as typeof fetch;
		const bob = await githubConditionalJson(env, {
			identity: BOB,
			repo: "acme/secret",
			resource: "issues",
			variant: "state=open",
			url: "https://api.github.com/repos/acme/secret/issues?state=open",
			headers: {},
		});
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(bob).toEqual({ ok: false, status: 404 });
	});

	it("treats a DIFFERENT auth context on the same user as a miss — fail closed, not a hit", async () => {
		const { env } = kvEnv();
		await seedAlice(env);
		// Same account, but the read is now unauthenticated (the App was uninstalled). The bytes
		// stored were fetched under an installation she may no longer have.
		expect(await readGithubCache(env, { userId: "alice", authContext: "anon" }, "acme/secret", "issues")).toBeNull();
	});

	it("refuses to cache at all when the auth context cannot be established", async () => {
		const { env, store } = kvEnv();
		globalThis.fetch = vi.fn(async () => ghResponse(200, [], 'W/"e"')) as unknown as typeof fetch;
		await githubConditionalJson(env, {
			identity: { userId: "alice", authContext: null },
			repo: "acme/secret",
			resource: "issues",
			variant: "state=open",
			url: "https://x",
			headers: {},
		});
		expect(store.size).toBe(0);
	});

	it("is OFF entirely with no KV binding — every caller behaves exactly as before", async () => {
		const env = {} as Env;
		expect(await githubAuthContext(env, "alice", "acme", "tok")).toBeNull();
		expect(await readGithubCache(env, ALICE, "acme/secret", "issues")).toBeNull();
	});

	it("names an authenticated read by its verified installation, and an unauthenticated one anon", async () => {
		const { env } = kvEnv();
		expect(await githubAuthContext(env, "alice", "acme", "tok")).toBe("installation:11");
		expect(await githubAuthContext(env, "alice", "acme", null)).toBe("anon");
		// Bob holds a token for an installation he has no verified binding to — unnameable, so
		// uncacheable. Fail closed.
		expect(await githubAuthContext(env, "bob", "acme", "tok")).toBeNull();
	});
});

describe("conditional requests — the ETag round trip", () => {
	it("sends the stored ETag back and serves the cached payload on 304", async () => {
		const { env } = kvEnv();
		await seedAlice(env);
		let sent: Record<string, string> = {};
		globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
			sent = (init?.headers ?? {}) as Record<string, string>;
			return ghResponse(304, null);
		}) as unknown as typeof fetch;
		const again = await githubConditionalJson<Array<{ number: number }>>(env, {
			identity: ALICE,
			repo: "acme/secret",
			resource: "issues",
			variant: "state=open",
			url: "https://api.github.com/repos/acme/secret/issues?state=open",
			headers: {},
		});
		expect(sent["If-None-Match"]).toBe('W/"e1"');
		expect(again).toMatchObject({ ok: true, fromCache: true, stale: false });
		expect(again.ok && again.data[0].number).toBe(1);
	});

	it("keeps query variants apart, so a closed-issue read cannot be served to an open-issue one", async () => {
		const { env } = kvEnv();
		await seedAlice(env);
		globalThis.fetch = vi.fn(async () => ghResponse(200, [{ number: 9 }], 'W/"e2"')) as unknown as typeof fetch;
		const closed = await githubConditionalJson<Array<{ number: number }>>(env, {
			identity: ALICE,
			repo: "acme/secret",
			resource: "issues",
			variant: "state=closed",
			url: "https://x",
			headers: {},
		});
		expect(closed).toMatchObject({ fromCache: false });
		// Both variants now live in the SAME entry — which is what makes one delete drop them all.
		const entry = await readGithubCache(env, ALICE, "acme/secret", "issues");
		expect(Object.keys(entry?.variants ?? {}).sort()).toEqual(["state=closed", "state=open"]);
	});

	it("drops the entry on 403/404 — access CHANGED, so the stored copy is not ours to serve", async () => {
		const { env, store } = kvEnv();
		await seedAlice(env);
		expect(store.size).toBe(1);
		globalThis.fetch = vi.fn(async () => ghResponse(403, { message: "Forbidden" })) as unknown as typeof fetch;
		const r = await githubConditionalJson(env, {
			identity: ALICE,
			repo: "acme/secret",
			resource: "issues",
			variant: "state=open",
			url: "https://x",
			headers: {},
		});
		expect(r).toEqual({ ok: false, status: 403 });
		expect(store.size).toBe(0);
	});

	it("serves a STALE copy when GitHub is unreachable — that says nothing about permission", async () => {
		const { env } = kvEnv();
		await seedAlice(env);
		globalThis.fetch = vi.fn(async () => {
			throw new Error("network");
		}) as unknown as typeof fetch;
		const r = await githubConditionalJson<Array<{ number: number }>>(env, {
			identity: ALICE,
			repo: "acme/secret",
			resource: "issues",
			variant: "state=open",
			url: "https://x",
			headers: {},
		});
		expect(r).toMatchObject({ ok: true, fromCache: true, stale: true });
	});

	it("serves a stale copy on a 5xx / secondary-limit 429 too", async () => {
		const { env } = kvEnv();
		await seedAlice(env);
		for (const status of [429, 502]) {
			globalThis.fetch = vi.fn(async () => ghResponse(status, {})) as unknown as typeof fetch;
			const r = await githubConditionalJson(env, {
				identity: ALICE,
				repo: "acme/secret",
				resource: "issues",
				variant: "state=open",
				url: "https://x",
				headers: {},
			});
			expect(r).toMatchObject({ ok: true, stale: true });
		}
	});

	it("stores nothing when GitHub sent no ETag — nothing to be conditional about", async () => {
		const { env, store } = kvEnv();
		globalThis.fetch = vi.fn(async () => ghResponse(200, [{ number: 2 }])) as unknown as typeof fetch;
		const r = await githubConditionalJson(env, {
			identity: ALICE,
			repo: "acme/secret",
			resource: "issues",
			variant: "state=open",
			url: "https://x",
			headers: {},
		});
		expect(r).toMatchObject({ ok: true, fromCache: false });
		expect(store.size).toBe(0);
	});

	it("reports a 304 with nothing stored as a failure rather than inventing an empty list", async () => {
		const { env } = kvEnv();
		globalThis.fetch = vi.fn(async () => ghResponse(304, null)) as unknown as typeof fetch;
		const r = await githubConditionalJson(env, {
			identity: ALICE,
			repo: "acme/secret",
			resource: "issues",
			variant: "state=open",
			url: "https://x",
			headers: {},
		});
		expect(r).toEqual({ ok: false, status: 304 });
	});
});

/**
 * The `runs` resource, driven through `fetchWorkflowRuns` itself rather than through
 * `githubConditionalJson` directly (#418).
 *
 * Testing the cache module again would only re-prove the cache. What is new here is the WIRING —
 * that the identity reaches it, that the resource and variant are the ones this caller means, and
 * above all that mapping the cache's result union back onto `WorkflowRunsResult` did not lose the
 * two properties every caller of this function depends on: it never throws, and a failure is
 * always `{ status }`.
 */
describe("Actions runs go through the conditional cache (#418)", () => {
	const runsBody = (n: number) => ({ workflow_runs: [{ id: n, run_number: n, status: "completed", conclusion: "success" }] });

	async function seedRuns(env: Env, identity = ALICE) {
		globalThis.fetch = vi.fn(async () => ghResponse(200, runsBody(7), 'W/"r1"')) as unknown as typeof fetch;
		return fetchWorkflowRuns("acme/secret", "tok", { perPage: 1 }, { env, identity });
	}

	it("stores the runs page under the `runs` resource and replays it on a 304", async () => {
		const { env } = kvEnv();
		expect(await seedRuns(env)).toEqual({ runs: runsBody(7).workflow_runs });

		let sent: Record<string, string> = {};
		globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
			sent = (init?.headers ?? {}) as Record<string, string>;
			return ghResponse(304, null);
		}) as unknown as typeof fetch;
		const again = await fetchWorkflowRuns("acme/secret", "tok", { perPage: 1 }, { env, identity: ALICE });
		// The acceptance criterion: an unchanged repo's poll sends If-None-Match and spends no
		// primary rate limit, while still answering with the real runs.
		expect(sent["If-None-Match"]).toBe('W/"r1"');
		expect(again).toEqual({ runs: runsBody(7).workflow_runs });
	});

	it("keeps `runs` apart from `issues` on the same repo and user", async () => {
		const { env } = kvEnv();
		await seedAlice(env);
		await seedRuns(env);
		// Two entries, not one: a resource collision would serve an issues page as a builds page.
		expect(await readGithubCache(env, ALICE, "acme/secret", "runs")).not.toBeNull();
		expect(await readGithubCache(env, ALICE, "acme/secret", "issues")).not.toBeNull();
		expect(githubCacheKey("alice", "acme/secret", "runs")).not.toBe(githubCacheKey("alice", "acme/secret", "issues"));
	});

	it("keeps the query variants apart — a PR-checks page is not the Builds page", async () => {
		const { env } = kvEnv();
		await seedRuns(env); // per_page=1 — /builds and /deployment
		globalThis.fetch = vi.fn(async () => ghResponse(200, runsBody(8), 'W/"r2"')) as unknown as typeof fetch;
		await fetchWorkflowRuns("acme/secret", "tok", { perPage: 50, event: "pull_request" }, { env, identity: ALICE });
		const entry = await readGithubCache(env, ALICE, "acme/secret", "runs");
		expect(Object.keys(entry?.variants ?? {}).sort()).toEqual(["per_page=1", "per_page=50&event=pull_request"]);
	});

	it("does NOT serve one tenant's runs to another — the tenancy boundary holds for `runs` too", async () => {
		const { env } = kvEnv();
		await seedRuns(env);
		expect(await readGithubCache(env, BOB, "acme/secret", "runs")).toBeNull();

		// And Bob's read really goes to GitHub, where his own lack of access is decided.
		const fetchSpy = vi.fn(async () => ghResponse(404, { message: "Not Found" }));
		globalThis.fetch = fetchSpy as unknown as typeof fetch;
		const bob = await fetchWorkflowRuns("acme/secret", "tok", { perPage: 1 }, { env, identity: BOB });
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(bob).toEqual({ status: 404 });
	});

	it("a 403/404 INVALIDATES rather than serving the stored copy, and reports the status", async () => {
		const { env, store } = kvEnv();
		await seedRuns(env);
		expect(store.size).toBe(1);
		globalThis.fetch = vi.fn(async () => ghResponse(403, { message: "Forbidden" })) as unknown as typeof fetch;
		// Access CHANGED — the entry was fetched under an authority this caller may no longer have.
		expect(await fetchWorkflowRuns("acme/secret", "tok", { perPage: 1 }, { env, identity: ALICE })).toEqual({ status: 403 });
		expect(store.size).toBe(0);
	});

	it("a 5xx / network error still SERVES the stored copy — unreachable says nothing about permission", async () => {
		const { env } = kvEnv();
		await seedRuns(env);
		globalThis.fetch = vi.fn(async () => ghResponse(502, {})) as unknown as typeof fetch;
		expect(await fetchWorkflowRuns("acme/secret", "tok", { perPage: 1 }, { env, identity: ALICE })).toEqual({ runs: runsBody(7).workflow_runs });

		globalThis.fetch = vi.fn(async () => {
			throw new Error("network");
		}) as unknown as typeof fetch;
		expect(await fetchWorkflowRuns("acme/secret", "tok", { perPage: 1 }, { env, identity: ALICE })).toEqual({ runs: runsBody(7).workflow_runs });
	});

	it("NEVER throws, and always reports a failure as `{ status }` — the contract five callers degrade on", async () => {
		const { env } = kvEnv();
		// Nothing stored, and GitHub is unreachable: there is no copy to fall back to.
		globalThis.fetch = vi.fn(async () => {
			throw new Error("network");
		}) as unknown as typeof fetch;
		expect(await fetchWorkflowRuns("acme/secret", "tok", { perPage: 1 }, { env, identity: ALICE })).toEqual({ status: null });

		// A 304 with nothing stored is a failure, not an invented empty list — reporting `runs: []`
		// here would render "no builds" for a repo that has them.
		globalThis.fetch = vi.fn(async () => ghResponse(304, null)) as unknown as typeof fetch;
		expect(await fetchWorkflowRuns("acme/secret", "tok", { perPage: 1 }, { env, identity: ALICE })).toEqual({ status: 304 });
	});

	it("with NO identity supplied, behaves exactly as before — a plain fetch, nothing stored", async () => {
		const { store } = kvEnv();
		globalThis.fetch = vi.fn(async () => ghResponse(200, runsBody(3), 'W/"r9"')) as unknown as typeof fetch;
		expect(await fetchWorkflowRuns("acme/secret", "tok", { perPage: 1 })).toEqual({ runs: runsBody(3).workflow_runs });
		expect(store.size).toBe(0);
	});

	it("an unnameable auth context does not cache — it falls back to the plain fetch, not to someone else's entry", async () => {
		const { env, store } = kvEnv();
		await seedRuns(env); // Alice's entry exists.
		globalThis.fetch = vi.fn(async () => ghResponse(200, runsBody(4), 'W/"r4"')) as unknown as typeof fetch;
		const r = await fetchWorkflowRuns("acme/secret", "tok", { perPage: 1 }, { env, identity: { userId: "alice", authContext: null } });
		expect(r).toEqual({ runs: runsBody(4).workflow_runs });
		expect(store.size).toBe(1); // still only the seeded entry — nothing new written
	});
});

describe("invalidation on the platform's own writes", () => {
	it("drops EVERY variant of the resource with one delete", async () => {
		const { env } = kvEnv();
		await seedAlice(env);
		globalThis.fetch = vi.fn(async () => ghResponse(200, [{ number: 9 }], 'W/"e2"')) as unknown as typeof fetch;
		await githubConditionalJson(env, { identity: ALICE, repo: "acme/secret", resource: "issues", variant: "state=closed", url: "https://x", headers: {} });

		await invalidateGithubCache(env, "alice", "acme/secret", "issues");
		expect(await readGithubCache(env, ALICE, "acme/secret", "issues")).toBeNull();
	});

	it("after invalidation the next read really goes to GitHub, with NO If-None-Match", async () => {
		const { env } = kvEnv();
		await seedAlice(env);
		await invalidateGithubCache(env, "alice", "acme/secret", "issues");
		let sent: Record<string, string> = {};
		globalThis.fetch = vi.fn(async (_u: unknown, init?: RequestInit) => {
			sent = (init?.headers ?? {}) as Record<string, string>;
			return ghResponse(200, [{ number: 1 }, { number: 2 }], 'W/"e3"');
		}) as unknown as typeof fetch;
		const r = await githubConditionalJson<Array<{ number: number }>>(env, {
			identity: ALICE,
			repo: "acme/secret",
			resource: "issues",
			variant: "state=open",
			url: "https://x",
			headers: {},
		});
		expect(sent["If-None-Match"]).toBeUndefined();
		expect(r.ok && r.data).toHaveLength(2);
	});

	it("only touches the invalidated user — a shared repo does not clear someone else's entry", async () => {
		const { env, store } = kvEnv();
		await seedAlice(env);
		await invalidateGithubCache(env, "bob", "acme/secret", "issues");
		expect(store.size).toBe(1);
		expect(await readGithubCache(env, ALICE, "acme/secret", "issues")).not.toBeNull();
	});
});
