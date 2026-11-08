import type { Page } from "@playwright/test";

/**
 * The Original Finder routes (#1616), answered locally. Handles only `/v1/instances/inst-1/original-finder*` and
 * `fallback()`s everything else, so it layers over any other mock (register that one first: Playwright runs the
 * LAST registered route first). `requests` records every call as `METHOD /path`; `puts` keeps the settings bodies.
 */
const API = "https://api.proagentstore.online";
const PREFIX = "/v1/instances/inst-1/original-finder";

/** A `local_browser` agent that is the target of a `job.lead.original_missing` connection; the server says so with `originalFinder`. */
export const FINDER_INSTANCE = { id: "inst-1", agent_id: "agent-1", name: "Original Finder", status: "active", slug: "original-finder", category: "productivity", icon_bg: "#0369a1", originalFinder: true, capabilities: { surfaces: ["chat", "settings"], runtime: "local_browser" } };
/** The same runtime with no connection to it, and no Gmail source. */
export const PLAIN_LOCAL_BROWSER_INSTANCE = { id: "inst-1", agent_id: "agent-2", name: "Web Researcher", status: "active", slug: "web-researcher", category: "productivity", icon_bg: "#7c3aed", capabilities: { surfaces: ["chat", "settings"], runtime: "local_browser" } };

const lead = (id: string, state: string, over: Record<string, unknown> = {}) => ({ lead_id: id, source_instance_id: "inst-scout", state, attempts: 1, next_attempt_at: null, run_id: null, detail: null, original_url: null, updated_at: Date.now(), ...over });

export const FINDER_LEADS = [
	lead("l-found", "found", { original_url: "https://careers.acme.example/jobs/platform-engineer-with-a-very-long-path-segment-that-must-wrap-on-a-phone" }),
	lead("l-queued", "queued", { attempts: 0, next_attempt_at: Date.now() + 600_000 }),
	lead("l-failed", "failed", { attempts: 3, detail: "The company site blocked the research run after three tries." }),
	lead("l-scope", "out_of_scope", { attempts: 0, detail: "out_of_scope: role not in your list" }),
];

export interface FinderMockOptions {
	settings?: { dailyCap: number; roles: string[]; locations: string[]; exclude: string[] };
	scope?: { roles: string[]; locations: string[]; exclude: string[]; source: string };
	budget?: { dailyCap: number; usedToday: number; remaining: number };
	counts?: Record<string, number>;
	leads?: unknown[];
	/** The overview read answers 500. */
	failOverview?: boolean;
	/** The settings PUT answers 400 with this text. */
	refusePut?: string;
}

export async function installFinderRoutes(page: Page, opts: FinderMockOptions = {}) {
	const requests: string[] = [];
	const puts: unknown[] = [];
	let settings = opts.settings ?? { dailyCap: 10, roles: [], locations: [], exclude: [] };
	await page.route(`${API}/**`, async (route) => {
		const req = route.request();
		const url = new URL(req.url());
		if (!url.pathname.startsWith(PREFIX)) return route.fallback();
		const json = (data: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
		requests.push(`${req.method()} ${url.pathname.slice("/v1/instances/inst-1".length)}`);
		if (url.pathname === `${PREFIX}/settings` && req.method() === "PUT") {
			puts.push(req.postDataJSON());
			if (opts.refusePut) return json({ error: opts.refusePut }, 400);
			settings = { ...settings, ...(req.postDataJSON() as object) };
			return json({ settings });
		}
		if (url.pathname === PREFIX) {
			if (opts.failOverview) return json({ error: "boom" }, 500);
			const leads = opts.leads ?? FINDER_LEADS;
			return json({
				settings,
				scope: opts.scope ?? { roles: ["platform engineer", "site reliability"], locations: [], exclude: [], source: "runner" },
				budget: opts.budget ?? { dailyCap: settings.dailyCap, usedToday: 4, remaining: Math.max(0, settings.dailyCap - 4) },
				counts: opts.counts ?? { found: 1, queued: 1, failed: 1, out_of_scope: 1 },
				leads,
			});
		}
		return route.fallback();
	});
	return { requests, puts };
}
