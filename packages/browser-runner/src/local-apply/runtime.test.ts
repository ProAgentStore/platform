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
let pageUnavailable: "expired" | "unavailable" | null;
/**
 * The live SEEK shape (#989), when a test asks for it: a job AD whose only control is the one that
 * OPENS the application, and which reveals the form once that control is pressed. `null` keeps the
 * plain single-page form every other test here uses.
 */
let seek: "ad" | "form" | null;
const SEEK_AD = "https://au.seek.com/job/94991284";
const SEEK_FORM = "https://au.seek.com/job/94991284/apply";

const browser: BrowserTools = {
	listTools: async () => ["browser_navigate", "browser_snapshot", "browser_click", "browser_type", "browser_evaluate"].map((name) => ({ name, inputSchema: {} })),
	callTool: async (name, args = {}) => {
		if (name === "browser_evaluate") {
			if (args.target === "a1") return { content: [{ text: `### Result\n${JSON.stringify({ submits: false, method: "", name: "Apply", tag: "a", type: "" })}` }] };
			if (args.target) return { content: [{ text: `### Result\n${JSON.stringify({ submits: true, method: "post", name: "Submit application", tag: "button", type: "submit" })}` }] };
			const url = seek === "ad" ? SEEK_AD : seek === "form" ? SEEK_FORM : "https://jobs.example.com/apply";
			return { content: [{ text: `### Result\n${JSON.stringify({ url, title: "Apply", ...(pageUnavailable ? { unavailable: pageUnavailable } : {}) })}` }] };
		}
		if (name === "browser_snapshot") return { content: [{ text: seek === "ad" ? '- link "Apply" [ref=a1]' : '- textbox "Full name" [ref=e1]\n- button "Submit application" [ref=e2]' }] };
		if (name === "browser_click") {
			clicks.push(String(args.target));
			// Pressing the ad's Apply control is what puts the form on the screen.
			if (args.target === "a1" && seek === "ad") seek = "form";
		}
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
async function approve(rt: LocalApplyRuntime, checkpointId = "initial:1", phase = "initial") {
	const checkpoint = call(rt, "supervisor_checkpoint", { checkpointId, phase });
	await settle();
	rt.directive({ runId: "run-1", schemaVersion: 1, checkpointId, directive: "continue" });
	return checkpoint;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "local-apply-"));
	home = join(dir, "home");
	mkdirSync(join(home, "jobs/applications/lead-1/t-run"), { recursive: true });
	writeFileSync(join(home, "jobs/profile.md"), PROFILE);
	writeFileSync(join(home, "jobs/applications/lead-1/t-run/resume.md"), RESUME);
	writeFileSync(join(home, "jobs/applications/lead-1/t-run/cover-letter.md"), COVER);
	spawned = [];
	clicks = [];
	pageUnavailable = null;
	seek = null;
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
			await approve(rt);
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
		await approve(rt, "after-answer:1", "uncertain");
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

	it("serves a terminal typed result after the runner process restarts", async () => {
		const first = runtime();
		first.start(envelope());
		await settle();
		// A terminal result is written before the old process can disappear.
		first.cancel({ runId: "run-1" });
		const before = first.status({ runId: "run-1" });
		const restarted = runtime();
		expect(restarted.status({ runId: "run-1" })).toMatchObject({
			state: "ended",
			lastSeq: before.lastSeq,
			result: { runId: "run-1", outcome: "failed", error: "Cancelled by the owner" },
		});
		// The recovered terminal run still protects the request id from a duplicate start.
		expect(restarted.start(envelope())).toMatchObject({ existing: true, status: "ended" });
	});

	it("waits at a typed supervisor checkpoint until its persisted continue directive, never an owner resume", async () => {
		const rt = runtime();
		rt.start(envelope());
		await settle();
		const checkpoint = call(rt, "supervisor_checkpoint", { checkpointId: "before-submit:1", phase: "before_submit" });
		await settle();
		expect(rt.status({ runId: "run-1" })).toMatchObject({
			state: "paused",
			pause: { reason: "supervisor_checkpoint", checkpoint: { schemaVersion: 1, checkpointId: "before-submit:1", facts: { phase: "before_submit", actions: 0, filled: 0, uploaded: 0, blockers: [] } } },
		});
		expect(() => rt.resume({ runId: "run-1" })).toThrow(/persisted supervisor directive/);
		const released = rt.directive({ runId: "run-1", schemaVersion: 1, checkpointId: "before-submit:1", directive: "continue" });
		expect(released.state).toBe("running");
		expect((await checkpoint).content[0].text).toMatch(/persisted supervisor directive is continue/);
		expect(rt.status({ runId: "run-1" }).events).toEqual(expect.arrayContaining([
			expect.objectContaining({ type: "supervisor.checkpoint", detail: expect.objectContaining({ checkpointId: "before-submit:1", phase: "before_submit" }) }),
			expect.objectContaining({ type: "supervisor.directive", detail: { checkpointId: "before-submit:1", directive: "continue" } }),
		]));
	});

	it("records a directive idempotently before a checkpoint arrives, and refuses a conflicting replay", async () => {
		const rt = runtime();
		rt.start(envelope());
		await settle();
		rt.directive({ runId: "run-1", schemaVersion: 1, checkpointId: "after-profile", directive: "continue" });
		expect((await call(rt, "supervisor_checkpoint", { checkpointId: "after-profile", phase: "initial" })).content[0].text).toMatch(/directive is continue/);
		expect(rt.directive({ runId: "run-1", schemaVersion: 1, checkpointId: "after-profile", directive: "continue" }).state).toBe("running");
		expect(() => rt.directive({ runId: "run-1", schemaVersion: 1, checkpointId: "after-profile", directive: "stop" })).toThrow(/different directive/);
	});

	it.each(["request_review", "stop"] as const)("terminally resolves a persisted %s directive without trusting the CLI", async (directive) => {
		const rt = runtime();
		rt.start(envelope());
		await settle();
		const checkpoint = call(rt, "supervisor_checkpoint", { checkpointId: "final-check", phase: "uncertain" });
		await settle();
		const status = rt.directive({ runId: "run-1", schemaVersion: 1, checkpointId: "final-check", directive });
		expect(status).toMatchObject({ state: "ended", result: directive === "request_review" ? { outcome: "awaiting_review" } : { outcome: "blocked", blockReason: "incomplete" } });
		expect((await checkpoint).isError).toBe(true);
	});

	it("ends blocked with runner-verified evidence when the CLI reports an expired listing", async () => {
		pageUnavailable = "expired";
		const rt = runtime();
		rt.start(envelope());
		await settle();
		await call(rt, "browser_navigate", { url: "https://jobs.example.com/apply" });
		await call(rt, "browser_snapshot");
		expect((await call(rt, "report_job_unavailable", { reason: "expired" })).isError).toBeFalsy();
		child.exit(0);
		const status = rt.status({ runId: "run-1" });
		expect(status.result).toMatchObject({ outcome: "blocked", blockReason: "job_unavailable", unavailable: { reason: "expired", url: "https://jobs.example.com/apply", source: "page_notice" } });
		expect(status.events.map((e) => e.type)).toContain("job.unavailable");
	});
});

/**
 * #989 — the live sequence, through the real runtime.
 *
 * Post-#985 production run `64ed66de…` on `au.seek.com/job/94991284`: the runner reported its
 * `initial` checkpoint, the cloud's policy decided `continue`, the directive was delivered and
 * acknowledged, the CLI resumed — and two seconds later recorded
 * `browser_click → class: submit → refused: fill_and_review`, then `review.ready {count: 0}`, and
 * ended `awaiting_review` having typed nothing. The machine was running CLI 0.4.84, whose bundled
 * bridge predates #985 (that commit never bumped `packages/cli`, so nothing was published), and
 * `LOCAL_APPLY_CONTRACT_MIN_CLI` now refuses it — but the behaviour the published runner will
 * carry is the one asserted here, end to end.
 */
describe("the live SEEK sequence: the entry Apply opens the form, the final submit stays refused (#989)", () => {
	const seekEnvelope = () => envelope({ applicationUrl: SEEK_AD, policy: { mode: "fill_and_review", allowDomains: ["au.seek.com"] } });

	it("initial checkpoint → continue → entry Apply → the form fills → the submit is refused", async () => {
		seek = "ad";
		const rt = runtime();
		rt.start(seekEnvelope());
		await settle();
		await call(rt, "browser_navigate", { url: SEEK_AD });
		await call(rt, "browser_snapshot");
		// The cloud's own decision at the initial checkpoint, exactly as #982/#985 deliver it.
		await approve(rt, "seek-94991284-initial", "initial");

		// THE PRESS THAT ENDED THE LIVE RUNS. It reaches the page now.
		const entry = await call(rt, "browser_click", { target: "a1" });
		expect(entry.isError).toBeFalsy();
		expect(clicks).toEqual(["a1"]);

		// The form is on screen, and it gets its OWN checkpoint: the approval was spent by the move.
		await call(rt, "browser_snapshot");
		const early = await call(rt, "browser_type", { target: "e1", text: "Jane Citizen", source_quote: "Name: Jane Citizen" });
		expect(early.isError).toBe(true);
		expect(early.content[0].text).toMatch(/supervisor_checkpoint must return continue/);
		await approve(rt, "seek-94991284-form", "post_navigation");

		// Field work — the capability the live runs never got to use.
		expect((await call(rt, "browser_type", { target: "e1", text: "Jane Citizen", source_quote: "Name: Jane Citizen" })).isError).toBeFalsy();

		// And the FINAL submit is still never pressed under fill_and_review.
		const sub = await call(rt, "browser_click", { target: "e2" });
		expect(sub.content[0].text).toMatch(/NOT pressed/);
		expect(clicks).toEqual(["a1"]);
		child.exit(0);

		const st = rt.status({ runId: "run-1" });
		expect(st.result).toMatchObject({ outcome: "awaiting_review", mode: "fill_and_review", filled: 1, submitAttempted: false });
		const entryDecision = st.events.find((e) => e.type === "policy.decision" && e.detail?.class === "entry");
		expect(entryDecision?.detail).toMatchObject({ tool: "browser_click", decision: "allowed", reason: "entry_label_nothing_filled" });
		// The refusal that follows is the real one, and it names the rule that classified it.
		expect(st.events.find((e) => e.type === "policy.decision" && e.detail?.class === "submit")?.detail).toMatchObject({ decision: "refused", reason: "fill_and_review", rule: "terminal_label" });
		expect(st.events.some((e) => e.type === "submit.attempted")).toBe(false);
		// Observable progress, which is what the issue asks the live repeat to show.
		expect(st.events.some((e) => e.type === "field.filled")).toBe(true);
		expect(JSON.stringify(st.events)).not.toContain("Jane Citizen");
	});

	it("a submit-class control refused with NOTHING entered ends blocked — never review-ready with count 0", async () => {
		seek = "form";
		const rt = runtime();
		rt.start(seekEnvelope());
		await settle();
		await call(rt, "browser_navigate", { url: SEEK_FORM });
		await call(rt, "browser_snapshot");
		await approve(rt, "seek-94991284-initial", "initial");

		// Nothing typed, and the control that submits is pressed: the live shape of the defect.
		const sub = await call(rt, "browser_click", { target: "e2" });
		expect(sub.content[0].text).toMatch(/NOT pressed/);
		expect(clicks).toEqual([]);
		// The CLI then tries to report a review anyway. It is declined: there is no form to review.
		const review = await call(rt, "ready_for_review", { summary: "Stopped at the submit." });
		expect(review.isError).toBe(true);
		expect(review.content[0].text).toMatch(/nothing to review/);
		child.exit(0);

		const st = rt.status({ runId: "run-1" });
		expect(st.result).toMatchObject({ outcome: "blocked", blockReason: "incomplete", filled: 0, uploaded: [], submitAttempted: false });
		expect((st.result as { questions?: string[] }).questions?.[0]).toMatch(/Approve this application|open it yourself/);
		expect(st.events.some((e) => e.type === "review.ready")).toBe(false);
		expect(st.events.find((e) => e.type === "policy.decision" && e.detail?.tool === "ready_for_review")?.detail).toMatchObject({ decision: "refused", reason: "incomplete" });
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

// ── #975: a CLI that puts nothing on the page says so, and a healthy run of EITHER engine
// walks the whole path ────────────────────────────────────────────────────────────────────────
//
// The production case: the CLI authenticated, exited 0 after ~51s, and emitted no browser,
// checkpoint, fill or review event. `incomplete` is also what a half-filled form reports, so the
// operator could not tell "it did nothing" from "it stopped partway" — and nothing said why.
describe("a CLI that never touches the browser bridge is diagnosed, not called `incomplete` (#975)", () => {
	const resultOf = (rt: LocalApplyRuntime) => rt.status({ runId: "run-1" }).result;

	it("exit 0 with zero bridge calls: a distinct reason, the counts that prove it, and nothing submitted", async () => {
		const rt = runtime();
		rt.start(envelope());
		await settle();
		// The CLI talks, and never calls a single bridge tool — the exact production shape.
		child.stdout.write(`${JSON.stringify({ type: "result", result: "I reviewed the materials." })}\n`);
		await settle();
		child.exit(0);

		const r = resultOf(rt);
		expect(r).toMatchObject({ outcome: "blocked", blockReason: "bridge_unused", submitAttempted: false, filled: 0 });
		expect(r?.diagnostic).toMatchObject({ cause: "bridge_unused", bridgeCalls: 0, engineExit: 0, pages: 0, filled: 0 });
		// Actionable: the question names what to do, not just that it failed.
		expect(r?.questions?.[0]).toMatch(/without opening the application page|declined the task/);
	});

	it("names the approval policy that refused the tools — #952's failure, invisible from the cloud", async () => {
		const rt = runtime();
		rt.start(envelope());
		await settle();
		child.stdout.write("the browser bridge required approval, but this session's approval policy is `never`\n");
		await settle();
		child.exit(0);
		const r = resultOf(rt);
		expect(r?.diagnostic?.signals).toContain("approval_policy_blocked");
		expect(r?.questions?.[0]).toMatch(/approval policy refused/);
	});

	it("a CLI that printed nothing at all is a different cause from one that talked", async () => {
		const rt = runtime();
		rt.start(envelope());
		await settle();
		child.exit(0);
		expect(resultOf(rt)?.diagnostic).toMatchObject({ cause: "no_engine_output", signals: expect.arrayContaining(["no_output"]) });
	});

	it("a non-zero exit is reported as such, with the code", async () => {
		const rt = runtime();
		rt.start(envelope());
		await settle();
		child.stdout.write(`${JSON.stringify({ type: "result", result: "giving up" })}\n`);
		await settle();
		child.exit(3);
		expect(resultOf(rt)?.diagnostic).toMatchObject({ cause: "engine_exited_nonzero", engineExit: 3 });
	});

	it("the diagnostic carries NO prose from the CLI — only ids, codes and counts", async () => {
		const rt = runtime();
		rt.start(envelope());
		await settle();
		// Everything a CLI legitimately prints while it works: the owner's résumé, their answers,
		// a cookie and a key. None of it may appear in the diagnostic.
		child.stdout.write(`${JSON.stringify({ type: "result", result: "Filled Jane Citizen, sk-ant-0000000000000000000000000000000000000000, session=abc123" })}\n`);
		child.stdout.write("Dear Globex, I would like to apply. Expected salary: 180000\n");
		await settle();
		child.exit(0);
		const d = JSON.stringify(resultOf(rt)?.diagnostic ?? {});
		for (const secret of ["Jane Citizen", "sk-ant-", "session=abc123", "Dear Globex", "180000"]) expect(d, secret).not.toContain(secret);
		// Only the closed vocabulary.
		expect(Object.keys(JSON.parse(d)).sort()).toEqual(["activeMs", "bridgeCalls", "cause", "engineExit", "filled", "pages", "signals"]);
	});
});

describe.each([["claude"], ["codex"]] as const)("%s: a connected-runner application walks the whole path (#975)", (engine) => {
	it("launches the bridge, checkpoints, fills, pauses, and submits only when authorized", async () => {
		const rt = runtime();
		// auto_submit with the PAGS gate is what an owner-approved application (#973) dispatches as.
		rt.start(envelope({ engine, policy: { mode: "auto_submit", allowDomains: ["jobs.example.com"], submitGate: { gateId: "gate-1" } } }));
		await settle();

		// 1. BRIDGE LAUNCH — the CLI is spawned for this engine with the bridge wired in.
		expect(spawned).toHaveLength(1);
		expect(spawned[0].command).toContain(engine);
		// The two engines take the bridge differently and both must actually get it: Claude through a
		// strict MCP config file, Codex through `-c mcp_servers.…` flags (there is no file).
		if (engine === "claude") expect(readFileSync(join(dir, "data/local-apply/runner-1/run-1/mcp.json"), "utf8")).toContain("PAGS_BRIDGE_TOKEN");
		else expect(spawned[0].args.join(" ")).toMatch(/mcp_servers\..*\.command=/);

		// 2. CHECKPOINT — the page is admitted only after the cloud supervisor releases it.
		await call(rt, "browser_navigate", { url: "https://jobs.example.com/apply" });
		await call(rt, "browser_snapshot");
		const blockedFill = await call(rt, "browser_type", { target: "e1", text: "Jane Citizen", source_quote: "Name: Jane Citizen" });
		expect(blockedFill.isError, "a fill before the checkpoint is refused").toBeTruthy();
		await approve(rt);

		// 3. FIELD FILL — grounded in the owner's own approved source.
		expect((await call(rt, "browser_type", { target: "e1", text: "Jane Citizen", source_quote: "Name: Jane Citizen" })).isError).toBeFalsy();

		// 4. PAUSE — a value the CLI does not have stops the run and asks, rather than inventing one.
		const asked = call(rt, "request_answer", { question: "Expected salary?" });
		await settle();
		expect(rt.status({ runId: "run-1" }).pause).toMatchObject({ reason: "missing_answer" });
		rt.resume({ runId: "run-1", answers: [{ question: "Expected salary?", answer: "Market rate" }] });
		// The answer becomes a SOURCE the CLI must quote; it is deliberately not echoed back to it.
		expect((await asked).content[0].text).toMatch(/owner answered/);

		// 5. AUTHORIZED SUBMIT — the gate the cloud issued is what lets the click through.
		await approve(rt, "before-submit:1", "before_submit");
		const submit = await call(rt, "browser_click", { target: "e2" });
		// The gate let it through and it REACHED THE PAGE — which under fill_and_review is refused
		// outright (the other test in this file asserts that). The fake site shows no confirmation
		// page, so the runner correctly reports it as pressed-but-unconfirmed and stops: a submit is
		// recorded as attempted, never as succeeded on the runner's word alone.
		expect(submit.content[0]?.text).toMatch(/pressed/);
		expect(clicks, "the authorized submit actually reached the page").toContain("e2");
		child.exit(0);

		const st = rt.status({ runId: "run-1" });
		expect(st.state).toBe("ended");
		expect(st.result, "the submit is recorded as attempted, not as confirmed").toMatchObject({ submitAttempted: true, blockReason: "submit_unconfirmed" });
		expect(st.result?.blockReason, "a run that used the bridge is never bridge_unused").not.toBe("bridge_unused");
		// #994: a pressed submit that remains unconfirmed is a distinct, actionable diagnostic. Its
		// evidence is ids only — the fake page's contents do not cross the runner contract.
		expect(st.result?.diagnostic).toMatchObject({
			cause: "submit_unconfirmed",
			signals: expect.arrayContaining(["confirmation_no_marker", "confirmation_url_unchanged"]),
		});
		expect(st.result?.filled).toBeGreaterThan(0);
		expect(st.events.map((e) => e.type)).toEqual(
			expect.arrayContaining(["engine.started", "browser.navigated", "supervisor.checkpoint", "field.filled", "run.paused", "submit.attempted"]),
		);
		// The owner's own values never enter the trace, whichever engine ran.
		expect(JSON.stringify(st.events)).not.toContain("Jane Citizen");
		expect(JSON.stringify(st.events)).not.toContain("Market rate");
	});

	// The sixth phase is its own run: reporting an unavailable listing ENDS the application, so it
	// cannot be reached in the same run as a submit — and the runner believes it only after seeing
	// the page's own notice itself.
	it("ends as job_unavailable when the page's own notice says the listing is gone — and never submits", async () => {
		const rt = runtime();
		rt.start(envelope({ engine, policy: { mode: "auto_submit", allowDomains: ["jobs.example.com"], submitGate: { gateId: "gate-1" } } }));
		await settle();
		pageUnavailable = "expired";
		await call(rt, "browser_navigate", { url: "https://jobs.example.com/apply" });
		await call(rt, "browser_snapshot");
		const notice = await call(rt, "report_job_unavailable", { reason: "expired", quote: "This job is no longer advertised" });
		expect(notice.isError, `report_job_unavailable: ${notice.content[0]?.text}`).toBeFalsy();
		child.exit(0);

		const st = rt.status({ runId: "run-1" });
		expect(st.result).toMatchObject({ outcome: "blocked", blockReason: "job_unavailable", submitAttempted: false });
		// It used the bridge, so it is NOT the #975 "did nothing" case.
		expect(st.result?.blockReason).not.toBe("bridge_unused");
		expect(st.events.map((e) => e.type)).toEqual(expect.arrayContaining(["browser.navigated", "job.unavailable"]));
		expect(clicks).toEqual([]);
	});
});
