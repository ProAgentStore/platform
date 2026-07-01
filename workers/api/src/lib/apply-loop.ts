import { runUserWorkersAi } from "./user-ai.js";
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
}

/** One action the runner performs on the live page (mirrors the runner's BrowserAction). */
export interface BrowserAction {
	action: "click" | "type" | "select" | "check" | "upload" | "navigate" | "scroll" | "key" | "wait";
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
}

/** Side-effecting hooks the loop drives — real ones hit the runner; tests mock them. */
export interface ApplyDeps {
	snapshot: () => Promise<PageSnapshot>;
	/** Perform an action. A Playwright failure comes back as `error` (never throws) so the brain can adapt. */
	act: (action: BrowserAction) => Promise<{ url: string; challenge: string | null; error?: string }>;
	decide: (params: { job: ApplyJob; actionLog: string[]; snapshot: PageSnapshot }) => Promise<ApplyDecision>;
	onEvent?: (type: string, message: string, data?: unknown) => Promise<void> | void;
	/** Read (and clear) any free-text message the user sent to this RUNNING task — so
	 *  guidance can be injected mid-flight, not only on a handoff resume. */
	pollHint?: () => Promise<string | null>;
}

/**
 * The remote brain's apply loop: look at the page, decide one action, do it,
 * repeat — until the application is submitted, the job is expired, or a CAPTCHA
 * forces a human handoff. Pure orchestration over {@link ApplyDeps} so it can be
 * unit-tested without a browser, an LLM, or a deployed Workflow.
 */
export async function runApplyLoop(deps: ApplyDeps, job: ApplyJob, opts: { maxSteps?: number; solvedChallengeUrl?: string; tokens?: { input: number; output: number } } = {}): Promise<ApplyResult> {
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
	let filledSomething = false; // any field typed → the application is in progress (dry-run safety)
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
			return { outcome: "captcha", challenge: snap.challenge, url: snap.url, steps: step, transcript: [...actionLog] };
		}

		// Mid-flight steering: pick up any message you sent to this RUNNING task and
		// make it top-priority guidance for THIS decision, then consume it (one-shot).
		const liveHint = deps.pollHint ? await deps.pollHint().catch(() => null) : null;
		if (liveHint) {
			job.userHint = liveHint;
			await deps.onEvent?.("agent.guidance", `Message from you: "${liveHint}"`, { hint: liveHint });
		}

		const decision = await deps.decide({ job, actionLog, snapshot: snap });
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
				return { outcome: "captcha", challenge: "captcha", detail: decision.finish.detail, url: snap.url, steps: step, transcript: [...actionLog] };
			}
			return { outcome: decision.finish.status, detail: decision.finish.detail, url: snap.url, steps: step, transcript: [...actionLog] };
		}
		if (decision.needsInput) {
			// Ask-and-hold: pause for the user to supply a value (same machinery as captcha).
			await deps.onEvent?.("agent.needs_input", `Needs your input — ${decision.needsInput.field}${decision.needsInput.why ? ` (${decision.needsInput.why})` : ""}`, decision.needsInput);
			return { outcome: "needs_input", fieldNeeded: decision.needsInput.field, detail: decision.needsInput.why, url: snap.url, steps: step, transcript: [...actionLog] };
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
				await deps.onEvent?.("agent.stuck", `Repeated "${describeAction(decision.action)}" with no progress — handing off`, { action: decision.action });
				return { outcome: "stuck", detail: describeAction(decision.action), url: snap.url, steps: step, transcript: [...actionLog] };
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
				return { outcome: "stuck", detail: describeAction(decision.action), url: snap.url, steps: step, transcript: [...actionLog] };
			}
		} else {
			repeatFails = 0;
			lastActionKey = "";
			if (decision.action.action === "type") filledSomething = true;
			// Track arrow-key nav so a following Enter is an autocomplete accept
			// (allowed in dry-run), not a form submit.
			lastActionWasArrow = decision.action.action === "key" && /^arrow/i.test(decision.action.key ?? "");
			actionLog.push(describeAction(decision.action));
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

/** The browser actions exposed to Claude as tools — addressed by ARIA role + accessible name. */
export const BROWSER_TOOLS = [
	tool("type", "Type text into a field identified by its ARIA role and accessible name.", {
		role: { type: "string", description: 'usually "textbox"' },
		name: { type: "string", description: "the field's label/accessible name from the snapshot" },
		text: { type: "string", description: "text to type" },
	}, ["name", "text"]),
	tool("select", "Choose an option in a dropdown/combobox.", {
		name: { type: "string", description: "the select's label" },
		value: { type: "string", description: "the option label to choose" },
	}, ["name", "value"]),
	tool("check", "Check a radio button or checkbox by its label.", {
		name: { type: "string", description: "the option's label" },
	}, ["name"]),
	tool("click", "Click a button or link by its accessible name.", {
		role: { type: "string", description: '"button" or "link"' },
		name: { type: "string", description: "the control's visible text/label" },
	}, ["name"]),
	tool("upload", "Upload the candidate's résumé to a file field by its label (the file is attached automatically).", {
		name: { type: "string", description: "the upload control's label, e.g. \"Resume\"" },
	}, ["name"]),
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

/** Build the system prompt that turns Claude into a job-application driver. */
export function applySystemPrompt(job: ApplyJob): string {
	const c = job.candidate;
	const lines = [
		"You are a job-application agent operating a real web browser through tools.",
		"You see each page as an ARIA snapshot (roles + accessible names + values). You act ONLY through the provided tools — there are no CSS selectors. Address elements by their role + accessible name exactly as they appear in the snapshot.",
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
		"- Résumé / file uploads: ALWAYS use the `upload` tool on the upload control (the file is supplied automatically — never ask for a path). Do NOT `click` a 'Browse' / 'Choose file' / 'Upload your CV' button to open a file picker — use `upload` directly on it.",
		job.password ? `- Account password: ${job.password} — use EXACTLY this in both Password and Confirm password. Never invent a different password.` : "",
		"",
		"ACCOUNT:",
		job.hasStoredLogin
			? "- You HAVE a saved login for this site. If it asks you to sign in or register, choose **Sign in / Log in** and use the candidate email + the account password above."
			: "- You have NO saved login for this site (this is your first application here). If the page offers BOTH 'Sign in' and 'Create an account' / 'Register', choose **Create an account** and register with the candidate email + the account password above. Do NOT try to Sign in first — the account does not exist yet.",
		"- After clicking 'Create an account' / 'Register', a registration FORM appears — fill it (name, email, password, confirm password) and submit it. Do NOT click the 'Create an account' link again; act on the new form fields in the snapshot.",
		"- If you try to register and the email is ALREADY REGISTERED ('already exists', 'email is taken'), switch to Sign in / Log in with the same email + the account password above.",
		"- Some sites email a verification/confirmation link after registration. If you're blocked waiting on email verification and have no way to read it, call finish(status:\"blocked\", detail:\"email verification required to continue\").",
		"",
		"RULES:",
		"- Do exactly ONE tool call per turn — the next page snapshot follows.",
		"- If the action log shows your last action FAILED (e.g. a click timed out), DO NOT repeat it. The page likely already advanced, opened a new tab, or the element moved — re-read the CURRENT snapshot and act on what's there now (a different button, the next field, or scroll to find it).",
		"- After clicking something like Apply/Next/Continue, expect the page to change; act on the NEW snapshot, not the element you just clicked.",
		"- For ANY dropdown, combobox, or autocomplete/typeahead field (including a city/location box), use the `select` tool with the value — it opens the control, filters if needed, and picks the option for you. Do NOT `type` then `click` a suggestion for these.",
		"- AUTOCOMPLETE TEXTBOX (city, suburb, address, school, company): some of these LOOK like a plain `textbox` in the snapshot but only accept a value when you PICK a suggestion. If you `type` into such a field and it does not stick (the action log says no visible change, the field still reads empty, or a list of options/suggestions is now open), DO NOT retype the same text. Instead: CLICK the matching suggestion/option shown in the snapshot, or press_key \"ArrowDown\" then press_key \"Enter\" to accept the first match. If still stuck, try `select` on that field.",
		"- To FIX or CLEAR a field that has the wrong value (e.g. text landed in the wrong box), just call `type` again with the correct value on that field — it REPLACES the existing text. There is no triple-click, double-click, or clear tool; never call those.",
		"- The ONLY tools that exist are: type, select, check, click, upload, navigate, scroll, press_key, request_user_info, finish. Never call any other tool name.",
		"- NEVER invent data. Use ONLY the candidate values above. Do not make up a phone number, salary, address, or any value you weren't given. For a REQUIRED field you don't have a value for, call request_user_info(field, why) to ask the user and wait — do NOT guess or fabricate.",
		"- Demographic / EEO / voluntary self-identification questions (gender, race, ethnicity, veteran status, disability): ALWAYS choose \"Decline to self-identify\" / \"I don't wish to answer\" / \"Prefer not to say\" unless a candidate value above explicitly provides it. Never guess these.",
		"- You may answer genuine screening questions (years of experience, work authorization) from the candidate data; if a required one isn't answerable from the data, use request_user_info rather than fabricating.",
		"- If a CAPTCHA / 'verify you are human' appears, do nothing — the system hands off to a human automatically.",
		"- If the job is closed/expired, call finish(status:\"expired\").",
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
		case "type": return { thought, action: { action: "type", role: str(a.role) || "textbox", name: str(a.name), text: str(a.text) ?? "" } };
		case "select": return { thought, action: { action: "select", role: "combobox", name: str(a.name), text: str(a.value) } };
		case "check": return { thought, action: { action: "check", role: "checkbox", name: str(a.name) } };
		case "click": return { thought, action: { action: "click", role: str(a.role) || "button", name: str(a.name) } };
		case "upload": return { thought, action: { action: "upload", name: str(a.name) || "Resume", file: job.resumePath } };
		case "navigate": return { thought, action: { action: "navigate", url: str(a.url) } };
		case "scroll": return { thought, action: { action: "scroll", dy: num(a.dy) ?? 600 } };
		case "press_key": return { thought, action: { action: "key", key: str(a.key) || "Enter" } };
		case "request_user_info": return { thought, needsInput: { field: str(a.field) || "this field", why: str(a.why) } };
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
): Promise<ApplyDecision> {
	const userMsg = [
		`Actions so far:\n${params.actionLog.length ? params.actionLog.map((a, i) => `${i + 1}. ${a}`).join("\n") : "(none yet)"}`,
		`\nCURRENT PAGE — ${params.snapshot.title || ""} <${params.snapshot.url}>`,
		params.snapshot.snapshot,
		"\nDo the single next action toward submitting the application. Call exactly one tool.",
	].join("\n");

	const res = (await runUserWorkersAi(env, userId, "claude-sonnet-4-6", {
		messages: [
			{ role: "system", content: applySystemPrompt(params.job) },
			{ role: "user", content: userMsg },
		],
		tools: BROWSER_TOOLS,
	})) as { response?: string; tool_calls?: Array<{ name: string; arguments: Record<string, unknown> }>; usage?: { input: number; output: number } };

	const call = res.tool_calls?.[0];
	if (!call) {
		// No tool call — treat the prose as a blocked/finish signal.
		return { thought: res.response, finish: { status: "blocked", detail: res.response || "no action chosen" }, usage: res.usage };
	}
	const decision = toolCallToDecision(call, params.job, res.response);
	decision.usage = res.usage;
	return decision;
}
