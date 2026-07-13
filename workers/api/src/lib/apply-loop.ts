import { runUserWorkersAi } from "./user-ai.js";
import type { UsageContext } from "./usage.js";
import type { Env } from "../types.js";

/** The candidate + job context the brain applies with. */
export interface ApplyJob {
	url: string;
	resumePath: string;
	candidate: {
		fullName: string;
		email: string;
		phone?: string;
		location?: string;
		linkedin?: string;
		portfolio?: string;
		workAuthorization?: string;
		salaryExpectation?: string;
	};
	coverNote?: string;
	/** Stable password to use when an ATS requires an account (same every run). */
	password?: string;
	/** True if a credential is stored for this host → sign in; false → create account. */
	hasStoredLogin?: boolean;
	/** Test mode: fill everything and reach Submit, but DON'T click it. */
	dryRun?: boolean;
	/** Values the user supplied mid-run via ask-and-hold (field label → value). */
	providedAnswers?: Record<string, string>;
	/** The user's own rules for this agent (from KB → Special Instructions). */
	specialInstructions?: string;
	/** Live free-text message the user sent while the agent was paused/stuck. */
	userHint?: string;
	/** Job-search preferences (location/work-type/relocation) that guide answers. */
	preferences?: { targetRoles?: string; targetLocations?: string; workType?: string; openToRelocation?: string };
	/** Notes from a previous successful run on this ATS (the per-ATS cache). */
	cacheHint?: string;
	/** The candidate's Gmail is connected + email permitted → the brain may read it
	 *  for a one-time sign-in link / verification code instead of pausing. */
	emailEnabled?: boolean;
	/** Today's date (YYYY-MM-DD), stamped at trigger time — for eSignature / date fields
	 *  on legal-acknowledgement steps (the model can't reliably know the current date). */
	today?: string;
}

/** One action the runner performs on the live page (mirrors the runner's BrowserAction). */
export interface BrowserAction {
	action: "click" | "type" | "select" | "check" | "upload" | "navigate" | "scroll" | "key" | "wait";
	/** Stable element ref from the snapshot (e.g. "e42") — unambiguous targeting. */
	ref?: string;
	role?: string;
	name?: string;
	nth?: number;
	text?: string;
	file?: string;
	url?: string;
	key?: string;
	dy?: number;
	ms?: number;
}

export interface PageSnapshot {
	url: string;
	title: string;
	snapshot: string;
	challenge: string | null;
	/** True when the user pressed Stop — the loop halts immediately. */
	cancelled?: boolean;
}

export type ApplyOutcome = "submitted" | "ready" | "expired" | "blocked" | "captcha" | "stuck" | "needs_input" | "failed" | "max_steps" | "cancelled";

export interface ApplyDecision {
	thought?: string;
	action?: BrowserAction;
	finish?: { status: "submitted" | "ready" | "expired" | "blocked"; detail: string };
	/** The agent needs a value from the user (ask-and-hold). */
	needsInput?: { field: string; why?: string };
	/** Read the candidate's connected inbox for a sign-in link / verification code. */
	readEmail?: { from?: string; subject?: string; withinDays?: number };
	/** Token usage for the LLM call that produced this decision. */
	usage?: { input: number; output: number };
}

export interface ApplyResult {
	outcome: ApplyOutcome;
	detail?: string;
	challenge?: string | null;
	/** For outcome "needs_input": the field the agent is asking the user for. */
	fieldNeeded?: string;
	url?: string;
	steps: number;
	/** The actions taken this run — fed back into the per-ATS cache on success. */
	transcript?: string[];
	/** Whether any field was typed by the end of this round. Carried across handoff
	 *  re-entries so the dry-run submit guard stays armed after a captcha/input pause
	 *  (otherwise round ≥2 starts "empty" and a one-page Apply=submit could really submit). */
	filled?: boolean;
}

/** The minimum a job needs for the loop itself — everything else is read by the
 *  injected `decide`. Kept tiny so the loop is reusable by other browser verticals
 *  (e.g. flight booking) whose job shape differs entirely from an ApplyJob. */
export interface BrowserJobBase {
	dryRun?: boolean;
	userHint?: string;
}

/** Side-effecting hooks the loop drives — real ones hit the runner; tests mock them.
 *  Generic over the job type `J` so the SAME loop engine drives apply and booking. */
export interface ApplyDeps<J extends BrowserJobBase = ApplyJob> {
	snapshot: () => Promise<PageSnapshot>;
	/** Perform an action. A Playwright failure comes back as `error` (never throws) so the brain can adapt.
	 *  For write actions, `feedback` reports the field's real value + any validation error after the write. */
	act: (action: BrowserAction) => Promise<{ url: string; challenge: string | null; error?: string; feedback?: string }>;
	decide: (params: { job: J; actionLog: string[]; snapshot: PageSnapshot }) => Promise<ApplyDecision>;
	onEvent?: (type: string, message: string, data?: unknown) => Promise<void> | void;
	/** Read (and clear) any free-text message the user sent to this RUNNING task — so
	 *  guidance can be injected mid-flight, not only on a handoff resume. */
	pollHint?: () => Promise<string | null>;
	/** Read the candidate's connected Gmail for a one-time sign-in link / code.
	 *  Returns a short human-readable result the brain acts on next turn. Optional:
	 *  when absent (tests, email off), the read_email_link tool isn't offered. */
	readEmail?: (q: { from?: string; subject?: string; withinDays?: number }) => Promise<string>;
}

/**
 * The remote brain's apply loop: look at the page, decide one action, do it,
 * repeat — until the application is submitted, the job is expired, or a CAPTCHA
 * forces a human handoff. Pure orchestration over {@link ApplyDeps} so it can be
 * unit-tested without a browser, an LLM, or a deployed Workflow.
 */
export async function runApplyLoop<J extends BrowserJobBase = ApplyJob>(deps: ApplyDeps<J>, job: J, opts: { maxSteps?: number; solvedChallengeUrl?: string; tokens?: { input: number; output: number }; filled?: boolean } = {}): Promise<ApplyResult> {
	const maxSteps = opts.maxSteps ?? 40;
	// After a human solves a captcha, its widget/"not a robot" text usually lingers
	// on the SAME page for the rest of the form, so re-detecting it would ping-pong
	// straight back to a handoff and never fill anything. So: suppress the captcha
	// handoff while we're still on the page where one was just solved; re-enable it
	// the moment the page navigates (a genuinely new captcha on a new page still
	// hands off). Compare without the URL hash. This is ATS-agnostic.
	const pageOf = (u: string) => (u || "").split("#")[0];
	const solvedPage = opts.solvedChallengeUrl ? pageOf(opts.solvedChallengeUrl) : "";
	const actionLog: string[] = [];
	let lastUrl = "";
	let lastActionKey = "";
	let repeatFails = 0;
	let pageKey = "";
	let failsOnPage = 0;
	// Shared so the caller can carry the running total across rounds (each handoff
	// re-enters runApplyLoop); without this, multi-round tasks would reset to 0.
	const tokens = opts.tokens ?? { input: 0, output: 0 };
	let actedLast = false;
	let lastSnapshot = "";
	let filledSomething = opts.filled ?? false; // any field typed → the application is in progress (dry-run safety); seeded from prior rounds
	let lastActionWasArrow = false; // last act was an arrow key (autocomplete nav) → a following Enter is an accept, not a submit
	const recentKeys: string[] = [];

	for (let step = 0; step < maxSteps; step++) {
		const snap = await deps.snapshot();
		if (snap.cancelled) {
			await deps.onEvent?.("agent.cancelled", "Stopped by the user", {});
			return { outcome: "cancelled", detail: "stopped by the user", url: snap.url, steps: step, transcript: [...actionLog] };
		}
		lastUrl = snap.url;
		// Fixation-guard reset — keyed on the URL only. A new URL = a new page, so a
		// same-named button across a funnel (careers → login → form) isn't fixation.
		// Deliberately NOT keyed on snapshot CONTENT: dynamic page text (timers,
		// carousels, ads) shifts every snapshot and would defeat the guard entirely,
		// letting a genuinely stuck agent thrash to max_steps instead of handing off.
		if (snap.url !== pageKey) { pageKey = snap.url; failsOnPage = 0; recentKeys.length = 0; }
		// No-change nudge — a SEPARATE, content-based signal: if the last action left
		// the snapshot byte-identical, the brain can't tell its "successful" click did
		// nothing, so surface it (so it varies approach before fixating). Safe under
		// dynamic content — any real change simply means no nudge.
		if (actedLast) {
			if (snap.snapshot === lastSnapshot) {
				actionLog.push("⚠ that action caused NO visible change to the page — the control may be wrong, disabled, or covered by a cookie/consent banner; try a DIFFERENT element or approach, do NOT repeat it");
			}
			actedLast = false;
		}
		lastSnapshot = snap.snapshot;

		// A CAPTCHA can't be solved by the model — hand off to the human, same session.
		// But don't re-hand-off for the page a human already solved one on (lingering
		// widget/text); only a captcha on a DIFFERENT page is a fresh one.
		if (snap.challenge && pageOf(snap.url) !== solvedPage) {
			await deps.onEvent?.("agent.captcha", `CAPTCHA detected (${snap.challenge}) — handing off`, { challenge: snap.challenge, url: snap.url });
			return { outcome: "captcha", challenge: snap.challenge, url: snap.url, steps: step, transcript: [...actionLog], filled: filledSomething };
		}

		// Mid-flight steering: pick up any message you sent to this RUNNING task and
		// make it top-priority guidance for THIS decision, then consume it (one-shot).
		const liveHint = deps.pollHint ? await deps.pollHint().catch(() => null) : null;
		if (liveHint) {
			job.userHint = liveHint;
			await deps.onEvent?.("agent.guidance", `Message from you: "${liveHint}"`, { hint: liveHint });
		}

		let decision: ApplyDecision;
		try {
			decision = await deps.decide({ job, actionLog, snapshot: snap });
		} catch (e) {
			// The brain step failed (e.g. the BYOK AI timed out or errored). Do NOT let it
			// crash the whole durable run with no output — hand off for this step so the
			// human can take over or it fails cleanly (and gets logged) on timeout.
			const msg = e instanceof Error ? e.message : String(e);
			await deps.onEvent?.("agent.decide_failed", `Deciding the next step failed: ${msg} — handing off`, { error: msg });
			return { outcome: "stuck", detail: `assistant error: ${msg}`, url: snap.url, steps: step, transcript: [...actionLog], filled: filledSomething };
		}
		if (liveHint) job.userHint = undefined; // applied to this step only
		if (decision.usage) { tokens.input += decision.usage.input; tokens.output += decision.usage.output; }
		await deps.onEvent?.(
			"agent.decision",
			decision.finish ? `finish: ${decision.finish.status}` : decision.action ? describeAction(decision.action) : "thinking",
			{ thought: decision.thought, action: decision.action, finish: decision.finish, tokensInput: tokens.input, tokensOutput: tokens.output },
		);

		if (decision.finish) {
			// If the model gives up because of a CAPTCHA the detector missed, route it
			// to a human takeover (captcha handoff) instead of failing the whole run.
			if (decision.finish.status === "blocked" && /captcha|not a robot|are you (a )?human|verify you('?re| are) human|anti-?bot/i.test(decision.finish.detail || "")) {
				await deps.onEvent?.("agent.captcha", `CAPTCHA the model can't solve — handing off (${decision.finish.detail})`, { challenge: "captcha", url: snap.url });
				return { outcome: "captcha", challenge: "captcha", detail: decision.finish.detail, url: snap.url, steps: step, transcript: [...actionLog], filled: filledSomething };
			}
			return { outcome: decision.finish.status, detail: decision.finish.detail, url: snap.url, steps: step, transcript: [...actionLog] };
		}
		if (decision.needsInput) {
			// Ask-and-hold: pause for the user to supply a value (same machinery as captcha).
			await deps.onEvent?.("agent.needs_input", `Needs your input — ${decision.needsInput.field}${decision.needsInput.why ? ` (${decision.needsInput.why})` : ""}`, decision.needsInput);
			return { outcome: "needs_input", fieldNeeded: decision.needsInput.field, detail: decision.needsInput.why, url: snap.url, steps: step, transcript: [...actionLog], filled: filledSomething };
		}
		if (decision.readEmail) {
			// Read the connected inbox for a sign-in link / code, feed the result back
			// into the log, and let the brain navigate to it next turn. Not a browser
			// act — no fixation/dry-run bookkeeping. Never throws (returns a message).
			const found = deps.readEmail
				? await deps.readEmail(decision.readEmail).catch((e) => `email read failed: ${e instanceof Error ? e.message : String(e)}`)
				: "email reading is not available for this agent";
			actionLog.push(`read_email_link → ${found}`);
			await deps.onEvent?.("agent.read_email", found, decision.readEmail);
			actedLast = false;
			continue;
		}
		if (!decision.action) {
			return { outcome: "failed", detail: decision.thought || "brain returned no action", url: snap.url, steps: step, transcript: [...actionLog] };
		}

		// Dry-run safety: once any field is filled, STOP before anything that could
		// submit. Two channels the old guard missed (only matched "Apply"): a final
		// button under any common terminal label (Submit/Send/Finish/Done, plus the
		// one-page "Apply"), and an Enter/Return keypress, which submits a focused
		// form. "Continue"/"Next"/"Review" are deliberately NOT matched — they advance
		// multi-page forms and must stay walkable in test mode. An Enter right after an
		// arrow key is an autocomplete accept, not a submit, so that case is allowed.
		if (job.dryRun && filledSomething) {
			const act = decision.action;
			const submitClick = act.action === "click" && /\b(apply|submit|send|finish|done)\b/i.test(act.name ?? "");
			const enterSubmit = act.action === "key" && /^(enter|return)$/i.test(act.key ?? "") && !lastActionWasArrow;
			if (submitClick || enterSubmit) {
				const label = act.name ?? act.key ?? "submit";
				await deps.onEvent?.("agent.dryrun", `Reached final "${label}" — stopping without submitting (test mode)`, {});
				return { outcome: "ready", detail: `reached final submit "${label}" — test mode, not submitted`, url: snap.url, steps: step, transcript: [...actionLog] };
			}
		}

		const key = JSON.stringify(decision.action);
		// Fixation guard (before acting): the brain keeps poking the SAME control
		// with no progress — e.g. a login that silently fails, so the click
		// "succeeds" but nothing advances (and repeated tries can trip a captcha).
		// Hand off rather than thrash. Scroll/wait are exempt (legit repetition).
		if (decision.action.action !== "scroll" && decision.action.action !== "wait") {
			recentKeys.push(key);
			if (recentKeys.length > 7) recentKeys.shift();
			if (recentKeys.filter((k) => k === key).length >= 4) {
				// DIAGNOSTIC: capture the full page (ARIA tree) at the stuck point — it shows
				// every field, disabled-button state, checkbox checked/unchecked, and any
				// validation text, so a "button won't advance" cause is knowable, not guessed.
				await deps.onEvent?.("agent.stuck", `Repeated "${describeAction(decision.action)}" with no progress — handing off`, { action: decision.action, url: snap.url, stuckSnapshot: snap.snapshot, recentActions: [...actionLog].slice(-8) });
				return { outcome: "stuck", detail: describeAction(decision.action), url: snap.url, steps: step, transcript: [...actionLog], filled: filledSomething };
			}
		}

		const actResult = await deps.act(decision.action);
		if (actResult?.error) {
			// Feed the failure back so the brain adapts instead of blindly repeating.
			repeatFails = key === lastActionKey ? repeatFails + 1 : 1;
			lastActionKey = key;
			failsOnPage += 1;
			actionLog.push(`${describeAction(decision.action)} — FAILED: ${actResult.error}`);
			await deps.onEvent?.("agent.action_failed", `${describeAction(decision.action)} failed: ${actResult.error}`, { action: decision.action, error: actResult.error });
			// Can't proceed after trying → hand off to the human for THIS step (the
			// workflow turns "stuck" into a takeover), then resume. Trips on a pure
			// repeat (3×) OR on several different-but-failing attempts on one page (the
			// brain thrashing a stubborn widget), so it never burns to max-steps.
			if (repeatFails >= 3 || failsOnPage >= 4) {
				// DIAGNOSTIC: same as the fixation guard — record the page so a repeated-failure
				// stuck (a widget the agent can't operate) is diagnosable from the transcript.
				await deps.onEvent?.("agent.stuck", `Stuck after repeated failures on "${describeAction(decision.action)}" — handing off`, { action: decision.action, url: snap.url, lastError: actResult.error, stuckSnapshot: snap.snapshot, recentActions: [...actionLog].slice(-8) });
				return { outcome: "stuck", detail: describeAction(decision.action), url: snap.url, steps: step, transcript: [...actionLog], filled: filledSomething };
			}
		} else {
			repeatFails = 0;
			lastActionKey = "";
			// Arm the dry-run submit block on ANY field-mutating action — not just `type`.
			// A form that's all dropdowns/checkboxes + a résumé upload (name/email pre-filled
			// from the account) never fires a `type`, so a `type`-only flag left the guard
			// disarmed and a test-mode run could really click the final Submit.
			if (["type", "select", "check", "upload"].includes(decision.action.action)) filledSomething = true;
			// Track arrow-key nav so a following Enter is an autocomplete accept
			// (allowed in dry-run), not a form submit.
			lastActionWasArrow = decision.action.action === "key" && /^arrow/i.test(decision.action.key ?? "");
			// Surface the runner's write-back feedback (real value + validation error) so
			// the brain self-corrects a rejected/mangled input instead of resending it.
			actionLog.push(actResult.feedback ? `${describeAction(decision.action)} — ${actResult.feedback}` : describeAction(decision.action));
			// A click/select/check/type is expected to change the page; if the NEXT
			// snapshot shows no change, the loop top tells the brain so it adapts.
			actedLast = decision.action.action !== "scroll" && decision.action.action !== "wait";
		}
	}
	return { outcome: "max_steps", detail: `stopped after ${maxSteps} actions`, url: lastUrl, steps: maxSteps, transcript: [...actionLog] };
}

/** Human-readable one-liner for an action (for the action log + activity trace). */
export function describeAction(a: BrowserAction): string {
	switch (a.action) {
		case "type": return `type "${a.text ?? ""}" into ${a.role ?? "field"} "${a.name ?? ""}"`;
		case "select": return `select "${a.text ?? ""}" in "${a.name ?? ""}"`;
		case "check": return `check "${a.name ?? ""}"`;
		case "click": return `click ${a.role ?? "button"} "${a.name ?? ""}"`;
		case "upload": return `upload résumé to "${a.name ?? "file field"}"`;
		case "navigate": return `navigate to ${a.url ?? ""}`;
		case "scroll": return `scroll ${a.dy ?? 600}px`;
		case "key": return `press ${a.key ?? "Enter"}`;
		case "wait": return `wait ${a.ms ?? 1000}ms`;
		default: return a.action;
	}
}

// ── The LLM decision step ────────────────────────────────────────────────────

function tool(name: string, description: string, props: Record<string, { type: string; description: string }>, required: string[]) {
	return { type: "function" as const, function: { name, description, parameters: { type: "object", properties: props, required } } };
}

/** The browser actions exposed to Claude as tools — target by the snapshot's [ref=eNN]
 *  (preferred, unambiguous) plus the accessible name for readability. */
const REF = { type: "string", description: 'the element\'s ref from the snapshot, e.g. "e42" — ALWAYS include it; it targets the exact element even when two fields share a label' };
export const BROWSER_TOOLS = [
	tool("type", "Type text into a field. Target it by its snapshot ref.", {
		ref: REF,
		role: { type: "string", description: 'usually "textbox"' },
		name: { type: "string", description: "the field's label/accessible name from the snapshot" },
		text: { type: "string", description: "text to type" },
	}, ["ref", "text"]),
	tool("select", "Choose an option in a dropdown/combobox. Target the control by its snapshot ref.", {
		ref: REF,
		name: { type: "string", description: "the select's label" },
		value: { type: "string", description: "the option label to choose" },
	}, ["ref", "value"]),
	tool("check", "Check a radio button or checkbox. Target it by its snapshot ref.", {
		ref: REF,
		name: { type: "string", description: "the option's label" },
	}, ["ref"]),
	tool("click", "Click a button or link. Target it by its snapshot ref.", {
		ref: REF,
		role: { type: "string", description: '"button" or "link"' },
		name: { type: "string", description: "the control's visible text/label" },
	}, ["ref"]),
	tool("upload", "Upload the candidate's résumé to a file field (the file is attached automatically). Target it by its snapshot ref.", {
		ref: REF,
		name: { type: "string", description: "the upload control's label, e.g. \"Resume\"" },
	}, ["ref"]),
	tool("navigate", "Go to a URL (e.g. the application page).", {
		url: { type: "string", description: "absolute http(s) URL" },
	}, ["url"]),
	tool("scroll", "Scroll the page vertically to reveal more.", {
		dy: { type: "number", description: "pixels (positive = down)" },
	}, []),
	tool("press_key", "Press a keyboard key like Enter or Tab.", {
		key: { type: "string", description: "e.g. Enter, Tab, Escape" },
	}, ["key"]),
	tool("request_user_info", "Ask the USER for a REQUIRED value you don't have (e.g. phone, salary expectation). Use this INSTEAD of inventing or guessing a value. The application pauses until they answer, then resumes.", {
		field: { type: "string", description: 'the field you need, e.g. "phone" or "salary expectation"' },
		why: { type: "string", description: "brief reason / where it's needed on the form" },
	}, ["field"]),
	tool("finish", "End the application: status submitted (you saw a confirmation), expired (job closed), or blocked (cannot proceed truthfully).", {
		status: { type: "string", description: "submitted | expired | blocked" },
		detail: { type: "string", description: "short explanation / confirmation text" },
	}, ["status", "detail"]),
];

/** Extra tool offered ONLY when the candidate's Gmail is connected + permitted. */
const READ_EMAIL_TOOL = tool(
	"read_email_link",
	"Read the candidate's connected inbox for a one-time sign-in link or verification code (e.g. a magic-link login or an email-confirmation step). Returns the most likely link and any code. Use it when the page says it emailed a link/code — then `navigate` to the link or `type` the code. Do NOT ask the user for a link you can read yourself.",
	{
		from: { type: "string", description: "sender domain/name to match, e.g. the ATS or company (optional but improves accuracy)" },
		subject: { type: "string", description: "words expected in the subject, e.g. \"sign in\" or \"verify\" (optional)" },
		within_days: { type: "number", description: "how recent, default 1" },
	},
	[],
);

/** Build the system prompt that turns Claude into a job-application driver. */
export function applySystemPrompt(job: ApplyJob): string {
	const c = job.candidate;
	const lines = [
		"You are a job-application agent operating a real web browser through tools.",
		"You see each page as an accessibility snapshot: every element shows its role, accessible name, current value, state (e.g. [disabled], [checked], [expanded], [active]), and a stable reference like [ref=e42]. You act ONLY through the provided tools — no CSS selectors.",
		"- TARGET BY REF: always pass the element's exact `ref` from the snapshot (e.g. \"e42\") to type/select/check/click/upload. The ref points at the EXACT element, so two fields sharing a label (e.g. a phone-country \"Country\" and an address \"Country\") are never confused. Include the accessible name too for clarity.",
		"- Read element STATE: a field marked [disabled] or [readonly] is already set and cannot be changed — do NOT try; move on. [checked]/[expanded] tell you a control's current state.",
		job.userHint
			? `\n‼️ LIVE MESSAGE FROM THE USER — they are watching you right now and just sent this; it describes the CURRENT screen. TRUST IT over your previous assumption: re-read the snapshot fresh and act on this, do NOT repeat the action you were stuck on. Message: "${job.userHint}"\n`
			: "",
		job.specialInstructions
			? `\n★ USER'S SPECIAL INSTRUCTIONS — follow these strictly; they OVERRIDE any default behavior below:\n${job.specialInstructions}\n`
			: "",
		"",
		job.dryRun
			? "Goal (TEST MODE): walk the whole application — Apply, any account/login, every form step, screening questions, résumé upload — and fill EVERYTHING, but DO NOT submit. When the form is fully filled and you've reached the final Submit/Send button, call finish(status:\"ready\", detail:\"<what you filled / what the submit button says>\"). Never click the final submit."
			: "Goal: complete and SUBMIT this job application for the candidate, walking through every step (Apply button, account creation/login if required, multi-step forms, screening questions).",
		"",
		"CANDIDATE:",
		`- Full name: ${c.fullName}`,
		`- Email: ${c.email}`,
		c.phone ? `- Phone: ${c.phone}` : "",
		c.location ? `- Location: ${c.location}` : "",
		c.linkedin ? `- LinkedIn: ${c.linkedin}` : "",
		c.portfolio ? `- Portfolio: ${c.portfolio}` : "",
		c.workAuthorization ? `- Work authorization: ${c.workAuthorization}` : "",
		c.salaryExpectation ? `- Salary expectation: ${c.salaryExpectation}` : "",
		...(job.preferences && (job.preferences.targetLocations || job.preferences.workType || job.preferences.openToRelocation || job.preferences.targetRoles)
			? [
				"JOB PREFERENCES (use to answer location / work-type / relocation / willingness questions consistently):",
				job.preferences.targetRoles ? `  • Target roles: ${job.preferences.targetRoles}` : "",
				job.preferences.targetLocations ? `  • Target locations: ${job.preferences.targetLocations}` : "",
				job.preferences.workType ? `  • Work type: ${job.preferences.workType}` : "",
				job.preferences.openToRelocation ? `  • Open to relocation: ${job.preferences.openToRelocation}` : "",
			]
			: []),
		...(job.providedAnswers && Object.keys(job.providedAnswers).length
			? ["- Values you asked the user for (use these, don't ask again):", ...Object.entries(job.providedAnswers).map(([k, v]) => `  • ${k}: ${v}`)]
			: []),
		job.coverNote ? `- Cover note: ${job.coverNote}` : "",
			"- Résumé / file uploads: ATTACH THE RÉSUMÉ EARLY. As soon as a résumé/CV upload control is present (e.g. 'Upload Resume', 'Upload CV', 'Attach resume', a file drop-zone), use the `upload` tool on it BEFORE filling the text fields — do NOT skip it. The résumé is required even when the upload control looks optional or sits among other import buttons (LinkedIn / Dropbox / Google Drive / OneDrive — IGNORE those, they are not the résumé upload; use `upload` on the résumé control). ALWAYS use the `upload` tool (the file is supplied automatically — never ask for a path); do NOT `click` a 'Browse' / 'Choose file' / 'Upload your CV' button to open a file picker — use `upload` directly on it.",
		job.password ? `- Account password: ${job.password} — use EXACTLY this in both Password and Confirm password. Never invent a different password.` : "",
		"",
		"ACCOUNT:",
		job.hasStoredLogin
			? "- You HAVE a saved login for this site. If it asks you to sign in or register, choose **Sign in / Log in** and use the candidate email + the account password above."
			: "- You have NO saved login for this site (this is your first application here). If the page offers BOTH 'Sign in' and 'Create an account' / 'Register', choose **Create an account** and register with the candidate email + the account password above. Do NOT try to Sign in first — the account does not exist yet.",
		"- After clicking 'Create an account' / 'Register', a registration FORM appears — fill it (name, email, password, confirm password) and submit it. Do NOT click the 'Create an account' link again; act on the new form fields in the snapshot.",
		"- If you try to register and the email is ALREADY REGISTERED ('already exists', 'email is taken'), switch to Sign in / Log in with the same email + the account password above.",
		job.emailEnabled
			? "- Some sites sign you in with a ONE-TIME LINK or CODE emailed to the candidate (passwordless / magic-link), or ask you to confirm your email. You CAN read the candidate's connected inbox: call read_email_link(from, subject) to fetch the link + any code, then `navigate` to the link (or `type` the code into the field). Only if that returns nothing after a short wait should you request_user_info or finish(blocked)."
			: "- Some sites email a verification/confirmation link after registration. If you're blocked waiting on email verification and have no way to read it, call finish(status:\"blocked\", detail:\"email verification required to continue\").",
		"",
		"RULES:",
		"- Do exactly ONE tool call per turn — the next page snapshot follows.",
		"- If the action log shows your last action FAILED (e.g. a click timed out), DO NOT repeat it. The page likely already advanced, opened a new tab, or the element moved — re-read the CURRENT snapshot and act on what's there now (a different button, the next field, or scroll to find it).",
		"- After clicking something like Apply/Next/Continue, expect the page to change; act on the NEW snapshot, not the element you just clicked.",
		"- DROPDOWNS / COMBOBOXES: first try the `select` tool with the value. If `select` FAILS with an error like \"not a <select>\" or \"Element is not a <select>\", the control is a CUSTOM combobox (a JS/React widget, common on modern application forms) — do NOT retry `select` on it. Instead: `click` the control to open it, then `click` the matching option now shown in the snapshot. If many options appear, `type` a few letters to filter first, then `click` the option (or press_key ArrowDown then Enter). One failed `select` is enough to know it's custom — switch to click-to-open immediately.",
		"- AUTOCOMPLETE TEXTBOX (city, suburb, address, school, company): some of these LOOK like a plain `textbox` in the snapshot but only accept a value when you PICK a suggestion. If you `type` into such a field and it does not stick (the action log says no visible change, the field still reads empty, or a list of options/suggestions is now open), DO NOT retype the same text. Instead: CLICK the matching suggestion/option shown in the snapshot, or press_key \"ArrowDown\" then press_key \"Enter\" to accept the first match. If still stuck, try `select` on that field.",
		"- To FIX or CLEAR a field that has the wrong value (e.g. text landed in the wrong box), just call `type` again with the correct value on that field — it REPLACES the existing text. There is no triple-click, double-click, or clear tool; never call those.",
		"- VALIDATION FEEDBACK: after you type/select, the log reports the field's ACTUAL value and any validation error, e.g. `⚠ \"<field>\" REJECTED: \"<message>\"` or `\"<field>\" now reads \"<value>\"`. CRITICAL: if the log says the field NOW READS the value you sent and that value is plausibly valid, the value TOOK — a lingering \"REJECTED\"/format error is often STALE (shown mid-typing, clears on blur/submit). Do NOT keep retyping that field; move on and let the form re-validate at submit. Only treat it as a real rejection if the value did NOT take (reads empty or different) or the SAME field is still flagged AFTER a submit attempt. When a value truly didn't take (a masked or country-code field), try a MATERIALLY DIFFERENT format, and after ~3 distinct tries call request_user_info — never resend a value that genuinely didn't take.",
		"- FILL EVERY REQUIRED FIELD before submitting. Scan the snapshot for empty required fields (marked * or showing a 'required' message) and fill them from the candidate data (or request_user_info). If a submit is blocked, it is usually an EMPTY required field, NOT the field you just filled — find and fill the empty one instead of re-editing a filled field.",
		"- 'Required' or '*' in a control's label/name is just a REQUIRED-FIELD MARKER — it does NOT mean the field is empty. A control like button \"Australian Permanent Resident Required\" that DISPLAYS a value ('Australian Permanent Resident') is ALREADY FILLED with that value; treat it as done. A field is only empty if it shows 'Select One' / 'Select...' / blank. Never re-open or re-fill a control that already shows a chosen value just because its label contains 'Required'.",
		"- STUBBORN WIDGET: if a field won't accept input, the feedback may include its real DOM (`DOM: <tag> …`). USE it to change approach — do NOT repeat the same failing action. If the DOM shows a custom dropdown (a button/div that opens a list, role=combobox/listbox, an options `<ul>`), use the `select` tool with the option's visible label (it opens the control, waits for options, and clicks for you). If it's a masked/format input, try the value in a different shape. If two different approaches still fail, request_user_info or move on to other fields.",
		`- The ONLY tools that exist are: type, select, check, click, upload, navigate, scroll, press_key, request_user_info, finish${job.emailEnabled ? ", read_email_link" : ""}. Never call any other tool name.`,
		"- NEVER invent data. Use ONLY the candidate values above. Do not make up a phone number, salary, address, or any value you weren't given. For a REQUIRED field you don't have a value for, call request_user_info(field, why) to ask the user and wait — do NOT guess or fabricate.",
		"- Demographic / EEO / voluntary self-identification questions (gender, race, ethnicity, veteran status, disability): ALWAYS choose \"Decline to self-identify\" / \"I don't wish to answer\" / \"Prefer not to say\" unless a candidate value above explicitly provides it. Never guess these.",
		"- You may answer genuine screening questions (years of experience, notice period, etc.) from the candidate data; if a required one isn't answerable from the data, use request_user_info rather than fabricating.",
		"- WORK AUTHORIZATION / RIGHT TO WORK is COUNTRY-SPECIFIC. Work out THIS job's country (from the posting, company, or office location). If the candidate is a CITIZEN or PERMANENT RESIDENT of that country — read their Location and any 'working rights' / citizenship values above — they have FULL working rights there and need NO visa sponsorship: choose the option that says they can work / have working rights / do NOT require sponsorship. A 'Work authorization' value above may be phrased for a DIFFERENT country (e.g. a note about the US); NEVER apply a statement about one country to a job in another country. NEVER select 'I need sponsorship' / 'I have no working rights', or write that you need a visa, for a country the candidate is a citizen or permanent resident of. If your EXACT status isn't offered (e.g. 'Citizen' is missing but 'Permanent Resident' is present), pick the closest option that grants FULL working rights with no sponsorship and MOVE ON — do NOT reopen the dropdown again and again hunting for an exact label; a close full-rights match is correct and final. ONCE THE FIELD DISPLAYS A FULL-RIGHTS VALUE (e.g. it now reads 'Australian Permanent Resident'), THAT FIELD IS DONE — do NOT reopen or change it because the candidate is technically a 'citizen'; there is no need for a literal 'Citizen' option, Permanent Resident already grants full working rights, and re-opening it just to hunt for 'Citizen' is a mistake that gets you stuck. Leave it and move to the next field. If you genuinely cannot tell whether the candidate is authorized for THIS job's country, call request_user_info — do NOT default to needing sponsorship.",
		`- eSIGNATURE / TERMS / ACKNOWLEDGEMENT step (very common as the LAST step before Submit): ticking the consent box is usually NOT enough. On such a step you MUST also: (a) type the candidate's FULL NAME (${c.fullName}) into any signature field — labels like 'Signature', 'Sign here', 'Type your name', 'Print name', 'Legal name', 'e-signature'; (b) fill any DATE field with today's date${job.today ? ` (${job.today})` : ""} — try formats like ${job.today ?? "YYYY-MM-DD"} or DD/MM/YYYY if one is rejected; (c) tick EVERY 'I agree' / 'I certify' / 'I consent' checkbox, not just the first. If 'Save and Continue' / 'Submit' does NOT advance after you tick the box, do NOT keep clicking it — a required SIGNATURE or DATE field on this same step is almost certainly still empty: re-scan the snapshot for it and fill it (or the checkbox didn't register — click it again and confirm it reads checked).`,
		"- If a CAPTCHA / 'verify you are human' appears, do nothing — the system hands off to a human automatically.",
		"- If the job is closed/expired, call finish(status:\"expired\").",
		"- ATS SERVER / PLATFORM ERROR: if the page shows a SYSTEM error banner — 'Errors Found', 'Error-Page Error', 'Error Code:', 'unexpected error', 'something went wrong', a 'VPS|…' / 'GMS|…' code, or an HTTP 500 page — that is the ATS itself failing, NOT a field you can fix. Do NOT keep clicking Save/Continue/Submit (it will not advance). Immediately call finish(status:\"blocked\", detail:\"ATS error: <exact banner text + code>\"). This commonly means the saved application is in a bad server-side state (e.g. resumed/re-submitted too many times) and needs a fresh application rather than more retries.",
		job.dryRun ? "- ⛔ TEST MODE — DO NOT SUBMIT. Fill everything; when you reach the final Submit/Send button, STOP and call finish(status:\"ready\"). (Submit clicks are blocked anyway.)" : "",
		"- When you see a submission confirmation, call finish(status:\"submitted\") with the confirmation text.",
		"- If you genuinely cannot proceed truthfully, call finish(status:\"blocked\") explaining why.",
		"- Be decisive and brief. Do not narrate.",
		job.cacheHint ? `\nNOTES FROM A PRIOR RUN ON THIS ATS (what worked AND what failed — reuse the good steps, avoid the failed ones):\n${job.cacheHint}` : "",
	];
	return lines.filter((l) => l !== "").join("\n");
}

/** Map a Claude tool call to a loop decision (a BrowserAction or a finish). */
export function toolCallToDecision(call: { name: string; arguments: Record<string, unknown> }, job: ApplyJob, thought?: string): ApplyDecision {
	const a = call.arguments || {};
	const str = (v: unknown) => (typeof v === "string" ? v : v == null ? undefined : String(v));
	const num = (v: unknown) => (typeof v === "number" ? v : undefined);
	switch (call.name) {
		case "type": return { thought, action: { action: "type", ref: str(a.ref), role: str(a.role) || "textbox", name: str(a.name), text: str(a.text) ?? "" } };
		case "select": return { thought, action: { action: "select", ref: str(a.ref), role: "combobox", name: str(a.name), text: str(a.value) } };
		case "check": return { thought, action: { action: "check", ref: str(a.ref), role: "checkbox", name: str(a.name) } };
		case "click": return { thought, action: { action: "click", ref: str(a.ref), role: str(a.role) || "button", name: str(a.name) } };
		case "upload": return { thought, action: { action: "upload", ref: str(a.ref), name: str(a.name) || "Resume", file: job.resumePath } };
		case "navigate": return { thought, action: { action: "navigate", url: str(a.url) } };
		case "scroll": return { thought, action: { action: "scroll", dy: num(a.dy) ?? 600 } };
		case "press_key": return { thought, action: { action: "key", key: str(a.key) || "Enter" } };
		case "request_user_info": return { thought, needsInput: { field: str(a.field) || "this field", why: str(a.why) } };
		case "read_email_link": return { thought, readEmail: { from: str(a.from), subject: str(a.subject), withinDays: num(a.within_days) } };
		case "finish": {
			const status = str(a.status);
			const valid = status === "submitted" || status === "ready" || status === "expired" || status === "blocked" ? status : "blocked";
			return { thought, finish: { status: valid as "submitted" | "ready" | "expired" | "blocked", detail: str(a.detail) || "" } };
		}
		case "clear":
		case "double_click":
		case "triple_click":
			// The brain invents these to select/clear a field before retyping. A plain
			// click is the safe equivalent; it then overwrites with `type` (which fills).
			return { thought, action: { action: "click", role: str(a.role) || "textbox", name: str(a.name) } };
		default:
			// Don't end the whole application on one unrecognized tool — re-read the
			// page and try again (the step cap prevents a runaway loop). Far better
			// than blocking a half-filled form.
			return { thought, action: { action: "wait", ms: 300 } };
	}
}

/** The real decision step: ask Claude (BYOK) for the next action given the current page. */
export async function decideAction(
	env: Env,
	userId: string,
	params: { job: ApplyJob; actionLog: string[]; snapshot: PageSnapshot },
	usageCtx?: UsageContext,
): Promise<ApplyDecision> {
	// Keep the action log bounded — it grows every step (and one entry can be an
	// 800-char sign-in link), which bloated the context until the AI call timed out.
	// The recent steps are what matter; older ones are summarised as a count.
	const MAX_LOG = 30;
	const log =
		params.actionLog.length > MAX_LOG
			? [`… (${params.actionLog.length - MAX_LOG} earlier steps omitted) …`, ...params.actionLog.slice(-MAX_LOG)]
			: params.actionLog;
	const userMsg = [
		`Actions so far:\n${log.length ? log.map((a, i) => `${i + 1}. ${a}`).join("\n") : "(none yet)"}`,
		`\nCURRENT PAGE — ${params.snapshot.title || ""} <${params.snapshot.url}>`,
		params.snapshot.snapshot,
		"\nDo the single next action toward submitting the application. Call exactly one tool.",
	].join("\n");

	// Offer the mailbox-read tool only when the candidate's Gmail is connected + permitted.
	const tools = params.job.emailEnabled ? [...BROWSER_TOOLS, READ_EMAIL_TOOL] : BROWSER_TOOLS;
	const res = (await runUserWorkersAi(env, userId, "claude-sonnet-4-6", {
		messages: [
			{ role: "system", content: applySystemPrompt(params.job) },
			{ role: "user", content: userMsg },
		],
		tools,
		// The apply runs in a durable Workflow (2-min step budget), not an interactive
		// request — a 25s cap crashed the whole run on a big-context decision. Give it 60s.
		timeoutMs: 60_000,
	}, usageCtx)) as { response?: string; tool_calls?: Array<{ name: string; arguments: Record<string, unknown> }>; usage?: { input: number; output: number } };

	const call = res.tool_calls?.[0];
	if (!call) {
		// No tool call — treat the prose as a blocked/finish signal.
		return { thought: res.response, finish: { status: "blocked", detail: res.response || "no action chosen" }, usage: res.usage };
	}
	const decision = toolCallToDecision(call, params.job, res.response);
	decision.usage = res.usage;
	return decision;
}
