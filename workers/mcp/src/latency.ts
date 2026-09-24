/**
 * Stage-level latency for this worker (#198) — one ring of recent samples, one summary.
 *
 * ── What the incident looked like, and why stages
 *
 * On 2026-09-24 `whoami` took 12.2 s and four independent core calls crossed 20 s at once
 * (proappstore-online/platform#198). Nothing said WHERE the time went: the request log has
 * one number per request, the audit log records writes only, and the safety layer counts
 * `tools/call` messages, not durations. Measured the same day from an APAC client: TLS and
 * TCP stayed normal while time-to-first-byte spiked to 4–16 s on requests that touch no
 * auth, no database and no connector — this worker's own landing text, `/health`, the API
 * worker's `/health`, and a sibling store's MCP landing page — while an edge endpoint with no
 * Worker behind it and api.github.com stayed flat from the same colo. That is the edge or
 * the Worker's start, not a slow dependency, and it is the distinction every future report
 * needs to be able to make without a human running curl.
 *
 * So every hop is timed under a named STAGE, and the health tool reads the ring:
 *
 *   gateway    the whole request as this worker saw it (edge → response start)
 *   auth       verifying the session/OAuth identity
 *   state      hydrating the account (the roster read at DO start)
 *   tool       one tool handler, end to end
 *   api        one call to api.proagentstore.online
 *   connector  an external system (GitHub, …) reached on the caller's behalf
 *
 * ── Scope of the ring, stated so the numbers are not over-read
 *
 * The ring is per ISOLATE: the Durable Object serving one MCP session holds its own, the
 * plain worker that serves `/status` holds another, and neither sees the other's samples.
 * It is a recent-latency view for "what has THIS session/edge seen lately", not a fleet
 * metric. Fleet-wide p50/p95/p99 come from Workers Logs, which receive every sample as one
 * structured `mcp.latency` line — the query side of this is documented in
 * platform-docs/mcp.md ("Health And Latency").
 */

export type LatencyStage = "gateway" | "auth" | "state" | "tool" | "api" | "connector";

/**
 * Budget per stage, in milliseconds. A single sample over budget is "slow"; a p95 over
 * budget for {@link ALERT_THRESHOLDS.sustainedWindowMs} is what pages someone.
 */
export const LATENCY_BUDGET_MS: Record<LatencyStage, number> = {
	gateway: 1_000,
	auth: 500,
	state: 2_000,
	tool: 5_000,
	api: 3_000,
	connector: 8_000,
};

/** The alert rules, in one place so the docs and the health verdict quote the same numbers. */
export const ALERT_THRESHOLDS = {
	/** A stage whose p95 stays over its budget for this long is an incident, not a blip. */
	sustainedWindowMs: 5 * 60_000,
	/** Transport-level failures (thrown fetch, aborted stream) as a share of requests. */
	transportFailureRatePct: 2,
	/** Fewer samples than this and a p95 is noise — the verdict is `unknown`, not `ok`. */
	minSamples: 5,
} as const;

export interface LatencySample {
	stage: LatencyStage;
	/** What was timed: a tool name, an API path, a connector, `request`. Never an id or a secret. */
	name: string;
	ms: number;
	ok: boolean;
	/** Epoch ms when the sample was taken. */
	at: number;
}

export interface LatencySummary {
	count: number;
	p50: number | null;
	p95: number | null;
	p99: number | null;
	max: number | null;
	failures: number;
	failureRatePct: number | null;
	/** Epoch ms of the newest sample, so a reader can tell "quiet" from "healthy". */
	newestAt: number | null;
}

export type LatencyVerdict = "ok" | "degraded" | "unknown";

const RING_CAPACITY = 256;

/** Nearest-rank percentile over an ASCENDING array. `p` in (0, 100]. */
export function percentile(sorted: readonly number[], p: number): number | null {
	if (sorted.length === 0) return null;
	const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
	return sorted[rank - 1] ?? null;
}

export function summarize(samples: readonly LatencySample[]): LatencySummary {
	const sorted = samples.map((s) => s.ms).sort((a, b) => a - b);
	const failures = samples.filter((s) => !s.ok).length;
	return {
		count: samples.length,
		p50: percentile(sorted, 50),
		p95: percentile(sorted, 95),
		p99: percentile(sorted, 99),
		max: sorted.length ? sorted[sorted.length - 1] ?? null : null,
		failures,
		failureRatePct: samples.length ? Math.round((failures / samples.length) * 1000) / 10 : null,
		newestAt: samples.length ? Math.max(...samples.map((s) => s.at)) : null,
	};
}

/**
 * The verdict a summary earns against its stage's budget. `unknown` below the minimum
 * sample count — an empty ring must never read as healthy.
 */
export function verdictFor(stage: LatencyStage, summary: LatencySummary): LatencyVerdict {
	if (summary.count < ALERT_THRESHOLDS.minSamples || summary.p95 === null) return "unknown";
	if (summary.p95 > LATENCY_BUDGET_MS[stage]) return "degraded";
	if ((summary.failureRatePct ?? 0) > ALERT_THRESHOLDS.transportFailureRatePct) return "degraded";
	return "ok";
}

export interface LatencyRing {
	record(sample: Omit<LatencySample, "at"> & { at?: number }): void;
	/** Every sample, oldest first, optionally one stage's. */
	samples(stage?: LatencyStage): LatencySample[];
	summary(stage: LatencyStage): LatencySummary;
	/** Samples whose `name` starts with one of the prefixes — how a stage is split by tool family. */
	summaryWhere(stage: LatencyStage, predicate: (name: string) => boolean): LatencySummary;
	clear(): void;
}

export function newLatencyRing(capacity = RING_CAPACITY): LatencyRing {
	const buf: LatencySample[] = [];
	return {
		record(sample) {
			buf.push({ ...sample, at: sample.at ?? Date.now(), ms: Math.max(0, Math.round(sample.ms)) });
			if (buf.length > capacity) buf.splice(0, buf.length - capacity);
		},
		samples(stage) {
			return stage ? buf.filter((s) => s.stage === stage) : [...buf];
		},
		summary(stage) {
			return summarize(buf.filter((s) => s.stage === stage));
		},
		summaryWhere(stage, predicate) {
			return summarize(buf.filter((s) => s.stage === stage && predicate(s.name)));
		},
		clear() {
			buf.length = 0;
		},
	};
}

/** The isolate's ring. Per isolate by construction — see the header. */
export const latencyRing: LatencyRing = newLatencyRing();

/**
 * Record one sample in the ring AND as one structured log line, which is the half Workers
 * Logs can aggregate across every isolate. The line is JSON so a Logs query can filter on
 * `kind`, `stage` and `name` and compute percentiles over `ms`; nothing in it identifies a
 * tenant (a tool name and an API path are the product's own vocabulary).
 */
export function recordLatency(sample: Omit<LatencySample, "at">, traceId?: string): void {
	latencyRing.record(sample);
	console.log(JSON.stringify({ kind: "mcp.latency", ...sample, ms: Math.round(sample.ms), ...(traceId ? { traceId } : {}) }));
}

/** Time an async step and record it; the step's outcome (thrown or returned) is passed through. */
export async function timed<T>(stage: LatencyStage, name: string, step: () => Promise<T>, traceId?: string): Promise<T> {
	const started = Date.now();
	try {
		const value = await step();
		recordLatency({ stage, name, ms: Date.now() - started, ok: true }, traceId);
		return value;
	} catch (err) {
		recordLatency({ stage, name, ms: Date.now() - started, ok: false }, traceId);
		throw err;
	}
}

type FetchLike<E> = { fetch(request: Request, env: E, ctx: ExecutionContext): Response | Promise<Response> };

/**
 * Wrap the worker entry so EVERY request is a `gateway` sample and carries a trace id.
 *
 * `X-Trace-Id` is minted here (or taken from an incoming `X-Trace-Id`, so a client that
 * already correlates can keep its id) and echoed on the response beside a `Server-Timing`
 * header — the one place a browser or `curl -v` can read the worker's own view of the
 * request without any log access. The status is logged; the path is logged without its
 * query string, which is where an OAuth `code` or `state` would otherwise land.
 */
export function withRequestTiming<E>(inner: FetchLike<E>): FetchLike<E> {
	return {
		async fetch(request, env, ctx) {
			const started = Date.now();
			const traceId = request.headers.get("x-trace-id")?.slice(0, 64) || crypto.randomUUID();
			const url = new URL(request.url);
			let status = 0;
			try {
				const res = await inner.fetch(request, env, ctx);
				status = res.status;
				const ms = Date.now() - started;
				recordLatency({ stage: "gateway", name: "request", ms, ok: res.status < 500 }, traceId);
				const out = new Response(res.body, res);
				out.headers.set("X-Trace-Id", traceId);
				out.headers.append("Server-Timing", `gateway;dur=${ms}`);
				return out;
			} catch (err) {
				recordLatency({ stage: "gateway", name: "request", ms: Date.now() - started, ok: false }, traceId);
				throw err;
			} finally {
				console.log(JSON.stringify({ kind: "mcp.request", traceId, method: request.method, path: url.pathname, status, ms: Date.now() - started }));
			}
		},
	};
}
