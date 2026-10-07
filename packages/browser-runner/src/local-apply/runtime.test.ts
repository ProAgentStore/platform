/**
 * The application runtime (#957) through its real wiring — envelope, sources, artifact hashes,
 * engine env, bridge, pauses and the result — with only the CLI process and the browser faked.
 */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserTools } from "../local-browser/bridge.js";
import type { LocalApplyTaskEnvelope } from "./contract.js";
import { LocalApplyRuntime, parseApplyEnvelope } from "./runtime.js";

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

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const RESUME = "# Jane Citizen\nStaff engineer, 2019 - 2024\n";
const COVER = "Dear Globex,\nI would like to apply.\n";
const PROFILE = "Name: Jane Citizen\nEmail: jane@example.com\n";

let dir: string;
let home: string;
let spawned: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }>;
let child: FakeChild;
let clicks: string[];

const browser: BrowserTools = {
	listTools: async () => ["browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_evaluate"].map((name) => ({ name, inputSchema: {} })),
	callTool: async (name, args = {}) => {
		if (name === "browser_evaluate") {
			if (args.target) return { content: [{ text: `### Result\n${JSON.stringify({ submits: true, method: "post", name: "Submit application", tag: "button", type: "submit" })}` }] };
			return { content: [{ text: `### Result\n${JSON.stringify({ url: "https://jobs.example.com/apply", title: "Apply" })}` }] };
		}
		if (name === "browser_snapshot") return { content: [{ text: '- textbox "Full name" [ref=e1]\n- button "Submit application" [ref=e2]' }] };
		if (name === "browser_click") clicks.push(String(args.target));
		return { content: [{ text: `${name} ok` }] };
	},
};

function runtime() {
	return new LocalApplyRuntime({
		dataDir: join(dir, "data"),
		homeDir: home,
		selfUrl: () => "http://127.0.0.1:4999",
		bridgeScript: "/runner/bridge-stdio.js",
		browserFor: async () => ({ tools: browser, stop: async () => undefined }),
		spawn: ((command: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
			spawned.push({ command, args, env: opts.env });
			child = new FakeChild();
			return child;
		}) as never,
	});
}

function envelope(over: Partial<LocalApplyTaskEnvelope> = {}): LocalApplyTaskEnvelope {
	return {
		type: "local_browser.apply",
		runId: "run-1",
		requestId: "t1:lead-1:1:materials",
		instanceId: "runner-1",
		applicationId: "app-1",
		engine: "claude",
		authMode: "machine",
		browserProfile: "isolated",
		applicationUrl: "https://jobs.example.com/apply",
		job: { title: "Staff Engineer", company: "Globex" },
		workspace: "~/jobs",
		sources: [{ role: "profile", path: "profile.md" }],
		artifacts: [
			{ kind: "resume", path: "~/jobs/applications/lead-1/t-run/resume.md", sha256: sha(RESUME) },
			{ kind: "cover_letter", path: "~/jobs/applications/lead-1/t-run/cover-letter.md", sha256: sha(COVER) },
		],
		policy: { mode: "fill_and_review", allowDomains: ["jobs.example.com"] },
		limits: { maxMinutes: 20, maxPages: 30, maxActions: 300 },
		...over,
	};
}

const settle = () => new Promise((r) => setTimeout(r, 20));
const call = (rt: LocalApplyRuntime, name: string, args: Record<string, unknown> = {}) => rt.bridge({ runId: "run-1", op: "call", name, args }) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "local-apply-"));
	home = join(dir, "home");
	mkdirSync(join(home, "jobs/applications/lead-1/t-run"), { recursive: true });
	writeFileSync(join(home, "jobs/profile.md"), PROFILE);
	writeFileSync(join(home, "jobs/applications/lead-1/t-run/resume.md"), RESUME);
	writeFileSync(join(home, "jobs/applications/lead-1/t-run/cover-letter.md"), COVER);
	spawned = [];
	clicks = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("parseApplyEnvelope", () => {
	it.each([
		["a provider API key mode", { authMode: "api-key" }, /authMode/],
		["auto_submit without the PAGS gate", { policy: { mode: "auto_submit", allowDomains: ["jobs.example.com"] } }, /submitGate/],
		["no allowed site", { policy: { mode: "fill_and_review", allowDomains: [] } }, /allowDomains/],
		["an artifact outside home", { artifacts: [{ kind: "resume", path: "/etc/passwd", sha256: "a".repeat(64) }] }, /artifact/],
		["a source in applications/", { sources: [{ role: "profile", path: "applications/x.md" }] }, /source/],
	])("refuses %s", (_label, over, msg) => {
		expect(() => parseApplyEnvelope({ ...envelope(), ...over })).toThrow(msg as RegExp);
	});
	it("drops a gate sent with fill_and_review — the mode decides, not a stray field", () => {
		const e = parseApplyEnvelope({ ...envelope(), policy: { mode: "fill_and_review", allowDomains: ["jobs.example.com"], submitGate: { gateId: "g" } } });
		expect(e.policy.submitGate).toBeUndefined();
	});
});

describe("a fill-and-review run, end to end on the runner", () => {
	it("fills, refuses the submit, and ends awaiting_review — the click never reaches the page", async () => {
		const prev = { a: process.env.ANTHROPIC_API_KEY, o: process.env.OPENAI_API_KEY, t: process.env.CLAUDE_CODE_OAUTH_TOKEN };
		process.env.ANTHROPIC_API_KEY = "sk-ant-should-never-reach-the-cli-0000000000";
		process.env.OPENAI_API_KEY = "sk-openai-should-never-reach-the-cli-000000";
		process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-should-not-reach-in-machine-mode";
		try {
			const rt = runtime();
			expect(rt.start(envelope())).toMatchObject({ runId: "run-1", existing: false });
			await settle();
			expect(spawned).toHaveLength(1);
			for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) expect(spawned[0].env[k]).toBeUndefined();
			// The CLI's prompt carries the owner's own sources, for it to quote.
			expect(spawned[0].args.join(" ")).toContain("Email: jane@example.com");

			await call(rt, "browser_navigate", { url: "https://jobs.example.com/apply" });
			await call(rt, "browser_snapshot");
			expect((await call(rt, "browser_type", { target: "e1", text: "Jane Citizen", source_quote: "Name: Jane Citizen" })).isError).toBeFalsy();
			// Grounded in the approved résumé, too.
			expect((await call(rt, "browser_type", { target: "e1", text: "Staff engineer", source_quote: "Staff engineer, 2019 - 2024" })).isError).toBeFalsy();
			const sub = await call(rt, "browser_click", { target: "e2" });
			expect(sub.content[0].text).toMatch(/NOT pressed/);
			expect(clicks).toEqual([]);
			child.exit(0);

			const st = rt.status({ runId: "run-1" });
			expect(st.state).toBe("ended");
			expect(st.result).toMatchObject({ outcome: "awaiting_review", mode: "fill_and_review", engineAuth: "machine-login", filled: 2, submitAttempted: false });
			expect(st.events.map((e) => e.type)).toEqual(expect.arrayContaining(["source.read", "engine.auth_checked", "engine.started", "field.filled", "policy.decision", "review.ready", "engine.ended"]));
			expect(JSON.stringify(st.events)).not.toContain("Jane Citizen");
		} finally {
			for (const [k, v] of [["ANTHROPIC_API_KEY", prev.a], ["OPENAI_API_KEY", prev.o], ["CLAUDE_CODE_OAUTH_TOKEN", prev.t]] as const) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	});

	it("a replayed start is the same run: one CLI, one fill", async () => {
		const rt = runtime();
		rt.start(envelope());
		expect(rt.start({ ...envelope(), runId: "run-2" })).toMatchObject({ runId: "run-1", existing: true });
		await settle();
		expect(spawned).toHaveLength(1);
		// …and a different application for the same agent waits its turn.
		expect(() => rt.start({ ...envelope(), runId: "run-3", requestId: "other" })).toThrow(/one at a time/);
	});

	it("only the run's own token reaches its bridge", async () => {
		const rt = runtime();
		rt.start(envelope());
		await settle();
		expect(rt.authorizeBridge("run-1", "nope")).toBe(false);
		const mcp = readFileSync(join(dir, "data/local-apply/runner-1/run-1/mcp.json"), "utf8");
		const token = mcp.match(/"PAGS_BRIDGE_TOKEN":"([a-f0-9]+)"/)?.[1] ?? "";
		expect(token).not.toBe("");
		expect(rt.authorizeBridge("run-1", token)).toBe(true);
	});

	it("pauses for a missing answer, carries the question on status, and grounds the owner's answer after resume", async () => {
		const rt = runtime();
		rt.start(envelope());
		await settle();
		await call(rt, "browser_navigate", { url: "https://jobs.example.com/apply" });
		await call(rt, "browser_snapshot");
		const asked = call(rt, "request_answer", { question: "Expected salary?" });
		await settle();
		expect(rt.status({ runId: "run-1" })).toMatchObject({ state: "paused", pause: { reason: "missing_answer", question: "Expected salary?" } });
		// While it waits, nothing else reaches the page — a CLI that gave up on its own call is told to stop.
		expect((await call(rt, "browser_type", { target: "e1", text: "Jane Citizen", source_quote: "Name: Jane Citizen" })).content[0].text).toMatch(/paused for the owner/);
		rt.resume({ runId: "run-1", answers: [{ question: "Expected salary?", answer: "150000 AUD" }] });
		expect((await asked).isError).toBeFalsy();
		expect((await call(rt, "browser_type", { target: "e1", text: "150000 AUD", source_quote: "A: 150000 AUD" })).isError).toBeFalsy();
	});

	it("a cancel while paused ends the run failed and releases the waiting call", async () => {
		const rt = runtime();
		rt.start(envelope());
		await settle();
		const asked = call(rt, "request_answer", { question: "Expected salary?" });
		await settle();
		rt.cancel({ runId: "run-1" });
		await asked;
		expect(rt.status({ runId: "run-1" }).result).toMatchObject({ outcome: "failed", error: "Cancelled by the owner" });
	});
});

describe("pauses before the CLI starts — nothing is guessed past", () => {
	it("a changed artifact blocks the run and nothing is spawned", async () => {
		writeFileSync(join(home, "jobs/applications/lead-1/t-run/resume.md"), `${RESUME}edited\n`);
		const rt = runtime();
		rt.start(envelope());
		await settle();
		expect(spawned).toHaveLength(0);
		expect(rt.status({ runId: "run-1" }).result).toMatchObject({ outcome: "blocked", blockReason: "artifact_changed" });
	});

	it("a missing profile blocks the run with the question", async () => {
		rmSync(join(home, "jobs/profile.md"));
		const rt = runtime();
		rt.start(envelope());
		await settle();
		expect(spawned).toHaveLength(0);
		const r = rt.status({ runId: "run-1" }).result;
		expect(r).toMatchObject({ outcome: "blocked", blockReason: "source_unavailable" });
		expect(r?.questions?.[0]).toMatch(/profile/);
	});

	it("a CLI that is not signed in ends blocked, naming the fix", async () => {
		const rt = runtime();
		rt.start(envelope());
		await settle();
		child.stdout.write("Not logged in · Please run /login\n");
		await settle();
		child.exit(1);
		expect(rt.status({ runId: "run-1" }).result).toMatchObject({ outcome: "blocked", blockReason: "engine_not_signed_in", engineAuth: "missing_login" });
	});
});
