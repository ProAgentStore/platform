/**
 * The Coder's REPO surface: what the agent is pointed at, and what GitHub says about it (#305).
 *
 * Fifteen routes, split out of `routes/coding.ts` along the boundary the registrations already
 * had — everything here answers a question about a REPOSITORY (add/remove it, name it, its
 * rules, its builds, its issues, which issue is next), and nothing here touches a live engine.
 * That is why the whole module reaches the runner exactly once, in `detect-github`, and only
 * to read a git remote.
 *
 * Registered from the position the block occupied in `coding.ts` — Hono matches in
 * registration ORDER, so moving a block past a sibling pattern is a behaviour change even when
 * the route set is unchanged. `coding.contract.test.ts` pins the order for that reason.
 */
import type { Hono } from "hono";
import { HttpError } from "../lib/auth.js";
import { callRunner, getBoundRunnerConn, READ_TIMEOUT_MS, type RunnerConn } from "../lib/runner-client.js";
import { computeETag, mergeRuns, persistBuildHistory, readBuildHistory, type BuildRun } from "../lib/build-history.js";
import type { IssueDetail } from "../lib/github-issues.js";
import { canReadHosted, hostedCoordinate, hostedReadRefusal, latestHostedBuild, listHostedBuilds, listHostedIssues, readHostedIssue, type HostedRepoRef } from "../lib/hosted-repo.js";
import { logError } from "../lib/error-log.js";
// One vocabulary for "why is there no machine" — the same diagnosis `/runtime/status` and the
// Pilot's pause both report, so this surface cannot invent a third wording for one state (#440).
import { describeFacts } from "../lib/runner-availability.js";
import { runtimeConnectivity } from "../lib/instance-connectivity.js";
import { asClient } from "../lib/coding-engines.js";
import { createRepo, deleteRepo, getActiveSessionForRepo, getRepo, listRepos, listSessions, updateRepo, updateRepoClone } from "../lib/coding-store.js";
import { checkWorkdirVia, cloneStatusForVerdict, isWorkdirBroken, type WorkdirVerdict } from "../lib/coding-workdir.js";
import { sanitizeRepoPolicies, type DeclaredRepoPolicies } from "../lib/repo-policies.js";
import type { CloneStatus, CodingRepo } from "../lib/coding-types.js";
import { mergePolicyPatch } from "../lib/coding-authority.js";
import { patchInstanceConfig } from "../lib/instance-config.js";
import { parseRepoRef } from "../lib/git-providers.js";
import { getSessionRunnerConn, pickNextIssue, requireOwned } from "./coding-shared.js";
import type { Env } from "../types.js";

/** "~/dev/stores/pags/platform" → "pags/platform" — a less generic default name. */
function lastTwoSegments(path: string): string {
	const parts = path.replace(/\/+$/, "").split("/").filter(Boolean);
	return parts.slice(-2).join("/");
}

/** How the Loop sources its objective: `direct` (you type each objective) or `issues`
 *  (the backlog IS the GitHub issue tracker — the Loop proposes the next open issue and you
 *  approve it). Instance-wide for v1. Stored in the instance's JSON config (no migration). */
export type WorkMode = "direct" | "issues";

async function readWorkMode(env: Env, instanceId: string, userId: string): Promise<WorkMode> {
	const row = await env.DB.prepare("SELECT config FROM agent_instances WHERE id = ?1 AND user_id = ?2")
		.bind(instanceId, userId)
		.first<{ config: string }>();
	try {
		const cfg = JSON.parse(row?.config || "{}") as { workMode?: string };
		return cfg.workMode === "issues" ? "issues" : "direct";
	} catch {
		return "direct";
	}
}

/**
 * The next open issue to work on a repo, for issues-mode: lowest number first, skipping any the
 * caller excludes (declined this Loop run) and the one already in an active session. Returns the
 * full detail (body included) so the console can pre-fill the objective, or null when the backlog
 * is empty. Never throws (the hosted readers degrade to []/null).
 *
 * Takes the REPO rather than an `owner/repo` string (#221): which host to ask is the repo's
 * business, and issues-mode is now sourced identically from a GitHub backlog and a GitLab one.
 */
async function nextOpenIssue(env: Env, userId: string, repo: HostedRepoRef, opts: { labels?: string; exclude: Set<number> }): Promise<IssueDetail | null> {
	const issues = await listHostedIssues(env, userId, repo, { state: "open", labels: opts.labels });
	const next = pickNextIssue(issues, opts.exclude);
	return next ? readHostedIssue(env, userId, repo, next.number) : null;
}

/** No runner to ask — a fact about the CONNECTION, never about the path (see coding-workdir). */
function unverified(workDir: string): WorkdirVerdict {
	return {
		state: "unverified",
		path: workDir,
		detail: `\`${workDir}\` has not been checked — no machine is connected. Run \`pags up\` on the machine that has this checkout.`,
	};
}

/**
 * Ask the machine what is at a local repo's path, and store what we learned (#405).
 *
 * `onUnverified` is the whole difference between the two callers, and it is deliberate:
 *
 *   - ADD time passes `"unknown"`. A path nobody has looked at must not be called `ready` —
 *     `ready` is the same word a successful clone gets, and writing it about an unseen path is
 *     what let an empty directory look usable for two days.
 *   - LIST time passes `null` (leave it). A machine that has gone offline says nothing new about
 *     a path it verified yesterday, and downgrading on its absence would flip every repo in the
 *     list every time a laptop closed — while the offline banner already says the true thing.
 *
 * Never throws, and never writes when nothing changed.
 */
async function verifyLocalWorkdir(
	env: Env,
	repo: CodingRepo,
	conn: RunnerConn | null,
	opts: { onUnverified: CloneStatus | null },
): Promise<{ repo: CodingRepo; verdict: WorkdirVerdict; checked: boolean }> {
	const workdir = repo.workdir;
	if (!workdir) return { repo, verdict: { state: "ok", path: "", detail: "" }, checked: false };
	const verdict = conn ? await checkWorkdirVia(conn, workdir) : unverified(workdir);
	// A machine ANSWERED about this path. That is a separate fact from what it answered, and it is
	// the one #440 is about: the row can be right and still be five days old, and nothing recorded
	// which. `unverified` is not a look at the directory — it is the absence of one.
	const checked = verdict.state !== "unverified";
	const status = verdict.state === "unverified" ? opts.onUnverified : cloneStatusForVerdict(verdict);
	const cloneError = verdict.detail || null;
	// Is there a new VERDICT to store, as opposed to a new TIME? The two are independent since
	// #440: "still ready" is not a change of state and IS a change of freshness.
	const writeVerdict = status !== null && !(repo.cloneStatus === status && (repo.cloneError ?? null) === cloneError);
	if (!checked && !writeVerdict) return { repo, verdict, checked };
	await updateRepoClone(env, repo.id, {
		// COALESCE leaves the column alone when this is undefined — so an identical verdict, and an
		// `unverified` one the caller has no downgrade for, both change nothing.
		cloneStatus: writeVerdict ? status : undefined,
		// `clone_error` is NOT coalesced in the statement, so a time-only write has to re-send what
		// is already there or it would silently clear a live diagnosis.
		cloneError: writeVerdict ? cloneError : (repo.cloneError ?? null),
		// The whole point of the column: stamped even when the verdict is identical. Skipping it —
		// as the old "nothing changed" early return did — is what leaves a correct `ready`
		// indistinguishable from a `ready` nobody has re-confirmed since Monday. One UPDATE per
		// local repo per list read, bounded by `MAX_VERIFY_PER_LIST`.
		checkedNow: checked,
	});
	const next = writeVerdict ? { cloneStatus: status, cloneError: cloneError ?? undefined } : {};
	// Mirrored rather than re-read: `datetime('now')` is UTC to the second in exactly this format,
	// so one extra SELECT per repo would buy at most a sub-second difference. The caller renders
	// the response, so without this a re-check would answer "never checked" about the check it
	// just performed.
	const checkedAt = checked ? { cloneCheckedAt: sqlNow() } : {};
	return { repo: { ...repo, ...next, ...checkedAt }, verdict, checked };
}

/** `datetime('now')`'s own format — see `verifyLocalWorkdir`. */
function sqlNow(): string {
	return new Date().toISOString().slice(0, 19).replace("T", " ");
}

/**
 * How many local repos one list request will verify. A checkout can be moved or deleted long
 * after it was added — the same state arriving later — so the list is where it has to be caught.
 * The cap (and the short per-call timeout in coding-workdir) is what keeps the Coding tab's first
 * paint bounded when a machine is connected but slow.
 */
const MAX_VERIFY_PER_LIST = 12;

/**
 * Did this response re-check the paths it is describing, and if not, why not (#440)?
 *
 * The list route's re-check is CONDITIONAL — `if (!conn) return c.json({ repos })` — and the early
 * return was silent, so a response carrying five-day-old verdicts was indistinguishable on the wire
 * from one that had just confirmed every path. That difference is the difference between "the
 * platform looked and it is broken" and "nobody has looked since Monday", and only the server can
 * tell them apart.
 *
 * `reason` is `diagnoseAttachment`'s sentence, not a new one: the pin, the machine and the remedy
 * are the same facts `/runtime/status` reports, and two surfaces inventing separate wordings for
 * one connectivity state is the failure #237/#341 keep re-fixing.
 */
interface RecheckReport {
	/** A machine was asked about at least one path. */
	ran: boolean;
	/** How many paths got a definite verdict. */
	checked: number;
	/** Why nothing was asked, when nothing was. */
	reason?: string;
}

/** Why no machine could be asked — in the vocabulary `/runtime/status` already uses. */
async function noRunnerReason(env: Env, instanceId: string, uid: string): Promise<string> {
	const facts = await runtimeConnectivity(env, instanceId, uid).catch(() => null);
	const d = describeFacts(facts ?? { hasRuntimeRow: false, relayConnected: false, node: null, runnerVersion: null, lastSeenAt: null });
	return `${d.message}${d.remedy ? ` Try: \`${d.remedy}\`` : ""}`;
}

export function registerRepoRoutes(codingRoutes: Hono<{ Bindings: Env }>) {
	codingRoutes.get("/:instanceId/coding/repos", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const repos = await listRepos(c.env, instanceId, uid);
		const local = repos.filter((r) => r.workdir).slice(0, MAX_VERIFY_PER_LIST);
		if (!local.length) return c.json({ repos, recheck: { ran: false, checked: 0 } satisfies RecheckReport });
		const conn = await getBoundRunnerConn(c.env, instanceId, uid).catch(() => null);
		// MEASURED (#440): this is the branch that fires. `getBoundRunnerConn` honours the
		// instance's "Runs on" pin and does NOT fall back (#379/#380), so an agent pinned to a
		// machine that is not running `pags up` resolves null here — while `/coding/browse`
		// (`getDefaultRunnerConn`), `/coding/diagnostics` (`getRunnerConn` on the runtime row's
		// node) and `/v1/terminals/nodes` (`relayConnected` per node) all bypass the pin and all
		// report the machine healthy. That contradiction is why five days of no re-check looked
		// impossible from outside. The pin is authoritative and stays so; what was missing is
		// saying that this response did not re-check, and why.
		if (!conn) return c.json({ repos, recheck: { ran: false, checked: 0, reason: await noRunnerReason(c.env, instanceId, uid) } satisfies RecheckReport });
		// One relay command each, in parallel on the one socket — the worst case is a single
		// WORKDIR_CHECK_TIMEOUT_MS, not one per repo.
		const settled = await Promise.allSettled(local.map((r) => verifyLocalWorkdir(c.env, r, conn, { onUnverified: null })));
		const fresh = new Map<string, CodingRepo>();
		let checked = 0;
		for (const s of settled) {
			if (s.status !== "fulfilled") continue;
			fresh.set(s.value.repo.id, s.value.repo);
			if (s.value.checked) checked++;
		}
		// A resolved connection that answers nothing is the OTHER invisible outcome, and the one
		// no probe from outside can see: the check degrades to `unverified`, `onUnverified: null`
		// declines to write, and the response looks exactly like a successful re-check. Record it
		// as a `warn` — it is not a bug in this request, it is the only evidence that a runner is
		// connected and not answering `/coding/repo-check` (a CLI older than #405, a wedged
		// runner, a relay timeout under parallel load).
		if (checked < local.length) {
			await logError(c.env, {
				source: "coding",
				level: "warn",
				userId: uid,
				message: `Workdir re-check: ${local.length - checked}/${local.length} local repos gave no verdict on a connected runner`,
				context: { instanceId, node: conn.runnerNode ?? null, checked, total: local.length },
			});
		}
		return c.json({ repos: repos.map((r) => fresh.get(r.id) ?? r), recheck: { ran: true, checked } satisfies RecheckReport });
	});

	/**
	 * Re-take the verdict on ONE repo's checkout, on demand, and say what happened (#440).
	 *
	 * The escape hatch the surface did not have. Before this, the only way out of a wrong verdict
	 * was a SUCCESSFUL list-time re-check — which needs a resolvable connection at that instant,
	 * is triggered only by someone opening the repo list, and reported nothing when it did not
	 * happen. So a row could sit wrong for five days with no action available to its owner and no
	 * way for anyone to find out why.
	 *
	 * It is also the instrument. `onUnverified: "unknown"` is ADD's answer, not LIST's: this is a
	 * deliberate request for a verdict, so "nobody could look" is a result worth recording rather
	 * than a reason to leave yesterday's answer in place — and the response says which of the two
	 * happened, instead of returning early in silence.
	 *
	 * Owner-scoped through `requireOwned` like every other `:instanceId` route, and it rides the
	 * default 240/min bucket (`rateLimitDefault`) — a user-triggered relay command, at the same
	 * rate as every other console action.
	 */
	codingRoutes.post("/:instanceId/coding/repos/:repoId/recheck", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const repo = await getRepo(c.env, instanceId, uid, c.req.param("repoId"));
		if (!repo) throw new HttpError(404, "Repo not found");
		// A cloned repo has no local path to look at; `clone_status` there is written by the clone
		// itself. Saying so beats running a check that would answer about nothing.
		if (!repo.workdir) return c.json({ repo, checked: false, reason: "This repo is cloned by the platform, not run from a folder on your machine — there is no local path to check." });
		const conn = await getBoundRunnerConn(c.env, instanceId, uid).catch(() => null);
		const { repo: fresh, verdict, checked } = await verifyLocalWorkdir(c.env, repo, conn, { onUnverified: "unknown" });
		return c.json({
			repo: fresh,
			checked,
			// The verdict itself, not just its effect on the row — that is what makes this route a
			// diagnostic. `detail` is #405's relayable sentence; `state` is the machine-readable one.
			verdict: { state: verdict.state, path: verdict.path, detail: verdict.detail },
			// Only for the NO-MACHINE case. A machine that was reached and still could not answer
			// has already said so in `verdict.detail` ("could not be verified on the connected
			// machine: …"), and overwriting that with a connectivity sentence would report the
			// opposite of what happened.
			...(conn ? {} : { reason: await noRunnerReason(c.env, instanceId, uid) }),
		});
	});

	codingRoutes.post("/:instanceId/coding/repos", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
		const name = String(body.name ?? "").trim();
		const githubRepoIn = typeof body.githubRepo === "string" ? body.githubRepo : undefined;
		const cloneUrlIn = typeof body.cloneUrl === "string" ? body.cloneUrl : undefined;
		// A local checkout the user already has on the runner machine — run there, no clone.
		const localPath = typeof body.localPath === "string" ? body.localPath.trim() : "";
		if (localPath) {
			const created = await createRepo(c.env, instanceId, uid, {
				// A bare folder name ("platform") is ambiguous — default to the last two
				// path segments ("pags/platform"). Editable later either way.
				name: name || lastTwoSegments(localPath) || "repo",
				workdir: localPath,
				provider: "local",
				defaultClient: asClient(body.defaultClient),
			});
			// `createRepo` optimistically calls any local path `ready`. Ask the machine that will
			// run in it BEFORE letting that stand (#405): the runner is connected at this moment
			// and can answer all three questions — does it exist, does it hold anything, is it a
			// checkout — and it was simply never asked.
			//
			// Still a 201, not a 400. The row is the handle the owner needs to fix or delete the
			// repo, and refusing to create it would leave them with a typo and no way to see it;
			// what changes is that the row says what is wrong instead of saying `ready`.
			const conn = await getBoundRunnerConn(c.env, instanceId, uid).catch(() => null);
			const { repo, verdict } = await verifyLocalWorkdir(c.env, created, conn, { onUnverified: "unknown" });
			return c.json(isWorkdirBroken(verdict) ? { repo, warning: verdict.detail } : { repo }, 201);
		}
		// A clone URL alone is enough: it carries the provider, the slug and the web URL (#221).
		// The URL is the AUTHORITY when both arrive — `githubRepo` and `cloneUrl` are independent
		// body fields, so a GitLab URL paired with a GitHub coordinate must not be stored as a
		// GitHub repo. (It is also what stops that pair minting an installation token; the
		// credential seam re-checks the host, so this is defence in depth rather than the fix.)
		const ref = parseRepoRef(cloneUrlIn);
		// No URL and no coordinate is a placeholder the owner will point at a source later —
		// `local`, not `other`: it has no remote to be honest or dishonest about.
		const provider = ref ? ref.provider : githubRepoIn ? "github" : cloneUrlIn ? "other" : "local";
		const slug = ref ? ref.slug : (githubRepoIn ?? "");
		// `github_repo` stays populated for GitHub ONLY — every GitHub reader (issues, Actions,
		// deploy watch, the supervisor's coordinates) still keys off it, and writing a GitLab
		// path into it is precisely the "pretending they are GitHub" this issue is about.
		const githubRepo = provider === "github" ? slug || undefined : undefined;
		// An https URL is canonicalised (a pasted browser path is not cloneable); ssh is kept
		// verbatim so the machine's own keys still do the work.
		const cloneUrl = ref?.cloneUrl || cloneUrlIn;
		// Default to the full slug — a bare repo name ("platform") is too generic to tell
		// projects apart. The user can rename it afterwards.
		const derivedName =
			name || slug || (cloneUrl ? cloneUrl.replace(/\.git$/, "").replace(/\/$/, "").split("/").pop() : "");
		if (!derivedName && !cloneUrl) return c.json({ error: "a repo name or URL is required" }, 400);
		const repo = await createRepo(c.env, instanceId, uid, {
			name: derivedName || "repo",
			githubRepo,
			provider,
			repoSlug: slug || undefined,
			webUrl: ref?.webUrl || undefined,
			cloneUrl,
			branch: typeof body.branch === "string" ? body.branch : undefined,
			defaultClient: asClient(body.defaultClient),
		});
		return c.json({ repo }, 201);
	});

	/**
	 * Auto-associate a LOCAL-PATH repo with its hosted identity by reading the local checkout's
	 * `origin` remote via the runner — so build status can query Actions for a repo you run from
	 * a local checkout (which otherwise has no githubRepo). Idempotent: returns the existing
	 * githubRepo if already set; { githubRepo: null } (never a 500) when there's no runner or no
	 * origin.
	 *
	 * Since #221 it also records a NON-GitHub origin (provider + slug + web URL) rather than
	 * discarding it — a GitLab checkout used to come back `{githubRepo:null}` and stay badged
	 * "local" forever. The route KEEPS its name and its `githubRepo` field: the console polls it
	 * on every load, so renaming it would break every deployed client for a cosmetic gain.
	 */
	codingRoutes.post("/:instanceId/coding/repos/:repoId/detect-github", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const repo = await getRepo(c.env, instanceId, uid, c.req.param("repoId"));
		if (!repo) throw new HttpError(404, "Repo not found");
		if (repo.githubRepo) return c.json({ githubRepo: repo.githubRepo, detected: false });
		if (!repo.workdir) return c.json({ githubRepo: null, reason: "not a local repo" });
		const conn = await getBoundRunnerConn(c.env, instanceId, uid);
		if (!conn) return c.json({ githubRepo: null, reason: "runner offline" });
		let remote: string | null = null;
		try {
			const r = await callRunner<{ remote?: string | null }>(conn, "/coding/git-remote", { workDir: repo.workdir }, { timeoutMs: READ_TIMEOUT_MS });
			remote = r.remote ?? null;
		} catch {
			return c.json({ githubRepo: null, reason: "could not read remote" });
		}
		// The same parser the clone-URL path uses — https, ssh, or scp-like, any known host.
		const ref = parseRepoRef(remote);
		if (!ref?.slug) return c.json({ githubRepo: null, detected: false });
		const githubRepo = ref.provider === "github" ? ref.slug : null;
		await c.env.DB.prepare(
			"UPDATE coding_repos SET github_repo = COALESCE(?1, github_repo), provider = ?5, repo_slug = ?6, web_url = ?7, updated_at = datetime('now') WHERE id = ?2 AND instance_id = ?3 AND user_id = ?4",
		)
			.bind(githubRepo, repo.id, instanceId, uid, ref.provider, ref.slug, ref.webUrl || null)
			.run();
		return c.json({ githubRepo, provider: ref.provider, repoSlug: ref.slug, detected: true });
	});

	codingRoutes.delete("/:instanceId/coding/repos/:repoId", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const repoId = c.req.param("repoId");
		// End any active sessions on the runner before deleting from DB. Deleting the repo removes the
		// last handle to those sessions, so a stop that quietly failed left a CLI process writing to a
		// checkout that no API could reach any more — no repo id, no session id, only `ps`. The delete
		// still proceeds (the user asked for it, and blocking on a flaky runner traps them with a repo
		// they cannot remove), but a failure is recorded and reported instead of vanishing.
		const sessions = await listSessions(c.env, instanceId, uid);
		const orphaned: string[] = [];
		for (const s of sessions.filter((s) => s.repoId === repoId && s.status === "active")) {
			const conn = await getSessionRunnerConn(c.env, instanceId, uid, s);
			if (!conn) continue; // machine is offline — there is no process left to stop
			const err = await callRunner(conn, "/coding/end", { sessionId: s.id }).then(
				() => null,
				(e: unknown) => (e instanceof Error ? e.message : String(e)),
			);
			if (err) {
				orphaned.push(s.id);
				await logError(c.env, {
					source: "coding",
					userId: uid,
					message: `Engine for session ${s.id} did not stop while deleting its repo: ${err}`,
					context: { instanceId, sessionId: s.id, repoId },
				});
			}
		}
		const ok = await deleteRepo(c.env, instanceId, uid, repoId);
		if (!ok) throw new HttpError(404, "Repo not found");
		return c.json(
			orphaned.length
				? {
						ok: true,
						enginesStopped: false,
						warning: `The repo was removed, but ${orphaned.length} engine process(es) did not confirm they stopped and may still be running on your machine.`,
					}
				: { ok: true },
		);
	});

	/** Get/set per-repo instructions (injected into the co-pilot + Overseer prompts). */
	codingRoutes.get("/:instanceId/coding/repos/:repoId/instructions", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const repo = await getRepo(c.env, instanceId, uid, c.req.param("repoId"));
		if (!repo) throw new HttpError(404, "Repo not found");
		return c.json({ instructions: repo.instructions || "" });
	});

	codingRoutes.put("/:instanceId/coding/repos/:repoId/instructions", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const repoId = c.req.param("repoId");
		const body = await c.req.json<{ instructions?: string }>();
		const instructions = String(body.instructions || "").slice(0, 5000);
		await c.env.DB.prepare(
			"UPDATE coding_repos SET instructions = ?1, updated_at = datetime('now') WHERE id = ?2 AND instance_id = ?3 AND user_id = ?4",
		)
			.bind(instructions, repoId, instanceId, uid)
			.run();
		return c.json({ instructions });
	});

	/**
	 * Latest build for a repo — GitHub Actions, or a GitLab pipeline (#221) — so the console can
	 * show build/deploy status (running / failed / live) independently of the agent. OPTIONAL:
	 * returns { available:false } for local repos, hosts with no client, or when the credential
	 * is missing — so it never breaks anything.
	 */
	codingRoutes.get("/:instanceId/coding/repos/:repoId/deployment", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const repo = await getRepo(c.env, instanceId, uid, c.req.param("repoId"));
		if (!repo) throw new HttpError(404, "Repo not found");
		const latest = await latestHostedBuild(c.env, uid, repo);
		// The unavailable body stays `{available:false}` with NO `run` key, which is what this route
		// has always put on the wire — `latestHostedBuild` carries `run:null` alongside it for its
		// other caller. Dispatching the lookup must not change the response shape (#304, #221).
		return c.json(latest.available ? latest : { available: false });
	});

	/**
	 * Paginated list of a repo's recent builds — the Build Status panel's
	 * data source (build history). Plural sibling of `/deployment` (which returns only the
	 * latest). Same graceful-degradation contract: `{ available:false }` (never a 500) for
	 * local repos, hosts with no client, or when the credential is missing. Auth is the repo
	 * provider's own — a GitHub App installation token, or a GitLab PAT from the vault — resolved
	 * server-side and never exposed to the browser.
	 * `?page` (≥1, default 1) + `?perPage` (1..50, default 20). (CODER-001, #77)
	 *
	 * Page 1 also merges a durable KV build-history log (survives GitHub retention / transient
	 * failures), persists best-effort, and supports conditional requests via a weak ETag —
	 * `If-None-Match` on an unchanged latest build returns 304. (CODER-002, #78)
	 */
	codingRoutes.get("/:instanceId/coding/repos/:repoId/deployments", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const repo = await getRepo(c.env, instanceId, uid, c.req.param("repoId"));
		if (!repo) throw new HttpError(404, "Repo not found");
		const page = Math.max(1, Number.parseInt(c.req.query("page") || "1", 10) || 1);
		const perPage = Math.min(50, Math.max(1, Number.parseInt(c.req.query("perPage") || "20", 10) || 20));
		try {
			// The provider decides how to ask AND with what credential — including GitHub's
			// unauthenticated fallback for a public repo, which lives in the dispatcher now but is
			// unchanged (CODER-010, #121). `null` is "could not ask", never "no builds yet".
			const runs = await listHostedBuilds(c.env, uid, repo, { page, perPage });
			if (!runs) return c.json({ available: false });
			// "There may be more" signal without parsing the Link header: a full live page implies a next.
			const nextPage = runs.length === perPage ? page + 1 : undefined;

			// Page 1 is the panel's freshness poll: merge live runs with the durable KV history
			// (so history survives GitHub retention + transient failures), persist best-effort, and
			// support conditional requests — an unchanged latest build short-circuits to 304. Deeper
			// pages are live GitHub only (immutable deep history), no merge/ETag. (CODER-002, #78)
			if (page === 1) {
				const stored = await readBuildHistory(c.env, instanceId, repo.id);
				const merged = mergeRuns(stored, runs);
				await persistBuildHistory(c.env, instanceId, repo.id, merged); // best-effort, never throws
				const etag = computeETag(merged);
				if (c.req.header("If-None-Match") === etag) return c.body(null, 304, { ETag: etag });
				return c.json(nextPage ? { available: true, runs: merged, nextPage } : { available: true, runs: merged }, 200, {
					ETag: etag,
				});
			}
			return c.json(nextPage ? { available: true, runs, nextPage } : { available: true, runs });
		} catch {
			return c.json({ available: false });
		}
	});

	/**
	 * Aggregate latest build per repo for an instance — ONE call for the Build Status panel
	 * instead of N per-repo /deployments requests. Fans out to each repo's host with bounded
	 * concurrency; a repo that fails degrades to `{ available:false }` for that repo only, never
	 * failing the whole response. Local repos and hosts with no client are listed as
	 * `available:false` (not hidden) so the panel can still show them. Drill-down to full history
	 * stays on /deployments. (CODER-003, #79; provider dispatch #221)
	 */
	codingRoutes.get("/:instanceId/coding/builds", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const repos = await listRepos(c.env, instanceId, uid);
		// Only repos whose host can actually be asked are fanned out. A local repo has nothing to
		// ask, and spending a request to be told so once per poll per repo is the cost this filter
		// has always avoided — it is now asked of the provider rather than of `github_repo`.
		const askable = repos.filter((r) => canReadHosted(r, "builds"));

		// Bounded concurrency keeps us well under the host's rate limit even with many repos.
		const CONCURRENCY = 6;
		const byRepo = new Map<string, { available: boolean; run: BuildRun | null }>();
		for (let i = 0; i < askable.length; i += CONCURRENCY) {
			const batch = askable.slice(i, i + CONCURRENCY);
			const settled = await Promise.allSettled(batch.map((r) => latestHostedBuild(c.env, uid, r)));
			settled.forEach((s, j) => {
				byRepo.set(batch[j].id, s.status === "fulfilled" ? s.value : { available: false, run: null });
			});
		}

		// Preserve the instance's repo order; repos that were not asked fall through to available:false.
		const builds = repos.map((r) => {
			const res = byRepo.get(r.id);
			// `githubRepo` travels too: the console applies ONE naming rule (repo-title.ts) — the GitHub
			// coordinate when there is one, else the folder name — and cannot without it.
			return { repoId: r.id, repoName: r.name, githubRepo: r.githubRepo ?? null, available: res?.available ?? false, run: res?.run ?? null };
		});
		return c.json({ builds });
	});

	/**
	 * A repo's issues (read-only, cloud→host — no runner needed, so any runner version works).
	 * Public repos work unauthenticated on both hosts; a private one needs the GitHub App
	 * installed for the owner, or a GitLab PAT in the vault. 400 for anything else.
	 *
	 * `hostedReadRefusal` is the guard, not `!githubRepo` (#221). The old expression fused three
	 * separate claims — hosted at all, coordinate known, host drivable — so a correctly-added
	 * GitLab repo was told it "isn't connected to GitHub" when the only false one was the third.
	 * Bitbucket still refuses here, and now says so in those words.
	 */
	codingRoutes.get("/:instanceId/coding/repos/:repoId/issues", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const repo = await getRepo(c.env, instanceId, uid, c.req.param("repoId"));
		if (!repo) throw new HttpError(404, "Repo not found");
		const refusal = hostedReadRefusal(repo, "issues");
		if (refusal) return c.json({ error: refusal }, 400);
		const state = c.req.query("state");
		const labels = c.req.query("labels") || undefined;
		const issues = await listHostedIssues(c.env, uid, repo, {
			state: state === "closed" || state === "all" ? state : "open",
			labels,
		});
		// `repo` on the wire stays the coordinate the console already renders. For a GitHub repo
		// that is byte-identical to `githubRepo` (migration 0097 backfilled the slug from it); for
		// a GitLab repo it is the project path, which is the only true answer.
		return c.json({ repo: hostedCoordinate(repo), issues });
	});

	codingRoutes.get("/:instanceId/coding/repos/:repoId/issues/:number", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const repo = await getRepo(c.env, instanceId, uid, c.req.param("repoId"));
		if (!repo) throw new HttpError(404, "Repo not found");
		const refusal = hostedReadRefusal(repo, "issues");
		if (refusal) return c.json({ error: refusal }, 400);
		const number = Number.parseInt(c.req.param("number"), 10);
		if (!Number.isFinite(number)) return c.json({ error: "Invalid issue number" }, 400);
		const issue = await readHostedIssue(c.env, uid, repo, number);
		if (!issue) throw new HttpError(404, "Issue not found");
		return c.json({ issue });
	});

	/**
	 * Work mode (instance-wide): `direct` = you type each Loop objective; `issues` = the Loop
	 * sources its objective from the next open GitHub issue (approve-per-issue). Read-merge-write
	 * on the instance config JSON — no migration.
	 */
	codingRoutes.get("/:instanceId/coding/work-mode", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		return c.json({ workMode: await readWorkMode(c.env, instanceId, uid) });
	});

	codingRoutes.put("/:instanceId/coding/work-mode", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const body = (await c.req.json().catch(() => ({}))) as { workMode?: unknown };
		const workMode: WorkMode = body.workMode === "issues" ? "issues" : "direct";
		// Patch just this key (#231). The read-parse-catch dance is gone with it: a corrupt config
		// no longer has to be "overwritten", because json_set coerces it in SQL and only this key
		// is touched — so a malformed blob can't cost the owner their other settings either.
		await patchInstanceConfig(c.env, instanceId, uid, "workMode", workMode);
		return c.json({ workMode });
	});

	/**
	 * The next open issue to work on this repo (issues-mode Loop sources its objective from
	 * here). Lowest-numbered open issue, skipping `?exclude=1,2` (declined this run) and the one
	 * already in an active session. `?labels=` narrows/orders by label. Returns `{ issue: null }`
	 * when the backlog is empty. 400 when the repo has no readable issue tracker.
	 */
	codingRoutes.get("/:instanceId/coding/repos/:repoId/next-issue", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const repo = await getRepo(c.env, instanceId, uid, c.req.param("repoId"));
		if (!repo) throw new HttpError(404, "Repo not found");
		const refusal = hostedReadRefusal(repo, "issues");
		if (refusal) return c.json({ error: refusal }, 400);
		const exclude = new Set<number>();
		for (const n of (c.req.query("exclude") || "").split(",")) {
			const v = Number.parseInt(n, 10);
			if (Number.isFinite(v)) exclude.add(v);
		}
		// Don't re-propose the issue already being worked in an active session on this repo.
		const active = await getActiveSessionForRepo(c.env, instanceId, uid, repo.id);
		if (active?.issueNumber) exclude.add(active.issueNumber);
		const issue = await nextOpenIssue(c.env, uid, repo, { labels: c.req.query("labels") || undefined, exclude });
		return c.json({ issue });
	});

	/**
	 * Update a repo/project: rename, set its launch URLs (dev/staging/prod), its merge policy —
	 * and, since #410/#411, MOVE it: change the folder its working copy lives in.
	 *
	 * ── Identity is immutable; address is not
	 *
	 * `workdir` was the one thing about a repo that could not be corrected. It was displayed in the
	 * settings sheet as read-only text styled exactly like every input around it, and the payload
	 * type here did not name it — so an owner who fixed a mistyped path watched the platform accept
	 * the edit and keep reading the old directory ("I updated it, but it is still using the old
	 * one"). The only remaining remedy was DELETE, which throws away the row's name, URLs, merge
	 * policy (#314), instructions and issue mode, and is the foreign key for `coding_sessions` and
	 * `coding_timeline` — the owner had to destroy the history to fix a typo.
	 *
	 * It was never a decision that the address was fixed. `50a9746` split this route out of
	 * `coding.ts` carrying whatever the pre-split code happened to accept; nothing anywhere records
	 * a rationale. The rule that IS right is narrower than "editable": WHICH repository this is
	 * stays fixed, because sessions and the timeline hang off it. WHERE its working copy sits is a
	 * fact about a machine, and machines get reorganised.
	 *
	 * The safety is therefore expressed as WHEN, not whether — see the 409 below.
	 */
	codingRoutes.put("/:instanceId/coding/repos/:repoId", async (c) => {
		const { uid, instanceId } = await requireOwned(c);
		const repoId = c.req.param("repoId");
		const body = (await c.req.json().catch(() => ({}))) as {
			name?: string;
			urls?: { dev?: string; staging?: string; prod?: string };
			mergePolicy?: string;
			workdir?: string;
			policies?: unknown;
		};
		const name = typeof body.name === "string" ? body.name.trim() : undefined;
		const hasUrls = body.urls !== undefined && typeof body.urls === "object";
		const policy = mergePolicyPatch(body.mergePolicy); // #314 — merge authority for THIS repo
		if (!policy.ok) return c.json({ error: policy.error }, 400);
		// #322 — which standing invariants this repo claims. Refused rather than silently dropped
		// when unrecognised: a policy that quietly never applies is indistinguishable from one that
		// is holding, which is the failure mode the whole feature exists to remove.
		let policies: DeclaredRepoPolicies | undefined;
		if (body.policies !== undefined) {
			const parsed = sanitizeRepoPolicies(body.policies);
			if (!parsed.ok) return c.json({ error: parsed.error }, 400);
			policies = parsed.value;
		}
		const workdirIn = typeof body.workdir === "string" ? body.workdir.trim() : undefined;
		// Blanking is refused rather than stored: every tool addresses this repo BY its workdir, so
		// an empty one is not a state anyone wants — it is a delete, and delete has its own route.
		if (workdirIn === "") return c.json({ error: "A folder is required. To remove this repo, delete it." }, 400);
		if (!name && !hasUrls && policy.value === undefined && workdirIn === undefined && policies === undefined) {
			return c.json({ error: "name, urls, mergePolicy, workdir or policies is required" }, 400);
		}

		// Only a MOVE needs the extra read and the session check. A save that resends the same path
		// (which the settings sheet does on every Save, because the field is now always populated)
		// must behave exactly as it did before this route learned about folders.
		let moving = false;
		if (workdirIn !== undefined) {
			const existing = await getRepo(c.env, instanceId, uid, repoId);
			if (!existing) throw new HttpError(404, "Repo not found");
			moving = workdirIn !== (existing.workdir ?? "");
			if (moving) {
				// A live session's engine has the OLD path as its cwd, and changing the row does not
				// move the process: the platform would believe path B while the CLI works in path A,
				// and Claude Code would `--resume` a conversation about different code. Refuse and
				// name the session, rather than silently splitting the brain.
				const active = await getActiveSessionForRepo(c.env, instanceId, uid, repoId);
				if (active) {
					return c.json(
						{
							error: "A session is running on this repo. End it before moving the folder — its CLI is still working in the old directory.",
							sessionId: active.id,
						},
						409,
					);
				}
			}
		}

		const ok = await updateRepo(c.env, instanceId, uid, repoId, {
			name: name || undefined,
			urls: hasUrls ? body.urls : undefined,
			mergePolicy: policy.value,
			workdir: moving ? workdirIn : undefined,
			policies,
		});
		if (!ok) throw new HttpError(404, "Repo not found");
		if (!moving) return c.json({ ok: true });

		// Store, THEN verify — the same order and the same helper the add path uses (#405), so all
		// three entry points give one verdict in one wording. Storing first is deliberate: an owner
		// may be fixing this from a phone with the laptop shut, and refusing the save would make the
		// product unusable for the case it exists to serve. What must not happen is a stale claim.
		//
		// `onUnverified: "unknown"` (ADD's answer, not LIST's) is the difference that matters here.
		// A moved repo's `clone_status` was earned by the OLD directory; leaving `ready` on a path
		// nobody has looked at is exactly the false claim #405 removed. `unknown` does not condemn
		// the new path — it says nobody has been asked yet, and the list upgrades it on the next
		// read once a machine is connected.
		const moved = await getRepo(c.env, instanceId, uid, repoId);
		if (!moved) throw new HttpError(404, "Repo not found");
		const conn = await getBoundRunnerConn(c.env, instanceId, uid).catch(() => null);
		const { repo, verdict } = await verifyLocalWorkdir(c.env, moved, conn, { onUnverified: "unknown" });
		return c.json(isWorkdirBroken(verdict) ? { ok: true, repo, warning: verdict.detail } : { ok: true, repo });
	});
}
