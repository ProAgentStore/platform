/**
 * The repo surface, driven — what the owner's request actually STORES and is told (#221).
 *
 * `coding.contract.test.ts` drives every route as a stranger and pins the tenant gate. This one
 * drives two of them as the OWNER, because the bug being fixed is on the far side of that gate:
 * a GitLab clone URL used to be accepted, stored with an empty `github_repo`, rendered as a
 * local checkout, and — when its owner opened the Issues panel — told it "isn't connected to
 * GitHub", which is a sentence about a setup mistake they had not made.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../lib/auth.js";
import { signSession } from "../lib/session.js";
// The runner transport, stubbed at the seam every repo route reaches the machine through. Only
// the two entry points are replaced; the rest of the module (typed errors, timeouts) is real, so
// a caller that starts depending on one of them is not silently handed `undefined`.
// `liveNodeIgnoringPin` is here for the same reason: it is a relay scan, and it is the fact that
// turns "this agent isn't attached" into "you are pinned at a machine that is off" (#461).
const { getBoundRunnerConn, callRunner, liveNodeIgnoringPin } = vi.hoisted(() => ({
	getBoundRunnerConn: vi.fn(),
	callRunner: vi.fn(),
	liveNodeIgnoringPin: vi.fn(),
}));
vi.mock("../lib/runner-client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/runner-client.js")>()),
	getBoundRunnerConn,
	callRunner,
	liveNodeIgnoringPin,
}));

import { registerRepoRoutes } from "./coding-repos.js";
// Registered alongside the repo routes so the provider-dispatch block can assert that the
// three hosted surfaces disagree about GitLab on purpose: issues and builds answer, pull
// requests refuse (#221).
import { registerPullRoutes } from "./coding-pulls.js";
import type { Env } from "../types.js";

const SECRET = "coding-repos-test-secret";
const UID = "user-1";
const INSTANCE = "inst-1";

interface Statement {
	sql: string;
	binds: unknown[];
}

/**
 * A D1 that resolves ownership, echoes an inserted repo back as a row, and otherwise answers
 * with `repo`. Enough to drive add-repo and the read routes without a real database.
 */
function ownerEnv(repo?: Record<string, unknown>) {
	const issued: Statement[] = [];
	let inserted: Record<string, unknown> | null = null;
	const DB = {
		prepare(sql: string) {
			const flat = sql.replace(/\s+/g, " ").trim();
			const stmt = {
				bind: (...binds: unknown[]) => {
					issued.push({ sql: flat, binds });
					if (flat.startsWith("INSERT INTO coding_repos")) {
						// The column order of the INSERT, so the assertions below read as columns
						// rather than as positional indexes.
						const [id, instance_id, user_id, name, github_repo, provider, repo_slug, web_url, clone_url, branch, workdir, clone_status, default_client] = binds;
						inserted = {
							id, instance_id, user_id, name, github_repo, provider, repo_slug, web_url, clone_url, branch, workdir, clone_status, default_client,
							clone_error: null, urls: null, instructions: null, merge_policy: null,
							created_at: "2026-08-08 00:00:00", updated_at: "2026-08-08 00:00:00",
						};
					}
					return stmt;
				},
				first: async () => {
					if (/FROM agent_instances/.test(flat)) return { id: INSTANCE };
					if (/FROM coding_repos/.test(flat)) return inserted ?? repo ?? null;
					return null;
				},
				all: async () => ({ results: [] }),
				run: async () => ({ meta: { changes: 1 } }),
			};
			return stmt;
		},
	};
	const env = { SESSION_SIGNING_KEY: SECRET, DB } as unknown as Env;
	return { env, issued, insertedRepo: () => inserted };
}

function buildApp(repo?: Record<string, unknown>) {
	const ctx = ownerEnv(repo);
	const app = new Hono<{ Bindings: Env }>();
	const routes = new Hono<{ Bindings: Env }>();
	registerRepoRoutes(routes);
	registerPullRoutes(routes);
	app.route("/v1/instances", routes);
	app.onError((err, c) => c.json({ error: (err as Error).message }, err instanceof HttpError ? (err.status as 400) : 500));
	return { app, ...ctx };
}

async function addRepo(body: Record<string, unknown>) {
	const { app, env, insertedRepo, issued } = buildApp();
	const token = await signSession({ uid: UID, email: "o@example.com", roles: [] }, SECRET);
	const res = await app.request(
		`/v1/instances/${INSTANCE}/coding/repos`,
		{ method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) },
		env,
	);
	return {
		status: res.status,
		body: (await res.json()) as { repo?: Record<string, unknown>; warning?: string; error?: string },
		row: insertedRepo(),
		issued,
	};
}

/** No machine is connected — the default for every test that predates #405. */
beforeEach(() => {
	getBoundRunnerConn.mockReset();
	callRunner.mockReset();
	liveNodeIgnoringPin.mockReset();
	getBoundRunnerConn.mockResolvedValue(null);
	liveNodeIgnoringPin.mockResolvedValue(null);
});

describe("POST /coding/repos — a repo is stored as what it IS", () => {
	it("stores a GitLab URL as a GitLab repo, with its nested slug and NO github_repo", async () => {
		const { status, row } = await addRepo({ cloneUrl: "https://gitlab.com/group/subgroup/project.git" });
		expect(status).toBe(201);
		expect(row).toMatchObject({
			provider: "gitlab",
			repo_slug: "group/subgroup/project",
			web_url: "https://gitlab.com/group/subgroup/project",
			github_repo: null,
			name: "group/subgroup/project",
		});
	});

	it("stores a Bitbucket URL as Bitbucket", async () => {
		const { row } = await addRepo({ cloneUrl: "https://bitbucket.org/workspace/repo.git" });
		expect(row).toMatchObject({ provider: "bitbucket", repo_slug: "workspace/repo", github_repo: null });
	});

	it("keeps every existing GitHub path byte-for-byte", async () => {
		// What the console sends today for `owner/repo`.
		const both = await addRepo({ githubRepo: "ProAgentStore/platform", cloneUrl: "https://github.com/ProAgentStore/platform.git" });
		expect(both.row).toMatchObject({ provider: "github", github_repo: "ProAgentStore/platform", repo_slug: "ProAgentStore/platform" });
		// A bare clone URL still derives the coordinate.
		const urlOnly = await addRepo({ cloneUrl: "https://github.com/o/r.git" });
		expect(urlOnly.row).toMatchObject({ provider: "github", github_repo: "o/r" });
		// A bare coordinate with no URL still means GitHub.
		const slugOnly = await addRepo({ githubRepo: "o/r" });
		expect(slugOnly.row).toMatchObject({ provider: "github", github_repo: "o/r" });
	});

	it("lets the URL's host WIN over a conflicting githubRepo", async () => {
		// The two are independent body fields. Trusting the coordinate here would store a GitLab
		// repo as a GitHub one and then ask GitHub about a project that does not exist there.
		const { row } = await addRepo({ githubRepo: "me/private", cloneUrl: "https://gitlab.com/group/project.git" });
		expect(row).toMatchObject({ provider: "gitlab", repo_slug: "group/project", github_repo: null });
	});

	it("canonicalises a pasted BROWSER url into something git can clone", async () => {
		const { row } = await addRepo({ cloneUrl: "https://gitlab.com/group/project/-/tree/main" });
		expect(row?.clone_url).toBe("https://gitlab.com/group/project.git");
	});

	it("keeps an ssh clone URL verbatim — the machine's own keys do that clone", async () => {
		const { row } = await addRepo({ cloneUrl: "git@gitlab.com:group/project.git" });
		expect(row).toMatchObject({ provider: "gitlab", clone_url: "git@gitlab.com:group/project.git" });
	});

	it("calls a local path local, and a nameless placeholder local too", async () => {
		expect((await addRepo({ localPath: "~/dev/stores/pags/platform" })).row).toMatchObject({ provider: "local", workdir: "~/dev/stores/pags/platform" });
		expect((await addRepo({ name: "scratch" })).row).toMatchObject({ provider: "local", name: "scratch" });
	});

	it("calls an unrecognised host `other` — a real remote, not a local checkout", async () => {
		const { row } = await addRepo({ cloneUrl: "https://git.internal.example/team/service.git" });
		expect(row).toMatchObject({ provider: "other", clone_url: "https://git.internal.example/team/service.git" });
	});
});

/**
 * `ready` is a CLAIM, and the platform may only make it about a path it has looked at (#405).
 *
 * A local repo used to become `ready` — the same word a successful clone gets — the instant
 * someone typed a path. The runner was connected at that moment and could have answered all
 * three questions; it was never asked. Two days later the agent was still being asked about code
 * in an empty directory the console called ready, and it invented the code (#395).
 */
describe("POST /coding/repos — a local path is CHECKED before it is called ready", () => {
	const FAKE_CONN = { instanceId: INSTANCE } as never;
	const HEALTHY = { checked: true, path: "/home/u/dev/thing", exists: true, isDirectory: true, entryCount: 91, insideWorkTree: true, gitChecked: true };

	/**
	 * The last `clone_status`/`clone_error` written for a repo, or null if nothing was written.
	 *
	 * `status: null` is a real outcome since #440 and is NOT "nothing happened": the statement
	 * COALESCEs, so a null there leaves the column alone. It is what a re-check that agreed with
	 * the stored verdict issues — a write whose only effect is the timestamp.
	 */
	const statusWritten = (issued: Statement[]) => {
		const update = issued.filter((s) => s.sql.startsWith("UPDATE coding_repos SET clone_status")).pop();
		return update ? { status: update.binds[1], error: update.binds[2] } : null;
	};

	/** Did the last write stamp `clone_checked_at` — i.e. did a machine actually look (#440)? */
	const checkStamped = (issued: Statement[]) => {
		const update = issued.filter((s) => s.sql.startsWith("UPDATE coding_repos SET clone_status")).pop();
		return update ? update.binds[5] === 1 : false;
	};

	it("asks the machine that will use the path, passing the path the owner typed", async () => {
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		callRunner.mockResolvedValue(HEALTHY);
		await addRepo({ localPath: "~/dev/thing" });
		expect(callRunner).toHaveBeenCalledWith(FAKE_CONN, "/coding/repo-check", { workDir: "~/dev/thing" }, expect.anything());
	});

	it("marks an EMPTY directory needs_attention, with a message naming it", async () => {
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		callRunner.mockResolvedValue({ ...HEALTHY, entryCount: 0, insideWorkTree: false });
		const { status, body, issued } = await addRepo({ localPath: "~/dev/pas/platform/apps/chess-academy" });
		// Still created: the row is the handle the owner needs to fix or delete it. What changed
		// is that it no longer says `ready`.
		expect(status).toBe(201);
		expect(statusWritten(issued)).toMatchObject({ status: "needs_attention" });
		expect(body.repo?.cloneStatus).toBe("needs_attention");
		expect(body.warning).toContain("/home/u/dev/thing");
		expect(body.warning).toMatch(/EMPTY/);
	});

	it("marks a path that does not exist needs_attention too", async () => {
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		callRunner.mockResolvedValue({ checked: true, path: "/home/u/typo", exists: false });
		const { body } = await addRepo({ localPath: "~/typo" });
		expect(body.repo?.cloneStatus).toBe("needs_attention");
		expect(body.warning).toMatch(/does not exist/);
	});

	it("leaves a real checkout `ready`, and changes no status it did not have to", async () => {
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		callRunner.mockResolvedValue(HEALTHY);
		const { body, issued } = await addRepo({ localPath: "~/dev/thing" });
		expect(body.repo?.cloneStatus).toBe("ready");
		expect(body.warning).toBeUndefined();
		// #405 asserted "writes nothing" here, and #440 splits that in two: the VERDICT is
		// unchanged (null status, so COALESCE leaves the column alone) while the TIME is recorded,
		// because "still ready" is not a change of state and is a change of freshness. Without the
		// second half a correct `ready` is indistinguishable from one nobody has re-confirmed for
		// five days — which is the bug.
		expect(statusWritten(issued)).toMatchObject({ status: null });
		expect(checkStamped(issued)).toBe(true);
	});

	it("does NOT stamp a check time when no machine could be asked", async () => {
		// The column's meaning depends entirely on this: absent means NOBODY LOOKED. An
		// `unverified` verdict that writes `unknown` is still not a look at the directory, so
		// stamping it would turn "we asked and got no answer" into "we checked".
		const { issued } = await addRepo({ localPath: "~/dev/thing" });
		expect(statusWritten(issued)).toMatchObject({ status: "unknown" });
		expect(checkStamped(issued)).toBe(false);
	});

	// "Only when the runner is live" — with no machine connected there is nobody to ask, and the
	// honest outcome is not a silent `ready`. `unknown` is a path nobody has looked at yet; the
	// repos list upgrades it the moment one is.
	it("does NOT say ready when no machine is connected to check", async () => {
		const { status, body, issued } = await addRepo({ localPath: "~/dev/thing" });
		expect(status).toBe(201);
		expect(statusWritten(issued)).toMatchObject({ status: "unknown" });
		expect(body.repo?.cloneStatus).toBe("unknown");
		// Not a defect, so not a warning — the console's offline banner is the true sentence here.
		expect(body.warning).toBeUndefined();
	});

	// An older CLI 404s /coding/repo-check; the relay hands the cloud `{error:"Not found"}`. A
	// version skew must not condemn a repo — but it must not mint `ready` either.
	it("treats an older runner as unchecked, not as broken", async () => {
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		callRunner.mockResolvedValue({ error: "Not found" });
		const { body, issued } = await addRepo({ localPath: "~/dev/thing" });
		expect(statusWritten(issued)).toMatchObject({ status: "unknown" });
		expect(body.warning).toBeUndefined();
	});

	it("never asks the machine about a CLONE — there is no local path to look at yet", async () => {
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		await addRepo({ cloneUrl: "https://github.com/o/r.git" });
		expect(callRunner).not.toHaveBeenCalled();
	});
});

/**
 * A checkout can be moved or deleted long after it was added — the same state arriving later.
 * The list is the only place that state can be caught, because it is what the console reads.
 */
describe("GET /coding/repos — the path is re-checked on every list", () => {
	const FAKE_CONN = { instanceId: INSTANCE } as never;
	const row = (over: Record<string, unknown> = {}) => ({
		id: "repo-1", instance_id: INSTANCE, user_id: UID, name: "apps/chess-academy",
		github_repo: null, provider: "local", repo_slug: null, web_url: null, clone_url: null,
		branch: "", workdir: "~/dev/pas/platform/apps/chess-academy", clone_status: "ready",
		clone_error: null, default_client: "claude", urls: null, instructions: null, merge_policy: null,
		created_at: "2026-08-07 08:29:04", updated_at: "2026-08-07 08:29:04", ...over,
	});

	/** D1's `datetime('now')` format, a few seconds ago — a FRESH heartbeat. */
	const justSeen = () => new Date(Date.now() - 5_000).toISOString().slice(0, 19).replace("T", " ");

	const reasonOf = (body: { recheck?: Record<string, unknown> }) => String(body.recheck?.reason ?? "");

	/**
	 * @param opts.registered a runtime registration exists and is heartbeating right now. On a
	 *   multi-machine account that heartbeat lands on the shared default row even while the pinned
	 *   machine is off, which is exactly why the pin-blind diagnosis read "the machine is online".
	 * @param opts.pinnedTo the instance's "Runs on" pin (`config.runnerNode`) (#461).
	 */
	async function listRepos(rows: Array<Record<string, unknown>>, opts: { registered?: boolean; pinnedTo?: string } = {}) {
		const issued: Statement[] = [];
		const DB = {
			prepare(sql: string) {
				const flat = sql.replace(/\s+/g, " ").trim();
				const stmt = {
					bind: (...binds: unknown[]) => {
						issued.push({ sql: flat, binds });
						return stmt;
					},
					first: async () => (/FROM agent_instances/.test(flat) ? { id: INSTANCE } : null),
					all: async () => {
						if (/FROM coding_repos/.test(flat)) return { results: rows };
						// The batched "Runs on" pin read behind `runtimeConnectivity` (#461).
						if (/SELECT id, config FROM agent_instances/.test(flat)) {
							return { results: opts.pinnedTo ? [{ id: INSTANCE, config: JSON.stringify({ runnerNode: opts.pinnedTo }) }] : [] };
						}
						if (/FROM instance_runtimes/.test(flat)) {
							return {
								results: opts.registered
									? [{ instance_id: INSTANCE, runner_node: opts.pinnedTo ?? "Mac", runner_version: "0.4.44", last_seen_at: justSeen() }]
									: [],
							};
						}
						return { results: [] };
					},
					run: async () => ({ meta: { changes: 1 } }),
				};
				return stmt;
			},
		};
		const env = { SESSION_SIGNING_KEY: SECRET, DB } as unknown as Env;
		const app = new Hono<{ Bindings: Env }>();
		const routes = new Hono<{ Bindings: Env }>();
		registerRepoRoutes(routes);
		app.route("/v1/instances", routes);
		const token = await signSession({ uid: UID, email: "o@example.com", roles: [] }, SECRET);
		const res = await app.request(`/v1/instances/${INSTANCE}/coding/repos`, { headers: { Authorization: `Bearer ${token}` } }, env);
		return { body: (await res.json()) as { repos: Array<Record<string, unknown>>; recheck?: Record<string, unknown> }, issued };
	}

	it("downgrades a repo whose checkout has gone since it was added", async () => {
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		callRunner.mockResolvedValue({ checked: true, path: "/home/u/dev/chess-academy", exists: false });
		const { body, issued } = await listRepos([row()]);
		expect(body.repos[0].cloneStatus).toBe("needs_attention");
		expect(String(body.repos[0].cloneError)).toContain("/home/u/dev/chess-academy");
		expect(issued.some((s) => s.sql.startsWith("UPDATE coding_repos SET clone_status"))).toBe(true);
	});

	it("upgrades one back to ready when the checkout is there again", async () => {
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		callRunner.mockResolvedValue({ checked: true, path: "/home/u/dev/x", exists: true, isDirectory: true, entryCount: 12, insideWorkTree: true, gitChecked: true });
		const { body } = await listRepos([row({ clone_status: "needs_attention", clone_error: "…was empty" })]);
		expect(body.repos[0].cloneStatus).toBe("ready");
		expect(body.repos[0].cloneError).toBeUndefined();
	});

	// A laptop that closed says nothing new about the path on it. Downgrading on its absence
	// would flip every repo in the list every time someone shut a lid, while the console's
	// offline banner already says the true thing.
	it("leaves every stored verdict alone when no machine is connected", async () => {
		const { body, issued } = await listRepos([row(), row({ id: "repo-2", clone_status: "needs_attention", clone_error: "gone" })]);
		expect(body.repos.map((r) => r.cloneStatus)).toEqual(["ready", "needs_attention"]);
		expect(issued.some((s) => s.sql.startsWith("UPDATE coding_repos SET clone_status"))).toBe(false);
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("does not ask the machine about repos that have no local path", async () => {
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		await listRepos([row({ provider: "github", workdir: null, github_repo: "o/r", clone_url: "https://github.com/o/r.git" })]);
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("changes no verdict when the verdict has not changed — but records that it looked (#440)", async () => {
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		callRunner.mockResolvedValue({ checked: true, path: "~/dev/x", exists: true, isDirectory: true, entryCount: 3, insideWorkTree: true, gitChecked: true });
		const { issued } = await listRepos([row()]);
		const update = issued.filter((s) => s.sql.startsWith("UPDATE coding_repos SET clone_status")).pop();
		// The status bind stays null (COALESCE leaves the column), the error is re-sent unchanged
		// (it is NOT coalesced, so omitting it would clear a live diagnosis), and the check time is
		// stamped. #405's version of this test skipped the write entirely, which is exactly how a
		// five-day-old `ready` became unreadable as such.
		expect(update?.binds[1]).toBeNull();
		expect(update?.binds[5]).toBe(1);
	});

	it("says on the wire that it could NOT re-check, and why", async () => {
		// The silent early return is the other half of #440. Two consecutive reads of this list
		// against a five-day-old row came back byte-identical, and nothing in either response said
		// whether the platform had looked — so "it is broken" and "nobody has looked since Monday"
		// were the same answer.
		const { body } = await listRepos([row()]);
		expect(body.recheck).toMatchObject({ ran: false, checked: 0 });
		// #461: this used to assert only `/\S/` — that the reason was NON-EMPTY — which is how a
		// reason that was wrong in both halves shipped green. Assert the sentence.
		expect(reasonOf(body)).toBe("No runner has registered for this agent yet. Try: `pags up`");
	});

	// #461, measured in production on the instance #440 was filed about. Both surfaces below are
	// the same function over the same facts about the same instance in the same second, and only
	// one of them was told about the pin.
	it("names the dead pin AND the machine that is up, and offers no `--force`, when the pin is why", async () => {
		liveNodeIgnoringPin.mockResolvedValue("Mac");
		const { body } = await listRepos([row()], { registered: true, pinnedTo: "Sergeys-Mac-mini.local" });
		const reason = reasonOf(body);
		expect(body.recheck).toMatchObject({ ran: false, checked: 0 });
		expect(reason).toContain("Sergeys-Mac-mini.local");
		expect(reason).toContain("Mac is connected");
		expect(reason).toContain('"Runs on"');
		// The two halves that were false: nothing else holds this agent, and `--force` cannot
		// repoint a pin — `pags up` is already running on Mac with a live socket for this instance.
		expect(reason).not.toContain("--force");
		expect(reason).not.toContain("another runner");
	});

	it("still prescribes `pags up --force` when the machine really is up and only this agent is detached", async () => {
		// The unpinned case is what `--force` is the answer to, and it must read exactly as before.
		const { body } = await listRepos([row()], { registered: true });
		expect(reasonOf(body)).toBe(
			"The machine is online but this agent isn't attached — another runner on it may already hold this agent. Try: `pags up --force`",
		);
		expect(liveNodeIgnoringPin).not.toHaveBeenCalled();
	});

	it("says on the wire that it DID re-check, and how many paths answered", async () => {
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		callRunner.mockResolvedValue({ checked: true, path: "~/dev/x", exists: true, isDirectory: true, entryCount: 3, insideWorkTree: true, gitChecked: true });
		const { body } = await listRepos([row()]);
		expect(body.recheck).toMatchObject({ ran: true, checked: 1 });
	});

	it("counts a connected runner that gave no verdict as NOT checked", async () => {
		// The invisible outcome the issue could not close from outside: a resolved connection whose
		// check degrades to `unverified` writes nothing under `onUnverified: null`, and used to be
		// indistinguishable from a successful re-check.
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		callRunner.mockResolvedValue({ error: "Not found" });
		const { body, issued } = await listRepos([row()]);
		expect(body.recheck).toMatchObject({ ran: true, checked: 0 });
		expect(issued.some((s) => s.sql.startsWith("UPDATE coding_repos SET clone_status"))).toBe(false);
	});
});

describe("GET /coding/repos/:id/issues — dispatched by provider, refused honestly (#221)", () => {
	const gitlabRepo = {
		id: "repo-1", instance_id: INSTANCE, user_id: UID, name: "group/project",
		github_repo: null, provider: "gitlab", repo_slug: "group/sub/project", web_url: null,
		clone_url: "https://gitlab.com/group/sub/project.git", branch: "", workdir: null,
		clone_status: "ready", clone_error: null, default_client: "claude",
		urls: null, instructions: null, merge_policy: null,
		created_at: "2026-08-08 00:00:00", updated_at: "2026-08-08 00:00:00",
	};

	/**
	 * Every outbound HTTP call this block makes, captured. The assertion that matters most is
	 * negative: a GitLab slug must NEVER reach api.github.com. `group/sub/project` is not an
	 * `owner/repo`, so letting it flow into the GitHub client would build a nonsense authenticated
	 * request against someone else's namespace — the exact failure a provider dispatch exists to
	 * make impossible, and one no green "it returned 400" test would have caught.
	 */
	let urls: string[] = [];
	beforeEach(() => {
		urls = [];
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
			urls.push(String(input));
			return new Response(JSON.stringify([{ iid: 3, title: "Pipeline flakes", state: "opened", labels: ["ci"], user_notes_count: 2, updated_at: "2026-08-08T00:00:00Z", web_url: "https://gitlab.com/x/-/issues/3", description: "It fails on rerun." }]), {
				status: 200, headers: { "Content-Type": "application/json" },
			});
		}));
	});

	const get = async (path: string, repo: Record<string, unknown>) => {
		const { app, env } = buildApp(repo);
		const token = await signSession({ uid: UID, email: "o@example.com", roles: [] }, SECRET);
		const res = await app.request(`/v1/instances/${INSTANCE}/coding/repos/repo-1${path}`, { headers: { Authorization: `Bearer ${token}` } }, env);
		return { status: res.status, body: (await res.json()) as Record<string, unknown> };
	};

	it("lists a GitLab project's issues, addressed by its NESTED path", async () => {
		const { status, body } = await get("/issues", gitlabRepo);
		expect(status).toBe(200);
		// `iid`, not `id` — the number a human sees and the one `#3` means in that project.
		expect(body.issues).toEqual([
			{ number: 3, title: "Pipeline flakes", state: "open", labels: ["ci"], comments: 2, updatedAt: "2026-08-08T00:00:00Z", url: "https://gitlab.com/x/-/issues/3" },
		]);
		// The coordinate on the wire is the project path — `github_repo` is null here, and the
		// console renders whatever `repo` says.
		expect(body.repo).toBe("group/sub/project");
		expect(urls.some((u) => u.startsWith("https://gitlab.com/api/v4/projects/group%2Fsub%2Fproject/issues"))).toBe(true);
		expect(urls.some((u) => u.includes("api.github.com"))).toBe(false);
		// GitLab rejects `state=all` with a 400, so "open" must go out as its word for it.
		expect(urls.some((u) => u.includes("state=opened"))).toBe(true);
	});

	it("still gives a LOCAL repo the actionable message it always got", async () => {
		const { status, body } = await get("/issues", { ...gitlabRepo, provider: "local", repo_slug: null, clone_url: null, workdir: "~/notes" });
		expect(status).toBe(400);
		expect(body.error).toMatch(/local checkout/);
		expect(urls).toEqual([]);
	});

	it("lists a BITBUCKET repo's issues — and that slug never reaches GitHub or GitLab", async () => {
		// Phase 4 (#221). `team/widget` IS a well-formed `owner/repo`, so — unlike the nested GitLab
		// path above — a leak here would not be caught by any shape check. It would build an
		// authenticated request against a GitHub namespace of the same name that nobody asked about,
		// which is why the negative assertion is the one that matters.
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
			urls.push(String(input));
			return new Response(JSON.stringify({ values: [{ id: 12, title: "Deploy step flakes", state: "new", kind: "bug", priority: "major", updated_on: "2026-08-08T00:00:00Z", links: { html: { href: "https://bitbucket.org/team/widget/issues/12" } } }] }), {
				status: 200, headers: { "Content-Type": "application/json" },
			});
		}));
		const { status, body } = await get("/issues", { ...gitlabRepo, provider: "bitbucket", repo_slug: "team/widget" });
		expect(status).toBe(200);
		expect(body.issues).toEqual([
			// `kind` + `priority` become the labels, because Bitbucket has none — and `comments` is
			// 0 because the payload carries no count at all, not because there are none.
			{ number: 12, title: "Deploy step flakes", state: "open", labels: ["bug", "major"], comments: 0, updatedAt: "2026-08-08T00:00:00Z", url: "https://bitbucket.org/team/widget/issues/12" },
		]);
		expect(urls.some((u) => u.startsWith("https://api.bitbucket.org/2.0/repositories/team/widget/issues"))).toBe(true);
		expect(urls.some((u) => u.includes("api.github.com"))).toBe(false);
		expect(urls.some((u) => u.includes("gitlab.com"))).toBe(false);
	});

	it("refuses an UNINTEGRATED host — a real remote we simply cannot query, said in those words", async () => {
		const { status, body } = await get("/issues", { ...gitlabRepo, provider: "other", repo_slug: "team/thing" });
		expect(status).toBe(400);
		expect(body.error).toMatch(/no integration/);
		expect(urls).toEqual([]);
	});

	it("a BITBUCKET repo is still refused PULL REQUESTS — one flag moved, not three", async () => {
		const { status, body } = await get("/pulls", { ...gitlabRepo, provider: "bitbucket", repo_slug: "team/widget" });
		expect(status).toBe(400);
		expect(body.error).toContain("Bitbucket");
		expect(body.error).toMatch(/yet/);
		expect(urls).toEqual([]);
	});

	it("reads GitLab BUILDS as pipelines, and never asks GitHub about them", async () => {
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
			urls.push(String(input));
			return new Response(JSON.stringify([{ iid: 12, status: "failed", source: "push", ref: "main", sha: "abcdef1234", web_url: "https://gitlab.com/x/-/pipelines/12", updated_at: "2026-08-08T01:00:00Z" }]), {
				status: 200, headers: { "Content-Type": "application/json" },
			});
		}));
		const { status, body } = await get("/deployment", gitlabRepo);
		expect(status).toBe(200);
		// GitLab's single `status` is widened into GitHub's (status, conclusion) pair, because
		// that is the shape the console and the KV build history already read.
		expect(body).toEqual({
			available: true,
			run: { status: "completed", conclusion: "failure", name: "push", runNumber: 12, url: "https://gitlab.com/x/-/pipelines/12", branch: "main", sha: "abcdef1", updatedAt: "2026-08-08T01:00:00Z" },
		});
		expect(urls.some((u) => u.startsWith("https://gitlab.com/api/v4/projects/group%2Fsub%2Fproject/pipelines"))).toBe(true);
		expect(urls.some((u) => u.includes("api.github.com"))).toBe(false);
	});

	it("a GitLab repo is still refused PULL REQUESTS — the flags move independently", async () => {
		// Merge requests have no client. `supports.pulls:false` is what keeps turning issues on
		// from silently asserting a surface that would 404 or, worse, hit the wrong API.
		const { status, body } = await get("/pulls", gitlabRepo);
		expect(status).toBe(400);
		expect(body.error).toContain("GitLab");
		expect(urls).toEqual([]);
	});
});

/**
 * A repo can be MOVED. Its identity cannot (#410/#411).
 *
 * `workdir` was the one thing about a repo that could not be corrected: the settings sheet showed
 * it as read-only text styled exactly like the inputs around it, and this route's payload type did
 * not name it — so the console was not failing to send a change, there was nothing to send. The
 * owner's only remedy was DELETE, which takes the name, the URLs, the merge policy (#314), the
 * instructions and the issue mode with it, and is the foreign key for `coding_sessions` and
 * `coding_timeline`. Fixing a typo meant destroying the history.
 *
 * The rule these tests pin is neither "editable" nor "immutable": WHICH repository this is stays
 * fixed, WHERE its working copy lives does not.
 */
describe("PUT /coding/repos/:id — the folder is editable, and checked when it changes", () => {
	const FAKE_CONN = { instanceId: INSTANCE } as never;
	const HEALTHY = { checked: true, path: "~/dev/stores/pas/apps/chess-academy", exists: true, isDirectory: true, entryCount: 21039, insideWorkTree: true, gitChecked: true };

	const repoRow = (over: Record<string, unknown> = {}) => ({
		id: "repo-1", instance_id: INSTANCE, user_id: UID, name: "apps/chess-academy",
		github_repo: null, provider: "local", repo_slug: null, web_url: null, clone_url: null,
		branch: "", workdir: "~/dev/pas/platform/apps/chess-academy", clone_status: "ready",
		clone_error: null, default_client: "claude", urls: null, instructions: null, merge_policy: null,
		created_at: "2026-08-07 08:29:04", updated_at: "2026-08-07 08:29:04", ...over,
	});

	/**
	 * A D1 whose repo row actually CHANGES when the route updates it — the route re-reads the row
	 * before verifying, so a harness echoing the pre-update row would have it checking the OLD path
	 * and every assertion below would pass for the wrong reason.
	 *
	 * `session` is the active-session lookup's answer; `null` is a quiet repo.
	 */
	function movableEnv(row: Record<string, unknown> | null, session: Record<string, unknown> | null = null) {
		const issued: Statement[] = [];
		let current = row;
		const DB = {
			prepare(sql: string) {
				const flat = sql.replace(/\s+/g, " ").trim();
				const stmt = {
					bind: (...binds: unknown[]) => {
						issued.push({ sql: flat, binds });
						// updateRepo binds: repoId, instanceId, userId, name, urlsJson, hasUrls, mergePolicy, workdir
						if (flat.startsWith("UPDATE coding_repos SET name") && current) {
							if (binds[7] != null) current = { ...current, workdir: binds[7] };
							if (binds[3] != null) current = { ...current, name: binds[3] };
						}
						if (flat.startsWith("UPDATE coding_repos SET clone_status") && current) {
							current = { ...current, clone_status: binds[1], clone_error: binds[2] };
						}
						return stmt;
					},
					first: async () => {
						if (/FROM agent_instances/.test(flat)) return { id: INSTANCE };
						if (/FROM coding_sessions/.test(flat)) return session;
						if (/FROM coding_repos/.test(flat)) return current;
						return null;
					},
					all: async () => ({ results: [] }),
					run: async () => ({ meta: { changes: current ? 1 : 0 } }),
				};
				return stmt;
			},
		};
		return { env: { SESSION_SIGNING_KEY: SECRET, DB } as unknown as Env, issued, row: () => current };
	}

	async function put(body: Record<string, unknown>, ctx: ReturnType<typeof movableEnv>) {
		const app = new Hono<{ Bindings: Env }>();
		const routes = new Hono<{ Bindings: Env }>();
		registerRepoRoutes(routes);
		app.route("/v1/instances", routes);
		app.onError((err, c) => c.json({ error: (err as Error).message }, err instanceof HttpError ? (err.status as 400) : 500));
		const token = await signSession({ uid: UID, email: "o@example.com", roles: [] }, SECRET);
		const res = await app.request(
			`/v1/instances/${INSTANCE}/coding/repos/repo-1`,
			{ method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) },
			ctx.env,
		);
		return { status: res.status, body: (await res.json()) as { ok?: boolean; error?: string; sessionId?: string; warning?: string; repo?: Record<string, unknown> } };
	}

	it("writes the new folder, keeping the row — and therefore its sessions and its history", async () => {
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		callRunner.mockResolvedValue(HEALTHY);
		const ctx = movableEnv(repoRow());
		const { status } = await put({ workdir: "~/dev/stores/pas/apps/chess-academy" }, ctx);
		expect(status).toBe(200);
		expect(ctx.row()).toMatchObject({ id: "repo-1", workdir: "~/dev/stores/pas/apps/chess-academy" });
		// The handle everything else hangs off is untouched — this is the whole reason
		// delete-and-re-add was not an acceptable answer.
		expect(ctx.issued.some((s) => s.sql.startsWith("DELETE FROM coding_repos"))).toBe(false);
	});

	it("checks the NEW path on the machine, and clears needs_attention when it is good", async () => {
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		callRunner.mockResolvedValue(HEALTHY);
		const ctx = movableEnv(repoRow({ clone_status: "needs_attention", clone_error: "…is EMPTY" }));
		const { body } = await put({ workdir: "~/dev/stores/pas/apps/chess-academy" }, ctx);
		// It asked about the new path, not the one the row held when the request arrived.
		expect(callRunner).toHaveBeenCalledWith(FAKE_CONN, "/coding/repo-check", { workDir: "~/dev/stores/pas/apps/chess-academy" }, expect.anything());
		expect(body.repo?.cloneStatus).toBe("ready");
		expect(body.warning).toBeUndefined();
	});

	it("stores a broken path and MARKS it — the same sentence the add path gives", async () => {
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		callRunner.mockResolvedValue({ checked: true, path: "~/typo", exists: false });
		const ctx = movableEnv(repoRow());
		const { status, body } = await put({ workdir: "~/typo" }, ctx);
		// Not a 400. The owner may be fixing this from a phone with the machine shut, and refusing
		// the save would make the product unusable for the case it exists to serve. What must not
		// happen is the row going on claiming `ready` about a directory that is not there.
		expect(status).toBe(200);
		expect(body.repo?.cloneStatus).toBe("needs_attention");
		expect(body.warning).toMatch(/does not exist/);
		expect(body.warning).toContain("~/typo");
	});

	// `unknown`, NOT the `ready` the OLD directory earned. `clone_status` is a claim about the path
	// the row holds NOW, so it must move with it — #405's point, applied to an edit instead of an add.
	it("does not let a moved repo keep the previous path's `ready`", async () => {
		const ctx = movableEnv(repoRow({ clone_status: "ready" })); // no machine connected
		const { body } = await put({ workdir: "~/dev/somewhere/else" }, ctx);
		expect(body.repo?.cloneStatus).toBe("unknown");
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("refuses the move while a session is live, and names the session", async () => {
		const ctx = movableEnv(repoRow(), { id: "sess-9", instance_id: INSTANCE, user_id: UID, repo_id: "repo-1", status: "active" });
		const { status, body } = await put({ workdir: "~/dev/elsewhere" }, ctx);
		// The engine's cwd is the old path and moving the row does not move the process: the
		// platform would believe path B while the CLI works in path A, and Claude Code would
		// `--resume` a conversation about different code.
		expect(status).toBe(409);
		expect(body.sessionId).toBe("sess-9");
		expect(ctx.row()).toMatchObject({ workdir: "~/dev/pas/platform/apps/chess-academy" });
	});

	it("does NOT refuse a save that resends the SAME folder while a session is live", async () => {
		// The settings sheet posts the folder on every Save, because the field is always populated.
		// A no-op must stay a no-op, or renaming a repo becomes impossible while it is being worked.
		const ctx = movableEnv(repoRow(), { id: "sess-9", instance_id: INSTANCE, user_id: UID, repo_id: "repo-1", status: "active" });
		const { status } = await put({ name: "chess", workdir: "~/dev/pas/platform/apps/chess-academy" }, ctx);
		expect(status).toBe(200);
		expect(ctx.row()).toMatchObject({ name: "chess" });
		expect(callRunner).not.toHaveBeenCalled(); // nothing moved, nothing to re-check
	});

	it("refuses a BLANK folder — that is a delete, and delete has its own route", async () => {
		const ctx = movableEnv(repoRow());
		const { status, body } = await put({ workdir: "   " }, ctx);
		expect(status).toBe(400);
		expect(body.error).toMatch(/folder is required/i);
		expect(ctx.issued.some((s) => s.sql.startsWith("UPDATE coding_repos"))).toBe(false);
	});

	it("is still owner-scoped — another user's repo is a 404, and is not written", async () => {
		const ctx = movableEnv(null); // getRepo finds nothing for this (user, instance, repo)
		const { status } = await put({ workdir: "~/dev/theirs" }, ctx);
		expect(status).toBe(404);
		expect(ctx.issued.some((s) => s.sql.startsWith("UPDATE coding_repos"))).toBe(false);
	});

	it("leaves the name/urls-only path exactly as it was — no read, no session check, no probe", async () => {
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		const ctx = movableEnv(repoRow());
		const { status, body } = await put({ name: "renamed" }, ctx);
		expect(status).toBe(200);
		expect(body).toEqual({ ok: true });
		expect(ctx.issued.some((s) => /FROM coding_sessions/.test(s.sql))).toBe(false);
		expect(callRunner).not.toHaveBeenCalled();
	});

	// #322 — the repo DECLARES which standing invariants it claims. The declaration is the whole
	// safety property of the feature, so it is validated at the boundary rather than at the reader.
	describe("standing policies", () => {
		/** The bind index of the policies JSON, and of the flag that says it was supplied at all. */
		const POLICIES = 8;
		const HAS_POLICIES = 9;
		const updateBinds = (ctx: ReturnType<typeof movableEnv>) =>
			ctx.issued.find((s) => s.sql.startsWith("UPDATE coding_repos SET name"))?.binds;

		it("stores a declaration", async () => {
			const ctx = movableEnv(repoRow());
			const { status } = await put({ policies: { "repo.on_default_branch": "observe" } }, ctx);
			expect(status).toBe(200);
			const binds = updateBinds(ctx);
			expect(binds?.[POLICIES]).toBe('{"repo.on_default_branch":"observe"}');
			expect(binds?.[HAS_POLICIES]).toBe(1);
		});

		it("refuses an unknown policy, and writes nothing", async () => {
			const ctx = movableEnv(repoRow());
			const { status, body } = await put({ policies: { "repo.fix_everything": "observe" } }, ctx);
			expect(status).toBe(400);
			expect(body.error).toContain("unknown policy");
			expect(ctx.issued.some((s) => s.sql.startsWith("UPDATE coding_repos"))).toBe(false);
		});

		it("refuses `act` — there is no actuator, so accepting the word would be a promise", async () => {
			const ctx = movableEnv(repoRow());
			const { status, body } = await put({ policies: { "repo.tree_clean": "act" } }, ctx);
			expect(status).toBe(400);
			expect(body.error).toContain("off, observe");
		});

		it("clearing every claim stores NULL, not `{}` — one spelling of declared-nothing", async () => {
			const ctx = movableEnv(repoRow());
			const { status } = await put({ policies: {} }, ctx);
			expect(status).toBe(200);
			const binds = updateBinds(ctx);
			expect(binds?.[POLICIES]).toBeNull();
			expect(binds?.[HAS_POLICIES]).toBe(1);
		});

		it("a request that does not mention policies leaves the column alone", async () => {
			const ctx = movableEnv(repoRow());
			await put({ name: "renamed" }, ctx);
			expect(updateBinds(ctx)?.[HAS_POLICIES]).toBe(0);
		});
	});
});

/**
 * The escape hatch, and the instrument (#440).
 *
 * A row that says a healthy checkout is broken had no owner-reachable remedy: the only way out
 * was a SUCCESSFUL list-time re-check, which needs a resolvable runner connection at that
 * instant, fires only when someone opens the repo list, and reported nothing when it did not
 * happen. `pas/platform` sat wrong for five days behind exactly that.
 */
describe("POST /coding/repos/:id/recheck — a verdict can be re-taken on purpose", () => {
	const FAKE_CONN = { instanceId: INSTANCE } as never;
	const localRepo = {
		id: "repo-1", instance_id: INSTANCE, user_id: UID, name: "pas/platform",
		github_repo: null, provider: "local", repo_slug: null, web_url: null, clone_url: null,
		branch: "", workdir: "~/dev/stores/pas/platform", clone_status: "error",
		clone_error: "No runner connected — run `pags up`", default_client: "claude",
		urls: null, instructions: null, merge_policy: null,
		created_at: "2026-08-03 01:44:25", updated_at: "2026-08-03 01:44:25",
	};

	async function recheck(repo: Record<string, unknown> | null) {
		const { app, env, issued } = buildApp(repo ?? undefined);
		const token = await signSession({ uid: UID, email: "o@example.com", roles: [] }, SECRET);
		const res = await app.request(
			`/v1/instances/${INSTANCE}/coding/repos/repo-1/recheck`,
			{ method: "POST", headers: { Authorization: `Bearer ${token}` } },
			env,
		);
		return { status: res.status, body: (await res.json()) as Record<string, unknown>, issued };
	}

	it("re-takes the verdict and returns it, clearing a five-day-old transport failure", async () => {
		// The measured row, and the measured runner answer for that exact path: 18 entries, inside
		// a work tree. The whole point is that ONE deliberate request replaces the stale claim.
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		callRunner.mockResolvedValue({ checked: true, path: "/Users/serge-ivo/dev/stores/pas/platform", exists: true, isDirectory: true, entryCount: 18, insideWorkTree: true, gitChecked: true });
		const { status, body, issued } = await recheck(localRepo);
		expect(status).toBe(200);
		expect(body.checked).toBe(true);
		expect(body.verdict).toMatchObject({ state: "ok" });
		expect((body.repo as Record<string, unknown>).cloneStatus).toBe("ready");
		const update = issued.filter((s) => s.sql.startsWith("UPDATE coding_repos SET clone_status")).pop();
		expect(update?.binds[1]).toBe("ready");
		expect(update?.binds[5]).toBe(1);
	});

	it("keeps the monorepo-subfolder case READY — a folder inside a work tree is a legitimate workdir", async () => {
		// `stores/fds` holds one entry and no `.git` of its own, and reads `ready` correctly:
		// `~/dev/stores` is itself a work tree. #405 chose `insideWorkTree` over an existence test
		// precisely so a package inside a monorepo checkout is not condemned. A re-check must not
		// be the thing that finally condemns it.
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		callRunner.mockResolvedValue({ checked: true, path: "/Users/u/dev/stores/fds", exists: true, isDirectory: true, entryCount: 1, insideWorkTree: true, gitChecked: true });
		const { body } = await recheck({ ...localRepo, workdir: "~/dev/stores/fds", clone_status: "ready", clone_error: null });
		expect(body.verdict).toMatchObject({ state: "ok" });
		expect((body.repo as Record<string, unknown>).cloneStatus).toBe("ready");
	});

	it("says NOBODY LOOKED rather than returning early in silence", async () => {
		// The diagnostic half. `getBoundRunnerConn` honours the instance's "Runs on" pin and does
		// not fall back (#379/#380), so an agent pinned to a machine that is not running `pags up`
		// resolves null here while every pin-ignoring surface reports the machine healthy — which
		// is why the list's silent early return was unknowable from outside.
		getBoundRunnerConn.mockResolvedValue(null);
		const { body } = await recheck(localRepo);
		expect(body.checked).toBe(false);
		expect(body.verdict).toMatchObject({ state: "unverified" });
		expect(String(body.reason)).toMatch(/\S/);
		expect(callRunner).not.toHaveBeenCalled();
	});

	it("does not leave a stale `ready` standing when nobody could look", async () => {
		// `onUnverified: "unknown"` — ADD's answer, not LIST's. This is a deliberate REQUEST for a
		// verdict, so "nobody could look" is a result worth recording; leaving yesterday's `ready`
		// would answer the question the owner asked with the claim they are doubting.
		getBoundRunnerConn.mockResolvedValue(null);
		const { issued } = await recheck({ ...localRepo, clone_status: "ready", clone_error: null });
		const update = issued.filter((s) => s.sql.startsWith("UPDATE coding_repos SET clone_status")).pop();
		expect(update?.binds[1]).toBe("unknown");
		// Still not a look at the directory, so still no check time.
		expect(update?.binds[5]).toBe(0);
	});

	it("refuses a repo with no local path instead of checking nothing", async () => {
		getBoundRunnerConn.mockResolvedValue(FAKE_CONN);
		const { body } = await recheck({ ...localRepo, workdir: null, provider: "github", github_repo: "o/r", clone_url: "https://github.com/o/r.git" });
		expect(body.checked).toBe(false);
		expect(String(body.reason)).toMatch(/no local path/i);
		expect(callRunner).not.toHaveBeenCalled();
	});
});
