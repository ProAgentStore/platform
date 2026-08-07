import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { jobKeyForTask, deriveFromUrl, TICKET_TURN_TYPES_SQL } from "./board.js";
import { TICKET_ANSWER_EVENT, TICKET_QUESTION_EVENT } from "./ticket-chat.js";

/**
 * The board counts each ticket's conversation turns (#150), and that count is the ONE query
 * here that inlines literals instead of binding them. These pin why.
 */
describe("TICKET_TURN_TYPES_SQL — the partial index only works if the predicate matches", () => {
	const migration = readFileSync(
		join(import.meta.dirname, "../../migrations/0088_ticket_thread_index.sql"),
		"utf8",
	);
	const boardSrc = readFileSync(join(import.meta.dirname, "board.ts"), "utf8");
	/** Code only. The comments here DISCUSS the bound form as the thing not to write, so a
	 *  naive grep over the whole file matches the prose it is warning about. */
	const boardCode = boardSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

	it("is the two conversation types, quoted — and nothing a quote could escape out of", () => {
		// These are compile-time constants, never user input. The test is the standing proof of
		// that, since inlining them into SQL is otherwise exactly what an injection looks like.
		expect(TICKET_TURN_TYPES_SQL).toBe("'ticket.question', 'ticket.answer'");
		for (const t of [TICKET_QUESTION_EVENT, TICKET_ANSWER_EVENT]) {
			expect(t).toMatch(/^[a-z.]+$/);
		}
	});

	it("matches migration 0088's index predicate character-for-character", () => {
		// SQLite uses a partial index only when it can PROVE the query's WHERE implies the
		// index's, which it does by matching the predicate at prepare time. If the two drift —
		// a renamed event type, a reordered list, a lost space — the index is silently skipped
		// and the count becomes a full scan of the runtime event firehose. The query still
		// returns the right answer, so nothing else would ever catch it.
		expect(migration).toContain(`WHERE type IN (${TICKET_TURN_TYPES_SQL})`);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: asserting on board.ts's SOURCE TEXT — the placeholder is what the assertion looks for, not a lost interpolation.
		expect(boardCode).toContain("AND type IN (${TICKET_TURN_TYPES_SQL})");
	});

	it("does NOT bind the types as parameters", () => {
		// The bound form (`type IN (?3, ?4)`) is the natural thing to write and the thing that
		// breaks this: with the values unknown at prepare time, EXPLAIN QUERY PLAN goes from
		// "SEARCH … USING INDEX idx_runtime_task_events_thread" to "SCAN". Measured, not assumed.
		expect(boardCode).not.toMatch(/type IN \(\s*\?\d/);
	});
});

describe("jobKeyForTask", () => {
	it("collapses the same job URL across query strings / tracking params", () => {
		const a = jobKeyForTask({ id: "t1", input: { url: "https://jobs.example.com/JobA/123?utm_source=linkedin" } });
		const b = jobKeyForTask({ id: "t2", input: { url: "https://jobs.example.com/JobA/123?source=indeed" } });
		expect(a).toBe(b);
	});

	it("ignores www + trailing slash + case", () => {
		const a = jobKeyForTask({ id: "t1", input: { url: "https://WWW.Example.com/Job/1/" } });
		const b = jobKeyForTask({ id: "t2", input: { url: "https://example.com/job/1" } });
		expect(a).toBe(b);
	});

	it("gives each browser.task run its own card (never collapses a recurring same-URL sweep)", () => {
		const a = jobKeyForTask({ id: "t1", type: "browser.task", input: { url: "https://www.facebook.com/friends/requests" } });
		const b = jobKeyForTask({ id: "t2", type: "browser.task", input: { url: "https://www.facebook.com/friends/requests" } });
		expect(a).toBe("t1");
		expect(b).toBe("t2");
		expect(a).not.toBe(b);
	});

	it("keeps different postings on the same host distinct", () => {
		const a = jobKeyForTask({ id: "t1", input: { url: "https://jobs.example.com/JobA/1" } });
		const b = jobKeyForTask({ id: "t2", input: { url: "https://jobs.example.com/JobB/2" } });
		expect(a).not.toBe(b);
	});

	it("keeps distinct jobs whose identity lives in the query string (LinkedIn currentJobId)", () => {
		const a = jobKeyForTask({ id: "t1", input: { url: "https://www.linkedin.com/jobs/view/?currentJobId=111" } });
		const b = jobKeyForTask({ id: "t2", input: { url: "https://www.linkedin.com/jobs/view/?currentJobId=222" } });
		expect(a).not.toBe(b);
	});

	it("still collapses the same query-identified job across tracking params", () => {
		const a = jobKeyForTask({ id: "t1", input: { url: "https://boards.greenhouse.io/x?gh_jid=9&utm_source=linkedin" } });
		const b = jobKeyForTask({ id: "t2", input: { url: "https://boards.greenhouse.io/x?gh_jid=9&utm_source=indeed&ref=foo" } });
		expect(a).toBe(b);
	});

	it("falls back to the task id when there is no URL", () => {
		expect(jobKeyForTask({ id: "t9" })).toBe("t9");
		expect(jobKeyForTask({ id: "t9", input: { url: "not a url" } })).toBe("t9");
	});
});

describe("deriveFromUrl", () => {
	it("prettifies the job slug and keeps the host as subtitle", () => {
		const r = deriveFromUrl("https://employmenthero.com/jobs/position/business-ai-group-pty-ltd-head-of-engineering-a8f4j/");
		expect(r.title).toBe("Business Ai Group Pty Ltd Head Of Engineering");
		expect(r.subtitle).toBe("employmenthero.com");
	});

	it("returns empty for a non-URL so the caller can fall back", () => {
		expect(deriveFromUrl("not a url")).toEqual({ title: "", subtitle: "" });
	});

	it("skips a trailing UUID and uses the company segment (Dover)", () => {
		const r = deriveFromUrl("https://app.dover.com/apply/pentanasolutions/fd3dae1c-8855-4308-9d50-27db48218d7a");
		expect(r.title).toBe("Pentanasolutions");
		expect(r.subtitle).toBe("app.dover.com");
	});

	it("skips generic route words + opaque id (Ashby → company)", () => {
		expect(deriveFromUrl("https://jobs.ashbyhq.com/xero/a547298d-33a5-45bc-ba01-d0787ac3e51b/application").title).toBe("Xero");
	});

	it("skips a numeric id and generic 'jobs' to reach the company (Greenhouse)", () => {
		expect(deriveFromUrl("https://job-boards.greenhouse.io/iconiq/jobs/8030553").title).toBe("Iconiq");
	});
});
