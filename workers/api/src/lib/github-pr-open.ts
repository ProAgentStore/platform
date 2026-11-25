/**
 * Open the pull request for an isolated-pr run (#1713, a slice of #1670).
 *
 * This is the ONE place the platform opens a pull request on its own, and it exists for one case: a repository whose owner chose the
 * `isolated-pr` preset. The caller (`isolated-run.ts`) checks the stored preset before it gets here; this module never decides to open
 * a PR, it only opens the one it was asked for, from a branch the runner has already pushed and read back. It merges nothing, closes
 * nothing and reviews nothing (`github-prs.ts` stays read-only).
 *
 * Idempotent: GitHub refuses a second PR for the same head/base (422), so a retried or replayed publish finds and returns the open one
 * instead of failing or duplicating. Never throws — a failure is a value the caller says out loud, and the pushed branch is untouched.
 */
import { installationTokenForOwner } from "./github-app.js";
import type { Env } from "../types.js";

const SEGMENT = /^[A-Za-z0-9._-]+$/;

const headers = (token: string) => ({
	Authorization: `token ${token}`,
	Accept: "application/vnd.github+json",
	"X-GitHub-Api-Version": "2022-11-28",
	"User-Agent": "proagentstore-coding/1.0",
	"Content-Type": "application/json",
});

export type OpenPrResult = { ok: true; number: number; url: string; existed: boolean } | { ok: false; error: string };

export async function openRunPullRequest(env: Env, userId: string, input: { githubRepo: string; head: string; base: string; title: string; body: string }): Promise<OpenPrResult> {
	const [owner, name, ...rest] = input.githubRepo.split("/");
	if (!owner || !name || rest.length || !SEGMENT.test(owner) || !SEGMENT.test(name)) return { ok: false, error: `unusable repository "${input.githubRepo}"` };
	const token = await installationTokenForOwner(env, userId, owner).catch(() => null);
	if (!token) return { ok: false, error: `no GitHub App installation covers ${owner}, so the pull request could not be opened` };
	const base = `https://api.github.com/repos/${owner}/${name}`;
	try {
		const res = await fetch(`${base}/pulls`, { method: "POST", headers: headers(token), body: JSON.stringify({ title: input.title.slice(0, 250), head: input.head, base: input.base, body: input.body.slice(0, 60_000) }) });
		if (res.ok) {
			const pr = (await res.json()) as { number?: number; html_url?: string };
			return typeof pr.number === "number" && pr.html_url ? { ok: true, number: pr.number, url: pr.html_url, existed: false } : { ok: false, error: "GitHub accepted the pull request but did not say which one" };
		}
		if (res.status === 422) {
			// Most likely "a pull request already exists for <head>": look it up rather than fail a replay.
			const found = await fetch(`${base}/pulls?state=open&head=${encodeURIComponent(`${owner}:${input.head}`)}&base=${encodeURIComponent(input.base)}&per_page=1`, { headers: headers(token) });
			if (found.ok) {
				const [pr] = (await found.json()) as Array<{ number?: number; html_url?: string }>;
				if (pr && typeof pr.number === "number" && pr.html_url) return { ok: true, number: pr.number, url: pr.html_url, existed: true };
			}
		}
		return { ok: false, error: `GitHub returned ${res.status} opening the pull request` };
	} catch (e) {
		return { ok: false, error: `could not reach GitHub to open the pull request (${e instanceof Error ? e.message.slice(0, 120) : "network error"})` };
	}
}
