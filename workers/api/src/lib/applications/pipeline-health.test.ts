import { describe, expect, it } from "vitest";
import { pipelineHealthFrom, SOURCE_STALE_AFTER_MS, type EdgeFact, type SourceFact } from "./pipeline-health.js";

const NOW = Date.parse("2026-10-12T12:00:00.000Z");
const sql = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const PIPELINE = { scouts: ["scout"], tailors: ["tailor"], runners: ["runner"] };
const edge = (over: Partial<EdgeFact> = {}): EdgeFact => ({ id: "c-ready", eventType: "job.application.materials_ready", sourceInstanceId: "tailor", targetInstanceId: "runner", enabled: true, dead: 0, ...over });
const gmail = (over: Partial<NonNullable<SourceFact["gmail"]>> = {}): SourceFact => ({
	instanceId: "scout",
	runtime: null,
	gmail: { enabled: true, emailPermitted: true, lastScanAt: sql(NOW - 60 * 60_000), lastFailureAt: null, lastFailureMessage: null, ...over },
});
const health = (edges: EdgeFact[], sources: SourceFact[], pipeline = PIPELINE) => pipelineHealthFrom({ pipeline, edges, sources, now: NOW });
const codes = (h: ReturnType<typeof health>) => h.problems.map((p) => p.code);

describe("pipeline health (#1022)", () => {
	it("a healthy pipeline: enabled edges, a recently scanned scheduled mailbox — ok, nothing to report", () => {
		const h = health([edge()], [gmail()]);
		expect(h).toMatchObject({ ok: true, problems: [] });
		expect(h.sources[0]).toMatchObject({ kind: "gmail", ready: true, scheduled: true, lastScanAt: new Date(NOW - 60 * 60_000).toISOString() });
	});

	it("names a disabled edge instead of letting its member silently drop out", () => {
		const h = health([edge({ enabled: false })], [gmail()], { ...PIPELINE, runners: [] });
		expect(codes(h)).toEqual(["edge_disabled", "no_runner"]);
		expect(h.problems[0]).toMatchObject({ connectionId: "c-ready", message: expect.stringMatching(/Tailor → Runner connection c-ready is disabled/) });
	});

	it("reports dead letters as replayable", () => {
		expect(health([edge({ dead: 2 })], [gmail()]).problems).toEqual([{ code: "edge_dead_letters", connectionId: "c-ready", message: expect.stringMatching(/2 hand-offs .* can be replayed/) }]);
	});

	it("a Scout with no mailbox and no browser runtime cannot find leads, and says so", () => {
		const h = health([edge()], [{ instanceId: "scout", runtime: null, gmail: null }]);
		expect(codes(h)).toEqual(["source_unavailable"]);
		expect(h.sources[0]).toMatchObject({ kind: "none", ready: false, scheduled: false });
	});

	it("a browser Scout is judged by its OWN schedule and scans — never hard-coded ready (#1022, live cb4c349c)", () => {
		const browser = (scheduled: boolean, lastCompletedAt: string | null) => health([edge()], [{ instanceId: "scout", runtime: "local_browser", gmail: null, browser: { scheduled, lastCompletedAt } }]);
		const scanned = new Date(NOW - 3_600_000).toISOString();
		// The live state: research runs by hand, no schedule — it read as `ready: true` with no problem.
		expect(codes(browser(false, scanned))).toEqual(["source_not_scheduled"]);
		expect(browser(false, scanned).sources[0]).toMatchObject({ kind: "browser", ready: false, scheduled: false, lastScanAt: scanned });
		expect(codes(browser(false, null))).toEqual(["source_not_scheduled", "source_never_scanned"]);
		expect(codes(browser(true, null))).toEqual(["source_never_scanned"]);
		expect(browser(true, scanned)).toMatchObject({ ok: true, problems: [], sources: [{ kind: "browser", ready: true, scheduled: true, lastScanAt: scanned }] });
		// No browser facts read at all is the unscheduled, never-scanned case — not a pass.
		expect(codes(health([edge()], [{ instanceId: "scout", runtime: "local_browser", gmail: null }]))).toEqual(["source_not_scheduled", "source_never_scanned"]);
	});

	it("distinguishes disabled, permission off, failing, never scanned and stale", () => {
		expect(codes(health([edge()], [gmail({ enabled: false })]))).toEqual(["source_disabled"]);
		expect(codes(health([edge()], [gmail({ emailPermitted: false })]))).toEqual(["source_email_off"]);
		const failing = health([edge()], [gmail({ lastFailureAt: sql(NOW - 60_000), lastFailureMessage: "Email access is not enabled for this Scout." })]);
		expect(failing.problems).toEqual([{ code: "source_failing", instanceId: "scout", message: expect.stringMatching(/last scan failed: Email access is not enabled/) }]);
		expect(failing.sources[0].ready).toBe(false);
		expect(codes(health([edge()], [gmail({ lastScanAt: null })]))).toEqual(["source_never_scanned"]);
		expect(codes(health([edge()], [gmail({ lastScanAt: sql(NOW - SOURCE_STALE_AFTER_MS - 60_000) })]))).toEqual(["source_stale"]);
	});

	it("a failure OLDER than the last successful scan is history, not a failing source", () => {
		expect(health([edge()], [gmail({ lastFailureAt: sql(NOW - 3 * 60 * 60_000), lastFailureMessage: "old" })]).ok).toBe(true);
	});

	it("a source with no mailbox names why it cannot be worked around, and the supported sources", () => {
		const [p] = health([edge()], [{ instanceId: "scout", runtime: null, gmail: null }]).problems;
		expect(p.message).toMatch(/not scanned from the cloud \(SEEK and Indeed refuse server requests with HTTP 403\)/);
		expect(p.message).toMatch(/Gmail mailbox .* job alerts, or run a local browser runtime with `pags up`/);
	});

	it("reports stored leads today's intake rules reject, by reason, without archiving them", () => {
		const h = health([edge()], [gmail({ junkLeads: { digest: 12, security_alert: 1, no_specific_job_url: 12 } })]);
		expect(h.ok).toBe(false);
		expect(h.problems).toEqual([{ code: "source_junk_leads", instanceId: "scout", message: expect.stringMatching(/holds 25 stored leads that today's intake rules reject \(12 digest, 1 security alert, 12 no specific job url\)\. They are not concrete jobs; archive them rather than apply\./) }]);
		// A health problem, not an outage: the mailbox itself is still ready.
		expect(h.sources[0].ready).toBe(true);
		for (const junkLeads of [{}, { digest: 0 }, undefined]) expect(health([edge()], [gmail({ junkLeads })]).ok).toBe(true);
	});
});
