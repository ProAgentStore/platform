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
	/** Test mode: fill everything and reach Submit, but DON'T click it. */
	dryRun?: boolean;
	/** Values the user supplied mid-run via ask-and-hold (field label → value). */
	providedAnswers?: Record<string, string>;
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
}

export type ApplyOutcome = "submitted" | "ready" | "expired" | "blocked" | "captcha" | "stuck" | "needs_input" | "failed" | "max_steps";

export interface ApplyDecision {
	thought?: string;
	action?: BrowserAction;
	finish?: { status: "submitted" | "ready" | "expired" | "blocked"; detail: string };
	/** The agent needs a value from the user (ask-and-hold). */
	needsInput?: { field: string; why?: string };
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
}

/**
 * The remote brain's apply loop: look at the page, decide one action, do it,
 * repeat — until the application is submitted, the job is expired, or a CAPTCHA
 * forces a human handoff. Pure orchestration over {@link ApplyDeps} so it can be
 * unit-tested without a browser, an LLM, or a deployed Workflow.
 */
export async function runApplyLoop(deps: ApplyDeps, job: ApplyJob, opts: { maxSteps?: number } = {}): Promise<ApplyResult> {
	const maxSteps = opts.maxSteps ?? 40;
	const actionLog: string[] = [];
	let lastUrl = "";
	let lastActionKey = "";
	let repeatFails = 0;
	let pageKey = "";
	let failsOnPage = 0;
	const recentKeys: string[] = [];

	for (let step = 0; step < maxSteps; step++) {
		const snap = await deps.snapshot();
		lastUrl = snap.url;
		// Reset the per-page failure counter whenever we move to a new page.
		if (snap.url !== pageKey) { pageKey = snap.url; failsOnPage = 0; }

		// A CAPTCHA can't be solved by the model — hand off to the human, same session.
		if (snap.challenge) {
			await deps.onEvent?.("agent.captcha", `CAPTCHA detected (${snap.challenge}) — handing off`, { challenge: snap.challenge, url: snap.url });
			return { outcome: "captcha", challenge: snap.challenge, url: snap.url, steps: step, transcript: [...actionLog] };
		}

		const decision = await deps.decide({ job, actionLog, snapshot: snap });
		await deps.onEvent?.(
			"agent.decision",
			decision.finish ? `finish: ${decision.finish.status}` : decision.action ? describeAction(decision.action) : "thinking",
			{ thought: decision.thought, action: decision.action, finish: decision.finish },
		);

		if (decision.finish) {
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
			actionLog.push(describeAction(decision.action));
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
		...(job.providedAnswers && Object.keys(job.providedAnswers).length
			? ["- Values you asked the user for (use these, don't ask again):", ...Object.entries(job.providedAnswers).map(([k, v]) => `  • ${k}: ${v}`)]
			: []),
		job.coverNote ? `- Cover note: ${job.coverNote}` : "",
		"- Résumé: attach via the `upload` tool whenever there is a file upload (the file is supplied automatically — never ask for a path).",
		job.password ? `- Account password: ${job.password} — use EXACTLY this in both Password and Confirm password. Never invent a different password.` : "",
		"",
		"ACCOUNT:",
		"- If the site requires an account to apply, create one with the candidate email + the account password above.",
		"- If the email is ALREADY REGISTERED (you see 'already exists', 'account exists', 'email is taken', or it asks you to sign in), do NOT keep trying to register — choose Sign in / Log in and use the same email + the account password above.",
		"",
		"RULES:",
		"- Do exactly ONE tool call per turn — the next page snapshot follows.",
		"- If the action log shows your last action FAILED (e.g. a click timed out), DO NOT repeat it. The page likely already advanced, opened a new tab, or the element moved — re-read the CURRENT snapshot and act on what's there now (a different button, the next field, or scroll to find it).",
		"- After clicking something like Apply/Next/Continue, expect the page to change; act on the NEW snapshot, not the element you just clicked.",
		"- For ANY dropdown, combobox, or autocomplete/typeahead field (including a city/location box), use the `select` tool with the value — it opens the control, filters if needed, and picks the option for you. Do NOT `type` then `click` a suggestion for these.",
		"- NEVER invent data. Use ONLY the candidate values above. Do not make up a phone number, salary, address, or any value you weren't given. For a REQUIRED field you don't have a value for, call request_user_info(field, why) to ask the user and wait — do NOT guess or fabricate.",
		"- Demographic / EEO / voluntary self-identification questions (gender, race, ethnicity, veteran status, disability): ALWAYS choose \"Decline to self-identify\" / \"I don't wish to answer\" / \"Prefer not to say\" unless a candidate value above explicitly provides it. Never guess these.",
		"- You may answer genuine screening questions (years of experience, work authorization) from the candidate data; if a required one isn't answerable from the data, use request_user_info rather than fabricating.",
		"- If a CAPTCHA / 'verify you are human' appears, do nothing — the system hands off to a human automatically.",
		"- If the job is closed/expired, call finish(status:\"expired\").",
		"- When you see a submission confirmation, call finish(status:\"submitted\") with the confirmation text.",
		"- If you genuinely cannot proceed truthfully, call finish(status:\"blocked\") explaining why.",
		"- Be decisive and brief. Do not narrate.",
		job.cacheHint ? `\nNOTES FROM A PRIOR SUCCESSFUL RUN ON THIS ATS (use to move faster):\n${job.cacheHint}` : "",
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
		default: return { thought, finish: { status: "blocked", detail: `unknown tool ${call.name}` } };
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
	})) as { response?: string; tool_calls?: Array<{ name: string; arguments: Record<string, unknown> }> };

	const call = res.tool_calls?.[0];
	if (!call) {
		// No tool call — treat the prose as a blocked/finish signal.
		return { thought: res.response, finish: { status: "blocked", detail: res.response || "no action chosen" } };
	}
	return toolCallToDecision(call, params.job, res.response);
}
