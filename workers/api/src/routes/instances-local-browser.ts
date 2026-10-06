import type { Context, Hono } from "hono";
import { capabilitiesForInstance } from "../lib/agent-capabilities.js";
import { HttpError, requireUser } from "../lib/auth.js";
import { LOCAL_BROWSER_CANCEL_PATH, LOCAL_BROWSER_RUN_PATH, LOCAL_BROWSER_TASK_TYPE, type LocalBrowserTaskEnvelope } from "../lib/local-browser/contract.js";
import { applyRunnerResult, ingestRunnerEvents, resumeLocalBrowserRun, syncLocalBrowserRun } from "../lib/local-browser/sync.js";
import { type FindingAction, reviewFinding } from "../lib/local-browser/findings.js";
import {
	type ConsentScope,
	type LocalBrowserRun,
	PROFILE_CONSENT_DOMAIN,
	appendLocalBrowserEvents,
	claimLocalBrowserRun,
	consentIdsOf,
	getLocalBrowserRun,
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
	const caps = await capabilitiesForInstance(c.env, instanceId, uid);
	if (caps?.runtime !== "local_browser" || !caps.localBrowser) {
		throw new HttpError(409, `This agent does not use local CLI browser research (its capabilities.runtime is ${caps?.runtime ? `"${caps.runtime}"` : "null"}). The creator declares capabilities.runtime "local_browser" to enable it.`);
	}
	return caps.localBrowser;
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

const REQUEST_ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

export function registerLocalBrowserRoutes(router: Hono<{ Bindings: Env }>): void {
	/** The stored settings, the policy a run would start with, the agent's ceilings, and the runner pin. */
	router.get("/:instanceId/local-browser/settings", async (c) => {
		const { uid, instanceId } = await owned(c);
		const cap = await capabilityOf(c, instanceId, uid);
		const { settings, runnerNode } = await readLocalBrowserSettings(c.env, instanceId, uid);
		const effective = effectiveLocalBrowserPolicy(cap, settings);
		return c.json({ settings, effective: "error" in effective ? null : effective, problem: "error" in effective ? effective.error : null, capability: cap, runnerNode });
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
			} catch {}
			if (!Array.isArray(taskTypes)) checks.push({ id: "runner_support", ok: null, detail: "The runner did not say which task types it supports; a run will report it." });
			else if (taskTypes.includes(LOCAL_BROWSER_TASK_TYPE)) checks.push({ id: "runner_support", ok: true, detail: "The runner supports local browser research" });
			else checks.push({ id: "runner_support", ok: false, detail: "The connected runner does not support local browser research yet. Update the CLI (npm i -g @proagentstore/cli) and run `pags up` again." });
		}
		checks.push({ id: "engine_login", ok: null, detail: "Checked by the runner at the start of each run and recorded as engine.auth_checked on the run's trace." });
		if (!("error" in effective) && effective.browserProfile === "default") {
			const consent = await listDomainConsent(c.env, instanceId, uid, Date.now());
			const allowed = consent.some((x) => x.scope === "signed_in_profile" && x.decision === "allow");
			checks.push(allowed ? { id: "profile_consent", ok: true, detail: "You allowed research in your signed-in browser profile" } : { id: "profile_consent", ok: false, detail: "Your signed-in browser profile is selected but not consented to. Allow it, or switch to the isolated profile." });
		}
		return c.json({ ready: checks.every((x) => x.ok !== false), checks });
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
		const cap = await capabilityOf(c, instanceId, uid);
		const b = await body(c);
		const objective = typeof b.objective === "string" ? b.objective.trim() : "";
		if (!objective || objective.length > 4000) throw new HttpError(400, "objective is required (up to 4000 characters)");
		const requestId = b.requestId === undefined ? crypto.randomUUID() : typeof b.requestId === "string" && REQUEST_ID_RE.test(b.requestId) ? b.requestId : null;
		if (!requestId) throw new HttpError(400, "requestId must be 1-100 characters of letters, digits, _ . : or -");
		const { settings } = await readLocalBrowserSettings(c.env, instanceId, uid);
		const policy = effectiveLocalBrowserPolicy(cap, settings);
		if ("error" in policy) throw new HttpError(409, policy.error);

		const now = Date.now();
		const claim = await claimLocalBrowserRun(c.env, { id: crypto.randomUUID(), instanceId, userId: uid, requestId, objective, policy, now });
		if (claim.kind === "existing") return c.json(claim.run, 200);
		if (claim.kind === "at_capacity") throw new HttpError(409, `${claim.active} local browser run(s) already active and this instance allows ${policy.limits.maxConcurrent} at a time. Wait for one to finish, or cancel it.`);
		const run = claim.run;
		await appendLocalBrowserEvents(c.env, instanceId, uid, run.id, [{ type: "run.requested", at: new Date(now).toISOString(), detail: { engine: policy.engine, authMode: policy.authMode, browserProfile: policy.browserProfile, maxMinutes: policy.limits.maxMinutes, maxPages: policy.limits.maxPages } }], now);
		return c.json(await dispatch(c, instanceId, uid, run), 202);
	});

	/** Reading a run brings it up to date from the runner first. */
	router.get("/:instanceId/local-browser/runs/:runId", async (c) => {
		const { uid, instanceId } = await owned(c);
		const run = await runOr404(c, instanceId, uid);
		return c.json(await syncLocalBrowserRun(c.env, instanceId, uid, run).catch(() => run));
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

/** Hand a queued run to the live runner, or end it with the reason it could not be handed over. */
async function dispatch(c: C, instanceId: string, uid: string, run: LocalBrowserRun): Promise<LocalBrowserRun> {
	const now = Date.now();
	const fail = async (errorCode: string, error: string) => {
		const failed = await transitionLocalBrowserRun(c.env, instanceId, uid, run.id, { to: "failed", errorCode, error }, now);
		await appendLocalBrowserEvents(c.env, instanceId, uid, run.id, [{ type: "run.ended", at: new Date(now).toISOString(), detail: { status: "failed", errorCode } }], now);
		return failed ?? run;
	};
	const runtime = await getLiveRuntime(c.env, instanceId, uid);
	if (!runtime) return fail("runner_offline", "No runner is connected. Run `pags up` on the machine that should do the research, then start the run again.");

	const consent = await listDomainConsent(c.env, instanceId, uid, now);
	const navigate = consent.filter((x) => x.scope === "navigate");
	const p = run.policy;
	const envelope: LocalBrowserTaskEnvelope = {
		type: LOCAL_BROWSER_TASK_TYPE,
		runId: run.id,
		requestId: run.requestId,
		instanceId,
		objective: run.objective,
		engine: p.engine,
		authMode: p.authMode,
		workspace: p.workspace,
		browserProfile: p.browserProfile,
		policy: {
			mode: p.mode,
			allowDomains: p.allowDomains,
			// An owner's "deny" on a domain is as binding as the configured deny list.
			denyDomains: [...new Set([...p.denyDomains, ...navigate.filter((x) => x.decision === "deny").map((x) => x.domain)])],
			consentedDomains: navigate.filter((x) => x.decision === "allow").map((x) => x.domain),
			profileConsented: consent.some((x) => x.scope === "signed_in_profile" && x.decision === "allow"),
			consentIds: consentIdsOf(consent),
		},
		limits: p.limits,
		resultSchema: p.resultSchema,
	};
	let res: Response;
	try {
		res = await callRuntime(c.env, runtime, LOCAL_BROWSER_RUN_PATH, { method: "POST", body: JSON.stringify(envelope) });
	} catch (err) {
		return fail("runner_unreachable", `The runner did not answer: ${err instanceof Error ? err.message.slice(0, 300) : "unknown error"}`);
	}
	const payload = (await runtimeJson(res)) as Record<string, unknown>;
	// The relay's own answers: 503 no socket at dispatch, 504 the socket went away mid-command.
	if (res.status === 503 || res.status === 504) return fail("runner_unreachable", "The runner disconnected before it took the run. Check `pags up` on that machine, then start the run again.");
	if (res.status === 404) return fail("runner_unsupported", "The connected runner does not support local browser research yet. Update the CLI (npm i -g @proagentstore/cli) and run `pags up` again.");
	if (!res.ok) return fail("runner_rejected", `The runner refused the run: ${typeof payload.error === "string" ? payload.error.slice(0, 500) : `HTTP ${res.status}`}`);
	const taskId = typeof payload.taskId === "string" ? payload.taskId : typeof payload.id === "string" ? payload.id : null;
	const started = await transitionLocalBrowserRun(c.env, instanceId, uid, run.id, { to: "running", runnerNode: runtime.runner_node || null, runnerTaskId: taskId }, now);
	await appendLocalBrowserEvents(c.env, instanceId, uid, run.id, [{ type: "runner.dispatched", at: new Date(now).toISOString(), detail: { runnerNode: runtime.runner_node || null, taskId } }], now);
	return started ?? ((await getLocalBrowserRun(c.env, instanceId, uid, run.id)) as LocalBrowserRun);
}
