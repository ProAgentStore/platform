/**
 * The health report (#198): one measurement, two surfaces.
 *
 * `platform_health` (an MCP tool) and `GET /status` + `/status.json` (the public page) both
 * render {@link probeHealth}. The report distinguishes the components the incident could
 * not: the MCP gateway, authentication, account/state hydration, local-runner dispatch,
 * coding-loop orchestration and the external connectors — each with its own verdict and,
 * where a cheap live probe exists, its own measured latency.
 *
 * What is NEVER in the report: a secret, a token, a tenant's data, an instance id. The
 * probes are public endpoints (`/health` on the API, GitHub's public status feed) and the
 * recent-latency figures are tool NAMES and API PATHS — the product's own vocabulary.
 */
import { apiBase, type McpEnv } from "./http.js";
import { ALERT_THRESHOLDS, LATENCY_BUDGET_MS, type LatencyRing, type LatencyStage, type LatencySummary, type LatencyVerdict, latencyRing, verdictFor } from "./latency.js";
import { MCP_SERVER_VERSION } from "./server-version.js";
import { verifyMcpSession } from "./session.js";

export type ComponentStatus = "ok" | "degraded" | "down" | "unauthenticated" | "unknown";

export interface ComponentReport {
	status: ComponentStatus;
	/** The live probe's own duration, when one ran. */
	ms?: number;
	/** What was probed, so a reader can reproduce it. Never carries credentials. */
	probe?: string;
	/** Recent latency seen by this isolate for the stage, when any. */
	recent?: LatencySummary & { verdict: LatencyVerdict };
	detail?: string;
}

export interface HealthReport {
	ok: boolean;
	service: "proagentstore-mcp";
	version: string;
	traceId: string;
	timestamp: string;
	components: {
		gateway: ComponentReport;
		auth: ComponentReport;
		state: ComponentReport;
		runner: ComponentReport;
		coding_loop: ComponentReport;
		connectors: { github: ComponentReport };
	};
	/** Every stage's recent summary from this isolate's ring, budget beside it. */
	recent: Record<LatencyStage, LatencySummary & { verdict: LatencyVerdict; budgetMs: number }>;
	alerts: typeof ALERT_THRESHOLDS;
	/** Which measurements this report can and cannot make — read before drawing conclusions. */
	scope: string;
}

/** A probe that must not itself become the slow thing: hard cap, and a failure is a verdict. */
const PROBE_TIMEOUT_MS = 5_000;

export interface ProbeOptions {
	env: McpEnv;
	/** The connection's session token, when there is one — auth is then measured, not assumed. */
	token?: string | null;
	ring?: LatencyRing;
	traceId?: string;
	/** Injected for tests; defaults to the global. */
	fetchImpl?: typeof fetch;
	now?: () => number;
}

async function timedFetch(fetchImpl: typeof fetch, url: string, now: () => number): Promise<{ ms: number; status: number | null; body: string }> {
	const started = now();
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
	try {
		const res = await fetchImpl(url, { signal: ctl.signal, headers: { Accept: "application/json" } });
		const body = await res.text();
		return { ms: now() - started, status: res.status, body };
	} catch {
		return { ms: now() - started, status: null, body: "" };
	} finally {
		clearTimeout(timer);
	}
}

function liveVerdict(stage: LatencyStage, ms: number, status: number | null): ComponentStatus {
	if (status === null || status >= 500) return "down";
	return ms > LATENCY_BUDGET_MS[stage] ? "degraded" : "ok";
}

function recentFor(ring: LatencyRing, stage: LatencyStage, predicate?: (name: string) => boolean): LatencySummary & { verdict: LatencyVerdict } {
	const summary = predicate ? ring.summaryWhere(stage, predicate) : ring.summary(stage);
	return { ...summary, verdict: verdictFor(stage, summary) };
}

/** A stage with no live probe: its verdict is whatever the ring has seen for its tool family. */
function fromRing(ring: LatencyRing, predicate: (name: string) => boolean, detail: string): ComponentReport {
	const recent = recentFor(ring, "tool", predicate);
	const status: ComponentStatus = recent.verdict === "unknown" ? "unknown" : recent.verdict;
	return { status, recent, detail };
}

export async function probeHealth(opts: ProbeOptions): Promise<HealthReport> {
	const ring = opts.ring ?? latencyRing;
	const fetchImpl = opts.fetchImpl ?? fetch;
	const now = opts.now ?? Date.now;
	const traceId = opts.traceId ?? crypto.randomUUID();

	// gateway — we are answering, so the live verdict is what the ring says about recent requests.
	const gatewayRecent = recentFor(ring, "gateway");
	const gateway: ComponentReport = {
		status: gatewayRecent.verdict === "unknown" ? "ok" : gatewayRecent.verdict,
		recent: gatewayRecent,
		detail: "this worker, edge to response start",
	};

	// auth — verify the connection's own session locally; no network.
	let auth: ComponentReport;
	if (!opts.token) {
		auth = { status: "unauthenticated", detail: "no session on this call — nothing to verify" };
	} else if (!opts.env.SESSION_SIGNING_KEY) {
		auth = { status: "down", detail: "SESSION_SIGNING_KEY is not configured on this worker" };
	} else {
		const started = now();
		// A malformed token (bad base64, no dot) throws inside the decoder; for a health probe
		// that is the same answer as "did not verify", never a crash of the diagnostic itself.
		const payload = await verifyMcpSession(opts.token, opts.env.SESSION_SIGNING_KEY).catch(() => null);
		const ms = now() - started;
		auth = { status: payload ? liveVerdict("auth", ms, 200) : "degraded", ms, probe: "verifyMcpSession", recent: recentFor(ring, "auth"), ...(payload ? {} : { detail: "the session did not verify (expired or not this platform's)" }) };
	}

	// state — the API worker that hydrates accounts; its /health is the cheapest round trip.
	const apiUrl = `${apiBase(opts.env)}/health`;
	const api = await timedFetch(fetchImpl, apiUrl, now);
	const state: ComponentReport = {
		status: liveVerdict("state", api.ms, api.status),
		ms: api.ms,
		probe: "GET /health on the API worker",
		recent: recentFor(ring, "state"),
		...(api.status === null ? { detail: "the API worker did not answer within the probe timeout" } : {}),
	};

	// connectors.github — GitHub's own public status feed; measured and read, no token.
	const gh = await timedFetch(fetchImpl, "https://www.githubstatus.com/api/v2/status.json", now);
	let indicator = "unknown";
	try {
		indicator = String((JSON.parse(gh.body) as { status?: { indicator?: string } }).status?.indicator ?? "unknown");
	} catch {
		indicator = "unknown";
	}
	const github: ComponentReport = {
		status: gh.status === null ? "down" : indicator === "none" || indicator === "unknown" ? liveVerdict("connector", gh.ms, gh.status) : "degraded",
		ms: gh.ms,
		probe: "GET githubstatus.com status.json",
		recent: recentFor(ring, "connector", (n) => n.startsWith("github")),
		detail: `GitHub reports status indicator \`${indicator}\``,
	};

	// Tool families by name: the runtime/runner group (`register_instance_runtime`,
	// `instance_runtime_status`, `list_runner_nodes`, …) and the loop group (`coding_loop_*`,
	// `check_instance_loop`, `continue_instance_run`, `stop_instance_loop`, …).
	const runner = fromRing(ring, (n) => n.includes("runtime") || n.includes("runner"), "no live probe — verdict from recent runtime tool calls on this session");
	const codingLoop = fromRing(ring, (n) => n.startsWith("coding_loop_") || n.includes("instance_loop") || n.includes("instance_run"), "no live probe — verdict from recent coding-loop tool calls on this session");

	const stages: LatencyStage[] = ["gateway", "auth", "state", "tool", "api", "connector"];
	const recent = Object.fromEntries(
		stages.map((stage) => [stage, { ...recentFor(ring, stage), budgetMs: LATENCY_BUDGET_MS[stage] }]),
	) as HealthReport["recent"];

	const components = { gateway, auth, state, runner, coding_loop: codingLoop, connectors: { github } };
	const statuses = [gateway.status, auth.status, state.status, runner.status, codingLoop.status, github.status];
	return {
		ok: !statuses.some((s) => s === "down" || s === "degraded"),
		service: "proagentstore-mcp",
		version: MCP_SERVER_VERSION,
		traceId,
		timestamp: new Date(now()).toISOString(),
		components,
		recent,
		alerts: ALERT_THRESHOLDS,
		scope:
			"Live probes: auth (local verify), state (API /health), connectors.github (GitHub status feed). " +
			"Recent figures are this isolate's own ring — one MCP session's Durable Object, or the edge worker serving /status — not a fleet metric; " +
			"fleet p50/p95/p99 come from Workers Logs (`kind:\"mcp.latency\"`). Nothing here names a tenant, an instance or a secret.",
	};
}

const esc = (s: unknown): string => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function fmt(summary: LatencySummary | undefined): string {
	if (!summary || summary.count === 0) return "no samples yet";
	return `n=${summary.count} p50=${summary.p50}ms p95=${summary.p95}ms p99=${summary.p99}ms max=${summary.max}ms failures=${summary.failures}`;
}

/** The public status page. Plain HTML, no script, no styles beyond a table — it has to render when everything else is slow. */
export function renderStatusHtml(report: HealthReport): string {
	const c = report.components;
	const rows: Array<[string, ComponentReport]> = [
		["MCP gateway", c.gateway],
		["Authentication", c.auth],
		["Account / state hydration (API)", c.state],
		["Local-runner dispatch", c.runner],
		["Coding-loop orchestration", c.coding_loop],
		["Connector: GitHub", c.connectors.github],
	];
	const body = rows
		.map(
			([label, r]) =>
				`<tr><td>${esc(label)}</td><td class="s-${esc(r.status)}">${esc(r.status)}</td><td>${r.ms === undefined ? "—" : `${esc(r.ms)} ms`}</td><td>${esc(fmt(r.recent))}</td><td>${esc(r.detail ?? r.probe ?? "")}</td></tr>`,
		)
		.join("");
	const budgets = (Object.keys(report.recent) as LatencyStage[])
		.map((stage) => {
			const r = report.recent[stage];
			return `<tr><td>${esc(stage)}</td><td>${esc(r.budgetMs)} ms</td><td class="s-${esc(r.verdict)}">${esc(r.verdict)}</td><td>${esc(fmt(r))}</td></tr>`;
		})
		.join("");
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ProAgentStore MCP status</title><style>body{font:14px/1.5 system-ui,sans-serif;margin:2rem;max-width:64rem}table{border-collapse:collapse;width:100%;margin:1rem 0}td,th{border:1px solid #ccc;padding:.4rem .6rem;text-align:left;vertical-align:top}.s-ok{color:#166534}.s-degraded{color:#b45309}.s-down{color:#b91c1c}.s-unknown,.s-unauthenticated{color:#6b7280}code{font-size:.9em}</style></head><body><h1>ProAgentStore MCP — ${report.ok ? "operational" : "degraded"}</h1><p>version <code>${esc(report.version)}</code> · trace <code>${esc(report.traceId)}</code> · ${esc(report.timestamp)}</p><table><thead><tr><th>Component</th><th>Status</th><th>Probe</th><th>Recent (this edge)</th><th>Notes</th></tr></thead><tbody>${body}</tbody></table><h2>Latency budgets</h2><p>A stage whose p95 stays over budget for ${Math.round(report.alerts.sustainedWindowMs / 60000)} minutes, or whose transport failure rate exceeds ${report.alerts.transportFailureRatePct}%, is an incident.</p><table><thead><tr><th>Stage</th><th>Budget</th><th>Verdict</th><th>Recent (this edge)</th></tr></thead><tbody>${budgets}</tbody></table><p>${esc(report.scope)}</p><p>Machine-readable: <a href="/status.json">/status.json</a>. Over MCP: the read-only <code>platform_health</code> tool, which also sees the session's own recent tool latency.</p></body></html>`;
}
