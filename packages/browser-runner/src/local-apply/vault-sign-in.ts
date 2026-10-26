/**
 * The vault sign-in (#1229): a fill run paused `login_required` on a host with a stored password login signs itself in.
 *
 * The cloud reads the owner's credential (`findCredentialForHost`, owner-scoped) and sends it here in ONE request; this types it into the
 * paused run's own sign-in page and, once the site lets the browser in, releases the pause. The CLI — blocked in its pause — never sees the
 * username or the password, and neither enters the trace, a log or a return value: events carry the site and a reason, nothing typed.
 * Nothing is kept after the call.
 *
 * It is careful in the ways a password makes it need to be:
 *   • **One site.** The request names the host the credential belongs to; if the page is on any other site, nothing is typed (`host_mismatch`).
 *   • **One attempt.** A wrong password is never retried here (a loop of bad logins locks an account); a CAPTCHA or a second factor is never
 *     worked around. Each ends the attempt with its reason and the pause stays for the owner, who gets the ordinary sign-in handoff.
 *   • **Read by role and name**, like the email-code sign-in: a username box, a password box, a sign-in button — and for a two-step form
 *     (username, Continue, then password) the second step. Anything the page does not offer ends `failed`, not guessed at.
 *
 * Not verified live: no site's sign-in page was driven for a real login. The page shapes it expects are exercised on recorded snapshots.
 */
import { RunnerInputError } from "../errors.js";
import { type BrowserTools, evaluateResult } from "../local-browser/bridge.js";
import type { LocalApplyEvent, LocalApplyVaultSignInFailure, LocalApplyVaultSignInResult } from "./contract.js";
import { codeBoxes, controlsOf } from "./email-code.js";
import { looksLikeSignIn, siteKeyOf } from "./site-session.js";

export interface VaultSignInTarget {
	tools: BrowserTools;
	emit(event: Omit<LocalApplyEvent, "at">): void;
	/** Release the run's sign-in pause; the bridge then records the session as after an owner's sign-in. */
	resume(): void;
	/** Injectable so tests do not wait in real time. */
	wait?(ms: number): Promise<void>;
}

const USERNAME_FIELD = /e-?mail|user ?name|user ?id|login|account|phone|mobile/i;
const PASSWORD_FIELD = /pass ?word|passcode|pin\b/i;
/** A button that signs in with THIS account — not "with Google", not "forgot", not "create". */
const SUBMIT_BUTTON = /^(sign[- ]?in|log[- ]?in|continue|next|submit)\b/i;
const NOT_SUBMIT = /\bwith\b|google|apple|facebook|linkedin|microsoft|github|passkey|forgot|reset|create|register|sign[- ]?up|join|email me|send|code/i;
const CAPTCHA = /captcha|recaptcha|hcaptcha|turnstile|verify (that )?you('| a)?re (a )?human|are you (a )?(human|robot)|i'?m not a robot|security check|unusual (activity|traffic)/i;
const SECOND_FACTOR = /two[- ]?factor|2[- ]?step|2fa|authenticator app|authentication code|security code|verification code|one[- ]?time (code|pass)|we('| ha)ve sent (you )?(a|an) (code|email|text|sms)|check your (email|phone)/i;
const REFUSED = /incorrect|invalid|wrong|didn'?t match|does not match|not (correct|recogni[sz]ed)|couldn'?t (find|sign)|unable to sign|try again/i;
const LOOKS = 6;
const LOOK_MS = 2000;

type Control = { role: string; name: string; ref: string };

const textOf = (r: { content?: Array<{ text?: string }> }) => (r.content ?? []).map((c) => c.text ?? "").join("\n");

async function snapshot(tools: BrowserTools): Promise<{ text: string; controls: Control[] }> {
	const text = textOf(await tools.callTool("browser_snapshot", {}).catch(() => ({ content: [] })));
	return { text, controls: controlsOf(text) };
}

async function pageUrl(tools: BrowserTools): Promise<string | null> {
	const res = await tools.callTool("browser_evaluate", { function: "() => location.href" }).catch(() => null);
	const v = res && !res.isError ? evaluateResult(textOf(res)) : null;
	return typeof v === "string" ? v : null;
}

const passwordBox = (cs: Control[]) => cs.find((c) => (c.role === "textbox" || c.role === "spinbutton") && PASSWORD_FIELD.test(c.name));
const usernameBox = (cs: Control[]) => cs.find((c) => c.role === "textbox" && USERNAME_FIELD.test(c.name) && !PASSWORD_FIELD.test(c.name));
const submitButton = (cs: Control[]) => cs.find((c) => c.role === "button" && SUBMIT_BUTTON.test(c.name.trim()) && !NOT_SUBMIT.test(c.name));

/** Does the page ask for proof of a human? Shared with account creation (#1230), which stops at the same wall. */
export const looksLikeCaptcha = (text: string): boolean => CAPTCHA.test(text);

/** What the page says stands in the way: a challenge, a second factor, or a refused password. Null when none. */
export function obstacleOn(text: string, controls: Control[]): "captcha" | "two_factor" | "wrong_password" | null {
	if (CAPTCHA.test(text)) return "captcha";
	if (!passwordBox(controls) && (codeBoxes(controls).length || SECOND_FACTOR.test(text))) return "two_factor";
	if (passwordBox(controls) && REFUSED.test(text)) return "wrong_password";
	return null;
}

/** Sign a run paused for a sign-in in with the credential the cloud read from the vault. Never throws for a page that is not as expected. */
export async function runVaultSignIn(target: VaultSignInTarget, raw: unknown): Promise<LocalApplyVaultSignInResult> {
	const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const wait = target.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const { tools } = target;
	const username = typeof o.username === "string" ? o.username : "";
	const password = typeof o.password === "string" ? o.password : "";
	const wanted = typeof o.host === "string" ? o.host.trim().toLowerCase() : "";
	if (!username || username.length > 320 || !password || password.length > 1024 || !/^[a-z0-9.-]{3,253}$/.test(wanted)) throw new RunnerInputError("vault sign-in needs host, username and password");

	const url = await pageUrl(tools);
	const host = url ? new URL(url).hostname : "";
	const site = host ? siteKeyOf(host) : "";
	const fail = (reason: LocalApplyVaultSignInFailure): LocalApplyVaultSignInResult => {
		target.emit({ type: "policy.decision", ...(host ? { domain: host } : {}), detail: { tool: "vault_sign_in", class: "session", decision: "failed", reason, ...(site ? { site } : {}) } });
		return { state: "failed", reason };
	};
	// The credential belongs to ONE site. A page anywhere else — a redirect to an identity provider, say — gets nothing typed.
	if (!url || !site || site !== siteKeyOf(wanted)) return fail("host_mismatch");

	let { text, controls } = await snapshot(tools);
	// Before anything is typed only a challenge stops it: a username-first page may talk about codes without being a second-factor prompt.
	if (obstacleOn(text, controls) === "captcha") return fail("captcha");

	// A two-step form asks for the username first and the password after Continue.
	if (!passwordBox(controls)) {
		const user = usernameBox(controls);
		if (!user) return fail("no_username_field");
		const next = submitButton(controls);
		if (!next) return fail("no_submit_button");
		await tools.callTool("browser_type", { element: user.name, target: user.ref, text: username });
		await tools.callTool("browser_click", { element: next.name, target: next.ref });
		let seen = false;
		for (let i = 0; i < LOOKS && !seen; i++) {
			await wait(LOOK_MS);
			({ text, controls } = await snapshot(tools));
			const stop = obstacleOn(text, controls);
			if (stop === "captcha" || stop === "two_factor") return fail(stop);
			seen = !!passwordBox(controls);
		}
		if (!seen) return fail("no_password_field");
	} else {
		const user = usernameBox(controls);
		if (user) await tools.callTool("browser_type", { element: user.name, target: user.ref, text: username });
	}

	const pass = passwordBox(controls);
	const submit = submitButton(controls);
	if (!pass) return fail("no_password_field");
	if (!submit) return fail("no_submit_button");
	await tools.callTool("browser_type", { element: pass.name, target: pass.ref, text: password });
	await tools.callTool("browser_click", { element: submit.name, target: submit.ref });

	for (let i = 0; i < LOOKS; i++) {
		await wait(LOOK_MS);
		const now = await pageUrl(tools);
		const seen = await snapshot(tools);
		const stop = obstacleOn(seen.text, seen.controls);
		if (stop) return fail(stop);
		if (now && !looksLikeSignIn(now, !!passwordBox(seen.controls))) {
			target.emit({ type: "policy.decision", domain: new URL(now).hostname, detail: { tool: "vault_sign_in", class: "session", decision: "signed_in", site } });
			target.resume();
			return { state: "signed_in" };
		}
	}
	return fail("not_signed_in");
}
