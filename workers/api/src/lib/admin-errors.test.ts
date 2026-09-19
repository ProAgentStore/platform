import { describe, expect, it } from "vitest";
import { normalizeMessage, signatureKey, summarizeErrors, type RawError } from "./admin-errors.js";

function e(p: Partial<RawError>): RawError {
	return { id: "x", created_at: "2026-08-01 00:00:00", user_id: "u1", source: "auth", status: null, message: "m", context: null, ...p };
}

describe("normalizeMessage", () => {
	it("redacts uuids, long hex, numbers, quoted strings", () => {
		expect(normalizeMessage("GET /v1/instances/12ebf1f0-73a6-4172-bfbb-91518104c8bc/runtime/status → 502"))
			.toBe("get /v{n}/instances/{id}/runtime/status → {n}");
		expect(normalizeMessage('Translation failed for "hello world"')).toBe('translation failed for "{s}"');
	});
	it("collapses two near-identical messages to the same signature", () => {
		const a = signatureKey("client:api", "POST /v1/instances/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/translate → 502");
		const b = signatureKey("client:api", "POST /v1/instances/11111111-2222-3333-4444-555555555555/translate → 500");
		expect(a).toBe(b);
	});
});

describe("summarizeErrors", () => {
	it("groups by signature with count, distinct users, first/last seen", () => {
		const rows = [
			e({ id: "1", created_at: "2026-08-01 10:00:00", user_id: "u1", source: "job-apply", message: "timeout after 25s" }),
			e({ id: "2", created_at: "2026-08-01 09:00:00", user_id: "u2", source: "job-apply", message: "timeout after 30s" }),
			e({ id: "3", created_at: "2026-08-01 08:00:00", user_id: "u1", source: "job-apply", message: "timeout after 12s" }),
			e({ id: "4", created_at: "2026-08-01 07:00:00", user_id: "u9", source: "auth", message: "invalid token" }),
		];
		const sigs = summarizeErrors(rows);
		expect(sigs).toHaveLength(2);
		const top = sigs[0];
		expect(top.source).toBe("job-apply");
		expect(top.count).toBe(3);
		expect(top.users).toBe(2); // u1, u2
		expect(top.lastId).toBe("1"); // newest
		expect(top.firstSeen).toBe("2026-08-01 08:00:00");
		expect(top.lastSeen).toBe("2026-08-01 10:00:00");
	});
	it("sorts by count desc", () => {
		const rows = [
			e({ source: "a", message: "one" }),
			e({ source: "b", message: "two" }),
			e({ source: "b", message: "two" }),
		];
		expect(summarizeErrors(rows)[0].source).toBe("b");
	});

	it("counts OCCURRENCES, not rows — a collapsed row stands for all its repeats (#424)", () => {
		// The write side now folds an identical repeat into a counter. Counting rows would report
		// "2" for the failure that actually happened 1809 times, understating exactly the runaway
		// the counter exists to make visible — and the sort would then bury it.
		const rows = [
			e({ id: "1", source: "unhandled", message: "compound select", repeat_count: 900, created_at: "2026-08-01 11:00:00", last_seen_at: "2026-08-01 12:00:00" }),
			e({ id: "2", source: "unhandled", message: "compound select", repeat_count: 900, created_at: "2026-08-01 05:00:00" }),
			e({ id: "3", source: "voice", message: "stt failed" }),
		];
		const [top] = summarizeErrors(rows);
		expect(top.count).toBe(1800);
		expect(top.rows).toBe(2);
		expect(top.lastSeen).toBe("2026-08-01 12:00:00");
		expect(top.firstSeen).toBe("2026-08-01 05:00:00");
	});

	it("treats a row written before migration 0103 as one occurrence at error level", () => {
		// The columns are nullable and 1800 existing rows predate them. A NaN or a 0 here would
		// silently zero out the historic half of every signature.
		const [sig] = summarizeErrors([e({ repeat_count: null, last_seen_at: null, level: null })]);
		expect(sig.count).toBe(1);
		expect(sig.level).toBe("error");
		expect(sig.lastSeen).toBe("2026-08-01 00:00:00");
	});

	it("a signature that is EVER a real error is not filed under warn", () => {
		// Severity is per row, but the operator reads per signature. Taking the quietest member's
		// level would hide a 500 behind the diagnostic 402s that share its shape.
		const warnOnly = summarizeErrors([e({ level: "warn" }), e({ level: "warn" })]);
		expect(warnOnly[0].level).toBe("warn");
		const mixed = summarizeErrors([e({ level: "warn" }), e({ level: "error" })]);
		expect(mixed[0].level).toBe("error");
	});
});

describe("facets — what a signature touched, as a lower bound (#823)", () => {
	const row = (over: Partial<RawError> = {}): RawError => ({
		id: "e1",
		created_at: "2026-09-20 10:00:00",
		user_id: "u1",
		source: "coding:session",
		status: null,
		message: "coding run abc failed (infra_transient) at think after 3 steps: DO reset",
		context: null,
		level: "warn",
		repeat_count: 1,
		last_seen_at: "2026-09-20 10:00:00",
		...over,
	});

	it("reads the coding-failure context #823 asks for: class, repo, instance, resumed-vs-not", () => {
		// These rows ARE the "coding run crashes" bullet. `recordCodingFailure` writes them into
		// error_log with source `coding:session`, so they were never a separate data source.
		const [sig] = summarizeErrors([
			row({
				context: JSON.stringify({ instanceId: "inst-1", repo: "acme/api", failureClass: "infra_transient", disposition: "resumed" }),
			}),
		]);
		expect(sig.facets).toEqual({
			instances: ["inst-1"],
			repos: ["acme/api"],
			failureClasses: ["infra_transient"],
			resumed: true,
			ended: false,
		});
	});

	it("reads BOTH retained samples, so a collapsed bucket is not judged by whichever opened it", () => {
		// #538 keeps the first occurrence's context and the latest one's, precisely because the
		// first is not representative. Reading only `context` would attribute this row to inst-2.
		const [sig] = summarizeErrors([
			row({
				context: JSON.stringify({ instanceId: "inst-2", disposition: "resumed" }),
				last_context: JSON.stringify({ instanceId: "inst-1", disposition: "ended" }),
				repeat_count: 9,
			}),
		]);
		expect(sig.facets.instances).toEqual(["inst-1", "inst-2"]);
		// Both true: the bucket opened on a run that was resumed and closed on one that was not.
		// Collapsing these to one verdict would have to pick a winner and misreport half the rows.
		expect(sig.facets.resumed).toBe(true);
		expect(sig.facets.ended).toBe(true);
	});

	it("accepts either spelling of the instance key", () => {
		// Both are written by real call sites; error-log.ts's trace bridge reads both too.
		const [sig] = summarizeErrors([row({ context: JSON.stringify({ instance_id: "inst-9" }) })]);
		expect(sig.facets.instances).toEqual(["inst-9"]);
	});

	it("survives a context that is not JSON, is not an object, or is missing", () => {
		// The context is free-form and written by ~25 call sites. A facet that could throw would
		// break the page on exactly the malformed row it exists to show.
		for (const ctx of ["not json at all", "[1,2,3]", '"a string"', "null", "", null]) {
			const [sig] = summarizeErrors([row({ context: ctx })]);
			expect(sig.facets.instances).toEqual([]);
			expect(sig.facets.failureClasses).toEqual([]);
		}
	});

	it("ignores a key whose value is not a usable string", () => {
		const [sig] = summarizeErrors([row({ context: JSON.stringify({ instanceId: 42, repo: "   ", failureClass: null }) })]);
		expect(sig.facets).toEqual({ instances: [], repos: [], failureClasses: [], resumed: false, ended: false });
	});

	it("sorts, so the rendered order is a property of the data and not of insertion", () => {
		// A list that reshuffles between polls reads as a change nobody made.
		const [sig] = summarizeErrors([
			row({ id: "a", context: JSON.stringify({ instanceId: "zz" }) }),
			row({ id: "b", context: JSON.stringify({ instanceId: "aa" }) }),
		]);
		expect(sig.facets.instances).toEqual(["aa", "zz"]);
	});

	it("gives every signature facets, even one whose rows carry no context at all", () => {
		// An absent object would make every reader guard; an empty one is the same answer stated.
		const [sig] = summarizeErrors([row({ source: "auth", message: "oauth failed", context: null })]);
		expect(sig.facets).toEqual({ instances: [], repos: [], failureClasses: [], resumed: false, ended: false });
	});
});
