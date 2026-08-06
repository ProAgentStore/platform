import { describe, expect, it } from "vitest";
import {
	eventHeadline,
	eventTone,
	historyHeadline,
	parsePayload,
	sourceLabel,
	statusLabel,
	syncCounts,
	tallyEvents,
	truncatePayload,
	type TriggerEvent,
} from "./triggerEvents";

const event = (over: Partial<TriggerEvent> = {}): TriggerEvent => ({
	id: "e1",
	type: "cron",
	status: "succeeded",
	created_at: "2026-07-12T08:00:00Z",
	...over,
});

describe("parsePayload", () => {
	it("accepts the JSON string the API stores and an already-parsed object", () => {
		expect(parsePayload('{"a":1}')).toEqual({ a: 1 });
		expect(parsePayload({ a: 1 })).toEqual({ a: 1 });
	});

	it("returns null for anything that is not a JSON object", () => {
		expect(parsePayload(null)).toBeNull();
		expect(parsePayload("not json")).toBeNull();
		expect(parsePayload("[1,2]")).toBeNull();
	});
});

describe("syncCounts", () => {
	it("reads the connector-sync result the trigger records", () => {
		expect(syncCounts('{"provider":"google_drive","scanned":40,"imported":3,"skipped":37,"errors":[]}')).toEqual({
			scanned: 40,
			imported: 3,
			skipped: 37,
			errors: [],
		});
	});

	it("keeps per-file errors, which is where a partial import explains itself", () => {
		const counts = syncCounts({ scanned: 2, imported: 1, skipped: 0, errors: ["Brief.docx: export failed"] });
		expect(counts?.errors).toEqual(["Brief.docx: export failed"]);
	});

	it("returns null for a payload that is not a sync result", () => {
		expect(syncCounts('{"pipeline":"sweep","runId":"r1"}')).toBeNull();
		expect(syncCounts(null)).toBeNull();
	});
});

describe("eventTone", () => {
	it("marks a succeeded sync that hit per-file errors as a WARNING, not a success", () => {
		// The dispatch worked and the import did not — a status column alone cannot say that,
		// and treating it as a plain success is how a silently-half-broken sync survives.
		expect(eventTone(event({ payload: '{"scanned":2,"imported":1,"skipped":0,"errors":["x: boom"]}' }))).toBe("warn");
	});

	it("maps the plain statuses", () => {
		expect(eventTone(event({ status: "succeeded" }))).toBe("ok");
		expect(eventTone(event({ status: "failed", error: "boom" }))).toBe("bad");
		expect(eventTone(event({ status: "running" }))).toBe("warn");
		expect(eventTone(event({ status: "received" }))).toBe("idle");
	});
});

describe("eventHeadline", () => {
	it("leads with the error when there is one", () => {
		expect(eventHeadline(event({ status: "failed", error: "knowledge dispatch failed (500)" }))).toBe("knowledge dispatch failed (500)");
	});

	it("shows sync counts for a connector run", () => {
		expect(eventHeadline(event({ payload: '{"scanned":40,"imported":3,"skipped":37,"errors":["a: boom"]}' })))
			.toBe("3 imported · 37 skipped · 40 scanned · 1 error");
	});

	it("falls back to the recorded message, then to a generic line", () => {
		expect(eventHeadline(event({ message: 'started pipeline "sweep" (run abc12345)' }))).toBe('started pipeline "sweep" (run abc12345)');
		expect(eventHeadline(event({ status: "received", type: "webhook" }))).toBe("Payload received, dispatching");
		expect(eventHeadline(event({ status: "succeeded", type: "manual" }))).toBe("Run now run succeeded");
	});

	it("labels the source in the words the UI uses", () => {
		expect(sourceLabel("cron")).toBe("Schedule");
		expect(sourceLabel("manual")).toBe("Run now");
		expect(sourceLabel("webhook")).toBe("Webhook");
		expect(statusLabel("succeeded")).toBe("Succeeded");
		expect(statusLabel("weird")).toBe("weird");
	});
});

describe("truncatePayload", () => {
	it("pretty-prints a JSON payload", () => {
		expect(truncatePayload('{"a":1}')).toBe('{\n  "a": 1\n}');
	});

	it("bounds an oversized payload — a webhook body is attacker-influenced and up to 16KB", () => {
		const big = JSON.stringify({ text: "x".repeat(5000) });
		const out = truncatePayload(big, 200);
		expect(out.length).toBeLessThan(260);
		expect(out).toContain("more characters");
	});

	it("renders nothing for an absent payload", () => {
		expect(truncatePayload(null)).toBe("");
		expect(truncatePayload(undefined)).toBe("");
	});
});

describe("tallyEvents + historyHeadline", () => {
	it("counts by status", () => {
		expect(tallyEvents([event(), event({ status: "failed" }), event({ status: "running" }), event({ status: "received" })]))
			.toEqual({ total: 4, succeeded: 1, failed: 1, running: 1, received: 1 });
	});

	it("calls out a trigger that has NEVER run as its own state", () => {
		// A webhook nobody has ever POSTed to looks exactly like a working one in a list of
		// definitions, and it is a completely different problem.
		expect(historyHeadline([])).toEqual({ tone: "idle", text: "Never run" });
	});

	it("leads with the latest failure", () => {
		const out = historyHeadline([event({ status: "failed", error: "boom" }), event()]);
		expect(out.tone).toBe("bad");
		expect(out.text).toContain("boom");
	});

	it("warns when recent history contains failures even though the last run was fine", () => {
		const out = historyHeadline([event(), event({ status: "failed", error: "boom" })]);
		expect(out).toEqual({ tone: "warn", text: "Last run OK · 1 of the last 2 failed" });
	});

	it("is quiet when everything worked", () => {
		expect(historyHeadline([event(), event()])).toEqual({ tone: "ok", text: "Last 2 runs OK" });
	});

	it("reports an in-flight run", () => {
		expect(historyHeadline([event({ status: "running" })])).toEqual({ tone: "warn", text: "Running now" });
	});
});
