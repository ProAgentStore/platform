/** #1713 — the pull request an isolated-pr run opens: idempotent, never throws, and refuses what it cannot place. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types.js";

const token = vi.hoisted(() => ({ value: "ghs_test" as string | null }));
vi.mock("./github-app.js", () => ({ installationTokenForOwner: async () => token.value }));
const { openRunPullRequest } = await import("./github-pr-open.js");

const INPUT = { githubRepo: "o/r", head: "pags/run/x", base: "main", title: "Fix it", body: "body" };
const env = {} as Env;
let calls: Array<{ url: string; method: string; body?: string }>;
const reply = (...responses: Array<{ status: number; json?: unknown }>) => {
	const queue = [...responses];
	vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
		calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
		const r = queue.shift() ?? { status: 500 };
		return new Response(JSON.stringify(r.json ?? {}), { status: r.status });
	});
};
beforeEach(() => {
	calls = [];
	token.value = "ghs_test";
});
afterEach(() => vi.unstubAllGlobals());

describe("openRunPullRequest", () => {
	it("opens a pull request from the run branch to the target", async () => {
		reply({ status: 201, json: { number: 12, html_url: "https://github.com/o/r/pull/12" } });
		expect(await openRunPullRequest(env, "u1", INPUT)).toEqual({ ok: true, number: 12, url: "https://github.com/o/r/pull/12", existed: false });
		expect(calls[0]).toMatchObject({ url: "https://api.github.com/repos/o/r/pulls", method: "POST" });
		expect(JSON.parse(calls[0].body ?? "{}")).toMatchObject({ head: "pags/run/x", base: "main", title: "Fix it" });
	});

	it("a replay finds the pull request that is already open instead of failing or duplicating", async () => {
		reply({ status: 422, json: { message: "A pull request already exists" } }, { status: 200, json: [{ number: 12, html_url: "https://github.com/o/r/pull/12" }] });
		expect(await openRunPullRequest(env, "u1", INPUT)).toMatchObject({ ok: true, number: 12, existed: true });
		expect(calls[1].url).toContain("head=o%3Apags%2Frun%2Fx");
	});

	it("says what failed, without throwing", async () => {
		reply({ status: 403 });
		expect(await openRunPullRequest(env, "u1", INPUT)).toEqual({ ok: false, error: "GitHub returned 403 opening the pull request" });
		vi.stubGlobal("fetch", async () => {
			throw new Error("boom");
		});
		expect(await openRunPullRequest(env, "u1", INPUT)).toMatchObject({ ok: false, error: expect.stringContaining("boom") });
	});

	it("refuses without an installation covering the owner, and a repository name that could smuggle a path", async () => {
		token.value = null;
		expect(await openRunPullRequest(env, "u1", INPUT)).toMatchObject({ ok: false, error: expect.stringContaining("no GitHub App installation") });
		token.value = "ghs_test";
		expect(await openRunPullRequest(env, "u1", { ...INPUT, githubRepo: "o/r?x=1" })).toMatchObject({ ok: false });
		expect(await openRunPullRequest(env, "u1", { ...INPUT, githubRepo: "o/r/extra" })).toMatchObject({ ok: false });
		expect(calls).toEqual([]);
	});
});
