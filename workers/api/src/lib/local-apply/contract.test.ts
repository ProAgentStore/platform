/**
 * The PAGS ↔ runner contract for application execution (#957): the two vendored copies are one
 * file, a runner cannot put a typed value into a trace, and a submission is only a submission with
 * its confirmed page, its gate and an auto_submit run.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseLocalApplyEvent, parseLocalApplyResult } from "./contract";

const ROOT = join(__dirname, "../../../../..");

describe("the vendored copy", () => {
	it("is byte-identical in the Worker and the runner — edit both together", () => {
		const worker = readFileSync(join(ROOT, "workers/api/src/lib/local-apply/contract.ts"), "utf8");
		expect(readFileSync(join(ROOT, "packages/browser-runner/src/local-apply/contract.ts"), "utf8")).toBe(worker);
		expect(worker).not.toMatch(/^import /m);
	});
});

describe("parseLocalApplyEvent", () => {
	it("keeps classes, decisions and handles; drops a typed value, a page's text and a cookie", () => {
		const e = parseLocalApplyEvent({ type: "field.filled", at: "2026-10-07T00:00:00Z", detail: { class: "fill", role: "textbox", value: "Jane Citizen", text: "page text", cookie: "sid=1" } });
		expect(e).toEqual({ type: "field.filled", at: "2026-10-07T00:00:00Z", detail: { class: "fill", role: "textbox" } });
	});
	it("refuses a pause without a known reason, and an unknown type", () => {
		expect(parseLocalApplyEvent({ type: "run.paused", at: "2026-10-07T00:00:00Z" })).toBeNull();
		expect(parseLocalApplyEvent({ type: "form.submitted", at: "2026-10-07T00:00:00Z" })).toBeNull();
	});
});

const BASE = { runId: "r1", traceId: "r1", engineAuth: "machine-login", filled: 3, uploaded: ["resume", "bogus"], summary: "ok" };

describe("parseLocalApplyResult", () => {
	it("accepts an awaiting_review result and keeps only real artifact kinds", () => {
		const r = parseLocalApplyResult({ ...BASE, outcome: "awaiting_review", mode: "fill_and_review" });
		expect("result" in r && r.result).toMatchObject({ outcome: "awaiting_review", uploaded: ["resume"], submitAttempted: false });
	});
	it.each([
		["from a fill_and_review run", { mode: "fill_and_review", submitted: { url: "https://x.example/thanks", at: "2026-10-07T00:00:00Z", gateId: "g" } }, /auto_submit/],
		["without the confirmed page", { mode: "auto_submit", submitted: { at: "2026-10-07T00:00:00Z", gateId: "g" } }, /confirmed url/],
		["without the gate", { mode: "auto_submit", submitted: { url: "https://x.example/thanks", at: "2026-10-07T00:00:00Z" } }, /gateId/],
	])("refuses a submitted outcome %s", (_label, over, msg) => {
		const r = parseLocalApplyResult({ ...BASE, outcome: "submitted", ...over });
		expect("error" in r && r.error).toMatch(msg);
	});
	it("a blocked result carries a known reason (unknown → incomplete) and bounded questions", () => {
		const r = parseLocalApplyResult({ ...BASE, outcome: "blocked", mode: "fill_and_review", blockReason: "made_up", questions: ["Q?", 3, ""] });
		expect("result" in r && r.result).toMatchObject({ blockReason: "incomplete", questions: ["Q?"] });
	});
});
