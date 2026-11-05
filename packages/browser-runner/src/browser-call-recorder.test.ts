import { describe, expect, it } from "vitest";
import { BROWSER_CALL_CAP, BrowserCallRecorder, isBrowserCallSubjectKind, summarizeCallArgs } from "./browser-call-recorder.js";

const SUBJECT = { kind: "local_apply_run", id: "run-1" };

describe("BrowserCallRecorder", () => {
	it("redacts structured diagnostics before retaining deadline evidence", () => {
		const recorder = new BrowserCallRecorder();
		recorder.record({ subject: SUBJECT, tool: "browser_type", args: { text: "private typed value" }, secrets: { SECRET: "secret-token" }, startedAt: Date.now(), outcome: "tool_error", internal: false,
			toolDiagnostic: { kind: "request_deadline", phase: "native_response", tool: "browser_type", execution: "pending", recoverable: false, elapsedMs: 60_000, message: "private typed value remains uncertain", originalError: "secret-token and private typed value", machine: { cpus: 2, load1: 8, loadPerCpu: 4, freeMemoryBytes: 100, totalMemoryBytes: 200 } } });
		const diagnostic = recorder.page(SUBJECT, 0).calls[0].toolDiagnostic;
		expect(diagnostic).toMatchObject({ kind: "request_deadline", execution: "pending", elapsedMs: 60_000 });
		expect(JSON.stringify(diagnostic)).not.toContain("private typed value");
		expect(JSON.stringify(diagnostic)).not.toContain("secret-token");
	});
	it("masks known credentials in URL paths before keeping args or urlAfter", () => {
		const recorder = new BrowserCallRecorder();
		for (const path of ["FAKE_REVIEW_SECRET", "with%20space"]) recorder.record({ subject: SUBJECT, tool: "browser_navigate", args: { url: `https://fixture.test/reset/${path}?token=hidden` }, secrets: { PIN: "FAKE_REVIEW_SECRET", OTHER: "with space" }, startedAt: Date.now(), outcome: "ok", internal: false });
		for (const record of recorder.page(SUBJECT, 0).calls) {
			expect(record.args.url).toBe("https://fixture.test/reset/[REDACTED]");
			expect(record.urlAfter).toBe(record.args.url);
		}
	});
	it("redacts echoed values and short secrets before storing or truncating an error", () => {
		const r = new BrowserCallRecorder();
		r.record({ subject: SUBJECT, tool: "browser_type", args: { text: "typed-password" }, secrets: { PIN: "42" }, startedAt: Date.now(), outcome: "tool_error", errorHead: "Rejected typed-password with PIN 42", internal: false });
		const error = r.page(SUBJECT, 0).calls[0].errorHead;
		expect(error).not.toContain("typed-password");
		expect(error).not.toContain("42");
		expect(error).toContain("[REDACTED]");
	});
	it("does not expose a secret prefix when a retained label reaches its size limit", () => {
		const secret = "never-leak-this-value";
		const out = summarizeCallArgs({ element: `${"x".repeat(195)}${secret}` }, { PASSWORD: secret });
		expect(out.element).not.toContain("never");
	});
	it("records ok, tool_error, thrown and refused outcomes with a sequence that only ever advances", () => {
		const r = new BrowserCallRecorder();
		r.record({ subject: SUBJECT, tool: "browser_navigate", args: { url: "https://a.com" }, startedAt: Date.now(), outcome: "ok", internal: false });
		r.record({ subject: SUBJECT, tool: "browser_click", args: {}, startedAt: Date.now(), outcome: "tool_error", errorHead: "no such element", internal: false });
		r.record({ subject: SUBJECT, tool: "browser_evaluate", args: {}, startedAt: Date.now(), outcome: "thrown", errorHead: "disconnected", internal: true });
		r.record({ subject: SUBJECT, tool: "browser_type", args: {}, startedAt: Date.now(), outcome: "refused", errorHead: "research only", internal: false });
		const page = r.page(SUBJECT, 0);
		expect(page.calls.map((c) => c.outcome)).toEqual(["ok", "tool_error", "thrown", "refused"]);
		expect(page.calls.map((c) => c.seq)).toEqual([1, 2, 3, 4]);
		expect(page.calls[1].errorHead).toBe("no such element");
		expect(page.calls[2].internal).toBe(true);
		expect(page.lastSeq).toBe(4);
		expect(page.dropped).toBe(0);
		// Every record carries an opaque, unique call id.
		expect(new Set(page.calls.map((c) => c.callId)).size).toBe(4);
	});

	it("internal defaults false and is carried through exactly as given", () => {
		const r = new BrowserCallRecorder();
		r.record({ subject: SUBJECT, tool: "browser_snapshot", args: {}, startedAt: Date.now(), outcome: "ok", internal: false });
		r.record({ subject: SUBJECT, tool: "browser_evaluate", args: {}, startedAt: Date.now(), outcome: "ok", internal: true });
		const [a, b] = r.page(SUBJECT, 0).calls;
		expect(a.internal).toBe(false);
		expect(b.internal).toBe(true);
	});

	it("subject: null is its own stream, independent of a bound subject's", () => {
		const r = new BrowserCallRecorder();
		r.record({ subject: null, tool: "browser_navigate", args: {}, startedAt: Date.now(), outcome: "ok", internal: false });
		r.record({ subject: SUBJECT, tool: "browser_click", args: {}, startedAt: Date.now(), outcome: "ok", internal: false });
		expect(r.page(null, 0).calls).toHaveLength(1);
		expect(r.page(SUBJECT, 0).calls).toHaveLength(1);
		expect(r.page({ kind: "local_apply_run", id: "run-2" }, 0).calls).toHaveLength(0);
	});

	it("never drops the no-subject stream, however many calls it holds", () => {
		const r = new BrowserCallRecorder(2); // a tiny cap, so the test does not need BROWSER_CALL_CAP iterations
		for (let i = 0; i < 10; i++) r.record({ subject: null, tool: "browser_navigate", args: {}, startedAt: Date.now(), outcome: "ok", internal: false });
		const page = r.page(null, 0);
		expect(page.calls).toHaveLength(10);
		expect(page.dropped).toBe(0);
	});

	it("caps a bound subject's stream and counts the overflow in `dropped`, while `seq` keeps advancing", () => {
		const r = new BrowserCallRecorder(3);
		for (let i = 0; i < 5; i++) r.record({ subject: SUBJECT, tool: "browser_navigate", args: {}, startedAt: Date.now(), outcome: "ok", internal: false });
		const page = r.page(SUBJECT, 0);
		expect(page.calls).toHaveLength(3);
		expect(page.dropped).toBe(2);
		// The cursor advances past the drops — a puller resuming from here is never stuck behind them.
		expect(page.lastSeq).toBe(5);
	});

	it("the default cap is 2000, named and exported so a reader can tell what 'capped' means", () => {
		expect(BROWSER_CALL_CAP).toBe(2000);
	});

	it("pages by seq and reports the actual stream watermark when a cursor belongs to an older epoch", () => {
		const r = new BrowserCallRecorder();
		for (let i = 0; i < 5; i++) r.record({ subject: SUBJECT, tool: "browser_navigate", args: {}, startedAt: Date.now(), outcome: "ok", internal: false });
		const first = r.page(SUBJECT, 0);
		expect(first.calls.map((c) => c.seq)).toEqual([1, 2, 3, 4, 5]);
		const second = r.page(SUBJECT, 3);
		expect(second.calls.map((c) => c.seq)).toEqual([4, 5]);
		expect(second.lastSeq).toBe(5);
		// A future cursor must not hide a restarted recorder with fewer calls.
		const ahead = r.page(SUBJECT, 100);
		expect(ahead.calls).toEqual([]);
		expect(ahead.lastSeq).toBe(5);
		expect(ahead.latestSeq).toBe(5);
		expect(ahead.epoch).toBe(r.epoch);
	});

	it("never throws, even if an input is malformed — recording is best-effort", () => {
		const r = new BrowserCallRecorder();
		// Circular args would make JSON.stringify throw elsewhere; summarizeCallArgs never stringifies, but
		// the contract here is "record() never throws", however it is misused.
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(() => r.record({ subject: SUBJECT, tool: "x", args: circular, startedAt: Date.now(), outcome: "ok", internal: false })).not.toThrow();
	});
});

describe("isBrowserCallSubjectKind", () => {
	it("accepts exactly the three artifact-subject kinds, nothing else", () => {
		expect(isBrowserCallSubjectKind("runtime_task")).toBe(true);
		expect(isBrowserCallSubjectKind("local_browser_run")).toBe(true);
		expect(isBrowserCallSubjectKind("local_apply_run")).toBe(true);
		expect(isBrowserCallSubjectKind("something_else")).toBe(false);
		expect(isBrowserCallSubjectKind(42)).toBe(false);
	});
});

describe("summarizeCallArgs — the safe args summary (#1409)", () => {
	it("keeps element/role/ref/target, and reduces a url to origin + path", () => {
		expect(summarizeCallArgs({ element: "Email", role: "textbox", ref: "e3", target: "e3", url: "https://a.com/x?token=abc#frag" })).toEqual({
			element: "Email",
			role: "textbox",
			ref: "e3",
			target: "e3",
			url: "https://a.com/x",
		});
	});

	it("never keeps typed text or page content — only its length", () => {
		const out = summarizeCallArgs({ text: "my secret password 123" });
		expect(out).toEqual({ textLength: "my secret password 123".length });
		expect(JSON.stringify(out)).not.toContain("secret");
	});

	it("notes a browser_evaluate function's presence, never its body", () => {
		const out = summarizeCallArgs({ function: "() => document.querySelector('input').value" });
		expect(out).toEqual({ hasFunction: true });
		expect(JSON.stringify(out)).not.toContain("querySelector");
	});

	it("counts values/paths arrays rather than keeping their content", () => {
		expect(summarizeCallArgs({ values: ["Engineering", "Design"] })).toEqual({ valuesCount: 2 });
		expect(summarizeCallArgs({ paths: ["/home/jane/resume.pdf"] })).toEqual({ pathsCount: 1 });
	});

	it("replaces a secret's VALUE with its name, wherever it appears in a kept string field", () => {
		const secrets = { PAGS_LOGIN_PASSWORD: "Tr0ub4dor&3-never-seen" };
		const out = summarizeCallArgs({ element: "the Tr0ub4dor&3-never-seen field" }, secrets);
		expect(out.element).toBe("the <secret>PAGS_LOGIN_PASSWORD</secret> field");
		expect(JSON.stringify(out)).not.toContain("Tr0ub4dor&3-never-seen");
	});

	it("an unrecognised tool's args produce an empty summary, not a guess", () => {
		expect(summarizeCallArgs({ somethingNew: "whatever" })).toEqual({});
	});
});

it("bounded pages advance only past returned calls and expose recorder epochs and drops", () => {
 const recorder = new BrowserCallRecorder(105);
 for (let i = 0; i < 110; i++) recorder.record({ subject: SUBJECT, tool: "browser_snapshot", args: {}, startedAt: Date.now(), outcome: "ok", internal: false });
 const first = recorder.page(SUBJECT, 0, 100);
 expect(first).toMatchObject({ lastSeq: 100, latestSeq: 110, hasMore: true, dropped: 5, epoch: recorder.epoch });
 expect(first.calls).toHaveLength(100);
 const next = recorder.page(SUBJECT, first.lastSeq, 100);
 expect(next.calls.map((c) => c.seq)).toEqual([101, 102, 103, 104, 105]);
 expect(next).toMatchObject({ lastSeq: 110, latestSeq: 110, hasMore: false, dropped: 5 });
 const restarted = new BrowserCallRecorder();
 expect(restarted.page(SUBJECT, 110)).toMatchObject({ lastSeq: 0, latestSeq: 0 });
 expect(restarted.epoch).not.toBe(recorder.epoch);
});
