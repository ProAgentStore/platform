/**
 * The local browser research runtime (#944): one run per requestId, a concurrency cap, a scratch
 * folder that is never a repository, pauses the owner resolves, the result envelope, and cleanup.
 * The CLI process and the browser are faked; the registry, lifecycle and policy wiring are real.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserTools } from "./bridge.js";
import type { LocalBrowserTaskEnvelope } from "./contract.js";
import { LocalBrowserRuntime, parseEnvelope, resolveWorkspacePath } from "./runtime.js";

class FakeChild extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	exitCode: number | null = null;
	killed: string[] = [];
	kill(signal: string) {
		this.killed.push(signal);
		this.exit(143);
		return true;
	}
	exit(code: number) {
		if (this.exitCode !== null) return;
		this.exitCode = code;
		this.emit("close", code);
	}
}

let dir: string;
let home: string;
let spawned: Array<{ command: string; args: string[]; opts: { cwd: string; env: NodeJS.ProcessEnv }; child: FakeChild }>;
let browsersStopped: number;
let now: number;

const browser: BrowserTools = {
	listTools: async () => [{ name: "browser_navigate", inputSchema: {} }, { name: "browser_snapshot", inputSchema: {} }],
	callTool: async (name, args = {}) =>
		name === "browser_evaluate" ? { content: [{ text: `### Result\n${JSON.stringify({ url: "https://seek.com.au/jobs", title: "Jobs" })}` }] } : { content: [{ text: `${name} ${JSON.stringify(args)}` }] },
};

function runtime(over: { retentionMs?: number; spawnError?: NodeJS.ErrnoException } = {}) {
	return new LocalBrowserRuntime({
		dataDir: dir,
		homeDir: home,
		selfUrl: () => "http://127.0.0.1:4999",
		bridgeScript: "/runner/bridge-stdio.js",
		now: () => now,
		retentionMs: over.retentionMs,
		browserFor: async () => ({ tools: browser, stop: async () => void browsersStopped++ }),
		spawn: ((command: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => {
			const child = new FakeChild();
			spawned.push({ command, args, opts, child });
			if (over.spawnError) queueMicrotask(() => child.emit("error", over.spawnError));
			return child;
		}) as never,
	});
}

const envelope = (over: Partial<LocalBrowserTaskEnvelope> = {}): LocalBrowserTaskEnvelope => ({
	type: "local_browser.research",
	runId: "run-1",
	requestId: "req-1",
	instanceId: "inst-1",
	objective: "Find Sydney TypeScript roles",
	engine: "claude",
	authMode: "subscription",
	workspace: { kind: "scratch" },
	browserProfile: "isolated",
	policy: { mode: "research_only", allowDomains: ["seek.com.au"], denyDomains: [], consentedDomains: [], profileConsented: false },
	limits: { maxMinutes: 15, maxPages: 30, maxActions: 200, maxConcurrent: 1 },
	resultSchema: { id: "findings", version: 1 },
	...over,
});
const settle = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "lb-runtime-"));
	home = mkdtempSync(join(tmpdir(), "lb-home-"));
	spawned = [];
	browsersStopped = 0;
	now = 1_000_000;
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
});

describe("starting a run", () => {
	it("spawns the engine in a scratch folder under the runner, with the bridge as its MCP server", async () => {
		const rt = runtime();
		expect(rt.start(envelope())).toEqual({ runId: "run-1", taskId: "run-1", status: "running", existing: false });
		await settle();
		const s = spawned[0];
		expect(s.command).toBe("claude");
		expect(s.opts.cwd).toBe(join(dir, "local-browser", "inst-1", "run-1", "scratch"));
		expect(existsSync(join(s.opts.cwd, ".git"))).toBe(false);
		const mcp = JSON.parse(readFileSync(join(dir, "local-browser", "inst-1", "run-1", "mcp.json"), "utf8"));
		expect(mcp.mcpServers.pags_browser).toMatchObject({ args: ["/runner/bridge-stdio.js"], env: { PAGS_BRIDGE_URL: "http://127.0.0.1:4999", PAGS_BRIDGE_RUN: "run-1" } });
		expect(rt.status({ runId: "run-1" }).events.map((e) => e.type)).toEqual(["engine.auth_checked", "engine.started"]);
	});

	it("is idempotent on requestId, and holds the concurrency cap per instance", async () => {
		const rt = runtime();
		rt.start(envelope());
		expect(rt.start(envelope({ runId: "run-other" }))).toMatchObject({ runId: "run-1", existing: true });
		expect(() => rt.start(envelope({ runId: "run-2", requestId: "req-2" }))).toThrow(/already running 1 research run/);
		// Another instance has its own cap.
		expect(rt.start(envelope({ runId: "run-3", requestId: "req-3", instanceId: "inst-2" })).status).toBe("running");
		await settle();
		expect(spawned).toHaveLength(2);
	});

	it("runs in a home-relative folder the owner chose, and refuses one outside home", async () => {
		const rt = runtime();
		rt.start(envelope({ workspace: { kind: "path", path: "~/jobs" } }));
		await settle();
		expect(spawned[0].opts.cwd).toBe(realpathSync(join(home, "jobs")));
		expect(() => resolveWorkspacePath("~/../etc", home)).toThrow(/inside this machine's home/);
		mkdirSync(join(home, "a"));
		symlinkSync(tmpdir(), join(home, "a", "out"));
		expect(() => resolveWorkspacePath("~/a/out", home)).toThrow(/symlink/);
		expect(() => resolveWorkspacePath("/etc", home)).toThrow(/written "~\/…"/);
	});

	it("refuses an envelope that is not a research run", () => {
		expect(() => parseEnvelope({ ...envelope(), policy: { ...envelope().policy, mode: "full_access" } })).toThrow(/research_only/);
		expect(() => parseEnvelope({ ...envelope(), engine: "grok" })).toThrow(/engine/);
		expect(() => parseEnvelope({ ...envelope(), limits: { ...envelope().limits, maxMinutes: 600 } })).toThrow(/limits/);
	});
});

describe("the bridge", () => {
	it("accepts only the run's own token, and only while the run is live", async () => {
		const rt = runtime();
		rt.start(envelope());
		await settle();
		const token = spawned[0].args.length ? JSON.parse(readFileSync(join(dir, "local-browser", "inst-1", "run-1", "mcp.json"), "utf8")).mcpServers.pags_browser.env.PAGS_BRIDGE_TOKEN : "";
		expect(rt.authorizeBridge("run-1", token)).toBe(true);
		expect(rt.authorizeBridge("run-1", "guess")).toBe(false);
		expect(rt.authorizeBridge("run-2", token)).toBe(false);
		spawned[0].child.exit(0);
		expect(rt.authorizeBridge("run-1", token)).toBe(false);
	});
});

describe("ending a run", () => {
	it("returns the findings the bridge recorded and the summary, with the observed sign-in", async () => {
		const rt = runtime();
		rt.start(envelope());
		await settle();
		await rt.bridge({ runId: "run-1", op: "call", name: "browser_navigate", args: { url: "https://seek.com.au/jobs" } });
		await rt.bridge({ runId: "run-1", op: "call", name: "record_finding", args: { title: "Dev", url: "https://seek.com.au/job/1", evidence: "Dev — Sydney" } });
		await rt.bridge({ runId: "run-1", op: "call", name: "finish_research", args: { summary: "1 role" } });
		spawned[0].child.exit(0);
		const s = rt.status({ runId: "run-1", afterSeq: 2 });
		expect(s.state).toBe("ended");
		expect(s.result).toMatchObject({ outcome: "completed", summary: "1 role", engineAuth: "machine-login", findings: [{ title: "Dev" }], traceId: "run-1" });
		expect(s.events.map((e) => e.type)).toEqual(["policy.decision", "browser.navigated", "finding.parsed", "engine.ended"]);
		expect(browsersStopped).toBe(1);
	});

	it("says the CLI is not signed in, and how to fix it", async () => {
		const rt = runtime();
		rt.start(envelope({ engine: "codex" }));
		await settle();
		spawned[0].child.stdout.write("Error: not logged in. Run `codex login`\n");
		await settle();
		spawned[0].child.exit(1);
		expect(rt.status({ runId: "run-1" }).result).toMatchObject({ outcome: "failed", engineAuth: "missing_login", error: expect.stringMatching(/codex login/) });
	});

	it("says the CLI is not installed", async () => {
		const rt = runtime({ spawnError: Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }) });
		rt.start(envelope());
		await settle();
		expect(rt.status({ runId: "run-1" }).result).toMatchObject({ outcome: "failed", error: expect.stringMatching(/Claude Code CLI is not installed/) });
	});

	it("cancels: stops the engine and ends the run", async () => {
		const rt = runtime();
		rt.start(envelope());
		await settle();
		rt.cancel({ runId: "run-1" });
		expect(spawned[0].child.killed).toEqual(["SIGTERM"]);
		expect(rt.status({ runId: "run-1" }).result).toMatchObject({ outcome: "failed", error: "Cancelled by the owner" });
	});

	it("answers 404 for a run it does not hold — a restarted runner", () => {
		expect(() => runtime().status({ runId: "gone" })).toThrow(expect.objectContaining({ status: 404 }));
	});
});

describe("pauses", () => {
	it("waits for consent before using the signed-in profile, and starts once the owner allows it", async () => {
		const rt = runtime();
		rt.start(envelope({ browserProfile: "default" }));
		await settle();
		expect(spawned).toHaveLength(0);
		expect(rt.status({ runId: "run-1" })).toMatchObject({ state: "paused", pauseReason: "consent_required" });
		now += 60_000; // time waiting on the owner is not run time
		rt.resume({ runId: "run-1", consentedDomains: [], denyDomains: [], profileConsented: true });
		await settle();
		expect(spawned).toHaveLength(1);
		expect(rt.status({ runId: "run-1" }).events.map((e) => e.type)).toEqual(["consent.requested", "run.paused", "run.resumed", "policy.decision", "engine.auth_checked", "engine.started"]);
	});

	it("holds a navigation to a new site until resume, then lets it through", async () => {
		const rt = runtime();
		rt.start(envelope({ policy: { ...envelope().policy, allowDomains: [] } }));
		await settle();
		const call = rt.bridge({ runId: "run-1", op: "call", name: "browser_navigate", args: { url: "https://seek.com.au/jobs" } });
		await settle();
		expect(rt.status({ runId: "run-1" })).toMatchObject({ state: "paused", pauseReason: "consent_required" });
		rt.resume({ runId: "run-1", consentedDomains: ["seek.com.au"], denyDomains: [], profileConsented: false });
		expect(((await call) as { isError?: boolean }).isError).toBeUndefined();
		expect(rt.status({ runId: "run-1" }).state).toBe("running");
	});

	it("releases a held call as refused when the run is cancelled", async () => {
		const rt = runtime();
		rt.start(envelope({ policy: { ...envelope().policy, allowDomains: [] } }));
		await settle();
		const call = rt.bridge({ runId: "run-1", op: "call", name: "browser_navigate", args: { url: "https://indeed.com/" } });
		await settle();
		rt.cancel({ runId: "run-1" });
		expect(((await call) as { isError?: boolean }).isError).toBe(true);
	});
});

describe("retention", () => {
	it("removes an ended run's folder and record after the retention window, and keeps a live one", async () => {
		const rt = runtime({ retentionMs: 1000 });
		rt.start(envelope());
		rt.start(envelope({ runId: "run-live", requestId: "req-live", instanceId: "inst-2" }));
		await settle();
		spawned[0].child.exit(0);
		now += 5000;
		rt.sweep();
		expect(existsSync(join(dir, "local-browser", "inst-1", "run-1"))).toBe(false);
		expect(() => rt.status({ runId: "run-1" })).toThrow(/No local browser run/);
		expect(rt.status({ runId: "run-live" }).state).toBe("running");
	});
});
