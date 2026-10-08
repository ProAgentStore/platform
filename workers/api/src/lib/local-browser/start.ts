/**
 * Starting a local CLI browser research run (#945) — the ONE path, shared by the owner's
 * `POST …/local-browser/runs` and the `run_local_browser` trigger action (#962).
 *
 * A scheduled run must be the same run an owner starts by hand: the same capability check, the same
 * effective policy (limits, consent, allow/deny lists), the same `maxConcurrent` claim and the same
 * dispatch to the runner. Two copies of those rules is how a cron run would one day skip a check the
 * button enforces, so the route and the trigger both call this and only map its outcome.
 */
import { capabilitiesForInstance } from "../agent-capabilities.js";
import { getLiveRuntime, callRuntime, runtimeJson } from "../../routes/instances-runtime.js";
import type { Env } from "../../types.js";
import { LOCAL_BROWSER_RUN_PATH, LOCAL_BROWSER_TASK_TYPE, type LocalBrowserTaskEnvelope } from "./contract.js";
import { LOCAL_BROWSER_CODEX_MIN_CLI, effectiveLocalBrowserPolicy, type LocalBrowserCapability } from "./policy.js";
import { cliAtLeast } from "../runner-upgrade.js";
import { syncScanCard } from "./scan-board.js";
import {
	appendLocalBrowserEvents,
	getLocalBrowserRun,
	claimLocalBrowserRun,
	consentIdsOf,
	type LocalBrowserRun,
	listDomainConsent,
	readLocalBrowserSettings,
	transitionLocalBrowserRun,
} from "./store.js";

/** The longest objective a run accepts — the same bound for an owner and for a trigger. */
export const LOCAL_BROWSER_OBJECTIVE_MAX = 4000;

/** Why an agent is not a local browser agent, in the words both callers show. */
export function notLocalBrowserMessage(runtime: string | null | undefined): string {
	return `This agent does not use local CLI browser research (its capabilities.runtime is ${runtime ? `"${runtime}"` : "null"}). The creator declares capabilities.runtime "local_browser" to enable it.`;
}

/** The agent's local browser capability, or the reason it has none. */
export async function localBrowserCapability(env: Env, instanceId: string, uid: string): Promise<{ cap: LocalBrowserCapability } | { error: string }> {
	const caps = await capabilitiesForInstance(env, instanceId, uid);
	if (caps?.runtime !== "local_browser" || !caps.localBrowser) return { error: notLocalBrowserMessage(caps?.runtime) };
	return { cap: caps.localBrowser };
}

export type StartLocalBrowserOutcome =
	/** A new run, dispatched — or already ended `failed` with the code saying why it could not be. */
	| { kind: "started"; run: LocalBrowserRun }
	/** The same `requestId` already named a run: that run, unchanged. */
	| { kind: "existing"; run: LocalBrowserRun }
	/** Not a local browser agent, or its settings do not resolve to a runnable policy. */
	| { kind: "refused"; error: string }
	/** `maxConcurrent` runs are already active. */
	| { kind: "at_capacity"; error: string };

export async function startLocalBrowserRun(
	env: Env,
	instanceId: string,
	uid: string,
	input: { objective: string; requestId: string; source: "owner" | "trigger" },
): Promise<StartLocalBrowserOutcome> {
	const capability = await localBrowserCapability(env, instanceId, uid);
	if ("error" in capability) return { kind: "refused", error: capability.error };
	const { settings } = await readLocalBrowserSettings(env, instanceId, uid);
	const policy = effectiveLocalBrowserPolicy(capability.cap, settings);
	if ("error" in policy) return { kind: "refused", error: policy.error };

	const now = Date.now();
	const claim = await claimLocalBrowserRun(env, { id: crypto.randomUUID(), instanceId, userId: uid, requestId: input.requestId, objective: input.objective, policy, now });
	if (claim.kind === "existing") return { kind: "existing", run: claim.run };
	if (claim.kind === "at_capacity") {
		return { kind: "at_capacity", error: `${claim.active} local browser run(s) already active and this instance allows ${policy.limits.maxConcurrent} at a time. Wait for one to finish, or cancel it.` };
	}
	const run = claim.run;
	await appendLocalBrowserEvents(env, instanceId, uid, run.id, [
		{
			type: "run.requested",
			at: new Date(now).toISOString(),
			// Who asked (#962): a run nobody pressed a button for says so on its own trace.
			detail: { engine: policy.engine, authMode: policy.authMode, browserProfile: policy.browserProfile, maxMinutes: policy.limits.maxMinutes, maxPages: policy.limits.maxPages, source: input.source },
		},
	], now);
	const dispatched = await dispatch(env, instanceId, uid, run);
	// On the BOARD the moment it starts (#980), not when it ends: a Scout mid-scan showed an empty
	// board and an `Idle` card, which is what made "is it doing anything" unanswerable.
	await syncScanCard(env, instanceId, uid, dispatched);
	return { kind: "started", run: dispatched };
}

/**
 * Why this machine cannot run this engine, or null (#952). A Codex run on a runner older than
 * {@link LOCAL_BROWSER_CODEX_MIN_CLI} opens no page at all — and such a runner also predates the check
 * that fails a run which never touched the bridge (#944), so it would report that run "completed".
 * Refused before dispatch instead, naming the fix. An unreported version is not judged.
 */
export function engineRunnerProblem(engine: string, runnerVersion: string | null | undefined, node: string | null | undefined): string | null {
	if (engine !== "codex" || !runnerVersion?.trim() || cliAtLeast(runnerVersion, LOCAL_BROWSER_CODEX_MIN_CLI)) return null;
	return `The runner on ${node || "that machine"} is CLI ${runnerVersion.trim()}, too old for Codex research — it cannot call the browser tools (needs ${LOCAL_BROWSER_CODEX_MIN_CLI} or newer). Update it (npm i -g @proagentstore/cli, or runner_update) and restart \`pags up\` — or switch this instance's engine to Claude Code.`;
}

/** Hand the run to the live runner. A dispatch that cannot happen ends the run `failed` with a code. */
async function dispatch(env: Env, instanceId: string, uid: string, run: LocalBrowserRun): Promise<LocalBrowserRun> {
	const now = Date.now();
	const fail = async (errorCode: string, error: string) => {
		const failed = await transitionLocalBrowserRun(env, instanceId, uid, run.id, { to: "failed", errorCode, error }, now);
		await appendLocalBrowserEvents(env, instanceId, uid, run.id, [{ type: "run.ended", at: new Date(now).toISOString(), detail: { status: "failed", errorCode } }], now);
		return failed ?? run;
	};
	const runtime = await getLiveRuntime(env, instanceId, uid);
	if (!runtime) return fail("runner_offline", "No runner is connected. Run `pags up` on the machine that should do the research, then start the run again.");
	const tooOld = engineRunnerProblem(run.policy.engine, runtime.runner_version, runtime.runner_node);
	if (tooOld) return fail("runner_unsupported", tooOld);

	const consent = await listDomainConsent(env, instanceId, uid, now);
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
		res = await callRuntime(env, runtime, LOCAL_BROWSER_RUN_PATH, { method: "POST", body: JSON.stringify(envelope) });
	} catch (err) {
		return fail("runner_unreachable", `The runner did not answer: ${err instanceof Error ? err.message.slice(0, 300) : "unknown error"}`);
	}
	const payload = (await runtimeJson(res)) as Record<string, unknown>;
	// The relay's own answers: 503 no socket at dispatch, 504 the socket went away mid-command.
	if (res.status === 503 || res.status === 504) return fail("runner_unreachable", "The runner disconnected before it took the run. Check `pags up` on that machine, then start the run again.");
	if (res.status === 404) return fail("runner_unsupported", "The connected runner does not support local browser research yet. Update the CLI (npm i -g @proagentstore/cli) and run `pags up` again.");
	if (!res.ok) return fail("runner_rejected", `The runner refused the run: ${typeof payload.error === "string" ? payload.error.slice(0, 500) : `HTTP ${res.status}`}`);
	const taskId = typeof payload.taskId === "string" ? payload.taskId : typeof payload.id === "string" ? payload.id : null;
	const started = await transitionLocalBrowserRun(env, instanceId, uid, run.id, { to: "running", runnerNode: runtime.runner_node || null, runnerTaskId: taskId }, now);
	await appendLocalBrowserEvents(env, instanceId, uid, run.id, [{ type: "runner.dispatched", at: new Date(now).toISOString(), detail: { runnerNode: runtime.runner_node || null, taskId } }], now);
	return started ?? ((await getLocalBrowserRun(env, instanceId, uid, run.id)) as LocalBrowserRun);
}
