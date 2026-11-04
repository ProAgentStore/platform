import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ApplyBridge, type ApplyBridgeHost } from "./bridge.js";
import { fullArtifactPaths, parseToolAccess } from "./full-tools.js";
import type { BrowserTools } from "../local-browser/bridge.js";
import type { MaskablePage } from "../local-browser/replay.js";

const names = ["browser_snapshot", "browser_type", "browser_fill_form", "browser_evaluate", "browser_run_code_unsafe", "browser_take_screenshot", "browser_tabs", "browser_click", "browser_navigate"];
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
