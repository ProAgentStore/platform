import { describe, expect, it, vi } from "vitest";
import type { BrowserTools } from "../local-browser/bridge.js";
import { redactReplayText } from "./apply-replay.js";
import { ShotRecorder } from "../local-browser/replay.js";
import { ApplyBridge, type ApplyBridgeHost } from "./bridge.js";
import type { LocalApplyEvent } from "./contract.js";

const JOB = "https://jobs.example.test/job/123";
const LOGIN = "https://jobs.example.test/login?state=private-token#secret";

function fixture({ enabled = true, target = "Apply", secret = "", pageUnavailable = false } = {}) {
	let currentUrl = "about:blank";
	let popup = false;
	let shot = 0;
	let screenshotFails = false;
	let clickFails = false;
	let release: (result: "stopped") => void = () => undefined;
	let paused: () => void = () => undefined;
	const whenPaused = new Promise<void>((done) => { paused = done; });
	const events: Array<Omit<LocalApplyEvent, "at">> = [];
	const result = (text: string) => ({ content: [{ type: "text", text }] });
	const browser: BrowserTools = {
		listTools: async () => [],
		callTool: async (name, args = {}) => {
			if (name === "browser_evaluate") return result(`### Result\n${JSON.stringify(args.target ? { submits: false, method: "", tag: "a", name: target } : { url: currentUrl, login: currentUrl === LOGIN })}`);
			if (name === "browser_navigate") currentUrl = String(args.url);
			if (name === "browser_snapshot") return result(`- link "${target}" [ref=e1]`);
			if (name === "browser_tabs") {
				if (args.action === "select") currentUrl = LOGIN;
				return result(`### Result\n- 0: Job${popup ? "\n- 1: Login" : ""}`);
			}
			if (name === "browser_click") {
				if (clickFails) throw new Error("synthetic browser failure");
				popup = true;
			}
			return result("ok");
		},
	};
	const host: ApplyBridgeHost = {
		emit: (event) => { events.push(event); },
		pause: () => { paused(); return new Promise((done) => { release = done; }); },
		supervisorCheckpoint: async () => "continue",
		isAllowed: (host) => host === "jobs.example.test",
		grounding: () => "Name: Jane Citizen",
		artifactPath: () => ({ error: "no synthetic artifact" }),
		overTime: () => false,
		now: () => 12345,
		limits: { maxMinutes: 10, maxActions: 20, maxPages: 10 },
		mode: "fill_and_review",
		redact: (text) => redactReplayText(text, secret ? [secret] : []),
		page: () => { if (pageUnavailable) throw new Error("synthetic lost page handle"); return { url: () => currentUrl, locator: () => ({}) as never, screenshot: async () => {
			if (screenshotFails) throw new Error("synthetic screenshot failure");
			return Buffer.from(`frame ${++shot}: ${currentUrl}`);
		} }; },
	};
	const shots = new ShotRecorder(20);
	const bridge = new ApplyBridge(browser, host, enabled ? shots : undefined);
	return { bridge, shots, events, whenPaused, stop: () => release("stopped"), failScreenshot: () => { screenshotFails = true; }, failClick: () => { clickFails = true; } };
}

async function openJob(f: ReturnType<typeof fixture>) {
	await f.bridge.callTool("browser_navigate", { url: JOB });
	await f.bridge.callTool("browser_snapshot", {});
	await f.bridge.callTool("supervisor_checkpoint", { checkpointId: "job-1", phase: "initial" });
}

describe("application replay preserves action and pause evidence", () => {
	it("captures the selected login popup before its click returns or the owner resumes", async () => {
		const f = fixture();
		await openJob(f);
		expect(f.shots.shots.map((s) => s.url)).toEqual([JOB, JOB, JOB]);
		let returned = false;
		const click = f.bridge.callTool("browser_click", { target: "e1", element: "invented model description" }).then((r) => { returned = true; return r; });
		await f.whenPaused;
		try {
			expect(returned).toBe(false);
			expect(f.shots.shots).toHaveLength(4);
			const last = f.shots.shots.at(-1)!;
			expect(last).toMatchObject({ point: "blocked", url: "https://jobs.example.test/login", action: "browser_click", target: "Apply" });
			expect(Buffer.from(last.data, "base64").toString()).toContain("/login");
			expect(last.data).not.toBe(f.shots.shots[0].data);
			expect(f.events).toContainEqual(expect.objectContaining({ type: "policy.decision", detail: { class: "action", tool: "browser_click", decision: "completed", target: "Apply" } }));
			expect(f.events).toContainEqual(expect.objectContaining({ type: "screenshot.captured", url: "https://jobs.example.test/login", detail: expect.objectContaining({ shot: 4, reason: "login_required" }) }));
		} finally { f.stop(); await click; }
		expect(f.shots.shots).toHaveLength(4); // Stopping the parked call must not add a duplicate failure frame.
	});

	it("records a browser failure as failed, with its own frame instead of pretending an allowed action completed", async () => {
		const f = fixture();
		await openJob(f);
		f.failClick();
		await expect(f.bridge.callTool("browser_click", { target: "e1" })).rejects.toThrow("synthetic browser failure");
		expect(f.events.filter((e) => e.detail?.class === "action" && e.detail?.tool === "browser_click").map((e) => e.detail?.decision)).toEqual(["failed"]);
		expect(f.shots.shots.at(-1)).toMatchObject({ point: "blocked", url: JOB, target: "Apply" });
	});

	it("states why a screenshot is missing without changing the successful action result", async () => {
		const f = fixture();
		f.failScreenshot();
		expect((await f.bridge.callTool("browser_navigate", { url: JOB })).isError).not.toBe(true);
		expect(f.shots.shots).toEqual([]);
		expect(f.events).toContainEqual(expect.objectContaining({ type: "policy.decision", detail: expect.objectContaining({ class: "replay", decision: "missing", reason: "capture_failed" }) }));
	});

	it("redacts known run secrets from observed labels and strips URL state before recording metadata", async () => {
		const f = fixture({ target: "Apply 482913", secret: "482913" });
		await openJob(f);
		const click = f.bridge.callTool("browser_click", { target: "e1" });
		await f.whenPaused;
		try {
			const metadata = f.shots.shots.map(({ data: _pixels, ...rest }) => rest);
			expect(JSON.stringify(metadata)).not.toMatch(/482913|private-token|#secret/);
			expect(JSON.stringify(f.events)).not.toContain("482913");
			expect(f.shots.shots.at(-1)?.target).toContain("[REDACTED]");
		} finally { f.stop(); await click; }
	});

	it("takes no screenshots and reports no missing frames when capture is off", async () => {
		const f = fixture({ enabled: false });
		await openJob(f);
		expect(f.shots.shots).toEqual([]);
		expect(f.events.some((e) => e.type === "screenshot.captured" || e.detail?.class === "replay")).toBe(false);
	});
	it.each(["page getter", "recorder"])("keeps the login pause available when the %s throws", async (failure) => {
		const f = fixture({ pageUnavailable: failure === "page getter" });
		if (failure === "recorder") vi.spyOn(f.shots, "captureResult").mockRejectedValue(new Error("synthetic recorder failure"));
		await openJob(f);
		const click = f.bridge.callTool("browser_click", { target: "e1" });
		await f.whenPaused;
		try {
			expect(f.events).toContainEqual(expect.objectContaining({ type: "policy.decision", detail: expect.objectContaining({ class: "replay", decision: "missing", reason: failure === "page getter" ? "page_unavailable" : "capture_failed" }) }));
		} finally { f.stop(); await click; }
	});
});
