/**
 * The email-code sign-in (#1106): a fill run paused `login_required` on SEEK signs itself in.
 *
 * SEEK signs a jobseeker in with a code emailed to the account address. The page was read live
 * (2026-10-16): `au.seek.com/oauth/login?returnUrl=…` lands on `login.seek.com`, which offers
 * `textbox "Email address"` and `button "Email me a sign in code"`. The runner does the page half:
 * `request` enters the address the cloud names and asks for the code; `enter` types the code the
 * cloud read from the owner's connected Gmail and waits for the site to let the browser in. The cloud
 * does the mailbox half (`workers/api/src/lib/local-apply/email-code-sign-in.ts`); this machine never
 * touches a mailbox.
 *
 * It drives the run's own browser while the run is paused, so the CLI — blocked in its pause — never
 * sees the address or the code, and neither enters the trace: events carry the site and a reason.
 * Anything the page does not offer (no email box, no code box, still on the sign-in page after the
 * code) ends `failed`, and the pause stays for the owner: this is the default path, never the only one.
 *
 * Not verified live: the code-entry page (reaching it sends a real code to a real inbox). It is read
 * by role and name — one code box, or one box per digit — the same way as the first page.
 */
import { RunnerInputError } from "../errors.js";
import { type BrowserTools, evaluateResult } from "../local-browser/bridge.js";
import { EMAIL_CODE_SIGN_IN_SITES, type LocalApplyEmailCodeFailure, type LocalApplyEmailCodeResult, type LocalApplyEvent } from "./contract.js";
import { looksLikeSignIn, siteKeyOf } from "./site-session.js";

export interface EmailCodeTarget {
	tools: BrowserTools;
	emit(event: Omit<LocalApplyEvent, "at">): void;
	/** Release the run's sign-in pause; the bridge then records the session as after an owner's sign-in. */
	resume(): void;
	/** Injectable so tests do not wait in real time. */
	wait?(ms: number): Promise<void>;
}

const EMAIL_FIELD = /e-?mail/i;
const SEND_BUTTON = /^(email|send) me an? (sign[- ]?in |log[- ]?in |verification )?code$|^send (an? )?(sign[- ]?in |verification )?code$/i;
const CODE_FIELD = /code|one[- ]?time|verification|otp|passcode|digit/i;
const CONFIRM_BUTTON = /^(verify|continue|sign in|log in|submit|confirm|next)\b/i;
const LOOKS = 6;
const LOOK_MS = 2000;

type Control = { role: string; name: string; ref: string };

/** Every `- role "name" [ref=…]` line of a snapshot. */
export function controlsOf(snapshot: string): Control[] {
	const out: Control[] = [];
	for (const line of snapshot.split("\n")) {
		const m = line.match(/^\s*-\s*([a-z]+)(?:\s+"([^"]*)")?[^\n]*\[ref=([^\]\s]+)\]/i);
		if (m) out.push({ role: m[1].toLowerCase(), name: m[2] ?? "", ref: m[3] });
	}
	return out;
}

/** The box(es) a code goes in: one named for a code, or one box per digit (4–8 unnamed or "digit" boxes). */
export function codeBoxes(controls: Control[]): Control[] {
	const boxes = controls.filter((c) => (c.role === "textbox" || c.role === "spinbutton") && !EMAIL_FIELD.test(c.name));
	const named = boxes.find((c) => CODE_FIELD.test(c.name) && !/digit\s*\d/i.test(c.name));
	if (named) return [named];
	const perDigit = boxes.filter((c) => !c.name || /digit/i.test(c.name));
	return perDigit.length >= 4 && perDigit.length <= 8 ? perDigit : [];
}

const textOf = (r: { content?: Array<{ text?: string }> }) => (r.content ?? []).map((c) => c.text ?? "").join("\n");

async function snapshot(tools: BrowserTools): Promise<Control[]> {
	return controlsOf(textOf(await tools.callTool("browser_snapshot", {}).catch(() => ({ content: [] }))));
}

async function pageUrl(tools: BrowserTools): Promise<string | null> {
	const res = await tools.callTool("browser_evaluate", { function: "() => location.href" }).catch(() => null);
	const v = res && !res.isError ? evaluateResult(textOf(res)) : null;
	return typeof v === "string" ? v : null;
}

/** Run one step on a run paused for a sign-in. Never throws for a page that is not as expected. */
export async function runEmailCodeStep(target: EmailCodeTarget, raw: unknown): Promise<LocalApplyEmailCodeResult> {
	const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const wait = target.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const { tools } = target;
	const url = await pageUrl(tools);
	const host = url ? new URL(url).hostname : "";
	const site = host ? siteKeyOf(host) : "";
	const fail = (reason: LocalApplyEmailCodeFailure): LocalApplyEmailCodeResult => {
		target.emit({ type: "policy.decision", ...(host ? { domain: host } : {}), detail: { tool: "email_code_sign_in", class: "session", decision: "failed", reason, ...(site ? { site } : {}) } });
		return { state: "failed", reason };
	};
	if (!url || !EMAIL_CODE_SIGN_IN_SITES.includes(site)) return fail("unsupported_site");

	if (o.step === "request") {
		const email = typeof o.email === "string" ? o.email.trim() : "";
		if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) throw new RunnerInputError("request needs the sign-in email");
		// A pause before the press (#1094) is on the job page: open SEEK's sign-in, returning to that page.
		if (!looksLikeSignIn(url, false)) {
			const u = new URL(url);
			await tools.callTool("browser_navigate", { url: `https://${u.host}/oauth/login?returnUrl=${encodeURIComponent(u.pathname + u.search)}` });
			await wait(LOOK_MS);
		}
		const first = await snapshot(tools);
		const box = first.find((c) => c.role === "textbox" && EMAIL_FIELD.test(c.name));
		if (!box) return fail("no_email_field");
		const send = first.find((c) => c.role === "button" && SEND_BUTTON.test(c.name.trim()));
		if (!send) return fail("no_send_button");
		await tools.callTool("browser_type", { element: box.name, target: box.ref, text: email });
		await tools.callTool("browser_click", { element: send.name, target: send.ref });
		for (let i = 0; i < LOOKS; i++) {
			await wait(LOOK_MS);
			if (codeBoxes(await snapshot(tools)).length) {
				target.emit({ type: "policy.decision", domain: host, detail: { tool: "email_code_sign_in", class: "session", decision: "code_requested", site } });
				return { state: "code_requested" };
			}
		}
		return fail("no_code_field");
	}

	if (o.step === "enter") {
		const code = typeof o.code === "string" ? o.code.trim() : "";
		if (!/^[A-Za-z0-9]{4,10}$/.test(code)) throw new RunnerInputError("enter needs the code");
		const controls = await snapshot(tools);
		const boxes = codeBoxes(controls);
		if (!boxes.length || (boxes.length > 1 && boxes.length !== code.length)) return fail("no_code_field");
		if (boxes.length === 1) await tools.callTool("browser_type", { element: boxes[0].name || "code", target: boxes[0].ref, text: code });
		else for (const [i, b] of boxes.entries()) await tools.callTool("browser_type", { element: b.name || `digit ${i + 1}`, target: b.ref, text: code[i] });
		// Some code pages sign in as the last digit lands; the rest have a button.
		const confirm = controls.find((c) => c.role === "button" && CONFIRM_BUTTON.test(c.name.trim()) && !/resend|email me|send/i.test(c.name));
		if (confirm) await tools.callTool("browser_click", { element: confirm.name, target: confirm.ref }).catch(() => undefined);
		for (let i = 0; i < LOOKS; i++) {
			await wait(LOOK_MS);
			const now = await pageUrl(tools);
			if (now && !looksLikeSignIn(now, false) && !codeBoxes(await snapshot(tools)).length) {
				target.emit({ type: "policy.decision", domain: new URL(now).hostname, detail: { tool: "email_code_sign_in", class: "session", decision: "signed_in", site } });
				target.resume();
				return { state: "signed_in" };
			}
		}
		return fail("code_rejected");
	}
	throw new RunnerInputError("step must be request or enter");
}
