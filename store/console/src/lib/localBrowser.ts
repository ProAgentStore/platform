/**
 * Local CLI browser research in the console (#946) — every decision the Research tab and the
 * settings section make, as pure functions, so they are tested without rendering.
 *
 * The one distinction the UI must never blur: PAGS SUPERVISES (stores the run, asks the owner,
 * saves what they approve) while a Codex or Claude Code CLI signed in on the owner's own machine
 * DRIVES the browser. Every label below says which of the two a step belongs to.
 */
import type {
	LocalBrowserCapabilityView,
	LocalBrowserFindingReview,
	LocalBrowserPauseReason,
	LocalBrowserPreflight,
	LocalBrowserRunStatus,
	LocalBrowserRunView,
	LocalBrowserSettingsValues,
	LocalBrowserTraceEvent,
} from "./types";

export const ACTIVE_STATUSES: readonly LocalBrowserRunStatus[] = ["queued", "running", "paused"];
export const isActiveRun = (status: LocalBrowserRunStatus) => ACTIVE_STATUSES.includes(status);

export const STATUS_LABEL: Record<LocalBrowserRunStatus, { label: string; tone: "accent" | "warning" | "success" | "danger" | "muted" }> = {
	queued: { label: "Queued", tone: "muted" },
	running: { label: "Researching", tone: "accent" },
	paused: { label: "Waiting for you", tone: "warning" },
	completed: { label: "Finished", tone: "success" },
	failed: { label: "Failed", tone: "danger" },
	cancelled: { label: "Cancelled", tone: "muted" },
};

export const TONE_CLASS: Record<"accent" | "warning" | "success" | "danger" | "muted", string> = {
	accent: "text-accent",
	warning: "text-warning",
	success: "text-success",
	danger: "text-danger",
	muted: "text-muted",
};

// ── Setup checklist ──────────────────────────────────────────────────────────────────────────

const CHECK_LABEL: Record<string, string> = {
	settings: "Settings fit this agent",
	runner: "Runner connected",
	runner_support: "Runner can do browser research",
	engine_login: "Task engine signed in",
	profile_consent: "Signed-in browser profile allowed",
};

export interface ChecklistItem {
	id: string;
	label: string;
	state: "ok" | "todo" | "unknown";
	detail: string;
}

/** Only the runner, the engine login and the browser — never a repository or GitHub (#946). */
export function setupChecklist(preflight: LocalBrowserPreflight | null): ChecklistItem[] {
	return (preflight?.checks ?? []).map((c) => ({
		id: c.id,
		label: CHECK_LABEL[c.id] ?? c.id,
		state: c.ok === true ? "ok" : c.ok === false ? "todo" : "unknown",
		detail: c.detail,
	}));
}

// ── Why a run stopped ────────────────────────────────────────────────────────────────────────

const ERROR_TEXT: Record<string, string> = {
	runner_offline: "No runner was connected. Run `pags up` on the machine that should do the research, then start again.",
	runner_unsupported: "The runner on that machine is too old for browser research. Update it (npm i -g @proagentstore/cli), run `pags up`, then start again.",
	runner_unreachable: "The runner stopped answering. Check `pags up` on that machine, then start again.",
	runner_rejected: "The runner refused the run.",
	runner_lost: "The runner lost this run — it restarted or went away for too long. Start the run again.",
	engine_not_signed_in: "The CLI on that machine is not signed in.",
	engine_failed: "The CLI stopped with an error.",
	runner_result_invalid: "The runner sent a result PAGS could not accept.",
	cancelled: "You cancelled this run.",
};

/** What to tell the owner about a failed or cancelled run — the step that fixes it first. */
export function runProblem(run: Pick<LocalBrowserRunView, "status" | "errorCode" | "error">): string | null {
	if (run.status !== "failed" && run.status !== "cancelled") return null;
	const known = run.errorCode ? ERROR_TEXT[run.errorCode] : undefined;
	if (known && run.error && run.errorCode !== "cancelled" && !known.includes(run.error)) return `${known} ${run.error}`;
	return known ?? run.error ?? "The run stopped without a reason.";
}

// ── A pause, and the one thing that resolves it ──────────────────────────────────────────────

export type PauseAction = { kind: "allow_site"; domain: string } | { kind: "allow_profile" } | { kind: "done_in_browser" } | { kind: "keep_reading" };

export interface PauseBanner {
	title: string;
	body: string;
	actions: PauseAction[];
}

/** The site or scope a pause is about, from the newest event that asked. */
function pauseSubject(events: readonly LocalBrowserTraceEvent[]): { domain?: string; scope?: string } {
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (e.type === "consent.requested") return { domain: e.domain, scope: typeof e.detail?.scope === "string" ? e.detail.scope : undefined };
		if (e.type === "browser.blocked" || e.type === "run.paused") {
			const domain = e.domain ?? (typeof e.detail?.domain === "string" ? e.detail.domain : undefined);
			if (domain) return { domain };
		}
	}
	return {};
}

/**
 * The banner for a paused run: what it is waiting on, and only the step that unblocks it. Allowing
 * a site records consent and resumes; a captcha or sign-in is done by the owner in the browser on
 * their own machine — PAGS cannot do it for them — and then resumed.
 */
export function pauseBanner(run: Pick<LocalBrowserRunView, "status" | "pauseReason" | "runnerNode">, events: readonly LocalBrowserTraceEvent[]): PauseBanner | null {
	if (run.status !== "paused") return null;
	const { domain, scope } = pauseSubject(events);
	const machine = run.runnerNode ? `on ${run.runnerNode}` : "on the machine running the research";
	const reason: LocalBrowserPauseReason | null = run.pauseReason;
	if (reason === "consent_required" && scope === "signed_in_profile") {
		return { title: "May research use your signed-in browser?", body: "The run is set to use your own browser profile, with your sign-ins. It waits until you decide.", actions: [{ kind: "allow_profile" }] };
	}
	if (reason === "consent_required") {
		return {
			title: domain ? `Open ${domain}?` : "A new site needs your OK",
			body: "The research wants to read a site you have not allowed yet. Allowing it lets this and later runs open it; the run waits until you decide.",
			actions: domain ? [{ kind: "allow_site", domain }] : [{ kind: "done_in_browser" }],
		};
	}
	if (reason === "captcha") return { title: `Captcha${domain ? ` on ${domain}` : ""}`, body: `Solve it in the browser ${machine}, then resume. The research never tries to get past it.`, actions: [{ kind: "done_in_browser" }] };
	if (reason === "login_required") return { title: `Sign-in${domain ? ` on ${domain}` : ""}`, body: `Sign in yourself in the browser ${machine} if you want this site read, then resume.`, actions: [{ kind: "done_in_browser" }] };
	// #947: a paywall is a pause too — an owner who subscribes signs in to it themselves; the run never gets around it.
	if (reason === "paywall") return { title: `Paywall${domain ? ` on ${domain}` : ""}`, body: `If you subscribe, sign in yourself in the browser ${machine}, then resume. Otherwise stop the run — the research never gets around a paywall.`, actions: [{ kind: "done_in_browser" }] };
	// #947: a bot check or access block is a person's to clear in that browser, or to leave — never the run's to get past.
	if (reason === "access_blocked") return { title: `${domain ?? "A site"} is blocking automated browsing`, body: `If it is a "verify you are human" check, pass it yourself in the browser ${machine}, then resume. If it is a hard block, stop — the research does not work around it.`, actions: [{ kind: "done_in_browser" }] };
	// #947: a page that submits, pays or uploads. Nothing on it can be filled either way; the question is only whether to read it.
	if (reason === "write_affordance") return { title: `${domain ? `A page on ${domain}` : "A page"} asks for something to be submitted`, body: "It is a form for applying, paying, uploading or creating an account. Research cannot fill or submit anything; let it read the page, or stop the run and it goes back.", actions: [{ kind: "keep_reading" }] };
	return { title: "The run is waiting for you", body: `Check the browser ${machine}, then resume.`, actions: [{ kind: "done_in_browser" }] };
}

// ── The run as a sequence of steps ───────────────────────────────────────────────────────────

export interface Phase {
	id: "brief" | "cli" | "pages" | "findings" | "review";
	label: string;
	/** Who does this step — the honest answer the UI must keep visible. */
	actor: "PAGS" | "Local CLI" | "You";
	state: "done" | "current" | "waiting" | "blocked";
	detail: string;
}

export function engineAuthLabel(engineAuth: string | null | undefined): { label: string; tone: "success" | "warning" | "danger" | "muted" } {
	switch (engineAuth) {
		case "subscription":
			return { label: "Subscription", tone: "success" };
		case "machine-login":
			return { label: "Machine login", tone: "success" };
		case "api-key":
			return { label: "API key — billed per token", tone: "warning" };
		case "missing_login":
			return { label: "Not signed in", tone: "danger" };
		default:
			return { label: "Not checked yet", tone: "muted" };
	}
}

/** Brief → Local CLI started → Browser pages → Findings parsed → Review/save (#946). */
export function runPhases(run: LocalBrowserRunView, events: readonly LocalBrowserTraceEvent[]): Phase[] {
	const has = (t: string) => events.some((e) => e.type === t);
	const pages = events.filter((e) => e.type === "browser.navigated");
	const found = run.result?.findings.length ?? events.filter((e) => e.type === "finding.parsed").length;
	const ended = !isActiveRun(run.status);
	const blocked = run.status === "paused";
	const started = has("engine.started");
	const reviewed = Object.keys(run.findingReviews).length;
	const auth = engineAuthLabel(run.engineAuth ?? (events.find((e) => e.type === "engine.auth_checked")?.detail?.engineAuth as string | undefined));
	return [
		{ id: "brief", label: "Brief", actor: "PAGS", state: "done", detail: run.objective },
		{
			id: "cli",
			label: "Local CLI started",
			actor: "Local CLI",
			state: started ? "done" : ended ? "blocked" : "current",
			detail: started ? `${run.policy.engine === "claude" ? "Claude Code" : "Codex"} on ${run.runnerNode ?? "your machine"} · ${auth.label}` : ended ? "Never started" : "Waiting for the runner",
		},
		{
			id: "pages",
			label: "Browser pages",
			actor: "Local CLI",
			state: pages.length ? (ended ? "done" : blocked ? "blocked" : "current") : started && !ended ? "current" : ended ? "done" : "waiting",
			detail: pages.length ? `${pages.length} page${pages.length === 1 ? "" : "s"} on ${new Set(pages.map((p) => p.domain)).size} site(s)` : "None yet",
		},
		{
			id: "findings",
			label: "Findings parsed",
			actor: "Local CLI",
			state: found ? (ended ? "done" : "current") : ended ? "done" : "waiting",
			detail: `${found} finding${found === 1 ? "" : "s"}${run.result?.sourceFailures.length ? ` · ${run.result.sourceFailures.length} source(s) unreadable` : ""}`,
		},
		{
			id: "review",
			label: "Review and save",
			actor: "You",
			state: run.status === "completed" ? (found && reviewed >= found ? "done" : "current") : "waiting",
			detail: run.status === "completed" ? `${reviewed} of ${found} reviewed` : "After the run finishes",
		},
	];
}

/** The pages the run opened, newest first, for the readable step list. */
export function pageSteps(events: readonly LocalBrowserTraceEvent[]): Array<{ seq: number; at: string; domain: string; url: string; title: string; note?: string }> {
	return events
		.filter((e) => e.type === "browser.navigated" || e.type === "browser.blocked" || (e.type === "policy.decision" && e.detail?.decision === "refused"))
		.map((e) => ({
			seq: e.seq,
			at: e.at,
			domain: e.domain ?? "",
			url: e.url ?? "",
			title: typeof e.detail?.title === "string" ? e.detail.title : "",
			note: e.type === "browser.blocked" ? `Blocked: ${String(e.detail?.reason ?? "")}` : e.type === "policy.decision" ? `Refused: ${String(e.detail?.reason ?? e.detail?.tool ?? "")}` : undefined,
		}))
		.reverse();
}

export function reviewLabel(review: LocalBrowserFindingReview | undefined): { label: string; tone: "success" | "warning" | "muted" } | null {
	if (!review) return null;
	if (review.decision === "saved") return { label: `Saved to ${review.collection ?? "the collection"}`, tone: "success" };
	if (review.decision === "duplicate") return { label: `Already in ${review.collection ?? "the collection"}`, tone: "warning" };
	return { label: "Skipped", tone: "muted" };
}

// ── Settings form ────────────────────────────────────────────────────────────────────────────

/** One hostname per line or comma — what the owner types into a site list. */
export function parseDomains(text: string): string[] {
	return [...new Set(text.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean))];
}

/** The auth modes to offer: subscription first; api-key only when the agent allows per-token billing. */
export function authModeChoices(cap: Pick<LocalBrowserCapabilityView, "subscriptionOnly">): Array<{ value: "subscription" | "machine" | "api-key"; label: string }> {
	return [
		{ value: "subscription", label: "Subscription (your Codex or Claude plan)" },
		{ value: "machine", label: "Whatever the machine is signed in with" },
		...(cap.subscriptionOnly ? [] : [{ value: "api-key" as const, label: "API key — billed per token" }]),
	];
}

export interface SettingsForm {
	engine: string;
	authMode: string;
	workspace: "scratch" | "path";
	workspacePath: string;
	browserProfile: "isolated" | "default";
	allowDomains: string;
	denyDomains: string;
	maxMinutes: string;
	maxPages: string;
	maxActions: string;
	maxConcurrent: string;
	collection: string;
	keyField: string;
}

export function formFromSettings(s: LocalBrowserSettingsValues): SettingsForm {
	return {
		engine: s.engine ?? "",
		authMode: s.authMode ?? "",
		workspace: s.workspace?.kind === "path" ? "path" : "scratch",
		workspacePath: s.workspace?.kind === "path" ? s.workspace.path : "",
		browserProfile: s.browserProfile ?? "isolated",
		allowDomains: (s.access?.allowDomains ?? []).join("\n"),
		denyDomains: (s.access?.denyDomains ?? []).join("\n"),
		maxMinutes: s.limits?.maxMinutes?.toString() ?? "",
		maxPages: s.limits?.maxPages?.toString() ?? "",
		maxActions: s.limits?.maxActions?.toString() ?? "",
		maxConcurrent: s.limits?.maxConcurrent?.toString() ?? "",
		collection: s.collection?.name ?? "",
		keyField: s.collection?.keyField ?? "",
	};
}

/**
 * The PATCH the form describes. An empty field is sent as `null` — back to the agent's default —
 * so a cleared box means "use the default", never an empty value the server would refuse.
 */
export function patchFromForm(f: SettingsForm): Record<string, unknown> {
	const num = (v: string) => (v.trim() ? Number(v) : null);
	return {
		engine: f.engine || null,
		authMode: f.authMode || null,
		workspace: f.workspace === "path" ? { kind: "path", path: f.workspacePath.trim() } : null,
		browserProfile: f.browserProfile === "default" ? "default" : null,
		access: { allowDomains: parseDomains(f.allowDomains), denyDomains: parseDomains(f.denyDomains) },
		limits: { maxMinutes: num(f.maxMinutes), maxPages: num(f.maxPages), maxActions: num(f.maxActions), maxConcurrent: num(f.maxConcurrent) },
		collection: f.collection.trim() ? { name: f.collection.trim(), ...(f.keyField.trim() ? { keyField: f.keyField.trim() } : {}) } : null,
	};
}
