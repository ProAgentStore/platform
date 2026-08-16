/**
 * Which repository may this coding instance WRITE to (#676).
 *
 * ── The event this exists for ──
 *
 * Instance `e4d2d031` ("PAS Coder") has exactly one registered repo,
 * `proappstore-online/platform`. Given an objective to implement that repo's issue #137, session
 * `csess_f686f1ff` ran, at 2026-08-16T01:55:44Z:
 *
 *     cd /Users/serge-ivo/dev/stores/pags/platform && gh pr create --repo ProAgentStore/platform …
 *
 * — opening PR #675 in a DIFFERENT GitHub organisation. The intended repo received nothing, and
 * the run reported success, describing its target as "the PAGS platform repo". The Engine's model
 * of where it was working had drifted and **no layer beneath it disagreed**.
 *
 * A registered repo was a working-directory default. It was never an authorization boundary.
 *
 * ── What this is, and the thing it is NOT ──
 *
 * This is {@link https://github.com/ProAgentStore/platform/issues/676 #676}'s layer 3, and it is
 * the same shape as `coding-authority.ts`'s: the observed acts (#294) are protocol FACT — a
 * `tool_use` event carrying the literal command the Engine ran — checked against a rule, with a
 * hit HALTING the run and naming what it was aimed at.
 *
 * **It is detection-and-halt, not containment.** The Engine runs
 * `claude --dangerously-skip-permissions` on the owner's own machine with the machine's own `gh`
 * login, so the first wrong-org write still LANDS; this stops the run immediately afterwards and
 * tells the owner which repository was written to. That converts a silent wrong-org landing that
 * reported success into a visible refusal, which is most of the reported pain — but anyone reading
 * this must not conclude a wrong-repo write has become impossible. It has not. Making the FIRST
 * write fail needs the credential the Engine uses to be scoped, and the Engine's credential is the
 * account's, reached over SSH and its own `gh` config.
 *
 * ── Why the asymmetry (writes scoped, reads broad) is load-bearing ──
 *
 * Only consequential acts reach this gate, and #294's vocabulary records writes alone — an
 * ordinary read produces no act at all. That is not an accident of implementation, it is the
 * requirement: in a separate run the same day the Engine usefully ran
 * `gh pr view 138 --repo proappstore-online/platform` as a reference implementation while working
 * on ProAgentStore/platform. Scoping READS to one repository would break a legitimate pattern, so
 * nothing here may ever look at one.
 *
 * ── Unknown is not a violation ──
 *
 * This function halts runs, so every unanswerable input resolves to "permitted". A command naming
 * no repository (`git push -u origin feat/x` — the ordinary shape) is not judged: the repo would
 * have to be inferred from a working directory the act record does not carry, and a guess that
 * stops a working run costs more than the gap it closes. An instance with no registered GitHub
 * slug at all (every repo local-path, no `github_repo`) has no scope to compare against and is
 * likewise left alone.
 */
import { logEvent } from "./events.js";
import { upsertWorkCard } from "./work-card.js";
import type { EngineActReport } from "./engine-acts.js";
import type { Env } from "../types.js";

/**
 * Act kinds that change a REMOTE repository.
 *
 * `reset.hard`, `clean` and `file.delete` are local to the checkout — destructive, but they reach
 * no other repo and #314 already covers the trunk. `package.publish` goes to a registry, not a
 * repository, and `deploy` names no repo at all. Including any of them would make this gate fire
 * on a command whose repository mention is incidental.
 */
export const REMOTE_WRITE_KINDS: ReadonlySet<string> = new Set([
	"pr.open",
	"pr.merge",
	"push",
	"push.trunk",
	"push.force",
	"branch.delete",
	"repo.delete",
	"release.publish",
]);

/** `owner/name` — GitHub's own character set, and no path separators beyond the single slash. */
const SLUG = "([A-Za-z0-9][A-Za-z0-9._-]*)/([A-Za-z0-9][A-Za-z0-9._-]*?)";

/**
 * The positions in a command that DENOTE a repository. An allowlist of shapes, deliberately —
 * a bare `owner/name`-looking token is far more often a path, a ref (`origin/main`,
 * `refs/heads/x`) or a branch (`feat/update-board-ticket`), and every false positive here halts
 * a run that was working.
 */
const REPO_POSITIONS: readonly RegExp[] = [
	// gh's own repo selector: `--repo owner/name`, `--repo=owner/name`, `-R owner/name`.
	new RegExp(`(?:--repo[=\\s]+|-R\\s+)${SLUG}(?:\\.git)?(?=$|[\\s"'])`, "g"),
	// An https remote or a github URL of any kind (`/pull/675`, `/tree/main`, …).
	new RegExp(`https?://[^/\\s]+/${SLUG}(?:\\.git)?(?=$|[\\s"'/])`, "g"),
	// An scp-style ssh remote. The host is NOT anchored to github.com: this account's ~/.ssh/config
	// rewrites it to `github-personal`, so a literal-host rule would miss every push it makes.
	new RegExp(`[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:${SLUG}(?:\\.git)?(?=$|[\\s"'])`, "g"),
	// `gh api repos/owner/name/...`
	new RegExp(`\\brepos/${SLUG}(?=$|[\\s"'/])`, "g"),
];

/**
 * Every repository slug the command explicitly names, in order, deduplicated.
 *
 * Pure and exported so the one rule that decides "did this command name a repository" is testable
 * without a run. Returns `[]` for a command that names none — which the caller must read as
 * "unknown", never as "none, therefore fine".
 */
export function repoSlugsInCommand(command: string): string[] {
	const s = String(command ?? "");
	const out: string[] = [];
	const seen = new Set<string>();
	for (const re of REPO_POSITIONS) {
		// A fresh lastIndex per call — these are module-level /g regexes reused across commands.
		re.lastIndex = 0;
		for (const m of s.matchAll(re)) {
			const slug = `${m[1]}/${m[2]}`.replace(/\.git$/, "");
			const key = slug.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(slug);
		}
	}
	return out;
}

/** GitHub owners and repository names are case-insensitive; the stored casing is display only. */
function sameRepo(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The repository this act wrote to that the instance is not registered for, or null.
 *
 * Null covers three distinct "no" answers, and all three are deliberate: the act is not a remote
 * write, the command named no repository, or the instance has no registered slug to compare
 * against. See the module comment — this gate halts runs, so every one of them permits.
 */
export function outOfScopeWrite(registered: readonly string[], act: { kind: string; command: string }): string | null {
	if (!REMOTE_WRITE_KINDS.has(act.kind)) return null;
	const scope = registered.filter((r) => typeof r === "string" && r.includes("/"));
	if (!scope.length) return null;
	for (const slug of repoSlugsInCommand(act.command)) {
		if (!scope.some((r) => sameRepo(r, slug))) return slug;
	}
	return null;
}

/** Every act that wrote outside the instance's registered repositories, with what it was aimed at. */
export function unscopedWrites<T extends { kind: string; command: string }>(
	registered: readonly string[],
	acts: readonly T[],
): Array<{ act: T; refused: string }> {
	const out: Array<{ act: T; refused: string }> = [];
	for (const act of acts) {
		const refused = outOfScopeWrite(registered, act);
		if (refused) out.push({ act, refused });
	}
	return out;
}

/** What the act did, in words, for the violation sentence. */
function actPhrase(kind: string): string {
	switch (kind) {
		case "pr.open":
			return "opened a pull request";
		case "pr.merge":
			return "merged a pull request";
		case "push":
		case "push.trunk":
			return "pushed";
		case "push.force":
			return "force-pushed";
		case "branch.delete":
			return "deleted a branch";
		case "repo.delete":
			return "deleted a repository";
		case "release.publish":
			return "published a release";
		default:
			return kind;
	}
}

/**
 * The sentence the owner reads. It LEADS with the repository that was written to.
 *
 * #676 item 4: "surface the refused target repo in the run's stop reason, so the user sees
 * 'attempted write to X, not permitted' rather than a generic failure. A silent refusal reproduces
 * today's defect with the opposite sign." The registered scope is named too — without it the
 * reader cannot tell a misdirected run from a repo somebody forgot to register.
 *
 * The outcome is stated in all three states for the reason `describeViolation` states it: a write
 * whose result was never observed must not be reported as one that landed, nor as one that did not.
 */
export function describeRepoScopeViolation(
	refused: string,
	registered: readonly string[],
	act: { kind: string; ok?: boolean | null },
): string {
	const outcome = act.ok === false ? " (the command FAILED)" : act.ok === null || act.ok === undefined ? " (outcome not observed)" : "";
	const scope = registered.length === 1 ? registered[0] : registered.join(", ");
	return `Attempted write to "${refused}", not permitted: this agent is registered for ${scope}. The agent ${actPhrase(act.kind)} there${outcome}.`;
}

// ── The I/O half ────────────────────────────────────────────────────────────
//
// Everything above is pure and unit-tested. `coding-authority.ts` draws the same line for the same
// reason: the caller says WHAT it wants recorded and does not know the shape of the row.

/**
 * The GitHub slugs this instance is registered for — the write scope.
 *
 * EVERY repo on the instance, not the session's one: an instance legitimately carries several
 * repos and a write to any of them is in scope. Rows with no `github_repo` (a local-path repo
 * never given GitHub coordinates, a GitLab repo) contribute nothing, so an instance holding only
 * those resolves to `[]` — which {@link outOfScopeWrite} reads as "no scope to compare against"
 * and permits.
 *
 * Degrades to `[]` on a read failure, for the reason `readMergePolicyForRun` degrades to the
 * permissive default: a D1 blip must not invent a restriction the owner did not choose and halt a
 * run they were relying on.
 *
 * It lives here rather than in `coding-store.ts` because it is half of one question — what may
 * this instance write to, and did it — and the other half is the rest of this file.
 */
export async function registeredRepoSlugs(env: Env, instanceId: string, userId: string): Promise<string[]> {
	const { results } = await env.DB.prepare(
		"SELECT github_repo FROM coding_repos WHERE instance_id = ?1 AND user_id = ?2 AND github_repo IS NOT NULL AND github_repo != ''",
	)
		.bind(instanceId, userId)
		.all<{ github_repo: string | null }>()
		.catch(() => ({ results: [] as { github_repo: string | null }[] }));
	const seen = new Set<string>();
	const out: string[] = [];
	for (const row of results ?? []) {
		const slug = (row.github_repo ?? "").trim();
		if (!slug.includes("/") || seen.has(slug.toLowerCase())) continue;
		seen.add(slug.toLowerCase());
		out.push(slug);
	}
	return out;
}

/**
 * Record every write that went outside the instance's registered repositories, and return the
 * reason the run should stop (null when there was nothing to record).
 *
 * Written at `error` level and given a BOARD CARD, matching `recordAuthorityViolations`: the
 * complaint in #676 is that the wrong-org landing was found only by the owner noticing it
 * afterwards, so a record that still needs suspicion to look at would not fix it.
 *
 * The row id is deterministic (`repo-scope:<session>:<act>`), so a retried workflow step reports
 * the same breach once rather than manufacturing a second wrong-org write that never happened.
 */
export async function recordRepoScopeViolations(
	env: Env,
	ctx: { userId: string; instanceId: string; sessionId: string; repoLabel: string; traceId?: string | null },
	registered: readonly string[],
	acts: readonly EngineActReport[],
): Promise<string | null> {
	const violations = unscopedWrites(registered, acts);
	if (!violations.length) return null;
	const now = new Date().toISOString();
	for (const { act, refused } of violations) {
		const text = describeRepoScopeViolation(refused, registered, act);
		const id = `repo-scope:${ctx.sessionId}:${act.id}`.slice(0, 200);
		await logEvent(env, {
			id,
			source: "coding",
			event: "act.out_of_scope",
			level: "error",
			userId: ctx.userId,
			instanceId: ctx.instanceId,
			traceId: ctx.traceId || ctx.sessionId,
			message: text,
			context: { act: act.kind, command: act.command, refused, registered: [...registered], ok: act.ok, sessionId: ctx.sessionId },
		}).catch(() => undefined);
		await upsertWorkCard(env, {
			instanceId: ctx.instanceId,
			userId: ctx.userId,
			id,
			task: {
				id,
				type: "coding.out_of_scope_write",
				status: "needs_human",
				// The refused repo is in the TITLE: this card is the thing an owner scanning a board
				// sees, and the repository is the fact that was wrong.
				title: `Write to unregistered repository ${refused}`.slice(0, 200),
				subtitle: `${act.kind} — registered: ${registered.join(", ")}`.slice(0, 200),
				description: `${text} The run was stopped. Command: ${act.command}`.slice(0, 300),
				createdAt: now,
				updatedAt: now,
			},
		}).catch(() => undefined);
	}
	return describeRepoScopeViolation(violations[0].refused, registered, violations[0].act);
}
