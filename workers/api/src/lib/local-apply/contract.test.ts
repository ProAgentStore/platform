/**
 * The PAGS ↔ runner contract for application execution (#957): the two vendored copies are one
 * file, a runner cannot put a typed value into a trace, and a submission is only a submission with
 * its confirmed page, its gate and an auto_submit run.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APPLY_ENTRY_RE, ONE_CLICK_SUBMIT_RE, TERMINAL_APPLY_SUBMIT_RE, classifyApplyClick, parseLocalApplyEvent, parseLocalApplyResult } from "./contract";

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
	it("accepts only runner-verified structured evidence for an unavailable job", () => {
		const r = parseLocalApplyResult({ ...BASE, outcome: "blocked", mode: "fill_and_review", blockReason: "job_unavailable", unavailable: { reason: "expired", url: "https://jobs.example.com/closed", observedAt: "2026-10-07T00:00:00Z", source: "page_notice", notice: "This job has expired" } });
		expect("result" in r && r.result).toMatchObject({ blockReason: "job_unavailable", unavailable: { reason: "expired", url: "https://jobs.example.com/closed", observedAt: "2026-10-07T00:00:00Z", source: "page_notice" } });
		expect("result" in r && r.result && r.result.unavailable).not.toHaveProperty("notice");
	});
	it.each([
		["without evidence", { blockReason: "job_unavailable" }],
		["with caller-supplied prose instead of a page signal", { blockReason: "job_unavailable", unavailable: { reason: "expired", url: "https://jobs.example.com/closed", observedAt: "2026-10-07T00:00:00Z", source: "model_claim" } }],
		["for a different block reason", { blockReason: "incomplete", unavailable: { reason: "expired", url: "https://jobs.example.com/closed", observedAt: "2026-10-07T00:00:00Z", source: "page_notice" } }],
	])("refuses unavailable evidence %s", (_label, over) => {
		const r = parseLocalApplyResult({ ...BASE, outcome: "blocked", mode: "fill_and_review", ...over });
		expect("error" in r && r.error).toMatch(/unavailable evidence/);
	});
});

/**
 * Which control is the final submit (#985).
 *
 * The live failure: four fill-and-review runs on one SEEK posting ended `awaiting_review` with
 * `filled: 0`. The press that OPENS the application was classified as the submit, because the
 * bridge was testing labels against the READ-ONLY floor vocabulary, which matches bare `apply` on
 * purpose. These cases are the rule that replaced it — and the first two describe the live runs.
 */
describe("classifyApplyClick (#985)", () => {
	const click = (over: Partial<Parameters<typeof classifyApplyClick>[0]> = {}) =>
		classifyApplyClick({ role: "button", names: ["Apply"], submits: false, method: "", filled: 0, uploaded: 0, ...over });

	it("the control that OPENS a SEEK application is an entry, not the submit", () => {
		expect(click({ names: ["Apply"] })).toMatchObject({ klass: "entry", reason: "entry_label_nothing_filled" });
		expect(click({ role: "link", names: ["Apply for this job"] }).klass).toBe("entry");
		expect(click({ names: ["Start your application"] }).klass).toBe("entry");
		// …including when the page wraps it in a POST form, which says nothing about finality.
		expect(click({ names: ["Apply"], submits: true, method: "post" })).toMatchObject({ klass: "entry", reason: "entry_post_form_nothing_filled" });
	});

	it("a ONE-CLICK apply stays the submit — it can send the application outright", () => {
		// The overlap with the entry family is only dangerous in one direction, so it is tested first.
		for (const name of ["Quick apply", "Easy Apply", "1-click apply", "Apply with your profile", "Apply using your profile", "Instant Apply"]) {
			expect(classifyApplyClick({ role: "button", names: [name], submits: false, method: "", filled: 0, uploaded: 0 }), name).toMatchObject({ klass: "submit", reason: "one_click_apply" });
		}
	});

	it("the control that SENDS a filled application is the submit, in any language", () => {
		for (const name of ["Submit application", "Submit", "Send my application", "Envoyer ma candidature", "Absenden", "Wyślij", "提交", "제출"]) {
			expect(classifyApplyClick({ role: "button", names: [name], submits: true, method: "post", filled: 4, uploaded: 1 }), name).toMatchObject({ klass: "submit", reason: "terminal_label" });
		}
	});

	it("the APPLY family becomes terminal once something HAS been entered", () => {
		// The cloud guard's own rule (`POST_FILL_SUBMIT_RE`): an "Apply" at the end of a filled form
		// is the send button. Entry is only entry while there is nothing to send.
		expect(click({ names: ["Apply"], filled: 3 })).toMatchObject({ klass: "step", reason: "step_after_fill" });
		expect(click({ names: ["Apply"], filled: 3, submits: true, method: "post" })).toMatchObject({ klass: "submit", reason: "post_submit_after_fill" });
		expect(click({ names: ["Apply"], uploaded: 1, submits: true, method: "post" }).klass).toBe("submit");
	});

	it("a POST submit with nothing entered is a page-advance, so a multi-page form stays walkable", () => {
		expect(click({ names: ["Save and continue"], submits: true, method: "post" }).klass).toBe("entry");
		expect(click({ names: ["Page 2 of 4"], submits: true, method: "post" })).toMatchObject({ klass: "step", reason: "post_submit_nothing_filled" });
		// A GET form is a search, never a submission.
		expect(click({ names: ["Search jobs"], submits: true, method: "get" }).klass).toBe("other");
	});

	it("an unrecognised control is nobody's business to press", () => {
		expect(click({ names: ["Share on LinkedIn"] }).klass).toBe("other");
		expect(click({ names: [] }).klass).toBe("other");
		expect(click({ names: [undefined, "  "] }).klass).toBe("other");
	});

	it("reads EVERY name it was given — the page's, the snapshot's and the CLI's claim", () => {
		// The CLI can mislabel a control; the page's own accessible name is checked too, and either
		// one naming a submit is enough.
		expect(click({ names: ["Continue", "Submit application"] })).toMatchObject({ klass: "submit", reason: "terminal_label" });
		expect(click({ names: ["Submit application", "Continue"] }).klass).toBe("submit");
	});

	it("the three vocabularies say what they are named for, and the overlap is only in one place", () => {
		expect(APPLY_ENTRY_RE.test("Apply")).toBe(true);
		expect(TERMINAL_APPLY_SUBMIT_RE.test("Apply")).toBe(false);
		expect(ONE_CLICK_SUBMIT_RE.test("Apply")).toBe(false);
		// "Quick apply" is in BOTH apply lists; the classifier's order is what makes it terminal.
		expect(APPLY_ENTRY_RE.test("Quick apply")).toBe(true);
		expect(ONE_CLICK_SUBMIT_RE.test("Quick apply")).toBe(true);
		expect(classifyApplyClick({ role: "button", names: ["Quick apply"], submits: false, method: "", filled: 0, uploaded: 0 }).klass).toBe("submit");
	});
});
