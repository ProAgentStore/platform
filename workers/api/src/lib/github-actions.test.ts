import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJobLog, JOB_LOG_FETCH_BYTES, mapWorkflowJob, pickJob, stripLogTimestamps, type WorkflowJob } from "./github-actions.js";
import { MAX_LINE_CHARS, READ_MAX_CHARS, READ_MAX_LINES, renderRepoFileWindow, tailWindowStart } from "./repo-file-window.js";

const job = (over: Partial<WorkflowJob>): WorkflowJob => ({ id: 1, name: "job", status: "completed", conclusion: "success", url: "", steps: [], ...over });

describe("pickJob — which job to read when none was named (#781)", () => {
	it("prefers the first FAILED job, whatever its position", () => {
		const jobs = [job({ id: 1, conclusion: "success" }), job({ id: 2, conclusion: "failure" }), job({ id: 3, conclusion: "failure" })];
		expect(pickJob(jobs)?.id).toBe(2);
	});
	it("counts timed_out and action_required as failures, but not cancelled", () => {
		expect(pickJob([job({ id: 1 }), job({ id: 2, conclusion: "timed_out" })])?.id).toBe(2);
		expect(pickJob([job({ id: 1 }), job({ id: 2, conclusion: "action_required" })])?.id).toBe(2);
		// A cancelled job printed nothing diagnostic; the last completed job is the better read.
		expect(pickJob([job({ id: 1, conclusion: "cancelled" }), job({ id: 2 })])?.id).toBe(2);
	});
	it("falls back to the job still running, then to the last job", () => {
		expect(pickJob([job({ id: 1 }), job({ id: 2, status: "in_progress", conclusion: null }), job({ id: 3, status: "queued", conclusion: null })])?.id).toBe(2);
		expect(pickJob([job({ id: 1 }), job({ id: 2 })])?.id).toBe(2);
		expect(pickJob([])).toBeNull();
	});
});

describe("stripLogTimestamps", () => {
	it("removes GitHub's per-line ISO prefix and nothing else", () => {
		const raw = "2026-09-08T09:10:09.1234567Z ##[group]Run tsc\n2026-09-08T09:10:10Z error TS2322\nno prefix here\n";
		expect(stripLogTimestamps(raw)).toBe("##[group]Run tsc\nerror TS2322\nno prefix here\n");
	});
	it("does not touch a timestamp that is not at the start of a line", () => {
		expect(stripLogTimestamps("built at 2026-09-08T09:10:09Z ok")).toBe("built at 2026-09-08T09:10:09Z ok");
	});
});

describe("mapWorkflowJob", () => {
	it("keeps id, name, status, conclusion, url and the steps; tolerates missing fields", () => {
		const j = mapWorkflowJob({ id: 7, name: "ci", status: "completed", conclusion: null, html_url: "u", steps: [{ number: 2, name: "Test", status: "completed", conclusion: "failure" }] });
		expect(j).toEqual({ id: 7, name: "ci", status: "completed", conclusion: null, url: "u", steps: [{ number: 2, name: "Test", status: "completed", conclusion: "failure" }] });
		expect(mapWorkflowJob({})).toEqual({ id: 0, name: "", status: "", conclusion: null, url: "", steps: [] });
	});
});

describe("fetchJobLog — the redirect is followed WITHOUT the token, and the TAIL is kept", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("asks GitHub with the token and redirect:manual, then fetches the blob bare", async () => {
		const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
			if (url.includes("/actions/jobs/9/logs")) return { ok: false, status: 302, headers: new Headers({ location: "https://blob.example/9.txt" }) } as unknown as Response;
			return { ok: true, status: 200, headers: new Headers(), text: async () => "hello\n" } as unknown as Response;
		});
		vi.stubGlobal("fetch", fetchMock);
		const r = await fetchJobLog("acme/widgets", "tok", 9);
		expect(r).toEqual({ text: "hello\n", size: 6, headTruncated: false });
		const [[apiUrl, apiInit], [blobUrl, blobInit]] = fetchMock.mock.calls;
		expect(apiUrl).toBe("https://api.github.com/repos/acme/widgets/actions/jobs/9/logs");
		expect(apiInit?.redirect).toBe("manual");
		expect((apiInit?.headers as Record<string, string>).Authorization).toBe("token tok");
		expect(blobUrl).toBe("https://blob.example/9.txt");
		// A deadline (#438) and nothing else: no headers means the token cannot leak to the blob host.
		expect(blobInit?.headers).toBeUndefined();
		expect(blobInit?.signal).toBeInstanceOf(AbortSignal);
		expect(apiInit?.signal).toBeInstanceOf(AbortSignal);
	});

	it("keeps the END of an oversized log — the failure is the last thing printed", async () => {
		const big = `${"a".repeat(JOB_LOG_FETCH_BYTES)}TAIL`;
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => big }) as unknown as Response));
		const r = await fetchJobLog("acme/widgets", "tok", 9);
		if ("status" in r) throw new Error("expected text");
		expect(r.headTruncated).toBe(true);
		expect(r.size).toBe(big.length);
		expect(r.text.length).toBe(JOB_LOG_FETCH_BYTES);
		expect(r.text.endsWith("TAIL")).toBe(true);
	});

	it("reports a redirect with no location, a non-ok blob, and a network error as {status}", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 302, headers: new Headers() }) as unknown as Response));
		expect(await fetchJobLog("acme/widgets", "tok", 9)).toEqual({ status: 302 });
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 410, headers: new Headers() }) as unknown as Response));
		expect(await fetchJobLog("acme/widgets", "tok", 9)).toEqual({ status: 410 });
		vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
		expect(await fetchJobLog("acme/widgets", "tok", 9)).toEqual({ status: null });
	});
});

describe("tailWindowStart — the inverse of the forward renderer", () => {
	it("returns 1 when everything fits", () => {
		expect(tailWindowStart(["a", "b", "c"])).toBe(1);
	});
	it("picks a start from which the renderer runs exactly to the last line within budget", () => {
		const lines = Array.from({ length: 3_000 }, (_, i) => `line ${i + 1} ${"x".repeat(40)}`);
		const start = tailWindowStart(lines);
		expect(start).toBeGreaterThan(1);
		const win = renderRepoFileWindow({ path: "log", content: lines.join("\n"), startLine: start });
		expect(win.success).toBe(true);
		expect(win.content.endsWith(`3000: line 3000 ${"x".repeat(40)}`)).toBe(true);
		expect(win.tail).toBeUndefined();
		expect(win.content.length).toBeLessThanOrEqual(READ_MAX_CHARS);
		// One line earlier would not have fit: the tail is as long as the budget allows.
		const wider = renderRepoFileWindow({ path: "log", content: lines.join("\n"), startLine: start - 1 });
		expect(wider.tail).toBeDefined();
	});
	it("is bounded by the line budget on short lines", () => {
		const lines = Array.from({ length: READ_MAX_LINES + 50 }, () => "x");
		expect(tailWindowStart(lines)).toBe(51);
	});
	it("budgets a long line the way the renderer cuts it", () => {
		const lines = ["short", "y".repeat(MAX_LINE_CHARS * 20), "end"];
		// 20 × 2,000 characters would blow the budget uncut; cut to MAX_LINE_CHARS it fits.
		expect(tailWindowStart(lines)).toBe(1);
	});
});
