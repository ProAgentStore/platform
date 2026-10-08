import { readScanSchedule, scanScheduleSummary } from "../lib/local-browser/schedule.js";
import { scanTelemetry } from "../lib/local-browser/telemetry.js";
import { syncScanCard } from "../lib/local-browser/scan-board.js";
import type { Context, Hono } from "hono";
import { HttpError, requireUser } from "../lib/auth.js";
import { logError } from "../lib/error-log.js";
import { LOCAL_BROWSER_CANCEL_PATH, LOCAL_BROWSER_TASK_TYPE } from "../lib/local-browser/contract.js";
import { applyRunnerResult, ingestRunnerEvents, resumeLocalBrowserRun, syncLocalBrowserRun } from "../lib/local-browser/sync.js";
import { type FindingAction, reviewFinding } from "../lib/local-browser/findings.js";
import {
	type ConsentScope,
	type LocalBrowserRun,
	PROFILE_CONSENT_DOMAIN,
	appendLocalBrowserEvents,
	getLocalBrowserRun,
	lastObservedEngineAuth,
	type ObservedEngineAuth,
	listDomainConsent,
	listLocalBrowserEvents,
	listLocalBrowserRuns,
	readLocalBrowserSettings,
	setDomainConsent,
	transitionLocalBrowserRun,
	writeLocalBrowserSettings,
} from "../lib/local-browser/store.js";
import { type LocalBrowserCapability, effectiveLocalBrowserPolicy, isTerminal, mergeLocalBrowserSettings, normalizeDomain } from "../lib/local-browser/policy.js";
import { callRuntime, getLiveRuntime, requireOwnedInstance, runtimeJson } from "./instances-runtime.js";
import { LOCAL_BROWSER_OBJECTIVE_MAX, engineRunnerProblem, localBrowserCapability, startLocalBrowserRun } from "../lib/local-browser/start.js";
import type { Env } from "../types.js";

/**
 * Local CLI browser research (#945, epic #943) — settings, preflight, consent and the run lifecycle.
 *
 * A start is dispatched to the runner (`/local-browser/run`); from then on PAGS PULLS the run's
 * events and result from the runner (`lib/local-browser/sync.ts`) when a run or its trace is read
 * and from the per-minute cron — the runner cannot reach the API (#944). A runner that predates the
 * feature answers 404 and the run ends `runner_unsupported` at once, never queued forever.
 *
 * Owner-scoped throughout: every route 404s an instance the caller does not own, and every store
 * call is `user_id`-scoped as well. The two report routes (`…/events`, `…/result`) take a report
 * pushed with the owner's own session; they run the same code as the pull.
 */
type C = Context<{ Bindings: Env }>;

async function owned(c: C): Promise<{ uid: string; instanceId: string }> {
	const session = await requireUser(c);
	const instanceId = c.req.param("instanceId") ?? "";
	await requireOwnedInstance(c.env, instanceId, session.uid);
	return { uid: session.uid, instanceId };
}

/** The agent's local browser capability, or a 409 saying this is not that kind of agent. */
async function capabilityOf(c: C, instanceId: string, uid: string): Promise<LocalBrowserCapability> {
	const capability = await localBrowserCapability(c.env, instanceId, uid);
	if ("error" in capability) throw new HttpError(409, capability.error);
	return capability.cap;
}

async function runOr404(c: C, instanceId: string, uid: string): Promise<LocalBrowserRun> {
	const run = await getLocalBrowserRun(c.env, instanceId, uid, c.req.param("runId") ?? "");
	if (!run) throw new HttpError(404, "Local browser run not found");
	return run;
}

const body = async (c: C): Promise<Record<string, unknown>> => {
	const b = await c.req.json().catch(() => ({}));
	return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
};

/**
 * The engine sign-in check (#945), from the verdict the runner last recorded — the runner checks it at
 * the start of every run (`engine.auth_checked`); nothing can probe it between runs yet. Never
 * `ok:false`: the console disables Start on a failed check, and a stale `missing_login` must not lock
 * out the one run that would observe the owner has since signed in.
 */
export function engineLoginCheck(seen: ObservedEngineAuth | null, engine: string | null): { id: string; ok: boolean | null; detail: string } {
	const id = "engine_login";
	const when = seen ? ` (last checked ${new Date(seen.observedAt).toISOString().replace(/:\d\d\.\d+Z$/, "").replace("T", " ")} UTC, run ${seen.runId})` : "";
	if (!seen || !engine) return { id, ok: null, detail: "Not observed yet — the runner checks the engine's sign-in at the start of each run and records it as engine.auth_checked on the run's trace." };
	if (seen.verdict === "subscription" || seen.verdict === "machine-login") return { id, ok: true, detail: `${engine} was signed in (${seen.verdict})${when}.` };
	if (seen.verdict === "missing_login") return { id, ok: null, detail: `${engine} was NOT signed in on the runner machine${when}. Sign it in there (${engine === "codex" ? "`codex login`" : "run `claude` and use /login"}), then start a run — it is checked again.` };
	return { id, ok: null, detail: `${engine} last ran on ${seen.verdict}${when}.` };
}

const REQUEST_ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

/** How much of a run's trace the telemetry is computed from. A run's trace is bounded by policy. */
const SCAN_TELEMETRY_EVENTS = 500;

export function registerLocalBrowserRoutes(router: Hono<{ Bindings: Env }>): void {
	/** The stored settings, the policy a run would start with, the agent's ceilings, and the runner pin. */
	router.get("/:instanceId/local-browser/settings", async (c) => {
		const { uid, instanceId } = await owned(c);
		const cap = await capabilityOf(c, instanceId, uid);
		const { settings, runnerNode } = await readLocalBrowserSettings(c.env, instanceId, uid);
		const effective = effectiveLocalBrowserPolicy(cap, settings);
		// The SCAN SCHEDULE (#980), on the response the console's settings card and MCP's
		// `get_instance_local_browser_settings` both already read — so "is this Scout scheduled" is
		// answered in the same breath as "how would it run", and the two surfaces cannot disagree.
		// A view over the existing cron trigger, never a second scheduler: see lib/local-browser/schedule.ts.
		const schedule = await readScanSchedule(c.env, instanceId, uid);
		return c.json({ settings, effective: "error" in effective ? null : effective, problem: "error" in effective ? effective.error : null, capability: cap, runnerNode, schedule, scheduleSummary: scanScheduleSummary(schedule) });
	});

	/** PATCH semantics: a field present replaces, `null` clears it to the agent default. The pin is `PUT /runner-node`. */
	router.put("/:instanceId/local-browser/settings", async (c) => {
		const { uid, instanceId } = await owned(c);
		const cap = await capabilityOf(c, instanceId, uid);
		const patch = await body(c);
		if ("runnerNode" in patch) throw new HttpError(400, "The runner is chosen with PUT /v1/instances/:id/runner-node (it re-attaches the runner); it is not a local browser setting.");
		const { settings: stored } = await readLocalBrowserSettings(c.env, instanceId, uid);
		const merged = mergeLocalBrowserSettings(stored, patch, cap);
		if ("error" in merged) throw new HttpError(400, merged.error);
		await writeLocalBrowserSettings(c.env, instanceId, uid, merged.settings);
		return c.json({ settings: merged.settings, effective: effectiveLocalBrowserPolicy(cap, merged.settings) });
	});

	/**
	 * Read-only: is this instance ready to start a run, and if not, the one step that would fix it.
	 * Each check is `ok: true | false | null` — null means not knowable yet, and does not block.
	 */
	router.get("/:instanceId/local-browser/preflight", async (c) => {
		const { uid, instanceId } = await owned(c);
		const cap = await capabilityOf(c, instanceId, uid);
		const { settings } = await readLocalBrowserSettings(c.env, instanceId, uid);
		const effective = effectiveLocalBrowserPolicy(cap, settings);
		const checks: Array<{ id: string; ok: boolean | null; detail: string }> = [];
		checks.push("error" in effective ? { id: "settings", ok: false, detail: effective.error } : { id: "settings", ok: true, detail: `${effective.engine} via ${effective.authMode}, ${effective.workspace.kind === "scratch" ? "managed scratch folder" : effective.workspace.path}, ${effective.browserProfile} browser profile` });
		const runtime = await getLiveRuntime(c.env, instanceId, uid);
		checks.push(runtime ? { id: "runner", ok: true, detail: `Connected on ${runtime.runner_node || "this machine"}` } : { id: "runner", ok: false, detail: "No runner is connected. Run `pags up` on the machine that should do the research." });
		if (runtime) {
			// Asked live: the registration row's `capabilities` is a free-form string list that
			// `pags up` does not fill, so only the runner's own `/capabilities` answers this.
			let taskTypes: unknown = null;
			try {
				const res = await callRuntime(c.env, runtime, "/capabilities");
				if (res.ok) taskTypes = ((await runtimeJson(res)) as { taskTypes?: unknown }).taskTypes;
			} catch (err) {
				// callRuntime or runtimeJson failed (relay timeout, unreadable body). Preflight still answers,
				// degrading this check to ok:null below; the cause goes to the durable error log.
				await logError(c.env, { source: "local-browser", level: "warn", userId: uid, message: `preflight /capabilities probe failed: ${err instanceof Error ? err.message : String(err)}`, context: { instanceId, runnerNode: runtime.runner_node || null } });
			}
			if (!Array.isArray(taskTypes)) checks.push({ id: "runner_support", ok: null, detail: "The runner did not say which task types it supports; a run will report it." });
			else if (taskTypes.includes(LOCAL_BROWSER_TASK_TYPE)) {
				// Supporting the task is not supporting it with THIS engine (#952): a Codex run needs a newer runner.
				const tooOld = "error" in effective ? null : engineRunnerProblem(effective.engine, runtime.runner_version, runtime.runner_node);
				checks.push(tooOld ? { id: "runner_support", ok: false, detail: tooOld } : { id: "runner_support", ok: true, detail: "The runner supports local browser research" });
			}
			else checks.push({ id: "runner_support", ok: false, detail: "The connected runner does not support local browser research yet. Update the CLI (npm i -g @proagentstore/cli) and run `pags up` again." });
		}
		const engineAuth = "error" in effective ? null : await lastObservedEngineAuth(c.env, instanceId, uid, effective.engine, effective.authMode);
		checks.push(engineLoginCheck(engineAuth, "error" in effective ? null : effective.engine));
		if (!("error" in effective) && effective.browserProfile === "default") {
			const consent = await listDomainConsent(c.env, instanceId, uid, Date.now());
			const allowed = consent.some((x) => x.scope === "signed_in_profile" && x.decision === "allow");
			checks.push(allowed ? { id: "profile_consent", ok: true, detail: "You allowed research in your signed-in browser profile" } : { id: "profile_consent", ok: false, detail: "Your signed-in browser profile is selected but not consented to. Allow it, or switch to the isolated profile." });
		}
		return c.json({ ready: checks.every((x) => x.ok !== false), checks, engineAuth });
	});

	/** Live per-domain navigation decisions, and the signed-in-profile decision (domain "*"). */
	router.get("/:instanceId/local-browser/consent", async (c) => {
		const { uid, instanceId } = await owned(c);
		await capabilityOf(c, instanceId, uid);
		return c.json({ consent: await listDomainConsent(c.env, instanceId, uid, Date.now()) });
	});

	/** `{domain, scope, decision: "allow" | "deny" | null, ttlDays?}`. `null` withdraws the decision. */
	router.put("/:instanceId/local-browser/consent", async (c) => {
		const { uid, instanceId } = await owned(c);
		await capabilityOf(c, instanceId, uid);
		const b = await body(c);
		const scope = b.scope === "navigate" || b.scope === "signed_in_profile" ? (b.scope as ConsentScope) : null;
		if (!scope) throw new HttpError(400, 'scope must be "navigate" or "signed_in_profile"');
		const domain = scope === "signed_in_profile" ? PROFILE_CONSENT_DOMAIN : normalizeDomain(b.domain);
		if (!domain) throw new HttpError(400, "domain must be a hostname, e.g. example.com (it also covers subdomains)");
		const decision = b.decision === "allow" || b.decision === "deny" ? b.decision : b.decision === null ? null : undefined;
		if (decision === undefined) throw new HttpError(400, 'decision must be "allow", "deny", or null to withdraw it');
		const ttl = b.ttlDays === undefined ? null : typeof b.ttlDays === "number" && Number.isInteger(b.ttlDays) && b.ttlDays >= 1 && b.ttlDays <= 365 ? b.ttlDays : NaN;
		if (Number.isNaN(ttl)) throw new HttpError(400, "ttlDays must be a whole number from 1 to 365");
		const now = Date.now();
		await setDomainConsent(c.env, instanceId, uid, { domain, scope, decision, expiresAt: ttl ? now + ttl * 86_400_000 : null }, now);
		return c.json({ consent: await listDomainConsent(c.env, instanceId, uid, now) });
	});

	router.get("/:instanceId/local-browser/runs", async (c) => {
		const { uid, instanceId } = await owned(c);
		const limit = Math.min(Math.max(Number(c.req.query("limit")) || 20, 1), 100);
		return c.json({ runs: await listLocalBrowserRuns(c.env, instanceId, uid, limit) });
	});

	/**
	 * Start a run: `{objective, requestId?}`. Idempotent on `requestId` (the same key returns the
	 * same run, 200), capped by the effective `maxConcurrent` (409), and dispatched to the live
	 * runner. A dispatch that cannot happen ends the run as `failed` with a code saying why.
	 */
	router.post("/:instanceId/local-browser/runs", async (c) => {
		const { uid, instanceId } = await owned(c);
		const b = await body(c);
		const objective = typeof b.objective === "string" ? b.objective.trim() : "";
		if (!objective || objective.length > LOCAL_BROWSER_OBJECTIVE_MAX) throw new HttpError(400, `objective is required (up to ${LOCAL_BROWSER_OBJECTIVE_MAX} characters)`);
		const requestId = b.requestId === undefined ? crypto.randomUUID() : typeof b.requestId === "string" && REQUEST_ID_RE.test(b.requestId) ? b.requestId : null;
		if (!requestId) throw new HttpError(400, "requestId must be 1-100 characters of letters, digits, _ . : or -");
		// The one start path (#962) — the run_local_browser trigger calls it too.
		const out = await startLocalBrowserRun(c.env, instanceId, uid, { objective, requestId, source: "owner" });
		if (out.kind === "refused" || out.kind === "at_capacity") throw new HttpError(409, out.error);
		return c.json(out.run, out.kind === "existing" ? 200 : 202);
	});

	/** Reading a run brings it up to date from the runner first. */
	router.get("/:instanceId/local-browser/runs/:runId", async (c) => {
		const { uid, instanceId } = await owned(c);
		const run = await runOr404(c, instanceId, uid);
		const current = await syncLocalBrowserRun(c.env, instanceId, uid, run).catch(() => run);
		// What the scan DID, structured (#980): counts, source reachability, dispositions by reason
		// and the terminal reason — from the trace PAGS already holds, so reading it reaches no
		// machine. Privacy boundary argued in lib/local-browser/telemetry.ts: counts, hostnames and
		// closed-vocabulary codes only, never page text or engine output.
		const events = await listLocalBrowserEvents(c.env, instanceId, uid, current.id, 0, SCAN_TELEMETRY_EVENTS).catch(() => []);
		return c.json({ ...current, telemetry: scanTelemetry({ run: current, events }) });
	});

	/**
	 * The owner's decision on one finding (#946): `save` writes it to the collection the run's
	 * policy names — unless that collection already holds its key, which comes back as a
	 * `duplicate` review instead; `{force: true}` saves it anyway. `skip` records the decision only.
	 */
	const review = (action: FindingAction) => async (c: C) => {
		const { uid, instanceId } = await owned(c);
		const run = await runOr404(c, instanceId, uid);
		const index = Number(c.req.param("index"));
		if (!Number.isInteger(index) || index < 0) throw new HttpError(400, "index must be the finding's position, from 0");
		const force = action === "save" && (await body(c)).force === true;
		return c.json(await reviewFinding(c.env, instanceId, uid, run, index, action, force));
	};
	// Two literal paths, not one template: the route and OpenAPI guards read registrations as text.
	router.post("/:instanceId/local-browser/runs/:runId/findings/:index/save", review("save"));
	router.post("/:instanceId/local-browser/runs/:runId/findings/:index/skip", review("skip"));

	/** Release a paused run once the owner has acted — consent recorded, captcha solved, signed in. */
	router.post("/:instanceId/local-browser/runs/:runId/resume", async (c) => {
		const { uid, instanceId } = await owned(c);
		const run = await syncLocalBrowserRun(c.env, instanceId, uid, await runOr404(c, instanceId, uid));
		return c.json(await resumeLocalBrowserRun(c.env, instanceId, uid, run));
	});

	router.post("/:instanceId/local-browser/runs/:runId/cancel", async (c) => {
		const { uid, instanceId } = await owned(c);
		const run = await runOr404(c, instanceId, uid);
		if (isTerminal(run.status)) throw new HttpError(409, `The run already ${run.status === "cancelled" ? "was cancelled" : `ended: ${run.status}`}`);
		const now = Date.now();
		const moved = await transitionLocalBrowserRun(c.env, instanceId, uid, run.id, { to: "cancelled", errorCode: "cancelled", error: "Cancelled by the owner" }, now);
		if (!moved) throw new HttpError(409, "The run changed state while cancelling; read it again");
		await appendLocalBrowserEvents(c.env, instanceId, uid, run.id, [{ type: "run.ended", at: new Date(now).toISOString(), detail: { status: "cancelled" } }], now);
		// Best-effort: stop the engine. The run is cancelled whether or not the runner hears it.
		if (run.status !== "queued") {
			const runtime = await getLiveRuntime(c.env, instanceId, uid).catch(() => null);
			if (runtime) await callRuntime(c.env, runtime, LOCAL_BROWSER_CANCEL_PATH, { method: "POST", body: JSON.stringify({ runId: run.id }) }).catch(() => undefined);
		}
		// The fourth place a scan's state changes (#980) — a cancelled scan must not sit on the board
		// as if it were still running.
		await syncScanCard(c.env, instanceId, uid, moved);
		return c.json(moved);
	});

	router.get("/:instanceId/local-browser/runs/:runId/events", async (c) => {
		const { uid, instanceId } = await owned(c);
		const run = await runOr404(c, instanceId, uid);
		await syncLocalBrowserRun(c.env, instanceId, uid, run).catch(() => undefined);
		const after = Math.max(Number(c.req.query("after")) || 0, 0);
		const limit = Math.min(Math.max(Number(c.req.query("limit")) || 200, 1), 500);
		const events = await listLocalBrowserEvents(c.env, instanceId, uid, run.id, after, limit);
		return c.json({ events, nextAfter: events.length ? events[events.length - 1].seq : after });
	});

	/** The runner reports events: `{events: [...]}`, at most 100 per call. Invalid ones are counted, not stored. */
	router.post("/:instanceId/local-browser/runs/:runId/events", async (c) => {
		const { uid, instanceId } = await owned(c);
		const run = await runOr404(c, instanceId, uid);
		if (isTerminal(run.status)) throw new HttpError(409, `The run has ended (${run.status}); it takes no more events`);
		const raw = (await body(c)).events;
		if (!Array.isArray(raw) || raw.length > 100) throw new HttpError(400, "events must be an array of at most 100 events");
		const r = await ingestRunnerEvents(c.env, instanceId, uid, run, raw, Date.now());
		return c.json({ accepted: r.accepted, rejected: r.rejected, dropped: r.dropped, status: r.run.status });
	});

	/** The runner's final result envelope, validated by the shared contract. Ends the run. */
	router.post("/:instanceId/local-browser/runs/:runId/result", async (c) => {
		const { uid, instanceId } = await owned(c);
		const run = await runOr404(c, instanceId, uid);
		return c.json(await applyRunnerResult(c.env, instanceId, uid, run, await body(c), Date.now()));
	});
}
