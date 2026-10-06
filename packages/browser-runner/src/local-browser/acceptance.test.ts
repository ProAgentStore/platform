/**
 * #947 acceptance, on the runner: safety, consent and the trace, through the REAL runtime and
 * bridge wiring — only the CLI process and the browser are fakes. Every rule asserted here is
 * enforced in runner code, not asked of a model.
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserTools } from "./bridge.js";
import type { LocalBrowserTaskEnvelope } from "./contract.js";
import { LocalBrowserRuntime } from "./runtime.js";

class FakeChild extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	exitCode: number | null = null;
	kill() {
		this.exit(143);
		return true;
	}
	exit(code: number) {
		if (this.exitCode !== null) return;
		this.exitCode = code;
		this.emit("close", code);
	}
}

const SECRET_KEY = "sk-test-0123456789abcdefghijklmnopqrstuv";
const SHAPELESS = "hunter2-correct-horse";
let dir: string;
let child: FakeChild;
let browserCalls: string[];
let page: { url: string; title: string };

/** A browser whose current page follows navigation, and whose title the test controls. */
const browser: BrowserTools = {
	listTools: async () => ["browser_navigate", "browser_snapshot", "browser_type", "browser_evaluate"].map((name) => ({ name, inputSchema: {} })),
	callTool: async (name, args = {}) => {
		if (name === "browser_evaluate") return { content: [{ text: `### Result\n${JSON.stringify({ url: page.url, title: page.title })}` }] };
		browserCalls.push(name);
		if (name === "browser_navigate") page = { url: String(args.url), title: page.title };
		return { content: [{ text: `${name} ok` }] };
	},
};

function runtime() {
	return new LocalBrowserRuntime({
		dataDir: dir,
		selfUrl: () => "http://127.0.0.1:4999",
		bridgeScript: "/runner/bridge-stdio.js",
		browserFor: async () => ({ tools: browser, stop: async () => undefined }),
		spawn: (() => {
			child = new FakeChild();
			return child;
		}) as never,
	});
}

const envelope = (policy: Partial<LocalBrowserTaskEnvelope["policy"]> = {}, over: Partial<LocalBrowserTaskEnvelope> = {}): LocalBrowserTaskEnvelope => ({
	type: "local_browser.research",
	runId: "run-1",
	requestId: "req-1",
	instanceId: "inst-1",
	objective: "Find roles",
	engine: "codex",
	authMode: "subscription",
	workspace: { kind: "scratch" },
	browserProfile: "isolated",
	policy: { mode: "research_only", allowDomains: [], denyDomains: [], consentedDomains: [], profileConsented: false, ...policy },
	limits: { maxMinutes: 15, maxPages: 30, maxActions: 200, maxConcurrent: 1 },
	resultSchema: { id: "findings", version: 1 },
	...over,
});
const settle = () => new Promise((r) => setTimeout(r, 10));
const call = (rt: LocalBrowserRuntime, name: string, args: Record<string, unknown> = {}) => rt.bridge({ runId: "run-1", op: "call", name, args }) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
const trace = (rt: LocalBrowserRuntime) => rt.status({ runId: "run-1" }).events;

const saved = { ...process.env };
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lb-acceptance-"));
	browserCalls = [];
	page = { url: "about:blank", title: "" };
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	process.env = { ...saved };
});

describe("safety (#947)", () => {
	it("never stores a secret from the environment — not in the error, the summary or the trace", async () => {
		process.env.OPENAI_API_KEY = SECRET_KEY;
		process.env.JOB_SITE_PASSWORD = SHAPELESS; // no recognisable shape: only the env name gives it away
		const rt = runtime();
		rt.start(envelope({ allowDomains: ["seek.com.au"] }, { authMode: "api-key" })); // api-key mode keeps the key in the engine env
		await settle();
		page.title = `Welcome ${SHAPELESS}`;
		await call(rt, "browser_navigate", { url: "https://seek.com.au/" });
		child.stderr.write(`Error: 401 with OPENAI_API_KEY=${SECRET_KEY}\nAuthorization: Bearer ${SECRET_KEY}\nlogin ${SHAPELESS} failed\n`);
		await settle();
		child.exit(1);
		const status = rt.status({ runId: "run-1" });
		const everything = JSON.stringify(status);
		expect(everything).not.toContain(SECRET_KEY);
		expect(everything).not.toContain(SHAPELESS);
		expect(status.result?.error).toMatch(/exited with code 1: .*OPENAI_API_KEY=\[REDACTED\]/s);
		expect(status.events.find((e) => e.type === "browser.navigated")?.detail).toEqual({ title: "Welcome [REDACTED]" });
	});

	it.each(["browser_type", "browser_fill_form", "browser_file_upload", "browser_evaluate"])("refuses %s in research mode, and the browser never sees it", async (tool) => {
		const rt = runtime();
		rt.start(envelope({ allowDomains: ["seek.com.au"] }));
		await settle();
		const r = await call(rt, tool, { text: "x", function: "() => document.forms[0].submit()" });
		expect(r.isError).toBe(true);
		expect(browserCalls).toEqual([]);
		expect(trace(rt).at(-1)).toMatchObject({ type: "policy.decision", detail: { tool, decision: "refused" } });
	});

	it("denies a site that is not on the allow list, without opening it", async () => {
		const rt = runtime();
		rt.start(envelope({ allowDomains: ["seek.com.au"] }));
		await settle();
		expect((await call(rt, "browser_navigate", { url: "https://indeed.com/" })).isError).toBe(true);
		expect(browserCalls).toEqual([]);
	});

	it("lets the deny list win over the allow list, for the site and its subdomains", async () => {
		const rt = runtime();
		rt.start(envelope({ allowDomains: ["seek.com.au"], denyDomains: ["seek.com.au", "ads.example.com"] }));
		await settle();
		for (const url of ["https://seek.com.au/", "https://jobs.seek.com.au/"]) {
			expect((await call(rt, "browser_navigate", { url })).content[0].text).toMatch(/deny list/);
		}
		expect(browserCalls).toEqual([]);
	});
});

describe("consent (#947)", () => {
	it("pauses on a new site with consent.requested, and waits until resumed", async () => {
		const rt = runtime();
		rt.start(envelope());
		await settle();
		const held = call(rt, "browser_navigate", { url: "https://seek.com.au/jobs" });
		await settle();
		expect(rt.status({ runId: "run-1" })).toMatchObject({ state: "paused", pauseReason: "consent_required" });
		expect(trace(rt).slice(-2)).toMatchObject([{ type: "consent.requested", domain: "seek.com.au" }, { type: "run.paused" }]);
		expect(browserCalls).toEqual([]); // nothing opened while waiting
		rt.resume({ runId: "run-1", consentedDomains: ["seek.com.au"], denyDomains: [], profileConsented: false, consentIds: { "seek.com.au": "consent-allow-1" } });
		expect((await held).isError).toBeUndefined();
		expect(browserCalls).toEqual(["browser_navigate"]);
	});

	it("names the owner's ALLOW decision on the policy decision that follows, and on later visits", async () => {
		const rt = runtime();
		rt.start(envelope());
		await settle();
		const held = call(rt, "browser_navigate", { url: "https://seek.com.au/jobs" });
		await settle();
		rt.resume({ runId: "run-1", consentedDomains: ["seek.com.au"], denyDomains: [], profileConsented: false, consentIds: { "seek.com.au": "consent-allow-1" } });
		await held;
		expect(trace(rt).find((e) => e.type === "policy.decision")).toMatchObject({ domain: "seek.com.au", consentId: "consent-allow-1", detail: { decision: "allowed", basis: "consent" } });
	});

	it("blocks a DENIED site for the rest of the run, naming the decision, without asking again", async () => {
		const rt = runtime();
		rt.start(envelope());
		await settle();
		const held = call(rt, "browser_navigate", { url: "https://indeed.com/" });
		await settle();
		rt.resume({ runId: "run-1", consentedDomains: [], denyDomains: ["indeed.com"], profileConsented: false, consentIds: { "indeed.com": "consent-deny-1" } });
		expect((await held).isError).toBe(true);
		const again = await call(rt, "browser_navigate", { url: "https://au.indeed.com/jobs" });
		expect(again.content[0].text).toMatch(/deny list/);
		expect(trace(rt).filter((e) => e.type === "consent.requested")).toHaveLength(1);
		expect(trace(rt).at(-1)).toMatchObject({ type: "policy.decision", domain: "au.indeed.com", consentId: "consent-deny-1", detail: { decision: "refused" } });
		expect(browserCalls).toEqual([]);
	});

	it("is deterministic: the same decisions give the same trace, run after run", async () => {
		const scenario = async () => {
			const rt = runtime();
			rt.start(envelope({ allowDomains: [], denyDomains: ["indeed.com"], consentedDomains: ["seek.com.au"], consentIds: { "seek.com.au": "c-allow", "indeed.com": "c-deny" } }));
			await settle();
			await call(rt, "browser_navigate", { url: "https://seek.com.au/" });
			await call(rt, "browser_navigate", { url: "https://seek.com.au/page/2" });
			await call(rt, "browser_navigate", { url: "https://indeed.com/" });
			child.exit(0);
			// Times and positions differ between runs; what happened, where, and on whose decision must not.
			return trace(rt).map(({ type, domain, consentId, pauseReason, detail }) => ({ type, domain, consentId, pauseReason, decision: detail?.decision }));
		};
		const first = await scenario();
		expect(await scenario()).toEqual(first);
		expect(first.filter((e) => e.type === "policy.decision")).toEqual([
			{ type: "policy.decision", domain: "seek.com.au", consentId: "c-allow", pauseReason: undefined, decision: "allowed" },
			{ type: "policy.decision", domain: "indeed.com", consentId: "c-deny", pauseReason: undefined, decision: "refused" },
		]);
	});
});

describe("the trace (#947)", () => {
	it("records each browser step with its url, domain, type and time", async () => {
		const rt = runtime();
		rt.start(envelope({ allowDomains: ["seek.com.au"] }));
		await settle();
		page.title = "Jobs";
		await call(rt, "browser_navigate", { url: "https://www.seek.com.au/jobs" });
		const nav = trace(rt).find((e) => e.type === "browser.navigated");
		expect(nav).toMatchObject({ type: "browser.navigated", url: "https://www.seek.com.au/jobs", domain: "www.seek.com.au", detail: { title: "Jobs" } });
		expect(Number.isNaN(Date.parse(String(nav?.at)))).toBe(false);
		expect(trace(rt).map((e) => e.type)).toEqual(["engine.auth_checked", "engine.started", "policy.decision", "browser.navigated"]);
	});
});
