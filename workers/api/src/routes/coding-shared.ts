/**
 * What every module of the Coder control plane needs, and nothing else (#305).
 *
 * `routes/coding.ts` was one 1778-line file holding 39 routes. The seams it split along —
 * repos, the LLM-driven brains, diagnostics — each needed the same four things: the tenant
 * gate, the user's rules, the runner connection for a session, and the `owner/repo` string
 * handling. Those live here so a sibling module can be read without the other three.
 *
 * This module is a LEAF on purpose: it imports `lib/*` and nothing from `routes/*`, so the
 * import graph stays acyclic (`lib/import-graph.test.ts`) no matter which sibling grows next.
 */
import type { Context } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { getRunnerConn } from "../lib/runner-client.js";
import { getRuntime } from "./instances-runtime.js";
import type { CodingSessionRecord } from "../lib/coding-types.js";
import type { Env } from "../types.js";

/**
 * Confirm the caller owns the instance (the workspace).
 *
 * THE tenant gate for all 39 coding routes, and the first line of every one of them.
 * `coding.contract.test.ts` drives each route as a stranger and pins that it 404s here —
 * a route that forgets this call moves in that table rather than shipping quietly.
 */
export async function requireOwned(
	c: Context<{ Bindings: Env }>,
): Promise<{ uid: string; instanceId: string; session: Awaited<ReturnType<typeof requireUser>> }> {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId") ?? "";
	const owned = await c.env.DB.prepare("SELECT id FROM agent_instances WHERE id = ?1 AND user_id = ?2")
		.bind(instanceId, session.uid)
		.first();
	if (!owned) throw new HttpError(404, "Instance not found");
	return { uid: session.uid, instanceId, session };
}

/** The instance's Special Instructions (user rules) from its JSON config. */
export async function readSpecialInstructions(env: Env, instanceId: string, userId: string): Promise<string | undefined> {
	const row = await env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2")
		.bind(instanceId, userId)
		.first<{ config: string }>();
	try {
		const cfg = JSON.parse(row?.config || "{}") as { specialInstructions?: string };
		return cfg.specialInstructions || undefined;
	} catch {
		return undefined;
	}
}

/** The machine that owns this session — routing follows the session's stamped node. */
export async function getSessionRunnerConn(env: Env, instanceId: string, uid: string, session: CodingSessionRecord) {
	return getRunnerConn(env, instanceId, uid, session.runnerNode ?? null);
}

/** The instance's default machine — for the commands that aren't scoped to one session. */
export async function getDefaultRunnerConn(env: Env, instanceId: string, uid: string) {
	const runtime = await getRuntime(env, instanceId, uid);
	return getRunnerConn(env, instanceId, uid, runtime?.runner_node ?? null);
}

/** Pure selection: lowest-numbered issue not excluded (deterministic ordering). Exported for
 *  tests — the ordering/skip rule is the part worth pinning. */
export function pickNextIssue<T extends { number: number }>(issues: T[], exclude: Set<number>): T | null {
	return [...issues].sort((a, b) => a.number - b.number).find((i) => !exclude.has(i.number)) ?? null;
}

/**
 * `owner/repo` out of a GitHub clone URL — https or ssh, with or without `.git`, with or
 * without a trailing slash. Returns null for anything that isn't a GitHub URL.
 *
 * Exported and shared because this regex was written out twice (#304): once when adding a
 * repo from a bare clone URL, once when reading a local checkout's `origin` remote. Both
 * answer the same question, and the second site's comment already said "same shape as the
 * clone-URL path" — so a fix to one (a new host form, a stricter owner charset) would
 * silently have left the other behind.
 */
export function parseGithubRepo(url: string | null | undefined): string | null {
	if (!url) return null;
	return url.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i)?.[1] ?? null;
}

/**
 * The owner half of an `owner/repo` — what `installationTokenForOwner` is keyed by. Empty
 * string when there is no repo reference at all, which every caller already treats as "no
 * installation to look up".
 *
 * Exported and shared because the same index-into-a-split appeared five times (#304) in two
 * spellings: three guarded by `includes("/")`, two by a truthiness ternary.
 *
 * DELIBERATELY NOT stricter than what it replaced. A reference with no slash at all
 * (`"platform"`, which the add-repo route accepts because `body.githubRepo` is taken on
 * trust) comes back as `"platform"` — a nonsense owner, exactly as before. Rejecting it here
 * would be a real behaviour change smuggled into a de-duplication: the two ternary callers
 * would stop attempting a token lookup they attempt today. Validating `body.githubRepo` at
 * the edge is the right fix and is a separate decision.
 */
export function ownerOf(githubRepo: string | null | undefined): string {
	if (!githubRepo) return "";
	return githubRepo.split("/")[0];
}
