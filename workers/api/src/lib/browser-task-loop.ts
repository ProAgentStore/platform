// Generic, objective-driven browser task — the production path for browser agents
// (issue #69/#71). It REUSES apply's proven engine (`runApplyLoop` + `ApplyDeps` +
// the runner `/browser/*` primitives + captcha/stuck/needs_input handoffs); only the
// prompt, the tool set, and the decision step are generalized from job-specific to
// "achieve this objective on this page". The agent supplies the objective as DATA, so
// the platform stays domain-agnostic (no "facebook"/"friends" in core).
import { runUserWorkersAi } from "./user-ai.js";
import { COMMIT_VERB_RE as COMMIT_VERBS, commitBlockReason, commitModeFor } from "./commit-guard.js";
import { type ApplyDecision, type BrowserAction, type BrowserJobBase, type PageSnapshot } from "./apply-loop.js";
import type { UsageContext } from "./usage.js";
import type { Env } from "../types.js";

/** The minimal job a generic browser task needs. Everything task-specific is `objective`. */
export interface BrowserTaskJob extends BrowserJobBase {
	/** Where the run starts (the agent's declared start URL, or a per-run override). */
	url: string;
	/** What to accomplish — the agent's declared goal + the subscriber's settings,
	 *  rendered by the trigger route. This is the ONLY task-specific input. */
	objective: string;
	/** The subscriber's free-text rules (Special Instructions); injected at the top. */
	specialInstructions?: string;
	/** Live free-text message the user sent while the agent was paused/stuck. */
	userHint?: string;
	/** Today's date (YYYY-MM-DD), stamped at trigger time — for any date fields. */
	today?: string;
	/** Per-RUN check: the workflow's act layer blocks the commit action (click Confirm/
	 *  Submit/Send/…) so a run can be walked safely without committing anything. */
	dryRun?: boolean;
	/**
	 * Per-AGENT property: this agent only ever OBSERVES. Same act-layer guard as
	 * `dryRun`, but it is declared on the agent row (`config.browserTask.readOnly`)
	 * and never read from a request body — so a subscriber, a cron config, or the
	 * agent's own brain cannot turn it off. That is the difference between "this run
	 * is a rehearsal" and "this agent cannot commit anything, ever".
	 *
	 * It is what makes a browser agent safe to point at a REAL logged-in account: the
	 * blast radius of a wrong decision is a wasted step, not a payment.
	 */
	readOnly?: boolean;
	/** Values the user supplied mid-run via a needs_input handoff (field → value),
	 *  fed back so the agent never re-asks. */
	providedAnswers?: Record<string, string>;
}

/** Verbs that COMMIT an irreversible action — blocked in dry-run and read-only, and the model is
 *  told to treat them as the final step. Re-exported from `commit-guard.ts`, which is now the one
 *  place the vocabulary lives: a second copy is how apply and browse came to disagree about what
 *  "committing" means, and the weaker of the two was the hole (#629). */
export { COMMIT_VERB_RE } from "./commit-guard.js";

function tool(name: string, description: string, props: Record<string, { type: string; description: string }>, required: string[]) {
	return { type: "function" as const, function: { name, description, parameters: { type: "object", properties: props, required } } };
}

const REF = { type: "string", description: 'the element\'s ref from the snapshot, e.g. "e42" — ALWAYS include it; it targets the exact element even when two share a label' };

/** The browser actions exposed to Claude for a generic task. Same primitives as apply,
 *  minus résumé upload; `finish` uses generic outcomes (done|blocked). */
export const BROWSER_TASK_TOOLS = [
	tool("click", "Click a button, link, or control. Target it by its snapshot ref.", {
		ref: REF,
		role: { type: "string", description: '"button" or "link"' },
		name: { type: "string", description: "the control's visible text/label" },
	}, ["ref"]),
	tool("type", "Type text into a field. Target it by its snapshot ref.", {
		ref: REF,
		name: { type: "string", description: "the field's label/accessible name" },
		text: { type: "string", description: "text to type" },
	}, ["ref", "text"]),
	tool("select", "Choose an option in a dropdown/combobox. Target the control by its snapshot ref.", {
		ref: REF,
		name: { type: "string", description: "the select's label" },
		value: { type: "string", description: "the option label to choose" },
	}, ["ref", "value"]),
	tool("check", "Check a checkbox or radio. Target it by its snapshot ref.", {
		ref: REF,
		name: { type: "string", description: "the option's label" },
	}, ["ref"]),
	tool("navigate", "Go to a URL.", { url: { type: "string", description: "absolute http(s) URL" } }, ["url"]),
	tool("scroll", "Scroll the page vertically to reveal more.", { dy: { type: "number", description: "pixels (positive = down)" } }, []),
	tool("press_key", "Press a keyboard key like Enter or Tab.", { key: { type: "string", description: "e.g. Enter, Tab, Escape" } }, ["key"]),
	tool("request_user_info", "Ask the USER for a REQUIRED value you don't have. Use this INSTEAD of inventing one. The run pauses until they answer, then resumes.", {
		field: { type: "string", description: "the value you need" },
		why: { type: "string", description: "brief reason / where it's needed" },
	}, ["field"]),
	tool("finish", "End the run: status done (objective achieved / nothing left to do) or blocked (cannot proceed truthfully).", {
		status: { type: "string", description: "done | blocked" },
		detail: { type: "string", description: "short summary of what you did / why you stopped" },
	}, ["status", "detail"]),
];

/** Build the objective-driven system prompt (replaces the ~job-specific apply prompt). */
export function browserTaskSystemPrompt(job: BrowserTaskJob): string {
	const lines = [
		"You are a web-automation agent operating a real web browser through tools.",
		"You see each page as an accessibility snapshot: every element shows its role, accessible name, current value, state (e.g. [disabled], [checked], [expanded]), and a stable reference like [ref=e42]. You act ONLY through the provided tools — no CSS selectors.",
		"- TARGET BY REF: always pass the element's exact `ref` from the snapshot (e.g. \"e42\"). Include the accessible name too for clarity.",
		"- Read element STATE: a control marked [disabled]/[readonly] can't be changed — move on. [checked]/[expanded] tell you current state.",
		job.userHint
			? `\n‼️ LIVE MESSAGE FROM THE USER — they are watching right now and just sent this; it describes the CURRENT screen. TRUST IT: re-read the snapshot and act on it, do NOT repeat the action you were stuck on. Message: "${job.userHint}"\n`
			: "",
		job.specialInstructions
			? `\n★ USER'S SPECIAL INSTRUCTIONS — follow strictly; they OVERRIDE the defaults below:\n${job.specialInstructions}\n`
			: "",
		"",
		"## YOUR OBJECTIVE",
		job.objective,
		"",
		...(job.providedAnswers && Object.keys(job.providedAnswers).length
			? ["Values you asked the user for (use these, don't ask again):", ...Object.entries(job.providedAnswers).map(([k, v]) => `  • ${k}: ${v}`), ""]
			: []),
		"## RULES",
		"- Do exactly ONE tool call per turn — the next page snapshot follows.",
		"- After you click something that changes the page (Next/Confirm/a link), act on the NEW snapshot, not the element you just clicked.",
		"- If the action log shows your last action FAILED, do NOT repeat it — re-read the CURRENT snapshot and act on what's there now.",
		"- DROPDOWNS/COMBOBOXES: first try `select`. If it fails (\"not a <select>\"), it's a custom widget — `click` it to open, then `click` the matching option (or type a few letters to filter, then click).",
		"- Stay STRICTLY within the objective. Do NOT take any action beyond it — no posting, messaging, changing settings, or interacting with anything the objective doesn't ask for.",
		"- NEVER invent data. For a REQUIRED value you weren't given, call request_user_info(field, why) and wait — do not guess.",
		"- LOGIN / CHECKPOINT / CAPTCHA: if you see a sign-in screen, security check, 2FA, or a \"verify you are human\" challenge, do NOTHING — the system hands off to a human automatically. NEVER attempt to sign in or solve a captcha yourself.",
		"- Respect any count limit in the objective (e.g. \"up to 20\"): track how many you've done and STOP at the limit.",
		"- When the objective is complete, or there is nothing left to act on, call finish(status:\"done\", detail:\"<what you did>\").",
		"- If you genuinely cannot proceed, call finish(status:\"blocked\", detail:\"<why>\").",
		"- Be decisive and brief. Do not narrate.",
		// read-only is the stronger, permanent form of the same guard, so it wins when both are set.
		job.readOnly
			? [
					"",
					"## READ-ONLY — THIS IS THE WHOLE POINT OF THIS AGENT",
					"You LOOK and you REPORT. You never change anything on this account.",
					"- ALLOWED: navigate, scroll, open a menu/tab/statement, and type into a SEARCH or FILTER box to find what you were asked about.",
					"- FORBIDDEN: submitting, sending, posting, paying, confirming, accepting, deleting, saving, or changing any setting. The runtime BLOCKS those clicks before they reach the page, so attempting one only wastes a step — and the block is not something you can talk your way past.",
					"- If the only way to finish would be to change something, do NOT try: call finish(status:\"blocked\", detail:\"<what would have had to change>\") and say so.",
					"- YOUR finish DETAIL IS THE REPORT. Put the ACTUAL figures, dates and statuses you read into it (\"Balance $184.20, due 3 September\") — never \"I checked the page\". If something you were asked for was not on screen, say that plainly; do NOT guess it.",
				].join("\n")
			: job.dryRun
				? "- ⛔ REHEARSAL (dry run): walk the flow but do NOT perform the committing action. When you would click a final Confirm/Add/Submit/Send/Post/Delete/Pay button, STOP and call finish(status:\"done\", detail:\"dry run — reached <button>\") instead. (Such clicks are blocked anyway.)"
				: "",
	];
	return lines.filter((l) => l !== "").join("\n");
}

/** Map a Claude tool call to a loop decision. `finish` uses generic outcomes mapped
 *  onto the shared ApplyDecision shape (done→"submitted" success, blocked→"blocked"). */
export function browserToolCallToDecision(call: { name: string; arguments: Record<string, unknown> }, thought?: string): ApplyDecision {
	const a = call.arguments || {};
	const str = (v: unknown) => (typeof v === "string" ? v : v == null ? undefined : String(v));
	const num = (v: unknown) => (typeof v === "number" ? v : undefined);
	switch (call.name) {
		case "click": return { thought, action: { action: "click", ref: str(a.ref), role: str(a.role) || "button", name: str(a.name) } };
		case "type": return { thought, action: { action: "type", ref: str(a.ref), role: "textbox", name: str(a.name), text: str(a.text) ?? "" } };
		case "select": return { thought, action: { action: "select", ref: str(a.ref), role: "combobox", name: str(a.name), text: str(a.value) } };
		case "check": return { thought, action: { action: "check", ref: str(a.ref), role: "checkbox", name: str(a.name) } };
		case "navigate": return { thought, action: { action: "navigate", url: str(a.url) } };
		case "scroll": return { thought, action: { action: "scroll", dy: num(a.dy) ?? 600 } };
		case "press_key": return { thought, action: { action: "key", key: str(a.key) || "Enter" } };
		case "request_user_info": return { thought, needsInput: { field: str(a.field) || "this value", why: str(a.why) } };
		case "finish": {
			const done = str(a.status) === "done";
			return { thought, finish: { status: done ? "submitted" : "blocked", detail: str(a.detail) || "" } };
		}
		default:
			// Unknown tool — re-read the page and try again (step cap prevents runaway).
			return { thought, action: { action: "wait", ms: 300 } };
	}
}

/** The decision step: ask Claude (BYOK) for the next action given the page + objective. */
export async function decideBrowserTask(
	env: Env,
	userId: string,
	params: { job: BrowserTaskJob; actionLog: string[]; snapshot: PageSnapshot },
	usageCtx?: UsageContext,
): Promise<ApplyDecision> {
	const MAX_LOG = 30;
	const log =
		params.actionLog.length > MAX_LOG
			? [`… (${params.actionLog.length - MAX_LOG} earlier steps omitted) …`, ...params.actionLog.slice(-MAX_LOG)]
			: params.actionLog;
	const userMsg = [
		`Actions so far:\n${log.length ? log.map((a, i) => `${i + 1}. ${a}`).join("\n") : "(none yet)"}`,
		`\nCURRENT PAGE — ${params.snapshot.title || ""} <${params.snapshot.url}>`,
		params.snapshot.snapshot,
		"\nDo the single next action toward the objective. Call exactly one tool.",
	].join("\n");

	const res = (await runUserWorkersAi(env, userId, "claude-sonnet-4-6", {
		messages: [
			{ role: "system", content: browserTaskSystemPrompt(params.job) },
			{ role: "user", content: userMsg },
		],
		tools: BROWSER_TASK_TOOLS,
		timeoutMs: 60_000,
	}, usageCtx)) as { response?: string; tool_calls?: Array<{ name: string; arguments: Record<string, unknown> }>; usage?: { input: number; output: number } };

	const call = res.tool_calls?.[0];
	if (!call) {
		return { thought: res.response, finish: { status: "blocked", detail: res.response || "no action chosen" }, usage: res.usage };
	}
	const decision = browserToolCallToDecision(call, res.response);
	decision.usage = res.usage;
	return decision;
}

/** Is this action the committing step (blocked in dry-run / read-only)? */
export function isCommitClick(action: BrowserAction): boolean {
	return action.action === "click" && COMMIT_VERBS.test(action.name ?? "");
}

/**
 * Why this action must not reach the page — the workflow's act layer returns this to the
 * brain INSTEAD of performing it. `null` means "go ahead".
 *
 * Read-only and dry-run share one commit guard on purpose: two guards would eventually disagree
 * about what "committing" means, and the weaker one would be the hole. That is not a hypothetical
 * — this one was CLICK-ONLY while apply's blocked Enter, so a read-only agent could commit by
 * pressing Enter on a focused form field, which is the one thing its declaration promises it can
 * never do (#629). The rule now lives in `commit-guard.ts` and is consulted by both loops:
 *
 *   • every action kind that can commit, not just `click` — Enter/NumpadEnter/Return submit a
 *     focused form, Space activates a focused button;
 *   • matched against the PAGE's own name for the targeted `ref` as well as the model's claimed
 *     `name`, because the runner locates purely by `ref` and never reads `name` (#627);
 *   • a vocabulary that is not English-only.
 *
 * Still deliberately fail-safe: a filter button literally labelled "Apply" is refused too. For an
 * agent whose promise is that it cannot act, refusing a harmless click is the cheap error and
 * performing a harmful one is the expensive one.
 *
 * `snapshot` is the page the decision was made from; `runnerEnforces` says whether the runner
 * acknowledged that it applies the guard at the act boundary itself (see `commit-guard.ts`).
 */
export function blockedActionReason(job: BrowserTaskJob, action: BrowserAction, snapshot?: string | null, runnerEnforces?: boolean): string | null {
	const mode = commitModeFor(job);
	return mode ? commitBlockReason({ mode, action, snapshot, runnerEnforces }) : null;
}
