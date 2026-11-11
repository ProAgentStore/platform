/**
 * #1412's acceptance item still open after the landing commit (21488d9a): "fixtures pass with the
 * macros disabled by a test flag" — the synthetic fixtures didn't yet cover the two-step and
 * emailed-code shapes, and nothing proved the REAL `@playwright/mcp` secret substitution (not a
 * mocked browser) never lets a value escape. This drives all three shapes — password, two-step
 * username/then/password, and emailed code — through a REAL Chromium via `McpRuntime` against the
 * real `test-job-server-auth.ts` fixture, driving `ApplyBridge` directly: the three hardcoded
 * macros this once had to be disabled against no longer exist (retired in #1422), so the
 * agent-driven path in `bridge.ts` is the only way to clear the wall. No live site; purely the
 * local synthetic fixture (#1412's own "no live site run is authorised by this ticket").
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { BrowserTools } from "../local-browser/bridge.js";
import type { McpRuntime } from "../mcp-runtime.js";
import { ensureTestChromiumInstalled } from "../test-chromium.js";
import { startTestJobServerAuth, type TestJobServerAuth } from "../test-job-server-auth.js";
import { ApplyBridge, type ApplyBridgeHost } from "./bridge.js";
import type { LocalApplyEvent, LocalApplyPause } from "./contract.js";
import { SiteSessionLedger } from "./site-session.js";
import { launchCdpBrowser } from "./live-run-browser.js";

const PROFILE = "Name: Jane Citizen\nEmail: jane.citizen@example.com";
const EMAIL = "jane.citizen@example.com";
const PASSWORD = "Tr0ub4dor&3-never-seen";

let server: TestJobServerAuth;
let profileDir: string;
let launched: Awaited<ReturnType<typeof launchCdpBrowser>> | undefined;
let mcp: McpRuntime;

// Resolve/install this package's Chromium before the persistent-context launch. CI's root
// Playwright has a different browser revision and its later E2E install cannot supply this one.
beforeAll(() => ensureTestChromiumInstalled());

beforeEach(async () => {
	launched = undefined;
	profileDir = "";
	server = await startTestJobServerAuth();
	profileDir = mkdtempSync(join(tmpdir(), "pags-agent-sign-in-leak-test-"));
	launched = await launchCdpBrowser(profileDir, true);
	mcp = launched.mcp;
	await fetch(`${server.url}/register`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: `fullName=Jane+Citizen&email=${encodeURIComponent(EMAIL)}&password=${encodeURIComponent(PASSWORD)}`,
		redirect: "manual",
	});
});

afterEach(async () => {
	try {
		await launched?.stop();
	} finally {
		if (profileDir) rmSync(profileDir, { recursive: true, force: true });
		await server?.close();
	}
});

/** Wraps the real McpRuntime so every call+result is recorded for the leak check, while still driving the real browser. */
function recordingTools(): { tools: BrowserTools; calls: Array<{ name: string; args: Record<string, unknown>; resultText: string }> } {
	const calls: Array<{ name: string; args: Record<string, unknown>; resultText: string }> = [];
	return {
		calls,
		tools: {
			listTools: () => mcp.listTools(),
			callTool: async (name, args = {}, opts) => {
				const res = await mcp.callTool(name, args, opts);
				calls.push({ name, args, resultText: mcp.textOf(res) });
				return res;
			},
		},
	};
}

function host(names: string[], o: { onRequestCode?: () => Promise<boolean> } = {}) {
	const events: Array<Omit<LocalApplyEvent, "at">> = [];
	const pauses: LocalApplyPause[] = [];
	const h: ApplyBridgeHost = {
		emit: (e) => events.push(e),
		pause: async (p) => {
			pauses.push(p);
			return p.reason === "login_required" ? "sign_in" : "stopped";
		},
		signInSecrets: () => [...names],
		requestSignInCode: o.onRequestCode,
		signInDone: () => undefined,
		supervisorCheckpoint: async () => "continue",
		isAllowed: () => true,
		grounding: () => PROFILE,
		artifactPath: () => ({ error: "no artifact needed in this test" }),
		overTime: () => false,
		now: () => Date.now(),
		limits: { maxMinutes: 5, maxPages: 30, maxActions: 100 },
		mode: "fill_and_review",
	};
	return { host: h, events, pauses };
}

/**
 * The full-tool-access host for the #1619 account-registration operations (#1422: the sign-up-with-code
 * fixture) — `request_new_password` and `request_sign_in_link`/`request_sign_in_code` only exist on
 * `FullApplyTools`, so this drives `toolAccess: "full"` rather than the guarded `host()` above.
 */
function fullAccountHost(names: string[], o: { onRequestNewPassword: () => Promise<boolean>; onRequestCode: () => Promise<boolean> }) {
	const events: Array<Omit<LocalApplyEvent, "at">> = [];
	const pauses: LocalApplyPause[] = [];
	const h: ApplyBridgeHost = {
		emit: (e) => events.push(e),
		pause: async (p) => {
			pauses.push(p);
			return p.reason === "login_required" ? "sign_in" : "stopped";
		},
		signInSecrets: () => [...names],
		accountOperations: true,
		requestNewPassword: o.onRequestNewPassword,
		requestSignInCode: o.onRequestCode,
		signInDone: () => undefined,
		supervisorCheckpoint: async () => "continue",
		isAllowed: () => true,
		grounding: () => PROFILE,
		artifactPath: () => ({ error: "no artifact needed in this test" }),
		overTime: () => false,
		isStopped: () => false,
		now: () => Date.now(),
		limits: { maxMinutes: 5, maxPages: 30, maxActions: 100 },
		mode: "fill_and_review",
		toolAccess: "full",
		page: () => launched!.activePage(),
	};
	return { host: h, events, pauses };
}

/** The ref Playwright's real ARIA snapshot assigned to the first line matching `pattern` — frame-prefixed (`f1e8`), not bare (`e8`). */
function refFor(snapshot: string, pattern: RegExp): string {
	const line = snapshot.split("\n").find((l) => pattern.test(l));
	const m = line?.match(/\[ref=([^\]]+)\]/);
	if (!m) throw new Error(`No ref matching ${pattern} in snapshot:\n${snapshot}`);
	return m[1];
}

describe("the agent-driven sign-in against a REAL browser and REAL @playwright/mcp secrets (#1412, leak proof)", () => {
	it("passwordless username and OTP forms on an ordinary URL remain a sign-in until the code wall disappears (#1438)", async () => {
		mcp.provideSecrets({ PAGS_LOGIN_USERNAME: EMAIL, PAGS_LOGIN_CODE: "123456" });
		const { tools } = recordingTools();
		const { host: h, pauses } = host(["PAGS_LOGIN_USERNAME", "PAGS_LOGIN_CODE"]);
		const bridge = new ApplyBridge(tools, h);
		await bridge.callTool("browser_navigate", { url: server.jobUrl });
		const page = launched!.activePage()!;
		await page.setContent('<form><label>Email<input type="email"></label><button type="button">Email me a sign in code</button></form>');
		const emailPage = await bridge.callTool("browser_snapshot", {});
		await bridge.callTool("supervisor_checkpoint", { checkpointId: "passwordless", phase: "post_navigation" });
		expect(pauses.at(-1)?.reason).toBe("login_required");
		const email = refFor(emailPage.content[0].text, /textbox "Email"/);
		expect((await bridge.callTool("browser_type", { target: email, text: "PAGS_LOGIN_USERNAME" })).isError).toBeUndefined();
		await page.locator('button').evaluate(button => button.addEventListener('click', () => { document.body.innerHTML = '<form><label>Verification code<input name="code" autocomplete="one-time-code"></label><button type="button">Verify</button></form>'; }));
		const next = refFor((await bridge.callTool("browser_snapshot", {})).content[0].text, /button "Email me a sign in code"/);
		const toCode = await bridge.callTool("browser_click", { target: next });
		expect(toCode.content[0].text).toContain("Still on the sign-in page");
		expect(bridge.signIn).not.toBeNull();
		const codePage = await bridge.callTool("browser_snapshot", {});
		const code = refFor(codePage.content[0].text, /textbox "Verification code"/);
		expect((await bridge.callTool("browser_type", { target: code, text: "PAGS_LOGIN_CODE" })).isError).toBeUndefined();
		expect((await bridge.callTool("browser_snapshot", {})).content[0].text).not.toContain("Signed in to");
		await page.setContent('<h1>My account</h1>');
		expect((await bridge.callTool("browser_snapshot", {})).content[0].text).toContain("Signed in to");
		expect(bridge.signIn).toBeNull();
	}, 60_000);

	it("a job snapshot before the sign-in wall cannot complete the pre-submit session gate (#1438)", async () => {
		const { tools, calls } = recordingTools();
		const { host: h, events } = host(["PAGS_LOGIN_USERNAME"]);
		const ledger = new SiteSessionLedger(join(profileDir, "sessions.json"), () => launched!.context.cookies());
		ledger.learnSignInWall(server.jobUrl, server.loginUrl);
		h.sessions = ledger;
		h.mode = "auto_submit";
		h.gateId = "synthetic-gate";
		const bridge = new ApplyBridge(tools, h);
		await bridge.callTool("browser_navigate", { url: server.jobUrl });
		await launched!.activePage()!.setContent('<button>Quick apply</button>');
		const snapshot = await bridge.callTool("browser_snapshot", {});
		await bridge.callTool("supervisor_checkpoint", { checkpointId: "before-quick-apply", phase: "before_submit" });
		const target = refFor(snapshot.content[0].text, /button "Quick apply"/);
		const held = await bridge.callTool("browser_click", { target });
		expect(held.content[0].text).toContain("Not pressed.");
		const after = await bridge.callTool("browser_snapshot", {});
		expect(after.content[0].text).not.toContain("Signed in to");
		expect(bridge.signIn).not.toBeNull();
		expect((await ledger.check(server.jobUrl)).state).toBe("missing");
		expect(calls.filter(c => c.name === "browser_click")).toHaveLength(0);
		expect(events.some(e => e.type === "submit.attempted")).toBe(false);
	});

	it("an unrelated hidden password never authorizes an application Submit (#1438)", async () => {
		const { tools, calls } = recordingTools();
		const { host: h, pauses } = host(["PAGS_LOGIN_PASSWORD"]);
		const bridge = new ApplyBridge(tools, h);
		await bridge.callTool("browser_navigate", { url: server.jobUrl });
		const page = launched!.activePage()!;
		await page.setContent('<form><input type="password" hidden></form><form id="application"><label>Promo code<input name="promoCode"></label><label>Postcode<input name="postcode"></label><button type="submit">Submit</button></form>');
		await page.evaluate(() => document.querySelector('#application')!.addEventListener('submit', e => { e.preventDefault(); document.title = 'SENT'; }));
		const snap = await bridge.callTool("browser_snapshot", {});
		await bridge.callTool("supervisor_checkpoint", { checkpointId: "hidden-password", phase: "initial" });
		expect(pauses).toHaveLength(0);
		const submit = refFor(snap.content[0].text, /button "Submit"/);
		await bridge.callTool("browser_click", { target: submit });
		expect(calls.filter(c => c.name === "browser_click")).toHaveLength(0);
		expect(await page.title()).not.toBe("SENT");
	});

	it("even on an active login page, an unrelated application form cannot use the session bypass (#1438)", async () => {
		const { tools, calls } = recordingTools();
		const { host: h } = host(["PAGS_LOGIN_PASSWORD"]);
		const bridge = new ApplyBridge(tools, h);
		await bridge.callTool("browser_navigate", { url: server.loginUrl });
		const page = launched!.activePage()!;
		await page.setContent('<form action="/login"><label>Password<input type="password"></label><button>Sign in</button></form><form id="application"><label>Full name<input name="fullName"></label><label>Email<input type="email"></label><input type="password" hidden><button type="submit">Submit</button></form>');
		const snap = await bridge.callTool("browser_snapshot", {});
		const submit = refFor(snap.content[0].text, /button "Submit"/);
		expect((await bridge.callTool("browser_click", { target: submit })).isError).toBe(true);
		expect(calls.filter(c => c.name === "browser_click")).toHaveLength(0);
	});

	it("a same-origin sign-in form cannot submit credentials to a different origin (#1438)", async () => {
		const { tools, calls } = recordingTools();
		const { host: h } = host(["PAGS_LOGIN_PASSWORD"]);
		const bridge = new ApplyBridge(tools, h);
		await bridge.callTool("browser_navigate", { url: server.loginUrl });
		const page = launched!.activePage()!;
		await page.locator('form').evaluate(form => form.setAttribute('action', 'https://untrusted.example/login'));
		const snap = await bridge.callTool("browser_snapshot", {});
		const signIn = refFor(snap.content[0].text, /button "Sign in"/);
		expect((await bridge.callTool("browser_click", { target: signIn })).isError).toBe(true);
		expect(calls.filter(c => c.name === "browser_click")).toHaveLength(0);
	});

	it("password login: the name is typed, the real value is substituted, and the value never appears in any call or event", async () => {
		mcp.provideSecrets({ PAGS_LOGIN_USERNAME: EMAIL, PAGS_LOGIN_PASSWORD: PASSWORD });
		const names = ["PAGS_LOGIN_USERNAME", "PAGS_LOGIN_PASSWORD"];
		const { tools, calls } = recordingTools();
		const { host: h, events, pauses } = host(names);
		const bridge = new ApplyBridge(tools, h);

		await bridge.callTool("browser_navigate", { url: server.jobUrl });
		await bridge.callTool("browser_snapshot", {});
		const wall = await bridge.callTool("browser_navigate", { url: server.loginUrl });
		expect(wall.isError).toBeUndefined();
		expect(pauses).toHaveLength(1);
		expect(pauses[0]).toMatchObject({ reason: "login_required" });

		const snap1 = await bridge.callTool("browser_snapshot", {});
		const snapText1 = (snap1.content[0] as { text: string }).text;
		const emailRef = refFor(snapText1, /textbox "Email"/i);
		const passwordRef = refFor(snapText1, /textbox "Password"/i);

		expect((await bridge.callTool("browser_type", { target: emailRef, text: "PAGS_LOGIN_USERNAME" })).isError).toBeUndefined();
		expect((await bridge.callTool("browser_type", { target: passwordRef, text: "PAGS_LOGIN_PASSWORD" })).isError).toBeUndefined();

		const snap2 = await bridge.callTool("browser_snapshot", {});
		const signInRef = refFor((snap2.content[0] as { text: string }).text, /button "Sign in"/i);
		const signedIn = await bridge.callTool("browser_click", { target: signInRef });
		expect(signedIn.isError).toBeUndefined();
		expect(signedIn.content[0].text).toMatch(/Signed in/);

		// Genuinely authenticated, not just believed to be: the dashboard's real content, read live.
		const dash = await bridge.callTool("browser_snapshot", {});
		expect((dash.content[0] as { text: string }).text).toMatch(/My Applications/);

		const dump = JSON.stringify({ calls, events });
		expect(dump).not.toContain(PASSWORD);
		expect(dump).not.toContain(EMAIL);
	}, 60_000);

	it("two-step (email, THEN password on a second page): still just names, across both pages", async () => {
		mcp.provideSecrets({ PAGS_LOGIN_USERNAME: EMAIL, PAGS_LOGIN_PASSWORD: PASSWORD });
		const names = ["PAGS_LOGIN_USERNAME", "PAGS_LOGIN_PASSWORD"];
		const { tools, calls } = recordingTools();
		const { host: h, events } = host(names);
		const bridge = new ApplyBridge(tools, h);

		await bridge.callTool("browser_navigate", { url: server.jobUrl });
		await bridge.callTool("browser_snapshot", {});
		await bridge.callTool("browser_navigate", { url: server.twoStepLoginUrl });

		const step1 = await bridge.callTool("browser_snapshot", {});
		const step1Text = (step1.content[0] as { text: string }).text;
		const emailRef = refFor(step1Text, /textbox "Email"/i);
		expect((await bridge.callTool("browser_type", { target: emailRef, text: "PAGS_LOGIN_USERNAME" })).isError).toBeUndefined();

		const continueSnap = await bridge.callTool("browser_snapshot", {});
		const continueRef = refFor((continueSnap.content[0] as { text: string }).text, /button "Continue"/i);
		const step2 = await bridge.callTool("browser_click", { target: continueRef });
		expect(step2.isError).toBeUndefined();
		expect(step2.content[0].text).toMatch(/Still on the sign-in page/);

		const step2Snap = await bridge.callTool("browser_snapshot", {});
		const step2Text = (step2Snap.content[0] as { text: string }).text;
		const passwordRef = refFor(step2Text, /textbox "Password"/i);
		expect((await bridge.callTool("browser_type", { target: passwordRef, text: "PAGS_LOGIN_PASSWORD" })).isError).toBeUndefined();

		const finalSnap = await bridge.callTool("browser_snapshot", {});
		const signInRef = refFor((finalSnap.content[0] as { text: string }).text, /button "Sign in"/i);
		const signedIn = await bridge.callTool("browser_click", { target: signInRef });
		expect(signedIn.isError).toBeUndefined();
		expect(signedIn.content[0].text).toMatch(/Signed in/);

		const dash = await bridge.callTool("browser_snapshot", {});
		expect((dash.content[0] as { text: string }).text).toMatch(/My Applications/);

		const dump = JSON.stringify({ calls, events });
		expect(dump).not.toContain(PASSWORD);
		expect(dump).not.toContain(EMAIL);
	}, 60_000);

	it("emailed code: the CLI asks, the cloud reads the code the fixture 'emailed' (never the page) and provisions PAGS_LOGIN_CODE", async () => {
		mcp.provideSecrets({ PAGS_LOGIN_USERNAME: EMAIL, PAGS_LOGIN_PASSWORD: PASSWORD });
		const names = ["PAGS_LOGIN_USERNAME", "PAGS_LOGIN_PASSWORD"];
		let code = "";
		const { tools, calls } = recordingTools();
		const { host: h, events } = host(names, {
			onRequestCode: async () => {
				// The same thing the real Worker does: read the emailed code out of band, never from the page.
				code = server.pendingMfaCodes.get(EMAIL) ?? "";
				if (!code) return false;
				mcp.provideSecrets({ PAGS_LOGIN_CODE: code });
				names.push("PAGS_LOGIN_CODE");
				return true;
			},
		});
		const bridge = new ApplyBridge(tools, h);

		await bridge.callTool("browser_navigate", { url: server.jobUrl });
		await bridge.callTool("browser_snapshot", {});
		await bridge.callTool("browser_navigate", { url: server.mfaLoginUrl });

		const step1 = await bridge.callTool("browser_snapshot", {});
		const step1Text = (step1.content[0] as { text: string }).text;
		const emailRef = refFor(step1Text, /textbox "Email"/i);
		const passwordRef = refFor(step1Text, /textbox "Password"/i);
		expect((await bridge.callTool("browser_type", { target: emailRef, text: "PAGS_LOGIN_USERNAME" })).isError).toBeUndefined();
		expect((await bridge.callTool("browser_type", { target: passwordRef, text: "PAGS_LOGIN_PASSWORD" })).isError).toBeUndefined();

		const credsSnap = await bridge.callTool("browser_snapshot", {});
		const signInRef = refFor((credsSnap.content[0] as { text: string }).text, /button "Sign in"/i);
		const toCodePage = await bridge.callTool("browser_click", { target: signInRef });
		expect(toCodePage.isError).toBeUndefined();
		expect(toCodePage.content[0].text).toMatch(/Still on the sign-in page/);

		// Typing the name before the code has arrived is refused, not silently typed.
		const codeSnap = await bridge.callTool("browser_snapshot", {});
		const codeRef = refFor((codeSnap.content[0] as { text: string }).text, /textbox "Code"/i);
		const early = await bridge.callTool("browser_type", { target: codeRef, text: "PAGS_LOGIN_CODE" });
		expect(early.isError).toBe(true);

		const waited = await bridge.callTool("request_sign_in_code", {});
		expect(waited.content[0].text).toMatch(/available as PAGS_LOGIN_CODE/);
		expect(code).toMatch(/^\d{6}$/);

		expect((await bridge.callTool("browser_type", { target: codeRef, text: "PAGS_LOGIN_CODE" })).isError).toBeUndefined();
		const verifySnap = await bridge.callTool("browser_snapshot", {});
		const verifyRef = refFor((verifySnap.content[0] as { text: string }).text, /button "Verify"/i);
		const signedIn = await bridge.callTool("browser_click", { target: verifyRef });
		expect(signedIn.isError).toBeUndefined();
		expect(signedIn.content[0].text).toMatch(/Signed in/);

		const dash = await bridge.callTool("browser_snapshot", {});
		expect((dash.content[0] as { text: string }).text).toMatch(/My Applications/);

		const dump = JSON.stringify({ calls, events });
		expect(dump).not.toContain(PASSWORD);
		expect(dump).not.toContain(EMAIL);
		expect(code).not.toBe("");
		expect(dump).not.toContain(code);
	}, 60_000);

	it("sign-up with code (#1422): registering a new account, confirmed by an emailed code, through FULL tool access", async () => {
		const NEW_EMAIL = "nina.newhire@example.com";
		const GENERATED_PASSWORD = "Gen3rated-np-9f2!";
		mcp.provideSecrets({ PAGS_LOGIN_USERNAME: NEW_EMAIL });
		const names = ["PAGS_LOGIN_USERNAME"];
		let code = "";
		const { tools, calls } = recordingTools();
		const { host: h, events, pauses } = fullAccountHost(names, {
			onRequestNewPassword: async () => {
				mcp.provideSecrets({ PAGS_NEW_PASSWORD: GENERATED_PASSWORD });
				names.push("PAGS_NEW_PASSWORD");
				return true;
			},
			onRequestCode: async () => {
				// The same thing the real Worker does: read the emailed code out of band, never from the page.
				code = server.pendingMfaCodes.get(NEW_EMAIL) ?? "";
				if (!code) return false;
				mcp.provideSecrets({ PAGS_LOGIN_CODE: code });
				names.push("PAGS_LOGIN_CODE");
				return true;
			},
		});
		const bridge = new ApplyBridge(tools, h);

		await bridge.callTool("browser_navigate", { url: server.registerWithCodeUrl });
		const signIn = await bridge.callTool("request_sign_in", {});
		expect(pauses).toHaveLength(1);
		expect(pauses[0]).toMatchObject({ reason: "login_required" });
		expect(signIn.content[0].text).toMatch(/request_new_password/);
		expect(signIn.content[0].text).not.toContain(NEW_EMAIL);

		const regSnap = await bridge.callTool("browser_snapshot", {});
		const regText = (regSnap.content[0] as { text: string }).text;
		const nameRef = refFor(regText, /textbox "Full name"/i);
		const emailRef = refFor(regText, /textbox "Email"/i);
		const passwordRef = refFor(regText, /textbox "Password"/i);

		// Full access places no source-quote restriction on an ordinary literal like a name.
		expect((await bridge.callTool("browser_type", { target: nameRef, text: "Nina New Hire" })).isError).toBeUndefined();
		expect((await bridge.callTool("browser_type", { target: emailRef, text: "PAGS_LOGIN_USERNAME" })).isError).toBeUndefined();

		const np = await bridge.callTool("request_new_password", {});
		expect(np.isError).toBeFalsy();
		expect((await bridge.callTool("browser_type", { target: passwordRef, text: "PAGS_NEW_PASSWORD" })).isError).toBeUndefined();

		const sendSnap = await bridge.callTool("browser_snapshot", {});
		const sendRef = refFor((sendSnap.content[0] as { text: string }).text, /button "Send me a code"/i);
		expect((await bridge.callTool("browser_click", { target: sendRef })).isError).toBeUndefined();

		const codeSnap = await bridge.callTool("browser_snapshot", {});
		const codeRef = refFor((codeSnap.content[0] as { text: string }).text, /textbox "Code"/i);

		const waited = await bridge.callTool("request_sign_in_code", {});
		expect(waited.isError).toBeFalsy();
		expect(code).toMatch(/^\d{6}$/);

		expect((await bridge.callTool("browser_type", { target: codeRef, text: "PAGS_LOGIN_CODE" })).isError).toBeUndefined();
		const verifySnap = await bridge.callTool("browser_snapshot", {});
		const createRef = refFor((verifySnap.content[0] as { text: string }).text, /button "Create account"/i);
		expect((await bridge.callTool("browser_click", { target: createRef })).isError).toBeUndefined();

		// Genuinely registered and signed in, not just believed to be: the dashboard's real content, read live.
		const dash = await bridge.callTool("browser_snapshot", {});
		expect((dash.content[0] as { text: string }).text).toMatch(/My Applications/);

		expect((await bridge.callTool("finish_sign_in", { signedIn: true })).isError).toBeFalsy();
		expect(events.some((e) => e.type === "policy.decision" && e.detail?.tool === "agent_sign_in" && e.detail?.decision === "signed_in")).toBe(true);

		const dump = JSON.stringify({ calls, events });
		expect(dump).not.toContain(GENERATED_PASSWORD);
		expect(dump).not.toContain(NEW_EMAIL);
		expect(code).not.toBe("");
		expect(dump).not.toContain(code);
	}, 60_000);
});
