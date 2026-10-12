/**
 * The grounded coder brain (#1026): what it reads before deciding, the evidence rule and the confidence threshold,
 * through the real sweep and the real store over the real schema. Only the model and the issue comment/notify
 * effects are faked; the GitHub reads are stubbed at `fetch`, so the real grounding code runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { realSchemaD1, seedTenant, type RealSchemaD1 } from "./d1-sqlite.js";
import { setCoderBrain } from "./coder-brain.js";
import { citedSources, declineAfterModel, sourceLabels, type DecisionContext } from "./coder-brain-decide.js";
import { linkedIssueNumbers, namedFiles } from "./coder-brain-grounding.js";
import { getCoderQuestion, markHumanAnswered } from "./coder-question-store.js";
import { type CoderQuestionEffects, captureAndAnnounceQuestion, defaultEffects, runDueCoderQuestions } from "./coder-question-sweep.js";
import type { Env } from "../types.js";

const MIN = 60_000;
let d1: RealSchemaD1;
let env: Env;

/** The repo GitHub serves, by path suffix. Docs settle the layout question; nothing settles the fixtures one. */
const GITHUB: Record<string, unknown> = {
	"/issues/7": { number: 7, title: "Members table", body: "Rework the members table. See #5 for the design decision.", labels: [], state: "open" },
	"/issues/5": { number: 5, title: "Table design system", body: "Decided: every list uses the COMPACT layout.", labels: [], state: "closed" },
	"/issues/9": { number: 9, title: "Import fixtures from the league", body: "Import the league's fixtures. Open question: hold imported fixtures back from members until a club admin reviews them, or publish them at once?", labels: [], state: "open" },
	"/issues/7/comments": [],
	"/issues/9/comments": [{ user: { login: "serge-ivo" }, body: "Not sure yet — admins want control, members want speed." }],
	"/issues?state=open": [{ number: 7, title: "Members table", state: "open", labels: [], comments: 0, updated_at: "2026-10-12T00:00:00Z", html_url: "x" }, { number: 9, title: "Import fixtures from the league", state: "open", labels: [{ name: "epic:fixtures" }], comments: 1, updated_at: "2026-10-12T00:00:00Z", html_url: "x" }],
	"/issues?state=closed": [{ number: 5, title: "Table design system", state: "closed", labels: [{ name: "design" }], comments: 0, updated_at: "2026-10-01T00:00:00Z", html_url: "x" }],
	"/contents/docs": [{ type: "file", path: "docs/table-layout.md" }, { type: "file", path: "docs/billing.md" }],
	"/contents/docs/table-layout.md": "# Table layout\n\nAll tables use the compact layout. Comfortable is reserved for print views.",
	"/contents/README.md": "# Clubs app",
	"/contents/src/members/table.tsx": "export const layout = 'compact';",
	"/commits?": [{ sha: "a1b2c3d4e5f6", commit: { message: "feat: compact fixtures list" } }],
};
function stubGithub() {
	vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
		const url = String(input);
		const key = Object.keys(GITHUB)
			.filter((k) => (k.endsWith("?") || k.includes("?") ? url.includes(k) : url.split("?")[0].endsWith(k)))
			.sort((a, b) => b.length - a.length)[0];
		if (!key) return new Response("not found", { status: 404 });
		const v = GITHUB[key];
		return typeof v === "string" ? new Response(v) : Response.json(v);
	});
}

/**
 * A fake model that is HONEST about grounding: it decides only when the source that settles the question is in
 * its prompt, and cites it. `confidence` is what it reports when it decides.
 */
function model(confidence: number, seen: string[]) {
	return async (p: { system: string; user: string }) => {
		seen.push(p.user);
		if (/\[docs\/table-layout\.md\][\s\S]*compact layout/.test(p.user)) {
			return JSON.stringify({ decision: "compact", confidence, reason: "docs/table-layout.md: all tables use the compact layout", evidence: ["docs/table-layout.md", "issue #5"], options_considered: ["compact", "comfortable"], risks: ["print views differ"] });
		}
		return JSON.stringify({ declined: true, confidence: 0.4, reason: "a product trade-off nothing in the sources settles", what_would_settle_it: "The owner's choice: hold imported fixtures for admin review, or publish them at once." });
	};
}

function effects(confidence: number, seen: string[], log: { comments: string[]; notified: Array<{ title: string; alert: boolean }>; contextCalls: number }): Partial<CoderQuestionEffects> {
	const real = defaultEffects(env);
	return {
		postComment: async (_q, body) => {
			log.comments.push(body);
			return true;
		},
		notify: async (_q, title, _b, alert) => {
			log.notified.push({ title, alert });
		},
		deliver: async () => undefined,
		context: async (q) => {
			log.contextCalls++;
			return real.context(q);
		},
		model: () => model(confidence, seen),
		proRefusal: async () => null,
		audit: async () => undefined,
	};
}

beforeEach(async () => {
	d1 = realSchemaD1();
	seedTenant(d1, { userId: "u1", instanceIds: ["coder", "coder2"] });
	// One session per repo and one repo row per instance (schema): issue 9's session is on a second coder.
	d1.exec("INSERT INTO coding_repos (id, instance_id, user_id, name, github_repo) VALUES ('repo-1', 'coder', 'u1', 'clubs', 'acme/clubs'), ('repo-2', 'coder2', 'u1', 'clubs', 'acme/clubs')");
	d1.exec("INSERT INTO coding_sessions (id, instance_id, repo_id, user_id, issue_number) VALUES ('s7', 'coder', 'repo-1', 'u1', 7), ('s9', 'coder2', 'repo-2', 'u1', 9)");
	env = { DB: d1.DB } as unknown as Env;
	for (const id of ["coder", "coder2"]) await setCoderBrain(env, id, "u1", { enabled: true, humanTimeoutMinutes: 30, escalationTimeoutMinutes: 60 });
	stubGithub();
});
afterEach(() => {
	vi.unstubAllGlobals();
	d1.close();
});

const askLayout = (fx: Partial<CoderQuestionEffects>) =>
	captureAndAnnounceQuestion(env, { instanceId: "coder", userId: "u1", sessionId: "s7", question: "Which layout for src/members/table.tsx?", options: ["compact", "comfortable"], why: "the table is getting dense" }, fx as CoderQuestionEffects);
const FIXTURES_Q = "Should imported fixtures be held from members until an admin reviews them?";
const askFixtures = (fx: Partial<CoderQuestionEffects>, at: { instanceId: string; sessionId: string } = { instanceId: "coder2", sessionId: "s9" }) =>
	captureAndAnnounceQuestion(env, { ...at, userId: "u1", question: FIXTURES_Q, options: ["hold for review", "publish at once"], why: "the issue leaves it open" }, fx as CoderQuestionEffects);

describe("a question the docs and backlog settle", () => {
	it("is decided above threshold, citing those sources — in the issue comment and on the row", async () => {
		const seen: string[] = [];
		const log = { comments: [] as string[], notified: [] as Array<{ title: string; alert: boolean }>, contextCalls: 0 };
		const fx = effects(0.9, seen, log);
		const { question } = await askLayout(fx);
		const r = await runDueCoderQuestions(env, question.askedAt + 31 * MIN, fx);
		expect(r.decided).toBe(1);
		// The grounding reached the model: the linked issue, the backlog, the matching doc, the named file, the commit.
		const prompt = seen[0];
		expect(prompt).toMatch(/\[issue #5\] \(linked, closed\) Table design system/);
		expect(prompt).toMatch(/\[backlog\][\s\S]*#9 \[open\] Import fixtures from the league \(epic:fixtures\)/);
		expect(prompt).toMatch(/\[docs\/table-layout\.md\]/);
		expect(prompt).not.toMatch(/\[docs\/billing\.md\]/); // only docs that share a word with the question
		expect(prompt).toMatch(/\[src\/members\/table\.tsx\] \(code, read-only\)/);
		expect(prompt).toMatch(/a1b2c3d feat: compact fixtures list/);
		const comment = log.comments.find((c) => /Decided by coder brain/.test(c)) ?? "";
		expect(comment).toMatch(/\*\*Evidence:\*\* docs\/table-layout\.md; issue #5/);
		expect(comment).toMatch(/\*\*Risks:\*\* print views differ/);
		expect(await getCoderQuestion(env, question.id)).toMatchObject({ state: "answered_brain", decision: "compact", confidence: 0.9, model: "claude-sonnet-4-6", evidence: ["docs/table-layout.md", "issue #5"], risks: ["print views differ"] });
	});
});

describe("a genuine product trade-off (Tennis Clubs issue 7's question about holding imported fixtures)", () => {
	it("is declined below threshold, the human is asked again, and the decline is recorded with what would settle it", async () => {
		const seen: string[] = [];
		const log = { comments: [] as string[], notified: [] as Array<{ title: string; alert: boolean }>, contextCalls: 0 };
		const fx = effects(0.9, seen, log);
		const { question } = await askFixtures(fx);
		const r = await runDueCoderQuestions(env, question.askedAt + 31 * MIN, fx);
		expect(r.escalated).toBe(1);
		expect(log.notified).toEqual([{ title: "⚠️ Coder still needs your answer", alert: true }]);
		expect(log.comments.at(-1)).toMatch(/could not decide[\s\S]*What would settle it:\*\* The owner's choice: hold imported fixtures/);
		expect(await getCoderQuestion(env, question.id)).toMatchObject({ state: "escalated", confidence: 0.4, model: "claude-sonnet-4-6", reason: expect.stringMatching(/product trade-off/) });
	});
});

describe("the confidence threshold decides the same fixture both ways", () => {
	it.each([
		[0.8, "answered_brain"],
		[0.9, "escalated"],
	])("threshold %s → %s, for a model 0.85 sure", async (threshold, state) => {
		await setCoderBrain(env, "coder", "u1", { confidenceThreshold: threshold });
		const log = { comments: [] as string[], notified: [] as Array<{ title: string; alert: boolean }>, contextCalls: 0 };
		const fx = effects(0.85, [], log);
		const { question } = await askLayout(fx);
		await runDueCoderQuestions(env, question.askedAt + 31 * MIN, fx);
		const q = await getCoderQuestion(env, question.id);
		expect(q?.state).toBe(state);
		expect(q?.confidence).toBe(0.85); // recorded either way
	});
});

describe("a brain-off instance never runs the grounded engine", () => {
	it("no context is gathered and no model is called, however long the question waits", async () => {
		await setCoderBrain(env, "coder", "u1", { enabled: false });
		const seen: string[] = [];
		const log = { comments: [] as string[], notified: [] as Array<{ title: string; alert: boolean }>, contextCalls: 0 };
		const fx = effects(0.95, seen, log);
		const { question } = await askLayout(fx);
		for (const m of [31, 61, 200]) await runDueCoderQuestions(env, question.askedAt + m * MIN, fx);
		expect(log.contextCalls).toBe(0);
		expect(seen).toEqual([]);
	});
});

describe("the evidence rule", () => {
	const ctx: DecisionContext = { question: "q", options: ["compact"], why: null, repo: "acme/clubs", issue: { number: 7, title: "t", body: "b", labels: [] }, comments: [], claudeMd: null, docs: [{ path: "docs/table-layout.md", text: "x" }], recentCommits: ["a1b2c3d feat"] };
	const decision = (evidence: string[]) => ({ decision: "compact", confidence: 0.95, reason: "r", optionsConsidered: [], evidence, risks: [] });

	it("a decision citing nothing — or only sources it was not given — counts as below threshold", () => {
		const labels = sourceLabels(ctx);
		expect(labels).toEqual(["issue #7", "docs/table-layout.md", "commit a1b2c3d"]);
		expect(declineAfterModel(decision([]), ["compact"], 0.8, labels)).toMatch(/cites no evidence/);
		expect(declineAfterModel(decision(["docs/made-up.md", "my intuition"]), ["compact"], 0.8, labels)).toMatch(/cites no evidence/);
		expect(declineAfterModel(decision(["docs/table-layout.md line 3"]), ["compact"], 0.8, labels)).toBeNull();
		expect(citedSources(["commit a1b2c3d", "vibes"], labels)).toEqual(["commit a1b2c3d"]);
	});
});

describe("grounding helpers", () => {
	it("finds the issues a text links and the files it names — never URLs or the issue itself", () => {
		expect(linkedIssueNumbers(["See #5 and #12, not #7", "also https://x.example/#9"], 7)).toEqual([5, 12]);
		expect(namedFiles(["Edit `src/members/table.tsx` and docs/a.md, not https://x.example/a.ts or .env"])).toEqual(["src/members/table.tsx", "docs/a.md"]);
		expect(namedFiles(["Which layout for src/members/table.tsx?"])).toEqual(["src/members/table.tsx"]); // a question ends in "?"
	});

	it("earlier answers on the instance — a person's included — reach the next decision, with any secret redacted", async () => {
		const fx = effects(0.9, [], { comments: [], notified: [], contextCalls: 0 });
		await askFixtures(fx, { instanceId: "coder", sessionId: "s7" }); // the same coder, so its history is the next decision's
		await markHumanAnswered(env, "coder", "s7", Date.now(), "hold for review, token sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345");
		const seen: string[] = [];
		const { question } = await askLayout(effects(0.9, seen, { comments: [], notified: [], contextCalls: 0 }));
		await runDueCoderQuestions(env, question.askedAt + 31 * MIN, effects(0.9, seen, { comments: [], notified: [], contextCalls: 0 }));
		expect(seen[0]).toMatch(/\[earlier decisions\][\s\S]*owner answered "Should imported fixtures be held[\s\S]*→ hold for review/);
		expect(seen[0]).not.toContain("sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345");
	});
});
