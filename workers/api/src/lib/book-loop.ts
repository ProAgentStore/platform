/**
 * Flight-booking brain. Reuses the proven, unit-tested {@link runApplyLoop} engine
 * (snapshot → decide → act, with the fixation/stuck/needs-input handling) — this
 * module only supplies the BOOKING decision step: a JetStar-aware system prompt, a
 * booking-shaped toolset (no résumé upload), and the job shape.
 *
 * SAFETY — the agent STOPS BEFORE PAYMENT. It searches, selects the flight, and
 * fills passenger details, then calls finish(status:"ready") the moment it reaches
 * the payment/checkout page. It NEVER enters card details — the human reviews and
 * pays via the takeover. The workflow additionally hard-blocks any payment action
 * (see `isPaymentField` / `isPaymentSubmit`) as a belt-and-braces guard.
 */
import { runUserWorkersAi } from "./user-ai.js";
import type { ApplyDecision, BrowserJobBase, PageSnapshot } from "./apply-loop.js";
import { toolCallToDecision } from "./apply-loop.js";
import type { Env } from "../types.js";

/** The trip + traveller context the booking brain works from. */
export interface BookingJob extends BrowserJobBase {
	/** Where to start (the airline's booking/search page). */
	url: string;
	trip: {
		origin: string;
		destination: string;
		/** Preferred outbound date (YYYY-MM-DD or a phrase the user gave). */
		departDate?: string;
		returnDate?: string;
		oneWay?: boolean;
		/** e.g. "1 adult". */
		passengers?: string;
		/** Preferred fare/bundle, e.g. "Starter". */
		fareType?: string;
	};
	traveller: {
		fullName: string;
		email: string;
		phone?: string;
		/** Date of birth if the airline requires it (YYYY-MM-DD). */
		dob?: string;
	};
	/** A saved airline login exists → sign in; else book as guest. */
	hasStoredLogin?: boolean;
	/** Stable account password (same every run) when a login is used. */
	password?: string;
	/** The user's own rules (KB → Special Instructions) — override the defaults. */
	specialInstructions?: string;
	/** Notes from a prior successful run on this airline (per-host cache). */
	cacheHint?: string;
	/** Today's date (YYYY-MM-DD), stamped at trigger time. */
	today?: string;
}

// ── Payment guard (used by the workflow's act wrapper) ───────────────────────

/** True if a field/label looks like payment-card data the agent must NEVER fill. */
export function isPaymentField(name: string | undefined): boolean {
	const n = (name ?? "").toLowerCase();
	if (!n) return false;
	return /card\s*number|cardholder|card holder|name on card|cvv|cvc|security code|card verification|expiry|expiration|exp\.?\s*date|\bccv\b|credit card|debit card|\bpan\b|billing (address|zip|postcode)/.test(n);
}

/** True if an action is the final "pay / purchase / confirm payment" click. */
export function isPaymentSubmit(name: string | undefined): boolean {
	const n = (name ?? "").toLowerCase();
	if (!n) return false;
	return /\bpay\b|pay now|pay\s*&|make payment|complete (payment|booking|purchase)|confirm (and pay|payment|purchase)|place order|purchase|checkout now|buy now/.test(n);
}

// ── The booking toolset ──────────────────────────────────────────────────────

function tool(name: string, description: string, props: Record<string, { type: string; description: string }>, required: string[]) {
	return { type: "function" as const, function: { name, description, parameters: { type: "object", properties: props, required } } };
}

const REF = { type: "string", description: 'the element\'s ref from the snapshot, e.g. "e42" — ALWAYS include it; it targets the exact element even when two fields share a label' };

/** Browser actions offered to the booking brain — no résumé upload, no email read. */
export const BOOKING_TOOLS = [
	tool("type", "Type text into a field. Target it by its snapshot ref.", {
		ref: REF,
		role: { type: "string", description: 'usually "textbox"' },
		name: { type: "string", description: "the field's label/accessible name" },
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
	tool("navigate", "Go to a URL (e.g. the airline's booking page).", {
		url: { type: "string", description: "absolute http(s) URL" },
	}, ["url"]),
	tool("scroll", "Scroll the page vertically to reveal more.", {
		dy: { type: "number", description: "pixels (positive = down)" },
	}, []),
	tool("press_key", "Press a keyboard key like Enter or Tab.", {
		key: { type: "string", description: "e.g. Enter, Tab, Escape, ArrowDown" },
	}, ["key"]),
	tool("request_user_info", "Ask the USER for a REQUIRED value you don't have (e.g. date of birth, a passenger detail, which fare to pick). Use this INSTEAD of inventing a value. Booking pauses until they answer, then resumes.", {
		field: { type: "string", description: 'the value you need, e.g. "date of birth" or "which fare"' },
		why: { type: "string", description: "brief reason / where it's needed" },
	}, ["field"]),
	tool("finish", "End your part of the booking. status \"ready\" = you reached the PAYMENT/checkout page with the flight selected and passenger details filled (the human pays). \"expired\" = no matching flight/date available. \"blocked\" = cannot proceed truthfully.", {
		status: { type: "string", description: "ready | expired | blocked" },
		detail: { type: "string", description: "short summary: the selected flight (date/time/fare/price) + what's left for the human" },
	}, ["status", "detail"]),
];

/** Build the system prompt that turns Claude into a flight-booking driver. */
export function bookingSystemPrompt(job: BookingJob): string {
	const t = job.trip;
	const p = job.traveller;
	const lines = [
		"You are a flight-booking agent operating a real web browser through tools, booking a repeat ticket for the traveller.",
		"You see each page as an accessibility snapshot: every element shows its role, accessible name, current value, state ([disabled], [checked], [expanded], …), and a stable [ref=e42]. You act ONLY through the provided tools — no CSS selectors. ALWAYS pass the element's exact `ref`.",
		job.userHint
			? `\n‼️ LIVE MESSAGE FROM THE USER — they are watching right now; it describes the CURRENT screen. TRUST IT over your previous assumption: re-read the snapshot and act on this. Message: "${job.userHint}"\n`
			: "",
		job.specialInstructions
			? `\n★ USER'S SPECIAL INSTRUCTIONS — follow these strictly; they OVERRIDE the defaults below:\n${job.specialInstructions}\n`
			: "",
		"",
		"⛔ CRITICAL PAYMENT BOUNDARY — you must NEVER enter payment. Do NOT type a card number, cardholder name, expiry, or CVV; do NOT click Pay / Purchase / Complete booking / Confirm & pay. The MOMENT you reach the payment or checkout page (card fields appear, or a payment/checkout step is shown) with the flight selected and passenger details filled, STOP and call finish(status:\"ready\", detail:\"<selected flight: date, time, fare, price> — ready for you to review and pay\"). The human completes payment. Any payment action is blocked anyway.",
		"",
		"GOAL: book the following trip up to (but NOT including) payment:",
		`- From: ${t.origin}`,
		`- To: ${t.destination}`,
		t.oneWay ? "- One way" : t.returnDate ? `- Return on: ${t.returnDate}` : "- Return (ask the user for the return date if required and not given)",
		t.departDate ? `- Depart on: ${t.departDate}` : "- Departure date: NOT specified — call request_user_info(\"departure date\") rather than guessing.",
		t.passengers ? `- Passengers: ${t.passengers}` : "- Passengers: 1 adult (unless the snapshot/instructions say otherwise)",
		t.fareType ? `- Preferred fare/bundle: ${t.fareType} (pick this fare; if unavailable, pick the cheapest and note it)` : "- Fare: pick the CHEAPEST fare for the chosen flight unless instructed otherwise.",
		"- If multiple flights match, pick the CHEAPEST at a reasonable time unless the instructions say otherwise. Note the flight you picked in your finish detail.",
		"",
		"TRAVELLER:",
		`- Full name: ${p.fullName}`,
		`- Email: ${p.email}`,
		p.phone ? `- Phone: ${p.phone}` : "",
		p.dob ? `- Date of birth: ${p.dob}` : "",
		"",
		"ACCOUNT:",
		job.hasStoredLogin
			? "- You HAVE a saved login for this airline. If asked to sign in, use the traveller email + the account password below (sign in to reuse saved traveller details — do NOT re-enter card info)."
			: "- No saved login. Book as a GUEST if offered. Do NOT create an account unless the flow forces it.",
		job.password ? `- Account password (only if a login is required): ${job.password} — use EXACTLY this. Never invent one.` : "",
		"",
		"RULES:",
		"- Do exactly ONE tool call per turn — the next page snapshot follows.",
		"- Dismiss cookie/consent/newsletter/currency pop-ups if they block the form (click Accept/Close/No thanks) so you can proceed.",
		"- DATE PICKERS: open the picker, navigate months if needed, and CLICK the exact day cell for the requested date. If a date field is a plain textbox, `type` the date (try formats like the site's placeholder, or DD/MM/YYYY).",
		"- ORIGIN/DESTINATION are usually AUTOCOMPLETE fields: `type` a few letters of the city/airport, then CLICK the matching suggestion (or ArrowDown + Enter). Do not assume typing alone sticks.",
		"- DROPDOWNS: try `select` first; if it errors 'not a <select>', it's a custom combobox — `click` to open, then `click` the option.",
		"- After clicking Search/Continue/Next, expect a new page — act on the NEW snapshot, not the button you clicked. If your last action FAILED, do NOT repeat it; re-read the current snapshot.",
		"- NEVER invent traveller data. For a REQUIRED value you don't have (date of birth, a specific passenger detail, an ambiguous fare choice), call request_user_info(field, why) and wait — do NOT guess.",
		"- If a CAPTCHA / 'verify you are human' appears, do nothing — the system hands off to a human automatically.",
		"- If no flight matches the requested route/date, call finish(status:\"expired\", detail:\"…\").",
		"- Be decisive and brief. Do not narrate.",
		job.cacheHint ? `\nNOTES FROM A PRIOR BOOKING ON THIS SITE (reuse what worked, avoid what failed):\n${job.cacheHint}` : "",
		"\nRemember: your job ENDS at the payment page with finish(status:\"ready\"). The traveller pays.",
	];
	return lines.filter((l) => l !== "").join("\n");
}

/** Map a Claude tool call to a loop decision. Reuses the shared apply mapper for the
 *  browser actions; booking's finish statuses are a subset (ready/expired/blocked). */
export function toolCallToBookingDecision(call: { name: string; arguments: Record<string, unknown> }, thought?: string): ApplyDecision {
	// The shared mapper handles type/select/check/click/navigate/scroll/press_key/
	// request_user_info/finish. `upload` isn't offered here; pass a résumé-less job.
	return toolCallToDecision(call, { url: "", resumePath: "", candidate: { fullName: "", email: "" } }, thought);
}

/** The booking decision step: ask Claude (BYOK) for the next action given the page. */
export async function decideBookingAction(
	env: Env,
	userId: string,
	params: { job: BookingJob; actionLog: string[]; snapshot: PageSnapshot },
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
		"\nDo the single next action toward selecting the flight + filling passenger details. STOP at payment. Call exactly one tool.",
	].join("\n");

	const res = (await runUserWorkersAi(env, userId, "claude-sonnet-4-6", {
		messages: [
			{ role: "system", content: bookingSystemPrompt(params.job) },
			{ role: "user", content: userMsg },
		],
		tools: BOOKING_TOOLS,
		timeoutMs: 60_000,
	})) as { response?: string; tool_calls?: Array<{ name: string; arguments: Record<string, unknown> }>; usage?: { input: number; output: number } };

	const call = res.tool_calls?.[0];
	if (!call) {
		return { thought: res.response, finish: { status: "blocked", detail: res.response || "no action chosen" }, usage: res.usage };
	}
	const decision = toolCallToBookingDecision(call, res.response);
	decision.usage = res.usage;
	return decision;
}
