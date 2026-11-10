import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ApplyBridge, type ApplyBridgeHost } from "./bridge.js";
import { fullArtifactPaths, parseToolAccess } from "./full-tools.js";
import { ACCOUNT_DATA_RULE, fullApplyPrompt } from "./full-prompt.js";
import { sourceId } from "./answer-decision.js";
import type { BrowserTools } from "../local-browser/bridge.js";
import type { MaskablePage } from "../local-browser/replay.js";

const names = ["browser_snapshot", "browser_type", "browser_fill_form", "browser_evaluate", "browser_run_code_unsafe", "browser_take_screenshot", "browser_tabs", "browser_click", "browser_navigate", "browser_select_option"];
const native = names.map((name) => ({ name, description: `native ${name}`, inputSchema: { type: "object", properties: { target: { type: "string" }, code: { type: "string" } }, additionalProperties: false } }));
function fixture(over: Partial<ApplyBridgeHost> = {}) {
	let url = "https://forms.example.test/start";
	const page = { url: () => url } as MaskablePage;
	const emit = vi.fn();
	const callTool = vi.fn<BrowserTools["callTool"]>(async (name) => name === "browser_snapshot" ? { content: [{ type: "text", text: '- button "Final send" [ref=s1]' }] } : name === "browser_take_screenshot" ? { content: [{ type: "text", text: "native metadata" }, { type: "image", data: "PIXELS", mimeType: "image/png" }] } : { content: [{ type: "text", text: "native response" }] });
	const host: ApplyBridgeHost = { emit, pause: async () => "resumed", supervisorCheckpoint: async () => "continue", isAllowed: () => true, grounding: () => "Trusted facts", artifactPath: () => ({ error: "No document" }), overTime: () => false, isStopped: () => false, now: Date.now, limits: { maxActions: 30, maxPages: 5, maxMinutes: 5 }, mode: "fill_and_review", toolAccess: "full", escalationLevel: "autonomous", page: () => page, ...over };
	const bridge = new ApplyBridge({ listTools: async () => native, callTool }, host);
	return { bridge, callTool, host, emit, navigate: (next: string) => { url = next; } };
}

describe("accepted full native application tools", () => {
	it("preserves complete native schemas and pixels even with replay disabled", async () => {
		const f = fixture(); const tools = await f.bridge.listTools();
		for (const tool of native) expect(tools.find((item) => item.name === tool.name)).toEqual(tool);
		expect(tools.map((tool) => tool.name)).toContain("submit_application");
		expect(await f.bridge.callTool("browser_take_screenshot", { scale: "css" })).toEqual({ content: [{ type: "text", text: "native metadata" }, { type: "image", data: "PIXELS", mimeType: "image/png" }] });
		expect(f.bridge.screenshotRequests).toBe(1); expect(f.bridge.screenshotsDelivered).toBe(1); expect(f.bridge.independentScreenshotAvailable).toBe(false);
	});
	it("dispatches native forms/code/keys without page classifiers, source schema injection or routine checkpoints", async () => {
		const f = fixture();
		await f.bridge.callTool("browser_fill_form", { fields: [{ name: "Any new question", type: "textbox", value: "Owner fact", ref: "x" }] });
		await f.bridge.callTool("browser_run_code_unsafe", { code: "async page => page.title()" });
		await f.bridge.callTool("browser_evaluate", { function: "() => document.title" });
		expect(f.callTool.mock.calls.map(([name]) => name)).toEqual(["browser_fill_form", "browser_run_code_unsafe", "browser_evaluate"]);
		expect(f.bridge.filled).toBe(0); expect(f.bridge.submitAttempted).toBe(false);
		await f.bridge.callTool("ready_for_review", { summary: "Model reports values verified" });
		expect(f.bridge.reviewReady).toBe(true); expect(f.bridge.summary).toContain("submission state is unverified");
		expect(f.emit.mock.calls.some(([event]) => event.detail?.tool === "browser_run_code_unsafe" && event.detail?.decision === "completed")).toBe(true);
	});
	it("keeps guarded access unchanged and refuses unadvertised tools", async () => {
		const f = fixture({ toolAccess: "guarded" });
		expect((await f.bridge.listTools()).some((tool) => tool.name === "browser_run_code_unsafe")).toBe(false);
		expect((await f.bridge.callTool("browser_run_code_unsafe", { code: "anything" })).isError).toBe(true);
		expect(f.callTool).not.toHaveBeenCalled();
		const full = fixture(); expect((await full.bridge.callTool("browser_unlisted", {})).isError).toBe(true); expect(full.callTool).not.toHaveBeenCalled();
	});
	it("checks Stop and limits before native dispatch, including when a queued call resumes", async () => {
		let stopped = false; const f = fixture({ isStopped: () => stopped, limits: { maxActions: 1, maxPages: 1, maxMinutes: 1 } });
		await f.bridge.callTool("browser_evaluate", { function: "() => 1" });
		expect((await f.bridge.callTool("browser_evaluate", { function: "() => 2" })).isError).toBe(true);
		stopped = true; expect((await f.bridge.callTool("browser_tabs", { action: "close" })).isError).toBe(true); expect(f.callTool).toHaveBeenCalledTimes(1);
	});
	it("requires fresh explicit submit checkpoint, a current target, and separate submission permission", async () => {
		const f = fixture();
		await f.bridge.callTool("browser_snapshot");
		expect((await f.bridge.callTool("submit_application", { ref: "s1" })).isError).toBe(true);
		await f.bridge.callTool("supervisor_checkpoint", { checkpointId: "final", phase: "before_submit" });
		await f.bridge.callTool("submit_application", { ref: "s1" });
		expect(f.callTool.mock.calls.some(([name]) => name === "browser_click")).toBe(false);
		expect(f.bridge.submitAttempted).toBe(false);
	});
	it("invalidates submission permission after native actions or a page change", async () => {
		const f = fixture({ mode: "auto_submit", gateId: "gate" });
		await f.bridge.callTool("browser_snapshot");
		await f.bridge.callTool("supervisor_checkpoint", { checkpointId: "final", phase: "before_submit" });
		await f.bridge.callTool("browser_evaluate", { function: "() => 1" });
		expect((await f.bridge.callTool("submit_application", { ref: "s1" })).isError).toBe(true);
		await f.bridge.callTool("supervisor_checkpoint", { checkpointId: "final2", phase: "before_submit" }); f.navigate("https://forms.example.test/other");
		expect((await f.bridge.callTool("submit_application", { ref: "s1" })).isError).toBe(true);
	});
	it("requests sign-in explicitly and binds only credential-placeholder calls to the observed origin", async () => {
		const clear = vi.fn(); const f = fixture({ pause: async () => "sign_in", signInSecrets: () => ["PAGS_LOGIN_PASSWORD"], signInDone: clear });
		await f.bridge.callTool("request_sign_in");
		await f.bridge.callTool("browser_type", { target: "password", text: "PAGS_LOGIN_PASSWORD" });
		expect(f.callTool.mock.calls.at(-1)?.[2]).toEqual({ expectedOrigin: "https://forms.example.test" });
		await f.bridge.callTool("browser_snapshot"); expect(f.callTool.mock.calls.at(-1)?.[2]).toBeUndefined();
		await f.bridge.callTool("finish_sign_in"); expect(clear).toHaveBeenCalledOnce();
	});
	it("holds a login_required block while the sign-in pause is unresolved and clears it once resolved", async () => {
		let release: (o: "resumed") => void = () => {};
		const f = fixture({ pause: () => new Promise((done) => { release = done; }) });
		const pending = f.bridge.callTool("request_sign_in");
		await Promise.resolve(); await Promise.resolve();
		expect(f.bridge.blocked).toEqual({ reason: "login_required", questions: ["Sign in to example.test on this machine's application browser, then retry. Nothing was submitted."] });
		release("resumed"); await pending;
		expect(f.bridge.blocked).toBeNull();
	});
	it("refuses a sign-in code request after redirect and clears credentials", async () => {
		const code = vi.fn(async () => true); const clear = vi.fn();
		const f = fixture({ pause: async () => "sign_in", requestSignInCode: code, signInDone: clear });
		await f.bridge.callTool("request_sign_in"); f.navigate("https://other.example.test/");
		expect((await f.bridge.callTool("request_sign_in_code")).isError).toBe(true);
		expect(code).not.toHaveBeenCalled(); expect(clear).toHaveBeenCalledOnce();
	});
	it("clears broker secrets if the origin changes while a code request waits", async () => {
		let resolve!: (value: boolean) => void; const clear = vi.fn();
		const f = fixture({ pause: async () => "sign_in", requestSignInCode: () => new Promise<boolean>((done) => { resolve = done; }), signInDone: clear });
		await f.bridge.callTool("request_sign_in");
		const pending = f.bridge.callTool("request_sign_in_code"); await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
		f.navigate("https://other.example.test/"); resolve(true);
		expect((await pending).isError).toBe(true); expect(clear).toHaveBeenCalledOnce();
	});
	it("does not mark unresolved personal facts ready for submission", async () => {
		const f = fixture(); await f.bridge.callTool("browser_snapshot");
		await f.bridge.callTool("request_answer", { question: "Unrecorded fact?" });
		await f.bridge.callTool("ready_for_review", { summary: "Known values filled" });
		expect(f.bridge.reviewReady).toBe(false); expect(f.bridge.blocked?.reason).toBe("incomplete"); expect(f.bridge.summary).toContain("unverified");
	});
	it.each(["Public portfolio?", "Additional information for this request?"])("allows an evidence-backed optional omission for %s without inventing a value", async (question) => {
		const f = fixture();
		await f.bridge.callTool("browser_snapshot");
		await f.bridge.callTool("request_answer", { question });
		expect(f.bridge.unresolvedQuestions).toEqual([question]);
		const assessment = { classification: "optional", observationUrl: "https://forms.example.test/start", evidence: "The current review accepts the empty optional control; no material claim changes.", omissionVerified: true, decision: { risk: "minor", reason: "Leaving a voluntary detail absent asserts no new fact." } };
		expect((await f.bridge.callTool("request_answer", { question, assessment })).isError).not.toBe(true);
		expect(f.bridge.unresolvedQuestions).toEqual([]);
		expect(f.bridge.deferredQuestions).toEqual([expect.objectContaining({ question, classification: "optional", blocking: false, omissionVerified: true })]);
		expect(f.callTool.mock.calls.map(([name]) => name)).toEqual(["browser_snapshot"]);
		await f.bridge.callTool("ready_for_review", { summary: "Required fields verified, optional detail omitted." });
		expect(f.bridge.reviewReady).toBe(true);
		expect(f.bridge.submitAttempted).toBe(false);
	});
	it.each(["required", "material", "unknown"])("reinstates an omitted question when later evidence changes its classification to %s", async (classification) => {
		const f = fixture(); const question = "Unrecorded fact?";
		const assessment = { classification: "optional", observationUrl: "https://forms.example.test/start", evidence: "Current form accepts omission.", omissionVerified: true, decision: { risk: "minor", reason: "Optional omission." } };
		await f.bridge.callTool("request_answer", { question, assessment });
		await f.bridge.callTool("request_answer", { question, assessment: { ...assessment, classification, omissionVerified: false, evidence: "Later validation or context requires clarification." } });
		expect(f.bridge.unresolvedQuestions).toEqual([question]);
		await f.bridge.callTool("browser_snapshot");
		await f.bridge.callTool("ready_for_review", { summary: "Required question unresolved." });
		expect(f.bridge.reviewReady).toBe(false);
	});
	it.each([
		["balanced", "minor", true, false], ["balanced", "major", true, true],
		["conservative", "minor", true, true], ["autonomous", "minor", false, true],
	] as const)("applies %s authority to %s omission with verified=%s", async (escalationLevel, risk, omissionVerified, blocking) => {
		const pause = vi.fn(async () => "resumed" as const); const f = fixture({ escalationLevel, pause });
		await f.bridge.callTool("request_answer", { question: "Unknown optional detail?", assessment: { classification: "optional", observationUrl: "https://forms.example.test/start", evidence: "Observed current form behavior.", omissionVerified, decision: { risk, reason: "Model-assessed omission risk." } } });
		expect(f.bridge.unresolvedQuestions.length).toBe(blocking ? 1 : 0);
		expect(pause).toHaveBeenCalledTimes(blocking && escalationLevel !== "autonomous" ? 1 : 0);
	});
	it("retains current trusted provenance and bounded redacted rationale without exposing evidence in trace", async () => {
		const source = { label: "owner memory", text: "Two historical facts remain in conflict." };
		const f = fixture({ groundingSources: () => [source], redact: (value) => value.replaceAll("private-token", "[REDACTED]") });
		const assessment = { classification: "optional", observationUrl: "https://forms.example.test/start", evidence: "Observed omission accepted, private-token", omissionVerified: true, sourceIds: [sourceId(source)], decision: { risk: "minor", reason: "No new assertion, private-token" } };
		expect((await f.bridge.callTool("request_answer", { question: "Unknown detail?", assessment })).isError).not.toBe(true);
		expect(f.bridge.deferredQuestions[0]).toMatchObject({ sourceIds: [sourceId(source)], evidence: "Observed omission accepted, [REDACTED]", reason: "No new assertion, [REDACTED]" });
		expect(JSON.stringify(f.emit.mock.calls)).not.toContain("private-token");
		expect(JSON.stringify(f.emit.mock.calls)).not.toContain("Observed omission accepted");
		expect((await f.bridge.callTool("request_answer", { question: "Unknown detail?", assessment: { ...assessment, sourceIds: ["page-claimed-source"] } })).isError).toBe(true);
	});
	it("still records a blocking question when the browser page is unavailable", async () => {
		const f = fixture({ page: () => { throw new Error("closed browser"); } });
		expect((await f.bridge.callTool("request_answer", { question: "Missing required fact?" })).isError).not.toBe(true);
		expect(f.bridge.unresolvedQuestions).toEqual(["Missing required fact?"]);
	});

	it("rejects stale or malformed reclassification without removing an existing blocker", async () => {
		const f = fixture(); const question = "Unknown detail?";
		await f.bridge.callTool("request_answer", { question });
		for (const assessment of [{ classification: "optional" }, { classification: "optional", observationUrl: "https://other.example.test/", evidence: "Old page", omissionVerified: true, decision: { risk: "minor", reason: "Optional" } }]) expect((await f.bridge.callTool("request_answer", { question, assessment })).isError).toBe(true);
		expect(f.bridge.unresolvedQuestions).toEqual([question]);
	});
	describe("owner account storage (#1626)", () => {
		const limitDialog = ['- dialog "Resumé limit reached. Please select a resumé to delete from your list and try again." [ref=d0]', '- combobox "Résumé to delete" [ref=d1]', '- button "Delete selected résumé" [ref=d2]', '- button "Remove resume.pdf from application" [ref=f1]'].join("\n");
		function limitFixture(over: Partial<ApplyBridgeHost> = {}) {
			const f = fixture(over);
			f.callTool.mockImplementation(async (name) => ({ content: [{ type: "text", text: name === "browser_snapshot" ? limitDialog : "native response" }] }));
			return f;
		}
		it("holds a delete on the owner's stored resumes with a missing_answer pause and never dispatches it", async () => {
			const pause = vi.fn(async () => "resumed" as const);
			const f = limitFixture({ pause, escalationLevel: "autonomous" });
			await f.bridge.callTool("browser_snapshot");
			const select = await f.bridge.callTool("browser_select_option", { element: "Résumé to delete dropdown", target: "#docLimitExceededDropdown", values: ["10/11/26 - resume.pdf"] });
			expect(select.isError).toBe(true);
			expect(pause).toHaveBeenCalledWith(expect.objectContaining({ reason: "missing_answer", question: expect.stringContaining("forms.example.test") }), undefined);
			const click = await f.bridge.callTool("browser_click", { element: "Delete selected résumé button", target: "d2" });
			expect(click.isError).toBe(true);
			expect(f.callTool.mock.calls.map(([n]) => n)).toEqual(["browser_snapshot"]);
		});
		it("lets the delete through once the owner's answer arrives, for one click", async () => {
			let facts = "Trusted facts";
			const f = limitFixture({ pause: async () => { facts += " Owner: delete the oldest"; return "resumed"; }, grounding: () => facts });
			await f.bridge.callTool("browser_snapshot");
			expect((await f.bridge.callTool("browser_click", { element: "Delete selected résumé button", target: "d2" })).isError).toBe(true);
			await f.bridge.callTool("browser_click", { element: "Delete selected résumé button", target: "d2" });
			expect(f.callTool.mock.calls.filter(([n]) => n === "browser_click")).toHaveLength(1);
		});
		it("does not block removing an attachment from the current application form", async () => {
			const pause = vi.fn(async () => "resumed" as const);
			const f = fixture({ pause });
			await f.bridge.callTool("browser_click", { element: "Remove resume.pdf from application", target: "f1" });
			expect(pause).not.toHaveBeenCalled();
			expect(f.callTool.mock.calls.map(([n]) => n)).toEqual(["browser_click"]);
		});
		it("tells the model never to delete stored account data", () => {
			expect(ACCOUNT_DATA_RULE).toMatch(/Never delete, remove or replace data stored on the owner's job-site account/);
			expect(fullApplyPrompt({ job: { title: "T" }, applicationUrl: "https://x.test", policy: {}, limits: { maxActions: 1, maxPages: 1, maxMinutes: 1 } } as never, [])).toContain(ACCOUNT_DATA_RULE);
		});
	});
});

describe("full tool authority and document provenance", () => {
	const receipt = { revision: "full_playwright_v1", acceptedAt: "2026-11-05T00:00:00Z", acceptedBy: "owner", instanceId: "instance" };
	it("requires a structurally valid receipt bound to this instance", () => {
		expect(parseToolAccess({}, "instance").toolAccess).toBe("guarded");
		expect(() => parseToolAccess({ toolAccess: "full" }, "instance")).toThrow(/acceptance/);
		expect(() => parseToolAccess({ toolAccess: "full", toolAccessAcceptance: receipt }, "other")).toThrow(/acceptance/);
		expect(parseToolAccess({ toolAccess: "full", toolAccessAcceptance: receipt }, "instance")).toMatchObject({ toolAccess: "full", toolAccessAcceptance: receipt });
	});
	it("stages approved documents with their extension, and rechecks original and staged bytes on every use", () => {
		const dir = mkdtempSync(join(tmpdir(), "full-docs-"));
		try {
			const original = join(dir, "source.pdf"); writeFileSync(original, "PDF bytes");
			const sha256 = createHash("sha256").update("PDF bytes").digest("hex"); let changed = false;
			const paths = fullArtifactPaths(() => changed ? { error: "Original changed" } : { path: original, sha256 }, [{ kind: "resume", path: "~/source.pdf", sha256 }], dir);
			const staged = paths("resume"); if ("error" in staged) throw new Error(staged.error);
			expect(staged.path.endsWith("resume.pdf")).toBe(true); expect(readFileSync(staged.path, "utf8")).toBe("PDF bytes");
			changed = true; expect(paths("resume")).toEqual({ error: "Original changed" }); changed = false;
			writeFileSync(staged.path, "changed"); expect(paths("resume")).toMatchObject({ error: expect.stringContaining("changed") });
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
});
