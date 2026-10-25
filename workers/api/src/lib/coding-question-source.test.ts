/**
 * #1363 — the source of a coding question and whether its context is still a safe premise.
 *
 * Over the real schema: a registered repo, a session bound to an issue, a ticket carrying the issue sync's cache, and a
 * run joining them. What is asserted is behavior: the exact URL and title, the staleness verdict and its reason, and that
 * nothing here ever calls GitHub or reads the question's words.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import {
	assessStaleness,
	CONTEXT_OLD_MS,
	codingQuestionIssue,
	codingQuestionIssueUrl,
	codingQuestionSource,
	questionSourceFields,
	questionSourceLead,
	questionSourceNotice,
	questionSourceTail,
	sanitizeQuestionIssue,
	withQuestionSources,
} from "./coding-question-source.js";
import type { IssueCache } from "./issue-tickets.js";
import type { Env } from "../types.js";

const NOW = Date.parse("2026-10-25T12:00:00Z");
const ASKED = Date.parse("2026-10-25T10:00:00Z");
const HOUR = 3_600_000;
const IDS = { instanceId: "coder", userId: "u1", sessionId: "s1", runId: "run-1" };

let d1: RealSchemaD1;
let env: Env;

const cache = (over: Partial<IssueCache> = {}): IssueCache => ({
	number: 1349, repo: "ProAgentStore/platform", title: "Page GitHub evidence safely", state: "open", stateReason: null, labels: [], assignees: [],
	url: "https://github.com/ProAgentStore/platform/issues/1349", updatedAt: "2026-10-25T09:00:00Z", closedAt: null, summary: "Read every page of the release evidence before posting.", ...over,
});

/** A run bound to issue 1349 through its ticket, whose cache was last written `syncedAgoMs` before NOW. */
function bind(opts: { cache?: IssueCache | null; syncedAgoMs?: number; repo?: string; number?: number } = {}) {
	const number = opts.number ?? 1349;
	d1.exec(`UPDATE coding_repos SET github_repo = '${opts.repo ?? "ProAgentStore/platform"}' WHERE id = 'repo-1'`);
	d1.exec(`UPDATE coding_sessions SET issue_number = ${number} WHERE id = 's1'`);
	const synced = new Date(NOW - (opts.syncedAgoMs ?? HOUR)).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
	const body = opts.cache === null ? "NULL" : `'${JSON.stringify(opts.cache ?? cache()).replace(/'/g, "''")}'`;
	d1.exec(`INSERT INTO tickets (id, instance_id, user_id, job_key, title, created_by, issue_number, repo_id, issue_cache, updated_at) VALUES ('t1', 'coder', 'u1', 'issue:repo-1#${number}', 'ticket', 'agent', ${number}, 'repo-1', ${body}, '${synced}')`);
	d1.exec("INSERT INTO agent_loop_runs (run_id, user_id, instance_id, objective, status, iteration, max_iterations, started_at, session_id, ticket_id) VALUES ('run-1','u1','coder','implement 1349','running',1,10,1,'s1','t1')");
}
const source = (askedAt: number | null = ASKED) => codingQuestionSource(env, IDS, { askedAt, now: NOW });

beforeEach(() => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["coder"] });
	d1.exec("INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo) VALUES ('repo-1', 'coder', 'u1', 'platform', 'ProAgentStore/platform')");
	d1.exec("INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, issue_number) VALUES ('s1', 'coder', 'repo-1', 'u1', NULL)");
	env = { DB: d1.DB } as unknown as Env;
});
afterEach(() => {
	vi.unstubAllGlobals();
	d1.close();
});

describe("a linked, fresh issue (#1363)", () => {
	it("carries the exact URL, title, summary and state from the bound ticket, and is not stale", async () => {
		bind();
		const found = await source();
		expect(found.status).toBe("linked");
		expect(found.issue).toEqual({
			repo: "ProAgentStore/platform", number: 1349, title: "Page GitHub evidence safely", url: "https://github.com/ProAgentStore/platform/issues/1349",
			summary: "Read every page of the release evidence before posting.", issueState: "open", issueUpdatedAt: "2026-10-25T09:00:00Z", cacheAge: HOUR,
		});
		expect(questionSourceNotice(found)).toBe("");
		expect(questionSourceLead(found.issue, "x/y")).toBe("ProAgentStore/platform#1349 — Page GitHub evidence safely. https://github.com/ProAgentStore/platform/issues/1349");
	});
	it("codingQuestionIssue is the same issue without the status", async () => {
		bind();
		expect((await codingQuestionIssue(env, IDS, { askedAt: ASKED, now: NOW }))?.number).toBe(1349);
	});
});

describe("a stale source is flagged with the reason and never rewritten (#1363)", () => {
	it("a closed issue: the premise may no longer hold", async () => {
		bind({ cache: cache({ state: "closed", closedAt: "2026-10-24T18:30:00Z", stateReason: "completed" }) });
		const { issue } = await source();
		expect(issue).toMatchObject({ stale: true, staleReason: "issue_closed", issueState: "closed" });
		expect(issue?.staleDetail).toMatch(/closed \(since 2026-10-24\)/);
		expect(questionSourceNotice({ status: "linked", issue })).toMatch(/Needs refresh: the source issue is closed/);
		expect(questionSourceNotice({ status: "linked", issue })).toMatch(/the question is unchanged/);
	});
	it("an issue updated after the question was asked", async () => {
		bind({ cache: cache({ updatedAt: "2026-10-25T11:00:00Z" }) });
		expect((await source()).issue).toMatchObject({ stale: true, staleReason: "issue_changed_since_asked" });
	});
	it("without an asked-at the 'changed since' rule cannot fire, so a fresh cache stays fresh", async () => {
		bind({ cache: cache({ updatedAt: "2026-10-25T11:00:00Z" }) });
		expect((await source(null)).issue?.stale).toBeUndefined();
	});
	it("a cache not refreshed for more than a day", async () => {
		bind({ syncedAgoMs: 30 * HOUR, cache: cache({ updatedAt: "2026-10-23T00:00:00Z" }) });
		const { issue } = await source();
		expect(issue).toMatchObject({ stale: true, staleReason: "context_old", cacheAge: 30 * HOUR });
		expect(issue?.staleDetail).toMatch(/refreshed 30 hours ago/);
	});
	it("closed outranks changed, and changed outranks old", async () => {
		bind({ syncedAgoMs: 40 * HOUR, cache: cache({ state: "closed", updatedAt: "2026-10-25T11:00:00Z" }) });
		expect((await source()).issue?.staleReason).toBe("issue_closed");
		d1.exec("DELETE FROM agent_loop_runs; DELETE FROM tickets");
		bind({ syncedAgoMs: 40 * HOUR, cache: cache({ updatedAt: "2026-10-25T11:00:00Z" }) });
		expect((await source()).issue?.staleReason).toBe("issue_changed_since_asked");
	});
	it("the boundary: exactly a day is still fresh, a minute more is old", () => {
		const base = { askedAt: ASKED, now: NOW };
		expect(assessStaleness(cache(), { ...base, syncedAt: NOW - CONTEXT_OLD_MS }).stale).toBeUndefined();
		expect(assessStaleness(cache(), { ...base, syncedAt: NOW - CONTEXT_OLD_MS - 60_000 }).staleReason).toBe("context_old");
		expect(assessStaleness(null, { ...base, syncedAt: NOW })).toEqual({ cacheAge: 0 });
	});
	it("the sync's closed state is read case-insensitively", () => {
		expect(assessStaleness(cache({ state: "CLOSED" }), { now: NOW }).staleReason).toBe("issue_closed");
	});
});

describe("a missing or unusable source never invents a link (#1363)", () => {
	it("a run bound to no issue is 'none', not 'unavailable'", async () => {
		const found = await source();
		expect(found).toEqual({ status: "none", issue: null });
		expect(questionSourceNotice(found)).toBe("");
		expect(questionSourceTail(found)).toBe(" No issue is linked to this run.");
	});
	it("a session that is not this instance's or this owner's is 'none'", async () => {
		bind();
		expect((await codingQuestionSource(env, { ...IDS, instanceId: "other" })).status).toBe("none");
		expect((await codingQuestionSource(env, { ...IDS, userId: "u2" })).status).toBe("none");
		expect((await codingQuestionSource(env, { ...IDS, sessionId: "nope" })).status).toBe("none");
	});
	it("an unsafe registered repository builds no URL at all", async () => {
		bind({ repo: "acme/app?x=1" });
		expect(await source()).toEqual({ status: "none", issue: null });
		for (const repo of ["acme", "acme/app/extra", "https://evil.example/x", "../x", "a b/c", ""]) expect(codingQuestionIssueUrl(repo, 7), repo).toBeNull();
		for (const number of [0, -1, 1.5, Number.NaN, "7", null, undefined]) expect(codingQuestionIssueUrl("acme/app", number), String(number)).toBeNull();
	});
	it("a cache for ANOTHER issue is not trusted: the title falls back and nothing is flagged from it", async () => {
		bind({ cache: cache({ number: 99, title: "Someone else's issue", state: "closed", summary: "secret plans" }) });
		const { issue } = await source();
		expect(issue).toEqual({ repo: "ProAgentStore/platform", number: 1349, title: "Issue #1349", url: "https://github.com/ProAgentStore/platform/issues/1349", cacheAge: HOUR });
	});
	it("a cache from another repository is not trusted either", async () => {
		bind({ cache: cache({ repo: "someone/else", title: "Spoofed" }) });
		expect((await source()).issue?.title).toBe("Issue #1349");
	});
	it("a ticket with no cache yet is linked, with the plain title and no flags", async () => {
		bind({ cache: null });
		expect((await source()).issue).toMatchObject({ title: "Issue #1349", url: "https://github.com/ProAgentStore/platform/issues/1349" });
		expect((await source()).issue?.stale).toBeUndefined();
	});
	it("question prose is never read: the number comes from the bound session only", async () => {
		bind({ number: 7, cache: cache({ number: 7, title: "Seven" }) });
		const found = await codingQuestionSource(env, IDS);
		expect(found.issue?.number).toBe(7);
		expect(found.issue?.url).toBe("https://github.com/ProAgentStore/platform/issues/7");
	});
});

describe("a failed lookup is reported, not hidden, and never blocks (#1363)", () => {
	it("a database failure is 'unavailable' and does not throw", async () => {
		const broken = { DB: { prepare: () => { throw new Error("D1 is down"); } } } as unknown as Env;
		const found = await codingQuestionSource(broken, IDS);
		expect(found).toEqual({ status: "unavailable", issue: null });
		expect(questionSourceNotice(found)).toBe("The source issue could not be loaded, so check the run before answering.");
		expect(questionSourceTail(found)).toContain("could not be loaded");
		expect(await codingQuestionIssue(broken, IDS)).toBeNull();
	});
	it("GitHub is never called: the source comes from the stored cache alone", async () => {
		const fetchSpy = vi.fn(async () => { throw new Error("GitHub must not be reached"); });
		vi.stubGlobal("fetch", fetchSpy);
		bind();
		expect((await source()).status).toBe("linked");
		await withQuestionSources(env, [{ ...IDS, runId: "run-1", askedAt: ASKED }]); // the batch read stays off the network too
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("stored issue JSON cannot smuggle a link or a flag (#1363)", () => {
	const good = { repo: "ProAgentStore/platform", number: 1349, title: "T", url: "https://github.com/ProAgentStore/platform/issues/1349" };
	it("keeps a well-formed issue with its freshness fields", () => {
		expect(sanitizeQuestionIssue({ ...good, summary: "s", issueState: "closed", issueUpdatedAt: "x", cacheAge: 5, stale: true, staleReason: "issue_closed", staleDetail: "d" }))
			.toEqual({ ...good, summary: "s", issueState: "closed", issueUpdatedAt: "x", cacheAge: 5, stale: true, staleReason: "issue_closed", staleDetail: "d" });
	});
	it("refuses a URL that is not the one its own repo and number build", () => {
		for (const url of ["https://github.com/ProAgentStore/platform/issues/1350", "https://github.com.evil.example/ProAgentStore/platform/issues/1349", "javascript:alert(1)", ""]) {
			expect(sanitizeQuestionIssue({ ...good, url }), url).toBeNull();
		}
		expect(sanitizeQuestionIssue({ ...good, repo: "someone/else" })).toBeNull();
		expect(sanitizeQuestionIssue(null)).toBeNull();
		expect(sanitizeQuestionIssue("https://github.com/x/y/issues/1")).toBeNull();
	});
	it("drops a flag with an unknown reason, a mistyped age, and a flag that is not literally true", () => {
		const out = sanitizeQuestionIssue({ ...good, stale: true, staleReason: "trust_me", cacheAge: -5, issueState: 7 });
		expect(out).toEqual(good);
		expect(sanitizeQuestionIssue({ ...good, stale: "yes", staleReason: "issue_closed" })).toEqual(good);
	});
	it("falls back to a plain title when the stored one is empty", () => {
		expect(sanitizeQuestionIssue({ ...good, title: "  " })?.title).toBe("Issue #1349");
	});
});

describe("the coder_questions rows carry the source beside each question (#1363)", () => {
	it("adds title, summary, state, age and the stale verdict, and an honest status when there is none", async () => {
		bind({ cache: cache({ state: "closed", closedAt: "2026-10-25T08:00:00Z" }) });
		const q = { instanceId: "coder", userId: "u1", sessionId: "s1", runId: "run-1", askedAt: ASKED, id: "q1" };
		const [linked] = await withQuestionSources(env, [q]);
		expect(linked).toMatchObject({ id: "q1", issueStatus: "linked", issueTitle: "Page GitHub evidence safely", issueState: "closed", stale: true, staleReason: "issue_closed" });
		expect(linked.issueSummary).toContain("release evidence");
		const [none] = await withQuestionSources(env, [{ ...q, sessionId: "nope" }]);
		expect(none).toMatchObject({ issueStatus: "none" });
		expect(none).not.toHaveProperty("stale");
		expect(questionSourceFields({ status: "unavailable", issue: null })).toEqual({ issueStatus: "unavailable" });
	});
});
