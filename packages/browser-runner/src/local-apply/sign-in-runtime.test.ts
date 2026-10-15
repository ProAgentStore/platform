/**
 * #1100 — a sign-in in the application profile with NO run. The browser and its page are fakes (what
 * the runtime asks of them is the fact under test); the sign-in ledger is the real #1094 one on disk,
 * because "the next fill's session gate passes" is the outcome this exists for.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunBrowser } from "./runtime.js";
import { LocalApplySignInRuntime } from "./sign-in-runtime.js";
import { type SessionCookie, SiteSessionLedger } from "./site-session.js";

const JOB = "https://www.seek.com.au/job/88001234";
const request = (over: Record<string, unknown> = {}) => ({ signInId: "sign-in-30532b43", browserProfile: "isolated", url: JOB, ...over });

let dir: string;
let cookies: SessionCookie[];
let launched: Array<{ profile: string; runDir: string }>;
let stopped: number;
let visited: string[];
let pageClosed: boolean;
let opened: string[];
let ended: string[];
let busy: boolean;
let timers: Array<() => void>;

function runtime(o: { noPage?: boolean } = {}) {
	const page = { isClosed: () => pageClosed, goto: async (url: string) => void visited.push(url) } as unknown as Page;
	const ledgerPath = join(dir, "application-profiles", "isolated", "site-sessions.json");
	return new LocalApplySignInRuntime({
		dataDir: dir,
		busy: () => busy,
		schedule: (task) => {
			timers.push(task);
			return () => undefined;
		},
		browserFor: async (profile, runDir): Promise<RunBrowser> => {
			launched.push({ profile, runDir });
			return {
				tools: {} as RunBrowser["tools"],
				handoffPage: () => (o.noPage ? null : page),
				sessions: new SiteSessionLedger(ledgerPath, async () => cookies),
				stop: async () => void stopped++,
			};
		},
		takeover: {
			open: async (r) => {
				opened.push(r.handoffId);
				ended = ended.filter((id) => id !== r.handoffId);
			},
			state: async (id) => (opened.includes(id) && !ended.includes(id) && !pageClosed ? "ready" : "page_lost"),
			frame: async () => ({ frame: "data:image/jpeg;base64,SIGNIN", width: 1280, height: 720 }),
			input: async () => undefined,
			end: async (id) => void ended.push(id),
		},
	});
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sign-in-"));
	cookies = [];
	launched = [];
	stopped = 0;
	visited = [];
	pageClosed = false;
	opened = [];
	ended = [];
	busy = false;
	timers = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("a post-run sign-in opens the application profile at the job's site (#1100)", () => {
	it("launches the run's profile, opens the job page and streams it — with no run anywhere", async () => {
		const rt = runtime();
		const status = await rt.open(request());
		expect(status).toMatchObject({ signInId: "sign-in-30532b43", browserProfile: "isolated", site: "seek.com.au", state: "ready" });
		expect(launched).toEqual([{ profile: "isolated", runDir: join(dir, "sign-in", "sign-in-30532b43") }]);
		expect(visited).toEqual([JOB]);
		expect(opened).toEqual(["sign-in-30532b43"]);
		await expect(rt.frame({ signInId: "sign-in-30532b43" })).resolves.toMatchObject({ frame: "data:image/jpeg;base64,SIGNIN" });
		await expect(rt.input({ signInId: "sign-in-30532b43", input: { type: "click", x: 1, y: 2 } })).resolves.toBeUndefined();
		expect(rt.liveWork()).toEqual(["sign-in:sign-in-30532b43"]);
	});

	it("opening again under the same id reads the open one back — one browser, one page", async () => {
		const rt = runtime();
		await rt.open(request());
		await expect(rt.open(request())).resolves.toMatchObject({ state: "ready" });
		expect(launched).toHaveLength(1);
		await expect(rt.open(request({ url: "https://evil.example/" }))).rejects.toThrow(/already bound/);
	});

	it("finishing records the sign-in in the profile's ledger, so the next fill's session gate passes", async () => {
		const rt = runtime();
		const ledger = () => new SiteSessionLedger(join(dir, "application-profiles", "isolated", "site-sessions.json"), async () => cookies);
		expect((await ledger().check(JOB)).state).toBe("missing");
		await rt.open(request());
		// The owner signs in on the streamed page: SEEK sets its session cookie.
		cookies = [{ name: "JobseekerSessionId", domain: ".seek.com.au", expires: Date.now() / 1000 + 86_400 }];
		const done = await rt.end({ signInId: "sign-in-30532b43", complete: true });
		expect(done).toMatchObject({ state: "closed", signedIn: { fingerprint: 1, verifiable: true } });
		expect(done.terminalReason).toBeUndefined();
		expect(await ledger().check(JOB)).toEqual({ state: "ok", site: "seek.com.au" });
		expect(ended).toEqual(["sign-in-30532b43"]);
		expect(stopped).toBe(1);
		expect(rt.liveWork()).toEqual([]);
		// A finished sign-in is read back, never reopened.
		await expect(rt.open(request())).resolves.toMatchObject({ state: "closed", signedIn: { fingerprint: 1 } });
		expect(launched).toHaveLength(1);
	});

	it("closing without finishing records nothing", async () => {
		const rt = runtime();
		await rt.open(request());
		cookies = [{ name: "JobseekerSessionId", domain: ".seek.com.au", expires: -1 }];
		await expect(rt.end({ signInId: "sign-in-30532b43" })).resolves.toMatchObject({ state: "closed", terminalReason: "unavailable" });
		await expect(rt.end({ signInId: "sign-in-30532b43", complete: true })).resolves.not.toHaveProperty("signedIn");
		const ledger = new SiteSessionLedger(join(dir, "application-profiles", "isolated", "site-sessions.json"), async () => cookies);
		expect((await ledger.check(JOB)).state).toBe("missing");
	});

	it("never navigates the application browser from under a run, nor opens two sign-ins in one profile", async () => {
		busy = true;
		await expect(runtime().open(request())).rejects.toThrow(/application run is using/);
		busy = false;
		const rt = runtime();
		await rt.open(request());
		await expect(rt.open(request({ signInId: "sign-in-other" }))).rejects.toThrow(/Another sign-in/);
		expect(launched).toHaveLength(1);
	});

	it("a page the owner closed is reported lost, not served; the deadline closes an abandoned one", async () => {
		const rt = runtime();
		await rt.open(request());
		pageClosed = true;
		await expect(rt.frame({ signInId: "sign-in-30532b43" })).rejects.toThrow(/closed \(page_lost\)/);
		// Opening again under the same live takeover gives the owner a fresh page rather than a dead end.
		pageClosed = false;
		await expect(rt.open(request())).resolves.toMatchObject({ state: "ready" });
		expect(launched).toHaveLength(2);
		await rt.end({ signInId: "sign-in-30532b43" });

		const rt2 = runtime();
		await rt2.open(request({ signInId: "sign-in-2" }));
		for (const t of timers.splice(0)) t();
		await new Promise((r) => setTimeout(r, 0));
		expect(rt2.liveWork()).toEqual([]);
		await expect(rt2.frame({ signInId: "sign-in-2" })).rejects.toThrow(/closed \(expired\)/);
	});

	it("a profile with no page is closed as unavailable rather than looking ready", async () => {
		await expect(runtime({ noPage: true }).open(request())).resolves.toMatchObject({ state: "closed", terminalReason: "profile_unavailable" });
		expect(stopped).toBe(1);
	});

	it("refuses anything but an opaque id, a known profile and an http(s) url", async () => {
		const rt = runtime();
		await expect(rt.open(request({ url: "file:///etc/passwd" }))).rejects.toThrow(/http\(s\) url/);
		await expect(rt.open(request({ browserProfile: "everyday" }))).rejects.toThrow(/browserProfile/);
		await expect(rt.open(request({ signInId: "../x" }))).rejects.toThrow(/signInId/);
		await expect(rt.frame({ signInId: "nope" })).rejects.toThrow(/not found/);
	});
});
