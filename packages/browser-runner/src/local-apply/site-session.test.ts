/**
 * #1094 — an Application Runner run asks the owner to sign in to a site BEFORE an uncertain press,
 * remembers that sign-in for the browser profile, and asks again when the session is gone.
 *
 * The ledger is driven against a real file; the bridge against a faked browser whose cookie jar the
 * test controls. Every "nothing was pressed" assertion reads the calls the browser actually got.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserTools } from "../local-browser/bridge.js";
import { ApplyBridge, type ApplyBridgeHost } from "./bridge.js";
import { type LocalApplyEvent, type LocalApplyPause, parseLocalApplyEvent, traceUrl } from "./contract.js";
import { looksLikeSignIn, type SessionCookie, SiteSessionLedger, siteKeyOf } from "./site-session.js";

let dir: string;
let ledgerPath: string;
let jar: SessionCookie[];
const NOW = Date.parse("2026-10-15T00:00:00Z");
const reader = async () => jar.map((c) => ({ ...c, value: "SECRET-COOKIE-VALUE" }) as SessionCookie);
const ledger = () => new SiteSessionLedger(ledgerPath, reader, () => NOW);
const inAnHour = NOW / 1000 + 3600;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "site-session-"));
	ledgerPath = join(dir, "isolated", "site-sessions.json");
	jar = [{ name: "visitor", domain: ".seek.com", expires: inAnHour }];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the site-session ledger", () => {
	it("keys sites by registrable domain", () => {
		expect(siteKeyOf("au.seek.com")).toBe("seek.com");
		expect(siteKeyOf("login.seek.com")).toBe("seek.com");
		expect(siteKeyOf("www.seek.com.au")).toBe("seek.com.au");
		expect(siteKeyOf("jobs.example.com")).toBe("example.com");
	});

	it("recognises a sign-in page by password field, host or path", () => {
		expect(looksLikeSignIn("https://login.seek.com/x", false)).toBe(true);
		expect(looksLikeSignIn("https://jobs.example.com/oauth/authorize", false)).toBe(true);
		expect(looksLikeSignIn("https://jobs.example.com/apply", true)).toBe(true);
		expect(looksLikeSignIn("https://au.seek.com/job/1", false)).toBe(false);
	});

	it("a listed site with no sign-in on record is missing; an unlisted one is not gated", async () => {
		expect(await ledger().check("https://au.seek.com/job/94708960")).toEqual({ state: "missing", site: "seek.com", reason: "never_signed_in" });
		expect(await ledger().check("https://jobs.example.com/apply")).toEqual({ state: "ok", site: null });
	});

	it("records the cookies a sign-in added — names and expiry only, never a value — and survives a reload", async () => {
		const l = ledger();
		await l.beginSignIn("seek.com");
		jar.push({ name: "auth", domain: "au.seek.com", expires: inAnHour }, { name: "other-site", domain: ".example.com", expires: inAnHour });
		expect(await l.completeSignIn("seek.com")).toEqual({ fingerprint: 1, verifiable: true });
		const file = readFileSync(ledgerPath, "utf8");
		expect(file).not.toContain("SECRET-COOKIE-VALUE");
		expect(JSON.parse(file).sites["seek.com"]).toMatchObject({ state: "signed_in", cookieNames: ["auth"], verifiable: true });
		expect(await ledger().check("https://au.seek.com/job/1")).toEqual({ state: "ok", site: "seek.com" });
	});

	it("a session cookie that is gone or expired is a missing session again", async () => {
		const l = ledger();
		await l.beginSignIn("seek.com");
		jar.push({ name: "auth", domain: "au.seek.com", expires: inAnHour });
		await l.completeSignIn("seek.com");
		jar = jar.filter((c) => c.name !== "auth");
		expect(await ledger().check("https://au.seek.com/job/1")).toMatchObject({ state: "missing", reason: "expired" });
		jar.push({ name: "auth", domain: "au.seek.com", expires: NOW / 1000 - 1 });
		expect(await ledger().check("https://au.seek.com/job/1")).toMatchObject({ state: "missing", reason: "expired" });
	});

	it("a sign-in that added no cookie is kept but unverifiable, so later checks pass", async () => {
		const l = ledger();
		await l.beginSignIn("seek.com");
		expect(await l.completeSignIn("seek.com")).toEqual({ fingerprint: 0, verifiable: false });
		expect(await ledger().check("https://au.seek.com/job/1")).toEqual({ state: "ok", site: "seek.com" });
	});

	it("a bounce to a sign-in page is learned for any site, without the URL's query", async () => {
		const site = ledger().learnSignInWall("https://jobs.example.com/apply", "https://login.example.com/authorize?state=S3CR3T&nonce=N");
		expect(site).toBe("example.com");
		expect(await ledger().check("https://jobs.example.com/apply")).toMatchObject({ state: "missing", reason: "bounced_to_sign_in" });
		const file = readFileSync(ledgerPath, "utf8");
		expect(file).toContain('"loginHost": "login.example.com"');
		expect(file).not.toContain("S3CR3T");
	});
});

describe("trace URLs keep origin and path only (#1069)", () => {
	it("traceUrl and the event contract both drop query and fragment", () => {
		const raw = "https://login.seek.com/authorize?state=S&nonce=N&code_challenge=C&JobseekerSessionId=J#frag";
		expect(traceUrl(raw)).toBe("https://login.seek.com/authorize");
		const parsed = parseLocalApplyEvent({ type: "submit.unconfirmed", at: new Date(NOW).toISOString(), url: raw });
		expect(parsed?.url).toBe("https://login.seek.com/authorize");
		expect(JSON.stringify(parsed)).not.toMatch(/state=|nonce|JobseekerSessionId|frag/);
	});
});

// ── The bridge: the gate sits before the uncertain press ──────────────────────────────────────

const JOB = "https://au.seek.com/job/94708960";
const SNAPSHOT = ['- button "Quick apply" [ref=e22]', '- button "Submit application" [ref=e8]'].join("\n");
const FACTS: Record<string, { submits: boolean; method: string; name: string }> = {
	e22: { submits: false, method: "", name: "Quick apply" },
	e8: { submits: true, method: "post", name: "Submit application" },
};

function harness(o: { url?: string; onPause?: (p: LocalApplyPause) => "resumed" | "stopped"; afterClick?: string; loginAfterClick?: boolean } = {}) {
	const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	const history = [o.url ?? JOB];
	const tools: BrowserTools = {
		listTools: async () => [],
		callTool: async (name, args = {}) => {
			if (name === "browser_evaluate") {
				if (typeof args.target === "string") return { content: [{ text: `### Result\n${JSON.stringify({ tag: "button", type: "", ...FACTS[args.target] })}` }] };
				const url = history[history.length - 1];
				return { content: [{ text: `### Result\n${JSON.stringify({ url, title: "Job", login: !!o.loginAfterClick && url !== history[0] })}` }] };
			}
			calls.push({ name, args });
			if (name === "browser_click" && o.afterClick) history.push(o.afterClick);
			if (name === "browser_snapshot") return { content: [{ text: SNAPSHOT }] };
			return { content: [{ text: `${name} ok` }] };
		},
	};
	const events: Array<Omit<LocalApplyEvent, "at">> = [];
	const pauses: LocalApplyPause[] = [];
	const host: ApplyBridgeHost = {
		emit: (e) => events.push(e),
		pause: async (p) => {
			pauses.push(p);
			return o.onPause ? o.onPause(p) : "stopped";
		},
		supervisorCheckpoint: async () => "continue",
		isAllowed: (h) => h.endsWith("seek.com") || h.endsWith("example.com"),
		grounding: () => "",
		artifactPath: () => ({ error: "none" }),
		overTime: () => false,
		now: () => NOW,
		limits: { maxPages: 20, maxMinutes: 20 } as ApplyBridgeHost["limits"],
		mode: "auto_submit",
		gateId: "gate-1",
		sessions: ledger(),
	};
	const bridge = new ApplyBridge(tools, host);
	const press = async (target = "e22") => {
		await bridge.callTool("browser_navigate", { url: o.url ?? JOB });
		await bridge.callTool("browser_snapshot", {});
		await bridge.callTool("supervisor_checkpoint", { checkpointId: "initial:1", phase: "initial" });
		return bridge.callTool("browser_click", { target });
	};
	const pressed = (target = "e22") => calls.filter((c) => c.name === "browser_click" && c.args.target === target).length;
	return { bridge, events, pauses, press, pressed, attempted: () => events.filter((e) => e.type === "submit.attempted").length };
}

describe("the session gate before a one-click press (#1094)", () => {
	it("with no SEEK sign-in on record, the run pauses for a sign-in and presses NOTHING", async () => {
		const h = harness();
		const res = await h.press();
		expect(h.pauses).toEqual([expect.objectContaining({ reason: "login_required", domain: "au.seek.com" })]);
		expect(h.pauses[0].question).toMatch(/Sign in to seek\.com.*remembered on this machine.*Nothing has been submitted/);
		expect(h.pressed()).toBe(0);
		expect(h.attempted()).toBe(0);
		expect(res.isError).toBe(true);
		expect(h.bridge.blocked?.reason).toBe("login_required");
		expect(h.events).toContainEqual(expect.objectContaining({ type: "policy.decision", detail: expect.objectContaining({ class: "session", decision: "paused", reason: "session_never_signed_in", site: "seek.com" }) }));
	});

	it("the owner signs in once during the pause; the run continues unpressed, and the NEXT run presses without asking", async () => {
		const first = harness({
			onPause: () => {
				jar.push({ name: "auth", domain: "au.seek.com", expires: inAnHour });
				return "resumed";
			},
		});
		const res = await first.press();
		expect(res.isError).toBeFalsy();
		expect(res.content[0].text).toMatch(/signed in to seek\.com.*Nothing has been submitted.*browser_navigate \(https:\/\/au\.seek\.com\/job\/94708960\)/);
		expect(first.pressed()).toBe(0);
		expect(first.events).toContainEqual(expect.objectContaining({ detail: expect.objectContaining({ class: "session", decision: "recorded", site: "seek.com", count: 1, basis: "cookies" }) }));

		const second = harness();
		await second.press();
		expect(second.pauses).toHaveLength(0);
		expect(second.pressed()).toBe(1);
		expect(second.attempted()).toBe(1);
	});

	it("an expired session asks again instead of pressing into the sign-in wall", async () => {
		await harness({
			onPause: () => {
				jar.push({ name: "auth", domain: "au.seek.com", expires: inAnHour });
				return "resumed";
			},
		}).press();
		jar = jar.filter((c) => c.name !== "auth");
		const later = harness();
		await later.press();
		expect(later.pauses).toEqual([expect.objectContaining({ reason: "login_required" })]);
		expect(later.pressed()).toBe(0);
		expect(later.events).toContainEqual(expect.objectContaining({ detail: expect.objectContaining({ reason: "session_expired" }) }));
	});

	it("an unlisted site is not gated — a press that bounces to its sign-in stays submit_unconfirmed, and is learned for next time", async () => {
		const url = "https://jobs.example.com/apply";
		const h = harness({ url, afterClick: "https://login.example.com/authorize?state=S3CR3T", loginAfterClick: true });
		await h.press("e8");
		expect(h.pressed("e8")).toBe(1);
		expect(h.bridge.blocked?.reason).toBe("submit_unconfirmed");
		expect(h.bridge.blocked?.questions[0]).toMatch(/will ask you to sign in to example\.com first/);
		expect(h.events).toContainEqual(expect.objectContaining({ detail: expect.objectContaining({ decision: "learned", reason: "bounced_to_sign_in", site: "example.com" }) }));

		const next = harness({ url });
		await next.press("e8");
		expect(next.pressed("e8")).toBe(0);
		expect(next.pauses).toEqual([expect.objectContaining({ reason: "login_required" })]);
	});

	it("without a ledger (an older host) the press is unchanged", async () => {
		const h = harness();
		(h.bridge as unknown as { host: ApplyBridgeHost }).host.sessions = undefined;
		await h.press();
		expect(h.pressed()).toBe(1);
	});
});
