/**
 * #896 — `pags up --replace`: an explicit, graceful takeover that refuses to destroy work.
 *
 * What this replaces: `pkill -f` on three name patterns, on EVERY `pags up`. Since the local
 * runtimes shipped, that ended real work on every start — a Codex or Grok turn, a browser research
 * run, a tailoring run, an application fill — and told the owner nothing until the cloud gave up on
 * it minutes later. So the rule here is that a replace is asked for, is refused while anything is
 * live unless the owner says `--now`, and never escalates to a signal by itself.
 */
import { describe, expect, it, vi } from "vitest";
import type { RunnerLockFile } from "./runner-lock.js";
import { describeWork, hasWork, holderWork, replaceHolder, replaceVerdict } from "./runner-replace.js";

const LOCK = (over: Partial<RunnerLockFile> = {}): RunnerLockFile => ({
	v: 1,
	rsid: "rsid-A",
	pid: 4121,
	pidStartedAt: "Wed Oct  1 09:12:03 2026",
	startedAt: Date.parse("2026-10-01T09:12:03Z"),
	port: 49171,
	node: "pink-laptop",
	machineId: "m-pink",
	account: "serge-ivo",
	version: "0.4.88",
	launch: "tty",
	launchDetail: "ttys003",
	childPids: [],
	nonce: "nonce-A",
	heartbeatAt: Date.now(),
	...over,
});
const WORK = { codingTurns: 1, localRuns: 1, detail: ["a Codex turn (lost on a restart)", "a browser research run (cb4c349c)"] };

describe("whether a replace may proceed (#896)", () => {
	it("an IDLE holder may be replaced", () => {
		expect(replaceVerdict(LOCK(), { codingTurns: 0, localRuns: 0, detail: [] }, {})).toMatchObject({ allowed: true });
		// A holder too old to report its work answers nothing, and is replaceable.
		expect(replaceVerdict(LOCK(), null, {})).toMatchObject({ allowed: true });
	});

	it("REFUSES while work is live, and says exactly what would be lost (Q4)", () => {
		const v = replaceVerdict(LOCK(), WORK, {});
		expect(v.allowed).toBe(false);
		const said = v.lines.join(" ");
		expect(said).toMatch(/a Codex turn \(lost on a restart\), a browser research run \(cb4c349c\)/);
		expect(said).toMatch(/do not survive a restart/);
		expect(said).toMatch(/pags up --replace --now/);
	});

	it("--now is the owner saying it anyway", () => {
		expect(replaceVerdict(LOCK(), WORK, { now: true })).toMatchObject({ allowed: true });
	});

	it("REFUSES against a service runner, because the unit would just restart it (Q2)", () => {
		const v = replaceVerdict(LOCK({ launch: "service", launchDetail: "com.pags.runner" }), { codingTurns: 0, localRuns: 0, detail: [] }, { now: true });
		expect(v.allowed, "even --now does not win against a service").toBe(false);
		expect(v.lines.join(" ")).toMatch(/com\.pags\.runner/);
		expect(v.lines.join(" ")).toMatch(/Stop its launchd\/systemd unit/);
	});

	it("counts and names work without inventing any", () => {
		expect(hasWork(null)).toBe(false);
		expect(hasWork({ codingTurns: 0, localRuns: 0, detail: [] })).toBe(false);
		expect(hasWork({ codingTurns: 0, localRuns: 1, detail: [] })).toBe(true);
		// With no detail from the holder, the counts are described instead.
		expect(describeWork({ codingTurns: 2, localRuns: 1, detail: [] })).toBe("2 coding turns, 1 local run");
		expect(describeWork({ codingTurns: 1, localRuns: 0, detail: [] })).toBe("1 coding turn");
	});
});

describe("asking the holder to stop", () => {
	const deps = (over: Partial<Parameters<typeof replaceHolder>[2]> = {}) => ({ sleep: async () => undefined, now: () => Date.now(), ...over });

	it("quotes the lock's nonce — the holder stops for nobody else", async () => {
		const calls: Array<{ url: string; body: unknown }> = [];
		const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
			if (String(url).endsWith("/health")) return new Response(JSON.stringify({ work: { codingTurns: 0, localRuns: 0, detail: [] } }), { status: 200 });
			return new Response(JSON.stringify({ stopping: true }), { status: 202 });
		}) as unknown as typeof fetch;
		let alive = true;
		const out = await replaceHolder(LOCK(), {}, deps({ fetchImpl, alive: () => { const was = alive; alive = false; return was; } }));
		expect(out.ok).toBe(true);
		expect(out.lines.join(" ")).toMatch(/Replaced the `pags up` on pid 4121/);
		const shutdown = calls.find((c) => c.url.endsWith("/control/shutdown"));
		expect(shutdown?.url).toBe("http://127.0.0.1:49171/control/shutdown");
		expect(shutdown?.body).toMatchObject({ nonce: "nonce-A", reason: "replaced" });
	});

	it("never contacts the holder at all when the verdict refuses", async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ work: WORK }), { status: 200 })) as unknown as typeof fetch;
		const out = await replaceHolder(LOCK(), {}, deps({ fetchImpl }));
		expect(out.ok).toBe(false);
		// One call: the /health that found the work. No shutdown was asked for.
		expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
	});

	it("reports a holder that will not go, and does NOT kill it", async () => {
		// The issue's rule 6: no automatic kill of another user process, ever.
		let t = 0;
		const fetchImpl = vi.fn(async (url: string | URL | Request) =>
			String(url).endsWith("/health") ? new Response(JSON.stringify({ work: { codingTurns: 0, localRuns: 0, detail: [] } }), { status: 200 }) : new Response("{}", { status: 202 }),
		) as unknown as typeof fetch;
		const out = await replaceHolder(LOCK(), {}, deps({ fetchImpl, alive: () => true, now: () => (t += 5_000) }));
		expect(out.ok).toBe(false);
		expect(out.lines.join(" ")).toMatch(/still running after 30s/);
		expect(out.lines.join(" ")).toMatch(/will not kill it for you/);
	});

	it("says so when the holder refuses the request, or cannot be reached", async () => {
		const refuse = vi.fn(async (url: string | URL | Request) =>
			String(url).endsWith("/health") ? new Response(JSON.stringify({ work: { codingTurns: 0, localRuns: 0, detail: [] } }), { status: 200 }) : new Response("no", { status: 403 }),
		) as unknown as typeof fetch;
		expect((await replaceHolder(LOCK(), {}, deps({ fetchImpl: refuse }))).lines.join(" ")).toMatch(/refused the stop request \(HTTP 403\)/);

		const broken = vi.fn(async (url: string | URL | Request) => {
			if (String(url).endsWith("/health")) return new Response("{}", { status: 500 });
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		expect((await replaceHolder(LOCK(), {}, deps({ fetchImpl: broken }))).lines.join(" ")).toMatch(/could not be asked to stop: ECONNREFUSED/);
	});

	it("refuses when the lock records no port — there is nothing to ask", async () => {
		const out = await replaceHolder(LOCK({ port: null }), {}, deps());
		expect(out.ok).toBe(false);
		expect(out.lines.join(" ")).toMatch(/does not say which port/);
	});

	it("reads the holder's work from its own /health, and tolerates an old one", async () => {
		const ok = vi.fn(async () => new Response(JSON.stringify({ work: { codingTurns: 2, localRuns: 1, detail: ["a Codex turn"] } }), { status: 200 })) as unknown as typeof fetch;
		expect(await holderWork(LOCK(), { fetchImpl: ok })).toEqual({ codingTurns: 2, localRuns: 1, detail: ["a Codex turn"] });
		// A /health with no `work` block is a CLI that predates this — reported as unknown, not zero.
		const old = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
		expect(await holderWork(LOCK(), { fetchImpl: old })).toBeNull();
		// Junk counts are ignored rather than rendered.
		const junk = vi.fn(async () => new Response(JSON.stringify({ work: { codingTurns: -4, localRuns: "many", detail: [1, "a run"] } }), { status: 200 })) as unknown as typeof fetch;
		expect(await holderWork(LOCK(), { fetchImpl: junk })).toEqual({ codingTurns: 0, localRuns: 0, detail: ["a run"] });
	});
});
