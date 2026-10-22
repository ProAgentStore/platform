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
		[{ ...RESULT, findings: [{ title: "x", url: "javascript:alert(1)", evidence: "e" }] }, /findings\[0\]/],
		[{ ...RESULT, findings: [{ title: "x", url: "https://a.com" }] }, /findings\[0\]/],
		[{ ...RESULT, sourceFailures: [{ reason: "timeout" }] }, /sourceFailures\[0\] needs a url/],
		[{ ...RESULT, findings: Array.from({ length: 201 }, () => RESULT.findings[0]) }, /at most 200 findings/],
	])("refuses an invalid envelope (%#)", (raw, why) => {
		const r = parseLocalBrowserResult(raw);
		expect("error" in r && r.error).toMatch(why);
	});
});

/**
 * #947: "do not retain … secret environment values" — on the path that retains longest.
 *
 * The envelope's `summary` and `error` were redacted and its FINDINGS were not: `title`, `evidence`
 * and a source failure's `detail` were length-capped only, and `fields` was filtered by KEY. So a
 * credential under an innocuous key, or a secret quoted into evidence, was stored in the run's
 * result, shown in the console, returned over MCP, and copied into the owner's collection record.
 */
describe("findings are redacted, not just capped (#947)", () => {
	const KEY = "sk-ant-api03-aaaabbbbccccddddeeeeffffgggghhhh";

	it("redacts a credential-shaped string in a finding's evidence, title and an innocuously-keyed field", async () => {
		const { parseLocalBrowserResult } = await import("./contract");
		const r = parseLocalBrowserResult({
			...RESULT,
			findings: [{ title: `Engineer ${KEY}`, url: "https://jobs.example.com/1", evidence: `Posted by ${KEY} — Sydney`, fields: { note: `contact ${KEY}`, location: "Sydney" } }],
		});
		expect("result" in r).toBe(true);
		const f = ("result" in r ? r.result.findings[0] : null) as { title: string; evidence: string; fields: Record<string, unknown> };
		expect(f.title).toBe("Engineer [REDACTED]");
		expect(f.evidence).toBe("Posted by [REDACTED] — Sydney");
		// The KEY name was innocuous — the old filter only looked at keys, so this is the case it missed.
		expect(f.fields.note).toBe("contact [REDACTED]");
		expect(f.fields.location, "ordinary text is untouched").toBe("Sydney");
		// Nowhere in the stored envelope, under any field.
		expect(JSON.stringify("result" in r ? r.result : {})).not.toContain(KEY);
	});

	it("redacts a credential-shaped string in a source failure's detail", async () => {
		const { parseLocalBrowserResult } = await import("./contract");
		const r = parseLocalBrowserResult({
			...RESULT,
			sourceFailures: [{ url: "https://www.linkedin.com/jobs", reason: "login_required", detail: `rejected: Bearer abc.def-ghi_jkl012 for ${KEY}` }],
		});
		const sf = ("result" in r ? r.result.sourceFailures[0] : null) as { detail: string };
		expect(sf.detail).toBe("rejected: Bearer [REDACTED] for [REDACTED]");
		expect(JSON.stringify("result" in r ? r.result : {})).not.toContain(KEY);
	});

	it("removes a machine's own secret env value, which has no recognisable shape", async () => {
		const { redactFinding, redactSourceFailure, secretEnvValues } = await import("./contract");
		const secrets = secretEnvValues({ JOB_SITE_PASSWORD: "hunter2-horse", HOME: "/Users/me" });
		const f = redactFinding({ title: "Role at hunter2-horse Ltd", url: "https://jobs.example.com/1", evidence: "signed in with hunter2-horse", fields: { note: "hunter2-horse" } }, secrets);
		expect(f.title).toBe("Role at [REDACTED] Ltd");
		expect(f.evidence).toBe("signed in with [REDACTED]");
		expect(f.fields.note).toBe("[REDACTED]");
		expect(redactSourceFailure({ url: "https://x.example.com", reason: "login_required", detail: "hunter2-horse rejected" }, secrets).detail).toBe("[REDACTED] rejected");
		// A failure with no detail is returned as it was, not given an empty one.
		expect(redactSourceFailure({ url: "https://x.example.com", reason: "login_required" }, secrets)).toEqual({ url: "https://x.example.com", reason: "login_required" });
	});

	it("still drops a sensitive KEY outright rather than redacting its value", async () => {
		const { redactFinding } = await import("./contract");
		const f = redactFinding({ title: "t", url: "https://x.example.com", evidence: "e", fields: { password: "hunter2", cookie: "a=b", location: "Sydney" } });
		expect(f.fields).toEqual({ location: "Sydney" });
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
		expect(redactDetail({ api_key: "x", apiKey: "x", formValues: { a: 1 }, otp: "1", text: "ab ".repeat(700) })).toEqual({ text: "ab ".repeat(700).slice(0, 1000) });
	});
});

describe("redactText (#947)", () => {
	it("removes keys, bearer tokens, JWTs, credential assignments and long opaque strings", async () => {
		const { redactText } = await import("./contract");
		expect(redactText("key sk-proj-abcdefghijklmnopqrstuvwxyz0123")).toBe("key [REDACTED]");
		expect(redactText("Authorization: Bearer abc.def-ghi_jkl012")).toBe("Authorization: Bearer [REDACTED]");
		expect(redactText("ANTHROPIC_API_KEY=abc123 then GH_TOKEN: 'xyz'")).toBe("ANTHROPIC_API_KEY=[REDACTED] then GH_TOKEN=[REDACTED]");
		expect(redactText("t eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlaGVyZQ")).toBe("t [REDACTED]");
		expect(redactText(`blob ${"Zm9v".repeat(12)}== end`)).toBe("blob [REDACTED] end");
		expect(redactText("ghp_0123456789abcdefghijABCDEFGHIJ")).toBe("[REDACTED]");
	});

	it("removes a known secret value verbatim, even with no recognisable shape", async () => {
		const { redactText, secretEnvValues } = await import("./contract");
		const secrets = secretEnvValues({ JOB_SITE_PASSWORD: "hunter2-horse", PATH: "/usr/bin:/bin", SHORT_TOKEN: "abc", HOME: "/Users/me" });
		expect(secrets).toEqual(["hunter2-horse"]);
		expect(redactText("login hunter2-horse failed", secrets)).toBe("login [REDACTED] failed");
	});

	it("leaves ordinary text alone", async () => {
		const { redactText } = await import("./contract");
		expect(redactText("Found 3 senior TypeScript roles in Sydney on seek.com.au")).toBe("Found 3 senior TypeScript roles in Sydney on seek.com.au");
	});
});

describe("parseLocalBrowserResult — normalise a version difference, refuse a malformed result (#1153)", () => {
	const ok = (raw: unknown) => {
		const r = parseLocalBrowserResult(raw);
		if (!("result" in r)) throw new Error(`expected a result, got: ${r.error}`);
		return r;
	};

	it("an older runner's envelope without traceId or engineAuth is accepted, with both read from the contract — and the notes say so", () => {
		const { traceId: _t, engineAuth: _e, ...older } = RESULT;
		const r = ok(older);
		expect(r.result).toMatchObject({ runId: RESULT.runId, traceId: RESULT.runId, engineAuth: "unknown" });
		expect(r.notes?.join(" ")).toMatch(/traceId was missing/);
		expect(r.notes?.join(" ")).toMatch(/engineAuth \(missing\)/);
	});

	it("an engineAuth outside the closed list is stored as 'unknown', and its value is never echoed into the notes", () => {
		const r = ok({ ...RESULT, engineAuth: "sk-ant-api03-THISISASECRETVALUE" });
		expect(r.result.engineAuth).toBe("unknown");
		expect(JSON.stringify(r.notes)).not.toContain("THISISASECRET");
	});

	it("an unknown source-failure reason is filed as 'error' with the original in its detail; the vocabulary stays closed", () => {
		const r = ok({ ...RESULT, sourceFailures: [{ url: "https://a.com", reason: "geo_blocked" }] });
		expect(r.result.sourceFailures).toEqual([{ url: "https://a.com", reason: "error", detail: "reason: geo_blocked" }]);
	});

	it("outcome in another case and fields as a JSON string are read; an absent list is NOT (every runner sent both)", () => {
		const r = ok({ ...RESULT, outcome: " Completed ", findings: [{ title: "t", url: "https://a.com/j", evidence: "e", fields: '{"verification_outcome":"active"}' }] });
		expect(r.result.outcome).toBe("completed");
		expect(r.result.findings[0].fields).toEqual({ verification_outcome: "active" });
		expect(parseLocalBrowserResult({ ...RESULT, sourceFailures: undefined })).toEqual({ error: expect.stringMatching(/sourceFailures must be an array \(got missing\)/) });
	});

	it("STILL fails closed on what decides a verdict: a bad finding refuses the whole envelope, never just that finding", () => {
		const good = { title: "t", url: "https://a.com/j", evidence: "e", fields: { verification_outcome: "expired" } };
		const bad = { title: "t", url: "not a url", evidence: "e", fields: { verification_outcome: "active" } };
		const r = parseLocalBrowserResult({ ...RESULT, findings: [good, bad] });
		expect(r).toHaveProperty("error");
		expect(parseLocalBrowserResult({ ...RESULT, findings: "oops" })).toEqual({ error: expect.stringMatching(/findings must be an array \(got "oops"\)/) });
		expect(parseLocalBrowserResult({ ...RESULT, outcome: "paused" })).toHaveProperty("error");
		expect(parseLocalBrowserResult([])).toEqual({ error: expect.stringMatching(/must be a JSON object/) });
	});

	it("the refusal is actionable: every problem, with its path and a short redacted look at what arrived", () => {
		const r = parseLocalBrowserResult({ ...RESULT, runId: "", findings: [{ title: "", url: "ftp://x", evidence: "" }, { title: "ok" }] });
		const error = "error" in r ? r.error : "";
		expect(error).toMatch(/runId is required \(got ""\)/);
		expect(error).toMatch(/findings\[0\] needs title \(got ""\), an http\(s\) url \(got "ftp:\/\/x"\), evidence/);
		expect(error).toMatch(/findings\[1\] needs an http\(s\) url \(got missing\), evidence \(got missing\)/);
	});

	it("a credential-shaped value in a refused field is redacted in the diagnostic, and a long list of problems is capped", () => {
		const secret = "sk-ant-api03-" + "A".repeat(40);
		const r = parseLocalBrowserResult({ ...RESULT, findings: Array.from({ length: 9 }, () => ({ title: secret, url: secret, evidence: "" })) });
		const error = "error" in r ? r.error : "";
		expect(error).not.toContain(secret);
		expect(error).toMatch(/and 4 more$/);
	});
});
