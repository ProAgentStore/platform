/**
 * The PAGS ↔ runner wire contract for local browser research (#945): what a runner may report,
 * and that the Worker's copy and the runner's copy are the same file.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseLocalBrowserEvent, parseLocalBrowserResult, redactDetail } from "./contract";

const ROOT = join(__dirname, "../../../../..");

describe("the vendored copy", () => {
	it("is byte-identical in the Worker and the runner — edit both together", () => {
		const worker = readFileSync(join(ROOT, "workers/api/src/lib/local-browser/contract.ts"), "utf8");
		const runner = readFileSync(join(ROOT, "packages/browser-runner/src/local-browser/contract.ts"), "utf8");
		expect(runner).toBe(worker);
	});

	it("imports nothing, so it can be vendored", () => {
		expect(readFileSync(join(ROOT, "workers/api/src/lib/local-browser/contract.ts"), "utf8")).not.toMatch(/^import /m);
	});
});

const RESULT = {
	runId: "r1",
	outcome: "completed",
	traceId: "t1",
	engineAuth: "subscription",
	summary: "Found 1 role",
	findings: [{ title: "Engineer", url: "https://jobs.example.com/1", evidence: "Engineer — Sydney", fields: { location: "Sydney", salary: 120000, remote: false, password: "hunter2" } }],
	sourceFailures: [{ url: "https://www.linkedin.com/jobs", reason: "login_required" }],
};

describe("parseLocalBrowserResult", () => {
	it("accepts a valid envelope and drops a sensitive field", () => {
		const r = parseLocalBrowserResult(RESULT);
		expect(r).toMatchObject({ result: { runId: "r1", outcome: "completed", engineAuth: "subscription", sourceFailures: [{ url: "https://www.linkedin.com/jobs", reason: "login_required" }] } });
		expect("result" in r && r.result.findings[0].fields).toEqual({ location: "Sydney", salary: 120000, remote: false });
	});

	it("gives a failed run a reason even when the runner sent none", () => {
		expect(parseLocalBrowserResult({ ...RESULT, outcome: "failed", findings: [] })).toMatchObject({ result: { outcome: "failed", error: "The run failed without a reason." } });
	});

	it("accepts a failed envelope that carries its own error — the result is wrapped so the two are never confused", () => {
		const r = parseLocalBrowserResult({ ...RESULT, outcome: "failed", findings: [], engineAuth: "missing_login", error: "Run `codex login`" });
		expect(r).not.toHaveProperty("error");
		expect(r).toMatchObject({ result: { outcome: "failed", engineAuth: "missing_login", error: "Run `codex login`" } });
	});

	it.each([
		[{ ...RESULT, runId: "" }, /runId/],
		[{ ...RESULT, outcome: "paused" }, /outcome/],
		[{ ...RESULT, engineAuth: "sk-ant-123" }, /engineAuth/],
		[{ ...RESULT, findings: [{ title: "x", url: "javascript:alert(1)", evidence: "e" }] }, /findings\[0\]/],
		[{ ...RESULT, findings: [{ title: "x", url: "https://a.com" }] }, /findings\[0\]/],
		[{ ...RESULT, sourceFailures: [{ url: "https://a.com", reason: "bypassed" }] }, /sourceFailures\[0\]/],
		[{ ...RESULT, findings: Array.from({ length: 201 }, () => RESULT.findings[0]) }, /at most 200 findings/],
	])("refuses an invalid envelope (%#)", (raw, why) => {
		const r = parseLocalBrowserResult(raw);
		expect("error" in r && r.error).toMatch(why);
	});
});

describe("parseLocalBrowserEvent", () => {
	it("accepts a navigation and redacts its detail", () => {
		const e = parseLocalBrowserEvent({ type: "browser.navigated", at: "2026-10-07T01:00:00Z", url: "https://seek.com.au/jobs", domain: "SEEK.com.au", detail: { title: "Jobs", cookie: "sid=1", nested: { authorization: "Bearer x", ok: 1 } } });
		expect(e).toEqual({ type: "browser.navigated", at: "2026-10-07T01:00:00Z", url: "https://seek.com.au/jobs", domain: "seek.com.au", detail: { title: "Jobs", nested: { ok: 1 } } });
	});

	it("refuses an unknown type, a pause with no reason, and an event a runner may not claim", () => {
		expect(parseLocalBrowserEvent({ type: "browser.submitted", at: "2026-10-07T01:00:00Z" })).toBeNull();
		expect(parseLocalBrowserEvent({ type: "run.paused", at: "2026-10-07T01:00:00Z" })).toBeNull();
		expect(parseLocalBrowserEvent({ type: "run.ended", at: "2026-10-07T01:00:00Z" })).toBeNull();
		expect(parseLocalBrowserEvent({ type: "note", at: "not a time" })).toBeNull();
	});

	it("drops a non-http url rather than storing it", () => {
		expect(parseLocalBrowserEvent({ type: "note", at: "2026-10-07T01:00:00Z", url: "file:///etc/passwd" })).toEqual({ type: "note", at: "2026-10-07T01:00:00Z" });
	});
});

describe("redactDetail", () => {
	it("drops credential-shaped keys at any depth and bounds strings", () => {
		expect(redactDetail({ api_key: "x", apiKey: "x", formValues: { a: 1 }, otp: "1", text: "a".repeat(2000) })).toEqual({ text: "a".repeat(1000) });
	});
});
