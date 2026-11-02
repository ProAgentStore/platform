/**
 * #1412's acceptance item still open after the landing commit (21488d9a): "fixtures pass with the
 * macros disabled by a test flag" — the synthetic fixtures didn't yet cover the two-step and
 * emailed-code shapes, and nothing proved the REAL `@playwright/mcp` secret substitution (not a
 * mocked browser) never lets a value escape. This drives all three shapes — password, two-step
 * username/then/password, and emailed code — through a REAL Chromium via `McpRuntime` against the
 * real `test-job-server-auth.ts` fixture, with `PAGS_TEST_DISABLE_SIGN_IN_MACROS=1` set so the
 * three hardcoded macros (retired in #1422) are provably unreachable: only the agent-driven path
 * in `bridge.ts` can clear the wall. No live site; purely the local synthetic fixture (#1412's own
 * "no live site run is authorised by this ticket").
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrowserTools } from "../local-browser/bridge.js";
import { McpRuntime } from "../mcp-runtime.js";
import { startTestJobServerAuth, type TestJobServerAuth } from "../test-job-server-auth.js";
import { ApplyBridge, type ApplyBridgeHost } from "./bridge.js";
import type { LocalApplyEvent, LocalApplyPause } from "./contract.js";

const PROFILE = "Name: Jane Citizen\nEmail: jane.citizen@example.com";
const EMAIL = "jane.citizen@example.com";
const PASSWORD = "Tr0ub4dor&3-never-seen";

let server: TestJobServerAuth;
let mcp: McpRuntime;

beforeEach(async () => {
	process.env.PAGS_TEST_DISABLE_SIGN_IN_MACROS = "1";
	server = await startTestJobServerAuth();
	mcp = new McpRuntime();
	await mcp.start({ headless: true });
	await fetch(`${server.url}/register`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: `fullName=Jane+Citizen&email=${encodeURIComponent(EMAIL)}&password=${encodeURIComponent(PASSWORD)}`,
		redirect: "manual",
	});
});

afterEach(async () => {
	delete process.env.PAGS_TEST_DISABLE_SIGN_IN_MACROS;
	await mcp.stop();
	await server.close();
});

/** Wraps the real McpRuntime so every call+result is recorded for the leak check, while still driving the real browser. */
function recordingTools(): { tools: BrowserTools; calls: Array<{ name: string; args: Record<string, unknown>; resultText: string }> } {
	const calls: Array<{ name: string; args: Record<string, unknown>; resultText: string }> = [];
	return {
		calls,
		tools: {
			listTools: () => mcp.listTools(),
			callTool: async (name, args = {}) => {
				const res = await mcp.callTool(name, args);
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

/** The ref Playwright's real ARIA snapshot assigned to the first line matching `pattern` — frame-prefixed (`f1e8`), not bare (`e8`). */
function refFor(snapshot: string, pattern: RegExp): string {
	const line = snapshot.split("\n").find((l) => pattern.test(l));
	const m = line?.match(/\[ref=([^\]]+)\]/);
	if (!m) throw new Error(`No ref matching ${pattern} in snapshot:\n${snapshot}`);
	return m[1];
}

describe("the agent-driven sign-in against a REAL browser and REAL @playwright/mcp secrets (#1412, leak proof)", () => {
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
});
