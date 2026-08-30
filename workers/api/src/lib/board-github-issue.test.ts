/**
 * GitHub issue backing for board cards (#682).
 *
 * Tests the foundational slice: link/unlink a card to an issue (number + cached
 * projection), refresh cached projections for all linked cards, and verify the
 * projection is included in `buildInstanceBoard` when populated.
 *
 * Driven against `realSchemaD1` so the ALTER TABLE columns added in migration 0144
 * are present and the SQL actually runs — stub-based tests would not catch a missing
 * column or a wrong COALESCE.
 */
import { describe, expect, it } from "vitest";
import { linkBoardItemGithubIssue, refreshBoardGithubIssues, buildInstanceBoard } from "./board.js";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import type { Env } from "../types.js";
import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

vi.mock("./github-app.js", () => ({
	installationTokenForOwner: vi.fn(async () => null), // no GitHub App configured
}));

const GITHUB_ISSUE_1 = {
	number: 42,
	title: "Fix the widget",
	state: "open",
	labels: ["bug", "P1"],
	comments: 3,
	updatedAt: "2026-08-01T00:00:00Z",
	url: "https://github.com/acme/widget/issues/42",
};

const GITHUB_ISSUE_2 = {
	number: 7,
	title: "Add dark mode",
	state: "closed",
	labels: ["enhancement"],
	comments: 0,
	updatedAt: "2026-08-02T00:00:00Z",
	url: "https://github.com/acme/widget/issues/7",
};

function mockFetch(handler: (url: string) => { status: number; body: unknown }) {
	globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		const { status, body } = handler(url);
		return {
			ok: status >= 200 && status < 300,
			status,
			headers: { get: () => null },
			json: async () => body,
		} as unknown as Response;
	}) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER = "user-1";
const INSTANCE = "inst-1";
const JOB_KEY = "acme.co/careers/widget";
const REPO = "acme/widget";

function setup(): { d1: RealSchemaD1; env: Env } {
	const d1 = realSchemaD1();
	seedTenant(d1, { userId: USER, instanceIds: [INSTANCE] });
	const env = { DB: d1.DB } as unknown as Env;
	return { d1, env };
}

function storedRow(d1: RealSchemaD1, jobKey = JOB_KEY) {
	return d1.sqlite
		.prepare("SELECT github_issue_number, github_issue_cache FROM board_items WHERE instance_id = ? AND user_id = ? AND job_key = ?")
		.get(INSTANCE, USER, jobKey) as { github_issue_number: number | null; github_issue_cache: string | null } | undefined;
}

// ---------------------------------------------------------------------------
// Tests: linkBoardItemGithubIssue
// ---------------------------------------------------------------------------

describe("linkBoardItemGithubIssue — link", () => {
	it("stores the issue number and populates the cache when GitHub responds", async () => {
		const { d1, env } = setup();
		mockFetch(() => ({
			status: 200,
			body: { number: 42, title: "Fix the widget", state: "open", comments: 3, updated_at: "2026-08-01T00:00:00Z", html_url: "https://github.com/acme/widget/issues/42", body: "", labels: [{ name: "bug" }, { name: "P1" }] },
		}));

		const result = await linkBoardItemGithubIssue(env, INSTANCE, USER, JOB_KEY, { repo: REPO, issueNumber: 42 });
		expect(result.ok).toBe(true);
		if (result.ok && result.issue) {
			expect(result.issue.number).toBe(42);
			expect(result.issue.title).toBe("Fix the widget");
			expect(result.issue.state).toBe("open");
			expect(result.issue.labels).toEqual(["bug", "P1"]);
		}

		const row = storedRow(d1)!;
		expect(row).toBeTruthy();
		expect(row.github_issue_number).toBe(42);
		const cached = JSON.parse(row.github_issue_cache ?? "{}") as Record<string, unknown>;
		expect(cached.title).toBe("Fix the widget");
		expect(cached.labels).toEqual(["bug", "P1"]);
		d1.close();
	});

	it("stores the number but returns ok:false when GitHub is unreachable, leaving cache empty", async () => {
		const { d1, env } = setup();
		mockFetch(() => ({ status: 404, body: {} }));

		const result = await linkBoardItemGithubIssue(env, INSTANCE, USER, JOB_KEY, { repo: REPO, issueNumber: 99 });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatch(/99/);

		const row = storedRow(d1)!;
		expect(row).toBeTruthy();
		expect(row.github_issue_number).toBe(99);
		expect(row.github_issue_cache).toBe("");
		d1.close();
	});

	it("does not overwrite an existing user_status when linking a pre-moved card", async () => {
		const { d1, env } = setup();
		// Seed a moved card.
		d1.sqlite.prepare(
			"INSERT INTO board_items (instance_id, user_id, job_key, user_status, title, subtitle, url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))",
		).run(INSTANCE, USER, JOB_KEY, "interview", "Widget role", "acme.co", "https://acme.co/careers/widget");

		mockFetch(() => ({
			status: 200,
			body: { number: 42, title: "Fix the widget", state: "open", comments: 0, updated_at: "", html_url: "u42", body: "", labels: [] },
		}));

		await linkBoardItemGithubIssue(env, INSTANCE, USER, JOB_KEY, { repo: REPO, issueNumber: 42 });

		// The user_status must still be "interview" — linking never touches it.
		const row = d1.sqlite.prepare(
			"SELECT user_status, github_issue_number FROM board_items WHERE instance_id = ? AND user_id = ? AND job_key = ?",
		).get(INSTANCE, USER, JOB_KEY) as { user_status: string; github_issue_number: number } | undefined;
		expect(row?.user_status).toBe("interview");
		expect(row?.github_issue_number).toBe(42);
		d1.close();
	});
});

describe("linkBoardItemGithubIssue — unlink", () => {
	it("clears github_issue_number and github_issue_cache on an existing row", async () => {
		const { d1, env } = setup();
		// Seed a linked card.
		d1.sqlite.prepare(
			"INSERT INTO board_items (instance_id, user_id, job_key, user_status, title, subtitle, url, github_issue_number, github_issue_cache, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))",
		).run(INSTANCE, USER, JOB_KEY, "open", "Widget", "acme.co", "https://acme.co/j", 42, JSON.stringify({ number: 42, title: "t", state: "open", labels: [], url: "u" }));

		const result = await linkBoardItemGithubIssue(env, INSTANCE, USER, JOB_KEY, null);
		expect(result.ok).toBe(true);

		const row = storedRow(d1)!;
		expect(row.github_issue_number).toBeNull();
		expect(row.github_issue_cache).toBe("");
		d1.close();
	});

	it("is a no-op when the card does not exist yet (no error)", async () => {
		const { d1, env } = setup();
		const result = await linkBoardItemGithubIssue(env, INSTANCE, USER, "unknown-key", null);
		expect(result.ok).toBe(true);
		d1.close();
	});
});

// ---------------------------------------------------------------------------
// Tests: refreshBoardGithubIssues
// ---------------------------------------------------------------------------

describe("refreshBoardGithubIssues", () => {
	it("updates the cache for every linked card and reports counts", async () => {
		const { d1, env } = setup();
		// Seed two linked cards (empty cache — simulating fresh link with unavailable GitHub).
		d1.sqlite.prepare(
			"INSERT INTO board_items (instance_id, user_id, job_key, user_status, title, subtitle, url, github_issue_number, github_issue_cache, updated_at) VALUES (?, ?, ?, NULL, '', '', '', ?, '', datetime('now'))",
		).run(INSTANCE, USER, JOB_KEY, 42);
		d1.sqlite.prepare(
			"INSERT INTO board_items (instance_id, user_id, job_key, user_status, title, subtitle, url, github_issue_number, github_issue_cache, updated_at) VALUES (?, ?, ?, NULL, '', '', '', ?, '', datetime('now'))",
		).run(INSTANCE, USER, "other-key", 7);

		mockFetch((url) => {
			if (url.includes("/issues/42")) return { status: 200, body: { ...GITHUB_ISSUE_1, body: "", pull_request: undefined, updated_at: GITHUB_ISSUE_1.updatedAt, html_url: GITHUB_ISSUE_1.url, labels: GITHUB_ISSUE_1.labels.map((n) => ({ name: n })) } };
			if (url.includes("/issues/7")) return { status: 200, body: { ...GITHUB_ISSUE_2, body: "", pull_request: undefined, updated_at: GITHUB_ISSUE_2.updatedAt, html_url: GITHUB_ISSUE_2.url, labels: GITHUB_ISSUE_2.labels.map((n) => ({ name: n })) } };
			return { status: 404, body: {} };
		});

		const result = await refreshBoardGithubIssues(env, INSTANCE, USER, REPO);
		expect(result.refreshed).toBe(2);
		expect(result.skipped).toBe(0);

		const r1 = storedRow(d1, JOB_KEY)!;
		const c1 = JSON.parse(r1.github_issue_cache ?? "{}") as Record<string, unknown>;
		expect(c1.title).toBe("Fix the widget");
		expect(c1.labels).toEqual(["bug", "P1"]);

		const r2 = storedRow(d1, "other-key")!;
		const c2 = JSON.parse(r2.github_issue_cache ?? "{}") as Record<string, unknown>;
		expect(c2.title).toBe("Add dark mode");
		d1.close();
	});

	it("counts skipped issues when GitHub returns an error", async () => {
		const { d1, env } = setup();
		d1.sqlite.prepare(
			"INSERT INTO board_items (instance_id, user_id, job_key, user_status, title, subtitle, url, github_issue_number, github_issue_cache, updated_at) VALUES (?, ?, ?, NULL, '', '', '', ?, '', datetime('now'))",
		).run(INSTANCE, USER, JOB_KEY, 42);

		mockFetch(() => ({ status: 503, body: {} }));

		const result = await refreshBoardGithubIssues(env, INSTANCE, USER, REPO);
		expect(result.refreshed).toBe(0);
		expect(result.skipped).toBe(1);
		d1.close();
	});

	it("returns zero counts when no cards are linked", async () => {
		const { d1, env } = setup();
		const result = await refreshBoardGithubIssues(env, INSTANCE, USER, REPO);
		expect(result.refreshed).toBe(0);
		expect(result.skipped).toBe(0);
		d1.close();
	});
});

// ---------------------------------------------------------------------------
// Tests: buildInstanceBoard includes githubIssue
// ---------------------------------------------------------------------------

describe("buildInstanceBoard — githubIssue projection", () => {
	it("includes the cached issue projection on a standalone card (moved with runs cleared)", async () => {
		const { d1, env } = setup();
		// A standalone card: has user_status + github_issue fields but no runtime tasks.
		const cache = JSON.stringify({ number: 42, title: "Fix the widget", state: "open", labels: ["bug"], url: "https://github.com/acme/widget/issues/42" });
		d1.sqlite.prepare(
			"INSERT INTO board_items (instance_id, user_id, job_key, user_status, title, subtitle, url, github_issue_number, github_issue_cache, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))",
		).run(INSTANCE, USER, JOB_KEY, "interview", "Widget", "acme.co", "https://acme.co/j", 42, cache);

		const board = await buildInstanceBoard(env, INSTANCE, USER);
		const card = board.items.find((i) => i.jobKey === JOB_KEY);
		expect(card).toBeTruthy();
		expect(card?.githubIssue).toMatchObject({ number: 42, title: "Fix the widget", state: "open", labels: ["bug"] });
		d1.close();
	});

	it("omits githubIssue on cards with no link", async () => {
		const { d1, env } = setup();
		d1.sqlite.prepare(
			"INSERT INTO board_items (instance_id, user_id, job_key, user_status, title, subtitle, url, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))",
		).run(INSTANCE, USER, JOB_KEY, "interview", "Widget", "acme.co", "https://acme.co/j");

		const board = await buildInstanceBoard(env, INSTANCE, USER);
		const card = board.items.find((i) => i.jobKey === JOB_KEY);
		expect(card?.githubIssue).toBeUndefined();
		d1.close();
	});
});
