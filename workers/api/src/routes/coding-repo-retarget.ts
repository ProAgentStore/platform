/**
 * `POST /:instanceId/coding/repos/:repoId/retarget` and its history read (#1012).
 *
 * Moves one binding's GitHub coordinate after the SAME repository was renamed or transferred,
 * without deleting the row that sessions, the timeline and the instructions hang off. The store
 * half (`lib/coding-repo-retarget.ts`) holds the compare-and-set; this half establishes the facts
 * it cannot see:
 *
 *   - GitHub's own answer for the numeric id, through the owner's GitHub App installation. A URL
 *     redirect or a reused name is never taken as identity: the destination must be what GitHub
 *     reports for that id, and a pre-0209 binding must still resolve to the id the caller asserts.
 *   - The machine's checkout. Its `origin` must already name the destination. This route never
 *     changes a remote — that stays an explicit owner action, and the refusal says the command.
 *
 * It never clones, pushes, starts or drains work, and it is registered from `registerRepoRoutes`
 * so `coding.contract.test.ts` sees it as part of the repo surface.
 */
import type { Hono } from "hono";
import { HttpError } from "../lib/auth.js";
import { getRepo, listSessions } from "../lib/coding-store.js";
import { labelSessions, listRetargetAudits, retargetRepositoryBinding } from "../lib/coding-repo-retarget.js";
import { parseRepoRef } from "../lib/git-providers.js";
import { resolveGithubAccess } from "../lib/github-app.js";
import { callRunner, getBoundRunnerConn, READ_TIMEOUT_MS } from "../lib/runner-client.js";
import { requireOwned } from "./coding-shared.js";
import type { Env } from "../types.js";

const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;

function coordinate(raw: unknown): { owner: string; name: string; githubId?: number } | null {
	const r = (raw ?? {}) as Record<string, unknown>;
	const owner = typeof r.owner === "string" ? r.owner.trim() : "";
	const name = typeof r.name === "string" ? r.name.trim() : "";
	if (!SEGMENT.test(owner) || !SEGMENT.test(name)) return null;
	if (r.githubId === undefined || r.githubId === null) return { owner, name };
	return typeof r.githubId === "number" && Number.isSafeInteger(r.githubId) && r.githubId > 0 ? { owner, name, githubId: r.githubId } : null;
}

type Verdict = { ok: true; fullName: string; id: number } | { ok: false; status: 403 | 409; error: string };

/** GitHub's authenticated answer for one repository, by numeric id or by coordinate. */
async function githubRepository(env: Env, uid: string, tokenOwner: string, path: string): Promise<Verdict> {
	const access = await resolveGithubAccess(env, uid, tokenOwner, { diagnose: true });
	if (!access.ok) return { ok: false, status: 403, error: access.message };
	try {
		const res = await fetch(`https://api.github.com${path}`, {
			headers: { Authorization: `Bearer ${access.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "proagentstore" },
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) return { ok: false, status: 403, error: "The owner's GitHub App installation cannot access that repository." };
		const body = (await res.json()) as { id?: unknown; full_name?: unknown };
		if (typeof body.id !== "number" || typeof body.full_name !== "string") return { ok: false, status: 409, error: "GitHub did not return a repository identity." };
		return { ok: true, fullName: body.full_name, id: body.id };
	} catch {
		return { ok: false, status: 403, error: "GitHub could not be reached to verify the repository identity." };
	}
}

export function registerRepoRetargetRoutes(codingRoutes: Hono<{ Bindings: Env }>) {
	codingRoutes.post("/:instanceId/coding/repos/:repoId/retarget", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const repoId = c.req.param("repoId");
		const body = (await c.req.json().catch(() => ({}))) as { expectedCurrent?: Record<string, unknown>; destination?: unknown; dryRun?: unknown };
		const expected = coordinate(body.expectedCurrent);
		const version = body.expectedCurrent?.version;
		const destination = coordinate(body.destination);
		if (!expected || !destination?.githubId || typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) {
			return c.json({ error: "expectedCurrent { owner, name, version, githubId? } and destination { owner, name, githubId } are required." }, 400);
		}
		const dryRun = body.dryRun === true;
		const repo = await getRepo(c.env, instanceId, uid, repoId);
		if (!repo) throw new HttpError(404, "Repo not found");
		if (!repo.githubRepo) return c.json({ error: "This binding has no GitHub identity to retarget." }, 409);

		// The destination is exactly what GitHub reports for this numeric id. A different repository
		// that took the old name has a different id, so it fails here instead of inheriting history.
		const dest = await githubRepository(c.env, uid, destination.owner, `/repositories/${destination.githubId}`);
		if (!dest.ok) return c.json({ error: dest.error }, dest.status);
		const targetSlug = `${destination.owner}/${destination.name}`;
		if (dest.id !== destination.githubId || dest.fullName.toLowerCase() !== targetSlug.toLowerCase()) {
			return c.json({ error: `GitHub reports repository ${destination.githubId} as ${dest.fullName}, not ${targetSlug}.`, canonical: dest.fullName }, 409);
		}
		// A binding recorded before the numeric id existed: its stored coordinate must still resolve
		// to the id the caller asserts. If the old name now belongs to another repository, there is
		// no way to tell which repository the history is about, and the request is refused.
		if (repo.githubRepositoryId === undefined) {
			if (!expected.githubId) return c.json({ error: "expectedCurrent.githubId is required: this binding has no numeric GitHub id recorded yet." }, 400);
			const source = await githubRepository(c.env, uid, destination.owner, `/repos/${encodeURIComponent(expected.owner)}/${encodeURIComponent(expected.name)}`);
			if (!source.ok) return c.json({ error: source.error }, source.status);
			if (source.id !== expected.githubId) {
				return c.json({ error: `${expected.owner}/${expected.name} now resolves to a different GitHub repository (id ${source.id}); this binding's identity cannot be established.` }, 409);
			}
		}

		// The machine's checkout must already point at the destination. Never repointed from here.
		const routeBlockers: string[] = [];
		let originRemedy: string | undefined;
		if (!repo.workdir) {
			routeBlockers.push("managed_clone_origin_unverifiable");
		} else {
			const conn = await getBoundRunnerConn(c.env, instanceId, uid);
			let remote: string | null | undefined;
			if (!conn) routeBlockers.push("runner_offline");
			else {
				remote = await callRunner<{ remote?: string | null }>(conn, "/coding/git-remote", { workDir: repo.workdir }, { timeoutMs: READ_TIMEOUT_MS })
					.then((r) => r.remote ?? null)
					.catch(() => undefined);
				const ref = parseRepoRef(remote ?? null);
				if (remote === undefined) routeBlockers.push("local_origin_unreadable");
				else if (ref?.provider !== "github" || ref.slug.toLowerCase() !== targetSlug.toLowerCase()) {
					routeBlockers.push("local_origin_mismatch");
					originRemedy = `git -C "${repo.workdir}" remote set-url origin https://github.com/${targetSlug}.git`;
				}
			}
		}

		const result = await retargetRepositoryBinding(c.env, {
			instanceId,
			userId: uid,
			repoId,
			expectedCurrent: { ...expected, version },
			destination: { owner: destination.owner, name: destination.name, githubId: destination.githubId },
			dryRun,
			routeBlockers,
		});
		switch (result.kind) {
			case "not-found":
				throw new HttpError(404, "Repo not found");
			case "not-github":
				return c.json({ error: "This binding has no GitHub identity to retarget." }, 409);
			case "stale":
				return c.json({ error: "The binding no longer has the expected current identity or version.", actual: result.actual }, 412);
			case "different-repository":
				return c.json({ error: `The destination is a different repository from this binding (GitHub id ${result.bindingGithubId}). Add it as a new binding instead.` }, 409);
			case "conflict":
				return c.json({ error: "Another binding on this instance already holds the destination identity.", conflictingRepoId: result.conflictingRepoId }, 409);
			case "busy":
				return c.json({ error: "The binding cannot be retargeted yet.", blockers: result.blockers, ...(originRemedy ? { originRemedy } : {}) }, 409);
			case "preview":
				return c.json({ dryRun: true, ready: result.blockers.length === 0, repo: result.repo, changes: result.changes, blockers: result.blockers, ...(originRemedy ? { originRemedy } : {}) });
			case "idempotent":
				return c.json({ ok: true, idempotent: true, repo: result.repo, audit: result.audit });
			case "applied":
				return c.json({ ok: true, repo: result.repo, audit: result.audit, rollback: result.rollback });
		}
	});

	/** Retarget history, and which coordinate each of this binding's sessions actually worked on. */
	codingRoutes.get("/:instanceId/coding/repos/:repoId/retargets", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const repoId = c.req.param("repoId");
		const repo = await getRepo(c.env, instanceId, uid, repoId);
		if (!repo) throw new HttpError(404, "Repo not found");
		const audits = await listRetargetAudits(c.env, instanceId, uid, repoId);
		const sessions = (await listSessions(c.env, instanceId, uid)).filter((s) => s.repoId === repoId);
		return c.json({
			repoId,
			githubRepo: repo.githubRepo ?? null,
			githubRepositoryId: repo.githubRepositoryId ?? null,
			bindingVersion: repo.bindingVersion ?? 1,
			audits,
			sessions: labelSessions(repo.githubRepo ?? "", audits, sessions.map((s) => ({ id: s.id, startedAt: s.startedAt }))),
		});
	});
}
