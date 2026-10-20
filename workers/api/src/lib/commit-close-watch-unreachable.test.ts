/**
 * #1246 — a repo the commit-close watch can never reach is recorded ONCE and backed off.
 *
 * Live, 30 days: ~40k of 45,980 error occurrences were this sweep re-declining the same bindings every
 * tick — vibecodeqa/* with no App installation, a chess-academy that moved to ChessClubs-online, an org
 * that does not exist. These run the real sweep over the real migrated schema, so the back-off is the
 * SELECT's own filter; only GitHub and the error log are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMIT_CLOSE_UNREACHABLE_RETRY_HOURS, runCommitCloseWatch } from "./commit-close-watch.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { logError } from "./error-log.js";
import { installationTokenForOwner } from "./github-app.js";
import { githubConditionalJson } from "./github-cache.js";
import type { Env } from "../types.js";

vi.mock("./github-app.js", () => ({ installationTokenForOwner: vi.fn() }));
vi.mock("./github-cache.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./github-cache.js")>()),
	githubConditionalJson: vi.fn(),
	githubAuthContext: vi.fn(async () => "app:1"),
	invalidateGithubCache: vi.fn(async () => undefined),
}));
vi.mock("./error-log.js", () => ({ logError: vi.fn(async () => undefined) }));

let d1: RealSchemaD1;
let env: Env;

const NO_INSTALL = /no GitHub App installation token/;
const NOT_FOUND = /GitHub returned 404/;

const repo = () =>
	d1.sqlite.prepare("SELECT github_repo, commit_watch_unreachable AS why, commit_watch_unreachable_repo AS forRepo, commit_watch_retry_at AS retryAt FROM coding_repos WHERE id = 'r1'").get() as {
		github_repo: string;
		why: string | null;
		forRepo: string | null;
		retryAt: string | null;
	};
const logged = () => vi.mocked(logError).mock.calls.map(([, e]) => (e as { message: string }).message);
/** The back-off has run out: the next sweep may look again. */
const expire = () => d1.exec("UPDATE coding_repos SET commit_watch_retry_at = datetime('now', '-1 minute') WHERE id = 'r1'");
const page404 = () => vi.mocked(githubConditionalJson).mockResolvedValue({ ok: false, status: 404, fromCache: false, stale: false, data: null } as never);
const pageOk = () =>
	vi.mocked(githubConditionalJson).mockResolvedValue({
		ok: true,
		fromCache: false,
		stale: false,
		data: [{ sha: "new", commit: { message: "nothing to close", committer: { date: "2026-10-20T00:00:00Z" } } }],
	} as never);

beforeEach(() => {
	vi.clearAllMocks();
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["i1"] });
	d1.exec("INSERT INTO coding_repos (id, instance_id, user_id, name, workdir, github_repo) VALUES ('r1', 'i1', 'u1', 'ops', '~/dev/ops', 'vibecodeqa/ops')");
	env = { DB: d1.DB } as unknown as Env;
	vi.mocked(installationTokenForOwner).mockResolvedValue(null);
});
afterEach(() => d1.close());

describe("no GitHub App installation for the owner (#1246)", () => {
	it("is logged ONCE and backed off: the next ticks neither ask for a token nor log", async () => {
		await runCommitCloseWatch(env);
		expect(logged()).toEqual([expect.stringMatching(NO_INSTALL)]);
		expect(logged()[0]).toContain(`Retried every ${COMMIT_CLOSE_UNREACHABLE_RETRY_HOURS}h`);
		expect(repo()).toMatchObject({ why: expect.stringMatching(NO_INSTALL), forRepo: "vibecodeqa/ops", retryAt: expect.any(String) });

		for (let tick = 0; tick < 5; tick++) await runCommitCloseWatch(env);
		expect(installationTokenForOwner).toHaveBeenCalledTimes(1);
		expect(logError).toHaveBeenCalledTimes(1);
	});

	it("after the back-off it is tried again — and, still unreachable for the same reason, NOT logged again", async () => {
		await runCommitCloseWatch(env);
		expire();
		await runCommitCloseWatch(env);
		expect(installationTokenForOwner).toHaveBeenCalledTimes(2);
		expect(logError).toHaveBeenCalledTimes(1);
		expect(d1.sqlite.prepare("SELECT commit_watch_retry_at > datetime('now') AS ahead FROM coding_repos WHERE id = 'r1'").get()).toEqual({ ahead: 1 });
	});

	it("an installation added later: the next try reaches the page, and the record is cleared", async () => {
		await runCommitCloseWatch(env);
		expire();
		vi.mocked(installationTokenForOwner).mockResolvedValue("tok");
		pageOk();
		await runCommitCloseWatch(env);
		expect(repo()).toMatchObject({ why: null, forRepo: null, retryAt: null });
		expect(logError).toHaveBeenCalledTimes(1);
	});
});

describe("a commits page GitHub answers 404 (#1246: chess-academy moved, an org that does not exist)", () => {
	beforeEach(() => {
		vi.mocked(installationTokenForOwner).mockResolvedValue("tok");
		page404();
	});

	it("is logged once, naming the likely causes, and backed off", async () => {
		await runCommitCloseWatch(env);
		await runCommitCloseWatch(env);
		expect(logged()).toEqual([expect.stringMatching(NOT_FOUND)]);
		expect(logged()[0]).toMatch(/renamed, moved, deleted, or not in the installation/);
		expect(githubConditionalJson).toHaveBeenCalledTimes(1);
	});

	it("a CHANGED reason is logged — the record says what is true now", async () => {
		await runCommitCloseWatch(env);
		expire();
		vi.mocked(installationTokenForOwner).mockResolvedValue(null);
		await runCommitCloseWatch(env);
		expect(logged()).toEqual([expect.stringMatching(NOT_FOUND), expect.stringMatching(NO_INSTALL)]);
	});

	it("a binding re-pointed at another repo is tried at once, not after the back-off", async () => {
		await runCommitCloseWatch(env);
		d1.exec("UPDATE coding_repos SET github_repo = 'ChessClubs-online/chess-clubs' WHERE id = 'r1'");
		pageOk();
		await runCommitCloseWatch(env);
		expect(githubConditionalJson).toHaveBeenCalledTimes(2);
		expect(vi.mocked(githubConditionalJson).mock.calls[1][1].url).toContain("/repos/ChessClubs-online/chess-clubs/commits?");
		expect(repo()).toMatchObject({ why: null, retryAt: null });
	});
});

describe("a failure that CAN change between ticks is not backed off (#1246)", () => {
	it("a 500 is still declined and logged per tick, with no unreachable record", async () => {
		vi.mocked(installationTokenForOwner).mockResolvedValue("tok");
		vi.mocked(githubConditionalJson).mockResolvedValue({ ok: false, status: 500, fromCache: false, stale: false, data: null } as never);
		await runCommitCloseWatch(env);
		await runCommitCloseWatch(env);
		expect(githubConditionalJson).toHaveBeenCalledTimes(2);
		expect(logged()).toEqual([expect.stringMatching(/declined a commits page .*: GitHub returned 500/), expect.stringMatching(/GitHub returned 500/)]);
		expect(repo()).toMatchObject({ why: null, retryAt: null });
	});
});
