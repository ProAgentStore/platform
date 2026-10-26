/**
 * Account creation (#1230, #1226 ask 2): a fill run paused `login_required` on a site where the owner has no account opens the site's own sign-up
 * form on the paused run's page, fills it from the owner's profile, and — once the cloud has stored the new password in the vault — submits it.
 *
 * Three steps, each one request from the cloud (`LOCAL_APPLY_ACCOUNT_CREATION_PATH`):
 *   • `prepare`  find the sign-up form (follow the sign-in page's "Create account" link if that is where the pause is), fill the NON-secret fields,
 *                and report whether the form asks for a password. Nothing is submitted. The cloud generates the password and stores it BEFORE step two.
 *   • `submit`   type the password, tick the terms box only when the owner authorised it for this site, press the form's own button, and look:
 *                a code box (the cloud reads the emailed code), a page past the form (created), or a reason it did not work.
 *   • `enter`    type the verification code.
 *
 * What it will not do, each ending the attempt with a reason so the owner gets the ordinary sign-in handoff:
 *   • get past a CAPTCHA or any proof-of-a-human challenge (`captcha`), at any step;
 *   • agree to a site's terms unless `acceptTerms` is true (`terms_required`) — accepting terms is the owner's act, authorised per host;
 *   • tick a marketing / newsletter / alerts box, ever;
 *   • invent a value: a required field the profile has nothing for ends `field_required`;
 *   • create a second account where the email is already registered (`email_taken`).
 *
 * The profile and the password pass through one request and are never kept, traced, logged or shown to the CLI: events carry the site, a decision
 * and a reason — nothing typed. It reads the page by role and name like the sign-in flows.
 *
 * Not verified live: no site's sign-up page was driven for a real registration. The page shapes it expects are exercised on recorded snapshots.
 */
import { RunnerInputError } from "../errors.js";
import { type BrowserTools, evaluateResult } from "../local-browser/bridge.js";
import type { LocalApplyAccountCreationFailure, LocalApplyAccountCreationResult, LocalApplyAccountProfile, LocalApplyEvent } from "./contract.js";
import { codeBoxes, controlsOf } from "./email-code.js";
import { looksLikeSignIn, siteKeyOf } from "./site-session.js";
import { looksLikeCaptcha } from "./vault-sign-in.js";

export interface AccountCreationTarget {
	tools: BrowserTools;
	emit(event: Omit<LocalApplyEvent, "at">): void;
	/** Release the run's sign-in pause once the site lets the browser in. */
	resume(): void;
	/** Injectable so tests do not wait in real time. */
	wait?(ms: number): Promise<void>;
}

const FIRST = /first ?name|given ?name|forename/i;
const LAST = /last ?name|family ?name|surname/i;
const FULL = /^(your |full )?name\b/i;
const EMAIL = /e-?mail/i;
const PHONE = /phone|mobile/i;
const WHERE = /location|city|suburb|town|post ?code|zip/i;
const LINKEDIN = /linked-?in/i;
const PASSWORD = /pass ?word/i;
const CONFIRM = /confirm|re-?(enter|type)|repeat|again/i;
const REQUIRED = /\*|\brequired\b/i;
const SIGNUP_ENTRY = /^(create (an? |your )?(new )?account|sign[- ]?up|register|join( now| us)?)\b/i;
/** Not a way in for THIS account: "with Google", "already have an account", the sign-in and reset links. */
const NOT_THIS_ACCOUNT = /\bwith\b|google|apple|facebook|linkedin|microsoft|github|already|sign[- ]?in|log[- ]?in|forgot|reset/i;
const SUBMIT = /^(create (an? |your )?(new )?account|sign[- ]?up|register|join( now| us)?|continue|next|submit)\b/i;
const TERMS = /terms|conditions|privacy|agree|accept/i;
/** Never ticked, whatever else the label says. */
const MARKETING = /newsletter|marketing|promotion|offers|job alerts?|updates|e-?mails? me|contact me|subscribe|notify/i;
const TAKEN = /already (registered|exists|in use|have an account|associated)|is (already )?taken|account (with this e-?mail )?(already )?exists|e-?mail (is |address is )?(already )?(in use|taken|registered)/i;
const SIGNUP_URL = /sign-?up|register|join|create|new-account/i;
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

/** Refs of checkboxes the snapshot already shows ticked — a click would UNtick them. */
export function checkedRefs(snapshotText: string): Set<string> {
	const out = new Set<string>();
	for (const line of snapshotText.split("\n")) {
		const m = line.match(/-\s*checkbox\b[^\n]*\[checked\][^\n]*\[ref=([^\]\s]+)\]|-\s*checkbox\b[^\n]*\[ref=([^\]\s]+)\][^\n]*\[checked\]/i);
		if (m) out.add(m[1] ?? m[2]);
	}
	return out;
}

const textboxes = (cs: Control[]) => cs.filter((c) => c.role === "textbox" || c.role === "spinbutton");
const passwordBoxes = (cs: Control[]) => textboxes(cs).filter((c) => PASSWORD.test(c.name));
const emailBox = (cs: Control[]) => textboxes(cs).find((c) => EMAIL.test(c.name) && !PASSWORD.test(c.name));
const nameBox = (cs: Control[]) => textboxes(cs).find((c) => FIRST.test(c.name) || LAST.test(c.name) || FULL.test(c.name));
/** The terms boxes: a checkbox about terms or privacy that is not also an offer to be marketed to. */
export const termsBoxes = (cs: Control[]) => cs.filter((c) => c.role === "checkbox" && TERMS.test(c.name) && !MARKETING.test(c.name));
const submitButton = (cs: Control[]) => cs.find((c) => c.role === "button" && SUBMIT.test(c.name.trim()) && !NOT_THIS_ACCOUNT.test(c.name));

/**
 * Is this a sign-up form? A sign-IN page also has an email box and often a password box, so those alone prove nothing. What a sign-up form has
 * that a sign-in page does not: a name box, a "confirm password" box, or a sign-up address.
 */
export function isSignUpForm(controls: Control[], url: string): boolean {
	if (!emailBox(controls)) return false;
	return !!nameBox(controls) || passwordBoxes(controls).some((c) => CONFIRM.test(c.name)) || SIGNUP_URL.test(url);
}

const strOf = (v: unknown, max: number): string => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Validate the profile the cloud sent; throws for a request that is not one (a runner bug, not a page problem). */
function profileOf(raw: unknown): LocalApplyAccountProfile {
	const p = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const email = strOf(p.email, 254);
	const firstName = strOf(p.firstName, 100);
	const lastName = strOf(p.lastName, 100);
	if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !firstName || !lastName) throw new RunnerInputError("prepare needs the profile's first name, last name and email");
	const phone = strOf(p.phone, 40);
	const location = strOf(p.location, 200);
	const linkedin = strOf(p.linkedin, 300);
	return { firstName, lastName, email, ...(phone ? { phone } : {}), ...(location ? { location } : {}), ...(linkedin ? { linkedin } : {}) };
}

/** Run one step on a run paused for a sign-in. Never throws for a page that is not as expected. */
export async function runAccountCreationStep(target: AccountCreationTarget, raw: unknown): Promise<LocalApplyAccountCreationResult> {
	const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const wait = target.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const { tools } = target;
	const wanted = typeof o.host === "string" ? o.host.trim().toLowerCase() : "";
	if (!/^[a-z0-9.-]{3,253}$/.test(wanted)) throw new RunnerInputError("account creation needs the host");
	if (o.step !== "prepare" && o.step !== "submit" && o.step !== "enter") throw new RunnerInputError("step must be prepare, submit or enter");

	const url = await pageUrl(tools);
	const host = url ? new URL(url).hostname : "";
	const site = host ? siteKeyOf(host) : "";
	const decide = (decision: string, extra: Record<string, string | boolean> = {}) =>
		target.emit({ type: "policy.decision", ...(host ? { domain: host } : {}), detail: { tool: "account_creation", class: "session", decision, ...(site ? { site } : {}), ...extra } });
	const fail = (reason: LocalApplyAccountCreationFailure): LocalApplyAccountCreationResult => {
		decide("failed", { reason });
		return { state: "failed", reason };
	};
	// The profile and the password belong to ONE site. A page anywhere else — an identity provider — gets nothing typed.
	if (!url || !site || site !== siteKeyOf(wanted)) return fail("host_mismatch");

	let { text, controls } = await snapshot(tools);
	if (looksLikeCaptcha(text)) return fail("captcha");

	if (o.step === "prepare") {
		const profile = profileOf(o.profile);
		if (!isSignUpForm(controls, url)) {
			// The pause is on the sign-in page: follow the site's own way to the sign-up form.
			const entry = controls.find((c) => (c.role === "link" || c.role === "button") && SIGNUP_ENTRY.test(c.name.trim()) && !NOT_THIS_ACCOUNT.test(c.name));
			if (!entry) return fail("no_signup_link");
			await tools.callTool("browser_click", { element: entry.name, target: entry.ref });
			let found = false;
			for (let i = 0; i < LOOKS && !found; i++) {
				await wait(LOOK_MS);
				({ text, controls } = await snapshot(tools));
				if (looksLikeCaptcha(text)) return fail("captcha");
				// After following the link any page with an email box is the form (a passwordless sign-up asks for nothing else).
				found = !!emailBox(controls);
			}
			if (!found) return fail("no_signup_form");
		}
		if (!emailBox(controls)) return fail("no_email_field");

		// Fill what is not secret, by what each box is named. A required box with nothing to put in it ends the attempt: nothing is invented.
		for (const c of textboxes(controls)) {
			if (PASSWORD.test(c.name)) continue;
			let value: string | undefined;
			if (EMAIL.test(c.name)) value = profile.email;
			else if (FIRST.test(c.name)) value = profile.firstName;
			else if (LAST.test(c.name)) value = profile.lastName;
			else if (FULL.test(c.name)) value = `${profile.firstName} ${profile.lastName}`;
			else if (PHONE.test(c.name)) value = profile.phone;
			else if (WHERE.test(c.name)) value = profile.location;
			else if (LINKEDIN.test(c.name)) value = profile.linkedin;
			if (value === undefined) {
				if (REQUIRED.test(c.name)) return fail("field_required");
				continue;
			}
			await tools.callTool("browser_type", { element: c.name, target: c.ref, text: value });
		}
		const needsPassword = passwordBoxes(controls).length > 0;
		decide("prepared", { needsPassword });
		return { state: "prepared", needsPassword };
	}

	if (o.step === "enter") {
		const code = strOf(o.code, 10);
		if (!/^[A-Za-z0-9]{4,10}$/.test(code)) throw new RunnerInputError("enter needs the code");
		const boxes = codeBoxes(controls);
		if (!boxes.length || (boxes.length > 1 && boxes.length !== code.length)) return fail("no_code_field");
		if (boxes.length === 1) await tools.callTool("browser_type", { element: boxes[0].name || "code", target: boxes[0].ref, text: code });
		else for (const [i, b] of boxes.entries()) await tools.callTool("browser_type", { element: b.name || `digit ${i + 1}`, target: b.ref, text: code[i] });
		const confirm = controls.find((c) => c.role === "button" && /^(verify|continue|confirm|submit|next)\b/i.test(c.name.trim()) && !/resend|send/i.test(c.name));
		if (confirm) await tools.callTool("browser_click", { element: confirm.name, target: confirm.ref }).catch(() => undefined);
		for (let i = 0; i < LOOKS; i++) {
			await wait(LOOK_MS);
			const now = await pageUrl(tools);
			const seen = await snapshot(tools);
			if (looksLikeCaptcha(seen.text)) return fail("captcha");
			if (now && !looksLikeSignIn(now, false) && !codeBoxes(seen.controls).length && !isSignUpForm(seen.controls, now)) {
				decide("created");
				target.resume();
				return { state: "created" };
			}
		}
		return fail("code_rejected");
	}

	// step === "submit"
	const password = typeof o.password === "string" ? o.password : "";
	if (password.length > 1024) throw new RunnerInputError("password is too long");
	const acceptTerms = o.acceptTerms === true;
	let typedPassword = false;
	for (let round = 0; round < 2; round++) {
		const pw = passwordBoxes(controls);
		if (pw.length && !typedPassword) {
			// The form asks for a password the cloud did not prepare for: there is nothing stored to type, and nothing is made up.
			if (!password) return fail("password_not_prepared");
			for (const c of pw) await tools.callTool("browser_type", { element: c.name, target: c.ref, text: password });
			typedPassword = true;
		}
		const ticked = checkedRefs(text);
		for (const box of termsBoxes(controls)) {
			if (ticked.has(box.ref)) continue;
			if (!acceptTerms) return fail("terms_required");
			await tools.callTool("browser_click", { element: box.name, target: box.ref });
		}
		const button = submitButton(controls);
		if (!button) return fail("no_submit_button");
		await tools.callTool("browser_click", { element: button.name, target: button.ref });

		let again = false;
		for (let i = 0; i < LOOKS && !again; i++) {
			await wait(LOOK_MS);
			const now = await pageUrl(tools);
			const seen = await snapshot(tools);
			text = seen.text;
			controls = seen.controls;
			if (looksLikeCaptcha(text)) return fail("captcha");
			if (TAKEN.test(text)) return fail("email_taken");
			if (codeBoxes(controls).length) {
				decide("code_requested");
				return { state: "code_requested" };
			}
			// A two-step form asks for the password on its second page.
			if (!typedPassword && passwordBoxes(controls).length && round === 0) again = true;
			else if (now && !emailBox(controls) && !passwordBoxes(controls).length && !looksLikeSignIn(now, false) && !SIGNUP_URL.test(now)) {
				decide("created");
				target.resume();
				return { state: "created" };
			}
		}
		if (!again) break;
	}
	return fail("not_created");
}
