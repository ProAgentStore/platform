import type { Page } from "@playwright/test";

/**
 * The API a History area (#1590) reads, answered locally. It handles only the paths History's panels and the
 * Activity timeline call, and `fallback()`s everything else, so it layers over any other mock: register that one
 * first (Playwright runs the LAST registered route first).
 *
 * Everything under `/v1/instances/inst-1/` is recorded in `requests` as `METHOD /path?query`, so a spec can count
 * what a page asked for, and `calls` keeps the bodies of the writes.
 */
const API = "https://api.proagentstore.online";
const PREFIX = "/v1/instances/inst-1";

export const LOCAL_BROWSER_INSTANCE = { id: "inst-1", agent_id: "agent-1", name: "Gmail Job Search Scout", status: "active", slug: "job-search-scout", category: "productivity", icon_bg: "#7c3aed", sourceMode: "gmail", capabilities: { surfaces: ["chat", "settings"], runtime: "local_browser" } };
/** A local_browser agent that is not a Gmail Scout (#1604): its verification queue is a History panel. */
export const BROWSER_INSTANCE = { ...LOCAL_BROWSER_INSTANCE, name: "Job Researcher", slug: "job-researcher", sourceMode: undefined };
export const CODING_INSTANCE = { id: "inst-1", agent_id: "a-coder", name: "pags platform", agentName: "Repo Coder", status: "active", slug: "coder", category: "developer", icon_bg: "#0f766e", capabilities: { surfaces: ["coding"], runtime: "coding" } };

const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

export const LAUNCH = { engine: "chrome", browserType: "chromium", channel: "chrome", version: "142.0.0", executable: null, mode: "headless", profilePolicy: "persistent", profileId: "scout/chrome/profile", transport: "playwright", launchedAt: "2026-11-03T01:00:00Z", active: true };

const run = (runId: string, status: string, objective: string, extra: Record<string, unknown> = {}) => ({ runId, objective, status, stopReason: null, detail: null, iteration: 3, maxIterations: 40, startedAt: Date.now() - 3_600_000, finishedAt: status === "running" ? null : Date.now() - 1_800_000, ...extra });

const takeover = (id: string, over: Record<string, unknown> = {}) => ({
	id,
	subjectKind: "runtime_task",
	subjectId: `task-${id}`,
	state: "ended",
	reason: "captcha",
	mobileAllowed: true,
	endReason: "declined",
	expiresAt: iso(-20),
	createdAt: iso(120),
	activatedAt: null,
	endedAt: iso(100),
	...over,
});

export const verification = (leadId: string, over: Record<string, unknown> = {}) => ({
	leadId, canonicalUrl: `https://www.seek.com.au/job/${leadId}`, expectedTitle: `Role ${leadId}`, expectedCompany: "Acme", state: "awaiting", attempts: 0, nextAttemptAt: iso(-5), lastOutcome: null, lastDetail: null, ...over,
});

export interface HistoryMockOptions {
	/** Paths (relative to the instance) answered with a 500, to force one panel's failure. */
	fail?: string[];
	runs?: unknown[];
	queue?: Array<{ id: string; objective: string }>;
	takeovers?: unknown[];
	/** `GET /job-leads/browser-verifications` rows (#1604). */
	verifications?: unknown[];
	/** `null` = the runner reports no launch. */
	session?: { status: string; launch: unknown } | null;
	secureInputs?: unknown[];
	deliveries?: unknown[];
	events?: unknown[];
}

/** Every panel with something in it, one row needing the owner in loop-runs and takeovers. */
export function seededHistory(): HistoryMockOptions {
	return {
		runs: [
			run("run-done", "completed", "Fix the login redirect", { stopReason: "done" }),
			run("run-limit", "failed", "Migrate the schema", { stopReason: "max_iterations" }),
			run("run-stuck", "needs_human", "Rotate the signing keys", { stopReason: "escalated", startedAt: Date.now() - 29 * 86_400_000 }),
			run("run-live", "running", "Ship the docs", { health: "working" }),
		],
		queue: [{ id: "q-1", objective: "Fix the login" }, { id: "q-2", objective: "URGENT: leads dropped" }],
		takeovers: [
			takeover("t-old"),
			takeover("t-consent", { subjectKind: "manual", subjectId: "site-consent:www.seek.com.au", state: "requested", reason: "manual", endReason: null, endedAt: null }),
		],
		// One waits on the seek.com.au consent takeover above (needs the owner), one is closed and can be verified again.
		verifications: [verification("lead-closed", { state: "unverifiable", closedReason: "consent_expired", attempts: 3, canonicalUrl: "https://boards.example.org/jobs/9" }), verification("lead-wait")],
		session: { status: "connected", launch: LAUNCH },
		secureInputs: [{ id: "si-1", status: "consumed", label: "GitHub token", destinationScope: "instance", oneShot: true, expiresAt: iso(-60), createdAt: iso(300), consumedAt: iso(290) }],
		deliveries: [
			{ id: "del-dead", eventType: "lead.created", source: "connection", sourceInstanceId: "inst-1", targetInstanceId: "inst-2", action: "run_pipeline", status: "dead", attempts: 5, nextAttemptAt: null, lastError: "builder MCP unreachable", traceId: "run-42", createdAt: "2026-07-12T23:30:00.000Z" },
			{ id: "del-ok", eventType: "lead.created", source: "connection", sourceInstanceId: "inst-1", targetInstanceId: "inst-2", action: "run_pipeline", status: "delivered", attempts: 1, nextAttemptAt: null, lastError: null, traceId: null, createdAt: "2026-07-12T22:30:00.000Z" },
		],
	};
}

export async function installHistoryRoutes(page: Page, opts: HistoryMockOptions = seededHistory()) {
	const requests: string[] = [];
	const calls: Array<{ method: string; path: string; body: unknown }> = [];
	const runs = [...(opts.runs ?? [])] as Array<Record<string, unknown>>;
	let queue = [...(opts.queue ?? [])];
	const takeovers = [...(opts.takeovers ?? [])] as Array<Record<string, unknown>>;
	const deliveries = [...(opts.deliveries ?? [])] as Array<Record<string, unknown>>;

	await page.route(`${API}/**`, async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		if (!url.pathname.startsWith(`${PREFIX}/`) && url.pathname !== "/v1/instances/inst-2/trace") return route.fallback();
		const rest = url.pathname.slice(PREFIX.length);
		const method = req.method();
		const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
		requests.push(`${method} ${rest}${url.search}`);
		if (method !== "GET") calls.push({ method, path: rest, body: req.postData() ? req.postDataJSON() : null });

		if (opts.fail?.includes(rest)) return json({ error: "boom" }, 500);

		if (rest === "/activity") return json({ events: opts.events ?? [{ id: "e1", type: "tool.called", data: { tool: "search_knowledge" }, createdAt: iso(5) }, { id: "e2", type: "chat.response", createdAt: iso(6) }] });
		if (rest === "/loop" && method === "GET") return json({ runs });
		if (rest === "/loop/queue" && method === "GET") return json({ scope: "pending", entries: queue.map((q, i) => ({ ...q, next: i === 0 })), activeRun: null, inFlightStarts: [], handoff: null });
		const cancel = rest.match(/^\/loop\/([^/]+)\/cancel$/);
		if (cancel && method === "POST") {
			const r = runs.find((x) => x.runId === cancel[1]);
			if (r) r.cancelRequested = true;
			return json({ ok: true });
		}
		const cont = rest.match(/^\/loop\/([^/]+)\/continue$/);
		if (cont && method === "POST") return json({ ok: true });
		const unqueue = rest.match(/^\/loop\/queue\/([^/]+)$/);
		if (unqueue && method === "DELETE") {
			queue = queue.filter((q) => q.id !== decodeURIComponent(unqueue[1]));
			return json({ ok: true });
		}
		if (rest === "/board/order" && method === "POST") {
			const body = req.postDataJSON() as { jobKey: string };
			const id = body.jobKey.replace("objective:", "");
			const moving = queue.find((q) => q.id === id);
			if (moving) queue = [moving, ...queue.filter((q) => q !== moving)];
			return json({ column: { id: "waiting", title: "Waiting" }, items: [] });
		}

		if (rest.startsWith("/job-leads/browser-verifications") && method === "GET") return json({ leads: opts.verifications ?? [], attempts: [] });
		if (/^\/job-leads\/[^/]+\/browser-verification$/.test(rest) && method === "POST") return json({ ok: true });

		if (rest.startsWith("/browser-takeovers") && method === "GET") return json({ takeovers });
		const patch = rest.match(/^\/browser-takeovers\/([^/]+)$/);
		if (patch && method === "PATCH") {
			const t = takeovers.find((x) => x.id === patch[1]);
			if (t) Object.assign(t, { state: "ended", endReason: "declined" });
			return json({ takeover: t });
		}
		if (rest === "/local-browser/consent" && method === "PUT") {
			for (const t of takeovers) if (t.subjectKind === "manual" && t.state === "requested") Object.assign(t, { state: "resumed", endReason: "resumed_at_machine" });
			return json({ consent: [] });
		}

		if (rest === "/browser-settings/session") {
			const s = opts.session === undefined ? { status: "connected", launch: LAUNCH } : opts.session;
			return json(s === null ? { status: "connected", launch: null, launches: [] } : { ...s, launches: s.launch ? [s.launch] : [] });
		}
		if (rest.startsWith("/secure-inputs") && method === "GET") return json({ requests: opts.secureInputs ?? [], total: (opts.secureInputs ?? []).length, nextOffset: null });
		if (rest.startsWith("/connections/deliveries") && method === "GET") return json({ deliveries });
		const replay = rest.match(/^\/connections\/deliveries\/([^/]+)\/replay$/);
		if (replay && method === "POST") {
			const d = deliveries.find((x) => x.id === replay[1]);
			if (d) Object.assign(d, { status: "delivered", lastError: null });
			return json({ ok: true });
		}
		if (rest === "/trace") return json({ events: [{ id: "tr1", event: "chain.link", message: "started the child run", level: "info" }] });
		return route.fallback();
	});
	return { requests, calls };
}
