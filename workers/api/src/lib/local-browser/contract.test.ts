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
